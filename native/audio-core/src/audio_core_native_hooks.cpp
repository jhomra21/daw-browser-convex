#include "audio_core_internal.h"


#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
namespace {
bool configuration_instrument_matches(Core& core, const uint64_t node_id, const uint32_t kind) {
  const auto& graph = configuration_graph(core);
  const auto index = graph_node_index(graph, node_id);
  return index >= 0 && graph.nodes[index].kind == DAW_AUDIO_GRAPH_NODE_INSTRUMENT
    && graph.nodes[index].instrument.kind == kind;
}

bool retained_scheduled_node(const GraphRevision& previous, const GraphRevision& next, uint64_t id) {
  const auto old_index = graph_node_index(previous, id);
  const auto new_index = graph_node_index(next, id);
  return old_index >= 0 && new_index >= 0
    && previous.nodes[old_index].kind == next.nodes[new_index].kind
    && previous.node_slots[old_index] == next.node_slots[new_index]
    && previous.node_generations[old_index] == next.node_generations[new_index];
}

const GraphRevision::Processor* scheduled_processor(const GraphRevision& graph, uint64_t id) {
  const auto end = graph.scheduled_processor_lookup.begin() + graph.processor_count;
  const auto found = std::lower_bound(graph.scheduled_processor_lookup.begin(), end, id,
    [&graph](uint16_t index, uint64_t target) { return graph.processors[index].instance_id < target; });
  return found != end && graph.processors[*found].instance_id == id ? &graph.processors[*found] : nullptr;
}

const daw_audio_graph_node_descriptor* scheduled_mixer(const GraphRevision& graph, uint64_t id) {
  const auto end = graph.scheduled_mixer_lookup.begin() + graph.node_count;
  const auto found = std::lower_bound(graph.scheduled_mixer_lookup.begin(), end, id,
    [&graph](uint16_t index, uint64_t target) { return graph.nodes[index].mixer.instance_id < target; });
  return found != end && graph.nodes[*found].mixer.instance_id == id ? &graph.nodes[*found] : nullptr;
}
}

bool daw::audio_core::RetainsScheduledTarget(const daw_audio_core_handle handle,
  const uint32_t previous_revision, const daw_audio_sample_source_event& event) noexcept {
  const Core* core = to_core(handle);
  return core != nullptr && core->prepared_graph->revision == previous_revision
    && retained_scheduled_node(*core->prepared_graph, *core->published_graph, event.source_node_id);
}

bool daw::audio_core::RetainsScheduledTarget(const daw_audio_core_handle handle,
  const uint32_t previous_revision, const daw_audio_processor_event& event) noexcept {
  const Core* core = to_core(handle);
  if (core == nullptr || core->prepared_graph->revision != previous_revision) return false;
  const auto& previous = *core->prepared_graph;
  const auto& next = *core->published_graph;
  const auto* old_processor = scheduled_processor(previous, event.processor_instance_id);
  const auto* new_processor = scheduled_processor(next, event.processor_instance_id);
  if (old_processor != nullptr && new_processor != nullptr)
    return old_processor->node_id == new_processor->node_id && old_processor->kind == new_processor->kind
      && retained_scheduled_node(previous, next, new_processor->node_id)
      && processor_declares_target(*new_processor, event.parameter_target);
  const auto* old_mixer = scheduled_mixer(previous, event.processor_instance_id);
  const auto* new_mixer = scheduled_mixer(next, event.processor_instance_id);
  return old_processor == nullptr && new_processor == nullptr && old_mixer != nullptr && new_mixer != nullptr
    && old_mixer->id == new_mixer->id && retained_scheduled_node(previous, next, new_mixer->id)
    && valid_mixer_parameter_value(event.parameter_target, event.value);
}

daw::audio_core::NativeLatencyTransition daw::audio_core::InspectLatencyTransition(
  const daw_audio_core_handle handle) noexcept {
  const Core *core = to_core(handle);
  if (core == nullptr) return {};
  return {
    .budget = core->latency_budget.load(std::memory_order_acquire),
    .revision = core->latency_move_revision.load(std::memory_order_acquire),
    .completed_revision = core->latency_completed_revision.load(std::memory_order_acquire),
    .completed_frame = core->completed_graph_frame.load(std::memory_order_acquire),
  };
}

