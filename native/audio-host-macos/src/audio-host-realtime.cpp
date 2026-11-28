#include "audio-host-internal.h"

namespace daw::audio_host_macos {

// DAW_REALTIME_CALLBACK_REGION_BEGIN audio-host
bool AudioHost::ProcessPlanar(
  std::span<const float* const> input,
  std::span<float* const> output,
  std::uint32_t frame_count) {
  const auto callback_attempt = impl_->callback_attempts.fetch_add(1, std::memory_order_relaxed) + 1;
  if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kRunning
    || impl_->active_core.load(std::memory_order_acquire) == 0
    || input.size() < impl_->config.channel_count
    || output.size() < impl_->config.channel_count) {
    impl_->RejectBlock(RejectedBlockReason::kNotRunningOrCoreUnavailable, callback_attempt);
    return false;
  }
  for (std::uint32_t channel = 0; channel < impl_->config.channel_count; ++channel) {
    if (input[channel] == nullptr || output[channel] == nullptr) {
      impl_->RejectBlock(RejectedBlockReason::kNullChannel, callback_attempt);
      return false;
    }
  }
#if defined(DAW_AUDIO_HOST_TEST_PATCH_CLAIM)
  impl_->test_patch_claim_hold_frames.fetch_sub(frame_count, std::memory_order_relaxed);
#endif
  impl_->ApplyRequestedProcessorPatch();
  const float* const* inputs = input.data();
  float* const* outputs = output.data();
  std::uint32_t offset = 0;
  while (offset < frame_count) {
    impl_->ApplyRequestedProcessorPatch();
    {
      std::uint32_t read = impl_->transport_queue.read.load(std::memory_order_relaxed);
      const std::uint32_t write = impl_->transport_queue.write.load(std::memory_order_acquire);
      while (read != write) {
        const auto command = impl_->transport_queue.commands[read % Impl::kTransportQueueCapacity];
        const auto current_epoch = impl_->applied_transport_epoch.load(std::memory_order_acquire);
        const auto current_transition = impl_->applied_transport_transition_id.load(std::memory_order_acquire);
        if (command.transition_id > current_transition && command.epoch >= current_epoch) {
          const daw_audio_transport_state state{
            .epoch = command.epoch,
            .running = command.running ? 1U : 0U,
            .frame = command.frame,
            .tempo_bpm = command.bpm,
            .time_signature_numerator = command.time_signature_numerator,
            .time_signature_denominator = command.time_signature_denominator,
            .cycle_active = command.cycle_active ? 1U : 0U,
            .cycle_start_frame = command.cycle_start_frame,
            .cycle_end_frame = command.cycle_end_frame,
          };
          const daw_audio_core_handle core = impl_->active_core.load(std::memory_order_acquire);
          const auto result = core == 0 ? DAW_AUDIO_CORE_INVALID_HANDLE : daw_audio_core_set_transport(core, &state);
          if (result != DAW_AUDIO_CORE_OK) {
            impl_->RejectBlock(RejectedBlockReason::kTransport, callback_attempt, result);
            return false;
          }
          if (impl_->ActiveSchedule().accepted_schedule_epoch.load(std::memory_order_acquire) != command.epoch) {
            impl_->ActiveSchedule().published_schedule_window_id.store(0, std::memory_order_release);
            impl_->ActiveSchedule().accepted_schedule_through_frame.store(command.frame, std::memory_order_release);
            impl_->ActiveSchedule().schedule_complete.store(false, std::memory_order_release);
            impl_->ActiveSchedule().accepted_schedule_epoch.store(command.epoch, std::memory_order_release);
          }
          impl_->applied_transport_epoch.store(command.epoch, std::memory_order_release);
          impl_->applied_transport_frame.store(command.frame, std::memory_order_release);
          impl_->applied_transport_running.store(command.running, std::memory_order_release);
          impl_->applied_transport_transition_id.store(command.transition_id, std::memory_order_release);
          if (!command.running) impl_->SignalRealtimeBridge(Impl::kRealtimeLatencyCompleted);
        }
        ++read;
      }
      impl_->transport_queue.read.store(read, std::memory_order_release);
    }
    const auto pending_revision = impl_->publish_requested_revision.load(std::memory_order_acquire);
    const auto requested_frame = pending_revision == 0 ? 0 : impl_->requested_publication_frame.load(std::memory_order_acquire);
    const auto current_frame = static_cast<std::uint64_t>(impl_->applied_transport_frame.load(std::memory_order_acquire));
    const std::uint32_t requested_revision = pending_revision != 0
      && (requested_frame == 0 || current_frame >= requested_frame)
      ? impl_->publish_requested_revision.exchange(0, std::memory_order_acq_rel) : 0;
    std::uint32_t unowned_schedule = 0;
    const bool schedule_claimed = requested_revision != 0 && impl_->schedule_owner.compare_exchange_strong(
      unowned_schedule, 2, std::memory_order_acq_rel);
    // Complete windows are sorted, so instrument/processor heads suffice.
    // Automation segments are projected per block, not deferred in a queue.
    const auto head_before_seam = [requested_frame]<std::size_t Capacity>(const Impl::ControlLane<Capacity>& lane) {
      const auto read = lane.read.load(std::memory_order_relaxed);
      return lane.write.load(std::memory_order_acquire) != read
        && lane.events[read % Capacity].absolute_frame < requested_frame;
    };
    // Legacy direct source commands share the source lane without ordering;
    // inspect its bounded capacity rather than let a future head hide work.
    const auto direct_source_before_seam = [requested_frame]<std::size_t Capacity>(
      const Impl::ControlLane<Capacity>& lane) {
      const auto read = lane.read.load(std::memory_order_relaxed);
      const auto count = std::min<std::uint32_t>(lane.write.load(std::memory_order_acquire) - read, Capacity);
      for (std::uint32_t index = 0; index < count; ++index) {
        if (static_cast<std::uint64_t>(lane.events[(read + index) % Capacity].source.start_frame)
          < requested_frame) return true;
      }
      return false;
    };
    const bool old_bank_pending = schedule_claimed && requested_frame != 0
      && (head_before_seam(impl_->ActiveSchedule().instrument_queue)
        || head_before_seam(impl_->ActiveSchedule().scheduled_processor_queue)
        || direct_source_before_seam(impl_->ActiveSchedule().source_queue));
    if (old_bank_pending) impl_->ActiveSchedule().instrument_drain_priority = true;
    if (requested_revision != 0 && (!schedule_claimed
      || (requested_frame != 0 && current_frame != requested_frame) || old_bank_pending)) {
      impl_->publication_rebase_required.store(true, std::memory_order_release);
      impl_->publish_deferred_revision.store(requested_revision, std::memory_order_release);
      impl_->SignalRealtimeBridge(Impl::kRealtimeScheduleProgress);
    } else if (requested_revision != 0
      && impl_->prepared_core != 0
      && impl_->prepared_revision.load(std::memory_order_acquire) == requested_revision) {
      // Frame zero publishes with no seam, so no source declarations are reconciled.
      std::optional<Impl::SourceSeam> source_seam;
      if (requested_frame != 0) source_seam = impl_->AdmitSourceSeam(static_cast<std::int64_t>(requested_frame));
      const bool sources_ready = requested_frame == 0 || source_seam.has_value();
      if (!sources_ready) impl_->publication_rebase_required.store(true, std::memory_order_release);
      const auto result = sources_ready ? daw_audio_core_publish(
        impl_->active_core.load(std::memory_order_acquire), requested_revision)
        : DAW_AUDIO_CORE_LATENCY_MOVE_PENDING;
      if (result == DAW_AUDIO_CORE_OK) {
        impl_->ApplyPreparedTransportContext();
        impl_->PromoteObservationLookup();
        if (source_seam) impl_->CommitSourceSeam(*source_seam);
        impl_->ReconcileScheduledTargets(impl_->active_core.load(std::memory_order_acquire),
          impl_->active_revision.load(std::memory_order_acquire), requested_revision, requested_frame == 0);
        if (requested_frame != 0) {
          impl_->active_schedule_bank.store(
            1U - impl_->active_schedule_bank.load(std::memory_order_relaxed), std::memory_order_release);
        }
        const auto publication_frame = impl_->applied_transport_frame.load(std::memory_order_relaxed);
        const auto publication_epoch = impl_->completed_render_epoch.load(std::memory_order_relaxed);
        impl_->publication_frame.store(publication_frame, std::memory_order_release);
        if (impl_->observer) impl_->observer->SetPublicationPosition(publication_frame, publication_epoch);
        impl_->RecordPublicationLatency();
        impl_->RetirePreviousPlan(impl_->active_revision.exchange(requested_revision, std::memory_order_acq_rel));
        impl_->prepared_core = 0;
        impl_->prepared_revision.store(0, std::memory_order_release);
        impl_->last_graph_revision.store(requested_revision, std::memory_order_release);
      }
      if (result == DAW_AUDIO_CORE_LATENCY_MOVE_PENDING) {
        // Not admitted: preserve the prepared bank for explicit event retry.
        impl_->publish_deferred_revision.store(requested_revision, std::memory_order_release);
        impl_->SignalRealtimeBridge(Impl::kRealtimeScheduleProgress);
      } else {
        impl_->publish_acknowledged_revision.store(requested_revision, std::memory_order_release);
        impl_->SignalRealtimeBridge(Impl::kRealtimePublishAcknowledged);
      }
    }
    const daw_audio_core_handle active_core = impl_->active_core.load(std::memory_order_acquire);
    const std::uint32_t maximum_frames = std::min(
      impl_->config.max_frames_per_block,
      static_cast<std::uint32_t>(DAW_AUDIO_RECORDING_CAPTURE_BLOCK_FRAMES));
    std::uint32_t frames = frame_count - offset > maximum_frames
      ? maximum_frames
      : frame_count - offset;
    // Device callbacks can be shorter than the configured maximum. Split the
    // final old-bank slice at the seam, never overshoot it or publish late.
    if (pending_revision != 0 && requested_frame > current_frame)
      frames = static_cast<std::uint32_t>(std::min<std::uint64_t>(frames, requested_frame - current_frame));
    auto& input_slice = impl_->realtime_process_scratch.input_slice;
    auto& output_slice = impl_->realtime_process_scratch.output_slice;
    if (impl_->config.channel_count > input_slice.size()) {
      impl_->RejectBlock(RejectedBlockReason::kScratchCapacity, callback_attempt);
      return false;
    }
    for (std::uint32_t channel = 0; channel < impl_->config.channel_count; ++channel) {
      input_slice[channel] = inputs[channel] + offset;
      output_slice[channel] = outputs[channel] + offset;
    }
    auto& processor_events = impl_->realtime_process_scratch.processor_events;
    auto& instrument_events = impl_->realtime_process_scratch.instrument_events;
    auto& render_instrument_events = impl_->realtime_process_scratch.render_instrument_events;
    auto& rejected_instrument_events = impl_->realtime_process_scratch.rejected_instrument_events;
    auto& instrument_order = impl_->realtime_process_scratch.instrument_order;
    std::uint32_t processor_event_count = 0;
    std::uint64_t processor_sequence_applied = 0;
    std::uint32_t instrument_event_count = 0;
    std::uint64_t urgent_sequence_applied = 0;
    std::uint32_t urgent_read = impl_->urgent_queue.read.load(std::memory_order_relaxed);
    std::uint32_t scheduled_instrument_read = impl_->ActiveSchedule().instrument_queue.read.load(std::memory_order_relaxed);
    std::uint32_t instrument_read = impl_->instrument_queue.read.load(std::memory_order_relaxed);
    const auto block_start_frame = impl_->applied_transport_frame.load(std::memory_order_acquire);
    const auto block_end_frame = block_start_frame + static_cast<std::int64_t>(frames);
    const auto applied_epoch = impl_->applied_transport_epoch.load(std::memory_order_acquire);
    const auto published_window = impl_->ActiveSchedule().published_schedule_window_id.load(std::memory_order_acquire);
    const auto drain_scheduled_processor_lane = [&]<std::size_t Capacity>(Impl::ControlLane<Capacity>& lane) {
      std::uint32_t read = lane.read.load(std::memory_order_relaxed);
      const std::uint32_t write = lane.write.load(std::memory_order_acquire);
      while (read != write) {
        const auto& event = lane.events[read % Capacity];
        if (event.cancelled || event.processor_revision != impl_->active_revision.load(std::memory_order_acquire)
          || event.processor_epoch != applied_epoch) {
          ++read;
          continue;
        }
        if (!impl_->applied_transport_running.load(std::memory_order_acquire)) break;
        if (event.window_id > published_window) break;
        if (event.absolute_frame >= static_cast<std::uint64_t>(block_end_frame)) break;
        if (event.processor_end_frame > event.absolute_frame) {
          if (event.processor_end_frame > static_cast<std::uint64_t>(block_start_frame)) {
            if (impl_->processor_ramp_count >= impl_->processor_ramps.size()) return false;
            impl_->processor_ramps[impl_->processor_ramp_count++] = {
              .processor = event.processor,
              .start_frame = event.absolute_frame,
              .end_frame = event.processor_end_frame,
              .end_value = event.processor_end_value,
              .revision = event.processor_revision,
              .epoch = event.processor_epoch,
            };
          }
          ++read;
          continue;
        }
        if (event.absolute_frame < static_cast<std::uint64_t>(block_start_frame)) {
          ++read;
          continue;
        }
        if (processor_event_count >= processor_events.size()) return false;
        processor_events[processor_event_count] = event.processor;
        processor_events[processor_event_count].frame_offset = event.absolute_frame <= static_cast<std::uint64_t>(block_start_frame)
          ? 0
          : static_cast<std::uint32_t>(event.absolute_frame - static_cast<std::uint64_t>(block_start_frame));
        ++processor_event_count;
        ++read;
      }
      lane.read.store(read, std::memory_order_release);
      return true;
    };
    const auto drain_processor_lane = [&]<std::size_t Capacity>(Impl::ControlLane<Capacity>& lane) {
      std::uint32_t read = lane.read.load(std::memory_order_relaxed);
      const std::uint32_t write = lane.write.load(std::memory_order_acquire);
      while (read != write) {
        const auto& event = lane.events[read % Capacity];
        if (event.cancelled || (event.processor_revision != 0
          && (event.processor_revision != impl_->active_revision.load(std::memory_order_acquire)
            || event.processor_epoch != applied_epoch))) {
          ++read;
          continue;
        }
        if (event.processor.frame_offset >= frames) break;
        if (processor_event_count >= processor_events.size()) return false;
        processor_events[processor_event_count] = event.processor;
        ++processor_event_count;
        processor_sequence_applied = std::max(processor_sequence_applied, event.processor_sequence);
        ++read;
      }
      lane.read.store(read, std::memory_order_release);
      return true;
    };
    // Each block writes a ramp value every `stride` frames, the smallest power of two that keeps the block's events inside
    // the core's capacity less headroom for the VST automation the coordinator counts with them. Ramps stay in `processor_ramps`
    // until they end, so a rejected block retries with the same ramps.
    constexpr std::uint32_t kRampVstHeadroom = 32;
    const auto expand_processor_ramps = [&]() {
      if (!impl_->applied_transport_running.load(std::memory_order_acquire)) return true;
      const auto& ramps = impl_->processor_ramps;
      const std::uint64_t block_start = static_cast<std::uint64_t>(block_start_frame);
      const std::uint64_t block_end = static_cast<std::uint64_t>(block_end_frame);
      const auto span_of = [&](const Impl::ProcessorRamp& ramp) {
        return std::min(ramp.end_frame, block_end) - std::max(ramp.start_frame, block_start);
      };
      const std::uint32_t reserved = std::min<std::uint32_t>(
        static_cast<std::uint32_t>(processor_events.size()), processor_event_count + kRampVstHeadroom);
      const std::uint32_t budget = static_cast<std::uint32_t>(processor_events.size()) - reserved;
      std::uint32_t stride = 1;
      for (; stride < frames; stride *= 2) {
        std::uint64_t needed = 0;
        for (std::uint32_t index = 0; index < impl_->processor_ramp_count; ++index)
          needed += (span_of(ramps[index]) + stride - 1) / stride;
        if (needed <= budget) break;
      }
      for (std::uint32_t index = 0; index < impl_->processor_ramp_count; ++index) {
        const auto& ramp = ramps[index];
        const std::uint64_t last = std::min(ramp.end_frame, block_end);
        const double slope = (static_cast<double>(ramp.end_value) - ramp.processor.value)
          / static_cast<double>(ramp.end_frame - ramp.start_frame);
        for (std::uint64_t frame = std::max(ramp.start_frame, block_start); frame < last; frame += stride) {
          if (processor_event_count >= processor_events.size()) return false;
          processor_events[processor_event_count] = ramp.processor;
          processor_events[processor_event_count].frame_offset = static_cast<std::uint32_t>(frame - block_start);
          processor_events[processor_event_count].value = static_cast<float>(
            ramp.processor.value + slope * static_cast<double>(frame - ramp.start_frame));
          ++processor_event_count;
        }
      }
      return true;
    };
    const auto drain_instrument_lane = [&]<std::size_t Capacity>(
      Impl::ControlLane<Capacity>& lane, std::uint32_t& read, const bool urgent) {
      const std::uint32_t write = lane.write.load(std::memory_order_acquire);
      while (read != write) {
        auto& event = lane.events[read % Capacity];
        if (event.cancelled || event.instrument.epoch != applied_epoch) {
          ++read;
          continue;
        }
        if (event.scheduled && !impl_->applied_transport_running.load(std::memory_order_acquire)) break;
        if (event.scheduled && event.window_id > published_window) break;
        const auto event_frame = event.scheduled ? event.absolute_frame
          : static_cast<std::uint64_t>(event.instrument.frame_offset);
        if (event_frame >= static_cast<std::uint64_t>(block_end_frame)) break;
        // Keep excess scheduled notes in their lane when live controls use
        // block capacity. Render them at offset zero next time, never consume
        // a live control in a block that we reject for merge overflow.
        if (instrument_event_count >= instrument_events.size()) break;
        instrument_order[instrument_event_count] = static_cast<std::uint16_t>(instrument_event_count);
        instrument_events[instrument_event_count] = event.instrument;
        if (urgent) urgent_sequence_applied = std::max(urgent_sequence_applied, event.instrument.sequence);
        instrument_events[instrument_event_count].frame_offset = event_frame <= static_cast<std::uint64_t>(block_start_frame)
          ? 0
          : static_cast<std::uint32_t>(event_frame - static_cast<std::uint64_t>(block_start_frame));
        ++instrument_event_count;
        ++read;
      }
      // Publish consumption only after core processing succeeds. Producers
      // cannot overwrite controls retained for a rejected block's retry.
      return true;
    };
    const auto drain_source_lane = [&]<std::size_t Capacity>(Impl::ControlLane<Capacity>& lane) {
      std::uint32_t read = lane.read.load(std::memory_order_relaxed);
      const std::uint32_t write = lane.write.load(std::memory_order_acquire);
      while (read != write) {
        const auto& event = lane.events[read % Capacity];
        if (event.cancelled) {
          ++read;
          continue;
        }
        if (event.scheduled && !impl_->applied_transport_running.load(std::memory_order_acquire)) break;
        if (event.scheduled && event.source.epoch != applied_epoch) {
          ++read;
          continue;
        }
        if (event.scheduled && event.window_id > published_window) break;
        if (event.scheduled && event.source.start_frame >= block_end_frame) break;
        if (daw_audio_core_schedule_sample_source(active_core, &event.source) != DAW_AUDIO_CORE_OK) return false;
        ++read;
      }
      const auto previous_read = lane.read.exchange(read, std::memory_order_release);
      if (read != previous_read && impl_->asset_retirement_pending.load(std::memory_order_acquire))
        impl_->SignalRealtimeBridge(Impl::kRealtimeAssetReaders);
      return true;
    };
    {
      auto& ramps = impl_->processor_ramps;
      std::uint32_t kept = 0;
      for (std::uint32_t index = 0; index < impl_->processor_ramp_count; ++index) {
        const auto& ramp = ramps[index];
        if (ramp.cancelled || ramp.revision != impl_->active_revision.load(std::memory_order_acquire)
          || ramp.epoch != applied_epoch || ramp.end_frame <= static_cast<std::uint64_t>(block_start_frame)) continue;
        ramps[kept++] = ramp;
      }
      impl_->processor_ramp_count = kept;
    }
    // After a saturation rebase, new live controls cannot starve the finite
    // accepted schedule backlog. All lanes retain excess events for retry.
    if ((impl_->ActiveSchedule().instrument_drain_priority
        && !drain_instrument_lane(impl_->ActiveSchedule().instrument_queue, scheduled_instrument_read, false))
      || !drain_instrument_lane(impl_->urgent_queue, urgent_read, true)
      || !drain_instrument_lane(impl_->instrument_queue, instrument_read, false)
      || !drain_instrument_lane(impl_->ActiveSchedule().instrument_queue, scheduled_instrument_read, false)
      || !drain_scheduled_processor_lane(impl_->ActiveSchedule().scheduled_processor_queue)
      || !drain_processor_lane(impl_->processor_queue)
      || !expand_processor_ramps()
      || !drain_source_lane(impl_->ActiveSchedule().source_queue)) {
      const auto reason = instrument_event_count >= instrument_events.size()
        ? RejectedBlockReason::kInstrumentEventCapacity
        : processor_event_count >= processor_events.size()
          || impl_->processor_ramp_count >= impl_->processor_ramps.size()
          ? RejectedBlockReason::kProcessorEventCapacity
          : RejectedBlockReason::kSourceSchedule;
      impl_->RejectBlock(reason, callback_attempt);
      return false;
    }
    const auto processor_before = [](const auto& left, const auto& right) {
      return left.processor_instance_id < right.processor_instance_id
        || (left.processor_instance_id == right.processor_instance_id && (
          left.frame_offset < right.frame_offset
          || (left.frame_offset == right.frame_offset && left.parameter_target < right.parameter_target)));
    };
    for (std::uint32_t index = 1; index < processor_event_count; ++index) {
      const auto event = processor_events[index];
      std::uint32_t position = index;
      while (position > 0 && processor_before(event, processor_events[position - 1])) {
        processor_events[position] = processor_events[position - 1];
        --position;
      }
      processor_events[position] = event;
    }
    std::sort(instrument_order.begin(), instrument_order.begin() + instrument_event_count,
      [&instrument_events](const auto left_index, const auto right_index) {
        const auto& left = instrument_events[left_index];
        const auto& right = instrument_events[right_index];
        return left.frame_offset < right.frame_offset
          || (left.frame_offset == right.frame_offset && left.sequence < right.sequence);
      });
    // Queue sequence domains are independent. Preserve their acknowledgement
    // identity above; the core requires increasing sequences across this block.
    for (std::uint32_t index = 0; index < instrument_event_count; ++index) {
      render_instrument_events[index] = instrument_events[instrument_order[index]];
      render_instrument_events[index].sequence = index + 1;
    }
    const daw_audio_core_process_block block{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
      .frame_count = frames,
      .channel_count = impl_->config.channel_count,
      .input_bus_count = 1,
      .inputs = input_slice.data(),
      .outputs = output_slice.data(),
      .graph_revision = impl_->active_revision.load(std::memory_order_acquire),
      .parameter_block_count = 0,
      .parameter_blocks = nullptr,
      .event_count = processor_event_count,
      .events = processor_event_count == 0 ? nullptr : processor_events.data(),
      .transport_epoch = applied_epoch,
      .instrument_event_count = instrument_event_count,
      .instrument_events = instrument_event_count == 0 ? nullptr : render_instrument_events.data(),
    };
    const auto latency_before = daw::audio_core::InspectLatencyTransition(active_core);
    const auto result = impl_->strict_offline_export
      ? daw_audio_core_process(active_core, &block)
      : daw_audio_core_process_valid_instrument_events(
        active_core, &block, rejected_instrument_events.data());
    if (result != DAW_AUDIO_CORE_OK) {
      const auto rejected_index = daw_audio_core_rejected_instrument_event_index(active_core);
      impl_->RejectBlock(
        RejectedBlockReason::kCoreProcess,
        callback_attempt,
        result,
        frames,
        impl_->config.channel_count,
        processor_event_count,
        impl_->strict_offline_export && rejected_index == UINT32_MAX
          ? 0 : instrument_event_count,
        block.graph_revision
      );
      return false;
    }
    const auto latency_after = daw::audio_core::InspectLatencyTransition(active_core);
    const bool latency_completed = latency_after.completed_revision != latency_before.completed_revision;
    if (impl_->offline_failure.load(std::memory_order_acquire)) {
      impl_->RejectBlock(
        RejectedBlockReason::kCoreProcess,
        callback_attempt,
        DAW_AUDIO_CORE_INVALID_ARGUMENT,
        frames,
        impl_->config.channel_count,
        processor_event_count,
        instrument_event_count,
        block.graph_revision
      );
      return false;
    }
    std::uint32_t rejected_count = 0;
    std::uint32_t first_rejected = 0;
    for (std::uint32_t index = 0; index < instrument_event_count; ++index) {
      if (rejected_instrument_events[index] == 0) continue;
      if (rejected_count == 0) first_rejected = index;
      ++rejected_count;
    }
    if (rejected_count != 0) {
      const auto& first = instrument_events[instrument_order[first_rejected]];
      // Lifetime cumulative reporting coalesces bridge wakeups without losing
      // counts or racing replacement of the first rejection's identity.
      if (impl_->rejected_instrument_count.load(std::memory_order_relaxed) == 0) {
        impl_->rejected_instrument_node.store(first.node_id, std::memory_order_relaxed);
        impl_->rejected_instrument_sequence.store(first.sequence, std::memory_order_relaxed);
      }
      impl_->rejected_instrument_count.fetch_add(rejected_count, std::memory_order_release);
      impl_->SignalRealtimeBridge(Impl::kRealtimeInstrumentRejected);
    }
    auto applied_processor_sequence = impl_->applied_processor_sequence.load(std::memory_order_relaxed);
    while (processor_sequence_applied > applied_processor_sequence
      && !impl_->applied_processor_sequence.compare_exchange_weak(
        applied_processor_sequence, processor_sequence_applied, std::memory_order_release, std::memory_order_relaxed)) {}
    impl_->urgent_queue.read.store(urgent_read, std::memory_order_release);
    impl_->instrument_queue.read.store(instrument_read, std::memory_order_release);
    impl_->ActiveSchedule().instrument_queue.read.store(scheduled_instrument_read, std::memory_order_release);
    auto applied_urgent = impl_->applied_urgent_sequence.load(std::memory_order_relaxed);
    while (urgent_sequence_applied > applied_urgent
      && !impl_->applied_urgent_sequence.compare_exchange_weak(
        applied_urgent, urgent_sequence_applied, std::memory_order_release, std::memory_order_relaxed)) {}
    if (impl_->recording_monitoring.load(std::memory_order_acquire)) {
      const std::uint64_t read = impl_->recording_monitor_read.load(std::memory_order_relaxed);
      const std::uint64_t write = impl_->recording_monitor_write.load(std::memory_order_acquire);
      const std::uint32_t monitored_frames = std::min<std::uint64_t>(frames, write - read);
      const std::uint32_t recording_channels = impl_->recording_channel_count.load(std::memory_order_acquire);
      for (std::uint32_t channel = 0; channel < impl_->config.channel_count && recording_channels > 0; ++channel) {
        const std::uint32_t monitor_channel = std::min(channel, recording_channels - 1);
        for (std::uint32_t frame = 0; frame < monitored_frames; ++frame) {
          output_slice[channel][frame] +=
            impl_->recording_monitor_ring[monitor_channel][(read + frame) % Impl::kRecordingMonitorCapacity];
        }
      }
      impl_->recording_monitor_read.store(read + monitored_frames, std::memory_order_release);
    }
    if (impl_->applied_transport_running.load(std::memory_order_acquire)) {
      impl_->applied_transport_frame.fetch_add(frames, std::memory_order_release);
      impl_->transport_frame.store(
        impl_->applied_transport_frame.load(std::memory_order_acquire),
        std::memory_order_release
      );
    }
    if (impl_->observer && impl_->observer->tap()) {
      impl_->observer->tap()->Push(output_slice.data(), frames, block.graph_revision, applied_epoch, block_start_frame);
      impl_->SignalRealtimeBridge(Impl::kRealtimeAcceptanceCapture);
    }
    impl_->schedule_progress_revision.store(
      impl_->active_revision.load(std::memory_order_acquire),
      std::memory_order_release
    );
    impl_->schedule_progress_epoch.store(applied_epoch, std::memory_order_release);
    impl_->schedule_progress_rendered_frame.store(
      static_cast<std::uint64_t>(std::max<std::int64_t>(
        0,
        impl_->applied_transport_frame.load(std::memory_order_acquire)
      )),
      std::memory_order_release
    );
    impl_->schedule_progress_accepted_frame.store(
      impl_->ActiveSchedule().accepted_schedule_through_frame.load(std::memory_order_acquire),
      std::memory_order_release
    );
    impl_->schedule_progress_window_id.store(
      impl_->ActiveSchedule().published_schedule_window_id.load(std::memory_order_acquire),
      std::memory_order_release
    );
    impl_->schedule_progress_applied_transition.store(
      impl_->applied_transport_transition_id.load(std::memory_order_acquire),
      std::memory_order_release
    );
    impl_->schedule_progress_urgent.store(
      impl_->applied_urgent_sequence.load(std::memory_order_acquire),
      std::memory_order_release
    );
    impl_->schedule_progress_processor.store(
      impl_->applied_processor_sequence.load(std::memory_order_acquire),
      std::memory_order_release
    );
    impl_->schedule_progress_running.store(
      impl_->applied_transport_running.load(std::memory_order_acquire),
      std::memory_order_release
    );
    impl_->schedule_progress_complete.store(
      impl_->ActiveSchedule().schedule_complete.load(std::memory_order_acquire),
      std::memory_order_release
    );
    const auto rendered_frame = impl_->schedule_progress_rendered_frame.load(std::memory_order_relaxed);
    const auto revision = impl_->schedule_progress_revision.load(std::memory_order_relaxed);
    const auto epoch = impl_->schedule_progress_epoch.load(std::memory_order_relaxed);
    const auto accepted_frame = impl_->schedule_progress_accepted_frame.load(std::memory_order_relaxed);
    const auto window_id = impl_->schedule_progress_window_id.load(std::memory_order_relaxed);
    const auto transition = impl_->schedule_progress_applied_transition.load(std::memory_order_relaxed);
    const auto urgent = impl_->schedule_progress_urgent.load(std::memory_order_relaxed);
    const auto processor = impl_->schedule_progress_processor.load(std::memory_order_relaxed);
    const auto running = impl_->schedule_progress_running.load(std::memory_order_relaxed);
    const auto complete = impl_->schedule_progress_complete.load(std::memory_order_relaxed);
    const auto frame_quantum = std::max<std::uint64_t>(
      static_cast<std::uint64_t>(impl_->config.max_frames_per_block),
      512
    );
    const bool meaningful = !impl_->schedule_progress_has_notification
      || rendered_frame >= impl_->schedule_progress_notified_frame + frame_quantum
      || revision != impl_->schedule_progress_notified_revision
      || epoch != impl_->schedule_progress_notified_epoch
      || accepted_frame != impl_->schedule_progress_notified_accepted_frame
      || window_id != impl_->schedule_progress_notified_window_id
      || transition != impl_->schedule_progress_notified_transition
      || urgent != impl_->schedule_progress_notified_urgent
      || processor != impl_->schedule_progress_notified_processor
      || running != impl_->schedule_progress_notified_running
      || complete != impl_->schedule_progress_notified_complete;
    if (meaningful) {
      impl_->schedule_progress_has_notification = true;
      impl_->schedule_progress_notified_frame = rendered_frame;
      impl_->schedule_progress_notified_revision = revision;
      impl_->schedule_progress_notified_epoch = epoch;
      impl_->schedule_progress_notified_accepted_frame = accepted_frame;
      impl_->schedule_progress_notified_window_id = window_id;
      impl_->schedule_progress_notified_transition = transition;
      impl_->schedule_progress_notified_urgent = urgent;
      impl_->schedule_progress_notified_processor = processor;
      impl_->schedule_progress_notified_running = running;
      impl_->schedule_progress_notified_complete = complete;
      impl_->schedule_progress_sequence.fetch_add(1, std::memory_order_release);
    }
    const bool assets_ready = daw::audio_core::CompleteAssetReaders(active_core,
      impl_->completed_render_epoch.load(std::memory_order_relaxed) + 1);
    impl_->completed_render_epoch.fetch_add(1, std::memory_order_release);
    if (assets_ready) impl_->SignalRealtimeBridge(Impl::kRealtimeAssetReaders);
    // Publish readiness only after the retiring callback's reader epoch and
    // progress fields are visible, including completions below the frame quantum.
    if (latency_completed) {
      impl_->latency_completion_generation.fetch_add(1, std::memory_order_release);
      if (!meaningful) impl_->schedule_progress_sequence.fetch_add(1, std::memory_order_release);
      impl_->SignalRealtimeBridge(Impl::kRealtimeLatencyCompleted | Impl::kRealtimeScheduleProgress);
    } else if (meaningful) impl_->SignalRealtimeBridge(Impl::kRealtimeScheduleProgress);
    if (offset != 0) impl_->split_blocks.fetch_add(1, std::memory_order_relaxed);
    offset += frames;
  }
  impl_->callbacks.fetch_add(1, std::memory_order_relaxed);
  return true;
}

