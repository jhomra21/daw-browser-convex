#include "vst3-editor-window.h"

#include "pluginterfaces/base/funknown.h"
#include "pluginterfaces/gui/iplugview.h"

#import <Cocoa/Cocoa.h>

#include <algorithm>
#include <cstddef>
#include <limits>

@interface DawEditorWindow : NSWindow
@end

@implementation DawEditorWindow

- (void)close {
  [super close];
  [[NSNotificationCenter defaultCenter]
    postNotificationName:@"NSWindowDidCloseNotification"
                  object:self];
}

@end

namespace daw::plugin_host {
namespace {

constexpr std::uint32_t kMaximumEditorDimension = 8'192;
constexpr std::size_t kMaximumEditorEventsPerPump = 64;
constexpr CGFloat kEditorAnchorGap = 12.0;
NSWindow* gEditorWindow = nil;
bool gEditorInteractionPending = false;

bool ValidDimension(const std::uint32_t value) {
  return value > 0 && value <= kMaximumEditorDimension;
}

void ActivateAndOrderFront(NSWindow* window) {
  if (!window || !NSApp) return;
  [window setLevel:NSFloatingWindowLevel];
  [window setHidesOnDeactivate:NO];
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  const NSApplicationActivationOptions activationOptions =
    NSApplicationActivateIgnoringOtherApps | NSApplicationActivateAllWindows;
#pragma clang diagnostic pop
  [[NSRunningApplication currentApplication]
    activateWithOptions:activationOptions];
  [NSApp activateIgnoringOtherApps:YES];
  [window orderFrontRegardless];
  [window makeKeyWindow];
  [window makeKeyAndOrderFront:nil];
}

NSScreen* ScreenForAnchor(const WorkerEditorAnchor& anchor, CGFloat& appKitY) {
  NSScreen* selected = nil;
  CGFloat desktopTop = -CGFLOAT_MAX;
  for (NSScreen* screen in NSScreen.screens) {
    desktopTop = std::max(desktopTop, NSMaxY(screen.frame));
  }
  appKitY = desktopTop - static_cast<CGFloat>(anchor.y);
  for (NSScreen* screen in NSScreen.screens) {
    const NSRect frame = screen.frame;
    const CGFloat topOriginY = desktopTop - NSMaxY(frame);
    if (anchor.x >= NSMinX(frame) && anchor.x <= NSMaxX(frame)
      && anchor.y >= topOriginY && anchor.y <= topOriginY + NSHeight(frame)) {
      selected = screen;
      break;
    }
  }
  return selected ?: NSScreen.mainScreen ?: NSScreen.screens.firstObject;
}

void PositionWindow(NSWindow* window, const std::optional<WorkerEditorAnchor>& anchor) {
  if (!window) return;
  NSScreen* screen = nil;
  CGFloat centerX = 0.0;
  CGFloat bottomY = 0.0;
  if (anchor) {
    screen = ScreenForAnchor(*anchor, bottomY);
    centerX = static_cast<CGFloat>(anchor->x);
  } else {
    screen = NSScreen.mainScreen ?: NSScreen.screens.firstObject;
  }
  if (!screen) return;
  const NSRect visibleFrame = screen.visibleFrame;
  const NSSize windowSize = window.frame.size;
  const CGFloat minimumX = NSMinX(visibleFrame);
  const CGFloat maximumX = NSMaxX(visibleFrame) - windowSize.width;
  const CGFloat minimumY = NSMinY(visibleFrame);
  const CGFloat maximumY = NSMaxY(visibleFrame) - windowSize.height;
  const CGFloat desiredX = anchor ? centerX - windowSize.width / 2.0 : NSMidX(visibleFrame) - windowSize.width / 2.0;
  const CGFloat desiredY = anchor
    ? bottomY + kEditorAnchorGap
    : NSMidY(visibleFrame) - windowSize.height / 2.0;
  const CGFloat originX = maximumX >= minimumX ? std::clamp(desiredX, minimumX, maximumX) : NSMidX(visibleFrame) - windowSize.width / 2.0;
  const CGFloat originY = maximumY >= minimumY ? std::clamp(desiredY, minimumY, maximumY) : NSMidY(visibleFrame) - windowSize.height / 2.0;
  [window setFrameOrigin:NSMakePoint(originX, originY)];
}

class EditorFrame final : public Steinberg::IPlugFrame {
 public:
  explicit EditorFrame(Vst3EditorWindow::Implementation& owner) : owner_(owner) {}

