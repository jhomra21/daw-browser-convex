#include "audio_core_internal.h"

namespace {

std::unique_ptr<Core> wasm_utility_core{};
bool wasm_utility_initialized = false;
std::unique_ptr<Core> wasm_asset_core{};
bool wasm_asset_initialized = false;
/* Asset-only and graph bridges are mutually exclusive Wasm control planes.
 * Reuse their fixed storage so enabling graph processing does not inflate the
 * fixed linear-memory artifact by an additional Core instance. */
Core *wasm_graph_core = nullptr;
bool wasm_graph_initialized = false;
uint32_t wasm_graph_max_input_buses = 0;
daw_audio_core_handle wasm_recording_capture = 0;

bool wasm_read_u64(const uint8_t *bytes, uint32_t byte_count, uint32_t *offset, uint64_t *out) {
  uint32_t low = 0;
  uint32_t high = 0;
  if (!wasm_read_u32(bytes, byte_count, offset, &low) || !wasm_read_u32(bytes, byte_count, offset, &high)) return false;
  *out = static_cast<uint64_t>(low) | (static_cast<uint64_t>(high) << 32u);
  return true;
}

bool wasm_read_i64(const uint8_t *bytes, uint32_t byte_count, uint32_t *offset, int64_t *out) {
  uint64_t value = 0;
  if (!wasm_read_u64(bytes, byte_count, offset, &value)) return false;
  __builtin_memcpy(out, &value, sizeof(value));
  return true;
}

bool wasm_read_f32(const uint8_t *bytes, uint32_t byte_count, uint32_t *offset, float *out) {
  uint32_t bits = 0;
  if (!wasm_read_u32(bytes, byte_count, offset, &bits)) return false;
  __builtin_memcpy(out, &bits, sizeof(bits));
  return true;
}

uint32_t wasm_graph_kind(uint32_t kind) {
  if (kind == 1) return DAW_AUDIO_GRAPH_NODE_SOURCE;
  if (kind == 2) return DAW_AUDIO_GRAPH_NODE_INSTRUMENT;
  if (kind == 6) return DAW_AUDIO_GRAPH_NODE_MASTER;
  return DAW_AUDIO_GRAPH_NODE_MIXER;
}
}  // namespace

