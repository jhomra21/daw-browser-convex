#include "audio_core_internal.h"

namespace {

bool same_float(float left, float right) {
  return left == right;
}

// The synth and sampler states are packed 4-byte words, so a byte compare is a value compare. A sample zone and the granular
// state open with a 64-bit handle that sits on an 8-byte boundary: they carry padding that the caller leaves as its heap held
// it, so they compare by field.
static_assert(sizeof(daw_audio_synth_state) == 156 && sizeof(daw_audio_sampler_state) == 88);
}  // namespace

namespace daw::audio_core_internal {

bool same_instrument_configuration(
  const daw_audio_graph_node_descriptor &current_node,
  const daw_audio_graph_node_descriptor &next_node,
  const InstrumentConfiguration &current,
  const InstrumentConfiguration &next) {
  if (current_node.instrument.kind != next_node.instrument.kind
    || current_node.instrument.version != next_node.instrument.version
    || current_node.instrument.voice_capacity != next_node.instrument.voice_capacity
    || current_node.instrument.parameter_count != next_node.instrument.parameter_count) return false;
  for (uint32_t index = 0; index < DAW_AUDIO_CORE_MAX_INSTRUMENT_PARAMETERS; ++index) {
    if (current_node.instrument.parameter_targets[index] != next_node.instrument.parameter_targets[index]) return false;
  }
  const InstrumentConfiguration before = discrete_part(current);
  const InstrumentConfiguration after = discrete_part(next);
  switch (next_node.instrument.kind) {
    case DAW_AUDIO_INSTRUMENT_KIND_SYNTH:
      return std::memcmp(&before.synth, &after.synth, sizeof(before.synth)) == 0;
    case DAW_AUDIO_INSTRUMENT_KIND_SAMPLER:
    case DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK:
      return std::memcmp(&before.sampler, &after.sampler, sizeof(before.sampler)) == 0
        && same_zones(before, after);
    case DAW_AUDIO_INSTRUMENT_KIND_GRANULAR:
      return same_granular(before.granular, after.granular);
    default:
      return true;
  }
}

// Whether a processor's slot (history, tails, live overrides) can serve the next
// plan's processor. Bypass is a parameter, not a structure: it is applied by the
// renderer, which ramps it where the DSP defines a ramp, so toggling it never
// replaces the slot.
bool compatible_processor_history(
  const GraphRevision::Processor &current,
  const GraphRevision::Processor &next) {
  if (current.instance_id != next.instance_id
    || current.kind != next.kind
    || current.state_version != next.state_version
    || current.state_size != next.state_size
    || current.input_layout != next.input_layout
    || current.output_layout != next.output_layout) return false;
  switch (next.kind) {
    case DAW_AUDIO_PROCESSOR_KIND_UTILITY:
      return current.utility.dc_block == next.utility.dc_block
        && current.utility.input_mode == next.utility.input_mode
        && current.utility.matrix == next.utility.matrix
        && current.utility.swap == next.utility.swap;
    case DAW_AUDIO_PROCESSOR_KIND_SATURATOR:
      return current.saturator.curve == next.saturator.curve
        && current.saturator.color == next.saturator.color
        && same_float(current.saturator.color_frequency_hz, next.saturator.color_frequency_hz);
    case DAW_AUDIO_PROCESSOR_KIND_EQ:
      if (current.eq.mono != next.eq.mono) return false;
      for (uint32_t band = 0; band < 8; ++band) {
        if (current.eq.bands[band].enabled != next.eq.bands[band].enabled
          || current.eq.bands[band].type != next.eq.bands[band].type) return false;
      }
      return true;
    case DAW_AUDIO_PROCESSOR_KIND_GATE:
      return current.gate.mode == next.gate.mode
        && current.gate.detector == next.gate.detector
        && current.gate.sidechain_enabled == next.gate.sidechain_enabled
        && same_float(current.gate.lookahead_ms, next.gate.lookahead_ms)
        && same_float(current.gate.sidechain_frequency_hz, next.gate.sidechain_frequency_hz)
        && same_float(current.gate.sidechain_q, next.gate.sidechain_q);
    case DAW_AUDIO_PROCESSOR_KIND_COMPRESSOR:
      return current.compressor.auto_release == next.compressor.auto_release
        && current.compressor.detector_mode == next.compressor.detector_mode
        && current.compressor.dynamics_mode == next.compressor.dynamics_mode
        && current.compressor.envelope_curve == next.compressor.envelope_curve
        && current.compressor.sidechain_enabled == next.compressor.sidechain_enabled
        && current.compressor.sidechain_filter_type == next.compressor.sidechain_filter_type
        && same_float(current.compressor.lookahead_ms, next.compressor.lookahead_ms)
        && same_float(current.compressor.sidechain_frequency_hz, next.compressor.sidechain_frequency_hz)
        && same_float(current.compressor.sidechain_q, next.compressor.sidechain_q);
    case DAW_AUDIO_PROCESSOR_KIND_LIMITER:
      return current.limiter.detector_oversampling == next.limiter.detector_oversampling
        && same_float(current.limiter.lookahead_ms, next.limiter.lookahead_ms);
    case DAW_AUDIO_PROCESSOR_KIND_SPECTRAL:
      return current.spectral.fft_size == next.spectral.fft_size
        && current.spectral.overlap == next.spectral.overlap;
    case DAW_AUDIO_PROCESSOR_KIND_AUTOFILTER:
      return current.autofilter.hi_quality == next.autofilter.hi_quality;
    case DAW_AUDIO_PROCESSOR_KIND_LOFI:
      return current.lofi.bit_depth == next.lofi.bit_depth
        && current.lofi.quantization == next.lofi.quantization
        && current.lofi.dither == next.lofi.dither
        && current.lofi.seed == next.lofi.seed;
    default:
      return current.kind == DAW_AUDIO_PROCESSOR_KIND_DELAY
        || current.kind == DAW_AUDIO_PROCESSOR_KIND_REVERB
        || current.kind == DAW_AUDIO_PROCESSOR_KIND_CHORUS
        || current.kind == DAW_AUDIO_PROCESSOR_KIND_FLANGER
        || current.kind == DAW_AUDIO_PROCESSOR_KIND_PHASER
        || current.kind == DAW_AUDIO_PROCESSOR_KIND_TREMOLO
        || current.kind == DAW_AUDIO_PROCESSOR_KIND_AUTOPAN
        || current.kind == DAW_AUDIO_PROCESSOR_KIND_ENSEMBLE;
  }
}
}  // namespace daw::audio_core_internal

