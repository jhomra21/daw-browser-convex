#include "audio_core_internal.h"

namespace {

#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
void begin_prepare_profile(Core &core) { core.prepare_step_count = 0; }
#else
void begin_prepare_profile(Core &) {}
#endif

// Control-side reader ownership. Retained live identities and delayed ghosts
// reserve rings. A zero-delay ghost still needs no ring.
// Dropped owners finish their last read/write in the old plan's render epoch;
// publication at the next boundary transfers their rings. Preparation must
// never reset those callback-owned descriptors or write their storage.
bool prepare_tap_histories(Core &core, GraphRevision &next) {
  const auto &current = *core.published_graph;
  std::array<bool, Core::kTapHistorySlots> occupied{};
  std::array<uint16_t, kMaximumGraphNodes> by_id{};
  for (uint32_t node = 0; node < current.node_count; ++node) {
    by_id[node] = static_cast<uint16_t>(node);
  }
  const auto end = by_id.begin() + current.node_count;
  std::sort(by_id.begin(), end, [&](uint16_t left, uint16_t right) {
    return current.nodes[left].id < current.nodes[right].id;
  });
  // Reserve retained readers before assigning any new owner, irrespective of
  // node order. Runtime generation distinguishes replacement from retention.
  for (uint32_t node = 0; node < next.node_count; ++node) {
    const uint64_t id = next.nodes[node].id;
    const auto old = std::lower_bound(by_id.begin(), end, id, [&](uint16_t index, uint64_t key) {
      return current.nodes[index].id < key;
    });
    const bool retained = old != end && current.nodes[*old].id == id
      && current.node_slots[*old] == next.node_slots[node]
      && current.node_generations[*old] == next.node_generations[node];
    for (uint32_t tap = 0; tap < kGraphStageCount; ++tap) {
      next.reset_tap_histories[node][tap] = !retained;
      if (retained) {
        next.tap_history_slots[node][tap] = current.tap_history_slots[*old][tap];
        occupied[next.tap_history_slots[node][tap]] = true;
      }
    }
  }
  // A delayed ghost keeps the old owner, not a second history bank. Reserve its
  // readers before transferring any dropped owner's ring to a fresh live tap.
  // The ordinary 192-ring bound remains a genuine capacity limit.
  for (uint32_t edge = next.edge_count; edge < next.total_edge_count(); ++edge) {
    if (next.read_heads[edge].delay == 0) continue;
    const uint32_t source = next.edge_source_indices[edge];
    if (source < next.node_count) continue;
    const uint32_t stage = next.edges[edge].tap == DAW_AUDIO_GRAPH_EDGE_PRE_FX ? kGraphPreFxStage
      : next.edges[edge].tap == DAW_AUDIO_GRAPH_EDGE_PRE_FADER ? kGraphPreFaderStage : kGraphOutputStage;
    const uint32_t slot = next.tap_history_slots[source][stage];
    if (!next.ghost_history_writers[source][stage] && occupied[slot]) return false;
    next.ghost_history_writers[source][stage] = true;
    occupied[slot] = true;
  }
  uint32_t free_slot = 0;
  for (uint32_t node = 0; node < next.node_count; ++node) {
    for (uint32_t tap = 0; tap < kGraphStageCount; ++tap) {
      if (!next.reset_tap_histories[node][tap]) continue;
      while (free_slot < occupied.size() && occupied[free_slot]) ++free_slot;
      if (free_slot == occupied.size()) return false;
      next.tap_history_slots[node][tap] = static_cast<uint16_t>(free_slot);
      occupied[free_slot++] = true;
    }
  }
  return true;
}

#if !defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
// Native reserves kMaximumGraphLatencyFrames for every tap; that does not fit the
// fixed 256 MiB Wasm memory, so the rings here follow the readers. Every tap a node
// owns keeps this floor, so a delay raised later still has its history to read.
constexpr uint32_t kPortableTapHistoryFloorFrames = 4096;

// Control and render share one thread here, so a prepare may move the rings. They
// only grow: the published plan keeps reading them, and a grown ring carries its
// history over. A ring covers the longest delay any head of the plan reads.
bool configure_portable_tap_histories(Core &core, const GraphRevision &graph) {
  std::array<uint32_t, Core::kTapHistorySlots> capacities{};
  for (uint32_t slot = 0; slot < capacities.size(); ++slot) capacities[slot] = core.graph_tap_histories[slot].capacity;
  const auto grow = [&](uint32_t slot, uint32_t frames) {
    uint32_t capacity = 1;
    while (capacity < frames) capacity *= 2;
    capacities[slot] = std::max(capacities[slot], capacity);
  };
  for (uint32_t node = 0; node < graph.node_count; ++node) {
    for (uint32_t tap = 0; tap < kGraphStageCount; ++tap) grow(graph.tap_history_slots[node][tap], kPortableTapHistoryFloorFrames);
  }
  for (uint32_t edge = 0; edge < graph.total_edge_count(); ++edge) {
    const auto &reader = graph.edges[edge];
    const auto &head = graph.read_heads[edge];
    const uint32_t stage = reader.tap == DAW_AUDIO_GRAPH_EDGE_PRE_FX ? kGraphPreFxStage
      : reader.tap == DAW_AUDIO_GRAPH_EDGE_PRE_FADER ? kGraphPreFaderStage : kGraphOutputStage;
    grow(graph.tap_history_slots[graph.edge_source_indices[edge]][stage],
      std::max({head.delay, head.previous_delay, head.stopped_delay}));
  }
  std::array<std::size_t, Core::kTapHistorySlots> offsets{};
  std::size_t samples = 0;
  bool grown = false;
  for (uint32_t slot = 0; slot < capacities.size(); ++slot) {
    offsets[slot] = samples;
    samples += static_cast<std::size_t>(capacities[slot]) * 2u;
    grown = grown || capacities[slot] != core.graph_tap_histories[slot].capacity;
  }
  if (!grown) return true;
  std::unique_ptr<float[]> storage(new (std::nothrow) float[samples]());
  if (!storage) return false;
  volatile float *pages = storage.get();
  for (std::size_t sample = 0; sample < samples; sample += 1024u) pages[sample] = 0.0F;
  for (uint32_t slot = 0; slot < capacities.size(); ++slot) {
    const auto &old = core.graph_tap_histories[slot];
    const uint64_t first = std::max<uint64_t>(old.first_frame, old.end_frame - std::min(old.end_frame, uint64_t{old.capacity}));
    for (uint32_t channel = 0; channel < 2; ++channel) {
      for (uint64_t frame = first; frame < old.end_frame; ++frame) {
        storage[offsets[slot] + channel * capacities[slot] + (frame & (capacities[slot] - 1u))]
          = core.graph_tap_storage[old.offset + channel * old.capacity + (frame & (old.capacity - 1u))];
      }
    }
  }
  for (uint32_t slot = 0; slot < capacities.size(); ++slot) {
    core.graph_tap_histories[slot].offset = offsets[slot];
    core.graph_tap_histories[slot].capacity = capacities[slot];
  }
  core.graph_tap_storage = std::move(storage);
  return true;
}
#endif

// Control-side read-head preparation. Keep the compiler's validated minimum
// table for stopped playback; a running graph pins its master budget on lowers.
// Heads share the retained pre-gain tap, never another copy of the signal.
daw_audio_core_result prepare_latency_heads(Core &core, GraphRevision &next, bool stopped = false) {
  const auto &current = *core.published_graph;
  const bool running = !stopped && core.transport_running.load(std::memory_order_acquire);
  std::array<uint32_t, kMaximumGraphNodes> padding{};
  std::array<bool, kMaximumGraphNodes> spectral_raise{};
  if (running) for (uint32_t index = 0; index < next.processor_count; ++index) {
    const auto &processor = next.processors[index];
    padding[processor.node_index] += processor.spectral_compensation;
    if (processor.spectral_predecessor >= 0) {
      const auto &prior = next.spectral_predecessors[processor.spectral_predecessor];
      spectral_raise[processor.node_index] = spectral_raise[processor.node_index]
        || processor.spectral.fft_size + processor.spectral_compensation
          > prior.spectral.fft_size + prior.spectral_compensation;
    }
  }
  const uint32_t old_budget = core.latency_budget.load(std::memory_order_acquire);
  std::array<uint32_t, kMaximumGraphNodes> paths{};
  std::array<uint32_t, kMaximumGraphNodes> inputs{};
  std::array<bool, kMaximumGraphNodes> kept{};
  std::array<bool, kMaximumGraphNodes> normal{};
  for (uint32_t ordered = 0; ordered < next.node_count; ++ordered) {
    const uint32_t node = next.process_order[ordered];
    const auto range = next.incoming_edge_ranges[node];
    kept[node] = next.nodes[node].keep_latency != 0;
    normal[node] = range.count == 0 && !kept[node];
    for (uint32_t position = range.start; position < range.start + range.count; ++position) {
      const uint32_t edge = next.incoming_edge_indices[position];
      const uint32_t source = next.edge_source_indices[edge];
      if (source >= next.node_count) continue;
      kept[node] = kept[node] || kept[source];
      if (!normal[source]) continue;
      normal[node] = true;
      uint32_t arrival = paths[source];
      if (next.edges[edge].tap == DAW_AUDIO_GRAPH_EDGE_PRE_FX)
        arrival -= next.nodes[source].latency_frames + next.nodes[source].external_latency_frames + padding[source];
      inputs[node] = std::max(inputs[node], arrival);
    }
    if (next.nodes[node].keep_latency != 0) normal[node] = false;
    const uint64_t path_latency = static_cast<uint64_t>(inputs[node]) + next.nodes[node].latency_frames
      + next.nodes[node].external_latency_frames + padding[node];
    const auto latency_result = validate_graph_path_latency(core, node, path_latency);
    if (latency_result != DAW_AUDIO_CORE_OK) return latency_result;
    paths[node] = static_cast<uint32_t>(path_latency);
  }
  next.minimum_latency = normal[next.master_index] ? paths[next.master_index] : 0u;
  next.latency_budget = running ? std::max(old_budget, next.minimum_latency) : next.minimum_latency;
  next.latency_raise = running && current.revision != 0 && next.latency_budget > old_budget
    ? next.latency_budget - old_budget : 0;
  next.latency_origin = core.completed_graph_frame.load(std::memory_order_acquire);
  next.latency_end = next.latency_origin;
  if (next.latency_raise != 0) next.latency_end += next.fade_frames * 2u;
  // Normal contributions enter a mixed bus already compensated to output
  // content time. The shared bus (and every downstream bus/return) then needs
  // no compensation, preserving the monitored contribution without DSP lanes.
  std::array<uint32_t, kMaximumGraphNodes> downstream{};
  std::array<uint32_t, kMaximumGraphNodes> shortest{};
  shortest.fill(UINT32_MAX);
  shortest[next.master_index] = downstream[next.master_index] = next.nodes[next.master_index].latency_frames
    + next.nodes[next.master_index].external_latency_frames + padding[next.master_index];
  for (uint32_t ordered = next.node_count; ordered-- > 0;) {
    const uint32_t target = next.process_order[ordered];
    const auto range = next.incoming_edge_ranges[target];
    for (uint32_t position = range.start; position < range.start + range.count; ++position) {
      const uint32_t edge = next.incoming_edge_indices[position];
      const uint32_t source = next.edge_source_indices[edge];
      if (source >= next.node_count) continue;
      if (shortest[target] == UINT32_MAX) continue;
      const uint32_t latency = next.edges[edge].tap == DAW_AUDIO_GRAPH_EDGE_PRE_FX ? 0u
        : next.nodes[source].latency_frames + next.nodes[source].external_latency_frames + padding[source];
      downstream[source] = std::max(downstream[source], downstream[target] + latency);
      shortest[source] = std::min(shortest[source], shortest[target] + latency);
    }
  }
  // One shared nonlinear bus cannot give its normal contribution two different
  // pre-merge delays without executing independent DSP lanes. Reject that
  // topology explicitly rather than delaying its monitored contribution.
  for (uint32_t node = 0; node < next.node_count; ++node)
    if (kept[node] && normal[node] && shortest[node] != UINT32_MAX && shortest[node] != downstream[node]) {
      core.graph_validation_diagnostic = {
        .code = DAW_AUDIO_CORE_GRAPH_VALIDATION_KEEP_LATENCY_DIVERGENT_MIXED_BUS,
        .index = node, .actual = downstream[node], .limit = shortest[node]};
      return DAW_AUDIO_CORE_GRAPH_COMPATIBILITY_REJECTED;
    }
  std::array<uint16_t, kMaximumGraphEdges> old_edges{};
  for (uint32_t edge = 0; edge < current.edge_count; ++edge) old_edges[edge] = static_cast<uint16_t>(edge);
  const auto old_end = old_edges.begin() + current.edge_count;
  std::sort(old_edges.begin(), old_end, [&](uint16_t left, uint16_t right) {
    return current.edges[left].id < current.edges[right].id;
  });
  for (uint32_t edge = 0; edge < next.edge_count; ++edge) {
    const uint32_t source = next.edge_source_indices[edge];
    const uint32_t target = next.edge_target_indices[edge];
    auto &head = next.read_heads[edge];
    uint32_t arrival = paths[source];
    if (next.edges[edge].tap == DAW_AUDIO_GRAPH_EDGE_PRE_FX)
      arrival -= next.nodes[source].latency_frames + next.nodes[source].external_latency_frames + padding[source];
    const bool skip = kept[source] || next.nodes[target].keep_latency != 0;
    head.stopped_delay = skip || inputs[target] <= arrival ? 0u : inputs[target] - arrival;
    head.delay = head.stopped_delay;
    if (!skip && kept[target]) {
      const uint32_t remaining = downstream[target];
      head.stopped_delay = next.minimum_latency > remaining + arrival ? next.minimum_latency - remaining - arrival : 0u;
      head.delay = next.latency_budget > remaining + arrival ? next.latency_budget - remaining - arrival : 0u;
    } else if (!skip && target == next.master_index) head.delay += next.latency_budget - next.minimum_latency;
    head.previous_delay = head.delay;
    const auto delay_result = validate_graph_path_latency(core, target, head.delay);
    if (delay_result != DAW_AUDIO_CORE_OK) return delay_result;
    const auto stopped_delay_result = validate_graph_path_latency(core, target, head.stopped_delay);
    if (stopped_delay_result != DAW_AUDIO_CORE_OK) return stopped_delay_result;
    const auto &after = next.edges[edge];
    const auto old = std::lower_bound(old_edges.begin(), old_end, after.id, [&](uint16_t index, uint64_t id) {
      return current.edges[index].id < id;
    });
    const bool retained = old != old_end && current.edges[*old].id == after.id
      && current.edges[*old].from_node_id == after.from_node_id
      && current.edges[*old].to_node_id == after.to_node_id && current.edges[*old].tap == after.tap
      && current.edges[*old].sidechain == after.sidechain
      && current.edges[*old].target_processor_id == after.target_processor_id;
    if (retained) {
      head.previous_delay = running && old_budget == current.latency_budget
        && core.latency_shrunk_revision.load(std::memory_order_acquire) != current.revision
        ? current.read_heads[*old].delay : current.read_heads[*old].stopped_delay;
    }
    head.seam = next.latency_origin;
    if (running && retained && head.previous_delay != head.delay) {
      if (next.latency_raise != 0) head.seam += next.fade_frames;
      else {
        head.seam += std::max(head.previous_delay, head.delay);
        head.crossfade_frames = next.fade_frames * 2u;
      }
      next.latency_end = std::max(next.latency_end, head.seam + head.crossfade_frames);
    }
    // A spectral raise already aligns the predecessor to the new stage at the
    // write seam. Read the new tap segment at that segment's arrival, instead
    // of mixing read heads with incompatible effective source latencies.
    if (running && retained && after.tap != DAW_AUDIO_GRAPH_EDGE_PRE_FX && spectral_raise[source]) {
      head.seam = next.latency_origin + (next.latency_raise != 0 ? next.fade_frames : 0u) + head.delay;
      head.crossfade_frames = 0;
      next.latency_end = std::max(next.latency_end, head.seam);
    }
  }
  if (running) {
    // Stopped playback removes stage-local compensation as well as the pinned
    // master budget. Prepare that independent raw-latency table off-thread.
    std::array<uint32_t, kMaximumGraphEdges> delays{};
    const auto budget = next.latency_budget, raise = next.latency_raise;
    const auto end = next.latency_end;
    const auto origin = next.latency_origin;
    const auto heads = next.read_heads;
    PrepareScope stopped_scope(core, "latency-heads-stopped");
    const auto result = prepare_latency_heads(core, next, true);
    stopped_scope.Finish();
    if (result != DAW_AUDIO_CORE_OK) return result;
    for (uint32_t edge = 0; edge < next.edge_count; ++edge) delays[edge] = next.read_heads[edge].stopped_delay;
    const auto raw_minimum = next.minimum_latency;
    next.read_heads = heads;
    for (uint32_t edge = 0; edge < next.edge_count; ++edge) next.read_heads[edge].stopped_delay = delays[edge];
    next.latency_budget = budget;
    next.minimum_latency = raw_minimum;
    next.latency_raise = raise;
    next.latency_end = end;
    next.latency_origin = origin;
  }
  return DAW_AUDIO_CORE_OK;
}
}  // namespace


