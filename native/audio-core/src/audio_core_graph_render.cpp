#include "audio_core_internal.h"

namespace daw::audio_core_internal {

// Sized by the core config, so one allocation serves every revision and a
// prepare never frees storage the callback may still be reading.
bool allocate_graph_stage_buffers(Core &core) {
  if (core.graph_stage_buffers) return true;
  const std::size_t graph_stage_samples = static_cast<std::size_t>(kGraphStageCount) * kMaximumGraphNodes * 2u
    * core.config.max_frames_per_block;
  std::unique_ptr<float[]> buffers(new (std::nothrow) float[graph_stage_samples]());
  if (!buffers) return false;
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  if (!core.graph_tap_storage) {
    const std::size_t history_samples = static_cast<std::size_t>(Core::kTapHistorySlots) * 2u
      * kMaximumGraphLatencyFrames;
    core.graph_tap_storage.reset(new (std::nothrow) float[history_samples]());
    if (!core.graph_tap_storage) return false;
    // A zero-filled allocation may still be backed by shared zero pages.
    // Touch every 4 KiB off-thread, covering native and Wasm page sizes.
    volatile float *pages = core.graph_tap_storage.get();
    for (std::size_t sample = 0; sample < history_samples; sample += 1024u) pages[sample] = 0.0F;
    for (uint32_t slot = 0; slot < Core::kTapHistorySlots; ++slot) {
      core.graph_tap_histories[slot].offset = static_cast<std::size_t>(slot) * 2u * kMaximumGraphLatencyFrames;
      core.graph_tap_histories[slot].capacity = kMaximumGraphLatencyFrames;
    }
  }
#endif
  core.graph_stage_buffers = std::move(buffers);
  return true;
}
}  // namespace daw::audio_core_internal

