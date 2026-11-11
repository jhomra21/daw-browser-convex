#include "daw/audio_core.h"
#include "utility_fixture.h"
#include "daw/audio_core_native.h"
#include "daw/audio_core_instrument_wire.h"
#include "graph_fixture.h"
#if defined(DAW_AUDIO_CORE_TEST_SPECTRAL_INTERNALS)

// Source-level contracts exercise the private transfer without adding a public
// mutation/inspection API. Build this variant without linking audio_core.cpp twice.
#include "../src/audio_core.cpp"
#endif

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <chrono>
#include <cstddef>
#include <cstring>
#include <cstdlib>
#include <cstdio>
#include <deque>
#include <map>
#include <memory>
#include <new>
#include <string>
#include <utility>
#include <vector>

static_assert(DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS == 24u);
static_assert(sizeof(daw_audio_synth_state) == daw::audio_core_wire::kSynthStateBytes);
static_assert(sizeof(daw_audio_sampler_state) == daw::audio_core_wire::kSamplerStateBytes);
static_assert(sizeof(daw_audio_sample_zone) == daw::audio_core_wire::kSampleZoneBytes);
static_assert(offsetof(daw_audio_recording_capture_block, sequence) == 16u);
static_assert(offsetof(daw_audio_recording_capture_block, rms) == 56u);
static_assert(offsetof(daw_audio_recording_capture_block, peak) == 60u);
static_assert(sizeof(daw_audio_recording_capture_block) == 64u);

namespace {

std::size_t allocation_count = 0;
std::size_t first_allocation_size = 0;

std::array<std::uint64_t, 3> native_hook_nodes{};
std::array<void*, 3> native_hook_attachments{};
std::array<std::uint32_t, 3> native_hook_revisions{};
std::array<std::uint32_t, 3> native_hook_stages{};
std::array<daw::audio_core::NativeGraphStageRole, 3> native_hook_roles{};
std::uint32_t native_hook_calls = 0;
std::array<std::uint64_t, 2> native_observer_nodes{};
std::array<float, 2> native_observer_left{};
std::uint32_t native_observer_calls = 0;

void native_graph_hook(const daw::audio_core::NativeGraphNodeRender& render) noexcept {
  native_hook_nodes[native_hook_calls] = render.node_id;
  native_hook_attachments[native_hook_calls] = render.attachment;
  native_hook_revisions[native_hook_calls] = render.graph_revision;
  native_hook_stages[native_hook_calls] = render.stage_index;
  native_hook_roles[native_hook_calls] = render.stage_role;
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

void native_mixed_stage_hook(const daw::audio_core::NativeGraphNodeRender& render) noexcept {
  auto *operation = static_cast<int *>(render.attachment);
  if (operation == nullptr) return;
  for (std::uint32_t frame = 0; frame < render.frame_count; ++frame) {
    render.planes[0][frame] += static_cast<float>(*operation);
    render.planes[1][frame] += static_cast<float>(*operation);
  }
}

void native_instrument_source_hook(const daw::audio_core::NativeGraphNodeRender& render) noexcept {
  for (std::uint32_t frame = 0; frame < render.frame_count; ++frame) {
    render.planes[0][frame] = 2.0F;
    render.planes[1][frame] = 2.0F;
  }
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
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  expect(daw_audio_core_prepare_graph(core, &latency_change), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_cancel_prepared_graph(core, 6), DAW_AUDIO_CORE_OK);
#else
  expect(daw_audio_core_prepare_graph(core, &latency_change), DAW_AUDIO_CORE_LATENCY_CHANGE_DEFERRED);
#endif
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

void test_master_mixer_gain_is_applied_to_rendered_output() {
  daw_audio_core_handle core = create_core(4, 2, 1);
  const std::array<daw_audio_graph_node_descriptor, 2> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0,
      .mixer = {.instance_id = 202, .gain = 0.25F}},
  }};
  const daw_audio_graph_edge_descriptor edge{
    .id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F,
    .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0,
  };
  prepare_graph(core, 1, nodes.data(), nodes.size(), &edge, 1);
  std::array<float, 4> input_left{2.0F, 2.0F, 2.0F, 2.0F};
  std::array<float, 4> input_right{4.0F, 4.0F, 4.0F, 4.0F};
  const float *inputs[]{input_left.data(), input_right.data()};
  std::array<float, 4> output_left{};
  std::array<float, 4> output_right{};
  float *outputs[]{output_left.data(), output_right.data()};
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 4, .channel_count = 2,
    .input_bus_count = 1, .inputs = inputs, .outputs = outputs,
  };
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(output_left[0] == 0.5F);
  assert(output_right[0] == 1.0F);
  assert(output_left[3] == 0.5F);
  assert(output_right[3] == 1.0F);
  daw_audio_core_destroy(core);
}

// A source and its fader feeding a master with no fader, for the mixer witnesses.
void prepare_fader_graph(
  daw_audio_core_handle core, uint32_t revision, daw_audio_mixer_state mixer, float edge_gain = 1.0F) {
  const std::array<daw_audio_graph_node_descriptor, 2> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0, .mixer = mixer},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const daw_audio_graph_edge_descriptor edge{
    .id = 1, .from_node_id = 1, .to_node_id = 2, .gain = edge_gain,
    .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0,
  };
  prepare_graph(core, revision, nodes.data(), nodes.size(), &edge, 1);
}

// One block of unit DC on every input bus; returns the left output.
std::vector<float> render_dc_block(
  daw_audio_core_handle core, uint32_t revision, uint32_t frames, uint32_t buses = 1,
  const std::vector<daw_audio_processor_event> &events = {}) {
  const std::vector<float> input(frames, 1.0F);
  std::vector<float> left(frames);
  std::vector<float> right(frames);
  std::vector<const float *> inputs(buses * 2, input.data());
  float *outputs[]{left.data(), right.data()};
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = frames, .channel_count = 2,
    .input_bus_count = buses, .inputs = inputs.data(), .outputs = outputs, .graph_revision = revision,
    .event_count = static_cast<uint32_t>(events.size()), .events = events.empty() ? nullptr : events.data(),
  };
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(left == right);
  return left;
}

// A mixer event holds until a later event supersedes it, across blocks: an
// automation hold and a schedule's one window-start set rely on it.
void test_mixer_event_value_holds_across_blocks() {
  daw_audio_core_handle core = create_core(8, 2, 1);
  prepare_fader_graph(core, 1, {.instance_id = 101, .gain = 1.0F});
  const auto set = render_dc_block(core, 1, 8, 1, {{.processor_instance_id = 101,
    .parameter_target = DAW_AUDIO_MIXER_PARAMETER_GAIN, .frame_offset = 2, .value = 0.25F}});
  assert(set[1] == 1.0F && set[2] == 0.25F && set[7] == 0.25F);
  for (const float sample : render_dc_block(core, 1, 8)) assert(sample == 0.25F);
  for (const float sample : render_dc_block(core, 1, 8, 1, {{.processor_instance_id = 101,
    .parameter_target = DAW_AUDIO_MIXER_PARAMETER_MUTE, .frame_offset = 0, .value = 1.0F}})) assert(sample == 0.0F);
  for (const float sample : render_dc_block(core, 1, 8)) assert(sample == 0.0F);
  const auto unmuted = render_dc_block(core, 1, 8, 1, {{.processor_instance_id = 101,
    .parameter_target = DAW_AUDIO_MIXER_PARAMETER_MUTE, .frame_offset = 4, .value = 0.0F}});
  assert(unmuted[3] == 0.0F && unmuted[4] == 0.25F && unmuted[7] == 0.25F);
  daw_audio_core_destroy(core);
}

// A solo event silences every other fader from its frame on, and holds as well.
void test_mixer_solo_event_holds_and_silences_other_faders() {
  daw_audio_core_handle core = create_core(8, 2, 1);
  const std::array<daw_audio_graph_node_descriptor, 3> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0,
      .mixer = {.instance_id = 101, .gain = 1.0F}},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 1, .latency_frames = 0,
      .mixer = {.instance_id = 102, .gain = 0.5F}},
    {.id = 3, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const std::array<daw_audio_graph_edge_descriptor, 2> edges{{
    {.id = 11, .from_node_id = 1, .to_node_id = 3, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER},
    {.id = 12, .from_node_id = 2, .to_node_id = 3, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER},
  }};
  prepare_graph(core, 1, nodes.data(), nodes.size(), edges.data(), edges.size());
  const auto soloed = render_dc_block(core, 1, 8, 2, {{.processor_instance_id = 102,
    .parameter_target = DAW_AUDIO_MIXER_PARAMETER_SOLO, .frame_offset = 4, .value = 1.0F}});
  assert(soloed[3] == 1.5F && soloed[4] == 0.5F && soloed[7] == 0.5F);
  for (const float sample : render_dc_block(core, 1, 8, 2)) assert(sample == 0.5F);
  daw_audio_core_destroy(core);
}

// Held automation, then a fader commit (MIXPROBE B/C): publish drops what every
// retained node latched, so the committed descriptor wins even when its value
// did not change, and it is reached over the plan's fade, not in one step.
void test_mixer_publish_drops_latched_values() {
  daw_audio_core_handle core = create_core(256, 2, 1);
  prepare_fader_graph(core, 1, {.instance_id = 101, .gain = 1.0F});
  (void)render_dc_block(core, 1, 256, 1, {{.processor_instance_id = 101,
    .parameter_target = DAW_AUDIO_MIXER_PARAMETER_GAIN, .frame_offset = 0, .value = 0.25F}});
  assert(render_dc_block(core, 1, 256).back() == 0.25F);
  prepare_fader_graph(core, 2, {.instance_id = 101, .gain = 1.0F});
  assert(render_dc_block(core, 2, 256).back() == 1.0F);
  for (const float sample : render_dc_block(core, 2, 256)) assert(sample == 1.0F);
  prepare_fader_graph(core, 3, {.instance_id = 101, .gain = 0.5F});
  assert(render_dc_block(core, 3, 256).back() == 0.5F);
  for (const float sample : render_dc_block(core, 3, 256)) assert(sample == 0.5F);
  daw_audio_core_destroy(core);
}

// A locate starts a new epoch: what the old one latched is dropped, and the
// schedule's window-start set establishes the automated value again.
void test_mixer_epoch_change_drops_latched_values() {
  daw_audio_core_handle core = create_core(8, 2, 1);
  prepare_fader_graph(core, 1, {.instance_id = 101, .gain = 1.0F});
  daw_audio_transport_state transport{.epoch = 1, .running = 1, .tempo_bpm = 120.0,
    .time_signature_numerator = 4, .time_signature_denominator = 4};
  expect(daw_audio_core_set_transport(core, &transport), DAW_AUDIO_CORE_OK);
  (void)render_dc_block(core, 1, 8, 1, {{.processor_instance_id = 101,
    .parameter_target = DAW_AUDIO_MIXER_PARAMETER_GAIN, .frame_offset = 0, .value = 0.25F}});
  for (const float sample : render_dc_block(core, 1, 8)) assert(sample == 0.25F);
  transport.epoch = 2;
  expect(daw_audio_core_set_transport(core, &transport), DAW_AUDIO_CORE_OK);
  for (const float sample : render_dc_block(core, 1, 8)) assert(sample == 1.0F);
  daw_audio_core_destroy(core);
}

// A fader edit published while the node plays moves the output by at most one
// step of the plan's fade per frame: a gain step, a mute and an unmute alike.
void test_mixer_publish_ramps_gain_mute_and_unmute() {
  constexpr uint32_t fade_frames = (48000u * 5u + 500u) / 1000u;
  daw_audio_core_handle core = create_core(256, 2, 1);
  prepare_fader_graph(core, 1, {.instance_id = 101, .gain = 0.5F});
  float previous = render_dc_block(core, 1, 256).back();
  assert(previous == 0.5F);
  const auto expect_ramp = [&](uint32_t revision, daw_audio_mixer_state mixer, float target) {
    prepare_fader_graph(core, revision, mixer);
    const auto block = render_dc_block(core, revision, 256);
    const float bound = std::fabs(target - previous) / static_cast<float>(fade_frames) + 1.0e-6F;
    for (const float sample : block) {
      assert(std::fabs(sample - previous) <= bound);
      previous = sample;
    }
    assert(block[fade_frames - 1] == target && block.back() == target);
  };
  expect_ramp(2, {.instance_id = 101, .gain = 0.25F}, 0.25F);
  expect_ramp(3, {.instance_id = 101, .gain = 0.25F, .muted = 1}, 0.0F);
  expect_ramp(4, {.instance_id = 101, .gain = 0.25F}, 0.25F);
  daw_audio_core_destroy(core);
}

// Two sources on their own buses into a master, B's output edge at `b_edge`: the
// product's solo topology moves only the output edges of the tracks it silences.
// Without B, the plan deletes it.
void prepare_solo_graph(daw_audio_core_handle core, uint32_t revision, float b_edge, bool with_b = true) {
  const std::array<daw_audio_graph_node_descriptor, 3> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .mixer = {.instance_id = 101, .gain = 1.0F}},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 1, .mixer = {.instance_id = 102, .gain = 1.0F}},
    {.id = 3, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0},
  }};
  const std::array<daw_audio_graph_edge_descriptor, 2> edges{{
    {.id = 11, .from_node_id = 1, .to_node_id = 3, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER},
    {.id = 12, .from_node_id = 2, .to_node_id = 3, .gain = b_edge, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER},
  }};
  if (with_b) prepare_graph(core, revision, nodes.data(), nodes.size(), edges.data(), edges.size());
  else {
    const std::array<daw_audio_graph_node_descriptor, 2> kept{nodes[0], nodes[2]};
    prepare_graph(core, revision, kept.data(), kept.size(), edges.data(), 1);
  }
}

// A publish that changes the gain of an edge it keeps moves that edge over the
// plan's fade as well: an edge change alone steps by at most |delta|/fade per
// frame. A product mute or unmute moves the fader and the output edge together
// over the same fade, so the output follows (1 - k/fade)^2 and steps by at most
// (2 fade - 1)/fade^2. So does an edge still moving when its node is deleted,
// against the node's deletion fade.
void test_edge_publish_ramps_gain_mute_and_solo() {
  constexpr uint32_t fade_frames = (48000u * 5u + 500u) / 1000u;
  constexpr float fade = static_cast<float>(fade_frames);
  constexpr float composite = (2.0F * fade - 1.0F) / (fade * fade);
  daw_audio_core_handle core = create_core(256, 2, 1);
  float previous = 0.0F;
  const auto expect_steps = [&](uint32_t revision, uint32_t buses, uint32_t frames, float bound) {
    const auto block = render_dc_block(core, revision, frames, buses);
    for (const float sample : block) {
      assert(std::fabs(sample - previous) <= bound + 1.0e-6F);
      previous = sample;
    }
    return block;
  };
  const auto expect_ramp = [&](uint32_t revision, uint32_t buses, float target, float bound) {
    const auto block = expect_steps(revision, buses, 256, bound);
    assert(block[fade_frames - 1] == target && block.back() == target);
    for (const float sample : render_dc_block(core, revision, 256, buses)) assert(sample == target);
  };
  prepare_fader_graph(core, 1, {.instance_id = 101, .gain = 1.0F}, 0.5F);
  previous = render_dc_block(core, 1, 256).back();
  assert(previous == 0.5F);
  prepare_fader_graph(core, 2, {.instance_id = 101, .gain = 1.0F}, 0.25F);
  expect_ramp(2, 1, 0.25F, 0.25F / fade);
  // A publish during the move that keeps the edge's gain lets the move run on; one
  // that changes it again starts from where the edge stands.
  prepare_fader_graph(core, 3, {.instance_id = 101, .gain = 1.0F}, 1.0F);
  (void)expect_steps(3, 1, 64, 0.75F / fade);
  prepare_fader_graph(core, 4, {.instance_id = 101, .gain = 1.0F}, 1.0F);
  const auto carried = expect_steps(4, 1, 256, 0.75F / fade);
  assert(carried[fade_frames - 64 - 1] == 1.0F && carried.back() == 1.0F);
  prepare_fader_graph(core, 5, {.instance_id = 101, .gain = 1.0F}, 0.5F);
  (void)expect_steps(5, 1, 64, 0.5F / fade);
  prepare_fader_graph(core, 6, {.instance_id = 101, .gain = 1.0F}, 1.0F);
  expect_ramp(6, 1, 1.0F, 0.5F / fade);
  prepare_fader_graph(core, 7, {.instance_id = 101, .gain = 0.0F, .muted = 1}, 0.0F);
  expect_ramp(7, 1, 0.0F, composite);
  prepare_fader_graph(core, 8, {.instance_id = 101, .gain = 1.0F}, 1.0F);
  expect_ramp(8, 1, 1.0F, composite);
  daw_audio_core_destroy(core);
  core = create_core(256, 2, 1);
  prepare_solo_graph(core, 1, 1.0F);
  previous = render_dc_block(core, 1, 256, 2).back();
  assert(previous == 2.0F);
  prepare_solo_graph(core, 2, 0.0F);
  expect_ramp(2, 2, 1.0F, 1.0F / fade);
  prepare_solo_graph(core, 3, 1.0F);
  expect_ramp(3, 2, 2.0F, 1.0F / fade);
  prepare_solo_graph(core, 4, 0.0F);
  (void)expect_steps(4, 2, 64, 1.0F / fade);
  prepare_solo_graph(core, 5, 0.0F, false);
  expect_ramp(5, 2, 1.0F, composite);
  daw_audio_core_destroy(core);
}

// A source's input bus indexes the process block's input buses, up to the bus
// capacity process accepts, not the channels of one bus: a browser project
// gives each of its audio tracks a source with its own bus.
void test_source_input_bus_is_bounded_by_bus_capacity() {
  daw_audio_core_handle core = create_core(4, 2, 1);
  std::array<daw_audio_graph_node_descriptor, 4> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 1},
    {.id = 3, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 2},
    {.id = 4, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0},
  }};
  const std::array<daw_audio_graph_edge_descriptor, 3> edges{{
    {.id = 11, .from_node_id = 1, .to_node_id = 4, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER},
    {.id = 12, .from_node_id = 2, .to_node_id = 4, .gain = 2.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER},
    {.id = 13, .from_node_id = 3, .to_node_id = 4, .gain = 4.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER},
  }};
  prepare_graph(core, 1, nodes.data(), nodes.size(), edges.data(), edges.size());
  for (const float sample : render_dc_block(core, 1, 4, 3)) assert(sample == 7.0F);
  for (const float sample : render_dc_block(core, 1, 4, 2)) assert(sample == 3.0F);
  nodes[2].input_bus = 64;
  const daw_audio_graph_prepare_request beyond{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 2,
    .node_count = static_cast<uint32_t>(nodes.size()), .edge_count = static_cast<uint32_t>(edges.size()),
    .nodes = nodes.data(), .edges = edges.data(),
  };
  expect(daw_audio_core_prepare_graph(core, &beyond), DAW_AUDIO_CORE_INVALID_ARGUMENT);
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
    {.node_id = 1, .stage_index = 0, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .pdc_latency_frames = 0, .attachment = &source_attachment},
    {.node_id = 1, .stage_index = 1, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .pdc_latency_frames = 0, .attachment = &source_chain_attachment},
    {.node_id = 2, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .pdc_latency_frames = 0,
      .attachment = &master_attachment},
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
  assert(native_hook_stages[0] == 0 && native_hook_stages[1] == 1 && native_hook_stages[2] == 0);
  assert(native_hook_roles[0] == daw::audio_core::NativeGraphStageRole::kEffect
    && native_hook_roles[1] == daw::audio_core::NativeGraphStageRole::kEffect
    && native_hook_roles[2] == daw::audio_core::NativeGraphStageRole::kEffect);
  assert(output_left[0] == 4.0F && output_right[0] == 12.0F);
  assert(native_observer_calls == 2 && native_observer_nodes[0] == 1 && native_observer_nodes[1] == 2);
  assert(native_observer_left[0] == 4.0F && native_observer_left[1] == 4.0F);
  const std::array<daw::audio_core::NativeGraphHookBinding, 1> bad_bindings{{
    {.node_id = 1, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .pdc_latency_frames = 1,
      .attachment = &source_attachment},
  }};
  expect(daw::audio_core::RegisterNativeGraphHook(core, {.graph_revision = 9, .hook = native_graph_hook,
    .bindings = bad_bindings}), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  const std::array<daw::audio_core::NativeGraphHookBinding, 2> gapped_bindings{{
    {.node_id = 1, .stage_index = 0, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .attachment = &source_attachment},
    {.node_id = 1, .stage_index = 2, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .attachment = &source_chain_attachment},
  }};
  expect(daw::audio_core::RegisterNativeGraphHook(core, {.graph_revision = 9, .hook = native_graph_hook,
    .bindings = gapped_bindings}), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  const std::array<daw::audio_core::NativeGraphHookBinding, 2> duplicate_bindings{{
    {.node_id = 1, .stage_index = 0, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .attachment = &source_attachment},
    {.node_id = 1, .stage_index = 0, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .attachment = &source_chain_attachment},
  }};
  expect(daw::audio_core::RegisterNativeGraphHook(core, {.graph_revision = 9, .hook = native_graph_hook,
    .bindings = duplicate_bindings}), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  daw_audio_core_destroy(core);
}

void test_native_mixed_stage_interleave_is_noncommutative_and_fader_is_last() {
  const auto run = [](const std::uint32_t hook_stage) {
    daw_audio_core_handle core = create_core(4, 2, 1);
    const std::array<daw_audio_graph_node_descriptor, 2> nodes{{
      {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
        .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0,
        .mixer = {.instance_id = 101, .gain = 2.0F}},
      {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
        .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
    }};
    const std::array<daw_audio_graph_edge_descriptor, 1> edges{{
      {.id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F,
        .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0},
    }};
    const daw_audio_utility_state utility_a{
      .enabled = 1, .gain_db = 6.0F, .polarity = DAW_AUDIO_UTILITY_POLARITY_NORMAL,
      .input_mode = DAW_AUDIO_UTILITY_INPUT_MODE_STEREO, .pan = 0.0F, .balance = 0.0F,
      .width = 1.0F, .matrix = DAW_AUDIO_UTILITY_MATRIX_STEREO, .swap = 0, .dc_block = 0,
    };
    const daw_audio_utility_state utility_b{
      .enabled = 1, .gain_db = -6.0F, .polarity = DAW_AUDIO_UTILITY_POLARITY_NORMAL,
      .input_mode = DAW_AUDIO_UTILITY_INPUT_MODE_STEREO, .pan = 0.0F, .balance = 0.0F,
      .width = 1.0F, .matrix = DAW_AUDIO_UTILITY_MATRIX_STEREO, .swap = 0, .dc_block = 0,
    };
    const std::array<daw_audio_processor_descriptor, 2> processors{{
      {.node_id = 1, .instance_id = 201, .kind = DAW_AUDIO_PROCESSOR_KIND_UTILITY, .state_version = 1,
        .state_size = sizeof(utility_a), .bypassed = 0, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
        .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .latency_frames = 0, .tail_frames = 0,
        .parameter_count = 0, .parameter_targets = nullptr,
        .state = reinterpret_cast<const uint8_t *>(&utility_a)},
      {.node_id = 1, .instance_id = 202, .kind = DAW_AUDIO_PROCESSOR_KIND_UTILITY, .state_version = 1,
        .state_size = sizeof(utility_b), .bypassed = 0, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
        .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .latency_frames = 0, .tail_frames = 0,
        .parameter_count = 0, .parameter_targets = nullptr,
        .state = reinterpret_cast<const uint8_t *>(&utility_b)},
    }};
    const daw_audio_graph_prepare_request request{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 1, .node_count = 2, .edge_count = 1,
      .processor_count = 2, .nodes = nodes.data(), .edges = edges.data(), .processors = processors.data(),
    };
    expect(daw_audio_core_prepare_graph(core, &request), DAW_AUDIO_CORE_OK);
    int operation = 1;
    const daw::audio_core::NativeGraphHookBinding binding{
      .node_id = 1, .stage_index = hook_stage, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .pdc_latency_frames = 0, .attachment = &operation,
    };
    expect(daw::audio_core::RegisterNativeGraphHook(core, {
      .graph_revision = 1, .hook = native_mixed_stage_hook,
      .bindings = std::span<const daw::audio_core::NativeGraphHookBinding>(&binding, 1),
    }), DAW_AUDIO_CORE_OK);
    expect(daw_audio_core_publish(core, 1), DAW_AUDIO_CORE_OK);
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
    const float result = output_left[0];
    daw_audio_core_destroy(core);
    return result;
  };

  const float built_in_then_hook_then_built_in = run(1);
  const float built_in_then_built_in_then_hook = run(2);
  assert(built_in_then_hook_then_built_in > 2.9F && built_in_then_hook_then_built_in < 3.1F);
  assert(built_in_then_built_in_then_hook > 3.9F && built_in_then_built_in_then_hook < 4.1F);
  assert(built_in_then_hook_then_built_in != built_in_then_built_in_then_hook);
}

void test_native_instrument_hook_is_a_source_stage() {
  daw_audio_core_handle core = create_core(4, 2, 1);
  const std::array<daw_audio_graph_node_descriptor, 2> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_INSTRUMENT, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0,
      .instrument = {.kind = DAW_AUDIO_INSTRUMENT_KIND_SYNTH, .version = 1, .voice_capacity = 1},
      .mixer = {.instance_id = 101, .gain = 2.0F}},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const daw_audio_graph_edge_descriptor edge{
    .id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F,
    .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0,
  };
  const daw_audio_utility_state effect_state{
    .enabled = 1, .gain_db = 6.0F, .polarity = DAW_AUDIO_UTILITY_POLARITY_NORMAL,
    .input_mode = DAW_AUDIO_UTILITY_INPUT_MODE_STEREO, .pan = 0.0F, .balance = 0.0F,
    .width = 1.0F, .matrix = DAW_AUDIO_UTILITY_MATRIX_STEREO, .swap = 0, .dc_block = 0,
  };
  const daw_audio_processor_descriptor effect{
    .node_id = 1, .instance_id = 102, .kind = DAW_AUDIO_PROCESSOR_KIND_UTILITY, .state_version = 1,
    .state_size = sizeof(effect_state), .bypassed = 0, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .latency_frames = 0, .tail_frames = 0,
    .parameter_count = 0, .parameter_targets = nullptr,
    .state = reinterpret_cast<const uint8_t *>(&effect_state),
  };
  const daw_audio_graph_prepare_request request{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 1, .node_count = 2, .edge_count = 1,
    .processor_count = 1, .nodes = nodes.data(), .edges = &edge, .processors = &effect,
  };
  expect(daw_audio_core_prepare_graph(core, &request), DAW_AUDIO_CORE_OK);
  int attachment = 1;
  const daw::audio_core::NativeGraphHookBinding binding{
    .node_id = 1, .stage_index = 0, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .stage_role = daw::audio_core::NativeGraphStageRole::kInstrument, .attachment = &attachment,
  };
  expect(daw::audio_core::RegisterNativeGraphHook(core, {
    .graph_revision = 1, .hook = native_instrument_source_hook,
    .bindings = std::span<const daw::audio_core::NativeGraphHookBinding>(&binding, 1),
  }), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_publish(core, 1), DAW_AUDIO_CORE_OK);
  std::array<float, 4> output_left{};
  std::array<float, 4> output_right{};
  float *outputs[]{output_left.data(), output_right.data()};
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 4, .channel_count = 2,
    .input_bus_count = 0, .inputs = nullptr, .outputs = outputs,
  };
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(output_left[0] > 7.9F && output_left[0] < 8.1F);
  assert(output_right[0] > 7.9F && output_right[0] < 8.1F);
  daw_audio_core_destroy(core);
}

void test_native_hook_runs_before_builtin_processor() {
  daw_audio_core_handle core = create_core(4, 2, 1);
  const std::array<daw_audio_graph_node_descriptor, 2> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const daw_audio_graph_edge_descriptor edge{
    .id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F,
    .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0,
  };
  const daw_audio_utility_state utility_state{
    .enabled = 1, .gain_db = 6.0F, .polarity = DAW_AUDIO_UTILITY_POLARITY_NORMAL,
    .input_mode = DAW_AUDIO_UTILITY_INPUT_MODE_STEREO, .pan = 0.0F, .balance = 0.0F,
    .width = 1.0F, .matrix = DAW_AUDIO_UTILITY_MATRIX_STEREO, .swap = 0, .dc_block = 0,
  };
  const daw_audio_processor_descriptor terminal{
    .node_id = 1, .instance_id = 91, .kind = DAW_AUDIO_PROCESSOR_KIND_UTILITY, .state_version = 1,
    .state_size = sizeof(utility_state), .bypassed = 0, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .latency_frames = 0, .tail_frames = 0,
    .parameter_count = 0, .parameter_targets = nullptr,
    .state = reinterpret_cast<const uint8_t *>(&utility_state),
  };
  const daw_audio_graph_prepare_request request{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 1, .node_count = 2, .edge_count = 1,
    .processor_count = 1, .nodes = nodes.data(), .edges = &edge, .processors = &terminal,
  };
  expect(daw_audio_core_prepare_graph(core, &request), DAW_AUDIO_CORE_OK);
  int hook_attachment = 1;
  daw::audio_core::NativeGraphHookBinding binding{
    .node_id = 1, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .pdc_latency_frames = 0,
    .attachment = &hook_attachment,
  };
  expect(daw::audio_core::RegisterNativeGraphHook(core, {
    .graph_revision = 1, .hook = native_graph_hook,
    .bindings = std::span<const daw::audio_core::NativeGraphHookBinding>(&binding, 1),
  }), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_publish(core, 1), DAW_AUDIO_CORE_OK);
  std::array<float, 4> left{1.0F, 1.0F, 1.0F, 1.0F};
  std::array<float, 4> right{1.0F, 1.0F, 1.0F, 1.0F};
  const float *inputs[]{left.data(), right.data()};
  std::array<float, 4> output_left{};
  std::array<float, 4> output_right{};
  float *outputs[]{output_left.data(), output_right.data()};
  daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 4, .channel_count = 2,
    .input_bus_count = 1, .inputs = inputs, .outputs = outputs, .graph_revision = 1,
  };
  native_hook_calls = 0;
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(native_hook_calls == 1);
  assert(output_left[0] > 3.9F && output_left[0] < 4.1F);
  assert(output_right[0] > 3.9F && output_right[0] < 4.1F);
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
  too_long.pdc_delay_frames = 65537;
  daw_audio_graph_prepare_request capacity_request{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 1, .node_count = 2, .edge_count = 1, .nodes = nodes.data(), .edges = &too_long,
  };
  expect(daw_audio_core_prepare_graph(core, &capacity_request), DAW_AUDIO_CORE_CAPACITY_EXCEEDED);
  capacity_request.edge_count = 0;
  capacity_request.edges = nullptr;
  const daw_audio_utility_state state{
    .enabled = 1, .gain_db = 0.0F, .polarity = DAW_AUDIO_UTILITY_POLARITY_NORMAL,
    .input_mode = DAW_AUDIO_UTILITY_INPUT_MODE_STEREO, .pan = 0.0F, .balance = 0.0F,
    .width = 1.0F, .matrix = DAW_AUDIO_UTILITY_MATRIX_STEREO, .swap = 0, .dc_block = 0,
  };
  std::array<daw_audio_processor_descriptor, DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE + 1> processors{};
  for (std::size_t index = 0; index < processors.size(); ++index) {
    processors[index] = {
      .node_id = 1, .instance_id = 1000 + static_cast<std::uint64_t>(index),
      .kind = DAW_AUDIO_PROCESSOR_KIND_UTILITY, .state_version = 1, .state_size = sizeof(state),
      .bypassed = 0, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .latency_frames = 0, .tail_frames = 0,
      .parameter_count = 0, .parameter_targets = nullptr,
      .state = reinterpret_cast<const std::uint8_t *>(&state),
    };
  }
  capacity_request.processor_count = static_cast<std::uint32_t>(processors.size());
  capacity_request.nodes = nodes.data();
  capacity_request.node_count = 2;
  capacity_request.processors = processors.data();
  const auto capacity_result = daw_audio_core_prepare_graph(core, &capacity_request);
  expect(capacity_result, DAW_AUDIO_CORE_CAPACITY_EXCEEDED);
  daw_audio_core_destroy(core);
}

void test_portable_graph_accepts_a_full_effect_chain() {
  daw_audio_core_handle core = create_core(8, 2, 1);
  const std::array<daw_audio_graph_node_descriptor, 2> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const daw_audio_graph_edge_descriptor edge{
    .id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F,
    .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0,
  };
  const daw_audio_utility_state state{
    .enabled = 1, .gain_db = 0.0F, .polarity = DAW_AUDIO_UTILITY_POLARITY_NORMAL,
    .input_mode = DAW_AUDIO_UTILITY_INPUT_MODE_STEREO, .pan = 0.0F, .balance = 0.0F,
    .width = 1.0F, .matrix = DAW_AUDIO_UTILITY_MATRIX_STEREO, .swap = 0, .dc_block = 0,
  };
  std::array<daw_audio_processor_descriptor, 17> processors{};
  for (std::size_t index = 0; index < processors.size(); ++index) {
    processors[index] = {
      .node_id = 1,
      .instance_id = 1000 + static_cast<std::uint64_t>(index),
      .kind = DAW_AUDIO_PROCESSOR_KIND_UTILITY,
      .state_version = 1,
      .state_size = sizeof(state),
      .bypassed = 0,
      .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .latency_frames = 0,
      .tail_frames = 0,
      .parameter_count = 0,
      .parameter_targets = nullptr,
      .state = reinterpret_cast<const std::uint8_t *>(&state),
    };
  }
  const daw_audio_graph_prepare_request request{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 1, .node_count = 2, .edge_count = 1,
    .processor_count = static_cast<std::uint32_t>(processors.size()), .nodes = nodes.data(), .edges = &edge,
    .processors = processors.data(),
  };
  expect(daw_audio_core_prepare_graph(core, &request), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_publish(core, 1), DAW_AUDIO_CORE_OK);
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

// A full ring, not an oversized block: this exercises wraparound, independent
// fan-out gains, and writing a tap exactly once despite several readers.
void test_phase4_full_history_and_fanout(uint32_t frames, bool measure = false, bool spectral = false) {
  first_allocation_size = 0;
  const auto core = create_core(frames, 2, 1);
  const auto core_bytes = first_allocation_size;
  const uint32_t delay = 65536;
  std::array<daw_audio_graph_node_descriptor, 3> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = 2, .output_layout = 2, .input_bus = 0},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = 2, .output_layout = 2, .input_bus = 1, .latency_frames = delay},
    {.id = 3, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = 2, .output_layout = 2},
  }};
  std::array<daw_audio_graph_edge_descriptor, 3> edges{{
    {.id = 1, .from_node_id = 1, .to_node_id = 3, .gain = 0.25F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .pdc_delay_frames = delay},
    {.id = 2, .from_node_id = 1, .to_node_id = 3, .gain = 0.75F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .pdc_delay_frames = delay},
    {.id = 3, .from_node_id = 2, .to_node_id = 3, .gain = 0.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER},
  }};
  const daw_audio_spectral_state spectral_state{
    .enabled = 1, .fft_size = 4096, .overlap = 4, .mode = DAW_AUDIO_SPECTRAL_MODE_FREEZE,
    .gate_threshold_db = -60.0F, .gate_attack_ms = 1.0F, .gate_release_ms = 20.0F, .mix = 1.0F,
  };
  const daw_audio_processor_descriptor processor{
    .node_id = 1, .instance_id = 10, .kind = DAW_AUDIO_PROCESSOR_KIND_SPECTRAL,
    .state_version = 1, .state_size = sizeof(spectral_state),
    .input_layout = 2, .output_layout = 2, .latency_frames = 4096,
    .state = reinterpret_cast<const uint8_t *>(&spectral_state),
  };
  if (spectral) {
    nodes[0].latency_frames = 4096;
    edges[0].pdc_delay_frames -= 4096;
    edges[1].pdc_delay_frames -= 4096;
  }
  const auto before_prepare = allocation_count;
  const daw_audio_graph_prepare_request request{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 1,
    .node_count = nodes.size(), .edge_count = edges.size(), .processor_count = spectral ? 1u : 0u,
    .nodes = nodes.data(), .edges = edges.data(), .processors = spectral ? &processor : nullptr,
  };
  expect(daw_audio_core_prepare_graph(core, &request), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_publish(core, 1), DAW_AUDIO_CORE_OK);
  assert(allocation_count == before_prepare);
  std::array<float, 8192> input{};
  std::array<float, 8192> input_right{};
  std::array<float, 8192> zero{};
  std::array<float, 8192> left{};
  std::array<float, 8192> right{};
  const float *inputs[]{input.data(), input_right.data(), zero.data(), zero.data()};
  float *outputs[]{left.data(), right.data()};
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = frames, .channel_count = 2,
    .input_bus_count = 2, .inputs = inputs, .outputs = outputs, .graph_revision = 1,
  };
  const auto sample = [](uint64_t frame) {
    return static_cast<float>((frame * 17u) % 1009u) / 1024.0F;
  };
  double block_nanoseconds = 0;
  uint32_t blocks = 0;
  for (uint64_t start = 0; start < delay * 3u; start += frames) {
    for (uint32_t frame = 0; frame < frames; ++frame) {
      input[frame] = sample(start + frame);
      input_right[frame] = -sample(start + frame + 47u) * 0.5F;
    }
    const auto before_render = allocation_count;
    const auto began = std::chrono::steady_clock::now();
    expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
    const double nanoseconds = std::chrono::duration<double, std::nano>(std::chrono::steady_clock::now() - began).count();
    // Attribute the spectral measurement to a fully populated steady graph,
    // excluding startup, OLA fill and the compensation history's first fill.
    if (!spectral || start >= delay + spectral_state.fft_size * 2u) {
      block_nanoseconds += nanoseconds;
      ++blocks;
    }
    assert(allocation_count == before_render);
    for (uint32_t frame = 0; frame < frames; ++frame) {
      // The ordinary FFT startup OLA ramp is not part of steady-state cost.
      if (spectral && start + frame < delay + spectral_state.fft_size) continue;
      const float expected = start + frame < delay ? 0.0F : sample(start + frame - delay);
      assert(spectral ? std::abs(left[frame] - expected) < 0.00005F : left[frame] == expected);
      const float expected_right = start + frame < delay ? 0.0F : -sample(start + frame - delay + 47u) * 0.5F;
      assert(spectral ? std::abs(right[frame] - expected_right) < 0.00005F : right[frame] == expected_right);
    }
  }
  if (measure) std::printf("phase4 history: frames=%u spectral=%u Core=%zu bytes histories=%zu bytes mean_block=%.3f us ns/frame=%.3f prepare_allocations=0 render_allocations=0\n",
    frames, spectral ? 1u : 0u, core_bytes, 192u * 2u * 65536u * sizeof(float), block_nanoseconds / blocks / 1000.0,
    block_nanoseconds / blocks / frames);
  daw_audio_core_destroy(core);
}

// Maximum live graphs can replace every source repeatedly. Completed ghosts
// must release their history ownership as well as their instrument runtime.
void test_phase4_sequential_maximum_replacement() {
  const auto core = create_core(128, 2, 1);
  std::array<daw_audio_graph_node_descriptor, 64> nodes{};
  std::array<daw_audio_graph_edge_descriptor, 63> edges{};
  nodes[63] = {.id = 10000, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = 2, .output_layout = 2};
  std::array<float, 128> left{};
  std::array<float, 128> right{};
  left.fill(0.25F);
  right.fill(-0.125F);
  const float *inputs[]{left.data(), right.data()};
  std::array<float, 128> output_left{};
  std::array<float, 128> output_right{};
  float *outputs[]{output_left.data(), output_right.data()};
  for (uint32_t revision = 1; revision <= 8; ++revision) {
    for (uint32_t node = 0; node < 63; ++node) {
      const uint64_t id = revision * 100u + node;
      nodes[node] = {.id = id, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = 2, .output_layout = 2};
      edges[node] = {.id = id, .from_node_id = id, .to_node_id = 10000,
        .gain = 1.0F / 64.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER};
    }
    prepare_graph(core, revision, nodes.data(), nodes.size(), edges.data(), edges.size());
    const daw_audio_core_process_block block{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 128, .channel_count = 2,
      .input_bus_count = 1, .inputs = inputs, .outputs = outputs, .graph_revision = revision,
    };
    for (uint32_t index = 0; index < 16; ++index) expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
    assert(output_left[127] == 63.0F * 0.25F / 64.0F);
    assert(output_right[127] == -63.0F * 0.125F / 64.0F);
    if (revision > 1) assert(daw_audio_core_reclaim_retired_runtime(core) == 63);
  }
  daw_audio_core_destroy(core);
}

// Failure-first native live contract, intentionally separate from the default
// foundation gates until live latency publication exists. Failures to guard:
// publication-time rather than seam-time switching; moving an unaffected path
// on a lower; a block-rounded rather than sample-exact 5 ms ramp; channel/gain
// corruption in a shared ring; and a raise that moves by anything other than R.
void test_phase4_live_latency_pcm(uint32_t rate, uint32_t frames, uint32_t before, uint32_t after,
  bool keep_latency = false, bool overlap = false, bool edited_signal = false) {
  const auto core = create_core_at_rate(frames, 2, 1, rate);
  std::array<daw_audio_graph_node_descriptor, 3> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = 2, .output_layout = 2},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = 2, .output_layout = 2,
      .input_bus = 1, .latency_frames = before},
    {.id = 3, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = 2, .output_layout = 2},
  }};
  std::array<daw_audio_graph_edge_descriptor, 3> edges{{
    {.id = 1, .from_node_id = 1, .to_node_id = 3, .gain = 0.25F,
      .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .pdc_delay_frames = before},
    {.id = 2, .from_node_id = 1, .to_node_id = 3, .gain = 0.75F,
      .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .pdc_delay_frames = before},
    {.id = 3, .from_node_id = 2, .to_node_id = 3, .gain = edited_signal ? 1.0F : 0.0F,
      .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER},
  }};
  nodes[1].keep_latency = keep_latency ? 1u : 0u;
  prepare_graph(core, 1, nodes.data(), nodes.size(), edges.data(), edges.size());
  const daw_audio_transport_state transport{.epoch = 1, .running = 1, .tempo_bpm = 120.0,
    .time_signature_numerator = 4, .time_signature_denominator = 4};
  expect(daw_audio_core_set_transport(core, &transport), DAW_AUDIO_CORE_OK);
  std::array<float, 8192> left{};
  std::array<float, 8192> right{};
  std::array<float, 8192> zero{};
  std::array<float, 8192> second_right{};
  std::array<float, 8192> output_left{};
  std::array<float, 8192> output_right{};
  const float *inputs[]{left.data(), right.data(), zero.data(), second_right.data()};
  float *outputs[]{output_left.data(), output_right.data()};
  daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = frames, .channel_count = 2,
    .input_bus_count = 2, .inputs = inputs, .outputs = outputs, .graph_revision = 1, .transport_epoch = 1,
  };
  const auto sample = [](uint64_t frame) { return static_cast<float>(1u + (frame * 17u) % 1009u) / 8192.0F; };
  uint64_t write_frame = 0;
  double fade_nanoseconds = 0;
  uint32_t fade_blocks = 0;
  uint64_t measure_fade_until = 0;
  const auto render = [&] {
    for (uint32_t frame = 0; frame < frames; ++frame) {
      left[frame] = sample(write_frame + frame);
      right[frame] = -sample(write_frame + frame + 47u) * 0.5F;
      if (edited_signal) {
        zero[frame] = sample(write_frame + frame + 127u) * 0.25F;
        second_right[frame] = sample(write_frame + frame + 19u) * 0.125F;
      }
    }
    const auto allocations = allocation_count;
    const auto began = std::chrono::steady_clock::now();
    expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
    if (block.graph_revision == 2 && write_frame < measure_fade_until) {
      fade_nanoseconds += std::chrono::duration<double, std::nano>(std::chrono::steady_clock::now() - began).count();
      ++fade_blocks;
    }
    assert(allocation_count == allocations);
    write_frame += frames;
  };
  // Every delay at publication already has valid history, including a full-ring
  // raise. Warming the existing branch after publishing would violate the contract.
  while (write_frame < 65536u + frames * 2u) render();
  const uint64_t publication = write_frame;
  nodes[1].latency_frames = after;
  edges[0].pdc_delay_frames = after;
  edges[1].pdc_delay_frames = after;
  const daw_audio_graph_prepare_request request{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 2,
    .node_count = 3, .edge_count = 3, .nodes = nodes.data(), .edges = edges.data(),
  };
  const auto allocations = allocation_count;
  const auto prepare_began = std::chrono::steady_clock::now();
  expect(daw_audio_core_prepare_graph(core, &request), DAW_AUDIO_CORE_OK);
  assert(daw_audio_core_prepared_graph_continuity(core) == 1);
  expect(daw_audio_core_publish(core, 2), DAW_AUDIO_CORE_OK);
  const double prepare_microseconds = std::chrono::duration<double, std::micro>(
    std::chrono::steady_clock::now() - prepare_began).count();
  assert(allocation_count == allocations);
  block.graph_revision = 2;
  const uint32_t fade = std::max(1u, static_cast<uint32_t>((static_cast<uint64_t>(rate) * 5u + 500u) / 1000u));
  const uint64_t seam = publication + fade;
  measure_fade_until = publication + fade * 2u;
  bool queued = false;
  while (write_frame < seam + fade + std::max(before, after) + frames * 2u) {
    const uint64_t start = write_frame;
    render();
    for (uint32_t frame = 0; frame < frames; ++frame) {
      const uint64_t absolute = start + frame;
      const bool raise = after > before;
      const uint32_t delay = keep_latency ? 0u : raise && absolute >= seam ? after : before;
      float gain = 1.0F;
      if (!keep_latency && raise && absolute < seam) gain = static_cast<float>(seam - absolute) / fade;
      else if (!keep_latency && raise && absolute < seam + fade) gain = static_cast<float>(absolute - seam) / fade;
      float second_left = 0.0F, second_r = 0.0F;
      if (edited_signal) {
        const uint64_t own_seam = publication + before - after;
        const float mix = absolute < own_seam ? 0.0F
          : absolute < own_seam + fade * 2u ? static_cast<float>(absolute - own_seam) / (fade * 2u) : 1.0F;
        second_left = sample(absolute + 127u) * 0.25F * (1.0F - mix)
          + sample(absolute - (before - after) + 127u) * 0.25F * mix;
        second_r = sample(absolute + 19u) * 0.125F * (1.0F - mix)
          + sample(absolute - (before - after) + 19u) * 0.125F * mix;
      }
      const float expected_left = (sample(absolute - delay) + second_left) * gain;
      const float expected_right = (-sample(absolute - delay + 47u) * 0.5F + second_r) * gain;
      // All frames are checked, explicitly including S-1, S and S+1, and the
      // exact time at which the fade ends. No exclusion window hides the move.
      if (output_left[frame] != expected_left || output_right[frame] != expected_right) {
        std::fprintf(stderr, "phase4 PCM rate=%u block=%u before=%u after=%u frame=%llu seam=%llu actual=%g/%g expected=%g/%g\n",
          rate, frames, before, after, static_cast<unsigned long long>(absolute),
          static_cast<unsigned long long>(seam), output_left[frame], output_right[frame],
          expected_left, expected_right);
        assert(false);
      }
    }
    if (overlap && !queued) {
      nodes[1].latency_frames = after + 1024u;
      edges[0].pdc_delay_frames = edges[1].pdc_delay_frames = after + 1024u;
      daw_audio_graph_prepare_request later = request;
      later.graph_revision = 3;
      expect(daw_audio_core_prepare_graph(core, &later), DAW_AUDIO_CORE_OK);
      expect(daw_audio_core_publish(core, 3), DAW_AUDIO_CORE_LATENCY_MOVE_PENDING);
      const auto transition = daw::audio_core::InspectLatencyTransition(core);
      assert(transition.revision == 2 && transition.completed_revision < 2);
      queued = true;
    }
  }
  if (overlap) {
    assert(daw::audio_core::InspectLatencyTransition(core).completed_revision == 2);
    expect(daw_audio_core_publish(core, 3), DAW_AUDIO_CORE_OK);
    block.graph_revision = 3;
    const uint64_t second_seam = write_frame + fade;
    while (write_frame < second_seam + fade + frames) {
      const uint64_t start = write_frame;
      render();
      for (uint32_t frame = 0; frame < frames; ++frame) {
        const uint64_t absolute = start + frame;
        const uint32_t delay = absolute >= second_seam ? after + 1024u : after;
        const float gain = absolute < second_seam ? static_cast<float>(second_seam - absolute) / fade
          : absolute < second_seam + fade ? static_cast<float>(absolute - second_seam) / fade : 1.0F;
        assert(output_left[frame] == sample(absolute - delay) * gain);
        assert(output_right[frame] == -sample(absolute - delay + 47u) * 0.5F * gain);
      }
    }
  }
  daw_audio_transport_state stopped = transport;
  stopped.running = 0;
  expect(daw_audio_core_set_transport(core, &stopped), DAW_AUDIO_CORE_OK);
  assert(daw::audio_core::InspectLatencyTransition(core).budget == (keep_latency ? 0u : overlap ? after + 1024u : after));
  expect(daw_audio_core_set_transport(core, &transport), DAW_AUDIO_CORE_OK);
  if (!overlap) {
    const uint64_t start = write_frame;
    render();
    const uint32_t delay = keep_latency ? 0u : after;
    for (uint32_t frame = 0; frame < frames; ++frame) {
      assert(output_left[frame] == sample(start + frame - delay)
        + (edited_signal ? sample(start + frame + 127u) * 0.25F : 0.0F));
      assert(output_right[frame] == -sample(start + frame - delay + 47u) * 0.5F
        + (edited_signal ? sample(start + frame + 19u) * 0.125F : 0.0F));
    }
  }
  std::printf("phase4 PCM rate=%u block=%u before=%u after=%u keep=%u samples=exact prepare_publish=%.3f us fade_blocks=%u mean_fade_block=%.3f us total_fade_callbacks=%.3f us\n",
    rate, frames, before, after, keep_latency ? 1u : 0u, prepare_microseconds, fade_blocks,
    fade_nanoseconds / fade_blocks / 1000.0, fade_nanoseconds / 1000.0);
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

void test_same_core_processor_state_patch_preserves_revision() {
  const std::array<daw_audio_graph_node_descriptor, 2> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const daw_audio_graph_edge_descriptor edge{
    .id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F,
    .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0,
  };
  std::array<std::uint8_t, 40> state{};
  const auto write_u32 = [&state](std::uint32_t offset, std::uint32_t value) {
    state[offset] = static_cast<std::uint8_t>(value);
    state[offset + 1] = static_cast<std::uint8_t>(value >> 8U);
    state[offset + 2] = static_cast<std::uint8_t>(value >> 16U);
    state[offset + 3] = static_cast<std::uint8_t>(value >> 24U);
  };
  const auto write_f32 = [&write_u32](std::uint32_t offset, float value) {
    std::uint32_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    write_u32(offset, bits);
  };
  write_u32(0, 1);
  write_f32(4, 0.0F);
  write_u32(8, DAW_AUDIO_UTILITY_POLARITY_NORMAL);
  write_u32(12, DAW_AUDIO_UTILITY_INPUT_MODE_STEREO);
  write_f32(16, 0.0F);
  write_f32(20, 0.0F);
  write_f32(24, 1.0F);
  write_u32(28, DAW_AUDIO_UTILITY_MATRIX_STEREO);
  write_u32(32, 0);
  write_u32(36, 0);
  const std::array<uint32_t, 3> targets{4, 1, 2};
  const daw_audio_processor_descriptor processor{
    .node_id = 2, .instance_id = 77, .kind = DAW_AUDIO_PROCESSOR_KIND_UTILITY,
    .state_version = 1, .state_size = static_cast<std::uint32_t>(state.size()), .bypassed = 0,
    .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .latency_frames = 0, .tail_frames = 0, .parameter_count = static_cast<uint32_t>(targets.size()),
    .parameter_targets = targets.data(), .state = state.data(),
  };
  daw_audio_core_handle core = create_core(8, 2, 1);
  const daw_audio_graph_prepare_request request{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 9, .node_count = 2,
    .edge_count = 1, .processor_count = 1, .nodes = nodes.data(), .edges = &edge, .processors = &processor,
  };
  expect(daw_audio_core_prepare_graph(core, &request), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_publish(core, 9), DAW_AUDIO_CORE_OK);
  std::array<float, 8> input_left{}; std::array<float, 8> input_right{};
  input_left[0] = 1.0F; input_right[0] = 1.0F;
  const float *inputs[]{input_left.data(), input_right.data()};
  std::array<float, 8> output_left{}; std::array<float, 8> output_right{};
  float *outputs[]{output_left.data(), output_right.data()};
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 1, .channel_count = 2,
    .input_bus_count = 1, .inputs = inputs, .outputs = outputs, .graph_revision = 9,
  };
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(std::abs(output_left[0] - 1.0F) < 1e-5F);
  write_f32(4, 6.0F);
  const daw_audio_processor_state_patch patch{
    .graph_revision = 9, .node_id = 2, .instance_id = 77, .kind = DAW_AUDIO_PROCESSOR_KIND_UTILITY,
    .state_version = 1, .state_size = static_cast<std::uint32_t>(state.size()), .bypassed = 0,
    .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .parameter_count = static_cast<uint32_t>(targets.size()), .latency_frames = 0, .tail_frames = 96'960,
    .parameter_targets = targets.data(), .state = state.data(),
  };
  expect(daw_audio_core_stage_processor_state_patch(core, &patch), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_stage_processor_state_patch(core, &patch), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_stage_processor_state_patch(core, &patch), DAW_AUDIO_CORE_CAPACITY_EXCEEDED);
  expect(daw_audio_core_apply_staged_processor_state_patch(core), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_apply_staged_processor_state_patch(core), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_apply_staged_processor_state_patch(core), DAW_AUDIO_CORE_NO_DATA);
  assert(std::abs(output_left[0] - 1.0F) < 1e-5F);
  output_left.fill(0.0F); output_right.fill(0.0F);
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(output_left[0] > 1.9F && output_left[0] < 2.1F);

  const std::array<uint32_t, 3> different_targets{4, 1, 3};
  daw_audio_processor_state_patch different_patch = patch;
  different_patch.parameter_targets = different_targets.data();
  expect(daw_audio_core_stage_processor_state_patch(core, &different_patch), DAW_AUDIO_CORE_STALE_REVISION);

  daw_audio_graph_prepare_request next_request = request;
  next_request.graph_revision = 10;
  expect(daw_audio_core_prepare_graph(core, &next_request), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_publish(core, 10), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_stage_processor_state_patch(core, &patch), DAW_AUDIO_CORE_STALE_REVISION);
  daw_audio_processor_state_patch next_patch = patch;
  next_patch.graph_revision = 10;
  expect(daw_audio_core_stage_processor_state_patch(core, &next_patch), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_apply_staged_processor_state_patch(core), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_stage_processor_state_patch(core, &next_patch), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_cancel_staged_processor_state_patch(core), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_apply_staged_processor_state_patch(core), DAW_AUDIO_CORE_NO_DATA);
  daw_audio_core_destroy(core);
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
  // The second instance is born bypassed in the graph's first plan: nothing was
  // sounding to ramp away from, so it passes its input dry from the first sample
  // instead of flashing its processed (inverted-input) signal (Checkpoint 37).
  assert(std::abs(output_left[0] - 0.1F) <= 1e-6F);
  assert(std::abs(output_right[0] - 0.1F) <= 1e-6F);

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
  std::array<uint32_t, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS + 1> oversized_targets{};
  for (uint32_t index = 0; index < oversized_targets.size(); ++index) {
    oversized_targets[index] = DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB;
  }
  daw_audio_processor_descriptor too_many_targets = processor;
  too_many_targets.parameter_count = static_cast<uint32_t>(oversized_targets.size());
  too_many_targets.parameter_targets = oversized_targets.data();
  daw_audio_graph_prepare_request too_many_targets_request = request;
  too_many_targets_request.graph_revision = 2;
  too_many_targets_request.processors = &too_many_targets;
  expect(daw_audio_core_prepare_graph(core, &too_many_targets_request), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  daw_audio_processor_descriptor null_targets = processor;
  null_targets.parameter_count = 1;
  null_targets.parameter_targets = nullptr;
  daw_audio_graph_prepare_request null_targets_request = request;
  null_targets_request.graph_revision = 2;
  null_targets_request.processors = &null_targets;
  expect(daw_audio_core_prepare_graph(core, &null_targets_request), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  const std::array<uint32_t, 2> duplicate_targets{
    DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB,
    DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB,
  };
  daw_audio_processor_descriptor duplicate_targets_descriptor = processor;
  duplicate_targets_descriptor.parameter_count = static_cast<uint32_t>(duplicate_targets.size());
  duplicate_targets_descriptor.parameter_targets = duplicate_targets.data();
  daw_audio_graph_prepare_request duplicate_targets_request = request;
  duplicate_targets_request.graph_revision = 2;
  duplicate_targets_request.processors = &duplicate_targets_descriptor;
  expect(daw_audio_core_prepare_graph(core, &duplicate_targets_request), DAW_AUDIO_CORE_INVALID_ARGUMENT);
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
  std::array<uint8_t, 36> lofi_state{};
  const auto write_lofi_u32 = [&lofi_state](uint32_t offset, uint32_t value) {
    lofi_state[offset] = static_cast<uint8_t>(value);
    lofi_state[offset + 1] = static_cast<uint8_t>(value >> 8u);
    lofi_state[offset + 2] = static_cast<uint8_t>(value >> 16u);
    lofi_state[offset + 3] = static_cast<uint8_t>(value >> 24u);
  };
  const auto write_lofi_f32 = [&lofi_state, &write_lofi_u32](uint32_t offset, float value) {
    uint32_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    write_lofi_u32(offset, bits);
  };
  write_lofi_u32(0, 1);
  write_lofi_u32(4, 12);
  write_lofi_f32(8, 0.5F);
  write_lofi_f32(12, 0.2F);
  write_lofi_f32(16, -60.0F);
  write_lofi_u32(20, DAW_AUDIO_LOFI_QUANTIZATION_ROUND);
  write_lofi_u32(24, DAW_AUDIO_LOFI_DITHER_TRIANGULAR);
  write_lofi_f32(28, 1.0F);
  write_lofi_u32(32, 123);
  const std::array<uint32_t, 5> lofi_targets{41, 42, 43, 44, 131};
  const daw_audio_processor_descriptor lofi{
    .node_id = 2, .instance_id = 44, .kind = DAW_AUDIO_PROCESSOR_KIND_LOFI,
    .state_version = 1, .state_size = static_cast<uint32_t>(lofi_state.size()), .bypassed = 0,
    .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .latency_frames = 0, .tail_frames = 0, .parameter_count = static_cast<uint32_t>(lofi_targets.size()),
    .parameter_targets = lofi_targets.data(), .state = lofi_state.data(),
  };
  daw_audio_graph_prepare_request lofi_request = request;
  lofi_request.graph_revision = 3;
  lofi_request.processors = &lofi;
  expect(daw_audio_core_prepare_graph(core, &lofi_request), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_publish(core, 3), DAW_AUDIO_CORE_OK);
  const std::array<float, 1> lofi_input{0.25F};
  const float *lofi_inputs[]{lofi_input.data(), lofi_input.data()};
  std::array<float, 1> lofi_left{};
  std::array<float, 1> lofi_right{};
  float *lofi_outputs[]{lofi_left.data(), lofi_right.data()};
  const daw_audio_processor_event nonintegral_bit_depth{
    .processor_instance_id = 44, .parameter_target = 131, .frame_offset = 0, .value = 12.5F,
  };
  daw_audio_core_process_block lofi_process{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 1, .channel_count = 2,
    .input_bus_count = 1, .inputs = lofi_inputs, .outputs = lofi_outputs, .graph_revision = 3,
    .event_count = 1, .events = &nonintegral_bit_depth,
  };
  expect(daw_audio_core_process(core, &lofi_process), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  const daw_audio_processor_event out_of_range_bit_depth{
    .processor_instance_id = 44, .parameter_target = 131, .frame_offset = 0, .value = 25.0F,
  };
  lofi_process.events = &out_of_range_bit_depth;
  expect(daw_audio_core_process(core, &lofi_process), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  const daw_audio_processor_event valid_bit_depth{
    .processor_instance_id = 44, .parameter_target = 131, .frame_offset = 0, .value = 16.0F,
  };
  lofi_process.events = &valid_bit_depth;
  expect(daw_audio_core_process(core, &lofi_process), DAW_AUDIO_CORE_OK);
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
  // Bypass moves to the dry signal over the shared 10 ms ramp, then is exactly dry.
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(std::abs(saturated_left[0] - left[0]) > 0.05F);
  for (uint32_t index = 0; index < 8; ++index) expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
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

void test_eight_delay_fallback_releases_retirement_slots_and_tails() {
  constexpr uint32_t kDelayCount = 8;
  const auto nodes_for = [] {
    std::array<daw_audio_graph_node_descriptor, 9> nodes{};
    for (uint32_t index = 0; index < kDelayCount; ++index) {
      nodes[index] = {
        .id = index + 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE,
        .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
        .input_bus = 0, .latency_frames = 0,
      };
    }
    nodes[kDelayCount] = {
      .id = 9, .kind = DAW_AUDIO_GRAPH_NODE_MASTER,
      .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .input_bus = 0, .latency_frames = 0,
    };
    return nodes;
  };
  const auto edges_for = [] {
    std::array<daw_audio_graph_edge_descriptor, kDelayCount> edges{};
    for (uint32_t index = 0; index < kDelayCount; ++index) {
      edges[index] = {
        .id = index + 1, .from_node_id = index + 1, .to_node_id = 9,
        .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0,
      };
    }
    return edges;
  };
  std::array<std::array<uint8_t, 32>, kDelayCount> states{};
  const auto write_u32 = [](std::array<uint8_t, 32> &state, const uint32_t offset, const uint32_t value) {
    state[offset] = static_cast<uint8_t>(value);
    state[offset + 1] = static_cast<uint8_t>(value >> 8u);
    state[offset + 2] = static_cast<uint8_t>(value >> 16u);
    state[offset + 3] = static_cast<uint8_t>(value >> 24u);
  };
  const auto write_f32 = [&write_u32](std::array<uint8_t, 32> &state, const uint32_t offset, const float value) {
    uint32_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    write_u32(state, offset, bits);
  };
  for (auto &state : states) {
    write_u32(state, 0, 1);
    write_f32(state, 4, 10.0F);
    write_f32(state, 8, 0.5F);
    write_f32(state, 12, 1.0F);
    write_u32(state, 16, 1);
    write_u32(state, 20, 1);
    write_f32(state, 24, 120.0F);
    write_f32(state, 28, 8000.0F);
  }
  auto nodes = nodes_for();
  const auto edges = edges_for();
  std::array<daw_audio_processor_descriptor, kDelayCount> processors{};
  for (uint32_t index = 0; index < kDelayCount; ++index) {
    processors[index] = {
      .node_id = index + 1, .instance_id = index + 1, .kind = DAW_AUDIO_PROCESSOR_KIND_DELAY,
      .state_version = 1, .state_size = 32, .bypassed = 0,
      .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .latency_frames = 0, .tail_frames = 2400, .parameter_count = 0, .parameter_targets = nullptr,
      .state = states[index].data(),
    };
  }
  daw_audio_core_handle core = create_core(512, 2, 1);
  const auto prepare = [&](const uint32_t revision, const uint32_t processor_count) {
    const daw_audio_graph_prepare_request request{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = revision,
      .node_count = static_cast<uint32_t>(nodes.size()), .edge_count = static_cast<uint32_t>(edges.size()),
      .processor_count = processor_count, .nodes = nodes.data(), .edges = edges.data(),
      .processors = processor_count == 0 ? nullptr : processors.data(),
    };
    expect(daw_audio_core_prepare_graph(core, &request), DAW_AUDIO_CORE_OK);
  };
  prepare(1, kDelayCount);
  expect(daw_audio_core_publish(core, 1), DAW_AUDIO_CORE_OK);
  std::array<float, 512> left{};
  std::array<float, 512> right{};
  left[0] = 1.0F;
  const float *inputs[]{left.data(), right.data()};
  std::array<float, 512> output_left{};
  std::array<float, 512> output_right{};
  float *outputs[]{output_left.data(), output_right.data()};
  daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 512, .channel_count = 2,
    .input_bus_count = 1, .inputs = inputs, .outputs = outputs, .graph_revision = 1,
  };
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  left.fill(0.0F);
  right.fill(0.0F);
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);

  for (uint32_t index = 0; index < kDelayCount; ++index) processors[index].instance_id = 100 + index;
  const daw_audio_graph_prepare_request replacement{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 2,
    .node_count = static_cast<uint32_t>(nodes.size()), .edge_count = static_cast<uint32_t>(edges.size()),
    .processor_count = kDelayCount, .nodes = nodes.data(), .edges = edges.data(), .processors = processors.data(),
  };
  expect(daw_audio_core_prepare_graph(core, &replacement), DAW_AUDIO_CORE_OK);
  daw_audio_core_handle fresh = create_core(512, 2, 1);
  expect(daw_audio_core_prepare_graph(fresh, &replacement), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_publish(fresh, 2), DAW_AUDIO_CORE_OK);
  block.graph_revision = 2;
  output_left.fill(0.0F);
  output_right.fill(0.0F);
  expect(daw_audio_core_process(fresh, &block), DAW_AUDIO_CORE_OK);
  for (const float sample : output_left) assert(std::abs(sample) <= 1e-6F);
  for (const float sample : output_right) assert(std::abs(sample) <= 1e-6F);
  daw_audio_core_destroy(fresh);
  daw_audio_core_destroy(core);
}

void test_live_delay_and_reverb_retirement_materialization() {
  const std::array<daw_audio_graph_node_descriptor, 2> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const daw_audio_graph_edge_descriptor edge{
    .id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F,
    .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0,
  };
  const auto write_u32 = [](uint8_t *state, uint32_t offset, uint32_t value) {
    state[offset] = static_cast<uint8_t>(value);
    state[offset + 1] = static_cast<uint8_t>(value >> 8u);
    state[offset + 2] = static_cast<uint8_t>(value >> 16u);
    state[offset + 3] = static_cast<uint8_t>(value >> 24u);
  };
  const auto write_f32 = [&write_u32](uint8_t *state, uint32_t offset, float value) {
    uint32_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    write_u32(state, offset, bits);
  };

  const auto run_delay = [&](uint32_t live_target, float live_value, bool expect_late_tail) {
    std::array<uint8_t, 32> state{};
    write_u32(state.data(), 0, 1);
    write_f32(state.data(), 4, 10.0F);
    write_f32(state.data(), 8, 0.5F);
    write_f32(state.data(), 12, 1.0F);
    write_u32(state.data(), 16, 1);
    write_u32(state.data(), 20, 1);
    write_f32(state.data(), 24, 120.0F);
    write_f32(state.data(), 28, 8000.0F);
    const std::array<uint32_t, 5> targets{5, 6, 7, 8, 9};
    daw_audio_processor_descriptor processor{
      .node_id = 2, .instance_id = 501, .kind = DAW_AUDIO_PROCESSOR_KIND_DELAY,
      .state_version = 1, .state_size = 32, .bypassed = 0,
      .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .latency_frames = 0, .tail_frames = 1, .parameter_count = static_cast<uint32_t>(targets.size()),
      .parameter_targets = targets.data(), .state = state.data(),
    };
    daw_audio_core_handle core = create_core(512, 2, 1);
    const daw_audio_graph_prepare_request initial{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 1, .node_count = 2, .edge_count = 1,
      .processor_count = 1, .nodes = nodes.data(), .edges = &edge, .processors = &processor,
    };
    expect(daw_audio_core_prepare_graph(core, &initial), DAW_AUDIO_CORE_OK);
    expect(daw_audio_core_publish(core, 1), DAW_AUDIO_CORE_OK);
    std::array<float, 512> left{};
    std::array<float, 512> right{};
    left[0] = 1.0F;
    const float *inputs[]{left.data(), right.data()};
    std::array<float, 512> output_left{};
    std::array<float, 512> output_right{};
    float *outputs[]{output_left.data(), output_right.data()};
    const std::array<uint32_t, 1> parameter_targets{live_target};
    const std::array<float, 1> parameter_values{live_value};
    const daw_audio_processor_parameter_block parameter_block{
      .processor_instance_id = 501, .frame_count = 1, .parameter_count = 1,
      .parameter_targets = parameter_targets.data(), .values = parameter_values.data(),
    };
    daw_audio_core_process_block block{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 512, .channel_count = 2,
      .input_bus_count = 1, .inputs = inputs, .outputs = outputs, .graph_revision = 1,
      .parameter_block_count = 1, .parameter_blocks = &parameter_block,
    };
    expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
    const daw_audio_graph_prepare_request removal{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 2, .node_count = 2, .edge_count = 1,
      .processor_count = 0, .nodes = nodes.data(), .edges = &edge, .processors = nullptr,
    };
    expect(daw_audio_core_prepare_graph(core, &removal), DAW_AUDIO_CORE_OK);
    expect(daw_audio_core_publish(core, 2), DAW_AUDIO_CORE_OK);
    block.graph_revision = 2;
    block.parameter_block_count = 0;
    block.parameter_blocks = nullptr;
    block.event_count = 0;
    block.events = nullptr;
    left.fill(0.0F);
    right.fill(0.0F);
    float late_peak = 0.0F;
    for (uint32_t block_index = 0; block_index < 32; ++block_index) {
      output_left.fill(0.0F);
      output_right.fill(0.0F);
      expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
      if (block_index >= 8) {
        for (uint32_t frame = 0; frame < 512; ++frame) {
          late_peak = std::max(late_peak, std::max(std::abs(output_left[frame]), std::abs(output_right[frame])));
        }
      }
    }
    if (expect_late_tail) assert(late_peak > 1e-5F);
    else assert(late_peak <= 1e-6F);
    daw_audio_core_destroy(core);
  };

  // A deleted processor fades out over ~5 ms and then contributes nothing, whatever live overrides it held.
  run_delay(DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_TIME_MS, 100.0F, false);
  run_delay(DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_DRY_WET, 0.0F, false);

  const auto run_reverb = [&](uint32_t live_target, float live_value, bool expect_late_tail) {
    std::array<uint8_t, 72> state{};
    write_u32(state.data(), 0, 1);
    write_f32(state.data(), 4, 1.0F);
    write_f32(state.data(), 8, 0.2F);
    write_f32(state.data(), 12, 20.0F);
    write_f32(state.data(), 16, 0.5F);
    write_u32(state.data(), 20, 1);
    write_f32(state.data(), 24, 5.0F);
    write_f32(state.data(), 28, 0.3F);
    write_f32(state.data(), 32, 0.5F);
    write_f32(state.data(), 36, 1.0F);
    write_f32(state.data(), 40, 0.5F);
    write_f32(state.data(), 44, 0.75F);
    write_f32(state.data(), 48, 0.8F);
    write_f32(state.data(), 52, 20.0F);
    write_f32(state.data(), 56, 20'000.0F);
    write_f32(state.data(), 60, 20.0F);
    write_f32(state.data(), 64, 20'000.0F);
    write_f32(state.data(), 68, 1.0F);
    const std::array<uint32_t, 16> targets{
      10, 11, 12, 13, 14, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142,
    };
    daw_audio_processor_descriptor processor{
      .node_id = 2, .instance_id = 502, .kind = DAW_AUDIO_PROCESSOR_KIND_REVERB,
      .state_version = 1, .state_size = 72, .bypassed = 0,
      .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .latency_frames = 0, .tail_frames = 1, .parameter_count = static_cast<uint32_t>(targets.size()),
      .parameter_targets = targets.data(), .state = state.data(),
    };
    daw_audio_core_handle core = create_core(512, 2, 1);
    const daw_audio_graph_prepare_request initial{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 1, .node_count = 2, .edge_count = 1,
      .processor_count = 1, .nodes = nodes.data(), .edges = &edge, .processors = &processor,
    };
    expect(daw_audio_core_prepare_graph(core, &initial), DAW_AUDIO_CORE_OK);
    expect(daw_audio_core_publish(core, 1), DAW_AUDIO_CORE_OK);
    std::array<float, 512> left{};
    std::array<float, 512> right{};
    left[0] = 1.0F;
    const float *inputs[]{left.data(), right.data()};
    std::array<float, 512> output_left{};
    std::array<float, 512> output_right{};
    float *outputs[]{output_left.data(), output_right.data()};
    const std::array<uint32_t, 1> parameter_targets{live_target};
    const std::array<float, 1> parameter_values{live_value};
    const daw_audio_processor_parameter_block parameter_block{
      .processor_instance_id = 502, .frame_count = 1, .parameter_count = 1,
      .parameter_targets = parameter_targets.data(), .values = parameter_values.data(),
    };
    daw_audio_core_process_block block{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 512, .channel_count = 2,
      .input_bus_count = 1, .inputs = inputs, .outputs = outputs, .graph_revision = 1,
      .parameter_block_count = 1, .parameter_blocks = &parameter_block,
    };
    expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
    const daw_audio_graph_prepare_request removal{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 2, .node_count = 2, .edge_count = 1,
      .processor_count = 0, .nodes = nodes.data(), .edges = &edge, .processors = nullptr,
    };
    expect(daw_audio_core_prepare_graph(core, &removal), DAW_AUDIO_CORE_OK);
    expect(daw_audio_core_publish(core, 2), DAW_AUDIO_CORE_OK);
    block.graph_revision = 2;
    block.parameter_block_count = 0;
    block.parameter_blocks = nullptr;
    block.event_count = 0;
    block.events = nullptr;
    left.fill(0.0F);
    right.fill(0.0F);
    float late_peak = 0.0F;
    for (uint32_t block_index = 0; block_index < 64; ++block_index) {
      output_left.fill(0.0F);
      output_right.fill(0.0F);
      expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
      if (block_index >= 16) {
        for (uint32_t frame = 0; frame < 512; ++frame) {
          late_peak = std::max(late_peak, std::max(std::abs(output_left[frame]), std::abs(output_right[frame])));
        }
      }
    }
    if (expect_late_tail) assert(late_peak > 1e-8F);
    else {
      assert(late_peak <= 1e-6F);
      std::array<daw_audio_processor_descriptor, 8> replacements{};
      for (uint32_t index = 0; index < replacements.size(); ++index) {
        replacements[index] = processor;
        replacements[index].instance_id = 600 + index;
      }
      const daw_audio_graph_prepare_request replacement{
        .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 3, .node_count = 2, .edge_count = 1,
        .processor_count = static_cast<uint32_t>(replacements.size()), .nodes = nodes.data(), .edges = &edge,
        .processors = replacements.data(),
      };
      expect(daw_audio_core_prepare_graph(core, &replacement), DAW_AUDIO_CORE_OK);
      expect(daw_audio_core_publish(core, 3), DAW_AUDIO_CORE_OK);
    }
    daw_audio_core_destroy(core);
  };

  run_reverb(DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DECAY_SEC, 2.0F, false);
  run_reverb(DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_WET, 0.0F, false);
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
    // Disabling a stage is a bypass, never a restructure: the capture it holds is
    // still there when it is switched back on (an FFT size change below does reset it).
    assert(peak(output_left, 512) > 1e-5F);
    publish_lifecycle(6, DAW_AUDIO_SPECTRAL_MODE_FREEZE, 1, 1024);
    render_lifecycle(6);
    assert(peak(output_left, 1024) == 0.0F);
    daw_audio_core_destroy(lifecycle_core);
  }
  daw_audio_core_handle capacity_core = create_core(64, 2, 1);
  std::array<daw_audio_graph_node_descriptor, 2> capacity_nodes{{nodes[0], nodes[2]}};
  capacity_nodes[1].latency_frames = 512 * (DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE + 1);
  const std::array<daw_audio_graph_edge_descriptor, 1> capacity_edges{{
    {.id = 1, .from_node_id = 1, .to_node_id = 3, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0},
  }};
  std::array<std::array<uint8_t, 60>, DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE + 1> states{};
  std::array<daw_audio_processor_descriptor, DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE + 1> processors{};
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

void test_same_core_prepared_graph_can_be_cancelled() {
  const daw_audio_core_handle core = create_core(64, 2, 1);
  const daw_audio_core_prepare_request initial{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .graph_revision = 1,
    .reserved0 = 0,
    .reserved1 = 0,
  };
  expect(daw_audio_core_prepare(core, &initial), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_publish(core, 1), DAW_AUDIO_CORE_OK);
  const daw_audio_core_prepare_request staged{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .graph_revision = 2,
    .reserved0 = 0,
    .reserved1 = 0,
  };
  expect(daw_audio_core_prepare(core, &staged), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_cancel_prepared_graph(core, 2), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_publish(core, 2), DAW_AUDIO_CORE_STALE_REVISION);
  daw_audio_core_destroy(core);
}

void test_incompatible_continuity_prepare_does_not_consume_reset_state() {
  daw_audio_core_handle core = create_core(4, 2, 1);
  const std::array<daw_audio_graph_node_descriptor, 2> initial_nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const daw_audio_graph_edge_descriptor initial_edge{
    .id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F,
    .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0,
  };
  prepare_graph(core, 1, initial_nodes.data(), initial_nodes.size(), &initial_edge, 1);
  // Native latency edits keep the source runtime; portable callers retain their
  // compatibility verdict until their own seam publication is implemented.
  auto delayed_source = initial_nodes[0];
  delayed_source.input_bus = 1;
  delayed_source.external_latency_frames = 4;
  const std::array<daw_audio_graph_node_descriptor, 3> incompatible_nodes{{
    delayed_source,
    {.id = 3, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 1, .latency_frames = 0},
    initial_nodes[1],
  }};
  const std::array<daw_audio_graph_edge_descriptor, 2> incompatible_edges{{
    initial_edge,
    {.id = 2, .from_node_id = 3, .to_node_id = 2, .gain = 1.0F,
      .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 4},
  }};
  const daw_audio_graph_prepare_request request{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 2,
    .node_count = static_cast<uint32_t>(incompatible_nodes.size()),
    .edge_count = static_cast<uint32_t>(incompatible_edges.size()),
    .nodes = incompatible_nodes.data(), .edges = incompatible_edges.data(),
  };
  expect(daw_audio_core_prepare_graph(core, &request), DAW_AUDIO_CORE_OK);
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  assert(daw_audio_core_prepared_graph_continuity(core) == 1);
#else
  assert(daw_audio_core_prepared_graph_continuity(core) == 0);
#endif
  expect(daw_audio_core_publish(core, 2), DAW_AUDIO_CORE_OK);
  const std::array<float, 1> left_one{1.0F};
  const std::array<float, 1> right_one{0.5F};
  const float *inputs[]{left_one.data(), right_one.data(), left_one.data(), right_one.data()};
  std::array<float, 1> output_left{};
  std::array<float, 1> output_right{};
  float *outputs[]{output_left.data(), output_right.data()};
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 1, .channel_count = 2,
    .input_bus_count = 2, .inputs = inputs, .outputs = outputs, .graph_revision = 2,
  };
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(std::isfinite(output_left[0]) && std::isfinite(output_right[0]));
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

void test_mapped_asset_retains_wide_frame_ranges() {
  daw_audio_core_handle core = create_core(8, 1, 1);
  publish(core, 1);
  const float sample = 0.25F;
  const float *planes[]{&sample};
  const std::uint64_t frame_count = static_cast<std::uint64_t>(UINT32_MAX) + 17;
  const daw_audio_mapped_asset_descriptor descriptor{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .revision = 9,
    .byte_length = frame_count * sizeof(float),
    .content_hash_prefix = 0,
    .frame_count = frame_count,
    .sample_rate_hz = 48000,
    .channel_count = 1,
    .planes = planes,
  };
  daw_audio_asset_handle asset = 0;
  expect(daw_audio_core_create_mapped_asset(core, &descriptor, &asset), DAW_AUDIO_CORE_OK);
  uint32_t revision = 0;
  expect(daw_audio_core_get_asset_revision(core, asset, &revision), DAW_AUDIO_CORE_OK);
  assert(revision == descriptor.revision);

  const daw_audio_transport_state transport{.epoch = 1, .running = 1, .frame = 0};
  expect(daw_audio_core_set_transport(core, &transport), DAW_AUDIO_CORE_OK);
  const daw_audio_sample_source_event event{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .epoch = 1,
    .sequence = 1,
    .asset = asset,
    .start_frame = 0,
    .stop_frame = 1,
    .source_offset_frame = static_cast<std::uint64_t>(UINT32_MAX) + 1,
    .source_frame_count = 1,
    .gain = 1.0F,
    .fade_in_start_frame = 0,
    .fade_in_end_frame = 0,
    .fade_out_start_frame = 1,
    .fade_out_end_frame = 1,
  };
  expect(daw_audio_core_schedule_sample_source(core, &event), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_release_asset(core, asset), DAW_AUDIO_CORE_ASSET_IN_USE);

  const daw_audio_transport_state next_epoch{.epoch = 2, .running = 0, .frame = 0};
  expect(daw_audio_core_set_transport(core, &next_epoch), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_release_asset(core, asset), DAW_AUDIO_CORE_OK);
  daw_audio_core_destroy(core);
}

void test_wasm_planar_preserves_requested_eager_channels() {
  expect(daw_audio_core_wasm_graph_initialize_planar(48000, 4, 1, 3, 2), DAW_AUDIO_CORE_OK);
  std::array<uint8_t, 128> graph{};
  const auto write_u32 = [&graph](std::size_t offset, uint32_t value) {
    graph[offset] = static_cast<uint8_t>(value);
    graph[offset + 1] = static_cast<uint8_t>(value >> 8u);
    graph[offset + 2] = static_cast<uint8_t>(value >> 16u);
    graph[offset + 3] = static_cast<uint8_t>(value >> 24u);
  };
  const auto write_u64 = [&write_u32](std::size_t offset, uint64_t value) {
    write_u32(offset, static_cast<uint32_t>(value));
    write_u32(offset + 4, static_cast<uint32_t>(value >> 32u));
  };
  write_u32(0, 1);
  write_u32(4, 1);
  write_u32(8, 2);
  write_u32(12, 1);
  write_u32(16, 0);
  write_u64(24, 1);
  write_u32(32, DAW_AUDIO_GRAPH_NODE_SOURCE);
  write_u32(36, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
  write_u32(40, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
  write_u32(44, 0);
  write_u64(52, 2);
  write_u32(60, 6);
  write_u32(64, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
  write_u32(68, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
  write_u32(72, 0);
  write_u64(80, 3);
  write_u64(88, 1);
  write_u64(96, 2);
  write_u64(104, 0);
  write_u32(112, 0x3f800000);
  write_u32(116, DAW_AUDIO_GRAPH_EDGE_POST_FADER);

  expect(daw_audio_core_wasm_graph_prepare(graph.data(), graph.size()), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_wasm_graph_publish(1), DAW_AUDIO_CORE_OK);

  const std::array<float, 1> eager_left{0.25F};
  const std::array<float, 1> eager_right{-0.5F};
  const std::array<float, 1> eager_third{3.0F};
  const float *eager_planes[]{eager_left.data(), eager_right.data(), eager_third.data()};
  daw_audio_asset_handle asset = 0;
  expect(daw_audio_core_wasm_graph_register_pcm_asset(
    1, 48000, 3, eager_planes, &asset), DAW_AUDIO_CORE_OK);

  daw_audio_asset_handle rejected_paged_asset = 0;
  expect(daw_audio_core_wasm_graph_create_paged_asset(
    1, 48000, 3, &rejected_paged_asset), DAW_AUDIO_CORE_INVALID_ARGUMENT);

  expect(daw_audio_core_wasm_graph_set_transport(1, 1, 0), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_wasm_graph_schedule_sample_source(
    1, 1, 1, asset, 0, 1, 0, 1, 1.0F, 0, 0, 1, 1, 0.0F, 0.0F, 0.5F, 0.0F, 0.5F), DAW_AUDIO_CORE_OK);
  const std::array<float, 1> input_left{};
  const std::array<float, 1> input_right{};
  const std::array<float, 1> input_third{};
  const float *inputs[]{input_left.data(), input_right.data(), input_third.data()};
  std::array<float, 1> output_left{};
  std::array<float, 1> output_right{};
  std::array<float, 1> output_third{};
  float *outputs[]{output_left.data(), output_right.data(), output_third.data()};
  expect(daw_audio_core_wasm_graph_process_planar(
    1, 1, 3, inputs, outputs, 1, nullptr, 0, nullptr, 0, nullptr, 0), DAW_AUDIO_CORE_OK);
  assert(output_left[0] == 0.25F && output_right[0] == -0.5F && output_third[0] == -0.5F);
  expect(daw_audio_core_wasm_graph_set_transport(2, 0, 0), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_wasm_graph_release_asset(asset), DAW_AUDIO_CORE_OK);
}

void test_paged_asset_pool_preparation_and_rendering() {
  daw_audio_core_handle core = create_core(8, 2, 4);
  const daw_audio_paged_asset_config config{
    .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
    .page_frames = 4,
    .slot_count = 3,
    .max_channels = 2,
  };
  expect(daw_audio_core_configure_paged_assets(core, &config), DAW_AUDIO_CORE_OK);
  const daw_audio_paged_asset_descriptor descriptor{
    .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
    .revision = 1,
    .byte_length = 10u * 2u * sizeof(float),
    .content_hash_prefix = 0,
    .frame_count = 10,
    .sample_rate_hz = 48000,
    .channel_count = 2,
  };
  daw_audio_asset_handle asset = 0;
  expect(daw_audio_core_create_paged_asset(core, &descriptor, &asset), DAW_AUDIO_CORE_OK);
  const std::array<float, 4> page_left{1.0F, 2.0F, 3.0F, 4.0F};
  const std::array<float, 4> page_right{-1.0F, -2.0F, -3.0F, -4.0F};
  const float *page_planes[]{page_left.data(), page_right.data()};
  const daw_audio_paged_asset_page_write page_write{
    .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
    .asset = asset,
    .page_index = 0,
    .valid_frames = 4,
    .channel_count = 2,
    .planes = page_planes,
  };
  expect(daw_audio_core_write_paged_asset_page(core, &page_write), DAW_AUDIO_CORE_OK);
  const daw_audio_paged_asset_prepare_request missing_request{
    .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
    .asset = asset,
    .source_offset_frame = 0,
    .source_frame_count = 8,
    .interpolation_guard_frames = 1,
  };
  daw_audio_paged_preparation_handle preparation = 0;
  uint64_t first_missing_page = 0;
  expect(daw_audio_core_prepare_paged_asset(
    core, &missing_request, &preparation, &first_missing_page), DAW_AUDIO_CORE_NO_DATA);
  assert(preparation == 0 && first_missing_page == 1);

  const std::array<float, 4> page_two_left{5.0F, 6.0F, 7.0F, 8.0F};
  const std::array<float, 4> page_two_right{-5.0F, -6.0F, -7.0F, -8.0F};
  const float *page_two_planes[]{page_two_left.data(), page_two_right.data()};
  const daw_audio_paged_asset_page_write page_two_write{
    .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
    .asset = asset,
    .page_index = 1,
    .valid_frames = 4,
    .channel_count = 2,
    .planes = page_two_planes,
  };
  expect(daw_audio_core_write_paged_asset_page(core, &page_two_write), DAW_AUDIO_CORE_OK);
  const std::array<float, 2> tail_left{9.0F, 10.0F};
  const std::array<float, 2> tail_right{-9.0F, -10.0F};
  const float *tail_planes[]{tail_left.data(), tail_right.data()};
  const daw_audio_paged_asset_page_write tail_write{
    .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
    .asset = asset,
    .page_index = 2,
    .valid_frames = 2,
    .channel_count = 2,
    .planes = tail_planes,
  };
  expect(daw_audio_core_write_paged_asset_page(core, &tail_write), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_prepare_paged_asset(
    core, &missing_request, &preparation, &first_missing_page), DAW_AUDIO_CORE_OK);
  assert(preparation != 0);
  assert(daw_audio_core_write_paged_asset_page(core, &page_write) == DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_trim_paged_asset(core, asset, 1, 1), DAW_AUDIO_CORE_ASSET_IN_USE);

  publish(core, 1);
  const daw_audio_transport_state transport{.epoch = 1, .running = 1, .frame = 0};
  expect(daw_audio_core_set_transport(core, &transport), DAW_AUDIO_CORE_OK);
  const daw_audio_paged_sample_source_event event{
    .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
    .epoch = 1,
    .sequence = 1,
    .source_node_id = 0,
    .preparation = preparation,
    .start_frame = 0,
    .stop_frame = 3,
    .source_offset_frame = 3,
    .source_frame_count = 3,
    .source_offset_fraction = 0.0F,
    .gain = 1.0F,
    .fade_in_start_frame = 0,
    .fade_in_end_frame = 0,
    .fade_out_start_frame = 3,
    .fade_out_end_frame = 3,
  };
  expect(daw_audio_core_schedule_prepared_sample_source(core, &event), DAW_AUDIO_CORE_OK);
  std::array<float, 3> left{};
  std::array<float, 3> right{};
  float *outputs[]{left.data(), right.data()};
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .frame_count = 3,
    .channel_count = 2,
    .input_bus_count = 0,
    .inputs = nullptr,
    .outputs = outputs,
  };
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  assert(left[0] == 4.0F && left[1] == 5.0F && left[2] == 6.0F);
  assert(right[0] == -4.0F && right[1] == -5.0F && right[2] == -6.0F);
  expect(daw_audio_core_release_paged_preparation(core, preparation), DAW_AUDIO_CORE_ASSET_IN_USE);
  const daw_audio_core_process_block end_block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .frame_count = 1,
    .channel_count = 2,
    .input_bus_count = 0,
    .inputs = nullptr,
    .outputs = outputs,
  };
  expect(daw_audio_core_process(core, &end_block), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_release_paged_preparation(core, preparation), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_release_paged_preparation(core, preparation), DAW_AUDIO_CORE_INVALID_HANDLE);
  expect(daw_audio_core_release_asset(core, asset), DAW_AUDIO_CORE_OK);
  daw_audio_core_destroy(core);
}

void test_paged_asset_wide_indices_capacity_and_eof_guards() {
  {
    daw_audio_core_handle core = create_core(8, 2, 1);
    const daw_audio_paged_asset_config config{
      .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
      .page_frames = 4,
      .slot_count = 2,
      .max_channels = 2,
    };
    expect(daw_audio_core_configure_paged_assets(core, &config), DAW_AUDIO_CORE_OK);
    const std::uint64_t final_page = std::uint64_t{1} << 32;
    const std::uint64_t final_frame = final_page * config.page_frames;
    const daw_audio_paged_asset_descriptor descriptor{
      .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
      .revision = 1,
      .byte_length = (final_frame + 1) * sizeof(float),
      .content_hash_prefix = 0,
      .frame_count = final_frame + 1,
      .sample_rate_hz = 48000,
      .channel_count = 1,
    };
    daw_audio_asset_handle asset = 0;
    expect(daw_audio_core_create_paged_asset(core, &descriptor, &asset), DAW_AUDIO_CORE_OK);
    const std::array<float, 1> final_sample{7.0F};
    const float *planes[]{final_sample.data()};
    const daw_audio_paged_asset_page_write write{
      .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
      .asset = asset,
      .page_index = final_page,
      .valid_frames = 1,
      .channel_count = 1,
      .planes = planes,
    };
    expect(daw_audio_core_write_paged_asset_page(core, &write), DAW_AUDIO_CORE_OK);
    const daw_audio_paged_asset_prepare_request request{
      .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
      .asset = asset,
      .source_offset_frame = final_frame,
      .source_frame_count = 1,
      .interpolation_guard_frames = 1,
    };
    daw_audio_paged_preparation_handle preparation = 0;
    std::uint64_t first_missing_page = 0;
    expect(daw_audio_core_prepare_paged_asset(
      core, &request, &preparation, &first_missing_page), DAW_AUDIO_CORE_OK);
    expect(daw_audio_core_release_paged_preparation(core, preparation), DAW_AUDIO_CORE_OK);
    expect(daw_audio_core_release_asset(core, asset), DAW_AUDIO_CORE_OK);
    daw_audio_core_destroy(core);
  }

  {
    daw_audio_core_handle core = create_core(8, 2, 1);
    const daw_audio_paged_asset_config config{
      .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
      .page_frames = 4,
      .slot_count = 2,
      .max_channels = 2,
    };
    expect(daw_audio_core_configure_paged_assets(core, &config), DAW_AUDIO_CORE_OK);
    const daw_audio_paged_asset_descriptor descriptor{
      .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
      .revision = 1,
      .byte_length = 12u * sizeof(float),
      .content_hash_prefix = 0,
      .frame_count = 12,
      .sample_rate_hz = 48000,
      .channel_count = 1,
    };
    daw_audio_asset_handle asset = 0;
    expect(daw_audio_core_create_paged_asset(core, &descriptor, &asset), DAW_AUDIO_CORE_OK);
    const std::array<float, 4> first_page{1.0F, 2.0F, 3.0F, 4.0F};
    const std::array<float, 4> second_page{5.0F, 6.0F, 7.0F, 8.0F};
    const float *first_planes[]{first_page.data()};
    const float *second_planes[]{second_page.data()};
    const daw_audio_paged_asset_page_write first_write{
      .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
      .asset = asset,
      .page_index = 0,
      .valid_frames = 4,
      .channel_count = 1,
      .planes = first_planes,
    };
    const daw_audio_paged_asset_page_write second_write{
      .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
      .asset = asset,
      .page_index = 1,
      .valid_frames = 4,
      .channel_count = 1,
      .planes = second_planes,
    };
    expect(daw_audio_core_write_paged_asset_page(core, &first_write), DAW_AUDIO_CORE_OK);
    expect(daw_audio_core_write_paged_asset_page(core, &second_write), DAW_AUDIO_CORE_OK);
    const daw_audio_paged_asset_prepare_request request{
      .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
      .asset = asset,
      .source_offset_frame = 0,
      .source_frame_count = 9,
      .interpolation_guard_frames = 0,
    };
    daw_audio_paged_preparation_handle preparation = 0;
    std::uint64_t first_missing_page = 0;
    expect(daw_audio_core_prepare_paged_asset(
      core, &request, &preparation, &first_missing_page), DAW_AUDIO_CORE_CAPACITY_EXCEEDED);
    assert(preparation == 0 && first_missing_page == 0);
    const std::array<float, 4> replacement{9.0F, 10.0F, 11.0F, 12.0F};
    const float *replacement_planes[]{replacement.data()};
    const daw_audio_paged_asset_page_write replacement_write{
      .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
      .asset = asset,
      .page_index = 0,
      .valid_frames = 4,
      .channel_count = 1,
      .planes = replacement_planes,
    };
    expect(daw_audio_core_write_paged_asset_page(core, &replacement_write), DAW_AUDIO_CORE_OK);
    const daw_audio_paged_asset_descriptor too_many_channels{
      .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
      .revision = 1,
      .byte_length = 12u * 3u * sizeof(float),
      .content_hash_prefix = 0,
      .frame_count = 12,
      .sample_rate_hz = 48000,
      .channel_count = 3,
    };
    daw_audio_asset_handle rejected_asset = 0;
    expect(daw_audio_core_create_paged_asset(core, &too_many_channels, &rejected_asset),
      DAW_AUDIO_CORE_INVALID_ARGUMENT);
    expect(daw_audio_core_release_asset(core, asset), DAW_AUDIO_CORE_OK);
    daw_audio_core_destroy(core);
  }

  {
    daw_audio_core_handle core = create_core(8, 2, 1);
    const daw_audio_paged_asset_config config{
      .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
      .page_frames = 4,
      .slot_count = 1,
      .max_channels = 1,
    };
    expect(daw_audio_core_configure_paged_assets(core, &config), DAW_AUDIO_CORE_OK);
    const daw_audio_paged_asset_descriptor descriptor{
      .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
      .revision = 1,
      .byte_length = 4u * sizeof(float),
      .content_hash_prefix = 0,
      .frame_count = 4,
      .sample_rate_hz = 48000,
      .channel_count = 1,
    };
    daw_audio_asset_handle asset = 0;
    expect(daw_audio_core_create_paged_asset(core, &descriptor, &asset), DAW_AUDIO_CORE_OK);
    const std::array<float, 4> samples{1.0F, 2.0F, 3.0F, 4.0F};
    const float *planes[]{samples.data()};
    const daw_audio_paged_asset_page_write write{
      .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
      .asset = asset,
      .page_index = 0,
      .valid_frames = 4,
      .channel_count = 1,
      .planes = planes,
    };
    expect(daw_audio_core_write_paged_asset_page(core, &write), DAW_AUDIO_CORE_OK);
    const daw_audio_paged_asset_prepare_request request{
      .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
      .asset = asset,
      .source_offset_frame = 0,
      .source_frame_count = 4,
      .interpolation_guard_frames = 1,
    };
    daw_audio_paged_preparation_handle preparation = 0;
    std::uint64_t first_missing_page = 0;
    expect(daw_audio_core_prepare_paged_asset(
      core, &request, &preparation, &first_missing_page), DAW_AUDIO_CORE_OK);

    publish(core, 1);
    const daw_audio_transport_state transport{.epoch = 1, .running = 1, .frame = 0};
    expect(daw_audio_core_set_transport(core, &transport), DAW_AUDIO_CORE_OK);
    const daw_audio_paged_sample_source_event event{
      .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
      .epoch = 1,
      .sequence = 1,
      .source_node_id = 0,
      .preparation = preparation,
      .start_frame = 0,
      .stop_frame = 4,
      .source_offset_frame = 0,
      .source_frame_count = 4,
      .source_offset_fraction = 0.5F,
      .gain = 1.0F,
      .fade_in_start_frame = 0,
      .fade_in_end_frame = 0,
      .fade_out_start_frame = 4,
      .fade_out_end_frame = 4,
    };
    expect(daw_audio_core_schedule_prepared_sample_source(core, &event), DAW_AUDIO_CORE_OK);
    std::array<float, 4> output{};
    float *outputs[]{output.data(), output.data()};
    const daw_audio_core_process_block block{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
      .frame_count = 4,
      .channel_count = 1,
      .input_bus_count = 0,
      .inputs = nullptr,
      .outputs = outputs,
    };
    expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
    assert(output[0] == 1.5F && output[1] == 2.5F && output[2] == 3.5F && output[3] == 4.0F);
    expect(daw_audio_core_release_paged_preparation(core, preparation), DAW_AUDIO_CORE_ASSET_IN_USE);
    const daw_audio_core_process_block end_block{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
      .frame_count = 1,
      .channel_count = 1,
      .input_bus_count = 0,
      .inputs = nullptr,
      .outputs = outputs,
    };
    expect(daw_audio_core_process(core, &end_block), DAW_AUDIO_CORE_OK);
    expect(daw_audio_core_release_paged_preparation(core, preparation), DAW_AUDIO_CORE_OK);
    expect(daw_audio_core_release_asset(core, asset), DAW_AUDIO_CORE_OK);
    daw_audio_core_destroy(core);
  }
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

  const daw_audio_transport_state paused{.epoch = 1, .running = 0, .frame = 5};
  expect(daw_audio_core_set_transport(core, &paused), DAW_AUDIO_CORE_OK);
  left_output.fill(1.0F);
  right_output.fill(-1.0F);
  daw_audio_core_process_block paused_block = block;
  paused_block.frame_count = 3;
  expect(daw_audio_core_process(core, &paused_block), DAW_AUDIO_CORE_OK);
  for (uint32_t frame = 0; frame < paused_block.frame_count; ++frame) {
    assert(left_output[frame] == 0.0F && right_output[frame] == 0.0F);
  }

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

void test_sample_source_curved_fades() {
  daw_audio_core_handle core = create_core(16, 1, 1);
  publish(core, 1);
  const std::array<float, 8> samples{1.0F, 1.0F, 1.0F, 1.0F, 1.0F, 1.0F, 1.0F, 1.0F};
  const float *planes[]{samples.data()};
  const daw_audio_asset_descriptor descriptor{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .revision = 1,
    .byte_length = 32,
    .content_hash_prefix = 0,
    .frame_count = 8,
    .sample_rate_hz = 48000,
    .channel_count = 1,
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
    .start_frame = 0,
    .stop_frame = 8,
    .source_offset_frame = 0,
    .source_frame_count = 8,
    .gain = 1.0F,
    .fade_in_start_frame = 0,
    .fade_in_end_frame = 4,
    .fade_out_start_frame = 4,
    .fade_out_end_frame = 8,
    .fade_in_curve = 1.0F,
    .fade_in_curve_position = 0.25F,
    .fade_out_curve = -1.0F,
    .fade_out_curve_position = 0.75F,
  };
  expect(daw_audio_core_schedule_sample_source(core, &event), DAW_AUDIO_CORE_OK);
  std::array<float, 8> output{};
  float *outputs[]{output.data()};
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .frame_count = 8,
    .channel_count = 1,
    .input_bus_count = 0,
    .inputs = nullptr,
    .outputs = outputs,
  };
  expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
  const std::array<float, 8> expected{
    0.0F, 0.5980762F, 0.8541020F, 0.9686270F,
    1.0F, 0.6771243F, 0.3819660F, 0.1339746F,
  };
  for (uint32_t frame = 0; frame < expected.size(); ++frame) {
    assert(std::abs(output[frame] - expected[frame]) <= 1e-5F);
  }
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

void test_eq_realtime_parameter_offsets_and_persistence() {
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
  std::array<uint8_t, 200> state{};
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
  write_u32(4, 0);
  for (uint32_t index = 0; index < 8; ++index) {
    const uint32_t offset = 8 + index * 24;
    write_u32(offset, index == 0 ? 1 : 0);
    write_u32(offset + 4, DAW_AUDIO_EQ_BAND_LOWSHELF);
    write_f32(offset + 8, 1000.0F);
    write_f32(offset + 12, 0.0F);
    write_f32(offset + 16, 1.0F);
  }
  std::array<uint32_t, 24> targets{};
  for (uint32_t index = 0; index < 8; ++index) {
    targets[index * 3] = DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_FREQUENCY_HZ(index);
    targets[index * 3 + 1] = DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_GAIN_DB(index);
    targets[index * 3 + 2] = DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_Q(index);
  }
  const daw_audio_processor_descriptor processor{
    .node_id = 2, .instance_id = 43, .kind = DAW_AUDIO_PROCESSOR_KIND_EQ,
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

  const std::array<float, 4> input{1.0F, 1.0F, 1.0F, 1.0F};
  const float *inputs[]{input.data(), input.data()};
  std::array<float, 4> output_left{};
  std::array<float, 4> output_right{};
  float *outputs[]{output_left.data(), output_right.data()};
  const daw_audio_processor_event event{
    .processor_instance_id = 43,
    .parameter_target = DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_GAIN_DB(0),
    .frame_offset = 2,
    .value = 12.0F,
  };
  const daw_audio_core_process_block event_block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 4, .channel_count = 2,
    .input_bus_count = 1, .inputs = inputs, .outputs = outputs, .graph_revision = 1,
    .event_count = 1, .events = &event,
  };
  expect(daw_audio_core_process(core, &event_block), DAW_AUDIO_CORE_OK);
  assert(std::abs(output_left[0] - 1.0F) <= 1e-6F);
  assert(std::abs(output_left[1] - 1.0F) <= 1e-6F);
  assert(output_left[2] > 1.0F);
  assert(output_left[3] > 1.0F);
  assert(std::abs(output_left[2] - output_right[2]) <= 1e-6F);

  output_left.fill(0.0F);
  output_right.fill(0.0F);
  const daw_audio_core_process_block persistent_block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 4, .channel_count = 2,
    .input_bus_count = 1, .inputs = inputs, .outputs = outputs, .graph_revision = 1,
  };
  expect(daw_audio_core_process(core, &persistent_block), DAW_AUDIO_CORE_OK);
  assert(output_left[0] > 1.0F);
  assert(output_right[0] > 1.0F);
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

void test_repeated_identical_instrument_revision_preserves_continuity() {
  daw_audio_core_handle core = create_core(8, 2, 1);
  const std::array<daw_audio_graph_node_descriptor, 2> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_INSTRUMENT, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0,
      .instrument = {.kind = DAW_AUDIO_INSTRUMENT_KIND_SYNTH, .version = 1, .voice_capacity = 2}},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  }};
  const std::array<daw_audio_graph_edge_descriptor, 1> edges{{
    {.id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F,
      .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .sidechain = 0, .pdc_delay_frames = 0},
  }};
  const daw_audio_synth_state synth{
    .version = 1, .seed = 1, .filter_cutoff_hz = 1000.0F, .filter_resonance = 0.7F,
    .filter_key_tracking = 0.5F, .filter_sustain = 0.5F, .amp_sustain = 0.5F,
    .lfo_rate_hz = 1.0F, .output_gain = 0.75F,
  };
  const auto request = [&](const uint32_t revision) {
    return daw_audio_graph_prepare_request{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = revision,
      .node_count = static_cast<uint32_t>(nodes.size()), .edge_count = static_cast<uint32_t>(edges.size()),
      .processor_count = 0, .nodes = nodes.data(), .edges = edges.data(), .processors = nullptr,
    };
  };
  auto first = request(1);
  expect(daw_audio_core_prepare_graph(core, &first), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_configure_synth(core, 1, &synth), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_publish(core, 1), DAW_AUDIO_CORE_OK);
  auto second = request(2);
  expect(daw_audio_core_prepare_graph(core, &second), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_configure_synth(core, 1, &synth), DAW_AUDIO_CORE_OK);
  assert(daw_audio_core_prepared_graph_continuity(core) == 1);
  expect(daw_audio_core_publish(core, 2), DAW_AUDIO_CORE_OK);
  auto cold_configuration = synth;
  cold_configuration.output_gain = 0.25F;
  expect(daw_audio_core_configure_synth(core, 1, &cold_configuration), DAW_AUDIO_CORE_OK);
  auto third = request(3);
  expect(daw_audio_core_prepare_graph(core, &third), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_configure_synth(core, 1, &cold_configuration), DAW_AUDIO_CORE_OK);
  assert(daw_audio_core_prepared_graph_continuity(core) == 1);
  expect(daw_audio_core_publish(core, 3), DAW_AUDIO_CORE_OK);
  daw_audio_core_destroy(core);
}

void test_instrument_reindex_retains_sustain_and_live_parameter_override() {
  const auto edited = create_core(64, 2, 1);
  const auto reference = create_core(64, 2, 1);
  std::array<daw_audio_graph_node_descriptor, 2> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_INSTRUMENT,
      .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .instrument = {.kind = DAW_AUDIO_INSTRUMENT_KIND_SYNTH, .version = 1, .voice_capacity = 2,
        .parameter_count = 1, .parameter_targets = {DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_GAIN}}},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER,
      .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO},
  }};
  const daw_audio_graph_edge_descriptor edge{
    .id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F,
    .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER,
  };
  const daw_audio_synth_state synth{
    .version = 1, .seed = 19,
    .oscillators = {{.enabled = 1, .waveform = DAW_AUDIO_SYNTH_WAVEFORM_SINE, .level = 0.5F}},
    .filter_cutoff_hz = 1000.0F, .filter_resonance = 0.7F,
    .filter_sustain = 0.5F, .amp_sustain = 1.0F, .amp_release_ms = 1.0F,
    .lfo_rate_hz = 1.0F, .output_gain = 0.75F,
  };
  const auto prepare = [&](daw_audio_core_handle core, uint32_t revision) {
    const daw_audio_graph_prepare_request request{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = revision,
      .node_count = 2, .edge_count = 1, .nodes = nodes.data(), .edges = &edge,
    };
    expect(daw_audio_core_prepare_graph(core, &request), DAW_AUDIO_CORE_OK);
    expect(daw_audio_core_configure_synth(core, 1, &synth), DAW_AUDIO_CORE_OK);
  };
  for (const auto core : {edited, reference}) {
    prepare(core, 1);
    expect(daw_audio_core_publish(core, 1), DAW_AUDIO_CORE_OK);
    const daw_audio_transport_state transport{.epoch = 1, .running = 1};
    expect(daw_audio_core_set_transport(core, &transport), DAW_AUDIO_CORE_OK);
  }
  const std::array<daw_audio_instrument_event, 4> events{{
    {.node_id = 1, .note_id = 9, .sequence = 1, .epoch = 1,
      .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON, .note = 69, .value = 1.0F},
    {.node_id = 1, .sequence = 2, .epoch = 1, .frame_offset = 1,
      .type = DAW_AUDIO_INSTRUMENT_EVENT_SUSTAIN, .value = 1.0F},
    {.node_id = 1, .note_id = 9, .sequence = 3, .epoch = 1, .frame_offset = 2,
      .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF, .note = 69},
    {.node_id = 1, .sequence = 4, .epoch = 1, .frame_offset = 3,
      .type = DAW_AUDIO_INSTRUMENT_EVENT_PARAMETER,
      .note = DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_GAIN, .value = 0.125F},
  }};
  const auto render = [&](daw_audio_core_handle core, uint32_t revision, bool start) {
    std::array<std::array<float, 64>, 2> samples{};
    float *outputs[]{samples[0].data(), samples[1].data()};
    const daw_audio_core_process_block block{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 64, .channel_count = 2,
      .outputs = outputs, .graph_revision = revision, .transport_epoch = 1,
      .instrument_event_count = start ? static_cast<uint32_t>(events.size()) : 0,
      .instrument_events = start ? events.data() : nullptr,
    };
    expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
    return samples;
  };
  assert(render(edited, 1, true) == render(reference, 1, true));
  std::swap(nodes[0], nodes[1]);
  prepare(edited, 99);
  assert(render(edited, 1, false) == render(reference, 1, false));
  expect(daw_audio_core_cancel_prepared_graph(edited, 99), DAW_AUDIO_CORE_OK);
  assert(render(edited, 1, false) == render(reference, 1, false));
  std::swap(nodes[0], nodes[1]);
  for (uint32_t revision = 2; revision <= 5; ++revision) {
    std::swap(nodes[0], nodes[1]);
    prepare(edited, revision);
    assert(daw_audio_core_prepared_graph_continuity(edited) == 1);
    // Preparation cannot freeze the callback's live state at prepare time.
    assert(render(edited, revision - 1, false) == render(reference, 1, false));
    allocation_count = 0;
    expect(daw_audio_core_publish(edited, revision), DAW_AUDIO_CORE_OK);
    assert(allocation_count == 0);
    const auto actual = render(edited, revision, false);
    assert(actual == render(reference, 1, false));
    assert(std::any_of(actual[0].begin(), actual[0].end(), [](float value) {
      return std::abs(value) > 1e-5F;
    }));
  }
  daw_audio_core_destroy(edited);
  daw_audio_core_destroy(reference);
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
  // The gain slews to nothing over a few milliseconds, then stays there.
  for (uint32_t block = 0; block < 100; ++block) expect(render(first, 64, nullptr, 0, first_left.data(), first_right.data()), DAW_AUDIO_CORE_OK);
  assert(first_left.back() == 0.0F && first_right.back() == 0.0F);
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

  daw_audio_synth_state long_release_synth = synth;
  long_release_synth.amp_release_ms = 60'000.0F;
  daw_audio_core_handle long_release = create_core(512, 2, 1);
  prepare_graph(long_release, 1, nodes.data(), nodes.size(), edges.data(), edges.size());
  expect(daw_audio_core_configure_synth(long_release, 1, &long_release_synth), DAW_AUDIO_CORE_OK);
  const daw_audio_transport_state long_release_transport{.epoch = 1, .running = 1, .frame = 0};
  expect(daw_audio_core_set_transport(long_release, &long_release_transport), DAW_AUDIO_CORE_OK);
  const daw_audio_instrument_event long_release_note_on{
    .node_id = 1, .note_id = 20, .sequence = 1, .epoch = 1, .frame_offset = 0,
    .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON, .channel = 0, .note = 60, .value = 0.9F,
  };
  const daw_audio_instrument_event long_release_note_off{
    .node_id = 1, .note_id = 20, .sequence = 2, .epoch = 1, .frame_offset = 0,
    .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF, .channel = 0, .note = 60, .value = 0.0F,
  };
  std::array<float, 512> long_release_left{};
  std::array<float, 512> long_release_right{};
  const daw_audio_instrument_event no_instrument_events{};
  expect(render(long_release, 512, &long_release_note_on, 1, long_release_left.data(), long_release_right.data()), DAW_AUDIO_CORE_OK);
  expect(render(long_release, 512, &long_release_note_off, 1, long_release_left.data(), long_release_right.data()), DAW_AUDIO_CORE_OK);
  for (uint32_t block_index = 0; block_index < 128; ++block_index) {
    expect(render(long_release, 512, &no_instrument_events, 0, long_release_left.data(), long_release_right.data()), DAW_AUDIO_CORE_OK);
    float block_peak = 0.0F;
    for (uint32_t frame = 0; frame < long_release_left.size(); ++frame) {
      assert(std::isfinite(long_release_left[frame]) && std::isfinite(long_release_right[frame]));
      block_peak = std::max(block_peak, std::max(
        std::abs(long_release_left[frame]), std::abs(long_release_right[frame])));
    }
    if (block_index == 0 || block_index == 63 || block_index == 127) assert(block_peak > 1e-5F);
  }
  daw_audio_core_destroy(long_release);
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
    .filter_cutoff_hz = 20000.0F, .filter_resonance = 0.7F, .lfo_rate_hz = 0.01F, .retrigger = 1,
  };
  daw_audio_sampler_state empty_sampler = sampler;
  empty_sampler.zone_count = 0;
  expect(daw_audio_core_configure_sampler(core, 1, &empty_sampler, nullptr), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_configure_sampler(core, 2, &empty_sampler, nullptr), DAW_AUDIO_CORE_OK);
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
  const daw_audio_granular_state empty_granular{
    .version = 1, .asset = 0, .seed = 77, .max_grains = 2, .window_shape = DAW_AUDIO_GRANULAR_WINDOW_HANN,
    .freeze = 0, .grain_size_ms = 5.0F, .density_hz = 200.0F, .position = 0.5F, .spray = 1.0F,
    .pitch_semitones = 0.0F, .reverse_probability = 0.5F, .stereo_spread = 0.5F,
  };
  expect(daw_audio_core_configure_granular(core, 1, &empty_granular), DAW_AUDIO_CORE_OK);
  const daw_audio_transport_state silent_transport{.epoch = 1, .running = 1, .frame = 0};
  expect(daw_audio_core_set_transport(core, &silent_transport), DAW_AUDIO_CORE_OK);
  std::array<float, 8> silent_left{};
  std::array<float, 8> silent_right{};
  float *silent_outputs[]{silent_left.data(), silent_right.data()};
  const daw_audio_core_process_block silent_block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 8, .channel_count = 2, .outputs = silent_outputs,
    .graph_revision = 1, .transport_epoch = 1,
  };
  expect(daw_audio_core_process(core, &silent_block), DAW_AUDIO_CORE_OK);
  assert(std::all_of(silent_left.begin(), silent_left.end(), [](float value) { return std::isfinite(value) && value == 0.0F; }));
  assert(std::all_of(silent_right.begin(), silent_right.end(), [](float value) { return std::isfinite(value) && value == 0.0F; }));
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

// Executable phase-3 oracles deliberately use the production prepare/publish
// API. The same cases also run one at a time through --phase-3-contract <case>.
struct Phase3Fixture {
  static constexpr uint32_t frames = 64;
  daw_audio_core_handle core;
  uint32_t revision = 1;
  uint32_t observed_nodes = 0;
  std::array<daw_audio_graph_node_descriptor, 3> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE,
      .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER,
      .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO},
    {.id = 3, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE,
      .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO},
  }};
  std::array<daw_audio_graph_edge_descriptor, 2> edges{{
    {.id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F,
      .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER},
    {.id = 2, .from_node_id = 3, .to_node_id = 2, .gain = 0.0F,
      .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER},
  }};
  daw_audio_utility_state utility = utility_state();
  daw_audio_utility_state neutral_utility = utility_state();
  std::array<uint8_t, 72> reverb{};
  std::array<daw_audio_processor_descriptor, 2> processors{};

  explicit Phase3Fixture(uint32_t sample_rate = 48000)
    : core(create_core_at_rate(frames, 2, 1, sample_rate)) {
    utility.dc_block = 1;
    for (uint32_t index = 0; index < processors.size(); ++index) {
      processors[index] = {
        .node_id = 1, .instance_id = index == 0 ? 0x1'0000'0001ULL : 1ULL,
        .kind = DAW_AUDIO_PROCESSOR_KIND_UTILITY,
        .state_version = 1, .state_size = sizeof(utility),
        .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
        .state = reinterpret_cast<const uint8_t *>(&utility),
      };
    }
    processors[1].state = reinterpret_cast<const uint8_t *>(&neutral_utility);
  }
  ~Phase3Fixture() { daw_audio_core_destroy(core); }
  Phase3Fixture(const Phase3Fixture &) = delete;
  Phase3Fixture &operator=(const Phase3Fixture &) = delete;

  void use_long_wet_reverb() {
    const auto u32 = [&](uint32_t offset, uint32_t value) {
      for (uint32_t byte = 0; byte < 4; ++byte)
        reverb[offset + byte] = static_cast<uint8_t>(value >> (byte * 8));
    };
    const auto f32 = [&](uint32_t offset, float value) {
      uint32_t bits = 0;
      std::memcpy(&bits, &value, sizeof(bits));
      u32(offset, bits);
    };
    u32(0, 1); f32(4, 1.0F); f32(8, 12.0F); f32(12, 20.0F);
    f32(16, 0.5F); u32(20, 1); f32(24, 5.0F); f32(28, 0.3F);
    f32(32, 0.5F); f32(36, 1.0F); f32(40, 0.65F); f32(44, 0.75F);
    f32(48, 0.8F); f32(52, 20.0F); f32(56, 20000.0F);
    f32(60, 20.0F); f32(64, 20000.0F); f32(68, 1.0F);
    processors[0].kind = DAW_AUDIO_PROCESSOR_KIND_REVERB;
    processors[0].state_size = static_cast<uint32_t>(reverb.size());
    processors[0].state = reverb.data();
    processors[0].tail_frames = 48000 * 13;
  }

  void prepare(uint32_t next_revision, uint32_t node_count = 2,
    uint32_t edge_count = 1, uint32_t processor_count = 2) {
    const daw_audio_graph_prepare_request request{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = next_revision,
      .node_count = node_count, .edge_count = edge_count, .processor_count = processor_count,
      .nodes = nodes.data(), .edges = edges.data(), .processors = processors.data(),
    };
    expect(daw_audio_core_prepare_graph(core, &request), DAW_AUDIO_CORE_OK);
    const daw::audio_core::NativeGraphHookRegistration observer{
      .graph_revision = next_revision,
      .observer = [](const daw::audio_core::NativeGraphNodeRender &render) noexcept {
        ++*static_cast<uint32_t *>(render.attachment);
      },
      .observer_attachment = &observed_nodes,
    };
    expect(daw::audio_core::RegisterNativeGraphHook(core, observer), DAW_AUDIO_CORE_OK);
  }

  void publish(uint32_t next_revision) {
    const auto allocations_before = allocation_count;
    expect(daw_audio_core_publish(core, next_revision), DAW_AUDIO_CORE_OK);
    assert(allocation_count == allocations_before);
    revision = next_revision;
  }

  std::array<std::array<float, frames>, 2> render(float input, bool impulse = false,
    uint32_t expected_nodes = 2) {
    std::array<float, frames> signal{};
    if (impulse) signal[0] = input;
    else signal.fill(input);
    const float *inputs[]{signal.data(), signal.data()};
    std::array<std::array<float, frames>, 2> samples{};
    float *outputs[]{samples[0].data(), samples[1].data()};
    const daw_audio_core_process_block block{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = frames, .channel_count = 2,
      .input_bus_count = 1, .inputs = inputs, .outputs = outputs, .graph_revision = revision,
    };
    observed_nodes = 0;
    const auto allocations_before = allocation_count;
    expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
    assert(allocation_count == allocations_before);
    assert(observed_nodes == expected_nodes);
    return samples;
  }
};

void test_phase3_chain_reorder_preserves_history_and_observer_counts() {
  Phase3Fixture edited;
  Phase3Fixture reference;
  for (auto *fixture : {&edited, &reference}) {
    fixture->prepare(1);
    fixture->publish(1);
  }
  for (uint32_t index = 0; index < 32; ++index)
    assert(edited.render(0.25F) == reference.render(0.25F));
  std::swap(edited.processors[0], edited.processors[1]);
  edited.prepare(2);
  assert(daw_audio_core_prepared_graph_continuity(edited.core) == 1);
  for (uint32_t index = 0; index < 4; ++index)
    assert(edited.render(0.25F) == reference.render(0.25F));
  expect(daw_audio_core_cancel_prepared_graph(edited.core, 2), DAW_AUDIO_CORE_OK);
  assert(edited.render(0.25F) == reference.render(0.25F));
  edited.prepare(3);
  edited.publish(3);
  // The reordered node dips for a deletion fade (a quarter of a second at the
  // slowest rate under test is far beyond it) and never rises above the reference.
  float dip_peak = 0.0F;
  for (uint32_t index = 0; index < 16; ++index) {
    const auto actual = edited.render(0.25F);
    const auto expected = reference.render(0.25F);
    for (uint32_t channel = 0; channel < 2; ++channel)
      for (uint32_t frame = 0; frame < Phase3Fixture::frames; ++frame) {
        assert(std::abs(actual[channel][frame]) <= std::abs(expected[channel][frame]) + 1e-6F);
        dip_peak = std::max(dip_peak, std::abs(expected[channel][frame]) - std::abs(actual[channel][frame]));
      }
  }
  assert(dip_peak > 1e-3F);
  // A memoryless unity stage commutes with the retained DC filter. Floating
  // point utility matrix roundoff is bounded separately on this edited path.
  // Unlike two stateful cascaded filters, this does not require migrating a
  // processor's history to pretend the edit itself was inaudible.
  for (uint32_t index = 0; index < 64; ++index) {
    const auto actual = edited.render(0.25F);
    const auto expected = reference.render(0.25F);
    for (uint32_t channel = 0; channel < 2; ++channel)
      for (uint32_t frame = 0; frame < Phase3Fixture::frames; ++frame)
        assert(std::abs(actual[channel][frame] - expected[channel][frame]) < 1e-6F);
  }
}

void test_phase3_long_wet_tail_across_unrelated_edit(bool connected, bool removal = false) {
  Phase3Fixture edited;
  Phase3Fixture reference;
  for (auto *fixture : {&edited, &reference}) {
    fixture->use_long_wet_reverb();
    fixture->prepare(1, removal ? 3 : 2, removal ? 2 : 1, 1);
    fixture->publish(1);
  }
  const uint32_t initial_nodes = removal ? 3 : 2;
  assert(edited.render(1.0F, true, initial_nodes)
    == reference.render(1.0F, true, initial_nodes));
  for (uint32_t index = 0; index < 750; ++index)
    assert(edited.render(0.0F, false, initial_nodes)
      == reference.render(0.0F, false, initial_nodes));
  // Disconnected additions are the existing supported baseline. The explicit
  // connected case is a red contract until full topology ownership is ready.
  const uint32_t next_nodes = removal ? 2 : 3;
  edited.prepare(2, next_nodes, connected && !removal ? 2 : 1, 1);
  assert(daw_audio_core_prepared_graph_continuity(edited.core) == 1);
  for (uint32_t index = 0; index < 4; ++index)
    assert(edited.render(0.0F, false, initial_nodes)
      == reference.render(0.0F, false, initial_nodes));
  edited.publish(2);
  double energy = 0.0;
  for (uint32_t index = 0; index < 1500; ++index) {
    const auto samples = edited.render(0.0F, false, next_nodes);
    assert(samples == reference.render(0.0F, false, initial_nodes));
    for (float sample : samples[0]) energy += static_cast<double>(sample) * sample;
  }
  assert(energy > 1e-8);
  if (connected && !removal) {
    edited.prepare(3, 2, 1, 1);
    assert(daw_audio_core_prepared_graph_continuity(edited.core) == 1);
    assert(edited.render(0.0F, false, 3) == reference.render(0.0F));
    edited.publish(3);
    for (uint32_t index = 0; index < 64; ++index)
      assert(edited.render(0.0F) == reference.render(0.0F));
  }
}

void test_phase3_deleted_source_fades_for_five_milliseconds(uint32_t sample_rate) {
  Phase3Fixture edited(sample_rate);
  edited.prepare(1, 2, 1, 0);
  edited.publish(1);
  const auto before = edited.render(0.25F);
  for (float sample : before[0]) assert(sample == 0.25F);
  edited.nodes[0] = edited.nodes[1]; // Only master survives.
  edited.prepare(2, 1, 0, 0);
  // Publish anyway here: the oracle must independently detect the current hard
  // cut, not stop at the unsupported topology verdict.
  edited.publish(2);
  const uint32_t fade_frames = static_cast<uint32_t>(std::ceil(sample_rate * 0.005));
  for (uint32_t block = 0; block < (fade_frames + Phase3Fixture::frames - 1)
    / Phase3Fixture::frames + 2; ++block) {
    const auto samples = edited.render(0.25F, false, 1);
    for (uint32_t frame = 0; frame < Phase3Fixture::frames; ++frame) {
      const uint32_t elapsed = block * Phase3Fixture::frames + frame;
      const float expected = elapsed < fade_frames
        ? 0.25F * (1.0F - static_cast<float>(elapsed) / fade_frames) : 0.0F;
      assert(std::abs(samples[0][frame] - expected) < 1e-6F);
      assert(std::abs(samples[1][frame] - expected) < 1e-6F);
      if (elapsed >= fade_frames)
        assert(samples[0][frame] == 0.0F && samples[1][frame] == 0.0F);
    }
  }
}

// Sixteen chains of 32 utilities fill the live processor capacity, so slot
// exhaustion, rollback and epoch-delayed reuse are observable through the API.
struct Phase3SlotFixture {
  static constexpr uint32_t sources = 16;
  static constexpr uint32_t chain = 32;
  static constexpr uint32_t frames = 64;
  daw_audio_core_handle core = create_core_at_rate(frames, 2, 1, 48000);
  uint32_t revision = 0;
  uint32_t processor_count;
  daw_audio_utility_state utility = utility_state();
  std::array<daw_audio_graph_node_descriptor, sources + 1> nodes{};
  std::array<daw_audio_graph_edge_descriptor, sources> edges{};
  std::array<daw_audio_processor_descriptor, sources * chain> processors{};

  explicit Phase3SlotFixture(uint32_t count) : processor_count(count) {
    utility.dc_block = 1;
    for (uint32_t index = 0; index < sources; ++index) {
      nodes[index] = {.id = index + 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE,
        .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO};
      edges[index] = {.id = index + 1, .from_node_id = index + 1, .to_node_id = sources + 1,
        .gain = 1.0F / sources, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER};
    }
    nodes[sources] = {.id = sources + 1, .kind = DAW_AUDIO_GRAPH_NODE_MASTER,
      .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO};
    replace(0, 0);
  }
  ~Phase3SlotFixture() { daw_audio_core_destroy(core); }
  Phase3SlotFixture(const Phase3SlotFixture &) = delete;
  Phase3SlotFixture &operator=(const Phase3SlotFixture &) = delete;

  // The first `count` processors get instance IDs the core has not seen under `tag`.
  void replace(uint32_t count, uint64_t tag) {
    for (uint32_t index = 0; index < processors.size(); ++index) {
      processors[index] = {
        .node_id = index / chain + 1, .instance_id = 1 + index + (index < count ? tag * 10000 : 0),
        .kind = DAW_AUDIO_PROCESSOR_KIND_UTILITY, .state_version = 1, .state_size = sizeof(utility),
        .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
        .state = reinterpret_cast<const uint8_t *>(&utility),
      };
    }
  }

  daw_audio_core_result prepare(uint32_t next_revision) {
    const daw_audio_graph_prepare_request request{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = next_revision,
      .node_count = sources + 1, .edge_count = sources, .processor_count = processor_count,
      .nodes = nodes.data(), .edges = edges.data(), .processors = processors.data(),
    };
    return daw_audio_core_prepare_graph(core, &request);
  }

  void publish(uint32_t next_revision) {
    expect(daw_audio_core_publish(core, next_revision), DAW_AUDIO_CORE_OK);
    revision = next_revision;
  }

  std::array<std::array<float, frames>, 2> render() {
    std::array<float, frames> signal{};
    signal.fill(0.25F);
    const float *inputs[]{signal.data(), signal.data()};
    std::array<std::array<float, frames>, 2> samples{};
    float *outputs[]{samples[0].data(), samples[1].data()};
    const daw_audio_core_process_block block{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = frames, .channel_count = 2,
      .input_bus_count = 1, .inputs = inputs, .outputs = outputs, .graph_revision = revision,
    };
    const auto allocations_before = allocation_count;
    expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
    assert(allocation_count == allocations_before);
    return samples;
  }
};

// Checkpoint 17 (core half): a transition the pool cannot hold fails the prepare
// and leaves the callback's slots and audio untouched. The host half
// (TestTransitionExhaustionFailsWithoutColdCore) requires that failure to reach
// the caller instead of becoming a published cold core.
void test_phase3_slot_exhaustion_rollback_and_epoch_delayed_reuse() {
  // 512 live processors fill the live capacity; 128 more slots belong to fading
  // entries, so the pool is exactly full once 128 of them are replaced at once.
  Phase3SlotFixture edited(512);
  Phase3SlotFixture reference(512);
  for (auto *fixture : {&edited, &reference}) {
    expect(fixture->prepare(1), DAW_AUDIO_CORE_OK);
    fixture->publish(1);
  }
  for (uint32_t index = 0; index < 8; ++index) assert(edited.render() == reference.render());

  // 129 replacements need 129 fading entries: a genuine failure that must not
  // touch the slots the callback is using.
  edited.replace(129, 1);
  expect(edited.prepare(2), DAW_AUDIO_CORE_CAPACITY_EXCEEDED);
  for (uint32_t index = 0; index < 4; ++index) assert(edited.render() == reference.render());

  // A failed prepare and a cancelled prepare both hand their fresh slots back.
  edited.replace(128, 1);
  expect(edited.prepare(2), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_cancel_prepared_graph(edited.core, 2), DAW_AUDIO_CORE_OK);
  assert(edited.render() == reference.render());
  expect(edited.prepare(2), DAW_AUDIO_CORE_OK);
  // A superseded prepared revision can no longer be published.
  expect(daw_audio_core_publish(edited.core, 1), DAW_AUDIO_CORE_STALE_REVISION);
  const auto allocations_before = allocation_count;
  edited.publish(2);
  assert(allocation_count == allocations_before);

  // The 128 replaced processors keep their slots while they fade out (240 frames
  // at 48 kHz, four 64-frame blocks). The fading entries and slots are all taken,
  // so one more replacement fails until the block that finished the fade has completed.
  edited.replace(129, 1);
  for (uint32_t index = 0; index < 3; ++index) edited.render();
  expect(edited.prepare(3), DAW_AUDIO_CORE_CAPACITY_EXCEEDED);
  assert(daw_audio_core_reclaim_retired_runtime(edited.core) == 0);
  edited.render();
  assert(daw_audio_core_reclaim_retired_runtime(edited.core) == 128);
  expect(edited.prepare(3), DAW_AUDIO_CORE_OK);
  edited.publish(3);
  for (uint32_t index = 0; index < 4; ++index) edited.render();
  edited.replace(130, 1);
  expect(edited.prepare(4), DAW_AUDIO_CORE_OK);
  edited.publish(4);

  // A prepared plan that retains slots the published plan has since retired
  // names stale slots and is refused instead of reviving them.
  edited.replace(130, 1);
  expect(edited.prepare(5), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_retire(edited.core, 4), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_publish(edited.core, 5), DAW_AUDIO_CORE_STALE_REVISION);
}

void test_phase3_processor_removal_fades_while_retained_stays_exact() {
  Phase3Fixture edited;
  Phase3Fixture reference;
  for (auto *fixture : {&edited, &reference}) {
    fixture->prepare(1);
    fixture->publish(1);
  }
  for (uint32_t index = 0; index < 16; ++index) assert(edited.render(0.25F) == reference.render(0.25F));
  // Drop the second chain entry; the DC-blocking one must be rendered exactly once.
  edited.prepare(2, 2, 1, 1);
  assert(daw_audio_core_prepared_graph_continuity(edited.core) == 1);
  edited.publish(2);
  for (uint32_t index = 0; index < 32; ++index) {
    const auto actual = edited.render(0.25F);
    const auto expected = reference.render(0.25F);
    for (uint32_t channel = 0; channel < 2; ++channel)
      for (uint32_t frame = 0; frame < Phase3Fixture::frames; ++frame)
        assert(std::abs(actual[channel][frame] - expected[channel][frame]) < 1e-6F);
  }
}

// The processor descriptors the TypeScript compiler emits (createPortableGraphSnapshot)
// for the stages these contracts drive, written by
// native/audio-core/scripts/generate-compiled-processors.ts and kept current by its
// --check in test-native.sh. A stage built from a record has the product's state
// bytes, instance id, latency, tail, bypass flag and complete set of parameter
// targets, so a contract cannot pass on a simplification of what the host sends.
struct CompiledProcessor {
  uint64_t instance_id = 0;
  uint32_t kind = 0, state_version = 0, latency_frames = 0, tail_frames = 0, bypassed = 0;
  std::vector<uint32_t> targets;
  std::vector<uint8_t> state;
};

const std::map<std::string, CompiledProcessor> &compiled_processors() {
  static const std::map<std::string, CompiledProcessor> records = [] {
    std::string path = __FILE__;
    path.erase(path.rfind('/') + 1);
    path += "fixtures/compiled-processors.txt";
    std::FILE *file = std::fopen(path.c_str(), "r");
    if (file == nullptr) {
      std::fprintf(stderr, "compiled processors: cannot open %s\n", path.c_str());
      std::abort();
    }
    std::map<std::string, CompiledProcessor> parsed;
    std::string text;
    for (int character = std::fgetc(file); character != EOF; character = std::fgetc(file)) text.push_back(static_cast<char>(character));
    std::fclose(file);
    size_t line_start = 0;
    while (line_start < text.size()) {
      const size_t line_end = text.find('\n', line_start);
      std::vector<std::string> fields;
      for (size_t start = line_start; start <= line_end;) {
        const size_t stop = std::min(text.find(' ', start), line_end);
        fields.push_back(text.substr(start, stop - start));
        start = stop + 1;
      }
      line_start = line_end + 1;
      assert(fields.size() == 9);
      CompiledProcessor record;
      record.instance_id = std::stoull(fields[1]);
      record.kind = static_cast<uint32_t>(std::stoul(fields[2]));
      record.state_version = static_cast<uint32_t>(std::stoul(fields[3]));
      record.latency_frames = static_cast<uint32_t>(std::stoul(fields[4]));
      record.tail_frames = static_cast<uint32_t>(std::stoul(fields[5]));
      record.bypassed = static_cast<uint32_t>(std::stoul(fields[6]));
      for (size_t start = 0; start < fields[7].size();) {
        const size_t stop = std::min(fields[7].find(',', start), fields[7].size());
        record.targets.push_back(static_cast<uint32_t>(std::stoul(fields[7].substr(start, stop - start))));
        start = stop + 1;
      }
      for (size_t index = 0; index + 1 < fields[8].size(); index += 2) {
        record.state.push_back(static_cast<uint8_t>(std::stoul(fields[8].substr(index, 2), nullptr, 16)));
      }
      parsed.emplace(fields[0], std::move(record));
    }
    return parsed;
  }();
  return records;
}

const CompiledProcessor &compiled_processor(const std::string &name) {
  const auto found = compiled_processors().find(name);
  if (found == compiled_processors().end()) {
    std::fprintf(stderr, "compiled processors: no record named %s\n", name.c_str());
    std::abort();
  }
  return found->second;
}

// The first field in which a rig processor differs from a record, or null.
const char *compiled_difference(const daw_audio_processor_descriptor &actual, const CompiledProcessor &record) {
  if (actual.instance_id != record.instance_id) return "instance id";
  if (actual.kind != record.kind) return "kind";
  if (actual.state_version != record.state_version) return "state version";
  if (actual.bypassed != record.bypassed) return "bypass flag";
  if (actual.latency_frames != record.latency_frames) return "latency";
  if (actual.tail_frames != record.tail_frames) return "tail";
  if (actual.parameter_count != record.targets.size()
    || !std::equal(record.targets.begin(), record.targets.end(), actual.parameter_targets)) return "parameter targets";
  if (actual.state_size != record.state.size() || std::memcmp(actual.state, record.state.data(), record.state.size()) != 0) {
    return "state bytes";
  }
  return nullptr;
}

// Round-4 review contracts (checkpoints 12-16). A rig builds a graph from vectors,
// so each case states only the edit it exercises. Every case uses the production
// prepare/publish API and checks that publish and render allocate nothing.
struct Phase3Rig {
  static constexpr uint32_t frames = 64;
  using Block = std::array<std::array<float, frames>, 2>;
  daw_audio_core_handle core;
  uint32_t revision = 0;
  uint32_t sample_rate;
  std::vector<daw_audio_graph_node_descriptor> nodes;
  std::vector<daw_audio_graph_edge_descriptor> edges;
  std::vector<daw_audio_processor_descriptor> processors;
  std::deque<daw_audio_utility_state> utilities;
  std::deque<std::array<uint8_t, 32>> saturators;
  std::deque<std::array<uint8_t, 72>> compressors;
  std::deque<std::vector<uint8_t>> states;
  // When set, the output of this node is captured on every render, whatever the
  // master mix does: an exact view of one object for isolation oracles.
  uint64_t witness_node = 0;
  Block witness{};
  // When set, a hook halving the node's signal runs as an external stage at
  // `external_stage` among its built-in stages, like a plugin the host binds there.
  uint64_t external_node = 0;
  uint32_t external_stage = 0;
  static constexpr std::array<uint32_t, 1> gain_target{DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB};
  // Synth nodes: configured on every prepare, like the product does before publish.
  // Notes queued here go out with the next render.
  std::map<uint64_t, daw_audio_synth_state> synths;
  std::vector<daw_audio_instrument_event> notes;
  uint32_t transport_epoch = 0;
  uint32_t note_sequence = 0;
  std::deque<std::array<uint32_t, 1>> declared_targets;
  std::deque<std::vector<uint32_t>> compiled_targets;
  uint64_t tone_frame = 0;

  // `capacity` is the largest block render_tone_wide may render.
  explicit Phase3Rig(uint32_t rate = 48000, uint32_t capacity = frames)
    : core(create_core_at_rate(capacity, 2, 1, rate)), sample_rate(rate) {}
  ~Phase3Rig() { daw_audio_core_destroy(core); }
  Phase3Rig(const Phase3Rig &) = delete;
  Phase3Rig &operator=(const Phase3Rig &) = delete;

  uint32_t fade_frames() const { return (sample_rate * 5u + 500u) / 1000u; }
  static float ramp(uint32_t elapsed, uint32_t fade) {
    return elapsed >= fade ? 0.0F : 1.0F - static_cast<float>(elapsed) / static_cast<float>(fade);
  }

  void clear() { nodes.clear(); edges.clear(); processors.clear(); }
  void add_node(uint64_t id, uint32_t kind, uint32_t input_bus = 0) {
    nodes.push_back({.id = id, .kind = kind, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = input_bus});
  }
  void add_instrument(uint64_t id, const daw_audio_synth_state &synth) {
    nodes.push_back({.id = id, .kind = DAW_AUDIO_GRAPH_NODE_INSTRUMENT, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .instrument = {.kind = DAW_AUDIO_INSTRUMENT_KIND_SYNTH, .version = 1, .voice_capacity = 2}});
    synths[id] = synth;
  }
  void note_on(uint64_t node, uint32_t note) {
    if (transport_epoch == 0) {
      transport_epoch = 1;
      const daw_audio_transport_state transport{.epoch = 1, .running = 1};
      expect(daw_audio_core_set_transport(core, &transport), DAW_AUDIO_CORE_OK);
    }
    ++note_sequence;
    notes.push_back({.node_id = node, .note_id = note_sequence, .sequence = note_sequence, .epoch = 1,
      .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON, .note = note, .value = 1.0F});
  }
  void add_edge(uint64_t from, uint64_t to, float gain = 1.0F) {
    edges.push_back({.id = edges.size() + 1, .from_node_id = from, .to_node_id = to, .gain = gain,
      .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER});
  }
  // Declares one automatable parameter on the last processor, the way the product's
  // compiled graph does for every effect it can automate.
  void declare_target(uint32_t target) {
    declared_targets.push_back({target});
    processors.back().parameter_count = 1;
    processors.back().parameter_targets = declared_targets.back().data();
  }
  void add_processor(uint64_t node, uint64_t instance, uint32_t kind, uint32_t size, const uint8_t *state,
    bool automatable) {
    processors.push_back({.node_id = node, .instance_id = instance, .kind = kind, .state_version = 1,
      .state_size = size, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .parameter_count = automatable ? 1u : 0u,
      .parameter_targets = automatable ? gain_target.data() : nullptr, .state = state});
  }
  void add_utility(uint64_t node, uint64_t instance, float gain_db = 0.0F, bool dc_block = false,
    bool automatable = false) {
    utilities.push_back(utility_state(1, gain_db));
    utilities.back().dc_block = dc_block ? 1 : 0;
    add_processor(node, instance, DAW_AUDIO_PROCESSOR_KIND_UTILITY, sizeof(daw_audio_utility_state),
      reinterpret_cast<const uint8_t *>(&utilities.back()), automatable);
  }
  // Hard clipper with 18 dB of drive: it does not commute with a gain stage.
  void add_saturator(uint64_t node, uint64_t instance) {
    saturators.emplace_back();
    auto &bytes = saturators.back();
    const auto put = [&bytes](uint32_t offset, uint32_t bits) {
      for (uint32_t byte = 0; byte < 4; ++byte) bytes[offset + byte] = static_cast<uint8_t>(bits >> (byte * 8));
    };
    const auto put_float = [&put](uint32_t offset, float value) {
      uint32_t bits = 0;
      std::memcpy(&bits, &value, sizeof(bits));
      put(offset, bits);
    };
    put(0, 1); put_float(4, 18.0F); put(8, DAW_AUDIO_SATURATOR_CURVE_HARD); put(12, 1);
    put_float(16, 2500.0F); put_float(20, 0.5F); put_float(24, -3.0F); put_float(28, 0.75F);
    add_processor(node, instance, DAW_AUDIO_PROCESSOR_KIND_SATURATOR, 32, bytes.data(), false);
  }
  // A hard compressor with full lookahead, so its detector reacts at once, and a
  // detector low-pass wide enough to pass a steady key: with the key on a second
  // bus, only the key decides how far the program is pulled down.
  void add_compressor(uint64_t node, uint64_t instance, float threshold_db) {
    compressors.emplace_back();
    auto &bytes = compressors.back();
    const auto put = [&bytes](uint32_t offset, uint32_t bits) {
      for (uint32_t byte = 0; byte < 4; ++byte) bytes[offset + byte] = static_cast<uint8_t>(bits >> (byte * 8));
    };
    const auto put_float = [&put](uint32_t offset, float value) {
      uint32_t bits = 0;
      std::memcpy(&bits, &value, sizeof(bits));
      put(offset, bits);
    };
    put(0, 1); put_float(4, threshold_db); put_float(8, 100.0F); put_float(12, 0.1F); put_float(16, 5.0F);
    put_float(32, 1.0F); put_float(40, 10.0F); put(56, 1); put(60, 1); put_float(64, 20000.0F); put_float(68, 0.707F);
    add_processor(node, instance, DAW_AUDIO_PROCESSOR_KIND_COMPRESSOR, 72, bytes.data(), false);
  }
  // Any processor whose ABI state is a plain struct (EQ, gate, limiter, ...).
  template <typename State>
  void add_state(uint64_t node, uint64_t instance, uint32_t kind, const State &state) {
    const auto *bytes = reinterpret_cast<const uint8_t *>(&state);
    states.emplace_back(bytes, bytes + sizeof(State));
    add_processor(node, instance, kind, sizeof(State), states.back().data(), false);
  }
  // Any processor given as the ABI's raw state bytes.
  void add_bytes(uint64_t node, uint64_t instance, uint32_t kind, const uint8_t *bytes, uint32_t size) {
    states.emplace_back(bytes, bytes + size);
    add_processor(node, instance, kind, size, states.back().data(), false);
  }
  // A stage exactly as the compiler emits it, its latency added to its node's. Only
  // the matrix's key compressor passes keep_latency = false: every matrix edit is
  // latency-neutral by construction, and removing a stage that delays the signal is
  // a latency change (LATENCY_CHANGE_DEFERRED), not a live edit.
  void add_compiled(uint64_t node, const std::string &name, bool keep_latency = true) {
    const CompiledProcessor &record = compiled_processor(name);
    const uint32_t latency = keep_latency ? record.latency_frames : 0;
    states.emplace_back(record.state);
    compiled_targets.push_back(record.targets);
    processors.push_back({.node_id = node, .instance_id = record.instance_id, .kind = record.kind,
      .state_version = record.state_version, .state_size = static_cast<uint32_t>(record.state.size()),
      .bypassed = record.bypassed, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .latency_frames = latency,
      .tail_frames = record.tail_frames, .parameter_count = static_cast<uint32_t>(record.targets.size()),
      .parameter_targets = compiled_targets.back().data(), .state = states.back().data()});
    for (daw_audio_graph_node_descriptor &candidate : nodes) {
      if (candidate.id == node) candidate.latency_frames += latency;
    }
  }
  void add_sidechain(uint64_t from, uint64_t to, uint64_t target_processor) {
    edges.push_back({.id = edges.size() + 1, .from_node_id = from, .to_node_id = to,
      .target_processor_id = target_processor, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER,
      .sidechain = 1});
  }

  daw_audio_core_result prepare(uint32_t next_revision) {
    const daw_audio_graph_prepare_request request{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = next_revision,
      .node_count = static_cast<uint32_t>(nodes.size()), .edge_count = static_cast<uint32_t>(edges.size()),
      .processor_count = static_cast<uint32_t>(processors.size()),
      .nodes = nodes.data(), .edges = edges.data(), .processors = processors.data(),
    };
    const daw_audio_core_result result = daw_audio_core_prepare_graph(core, &request);
    if (result != DAW_AUDIO_CORE_OK) return result;
    for (const auto &node : nodes) {
      if (node.kind != DAW_AUDIO_GRAPH_NODE_INSTRUMENT) continue;
      // Configuring is part of preparing: a refusal (capacity) fails the whole edit.
      const daw_audio_core_result configured = daw_audio_core_configure_synth(core, node.id, &synths.at(node.id));
      if (configured != DAW_AUDIO_CORE_OK) return configured;
    }
    if (witness_node == 0 && external_node == 0) return result;
    const daw::audio_core::NativeGraphHookBinding external{
      .node_id = external_node, .stage_index = external_stage, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .attachment = this,
    };
    const daw::audio_core::NativeGraphHookRegistration registration{
      .graph_revision = next_revision,
      .hook = [](const daw::audio_core::NativeGraphNodeRender &render) noexcept {
        for (uint32_t frame = 0; frame < render.frame_count; ++frame) {
          render.planes[0][frame] *= 0.5F;
          render.planes[1][frame] *= 0.5F;
        }
      },
      .bindings = std::span<const daw::audio_core::NativeGraphHookBinding>(&external, external_node != 0 ? 1 : 0),
      .observer = witness_node == 0 ? nullptr : +[](const daw::audio_core::NativeGraphNodeRender &render) noexcept {
        Phase3Rig &rig = *static_cast<Phase3Rig *>(render.attachment);
        if (render.node_id != rig.witness_node) return;
        for (uint32_t channel = 0; channel < 2; ++channel) {
          for (uint32_t frame = 0; frame < frames; ++frame) rig.witness[channel][frame] = render.planes[channel][frame];
        }
      },
      .observer_attachment = witness_node == 0 ? nullptr : this,
    };
    return daw::audio_core::RegisterNativeGraphHook(core, registration);
  }
  void publish(uint32_t next_revision) {
    const auto allocations_before = allocation_count;
    expect(daw_audio_core_publish(core, next_revision), DAW_AUDIO_CORE_OK);
    assert(allocation_count == allocations_before);
    revision = next_revision;
  }
  void commit(uint32_t next_revision) {
    expect(prepare(next_revision), DAW_AUDIO_CORE_OK);
    publish(next_revision);
  }
  Block render(float input, const daw_audio_processor_event *events = nullptr, uint32_t event_count = 0) {
    std::array<float, frames> signal{};
    signal.fill(input);
    const float *inputs[]{signal.data(), signal.data()};
    Block samples{};
    float *outputs[]{samples[0].data(), samples[1].data()};
    const auto sent = std::exchange(notes, {});
    const daw_audio_core_process_block block{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = frames, .channel_count = 2,
      .input_bus_count = 1, .inputs = inputs, .outputs = outputs, .graph_revision = revision,
      .event_count = event_count, .events = events, .transport_epoch = transport_epoch,
      .instrument_event_count = static_cast<uint32_t>(sent.size()), .instrument_events = sent.data(),
    };
    const auto allocations_before = allocation_count;
    expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
    assert(allocation_count == allocations_before);
    return samples;
  }
  Block render_stereo(float left, float right) {
    std::array<float, frames> left_signal{};
    std::array<float, frames> right_signal{};
    left_signal.fill(left);
    right_signal.fill(right);
    const float *inputs[]{left_signal.data(), right_signal.data()};
    Block samples{};
    float *outputs[]{samples[0].data(), samples[1].data()};
    const auto sent = std::exchange(notes, {});
    const daw_audio_core_process_block block{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = frames, .channel_count = 2,
      .input_bus_count = 1, .inputs = inputs, .outputs = outputs, .graph_revision = revision,
      .transport_epoch = transport_epoch, .instrument_event_count = static_cast<uint32_t>(sent.size()),
      .instrument_events = sent.data(),
    };
    expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
    return samples;
  }
  Block render_input(const std::array<float, frames> &left, const std::array<float, frames> &right) {
    const float *inputs[]{left.data(), right.data()};
    Block samples{};
    float *outputs[]{samples[0].data(), samples[1].data()};
    const daw_audio_core_process_block block{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = frames, .channel_count = 2,
      .input_bus_count = 1, .inputs = inputs, .outputs = outputs, .graph_revision = revision,
    };
    const auto allocations_before = allocation_count;
    expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
    assert(allocation_count == allocations_before);
    return samples;
  }
  float tone(float hz, float amplitude, uint64_t index) const {
    return amplitude * static_cast<float>(std::sin(6.283185307179586 * hz * static_cast<double>(index)
      / static_cast<double>(sample_rate)));
  }
  // A sine on the left input and its (signed) copy on the right, continuing from
  // where the last tone block ended: right_sign = -1 is a bipolar, zero-mean pair.
  Block render_tone(float hz, float amplitude, float right_sign) {
    std::array<float, frames> left_signal{};
    std::array<float, frames> right_signal{};
    for (uint32_t frame = 0; frame < frames; ++frame) {
      left_signal[frame] = tone(hz, amplitude, tone_frame + frame);
      right_signal[frame] = right_sign * left_signal[frame];
    }
    tone_frame += frames;
    const float *inputs[]{left_signal.data(), right_signal.data()};
    Block samples{};
    float *outputs[]{samples[0].data(), samples[1].data()};
    const daw_audio_core_process_block block{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = frames, .channel_count = 2,
      .input_bus_count = 1, .inputs = inputs, .outputs = outputs, .graph_revision = revision,
    };
    const auto allocations_before = allocation_count;
    expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
    assert(allocation_count == allocations_before);
    return samples;
  }
  // The left channel of one block of `count` frames of render_tone's signal, for
  // contracts that run at the buffer sizes a host offers.
  std::vector<float> render_tone_wide(float hz, float amplitude, float right_sign, uint32_t count) {
    std::vector<float> left_signal(count), right_signal(count), left_output(count), right_output(count);
    for (uint32_t frame = 0; frame < count; ++frame) {
      left_signal[frame] = tone(hz, amplitude, tone_frame + frame);
      right_signal[frame] = right_sign * left_signal[frame];
    }
    tone_frame += count;
    const float *inputs[]{left_signal.data(), right_signal.data()};
    float *outputs[]{left_output.data(), right_output.data()};
    const daw_audio_core_process_block block{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = count, .channel_count = 2,
      .input_bus_count = 1, .inputs = inputs, .outputs = outputs, .graph_revision = revision,
    };
    expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
    return left_output;
  }
  // Two input buses: bus 0 carries `key`, bus 1 carries `program`.
  Block render_keyed(float key, float program) {
    std::array<float, frames> key_signal{};
    std::array<float, frames> program_signal{};
    key_signal.fill(key);
    program_signal.fill(program);
    const float *inputs[]{key_signal.data(), key_signal.data(), program_signal.data(), program_signal.data()};
    Block samples{};
    float *outputs[]{samples[0].data(), samples[1].data()};
    const auto sent = std::exchange(notes, {});
    const daw_audio_core_process_block block{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = frames, .channel_count = 2,
      .input_bus_count = 2, .inputs = inputs, .outputs = outputs, .graph_revision = revision,
      .transport_epoch = transport_epoch, .instrument_event_count = static_cast<uint32_t>(sent.size()),
      .instrument_events = sent.data(),
    };
    const auto allocations_before = allocation_count;
    expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
    assert(allocation_count == allocations_before);
    return samples;
  }
};

// Checkpoint 12: a deleted stage keeps its place in the chain, so a nonlinear
// stage after it still sees the signal it saw before the edit.
void test_phase3_deleted_stage_keeps_its_chain_position(uint32_t layout) {
  const auto build = [layout](Phase3Rig &rig, bool with_gain, bool gain_last) {
    rig.clear();
    rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE);
    rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER);
    rig.add_edge(1, 2);
    if (layout == 1) rig.add_saturator(1, 11);
    if (with_gain && !gain_last) rig.add_utility(1, 10, -12.0F);
    rig.add_saturator(1, layout == 0 ? 11 : 12);
    if (with_gain && gain_last) rig.add_utility(1, 10, -12.0F);
  };
  Phase3Rig edited;
  Phase3Rig reference;
  Phase3Rig swapped; // The wrong order a trailing ghost would produce.
  Phase3Rig steady;  // What the chain becomes once the deleted stage is gone.
  build(edited, true, false);
  build(reference, true, false);
  build(swapped, true, true);
  build(steady, false, false);
  for (auto *rig : {&edited, &reference, &swapped, &steady}) rig->commit(1);
  for (uint32_t index = 0; index < 8; ++index) {
    edited.render(0.25F);
    reference.render(0.25F);
    swapped.render(0.25F);
  }
  build(edited, false, false);
  edited.commit(2);
  const auto first = edited.render(0.25F);
  const auto before_edit = reference.render(0.25F);
  const auto wrong_order = swapped.render(0.25F);
  // The oracle is only meaningful when the order is audible.
  assert(std::abs(before_edit[0][0] - wrong_order[0][0]) > 0.05F);
  // The first faded frame is the unedited signal: the deleted stage is still at full level.
  assert(std::abs(first[0][0] - before_edit[0][0]) < 1e-6F);
  assert(std::abs(first[1][0] - before_edit[1][0]) < 1e-6F);
  Phase3Rig::Block last{};
  for (uint32_t index = 0; index < 8; ++index) last = edited.render(0.25F);
  Phase3Rig::Block settled{};
  for (uint32_t index = 0; index < 48; ++index) settled = steady.render(0.25F);
  for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame)
    assert(std::abs(last[0][frame] - settled[0][frame]) < 1e-5F);
}

// Checkpoint 13: deleting a track that plays an audio clip fades the clip.
void test_phase3_deleted_audio_clip_source_fades(uint32_t sample_rate) {
  Phase3Rig rig(sample_rate);
  rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE, DAW_AUDIO_GRAPH_INPUT_BUS_DISCONNECTED);
  rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER);
  rig.add_edge(1, 2);
  rig.commit(1);
  constexpr uint32_t asset_frames = 16384;
  const std::vector<float> samples(asset_frames, 0.5F);
  const float *planes[]{samples.data()};
  const daw_audio_asset_descriptor descriptor{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .revision = 1, .byte_length = samples.size() * sizeof(float),
    .content_hash_prefix = 0, .frame_count = asset_frames, .sample_rate_hz = sample_rate,
    .channel_count = 1, .planes = planes,
  };
  daw_audio_asset_handle asset = 0;
  expect(daw_audio_core_create_asset(rig.core, &descriptor, &asset), DAW_AUDIO_CORE_OK);
  const daw_audio_transport_state transport{.epoch = 1, .running = 1, .frame = 0};
  expect(daw_audio_core_set_transport(rig.core, &transport), DAW_AUDIO_CORE_OK);
  const daw_audio_sample_source_event clip{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .epoch = 1, .sequence = 1, .source_node_id = 1, .asset = asset,
    .start_frame = 0, .stop_frame = static_cast<int64_t>(samples.size()), .source_offset_frame = 0,
    .source_frame_count = samples.size(), .gain = 1.0F, .fade_in_start_frame = 0, .fade_in_end_frame = 0,
    .fade_out_start_frame = static_cast<int64_t>(samples.size()),
    .fade_out_end_frame = static_cast<int64_t>(samples.size()),
  };
  expect(daw_audio_core_schedule_sample_source(rig.core, &clip), DAW_AUDIO_CORE_OK);
  for (uint32_t index = 0; index < 4; ++index) assert(std::abs(rig.render(0.0F)[0][0] - 0.5F) < 1e-6F);
  rig.clear();
  rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER);
  rig.commit(2);
  const uint32_t fade = rig.fade_frames();
  for (uint32_t block = 0; block < (fade + Phase3Rig::frames - 1) / Phase3Rig::frames + 2; ++block) {
    const auto output = rig.render(0.0F);
    for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame) {
      const uint32_t elapsed = block * Phase3Rig::frames + frame;
      const float expected = 0.5F * Phase3Rig::ramp(elapsed, fade);
      assert(std::abs(output[0][frame] - expected) < 1e-6F);
      assert(std::abs(output[1][frame] - expected) < 1e-6F);
    }
  }
}

// Checkpoint 14: a latched manual override belongs to the processor's runtime
// slot. A retained processor keeps it across an unrelated publish, and a deleted
// one keeps fading with it, without the control thread reading it.
void test_phase3_live_override_survives_publish_and_ghost_keeps_it() {
  const auto build = [](Phase3Rig &rig, bool extra_node, bool with_gain) {
    rig.clear();
    rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE);
    rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER);
    rig.add_edge(1, 2);
    if (extra_node) rig.add_node(3, DAW_AUDIO_GRAPH_NODE_SOURCE, DAW_AUDIO_GRAPH_INPUT_BUS_DISCONNECTED);
    if (with_gain) rig.add_utility(1, 10, 0.0F, false, true);
  };
  Phase3Rig edited;
  Phase3Rig reference;
  build(edited, false, true);
  build(reference, false, true);
  edited.commit(1);
  reference.commit(1);
  const daw_audio_processor_event override_event{
    .processor_instance_id = 10, .parameter_target = DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB,
    .frame_offset = 0, .value = -12.0F,
  };
  assert(edited.render(0.25F, &override_event, 1) == reference.render(0.25F, &override_event, 1));
  for (uint32_t index = 0; index < 4; ++index) assert(edited.render(0.25F) == reference.render(0.25F));
  build(edited, true, true);
  edited.commit(2);
  for (uint32_t index = 0; index < 4; ++index) {
    const auto actual = edited.render(0.25F);
    assert(actual == reference.render(0.25F));
    assert(actual[0][Phase3Rig::frames - 1] < 0.1F); // Still the -12 dB override, not the 0 dB descriptor.
  }
  build(edited, true, false);
  edited.commit(3);
  const auto first = edited.render(0.25F);
  const auto expected = reference.render(0.25F);
  assert(std::abs(first[0][0] - expected[0][0]) < 1e-6F);
}

// Checkpoint 15: transition entries have their own bounded capacity.
void test_phase3_full_capacity_replace_fades_and_overflow_fails_cleanly() {
  constexpr uint32_t live_nodes = 64;
  const auto build = [](Phase3Rig &rig, uint64_t first, uint64_t last, std::vector<uint64_t> extra) {
    rig.clear();
    rig.add_node(1000, DAW_AUDIO_GRAPH_NODE_MASTER);
    for (uint64_t id = first; id <= last; ++id) rig.add_node(id, DAW_AUDIO_GRAPH_NODE_SOURCE);
    for (uint64_t id : extra) rig.add_node(id, DAW_AUDIO_GRAPH_NODE_SOURCE, DAW_AUDIO_GRAPH_INPUT_BUS_DISCONNECTED);
    for (const auto &node : rig.nodes)
      if (node.id != 1000) rig.add_edge(node.id, 1000);
  };
  {
    // Sixty-four live nodes; one sounding node is replaced by another.
    Phase3Rig rig;
    build(rig, 1, live_nodes - 1, {});
    assert(rig.nodes.size() == live_nodes);
    rig.commit(1);
    for (uint32_t index = 0; index < 4; ++index) rig.render(0.25F);
    const float steady = rig.render(0.25F)[0][0];
    build(rig, 2, live_nodes - 1, {500});
    assert(rig.nodes.size() == live_nodes);
    expect(rig.prepare(2), DAW_AUDIO_CORE_OK);
    assert(daw_audio_core_prepared_graph_continuity(rig.core) == 1);
    rig.publish(2);
    const uint32_t fade = rig.fade_frames();
    for (uint32_t block = 0; block < (fade + Phase3Rig::frames - 1) / Phase3Rig::frames + 2; ++block) {
      const auto output = rig.render(0.25F);
      for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame) {
        const float expected = steady - 0.25F * (1.0F - Phase3Rig::ramp(block * Phase3Rig::frames + frame, fade));
        assert(std::abs(output[0][frame] - expected) < 1e-4F);
      }
    }
  }
  {
    // Genuine overflow: 63 deletions on top of 2 fades still in flight need 65
    // transition nodes. The prepare fails and the active plan keeps rendering.
    Phase3Rig edited;
    Phase3Rig reference;
    for (auto *rig : {&edited, &reference}) {
      build(*rig, 1, live_nodes - 1, {});
      rig->commit(1);
      for (uint32_t index = 0; index < 4; ++index) rig->render(0.25F);
      build(*rig, 3, live_nodes - 1, {500, 501});
      rig->commit(2);
    }
    assert(edited.render(0.25F) == reference.render(0.25F));
    edited.clear();
    edited.add_node(1000, DAW_AUDIO_GRAPH_NODE_MASTER);
    expect(edited.prepare(3), DAW_AUDIO_CORE_CAPACITY_EXCEEDED);
    expect(daw_audio_core_publish(edited.core, 3), DAW_AUDIO_CORE_STALE_REVISION);
    for (uint32_t index = 0; index < 12; ++index) assert(edited.render(0.25F) == reference.render(0.25F));
  }
}

// Checkpoint 16: a deleted source and its deleted group fade once, at the point
// they join the surviving routing. The group's own processor sees unfaded input.
void test_phase3_source_and_group_deletion_apply_the_envelope_once() {
  const auto build = [](Phase3Rig &rig, bool deleted) {
    rig.clear();
    rig.add_node(3, DAW_AUDIO_GRAPH_NODE_MASTER);
    if (!deleted) {
      rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE);
      rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MIXER);
      rig.add_edge(1, 2);
      rig.add_edge(2, 3);
      rig.add_utility(2, 20, 0.0F, true);
    }
  };
  Phase3Rig edited;
  Phase3Rig reference;
  build(edited, false);
  build(reference, false);
  edited.commit(1);
  reference.commit(1);
  for (uint32_t index = 0; index < 8; ++index) assert(edited.render(0.25F) == reference.render(0.25F));
  build(edited, true);
  edited.commit(2);
  const uint32_t fade = edited.fade_frames();
  for (uint32_t block = 0; block < (fade + Phase3Rig::frames - 1) / Phase3Rig::frames + 2; ++block) {
    const auto actual = edited.render(0.25F);
    const auto expected = reference.render(0.25F);
    for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame) {
      const float envelope = Phase3Rig::ramp(block * Phase3Rig::frames + frame, fade);
      assert(std::abs(actual[0][frame] - expected[0][frame] * envelope) < 1e-6F);
    }
  }
}

// Checkpoint 12, native hooks: an external stage appended to a chain that holds a
// fading ghost still runs last, and the ghost keeps its place before the survivor.
void test_phase3_native_hook_stage_follows_ghost_chain() {
  const auto build = [](Phase3Rig &rig, bool with_gain) {
    rig.clear();
    rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE);
    rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER);
    rig.add_edge(1, 2);
    if (with_gain) rig.add_utility(1, 10, -12.0F);
    rig.add_saturator(1, 11);
  };
  Phase3Rig edited;
  Phase3Rig reference;
  build(edited, true);
  build(reference, true);
  edited.commit(1);
  reference.commit(1);
  for (uint32_t index = 0; index < 8; ++index) {
    edited.render(0.25F);
    reference.render(0.25F);
  }
  build(edited, false);
  expect(edited.prepare(2), DAW_AUDIO_CORE_OK);
  int attachment = 1;
  const std::array<daw::audio_core::NativeGraphHookBinding, 1> bindings{{
    {.node_id = 1, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .attachment = &attachment},
  }};
  expect(daw::audio_core::RegisterNativeGraphHook(edited.core, {
    .graph_revision = 2, .hook = native_graph_hook, .bindings = bindings}), DAW_AUDIO_CORE_OK);
  edited.publish(2);
  native_hook_calls = 0;
  const auto first = edited.render(0.25F);
  const auto before_edit = reference.render(0.25F);
  // Ghost, survivor, then the external stage that doubles node 1.
  assert(native_hook_calls == 1 && native_hook_nodes[0] == 1 && native_hook_stages[0] == 2);
  assert(native_hook_attachments[0] == &attachment);
  assert(std::abs(first[0][0] - 2.0F * before_edit[0][0]) < 1e-6F);
}

// Checkpoint 20: a staged processor patch is unresolved until it is applied or
// cancelled. Preparing beside it would copy the plan the callback is about to
// rewrite, so the prepare is refused and succeeds once the patch is settled.
void test_phase3_unresolved_patch_blocks_prepare() {
  Phase3Rig rig;
  rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE);
  rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER);
  rig.add_edge(1, 2);
  rig.add_utility(1, 10, 0.0F);
  rig.commit(1);
  const daw_audio_processor_state_patch patch{
    .graph_revision = 1, .node_id = 1, .instance_id = 10, .kind = DAW_AUDIO_PROCESSOR_KIND_UTILITY,
    .state_version = 1, .state_size = sizeof(daw_audio_utility_state),
    .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .state = reinterpret_cast<const uint8_t *>(&rig.utilities.back()),
  };
  expect(daw_audio_core_stage_processor_state_patch(rig.core, &patch), DAW_AUDIO_CORE_OK);
  expect(rig.prepare(2), DAW_AUDIO_CORE_PROCESSOR_PATCH_PENDING);
  expect(daw_audio_core_cancel_staged_processor_state_patch(rig.core), DAW_AUDIO_CORE_OK);
  expect(rig.prepare(2), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_cancel_prepared_graph(rig.core, 2), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_stage_processor_state_patch(rig.core, &patch), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_apply_staged_processor_state_patch(rig.core), DAW_AUDIO_CORE_OK);
  expect(rig.prepare(2), DAW_AUDIO_CORE_OK);
}

// Checkpoint 18: a compressor deleted from a chain keeps the external key that was
// pulling its program down while it fades. A ghost that fell back to its own input
// as the key would step the program level at the edit.
void test_phase3_deleted_compressor_keeps_its_external_sidechain() {
  const auto build = [](Phase3Rig &rig, bool with_compressor, bool with_key) {
    rig.clear();
    if (with_key) rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE, 0);
    rig.add_node(2, DAW_AUDIO_GRAPH_NODE_SOURCE, 1);
    rig.add_node(3, DAW_AUDIO_GRAPH_NODE_MASTER);
    rig.add_edge(2, 3);
    if (with_compressor) {
      rig.add_compressor(2, 20, -12.0F);
      rig.add_sidechain(1, 2, 20);
    }
  };
  constexpr float key = 1.0F;
  constexpr float program = 0.1F;
  for (const bool delete_key : {false, true}) {
    Phase3Rig edited;
    Phase3Rig reference;
    build(edited, true, true);
    build(reference, true, true);
    edited.commit(1);
    reference.commit(1);
    for (uint32_t index = 0; index < 16; ++index)
      assert(edited.render_keyed(key, program) == reference.render_keyed(key, program));
    // The oracle only means something when the key audibly ducks the program.
    assert(reference.render_keyed(key, program)[0][Phase3Rig::frames - 1] < 0.5F * program);
    edited.render_keyed(key, program);
    build(edited, false, !delete_key);
    expect(edited.prepare(2), DAW_AUDIO_CORE_OK);
    assert(daw_audio_core_prepared_graph_continuity(edited.core) == 1);
    edited.publish(2);
    const uint32_t fade = edited.fade_frames();
    for (uint32_t block = 0; block < (fade + Phase3Rig::frames - 1) / Phase3Rig::frames + 2; ++block) {
      const auto actual = edited.render_keyed(key, program);
      const auto before_edit = reference.render_keyed(key, program);
      for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame) {
        if (delete_key && block * Phase3Rig::frames + frame != 0) continue;
        // A deleted key source fades too, so only the first sample is the old output.
        const float wet = Phase3Rig::ramp(block * Phase3Rig::frames + frame, fade);
        const float expected = program + (before_edit[0][frame] - program) * wet;
        assert(std::abs(actual[0][frame] - expected) < 1e-5F);
        assert(std::abs(actual[1][frame] - expected) < 1e-5F);
      }
    }
    assert(std::abs(edited.render_keyed(key, program)[0][0] - program) < 1e-6F);
  }
}

// Checkpoint 19: removed processors that sit next to each other leave as one
// stage. Each one crossfading on its own would multiply the ramps together.
void test_phase3_adjacent_removed_processors_fade_as_one_stage() {
  constexpr float input = 0.01F;
  const auto gain = [](float db) { return std::pow(10.0F, db / 20.0F); };
  constexpr float double_db = 6.0206F;
  constexpr float triple_db = 9.5424F;
  constexpr float quintuple_db = 13.9794F;
  const auto build = [&](Phase3Rig &rig, bool first, bool second, bool third) {
    rig.clear();
    rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE);
    rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER);
    rig.add_edge(1, 2);
    if (first) rig.add_utility(1, 10, double_db);
    if (second) rig.add_utility(1, 11, triple_db);
    if (third) rig.add_utility(1, 12, quintuple_db);
  };
  {
    // x2 then x3 deleted together: one linear ramp from x6 to x1, so x3.5 halfway.
    Phase3Rig rig;
    build(rig, true, true, false);
    rig.commit(1);
    for (uint32_t index = 0; index < 16; ++index) rig.render(input);
    assert(std::abs(rig.render(input)[0][0] / input - 6.0F) < 1e-3F);
    build(rig, false, false, false);
    rig.commit(2);
    const uint32_t fade = rig.fade_frames();
    for (uint32_t block = 0; block < (fade + Phase3Rig::frames - 1) / Phase3Rig::frames + 2; ++block) {
      const auto output = rig.render(input);
      for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame) {
        const float wet = Phase3Rig::ramp(block * Phase3Rig::frames + frame, fade);
        assert(std::abs(output[0][frame] / input - (1.0F + 5.0F * wet)) < 2e-3F);
      }
    }
  }
  {
    // A fade already running keeps its own clock when two more stages are deleted
    // later: the old one and the new pair are separate transitions.
    Phase3Rig rig;
    build(rig, true, true, true);
    rig.commit(1);
    for (uint32_t index = 0; index < 16; ++index) rig.render(input);
    build(rig, false, true, true);
    rig.commit(2);
    rig.render(input);
    const uint32_t first_elapsed = Phase3Rig::frames;
    build(rig, false, false, false);
    rig.commit(3);
    const uint32_t fade = rig.fade_frames();
    const float pair = gain(triple_db) * gain(quintuple_db);
    for (uint32_t block = 0; block < (fade - first_elapsed) / Phase3Rig::frames; ++block) {
      const auto output = rig.render(input);
      for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame) {
        const uint32_t elapsed = block * Phase3Rig::frames + frame;
        const float first = 1.0F + (gain(double_db) - 1.0F) * Phase3Rig::ramp(first_elapsed + elapsed, fade);
        const float rest = 1.0F + (pair - 1.0F) * Phase3Rig::ramp(elapsed, fade);
        assert(std::abs(output[0][frame] / input - first * rest) < 5e-3F * first * rest);
      }
    }
  }
}

// Checkpoint 22: an edit to one object never disturbs another. Node 1 is a DC
// blocker ringing into the master; node 2 is an unrouted branch that takes each
// non-latency edit (bypass, layout, input bus, structural setting). The blocker's
// output must stay bit-identical to a rig that was never edited, and the same
// core must carry the edit (continuity 1), so the host never builds a cold core.
void test_phase3_non_latency_edit_touches_only_its_own_object() {
  enum class Edit { kBypass, kLayout, kInputBus, kStructure };
  for (const Edit edit : {Edit::kBypass, Edit::kLayout, Edit::kInputBus, Edit::kStructure}) {
    const auto build = [edit](Phase3Rig &rig, bool after) {
      rig.clear();
      rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE, 0);
      rig.add_node(2, DAW_AUDIO_GRAPH_NODE_SOURCE, 0);
      rig.add_node(3, DAW_AUDIO_GRAPH_NODE_MASTER);
      rig.add_edge(1, 3);
      rig.add_utility(1, 10, 0.0F, true);
      rig.add_utility(2, 20, 0.0F, after && edit == Edit::kStructure);
      if (!after) return;
      if (edit == Edit::kBypass) rig.processors.back().bypassed = 1;
      if (edit == Edit::kInputBus) rig.nodes[1].input_bus = 1;
      if (edit == Edit::kLayout) {
        rig.nodes[1].input_layout = rig.nodes[1].output_layout = DAW_AUDIO_GRAPH_LAYOUT_MONO;
        rig.processors.back().input_layout = rig.processors.back().output_layout = DAW_AUDIO_GRAPH_LAYOUT_MONO;
      }
    };
    Phase3Rig edited;
    Phase3Rig reference;
    build(edited, false);
    build(reference, false);
    edited.commit(1);
    reference.commit(1);
    for (uint32_t index = 0; index < 8; ++index) assert(edited.render(0.25F) == reference.render(0.25F));
    // The oracle only means something while the blocker still rings: a reset
    // would restart it at the full input level.
    assert(reference.render(0.25F)[0][Phase3Rig::frames - 1] < 0.15F);
    edited.render(0.25F);
    build(edited, true);
    expect(edited.prepare(2), DAW_AUDIO_CORE_OK);
    assert(daw_audio_core_prepared_graph_continuity(edited.core) == 1);
    edited.publish(2);
    for (uint32_t index = 0; index < 16; ++index) assert(edited.render(0.25F) == reference.render(0.25F));
  }
}

// Checkpoint 22: an edit the core cannot fade or order is a failed prepare, not a
// reset. Node 1 is the ringing witness. The prepare must name the failure, leave
// the active plan rendering bit-identically, and leave the core usable.
void test_phase3_edit_that_cannot_be_carried_fails_instead_of_resetting() {
  {
    // Deleting a zero-latency stage that changes layout: it has no dry path to fade to.
    const auto build = [](Phase3Rig &rig, bool converter) {
      rig.clear();
      rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE, 0);
      rig.add_node(2, DAW_AUDIO_GRAPH_NODE_SOURCE, 0);
      rig.add_node(3, DAW_AUDIO_GRAPH_NODE_MASTER);
      rig.nodes[1].input_layout = DAW_AUDIO_GRAPH_LAYOUT_MONO;
      rig.add_edge(1, 3);
      rig.add_utility(1, 10, 0.0F, true);
      if (!converter) return;
      rig.add_utility(2, 20);
      rig.processors.back().input_layout = DAW_AUDIO_GRAPH_LAYOUT_MONO;
    };
    Phase3Rig edited;
    Phase3Rig reference;
    build(edited, true);
    build(reference, true);
    edited.commit(1);
    reference.commit(1);
    for (uint32_t index = 0; index < 8; ++index) assert(edited.render(0.25F) == reference.render(0.25F));
    build(edited, false);
    expect(edited.prepare(2), DAW_AUDIO_CORE_GRAPH_COMPATIBILITY_REJECTED);
    expect(daw_audio_core_publish(edited.core, 2), DAW_AUDIO_CORE_STALE_REVISION);
    for (uint32_t index = 0; index < 8; ++index) assert(edited.render(0.25F) == reference.render(0.25F));
    // The core is not wedged: an edit it can carry prepares on the same core.
    build(edited, true);
    edited.processors.back().bypassed = 1;
    expect(edited.prepare(2), DAW_AUDIO_CORE_OK);
    assert(daw_audio_core_prepared_graph_continuity(edited.core) == 1);
    edited.publish(2);
    for (uint32_t index = 0; index < 8; ++index) assert(edited.render(0.25F) == reference.render(0.25F));
  }
  {
    // Deleting a node while a new edge routes its output back into its own source
    // would make the fading node part of a cycle.
    const auto build = [](Phase3Rig &rig, bool before) {
      rig.clear();
      rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE, 0);
      if (before) rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MIXER);
      rig.add_node(3, DAW_AUDIO_GRAPH_NODE_MIXER);
      rig.add_node(4, DAW_AUDIO_GRAPH_NODE_MASTER);
      rig.add_node(5, DAW_AUDIO_GRAPH_NODE_SOURCE, 0);
      if (before) {
        rig.add_edge(1, 2);
        rig.add_edge(2, 3);
        rig.add_edge(3, 4);
      } else {
        rig.add_edge(3, 1);
        rig.add_edge(1, 4);
      }
      rig.add_edge(5, 4);
      rig.add_utility(5, 10, 0.0F, true);
    };
    Phase3Rig edited;
    Phase3Rig reference;
    build(edited, true);
    build(reference, true);
    edited.commit(1);
    reference.commit(1);
    for (uint32_t index = 0; index < 8; ++index) assert(edited.render(0.25F) == reference.render(0.25F));
    build(edited, false);
    expect(edited.prepare(2), DAW_AUDIO_CORE_GRAPH_COMPATIBILITY_REJECTED);
    for (uint32_t index = 0; index < 8; ++index) assert(edited.render(0.25F) == reference.render(0.25F));
  }
}

// Checkpoint 23: a processor that is already fading out keeps its own clock when
// the node it sits on is deleted too. Its stage is at 11/15 of full level (64 of
// 240 frames elapsed); restarting it at full level would step the output.
void test_phase3_deleting_a_node_keeps_its_processors_running_fade() {
  constexpr float input = 0.01F;
  constexpr float sextuple_db = 15.5630F;
  Phase3Rig rig;
  const auto build = [&](bool with_source, bool with_stage) {
    rig.clear();
    if (with_source) rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE);
    rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER);
    if (with_source) rig.add_edge(1, 2);
    if (with_stage) rig.add_utility(1, 10, sextuple_db);
  };
  build(true, true);
  rig.commit(1);
  for (uint32_t index = 0; index < 16; ++index) rig.render(input);
  build(true, false);
  rig.commit(2);
  rig.render(input);
  const uint32_t fade = rig.fade_frames();
  const uint32_t stage_elapsed = Phase3Rig::frames;
  build(false, false);
  rig.commit(3);
  for (uint32_t block = 0; block < (fade + Phase3Rig::frames - 1) / Phase3Rig::frames + 1; ++block) {
    const auto output = rig.render(input);
    for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame) {
      const uint32_t elapsed = block * Phase3Rig::frames + frame;
      const float node = Phase3Rig::ramp(elapsed, fade);
      const float stage = 1.0F + 5.0F * Phase3Rig::ramp(stage_elapsed + elapsed, fade);
      assert(std::abs(output[0][frame] - input * node * stage) < 1e-4F * stage);
      assert(std::abs(output[1][frame] - input * node * stage) < 1e-4F * stage);
    }
  }
  assert(rig.render(input)[0][0] == 0.0F);
}

// Checkpoint 24: a key source deleted from a surviving compressor hands the
// detector back to the compressor's own input as the key fades. Left on an
// external key that has faded to silence, the compressor never reduces again
// until some later publication.
void test_phase3_deleted_key_hands_the_detector_back_to_its_own_input() {
  constexpr float program = 0.8F;
  const auto build = [](Phase3Rig &rig, bool with_key) {
    rig.clear();
    if (with_key) rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE, 0);
    rig.add_node(2, DAW_AUDIO_GRAPH_NODE_SOURCE, 1);
    rig.add_node(3, DAW_AUDIO_GRAPH_NODE_MASTER);
    rig.add_edge(2, 3);
    rig.add_compressor(2, 20, -12.0F);
    if (with_key) rig.add_sidechain(1, 2, 20);
  };
  Phase3Rig settled;
  build(settled, false);
  settled.commit(1);
  Phase3Rig::Block steady{};
  for (uint32_t index = 0; index < 400; ++index) steady = settled.render_keyed(1.0F, program);
  const float requested = steady[0][Phase3Rig::frames - 1];
  // The oracle only means something when the compressor audibly reduces its own input.
  assert(requested < 0.5F * program);

  Phase3Rig rig;
  build(rig, true);
  rig.commit(1);
  Phase3Rig::Block block{};
  for (uint32_t index = 0; index < 16; ++index) block = rig.render_keyed(1.0F, program);
  float previous = block[0][Phase3Rig::frames - 1];
  build(rig, false);
  expect(rig.prepare(2), DAW_AUDIO_CORE_OK);
  assert(daw_audio_core_prepared_graph_continuity(rig.core) == 1);
  rig.publish(2);
  float largest_step = 0.0F;
  for (uint32_t index = 0; index < 400; ++index) {
    block = rig.render_keyed(1.0F, program);
    for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame) {
      largest_step = std::max(largest_step, std::abs(block[0][frame] - previous));
      previous = block[0][frame];
      assert(block[0][frame] == block[1][frame]);
    }
  }
  assert(std::abs(block[0][Phase3Rig::frames - 1] - requested) < 1e-4F);
  // Measured 1.3e-4 per sample across the whole hand-back; a step from a detector
  // switching sources at the end of the fade would be of the order of the program level.
  assert(largest_step < 1e-3F);
}

// Prints what was measured before aborting, so a failing contract names its numbers.
void phase3_require(bool ok, const char *what, float actual, float expected, uint32_t index = 0) {
  if (ok) return;
  std::fprintf(stderr, "phase 3 contract: %s: sample %u actual %.6f expected %.6f\n", what, index, actual, expected);
  std::abort();
}

uint32_t bypass_ramp_frames(uint32_t sample_rate) { return (sample_rate + 50u) / 100u; }

// All seventeen product processor kinds.
constexpr std::array<const char *, 17> kBypassKindNames{"utility", "saturator", "eq", "gate", "compressor", "limiter",
  "chorus", "flanger", "phaser", "tremolo", "autopan", "ensemble", "delay", "reverb", "spectral", "autofilter", "lofi"};
constexpr std::array<const char *, 17> kBypassKindStages{"stage-one", "stage-two", "eq", "gate", "compressor", "limiter",
  "chorus", "flanger", "phaser", "tremolo", "autopan", "ensemble", "delay", "reverb", "spectral", "autofilter", "lofi"};

// One sounding stage of each kind between a source and the master. Every one
// processes a 220 Hz tone audibly (wet and dry differ by more than 0.1). The
// stage is the compiler's own record (compiled-processors.txt): a bypassed one has
// the plan flag set, the state's enabled flag cleared and the kind's complete set of
// automatable parameters declared, and its latency is the node's.
void bypass_subject(Phase3Rig &rig, uint32_t which, uint32_t bypassed) {
  rig.clear();
  rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE);
  rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER);
  rig.add_edge(1, 2);
  rig.add_compiled(1, std::string(kBypassKindStages[which]) + (bypassed != 0 ? "-off" : ""));
}

// Checkpoint 26: bypass is one mechanism. Whatever the kind, toggling it moves the
// output from the processed signal to the dry one along the same 10 ms linear ramp,
// in both directions, with the processor's own state running throughout.
void test_phase3_every_kind_bypass_ramps_alike() {
  for (uint32_t which = 0; which < kBypassKindNames.size(); ++which) {
    // The edited rig is toggled; two references run the same tone beside it, one that
    // is never bypassed (the processed signal, with its state running) and one that
    // is bypassed from the start (the dry signal as the kind delays it). The output
    // must be the straight line between them, whatever the kind does to a signal.
    Phase3Rig edited, wet_reference, dry_reference;
    const uint32_t ramp = bypass_ramp_frames(edited.sample_rate);
    // The auto filter writes its mix into its latency line, so its ramp reaches the
    // output that many frames late. Every other kind ramps at its output.
    const uint32_t lag = std::strcmp(kBypassKindNames[which], "autofilter") == 0
      ? compiled_processor("autofilter").latency_frames : 0;
    bypass_subject(edited, which, 0);
    bypass_subject(wet_reference, which, 0);
    bypass_subject(dry_reference, which, 1);
    edited.commit(1);
    wet_reference.commit(1);
    dry_reference.commit(1);
    const auto step = [&] {
      return std::array{edited.render_tone(220.0F, 0.4F, 1.0F), wet_reference.render_tone(220.0F, 0.4F, 1.0F),
        dry_reference.render_tone(220.0F, 0.4F, 1.0F)};
    };
    for (uint32_t index = 0; index < 120; ++index) step();
    float audible = 0.0F;
    for (uint32_t index = 0; index < 8; ++index) {
      const auto blocks = step();
      for (uint32_t channel = 0; channel < 2; ++channel) {
        for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame) {
          audible = std::max(audible, std::abs(blocks[1][channel][frame] - blocks[2][channel][frame]));
        }
      }
    }
    phase3_require(audible > 0.1F, kBypassKindNames[which], audible, 0.1F);
    for (const uint32_t bypassed : {1u, 0u}) {
      bypass_subject(edited, which, bypassed);
      edited.commit(bypassed != 0 ? 2 : 3);
      uint32_t elapsed = 0;
      for (uint32_t index = 0; index < ramp / Phase3Rig::frames + 4; ++index) {
        const auto blocks = step();
        for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame, ++elapsed) {
          const float moved = std::clamp(static_cast<float>(elapsed + 1) - static_cast<float>(lag), 0.0F, static_cast<float>(ramp))
            / static_cast<float>(ramp);
          const float toward = bypassed != 0 ? moved : 1.0F - moved;
          for (uint32_t channel = 0; channel < 2; ++channel) {
            const float expected = blocks[1][channel][frame] + toward * (blocks[2][channel][frame] - blocks[1][channel][frame]);
            phase3_require(std::abs(blocks[0][channel][frame] - expected) < 2e-4F,
              kBypassKindNames[which], blocks[0][channel][frame], expected, elapsed);
          }
        }
      }
    }
  }
}

// Checkpoint 27: a processor replaced while its bypass is mid-ramp carries the ramp
// position over, so the output keeps moving along the same line instead of
// jumping to either end. The position is handed over on the callback side.
void test_phase3_restructure_mid_bypass_keeps_the_ramp() {
  const auto build = [](Phase3Rig &rig, uint32_t bypassed, bool swap) {
    rig.clear();
    rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE);
    rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER);
    rig.add_edge(1, 2);
    rig.add_utility(1, 10, 6.0206F);
    rig.utilities.back().swap = swap ? 1 : 0;
    rig.utilities.back().enabled = bypassed != 0 ? 0u : 1u;
    rig.declare_target(DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB);
    rig.processors.back().bypassed = bypassed;
  };
  Phase3Rig rig;
  const uint32_t ramp = bypass_ramp_frames(rig.sample_rate);
  build(rig, 0, false);
  rig.commit(1);
  for (uint32_t index = 0; index < 20; ++index) rig.render(0.25F);
  build(rig, 1, false);
  rig.commit(2);
  uint32_t elapsed = 0;
  const auto check = [&](uint32_t blocks) {
    for (uint32_t index = 0; index < blocks; ++index) {
      const auto block = rig.render(0.25F);
      for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame, ++elapsed) {
        const float expected = 0.5F - 0.25F * std::min(1.0F, static_cast<float>(elapsed + 1) / static_cast<float>(ramp));
        phase3_require(std::abs(block[0][frame] - expected) < 1e-5F, "bypass ramp restarted", block[0][frame], expected, elapsed);
      }
    }
  };
  check(1);
  // A swapped channel order is silent on a centred input but replaces the slot.
  build(rig, 1, true);
  rig.commit(3);
  check(ramp / Phase3Rig::frames + 3);
}

// Checkpoint 29: deleting a group and routing its children straight to its parent
// moves them from the group's path to the direct one with complementary levels, so
// the children are never summed twice.
void test_phase3_ungroup_hands_children_from_the_group_to_the_direct_route() {
  for (const bool processed : {false, true}) {
    const auto build = [processed](Phase3Rig &rig, bool grouped) {
      rig.clear();
      rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE);
      if (grouped) rig.add_node(5, DAW_AUDIO_GRAPH_NODE_MIXER);
      rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER);
      if (grouped) {
        rig.add_edge(1, 5);
        rig.add_edge(5, 2);
        if (processed) rig.add_utility(5, 50, 6.0206F);
      } else {
        rig.add_edge(1, 2);
      }
    };
    Phase3Rig rig;
    build(rig, true);
    rig.commit(1);
    for (uint32_t index = 0; index < 8; ++index) rig.render(0.25F);
    build(rig, false);
    rig.commit(2);
    const float before = processed ? 0.5F : 0.25F;
    const uint32_t fade = rig.fade_frames();
    for (uint32_t index = 0; index < fade / Phase3Rig::frames + 3; ++index) {
      const auto block = rig.render(0.25F);
      for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame) {
        const float expected = 0.25F + Phase3Rig::ramp(index * Phase3Rig::frames + frame, fade) * (before - 0.25F);
        phase3_require(std::abs(block[0][frame] - expected) < 1e-5F && std::abs(block[1][frame] - expected) < 1e-5F,
          processed ? "processed ungroup" : "unity ungroup", block[0][frame], expected, index * Phase3Rig::frames + frame);
      }
    }
  }
}

// Checkpoint 30: deleting a send (a route between two surviving nodes) fades its
// contribution out over the deletion fade like any other sounding object, and
// adding one fades it in.
void test_phase3_send_deletion_and_addition_ramp() {
  const auto build = [](Phase3Rig &rig, bool send) {
    rig.clear();
    rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE);
    rig.add_node(9, DAW_AUDIO_GRAPH_NODE_MIXER);
    rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER);
    rig.add_edge(1, 2);
    rig.edges.back().id = 1;
    rig.add_edge(9, 2);
    rig.edges.back().id = 2;
    if (send) {
      rig.add_edge(1, 9, 0.5F);
      rig.edges.back().id = 3;
    }
    rig.add_utility(9, 90, 0.0F);
  };
  for (const bool deleting : {true, false}) {
    Phase3Rig rig;
    build(rig, deleting);
    rig.commit(1);
    for (uint32_t index = 0; index < 8; ++index) rig.render(0.25F);
    build(rig, !deleting);
    rig.commit(2);
    const float with_send = 0.375F;
    const float without_send = 0.25F;
    const uint32_t fade = rig.fade_frames();
    for (uint32_t index = 0; index < fade / Phase3Rig::frames + 3; ++index) {
      const auto block = rig.render(0.25F);
      for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame) {
        const float remaining = Phase3Rig::ramp(index * Phase3Rig::frames + frame, fade);
        const float expected = deleting ? without_send + remaining * (with_send - without_send)
          : with_send + remaining * (without_send - with_send);
        phase3_require(std::abs(block[0][frame] - expected) < 1e-5F, deleting ? "deleted send" : "added send",
          block[0][frame], expected, index * Phase3Rig::frames + frame);
      }
    }
  }
}

// Checkpoint 31: a node whose channel layout changes (mono <-> stereo) while it
// sounds changes what it outputs at once; the difference is handed back over the
// deletion fade, and a node beside it is bit-for-bit untouched.
void test_phase3_layout_change_ramps(bool to_mono) {
  const auto build = [](Phase3Rig &rig, bool mono) {
    rig.clear();
    rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE, 0);
    if (mono) rig.nodes.back().input_layout = rig.nodes.back().output_layout = DAW_AUDIO_GRAPH_LAYOUT_MONO;
    rig.add_node(3, DAW_AUDIO_GRAPH_NODE_SOURCE, 0);
    rig.nodes.back().id = 3;
    rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER);
    rig.add_edge(1, 2);
    rig.add_edge(3, 2, 0.5F);
  };
  Phase3Rig edited;
  Phase3Rig reference;
  build(edited, !to_mono);
  build(reference, !to_mono);
  edited.commit(1);
  reference.commit(1);
  for (uint32_t block = 0; block < 4; ++block) {
    assert(edited.render_stereo(0.8F, 0.2F) == reference.render_stereo(0.8F, 0.2F));
  }
  const Phase3Rig::Block before = edited.render_stereo(0.8F, 0.2F);
  build(edited, to_mono);
  edited.commit(2);
  const uint32_t fade = edited.fade_frames();
  std::vector<float> left;
  std::vector<float> right;
  for (uint32_t block = 0; block < 8; ++block) {
    const Phase3Rig::Block actual = edited.render_stereo(0.8F, 0.2F);
    left.insert(left.end(), actual[0].begin(), actual[0].end());
    right.insert(right.end(), actual[1].begin(), actual[1].end());
  }
  const Phase3Rig::Block steady = edited.render_stereo(0.8F, 0.2F);
  // Source 1 mono: both sides 0.5; stereo: 0.8 / 0.2. Source 3 adds 0.5 * (0.8, 0.2).
  const float from_left = (to_mono ? 0.8F : 0.5F) + 0.4F;
  const float to_left = (to_mono ? 0.5F : 0.8F) + 0.4F;
  const float spread = std::abs(to_left - from_left);
  assert(std::abs(before[0][63] - from_left) <= 1e-6F);
  const auto fail = [&](const char *what, uint32_t index, float actual, float expected) {
    std::fprintf(stderr, "layout change (%s): %s at sample %u: actual %.6f expected %.6f\n",
      to_mono ? "to mono" : "to stereo", what, index, actual, expected);
    std::abort();
  };
  float previous = before[0][63];
  for (uint32_t index = 0; index < left.size(); ++index) {
    if (std::abs(left[index] - previous) > 4.0F * spread / static_cast<float>(fade) + 1e-6F) {
      fail("step", index, left[index], previous);
    }
    previous = left[index];
    // The node folds before its chain and again after its fader, both moving over
    // the fade (Checkpoint 38): a source holding (0.8, 0.2) mixed down is the
    // crossfade applied twice, a smooth curve between the two ends with no step.
    const float remaining = Phase3Rig::ramp(index, fade);
    const float fold = to_mono ? 1.0F - remaining : remaining;
    const float once = 0.8F + fold * (0.5F - 0.8F);
    const float expected = once + fold * (0.5F - once) + 0.4F;
    if (std::abs(left[index] - expected) > 4.0F * spread / static_cast<float>(fade) + 1e-6F) {
      fail("not the folded crossfade", index, left[index], expected);
    }
  }
  assert(std::abs(steady[0][63] - to_left) <= 1e-6F);
  assert(std::abs(steady[1][63] - ((to_mono ? 0.5F : 0.2F) + 0.1F)) <= 1e-6F);
}

// Captures one node's output on every block, whatever the master mix does.
struct NodeCapture {
  uint64_t node_id = 0;
  std::array<float, 64> left{};
  std::array<float, 64> right{};
  static void observe(const daw::audio_core::NativeGraphNodeRender &render) noexcept {
    NodeCapture &capture = *static_cast<NodeCapture *>(render.attachment);
    if (render.node_id != capture.node_id) return;
    for (uint32_t frame = 0; frame < render.frame_count; ++frame) {
      capture.left[frame] = render.planes[0][frame];
      capture.right[frame] = render.planes[1][frame];
    }
  }
};

// Checkpoint 32: an instrument whose configuration changes while it plays is
// replaced by one that takes over its voices. Its output does not step; the other
// instrument is bit-for-bit what it would have been.
void test_phase3_instrument_replacement_hands_over_without_a_step() {
  const daw_audio_synth_state synth{
    .version = 1, .seed = 19,
    .oscillators = {{.enabled = 1, .waveform = DAW_AUDIO_SYNTH_WAVEFORM_SINE, .level = 0.5F}},
    .filter_cutoff_hz = 1000.0F, .filter_resonance = 0.7F,
    .filter_sustain = 0.5F, .amp_sustain = 1.0F, .amp_release_ms = 1.0F,
    .lfo_rate_hz = 1.0F, .output_gain = 0.75F,
  };
  daw_audio_synth_state replacement = synth;
  replacement.output_gain = 0.375F;
  replacement.lfo_waveform = 1;  // inaudible (the LFO is off) and discrete, so the edit replaces the instrument
  std::array<daw_audio_graph_node_descriptor, 3> nodes{{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_INSTRUMENT, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .instrument = {.kind = DAW_AUDIO_INSTRUMENT_KIND_SYNTH, .version = 1, .voice_capacity = 2}},
    {.id = 3, .kind = DAW_AUDIO_GRAPH_NODE_INSTRUMENT, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .instrument = {.kind = DAW_AUDIO_INSTRUMENT_KIND_SYNTH, .version = 1, .voice_capacity = 2}},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO},
  }};
  const std::array<daw_audio_graph_edge_descriptor, 2> edges{{
    {.id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER},
    {.id = 2, .from_node_id = 3, .to_node_id = 2, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER},
  }};
  struct Side {
    daw_audio_core_handle core = create_core(64, 2, 1);
    NodeCapture witness{.node_id = 3};
    uint32_t revision = 0;
    ~Side() { daw_audio_core_destroy(core); }
    void commit(const std::array<daw_audio_graph_node_descriptor, 3> &graph,
      const std::array<daw_audio_graph_edge_descriptor, 2> &routes, const daw_audio_synth_state &first,
      const daw_audio_synth_state &second) {
      const daw_audio_graph_prepare_request request{
        .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = ++revision,
        .node_count = 3, .edge_count = 2, .nodes = graph.data(), .edges = routes.data(),
      };
      expect(daw_audio_core_prepare_graph(core, &request), DAW_AUDIO_CORE_OK);
      expect(daw_audio_core_configure_synth(core, 1, &first), DAW_AUDIO_CORE_OK);
      expect(daw_audio_core_configure_synth(core, 3, &second), DAW_AUDIO_CORE_OK);
      expect(daw::audio_core::RegisterNativeGraphHook(core, {
        .graph_revision = revision, .observer = &NodeCapture::observe, .observer_attachment = &witness}),
        DAW_AUDIO_CORE_OK);
      expect(daw_audio_core_publish(core, revision), DAW_AUDIO_CORE_OK);
    }
    std::array<std::array<float, 64>, 2> render(bool start) {
      const std::array<daw_audio_instrument_event, 2> events{{
        {.node_id = 1, .note_id = 1, .sequence = 1, .epoch = 1, .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON,
          .note = 69, .value = 1.0F},
        {.node_id = 3, .note_id = 2, .sequence = 2, .epoch = 1, .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON,
          .note = 64, .value = 1.0F},
      }};
      std::array<std::array<float, 64>, 2> samples{};
      float *outputs[]{samples[0].data(), samples[1].data()};
      const daw_audio_core_process_block block{
        .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = 64, .channel_count = 2,
        .outputs = outputs, .graph_revision = revision, .transport_epoch = 1,
        .instrument_event_count = start ? 2u : 0u, .instrument_events = start ? events.data() : nullptr,
      };
      expect(daw_audio_core_process(core, &block), DAW_AUDIO_CORE_OK);
      return samples;
    }
  };
  Side edited;
  Side reference;
  Side renewed;  // plays the replacement's configuration from the start
  for (Side *side : {&edited, &reference, &renewed}) {
    side->commit(nodes, edges, side == &renewed ? replacement : synth, synth);
    const daw_audio_transport_state transport{.epoch = 1, .running = 1};
    expect(daw_audio_core_set_transport(side->core, &transport), DAW_AUDIO_CORE_OK);
  }
  float last_before_edit = 0.0F;
  for (uint32_t block = 0; block < 12; ++block) {
    const auto steady = edited.render(block == 0);
    assert(steady == reference.render(block == 0));
    renewed.render(block == 0);
    last_before_edit = steady[0][63];
  }
  edited.commit(nodes, edges, replacement, synth);
  const uint32_t fade = 240;
  std::vector<float> total{last_before_edit};
  std::vector<float> reference_total;
  std::vector<float> renewed_total;
  std::vector<float> witness_total;
  float reference_step = 0.0F;
  // Long enough for the seeded gain to finish its slew onto the new configuration.
  for (uint32_t block = 0; block < 60; ++block) {
    const auto actual = edited.render(false);
    const auto expected = reference.render(false);
    const auto carried = renewed.render(false);
    for (uint32_t frame = 0; frame < 64; ++frame) {
      if (edited.witness.left[frame] != reference.witness.left[frame]
        || edited.witness.right[frame] != reference.witness.right[frame]) {
        std::fprintf(stderr, "instrument replacement: the untouched instrument changed at block %u\n", block);
        std::abort();
      }
      if (!reference_total.empty()) reference_step = std::max(reference_step, std::abs(expected[0][frame] - reference_total.back()));
      total.push_back(actual[0][frame]);
      reference_total.push_back(expected[0][frame]);
      renewed_total.push_back(carried[0][frame]);
      witness_total.push_back(edited.witness.left[frame]);
    }
  }
  const float bound = reference_step + 4.0F * 0.375F / static_cast<float>(fade) + 1e-4F;
  for (uint32_t index = 1; index < total.size(); ++index) {
    if (std::abs(total[index] - total[index - 1]) > bound) {
      std::fprintf(stderr, "instrument replacement: step %.6f at sample %u exceeds %.6f\n",
        std::abs(total[index] - total[index - 1]), index, bound);
      std::abort();
    }
  }
  float replaced_voice = 0.0F;
  for (uint32_t index = static_cast<uint32_t>(total.size()) - 128; index < total.size(); ++index) {
    // Once the fade has run the edited instrument is the replacement's configuration
    // on the note it was already holding, beside the untouched one.
    assert(std::abs(total[index] - renewed_total[index - 1]) <= 1e-5F);
    replaced_voice = std::max(replaced_voice, std::abs(reference_total[index - 1] - witness_total[index - 1]));
  }
  // The oracle above is only meaningful if the instrument was sounding and the edit replaced it.
  assert(replaced_voice > 0.05F);
}

// `edit` marks the synth as another edit of the same instrument: it sets the LFO
// shape (the LFO is off, so nothing is heard), a discrete field, so a synth with a
// different `edit` replaces the instrument where a different gain alone only moves it.
daw_audio_synth_state phase3_synth(float output_gain, uint32_t edit = 0) {
  return {
    .version = 1, .seed = 19,
    .oscillators = {{.enabled = 1, .waveform = DAW_AUDIO_SYNTH_WAVEFORM_SINE, .level = 0.5F}},
    .filter_cutoff_hz = 1000.0F, .filter_resonance = 0.7F,
    .filter_sustain = 0.5F, .amp_sustain = 1.0F, .amp_release_ms = 1.0F,
    .lfo_waveform = edit, .lfo_rate_hz = 1.0F, .output_gain = output_gain,
  };
}

// A reference keeps running without edits. Every audible sample, including the
// fade and the shifted continuation, must come from that same held voice/tail.
// Resetting retained DSP, retriggering a note, or fading twice fails this oracle.
void test_phase4_retained_signal(bool synth, bool keyed = false) {
  Phase3Rig edited;
  Phase3Rig reference;
  Phase3Fixture tail_state;
  tail_state.use_long_wet_reverb();
  for (auto *rig : {&edited, &reference}) {
    if (keyed) {
      rig->add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE, 0);
      rig->add_node(2, DAW_AUDIO_GRAPH_NODE_SOURCE, 1);
      rig->add_node(3, DAW_AUDIO_GRAPH_NODE_MASTER);
      rig->add_node(4, DAW_AUDIO_GRAPH_NODE_SOURCE, DAW_AUDIO_GRAPH_INPUT_BUS_DISCONNECTED);
      rig->add_compressor(2, 20, -12.0F);
      rig->processors.back().latency_frames = 480;
      rig->nodes[1].latency_frames = rig->nodes[3].latency_frames = 480;
      rig->add_edge(2, 3);
      rig->add_edge(4, 3, 0.0F);
      rig->add_sidechain(1, 2, 20);
    } else {
      if (synth) rig->add_instrument(1, phase3_synth(0.5F));
      else {
        rig->add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE);
        rig->add_bytes(1, 10, DAW_AUDIO_PROCESSOR_KIND_REVERB,
          tail_state.reverb.data(), tail_state.reverb.size());
      }
      rig->add_node(2, DAW_AUDIO_GRAPH_NODE_SOURCE);
      rig->add_node(3, DAW_AUDIO_GRAPH_NODE_MASTER);
      rig->add_edge(1, 3);
      rig->add_edge(2, 3, 0.0F);
    }
    rig->commit(1);
    if (synth) rig->note_on(1, 48);
    else {
      rig->transport_epoch = 1;
      const daw_audio_transport_state transport{.epoch = 1, .running = 1};
      expect(daw_audio_core_set_transport(rig->core, &transport), DAW_AUDIO_CORE_OK);
    }
  }
  std::vector<std::array<float, 2>> trace;
  const auto render = [keyed](Phase3Rig &rig, float excitation) {
    return keyed ? rig.render_keyed(1.0F, 0.1F) : rig.render(excitation);
  };
  const auto append_reference = [&](const Phase3Rig::Block &block) {
    for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame)
      trace.push_back({block[0][frame], block[1][frame]});
  };
  for (uint32_t block = 0; block < 96; ++block) {
    const float excitation = !synth && block == 0 ? 1.0F : 0.0F;
    const auto expected = render(reference, excitation);
    assert(render(edited, excitation) == expected);
    append_reference(expected);
  }
  double energy = 0.0;
  for (uint32_t revision = 2; revision <= 3; ++revision) {
    edited.nodes[keyed ? 3 : 1].latency_frames = (keyed ? 480u : 0u) + (revision == 2 ? 1024u : 0u);
    edited.edges[0].pdc_delay_frames = revision == 2 ? 1024u : 0u;
    expect(edited.prepare(revision), DAW_AUDIO_CORE_OK);
    edited.publish(revision);
    const uint64_t publication = trace.size();
    const uint64_t seam = publication + edited.fade_frames();
    for (uint32_t block = 0; block < 64; ++block) {
      const uint64_t start = trace.size();
      append_reference(render(reference, 0.0F));
      const auto actual = render(edited, 0.0F);
      for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame) {
        const uint64_t absolute = start + frame;
        const uint32_t delay = revision == 2 && absolute < seam ? 0u : 1024u;
        float gain = 1.0F;
        if (revision == 2 && absolute < seam) gain = static_cast<float>(seam - absolute) / edited.fade_frames();
        else if (revision == 2 && absolute < seam + edited.fade_frames())
          gain = static_cast<float>(absolute - seam) / edited.fade_frames();
        for (uint32_t channel = 0; channel < 2; ++channel) {
          const float expected = trace[absolute - delay][channel] * gain;
          assert(actual[channel][frame] == expected);
          energy += static_cast<double>(expected) * expected;
        }
      }
    }
  }
  assert(energy > 1e-8);
  std::printf("phase4 retained %s: raise/lower PCM exact, energy=%g\n",
    keyed ? "sidechain-key" : synth ? "held-note" : "reverb-tail", energy);
}

// Stopped seeks reset the DC estimate; a running locate's paused priming phase
// preserves it. Neither path resets the other processor histories.
void test_phase4_seek_discards_dc_bias() {
  Phase3Rig edited;
  Phase3Rig reference;
  for (auto *rig : {&edited, &reference}) {
    rig->add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE, 0);
    rig->add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER);
    rig->add_edge(1, 2);
    rig->add_utility(1, 10, 0.0F, true);
    rig->commit(1);
    const daw_audio_transport_state playing{.epoch = 1, .running = 1, .frame = 4096};
    expect(daw_audio_core_set_transport(rig->core, &playing), DAW_AUDIO_CORE_OK);
  }
  for (uint32_t block = 0; block < 16; ++block) {
    edited.render(0.25F);
    reference.render(-0.5F);
  }
  const daw_audio_transport_state stopped{.epoch = 1, .running = 0, .frame = 5120};
  for (auto *rig : {&edited, &reference})
    expect(daw_audio_core_set_transport(rig->core, &stopped), DAW_AUDIO_CORE_OK);
  const daw_audio_transport_state seek{.epoch = 2, .running = 0, .frame = 0};
  for (auto *rig : {&edited, &reference})
    expect(daw_audio_core_set_transport(rig->core, &seek), DAW_AUDIO_CORE_OK);
  const auto actual = edited.render(0.125F);
  const auto expected = reference.render(0.125F);
  std::fprintf(stderr, "seek DC actual=%g reference=%g\n", actual[0][0], expected[0][0]);
  assert(actual == expected);
  // A running locate also primes its new epoch with running=false. It must
  // preserve the estimate, unlike a seek that originates in stopped transport.
  const daw_audio_transport_state playing{.epoch = 2, .running = 1, .frame = 0};
  for (auto *rig : {&edited, &reference}) {
    expect(daw_audio_core_set_transport(rig->core, &playing), DAW_AUDIO_CORE_OK);
    for (unsigned block = 0; block < 16; ++block) rig->render(.25F);
  }
  const daw_audio_transport_state locating{.epoch = 3, .running = 0, .frame = 8192};
  expect(daw_audio_core_set_transport(edited.core, &locating), DAW_AUDIO_CORE_OK);
  const daw_audio_transport_state resume{.epoch = 3, .running = 1, .frame = 8192};
  expect(daw_audio_core_set_transport(edited.core, &resume), DAW_AUDIO_CORE_OK);
  const auto located = edited.render(.125F);
  const auto continuous = reference.render(.125F);
  std::fprintf(stderr, "running seek DC actual=%g continuous=%g\n", located[0][0], continuous[0][0]);
  assert(located == continuous);
  // The same running-locate sequence must also retain an audible reverb tail,
  // with the DC blocker downstream of that tail.
  Phase3Fixture tail_state;
  tail_state.use_long_wet_reverb();
  for (auto *rig : {&edited, &reference}) {
    rig->add_bytes(1, 20, DAW_AUDIO_PROCESSOR_KIND_REVERB,
      tail_state.reverb.data(), tail_state.reverb.size());
    rig->add_utility(1, 30, 0.F, true);
    rig->commit(2);
  }
  for (unsigned block = 0; block < 96; ++block)
    assert(edited.render(.25F) == reference.render(.25F));
  const daw_audio_transport_state tail_seek{.epoch = 4, .running = 0, .frame = 16384};
  const daw_audio_transport_state tail_resume{.epoch = 4, .running = 1, .frame = 16384};
  expect(daw_audio_core_set_transport(edited.core, &tail_seek), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_set_transport(edited.core, &tail_resume), DAW_AUDIO_CORE_OK);
  double energy = 0;
  for (unsigned block = 0; block < 128; ++block) {
    const auto tail = edited.render(0.F);
    assert(tail == reference.render(0.F));
    for (float value : tail[0]) energy += value * value;
  }
  assert(energy > 1e-8);
  std::fprintf(stderr, "running seek reverb/DC tail exact energy=%g\n", energy);
}

void test_phase4_keep_routing(bool send, bool mixed) {
  Phase3Rig rig;
  rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE, 0);
  rig.nodes.back().keep_latency = 1;
  rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MIXER);
  rig.add_node(3, DAW_AUDIO_GRAPH_NODE_SOURCE, 1);
  rig.add_node(4, DAW_AUDIO_GRAPH_NODE_SOURCE, DAW_AUDIO_GRAPH_INPUT_BUS_DISCONNECTED);
  rig.nodes.back().latency_frames = 2048;
  rig.add_node(5, DAW_AUDIO_GRAPH_NODE_MASTER);
  rig.add_edge(1, 2, send ? 0.5F : 1.0F);
  rig.add_edge(2, 5);
  if (send) rig.add_edge(1, 5, 0.5F);
  rig.add_edge(3, mixed ? 2 : 5, 0.5F);
  rig.add_edge(4, 5);
  for (auto &edge : rig.edges) if (edge.to_node_id == 5 && edge.from_node_id != 4) edge.pdc_delay_frames = 2048;
  rig.commit(1);
  const auto signal = [](uint32_t block) { return static_cast<float>(1u + block % 13u) / 64.0F; };
  for (uint32_t block = 0; block < 128; ++block) {
    const auto actual = rig.render_keyed(signal(block), signal(block) * 0.25F);
    const float normal = block < 32 ? 0.0F : signal(block - 32) * 0.125F;
    for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame) {
      const float expected = signal(block) + normal;
      if (actual[0][frame] != expected || actual[1][frame] != expected) {
        std::fprintf(stderr, "Keep Latency %s block=%u frame=%u actual=%g expected=%g (kept now + normal delayed 2048)\n",
          mixed ? "mixed-group" : send ? "send-return" : "group", block, frame, actual[0][frame], expected);
        assert(false);
      }
    }
  }
  std::printf("Keep Latency %s: exact kept and normal PCM\n", mixed ? "mixed-group" : send ? "send-return" : "group");
}

void test_phase4_fft_change_audible(uint32_t lag_blocks = 1) {
  Phase3Rig rig;
  Phase3Rig reference;
  rig.witness_node = reference.witness_node = 2;
  const auto build = [](Phase3Rig &target, uint32_t fft) {
    target.clear();
    target.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE);
    target.add_node(2, DAW_AUDIO_GRAPH_NODE_SOURCE);
    target.add_node(3, DAW_AUDIO_GRAPH_NODE_MASTER);
    target.add_edge(1, 3);
    target.add_edge(2, 3, 0.0F);
    std::array<uint8_t, 60> state{};
    const auto put = [&](uint32_t offset, uint32_t value) { std::memcpy(state.data() + offset, &value, 4); };
    const auto number = [&](uint32_t offset, float value) { std::memcpy(state.data() + offset, &value, 4); };
    put(0, 1); put(4, fft); put(8, 4); put(12, DAW_AUDIO_SPECTRAL_MODE_FREEZE);
    number(20, -60.0F); number(24, 1.0F); number(28, 20.0F);
    number(52, 1.0F); number(56, 1.0F);
    target.add_bytes(1, 10, DAW_AUDIO_PROCESSOR_KIND_SPECTRAL, state.data(), state.size());
    target.processors.back().latency_frames = fft;
    target.nodes[0].latency_frames = fft;
    target.edges[1].pdc_delay_frames = fft;
  };
  build(rig, 512); build(reference, 512);
  rig.commit(1); reference.commit(1);
  const daw_audio_transport_state transport{.epoch = 1, .running = 1};
  expect(daw_audio_core_set_transport(rig.core, &transport), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_set_transport(reference.core, &transport), DAW_AUDIO_CORE_OK);
  uint64_t position = 0;
  std::vector<std::array<float, 2>> stage_trace;
  const auto tone = [](uint64_t frame, uint32_t channel) -> float {
    return channel == 0 ? 0.25F * std::sin(6.283185307179586 * frame / 137.0)
      : 0.125F * std::cos(6.283185307179586 * frame / 93.0);
  };
  const auto render = [&] {
    std::array<float, Phase3Rig::frames> left{}, right{};
    for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame) {
      left[frame] = tone(position + frame, 0);
      right[frame] = tone(position + frame, 1);
      const uint64_t absolute = position + frame;
      stage_trace.push_back(absolute < 512 ? std::array<float, 2>{}
        : std::array<float, 2>{tone(absolute - 512, 0), tone(absolute - 512, 1)});
    }
    position += Phase3Rig::frames;
    const auto expected = reference.render_input(left, right);
    const auto actual = rig.render_input(left, right);
    assert(rig.witness == reference.witness);
    return std::pair{actual, expected};
  };
  for (uint32_t block = 0; block < 256; ++block) render();
  for (uint32_t revision = 2; revision <= 3; ++revision) {
    const uint32_t before = revision == 2 ? 512 : 4096;
    const uint32_t after = revision == 2 ? 4096 : 512;
    build(rig, after);
    const auto prepare_begin = std::chrono::steady_clock::now();
    expect(rig.prepare(revision), DAW_AUDIO_CORE_OK);
    const double prepare_us = std::chrono::duration<double, std::micro>(
      std::chrono::steady_clock::now() - prepare_begin).count();
    // A late publication must consume the prepared window's catch-up samples,
    // not reset the new FFT or rerun the upstream source.
    if (revision == 2) for (uint32_t block = 0; block < lag_blocks; ++block) render();
    const uint64_t publication = position;
    rig.publish(revision);
    double energy = 0.0;
    double transition_us = 0.0, steady_us = 0.0, peak_us = 0.0;
    const uint32_t measured_blocks = std::max(320u, lag_blocks * 2u + 32u);
    for (uint32_t block = 0; block < measured_blocks; ++block) {
      const auto began = std::chrono::steady_clock::now();
      const auto [actual, steady] = render();
      const double elapsed_us = std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - began).count();
      if (block < 16) transition_us += elapsed_us;
      else steady_us += elapsed_us;
      peak_us = std::max(peak_us, elapsed_us);
      static_cast<void>(steady);
      for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame) {
        const uint32_t elapsed = block * Phase3Rig::frames + frame;
        const float gain = revision == 2 && elapsed < rig.fade_frames()
          ? static_cast<float>(rig.fade_frames() - elapsed) / rig.fade_frames()
          : revision == 2 && elapsed < rig.fade_frames() * 2u
            ? static_cast<float>(elapsed - rig.fade_frames()) / rig.fade_frames() : 1.0F;
        const uint64_t absolute = publication + elapsed;
        const uint32_t lag = lag_blocks * Phase3Rig::frames;
        const uint32_t seam = revision == 2 ? (lag == 0 ? 0u : std::min(lag, after * 2u) - 1u) : 0u;
        const uint32_t aligned_seam = revision == 2 ? std::max(seam, rig.fade_frames()) : seam;
        const float stage_mix = elapsed < aligned_seam ? 0.0F
          : std::min(1.0F, static_cast<float>(elapsed - aligned_seam) / (rig.fade_frames() * 2u));
        const uint32_t old_delay = revision == 2 && elapsed >= rig.fade_frames() ? after - before : 0u;
        const uint32_t delay = revision == 2 ? 0u : before - after;
        for (uint32_t channel = 0; channel < 2; ++channel)
          stage_trace[absolute][channel] = tone(absolute - before - old_delay, channel) * (1.0F - stage_mix)
            + tone(absolute - after - delay, channel) * stage_mix;
        const auto expected_sample = [&](uint32_t channel) {
          return stage_trace[absolute][channel] * gain;
        };
        const float expected = expected_sample(0);
        if (std::abs(actual[0][frame] - expected) > 0.00002F || std::abs(actual[1][frame] - expected_sample(1)) > 0.00002F) {
          std::fprintf(stderr, "fft-change-audible revision=%u elapsed=%u actual=%g expected=%g: edited stage dropout/continuity\n",
            revision, elapsed, actual[0][frame], expected);
          assert(false);
        }
        energy += actual[0][frame] * actual[0][frame];
      }
      const uint32_t stage_seam = revision == 2
        ? (lag_blocks == 0 ? 0u : std::min(lag_blocks * Phase3Rig::frames, after * 2u) - 1u) : 0u;
      const uint32_t complete = (revision == 2 ? std::max(stage_seam, rig.fade_frames()) : stage_seam)
        + rig.fade_frames() * 2u + 1u;
      assert((daw::audio_core::InspectLatencyTransition(rig.core).completed_revision == revision)
        == ((block + 1u) * Phase3Rig::frames >= complete));
    }
    assert(energy > 100.0);
    std::printf("FFT %u->%u prepare=%.3f us dual-rig-64-frame mean transition=%.3f steady=%.3f peak=%.3f us energy=%g\n",
      before, after, prepare_us, transition_us / 16.0, steady_us / (measured_blocks - 16u), peak_us, energy);
  }
  std::puts("fft-change-audible: 512->4096->512 no dropout, unaffected PCM exact");
}

// Failure-first extension of /tmp/ae08-rereview/spectral-probe.cpp. A continuous
// target-size core is the energy oracle, and a disconnected witness must null
// exactly. Include both directions and all six modes, not pass-through Freeze.
void test_phase4_stateful_spectral(uint32_t mode, bool lower, uint32_t overlap = 4, bool same_fft = false,
  bool short_history = false, bool expired = false) {
  Phase3Rig edited, reference;
  const bool tone = mode == DAW_AUDIO_SPECTRAL_MODE_HPSS;
  const bool broadband = mode == DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE && !same_fft;
  std::unique_ptr<Phase3Rig> old_reference = tone ? std::make_unique<Phase3Rig>() : nullptr;
  std::vector<float> stage_trace;
  std::vector<float> target_trace;
  edited.witness_node = reference.witness_node = 2;
  const uint32_t before = same_fft ? 4096 : lower ? 4096 : 512;
  const uint32_t after = same_fft ? 4096 : lower ? 512 : 4096;
  uint32_t edited_overlap = same_fft ? 2u : overlap;
  const auto build = [&](Phase3Rig &rig, uint32_t fft, bool learning) {
    rig.clear();
    rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE);
    rig.add_node(2, DAW_AUDIO_GRAPH_NODE_SOURCE);
    rig.add_node(3, DAW_AUDIO_GRAPH_NODE_MASTER);
    rig.add_edge(1, 3);
    rig.add_edge(2, 3, 0.0F);
    rig.edges.back().pdc_delay_frames = fft;
    daw_audio_spectral_state state{
      .enabled = 1, .fft_size = fft, .overlap = &rig == &edited ? edited_overlap : overlap, .mode = mode,
      .freeze = mode == DAW_AUDIO_SPECTRAL_MODE_FREEZE ? 1.0F : 0.0F,
      .gate_threshold_db = 0.0F, .gate_attack_ms = 1000.0F, .gate_release_ms = 5000.0F,
      .harmonic_percussive_balance = 1.0F, .noise_reduction = 0.75F,
      .profile_learn = learning ? (broadband ? 0.1F : 1.0F) : 0.0F, .mix = 1.0F,
    };
    rig.add_state(1, 10, DAW_AUDIO_PROCESSOR_KIND_SPECTRAL, state);
    if (mode == DAW_AUDIO_SPECTRAL_MODE_FREEZE || mode == DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE)
      rig.declare_target(mode == DAW_AUDIO_SPECTRAL_MODE_FREEZE ? 15 : 24);
    rig.processors.back().latency_frames = fft;
    rig.nodes[0].latency_frames = fft;
  };
  build(edited, before, true); build(reference, after, true);
  if (old_reference) { build(*old_reference, before, true); old_reference->commit(1); }
  edited.commit(1); reference.commit(1);
  const daw_audio_transport_state transport{.epoch = 1, .running = 1};
  expect(daw_audio_core_set_transport(edited.core, &transport), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_set_transport(reference.core, &transport), DAW_AUDIO_CORE_OK);
  if (old_reference) expect(daw_audio_core_set_transport(old_reference->core, &transport), DAW_AUDIO_CORE_OK);
  uint32_t random = 0x7a3579u;
  const auto render = [&](float level) {
    std::array<float, Phase3Rig::frames> noise{};
    if (broadband) for (auto &sample : noise) {
      random ^= random << 13; random ^= random >> 17; random ^= random << 5;
      sample = level * (random / 2147483648.0 - 1);
    }
    const auto a = broadband ? edited.render_input(noise, noise)
      : tone ? edited.render_tone(220, level, 1) : edited.render(level);
    const auto b = broadband ? reference.render_input(noise, noise)
      : tone ? reference.render_tone(220, level, 1) : reference.render(level);
    if (tone) target_trace.insert(target_trace.end(), b[0].begin(), b[0].end());
    if (old_reference) {
      const auto old = old_reference->render_tone(220, level, 1);
      stage_trace.insert(stage_trace.end(), old[0].begin(), old[0].end());
    }
    assert(edited.witness == reference.witness);
    return std::pair{a, b};
  };
  const uint32_t warm_blocks = short_history ? 128u : 2048u;
  for (uint32_t block = 0; block < warm_blocks; ++block) render(0.25F);
  // Stop profile learning while retaining its learned quarter-scale spectrum.
  // The later half-scale input cannot reconstruct that profile from history.
  build(edited, before, false); build(reference, after, false);
  edited.commit(2); reference.commit(2);
  const float level = mode == DAW_AUDIO_SPECTRAL_MODE_GATE ? 0.00001F : 0.5F;
  for (uint32_t block = 0; block < warm_blocks; ++block) render(level);
  edited_overlap = overlap;
  build(edited, after, false);
  expect(edited.prepare(3), DAW_AUDIO_CORE_OK);
  if (expired) for (uint32_t block = 0; block < 4096; ++block) render(level);
  edited.publish(3);
  const uint64_t publication = stage_trace.size();
  const uint32_t warm_frames = after * 2u + 30u * (after / overlap);
  const uint32_t stage_seam = expired ? warm_frames - 1u
    : short_history ? warm_frames - warm_blocks * Phase3Rig::frames * 2u - 1u : 0u;
  double actual = 0.0, expected = 0.0;
  double window_actual = 0.0, window_expected = 0.0;
  for (uint32_t block = 0; block < 2048; ++block) {
    const auto [a, b] = render(level);
    double analytic_energy = 0.0;
    if (tone) for (uint32_t i = 0; i < Phase3Rig::frames; ++i) {
      const uint32_t elapsed = block * Phase3Rig::frames + i;
      const uint64_t at = publication + elapsed;
      const uint32_t aligned_seam = lower ? stage_seam : std::max(stage_seam, edited.fade_frames());
      const float stage_mix = elapsed < aligned_seam ? 0.0F
        : std::min(1.0F, static_cast<float>(elapsed - aligned_seam) / (edited.fade_frames() * 2u));
      const uint32_t delay = lower ? before - after : 0u;
      const float gain = lower ? 1.0F : elapsed < edited.fade_frames()
        ? static_cast<float>(edited.fade_frames() - elapsed) / edited.fade_frames()
        : elapsed < edited.fade_frames() * 2u
          ? static_cast<float>(elapsed - edited.fade_frames()) / edited.fade_frames() : 1.0F;
      const uint32_t old_delay = !lower && elapsed >= edited.fade_frames() ? after - before : 0u;
      const float analytic = (stage_trace[at - old_delay] * (1.0F - stage_mix)
        + target_trace[at - delay] * stage_mix) * gain;
      analytic_energy += analytic * analytic;
      if (std::abs(a[0][i] - analytic) > 0.00002F) {
        std::fprintf(stderr, "HPSS analytic %u->%u elapsed=%u actual=%g expected=%g\n", before, after, elapsed, a[0][i], analytic);
        assert(false);
      }
    }
    // Per-block energy catches short holes, including the original 512..8191
    // failure window. DC is analytic for the other modes. HPSS is periodic.
    if (block >= 8) {
      double ae = 0, be = 0;
      for (uint32_t i = 0; i < Phase3Rig::frames; ++i) {
        assert(std::isfinite(a[0][i]) && std::isfinite(a[1][i]));
        ae += a[0][i] * a[0][i]; be += b[0][i] * b[0][i];
      }
      if (tone) be = analytic_energy;
      actual += ae; expected += be;
      // The sample-exact two-reference oracle above covers the entire seam,
      // including its legitimate destructive interference.
      if (broadband) {
        for (float sample : a[0]) assert(std::abs(sample) < 1);
        assert(ae > 0);
        window_actual += ae; window_expected += be;
        if (block % 64 == 63) {
          assert(std::abs(10 * std::log10(window_actual / window_expected)) <= 1);
          window_actual = window_expected = 0;
        }
      } else if (ae < be * 0.65 || ae > be * 1.4) {
        std::fprintf(stderr, "spectral-state mode=%u %u->%u frame=%u energy=%g continuous=%g\n",
          mode, before, after, block * Phase3Rig::frames, ae, be);
        assert(false);
      }
    }
  }
  std::printf("spectral-state total mode=%u actual=%g expected=%g ratio=%g\n", mode, actual, expected, actual / expected);
  std::fflush(stdout);
  assert(expected > 1e-12 && (broadband ? std::abs(10 * std::log10(actual / expected)) <= 1
    : std::abs(actual / expected - 1.0) < 0.05));
  const bool captured = !same_fft && (mode == DAW_AUDIO_SPECTRAL_MODE_FREEZE || mode == DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE);
  assert(daw::audio_core::InspectLatencyTransition(edited.core).completed_revision == 3);
  std::printf("spectral-state mode=%u %u->%u energy=%g continuous=%g unaffected PCM exact\n",
    mode, before, after, actual, expected);
  if (captured) {
    const daw_audio_processor_event release{
      .processor_instance_id = 10, .parameter_target = mode == DAW_AUDIO_SPECTRAL_MODE_FREEZE ? 15u : 24u,
      .frame_offset = 0, .value = mode == DAW_AUDIO_SPECTRAL_MODE_FREEZE ? 0.0F : 1.0F,
    };
    edited.render(level, &release, 1);
    reference.render(level, &release, 1);
    for (uint32_t block = 0; block < 256; ++block) {
      const auto [a, b] = render(level);
      if (block > 128 && !broadband) for (uint32_t i = 0; i < Phase3Rig::frames; ++i)
        assert(std::abs(a[0][i] - b[0][i]) < 0.00002F);
    }
    assert(daw::audio_core::InspectLatencyTransition(edited.core).completed_revision == 3);
    std::puts("captured state: finite completion before release/relearn");
  }
}

void test_phase4_spectral_snapshot_mode() {
  Phase3Rig rig;
  const auto build = [&](uint32_t fft, uint32_t mode, float learn) {
    rig.clear();
    rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE);
    rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER);
    rig.add_edge(1, 2);
    const daw_audio_spectral_state state{
      .enabled = 1, .fft_size = fft, .overlap = 4, .mode = mode, .freeze = 1,
      .gate_threshold_db = -60, .gate_attack_ms = 1, .gate_release_ms = 20,
      .noise_reduction = .75F, .profile_learn = learn, .mix = 1,
    };
    rig.add_state(1, 10, DAW_AUDIO_PROCESSOR_KIND_SPECTRAL, state);
    rig.nodes[0].latency_frames = rig.processors.back().latency_frames = fft;
  };
  build(512, DAW_AUDIO_SPECTRAL_MODE_FREEZE, 0); rig.commit(1);
  const daw_audio_transport_state transport{.epoch = 1, .running = 1};
  expect(daw_audio_core_set_transport(rig.core, &transport), DAW_AUDIO_CORE_OK);
  for (unsigned i = 0; i < 512; ++i) rig.render_tone(750, .25F, 1);
  build(512, DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE, 1); rig.commit(2);
  for (unsigned i = 0; i < 512; ++i) rig.render(0);
  build(512, DAW_AUDIO_SPECTRAL_MODE_FREEZE, 0); rig.commit(3);
  const auto energy = [&] {
    double result = 0;
    for (unsigned i = 0; i < 512; ++i) {
      const auto output = rig.render(0);
      if (i > 256) for (float x : output[0]) result += x * x;
    }
    return result;
  };
  const double before = energy();
  build(4096, DAW_AUDIO_SPECTRAL_MODE_FREEZE, 0); rig.commit(4);
  const double after = energy();
  const double db = 10 * std::log10(after / before);
  std::printf("snapshot mode roundtrip before=%g after=%g delta_db=%g completed=%u\n",
    before, after, db, daw::audio_core::InspectLatencyTransition(rig.core).completed_revision);
  std::fflush(stdout);
  assert(before > 1 && std::abs(db) <= 1);
  assert(daw::audio_core::InspectLatencyTransition(rig.core).completed_revision == 4);
}

void test_phase4_spectral_frozen_tone(bool lower, float mix) {
  Phase3Rig rig;
  const auto build = [&](uint32_t fft) {
    rig.clear(); rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE);
    rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER); rig.add_edge(1, 2);
    const daw_audio_spectral_state state{
      .enabled = 1, .fft_size = fft, .overlap = 4, .mode = DAW_AUDIO_SPECTRAL_MODE_FREEZE,
      .freeze = 1, .gate_threshold_db = -60, .gate_attack_ms = 1, .gate_release_ms = 20, .mix = mix,
    };
    rig.add_state(1, 10, DAW_AUDIO_PROCESSOR_KIND_SPECTRAL, state);
    rig.nodes[0].latency_frames = rig.processors.back().latency_frames = fft;
  };
  const uint32_t before = lower ? 4096u : 512u, after = lower ? 512u : 4096u;
  build(before); rig.commit(1);
  const daw_audio_transport_state transport{.epoch = 1, .running = 1};
  expect(daw_audio_core_set_transport(rig.core, &transport), DAW_AUDIO_CORE_OK);
  for (uint32_t i = 0; i < 512; ++i) rig.render_tone(750, .25F, 1);
  for (uint32_t i = 0; i < 256; ++i) rig.render(0);
  double old_energy = 0;
  for (uint32_t i = 0; i < 256; ++i) {
    const auto output = rig.render(0);
    for (float x : output[0]) old_energy += x * x;
  }
  build(after); rig.commit(2);
  for (uint32_t i = 0; i < 512; ++i) {
    const auto output = rig.render(0);
    for (float x : output[0]) assert(std::isfinite(x) && std::abs(x) < 1);
    double energy = 0;
    for (float x : output[0]) energy += x * x;
    assert(energy > 1e-8);
  }
  std::array<float, 16384> samples{};
  for (uint32_t at = 0; at < samples.size(); at += Phase3Rig::frames) {
    const auto output = rig.render(0);
    std::copy(output[0].begin(), output[0].end(), samples.begin() + at);
  }
  double total = 0, narrow = 0, peak = 0;
  uint32_t dominant = 0;
  for (float x : samples) total += x * x;
  // Exact integer periods over this observation window, including every
  // frequency inside +/-2 destination bins (23.4375 Hz around 750 Hz).
  const uint32_t radius = samples.size() * 2u / after;
  for (uint32_t k = 256u - radius; k <= 256u + radius; ++k) {
    double re = 0, im = 0;
    for (uint32_t i = 0; i < samples.size(); ++i) {
      const double phase = 6.283185307179586 * k * i / samples.size();
      re += samples[i] * std::cos(phase); im += samples[i] * std::sin(phase);
    }
    const double energy = 2 * (re * re + im * im) / samples.size();
    narrow += energy;
    if (energy > peak) { peak = energy; dominant = k; }
  }
  const double db = 10 * std::log10(total / old_energy);
  std::printf("frozen tone %u->%u mix=%g source_energy=%g destination_energy=%g delta_db=%g dominant_hz=%g narrow_fraction=%g\n",
    before, after, mix, old_energy, total, db, dominant * 48000.0 / samples.size(), narrow / total);
  std::fflush(stdout);
  assert(std::abs(dominant * 48000.0 / samples.size() - 750) <= 48000.0 / after);
  assert(narrow / total >= .9);
  assert(std::abs(db) <= 1);
}

#if defined(DAW_AUDIO_CORE_TEST_SPECTRAL_INTERNALS)
void test_phase4_spectral_transfer_late() {
  Phase3Rig rig;
  const auto build = [&](uint32_t fft, bool learn) {
    rig.clear(); rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE);
    rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER); rig.add_edge(1, 2);
    const daw_audio_spectral_state state{
      .enabled = 1, .fft_size = fft, .overlap = 4, .mode = DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE,
      .gate_threshold_db = -60, .gate_attack_ms = 1, .gate_release_ms = 20,
      .noise_reduction = .75F, .profile_learn = learn ? 1.0F : 0.0F, .mix = 1,
    };
    rig.add_state(1, 10, DAW_AUDIO_PROCESSOR_KIND_SPECTRAL, state);
    rig.nodes[0].latency_frames = rig.processors.back().latency_frames = fft;
  };
  build(512, true); rig.commit(1);
  const daw_audio_transport_state transport{.epoch = 1, .running = 1};
  expect(daw_audio_core_set_transport(rig.core, &transport), DAW_AUDIO_CORE_OK);
  for (uint32_t i = 0; i < 256; ++i) rig.render(.25F);
  build(4096, false); expect(rig.prepare(2), DAW_AUDIO_CORE_OK);
  for (uint32_t i = 0; i < 64; ++i) rig.render(.5F);
  auto &core = *to_core(rig.core);
  auto &bank = core.spectral_inputs[2];
  SpectralHistory tagged{};
  tagged.state_serial = 42; tagged.fft_size = 512; tagged.noise_profile[0][0] = 7;
  bank.publish(tagged, DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE);
  const daw_audio_spectral_state correct{.fft_size = 512, .mode = DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE};
  auto wrong = correct; wrong.mode = DAW_AUDIO_SPECTRAL_MODE_FREEZE;
  assert(!bank.read(tagged, wrong) && tagged.state_serial == 0);
  wrong = correct; wrong.fft_size = 4096;
  assert(!bank.read(tagged, wrong) && tagged.state_serial == 0);
  assert(bank.read(tagged, correct) && tagged.state_serial == 42 && tagged.noise_profile[0][0] == 7);
  const auto source = core.spectral_histories[core.published_graph->processors[0].spectral_slot].noise_profile[0];
  rig.publish(2); rig.render(1);
  const auto &destination = core.spectral_histories[core.published_graph->processors[0].spectral_slot].noise_profile[0];
  double worst = 0;
  for (uint32_t k = 0; k <= 2048; ++k) {
    const uint32_t lo = k / 8, hi = std::min(lo + 1u, 256u);
    const double fraction = (k % 8) / 8.0;
    const double expected = std::sqrt(8 * (source[lo] * source[lo] * (1 - fraction) + source[hi] * source[hi] * fraction));
    worst = std::max(worst, std::abs(destination[k] - expected) / std::max(1e-9, expected));
  }
  std::printf("latest tagged Noise profile all-bin relative error=%g\n", worst);
  assert(worst < 1e-5);
}

void test_phase4_spectral_transfer_cost() {
  auto prior = std::make_unique<SpectralHistory>();
  auto next = std::make_unique<SpectralHistory>();
  for (const auto sizes : {std::array{512u, 4096u}, std::array{4096u, 512u}}) {
    for (uint32_t mode : {DAW_AUDIO_SPECTRAL_MODE_GATE, DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE}) {
      const daw_audio_spectral_state before{.fft_size = sizes[0], .mode = mode};
      auto after = before; after.fft_size = sizes[1];
      const auto map = prepare_spectral_transfer(sizes[0], sizes[1]);
      double total = 0, worst = 0;
      float checksum = 0;
      for (uint32_t run = 0; run < 10000; ++run) {
        for (auto &c : prior->noise_profile) c.fill(.1F + (run % 17) * .01F);
        for (auto &c : prior->gate_gain) c.fill(.5F);
        const auto allocations = allocation_count;
        const auto start = std::chrono::steady_clock::now();
        apply_spectral_transfer(*prior, before, *next, after, map);
        const double us = std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - start).count();
        assert(allocation_count == allocations);
        total += us; worst = std::max(worst, us);
        checksum += next->noise_profile[0][run % (sizes[1] / 2 + 1)] + next->gate_gain[0][0];
      }
      std::printf("refresh mode=%u %u->%u mean_us=%g worst_us=%g checksum=%g\n",
        mode, sizes[0], sizes[1], total / 10000, worst, checksum);
    }
  }
  const auto handle = create_core(128, 2, 1);
  auto &core = *to_core(handle);
  for (const auto sizes : {std::array{512u, 4096u}, std::array{4096u, 512u}}) {
    std::array<double, 2> means{}, peaks{};
    for (uint32_t wet = 0; wet < 2; ++wet) {
      GraphRevision::Processor old{}, replacement{};
      old.spectral_slot = 0; replacement.spectral_slot = 1;
      old.spectral = {.enabled = 1, .fft_size = sizes[0], .overlap = 4,
        .mode = DAW_AUDIO_SPECTRAL_MODE_FREEZE, .freeze = 1, .mix = 1};
      replacement.spectral = old.spectral; replacement.spectral.fft_size = sizes[1];
      core.spectral_inputs[0].initialize_samples(); core.spectral_inputs[1].initialize_samples();
      uint32_t blocks = 0;
      for (uint32_t run = 0; run < 100; ++run) {
        core.spectral_histories[0] = SpectralHistory{};
        core.spectral_histories[1] = SpectralHistory{};
        reset_spectral_history(core.spectral_histories[0], old.spectral);
        reset_spectral_history(core.spectral_histories[1], replacement.spectral);
        for (uint32_t at = 0; at < sizes[1] * 2u; at += 128) {
          float l = 0, r = 0;
          const auto allocations = allocation_count;
          const auto start = std::chrono::steady_clock::now();
          for (uint32_t frame = 0; frame < 128; ++frame) {
            render_spectral_sample(core, old, frame, .25F, .25F, 0, 0, &l, &r);
            render_spectral_sample(core, replacement, frame, .25F, .25F, 0, 0, &l, &r,
              wet ? &core.spectral_histories[0].wet_sample : nullptr);
          }
          const double us = std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - start).count();
          assert(allocation_count == allocations);
          means[wet] += us; peaks[wet] = std::max(peaks[wet], us); ++blocks;
        }
      }
      means[wet] /= blocks;
    }
    std::printf("recapture dual-stage 128 frames %u->%u ordinary_mean_us=%g wet_mean_us=%g added_mean_us=%g ordinary_peak_us=%g wet_peak_us=%g\n",
      sizes[0], sizes[1], means[0], means[1], means[1] - means[0], peaks[0], peaks[1]);
  }
  daw_audio_core_destroy(handle);
}

void test_phase4_spectral_transfer_relearn() {
  const auto handle = create_core(64, 2, 1);
  auto &core = *to_core(handle);
  auto learned = std::make_unique<std::array<SpectralHistory, 4>>();
  auto history = std::make_unique<SpectralHistory>();
  auto next = std::make_unique<SpectralHistory>();
  constexpr std::array<uint32_t, 4> sizes{512, 4096, 1024, 2048};
  uint32_t random = 0x7a3579u;
  const auto uniform = [&] {
    random ^= random << 13; random ^= random >> 17; random ^= random << 5;
    return (random + 1.0) / 4294967297.0;
  };
  for (bool pink : {false, true}) {
    for (uint32_t index = 0; index < sizes.size(); ++index) {
      const uint32_t n = sizes[index];
      GraphRevision::Processor processor{};
      processor.spectral = {
        .enabled = 1, .fft_size = n, .overlap = 4, .mode = DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE,
        .profile_learn = 1, .mix = 1,
      };
      reset_spectral_history(*history, processor.spectral);
      auto &sum = (*learned)[index].noise_profile[0];
      sum.fill(0);
      constexpr uint32_t trials = 2048;
      for (uint32_t trial = 0; trial < trials; ++trial) {
        // Gaussian frequency coefficients generate a stationary broadband
        // ensemble. Pink has a fixed 1 kHz corner to avoid a divergent DC PSD.
        for (uint32_t k = 0; k <= n / 2; ++k) {
          const double radius = std::sqrt(-2 * std::log(uniform()));
          const double phase = 6.283185307179586 * uniform();
          const double psd = pink ? 1000.0 / std::max(1000.0, k * 48000.0 / n) : 1;
          const double scale = std::sqrt(n * psd / 2);
          history->real[0][k] = scale * radius * std::cos(phase);
          history->imaginary[0][k] = (k == 0 || k == n / 2) ? 0 : scale * radius * std::sin(phase);
          if (k == 0 || k == n / 2) history->real[0][k] *= std::sqrt(2.0);
          else {
            history->real[0][n - k] = history->real[0][k];
            history->imaginary[0][n - k] = -history->imaginary[0][k];
          }
        }
        spectral_fft(history->real[0], history->imaginary[0], n, true);
        for (uint32_t i = 0; i < n; ++i) {
          history->input[0][i] = history->real[0][i];
          history->input[1][i] = history->real[0][i];
        }
        history->write_index = n;
        process_spectral_frame(core, processor, *history, 0);
        for (uint32_t k = 0; k <= n / 2; ++k)
          sum[k] += history->noise_profile[0][k] * history->noise_profile[0][k] / trials;
      }
      for (uint32_t k = 0; k <= n / 2; ++k) sum[k] = std::sqrt(sum[k]);
    }
    for (uint32_t index = 0; index < sizes.size(); ++index) {
      const uint32_t target = index ^ 1u;
      const daw_audio_spectral_state before{.fft_size = sizes[index], .mode = DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE};
      auto after = before; after.fft_size = sizes[target];
      transfer_spectral_persistent((*learned)[index], before, *next, after);
      double worst = 0;
      for (uint32_t k = 0; k <= after.fft_size / 2; ++k) {
        const double ratio = next->noise_profile[0][k] / (*learned)[target].noise_profile[0][k];
        worst = std::max(worst, std::abs(20 * std::log10(ratio)));
      }
      std::printf("actual relearn pink=%u %u->%u worst_band_db=%g\n", pink, before.fft_size, after.fft_size, worst);
      std::fflush(stdout);
      assert(worst <= 1);
    }
  }
  daw_audio_core_destroy(handle);
}

void test_phase4_spectral_transfer_shape(bool pink) {
  auto prior = std::make_unique<SpectralHistory>();
  auto next = std::make_unique<SpectralHistory>();
  for (const auto sizes : {std::array{512u, 4096u}, std::array{4096u, 512u},
    std::array{1024u, 2048u}, std::array{2048u, 1024u}}) {
    const auto [a, b] = sizes;
    for (uint32_t mode : {DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE,
      DAW_AUDIO_SPECTRAL_MODE_GATE}) {
      const daw_audio_spectral_state before{.fft_size = a, .mode = mode};
      auto after = before; after.fft_size = b;
      auto &source = mode == DAW_AUDIO_SPECTRAL_MODE_GATE ? prior->gate_gain : prior->noise_profile;
      auto &destination = mode == DAW_AUDIO_SPECTRAL_MODE_GATE ? next->gate_gain : next->noise_profile;
      const double ratio = double(b) / a;
      const auto power = [&](uint32_t bin) { return pink ? 1.0 / std::max(1u, bin) : 1.0; };
      for (auto &channel : source) for (uint32_t bin = 0; bin <= a / 2; ++bin)
        channel[bin] = std::sqrt(power(bin));
      transfer_spectral_persistent(*prior, before, *next, after);
      for (uint32_t bin = 0; bin <= b / 2; ++bin) {
        const double center = bin / ratio;
        double expected = 0;
        if (b >= a) {
          const uint32_t lo = center, hi = std::min(lo + 1, a / 2);
          expected = power(lo) + (power(hi) - power(lo)) * (center - lo);
        } else {
          const double left = std::max(0.0, (bin - .5) / ratio);
          const double right = std::min(double(a / 2), (bin + .5) / ratio);
          for (uint32_t k = 0; k <= a / 2; ++k)
            expected += power(k) * std::max(0.0, std::min(right, k + .5) - std::max(left, k - .5));
          expected /= right - left;
        }
        if (mode != DAW_AUDIO_SPECTRAL_MODE_GATE) expected *= ratio;
        const double db = 10 * std::log10(destination[0][bin] * destination[0][bin] / expected);
        if (std::abs(db) > 1) {
          std::fprintf(stderr, "shape pink=%u mode=%u %u->%u bin=%u actual=%g expected=%g delta_db=%g\n",
            pink, mode, a, b, bin, destination[0][bin], std::sqrt(expected), db);
          assert(false);
        }
      }
    }
  }
}

void test_phase4_spectral_transfer_narrow() {
  auto prior = std::make_unique<SpectralHistory>();
  auto next = std::make_unique<SpectralHistory>();
  const daw_audio_spectral_state before{.fft_size = 4096, .mode = DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE};
  auto after = before; after.fft_size = 512;
  for (uint32_t bin : {1u, 65u, 2047u}) {
    for (auto &channel : prior->noise_profile) { channel.fill(0); channel[bin] = 1; }
    transfer_spectral_persistent(*prior, before, *next, after);
    double energy = 0;
    for (uint32_t k = 0; k <= 256; ++k)
      energy += next->noise_profile[0][k] * next->noise_profile[0][k] * (k == 0 || k == 256 ? 1 : 2);
    // Real-spectrum signal power is 2*sum(|X|²)/N² (sqrt-Hann energy N/2).
    const double db = 10 * std::log10(energy * 4096.0 * 4096.0 / (2 * 512.0 * 512.0));
    std::printf("narrow bin=%u destination_raw_energy=%g normalized_delta_db=%g\n", bin, energy, db);
    std::fflush(stdout);
    assert(std::abs(db) <= .5);
  }
}

void test_phase4_spectral_transfer_endpoints() {
  for (const auto sizes : {std::array{512u, 4096u}, std::array{4096u, 512u}}) {
    Phase3Rig rig;
    const auto build = [&](uint32_t fft) {
      rig.clear(); rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE);
      rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER); rig.add_edge(1, 2);
      const daw_audio_spectral_state state{
        .enabled = 1, .fft_size = fft, .overlap = 4, .mode = DAW_AUDIO_SPECTRAL_MODE_FREEZE,
        .freeze = 1, .gate_threshold_db = -60, .gate_attack_ms = 1, .gate_release_ms = 20, .mix = 1,
      };
      rig.add_state(1, 10, DAW_AUDIO_PROCESSOR_KIND_SPECTRAL, state);
      rig.nodes[0].latency_frames = rig.processors.back().latency_frames = fft;
    };
    build(sizes[0]); rig.commit(1);
    const daw_audio_transport_state transport{.epoch = 1, .running = 1};
    expect(daw_audio_core_set_transport(rig.core, &transport), DAW_AUDIO_CORE_OK);
    std::array<float, Phase3Rig::frames> signal{};
    for (uint32_t k = 0; k < signal.size(); ++k) signal[k] = -.25F + (k % 2 ? -.125F : .125F);
    for (uint32_t i = 0; i < 512; ++i) rig.render_input(signal, signal);
    build(sizes[1]); rig.commit(2);
    for (uint32_t i = 0; i < 512; ++i) rig.render(0);
    auto &core = *to_core(rig.core);
    auto &processor = core.published_graph->processors[0];
    auto &history = core.spectral_histories[processor.spectral_slot];
    assert(history.freeze_captured[0]);
    transform_spectrum(core, processor, history, 0, 0);
    for (uint32_t k : {0u, sizes[1] / 2}) {
      std::printf("recaptured endpoint %u->%u bin=%u real=%g imaginary=%g\n",
        sizes[0], sizes[1], k, history.real[0][k], history.imaginary[0][k]);
      assert(history.imaginary[0][k] == 0);
      assert(std::signbit(history.real[0][k]) == (k == 0));
    }
    assert(daw::audio_core::InspectLatencyTransition(rig.core).completed_revision == 2);
  }
}
#endif

// Failure-first: capture/learn a stationary two-band signal, replace the input
// with silence (Freeze) or twice its amplitude (Noise), then resize without a
// release/relearn gesture. Compare settled band energies, not just total RMS.
void test_phase4_spectral_carry(uint32_t mode, bool lower) {
  if (mode == DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE) {
    // A PSD profile is stationary broadband state, not a coherent tonal lobe.
    // The source-level flat/pink contracts verify every destination band;
    // this companion exercises audible continuity and unaffected-path PCM.
    test_phase4_stateful_spectral(mode, lower);
    return;
  }
  Phase3Rig rig;
  const uint32_t before = lower ? 4096u : 512u, after = lower ? 512u : 4096u;
  const auto build = [&](uint32_t fft, bool learn) {
    rig.clear();
    rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE);
    rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER);
    rig.add_edge(1, 2);
    daw_audio_spectral_state state{
      .enabled = 1, .fft_size = fft, .overlap = 4, .mode = mode,
      .freeze = 1.0F, .gate_threshold_db = -60.0F, .gate_attack_ms = 1.0F,
      .gate_release_ms = 20.0F, .noise_reduction = 0.75F,
      .profile_learn = learn ? 1.0F : 0.0F, .mix = 1.0F,
    };
    rig.add_state(1, 10, DAW_AUDIO_PROCESSOR_KIND_SPECTRAL, state);
    rig.nodes[0].latency_frames = rig.processors.back().latency_frames = fft;
  };
  uint64_t position = 0;
  const auto render = [&](float gain) {
    std::array<float, Phase3Rig::frames> input{};
    for (uint32_t i = 0; i < Phase3Rig::frames; ++i)
      input[i] = gain * (0.2F * std::sin(6.283185307179586 * 750.0 * (position + i) / 48000.0)
        + 0.1F * std::sin(6.283185307179586 * 3000.0 * (position + i) / 48000.0));
    position += Phase3Rig::frames;
    return rig.render_input(input, input);
  };
  build(before, true); rig.commit(1);
  const daw_audio_transport_state transport{.epoch = 1, .running = 1};
  expect(daw_audio_core_set_transport(rig.core, &transport), DAW_AUDIO_CORE_OK);
  for (uint32_t i = 0; i < 512; ++i) render(1.0F);
  build(before, false); rig.commit(2);
  const float gain = mode == DAW_AUDIO_SPECTRAL_MODE_FREEZE ? 0.0F : 2.0F;
  for (uint32_t i = 0; i < 256; ++i) render(gain);
  const auto bands = [&] {
    constexpr uint32_t count = 16384;
    std::array<double, 2> re{}, im{};
    for (uint32_t at = 0; at < count; at += Phase3Rig::frames) {
      const auto output = render(gain);
      for (uint32_t i = 0; i < Phase3Rig::frames; ++i)
        for (uint32_t band = 0; band < 2; ++band) {
          const double phase = 6.283185307179586 * (band == 0 ? 750.0 : 3000.0) * (at + i) / 48000.0;
          re[band] += output[0][i] * std::cos(phase);
          im[band] += output[0][i] * std::sin(phase);
        }
    }
    return std::array<double, 2>{re[0] * re[0] + im[0] * im[0], re[1] * re[1] + im[1] * im[1]};
  };
  const auto old = bands();
  build(after, false); rig.commit(3);
  for (uint32_t i = 0; i < 512; ++i) render(gain);
  const auto next = bands();
  for (uint32_t band = 0; band < 2; ++band) {
    const double db = 10.0 * std::log10(next[band] / old[band]);
    std::printf("carry mode=%u %u->%u band=%u delta_db=%g\n", mode, before, after, band, db);
    std::fflush(stdout);
    assert(old[band] > 1.0 && std::abs(db) <= 1.0);
  }
  assert(daw::audio_core::InspectLatencyTransition(rig.core).completed_revision == 3);
}

// Reviewer round-three fixture, separated stereo lanes make alignment observable
// at every sample, rather than inferring it from the summed impulse peaks.
void test_phase4_spectral_aligned_completion(uint32_t mode, bool lower, bool alignment, uint32_t rate = 48000) {
  Phase3Rig rig(rate);
  const uint32_t before = lower ? 4096u : 512u;
  const uint32_t after = lower ? 512u : 4096u;
  const float dry = mode == DAW_AUDIO_SPECTRAL_MODE_FREEZE ? 0.5F : 1.0F;
  const auto build = [&](uint32_t fft) {
    rig.clear();
    rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE, 0);
    rig.add_node(2, DAW_AUDIO_GRAPH_NODE_SOURCE, 1);
    rig.add_node(3, DAW_AUDIO_GRAPH_NODE_MASTER);
    rig.add_edge(1, 3);
    rig.add_edge(2, 3, dry);
    daw_audio_spectral_state state{
      .enabled = 1, .fft_size = fft, .overlap = 4, .mode = mode, .freeze = 1.0F,
      .gate_threshold_db = -60.0F, .gate_attack_ms = 1.0F, .gate_release_ms = 20.0F,
      .noise_reduction = 0.75F, .profile_learn = 0.0F, .mix = 1.0F - dry,
    };
    rig.add_state(1, 10, DAW_AUDIO_PROCESSOR_KIND_SPECTRAL, state);
    rig.processors.back().latency_frames = fft;
    rig.nodes[0].latency_frames = fft;
    state.fft_size = 4096;
    state.mix = 0.0F;
    rig.add_state(2, 20, DAW_AUDIO_PROCESSOR_KIND_SPECTRAL, state);
    rig.processors.back().latency_frames = 4096;
    rig.nodes[1].latency_frames = 4096;
    rig.edges[0].pdc_delay_frames = 4096 - fft;
  };
  build(before);
  rig.commit(1);
  const daw_audio_transport_state transport{.epoch = 1, .running = 1};
  expect(daw_audio_core_set_transport(rig.core, &transport), DAW_AUDIO_CORE_OK);
  uint64_t position = 0;
  const auto render = [&](bool impulses, bool audible = true) {
    std::array<float, Phase3Rig::frames> signal{}, zero{};
    for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame)
      if (impulses && (position + frame) % 257u == 0) signal[frame] = 0.5F;
    position += Phase3Rig::frames;
    const float *inputs[]{signal.data(), zero.data(), zero.data(), signal.data()};
    Phase3Rig::Block output{};
    float *outputs[]{output[0].data(), output[1].data()};
    const daw_audio_core_process_block block{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = Phase3Rig::frames,
      .channel_count = 2, .input_bus_count = 2, .inputs = inputs, .outputs = outputs,
      .graph_revision = rig.revision,
    };
    const auto allocations = allocation_count;
    expect(daw_audio_core_process(rig.core, &block), DAW_AUDIO_CORE_OK);
    assert(allocation_count == allocations);
    if (alignment && audible) for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame) {
      if (std::abs(output[0][frame] - output[1][frame]) > 0.00001F) {
        std::fprintf(stderr, "spectral alignment mode=%u %u->%u at=%llu left=%g sibling=%g\n",
          mode, before, after, static_cast<unsigned long long>(position - Phase3Rig::frames + frame),
          output[0][frame], output[1][frame]);
        assert(false);
      }
    }
  };
  // Capture silence first, then send impulses through the dry fraction.
  for (uint32_t block = 0; block < 256; ++block) render(false);
  for (uint32_t block = 0; block < 128; ++block) render(true);
  build(after);
  rig.commit(2);
  constexpr uint32_t bound = 16384;
  const uint32_t recapture_bound = 2u * after + (lower ? before - after : 0u)
    + rig.fade_frames() * 2u + Phase3Rig::frames;
  for (uint32_t frame = 0; frame < bound; frame += Phase3Rig::frames) {
    render(true);
    if (mode == DAW_AUDIO_SPECTRAL_MODE_FREEZE && frame + Phase3Rig::frames >= recapture_bound)
      assert(daw::audio_core::InspectLatencyTransition(rig.core).completed_revision == 2);
  }
  const auto transition = daw::audio_core::InspectLatencyTransition(rig.core);
  build(after);
  const auto prepare = rig.prepare(3);
  const auto publish = daw_audio_core_publish(rig.core, 3);
  std::printf("spectral completion mode=%u %u->%u completed=%u bound=%u next_prepare=%u next_publish=%u\n",
    mode, before, after, transition.completed_revision, bound, prepare, publish);
  std::fflush(stdout);
  assert(transition.completed_revision == 2);
  expect(prepare, DAW_AUDIO_CORE_OK);
  expect(publish, DAW_AUDIO_CORE_OK);
  rig.revision = 3;
  for (uint32_t frame = 0; frame < bound; frame += Phase3Rig::frames) render(true);
  const daw_audio_transport_state stopped{.epoch = 1, .running = 0};
  expect(daw_audio_core_set_transport(rig.core, &stopped), DAW_AUDIO_CORE_OK);
  // PDC shrinks while stopped. Render a silent/in-audible fill before restart.
  for (uint32_t frame = 0; frame < 8192; frame += Phase3Rig::frames) render(true, false);
  expect(daw_audio_core_set_transport(rig.core, &transport), DAW_AUDIO_CORE_OK);
  for (uint32_t frame = 0; frame < 8192; frame += Phase3Rig::frames) render(true);
  build(after); rig.commit(4);
  for (uint32_t frame = 0; frame < bound; frame += Phase3Rig::frames) render(true);
}

// Failure-first round-five fixtures reuse the reviewer's 256-block capture,
// eight-block resize lead-in and constant 0.25 -> 0.5 release probe.
void test_phase4_spectral_freeze_gesture(bool lower, bool engage, bool automation, bool alignment) {
  Phase3Rig rig;
  const uint32_t before = lower ? 4096u : 512u, after = lower ? 512u : 4096u;
  const auto build = [&](uint32_t fft) {
    rig.clear();
    rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE, 0);
    rig.add_node(2, DAW_AUDIO_GRAPH_NODE_SOURCE, 1);
    rig.add_node(3, DAW_AUDIO_GRAPH_NODE_MASTER);
    rig.add_edge(1, 3);
    rig.add_edge(2, 3, alignment ? 1.0F : 0.0F);
    rig.edges.back().pdc_delay_frames = fft;
    const daw_audio_spectral_state state{
      .enabled = 1, .fft_size = fft, .overlap = 4, .mode = DAW_AUDIO_SPECTRAL_MODE_FREEZE,
      .freeze = engage ? 0.0F : 1.0F, .gate_threshold_db = -60, .gate_attack_ms = 1,
      .gate_release_ms = 20, .mix = alignment ? 0.0F : 1.0F,
    };
    rig.add_state(1, 10, DAW_AUDIO_PROCESSOR_KIND_SPECTRAL, state);
    rig.declare_target(15);
    rig.nodes[0].latency_frames = rig.processors.back().latency_frames = fft;
  };
  uint64_t position = 0;
  bool changed = false;
  const auto render = [&](float level, bool gesture = false) {
    std::array<float, Phase3Rig::frames> signal{}, zero{}, values{};
    for (uint32_t i = 0; i < Phase3Rig::frames; ++i) {
      signal[i] = alignment ? ((position + i) % 257u == 0 ? .5F : 0.0F) : level;
      // Exercise a non-block-aligned live event and sample automation seam.
      values[i] = (changed || (gesture && i >= 17)) ? (engage ? 1.0F : 0.0F) : (engage ? 0.0F : 1.0F);
    }
    const float *inputs[]{signal.data(), zero.data(), zero.data(), signal.data()};
    Phase3Rig::Block output{};
    float *outputs[]{output[0].data(), output[1].data()};
    const uint32_t target = 15;
    const daw_audio_processor_parameter_block parameters{
      .processor_instance_id = 10, .frame_count = Phase3Rig::frames, .parameter_count = 1,
      .parameter_targets = &target, .values = values.data(),
    };
    const daw_audio_processor_event event{
      .processor_instance_id = 10, .parameter_target = 15, .frame_offset = 17,
      .value = engage ? 1.0F : 0.0F,
    };
    const daw_audio_core_process_block block{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = Phase3Rig::frames,
      .channel_count = 2, .input_bus_count = 2, .inputs = inputs, .outputs = outputs,
      .graph_revision = rig.revision, .parameter_block_count = automation ? 1u : 0u,
      .parameter_blocks = automation ? &parameters : nullptr,
      .event_count = !automation && gesture ? 1u : 0u, .events = !automation && gesture ? &event : nullptr,
    };
    const auto allocations = allocation_count;
    expect(daw_audio_core_process(rig.core, &block), DAW_AUDIO_CORE_OK);
    assert(allocation_count == allocations);
    position += Phase3Rig::frames;
    if (gesture) changed = true;
    return output;
  };
  build(before); rig.commit(1);
  const daw_audio_transport_state transport{.epoch = 1, .running = 1};
  expect(daw_audio_core_set_transport(rig.core, &transport), DAW_AUDIO_CORE_OK);
  for (uint32_t i = 0; i < 256; ++i) render(.25F);
  // Settle the changed live input underneath held Freeze. Its own delayed
  // 0.25 step is not a resize discontinuity and must not contaminate this
  // constant-input gesture oracle (the unchanged reviewer probe covers it).
  if (!engage) for (uint32_t i = 0; i < 128; ++i) render(.5F);
  build(after); rig.commit(2);
  // Engaging captures a settled 0.25, then rejects later live 0.5.
  for (uint32_t i = 0; i < (engage ? 1u : 8u); ++i) render(engage ? .25F : .5F);
  auto output = render(engage ? .25F : .5F, true);
  float previous = output[0].back();
  double max_step = 0, level_sum = 0;
  float released_reference = 0;
  uint32_t completed_at = 0;
  const uint32_t bound = 2u * after + (lower ? before - after : 0u)
    + 2u * rig.fade_frames() + Phase3Rig::frames;
  for (uint32_t at = 0; at < 32768; at += Phase3Rig::frames) {
    output = render(engage && at < 8192 ? .25F : .5F);
    if (at <= bound * 3u / 4u && at + Phase3Rig::frames > bound * 3u / 4u)
      released_reference = output[0].back();
    for (uint32_t i = 0; i < Phase3Rig::frames; ++i) {
      if (alignment) assert(std::abs(output[0][i] - output[1][i]) < 0.00001F);
      else {
        max_step = std::max(max_step, double(std::abs(output[0][i] - previous)));
        previous = output[0][i];
        if (at >= 24576) level_sum += output[0][i];
      }
    }
    if (completed_at == 0 && daw::audio_core::InspectLatencyTransition(rig.core).completed_revision == 2)
      completed_at = at + Phase3Rig::frames;
  }
  const double expected = engage ? .25 : .5;
  const double db = alignment ? 0 : 20 * std::log10(level_sum / 8192 / expected);
  std::printf("Freeze %s %u->%u automation=%u alignment=%u max_step=%g level_db=%g completion=%u bound=%u\n",
    engage ? "engage" : "release", before, after, automation, alignment, max_step, db, completed_at, bound);
  std::fflush(stdout);
  // Stronger than an outside-fade oracle: every post-gesture step is bounded.
  assert(max_step < .01);
  assert(std::abs(db) < .1);
  assert(completed_at != 0 && completed_at <= bound);
  // The old stage must release too, not hold 0.25 until the new fade begins.
  if (!engage && !alignment) assert(released_reference > .3F);
}

// Reuse review6's held capture and offset-17 toggle stream, with a finite
// publication-relative oracle rather than waiting for automation to stop.
void test_phase4_spectral_freeze_toggle(bool lower, uint32_t period, bool engaged,
  bool alignment, uint32_t rate = 48000, bool continuous = false, bool bounce = false) {
  Phase3Rig rig(rate);
  const uint32_t before = lower ? 4096u : 512u, after = lower ? 512u : 4096u;
  const uint32_t fade = std::max(1u, rig.fade_frames());
  const uint32_t deadline = 2u * after + (lower ? before - after : 0u)
    + 2u * fade + Phase3Rig::frames;
  const auto build = [&](uint32_t fft) {
    rig.clear();
    rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE, 0);
    rig.add_node(2, DAW_AUDIO_GRAPH_NODE_SOURCE, 1);
    rig.add_node(3, DAW_AUDIO_GRAPH_NODE_MASTER);
    rig.add_edge(1, 3);
    rig.add_edge(2, 3, alignment ? 1.0F : 0.0F);
    rig.edges.back().pdc_delay_frames = fft;
    const daw_audio_spectral_state state{
      .enabled = 1, .fft_size = fft, .overlap = 4, .mode = DAW_AUDIO_SPECTRAL_MODE_FREEZE,
      .freeze = 1, .gate_threshold_db = -60, .gate_attack_ms = 1,
      .gate_release_ms = 20, .mix = alignment ? 0.0F : 1.0F,
    };
    rig.add_state(1, 10, DAW_AUDIO_PROCESSOR_KIND_SPECTRAL, state);
    rig.declare_target(15);
    rig.nodes[0].latency_frames = rig.processors.back().latency_frames = fft;
  };
  uint64_t position = 0;
  const auto render = [&](float level, const daw_audio_processor_event *event = nullptr) {
    std::array<float, Phase3Rig::frames> signal{}, zero{};
    for (uint32_t i = 0; i < Phase3Rig::frames; ++i)
      signal[i] = alignment ? ((position + i) % 257u == 0 ? .5F : 0.0F) : level;
    const float *inputs[]{signal.data(), zero.data(), zero.data(), signal.data()};
    Phase3Rig::Block output{};
    float *outputs[]{output[0].data(), output[1].data()};
    const daw_audio_core_process_block block{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = Phase3Rig::frames,
      .channel_count = 2, .input_bus_count = 2, .inputs = inputs, .outputs = outputs,
      .graph_revision = rig.revision, .event_count = event ? 1u : 0u, .events = event,
    };
    const auto allocations = allocation_count;
    expect(daw_audio_core_process(rig.core, &block), DAW_AUDIO_CORE_OK);
    assert(allocation_count == allocations);
    position += Phase3Rig::frames;
    if (alignment) for (uint32_t i = 0; i < Phase3Rig::frames; ++i)
      assert(output[0][i] == output[1][i]);
    return output;
  };
  build(before); rig.commit(1);
  const daw_audio_transport_state transport{.epoch = 1, .running = 1};
  expect(daw_audio_core_set_transport(rig.core, &transport), DAW_AUDIO_CORE_OK);
  for (uint32_t i = 0; i < 256; ++i) render(.25F);
  build(after); rig.commit(2);
  uint32_t completed = 0;
  float previous = alignment ? 0.0F : .25F;
  double max_step = 0;
  bool effective = true;
  // Toggle through the deadline, then put the opposite of its latched value
  // in force during the final warm-up. That value must survive retirement.
  const bool latched = bounce || (deadline / period) % 2u != 0;
  for (uint32_t at = 0; at < 2u * deadline; at += Phase3Rig::frames) {
    const bool alternating = bounce ? (at / period) % 2u == 0 : (at / period) % 2u != 0;
    const bool value = bounce && at >= deadline
      ? at < deadline + after + 256u || at >= deadline + after + 1024u
      : !continuous && at >= deadline + Phase3Rig::frames
        ? engaged : alternating;
    effective = value;
    const daw_audio_processor_event event{
      .processor_instance_id = 10, .parameter_target = 15, .frame_offset = 17,
      .value = value ? 1.0F : 0.0F,
    };
    const auto output = render(bounce && at >= deadline ? .5F : .25F, &event);
    if (!alignment) for (uint32_t i = 0; i < Phase3Rig::frames; ++i) {
      // The publication raise fade is only two samples at the formal 1 Hz
      // minimum. Its intentional gain ramp is not a Freeze discontinuity.
      if (at + i > 2u * fade)
        max_step = std::max(max_step, double(std::abs(output[0][i] - previous)));
      previous = output[0][i];
    }
    if (daw::audio_core::InspectLatencyTransition(rig.core).completed_revision == 2) {
      completed = at + Phase3Rig::frames;
      break;
    }
  }
  std::printf("Freeze toggle %u->%u period=%u rate=%u engaged=%u alignment=%u continuous=%u bounce=%u latch=%u completion=%u bound=%u max_step=%g\n",
    before, after, period, rate, engaged, alignment, continuous, bounce, latched, completed, 2u * deadline, max_step);
  std::fflush(stdout);
  assert(completed != 0 && completed <= 2u * deadline);
  if (!bounce) assert(max_step < .01);
  build(after);
  expect(rig.prepare(3), DAW_AUDIO_CORE_OK);
  expect(daw_audio_core_publish(rig.core, 3), DAW_AUDIO_CORE_OK);
  rig.revision = 3;
  // Complete the normal steady-state FFT/OLA response, then change live level.
  // Engaged must retain 0.25; released must follow 0.5, not the latched capture.
  double steady_step = 0;
  for (uint32_t at = 0; at < 8192; at += Phase3Rig::frames) {
    const auto output = render(bounce ? .5F : .25F);
    if (!alignment) for (float sample : output[0]) {
      steady_step = std::max(steady_step, double(std::abs(sample - previous)));
      previous = sample;
    }
  }
  // Bounce also changes the actual signal beneath Freeze; its natural delayed
  // live edge is not part of the constant-input continuity oracle.
  if (!bounce) assert(steady_step < .01);
  double sum = 0;
  for (uint32_t at = 0; at < 16384; at += Phase3Rig::frames) {
    const auto output = render(bounce ? .75F : .5F);
    if (at >= 8192) for (float sample : output[0]) sum += sample;
  }
  const double db = alignment ? 0 : 20 * std::log10(sum / 8192 / (bounce ? .5 : effective ? .25 : .5));
  std::printf("Freeze toggle final level_db=%g steady_step=%g\n", db, steady_step);
  assert(std::abs(db) < .1);
}

void test_phase4_keep_divergent_bus_rejected() {
  Phase3Rig rig;
  rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE);
  rig.nodes.back().keep_latency = 1;
  rig.add_node(2, DAW_AUDIO_GRAPH_NODE_SOURCE, 1);
  rig.add_node(3, DAW_AUDIO_GRAPH_NODE_MIXER);
  rig.add_node(4, DAW_AUDIO_GRAPH_NODE_MIXER);
  rig.nodes.back().latency_frames = 2048;
  rig.add_node(5, DAW_AUDIO_GRAPH_NODE_MASTER);
  rig.add_edge(1, 3); rig.add_edge(2, 3);
  rig.add_edge(3, 4); rig.add_edge(4, 5); rig.add_edge(3, 5);
  rig.edges.back().pdc_delay_frames = 2048;
  expect(rig.prepare(1), DAW_AUDIO_CORE_GRAPH_COMPATIBILITY_REJECTED);
  const auto diagnostic = daw_audio_core_get_graph_validation_diagnostic(rig.core);
  assert(diagnostic.code == DAW_AUDIO_CORE_GRAPH_VALIDATION_KEEP_LATENCY_DIVERGENT_MIXED_BUS);
  assert(diagnostic.actual == 2048 && diagnostic.limit == 0);
  std::puts("Keep Latency mixed bus divergent latency: explicit rejection");
}

void test_phase4_delayed_deletion() {
  Phase3Rig rig;
  rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE, 0);
  rig.add_node(2, DAW_AUDIO_GRAPH_NODE_SOURCE, 1);
  rig.nodes[1].latency_frames = 32;
  rig.add_node(3, DAW_AUDIO_GRAPH_NODE_MASTER);
  rig.add_edge(1, 3);
  rig.edges.back().pdc_delay_frames = 32;
  rig.add_edge(2, 3, 0.0F);
  rig.commit(1);
  const daw_audio_transport_state transport{.epoch = 1, .running = 1};
  expect(daw_audio_core_set_transport(rig.core, &transport), DAW_AUDIO_CORE_OK);
  for (uint32_t block = 0; block < 8; ++block) rig.render_keyed(0.25F, 0.0F);
  rig.nodes.erase(rig.nodes.begin());
  rig.edges.erase(rig.edges.begin());
  rig.commit(2);
  for (uint32_t block = 0; block < 8; ++block) {
    const auto actual = rig.render_keyed(0.25F, 0.0F);
    for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame) {
      const float expected = 0.25F * Phase3Rig::ramp(block * Phase3Rig::frames + frame, rig.fade_frames());
      assert(actual[0][frame] == expected && actual[1][frame] == expected);
    }
  }
}

// Checkpoint 34: a node slot that is retired and reclaimed holds nothing of the
// node that used it. Two instrument replacements one block apart leave the middle
// slot retired with its dip still running; the node added into that slot
// afterwards is silent and must stay exactly silent.
void test_phase3_reused_node_slot_starts_clean() {
  Phase3Rig rig;
  rig.witness_node = 5;
  const auto build = [&rig](float gain, bool probe) {
    rig.clear();
    rig.add_instrument(1, phase3_synth(gain, static_cast<uint32_t>(gain * 4.0F)));
    rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER);
    rig.add_edge(1, 2);
    if (probe) {
      rig.add_node(5, DAW_AUDIO_GRAPH_NODE_SOURCE, DAW_AUDIO_GRAPH_INPUT_BUS_DISCONNECTED);
      rig.add_edge(5, 2);
    }
  };
  build(0.75F, false);
  rig.commit(1);
  rig.note_on(1, 28);
  for (uint32_t index = 0; index < 12; ++index) rig.render(0.0F);
  build(0.5F, false);
  rig.commit(2);
  rig.render(0.0F);
  build(0.25F, false);
  rig.commit(3);
  for (uint32_t index = 0; index < rig.fade_frames() / Phase3Rig::frames + 4; ++index) rig.render(0.0F);
  (void)daw_audio_core_reclaim_retired_runtime(rig.core);
  build(0.25F, true);
  rig.commit(4);
  float largest = 0.0F;
  for (uint32_t index = 0; index < 8; ++index) {
    rig.render(0.0F);
    for (uint32_t channel = 0; channel < 2; ++channel)
      for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame)
        largest = std::max(largest, std::abs(rig.witness[channel][frame]));
  }
  phase3_require(largest == 0.0F, "a node added into a reused slot is not silent", largest, 0.0F);
}

// A node released in the middle of its reorder dip (nothing it feeds remains, so no
// ghost carries it out) leaves the dip in its slot; the node added into that slot
// afterwards renders at full level in its own order, bit for bit like one that never
// shared a core with a dip.
void test_phase3_reused_node_slot_has_no_dip() {
  const auto build = [](Phase3Rig &rig, bool isolated_node, bool reordered, bool probe) {
    rig.clear();
    rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER);
    if (isolated_node) {
      rig.add_node(3, DAW_AUDIO_GRAPH_NODE_SOURCE);
      if (reordered) rig.add_saturator(3, 31);
      rig.add_utility(3, 30, 6.0206F);
      if (!reordered) rig.add_saturator(3, 31);
    }
    if (probe) {
      rig.add_node(5, DAW_AUDIO_GRAPH_NODE_SOURCE);
      rig.add_edge(5, 2);
      rig.add_utility(5, 50, 6.0206F);
      rig.add_saturator(5, 51);
    }
  };
  Phase3Rig dirty, fresh;
  dirty.witness_node = fresh.witness_node = 5;
  build(dirty, true, false, false);
  dirty.commit(1);
  for (uint32_t block = 0; block < 4; ++block) dirty.render_tone(220.0F, 0.4F, 1.0F);
  build(dirty, true, true, false);
  dirty.commit(2);
  dirty.render_tone(220.0F, 0.4F, 1.0F);
  build(dirty, false, false, false);
  dirty.commit(3);
  for (uint32_t block = 0; block < 4; ++block) dirty.render_tone(220.0F, 0.4F, 1.0F);
  (void)daw_audio_core_reclaim_retired_runtime(dirty.core);
  build(fresh, false, false, false);
  fresh.commit(1);
  for (uint32_t block = 0; block < 4; ++block) fresh.render_tone(220.0F, 0.4F, 1.0F);
  build(dirty, false, false, true);
  dirty.commit(4);
  build(fresh, false, false, true);
  fresh.commit(2);
  dirty.tone_frame = fresh.tone_frame = 0;
  for (uint32_t block = 0; block < 8; ++block) {
    dirty.render_tone(220.0F, 0.4F, 1.0F);
    fresh.render_tone(220.0F, 0.4F, 1.0F);
    for (uint32_t channel = 0; channel < 2; ++channel) {
      for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame) {
        phase3_require(dirty.witness[channel][frame] == fresh.witness[channel][frame],
          "a node added into a slot released mid-dip is not at full level", dirty.witness[channel][frame],
          fresh.witness[channel][frame], block * Phase3Rig::frames + frame);
      }
    }
  }
}

// Raw ABI state for the kinds the rig has no typed helper for.
struct Phase3RawState {
  std::array<uint8_t, 80> bytes{};
  uint32_t size = 0;
  void u32(uint32_t offset, uint32_t value) {
    for (uint32_t byte = 0; byte < 4; ++byte) bytes[offset + byte] = static_cast<uint8_t>(value >> (byte * 8));
  }
  void f32(uint32_t offset, float value) {
    uint32_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    u32(offset, bits);
  }
};

Phase3RawState phase3_chorus_state() {
  Phase3RawState state;
  state.size = 28;
  state.u32(0, 1); state.f32(4, 12.0F); state.f32(8, 4.0F); state.f32(12, 0.8F);
  state.f32(16, 0.0F); state.f32(20, 0.25F); state.f32(24, 0.35F);
  return state;
}

Phase3RawState phase3_lofi_state() {
  Phase3RawState state;
  state.size = 36;
  state.u32(0, 1); state.u32(4, 12); state.f32(8, 0.5F); state.f32(12, 0.2F); state.f32(16, -60.0F);
  state.u32(20, DAW_AUDIO_LOFI_QUANTIZATION_ROUND); state.u32(24, DAW_AUDIO_LOFI_DITHER_TRIANGULAR);
  state.f32(28, 1.0F); state.u32(32, 123);
  return state;
}

Phase3RawState phase3_reverb_state() {
  Phase3RawState state;
  state.size = 72;
  state.u32(0, 1); state.f32(4, 1.0F); state.f32(8, 12.0F); state.f32(12, 20.0F);
  state.f32(16, 0.5F); state.u32(20, 1); state.f32(24, 5.0F); state.f32(28, 0.3F);
  state.f32(32, 0.5F); state.f32(36, 1.0F); state.f32(40, 0.65F); state.f32(44, 0.75F);
  state.f32(48, 0.8F); state.f32(52, 20.0F); state.f32(56, 20000.0F);
  state.f32(60, 20.0F); state.f32(64, 20000.0F); state.f32(68, 1.0F);
  return state;
}

// Checkpoint 35: a reclaimed slot is indistinguishable from one that was never used.
// One core is driven through bypass, restructure, reorder, layout, instrument
// replacement and deletion over every kind of processor the rig can build, drained
// and reclaimed; a second core never saw any of it. Both then take the same edit to
// the same graph (a silent node among sounding ones) and must render the same bits.
struct PristineVariant {
  bool bypassed = false, reordered = false, mono = false, alternate = false, three = true, empty = false;
};

void pristine_build(Phase3Rig &rig, const PristineVariant &variant) {
  const auto edge = [&rig](uint64_t id, uint64_t from, uint64_t to) {
    rig.add_edge(from, to);
    rig.edges.back().id = id;
  };
  rig.clear();
  rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER);
  if (variant.empty) return;
  rig.add_instrument(1, phase3_synth(variant.alternate ? 0.4F : 0.75F, variant.alternate ? 1 : 0));
  edge(1, 1, 2);
  if (variant.three) {
    rig.add_node(3, DAW_AUDIO_GRAPH_NODE_SOURCE, 0);
    if (variant.mono) rig.nodes.back().input_layout = rig.nodes.back().output_layout = DAW_AUDIO_GRAPH_LAYOUT_MONO;
    edge(3, 3, 2);
  }
  rig.add_node(5, DAW_AUDIO_GRAPH_NODE_SOURCE, DAW_AUDIO_GRAPH_INPUT_BUS_DISCONNECTED);
  edge(5, 5, 2);
  rig.add_utility(1, 10, 0.0F, true);
  rig.add_saturator(1, 11);
  daw_audio_eq_state eq{};
  eq.enabled = 1;
  for (daw_audio_eq_band_state &band : eq.bands) band = {0, DAW_AUDIO_EQ_BAND_PEAKING, 1000.0F, 0.0F, 1.0F, 0};
  eq.bands[0] = {1, DAW_AUDIO_EQ_BAND_LOWSHELF, 200.0F, 12.0F, 0.7F, 0};
  rig.add_state(1, 12, DAW_AUDIO_PROCESSOR_KIND_EQ, eq);
  const Phase3RawState chorus = phase3_chorus_state();
  rig.add_bytes(1, 13, DAW_AUDIO_PROCESSOR_KIND_CHORUS, chorus.bytes.data(), chorus.size);
  const HistoryFixtureState delay = history_fixture_state(DAW_AUDIO_PROCESSOR_KIND_DELAY);
  rig.add_bytes(1, 14, DAW_AUDIO_PROCESSOR_KIND_DELAY, delay.bytes.data(), delay.size);
  const Phase3RawState reverb = phase3_reverb_state();
  rig.add_bytes(1, 15, DAW_AUDIO_PROCESSOR_KIND_REVERB, reverb.bytes.data(), reverb.size);
  rig.processors.back().tail_frames = 48000 * 13;
  if (variant.three) {
    const daw_audio_gate_state gate{.enabled = 1, .mode = 0, .threshold_db = -30.0F, .ratio = 2.0F, .attack_ms = 0.1F,
      .hold_ms = 0.0F, .release_ms = 5.0F, .hysteresis_db = 0.0F, .range_db = -30.0F, .lookahead_ms = 0.0F,
      .detector = 0, .link = 1.0F, .sidechain_enabled = 0, .sidechain_frequency_hz = 100.0F, .sidechain_q = 0.707F};
    rig.add_state(3, 20, DAW_AUDIO_PROCESSOR_KIND_GATE, gate);
    const daw_audio_limiter_state limiter{.enabled = 1, .ceiling_dbtp = -12.0F, .release_ms = 20.0F,
      .lookahead_ms = 1.0F, .link = 1.0F, .detector_oversampling = 4};
    const auto compressor = [&rig] { rig.add_compressor(3, 21, -30.0F); };
    const auto limit = [&rig, &limiter] { rig.add_state(3, 22, DAW_AUDIO_PROCESSOR_KIND_LIMITER, limiter); };
    if (variant.reordered) { limit(); compressor(); } else { compressor(); limit(); }
    const Phase3RawState lofi = phase3_lofi_state();
    rig.add_bytes(3, 23, DAW_AUDIO_PROCESSOR_KIND_LOFI, lofi.bytes.data(), lofi.size);
    rig.add_utility(3, 24, 3.0F, true, true);
  }
  rig.add_utility(5, 30, 0.0F, true);
  for (auto &processor : rig.processors) {
    if (processor.node_id != 5) processor.bypassed = variant.bypassed ? 1u : 0u;
    if (processor.node_id == 3 && variant.mono) processor.input_layout = processor.output_layout = DAW_AUDIO_GRAPH_LAYOUT_MONO;
  }
}

void test_phase3_reclaimed_slots_are_pristine() {
  constexpr uint32_t probe_blocks = 48;
  const auto play = [](Phase3Rig &rig, uint32_t blocks) {
    std::vector<Phase3Rig::Block> out;
    for (uint32_t index = 0; index < blocks; ++index) out.push_back(rig.render_tone(220.0F, 0.5F, 1.0F));
    return out;
  };
  Phase3Rig dirty;
  {
    PristineVariant variant;
    pristine_build(dirty, variant);
    dirty.commit(1);
    dirty.note_on(1, 28);
    dirty.note_on(1, 35);
    play(dirty, 24);
    variant.bypassed = true;
    pristine_build(dirty, variant);
    dirty.commit(2);
    play(dirty, 1);
    variant.reordered = variant.mono = variant.alternate = true;
    pristine_build(dirty, variant);
    dirty.commit(3);
    play(dirty, 1);
    variant.bypassed = false;
    variant.three = false;
    pristine_build(dirty, variant);
    dirty.commit(4);
    play(dirty, 1);
    variant.empty = true;
    pristine_build(dirty, variant);
    dirty.commit(5);
    play(dirty, 2 * (dirty.fade_frames() / Phase3Rig::frames + 4));
    (void)daw_audio_core_reclaim_retired_runtime(dirty.core);
  }
  Phase3Rig fresh;
  {
    PristineVariant variant;
    variant.empty = true;
    pristine_build(fresh, variant);
    fresh.commit(1);
    play(fresh, 4);
  }
  PristineVariant probe;
  pristine_build(dirty, probe);
  pristine_build(fresh, probe);
  dirty.commit(6);
  fresh.commit(2);
  dirty.tone_frame = fresh.tone_frame = 0;
  dirty.note_on(1, 40);
  fresh.note_on(1, 40);
  const auto from_dirty = play(dirty, probe_blocks);
  const auto from_fresh = play(fresh, probe_blocks);
  for (uint32_t block = 0; block < probe_blocks; ++block) {
    for (uint32_t channel = 0; channel < 2; ++channel) {
      for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame) {
        phase3_require(from_dirty[block][channel][frame] == from_fresh[block][channel][frame],
          "a reclaimed slot differs from a never-used one", from_dirty[block][channel][frame],
          from_fresh[block][channel][frame], block * Phase3Rig::frames + frame);
      }
    }
  }
}

// Checkpoint 36: bypass is a parameter in the form the product compiles it, never a
// restructure. A stage is bypassed with its plan flag set, its own enabled flag
// cleared and its automatable parameters declared; flipping that must not replace the
// stage's runtime (a DC blocker keeps its state across the toggle) and the plan flag
// alone must also hold when parameters are declared.
void test_phase3_compiled_bypass_is_a_parameter_not_a_restructure() {
  constexpr float input = 0.25F;
  for (const bool flag_only : {true, false}) {
    Phase3Rig rig;
    const uint32_t ramp = bypass_ramp_frames(rig.sample_rate);
    const auto build = [&](bool bypassed) {
      rig.clear();
      rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE);
      rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER);
      rig.add_edge(1, 2);
      rig.add_utility(1, 10, 6.0206F);
      rig.declare_target(DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB);
      rig.utilities.back().enabled = bypassed && !flag_only ? 0u : 1u;
      rig.processors.back().bypassed = bypassed ? 1u : 0u;
    };
    build(false);
    rig.commit(1);
    Phase3Rig::Block block{};
    for (uint32_t index = 0; index < 20; ++index) block = rig.render(input);
    phase3_require(std::abs(block[0][63] - 0.5F) < 1e-6F, "declared-target stage is not wet", block[0][63], 0.5F);
    build(true);
    rig.commit(2);
    for (uint32_t index = 0; index < ramp / Phase3Rig::frames + 4; ++index) block = rig.render(input);
    phase3_require(std::abs(block[0][63] - input) < 1e-6F,
      flag_only ? "the plan flag alone does not bypass a stage with declared targets"
                : "a compiled bypass does not settle on the dry signal", block[0][63], input);
  }
  // A DC blocker has all but forgotten its constant input after 160 ms. Bypassing it
  // moves along the dry ramp from where the wet signal is; a restructure would restart
  // the blocker, whose first output is the whole input, and the wet signal would step
  // from 1e-5 to 0.25 at the toggle.
  Phase3Rig rig;
  const uint32_t ramp = bypass_ramp_frames(rig.sample_rate);
  const auto build = [&rig](bool bypassed) {
    rig.clear();
    rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE);
    rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER);
    rig.add_edge(1, 2);
    rig.add_utility(1, 10, 0.0F, true);
    rig.declare_target(DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB);
    rig.utilities.back().enabled = bypassed ? 0u : 1u;
    rig.processors.back().bypassed = bypassed ? 1u : 0u;
  };
  build(false);
  rig.commit(1);
  Phase3Rig::Block block{};
  for (uint32_t index = 0; index < 120; ++index) block = rig.render(input);
  const float wet = block[0][63];
  phase3_require(wet < 1e-3F, "the DC blocker has not settled", wet, 0.0F);
  for (const bool bypassed : {true, false}) {
    build(bypassed);
    rig.commit(bypassed ? 2 : 3);
    uint32_t elapsed = 0;
    for (uint32_t index = 0; index < ramp / Phase3Rig::frames + 3; ++index) {
      block = rig.render(input);
      for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame, ++elapsed) {
        const float level = std::min(1.0F, static_cast<float>(elapsed + 1) / static_cast<float>(ramp));
        const float expected = input * (bypassed ? level : 1.0F - level);
        phase3_require(std::abs(block[0][frame] - expected) < 1e-3F && std::abs(block[1][frame] - expected) < 1e-3F,
          bypassed ? "bypassing a DC blocker restarted it" : "un-bypassing a DC blocker restarted it",
          block[0][frame], expected, elapsed);
      }
    }
  }
}

// Checkpoint 37: a stage that is bypassed when its graph is first built starts on
// its dry signal. There is nothing sounding to ramp away from, so no wet sample may
// leak out while the position climbs.
void test_phase3_initially_bypassed_stage_starts_dry() {
  constexpr float input = 0.4F;
  for (uint32_t which = 0; which < kBypassKindNames.size(); ++which) {
    Phase3Rig rig;
    bypass_subject(rig, which, 1);
    rig.commit(1);
    for (uint32_t index = 0; index < 4; ++index) {
      const auto block = rig.render(input);
      for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame) {
        // The dynamics kinds bypass to their input as delayed by their fixed latency
        // (10 ms at most), so their dry signal is silence until the delay line fills;
        // a wet sample is neither silence nor the input.
        const uint32_t sample = index * Phase3Rig::frames + frame;
        const auto dry = [&](float value) {
          return std::abs(value - input) < 1e-6F || (sample < rig.sample_rate / 100 && value == 0.0F);
        };
        phase3_require(dry(block[0][frame]) && dry(block[1][frame]), kBypassKindNames[which], block[0][frame], input, sample);
      }
    }
  }
}

// Checkpoint 38: a channel layout change crossfades the waveform. Each fold of the
// node (before its chain, after its fader) moves linearly between the unfolded and
// folded signal over the deletion fade, so a zero-mean 40 Hz pair with opposite
// polarity (whose mono sum is silence) fades along its own cycle with no offset. The
// node's unfolded share is (1 - m)^2 because the two folds move together.
void test_phase3_layout_change_crossfades_the_waveform(bool to_mono) {
  Phase3Rig rig;
  const auto build = [&rig](bool mono) {
    rig.clear();
    rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE, 0);
    if (mono) rig.nodes.back().input_layout = rig.nodes.back().output_layout = DAW_AUDIO_GRAPH_LAYOUT_MONO;
    rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER);
    rig.add_edge(1, 2);
  };
  build(!to_mono);
  rig.commit(1);
  for (uint32_t index = 0; index < 8; ++index) rig.render_tone(40.0F, 0.8F, -1.0F);
  build(to_mono);
  rig.commit(2);
  const uint32_t fade = rig.fade_frames();
  float worst = 0.0F;
  uint32_t elapsed = 0;
  for (uint32_t block = 0; block < fade / Phase3Rig::frames + 3; ++block) {
    const uint64_t start = rig.tone_frame;
    const auto output = rig.render_tone(40.0F, 0.8F, -1.0F);
    for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame, ++elapsed) {
      const float progress = std::min(1.0F, static_cast<float>(elapsed) / static_cast<float>(fade));
      const float fold = to_mono ? progress : 1.0F - progress;
      const float expected = rig.tone(40.0F, 0.8F, start + frame) * (1.0F - fold) * (1.0F - fold);
      worst = std::max({worst, std::abs(output[0][frame] - expected), std::abs(output[1][frame] + expected)});
    }
  }
  std::printf("layout crossfade (%s): largest deviation from the waveform crossfade %.2e\n",
    to_mono ? "to mono" : "to stereo", worst);
  phase3_require(worst < 2e-5F, "layout change is not a waveform crossfade", worst, 0.0F);
}

// Checkpoint 39: a replaced instrument crossfades with the one it replaces. The old
// instrument keeps rendering its own voices while the new one fades in, so the
// output over the fade is (1 - g) times what the old one would have played plus g
// times what an instrument of the new configuration that held the same note all
// along plays: both waveforms are whole, nothing is a DC offset, and a 41 Hz note
// has no residue.
void test_phase3_instrument_replacement_crossfades_the_waveform() {
  const auto build = [](Phase3Rig &rig, uint32_t waveform) {
    daw_audio_synth_state synth = phase3_synth(0.75F);
    synth.oscillators[0].waveform = waveform;
    rig.clear();
    rig.add_instrument(1, synth);
    rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER);
    rig.add_edge(1, 2);
  };
  Phase3Rig edited;
  Phase3Rig old_voice;
  Phase3Rig new_voice;
  build(edited, DAW_AUDIO_SYNTH_WAVEFORM_SINE);
  build(old_voice, DAW_AUDIO_SYNTH_WAVEFORM_SINE);
  build(new_voice, DAW_AUDIO_SYNTH_WAVEFORM_TRIANGLE);
  for (Phase3Rig *rig : {&edited, &old_voice, &new_voice}) rig->commit(1);
  edited.note_on(1, 28);
  old_voice.note_on(1, 28);
  new_voice.note_on(1, 28);
  for (uint32_t index = 0; index < 12; ++index) {
    assert(edited.render(0.0F) == old_voice.render(0.0F));
    new_voice.render(0.0F);
  }
  // The held note carries into the replacement, so the new instrument's reference is
  // one that has held the same note since the start.
  build(edited, DAW_AUDIO_SYNTH_WAVEFORM_TRIANGLE);
  edited.commit(2);
  const uint32_t fade = edited.fade_frames();
  float worst = 0.0F;
  float old_peak = 0.0F;
  uint32_t elapsed = 0;
  Phase3Rig::Block last{};
  Phase3Rig::Block expected_last{};
  for (uint32_t block = 0; block < fade / Phase3Rig::frames + 3; ++block) {
    const auto actual = edited.render(0.0F);
    const auto old_output = old_voice.render(0.0F);
    const auto new_output = new_voice.render(0.0F);
    for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame, ++elapsed) {
      const float entering = std::min(1.0F, static_cast<float>(elapsed) / static_cast<float>(fade));
      for (uint32_t channel = 0; channel < 2; ++channel) {
        const float expected = old_output[channel][frame] * (1.0F - entering) + new_output[channel][frame] * entering;
        worst = std::max(worst, std::abs(actual[channel][frame] - expected));
      }
      old_peak = std::max(old_peak, std::abs(old_output[0][frame]));
    }
    last = actual;
    expected_last = new_output;
  }
  std::printf("instrument crossfade: largest deviation from the waveform crossfade %.2e (old voice peak %.3f)\n",
    worst, old_peak);
  phase3_require(old_peak > 0.1F, "the replaced instrument was not sounding", old_peak, 0.1F);
  phase3_require(worst < 2e-5F, "instrument replacement is not a waveform crossfade", worst, 0.0F);
  phase3_require(last == expected_last, "the replacement did not land on the new instrument", last[0][0], expected_last[0][0]);
}

// Checkpoint 41: replacements stack only as deep as a node may carry. Replacing an
// instrument over and over inside one fade keeps every predecessor sounding; the
// edit that would exceed the limit fails at prepare (nothing is cut), and the node
// takes edits again once the fades have run.
void test_phase3_replacement_depth_is_bounded_and_recovers() {
  Phase3Rig rig;
  const auto build = [&rig](uint32_t step) {
    rig.clear();
    rig.add_instrument(1, phase3_synth(0.2F + 0.05F * static_cast<float>(step % 8), step % 2));
    rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER);
    rig.add_edge(1, 2);
  };
  build(0);
  rig.commit(1);
  rig.note_on(1, 28);
  uint32_t revision = 1;
  uint32_t accepted = 0;
  daw_audio_core_result refused = DAW_AUDIO_CORE_OK;
  for (uint32_t step = 1; step < 32 && refused == DAW_AUDIO_CORE_OK; ++step) {
    build(step);
    refused = rig.prepare(revision + 1);
    if (refused != DAW_AUDIO_CORE_OK) break;
    rig.publish(++revision);
    ++accepted;
  }
  phase3_require(refused == DAW_AUDIO_CORE_CAPACITY_EXCEEDED, "the replacement chain is unbounded",
    static_cast<float>(refused), static_cast<float>(DAW_AUDIO_CORE_CAPACITY_EXCEEDED), accepted);
  phase3_require(accepted > 0, "no replacement was accepted", static_cast<float>(accepted), 1.0F);
  for (uint32_t block = 0; block < 2 * (rig.fade_frames() / Phase3Rig::frames + 2); ++block) rig.render(0.0F);
  build(40);
  rig.commit(revision + 1);
  rig.render(0.0F);
  std::printf("instrument replacements accepted within one fade: %u\n", accepted);
}

// Phase 6i, Mechanism A: an instrument edited under held notes plays on. Every case
// below runs an instrument next to references that are never edited, and holds the
// edited one to what a reference with the edited configuration (that held the same
// notes all along) plays, blended over the 5 ms fade the publish gives it: a held
// note keeps its phase, takes the edit at once, and nothing goes silent in between.
struct HeldRig {
  static constexpr uint32_t frames = 64;
  static constexpr uint32_t asset_frames = 20000;
  static constexpr uint32_t short_frames = 1000;
  static constexpr uint32_t fade = 240;  // 5 ms at 48 kHz
  daw_audio_core_handle core = create_core(frames, 2, 4);
  uint32_t kind;
  uint32_t capacity;
  uint32_t revision = 0;
  uint32_t sequence = 0;
  uint32_t live_targets = 0;  // the first N synth parameters are declared live
  daw_audio_synth_state synth = phase3_synth(0.5F);
  daw_audio_sampler_state sampler{
    .version = 1, .amp_attack_ms = 0.0F, .amp_decay_ms = 0.0F, .amp_sustain = 1.0F, .amp_release_ms = 1.0F,
    .filter_mode = DAW_AUDIO_SYNTH_FILTER_MODE_LOWPASS, .filter_cutoff_hz = 20000.0F, .filter_resonance = 0.7F,
    .lfo_rate_hz = 0.01F, .retrigger = 0,
  };
  daw_audio_granular_state granular{};
  std::vector<daw_audio_sample_zone> zones;
  // The core reads the planes for as long as the asset lives, so they live here.
  std::array<std::vector<float>, 3> sources;
  std::array<std::array<const float *, 1>, 3> plane_tables{};
  std::array<daw_audio_asset_handle, 3> assets{};
  std::vector<daw_audio_instrument_event> events;
  std::array<std::vector<float>, 2> heard;

  explicit HeldRig(uint32_t instrument_kind, uint32_t polyphony = 8) : kind(instrument_kind), capacity(polyphony) {
    const std::array<uint32_t, 3> lengths{asset_frames, asset_frames, short_frames};
    const std::array<float, 3> cycles{37.0F, 91.0F, 5.0F};
    for (uint32_t index = 0; index < 3; ++index) {
      sources[index].resize(lengths[index]);
      for (uint32_t frame = 0; frame < lengths[index]; ++frame) {
        sources[index][frame] = std::sin(6.2831853F * cycles[index] * static_cast<float>(frame) / static_cast<float>(lengths[index]));
      }
      plane_tables[index] = {sources[index].data()};
      const daw_audio_asset_descriptor descriptor{
        .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .revision = index + 1, .byte_length = lengths[index] * sizeof(float),
        .content_hash_prefix = 0, .frame_count = lengths[index], .sample_rate_hz = 48000, .channel_count = 1,
        .planes = plane_tables[index].data(),
      };
      expect(daw_audio_core_create_asset(core, &descriptor, &assets[index]), DAW_AUDIO_CORE_OK);
    }
    granular = {
      .version = 1, .asset = assets[0], .seed = 77, .max_grains = 16, .window_shape = DAW_AUDIO_GRANULAR_WINDOW_HANN,
      .freeze = 0, .grain_size_ms = 20.0F, .density_hz = 100.0F, .position = 0.5F, .spray = 0.3F,
      .pitch_semitones = 0.0F, .reverse_probability = 0.0F, .stereo_spread = 0.3F,
    };
    if (kind == DAW_AUDIO_INSTRUMENT_KIND_SAMPLER) zones.push_back(zone(0, 127));
    if (kind == DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK) {
      for (uint32_t note = 48; note <= 55; ++note) zones.push_back(zone(note, note));
      zones.push_back(zone(60, 60));
    }
  }
  ~HeldRig() { daw_audio_core_destroy(core); }
  HeldRig(const HeldRig &) = delete;
  HeldRig &operator=(const HeldRig &) = delete;

  daw_audio_sample_zone zone(uint32_t low, uint32_t high) const {
    return {.asset = assets[0], .key_low = low, .key_high = high, .velocity_low = 1, .velocity_high = 127,
      .root_note = 60, .gain = 1.0F, .playback_mode = DAW_AUDIO_SAMPLE_PLAYBACK_FORWARD_LOOP,
      .end_frame = asset_frames, .loop_end_frame = asset_frames};
  }
  daw_audio_core_result commit() {
    daw_audio_instrument_state_descriptor instrument{
      .kind = kind, .version = 1, .voice_capacity = capacity, .parameter_count = live_targets};
    for (uint32_t index = 0; index < live_targets; ++index) instrument.parameter_targets[index] = index + 1;
    const std::array<daw_audio_graph_node_descriptor, 2> nodes{{
      {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_INSTRUMENT, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
        .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .instrument = instrument},
      {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
        .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO},
    }};
    const daw_audio_graph_edge_descriptor edge{
      .id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER};
    const daw_audio_graph_prepare_request request{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = revision + 1,
      .node_count = 2, .edge_count = 1, .nodes = nodes.data(), .edges = &edge,
    };
    daw_audio_core_result result = daw_audio_core_prepare_graph(core, &request);
    if (result != DAW_AUDIO_CORE_OK) return result;
    daw_audio_sampler_state sampler_state = sampler;
    sampler_state.zone_count = static_cast<uint32_t>(zones.size());
    result = kind == DAW_AUDIO_INSTRUMENT_KIND_SYNTH ? daw_audio_core_configure_synth(core, 1, &synth)
      : kind == DAW_AUDIO_INSTRUMENT_KIND_GRANULAR ? daw_audio_core_configure_granular(core, 1, &granular)
      : daw_audio_core_configure_sampler(core, 1, &sampler_state, zones.data());
    if (result != DAW_AUDIO_CORE_OK) {
      expect(daw_audio_core_cancel_prepared_graph(core, revision + 1), DAW_AUDIO_CORE_OK);
      return result;
    }
    expect(daw_audio_core_publish(core, revision + 1), DAW_AUDIO_CORE_OK);
    if (++revision == 1) {
      const daw_audio_transport_state transport{.epoch = 1, .running = 1};
      expect(daw_audio_core_set_transport(core, &transport), DAW_AUDIO_CORE_OK);
    }
    return DAW_AUDIO_CORE_OK;
  }
  void push(uint32_t type, uint64_t note_id, uint32_t note, float value) {
    ++sequence;
    events.push_back({.node_id = 1, .note_id = note_id, .sequence = sequence, .epoch = 1, .type = type, .note = note, .value = value});
  }
  uint64_t note_on(uint32_t note, float velocity = 1.0F) {
    push(DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON, sequence + 1, note, velocity);
    return sequence;
  }
  void note_off(uint64_t id, uint32_t note) { push(DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF, id, note, 0.0F); }
  void sustain(bool on) { push(DAW_AUDIO_INSTRUMENT_EVENT_SUSTAIN, 0, 0, on ? 1.0F : 0.0F); }
  void parameter(uint32_t target, float value, uint32_t frame_offset = 0) {
    push(DAW_AUDIO_INSTRUMENT_EVENT_PARAMETER, 0, target, value);
    events.back().frame_offset = frame_offset;
  }
  void render(uint32_t blocks) {
    for (uint32_t block = 0; block < blocks; ++block) {
      std::array<std::array<float, frames>, 2> samples{};
      float *outputs[]{samples[0].data(), samples[1].data()};
      const daw_audio_core_process_block request{
        .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = frames, .channel_count = 2, .outputs = outputs,
        .graph_revision = revision, .transport_epoch = 1,
        .instrument_event_count = static_cast<uint32_t>(events.size()),
        .instrument_events = events.empty() ? nullptr : events.data(),
      };
      expect(daw_audio_core_process(core, &request), DAW_AUDIO_CORE_OK);
      events.clear();
      for (uint32_t channel = 0; channel < 2; ++channel) heard[channel].insert(heard[channel].end(), samples[channel].begin(), samples[channel].end());
    }
  }
  size_t rendered() const { return heard[0].size(); }
  // An edit that cannot be heard and replaces the instrument (a discrete field, the
  // LFO shape or the filter mode of a filter that is off): a held note must come
  // through it untouched.
  void quiet_edit() {
    if (kind == DAW_AUDIO_INSTRUMENT_KIND_SYNTH) synth.lfo_waveform ^= 1u;
    else if (kind == DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) ++granular.seed;
    else sampler.filter_mode ^= 1u;
  }
};

const char *kind_name(uint32_t kind) {
  return kind == DAW_AUDIO_INSTRUMENT_KIND_SYNTH ? "synth" : kind == DAW_AUDIO_INSTRUMENT_KIND_SAMPLER ? "sampler"
    : kind == DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK ? "drum rack" : "granular";
}

void phase6i_require(bool ok, const char *name, const char *what, float actual, float expected) {
  if (ok) return;
  std::fprintf(stderr, "phase 6i contract: %s: %s: actual %.6f expected %.6f\n", name, what, actual, expected);
  std::abort();
}

float largest_difference(const std::vector<float> &left, const std::vector<float> &right, size_t from) {
  float largest = 0.0F;
  for (size_t index = from; index < left.size(); ++index) largest = std::max(largest, std::abs(left[index] - right[index]));
  return largest;
}

float peak_after(const std::vector<float> &signal, size_t from) {
  float peak = 0.0F;
  for (size_t index = from; index < signal.size(); ++index) peak = std::max(peak, std::abs(signal[index]));
  return peak;
}

uint32_t longest_silence(const std::vector<float> &signal, size_t from) {
  uint32_t longest = 0;
  uint32_t run = 0;
  for (size_t index = from; index < signal.size(); ++index) {
    run = std::abs(signal[index]) < 1e-6F ? run + 1 : 0;
    longest = std::max(longest, run);
  }
  return longest;
}

// What the edit is blended into: the old instrument's output times the fade-out plus
// the new one's times the fade-in, the only thing a seeded replacement may play.
float largest_blend_error(
  const std::vector<float> &actual, const std::vector<float> &before, const std::vector<float> &after, size_t from) {
  float largest = 0.0F;
  for (size_t index = from; index < actual.size(); ++index) {
    const float entering = std::min(1.0F, static_cast<float>(index - from) / static_cast<float>(HeldRig::fade));
    largest = std::max(largest, std::abs(actual[index] - (before[index] * (1.0F - entering) + after[index] * entering)));
  }
  return largest;
}

// A held note and an edit that is not live: the output never goes quiet for longer
// than the unedited reference does, and the voice's phase goes on (no deviation from
// the reference at all, since the edit is inaudible).
void test_phase6i_held_note_survives_an_edit(const uint32_t kind) {
  {
    HeldRig edited(kind);
    HeldRig reference(kind);
    for (HeldRig *rig : {&edited, &reference}) {
      expect(rig->commit(), DAW_AUDIO_CORE_OK);
      rig->note_on(60);
      rig->render(20);
    }
    const size_t edit = edited.rendered();
    edited.quiet_edit();
    expect(edited.commit(), DAW_AUDIO_CORE_OK);
    edited.render(20);
    reference.render(20);
    phase6i_require(peak_after(reference.heard[0], edit) > 0.05F, kind_name(kind), "the held note was not sounding",
      peak_after(reference.heard[0], edit), 0.05F);
    phase6i_require(longest_silence(edited.heard[0], edit) <= longest_silence(reference.heard[0], edit), kind_name(kind),
      "the output went quiet across the edit", static_cast<float>(longest_silence(edited.heard[0], edit)),
      static_cast<float>(longest_silence(reference.heard[0], edit)));
    for (uint32_t channel = 0; channel < 2; ++channel) {
      const float deviation = largest_difference(edited.heard[channel], reference.heard[channel], edit);
      phase6i_require(deviation < 1e-5F, kind_name(kind), "the held voice did not go on at its phase", deviation, 0.0F);
    }
  }
}

// The sustain pedal is held across the edit, and a note-off after it releases the
// copied voice: the edited synth follows the reference through both.
void test_phase6i_pedal_and_note_off_survive_an_edit() {
  for (const bool pedal : {true, false}) {
    HeldRig edited(DAW_AUDIO_INSTRUMENT_KIND_SYNTH);
    HeldRig reference(DAW_AUDIO_INSTRUMENT_KIND_SYNTH);
    for (HeldRig *rig : {&edited, &reference}) {
      expect(rig->commit(), DAW_AUDIO_CORE_OK);
      if (pedal) rig->sustain(true);
      const uint64_t note = rig->note_on(60);
      if (pedal) rig->note_off(note, 60);
      rig->render(20);
    }
    const size_t edit = edited.rendered();
    edited.quiet_edit();
    expect(edited.commit(), DAW_AUDIO_CORE_OK);
    for (HeldRig *rig : {&edited, &reference}) rig->render(20);
    phase6i_require(peak_after(reference.heard[0], edit) > 0.05F, "synth", "the held note was not sounding",
      peak_after(reference.heard[0], edit), 0.05F);
    for (HeldRig *rig : {&edited, &reference}) {
      if (pedal) rig->sustain(false);
      else rig->note_off(1, 60);
      rig->render(20);
    }
    const float deviation = largest_difference(edited.heard[0], reference.heard[0], edit);
    phase6i_require(deviation < 1e-5F, "synth", pedal ? "the pedal did not survive the edit" : "a note-off did not release the copied voice", deviation, 0.0F);
    phase6i_require(peak_after(edited.heard[0], edited.rendered() - 2 * HeldRig::frames) < 1e-4F, "synth",
      "the voice was not released", peak_after(edited.heard[0], edited.rendered() - 2 * HeldRig::frames), 1e-4F);
  }
}

void play_chord(HeldRig &rig, uint32_t first_note, uint32_t count) {
  for (uint32_t note = first_note; note < first_note + count; ++note) rig.note_on(note);
}

// Polyphony 8 -> 2: the two newest voices go on with unbroken phase and the other
// six leave on the fade; 2 -> 8: the sounding voices are unchanged.
void test_phase6i_polyphony_change_keeps_the_newest_voices(const uint32_t kind) {
  {
    HeldRig edited(kind, 8);
    HeldRig all(kind, 8);
    HeldRig newest(kind, 2);
    for (HeldRig *rig : {&edited, &all, &newest}) expect(rig->commit(), DAW_AUDIO_CORE_OK);
    play_chord(edited, 48, 8);
    play_chord(all, 48, 8);
    play_chord(newest, 54, 2);
    for (HeldRig *rig : {&edited, &all, &newest}) rig->render(20);
    const size_t edit = edited.rendered();
    edited.capacity = 2;
    expect(edited.commit(), DAW_AUDIO_CORE_OK);
    for (HeldRig *rig : {&edited, &all, &newest}) rig->render(12);
    phase6i_require(largest_difference(all.heard[0], newest.heard[0], edit) > 0.1F, kind_name(kind),
      "the chord and its two newest notes are not told apart", largest_difference(all.heard[0], newest.heard[0], edit), 0.1F);
    const float blend = largest_blend_error(edited.heard[0], all.heard[0], newest.heard[0], edit);
    phase6i_require(blend < 1e-4F, kind_name(kind), "polyphony 8 -> 2 is not the old chord fading to its two newest", blend, 0.0F);
    const float settled = largest_difference(edited.heard[0], newest.heard[0], edit + 2 * HeldRig::fade);
    phase6i_require(settled < 1e-4F, kind_name(kind), "the two newest voices did not go on", settled, 0.0F);

    HeldRig raised(kind, 2);
    HeldRig steady(kind, 2);
    for (HeldRig *rig : {&raised, &steady}) {
      expect(rig->commit(), DAW_AUDIO_CORE_OK);
      play_chord(*rig, 54, 2);
      rig->render(20);
    }
    const size_t raise = raised.rendered();
    raised.capacity = 8;
    expect(raised.commit(), DAW_AUDIO_CORE_OK);
    for (HeldRig *rig : {&raised, &steady}) rig->render(12);
    const float unchanged = largest_difference(raised.heard[0], steady.heard[0], raise);
    phase6i_require(unchanged < 1e-5F, kind_name(kind), "polyphony 2 -> 8 changed the sounding voices", unchanged, 0.0F);
  }
}

// An edit to a zone under a held note applies at once, at the same playhead, with
// no retrigger. The tuning, start and swapped-asset cases are held to the sample
// the voice must read at each frame, worked out from the asset.
void test_phase6i_zone_edit_under_a_held_note(const uint32_t kind) {
  {
    const auto held = [kind](auto edit, uint32_t blocks_after) {
      auto rig = std::make_unique<HeldRig>(kind);
      expect(rig->commit(), DAW_AUDIO_CORE_OK);
      rig->note_on(60);
      rig->render(20);
      edit(*rig);
      expect(rig->commit(), DAW_AUDIO_CORE_OK);
      rig->render(blocks_after);
      return rig;
    };
    const size_t edit = 20 * HeldRig::frames;
    // The continuous values (gain, pan, tuning) slew onto the edit with no retrigger, and
    // have landed on it once the settle time has run.
    const uint32_t settle_blocks = 170;  // 20 held blocks, then 150 for the slew to land
    const size_t slewed = edit + (settle_blocks - 100) * HeldRig::frames;  // the last 80 blocks
    const size_t settled = edit + 2 * HeldRig::fade;
    const auto reference = held([](HeldRig &) {}, settle_blocks);
    const char *name = kind_name(kind);
    // Gain: half of what the unedited instrument plays.
    const auto quieter = held([](HeldRig &rig) { for (auto &zone : rig.zones) zone.gain = 0.5F; }, settle_blocks);
    float gain_error = 0.0F;
    for (size_t index = slewed; index < quieter->heard[0].size(); ++index) {
      gain_error = std::max(gain_error, std::abs(quieter->heard[0][index] - 0.5F * reference->heard[0][index]));
    }
    phase6i_require(gain_error < 1e-4F, name, "a gain edit did not reach the held note", gain_error, 0.0F);
    // Pan: hard right takes the left channel to nothing and doubles the right by sqrt 2.
    const auto panned = held([](HeldRig &rig) { for (auto &zone : rig.zones) zone.pan = 1.0F; }, settle_blocks);
    phase6i_require(peak_after(panned->heard[0], slewed) < 1e-4F, name, "a pan edit left sound in the left channel",
      peak_after(panned->heard[0], slewed), 0.0F);
    float pan_error = 0.0F;
    for (size_t index = slewed; index < panned->heard[1].size(); ++index) {
      pan_error = std::max(pan_error, std::abs(panned->heard[1][index] - 1.41421356F * reference->heard[0][index]));
    }
    phase6i_require(pan_error < 1e-4F, name, "a pan edit did not reach the held note", pan_error, 0.0F);
    // Tuning: an octave up halves the period (the asset has 37 cycles over its 20000
    // frames at the core's rate), measured over the settled stretch.
    const auto tuned = held([](HeldRig &rig) { for (auto &zone : rig.zones) zone.tune_cents = 1200.0F; }, settle_blocks);
    const std::vector<float> &tuned_left = tuned->heard[0];
    double first_cross = -1.0;
    double last_cross = 0.0;
    uint32_t crossings = 0;
    for (size_t index = slewed + 1; index < tuned_left.size(); ++index) {
      if (!(tuned_left[index - 1] < 0.0F && tuned_left[index] >= 0.0F)) continue;
      last_cross = static_cast<double>(index - 1) + -tuned_left[index - 1] / (tuned_left[index] - tuned_left[index - 1]);
      if (first_cross < 0.0) first_cross = last_cross;
      else ++crossings;
    }
    const double period = (last_cross - first_cross) / crossings;
    phase6i_require(crossings > 10 && std::abs(period - 0.5 * HeldRig::asset_frames / 37.0) < 0.05, name,
      "a tuning edit did not reach the held note", static_cast<float>(period), static_cast<float>(0.5 * HeldRig::asset_frames / 37.0));
    // Start: the playhead moves by the distance the start moved; the loop is the whole asset, so a one-shot.
    const auto one_shot = [](HeldRig &rig) {
      for (auto &zone : rig.zones) {
        zone.playback_mode = DAW_AUDIO_SAMPLE_PLAYBACK_ONE_SHOT;
        zone.loop_end_frame = 0;
      }
    };
    const auto started = held([&one_shot](HeldRig &rig) {
      one_shot(rig);
      expect(rig.commit(), DAW_AUDIO_CORE_OK);
      rig.render(1);
      for (auto &zone : rig.zones) zone.start_frame = 1000;
    }, 12);
    const size_t started_edit = 21 * HeldRig::frames;
    float start_error = 0.0F;
    for (size_t index = started_edit + 2 * HeldRig::fade; index < started->heard[0].size(); ++index) {
      start_error = std::max(start_error, std::abs(started->heard[0][index] - started->sources[0][index + 1000]));
    }
    phase6i_require(start_error < 1e-4F, name, "a start edit did not move the held note", start_error, 0.0F);
    // A swapped asset: the same playhead in the new sample, and the old asset stays
    // resident until the replaced instrument has faded out.
    HeldRig swapped(kind);
    expect(swapped.commit(), DAW_AUDIO_CORE_OK);
    swapped.note_on(60);
    swapped.render(20);
    for (auto &zone : swapped.zones) zone.asset = swapped.assets[1];
    expect(swapped.commit(), DAW_AUDIO_CORE_OK);
    expect(daw_audio_core_release_asset(swapped.core, swapped.assets[0]), DAW_AUDIO_CORE_ASSET_IN_USE);
    swapped.render(12);
    float swap_error = 0.0F;
    for (size_t index = settled; index < swapped.heard[0].size(); ++index) {
      swap_error = std::max(swap_error, std::abs(swapped.heard[0][index] - swapped.sources[1][index % HeldRig::asset_frames]));
    }
    phase6i_require(swap_error < 1e-4F, name, "a swapped asset did not play at the same position", swap_error, 0.0F);
    expect(daw_audio_core_release_asset(swapped.core, swapped.assets[0]), DAW_AUDIO_CORE_OK);
    // A swap to a sample shorter than the playhead ends the voice on the fade.
    HeldRig shortened(kind);
    expect(shortened.commit(), DAW_AUDIO_CORE_OK);
    shortened.note_on(60);
    shortened.render(20);
    for (auto &zone : shortened.zones) {
      zone.asset = shortened.assets[2];
      zone.end_frame = HeldRig::short_frames;
      zone.loop_end_frame = HeldRig::short_frames;
    }
    expect(shortened.commit(), DAW_AUDIO_CORE_OK);
    shortened.render(12);
    phase6i_require(peak_after(shortened.heard[0], settled) < 1e-6F, name, "a voice past the end of the new sample went on",
      peak_after(shortened.heard[0], settled), 0.0F);
    phase6i_require(peak_after(shortened.heard[0], edit) > 0.05F, name, "the old voice did not fade out",
      peak_after(shortened.heard[0], edit), 0.05F);
  }
}

// Granular: a parameter edit under a held note keeps the cloud going.
void test_phase6i_granular_parameter_edit_under_a_held_note() {
  HeldRig edited(DAW_AUDIO_INSTRUMENT_KIND_GRANULAR);
  HeldRig reference(DAW_AUDIO_INSTRUMENT_KIND_GRANULAR);
  for (HeldRig *rig : {&edited, &reference}) {
    expect(rig->commit(), DAW_AUDIO_CORE_OK);
    rig->note_on(60);
    rig->render(40);
  }
  const size_t edit = edited.rendered();
  edited.granular.pitch_semitones = 12.0F;
  edited.granular.grain_size_ms = 40.0F;
  expect(edited.commit(), DAW_AUDIO_CORE_OK);
  for (HeldRig *rig : {&edited, &reference}) rig->render(40);
  phase6i_require(peak_after(edited.heard[0], edit + 2 * HeldRig::fade) > 0.05F, "granular", "the cloud stopped under the edit",
    peak_after(edited.heard[0], edit + 2 * HeldRig::fade), 0.05F);
  phase6i_require(longest_silence(edited.heard[0], edit) <= longest_silence(reference.heard[0], edit), "granular",
    "the cloud went quiet across the edit", static_cast<float>(longest_silence(edited.heard[0], edit)),
    static_cast<float>(longest_silence(reference.heard[0], edit)));
}

// Ten replacements inside 50 ms (three blocks, 4 ms, apart), each starting before the last has finished: all are
// accepted, the held note never deviates (inaudible edits), and when the edits are
// gain changes the output never rises above the louder configuration, so the weights
// of the instruments blended at once sum to no more than one.
void test_phase6i_replacement_chain_has_no_level_bump() {
  HeldRig edited(DAW_AUDIO_INSTRUMENT_KIND_SYNTH);
  HeldRig reference(DAW_AUDIO_INSTRUMENT_KIND_SYNTH);
  HeldRig bumped(DAW_AUDIO_INSTRUMENT_KIND_SYNTH);
  HeldRig loud(DAW_AUDIO_INSTRUMENT_KIND_SYNTH);
  loud.synth.output_gain = 0.5F;
  for (HeldRig *rig : {&edited, &reference, &bumped, &loud}) {
    expect(rig->commit(), DAW_AUDIO_CORE_OK);
    rig->note_on(60);
    rig->render(20);
  }
  const size_t edit = edited.rendered();
  for (uint32_t step = 0; step < 10; ++step) {
    edited.synth.lfo_waveform = step % 2;
    bumped.synth.lfo_waveform = step % 2;
    bumped.synth.output_gain = step % 2 == 0 ? 0.25F : 0.5F;
    expect(edited.commit(), DAW_AUDIO_CORE_OK);
    expect(bumped.commit(), DAW_AUDIO_CORE_OK);
    for (HeldRig *rig : {&edited, &reference, &bumped, &loud}) rig->render(3);  // 4 ms: the previous fade is still running
  }
  for (HeldRig *rig : {&edited, &reference, &bumped, &loud}) rig->render(12);
  const float deviation = largest_difference(edited.heard[0], reference.heard[0], edit);
  phase6i_require(deviation < 1e-5F, "synth", "ten replacements disturbed the held note", deviation, 0.0F);
  float excess = 0.0F;
  for (size_t index = edit; index < bumped.heard[0].size(); ++index) {
    excess = std::max(excess, std::abs(bumped.heard[0][index]) - std::abs(loud.heard[0][index]));
  }
  phase6i_require(excess < 1e-5F, "synth", "a level bump across the seam", excess, 0.0F);
}

// Phase 6i, Mechanism B: a drag is smooth. Every case drags one value in a few steps
// ten blocks apart (a step is what a drag delivers, one per block at the fastest) under
// a held sine and is held to what a steady instrument at any of the dragged values
// plays: the output may never step by more than the steepest slope any of them has
// (a zipper is a step), and a gliding pitch may never change its period by more than
// a few percent from one cycle to the next. The sine makes both measurable.
enum class Drag { Gain, Pan, Cutoff, Pitch };

const char *drag_name(Drag drag) {
  return drag == Drag::Gain ? "gain" : drag == Drag::Pan ? "pan" : drag == Drag::Cutoff ? "cutoff" : "pitch";
}

std::vector<float> drag_values(uint32_t kind, Drag drag) {
  switch (drag) {
    case Drag::Gain: return {0.1F, 0.4F, 0.7F, 1.0F};
    case Drag::Pan: return {-1.0F, 0.0F, 1.0F};
    // A synth's key tracking lifts its cutoff above the tone. A sampler's filter has none, and its tone (note 84
    // on a sine sample, 873 Hz) sits where the resonance peak lands, so the drag moves the level of what is heard.
    case Drag::Cutoff:
      return kind == DAW_AUDIO_INSTRUMENT_KIND_SYNTH ? std::vector<float>{12000.0F, 6000.0F, 3000.0F, 1800.0F}
                                                      : std::vector<float>{12000.0F, 3000.0F, 1500.0F, 1000.0F};
    case Drag::Pitch: return {0.0F, 2.0F, 4.0F, 6.0F};
  }
  return {};
}

void set_drag_value(HeldRig &rig, Drag drag, float value) {
  const bool synth = rig.kind == DAW_AUDIO_INSTRUMENT_KIND_SYNTH;
  if (drag == Drag::Gain) {
    if (synth) rig.synth.output_gain = value;
    else for (auto &zone : rig.zones) zone.gain = value;
  } else if (drag == Drag::Pan) {
    if (synth) rig.synth.output_pan = value;
    else for (auto &zone : rig.zones) zone.pan = value;
  } else if (drag == Drag::Cutoff) {
    if (synth) {
      rig.synth.filter_enabled = 1;
      rig.synth.filter_resonance = 25.0F;
      rig.synth.filter_cutoff_hz = value;
    } else {
      rig.sampler.filter_enabled = 1;
      rig.sampler.filter_resonance = 25.0F;
      rig.sampler.filter_cutoff_hz = value;
    }
  } else if (synth) {
    rig.synth.oscillators[0].semitone = static_cast<int32_t>(value);
  } else {
    for (auto &zone : rig.zones) zone.tune_cents = 100.0F * value;
  }
}

constexpr uint32_t kDragNote = 84;
constexpr uint32_t kDragStepBlocks = 10;
constexpr uint32_t kDragSettleBlocks = 150;

std::unique_ptr<HeldRig> held_for_drag(uint32_t kind, Drag drag, float value, bool live) {
  auto rig = std::make_unique<HeldRig>(kind);
  rig->live_targets = live ? 8 : 0;
  for (auto &zone : rig->zones) {
    zone.asset = rig->assets[1];
    if (kind == DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK) zone.key_low = zone.key_high = kDragNote;
  }
  set_drag_value(*rig, drag, value);
  expect(rig->commit(), DAW_AUDIO_CORE_OK);
  rig->note_on(kDragNote);
  rig->render(20);
  return rig;
}

float largest_step(const std::vector<float> &signal, size_t from) {
  float largest = 0.0F;
  for (size_t index = from; index < signal.size(); ++index) largest = std::max(largest, std::abs(signal[index] - signal[index - 1]));
  return largest;
}

// The widest ratio between two neighbouring cycles, from interpolated upward zero crossings.
float widest_period_step(const std::vector<float> &signal, size_t from, size_t to) {
  double last_cross = -1.0;
  double last_period = 0.0;
  double widest = 1.0;
  for (size_t index = from + 1; index < to; ++index) {
    if (!(signal[index - 1] < 0.0F && signal[index] >= 0.0F)) continue;
    const double cross = static_cast<double>(index - 1) + -signal[index - 1] / (signal[index] - signal[index - 1]);
    if (last_cross >= 0.0) {
      const double period = cross - last_cross;
      if (last_period > 0.0) widest = std::max({widest, period / last_period, last_period / period});
      last_period = period;
    }
    last_cross = cross;
  }
  return static_cast<float>(widest);
}

// How the dragged values reach the core: as publishes of the edited configuration, or
// as the live events of a synth (gain, pan and cutoff are live targets).
void test_phase6i_drag_is_smooth(const uint32_t kind, const Drag drag, const bool live) {
  const std::vector<float> values = drag_values(kind, drag);
  const std::array<uint32_t, 4> targets{DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_GAIN, DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_PAN,
    DAW_AUDIO_SYNTH_PARAMETER_FILTER_CUTOFF_HZ, 0};
  const auto dragged = held_for_drag(kind, drag, values[0], live);
  const size_t from = dragged->rendered();
  for (size_t step = 1; step < values.size(); ++step) {
    if (live) {
      dragged->parameter(targets[static_cast<size_t>(drag)], values[step]);
    } else {
      set_drag_value(*dragged, drag, values[step]);
      expect(dragged->commit(), DAW_AUDIO_CORE_OK);
    }
    dragged->render(kDragStepBlocks);
  }
  const size_t drag_end = dragged->rendered();
  dragged->render(kDragSettleBlocks);
  const std::string name = std::string(kind_name(kind)) + " " + drag_name(drag) + (live ? " (live)" : "");
  if (drag == Drag::Pitch) {
    const float widest = widest_period_step(dragged->heard[0], from, drag_end);
    phase6i_require(widest < 1.025F, name.c_str(), "the pitch stepped from one cycle to the next", widest, 1.025F);
    return;
  }
  for (uint32_t channel = 0; channel < 2; ++channel) {
    float steepest = 0.0F;
    for (const float value : values) {
      const auto steady = held_for_drag(kind, drag, value, live);
      steady->render(kDragStepBlocks * static_cast<uint32_t>(values.size() - 1) + kDragSettleBlocks);
      steepest = std::max(steepest, largest_step(steady->heard[channel], from));
    }
    const float step = largest_step(dragged->heard[channel], from);
    phase6i_require(step < 1.25F * steepest, name.c_str(), "the output stepped during the drag", step, 1.25F * steepest);
  }
  const auto arrived = held_for_drag(kind, drag, values.back(), live);
  arrived->render(kDragStepBlocks * static_cast<uint32_t>(values.size() - 1) + kDragSettleBlocks);
  const float miss = largest_difference(dragged->heard[0], arrived->heard[0], dragged->rendered() - 20 * HeldRig::frames);
  phase6i_require(miss < 1e-3F, name.c_str(), "the drag did not arrive at its value", miss, 0.0F);
}

// 256 events in one block that swing the gain end to end, then a reversal before the
// first move has finished: no step, no overshoot past the louder value, and the last
// event wins.
void test_phase6i_event_burst_and_reversal_are_smooth() {
  const auto steady = [](float gain) {
    auto rig = held_for_drag(DAW_AUDIO_INSTRUMENT_KIND_SYNTH, Drag::Gain, gain, true);
    rig->render(200);
    return rig;
  };
  const auto loud = steady(1.0F);
  const float steepest = largest_step(loud->heard[0], 20 * HeldRig::frames);
  const float loudest = peak_after(loud->heard[0], 20 * HeldRig::frames);
  const auto burst = held_for_drag(DAW_AUDIO_INSTRUMENT_KIND_SYNTH, Drag::Gain, 0.2F, true);
  for (uint32_t event = 0; event < 256; ++event) {
    burst->parameter(DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_GAIN, event == 255 ? 0.6F : event % 2 == 0 ? 1.0F : 0.2F, event / 4);
  }
  burst->render(200);
  const auto reversed = held_for_drag(DAW_AUDIO_INSTRUMENT_KIND_SYNTH, Drag::Gain, 0.2F, true);
  reversed->parameter(DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_GAIN, 1.0F);
  reversed->render(2);
  reversed->parameter(DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_GAIN, 0.2F);
  reversed->render(198);
  const size_t from = 20 * HeldRig::frames;
  for (const auto *rig : {burst.get(), reversed.get()}) {
    const char *name = rig == burst.get() ? "burst of 256 events" : "reversal mid-slew";
    const float step = largest_step(rig->heard[0], from);
    phase6i_require(step < 1.25F * steepest, name, "the output stepped", step, 1.25F * steepest);
    phase6i_require(peak_after(rig->heard[0], from) <= loudest * 1.0001F, name, "the value overshot", peak_after(rig->heard[0], from), loudest);
  }
  const auto last = steady(0.6F);
  const float miss = largest_difference(burst->heard[0], last->heard[0], burst->rendered() - 20 * HeldRig::frames);
  phase6i_require(miss < 1e-3F, "burst of 256 events", "the last event did not win", miss, 0.0F);
}

// Automation and a manual drag write the same parameter: events and publishes in turn
// reach one value, with no step between them.
void test_phase6i_automation_and_a_drag_share_a_parameter() {
  const std::vector<float> values = drag_values(DAW_AUDIO_INSTRUMENT_KIND_SYNTH, Drag::Gain);
  const auto steady = held_for_drag(DAW_AUDIO_INSTRUMENT_KIND_SYNTH, Drag::Gain, values.back(), true);
  steady->render(kDragStepBlocks * static_cast<uint32_t>(values.size() - 1) + kDragSettleBlocks);
  const auto mixed = held_for_drag(DAW_AUDIO_INSTRUMENT_KIND_SYNTH, Drag::Gain, values[0], true);
  const size_t from = mixed->rendered();
  for (size_t step = 1; step < values.size(); ++step) {
    if (step % 2 == 0) {
      mixed->synth.output_gain = values[step];
      expect(mixed->commit(), DAW_AUDIO_CORE_OK);
    } else {
      mixed->parameter(DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_GAIN, values[step]);
    }
    mixed->render(kDragStepBlocks);
  }
  mixed->render(kDragSettleBlocks);
  const float step = largest_step(mixed->heard[0], from);
  const float steepest = largest_step(steady->heard[0], from);
  phase6i_require(step < 1.25F * steepest, "synth gain", "automation and a drag stepped", step, 1.25F * steepest);
  const float miss = largest_difference(mixed->heard[0], steady->heard[0], mixed->rendered() - 20 * HeldRig::frames);
  phase6i_require(miss < 1e-3F, "synth gain", "the last write did not win", miss, 0.0F);
}

// A drag already sliding when a replacement lands: the replacement goes on from the
// value the old instrument had applied, so the output matches an instrument that was
// never replaced (the discrete edit is inaudible).
void test_phase6i_replacement_goes_on_from_the_applied_value(const uint32_t kind) {
  auto replaced = held_for_drag(kind, Drag::Gain, 0.2F, false);
  auto kept = held_for_drag(kind, Drag::Gain, 0.2F, false);
  const size_t from = replaced->rendered();
  for (HeldRig *rig : {replaced.get(), kept.get()}) {
    set_drag_value(*rig, Drag::Gain, 1.0F);
    expect(rig->commit(), DAW_AUDIO_CORE_OK);
    rig->render(3);
  }
  replaced->quiet_edit();
  expect(replaced->commit(), DAW_AUDIO_CORE_OK);
  for (HeldRig *rig : {replaced.get(), kept.get()}) rig->render(kDragSettleBlocks);
  const float deviation = largest_difference(replaced->heard[0], kept->heard[0], from);
  phase6i_require(deviation < 1e-4F, kind_name(kind), "the replacement jumped from the applied value", deviation, 0.0F);
}

// Continuous-only edits never replace the instrument: twenty published back to back
// (a replacement chain would refuse the ninth) are all accepted and leave the output
// finite.
void test_phase6i_continuous_edits_do_not_replace_the_instrument(const uint32_t kind) {
  HeldRig rig(kind);
  expect(rig.commit(), DAW_AUDIO_CORE_OK);
  rig.note_on(60);
  rig.render(20);
  for (uint32_t edit = 0; edit < 20; ++edit) {
    const bool high = edit % 2 == 0;
    if (kind == DAW_AUDIO_INSTRUMENT_KIND_SYNTH) rig.synth.output_gain = high ? 0.25F : 0.5F;
    else if (kind == DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) rig.granular.density_hz = high ? 120.0F : 100.0F;
    else for (auto &zone : rig.zones) zone.gain = high ? 0.5F : 1.0F;
    const daw_audio_core_result result = rig.commit();
    phase6i_require(result == DAW_AUDIO_CORE_OK, kind_name(kind), "a continuous edit was refused", static_cast<float>(result), 0.0F);
  }
  rig.render(20);
  phase6i_require(peak_after(rig.heard[0], 0) < 10.0F && std::isfinite(peak_after(rig.heard[1], 0)), kind_name(kind),
    "the output left the finite range", peak_after(rig.heard[0], 0), 10.0F);
}

// The padding of a state (a 64-bit handle sits on an 8-byte boundary, so the granular state and each sample zone carry some)
// is whatever the caller's memory held. Overwrites it, in the rig's granular state and zones, with `byte`.
void fill_padding(HeldRig &rig, const unsigned char byte) {
  const auto fill = [byte](auto &state, const size_t from, const size_t to) {
    std::memset(reinterpret_cast<unsigned char *>(&state) + from, byte, to - from);
  };
  fill(rig.granular, offsetof(daw_audio_granular_state, version) + sizeof(uint32_t), offsetof(daw_audio_granular_state, asset));
  fill(rig.granular, offsetof(daw_audio_granular_state, stereo_spread) + sizeof(float), sizeof(daw_audio_granular_state));
  for (daw_audio_sample_zone &zone : rig.zones) {
    fill(zone, offsetof(daw_audio_sample_zone, choke_group) + sizeof(uint32_t), sizeof(daw_audio_sample_zone));
  }
}

// A drag of one continuous value keeps the instrument and slews, whatever the padding of each published state holds: the
// output is exactly what it is when every state's padding is clean.
void test_phase6i_padding_is_not_part_of_a_configuration(const uint32_t kind) {
  const auto dragged = [kind](const bool noisy) {
    auto rig = std::make_unique<HeldRig>(kind);
    expect(rig->commit(), DAW_AUDIO_CORE_OK);
    rig->note_on(60);
    rig->render(20);
    for (uint32_t step = 0; step < 6; ++step) {
      if (kind == DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) rig->granular.position = 0.2F + 0.1F * static_cast<float>(step);
      else for (auto &zone : rig->zones) zone.gain = 1.0F - 0.15F * static_cast<float>(step);
      fill_padding(*rig, noisy ? static_cast<unsigned char>(0xA5 ^ step) : 0);
      expect(rig->commit(), DAW_AUDIO_CORE_OK);
      rig->render(5);
    }
    return rig;
  };
  const auto noisy = dragged(true);
  const auto clean = dragged(false);
  phase6i_require(peak_after(clean->heard[0], 0) > 0.02F, kind_name(kind), "the instrument was not sounding", peak_after(clean->heard[0], 0), 0.02F);
  const float deviation = largest_difference(noisy->heard[0], clean->heard[0], 0);
  phase6i_require(deviation == 0.0F, kind_name(kind), "padding in a published state replaced the instrument", deviation, 0.0F);
}

#if defined(DAW_AUDIO_CORE_TEST_SPECTRAL_INTERNALS)
// Replacements that shrink a drum rack's zone count under held notes: no sounding sample voice may name a zone the
// instrument no longer has (the render path indexes the zone table by it).
void test_phase6i_replacement_leaves_no_voice_on_a_missing_zone() {
  HeldRig rig(DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK);
  expect(rig.commit(), DAW_AUDIO_CORE_OK);
  play_chord(rig, 48, 8);
  rig.render(10);
  uint32_t sounding = 0;
  for (const size_t zone_count : {7u, 4u, 2u, 1u}) {
    rig.zones.resize(zone_count);
    expect(rig.commit(), DAW_AUDIO_CORE_OK);
    rig.render(12);
    const InstrumentNodeState &runtime = published_instrument(*to_core(rig.core), 0);
    for (const SampleVoice &voice : runtime.sample_voices) {
      if (!voice.active) continue;
      ++sounding;
      phase6i_require(voice.zone < runtime.sampler.zone_count, "drum rack", "a sounding voice names a zone that is gone",
        static_cast<float>(voice.zone), static_cast<float>(runtime.sampler.zone_count));
    }
  }
  phase6i_require(sounding > 0, "drum rack", "no voice was sounding after the replacements", static_cast<float>(sounding), 1.0F);
}
#endif

// What cannot be set never reaches the voices: a value that is not a number is refused
// where it enters, a value dragged to nothing ends at exactly nothing (no subnormal
// tail), and a polyphony above the 32 voices the core holds is refused at configure.
void test_phase6i_bad_values_and_the_polyphony_cap() {
  HeldRig rig(DAW_AUDIO_INSTRUMENT_KIND_SYNTH);
  rig.live_targets = 8;
  expect(rig.commit(), DAW_AUDIO_CORE_OK);
  for (const float bad : {std::numeric_limits<float>::quiet_NaN(), std::numeric_limits<float>::infinity()}) {
    const daw_audio_instrument_event event{.node_id = 1, .sequence = 1, .epoch = 1, .type = DAW_AUDIO_INSTRUMENT_EVENT_PARAMETER,
      .note = DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_GAIN, .value = bad};
    phase6i_require(daw_audio_core_validate_instrument_target(rig.core, &event) == DAW_AUDIO_CORE_INVALID_ARGUMENT, "synth",
      "a value that is not a number was accepted as an event", bad, 0.0F);
    rig.synth.output_gain = bad;
    phase6i_require(rig.commit() == DAW_AUDIO_CORE_INVALID_ARGUMENT, "synth", "a value that is not a number was configured", bad, 0.0F);
  }
  rig.synth.output_gain = 0.5F;
  rig.note_on(72);
  rig.render(5);
  rig.parameter(DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_GAIN, 0.0F);
  rig.render(300);
  rig.parameter(DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_GAIN, 0.5F);
  rig.render(300);
  for (size_t index = 0; index < rig.rendered(); ++index) {
    phase6i_require(std::fpclassify(rig.heard[0][index]) != FP_SUBNORMAL && std::isfinite(rig.heard[0][index]), "synth",
      "a subnormal or non-finite sample", rig.heard[0][index], 0.0F);
    if (index >= 255 * HeldRig::frames && index < 305 * HeldRig::frames) {
      phase6i_require(rig.heard[0][index] == 0.0F, "synth", "a drag to nothing did not end at nothing", rig.heard[0][index], 0.0F);
    }
  }
  HeldRig too_many(DAW_AUDIO_INSTRUMENT_KIND_SYNTH, DAW_AUDIO_CORE_MAX_INSTRUMENT_VOICES + 1);
  phase6i_require(too_many.commit() == DAW_AUDIO_CORE_INVALID_ARGUMENT, "synth", "a polyphony above 32 was accepted",
    static_cast<float>(too_many.capacity), static_cast<float>(DAW_AUDIO_CORE_MAX_INSTRUMENT_VOICES));
  HeldRig at_cap(DAW_AUDIO_INSTRUMENT_KIND_SYNTH, DAW_AUDIO_CORE_MAX_INSTRUMENT_VOICES);
  expect(at_cap.commit(), DAW_AUDIO_CORE_OK);
}

// The cost of the slew, per 64-frame block, with each instrument at its fullest (32
// voices; the sampler over 32 zones; the granular at 128 grains): once settled, and
// right after an edit that moves every continuous value. Printed, not asserted: it is
// a measurement, and timing is not a gate.
void test_phase6i_slew_cost_at_the_maximum() {
  for (const uint32_t kind : {DAW_AUDIO_INSTRUMENT_KIND_SYNTH, DAW_AUDIO_INSTRUMENT_KIND_SAMPLER, DAW_AUDIO_INSTRUMENT_KIND_GRANULAR}) {
    HeldRig rig(kind, 32);
    if (kind == DAW_AUDIO_INSTRUMENT_KIND_SAMPLER) {
      rig.zones.clear();
      for (uint32_t note = 40; note < 72; ++note) rig.zones.push_back(rig.zone(note, note));
      rig.sampler.filter_enabled = 1;
    }
    rig.synth.filter_enabled = 1;
    rig.granular.max_grains = DAW_AUDIO_CORE_MAX_GRANULAR_GRAINS;
    rig.granular.density_hz = 200.0F;
    rig.granular.grain_size_ms = 1000.0F;
    expect(rig.commit(), DAW_AUDIO_CORE_OK);
    play_chord(rig, 40, 32);
    rig.render(200);
    const auto timed = [&rig](uint32_t blocks) {
      const auto begin = std::chrono::steady_clock::now();
      rig.render(blocks);
      return std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - begin).count() / blocks;
    };
    const double steady = timed(30);
    rig.synth.output_gain = 0.3F;
    rig.synth.output_pan = 0.5F;
    rig.synth.filter_cutoff_hz = 800.0F;
    rig.synth.oscillators[0].semitone = 5;
    rig.sampler.filter_cutoff_hz = 800.0F;
    for (auto &zone : rig.zones) {
      zone.gain = 0.3F;
      zone.pan = 0.5F;
      zone.tune_cents = 500.0F;
    }
    rig.granular.pitch_semitones = 5.0F;
    rig.granular.position = 0.2F;
    expect(rig.commit(), DAW_AUDIO_CORE_OK);
    const double moving = timed(30);
    std::printf("slew cost (%s, 32 voices): %.1f us per block settled, %.1f us per block while every value moves\n",
      kind_name(kind), steady, moving);
  }
}

// The cost of seeding on the callback at the maximum: 4 synths of 32 voices, 4
// samplers of 32 voices over 32 zones and 4 granulars of 128 grains, all sounding and
// all replaced in one publish. A publish allocates nothing and is timed beside one
// that replaces nothing, so the difference is what carrying the state costs.
void test_phase6i_publish_cost_at_the_maximum(const uint32_t revisions = 24) {
  constexpr uint32_t synths = 4;
  constexpr uint32_t instruments = 12;
  const auto core = create_core(HeldRig::frames, 2, 1);
  std::vector<float> source(HeldRig::asset_frames);
  for (uint32_t frame = 0; frame < source.size(); ++frame) source[frame] = std::sin(0.05F * static_cast<float>(frame));
  const std::array<const float *, 1> planes{source.data()};
  const daw_audio_asset_descriptor descriptor{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .revision = 1, .byte_length = source.size() * sizeof(float),
    .content_hash_prefix = 0, .frame_count = HeldRig::asset_frames, .sample_rate_hz = 48000, .channel_count = 1, .planes = planes.data(),
  };
  daw_audio_asset_handle asset = 0;
  expect(daw_audio_core_create_asset(core, &descriptor, &asset), DAW_AUDIO_CORE_OK);
  std::array<daw_audio_graph_node_descriptor, instruments + 1> nodes{};
  std::array<daw_audio_graph_edge_descriptor, instruments> edges{};
  for (uint32_t index = 0; index < instruments; ++index) {
    const uint32_t kind = index < synths ? DAW_AUDIO_INSTRUMENT_KIND_SYNTH
      : index < 2 * synths ? DAW_AUDIO_INSTRUMENT_KIND_SAMPLER : DAW_AUDIO_INSTRUMENT_KIND_GRANULAR;
    nodes[index] = {.id = index + 1, .kind = DAW_AUDIO_GRAPH_NODE_INSTRUMENT, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .instrument = {.kind = kind, .version = 1, .voice_capacity = 32}};
    edges[index] = {.id = index + 1, .from_node_id = index + 1, .to_node_id = instruments + 1, .gain = 0.05F,
      .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER};
  }
  nodes[instruments] = {.id = instruments + 1, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO};
  daw_audio_synth_state synth = phase3_synth(0.5F);
  daw_audio_sampler_state sampler{
    .version = 1, .zone_count = 32, .amp_sustain = 1.0F, .amp_release_ms = 1.0F, .filter_cutoff_hz = 20000.0F,
    .filter_resonance = 0.7F, .lfo_rate_hz = 0.01F,
  };
  std::array<daw_audio_sample_zone, 32> zones{};
  for (uint32_t index = 0; index < zones.size(); ++index) {
    zones[index] = {.asset = asset, .key_low = 40 + index, .key_high = 40 + index, .velocity_low = 1, .velocity_high = 127,
      .root_note = 60, .gain = 1.0F, .playback_mode = DAW_AUDIO_SAMPLE_PLAYBACK_FORWARD_LOOP,
      .end_frame = HeldRig::asset_frames, .loop_end_frame = HeldRig::asset_frames};
  }
  daw_audio_granular_state granular{
    .version = 1, .asset = asset, .seed = 77, .max_grains = 128, .window_shape = DAW_AUDIO_GRANULAR_WINDOW_HANN,
    .grain_size_ms = 1000.0F, .density_hz = 200.0F, .position = 0.5F, .spray = 0.3F, .stereo_spread = 0.3F,
  };
  uint32_t revision = 0;
  const auto commit = [&](bool edit) {
    if (edit) {
      synth.filter_key_tracking = synth.filter_key_tracking == 0.0F ? 0.25F : 0.0F;
      sampler.filter_cutoff_hz = sampler.filter_cutoff_hz == 20000.0F ? 19000.0F : 20000.0F;
      ++granular.seed;
    }
    const daw_audio_graph_prepare_request request{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = revision + 1, .node_count = instruments + 1,
      .edge_count = instruments, .nodes = nodes.data(), .edges = edges.data(),
    };
    expect(daw_audio_core_prepare_graph(core, &request), DAW_AUDIO_CORE_OK);
    for (uint32_t index = 0; index < instruments; ++index) {
      expect(index < synths ? daw_audio_core_configure_synth(core, index + 1, &synth)
        : index < 2 * synths ? daw_audio_core_configure_sampler(core, index + 1, &sampler, zones.data())
        : daw_audio_core_configure_granular(core, index + 1, &granular), DAW_AUDIO_CORE_OK);
    }
    const auto allocations = allocation_count;
    const auto begin = std::chrono::steady_clock::now();
    expect(daw_audio_core_publish(core, revision + 1), DAW_AUDIO_CORE_OK);
    const auto end = std::chrono::steady_clock::now();
    phase6i_require(allocation_count == allocations, "publish", "a publish allocated", static_cast<float>(allocation_count - allocations), 0.0F);
    ++revision;
    return std::chrono::duration<double, std::micro>(end - begin).count();
  };
  const auto render = [&](uint32_t blocks, const std::vector<daw_audio_instrument_event> &events) {
    std::array<std::array<float, HeldRig::frames>, 2> samples{};
    float *outputs[]{samples[0].data(), samples[1].data()};
    for (uint32_t block = 0; block < blocks; ++block) {
      const daw_audio_core_process_block request{
        .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = HeldRig::frames, .channel_count = 2, .outputs = outputs,
        .graph_revision = revision, .transport_epoch = 1,
        .instrument_event_count = block == 0 ? static_cast<uint32_t>(events.size()) : 0u,
        .instrument_events = block == 0 && !events.empty() ? events.data() : nullptr,
      };
      expect(daw_audio_core_process(core, &request), DAW_AUDIO_CORE_OK);
    }
  };
  commit(false);
  const daw_audio_transport_state transport{.epoch = 1, .running = 1};
  expect(daw_audio_core_set_transport(core, &transport), DAW_AUDIO_CORE_OK);
  std::vector<daw_audio_instrument_event> notes;
  uint64_t sequence = 0;
  for (uint32_t index = 0; index < instruments; ++index) {
    const uint32_t count = index < 2 * synths ? 32 : 2;
    for (uint32_t note = 0; note < count; ++note) {
      ++sequence;
      notes.push_back({.node_id = index + 1, .note_id = sequence, .sequence = sequence, .epoch = 1,
        .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON, .note = 40 + note, .value = 1.0F});
    }
  }
  for (size_t first = 0; first < notes.size(); first += 64) {  // a block takes a bounded number of events
    render(1, std::vector<daw_audio_instrument_event>(notes.begin() + static_cast<std::ptrdiff_t>(first),
      notes.begin() + static_cast<std::ptrdiff_t>(std::min(notes.size(), first + 64))));
  }
  render(600, {});  // long enough for 128 grains of 1 s to be sounding
  std::vector<double> replaced;
  std::vector<double> unchanged;
  for (uint32_t trial = 0; trial < revisions; ++trial) {
    replaced.push_back(commit(true));
    render(5, {});
    unchanged.push_back(commit(false));
    render(5, {});
  }
  std::sort(replaced.begin(), replaced.end());
  std::sort(unchanged.begin(), unchanged.end());
  std::printf("publish with %u sounding instruments replaced (4 x 32 synth voices, 4 x 32 sample voices over 32 zones, 4 x 128 grains): "
    "median %.1f us, max %.1f us; unchanged graph: median %.1f us, max %.1f us\n",
    instruments, replaced[replaced.size() / 2], replaced.back(), unchanged[unchanged.size() / 2], unchanged.back());
  daw_audio_core_destroy(core);
}

// The blend chain at its limit, with 32 voices held: eight replacements published
// back to back are accepted and, being inaudible edits, leave the output where the
// unedited reference has it (every instrument in the chain renders the same voices
// and the weights sum to one); the ninth is refused at prepare and nothing is cut.
// Prints what rendering the chain costs against rendering one instrument.
void test_phase6i_blend_chain_limit_with_held_voices() {
  HeldRig edited(DAW_AUDIO_INSTRUMENT_KIND_SYNTH, 32);
  HeldRig reference(DAW_AUDIO_INSTRUMENT_KIND_SYNTH, 32);
  for (HeldRig *rig : {&edited, &reference}) {
    expect(rig->commit(), DAW_AUDIO_CORE_OK);
    play_chord(*rig, 40, 32);
    rig->render(20);
  }
  const size_t edit = edited.rendered();
  for (uint32_t step = 0; step < 8; ++step) {
    edited.synth.lfo_waveform = step % 2 + 1;
    expect(edited.commit(), DAW_AUDIO_CORE_OK);
  }
  edited.synth.lfo_waveform = 3;
  expect(edited.commit(), DAW_AUDIO_CORE_CAPACITY_EXCEEDED);
  const auto begin = std::chrono::steady_clock::now();
  edited.render(4);
  const auto chain = std::chrono::steady_clock::now();
  reference.render(4);
  const auto single = std::chrono::steady_clock::now();
  edited.render(12);
  reference.render(12);
  const float deviation = largest_difference(edited.heard[0], reference.heard[0], edit);
  phase6i_require(deviation < 1e-4F, "synth", "an eight deep chain disturbed the held voices", deviation, 0.0F);
  edited.synth.lfo_waveform = 3;
  expect(edited.commit(), DAW_AUDIO_CORE_OK);  // the chain has run out: the node takes edits again
  std::printf("blend chain of 8 replacements over 32 held voices: %.1f us per block against %.1f us for one instrument\n",
    std::chrono::duration<double, std::micro>(chain - begin).count() / 4.0,
    std::chrono::duration<double, std::micro>(single - chain).count() / 4.0);
}

// Checkpoints 28, 40, 42 and 44 (superseded by Checkpoint 47): a reorder dips. A tone
// goes through [+6 dB utility, hard clipper] and is reordered to [clipper, utility]
// while a gain utility on the master keeps both orders' peaks below full scale. Three
// cores run side by side (the edited one and one built in each order), so the edited
// output is held to what the dip promises: the old order times a falling ramp for half
// a deletion fade, nothing, then the plan's order times a rising ramp for another
// half. `highpass` adds a 40 Hz Q=10 high-pass on the master, whose ring is long
// enough to keep any low-frequency energy the transition injected.
struct ReorderTrial {
  float edited_peak = 0.0F, old_peak = 0.0F, new_peak = 0.0F;
  float settled_residue = 0.0F;   // against the new order, the window right after the dip
  float late_residue = 0.0F;      // the same, four fades later
  float spread = 0.0F;
  float dip_error = 0.0F;         // while falling: against the old order, which the dip runs exactly
  float return_error = 0.0F;      // while rising: against the new order, whose stages carry the old order's state
  float largest_step = 0.0F, natural_step = 0.0F;
  float envelope() const { return std::max(old_peak, new_peak); }
};

void build_reorder_rig(Phase3Rig &rig, bool reordered, bool highpass, float master_db) {
  rig.clear();
  rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE);
  rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER);
  rig.add_edge(1, 2);
  if (reordered) rig.add_saturator(1, 11);
  rig.add_utility(1, 10, 6.0206F);
  if (!reordered) rig.add_saturator(1, 11);
  if (highpass) {
    daw_audio_eq_state eq{};
    eq.enabled = 1;
    for (auto &band : eq.bands) band = {0, DAW_AUDIO_EQ_BAND_PEAKING, 1000.0F, 0.0F, 1.0F, 0};
    eq.bands[0] = {1, DAW_AUDIO_EQ_BAND_HIGHPASS, 40.0F, 0.0F, 10.0F, 0};
    rig.add_state(2, 20, DAW_AUDIO_PROCESSOR_KIND_EQ, eq);
  }
  rig.add_utility(2, 21, master_db);
}

// What the dip emits at `at` frames after the publish: the gain on each order.
struct DipGain { float old_order = 0.0F, new_order = 0.0F; };
DipGain dip_gain(uint32_t at, uint32_t fade) {
  const uint32_t half = (fade + 1) / 2;
  if (at < half) return {static_cast<float>(half - at) / static_cast<float>(half), 0.0F};
  if (at < 2 * half) return {0.0F, static_cast<float>(at - half) / static_cast<float>(half)};
  return {0.0F, 1.0F};
}

ReorderTrial run_reorder_trial(float hz, uint32_t warm_blocks, bool highpass, uint32_t rate = 48000,
  float master_db = -6.0206F) {
  Phase3Rig edited(rate), old_order(rate), new_order(rate);
  build_reorder_rig(edited, false, highpass, master_db);
  build_reorder_rig(old_order, false, highpass, master_db);
  build_reorder_rig(new_order, true, highpass, master_db);
  for (Phase3Rig *rig : {&edited, &old_order, &new_order}) rig->commit(1);
  Phase3Rig::Block last{}, last_old{}, last_new{};
  for (uint32_t block = 0; block < warm_blocks; ++block) {
    last = edited.render_tone(hz, 0.4F, 1.0F);
    last_old = old_order.render_tone(hz, 0.4F, 1.0F);
    last_new = new_order.render_tone(hz, 0.4F, 1.0F);
  }
  build_reorder_rig(edited, true, highpass, master_db);
  edited.commit(2);
  const uint32_t fade = edited.fade_frames();
  float previous = last[0][Phase3Rig::frames - 1];
  float old_previous = last_old[0][Phase3Rig::frames - 1];
  float new_previous = last_new[0][Phase3Rig::frames - 1];
  ReorderTrial trial;
  for (uint32_t block = 0; block < 6 * fade / Phase3Rig::frames + 2; ++block) {
    const auto actual = edited.render_tone(hz, 0.4F, 1.0F);
    const auto from_old = old_order.render_tone(hz, 0.4F, 1.0F);
    const auto from_new = new_order.render_tone(hz, 0.4F, 1.0F);
    for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame) {
      const uint32_t at = block * Phase3Rig::frames + frame;
      const float residue = std::abs(actual[0][frame] - from_new[0][frame]);
      const DipGain gain = dip_gain(at, fade);
      trial.edited_peak = std::max(trial.edited_peak, std::abs(actual[0][frame]));
      trial.old_peak = std::max(trial.old_peak, std::abs(from_old[0][frame]));
      trial.new_peak = std::max(trial.new_peak, std::abs(from_new[0][frame]));
      trial.spread = std::max(trial.spread, std::abs(from_old[0][frame] - from_new[0][frame]));
      trial.largest_step = std::max(trial.largest_step, std::abs(actual[0][frame] - previous));
      trial.natural_step = std::max({trial.natural_step, std::abs(from_old[0][frame] - old_previous),
        std::abs(from_new[0][frame] - new_previous)});
      if (!highpass) {
        const float expected = gain.old_order * from_old[0][frame] + gain.new_order * from_new[0][frame];
        float &error = gain.new_order > 0.0F ? trial.return_error : trial.dip_error;
        if (at < fade + 1) error = std::max(error, std::abs(actual[0][frame] - expected));
      }
      if (at >= fade && at < 2 * fade) trial.settled_residue = std::max(trial.settled_residue, residue);
      if (at >= 5 * fade && at < 6 * fade) trial.late_residue = std::max(trial.late_residue, residue);
      previous = actual[0][frame];
      old_previous = from_old[0][frame];
      new_previous = from_new[0][frame];
    }
  }
  return trial;
}

// Checkpoints 28 and 40, superseded: a reorder of stages that do not commute is a dip,
// not a splice. The edited output is exactly the old order falling for half a fade,
// then the new order rising, so it never carries anything either order did not, and
// its steps are the signal's own plus the ramp's (the envelope over half a fade).
void test_phase3_reorder_dips_through_nothing() {
  for (const float hz : {40.0F, 220.0F, 1000.0F}) {
    const ReorderTrial trial = run_reorder_trial(hz, 56, false);
    const float half = static_cast<float>((Phase3Rig().fade_frames() + 1) / 2);
    std::printf("reorder dip, %.0f Hz: spread between the orders %.4f, fade-out error %.2e, return error %.2e, "
      "peak %.4f against %.4f, largest step %.5f against the signals' own %.5f plus the ramp's %.5f\n",
      hz, trial.spread, trial.dip_error, trial.return_error, trial.edited_peak, trial.envelope(), trial.largest_step,
      trial.natural_step, trial.envelope() / half);
    phase3_require(trial.spread > 0.1F, "the order is not audible", trial.spread, 0.1F);
    phase3_require(trial.dip_error < 1e-6F, "the reorder does not fade out the old order", trial.dip_error, 1e-6F);
    phase3_require(trial.return_error < 0.01F * trial.envelope(), "the reorder does not return to the new order",
      trial.return_error, 0.01F * trial.envelope());
    phase3_require(trial.edited_peak <= trial.envelope() + 1e-6F, "the reorder is louder than either order",
      trial.edited_peak, trial.envelope());
    phase3_require(trial.largest_step <= trial.natural_step + 1.01F * trial.envelope() / half + 1e-5F,
      "the reorder stepped", trial.largest_step, trial.natural_step + trial.envelope() / half);
    phase3_require(trial.settled_residue < 2e-4F, "the reorder did not land on the new order",
      trial.settled_residue, 2e-4F);
  }
}

// A reorder is a transition between two valid outputs of the same node, so what it
// emits can never be louder than the louder of them and must not clip where neither
// order does. Swept over four frequencies and eight tone phases, and once with the
// master gain that put the old splice at 1.012 against references at 0.976.
void test_phase3_reorder_never_exceeds_the_envelope_of_either_order() {
  float worst_excess = 0.0F;
  for (const float hz : {40.0F, 1000.0F, 10000.0F, 20000.0F}) {
    for (uint32_t warm = 53; warm <= 60; ++warm) {
      const ReorderTrial trial = run_reorder_trial(hz, warm, false);
      worst_excess = std::max(worst_excess, trial.edited_peak - trial.envelope());
      phase3_require(trial.spread > 0.05F, "the order is not audible", trial.spread, 0.05F);
      phase3_require(trial.envelope() < 1.0F, "the references clip", trial.envelope(), 1.0F);
      phase3_require(trial.edited_peak <= trial.envelope() + 1e-6F,
        "the reorder overshoots the envelope of the two orders", trial.edited_peak, trial.envelope());
    }
  }
  const ReorderTrial hot = run_reorder_trial(1000.0F, 60, true, 48000, -3.28619F);
  std::printf("reorder envelope sweep: worst excess over the louder order %.5f; hot master: peak %.4f against "
    "%.4f\n", worst_excess, hot.edited_peak, hot.envelope());
  phase3_require(hot.edited_peak <= hot.envelope() + 1e-6F, "the reorder clips where neither order does",
    hot.edited_peak, hot.envelope());
  phase3_require(hot.edited_peak < 1.0F, "the reorder clips", hot.edited_peak, 1.0F);
}

// What a reorder leaves behind must not be low-frequency energy: a resonant
// high-pass downstream rings on it for tens of milliseconds. The dip only ever
// multiplies a stage's output by a ramp, so the filter must ring no louder than it
// does on either order, and right after the dip the output is back on the new order.
void test_phase3_reorder_residue_decays_through_a_resonant_high_pass() {
  for (const float hz : {40.0F, 1000.0F}) {
    for (const uint32_t warm : {53u, 56u, 60u}) {
      const ReorderTrial trial = run_reorder_trial(hz, warm, true);
      const float baseline = trial.envelope();
      std::printf("reorder through a 40 Hz Q=10 high-pass, %.0f Hz warm %u: peak %.4f against %.4f, settled "
        "residue %.4f, late residue %.4f, spread %.4f\n", hz, warm, trial.edited_peak, baseline,
        trial.settled_residue, trial.late_residue, trial.spread);
      phase3_require(trial.edited_peak <= 1.05F * baseline, "the reorder rings louder than either order",
        trial.edited_peak, 1.05F * baseline);
      if (hz > 100.0F) {
        phase3_require(trial.settled_residue <= 0.1F * baseline,
          "the reorder leaves low-frequency residue after the dip", trial.settled_residue, 0.1F * baseline);
      } else {
        phase3_require(trial.settled_residue <= trial.spread,
          "the reorder rings beyond the spread of the two orders", trial.settled_residue, trial.spread);
      }
      // The two cores' filters differ in state by the dip's tiny return error, which
      // settles at a hundredth of the signal.
      phase3_require(trial.late_residue <= trial.settled_residue + 0.01F * baseline,
        "the residue does not decay", trial.late_residue, trial.settled_residue + 0.01F * baseline);
    }
  }
}

// The dip's steps are one ramp step whatever the rate: at 192 kHz the old mirror
// stepped by 0.078 where the signal moves by 0.0003 per sample.
void test_phase3_reorder_steps_stay_small_at_every_rate() {
  for (const uint32_t rate : {48000u, 96000u, 192000u}) {
    const ReorderTrial trial = run_reorder_trial(1000.0F, 56, false, rate);
    const float half = static_cast<float>((Phase3Rig(rate).fade_frames() + 1) / 2);
    const float bound = trial.natural_step + 1.01F * trial.envelope() / half + 1e-5F;
    std::printf("reorder at %u Hz: fade %u frames, largest step %.6f against the signals' own %.6f plus the "
      "ramp's %.6f, fade-out error %.2e, return error %.2e\n", rate, Phase3Rig(rate).fade_frames(),
      trial.largest_step, trial.natural_step, trial.envelope() / half, trial.dip_error, trial.return_error);
    phase3_require(trial.largest_step <= bound, "the reorder stepped", trial.largest_step, bound);
    phase3_require(trial.dip_error < 1e-6F, "the reorder does not fade out the old order", trial.dip_error, 1e-6F);
    phase3_require(trial.return_error < 0.01F * trial.envelope(), "the reorder does not return to the new order",
      trial.return_error, 0.01F * trial.envelope());
  }
}

// A transient that left the node before the publish is gone: the dip has no memory of
// the node's recent output to replay, so a downstream resonant filter rings on it as
// it does on the references and no louder (the mirror replayed it at 2.05 against 0.71).
void test_phase3_reorder_does_not_replay_expired_transients() {
  const uint32_t warm = 56;
  const auto feed = [](Phase3Rig &rig, uint32_t block, uint32_t impulse_at) {
    std::array<float, Phase3Rig::frames> left{};
    std::array<float, Phase3Rig::frames> right{};
    for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame) {
      left[frame] = block * Phase3Rig::frames + frame == impulse_at ? 0.4F : 0.0F;
      right[frame] = -left[frame];
    }
    return rig.render_input(left, right);
  };
  for (const uint32_t ago : {2u, 50u, 120u}) {
    Phase3Rig edited, old_order, new_order;
    build_reorder_rig(edited, false, true, -6.0206F);
    build_reorder_rig(old_order, false, true, -6.0206F);
    build_reorder_rig(new_order, true, true, -6.0206F);
    for (Phase3Rig *rig : {&edited, &old_order, &new_order}) rig->commit(1);
    const uint32_t impulse_at = warm * Phase3Rig::frames - ago;
    for (uint32_t block = 0; block < warm; ++block) {
      feed(edited, block, impulse_at);
      feed(old_order, block, impulse_at);
      feed(new_order, block, impulse_at);
    }
    build_reorder_rig(edited, true, true, -6.0206F);
    edited.commit(2);
    float edited_peak = 0.0F, reference_peak = 0.0F;
    for (uint32_t block = warm; block < warm + 24; ++block) {
      const auto actual = feed(edited, block, impulse_at);
      const auto from_old = feed(old_order, block, impulse_at);
      const auto from_new = feed(new_order, block, impulse_at);
      for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame) {
        edited_peak = std::max(edited_peak, std::abs(actual[0][frame]));
        reference_peak = std::max({reference_peak, std::abs(from_old[0][frame]), std::abs(from_new[0][frame])});
      }
    }
    std::printf("reorder %u samples after a 0.4 impulse: peak %.5f against the references' %.5f\n", ago,
      edited_peak, reference_peak);
    phase3_require(edited_peak <= reference_peak + 1e-6F, "the reorder replays an expired transient",
      edited_peak, reference_peak);
  }
}

// An edit that arrives while a node is dipping continues from where the dip stands,
// whether it is falling or rising and whether it reorders again or puts the order
// back. Three stages, three orders: [A B C] -> [B A C] at once, -> [A C B] 64 frames
// later (falling), -> [A B C] 192 frames in (rising). The output never leaves the
// envelope of the three orders, steps no more than their own plus a ramp step, and
// lands on the last order.
void test_phase3_reorder_during_a_dip_continues_it() {
  enum Order { kABC, kBAC, kACB };
  const auto build = [](Phase3Rig &rig, Order order) {
    rig.clear();
    rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE);
    rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER);
    rig.add_edge(1, 2);
    const auto stage = [&rig](char which) {
      if (which == 'A') rig.add_utility(1, 10, 6.0206F);
      else if (which == 'B') rig.add_saturator(1, 11);
      else rig.add_utility(1, 12, -4.0F);
    };
    for (const char which : order == kABC ? "ABC" : order == kBAC ? "BAC" : "ACB") {
      if (which != '\0') stage(which);
    }
    rig.add_utility(2, 21, -6.0206F);
  };
  Phase3Rig edited, ref_abc, ref_bac, ref_acb;
  build(edited, kABC);
  build(ref_abc, kABC);
  build(ref_bac, kBAC);
  build(ref_acb, kACB);
  for (Phase3Rig *rig : {&edited, &ref_abc, &ref_bac, &ref_acb}) rig->commit(1);
  const uint32_t warm = 56;
  Phase3Rig::Block last{};
  std::array<Phase3Rig::Block, 3> last_refs{};
  for (uint32_t block = 0; block < warm; ++block) {
    last = edited.render_tone(1000.0F, 0.4F, 1.0F);
    last_refs = {ref_abc.render_tone(1000.0F, 0.4F, 1.0F), ref_bac.render_tone(1000.0F, 0.4F, 1.0F),
      ref_acb.render_tone(1000.0F, 0.4F, 1.0F)};
  }
  build(edited, kBAC);
  edited.commit(2);
  const uint32_t fade = edited.fade_frames();
  const float half = static_cast<float>((fade + 1) / 2);
  float previous = last[0][Phase3Rig::frames - 1];
  std::array<float, 3> previous_refs{last_refs[0][0][Phase3Rig::frames - 1], last_refs[1][0][Phase3Rig::frames - 1],
    last_refs[2][0][Phase3Rig::frames - 1]};
  float peak = 0.0F, envelope = 0.0F, step = 0.0F, natural = 0.0F, residue = 0.0F;
  const uint32_t blocks = 8 * fade / Phase3Rig::frames;
  for (uint32_t block = 0; block < blocks; ++block) {
    if (block == 1) { build(edited, kACB); edited.commit(3); }
    if (block == 3) { build(edited, kABC); edited.commit(4); }
    const auto actual = edited.render_tone(1000.0F, 0.4F, 1.0F);
    const std::array<Phase3Rig::Block, 3> refs{ref_abc.render_tone(1000.0F, 0.4F, 1.0F),
      ref_bac.render_tone(1000.0F, 0.4F, 1.0F), ref_acb.render_tone(1000.0F, 0.4F, 1.0F)};
    for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame) {
      peak = std::max(peak, std::abs(actual[0][frame]));
      step = std::max(step, std::abs(actual[0][frame] - previous));
      previous = actual[0][frame];
      for (uint32_t which = 0; which < 3; ++which) {
        envelope = std::max(envelope, std::abs(refs[which][0][frame]));
        natural = std::max(natural, std::abs(refs[which][0][frame] - previous_refs[which]));
        previous_refs[which] = refs[which][0][frame];
      }
      if (block >= blocks - 8) residue = std::max(residue, std::abs(actual[0][frame] - refs[0][0][frame]));
    }
  }
  std::printf("reorder during a dip: peak %.4f against %.4f, largest step %.5f against %.5f plus %.5f, "
    "final residue %.2e\n", peak, envelope, step, natural, envelope / half, residue);
  phase3_require(peak <= envelope + 1e-6F, "the dip left the envelope of the orders", peak, envelope);
  phase3_require(step <= natural + 1.01F * envelope / half + 1e-5F, "the dip stepped", step,
    natural + envelope / half);
  phase3_require(residue < 2e-4F, "the dip did not land on the last order", residue, 2e-4F);
}

// An external stage renders its whole block where it stands, so a node with one cannot
// split a block between the two orders: the order changes on a block edge. The old
// order therefore runs at full level until the fade has to start, the fade ends on
// that edge, and the plan's order rises from it. Run at the buffer sizes a host offers
// (the stage cannot know them), the dip is the same few milliseconds with at most the
// one frame of nothing at the switch, not a silence to the end of the block (905 frames
// at 1024, 8073 at 8192 before). The output stays inside the two orders' envelope and
// lands on the new one.
void test_phase3_reorder_with_an_external_stage_dips_at_block_edges(uint32_t block_frames) {
  const auto build = [](Phase3Rig &rig, bool reordered) {
    rig.clear();
    rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE);
    rig.add_node(2, DAW_AUDIO_GRAPH_NODE_MASTER);
    rig.add_edge(1, 2);
    if (reordered) rig.add_saturator(1, 11);
    rig.add_utility(1, 10, -12.0412F);
    if (!reordered) rig.add_saturator(1, 11);
    rig.add_utility(2, 21, 0.0F);
    rig.external_node = 1;
    rig.external_stage = 1;
  };
  Phase3Rig edited(48000, block_frames), old_order(48000, block_frames), new_order(48000, block_frames);
  build(edited, false);
  build(old_order, false);
  build(new_order, true);
  for (Phase3Rig *rig : {&edited, &old_order, &new_order}) rig->commit(1);
  const auto render_all = [&] {
    return std::array<std::vector<float>, 3>{edited.render_tone_wide(1000.0F, 0.4F, 1.0F, block_frames),
      old_order.render_tone_wide(1000.0F, 0.4F, 1.0F, block_frames),
      new_order.render_tone_wide(1000.0F, 0.4F, 1.0F, block_frames)};
  };
  std::array<std::vector<float>, 3> last;
  for (uint32_t block = 0; block < std::max(2u, 3584u / block_frames); ++block) last = render_all();
  build(edited, true);
  edited.commit(2);
  const uint32_t fade = edited.fade_frames();
  const uint32_t half = (fade + 1) / 2;
  float previous = last[0].back(), old_previous = last[1].back(), new_previous = last[2].back();
  float peak = 0.0F, envelope = 0.0F, step = 0.0F, natural = 0.0F, residue = 0.0F, spread = 0.0F;
  uint32_t silent_frames = 0, early_frames = 0;
  const uint32_t total = std::max(6 * fade, 4 * block_frames);
  const uint32_t blocks = (total + block_frames - 1) / block_frames;
  for (uint32_t block = 0; block < blocks; ++block) {
    const auto [actual, from_old, from_new] = render_all();
    for (uint32_t frame = 0; frame < block_frames; ++frame) {
      peak = std::max(peak, std::abs(actual[frame]));
      envelope = std::max({envelope, std::abs(from_old[frame]), std::abs(from_new[frame])});
      spread = std::max(spread, std::abs(from_old[frame] - from_new[frame]));
      step = std::max(step, std::abs(actual[frame] - previous));
      natural = std::max({natural, std::abs(from_old[frame] - old_previous), std::abs(from_new[frame] - new_previous)});
      if (actual[frame] == 0.0F) ++silent_frames;
      // Before the fade has to start the old order sounds at full level; with a block
      // longer than the fade, the first frames of the block are those.
      if (block == 0 && block_frames > half + 1 && frame < block_frames - half - 1
        && std::abs(actual[frame] - from_old[frame]) > 1e-6F) ++early_frames;
      if (block * block_frames + frame >= blocks * block_frames - 2 * fade) {
        residue = std::max(residue, std::abs(actual[frame] - from_new[frame]));
      }
      previous = actual[frame];
      old_previous = from_old[frame];
      new_previous = from_new[frame];
    }
  }
  std::printf("reorder around an external stage at %u frames: spread %.4f, peak %.4f against %.4f, largest step %.5f "
    "against %.5f plus %.5f, %u silent frames, %u frames dipped early, final residue %.2e\n", block_frames, spread,
    peak, envelope, step, natural, envelope / static_cast<float>(half), silent_frames, early_frames, residue);
  phase3_require(spread > 0.02F, "the order is not audible", spread, 0.02F);
  // The frame at the switch is the new order's first, at nothing. Nothing else is silent.
  phase3_require(silent_frames == 1, "the dip held silence", static_cast<float>(silent_frames), 1.0F);
  phase3_require(early_frames == 0, "the dip started before the fade had to", static_cast<float>(early_frames), 0.0F);
  phase3_require(peak <= envelope + 1e-6F, "the dip left the envelope of the orders", peak, envelope);
  phase3_require(step <= natural + 1.01F * envelope / static_cast<float>(half) + 1e-5F, "the dip stepped", step,
    natural + envelope / static_cast<float>(half));
  phase3_require(residue < 2e-4F, "the dip did not land on the new order", residue, 2e-4F);
}

void test_phase3_reorder_with_an_external_stage_dips_at_block_edges() {
  for (const uint32_t block_frames : {64u, 128u, 1024u, 8192u}) {
    test_phase3_reorder_with_an_external_stage_dips_at_block_edges(block_frames);
  }
}

// Checkpoint 25: the transition matrix. Every non-latency edit the product can
// make to a small but complete graph is applied alone, in ordered pairs at several
// publish offsets, and in ordered triples, at 48 and 96 kHz, and each run is held
// to the same oracles. The graph:
//   A (source, program bus) -> [P1 +6 dB utility, P2 hard-clip saturator] -> G (group)
//   B (source) -> [DC-blocking utility] -> G;  G -> master
//   C (source) -> [compressor keyed by K (source on the key bus)] -> master
//   A -> R (send, half level), R (return bus, -6 dB utility) -> master
//   W (witness, left channel only) -> [ringing DC blocker] -> master
// Edits are the ones in MatrixEdit. Oracles, per run:
//   1. every sample is finite;
//   2. the witness node's own output (captured by an observer, not recovered from
//      the master mix) is bit-for-bit the edit-free render, so no edit reaches an
//      unrelated object's runtime;
//   3. no sample-to-sample step exceeds what the edits' own audible difference
//      spread over a fade allows, so nothing is cut, restarted or doubled;
//   4. once the last fade and the compressor re-settle, the output stays within 1e-3
//      of a cold render of the final graph (a deleted contribution never returns);
//      by the end it is within 1e-4 (retained state converged);
//   5. alone, deleting a source, a group, a send or a return is exactly final + ramp *
//      (before - final), adding a send is exactly before + (1 - ramp) * (final -
//      before), and adding a node, a unity stage or ungrouping a unity group is
//      exactly invisible;
//   6. every edit prepares on the live core with continuity 1, so the host never
//      builds a cold core for any of them.
// Every edit in the enum is covered, including bypass or restructure overlapping
// each other and a reorder in the block it publishes in; an added source may step
// at its first sample only, which is the content starting. Edits that need their own
// signals and so their own contracts rather than this graph: instrument replacement
// (Checkpoint 32), mono <-> stereo layout changes (Checkpoint 31), slot accounting
// (slot-exhaustion), and each processor kind's bypass (bypass-kinds).
enum MatrixEdit : uint32_t {
  kMatrixDeleteStageOne, kMatrixDeleteStageTwo, kMatrixDeleteSource, kMatrixDeleteGroup, kMatrixDeleteKey,
  kMatrixDeleteCompressor, kMatrixAddStage, kMatrixAddNode, kMatrixReorder, kMatrixBypassStageOne,
  kMatrixRestructureStageOne, kMatrixUngroup, kMatrixDeleteSend, kMatrixDeleteReturn, kMatrixAddSend,
  kMatrixRetargetKey, kMatrixAddSource, kMatrixEditCount
};
constexpr std::array<const char *, kMatrixEditCount> kMatrixEditNames{
  "delete-p1", "delete-p2", "delete-source", "delete-group", "delete-key", "delete-compressor", "add-stage",
  "add-node", "reorder", "bypass-p1", "restructure-p1", "ungroup", "delete-send", "delete-return", "add-send",
  "retarget-key", "add-source"};

struct MatrixSpec {
  bool source = true, stage_one = true, stage_two = true, group = true, key = true, compressor = true;
  bool added_stage = false, added_node = false, reordered = false, bypassed = false, restructured = false;
  bool ungrouped = false, send = true, returns = true, added_send = false, retargeted = false, added_source = false;
  uint32_t bits() const {
    return (source ? 1u : 0u) | (stage_one ? 2u : 0u) | (stage_two ? 4u : 0u) | (group ? 8u : 0u) | (key ? 16u : 0u)
      | (compressor ? 32u : 0u) | (added_stage ? 64u : 0u) | (added_node ? 128u : 0u) | (reordered ? 256u : 0u)
      | (bypassed ? 512u : 0u) | (restructured ? 1024u : 0u) | (ungrouped ? 2048u : 0u) | (send ? 4096u : 0u)
      | (returns ? 8192u : 0u) | (added_send ? 16384u : 0u) | (retargeted ? 32768u : 0u)
      | (added_source ? 65536u : 0u);
  }
};

bool matrix_apply(MatrixSpec &spec, MatrixEdit edit) {
  const bool chain = spec.source && spec.stage_one && spec.stage_two;
  switch (edit) {
    case kMatrixDeleteStageOne: if (!spec.source || !spec.stage_one) return false; spec.stage_one = false; return true;
    case kMatrixDeleteStageTwo: if (!spec.source || !spec.stage_two) return false; spec.stage_two = false; return true;
    case kMatrixDeleteSource: if (!spec.source) return false; spec.source = false; return true;
    case kMatrixDeleteGroup: if (!spec.group) return false; spec.group = false; return true;
    case kMatrixDeleteKey: if (!spec.key) return false; spec.key = false; return true;
    case kMatrixDeleteCompressor: if (!spec.compressor) return false; spec.compressor = false; return true;
    case kMatrixAddStage: if (spec.added_stage) return false; spec.added_stage = true; return true;
    case kMatrixAddNode: if (spec.added_node) return false; spec.added_node = true; return true;
    case kMatrixReorder: if (!chain || spec.reordered) return false; spec.reordered = true; return true;
    case kMatrixBypassStageOne:
      if (!spec.source || !spec.stage_one || spec.bypassed) return false;
      spec.bypassed = true;
      return true;
    case kMatrixRestructureStageOne:
      if (!spec.source || !spec.stage_one || spec.restructured) return false;
      spec.restructured = true;
      return true;
    case kMatrixUngroup: if (!spec.group) return false; spec.group = false; spec.ungrouped = true; return true;
    case kMatrixDeleteSend:
      if (!spec.returns || !spec.send || !spec.source) return false;
      spec.send = false;
      return true;
    case kMatrixDeleteReturn: if (!spec.returns) return false; spec.returns = false; return true;
    case kMatrixAddSend: if (!spec.returns || spec.added_send) return false; spec.added_send = true; return true;
    case kMatrixRetargetKey:
      if (!spec.key || !spec.compressor || spec.retargeted) return false;
      spec.retargeted = true;
      return true;
    case kMatrixAddSource: if (spec.added_source) return false; spec.added_source = true; return true;
    default: return false;
  }
}

constexpr float kMatrixKey = 0.9F;
constexpr float kMatrixProgram = 0.5F;

// Stable IDs for every node, edge and processor, so a build after an edit names the
// survivors exactly as the build before it did.
void matrix_build(Phase3Rig &rig, const MatrixSpec &spec) {
  const auto edge = [&rig](uint64_t id, uint64_t from, uint64_t to, float gain = 1.0F) {
    rig.add_edge(from, to, gain);
    rig.edges.back().id = id;
  };
  rig.clear();
  if (spec.source) rig.add_node(1, DAW_AUDIO_GRAPH_NODE_SOURCE, 1);
  rig.add_node(2, DAW_AUDIO_GRAPH_NODE_SOURCE, 1);
  if (spec.key) {
    rig.add_node(3, DAW_AUDIO_GRAPH_NODE_SOURCE, 0);
    rig.add_node(10, DAW_AUDIO_GRAPH_NODE_SOURCE, 1);
  }
  rig.add_node(4, DAW_AUDIO_GRAPH_NODE_SOURCE, 1);
  if (spec.group) rig.add_node(5, DAW_AUDIO_GRAPH_NODE_MIXER);
  rig.add_node(6, DAW_AUDIO_GRAPH_NODE_MASTER);
  rig.add_node(7, DAW_AUDIO_GRAPH_NODE_SOURCE, 1);
  if (spec.added_node) rig.add_node(8, DAW_AUDIO_GRAPH_NODE_SOURCE, DAW_AUDIO_GRAPH_INPUT_BUS_DISCONNECTED);
  if (spec.returns) rig.add_node(9, DAW_AUDIO_GRAPH_NODE_MIXER);
  if (spec.group) {
    if (spec.source) edge(1, 1, 5);
    edge(2, 2, 5);
    edge(3, 5, 6);
  } else if (spec.ungrouped) {
    if (spec.source) edge(4, 1, 6);
    edge(5, 2, 6);
  }
  edge(6, 4, 6);
  edge(8, 7, 6);
  if (spec.added_node) edge(9, 8, 6);
  if (spec.added_source) {
    rig.add_node(13, DAW_AUDIO_GRAPH_NODE_SOURCE, 1);
    edge(23, 13, 6);
  }
  if (spec.returns) {
    edge(20, 9, 6);
    if (spec.source && spec.send) edge(21, 1, 9, 0.5F);
    if (spec.added_send) edge(22, 2, 9, 0.5F);
  }
  // Every stage is the compiler's record. The key compressor's 480 frames of latency
  // are left out: every matrix edit is latency-neutral, and deleting a stage that
  // delays the signal is a latency change (LATENCY_CHANGE_DEFERRED), not a live edit.
  const auto stage_one = [&] {
    if (!spec.stage_one) return;
    rig.add_compiled(1, std::string("stage-one") + (spec.restructured ? "-swap" : "") + (spec.bypassed ? "-off" : ""));
  };
  if (spec.source && spec.reordered) {
    if (spec.stage_two) rig.add_compiled(1, "stage-two");
    stage_one();
  } else if (spec.source) {
    stage_one();
    if (spec.stage_two) rig.add_compiled(1, "stage-two");
  }
  rig.add_compiled(2, "dc-stage");
  if (spec.added_stage) rig.add_compiled(2, "added-stage");
  if (spec.compressor) {
    rig.add_compiled(4, "key-compressor", false);
    if (spec.key) {
      rig.add_sidechain(spec.retargeted ? 10 : 3, 4, compiled_processor("key-compressor").instance_id);
      rig.edges.back().id = 7;
    }
  }
  rig.add_compiled(7, "balanced");
  if (spec.added_node) rig.add_compiled(8, "added-node-stage");
  if (spec.added_source) rig.add_compiled(13, "added-source-trim");
  if (spec.returns) rig.add_compiled(9, "return-trim");
}

// Checkpoint 44: the matrix and the bypass subjects are made of what the compiler
// emits. Every processor either builds must equal a record from
// compiled-processors.txt in every field the host sends: instance id, kind, state
// version, state bytes, bypass flag, latency, tail and the complete declared
// parameter targets. The key compressor alone differs, in latency, by design
// (see matrix_build).
void require_compiled_stages(const Phase3Rig &rig, const char *context) {
  for (const daw_audio_processor_descriptor &processor : rig.processors) {
    const char *first_difference = "no record has this instance id";
    bool equal = false;
    for (const auto &[name, record] : compiled_processors()) {
      if (record.instance_id != processor.instance_id) continue;
      daw_audio_processor_descriptor comparable = processor;
      if (name == "key-compressor") comparable.latency_frames = record.latency_frames;
      first_difference = compiled_difference(comparable, record);
      if (first_difference == nullptr) {
        equal = true;
        break;
      }
    }
    if (!equal) {
      std::fprintf(stderr, "phase 3 contract: %s: processor %llu is not a compiler record: %s\n", context,
        static_cast<unsigned long long>(processor.instance_id), first_difference);
      std::abort();
    }
  }
}

void test_phase3_stages_are_what_the_compiler_emits() {
  std::vector<MatrixSpec> specs(6);
  specs[1].bypassed = true;
  specs[2].restructured = true;
  specs[3].bypassed = specs[3].restructured = true;
  specs[4].reordered = true;
  specs[5].added_stage = specs[5].added_node = specs[5].added_source = true;
  for (const MatrixSpec &spec : specs) {
    Phase3Rig rig;
    matrix_build(rig, spec);
    require_compiled_stages(rig, "matrix");
  }
  for (uint32_t which = 0; which < kBypassKindNames.size(); ++which) {
    for (uint32_t bypassed = 0; bypassed < 2; ++bypassed) {
      Phase3Rig rig;
      bypass_subject(rig, which, bypassed);
      require_compiled_stages(rig, kBypassKindNames[which]);
    }
  }
}

struct MatrixTrace {
  std::vector<Phase3Rig::Block> output;
  std::vector<Phase3Rig::Block> witness;
};
struct MatrixStep {
  uint32_t block;
  MatrixEdit edit;
};

constexpr uint32_t kMatrixFirstEditBlock = 16;
constexpr uint64_t kMatrixWitnessNode = 7;

uint32_t matrix_total_blocks(uint32_t sample_rate) {
  return kMatrixFirstEditBlock + 24 + 160 * (sample_rate / 48000);
}

MatrixTrace matrix_run(uint32_t sample_rate, MatrixSpec spec, const std::vector<MatrixStep> &steps) {
  Phase3Rig rig(sample_rate);
  rig.witness_node = kMatrixWitnessNode;
  matrix_build(rig, spec);
  rig.commit(1);
  uint32_t revision = 1;
  MatrixTrace trace;
  size_t next = 0;
  for (uint32_t block = 0; block < matrix_total_blocks(sample_rate); ++block) {
    for (; next < steps.size() && steps[next].block == block; ++next) {
      assert(matrix_apply(spec, steps[next].edit));
      matrix_build(rig, spec);
      expect(rig.prepare(++revision), DAW_AUDIO_CORE_OK);
      // No matrix edit changes latency, so none may need a cold core.
      assert(daw_audio_core_prepared_graph_continuity(rig.core) == 1);
      rig.publish(revision);
    }
    trace.output.push_back(rig.render_keyed(kMatrixKey, kMatrixProgram));
    trace.witness.push_back(rig.witness);
  }
  return trace;
}

struct MatrixCache {
  std::map<std::pair<uint32_t, uint32_t>, MatrixTrace> traces;
  const MatrixTrace &cold(uint32_t sample_rate, const MatrixSpec &spec) {
    const auto key = std::make_pair(sample_rate, spec.bits());
    auto found = traces.find(key);
    if (found == traces.end()) found = traces.emplace(key, matrix_run(sample_rate, spec, {})).first;
    return found->second;
  }
};

float matrix_sample(const MatrixTrace &trace, uint32_t channel, uint32_t index) {
  return trace.output[index / Phase3Rig::frames][channel][index % Phase3Rig::frames];
}

float matrix_distance(const MatrixTrace &left, const MatrixTrace &right) {
  float largest = 0.0F;
  for (uint32_t index = 0; index < left.output.size() * Phase3Rig::frames; ++index) {
    for (uint32_t channel = 0; channel < 2; ++channel)
      largest = std::max(largest, std::abs(matrix_sample(left, channel, index) - matrix_sample(right, channel, index)));
  }
  return largest;
}

void matrix_check(uint32_t sample_rate, const std::vector<MatrixStep> &steps, MatrixCache &cache) {
  std::string name = std::to_string(sample_rate) + " Hz:";
  MatrixSpec final_spec;
  MatrixSpec base_spec;
  float spread = 0.0F;
  // Where an added source starts sounding, and by how much: its onset is the edit's
  // intended content, so only that sample may exceed what a fade allows.
  std::vector<std::pair<uint32_t, float>> onsets;
  uint32_t last_block = 0;
  for (const MatrixStep &step : steps) {
    name += std::string(" ") + kMatrixEditNames[step.edit] + "@" + std::to_string(step.block);
    assert(matrix_apply(final_spec, step.edit));
    MatrixSpec alone = base_spec;
    assert(matrix_apply(alone, step.edit));
    const float distance = matrix_distance(cache.cold(sample_rate, base_spec), cache.cold(sample_rate, alone));
    spread += distance;
    if (step.edit == kMatrixAddSource) onsets.emplace_back(step.block * Phase3Rig::frames, distance);
    last_block = std::max(last_block, step.block);
  }
  const MatrixTrace edited = matrix_run(sample_rate, base_spec, steps);
  const uint32_t fade = (sample_rate * 5u + 500u) / 1000u;
  // A reorder dips through nothing (the `reorder-declick` contract), so it needs no
  // allowance beyond the fade's.
  const float step_limit = 12.0F * spread / static_cast<float>(fade) + 5e-4F;
  const auto require = [&name, &edited, &spread, &step_limit](bool ok, const char *what, uint32_t index) {
    if (ok) return;
    std::fprintf(stderr, "transition matrix: %s: %s (sample %u; spread %.4f, step limit %.5f)\n", name.c_str(), what,
      index, spread, step_limit);
    const uint32_t count = static_cast<uint32_t>(edited.output.size()) * Phase3Rig::frames;
    for (uint32_t probe = index > 3 ? index - 3 : 0; probe < index + 4 && probe < count; ++probe)
      std::fprintf(stderr, "  [%u] L=%.6f R=%.6f\n", probe, matrix_sample(edited, 0, probe), matrix_sample(edited, 1, probe));
    std::abort();
  };
  const MatrixTrace &base = cache.cold(sample_rate, base_spec);
  const MatrixTrace &final_trace = cache.cold(sample_rate, final_spec);
  const uint32_t samples = static_cast<uint32_t>(edited.output.size()) * Phase3Rig::frames;
  const uint32_t first_sample = steps.front().block * Phase3Rig::frames;
  // The compressor needs a few releases after a key is handed back; 40 ms covers it.
  const uint32_t settled = (last_block + (fade + Phase3Rig::frames - 1) / Phase3Rig::frames) * Phase3Rig::frames
    + sample_rate / 25;
  const bool single = steps.size() == 1;
  {
    float sounding = 0.0F;
    for (uint32_t frame = 0; frame < Phase3Rig::frames; ++frame) {
      sounding = std::max(sounding, std::abs(base.witness[steps.front().block - 1][0][frame]));
    }
    require(sounding > 1e-4F, "the witness captured nothing before the edit", first_sample);
  }
  for (uint32_t index = 0; index < samples; ++index) {
    for (uint32_t channel = 0; channel < 2; ++channel) {
      const float value = matrix_sample(edited, channel, index);
      require(std::isfinite(value), "non-finite sample", index);
      if (index >= first_sample && index > 0) {
        float allowance = step_limit;
        for (const auto &onset : onsets) if (onset.first == index) allowance += onset.second;
        require(std::abs(value - matrix_sample(edited, channel, index - 1)) <= allowance,
          "step larger than the edits' own difference allows", index);
      }
      if (index >= settled) {
        require(std::abs(value - matrix_sample(final_trace, channel, index)) <= 1e-3F,
          "deleted or replaced contribution did not stay gone", index);
      }
      if (index + 4 * Phase3Rig::frames >= samples) {
        require(std::abs(value - matrix_sample(final_trace, channel, index)) <= 1e-4F,
          "end state differs from a cold render of the final graph", index);
      }
      require(edited.witness[index / Phase3Rig::frames][channel][index % Phase3Rig::frames]
        == base.witness[index / Phase3Rig::frames][channel][index % Phase3Rig::frames],
        "unrelated object's output changed", index);
    }
    if (!single || index < first_sample) continue;
    const MatrixEdit edit = steps.front().edit;
    for (uint32_t channel = 0; channel < 2; ++channel) {
      const float value = matrix_sample(edited, channel, index);
      const float before = matrix_sample(base, channel, index);
      const float after = matrix_sample(final_trace, channel, index);
      const float remaining = Phase3Rig::ramp(index - first_sample, fade);
      if (edit == kMatrixDeleteSource || edit == kMatrixDeleteGroup || edit == kMatrixDeleteSend
        || edit == kMatrixDeleteReturn) {
        require(std::abs(value - (after + remaining * (before - after))) <= 2e-5F,
          "deletion is not one linear ramp", index);
      } else if (edit == kMatrixAddSend) {
        require(std::abs(value - (before + (1.0F - remaining) * (after - before))) <= 2e-5F,
          "a new send does not join along one linear ramp", index);
      } else if (edit == kMatrixAddNode || edit == kMatrixAddStage || edit == kMatrixUngroup) {
        require(std::abs(value - before) <= 1e-6F, "an invisible edit changed the output", index);
      }
    }
  }
}

// `full` adds every gap and a third edit to every pair; the default keeps every
// edit alone and in pairs, which is what each family's own oracle needs.
void test_phase3_transition_matrix(bool full) {
  MatrixCache cache;
  uint32_t singles = 0, pairs = 0, triples = 0, skipped = 0;
  const auto applicable = [](const std::vector<MatrixEdit> &edits) {
    MatrixSpec spec;
    for (const MatrixEdit edit : edits) if (!matrix_apply(spec, edit)) return false;
    return true;
  };
  for (const uint32_t sample_rate : {48000u, 96000u}) {
    // Offsets in blocks between consecutive publishes: back to back, while the first
    // fade is in flight (one 64-frame block of 240 or 480), and after it finished.
    const std::vector<uint32_t> gaps = sample_rate != 48000 ? std::vector<uint32_t>{1}
      : full ? std::vector<uint32_t>{0, 1, 10} : std::vector<uint32_t>{0, 1};
    for (uint32_t first = 0; first < kMatrixEditCount; ++first) {
      const auto a = static_cast<MatrixEdit>(first);
      matrix_check(sample_rate, {{kMatrixFirstEditBlock, a}}, cache);
      ++singles;
      for (uint32_t second = 0; second < kMatrixEditCount; ++second) {
        if (second == first) continue;
        const auto b = static_cast<MatrixEdit>(second);
        if (!applicable({a, b})) {
          ++skipped;
          continue;
        }
        for (const uint32_t gap : gaps) {
          matrix_check(sample_rate, {{kMatrixFirstEditBlock, a}, {kMatrixFirstEditBlock + gap, b}}, cache);
          ++pairs;
        }
        if (!full || sample_rate != 48000) continue;
        // One deterministic third edit per ordered pair, both gaps one block.
        for (uint32_t offset = 0; offset < kMatrixEditCount; ++offset) {
          const auto c = static_cast<MatrixEdit>((first * 5 + second * 3 + 1 + offset) % kMatrixEditCount);
          if (c == a || c == b || !applicable({a, b, c})) continue;
          matrix_check(sample_rate,
            {{kMatrixFirstEditBlock, a}, {kMatrixFirstEditBlock + 1, b}, {kMatrixFirstEditBlock + 2, c}}, cache);
          ++triples;
          break;
        }
      }
    }
  }
  // Slot reuse: edits that leave state on a node's runtime (a reorder's dip, a
  // restructured or bypassed stage, a deleted source, a retargeted key), then a long
  // enough pause for those slots to retire and be reclaimed, then an edit that
  // takes a node slot (an added source or node). The added object must be exactly
  // what a cold render of the final graph makes of it.
  constexpr uint32_t kReuseGap = 40;
  uint32_t reuse = 0;
  for (const uint32_t sample_rate : {48000u, 96000u}) {
    for (const MatrixEdit dirtying : {kMatrixReorder, kMatrixBypassStageOne, kMatrixRestructureStageOne,
           kMatrixDeleteKey, kMatrixDeleteReturn}) {
      for (const MatrixEdit taking : {kMatrixAddSource, kMatrixAddNode}) {
        matrix_check(sample_rate, {{kMatrixFirstEditBlock, dirtying}, {kMatrixFirstEditBlock + 1, kMatrixDeleteSource},
          {kMatrixFirstEditBlock + kReuseGap, taking}}, cache);
        ++reuse;
      }
    }
  }
  std::printf("transition matrix (%s): %u single, %u pair, %u triple runs; %u inapplicable pairs skipped; "
    "%zu distinct cold renders; %u slot-reuse sequences\n", full ? "full" : "default", singles, pairs, triples,
    skipped, cache.traces.size(), reuse);
}

// The graph fixture is fed bytes it did not produce: a graph edit that is missing,
// shorter than the envelope header, or not a graph must fail the render and never
// be read past its end. Each fixture is an exactly sized allocation so a sanitizer
// build faults on any byte read beyond it.
void fixture_put_u32(std::vector<uint8_t> &bytes, uint32_t value) {
  for (uint32_t shift = 0; shift < 32; shift += 8) bytes.push_back(static_cast<uint8_t>(value >> shift));
}

std::vector<uint8_t> fixture_master_graph(uint32_t revision) {
  std::vector<uint8_t> graph;
  for (const uint32_t word : {1u, revision, 1u, 0u, 0u, 0u}) fixture_put_u32(graph, word);
  fixture_put_u32(graph, 1);  // node id, low word
  fixture_put_u32(graph, 0);  // node id, high word
  for (const uint32_t word : {6u, 2u, 2u, 0u, 0u}) fixture_put_u32(graph, word);
  return graph;
}

daw_audio_core_result run_fixture_with_edit(const std::vector<uint8_t> &edit_graph, uint32_t edit_frame) {
  const std::vector<uint8_t> graph = fixture_master_graph(1);
  std::vector<uint8_t> edits;
  fixture_put_u32(edits, 1);
  fixture_put_u32(edits, edit_frame);
  fixture_put_u32(edits, static_cast<uint32_t>(edit_graph.size()));
  edits.insert(edits.end(), edit_graph.begin(), edit_graph.end());
  std::vector<uint8_t> partitions;
  for (const uint32_t word : {2u, 4u, 4u}) fixture_put_u32(partitions, word);
  constexpr uint32_t frames = 8;
  const std::vector<float> input(2 * frames, 0.0F);
  std::vector<uint8_t> fixture;
  for (const uint32_t word : {DAW_AUDIO_GRAPH_FIXTURE_MAGIC, DAW_AUDIO_GRAPH_FIXTURE_VERSION, 48000u, 4u, 1u, 2u, 1u,
         static_cast<uint32_t>(graph.size()), frames, 0u, 0u, 0u, 1u, 1u, 0u, 0u, 0u, 0u,
         static_cast<uint32_t>(partitions.size()), static_cast<uint32_t>(edits.size())}) {
    fixture_put_u32(fixture, word);
  }
  fixture.insert(fixture.end(), graph.begin(), graph.end());
  const auto *input_bytes = reinterpret_cast<const uint8_t *>(input.data());
  fixture.insert(fixture.end(), input_bytes, input_bytes + input.size() * sizeof(float));
  fixture.insert(fixture.end(), partitions.begin(), partitions.end());
  fixture.insert(fixture.end(), edits.begin(), edits.end());
  const std::vector<uint8_t> exact(fixture.begin(), fixture.end());
  std::array<float, frames> left{};
  std::array<float, frames> right{};
  float *const outputs[]{left.data(), right.data()};
  return daw_audio_core_run_graph_fixture(exact.data(), exact.size(), outputs);
}

void test_graph_fixture_rejects_malformed_edit_graphs() {
  expect(run_fixture_with_edit(fixture_master_graph(2), 4), DAW_AUDIO_CORE_OK);
  expect(run_fixture_with_edit({}, 4), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  expect(run_fixture_with_edit({1, 0, 0, 0}, 4), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  std::vector<uint8_t> header_short = fixture_master_graph(2);
  header_short.resize(DAW_AUDIO_CORE_WASM_GRAPH_HEADER_BYTES - 1);
  expect(run_fixture_with_edit(header_short, 4), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  std::vector<uint8_t> truncated_node = fixture_master_graph(2);
  truncated_node.resize(truncated_node.size() - 4);
  expect(run_fixture_with_edit(truncated_node, 4), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  // A header with no node is a graph the core refuses, not bytes to read a revision from.
  std::vector<uint8_t> empty_graph;
  for (const uint32_t word : {1u, 2u, 0u, 0u, 0u, 0u}) fixture_put_u32(empty_graph, word);
  expect(run_fixture_with_edit(empty_graph, 4), DAW_AUDIO_CORE_INVALID_ARGUMENT);
  expect(run_fixture_with_edit(fixture_master_graph(2), 8), DAW_AUDIO_CORE_INVALID_ARGUMENT);
}

}  // namespace

void *operator new(std::size_t size) {
  ++allocation_count;
  if (first_allocation_size == 0) first_allocation_size = size;
  if (void *memory = std::malloc(size)) return memory;
  throw std::bad_alloc();
}

void operator delete(void *memory) noexcept {
  std::free(memory);
}

void *operator new[](std::size_t size) { return ::operator new(size); }
void operator delete[](void *memory) noexcept { std::free(memory); }
void operator delete(void *memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void *memory, std::size_t) noexcept { std::free(memory); }
void *operator new(std::size_t size, std::align_val_t alignment) {
  ++allocation_count;
  if (first_allocation_size == 0) first_allocation_size = size;
  void *memory = nullptr;
  if (posix_memalign(&memory, static_cast<std::size_t>(alignment), std::max<std::size_t>(size, 1)) == 0) return memory;
  throw std::bad_alloc();
}
void *operator new[](std::size_t size, std::align_val_t alignment) { return ::operator new(size, alignment); }
void operator delete(void *memory, std::align_val_t) noexcept { std::free(memory); }
void operator delete[](void *memory, std::align_val_t) noexcept { std::free(memory); }
void operator delete(void *memory, std::size_t, std::align_val_t) noexcept { std::free(memory); }
void operator delete[](void *memory, std::size_t, std::align_val_t) noexcept { std::free(memory); }

int main(int argc, char **argv) {
  if (argc == 3 && std::strcmp(argv[1], "--phase-4-contract") == 0) {
    if (std::strncmp(argv[2], "spectral-freeze-toggle-", 23) == 0) {
      const unsigned direction = static_cast<unsigned>(std::strtoul(argv[2] + 23, nullptr, 10));
      if (direction >= 2) return 2;
      for (uint32_t rate : {48000u, 22050u, 1u})
        for (uint32_t period : {2048u, 256u})
          for (bool engaged : {false, true}) for (bool alignment : {false, true})
            test_phase4_spectral_freeze_toggle(direction != 0, period, engaged, alignment, rate);
      for (uint32_t rate : {48000u, 22050u, 1u}) for (uint32_t period : {2048u, 256u})
        for (bool alignment : {false, true})
          test_phase4_spectral_freeze_toggle(direction != 0, period, false, alignment, rate, true);
      test_phase4_spectral_freeze_toggle(direction != 0, 256, true, false, 48000, false, true);
    } else if (std::strncmp(argv[2], "spectral-freeze-gesture-", 24) == 0) {
      const unsigned index = static_cast<unsigned>(std::strtoul(argv[2] + 24, nullptr, 10));
      if (index >= 4) return 2;
      for (bool automation : {false, true}) for (bool alignment : {false, true})
        test_phase4_spectral_freeze_gesture(index % 2 != 0, index >= 2, automation, alignment);
    } else if (std::strcmp(argv[2], "spectral-snapshot-mode") == 0) {
      test_phase4_spectral_snapshot_mode();
    } else if (std::strcmp(argv[2], "spectral-frozen-tone") == 0) {
      for (bool lower : {false, true}) for (float mix : {1.0F, .25F}) test_phase4_spectral_frozen_tone(lower, mix);
    } else if (std::strcmp(argv[2], "spectral-recapture-bound") == 0) {
      for (uint32_t rate : {22050u, 1u}) for (bool lower : {false, true})
        test_phase4_spectral_aligned_completion(DAW_AUDIO_SPECTRAL_MODE_FREEZE, lower, true, rate);
#if defined(DAW_AUDIO_CORE_TEST_SPECTRAL_INTERNALS)
    } else if (std::strcmp(argv[2], "spectral-transfer-relearn") == 0) {
      test_phase4_spectral_transfer_relearn();
    } else if (std::strcmp(argv[2], "spectral-transfer-cost") == 0) {
      test_phase4_spectral_transfer_cost();
    } else if (std::strcmp(argv[2], "spectral-transfer-late") == 0) {
      test_phase4_spectral_transfer_late();
    } else if (std::strcmp(argv[2], "spectral-transfer-flat") == 0) {
      test_phase4_spectral_transfer_shape(false);
    } else if (std::strcmp(argv[2], "spectral-transfer-pink") == 0) {
      test_phase4_spectral_transfer_shape(true);
    } else if (std::strcmp(argv[2], "spectral-transfer-narrow") == 0) {
      test_phase4_spectral_transfer_narrow();
    } else if (std::strcmp(argv[2], "spectral-transfer-endpoints") == 0) {
      test_phase4_spectral_transfer_endpoints();
#endif
    } else if (std::strncmp(argv[2], "spectral-carry-", 15) == 0) {
      const unsigned index = static_cast<unsigned>(std::strtoul(argv[2] + 15, nullptr, 10));
      if (index >= 4) return 2;
      test_phase4_spectral_carry(index < 2 ? DAW_AUDIO_SPECTRAL_MODE_FREEZE
        : DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE, index % 2 != 0);
    } else if (std::strncmp(argv[2], "spectral-alignment-", 19) == 0
      || std::strncmp(argv[2], "spectral-completion-", 20) == 0) {
      const bool alignment = std::strncmp(argv[2], "spectral-alignment-", 19) == 0;
      const unsigned index = static_cast<unsigned>(std::strtoul(argv[2] + (alignment ? 19 : 20), nullptr, 10));
      if (index >= 4) return 2;
      test_phase4_spectral_aligned_completion(index < 2 ? DAW_AUDIO_SPECTRAL_MODE_FREEZE
        : DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE, index % 2 != 0, alignment);
    } else if (std::strcmp(argv[2], "capacity") == 0) {
      for (const uint32_t latency : {8193u, 65536u}) {
        const auto core = create_core(128, 2, 1);
        const std::array<daw_audio_graph_node_descriptor, 3> nodes{{
          {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = 2, .output_layout = 2, .input_bus = 0},
          {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = 2, .output_layout = 2, .input_bus = 1, .latency_frames = latency},
          {.id = 3, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = 2, .output_layout = 2},
        }};
        const std::array<daw_audio_graph_edge_descriptor, 2> edges{{
          {.id = 1, .from_node_id = 1, .to_node_id = 3, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .pdc_delay_frames = latency},
          {.id = 2, .from_node_id = 2, .to_node_id = 3, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER},
        }};
        prepare_graph(core, 1, nodes.data(), nodes.size(), edges.data(), edges.size());
        daw_audio_core_destroy(core);
      }
      for (const uint32_t frames : {128u, 1024u, 8192u}) test_phase4_full_history_and_fanout(frames);
    } else if (std::strcmp(argv[2], "sequential-replacement") == 0) {
      test_phase4_sequential_maximum_replacement();
    } else if (std::strcmp(argv[2], "raise-pcm") == 0) {
      test_phase4_live_latency_pcm(48000, 128, 0, 2048);
    } else if (std::strcmp(argv[2], "lower-pcm") == 0) {
      test_phase4_live_latency_pcm(48000, 128, 2048, 0);
    } else if (std::strcmp(argv[2], "lower-edited-pcm") == 0) {
      test_phase4_seek_discards_dc_bias();
      test_phase4_live_latency_pcm(48000, 128, 2048, 0, false, false, true);
    } else if (std::strcmp(argv[2], "raise-extreme-low-rate") == 0) {
      test_phase4_live_latency_pcm(22050, 1024, 0, 65536);
    } else if (std::strcmp(argv[2], "raise-extreme-high-rate") == 0) {
      test_phase4_live_latency_pcm(192000, 8192, 0, 65536);
    } else if (std::strcmp(argv[2], "spectral-short-history") == 0) {
      test_phase4_stateful_spectral(DAW_AUDIO_SPECTRAL_MODE_HPSS, false, 4, false, true);
    } else if (std::strcmp(argv[2], "spectral-expired-history") == 0) {
      test_phase4_stateful_spectral(DAW_AUDIO_SPECTRAL_MODE_HPSS, false, 2, false, false, true);
    } else if (std::strncmp(argv[2], "spectral-state-", 15) == 0) {
      const unsigned index = static_cast<unsigned>(std::strtoul(argv[2] + 15, nullptr, 10));
      if (index >= 16) return 2;
      test_phase4_stateful_spectral(index < 12 ? index / 2 : index < 14 ? DAW_AUDIO_SPECTRAL_MODE_HPSS
        : index == 14 ? DAW_AUDIO_SPECTRAL_MODE_FREEZE : DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE,
        index % 2 != 0, index < 12 || index >= 14 ? 4 : 2, index >= 14);
    } else if (std::strcmp(argv[2], "fft-change-audible") == 0) {
      test_phase4_fft_change_audible();
    } else if (std::strcmp(argv[2], "fft-change-late") == 0) {
      test_phase4_fft_change_audible(512);
    } else if (std::strcmp(argv[2], "keep-group") == 0) {
      test_phase4_keep_routing(false, false);
    } else if (std::strcmp(argv[2], "keep-send-return") == 0) {
      test_phase4_keep_routing(true, false);
    } else if (std::strcmp(argv[2], "keep-mixed-group") == 0) {
      test_phase4_keep_routing(false, true);
    } else if (std::strcmp(argv[2], "keep-divergent-bus") == 0) {
      test_phase4_keep_divergent_bus_rejected();
    } else if (std::strcmp(argv[2], "keep-latency") == 0) {
      test_phase4_live_latency_pcm(48000, 128, 256, 2048, true);
    } else if (std::strcmp(argv[2], "overlapping-raise") == 0) {
      test_phase4_live_latency_pcm(48000, 128, 0, 2048, false, true);
    } else if (std::strcmp(argv[2], "held-note") == 0) {
      test_phase4_retained_signal(true);
    } else if (std::strcmp(argv[2], "reverb-tail") == 0) {
      test_phase4_retained_signal(false);
    } else if (std::strcmp(argv[2], "sidechain-key") == 0) {
      test_phase4_retained_signal(false, true);
    } else if (std::strcmp(argv[2], "delayed-deletion") == 0) {
      test_phase4_delayed_deletion();
    } else if (std::strcmp(argv[2], "fanout-seam") == 0) {
      test_phase4_live_latency_pcm(48000, 128, 17, 2048);
    } else if (std::strcmp(argv[2], "one-frame-seam") == 0) {
      test_phase4_live_latency_pcm(48000, 128, 0, 1);
      test_phase4_live_latency_pcm(48000, 128, 1, 0);
    } else if (std::strcmp(argv[2], "memory") == 0) {
      for (const uint32_t frames : {128u, 1024u, 8192u}) test_phase4_full_history_and_fanout(frames, true);
    } else if (std::strcmp(argv[2], "memory-spectral") == 0) {
      for (const uint32_t frames : {128u, 1024u, 8192u}) test_phase4_full_history_and_fanout(frames, true, true);
    } else if (std::strcmp(argv[2], "path-capacity") == 0) {
      const auto core = create_core(128, 2, 1);
      const std::array<daw_audio_graph_node_descriptor, 2> nodes{{
        {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = 2, .output_layout = 2, .input_bus = 0, .latency_frames = 65536},
        {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = 2, .output_layout = 2, .latency_frames = 1},
      }};
      const daw_audio_graph_edge_descriptor edge{
        .id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER,
      };
      const daw_audio_graph_prepare_request request{
        .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 1,
        .node_count = 2, .edge_count = 1, .nodes = nodes.data(), .edges = &edge,
      };
      expect(daw_audio_core_prepare_graph(core, &request), DAW_AUDIO_CORE_CAPACITY_EXCEEDED);
      daw_audio_core_destroy(core);
    } else if (std::strcmp(argv[2], "live-lower") == 0) {
      const auto core = create_core(128, 2, 1);
      std::array<daw_audio_graph_node_descriptor, 3> nodes{{
        {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = 2, .output_layout = 2, .input_bus = 0},
        {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_SOURCE, .input_layout = 2, .output_layout = 2, .input_bus = 1, .latency_frames = 4},
        {.id = 3, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = 2, .output_layout = 2},
      }};
      std::array<daw_audio_graph_edge_descriptor, 2> edges{{
        {.id = 1, .from_node_id = 1, .to_node_id = 3, .gain = 1.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER, .pdc_delay_frames = 4},
        {.id = 2, .from_node_id = 2, .to_node_id = 3, .gain = 0.0F, .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER},
      }};
      prepare_graph(core, 1, nodes.data(), nodes.size(), edges.data(), edges.size());
      nodes[1].latency_frames = 0;
      edges[0].pdc_delay_frames = 0;
      const daw_audio_graph_prepare_request request{
        .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 2,
        .node_count = 3, .edge_count = 2, .nodes = nodes.data(), .edges = edges.data(),
      };
      expect(daw_audio_core_prepare_graph(core, &request), DAW_AUDIO_CORE_OK);
      assert(daw_audio_core_prepared_graph_continuity(core) == 1);
      daw_audio_core_destroy(core);
    } else {
      return 2;
    }
    return 0;
  }
  if (argc == 3 && std::strcmp(argv[1], "--phase-6i-contract") == 0) {
    // `<case>-<instrument>` runs one case for one instrument, so each is red or green on its own.
    const std::string contract = argv[2];
    const auto split = contract.rfind('-');
    const std::string name = contract.substr(0, split);
    const std::string instrument = split == std::string::npos ? "" : contract.substr(split + 1);
    const uint32_t kind = instrument == "synth" ? DAW_AUDIO_INSTRUMENT_KIND_SYNTH
      : instrument == "sampler" ? DAW_AUDIO_INSTRUMENT_KIND_SAMPLER
      : instrument == "drum" ? DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK : DAW_AUDIO_INSTRUMENT_KIND_GRANULAR;
    if (name == "held" && !instrument.empty()) test_phase6i_held_note_survives_an_edit(kind);
    else if (name == "polyphony" && kind != DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) test_phase6i_polyphony_change_keeps_the_newest_voices(kind);
    else if (name == "zone" && kind != DAW_AUDIO_INSTRUMENT_KIND_SYNTH && kind != DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) test_phase6i_zone_edit_under_a_held_note(kind);
    else if (contract == "pedal") test_phase6i_pedal_and_note_off_survive_an_edit();
    else if (contract == "granular-parameter") test_phase6i_granular_parameter_edit_under_a_held_note();
    else if (name == "retained" && !instrument.empty()) test_phase6i_continuous_edits_do_not_replace_the_instrument(kind);
    else if (name == "padding" && (kind == DAW_AUDIO_INSTRUMENT_KIND_SAMPLER || kind == DAW_AUDIO_INSTRUMENT_KIND_GRANULAR)) test_phase6i_padding_is_not_part_of_a_configuration(kind);
#if defined(DAW_AUDIO_CORE_TEST_SPECTRAL_INTERNALS)
    else if (contract == "zones-gone") test_phase6i_replacement_leaves_no_voice_on_a_missing_zone();
#endif
    else if (name == "carry" && kind != DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) test_phase6i_replacement_goes_on_from_the_applied_value(kind);
    else if (contract == "bad-values") test_phase6i_bad_values_and_the_polyphony_cap();
    else if (contract == "burst") test_phase6i_event_burst_and_reversal_are_smooth();
    else if (contract == "mixed") test_phase6i_automation_and_a_drag_share_a_parameter();
    else if (name.rfind("drag", 0) == 0 && kind != DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) {
      // drag<param>[-live]-<instrument>, e.g. dragpitch-sampler or draggain-live-synth
      std::string param = name.substr(4);
      const bool live = param.size() > 5 && param.compare(param.size() - 5, 5, "-live") == 0;
      if (live) param.resize(param.size() - 5);
      for (const Drag drag : {Drag::Gain, Drag::Pan, Drag::Cutoff, Drag::Pitch}) {
        if (param == drag_name(drag)) test_phase6i_drag_is_smooth(kind, drag, live);
      }
    }
    else if (contract == "chain") test_phase6i_replacement_chain_has_no_level_bump();
    else if (contract == "publish-cost") test_phase6i_publish_cost_at_the_maximum(200);
    else if (contract == "slew-cost") test_phase6i_slew_cost_at_the_maximum();
    else if (contract == "chain-limit") test_phase6i_blend_chain_limit_with_held_voices();
    else return 2;
    return 0;
  }
  if (argc == 3 && std::strcmp(argv[1], "--phase-3-contract") == 0) {
    if (std::strcmp(argv[2], "connected-topology") == 0)
      test_phase3_long_wet_tail_across_unrelated_edit(true);
    else if (std::strcmp(argv[2], "connected-removal") == 0)
      test_phase3_long_wet_tail_across_unrelated_edit(true, true);
    else if (std::strcmp(argv[2], "delete-44100") == 0)
      test_phase3_deleted_source_fades_for_five_milliseconds(44100);
    else if (std::strcmp(argv[2], "delete-48000") == 0)
      test_phase3_deleted_source_fades_for_five_milliseconds(48000);
    else if (std::strcmp(argv[2], "delete-96000") == 0)
      test_phase3_deleted_source_fades_for_five_milliseconds(96000);
    else if (std::strcmp(argv[2], "stage-order") == 0) {
      test_phase3_deleted_stage_keeps_its_chain_position(0);
      test_phase3_deleted_stage_keeps_its_chain_position(1);
      test_phase3_native_hook_stage_follows_ghost_chain();
    } else if (std::strcmp(argv[2], "clip-deletion") == 0) {
      test_phase3_deleted_audio_clip_source_fades(44100);
      test_phase3_deleted_audio_clip_source_fades(48000);
    } else if (std::strcmp(argv[2], "live-override") == 0)
      test_phase3_live_override_survives_publish_and_ghost_keeps_it();
    else if (std::strcmp(argv[2], "full-capacity") == 0)
      test_phase3_full_capacity_replace_fades_and_overflow_fails_cleanly();
    else if (std::strcmp(argv[2], "group-deletion") == 0)
      test_phase3_source_and_group_deletion_apply_the_envelope_once();
    else if (std::strcmp(argv[2], "pending-patch") == 0)
      test_phase3_unresolved_patch_blocks_prepare();
    else if (std::strcmp(argv[2], "slot-exhaustion") == 0)
      test_phase3_slot_exhaustion_rollback_and_epoch_delayed_reuse();
    else if (std::strcmp(argv[2], "ghost-sidechain") == 0)
      test_phase3_deleted_compressor_keeps_its_external_sidechain();
    else if (std::strcmp(argv[2], "adjacent-removal") == 0)
      test_phase3_adjacent_removed_processors_fade_as_one_stage();
    else if (std::strcmp(argv[2], "object-isolation") == 0)
      test_phase3_non_latency_edit_touches_only_its_own_object();
    else if (std::strcmp(argv[2], "explicit-failure") == 0)
      test_phase3_edit_that_cannot_be_carried_fails_instead_of_resetting();
    else if (std::strcmp(argv[2], "ghost-reparent") == 0)
      test_phase3_deleting_a_node_keeps_its_processors_running_fade();
    else if (std::strcmp(argv[2], "expired-key") == 0)
      test_phase3_deleted_key_hands_the_detector_back_to_its_own_input();
    else if (std::strcmp(argv[2], "bypass-kinds") == 0)
      test_phase3_every_kind_bypass_ramps_alike();
    else if (std::strcmp(argv[2], "bypass-restructure") == 0)
      test_phase3_restructure_mid_bypass_keeps_the_ramp();
    else if (std::strcmp(argv[2], "reorder-declick") == 0)
      test_phase3_reorder_dips_through_nothing();
    else if (std::strcmp(argv[2], "ungroup") == 0)
      test_phase3_ungroup_hands_children_from_the_group_to_the_direct_route();
    else if (std::strcmp(argv[2], "send-edit") == 0)
      test_phase3_send_deletion_and_addition_ramp();
    else if (std::strcmp(argv[2], "layout-change") == 0) {
      test_phase3_layout_change_ramps(true);
      test_phase3_layout_change_ramps(false);
    } else if (std::strcmp(argv[2], "instrument-replacement") == 0)
      test_phase3_instrument_replacement_hands_over_without_a_step();
    else if (std::strcmp(argv[2], "slot-reuse") == 0)
      test_phase3_reused_node_slot_starts_clean();
    else if (std::strcmp(argv[2], "slot-dip") == 0)
      test_phase3_reused_node_slot_has_no_dip();
    else if (std::strcmp(argv[2], "slot-pristine") == 0)
      test_phase3_reclaimed_slots_are_pristine();
    else if (std::strcmp(argv[2], "compiled-bypass") == 0)
      test_phase3_compiled_bypass_is_a_parameter_not_a_restructure();
    else if (std::strcmp(argv[2], "startup-dry") == 0)
      test_phase3_initially_bypassed_stage_starts_dry();
    else if (std::strcmp(argv[2], "layout-waveform") == 0) {
      test_phase3_layout_change_crossfades_the_waveform(true);
      test_phase3_layout_change_crossfades_the_waveform(false);
    } else if (std::strcmp(argv[2], "instrument-waveform") == 0)
      test_phase3_instrument_replacement_crossfades_the_waveform();
    else if (std::strcmp(argv[2], "replacement-depth") == 0)
      test_phase3_replacement_depth_is_bounded_and_recovers();
    else if (std::strcmp(argv[2], "reorder-rates") == 0)
      test_phase3_reorder_steps_stay_small_at_every_rate();
    else if (std::strcmp(argv[2], "reorder-transient") == 0)
      test_phase3_reorder_does_not_replay_expired_transients();
    else if (std::strcmp(argv[2], "reorder-external") == 0)
      test_phase3_reorder_with_an_external_stage_dips_at_block_edges();
    else if (std::strcmp(argv[2], "reorder-during-dip") == 0)
      test_phase3_reorder_during_a_dip_continues_it();
    else if (std::strcmp(argv[2], "reorder-envelope") == 0)
      test_phase3_reorder_never_exceeds_the_envelope_of_either_order();
    else if (std::strcmp(argv[2], "reorder-highpass") == 0)
      test_phase3_reorder_residue_decays_through_a_resonant_high_pass();
    else if (std::strcmp(argv[2], "compiler-stages") == 0)
      test_phase3_stages_are_what_the_compiler_emits();
    else if (std::strcmp(argv[2], "fixture-malformed") == 0)
      test_graph_fixture_rejects_malformed_edit_graphs();
    else if (std::strcmp(argv[2], "transition-matrix") == 0)
      test_phase3_transition_matrix(false);
    else if (std::strcmp(argv[2], "transition-matrix-full") == 0)
      test_phase3_transition_matrix(true);
    else if (std::strcmp(argv[2], "mixer-hold") == 0)
      test_mixer_event_value_holds_across_blocks();
    else if (std::strcmp(argv[2], "mixer-solo-hold") == 0)
      test_mixer_solo_event_holds_and_silences_other_faders();
    else if (std::strcmp(argv[2], "mixer-publish-latch") == 0)
      test_mixer_publish_drops_latched_values();
    else if (std::strcmp(argv[2], "mixer-epoch-latch") == 0)
      test_mixer_epoch_change_drops_latched_values();
    else if (std::strcmp(argv[2], "mixer-publish-ramp") == 0)
      test_mixer_publish_ramps_gain_mute_and_unmute();
    else if (std::strcmp(argv[2], "edge-publish-ramp") == 0)
      test_edge_publish_ramps_gain_mute_and_solo();
    else if (std::strcmp(argv[2], "source-input-bus") == 0)
      test_source_input_bus_is_bounded_by_bus_capacity();
    else return 2;
    return 0;
  }
  if (argc != 1) return 2;
  test_phase3_chain_reorder_preserves_history_and_observer_counts();
  test_phase3_long_wet_tail_across_unrelated_edit(false);
  test_phase3_long_wet_tail_across_unrelated_edit(true);
  test_phase3_long_wet_tail_across_unrelated_edit(true, true);
  for (const uint32_t sample_rate : {44100u, 48000u, 96000u})
    test_phase3_deleted_source_fades_for_five_milliseconds(sample_rate);
  test_phase3_processor_removal_fades_while_retained_stays_exact();
  test_phase3_slot_exhaustion_rollback_and_epoch_delayed_reuse();
  test_phase3_deleted_stage_keeps_its_chain_position(0);
  test_phase3_deleted_stage_keeps_its_chain_position(1);
  test_phase3_native_hook_stage_follows_ghost_chain();
  test_phase3_deleted_audio_clip_source_fades(44100);
  test_phase3_deleted_audio_clip_source_fades(48000);
  test_phase3_live_override_survives_publish_and_ghost_keeps_it();
  test_phase3_full_capacity_replace_fades_and_overflow_fails_cleanly();
  test_phase3_source_and_group_deletion_apply_the_envelope_once();
  test_phase3_deleted_compressor_keeps_its_external_sidechain();
  test_phase3_adjacent_removed_processors_fade_as_one_stage();
  test_phase3_non_latency_edit_touches_only_its_own_object();
  test_phase3_edit_that_cannot_be_carried_fails_instead_of_resetting();
  test_phase3_deleting_a_node_keeps_its_processors_running_fade();
  test_phase3_deleted_key_hands_the_detector_back_to_its_own_input();
  test_phase3_every_kind_bypass_ramps_alike();
  test_phase3_restructure_mid_bypass_keeps_the_ramp();
  test_phase3_reorder_dips_through_nothing();
  test_phase3_ungroup_hands_children_from_the_group_to_the_direct_route();
  test_phase3_send_deletion_and_addition_ramp();
  test_phase3_layout_change_ramps(true);
  test_phase3_layout_change_ramps(false);
  test_phase3_instrument_replacement_hands_over_without_a_step();
  test_phase3_reused_node_slot_starts_clean();
  test_phase3_reused_node_slot_has_no_dip();
  test_phase4_sequential_maximum_replacement();
  test_phase4_keep_routing(false, false);
  test_phase4_keep_routing(true, false);
  test_phase4_keep_routing(false, true);
  test_phase4_keep_divergent_bus_rejected();
  test_phase4_fft_change_audible();
  test_phase3_reclaimed_slots_are_pristine();
  test_phase3_compiled_bypass_is_a_parameter_not_a_restructure();
  test_phase3_initially_bypassed_stage_starts_dry();
  test_phase3_layout_change_crossfades_the_waveform(true);
  test_phase3_layout_change_crossfades_the_waveform(false);
  test_phase3_instrument_replacement_crossfades_the_waveform();
  test_phase3_replacement_depth_is_bounded_and_recovers();
  for (const uint32_t kind : {DAW_AUDIO_INSTRUMENT_KIND_SYNTH, DAW_AUDIO_INSTRUMENT_KIND_SAMPLER,
    DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK, DAW_AUDIO_INSTRUMENT_KIND_GRANULAR}) {
    test_phase6i_held_note_survives_an_edit(kind);
    if (kind != DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) test_phase6i_polyphony_change_keeps_the_newest_voices(kind);
    if (kind == DAW_AUDIO_INSTRUMENT_KIND_SAMPLER || kind == DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK) test_phase6i_zone_edit_under_a_held_note(kind);
    test_phase6i_continuous_edits_do_not_replace_the_instrument(kind);
    if (kind == DAW_AUDIO_INSTRUMENT_KIND_SAMPLER || kind == DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) test_phase6i_padding_is_not_part_of_a_configuration(kind);
    if (kind == DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) continue;
    test_phase6i_replacement_goes_on_from_the_applied_value(kind);
    for (const Drag drag : {Drag::Gain, Drag::Pan, Drag::Cutoff, Drag::Pitch}) {
      test_phase6i_drag_is_smooth(kind, drag, false);
      if (kind == DAW_AUDIO_INSTRUMENT_KIND_SYNTH && drag != Drag::Pitch) test_phase6i_drag_is_smooth(kind, drag, true);
    }
  }
  test_phase6i_event_burst_and_reversal_are_smooth();
  test_phase6i_automation_and_a_drag_share_a_parameter();
  test_phase6i_bad_values_and_the_polyphony_cap();
  test_phase6i_pedal_and_note_off_survive_an_edit();
  test_phase6i_granular_parameter_edit_under_a_held_note();
  test_phase6i_replacement_chain_has_no_level_bump();
  test_phase6i_publish_cost_at_the_maximum();
  test_phase6i_slew_cost_at_the_maximum();
  test_phase6i_blend_chain_limit_with_held_voices();
  test_phase3_reorder_steps_stay_small_at_every_rate();
  test_phase3_reorder_does_not_replay_expired_transients();
  test_phase3_reorder_during_a_dip_continues_it();
  test_phase3_reorder_with_an_external_stage_dips_at_block_edges();
  test_phase3_reorder_never_exceeds_the_envelope_of_either_order();
  test_phase3_reorder_residue_decays_through_a_resonant_high_pass();
  test_phase3_stages_are_what_the_compiler_emits();
  test_graph_fixture_rejects_malformed_edit_graphs();
  test_phase3_transition_matrix(false);
  test_phase3_unresolved_patch_blocks_prepare();
  test_portable_graph_topology_pdc_and_revision_safety();
  test_graph_edges_read_declared_stage_taps();
  test_master_mixer_gain_is_applied_to_rendered_output();
  test_mixer_event_value_holds_across_blocks();
  test_mixer_solo_event_holds_and_silences_other_faders();
  test_mixer_publish_drops_latched_values();
  test_mixer_epoch_change_drops_latched_values();
  test_mixer_publish_ramps_gain_mute_and_unmute();
  test_edge_publish_ramps_gain_mute_and_solo();
  test_source_input_bus_is_bounded_by_bus_capacity();
  test_native_graph_hook_binds_prepared_nodes_before_publish();
  test_native_mixed_stage_interleave_is_noncommutative_and_fader_is_last();
  test_native_instrument_hook_is_a_source_stage();
  test_native_hook_runs_before_builtin_processor();
  test_portable_graph_rejects_invalid_topology_and_capacity();
  test_portable_graph_accepts_a_full_effect_chain();
  test_portable_graph_utility_node();
  test_per_instance_history_isolation_and_republication();
  test_same_core_processor_state_patch_preserves_revision();
  test_utility_history_isolated_between_instances_and_standalone();
  test_pdc_delay_may_exceed_runtime_block_size_within_ring_capacity();
  test_phase4_full_history_and_fanout(128);
  test_phase4_full_history_and_fanout(8192);
  test_processor_chain_prepare_and_dispatch();
  test_processor_control_slot_survives_graph_compaction();
  test_eq_realtime_parameter_offsets_and_persistence();
  test_portable_saturator_and_eq_characterization();
  test_targeted_sidechain_routing();
  test_portable_modulation_processor_characterization();
  test_portable_dynamics_processor_characterization();
  test_portable_delay_and_reverb_characterization();
  test_eight_delay_fallback_releases_retirement_slots_and_tails();
  test_live_delay_and_reverb_retirement_materialization();
  test_portable_spectral_processor_characterization_and_capacity();
  test_abi_and_revision_rejection();
  test_same_core_prepared_graph_can_be_cancelled();
  test_incompatible_continuity_prepare_does_not_consume_reset_state();
  test_variable_blocks_and_capacity();
  test_stale_asset_handles();
  test_mapped_asset_retains_wide_frame_ranges();
  test_wasm_planar_preserves_requested_eager_channels();
  test_paged_asset_pool_preparation_and_rendering();
  test_paged_asset_wide_indices_capacity_and_eof_guards();
  test_sample_source_scheduling();
  test_sample_source_curved_fades();
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
  test_repeated_identical_instrument_revision_preserves_continuity();
  test_instrument_reindex_retains_sustain_and_live_parameter_override();
  test_instrument_synthesis_lifecycle_determinism_and_boundaries();
  test_synth_filter_modes_and_partition_invariance();
  test_sampler_and_drum_rack_asset_voices();
  test_granular_asset_seed_freeze_and_note_ownership();
  test_recording_capture_boundaries_ownership_and_overflow();
}