std::uint32_t daw::audio_core::PublishedGraphLatency(const daw_audio_core_handle handle) noexcept {
  const Core *core = to_core(handle);
  return core == nullptr ? 0u : core->published_graph->minimum_latency;
}

std::uint32_t daw::audio_core::PublishedGraphSpectralPredecessors(const daw_audio_core_handle handle) noexcept {
  const Core *core = to_core(handle);
  return core == nullptr ? 0u : core->published_graph->spectral_predecessor_count;
}

void daw::audio_core::SetPrepareProfiling(const daw_audio_core_handle handle, const bool enabled) noexcept {
  if (Core *core = to_core(handle); core != nullptr) core->prepare_profiling = enabled;
}

std::span<const daw::audio_core::PrepareStepTime> daw::audio_core::LastPrepareProfile(
  const daw_audio_core_handle handle) noexcept {
  const Core *core = to_core(handle);
  return core == nullptr ? std::span<const PrepareStepTime>{}
    : std::span<const PrepareStepTime>(core->prepare_steps.data(), core->prepare_step_count);
}

void daw::audio_core::StopLatencyTransition(const daw_audio_core_handle handle) noexcept {
  Core *core = to_core(handle);
  if (core == nullptr) return;
  core->latency_shrunk_revision = core->published_revision;
  core->latency_budget.store(core->published_graph->minimum_latency, std::memory_order_release);
  core->transport_running.store(false, std::memory_order_release);
  core->latency_completed_revision.store(core->published_revision, std::memory_order_release);
}

bool daw::audio_core::ValidateInstrumentState(
  const daw_audio_core_handle handle, const uint64_t node_id,
  const daw_audio_synth_state& state) noexcept {
  auto* core = to_core(handle);
  return core != nullptr && configuration_instrument_matches(*core, node_id, DAW_AUDIO_INSTRUMENT_KIND_SYNTH)
    && valid_synth_state(state);
}

bool daw::audio_core::ValidateInstrumentState(
  const daw_audio_core_handle handle, const uint64_t node_id, const uint32_t kind,
  const daw_audio_sampler_state& state, const std::span<const daw_audio_sample_zone> zones) noexcept {
  auto* core = to_core(handle);
  if (core == nullptr || (kind != DAW_AUDIO_INSTRUMENT_KIND_SAMPLER && kind != DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK)
    || !configuration_instrument_matches(*core, node_id, kind)
    || !valid_sampler_state(state) || zones.size() != state.zone_count) return false;
  for (const auto& zone : zones) {
    if (!valid_sample_zone(*core, zone)
      || (kind == DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK
        && (zone.key_low != zone.key_high || zone.round_robin_group != 0))) return false;
  }
  return true;
}

bool daw::audio_core::ValidateInstrumentState(
  const daw_audio_core_handle handle, const uint64_t node_id,
  const daw_audio_granular_state& state) noexcept {
  auto* core = to_core(handle);
  return core != nullptr && configuration_instrument_matches(*core, node_id, DAW_AUDIO_INSTRUMENT_KIND_GRANULAR)
    && valid_granular_state(*core, state);
}