namespace daw::audio_core_internal {

bool wasm_parse_graph(
  const uint8_t *bytes,
  uint32_t byte_count,
  daw_audio_graph_prepare_request *out_request,
  std::array<daw_audio_graph_node_descriptor, kMaximumLiveNodes> *nodes,
  std::array<daw_audio_graph_edge_descriptor, kMaximumLiveEdges> *edges,
  std::array<daw_audio_processor_descriptor, kMaximumLiveProcessors> *processors,
  std::array<std::array<uint32_t, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS>, kMaximumLiveProcessors> *targets,
  std::array<std::array<uint8_t, DAW_AUDIO_CORE_MAX_PROCESSOR_STATE_BYTES>, kMaximumLiveProcessors> *states) {
  if (bytes == nullptr || byte_count < DAW_AUDIO_CORE_WASM_GRAPH_HEADER_BYTES) return false;
  uint32_t offset = 0;
  uint32_t version = 0;
  uint32_t revision = 0;
  uint32_t node_count = 0;
  uint32_t edge_count = 0;
  uint32_t processor_count = 0;
  uint32_t reserved = 0;
  if (!wasm_read_u32(bytes, byte_count, &offset, &version) || !wasm_read_u32(bytes, byte_count, &offset, &revision)
    || !wasm_read_u32(bytes, byte_count, &offset, &node_count) || !wasm_read_u32(bytes, byte_count, &offset, &edge_count)
    || !wasm_read_u32(bytes, byte_count, &offset, &processor_count) || !wasm_read_u32(bytes, byte_count, &offset, &reserved)
    || (version != DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION
      && version != DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION_EXTERNAL_LATENCY
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
      && version != DAW_AUDIO_CORE_NATIVE_GRAPH_ENVELOPE_VERSION_KEEP_LATENCY
#endif
      && version != DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION_LEGACY_2
      && version != DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION_LEGACY) || reserved != 0
    || revision == 0 || node_count == 0 || node_count > kMaximumLiveNodes || edge_count > kMaximumLiveEdges
    || processor_count > kMaximumLiveProcessors) return false;
  for (uint32_t index = 0; index < node_count; ++index) {
    uint64_t id = 0;
    uint32_t kind = 0;
    uint32_t input_layout = 0;
    uint32_t output_layout = 0;
    uint32_t input_bus = 0;
    uint32_t latency = 0;
    uint32_t external_latency = 0;
    uint32_t keep_latency = 0;
    if (!wasm_read_u64(bytes, byte_count, &offset, &id) || !wasm_read_u32(bytes, byte_count, &offset, &kind)
      || !wasm_read_u32(bytes, byte_count, &offset, &input_layout) || !wasm_read_u32(bytes, byte_count, &offset, &output_layout)
      || !wasm_read_u32(bytes, byte_count, &offset, &input_bus) || !wasm_read_u32(bytes, byte_count, &offset, &latency)) return false;
    if (version >= DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION_EXTERNAL_LATENCY
      && !wasm_read_u32(bytes, byte_count, &offset, &external_latency)) return false;
    if (version == DAW_AUDIO_CORE_NATIVE_GRAPH_ENVELOPE_VERSION_KEEP_LATENCY
      && (!wasm_read_u32(bytes, byte_count, &offset, &keep_latency) || keep_latency > 1)) return false;
    daw_audio_instrument_state_descriptor instrument{};
    if (version != DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION_LEGACY) {
      if (!wasm_read_u32(bytes, byte_count, &offset, &instrument.kind)
        || !wasm_read_u32(bytes, byte_count, &offset, &instrument.version)
        || !wasm_read_u32(bytes, byte_count, &offset, &instrument.voice_capacity)
        || !wasm_read_u32(bytes, byte_count, &offset, &instrument.parameter_count)
        || instrument.parameter_count > DAW_AUDIO_CORE_MAX_INSTRUMENT_PARAMETERS) return false;
      for (uint32_t target = 0; target < instrument.parameter_count; ++target) {
        if (!wasm_read_u32(bytes, byte_count, &offset, &instrument.parameter_targets[target])) return false;
      }
      for (uint32_t target = instrument.parameter_count; target < DAW_AUDIO_CORE_MAX_INSTRUMENT_PARAMETERS; ++target) {
        uint32_t ignored = 0;
        if (!wasm_read_u32(bytes, byte_count, &offset, &ignored)) return false;
      }
    }
    daw_audio_mixer_state mixer{};
    if (version == DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION
      || version >= DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION_EXTERNAL_LATENCY) {
      if (!wasm_read_u64(bytes, byte_count, &offset, &mixer.instance_id)
        || !wasm_read_f32(bytes, byte_count, &offset, &mixer.gain)
        || !wasm_read_f32(bytes, byte_count, &offset, &mixer.pan)
        || !wasm_read_u32(bytes, byte_count, &offset, &mixer.muted)
        || !wasm_read_u32(bytes, byte_count, &offset, &mixer.soloed)) return false;
    }
    (*nodes)[index] = {
      .id = id, .kind = wasm_graph_kind(kind), .input_layout = input_layout, .output_layout = output_layout,
      .input_bus = input_bus, .latency_frames = latency, .external_latency_frames = external_latency,
      .instrument = instrument, .mixer = mixer, .keep_latency = keep_latency,
    };
  }
  for (uint32_t index = 0; index < edge_count; ++index) {
    uint64_t id = 0;
    uint64_t from = 0;
    uint64_t to = 0;
    uint64_t target = 0;
    float gain = 0.0F;
    uint32_t tap = 0;
    uint32_t sidechain = 0;
    uint32_t delay = 0;
    if (!wasm_read_u64(bytes, byte_count, &offset, &id) || !wasm_read_u64(bytes, byte_count, &offset, &from)
      || !wasm_read_u64(bytes, byte_count, &offset, &to) || !wasm_read_u64(bytes, byte_count, &offset, &target)
      || !wasm_read_f32(bytes, byte_count, &offset, &gain) || !wasm_read_u32(bytes, byte_count, &offset, &tap)
      || !wasm_read_u32(bytes, byte_count, &offset, &sidechain) || !wasm_read_u32(bytes, byte_count, &offset, &delay)) return false;
    (*edges)[index] = {
      .id = id, .from_node_id = from, .to_node_id = to, .target_processor_id = target,
      .gain = gain, .tap = tap, .sidechain = sidechain, .pdc_delay_frames = delay,
    };
  }
  for (uint32_t index = 0; index < processor_count; ++index) {
    uint64_t node_id = 0;
    uint32_t kind = 0;
    uint32_t schema = 0;
    uint32_t state_size = 0;
    uint32_t instance = 0;
    uint32_t bypassed = 0;
    uint32_t input_layout = 0;
    uint32_t output_layout = 0;
    uint32_t target_count = 0;
    uint32_t latency = 0;
    uint32_t tail = 0;
    if (!wasm_read_u64(bytes, byte_count, &offset, &node_id) || !wasm_read_u32(bytes, byte_count, &offset, &kind)
      || !wasm_read_u32(bytes, byte_count, &offset, &schema) || !wasm_read_u32(bytes, byte_count, &offset, &state_size)
      || !wasm_read_u32(bytes, byte_count, &offset, &instance) || !wasm_read_u32(bytes, byte_count, &offset, &bypassed)
      || !wasm_read_u32(bytes, byte_count, &offset, &input_layout) || !wasm_read_u32(bytes, byte_count, &offset, &output_layout)
      || !wasm_read_u32(bytes, byte_count, &offset, &target_count) || !wasm_read_u32(bytes, byte_count, &offset, &latency)
      || !wasm_read_u32(bytes, byte_count, &offset, &tail) || state_size > DAW_AUDIO_CORE_MAX_PROCESSOR_STATE_BYTES
      || target_count > DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS || offset > byte_count || byte_count - offset < state_size) return false;
    for (uint32_t byte = 0; byte < state_size; ++byte) (*states)[index][byte] = bytes[offset + byte];
    offset += state_size;
    for (uint32_t target = 0; target < target_count; ++target) {
      if (!wasm_read_u32(bytes, byte_count, &offset, &(*targets)[index][target])) return false;
    }
    (*processors)[index] = {
      .node_id = node_id, .instance_id = instance, .kind = kind, .state_version = schema, .state_size = state_size,
      .bypassed = bypassed, .input_layout = input_layout, .output_layout = output_layout, .latency_frames = latency,
      .tail_frames = tail, .parameter_count = target_count, .parameter_targets = (*targets)[index].data(), .state = (*states)[index].data(),
    };
  }
  if (offset != byte_count) return false;
  *out_request = {
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = revision, .node_count = node_count,
    .edge_count = edge_count, .processor_count = processor_count, .reserved0 = 0, .nodes = nodes->data(),
    .edges = edges->data(), .processors = processors->data(),
  };
  return true;
}
}  // namespace daw::audio_core_internal


