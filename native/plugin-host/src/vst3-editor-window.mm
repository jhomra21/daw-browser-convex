#include "vst3-editor-window.h"

#include "pluginterfaces/base/funknown.h"
#include "pluginterfaces/gui/iplugview.h"

#import <Cocoa/Cocoa.h>

#include <algorithm>
#include <limits>

namespace daw::plugin_host {
namespace {

constexpr std::uint32_t kMaximumEditorDimension = 8'192;

bool ValidDimension(const std::uint32_t value) {
  return value > 0 && value <= kMaximumEditorDimension;
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

class Vst3EditorWindow::Implementation {
 public:
  NSWindow* window = nil;
  NSView* hostView = nil;
  id closeObserver = nil;
  Steinberg::IPlugView* view = nullptr;
  EditorFrame frame{*this};
  bool attached = false;
  std::uint32_t width = 0;
  std::uint32_t height = 0;

  void WindowDidClose() {
    if (attached && view) {
      view->removed();
      attached = false;
    }
    window = nil;
    hostView = nil;
    width = 0;
    height = 0;
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
    if (closeObserver) {
      [[NSNotificationCenter defaultCenter] removeObserver:closeObserver];
      closeObserver = nil;
    }
    if (attached && view) {
      view->removed();
      attached = false;
    }
    if (window) [window close];
    window = nil;
    hostView = nil;
    view = nullptr;
    width = 0;
    height = 0;
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

bool Vst3EditorWindow::Open(Steinberg::IPlugView& view) {
  if (!NSThread.isMainThread || implementation_->window) return false;
  [NSApplication sharedApplication];
  Steinberg::ViewRect size{};
  if (view.isPlatformTypeSupported(Steinberg::kPlatformTypeNSView) != Steinberg::kResultTrue
    || view.getSize(&size) != Steinberg::kResultOk || size.right <= size.left || size.bottom <= size.top) {
    return false;
  }
  const auto width = static_cast<std::uint32_t>(size.right - size.left);
  const auto height = static_cast<std::uint32_t>(size.bottom - size.top);
  if (!ValidDimension(width) || !ValidDimension(height) || view.setFrame(&implementation_->frame) != Steinberg::kResultOk) return false;
  implementation_->window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, width, height)
    styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable)
    backing:NSBackingStoreBuffered defer:NO];
  implementation_->hostView = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, width, height)];
  [implementation_->window setContentView:implementation_->hostView];
  implementation_->view = &view;
  auto* owner = implementation_;
  implementation_->closeObserver = [[NSNotificationCenter defaultCenter]
    addObserverForName:NSWindowWillCloseNotification object:implementation_->window queue:nil
    usingBlock:^(NSNotification*) { owner->WindowDidClose(); }];
  if (view.attached((__bridge void*)implementation_->hostView, Steinberg::kPlatformTypeNSView) != Steinberg::kResultOk) {
    implementation_->Close();
    return false;
  }
  implementation_->attached = true;
  implementation_->width = width;
  implementation_->height = height;
  [implementation_->window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  return true;
}

bool Vst3EditorWindow::Close() {
  if (!NSThread.isMainThread) return false;
  const bool wasOpen = implementation_->window != nil;
  implementation_->Close();
  return wasOpen;
}

bool Vst3EditorWindow::Focus() {
  if (!NSThread.isMainThread || !implementation_->window) return false;
  [implementation_->window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  return true;
}

bool Vst3EditorWindow::Resize(const std::uint32_t width, const std::uint32_t height) {
  return NSThread.isMainThread && implementation_->Resize(width, height);
}

Vst3EditorWindowStatus Vst3EditorWindow::status() const {
  return {
    .supported = implementation_->view != nullptr,
    .open = implementation_->window != nil && implementation_->window.isVisible,
    .width = implementation_->width,
    .height = implementation_->height,
  };
}

void PumpVst3EditorEvents() {
  if (!NSThread.isMainThread || NSApp == nil) return;
  NSEvent* event = [NSApp nextEventMatchingMask:NSEventMaskAny
    untilDate:[NSDate dateWithTimeIntervalSinceNow:0]
    inMode:NSDefaultRunLoopMode dequeue:YES];
  if (event) [NSApp sendEvent:event];
}

}  // namespace daw::plugin_host
