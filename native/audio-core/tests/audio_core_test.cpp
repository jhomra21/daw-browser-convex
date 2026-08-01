#include "daw/audio_core.h"
#include "utility_fixture.h"
#include "daw/audio_core_native.h"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <cstring>
#include <cstdlib>
#include <new>
#include <utility>
#include <vector>

static_assert(DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS == 16u);

namespace {

std::size_t allocation_count = 0;

std::array<std::uint64_t, 3> native_hook_nodes{};
std::array<void*, 3> native_hook_attachments{};
std::array<std::uint32_t, 3> native_hook_revisions{};
std::uint32_t native_hook_calls = 0;
std::array<std::uint64_t, 2> native_observer_nodes{};
std::array<float, 2> native_observer_left{};
std::uint32_t native_observer_calls = 0;

void native_graph_hook(const daw::audio_core::NativeGraphNodeRender& render) noexcept {
  native_hook_nodes[native_hook_calls] = render.node_id;
  native_hook_attachments[native_hook_calls] = render.attachment;
  native_hook_revisions[native_hook_calls] = render.graph_revision;
  ++native_hook_calls;
  if (render.node_id == 1) {
    for (std::uint32_t frame = 0; frame < render.frame_count; ++frame) {
      render.planes[0][frame] *= 2.0F;
      render.planes[1][frame] *= 2.0F;
    }
  }
}

void native_graph_observer(const daw::audio_core::NativeGraphNodeRender& render) noexcept {
  native_observer_nodes[native_observer_calls] = render.node_id;
  native_observer_left[native_observer_calls] = render.planes[0][0];
  ++native_observer_calls;
}

void expect(daw_audio_core_result actual, daw_audio_core_result expected) {
  if (actual != expected) std::fprintf(stderr, "actual=%u expected=%u\n", actual, expected);
  assert(actual == expected);
}

daw_audio_core_handle create_core_at_rate(uint32_t frames, uint32_t channels, uint32_t assets, uint32_t sample_rate_hz) {
  daw_audio_core_handle core = 0;
  const daw_audio_core_config config{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .max_frames_per_block = frames,
    .max_channels = channels,
    .max_assets = assets,
    .sample_rate_hz = sample_rate_hz,
  };
  expect(daw_audio_core_create(&config, &core), DAW_AUDIO_CORE_OK);
  return core;
}

daw_audio_core_handle create_core(uint32_t frames, uint32_t channels, uint32_t assets) {
  return create_core_at_rate(frames, channels, assets, 48000);
}

void publish(daw_audio_core_handle core, uint32_t revision) {
  const daw_audio_core_prepare_request request{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .graph_revision = revision,
    .reserved0 = 0,
    .reserved1 = 0,
  };
  expect(daw_audio_core_prepare(core, &request), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_publish(core, revision), DAW_AUDIO_CORE_OK);
}

void prepare_graph(
  daw_audio_core_handle core,
  uint32_t revision,
  const daw_audio_graph_node_descriptor *nodes,
  uint32_t node_count,
  const daw_audio_graph_edge_descriptor *edges,
  uint32_t edge_count) {
  const daw_audio_graph_prepare_request request{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .graph_revision = revision,
    .node_count = node_count,
    .edge_count = edge_count,
    .nodes = nodes,
    .edges = edges,
  };
  expect(daw_audio_core_prepare_graph(core, &request), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_publish(core, revision), DAW_AUDIO_CORE_OK);
}

void test_portable_graph_topology_pdc_and_revision_safety() {
  daw_audio_core_handle core = create_core(8, 2, 1);
  const std::array<daw_audio_graph_node_descriptor, 3> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_MONO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_MONO, .input_bus = 0, .latency_frames = 0},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 1, .latency_frames = 4},
    {.id = 3, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const std::array<daw_audio_graph_edge_descriptor, 2> edges{{
    {.id = 11, .from_node_id = 1, .to_node_id = 3, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 4},
    {.id = 12, .from_node_id = 2, .to_node_id = 3, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0},
  }};
  prepare_graph(core, 5, nodes.data(), nodes.size(), edges.data(), edges.size());
  std::array<float, 8> mono{};
  std::array<float, 8> left{};
  std::array<float, 8> right{};
  mono[0] = 1.0F;
  left[0] = 2.0F;
  right[0] = 4.0F;
  const float *inputs[]{mono.data(), mono.data(), left.data(), right.data()};
  std::array<float, 8> output_left{};
  std::array<float, 8> output_right{};
  float *outputs[]{output_left.data(), output_right.data()};
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 8, .channel_count = 2,
    .input_bus_count = 2, .inputs = inputs, .outputs = outputs,
  };
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(output_left[0] == 2.0F);
  assert(output_right[0] == 4.0F);
  assert(output_left[4] == 1.0F);
  assert(output_right[4] == 1.0F);
  std::array<daw_audio_graph_node_descriptor, 3> changed_nodes = nodes;
  changed_nodes[1].latency_frames = 0;
  std::array<daw_audio_graph_edge_descriptor, 2> changed_edges = edges;
  changed_edges[0].pdc_delay_frames = 0;
  const daw_audio_graph_prepare_request latency_change{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 6,
    .node_count = static_cast<uint32_t>(changed_nodes.size()), .edge_count = static_cast<uint32_t>(changed_edges.size()),
    .nodes = changed_nodes.data(), .edges = changed_edges.data(),
  };
  expect(daw_audio_core_prepare_graph(core, &latency_change), DAW_AUDIO_CORE_LATENCY_CHANGE_DEFERRED);
  expect(daw_audio_core_retire(core, 4), DAW_AUDIO_CORE_STALE_REVISION);
  expect(daw_audio_core_retire(core, 5), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_NOT_PREPARED);
  daw_audio_core_destroy(core);
}

void test_graph_edges_read_declared_stage_taps() {
  daw_audio_core_handle core = create_core(4, 2, 1);
  const std::array<daw_audio_graph_node_descriptor, 2> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0,
      .mixer = {.instance_id = 101, .gain = 2.0F}},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const std::array<daw_audio_graph_edge_descriptor, 3> edges{{
    {.id = 11, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_PRE_FX,
      .sidechain = 0, .pdc_delay_frames = 0},
    {.id = 12, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_PRE_FADER,
      .sidechain = 0, .pdc_delay_frames = 0},
    {.id = 13, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER,
      .sidechain = 0, .pdc_delay_frames = 0},
  }};
  prepare_graph(core, 1, nodes.data(), nodes.size(), edges.data(), edges.size());
  std::array<float, 4> input_left{1.0F};
  std::array<float, 4> input_right{1.0F};
  const float *inputs[]{input_left.data(), input_right.data()};
  std::array<float, 4> output_left{};
  std::array<float, 4> output_right{};
  float *outputs[]{output_left.data(), output_right.data()};
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 4, .channel_count = 2,
    .input_bus_count = 1, .inputs = inputs, .outputs = outputs,
  };
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(output_left[0] == 4.0F);
  assert(output_right[0] == 4.0F);
  daw_audio_core_destroy(core);
}

void test_native_graph_hook_binds_prepared_nodes_before_publish() {
  daw_audio_core_handle core = create_core(4, 2, 1);
  const std::array<daw_audio_graph_node_descriptor, 2> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const std::array<daw_audio_graph_edge_descriptor, 1> edges{{
    {.id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER,
      .sidechain = 0, .pdc_delay_frames = 0},
  }};
  const daw_audio_graph_prepare_request request{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 9, .node_count = 2, .edge_count = 1,
    .nodes = nodes.data(), .edges = edges.data(),
  };
  expect(daw_audio_core_prepare_graph(core, &request), DAW_AUDIO_CORE_OK);
  int source_attachment = 1;
  int source_chain_attachment = 3;
  int master_attachment = 2;
  const std::array<daw::audio_core::NativeGraphHookBinding, 3> bindings{{
    {.node_id = 1, .chain_index = 0, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .pdc_latency_frames = 0, .attachment = &source_attachment},
    {.node_id = 1, .chain_index = 1, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .pdc_latency_frames = 0, .attachment = &source_chain_attachment},
    {.node_id = 2, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .pdc_latency_frames = 0, .attachment = &master_attachment},
  }};
  int observer_attachment = 3;
  expect(daw::audio_core::RegisterNativeGraphHook(core, {
    .graph_revision = 9,
    .hook = native_graph_hook,
    .bindings = bindings,
    .observer = native_graph_observer,
    .observer_attachment = &observer_attachment,
  }),
    DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_publish(core, 9), DAW_AUDIO_CORE_OK);
  std::array<float, 4> left{1.0F};
  std::array<float, 4> right{3.0F};
  const float* inputs[]{left.data(), right.data()};
  std::array<float, 4> output_left{};
  std::array<float, 4> output_right{};
  float* outputs[]{output_left.data(), output_right.data()};
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 4, .channel_count = 2, .input_bus_count = 1,
    .inputs = inputs, .outputs = outputs,
  };
  native_hook_calls = 0;
  native_observer_calls = 0;
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(native_hook_calls == 3 && native_hook_nodes[0] == 1 && native_hook_nodes[1] == 1 && native_hook_nodes[2] == 2);
  assert(native_hook_attachments[0] == &source_attachment && native_hook_attachments[1] == &source_chain_attachment
    && native_hook_attachments[2] == &master_attachment);
  assert(native_hook_revisions[0] == 9 && native_hook_revisions[1] == 9 && native_hook_revisions[2] == 9);
  assert(output_left[0] == 4.0F && output_right[0] == 12.0F);
  assert(native_observer_calls == 2 && native_observer_nodes[0] == 1 && native_observer_nodes[1] == 2);
  assert(native_observer_left[0] == 4.0F && native_observer_left[1] == 4.0F);
  const std::array<daw::audio_core::NativeGraphHookBinding, 1> bad_bindings{{
    {.node_id = 1, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .pdc_latency_frames = 1,
      .attachment = &source_attachment},
  }};
  expect(daw::audio_core::RegisterNativeGraphHook(core, {.graph_revision = 9, .hook = native_graph_hook,
    .bindings = bad_bindings}), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  daw_audio_core_destroy(core);
}

void test_portable_graph_rejects_invalid_topology_and_capacity() {
  daw_audio_core_handle core = create_core(8, 2, 1);
  const std::array<daw_audio_graph_node_descriptor, 2> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const std::array<daw_audio_graph_edge_descriptor, 2> cycle{{
    {.id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0},
    {.id = 2, .from_node_id = 2, .to_node_id = 1, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0},
  }};
  daw_audio_graph_prepare_request cycle_request{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 1, .node_count = 2, .edge_count = 2, .nodes = nodes.data(), .edges = cycle.data(),
  };
  expect(daw_audio_core_prepare_graph(core, &cycle_request), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  daw_audio_graph_edge_descriptor too_long = cycle[0];
  too_long.pdc_delay_frames = 8193;
  daw_audio_graph_prepare_request capacity_request{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 1, .node_count = 2, .edge_count = 1, .nodes = nodes.data(), .edges = &too_long,
  };
  expect(daw_audio_core_prepare_graph(core, &capacity_request), DAW_AUDIO_CORE_CAPACITY_EXCEEDED);
  capacity_request.edge_count = 0;
  capacity_request.edges = nullptr;
  capacity_request.processor_count = DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE * 64u + 1u;
  expect(daw_audio_core_prepare_graph(core, &capacity_request), DAW_AUDIO_CORE_CAPACITY_EXCEEDED);
  daw_audio_core_destroy(core);
}

void test_pdc_delay_may_exceed_runtime_block_size_within_ring_capacity() {
  daw_audio_core_handle core = create_core(512, 2, 1);
  const std::array<daw_audio_graph_node_descriptor, 3> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 1024},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 1, .latency_frames = 0},
    {.id = 3, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const std::array<daw_audio_graph_edge_descriptor, 2> edges{{
    {.id = 1, .from_node_id = 1, .to_node_id = 3, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0},
    {.id = 2, .from_node_id = 2, .to_node_id = 3, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 1024},
  }};
  const daw_audio_graph_prepare_request request{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .graph_revision = 1,
    .node_count = static_cast<uint32_t>(nodes.size()),
    .edge_count = static_cast<uint32_t>(edges.size()),
    .nodes = nodes.data(),
    .edges = edges.data(),
  };
  expect(daw_audio_core_prepare_graph(core, &request), DAW_AUDIO_CORE_OK);
  assert(daw_audio_core_get_graph_validation_diagnostic(core).code == DAW_AUDIO_CORE_GRAPH_VALIDATION_NONE);
  daw_audio_core_destroy(core);
}

void test_portable_graph_utility_node() {
  daw_audio_core_handle core = create_core(4, 2, 1);
  const std::array<daw_audio_graph_node_descriptor, 3> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_UTILITY, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
    {.id = 3, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const std::array<daw_audio_graph_edge_descriptor, 2> edges{{
    {.id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0},
    {.id = 2, .from_node_id = 2, .to_node_id = 3, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0},
  }};
  prepare_graph(core, 1, nodes.data(), nodes.size(), edges.data(), edges.size());
  const daw_audio_utility_state inverted{
    .enabled = 1, .gain_db = 0.0F, .polarity = DAW_AUDIO_UTILITY_POLARITY_INVERT,
    .input_mode = DAW_AUDIO_UTILITY_INPUT_MODE_STEREO, .pan = 0.0F, .balance = 0.0F,
    .width = 1.0F, .matrix = DAW_AUDIO_UTILITY_MATRIX_STEREO, .swap = 0, .dc_block = 0,
  };
  expect(daw_audio_core_configure_utility(core, &inverted), DAW_AUDIO_CORE_OK);
  const std::array<float, 1> left{0.25F};
  const std::array<float, 1> right{-0.5F};
  const float *inputs[]{left.data(), right.data()};
  std::array<float, 1> output_left{};
  std::array<float, 1> output_right{};
  float *outputs[]{output_left.data(), output_right.data()};
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 1, .channel_count = 2,
    .input_bus_count = 1, .inputs = inputs, .outputs = outputs,
  };
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(std::abs(output_left[0] + 0.25F) <= 1e-6F);
  assert(std::abs(output_right[0] - 0.5F) <= 1e-6F);
  daw_audio_core_destroy(core);
}

struct HistoryFixtureState {
  std::array<uint8_t, DAW_AUDIO_CORE_MAX_PROCESSOR_STATE_BYTES> bytes{};
  uint32_t size = 0;
  uint32_t latency = 0;
};

HistoryFixtureState history_fixture_state(uint32_t kind) {
  HistoryFixtureState fixture{};
  const auto write_u32 = [&fixture](uint32_t offset, uint32_t value) {
    fixture.bytes[offset] = static_cast<uint8_t>(value);
    fixture.bytes[offset + 1] = static_cast<uint8_t>(value >> 8u);
    fixture.bytes[offset + 2] = static_cast<uint8_t>(value >> 16u);
    fixture.bytes[offset + 3] = static_cast<uint8_t>(value >> 24u);
  };
  const auto write_f32 = [&write_u32](uint32_t offset, float value) {
    uint32_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    write_u32(offset, bits);
  };
  if (kind == DAW_AUDIO_PROCESSOR_KIND_UTILITY) {
    fixture.size = 40;
    write_u32(0, 1); write_f32(4, 0.0F); write_u32(8, DAW_AUDIO_UTILITY_POLARITY_NORMAL);
    write_u32(12, DAW_AUDIO_UTILITY_INPUT_MODE_STEREO); write_f32(16, 0.0F);
    write_f32(20, 0.0F); write_f32(24, 1.0F); write_u32(28, DAW_AUDIO_UTILITY_MATRIX_STEREO);
    write_u32(32, 0); write_u32(36, 1);
  } else if (kind == DAW_AUDIO_PROCESSOR_KIND_SATURATOR) {
    fixture.size = 32;
    write_u32(0, 1); write_f32(4, 18.0F); write_u32(8, DAW_AUDIO_SATURATOR_CURVE_HARD);
    write_u32(12, 1); write_f32(16, 2500.0F); write_f32(20, 0.5F);
    write_f32(24, -3.0F); write_f32(28, 0.75F);
  } else if (kind == DAW_AUDIO_PROCESSOR_KIND_EQ) {
    fixture.size = 200;
    write_u32(0, 1); write_u32(4, 0);
    for (uint32_t band = 0; band < 8; ++band) {
      const uint32_t offset = 8 + band * 24;
      write_u32(offset, band < 3 ? 1 : 0);
      write_u32(offset + 4, band == 0 ? DAW_AUDIO_EQ_BAND_HIGHPASS : DAW_AUDIO_EQ_BAND_PEAKING);
      write_f32(offset + 8, band == 0 ? 120.0F : 1000.0F);
      write_f32(offset + 12, band == 1 ? 6.0F : 0.0F);
      write_f32(offset + 16, 1.0F);
    }
  } else if (kind == DAW_AUDIO_PROCESSOR_KIND_GATE) {
    fixture.size = 60; fixture.latency = 96;
    write_u32(0, 1); write_u32(4, 0); write_f32(8, -24.0F); write_f32(12, 3.0F);
    write_f32(16, 1.0F); write_f32(20, 8.0F); write_f32(24, 40.0F); write_f32(28, 4.0F);
    write_f32(32, -48.0F); write_f32(36, 1.0F); write_u32(40, 0); write_f32(44, 0.75F);
    write_u32(48, 0); write_f32(52, 80.0F); write_f32(56, 0.707F);
  } else if (kind == DAW_AUDIO_PROCESSOR_KIND_COMPRESSOR) {
    fixture.size = 72; fixture.latency = 480;
    write_u32(0, 1); write_f32(4, -18.0F); write_f32(8, 4.0F); write_f32(12, 3.0F);
    write_f32(16, 60.0F); write_u32(20, 0); write_f32(24, 2.0F); write_f32(28, -1.0F);
    write_f32(32, 0.8F); write_f32(36, 6.0F); write_f32(40, 4.0F); write_u32(44, 0);
    write_u32(48, 0); write_u32(52, 0); write_u32(56, 0); write_u32(60, 1);
    write_f32(64, 120.0F); write_f32(68, 0.707F);
  } else if (kind == DAW_AUDIO_PROCESSOR_KIND_LIMITER) {
    fixture.size = 24; fixture.latency = 240;
    write_u32(0, 1); write_f32(4, -6.0F); write_f32(8, 50.0F); write_f32(12, 5.0F);
    write_f32(16, 1.0F); write_u32(20, 4);
  } else if (kind == DAW_AUDIO_PROCESSOR_KIND_DELAY) {
    fixture.size = 32;
    write_u32(0, 1); write_f32(4, 10.0F); write_f32(8, 0.5F); write_f32(12, 0.5F);
    write_u32(16, 1); write_u32(20, 1); write_f32(24, 120.0F); write_f32(28, 8000.0F);
  } else {
    fixture.size = 60; fixture.latency = 512;
    write_u32(0, 1); write_u32(4, 512); write_u32(8, 4); write_u32(12, DAW_AUDIO_SPECTRAL_MODE_FREEZE);
    write_f32(16, 0.0F); write_f32(20, -60.0F); write_f32(24, 10.0F); write_f32(28, 100.0F);
    write_f32(32, 0.0F); write_f32(36, 0.0F); write_f32(40, 0.0F); write_f32(44, 0.0F);
    write_f32(48, 0.0F); write_f32(52, 0.0F); write_f32(56, 1.0F);
  }
  return fixture;
}

