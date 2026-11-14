#include "worker-control-service.h"

#include <chrono>
#include <cinttypes>
#include <cstdio>

namespace daw::plugin_host {
namespace {

void LogIncident(const WorkerDiagnostic& diagnostic, const std::uint64_t generation) {
  if (diagnostic.kind != WorkerDiagnosticKind::kFault
    && diagnostic.kind != WorkerDiagnosticKind::kMiss
    && diagnostic.kind != WorkerDiagnosticKind::kRestart) return;
  const auto fault = diagnostic.kind == WorkerDiagnosticKind::kFault;
  // One bounded stdio call keeps concurrent service lines intact; never runs
  // on the audio callback or includes plugin identity/authentication tokens.
  std::fprintf(stderr,
    "[vst-worker-incident] {\"kind\":%" PRIu32 ",\"workerGeneration\":%" PRIu64
    ",\"sequence\":%" PRIu64 ",\"transportEpoch\":%" PRIu32
    ",\"originCode\":%" PRIu32 ",\"childCode\":%" PRIu32
    ",\"childStatus\":%" PRIu32 ",\"value\":%" PRIu32 "}\n",
    static_cast<std::uint32_t>(diagnostic.kind), generation, diagnostic.sequence, diagnostic.transport_epoch,
    fault ? diagnostic.value & 0xffU : 0U,
    fault ? (diagnostic.value >> 8U) & 0xffU : 0U,
    fault ? (diagnostic.value >> 16U) & 0xffU : 0U, diagnostic.value);
}

void DrainDiagnostics(
  WorkerRuntime& runtime,
  SpscQueue<WorkerDiagnostic, kMaximumWorkerSlots>& diagnostics,
  const std::uint64_t generation,
  const WorkerControlService::DiagnosticListener listener,
  void* const context
) {
  while (const auto diagnostic = runtime.ReadDiagnostic()) {
    LogIncident(*diagnostic, generation);
    if (diagnostic->kind != WorkerDiagnosticKind::kParameterEdit) {
      static_cast<void>(diagnostics.TryPush(*diagnostic));
    }
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

WorkerSlotStatus WorkerCallbackPort::ReadStatus(
  const std::size_t slotIndex,
  const std::uint64_t sequence
) const noexcept {
  return service_ ? service_->ReadStatusFromCallback(slotIndex, sequence) : WorkerSlotStatus::kDropped;
}

bool WorkerCallbackPort::CopyCompletedOutput(
  const std::size_t slotIndex,
  const std::uint64_t sequence,
  const std::span<float> output,
  std::uint64_t* const outputSilenceFlags
) const noexcept {
  return service_ && service_->CopyCompletionOutputFromCallback(slotIndex, sequence, output, outputSilenceFlags);
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

std::optional<WorkerTailMetadata> WorkerCallbackPort::ReadTailMetadata() const noexcept {
  return service_ ? service_->ReadTailMetadataFromCallback() : std::nullopt;
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
  ++incidentWorkerGeneration_;
  if (!runtime_.Start(startup, configuration, request)) {
    PublishFault(EncodeWorkerFault(WorkerFaultOrigin::kStartupFailure));
    return false;
  }
  running_.store(true, std::memory_order_release);
  thread_ = std::thread(&WorkerControlService::Run, this);
  return true;
}

void WorkerControlService::Stop() {
  if (running_.exchange(false, std::memory_order_acq_rel)) {
    NotifyService();
  }
  if (thread_.joinable()) thread_.join();
  runtime_.Stop();
  health_.store(WorkerHealth::kStopped, std::memory_order_release);
}

bool WorkerControlService::Restart() {
  if (!running_.load(std::memory_order_acquire)) return false;
  // Restart is a control-plane operation. The host must quiesce its callback
  // port before replacing the shared transport.
  running_.store(false, std::memory_order_release);
  NotifyService();
  if (thread_.joinable()) thread_.join();
  const auto restarted = runtime_.Restart();
  health_.store(restarted ? WorkerHealth::kStarting : WorkerHealth::kFaulted, std::memory_order_release);
  if (restarted) {
    ++incidentWorkerGeneration_;
    running_.store(true, std::memory_order_release);
    thread_ = std::thread(&WorkerControlService::Run, this);
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

std::uint64_t WorkerControlService::workerGeneration() const noexcept {
  const auto* transport = runtime_.transport();
  return transport == nullptr ? 0 : transport->token();
}

int WorkerControlService::workerProcessGroupId() const noexcept {
  return runtime_.processGroupId();
}

std::optional<WorkerDiagnostic> WorkerControlService::ReadDiagnostic() {
  WorkerDiagnostic diagnostic{};
  if (!diagnostics_.TryPop(diagnostic)) return std::nullopt;
  return diagnostic;
}

WorkerProcessingMetrics WorkerControlService::processingMetrics() const {
  const auto* transport = runtime_.transport();
  return transport == nullptr ? WorkerProcessingMetrics{} : transport->ReadProcessingMetrics();
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
  const std::uint32_t height,
  const std::optional<WorkerEditorAnchor> anchor
) {
  std::lock_guard lock(control_mutex_);
  if (!running_.load(std::memory_order_acquire)) return std::nullopt;
  return runtime_.ExecuteEditorCommand(command, width, height, anchor);
}

WorkerSubmissionStatus WorkerControlService::ProcessOffline(
  const WorkerSubmission& submission,
  const std::chrono::milliseconds timeout
) {
  bool completed = false;
  auto faultValue = EncodeWorkerFault(WorkerFaultOrigin::kOfflineCompletionFailure);
  {
    std::lock_guard lock(control_mutex_);
    if (!running_.load(std::memory_order_acquire)) return WorkerSubmissionStatus::kUnavailable;
    if (!runtime_.PublishSubmission(
      submission.slotIndex,
      submission.sequence,
      submission.numSamples,
      submission.events,
      submission.context
    )) return WorkerSubmissionStatus::kInvalid;
    if (!runtime_.DispatchPublishedSubmission(submission.slotIndex, submission.sequence)) {
      faultValue = EncodeWorkerFault(WorkerFaultOrigin::kDispatchFailure);
      static_cast<void>(runtime_.CancelPublishedSubmission(submission.slotIndex, submission.sequence));
    } else {
      completed = runtime_.WaitForOfflineCompletion(submission.slotIndex, submission.sequence, timeout);
    }
  }
  if (completed) {
    health_.store(runtime_.health(), std::memory_order_release);
    return WorkerSubmissionStatus::kAccepted;
  }
  PublishFault(faultValue, submission.sequence);
  running_.store(false, std::memory_order_release);
  NotifyService();
  if (thread_.joinable()) thread_.join();
  runtime_.Stop();
  return WorkerSubmissionStatus::kUnavailable;
}

WorkerCallbackPort WorkerControlService::callbackPort() noexcept {
  return WorkerCallbackPort(this);
}

// DAW_REALTIME_CALLBACK_REGION_BEGIN worker-control-service
WorkerSubmissionStatus WorkerControlService::PublishFromCallback(const WorkerSubmission& submission) noexcept {
  if (!running_.load(std::memory_order_acquire)) return WorkerSubmissionStatus::kUnavailable;
  if (submission.sequence == 0 || !runtime_.PublishSubmission(
    submission.slotIndex, submission.sequence, submission.numSamples, submission.events, submission.context
  )) {
    return WorkerSubmissionStatus::kInvalid;
  }
  if (!submissions_.TryPush({.slotIndex = submission.slotIndex, .sequence = submission.sequence})) {
    static_cast<void>(runtime_.CancelPublishedSubmission(submission.slotIndex, submission.sequence));
    return WorkerSubmissionStatus::kQueueFull;
  }
  // A full pipe still means a wake is pending. Any other write failure means
  // the submission cannot be guaranteed to run, so release its shared slot.
  if (!runtime_.NotifyRealtimeWorker()) {
    static_cast<void>(runtime_.CancelPublishedSubmission(submission.slotIndex, submission.sequence));
    return WorkerSubmissionStatus::kUnavailable;
  }
  return WorkerSubmissionStatus::kAccepted;
}

bool WorkerControlService::ReadCompletionFromCallback(
  const std::size_t slotIndex,
  const std::uint64_t sequence
) const noexcept {
  return runtime_.ReadCompleted(slotIndex, sequence);
}

WorkerSlotStatus WorkerControlService::ReadStatusFromCallback(
  const std::size_t slotIndex,
  const std::uint64_t sequence
) const noexcept {
  const auto* transport = runtime_.transport();
  if (transport == nullptr) return WorkerSlotStatus::kDropped;
  const auto slot = transport->slot(slotIndex);
  return slot.sequence == sequence ? slot.status : WorkerSlotStatus::kDropped;
}

bool WorkerControlService::CopyCompletionOutputFromCallback(
  const std::size_t slotIndex,
  const std::uint64_t sequence,
  const std::span<float> output,
  std::uint64_t* const outputSilenceFlags
) noexcept {
  return runtime_.CopyCompletedOutput(slotIndex, sequence, output, outputSilenceFlags);
}

bool WorkerControlService::CopyInputFromCallback(const std::size_t slotIndex, const std::span<const float> input) noexcept {
  return runtime_.CopyInput(slotIndex, input);
}

bool WorkerControlService::DiscardLateFromCallback(const std::size_t slotIndex, const std::uint64_t sequence) noexcept {
  return runtime_.DiscardLate(slotIndex, sequence);
}

bool WorkerControlService::PublishDiagnosticFromCallback(const WorkerDiagnostic diagnostic) noexcept {
  if (!callbackDiagnostics_.TryPush(diagnostic)) return false;
  return true;
}

std::optional<WorkerTailMetadata> WorkerControlService::ReadTailMetadataFromCallback() const noexcept {
  return runtime_.ReadTailMetadata();
}

WorkerHealth WorkerControlService::ReadHealthFromCallback() const noexcept {
  return runtime_.callbackHealth();
}
// DAW_REALTIME_CALLBACK_REGION_END worker-control-service

void WorkerControlService::Run() {
  while (running_.load(std::memory_order_acquire)) {
    QueuedSubmission submission{};
    std::uint64_t dispatchFailureSequence = 0;
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
          dispatchFailureSequence = submission.sequence;
        }
      }
      currentHealth = dispatchFailed ? WorkerHealth::kFaulted : runtime_.health();
    }
    const WorkerHealth previousHealth = health_.exchange(currentHealth, std::memory_order_acq_rel);
    DrainDiagnostics(
      runtime_,
      diagnostics_,
      incidentWorkerGeneration_,
      diagnosticListener_.load(std::memory_order_acquire),
      diagnosticContext_.load(std::memory_order_relaxed)
    );
    WorkerDiagnostic callbackDiagnostic{};
    bool callbackFault = false;
    std::uint64_t missedSequence = 0;
    while (callbackDiagnostics_.TryPop(callbackDiagnostic)) {
      LogIncident(callbackDiagnostic, incidentWorkerGeneration_);
      if (callbackDiagnostic.kind != WorkerDiagnosticKind::kParameterEdit) {
        static_cast<void>(diagnostics_.TryPush(callbackDiagnostic));
      }
      const auto listener = diagnosticListener_.load(std::memory_order_acquire);
      if (listener != nullptr) {
        listener(callbackDiagnostic, diagnosticContext_.load(std::memory_order_relaxed));
      }
      if (callbackDiagnostic.kind == WorkerDiagnosticKind::kMiss) {
        {
          std::lock_guard lock(control_mutex_);
          static_cast<void>(runtime_.TerminateForFault());
        }
        health_.store(WorkerHealth::kFaulted, std::memory_order_release);
        running_.store(false, std::memory_order_release);
        callbackFault = true;
        missedSequence = callbackDiagnostic.sequence;
      }
    }
    if (callbackFault) {
      PublishFault(EncodeWorkerFault(WorkerFaultOrigin::kCallbackMissTermination), missedSequence);
      break;
    }
    if (currentHealth == WorkerHealth::kFaulted && previousHealth != WorkerHealth::kFaulted) {
      PublishFault(dispatchFailureSequence != 0
        ? EncodeWorkerFault(WorkerFaultOrigin::kDispatchFailure) : runtime_.faultValue(),
        dispatchFailureSequence);
    }
    if (running_.load(std::memory_order_acquire)) {
      std::unique_lock lock(wake_mutex_);
      const auto observedWake = wakeSequence_.load(std::memory_order_acquire);
      wake_ready_.wait_for(lock, std::chrono::milliseconds(2), [this, observedWake] {
        return wakeSequence_.load(std::memory_order_acquire) != observedWake
          || !running_.load(std::memory_order_acquire);
      });
    }
  }
}

void WorkerControlService::NotifyService() noexcept {
  wakeSequence_.fetch_add(1, std::memory_order_release);
  wake_ready_.notify_one();
}

void WorkerControlService::PublishFault(const std::uint32_t value, const std::uint64_t sequence) noexcept {
  health_.store(WorkerHealth::kFaulted, std::memory_order_release);
  const WorkerDiagnostic diagnostic{.kind = WorkerDiagnosticKind::kFault, .value = value, .sequence = sequence};
  LogIncident(diagnostic, incidentWorkerGeneration_);
  static_cast<void>(diagnostics_.TryPush(diagnostic));
  const auto listener = diagnosticListener_.load(std::memory_order_acquire);
  if (listener != nullptr) listener(diagnostic, diagnosticContext_.load(std::memory_order_relaxed));
}

}  // namespace daw::plugin_host
