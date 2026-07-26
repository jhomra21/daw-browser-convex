#pragma once

#include "worker-supervisor.h"

#include <cstdint>
#include <optional>

namespace daw::plugin_host {

enum class WorkerControlCommand : std::uint32_t {
  kProcess = 1,
  kStop = 2,
  kEditorOpen = 3,
  kEditorClose = 4,
  kEditorFocus = 5,
  kEditorResize = 6,
  kEditorStatus = 7,
  kStateSet = 8,
  kStateGet = 9,
};

[[nodiscard]] bool WriteWorkerStartupRequest(
  int fileDescriptor,
  std::uint64_t transportToken,
  const WorkerStartupRequest& request
);
[[nodiscard]] std::optional<WorkerStartupRequest> ReadWorkerStartupRequest(
  int fileDescriptor,
  std::uint64_t transportToken
);
[[nodiscard]] bool WriteWorkerControlCommand(
  int fileDescriptor,
  WorkerControlCommand command,
  std::uint32_t width = 0,
  std::uint32_t height = 0
);
struct WorkerControlRequest {
  WorkerControlCommand command;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
};
[[nodiscard]] std::optional<WorkerControlRequest> ReadWorkerControlCommand(int fileDescriptor);
[[nodiscard]] bool WriteWorkerEditorResponse(int fileDescriptor, const WorkerEditorResponse& response);
[[nodiscard]] std::optional<WorkerEditorResponse> ReadWorkerEditorResponse(int fileDescriptor);
[[nodiscard]] bool WriteWorkerState(int fileDescriptor, const WorkerState& state);
[[nodiscard]] std::optional<WorkerState> ReadWorkerState(int fileDescriptor);
[[nodiscard]] bool WriteWorkerHello(int fileDescriptor, const WorkerHello& hello);
[[nodiscard]] std::optional<WorkerHello> ReadWorkerHello(int fileDescriptor);

}  // namespace daw::plugin_host
