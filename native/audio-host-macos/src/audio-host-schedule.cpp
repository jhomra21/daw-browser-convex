#include "audio-host-internal.h"

namespace daw::audio_host_macos {

namespace {

bool ValidNativeInstrumentEvent(const daw_audio_instrument_event& event) {
  const bool portable = event.type >= DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON
    && event.type <= DAW_AUDIO_INSTRUMENT_EVENT_PARAMETER;
  const bool native = event.type >= static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOn)
    && event.type <= static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kAllSoundOff);
  if (event.node_id == 0 || event.epoch == 0 || event.sequence == 0 || event.channel > 15
    || event.note > 127 || !std::isfinite(event.value) || (!portable && !native)) return false;
  if ((event.type == DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON
      || event.type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOn))
    && (event.note_id == 0 || event.value < 0.0F || event.value > 1.0F)) return false;
  if ((event.type == DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF
      || event.type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOff))
    && event.note_id == 0) return false;
  return true;
}

bool ValidNativeSampleSourceEvent(const daw_audio_sample_source_event& event) {
  return event.epoch != 0
    && event.sequence != 0
    && event.asset != 0
    && event.stop_frame > event.start_frame
    && event.source_frame_count > 0
    && std::isfinite(event.gain)
    && std::isfinite(event.source_offset_fraction)
    && event.source_offset_fraction >= 0.0F && event.source_offset_fraction < 1.0F
    && event.fade_in_start_frame <= event.fade_in_end_frame
    && event.fade_out_start_frame <= event.fade_out_end_frame
    && std::isfinite(event.fade_in_curve)
    && event.fade_in_curve >= -1.0F && event.fade_in_curve <= 1.0F
    && std::isfinite(event.fade_in_curve_position)
    && event.fade_in_curve_position >= 0.0F && event.fade_in_curve_position <= 1.0F
    && std::isfinite(event.fade_out_curve)
    && event.fade_out_curve >= -1.0F && event.fade_out_curve <= 1.0F
    && std::isfinite(event.fade_out_curve_position)
    && event.fade_out_curve_position >= 0.0F && event.fade_out_curve_position <= 1.0F;
}

}  // namespace

bool AudioHost::QueueParameterEvents(const std::span<const std::uint8_t> payload) {
  Impl::ControlSubmissionClaim claim{impl_->schedule_owner};
  if (!claim.acquired) return false;
  if (payload.size() < 4) return false;
  const std::uint32_t count = ReadLeU32(payload.data());
  const bool has_batch = payload.size() == 20 + static_cast<std::size_t>(count) * 20;
  if (count == 0 && has_batch) return false;
  if (count > DAW_AUDIO_CORE_MAX_PROCESSOR_EVENTS
    || (!has_batch && payload.size() != 4 + static_cast<std::size_t>(count) * 20)) return false;
  const auto batch_revision = has_batch ? ReadLeU32(payload.data() + 4) : 0;
  const auto batch_epoch = has_batch ? ReadLeU32(payload.data() + 8) : 0;
  const auto batch_sequence = has_batch ? ReadLeU64(payload.data() + 12) : 0;
  if (has_batch && (batch_revision == 0 || batch_epoch == 0 || batch_sequence == 0
    || batch_revision != impl_->active_revision.load(std::memory_order_acquire)
    || batch_epoch != impl_->transport_epoch.load(std::memory_order_acquire))) return false;
  // All-or-nothing: every event is validated before capacity, before the sequence is
  // consumed and before anything is enqueued, so a refused batch leaves no trace.
  const std::size_t offset = has_batch ? 20 : 4;
  std::array<Impl::QueuedControlEvent, DAW_AUDIO_CORE_MAX_PROCESSOR_EVENTS> validated{};
  for (std::uint32_t index = 0; index < count; ++index) {
    const auto* bytes = payload.data() + offset + index * 20;
    if (ReadLeU64(bytes) == 0
      || ReadLeU32(bytes + 8) == 0
      || ReadLeU32(bytes + 12) >= impl_->config.max_frames_per_block
      || !std::isfinite(ReadLeFloat(bytes + 16))) return false;
    auto& event = validated[index];
    event.kind = Impl::QueuedControlKind::kProcessor;
    event.processor_revision = batch_revision;
    event.processor_epoch = batch_epoch;
    event.processor_sequence = batch_sequence;
    event.processor = {.processor_instance_id = ReadLeU64(bytes), .parameter_target = ReadLeU32(bytes + 8),
      .frame_offset = ReadLeU32(bytes + 12), .value = ReadLeFloat(bytes + 16)};
  }
  if (!impl_->HasCapacity(Impl::QueuedControlKind::kProcessor, count)) return false;
  if (has_batch) {
    auto last_sequence = impl_->last_queued_processor_sequence.load(std::memory_order_acquire);
    while (batch_sequence > last_sequence
      && !impl_->last_queued_processor_sequence.compare_exchange_weak(
        last_sequence, batch_sequence, std::memory_order_acq_rel, std::memory_order_acquire)) {}
    if (batch_sequence <= last_sequence) return false;
  }
  for (std::uint32_t index = 0; index < count; ++index) {
    if (!impl_->EnqueueControlEvent(validated[index])) return false;
  }
  return true;
}

