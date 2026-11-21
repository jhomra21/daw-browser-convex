#include "audio-host-internal.h"

namespace daw::audio_host_macos {

namespace {

bool OpenOutputDevice(const HostConfig& config, AudioHost* host, void** session) {
#if defined(DAW_AUDIO_HOST_TEST_PATCH_CLAIM) && DAW_AUDIO_HOST_TEST_PATCH_CLAIM == 1
  if (const auto start = test_device_start.load(std::memory_order_acquire)) return start(host, session);
#endif
  return StartCoreAudioDevice(config.device_uid, config.sample_rate_hz, config.channel_count, host, session);
}

template <std::size_t Size>
Diagnostics::DurationQuantiles DurationQuantiles(
  const std::array<std::uint64_t, Size>& buckets,
  const std::uint64_t count,
  const std::uint64_t maximum
) {
  Diagnostics::DurationQuantiles result{.maximum_nanoseconds = maximum};
  if (count == 0) return result;
  const auto value = [&](const std::uint64_t numerator, const std::uint64_t denominator) {
    const auto target = std::max<std::uint64_t>(1, (count * numerator + denominator - 1) / denominator);
    std::uint64_t cumulative = 0;
    for (std::size_t index = 0; index < buckets.size(); ++index) {
      cumulative += buckets[index];
      if (cumulative >= target) return std::uint64_t{1} << index;
    }
    return maximum;
  };
  result.p50_nanoseconds = value(50, 100);
  result.p95_nanoseconds = value(95, 100);
  result.p99_nanoseconds = value(99, 100);
  return result;
}

bool ValidConfig(const HostConfig& config) {
  return !config.device_uid.empty()
    && config.sample_rate_hz > 0
    && config.max_frames_per_block > 0
    && config.channel_count > 0
    && config.revision > 0;
}

}  // namespace

AudioHost::AudioHost(RecordingSpoolService* spool, RecordingInputDevice* recording_device,
  std::shared_ptr<RecordingStatusChannel> recording_status, const char* evidence_directory) : impl_(new Impl) {
  if (daw::acceptance::On(evidence_directory)) impl_->observer = std::make_unique<AcceptanceObserver>(evidence_directory);
  if (pipe(impl_->control_wake.data()) == 0) {
    bool ready = true;
    for (const auto descriptor : impl_->control_wake) {
      ready = fcntl(descriptor, F_SETFL, O_NONBLOCK) == 0 && ready;
      ready = fcntl(descriptor, F_SETFD, FD_CLOEXEC) == 0 && ready;
    }
    if (!ready) {
      for (const auto descriptor : impl_->control_wake) close(descriptor);
      impl_->control_wake.fill(-1);
    }
  }
  impl_->recording_spool = spool;
  impl_->recording_status_channel = std::move(recording_status);
  impl_->recording_device = recording_device ? recording_device : &impl_->default_recording_device;
  impl_->worker_notifications.active_revision = &impl_->active_revision;
  impl_->meter_observer.bridge_pending = &impl_->realtime_bridge_pending;
  impl_->spectrum_observer.selected_node = &impl_->spectrum_selected_node;
  impl_->spectrum_observer.bridge_pending = &impl_->realtime_bridge_pending;
  impl_->telemetry_observer.meter = &impl_->meter_observer;
  impl_->telemetry_observer.spectrum = &impl_->spectrum_observer;
  impl_->StartRealtimeBridge();
  if (spool) {
    impl_->recording_advance_running.store(true, std::memory_order_release);
    impl_->recording_advance_thread = std::thread([this, signal = spool->StatusSignal()] {
      auto revision = signal->Revision();
      while (impl_->recording_advance_running.load(std::memory_order_acquire)) {
        AdvanceRecording();
        if (impl_->recording_status_channel) {
          const auto status = RecordingSnapshot();
          if (status.generation != 0) impl_->recording_status_channel->Publish(status);
        }
        revision = signal->Wait(revision);
      }
    });
  }
}

AudioHost::~AudioHost() {
  Stop();
  impl_->StopRealtimeBridge();
  for (const auto descriptor : impl_->control_wake) if (descriptor >= 0) close(descriptor);
  impl_->recording_advance_running.store(false, std::memory_order_release);
  if (impl_->recording_spool) impl_->recording_spool->StatusSignal()->Notify();
  if (impl_->recording_advance_thread.joinable()) impl_->recording_advance_thread.join();
  impl_->recording_capture.store(0, std::memory_order_release);
  impl_->recording_session.reset();
  const daw_audio_core_handle active_core = impl_->active_core.load(std::memory_order_acquire);
  if (active_core != 0) daw_audio_core_destroy(active_core);
  delete impl_;
}

bool AudioHost::Configure(const HostConfig& config) {
  if (impl_->control_wake[0] < 0 || impl_->publication_in_flight != 0
    || !ValidConfig(config) || impl_->state.load(std::memory_order_acquire) == LifecycleState::kRunning) return false;
  daw_audio_core_handle next_core = 0;
  const daw_audio_core_config core_config{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .max_frames_per_block = config.max_frames_per_block,
    .max_channels = config.channel_count,
    .max_assets = 64,
    .sample_rate_hz = config.sample_rate_hz,
  };
  if (daw_audio_core_create(&core_config, &next_core) != DAW_AUDIO_CORE_OK) return false;
  const daw_audio_core_prepare_request prepare{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .graph_revision = config.revision,
    .reserved0 = 0,
    .reserved1 = 0,
  };
  if (daw_audio_core_prepare(next_core, &prepare) != DAW_AUDIO_CORE_OK
    || daw_audio_core_publish(next_core, config.revision) != DAW_AUDIO_CORE_OK) {
    daw_audio_core_destroy(next_core);
    return false;
  }
  const daw_audio_core_handle previous_core = impl_->active_core.exchange(next_core, std::memory_order_acq_rel);
  if (previous_core != 0) daw_audio_core_destroy(previous_core);
  impl_->prepared_core = 0;
  impl_->prepared_continuity = GraphRevisionContinuity::kNotEvaluated;
  impl_->config = config;
  if (impl_->observer && impl_->observer->tap())
    impl_->observer->tap()->Configure(config.sample_rate_hz, config.channel_count);
  impl_->Evidence("device-configure");
  impl_->schedule_progress_has_notification = false;
  impl_->schedule_progress_notified_frame = 0;
  impl_->schedule_progress_notified_revision = 0;
  impl_->schedule_progress_notified_epoch = 0;
  impl_->schedule_progress_notified_accepted_frame = 0;
  impl_->schedule_progress_notified_window_id = 0;
  impl_->schedule_progress_notified_transition = 0;
  impl_->schedule_progress_notified_urgent = 0;
  impl_->schedule_progress_notified_running = false;
  impl_->schedule_progress_notified_complete = false;
  impl_->assets.clear();
  impl_->asset_retirement_pending.store(false, std::memory_order_release);
  impl_->published_instrument_assets.clear();
  impl_->prepared_instrument_assets.clear();
  impl_->published_routing.reset();
  impl_->prepared_routing.reset();
  impl_->prepared_asset_handles.clear();
  for (auto& [instance_id, attachment] : impl_->native_vst_attachments) {
    attachment->realtime_started = false;
    attachment->missed_callbacks.fill(0);
    attachment->missed_frames.fill(0);
  }
  impl_->graph_prepared = false;
  impl_->transport_prepared = false;
  impl_->transport_frame.store(0, std::memory_order_release);
  impl_->transport_running.store(false, std::memory_order_release);
  impl_->applied_transport_epoch.store(0, std::memory_order_release);
  impl_->applied_transport_frame.store(0, std::memory_order_release);
  impl_->applied_transport_running.store(false, std::memory_order_release);
  impl_->applied_transport_transition_id.store(0, std::memory_order_release);
  impl_->last_queued_transport_epoch.store(0, std::memory_order_release);
  impl_->last_queued_transport_transition_id.store(0, std::memory_order_release);
  impl_->schedule_banks[0].Reset(0, 0, 0);
  impl_->schedule_banks[1].Reset(0, 0, 0);
  impl_->active_schedule_bank.store(0, std::memory_order_release);
  impl_->PublishAutomationCredits();
  impl_->requested_publication_frame.store(0, std::memory_order_release);
  impl_->schedule_owner.store(0, std::memory_order_release);
  impl_->transport_queue.read.store(0, std::memory_order_release);
  impl_->transport_queue.write.store(0, std::memory_order_release);
  impl_->ActiveSchedule().accepted_schedule_epoch.store(0, std::memory_order_release);
  impl_->ActiveSchedule().accepted_schedule_through_frame.store(0, std::memory_order_release);
  impl_->ActiveSchedule().published_schedule_window_id.store(0, std::memory_order_release);
  impl_->ActiveSchedule().schedule_complete.store(false, std::memory_order_release);
  impl_->ActiveSchedule().last_accepted_schedule_window_id = 0;
  impl_->ActiveSchedule().last_accepted_schedule_epoch = 0;
  impl_->ActiveSchedule().last_schedule_start_frame = 0;
  impl_->ActiveSchedule().schedule_digest_windows = {};
  impl_->ActiveSchedule().schedule_chunk_digests = {};
  impl_->ActiveSchedule().schedule_digest_cursor = 0;
  impl_->state.store(LifecycleState::kConfigured, std::memory_order_release);
  impl_->active_revision.store(config.revision, std::memory_order_release);
  impl_->prepared_revision.store(0, std::memory_order_release);
  impl_->retired_revision.store(0, std::memory_order_release);
  impl_->publish_requested_revision.store(0, std::memory_order_release);
  impl_->publish_acknowledged_revision.store(0, std::memory_order_release);
  impl_->callback_attempts.store(0, std::memory_order_release);
  impl_->callbacks.store(0, std::memory_order_release);
  impl_->split_blocks.store(0, std::memory_order_release);
  impl_->rejected_blocks.store(0, std::memory_order_release);
  impl_->last_rejected_reason.store(RejectedBlockReason::kNone, std::memory_order_release);
  impl_->last_rejected_callback.store(0, std::memory_order_release);
  impl_->last_rejected_render_epoch.store(0, std::memory_order_release);
  impl_->last_rejected_transport_epoch.store(0, std::memory_order_release);
  impl_->last_rejected_core_result.store(DAW_AUDIO_CORE_OK, std::memory_order_release);
  impl_->last_rejected_frame_count.store(0, std::memory_order_release);
  impl_->last_rejected_channel_count.store(0, std::memory_order_release);
  impl_->last_rejected_processor_event_count.store(0, std::memory_order_release);
  impl_->last_rejected_instrument_event_count.store(0, std::memory_order_release);
  impl_->last_rejected_graph_revision.store(0, std::memory_order_release);
  impl_->completed_render_epoch.store(0, std::memory_order_release);
  impl_->meter_observer.Clear();
  impl_->spectrum_observer.Clear();
  impl_->spectrum_selected_node.store(0, std::memory_order_release);
  impl_->spectrum_smoothed.fill(0.0F);
  impl_->spectrum_has_previous = false;
    impl_->spectrum_history_left.fill(0.0F);
    impl_->spectrum_history_right.fill(0.0F);
    impl_->spectrum_history_count = 0;
  impl_->meter_sequence = 0;
  impl_->spectrum_sequence = 0;
  impl_->last_graph_revision.store(0, std::memory_order_release);
  impl_->urgent_queue.read.store(0, std::memory_order_release);
  impl_->urgent_queue.write.store(0, std::memory_order_release);
  impl_->instrument_queue.read.store(0, std::memory_order_release);
  impl_->instrument_queue.write.store(0, std::memory_order_release);
  impl_->ActiveSchedule().source_queue.read.store(0, std::memory_order_release);
  impl_->ActiveSchedule().source_queue.write.store(0, std::memory_order_release);
  impl_->ActiveSchedule().scheduled_processor_queue.read.store(0, std::memory_order_release);
  impl_->ActiveSchedule().scheduled_processor_queue.write.store(0, std::memory_order_release);
  impl_->processor_queue.read.store(0, std::memory_order_release);
  impl_->processor_queue.write.store(0, std::memory_order_release);
  impl_->processor_ramp_count = 0;
  return true;
}

int AudioHost::controlWakeDescriptor() const { return impl_->control_wake[0]; }

void AudioHost::DrainControlWake() {
  std::array<std::uint8_t, 256> pending{};
  while (read(impl_->control_wake[0], pending.data(), pending.size()) > 0) {}
}

bool AudioHost::Start() {
  impl_->Evidence("device-start-request");
  if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kConfigured || impl_->config.device_uid.empty()
    || !impl_->graph_prepared || !impl_->transport_prepared) return false;
  if (!impl_->StartNativeVstWorkers(daw::plugin_host::WorkerProcessSetup::Mode::kRealtime)) return false;
  impl_->strict_offline_export = false;
  // CoreAudio may invoke the IO callback synchronously while the device is
  // being started. Publish the running state before opening the device so
  // that the first callback is processed rather than counted as rejected.
  impl_->state.store(LifecycleState::kRunning, std::memory_order_release);
  if (!OpenOutputDevice(impl_->config, this, &impl_->device_session)) {
    impl_->state.store(LifecycleState::kConfigured, std::memory_order_release);
    impl_->StopNativeVstWorkers();
    return false;
  }
  if (impl_->observer) {
    char fields[256];
    std::snprintf(fields, sizeof(fields), ",\"deviceSession\":\"%d-%p\",\"sampleRate\":%u,\"blockSize\":%u",
      getpid(), impl_->device_session, impl_->config.sample_rate_hz, impl_->config.max_frames_per_block);
    impl_->observer->Event("device-session", fields);
  }
  return true;
}

