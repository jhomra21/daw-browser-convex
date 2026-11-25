#include "audio_core_internal.h"

namespace {

int32_t graph_node_index_linear(const GraphRevision &graph, uint64_t id) {
  for (uint32_t index = 0; index < graph.node_count; ++index) {
    if (graph.nodes[index].id == id) return static_cast<int32_t>(index);
  }
  return -1;
}
}  // namespace

namespace daw::audio_core_internal {

int32_t graph_node_index(const GraphRevision &graph, uint64_t id) {
  uint32_t first = 0;
  uint32_t last = graph.node_count;
  while (first < last) {
    const uint32_t middle = first + (last - first) / 2;
    const uint32_t node_index = graph.node_lookup[middle];
    const uint64_t candidate = graph.nodes[node_index].id;
    if (candidate < id) first = middle + 1;
    else last = middle;
  }
  if (first >= graph.node_count) return -1;
  const uint32_t node_index = graph.node_lookup[first];
  return graph.nodes[node_index].id == id ? static_cast<int32_t>(node_index) : -1;
}

// Topological order over live and ghost nodes together, signal and sidechain
// edges alike: a key is always processed before the node it controls. False on a
// cycle.
bool order_graph_nodes(GraphRevision &graph) {
  std::array<uint32_t, kMaximumGraphNodes> remaining{};
  std::array<bool, kMaximumGraphNodes> ordered{};
  const uint32_t node_total = graph.total_node_count();
  const uint32_t edge_total = graph.total_edge_count();
  for (uint32_t edge_index = 0; edge_index < edge_total; ++edge_index) {
    ++remaining[graph.edge_target_indices[edge_index]];
  }
  for (uint32_t order_count = 0; order_count < node_total; ++order_count) {
    uint32_t next = kMaximumGraphNodes;
    for (uint32_t index = 0; index < node_total; ++index) {
      if (!ordered[index] && remaining[index] == 0) {
        next = index;
        break;
      }
    }
    if (next == kMaximumGraphNodes) return false;
    ordered[next] = true;
    graph.process_order[order_count] = next;
    for (uint32_t edge_index = 0; edge_index < edge_total; ++edge_index) {
      if (graph.edge_source_indices[edge_index] == next) --remaining[graph.edge_target_indices[edge_index]];
    }
  }
  return true;
}

void build_graph_ranges(GraphRevision &graph) {
  const uint32_t node_total = graph.total_node_count();
  const uint32_t edge_total = graph.total_edge_count();
  const uint32_t processor_total = graph.total_processor_count();
  graph.incoming_edge_ranges = {};
  graph.processor_ranges = {};
  graph.sidechain_edge_ranges = {};
  for (uint32_t edge_index = 0; edge_index < edge_total; ++edge_index) {
    if (graph.edges[edge_index].sidechain == 0) ++graph.incoming_edge_ranges[graph.edge_target_indices[edge_index]].count;
  }
  for (uint32_t processor_index = 0; processor_index < processor_total; ++processor_index) {
    ++graph.processor_ranges[graph.processors[processor_index].node_index].count;
  }
  uint16_t incoming_start = 0;
  uint16_t processor_start = 0;
  for (uint32_t node_index = 0; node_index < node_total; ++node_index) {
    graph.incoming_edge_ranges[node_index].start = incoming_start;
    graph.processor_ranges[node_index].start = processor_start;
    incoming_start = static_cast<uint16_t>(incoming_start + graph.incoming_edge_ranges[node_index].count);
    processor_start = static_cast<uint16_t>(processor_start + graph.processor_ranges[node_index].count);
  }
  std::array<uint16_t, kMaximumGraphNodes> incoming_fill{};
  std::array<uint16_t, kMaximumGraphNodes> processor_fill{};
  for (uint32_t edge_index = 0; edge_index < edge_total; ++edge_index) {
    if (graph.edges[edge_index].sidechain != 0) continue;
    const uint32_t target = graph.edge_target_indices[edge_index];
    graph.incoming_edge_indices[graph.incoming_edge_ranges[target].start + incoming_fill[target]++] =
      static_cast<uint16_t>(edge_index);
  }
  for (uint32_t processor_index = 0; processor_index < graph.processor_count; ++processor_index) {
    const uint32_t node_index = graph.processors[processor_index].node_index;
    graph.processor_indices[graph.processor_ranges[node_index].start + processor_fill[node_index]++] =
      static_cast<uint16_t>(processor_index);
  }
  // A ghost goes back where it stood in its chain: straight after the processor
  // it followed, so every retained processor still runs once and in order.
  // Ghosts are stored in their old chain order, so a ghost's anchor is placed
  // before the ghost itself.
  for (uint32_t processor_index = graph.processor_count; processor_index < processor_total; ++processor_index) {
    const GraphRevision::Processor &ghost = graph.processors[processor_index];
    uint16_t *chain = &graph.processor_indices[graph.processor_ranges[ghost.node_index].start];
    uint32_t position = 0;
    if (ghost.chain_anchor >= 0) {
      while (chain[position] != ghost.chain_anchor) ++position;
      ++position;
    }
    for (uint32_t end = processor_fill[ghost.node_index]++; end > position; --end) chain[end] = chain[end - 1];
    chain[position] = static_cast<uint16_t>(processor_index);
  }
  uint16_t sidechain_edge_count = 0;
  for (uint32_t processor_index = 0; processor_index < processor_total; ++processor_index) {
    GraphRevision::Range &sidechain_range = graph.sidechain_edge_ranges[processor_index];
    sidechain_range.start = sidechain_edge_count;
    for (uint32_t edge_index = 0; edge_index < edge_total; ++edge_index) {
      if (graph.edges[edge_index].sidechain != 0 && graph.edge_target_processors[edge_index] == processor_index) {
        graph.sidechain_edge_indices[sidechain_edge_count++] = static_cast<uint16_t>(edge_index);
        ++sidechain_range.count;
      }
    }
  }
}

daw_audio_core_result prepare_graph_revision(
  Core &core,
  const daw_audio_graph_prepare_request &request,
  GraphRevision *out_graph) {
  core.graph_validation_diagnostic = {};
  if (!valid_abi(request.abi_version)) return DAW_AUDIO_CORE_UNSUPPORTED_VERSION;
  if (request.graph_revision == 0 || request.node_count == 0 || request.node_count > kMaximumLiveNodes
    || request.edge_count > kMaximumLiveEdges || request.nodes == nullptr
    || (request.edge_count > 0 && request.edges == nullptr)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (request.processor_count > kMaximumLiveProcessors) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  if (request.processor_count > 0 && request.processors == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  GraphRevision &graph = core.graph_prepare_scratch[1];
  // Reset directly in preallocated storage. `graph = {}` materializes a full
  // graph temporary in debug builds and overflows macOS control-thread stacks.
  // This is control-only placement construction, with no storage allocation.
  std::destroy_at(&graph);
  std::construct_at(&graph);
  graph.revision = request.graph_revision;
  graph.node_count = request.node_count;
  graph.edge_count = request.edge_count;
  for (uint32_t index = 0; index < graph.node_count; ++index) {
    const daw_audio_graph_node_descriptor node = request.nodes[index];
    if (node.id == 0 || !valid_graph_node_kind(node.kind) || !valid_graph_layout(node.input_layout)
      || !valid_graph_layout(node.output_layout) || !valid_instrument_descriptor(node) || !valid_mixer_state(node.mixer)
      || node.keep_latency > 1
      // A source's bus indexes the block's input buses, which process caps at kMaximumChannels.
      || (node.kind == DAW_AUDIO_GRAPH_NODE_SOURCE
        && node.input_bus != DAW_AUDIO_GRAPH_INPUT_BUS_DISCONNECTED
        && node.input_bus >= kMaximumChannels)) {
      return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
    if (graph_node_index_linear(graph, node.id) >= 0) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    graph.nodes[index] = node;
    if (node.kind == DAW_AUDIO_GRAPH_NODE_MASTER) {
      if (graph.master_index != kMaximumGraphNodes) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
      graph.master_index = index;
    }
  }
  if (graph.master_index == kMaximumGraphNodes) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  for (uint32_t index = 0; index < graph.node_count; ++index) graph.node_lookup[index] = index;
  std::sort(graph.node_lookup.begin(), graph.node_lookup.begin() + graph.node_count, [&graph](uint32_t left, uint32_t right) {
    return graph.nodes[left].id < graph.nodes[right].id;
  });
  std::array<uint32_t, kMaximumGraphNodes> processor_counts{};
  for (uint32_t index = 0; index < request.processor_count; ++index) {
    const daw_audio_processor_descriptor &descriptor = request.processors[index];
    const int32_t node_index = graph_node_index(graph, descriptor.node_id);
    if (node_index < 0 || descriptor.instance_id == 0
      || descriptor.bypassed > 1 || !valid_graph_layout(descriptor.input_layout)
      || !valid_graph_layout(descriptor.output_layout)) {
      return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
    const ProcessorContract *contract = find_processor_contract(descriptor.kind);
    if (contract == nullptr) return DAW_AUDIO_CORE_PROCESSOR_KIND_UNKNOWN;
    if (descriptor.state_version != contract->schema_version || descriptor.state_size != contract->state_bytes
      || descriptor.state == nullptr) return DAW_AUDIO_CORE_PROCESSOR_STATE_INVALID;
    if (!contract->implemented) return DAW_AUDIO_CORE_PROCESSOR_IMPLEMENTATION_UNAVAILABLE;
    if (processor_counts[static_cast<uint32_t>(node_index)] >= DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE) {
      return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    }
    for (uint32_t existing = 0; existing < index; ++existing) {
      if (graph.processors[existing].instance_id == descriptor.instance_id) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
    GraphRevision::Processor &processor = graph.processors[index];
    processor.node_index = static_cast<uint16_t>(node_index);
    processor.control_slot = index;
    processor.node_id = descriptor.node_id;
    processor.instance_id = descriptor.instance_id;
    processor.kind = descriptor.kind;
    processor.state_version = descriptor.state_version;
    processor.bypassed = descriptor.bypassed;
    processor.input_layout = descriptor.input_layout;
    processor.output_layout = descriptor.output_layout;
    processor.latency_frames = descriptor.latency_frames;
    processor.tail_frames = descriptor.tail_frames;
    processor.state_size = descriptor.state_size;
    for (uint32_t byte = 0; byte < descriptor.state_size; ++byte) processor.state[byte] = descriptor.state[byte];
    if (!decode_processor_state(descriptor, core.config.sample_rate_hz, &processor)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    processor.parameter_count = descriptor.parameter_count;
    for (uint32_t parameter = 0; parameter < descriptor.parameter_count; ++parameter) {
      processor.parameter_targets[parameter] = descriptor.parameter_targets[parameter];
    }
    std::sort(
      processor.parameter_targets.begin(),
      processor.parameter_targets.begin() + processor.parameter_count);
    ++processor_counts[static_cast<uint32_t>(node_index)];
    ++graph.processor_count;
  }
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  for (uint32_t index = 0; index < graph.processor_count; ++index) graph.scheduled_processor_lookup[index] = index;
  std::sort(graph.scheduled_processor_lookup.begin(), graph.scheduled_processor_lookup.begin() + graph.processor_count,
    [&graph](uint16_t left, uint16_t right) { return graph.processors[left].instance_id < graph.processors[right].instance_id; });
  for (uint32_t index = 0; index < graph.node_count; ++index) graph.scheduled_mixer_lookup[index] = index;
  std::sort(graph.scheduled_mixer_lookup.begin(), graph.scheduled_mixer_lookup.begin() + graph.node_count,
    [&graph](uint16_t left, uint16_t right) { return graph.nodes[left].mixer.instance_id < graph.nodes[right].mixer.instance_id; });
#endif
  for (uint32_t node_index = 0; node_index < graph.node_count; ++node_index) {
    uint64_t chain_latency = 0;
    bool has_chain = false;
    uint32_t previous_layout = graph.nodes[node_index].input_layout;
    for (uint32_t processor_index = 0; processor_index < graph.processor_count; ++processor_index) {
      const GraphRevision::Processor &processor = graph.processors[processor_index];
      if (processor.node_id == graph.nodes[node_index].id) {
        has_chain = true;
        if (processor.input_layout != previous_layout) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
        previous_layout = processor.output_layout;
        chain_latency += processor.latency_frames;
      }
    }
    if (has_chain && (chain_latency != graph.nodes[node_index].latency_frames
      || previous_layout != graph.nodes[node_index].output_layout)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  for (uint32_t index = 0; index < graph.edge_count; ++index) {
    const daw_audio_graph_edge_descriptor edge = request.edges[index];
    const int32_t from_index = graph_node_index(graph, edge.from_node_id);
    const int32_t to_index = graph_node_index(graph, edge.to_node_id);
    if (edge.id == 0 || from_index < 0 || to_index < 0 || from_index == to_index
      || !std::isfinite(edge.gain) || !valid_graph_tap(edge.tap) || edge.sidechain > 1) {
      return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
    if ((edge.sidechain == 0 && edge.target_processor_id != 0) || (edge.sidechain != 0 && edge.target_processor_id == 0)) {
      return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
    if (edge.sidechain != 0) {
      const GraphRevision::Processor *target = nullptr;
      for (uint32_t processor_index = 0; processor_index < graph.processor_count; ++processor_index) {
        const GraphRevision::Processor &processor = graph.processors[processor_index];
        if (processor.instance_id == edge.target_processor_id) {
          target = &processor;
          graph.edge_target_processors[index] = static_cast<uint16_t>(processor_index);
          break;
        }
      }
      if (target == nullptr || target->node_id != edge.to_node_id
        || target->input_layout != graph.nodes[static_cast<uint32_t>(to_index)].input_layout) {
        return DAW_AUDIO_CORE_INVALID_ARGUMENT;
      }
    }
    if (edge.pdc_delay_frames > kMaximumGraphLatencyFrames) {
      core.graph_validation_diagnostic = {
        .code = DAW_AUDIO_CORE_GRAPH_VALIDATION_PDC_DELAY_EXCEEDS_RING_CAPACITY,
        .index = index,
        .actual = edge.pdc_delay_frames,
        .limit = kMaximumGraphLatencyFrames,
      };
      return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    }
    for (uint32_t existing = 0; existing < index; ++existing) {
      if (graph.edges[existing].id == edge.id) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
    graph.edges[index] = edge;
    graph.edge_source_indices[index] = static_cast<uint16_t>(from_index);
    graph.edge_target_indices[index] = static_cast<uint16_t>(to_index);
  }
  if (!order_graph_nodes(graph)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  std::array<uint32_t, kMaximumGraphNodes> path_latency{};
  const auto effective_node_latency = [&graph](const uint32_t node_index) -> uint32_t {
    const auto &node = graph.nodes[node_index];
    if (node.external_latency_frames > std::numeric_limits<uint32_t>::max() - node.latency_frames) {
      return std::numeric_limits<uint32_t>::max();
    }
    return node.latency_frames + node.external_latency_frames;
  };
  for (uint32_t ordered = 0; ordered < graph.node_count; ++ordered) {
    const uint32_t node_index = graph.process_order[ordered];
    uint32_t upstream_latency = 0;
    for (uint32_t edge_index = 0; edge_index < graph.edge_count; ++edge_index) {
      const daw_audio_graph_edge_descriptor &edge = graph.edges[edge_index];
      if (edge.sidechain != 0 || edge.to_node_id != graph.nodes[node_index].id) continue;
      const uint32_t source_index = graph.edge_source_indices[edge_index];
      uint32_t arrival = path_latency[source_index];
      if (edge.tap == DAW_AUDIO_GRAPH_EDGE_PRE_FX) {
        const uint32_t source_latency = effective_node_latency(source_index);
        if (arrival < source_latency) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
        arrival -= source_latency;
      }
      if (arrival > upstream_latency) upstream_latency = arrival;
    }
    const uint32_t node_latency = effective_node_latency(node_index);
    if (node_latency > std::numeric_limits<uint32_t>::max() - upstream_latency) {
      return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    }
    path_latency[node_index] = upstream_latency + node_latency;
    const auto latency_result = validate_graph_path_latency(core, node_index, path_latency[node_index]);
    if (latency_result != DAW_AUDIO_CORE_OK) return latency_result;
    for (uint32_t edge_index = 0; edge_index < graph.edge_count; ++edge_index) {
      const daw_audio_graph_edge_descriptor &edge = graph.edges[edge_index];
      if (edge.sidechain != 0 || edge.to_node_id != graph.nodes[node_index].id) continue;
      const uint32_t source_index = graph.edge_source_indices[edge_index];
      uint32_t arrival = path_latency[source_index];
      if (edge.tap == DAW_AUDIO_GRAPH_EDGE_PRE_FX) arrival -= effective_node_latency(source_index);
      if (edge.pdc_delay_frames != upstream_latency - arrival) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
  }
  build_graph_ranges(graph);
  graph.minimum_latency = path_latency[graph.master_index];
  if (!core.graph_stage_buffers) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  *out_graph = graph;
  return DAW_AUDIO_CORE_OK;
}
}  // namespace daw::audio_core_internal
