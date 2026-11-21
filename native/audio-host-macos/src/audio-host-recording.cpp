#include "audio-host-internal.h"

namespace daw::audio_host_macos {

bool RecordingInputDevice::Start(std::string_view uid, std::uint32_t rate, std::uint32_t channels,
  AudioHost* host, void** session) { return StartCoreAudioInputDevice(uid, rate, channels, host, session); }
void RecordingInputDevice::Stop(void* session) { StopCoreAudioDevice(session); }
std::uint32_t RecordingInputDevice::Rate(std::string_view uid) {
  const auto device = SelectInputDevice(uid);
  return device ? device->nominal_sample_rate_hz : 0;
}

void RecordingStatusChannel::Publish(RecordingStatus status) {
  {
    std::lock_guard lock(mutex_);
    latest_ = std::move(status);
    ++revision_;
  }
  changed_.notify_all();
}
std::optional<RecordingStatus> RecordingStatusChannel::Wait(std::uint64_t& revision, const std::atomic<bool>& running) {
  std::unique_lock lock(mutex_);
  changed_.wait(lock, [&] { return revision_ != revision || !running.load(std::memory_order_acquire); });
  revision = revision_;
  return running.load(std::memory_order_acquire) ? latest_ : std::nullopt;
}
void RecordingStatusChannel::Wake() {
  // Pair the external shutdown flag with Wait's predicate mutex, so a wake
  // cannot fall between its predicate check and condition-variable sleep.
  std::lock_guard lock(mutex_);
  changed_.notify_all();
}

bool AudioHost::ConfigureRecording(const RecordingConfig& config, SpoolRequest request) {
  std::lock_guard lock(impl_->recording_owner_mutex);
  if (!impl_->recording_spool || impl_->state.load(std::memory_order_acquire) != LifecycleState::kRunning
    || config.generation == 0 || config.session_id == 0 || config.channel_count == 0 || config.channel_count > 2
    || !std::isfinite(config.gain) || config.gain < 0 || (config.polarity != 1 && config.polarity != -1)
    || config.device_uid.empty() || config.punch_start_frame < 0
    || (config.punch_end_frame != -1 && config.punch_end_frame < config.punch_start_frame)) return false;
  // A take binds only a node the plan in force has, and one a prepared revision does not drop or reroute.
  if (config.target_node_id != 0
    && (!impl_->published_routing || !PlanContainsNode(*impl_->published_routing, config.target_node_id)
      || (impl_->prepared_routing
        && !CaptureTargetKept(*impl_->published_routing, *impl_->prepared_routing, config.target_node_id)))) return false;
  if (impl_->recording_session) {
    const auto state = impl_->recording_session->Snapshot().state;
    if (state == SpoolState::kPreparing || state == SpoolState::kReady) return false;
  }
  for (std::uint32_t channel = 0; channel < config.channel_count; ++channel) if (config.input_channels[channel] >= 64) return false;
  request.capture = {.abi_version = DAW_AUDIO_CORE_ABI_VERSION, .generation = config.generation,
    .session_id = config.session_id, .channel_count = config.channel_count,
    .input_channels = {config.input_channels[0], config.input_channels[1]}, .gain = config.gain,
    .polarity = config.polarity, .punch_start_frame = config.punch_start_frame, .punch_end_frame = config.punch_end_frame};
  auto session = impl_->recording_spool->Start(std::move(request));
  if (!session) return false;
  if (impl_->recording_device_session)
    impl_->recording_device->Stop(std::exchange(impl_->recording_device_session, nullptr));
  impl_->recording_capture.store(0, std::memory_order_release);
  impl_->recording_session = std::move(session);
  impl_->recording_config = config;
  impl_->recording_finish_accepted = false;
  impl_->recording_capture_retired = false;
  impl_->recording_input_failed = false;
  impl_->recording_rate = 0;
  impl_->recording_device_lost.store(false, std::memory_order_release);
  impl_->recording_started.store(false, std::memory_order_release);
  impl_->recording_monitoring.store(config.monitoring, std::memory_order_release);
  impl_->recording_channel_count.store(config.channel_count, std::memory_order_release);
  impl_->recording_monitor_read.store(0, std::memory_order_release);
  impl_->recording_monitor_write.store(0, std::memory_order_release);
  impl_->recording_command.store(Impl::RecordingCommand::kNone, std::memory_order_release);
  impl_->recording_punch_start_frame.store(config.punch_start_frame, std::memory_order_release);
  impl_->recording_input_frame.store(impl_->transport_frame.load(std::memory_order_acquire), std::memory_order_release);
  impl_->NotifyRecordingStatus();
  return true;
}

void AudioHost::AdvanceRecording() {
  std::lock_guard lock(impl_->recording_owner_mutex);
  const auto session = impl_->recording_session;
  if (!session) return;
  const auto snapshot = session->Snapshot();
  if (snapshot.state == SpoolState::kReady && !impl_->recording_finish_accepted
    && !impl_->recording_capture_retired
    && !impl_->recording_input_failed && impl_->recording_capture.load(std::memory_order_acquire) == 0) {
    std::uint32_t channels = 0;
    for (std::uint32_t index = 0; index < impl_->recording_config.channel_count; ++index)
      channels = std::max(channels, impl_->recording_config.input_channels[index] + 1);
    if (!impl_->recording_device->Start(impl_->recording_config.device_uid, impl_->config.sample_rate_hz,
      channels, this, &impl_->recording_device_session)) impl_->recording_input_failed = true;
    else {
      impl_->recording_rate = impl_->recording_device->Rate(impl_->recording_config.device_uid);
      if (impl_->recording_rate != impl_->config.sample_rate_hz) impl_->recording_input_failed = true;
    }
    if (impl_->recording_input_failed) {
      if (impl_->recording_device_session) impl_->recording_device->Stop(std::exchange(impl_->recording_device_session, nullptr));
      session->Abandon();
    } else impl_->recording_capture.store(session->CaptureHandle(), std::memory_order_release);
  }
  if (impl_->recording_device_lost.load(std::memory_order_acquire)) {
    if (impl_->recording_device_session) impl_->recording_device->Stop(std::exchange(impl_->recording_device_session, nullptr));
    impl_->recording_started.store(false, std::memory_order_release);
    impl_->recording_input_failed = true;
    session->Abandon();
  }
  if (snapshot.state == SpoolState::kFailed || snapshot.state == SpoolState::kCancelled
    || snapshot.state == SpoolState::kComplete) {
    if (impl_->recording_device_session)
      impl_->recording_device->Stop(std::exchange(impl_->recording_device_session, nullptr));
    impl_->recording_started.store(false, std::memory_order_release);
    impl_->recording_capture.store(0, std::memory_order_release);
    impl_->recording_capture_retired = true;
  }
  // Scalar observer wake only; do not signal StatusSignal again (self-wake loop).
  {
    std::lock_guard wait_lock(impl_->recording_wait_mutex);
    impl_->recording_status_revision.fetch_add(1, std::memory_order_release);
  }
  impl_->recording_wait.notify_all();
}

bool AudioHost::StartRecording() {
  std::lock_guard lock(impl_->recording_owner_mutex);
  if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kRunning
    || !impl_->recording_session || impl_->recording_session->Snapshot().state != SpoolState::kReady
    || impl_->recording_input_failed || impl_->recording_capture.load(std::memory_order_acquire) == 0
    || impl_->recording_started.load(std::memory_order_acquire) || impl_->recording_finish_accepted) return false;
  const auto start = impl_->transport_frame.load(std::memory_order_acquire);
  impl_->recording_input_frame.store(start, std::memory_order_release);
  impl_->recording_timeline_start_frame.store(std::max(start, impl_->recording_punch_start_frame.load()), std::memory_order_release);
  impl_->recording_started.store(true, std::memory_order_release);
  impl_->NotifyRecordingStatus();
  return true;
}

