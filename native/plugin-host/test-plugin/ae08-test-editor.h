#pragma once

// A plain child view added to the host's parent NSView, and its removal.
void* Ae08AttachPlainView(void* parent, int width, int height);
void Ae08RemovePlainView(void* child);
