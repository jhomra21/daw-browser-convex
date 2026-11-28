#include "audio_core_internal.h"

namespace {

bool bind_process_transport(Core &core, const daw_audio_core_process_block &block, uint8_t *rejected_events) {
  core.parameter_cache_prepared.fill(false);
  if (block.parameter_block_count > DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETER_BLOCKS
    || block.event_count > DAW_AUDIO_CORE_MAX_PROCESSOR_EVENTS
    || block.instrument_event_count > DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS
    || (block.parameter_block_count > 0 && block.parameter_blocks == nullptr)
    || (block.event_count > 0 && block.events == nullptr)
    || (block.instrument_event_count > 0 && block.instrument_events == nullptr)) return false;
  core.active_parameter_blocks.fill(nullptr);
  core.event_starts.fill(0);
  core.event_ends.fill(0);
  core.active_events = nullptr;
  core.active_event_count = 0;
  core.active_instrument_events = nullptr;
  core.active_instrument_event_count = 0;
  core.instrument_event_counts.fill(0);
  if (block.parameter_block_count == 0 && block.event_count == 0 && block.instrument_event_count == 0) return true;
  if (block.graph_revision != (*core.published_graph).revision
    || (block.instrument_event_count > 0 && block.transport_epoch != core.transport.epoch)) return false;
  core.active_events = block.events;
  core.active_event_count = block.event_count;
  for (uint32_t block_index = 0; block_index < block.parameter_block_count; ++block_index) {
    const daw_audio_processor_parameter_block &parameters = block.parameter_blocks[block_index];
    uint32_t processor_index = 0;
    const GraphRevision::Processor *processor = find_processor((*core.published_graph), parameters.processor_instance_id, &processor_index);
    if (processor == nullptr || core.active_parameter_blocks[processor_index] != nullptr
      || parameters.frame_count == 0 || (parameters.frame_count != 1 && parameters.frame_count != block.frame_count)
      || parameters.parameter_count == 0 || parameters.parameter_count > processor->parameter_count
      || parameters.parameter_targets == nullptr || parameters.values == nullptr) return false;
    for (uint32_t parameter = 0; parameter < parameters.parameter_count; ++parameter) {
      const uint32_t target = parameters.parameter_targets[parameter];
      if (!processor_declares_target(*processor, target)) return false;
      for (uint32_t previous = 0; previous < parameter; ++previous) {
        if (parameters.parameter_targets[previous] == target) return false;
      }
      for (uint32_t frame = 0; frame < parameters.frame_count; ++frame) {
        if (!valid_processor_parameter_value(target, parameters.values[parameter * parameters.frame_count + frame])) return false;
      }
    }
    core.active_parameter_blocks[processor_index] = &parameters;
  }
  uint64_t previous_processor = 0;
  uint32_t previous_offset = 0;
  bool has_previous = false;
  for (uint32_t event_index = 0; event_index < block.event_count; ++event_index) {
    const daw_audio_processor_event &event = block.events[event_index];
    uint32_t processor_index = 0;
    const GraphRevision::Processor *processor = find_processor((*core.published_graph), event.processor_instance_id, &processor_index);
    const daw_audio_graph_node_descriptor *mixer = processor == nullptr
      ? find_mixer_node((*core.published_graph), event.processor_instance_id)
      : nullptr;
    if ((processor == nullptr && mixer == nullptr) || event.frame_offset >= block.frame_count
      || (processor != nullptr && (!processor_declares_target(*processor, event.parameter_target)
        || !valid_processor_parameter_value(event.parameter_target, event.value)))
      || (mixer != nullptr && !valid_mixer_parameter_value(event.parameter_target, event.value))
      || (has_previous && (event.processor_instance_id < previous_processor
        || (event.processor_instance_id == previous_processor && event.frame_offset < previous_offset)))) return false;
    if (processor != nullptr && (!has_previous || event.processor_instance_id != previous_processor)) {
      core.event_starts[processor_index] = event_index;
      if (has_previous && find_processor((*core.published_graph), previous_processor, &processor_index) != nullptr) {
        uint32_t previous_index = 0;
        find_processor((*core.published_graph), previous_processor, &previous_index);
        core.event_ends[previous_index] = event_index;
      }
    }
    previous_processor = event.processor_instance_id;
    previous_offset = event.frame_offset;
    has_previous = true;
  }
  if (has_previous && find_processor((*core.published_graph), previous_processor, &previous_offset) != nullptr) {
    uint32_t previous_index = 0;
    find_processor((*core.published_graph), previous_processor, &previous_index);
    core.event_ends[previous_index] = block.event_count;
  }
  // Validation applies events to a scratch copy of only the nodes they touch.
#if defined(DAW_AUDIO_CORE_USE_PERSISTENT_VALIDATION_SCRATCH)
  auto &proposed_instruments = core.proposed_instruments;
#else
  std::array<InstrumentNodeState, kMaximumLiveNodes> proposed_instruments;
#endif
  for (auto &indices : core.instrument_event_indices) indices.fill(0);
  core.instrument_event_counts.fill(0);
  uint32_t previous_instrument_offset = 0;
  uint64_t previous_instrument_sequence = 0;
  bool has_previous_instrument = false;
  for (uint32_t event_index = 0; event_index < block.instrument_event_count; ++event_index) {
    core.rejected_instrument_event_index = event_index;
    const daw_audio_instrument_event &event = block.instrument_events[event_index];
#if defined(DAW_AUDIO_CORE_TEST_INSTRUMENT_REJECTION)
    // Only the host test's private core is built with this fault-injection hook.
    if (daw_audio_core_test_reject_instrument_event(event_index)) {
      if (rejected_events == nullptr) return false;
      rejected_events[event_index] = 1;
      continue;
    }
#endif
    const bool native_event = is_native_instrument_event(event.type);
    const std::uint32_t portable_type = portable_instrument_event_type(event.type);
    const int32_t node_index = graph_node_index((*core.published_graph), event.node_id);
    if (node_index < 0 || (*core.published_graph).nodes[static_cast<uint32_t>(node_index)].kind != DAW_AUDIO_GRAPH_NODE_INSTRUMENT
      || event.epoch != core.transport.epoch || event.sequence == 0 || event.frame_offset >= block.frame_count
      || (!native_event && (portable_type < DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON
        || portable_type > DAW_AUDIO_INSTRUMENT_EVENT_PARAMETER))
      || event.channel > 15 || event.note > 127 || !std::isfinite(event.value)
      || ((portable_type == DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON || is_native_live_note_on(event.type))
        && (event.note_id == 0 || event.value < 0.0F || event.value > 1.0F))
      || ((portable_type == DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF || is_native_live_note_off(event.type))
        && event.note_id == 0)
      || ((portable_type == DAW_AUDIO_INSTRUMENT_EVENT_SUSTAIN || portable_type == DAW_AUDIO_INSTRUMENT_EVENT_EXPRESSION)
        && (event.value < 0.0F || event.value > 1.0F))
      || (portable_type == DAW_AUDIO_INSTRUMENT_EVENT_PARAMETER
        && !instrument_declares_target((*core.published_graph).nodes[static_cast<uint32_t>(node_index)].instrument, event.note))
      || (has_previous_instrument && (event.frame_offset < previous_instrument_offset
        || event.sequence <= previous_instrument_sequence))) {
      if (rejected_events == nullptr) return false;
      rejected_events[event_index] = 1;
      continue;
    }
    const uint32_t index = static_cast<uint32_t>(node_index);
    if (core.instrument_event_counts[index] == 0) proposed_instruments[index] = published_instrument(core, index);
    bool accepted = true;
    if (is_native_transport_release(event.type)) {
      release_instrument_state(proposed_instruments[index]);
    } else if (is_native_all_sound_off(event.type)) {
      clear_instrument_state(proposed_instruments[index]);
    } else if ((*core.published_graph).nodes[index].instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_SYNTH) {
      accepted = apply_instrument_event(proposed_instruments[index], (*core.published_graph).nodes[index].instrument, event);
    } else if ((*core.published_graph).nodes[index].instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) {
      accepted = apply_granular_instrument_event(proposed_instruments[index], event);
    } else {
      accepted = apply_sample_instrument_event(core, proposed_instruments[index], (*core.published_graph).nodes[index].instrument, event);
    }
    if (!accepted) {
      if (rejected_events == nullptr) return false;
      rejected_events[event_index] = 1;
      continue;
    }
    const uint16_t count = core.instrument_event_counts[index];
    if (count >= DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS) return false;
    core.instrument_event_indices[index][count] = static_cast<uint16_t>(event_index);
    core.instrument_event_counts[index] = static_cast<uint16_t>(count + 1);
    previous_instrument_offset = event.frame_offset;
    previous_instrument_sequence = event.sequence;
    has_previous_instrument = true;
  }
  core.rejected_instrument_event_index = UINT32_MAX;
  core.active_instrument_events = block.instrument_events;
  core.active_instrument_event_count = block.instrument_event_count;
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  for (uint32_t node_index = 0; node_index < (*core.published_graph).node_count; ++node_index) {
    const uint16_t count = core.instrument_event_counts[node_index];
    for (uint16_t event_index = 0; event_index < count; ++event_index) {
      core.native_instrument_events[node_index][event_index] =
        core.active_instrument_events[core.instrument_event_indices[node_index][event_index]];
    }
  }
#endif
  return true;
}
}  // namespace