namespace {

float *graph_stage_sample(
  Core &core,
  uint32_t stage,
  uint32_t node_index,
  uint32_t channel,
  uint32_t frame) {
  const std::size_t offset = (((static_cast<std::size_t>(stage) * kMaximumGraphNodes + node_index) * 2u + channel)
    * core.config.max_frames_per_block) + frame;
  return core.graph_stage_buffers.get() + offset;
}

float deletion_fade_gain(uint32_t elapsed, uint32_t fade_frames) {
  return elapsed >= fade_frames ? 0.0F : 1.0F - static_cast<float>(elapsed) / static_cast<float>(fade_frames);
}

// Level at which a signal leaves a source node that was deleted. A fading node
// feeding a node that was deleted no later than itself is faded once, where the
// signal leaves that node, so deleting a source with its group does not apply the
// ramp twice.
float ghost_edge_fade_gain(const Core &core, const GraphRevision &graph, uint32_t edge_index, uint32_t frame) {
  const uint32_t target_index = graph.edge_target_indices[edge_index];
  const uint32_t elapsed = core.node_fade_start[graph.edge_source_indices[edge_index]];
  if (target_index >= graph.node_count && core.node_fade_start[target_index] >= elapsed) return 1.0F;
  return deletion_fade_gain(elapsed + frame, graph.fade_frames);
}

// Level at which a route that replaced one through a deleted node enters: the
// complement of that node's fade-out.
float edge_join_gain(const Core &core, const GraphRevision &graph, uint32_t edge_index, uint32_t frame) {
  const uint32_t join = graph.edge_join_nodes[edge_index];
  if (join == 0) return 1.0F;
  return 1.0F - deletion_fade_gain(core.node_fade_start[join - 1] + frame, graph.fade_frames);
}

float graph_tap_sample(
  Core &core,
  const GraphRevision &graph,
  uint32_t edge_index,
  uint32_t channel,
  uint32_t frame,
  uint32_t delay) {
  const daw_audio_graph_edge_descriptor &edge = graph.edges[edge_index];
  const uint32_t source_index = graph.edge_source_indices[edge_index];
  const uint32_t stage = edge.tap == DAW_AUDIO_GRAPH_EDGE_PRE_FX ? kGraphPreFxStage
    : edge.tap == DAW_AUDIO_GRAPH_EDGE_PRE_FADER ? kGraphPreFaderStage : kGraphOutputStage;
  float source = 0.0F;
  if (delay <= frame) {
    source = *graph_stage_sample(core, stage, source_index, channel, frame - delay);
  } else if (core.graph_write_frame + frame >= delay) {
    const uint64_t read_frame = core.graph_write_frame + frame - delay;
    const uint32_t slot = graph.tap_history_slots[source_index][stage];
    const auto &history = core.graph_tap_histories[slot];
    if (read_frame >= history.first_frame && read_frame < history.end_frame
      && history.end_frame - read_frame <= history.capacity) {
      const std::size_t offset = history.offset + static_cast<std::size_t>(channel) * history.capacity
        + (read_frame & (history.capacity - 1u));
      source = core.graph_tap_storage[offset];
    }
  }
  return source;
}

void advance_edge_ramps(Core &core, const GraphRevision &graph, uint32_t frame_count) {
  for (uint32_t edge = 0; edge < graph.total_edge_count(); ++edge) {
    Core::EdgeRamp &ramp = core.edge_ramps[core.edge_ramp_bank][edge];
    ramp.seen = true;
    ramp.elapsed = std::min(ramp.frames, ramp.elapsed + frame_count);
  }
}

float graph_edge_sample(
  Core &core, const GraphRevision &graph, uint32_t edge_index,
  uint32_t channel, uint32_t frame) {
  const auto &edge = graph.edges[edge_index];
  const uint32_t source_index = graph.edge_source_indices[edge_index];
  float source = 0.0F;
  const auto &head = graph.read_heads[edge_index];
  const uint64_t absolute = core.graph_write_frame + frame;
  const uint64_t seam = head.seam + core.latency_publication_shift;
  if (core.transport.running == 0 || core.latency_shrunk_revision == graph.revision) {
    source = graph_tap_sample(core, graph, edge_index, channel, frame, head.stopped_delay);
  } else if (absolute < seam) {
    source = graph_tap_sample(core, graph, edge_index, channel, frame, head.previous_delay);
  } else if (head.crossfade_frames != 0 && absolute - seam < head.crossfade_frames) {
    const float mix = static_cast<float>(absolute - seam) / head.crossfade_frames;
    const float previous = graph_tap_sample(core, graph, edge_index, channel, frame, head.previous_delay);
    const float next = graph_tap_sample(core, graph, edge_index, channel, frame, head.delay);
    source = previous * (1.0F - mix) + next * mix;
  } else {
    source = graph_tap_sample(core, graph, edge_index, channel, frame, head.delay);
  }
  const Core::EdgeRamp &ramp = core.edge_ramps[core.edge_ramp_bank][edge_index];
  source *= edge_ramp_gain(ramp, edge.gain, ramp.elapsed + frame + 1u);
  if (source_index >= graph.node_count) source *= ghost_edge_fade_gain(core, graph, edge_index, frame);
  return source * edge_join_gain(core, graph, edge_index, frame);
}

// Moves every ghost's fade forward by one block and retires what finished. The
// slot then only awaits reclamation after this process call completes.
void advance_deletion_fades(Core &core, const GraphRevision &graph, uint32_t frame_count) {
  const auto advance = [&](RuntimeSlot &slot) {
    const uint32_t elapsed = slot.fade_elapsed.load(std::memory_order_relaxed);
    if (elapsed >= graph.fade_frames) return true;
    slot.fade_elapsed.store(std::min(graph.fade_frames, elapsed + frame_count), std::memory_order_relaxed);
    return elapsed + frame_count >= graph.fade_frames;
  };
  for (uint32_t node_index = graph.node_count; node_index < graph.total_node_count(); ++node_index) {
    RuntimeSlot &slot = core.node_slots[graph.node_slots[node_index]];
    if (slot.state.load(std::memory_order_relaxed) == kSlotActive && advance(slot)) retire_runtime_slot(core, slot);
  }
  for (uint32_t index = graph.processor_count; index < graph.total_processor_count(); ++index) {
    const GraphRevision::Processor &processor = graph.processors[index];
    RuntimeSlot &slot = core.processor_slots[processor.history_slot];
    if (slot.state.load(std::memory_order_relaxed) != kSlotActive) continue;
    const bool finished = processor.detached
      ? advance(slot)
      : core.node_slots[graph.node_slots[processor.node_index]].state.load(std::memory_order_relaxed) != kSlotActive;
    if (finished) {
      retire_runtime_slot(core, slot);
      if (processor.spectral_predecessor >= 0) {
        const auto &previous = graph.spectral_predecessors[processor.spectral_predecessor];
        auto &old_slot = core.processor_slots[previous.history_slot];
        if (old_slot.state.load(std::memory_order_relaxed) == kSlotActive
          && old_slot.generation.load(std::memory_order_relaxed) == previous.generation) retire_runtime_slot(core, old_slot);
      }
    }
  }
}

struct ChainItem {
  uint16_t processor_index = 0;
  ProcessorRenderer render = nullptr;
};
constexpr uint32_t kMaximumChainItems = kMaximumNodeChain;

// One processor's sample. Its key is the signal routed to it, or its own input
// when nothing is. A key from a deleted source fades with that source, and the
// processor's own input takes over by the amount the keys have faded: once every
// key is gone the detector reads exactly what it would with no key routed, with
// no step on the way and no later publication needed.
void render_chain_frame(
  Core &core, GraphRevision &graph, const ChainItem &item, uint32_t frame, float &left, float &right) {
  GraphRevision::Processor &processor = graph.processors[item.processor_index];
  resolve_processor_parameter_frame(core, processor, frame);
  const float own_left = processor.kind == DAW_AUDIO_PROCESSOR_KIND_SPECTRAL ? 0.0F : left;
  const float own_right = processor.kind == DAW_AUDIO_PROCESSOR_KIND_SPECTRAL ? 0.0F : right;
  float sidechain_left = own_left;
  float sidechain_right = own_right;
  const GraphRevision::Range sidechain_range = graph.sidechain_edge_ranges[item.processor_index];
  if (sidechain_range.count > 0) {
    sidechain_left = 0.0F;
    sidechain_right = 0.0F;
    float key_level = 0.0F;
    const uint32_t sidechain_end = static_cast<uint32_t>(sidechain_range.start) + sidechain_range.count;
    for (uint32_t sidechain_position = sidechain_range.start; sidechain_position < sidechain_end; ++sidechain_position) {
      const uint32_t edge_index = graph.sidechain_edge_indices[sidechain_position];
      sidechain_left += graph_edge_sample(core, graph, edge_index, 0, frame);
      sidechain_right += graph_edge_sample(core, graph, edge_index, 1, frame);
      key_level += edge_join_gain(core, graph, edge_index, frame)
        * (graph.edge_source_indices[edge_index] < graph.node_count ? 1.0F : ghost_edge_fade_gain(core, graph, edge_index, frame));
    }
    key_level = std::min(1.0F, key_level);
    if (key_level < 1.0F) {
      sidechain_left += own_left * (1.0F - key_level);
      sidechain_right += own_right * (1.0F - key_level);
    }
  }
  float processed_left = 0.0F;
  float processed_right = 0.0F;
  if (processor.kind == DAW_AUDIO_PROCESSOR_KIND_GATE) core.gate_histories[processor.gate_slot].external_key = sidechain_range.count > 0;
  if (processor.kind == DAW_AUDIO_PROCESSOR_KIND_COMPRESSOR) core.compressor_histories[processor.compressor_slot].external_key = sidechain_range.count > 0;
  if (processor.kind == DAW_AUDIO_PROCESSOR_KIND_SPECTRAL) record_spectral_input(core, processor.spectral_slot, left, right, sidechain_left, sidechain_right);
  if (processor.spectral_predecessor >= 0) {
    auto &old = graph.spectral_predecessors[processor.spectral_predecessor];
    auto &slot = core.processor_slots[old.history_slot];
    auto &history = core.spectral_histories[processor.spectral_slot];
    if (runtime_slot_renderable(core, slot, old.generation)) {
      render_spectral_replacement_step(core, graph, processor, old, slot, frame, left, right,
        sidechain_left, sidechain_right, processed_left, processed_right);
    } else {
      item.render(core, processor, frame, left, right, sidechain_left, sidechain_right, &processed_left, &processed_right);
      if (processor.spectral_compensation != 0 && core.transport.running != 0
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
        && core.latency_shrunk_revision.load(std::memory_order_relaxed) != graph.revision
#endif
      ) {
        processed_left = spectral_delayed_output(history, 0, processor.spectral_compensation);
        processed_right = spectral_delayed_output(history, 1, processor.spectral_compensation);
      }
    }
  } else {
    item.render(core, processor, frame, left, right, sidechain_left, sidechain_right, &processed_left, &processed_right);
    if (processor.kind == DAW_AUDIO_PROCESSOR_KIND_SPECTRAL && processor.spectral_compensation != 0
      && core.transport.running != 0
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
      && core.latency_shrunk_revision.load(std::memory_order_relaxed) != graph.revision
#endif
    ) {
      const auto &history = core.spectral_histories[processor.spectral_slot];
      processed_left = spectral_delayed_output(history, 0, processor.spectral_compensation);
      processed_right = spectral_delayed_output(history, 1, processor.spectral_compensation);
    }
  }
  left = std::isfinite(processed_left) ? processed_left : 0.0F;
  right = std::isfinite(processed_right) ? processed_right : 0.0F;
}

// Renders consecutive built-in processors of one node over the block, in chain
// order. Removed processors that sit next to each other and started fading
// together leave as one stage: they run in sequence at full level and a single
// ramp crossfades from the signal that entered the first to the one that left the
// last. Crossfading each on its own would multiply the ramps. Runs frames
// [frame_begin, frame_end) of the block: a dipping node runs the two halves of a
// block in different orders, and each processor still sees its frames once, in
// sequence. Returns whether a live (not fading) processor ran.
bool render_chain_segment(
  Core &core, GraphRevision &graph, uint32_t node_index, uint32_t frame_begin, uint32_t frame_end,
  const ChainItem *items, uint32_t count) {
  bool live = false;
  const auto fade_clock = [&core](const GraphRevision::Processor &processor, uint32_t &elapsed) {
    const RuntimeSlot &slot = core.processor_slots[processor.history_slot];
    if (!runtime_slot_renderable(core, slot, processor.generation)) return false;
    elapsed = slot.fade_elapsed.load(std::memory_order_relaxed);
    return true;
  };
  std::array<ChainItem, kMaximumChainItems> run;
  for (uint32_t position = 0; position < count; ++position) {
    GraphRevision::Processor &first = graph.processors[items[position].processor_index];
    uint32_t fade_start = 0;
    if (first.detached && !fade_clock(first, fade_start)) continue;
    uint32_t run_count = 0;
    run[run_count++] = items[position];
    while (first.detached && position + 1 < count) {
      const GraphRevision::Processor &candidate = graph.processors[items[position + 1].processor_index];
      uint32_t elapsed = 0;
      if (!candidate.detached) break;
      if (!fade_clock(candidate, elapsed)) {
        ++position;
        continue;
      }
      if (elapsed != fade_start) break;
      run[run_count++] = items[++position];
    }
    live = live || !first.ghost;
    for (uint32_t index = 0; index < run_count; ++index) {
      prepare_processor_parameter_cache(core, graph.processors[run[index].processor_index]);
    }
    for (uint32_t frame = frame_begin; frame < frame_end; ++frame) {
      float &left = *graph_stage_sample(core, kGraphPreFaderStage, node_index, 0, frame);
      float &right = *graph_stage_sample(core, kGraphPreFaderStage, node_index, 1, frame);
      const float dry_left = left;
      const float dry_right = right;
      for (uint32_t index = 0; index < run_count; ++index) render_chain_frame(core, graph, run[index], frame, left, right);
      if (!first.detached) continue;
      const float wet = deletion_fade_gain(fade_start + frame, graph.fade_frames);
      left = dry_left + (left - dry_left) * wet;
      right = dry_right + (right - dry_right) * wet;
      if (!std::isfinite(left)) left = 0.0F;
      if (!std::isfinite(right)) right = 0.0F;
    }
  }
  return live;
}
}  // namespace