bool AudioHost::StartOffline() {
  if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kConfigured
    || !impl_->graph_prepared || !impl_->transport_prepared) return false;
  if (!impl_->StartNativeVstWorkers(daw::plugin_host::WorkerProcessSetup::Mode::kOffline)) return false;
  impl_->strict_offline_export = impl_->config.device_uid == "offline:render";
  impl_->state.store(LifecycleState::kRunning, std::memory_order_release);
  return true;
}

bool AudioHost::StartDiagnosticMode() {
  if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kConfigured) return false;
  if (!impl_->StartNativeVstWorkers(daw::plugin_host::WorkerProcessSetup::Mode::kRealtime)) return false;
  impl_->strict_offline_export = false;
  impl_->state.store(LifecycleState::kRunning, std::memory_order_release);
  return true;
}

void AudioHost::Stop(const std::string& reason) {
  using Clock = std::chrono::steady_clock;
  const auto stop_started = Clock::now();
  const auto log_stage = [&](const char* stage, const char* phase, const Clock::time_point started) {
    const auto now = Clock::now();
    const auto elapsed = std::chrono::duration_cast<std::chrono::microseconds>(now - started).count();
    const auto total = std::chrono::duration_cast<std::chrono::microseconds>(now - stop_started).count();
    std::fprintf(stderr, "[native-audio-host-stop] phase=%s stage=%s elapsed_us=%lld total_us=%lld reason=%s\n",
      phase, stage, static_cast<long long>(elapsed), static_cast<long long>(total), reason.c_str());
  };
  impl_->Evidence("device-stop");
  const LifecycleState state = impl_->state.load(std::memory_order_acquire);
  std::fprintf(stderr,
    "[native-audio-host-stop] phase=entry reason=%s lifecycle=%u device=%p recording_device=%p recording_active=%u vst_attachments=%zu\n",
    reason.c_str(), static_cast<unsigned int>(state), impl_->device_session, impl_->recording_device_session,
    impl_->recording_started.load(std::memory_order_acquire) ? 1U : 0U, impl_->native_vst_attachments.size());
  if (state != LifecycleState::kRunning && state != LifecycleState::kFaulted) {
    if (impl_->prepared_core != 0)
      static_cast<void>(RollbackGraphRevision(impl_->prepared_revision.load(std::memory_order_acquire)));
    const auto stage_started = Clock::now();
    impl_->ClearScheduledLanes();
    log_stage("schedule-clear", "end", stage_started);
    return;
  }
  if (impl_->device_session != nullptr) {
    const auto stage_started = Clock::now();
    std::fprintf(stderr, "[native-audio-host-stop] phase=begin stage=coreaudio-output-stop reason=%s\n", reason.c_str());
    StopCoreAudioDevice(impl_->device_session);
    impl_->device_session = nullptr;
    log_stage("coreaudio-output-stop", "end", stage_started);
  }
  // The device reader is quiescent. Settle an already-published graph before
  // cancelling unpublished state, so its asset ownership cannot be forgotten.
  if (impl_->publication_in_flight != 0) {
    if (impl_->publish_requested_revision.exchange(0, std::memory_order_acq_rel) != 0)
      impl_->publication_in_flight = 0;
    else static_cast<void>(InspectGraphRevision(impl_->publication_in_flight));
  }
  {
    const auto stage_started = Clock::now();
    std::fprintf(stderr, "[native-audio-host-stop] phase=begin stage=recording-cleanup reason=%s\n", reason.c_str());
    std::lock_guard lock(impl_->recording_owner_mutex);
    impl_->recording_capture_retired = true;
    if (impl_->recording_device_session) impl_->recording_device->Stop(std::exchange(impl_->recording_device_session, nullptr));
    impl_->recording_started.store(false, std::memory_order_release);
    const auto capture = impl_->recording_capture.exchange(0, std::memory_order_acq_rel);
    if (impl_->recording_session && !impl_->recording_finish_accepted) {
      if (capture) static_cast<void>(daw_audio_recording_capture_cancel(capture));
      impl_->recording_session->Abandon();
    }
    impl_->recording_monitoring.store(false, std::memory_order_release);
    impl_->recording_command.store(Impl::RecordingCommand::kNone, std::memory_order_release);
    log_stage("recording-cleanup", "end", stage_started);
  }
  const auto worker_started = Clock::now();
  std::fprintf(stderr, "[native-audio-host-stop] phase=begin stage=worker-shutdown reason=%s\n", reason.c_str());
  impl_->StopNativeVstWorkers();
  log_stage("worker-shutdown", "end", worker_started);
  const auto schedule_started = Clock::now();
  std::fprintf(stderr, "[native-audio-host-stop] phase=begin stage=schedule-clear reason=%s\n", reason.c_str());
  impl_->ClearScheduledLanes();
  log_stage("schedule-clear", "end", schedule_started);
  impl_->state.store(LifecycleState::kConfigured, std::memory_order_release);
  impl_->publish_requested_revision.store(0, std::memory_order_release);
  daw::audio_core::StopLatencyTransition(impl_->active_core.load(std::memory_order_acquire));
  impl_->publish_wait.notify_all();
  impl_->publication_in_flight = 0;
  impl_->publish_deferred_revision.store(0, std::memory_order_release);
  impl_->schedule_owner.store(0, std::memory_order_release);
  if (impl_->prepared_core != 0) {
    static_cast<void>(RollbackGraphRevision(impl_->prepared_revision.load(std::memory_order_acquire)));
  }
  impl_->SignalRealtimeBridge(Impl::kRealtimeLatencyCompleted);
  log_stage("stop-total", "end", stop_started);
}

