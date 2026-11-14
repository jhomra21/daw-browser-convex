// The test plug-in's editor surface: a plain child NSView with no controls, so the host's editor path has something real to attach.
#import <AppKit/AppKit.h>

#include "ae08-test-editor.h"

void* Ae08AttachPlainView(void* parent, const int width, const int height) {
  NSView* child = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, width, height)];
  [(__bridge NSView*)parent addSubview:child];
  return (void*)CFBridgingRetain(child);
}

void Ae08RemovePlainView(void* child) {
  NSView* view = (NSView*)CFBridgingRelease(child);
  [view removeFromSuperview];
}