namespace daw::audio_core_internal {

// Ends the replaced instruments fading out beside a node's own, and the ones
// behind them: each retires its slot, which awaits reclamation after the process
// call completes. Callback, once a blend is over; or control thread, for a slot
// nothing renders any more.
void end_node_blend(Core &core, Core::NodeBlend &first) {
  Core::NodeBlend *blend = &first;
  for (uint32_t link = 0; blend->partner != 0 && link <= kMaximumNodeBlends; ++link) {
    const uint32_t partner = blend->partner - 1u;
    RuntimeSlot &slot = core.node_slots[partner];
    if (slot.state.load(std::memory_order_relaxed) == kSlotActive
      && slot.generation.load(std::memory_order_relaxed) == blend->partner_generation) retire_runtime_slot(core, slot);
    blend->partner = 0;
    blend->elapsed = 0;
    blend->depth.store(0, std::memory_order_release);
    blend = &core.node_blends[partner];
  }
}
}  // namespace daw::audio_core_internal

namespace {

// Moves every replaced instrument's fade forward by one block; one that finished
// retires itself and everything behind it, whose weight is nil by then.
void advance_node_blends(Core &core, const GraphRevision &graph, uint32_t frame_count) {
  for (uint32_t node_index = 0; node_index < graph.total_node_count(); ++node_index) {
    Core::NodeBlend &head = core.node_blends[graph.node_slots[node_index]];
    uint32_t depth = 0;
    Core::NodeBlend *blend = &head;
    while (blend->partner != 0 && depth < kMaximumNodeBlends) {
      blend->elapsed = std::min(graph.fade_frames, blend->elapsed + frame_count);
      if (blend->elapsed >= graph.fade_frames) {
        end_node_blend(core, *blend);
        break;
      }
      ++depth;
      blend = &core.node_blends[blend->partner - 1u];
    }
    head.depth.store(depth, std::memory_order_release);
  }
}

// A layout fold moves a linear step per frame toward the layout's target and folds
// by the position it stands at, so the first frame after a change is still the old
// layout and the last of the fade is the target layout.
float advance_fold(float &level, bool mono, float step) {
  const float applied = level;
  level = clamp_bypass_step(level, mono ? 1.0F : 0.0F, step);
  return applied;
}

void fold_channels(float level, float &left, float &right) {
  if (level <= 0.0F) return;
  const float mean = 0.5F * (left + right);
  if (level >= 1.0F) {
    left = right = mean;
    return;
  }
  left += (mean - left) * level;
  right += (mean - right) * level;
}

void render_instrument_state(
  Core &core, InstrumentNodeState &state, const daw_audio_instrument_state_descriptor &descriptor,
  float *left, float *right) {
  advance_applied(core, state, descriptor.kind);
  if (descriptor.kind == DAW_AUDIO_INSTRUMENT_KIND_SYNTH) {
    render_instrument_frame(state, descriptor, core.config.sample_rate_hz, left, right);
  } else if (descriptor.kind == DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) {
    render_granular_instrument_frame(core, state, left, right);
  } else {
    render_sample_instrument_frame(core, state, descriptor, left, right);
  }
}

// The leading frames of a block that still have output to fade, and so run the old
// order; the frame whose output is nothing already belongs to the plan's order. A
// node with an external stage cannot split a block (the stage renders all of it), so
// it keeps the old order for the whole block in which its output reaches nothing, and
// `dip_hold_frames` places the fade at the end of that block.
uint32_t dip_old_frames(const Core::NodeDip &dip, uint32_t frame_count, bool splittable) {
  if (dip.phase != Core::kDipFadingOut || dip.level == 0) return 0;
  return splittable ? std::min(frame_count, dip.level) : frame_count;
}

// The leading frames of a block in which a node that cannot split it keeps the old
// order at the level it stands at, so the fade ends on the block edge where the plan's
// order takes over instead of reaching nothing early and holding silence. A fade that
// does not fit in the block (shorter than it) runs from the first frame, and holds
// the level it has reached in the block that can finish it.
uint32_t dip_hold_frames(const Core::NodeDip &dip, uint32_t frame_count, bool splittable) {
  if (splittable || dip.phase != Core::kDipFadingOut || dip.level == 0 || frame_count < dip.level) return 0;
  return frame_count - dip.level;
}

// Multiplies a node's pre-fader output by its dip, one linear step per frame, and
// moves the dip along. The frame whose output is nothing, past the old order's last,
// starts the return. The first `hold_frames` frames keep the level they stand at.
void apply_node_dip(
  Core &core, const GraphRevision &graph, uint32_t node_index, uint32_t frame_count, uint32_t old_frames,
  uint32_t hold_frames) {
  Core::NodeDip &dip = core.node_dips[graph.node_slots[node_index]];
  const uint32_t half = dip_half_frames(graph);
  for (uint32_t frame = 0; frame < frame_count && dip.phase != Core::kDipNone; ++frame) {
    if (dip.phase == Core::kDipFadingOut && dip.level == 0 && frame >= old_frames) dip.phase = Core::kDipFadingIn;
    const float gain = static_cast<float>(dip.level) / static_cast<float>(half);
    if (dip.phase == Core::kDipFadingOut) {
      if (dip.level > 0 && frame >= hold_frames) --dip.level;
    } else if (++dip.level >= half) {
      dip = {};
    }
    *graph_stage_sample(core, kGraphPreFaderStage, node_index, 0, frame) *= gain;
    *graph_stage_sample(core, kGraphPreFaderStage, node_index, 1, frame) *= gain;
  }
}

// The chain a dipping node runs while its output fades out: the plan's chain with
// the stages the dip names (survivors, and the ghosts of stages the edit deleted)
// put back in the order they ran, in the places those stages hold. Stages the dip
// does not name (added by the edit) stay where the plan puts them, and so do the
// external stages around them.
void order_chain_for_dip(
  const GraphRevision &graph, const Core::NodeDip &dip, const ChainItem *items, uint32_t count, ChainItem *out) {
  const auto order_end = dip.order.begin() + dip.count;
  uint32_t taken = 0;
  for (uint32_t position = 0; position < count; ++position) {
    out[position] = items[position];
    if (std::find(dip.order.begin(), order_end, items[position].processor_index) == order_end) continue;
    const uint16_t index = dip.order[taken++];
    out[position] = {index, find_processor_renderer(graph.processors[index].kind)};
  }
}

// One block of a node's chain: the old order for the frames a dip still fades out,
// then the plan's order.
bool render_node_chain(
  Core &core, GraphRevision &graph, uint32_t node_index, uint32_t frame_count, uint32_t old_frames,
  const ChainItem *items, const ChainItem *old_items, uint32_t count) {
  bool live = false;
  if (old_frames > 0) live = render_chain_segment(core, graph, node_index, 0, old_frames, old_items, count);
  if (old_frames < frame_count) {
    live = render_chain_segment(core, graph, node_index, old_frames, frame_count, items, count) || live;
  }
  return live;
}
}  // namespace