void AudioHost::Teardown() {
  Stop();
  if (impl_->observer && impl_->observer->tap()) {
    impl_->StopRealtimeBridge();
    impl_->observer->FinishCapture();
    impl_->StartRealtimeBridge();
  }
  const daw_audio_core_handle active_core = impl_->active_core.exchange(0, std::memory_order_acq_rel);
  if (active_core != 0) daw_audio_core_destroy(active_core);
  impl_->prepared_core = 0;
  impl_->assets.clear();
  impl_->published_instrument_assets.clear();
  impl_->prepared_instrument_assets.clear();
  impl_->published_routing.reset();
  impl_->prepared_routing.reset();
  impl_->prepared_asset_handles.clear();
  impl_->native_vst_attachments.clear();
  impl_->PublishAutomationCredits();
  impl_->active_revision.store(0, std::memory_order_release);
  impl_->prepared_revision.store(0, std::memory_order_release);
  impl_->retired_revision.store(0, std::memory_order_release);
  impl_->transport_epoch.store(0, std::memory_order_release);
  impl_->transport_frame.store(0, std::memory_order_release);
  impl_->transport_running.store(false, std::memory_order_release);
  impl_->ActiveSchedule().accepted_schedule_epoch.store(0, std::memory_order_release);
  impl_->ActiveSchedule().accepted_schedule_through_frame.store(0, std::memory_order_release);
  impl_->ActiveSchedule().published_schedule_window_id.store(0, std::memory_order_release);
  impl_->ActiveSchedule().schedule_complete.store(false, std::memory_order_release);
  impl_->ActiveSchedule().last_accepted_schedule_window_id = 0;
  impl_->ActiveSchedule().last_accepted_schedule_epoch = 0;
  impl_->ActiveSchedule().last_schedule_start_frame = 0;
  impl_->ActiveSchedule().schedule_digest_windows = {};
  impl_->ActiveSchedule().schedule_chunk_digests = {};
  impl_->ActiveSchedule().schedule_digest_cursor = 0;
  impl_->ActiveSchedule().schedule_staging.clear();
  impl_->processor_ramp_count = 0;
  impl_->applied_urgent_sequence.store(0, std::memory_order_release);
  impl_->applied_processor_sequence.store(0, std::memory_order_release);
  impl_->last_queued_processor_sequence.store(0, std::memory_order_release);
  impl_->schedule_progress_processor.store(0, std::memory_order_release);
  impl_->schedule_progress_notified_processor = 0;
  impl_->graph_prepared = false;
  impl_->transport_prepared = false;
  impl_->state.store(LifecycleState::kIdle, std::memory_order_release);
}