ProcessorPatchStatus AudioHost::QueueProcessorStatePatch(const std::span<const std::uint8_t> payload) {
  using Refusal = ProcessorPatchRefusal;
  const auto refused = [](const Refusal refusal, const std::uint32_t core_result = 0, const std::uint64_t token = 0) {
    return ProcessorPatchStatus{ProcessorPatchOutcome::kRefused, refusal, core_result, token};
  };
  const auto applied_or_failed = [&refused](const std::uint32_t result) {
    return result == DAW_AUDIO_CORE_OK
      ? ProcessorPatchStatus{ProcessorPatchOutcome::kApplied, Refusal::kNone, 0, 0}
      : refused(Refusal::kApplyFailed, result);
  };
  if (payload.size() < 56 || payload.size() > 512) return refused(Refusal::kInvalid);
  if (impl_->active_core.load(std::memory_order_acquire) == 0) return refused(Refusal::kUnavailable);
  if (impl_->prepared_core != 0) return refused(Refusal::kPreparing);
  if (impl_->claimed_processor_patch.Pending(impl_->processor_patch_reported_token)) {
    return refused(Refusal::kClaimPending, 0, impl_->claimed_processor_patch.Recorded());
  }
  if (ReadLeU32(payload.data()) != 1) return refused(Refusal::kInvalid);
  const std::uint32_t revision = ReadLeU32(payload.data() + 4);
  const std::uint64_t node_id = ReadLeU64(payload.data() + 8);
  const std::uint32_t instance_id = ReadLeU32(payload.data() + 16);
  const std::uint32_t kind = ReadLeU32(payload.data() + 20);
  const std::uint32_t state_version = ReadLeU32(payload.data() + 24);
  const std::uint32_t state_size = ReadLeU32(payload.data() + 28);
  const std::uint32_t bypassed = ReadLeU32(payload.data() + 32);
  const std::uint32_t input_layout = ReadLeU32(payload.data() + 36);
  const std::uint32_t output_layout = ReadLeU32(payload.data() + 40);
  const std::uint32_t parameter_count = ReadLeU32(payload.data() + 44);
  const std::uint32_t latency_frames = ReadLeU32(payload.data() + 48);
  const std::uint32_t tail_frames = ReadLeU32(payload.data() + 52);
  if (revision == 0 || node_id == 0 || instance_id == 0 || kind == 0
    || state_size > DAW_AUDIO_CORE_MAX_PROCESSOR_STATE_BYTES
    || parameter_count > DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS
    || bypassed > 1 || (input_layout != DAW_AUDIO_GRAPH_LAYOUT_MONO && input_layout != DAW_AUDIO_GRAPH_LAYOUT_STEREO)
    || (output_layout != DAW_AUDIO_GRAPH_LAYOUT_MONO && output_layout != DAW_AUDIO_GRAPH_LAYOUT_STEREO)
    || payload.size() != 56 + static_cast<std::size_t>(state_size) + static_cast<std::size_t>(parameter_count) * 4) {
    return refused(Refusal::kInvalid);
  }
  if (revision != impl_->active_revision.load(std::memory_order_acquire)) return refused(Refusal::kStaleRevision);
  std::array<std::uint32_t, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS> targets{};
  for (std::uint32_t index = 0; index < parameter_count; ++index) {
    targets[index] = ReadLeU32(payload.data() + 56 + state_size + index * 4);
  }
  const daw_audio_processor_state_patch patch{
    .graph_revision = revision,
    .node_id = node_id,
    .instance_id = instance_id,
    .kind = kind,
    .state_version = state_version,
    .state_size = state_size,
    .bypassed = bypassed,
    .input_layout = input_layout,
    .output_layout = output_layout,
    .parameter_count = parameter_count,
    .latency_frames = latency_frames,
    .tail_frames = tail_frames,
    .parameter_targets = targets.data(),
    .state = payload.data() + 56,
  };
  const daw_audio_core_handle core = impl_->active_core.load(std::memory_order_acquire);
  const auto staged = daw_audio_core_stage_processor_state_patch(core, &patch);
  if (staged != DAW_AUDIO_CORE_OK) return refused(Refusal::kStageFailed, staged);
  // A patch the core applied is the only line a state change that publishes no graph leaves, so it is the settle point.
  const auto applied_with_evidence = [&](const std::uint32_t result) {
    const auto status = applied_or_failed(result);
    if (status.outcome == ProcessorPatchOutcome::kApplied && impl_->observer) {
      char detail[96];
      std::snprintf(detail, sizeof(detail), ",\"nodeId\":\"%llu\",\"instanceId\":%u,\"kind\":%u",
        static_cast<unsigned long long>(node_id), instance_id, kind);
      impl_->Evidence("processor-patch-applied", "", revision, detail);
    }
    return status;
  };
  if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kRunning) {
    return applied_with_evidence(daw_audio_core_apply_staged_processor_state_patch(core));
  }
  const std::uint64_t token = ++impl_->processor_patch_sequence;
  impl_->processor_patch_requested.store(token, std::memory_order_release);
  const auto wait = WaitForCallbackRequest(impl_->publish_wait, impl_->publish_wait_mutex,
    impl_->processor_patch_requested, impl_->processor_patch_acknowledged, token, [this] {
      return impl_->state.load(std::memory_order_acquire) != LifecycleState::kRunning;
    });
  if (wait == CallbackWait::kCancelled) {
    // The callback never claimed it, so the staged copy is still ours to discard.
    static_cast<void>(daw_audio_core_cancel_staged_processor_state_patch(core));
    return refused(Refusal::kNotClaimed);
  }
  if (wait == CallbackWait::kUnresolved) {
    // The callback owns the claimed patch and is mutating the published plan. Graph
    // and patch work are refused until its resolution has been reported.
#if defined(DAW_AUDIO_HOST_TEST_PATCH_CLAIM) && DAW_AUDIO_HOST_TEST_PATCH_CLAIM == 1
    if (const auto hook = test_patch_claim_hook.load(std::memory_order_acquire)) hook();
#endif
    impl_->claimed_processor_patch.Record(token);
    // An ack that landed before the claim was recorded still needs a frame to carry it.
    impl_->PublishScheduleProgressChange();
    impl_->Evidence("processor-patch-timeout", "callback-claimed-patch-unresolved");
    return {ProcessorPatchOutcome::kClaimed, Refusal::kNone, 0, token};
  }
  return applied_with_evidence(impl_->processor_patch_result.load(std::memory_order_acquire));
}