bool AudioHost::ProcessRecordingPlanar(
  const std::span<const float* const> input,
  const std::uint32_t frame_count) {
  const daw_audio_core_handle capture = impl_->recording_capture.load(std::memory_order_acquire);
  if (capture == 0 || input.empty() || input.size() > 64 || frame_count == 0) return false;
  for (const float* plane : input) {
    if (plane == nullptr) return false;
  }
  std::uint32_t offset = 0;
  while (offset < frame_count) {
    const std::uint32_t frames = std::min(
      frame_count - offset,
      static_cast<std::uint32_t>(DAW_AUDIO_RECORDING_CAPTURE_BLOCK_FRAMES));
    std::array<const float*, 64> input_slice{};
    for (std::size_t channel = 0; channel < input.size(); ++channel) input_slice[channel] = input[channel] + offset;
    const std::int64_t block_start_frame = impl_->recording_input_frame.load(std::memory_order_acquire);
    bool recording_status_changed = impl_->ApplyRecordingCommand(block_start_frame);
    if (impl_->recording_started.load(std::memory_order_acquire)) {
      const std::uint32_t recording_channels = impl_->recording_channel_count.load(std::memory_order_acquire);
      const bool monitoring = impl_->recording_monitoring.load(std::memory_order_acquire);
      for (std::uint32_t channel = 0; channel < recording_channels; ++channel) {
        impl_->recording_monitor_planes[channel] = impl_->recording_monitor[channel].data();
      }
      const daw_audio_core_result result = monitoring
        ? daw_audio_recording_capture_process_monitor(
          capture,
          input_slice.data(),
          static_cast<std::uint32_t>(input.size()),
          impl_->recording_monitor_planes.data(),
          recording_channels,
          frames,
          block_start_frame)
        : daw_audio_recording_capture_process(
          capture,
          input_slice.data(),
          static_cast<std::uint32_t>(input.size()),
          frames,
          block_start_frame);
      if (result == DAW_AUDIO_CORE_CAPACITY_EXCEEDED) {
        impl_->recording_started.store(false, std::memory_order_release);
      } else if (result != DAW_AUDIO_CORE_OK) {
        return false;
      }
      recording_status_changed = true;
      if (monitoring) {
        const std::uint64_t write = impl_->recording_monitor_write.load(std::memory_order_relaxed);
        const std::uint64_t read = impl_->recording_monitor_read.load(std::memory_order_acquire);
        if (write - read + frames <= Impl::kRecordingMonitorCapacity) {
          for (std::uint32_t channel = 0; channel < recording_channels; ++channel) {
            for (std::uint32_t frame = 0; frame < frames; ++frame) {
              impl_->recording_monitor_ring[channel][(write + frame) % Impl::kRecordingMonitorCapacity]
                = impl_->recording_monitor[channel][frame];
            }
          }
          impl_->recording_monitor_write.store(write + frames, std::memory_order_release);
        }
      }
    }
    if (recording_status_changed) impl_->SignalRealtimeBridge(Impl::kRealtimeRecordingStatus);
    impl_->recording_input_frame.fetch_add(frames, std::memory_order_release);
    offset += frames;
  }
  return true;
}
// DAW_REALTIME_CALLBACK_REGION_END audio-host