  Steinberg::tresult PLUGIN_API resizeView(Steinberg::IPlugView*, Steinberg::ViewRect* size) override;
  Steinberg::tresult PLUGIN_API queryInterface(const Steinberg::TUID iid, void** object) override {
    if (!object) return Steinberg::kInvalidArgument;
    const Steinberg::FUID frameIid{0x367FAF01, 0xAFA94693, 0x8D4DA2A0, 0xED0882A3};
    if (Steinberg::FUnknownPrivate::iidEqual(iid, Steinberg::FUnknown::iid)
      || Steinberg::FUnknownPrivate::iidEqual(iid, frameIid)) {
      *object = static_cast<Steinberg::IPlugFrame*>(this);
      return Steinberg::kResultOk;
    }
    *object = nullptr;
    return Steinberg::kNoInterface;
  }
  Steinberg::uint32 PLUGIN_API addRef() override { return 1; }
  Steinberg::uint32 PLUGIN_API release() override { return 1; }

 private:
  Vst3EditorWindow::Implementation& owner_;
};

}  // namespace

bool PrepareVst3EditorRuntime() {
  if (!NSApplicationLoad()) return false;
  [NSApplication sharedApplication];
  [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
  return NSApp != nil;
}

class Vst3EditorWindow::Implementation {
 public:
  NSWindow* window = nil;
  NSView* hostView = nil;
  id closeObserver = nil;
  Steinberg::IPlugView* view = nullptr;
  EditorFrame frame{*this};
  bool attached = false;
  std::optional<WorkerEditorAnchor> anchor;
  std::uint32_t width = 0;
  std::uint32_t height = 0;

  void InvalidateWindowState(const bool clearView) {
    NSWindow* closedWindow = window;
    id observer = closeObserver;
    closeObserver = nil;
    if (observer) {
      [[NSNotificationCenter defaultCenter] removeObserver:observer];
    }
    const bool wasAttached = attached;
    attached = false;
    window = nil;
    if (gEditorWindow == closedWindow) {
      gEditorWindow = nil;
      gEditorInteractionPending = false;
    }
    hostView = nil;
    anchor.reset();
    width = 0;
    height = 0;
    if (wasAttached && view) view->removed();
    if (clearView) view = nullptr;
  }

  void WindowDidClose() {
    InvalidateWindowState(false);
  }

  bool Resize(const std::uint32_t nextWidth, const std::uint32_t nextHeight) {
    if (!window || !view || !ValidDimension(nextWidth) || !ValidDimension(nextHeight)) return false;
    Steinberg::ViewRect size{0, 0, static_cast<Steinberg::int32>(nextWidth), static_cast<Steinberg::int32>(nextHeight)};
    if (view->canResize() != Steinberg::kResultOk || view->checkSizeConstraint(&size) != Steinberg::kResultOk
      || size.right <= size.left || size.bottom <= size.top) {
      return false;
    }
    const auto constrainedWidth = static_cast<std::uint32_t>(size.right - size.left);
    const auto constrainedHeight = static_cast<std::uint32_t>(size.bottom - size.top);
    if (!ValidDimension(constrainedWidth) || !ValidDimension(constrainedHeight)
      || view->onSize(&size) != Steinberg::kResultOk) return false;
    [hostView setFrame:NSMakeRect(0, 0, constrainedWidth, constrainedHeight)];
    [window setContentSize:NSMakeSize(constrainedWidth, constrainedHeight)];
    width = constrainedWidth;
    height = constrainedHeight;
    return true;
  }

  void Close() {
    NSWindow* closingWindow = window;
    InvalidateWindowState(true);
    if (closingWindow) [closingWindow close];
  }
};

Steinberg::tresult PLUGIN_API EditorFrame::resizeView(Steinberg::IPlugView*, Steinberg::ViewRect* size) {
  if (!size || size->right <= size->left || size->bottom <= size->top) return Steinberg::kInvalidArgument;
  const auto width = static_cast<std::uint32_t>(size->right - size->left);
  const auto height = static_cast<std::uint32_t>(size->bottom - size->top);
  return owner_.Resize(width, height) ? Steinberg::kResultOk : Steinberg::kResultFalse;
}

Vst3EditorWindow::Vst3EditorWindow() : implementation_(new Implementation) {}

Vst3EditorWindow::~Vst3EditorWindow() {
  Close();
  delete implementation_;
}

bool Vst3EditorWindow::Open(Steinberg::IPlugView& view, const std::optional<WorkerEditorAnchor> anchor) {
  if (!NSThread.isMainThread || implementation_->window || !PrepareVst3EditorRuntime()) return false;
  Steinberg::ViewRect size{};
  if (view.isPlatformTypeSupported(Steinberg::kPlatformTypeNSView) != Steinberg::kResultTrue
    || view.getSize(&size) != Steinberg::kResultOk || size.right <= size.left || size.bottom <= size.top) {
    return false;
  }
  const auto width = static_cast<std::uint32_t>(size.right - size.left);
  const auto height = static_cast<std::uint32_t>(size.bottom - size.top);
  if (!ValidDimension(width) || !ValidDimension(height) || view.setFrame(&implementation_->frame) != Steinberg::kResultOk) return false;
  implementation_->window = [[DawEditorWindow alloc] initWithContentRect:NSMakeRect(0, 0, width, height)
    styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable)
    backing:NSBackingStoreBuffered defer:NO];
  implementation_->hostView = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, width, height)];
  [implementation_->window setContentView:implementation_->hostView];
  implementation_->view = &view;
  auto* owner = implementation_;
  implementation_->closeObserver = [[NSNotificationCenter defaultCenter]
    addObserverForName:@"NSWindowDidCloseNotification" object:implementation_->window queue:nil
    usingBlock:^(NSNotification*) { owner->WindowDidClose(); }];
  if (view.attached((__bridge void*)implementation_->hostView, Steinberg::kPlatformTypeNSView) != Steinberg::kResultOk) {
    implementation_->Close();
    return false;
  }
  implementation_->attached = true;
  implementation_->anchor = anchor;
  implementation_->width = width;
  implementation_->height = height;
  [implementation_->window setCollectionBehavior:(NSWindowCollectionBehaviorMoveToActiveSpace | NSWindowCollectionBehaviorFullScreenAuxiliary)];
  PositionWindow(implementation_->window, implementation_->anchor);
  gEditorWindow = implementation_->window;
  ActivateAndOrderFront(implementation_->window);
  return true;
}

