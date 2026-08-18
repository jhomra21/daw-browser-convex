#pragma once

#include "worker-supervisor.h"

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <condition_variable>
#include <mutex>
#include <optional>
#include <span>
#include <thread>

namespace daw::plugin_host {

enum class WorkerSubmissionStatus : std::uint8_t {
  kAccepted,
  kQueueFull,
  kUnavailable,
  kInvalid,
};

template <typename Value, std::size_t Capacity>
class SpscQueue {
 public:
  static_assert(Capacity > 0);

  [[nodiscard]] bool TryPush(const Value& value) noexcept {
    const auto write = write_.load(std::memory_order_relaxed);
    if (write - read_.load(std::memory_order_acquire) == Capacity) return false;
    values_[write % Capacity] = value;
    write_.store(write + 1, std::memory_order_release);
    return true;
  }

  [[nodiscard]] bool TryPop(Value& value) noexcept {
    const auto read = read_.load(std::memory_order_relaxed);
    if (read == write_.load(std::memory_order_acquire)) return false;
    value = values_[read % Capacity];
    read_.store(read + 1, std::memory_order_release);
    return true;
  }

  [[nodiscard]] bool Empty() const noexcept {
    return read_.load(std::memory_order_acquire) == write_.load(std::memory_order_acquire);
  }

  [[nodiscard]] bool HasSpace() const noexcept {
    return write_.load(std::memory_order_acquire) - read_.load(std::memory_order_acquire) < Capacity;
  }

 private:
  alignas(64) std::array<Value, Capacity> values_{};
  alignas(64) std::atomic<std::size_t> write_{0};
  alignas(64) std::atomic<std::size_t> read_{0};
};

struct WorkerSubmission {
  std::size_t slotIndex = 0;
  std::uint64_t sequence = 0;
  std::size_t numSamples = 0;
  std::span<const WorkerTransportEvent> events;
  WorkerBlockContext context{};
};

struct WorkerCompletion {
  std::size_t slotIndex = 0;
  std::uint64_t sequence = 0;
};

class WorkerCallbackPort {
 public:
  WorkerCallbackPort() = default;
  [[nodiscard]] WorkerSubmissionStatus Submit(const WorkerSubmission& submission) const noexcept;
  [[nodiscard]] bool ReadCompleted(std::size_t slotIndex, std::uint64_t sequence) const noexcept;
  [[nodiscard]] bool CopyCompletedOutput(
    std::size_t slotIndex,
    std::uint64_t sequence,
    std::span<float> output,
    std::uint64_t* outputSilenceFlags = nullptr
  ) const noexcept;
  [[nodiscard]] bool CopyInput(
    std::size_t slotIndex,
    std::span<const float> input
  ) const noexcept;
  [[nodiscard]] bool DiscardLate(std::size_t slotIndex, std::uint64_t sequence) const noexcept;
  [[nodiscard]] bool PublishDiagnostic(WorkerDiagnostic diagnostic) const noexcept;
  [[nodiscard]] std::optional<WorkerTailMetadata> ReadTailMetadata() const noexcept;
  [[nodiscard]] WorkerHealth health() const noexcept;

 private:
  friend class WorkerControlService;
  explicit WorkerCallbackPort(class WorkerControlService* service) : service_(service) {}
  class WorkerControlService* service_ = nullptr;
};

class WorkerControlService {
 public:
  using DiagnosticListener = void (*)(const WorkerDiagnostic&, void*) noexcept;

  // Stop and Restart require the caller to quiesce all callback ports first.
  // Their shared transport is otherwise stable for the service lifetime.
  WorkerControlService();
  ~WorkerControlService();
  WorkerControlService(const WorkerControlService&) = delete;
  WorkerControlService& operator=(const WorkerControlService&) = delete;

  [[nodiscard]] bool Start(
    const WorkerStartupRequest& startup,
    const WorkerHostConfiguration& configuration,
    const WorkerTransportRequest& request
  );
  void Stop();
  [[nodiscard]] bool Restart();
  [[nodiscard]] bool SetState(const WorkerState& state);
  [[nodiscard]] std::optional<WorkerState> GetState();
  [[nodiscard]] WorkerHealth health() const noexcept;
  [[nodiscard]] std::uint64_t workerGeneration() const noexcept;
  [[nodiscard]] int workerProcessGroupId() const noexcept;
  [[nodiscard]] std::optional<WorkerDiagnostic> ReadDiagnostic();
  void SetDiagnosticListener(DiagnosticListener listener, void* context) noexcept;
  [[nodiscard]] std::optional<WorkerEditorResponse> ExecuteEditorCommand(
    WorkerControlCommand command,
    std::uint32_t width = 0,
    std::uint32_t height = 0,
    std::optional<WorkerEditorAnchor> anchor = std::nullopt
  );
  [[nodiscard]] WorkerSubmissionStatus ProcessOffline(
    const WorkerSubmission& submission,
    std::chrono::milliseconds timeout
  );
  [[nodiscard]] WorkerCallbackPort callbackPort() noexcept;

 private:
  friend class WorkerCallbackPort;
  static constexpr std::size_t kQueueCapacity = kMaximumWorkerSlots;
  struct QueuedSubmission {
    std::size_t slotIndex = 0;
    std::uint64_t sequence = 0;
  };

  [[nodiscard]] WorkerSubmissionStatus PublishFromCallback(const WorkerSubmission& submission) noexcept;
  [[nodiscard]] bool ReadCompletionFromCallback(std::size_t slotIndex, std::uint64_t sequence) const noexcept;
  [[nodiscard]] bool CopyCompletionOutputFromCallback(
    std::size_t slotIndex,
    std::uint64_t sequence,
    std::span<float> output,
    std::uint64_t* outputSilenceFlags = nullptr
  ) noexcept;
  [[nodiscard]] bool CopyInputFromCallback(std::size_t slotIndex, std::span<const float> input) noexcept;
  [[nodiscard]] bool DiscardLateFromCallback(std::size_t slotIndex, std::uint64_t sequence) noexcept;
  [[nodiscard]] bool PublishDiagnosticFromCallback(WorkerDiagnostic diagnostic) noexcept;
  [[nodiscard]] std::optional<WorkerTailMetadata> ReadTailMetadataFromCallback() const noexcept;
  [[nodiscard]] WorkerHealth ReadHealthFromCallback() const noexcept;
  void Run();
  void NotifyService() noexcept;
  void PublishFault() noexcept;

  WorkerRuntime runtime_;
  SpscQueue<QueuedSubmission, kQueueCapacity> submissions_;
  SpscQueue<WorkerCompletion, kQueueCapacity> completions_;
  SpscQueue<WorkerDiagnostic, kQueueCapacity> callbackDiagnostics_;
  SpscQueue<WorkerDiagnostic, kQueueCapacity> diagnostics_;
  std::atomic<WorkerHealth> health_{WorkerHealth::kStopped};
  std::atomic<bool> running_{false};
  std::atomic<std::uint64_t> wakeSequence_{0};
  std::atomic<DiagnosticListener> diagnosticListener_{nullptr};
  std::atomic<void*> diagnosticContext_{nullptr};
  std::thread thread_;
  std::mutex control_mutex_;
  std::mutex wake_mutex_;
  std::condition_variable wake_ready_;
};

}  // namespace daw::plugin_host