void AudioHost::RecordOutputCallback(
  const std::uint32_t frame_count,
  const std::uint64_t duration_nanoseconds
) noexcept {
  // The meter reads this while stopped too, so it records before the transport gate that guards the diagnostics.
  impl_->cpu_load.Record(frame_count, impl_->config.sample_rate_hz, duration_nanoseconds);
  if (!impl_->applied_transport_running.load(std::memory_order_acquire)
    || frame_count == 0 || duration_nanoseconds == 0) return;
  impl_->callback_frames.store(frame_count, std::memory_order_relaxed);
  impl_->callback_timing_count.fetch_add(1, std::memory_order_relaxed);
  auto maximum = impl_->callback_timing_maximum_nanoseconds.load(std::memory_order_relaxed);
  while (duration_nanoseconds > maximum && !impl_->callback_timing_maximum_nanoseconds.compare_exchange_weak(
    maximum, duration_nanoseconds, std::memory_order_relaxed, std::memory_order_relaxed)) {}
  const auto deadline_nanoseconds = impl_->config.sample_rate_hz == 0
    ? 0
    : static_cast<std::uint64_t>(
      static_cast<double>(frame_count) * 1'000'000'000.0
        / static_cast<double>(impl_->config.sample_rate_hz)
    );
  if (deadline_nanoseconds > 0 && duration_nanoseconds > deadline_nanoseconds) {
    impl_->callback_deadline_misses.fetch_add(1, std::memory_order_relaxed);
  }
  impl_->callback_timing_buckets[detail::RealtimeDurationHistogramBucket(duration_nanoseconds)]
    .fetch_add(1, std::memory_order_relaxed);
}

detail::CpuLoadSample AudioHost::TakeCpuLoad() noexcept {
  return impl_->cpu_load.Take();
}

}  // namespace daw::audio_host_macos