namespace {

// Preparation only: immutable instance IDs, no reads of callback-owned
// parameters or DSP histories. Fixed storage also bounds preparation memory.
// A portable core cannot bridge a live FFT-size change: the retained stage-input
// history that does it is native-sized (kSpectralInputFrames). The stage is replaced
// instead, as a removal plus an insertion: the old one fades out as a ghost and the
// new one starts fresh. Native keeps the spectral history across sizes.
bool replaced_by_spectral_size_change(
  const GraphRevision::Processor &current, const GraphRevision::Processor &next) {
#if !defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  return current.kind == DAW_AUDIO_PROCESSOR_KIND_SPECTRAL && next.kind == DAW_AUDIO_PROCESSOR_KIND_SPECTRAL
    && current.spectral.fft_size != next.spectral.fft_size;
#else
  (void)current;
  (void)next;
  return false;
#endif
}
}  // namespace

namespace daw::audio_core_internal {

ProcessorContinuityMap build_processor_continuity_map(
  const GraphRevision &current, const GraphRevision &next) {
  ProcessorContinuityMap map{};
  map.previous.fill(-1);
  map.next.fill(-1);
  std::array<uint16_t, kMaximumLiveProcessors> current_order{};
  std::array<uint16_t, kMaximumLiveProcessors> next_order{};
  for (uint32_t index = 0; index < current.processor_count; ++index)
    current_order[index] = static_cast<uint16_t>(index);
  for (uint32_t index = 0; index < next.processor_count; ++index)
    next_order[index] = static_cast<uint16_t>(index);
  std::sort(current_order.begin(), current_order.begin() + current.processor_count,
    [&](uint16_t left, uint16_t right) {
      return current.processors[left].instance_id < current.processors[right].instance_id;
    });
  std::sort(next_order.begin(), next_order.begin() + next.processor_count,
    [&](uint16_t left, uint16_t right) {
      return next.processors[left].instance_id < next.processors[right].instance_id;
    });
  uint32_t old_position = 0;
  uint32_t new_position = 0;
  while (old_position < current.processor_count && new_position < next.processor_count) {
    const auto old_index = current_order[old_position];
    const auto new_index = next_order[new_position];
    const uint64_t old_id = current.processors[old_index].instance_id;
    const uint64_t new_id = next.processors[new_index].instance_id;
    if (old_id < new_id) ++old_position;
    else if (new_id < old_id) ++new_position;
    else {
      if (!replaced_by_spectral_size_change(current.processors[old_index], next.processors[new_index])) {
        map.previous[new_index] = old_index;
        map.next[old_index] = new_index;
      }
      ++old_position;
      ++new_position;
    }
  }
  return map;
}
}  // namespace daw::audio_core_internal