void test_per_instance_history_isolation_and_republication() {
  constexpr uint32_t frames = 1024;
  const std::array<daw_audio_graph_edge_descriptor, 1> edges{{
    {.id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F,
      .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0},
  }};
  const auto nodes_for = [](bool extra) {
    if (extra) {
      return std::array<daw_audio_graph_node_descriptor, 3>{{
        {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
          .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
        {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
          .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
        {.id = 3, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
          .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
      }};
    }
    return std::array<daw_audio_graph_node_descriptor, 3>{{
      {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
        .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
      {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
        .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
      {.id = 0, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
        .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
    }};
  };
  const auto render = [&](uint32_t kind, bool republish) {
    HistoryFixtureState state = history_fixture_state(kind);
    auto nodes = nodes_for(false);
    nodes[1].latency_frames = state.latency;
    const daw_audio_processor_descriptor processor{
      .node_id = 2, .instance_id = 77, .kind = kind, .state_version = 1, .state_size = state.size,
      .bypassed = 0, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .latency_frames = state.latency, .tail_frames = 0, .parameter_count = 0,
      .parameter_targets = nullptr, .state = state.bytes.data(),
    };
    daw_audio_core_handle core = create_core(frames, 2, 1);
    daw_audio_graph_prepare_request request{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 1, .node_count = 2, .edge_count = 1,
      .processor_count = 1, .nodes = nodes.data(), .edges = edges.data(), .processors = &processor,
    };
    expect(daw_audio_core_prepare_graph(core, &request), DAW_AUDIO_CORE_OK);
    expect(daw_audio_core_publish(core, 1), DAW_AUDIO_CORE_OK);
    std::array<float, frames> left{}; std::array<float, frames> right{};
    for (uint32_t frame = 0; frame < frames; ++frame) {
      left[frame] = std::sin(static_cast<float>(frame) * 0.071F) * 0.75F + 0.1F;
      right[frame] = std::cos(static_cast<float>(frame) * 0.037F) * 0.5F - 0.05F;
    }
    const float *inputs[]{left.data(), right.data()};
    std::array<float, frames> output_left{}; std::array<float, frames> output_right{};
    float *outputs[]{output_left.data(), output_right.data()};
    daw_audio_core_process_block block{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = frames / 2, .channel_count = 2,
      .input_bus_count = 1, .inputs = inputs, .outputs = outputs,
    };
    expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
    if (republish) {
      auto changed_nodes = nodes_for(true);
      changed_nodes[1].latency_frames = state.latency;
      request.graph_revision = 2;
      request.node_count = 3;
      request.nodes = changed_nodes.data();
      expect(daw_audio_core_prepare_graph(core, &request), DAW_AUDIO_CORE_OK);
      expect(daw_audio_core_publish(core, 2), DAW_AUDIO_CORE_OK);
    }
    block.graph_revision = republish ? 2 : 1;
    const float *second_inputs[]{inputs[0] + frames / 2, inputs[1] + frames / 2};
    float *second_outputs[]{outputs[0] + frames / 2, outputs[1] + frames / 2};
    block.inputs = second_inputs;
    block.outputs = second_outputs;
    expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
    daw_audio_core_destroy(core);
    return std::pair<std::array<float, frames>, std::array<float, frames>>{output_left, output_right};
  };
  for (const uint32_t kind : {DAW_AUDIO_PROCESSOR_KIND_EQ, DAW_AUDIO_PROCESSOR_KIND_SATURATOR,
    DAW_AUDIO_PROCESSOR_KIND_GATE, DAW_AUDIO_PROCESSOR_KIND_COMPRESSOR, DAW_AUDIO_PROCESSOR_KIND_LIMITER,
    DAW_AUDIO_PROCESSOR_KIND_DELAY, DAW_AUDIO_PROCESSOR_KIND_SPECTRAL, DAW_AUDIO_PROCESSOR_KIND_UTILITY}) {
    const auto continuous = render(kind, false);
    const auto republished = render(kind, true);
    for (uint32_t frame = frames / 2; frame < frames; ++frame) {
      assert(std::abs(continuous.first[frame] - republished.first[frame]) <= 1e-6F);
      assert(std::abs(continuous.second[frame] - republished.second[frame]) <= 1e-6F);
    }
  }
}

void test_utility_history_isolated_between_instances_and_standalone() {
  constexpr uint32_t frames = 32;
  const std::array<daw_audio_graph_node_descriptor, 5> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 1, .latency_frames = 0},
    {.id = 3, .kind = DAW_AUDIO_GRAPH_NODE_UTILITY, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
    {.id = 4, .kind = DAW_AUDIO_GRAPH_NODE_UTILITY, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
    {.id = 5, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const std::array<daw_audio_graph_edge_descriptor, 4> edges{{
    {.id = 1, .from_node_id = 1, .to_node_id = 3, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER},
    {.id = 2, .from_node_id = 2, .to_node_id = 4, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER},
    {.id = 3, .from_node_id = 3, .to_node_id = 5, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER},
    {.id = 4, .from_node_id = 4, .to_node_id = 5, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER},
  }};
  const auto utility_bytes = [](uint32_t polarity, uint32_t enabled) {
    std::array<uint8_t, 40> bytes{};
    const auto write_u32 = [&bytes](uint32_t offset, uint32_t value) {
      bytes[offset] = static_cast<uint8_t>(value); bytes[offset + 1] = static_cast<uint8_t>(value >> 8u);
      bytes[offset + 2] = static_cast<uint8_t>(value >> 16u); bytes[offset + 3] = static_cast<uint8_t>(value >> 24u);
    };
    write_u32(0, enabled); write_u32(8, polarity); write_u32(12, DAW_AUDIO_UTILITY_INPUT_MODE_STEREO);
    uint32_t width = 0x3f800000; std::memcpy(bytes.data() + 24, &width, sizeof(width));
    write_u32(28, DAW_AUDIO_UTILITY_MATRIX_STEREO); write_u32(36, 1);
    return bytes;
  };
  auto state_a = utility_bytes(DAW_AUDIO_UTILITY_POLARITY_NORMAL, 1);
  auto state_b = utility_bytes(DAW_AUDIO_UTILITY_POLARITY_INVERT, 1);
  const daw_audio_processor_descriptor processors[2]{
    {.node_id = 3, .instance_id = 101, .kind = DAW_AUDIO_PROCESSOR_KIND_UTILITY, .state_version = 1,
      .state_size = 40, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .parameter_count = 0, .state = state_a.data()},
    {.node_id = 4, .instance_id = 102, .kind = DAW_AUDIO_PROCESSOR_KIND_UTILITY, .state_version = 1,
      .state_size = 40, .bypassed = 1, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .parameter_count = 0, .state = state_b.data()},
  };
  daw_audio_core_handle core = create_core(frames, 2, 1);
  const daw_audio_graph_prepare_request request{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 1, .node_count = 5, .edge_count = 4,
    .processor_count = 2, .nodes = nodes.data(), .edges = edges.data(), .processors = processors,
  };
  expect(daw_audio_core_prepare_graph(core, &request), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_publish(core, 1), DAW_AUDIO_CORE_OK);
  std::array<float, frames> a_left{}; std::array<float, frames> a_right{};
  std::array<float, frames> b_left{}; std::array<float, frames> b_right{};
  for (uint32_t frame = 0; frame < frames; ++frame) {
    a_left[frame] = 0.4F; a_right[frame] = 0.2F;
    b_left[frame] = -0.3F; b_right[frame] = -0.1F;
  }
  const float *inputs[]{a_left.data(), a_right.data(), b_left.data(), b_right.data()};
  std::array<float, frames> output_left{}; std::array<float, frames> output_right{};
  float *outputs[]{output_left.data(), output_right.data()};
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = frames, .channel_count = 2,
    .input_bus_count = 2, .inputs = inputs, .outputs = outputs,
  };
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(std::abs(output_left[0] - 0.69875F) <= 1e-4F);
  assert(std::abs(output_right[0] - 0.29958F) <= 1e-4F);

  expect(daw_audio_core_wasm_utility_initialize(48000, frames), DAW_AUDIO_CORE_OK);
  std::array<float, frames> standalone_left{}; std::array<float, frames> standalone_right{};
  daw_audio_utility_state standalone_state{
    .enabled = 1, .gain_db = 0.0F, .polarity = DAW_AUDIO_UTILITY_POLARITY_NORMAL,
    .input_mode = DAW_AUDIO_UTILITY_INPUT_MODE_STEREO, .pan = 0.0F, .balance = 0.0F, .width = 1.0F,
    .matrix = DAW_AUDIO_UTILITY_MATRIX_STEREO, .swap = 0, .dc_block = 1,
  };
  expect(daw_audio_core_wasm_utility_process(frames, a_left.data(), a_right.data(),
    standalone_left.data(), standalone_right.data(), &standalone_state), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  for (uint32_t frame = 0; frame < frames; ++frame) assert(std::isfinite(output_left[frame]) && std::isfinite(output_right[frame]));
  daw_audio_core_destroy(core);
}

void test_processor_chain_prepare_and_dispatch() {
  daw_audio_core_handle core = create_core(4, 2, 1);
  const std::array<daw_audio_graph_node_descriptor, 2> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const std::array<daw_audio_graph_edge_descriptor, 1> edges{{
    {.id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0},
  }};
  std::array<uint8_t, 40> state{};
  const auto write_u32 = [&state](uint32_t offset, uint32_t value) {
    state[offset] = static_cast<uint8_t>(value);
    state[offset + 1] = static_cast<uint8_t>(value >> 8u);
    state[offset + 2] = static_cast<uint8_t>(value >> 16u);
    state[offset + 3] = static_cast<uint8_t>(value >> 24u);
  };
  const auto write_f32 = [&state, &write_u32](uint32_t offset, float value) {
    uint32_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    write_u32(offset, bits);
  };
  write_u32(0, 1);
  write_f32(4, 0.0F);
  write_u32(8, DAW_AUDIO_UTILITY_POLARITY_INVERT);
  write_u32(12, DAW_AUDIO_UTILITY_INPUT_MODE_STEREO);
  write_f32(16, 0.0F);
  write_f32(20, 0.0F);
  write_f32(24, 1.0F);
  write_u32(28, DAW_AUDIO_UTILITY_MATRIX_STEREO);
  const std::array<uint32_t, 4> targets{1, 2, 3, 4};
  const daw_audio_processor_descriptor processor{
    .node_id = 2, .instance_id = 42, .kind = DAW_AUDIO_PROCESSOR_KIND_UTILITY,
    .state_version = 1, .state_size = static_cast<uint32_t>(state.size()), .bypassed = 0,
    .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .latency_frames = 0, .tail_frames = 0, .parameter_count = static_cast<uint32_t>(targets.size()),
    .parameter_targets = targets.data(), .state = state.data(),
  };
  const daw_audio_graph_prepare_request request{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 1,
    .node_count = static_cast<uint32_t>(nodes.size()), .edge_count = static_cast<uint32_t>(edges.size()),
    .processor_count = 1, .nodes = nodes.data(), .edges = edges.data(), .processors = &processor,
  };
  expect(daw_audio_core_prepare_graph(core, &request), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_publish(core, 1), DAW_AUDIO_CORE_OK);
  const std::array<float, 1> left{0.25F};
  const std::array<float, 1> right{-0.5F};
  const float *inputs[]{left.data(), right.data()};
  std::array<float, 1> output_left{};
  std::array<float, 1> output_right{};
  float *outputs[]{output_left.data(), output_right.data()};
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 1, .channel_count = 2,
    .input_bus_count = 1, .inputs = inputs, .outputs = outputs,
  };
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(std::abs(output_left[0] + 0.25F) <= 1e-6F);
  assert(std::abs(output_right[0] - 0.5F) <= 1e-6F);
  const std::array<float, 2> parameter_input{1.0F, 1.0F};
  const float *parameter_inputs[]{parameter_input.data(), parameter_input.data()};
  std::array<float, 2> parameter_left{};
  std::array<float, 2> parameter_right{};
  float *parameter_outputs[]{parameter_left.data(), parameter_right.data()};
  const std::array<uint32_t, 1> parameter_targets{DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_PAN};
  const std::array<float, 2> parameter_values{-1.0F, 1.0F};
  const daw_audio_processor_parameter_block parameter_block{
    .processor_instance_id = 42, .frame_count = 2, .parameter_count = 1,
    .parameter_targets = parameter_targets.data(), .values = parameter_values.data(),
  };
  const daw_audio_processor_event parameter_event{
    .processor_instance_id = 42, .parameter_target = DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_PAN,
    .frame_offset = 1, .value = 0.0F,
  };
  const daw_audio_core_process_block parameter_process{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 2, .channel_count = 2,
    .input_bus_count = 1, .inputs = parameter_inputs, .outputs = parameter_outputs,
    .graph_revision = 1, .parameter_block_count = 1, .parameter_blocks = &parameter_block,
    .event_count = 1, .events = &parameter_event,
  };
  expect(daw_audio_core_process(core, &parameter_process), DAW_AUDIO_CORE_OK);
  assert(std::abs(parameter_left[0] + 1.41421356F) <= 1e-6F);
  assert(std::abs(parameter_right[0]) <= 1e-6F);
  assert(std::abs(parameter_left[1] + 1.0F) <= 1e-6F);
  assert(std::abs(parameter_right[1] + 1.0F) <= 1e-6F);
  std::array<float, 2> persistent_left{};
  std::array<float, 2> persistent_right{};
  float *persistent_outputs[]{persistent_left.data(), persistent_right.data()};
  const daw_audio_core_process_block persistent_process{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 2, .channel_count = 2,
    .input_bus_count = 1, .inputs = parameter_inputs, .outputs = persistent_outputs,
    .graph_revision = 1,
  };
  expect(daw_audio_core_process(core, &persistent_process), DAW_AUDIO_CORE_OK);
  assert(std::abs(persistent_left[0] + 1.0F) <= 1e-6F);
  assert(std::abs(persistent_right[0] + 1.0F) <= 1e-6F);
  const std::array<daw_audio_processor_event, 2> multiple_events{{
    {.processor_instance_id = 42, .parameter_target = DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_PAN,
      .frame_offset = 0, .value = -1.0F},
    {.processor_instance_id = 42, .parameter_target = DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_PAN,
      .frame_offset = 1, .value = 0.5F},
  }};
  std::array<float, 2> multiple_left{};
  std::array<float, 2> multiple_right{};
  float *multiple_outputs[]{multiple_left.data(), multiple_right.data()};
  daw_audio_core_process_block multiple_process = persistent_process;
  multiple_process.outputs = multiple_outputs;
  multiple_process.event_count = static_cast<uint32_t>(multiple_events.size());
  multiple_process.events = multiple_events.data();
  expect(daw_audio_core_process(core, &multiple_process), DAW_AUDIO_CORE_OK);
  std::array<float, 1> final_left{};
  std::array<float, 1> final_right{};
  float *final_outputs[]{final_left.data(), final_right.data()};
  const std::array<float, 1> final_input{1.0F};
  const float *final_inputs[]{final_input.data(), final_input.data()};
  const daw_audio_processor_event rejected_event{
    .processor_instance_id = 42, .parameter_target = DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_PAN,
    .frame_offset = 0, .value = 2.0F,
  };
  daw_audio_core_process_block rejected_process{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 1, .channel_count = 2,
    .input_bus_count = 1, .inputs = final_inputs, .outputs = final_outputs,
    .graph_revision = 1, .event_count = 1, .events = &rejected_event,
  };
  expect(daw_audio_core_process(core, &rejected_process), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  rejected_process.event_count = 0;
  rejected_process.events = nullptr;
  expect(daw_audio_core_process(core, &rejected_process), DAW_AUDIO_CORE_OK);
  assert(std::abs(final_left[0] - multiple_left[1]) <= 1e-6F);
  assert(std::abs(final_right[0] - multiple_right[1]) <= 1e-6F);
  daw_audio_core_process_block stale_process = parameter_process;
  stale_process.graph_revision = 2;
  expect(daw_audio_core_process(core, &stale_process), DAW_AUDIO_CORE_STALE_REVISION);
  stale_process.graph_revision = 1;
  stale_process.parameter_block_count = DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETER_BLOCKS + 1;
  expect(daw_audio_core_process(core, &stale_process), DAW_AUDIO_CORE_CAPACITY_EXCEEDED);
  daw_audio_processor_descriptor duplicate = processor;
  std::array<daw_audio_processor_descriptor, 2> duplicates{processor, duplicate};
  daw_audio_graph_prepare_request duplicate_request = request;
  duplicate_request.graph_revision = 2;
  duplicate_request.processor_count = 2;
  duplicate_request.processors = duplicates.data();
  expect(daw_audio_core_prepare_graph(core, &duplicate_request), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  daw_audio_processor_descriptor unknown = processor;
  unknown.kind = 999;
  daw_audio_graph_prepare_request unknown_request = request;
  unknown_request.graph_revision = 2;
  unknown_request.processors = &unknown;
  expect(daw_audio_core_prepare_graph(core, &unknown_request), DAW_AUDIO_CORE_PROCESSOR_KIND_UNKNOWN);
  daw_audio_processor_descriptor oversized = processor;
  oversized.state_size = DAW_AUDIO_CORE_MAX_PROCESSOR_STATE_BYTES + 1;
  daw_audio_graph_prepare_request oversized_request = request;
  oversized_request.graph_revision = 2;
  oversized_request.processors = &oversized;
  expect(daw_audio_core_prepare_graph(core, &oversized_request), DAW_AUDIO_CORE_PROCESSOR_STATE_INVALID);
  daw_audio_processor_descriptor mismatched = processor;
  mismatched.state_version = 2;
  daw_audio_graph_prepare_request mismatch_request = request;
  mismatch_request.graph_revision = 2;
  mismatch_request.processors = &mismatched;
  expect(daw_audio_core_prepare_graph(core, &mismatch_request), DAW_AUDIO_CORE_PROCESSOR_STATE_INVALID);
  std::array<uint8_t, 32> saturator_state{};
  const auto write_saturator_u32 = [&saturator_state](uint32_t offset, uint32_t value) {
    saturator_state[offset] = static_cast<uint8_t>(value);
    saturator_state[offset + 1] = static_cast<uint8_t>(value >> 8u);
    saturator_state[offset + 2] = static_cast<uint8_t>(value >> 16u);
    saturator_state[offset + 3] = static_cast<uint8_t>(value >> 24u);
  };
  const auto write_saturator_f32 = [&saturator_state, &write_saturator_u32](uint32_t offset, float value) {
    uint32_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    write_saturator_u32(offset, bits);
  };
  write_saturator_u32(0, 1);
  write_saturator_f32(4, 6.0F);
  write_saturator_u32(8, DAW_AUDIO_SATURATOR_CURVE_SOFT);
  write_saturator_u32(12, 0);
  write_saturator_f32(16, 1200.0F);
  write_saturator_f32(20, 0.0F);
  write_saturator_f32(24, 0.0F);
  write_saturator_f32(28, 1.0F);
  const daw_audio_processor_descriptor saturator{
    .node_id = 2, .instance_id = 43, .kind = DAW_AUDIO_PROCESSOR_KIND_SATURATOR,
    .state_version = 1, .state_size = static_cast<uint32_t>(saturator_state.size()), .bypassed = 0,
    .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .latency_frames = 0, .tail_frames = 0, .parameter_count = 0,
    .parameter_targets = nullptr, .state = saturator_state.data(),
  };
  daw_audio_graph_prepare_request saturator_request = request;
  saturator_request.graph_revision = 2;
  saturator_request.processors = &saturator;
  expect(daw_audio_core_prepare_graph(core, &saturator_request), DAW_AUDIO_CORE_OK);
  daw_audio_core_destroy(core);
}

void test_portable_saturator_and_eq_characterization() {
  daw_audio_core_handle core = create_core(64, 2, 1);
  const std::array<daw_audio_graph_node_descriptor, 2> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const std::array<daw_audio_graph_edge_descriptor, 1> edges{{
    {.id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0},
  }};
  const auto write_u32 = [](std::array<uint8_t, 200> &bytes, uint32_t offset, uint32_t value) {
    bytes[offset] = static_cast<uint8_t>(value);
    bytes[offset + 1] = static_cast<uint8_t>(value >> 8u);
    bytes[offset + 2] = static_cast<uint8_t>(value >> 16u);
    bytes[offset + 3] = static_cast<uint8_t>(value >> 24u);
  };
  const auto write_f32 = [&write_u32](std::array<uint8_t, 200> &bytes, uint32_t offset, float value) {
    uint32_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    write_u32(bytes, offset, bits);
  };
  std::array<uint8_t, 200> state{};
  write_u32(state, 0, 1);
  write_f32(state, 4, 18.0F);
  write_u32(state, 8, DAW_AUDIO_SATURATOR_CURVE_HARD);
  write_u32(state, 12, 0);
  write_f32(state, 16, 1200.0F);
  write_f32(state, 20, 0.0F);
  write_f32(state, 24, 0.0F);
  write_f32(state, 28, 1.0F);
  daw_audio_processor_descriptor saturator{
    .node_id = 2, .instance_id = 1, .kind = DAW_AUDIO_PROCESSOR_KIND_SATURATOR,
    .state_version = 1, .state_size = 32, .bypassed = 0,
    .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .latency_frames = 0, .tail_frames = 0, .parameter_count = 0, .parameter_targets = nullptr, .state = state.data(),
  };
  daw_audio_graph_prepare_request prepare{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 1,
    .node_count = 2, .edge_count = 1, .processor_count = 1,
    .nodes = nodes.data(), .edges = edges.data(), .processors = &saturator,
  };
  const uint32_t undeclared_target = DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB;
  saturator.latency_frames = 1;
  expect(daw_audio_core_prepare_graph(core, &prepare), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  saturator.latency_frames = 0;
  saturator.tail_frames = 1;
  expect(daw_audio_core_prepare_graph(core, &prepare), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  saturator.tail_frames = 0;
  saturator.parameter_count = 1;
  saturator.parameter_targets = &undeclared_target;
  expect(daw_audio_core_prepare_graph(core, &prepare), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  saturator.parameter_count = 0;
  saturator.parameter_targets = nullptr;
  expect(daw_audio_core_prepare_graph(core, &prepare), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_publish(core, 1), DAW_AUDIO_CORE_OK);
  std::array<float, 64> left{};
  std::array<float, 64> right{};
  left[0] = right[0] = 1.0F;
  for (uint32_t index = 1; index < left.size(); ++index) {
    left[index] = index < 16 ? 0.25F : std::sin(static_cast<float>(index * index) * 0.005F);
    right[index] = std::sin(static_cast<float>(index) * 0.07F);
  }
  const float *inputs[]{left.data(), right.data()};
  std::array<float, 64> saturated_left{};
  std::array<float, 64> saturated_right{};
  float *outputs[]{saturated_left.data(), saturated_right.data()};
  daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 64, .channel_count = 2,
    .input_bus_count = 1, .inputs = inputs, .outputs = outputs,
  };
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(std::isfinite(saturated_left[0]) && std::isfinite(saturated_right[0]));
  assert(std::abs(saturated_left[0] - left[0]) > 0.05F);
  for (float sample : saturated_left) assert(std::isfinite(sample));
  saturator.bypassed = 1;
  prepare.graph_revision = 2;
  expect(daw_audio_core_prepare_graph(core, &prepare), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_publish(core, 2), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  for (uint32_t index = 0; index < left.size(); ++index) assert(std::abs(saturated_left[index] - left[index]) <= 1e-6F);

  state.fill(0);
  write_u32(state, 0, 1);
  write_u32(state, 4, 1);
  for (uint32_t band = 0; band < 8; ++band) {
    const uint32_t offset = 8 + band * 24;
    write_u32(state, offset, band == 0 ? 1 : 0);
    write_u32(state, offset + 4, band == 0 ? DAW_AUDIO_EQ_BAND_LOWPASS : DAW_AUDIO_EQ_BAND_PEAKING);
    write_f32(state, offset + 8, band == 0 ? 1000.0F : 1000.0F);
    write_f32(state, offset + 12, 0.0F);
    write_f32(state, offset + 16, 1.0F);
  }
  daw_audio_processor_descriptor eq{
    .node_id = 2, .instance_id = 2, .kind = DAW_AUDIO_PROCESSOR_KIND_EQ,
    .state_version = 1, .state_size = 200, .bypassed = 0,
    .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .latency_frames = 0, .tail_frames = 0, .parameter_count = 0, .parameter_targets = nullptr, .state = state.data(),
  };
  prepare.graph_revision = 3;
  prepare.processors = &eq;
  eq.latency_frames = 1;
  expect(daw_audio_core_prepare_graph(core, &prepare), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  eq.latency_frames = 0;
  eq.tail_frames = 1;
  expect(daw_audio_core_prepare_graph(core, &prepare), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  eq.tail_frames = 0;
  eq.parameter_count = 1;
  eq.parameter_targets = &undeclared_target;
  expect(daw_audio_core_prepare_graph(core, &prepare), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  eq.parameter_count = 0;
  eq.parameter_targets = nullptr;
  expect(daw_audio_core_prepare_graph(core, &prepare), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_publish(core, 3), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(std::isfinite(saturated_left[0]) && std::isfinite(saturated_right[0]));
  assert(std::abs(saturated_left[0] - saturated_right[0]) <= 1e-6F);
  left[0] = NAN;
  right[0] = NAN;
  block.frame_count = 1;
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(std::isfinite(saturated_left[0]) && std::isfinite(saturated_right[0]));
  daw_audio_core_destroy(core);
}

void test_targeted_sidechain_routing() {
  daw_audio_core_handle core = create_core(512, 2, 1);
  const std::array<daw_audio_graph_node_descriptor, 3> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 1, .latency_frames = 480},
    {.id = 3, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  std::array<daw_audio_graph_edge_descriptor, 2> edges{{
    {.id = 1, .from_node_id = 2, .to_node_id = 3, .target_processor_id = 0, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0},
    {.id = 2, .from_node_id = 1, .to_node_id = 2, .target_processor_id = 77, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 1, .pdc_delay_frames = 0},
  }};
  std::array<uint8_t, 72> state{};
  const auto write_u32 = [&state](uint32_t offset, uint32_t value) {
    state[offset] = static_cast<uint8_t>(value); state[offset + 1] = static_cast<uint8_t>(value >> 8u);
    state[offset + 2] = static_cast<uint8_t>(value >> 16u); state[offset + 3] = static_cast<uint8_t>(value >> 24u);
  };
  const auto write_f32 = [&write_u32](uint32_t offset, float value) {
    uint32_t bits = 0; std::memcpy(&bits, &value, sizeof(bits)); write_u32(offset, bits);
  };
  write_u32(0, 1); write_f32(4, -60.0F); write_f32(8, 100.0F); write_f32(12, 0.1F); write_f32(16, 5.0F);
  write_u32(20, 0); write_f32(24, 0.0F); write_f32(28, 0.0F); write_f32(32, 1.0F); write_f32(36, 0.0F); write_f32(40, 0.0F);
  write_u32(44, 0); write_u32(48, 0); write_u32(52, 0); write_u32(56, 1); write_u32(60, 1); write_f32(64, 120.0F); write_f32(68, 0.707F);
  const daw_audio_processor_descriptor processor{
    .node_id = 2, .instance_id = 99, .kind = DAW_AUDIO_PROCESSOR_KIND_COMPRESSOR, .state_version = 1, .state_size = 72,
    .bypassed = 0, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .latency_frames = 480, .tail_frames = 0, .parameter_count = 0, .parameter_targets = nullptr, .state = state.data(),
  };
  daw_audio_graph_prepare_request request{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 1, .node_count = 3, .edge_count = 2,
    .processor_count = 1, .nodes = nodes.data(), .edges = edges.data(), .processors = &processor,
  };
  expect(daw_audio_core_prepare_graph(core, &request), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  edges[1].target_processor_id = 99;
  expect(daw_audio_core_prepare_graph(core, &request), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_publish(core, 1), DAW_AUDIO_CORE_OK);
  std::array<float, 512> sidechain_left{};
  std::array<float, 512> sidechain_right{};
  std::array<float, 512> program_left{};
  std::array<float, 512> program_right{};
  program_left.fill(1.0F); program_right.fill(1.0F);
  const float *inputs[]{sidechain_left.data(), sidechain_right.data(), program_left.data(), program_right.data()};
  std::array<float, 512> output_left{};
  std::array<float, 512> output_right{};
  float *outputs[]{output_left.data(), output_right.data()};
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 512, .channel_count = 2,
    .input_bus_count = 2, .inputs = inputs, .outputs = outputs,
  };
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(output_left[511] > 0.9F);
  sidechain_left.fill(1.0F); sidechain_right.fill(1.0F);
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(output_left[511] < 0.5F);
  daw_audio_core_destroy(core);
}

void test_portable_modulation_processor_characterization() {
  const std::array<daw_audio_graph_node_descriptor, 2> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const std::array<daw_audio_graph_edge_descriptor, 1> edges{{
    {.id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0},
  }};
  const auto write_u32 = [](std::array<uint8_t, 32> &bytes, uint32_t offset, uint32_t value) {
    bytes[offset] = static_cast<uint8_t>(value); bytes[offset + 1] = static_cast<uint8_t>(value >> 8u);
    bytes[offset + 2] = static_cast<uint8_t>(value >> 16u); bytes[offset + 3] = static_cast<uint8_t>(value >> 24u);
  };
  const auto write_f32 = [&write_u32](std::array<uint8_t, 32> &bytes, uint32_t offset, float value) {
    uint32_t bits = 0; std::memcpy(&bits, &value, sizeof(bits)); write_u32(bytes, offset, bits);
  };
  const auto render = [&](uint32_t kind, uint32_t state_size, const std::array<uint8_t, 32> &state) {
    daw_audio_core_handle core = create_core(4096, 2, 1);
    const daw_audio_processor_descriptor processor{
      .node_id = 2, .instance_id = 100 + kind, .kind = kind, .state_version = 1, .state_size = state_size,
      .bypassed = 0, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .latency_frames = 0, .tail_frames = 0, .parameter_count = 0, .parameter_targets = nullptr, .state = state.data(),
    };
    const daw_audio_graph_prepare_request request{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 1, .node_count = 2, .edge_count = 1,
      .processor_count = 1, .nodes = nodes.data(), .edges = edges.data(), .processors = &processor,
    };
    expect(daw_audio_core_prepare_graph(core, &request), DAW_AUDIO_CORE_OK);
    expect(daw_audio_core_publish(core, 1), DAW_AUDIO_CORE_OK);
    std::array<float, 4096> left{}; std::array<float, 4096> right{}; left[0] = 1.0F; right[0] = -0.5F;
    const float *inputs[]{left.data(), right.data()};
    std::array<float, 4096> output_left{}; std::array<float, 4096> output_right{}; float *outputs[]{output_left.data(), output_right.data()};
    const daw_audio_core_process_block block{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 4096, .channel_count = 2, .input_bus_count = 1, .inputs = inputs, .outputs = outputs,
    };
    expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
    for (uint32_t index = 0; index < output_left.size(); ++index) {
      assert(std::isfinite(output_left[index]) && std::isfinite(output_right[index]));
    }
    daw_audio_core_destroy(core);
  };
  std::array<uint8_t, 32> state{};
  write_u32(state, 0, 1); write_f32(state, 4, 12.0F); write_f32(state, 8, 4.0F); write_f32(state, 12, 0.8F);
  write_f32(state, 16, 0.0F); write_f32(state, 20, 0.25F); write_f32(state, 24, 0.35F);
  render(DAW_AUDIO_PROCESSOR_KIND_CHORUS, 28, state);
  write_f32(state, 4, 1.5F); write_f32(state, 8, 1.0F); write_f32(state, 12, 0.2F); write_f32(state, 16, 0.35F); write_f32(state, 20, 0.5F); write_f32(state, 24, 0.5F);
  render(DAW_AUDIO_PROCESSOR_KIND_FLANGER, 28, state);
  state.fill(0); write_u32(state, 0, 1); write_u32(state, 4, 6); write_f32(state, 8, 1000.0F); write_f32(state, 12, 3.0F);
  write_f32(state, 16, 0.3F); write_f32(state, 20, 0.3F); write_f32(state, 24, 0.5F); write_f32(state, 28, 0.5F);
  render(DAW_AUDIO_PROCESSOR_KIND_PHASER, 32, state);
  state.fill(0); write_u32(state, 0, 1); write_u32(state, 4, 0); write_f32(state, 8, 4.0F); write_f32(state, 12, 0.5F); write_f32(state, 16, 0.5F); write_f32(state, 20, 0.0F);
  render(DAW_AUDIO_PROCESSOR_KIND_TREMOLO, 24, state);
  write_f32(state, 8, 1.0F); write_f32(state, 12, 1.0F);
  render(DAW_AUDIO_PROCESSOR_KIND_AUTOPAN, 24, state);
  state.fill(0); write_u32(state, 0, 1); write_u32(state, 4, 3); write_f32(state, 8, 18.0F); write_f32(state, 12, 6.0F); write_f32(state, 16, 0.6F); write_f32(state, 20, 1.0F); write_f32(state, 24, 0.5F);
  render(DAW_AUDIO_PROCESSOR_KIND_ENSEMBLE, 28, state);
}

void test_portable_dynamics_processor_characterization() {
  const std::array<daw_audio_graph_node_descriptor, 2> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const std::array<daw_audio_graph_edge_descriptor, 1> edges{{
    {.id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0},
  }};
  const auto write_u32 = [](std::array<uint8_t, 72> &bytes, uint32_t offset, uint32_t value) {
    bytes[offset] = static_cast<uint8_t>(value); bytes[offset + 1] = static_cast<uint8_t>(value >> 8u);
    bytes[offset + 2] = static_cast<uint8_t>(value >> 16u); bytes[offset + 3] = static_cast<uint8_t>(value >> 24u);
  };
  const auto write_f32 = [&write_u32](std::array<uint8_t, 72> &bytes, uint32_t offset, float value) {
    uint32_t bits = 0; std::memcpy(&bits, &value, sizeof(bits)); write_u32(bytes, offset, bits);
  };
  const auto render = [&](uint32_t kind, uint32_t state_size, const std::array<uint8_t, 72> &state, uint32_t latency) {
    daw_audio_core_handle core = create_core(4096, 2, 1);
    std::array<daw_audio_graph_node_descriptor, 2> processor_nodes = nodes;
    processor_nodes[1].latency_frames = latency;
    const daw_audio_processor_descriptor processor{
      .node_id = 2, .instance_id = kind, .kind = kind, .state_version = 1, .state_size = state_size, .bypassed = 0,
      .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .latency_frames = latency, .tail_frames = 0, .parameter_count = 0, .parameter_targets = nullptr, .state = state.data(),
    };
    const daw_audio_graph_prepare_request request{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 1, .node_count = 2, .edge_count = 1,
      .processor_count = 1, .nodes = processor_nodes.data(), .edges = edges.data(), .processors = &processor,
    };
    expect(daw_audio_core_prepare_graph(core, &request), DAW_AUDIO_CORE_OK);
    expect(daw_audio_core_publish(core, 1), DAW_AUDIO_CORE_OK);
    std::array<float, 4096> left{}; std::array<float, 4096> right{}; left.fill(1.0F); right.fill(0.5F);
    const float *inputs[]{left.data(), right.data()};
    std::array<float, 4096> output_left{}; std::array<float, 4096> output_right{}; float *outputs[]{output_left.data(), output_right.data()};
    daw_audio_core_process_block block{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 4096, .channel_count = 2, .input_bus_count = 1, .inputs = inputs, .outputs = outputs,
    };
    expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
    for (uint32_t index = 0; index < output_left.size(); ++index) assert(std::isfinite(output_left[index]) && std::isfinite(output_right[index]));
    const float last = output_left.back();
    block.frame_count = 1;
    left[0] = NAN; right[0] = NAN;
    expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
    assert(std::isfinite(output_left[0]) && std::isfinite(output_right[0]));
    daw_audio_core_destroy(core);
    return last;
  };
  std::array<uint8_t, 72> state{};
  write_u32(state, 0, 1); write_u32(state, 4, 0); write_f32(state, 8, -20.0F); write_f32(state, 12, 4.0F);
  write_f32(state, 16, 0.1F); write_f32(state, 20, 0.0F); write_f32(state, 24, 5.0F); write_f32(state, 28, 0.0F);
  write_f32(state, 32, -40.0F); write_f32(state, 36, 0.0F); write_u32(state, 40, 0); write_f32(state, 44, 1.0F);
  write_u32(state, 48, 1); write_f32(state, 52, 80.0F); write_f32(state, 56, 0.707F);
  const float gate = render(DAW_AUDIO_PROCESSOR_KIND_GATE, 60, state, 96);
  assert(gate < 0.02F);
  state.fill(0); write_u32(state, 0, 1); write_f32(state, 4, -24.0F); write_f32(state, 8, 4.0F);
  write_f32(state, 12, 0.1F); write_f32(state, 16, 5.0F); write_u32(state, 20, 0); write_f32(state, 24, 0.0F);
  write_f32(state, 28, 0.0F); write_f32(state, 32, 1.0F); write_f32(state, 36, 0.0F); write_f32(state, 40, 0.0F);
  write_u32(state, 44, 0); write_u32(state, 48, 0); write_u32(state, 52, 0); write_u32(state, 56, 0); write_u32(state, 60, 0);
  write_f32(state, 64, 120.0F); write_f32(state, 68, 0.707F);
  const float compressor = render(DAW_AUDIO_PROCESSOR_KIND_COMPRESSOR, 72, state, 480);
  assert(compressor < 0.8F);
  state.fill(0); write_u32(state, 0, 1); write_f32(state, 4, -6.0F); write_f32(state, 8, 20.0F);
  write_f32(state, 12, 5.0F); write_f32(state, 16, 1.0F); write_u32(state, 20, 4);
  const float limiter = render(DAW_AUDIO_PROCESSOR_KIND_LIMITER, 24, state, 240);
  assert(limiter <= std::pow(10.0F, -6.0F / 20.0F) + 1e-3F);
}

void test_portable_delay_and_reverb_characterization() {
  const std::array<daw_audio_graph_node_descriptor, 2> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const std::array<daw_audio_graph_edge_descriptor, 1> edges{{
    {.id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0},
  }};
  const auto write_u32 = [](std::array<uint8_t, 72> &bytes, uint32_t offset, uint32_t value) {
    bytes[offset] = static_cast<uint8_t>(value); bytes[offset + 1] = static_cast<uint8_t>(value >> 8u);
    bytes[offset + 2] = static_cast<uint8_t>(value >> 16u); bytes[offset + 3] = static_cast<uint8_t>(value >> 24u);
  };
  const auto write_f32 = [&write_u32](std::array<uint8_t, 72> &bytes, uint32_t offset, float value) {
    uint32_t bits = 0; std::memcpy(&bits, &value, sizeof(bits)); write_u32(bytes, offset, bits);
  };
  std::array<uint8_t, 72> state{};
  write_u32(state, 0, 1); write_f32(state, 4, 10.0F); write_f32(state, 8, 0.5F); write_f32(state, 12, 1.0F);
  write_u32(state, 16, 1); write_u32(state, 20, 1); write_f32(state, 24, 120.0F); write_f32(state, 28, 8000.0F);
  daw_audio_processor_descriptor delay{
    .node_id = 2, .instance_id = 13, .kind = DAW_AUDIO_PROCESSOR_KIND_DELAY, .state_version = 1, .state_size = 32,
    .bypassed = 0, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .latency_frames = 0, .tail_frames = 2400, .parameter_count = 0, .parameter_targets = nullptr, .state = state.data(),
  };
  daw_audio_core_handle core = create_core(512, 2, 1);
  daw_audio_graph_prepare_request prepare{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 1, .node_count = 2, .edge_count = 1,
    .processor_count = 1, .nodes = nodes.data(), .edges = edges.data(), .processors = &delay,
  };
  expect(daw_audio_core_prepare_graph(core, &prepare), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_publish(core, 1), DAW_AUDIO_CORE_OK);
  std::array<float, 512> left{}; std::array<float, 512> right{}; left[0] = 1.0F;
  const float *inputs[]{left.data(), right.data()};
  std::array<float, 512> output_left{}; std::array<float, 512> output_right{}; float *outputs[]{output_left.data(), output_right.data()};
  daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 512, .channel_count = 2,
    .input_bus_count = 1, .inputs = inputs, .outputs = outputs,
  };
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(std::isfinite(output_left[480]) && std::isfinite(output_right[480]));
  assert(std::abs(output_left[480]) > 1e-5F);
  daw_audio_core_destroy(core);

  state.fill(0);
  write_u32(state, 0, 1); write_f32(state, 4, 1.0F); write_f32(state, 8, 1.0F); write_f32(state, 12, 20.0F);
  write_f32(state, 16, 0.5F); write_u32(state, 20, 1); write_f32(state, 24, 5.0F); write_f32(state, 28, 0.3F);
  write_f32(state, 32, 0.5F); write_f32(state, 36, 1.0F); write_f32(state, 40, 0.65F); write_f32(state, 44, 0.75F);
  write_f32(state, 48, 0.8F); write_f32(state, 52, 20.0F); write_f32(state, 56, 20000.0F);
  write_f32(state, 60, 20.0F); write_f32(state, 64, 20000.0F); write_f32(state, 68, 1.0F);
  daw_audio_processor_descriptor reverb = delay;
  reverb.instance_id = 14; reverb.kind = DAW_AUDIO_PROCESSOR_KIND_REVERB; reverb.state_size = 72; reverb.tail_frames = 106560;
  core = create_core(512, 2, 1);
  prepare.graph_revision = 1; prepare.processors = &reverb;
  expect(daw_audio_core_prepare_graph(core, &prepare), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_publish(core, 1), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  for (uint32_t frame = 0; frame < block.frame_count; ++frame) {
    assert(std::isfinite(output_left[frame]) && std::isfinite(output_right[frame]));
  }
  left.fill(0.0F);
  right.fill(0.0F);
  float impulse_tail_peak = 0.0F;
  for (uint32_t block_index = 0; block_index < 8; ++block_index) {
    expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
    for (uint32_t frame = 0; frame < block.frame_count; ++frame) {
      assert(std::isfinite(output_left[frame]) && std::isfinite(output_right[frame]));
      impulse_tail_peak = std::max(
        impulse_tail_peak,
        std::max(std::abs(output_left[frame]), std::abs(output_right[frame])));
    }
  }
  assert(impulse_tail_peak > 1e-5F);

  left.fill(0.25F);
  right.fill(-0.125F);
  float sustained_peak = 0.0F;
  double sustained_energy = 0.0;
  constexpr uint32_t sustained_blocks = 288;
  for (uint32_t block_index = 0; block_index < sustained_blocks; ++block_index) {
    expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
    for (uint32_t frame = 0; frame < block.frame_count; ++frame) {
      assert(std::isfinite(output_left[frame]) && std::isfinite(output_right[frame]));
      sustained_peak = std::max(
        sustained_peak,
        std::max(std::abs(output_left[frame]), std::abs(output_right[frame])));
      sustained_energy += static_cast<double>(output_left[frame]) * output_left[frame]
        + static_cast<double>(output_right[frame]) * output_right[frame];
    }
  }
  const double sustained_rms = std::sqrt(sustained_energy / (2.0 * sustained_blocks * block.frame_count));
  assert(sustained_peak < 2.0F);
  assert(sustained_rms < 0.75);
  daw_audio_core_destroy(core);
}

void test_portable_spectral_processor_characterization_and_capacity() {
  const std::array<daw_audio_graph_node_descriptor, 3> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 1, .latency_frames = 0},
    {.id = 3, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 512},
  }};
  std::array<daw_audio_graph_edge_descriptor, 3> edges{{
    {.id = 1, .from_node_id = 1, .to_node_id = 3, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0},
    {.id = 2, .from_node_id = 2, .to_node_id = 3, .target_processor_id = 71, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 1, .pdc_delay_frames = 0},
  }};
  const auto write_u32 = [](std::array<uint8_t, 60> &bytes, uint32_t offset, uint32_t value) {
    bytes[offset] = static_cast<uint8_t>(value); bytes[offset + 1] = static_cast<uint8_t>(value >> 8u);
    bytes[offset + 2] = static_cast<uint8_t>(value >> 16u); bytes[offset + 3] = static_cast<uint8_t>(value >> 24u);
  };
  const auto write_f32 = [&write_u32](std::array<uint8_t, 60> &bytes, uint32_t offset, float value) {
    uint32_t bits = 0; std::memcpy(&bits, &value, sizeof(bits)); write_u32(bytes, offset, bits);
  };
  const auto spectral_state = [&](uint32_t mode) {
    std::array<uint8_t, 60> state{};
    write_u32(state, 0, 1); write_u32(state, 4, 512); write_u32(state, 8, 4); write_u32(state, 12, mode);
    write_f32(state, 16, mode == DAW_AUDIO_SPECTRAL_MODE_FREEZE ? 1.0F : 0.0F);
    write_f32(state, 20, -60.0F); write_f32(state, 24, 1.0F); write_f32(state, 28, 20.0F);
    write_f32(state, 32, 1.0F); write_f32(state, 36, 2.0F); write_f32(state, 40, 0.5F);
    write_f32(state, 44, 0.25F); write_f32(state, 48, 0.5F); write_f32(state, 52, 1.0F); write_f32(state, 56, 1.0F);
    return state;
  };
  const std::array<uint32_t, 11> targets{{15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25}};
  for (uint32_t mode = DAW_AUDIO_SPECTRAL_MODE_FREEZE; mode <= DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE; ++mode) {
    daw_audio_core_handle core = create_core(1024, 2, 1);
    std::array<uint8_t, 60> state = spectral_state(mode);
    daw_audio_processor_descriptor processor{
      .node_id = 3, .instance_id = 71, .kind = DAW_AUDIO_PROCESSOR_KIND_SPECTRAL, .state_version = 1, .state_size = 60,
      .bypassed = 0, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .latency_frames = 512, .tail_frames = 0, .parameter_count = static_cast<uint32_t>(targets.size()), .parameter_targets = targets.data(), .state = state.data(),
    };
    daw_audio_graph_prepare_request request{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 1, .node_count = 3, .edge_count = 2,
      .processor_count = 1, .nodes = nodes.data(), .edges = edges.data(), .processors = &processor,
    };
    expect(daw_audio_core_prepare_graph(core, &request), DAW_AUDIO_CORE_OK);
    expect(daw_audio_core_publish(core, 1), DAW_AUDIO_CORE_OK);
    std::array<float, 1024> side_left{}; std::array<float, 1024> side_right{};
    std::array<float, 1024> program_left{}; std::array<float, 1024> program_right{};
    program_left[128] = 1.0F; program_right[128] = -0.5F; side_left.fill(0.25F); side_right.fill(0.25F);
    const float *inputs[]{program_left.data(), program_right.data(), side_left.data(), side_right.data()};
    std::array<float, 1024> output_left{}; std::array<float, 1024> output_right{}; float *outputs[]{output_left.data(), output_right.data()};
    std::array<float, 1024 * 11> values{};
    const std::array<float, 11> parameter_values{{0.0F, -60.0F, 1.0F, 20.0F, 1.0F, 2.0F, 0.5F, 0.25F, 0.5F, 1.0F, 1.0F}};
    for (uint32_t parameter = 0; parameter < targets.size(); ++parameter) {
      for (uint32_t frame = 0; frame < 1024; ++frame) values[parameter * 1024 + frame] = parameter_values[parameter];
    }
    const daw_audio_processor_parameter_block parameters{
      .processor_instance_id = 71, .frame_count = 1024, .parameter_count = static_cast<uint32_t>(targets.size()),
      .parameter_targets = targets.data(), .values = values.data(),
    };
    const daw_audio_core_process_block block{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 1024, .channel_count = 2, .input_bus_count = 2,
      .inputs = inputs, .outputs = outputs, .graph_revision = 1, .parameter_block_count = 1, .parameter_blocks = &parameters,
    };
    expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
    for (uint32_t frame = 0; frame < output_left.size(); ++frame) assert(std::isfinite(output_left[frame]) && std::isfinite(output_right[frame]));
    float wet_peak = 0.0F;
    for (uint32_t frame = 512; frame < output_left.size(); ++frame) wet_peak = std::fmax(wet_peak, std::abs(output_left[frame]));
    assert(wet_peak > 1e-5F);
    daw_audio_core_destroy(core);
  }
  {
    daw_audio_core_handle lifecycle_core = create_core(1024, 2, 1);
    std::array<daw_audio_graph_node_descriptor, 3> lifecycle_nodes = nodes;
    std::array<daw_audio_graph_edge_descriptor, 2> lifecycle_edges{{edges[0], edges[1]}};
    lifecycle_edges[1].target_processor_id = 71;
    const std::array<uint32_t, 11> lifecycle_targets{{15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25}};
    std::array<uint8_t, 60> lifecycle_state{};
    const auto write_lifecycle_state = [&](uint32_t mode, uint32_t enabled, uint32_t fft_size) {
      lifecycle_state.fill(0);
      write_u32(lifecycle_state, 0, enabled);
      write_u32(lifecycle_state, 4, fft_size);
      write_u32(lifecycle_state, 8, 4);
      write_u32(lifecycle_state, 12, mode);
      write_f32(lifecycle_state, 16, 1.0F);
      write_f32(lifecycle_state, 20, -60.0F);
      write_f32(lifecycle_state, 24, 1.0F);
      write_f32(lifecycle_state, 28, 20.0F);
      write_f32(lifecycle_state, 32, 1.0F);
      write_f32(lifecycle_state, 36, 2.0F);
      write_f32(lifecycle_state, 40, 0.5F);
      write_f32(lifecycle_state, 44, 0.25F);
      write_f32(lifecycle_state, 48, 0.5F);
      write_f32(lifecycle_state, 52, 1.0F);
      write_f32(lifecycle_state, 56, 1.0F);
    };
    const auto publish_lifecycle = [&](uint32_t revision, uint32_t mode, uint32_t enabled, uint32_t fft_size) {
      lifecycle_nodes[2].latency_frames = fft_size;
      write_lifecycle_state(mode, enabled, fft_size);
      const daw_audio_processor_descriptor processor{
        .node_id = 3, .instance_id = 71, .kind = DAW_AUDIO_PROCESSOR_KIND_SPECTRAL, .state_version = 1,
        .state_size = 60, .bypassed = 0, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
        .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .latency_frames = fft_size, .tail_frames = 0,
        .parameter_count = static_cast<uint32_t>(lifecycle_targets.size()), .parameter_targets = lifecycle_targets.data(),
        .state = lifecycle_state.data(),
      };
      const daw_audio_graph_prepare_request request{
        .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = revision,
        .node_count = static_cast<uint32_t>(lifecycle_nodes.size()), .edge_count = static_cast<uint32_t>(lifecycle_edges.size()),
        .processor_count = 1, .nodes = lifecycle_nodes.data(), .edges = lifecycle_edges.data(), .processors = &processor,
      };
      expect(daw_audio_core_prepare_graph(lifecycle_core, &request), DAW_AUDIO_CORE_OK);
      expect(daw_audio_core_publish(lifecycle_core, revision), DAW_AUDIO_CORE_OK);
    };
    std::array<float, 1024> program_left{};
    std::array<float, 1024> program_right{};
    std::array<float, 1024> side_left{};
    std::array<float, 1024> side_right{};
    std::array<float, 1024> output_left{};
    std::array<float, 1024> output_right{};
    const auto render_lifecycle = [&](uint32_t revision) {
      output_left.fill(0.0F);
      output_right.fill(0.0F);
      const float *inputs[]{program_left.data(), program_right.data(), side_left.data(), side_right.data()};
      float *outputs[]{output_left.data(), output_right.data()};
      const daw_audio_core_process_block block{
        .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 1024, .channel_count = 2,
        .input_bus_count = 2, .inputs = inputs, .outputs = outputs, .graph_revision = revision,
      };
      expect(daw_audio_core_process(lifecycle_core, &block), DAW_AUDIO_CORE_OK);
    };
    const auto peak = [](const std::array<float, 1024> &values, uint32_t start) {
      float result = 0.0F;
      for (uint32_t frame = start; frame < values.size(); ++frame) result = std::fmax(result, std::abs(values[frame]));
      return result;
    };
    program_left[128] = 1.0F;
    program_right[128] = -0.5F;
    publish_lifecycle(1, DAW_AUDIO_SPECTRAL_MODE_FREEZE, 1, 512);
    render_lifecycle(1);
    assert(peak(output_left, 512) > 1e-5F);
    program_left.fill(0.0F);
    program_right.fill(0.0F);
    publish_lifecycle(2, DAW_AUDIO_SPECTRAL_MODE_GATE, 1, 512);
    render_lifecycle(2);
    publish_lifecycle(3, DAW_AUDIO_SPECTRAL_MODE_FREEZE, 1, 512);
    render_lifecycle(3);
    assert(peak(output_left, 512) > 1e-5F);
    publish_lifecycle(4, DAW_AUDIO_SPECTRAL_MODE_FREEZE, 0, 512);
    render_lifecycle(4);
    publish_lifecycle(5, DAW_AUDIO_SPECTRAL_MODE_FREEZE, 1, 512);
    render_lifecycle(5);
    assert(peak(output_left, 512) == 0.0F);
    publish_lifecycle(6, DAW_AUDIO_SPECTRAL_MODE_FREEZE, 1, 1024);
    render_lifecycle(6);
    assert(peak(output_left, 1024) == 0.0F);
    daw_audio_core_destroy(lifecycle_core);
  }
  daw_audio_core_handle capacity_core = create_core(64, 2, 1);
  std::array<daw_audio_graph_node_descriptor, 2> capacity_nodes{{nodes[0], nodes[2]}};
  capacity_nodes[1].latency_frames = 512 * 9;
  const std::array<daw_audio_graph_edge_descriptor, 1> capacity_edges{{
    {.id = 1, .from_node_id = 1, .to_node_id = 3, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0},
  }};
  std::array<std::array<uint8_t, 60>, 9> states{};
  std::array<daw_audio_processor_descriptor, 9> processors{};
  for (uint32_t index = 0; index < processors.size(); ++index) {
    states[index] = spectral_state(DAW_AUDIO_SPECTRAL_MODE_FREEZE);
    processors[index] = {.node_id = 3, .instance_id = index + 1, .kind = DAW_AUDIO_PROCESSOR_KIND_SPECTRAL,
      .state_version = 1, .state_size = 60, .bypassed = 0, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .latency_frames = 512, .tail_frames = 0,
      .parameter_count = 0, .parameter_targets = nullptr, .state = states[index].data()};
  }
  const daw_audio_graph_prepare_request capacity_request{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 1, .node_count = 2, .edge_count = 1,
    .processor_count = static_cast<uint32_t>(processors.size()), .nodes = capacity_nodes.data(), .edges = capacity_edges.data(), .processors = processors.data(),
  };
  expect(daw_audio_core_prepare_graph(capacity_core, &capacity_request), DAW_AUDIO_CORE_CAPACITY_EXCEEDED);
  daw_audio_core_destroy(capacity_core);
}

void test_abi_and_revision_rejection() {
  assert(daw_audio_core_get_abi_version() == DAW_AUDIO_CORE_ABI_VERSION);
  daw_audio_core_handle core = 0;
  const daw_audio_core_config unsupported{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION + 1,
    .max_frames_per_block = 64,
    .max_channels = 2,
    .max_assets = 1,
    .sample_rate_hz = 48000,
  };
  expect(daw_audio_core_create(&unsupported, &core), DAW_AUDIO_CORE_UNSUPPORTED_VERSION);

  core = create_core(64, 2, 1);
  expect(daw_audio_core_publish(core, 0), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  publish(core, 7);
  expect(daw_audio_core_retire(core, 6), DAW_AUDIO_CORE_STALE_REVISION);
  expect(daw_audio_core_retire(core, 7), DAW_AUDIO_CORE_OK);
  daw_audio_core_destroy(core);
}

void test_variable_blocks_and_capacity() {
  daw_audio_core_handle core = create_core(64, 2, 1);
  publish(core, 1);
  std::array<float, 64> input{};
  std::array<float, 64> output{};
  input[0] = 0.25F;
  input[15] = -0.5F;
  const float *inputs[] = {input.data()};
  float *outputs[] = {output.data()};
  for (const uint32_t frames : {1u, 16u, 64u}) {
    const daw_audio_core_process_block block{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
      .frame_count = frames,
      .channel_count = 1,
      .input_bus_count = 1,
      .inputs = inputs,
      .outputs = outputs,
    };
    expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  }
  assert(output[0] == input[0]);
  assert(output[15] == input[15]);
  const daw_audio_core_process_block too_large{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .frame_count = 65,
    .channel_count = 1,
    .input_bus_count = 1,
    .inputs = inputs,
    .outputs = outputs,
  };
  expect(daw_audio_core_process(core, &too_large), DAW_AUDIO_CORE_CAPACITY_EXCEEDED);
  daw_audio_core_destroy(core);
}

void test_stale_asset_handles() {
  daw_audio_core_handle core = create_core(64, 2, 1);
  std::array<float, 16> samples{};
  const float *planes[]{samples.data()};
  const daw_audio_asset_descriptor descriptor{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .revision = 3,
    .byte_length = 64,
    .content_hash_prefix = 0,
    .frame_count = 16,
    .sample_rate_hz = 48000,
    .channel_count = 1,
    .planes = planes,
  };
  daw_audio_asset_handle asset = 0;
  expect(daw_audio_core_create_asset(core, &descriptor, &asset), DAW_AUDIO_CORE_OK);
  daw_audio_asset_handle overflow = 0;
  expect(daw_audio_core_create_asset(core, &descriptor, &overflow), DAW_AUDIO_CORE_CAPACITY_EXCEEDED);
  expect(daw_audio_core_release_asset(core, asset), DAW_AUDIO_CORE_OK);
  uint32_t revision = 0;
  expect(daw_audio_core_get_asset_revision(core, asset, &revision), DAW_AUDIO_CORE_INVALID_HANDLE);
  daw_audio_core_destroy(core);
}

void test_sample_source_scheduling() {
  daw_audio_core_handle core = create_core(8, 2, 2);
  publish(core, 1);
  const std::array<float, 6> left{1.0F, 2.0F, NAN, 4.0F, 5.0F, 6.0F};
  const std::array<float, 6> right{-1.0F, -2.0F, -3.0F, -4.0F, -5.0F, -6.0F};
  const float *planes[]{left.data(), right.data()};
  const daw_audio_asset_descriptor descriptor{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .revision = 1,
    .byte_length = 48,
    .content_hash_prefix = 0,
    .frame_count = 6,
    .sample_rate_hz = 48000,
    .channel_count = 2,
    .planes = planes,
  };
  daw_audio_asset_handle asset = 0;
  expect(daw_audio_core_create_asset(core, &descriptor, &asset), DAW_AUDIO_CORE_OK);
  const daw_audio_transport_state transport{.epoch = 1, .running = 1, .frame = 0};
  expect(daw_audio_core_set_transport(core, &transport), DAW_AUDIO_CORE_OK);
  const daw_audio_sample_source_event event{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .epoch = 1,
    .sequence = 1,
    .asset = asset,
    .start_frame = 2,
    .stop_frame = 6,
    .source_offset_frame = 1,
    .source_frame_count = 4,
    .gain = 1.0F,
    .fade_in_start_frame = 2,
    .fade_in_end_frame = 4,
    .fade_out_start_frame = 4,
    .fade_out_end_frame = 6,
  };
  expect(daw_audio_core_schedule_sample_source(core, &event), DAW_AUDIO_CORE_OK);
  std::array<float, 8> left_output{};
  std::array<float, 8> right_output{};
  float *outputs[]{left_output.data(), right_output.data()};
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .frame_count = 5,
    .channel_count = 2,
    .input_bus_count = 0,
    .inputs = nullptr,
    .outputs = outputs,
  };
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(left_output[0] == 0.0F && left_output[1] == 0.0F);
  assert(std::abs(left_output[2]) <= 1e-6F);
  assert(left_output[3] == 0.0F);
  assert(std::abs(left_output[4] - 4.0F) <= 1e-6F);
  assert(std::abs(right_output[4] + 4.0F) <= 1e-6F);
  expect(daw_audio_core_release_asset(core, asset), DAW_AUDIO_CORE_ASSET_IN_USE);

  const daw_audio_transport_state seek{.epoch = 2, .running = 1, .frame = 0};
  expect(daw_audio_core_set_transport(core, &seek), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_schedule_sample_source(core, &event), DAW_AUDIO_CORE_STALE_REVISION);
  std::array<float, 8> seek_output{};
  float *mono_output[]{seek_output.data()};
  const daw_audio_core_process_block mono_block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .frame_count = 3,
    .channel_count = 1,
    .input_bus_count = 0,
    .inputs = nullptr,
    .outputs = mono_output,
  };
  expect(daw_audio_core_process(core, &mono_block), DAW_AUDIO_CORE_OK);
  assert(seek_output[0] == 0.0F && seek_output[1] == 0.0F && seek_output[2] == 0.0F);

  daw_audio_sample_source_event epoch_two = event;
  epoch_two.epoch = 2;
  epoch_two.sequence = 1;
  epoch_two.start_frame = 3;
  epoch_two.stop_frame = 5;
  epoch_two.fade_in_start_frame = 3;
  epoch_two.fade_in_end_frame = 3;
  epoch_two.fade_out_start_frame = 5;
  epoch_two.fade_out_end_frame = 5;
  expect(daw_audio_core_schedule_sample_source(core, &epoch_two), DAW_AUDIO_CORE_OK);
  daw_audio_core_process_block replay_block = mono_block;
  replay_block.frame_count = 2;
  expect(daw_audio_core_process(core, &replay_block), DAW_AUDIO_CORE_OK);
  assert(std::abs(seek_output[0] - 2.0F) <= 1e-6F);
  assert(std::abs(seek_output[1]) <= 1e-6F);
  daw_audio_core_process_block end_block = mono_block;
  end_block.frame_count = 1;
  expect(daw_audio_core_process(core, &end_block), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_release_asset(core, asset), DAW_AUDIO_CORE_OK);
  daw_audio_core_destroy(core);
}

void test_sample_source_partition_invariance_and_mono() {
  daw_audio_core_handle core = create_core(8, 2, 1);
  publish(core, 1);
  const std::array<float, 4> mono{0.25F, 0.5F, 0.75F, 1.0F};
  const float *planes[]{mono.data()};
  const daw_audio_asset_descriptor descriptor{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .revision = 1, .byte_length = 16,
    .content_hash_prefix = 0, .frame_count = 4, .sample_rate_hz = 48000, .channel_count = 1, .planes = planes,
  };
  daw_audio_asset_handle asset = 0;
  expect(daw_audio_core_create_asset(core, &descriptor, &asset), DAW_AUDIO_CORE_OK);
  const daw_audio_transport_state transport{.epoch = 1, .running = 1, .frame = 0};
  expect(daw_audio_core_set_transport(core, &transport), DAW_AUDIO_CORE_OK);
  const daw_audio_sample_source_event event{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .epoch = 1, .sequence = 1, .asset = asset,
    .start_frame = 0, .stop_frame = 4, .source_offset_frame = 0, .source_frame_count = 4, .gain = 1.0F,
    .fade_in_start_frame = 0, .fade_in_end_frame = 0, .fade_out_start_frame = 4, .fade_out_end_frame = 4,
  };
  expect(daw_audio_core_schedule_sample_source(core, &event), DAW_AUDIO_CORE_OK);
  std::array<float, 4> left{};
  std::array<float, 4> right{};
  float *outputs[]{left.data(), right.data()};
  const daw_audio_core_process_block first{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 1, .channel_count = 2, .input_bus_count = 0, .inputs = nullptr, .outputs = outputs,
  };
  expect(daw_audio_core_process(core, &first), DAW_AUDIO_CORE_OK);
  float *remainder_outputs[]{left.data() + 1, right.data() + 1};
  daw_audio_core_process_block remainder = first;
  remainder.frame_count = 3;
  remainder.outputs = remainder_outputs;
  expect(daw_audio_core_process(core, &remainder), DAW_AUDIO_CORE_OK);
  for (uint32_t frame = 0; frame < 4; ++frame) {
    assert(std::abs(left[frame] - mono[frame]) <= 1e-6F);
    assert(std::abs(right[frame] - mono[frame]) <= 1e-6F);
  }
  daw_audio_core_destroy(core);
}

void test_sample_source_fractional_rate_matrix_and_overlaps() {
  const std::array<std::pair<uint32_t, uint32_t>, 4> rates{{
    {44'100, 48'000}, {48'000, 44'100}, {48'000, 96'000}, {96'000, 48'000},
  }};
  for (const auto [asset_rate, core_rate] : rates) {
    for (const uint32_t channel_count : {1U, 2U}) {
      constexpr uint32_t output_frames = 37;
      constexpr uint32_t asset_frames = 96;
      std::vector<std::vector<float>> planes(channel_count, std::vector<float>(asset_frames));
      for (uint32_t channel = 0; channel < channel_count; ++channel) {
        for (uint32_t frame = 0; frame < asset_frames; ++frame) {
          planes[channel][frame] = static_cast<float>(channel + 1) * (0.1F + static_cast<float>(frame) * 0.01F);
        }
      }
      std::vector<const float *> plane_pointers;
      for (const auto &plane : planes) plane_pointers.push_back(plane.data());
      const daw_audio_asset_descriptor descriptor{
        .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .revision = 1,
        .byte_length = asset_frames * channel_count * sizeof(float), .content_hash_prefix = 0,
        .frame_count = asset_frames, .sample_rate_hz = asset_rate, .channel_count = channel_count,
        .planes = plane_pointers.data(),
      };
      const auto render = [&](const std::array<uint32_t, 6> &blocks, uint32_t block_count) {
        const daw_audio_core_config config{
          .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .max_frames_per_block = output_frames,
          .max_channels = 2, .max_assets = 1, .sample_rate_hz = core_rate,
        };
        daw_audio_core_handle core = 0;
        expect(daw_audio_core_create(&config, &core), DAW_AUDIO_CORE_OK);
        publish(core, 1);
        daw_audio_asset_handle asset = 0;
        expect(daw_audio_core_create_asset(core, &descriptor, &asset), DAW_AUDIO_CORE_OK);
        const daw_audio_transport_state transport{.epoch = 1, .running = 1, .frame = 0};
        expect(daw_audio_core_set_transport(core, &transport), DAW_AUDIO_CORE_OK);
        const std::array<daw_audio_sample_source_event, 2> events{{
          {.abi_version = DAW_AUDIO_CORE_ABI_VERSION, .epoch = 1, .sequence = 1, .asset = asset,
            .start_frame = 0, .stop_frame = output_frames, .source_offset_frame = 1, .source_frame_count = 30,
            .gain = 1.0F, .fade_in_start_frame = 0, .fade_in_end_frame = 2,
            .fade_out_start_frame = output_frames - 2, .fade_out_end_frame = output_frames,
            .source_offset_fraction = 0.25F},
          {.abi_version = DAW_AUDIO_CORE_ABI_VERSION, .epoch = 1, .sequence = 2, .asset = asset,
            .start_frame = 4, .stop_frame = output_frames - 3, .source_offset_frame = 10, .source_frame_count = 24,
            .gain = 0.5F, .fade_in_start_frame = 4, .fade_in_end_frame = 5,
            .fade_out_start_frame = output_frames - 5, .fade_out_end_frame = output_frames - 3,
            .source_offset_fraction = 0.5F},
        }};
        for (const auto &event : events) expect(daw_audio_core_schedule_sample_source(core, &event), DAW_AUDIO_CORE_OK);
        std::array<float, output_frames> left{};
        std::array<float, output_frames> right{};
        uint32_t frame = 0;
        for (uint32_t block = 0; block < block_count; ++block) {
          const uint32_t count = std::min(blocks[block], output_frames - frame);
          float *outputs[]{left.data() + frame, right.data() + frame};
          const daw_audio_core_process_block process{
            .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = count, .channel_count = 2,
            .input_bus_count = 0, .inputs = nullptr, .outputs = outputs,
          };
          expect(daw_audio_core_process(core, &process), DAW_AUDIO_CORE_OK);
          frame += count;
        }
        assert(frame == output_frames);
        daw_audio_core_destroy(core);
        return std::pair{left, right};
      };
      const auto whole = render({output_frames, 0, 0, 0, 0, 0}, 1);
      const auto partitioned = render({3, 7, 1, 11, 5, 10}, 6);
      for (uint32_t frame = 0; frame < output_frames; ++frame) {
        assert(std::isfinite(whole.first[frame]) && std::isfinite(whole.second[frame]));
        assert(std::abs(whole.first[frame] - partitioned.first[frame]) <= 1e-6F);
        assert(std::abs(whole.second[frame] - partitioned.second[frame]) <= 1e-6F);
      }
      const double expected_position = 1.25 + static_cast<double>(asset_rate) / static_cast<double>(core_rate);
      const uint32_t expected_frame = static_cast<uint32_t>(std::floor(expected_position));
      const float expected_fraction = static_cast<float>(expected_position - expected_frame);
      const float expected_frame_one = (planes[0][expected_frame]
        + (planes[0][expected_frame + 1] - planes[0][expected_frame]) * expected_fraction) * 0.5F;
      assert(std::abs(whole.first[1] - expected_frame_one) <= 1e-6F);
      if (channel_count == 2) assert(std::abs(whole.second[1] - expected_frame_one * 2.0F) <= 1e-6F);
    }
  }
}

void test_sample_source_targets_published_graph_source() {
  daw_audio_core_handle core = create_core(4, 2, 1);
  const std::array<daw_audio_graph_node_descriptor, 3> nodes{{
    {.id = 11, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
    {.id = 12, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 1, .latency_frames = 0},
    {.id = 13, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const std::array<daw_audio_graph_edge_descriptor, 1> edges{{
    {.id = 1, .from_node_id = 11, .to_node_id = 13, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0},
  }};
  prepare_graph(core, 1, nodes.data(), nodes.size(), edges.data(), edges.size());
  const std::array<float, 1> samples{0.25F};
  const float *planes[]{samples.data()};
  const daw_audio_asset_descriptor descriptor{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .revision = 1, .byte_length = sizeof(float),
    .content_hash_prefix = 0, .frame_count = 1, .sample_rate_hz = 48000, .channel_count = 1, .planes = planes,
  };
  daw_audio_asset_handle asset = 0;
  expect(daw_audio_core_create_asset(core, &descriptor, &asset), DAW_AUDIO_CORE_OK);
  const daw_audio_transport_state transport{.epoch = 1, .running = 1, .frame = 0};
  expect(daw_audio_core_set_transport(core, &transport), DAW_AUDIO_CORE_OK);
  const daw_audio_sample_source_event wrong_target{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .epoch = 1, .sequence = 1, .source_node_id = 13, .asset = asset,
    .start_frame = 0, .stop_frame = 1, .source_offset_frame = 0, .source_frame_count = 1, .gain = 1.0F,
    .fade_in_start_frame = 0, .fade_in_end_frame = 0, .fade_out_start_frame = 1, .fade_out_end_frame = 1,
  };
  expect(daw_audio_core_schedule_sample_source(core, &wrong_target), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  daw_audio_sample_source_event event = wrong_target;
  event.source_node_id = 11;
  expect(daw_audio_core_schedule_sample_source(core, &event), DAW_AUDIO_CORE_OK);
  std::array<float, 1> output_left{};
  std::array<float, 1> output_right{};
  float *outputs[]{output_left.data(), output_right.data()};
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 1, .channel_count = 2,
    .input_bus_count = 0, .inputs = nullptr, .outputs = outputs, .graph_revision = 1,
  };
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(std::abs(output_left[0] - 0.25F) <= 1e-6F);
  assert(std::abs(output_right[0] - 0.25F) <= 1e-6F);
  daw_audio_core_destroy(core);
}

void test_process_allocates_nothing() {
  daw_audio_core_handle core = create_core(64, 2, 1);
  publish(core, 1);
  std::array<float, 64> input{};
  std::array<float, 64> output{};
  const float *inputs[] = {input.data()};
  float *outputs[] = {output.data()};
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .frame_count = 64,
    .channel_count = 1,
    .input_bus_count = 1,
    .inputs = inputs,
    .outputs = outputs,
  };
  allocation_count = 0;
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(allocation_count == 0);
  daw_audio_core_destroy(core);
}

void test_prepared_graph_ranges_are_partition_invariant_and_allocation_free() {
  const std::array<daw_audio_graph_node_descriptor, 3> nodes{{
    {.id = 42, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .latency_frames = 0},
    {.id = 99, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
    {.id = 7, .kind = DAW_AUDIO_GRAPH_NODE_MIXER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .latency_frames = 0},
  }};
  const std::array<daw_audio_graph_edge_descriptor, 2> edges{{
    {.id = 2, .from_node_id = 7, .to_node_id = 42, .gain = 0.5F,
      .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0},
    {.id = 1, .from_node_id = 99, .to_node_id = 7, .gain = 1.0F,
      .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0},
  }};
  const std::array<float, 8> asset_samples{0.5F, 1.0F, 1.5F, 2.0F, 2.5F, 3.0F, 3.5F, 4.0F};
  const float *asset_planes[]{asset_samples.data()};
  const daw_audio_asset_descriptor asset_descriptor{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .revision = 1,
    .byte_length = asset_samples.size() * sizeof(float), .frame_count = asset_samples.size(),
    .sample_rate_hz = 48000, .channel_count = 1, .planes = asset_planes,
  };
  const auto create_render_core = [&]() {
    const daw_audio_core_handle core = create_core(8, 2, 1);
    prepare_graph(core, 1, nodes.data(), nodes.size(), edges.data(), edges.size());
    daw_audio_asset_handle asset = 0;
    expect(daw_audio_core_create_asset(core, &asset_descriptor, &asset), DAW_AUDIO_CORE_OK);
    const daw_audio_transport_state transport{.epoch = 1, .running = 1, .frame = 0};
    expect(daw_audio_core_set_transport(core, &transport), DAW_AUDIO_CORE_OK);
    const daw_audio_sample_source_event event{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .epoch = 1, .sequence = 1, .source_node_id = 99,
      .asset = asset, .start_frame = 0, .stop_frame = 8, .source_offset_frame = 0,
      .source_frame_count = 8, .gain = 1.0F, .fade_in_start_frame = 0, .fade_in_end_frame = 0,
      .fade_out_start_frame = 8, .fade_out_end_frame = 8,
    };
    expect(daw_audio_core_schedule_sample_source(core, &event), DAW_AUDIO_CORE_OK);
    return core;
  };
  const std::array<float, 8> input_left{1.0F, 0.5F, 0.25F, 0.0F, -0.25F, -0.5F, -0.75F, -1.0F};
  const std::array<float, 8> input_right{-1.0F, -0.5F, -0.25F, 0.0F, 0.25F, 0.5F, 0.75F, 1.0F};
  std::array<float, 8> whole_left{};
  std::array<float, 8> whole_right{};
  std::array<float, 8> partitioned_left{};
  std::array<float, 8> partitioned_right{};
  daw_audio_core_handle whole = create_render_core();
  const float *whole_inputs[]{input_left.data(), input_right.data()};
  float *whole_outputs[]{whole_left.data(), whole_right.data()};
  const daw_audio_core_process_block whole_block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 8, .channel_count = 2,
    .input_bus_count = 1, .inputs = whole_inputs, .outputs = whole_outputs, .graph_revision = 1,
  };
  allocation_count = 0;
  expect(daw_audio_core_process(whole, &whole_block), DAW_AUDIO_CORE_OK);
  assert(allocation_count == 0);
  daw_audio_core_destroy(whole);

  daw_audio_core_handle partitioned = create_render_core();
  const float *first_inputs[]{input_left.data(), input_right.data()};
  float *first_outputs[]{partitioned_left.data(), partitioned_right.data()};
  daw_audio_core_process_block partitioned_block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 3, .channel_count = 2,
    .input_bus_count = 1, .inputs = first_inputs, .outputs = first_outputs, .graph_revision = 1,
  };
  allocation_count = 0;
  expect(daw_audio_core_process(partitioned, &partitioned_block), DAW_AUDIO_CORE_OK);
  const float *second_inputs[]{input_left.data() + 3, input_right.data() + 3};
  float *second_outputs[]{partitioned_left.data() + 3, partitioned_right.data() + 3};
  partitioned_block.frame_count = 5;
  partitioned_block.inputs = second_inputs;
  partitioned_block.outputs = second_outputs;
  expect(daw_audio_core_process(partitioned, &partitioned_block), DAW_AUDIO_CORE_OK);
  assert(allocation_count == 0);
  for (uint32_t frame = 0; frame < whole_left.size(); ++frame) {
    assert(std::abs(whole_left[frame] - partitioned_left[frame]) <= 1e-6F);
    assert(std::abs(whole_right[frame] - partitioned_right[frame]) <= 1e-6F);
  }
  daw_audio_core_destroy(partitioned);
}

constexpr daw_audio_utility_state utility_state(
  uint32_t enabled = 1,
  float gain_db = 0.0F,
  uint32_t polarity = DAW_AUDIO_UTILITY_POLARITY_NORMAL,
  uint32_t input_mode = DAW_AUDIO_UTILITY_INPUT_MODE_STEREO,
  float pan = 0.0F,
  float balance = 0.0F,
  float width = 1.0F,
  uint32_t matrix = DAW_AUDIO_UTILITY_MATRIX_STEREO,
  uint32_t swap = 0,
  uint32_t dc_block = 0) {
  return {
    .enabled = enabled,
    .gain_db = gain_db,
    .polarity = polarity,
    .input_mode = input_mode,
    .pan = pan,
    .balance = balance,
    .width = width,
    .matrix = matrix,
    .swap = swap,
    .dc_block = dc_block,
  };
}

void test_processor_control_slot_survives_graph_compaction() {
  daw_audio_core_handle core = create_core(4, 2, 1);
  const std::array<daw_audio_graph_node_descriptor, 2> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const std::array<daw_audio_graph_edge_descriptor, 1> edges{{
    {.id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F,
      .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0},
  }};
  const std::array<uint32_t, 1> parameter_targets{DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_PAN};
  const auto first_state = utility_state();
  const auto second_state = utility_state();
  std::array<uint8_t, sizeof(daw_audio_utility_state)> first_state_bytes{};
  std::array<uint8_t, sizeof(daw_audio_utility_state)> second_state_bytes{};
  std::memcpy(first_state_bytes.data(), &first_state, sizeof(first_state));
  std::memcpy(second_state_bytes.data(), &second_state, sizeof(second_state));
  const std::array<daw_audio_processor_descriptor, 2> initial_processors{{
    {.node_id = 2, .instance_id = 41, .kind = DAW_AUDIO_PROCESSOR_KIND_UTILITY,
      .state_version = 1, .state_size = static_cast<uint32_t>(first_state_bytes.size()), .bypassed = 0,
      .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .latency_frames = 0, .tail_frames = 0, .parameter_count = 1,
      .parameter_targets = parameter_targets.data(), .state = first_state_bytes.data()},
    {.node_id = 2, .instance_id = 42, .kind = DAW_AUDIO_PROCESSOR_KIND_UTILITY,
      .state_version = 1, .state_size = static_cast<uint32_t>(second_state_bytes.size()), .bypassed = 0,
      .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .latency_frames = 0, .tail_frames = 0, .parameter_count = 1,
      .parameter_targets = parameter_targets.data(), .state = second_state_bytes.data()},
  }};
  const daw_audio_graph_prepare_request initial_request{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 1,
    .node_count = static_cast<uint32_t>(nodes.size()), .edge_count = static_cast<uint32_t>(edges.size()),
    .processor_count = static_cast<uint32_t>(initial_processors.size()), .nodes = nodes.data(),
    .edges = edges.data(), .processors = initial_processors.data(),
  };
  expect(daw_audio_core_prepare_graph(core, &initial_request), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_publish(core, 1), DAW_AUDIO_CORE_OK);

  const daw_audio_processor_descriptor retained_processor{
    .node_id = 2, .instance_id = 42, .kind = DAW_AUDIO_PROCESSOR_KIND_UTILITY,
    .state_version = 1, .state_size = static_cast<uint32_t>(second_state_bytes.size()), .bypassed = 0,
    .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .latency_frames = 0, .tail_frames = 0, .parameter_count = 1,
    .parameter_targets = parameter_targets.data(), .state = second_state_bytes.data(),
  };
  const daw_audio_graph_prepare_request compacted_request{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 2,
    .node_count = static_cast<uint32_t>(nodes.size()), .edge_count = static_cast<uint32_t>(edges.size()),
    .processor_count = 1, .nodes = nodes.data(), .edges = edges.data(),
    .processors = &retained_processor,
  };
  expect(daw_audio_core_prepare_graph(core, &compacted_request), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_publish(core, 2), DAW_AUDIO_CORE_OK);

  const std::array<float, 4> input{1.0F, 1.0F, 1.0F, 1.0F};
  const float *inputs[]{input.data(), input.data()};
  std::array<float, 4> output_left{};
  std::array<float, 4> output_right{};
  float *outputs[]{output_left.data(), output_right.data()};
  const daw_audio_processor_event event{
    .processor_instance_id = 42, .parameter_target = DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_PAN,
    .frame_offset = 2, .value = 1.0F,
  };
  const daw_audio_core_process_block event_block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 4, .channel_count = 2,
    .input_bus_count = 1, .inputs = inputs, .outputs = outputs, .graph_revision = 2,
    .event_count = 1, .events = &event,
  };
  expect(daw_audio_core_process(core, &event_block), DAW_AUDIO_CORE_OK);
  for (uint32_t frame = 0; frame < 2; ++frame) {
    assert(std::abs(output_left[frame] - 1.0F) <= 1e-6F);
    assert(std::abs(output_right[frame] - 1.0F) <= 1e-6F);
  }
  for (uint32_t frame = 2; frame < 4; ++frame) {
    assert(std::abs(output_left[frame]) <= 1e-6F);
    assert(std::abs(output_right[frame] - 1.41421356F) <= 1e-6F);
  }

  output_left.fill(0.0F);
  output_right.fill(0.0F);
  const daw_audio_core_process_block persistent_block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 4, .channel_count = 2,
    .input_bus_count = 1, .inputs = inputs, .outputs = outputs, .graph_revision = 2,
  };
  expect(daw_audio_core_process(core, &persistent_block), DAW_AUDIO_CORE_OK);
  for (uint32_t frame = 0; frame < 4; ++frame) {
    assert(std::abs(output_left[frame]) <= 1e-6F);
    assert(std::abs(output_right[frame] - 1.41421356F) <= 1e-6F);
  }
  daw_audio_core_destroy(core);
}

void test_utility_and_summing_graph() {
  daw_audio_core_handle core = create_core(64, 2, 1);
  publish(core, 1);
  const daw_audio_utility_state state = utility_state(
    1,
    0.0F,
    DAW_AUDIO_UTILITY_POLARITY_INVERT,
    DAW_AUDIO_UTILITY_INPUT_MODE_MONO_SUM,
    0.0F,
    0.0F,
    1.0F,
    DAW_AUDIO_UTILITY_MATRIX_STEREO,
    1);
  expect(daw_audio_core_configure_utility(core, &state), DAW_AUDIO_CORE_OK);
  const std::array<float, 1> first_left{1.0F};
  const std::array<float, 1> first_right{-0.5F};
  const std::array<float, 1> second_left{0.5F};
  const std::array<float, 1> second_right{0.5F};
  const float *inputs[] = {first_left.data(), first_right.data(), second_left.data(), second_right.data()};
  std::array<float, 1> left_output{};
  std::array<float, 1> right_output{};
  float *outputs[] = {left_output.data(), right_output.data()};
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .frame_count = 1,
    .channel_count = 2,
    .input_bus_count = 2,
    .inputs = inputs,
    .outputs = outputs,
  };
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(std::abs(left_output[0] + 0.75F) <= 1e-6F);
  assert(std::abs(right_output[0] + 0.75F) <= 1e-6F);
  daw_audio_core_destroy(core);
}

void test_utility_dsp_state_and_bypass() {
  daw_audio_core_handle core = create_core(480, 2, 1);
  publish(core, 1);
  const daw_audio_utility_state configured = utility_state(
    1,
    6.0F,
    DAW_AUDIO_UTILITY_POLARITY_NORMAL,
    DAW_AUDIO_UTILITY_INPUT_MODE_STEREO,
    1.0F,
    1.0F,
    0.0F,
    DAW_AUDIO_UTILITY_MATRIX_STEREO);
  expect(daw_audio_core_configure_utility(core, &configured), DAW_AUDIO_CORE_OK);
  std::array<float, 480> left_input{};
  std::array<float, 480> right_input{};
  left_input.fill(1.0F);
  right_input.fill(-0.5F);
  const float *inputs[] = {left_input.data(), right_input.data()};
  std::array<float, 480> left_output{};
  std::array<float, 480> right_output{};
  float *outputs[] = {left_output.data(), right_output.data()};
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .frame_count = 480,
    .channel_count = 2,
    .input_bus_count = 1,
    .inputs = inputs,
    .outputs = outputs,
  };
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(std::abs(left_output[0]) <= 1e-6F);
  assert(std::abs(right_output[0] - std::pow(10.0F, 6.0F / 20.0F) * 0.35355339F) <= 1e-5F);

  const daw_audio_utility_state bypassed = utility_state(0);
  expect(daw_audio_core_configure_utility(core, &bypassed), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(std::abs(left_output.back() - 1.0F) <= 1e-6F);
  assert(std::abs(right_output.back() + 0.5F) <= 1e-6F);

  left_input[0] = NAN;
  right_input[0] = NAN;
  const daw_audio_utility_state active = utility_state();
  expect(daw_audio_core_configure_utility(core, &active), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(left_output[0] == 0.0F);
  assert(right_output[0] == 0.0F);
  daw_audio_core_destroy(core);
}

void test_utility_mid_side_and_dc_blocking() {
  daw_audio_core_handle core = create_core(480, 2, 1);
  publish(core, 1);
  std::array<float, 480> left_input{};
  std::array<float, 480> right_input{};
  for (uint32_t index = 0; index < left_input.size(); ++index) {
    left_input[index] = std::sin(static_cast<float>(index) * 0.17F);
    right_input[index] = std::cos(static_cast<float>(index) * 0.11F) * 0.6F;
  }
  const float *inputs[] = {left_input.data(), right_input.data()};
  std::array<float, 480> left_output{};
  std::array<float, 480> right_output{};
  float *outputs[] = {left_output.data(), right_output.data()};
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .frame_count = 480,
    .channel_count = 2,
    .input_bus_count = 1,
    .inputs = inputs,
    .outputs = outputs,
  };
  const daw_audio_utility_state encode = utility_state(
    1, 0.0F, DAW_AUDIO_UTILITY_POLARITY_NORMAL, DAW_AUDIO_UTILITY_INPUT_MODE_STEREO,
    0.0F, 0.0F, 1.0F, DAW_AUDIO_UTILITY_MATRIX_MID_SIDE_ENCODE);
  expect(daw_audio_core_configure_utility(core, &encode), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  const float *encoded_inputs[] = {left_output.data(), right_output.data()};
  const daw_audio_core_process_block decode_block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .frame_count = 480,
    .channel_count = 2,
    .input_bus_count = 1,
    .inputs = encoded_inputs,
    .outputs = outputs,
  };
  const daw_audio_utility_state decode = utility_state(
    1, 0.0F, DAW_AUDIO_UTILITY_POLARITY_NORMAL, DAW_AUDIO_UTILITY_INPUT_MODE_STEREO,
    0.0F, 0.0F, 1.0F, DAW_AUDIO_UTILITY_MATRIX_MID_SIDE_DECODE);
  expect(daw_audio_core_configure_utility(core, &decode), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_process(core, &decode_block), DAW_AUDIO_CORE_OK);
  for (uint32_t index = 0; index < left_input.size(); ++index) {
    assert(std::abs(left_output[index] - left_input[index]) <= 2e-6F);
    assert(std::abs(right_output[index] - right_input[index]) <= 2e-6F);
  }

  left_input.fill(0.5F);
  right_input.fill(0.5F);
  const daw_audio_utility_state dc_blocking = utility_state(
    1, 0.0F, DAW_AUDIO_UTILITY_POLARITY_NORMAL, DAW_AUDIO_UTILITY_INPUT_MODE_STEREO,
    0.0F, 0.0F, 1.0F, DAW_AUDIO_UTILITY_MATRIX_STEREO, 0, 1);
  expect(daw_audio_core_configure_utility(core, &dc_blocking), DAW_AUDIO_CORE_OK);
  for (uint32_t block_index = 0; block_index < 100; ++block_index) expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(std::abs(left_output.back()) <= 1e-4F);
  assert(std::abs(right_output.back()) <= 1e-4F);
  daw_audio_core_destroy(core);
}

void test_utility_audio_parameters_are_per_frame() {
  daw_audio_core_handle core = create_core(2, 2, 1);
  publish(core, 1);
  const daw_audio_utility_state state = utility_state();
  expect(daw_audio_core_configure_utility(core, &state), DAW_AUDIO_CORE_OK);
  const std::array<float, 2> left_input{1.0F, 1.0F};
  const std::array<float, 2> right_input{1.0F, 1.0F};
  const float *inputs[] = {left_input.data(), right_input.data()};
  std::array<float, 2> left_output{};
  std::array<float, 2> right_output{};
  float *outputs[] = {left_output.data(), right_output.data()};
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .frame_count = 2,
    .channel_count = 2,
    .input_bus_count = 1,
    .inputs = inputs,
    .outputs = outputs,
    .graph_revision = 0,
    .parameter_block_count = 0,
    .parameter_blocks = nullptr,
    .event_count = 0,
    .events = nullptr,
  };
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(std::abs(left_output[0] - 1.0F) <= 1e-6F);
  assert(std::abs(right_output[0] - 1.0F) <= 1e-6F);
  assert(std::abs(left_output[1] - 1.0F) <= 1e-6F);
  assert(std::abs(right_output[1] - 1.0F) <= 1e-6F);
  daw_audio_core_destroy(core);
}

void test_utility_fixture_protocol() {
  struct Fixture {
    daw_audio_utility_fixture_header header;
    std::array<float, 2> input;
  };
  static_assert(offsetof(Fixture, input) == sizeof(daw_audio_utility_fixture_header));
  const Fixture fixture{
    .header = {
      .magic = DAW_AUDIO_UTILITY_FIXTURE_MAGIC,
      .version = DAW_AUDIO_UTILITY_FIXTURE_VERSION,
      .sample_rate_hz = 48000,
      .frame_count = 1,
      .channel_count = 2,
      .input_bus_count = 1,
      .state = utility_state(1, 0.0F, DAW_AUDIO_UTILITY_POLARITY_INVERT),
    },
    .input = {0.25F, -0.5F},
  };
  std::array<float, 1> left_output{};
  std::array<float, 1> right_output{};
  float *outputs[] = {left_output.data(), right_output.data()};
  expect(daw_audio_core_run_utility_fixture(
    reinterpret_cast<const uint8_t *>(&fixture),
    sizeof(fixture),
    outputs), DAW_AUDIO_CORE_OK);
  assert(std::abs(left_output[0] + 0.25F) <= 1e-6F);
  assert(std::abs(right_output[0] - 0.5F) <= 1e-6F);
}

void test_instrument_graph_epoch_events_and_voice_capacity() {
  daw_audio_core_handle core = create_core(8, 2, 1);
  const std::array<daw_audio_graph_node_descriptor, 2> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_INSTRUMENT, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0,
      .instrument = {.kind = DAW_AUDIO_INSTRUMENT_KIND_SYNTH, .version = 1, .voice_capacity = 2,
        .parameter_count = 1, .parameter_targets = {DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_GAIN}}},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const std::array<daw_audio_graph_edge_descriptor, 1> edges{{
    {.id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0},
  }};
  prepare_graph(core, 1, nodes.data(), nodes.size(), edges.data(), edges.size());
  const daw_audio_transport_state transport{.epoch = 1, .running = 1, .frame = 0};
  expect(daw_audio_core_set_transport(core, &transport), DAW_AUDIO_CORE_OK);
  const std::array<daw_audio_instrument_event, 2> ordered{{
    {.node_id = 1, .note_id = 1, .sequence = 1, .epoch = 1, .frame_offset = 2,
      .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON, .channel = 0, .note = 60, .value = 1.0F},
    {.node_id = 1, .note_id = 1, .sequence = 2, .epoch = 1, .frame_offset = 2,
      .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF, .channel = 0, .note = 60, .value = 0.0F},
  }};
  std::array<float, 8> left{};
  std::array<float, 8> right{};
  float *outputs[]{left.data(), right.data()};
  daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 8, .channel_count = 2,
    .input_bus_count = 0, .inputs = nullptr, .outputs = outputs, .graph_revision = 1,
    .transport_epoch = 1, .instrument_event_count = static_cast<uint32_t>(ordered.size()), .instrument_events = ordered.data(),
  };
  allocation_count = 0;
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(allocation_count == 0);
  std::array<daw_audio_instrument_event, DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS> maximum_events{};
  for (uint32_t index = 0; index < maximum_events.size(); ++index) {
    maximum_events[index] = {
      .node_id = 1, .note_id = 0, .sequence = index + 1, .epoch = 1, .frame_offset = 0,
      .type = DAW_AUDIO_INSTRUMENT_EVENT_PARAMETER, .channel = 0,
      .note = DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_GAIN, .value = 1.0F,
    };
  }
  block.instrument_event_count = static_cast<uint32_t>(maximum_events.size());
  block.instrument_events = maximum_events.data();
  allocation_count = 0;
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(allocation_count == 0);
  block.transport_epoch = 2;
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_STALE_REVISION);
  const std::array<daw_audio_instrument_event, 3> overflow{{
    {.node_id = 1, .note_id = 2, .sequence = 3, .epoch = 1, .frame_offset = 0, .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON, .channel = 0, .note = 61, .value = 1.0F},
    {.node_id = 1, .note_id = 3, .sequence = 4, .epoch = 1, .frame_offset = 1, .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON, .channel = 0, .note = 62, .value = 1.0F},
    {.node_id = 1, .note_id = 4, .sequence = 5, .epoch = 1, .frame_offset = 2, .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON, .channel = 0, .note = 63, .value = 1.0F},
  }};
  block.transport_epoch = 1;
  block.instrument_event_count = static_cast<uint32_t>(overflow.size());
  block.instrument_events = overflow.data();
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  for (float sample : left) assert(std::isfinite(sample));
  daw_audio_core_destroy(core);
}

void test_instrument_synthesis_lifecycle_determinism_and_boundaries() {
  const daw_audio_synth_state synth{
    .version = 1, .seed = 0x12345678U,
    .oscillators = {
      {.enabled = 1, .waveform = DAW_AUDIO_SYNTH_WAVEFORM_SAWTOOTH, .level = 0.4F, .octave = 0, .semitone = 0, .detune_cents = 0.0F},
      {.enabled = 1, .waveform = DAW_AUDIO_SYNTH_WAVEFORM_SQUARE, .level = 0.2F, .octave = 1, .semitone = 0, .detune_cents = 3.0F},
    },
    .noise_enabled = 1, .noise_level = 0.1F, .filter_enabled = 1, .filter_mode = DAW_AUDIO_SYNTH_FILTER_MODE_LOWPASS,
    .filter_cutoff_hz = 4000.0F, .filter_resonance = 0.707F, .filter_key_tracking = 0.5F,
    .filter_envelope_amount_octaves = 1.0F, .filter_attack_ms = 1.0F, .filter_decay_ms = 10.0F,
    .filter_sustain = 0.5F, .filter_release_ms = 4.0F, .amp_attack_ms = 1.0F, .amp_decay_ms = 10.0F,
    .amp_sustain = 0.7F, .amp_release_ms = 4.0F, .lfo_enabled = 1, .lfo_waveform = DAW_AUDIO_SYNTH_WAVEFORM_TRIANGLE,
    .lfo_rate_hz = 3.0F, .lfo_pitch_cents = 8.0F, .lfo_filter_octaves = 0.2F, .lfo_amplitude = 0.1F,
    .lfo_pan = 0.2F, .output_gain = 0.8F, .output_pan = 0.0F,
  };
  const std::array<daw_audio_graph_node_descriptor, 2> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_INSTRUMENT, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0,
      .instrument = {.kind = DAW_AUDIO_INSTRUMENT_KIND_SYNTH, .version = 1, .voice_capacity = 1,
        .parameter_count = 8, .parameter_targets = {
          DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_GAIN, DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_PAN,
          DAW_AUDIO_SYNTH_PARAMETER_FILTER_CUTOFF_HZ, DAW_AUDIO_SYNTH_PARAMETER_FILTER_RESONANCE,
          DAW_AUDIO_SYNTH_PARAMETER_AMP_ATTACK_MS, DAW_AUDIO_SYNTH_PARAMETER_AMP_DECAY_MS,
          DAW_AUDIO_SYNTH_PARAMETER_AMP_SUSTAIN, DAW_AUDIO_SYNTH_PARAMETER_AMP_RELEASE_MS}}},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const std::array<daw_audio_graph_edge_descriptor, 1> edges{{
    {.id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0},
  }};
  const auto prepare = [&] {
    daw_audio_core_handle core = create_core(512, 2, 1);
    prepare_graph(core, 1, nodes.data(), nodes.size(), edges.data(), edges.size());
    expect(daw_audio_core_configure_synth(core, 1, &synth), DAW_AUDIO_CORE_OK);
    const daw_audio_transport_state transport{.epoch = 1, .running = 1, .frame = 0};
    expect(daw_audio_core_set_transport(core, &transport), DAW_AUDIO_CORE_OK);
    return core;
  };
  const std::array<daw_audio_instrument_event, 2> start{{
    {.node_id = 1, .note_id = 1, .sequence = 1, .epoch = 1, .frame_offset = 0, .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON, .channel = 0, .note = 60, .value = 0.9F},
    {.node_id = 1, .note_id = 2, .sequence = 2, .epoch = 1, .frame_offset = 32, .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON, .channel = 0, .note = 72, .value = 0.8F},
  }};
  const auto render = [&](daw_audio_core_handle core, uint32_t frames, const daw_audio_instrument_event *events, uint32_t event_count, float *left, float *right) {
    float *outputs[]{left, right};
    const daw_audio_core_process_block block{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = frames, .channel_count = 2,
      .input_bus_count = 0, .inputs = nullptr, .outputs = outputs, .graph_revision = 1,
      .transport_epoch = 1, .instrument_event_count = event_count, .instrument_events = events,
    };
    return daw_audio_core_process(core, &block);
  };
  daw_audio_core_handle first = prepare();
  daw_audio_core_handle second = prepare();
  daw_audio_core_handle steal_reference = prepare();
  std::array<float, 64> first_left{};
  std::array<float, 64> first_right{};
  std::array<float, 64> second_left{};
  std::array<float, 64> second_right{};
  allocation_count = 0;
  expect(render(first, 64, start.data(), start.size(), first_left.data(), first_right.data()), DAW_AUDIO_CORE_OK);
  assert(allocation_count == 0);
  expect(render(second, 64, start.data(), start.size(), second_left.data(), second_right.data()), DAW_AUDIO_CORE_OK);
  const std::array<daw_audio_instrument_event, 1> replacement{{
    {.node_id = 1, .note_id = 2, .sequence = 1, .epoch = 1, .frame_offset = 32, .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON, .channel = 0, .note = 72, .value = 0.8F},
  }};
  std::array<float, 64> replacement_left{};
  std::array<float, 64> replacement_right{};
  expect(render(steal_reference, 64, replacement.data(), replacement.size(), replacement_left.data(), replacement_right.data()), DAW_AUDIO_CORE_OK);
  bool has_audio = false;
  for (uint32_t frame = 0; frame < first_left.size(); ++frame) {
    assert(std::isfinite(first_left[frame]) && std::isfinite(first_right[frame]));
    assert(first_left[frame] == second_left[frame] && first_right[frame] == second_right[frame]);
    if (frame >= 32) {
      assert(first_left[frame] == replacement_left[frame] && first_right[frame] == replacement_right[frame]);
    }
    has_audio = has_audio || std::abs(first_left[frame]) > 1e-5F || std::abs(first_right[frame]) > 1e-5F;
  }
  assert(has_audio);
  const std::array<daw_audio_instrument_event, 1> silence{{
    {.node_id = 1, .note_id = 0, .sequence = 3, .epoch = 1, .frame_offset = 0, .type = DAW_AUDIO_INSTRUMENT_EVENT_PARAMETER, .channel = 0, .note = DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_GAIN, .value = 0.0F},
  }};
  std::array<float, 1> silent_left{};
  std::array<float, 1> silent_right{};
  expect(render(first, 1, silence.data(), silence.size(), silent_left.data(), silent_right.data()), DAW_AUDIO_CORE_OK);
  assert(std::abs(silent_left[0]) <= 1e-7F && std::abs(silent_right[0]) <= 1e-7F);
  const std::array<daw_audio_instrument_event, 1> invalid{{
    {.node_id = 1, .note_id = 3, .sequence = 4, .epoch = 1, .frame_offset = 0, .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON, .channel = 0, .note = 61, .value = NAN},
  }};
  expect(render(first, 1, invalid.data(), invalid.size(), silent_left.data(), silent_right.data()), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  const daw_audio_transport_state seek{.epoch = 2, .running = 1, .frame = 0};
  expect(daw_audio_core_set_transport(first, &seek), DAW_AUDIO_CORE_OK);
  expect(render(first, 1, start.data(), 1, silent_left.data(), silent_right.data()), DAW_AUDIO_CORE_STALE_REVISION);
  daw_audio_core_handle lifecycle = prepare();
  const std::array<daw_audio_instrument_event, 3> held_note{{
    {.node_id = 1, .note_id = 10, .sequence = 1, .epoch = 1, .frame_offset = 0, .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON, .channel = 0, .note = 64, .value = 1.0F},
    {.node_id = 1, .note_id = 10, .sequence = 2, .epoch = 1, .frame_offset = 1, .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON, .channel = 0, .note = 64, .value = 1.0F},
    {.node_id = 1, .note_id = 10, .sequence = 3, .epoch = 1, .frame_offset = 2, .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF, .channel = 0, .note = 64, .value = 0.0F},
  }};
  std::array<float, 256> lifecycle_left{};
  std::array<float, 256> lifecycle_right{};
  expect(render(lifecycle, 256, held_note.data(), held_note.size(), lifecycle_left.data(), lifecycle_right.data()), DAW_AUDIO_CORE_OK);
  float held_tail = 0.0F;
  for (uint32_t frame = 240; frame < lifecycle_left.size(); ++frame) held_tail = std::fmax(held_tail, std::abs(lifecycle_left[frame]));
  assert(held_tail > 1e-5F);
  const std::array<daw_audio_instrument_event, 2> release_and_sustain{{
    {.node_id = 1, .note_id = 0, .sequence = 4, .epoch = 1, .frame_offset = 0, .type = DAW_AUDIO_INSTRUMENT_EVENT_SUSTAIN, .channel = 0, .note = 0, .value = 1.0F},
    {.node_id = 1, .note_id = 10, .sequence = 5, .epoch = 1, .frame_offset = 1, .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF, .channel = 0, .note = 64, .value = 0.0F},
  }};
  expect(render(lifecycle, 256, release_and_sustain.data(), release_and_sustain.size(), lifecycle_left.data(), lifecycle_right.data()), DAW_AUDIO_CORE_OK);
  held_tail = 0.0F;
  for (uint32_t frame = 240; frame < lifecycle_left.size(); ++frame) held_tail = std::fmax(held_tail, std::abs(lifecycle_left[frame]));
  assert(held_tail > 1e-5F);
  const std::array<daw_audio_instrument_event, 1> pedal_up{{
    {.node_id = 1, .note_id = 0, .sequence = 6, .epoch = 1, .frame_offset = 0, .type = DAW_AUDIO_INSTRUMENT_EVENT_SUSTAIN, .channel = 0, .note = 0, .value = 0.0F},
  }};
  std::array<float, 256> release_left{};
  std::array<float, 256> release_right{};
  expect(render(lifecycle, 256, pedal_up.data(), pedal_up.size(), release_left.data(), release_right.data()), DAW_AUDIO_CORE_OK);
  assert(std::abs(release_left.back()) <= 1e-6F && std::abs(release_right.back()) <= 1e-6F);
  daw_audio_core_destroy(lifecycle);
  daw_audio_core_destroy(first);
  daw_audio_core_destroy(second);
  daw_audio_core_destroy(steal_reference);
}

void test_synth_filter_modes_and_partition_invariance() {
  const std::array<uint32_t, 4> modes{
    DAW_AUDIO_SYNTH_FILTER_MODE_LOWPASS,
    DAW_AUDIO_SYNTH_FILTER_MODE_HIGHPASS,
    DAW_AUDIO_SYNTH_FILTER_MODE_BANDPASS,
    DAW_AUDIO_SYNTH_FILTER_MODE_NOTCH,
  };
  const std::array<float, 2> resonances{0.05F, 20.0F};
  const std::array<daw_audio_graph_node_descriptor, 2> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_INSTRUMENT, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0,
      .instrument = {.kind = DAW_AUDIO_INSTRUMENT_KIND_SYNTH, .version = 1, .voice_capacity = 4,
        .parameter_count = 0, .parameter_targets = {}}},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const std::array<daw_audio_graph_edge_descriptor, 1> edges{{
    {.id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F,
      .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0},
  }};
  const std::array<daw_audio_instrument_event, 3> events{{
    {.node_id = 1, .note_id = 1, .sequence = 1, .epoch = 1, .frame_offset = 0,
      .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON, .channel = 0, .note = 60, .value = 1.0F},
    {.node_id = 1, .note_id = 2, .sequence = 2, .epoch = 1, .frame_offset = 32,
      .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON, .channel = 0, .note = 67, .value = 0.8F},
    {.node_id = 1, .note_id = 1, .sequence = 3, .epoch = 1, .frame_offset = 64,
      .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF, .channel = 0, .note = 60, .value = 0.0F},
  }};
  const std::array<uint32_t, 3> sample_rates{44'100, 48'000, 96'000};
  for (const uint32_t sample_rate : sample_rates) {
    for (const uint32_t mode : modes) {
      for (const float resonance : resonances) {
      const daw_audio_synth_state synth{
        .version = 1, .seed = 0x4321U,
        .oscillators = {
          {.enabled = 1, .waveform = DAW_AUDIO_SYNTH_WAVEFORM_SAWTOOTH, .level = 1.0F,
            .octave = 0, .semitone = 0, .detune_cents = 0.0F},
          {.enabled = 0, .waveform = DAW_AUDIO_SYNTH_WAVEFORM_SINE, .level = 0.0F,
            .octave = 0, .semitone = 0, .detune_cents = 0.0F},
        },
        .noise_enabled = 0, .noise_level = 0.0F, .filter_enabled = 1, .filter_mode = mode,
        .filter_cutoff_hz = 1800.0F, .filter_resonance = resonance, .filter_key_tracking = 0.25F,
        .filter_envelope_amount_octaves = 1.5F, .filter_attack_ms = 0.0F, .filter_decay_ms = 18.0F,
        .filter_sustain = 0.35F, .filter_release_ms = 4.0F, .amp_attack_ms = 0.0F,
        .amp_decay_ms = 12.0F, .amp_sustain = 0.65F, .amp_release_ms = 4.0F,
        .lfo_enabled = 1, .lfo_waveform = DAW_AUDIO_SYNTH_WAVEFORM_TRIANGLE, .lfo_rate_hz = 4.0F,
        .lfo_pitch_cents = 6.0F, .lfo_filter_octaves = 0.5F, .lfo_amplitude = 0.2F,
        .lfo_pan = 0.1F, .output_gain = 0.7F, .output_pan = 0.0F,
      };
      const auto prepare = [&] {
        daw_audio_core_handle core = create_core_at_rate(96, 2, 1, sample_rate);
        prepare_graph(core, 1, nodes.data(), nodes.size(), edges.data(), edges.size());
        expect(daw_audio_core_configure_synth(core, 1, &synth), DAW_AUDIO_CORE_OK);
        const daw_audio_transport_state transport{.epoch = 1, .running = 1, .frame = 0};
        expect(daw_audio_core_set_transport(core, &transport), DAW_AUDIO_CORE_OK);
        return core;
      };
      const auto render = [&](daw_audio_core_handle core, bool partitioned, std::array<float, 96> &left, std::array<float, 96> &right) {
        auto process = [&](uint32_t offset, uint32_t frames, const daw_audio_instrument_event *event_data, uint32_t event_count) {
          float *outputs[]{left.data() + offset, right.data() + offset};
          const daw_audio_core_process_block block{
            .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = frames, .channel_count = 2,
            .input_bus_count = 0, .inputs = nullptr, .outputs = outputs, .graph_revision = 1,
            .transport_epoch = 1, .instrument_event_count = event_count, .instrument_events = event_data,
          };
          expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
        };
        if (!partitioned) {
          process(0, 96, events.data(), events.size());
          return;
        }
        const std::array<daw_audio_instrument_event, 1> first{{events[0]}};
        const std::array<daw_audio_instrument_event, 1> second{{{
          .node_id = 1, .note_id = 2, .sequence = 2, .epoch = 1, .frame_offset = 0,
          .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON, .channel = 0, .note = 67, .value = 0.8F,
        }}};
        const std::array<daw_audio_instrument_event, 1> third{{{
          .node_id = 1, .note_id = 1, .sequence = 3, .epoch = 1, .frame_offset = 0,
          .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF, .channel = 0, .note = 60, .value = 0.0F,
        }}};
        process(0, 32, first.data(), first.size());
        process(32, 32, second.data(), second.size());
        process(64, 32, third.data(), third.size());
      };
      daw_audio_core_handle whole_core = prepare();
      daw_audio_core_handle partitioned_core = prepare();
      std::array<float, 96> whole_left{};
      std::array<float, 96> whole_right{};
      std::array<float, 96> partitioned_left{};
      std::array<float, 96> partitioned_right{};
      render(whole_core, false, whole_left, whole_right);
      render(partitioned_core, true, partitioned_left, partitioned_right);
      bool has_audio = false;
      for (uint32_t frame = 0; frame < whole_left.size(); ++frame) {
        assert(std::isfinite(whole_left[frame]) && std::isfinite(whole_right[frame]));
        assert(std::abs(whole_left[frame] - partitioned_left[frame]) <= 1e-6F);
        assert(std::abs(whole_right[frame] - partitioned_right[frame]) <= 1e-6F);
        has_audio = has_audio || std::abs(whole_left[frame]) > 1e-5F;
      }
      assert(has_audio);
      daw_audio_core_destroy(whole_core);
      daw_audio_core_destroy(partitioned_core);
      }
    }
  }
}


void test_sampler_and_drum_rack_asset_voices() {
  daw_audio_core_handle core = create_core(8, 2, 2);
  const std::array<daw_audio_graph_node_descriptor, 3> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_INSTRUMENT, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0,
      .instrument = {.kind = DAW_AUDIO_INSTRUMENT_KIND_SAMPLER, .version = 1, .voice_capacity = 2}},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_INSTRUMENT, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0,
      .instrument = {.kind = DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK, .version = 1, .voice_capacity = 2}},
    {.id = 3, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const std::array<daw_audio_graph_edge_descriptor, 2> edges{{
    {.id = 1, .from_node_id = 1, .to_node_id = 3, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER},
    {.id = 2, .from_node_id = 2, .to_node_id = 3, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER},
  }};
  prepare_graph(core, 1, nodes.data(), nodes.size(), edges.data(), edges.size());
  const std::array<float, 4> sample_left{0.25F, 0.5F, 0.75F, 1.0F};
  const std::array<float, 4> sample_right{-0.25F, -0.5F, -0.75F, -1.0F};
  const float *planes[]{sample_left.data(), sample_right.data()};
  const daw_audio_asset_descriptor descriptor{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .revision = 1, .byte_length = 32, .content_hash_prefix = 0,
    .frame_count = 4, .sample_rate_hz = 44100, .channel_count = 2, .planes = planes,
  };
  daw_audio_asset_handle asset = 0;
  expect(daw_audio_core_create_asset(core, &descriptor, &asset), DAW_AUDIO_CORE_OK);
  const daw_audio_sampler_state sampler{
    .version = 1, .zone_count = 1, .amp_attack_ms = 0.0F, .amp_decay_ms = 0.0F, .amp_sustain = 1.0F,
    .amp_release_ms = 1.0F, .filter_enabled = 0, .filter_mode = DAW_AUDIO_SYNTH_FILTER_MODE_LOWPASS,
    .filter_cutoff_hz = 20000.0F, .filter_resonance = 0.7F, .retrigger = 1,
  };
  const daw_audio_sample_zone sampler_zone{
    .asset = asset, .key_low = 60, .key_high = 60, .velocity_low = 1, .velocity_high = 127,
    .root_note = 60, .tune_cents = 0.0F, .gain = 1.0F, .pan = 0.0F, .round_robin_group = 0,
    .round_robin_index = 0, .playback_mode = DAW_AUDIO_SAMPLE_PLAYBACK_FORWARD_LOOP,
    .start_frame = 0, .end_frame = 4, .loop_start_frame = 1, .loop_end_frame = 4, .choke_group = 2,
  };
  const daw_audio_sample_zone drum_zone{
    .asset = asset, .key_low = 36, .key_high = 36, .velocity_low = 1, .velocity_high = 127,
    .root_note = 36, .tune_cents = 0.0F, .gain = 1.0F, .pan = 0.0F, .round_robin_group = 0,
    .round_robin_index = 0, .playback_mode = DAW_AUDIO_SAMPLE_PLAYBACK_ONE_SHOT,
    .start_frame = 0, .end_frame = 4, .loop_start_frame = 0, .loop_end_frame = 0, .choke_group = 1,
  };
  expect(daw_audio_core_configure_sampler(core, 1, &sampler, &sampler_zone), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_configure_sampler(core, 2, &sampler, &drum_zone), DAW_AUDIO_CORE_OK);
  const daw_audio_transport_state transport{.epoch = 1, .running = 1, .frame = 0};
  expect(daw_audio_core_set_transport(core, &transport), DAW_AUDIO_CORE_OK);
  const std::array<daw_audio_instrument_event, 3> events{{
    {.node_id = 1, .note_id = 1, .sequence = 1, .epoch = 1, .frame_offset = 0, .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON, .channel = 0, .note = 60, .value = 1.0F},
    {.node_id = 2, .note_id = 2, .sequence = 2, .epoch = 1, .frame_offset = 1, .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON, .channel = 0, .note = 36, .value = 1.0F},
    {.node_id = 2, .note_id = 3, .sequence = 3, .epoch = 1, .frame_offset = 2, .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON, .channel = 0, .note = 36, .value = 1.0F},
  }};
  std::array<float, 8> left{};
  std::array<float, 8> right{};
  float *outputs[]{left.data(), right.data()};
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 8, .channel_count = 2, .outputs = outputs,
    .graph_revision = 1, .transport_epoch = 1, .instrument_event_count = static_cast<uint32_t>(events.size()), .instrument_events = events.data(),
  };
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(std::abs(left[0]) > 1e-5F && std::abs(left[7]) > 1e-5F);
  expect(daw_audio_core_release_asset(core, asset), DAW_AUDIO_CORE_ASSET_IN_USE);
  const daw_audio_transport_state next_epoch{.epoch = 2, .running = 1, .frame = 0};
  expect(daw_audio_core_set_transport(core, &next_epoch), DAW_AUDIO_CORE_OK);
  std::array<float, 1> stale_left{};
  std::array<float, 1> stale_right{};
  float *stale_outputs[]{stale_left.data(), stale_right.data()};
  const daw_audio_core_process_block stale{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 1, .channel_count = 2, .outputs = stale_outputs,
    .graph_revision = 1, .transport_epoch = 1, .instrument_event_count = 1, .instrument_events = events.data(),
  };
  expect(daw_audio_core_process(core, &stale), DAW_AUDIO_CORE_STALE_REVISION);
  daw_audio_core_destroy(core);
}

void test_granular_asset_seed_freeze_and_note_ownership() {
  daw_audio_core_handle core = create_core(32, 2, 1);
  const std::array<daw_audio_graph_node_descriptor, 2> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_INSTRUMENT, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0,
      .instrument = {.kind = DAW_AUDIO_INSTRUMENT_KIND_GRANULAR, .version = 1, .voice_capacity = 2}},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const daw_audio_graph_edge_descriptor edge{
    .id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER,
  };
  prepare_graph(core, 1, nodes.data(), nodes.size(), &edge, 1);
  const std::array<float, 256> source = [] {
    std::array<float, 256> value{};
    for (uint32_t index = 0; index < value.size(); ++index) value[index] = std::sin(static_cast<float>(index) * 0.1F);
    return value;
  }();
  const float *planes[]{source.data()};
  const daw_audio_asset_descriptor descriptor{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .revision = 7, .byte_length = source.size() * sizeof(float),
    .content_hash_prefix = 0, .frame_count = static_cast<uint32_t>(source.size()), .sample_rate_hz = 48000,
    .channel_count = 1, .planes = planes,
  };
  daw_audio_asset_handle asset = 0;
  expect(daw_audio_core_create_asset(core, &descriptor, &asset), DAW_AUDIO_CORE_OK);
  const daw_audio_granular_state granular{
    .version = 1, .asset = asset, .seed = 77, .max_grains = 2, .window_shape = DAW_AUDIO_GRANULAR_WINDOW_HANN,
    .freeze = 1, .grain_size_ms = 5.0F, .density_hz = 200.0F, .position = 0.5F, .spray = 1.0F,
    .pitch_semitones = 0.0F, .reverse_probability = 0.5F, .stereo_spread = 0.5F,
  };
  expect(daw_audio_core_configure_granular(core, 1, &granular), DAW_AUDIO_CORE_OK);
  const daw_audio_granular_state invalid{
    .version = 1, .asset = asset, .seed = 0, .max_grains = 2, .window_shape = 9, .freeze = 0,
  };
  expect(daw_audio_core_configure_granular(core, 1, &invalid), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  const daw_audio_transport_state transport{.epoch = 1, .running = 1, .frame = 0};
  expect(daw_audio_core_set_transport(core, &transport), DAW_AUDIO_CORE_OK);
  const std::array<daw_audio_instrument_event, 3> start{{
    {.node_id = 1, .note_id = 11, .sequence = 1, .epoch = 1, .frame_offset = 0, .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON, .channel = 0, .note = 60, .value = 1.0F},
    {.node_id = 1, .note_id = 12, .sequence = 2, .epoch = 1, .frame_offset = 1, .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON, .channel = 0, .note = 61, .value = 1.0F},
    {.node_id = 1, .note_id = 11, .sequence = 3, .epoch = 1, .frame_offset = 2, .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF, .channel = 0, .note = 60, .value = 0.0F},
  }};
  std::array<float, 32> left{};
  std::array<float, 32> right{};
  float *outputs[]{left.data(), right.data()};
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 32, .channel_count = 2, .outputs = outputs,
    .graph_revision = 1, .transport_epoch = 1, .instrument_event_count = static_cast<uint32_t>(start.size()), .instrument_events = start.data(),
  };
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(std::any_of(left.begin(), left.end(), [](float value) { return std::isfinite(value) && std::abs(value) > 1e-6F; }));
  expect(daw_audio_core_release_asset(core, asset), DAW_AUDIO_CORE_ASSET_IN_USE);
  const daw_audio_instrument_event release{
    .node_id = 1, .note_id = 12, .sequence = 4, .epoch = 1, .frame_offset = 0, .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF,
    .channel = 0, .note = 61, .value = 0.0F,
  };
  std::array<float, 32> release_left{};
  std::array<float, 32> release_right{};
  float *release_outputs[]{release_left.data(), release_right.data()};
  const daw_audio_core_process_block release_block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 32, .channel_count = 2, .outputs = release_outputs,
    .graph_revision = 1, .transport_epoch = 1, .instrument_event_count = 1, .instrument_events = &release,
  };
  expect(daw_audio_core_process(core, &release_block), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_release_asset(core, asset), DAW_AUDIO_CORE_OK);
  daw_audio_core_destroy(core);
}

void test_recording_capture_boundaries_ownership_and_overflow() {
  const daw_audio_recording_capture_config config{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .generation = 9, .session_id = 77,
    .channel_count = 2, .input_channels = {0, 3}, .gain = 2.0F, .polarity = -1,
    .punch_start_frame = 2, .punch_end_frame = 6,
  };
  daw_audio_core_handle capture = 0;
  expect(daw_audio_recording_capture_create(&config, &capture), DAW_AUDIO_CORE_OK);
  const std::array<float, 8> first{0.0F, 0.25F, 0.5F, 0.75F, 1.0F, -0.5F, 0.25F, 0.0F};
  const std::array<float, 8> second{};
  const std::array<float, 8> third{0.0F, 0.0F, 0.25F, 0.5F, 0.75F, 1.0F, 0.0F, 0.0F};
  const float *inputs[]{first.data(), second.data(), third.data(), third.data()};
  std::array<float, 8> monitor_left{};
  std::array<float, 8> monitor_right{};
  float *monitor[]{monitor_left.data(), monitor_right.data()};
  expect(daw_audio_recording_capture_process_monitor(capture, inputs, 4, monitor, 2, 8, 0), DAW_AUDIO_CORE_OK);
  assert(std::abs(monitor_left[1] + 0.5F) <= 1e-6F);
  assert(std::abs(monitor_left[2] + 1.0F) <= 1e-6F);
  assert(std::abs(monitor_right[2] + 0.5F) <= 1e-6F);
  assert(std::abs(monitor_right[6]) <= 1e-6F);
  expect(daw_audio_recording_capture_finalize(capture, 5), DAW_AUDIO_CORE_OK);
  daw_audio_recording_capture_block block{};
  expect(daw_audio_recording_capture_dequeue(capture, &block), DAW_AUDIO_CORE_OK);
  assert(block.generation == 9 && block.session_id == 77 && block.frame_count == 3 && block.channel_count == 2);
  assert(std::abs(block.planes[0][0] + 1.0F) <= 1e-6F);
  assert(std::abs(block.planes[0][1] + 1.5F) <= 1e-6F);
  assert(std::abs(block.planes[0][2] + 2.0F) <= 1e-6F);
  assert(std::abs(block.planes[1][0] + 0.5F) <= 1e-6F);
  expect(daw_audio_recording_capture_release_block(capture, block.block_id), DAW_AUDIO_CORE_OK);
  expect(daw_audio_recording_capture_release_block(capture, block.block_id), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  daw_audio_recording_capture_diagnostics diagnostics{};
  expect(daw_audio_recording_capture_get_diagnostics(capture, &diagnostics), DAW_AUDIO_CORE_OK);
  assert(diagnostics.captured_frames == 3 && diagnostics.available_blocks == DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS);
  daw_audio_recording_capture_destroy(capture);

  daw_audio_recording_capture_config overflow = config;
  overflow.channel_count = 1;
  overflow.input_channels[0] = 0;
  overflow.punch_start_frame = 0;
  overflow.punch_end_frame = -1;
  expect(daw_audio_recording_capture_create(&overflow, &capture), DAW_AUDIO_CORE_OK);
  const std::array<float, DAW_AUDIO_RECORDING_CAPTURE_BLOCK_FRAMES> silence{};
  const float *mono[]{silence.data()};
  for (uint32_t index = 0; index < DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS; ++index) {
    expect(daw_audio_recording_capture_process(
      capture, mono, 1, DAW_AUDIO_RECORDING_CAPTURE_BLOCK_FRAMES,
      static_cast<int64_t>(index) * DAW_AUDIO_RECORDING_CAPTURE_BLOCK_FRAMES), DAW_AUDIO_CORE_OK);
  }
  expect(daw_audio_recording_capture_process(
    capture, mono, 1, 1,
    static_cast<int64_t>(DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS) * DAW_AUDIO_RECORDING_CAPTURE_BLOCK_FRAMES),
    DAW_AUDIO_CORE_CAPACITY_EXCEEDED);
  expect(daw_audio_recording_capture_get_diagnostics(capture, &diagnostics), DAW_AUDIO_CORE_OK);
  assert(diagnostics.dropped_frames == 1 && diagnostics.dropped_blocks == 1 && diagnostics.fatal == 1);
  daw_audio_recording_capture_block in_flight{};
  expect(daw_audio_recording_capture_dequeue(capture, &in_flight), DAW_AUDIO_CORE_OK);
  const uint32_t in_flight_frames = in_flight.frame_count;
  expect(daw_audio_recording_capture_cancel(capture), DAW_AUDIO_CORE_OK);
  assert(in_flight.frame_count == in_flight_frames);
  expect(daw_audio_recording_capture_release_block(capture, in_flight.block_id), DAW_AUDIO_CORE_OK);
  while (daw_audio_recording_capture_dequeue(capture, &block) == DAW_AUDIO_CORE_OK) {
    expect(daw_audio_recording_capture_release_block(capture, block.block_id), DAW_AUDIO_CORE_OK);
  }
  expect(daw_audio_recording_capture_get_diagnostics(capture, &diagnostics), DAW_AUDIO_CORE_OK);
  assert(diagnostics.captured_frames == 0 && diagnostics.active == 0
    && diagnostics.queued_blocks == 0 && diagnostics.available_blocks == DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS);
  daw_audio_recording_capture_destroy(capture);

  daw_audio_recording_capture_config replacement = overflow;
  replacement.generation = 10;
  replacement.session_id = 78;
  expect(daw_audio_core_wasm_recording_capture_initialize(&replacement), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_wasm_recording_capture_process(mono, 1, 1, 0), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_wasm_recording_capture_cancel(), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_wasm_recording_capture_get_diagnostics(&diagnostics), DAW_AUDIO_CORE_OK);
  assert(diagnostics.generation == 10 && diagnostics.session_id == 78
    && diagnostics.captured_frames == 0 && diagnostics.active == 0);
}

}  // namespace

void *operator new(std::size_t size) {
  ++allocation_count;
  if (void *memory = std::malloc(size)) return memory;
  throw std::bad_alloc();
}

void operator delete(void *memory) noexcept {
  std::free(memory);
}

int main() {
  test_portable_graph_topology_pdc_and_revision_safety();
  test_graph_edges_read_declared_stage_taps();
  test_native_graph_hook_binds_prepared_nodes_before_publish();
  test_portable_graph_rejects_invalid_topology_and_capacity();
  test_portable_graph_utility_node();
  test_per_instance_history_isolation_and_republication();
  test_utility_history_isolated_between_instances_and_standalone();
  test_pdc_delay_may_exceed_runtime_block_size_within_ring_capacity();
  test_processor_chain_prepare_and_dispatch();
  test_processor_control_slot_survives_graph_compaction();
  test_portable_saturator_and_eq_characterization();
  test_targeted_sidechain_routing();
  test_portable_modulation_processor_characterization();
  test_portable_dynamics_processor_characterization();
  test_portable_delay_and_reverb_characterization();
  test_portable_spectral_processor_characterization_and_capacity();
  test_abi_and_revision_rejection();
  test_variable_blocks_and_capacity();
  test_stale_asset_handles();
  test_sample_source_scheduling();
  test_sample_source_partition_invariance_and_mono();
  test_sample_source_fractional_rate_matrix_and_overlaps();
  test_sample_source_targets_published_graph_source();
  test_process_allocates_nothing();
  test_prepared_graph_ranges_are_partition_invariant_and_allocation_free();
  test_utility_and_summing_graph();
  test_utility_dsp_state_and_bypass();
  test_utility_mid_side_and_dc_blocking();
  test_utility_audio_parameters_are_per_frame();
  test_utility_fixture_protocol();
  test_instrument_graph_epoch_events_and_voice_capacity();
  test_instrument_synthesis_lifecycle_determinism_and_boundaries();
  test_synth_filter_modes_and_partition_invariance();
  test_sampler_and_drum_rack_asset_voices();
  test_granular_asset_seed_freeze_and_note_ownership();
  test_recording_capture_boundaries_ownership_and_overflow();
}