namespace daw::audio_core_internal {

void process_graph(Core &core, const daw_audio_core_process_block &block) {
  GraphRevision &graph = (*core.published_graph);
  // Where each ghost's fade stands, known up front because a ghost consumer reads
  // its sources' progress. A faded-out ghost contributes nothing: consumers
  // multiply by the fade gain.
  for (uint32_t node_index = graph.node_count; node_index < graph.total_node_count(); ++node_index) {
    const RuntimeSlot &node_slot = core.node_slots[graph.node_slots[node_index]];
    core.node_fade_start[node_index] = runtime_slot_renderable(core, node_slot, graph.node_generations[node_index])
      ? node_slot.fade_elapsed.load(std::memory_order_relaxed) : graph.fade_frames;
  }
  const bool solo = resolve_mixer_solo(core, graph, block.frame_count);
  for (uint32_t ordered = 0; ordered < graph.total_node_count(); ++ordered) {
    const uint32_t node_index = graph.process_order[ordered];
    const daw_audio_graph_node_descriptor &node = graph.nodes[node_index];
    const bool ghost_node = node_index >= graph.node_count;
    if (ghost_node && core.node_fade_start[node_index] >= graph.fade_frames) continue;
    const uint32_t node_slot = graph.node_slots[node_index];
    InstrumentNodeState &instrument_state = core.instrument_runtime[node_slot];
    // The instrument and, while it fades out, the one it replaced and the ones
    // that one replaced in turn. `elapsed` is the clock of the fade-in that link
    // owns against the next one; the oldest link has none.
    struct InstrumentLink {
      InstrumentNodeState *state;
      const daw_audio_instrument_state_descriptor *descriptor;
      uint32_t elapsed;
    };
    std::array<InstrumentLink, kMaximumNodeBlends + 1> instrument_links;
    uint32_t instrument_link_count = 0;
    if (node.kind == DAW_AUDIO_GRAPH_NODE_INSTRUMENT) {
      instrument_links[instrument_link_count++] = {&instrument_state, &node.instrument, 0};
      const Core::NodeBlend *blend = &core.node_blends[node_slot];
      while (blend->partner != 0 && instrument_link_count <= kMaximumNodeBlends) {
        const uint32_t partner = blend->partner - 1u;
        if (!runtime_slot_renderable(core, core.node_slots[partner], blend->partner_generation)) break;
        instrument_links[instrument_link_count - 1].elapsed = blend->elapsed;
        instrument_links[instrument_link_count++] = {&core.instrument_runtime[partner], &blend->descriptor, 0};
        blend = &core.node_blends[partner];
      }
    }
    Core::NodeFold &fold = core.node_folds[node_slot];
    if (!fold.seen) {
      fold.level = {node.input_layout == DAW_AUDIO_GRAPH_LAYOUT_MONO ? 1.0F : 0.0F,
        node.output_layout == DAW_AUDIO_GRAPH_LAYOUT_MONO ? 1.0F : 0.0F};
      fold.seen = true;
    }
    const float fold_step = 1.0F / static_cast<float>(graph.fade_frames);
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
    const uint32_t hook_layout = node.output_layout;
    const uint32_t hook_channel_count = hook_layout == DAW_AUDIO_GRAPH_LAYOUT_MONO ? 1U : 2U;
#endif
    uint16_t instrument_event_cursor = 0;
    const uint16_t instrument_event_count = core.instrument_event_counts[node_index];
    for (uint32_t frame = 0; frame < block.frame_count; ++frame) {
      float left = 0.0F;
      float right = 0.0F;
      if (node.kind == DAW_AUDIO_GRAPH_NODE_INSTRUMENT) {
        while (instrument_event_cursor < instrument_event_count) {
          const uint16_t event_index = core.instrument_event_indices[node_index][instrument_event_cursor];
          const daw_audio_instrument_event &event = core.active_instrument_events[event_index];
          if (event.frame_offset != frame) break;
          ++instrument_event_cursor;
          if (is_native_transport_release(event.type)) {
            for (uint32_t link = 0; link < instrument_link_count; ++link) release_instrument_state(*instrument_links[link].state);
          } else if (is_native_all_sound_off(event.type)) {
            for (uint32_t link = 0; link < instrument_link_count; ++link) clear_instrument_state(*instrument_links[link].state);
          } else if (node.instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_SYNTH) {
            (void)apply_instrument_event(instrument_state, node.instrument, event);
          } else if (node.instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) {
            (void)apply_granular_instrument_event(instrument_state, event);
          } else {
            (void)apply_sample_instrument_event(core, instrument_state, node.instrument, event);
          }
        }
        if (instrument_link_count == 1) {
          render_instrument_state(core, instrument_state, node.instrument, &left, &right);
        } else {
          // Complementary weights: each link takes its share of what the newer
          // links left, so the waveforms sum to one whole at every frame.
          float remaining = 1.0F;
          for (uint32_t link = 0; link < instrument_link_count; ++link) {
            const InstrumentLink &voice = instrument_links[link];
            float voice_left = 0.0F;
            float voice_right = 0.0F;
            render_instrument_state(core, *voice.state, *voice.descriptor, &voice_left, &voice_right);
            const float entering = link + 1 == instrument_link_count ? 1.0F
              : std::min(1.0F, static_cast<float>(voice.elapsed + frame) / static_cast<float>(graph.fade_frames));
            left += remaining * entering * voice_left;
            right += remaining * entering * voice_right;
            remaining *= 1.0F - entering;
          }
        }
      }
      if (node.kind == DAW_AUDIO_GRAPH_NODE_SOURCE
        && node.input_bus != DAW_AUDIO_GRAPH_INPUT_BUS_DISCONNECTED
        && node.input_bus < block.input_bus_count && block.inputs != nullptr) {
        const float *source_left = block.inputs[node.input_bus * block.channel_count];
        const float *source_right = block.channel_count > 1 ? block.inputs[node.input_bus * block.channel_count + 1] : source_left;
        left = source_left == nullptr ? 0.0F : source_left[frame];
        right = source_right == nullptr ? left : source_right[frame];
      }
      if (node.kind == DAW_AUDIO_GRAPH_NODE_SOURCE) {
        render_sample_source_range(
          core, core.active_source_ranges[node_index],
          core.transport.frame + static_cast<int64_t>(frame), &left, &right);
      }
      if (node.kind != DAW_AUDIO_GRAPH_NODE_INSTRUMENT) {
        const GraphRevision::Range incoming_range = graph.incoming_edge_ranges[node_index];
        const uint32_t incoming_end = static_cast<uint32_t>(incoming_range.start) + incoming_range.count;
        for (uint32_t position = incoming_range.start; position < incoming_end; ++position) {
          const uint32_t edge_index = graph.incoming_edge_indices[position];
          left += graph_edge_sample(core, graph, edge_index, 0, frame);
          right += graph_edge_sample(core, graph, edge_index, 1, frame);
        }
      }
      fold_channels(advance_fold(fold.level[0], node.input_layout == DAW_AUDIO_GRAPH_LAYOUT_MONO, fold_step), left, right);
      *graph_stage_sample(core, kGraphPreFxStage, node_index, 0, frame) = std::isfinite(left) ? left : 0.0F;
      *graph_stage_sample(core, kGraphPreFxStage, node_index, 1, frame) = std::isfinite(right) ? right : 0.0F;
      *graph_stage_sample(core, kGraphPreFaderStage, node_index, 0, frame) =
        *graph_stage_sample(core, kGraphPreFxStage, node_index, 0, frame);
      *graph_stage_sample(core, kGraphPreFaderStage, node_index, 1, frame) =
        *graph_stage_sample(core, kGraphPreFxStage, node_index, 1, frame);
    }
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
    const NativeGraphHooks &native_stages = *core.published_native_hooks;
#endif
    // A node that is dipping runs the old order of its stages for the frames its
    // output still has to fade. An external stage renders a whole block where it
    // stands, so a node with one keeps the old order for the whole block in which its
    // output reaches nothing; it holds the old order at its level first, so the fade
    // ends on that block's edge.
    bool splittable = true;
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
    for (std::uint32_t stage_index = 0; stage_index < native_stages.stage_counts[node_index]; ++stage_index) {
      if (native_stages.stages[node_index][stage_index].kind == NativeGraphStageKind::kExternal) splittable = false;
    }
#endif
    const Core::NodeDip &node_dip = core.node_dips[node_slot];
    const uint32_t old_frames = dip_old_frames(node_dip, block.frame_count, splittable);
    const uint32_t hold_frames = dip_hold_frames(node_dip, block.frame_count, splittable);
    bool processed_chain = false;
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
    if (native_stages.has_instrument_sources[node_index] && native_stages.hook != nullptr) {
      const NativeGraphStage &source = native_stages.instrument_sources[node_index];
      const auto project_frame = project_time_frame(core);
      const daw::audio_core::NativeGraphNodeRender render{
        .graph_revision = graph.revision,
        .node_index = node_index,
        .node_id = node.id,
        .frame_count = block.frame_count,
        .channel_count = hook_channel_count,
        .sample_rate_hz = core.config.sample_rate_hz,
        .transport_epoch = core.transport.epoch,
        .transport_running = core.transport.running != 0,
        .transport_frame = core.transport.frame,
        .project_time_samples = project_frame,
        .tempo_bpm = core.transport.tempo_bpm,
        .project_time_music = project_time_music(core, project_frame),
        .time_signature_numerator = core.transport.time_signature_numerator,
        .time_signature_denominator = core.transport.time_signature_denominator,
        .cycle_active = core.transport.cycle_active != 0,
        .cycle_start_music = project_time_music(core, core.transport.cycle_start_frame),
        .cycle_end_music = project_time_music(core, core.transport.cycle_end_frame),
        .stage_index = 0,
        .stage_role = daw::audio_core::NativeGraphStageRole::kInstrument,
        .planes = {
          graph_stage_sample(core, kGraphPreFaderStage, node_index, 0, 0),
          graph_stage_sample(core, kGraphPreFaderStage, node_index, 1, 0),
        },
        .instrument_events = std::span<const daw_audio_instrument_event>(
          core.native_instrument_events[node_index].data(),
          core.instrument_event_counts[node_index]),
        .attachment = source.attachment,
      };
      native_stages.hook(render);
      processed_chain = true;
      for (std::uint32_t frame = 0; frame < block.frame_count; ++frame) {
        float &left = *graph_stage_sample(core, kGraphPreFaderStage, node_index, 0, frame);
        float &right = *graph_stage_sample(core, kGraphPreFaderStage, node_index, 1, frame);
        if (!std::isfinite(left)) left = 0.0F;
        if (!std::isfinite(right)) right = 0.0F;
      }
    }
    std::array<ChainItem, kMaximumChainItems> plan_order;
    std::array<ChainItem, kMaximumChainItems> old_order;
    uint32_t built_in_count = 0;
    for (std::uint32_t stage_index = 0; stage_index < native_stages.stage_counts[node_index]; ++stage_index) {
      const NativeGraphStage &stage = native_stages.stages[node_index][stage_index];
      if (stage.kind != NativeGraphStageKind::kExternal) plan_order[built_in_count++] = {stage.processor_index, stage.renderer};
    }
    if (old_frames > 0) order_chain_for_dip(graph, node_dip, plan_order.data(), built_in_count, old_order.data());
    // Built-in stages are gathered until an external stage interrupts the chain.
    std::array<ChainItem, kMaximumChainItems> pending;
    std::array<ChainItem, kMaximumChainItems> old_pending;
    std::uint32_t pending_count = 0;
    std::uint32_t built_in_index = 0;
    const auto render_pending = [&] {
      const bool live = render_node_chain(
        core, graph, node_index, block.frame_count, old_frames, pending.data(), old_pending.data(), pending_count);
      pending_count = 0;
      return live;
    };
    for (std::uint32_t stage_index = 0; stage_index < native_stages.stage_counts[node_index]; ++stage_index) {
      const NativeGraphStage &stage = native_stages.stages[node_index][stage_index];
      if (stage.kind == NativeGraphStageKind::kExternal) {
        processed_chain = render_pending() || processed_chain;
        if (native_stages.hook == nullptr) continue;
        const auto project_frame = project_time_frame(core);
        const daw::audio_core::NativeGraphNodeRender render{
          .graph_revision = graph.revision,
          .node_index = node_index,
          .node_id = node.id,
          .frame_count = block.frame_count,
          .channel_count = hook_channel_count,
          .sample_rate_hz = core.config.sample_rate_hz,
          .transport_epoch = core.transport.epoch,
          .transport_running = core.transport.running != 0,
          .transport_frame = core.transport.frame,
          .project_time_samples = project_frame,
          .tempo_bpm = core.transport.tempo_bpm,
          .project_time_music = project_time_music(core, project_frame),
          .time_signature_numerator = core.transport.time_signature_numerator,
          .time_signature_denominator = core.transport.time_signature_denominator,
          .cycle_active = core.transport.cycle_active != 0,
          .cycle_start_music = project_time_music(core, core.transport.cycle_start_frame),
          .cycle_end_music = project_time_music(core, core.transport.cycle_end_frame),
          .stage_index = stage_index,
          .stage_role = stage.role,
          .planes = {
            graph_stage_sample(core, kGraphPreFaderStage, node_index, 0, 0),
            graph_stage_sample(core, kGraphPreFaderStage, node_index, 1, 0),
          },
          .instrument_events = {},
          .attachment = stage.attachment,
        };
        native_stages.hook(render);
        processed_chain = true;
        for (std::uint32_t frame = 0; frame < block.frame_count; ++frame) {
          float &left = *graph_stage_sample(core, kGraphPreFaderStage, node_index, 0, frame);
          float &right = *graph_stage_sample(core, kGraphPreFaderStage, node_index, 1, frame);
          if (!std::isfinite(left)) left = 0.0F;
          if (!std::isfinite(right)) right = 0.0F;
        }
        continue;
      }
      old_pending[pending_count] = old_frames > 0 ? old_order[built_in_index] : plan_order[built_in_index];
      pending[pending_count++] = plan_order[built_in_index++];
    }
    processed_chain = render_pending() || processed_chain;
#else
    const GraphRevision::Range processor_range = graph.processor_ranges[node_index];
    const uint32_t processor_end = static_cast<uint32_t>(processor_range.start) + processor_range.count;
    std::array<ChainItem, kMaximumChainItems> chain;
    uint32_t chain_count = 0;
    for (uint32_t position = processor_range.start; position < processor_end; ++position) {
      const uint32_t processor_index = graph.processor_indices[position];
      const ProcessorRenderer render = find_processor_renderer(graph.processors[processor_index].kind);
      if (render != nullptr) chain[chain_count++] = {static_cast<uint16_t>(processor_index), render};
    }
    std::array<ChainItem, kMaximumChainItems> old_chain;
    if (old_frames > 0) order_chain_for_dip(graph, node_dip, chain.data(), chain_count, old_chain.data());
    processed_chain = render_node_chain(
      core, graph, node_index, block.frame_count, old_frames, chain.data(), old_chain.data(), chain_count)
      || processed_chain;
#endif
    if (!processed_chain && node.kind == DAW_AUDIO_GRAPH_NODE_UTILITY && core.utility_configured) {
      for (uint32_t frame = 0; frame < block.frame_count; ++frame) {
        float utility_left = 0.0F;
        float utility_right = 0.0F;
        process_utility_frame(
          core, nullptr, core.utility_history, frame,
          *graph_stage_sample(core, kGraphPreFaderStage, node_index, 0, frame),
          *graph_stage_sample(core, kGraphPreFaderStage, node_index, 1, frame),
          &utility_left, &utility_right);
        *graph_stage_sample(core, kGraphPreFaderStage, node_index, 0, frame) = utility_left;
        *graph_stage_sample(core, kGraphPreFaderStage, node_index, 1, frame) = utility_right;
      }
    }
    apply_node_dip(core, graph, node_index, block.frame_count, old_frames, hold_frames);
    MixerBlock mixer = begin_mixer_block(core, node.mixer, node_slot);
    for (uint32_t frame = 0; frame < block.frame_count; ++frame) {
      float left = *graph_stage_sample(core, kGraphPreFaderStage, node_index, 0, frame);
      float right = *graph_stage_sample(core, kGraphPreFaderStage, node_index, 1, frame);
      *graph_stage_sample(core, kGraphPreFaderStage, node_index, 0, frame) = std::isfinite(left) ? left : 0.0F;
      *graph_stage_sample(core, kGraphPreFaderStage, node_index, 1, frame) = std::isfinite(right) ? right : 0.0F;
      apply_mixer_frame(core, mixer, frame, solo && core.mixer_solo_frames[frame] != 0, &left, &right);
      fold_channels(advance_fold(fold.level[1], node.output_layout == DAW_AUDIO_GRAPH_LAYOUT_MONO, fold_step), left, right);
      *graph_stage_sample(core, kGraphOutputStage, node_index, 0, frame) = std::isfinite(left) ? left : 0.0F;
      *graph_stage_sample(core, kGraphOutputStage, node_index, 1, frame) = std::isfinite(right) ? right : 0.0F;
    }
    latch_mixer_block(core, mixer);
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
    if (!ghost_node && core.published_native_hooks->observer != nullptr) {
      const auto project_frame = project_time_frame(core);
      core.published_native_hooks->observer({
        .graph_revision = graph.revision,
        .node_index = node_index,
        .node_id = node.id,
        .frame_count = block.frame_count,
        .channel_count = node.output_layout == DAW_AUDIO_GRAPH_LAYOUT_MONO ? 1U : 2U,
        .sample_rate_hz = core.config.sample_rate_hz,
        .transport_epoch = core.transport.epoch,
        .transport_running = core.transport.running != 0,
        .transport_frame = core.transport.frame,
        .project_time_samples = project_frame,
        .tempo_bpm = core.transport.tempo_bpm,
        .project_time_music = project_time_music(core, project_frame),
        .time_signature_numerator = core.transport.time_signature_numerator,
        .time_signature_denominator = core.transport.time_signature_denominator,
        .cycle_active = core.transport.cycle_active != 0,
        .cycle_start_music = project_time_music(core, core.transport.cycle_start_frame),
        .cycle_end_music = project_time_music(core, core.transport.cycle_end_frame),
        .planes = {
          graph_stage_sample(core, kGraphOutputStage, node_index, 0, 0),
          graph_stage_sample(core, kGraphOutputStage, node_index, 1, 0),
        },
        .instrument_events = {},
        .attachment = core.published_native_hooks->observer_attachment,
      });
    }
#endif
  }
  // Commit each pre-gain tap once, after every reader consumed the preceding
  // block's history. This keeps a full-capacity delay valid even when a block
  // spans the ring wrap; writing a source block before its readers would erase
  // the oldest samples they still need.
  for (uint32_t node = 0; node < graph.total_node_count(); ++node) {
    for (uint32_t stage = 0; stage < kGraphStageCount; ++stage) {
      if (node >= graph.node_count && !graph.ghost_history_writers[node][stage]) continue;
      const uint32_t slot = graph.tap_history_slots[node][stage];
      auto &history = core.graph_tap_histories[slot];
      if (history.capacity == 0) continue;
      if (history.end_frame != core.graph_write_frame) history.first_frame = core.graph_write_frame;
      for (uint32_t channel = 0; channel < 2; ++channel) {
        const std::size_t base = history.offset + static_cast<std::size_t>(channel) * history.capacity;
        for (uint32_t frame = 0; frame < block.frame_count; ++frame) {
          core.graph_tap_storage[base + ((core.graph_write_frame + frame) & (history.capacity - 1u))]
            = *graph_stage_sample(core, stage, node, channel, frame);
        }
      }
      history.end_frame = core.graph_write_frame + block.frame_count;
      history.first_frame = std::max(history.first_frame,
        history.end_frame > history.capacity ? history.end_frame - history.capacity : 0);
    }
  }
  advance_deletion_fades(core, graph, block.frame_count);
  advance_node_blends(core, graph, block.frame_count);
  advance_edge_ramps(core, graph, block.frame_count);
  for (uint32_t channel = 0; channel < block.channel_count; ++channel) {
    const uint32_t graph_channel = channel == 0 ? 0 : 1;
    for (uint32_t frame = 0; frame < block.frame_count; ++frame) {
      float gain = 1.0F;
      if (graph.latency_raise != 0 && core.transport.running != 0 && core.latency_shrunk_revision != graph.revision) {
        const uint64_t absolute = core.graph_write_frame + frame;
        const uint64_t seam = graph.latency_origin + core.latency_publication_shift + graph.fade_frames;
        if (absolute < seam) gain = static_cast<float>(seam - absolute) / graph.fade_frames;
        else if (absolute < seam + graph.fade_frames) gain = static_cast<float>(absolute - seam) / graph.fade_frames;
      }
      block.outputs[channel][frame] = *graph_stage_sample(core, kGraphOutputStage, graph.master_index, graph_channel, frame) * gain;
    }
  }
  core.graph_write_frame += block.frame_count;
  core.completed_graph_frame.store(core.graph_write_frame, std::memory_order_release);
}
}  // namespace daw::audio_core_internal
