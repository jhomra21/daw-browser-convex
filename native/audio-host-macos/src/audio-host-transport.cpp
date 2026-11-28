#include "audio-host-internal.h"

namespace daw::audio_host_macos {

bool AudioHost::SetTransport(
  const std::uint32_t epoch,
  const bool running,
  const std::int64_t frame,
  const double bpm,
  const std::uint32_t time_signature_numerator,
  const std::uint32_t time_signature_denominator,
  const bool cycle_active,
  const double cycle_start_sec,
  const double cycle_end_sec,
  const std::uint64_t transition_id
) {
  const daw_audio_core_handle active_core = impl_->active_core.load(std::memory_order_acquire);
  const auto lifecycle = impl_->state.load(std::memory_order_acquire);
  const bool configured_offline_host = lifecycle == LifecycleState::kConfigured
    && impl_->config.device_uid == "offline:render";
  if ((running && lifecycle != LifecycleState::kRunning && !configured_offline_host)
    || active_core == 0 || frame < 0 || epoch == 0
    || (bpm != 0.0 && (!std::isfinite(bpm) || bpm <= 0.0))
    || time_signature_numerator > 32 || time_signature_denominator > 32
    || (time_signature_numerator == 0) != (time_signature_denominator == 0)
    || (cycle_active && (
      !std::isfinite(cycle_start_sec) || !std::isfinite(cycle_end_sec)
      || cycle_start_sec < 0.0 || cycle_end_sec <= cycle_start_sec
    ))) return false;
  const auto sample_rate = static_cast<double>(impl_->config.sample_rate_hz);
  const auto cycle_start_frame = cycle_active
    ? static_cast<std::int64_t>(std::llround(cycle_start_sec * sample_rate)) : 0;
  const auto cycle_end_frame = cycle_active
    ? static_cast<std::int64_t>(std::llround(cycle_end_sec * sample_rate)) : 0;
  if (cycle_active && cycle_end_frame <= cycle_start_frame) return false;
  const auto previous_epoch = impl_->last_queued_transport_epoch.load(std::memory_order_acquire);
  const auto previous_transition = impl_->last_queued_transport_transition_id.load(std::memory_order_acquire);
  const auto effective_transition = transition_id == 0 ? previous_transition + 1 : transition_id;
  if (epoch < previous_epoch || effective_transition < previous_transition) return false;
  // Reusing the running transition with an explicit musical context updates
  // only the prepared bank's context. The publication callback supplies its
  // seam frame, so IPC latency cannot turn this into a running locate.
  const bool context_only = transition_id != 0 && effective_transition == previous_transition
    && epoch == previous_epoch && running && bpm > 0.0
    && impl_->transport_running.load(std::memory_order_acquire);
  if (context_only && impl_->prepared_core != 0) {
    if (impl_->publication_in_flight != 0) return false;
    impl_->prepared_transport_context = Impl::TransportCommand{
      .epoch = epoch, .running = running, .frame = frame, .bpm = bpm,
      .time_signature_numerator = time_signature_numerator,
      .time_signature_denominator = time_signature_denominator,
      .cycle_active = cycle_active, .cycle_start_frame = cycle_start_frame,
      .cycle_end_frame = cycle_end_frame, .transition_id = effective_transition,
    };
    return true;
  }
  if (effective_transition == previous_transition) {
    return epoch == previous_epoch
      && impl_->transport_running.load(std::memory_order_acquire) == running
      && impl_->transport_frame.load(std::memory_order_acquire) == frame;
  }
  const auto transport_write = impl_->transport_queue.write.load(std::memory_order_relaxed);
  const auto transport_read = impl_->transport_queue.read.load(std::memory_order_acquire);
  if (transport_write - transport_read >= Impl::kTransportQueueCapacity) return false;
  if (impl_->publication_in_flight != 0) {
    const auto cancelled = impl_->publish_requested_revision.exchange(0, std::memory_order_acq_rel);
    if (cancelled != 0) impl_->publication_in_flight = 0;
    else if (InspectGraphRevision(impl_->publication_in_flight).code == GraphRevisionStatusCode::kPublishPending) return false;
  }
  if (impl_->prepared_core != 0) {
    const auto prepared = impl_->prepared_revision.load(std::memory_order_acquire);
    if (RollbackGraphRevision(prepared).code != GraphRevisionStatusCode::kRolledBack) return false;
  }
  if (!Impl::EnqueueTransportCommand(impl_->transport_queue, {
    .epoch = epoch,
    .running = running,
    .frame = frame,
    .bpm = bpm,
    .time_signature_numerator = time_signature_numerator,
    .time_signature_denominator = time_signature_denominator,
    .cycle_active = cycle_active,
    .cycle_start_frame = cycle_start_frame,
    .cycle_end_frame = cycle_end_frame,
    .transition_id = effective_transition,
  })) return false;
  impl_->last_queued_transport_epoch.store(epoch, std::memory_order_release);
  impl_->last_queued_transport_transition_id.store(effective_transition, std::memory_order_release);
  impl_->transport_epoch.store(epoch, std::memory_order_release);
  impl_->transport_frame.store(frame, std::memory_order_release);
  impl_->transport_running.store(running, std::memory_order_release);
  impl_->transport_prepared = true;
  return true;
}

bool AudioHost::WaitForScheduleProgress(const std::atomic<bool>* running) {
  std::unique_lock lock(impl_->schedule_progress_mutex);
  impl_->schedule_progress_wait.wait(lock, [this, running] {
    return impl_->schedule_progress_ready.load(std::memory_order_acquire)
      || (running != nullptr && !running->load(std::memory_order_acquire));
  });
  return impl_->schedule_progress_ready.load(std::memory_order_acquire);
}

std::optional<ScheduleProgress> AudioHost::DrainScheduleProgress() {
  if (!impl_->schedule_progress_ready.exchange(false, std::memory_order_acq_rel)) return std::nullopt;
  // Stop/completion can wake the bridge before the first successful callback.
  // Such a wake is not a populated schedule-progress snapshot.
  if (impl_->schedule_progress_sequence.load(std::memory_order_acquire) == 0) return std::nullopt;
  // Report the recorded claim's resolution once. Reading the result only for the token
  // that was acquired, and ending the claim only after that read, is what keeps the
  // callback from overwriting a result that has not been reported (no torn pair).
  const auto claim = impl_->claimed_processor_patch.Recorded();
  if (claim != 0 && claim != impl_->last_reported_patch.token
    && impl_->processor_patch_acknowledged.load(std::memory_order_acquire) == claim) {
    impl_->last_reported_patch = {claim, impl_->processor_patch_result.load(std::memory_order_relaxed)};
    impl_->processor_patch_reported_token.store(claim, std::memory_order_release);
  }
  const auto instrument_write = impl_->instrument_queue.write.load(std::memory_order_acquire);
  const auto instrument_read = impl_->instrument_queue.read.load(std::memory_order_acquire);
  const auto source_write = impl_->ActiveSchedule().source_queue.write.load(std::memory_order_acquire);
  const auto source_read = impl_->ActiveSchedule().source_queue.read.load(std::memory_order_acquire);
  return ScheduleProgress{
    .admission_capacity_generation = impl_->admission_capacity_generation.load(std::memory_order_acquire),
    .latency_completion_generation = impl_->latency_completion_generation.load(std::memory_order_acquire),
    .revision = impl_->schedule_progress_revision.load(std::memory_order_acquire),
    .epoch = impl_->schedule_progress_epoch.load(std::memory_order_acquire),
    .progress_sequence = impl_->schedule_progress_sequence.load(std::memory_order_acquire),
    .rendered_through_frame = impl_->schedule_progress_rendered_frame.load(std::memory_order_acquire),
    .accepted_through_frame = impl_->schedule_progress_accepted_frame.load(std::memory_order_acquire),
    .last_accepted_window_id = impl_->schedule_progress_window_id.load(std::memory_order_acquire),
    .applied_transport_transition_id = impl_->schedule_progress_applied_transition.load(std::memory_order_acquire),
    .applied_urgent_sequence = impl_->schedule_progress_urgent.load(std::memory_order_acquire),
    .applied_processor_sequence = impl_->schedule_progress_processor.load(std::memory_order_acquire),
    .running = impl_->schedule_progress_running.load(std::memory_order_acquire),
    .schedule_complete = impl_->schedule_progress_complete.load(std::memory_order_acquire),
    .instrument_credits = Impl::kInstrumentQueueCapacity - std::min<std::uint32_t>(
      Impl::kInstrumentQueueCapacity,
      instrument_write - instrument_read
    ),
    .source_credits = Impl::kSourceQueueCapacity - std::min<std::uint32_t>(
      Impl::kSourceQueueCapacity,
      source_write - source_read
    ),
    .automation_credits = impl_->automation_credit_totals[impl_->active_schedule_bank.load(std::memory_order_acquire)]
      .load(std::memory_order_acquire),
    .processor_patch_resolved_token = impl_->last_reported_patch.token,
    .processor_patch_resolved_result = impl_->last_reported_patch.result,
  };
}

void AudioHost::WakeScheduleProgressWait() {
  impl_->schedule_progress_wait.notify_all();
}

std::uint64_t AudioHost::appliedUrgentSequence() const {
  return impl_->applied_urgent_sequence.load(std::memory_order_acquire);
}

}  // namespace daw::audio_host_macos