bool AudioHost::QueueInstrumentEvents(const std::span<const std::uint8_t> payload) {
  Impl::ControlSubmissionClaim claim{impl_->schedule_owner};
  if (!claim.acquired) return false;
  if (payload.size() < 4) return false;
  const std::uint32_t count = ReadLeU32(payload.data());
  if (count > DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS || payload.size() != 4 + static_cast<std::size_t>(count) * 48) return false;
  const auto is_urgent = [&](const std::uint32_t index) {
    const auto type = ReadLeU32(payload.data() + 4 + index * 48 + 32);
    // Built-in instrument targets are not processor instances. Reuse the live
    // instrument lane and its post-process acknowledgement, ahead of notes.
    return type == DAW_AUDIO_INSTRUMENT_EVENT_PARAMETER
      || type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOn)
      || type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOff)
      || type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kTransportRelease)
      || type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kAllSoundOff);
  };
  std::uint32_t urgent_count = 0;
  for (std::uint32_t index = 0; index < count; ++index) if (is_urgent(index)) ++urgent_count;
  if (!impl_->HasCapacity(Impl::QueuedControlKind::kUrgent, urgent_count)
    || !impl_->HasCapacity(Impl::QueuedControlKind::kInstrument, count - urgent_count)) return false;
  std::array<Impl::QueuedControlEvent, DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS> validated{};
  for (std::uint32_t index = 0; index < count; ++index) {
    const auto* bytes = payload.data() + 4 + index * 48;
    Impl::QueuedControlEvent event{};
    event.kind = is_urgent(index) ? Impl::QueuedControlKind::kUrgent : Impl::QueuedControlKind::kInstrument;
    event.instrument = {.node_id = ReadLeU64(bytes), .note_id = ReadLeU64(bytes + 8), .sequence = ReadLeU64(bytes + 16),
      .epoch = ReadLeU32(bytes + 24), .frame_offset = ReadLeU32(bytes + 28), .type = ReadLeU32(bytes + 32),
      .channel = ReadLeU32(bytes + 36), .note = ReadLeU32(bytes + 40), .value = ReadLeFloat(bytes + 44)};
    if (!ValidNativeInstrumentEvent(event.instrument)
      || daw_audio_core_validate_instrument_target(
        impl_->active_core.load(std::memory_order_acquire), &event.instrument) != DAW_AUDIO_CORE_OK) {
      impl_->Evidence("instrument-admission-rejected", "invalid-graph-target-or-parameter-range");
      return false;
    }
    validated[index] = event;
  }
  for (std::uint32_t index = 0; index < count; ++index) {
    if (!impl_->EnqueueControlEvent(validated[index])) return false;
  }
  return true;
}

bool AudioHost::QueueSourceEvents(const std::span<const std::uint8_t> payload) {
  Impl::ControlSubmissionClaim claim{impl_->schedule_owner};
  if (!claim.acquired) return false;
  if (impl_->prepared_core != 0 || payload.size() < 4) return false;
  const std::uint32_t count = ReadLeU32(payload.data());
  if (count > DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS || payload.size() != 4 + static_cast<std::size_t>(count) * 112) return false;
  if (!impl_->HasCapacity(Impl::QueuedControlKind::kSource, count)) return false;
  for (std::uint32_t index = 0; index < count; ++index) {
    const auto* bytes = payload.data() + 4 + index * 112;
    const auto asset = impl_->assets.find(ReadLeU32(bytes + 20));
    if (asset == impl_->assets.end()
      || !impl_->AssetVisible(asset->second, impl_->active_revision.load(std::memory_order_acquire))) return false;
    impl_->RetainAsset(asset->second);
    const daw_audio_sample_source_event event{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
      .epoch = ReadLeU32(bytes),
      .sequence = ReadLeU64(bytes + 4),
      .source_node_id = ReadLeU64(bytes + 12),
      .asset = asset->second.handle,
      .start_frame = ReadLeI64(bytes + 24),
      .stop_frame = ReadLeI64(bytes + 32),
      .source_offset_frame = ReadLeU64(bytes + 40),
      .source_frame_count = ReadLeU64(bytes + 48),
      .gain = ReadLeFloat(bytes + 56),
      .fade_in_start_frame = ReadLeI64(bytes + 60),
      .fade_in_end_frame = ReadLeI64(bytes + 68),
      .fade_out_start_frame = ReadLeI64(bytes + 76),
      .fade_out_end_frame = ReadLeI64(bytes + 84),
      .source_offset_fraction = ReadLeFloat(bytes + 92),
      .fade_in_curve = ReadLeFloat(bytes + 96),
      .fade_in_curve_position = ReadLeFloat(bytes + 100),
      .fade_out_curve = ReadLeFloat(bytes + 104),
      .fade_out_curve_position = ReadLeFloat(bytes + 108),
    };
    if (!ValidNativeSampleSourceEvent(event)
      || event.source_offset_frame >= asset->second.frame_count
      || event.source_frame_count > asset->second.frame_count - event.source_offset_frame) return false;
  }
  for (std::uint32_t index = 0; index < count; ++index) {
    const auto* bytes = payload.data() + 4 + index * 112;
    const auto asset = impl_->assets.find(ReadLeU32(bytes + 20));
    Impl::QueuedControlEvent event{};
    event.kind = Impl::QueuedControlKind::kSource;
    event.source = {.abi_version = DAW_AUDIO_CORE_ABI_VERSION, .epoch = ReadLeU32(bytes), .sequence = ReadLeU64(bytes + 4),
      .source_node_id = ReadLeU64(bytes + 12), .asset = asset->second.handle, .start_frame = ReadLeI64(bytes + 24),
      .stop_frame = ReadLeI64(bytes + 32), .source_offset_frame = ReadLeU64(bytes + 40),
      .source_frame_count = ReadLeU64(bytes + 48), .gain = ReadLeFloat(bytes + 56),
      .fade_in_start_frame = ReadLeI64(bytes + 60), .fade_in_end_frame = ReadLeI64(bytes + 68),
      .fade_out_start_frame = ReadLeI64(bytes + 76), .fade_out_end_frame = ReadLeI64(bytes + 84),
      .source_offset_fraction = ReadLeFloat(bytes + 92),
      .fade_in_curve = ReadLeFloat(bytes + 96), .fade_in_curve_position = ReadLeFloat(bytes + 100),
      .fade_out_curve = ReadLeFloat(bytes + 104), .fade_out_curve_position = ReadLeFloat(bytes + 108)};
    if (!impl_->EnqueueControlEvent(event)) return false;
  }
  return true;
}