namespace {

void initialize_processor_slot(Core &core, uint32_t slot) {
  core.utility_histories[slot] = {};
  core.saturator_histories[slot] = {};
  core.eq_histories[slot] = {};
  core.dynamics_histories[slot] = {};
  core.modulation_histories[slot] = {};
  core.autofilter_histories[slot] = {};
  core.lofi_histories[slot] = {};
  core.processor_overrides[slot].count = 0;
}

// Everything the callback writes into a node slot besides the instrument voices
// (which assign_prepared_node resets, along with the configuration, when it hands
// the slot out): the reorder dip, the layout folds, the fader's latched values and
// ramp, and the instruments that were fading out beside this node's. A slot that
// left a plan carries none of it into the next node that takes it.
void initialize_node_slot(Core &core, uint32_t slot) {
  end_node_blend(core, core.node_blends[slot]);
  Core::NodeBlend &blend = core.node_blends[slot];
  blend.partner_generation = 0;
  blend.descriptor = {};
  core.node_dips[slot] = {};
  core.node_folds[slot] = {};
  core.mixer_latches[slot] = {};
  core.mixer_ramps[slot] = {};
}

// Delay, reverb and spectral histories live in small pools that follow the
// lifecycle of the processor slot that owns them.
void free_processor_slot_histories(Core &core, uint32_t slot) {
  for (uint32_t &owner : core.delay_slot_owners) if (owner == slot + 1) owner = 0;
  for (uint32_t &owner : core.reverb_slot_owners) if (owner == slot + 1) owner = 0;
  for (uint32_t &owner : core.spectral_slot_owners) if (owner == slot + 1) owner = 0;
}
}  // namespace