extern "C" daw_audio_core_result daw_audio_core_prepare(
  daw_audio_core_handle core_handle,
  const daw_audio_core_prepare_request *request) {
  Core *core = to_core(core_handle);
  if (core == nullptr || request == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (!valid_abi(request->abi_version)) return DAW_AUDIO_CORE_UNSUPPORTED_VERSION;
  if (request->graph_revision == 0) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  core->prepared_revision = request->graph_revision;
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_prepare_graph(
  daw_audio_core_handle core_handle,
  const daw_audio_graph_prepare_request *request) {
  Core *core = to_core(core_handle);
  if (core == nullptr || request == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  // Ghosts copy the published plan's processors, which applying a patch rewrites
  // in the callback: preparing beside an unresolved patch would read a torn plan.
  for (uint32_t index = 0; index < 2; ++index) {
    if (core->staged_processor_state_patches[index].state.load(std::memory_order_acquire) >= 2) {
      return DAW_AUDIO_CORE_PROCESSOR_PATCH_PENDING;
    }
  }
  GraphRevision *prepared = &core->graph_prepare_scratch[0];
  PrepareScope validate_scope(*core, "validate");
  const daw_audio_core_result result = prepare_graph_revision(*core, *request, prepared);
  validate_scope.Finish();
  if (result != DAW_AUDIO_CORE_OK) return result;
  {
    PrepareScope scope(*core, "copy");
    // A new prepare replaces any unpublished plan: its fresh slots go back first.
    release_prepared_runtime(*core);
    core->prepared_revision = 0;
    reclaim_retired_slots(*core);
    (*core->prepared_graph) = *prepared;
  }
  PrepareScope ownership_scope(*core, "ownership");
  const daw_audio_core_result ownership = prepare_runtime_ownership(*core);
  ownership_scope.Finish();
  if (ownership != DAW_AUDIO_CORE_OK) {
    release_prepared_runtime(*core);
    return ownership;
  }
  PrepareScope latency_scope(*core, "latency-heads");
  const auto latency = prepare_latency_heads(*core, *core->prepared_graph);
  latency_scope.Finish();
  if (latency != DAW_AUDIO_CORE_OK) {
    release_prepared_runtime(*core);
    return latency;
  }
  PrepareScope taps_scope(*core, "tap-histories");
  const bool tapped = prepare_tap_histories(*core, *core->prepared_graph);
  taps_scope.Finish();
  if (!tapped) {
    release_prepared_runtime(*core);
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
#if !defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  if (!configure_portable_tap_histories(*core, *core->prepared_graph)) {
    release_prepared_runtime(*core);
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
#endif
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  PrepareScope hooks_scope(*core, "native-stages");
  std::destroy_at(core->prepared_native_hooks);
  std::construct_at(core->prepared_native_hooks);
  if (!initialize_native_graph_stages(*core->prepared_native_hooks, *core->prepared_graph)) {
    release_prepared_runtime(*core);
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
#endif
  core->prepared_revision = request->graph_revision;
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_prepare_graph_bytes(
  daw_audio_core_handle core_handle,
  const uint8_t *graph_bytes,
  const uint32_t graph_byte_count) {
  Core *core = to_core(core_handle);
  if (core == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  core->graph_validation_diagnostic = {};
  begin_prepare_profile(*core);
  PrepareScope parse_scope(*core, "parse");
  std::array<daw_audio_graph_node_descriptor, kMaximumLiveNodes> nodes{};
  std::array<daw_audio_graph_edge_descriptor, kMaximumLiveEdges> edges{};
  std::array<daw_audio_processor_descriptor, kMaximumLiveProcessors> processors{};
  std::array<std::array<uint32_t, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS>, kMaximumLiveProcessors> targets{};
  std::array<std::array<uint8_t, DAW_AUDIO_CORE_MAX_PROCESSOR_STATE_BYTES>, kMaximumLiveProcessors> states{};
  daw_audio_graph_prepare_request request{};
  if (!wasm_parse_graph(
    graph_bytes,
    graph_byte_count,
    &request,
    &nodes,
    &edges,
    &processors,
    &targets,
    &states
  )) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  parse_scope.Finish();
  return daw_audio_core_prepare_graph(core_handle, &request);
}

extern "C" daw_audio_core_graph_validation_diagnostic daw_audio_core_get_graph_validation_diagnostic(
  const daw_audio_core_handle core_handle) {
  const Core *core = to_core(core_handle);
  return core == nullptr ? daw_audio_core_graph_validation_diagnostic{} : core->graph_validation_diagnostic;
}