bool AudioHost::StopRecording(const std::optional<std::int64_t> stop_frame) {
  std::lock_guard lock(impl_->recording_owner_mutex);
  if (!impl_->recording_session || !impl_->recording_started.load(std::memory_order_acquire)
    || impl_->recording_finish_accepted || (stop_frame && *stop_frame < 0)) return false;
  // StopCoreAudioDevice synchronously quiesces the sole producer. Finalize only
  // afterwards; callback logic remains unchanged and never sees these IO locks.
  if (impl_->recording_device_session) impl_->recording_device->Stop(std::exchange(impl_->recording_device_session, nullptr));
  const auto capture = impl_->recording_capture.load(std::memory_order_acquire);
  impl_->recording_started.store(false, std::memory_order_release);
  if (daw_audio_recording_capture_finalize(capture, stop_frame.value_or(impl_->recording_input_frame.load())) != DAW_AUDIO_CORE_OK) return false;
  daw_audio_recording_capture_diagnostics diagnostics{};
  if (daw_audio_recording_capture_get_diagnostics(capture, &diagnostics) != DAW_AUDIO_CORE_OK) return false;
  impl_->recording_finish_accepted = impl_->recording_session->Finish(diagnostics.captured_frames);
  impl_->NotifyRecordingStatus();
  return impl_->recording_finish_accepted;
}

