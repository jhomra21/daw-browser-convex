#include "worker-control-service.h"

#include <chrono>

namespace daw::plugin_host {
namespace {

constexpr auto kCallbackBridgeInterval = std::chrono::microseconds(100);

void DrainDiagnostics(
  WorkerRuntime& runtime,
  SpscQueue<WorkerDiagnostic, kMaximumWorkerSlots>& diagnostics,
  const WorkerControlService::DiagnosticListener listener,
  void* const context
) {
  while (const auto diagnostic = runtime.ReadDiagnostic()) {
    static_cast<void>(diagnostics.TryPush(*diagnostic));
    if (listener != nullptr) listener(*diagnostic, context);
  }
}

}  // namespace

WorkerSubmissionStatus WorkerCallbackPort::Submit(const WorkerSubmission& submission) const noexcept {
  return service_ ? service_->PublishFromCallback(submission) : WorkerSubmissionStatus::kUnavailable;
}

bool WorkerCallbackPort::ReadCompleted(const std::size_t slotIndex, const std::uint64_t sequence) const noexcept {
  return service_ && service_->ReadCompletionFromCallback(slotIndex, sequence);
}

bool WorkerCallbackPort::CopyCompletedOutput(
  const std::size_t slotIndex,
  const std::uint64_t sequence,
  const std::span<float> output
) const noexcept {
  return service_ && service_->CopyCompletionOutputFromCallback(slotIndex, sequence, output);
}

bool WorkerCallbackPort::CopyInput(const std::size_t slotIndex, const std::span<const float> input) const noexcept {
  return service_ && service_->CopyInputFromCallback(slotIndex, input);
}

bool WorkerCallbackPort::DiscardLate(const std::size_t slotIndex, const std::uint64_t sequence) const noexcept {
  return service_ && service_->DiscardLateFromCallback(slotIndex, sequence);
}

bool WorkerCallbackPort::PublishDiagnostic(const WorkerDiagnostic diagnostic) const noexcept {
  return service_ && service_->PublishDiagnosticFromCallback(diagnostic);
}

WorkerHealth WorkerCallbackPort::health() const noexcept {
  return service_ ? service_->ReadHealthFromCallback() : WorkerHealth::kStopped;
}

WorkerControlService::WorkerControlService() = default;

WorkerControlService::~WorkerControlService() {
  Stop();
}

bool WorkerControlService::Start(
  const WorkerStartupRequest& startup,
  const WorkerHostConfiguration& configuration,
  const WorkerTransportRequest& request
) {
  Stop();
  health_.store(WorkerHealth::kStarting, std::memory_order_release);
  if (!runtime_.Start(startup, configuration, request)) {
    PublishFault();
    return false;
  }
  running_.store(true, std::memory_order_release);
  thread_ = std::thread(&WorkerControlService::Run, this);
  callbackBridgeRunning_.store(true, std::memory_order_release);
  callbackBridgeThread_ = std::thread(&WorkerControlService::BridgeCallbackActivity, this);
  return true;
}

void WorkerControlService::Stop() {
  if (running_.exchange(false, std::memory_order_acq_rel)) {
    callbackBridgeRunning_.store(false, std::memory_order_release);
    NotifyService();
    if (callbackBridgeThread_.joinable()) callbackBridgeThread_.join();
    if (thread_.joinable()) thread_.join();
  }
  runtime_.Stop();
  health_.store(WorkerHealth::kStopped, std::memory_order_release);
}

bool WorkerControlService::Restart() {
  if (!running_.load(std::memory_order_acquire)) return false;
  // Restart is a control-plane operation. The host must quiesce its callback
  // port before replacing the shared transport.
  running_.store(false, std::memory_order_release);
  callbackBridgeRunning_.store(false, std::memory_order_release);
  NotifyService();
  if (callbackBridgeThread_.joinable()) callbackBridgeThread_.join();
  if (thread_.joinable()) thread_.join();
  const auto restarted = runtime_.Restart();
  health_.store(restarted ? WorkerHealth::kStarting : WorkerHealth::kFaulted, std::memory_order_release);
  if (restarted) {
    running_.store(true, std::memory_order_release);
    thread_ = std::thread(&WorkerControlService::Run, this);
    callbackBridgeRunning_.store(true, std::memory_order_release);
    callbackBridgeThread_ = std::thread(&WorkerControlService::BridgeCallbackActivity, this);
  }
  return restarted;
}

bool WorkerControlService::SetState(const WorkerState& state) {
  std::lock_guard lock(control_mutex_);
  return running_.load(std::memory_order_acquire) && runtime_.SetState(state);
}

std::optional<WorkerState> WorkerControlService::GetState() {
  std::lock_guard lock(control_mutex_);
  if (!running_.load(std::memory_order_acquire)) return std::nullopt;
  return runtime_.GetState();
}

WorkerHealth WorkerControlService::health() const noexcept {
  return health_.load(std::memory_order_acquire);
}

std::optional<WorkerDiagnostic> WorkerControlService::ReadDiagnostic() {
  WorkerDiagnostic diagnostic{};
  if (!diagnostics_.TryPop(diagnostic)) return std::nullopt;
  return diagnostic;
}

void WorkerControlService::SetDiagnosticListener(
  const DiagnosticListener listener,
  void* const context
) noexcept {
  diagnosticContext_.store(context, std::memory_order_relaxed);
  diagnosticListener_.store(listener, std::memory_order_release);
}

std::optional<WorkerEditorResponse> WorkerControlService::ExecuteEditorCommand(
  const WorkerControlCommand command,
  const std::uint32_t width,
  const std::uint32_t height
) {
  std::lock_guard lock(control_mutex_);
  if (!running_.load(std::memory_order_acquire)) return std::nullopt;
  return runtime_.ExecuteEditorCommand(command, width, height);
}

WorkerCallbackPort WorkerControlService::callbackPort() noexcept {
  return WorkerCallbackPort(this);
}

// DAW_REALTIME_CALLBACK_REGION_BEGIN worker-control-service
WorkerSubmissionStatus WorkerControlService::PublishFromCallback(const WorkerSubmission& submission) noexcept {
  if (!running_.load(std::memory_order_acquire)) return WorkerSubmissionStatus::kUnavailable;
  if (submission.sequence == 0 || !runtime_.PublishSubmission(
    submission.slotIndex, submission.sequence, submission.numSamples, submission.events
  )) {
    return WorkerSubmissionStatus::kInvalid;
  }
  if (!submissions_.TryPush({.slotIndex = submission.slotIndex, .sequence = submission.sequence})) {
    static_cast<void>(runtime_.CancelPublishedSubmission(submission.slotIndex, submission.sequence));
    return WorkerSubmissionStatus::kQueueFull;
  }
  callbackActivitySequence_.fetch_add(1, std::memory_order_release);
  return WorkerSubmissionStatus::kAccepted;
}

bool WorkerControlService::ReadCompletionFromCallback(
  const std::size_t slotIndex,
  const std::uint64_t sequence
) const noexcept {
  return runtime_.ReadCompleted(slotIndex, sequence);
}

bool WorkerControlService::CopyCompletionOutputFromCallback(
  const std::size_t slotIndex,
  const std::uint64_t sequence,
  const std::span<float> output
) noexcept {
  return runtime_.CopyCompletedOutput(slotIndex, sequence, output);
}

bool WorkerControlService::CopyInputFromCallback(const std::size_t slotIndex, const std::span<const float> input) noexcept {
  return runtime_.CopyInput(slotIndex, input);
}

bool WorkerControlService::DiscardLateFromCallback(const std::size_t slotIndex, const std::uint64_t sequence) noexcept {
  return runtime_.DiscardLate(slotIndex, sequence);
}

bool WorkerControlService::PublishDiagnosticFromCallback(const WorkerDiagnostic diagnostic) noexcept {
  if (!callbackDiagnostics_.TryPush(diagnostic)) return false;
  callbackActivitySequence_.fetch_add(1, std::memory_order_release);
  return true;
}

WorkerHealth WorkerControlService::ReadHealthFromCallback() const noexcept {
  return runtime_.callbackHealth();
}
// DAW_REALTIME_CALLBACK_REGION_END worker-control-service

void WorkerControlService::BridgeCallbackActivity() {
  std::uint64_t observed = callbackActivitySequence_.load(std::memory_order_acquire);
  auto nextHealthCheck = std::chrono::steady_clock::now() + std::chrono::milliseconds(10);
  while (callbackBridgeRunning_.load(std::memory_order_acquire)) {
    // The realtime producer cannot safely signal a scheduler primitive, so a
    // dedicated non-realtime bridge polls its atomic sequence at a bounded
    // sub-block interval and performs the actual control-thread wakeup.
    std::this_thread::sleep_for(kCallbackBridgeInterval);
    const std::uint64_t current = callbackActivitySequence_.load(std::memory_order_acquire);
    const auto now = std::chrono::steady_clock::now();
    if (current == observed && now < nextHealthCheck) continue;
    observed = current;
    nextHealthCheck = now + std::chrono::milliseconds(10);
    NotifyService();
  }
}

void WorkerControlService::Run() {
  std::uint64_t observedWake = wakeSequence_.load(std::memory_order_acquire);
  while (running_.load(std::memory_order_acquire)) {
    QueuedSubmission submission{};
    auto currentHealth = health_.load(std::memory_order_acquire) == WorkerHealth::kFaulted
      ? WorkerHealth::kFaulted
      : runtime_.health();
    if (currentHealth == WorkerHealth::kFaulted) {
      while (submissions_.TryPop(submission)) {
        static_cast<void>(runtime_.CancelPublishedSubmission(submission.slotIndex, submission.sequence));
      }
    } else {
      bool dispatchFailed = false;
      while (submissions_.TryPop(submission)) {
        std::lock_guard lock(control_mutex_);
        if (!runtime_.DispatchPublishedSubmission(submission.slotIndex, submission.sequence)) {
          static_cast<void>(runtime_.CancelPublishedSubmission(submission.slotIndex, submission.sequence));
          dispatchFailed = true;
        }
      }
      currentHealth = dispatchFailed ? WorkerHealth::kFaulted : runtime_.health();
    }
    const WorkerHealth previousHealth = health_.exchange(currentHealth, std::memory_order_acq_rel);
    DrainDiagnostics(
      runtime_,
      diagnostics_,
      diagnosticListener_.load(std::memory_order_acquire),
      diagnosticContext_.load(std::memory_order_relaxed)
    );
    WorkerDiagnostic callbackDiagnostic{};
    while (callbackDiagnostics_.TryPop(callbackDiagnostic)) {
      static_cast<void>(diagnostics_.TryPush(callbackDiagnostic));
      const auto listener = diagnosticListener_.load(std::memory_order_acquire);
      if (listener != nullptr) {
        listener(callbackDiagnostic, diagnosticContext_.load(std::memory_order_relaxed));
      }
    }
    if (currentHealth == WorkerHealth::kFaulted && previousHealth != WorkerHealth::kFaulted) {
      PublishFault();
    }
    const auto nextWake = wakeSequence_.load(std::memory_order_acquire);
    if (nextWake == observedWake && running_.load(std::memory_order_acquire)) {
      std::unique_lock lock(wake_mutex_);
      wake_ready_.wait(lock, [this, observedWake] {
        return wakeSequence_.load(std::memory_order_acquire) != observedWake
          || !running_.load(std::memory_order_acquire);
      });
    }
    observedWake = wakeSequence_.load(std::memory_order_acquire);
  }
}

void WorkerControlService::NotifyService() noexcept {
  wakeSequence_.fetch_add(1, std::memory_order_release);
  wake_ready_.notify_one();
}

void WorkerControlService::PublishFault() noexcept {
  health_.store(WorkerHealth::kFaulted, std::memory_order_release);
  const WorkerDiagnostic diagnostic{.kind = WorkerDiagnosticKind::kFault};
  static_cast<void>(diagnostics_.TryPush(diagnostic));
  const auto listener = diagnosticListener_.load(std::memory_order_acquire);
  if (listener != nullptr) listener(diagnostic, diagnosticContext_.load(std::memory_order_relaxed));
}

}  // namespace daw::plugin_host
