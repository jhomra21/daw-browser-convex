#pragma once

#include "worker-supervisor.h"
#include "vst3-editor-window.h"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <vector>

namespace daw::plugin_host {

enum class WorkerNotificationKind {
  kRestart,
  kLatency,
  kBuses,
  kFault,
};

struct WorkerNotification {
  WorkerNotificationKind kind = WorkerNotificationKind::kFault;
  std::string message;
  std::uint32_t value = 0;
};

struct WorkerInstanceRequest {
  WorkerLaunchEligibility eligibility;
  std::string classId;
  WorkerProcessSetup setup;
};

[[nodiscard]] std::string Sha256(std::span<const std::uint8_t> bytes);

class Vst3Worker {
 public:
  Vst3Worker();
  ~Vst3Worker();
  Vst3Worker(const Vst3Worker&) = delete;
  Vst3Worker& operator=(const Vst3Worker&) = delete;

  [[nodiscard]] bool Instantiate(const WorkerInstanceRequest& request);
  [[nodiscard]] std::optional<WorkerManifest> PreflightManifest(const WorkerTransportRequest& transport, std::uint32_t stateRevision);
  [[nodiscard]] bool ConfigureTransport(WorkerTransport& transport);
  [[nodiscard]] bool ProcessSubmittedSlot(std::size_t slotIndex);
  [[nodiscard]] std::optional<WorkerState> GetState();
  [[nodiscard]] bool SetState(const WorkerState& state);
  [[nodiscard]] bool EditorCommandSupported() const;
  [[nodiscard]] WorkerEditorStatus EditorStatus() const;
  [[nodiscard]] bool ExecuteEditorCommand(WorkerEditorCommand command, std::uint32_t width = 0, std::uint32_t height = 0);
  void Dispose();

  [[nodiscard]] bool ready() const;
  [[nodiscard]] const std::vector<WorkerNotification>& notifications() const;

 private:
  class Implementation;
  Implementation* implementation_;
};

}  // namespace daw::plugin_host