bool AudioHost::CancelRecording() {
  std::lock_guard lock(impl_->recording_owner_mutex);
  if (!impl_->recording_session) return true;
  if (impl_->recording_finish_accepted) return false;
  impl_->recording_capture_retired = true;
  if (impl_->recording_device_session) impl_->recording_device->Stop(std::exchange(impl_->recording_device_session, nullptr));
  impl_->recording_started.store(false, std::memory_order_release);
  const auto capture = impl_->recording_capture.load(std::memory_order_acquire);
  if (capture) static_cast<void>(daw_audio_recording_capture_cancel(capture));
  const bool accepted = impl_->recording_session->Abandon();
  impl_->NotifyRecordingStatus();
  return accepted;
}

void AudioHost::NotifyRecordingDeviceLost() {
  impl_->recording_device_lost.store(true, std::memory_order_release);
  impl_->NotifyRecordingStatus();
}

void AudioHost::NotifyOutputDeviceLost() {
  auto expected = LifecycleState::kRunning;
  if (impl_->state.compare_exchange_strong(expected, LifecycleState::kFaulted,
      std::memory_order_acq_rel)) {
    // Wake the existing event bridge even though no further callback will run.
    // Ownership is unchanged until Stop synchronously quiesces the device.
    impl_->NotifyScheduleProgress();
  }
}

RecordingStatus AudioHost::RecordingSnapshot() const {
  std::lock_guard lock(impl_->recording_owner_mutex);
  RecordingStatus status{};
  const auto session = impl_->recording_session;
  if (!session) return status;
  status.generation = impl_->recording_config.generation;
  status.session_id = impl_->recording_config.session_id;
  status.channel_count = impl_->recording_config.channel_count;
  status.sample_rate_hz = impl_->recording_rate;
  status.timeline_frame = impl_->recording_timeline_start_frame.load();
  status.spool = session->Snapshot();
  if (status.spool.state == SpoolState::kReady && status.sample_rate_hz == 0 && !impl_->recording_input_failed)
    status.spool.state = SpoolState::kPreparing;
  status.configured = status.spool.state == SpoolState::kReady && status.sample_rate_hz != 0 && !impl_->recording_input_failed;
  status.active = impl_->recording_started.load(std::memory_order_acquire);
  status.fatal = impl_->recording_input_failed || impl_->recording_device_lost.load() || status.spool.state == SpoolState::kFailed;
  if (impl_->recording_input_failed) { status.spool.state = SpoolState::kFailed; status.spool.error = SpoolError::kCapture; }
  const auto capture = session->CaptureHandle();
  daw_audio_recording_capture_diagnostics diagnostics{};
  if (capture && daw_audio_recording_capture_get_diagnostics(capture, &diagnostics) == DAW_AUDIO_CORE_OK) {
    status.captured_frames = diagnostics.captured_frames;
    status.dropped_frames = diagnostics.dropped_frames;
    status.dropped_blocks = diagnostics.dropped_blocks;
    status.available_blocks = diagnostics.available_blocks;
    status.queued_blocks = diagnostics.queued_blocks;
    status.rms = diagnostics.rms;
    status.peak = diagnostics.peak;
    status.fatal |= diagnostics.fatal != 0;
  }
  if (const auto result = session->Result()) { status.file_device = result->file_device; status.file_inode = result->file_inode; }
  return status;
}

std::optional<RecordingMessage> AudioHost::WaitForRecordingMessage(
  const std::uint64_t revision, const std::atomic<bool>* running) {
  {
    std::unique_lock lock(impl_->recording_wait_mutex);
    impl_->recording_wait.wait(lock, [&] { return impl_->recording_status_revision.load(std::memory_order_acquire) != revision
      || (running && !running->load(std::memory_order_acquire)); });
  }
  if (running && !running->load(std::memory_order_acquire)) return std::nullopt;
  return RecordingMessage{.block = std::nullopt, .status = RecordingSnapshot()};
}

void AudioHost::WakeRecordingWait() {
  impl_->recording_wait.notify_all();
}

std::uint64_t AudioHost::recordingStatusRevision() const {
  return impl_->recording_status_revision.load(std::memory_order_acquire);
}

}  // namespace daw::audio_host_macos