bool Vst3EditorWindow::Close() {
  if (!NSThread.isMainThread) return false;
  const bool wasOpen = implementation_->window != nil;
  implementation_->Close();
  return wasOpen;
}

bool Vst3EditorWindow::Focus(const std::optional<WorkerEditorAnchor> anchor) {
  if (!NSThread.isMainThread || !implementation_->window) return false;
  if (anchor) implementation_->anchor = anchor;
  PositionWindow(implementation_->window, implementation_->anchor);
  ActivateAndOrderFront(implementation_->window);
  return true;
}

bool Vst3EditorWindow::Resize(const std::uint32_t width, const std::uint32_t height) {
  return NSThread.isMainThread && implementation_->Resize(width, height);
}

Vst3EditorWindowStatus Vst3EditorWindow::status() const {
  return {
    .supported = implementation_->view != nullptr,
    .open = implementation_->window != nil,
    .width = implementation_->width,
    .height = implementation_->height,
  };
}

void PumpVst3EditorEvents() {
  if (!NSThread.isMainThread || NSApp == nil) return;
  for (std::size_t count = 0; count < kMaximumEditorEventsPerPump; ++count) {
    NSEvent* event = [NSApp nextEventMatchingMask:NSEventMaskAny
      untilDate:[NSDate dateWithTimeIntervalSinceNow:0]
      inMode:NSDefaultRunLoopMode dequeue:YES];
    if (!event) return;
    [NSApp sendEvent:event];
    if (event.type == NSEventTypeLeftMouseUp && event.window == gEditorWindow) {
      NSResponder* firstResponder = event.window.firstResponder;
      if (![firstResponder isKindOfClass:[NSTextView class]]
        && ![firstResponder isKindOfClass:[NSTextField class]]) {
        gEditorInteractionPending = true;
      }
    }
  }
}

bool ConsumeVst3EditorInteraction() {
  const bool pending = gEditorInteractionPending;
  gEditorInteractionPending = false;
  return pending && gEditorWindow != nil && gEditorWindow.isVisible;
}

}  // namespace daw::plugin_host
