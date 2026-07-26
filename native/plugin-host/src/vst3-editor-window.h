#pragma once

#include <cstdint>

namespace Steinberg {
class IPlugView;
}

namespace daw::plugin_host {

struct Vst3EditorWindowStatus {
  bool supported = false;
  bool open = false;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
};

// This is intentionally a worker-local macOS window. Electron only receives
// control-plane status and never owns or embeds the plug-in's foreign NSView.
class Vst3EditorWindow {
 public:
  class Implementation;

  Vst3EditorWindow();
  ~Vst3EditorWindow();
  Vst3EditorWindow(const Vst3EditorWindow&) = delete;
  Vst3EditorWindow& operator=(const Vst3EditorWindow&) = delete;

  [[nodiscard]] bool Open(Steinberg::IPlugView& view);
  [[nodiscard]] bool Close();
  [[nodiscard]] bool Focus();
  [[nodiscard]] bool Resize(std::uint32_t width, std::uint32_t height);
  [[nodiscard]] Vst3EditorWindowStatus status() const;

 private:
  Implementation* implementation_;
};

// Called by the worker's main control loop to keep AppKit event delivery on
// that same main thread without moving plug-in UI work to an Electron process.
void PumpVst3EditorEvents();

}  // namespace daw::plugin_host