extern "C" daw_audio_core_result daw_audio_core_stage_processor_state_patch(
  daw_audio_core_handle core_handle,
  const daw_audio_processor_state_patch *patch) {
  Core *core = to_core(core_handle);
  if (core == nullptr || patch == nullptr || patch->graph_revision == 0
    || patch->node_id == 0 || patch->instance_id == 0 || patch->kind == 0
    || patch->state == nullptr || patch->state_size > DAW_AUDIO_CORE_MAX_PROCESSOR_STATE_BYTES
    || patch->parameter_count > DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS
    || (patch->parameter_count > 0 && patch->parameter_targets == nullptr)
    || patch->bypassed > 1 || !valid_graph_layout(patch->input_layout)
    || !valid_graph_layout(patch->output_layout)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (core->published_revision != patch->graph_revision) return DAW_AUDIO_CORE_STALE_REVISION;
  Core::StagedProcessorStatePatch *slot = nullptr;
  for (uint32_t index = 0; index < 2; ++index) {
    auto &candidate = core->staged_processor_state_patches[index];
    uint32_t expected = 0;
    if (candidate.state.compare_exchange_strong(expected, 1, std::memory_order_acquire, std::memory_order_relaxed)) {
      slot = &candidate;
      break;
    }
  }
  if (slot == nullptr) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  const GraphRevision::Processor *current = nullptr;
  for (uint32_t index = 0; index < (*core->published_graph).processor_count; ++index) {
    const auto &candidate = (*core->published_graph).processors[index];
    if (candidate.node_id == patch->node_id && candidate.instance_id == patch->instance_id) {
      current = &candidate;
      break;
    }
  }
  if (current == nullptr || current->kind != patch->kind
    || current->state_size != patch->state_size
    || current->bypassed != patch->bypassed
    || current->input_layout != patch->input_layout
    || current->output_layout != patch->output_layout
    || current->latency_frames != patch->latency_frames
    || current->parameter_count != patch->parameter_count) {
    slot->state.store(0, std::memory_order_release);
    return DAW_AUDIO_CORE_STALE_REVISION;
  }
  for (uint32_t index = 0; index < patch->parameter_count; ++index) {
    if (!processor_declares_target(*current, patch->parameter_targets[index])) {
      slot->state.store(0, std::memory_order_release);
      return DAW_AUDIO_CORE_STALE_REVISION;
    }
  }
  const daw_audio_processor_descriptor descriptor{
    .node_id = patch->node_id,
    .instance_id = patch->instance_id,
    .kind = patch->kind,
    .state_version = patch->state_version,
    .state_size = patch->state_size,
    .bypassed = patch->bypassed,
    .input_layout = patch->input_layout,
    .output_layout = patch->output_layout,
    .latency_frames = patch->latency_frames,
    .tail_frames = patch->tail_frames,
    .parameter_count = patch->parameter_count,
    .parameter_targets = patch->parameter_targets,
    .state = patch->state,
  };
  GraphRevision::Processor staged{};
  staged.node_id = current->node_id;
  staged.node_index = current->node_index;
  staged.instance_id = current->instance_id;
  staged.kind = current->kind;
  staged.bypassed = current->bypassed;
  staged.input_layout = current->input_layout;
  staged.output_layout = current->output_layout;
  staged.latency_frames = current->latency_frames;
  staged.tail_frames = patch->tail_frames;
  staged.parameter_count = current->parameter_count;
  staged.parameter_targets = current->parameter_targets;
  staged.control_slot = current->control_slot;
  staged.history_slot = current->history_slot;
  staged.delay_slot = current->delay_slot;
  staged.reverb_slot = current->reverb_slot;
  staged.spectral_slot = current->spectral_slot;
  staged.state_size = patch->state_size;
  for (uint32_t index = 0; index < patch->state_size; ++index) staged.state[index] = patch->state[index];
  if (!decode_processor_state(descriptor, &staged)) {
    slot->state.store(0, std::memory_order_release);
    return DAW_AUDIO_CORE_PROCESSOR_STATE_INVALID;
  }
  slot->processor = staged;
  slot->graph_revision = patch->graph_revision;
  slot->state.store(2, std::memory_order_release);
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_apply_staged_processor_state_patch(
  daw_audio_core_handle core_handle) {
  Core *core = to_core(core_handle);
  if (core == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  Core::StagedProcessorStatePatch *slot = nullptr;
  for (uint32_t index = 0; index < 2; ++index) {
    auto &candidate = core->staged_processor_state_patches[index];
    uint32_t expected = 2;
    if (candidate.state.compare_exchange_strong(expected, 3, std::memory_order_acquire, std::memory_order_relaxed)) {
      slot = &candidate;
      break;
    }
  }
  if (slot == nullptr) return DAW_AUDIO_CORE_NO_DATA;
  const auto &staged = slot->processor;
  daw_audio_core_result result = DAW_AUDIO_CORE_STALE_REVISION;
  if (staged.node_id == 0 || staged.instance_id == 0
    || slot->graph_revision == 0
    || slot->graph_revision != core->published_revision
    || (*core->published_graph).revision != core->published_revision) {
    slot->state.store(0, std::memory_order_release);
    return result;
  }
  for (uint32_t index = 0; index < (*core->published_graph).processor_count; ++index) {
    auto &current = (*core->published_graph).processors[index];
    if (current.node_id == staged.node_id && current.instance_id == staged.instance_id) {
      if (current.kind != staged.kind || current.state_size != staged.state_size) {
        break;
      }
      current.state_size = staged.state_size;
      current.tail_frames = staged.tail_frames;
      current.state = staged.state;
      current.utility = staged.utility;
      current.saturator = staged.saturator;
      current.eq = staged.eq;
      current.delay_modulation = staged.delay_modulation;
      current.phaser = staged.phaser;
      current.amplitude_modulation = staged.amplitude_modulation;
      current.ensemble = staged.ensemble;
      current.gate = staged.gate;
      current.compressor = staged.compressor;
      current.limiter = staged.limiter;
      current.delay = staged.delay;
      current.reverb = staged.reverb;
      current.spectral = staged.spectral;
      current.autofilter = staged.autofilter;
      current.lofi = staged.lofi;
      core->processor_overrides[current.history_slot].count = 0;
      result = DAW_AUDIO_CORE_OK;
      break;
    }
  }
  slot->state.store(0, std::memory_order_release);
  return result;
}

extern "C" daw_audio_core_result daw_audio_core_cancel_staged_processor_state_patch(
  daw_audio_core_handle core_handle) {
  Core *core = to_core(core_handle);
  if (core == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  for (uint32_t index = 0; index < 2; ++index) {
    auto &slot = core->staged_processor_state_patches[index];
    uint32_t expected = 2;
    if (slot.state.compare_exchange_strong(expected, 0, std::memory_order_acq_rel, std::memory_order_acquire)) {
      return DAW_AUDIO_CORE_OK;
    }
  }
  return DAW_AUDIO_CORE_NO_DATA;
}

extern "C" daw_audio_core_result daw_audio_core_configure_utility(
  daw_audio_core_handle core_handle,
  const daw_audio_utility_state *state) {
  Core *core = to_core(core_handle);
  if (core == nullptr || state == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (!valid_utility_state(*state)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  core->utility = *state;
  core->utility_configured = true;
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_validate_instrument_target(
  daw_audio_core_handle core_handle,
  const daw_audio_instrument_event *event) {
  const Core *core = to_core(core_handle);
  if (core == nullptr || event == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  const auto &graph = *core->published_graph;
  const int32_t index = graph_node_index(graph, event->node_id);
  if (index < 0 || graph.nodes[static_cast<uint32_t>(index)].kind != DAW_AUDIO_GRAPH_NODE_INSTRUMENT) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  if (event->type != DAW_AUDIO_INSTRUMENT_EVENT_PARAMETER) return DAW_AUDIO_CORE_OK;
  const auto &descriptor = graph.nodes[static_cast<uint32_t>(index)].instrument;
  // Use the same setter as render validation, on local scalar configuration,
  // never read/copy the concurrently changing instrument runtime.
  daw_audio_synth_state candidate{};
  return descriptor.kind == DAW_AUDIO_INSTRUMENT_KIND_SYNTH
    && instrument_declares_target(descriptor, event->note)
    && set_synth_parameter(candidate, event->note, event->value)
      ? DAW_AUDIO_CORE_OK : DAW_AUDIO_CORE_INVALID_ARGUMENT;
}

extern "C" uint32_t daw_audio_core_rejected_instrument_event_index(
  daw_audio_core_handle core_handle) {
  const Core *core = to_core(core_handle);
  return core == nullptr ? UINT32_MAX : core->rejected_instrument_event_index;
}
namespace {

static daw_audio_core_result process_block(
  daw_audio_core_handle core_handle,
  const daw_audio_core_process_block *block,
  uint8_t *rejected_events) {
  Core *core = to_core(core_handle);
  if (core == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  core->rejected_instrument_event_index = UINT32_MAX;
  if (rejected_events != nullptr) std::fill_n(rejected_events, DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS, uint8_t{0});
  if (block == nullptr || block->outputs == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  // Every call counts as one render epoch once it returns, whatever it rendered.
  const struct EpochGuard {
    Core &core;
    ~EpochGuard() {
      core.render_epoch.fetch_add(1, std::memory_order_release);
      // Publish completion after the reader epoch, not from inside graph render.
      // Control may reclaim a descriptor as soon as it acquires this snapshot.
      const auto &graph = *core.published_graph;
      bool stages_complete = true;
      for (uint32_t index = 0; index < graph.spectral_predecessor_count; ++index) {
        const auto &processor = graph.spectral_predecessors[index];
        const auto &slot = core.processor_slots[processor.history_slot];
        if (slot.state.load(std::memory_order_relaxed) == kSlotActive
          && slot.generation.load(std::memory_order_relaxed) == processor.generation) stages_complete = false;
      }
      if (stages_complete && core.graph_write_frame >= graph.latency_end + core.latency_publication_shift)
        core.latency_completed_revision.store(graph.revision, std::memory_order_release);
    }
  } epoch{*core};
  if (!valid_abi(block->abi_version)) return DAW_AUDIO_CORE_UNSUPPORTED_VERSION;
  if (core->published_revision == 0) return DAW_AUDIO_CORE_NOT_PREPARED;
  if (block->frame_count == 0 || block->frame_count > core->config.max_frames_per_block
    || block->channel_count > core->config.max_channels
    || block->input_bus_count > kMaximumChannels) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  if (block->parameter_block_count > DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETER_BLOCKS
    || block->event_count > DAW_AUDIO_CORE_MAX_PROCESSOR_EVENTS
    || block->instrument_event_count > DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  if (block->instrument_event_count > 0 && block->transport_epoch != core->transport.epoch) return DAW_AUDIO_CORE_STALE_REVISION;
  for (uint32_t channel = 0; channel < block->channel_count; ++channel) {
    if (block->outputs[channel] == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  if (!bind_process_transport(*core, *block, rejected_events)) {
    return (block->parameter_block_count > 0 || block->event_count > 0 || block->instrument_event_count > 0)
      && block->graph_revision != (*core->published_graph).revision ? DAW_AUDIO_CORE_STALE_REVISION : DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  if ((*core->published_graph).revision == core->published_revision) {
    prepare_active_source_ranges(*core, &(*core->published_graph));
    process_graph(*core, *block);
    latch_processor_parameter_values(*core);
    if (core->transport.running != 0) core->transport.frame += static_cast<int64_t>(block->frame_count);
    return DAW_AUDIO_CORE_OK;
  }
  prepare_active_source_ranges(*core, nullptr);
  for (uint32_t channel = 0; channel < block->channel_count; ++channel) {
    float *output = block->outputs[channel];
    for (uint32_t frame = 0; frame < block->frame_count; ++frame) output[frame] = summed_input(*block, channel, frame);
  }
  for (uint32_t frame = 0; frame < block->frame_count; ++frame) {
    render_sample_source_range(*core, core->root_source_range, core->transport.frame + static_cast<int64_t>(frame), &block->outputs[0][frame],
      block->channel_count > 1 ? &block->outputs[1][frame] : &block->outputs[0][frame]);
  }
  if (core->utility_configured && block->channel_count > 0) {
    float *left_output = block->outputs[0];
    float *right_output = block->channel_count > 1 ? block->outputs[1] : nullptr;
    for (uint32_t frame = 0; frame < block->frame_count; ++frame) {
      const float dry_left = left_output[frame];
      const float dry_right = right_output == nullptr ? dry_left : right_output[frame];
      float left = 0.0F;
      float right = 0.0F;
      process_utility_frame(
        *core, nullptr, core->utility_history, frame, dry_left, dry_right, &left, &right);
      left_output[frame] = left;
      if (right_output != nullptr) right_output[frame] = right;
    }
  }
  if (core->transport.running != 0) core->transport.frame += static_cast<int64_t>(block->frame_count);
  return DAW_AUDIO_CORE_OK;
}
}  // namespace


extern "C" daw_audio_core_result daw_audio_core_process(
  daw_audio_core_handle core_handle,
  const daw_audio_core_process_block *block) {
  return process_block(core_handle, block, nullptr);
}

extern "C" daw_audio_core_result daw_audio_core_process_valid_instrument_events(
  daw_audio_core_handle core_handle,
  const daw_audio_core_process_block *block,
  uint8_t *rejected_events) {
  if (rejected_events == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  return process_block(core_handle, block, rejected_events);
}

extern "C" daw_audio_core_result daw_audio_core_set_transport(
  daw_audio_core_handle core_handle,
  const daw_audio_transport_state *state) {
  Core *core = to_core(core_handle);
  if (core == nullptr || state == nullptr || !valid_transport_state(*state)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (state->epoch < core->transport.epoch) return DAW_AUDIO_CORE_STALE_REVISION;
  if (state->epoch != core->transport.epoch) {
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
    if (core->transport.running == 0 && state->running == 0 && state->frame != core->transport.frame) {
      // A stopped seek starts a fresh input timeline, not a continuation of the
      // previous DC estimate. A running locate primes with running=0 too:
      // require the previous transport to be stopped, preserving its estimate.
      // Keep musical tails and bypass ramps intact.
      const auto clear_dc = [](UtilityHistory &history) {
        history.dc_x1_left = history.dc_x1_right = 0.0F;
        history.dc_y1_left = history.dc_y1_right = 0.0F;
      };
      clear_dc(core->utility_history);
      for (auto &history : core->utility_histories) clear_dc(history);
    }
#endif
    clear_sample_sources(*core);
    release_instrument_voices(*core);
    core->last_event_sequence = 0;
    for (Core::MixerLatch &latch : core->mixer_latches) latch.mask = 0;
  }
  core->transport = *state;
  core->transport_running.store(state->running != 0, std::memory_order_release);
  if (state->running == 0) {
    core->latency_shrunk_revision = core->published_revision;
    core->latency_budget.store(core->published_graph->minimum_latency, std::memory_order_release);
    core->latency_completed_revision.store(core->published_revision, std::memory_order_release);
  }
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_configure_synth(
  daw_audio_core_handle core_handle,
  uint64_t node_id,
  const daw_audio_synth_state *state) {
  Core *core = to_core(core_handle);
  if (core == nullptr || state == nullptr || !valid_synth_state(*state)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  const GraphRevision &graph = configuration_graph(*core);
  const int32_t node_index = graph_node_index(graph, node_id);
  if (node_index < 0 || graph.nodes[static_cast<uint32_t>(node_index)].kind != DAW_AUDIO_GRAPH_NODE_INSTRUMENT) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  const auto index = static_cast<uint32_t>(node_index);
  if (core->prepared_revision != 0) {
    (*core->prepared_instrument_configs)[index].synth = *state;
    return refresh_prepared_node(*core, index);
  }
  (*core->published_instrument_configs)[index].synth = *state;
  set_up_instrument(published_instrument(*core, index), (*core->published_instrument_configs)[index]);
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_configure_sampler(
  daw_audio_core_handle core_handle,
  uint64_t node_id,
  const daw_audio_sampler_state *state,
  const daw_audio_sample_zone *zones) {
  Core *core = to_core(core_handle);
  if (core == nullptr || state == nullptr || (state->zone_count > 0 && zones == nullptr) || !valid_sampler_state(*state)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  const GraphRevision &graph = configuration_graph(*core);
  const int32_t node_index = graph_node_index(graph, node_id);
  if (node_index < 0) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  const daw_audio_graph_node_descriptor &node = graph.nodes[static_cast<uint32_t>(node_index)];
  if (node.kind != DAW_AUDIO_GRAPH_NODE_INSTRUMENT
    || (node.instrument.kind != DAW_AUDIO_INSTRUMENT_KIND_SAMPLER && node.instrument.kind != DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK)) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  for (uint32_t index = 0; index < state->zone_count; ++index) {
    if (!valid_sample_zone(*core, zones[index])) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    if (node.instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK
      && (zones[index].key_low != zones[index].key_high || zones[index].round_robin_group != 0)) {
      return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
  }
  const auto node_slot = static_cast<uint32_t>(node_index);
  auto &configuration = core->prepared_revision != 0
    ? (*core->prepared_instrument_configs)[node_slot] : (*core->published_instrument_configs)[node_slot];
  configuration.sampler = *state;
  for (uint32_t index = 0; index < state->zone_count; ++index) configuration.zones[index] = zones[index];
  for (uint32_t index = state->zone_count; index < configuration.zones.size(); ++index) configuration.zones[index] = {};
  if (core->prepared_revision != 0) return refresh_prepared_node(*core, node_slot);
  InstrumentNodeState &instrument = published_instrument(*core, node_slot);
  set_up_instrument(instrument, configuration);
  instrument.round_robin_cursors.fill(0);
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_configure_granular(
  daw_audio_core_handle core_handle,
  uint64_t node_id,
  const daw_audio_granular_state *state) {
  Core *core = to_core(core_handle);
  if (core == nullptr || state == nullptr || !valid_granular_state(*core, *state)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  const GraphRevision &graph = configuration_graph(*core);
  const int32_t node_index = graph_node_index(graph, node_id);
  if (node_index < 0) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  const daw_audio_graph_node_descriptor &node = graph.nodes[static_cast<uint32_t>(node_index)];
  if (node.kind != DAW_AUDIO_GRAPH_NODE_INSTRUMENT || node.instrument.kind != DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  const auto index = static_cast<uint32_t>(node_index);
  if (core->prepared_revision != 0) {
    (*core->prepared_instrument_configs)[index].granular = *state;
    return refresh_prepared_node(*core, index);
  }
  (*core->published_instrument_configs)[index].granular = *state;
  set_up_instrument(published_instrument(*core, index), (*core->published_instrument_configs)[index]);
  return DAW_AUDIO_CORE_OK;
}