bool AudioHost::QueueScheduleWindow(const std::span<const std::uint8_t> payload) {
  impl_->schedule_window_error = "invalid schedule payload or graph publication still pending";
  Impl::ControlSubmissionClaim claim{impl_->schedule_owner};
  if (!claim.acquired) return false;
  const auto accepted = [&] {
    impl_->schedule_window_error = {};
    return true;
  };
  // Preparation does not own the active lanes. Only the callback's publication
  // claim excludes appends until target reconciliation has been acknowledged.
  if (payload.size() < 72) return false;
  const std::uint32_t revision = ReadLeU32(payload.data());
  const std::uint32_t epoch = ReadLeU32(payload.data() + 4);
  const std::uint64_t window_id = ReadLeU64(payload.data() + 8);
  const std::uint64_t start_frame = ReadLeU64(payload.data() + 16);
  const std::uint64_t end_frame = ReadLeU64(payload.data() + 24);
  const std::uint32_t chunk_index = ReadLeU32(payload.data() + 32);
  const std::uint32_t chunk_count = ReadLeU32(payload.data() + 36);
  const std::uint32_t ends_schedule = ReadLeU32(payload.data() + 40);
  const std::uint32_t instrument_count = ReadLeU32(payload.data() + 44);
  const std::uint32_t source_count = ReadLeU32(payload.data() + 48);
  const std::uint32_t automation_count = ReadLeU32(payload.data() + 52);
  const std::uint32_t processor_automation_count = ReadLeU32(payload.data() + 56);
  const auto prepared_binding = ReadLeU32(payload.data() + 60);
  const auto publication_frame = ReadLeU64(payload.data() + 64);
  const bool prepared = prepared_binding != 0;
  // Future publication freezes the prepared bank only, not active SPSC refills.
  if (impl_->publication_in_flight != 0
    && (prepared || impl_->requested_publication_frame == 0)) return false;
  auto& bank = prepared ? impl_->PreparedSchedule() : impl_->ActiveSchedule();
  if (prepared) {
    if (impl_->prepared_core == 0 || prepared_binding != revision
      || revision != impl_->prepared_revision.load(std::memory_order_acquire)
      || epoch != impl_->prepared_transport_epoch
      || publication_frame != impl_->requested_publication_frame
      || start_frame < publication_frame || impl_->publication_rebase_required.load()) return false;
    if (publication_frame <= static_cast<std::uint64_t>(impl_->applied_transport_frame.load(std::memory_order_acquire))) {
      impl_->publication_rebase_required.store(true, std::memory_order_release);
      impl_->schedule_window_error = "publication rebase required; inspect progress and resubmit unpublished windows";
      return false;
    }
  } else if (publication_frame != 0) return false;
  impl_->schedule_window_error = "invalid schedule header, revision, epoch or limits";
  if (revision == 0 || (!prepared && revision != impl_->active_revision.load(std::memory_order_acquire))
    || epoch == 0 || epoch != impl_->transport_epoch.load(std::memory_order_acquire)
    || window_id == 0 || start_frame >= end_frame || end_frame > std::numeric_limits<std::int64_t>::max()
    || chunk_count == 0 || chunk_count > kMaximumScheduleChunks || chunk_index >= chunk_count
    || ends_schedule > 1
    || (ends_schedule == 1 && chunk_index + 1 != chunk_count)
    || instrument_count + source_count + automation_count + processor_automation_count > kMaximumScheduleRecords
    || instrument_count > DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS
    || source_count > DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS
    || automation_count > kMaximumScheduleAutomationSegments
    || processor_automation_count > kMaximumScheduleAutomationSegments) return false;
  if (bank.last_accepted_schedule_epoch != epoch) {
    bank.last_accepted_schedule_window_id = 0;
    bank.last_accepted_schedule_epoch = epoch;
    bank.last_schedule_start_frame = 0;
    bank.schedule_digest_windows = {};
    bank.schedule_chunk_digests = {};
    bank.schedule_digest_cursor = 0;
    bank.schedule_staging.clear();
    bank.schedule_complete.store(false, std::memory_order_release);
  }
  const auto digest = [&] {
    std::uint64_t result = 1469598103934665603ULL;
    for (const auto byte : payload) {
      result ^= byte;
      result *= 1099511628211ULL;
    }
    return result;
  }();
  impl_->schedule_window_error = "schedule chunk conflicts with an accepted window";
  for (std::size_t index = 0; index < bank.schedule_digest_windows.size(); ++index) {
    if (bank.schedule_digest_windows[index] != window_id) continue;
    const auto existing = bank.schedule_chunk_digests[index][chunk_index];
    if (existing == digest) return accepted();
    return false;
  }
  auto& staging = bank.schedule_staging;
  impl_->schedule_window_error = "schedule is already complete";
  if (!staging.active && bank.schedule_complete.load(std::memory_order_acquire)) return false;
  const bool staging_was_active = staging.active;
  const auto staging_revision_before = staging.revision;
  const auto staging_epoch_before = staging.epoch;
  const auto staging_window_id_before = staging.window_id;
  const auto staging_start_frame_before = staging.start_frame;
  const auto staging_end_frame_before = staging.end_frame;
  const auto staging_chunk_count_before = staging.chunk_count;
  const auto record_count_before = staging.record_count;
  const auto automation_count_before = staging.automation_state.segment_count;
  const auto automation_group_count_before = staging.automation_state.group_count;
  for (std::size_t index = 0; index < staging.automation_state.group_count; ++index) {
    staging.rollback_automation_group_counts[index] = staging.automation_state.groups[index].count;
  }
  const auto ends_schedule_before = staging.ends_schedule;
  const auto received_chunk_before = staging.received_chunks[chunk_index];
  const auto chunk_digest_before = staging.chunk_digests[chunk_index];
  bool keep_staging = false;
  struct StagingRollback {
    Impl::ScheduleStaging& staging;
    bool was_active;
    std::uint32_t revision;
    std::uint32_t epoch;
    std::uint64_t window_id;
    std::uint64_t start_frame;
    std::uint64_t end_frame;
    std::uint32_t chunk_count;
    std::size_t record_count;
    std::size_t automation_count;
    std::size_t automation_group_count;
    bool ends_schedule;
    std::uint32_t chunk_index;
    bool received_chunk;
    std::uint64_t chunk_digest;
    bool& keep;
    ~StagingRollback() {
      if (keep) return;
      if (!was_active) {
        staging.clear();
        return;
      }
      staging.active = was_active;
      staging.revision = revision;
      staging.epoch = epoch;
      staging.window_id = window_id;
      staging.start_frame = start_frame;
      staging.end_frame = end_frame;
      staging.chunk_count = chunk_count;
      for (std::size_t index = record_count; index < staging.record_count; ++index) {
        staging.events[index] = {};
      }
      staging.record_count = record_count;
      staging.automation_state.segment_count = automation_count;
      staging.automation_state.group_count = automation_group_count;
      for (std::size_t index = 0; index < automation_group_count; ++index) {
        const auto previous_count = staging.rollback_automation_group_counts[index];
        for (std::size_t segment = previous_count;
             segment < staging.automation_state.groups[index].count; ++segment) {
          staging.automation_state.groups[index].segments[segment] = {};
        }
        staging.automation_state.groups[index].count = previous_count;
      }
      for (std::size_t index = automation_group_count;
           index < staging.automation_state.groups.size(); ++index) {
        auto& group = staging.automation_state.groups[index];
        for (std::size_t segment = 0; segment < group.count; ++segment) {
          group.segments[segment] = {};
        }
        group.attachment = nullptr;
        group.count = 0;
      }
      staging.active = was_active;
      staging.ends_schedule = ends_schedule;
      staging.received_chunks[chunk_index] = received_chunk;
      staging.chunk_digests[chunk_index] = chunk_digest;
    }
  } rollback{
    staging,
    staging_was_active,
    staging_revision_before,
    staging_epoch_before,
    staging_window_id_before,
    staging_start_frame_before,
    staging_end_frame_before,
    staging_chunk_count_before,
    record_count_before,
    automation_count_before,
    automation_group_count_before,
    ends_schedule_before,
    chunk_index,
    received_chunk_before,
    chunk_digest_before,
    keep_staging,
  };
  if (!staging.active) {
    impl_->schedule_window_error = "schedule window is stale or not contiguous";
    if (window_id <= bank.last_accepted_schedule_window_id
      || start_frame != bank.accepted_schedule_through_frame.load(std::memory_order_acquire)) return false;
    staging.clear();
    staging.active = true;
    staging.revision = revision;
    staging.epoch = epoch;
    staging.window_id = window_id;
    staging.start_frame = start_frame;
    staging.end_frame = end_frame;
    staging.chunk_count = chunk_count;
  }
  impl_->schedule_window_error = "schedule chunk does not match the pending window";
  if (!staging.active || staging.revision != revision || staging.epoch != epoch
    || staging.window_id != window_id || staging.start_frame != start_frame
    || staging.end_frame != end_frame || staging.chunk_count != chunk_count
  ) return false;
  if (staging.received_chunks[chunk_index]) {
    return staging.chunk_digests[chunk_index] == digest ? accepted() : false;
  }
  std::size_t offset = 72;
  std::uint64_t previous_frame = 0;
  std::uint64_t previous_sequence = 0;
  bool has_previous = false;
  for (std::uint32_t index = 0; index < instrument_count; ++index) {
    impl_->schedule_window_error = "invalid instrument event length, frame or ordering";
    if (offset + 48 > payload.size()) return false;
    const auto* bytes = payload.data() + offset;
    const std::uint64_t frame = start_frame + ReadLeU32(bytes + 28);
    const std::uint64_t sequence = ReadLeU64(bytes + 16);
    if (frame < start_frame || frame >= end_frame || sequence == 0
      || (has_previous && (frame < previous_frame || (frame == previous_frame && sequence <= previous_sequence)))) {
      return false;
    }
    Impl::QueuedControlEvent event{};
    event.kind = Impl::QueuedControlKind::kInstrument;
    event.window_id = window_id;
    event.absolute_frame = frame;
    event.scheduled = true;
    event.instrument = {
      .node_id = ReadLeU64(bytes),
      .note_id = ReadLeU64(bytes + 8),
      .sequence = sequence,
      .epoch = ReadLeU32(bytes + 24),
      .frame_offset = static_cast<std::uint32_t>(frame),
      .type = ReadLeU32(bytes + 32),
      .channel = ReadLeU32(bytes + 36),
      .note = ReadLeU32(bytes + 40),
      .value = ReadLeFloat(bytes + 44),
    };
    impl_->schedule_window_error = "invalid instrument event epoch, value or capacity";
    if (event.instrument.epoch != epoch || !ValidNativeInstrumentEvent(event.instrument)
      || staging.record_count >= staging.events.size()) return false;
    impl_->schedule_window_error = "instrument target is missing or its parameter is unsupported";
    if (prepared && !impl_->ValidPreparedInstrumentEvent(event.instrument)) return false;
    if (!prepared && daw_audio_core_validate_instrument_target(
        impl_->active_core.load(std::memory_order_acquire), &event.instrument) != DAW_AUDIO_CORE_OK) return false;
    staging.events[staging.record_count++] = event;
    previous_frame = frame;
    previous_sequence = sequence;
    has_previous = true;
    offset += 48;
  }
  std::uint64_t previous_source_frame = 0;
  std::uint64_t previous_source_sequence = 0;
  bool has_previous_source = false;
  for (std::uint32_t index = 0; index < source_count; ++index) {
    impl_->schedule_window_error = "invalid source event or sample coverage";
    if (offset + 112 > payload.size()) return false;
    const auto* bytes = payload.data() + offset;
    const auto source_start = ReadLeU64(bytes + 24);
    const auto source_sequence = ReadLeU64(bytes + 4);
    const auto source_stop = ReadLeU64(bytes + 32);
    const auto source_offset = ReadLeU64(bytes + 40);
    const auto source_frames = ReadLeU64(bytes + 48);
    const auto fade_in_start = ReadLeI64(bytes + 60);
    const auto fade_in_end = ReadLeI64(bytes + 68);
    const auto fade_out_start = ReadLeI64(bytes + 76);
    const auto fade_out_end = ReadLeI64(bytes + 84);
    const auto fade_in_curve = ReadLeFloat(bytes + 96);
    const auto fade_in_curve_position = ReadLeFloat(bytes + 100);
    const auto fade_out_curve = ReadLeFloat(bytes + 104);
    const auto fade_out_curve_position = ReadLeFloat(bytes + 108);
    const bool seam_origin = prepared && start_frame == publication_frame && source_start <= start_frame;
    const auto scheduled_start = seam_origin ? start_frame : source_start;
    if ((!seam_origin && source_start < start_frame) || source_start >= end_frame || source_sequence == 0
      || (seam_origin && source_stop <= publication_frame)
      || source_stop <= source_start || source_stop > std::numeric_limits<std::int64_t>::max()
      || source_frames == 0 || source_offset > std::numeric_limits<std::uint64_t>::max() - source_frames
      || fade_in_start > fade_in_end || fade_out_start > fade_out_end
      || !std::isfinite(fade_in_curve) || fade_in_curve < -1.0F || fade_in_curve > 1.0F
      || !std::isfinite(fade_in_curve_position) || fade_in_curve_position < 0.0F || fade_in_curve_position > 1.0F
      || !std::isfinite(fade_out_curve) || fade_out_curve < -1.0F || fade_out_curve > 1.0F
      || !std::isfinite(fade_out_curve_position) || fade_out_curve_position < 0.0F || fade_out_curve_position > 1.0F
      || (has_previous_source && (scheduled_start < previous_source_frame
        || (scheduled_start == previous_source_frame && source_sequence <= previous_source_sequence)))) return false;
    const auto asset = impl_->assets.find(ReadLeU32(bytes + 20));
    if (asset == impl_->assets.end() || !impl_->AssetVisible(asset->second, revision)
      || source_offset + source_frames > asset->second.frame_count
      || staging.record_count >= staging.events.size()) return false;
    impl_->RetainAsset(asset->second);
    if (asset->second.mapped) {
      const auto source_end = source_offset + source_frames;
      const auto& ranges = asset->second.mapped->written_ranges;
      if (!std::any_of(ranges.begin(), ranges.end(), [source_offset, source_end](const auto range) {
        return range.first <= source_offset && range.second >= source_end;
      })) return false;
    }
    Impl::QueuedControlEvent event{};
    event.kind = Impl::QueuedControlKind::kSource;
    event.window_id = window_id;
    event.scheduled = true;
    event.source = {
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
      .epoch = ReadLeU32(bytes),
      .sequence = source_sequence,
      .source_node_id = ReadLeU64(bytes + 12),
      .asset = asset->second.handle,
      .start_frame = static_cast<std::int64_t>(source_start),
      .stop_frame = static_cast<std::int64_t>(source_stop),
      .source_offset_frame = source_offset,
      .source_frame_count = source_frames,
      .gain = ReadLeFloat(bytes + 56),
      .fade_in_start_frame = fade_in_start,
      .fade_in_end_frame = fade_in_end,
      .fade_out_start_frame = fade_out_start,
      .fade_out_end_frame = fade_out_end,
      .source_offset_fraction = ReadLeFloat(bytes + 92),
      .fade_in_curve = fade_in_curve,
      .fade_in_curve_position = fade_in_curve_position,
      .fade_out_curve = fade_out_curve,
      .fade_out_curve_position = fade_out_curve_position};
    if (event.source.epoch != epoch || staging.record_count >= staging.events.size()) return false;
    staging.events[staging.record_count++] = event;
    previous_source_frame = scheduled_start;
    previous_source_sequence = source_sequence;
    has_previous_source = true;
    offset += 112;
  }
  std::string previous_automation_instance;
  std::uint32_t previous_automation_parameter = 0;
  std::uint64_t previous_automation_start = 0;
  bool has_previous_automation = false;
  for (std::uint32_t index = 0; index < automation_count; ++index) {
    impl_->schedule_window_error = "invalid plugin automation or unavailable plugin";
    if (offset + 4 > payload.size()) return false;
    const std::uint32_t instance_bytes = ReadLeU32(payload.data() + offset);
    offset += 4;
    if (instance_bytes == 0 || instance_bytes > kMaximumScheduleInstanceIdBytes
      || offset + instance_bytes + 40 > payload.size()) return false;
    const std::string instance_id(
      reinterpret_cast<const char*>(payload.data() + offset),
      instance_bytes
    );
    offset += instance_bytes;
    const auto attachment = impl_->native_vst_attachments.find(instance_id);
    if (attachment == impl_->native_vst_attachments.end() || !attachment->second->metadata.playback_enabled) return false;
    NativeVstAutomationSegment segment{
      .parameter_id = ReadLeU32(payload.data() + offset),
      .start_frame = ReadLeU64(payload.data() + offset + 4),
      .end_frame = ReadLeU64(payload.data() + offset + 12),
      .start_value = ReadLeDouble(payload.data() + offset + 20),
      .end_value = ReadLeDouble(payload.data() + offset + 28),
      .linear = ReadLeU32(payload.data() + offset + 36) == 1,
    };
    if (has_previous_automation
      && (instance_id < previous_automation_instance
        || (instance_id == previous_automation_instance
          && (segment.parameter_id < previous_automation_parameter
            || (segment.parameter_id == previous_automation_parameter
              && segment.start_frame <= previous_automation_start))))) return false;
    if (ReadLeU32(payload.data() + offset + 36) > 1
      || segment.start_frame < start_frame || segment.start_frame >= segment.end_frame
      || segment.end_frame > end_frame || !std::isfinite(segment.start_value)
      || !std::isfinite(segment.end_value) || segment.start_value < 0.0 || segment.start_value > 1.0
      || segment.end_value < 0.0 || segment.end_value > 1.0
      || staging.automation_state.segment_count >= kMaximumScheduleAutomationSegments) return false;
    auto group = std::find_if(
      staging.automation_state.groups.begin(),
      staging.automation_state.groups.begin() + staging.automation_state.group_count,
      [&attachment](const auto& candidate) { return candidate.attachment == attachment->second.get(); }
    );
    if (group == staging.automation_state.groups.begin() + staging.automation_state.group_count) {
      if (staging.automation_state.group_count >= staging.automation_state.groups.size()) return false;
      group = staging.automation_state.groups.begin() + staging.automation_state.group_count++;
      group->attachment = attachment->second.get();
    }
    if (group->count >= group->segments.size()) return false;
    group->segments[group->count++] = segment;
    ++staging.automation_state.segment_count;
    previous_automation_instance = instance_id;
    previous_automation_parameter = segment.parameter_id;
    previous_automation_start = segment.start_frame;
    has_previous_automation = true;
    offset += 40;
  }
  std::uint64_t previous_processor_frame = 0;
  std::uint64_t previous_processor_instance = 0;
  std::uint32_t previous_processor_target = 0;
  bool has_previous_processor = false;
  for (std::uint32_t index = 0; index < processor_automation_count; ++index) {
    impl_->schedule_window_error = "invalid processor automation";
    if (offset + 40 > payload.size()) return false;
    const auto* bytes = payload.data() + offset;
    const std::uint64_t processor_instance = ReadLeU64(bytes);
    const std::uint32_t parameter_target = ReadLeU32(bytes + 8);
    const std::uint32_t kind = ReadLeU32(bytes + 12);
    const std::uint64_t frame = ReadLeU64(bytes + 16);
    const std::uint64_t processor_end_frame = ReadLeU64(bytes + 24);
    const float start_value = ReadLeFloat(bytes + 32);
    const float end_value = ReadLeFloat(bytes + 36);
    if (processor_instance == 0 || parameter_target == 0 || kind > 1
      || frame < start_frame || frame >= end_frame
      || !std::isfinite(start_value) || !std::isfinite(end_value)
      || (kind == 0 && processor_end_frame != frame)
      || (kind == 1 && (processor_end_frame <= frame || processor_end_frame > end_frame))
      || (has_previous_processor && (frame < previous_processor_frame
        || (frame == previous_processor_frame && (processor_instance < previous_processor_instance
          || (processor_instance == previous_processor_instance
            && parameter_target <= previous_processor_target)))))
      || staging.record_count >= staging.events.size()) return false;
    Impl::QueuedControlEvent event{};
    event.kind = Impl::QueuedControlKind::kProcessor;
    event.window_id = window_id;
    event.absolute_frame = frame;
    event.scheduled = true;
    event.processor_end_frame = processor_end_frame;
    event.processor_end_value = end_value;
    event.processor_revision = revision;
    event.processor_epoch = epoch;
    event.processor = {
      .processor_instance_id = processor_instance,
      .parameter_target = parameter_target,
      .frame_offset = 0,
      .value = start_value,
    };
    staging.events[staging.record_count++] = event;
    previous_processor_frame = frame;
    previous_processor_instance = processor_instance;
    previous_processor_target = parameter_target;
    has_previous_processor = true;
    offset += 40;
  }
  impl_->schedule_window_error = "unexpected trailing schedule data";
  if (offset != payload.size()) return false;
  staging.received_chunks[chunk_index] = true;
  staging.chunk_digests[chunk_index] = digest;
  staging.ends_schedule = staging.ends_schedule || ends_schedule == 1;
  if (std::count(staging.received_chunks.begin(),
      staging.received_chunks.begin() + staging.chunk_count, true) != staging.chunk_count) {
    keep_staging = true;
    return accepted();
  }
  const std::uint32_t instrument_events = static_cast<std::uint32_t>(
    std::count_if(staging.events.begin(), staging.events.begin() + staging.record_count,
      [](const auto& event) { return event.kind == Impl::QueuedControlKind::kInstrument; })
  );
  const std::uint32_t source_events = static_cast<std::uint32_t>(
    std::count_if(staging.events.begin(), staging.events.begin() + staging.record_count,
      [](const auto& event) { return event.kind == Impl::QueuedControlKind::kSource; })
  );
  const std::uint32_t processor_events = static_cast<std::uint32_t>(
    std::count_if(staging.events.begin(), staging.events.begin() + staging.record_count,
      [](const auto& event) { return event.kind == Impl::QueuedControlKind::kProcessor; })
  );
  if (prepared && start_frame == publication_frame && std::count_if(staging.events.begin(),
    staging.events.begin() + staging.record_count, [publication_frame](const auto& event) {
      return event.kind == Impl::QueuedControlKind::kSource
        && event.source.start_frame <= static_cast<std::int64_t>(publication_frame);
    }) > 256) {
    impl_->schedule_window_error = "source seam capacity exceeded";
    return false;
  }
  impl_->schedule_window_error = "schedule queue capacity exceeded";
  if (!Impl::HasCapacity(bank.instrument_queue, instrument_events)
    || !Impl::HasCapacity(bank.source_queue, source_events)
    || !Impl::HasCapacity(bank.scheduled_processor_queue, processor_events)) {
    staging.clear();
    return false;
  }
  const auto rendered_epoch = impl_->schedule_progress_epoch.load(std::memory_order_acquire);
  const auto rendered_through_frame = rendered_epoch == epoch
    ? impl_->schedule_progress_rendered_frame.load(std::memory_order_acquire)
    : 0;
  std::array<NativeVstWorkerAttachment::AutomationPublication, NativeScheduleAutomationState::kMaximumAttachments>
    automation_publications{};
  for (std::size_t index = 0; index < staging.automation_state.group_count; ++index) {
    impl_->schedule_window_error = "plugin automation could not be published";
    const auto& group = staging.automation_state.groups[index];
    auto* attachment = static_cast<NativeVstWorkerAttachment*>(group.attachment);
    if (attachment == nullptr || !attachment->StageAutomation(
      epoch,
      rendered_through_frame,
      std::span<const NativeVstAutomationSegment>(group.segments.data(), group.count),
      prepared ? 1U - impl_->active_schedule_bank.load(std::memory_order_acquire)
        : impl_->active_schedule_bank.load(std::memory_order_acquire), automation_publications[index]
    )) {
      staging.clear();
      return false;
    }
  }
  // Chunk arrival order is not timeline order. Sort only on the control
  // thread so a future head cannot hide an accepted overdue event.
  std::sort(staging.events.begin(), staging.events.begin() + staging.record_count,
    [publication_frame](const auto& left, const auto& right) {
      const auto left_frame = left.kind == Impl::QueuedControlKind::kSource
        ? std::max(publication_frame, static_cast<std::uint64_t>(left.source.start_frame)) : left.absolute_frame;
      const auto right_frame = right.kind == Impl::QueuedControlKind::kSource
        ? std::max(publication_frame, static_cast<std::uint64_t>(right.source.start_frame)) : right.absolute_frame;
      if (left_frame != right_frame) return left_frame < right_frame;
      if (left.kind != right.kind) return left.kind < right.kind;
      if (left.kind == Impl::QueuedControlKind::kInstrument)
        return left.instrument.sequence < right.instrument.sequence;
      if (left.kind == Impl::QueuedControlKind::kSource)
        return left.source.sequence < right.source.sequence;
      return left.processor.processor_instance_id < right.processor.processor_instance_id
        || (left.processor.processor_instance_id == right.processor.processor_instance_id
          && left.processor.parameter_target < right.processor.parameter_target);
    });
  for (std::size_t index = 0; index < staging.record_count; ++index) {
    impl_->schedule_window_error = "schedule event queue is full";
    const auto& event = staging.events[index];
    const bool queued = event.kind == Impl::QueuedControlKind::kProcessor
      ? Impl::EnqueueControlEvent(bank.scheduled_processor_queue, event)
      : event.kind == Impl::QueuedControlKind::kInstrument
        ? Impl::EnqueueControlEvent(bank.instrument_queue, event)
        : Impl::EnqueueControlEvent(bank.source_queue, event);
    if (!queued) {
      staging.clear();
      return false;
    }
  }
  // All groups and lanes have passed admission. Nothing from a rejected
  // multi-attachment window can leak into the active automation buffers.
  for (std::size_t index = 0; index < staging.automation_state.group_count; ++index) {
    const auto& publication = automation_publications[index];
    publication.bank->buffer_counts[publication.buffer] = publication.count;
    publication.bank->count.store(publication.count, std::memory_order_release);
    publication.bank->epoch.store(epoch, std::memory_order_release);
    publication.bank->buffer.store(publication.buffer, std::memory_order_release);
  }
  impl_->PublishAutomationCredits();
  bank.published_schedule_window_id.store(window_id, std::memory_order_release);
  bank.accepted_schedule_epoch.store(epoch, std::memory_order_release);
  bank.accepted_schedule_through_frame.store(end_frame, std::memory_order_release);
  bank.last_accepted_schedule_window_id = window_id;
  bank.last_schedule_start_frame = start_frame;
  bank.schedule_complete.store(staging.ends_schedule, std::memory_order_release);
  const auto cursor = bank.schedule_digest_cursor++ % bank.schedule_digest_windows.size();
  bank.schedule_digest_windows[cursor] = window_id;
  bank.schedule_chunk_digests[cursor] = staging.chunk_digests;
  staging.clear();
  keep_staging = true;
  return accepted();
}

std::string_view AudioHost::scheduleWindowError() const { return impl_->schedule_window_error; }

}  // namespace daw::audio_host_macos
