#pragma once

#include "editor-parameter-state.h"
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
  kEditorInteraction,
  kParameterEdit,
  kTail,
  kEditorState,
};

struct WorkerNotification {
  WorkerNotificationKind kind = WorkerNotificationKind::kFault;
  std::string message;
  std::uint32_t value = 0;
  std::uint32_t parameter_id = 0;
  double normalized_value = 0.0;
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
  [[nodiscard]] bool ConfigureTransport(WorkerTransport& transport, const WorkerState* initialState = nullptr);
  [[nodiscard]] bool ProcessSubmittedSlot(std::size_t slotIndex);
  [[nodiscard]] bool PeekEditorParameterFeedback(PendingEditorParameterEdit& edit) const;
  [[nodiscard]] bool AckEditorParameterFeedback(
    std::uint32_t parameterId,
    std::uint64_t generation
  );
  [[nodiscard]] std::optional<WorkerState> GetState();
  [[nodiscard]] bool SetState(const WorkerState& state);
  void RefreshLifecycleMetadata();
  [[nodiscard]] bool EditorCommandSupported() const;
  [[nodiscard]] WorkerEditorStatus EditorStatus() const;
  [[nodiscard]] bool ExecuteEditorCommand(
    WorkerEditorCommand command,
    std::uint32_t width = 0,
    std::uint32_t height = 0,
    std::optional<WorkerEditorAnchor> anchor = std::nullopt
  );
  void PublishEditorOpenState(bool open);
  void Dispose();

  [[nodiscard]] bool ready() const;
  [[nodiscard]] const std::vector<WorkerNotification>& notifications() const;

 private:
  class Implementation;
  [[nodiscard]] bool ApplyState(const WorkerState& state);
  Implementation* implementation_;
};

}  // namespace daw::plugin_host