daw_audio_core_result daw::audio_core::RegisterNativeGraphHook(
  const daw_audio_core_handle core_handle,
  const NativeGraphHookRegistration& registration
) noexcept {
  Core *core = to_core(core_handle);
  if (core == nullptr || registration.graph_revision == 0
    || (registration.hook == nullptr && (registration.observer == nullptr || !registration.bindings.empty()))
    || registration.bindings.size() > kMaximumLiveNodes
    || core->prepared_revision != registration.graph_revision
    || (*core->prepared_graph).revision != registration.graph_revision) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  NativeGraphHooks next{};
  if (!initialize_native_graph_stages(next, *core->prepared_graph)) {
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
  next.revision = registration.graph_revision;
  next.hook = registration.hook;
  next.observer = registration.observer;
  next.observer_attachment = registration.observer_attachment;
  if (next.observer != nullptr && next.observer_attachment == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  std::array<std::array<NativeGraphHookBinding, DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE>, kMaximumLiveNodes> node_bindings{};
  std::array<std::uint32_t, kMaximumGraphNodes> node_binding_counts{};
  for (const NativeGraphHookBinding& binding : registration.bindings) {
    const int32_t node_index = graph_node_index((*core->prepared_graph), binding.node_id);
    if (node_index < 0 || binding.attachment == nullptr
      || node_binding_counts[static_cast<uint32_t>(node_index)] >= DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE
      || (binding.stage_role != daw::audio_core::NativeGraphStageRole::kEffect
        && binding.stage_role != daw::audio_core::NativeGraphStageRole::kInstrument)
      || (*core->prepared_graph).nodes[static_cast<uint32_t>(node_index)].output_layout != binding.output_layout
      || (*core->prepared_graph).nodes[static_cast<uint32_t>(node_index)].external_latency_frames
        != binding.external_latency_frames
      || (binding.pdc_latency_frames != 0
        && ((*core->prepared_graph).nodes[static_cast<uint32_t>(node_index)].latency_frames
          > std::numeric_limits<uint32_t>::max() - binding.external_latency_frames
          || (*core->prepared_graph).nodes[static_cast<uint32_t>(node_index)].latency_frames
            + binding.external_latency_frames != binding.pdc_latency_frames))
      || (binding.stage_index != daw::audio_core::kNativeGraphStageAppend
        && binding.stage_index >= kMaximumNativeGraphStagesPerNode)
      || (binding.stage_role == daw::audio_core::NativeGraphStageRole::kInstrument
        && ((*core->prepared_graph).nodes[static_cast<uint32_t>(node_index)].kind != DAW_AUDIO_GRAPH_NODE_INSTRUMENT
          || binding.stage_index != 0))) {
      return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
    node_bindings[static_cast<uint32_t>(node_index)][node_binding_counts[static_cast<uint32_t>(node_index)]++] = binding;
  }
  for (std::uint32_t node_index = 0; node_index < (*core->prepared_graph).node_count; ++node_index) {
    const std::uint32_t binding_count = node_binding_counts[node_index];
    if (binding_count == 0) continue;
    // External stages are placed among the plan's own processors. Fading ghosts
    // are not part of that numbering; they are put back after their anchors below.
    std::array<NativeGraphStage, kMaximumNativeGraphStagesPerNode> ordinary_stages{};
    std::array<NativeGraphStage, kMaximumNativeGraphStagesPerNode> ghost_stages{};
    std::uint32_t ordinary_count = 0;
    std::uint32_t ghost_count = 0;
    for (std::uint32_t stage_index = 0; stage_index < next.stage_counts[node_index]; ++stage_index) {
      const NativeGraphStage &stage = next.stages[node_index][stage_index];
      if ((*core->prepared_graph).processors[stage.processor_index].ghost) ghost_stages[ghost_count++] = stage;
      else ordinary_stages[ordinary_count++] = stage;
    }
    std::uint32_t effect_count = 0;
    for (std::uint32_t binding_index = 0; binding_index < binding_count; ++binding_index) {
      const NativeGraphHookBinding &binding = node_bindings[node_index][binding_index];
      if (binding.stage_role == daw::audio_core::NativeGraphStageRole::kInstrument) {
        if (next.has_instrument_sources[node_index]) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
        next.instrument_sources[node_index] = {
          .kind = NativeGraphStageKind::kExternal,
          .processor_index = 0,
          .attachment = binding.attachment,
          .role = binding.stage_role,
        };
        next.has_instrument_sources[node_index] = true;
      } else {
        ++effect_count;
      }
    }
    const std::uint32_t final_count = ordinary_count + effect_count;
    const std::uint32_t chain_end = final_count;
    if (final_count > kMaximumNativeGraphStagesPerNode) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    std::array<NativeGraphStage, kMaximumNativeGraphStagesPerNode> rebuilt{};
    std::array<bool, kMaximumNativeGraphStagesPerNode> occupied{};
    for (std::uint32_t binding_index = 0; binding_index < binding_count; ++binding_index) {
      const NativeGraphHookBinding &binding = node_bindings[node_index][binding_index];
      if (binding.stage_role == daw::audio_core::NativeGraphStageRole::kInstrument
        || binding.stage_index == daw::audio_core::kNativeGraphStageAppend) continue;
      const std::uint32_t position = binding.stage_index;
      if (position >= chain_end || occupied[position]) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
      occupied[position] = true;
      rebuilt[position] = {
        .kind = NativeGraphStageKind::kExternal,
        .processor_index = 0,
        .attachment = binding.attachment,
        .role = binding.stage_role,
      };
    }
    for (std::uint32_t binding_index = 0; binding_index < binding_count; ++binding_index) {
      const NativeGraphHookBinding &binding = node_bindings[node_index][binding_index];
      if (binding.stage_role == daw::audio_core::NativeGraphStageRole::kInstrument
        || binding.stage_index != daw::audio_core::kNativeGraphStageAppend) continue;
      std::uint32_t position = ordinary_count;
      while (position < chain_end && occupied[position]) ++position;
      if (position == chain_end) {
        position = 0;
        while (position < chain_end && occupied[position]) ++position;
      }
      if (position == chain_end) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
      occupied[position] = true;
      rebuilt[position] = {
        .kind = NativeGraphStageKind::kExternal,
        .processor_index = 0,
        .attachment = binding.attachment,
        .role = binding.stage_role,
      };
    }
    std::uint32_t built_in_index = 0;
    for (std::uint32_t position = 0; position < chain_end; ++position) {
      if (occupied[position]) continue;
      if (built_in_index >= ordinary_count) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
      rebuilt[position] = ordinary_stages[built_in_index++];
    }
    if (built_in_index != ordinary_count) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    std::uint32_t total_count = final_count;
    for (std::uint32_t ghost_index = 0; ghost_index < ghost_count; ++ghost_index) {
      const int32_t anchor = (*core->prepared_graph).processors[ghost_stages[ghost_index].processor_index].chain_anchor;
      std::uint32_t position = 0;
      if (anchor >= 0) {
        while (position < total_count && !(rebuilt[position].kind == NativeGraphStageKind::kBuiltIn
          && rebuilt[position].processor_index == anchor)) ++position;
        if (position == total_count) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
        ++position;
      }
      if (total_count >= kMaximumNativeGraphStagesPerNode) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
      for (std::uint32_t end = total_count++; end > position; --end) rebuilt[end] = rebuilt[end - 1];
      rebuilt[position] = ghost_stages[ghost_index];
    }
    next.stages[node_index] = rebuilt;
    next.stage_counts[node_index] = total_count;
  }
  *core->prepared_native_hooks = next;
  return DAW_AUDIO_CORE_OK;
}
#endif

#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
// DAW_REALTIME_CALLBACK_HELPER_BEGIN native-source-seam-declarations
static_assert(kMaximumSampleSources == daw::audio_core::kMaximumSourceDeclarations);
static_assert(kMaximumLiveNodes == daw::audio_core::kMaximumGraphViewNodes
  && kMaximumLiveEdges == daw::audio_core::kMaximumGraphViewEdges);

std::unique_ptr<const daw::audio_core::GraphView> daw::audio_core::DecodeGraphView(
  const std::span<const uint8_t> envelope) noexcept {
  struct Scratch {
    std::array<daw_audio_processor_descriptor, kMaximumLiveProcessors> processors{};
    std::array<std::array<uint32_t, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS>, kMaximumLiveProcessors> targets{};
    std::array<std::array<uint8_t, DAW_AUDIO_CORE_MAX_PROCESSOR_STATE_BYTES>, kMaximumLiveProcessors> states{};
  };
  const std::unique_ptr<Scratch> scratch{new (std::nothrow) Scratch{}};
  std::unique_ptr<GraphView> view{new (std::nothrow) GraphView{}};
  if (scratch == nullptr || view == nullptr || envelope.size() > UINT32_MAX) return nullptr;
  daw_audio_graph_prepare_request request{};
  const auto size = static_cast<uint32_t>(envelope.size());
  if (!wasm_parse_graph(envelope.data(), size, &request, &view->nodes, &view->edges, &scratch->processors,
    &scratch->targets, &scratch->states)) return nullptr;
  uint32_t offset = 0;
  static_cast<void>(wasm_read_u32(envelope.data(), size, &offset, &view->version));
  view->node_count = request.node_count;
  view->edge_count = request.edge_count;
  return view;
}

std::optional<daw::audio_core::SourceReconciliation> daw::audio_core::AdmitSampleSources(daw_audio_core_handle handle,
  std::span<const daw_audio_sample_source_event> events, int64_t frame) noexcept {
  Core *core = to_core(handle);
  if (core == nullptr || events.size() > kMaximumSampleSources) return std::nullopt;
  uint64_t floor = core->last_event_sequence;
  const auto &graph = configuration_graph(*core);
  // Only a hard replace stages in the inactive table, and the host never calls it, so the callback may borrow it.
  auto &declared = inactive_sample_source_table(*core);
  for (uint32_t index = 0; index < events.size(); ++index) {
    const auto &event = events[index];
    if (!valid_sample_source_event(event) || event.start_frame > frame || event.stop_frame <= frame
      || event.epoch != core->transport.epoch || event.sequence <= floor) return std::nullopt;
    floor = event.sequence;
    const auto *asset = find_asset(core, event.asset);
    if (asset == nullptr || event.source_offset_frame >= asset->frame_count
      || event.source_frame_count > asset->frame_count - event.source_offset_frame) return std::nullopt;
    const auto node = graph_node_index(graph, event.source_node_id);
    if (node < 0 || graph.nodes[static_cast<uint32_t>(node)].kind != DAW_AUDIO_GRAPH_NODE_SOURCE) return std::nullopt;
    declared[index] = make_sample_source(event);
    bind_sample_source_node(declared[index], graph);
  }
  SourceReconciliationPlan plan;
  if (!plan_sample_source_reconciliation(*core, {declared.data(), events.size()}, frame, plan)) return std::nullopt;
  return SourceReconciliation{
    .core = handle, .frame = frame, .count = static_cast<std::uint32_t>(events.size()), .sequence_floor = floor};
}

void daw::audio_core::CommitSampleSources(daw_audio_core_handle handle, const SourceReconciliation &admitted) noexcept {
  Core *core = to_core(handle);
  if (core == nullptr || admitted.core != handle || admitted.count > kMaximumSampleSources) return;
  const std::span<const SampleSource> declared{inactive_sample_source_table(*core).data(), admitted.count};
  SourceReconciliationPlan plan;
  // Publication only retires nodes, which removes tails and frees slots, so the plan that fit at admission still fits.
  // The check keeps the tail slots in bounds if that ever stops holding.
  if (!plan_sample_source_reconciliation(*core, declared, admitted.frame, plan)) return;
  apply_sample_source_reconciliation(*core, declared, admitted.frame, plan);
  core->last_event_sequence = admitted.sequence_floor;
}
// DAW_REALTIME_CALLBACK_HELPER_END native-source-seam-declarations

void daw::audio_core::RequestAssetRetirement(daw_audio_core_handle handle, daw_audio_asset_handle asset) noexcept {
  Core *core = to_core(handle);
  uint32_t index = 0, generation = 0;
  if (core == nullptr || !decode_asset_handle(asset, &index, &generation)
    || index >= core->config.max_assets || find_asset(core, asset) == nullptr) return;
  auto& retirement = core->asset_retirements[index];
  auto open = retirement.load(std::memory_order_acquire);
  if ((open & 3U) == 0) retirement.compare_exchange_strong(open, open + 1, std::memory_order_release);
}

void daw::audio_core::CancelAssetRetirement(daw_audio_core_handle handle, daw_audio_asset_handle asset) noexcept {
  Core *core = to_core(handle);
  uint32_t index = 0, generation = 0;
  if (core == nullptr || !decode_asset_handle(asset, &index, &generation)
    || index >= core->config.max_assets || find_asset(core, asset) == nullptr) return;
  auto& retirement = core->asset_retirements[index];
  // Advance the ticket even when the callback is scanning this request. An old
  // scan cannot acknowledge a later request after renewed ownership (ABA).
  auto previous = retirement.load(std::memory_order_acquire);
  while (!retirement.compare_exchange_weak(previous, (previous & ~uint64_t{3}) + 4,
    std::memory_order_acq_rel)) {}
}

// DAW_REALTIME_CALLBACK_HELPER_BEGIN native-asset-reader-completion
bool daw::audio_core::CompleteAssetReaders(daw_audio_core_handle handle, uint64_t completing_epoch) noexcept {
  Core *core = to_core(handle);
  if (core == nullptr) return false;
  bool pending = false;
  for (uint32_t index = 0; index < core->config.max_assets; ++index)
    pending = pending || (core->asset_retirements[index].load(std::memory_order_acquire) & 3U) == 1;
  if (!pending) return false;
  bool ready = false;
  std::array<bool, kMaximumAssets> referenced{};
  const auto retain = [&](daw_audio_asset_handle asset) {
    uint32_t index = 0, generation = 0;
    if (decode_asset_handle(asset, &index, &generation) && index < core->config.max_assets) referenced[index] = true;
  };
  for (const auto &source : *core->active_sample_sources)
    if (source.active) retain(source.asset);
  for (uint32_t node = 0; node < kNodeRuntimeSlots; ++node) {
    // Prepared configuration belongs to the control thread and is protected
    // by its host lease. Only active/fading runtimes are callback readers.
    if (core->node_slots[node].state.load(std::memory_order_acquire) != kSlotActive) continue;
    const auto &instrument = core->instrument_runtime[node];
    for (uint32_t zone = 0; zone < instrument.sampler.zone_count; ++zone) retain(instrument.zones[zone].asset);
    for (const auto &voice : instrument.sample_voices) if (voice.active) retain(voice.asset);
    for (const auto &voice : instrument.dying_sample_voices) if (voice.active) retain(voice.asset);
    retain(instrument.granular.asset);
  }
  for (uint32_t index = 0; index < core->config.max_assets; ++index) {
    auto &retirement = core->asset_retirements[index];
    auto requested = retirement.load(std::memory_order_acquire);
    if ((requested & 3U) != 1) continue;
    // This host extension owns resident/mapped assets only. Portable paged
    // cache preparations keep their separate pin-count/release contract.
    if (!referenced[index] && !core->assets[index].paged) {
      core->asset_retirement_epochs[index].store(completing_epoch, std::memory_order_relaxed);
      ready = retirement.compare_exchange_strong(requested, requested + 1, std::memory_order_release) || ready;
    }
  }
  return ready;
}
// DAW_REALTIME_CALLBACK_HELPER_END native-asset-reader-completion

bool daw::audio_core::ReclaimAsset(daw_audio_core_handle handle, daw_audio_asset_handle asset,
  bool device_stopped, uint64_t completed_epoch) noexcept {
  Core *core = to_core(handle);
  if (core == nullptr) return false;
  uint32_t index = 0, generation = 0;
  if (!decode_asset_handle(asset, &index, &generation) || index >= core->config.max_assets) return false;
  auto &retirement = core->asset_retirements[index];
  if (device_stopped) {
    if (asset_is_active(*core, asset)) return false;
  } else if ((retirement.load(std::memory_order_acquire) & 3U) != 2
    || completed_epoch < core->asset_retirement_epochs[index].load(std::memory_order_relaxed)) return false;
  AssetSlot *slot = find_asset(core, asset);
  if (slot == nullptr) return false;
  // The callback never touches ready metadata. The host waits for the completed
  // render epoch before entering here and forbids new references meanwhile.
  release_asset_storage(core, slot, asset);
  const auto previous = retirement.load(std::memory_order_relaxed);
  retirement.store((previous & ~uint64_t{3}) + 4, std::memory_order_release);
  return true;
}
#endif