extern "C" daw_audio_core_result daw_audio_core_wasm_utility_initialize(
  uint32_t sample_rate_hz,
  uint32_t max_frames_per_block) {
  const daw_audio_core_config config{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .max_frames_per_block = max_frames_per_block,
    .max_channels = 2,
    .max_assets = 1,
    .sample_rate_hz = sample_rate_hz,
  };
  if (!valid_config(config)) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  wasm_utility_core.reset();
  wasm_utility_core.reset(new (std::nothrow) Core{});
  if (wasm_utility_core == nullptr || !initialize_core_storage(*wasm_utility_core)) {
    wasm_utility_core.reset();
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
  wasm_utility_core->config = config;
  wasm_utility_core->prepared_revision = 1;
  wasm_utility_core->published_revision = 1;
  wasm_utility_initialized = true;
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_wasm_utility_process(
  uint32_t frame_count,
  const float *left_input,
  const float *right_input,
  float *left_output,
  float *right_output,
  const daw_audio_utility_state *state) {
  if (!wasm_utility_initialized || left_output == nullptr || right_output == nullptr || state == nullptr) return DAW_AUDIO_CORE_NOT_PREPARED;
  if (wasm_utility_core == nullptr
    || frame_count > wasm_utility_core->config.max_frames_per_block
    || !valid_utility_state(*state)) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  wasm_utility_core->utility = *state;
  wasm_utility_core->utility_configured = true;
  const float *inputs[2]{left_input, right_input == nullptr ? left_input : right_input};
  float *outputs[2]{left_output, right_output};
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .frame_count = frame_count,
    .channel_count = 2,
    .input_bus_count = 1,
    .inputs = inputs,
    .outputs = outputs,
    .graph_revision = 0,
    .parameter_block_count = 0,
    .parameter_blocks = nullptr,
    .event_count = 0,
    .events = nullptr,
    .transport_epoch = 0,
    .instrument_event_count = 0,
    .instrument_events = nullptr,
  };
  return daw_audio_core_process(to_handle(wasm_utility_core.get()), &block);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_asset_initialize(
  uint32_t sample_rate_hz,
  uint32_t max_assets) {
  const daw_audio_core_config config{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .max_frames_per_block = 1,
    .max_channels = kMaximumChannels,
    .max_assets = max_assets,
    .sample_rate_hz = sample_rate_hz,
  };
  if (!valid_config(config)) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  wasm_asset_core.reset();
  wasm_asset_core.reset(new (std::nothrow) Core{});
  if (wasm_asset_core == nullptr || !initialize_core_storage(*wasm_asset_core)) {
    wasm_asset_core.reset();
    wasm_graph_core = nullptr;
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
  wasm_asset_core->config = config;
  wasm_graph_core = wasm_asset_core.get();
  wasm_asset_initialized = true;
  wasm_graph_initialized = false;
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_wasm_register_pcm_asset(
  uint32_t frame_count,
  uint32_t sample_rate_hz,
  uint32_t channel_count,
  const float *const *planes,
  daw_audio_asset_handle *out_asset) {
  if (!wasm_asset_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  const daw_audio_asset_descriptor descriptor{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .revision = 1,
    .byte_length = static_cast<uint64_t>(frame_count) * static_cast<uint64_t>(channel_count) * sizeof(float),
    .content_hash_prefix = 0,
    .frame_count = frame_count,
    .sample_rate_hz = sample_rate_hz,
    .channel_count = channel_count,
    .planes = planes,
  };
  return daw_audio_core_create_asset(to_handle(wasm_asset_core.get()), &descriptor, out_asset);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_release_asset(
  daw_audio_asset_handle asset) {
  if (!wasm_asset_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_core_release_asset(to_handle(wasm_asset_core.get()), asset);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_initialize(
  uint32_t sample_rate_hz,
  uint32_t max_frames_per_block,
  uint32_t max_assets) {
  return daw_audio_core_wasm_graph_initialize_planar(
    sample_rate_hz, max_frames_per_block, kMaximumChannels, 2, max_assets);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_initialize_planar(
  uint32_t sample_rate_hz,
  uint32_t max_frames_per_block,
  uint32_t max_input_buses,
  uint32_t max_channels,
  uint32_t max_assets) {
  const daw_audio_core_config config{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .max_frames_per_block = max_frames_per_block,
    .max_channels = max_channels,
    .max_assets = max_assets,
    .sample_rate_hz = sample_rate_hz,
  };
  if (!valid_config(config) || max_input_buses == 0 || max_input_buses > kMaximumChannels) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  // Reconfigure is stopped, with no concurrent reader. Portable rings are sized
  // from the first graph's actual readers, rather than native transition capacity.
  wasm_asset_core.reset();
  wasm_asset_core.reset(new (std::nothrow) Core{});
  if (wasm_asset_core == nullptr || !initialize_core_storage(*wasm_asset_core)) {
    wasm_asset_core.reset();
    wasm_graph_core = nullptr;
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
  wasm_graph_core = wasm_asset_core.get();
  wasm_graph_core->config = config;
  if (!allocate_graph_stage_buffers(*wasm_graph_core)) {
    wasm_asset_core.reset();
    wasm_graph_core = nullptr;
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
  const daw_audio_paged_asset_config paged_config{
    .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
    .page_frames = DAW_AUDIO_CORE_WASM_PAGED_PAGE_FRAMES,
    .slot_count = DAW_AUDIO_CORE_WASM_PAGED_PAGE_SLOTS,
    .max_channels = std::min(max_channels, DAW_AUDIO_CORE_WASM_PAGED_MAX_CHANNELS),
  };
  if (!initialize_paged_storage(*wasm_graph_core, paged_config)) {
    wasm_asset_core.reset();
    wasm_graph_core = nullptr;
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
  wasm_graph_max_input_buses = max_input_buses;
  wasm_asset_initialized = false;
  wasm_graph_initialized = true;
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_prepare(
  const uint8_t *graph_bytes,
  uint32_t graph_byte_count) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  std::array<daw_audio_graph_node_descriptor, kMaximumLiveNodes> nodes{};
  std::array<daw_audio_graph_edge_descriptor, kMaximumLiveEdges> edges{};
  std::array<daw_audio_processor_descriptor, kMaximumLiveProcessors> processors{};
  std::array<std::array<uint32_t, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS>, kMaximumLiveProcessors> targets{};
  std::array<std::array<uint8_t, DAW_AUDIO_CORE_MAX_PROCESSOR_STATE_BYTES>, kMaximumLiveProcessors> states{};
  daw_audio_graph_prepare_request request{};
  if (!wasm_parse_graph(graph_bytes, graph_byte_count, &request, &nodes, &edges, &processors, &targets, &states)) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  return daw_audio_core_prepare_graph(to_handle(wasm_graph_core), &request);
}

extern "C" uint32_t daw_audio_core_wasm_graph_prepared_continuity() {
  return !wasm_graph_initialized || wasm_graph_core == nullptr
    ? 0U
    : daw_audio_core_prepared_graph_continuity(to_handle(wasm_graph_core));
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_publish(uint32_t expected_revision) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_core_publish(to_handle(wasm_graph_core), expected_revision);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_cancel(uint32_t expected_revision) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_core_cancel_prepared_graph(to_handle(wasm_graph_core), expected_revision);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_process(
  uint32_t frame_count,
  const float *left_input,
  const float *right_input,
  float *left_output,
  float *right_output,
  uint32_t graph_revision,
  const uint8_t *parameter_bytes,
  uint32_t parameter_byte_count,
  const uint8_t *event_bytes,
  uint32_t event_byte_count) {
  const float *inputs[2]{left_input, right_input == nullptr ? left_input : right_input};
  float *outputs[2]{left_output, right_output};
  return daw_audio_core_wasm_graph_process_planar(
    frame_count, 1, 2, inputs, outputs, graph_revision, parameter_bytes, parameter_byte_count,
    event_bytes, event_byte_count, nullptr, 0);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_process_planar(
  uint32_t frame_count,
  uint32_t input_bus_count,
  uint32_t channel_count,
  const float *const *inputs,
  float *const *outputs,
  uint32_t graph_revision,
  const uint8_t *parameter_bytes,
  uint32_t parameter_byte_count,
  const uint8_t *event_bytes,
  uint32_t event_byte_count,
  const uint8_t *instrument_event_bytes,
  uint32_t instrument_event_byte_count) {
  if (!wasm_graph_initialized || outputs == nullptr) return DAW_AUDIO_CORE_NOT_PREPARED;
  if (wasm_graph_core == nullptr
    || frame_count == 0 || frame_count > wasm_graph_core->config.max_frames_per_block
    || input_bus_count > wasm_graph_max_input_buses || channel_count == 0
    || channel_count > wasm_graph_core->config.max_channels) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  if ((input_bus_count > 0 && inputs == nullptr) || outputs == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  std::array<daw_audio_processor_parameter_block, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETER_BLOCKS> blocks{};
  std::array<daw_audio_processor_event, DAW_AUDIO_CORE_MAX_PROCESSOR_EVENTS> events{};
  std::array<daw_audio_instrument_event, DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS> instrument_events{};
  uint32_t block_count = 0;
  uint32_t event_count = 0;
  uint32_t offset = 0;
  if (parameter_byte_count == 0) {
    if (parameter_bytes != nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  } else {
    if (parameter_bytes == nullptr || !wasm_read_u32(parameter_bytes, parameter_byte_count, &offset, &block_count)
      || block_count > DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETER_BLOCKS) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    for (uint32_t index = 0; index < block_count; ++index) {
      uint64_t processor_id = 0;
      uint32_t values_frame_count = 0;
      uint32_t target_count = 0;
      if (!wasm_read_u64(parameter_bytes, parameter_byte_count, &offset, &processor_id)
        || !wasm_read_u32(parameter_bytes, parameter_byte_count, &offset, &values_frame_count)
        || !wasm_read_u32(parameter_bytes, parameter_byte_count, &offset, &target_count)
        || target_count == 0 || target_count > DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS
        || (values_frame_count != 1 && values_frame_count != frame_count)
        || offset > parameter_byte_count || parameter_byte_count - offset < target_count * 4u) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
      const uint32_t *targets = reinterpret_cast<const uint32_t *>(parameter_bytes + offset);
      offset += target_count * 4u;
      const uint64_t value_bytes = static_cast<uint64_t>(target_count) * static_cast<uint64_t>(values_frame_count) * sizeof(float);
      if (value_bytes > parameter_byte_count - offset) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
      const float *values = reinterpret_cast<const float *>(parameter_bytes + offset);
      offset += static_cast<uint32_t>(value_bytes);
      blocks[index] = {.processor_instance_id = processor_id, .frame_count = values_frame_count, .parameter_count = target_count, .parameter_targets = targets, .values = values};
    }
    if (offset != parameter_byte_count) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  offset = 0;
  if (event_byte_count == 0) {
    if (event_bytes != nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  } else {
    if (event_bytes == nullptr || !wasm_read_u32(event_bytes, event_byte_count, &offset, &event_count)
      || event_count > DAW_AUDIO_CORE_MAX_PROCESSOR_EVENTS) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    for (uint32_t index = 0; index < event_count; ++index) {
      uint64_t processor_id = 0;
      uint32_t target = 0;
      uint32_t frame_offset = 0;
      float value = 0.0F;
      if (!wasm_read_u64(event_bytes, event_byte_count, &offset, &processor_id)
        || !wasm_read_u32(event_bytes, event_byte_count, &offset, &target)
        || !wasm_read_u32(event_bytes, event_byte_count, &offset, &frame_offset)
        || !wasm_read_f32(event_bytes, event_byte_count, &offset, &value)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
      events[index] = {.processor_instance_id = processor_id, .parameter_target = target, .frame_offset = frame_offset, .value = value};
    }
    if (offset != event_byte_count) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  uint32_t instrument_event_count = 0;
  offset = 0;
  if (instrument_event_byte_count == 0) {
    if (instrument_event_bytes != nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  } else {
    if (instrument_event_bytes == nullptr
      || !wasm_read_u32(instrument_event_bytes, instrument_event_byte_count, &offset, &instrument_event_count)
      || instrument_event_count > DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    for (uint32_t index = 0; index < instrument_event_count; ++index) {
      daw_audio_instrument_event &event = instrument_events[index];
      if (!wasm_read_u64(instrument_event_bytes, instrument_event_byte_count, &offset, &event.node_id)
        || !wasm_read_u64(instrument_event_bytes, instrument_event_byte_count, &offset, &event.note_id)
        || !wasm_read_u64(instrument_event_bytes, instrument_event_byte_count, &offset, &event.sequence)
        || !wasm_read_u32(instrument_event_bytes, instrument_event_byte_count, &offset, &event.epoch)
        || !wasm_read_u32(instrument_event_bytes, instrument_event_byte_count, &offset, &event.frame_offset)
        || !wasm_read_u32(instrument_event_bytes, instrument_event_byte_count, &offset, &event.type)
        || !wasm_read_u32(instrument_event_bytes, instrument_event_byte_count, &offset, &event.channel)
        || !wasm_read_u32(instrument_event_bytes, instrument_event_byte_count, &offset, &event.note)
        || !wasm_read_f32(instrument_event_bytes, instrument_event_byte_count, &offset, &event.value)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
    if (offset != instrument_event_byte_count) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = frame_count, .channel_count = channel_count, .input_bus_count = input_bus_count,
    .inputs = inputs, .outputs = outputs, .graph_revision = graph_revision, .parameter_block_count = block_count,
    .parameter_blocks = block_count == 0 ? nullptr : blocks.data(), .event_count = event_count,
    .events = event_count == 0 ? nullptr : events.data(), .transport_epoch = wasm_graph_core->transport.epoch,
    .instrument_event_count = instrument_event_count,
    .instrument_events = instrument_event_count == 0 ? nullptr : instrument_events.data(),
  };
  return daw_audio_core_process(to_handle(wasm_graph_core), &block);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_set_transport(
  uint32_t epoch,
  uint32_t running,
  int64_t frame) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  const daw_audio_transport_state state{
    .epoch = epoch,
    .running = running,
    .frame = frame,
    .tempo_bpm = 0.0,
    .time_signature_numerator = 0,
    .time_signature_denominator = 0,
    .cycle_active = 0,
    .cycle_start_frame = 0,
    .cycle_end_frame = 0,
  };
  return daw_audio_core_set_transport(to_handle(wasm_graph_core), &state);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_schedule_sample_source(
  uint32_t epoch,
  uint64_t sequence,
  uint64_t source_node_id,
  daw_audio_asset_handle asset,
  int64_t start_frame,
  int64_t stop_frame,
  uint64_t source_offset_frame,
  uint64_t source_frame_count,
  float gain,
  int64_t fade_in_start_frame,
  int64_t fade_in_end_frame,
  int64_t fade_out_start_frame,
  int64_t fade_out_end_frame,
  float source_offset_fraction,
  float fade_in_curve,
  float fade_in_curve_position,
  float fade_out_curve,
  float fade_out_curve_position) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  const daw_audio_sample_source_event event{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .epoch = epoch,
    .sequence = sequence,
    .source_node_id = source_node_id,
    .asset = asset,
    .start_frame = start_frame,
    .stop_frame = stop_frame,
    .source_offset_frame = source_offset_frame,
    .source_frame_count = source_frame_count,
    .gain = gain,
    .fade_in_start_frame = fade_in_start_frame,
    .fade_in_end_frame = fade_in_end_frame,
    .fade_out_start_frame = fade_out_start_frame,
    .fade_out_end_frame = fade_out_end_frame,
    .source_offset_fraction = source_offset_fraction,
    .fade_in_curve = fade_in_curve,
    .fade_in_curve_position = fade_in_curve_position,
    .fade_out_curve = fade_out_curve,
    .fade_out_curve_position = fade_out_curve_position,
  };
  return daw_audio_core_schedule_sample_source(to_handle(wasm_graph_core), &event);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_replace_sample_sources(
  uint32_t revision,
  uint32_t epoch,
  const uint8_t *event_bytes,
  uint32_t event_byte_count) {
  if (!wasm_graph_initialized || wasm_graph_core == nullptr
    || revision == 0 || epoch == 0 || event_bytes == nullptr || event_byte_count < 4) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  uint32_t offset = 0;
  uint32_t event_count = 0;
  if (!wasm_read_u32(event_bytes, event_byte_count, &offset, &event_count)
    || event_count > kMaximumSampleSources
    || event_count > UINT32_MAX / 120u
    || event_byte_count - offset != event_count * 120u) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  std::array<daw_audio_sample_source_replacement_event, kMaximumSampleSources> events{};
  for (uint32_t index = 0; index < event_count; ++index) {
    auto &event = events[index];
    if (!wasm_read_u32(event_bytes, event_byte_count, &offset, &event.kind)
      || !wasm_read_u32(event_bytes, event_byte_count, &offset, &event.reserved)
      || !wasm_read_u64(event_bytes, event_byte_count, &offset, &event.sequence)
      || !wasm_read_u64(event_bytes, event_byte_count, &offset, &event.source_node_id)
      || !wasm_read_u64(event_bytes, event_byte_count, &offset,
        event.kind == 0 ? &event.asset : &event.preparation)
      || !wasm_read_i64(event_bytes, event_byte_count, &offset, &event.start_frame)
      || !wasm_read_i64(event_bytes, event_byte_count, &offset, &event.stop_frame)
      || !wasm_read_u64(event_bytes, event_byte_count, &offset, &event.source_offset_frame)
      || !wasm_read_u64(event_bytes, event_byte_count, &offset, &event.source_frame_count)
      || !wasm_read_f32(event_bytes, event_byte_count, &offset, &event.gain)
      || !wasm_read_i64(event_bytes, event_byte_count, &offset, &event.fade_in_start_frame)
      || !wasm_read_i64(event_bytes, event_byte_count, &offset, &event.fade_in_end_frame)
      || !wasm_read_i64(event_bytes, event_byte_count, &offset, &event.fade_out_start_frame)
      || !wasm_read_i64(event_bytes, event_byte_count, &offset, &event.fade_out_end_frame)
      || !wasm_read_f32(event_bytes, event_byte_count, &offset, &event.source_offset_fraction)
      || !wasm_read_f32(event_bytes, event_byte_count, &offset, &event.fade_in_curve)
      || !wasm_read_f32(event_bytes, event_byte_count, &offset, &event.fade_in_curve_position)
      || !wasm_read_f32(event_bytes, event_byte_count, &offset, &event.fade_out_curve)
      || !wasm_read_f32(event_bytes, event_byte_count, &offset, &event.fade_out_curve_position)) {
      return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
    event.abi_version = DAW_AUDIO_CORE_ABI_VERSION;
    event.epoch = epoch;
  }
  return daw_audio_core_replace_sample_sources(
    to_handle(wasm_graph_core), revision, epoch, events.data(), event_count);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_reset_sample_sources(
  uint32_t revision,
  uint32_t epoch) {
  if (!wasm_graph_initialized || wasm_graph_core == nullptr
    || revision == 0 || epoch == 0
    || wasm_graph_core->published_revision != revision
    || wasm_graph_core->transport.epoch != epoch) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  clear_sample_sources(*wasm_graph_core);
  wasm_graph_core->last_event_sequence = 0;
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_register_pcm_asset(
  uint32_t frame_count,
  uint32_t sample_rate_hz,
  uint32_t channel_count,
  const float *const *planes,
  daw_audio_asset_handle *out_asset) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  const daw_audio_asset_descriptor descriptor{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .revision = 1,
    .byte_length = static_cast<uint64_t>(frame_count) * static_cast<uint64_t>(channel_count) * sizeof(float),
    .content_hash_prefix = 0, .frame_count = frame_count, .sample_rate_hz = sample_rate_hz,
    .channel_count = channel_count, .planes = planes,
  };
  return daw_audio_core_create_asset(to_handle(wasm_graph_core), &descriptor, out_asset);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_release_asset(daw_audio_asset_handle asset) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_core_release_asset(to_handle(wasm_graph_core), asset);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_configure_synth(
  uint64_t node_id,
  const daw_audio_synth_state *state) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_core_configure_synth(to_handle(wasm_graph_core), node_id, state);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_configure_sampler(
  uint64_t node_id,
  const daw_audio_sampler_state *state,
  const daw_audio_sample_zone *zones) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_core_configure_sampler(to_handle(wasm_graph_core), node_id, state, zones);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_configure_granular(
  uint64_t node_id,
  const daw_audio_granular_state *state) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_core_configure_granular(to_handle(wasm_graph_core), node_id, state);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_create_paged_asset(
  uint64_t frame_count,
  uint32_t sample_rate_hz,
  uint32_t channel_count,
  daw_audio_asset_handle *out_asset) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  const daw_audio_paged_asset_descriptor descriptor{
    .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
    .revision = 1,
    .byte_length = frame_count * static_cast<uint64_t>(channel_count) * sizeof(float),
    .content_hash_prefix = 0,
    .frame_count = frame_count,
    .sample_rate_hz = sample_rate_hz,
    .channel_count = channel_count,
  };
  return daw_audio_core_create_paged_asset(to_handle(wasm_graph_core), &descriptor, out_asset);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_write_paged_asset_page(
  daw_audio_asset_handle asset,
  uint64_t page_index,
  uint32_t valid_frames,
  uint32_t channel_count,
  const float *const *planes) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  const daw_audio_paged_asset_page_write write{
    .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
    .asset = asset,
    .page_index = page_index,
    .valid_frames = valid_frames,
    .channel_count = channel_count,
    .planes = planes,
  };
  return daw_audio_core_write_paged_asset_page(to_handle(wasm_graph_core), &write);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_prepare_paged_asset(
  daw_audio_asset_handle asset,
  uint64_t source_offset_frame,
  uint64_t source_frame_count,
  uint32_t interpolation_guard_frames,
  daw_audio_paged_preparation_handle *out_preparation,
  uint64_t *out_first_missing_page) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  const daw_audio_paged_asset_prepare_request request{
    .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
    .asset = asset,
    .source_offset_frame = source_offset_frame,
    .source_frame_count = source_frame_count,
    .interpolation_guard_frames = interpolation_guard_frames,
    .reserved = 0,
  };
  return daw_audio_core_prepare_paged_asset(
    to_handle(wasm_graph_core), &request, out_preparation, out_first_missing_page);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_schedule_prepared_sample_source(
  uint32_t epoch,
  uint64_t sequence,
  uint64_t source_node_id,
  daw_audio_paged_preparation_handle preparation,
  int64_t start_frame,
  int64_t stop_frame,
  uint64_t source_offset_frame,
  uint64_t source_frame_count,
  float source_offset_fraction,
  float gain,
  int64_t fade_in_start_frame,
  int64_t fade_in_end_frame,
  int64_t fade_out_start_frame,
  int64_t fade_out_end_frame,
  float fade_in_curve,
  float fade_in_curve_position,
  float fade_out_curve,
  float fade_out_curve_position) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  const daw_audio_paged_sample_source_event event{
    .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
    .epoch = epoch,
    .sequence = sequence,
    .source_node_id = source_node_id,
    .preparation = preparation,
    .start_frame = start_frame,
    .stop_frame = stop_frame,
    .source_offset_frame = source_offset_frame,
    .source_frame_count = source_frame_count,
    .source_offset_fraction = source_offset_fraction,
    .gain = gain,
    .fade_in_start_frame = fade_in_start_frame,
    .fade_in_end_frame = fade_in_end_frame,
    .fade_out_start_frame = fade_out_start_frame,
    .fade_out_end_frame = fade_out_end_frame,
    .fade_in_curve = fade_in_curve,
    .fade_in_curve_position = fade_in_curve_position,
    .fade_out_curve = fade_out_curve,
    .fade_out_curve_position = fade_out_curve_position,
  };
  return daw_audio_core_schedule_prepared_sample_source(to_handle(wasm_graph_core), &event);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_release_paged_preparation(
  daw_audio_paged_preparation_handle preparation) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_core_release_paged_preparation(to_handle(wasm_graph_core), preparation);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_trim_paged_asset(
  daw_audio_asset_handle asset,
  uint64_t first_page,
  uint32_t page_count) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_core_trim_paged_asset(to_handle(wasm_graph_core), asset, first_page, page_count);
}

extern "C" uint32_t daw_audio_core_wasm_graph_paged_sub_abi_version(void) {
  return DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION;
}

extern "C" uint32_t daw_audio_core_wasm_graph_paged_page_frames(void) {
  return DAW_AUDIO_CORE_WASM_PAGED_PAGE_FRAMES;
}

extern "C" uint32_t daw_audio_core_wasm_graph_paged_slot_count(void) {
  return DAW_AUDIO_CORE_WASM_PAGED_PAGE_SLOTS;
}

extern "C" daw_audio_core_result daw_audio_core_wasm_recording_capture_initialize(
  const daw_audio_recording_capture_config *config) {
  if (wasm_recording_capture != 0) {
    daw_audio_recording_capture_destroy(wasm_recording_capture);
    wasm_recording_capture = 0;
  }
  return daw_audio_recording_capture_create(config, &wasm_recording_capture);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_recording_capture_process(
  const float *const *inputs,
  uint32_t input_channel_count,
  uint32_t frame_count,
  int64_t start_frame) {
  if (wasm_recording_capture == 0) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_recording_capture_process(
    wasm_recording_capture, inputs, input_channel_count, frame_count, start_frame);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_recording_capture_process_monitor(
  const float *const *inputs,
  uint32_t input_channel_count,
  float *const *monitor_outputs,
  uint32_t monitor_channel_count,
  uint32_t frame_count,
  int64_t start_frame) {
  if (wasm_recording_capture == 0) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_recording_capture_process_monitor(
    wasm_recording_capture, inputs, input_channel_count, monitor_outputs, monitor_channel_count, frame_count, start_frame);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_recording_capture_dequeue(
  float *const *outputs,
  daw_audio_recording_capture_block *out_block) {
  if (wasm_recording_capture == 0 || outputs == nullptr || out_block == nullptr) return DAW_AUDIO_CORE_NOT_PREPARED;
  daw_audio_recording_capture_block block{};
  const daw_audio_core_result result = daw_audio_recording_capture_dequeue(wasm_recording_capture, &block);
  if (result != DAW_AUDIO_CORE_OK) return result;
  for (uint32_t channel = 0; channel < block.channel_count; ++channel) {
    if (outputs[channel] == nullptr) {
      (void)daw_audio_recording_capture_release_block(wasm_recording_capture, block.block_id);
      return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
    for (uint32_t frame = 0; frame < block.frame_count; ++frame) {
      outputs[channel][frame] = block.planes[channel][frame];
    }
    block.planes[channel] = outputs[channel];
  }
  *out_block = block;
  return daw_audio_recording_capture_release_block(wasm_recording_capture, block.block_id);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_recording_capture_finalize(int64_t stop_frame) {
  if (wasm_recording_capture == 0) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_recording_capture_finalize(wasm_recording_capture, stop_frame);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_recording_capture_cancel(void) {
  if (wasm_recording_capture == 0) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_recording_capture_cancel(wasm_recording_capture);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_recording_capture_get_diagnostics(
  daw_audio_recording_capture_diagnostics *out_diagnostics) {
  if (wasm_recording_capture == 0) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_recording_capture_get_diagnostics(wasm_recording_capture, out_diagnostics);
}
