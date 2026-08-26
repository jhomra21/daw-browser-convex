#pragma once

#include "worker-supervisor.h"

#include <cstdint>
#include <optional>

namespace Steinberg {
class IPlugView;
}

namespace daw::plugin_host {

[[nodiscard]] bool PrepareVst3EditorRuntime();

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

  [[nodiscard]] bool Open(Steinberg::IPlugView& view, std::optional<WorkerEditorAnchor> anchor = std::nullopt);
  [[nodiscard]] bool Close();
  [[nodiscard]] bool Focus(std::optional<WorkerEditorAnchor> anchor = std::nullopt);
  [[nodiscard]] bool Resize(std::uint32_t width, std::uint32_t height);
  [[nodiscard]] Vst3EditorWindowStatus status() const;

 private:
  Implementation* implementation_;
};

// Called by the worker's main control loop to keep AppKit event delivery on
// that same main thread without moving plug-in UI work to an Electron process.
void PumpVst3EditorEvents();
[[nodiscard]] bool ConsumeVst3EditorInteraction();

}  // namespace daw::plugin_host