namespace daw::audio_core_internal {

// Control thread only. A retired slot is reusable once the render epoch it
// retired in has completed; the generation moves on before anything can name it again.
void reclaim_retired_slots(Core &core) {
  const uint64_t completed = core.render_epoch.load(std::memory_order_acquire);
  const auto reclaimable = [completed](const RuntimeSlot &slot) {
    return slot.state.load(std::memory_order_acquire) == kSlotRetired
      && completed >= slot.retired_epoch.load(std::memory_order_relaxed);
  };
  const auto free_slot = [&core](RuntimeSlot &slot) {
    slot.generation.fetch_add(1, std::memory_order_relaxed);
    slot.state.store(kSlotFree, std::memory_order_relaxed);
    slot.fade_elapsed.store(0, std::memory_order_relaxed);
    ++core.reclaimed_slots;
  };
  for (uint32_t index = 0; index < kProcessorRuntimeSlots; ++index) {
    RuntimeSlot &slot = core.processor_slots[index];
    if (!reclaimable(slot)) continue;
    free_slot(slot);
    free_processor_slot_histories(core, index);
    initialize_processor_slot(core, index);
    slot.state.store(kSlotInitialized, std::memory_order_release);
  }
  for (uint32_t index = 0; index < kNodeRuntimeSlots; ++index) {
    RuntimeSlot &slot = core.node_slots[index];
    if (!reclaimable(slot)) continue;
    free_slot(slot);
    initialize_node_slot(core, index);
    slot.state.store(kSlotInitialized, std::memory_order_release);
  }
}

// Rollback of an unpublished plan: its fresh slots go back, untouched, to initialized.
// Slots the plan shares with the published plan (or ghosts) are active and stay put.
void release_prepared_runtime(Core &core) {
  if (!core.prepared_runtime_held) return;
  const GraphRevision &plan = *core.prepared_graph;
  for (uint32_t index = 0; index < plan.processor_count; ++index) {
    const auto &processor = plan.processors[index];
    RuntimeSlot &slot = core.processor_slots[processor.history_slot];
    if (slot.state.load(std::memory_order_relaxed) != kSlotPrepared
      || slot.generation.load(std::memory_order_relaxed) != processor.generation) continue;
    free_processor_slot_histories(core, processor.history_slot);
    slot.state.store(kSlotInitialized, std::memory_order_release);
  }
  for (uint32_t index = 0; index < plan.total_node_count(); ++index) {
    RuntimeSlot &slot = core.node_slots[plan.node_slots[index]];
    if (slot.state.load(std::memory_order_relaxed) == kSlotPrepared
      && slot.generation.load(std::memory_order_relaxed) == plan.node_generations[index]) {
      slot.state.store(kSlotInitialized, std::memory_order_release);
    }
  }
  core.prepared_runtime_held = false;
}

// Entries the new plan drops are kept as ghosts so they can fade out instead of
// being cut. A deleted node only needs to survive if it still feeds something
// that remains. A ghost is built only from what the published plan fixed at
// prepare time; the callback-owned parameter overrides stay in the runtime slot
// the ghost shares. Running out of transition capacity, a deletion that has no dry
// path to fade to, and fading entries that would form a cycle are failed prepares
// (CAPACITY_EXCEEDED, GRAPH_COMPATIBILITY_REJECTED): none of them ever produces a
// plan that cuts a deletion or resets what the edit did not touch. A deletion that
// changes latency moves the read heads (prepare_latency_heads), as on every host.
daw_audio_core_result append_deletion_ghosts(
  Core &core, const GraphRevision &current, GraphRevision &next,
  const ProcessorContinuityMap &processors) {
  const uint32_t old_nodes = current.total_node_count();
  std::array<int32_t, kMaximumGraphNodes> node_to_next{};
  std::array<bool, kMaximumGraphNodes> absent{};
  std::array<bool, kMaximumGraphNodes> needed{};
  node_to_next.fill(-1);
  for (uint32_t index = 0; index < old_nodes; ++index) {
    if (index < current.node_count) {
      node_to_next[index] = graph_node_index(next, current.nodes[index].id);
      absent[index] = node_to_next[index] < 0;
    } else {
      // A same-ID live node is a different incarnation. Keep the old ghost's
      // slot/generation and its routes until its callback-owned fade completes.
      absent[index] = core.node_slots[current.node_slots[index]].state.load(std::memory_order_acquire) == kSlotActive;
    }
  }
  std::array<uint32_t, kMaximumGraphNodes> position{};
  for (uint32_t order = 0; order < old_nodes; ++order) position[current.process_order[order]] = order;
  std::array<uint16_t, kMaximumGraphEdges> by_source{};
  const uint32_t old_edges = current.total_edge_count();
  for (uint32_t index = 0; index < old_edges; ++index) by_source[index] = static_cast<uint16_t>(index);
  std::sort(by_source.begin(), by_source.begin() + old_edges, [&](uint16_t left, uint16_t right) {
    return position[current.edge_source_indices[left]] > position[current.edge_source_indices[right]];
  });
  // A fading processor still being controlled by a key keeps its source alive too;
  // a key whose processor already finished fading is not worth a transition node.
  const auto controlled_processor_alive = [&](uint32_t edge_index) {
    if (current.edges[edge_index].sidechain == 0) return true;
    const uint32_t target = current.edge_target_processors[edge_index];
    return target < current.processor_count
      || core.processor_slots[current.processors[target].history_slot].state.load(std::memory_order_acquire) == kSlotActive;
  };
  for (uint32_t order = 0; order < old_edges; ++order) {
    const uint32_t index = by_source[order];
    const uint32_t from = current.edge_source_indices[index];
    const uint32_t to = current.edge_target_indices[index];
    if (absent[from] && controlled_processor_alive(index)
      && (node_to_next[to] >= 0 || (absent[to] && needed[to]))) needed[from] = true;
  }
  const auto same_route = [](const daw_audio_graph_edge_descriptor &left, const daw_audio_graph_edge_descriptor &right) {
    return left.from_node_id == right.from_node_id && left.to_node_id == right.to_node_id
      && left.sidechain == right.sidechain
      && (left.sidechain != 0 ? left.target_processor_id == right.target_processor_id : left.tap == right.tap);
  };
  // A route that joined against a fading node is still joining when the next edit
  // arrives before that fade is over: the node outlives the edit, and the route (or
  // the fading copy of it) keeps the join it had.
  for (uint32_t edge = 0; edge < old_edges; ++edge) {
    const uint32_t join = current.edge_join_nodes[edge];
    if (join != 0 && absent[join - 1]) needed[join - 1] = true;
  }
  uint32_t ghost_nodes = 0;
  for (uint32_t index = 0; index < old_nodes; ++index) {
    if (!absent[index] || !needed[index]) continue;
    if (ghost_nodes >= kMaximumGhostNodes) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    const uint32_t ghost_index = next.node_count + ghost_nodes++;
    node_to_next[index] = static_cast<int32_t>(ghost_index);
    next.nodes[ghost_index] = current.nodes[index];
    next.node_slots[ghost_index] = current.node_slots[index];
    next.node_generations[ghost_index] = current.node_generations[index];
    next.tap_history_slots[ghost_index] = current.tap_history_slots[index];
  }
  const auto inherit_join = [&](uint32_t edge, uint32_t old) {
    const uint32_t join = current.edge_join_nodes[old];
    if (join != 0 && node_to_next[join - 1] >= static_cast<int32_t>(next.node_count)) {
      next.edge_join_nodes[edge] = static_cast<uint16_t>(node_to_next[join - 1] + 1);
    }
  };
  uint32_t ghost_edges = 0;
  const auto inherit_reader = [&](uint32_t edge, uint32_t old) {
    const uint32_t delay = core.latency_budget.load(std::memory_order_acquire) == current.latency_budget
      ? current.read_heads[old].delay : current.read_heads[old].stopped_delay;
    next.edges[edge].pdc_delay_frames = delay;
    next.read_heads[edge] = {.previous_delay = delay, .delay = delay, .stopped_delay = delay};
  };
  for (uint32_t order = 0; order < old_edges; ++order) {
    const uint32_t index = by_source[order];
    if (current.edges[index].sidechain != 0) continue;
    const int32_t from = node_to_next[current.edge_source_indices[index]];
    const int32_t to = node_to_next[current.edge_target_indices[index]];
    const bool from_ghost = from >= static_cast<int32_t>(next.node_count);
    const bool to_ghost = to >= static_cast<int32_t>(next.node_count);
    if (from < 0 || to < 0 || !(from_ghost || to_ghost)) continue;
    if (ghost_edges >= kMaximumGhostEdges) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    const uint32_t ghost_index = next.edge_count + ghost_edges++;
    next.edges[ghost_index] = current.edges[index];
    next.edge_previous[ghost_index] = static_cast<uint16_t>(index + 1u);
    inherit_reader(ghost_index, index);
    next.edge_source_indices[ghost_index] = static_cast<uint16_t>(from);
    next.edge_target_indices[ghost_index] = static_cast<uint16_t>(to);
    inherit_join(ghost_index, index);
  }
  std::array<uint32_t, kMaximumGraphNodes> chain_lengths{};
  for (uint32_t index = 0; index < next.processor_count; ++index) ++chain_lengths[next.processors[index].node_index];
  // Where each processor of the published plan stands in this one, -1 when it is gone.
  std::array<int32_t, kMaximumGraphProcessors> processor_to_next{};
  processor_to_next.fill(-1);
  uint32_t ghost_processors = 0;
  // Walk each old chain in order so a ghost can name the processor it followed.
  for (uint32_t old_node = 0; old_node < old_nodes; ++old_node) {
    const int32_t node = node_to_next[old_node];
    if (node < 0) continue;
    const GraphRevision::Range chain = current.processor_ranges[old_node];
    int32_t anchor = -1;
    for (uint32_t link = chain.start; link < static_cast<uint32_t>(chain.start) + chain.count; ++link) {
      const uint32_t index = current.processor_indices[link];
      const auto &old = current.processors[index];
      if (index < current.processor_count) {
        const int32_t kept = processors.next[index];
        if (kept >= 0 && next.processors[static_cast<uint32_t>(kept)].kind == old.kind) {
          processor_to_next[index] = kept;
          if (next.processors[static_cast<uint32_t>(kept)].node_index == node) anchor = kept;
          continue;
        }
      } else if (core.processor_slots[old.history_slot].state.load(std::memory_order_acquire) != kSlotActive) {
        continue;
      }
      // A survivor's crossfade back to the dry signal needs a stage that neither
      // delays nor changes layout; otherwise the deletion cannot be faded.
      if (node < static_cast<int32_t>(next.node_count)) {
        if (old.input_layout != old.output_layout
          || old.input_layout != next.nodes[static_cast<uint32_t>(node)].output_layout) {
          return DAW_AUDIO_CORE_GRAPH_COMPATIBILITY_REJECTED;
        }
      }
      if (ghost_processors >= kMaximumGhostProcessors
        || ++chain_lengths[static_cast<uint32_t>(node)] > DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE * 2u) {
        return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
      }
      const int32_t ghost_index = static_cast<int32_t>(next.processor_count + ghost_processors++);
      auto &ghost = next.processors[static_cast<uint32_t>(ghost_index)];
      ghost = old;
      ghost.ghost = true;
      // A stage already fading on its own clock keeps it when its node is deleted
      // too; the node's envelope then multiplies the rest of that fade.
      ghost.detached = old.detached || node < static_cast<int32_t>(next.node_count);
      ghost.node_index = static_cast<uint16_t>(node);
      ghost.node_id = next.nodes[static_cast<uint32_t>(node)].id;
      ghost.control_slot = static_cast<uint32_t>(ghost_index);
      ghost.chain_anchor = anchor;
      processor_to_next[index] = ghost_index;
      anchor = ghost_index;
    }
  }
  for (uint32_t index = 0; index < current.total_processor_count(); ++index) {
    next.processor_remap[index] = static_cast<int16_t>(processor_to_next[index]);
  }
  // A key keeps feeding a processor that fades, and a key that fades keeps feeding
  // the processor it controlled; an edge between two surviving entries is the
  // request's own business.
  for (uint32_t index = 0; index < old_edges; ++index) {
    if (current.edges[index].sidechain == 0) continue;
    const int32_t from = node_to_next[current.edge_source_indices[index]];
    const int32_t to = node_to_next[current.edge_target_indices[index]];
    const int32_t target = processor_to_next[current.edge_target_processors[index]];
    if (from < 0 || to < 0 || target < 0) continue;
    if (from < static_cast<int32_t>(next.node_count) && target < static_cast<int32_t>(next.processor_count)) continue;
    if (ghost_edges >= kMaximumGhostEdges) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    const uint32_t ghost_index = next.edge_count + ghost_edges++;
    next.edges[ghost_index] = current.edges[index];
    next.edge_previous[ghost_index] = static_cast<uint16_t>(index + 1u);
    inherit_reader(ghost_index, index);
    next.edge_source_indices[ghost_index] = static_cast<uint16_t>(from);
    next.edge_target_indices[ghost_index] = static_cast<uint16_t>(to);
    next.edge_target_processors[ghost_index] = static_cast<uint16_t>(target);
    inherit_join(ghost_index, index);
  }
  // Routes between surviving nodes are not cut or started either. A deleted one
  // keeps carrying its signal through a transition node that fades out; a new one
  // from a source that already sounds enters against the fade-out of the deleted
  // node it replaces (ungrouping), or else against a fade-in clock. Either way the
  // routes involved never sum to more than one route's worth.
  const auto transition_node = [&](uint32_t layout) -> int32_t {
    if (ghost_nodes >= kMaximumGhostNodes) return -1;
    const int32_t slot = acquire_runtime_slot(core.node_slots);
    if (slot < 0) return -1;
    core.prepared_runtime_held = true;
    const uint32_t index = next.node_count + ghost_nodes++;
    next.ghost_node_count = ghost_nodes;
    next.nodes[index] = {};
    next.nodes[index].id = kTransitionNodeId | index;
    next.nodes[index].kind = DAW_AUDIO_GRAPH_NODE_MIXER;
    next.nodes[index].input_layout = layout;
    next.nodes[index].output_layout = layout;
    next.node_slots[index] = static_cast<uint16_t>(slot);
    next.node_generations[index] = core.node_slots[static_cast<uint32_t>(slot)].generation.load(std::memory_order_relaxed);
    return static_cast<int32_t>(index);
  };
  for (uint32_t index = 0; index < current.edge_count; ++index) {
    const daw_audio_graph_edge_descriptor &old = current.edges[index];
    const int32_t from = node_to_next[current.edge_source_indices[index]];
    const int32_t to = node_to_next[current.edge_target_indices[index]];
    if (from < 0 || to < 0 || from >= static_cast<int32_t>(next.node_count)
      || to >= static_cast<int32_t>(next.node_count)) continue;
    const int32_t target = old.sidechain != 0 ? processor_to_next[current.edge_target_processors[index]] : -1;
    if (old.sidechain != 0 && (target < 0 || target >= static_cast<int32_t>(next.processor_count))) continue;
    bool kept = false;
    for (uint32_t other = 0; other < next.edge_count && !kept; ++other) kept = same_route(old, next.edges[other]);
    if (kept) continue;
    const int32_t carrier = transition_node(next.nodes[static_cast<uint32_t>(from)].output_layout);
    if (carrier < 0 || ghost_edges + 2 > kMaximumGhostEdges) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    const uint64_t carrier_id = next.nodes[static_cast<uint32_t>(carrier)].id;
    const uint32_t entering = next.edge_count + ghost_edges++;
    next.edges[entering] = {};
    next.edges[entering].id = old.id;
    next.edges[entering].from_node_id = old.from_node_id;
    next.edges[entering].to_node_id = carrier_id;
    next.edges[entering].gain = old.gain;
    next.edges[entering].tap = old.tap;
    next.edge_previous[entering] = static_cast<uint16_t>(index + 1u);
    inherit_reader(entering, index);
    next.edge_source_indices[entering] = static_cast<uint16_t>(from);
    next.edge_target_indices[entering] = static_cast<uint16_t>(carrier);
    const uint32_t leaving = next.edge_count + ghost_edges++;
    next.edges[leaving] = {};
    next.edges[leaving].id = old.id;
    next.edges[leaving].from_node_id = carrier_id;
    next.edges[leaving].to_node_id = old.to_node_id;
    next.edges[leaving].target_processor_id = old.target_processor_id;
    next.edges[leaving].gain = 1.0F;
    next.edges[leaving].tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER;
    next.edges[leaving].sidechain = old.sidechain;
    next.edge_source_indices[leaving] = static_cast<uint16_t>(carrier);
    next.edge_target_indices[leaving] = static_cast<uint16_t>(to);
    if (old.sidechain != 0) next.edge_target_processors[leaving] = static_cast<uint16_t>(target);
  }
  int32_t clock = -1;
  for (uint32_t edge = 0; edge < next.edge_count; ++edge) {
    const daw_audio_graph_edge_descriptor &added = next.edges[edge];
    int32_t existing = -1;
    for (uint32_t old = 0; old < current.edge_count && existing < 0; ++old) {
      if (same_route(current.edges[old], added)) existing = static_cast<int32_t>(old);
    }
    if (existing >= 0) next.edge_previous[edge] = static_cast<uint16_t>(existing + 1);
    const int32_t source = graph_node_index(current, added.from_node_id);
    if (added.pdc_delay_frames != 0 || source < 0) continue;
    if (existing >= 0) {
      inherit_join(edge, static_cast<uint32_t>(existing));
      continue;
    }
    std::array<bool, kMaximumGraphNodes> seen{};
    std::array<uint16_t, kMaximumGraphNodes> queue{};
    uint32_t head = 0;
    uint32_t tail = 0;
    queue[tail++] = static_cast<uint16_t>(source);
    for (; head < tail && added.sidechain == 0 && next.edge_join_nodes[edge] == 0; ++head) {
      for (uint32_t old = 0; old < old_edges && next.edge_join_nodes[edge] == 0; ++old) {
        const uint32_t target = current.edge_target_indices[old];
        if (current.edges[old].sidechain != 0 || current.edge_source_indices[old] != queue[head]
          || target >= current.node_count || !absent[target] || seen[target]) continue;
        seen[target] = true;
        if (node_to_next[target] >= static_cast<int32_t>(next.node_count)) {
          next.edge_join_nodes[edge] = static_cast<uint16_t>(node_to_next[target] + 1);
        } else {
          queue[tail++] = static_cast<uint16_t>(target);
        }
      }
    }
    if (next.edge_join_nodes[edge] != 0) continue;
    if (clock < 0) clock = transition_node(DAW_AUDIO_GRAPH_LAYOUT_STEREO);
    if (clock < 0) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    next.edge_join_nodes[edge] = static_cast<uint16_t>(clock + 1);
  }
  next.ghost_node_count = ghost_nodes;
  next.ghost_edge_count = ghost_edges;
  next.ghost_processor_count = ghost_processors;
  if (order_graph_nodes(next)) return DAW_AUDIO_CORE_OK;
  for (uint32_t index = next.node_count; index < next.total_node_count(); ++index) {
    RuntimeSlot &slot = core.node_slots[next.node_slots[index]];
    if (slot.state.load(std::memory_order_relaxed) == kSlotPrepared) slot.state.store(kSlotInitialized, std::memory_order_release);
  }
  next.ghost_node_count = 0;
  next.ghost_edge_count = 0;
  next.ghost_processor_count = 0;
  order_graph_nodes(next);
  return DAW_AUDIO_CORE_GRAPH_COMPATIBILITY_REJECTED;
}
}  // namespace daw::audio_core_internal