bool AudioHost::Retire(std::uint32_t revision) {
  if (impl_->state.load(std::memory_order_acquire) == LifecycleState::kRunning
    || impl_->prepared_core != 0 || impl_->HasRetiredPlan()
    || revision != impl_->active_revision.load(std::memory_order_acquire)) return false;
  const daw_audio_core_handle active_core = impl_->active_core.exchange(0, std::memory_order_acq_rel);
  if (active_core == 0) return false;
  daw_audio_core_destroy(active_core);
  impl_->active_revision.store(0, std::memory_order_release);
  impl_->state.store(LifecycleState::kIdle, std::memory_order_release);
  return true;
}

LifecycleState AudioHost::lifecycleState() const {
  return impl_->state.load(std::memory_order_acquire);
}

Diagnostics AudioHost::diagnostics() const {
  std::optional<Diagnostics::WorkerAutomation> automation;
  std::array<std::uint64_t, detail::kRealtimeDurationHistogramBuckets> callback_buckets{};
  std::array<std::uint64_t, daw::plugin_host::kWorkerProcessingHistogramBuckets> worker_buckets{};
  for (std::size_t index = 0; index < callback_buckets.size(); ++index) {
    callback_buckets[index] = impl_->callback_timing_buckets[index].load(std::memory_order_relaxed);
  }
  std::uint64_t worker_observations = 0;
  std::uint64_t worker_maximum = 0;
  std::uint64_t worker_deadline_misses = 0;
  std::uint64_t worker_watchdog_misses = 0;
  std::uint32_t active_workers = 0;
  const auto epoch = impl_->transport_epoch.load(std::memory_order_acquire);
  for (const auto& [instance_id, attachment] : impl_->native_vst_attachments) {
    static_cast<void>(instance_id);
    const auto& candidate = attachment->worker_automation;
    if (candidate && candidate->instance_id == instance_id)
      automation = SelectWorkerAutomation(std::move(automation), *candidate, epoch);
    if (attachment->worker.health() == daw::plugin_host::WorkerHealth::kReady) {
      ++active_workers;
    }
    const auto worker_metrics = attachment->worker.processingMetrics();
    worker_observations += worker_metrics.count;
    worker_maximum = std::max(worker_maximum, worker_metrics.maximum_nanoseconds);
    worker_deadline_misses += worker_metrics.deadline_misses;
    worker_watchdog_misses += attachment->watchdog_misses.load(std::memory_order_relaxed);
    for (std::size_t index = 0; index < worker_buckets.size(); ++index) {
      worker_buckets[index] += worker_metrics.buckets[index];
    }
  }
  const auto callback_count = impl_->callback_timing_count.load(std::memory_order_relaxed);
  return {
    .worker_automation = automation,
    .realtime_performance = {
      .sample_rate_hz = impl_->config.sample_rate_hz,
      .frames_per_callback = impl_->callback_frames.load(std::memory_order_relaxed),
      .observation_count = callback_count,
      .processing = DurationQuantiles(
        callback_buckets,
        callback_count,
        impl_->callback_timing_maximum_nanoseconds.load(std::memory_order_relaxed)
      ),
      .deadline_misses = impl_->callback_deadline_misses.load(std::memory_order_relaxed),
    },
    .vst_worker_performance = {
      .active_workers = active_workers,
      .observation_count = worker_observations,
      .processing = DurationQuantiles(worker_buckets, worker_observations, worker_maximum),
      .deadline_misses = worker_deadline_misses,
      .watchdog_misses = worker_watchdog_misses,
      .faults = impl_->vst_worker_faults.load(std::memory_order_relaxed),
      .restarts = impl_->vst_worker_restarts.load(std::memory_order_relaxed),
    },
    .state = impl_->state.load(std::memory_order_acquire),
    .callbacks = impl_->callbacks.load(std::memory_order_relaxed),
    .split_blocks = impl_->split_blocks.load(std::memory_order_relaxed),
    .rejected_blocks = impl_->rejected_blocks.load(std::memory_order_relaxed),
    .active_revision = impl_->active_revision.load(std::memory_order_acquire),
    .prepared_revision = impl_->prepared_revision.load(std::memory_order_acquire),
    .retired_revision = impl_->retired_revision.load(std::memory_order_acquire),
    .transport_epoch = impl_->transport_epoch.load(std::memory_order_acquire),
    .render_epoch = impl_->completed_render_epoch.load(std::memory_order_acquire),
    .installed_assets = static_cast<std::uint32_t>(impl_->assets.size()),
    .transport_frame = impl_->transport_frame.load(std::memory_order_acquire),
    .last_rejected_reason = impl_->last_rejected_reason.load(std::memory_order_relaxed),
    .last_rejected_callback = impl_->last_rejected_callback.load(std::memory_order_relaxed),
    .last_rejected_render_epoch = impl_->last_rejected_render_epoch.load(std::memory_order_relaxed),
    .last_rejected_transport_epoch = impl_->last_rejected_transport_epoch.load(std::memory_order_relaxed),
    .last_rejected_core_result = impl_->last_rejected_core_result.load(std::memory_order_relaxed),
    .last_rejected_frame_count = impl_->last_rejected_frame_count.load(std::memory_order_relaxed),
    .last_rejected_channel_count = impl_->last_rejected_channel_count.load(std::memory_order_relaxed),
    .last_rejected_processor_event_count = impl_->last_rejected_processor_event_count.load(std::memory_order_relaxed),
    .last_rejected_instrument_event_count = impl_->last_rejected_instrument_event_count.load(std::memory_order_relaxed),
    .last_rejected_graph_revision = impl_->last_rejected_graph_revision.load(std::memory_order_relaxed),
  };
}

DeviceReadinessReason AudioHost::readinessReason() const {
  if (impl_->state.load(std::memory_order_acquire) == LifecycleState::kIdle
    || impl_->config.device_uid.empty()) return DeviceReadinessReason::kDeviceNotConfigured;
  if (!impl_->graph_prepared) return DeviceReadinessReason::kGraphNotPrepared;
  if (!impl_->transport_prepared) return DeviceReadinessReason::kTransportNotPrepared;
  return DeviceReadinessReason::kReady;
}

}  // namespace daw::audio_host_macos
