#include "daw/audio_host_macos.h"
#include "daw/audio_host_automation_override.h"
#include "daw/audio_host_event_scheduler.h"
#include "daw/audio_core_native.h"
#include "daw/audio_core_instrument_wire.h"
#include "../src/acceptance-output-tap.h"
#include "../src/revision-publication-wait.h"
#include "../src/offline-failure-message.h"
#include "../src/recording-spool.h"
#include "worker-supervisor.h"
#include "vst3-worker.h"
#include <algorithm>
#include <array>
#include <bit>
#include <cassert>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <chrono>
#include <cstring>
#include <cstdio>
#include <future>
#include <filesystem>
#include <limits>
#include <optional>
#include <poll.h>
#include <signal.h>
#include <string>
#include <string_view>
#include <thread>
#include <vector>
#include <malloc/malloc.h>
#include <mach/mach.h>
#include <sys/stat.h>

// Linked only by this test executable's private core translation unit.
// Tests arm this before processing, on the same thread as the callback.
namespace {
std::uint32_t injected_event_index = UINT32_MAX;
std::uint32_t injected_event_rejections = 0;
std::uint64_t observed_instrument_events = 0;
int lock_failure_after = -1;
std::uint64_t resident_test_budget = UINT64_MAX;
bool measure_validation = false;
bool observe_context = false;
std::uint32_t context_applications = 0;
std::int64_t context_frame = -1;
double context_bpm = 0;
std::uint32_t context_numerator = 0, context_denominator = 0;
std::uint64_t validation_heap_start = 0, validation_resident_start = 0;
std::uint64_t validation_heap_peak = 0, validation_resident_peak = 0;
}
extern "C" void daw_audio_host_test_transport_context(
  const std::int64_t frame, const double bpm, const std::uint32_t numerator, const std::uint32_t denominator) {
  if (!observe_context) return;
  ++context_applications;
  context_frame = frame;
  context_bpm = bpm;
  context_numerator = numerator;
  context_denominator = denominator;
}
extern "C" void daw_audio_host_test_validation_memory(const bool begin) {
  if (!measure_validation) return;
  malloc_statistics_t heap{};
  malloc_zone_statistics(nullptr, &heap);
  mach_task_basic_info_data_t info{};
  mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
  assert(task_info(mach_task_self(), MACH_TASK_BASIC_INFO,
    reinterpret_cast<task_info_t>(&info), &count) == KERN_SUCCESS);
  if (begin) {
    validation_heap_start = heap.size_in_use;
    validation_resident_start = info.resident_size;
  } else {
    validation_heap_peak = std::max(validation_heap_peak,
      heap.size_in_use > validation_heap_start ? heap.size_in_use - validation_heap_start : 0);
    validation_resident_peak = std::max(validation_resident_peak,
      info.resident_size > validation_resident_start ? info.resident_size - validation_resident_start : 0);
  }
}
extern "C" std::uint64_t daw_audio_host_test_resident_budget() { return resident_test_budget; }
extern "C" bool daw_audio_host_test_fail_memory_lock() {
  if (lock_failure_after < 0) return false;
  return lock_failure_after-- == 0;
}
extern "C" bool daw_audio_core_test_reject_instrument_event(const std::uint32_t index) {
  ++observed_instrument_events;
  if (index != injected_event_index) return false;
  injected_event_index = UINT32_MAX;
  ++injected_event_rejections;
  return true;
}

namespace {

void TestWorkerAutomationSelection() {
  using daw::audio_host_macos::Diagnostics;
  const Diagnostics::WorkerAutomation stale{2, 9, 6, 30, "stale"};
  const Diagnostics::WorkerAutomation current{1, 11, 7, 12, "target"};
  std::optional<Diagnostics::WorkerAutomation> selected;
  selected = daw::audio_host_macos::SelectWorkerAutomation(selected, stale, 7);
  selected = daw::audio_host_macos::SelectWorkerAutomation(selected, current, 7);
  assert(selected && selected->instance_id == "target" && selected->last_parameter_id == 11);
  const Diagnostics::WorkerAutomation other{3, 14, 7, 13, "other"};
  selected = daw::audio_host_macos::SelectWorkerAutomation(selected, other, 7);
  assert(selected && selected->instance_id == "other");
}

std::array<std::uint8_t, 32> Fingerprint(const std::string_view value) {
  std::array<std::uint8_t, 32> result{};
  for (std::size_t index = 0; index < result.size(); ++index) {
    result[index] = static_cast<std::uint8_t>(
      std::stoul(std::string(value.substr(index * 2, 2)), nullptr, 16)
    );
  }
  return result;
}

void AppendLeU32(std::vector<std::uint8_t>& bytes, const std::uint32_t value) {
  bytes.push_back(static_cast<std::uint8_t>(value));
  bytes.push_back(static_cast<std::uint8_t>(value >> 8U));
  bytes.push_back(static_cast<std::uint8_t>(value >> 16U));
  bytes.push_back(static_cast<std::uint8_t>(value >> 24U));
}

void WriteLeU32(
  std::vector<std::uint8_t>& bytes,
  const std::size_t offset,
  const std::uint32_t value
) {
  bytes[offset] = static_cast<std::uint8_t>(value);
  bytes[offset + 1] = static_cast<std::uint8_t>(value >> 8U);
  bytes[offset + 2] = static_cast<std::uint8_t>(value >> 16U);
  bytes[offset + 3] = static_cast<std::uint8_t>(value >> 24U);
}

void AppendLeU64(std::vector<std::uint8_t>& bytes, const std::uint64_t value) {
  for (std::size_t index = 0; index < 8; ++index) {
    bytes.push_back(static_cast<std::uint8_t>(value >> (index * 8U)));
  }
}

void AppendLeFloat(std::vector<std::uint8_t>& bytes, const float value) {
  std::uint32_t encoded = 0;
  std::memcpy(&encoded, &value, sizeof(encoded));
  AppendLeU32(bytes, encoded);
}

void AppendBeU32(std::vector<std::uint8_t>& bytes, const std::uint32_t value) {
  bytes.push_back(static_cast<std::uint8_t>(value >> 24U));
  bytes.push_back(static_cast<std::uint8_t>(value >> 16U));
  bytes.push_back(static_cast<std::uint8_t>(value >> 8U));
  bytes.push_back(static_cast<std::uint8_t>(value));
}

void AppendBeU64(std::vector<std::uint8_t>& bytes, const std::uint64_t value) {
  for (int index = 7; index >= 0; --index) {
    bytes.push_back(static_cast<std::uint8_t>(value >> (index * 8)));
  }
}

#if defined(__clang__) || defined(__GNUC__)
__attribute__((noinline))
#endif
void ClobberStack() {
  volatile std::uint8_t storage[32 * 1024]{};
  for (std::size_t index = 0; index < sizeof(storage); ++index) {
    storage[index] = static_cast<std::uint8_t>(index);
  }
}

// The gain a kept edge applies `frame` frames (from 1) into the move a publish
// starts at 48 kHz: from `from` to `to` over the core's 5 ms (240-frame) fade.
float PublishedEdgeGain(const float from, const float to, const std::uint32_t frame) {
  return from + (to - from) * (static_cast<float>(frame) / 240.0F);
}

std::vector<std::uint8_t> GraphSnapshot(
  const std::uint32_t revision,
  const float gain,
  const std::uint32_t native_node_latency = 0,
  const bool with_utility = false
) {
  std::vector<std::uint8_t> payload;
  AppendLeU32(payload, native_node_latency > 0
    ? DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION_EXTERNAL_LATENCY
    : DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION);
  AppendLeU32(payload, revision);
  AppendLeU32(payload, 2);
  AppendLeU32(payload, 1);
  AppendLeU32(payload, with_utility ? 1 : 0);
  AppendLeU32(payload, 0);
  const auto append_node = [&payload, native_node_latency](const std::uint64_t id, const std::uint32_t kind) {
    AppendLeU64(payload, id);
    AppendLeU32(payload, kind);
    AppendLeU32(payload, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
    AppendLeU32(payload, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, native_node_latency > 0 ? 0 : id == 2 ? native_node_latency : 0);
    if (native_node_latency > 0) AppendLeU32(payload, id == 2 ? native_node_latency : 0);
    for (std::size_t field = 0; field < 20; ++field) AppendLeU32(payload, 0);
    AppendLeU64(payload, 0);
    AppendLeFloat(payload, 0.0F);
    AppendLeFloat(payload, 0.0F);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, 0);
  };
  append_node(1, 1);
  append_node(2, 6);
  AppendLeU64(payload, 3);
  AppendLeU64(payload, 1);
  AppendLeU64(payload, 2);
  AppendLeU64(payload, 0);
  AppendLeFloat(payload, gain);
  AppendLeU32(payload, DAW_AUDIO_GRAPH_EDGE_POST_FADER);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 0);
  if (with_utility) {
    AppendLeU64(payload, 2);
    AppendLeU32(payload, DAW_AUDIO_PROCESSOR_KIND_UTILITY);
    AppendLeU32(payload, 1);
    AppendLeU32(payload, 40);
    AppendLeU32(payload, 77);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
    AppendLeU32(payload, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
    AppendLeU32(payload, 1);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, 1);
    AppendLeFloat(payload, 0.0F);
    AppendLeU32(payload, DAW_AUDIO_UTILITY_POLARITY_NORMAL);
    AppendLeU32(payload, DAW_AUDIO_UTILITY_INPUT_MODE_STEREO);
    AppendLeFloat(payload, 0.0F);
    AppendLeFloat(payload, 0.0F);
    AppendLeFloat(payload, 1.0F);
    AppendLeU32(payload, DAW_AUDIO_UTILITY_MATRIX_STEREO);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB);
  }
  std::vector<std::uint8_t> frame;
  AppendBeU64(frame, revision);
  AppendBeU32(frame, static_cast<std::uint32_t>(payload.size()));
  frame.insert(frame.end(), payload.begin(), payload.end());
  return frame;
}

struct SnapshotEdge {
  std::uint64_t id;
  std::uint64_t from;
  std::uint64_t to;
  float gain = 0.25F;
};

struct SnapshotNode {
  std::uint64_t id;
  std::uint32_t kind;
  std::uint32_t bus;
};

std::vector<std::uint8_t> RoutedGraphSnapshot(
  const std::uint32_t revision,
  const std::vector<SnapshotNode>& nodes,
  const std::vector<SnapshotEdge>& edges
) {
  std::vector<std::uint8_t> payload;
  AppendLeU32(payload, DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION);
  AppendLeU32(payload, revision);
  AppendLeU32(payload, static_cast<std::uint32_t>(nodes.size()));
  AppendLeU32(payload, static_cast<std::uint32_t>(edges.size()));
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 0);
  for (const auto& [id, kind, bus] : nodes) {
    AppendLeU64(payload, id);
    AppendLeU32(payload, kind);
    AppendLeU32(payload, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
    AppendLeU32(payload, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
    AppendLeU32(payload, bus);
    for (std::size_t field = 0; field < 21; ++field) AppendLeU32(payload, 0);
    AppendLeU64(payload, 0);
    AppendLeFloat(payload, 0.0F);
    AppendLeFloat(payload, 0.0F);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, 0);
  }
  for (const auto& edge : edges) {
    AppendLeU64(payload, edge.id);
    AppendLeU64(payload, edge.from);
    AppendLeU64(payload, edge.to);
    AppendLeU64(payload, 0);
    AppendLeFloat(payload, edge.gain);
    AppendLeU32(payload, DAW_AUDIO_GRAPH_EDGE_POST_FADER);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, 0);
  }
  std::vector<std::uint8_t> frame;
  AppendBeU64(frame, revision);
  AppendBeU32(frame, static_cast<std::uint32_t>(payload.size()));
  frame.insert(frame.end(), payload.begin(), payload.end());
  return frame;
}

// Master 1000 plus one source per entry of `sources` (id, input bus), joined by `edges`.
std::vector<std::uint8_t> EdgeGraphSnapshot(
  const std::uint32_t revision,
  const std::vector<std::pair<std::uint64_t, std::uint32_t>>& sources,
  const std::vector<SnapshotEdge>& edges
) {
  std::vector<SnapshotNode> nodes{{1000, 6, 0}};
  for (const auto& [id, bus] : sources) nodes.push_back({id, 1, bus});
  return RoutedGraphSnapshot(revision, nodes, edges);
}

// Master 1000 fed by one source per entry of `sources` (id, input bus).
std::vector<std::uint8_t> FanInGraphSnapshot(
  const std::uint32_t revision,
  const std::vector<std::pair<std::uint64_t, std::uint32_t>>& sources
) {
  std::vector<SnapshotEdge> edges;
  for (const auto& source : sources) edges.push_back({source.first, source.first, 1000});
  return EdgeGraphSnapshot(revision, sources, edges);
}

std::vector<std::uint8_t> InstrumentGraphSnapshot(const std::uint32_t revision) {
  auto frame = GraphSnapshot(revision, 1.0F);
  WriteLeU32(frame, 44, 2);
  constexpr std::size_t instrument_offset = 64;
  WriteLeU32(frame, instrument_offset, DAW_AUDIO_INSTRUMENT_KIND_SYNTH);
  WriteLeU32(frame, instrument_offset + 4, 1);
  WriteLeU32(frame, instrument_offset + 8, 2);
  WriteLeU32(frame, instrument_offset + 12, 8);
  const std::array<std::uint32_t, 8> targets{{
    DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_GAIN,
    DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_PAN,
    DAW_AUDIO_SYNTH_PARAMETER_FILTER_CUTOFF_HZ,
    DAW_AUDIO_SYNTH_PARAMETER_FILTER_RESONANCE,
    DAW_AUDIO_SYNTH_PARAMETER_AMP_ATTACK_MS,
    DAW_AUDIO_SYNTH_PARAMETER_AMP_DECAY_MS,
    DAW_AUDIO_SYNTH_PARAMETER_AMP_SUSTAIN,
    DAW_AUDIO_SYNTH_PARAMETER_AMP_RELEASE_MS,
  }};
  for (std::size_t index = 0; index < targets.size(); ++index) {
    WriteLeU32(frame, instrument_offset + 16 + index * 4, targets[index]);
  }
  return frame;
}

std::vector<std::uint8_t> InstrumentStatePayload(const float output_gain) {
  daw_audio_synth_state state{
    .version = 1,
    .seed = 1,
    .filter_cutoff_hz = 1000.0F,
    .filter_resonance = 0.7F,
    .filter_key_tracking = 0.5F,
    .filter_sustain = 0.5F,
    .amp_sustain = 0.5F,
    .lfo_rate_hz = 1.0F,
    .output_gain = output_gain,
  };
  std::vector<std::uint8_t> payload;
  AppendLeU32(payload, 1);
  AppendLeU64(payload, 1);
  AppendLeU32(payload, DAW_AUDIO_INSTRUMENT_KIND_SYNTH);
  AppendLeU32(payload, sizeof(state));
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 0);
  const auto* bytes = reinterpret_cast<const std::uint8_t*>(&state);
  payload.insert(payload.end(), bytes, bytes + sizeof(state));
  return payload;
}

std::vector<std::uint8_t> PackedSynthStatePayload(const float output_gain) {
  std::vector<std::uint8_t> state(daw::audio_core_wire::kSynthStateBytes);
  WriteLeU32(state, 0, 1);
  WriteLeU32(state, 4, 1);
  WriteLeU32(state, 8, 1);
  WriteLeU32(state, 12, DAW_AUDIO_SYNTH_WAVEFORM_SAWTOOTH);
  WriteLeU32(state, 56, 1);
  WriteLeU32(state, 64, 1);
  WriteLeU32(state, 68, DAW_AUDIO_SYNTH_FILTER_MODE_LOWPASS);
  const auto write_float = [&state](const std::size_t offset, const float value) {
    std::uint32_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    WriteLeU32(state, offset, bits);
  };
  write_float(60, 0.1F);
  write_float(72, 1000.0F);
  write_float(76, 0.7F);
  write_float(80, 0.5F);
  write_float(96, 0.5F);
  write_float(112, 0.5F);
  write_float(128, 1.0F);
  write_float(148, output_gain);
  std::vector<std::uint8_t> payload;
  AppendLeU32(payload, 1);
  AppendLeU64(payload, 1);
  AppendLeU32(payload, DAW_AUDIO_INSTRUMENT_KIND_SYNTH);
  AppendLeU32(payload, static_cast<std::uint32_t>(state.size()));
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 0);
  payload.insert(payload.end(), state.begin(), state.end());
  return payload;
}

std::vector<std::uint8_t> EmptyGranularStatePayload() {
  std::vector<std::uint8_t> payload;
  AppendLeU32(payload, 1);
  AppendLeU64(payload, 1);
  AppendLeU32(payload, DAW_AUDIO_INSTRUMENT_KIND_GRANULAR);
  AppendLeU32(payload, 60);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 1);
  AppendLeU64(payload, 0);
  AppendLeU32(payload, 1);
  AppendLeU32(payload, 16);
  AppendLeU32(payload, DAW_AUDIO_GRANULAR_WINDOW_HANN);
  AppendLeU32(payload, 0);
  AppendLeFloat(payload, 100.0F);
  AppendLeFloat(payload, 10.0F);
  AppendLeFloat(payload, 0.0F);
  AppendLeFloat(payload, 0.0F);
  AppendLeFloat(payload, 0.0F);
  AppendLeFloat(payload, 0.0F);
  AppendLeFloat(payload, 0.0F);
  AppendLeU32(payload, 0);
  return payload;
}

std::vector<std::uint8_t> EmptyGranularGraphSnapshot(const std::uint32_t revision) {
  auto frame = InstrumentGraphSnapshot(revision);
  constexpr std::size_t instrument_offset = 64;
  WriteLeU32(frame, instrument_offset, DAW_AUDIO_INSTRUMENT_KIND_GRANULAR);
  WriteLeU32(frame, instrument_offset + 4, 1);
  WriteLeU32(frame, instrument_offset + 8, 2);
  WriteLeU32(frame, instrument_offset + 12, 0);
  for (std::size_t index = 0; index < DAW_AUDIO_CORE_MAX_INSTRUMENT_PARAMETERS; ++index) {
    WriteLeU32(frame, instrument_offset + 16 + index * 4, 0);
  }
  return frame;
}

void TestEmptyGranularInstrumentState() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48'000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  assert(host.PrepareGraphRevision(2, EmptyGranularGraphSnapshot(2)).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  assert(host.ConfigureInstrumentStates(EmptyGranularStatePayload()));
  assert(host.PublishGraphRevision(2).code == daw::audio_host_macos::GraphRevisionStatusCode::kPublished);
  host.Stop();
}

void TestPackedInstrumentStatePayloadBounds() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48'000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  assert(host.PrepareGraphRevision(1, InstrumentGraphSnapshot(1)).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  assert(host.ConfigureInstrumentStates(PackedSynthStatePayload(0.75F)));
  auto truncated = PackedSynthStatePayload(0.75F);
  truncated.pop_back();
  assert(!host.ConfigureInstrumentStates(truncated));
  auto oversized = PackedSynthStatePayload(0.75F);
  WriteLeU32(oversized, 20, 1);
  assert(!host.ConfigureInstrumentStates(oversized));
  host.Stop();
}

std::vector<std::uint8_t> UrgentTransportRelease(const std::uint32_t epoch) {
  std::vector<std::uint8_t> payload;
  AppendLeU32(payload, 1);
  AppendLeU64(payload, 1);
  AppendLeU64(payload, 1);
  AppendLeU64(payload, 1);
  AppendLeU32(payload, epoch);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, static_cast<std::uint32_t>(
    daw::audio_core::NativeInstrumentEventType::kTransportRelease
  ));
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 0);
  AppendLeFloat(payload, 0.0F);
  return payload;
}

std::vector<std::uint8_t> ProcessorStatePatch(const std::uint32_t revision, const float gain_db) {
  std::vector<std::uint8_t> payload;
  AppendLeU32(payload, 1);
  AppendLeU32(payload, revision);
  AppendLeU64(payload, 2);
  AppendLeU32(payload, 77);
  AppendLeU32(payload, DAW_AUDIO_PROCESSOR_KIND_UTILITY);
  AppendLeU32(payload, 1);
  AppendLeU32(payload, 40);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
  AppendLeU32(payload, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
  AppendLeU32(payload, 1);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 1);
  AppendLeFloat(payload, gain_db);
  AppendLeU32(payload, DAW_AUDIO_UTILITY_POLARITY_NORMAL);
  AppendLeU32(payload, DAW_AUDIO_UTILITY_INPUT_MODE_STEREO);
  AppendLeFloat(payload, 0.0F);
  AppendLeFloat(payload, 0.0F);
  AppendLeFloat(payload, 1.0F);
  AppendLeU32(payload, DAW_AUDIO_UTILITY_MATRIX_STEREO);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB);
  return payload;
}

void AppendInstanceId(std::vector<std::uint8_t>& bytes, const std::string_view instance_id) {
  AppendLeU32(bytes, static_cast<std::uint32_t>(instance_id.size()));
  bytes.insert(bytes.end(), instance_id.begin(), instance_id.end());
}

void AppendLeDouble(std::vector<std::uint8_t>& bytes, const double value) {
  std::uint64_t encoded = 0;
  std::memcpy(&encoded, &value, sizeof(encoded));
  for (std::size_t index = 0; index < sizeof(encoded); ++index) bytes.push_back(static_cast<std::uint8_t>(encoded >> (index * 8U)));
}

std::vector<std::uint8_t> ScheduleWindow(
  const std::uint32_t revision,
  const std::uint32_t epoch,
  const std::uint64_t window_id,
  const std::uint64_t start_frame,
  const std::uint64_t end_frame,
  const std::uint32_t chunk_index,
  const std::uint32_t chunk_count,
  const bool ends_schedule
) {
  std::vector<std::uint8_t> payload;
  AppendLeU32(payload, revision);
  AppendLeU32(payload, epoch);
  AppendLeU64(payload, window_id);
  AppendLeU64(payload, start_frame);
  AppendLeU64(payload, end_frame);
  AppendLeU32(payload, chunk_index);
  AppendLeU32(payload, chunk_count);
  AppendLeU32(payload, ends_schedule ? 1 : 0);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 0);
  AppendLeU64(payload, 0);
  return payload;
}

std::vector<std::uint8_t> ScheduleProcessorSetWindow(
  const std::uint32_t revision,
  const std::uint32_t epoch,
  const std::uint64_t window_id,
  const std::uint64_t start_frame,
  const std::uint64_t end_frame,
  const std::uint64_t processor_instance_id,
  const std::uint32_t parameter_target,
  const std::uint64_t frame,
  const float value
) {
  auto payload = ScheduleWindow(revision, epoch, window_id, start_frame, end_frame, 0, 1, false);
  WriteLeU32(payload, 56, 1);
  AppendLeU64(payload, processor_instance_id);
  AppendLeU32(payload, parameter_target);
  AppendLeU32(payload, 0);
  AppendLeU64(payload, frame);
  AppendLeU64(payload, frame);
  AppendLeFloat(payload, value);
  AppendLeFloat(payload, value);
  return payload;
}

// A set is a record whose end frame is its frame; a longer one is a linear segment.
struct ProcessorRecord {
  std::uint64_t frame;
  std::uint64_t end_frame;
  float start_value;
  float end_value;
};

std::vector<std::uint8_t> ScheduleProcessorRecordsWindow(
  const std::uint64_t window_id,
  const std::uint64_t start_frame,
  const std::uint64_t end_frame,
  const std::vector<ProcessorRecord>& records
) {
  auto payload = ScheduleWindow(2, 1, window_id, start_frame, end_frame, 0, 1, false);
  WriteLeU32(payload, 56, static_cast<std::uint32_t>(records.size()));
  for (const auto& record : records) {
    AppendLeU64(payload, 77);
    AppendLeU32(payload, DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB);
    AppendLeU32(payload, record.end_frame > record.frame ? 1 : 0);
    AppendLeU64(payload, record.frame);
    AppendLeU64(payload, record.end_frame);
    AppendLeFloat(payload, record.start_value);
    AppendLeFloat(payload, record.end_value);
  }
  return payload;
}

std::vector<std::uint8_t> ScheduleAutomationWindow(
  const std::uint32_t revision,
  const std::uint32_t epoch,
  const std::uint64_t window_id,
  const std::uint64_t start_frame,
  const std::uint64_t end_frame,
  const std::string_view instance_id
) {
  auto payload = ScheduleWindow(revision, epoch, window_id, start_frame, end_frame, 0, 1, false);
  payload[52] = 1;
  AppendInstanceId(payload, instance_id);
  AppendLeU32(payload, 7);
  AppendLeU64(payload, start_frame);
  AppendLeU64(payload, end_frame);
  AppendLeDouble(payload, 0.25);
  AppendLeDouble(payload, 0.75);
  AppendLeU32(payload, 1);
  return payload;
}

std::vector<std::uint8_t> ScheduleInstrumentWindow(
  const std::uint32_t revision,
  const std::uint32_t epoch,
  const std::uint64_t window_id,
  const std::uint64_t start_frame,
  const std::uint64_t end_frame,
  const std::uint32_t chunk_index,
  const std::uint32_t chunk_count,
  const bool ends_schedule,
  const std::uint32_t count
) {
  auto payload = ScheduleWindow(
    revision,
    epoch,
    window_id,
    start_frame,
    end_frame,
    chunk_index,
    chunk_count,
    ends_schedule
  );
  WriteLeU32(payload, 44, count);
  for (std::uint32_t index = 0; index < count; ++index) {
    AppendLeU64(payload, 1);
    AppendLeU64(payload, index + 1);
    AppendLeU64(payload, index + 1);
    AppendLeU32(payload, epoch);
    AppendLeU32(payload, index);  // Protocol 27: relative to the 64-bit window start.
    AppendLeU32(payload, DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, index % 128);
    AppendLeFloat(payload, 0.5F);
  }
  return payload;
}

using daw::audio_host_macos::NativeVstEventScheduler;
using daw::audio_host_macos::WorkerNotification;
using daw::audio_host_macos::WorkerNotificationKind;
using daw::audio_host_macos::WorkerNotificationQueue;
using daw::plugin_host::WorkerEventKind;
using daw::plugin_host::WorkerTransportEvent;

WorkerTransportEvent ParameterEvent(const std::uint32_t sample_offset, const std::uint32_t parameter_id) {
  return {
    .kind = WorkerEventKind::kParameter,
    .sampleOffset = sample_offset,
    .parameterId = parameter_id,
    .parameterValue = 0.5,
  };
}

std::size_t PrepareSchedulerBlock(
  NativeVstEventScheduler& scheduler,
  const std::uint32_t frame_count,
  std::array<WorkerTransportEvent, NativeVstEventScheduler::kCapacity>& block_events
) {
  std::size_t event_count = 0;
  assert(scheduler.PrepareBlock(frame_count, block_events, event_count, block_events.size()));
  return event_count;
}

void CommitSchedulerBlock(
  NativeVstEventScheduler& scheduler,
  std::array<WorkerTransportEvent, NativeVstEventScheduler::kCapacity>& block_events,
  const std::size_t event_count
) {
  for (std::size_t index = 1; index < event_count; ++index) {
    const auto event = block_events[index];
    std::size_t position = index;
    while (position > 0 && block_events[position - 1].sampleOffset > event.sampleOffset) {
      block_events[position] = block_events[position - 1];
      --position;
    }
    block_events[position] = event;
  }
  scheduler.CommitBlock(true);
}

void TestNativeVstEventScheduler() {
  {
    NativeVstEventScheduler scheduler;
    const auto event = ParameterEvent(1'000, 1);
    assert(scheduler.QueueEvents({&event, 1}));
    std::array<WorkerTransportEvent, NativeVstEventScheduler::kCapacity> block_events{};
    assert(PrepareSchedulerBlock(scheduler, 512, block_events) == 0);
    scheduler.CommitBlock(true);
    const auto second_count = PrepareSchedulerBlock(scheduler, 512, block_events);
    assert(second_count == 1 && block_events[0].sampleOffset == 488);
    scheduler.CommitBlock(true);
    assert(PrepareSchedulerBlock(scheduler, 512, block_events) == 0);
    scheduler.CommitBlock(true);
  }
  {
    NativeVstEventScheduler scheduler;
    const std::array events{
      ParameterEvent(1'000, 1),
      ParameterEvent(0, 2),
    };
    assert(scheduler.QueueEvents(events));
    std::array<WorkerTransportEvent, NativeVstEventScheduler::kCapacity> block_events{};
    const auto first_count = PrepareSchedulerBlock(scheduler, 512, block_events);
    assert(first_count == 1 && block_events[0].parameterId == 2);
    scheduler.CommitBlock(true);
    const auto second_count = PrepareSchedulerBlock(scheduler, 512, block_events);
    assert(second_count == 1 && block_events[0].parameterId == 1 && block_events[0].sampleOffset == 488);
    scheduler.CommitBlock(true);
    assert(PrepareSchedulerBlock(scheduler, 512, block_events) == 0);
    scheduler.CommitBlock(true);
  }
  {
    NativeVstEventScheduler scheduler;
    const auto event = ParameterEvent(1'500, 1);
    assert(scheduler.QueueEvents({&event, 1}));
    std::array<WorkerTransportEvent, NativeVstEventScheduler::kCapacity> block_events{};
    assert(PrepareSchedulerBlock(scheduler, 512, block_events) == 0);
    scheduler.CommitBlock(true);
    assert(PrepareSchedulerBlock(scheduler, 512, block_events) == 0);
    scheduler.CommitBlock(true);
    const auto third_count = PrepareSchedulerBlock(scheduler, 512, block_events);
    assert(third_count == 1 && block_events[0].sampleOffset == 476);
    scheduler.CommitBlock(true);
  }
  {
    NativeVstEventScheduler scheduler;
    const auto future = ParameterEvent(1'000, 1);
    assert(scheduler.QueueEvents({&future, 1}));
    std::array<WorkerTransportEvent, NativeVstEventScheduler::kCapacity> block_events{};
    assert(PrepareSchedulerBlock(scheduler, 512, block_events) == 0);
    scheduler.CommitBlock(true);
    const auto immediate = ParameterEvent(0, 2);
    assert(scheduler.QueueEvents({&immediate, 1}));
    const auto second_count = PrepareSchedulerBlock(scheduler, 512, block_events);
    assert(second_count == 2);
    assert(block_events[0].parameterId == 1 && block_events[0].sampleOffset == 488);
    assert(block_events[1].parameterId == 2 && block_events[1].sampleOffset == 0);
    CommitSchedulerBlock(scheduler, block_events, second_count);
    assert(PrepareSchedulerBlock(scheduler, 512, block_events) == 0);
    scheduler.CommitBlock(true);
  }
  {
    NativeVstEventScheduler scheduler;
    std::array<WorkerTransportEvent, NativeVstEventScheduler::kCapacity> events{};
    for (std::size_t index = 0; index < events.size(); ++index) {
      events[index] = ParameterEvent(0, static_cast<std::uint32_t>(index));
    }
    assert(scheduler.QueueEvents(events));
    const auto rejected = ParameterEvent(0, 2'048);
    assert(!scheduler.QueueEvents({&rejected, 1}));
    std::array<WorkerTransportEvent, NativeVstEventScheduler::kCapacity> block_events{};
    const auto event_count = PrepareSchedulerBlock(scheduler, 512, block_events);
    assert(event_count == events.size());
    for (std::size_t index = 0; index < event_count; ++index) {
      assert(block_events[index].parameterId == index);
    }
    scheduler.CommitBlock(true);
    assert(PrepareSchedulerBlock(scheduler, 512, block_events) == 0);
    scheduler.CommitBlock(true);
  }
}

void TestNativeVstAutomationOverrideTable() {
  assert(!daw::audio_host_macos::ShouldOverrideNativeVstAutomation(false));
  assert(daw::audio_host_macos::ShouldOverrideNativeVstAutomation(true));
  daw::audio_host_macos::NativeVstAutomationOverrideTable table;
  assert(table.Set(7) == daw::audio_host_macos::NativeVstAutomationOverrideTable::SetResult::kInserted);
  assert(table.Set(7) == daw::audio_host_macos::NativeVstAutomationOverrideTable::SetResult::kAlreadyPresent);
  for (std::uint32_t id = 0; id < daw::audio_host_macos::NativeVstAutomationOverrideTable::kCapacity; ++id) {
    if (id != 7) {
      assert(table.Set(id) == daw::audio_host_macos::NativeVstAutomationOverrideTable::SetResult::kInserted);
    }
  }
  assert(table.Set(100'000) == daw::audio_host_macos::NativeVstAutomationOverrideTable::SetResult::kFull);
  assert(table.Has(7));
  for (std::uint32_t id = 0; id < daw::audio_host_macos::NativeVstAutomationOverrideTable::kCapacity; id += 2) {
    table.Clear(id);
  }
  assert(table.Has(7));
  assert(!table.Has(8));
  for (std::uint32_t id = 0; id < daw::audio_host_macos::NativeVstAutomationOverrideTable::kCapacity / 2; ++id) {
    assert(table.Set(100'000 + id) == daw::audio_host_macos::NativeVstAutomationOverrideTable::SetResult::kInserted);
  }
  assert(table.Has(7));
  daw::audio_host_macos::NativeVstAutomationOverrideTable rollback;
  assert(rollback.Set(7) == daw::audio_host_macos::NativeVstAutomationOverrideTable::SetResult::kInserted);
  assert(rollback.Set(8) == daw::audio_host_macos::NativeVstAutomationOverrideTable::SetResult::kInserted);
  rollback.Clear(8);
  assert(rollback.Has(7));
  assert(!rollback.Has(8));

  daw::audio_host_macos::NativeVstAutomationOverrideTable collision;
  assert(collision.Set(0) == daw::audio_host_macos::NativeVstAutomationOverrideTable::SetResult::kInserted);
  assert(collision.Set(4'096) == daw::audio_host_macos::NativeVstAutomationOverrideTable::SetResult::kInserted);
  collision.Clear(0);
  assert(collision.Set(4'096) == daw::audio_host_macos::NativeVstAutomationOverrideTable::SetResult::kAlreadyPresent);
  assert(collision.Has(4'096));
  collision.Clear(4'096);
  assert(!collision.Has(4'096));
}

void TestDeviceNamespace() {
  assert(daw::audio_host_macos::CoreAudioDeviceId("BuiltInOutput") == "coreaudio:BuiltInOutput");
  const auto uid = daw::audio_host_macos::CoreAudioDeviceUid("coreaudio:BuiltInOutput");
  assert(uid && *uid == "BuiltInOutput");
  assert(!daw::audio_host_macos::CoreAudioDeviceUid("default"));
  assert(!daw::audio_host_macos::CoreAudioDeviceUid("coreaudio:"));
  assert(!daw::audio_host_macos::SelectOutputDevice("definitely-unavailable-daw-device"));
}

void TestControlFrames() {
  const std::array<std::uint8_t, 3> payload{1, 2, 3};
  const auto encoded = daw::audio_host_macos::EncodeControlFrame(
    daw::audio_host_macos::ControlType::kDiagnostics, payload);
  const auto decoded = daw::audio_host_macos::DecodeControlFrame(encoded);
  assert(decoded && decoded->type == daw::audio_host_macos::ControlType::kDiagnostics);
  assert(decoded->payload == std::vector<std::uint8_t>(payload.begin(), payload.end()));
  const auto transport = daw::audio_host_macos::EncodeControlFrame(
    daw::audio_host_macos::ControlType::kTransport, {});
  const auto decodedTransport = daw::audio_host_macos::DecodeControlFrame(transport);
  assert(decodedTransport && decodedTransport->type == daw::audio_host_macos::ControlType::kTransport);
  const auto transaction = daw::audio_host_macos::EncodeControlFrame(
    daw::audio_host_macos::ControlType::kGraphRollback, {});
  const auto protocol_version = daw::audio_host_macos::kControlProtocolVersion;
  assert(transaction == std::vector<std::uint8_t>({
    0x44, 0x41, 0x57, 0x48,
    static_cast<std::uint8_t>(protocol_version >> 24U),
    static_cast<std::uint8_t>(protocol_version >> 16U),
    static_cast<std::uint8_t>(protocol_version >> 8U),
    static_cast<std::uint8_t>(protocol_version),
    0x00, 0x00, 0x00, 0x27,
    0x00, 0x00, 0x00, 0x00,
  }));
  const auto decodedTransaction = daw::audio_host_macos::DecodeControlFrame(transaction);
  assert(decodedTransaction && decodedTransaction->type == daw::audio_host_macos::ControlType::kGraphRollback);
  const auto recording_device_query = daw::audio_host_macos::EncodeControlFrame(
    daw::audio_host_macos::ControlType::kRecordingDeviceQuery, {});
  const auto decoded_recording_device_query = daw::audio_host_macos::DecodeControlFrame(recording_device_query);
  assert(decoded_recording_device_query
    && decoded_recording_device_query->type == daw::audio_host_macos::ControlType::kRecordingDeviceQuery);
  const std::array<std::uint8_t, 18> stop_reason{
    0, 0, 0, 14, 'p', 'r', 'o', 'j', 'e', 'c', 't', '-', 's', 'w', 'i', 't', 'c', 'h',
  };
  const auto stop = daw::audio_host_macos::EncodeControlFrame(
    daw::audio_host_macos::ControlType::kStop, stop_reason);
  const auto decoded_stop = daw::audio_host_macos::DecodeControlFrame(stop);
  assert(decoded_stop && decoded_stop->type == daw::audio_host_macos::ControlType::kStop);
  assert(decoded_stop->payload == std::vector<std::uint8_t>(stop_reason.begin(), stop_reason.end()));
  for (const auto type : std::array{
    daw::audio_host_macos::ControlType::kVstEditor,
    daw::audio_host_macos::ControlType::kVstEditorStatus,
    daw::audio_host_macos::ControlType::kDiagnosticStart,
    daw::audio_host_macos::ControlType::kSpectrumSelection,
    daw::audio_host_macos::ControlType::kSpectrumFrame,
    daw::audio_host_macos::ControlType::kOfflineConfigure,
    daw::audio_host_macos::ControlType::kOfflineStart,
    daw::audio_host_macos::ControlType::kOfflinePcmChunk,
    daw::audio_host_macos::ControlType::kOfflineComplete,
    daw::audio_host_macos::ControlType::kOfflineError,
  }) {
    const auto frame = daw::audio_host_macos::EncodeControlFrame(type, {});
    const auto decodedFrame = daw::audio_host_macos::DecodeControlFrame(frame);
    assert(decodedFrame && decodedFrame->type == type);
  }
  auto malformed = encoded;
  malformed[4] = 2;
  assert(!daw::audio_host_macos::DecodeControlFrame(malformed));
  std::vector<std::uint8_t> oversized(daw::audio_host_macos::kControlFrameHeaderBytes);
  oversized[0] = 0x44;
  oversized[1] = 0x41;
  oversized[2] = 0x57;
  oversized[3] = 0x48;
  oversized[7] = daw::audio_host_macos::kControlProtocolVersion;
  oversized[11] = static_cast<std::uint8_t>(daw::audio_host_macos::ControlType::kAssetInstall);
  oversized[12] = 0x01;
  assert(!daw::audio_host_macos::DecodeControlFrame(oversized));
}

void TestOfflineTerminalIsPublishedBeforeStop() {
  std::vector<std::string> events;
  const auto published = daw::audio_host_macos::detail::PublishOfflineTerminalBeforeStop(
    [&] {
      events.push_back("terminal");
      return true;
    },
    [&] {
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
      events.push_back("stop");
      return false;
    }
  );
  assert(published);
  assert((events == std::vector<std::string>{"terminal", "stop"}));
}

void TestCallbackPlanarBuffersAndSplitting() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  assert(!host.Start());
  assert(host.StartDiagnosticMode());
  std::array<float, 10> left{};
  std::array<float, 10> right{};
  std::array<float, 10> output_left{};
  std::array<float, 10> output_right{};
  for (std::size_t index = 0; index < left.size(); ++index) {
    left[index] = static_cast<float>(index);
    right[index] = -static_cast<float>(index);
  }
  const std::array<const float*, 2> input{left.data(), right.data()};
  const std::array<float*, 2> output{output_left.data(), output_right.data()};
  assert(host.ProcessPlanar(input, output, 10));
  for (std::size_t index = 0; index < left.size(); ++index) {
    assert(output_left[index] == left[index]);
    assert(output_right[index] == right[index]);
  }
  const auto diagnostics = host.diagnostics();
  assert(diagnostics.callbacks == 1);
  assert(diagnostics.split_blocks == 2);
  host.Stop();
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 44100,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 2,
  }));
  assert(host.diagnostics().active_revision == 2);
  assert(host.SetTransport(1, false, 100));
  assert(host.diagnostics().transport_epoch == 1);
  assert(host.Retire(2));
  host.Teardown();
  assert(host.diagnostics().state == daw::audio_host_macos::LifecycleState::kIdle);
}
void TestOfflineStartProcessesWithoutDevice() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "offline:render",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  assert(host.PrepareAndPublishGraph(2, GraphSnapshot(2, 1.0F)));
  assert(host.SetTransport(1, true, 0));
  assert(host.StartDiagnosticMode());
  std::array<float, 4> input_left{};
  std::array<float, 4> input_right{};
  const std::array<const float*, 2> input{
    input_left.data(),
    input_right.data(),
  };
  std::array<float, 4> output_left{};
  std::array<float, 4> output_right{};
  const std::array<float*, 2> output{output_left.data(), output_right.data()};
  assert(host.ProcessPlanar(input, output, 4));
  host.Stop();
}

void TestStaleUrgentInstrumentEventIsDiscardedAfterTransportEpochAdvance() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  assert(host.PrepareGraphRevision(1, InstrumentGraphSnapshot(1)).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  assert(host.ConfigureInstrumentStates(InstrumentStatePayload(0.5F)));
  assert(host.PublishGraphRevision(1).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kPublished);
  assert(host.SetTransport(1, false, 0));
  assert(host.QueueInstrumentEvents(UrgentTransportRelease(1)));
  assert(host.StartOffline());
  assert(host.SetTransport(2, true, 0));

  std::array<float, 4> input_left{};
  std::array<float, 4> input_right{};
  std::array<float, 4> output_left{};
  std::array<float, 4> output_right{};
  const std::array<const float*, 2> input{input_left.data(), input_right.data()};
  const std::array<float*, 2> output{output_left.data(), output_right.data()};
  assert(host.ProcessPlanar(input, output, 4));
  assert(host.diagnostics().rejected_blocks == 0);
  host.Stop();
}


void TestPausedProcessDoesNotAdvanceTransportFrame() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  assert(host.PrepareAndPublishGraph(2, GraphSnapshot(2, 1.0F)));
  assert(host.SetTransport(1, false, 100));
  assert(host.StartDiagnosticMode());
  std::array<float, 4> left{1.0F, 1.0F, 1.0F, 1.0F};
  std::array<float, 4> right{0.5F, 0.5F, 0.5F, 0.5F};
  std::array<float, 4> output_left{};
  std::array<float, 4> output_right{};
  const std::array<const float*, 2> input{left.data(), right.data()};
  const std::array<float*, 2> output{output_left.data(), output_right.data()};

  assert(host.ProcessPlanar(input, output, 4));
  assert(host.diagnostics().transport_frame == 100);
  host.Stop();
}

void TestProcessorStatePatchTimeoutCancelsAndReusesSlot() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  assert(host.PrepareAndPublishGraph(2, GraphSnapshot(2, 1.0F, 0, true)));
  assert(host.StartDiagnosticMode());
  const auto first_patch = ProcessorStatePatch(2, 6.0F);
  auto timed_out = std::async(std::launch::async, [&host, &first_patch] {
    return host.QueueProcessorStatePatch(first_patch);
  });
  assert(timed_out.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
  const auto cancelled = timed_out.get();
  assert(cancelled.outcome == daw::audio_host_macos::ProcessorPatchOutcome::kRefused
    && cancelled.refusal == daw::audio_host_macos::ProcessorPatchRefusal::kNotClaimed && cancelled.token == 0);

  std::array<float, 4> input_left{1.0F, 1.0F, 1.0F, 1.0F};
  std::array<float, 4> input_right{1.0F, 1.0F, 1.0F, 1.0F};
  std::array<float, 4> output_left{};
  std::array<float, 4> output_right{};
  const std::array<const float*, 2> input{input_left.data(), input_right.data()};
  const std::array<float*, 2> output{output_left.data(), output_right.data()};
  assert(host.ProcessPlanar(input, output, 4));
  assert(output_left[0] > 0.99F && output_left[0] < 1.01F);

  const auto second_patch = ProcessorStatePatch(2, 6.0F);
  auto applied = std::async(std::launch::async, [&host, &second_patch] {
    return host.QueueProcessorStatePatch(second_patch);
  });
  std::this_thread::sleep_for(std::chrono::milliseconds(10));
  assert(host.ProcessPlanar(input, output, 4));
  assert(applied.wait_for(std::chrono::seconds(1)) == std::future_status::ready);
  assert(applied.get().outcome == daw::audio_host_macos::ProcessorPatchOutcome::kApplied);
  assert(output_left[0] > 1.99F && output_left[0] < 2.01F);
  // A cancelled patch leaves no claim behind: the next edit prepares normally.
  assert(host.PrepareGraphRevision(3, GraphSnapshot(3, 1.0F, 0, true)).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  assert(host.RollbackGraphRevision(3).code == daw::audio_host_macos::GraphRevisionStatusCode::kRolledBack);
  host.Stop();
}

void TestCheckpoint4ObservationHandoff(const char mode) {
  using daw::audio_host_macos::GraphRevisionStatusCode;
  daw::audio_host_macos::AudioHost host, reference;
  for (auto* current : {&host, &reference}) {
    assert(current->Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
      .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
    assert(current->PrepareAndPublishGraph(1, GraphSnapshot(1, 0.01F)));
    assert(current->SetTransport(1, false, 0));
    assert(current->StartDiagnosticMode());
    assert(current->SetSpectrumNode(1));
  }
  std::array<float, 128> signal{}, left{}, right{};
  const std::array<const float*, 2> input{signal.data(), signal.data()};
  const std::array<float*, 2> output{left.data(), right.data()};
  std::uint64_t frame = 0;
  const auto render = [&] {
    for (std::size_t index = 0; index < signal.size(); ++index)
      signal[index] = 0.01F * std::sin(6.283185307179586 * 12 * (frame + index) / 2048);
    frame += signal.size();
    assert(host.ProcessPlanar(input, output, 128));
    assert(reference.ProcessPlanar(input, output, 128));
  };
  for (unsigned block = 0; block < 16; ++block) {
    render();
    const auto actual = host.DrainSpectrumFrame();
    const auto expected = reference.DrainSpectrumFrame();
    assert(actual && expected && actual->data == expected->data);
  }
  auto candidate = GraphSnapshot(2, 0.01F);
  if (mode == 'b' || mode == 'e') {
    WriteLeU32(candidate, 12 + 24, 9); // Replace source ID and its edge reference.
    WriteLeU32(candidate, 12 + 24 + 264 + 8, 9);
  } else {
    std::swap_ranges(candidate.begin() + 36, candidate.begin() + 168, candidate.begin() + 168);
  }
  if (mode == 'd') {
    render();
    assert(host.SetSpectrumNode(1));
    const auto actual = host.DrainSpectrumFrame();
    const auto expected = reference.DrainSpectrumFrame();
    assert(actual && expected && actual->data == expected->data);
  } else {
    assert(host.PrepareGraphRevision(2, candidate).code == GraphRevisionStatusCode::kPrepared);
    if (mode == 'e') {
      assert(!host.SetSpectrumNode(9));
    } else if (mode == 'c') {
      assert(host.RollbackGraphRevision(2).code == GraphRevisionStatusCode::kRolledBack);
      assert(host.SetSpectrumNode(1));
      render();
      const auto actual = host.DrainSpectrumFrame();
      const auto expected = reference.DrainSpectrumFrame();
      assert(actual && expected && actual->node_id == 1 && actual->data == expected->data);
    } else {
      // The callback-owned seam must not require renderer reselection.
      render();
      const auto before = host.DrainSpectrumFrame();
      assert(before && before->node_id == 1 && before->graph_revision == 1);
      static_cast<void>(reference.DrainSpectrumFrame());
      assert(host.PublishGraphRevision(2).code == GraphRevisionStatusCode::kPublishPending);
      for (unsigned block = 0; block < 20; ++block) {
        render();
        const auto actual = host.DrainSpectrumFrame();
        const auto expected = reference.DrainSpectrumFrame();
        if (mode == 'b') assert(!actual);
        else if (mode != 'f') {
          assert(actual && expected && actual->graph_revision == 2 && actual->node_id == 1);
          assert(actual->sequence == expected->sequence && actual->data == expected->data);
        }
        if (mode == 'a') assert(host.SetSpectrumNode(1));
        if (mode == 'f') {
          const auto meters = host.DrainMeterBatch();
          assert(meters && meters->graph_revision == 2 && meters->transport_epoch == 1);
          for (std::uint32_t index = 0; index < meters->entry_count; ++index) {
            const auto& entry = meters->entries[index];
            double sum = 0;
            for (const auto sample : signal) sum += sample * sample;
            const auto rms = std::sqrt(sum / signal.size());
            assert(std::abs(entry.left_rms - rms * (entry.node_id == 1 ? 1 : 0.01)) < 1e-8);
          }
        }
      }
      assert(host.InspectGraphRevision(2).code == GraphRevisionStatusCode::kPublished);
    }
  }
  host.Stop();
  reference.Stop();
  std::fprintf(stderr, "checkpoint4 observation %c passed\n", mode);
}

void TestNativeMeterQueueAggregatesPostGraphOutput() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  assert(host.PrepareGraphRevision(2, GraphSnapshot(2, 1.0F)).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  assert(host.PublishGraphRevision(2).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kPublished);
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  std::array<float, 4> left{1.0F, 1.0F, 1.0F, 1.0F};
  std::array<float, 4> right{0.5F, 0.5F, 0.5F, 0.5F};
  std::array<float, 4> output_left{};
  std::array<float, 4> output_right{};
  const std::array<const float*, 2> input{left.data(), right.data()};
  const std::array<float*, 2> output{output_left.data(), output_right.data()};
  assert(host.ProcessPlanar(input, output, 4));
  const auto batch = host.DrainMeterBatch();
  assert(batch && batch->graph_revision == 2 && batch->transport_epoch == 1 && batch->entry_count == 2);
  assert(batch->entries[0].node_id == 1 && batch->entries[0].left_rms == 1.0F && batch->entries[0].right_rms == 0.5F);
  assert(batch->entries[1].node_id == 2 && batch->entries[1].left_rms == 1.0F && batch->entries[1].right_rms == 0.5F);
  assert(!host.DrainMeterBatch());
}

void TestNativeVstAttachmentBoundsAndLatencyContract() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  const std::array<float, 8> samples{};
  assert(!host.InstallAsset(1, 4, 48000, 2, 0, std::span<const float>(samples.data(), 7)));
  assert(!host.InstallAsset(1, 4, 48000, daw::audio_host_macos::kMaximumAssetChannels + 1, 0, samples));
  auto non_finite_samples = samples;
  non_finite_samples[0] = std::numeric_limits<float>::quiet_NaN();
  assert(!host.InstallAsset(1, 4, 48000, 2, 0, non_finite_samples));
  assert(host.InstallAsset(1, 4, 48000, 2, 0x1234, samples));
  assert(host.diagnostics().installed_assets == 1);
  assert(host.ReleaseAsset(1));
  assert(host.diagnostics().installed_assets == 0);
  assert(host.ReleaseAsset(1));
  for (std::uint32_t asset_id = 2; asset_id <= daw::audio_host_macos::kMaximumInstalledAssets + 1; ++asset_id) {
    assert(host.InstallAsset(asset_id, 4, 48000, 2, 0, samples));
  }
  assert(!host.InstallAsset(daw::audio_host_macos::kMaximumInstalledAssets + 2, 4, 48000, 2, 0, samples));
  host.Teardown();
  daw::audio_host_macos::NativeVstAttachment reference{
    .graph_node_id = 17,
    .instance_id = "b0c4db1e-bd48-46d4-a4bc-f5ad1fe6c6f1",
    .class_id = "class-id",
    .vendor_id = "vendor-id",
    .canonical_bundle_path = "/private/catalog/Example.vst3",
    .canonical_executable_path = "/private/catalog/Example.vst3/Contents/MacOS/Example",
    .architecture = 1,
    .scanner_catalog_version = 2,
    .role = daw::audio_host_macos::NativeVstRole::kEffect,
    .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .declared_latency_frames = 32,
    .transport_latency_frames = 4,
    .transport = {.slot_count = 2, .maximum_frames = 4, .input_channels = 2, .output_channels = 2, .maximum_events_per_block = 128},
  };
  reference.bundle_fingerprint.fill(1);
  reference.binary_fingerprint.fill(2);
  reference.initial_parameter_values.emplace_back(48, 0.592999);
  assert(host.AttachNativeVst(reference));
  assert(!host.AttachNativeVst(reference));
  assert(!host.DetachVstReference("class-id"));
  assert(host.DetachVstReference(reference.instance_id));
  reference.binary_fingerprint.fill(0);
  assert(!host.AttachNativeVst(reference));
  reference.binary_fingerprint.fill(2);
  reference.transport_latency_frames = 3;
  assert(!host.AttachNativeVst(reference));
}

void TestInstalledAssetSurvivesCallerLifetimeAndMapGrowth() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48'000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  assert(host.PrepareAndPublishGraph(2, GraphSnapshot(2, 1.0F)));
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  assert(host.SetTransport(1, true, 0));

  const std::array<float, 8> target_samples{
    0.25F, 0.5F, 0.75F, 1.0F,
    -0.25F, -0.5F, -0.75F, -1.0F,
  };
  assert(host.InstallAsset(1, 4, 48'000, 2, 0, target_samples));
  ClobberStack();
  const std::array<float, 8> extra_samples{
    2.0F, 2.0F, 2.0F, 2.0F,
    -2.0F, -2.0F, -2.0F, -2.0F,
  };
  for (std::uint32_t asset_id = 2; asset_id <= daw::audio_host_macos::kMaximumInstalledAssets; ++asset_id) {
    assert(host.InstallAsset(asset_id, 4, 48'000, 2, asset_id, extra_samples));
  }
  ClobberStack();

  std::vector<std::uint8_t> source_event;
  AppendLeU32(source_event, 1);
  AppendLeU32(source_event, 1);
  AppendLeU64(source_event, 1);
  AppendLeU64(source_event, 1);
  AppendLeU32(source_event, 1);
  AppendLeU64(source_event, 0);
  AppendLeU64(source_event, 4);
  AppendLeU64(source_event, 0);
  AppendLeU64(source_event, 4);
  AppendLeFloat(source_event, 1.0F);
  AppendLeU64(source_event, 0);
  AppendLeU64(source_event, 0);
  AppendLeU64(source_event, 4);
  AppendLeU64(source_event, 4);
  AppendLeFloat(source_event, 0.0F);
  AppendLeFloat(source_event, 0.0F);
  AppendLeFloat(source_event, 0.5F);
  AppendLeFloat(source_event, 0.0F);
  AppendLeFloat(source_event, 0.5F);
  assert(host.QueueSourceEvents(source_event));

  std::array<float, 4> input_left{};
  std::array<float, 4> input_right{};
  std::array<float, 4> output_left{};
  std::array<float, 4> output_right{};
  const std::array<const float*, 2> input{input_left.data(), input_right.data()};
  const std::array<float*, 2> output{output_left.data(), output_right.data()};
  assert(host.ProcessPlanar(input, output, 4));
  for (std::size_t frame = 0; frame < 4; ++frame) {
    assert(output_left[frame] == target_samples[frame]);
    assert(output_right[frame] == target_samples[4 + frame]);
  }
  host.Stop();
}

void TestMappedAssetSurvivesGraphPublication() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48'000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  assert(host.CreateMappedAsset(1, 4, 48'000, 2, 0));
  const std::array<float, 8> samples{
    0.25F, 0.5F, 0.75F, 1.0F,
    -0.25F, -0.5F, -0.75F, -1.0F,
  };
  assert(host.WriteMappedAssetPage(1, 0, 4, samples));
  assert(host.PrepareAndPublishGraph(2, GraphSnapshot(2, 1.0F)));
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  assert(host.SetTransport(1, true, 0));

  std::vector<std::uint8_t> source_event;
  AppendLeU32(source_event, 1);
  AppendLeU32(source_event, 1);
  AppendLeU64(source_event, 1);
  AppendLeU64(source_event, 1);
  AppendLeU32(source_event, 1);
  AppendLeU64(source_event, 0);
  AppendLeU64(source_event, 4);
  AppendLeU64(source_event, 0);
  AppendLeU64(source_event, 4);
  AppendLeFloat(source_event, 1.0F);
  AppendLeU64(source_event, 0);
  AppendLeU64(source_event, 0);
  AppendLeU64(source_event, 4);
  AppendLeU64(source_event, 4);
  AppendLeFloat(source_event, 0.0F);
  AppendLeFloat(source_event, 0.0F);
  AppendLeFloat(source_event, 0.5F);
  AppendLeFloat(source_event, 0.0F);
  AppendLeFloat(source_event, 0.5F);
  assert(host.QueueSourceEvents(source_event));

  std::array<float, 4> input_left{};
  std::array<float, 4> input_right{};
  std::array<float, 4> output_left{};
  std::array<float, 4> output_right{};
  const std::array<const float*, 2> input{input_left.data(), input_right.data()};
  const std::array<float*, 2> output{output_left.data(), output_right.data()};
  assert(host.ProcessPlanar(input, output, 4));
  for (std::size_t frame = 0; frame < 4; ++frame) {
    assert(output_left[frame] == samples[frame]);
    assert(output_right[frame] == samples[4 + frame]);
  }
  host.Stop();
}

// Failure cases: incomplete upload, invalid page/state, failed first/second lock,
// retry, shared assets, configured/voiced/retired release, cancellation and teardown.
// Exceeds both the legacy host frame ceiling and stereo IPC payload ceiling.
constexpr std::uint32_t kInstrumentFixtureFrames = 300'000;

std::vector<std::uint8_t> SampleInstrumentGraph(const std::uint32_t revision, const std::uint32_t kind) {
  auto graph = EmptyGranularGraphSnapshot(revision);
  WriteLeU32(graph, 64, kind);
  return graph;
}

std::vector<std::uint8_t> SampleInstrumentLatencyGraph(
  const std::uint32_t revision, const std::uint32_t kind, const std::uint32_t master_latency
) {
  auto graph = GraphSnapshot(revision, 1.0F, master_latency);
  WriteLeU32(graph, 44, 2);
  constexpr std::size_t instrument_offset = 68;
  WriteLeU32(graph, instrument_offset, kind);
  WriteLeU32(graph, instrument_offset + 4, 1);
  WriteLeU32(graph, instrument_offset + 8, 2);
  WriteLeU32(graph, instrument_offset + 12, 0);
  for (std::size_t index = 0; index < DAW_AUDIO_CORE_MAX_INSTRUMENT_PARAMETERS; ++index)
    WriteLeU32(graph, instrument_offset + 16 + index * 4, 0);
  return graph;
}

std::vector<std::uint8_t> SampleInstrumentPayload(
  const std::uint32_t kind, const std::uint32_t asset_index = 1, const bool two_assets = false,
  const float position = 0.98F, const float reverse = 1.0F
) {
  const auto handle = (1ULL << 32) | asset_index;
  if (kind == DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) {
    auto payload = EmptyGranularStatePayload();
    for (unsigned byte = 0; byte < 8; ++byte)
      payload[32 + byte] = static_cast<std::uint8_t>(handle >> (byte * 8));
    const auto put = [&](const std::size_t offset, const float value) {
      std::memcpy(payload.data() + 28 + offset, &value, sizeof(value));
    };
    put(36, position); put(40, 0.8F); put(48, reverse);
    return payload;
  }
  std::vector<std::uint8_t> state(daw::audio_core_wire::kSamplerStateBytes);
  WriteLeU32(state, 0, 1);
  WriteLeU32(state, 4, two_assets ? 2 : 1);
  const auto put = [&](const std::size_t offset, const float value) {
    std::memcpy(state.data() + offset, &value, sizeof(value));
  };
  put(16, 1); put(20, 10); put(32, 1000); put(36, 0.7F); put(64, 1);
  std::vector<std::uint8_t> payload;
  AppendLeU32(payload, 1); AppendLeU64(payload, 1); AppendLeU32(payload, kind);
  AppendLeU32(payload, static_cast<std::uint32_t>(state.size()));
  AppendLeU32(payload, (two_assets ? 2 : 1) * daw::audio_core_wire::kSampleZoneBytes);
  AppendLeU32(payload, 0);
  payload.insert(payload.end(), state.begin(), state.end());
  for (unsigned zone = 0; zone < (two_assets ? 2U : 1U); ++zone) {
    AppendLeU64(payload, handle + zone);
    AppendLeU32(payload, 60); AppendLeU32(payload, 60);
    AppendLeU32(payload, 1); AppendLeU32(payload, 127); AppendLeU32(payload, 60);
    AppendLeFloat(payload, 0); AppendLeFloat(payload, 0.8F); AppendLeFloat(payload, 0);
    AppendLeU32(payload, 0); AppendLeU32(payload, 0);
    AppendLeU32(payload, DAW_AUDIO_SAMPLE_PLAYBACK_CROSSFADE_LOOP);
    AppendLeU32(payload, 16380); AppendLeU32(payload, kInstrumentFixtureFrames);
    AppendLeU32(payload, 16380); AppendLeU32(payload, 16420);
    AppendLeU32(payload, 8); AppendLeU32(payload, 0); AppendLeU32(payload, 0);
  }
  return payload;
}

std::vector<float> SampleInstrumentPcm(const float scale = 1.0F) {
  std::vector<float> pcm(kInstrumentFixtureFrames * 2);
  for (std::size_t frame = 0; frame < kInstrumentFixtureFrames; ++frame) {
    pcm[frame] = scale * (0.2F + static_cast<float>(frame % 97) / 500);
    pcm[kInstrumentFixtureFrames + frame] = scale * (-0.1F - static_cast<float>(frame % 131) / 700);
  }
  return pcm;
}

void UploadInstrument(daw::audio_host_macos::AudioHost& host, const unsigned id, const std::vector<float>& pcm,
  const bool omit_last = false) {
  assert(host.CreateMappedAsset(id, kInstrumentFixtureFrames, 48000, 2, 0));
  for (std::uint32_t start = 0; start < kInstrumentFixtureFrames; start += 16384) {
    const auto count = std::min(16384U, kInstrumentFixtureFrames - start);
    if (omit_last && start + count == kInstrumentFixtureFrames) break;
    std::vector<float> page;
    page.insert(page.end(), pcm.begin() + start, pcm.begin() + start + count);
    page.insert(page.end(), pcm.begin() + kInstrumentFixtureFrames + start,
      pcm.begin() + kInstrumentFixtureFrames + start + count);
    assert(host.WriteMappedAssetPage(id, start, count, page));
  }
}

// The ACK status word separates "no core to take it" from "refused on the merits".
void TestAudioCorePresenceIsTheUnavailableBoundary() {
  using namespace daw::audio_host_macos;
  AudioHost host;
  assert(!host.HasAudioCore());
  const std::vector<std::uint8_t> empty_states{0, 0, 0, 0};
  assert(!host.ConfigureInstrumentStates(empty_states));
  assert(host.instrumentPreparationError() == "audio session is unavailable");
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  assert(host.HasAudioCore());
}

void TestInstrumentResidency() {
  using namespace daw::audio_host_macos;
  const auto pcm = SampleInstrumentPcm();
  AudioHost host;
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  UploadInstrument(host, 1, pcm, true);
  assert(!host.PrepareMappedAssetRange(1, 0, kInstrumentFixtureFrames));
  assert(host.PrepareGraphRevision(1, SampleInstrumentGraph(1, DAW_AUDIO_INSTRUMENT_KIND_SAMPLER)).code
    == GraphRevisionStatusCode::kPrepared);
  assert(!host.ConfigureInstrumentStates(SampleInstrumentPayload(2)));
  assert(host.instrumentPreparationError().find("incomplete") != std::string_view::npos);
  assert(host.HasAudioCore());
  assert(host.instrumentLockedBytes() == 0);
  assert(host.RollbackGraphRevision(1).code == GraphRevisionStatusCode::kRolledBack);
  const auto start = (kInstrumentFixtureFrames / 16384U) * 16384U;
  const auto count = kInstrumentFixtureFrames - start;
  std::vector<float> last(pcm.begin() + start, pcm.begin() + kInstrumentFixtureFrames);
  last.insert(last.end(), pcm.begin() + kInstrumentFixtureFrames + start, pcm.end());
  auto malformed = last;
  malformed[0] = std::numeric_limits<float>::quiet_NaN();
  assert(!host.WriteMappedAssetPage(1, start, count, malformed));
  assert(host.WriteMappedAssetPage(1, start, count, last));
  UploadInstrument(host, 2, pcm);
  assert(host.PrepareMappedAssetRange(1, 0, kInstrumentFixtureFrames));
  assert(host.PrepareGraphRevision(1, SampleInstrumentGraph(1, 2)).code == GraphRevisionStatusCode::kPrepared);
  for (const int fail_after : {0, 1}) {
    lock_failure_after = fail_after;
    assert(!host.ConfigureInstrumentStates(SampleInstrumentPayload(2, 1, true)));
    assert(host.instrumentPreparationError().find("memory locking unavailable") != std::string_view::npos);
    assert(host.instrumentLockedBytes() == 0);
  }
  lock_failure_after = -1;
  auto invalid_batch = SampleInstrumentPayload(2);
  WriteLeU32(invalid_batch, 0, 2);
  auto invalid_state = SampleInstrumentPayload(2, 63);
  invalid_batch.insert(invalid_batch.end(), invalid_state.begin() + 4, invalid_state.end());
  assert(!host.ConfigureInstrumentStates(invalid_batch));
  assert(host.instrumentLockedBytes() == 0); // Validate every candidate before mutation.
  assert(host.ConfigureInstrumentStates(SampleInstrumentPayload(2, 1, true)));
  const auto locked = host.instrumentLockedBytes();
  assert(locked >= pcm.size() * sizeof(float) * 2 && locked <= host.instrumentResidentBudgetBytes());
  assert(!host.WriteMappedAssetPage(1, start, count, last));
  assert(host.ReleaseAsset(1));
  assert(host.diagnostics().installed_assets != 0);
  assert(host.ConfigureInstrumentStates(SampleInstrumentPayload(2, 1, true)));
  assert(host.instrumentLockedBytes() == locked);
  assert(host.RollbackGraphRevision(1).code == GraphRevisionStatusCode::kRolledBack);
  assert(host.ReleaseAsset(1) && host.ReleaseAsset(2));
  assert(host.instrumentLockedBytes() == 0);
  resident_test_budget = 16384;
  AudioHost limited;
  resident_test_budget = UINT64_MAX;
  assert(limited.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  UploadInstrument(limited, 1, pcm);
  assert(limited.PrepareGraphRevision(1, SampleInstrumentGraph(1, 2)).code == GraphRevisionStatusCode::kPrepared);
  assert(!limited.ConfigureInstrumentStates(SampleInstrumentPayload(2)));
  assert(limited.instrumentPreparationError().find("sample memory budget exceeded") != std::string_view::npos);
  assert(limited.instrumentLockedBytes() == 0);
  limited.Teardown();

  AudioHost offline;
  assert(offline.Configure({.device_uid = "offline:render", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  UploadInstrument(offline, 1, pcm);
  assert(offline.PrepareGraphRevision(1, SampleInstrumentGraph(1, 4)).code == GraphRevisionStatusCode::kPrepared);
  lock_failure_after = 0;
  assert(offline.ConfigureInstrumentStates(SampleInstrumentPayload(4)));
  assert(lock_failure_after == 0 && offline.instrumentLockedBytes() == 0);
  lock_failure_after = -1;
  assert(!offline.WriteMappedAssetPage(1, start, count, last));
  offline.Teardown();
  AudioHost oversized;
  assert(oversized.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  // Sparse mapping checks the device ceiling without allocating/locking >1 GiB.
  assert(oversized.CreateMappedAsset(1, (1ULL << 28) + 1, 48000, 1, 0));
  assert(oversized.PrepareGraphRevision(1, SampleInstrumentGraph(1, 4)).code == GraphRevisionStatusCode::kPrepared);
  assert(!oversized.ConfigureInstrumentStates(SampleInstrumentPayload(4)));
  assert(oversized.instrumentPreparationError().find("1 GiB per device") != std::string_view::npos);
  assert(oversized.instrumentLockedBytes() == 0);
  oversized.Teardown();
  host.Teardown();
  assert(host.instrumentLockedBytes() == 0);
}

void TestSharedInstrumentResidency() {
  using namespace daw::audio_host_macos;
  AudioHost host;
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  UploadInstrument(host, 1, SampleInstrumentPcm());
  auto graph = FanInGraphSnapshot(1, {{1, 0}, {2, 0}});
  for (const unsigned index : {1, 2}) {
    const auto node = 12 + 24 + index * 132;
    WriteLeU32(graph, node + 8, 2);
    WriteLeU32(graph, node + 28, DAW_AUDIO_INSTRUMENT_KIND_GRANULAR);
    WriteLeU32(graph, node + 32, 1);
    WriteLeU32(graph, node + 36, 2);
  }
  assert(host.PrepareGraphRevision(1, graph).code == GraphRevisionStatusCode::kPrepared);
  auto both = SampleInstrumentPayload(4);
  WriteLeU32(both, 0, 2);
  auto second = SampleInstrumentPayload(4);
  WriteLeU32(second, 4, 2);
  both.insert(both.end(), second.begin() + 4, second.end());
  assert(host.ConfigureInstrumentStates(both));
  const auto bytes = host.instrumentLockedBytes();
  assert(bytes >= kInstrumentFixtureFrames * 2 * sizeof(float)
    && bytes < kInstrumentFixtureFrames * 4 * sizeof(float));
  assert(host.PublishGraphRevision(1).code == GraphRevisionStatusCode::kPublished);
  // A synth record must not clear a granular node's configured sample owner.
  assert(!host.ConfigureInstrumentStates(PackedSynthStatePayload(0.5F)));
  assert(host.ReleaseAsset(1));
  assert(host.diagnostics().installed_assets != 0);
  assert(host.instrumentLockedBytes() == bytes);
  assert(host.ConfigureInstrumentStates(EmptyGranularStatePayload()));
  assert(host.ReleaseAsset(1));
  auto mismatched = PackedSynthStatePayload(0.5F);
  WriteLeU32(mismatched, 4, 2);
  assert(!host.ConfigureInstrumentStates(mismatched));
  assert(host.ReleaseAsset(1)); // Deferred: node 2 remains a sample owner.
  assert(host.instrumentLockedBytes() == bytes);
  auto empty_second = EmptyGranularStatePayload();
  WriteLeU32(empty_second, 4, 2);
  assert(host.ConfigureInstrumentStates(empty_second));
  assert(host.ReleaseAsset(1));
  assert(host.instrumentLockedBytes() == 0);
  host.Teardown();
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  UploadInstrument(host, 1, SampleInstrumentPcm());
  assert(host.PrepareGraphRevision(1, SampleInstrumentGraph(1, 4)).code == GraphRevisionStatusCode::kPrepared);
  assert(host.ConfigureInstrumentStates(SampleInstrumentPayload(4)));
  assert(host.instrumentLockedBytes() != 0);
  host.Teardown(); // Prepared, still resident: destructor/teardown owns the unlock.
  assert(host.instrumentLockedBytes() == 0);
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  UploadInstrument(host, 1, SampleInstrumentPcm());
  assert(host.PrepareGraphRevision(1, SampleInstrumentGraph(1, 4)).code == GraphRevisionStatusCode::kPrepared);
  assert(host.ConfigureInstrumentStates(SampleInstrumentPayload(4)));
  assert(host.PublishGraphRevision(1).code == GraphRevisionStatusCode::kPublished);
  assert(host.instrumentLockedBytes() != 0);
  assert(host.Retire(1));
  host.Teardown();
  assert(host.instrumentLockedBytes() == 0);
}

void TestRestoredInstrumentAssetIdentity() {
  using namespace daw::audio_host_macos;
  const auto pcm = SampleInstrumentPcm();
  const auto timeline_pcm = SampleInstrumentPcm(-2.0F);
  for (const unsigned kind : {2U, 3U, 4U}) {
    AudioHost host;
    // Rebuild the same saved session twice, including a fresh core after teardown.
    for (unsigned load = 0; load < 2; ++load) {
      assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
        .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
      // Projection order is timeline first, localized instrument region second.
      // Stable session IDs sort differently; only the instrument is fully hydrated.
      UploadInstrument(host, 2, timeline_pcm);
      UploadInstrument(host, 1, pcm);
      assert(host.PrepareMappedAssetRange(1, 0, kInstrumentFixtureFrames));
      assert(host.PrepareAndPublishGraph(1, SampleInstrumentGraph(1, kind)));
      assert(host.ConfigureInstrumentStates(SampleInstrumentPayload(kind, 1)));
      assert(host.instrumentLockedBytes() >= pcm.size() * sizeof(float));
      assert(host.ReleaseAsset(2)); // The timeline asset is not the sample owner.
      const auto instrument_bytes = host.instrumentLockedBytes();
      assert(host.ReleaseAsset(2)); // Releasing the absent timeline asset is idempotent.
      assert(host.instrumentLockedBytes() == instrument_bytes);
      assert(host.ReleaseAsset(1));
      assert(host.diagnostics().installed_assets != 0);
      assert(host.SetTransport(1, false, 0));
      auto note = UrgentTransportRelease(1);
      WriteLeU32(note, 36, static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOn));
      WriteLeU32(note, 44, 60);
      const float velocity = 0.8F;
      std::memcpy(note.data() + 48, &velocity, sizeof(velocity));
      assert(host.QueueInstrumentEvents(note));
      assert(host.StartOffline());
      assert(host.SetTransport(1, true, 0));
      std::array<float, 128> silence{}, left{}, right{};
      const std::array<const float*, 2> input{silence.data(), silence.data()};
      const std::array<float*, 2> output{left.data(), right.data()};
      bool audible = false;
      for (unsigned block = 0; block < 128; ++block) {
        assert(host.ProcessPlanar(input, output, 128));
        for (unsigned frame = 0; frame < 128; ++frame) {
          assert(std::isfinite(left[frame]) && std::isfinite(right[frame]));
          audible = audible || left[frame] != 0 || right[frame] != 0;
        }
      }
      assert(audible);
      host.Teardown();
      assert(host.instrumentLockedBytes() == 0);
      assert(host.ReleaseAsset(1));
      assert(host.ReleaseAsset(1));
      assert(host.instrumentLockedBytes() == 0);
    }
  }
}

void TestInstrumentResidencyReplacementCapacityRollback() {
  using namespace daw::audio_host_macos;
  AudioHost host;
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  const auto pcm = SampleInstrumentPcm();
  UploadInstrument(host, 1, pcm);
  UploadInstrument(host, 2, pcm);
  const auto graph = [](const unsigned revision) {
    auto bytes = FanInGraphSnapshot(revision, {{1, 0}, {2, 0}});
    for (const unsigned index : {1, 2}) {
      const auto node = 12 + 24 + index * 132;
      WriteLeU32(bytes, node + 8, 2);
      WriteLeU32(bytes, node + 28, DAW_AUDIO_INSTRUMENT_KIND_GRANULAR);
      WriteLeU32(bytes, node + 32, 1);
      WriteLeU32(bytes, node + 36, 2);
    }
    return bytes;
  };
  assert(host.PrepareGraphRevision(1, graph(1)).code == GraphRevisionStatusCode::kPrepared);
  auto initial = SampleInstrumentPayload(4);
  WriteLeU32(initial, 0, 2);
  auto second = SampleInstrumentPayload(4);
  WriteLeU32(second, 4, 2);
  initial.insert(initial.end(), second.begin() + 4, second.end());
  assert(host.ConfigureInstrumentStates(initial));
  assert(host.PublishGraphRevision(1).code == GraphRevisionStatusCode::kPublished);
  const auto locked = host.instrumentLockedBytes();
  // Publish without processing: each changed configuration adds an unfinished blend.
  for (unsigned revision = 2; revision <= 9; ++revision) {
    assert(host.PrepareGraphRevision(revision, graph(revision)).code == GraphRevisionStatusCode::kPrepared);
    // The window shape is discrete, so each publication replaces the instrument (a
    // continuous edit such as the position would slew in place and start no blend).
    auto edited = SampleInstrumentPayload(4, 1, false, revision / 20.0F);
    WriteLeU32(edited, 28 + 20, revision % 3);
    assert(host.ConfigureInstrumentStates(edited));
    assert(host.PublishGraphRevision(revision).code == GraphRevisionStatusCode::kPublished);
    assert(host.RetireGraphRevision(revision - 1).code == GraphRevisionStatusCode::kRetired);
  }
  assert(host.PrepareGraphRevision(10, graph(10)).code == GraphRevisionStatusCode::kPrepared);
  // Node 2 succeeds with a newly locked mapping before saturated node 1 fails.
  auto batch = SampleInstrumentPayload(4, 2);
  WriteLeU32(batch, 0, 2);
  WriteLeU32(batch, 4, 2);
  const auto failing = SampleInstrumentPayload(4, 2);
  batch.insert(batch.end(), failing.begin() + 4, failing.end());
  assert(!host.ConfigureInstrumentStates(batch));
  assert(host.instrumentPreparationError().find("capacity exceeded") != std::string_view::npos);
  assert(host.instrumentPreparationError().find("prepare and retry") != std::string_view::npos);
  const auto status = host.InspectGraphRevision(9);
  assert(status.code == GraphRevisionStatusCode::kPublished && status.prepared_revision == 0);
  assert(host.instrumentLockedBytes() == locked);
  assert(host.ReleaseAsset(1)); // Deferred: both original published owners survive.
  assert(host.ReleaseAsset(2)); // No partial owner/configuration remains in either node.
  assert(host.instrumentLockedBytes() == locked);
  assert(host.ConfigureInstrumentStates(EmptyGranularStatePayload()));
  assert(host.ReleaseAsset(1)); // Deferred: node 2's original owner survived cancellation.
  assert(host.instrumentLockedBytes() == locked);
  // Active-core configuration succeeds even while all eight blends are unfinished.
  assert(host.ConfigureInstrumentStates(SampleInstrumentPayload(4, 1, false, 9 / 20.0F)));
  assert(host.SetTransport(1, false, 0));
  std::array<float, 128> silence{}, left{}, right{};
  const std::array<const float*, 2> input{silence.data(), silence.data()};
  const std::array<float*, 2> output{left.data(), right.data()};
  assert(host.StartOffline());
  for (unsigned block = 0; block < 4; ++block) assert(host.ProcessPlanar(input, output, 128));
  host.Stop();
  UploadInstrument(host, 2, pcm);
  // Releasing/recreating slot 2 advances its core generation, not its wire ID.
  assert(host.PrepareGraphRevision(10, graph(10)).code == GraphRevisionStatusCode::kPrepared);
  assert(host.ConfigureInstrumentStates(batch));
  assert(host.PublishGraphRevision(10).code == GraphRevisionStatusCode::kPublished);
  assert(host.RetireGraphRevision(9).code == GraphRevisionStatusCode::kRetired);
  // The deferred release of asset 1 now completes when its last owner leaves.
  assert(host.instrumentLockedBytes() == locked && host.ReleaseAsset(2));
  assert(host.diagnostics().installed_assets == 1);
  host.Teardown();
  assert(host.instrumentLockedBytes() == 0);
}

void MeasureInstrumentValidation() {
  using namespace daw::audio_host_macos;
  AudioHost host;
  assert(host.Configure({.device_uid = "offline:render", .sample_rate_hz = 48000,
    .max_frames_per_block = 8192, .channel_count = 2, .revision = 1}));
  UploadInstrument(host, 1, SampleInstrumentPcm());
  std::vector<std::pair<std::uint64_t, std::uint32_t>> nodes;
  for (unsigned node = 1; node <= 63; ++node) nodes.emplace_back(node, 0);
  auto graph = FanInGraphSnapshot(1, nodes);
  for (unsigned index = 1; index <= 63; ++index) {
    const auto offset = 12 + 24 + index * 132;
    WriteLeU32(graph, offset + 8, 2); // Portable graph envelope instrument kind.
    WriteLeU32(graph, offset + 28, DAW_AUDIO_INSTRUMENT_KIND_SAMPLER);
    WriteLeU32(graph, offset + 32, 1);
    WriteLeU32(graph, offset + 36, 32);
  }
  assert(host.PrepareGraphRevision(1, graph).code == GraphRevisionStatusCode::kPrepared);
  auto record = SampleInstrumentPayload(2);
  const auto zone_start = 28 + daw::audio_core_wire::kSamplerStateBytes;
  const std::vector<std::uint8_t> zone(record.begin() + zone_start, record.end());
  WriteLeU32(record, 32, DAW_AUDIO_CORE_MAX_SAMPLE_ZONES);
  WriteLeU32(record, 20, DAW_AUDIO_CORE_MAX_SAMPLE_ZONES * zone.size());
  for (unsigned index = 1; index < DAW_AUDIO_CORE_MAX_SAMPLE_ZONES; ++index)
    record.insert(record.end(), zone.begin(), zone.end());
  std::vector<std::uint8_t> payload;
  AppendLeU32(payload, 64);
  for (unsigned index = 0; index < 64; ++index) {
    WriteLeU32(record, 4, index % 63 + 1);
    payload.insert(payload.end(), record.begin() + 4, record.end());
  }
  measure_validation = true;
  double total_ms = 0, worst_ms = 0;
  for (unsigned iteration = 0; iteration < 20; ++iteration) {
    const auto start = std::chrono::steady_clock::now();
    assert(host.ConfigureInstrumentStates(payload));
    const auto ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
    total_ms += ms;
    worst_ms = std::max(worst_ms, ms);
  }
  measure_validation = false;
  std::printf("Phase2 validation: records=64 zones=2048 iterations=20 mean_ms=%.3f worst_ms=%.3f peak_heap_added=%llu peak_resident_added=%llu\n",
    total_ms / 20, worst_ms, static_cast<unsigned long long>(validation_heap_peak),
    static_cast<unsigned long long>(validation_resident_peak));
  host.Teardown();
}

void TestPagedInstrumentOutput(const std::uint32_t kind, const float position = 0.98F, const float reverse = 1,
  const bool offline = false) {
  using namespace daw::audio_host_macos;
  AudioHost paged;
  const auto pcm = SampleInstrumentPcm();
  // A direct core reference reads the original contiguous vector, with no
  // host mapping/page transfer and no legacy host install-size restriction.
  daw_audio_core_handle reference = 0;
  const daw_audio_core_config config{.abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .max_frames_per_block = 128, .max_channels = 2, .max_assets = 1, .sample_rate_hz = 48000};
  assert(daw_audio_core_create(&config, &reference) == DAW_AUDIO_CORE_OK);
  const std::array<const float*, 2> planes{pcm.data(), pcm.data() + kInstrumentFixtureFrames};
  const daw_audio_asset_descriptor descriptor{.abi_version = DAW_AUDIO_CORE_ABI_VERSION, .revision = 1,
    .byte_length = pcm.size() * sizeof(float), .content_hash_prefix = 0,
    .frame_count = kInstrumentFixtureFrames, .sample_rate_hz = 48000, .channel_count = 2, .planes = planes.data()};
  daw_audio_asset_handle asset = 0;
  assert(daw_audio_core_create_asset(reference, &descriptor, &asset) == DAW_AUDIO_CORE_OK);
  const auto graph = SampleInstrumentGraph(1, kind);
  assert(daw_audio_core_prepare_graph_bytes(reference, graph.data() + 12,
    static_cast<std::uint32_t>(graph.size() - 12)) == DAW_AUDIO_CORE_OK);
  if (kind == DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) {
    const daw_audio_granular_state state{.version = 1, .asset = asset, .seed = 1, .max_grains = 16,
      .window_shape = DAW_AUDIO_GRANULAR_WINDOW_HANN, .freeze = 0, .grain_size_ms = 100, .density_hz = 10,
      .position = position, .spray = 0.8F, .pitch_semitones = 0, .reverse_probability = reverse, .stereo_spread = 0};
    assert(daw_audio_core_configure_granular(reference, 1, &state) == DAW_AUDIO_CORE_OK);
  } else {
    const auto payload = SampleInstrumentPayload(kind);
    daw_audio_sampler_state state{};
    daw_audio_sample_zone zone{};
    assert(daw::audio_core_wire::DecodeSamplerState(
      std::span(payload).subspan(28, daw::audio_core_wire::kSamplerStateBytes), &state));
    assert(daw::audio_core_wire::DecodeSampleZone(
      std::span(payload).subspan(28 + daw::audio_core_wire::kSamplerStateBytes), &zone));
    zone.asset = asset;
    assert(daw_audio_core_configure_sampler(reference, 1, &state, &zone) == DAW_AUDIO_CORE_OK);
  }
  assert(daw_audio_core_publish(reference, 1) == DAW_AUDIO_CORE_OK);
  const daw_audio_transport_state transport{.epoch = 1, .running = 1, .frame = 0};
  assert(daw_audio_core_set_transport(reference, &transport) == DAW_AUDIO_CORE_OK);
  {
    auto* host = &paged;
    assert(host->Configure({.device_uid = offline ? "offline:render" : "diagnostic", .sample_rate_hz = 48000,
      .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
    // A distinct, fully installed timeline asset occupies the first host core
    // slot. The oracle below still expects the instrument's stable session ID.
    UploadInstrument(*host, 2, SampleInstrumentPcm(-2.0F));
    UploadInstrument(*host, 1, pcm);
    assert(host->PrepareGraphRevision(1, SampleInstrumentGraph(1, kind)).code == GraphRevisionStatusCode::kPrepared);
    assert(host->ConfigureInstrumentStates(SampleInstrumentPayload(kind, 1, false, position, reverse)));
    assert(host->PublishGraphRevision(1).code == GraphRevisionStatusCode::kPublished);
    assert(host->ReleaseAsset(1)); // Deferred while configured, before any voice exists.
    assert(host->diagnostics().installed_assets == 2);
    assert(host->SetTransport(1, false, 0));
    auto note = UrgentTransportRelease(1);
    WriteLeU32(note, 36, static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOn));
    WriteLeU32(note, 44, 60);
    const float velocity = 0.8F;
    std::memcpy(note.data() + 48, &velocity, sizeof(velocity));
    assert(host->QueueInstrumentEvents(note));
    assert(host->StartOffline());
    assert(host->SetTransport(1, true, 0));
  }
  std::array<float, 128> left{}, right{}, reference_left{}, reference_right{};
  std::array<float, 128> silence{};
  const std::array<const float*, 2> input{silence.data(), silence.data()};
  const std::array<float*, 2> output{left.data(), right.data()};
  const std::array<float*, 2> expected{reference_left.data(), reference_right.data()};
  bool audible = false;
  const daw_audio_instrument_event note{.node_id = 1, .note_id = 1, .sequence = 1, .epoch = 1,
    .frame_offset = 0, .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON, .channel = 0, .note = 60, .value = 0.8F};
  for (unsigned block = 0; block < 128; ++block) {
    assert(paged.ProcessPlanar(input, output, 128));
    const daw_audio_core_process_block reference_block{.abi_version = DAW_AUDIO_CORE_ABI_VERSION,
      .frame_count = 128, .channel_count = 2, .input_bus_count = 1, .inputs = input.data(), .outputs = expected.data(),
      .graph_revision = 1, .transport_epoch = 1, .instrument_event_count = block == 0 ? 1U : 0U,
      .instrument_events = block == 0 ? &note : nullptr};
    assert(daw_audio_core_process(reference, &reference_block) == DAW_AUDIO_CORE_OK);
    for (unsigned frame = 0; frame < 128; ++frame) {
      assert(std::isfinite(left[frame]) && std::isfinite(right[frame]));
      assert(left[frame] == reference_left[frame] && right[frame] == reference_right[frame]);
      audible = audible || left[frame] != 0 || right[frame] != 0;
    }
  }
  assert(audible);
  assert(offline ? paged.instrumentLockedBytes() == 0 : paged.instrumentLockedBytes() != 0);
  assert(paged.ReleaseAsset(1)); // Deferred: voice/grain and configured ownership.
  paged.Stop();
  daw_audio_core_destroy(reference);
  assert(paged.PrepareGraphRevision(2, SampleInstrumentGraph(2, kind)).code == GraphRevisionStatusCode::kPrepared);
  const auto bytes = paged.instrumentLockedBytes();
  assert(paged.ConfigureInstrumentStates(SampleInstrumentPayload(kind)));
  assert(paged.instrumentLockedBytes() == bytes); // Replacement shares the mapping.
  assert(paged.PublishGraphRevision(2).code == GraphRevisionStatusCode::kPublished);
  assert(paged.ReleaseAsset(1)); // Deferred: retired revision still owns it.
  assert(paged.RetireGraphRevision(1).code == GraphRevisionStatusCode::kRetired);
  assert(paged.PrepareGraphRevision(3, SampleInstrumentGraph(3, kind)).code == GraphRevisionStatusCode::kPrepared);
  auto empty = kind == DAW_AUDIO_INSTRUMENT_KIND_GRANULAR ? EmptyGranularStatePayload() : SampleInstrumentPayload(kind);
  if (kind != DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) {
    WriteLeU32(empty, 20, 0);
    WriteLeU32(empty, 32, 0);
    empty.resize(28 + daw::audio_core_wire::kSamplerStateBytes);
  }
  assert(paged.ConfigureInstrumentStates(empty));
  assert(paged.PublishGraphRevision(3).code == GraphRevisionStatusCode::kPublished);
  assert(paged.ReleaseAsset(1)); // Deferred: old owner retained after last owner is cleared.
  assert(paged.RetireGraphRevision(2).code == GraphRevisionStatusCode::kRetired);
  assert(paged.StartOffline());
  for (unsigned block = 0; block < 128; ++block) assert(paged.ProcessPlanar(input, output, 128));
  paged.Stop();
  assert(paged.ReleaseAsset(1));
  assert(paged.instrumentLockedBytes() == 0);
  paged.Teardown();
  assert(paged.instrumentLockedBytes() == 0);
}

void TestDrumRackPadsUseTheirOwnAssets() {
  using namespace daw::audio_host_macos;
  AudioHost host;
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  UploadInstrument(host, 3, SampleInstrumentPcm(-2.0F));
  UploadInstrument(host, 1, SampleInstrumentPcm());
  UploadInstrument(host, 2, SampleInstrumentPcm(-1.0F));
  assert(host.PrepareGraphRevision(1, SampleInstrumentGraph(1, DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK)).code
    == GraphRevisionStatusCode::kPrepared);
  auto state = SampleInstrumentPayload(DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK, 1, true);
  constexpr std::size_t zones_offset = 28 + daw::audio_core_wire::kSamplerStateBytes;
  constexpr std::size_t zone_bytes = daw::audio_core_wire::kSampleZoneBytes;
  // Pad 0 is MIDI 60 and pad 1 is MIDI 61; their PCM has opposite polarity.
  WriteLeU32(state, zones_offset + zone_bytes + 8, 61);
  WriteLeU32(state, zones_offset + zone_bytes + 12, 61);
  WriteLeU32(state, zones_offset + zone_bytes + 16, 61);
  assert(host.ConfigureInstrumentStates(state));
  const auto resident_bytes = host.instrumentLockedBytes();
  assert(resident_bytes >= 2 * SampleInstrumentPcm().size() * sizeof(float));
  assert(host.PublishGraphRevision(1).code == GraphRevisionStatusCode::kPublished);
  // A latency change keeps the core and resident assets. Reinstalling the same
  // wire state must still resolve the correct session asset handles.
  const auto rebuilt = host.PrepareGraphRevision(2,
    SampleInstrumentLatencyGraph(2, DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK, 1));
  assert(rebuilt.code == GraphRevisionStatusCode::kPrepared);
  assert(rebuilt.continuity == GraphRevisionContinuity::kAccepted);
  assert(host.ConfigureInstrumentStates(state));
  assert(host.instrumentLockedBytes() == resident_bytes);
  assert(host.PublishGraphRevision(2).code == GraphRevisionStatusCode::kPublished);
  assert(host.RetireGraphRevision(1).code == GraphRevisionStatusCode::kRetired);
  assert(host.SetTransport(1, false, 0));
  assert(host.StartOffline());
  assert(host.SetTransport(1, true, 0));
  std::array<float, 128> silence{}, left{}, right{};
  const std::array<const float*, 2> input{silence.data(), silence.data()};
  const std::array<float*, 2> output{left.data(), right.data()};
  const auto render_pad = [&](const std::uint32_t note, const bool positive) {
    auto event = UrgentTransportRelease(1);
    WriteLeU32(event, 36, static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOn));
    WriteLeU32(event, 44, note);
    const float velocity = 0.8F;
    std::memcpy(event.data() + 48, &velocity, sizeof(velocity));
    assert(host.QueueInstrumentEvents(event));
    float sum = 0;
    for (unsigned block = 0; block < 8; ++block) {
      assert(host.ProcessPlanar(input, output, 128));
      for (const float sample : left) sum += sample;
    }
    assert(positive ? sum > 0.01F : sum < -0.01F);
    auto release = UrgentTransportRelease(1);
    WriteLeU32(release, 36, static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOff));
    WriteLeU32(release, 44, note);
    assert(host.QueueInstrumentEvents(release));
    for (unsigned block = 0; block < 8; ++block) assert(host.ProcessPlanar(input, output, 128));
  };
  render_pad(60, true);
  render_pad(61, false);
  assert(host.ReleaseAsset(1) && host.ReleaseAsset(2));
  host.Stop();
  assert(host.PrepareGraphRevision(3, SampleInstrumentGraph(3, DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK)).code
    == GraphRevisionStatusCode::kPrepared);
  auto empty = SampleInstrumentPayload(DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK);
  WriteLeU32(empty, 20, 0);
  WriteLeU32(empty, 32, 0);
  empty.resize(28 + daw::audio_core_wire::kSamplerStateBytes);
  assert(host.ConfigureInstrumentStates(empty));
  assert(host.PublishGraphRevision(3).code == GraphRevisionStatusCode::kPublished);
  assert(host.RetireGraphRevision(2).code == GraphRevisionStatusCode::kRetired);
  host.Teardown();
  assert(host.instrumentLockedBytes() == 0);
  assert(host.ReleaseAsset(1) && host.ReleaseAsset(2) && host.ReleaseAsset(3));
  assert(host.ReleaseAsset(1) && host.ReleaseAsset(2) && host.ReleaseAsset(3));
  assert(host.instrumentLockedBytes() == 0);
}

void TestMappedAssetWrittenRangeLedgerIsBounded() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48'000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  const auto range_count = daw::audio_host_macos::kMaximumMappedAssetWrittenRanges + 1;
  assert(host.CreateMappedAsset(1, range_count * 2, 48'000, 1, 0));
  for (std::size_t index = 0; index < range_count - 1; ++index) {
    const std::array<float, 1> sample{static_cast<float>(index)};
    assert(host.WriteMappedAssetPage(1, index * 2, 1, sample));
  }
  const std::array<float, 1> overflow{1.F};
  assert(!host.WriteMappedAssetPage(1, (range_count - 1) * 2, 1, overflow));
  assert(host.assetOperationError() == "asset-page-capacity-exceeded");
  assert(host.PrepareMappedAssetRange(1, 0, 1));
  assert(!host.PrepareMappedAssetRange(1, (range_count - 1) * 2, 1));
  assert(host.ReleaseAsset(1));
}

void TestNativeVstRuntimeControlBounds() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  constexpr std::string_view instance_id = "b0c4db1e-bd48-46d4-a4bc-f5ad1fe6c6f1";
  daw::audio_host_macos::NativeVstAttachment attachment{
    .graph_node_id = 17,
    .instance_id = std::string(instance_id),
    .class_id = "class-id",
    .vendor_id = "vendor-id",
    .canonical_bundle_path = "/private/catalog/Example.vst3",
    .canonical_executable_path = "/private/catalog/Example.vst3/Contents/MacOS/Example",
    .architecture = 1,
    .scanner_catalog_version = 2,
    .role = daw::audio_host_macos::NativeVstRole::kEffect,
    .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .transport_latency_frames = 4,
    .playback_enabled = true,
    .transport = {.slot_count = 2, .maximum_frames = 4, .input_channels = 2, .output_channels = 2, .maximum_events_per_block = 2},
  };
  attachment.bundle_fingerprint.fill(1);
  attachment.binary_fingerprint.fill(2);
  attachment.parameter_ids = {7, 8};
  assert(host.AttachNativeVst(attachment));
  std::vector<std::uint8_t> malformed_state_request{0};
  assert(!host.GetNativeVstState(malformed_state_request));
  std::vector<std::uint8_t> unknown_state_request;
  AppendInstanceId(unknown_state_request, "c0c4db1e-bd48-46d4-a4bc-f5ad1fe6c6f2");
  assert(!host.GetNativeVstState(unknown_state_request));
  const auto ownedButNotReady = host.ExecuteNativeVstEditorCommand(
    instance_id,
    daw::audio_host_macos::NativeVstEditorCommand::kStatus
  );
  assert(ownedButNotReady && ownedButNotReady->owned && !ownedButNotReady->success);
  assert(!host.ExecuteNativeVstEditorCommand(
    "c0c4db1e-bd48-46d4-a4bc-f5ad1fe6c6f2",
    daw::audio_host_macos::NativeVstEditorCommand::kStatus
  ));
  std::vector<std::uint8_t> unknown_parameter;
  AppendInstanceId(unknown_parameter, instance_id);
  AppendLeU32(unknown_parameter, 2);
  AppendLeU32(unknown_parameter, 7);
  AppendLeU32(unknown_parameter, 0);
  AppendLeDouble(unknown_parameter, 0.25);
  AppendLeU32(unknown_parameter, 9);
  AppendLeU32(unknown_parameter, 0);
  AppendLeDouble(unknown_parameter, 0.5);
  assert(!host.QueueNativeVstParameterEvents(unknown_parameter));
  std::vector<std::uint8_t> parameters;
  AppendInstanceId(parameters, instance_id);
  AppendLeU32(parameters, 2);
  AppendLeU32(parameters, 7);
  AppendLeU32(parameters, 1);
  AppendLeDouble(parameters, 0.25);
  AppendLeU32(parameters, 8);
  AppendLeU32(parameters, 3);
  AppendLeDouble(parameters, 1.0);
  assert(host.QueueNativeVstParameterEvents(parameters));
  std::vector<std::uint8_t> unknown_reenable_instance;
  AppendInstanceId(unknown_reenable_instance, "c0c4db1e-bd48-46d4-a4bc-f5ad1fe6c6f2");
  AppendLeU32(unknown_reenable_instance, 1);
  AppendLeU32(unknown_reenable_instance, 7);
  assert(!host.ReenableVstScheduleAutomation(unknown_reenable_instance));
  std::vector<std::uint8_t> unknown_reenable_parameter;
  AppendInstanceId(unknown_reenable_parameter, instance_id);
  AppendLeU32(unknown_reenable_parameter, 1);
  AppendLeU32(unknown_reenable_parameter, 9);
  assert(!host.ReenableVstScheduleAutomation(unknown_reenable_parameter));
  std::vector<std::uint8_t> reenable_parameter;
  AppendInstanceId(reenable_parameter, instance_id);
  AppendLeU32(reenable_parameter, 1);
  AppendLeU32(reenable_parameter, 7);
  assert(host.ReenableVstScheduleAutomation(reenable_parameter));
  parameters.back() = 0x40;
  assert(!host.QueueNativeVstParameterEvents(parameters));
  std::vector<std::uint8_t> midi;
  AppendInstanceId(midi, instance_id);
  AppendLeU32(midi, 1);
  AppendLeU32(midi, 3);
  midi.insert(midi.end(), {0x90, 60, 100, 0});
  assert(host.QueueNativeVstMidiEvents(midi));
  midi.back() = 1;
  assert(!host.QueueNativeVstMidiEvents(midi));
  std::vector<std::uint8_t> invalid_state;
  AppendInstanceId(invalid_state, instance_id);
  AppendLeU32(invalid_state, 1);
  AppendLeU32(invalid_state, 64);
  invalid_state.insert(invalid_state.end(), 65, 0);
  assert(!host.SetNativeVstState(invalid_state));
}

void TestNativeVstWatchdogStartupGrace() {
  std::uint64_t missed_frames = 0;
  std::uint32_t missed_callbacks = 0;
  assert(!daw::audio_host_macos::detail::NativeVstWatchdogShouldMiss(
    false, 48'000, 23'999, missed_frames, missed_callbacks
  ));
  assert(daw::audio_host_macos::detail::NativeVstWatchdogShouldMiss(
    false, 48'000, 1, missed_frames, missed_callbacks
  ));

  missed_frames = 0;
  missed_callbacks = 0;
  assert(!daw::audio_host_macos::detail::NativeVstWatchdogShouldMiss(
    true, 48'000, 512, missed_frames, missed_callbacks
  ));
  assert(!daw::audio_host_macos::detail::NativeVstWatchdogShouldMiss(
    true, 48'000, 512, missed_frames, missed_callbacks
  ));
  assert(daw::audio_host_macos::detail::NativeVstWatchdogShouldMiss(
    true, 48'000, 512, missed_frames, missed_callbacks
  ));
}

void TestRealtimeDurationHistogramBucketsAreBounded() {
  using daw::audio_host_macos::detail::RealtimeDurationHistogramBucket;
  assert(RealtimeDurationHistogramBucket(0) == 0);
  assert(RealtimeDurationHistogramBucket(1) == 0);
  assert(RealtimeDurationHistogramBucket(2) == 1);
  assert(RealtimeDurationHistogramBucket(1ULL << 20U) == 20);
  assert(RealtimeDurationHistogramBucket(std::numeric_limits<std::uint64_t>::max()) == 31);
}

void TestNativeSessionWireRejectsMalformedFramesAndEvents() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  const std::array<std::uint8_t, 4> empty_events{0, 0, 0, 0};
  assert(host.QueueParameterEvents(empty_events));
  assert(host.QueueInstrumentEvents(empty_events));
  assert(host.QueueSourceEvents(empty_events));
  std::array<std::uint8_t, 112> source_before_install{};
  source_before_install[0] = 1;
  source_before_install[24] = 1;
  assert(!host.QueueSourceEvents(source_before_install));
  const std::array<float, 8> samples{};
  assert(host.InstallAsset(1, 4, 48000, 2, 0, samples));
  std::vector<std::uint8_t> invalid_curve_source;
  AppendLeU32(invalid_curve_source, 1);
  AppendLeU32(invalid_curve_source, 1);
  AppendLeU64(invalid_curve_source, 1);
  AppendLeU64(invalid_curve_source, 0);
  AppendLeU32(invalid_curve_source, 1);
  AppendLeU64(invalid_curve_source, 0);
  AppendLeU64(invalid_curve_source, 4);
  AppendLeU64(invalid_curve_source, 0);
  AppendLeU64(invalid_curve_source, 4);
  AppendLeFloat(invalid_curve_source, 1.0F);
  AppendLeU64(invalid_curve_source, 0);
  AppendLeU64(invalid_curve_source, 0);
  AppendLeU64(invalid_curve_source, 4);
  AppendLeU64(invalid_curve_source, 4);
  AppendLeFloat(invalid_curve_source, 0.0F);
  AppendLeFloat(invalid_curve_source, NAN);
  AppendLeFloat(invalid_curve_source, 0.5F);
  AppendLeFloat(invalid_curve_source, 0.0F);
  AppendLeFloat(invalid_curve_source, 0.5F);
  assert(!host.QueueSourceEvents(invalid_curve_source));
  std::array<std::uint8_t, 228> mixed_source_events{};
  mixed_source_events[0] = 2;
  mixed_source_events[24] = 1;
  mixed_source_events[116] = 2;
  assert(!host.QueueSourceEvents(mixed_source_events));
  assert(host.ReleaseAsset(1));
  const std::array<std::uint8_t, 12> empty_graph{};
  assert(!host.PrepareAndPublishGraph(1, empty_graph));
  const std::array<std::uint8_t, 5> malformed_events{1, 0, 0, 0, 0};
  assert(!host.QueueParameterEvents(malformed_events));
}

void TestScheduledProcessorSetUsesAbsoluteFrame() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48'000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  assert(host.PrepareAndPublishGraph(2, GraphSnapshot(2, 1.0F, 0, true)));
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  assert(host.SetTransport(1, true, 0));
  assert(host.QueueScheduleWindow(ScheduleProcessorSetWindow(
    2, 1, 1, 0, 4, 77, DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB, 2, -6.0F
  )));
  std::array<float, 4> left{{1.0F, 1.0F, 1.0F, 1.0F}};
  std::array<float, 4> right = left;
  std::array<float, 4> out_left{};
  std::array<float, 4> out_right{};
  const std::array<const float*, 2> input{{left.data(), right.data()}};
  const std::array<float*, 2> output{{out_left.data(), out_right.data()}};
  assert(host.ProcessPlanar(input, output, 4));
  assert(host.diagnostics().rejected_blocks == 0);
  host.Stop();
}

// Renders constant-one input through a utility whose gain ramps 0 to -6 dB over `ramp_frames`, in
// callbacks of `block_frames`, and returns the output gain per frame.
std::vector<float> RenderProcessorRamp(
  const std::uint32_t block_frames, const std::uint64_t ramp_frames, const std::vector<ProcessorRecord>& records
) {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48'000,
    .max_frames_per_block = block_frames, .channel_count = 2, .revision = 1}));
  assert(host.PrepareAndPublishGraph(2, GraphSnapshot(2, 1.0F, 0, true)));
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  assert(host.SetTransport(1, true, 0));
  const std::uint64_t window_end = (ramp_frames / block_frames + 2) * block_frames;
  assert(host.QueueScheduleWindow(ScheduleProcessorRecordsWindow(1, 0, window_end, records)));
  std::vector<float> ones(block_frames, 1.0F), left(block_frames), right(block_frames), gain;
  const std::array<const float*, 2> input{{ones.data(), ones.data()}};
  const std::array<float*, 2> output{{left.data(), right.data()}};
  for (std::uint64_t frame = 0; frame < window_end; frame += block_frames) {
    assert(host.ProcessPlanar(input, output, block_frames));
    gain.insert(gain.end(), left.begin(), left.end());
  }
  assert(host.diagnostics().rejected_blocks == 0);
  host.Stop();
  return gain;
}

void TestScheduledProcessorRampExpandsAtAdaptiveStride() {
  constexpr std::uint64_t kRampFrames = 2'400;  // 50 ms at 48 kHz
  const auto ideal = [](const std::uint64_t frame) {
    return std::pow(10.0, -6.0 * static_cast<double>(frame) / kRampFrames / 20.0);
  };
  double largest_ideal_step = 0.0;
  for (std::uint64_t frame = 1; frame < kRampFrames; ++frame)
    largest_ideal_step = std::max(largest_ideal_step, std::abs(ideal(frame) - ideal(frame - 1)));
  // One ramp at 512 frames needs stride 4 to fit the cap less VST headroom; at 128 frames stride 1 fits.
  for (const auto [block_frames, stride] : {std::pair{512U, 4U}, std::pair{128U, 1U}}) {
    const auto gain = RenderProcessorRamp(block_frames, kRampFrames, {
      {0, kRampFrames, 0.0F, -6.0F}, {kRampFrames, kRampFrames, -6.0F, -6.0F}});
    double largest_step = 0.0, error = 0.0, signal = 0.0;
    for (std::uint64_t frame = 0; frame < kRampFrames; ++frame) {
      if (frame > 0) largest_step = std::max(largest_step, std::abs(double{gain[frame]} - gain[frame - 1]));
      error += std::pow(gain[frame] - ideal(frame), 2);
      signal += std::pow(ideal(frame), 2);
    }
    std::fprintf(stderr, "ramp block=%u largest_step/ideal=%g snr_db=%g\n", block_frames,
      largest_step / largest_ideal_step, 10.0 * std::log10(signal / error));
    assert(largest_step <= stride * largest_ideal_step * 1.01);
    assert(10.0 * std::log10(signal / error) >= 60.0);
    assert(std::abs(gain[kRampFrames] - ideal(kRampFrames)) < 1e-6);
  }
}

void TestScheduledProcessorRampsStayWithinBlockCap() {
  constexpr std::uint64_t kRampFrames = 2'400;
  std::vector<ProcessorRecord> records;
  // Four overlapping ramps and a set on every fourth frame of the first block: 128 fixed events.
  for (std::uint64_t index = 0; index < 4; ++index) records.push_back({index, kRampFrames + index, 0.0F, -6.0F});
  for (std::uint64_t frame = 8; frame < 512; frame += 4) records.push_back({frame, frame, -3.0F, -3.0F});
  std::stable_sort(records.begin(), records.end(), [](const auto& left, const auto& right) { return left.frame < right.frame; });
  const auto gain = RenderProcessorRamp(512, kRampFrames, records);
  // The helper asserts no rejected block; the ramps still descend after the sets.
  assert(gain[2'300] < gain[1'000] && gain[2'300] > std::pow(10.0F, -6.0F / 20.0F));
}


void TestScheduleWindowCompletionSemantics() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  assert(host.PrepareAndPublishGraph(2, GraphSnapshot(2, 1.0F)));
  assert(host.SetTransport(1, false, 0));

  assert(host.QueueScheduleWindow(ScheduleWindow(2, 1, 1, 0, 4, 0, 2, false)));
  assert(host.QueueScheduleWindow(ScheduleWindow(2, 1, 1, 0, 4, 1, 2, false)));
  assert(host.QueueScheduleWindow(ScheduleWindow(2, 1, 2, 4, 8, 0, 1, false)));
  assert(host.QueueScheduleWindow(ScheduleWindow(2, 1, 3, 8, 12, 0, 1, true)));
  assert(host.QueueScheduleWindow(ScheduleWindow(2, 1, 3, 8, 12, 0, 1, true)));
  assert(!host.QueueScheduleWindow(ScheduleWindow(2, 1, 4, 12, 16, 0, 1, false)));
  host.Stop();

  daw::audio_host_macos::AudioHost invalid;
  assert(invalid.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  assert(invalid.PrepareAndPublishGraph(2, GraphSnapshot(2, 1.0F)));
  assert(invalid.SetTransport(1, false, 0));
  assert(!invalid.QueueScheduleWindow(ScheduleWindow(2, 1, 1, 0, 4, 0, 2, true)));
  assert(invalid.scheduleWindowError() == "invalid schedule header, revision, epoch or limits");
  assert(invalid.QueueScheduleWindow(ScheduleWindow(2, 1, 1, 0, 4, 0, 2, false)));
  assert(invalid.scheduleWindowError().empty());
  assert(invalid.QueueScheduleWindow(ScheduleWindow(2, 1, 1, 0, 4, 1, 2, false)));
  invalid.Stop();
}

void TestScheduleWindowRollback() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  assert(host.PrepareAndPublishGraph(2, InstrumentGraphSnapshot(2)));
  assert(host.SetTransport(1, false, 0));

  assert(host.QueueScheduleWindow(
    ScheduleInstrumentWindow(2, 1, 1, 0, 4, 0, 2, false, 1)
  ));
  auto malformed = ScheduleInstrumentWindow(2, 1, 1, 0, 4, 1, 2, true, 2);
  malformed.pop_back();
  assert(!host.QueueScheduleWindow(malformed));
  assert(host.QueueScheduleWindow(
    ScheduleInstrumentWindow(2, 1, 1, 0, 4, 1, 2, true, 1)
  ));
  host.Stop();
}

void TestMixedInstrumentSequenceDomains(const bool reject_first = false, const bool reject_instrument = false) {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  assert(host.PrepareGraphRevision(1, InstrumentGraphSnapshot(1)).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  assert(host.ConfigureInstrumentStates(PackedSynthStatePayload(0.5F)));
  assert(host.PublishGraphRevision(1).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kPublished);
  assert(host.SetTransport(1, false, 0));
  auto scheduled = ScheduleInstrumentWindow(1, 1, 1, 0, 1024, 0, 1, true, 1);
  WriteLeU32(scheduled, 72, 1);
  WriteLeU32(scheduled, 72 + 28, 64);
  if (reject_instrument) {
    auto rejected_note = scheduled;
    WriteLeU32(rejected_note, 100, 32);
    WriteLeU32(scheduled, 88, 2);
    scheduled.insert(scheduled.begin() + 72, rejected_note.begin() + 72, rejected_note.end());
    WriteLeU32(scheduled, 44, 2);
  }
  assert(host.QueueScheduleWindow(scheduled));
  auto live = UrgentTransportRelease(1);
  for (std::size_t index = 0; index < 8; ++index) {
    live[20 + index] = static_cast<std::uint8_t>(1'000'000ULL >> (8 * index));
  }
  WriteLeU32(live, 36, DAW_AUDIO_INSTRUMENT_EVENT_PARAMETER);
  WriteLeU32(live, 44, DAW_AUDIO_SYNTH_PARAMETER_FILTER_CUTOFF_HZ);
  const float cutoff = 913;
  std::memcpy(live.data() + 48, &cutoff, sizeof(cutoff));
  assert(host.QueueInstrumentEvents(live));
  if (reject_first) {
    // The host accepts the wire shape, but this nonexistent processor makes
    // core validation reject before any instrument is applied.
    std::vector<std::uint8_t> invalid_processor;
    AppendLeU32(invalid_processor, 1);
    AppendLeU64(invalid_processor, 999);
    AppendLeU32(invalid_processor, 1);
    AppendLeU32(invalid_processor, 0);
    AppendLeFloat(invalid_processor, 0.5F);
    assert(host.QueueParameterEvents(invalid_processor));
  }
  assert(host.StartOffline());
  assert(host.SetTransport(1, true, 0));
  std::array<float, 128> left{}, right{}, output_left{}, output_right{};
  const std::array<const float*, 2> input{left.data(), right.data()};
  const std::array<float*, 2> output{output_left.data(), output_right.data()};
  if (reject_first) {
    assert(!host.ProcessPlanar(input, output, 128));
    assert(host.appliedUrgentSequence() == 0);
    assert(host.diagnostics().last_rejected_reason == daw::audio_host_macos::RejectedBlockReason::kCoreProcess);
  }
  const auto rejections_before = injected_event_rejections;
  if (reject_instrument) injected_event_index = 1; // Cutoff, rejected note, valid note.
  const bool first = host.ProcessPlanar(input, output, 128);
  if (reject_instrument) assert(injected_event_rejections == rejections_before + 1);
  std::fprintf(stderr, "mixed sequence domains: processed=%d rejected=%llu urgent=%llu\n",
    first, static_cast<unsigned long long>(host.diagnostics().rejected_blocks),
    static_cast<unsigned long long>(host.appliedUrgentSequence()));
  assert(first);
  assert(host.appliedUrgentSequence() == 1'000'000);
  assert(host.diagnostics().rejected_blocks == (reject_first ? 1 : 0));
  float energy = 0;
  for (std::size_t frame = 0; frame < 64; ++frame) assert(output_left[frame] == 0);
  for (std::size_t frame = 64; frame < 128; ++frame) energy += std::abs(output_left[frame]);
  assert(energy > 0);
  // Compare against a synth compiled with the requested cutoff, proving the
  // parameter applied as well as the scheduled note (not just its ack).
  daw::audio_host_macos::AudioHost reference;
  assert(reference.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  assert(reference.PrepareGraphRevision(1, InstrumentGraphSnapshot(1)).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  auto reference_state = PackedSynthStatePayload(0.5F);
  std::memcpy(reference_state.data() + 28 + 72, &cutoff, sizeof(cutoff));
  assert(reference.ConfigureInstrumentStates(reference_state));
  assert(reference.PublishGraphRevision(1).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kPublished);
  assert(reference.SetTransport(1, false, 0));
  if (reject_instrument) {
    scheduled.erase(scheduled.begin() + 72, scheduled.begin() + 120);
    WriteLeU32(scheduled, 44, 1);
  }
  assert(reference.QueueScheduleWindow(scheduled));
  assert(reference.StartOffline());
  assert(reference.SetTransport(1, true, 0));
  std::array<float, 128> reference_left{}, reference_right{};
  const std::array<float*, 2> reference_output{reference_left.data(), reference_right.data()};
  assert(reference.ProcessPlanar(input, reference_output, 128));
  // The live cutoff moves the applied value over a few milliseconds instead of stepping
  // it, so the first block cannot equal the compiled reference. After the slew has
  // settled (40 blocks, far past 5 ms) the output must, and no sample may step by more
  // than the reference does.
  float host_step = 0;
  float reference_step = 0;
  for (unsigned block = 1; block < 40; ++block) {
    const float host_before = output_left[127];
    const float reference_before = reference_left[127];
    assert(host.ProcessPlanar(input, output, 128));
    assert(reference.ProcessPlanar(input, reference_output, 128));
    host_step = std::max(host_step, std::abs(output_left[0] - host_before));
    reference_step = std::max(reference_step, std::abs(reference_left[0] - reference_before));
    for (std::size_t frame = 1; frame < 128; ++frame) {
      host_step = std::max(host_step, std::abs(output_left[frame] - output_left[frame - 1]));
      reference_step = std::max(reference_step, std::abs(reference_left[frame] - reference_left[frame - 1]));
    }
  }
  float settled_energy = 0;
  for (std::size_t frame = 0; frame < 128; ++frame) {
    settled_energy += std::abs(reference_left[frame]);
    assert(std::abs(output_left[frame] - reference_left[frame]) < 1e-4F);
    assert(std::abs(output_right[frame] - reference_right[frame]) < 1e-4F);
  }
  assert(settled_energy > 0);
  assert(host_step <= reference_step * 1.05F + 1e-6F);
  reference.Stop();
  host.Stop();
}

// Reuse r22's exact-audio recovery reference, now with indexed fault injection.
void TestPermanentInstrumentRejectionRecovers() {
  TestMixedInstrumentSequenceDomains(false, true);
}

// R24: a full live burst must not stall unrelated source audio or a release.
void TestInstrumentRejectionBurstRendersValidSubset() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  auto graph = EmptyGranularGraphSnapshot(1);
  const auto source_graph = GraphSnapshot(1, 1.0F);
  constexpr std::size_t nodes_end = 36 + 2 * 132;
  std::vector<std::uint8_t> source(source_graph.begin() + 36, source_graph.begin() + 168);
  WriteLeU32(source, 0, 3);
  graph.insert(graph.begin() + nodes_end, source.begin(), source.end());
  std::vector<std::uint8_t> edge(source_graph.begin() + nodes_end, source_graph.end());
  WriteLeU32(edge, 0, 4);
  WriteLeU32(edge, 8, 3);
  graph.insert(graph.end(), edge.begin(), edge.end());
  WriteLeU32(graph, 20, 3);
  WriteLeU32(graph, 24, 2);
  std::vector<std::uint8_t> framed;
  AppendBeU64(framed, 1);
  AppendBeU32(framed, static_cast<std::uint32_t>(graph.size() - 12));
  std::copy(framed.begin(), framed.end(), graph.begin());
  assert(host.PrepareGraphRevision(1, graph).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  assert(host.ConfigureInstrumentStates(EmptyGranularStatePayload()));
  assert(host.PublishGraphRevision(1).code == daw::audio_host_macos::GraphRevisionStatusCode::kPublished);
  assert(host.SetTransport(1, false, 0));
  std::vector<std::uint8_t> chord;
  AppendLeU32(chord, 64);
  for (std::uint32_t index = 0; index < 64; ++index) {
    auto note = UrgentTransportRelease(1);
    WriteLeU32(note, 12, index + 1);
    WriteLeU32(note, 20, index + 1);
    WriteLeU32(note, 36, static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOn));
    WriteLeU32(note, 44, 36 + index);
    const float velocity = 0.8F;
    std::memcpy(note.data() + 48, &velocity, sizeof(velocity));
    chord.insert(chord.end(), note.begin() + 4, note.end());
  }
  assert(host.QueueInstrumentEvents(chord));
  auto invalid = ScheduleInstrumentWindow(1, 1, 1, 0, 128, 0, 1, true, 1);
  WriteLeU32(invalid, 88, 65);
  assert(host.QueueScheduleWindow(invalid));
  auto release = UrgentTransportRelease(1);
  WriteLeU32(release, 20, 100);
  assert(host.QueueInstrumentEvents(release));
  assert(host.StartOffline());
  assert(host.SetTransport(1, true, 0));
  std::array<float, 128> left{}, right{}, output_left{}, output_right{};
  left.fill(0.25F);
  right.fill(-0.125F);
  const std::array<const float*, 2> input{left.data(), right.data()};
  const std::array<float*, 2> output{output_left.data(), output_right.data()};
  unsigned failed = 0;
  bool first_audio = false;
  std::uint64_t first_urgent = 0;
  const auto rejections_before = injected_event_rejections;
  // 64 live notes precede the scheduled event; release 100 follows it.
  injected_event_index = 64;
  for (unsigned callback = 0; callback < 40; ++callback) {
    if (!host.ProcessPlanar(input, output, 128)) ++failed;
    if (callback == 0) {
      first_urgent = host.appliedUrgentSequence();
      first_audio = output_left == left && output_right == right;
    }
  }
  std::fprintf(stderr, "r24 burst: failed=%u first_urgent=%llu final_urgent=%llu output=%f/%f\n",
    failed, static_cast<unsigned long long>(first_urgent),
    static_cast<unsigned long long>(host.appliedUrgentSequence()), output_left[0], output_right[0]);
  assert(failed == 0);
  assert(injected_event_rejections == rejections_before + 1);
  assert(first_urgent == 100);
  assert(first_audio);
  assert(host.diagnostics().rejected_blocks == 0);
  assert(output_left == left && output_right == right);
  host.Stop();
}

void TestOfflineExportRejectsInjectedInstrumentFailure() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({.device_uid = "offline:render", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  assert(host.PrepareGraphRevision(1, EmptyGranularGraphSnapshot(1)).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  assert(host.ConfigureInstrumentStates(EmptyGranularStatePayload()));
  assert(host.PublishGraphRevision(1).code == daw::audio_host_macos::GraphRevisionStatusCode::kPublished);
  assert(host.SetTransport(1, false, 0));
  auto scheduled = ScheduleInstrumentWindow(1, 1, 1, 0, 128, 0, 1, true, 1);
  assert(host.QueueScheduleWindow(scheduled));
  assert(host.StartOffline());
  assert(host.SetTransport(1, true, 0));
  std::array<float, 128> left{}, right{}, output_left{}, output_right{};
  const std::array<const float*, 2> input{left.data(), right.data()};
  const std::array<float*, 2> output{output_left.data(), output_right.data()};
  output_left.fill(0.75F);
  output_right.fill(-0.75F);
  const auto rejections_before = injected_event_rejections;
  injected_event_index = 0;
  const bool rendered = host.ProcessPlanar(input, output, 128);
  std::fprintf(stderr, "offline export injected rejection: ok=%d rejected_blocks=%llu\n",
    rendered, static_cast<unsigned long long>(host.diagnostics().rejected_blocks));
  assert(!rendered);
  assert(injected_event_rejections == rejections_before + 1);
  assert(host.diagnostics().rejected_blocks == 1);
  assert(host.diagnostics().last_rejected_reason == daw::audio_host_macos::RejectedBlockReason::kCoreProcess);
  assert(host.diagnostics().last_rejected_instrument_event_count == 1);
  const auto message = daw::audio_host_macos::NativeOfflineFailureMessage(host.diagnostics());
  assert(message == "Native offline rendering failed because one or more instrument events were rejected; the export was not completed.");
  std::fprintf(stderr, "%s\n", message.c_str());
  // Strict core validation must fail before writing any output.
  for (const auto value : output_left) assert(value == 0.75F);
  for (const auto value : output_right) assert(value == -0.75F);
  host.Stop();
}

void TestScheduledInstrumentAdmission() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  assert(host.PrepareGraphRevision(1, InstrumentGraphSnapshot(1)).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  assert(host.ConfigureInstrumentStates(PackedSynthStatePayload(0.5F)));
  assert(host.PublishGraphRevision(1).code == daw::audio_host_macos::GraphRevisionStatusCode::kPublished);
  assert(host.SetTransport(1, false, 0));
  auto window = ScheduleInstrumentWindow(1, 1, 1, 0, 128, 0, 1, true, 2);
  WriteLeU32(window, 72, 1);
  WriteLeU32(window, 120, 1);
  WriteLeU32(window, 152, DAW_AUDIO_INSTRUMENT_EVENT_PARAMETER);
  WriteLeU32(window, 160, 127);
  const bool accepted = host.QueueScheduleWindow(window);
  std::fprintf(stderr, "scheduled invalid target admission: accepted=%d\n", accepted);
  assert(!accepted);
  assert(host.scheduleWindowError() == "instrument target is missing or its parameter is unsupported");
  WriteLeU32(window, 160, DAW_AUDIO_SYNTH_PARAMETER_FILTER_CUTOFF_HZ);
  const float zero = 0;
  std::memcpy(window.data() + 164, &zero, sizeof(zero));
  assert(!host.QueueScheduleWindow(window));
  const float cutoff = 913;
  std::memcpy(window.data() + 164, &cutoff, sizeof(cutoff));
  WriteLeU32(window, 120, 999);
  assert(!host.QueueScheduleWindow(window));
  WriteLeU32(window, 120, 2); // Master, not an instrument.
  assert(!host.QueueScheduleWindow(window));
  WriteLeU32(window, 120, 1);
  // Reusing the exact window proves rejected prefixes never publish or poison staging.
  assert(host.QueueScheduleWindow(window));
  assert(host.scheduleWindowError().empty());
  host.Stop();
}

// R23: malformed graph controls must never enter either instrument lane.
void TestInstrumentAdmissionAndVoiceStealing() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  assert(host.PrepareGraphRevision(1, InstrumentGraphSnapshot(1)).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  assert(host.ConfigureInstrumentStates(PackedSynthStatePayload(0.5F)));
  assert(host.PublishGraphRevision(1).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kPublished);
  assert(host.SetTransport(1, false, 0));
  auto parameter = UrgentTransportRelease(1);
  WriteLeU32(parameter, 36, DAW_AUDIO_INSTRUMENT_EVENT_PARAMETER);
  WriteLeU32(parameter, 44, DAW_AUDIO_SYNTH_PARAMETER_FILTER_CUTOFF_HZ);
  const float zero = 0;
  std::memcpy(parameter.data() + 48, &zero, sizeof(zero));
  const bool poison_accepted = host.QueueInstrumentEvents(parameter);
  std::fprintf(stderr, "r23 poison admission: accepted=%d\n", poison_accepted);
  assert(!poison_accepted);
  const float cutoff = 913;
  std::memcpy(parameter.data() + 48, &cutoff, sizeof(cutoff));
  auto missing = parameter;
  WriteLeU32(missing, 4, 999);
  assert(!host.QueueInstrumentEvents(missing));
  auto undeclared = parameter;
  WriteLeU32(undeclared, 44, 127);
  assert(!host.QueueInstrumentEvents(undeclared));
  // Validation is batch-atomic: a valid prefix cannot survive a rejected tail.
  std::vector<std::uint8_t> batch;
  AppendLeU32(batch, 2);
  auto prefix = parameter;
  WriteLeU32(prefix, 20, 777);
  batch.insert(batch.end(), prefix.begin() + 4, prefix.end());
  batch.insert(batch.end(), missing.begin() + 4, missing.end());
  assert(!host.QueueInstrumentEvents(batch));
  assert(host.QueueInstrumentEvents(parameter));
  std::vector<std::uint8_t> chord;
  AppendLeU32(chord, 33);
  for (std::uint32_t index = 0; index < 33; ++index) {
    auto note = UrgentTransportRelease(1);
    WriteLeU32(note, 12, index + 1);
    WriteLeU32(note, 20, index + 2);
    WriteLeU32(note, 36, DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON);
    WriteLeU32(note, 44, 36 + index);
    const float velocity = 0.8F;
    std::memcpy(note.data() + 48, &velocity, sizeof(velocity));
    chord.insert(chord.end(), note.begin() + 4, note.end());
  }
  assert(host.QueueInstrumentEvents(chord));
  assert(host.StartOffline());
  assert(host.SetTransport(1, true, 0));
  std::array<float, 128> left{}, right{}, output_left{}, output_right{};
  const std::array<const float*, 2> input{left.data(), right.data()};
  const std::array<float*, 2> output{output_left.data(), output_right.data()};
  const bool first = host.ProcessPlanar(input, output, 128);
  const bool second = host.ProcessPlanar(input, output, 128);
  std::fprintf(stderr, "r23 33-note chord: first=%d second=%d rejected=%llu urgent=%llu\n",
    first, second, static_cast<unsigned long long>(host.diagnostics().rejected_blocks),
    static_cast<unsigned long long>(host.appliedUrgentSequence()));
  assert(first && second);
  assert(host.diagnostics().rejected_blocks == 0);
  assert(host.appliedUrgentSequence() == 1);
  float energy = 0;
  for (const float value : output_left) energy += std::abs(value);
  assert(energy > 0);
  host.Stop();
}

void TestLargeFinalScheduleWindowUsesPersistentStaging() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 512,
    .channel_count = 2,
    .revision = 1,
  }));
  assert(host.PrepareAndPublishGraph(2, InstrumentGraphSnapshot(2)));
  assert(host.SetTransport(1, false, 0));
  assert(host.QueueScheduleWindow(
    ScheduleInstrumentWindow(2, 1, 1, 0, 512, 0, 1, true, 256)
  ));
  host.Stop();
}

void TestVstAutomationSegmentsReclaimWithinEpoch() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 2,
    .channel_count = 2,
    .revision = 1,
  }));
  constexpr std::string_view instance_id = "automation-instance";
  daw::audio_host_macos::NativeVstAttachment attachment{
    .graph_node_id = 2,
    .instance_id = std::string(instance_id),
    .class_id = "565354734D617376616C68616C6C6173",
    .vendor_id = "Valhalla DSP, LLC",
    .canonical_bundle_path = "/Library/Audio/Plug-Ins/VST3/ValhallaSupermassive.vst3",
    .canonical_executable_path = "/Library/Audio/Plug-Ins/VST3/ValhallaSupermassive.vst3/Contents/MacOS/ValhallaSupermassive",
    .architecture = 1,
    .scanner_catalog_version = 2,
    .role = daw::audio_host_macos::NativeVstRole::kEffect,
    .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .transport_latency_frames = 2,
    .playback_enabled = true,
    .transport = {.slot_count = 2, .maximum_frames = 2, .input_channels = 2, .output_channels = 2, .maximum_events_per_block = 32},
  };
  attachment.bundle_fingerprint = Fingerprint("0db70288522e217dd5a3c3690e3d9da2416a0019aa2def7e956e938af35a0a16");
  attachment.binary_fingerprint = Fingerprint("6e45a98e5da42ad8bcbfb7096debc5dddda111a710f28efb439fa8048c139b7d");
  attachment.parameter_ids = {7, 8};
  if (!std::filesystem::is_regular_file(attachment.canonical_executable_path)) {
    std::fputs("[skip] VST automation segment reclamation requires ValhallaSupermassive.\n", stderr);
    return;
  }
  assert(host.AttachNativeVst(attachment));
  const auto graph_status = host.PrepareGraphRevision(2, GraphSnapshot(2, 1.0F, 2));
  assert(graph_status.code == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  assert(host.PublishGraphRevision(2).code == daw::audio_host_macos::GraphRevisionStatusCode::kPublished);
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  assert(host.SetTransport(1, true, 0));
  for (std::size_t attempt = 0; attempt < 500; ++attempt) {
    const auto health = host.NativeVstHealth(instance_id);
    if (health && *health == daw::audio_host_macos::NativeVstWorkerHealth::kReady) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }

  std::array<float, 2> left{};
  std::array<float, 2> right{};
  std::array<float, 2> output_left{};
  std::array<float, 2> output_right{};
  const std::array<const float*, 2> input{left.data(), right.data()};
  const std::array<float*, 2> output{output_left.data(), output_right.data()};
  assert(host.ProcessPlanar(input, output, 2));
  assert(host.PrepareGraphRevision(3, GraphSnapshot(3, 1.F, 2), 512).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  auto staged_automation = ScheduleAutomationWindow(3, 1, 1, 512, 514, instance_id);
  WriteLeU32(staged_automation, 60, 3);
  WriteLeU32(staged_automation, 64, 512);
  assert(host.QueueScheduleWindow(staged_automation));
  assert(host.ProcessPlanar(input, output, 2));
  assert(host.WaitForScheduleProgress(nullptr));
  const auto staged_progress = host.DrainScheduleProgress();
  assert(staged_progress);
  std::fprintf(stderr, "checkpoint2 active VST credits=%u expected=2048\n", staged_progress->automation_credits);
  assert(staged_progress->automation_credits == 2048);
  assert(host.RollbackGraphRevision(3).code == daw::audio_host_macos::GraphRevisionStatusCode::kRolledBack);
  for (std::uint64_t index = 0; index < 2'050; ++index) {
    const auto start = index * 2;
    bool queued = false;
    for (std::size_t attempt = 0; attempt < 100 && !queued; ++attempt) {
      queued = host.QueueScheduleWindow(ScheduleAutomationWindow(
        2, 1, index + 1, start, start + 2, instance_id
      ));
      if (!queued) {
        assert(host.ProcessPlanar(input, output, 2));
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
      }
    }
    assert(queued);
    assert(host.ProcessPlanar(input, output, 2));
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  host.Stop();
}

void TestNoActiveDeviceFailsGracefully() {
  daw::audio_host_macos::AudioHost host;
  assert(host.readinessReason() == daw::audio_host_macos::DeviceReadinessReason::kDeviceNotConfigured);
  assert(!host.Start());
  assert(!host.Configure({
    .device_uid = "",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
}

void TestRejectedBlockDiagnosticsIdentifyLifecycleRejection() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  std::array<float, 2> left{};
  std::array<float, 2> right{};
  std::array<float, 2> output_left{};
  std::array<float, 2> output_right{};
  const std::array<const float*, 2> input{left.data(), right.data()};
  const std::array<float*, 2> output{output_left.data(), output_right.data()};
  assert(!host.ProcessPlanar(input, output, 2));
  const auto diagnostics = host.diagnostics();
  assert(diagnostics.rejected_blocks == 1);
  assert(diagnostics.last_rejected_reason
    == daw::audio_host_macos::RejectedBlockReason::kNotRunningOrCoreUnavailable);
  assert(diagnostics.last_rejected_callback == 1);
  assert(diagnostics.last_rejected_render_epoch == 0);
  assert(diagnostics.last_rejected_transport_epoch == 0);
  assert(diagnostics.last_rejected_core_result == DAW_AUDIO_CORE_OK);
}

void TestCoreAudioDeviceLossRoutesBySessionRole() {
  daw::audio_host_macos::AudioHost output_host;
  assert(output_host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  assert(output_host.StartDiagnosticMode());
  const auto output_recording_revision = output_host.recordingStatusRevision();
  daw::audio_host_macos::NotifyCoreAudioDeviceLost(
    output_host,
    daw::audio_host_macos::CoreAudioDeviceRole::kOutput);
  assert(output_host.diagnostics().state == daw::audio_host_macos::LifecycleState::kFaulted);
  assert(output_host.recordingStatusRevision() == output_recording_revision);
  output_host.Stop();

  daw::audio_host_macos::AudioHost input_host;
  assert(input_host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  assert(input_host.StartDiagnosticMode());
  const auto input_recording_revision = input_host.recordingStatusRevision();
  daw::audio_host_macos::NotifyCoreAudioDeviceLost(
    input_host,
    daw::audio_host_macos::CoreAudioDeviceRole::kRecordingInput);
  assert(input_host.diagnostics().state == daw::audio_host_macos::LifecycleState::kRunning);
  assert(input_host.recordingStatusRevision() == input_recording_revision + 1);
  input_host.Stop();
}

void TestKeepLatencyDiagnosticReply() {
  using namespace daw::audio_host_macos;
  AudioHost host;
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  // Monitored 1 + ordinary 2 merge at 3, then diverge via 4 and directly
  // to master 1000. Only the route through 4 has 2048 intrinsic frames.
  const auto original = EdgeGraphSnapshot(2, {{1, 0}, {2, 1}, {3, 0}, {4, 0}},
    {{11, 1, 3}, {12, 2, 3}, {13, 3, 4}, {14, 4, 1000}, {15, 3, 1000}});
  std::vector<std::uint8_t> payload(original.begin() + 12, original.begin() + 36);
  payload[0] = DAW_AUDIO_CORE_NATIVE_GRAPH_ENVELOPE_VERSION_KEEP_LATENCY;
  for (std::size_t node = 0; node < 5; ++node) {
    const auto begin = original.begin() + 36 + node * 132;
    payload.insert(payload.end(), begin, begin + 28);
    if (node == 4) payload[payload.size() - 3] = 8;  // 2048 intrinsic frames.
    AppendLeU32(payload, 0);
    AppendLeU32(payload, node == 1 ? 1 : 0);     // Keep Latency.
    payload.insert(payload.end(), begin + 28, begin + 132);
  }
  payload.insert(payload.end(), original.begin() + 36 + 5 * 132, original.end());
  // Ordinary graph PDC for the short branch, before Keep Latency policy.
  const auto delay_offset = 24 + 5 * 140 + 4 * 48 + 44;
  payload[delay_offset + 1] = 8;  // 2048 little-endian.
  std::vector<std::uint8_t> graph;
  AppendBeU64(graph, 2);
  AppendBeU32(graph, static_cast<std::uint32_t>(payload.size()));
  graph.insert(graph.end(), payload.begin(), payload.end());
  graph[36 + 3 * 140 + 8] = 3;  // Mixer wire kind, not a source.
  graph[36 + 4 * 140 + 8] = 3;
  auto initial = graph;
  initial[7] = 1;   // Framed revision.
  initial[16] = 1;  // Graph envelope revision.
  initial[36 + 140 + 32] = 0;
  assert(host.PrepareAndPublishGraph(1, initial));
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  assert(host.SetTransport(1, true, 0));
  const auto rejected = host.PrepareGraphRevision(2, graph);
  assert(rejected.code == GraphRevisionStatusCode::kPrepareFailed);
  assert(rejected.continuity == GraphRevisionContinuity::kRejected);
  assert(rejected.diagnostic_code == DAW_AUDIO_CORE_GRAPH_VALIDATION_KEEP_LATENCY_DIVERGENT_MIXED_BUS);
  assert(rejected.active_revision == 1);
  assert(host.diagnostics().state == LifecycleState::kRunning);
  initial[7] = 2;
  initial[16] = 2;
  assert(host.PrepareGraphRevision(2, initial).diagnostic_code == 0);
}

void TestRollbackSafeGraphRevisionLifecycle() {
  const auto progress_wire = daw::audio_host_macos::EncodeScheduleProgress({
    .admission_capacity_generation = 0x0102030405060708ULL,
    .latency_completion_generation = 0x1112131415161718ULL, .revision = 9, .epoch = 1,
    .progress_sequence = 1, .rendered_through_frame = 180, .accepted_through_frame = 240,
    .last_accepted_window_id = 7, .applied_transport_transition_id = 3,
    .running = true, .instrument_credits = 128, .source_credits = 64, .automation_credits = 32,
    .processor_patch_resolved_token = 0x2122232425262728ULL, .processor_patch_resolved_result = 12,
  });
  std::vector<std::uint8_t> expected_progress;
  AppendBeU32(expected_progress, 9); AppendBeU32(expected_progress, 1);
  for (const auto value : {1ULL, 180ULL, 240ULL, 7ULL, 3ULL, 0ULL, 0ULL}) AppendBeU64(expected_progress, value);
  for (const auto value : {1U, 128U, 64U, 32U}) AppendBeU32(expected_progress, value);
  assert(expected_progress.size() == 80);
  assert(std::equal(expected_progress.begin(), expected_progress.end(), progress_wire.begin()));
  AppendBeU64(expected_progress, 0x0102030405060708ULL);
  AppendBeU64(expected_progress, 0x1112131415161718ULL);
  // T5: protocol 29 appends the resolved patch token @96, its result @104 and a reserved word @108.
  AppendBeU64(expected_progress, 0x2122232425262728ULL);
  AppendBeU32(expected_progress, 12);
  AppendBeU32(expected_progress, 0);
  assert(progress_wire.size() == 112 && progress_wire == expected_progress);
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  const auto first_graph = GraphSnapshot(1, 1.0F);
  assert(host.PrepareAndPublishGraph(1, first_graph));
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  assert(host.SetTransport(1, true, 0));

  auto invalid_graph = GraphSnapshot(2, 0.5F);
  invalid_graph[12] = 99;
  const auto failed = host.PrepareGraphRevision(2, invalid_graph);
  assert(failed.code == daw::audio_host_macos::GraphRevisionStatusCode::kPrepareFailed);
  assert(failed.active_revision == 1);
  std::array<float, 4> left{1.0F, 1.0F, 1.0F, 1.0F};
  std::array<float, 4> right{1.0F, 1.0F, 1.0F, 1.0F};
  std::array<float, 4> output_left{};
  std::array<float, 4> output_right{};
  const std::array<const float*, 2> input{left.data(), right.data()};
  const std::array<float*, 2> output{output_left.data(), output_right.data()};
  assert(host.ProcessPlanar(input, output, 4));
  assert(output_left[0] == 1.0F && output_right[0] == 1.0F);

  const auto second_graph = GraphSnapshot(2, 0.25F);
  const auto discarded = host.PrepareGraphRevision(2, second_graph);
  assert(discarded.code == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  const auto rolled_back = host.RollbackGraphRevision(2);
  assert(rolled_back.code == daw::audio_host_macos::GraphRevisionStatusCode::kRolledBack);
  assert(rolled_back.active_revision == 1 && rolled_back.prepared_revision == 0);
  constexpr std::int64_t publication_frame = (1LL << 54) + 4;
  assert(host.SetTransport(1, true, publication_frame));
  assert(host.ProcessPlanar(input, output, 4));
  const auto prepared = host.PrepareGraphRevision(2, second_graph);
  assert(prepared.code == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  const auto active_while_prepared = host.InspectGraphRevision(1);
  assert(active_while_prepared.code == daw::audio_host_macos::GraphRevisionStatusCode::kPublished);
  assert(active_while_prepared.prepared_revision == 2);
  // Publication admission is synchronous and nonblocking. Its return is the
  // deterministic observation that the request is armed before this callback.
  auto published = host.PublishGraphRevision(2);
  assert(published.code == daw::audio_host_macos::GraphRevisionStatusCode::kPublishPending);
  output_left.fill(0.0F);
  output_right.fill(0.0F);
  assert(host.ProcessPlanar(input, output, 4));
  published = host.InspectGraphRevision(2);
  assert(published.code == daw::audio_host_macos::GraphRevisionStatusCode::kPublished);
  assert(published.active_revision == 2 && published.retired_revision == 1);
  assert(published.publication_frame == publication_frame + 4);
  const auto reconciled = host.InspectGraphRevision(2);
  assert(reconciled.code == daw::audio_host_macos::GraphRevisionStatusCode::kPublished);
  assert(reconciled.active_revision == published.active_revision);
  assert(reconciled.publication_frame == published.publication_frame);
  assert(host.RollbackGraphRevision(2).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kStaleRevision);
  assert(output_left[0] == PublishedEdgeGain(1.0F, 0.25F, 1) && output_right[0] == PublishedEdgeGain(1.0F, 0.25F, 1));
  const auto stale = host.PublishGraphRevision(1);
  assert(stale.code == daw::audio_host_macos::GraphRevisionStatusCode::kStaleRevision);
  const auto retired = host.RetireGraphRevision(1);
  assert(retired.code == daw::audio_host_macos::GraphRevisionStatusCode::kRetired);
  assert(retired.render_epoch >= published.render_epoch);
  const auto third_graph = GraphSnapshot(3, 0.5F);
  assert(host.PrepareGraphRevision(3, third_graph).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  const auto wait_started = std::chrono::steady_clock::now();
  const auto publish_timeout = host.PublishGraphRevision(3);
  const auto wait_elapsed = std::chrono::steady_clock::now() - wait_started;
  assert(wait_elapsed < std::chrono::milliseconds(50));
  assert(publish_timeout.code == daw::audio_host_macos::GraphRevisionStatusCode::kPublishPending);
  assert(publish_timeout.active_revision == 2 && publish_timeout.prepared_revision == 3);
  const auto timeout_reconciled = host.InspectGraphRevision(3);
  assert(timeout_reconciled.active_revision == 2 && timeout_reconciled.prepared_revision == 3);
  assert(timeout_reconciled.code == daw::audio_host_macos::GraphRevisionStatusCode::kPublishPending);
  // An admitted request stays callback-owned until the boundary, without
  // blocking unrelated commands or authorizing an unsafe rollback.
  assert(host.RollbackGraphRevision(3).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kPublishPending);
  assert(host.ProcessPlanar(input, output, 4));
  assert(host.InspectGraphRevision(3).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kPublished);
  assert(host.diagnostics().active_revision == 3);
  host.Stop();
}

// A transition the core has no room to fade is a failed prepare on the live
// core. It must not become a published cold core that hard-cuts every fade.
void TestTransitionExhaustionFailsWithoutColdCore() {
  using Sources = std::vector<std::pair<std::uint64_t, std::uint32_t>>;
  const auto range = [](const std::uint64_t first, const std::uint64_t last, const Sources& extra) {
    Sources sources;
    for (std::uint64_t id = first; id <= last; ++id) sources.emplace_back(id, 0);
    sources.insert(sources.end(), extra.begin(), extra.end());
    return sources;
  };
  const Sources disconnected{{500, DAW_AUDIO_GRAPH_INPUT_BUS_DISCONNECTED}, {501, DAW_AUDIO_GRAPH_INPUT_BUS_DISCONNECTED}};
  const auto configure = [&](daw::audio_host_macos::AudioHost& host) {
    assert(host.Configure({
      .device_uid = "diagnostic",
      .sample_rate_hz = 48000,
      .max_frames_per_block = 4,
      .channel_count = 2,
      .revision = 1,
    }));
    assert(host.PrepareAndPublishGraph(1, FanInGraphSnapshot(1, range(1, 63, {}))));
    // Two sources are replaced, so two fades are in flight once rendering starts.
    assert(host.PrepareAndPublishGraph(2, FanInGraphSnapshot(2, range(3, 63, disconnected))));
    assert(host.SetTransport(1, false, 0));
    assert(host.StartDiagnosticMode());
    assert(host.SetTransport(1, true, 0));
  };
  std::array<float, 4> input_left{1.0F, 1.0F, 1.0F, 1.0F};
  std::array<float, 4> input_right{1.0F, 1.0F, 1.0F, 1.0F};
  const std::array<const float*, 2> input{input_left.data(), input_right.data()};
  const auto render = [&](daw::audio_host_macos::AudioHost& host) {
    std::array<float, 8> samples{};
    const std::array<float*, 2> output{samples.data(), samples.data() + 4};
    assert(host.ProcessPlanar(input, output, 4));
    return samples;
  };
  daw::audio_host_macos::AudioHost edited;
  daw::audio_host_macos::AudioHost reference;
  for (auto* host : {&edited, &reference}) {
    configure(*host);
    render(*host);
  }
  assert(edited.diagnostics().active_revision == 2);
  // Deleting every remaining source needs 65 transition nodes against a budget of 64.
  const auto failed = edited.PrepareGraphRevision(3, FanInGraphSnapshot(3, {}));
  assert(failed.code == daw::audio_host_macos::GraphRevisionStatusCode::kPrepareFailed);
  assert(failed.active_revision == 2 && failed.prepared_revision == 0);
  assert(edited.InspectGraphRevision(2).code == daw::audio_host_macos::GraphRevisionStatusCode::kPublished);
  for (int block = 0; block < 20; ++block) assert(render(edited) == render(reference));
  // The live core stays usable: an edit that fits is accepted by the same core.
  const auto fitting = edited.PrepareGraphRevision(3, FanInGraphSnapshot(3, range(3, 62, disconnected)));
  assert(fitting.code == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  assert(fitting.continuity == daw::audio_host_macos::GraphRevisionContinuity::kAccepted);
  assert(edited.RollbackGraphRevision(3).code == daw::audio_host_macos::GraphRevisionStatusCode::kRolledBack);
  edited.Stop();
  reference.Stop();
}

// An edit whose fading node would form a cycle cannot be ordered. It is a failed
// prepare on the live core, not a published cold core that resets everything else.
void TestUnorderableEditFailsWithoutColdCore() {
  const auto before = [](const std::uint32_t revision) {
    return EdgeGraphSnapshot(revision, {{1, 0}, {2, 0}, {3, 0}, {5, 0}},
      {{1, 1, 2}, {2, 2, 3}, {3, 3, 1000}, {4, 5, 1000}});
  };
  daw::audio_host_macos::AudioHost edited;
  daw::audio_host_macos::AudioHost reference;
  std::array<float, 4> input_left{1.0F, 1.0F, 1.0F, 1.0F};
  std::array<float, 4> input_right{1.0F, 1.0F, 1.0F, 1.0F};
  const std::array<const float*, 2> input{input_left.data(), input_right.data()};
  const auto render = [&](daw::audio_host_macos::AudioHost& host) {
    std::array<float, 8> samples{};
    const std::array<float*, 2> output{samples.data(), samples.data() + 4};
    assert(host.ProcessPlanar(input, output, 4));
    return samples;
  };
  for (auto* host : {&edited, &reference}) {
    assert(host->Configure({
      .device_uid = "diagnostic",
      .sample_rate_hz = 48000,
      .max_frames_per_block = 4,
      .channel_count = 2,
      .revision = 1,
    }));
    assert(host->PrepareAndPublishGraph(1, before(1)));
    assert(host->SetTransport(1, false, 0));
    assert(host->StartDiagnosticMode());
    assert(host->SetTransport(1, true, 0));
    render(*host);
  }
  // Source 2 is deleted while a new edge routes source 3 back into source 1.
  const auto failed = edited.PrepareGraphRevision(2, EdgeGraphSnapshot(2, {{1, 0}, {3, 0}, {5, 0}},
    {{5, 3, 1}, {6, 1, 1000}, {4, 5, 1000}}));
  assert(failed.code == daw::audio_host_macos::GraphRevisionStatusCode::kPrepareFailed);
  assert(failed.active_revision == 1 && failed.prepared_revision == 0);
  for (int block = 0; block < 20; ++block) assert(render(edited) == render(reference));
  // The live core stays usable: an edit it can fade is accepted by the same core.
  const auto fitting = edited.PrepareGraphRevision(2, EdgeGraphSnapshot(2, {{1, 0}, {3, 0}, {5, 0}},
    {{2, 1, 3}, {3, 3, 1000}, {4, 5, 1000}}));
  assert(fitting.code == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  assert(fitting.continuity == daw::audio_host_macos::GraphRevisionContinuity::kAccepted);
  assert(edited.RollbackGraphRevision(2).code == daw::audio_host_macos::GraphRevisionStatusCode::kRolledBack);
  edited.Stop();
  reference.Stop();
}

void TestFallbackPublishesConfiguredInstrumentState() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  assert(host.PrepareGraphRevision(1, InstrumentGraphSnapshot(1)).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  assert(host.ConfigureInstrumentStates(InstrumentStatePayload(0.5F)));
  assert(host.PublishGraphRevision(1).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kPublished);

  assert(host.PrepareGraphRevision(2, InstrumentGraphSnapshot(2)).continuity
    == daw::audio_host_macos::GraphRevisionContinuity::kAccepted);
  assert(host.ConfigureInstrumentStates(InstrumentStatePayload(0.75F)));
  assert(host.PublishGraphRevision(2).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kPublished);
  assert(host.RetireGraphRevision(1).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kRetired);

  const auto repeated = host.PrepareGraphRevision(3, InstrumentGraphSnapshot(3));
  assert(repeated.code == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  assert(repeated.continuity == daw::audio_host_macos::GraphRevisionContinuity::kAccepted);
  assert(host.RollbackGraphRevision(3).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kRolledBack);
  host.Stop();
}

void TestWorkerNotificationCarriesRevisionIdentity() {
  daw::audio_host_macos::NativeVstAttachment attachment{
    .graph_node_id = 91,
    .instance_id = "attachment-instance",
  };
  const auto notification = daw::audio_host_macos::IdentifyWorkerNotification(
    attachment,
    7,
    daw::audio_host_macos::WorkerNotificationKind::kLatency,
    128
  );
  assert(notification.graph_revision == 7);
  assert(notification.graph_node_id == 91);
  assert(notification.instance_id == "attachment-instance");
  assert(notification.value == 128);
}

WorkerNotification Notification(
  const WorkerNotificationKind kind,
  const std::uint32_t value = 0,
  const std::string_view instance_id = {},
  const std::uint32_t parameter_id = 0,
  const double normalized_value = 0.0
) {
  return {
    .kind = kind,
    .instance_id = std::string(instance_id),
    .value = value,
    .parameter_id = parameter_id,
    .normalized_value = normalized_value,
  };
}

void TestWorkerNotificationQueuePolicy() {
  {
    WorkerNotificationQueue queue;
    assert(queue.Push(Notification(WorkerNotificationKind::kParameterEdit, 0, "instance", 7, 0.25)));
    assert(queue.Push(Notification(WorkerNotificationKind::kParameterEdit, 0, "instance", 7, 0.75)));
    const auto latest = queue.Pop();
    assert(latest.parameter_id == 7 && latest.normalized_value == 0.75 && queue.Empty());
  }
  {
    WorkerNotificationQueue queue;
    for (std::size_t index = 0; index < WorkerNotificationQueue::kCapacity; ++index) {
      assert(queue.Push(Notification(WorkerNotificationKind::kParameterEdit, 0, "instance", static_cast<std::uint32_t>(index), 0.5)));
    }
    assert(queue.Push(Notification(WorkerNotificationKind::kParameterEdit, 0, "instance", 999, 0.75)));
    assert(queue.Pop().parameter_id == 1);
  }
  {
    WorkerNotificationQueue queue;
    for (std::size_t index = 0; index < WorkerNotificationQueue::kCapacity; ++index) {
      assert(queue.Push(Notification(WorkerNotificationKind::kLatency, static_cast<std::uint32_t>(index))));
    }
    assert(queue.Push(Notification(WorkerNotificationKind::kParameterEdit, 0, "instance", 11, 0.25)));
    assert(queue.Pop().value == 1);
  }
  {
    WorkerNotificationQueue queue;
    for (std::size_t index = 0; index < WorkerNotificationQueue::kCapacity; ++index) {
      assert(queue.Push(Notification(
        index % 2 == 0 ? WorkerNotificationKind::kRestart : WorkerNotificationKind::kFault,
        static_cast<std::uint32_t>(index)
      )));
    }
    assert(!queue.Push(Notification(WorkerNotificationKind::kParameterEdit, 0, "instance", 1, 0.5)));
  }
  {
    WorkerNotificationQueue queue;
    for (std::size_t index = 0; index + 1 < WorkerNotificationQueue::kCapacity; ++index) {
      assert(queue.Push(Notification(
        index % 2 == 0 ? WorkerNotificationKind::kRestart : WorkerNotificationKind::kFault,
        static_cast<std::uint32_t>(index)
      )));
    }
    assert(queue.Push(Notification(WorkerNotificationKind::kLatency, 999)));
    assert(queue.Push(Notification(WorkerNotificationKind::kRestart, 1000)));
    assert(!queue.Push(Notification(WorkerNotificationKind::kFault, 1001)));
    assert(queue.Pop().value == 0);
  }
}

}  // namespace

std::vector<std::uint8_t> SpectralTransitionGraph(const std::uint32_t revision, const std::uint32_t fft) {
  auto frame = GraphSnapshot(revision, 1.F);
  std::vector<std::uint8_t> payload(frame.begin() + 12, frame.end());
  WriteLeU32(payload, 16, 1);
  WriteLeU32(payload, 48, fft);
  AppendLeU64(payload, 1);
  for (const auto value : {std::uint32_t(DAW_AUDIO_PROCESSOR_KIND_SPECTRAL), 1U, 60U, 10U, 0U, 2U, 2U, 0U, fft, 0U})
    AppendLeU32(payload, value);
  for (const auto value : {1U, fft, 2U, std::uint32_t(DAW_AUDIO_SPECTRAL_MODE_HPSS)}) AppendLeU32(payload, value);
  for (const auto value : {0.F, -60.F, 1.F, 20.F, 0.F, 0.F, 0.F, 1.F, 0.F, 0.F, 1.F}) AppendLeFloat(payload, value);
  frame.clear();
  AppendBeU64(frame, revision);
  AppendBeU32(frame, static_cast<std::uint32_t>(payload.size()));
  frame.insert(frame.end(), payload.begin(), payload.end());
  return frame;
}

// A multi-second HPSS transition keeps audio live but never owns the command
// loop. Completion, not elapsed time, admits bank reuse and the newest revision.
void TestLatencyMoveCompletionQueuesTheNextRevision() {
  using daw::audio_host_macos::GraphRevisionStatusCode;
  {
    daw::audio_host_macos::AudioHost queued;
    assert(queued.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
      .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
    assert(queued.PrepareGraphRevision(1, InstrumentGraphSnapshot(1)).code == GraphRevisionStatusCode::kPrepared);
    assert(queued.ConfigureInstrumentStates(PackedSynthStatePayload(0.5F)));
    assert(queued.PublishGraphRevision(1).code == GraphRevisionStatusCode::kPublished);
    assert(queued.SetTransport(1, false, 0));
    assert(queued.StartDiagnosticMode());
    assert(queued.QueueInstrumentEvents(UrgentTransportRelease(1)));
    const auto admission = queued.PrepareGraphRevision(2, InstrumentGraphSnapshot(2));
    std::fprintf(stderr, "queued-control prepare=%u (expected pending)\n", static_cast<unsigned>(admission.code));
    assert(admission.code == GraphRevisionStatusCode::kPublishPending);
    assert(queued.InspectGraphRevision(2).code == GraphRevisionStatusCode::kPublishPending);
    std::array<float, 128> silence{}, left{}, right{};
    const std::array<const float*, 2> input{silence.data(), silence.data()};
    const std::array<float*, 2> output{left.data(), right.data()};
    assert(queued.ProcessPlanar(input, output, 128));
    assert(queued.InspectGraphRevision(2).code == GraphRevisionStatusCode::kStaleRevision);
    assert(queued.PrepareGraphRevision(2, InstrumentGraphSnapshot(2)).code == GraphRevisionStatusCode::kPrepared);
    assert(queued.PublishGraphRevision(2).code == GraphRevisionStatusCode::kPublishPending);
    assert(queued.ProcessPlanar(input, output, 128));
    assert(queued.InspectGraphRevision(2).code == GraphRevisionStatusCode::kPublished);
    queued.Stop();
  }
  {
    daw::audio_host_macos::AudioHost paused;
    assert(paused.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
      .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
    assert(paused.PrepareGraphRevision(1, InstrumentGraphSnapshot(1)).code == GraphRevisionStatusCode::kPrepared);
    assert(paused.ConfigureInstrumentStates(PackedSynthStatePayload(0.5F)));
    assert(paused.PublishGraphRevision(1).code == GraphRevisionStatusCode::kPublished);
    assert(paused.SetTransport(1, false, 0));
    assert(paused.StartDiagnosticMode());
    assert(paused.QueueScheduleWindow(ScheduleInstrumentWindow(1, 1, 1, 0, 128, 0, 1, true, 1)));
    const auto admission = paused.PrepareGraphRevision(2, InstrumentGraphSnapshot(2));
    std::fprintf(stderr, "paused-schedule prepare=%u (expected prepared)\n", static_cast<unsigned>(admission.code));
    assert(admission.code == GraphRevisionStatusCode::kPrepared);
    assert(paused.PublishGraphRevision(2).code == GraphRevisionStatusCode::kPublishPending);
    std::array<float, 128> silence{}, left{}, right{};
    const std::array<const float*, 2> input{silence.data(), silence.data()};
    const std::array<float*, 2> output{left.data(), right.data()};
    assert(paused.ProcessPlanar(input, output, 128));
    assert(paused.InspectGraphRevision(2).code == GraphRevisionStatusCode::kPublished);
    assert(paused.SetTransport(1, true, 0));
    assert(paused.ProcessPlanar(input, output, 128));
    float energy = 0;
    for (const auto value : left) energy += std::abs(value);
    assert(energy > 0);
    paused.Stop();
  }
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 22050,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  assert(host.PrepareAndPublishGraph(1, SpectralTransitionGraph(1, 512)));
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  assert(host.SetTransport(1, true, 0));
  std::array<float, 128> silence{}, left{}, right{};
  const std::array<const float*, 2> input{silence.data(), silence.data()};
  const std::array<float*, 2> output{left.data(), right.data()};
  assert(host.ProcessPlanar(input, output, 128));
  assert(host.PrepareGraphRevision(2, SpectralTransitionGraph(2, 4096)).code == GraphRevisionStatusCode::kPrepared);
  const auto published = host.PublishGraphRevision(2);
  assert(host.ProcessPlanar(input, output, 128));
  assert(published.code == GraphRevisionStatusCode::kPublishPending);
  assert(host.InspectGraphRevision(2).code == GraphRevisionStatusCode::kPublished);
  const auto start = std::chrono::steady_clock::now();
  assert(host.RetireGraphRevision(1).code == GraphRevisionStatusCode::kRetirementNotSafe);
  assert(host.PrepareGraphRevision(3, SpectralTransitionGraph(3, 512)).code == GraphRevisionStatusCode::kPublishPending);
  assert(host.InspectGraphRevision(3).code == GraphRevisionStatusCode::kPublishPending);
  static_cast<void>(host.diagnostics());
  assert(std::chrono::steady_clock::now() - start < std::chrono::milliseconds(50));
  auto transition_started = std::async(std::launch::async, [&] {
    return host.WaitForScheduleProgress(nullptr);
  });
  assert(transition_started.wait_for(std::chrono::seconds(1)) == std::future_status::ready);
  assert(transition_started.get());
  const auto transitioning = host.DrainScheduleProgress();
  assert(transitioning && transitioning->admission_capacity_generation == 0
    && transitioning->latency_completion_generation == 0);
  unsigned rendered = 128;
  while (host.InspectGraphRevision(3).code == GraphRevisionStatusCode::kPublishPending && rendered < 100000) {
    assert(host.ProcessPlanar(input, output, 128));
    rendered += 128;
  }
  assert(rendered > 44100 && rendered < 100000);
  // Completion is its own fact, not a reclaim, even below the ordinary
  // progress quantum; repeated ordinary progress leaves that generation alone.
  auto completion = std::async(std::launch::async, [&] {
    return host.WaitForScheduleProgress(nullptr);
  });
  assert(completion.wait_for(std::chrono::seconds(1)) == std::future_status::ready);
  assert(completion.get());
  const auto progress = host.DrainScheduleProgress();
  assert(progress && progress->revision == 2);
  assert(progress->latency_completion_generation == 1);
  assert(progress->admission_capacity_generation == 0);
  assert(host.ProcessPlanar(input, output, 128));
  host.ProcessNativeVstControl();
  const auto ordinary = host.DrainScheduleProgress();
  if (ordinary) {
    assert(ordinary->latency_completion_generation == 1);
    assert(ordinary->admission_capacity_generation == 0);
  }
  // Completion unlocks automatic control-thread retirement before admission.
  const auto next = host.PrepareGraphRevision(3, SpectralTransitionGraph(3, 512));
  assert(next.code == GraphRevisionStatusCode::kPrepared && next.retired_revision == 0);
  assert(host.PublishGraphRevision(3).code == GraphRevisionStatusCode::kPublishPending);
  assert(host.ProcessPlanar(input, output, 128));
  assert(host.InspectGraphRevision(3).code == GraphRevisionStatusCode::kPublished);
  host.Stop();
}

// Acceptance evidence for one test: the host appends JSON lines to a private directory.
struct EvidenceLog {
  std::filesystem::path directory = std::filesystem::temp_directory_path()
    / ("ae08-evidence-" + std::to_string(getpid()));
  EvidenceLog() {
    std::filesystem::create_directory(directory);
    setenv("DAW_AE08_EVIDENCE_DIR", directory.c_str(), 1);
  }
  ~EvidenceLog() {
    unsetenv("DAW_AE08_EVIDENCE_DIR");
    std::filesystem::remove_all(directory);
  }
  // Lines of one event. The bridge thread writes after the callback returns, so wait for `count`.
  std::vector<std::string> Lines(const std::string& event, const std::size_t count) const {
    const auto marker = "\"event\":\"" + event + "\"";
    std::vector<std::string> found;
    for (const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);;) {
      found.clear();
      std::ifstream file(directory / ("native-" + std::to_string(getpid()) + ".jsonl"));
      for (std::string line; std::getline(file, line);)
        if (line.find(marker) != std::string::npos) found.push_back(line);
      if (found.size() >= count || std::chrono::steady_clock::now() > deadline) return found;
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
  }
  static std::optional<std::uint64_t> Field(const std::string& line, const std::string& key) {
    const auto at = line.find("\"" + key + "\":");
    if (at == std::string::npos) return std::nullopt;
    return std::strtoull(line.c_str() + at + key.size() + 3, nullptr, 10);
  }
};

// A raise publishes the larger latency. A lower while playing publishes the graph's own smaller latency but keeps
// the pinned budget until the transport stops, so only the graph latency shows that the lower was applied.
void TestPublishEvidenceCarriesTheAppliedLatency() {
  using daw::audio_host_macos::GraphRevisionStatusCode;
  EvidenceLog log;
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 22050,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  assert(host.PrepareAndPublishGraph(1, SpectralTransitionGraph(1, 512)));
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  assert(host.SetTransport(1, true, 0));
  std::array<float, 128> silence{}, left{}, right{};
  const std::array<const float*, 2> input{silence.data(), silence.data()};
  const std::array<float*, 2> output{left.data(), right.data()};
  assert(host.ProcessPlanar(input, output, 128));
  assert(host.PrepareGraphRevision(2, SpectralTransitionGraph(2, 4096)).code == GraphRevisionStatusCode::kPrepared);
  assert(host.PublishGraphRevision(2).code == GraphRevisionStatusCode::kPublishPending);
  assert(host.ProcessPlanar(input, output, 128));
  assert(host.InspectGraphRevision(2).code == GraphRevisionStatusCode::kPublished);
  for (unsigned rendered = 0; host.InspectGraphRevision(3).code == GraphRevisionStatusCode::kPublishPending
    && rendered < 1000; ++rendered) assert(host.ProcessPlanar(input, output, 128));
  assert(host.PrepareGraphRevision(3, SpectralTransitionGraph(3, 512)).code == GraphRevisionStatusCode::kPrepared);
  assert(host.PublishGraphRevision(3).code == GraphRevisionStatusCode::kPublishPending);
  assert(host.ProcessPlanar(input, output, 128));
  assert(host.InspectGraphRevision(3).code == GraphRevisionStatusCode::kPublished);
  const auto published = log.Lines("graph-publish", 3);
  host.Stop();
  assert(published.size() == 3);
  const auto latencies = [&](const char* key) {
    std::array<std::uint64_t, 3> frames{};
    for (std::size_t index = 0; index < frames.size(); ++index) {
      const auto value = EvidenceLog::Field(published[index], key);
      assert(value);
      frames[index] = *value;
    }
    return frames;
  };
  assert((latencies("graphLatencyFrames") == std::array<std::uint64_t, 3>{512, 4096, 512}));
  assert((latencies("pinnedLatencyFrames") == std::array<std::uint64_t, 3>{512, 4096, 4096}));
}

void TestPausedPublicationReconcilesScheduledTargets() {
  using daw::audio_host_macos::GraphRevisionStatusCode;
  for (const bool removed : {false, true}) {
    daw::audio_host_macos::AudioHost host;
    assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
      .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
    assert(host.PrepareAndPublishGraph(1, GraphSnapshot(1, 1.F, 0, true)));
    assert(host.SetTransport(1, false, 0));
    assert(host.StartDiagnosticMode());
    assert(host.QueueScheduleWindow(ScheduleProcessorSetWindow(
      1, 1, 1, 0, 128, 77, DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB, 0, -6.F)));
    assert(host.QueueScheduleWindow(ScheduleProcessorSetWindow(
      1, 1, 2, 128, 256, 77, DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB, 128, -12.F)));
    std::array<float, 128> silence{}, left{}, right{};
    const std::array<const float*, 2> input{silence.data(), silence.data()};
    const std::array<float*, 2> output{left.data(), right.data()};
    for (unsigned block = 0; block < 20; ++block) assert(host.ProcessPlanar(input, output, 128));
    auto replacement = GraphSnapshot(2, 1.F, 0, !removed);
    const auto admission = host.PrepareGraphRevision(2, replacement);
    std::fprintf(stderr, "paused automation removed=%d prepare=%u\n", removed, unsigned(admission.code));
    assert(admission.code == GraphRevisionStatusCode::kPrepared);
    assert(host.PublishGraphRevision(2).code == GraphRevisionStatusCode::kPublishPending);
    assert(host.ProcessPlanar(input, output, 128));
    assert(host.InspectGraphRevision(2).code == GraphRevisionStatusCode::kPublished);
    assert(host.RetireGraphRevision(1).code == GraphRevisionStatusCode::kRetired);
    assert(host.PrepareGraphRevision(3, GraphSnapshot(3, 1.F, 0, !removed)).code
      == GraphRevisionStatusCode::kPrepared);
    assert(host.PublishGraphRevision(3).code == GraphRevisionStatusCode::kPublishPending);
    assert(host.ProcessPlanar(input, output, 128));
    assert(host.InspectGraphRevision(3).code == GraphRevisionStatusCode::kPublished);
    assert(host.SetTransport(1, true, 0));
    silence.fill(1.F);
    assert(host.ProcessPlanar(input, output, 128));
    assert(host.diagnostics().rejected_blocks == 0);
    std::fprintf(stderr, "retained automation removed=%d output=%g\n", removed, left[127]);
    assert(std::abs(left[127] - (removed ? 1.F : std::pow(10.F, -6.F / 20.F))) < 1e-6F);
    assert(host.ProcessPlanar(input, output, 128));
    assert(std::abs(left[127] - (removed ? 1.F : std::pow(10.F, -12.F / 20.F))) < 1e-6F);
    host.Stop();
  }
  for (const bool removed : {false, true}) {
    daw::audio_host_macos::AudioHost host;
    assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
      .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
    assert(host.PrepareAndPublishGraph(1,
      EdgeGraphSnapshot(1, {{1, 0}, {3, 0}}, {{1, 1, 1000}, {2, 3, 1000}})));
    std::array<float, 256> asset{};
    asset.fill(.25F);
    assert(host.InstallAsset(1, 128, 48000, 2, 0, asset));
    assert(host.SetTransport(1, false, 0));
    assert(host.StartDiagnosticMode());
    auto window = ScheduleWindow(1, 1, 1, 0, 128, 0, 1, false);
    WriteLeU32(window, 48, 2);
    for (unsigned index = 0; index < 2; ++index) {
      AppendLeU32(window, 1);
      AppendLeU64(window, index + 1);
      AppendLeU64(window, index == 0 ? 1 : 3);
      AppendLeU32(window, 1);
      for (auto value : {0ULL, 128ULL, 0ULL, 128ULL}) AppendLeU64(window, value);
      AppendLeFloat(window, 1.F);
      for (auto value : {0ULL, 0ULL, 128ULL, 128ULL}) AppendLeU64(window, value);
      for (unsigned field = 0; field < 5; ++field) AppendLeFloat(window, 0.F);
    }
    assert(host.QueueScheduleWindow(window));
    auto replacement = removed
      ? EdgeGraphSnapshot(2, {{3, 0}}, {{2, 3, 1000}})
      : EdgeGraphSnapshot(2, {{1, 0}, {3, 0}}, {{1, 1, 1000}, {2, 3, 1000}});
    assert(host.PrepareGraphRevision(2, replacement).code == GraphRevisionStatusCode::kPrepared);
    assert(host.PublishGraphRevision(2).code == GraphRevisionStatusCode::kPublishPending);
    std::array<float, 128> silence{}, left{}, right{};
    const std::array<const float*, 2> input{silence.data(), silence.data()};
    const std::array<float*, 2> output{left.data(), right.data()};
    assert(host.ProcessPlanar(input, output, 128));
    assert(host.SetTransport(1, true, 0));
    for (unsigned block = 0; block < 3; ++block) {
      const bool rendered = host.ProcessPlanar(input, output, 128);
      std::fprintf(stderr, "queued source removed=%d block=%u rendered=%d rejected=%llu\n",
        removed, block, rendered, static_cast<unsigned long long>(host.diagnostics().rejected_blocks));
      assert(rendered);
      if (block == 0) assert(left[127] == (removed ? .0625F : .125F));
    }
    assert(host.diagnostics().rejected_blocks == 0);
    assert(host.diagnostics().transport_frame == 384);
    host.Stop();
  }
}

void TestDeviceLossTerminatesPendingTransition() {
  using namespace daw::audio_host_macos;
  AudioHost host;
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 22050,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  assert(host.PrepareAndPublishGraph(1, SpectralTransitionGraph(1, 512)));
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  assert(host.SetTransport(1, true, 0));
  std::array<float, 128> silence{}, left{}, right{};
  const std::array<const float*, 2> input{silence.data(), silence.data()};
  const std::array<float*, 2> output{left.data(), right.data()};
  assert(host.ProcessPlanar(input, output, 128));
  assert(host.PrepareGraphRevision(2, SpectralTransitionGraph(2, 4096)).code == GraphRevisionStatusCode::kPrepared);
  assert(host.PublishGraphRevision(2).code == GraphRevisionStatusCode::kPublishPending);
  assert(host.ProcessPlanar(input, output, 128));
  assert(host.InspectGraphRevision(2).code == GraphRevisionStatusCode::kPublished);
  assert(host.RetireGraphRevision(1).code == GraphRevisionStatusCode::kRetirementNotSafe);
  // Complete more reader epochs, but not the multi-second transition.
  assert(host.ProcessPlanar(input, output, 128));
  assert(host.ProcessPlanar(input, output, 128));
  // Drain any callback progress before establishing the device-loss edge.
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  host.DrainScheduleProgress();
  std::atomic<bool> running{true};
  auto fault = std::async(std::launch::async, [&] { return host.WaitForScheduleProgress(&running); });
  const auto before = host.diagnostics();
  host.NotifyOutputDeviceLost();
  const bool ready = fault.wait_for(std::chrono::milliseconds(100)) == std::future_status::ready;
  running.store(false);
  host.WakeScheduleProgressWait();
  static_cast<void>(fault.get());
  assert(ready);
  assert(host.diagnostics().state == LifecycleState::kFaulted);
  // Notification is not transition completion or permission to reclaim.
  assert(host.diagnostics().render_epoch == before.render_epoch);
  assert(host.diagnostics().retired_revision == 1);
  assert(host.RetireGraphRevision(1).code == GraphRevisionStatusCode::kRetirementNotSafe);
  host.Stop();
  host.Teardown();
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 22050,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 3}));
  assert(host.PrepareAndPublishGraph(3, SpectralTransitionGraph(3, 512)));
  assert(host.diagnostics().active_revision == 3);
}

void TestStopBeforeFirstCallbackDoesNotPublishEmptyProgress() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  assert(host.PrepareAndPublishGraph(1, SpectralTransitionGraph(1, 512)));
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  host.Stop();
  auto notification = std::async(std::launch::async, [&] {
    return host.WaitForScheduleProgress(nullptr);
  });
  assert(notification.wait_for(std::chrono::seconds(1)) == std::future_status::ready);
  assert(notification.get());
  const auto progress = host.DrainScheduleProgress();
  if (progress) std::fprintf(stderr, "pre-callback progress revision=%u epoch=%u sequence=%llu\n",
    progress->revision, progress->epoch,
    static_cast<unsigned long long>(progress->progress_sequence));
  assert(!progress);
}

void TestPrepareAutoRetiresCompletedRevision() {
  using daw::audio_host_macos::GraphRevisionStatusCode;
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 4, .channel_count = 2, .revision = 1,
  }));
  assert(host.PrepareAndPublishGraph(1, GraphSnapshot(1, 1.0F)));
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  assert(host.SetTransport(1, true, 0));
  std::array<float, 4> left{1, 1, 1, 1}, right{1, 1, 1, 1};
  std::array<float, 4> output_left{}, output_right{};
  const std::array<const float*, 2> input{left.data(), right.data()};
  const std::array<float*, 2> output{output_left.data(), output_right.data()};
  assert(host.ProcessPlanar(input, output, 4));
  assert(host.PrepareGraphRevision(2, GraphSnapshot(2, 0.25F)).code == GraphRevisionStatusCode::kPrepared);
  assert(host.SetTransport(1, true, 4, 137.0, 3, 4, false, 0.0, 0.0, 2));
  assert(host.InspectGraphRevision(2).prepared_revision == 2);
  assert(host.PublishGraphRevision(2).code == GraphRevisionStatusCode::kPublishPending);
  // Never reclaim or overwrite work that is still callback-owned.
  const auto pending = host.PrepareGraphRevision(3, GraphSnapshot(3, 0.5F));
  assert(pending.prepared_revision == 2 && pending.active_revision == 1);
  std::fprintf(stderr, "callback-owned prepare=%u\n", static_cast<unsigned>(pending.code));
  assert(pending.code == GraphRevisionStatusCode::kPublishPending);
  assert(host.ProcessPlanar(input, output, 4));
  const auto published = host.InspectGraphRevision(2);
  assert(published.code == GraphRevisionStatusCode::kPublished && published.retired_revision == 1);
  assert(output_left[0] == PublishedEdgeGain(1.0F, 0.25F, 1) && output_right[0] == PublishedEdgeGain(1.0F, 0.25F, 1));
  // No caller-owned retire is required once the predecessor's readers finish.
  const auto next = host.PrepareGraphRevision(3, GraphSnapshot(3, 0.5F));
  std::fprintf(stderr, "auto-retire prepare=%u retired=%u\n",
    static_cast<unsigned>(next.code), next.retired_revision);
  assert(next.code == GraphRevisionStatusCode::kPrepared);
  assert(next.retired_revision == 0 && next.active_revision == 2);
  assert(host.RollbackGraphRevision(3).code == GraphRevisionStatusCode::kRolledBack);
  assert(host.ProcessPlanar(input, output, 4));
  assert(output_left[0] == PublishedEdgeGain(1.0F, 0.25F, 5) && output_right[0] == PublishedEdgeGain(1.0F, 0.25F, 5));
  assert(host.diagnostics().transport_epoch == 1);
  host.Stop();
}

void TestActiveScheduleRefillsDuringGraphPreparation() {
  using daw::audio_host_macos::GraphRevisionStatusCode;
  for (const bool prepare_between_chunks : {false, true}) {
    daw::audio_host_macos::AudioHost host;
    assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
      .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
    assert(host.PrepareAndPublishGraph(1, GraphSnapshot(1, 1.F, 0, true)));
    assert(host.SetTransport(1, false, 0));
    assert(host.StartDiagnosticMode());
    assert(host.SetTransport(1, true, 0));
    auto first = ScheduleProcessorSetWindow(
      1, 1, 1, 0, 128, 77, DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB, 0, -6.F);
    WriteLeU32(first, 36, 2);
    const auto second = ScheduleWindow(1, 1, 1, 0, 128, 1, 2, false);
    if (prepare_between_chunks) assert(host.QueueScheduleWindow(first));
    assert(host.PrepareGraphRevision(2, GraphSnapshot(2, 1.F, 0, true)).code
      == GraphRevisionStatusCode::kPrepared);
    if (!prepare_between_chunks) {
      const bool accepted = host.QueueScheduleWindow(first);
      std::fprintf(stderr, "active refill during prepare accepted=%d\n", accepted);
      assert(accepted);
    }
    assert(host.QueueScheduleWindow(second));
    assert(host.QueueScheduleWindow(second));
    assert(!host.QueueScheduleWindow(ScheduleWindow(2, 1, 2, 128, 256, 0, 1, false)));
    assert(!host.QueueScheduleWindow(ScheduleWindow(1, 2, 2, 128, 256, 0, 1, false)));
    std::array<float, 128> input_samples{}, left{}, right{};
    input_samples.fill(1.F);
    const std::array<const float*, 2> input{input_samples.data(), input_samples.data()};
    const std::array<float*, 2> output{left.data(), right.data()};
    assert(host.ProcessPlanar(input, output, 128));
    assert(std::abs(left[127] - std::pow(10.F, -6.F / 20.F)) < 1e-6F);
    assert(host.diagnostics().active_revision == 1);
    assert(host.diagnostics().transport_frame == 128);
    assert(host.QueueScheduleWindow(ScheduleProcessorSetWindow(
      1, 1, 2, 128, 256, 77, DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB, 128, -12.F)));
    assert(host.PublishGraphRevision(2).code == GraphRevisionStatusCode::kPublishPending);
    assert(!host.QueueScheduleWindow(ScheduleWindow(1, 1, 3, 256, 384, 0, 1, false)));
    assert(host.ProcessPlanar(input, output, 128));
    assert(host.InspectGraphRevision(2).code == GraphRevisionStatusCode::kPublished);
    assert(std::abs(left[127] - std::pow(10.F, -12.F / 20.F)) < 1e-6F);
    assert(host.QueueScheduleWindow(ScheduleProcessorSetWindow(
      2, 1, 3, 256, 384, 77, DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB, 256, -18.F)));
    assert(host.ProcessPlanar(input, output, 128));
    assert(std::abs(left[127] - std::pow(10.F, -18.F / 20.F)) < 1e-6F);
    assert(host.diagnostics().transport_frame == 384);
    assert(host.diagnostics().transport_epoch == 1);
    assert(host.diagnostics().rejected_blocks == 0);
    host.Stop();
  }
}


// Prepared windows must not enter the active lanes before their graph seam.
void TestCheckpoint2StagedBank() {
  using daw::audio_host_macos::GraphRevisionStatusCode;
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  assert(host.PrepareAndPublishGraph(1, GraphSnapshot(1, 1.F, 0, true)));
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  assert(host.SetTransport(1, true, 0));
  assert(host.PrepareGraphRevision(2, GraphSnapshot(2, 1.F, 0, true), 256).code == GraphRevisionStatusCode::kPrepared);
  auto staged = ScheduleProcessorSetWindow(2, 1, 1, 256, 512, 77,
    DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB, 256, -12.F);
  std::vector<std::uint8_t> binding;
  AppendLeU32(binding, 2);  // Explicit prepared revision, zero for active.
  AppendLeU64(binding, 256);
  std::copy(binding.begin(), binding.end(), staged.begin() + 60);
  const auto accepted = host.QueueScheduleWindow(staged);
  std::fprintf(stderr, "checkpoint2 staged bank accepted=%u error=%.*s\n", accepted,
    static_cast<int>(host.scheduleWindowError().size()), host.scheduleWindowError().data());
  assert(accepted);
  std::vector<std::uint8_t> manual;
  AppendLeU32(manual, 1);
  AppendLeU64(manual, 77);
  AppendLeU32(manual, DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB);
  AppendLeU32(manual, 0);
  AppendLeFloat(manual, -6.F);
  assert(host.QueueParameterEvents(manual));
  host.Stop();
}


void TestCheckpoint2FuturePublication() {
  using daw::audio_host_macos::GraphRevisionStatusCode;
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  assert(host.PrepareAndPublishGraph(1, GraphSnapshot(1, 1.F, 0, true)));
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  assert(host.SetTransport(1, true, 0));
  assert(host.PrepareGraphRevision(2, GraphSnapshot(2, 1.F, 0, true), 256).code == GraphRevisionStatusCode::kPrepared);
  // Missing either side of the seam must not arm publication.
  assert(host.PublishGraphRevision(2).code == GraphRevisionStatusCode::kPublishPending);
  std::array<float, 128> signal{}, left{}, right{};
  signal.fill(1.F);
  const std::array<const float*, 2> input{signal.data(), signal.data()};
  const std::array<float*, 2> output{left.data(), right.data()};
  assert(host.ProcessPlanar(input, output, 128));
  std::fprintf(stderr, "checkpoint2 future active=%u expected=1\n", host.diagnostics().active_revision);
  assert(host.diagnostics().active_revision == 1);
  assert(host.QueueScheduleWindow(ScheduleWindow(1, 1, 1, 0, 256, 0, 1, false)));
  auto next = ScheduleProcessorSetWindow(2, 1, 1, 256, 512, 77,
    DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB, 256, -12.F);
  WriteLeU32(next, 60, 2);
  WriteLeU32(next, 64, 256);
  assert(host.QueueScheduleWindow(next));
  const std::array<std::uint8_t, 4> empty_states{};
  assert(host.ConfigureInstrumentStates(empty_states));
  assert(host.PublishGraphRevision(2).code == GraphRevisionStatusCode::kPublishPending);
  assert(host.ProcessPlanar(input, output, 128));
  assert(host.diagnostics().active_revision == 1);
  std::vector<std::uint8_t> pending_manual;
  AppendLeU32(pending_manual, 1);
  AppendLeU64(pending_manual, 77);
  AppendLeU32(pending_manual, DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB);
  AppendLeU32(pending_manual, 0);
  AppendLeFloat(pending_manual, -6.F);
  assert(host.QueueParameterEvents(pending_manual));
  assert(host.ProcessPlanar(input, output, 128));
  const auto proof = host.InspectGraphRevision(2);
  assert(proof.code == GraphRevisionStatusCode::kPublished && proof.publication_frame == 256);
  assert(host.diagnostics().transport_epoch == 1 && host.diagnostics().rejected_blocks == 0);
  for (const auto sample : left) assert(std::abs(sample - std::pow(10.F, -6.F / 20.F)) < 1e-6F);
  host.Stop();
}

void TestCheckpoint2LateFrame() {
  using daw::audio_host_macos::GraphRevisionStatusCode;
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  assert(host.PrepareAndPublishGraph(1, GraphSnapshot(1, 1.F)));
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  assert(host.SetTransport(1, true, 0));
  assert(host.PrepareGraphRevision(2, GraphSnapshot(2, 1.F), 128).code == GraphRevisionStatusCode::kPrepared);
  std::array<float, 128> silence{}, left{}, right{};
  const std::array<const float*, 2> input{silence.data(), silence.data()};
  const std::array<float*, 2> output{left.data(), right.data()};
  assert(host.ProcessPlanar(input, output, 128));
  assert(host.ProcessPlanar(input, output, 128));
  const auto late = host.PublishGraphRevision(2);
  std::fprintf(stderr, "checkpoint2 late code=%u expected=12\n", static_cast<unsigned>(late.code));
  assert(static_cast<unsigned>(late.code) == 12);
  assert(host.diagnostics().active_revision == 1 && host.diagnostics().transport_epoch == 1);
  const auto rendered_frame = host.diagnostics().transport_frame;
  host.Stop();
  assert(host.InspectGraphRevision(2).prepared_revision == 0);
  assert(host.diagnostics().active_revision == 1 && host.diagnostics().transport_frame == rendered_frame);
}

void TestCheckpoint2SeekCancelsUnpublished() {
  using daw::audio_host_macos::GraphRevisionStatusCode;
  for (const bool armed : {false, true}) {
    daw::audio_host_macos::AudioHost host;
    assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
      .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
    assert(host.PrepareAndPublishGraph(1, GraphSnapshot(1, 1.F)));
    assert(host.SetTransport(1, false, 0));
    assert(host.StartDiagnosticMode());
    assert(host.SetTransport(1, true, 0));
    assert(host.PrepareGraphRevision(2, GraphSnapshot(2, 1.F), 256).code == GraphRevisionStatusCode::kPrepared);
    if (armed) {
      assert(host.QueueScheduleWindow(ScheduleWindow(1, 1, 1, 0, 256, 0, 1, false)));
      auto staged = ScheduleWindow(2, 1, 1, 256, 512, 0, 1, false);
      WriteLeU32(staged, 60, 2);
      WriteLeU32(staged, 64, 256);
      assert(host.QueueScheduleWindow(staged));
      const std::array<std::uint8_t, 4> empty{};
      assert(host.ConfigureInstrumentStates(empty));
      assert(host.PublishGraphRevision(2).code == GraphRevisionStatusCode::kPublishPending);
    }
    const auto accepted = host.SetTransport(2, true, 1024);
    std::fprintf(stderr, "checkpoint2 seek accepted=%u expected=1\n", accepted);
    assert(accepted);
    assert(host.InspectGraphRevision(2).prepared_revision == 0);
    assert(host.diagnostics().active_revision == 1);
    host.Stop();
  }
}

void TestCheckpoint2HeldNoteSeam() {
  using daw::audio_host_macos::GraphRevisionStatusCode;
  daw::audio_host_macos::AudioHost edited, reference;
  for (auto* host : {&edited, &reference}) {
    assert(host->Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
      .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
    assert(host->PrepareGraphRevision(1, InstrumentGraphSnapshot(1)).code == GraphRevisionStatusCode::kPrepared);
    assert(host->ConfigureInstrumentStates(PackedSynthStatePayload(0.5F)));
    assert(host->PublishGraphRevision(1).code == GraphRevisionStatusCode::kPublished);
    assert(host->SetTransport(1, false, 0));
    assert(host->StartDiagnosticMode());
    assert(host->SetTransport(1, true, 0));
    auto active = ScheduleInstrumentWindow(1, 1, 1, 0, host == &edited ? 512 : 256, 0, 1, false, host == &edited ? 2 : 1);
    if (host == &edited) WriteLeU32(active, 72 + 48 + 28, 256);
    assert(host->QueueScheduleWindow(active));
  }
  assert(edited.PrepareGraphRevision(2, InstrumentGraphSnapshot(2), 256).code == GraphRevisionStatusCode::kPrepared);
  for (auto* host : {&edited, &reference}) {
    auto live_on = UrgentTransportRelease(1);
    WriteLeU32(live_on, 12, 100);
    WriteLeU32(live_on, 20, 100);
    WriteLeU32(live_on, 36, static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOn));
    WriteLeU32(live_on, 44, 60);
    const float velocity = 0.7F;
    std::memcpy(live_on.data() + 48, &velocity, sizeof(velocity));
    assert(host->QueueInstrumentEvents(live_on));
  }
  // A pending live release and manual override must be accepted while staging.
  auto live = UrgentTransportRelease(1);
  WriteLeU32(live, 36, static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOff));
  // Live note off for an absent handle is a safe no-op, no synthetic note-on.
  assert(edited.QueueInstrumentEvents(live));
  assert(reference.QueueInstrumentEvents(live));
  auto off = ScheduleInstrumentWindow(2, 1, 1, 256, 512, 0, 1, false, 1);
  WriteLeU32(off, 72 + 32, DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF);
  WriteLeU32(off, 60, 2);
  WriteLeU32(off, 64, 256);
  assert(edited.QueueScheduleWindow(off));
  WriteLeU32(off, 0, 1);
  WriteLeU32(off, 60, 0);
  WriteLeU32(off, 64, 0);
  WriteLeU32(off, 8, 2);
  assert(reference.QueueScheduleWindow(off));
  const std::array<std::uint8_t, 4> empty{};
  assert(edited.ConfigureInstrumentStates(empty));
  assert(edited.PublishGraphRevision(2).code == GraphRevisionStatusCode::kPublishPending);
  std::array<float, 128> silence{}, left{}, right{}, ref_left{}, ref_right{};
  const std::array<const float*, 2> input{silence.data(), silence.data()};
  const std::array<float*, 2> output{left.data(), right.data()}, ref_output{ref_left.data(), ref_right.data()};
  const auto events_before = observed_instrument_events;
  for (unsigned block = 0; block < 30; ++block) {
    if (block == 3) {
      auto live_off = UrgentTransportRelease(1);
      WriteLeU32(live_off, 12, 100);
      WriteLeU32(live_off, 20, 101);
      WriteLeU32(live_off, 36, static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOff));
      assert(edited.InspectGraphRevision(2).code == GraphRevisionStatusCode::kPublished);
      assert(edited.QueueInstrumentEvents(live_off));
      assert(reference.QueueInstrumentEvents(live_off));
    }
    assert(edited.ProcessPlanar(input, output, 128));
    assert(reference.ProcessPlanar(input, ref_output, 128));
    assert(left == ref_left && right == ref_right);
  }
  assert(edited.InspectGraphRevision(2).publication_frame == 256);
  // One scheduled on/off + live on/off + no-op release per host. The old-bank
  // note-on at the seam is never rendered, nor is the held voice retriggered.
  assert(observed_instrument_events - events_before == 10);
  assert(edited.diagnostics().rejected_blocks == 0);
  edited.Stop();
  reference.Stop();
}

void TestCheckpoint2CapacityAndPreparedTargets() {
  using daw::audio_host_macos::GraphRevisionStatusCode;
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  assert(host.PrepareAndPublishGraph(1, InstrumentGraphSnapshot(1)));
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  assert(host.SetTransport(1, true, 0));
  assert(host.PrepareGraphRevision(2, InstrumentGraphSnapshot(2), 256).code == GraphRevisionStatusCode::kPrepared);
  auto invalid = ScheduleInstrumentWindow(2, 1, 1, 256, 512, 0, 1, false, 1);
  WriteLeU32(invalid, 60, 2);
  WriteLeU32(invalid, 64, 256);
  WriteLeU32(invalid, 72, 999);
  assert(!host.QueueScheduleWindow(invalid));
  for (unsigned index = 0; index < 64; ++index) {
    auto full = ScheduleInstrumentWindow(2, 1, index + 1, 256 + 128 * index, 384 + 128 * index, 0, 1, false, 32);
    WriteLeU32(full, 60, 2);
    WriteLeU32(full, 64, 256);
    const bool full_accepted = host.QueueScheduleWindow(full);
    if (!full_accepted) std::fprintf(stderr, "bank fill index=%u error=%.*s\n", index,
      static_cast<int>(host.scheduleWindowError().size()), host.scheduleWindowError().data());
    assert(full_accepted);
  }
  auto overflow = ScheduleInstrumentWindow(2, 1, 65, 8448, 8576, 0, 1, false, 1);
  WriteLeU32(overflow, 60, 2);
  WriteLeU32(overflow, 64, 256);
  assert(!host.QueueScheduleWindow(overflow));
  assert(!host.QueueScheduleWindow(overflow));
  assert(host.QueueScheduleWindow(ScheduleWindow(1, 1, 1, 0, 128, 0, 1, false)));
  assert(host.RollbackGraphRevision(2).code == GraphRevisionStatusCode::kRolledBack);
  host.Stop();
}

void TestCheckpoint2RebaseAndShortBlocks() {
  using daw::audio_host_macos::GraphRevisionStatusCode;
  daw::audio_host_macos::AudioHost host;
  constexpr std::uint64_t origin = (1ULL << 33);
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  assert(host.PrepareAndPublishGraph(1, GraphSnapshot(1, 1.F, 0, true)));
  assert(host.SetTransport(1, false, origin));
  assert(host.StartDiagnosticMode());
  assert(host.SetTransport(1, true, origin));
  std::array<float, 128> signal{}, left{}, right{};
  signal.fill(1.F);
  const std::array<const float*, 2> input{signal.data(), signal.data()};
  const std::array<float*, 2> output{left.data(), right.data()};
  // Apply initial transport before selecting a seam relative to progress.
  assert(host.ProcessPlanar(input, output, 128));
  const auto first = origin + 256;
  assert(host.PrepareGraphRevision(2, GraphSnapshot(2, 1.F, 0, true), first).code == GraphRevisionStatusCode::kPrepared);
  auto staged = ScheduleProcessorSetWindow(2, 1, 1, first, first + 128, 77,
    DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB, first, -12.F);
  WriteLeU32(staged, 60, 2);
  WriteLeU32(staged, 64, static_cast<std::uint32_t>(first));
  WriteLeU32(staged, 68, static_cast<std::uint32_t>(first >> 32));
  assert(host.QueueScheduleWindow(staged));
  // A stale prepared event must never publish after its seam has passed.
  assert(host.ProcessPlanar(input, output, 128));
  assert(host.ProcessPlanar(input, output, 128));
  auto late = host.PublishGraphRevision(2, first);
  assert(late.code == GraphRevisionStatusCode::kRebaseRequired);
  assert(late.progress_frame == origin + 384 && late.transport_epoch == 1);
  const auto next = origin + 640;
  assert(host.PublishGraphRevision(2, next).code == GraphRevisionStatusCode::kPrepared);
  assert(!host.QueueScheduleWindow(staged));
  // Same window ID is valid in a rebased bank; all previous digests were discarded.
  auto rebased = ScheduleProcessorSetWindow(2, 1, 1, next, next + 256, 77,
    DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB, next, -18.F);
  WriteLeU32(rebased, 60, 2);
  WriteLeU32(rebased, 64, static_cast<std::uint32_t>(next));
  WriteLeU32(rebased, 68, static_cast<std::uint32_t>(next >> 32));
  assert(host.QueueScheduleWindow(rebased));
  const std::array<std::uint8_t, 4> empty{};
  assert(host.ConfigureInstrumentStates(empty));
  assert(host.QueueScheduleWindow(ScheduleWindow(1, 1, 1, origin, next, 0, 1, false)));
  assert(host.PublishGraphRevision(2, next).code == GraphRevisionStatusCode::kPublishPending);
  // Active-bank refills continue while the prepared bank is frozen.
  assert(host.QueueScheduleWindow(ScheduleWindow(1, 1, 2, next, next + 128, 0, 1, false)));
  assert(!host.QueueScheduleWindow(rebased));
  assert(host.ProcessPlanar(input, output, 96));
  assert(host.ProcessPlanar(input, output, 96));
  // This call crosses the seam. Native splits 64 old + 32 next frames.
  assert(host.ProcessPlanar(input, output, 96));
  const auto proof = host.InspectGraphRevision(2);
  assert(proof.code == GraphRevisionStatusCode::kPublished && proof.publication_frame == static_cast<std::int64_t>(next));
  std::fprintf(stderr, "rebase seam first=%f before=%f after=%f last=%f\n", left[0], left[63], left[64], left[95]);
  for (unsigned frame = 0; frame < 64; ++frame) assert(std::abs(left[frame] - 1.F) < 1e-6F);
  for (unsigned frame = 64; frame < 96; ++frame) assert(std::abs(left[frame] - std::pow(10.F, -18.F / 20.F)) < 1e-6F);
  assert(host.diagnostics().transport_epoch == 1 && host.diagnostics().rejected_blocks == 0);
  host.Stop();
}

void TestCheckpoint2RemovedTargetCancelsPendingLiveControl() {
  using daw::audio_host_macos::GraphRevisionStatusCode;
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  assert(host.PrepareGraphRevision(1, InstrumentGraphSnapshot(1)).code == GraphRevisionStatusCode::kPrepared);
  assert(host.ConfigureInstrumentStates(PackedSynthStatePayload(0.5F)));
  assert(host.PublishGraphRevision(1).code == GraphRevisionStatusCode::kPublished);
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  assert(host.SetTransport(1, true, 0));
  assert(host.QueueScheduleWindow(ScheduleWindow(1, 1, 1, 0, 256, 0, 1, false)));
  assert(host.PrepareGraphRevision(2, GraphSnapshot(2, 1.F), 256).code == GraphRevisionStatusCode::kPrepared);
  auto staged = ScheduleWindow(2, 1, 1, 256, 512, 0, 1, false);
  WriteLeU32(staged, 60, 2); WriteLeU32(staged, 64, 256);
  assert(host.QueueScheduleWindow(staged));
  const std::array<std::uint8_t, 4> empty{};
  assert(host.ConfigureInstrumentStates(empty));
  assert(host.PublishGraphRevision(2).code == GraphRevisionStatusCode::kPublishPending);
  std::array<float, 128> silence{}, left{}, right{};
  const std::array<const float*, 2> input{silence.data(), silence.data()};
  const std::array<float*, 2> output{left.data(), right.data()};
  assert(host.ProcessPlanar(input, output, 128));
  assert(host.ProcessPlanar(input, output, 128));
  auto removed_off = UrgentTransportRelease(1);
  WriteLeU32(removed_off, 36, static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOff));
  assert(host.QueueInstrumentEvents(removed_off));
  const auto before = observed_instrument_events;
  assert(host.ProcessPlanar(input, output, 128));
  assert(observed_instrument_events == before);
  assert(host.InspectGraphRevision(2).code == GraphRevisionStatusCode::kPublished);
  assert(host.diagnostics().rejected_blocks == 0);
  host.Stop();
}

void TestCheckpoint2SaturatedNoteOffSeam(const bool cancel_staged = false) {
  using namespace daw::audio_host_macos;
  std::array<float, 128> silence{}, left{}, right{};
  const std::array<const float*, 2> input{silence.data(), silence.data()};
  const std::array<float*, 2> output{left.data(), right.data()};
  std::vector<float> reference;
  for (const bool edit : {false, true}) {
    AudioHost host;
    assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
      .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
    assert(host.PrepareGraphRevision(1, InstrumentGraphSnapshot(1)).code == GraphRevisionStatusCode::kPrepared);
    assert(host.ConfigureInstrumentStates(PackedSynthStatePayload(0.5F)));
    assert(host.PublishGraphRevision(1).code == GraphRevisionStatusCode::kPublished);
    assert(host.SetTransport(1, false, 0));
    assert(host.StartDiagnosticMode());
    assert(host.SetTransport(1, true, 0));
    auto on = ScheduleInstrumentWindow(1, 1, 1, 0, 128, 0, 1, false, 1);
    WriteLeU32(on, 72 + 40, 60);
    assert(host.QueueScheduleWindow(on));
    assert(host.ProcessPlanar(input, output, 128));
    auto offs = ScheduleInstrumentWindow(1, 1, 2, 128, 256, 0, 1, false, 256);
    for (unsigned index = 0; index < 256; ++index) {
      WriteLeU32(offs, 72 + index * 48 + 28, 0);
      WriteLeU32(offs, 72 + index * 48 + 32, DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF);
      WriteLeU32(offs, 72 + index * 48 + 8, index == 255 ? 1 : 999 + index);
      WriteLeU32(offs, 72 + index * 48 + 40, 60);
    }
    assert(host.QueueScheduleWindow(offs));
    if (edit) {
      assert(host.PrepareGraphRevision(2, InstrumentGraphSnapshot(2), 256).code == GraphRevisionStatusCode::kPrepared);
      const std::array<std::uint8_t, 4> empty{};
      assert(host.ConfigureInstrumentStates(empty));
      auto staged = ScheduleWindow(2, 1, 1, 256, 512, 0, 1, false);
      WriteLeU32(staged, 60, 2);
      WriteLeU32(staged, 64, 256);
      assert(host.QueueScheduleWindow(staged));
      assert(host.PublishGraphRevision(2, 256).code == GraphRevisionStatusCode::kPublishPending);
    }
    auto live = UrgentTransportRelease(1);
    WriteLeU32(live, 12, 9999);
    WriteLeU32(live, 36, static_cast<unsigned>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOff));
    assert(host.QueueInstrumentEvents(live));
    const auto before = observed_instrument_events;
    for (unsigned block = 0; block < 102; ++block) {
      assert(host.ProcessPlanar(input, output, 128));
      if (!edit) {
        reference.insert(reference.end(), left.begin(), left.end());
        reference.insert(reference.end(), right.begin(), right.end());
      } else {
        if (block != 1) {
          for (unsigned frame = 0; frame < 128; ++frame) {
            assert(left[frame] == reference[block * 256 + frame]);
            assert(right[frame] == reference[block * 256 + 128 + frame]);
          }
        }
      }
      if (edit && cancel_staged && block == 0) {
        assert(host.SetTransport(1, false, 256));
        assert(host.InspectGraphRevision(2).prepared_revision == 0);
        assert(host.SetTransport(1, true, 256));
      }
      if (edit && block == 1 && cancel_staged) {
        assert(observed_instrument_events - before == 257);
        assert(host.diagnostics().active_revision == 1);
        for (unsigned frame = 0; frame < 128; ++frame) {
          assert(left[frame] == reference[block * 256 + frame]);
          assert(right[frame] == reference[block * 256 + 128 + frame]);
        }
      }
      if (edit && block == 1 && !cancel_staged) {
        const auto status = host.InspectGraphRevision(2);
        std::fprintf(stderr, "saturation seam code=%u active=%u events=%llu expected=257\n",
          static_cast<unsigned>(status.code), status.active_revision,
          static_cast<unsigned long long>(observed_instrument_events - before));
        assert(observed_instrument_events - before == 257);
        assert(status.code == GraphRevisionStatusCode::kRebaseRequired && status.active_revision == 1);
        for (unsigned frame = 0; frame < 128; ++frame) {
          assert(left[frame] == reference[block * 256 + frame]);
          assert(right[frame] == reference[block * 256 + 128 + frame]);
        }
        assert(status.transport_epoch == 1 && status.progress_frame == 384);
        assert(host.PublishGraphRevision(2, 640).code == GraphRevisionStatusCode::kPrepared);
        assert(host.QueueScheduleWindow(ScheduleWindow(1, 1, 3, 256, 640, 0, 1, false)));
        auto rebased = ScheduleWindow(2, 1, 1, 640, 896, 0, 1, false);
        WriteLeU32(rebased, 60, 2);
        WriteLeU32(rebased, 64, 640);
        assert(host.QueueScheduleWindow(rebased));
        assert(host.PublishGraphRevision(2, 640).code == GraphRevisionStatusCode::kPublishPending);
      }
    }
    float energy = 0;
    for (const auto sample : left) energy += std::abs(sample);
    for (const auto sample : right) energy += std::abs(sample);
    std::fprintf(stderr, "saturation edited=%u cancelled=%u events=%llu expected=257 final_energy=%g\n", edit, cancel_staged,
      static_cast<unsigned long long>(observed_instrument_events - before), energy);
    assert(observed_instrument_events - before == 257 && energy == 0);
    if (edit && !cancel_staged) {
      const auto proof = host.InspectGraphRevision(2);
      assert(proof.code == GraphRevisionStatusCode::kPublished && proof.publication_frame == 640);
      assert(proof.transport_epoch == 1);
    }
  }
}

void TestCheckpoint2SaturatedRebaseProgress() {
  using namespace daw::audio_host_macos;
  AudioHost host;
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  assert(host.PrepareGraphRevision(1, InstrumentGraphSnapshot(1)).code == GraphRevisionStatusCode::kPrepared);
  assert(host.ConfigureInstrumentStates(PackedSynthStatePayload(0.5F)));
  assert(host.PublishGraphRevision(1).code == GraphRevisionStatusCode::kPublished);
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  assert(host.SetTransport(1, true, 0));
  assert(host.QueueScheduleWindow(ScheduleWindow(1, 1, 1, 0, 128, 0, 1, false)));
  std::array<float, 128> silence{}, left{}, right{};
  const std::array<const float*, 2> input{silence.data(), silence.data()};
  const std::array<float*, 2> output{left.data(), right.data()};
  assert(host.ProcessPlanar(input, output, 128));
  for (unsigned chunk = 0; chunk < 8; ++chunk) {
    auto offs = ScheduleInstrumentWindow(1, 1, 2, 128, 256, chunk, 8, false, 256);
    for (unsigned index = 0; index < 256; ++index) {
      WriteLeU32(offs, 72 + index * 48 + 16, chunk * 256 + index + 1);
      WriteLeU32(offs, 72 + index * 48 + 28, 0);
      WriteLeU32(offs, 72 + index * 48 + 32, DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF);
    }
    assert(host.QueueScheduleWindow(offs));
  }
  const std::array<std::uint8_t, 4> empty{};
  assert(host.PrepareGraphRevision(2, InstrumentGraphSnapshot(2), 256).code == GraphRevisionStatusCode::kPrepared);
  assert(host.ConfigureInstrumentStates(empty));
  auto staged = ScheduleWindow(2, 1, 1, 256, 512, 0, 1, false);
  WriteLeU32(staged, 60, 2);
  WriteLeU32(staged, 64, 256);
  assert(host.QueueScheduleWindow(staged));
  assert(host.PublishGraphRevision(2, 256).code == GraphRevisionStatusCode::kPublishPending);
  // Live controls fill every slot before the seam, leaving all 2048 scheduled
  // records pending. Continue refilling live traffic whenever credits return.
  std::vector<std::uint8_t> live;
  AppendLeU32(live, 256);
  for (unsigned index = 0; index < 256; ++index) {
    auto event = UrgentTransportRelease(1);
    WriteLeU32(event, 12, 9999 + index);
    WriteLeU32(event, 20, index + 1);
    WriteLeU32(event, 36, static_cast<unsigned>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOff));
    live.insert(live.end(), event.begin() + 4, event.end());
  }
  assert(host.QueueInstrumentEvents(live));
  assert(host.ProcessPlanar(input, output, 128));
  assert(host.QueueInstrumentEvents(live));
  const auto before = observed_instrument_events;
  assert(host.ProcessPlanar(input, output, 128));
  assert(host.InspectGraphRevision(2).code == GraphRevisionStatusCode::kRebaseRequired);
  constexpr unsigned retry_frame = 1408;  // Nine blocks beyond fresh frame 256.
  assert(host.PublishGraphRevision(2, retry_frame).code == GraphRevisionStatusCode::kPrepared);
  assert(host.QueueScheduleWindow(ScheduleWindow(1, 1, 3, 256, retry_frame, 0, 1, false)));
  auto rebased = ScheduleWindow(2, 1, 1, retry_frame, retry_frame + 256, 0, 1, false);
  WriteLeU32(rebased, 60, 2);
  WriteLeU32(rebased, 64, retry_frame);
  assert(host.QueueScheduleWindow(rebased));
  assert(host.PublishGraphRevision(2, retry_frame).code == GraphRevisionStatusCode::kPublishPending);
  unsigned accepted_live_refills = 0;
  for (unsigned block = 1; block < 8; ++block) {
    // A full urgent queue rejects this refill without losing its accepted
    // controls. Either way it remains full while the scheduled backlog drains.
    if (host.QueueInstrumentEvents(live)) ++accepted_live_refills;
    assert(host.ProcessPlanar(input, output, 128));
  }
  // No urgent refill succeeded, so these are the 2048 scheduled records,
  // not live events masking an undrained scheduled backlog.
  std::fprintf(stderr, "saturation sustained events=%llu expected=2048 blocks=8 live_refills=%u\n",
    static_cast<unsigned long long>(observed_instrument_events - before),
    accepted_live_refills);
  assert(accepted_live_refills == 0 && observed_instrument_events - before == 2048);
  for (unsigned block = 0; block < 3; ++block) {
    assert(host.ProcessPlanar(input, output, 128));
    if (block == 0) assert(host.QueueInstrumentEvents(live));
  }
  const auto proof = host.InspectGraphRevision(2);
  std::fprintf(stderr, "saturation sustained code=%u publication=%lld expected=1408\n",
    static_cast<unsigned>(proof.code), static_cast<long long>(proof.publication_frame));
  assert(proof.code == GraphRevisionStatusCode::kPublished && proof.publication_frame == retry_frame);
  assert(observed_instrument_events - before == 2048 + 512);
  assert(proof.transport_epoch == 1 && host.diagnostics().rejected_blocks == 0);
}

void TestCheckpoint2OutOfOrderChunksAndCancellation() {
  using namespace daw::audio_host_macos;
  for (const bool cancel : {false, true}) {
    AudioHost host;
    assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
      .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
    assert(host.PrepareGraphRevision(1, InstrumentGraphSnapshot(1)).code == GraphRevisionStatusCode::kPrepared);
    assert(host.ConfigureInstrumentStates(PackedSynthStatePayload(0.5F)));
    assert(host.PublishGraphRevision(1).code == GraphRevisionStatusCode::kPublished);
    assert(host.SetTransport(1, false, 0));
    assert(host.StartDiagnosticMode());
    assert(host.SetTransport(1, true, 0));
    // The future chunk arrives first. It must not hide a pre-seam event in
    // the same accepted window, either during drainage or staged cancellation.
    for (const unsigned chunk : {1U, 0U}) {
      auto window = ScheduleInstrumentWindow(1, 1, 1, 0, 512, chunk, 2, false, 1);
      WriteLeU32(window, 72 + 28, chunk == 1 ? 300 : 0);
      WriteLeU32(window, 72 + 32, DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF);
      WriteLeU32(window, 72 + 16, chunk + 1);
      assert(host.QueueScheduleWindow(window));
    }
    assert(host.PrepareGraphRevision(2, InstrumentGraphSnapshot(2), 256).code == GraphRevisionStatusCode::kPrepared);
    const std::array<std::uint8_t, 4> empty{};
    assert(host.ConfigureInstrumentStates(empty));
    auto staged = ScheduleWindow(2, 1, 1, 256, 512, 0, 1, false);
    WriteLeU32(staged, 60, 2);
    WriteLeU32(staged, 64, 256);
    assert(host.QueueScheduleWindow(staged));
    assert(host.PublishGraphRevision(2, 256).code == GraphRevisionStatusCode::kPublishPending);
    if (cancel) {
      // Same-epoch pause cancels only staging. Real seek's new epoch
      // intentionally invalidates old-epoch notes, not a bank-switch loss.
      assert(host.SetTransport(1, false, 0));
      assert(host.InspectGraphRevision(2).prepared_revision == 0);
      assert(host.SetTransport(1, true, 0));
    }
    std::array<float, 128> silence{}, left{}, right{};
    const std::array<const float*, 2> input{silence.data(), silence.data()};
    const std::array<float*, 2> output{left.data(), right.data()};
    const auto before = observed_instrument_events;
    assert(host.ProcessPlanar(input, output, 128));
    std::fprintf(stderr, "saturation unordered cancel=%u first_block_events=%llu expected=1\n",
      cancel, static_cast<unsigned long long>(observed_instrument_events - before));
    assert(observed_instrument_events - before == 1);
    assert(host.ProcessPlanar(input, output, 128));
    assert(host.ProcessPlanar(input, output, 128));
    if (cancel) {
      assert(observed_instrument_events - before == 2);
      assert(host.diagnostics().active_revision == 1);
    } else {
      assert(observed_instrument_events - before == 1);
      assert(host.InspectGraphRevision(2).code == GraphRevisionStatusCode::kPublished);
    }
  }
}

// Checkpoint 3 failure inventory: prepared-only visibility; queued/source and
// mapped-page lifetime; rollback ownership; graph retirement independent from
// resource retirement; immutable stable IDs; bounded resource admission.
std::vector<std::uint8_t> Checkpoint3Source(const unsigned asset, const unsigned start = 0,
  const unsigned stop = 16, const unsigned sequence = 1) {
  std::vector<std::uint8_t> bytes;
  AppendLeU32(bytes, 1);
  AppendLeU32(bytes, 1); AppendLeU64(bytes, sequence); AppendLeU64(bytes, 1); AppendLeU32(bytes, asset);
  AppendLeU64(bytes, start); AppendLeU64(bytes, stop);
  AppendLeU64(bytes, 0); AppendLeU64(bytes, stop - start); AppendLeFloat(bytes, 1.F);
  AppendLeU64(bytes, 0); AppendLeU64(bytes, 0);
  AppendLeU64(bytes, stop); AppendLeU64(bytes, stop);
  AppendLeFloat(bytes, 0.F); AppendLeFloat(bytes, 0.F); AppendLeFloat(bytes, 0.5F);
  AppendLeFloat(bytes, 0.F); AppendLeFloat(bytes, 0.5F);
  return bytes;
}

void TestCheckpoint3SourceSeam(const char failure, const unsigned cancellation = 0) {
  using namespace daw::audio_host_macos;
  AudioHost host;
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  assert(host.PrepareAndPublishGraph(1, GraphSnapshot(1, 1.F)));
  std::array<float, 4096> pcm{};
  for (unsigned channel = 0; channel < 2; ++channel)
    for (unsigned frame = 0; frame < 2048; ++frame)
      pcm[channel * 2048 + frame] = 0.125F + frame / 16384.F;
  assert(host.InstallAsset(1, 2048, 48000, 2, 1, pcm));
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  assert(host.SetTransport(1, true, 0));
  assert(host.QueueSourceEvents(Checkpoint3Source(1, 0, failure == 'h' ? 257 : 1536)));
  std::array<float, 128> silence{}, left{}, right{};
  const std::array<const float*, 2> input{silence.data(), silence.data()};
  const std::array<float*, 2> output{left.data(), right.data()};
  const auto render = [&] { assert(host.ProcessPlanar(input, output, 128)); };
  render();
  assert(left[127] == pcm[127]);
  assert(host.PrepareGraphRevision(2, GraphSnapshot(2, 1.F), 256).code == GraphRevisionStatusCode::kPrepared);
  observe_context = true;
  context_applications = 0;
  assert(host.SetTransport(1, true, 0, 137.0, 3, 4, false, 0, 0, 2));
  assert(context_applications == 0);
  if (failure == 'e') {
    auto replacement = pcm;
    for (auto& sample : replacement) sample += 0.25F;
    assert(host.InstallAsset(2, 2048, 48000, 2, 2, replacement));
  }
  assert(host.QueueScheduleWindow(ScheduleWindow(1, 1, 1, 0, 256, 0, 1, false)));
  auto staged = ScheduleWindow(2, 1, 1, 256, 1536, 0, 1, false);
  WriteLeU32(staged, 60, 2); WriteLeU32(staged, 64, 256);
  if (failure != 'a' && failure != 'f' && failure != 'g' && failure != 'h' && failure != 'i') {
    WriteLeU32(staged, 48, 1);
    auto source = Checkpoint3Source(failure == 'e' ? 2 : 1, failure == 'c' ? 0 : 256, 1536, 2);
    const unsigned offset = failure == 'b' ? 512 : failure == 'd' ? 768 : 256;
    WriteLeU32(source, 4 + 40, failure == 'c' ? 0 : offset);
    staged.insert(staged.end(), source.begin() + 4, source.end());
  }
  assert(host.QueueScheduleWindow(staged));
  const std::array<std::uint8_t, 4> empty{};
  assert(host.ConfigureInstrumentStates(empty));
  if (cancellation == 2) {
    assert(host.PublishGraphRevision(2, 512).code == GraphRevisionStatusCode::kPrepared);
    // Rebase discards the old seam declarations, without touching live cursors.
    render(); render(); render();
    for (unsigned frame = 0; frame < 128; ++frame) assert(left[frame] == pcm[384 + frame]);
    assert(host.diagnostics().active_revision == 1);
    assert(context_applications == 0);
    observe_context = false;
    assert(host.RollbackGraphRevision(2).code == GraphRevisionStatusCode::kRolledBack);
    render();
    for (unsigned frame = 0; frame < 128; ++frame) assert(left[frame] == pcm[512 + frame]);
    host.Stop();
    return;
  }
  const bool unchanged = failure == 'c' || failure == 'f' || cancellation == 1;
  if (failure == 'f' || cancellation == 1) {
    assert(host.RollbackGraphRevision(2).code == GraphRevisionStatusCode::kRolledBack);
  } else if (failure == 'g') {
    assert(host.SetTransport(2, true, 1024));
    render();
    for (auto sample : left) assert(sample == 0.F);
    assert(host.InspectGraphRevision(2).prepared_revision == 0);
    assert(host.diagnostics().transport_frame == 1152);
    assert(context_applications == 0);
    observe_context = false;
    host.Stop();
    return;
  } else {
    assert(host.PublishGraphRevision(2, 256).code == GraphRevisionStatusCode::kPublishPending);
  }
  render();
  for (unsigned frame = 0; frame < 128; ++frame) assert(left[frame] == pcm[128 + frame]);
  assert(context_applications == 0);
  render();
  if (failure != 'f' && cancellation != 1) {
    assert(context_applications == 1 && context_frame == 256);
    assert(context_bpm == 137.0 && context_numerator == 3 && context_denominator == 4);
  } else assert(context_applications == 0);
  observe_context = false;
  if (failure != 'f' && cancellation != 1) {
    const auto proof = host.InspectGraphRevision(2);
    assert(proof.code == GraphRevisionStatusCode::kPublished && proof.publication_frame == 256);
  }
  // The first seam sample must not jump, even for deletion/replacement.
  assert(left[0] == pcm[256]);
  for (unsigned frame = 0; frame < 128; ++frame) {
    const float mix = frame / 288.F;
    const float replacement = failure == 'b' ? pcm[512 + frame]
      : failure == 'd' ? pcm[768 + frame]
      : failure == 'e' ? pcm[256 + frame] + 0.25F : 0.F;
    const float expected = unchanged ? pcm[256 + frame]
      : pcm[failure == 'h' ? 256 : 256 + frame] * (1.F - mix) + replacement * mix;
    assert(std::abs(left[frame] - expected) < 1e-7F);
  }
  if (unchanged)
    for (unsigned frame = 0; frame < 128; ++frame) assert(left[frame] == pcm[256 + frame]);
  if (failure == 'i') {
    assert(host.PrepareGraphRevision(3, GraphSnapshot(3, 1.F), 512).code == GraphRevisionStatusCode::kPrepared);
    auto readded = ScheduleWindow(3, 1, 1, 512, 1536, 0, 1, false);
    WriteLeU32(readded, 60, 3); WriteLeU32(readded, 64, 512); WriteLeU32(readded, 48, 1);
    auto source = Checkpoint3Source(1, 512, 1536, 2);
    WriteLeU32(source, 44, 512);
    readded.insert(readded.end(), source.begin() + 4, source.end());
    assert(host.QueueScheduleWindow(readded));
    assert(host.ConfigureInstrumentStates(empty));
    assert(host.PublishGraphRevision(3, 512).code == GraphRevisionStatusCode::kPublishPending);
    render(); render();
    assert(host.InspectGraphRevision(3).code == GraphRevisionStatusCode::kPublished);
    assert(std::abs(left[0] - pcm[512] * (1.F - 256.F / 288.F)) < 1e-7F);
    host.Stop();
    return;
  }
  if (failure == 'e' && cancellation == 0) {
    assert(host.RetireGraphRevision(1).code == GraphRevisionStatusCode::kRetired);
    assert(host.ReleaseAsset(1));
    host.ProcessNativeVstControl();
    assert(host.diagnostics().installed_assets == 2); // Tail still owns old PCM.
  }
  render(); // 384..511
  render(); // 512..639, termination ends at 544.
  for (unsigned frame = 32; frame < 128; ++frame) {
    const unsigned absolute = 512 + frame;
    const float expected = unchanged ? pcm[absolute] : failure == 'a' || failure == 'h' ? 0.F
      : failure == 'b' ? pcm[absolute + 256]
      : failure == 'd' ? pcm[absolute + 512]
      : pcm[absolute] + (failure == 'e' ? 0.25F : 0.F);
    if (left[frame] != expected) {
      std::fprintf(stderr, "source seam %c frame=%u actual=%g expected=%g\n",
        failure, absolute, left[frame], expected);
    }
    assert(left[frame] == expected);
  }
  if (failure == 'e' && cancellation == 0) {
    for (unsigned block = 0; block < 3; ++block) { host.ProcessNativeVstControl(); render(); }
    host.ProcessNativeVstControl();
    assert(host.diagnostics().installed_assets == 1);
  }
  assert(host.diagnostics().transport_epoch == 1 && host.diagnostics().rejected_blocks == 0);
  host.Stop();
  std::fprintf(stderr, "source seam %c PASS\n", failure);
}

void TestCheckpoint3RemovedSourceNodeReaddition() {
  using namespace daw::audio_host_macos;
  for (const bool future : {false, true}) {
    AudioHost host;
    assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
      .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
    assert(host.PrepareAndPublishGraph(1, FanInGraphSnapshot(1, {{1, 0}})));
    std::array<float, 4096> pcm{};
    for (unsigned channel = 0; channel < 2; ++channel)
      for (unsigned frame = 0; frame < 2048; ++frame)
        pcm[channel * 2048 + frame] = 0.125F + frame / 16384.F;
    assert(host.InstallAsset(1, 2048, 48000, 2, 1, pcm));
    assert(host.SetTransport(1, false, 0));
    assert(host.StartDiagnosticMode());
    assert(host.SetTransport(1, true, 0));
    assert(host.QueueSourceEvents(Checkpoint3Source(1, 0, 1536)));
    std::array<float, 128> silence{}, left{}, right{};
    const std::array<const float*, 2> input{silence.data(), silence.data()};
    const std::array<float*, 2> output{left.data(), right.data()};
    const auto render = [&] { assert(host.ProcessPlanar(input, output, 128)); };
    render();
    assert(left[127] == pcm[127] * 0.25F);
    const unsigned removal = future ? 256 : 0;
    assert(host.PrepareGraphRevision(2, EdgeGraphSnapshot(2, {}, {}), removal).code
      == GraphRevisionStatusCode::kPrepared);
    const std::array<std::uint8_t, 4> empty{};
    assert(host.ConfigureInstrumentStates(empty));
    if (future) {
      assert(host.QueueScheduleWindow(ScheduleWindow(1, 1, 1, 0, 256, 0, 1, false)));
      auto next = ScheduleWindow(2, 1, 1, 256, 1024, 0, 1, false);
      WriteLeU32(next, 60, 2); WriteLeU32(next, 64, 256);
      assert(host.QueueScheduleWindow(next));
    }
    assert(host.PublishGraphRevision(2, removal).code == GraphRevisionStatusCode::kPublishPending);
    if (future) render();
    render();
    const auto removed = host.InspectGraphRevision(2);
    assert(removed.code == GraphRevisionStatusCode::kPublished);
    render(); // Node's 5 ms deletion fade has completed.
    if (!future) render(); // Both variants reach native frame 512.
    assert(host.diagnostics().transport_frame == 512);
    // Re-add before the original stop and, for future publication, before its
    // longer source termination tail completes. The same ID is a new node.
    assert(host.PrepareGraphRevision(3, FanInGraphSnapshot(3, {{1, 0}})).code
      == GraphRevisionStatusCode::kPrepared);
    assert(host.ConfigureInstrumentStates(empty));
    assert(host.PublishGraphRevision(3).code == GraphRevisionStatusCode::kPublishPending);
    render();
    assert(host.InspectGraphRevision(3).code == GraphRevisionStatusCode::kPublished);
    std::fprintf(stderr, "source node readd h future=%u old-only=%g expected=0\n", future, left[0]);
    for (auto sample : left) assert(sample == 0.F);
    // An explicitly changed clip must not be suppressed by any old cursor.
    auto source = Checkpoint3Source(1, 640, 1152, 2);
    WriteLeU32(source, 44, 1024);
    assert(host.QueueSourceEvents(source));
    render();
    for (unsigned frame = 0; frame < 128; ++frame)
      assert(left[frame] == pcm[1024 + frame] * 0.25F);
    render();
    for (unsigned frame = 0; frame < 128; ++frame)
      assert(left[frame] == pcm[1152 + frame] * 0.25F);
    assert(host.diagnostics().transport_epoch == 1 && host.diagnostics().rejected_blocks == 0);
    host.Stop();
  }
}

void TestCheckpoint3RapidNodeReaddition() {
  using namespace daw::audio_host_macos;
  for (const bool remove_again : {false, true}) {
    AudioHost host;
    assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
      .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
    assert(host.PrepareAndPublishGraph(1, FanInGraphSnapshot(1, {{1, 0}})));
    std::array<float, 4096> pcm{};
    for (unsigned channel = 0; channel < 2; ++channel)
      for (unsigned frame = 0; frame < 2048; ++frame)
        pcm[channel * 2048 + frame] = 0.125F + frame / 16384.F;
    assert(host.InstallAsset(1, 2048, 48000, 2, 1, pcm));
    assert(host.SetTransport(1, false, 0));
    assert(host.StartDiagnosticMode());
    assert(host.SetTransport(1, true, 0));
    assert(host.QueueSourceEvents(Checkpoint3Source(1, 0, 1536)));
    std::array<float, 128> silence{}, left{}, right{};
    const std::array<const float*, 2> input{silence.data(), silence.data()};
    const std::array<float*, 2> output{left.data(), right.data()};
    const auto render = [&] { assert(host.ProcessPlanar(input, output, 128)); };
    render();
    assert(left[127] == pcm[127] * 0.25F);
    constexpr unsigned removal = 256;
    assert(host.PrepareGraphRevision(2, EdgeGraphSnapshot(2, {}, {}), removal).code
      == GraphRevisionStatusCode::kPrepared);
    const std::array<std::uint8_t, 4> empty{};
    assert(host.ConfigureInstrumentStates(empty));
    {
      assert(host.QueueScheduleWindow(ScheduleWindow(1, 1, 1, 0, 256, 0, 1, false)));
      auto next = ScheduleWindow(2, 1, 1, 256, 1024, 0, 1, false);
      WriteLeU32(next, 60, 2); WriteLeU32(next, 64, 256);
      assert(host.QueueScheduleWindow(next));
    }
    assert(host.PublishGraphRevision(2, removal).code == GraphRevisionStatusCode::kPublishPending);
    render();
    render();
    const auto removed = host.InspectGraphRevision(2);
    assert(removed.code == GraphRevisionStatusCode::kPublished);
    const float before = left[127];
    assert(host.diagnostics().transport_frame == 384);
    // Re-add before the original stop and, for future publication, before its
    // longer source termination tail completes. The same ID is a new node.
    assert(host.PrepareGraphRevision(3, FanInGraphSnapshot(3, {{1, 0}})).code
      == GraphRevisionStatusCode::kPrepared);
    assert(host.ConfigureInstrumentStates(empty));
    assert(host.PublishGraphRevision(3).code == GraphRevisionStatusCode::kPublishPending);
    assert(host.ProcessPlanar(input, output, 64));
    assert(host.InspectGraphRevision(3).code == GraphRevisionStatusCode::kPublished);
    std::fprintf(stderr, "P2-3 before=%g after=%g\n", before, left[0]);
    const float fade_slope = pcm[383] * 0.25F * (1.F - 127.F / 240.F) * (1.F - 127.F / 288.F)
      - pcm[384] * 0.25F * (1.F - 128.F / 240.F) * (1.F - 128.F / 288.F);
    assert(std::abs(left[0] - before) <= std::abs(fade_slope) + 1e-7F);
    for (unsigned frame = 0; frame < 64; ++frame) {
      const float expected = pcm[384 + frame] * 0.25F
        * (1.F - (128.F + frame) / 240.F) * (1.F - (128.F + frame) / 288.F);
      assert(std::abs(left[frame] - expected) < 1e-7F);
    }
    if (remove_again) {
      assert(host.PrepareGraphRevision(4, EdgeGraphSnapshot(4, {}, {})).code
        == GraphRevisionStatusCode::kPrepared);
      assert(host.ConfigureInstrumentStates(empty));
      assert(host.PublishGraphRevision(4).code == GraphRevisionStatusCode::kPublishPending);
    }
    render(); // 448..575, the original ghost must finish without restarting.
    for (unsigned frame = 0; frame < 128; ++frame) {
      const float expected = frame >= 48 ? 0.F : pcm[448 + frame] * 0.25F
        * (1.F - (192.F + frame) / 240.F) * (1.F - (192.F + frame) / 288.F);
      assert(std::abs(left[frame] - expected) < 1e-7F);
    }
    if (remove_again) { host.Stop(); continue; }
    assert(host.ProcessPlanar(input, output, 64)); // Reach frame 640.
    // An explicitly changed clip must not be suppressed by any old cursor.
    auto source = Checkpoint3Source(1, 640, 1152, 2);
    WriteLeU32(source, 44, 1024);
    assert(host.QueueSourceEvents(source));
    render();
    for (unsigned frame = 0; frame < 128; ++frame)
      assert(left[frame] == pcm[1024 + frame] * 0.25F);
    render();
    for (unsigned frame = 0; frame < 128; ++frame)
      assert(left[frame] == pcm[1152 + frame] * 0.25F);
    assert(host.diagnostics().transport_epoch == 1 && host.diagnostics().rejected_blocks == 0);
    host.Stop();
  }
}

void TestCheckpoint3SourceSeamCapacity() {
  using namespace daw::audio_host_macos;
  AudioHost host;
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 4, .channel_count = 2, .revision = 1}));
  assert(host.PrepareAndPublishGraph(1, GraphSnapshot(1, 1.F)));
  std::array<float, 4096> pcm{};
  pcm.fill(0.0005F);
  assert(host.InstallAsset(1, 2048, 48000, 2, 1, pcm));
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  assert(host.SetTransport(1, true, 0));
  auto sources = Checkpoint3Source(1, 0, 1024, 1);
  WriteLeU32(sources, 0, 256);
  for (unsigned index = 1; index < 256; ++index) {
    const auto source = Checkpoint3Source(1, 0, 1024, index + 1);
    sources.insert(sources.end(), source.begin() + 4, source.end());
  }
  assert(host.QueueSourceEvents(sources));
  std::array<float, 4> silence{}, left{}, right{};
  const std::array<const float*, 2> input{silence.data(), silence.data()};
  const std::array<float*, 2> output{left.data(), right.data()};
  const auto render = [&] { assert(host.ProcessPlanar(input, output, 4)); };
  render();
  assert(host.PrepareGraphRevision(2, GraphSnapshot(2, 1.F), 8).code == GraphRevisionStatusCode::kPrepared);
  assert(host.QueueScheduleWindow(ScheduleWindow(1, 1, 1, 0, 8, 0, 1, false)));
  auto staged = ScheduleWindow(2, 1, 1, 8, 16, 0, 1, false);
  WriteLeU32(staged, 60, 2); WriteLeU32(staged, 64, 8); WriteLeU32(staged, 48, 257);
  for (unsigned index = 0; index < 257; ++index) {
    auto source = Checkpoint3Source(1, 8, 1032, 257 + index);
    WriteLeU32(source, 44, 128);
    staged.insert(staged.end(), source.begin() + 4, source.end());
  }
  assert(!host.QueueScheduleWindow(staged)); // No partial bank mutation.
  WriteLeU32(staged, 48, 256); staged.resize(staged.size() - 112);
  assert(host.QueueScheduleWindow(staged));
  const std::array<std::uint8_t, 4> empty{};
  assert(host.ConfigureInstrumentStates(empty));
  assert(host.PublishGraphRevision(2, 8).code == GraphRevisionStatusCode::kPublishPending);
  render(); render();
  assert(host.InspectGraphRevision(2).code == GraphRevisionStatusCode::kPublished);
  // Another seam cannot truncate occupied tails to manufacture capacity.
  assert(host.PrepareGraphRevision(3, GraphSnapshot(3, 1.F), 16).code == GraphRevisionStatusCode::kPrepared);
  assert(host.ConfigureInstrumentStates(empty));
  auto next = ScheduleWindow(3, 1, 1, 16, 24, 0, 1, false);
  WriteLeU32(next, 60, 3); WriteLeU32(next, 64, 16);
  assert(host.QueueScheduleWindow(next));
  assert(host.PublishGraphRevision(3, 16).code == GraphRevisionStatusCode::kPublishPending);
  render(); render();
  assert(host.InspectGraphRevision(3).code == GraphRevisionStatusCode::kRebaseRequired);
  assert(host.diagnostics().active_revision == 2);
  assert(left[0] > 0.12F); // Existing cursors and tails were not stopped early.
  assert(host.RollbackGraphRevision(3).code == GraphRevisionStatusCode::kRolledBack);
  // No successful deletion/replacement reset the source sequence floor.
  assert(host.QueueSourceEvents(Checkpoint3Source(1, 24, 28, 512)));
  assert(!host.ProcessPlanar(input, output, 4));
  host.Stop();
  std::fprintf(stderr, "source seam capacity and sequence floor PASS\n");
}

// Each changed origin must occupy all 256 tail slots at 384. Deleting the
// replacements at 640 must rebase (12), not discard the still-audible tails.
void TestCheckpoint3WireOrigin(const unsigned mode) {
  using namespace daw::audio_host_macos;
  AudioHost host;
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  assert(host.PrepareAndPublishGraph(1, GraphSnapshot(1, 1.F)));
  std::array<float, 4096> pcm{};
  pcm.fill(0.0005F);
  assert(host.InstallAsset(1, 2048, 44100, 2, 1, pcm));
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  assert(host.SetTransport(1, true, 0));
  const auto source = [&](const unsigned sequence, const bool changed) {
    auto bytes = Checkpoint3Source(1, changed && mode == 4 ? 320 : 0, 1536, sequence);
    WriteLeU32(bytes, 44, changed ? mode == 1 ? 1 : mode == 4 ? 294 : 0 : 0);
    std::vector<std::uint8_t> fraction;
    // Exercise the colliding adjacent pair in both directions.
    AppendLeFloat(fraction, (mode == 2 && !changed) || (mode == 3 && changed)
      ? std::nextafter(0.1F, 0.F) : 0.1F);
    std::copy(fraction.begin(), fraction.end(), bytes.begin() + 96);
    return bytes;
  };
  auto initial = source(1, false);
  WriteLeU32(initial, 0, 256);
  for (unsigned index = 1; index < 256; ++index) {
    const auto bytes = source(index + 1, false);
    initial.insert(initial.end(), bytes.begin() + 4, bytes.end());
  }
  assert(host.QueueSourceEvents(initial));
  std::array<float, 128> silence{}, left{}, right{};
  const std::array<const float*, 2> input{silence.data(), silence.data()};
  const std::array<float*, 2> output{left.data(), right.data()};
  const auto render = [&] { assert(host.ProcessPlanar(input, output, 128)); };
  render();
  assert(host.PrepareGraphRevision(2, GraphSnapshot(2, 1.F), 384).code == GraphRevisionStatusCode::kPrepared);
  assert(host.QueueScheduleWindow(ScheduleWindow(1, 1, 1, 0, 384, 0, 1, false)));
  auto staged = ScheduleWindow(2, 1, 1, 384, 1536, 0, 1, false);
  WriteLeU32(staged, 60, 2); WriteLeU32(staged, 64, 384); WriteLeU32(staged, 48, 256);
  for (unsigned index = 0; index < 256; ++index) {
    const auto bytes = source(index + 257, true);
    staged.insert(staged.end(), bytes.begin() + 4, bytes.end());
  }
  assert(host.QueueScheduleWindow(staged));
  const std::array<std::uint8_t, 4> empty{};
  assert(host.ConfigureInstrumentStates(empty));
  assert(host.PublishGraphRevision(2, 384).code == GraphRevisionStatusCode::kPublishPending);
  render(); render(); render();
  assert(host.InspectGraphRevision(2).code == GraphRevisionStatusCode::kPublished);
  assert(host.PrepareGraphRevision(3, GraphSnapshot(3, 1.F), 640).code == GraphRevisionStatusCode::kPrepared);
  assert(host.ConfigureInstrumentStates(empty));
  auto deletion = ScheduleWindow(3, 1, 1, 640, 1536, 0, 1, false);
  WriteLeU32(deletion, 60, 3); WriteLeU32(deletion, 64, 640);
  assert(host.QueueScheduleWindow(deletion));
  assert(host.PublishGraphRevision(3, 640).code == GraphRevisionStatusCode::kPublishPending);
  render(); render();
  const auto code = host.InspectGraphRevision(3).code;
  const auto expected = mode == 0 ? GraphRevisionStatusCode::kPublished : GraphRevisionStatusCode::kRebaseRequired;
  std::fprintf(stderr, "wire origin mode=%u deletion_result=%u expected=%u\n",
    mode, unsigned(code), unsigned(expected));
  host.Stop();
  assert(code == expected);
}

void TestCheckpoint3FractionalSourceSeam() {
  using namespace daw::audio_host_macos;
  std::array<float, 4096> pcm{};
  for (unsigned index = 0; index < pcm.size(); ++index)
    pcm[index] = static_cast<float>((index * 197U) % 401U) / 4096.F;
  const auto capture = [&](const bool edit) {
    AudioHost host;
    assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
      .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
    assert(host.PrepareAndPublishGraph(1, GraphSnapshot(1, 1.F)));
    assert(host.InstallAsset(1, 2048, 44100, 2, 1, pcm));
    assert(host.SetTransport(1, false, 0));
    assert(host.StartDiagnosticMode());
    assert(host.SetTransport(1, true, 0));
    assert(host.QueueSourceEvents(Checkpoint3Source(1, 0, 1536)));
    if (edit) {
      assert(host.PrepareGraphRevision(2, GraphSnapshot(2, 1.F), 256).code == GraphRevisionStatusCode::kPrepared);
      assert(host.QueueScheduleWindow(ScheduleWindow(1, 1, 1, 0, 256, 0, 1, false)));
      auto staged = ScheduleWindow(2, 1, 1, 256, 1536, 0, 1, false);
      WriteLeU32(staged, 60, 2); WriteLeU32(staged, 64, 256); WriteLeU32(staged, 48, 1);
      auto source = Checkpoint3Source(1, 0, 1536, 2);
      staged.insert(staged.end(), source.begin() + 4, source.end());
      assert(host.QueueScheduleWindow(staged));
      const std::array<std::uint8_t, 4> empty{};
      assert(host.ConfigureInstrumentStates(empty));
      assert(host.PublishGraphRevision(2, 256).code == GraphRevisionStatusCode::kPublishPending);
    }
    std::array<float, 768> capture{};
    std::array<float, 128> silence{}, left{}, right{};
    const std::array<const float*, 2> input{silence.data(), silence.data()};
    const std::array<float*, 2> output{left.data(), right.data()};
    for (unsigned block = 0; block < 6; ++block) {
      assert(host.ProcessPlanar(input, output, 128));
      std::copy(left.begin(), left.end(), capture.begin() + block * 128);
    }
    if (edit) assert(host.InspectGraphRevision(2).code == GraphRevisionStatusCode::kPublished);
    host.Stop();
    return capture;
  };
  const auto reference = capture(false);
  const auto edited = capture(true);
  assert(reference == edited);
}

void TestCheckpoint3FractionalOrigins() {
  for (const auto rates : {std::pair{44100U, 48000U}, std::pair{48000U, 44100U}, std::pair{96000U, 48000U}})
  for (const float origin : {0.3F, 0.1F, 0.7F}) {
  using namespace daw::audio_host_macos;
  std::array<float, 4096> pcm{};
  for (unsigned index = 0; index < pcm.size(); ++index)
    pcm[index] = static_cast<float>((index * 197U) % 401U) / 4096.F;
  const auto capture = [&](const bool edit) {
    AudioHost host;
    assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = rates.second,
      .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
    assert(host.PrepareAndPublishGraph(1, GraphSnapshot(1, 1.F)));
    assert(host.InstallAsset(1, 2048, rates.first, 2, 1, pcm));
    assert(host.SetTransport(1, false, 0));
    assert(host.StartDiagnosticMode());
    assert(host.SetTransport(1, true, 0));
    auto initial = Checkpoint3Source(1, 0, 1536);
    std::vector<std::uint8_t> initial_fraction;
    AppendLeFloat(initial_fraction, origin);
    std::copy(initial_fraction.begin(), initial_fraction.end(), initial.begin() + 96);
    assert(host.QueueSourceEvents(initial));
    if (edit) {
      assert(host.PrepareGraphRevision(2, GraphSnapshot(2, 1.F), 384).code == GraphRevisionStatusCode::kPrepared);
      assert(host.QueueScheduleWindow(ScheduleWindow(1, 1, 1, 0, 384, 0, 1, false)));
      auto staged = ScheduleWindow(2, 1, 1, 384, 1536, 0, 1, false);
      WriteLeU32(staged, 60, 2); WriteLeU32(staged, 64, 384); WriteLeU32(staged, 48, 1);
      auto source = Checkpoint3Source(1, 0, 1536, 2);
      std::vector<std::uint8_t> fraction;
      AppendLeFloat(fraction, origin);
      std::copy(fraction.begin(), fraction.end(), source.begin() + 96);
      staged.insert(staged.end(), source.begin() + 4, source.end());
      assert(host.QueueScheduleWindow(staged));
      const std::array<std::uint8_t, 4> empty{};
      assert(host.ConfigureInstrumentStates(empty));
      assert(host.PublishGraphRevision(2, 384).code == GraphRevisionStatusCode::kPublishPending);
    }
    std::array<float, 768> capture{};
    std::array<float, 128> silence{}, left{}, right{};
    const std::array<const float*, 2> input{silence.data(), silence.data()};
    const std::array<float*, 2> output{left.data(), right.data()};
    for (unsigned block = 0; block < 6; ++block) {
      assert(host.ProcessPlanar(input, output, 128));
      std::copy(left.begin(), left.end(), capture.begin() + block * 128);
    }
    if (edit) assert(host.InspectGraphRevision(2).code == GraphRevisionStatusCode::kPublished);
    host.Stop();
    return capture;
  };
  const auto reference = capture(false);
  const auto edited = capture(true);
  unsigned mismatches=0;
  for (unsigned i=0;i<reference.size();++i) if(reference[i]!=edited[i]) ++mismatches;
  std::fprintf(stderr, "P2-1 rate=%u/%u origin=%g mismatches=%u\n", rates.first, rates.second, origin, mismatches);
  assert(reference == edited);
  }
}

void TestCheckpoint3FractionalEndpoint() {
  using namespace daw::audio_host_macos;
  std::array<float, 4096> pcm{};
  for (unsigned index = 0; index < pcm.size(); ++index)
    pcm[index] = static_cast<float>((index * 197U) % 401U) / 4096.F;
  const auto capture = [&](const bool edit) {
    AudioHost host;
    assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
      .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
    assert(host.PrepareAndPublishGraph(1, GraphSnapshot(1, 1.F)));
    assert(host.InstallAsset(1, 2048, 44100, 2, 1, pcm));
    assert(host.SetTransport(1, false, 0));
    assert(host.StartDiagnosticMode());
    assert(host.SetTransport(1, true, 0));
    assert(host.QueueSourceEvents(Checkpoint3Source(1, 0, 1536)));
    if (edit) {
      assert(host.PrepareGraphRevision(2, GraphSnapshot(2, 1.F), 256).code == GraphRevisionStatusCode::kPrepared);
      assert(host.QueueScheduleWindow(ScheduleWindow(1, 1, 1, 0, 256, 0, 1, false)));
      auto staged = ScheduleWindow(2, 1, 1, 256, 1536, 0, 1, false);
      WriteLeU32(staged, 60, 2); WriteLeU32(staged, 64, 256); WriteLeU32(staged, 48, 1);
      auto source = Checkpoint3Source(1, 0, 258, 2);
      // Retain the accepted origin; express the endpoint relative to it.
      WriteLeU32(source, 4 + 48, 237);
      WriteLeU32(source, 4 + 76, 1536); WriteLeU32(source, 4 + 84, 1536);
      staged.insert(staged.end(), source.begin() + 4, source.end());
      assert(host.QueueScheduleWindow(staged));
      const std::array<std::uint8_t, 4> empty{};
      assert(host.ConfigureInstrumentStates(empty));
      assert(host.PublishGraphRevision(2, 256).code == GraphRevisionStatusCode::kPublishPending);
    }
    std::array<float, 768> capture{};
    std::array<float, 128> silence{}, left{}, right{};
    const std::array<const float*, 2> input{silence.data(), silence.data()};
    const std::array<float*, 2> output{left.data(), right.data()};
    for (unsigned block = 0; block < 6; ++block) {
      assert(host.ProcessPlanar(input, output, 128));
      std::copy(left.begin(), left.end(), capture.begin() + block * 128);
    }
    if (edit) assert(host.InspectGraphRevision(2).code == GraphRevisionStatusCode::kPublished);
    host.Stop();
    return capture;
  };
  const auto reference = capture(false);
  const auto edited = capture(true);
  std::fprintf(stderr, "P2-2 frame257 reference=%g edited=%g\n",reference[257],edited[257]);
  assert(reference[257] == edited[257]);
}

void TestCheckpoint3Assets(const char failure) {
  using namespace daw::audio_host_macos;
  AudioHost host;
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 4, .channel_count = 2, .revision = 1}));
  assert(host.PrepareAndPublishGraph(1, GraphSnapshot(1, 1.F)));
  std::array<float, 32> samples{};
  samples.fill(0.25F);
  std::array<float, 4> silence{}, left{}, right{};
  const std::array<const float*, 2> input{silence.data(), silence.data()};
  const std::array<float*, 2> output{left.data(), right.data()};
  const auto render = [&] { assert(host.ProcessPlanar(input, output, 4)); };
  const auto start = [&] {
    assert(host.SetTransport(1, false, 0));
    assert(host.StartDiagnosticMode());
    assert(host.SetTransport(1, true, 0));
  };
  std::fprintf(stderr, "checkpoint3 failure=%c\n", failure);
  if (failure == 'a' || failure == 'c') {
    assert(host.InstallAsset(1, 16, 48000, 2, 1, samples));
    if (failure == 'a') start();
    assert(host.PrepareGraphRevision(2, GraphSnapshot(2, 1.F), 8).code == GraphRevisionStatusCode::kPrepared);
    assert(host.InstallAsset(2, 16, 48000, 2, 2, samples));
    assert(host.CreateMappedAsset(3, 16, 48000, 2, 3));
    assert(host.WriteMappedAssetPage(3, 0, 16, samples));
    assert(host.PrepareMappedAssetRange(3, 0, 16));
    if (failure == 'c') {
      assert(host.RollbackGraphRevision(2).code == GraphRevisionStatusCode::kRolledBack);
      host.ProcessNativeVstControl();
      assert(host.diagnostics().installed_assets == 1);
      assert(!host.WriteMappedAssetPage(3, 0, 16, samples));
      assert(host.QueueSourceEvents(Checkpoint3Source(1)));
    } else {
      auto active = ScheduleWindow(1, 1, 1, 0, 8, 0, 1, false);
      WriteLeU32(active, 48, 1);
      auto source = Checkpoint3Source(2, 0, 8);
      active.insert(active.end(), source.begin() + 4, source.end());
      assert(!host.QueueScheduleWindow(active)); // Prepared-only storage is invisible.
      WriteLeU32(active, 48, 0); active.resize(72);
      assert(host.QueueScheduleWindow(active));
      auto next = ScheduleWindow(2, 1, 1, 8, 24, 0, 1, false);
      WriteLeU32(next, 60, 2); WriteLeU32(next, 64, 8); WriteLeU32(next, 48, 1);
      source = Checkpoint3Source(2, 8, 24);
      next.insert(next.end(), source.begin() + 4, source.end());
      assert(host.QueueScheduleWindow(next));
      const std::array<std::uint8_t, 4> empty{};
      assert(host.ConfigureInstrumentStates(empty));
      assert(host.PublishGraphRevision(2).code == GraphRevisionStatusCode::kPublishPending);
      render(); assert(left[0] == 0.F);
      render(); assert(left[0] == 0.F);
      render();
      assert(host.InspectGraphRevision(2).code == GraphRevisionStatusCode::kPublished);
      assert(left[0] == 0.25F);
      assert(host.InstallAsset(4, 16, 48000, 2, 4, samples)); // Retired plan remains.
      assert(host.diagnostics().transport_epoch == 1 && host.diagnostics().rejected_blocks == 0);
    }
  } else if (failure == 'b' || failure == 'd') {
    assert(host.CreateMappedAsset(1, 16, 48000, 2, 1));
    assert(host.WriteMappedAssetPage(1, 0, 16, samples));
    start();
    assert(host.QueueSourceEvents(Checkpoint3Source(1, 4, 20)));
    assert(host.ReleaseAsset(1)); // Accepted even while queued, never frees its reader.
    assert(host.diagnostics().installed_assets == 1);
    render();
    pollfd wake{host.controlWakeDescriptor(), POLLIN, 0};
    assert(poll(&wake, 1, 1000) == 1 && (wake.revents & POLLIN) != 0);
    host.DrainControlWake();
    host.ProcessNativeVstControl(); // Queue reader handed ownership to the core.
    auto replacement = samples; replacement.fill(0.75F);
    assert(!host.WriteMappedAssetPage(1, 0, 16, replacement));
    render(); assert(left[0] == 0.25F);
    if (failure == 'd') {
      assert(host.PrepareGraphRevision(2, GraphSnapshot(2, 1.F)).code == GraphRevisionStatusCode::kPrepared);
      assert(host.PublishGraphRevision(2).code == GraphRevisionStatusCode::kPublishPending);
      render();
      assert(host.InspectGraphRevision(2).code == GraphRevisionStatusCode::kPublished);
      assert(host.PrepareGraphRevision(3, GraphSnapshot(3, 1.F)).code == GraphRevisionStatusCode::kPrepared);
      assert(host.diagnostics().retired_revision == 0); // Checkpoint 1 auto-retirement.
      assert(host.diagnostics().installed_assets == 1); // Retired graph is not the source lease.
      assert(host.RollbackGraphRevision(3).code == GraphRevisionStatusCode::kRolledBack);
    }
    for (unsigned block = 0; block < 8; ++block) {
      host.ProcessNativeVstControl();
      render();
    }
    wake.revents = 0;
    assert(poll(&wake, 1, 1000) == 1 && (wake.revents & POLLIN) != 0);
    host.DrainControlWake();
    host.ProcessNativeVstControl(); // No new renderer command is needed.
    assert(host.diagnostics().installed_assets == 0);
    assert(host.diagnostics().rejected_blocks == 0);
  } else if (failure == 'e') {
    assert(host.InstallAsset(1, 16, 48000, 2, 1, samples));
    assert(host.PrepareGraphRevision(2, GraphSnapshot(2, 1.F)).code == GraphRevisionStatusCode::kPrepared);
    assert(host.InstallAsset(1, 16, 48000, 2, 1, samples)); // Reuse, not another allocation.
    assert(host.diagnostics().installed_assets == 1);
    auto different = samples; different[0] = 1.F;
    assert(!host.InstallAsset(1, 16, 48000, 2, 1, different));
    assert(host.RollbackGraphRevision(2).code == GraphRevisionStatusCode::kRolledBack);
    assert(host.diagnostics().installed_assets == 1);
    assert(host.QueueSourceEvents(Checkpoint3Source(1)));
  } else if (failure == 'f') {
    for (unsigned id = 1; id <= kMaximumInstalledAssets; ++id)
      assert(host.InstallAsset(id, 16, 48000, 2, id, samples));
    assert(!host.InstallAsset(65, 16, 48000, 2, 65, samples));
    assert(host.assetOperationError() == "asset-capacity-exceeded");
    assert(host.diagnostics().installed_assets == kMaximumInstalledAssets);
    assert(host.ReleaseAsset(1));
    assert(host.InstallAsset(65, 16, 48000, 2, 65, samples));
  }
  host.Stop();
  std::fprintf(stderr, "checkpoint3 failure=%c PASS\n", failure);
}

void TestCheckpoint3CompletedAssetEpoch() {
  daw_audio_core_handle core = 0;
  const daw_audio_core_config config{.abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .max_frames_per_block = 4, .max_channels = 2, .max_assets = 1, .sample_rate_hz = 48000};
  assert(daw_audio_core_create(&config, &core) == DAW_AUDIO_CORE_OK);
  const std::array<float, 4> pcm{};
  const std::array<const float*, 1> planes{pcm.data()};
  const daw_audio_asset_descriptor descriptor{.abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .revision = 1, .byte_length = sizeof(pcm), .frame_count = 4, .sample_rate_hz = 48000,
    .channel_count = 1, .planes = planes.data()};
  daw_audio_asset_handle asset = 0;
  assert(daw_audio_core_create_asset(core, &descriptor, &asset) == DAW_AUDIO_CORE_OK);
  daw::audio_core::RequestAssetRetirement(core, asset);
  assert(daw::audio_core::CompleteAssetReaders(core, 7));
  assert(!daw::audio_core::ReclaimAsset(core, asset, false, 6));
  daw::audio_core::CancelAssetRetirement(core, asset);
  assert(!daw::audio_core::ReclaimAsset(core, asset, false, 7));
  daw::audio_core::RequestAssetRetirement(core, asset);
  assert(daw::audio_core::CompleteAssetReaders(core, 9));
  assert(!daw::audio_core::ReclaimAsset(core, asset, false, 8));
  assert(daw::audio_core::ReclaimAsset(core, asset, false, 9));
  const auto previous = asset;
  assert(daw_audio_core_create_asset(core, &descriptor, &asset) == DAW_AUDIO_CORE_OK);
  assert(asset != previous);
  assert(!daw::audio_core::ReclaimAsset(core, previous, false, 9));
  daw_audio_core_destroy(core);
}

void TestCheckpoint3StagedInstrumentAssets() {
  using namespace daw::audio_host_macos;
  AudioHost host;
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  assert(host.PrepareAndPublishGraph(1, GraphSnapshot(1, 1.F)));
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  assert(host.SetTransport(1, true, 0));
  assert(host.PrepareGraphRevision(2, SampleInstrumentGraph(2, DAW_AUDIO_INSTRUMENT_KIND_SAMPLER)).code
    == GraphRevisionStatusCode::kPrepared);
  UploadInstrument(host, 1, SampleInstrumentPcm());
  assert(host.ConfigureInstrumentStates(SampleInstrumentPayload(DAW_AUDIO_INSTRUMENT_KIND_SAMPLER)));
  assert(host.ReleaseAsset(1)); // Prepared configuration owns the only sample mapping.
  assert(host.PublishGraphRevision(2).code == GraphRevisionStatusCode::kPublishPending);
  std::array<float, 128> silence{}, left{}, right{};
  const std::array<const float*, 2> input{silence.data(), silence.data()};
  const std::array<float*, 2> output{left.data(), right.data()};
  const auto render = [&] { assert(host.ProcessPlanar(input, output, 128)); };
  render();
  assert(host.InspectGraphRevision(2).code == GraphRevisionStatusCode::kPublished);
  auto note = UrgentTransportRelease(1);
  WriteLeU32(note, 36, static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOn));
  WriteLeU32(note, 44, 60);
  const float velocity = 0.8F;
  std::memcpy(note.data() + 48, &velocity, sizeof(velocity));
  assert(host.QueueInstrumentEvents(note));
  render();
  assert(std::any_of(left.begin(), left.end(), [](const float value) { return value != 0.F; }));
  assert(host.RetireGraphRevision(1).code == GraphRevisionStatusCode::kRetired);
  assert(host.PrepareGraphRevision(3, GraphSnapshot(3, 1.F)).code == GraphRevisionStatusCode::kPrepared);
  assert(host.PublishGraphRevision(3).code == GraphRevisionStatusCode::kPublishPending);
  render();
  assert(host.InspectGraphRevision(3).code == GraphRevisionStatusCode::kPublished);
  assert(host.diagnostics().installed_assets == 1 && host.instrumentLockedBytes() > 0);
  for (unsigned block = 0; block < 64; ++block) render();
  assert(host.RetireGraphRevision(2).code == GraphRevisionStatusCode::kRetired);
  // Retirement may free the graph now, but storage is released only after the
  // callback acknowledges the separate reader ticket and completed epoch.
  assert(host.diagnostics().installed_assets == 1);
  const auto before_reclamation = host.DrainScheduleProgress();
  assert(before_reclamation && before_reclamation->admission_capacity_generation == 0);
  render();
  host.ProcessNativeVstControl();
  assert(host.diagnostics().installed_assets == 0 && host.instrumentLockedBytes() == 0);
  const auto reclaimed = host.DrainScheduleProgress();
  assert(reclaimed && reclaimed->admission_capacity_generation == 1
    && reclaimed->latency_completion_generation == 0);
  render();
  host.ProcessNativeVstControl();
  const auto unchanged = host.DrainScheduleProgress();
  if (unchanged) assert(unchanged->admission_capacity_generation == 1);
  assert(host.diagnostics().transport_epoch == 1 && host.diagnostics().rejected_blocks == 0);
  host.Stop();
}

namespace daw::audio_host_macos {
// Defined by this target's private copy of the host (DAW_AUDIO_HOST_TEST_PATCH_CLAIM=1).
void SetTestPatchClaimHook(void (*hook)());
void SetTestPatchAckHook(void (*hook)(std::uint64_t, std::uint32_t));
void SetTestPatchClaimHold(bool hold);
void SetTestPatchClaimDiscard(bool discard);
}

namespace {
using daw::audio_host_macos::ProcessorPatchOutcome;
using daw::audio_host_macos::ProcessorPatchRefusal;
using daw::audio_host_macos::ProcessorPatchStatus;
using daw::audio_host_macos::ScheduleProgress;

constexpr std::uint64_t kFirstSeamPatchToken = (1ULL << 53U) + 1U;

// §2.4.5: the only outcome/refusal/token combinations native may produce.
bool ValidPatchStatus(const ProcessorPatchStatus& status) {
  const auto refusal = static_cast<std::uint32_t>(status.refusal);
  switch (status.outcome) {
    case ProcessorPatchOutcome::kApplied:
      return refusal == 0 && status.core_result == 0 && status.token == 0;
    case ProcessorPatchOutcome::kClaimed:
      return refusal == 0 && status.core_result == 0 && status.token != 0;
    case ProcessorPatchOutcome::kRefused:
      return refusal >= 1 && refusal <= 8
        && (status.token != 0) == (status.refusal == ProcessorPatchRefusal::kClaimPending)
        && (status.core_result == 0 || status.refusal == ProcessorPatchRefusal::kStageFailed
          || status.refusal == ProcessorPatchRefusal::kApplyFailed);
  }
  return false;
}

// The test target's callback holds every taken patch until the next block, so the
// control thread's one-second wait expires and the reply is a claim.
struct PatchRig {
  daw::audio_host_macos::AudioHost host;
  std::array<float, 4> input_left{1.F, 1.F, 1.F, 1.F}, input_right{1.F, 1.F, 1.F, 1.F};
  std::array<float, 4> output_left{}, output_right{};

  explicit PatchRig(const bool hold = true) {
    assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
      .max_frames_per_block = 4, .channel_count = 2, .revision = 1}));
    assert(host.PrepareAndPublishGraph(2, GraphSnapshot(2, 1.F, 0, true)));
    assert(host.StartDiagnosticMode());
    daw::audio_host_macos::SetTestPatchClaimHold(hold);
  }
  ~PatchRig() {
    daw::audio_host_macos::SetTestPatchClaimHold(false);
    daw::audio_host_macos::SetTestPatchClaimDiscard(false);
    daw::audio_host_macos::SetTestPatchClaimHook(nullptr);
    daw::audio_host_macos::SetTestPatchAckHook(nullptr);
    host.Stop();
  }
  void Process() {
    const std::array<const float*, 2> input{input_left.data(), input_right.data()};
    const std::array<float*, 2> output{output_left.data(), output_right.data()};
    assert(host.ProcessPlanar(input, output, 4));
  }
};

std::future<ProcessorPatchStatus> QueuePatchAsync(PatchRig& rig, const std::vector<std::uint8_t>& patch) {
  return std::async(std::launch::async, [&rig, &patch] { return rig.host.QueueProcessorStatePatch(patch); });
}

ProcessorPatchStatus ClaimPatch(PatchRig& rig, const float gain_db) {
  const auto patch = ProcessorStatePatch(2, gain_db);
  auto reply = QueuePatchAsync(rig, patch);
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  rig.Process();  // the callback takes the request and holds it
  assert(reply.wait_for(std::chrono::seconds(3)) == std::future_status::ready);
  const auto status = reply.get();
  assert(ValidPatchStatus(status) && status.outcome == ProcessorPatchOutcome::kClaimed);
  return status;
}

std::vector<ScheduleProgress> DrainProgressFor(daw::audio_host_macos::AudioHost& host, const int milliseconds) {
  std::vector<ScheduleProgress> frames;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(milliseconds);
  while (std::chrono::steady_clock::now() < deadline) {
    if (auto frame = host.DrainScheduleProgress()) frames.push_back(*frame);
    else std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  return frames;
}

ScheduleProgress AwaitResolution(daw::audio_host_macos::AudioHost& host, const std::uint64_t token) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
  while (std::chrono::steady_clock::now() < deadline) {
    if (auto frame = host.DrainScheduleProgress()) {
      if (frame->processor_patch_resolved_token == token) return *frame;
    } else std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  assert(false && "claim resolution was never reported");
  return {};
}

// T1: a claimed reply, then the ack while paused and quiet, reports the resolution in the
// first frame after the resolving block. That block signals the bridge twice, for the ack
// and for its progress, and the bridge wakes once or twice, so it yields one or two frames;
// the reported resolution stays on every frame after it.
void TestPatchClaimResolvesWhilePausedAndQuiet() {
  PatchRig rig;
  DrainProgressFor(rig.host, 50);
  const auto claim = ClaimPatch(rig, 6.F);
  assert(claim.token == kFirstSeamPatchToken);
  assert(kFirstSeamPatchToken > static_cast<std::uint64_t>(9007199254740991ULL));
  for (const auto& frame : DrainProgressFor(rig.host, 30)) {
    assert(frame.processor_patch_resolved_token == 0);  // nothing reports a claim that has not resolved
  }
  rig.Process();
  const auto frames = DrainProgressFor(rig.host, 150);
  std::fprintf(stderr, "patch-claim-quiet frames=%zu\n", frames.size());
  assert(!frames.empty() && frames.size() <= 2);
  for (const auto& frame : frames) {
    assert(frame.processor_patch_resolved_token == claim.token
      && frame.processor_patch_resolved_result == DAW_AUDIO_CORE_OK);
  }
  assert(rig.host.diagnostics().transport_frame == 0);
}

// T2 + T4: the claim ends at the report. Until then another patch is refused with the
// blocking token and a prepare is refused; afterwards the next claim gets a new token.
void TestPatchClaimsAreSerializedUntilReported() {
  using daw::audio_host_macos::GraphRevisionStatusCode;
  PatchRig rig;
  DrainProgressFor(rig.host, 50);
  const auto first = ClaimPatch(rig, 6.F);
  const auto expect_blocked = [&] {
    const auto blocked = rig.host.QueueProcessorStatePatch(ProcessorStatePatch(2, 3.F));
    assert(ValidPatchStatus(blocked) && blocked.outcome == ProcessorPatchOutcome::kRefused
      && blocked.refusal == ProcessorPatchRefusal::kClaimPending && blocked.token == first.token);
    assert(rig.host.PrepareGraphRevision(3, GraphSnapshot(3, 1.F, 0, true)).code
      == GraphRevisionStatusCode::kPrepareFailed);
  };
  expect_blocked();
  rig.Process();  // acknowledged, not yet reported
  std::this_thread::sleep_for(std::chrono::milliseconds(30));
  expect_blocked();
  assert(AwaitResolution(rig.host, first.token).processor_patch_resolved_result == DAW_AUDIO_CORE_OK);
  DrainProgressFor(rig.host, 20);
  const auto second = ClaimPatch(rig, 3.F);
  assert(second.token == first.token + 1);
  rig.Process();
  assert(AwaitResolution(rig.host, second.token).processor_patch_resolved_result == DAW_AUDIO_CORE_OK);
  DrainProgressFor(rig.host, 20);
  assert(rig.host.PrepareGraphRevision(3, GraphSnapshot(3, 1.F, 0, true)).code == GraphRevisionStatusCode::kPrepared);
  assert(rig.host.RollbackGraphRevision(3).code == GraphRevisionStatusCode::kRolledBack);
}

PatchRig* hook_rig = nullptr;
std::optional<ScheduleProgress> frame_drained_before_record;
void AckBeforeRecordHook() {
  hook_rig->Process();  // releases the hold: the ack lands before the claim is recorded
  std::this_thread::sleep_for(std::chrono::milliseconds(50));  // let the bridge publish it
  frame_drained_before_record = hook_rig->host.DrainScheduleProgress();
}

// T3: an ack that beats Record is skipped by the drainer, and a later frame still carries it.
void TestPatchClaimAckBeforeRecordStillReports() {
  PatchRig rig;
  DrainProgressFor(rig.host, 50);
  hook_rig = &rig;
  frame_drained_before_record.reset();
  daw::audio_host_macos::SetTestPatchClaimHook(&AckBeforeRecordHook);
  const auto claim = ClaimPatch(rig, 6.F);
  assert(frame_drained_before_record && frame_drained_before_record->processor_patch_resolved_token == 0);
  assert(AwaitResolution(rig.host, claim.token).processor_patch_resolved_result == DAW_AUDIO_CORE_OK);
  hook_rig = nullptr;
}

std::uint64_t ack_hook_token = 0;
std::uint32_t ack_hook_result = 0;
void RecordAckPairHook(const std::uint64_t token, const std::uint32_t result) {
  ack_hook_token = token;
  ack_hook_result = result;
}

// T6: alternating success and failure results over 16 claims; every reported pair is that claim's own,
// and the result is already stored when the ack becomes visible (the callback runs on this thread).
void TestPatchClaimResultsStayCoherentWhenAlternating() {
  PatchRig rig;
  DrainProgressFor(rig.host, 50);
  daw::audio_host_macos::SetTestPatchAckHook(&RecordAckPairHook);
  for (unsigned index = 0; index < 16; ++index) {
    const bool failing = index % 2 == 1;
    daw::audio_host_macos::SetTestPatchClaimDiscard(failing);
    const auto claim = ClaimPatch(rig, 6.F);
    assert(claim.token == kFirstSeamPatchToken + index);
    rig.Process();
    assert(ack_hook_token == claim.token && ack_hook_result == (failing ? DAW_AUDIO_CORE_NO_DATA : DAW_AUDIO_CORE_OK));
    const auto resolved = AwaitResolution(rig.host, claim.token);
    assert(resolved.processor_patch_resolved_result == (failing ? DAW_AUDIO_CORE_NO_DATA : DAW_AUDIO_CORE_OK));
    DrainProgressFor(rig.host, 5);
  }
}

std::vector<std::uint8_t> ParameterBatch(const std::uint64_t sequence,
  const std::uint64_t second_instance, const std::uint32_t second_offset) {
  std::vector<std::uint8_t> payload;
  AppendLeU32(payload, 2);
  AppendLeU32(payload, 1);  // revision
  AppendLeU32(payload, 1);  // epoch
  AppendLeU64(payload, sequence);
  const std::array<std::pair<std::uint64_t, std::uint32_t>, 2> events{{{77, 0}, {second_instance, second_offset}}};
  for (const auto& [instance, offset] : events) {
    AppendLeU64(payload, instance);
    AppendLeU32(payload, DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB);
    AppendLeU32(payload, offset);
    AppendLeFloat(payload, -6.F);
  }
  return payload;
}

// T7: a valid prefix with an invalid suffix enqueues nothing and consumes no sequence.
void TestParameterBatchIsAllOrNothing() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
    .max_frames_per_block = 128, .channel_count = 2, .revision = 1}));
  assert(host.PrepareAndPublishGraph(1, GraphSnapshot(1, 1.F, 0, true)));
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  assert(host.SetTransport(1, true, 0));
  std::array<float, 128> signal{}, left{}, right{};
  signal.fill(1.F);
  const std::array<const float*, 2> input{signal.data(), signal.data()};
  const std::array<float*, 2> output{left.data(), right.data()};
  const auto applied_sequence = [&] {
    assert(host.ProcessPlanar(input, output, 128));
    std::uint64_t applied = 0;
    for (const auto& frame : DrainProgressFor(host, 50)) applied = std::max(applied, frame.applied_processor_sequence);
    return applied;
  };
  assert(!host.QueueParameterEvents(ParameterBatch(9, 0, 1)));  // second event has no instance
  assert(applied_sequence() == 0);
  assert(!host.QueueParameterEvents(ParameterBatch(9, 77, 128)));  // second event is past the block
  assert(applied_sequence() == 0);
  assert(host.QueueParameterEvents(ParameterBatch(9, 77, 1)));  // the same sequence is still admitted
  assert(applied_sequence() == 9);
}

// T8: every QueueProcessorStatePatch branch returns a valid outcome/refusal/token combination.
void TestPatchStatusBranchesAreValid() {
  const auto expect = [](const ProcessorPatchStatus& status, const ProcessorPatchOutcome outcome,
    const ProcessorPatchRefusal refusal) {
    assert(ValidPatchStatus(status) && status.outcome == outcome && status.refusal == refusal);
  };
  {
    daw::audio_host_macos::AudioHost unconfigured;
    expect(unconfigured.QueueProcessorStatePatch(ProcessorStatePatch(2, 6.F)),
      ProcessorPatchOutcome::kRefused, ProcessorPatchRefusal::kUnavailable);
  }
  {
    daw::audio_host_macos::AudioHost stopped;  // published but not running: applied inline
    assert(stopped.Configure({.device_uid = "diagnostic", .sample_rate_hz = 48000,
      .max_frames_per_block = 4, .channel_count = 2, .revision = 1}));
    assert(stopped.PrepareAndPublishGraph(2, GraphSnapshot(2, 1.F, 0, true)));
    expect(stopped.QueueProcessorStatePatch(ProcessorStatePatch(2, 6.F)),
      ProcessorPatchOutcome::kApplied, ProcessorPatchRefusal::kNone);
  }
  PatchRig rig(false);
  expect(rig.host.QueueProcessorStatePatch(std::vector<std::uint8_t>(10)),
    ProcessorPatchOutcome::kRefused, ProcessorPatchRefusal::kInvalid);
  auto wrong_version = ProcessorStatePatch(2, 6.F);
  WriteLeU32(wrong_version, 0, 2);
  expect(rig.host.QueueProcessorStatePatch(wrong_version),
    ProcessorPatchOutcome::kRefused, ProcessorPatchRefusal::kInvalid);
  expect(rig.host.QueueProcessorStatePatch(ProcessorStatePatch(9, 6.F)),
    ProcessorPatchOutcome::kRefused, ProcessorPatchRefusal::kStaleRevision);
  auto unknown_instance = ProcessorStatePatch(2, 6.F);
  WriteLeU32(unknown_instance, 16, 78);
  const auto stage_failed = rig.host.QueueProcessorStatePatch(unknown_instance);
  expect(stage_failed, ProcessorPatchOutcome::kRefused, ProcessorPatchRefusal::kStageFailed);
  assert(stage_failed.core_result == DAW_AUDIO_CORE_STALE_REVISION);
  assert(rig.host.PrepareGraphRevision(3, GraphSnapshot(3, 1.F, 0, true)).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  expect(rig.host.QueueProcessorStatePatch(ProcessorStatePatch(2, 6.F)),
    ProcessorPatchOutcome::kRefused, ProcessorPatchRefusal::kPreparing);
  assert(rig.host.RollbackGraphRevision(3).code == daw::audio_host_macos::GraphRevisionStatusCode::kRolledBack);
  expect(rig.host.QueueProcessorStatePatch(ProcessorStatePatch(2, 6.F)),
    ProcessorPatchOutcome::kRefused, ProcessorPatchRefusal::kNotClaimed);
  const auto patch = ProcessorStatePatch(2, 6.F);
  auto acknowledged = QueuePatchAsync(rig, patch);
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  rig.Process();
  expect(acknowledged.get(), ProcessorPatchOutcome::kApplied, ProcessorPatchRefusal::kNone);
  daw::audio_host_macos::SetTestPatchClaimDiscard(true);
  auto failed = QueuePatchAsync(rig, patch);
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  rig.Process();
  const auto apply_failed = failed.get();
  expect(apply_failed, ProcessorPatchOutcome::kRefused, ProcessorPatchRefusal::kApplyFailed);
  assert(apply_failed.core_result == DAW_AUDIO_CORE_NO_DATA);
}
}  // namespace

namespace {
using daw::audio_host_macos::AudioHostTestAccess;
using daw::audio_host_macos::NativeVstWorkerHealth;
using daw::audio_host_macos::WorkerNotificationKind;

constexpr std::string_view kFirstVstInstance = "b0c4db1e-bd48-46d4-a4bc-f5ad1fe6c6f1";
constexpr std::string_view kSecondVstInstance = "c0c4db1e-bd48-46d4-a4bc-f5ad1fe6c6f2";

// Attached workers run without a plug-in for the lifetime of this object.
struct NoPluginWorkers {
  NoPluginWorkers() { AudioHostTestAccess::UseNoPluginWorkers(true); }
  ~NoPluginWorkers() { AudioHostTestAccess::UseNoPluginWorkers(false); }
};

daw::audio_host_macos::NativeVstAttachment PlaybackVstAttachment(
  const std::string_view instance_id,
  const std::uint64_t node_id
) {
  daw::audio_host_macos::NativeVstAttachment attachment{
    .graph_node_id = node_id,
    .instance_id = std::string(instance_id),
    .class_id = "class-id",
    .vendor_id = "vendor-id",
    .canonical_bundle_path = "/private/catalog/Example.vst3",
    .canonical_executable_path = "/private/catalog/Example.vst3/Contents/MacOS/Example",
    .architecture = 1,
    .scanner_catalog_version = 2,
    .role = daw::audio_host_macos::NativeVstRole::kEffect,
    .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .declared_latency_frames = 32,
    .transport_latency_frames = 4,
    .playback_enabled = true,
    .transport = {.slot_count = 2, .maximum_frames = 4, .input_channels = 2, .output_channels = 2, .maximum_events_per_block = 2},
  };
  attachment.bundle_fingerprint.fill(1);
  attachment.binary_fingerprint.fill(2);
  return attachment;
}

bool WaitForVstHealth(
  daw::audio_host_macos::AudioHost& host,
  const std::string_view instance_id,
  const NativeVstWorkerHealth health
) {
  for (int attempt = 0; attempt < 1000; ++attempt) {
    if (host.NativeVstHealth(instance_id) == health) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  return false;
}

std::optional<daw::audio_host_macos::WorkerNotification> NextWorkerNotification(
  daw::audio_host_macos::AudioHost& host,
  const WorkerNotificationKind kind
) {
  std::atomic<bool> running{true};
  auto pending = std::async(std::launch::async, [&] {
    for (;;) {
      const auto notification = host.WaitForWorkerNotification(&running);
      if (!notification || notification->kind == kind) return notification;
    }
  });
  const auto arrived = pending.wait_for(std::chrono::seconds(10)) == std::future_status::ready;
  if (!arrived) {
    running.store(false, std::memory_order_release);
    host.WakeWorkerNotificationWait();
  }
  return pending.get();
}

void ConfigureDiagnosticHost(daw::audio_host_macos::AudioHost& host) {
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
}
}

void TestLatencyReportPublishesWithoutStop() {
  const NoPluginWorkers no_plugin;
  daw::audio_host_macos::AudioHost host;
  ConfigureDiagnosticHost(host);
  assert(host.AttachNativeVst(PlaybackVstAttachment(kFirstVstInstance, 17)));
  assert(host.StartDiagnosticMode());
  assert(WaitForVstHealth(host, kFirstVstInstance, NativeVstWorkerHealth::kReady));
  const auto generation = AudioHostTestAccess::WorkerGeneration(host, kFirstVstInstance);
  assert(AudioHostTestAccess::PublishWorkerDiagnostic(host, kFirstVstInstance,
    {.kind = daw::plugin_host::WorkerDiagnosticKind::kLatency, .value = 99}));
  const auto reported = NextWorkerNotification(host, WorkerNotificationKind::kLatency);
  assert(reported && reported->instance_id == kFirstVstInstance && reported->value == 99);
  host.ProcessNativeVstControl();
  assert(host.lifecycleState() == daw::audio_host_macos::LifecycleState::kRunning);
  assert(AudioHostTestAccess::WorkerGeneration(host, kFirstVstInstance) == generation);
  assert(host.NativeVstHealth(kFirstVstInstance) == NativeVstWorkerHealth::kReady);
  host.Stop();
}

void TestComponentRestartIsWorkerLocal() {
  const NoPluginWorkers no_plugin;
  daw::audio_host_macos::AudioHost host;
  ConfigureDiagnosticHost(host);
  assert(host.AttachNativeVst(PlaybackVstAttachment(kFirstVstInstance, 17)));
  assert(host.StartDiagnosticMode());
  assert(WaitForVstHealth(host, kFirstVstInstance, NativeVstWorkerHealth::kReady));
  const auto generation = AudioHostTestAccess::WorkerGeneration(host, kFirstVstInstance);
  assert(AudioHostTestAccess::PublishWorkerDiagnostic(host, kFirstVstInstance,
    {.kind = daw::plugin_host::WorkerDiagnosticKind::kRestart, .value = 1}));
  assert(NextWorkerNotification(host, WorkerNotificationKind::kRestart));
  host.ProcessNativeVstControl();
  assert(host.lifecycleState() == daw::audio_host_macos::LifecycleState::kRunning);
  assert(AudioHostTestAccess::WorkerGeneration(host, kFirstVstInstance) == generation);
  assert(host.NativeVstHealth(kFirstVstInstance) == NativeVstWorkerHealth::kReady);
  host.Stop();
}

void TestWorkerFaultIsolatesOnlyThatAttachment() {
  const NoPluginWorkers no_plugin;
  daw::audio_host_macos::AudioHost host;
  ConfigureDiagnosticHost(host);
  assert(host.AttachNativeVst(PlaybackVstAttachment(kFirstVstInstance, 17)));
  assert(host.AttachNativeVst(PlaybackVstAttachment(kSecondVstInstance, 18)));
  assert(host.StartDiagnosticMode());
  assert(WaitForVstHealth(host, kFirstVstInstance, NativeVstWorkerHealth::kReady));
  assert(WaitForVstHealth(host, kSecondVstInstance, NativeVstWorkerHealth::kReady));
  assert(kill(AudioHostTestAccess::WorkerProcessGroup(host, kFirstVstInstance), SIGKILL) == 0);
  const auto fault = NextWorkerNotification(host, WorkerNotificationKind::kFault);
  assert(fault && fault->instance_id == kFirstVstInstance);
  host.ProcessNativeVstControl();
  assert(host.lifecycleState() == daw::audio_host_macos::LifecycleState::kRunning);
  assert(host.NativeVstHealth(kFirstVstInstance) == NativeVstWorkerHealth::kFaulted);
  assert(host.NativeVstHealth(kSecondVstInstance) == NativeVstWorkerHealth::kReady);
  host.Stop();
}

namespace {
using Ownership = daw::audio_host_macos::AudioHostTestAccess::Ownership;
using daw::audio_host_macos::GraphRevisionStatusCode;

Ownership OwnershipOf(daw::audio_host_macos::AudioHost& host, const std::string_view instance_id) {
  return AudioHostTestAccess::AttachmentOwnership(host, instance_id);
}

void RenderBlock(daw::audio_host_macos::AudioHost& host) {
  std::array<float, 4> silence{}, left{}, right{};
  const std::array<const float*, 2> input{silence.data(), silence.data()};
  const std::array<float*, 2> output{left.data(), right.data()};
  assert(host.ProcessPlanar(input, output, 4));
}

// Runs a published graph with the transport rolling, ready for live revisions.
void StartRunningHostWithGraph(
  daw::audio_host_macos::AudioHost& host,
  const std::vector<std::uint8_t>& graph = GraphSnapshot(2, 1.0F)
) {
  ConfigureDiagnosticHost(host);
  assert(host.PrepareAndPublishGraph(2, graph));
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  assert(host.SetTransport(1, true, 0));
  RenderBlock(host);
}

// `render` runs one callback block; it is how the caller keeps its own audio flowing.
template <typename Render>
void PublishRunningGraph(
  daw::audio_host_macos::AudioHost& host,
  const std::uint32_t revision,
  const std::vector<std::uint8_t>& graph,
  Render render
) {
  assert(host.PrepareGraphRevision(revision, graph).code == GraphRevisionStatusCode::kPrepared);
  assert(host.PublishGraphRevision(revision).code == GraphRevisionStatusCode::kPublishPending);
  render();
  assert(host.InspectGraphRevision(revision).code == GraphRevisionStatusCode::kPublished);
  // The previous plan retires once the callback has moved past any latency transition.
  for (unsigned block = 0; block < 20000; ++block) {
    render();
    const auto retired = host.RetireGraphRevision(revision - 1);
    if (retired.code == GraphRevisionStatusCode::kRetired) return;
    assert(retired.code == GraphRevisionStatusCode::kRetirementNotSafe);
  }
  assert(false);
}

void PublishRunningRevision(daw::audio_host_macos::AudioHost& host, const std::uint32_t revision, const std::uint32_t latency) {
  PublishRunningGraph(host, revision, GraphSnapshot(revision, 1.0F, latency), [&host] { RenderBlock(host); });
}
}

void TestStagedAttachmentJoinsAPublishedGraph() {
  const NoPluginWorkers no_plugin;
  daw::audio_host_macos::AudioHost host;
  StartRunningHostWithGraph(host);
  assert(host.AttachNativeVst(PlaybackVstAttachment(kFirstVstInstance, 2)));
  assert(OwnershipOf(host, kFirstVstInstance) == Ownership::kStaged);
  assert(WaitForVstHealth(host, kFirstVstInstance, NativeVstWorkerHealth::kReady));
  PublishRunningRevision(host, 3, 36);
  assert(OwnershipOf(host, kFirstVstInstance) == Ownership::kActive);
  assert(host.NativeVstHealth(kFirstVstInstance) == NativeVstWorkerHealth::kReady);
  host.Stop();
}

// A host running `graph` with a spool and a fixture input device, for the tests that bind a capture to a node.
struct CaptureBoundHost {
  struct Device : daw::audio_host_macos::RecordingInputDevice {
    bool Start(std::string_view, std::uint32_t, std::uint32_t, daw::audio_host_macos::AudioHost*, void** session) override {
      *session = this;
      return true;
    }
    void Stop(void*) override {}
    std::uint32_t Rate(std::string_view) override { return 48000; }
  };
  char root[44] = "/private/tmp/daw-host-capture-lock-XXXXXX";
  daw::audio_host_macos::SpoolRequest request;
  daw::audio_host_macos::RecordingSpoolService service;
  Device device;
  daw::audio_host_macos::AudioHost host{&service, &device};
  explicit CaptureBoundHost(const std::vector<std::uint8_t>& graph) {
    assert(mkdtemp(root) != nullptr);
    struct stat identity{};
    assert(stat(root, &identity) == 0);
    request.root_path = root;
    request.root_device = identity.st_dev;
    request.root_inode = identity.st_ino;
    request.token = std::string(64, 'e');
    StartRunningHostWithGraph(host, graph);
  }
  ~CaptureBoundHost() {
    host.Stop();
    std::filesystem::remove_all(root);
  }
  [[nodiscard]] bool Capture(const std::uint64_t target) {
    return host.ConfigureRecording({
      .device_uid = "fixture", .generation = 1, .session_id = 1,
      .channel_count = 2, .input_channels = {0, 1}, .gain = 1, .polarity = 1,
      .punch_start_frame = 0, .punch_end_frame = -1, .monitoring = false, .target_node_id = target,
    }, request);
  }
};

// While a capture is bound to node X, a revision may not remove X or change where X's output goes
// (its output, group or send chain). Everything else publishes, and the capture is untouched.
void TestCaptureBoundRoutingIsLocked() {
  constexpr std::uint64_t kTarget = 10, kGroup = 20, kOuter = 25, kOther = 30, kMaster = 1000;
  const std::vector<SnapshotNode> base{{kMaster, 6, 0}, {kOuter, 3, 0}, {kGroup, 3, 0}, {kTarget, 1, 0}};
  // The target feeds a group that feeds an outer group that feeds the master: the route is three hops long.
  const std::vector<SnapshotEdge> routed{{1, kTarget, kGroup}, {2, kGroup, kOuter}, {3, kOuter, kMaster}};
  CaptureBoundHost rig(RoutedGraphSnapshot(2, base, routed));
  auto& host = rig.host;
  // A capture can only bind a node the published plan has.
  assert(!rig.Capture(999));
  assert(rig.Capture(kTarget));
  const auto before = host.RecordingSnapshot();
  const auto refused = [&](const std::vector<SnapshotNode>& nodes, const std::vector<SnapshotEdge>& edges) {
    return host.PrepareGraphRevision(3, RoutedGraphSnapshot(3, nodes, edges)).code
      == GraphRevisionStatusCode::kCaptureTargetLocked;
  };
  // Removing the target, rerouting its output, and removing the group it feeds are all refused.
  assert(refused({{kMaster, 6, 0}, {kOuter, 3, 0}, {kGroup, 3, 0}}, {{2, kGroup, kOuter}, {3, kOuter, kMaster}}));
  assert(refused(base, {{1, kTarget, kMaster}, {2, kGroup, kOuter}, {3, kOuter, kMaster}}));
  assert(refused({{kMaster, 6, 0}, {kOuter, 3, 0}, {kTarget, 1, 0}}, {{1, kTarget, kOuter}, {3, kOuter, kMaster}}));
  // Moving a group further along the route, not the target's own edge, is a reroute too.
  assert(refused(base, {{1, kTarget, kGroup}, {2, kGroup, kMaster}, {3, kOuter, kMaster}}));
  assert(refused(base, {{1, kTarget, kGroup}, {2, kGroup, kOuter}, {3, kOuter, kGroup}}));
  // Another send from the target adds a path.
  assert(refused(base, {{1, kTarget, kGroup}, {2, kGroup, kOuter}, {3, kOuter, kMaster}, {4, kTarget, kMaster}}));
  // A level change on any edge of the route is not a reroute, and publishes.
  PublishRunningGraph(host, 3, RoutedGraphSnapshot(3, base,
    {{1, kTarget, kGroup, 0.5F}, {2, kGroup, kOuter, 0.75F}, {3, kOuter, kMaster, 0.125F}}), [&host] { RenderBlock(host); });
  // A refusal leaves nothing prepared: an unrelated revision (a new source) prepares and publishes.
  auto other = base;
  other.push_back({kOther, 1, 1});
  auto other_edges = routed;
  other_edges.push_back({4, kOther, kMaster});
  PublishRunningGraph(host, 4, RoutedGraphSnapshot(4, other, other_edges), [&host] { RenderBlock(host); });
  // `configured` is left out: the spool reports ready from its own thread, so it can flip between the two reads.
  const auto after = host.RecordingSnapshot();
  assert(after.generation == before.generation && after.session_id == before.session_id
    && after.captured_frames == before.captured_frames && after.dropped_frames == before.dropped_frames
    && after.fatal == before.fatal);
  // The lock ends with the capture.
  assert(host.CancelRecording());
  assert(host.PrepareGraphRevision(5, RoutedGraphSnapshot(5, {{kMaster, 6, 0}, {kGroup, 3, 0}}, {{2, kGroup, kMaster}})).code
    == GraphRevisionStatusCode::kPrepared);
}

// A revision prepared but not yet published already decides what the plan in force will be: a take may not bind
// a node it drops or reroutes, or the publication would remove the node the capture reads.
void TestCaptureDoesNotBindANodeAPreparedRevisionDrops() {
  constexpr std::uint64_t kTarget = 10, kGroup = 20, kMaster = 1000;
  const std::vector<SnapshotNode> base{{kMaster, 6, 0}, {kGroup, 3, 0}, {kTarget, 1, 0}};
  CaptureBoundHost rig(RoutedGraphSnapshot(2, base, {{1, kTarget, kGroup}, {2, kGroup, kMaster}}));
  auto& host = rig.host;
  assert(host.PrepareGraphRevision(3, RoutedGraphSnapshot(3, {{kMaster, 6, 0}, {kGroup, 3, 0}}, {{2, kGroup, kMaster}})).code
    == GraphRevisionStatusCode::kPrepared);
  assert(!rig.Capture(kTarget));
  assert(host.PublishGraphRevision(3).code == GraphRevisionStatusCode::kPublishPending);
  RenderBlock(host);
  assert(!rig.Capture(kTarget));
}

void TestStagedAttachmentThatIsNotReadyIsRetiredAtPublication() {
  const NoPluginWorkers no_plugin;
  daw::audio_host_macos::AudioHost host;
  ConfigureDiagnosticHost(host);
  assert(host.PrepareAndPublishGraph(2, GraphSnapshot(2, 1.0F)));
  assert(host.AttachNativeVst(PlaybackVstAttachment(kFirstVstInstance, 2)));
  assert(OwnershipOf(host, kFirstVstInstance) == Ownership::kStaged);
  assert(host.PrepareAndPublishGraph(3, GraphSnapshot(3, 1.0F)));
  assert(OwnershipOf(host, kFirstVstInstance) == Ownership::kRetired);
  host.ProcessNativeVstControl();
  assert(OwnershipOf(host, kFirstVstInstance) == Ownership::kAbsent);
}

void TestRollbackRetiresEveryStagedAttachment() {
  const NoPluginWorkers no_plugin;
  daw::audio_host_macos::AudioHost host;
  StartRunningHostWithGraph(host);
  assert(host.AttachNativeVst(PlaybackVstAttachment(kFirstVstInstance, 2)));
  assert(WaitForVstHealth(host, kFirstVstInstance, NativeVstWorkerHealth::kReady));
  assert(host.PrepareGraphRevision(3, GraphSnapshot(3, 1.0F, 36)).code == GraphRevisionStatusCode::kPrepared);
  assert(host.RollbackGraphRevision(3).code == GraphRevisionStatusCode::kRolledBack);
  host.ProcessNativeVstControl();
  assert(OwnershipOf(host, kFirstVstInstance) == Ownership::kAbsent);
  host.Stop();
}

// A worker that never becomes ready and, once asked to stop, ignores SIGTERM: it needs
// about 500 ms to retire.
struct NeverReadyWorkers {
  NeverReadyWorkers() {
    const std::string script_path = "/tmp/ae08-never-ready-worker.sh";
    {
      std::ofstream script(script_path);
      script << "#!/bin/sh\ntrap '' TERM\nexec /bin/sleep 30\n";
    }
    assert(chmod(script_path.c_str(), 0700) == 0);
    AudioHostTestAccess::UseWorkerExecutable(script_path);
  }
  ~NeverReadyWorkers() { AudioHostTestAccess::UseWorkerExecutable({}); }
};

void TestUndoBeforePublicationBindsNothing() {
  const NoPluginWorkers no_plugin;
  daw::audio_host_macos::AudioHost host;
  StartRunningHostWithGraph(host);
  {
    // Deleted while its worker is still starting: nothing to park.
    const NeverReadyWorkers starting;
    assert(host.AttachNativeVst(PlaybackVstAttachment(kFirstVstInstance, 2)));
    assert(host.DetachVstReference(kFirstVstInstance));
    assert(OwnershipOf(host, kFirstVstInstance) == Ownership::kAbsent);
  }
  // Undone after its worker became ready: the late ready must not reach the graph,
  // which a binding would reject because the node declares no external latency.
  assert(host.AttachNativeVst(PlaybackVstAttachment(kSecondVstInstance, 2)));
  assert(WaitForVstHealth(host, kSecondVstInstance, NativeVstWorkerHealth::kReady));
  assert(host.DetachVstReference(kSecondVstInstance));
  PublishRunningRevision(host, 3, 0);
  host.ProcessNativeVstControl();
  assert(OwnershipOf(host, kSecondVstInstance) == Ownership::kParked);
  host.Stop();
}

void TestRapidInsertUndoBurstKeepsEveryInstanceOwned() {
  const NoPluginWorkers no_plugin;
  daw::audio_host_macos::AudioHost host;
  StartRunningHostWithGraph(host);
  constexpr unsigned kBursts = 70;
  const auto id_for = [](const unsigned burst) {
    char id[40];
    std::snprintf(id, sizeof(id), "b0c4db1e-bd48-46d4-a4bc-%012u", burst);
    return std::string(id);
  };
  for (unsigned burst = 0; burst < kBursts; ++burst) {
    assert(host.AttachNativeVst(PlaybackVstAttachment(id_for(burst), 2)));
    assert(host.DetachVstReference(id_for(burst)));
  }
  unsigned parked = 0;
  for (unsigned burst = 0; burst < kBursts; ++burst) {
    const auto ownership = OwnershipOf(host, id_for(burst));
    assert(ownership == Ownership::kAbsent || ownership == Ownership::kParked);
    parked += ownership == Ownership::kParked ? 1U : 0U;
  }
  assert(parked <= 4);
  host.Stop();
}

// Brings `ids.size()` ready instances to a running host's graph, all on node 2.
void AttachReadyInstances(daw::audio_host_macos::AudioHost& host, const std::vector<std::string_view>& ids) {
  for (const auto id : ids) assert(host.AttachNativeVst(PlaybackVstAttachment(id, 2)));
  for (const auto id : ids) assert(WaitForVstHealth(host, id, NativeVstWorkerHealth::kReady));
}

void TestParkedInstanceRejoinsWithoutAReload() {
  const NoPluginWorkers no_plugin;
  daw::audio_host_macos::AudioHost host;
  StartRunningHostWithGraph(host);
  AttachReadyInstances(host, {kFirstVstInstance});
  PublishRunningRevision(host, 3, 36);
  assert(OwnershipOf(host, kFirstVstInstance) == Ownership::kActive);
  const auto generation = AudioHostTestAccess::WorkerGeneration(host, kFirstVstInstance);
  // Deleted: the instance parks, and the revision that drops it does not bind it.
  assert(host.DetachVstReference(kFirstVstInstance));
  assert(OwnershipOf(host, kFirstVstInstance) == Ownership::kParked);
  PublishRunningRevision(host, 4, 0);
  host.ProcessNativeVstControl();
  assert(OwnershipOf(host, kFirstVstInstance) == Ownership::kParked);
  // Undone: the same object rejoins, is staged for the next publication, and is never reloaded.
  assert(host.AttachNativeVst(PlaybackVstAttachment(kFirstVstInstance, 2)));
  assert(OwnershipOf(host, kFirstVstInstance) == Ownership::kStaged);
  assert(AudioHostTestAccess::WorkerGeneration(host, kFirstVstInstance) == generation);
  PublishRunningRevision(host, 5, 36);
  assert(OwnershipOf(host, kFirstVstInstance) == Ownership::kActive);
  assert(AudioHostTestAccess::WorkerGeneration(host, kFirstVstInstance) == generation);
  host.Stop();
}

void TestUndoBeforeTheDeletePublishesKeepsTheLiveBinding() {
  const NoPluginWorkers no_plugin;
  daw::audio_host_macos::AudioHost host;
  StartRunningHostWithGraph(host);
  AttachReadyInstances(host, {kFirstVstInstance});
  PublishRunningRevision(host, 3, 36);
  const auto generation = AudioHostTestAccess::WorkerGeneration(host, kFirstVstInstance);
  assert(host.DetachVstReference(kFirstVstInstance));
  // The live plan still renders it, so only an identical binding may take it back.
  assert(host.AttachNativeVst(PlaybackVstAttachment(kFirstVstInstance, 2)));
  assert(OwnershipOf(host, kFirstVstInstance) == Ownership::kActive);
  assert(AudioHostTestAccess::WorkerGeneration(host, kFirstVstInstance) == generation);
  // A different binding cannot mutate an object the live plan reads: it loads again.
  assert(host.DetachVstReference(kFirstVstInstance));
  auto moved = PlaybackVstAttachment(kFirstVstInstance, 2);
  moved.stage_index = 1;
  assert(host.AttachNativeVst(moved));
  assert(OwnershipOf(host, kFirstVstInstance) == Ownership::kStaged);
  assert(AudioHostTestAccess::WorkerGeneration(host, kFirstVstInstance) != generation);
  host.Stop();
}

void TestParkedInstanceThatChangedIsLoadedAgain() {
  const NoPluginWorkers no_plugin;
  daw::audio_host_macos::AudioHost host;
  StartRunningHostWithGraph(host);
  AttachReadyInstances(host, {kFirstVstInstance});
  const auto generation = AudioHostTestAccess::WorkerGeneration(host, kFirstVstInstance);
  assert(host.DetachVstReference(kFirstVstInstance));
  assert(OwnershipOf(host, kFirstVstInstance) == Ownership::kParked);
  // A different state hash is a different instance: the parked one is released, not reused.
  auto changed = PlaybackVstAttachment(kFirstVstInstance, 2);
  changed.initial_state_sha256 = std::string(64, 'a');
  assert(host.AttachNativeVst(changed));
  assert(OwnershipOf(host, kFirstVstInstance) == Ownership::kStaged);
  assert(AudioHostTestAccess::WorkerGeneration(host, kFirstVstInstance) != generation);
  host.Stop();
}

// The revision that dropped a parked instance is published, but the plan before it is not retired yet: the callback may
// still read that instance's metadata, so a rejoin with another binding loads again and never rewrites it.
void TestRejoinInsideTheRetireWindowKeepsWhatTheCallbackReads() {
  const NoPluginWorkers no_plugin;
  daw::audio_host_macos::AudioHost host;
  StartRunningHostWithGraph(host);
  AttachReadyInstances(host, {kFirstVstInstance});
  PublishRunningRevision(host, 3, 36);
  const auto generation = AudioHostTestAccess::WorkerGeneration(host, kFirstVstInstance);
  assert(host.DetachVstReference(kFirstVstInstance));
  assert(host.PrepareGraphRevision(4, GraphSnapshot(4, 1.0F, 0)).code == GraphRevisionStatusCode::kPrepared);
  assert(host.PublishGraphRevision(4).code == GraphRevisionStatusCode::kPublishPending);
  RenderBlock(host);
  assert(host.InspectGraphRevision(4).code == GraphRevisionStatusCode::kPublished);
  auto moved = PlaybackVstAttachment(kFirstVstInstance, 2);
  moved.stage_index = 1;
  assert(host.AttachNativeVst(moved));
  assert(AudioHostTestAccess::WorkerGeneration(host, kFirstVstInstance) != generation);
  while (host.RetireGraphRevision(3).code != GraphRevisionStatusCode::kRetired) RenderBlock(host);
  host.Stop();
}

void TestParkingIsBoundedByCountAndAge() {
  const NoPluginWorkers no_plugin;
  daw::audio_host_macos::AudioHost host;
  StartRunningHostWithGraph(host);
  const std::vector<std::string> ids{"id-0", "id-1", "id-2", "id-3", "id-4"};
  for (const auto& id : ids) assert(host.AttachNativeVst(PlaybackVstAttachment(id, 2)));
  for (const auto& id : ids) assert(WaitForVstHealth(host, id, NativeVstWorkerHealth::kReady));
  for (const auto& id : ids) assert(host.DetachVstReference(id));
  assert(OwnershipOf(host, "id-0") == Ownership::kAbsent);
  for (std::size_t index = 1; index < ids.size(); ++index) assert(OwnershipOf(host, ids[index]) == Ownership::kParked);
  AudioHostTestAccess::SetParkedAge(host, std::chrono::milliseconds(50));
  std::this_thread::sleep_for(std::chrono::milliseconds(80));
  host.ProcessNativeVstControl();
  for (const auto& id : ids) assert(OwnershipOf(host, id) == Ownership::kAbsent);
  host.Stop();
}

// A child that ignores the stop request and SIGTERM needs about 500 ms before SIGKILL.
void TestRetiringASlowWorkerDoesNotBlockTheCommandLoop() {
  const NeverReadyWorkers slow;
  const NoPluginWorkers no_plugin;
  daw::audio_host_macos::AudioHost host;
  StartRunningHostWithGraph(host);
  assert(host.AttachNativeVst(PlaybackVstAttachment(kFirstVstInstance, 2)));
  const int slow_group = AudioHostTestAccess::WorkerProcessGroup(host, kFirstVstInstance);
  assert(slow_group > 0);
  const auto started = std::chrono::steady_clock::now();
  assert(host.DetachVstReference(kFirstVstInstance));
  host.ProcessNativeVstControl();
  const auto elapsed = std::chrono::steady_clock::now() - started;
  assert(elapsed < std::chrono::milliseconds(100));
  assert(OwnershipOf(host, kFirstVstInstance) == Ownership::kAbsent);
  // The slow child is still being retired, yet it ends without anyone waiting on the command loop.
  for (int attempt = 0; attempt < 400 && kill(-slow_group, 0) == 0; ++attempt) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  assert(kill(-slow_group, 0) != 0 && errno == ESRCH);
  host.Stop();
}

// A plan that was published but not yet inspected already renders the instance, so retiring
// it must leave its worker running until no plan can read it.
void TestRetireDuringPublicationKeepsTheWorkerTheCallbackReads() {
  const NoPluginWorkers no_plugin;
  daw::audio_host_macos::AudioHost host;
  StartRunningHostWithGraph(host);
  AttachReadyInstances(host, {kFirstVstInstance});
  assert(host.PrepareGraphRevision(3, GraphSnapshot(3, 1.0F, 36)).code == GraphRevisionStatusCode::kPrepared);
  assert(host.PublishGraphRevision(3).code == GraphRevisionStatusCode::kPublishPending);
  RenderBlock(host);
  assert(host.DetachVstReference(kFirstVstInstance));
  AudioHostTestAccess::SetParkedAge(host, std::chrono::milliseconds(0));
  host.ProcessNativeVstControl();
  assert(OwnershipOf(host, kFirstVstInstance) == Ownership::kRetired);
  for (unsigned block = 0; block < 50; ++block) {
    RenderBlock(host);
    assert(host.NativeVstHealth(kFirstVstInstance) == NativeVstWorkerHealth::kReady);
  }
  assert(host.InspectGraphRevision(3).code == GraphRevisionStatusCode::kPublished);
  assert(OwnershipOf(host, kFirstVstInstance) == Ownership::kRetired);
  assert(host.NativeVstHealth(kFirstVstInstance) == NativeVstWorkerHealth::kReady);
  while (host.RetireGraphRevision(2).code != GraphRevisionStatusCode::kRetired) RenderBlock(host);
  // Dropped from the next revision, it can go: the reaper stops its worker.
  PublishRunningRevision(host, 4, 0);
  host.ProcessNativeVstControl();
  assert(OwnershipOf(host, kFirstVstInstance) == Ownership::kAbsent);
  host.Stop();
}

// Host tests against the AE-08 test plug-in. They run only when a driver names a built and
// signed bundle with its fingerprints (DAW_AE08_TEST_PLUGIN_BUNDLE, _BUNDLE_FINGERPRINT,
// _BINARY_FINGERPRINT); the plug-in is never built or installed by default.
namespace plugin {
constexpr std::string_view kFirst = "b0c4db1e-bd48-46d4-a4bc-f5ad1fe6c6f1";
constexpr std::string_view kSecond = "c0c4db1e-bd48-46d4-a4bc-f5ad1fe6c6f2";
constexpr std::uint32_t kBlock = 128;
constexpr std::uint32_t kRate = 48000;
// Parameter ids of the plug-in (ae08-test-effect.cpp) and the normalized value of step 1 of 3.
constexpr std::uint32_t kLatency = 1, kFault = 2, kRequestRestart = 4;
constexpr double kStepOne = 1.0 / 3.0, kStepThree = 1.0;

std::string Env(const char* name) {
  const auto* value = std::getenv(name);
  assert(value != nullptr);
  return value;
}

// `startup_delay_step` 1 makes the plug-in take 2 s to load its state.
daw::audio_host_macos::NativeVstAttachment Attachment(
  const std::string_view instance_id, const std::uint64_t node_id, const int startup_delay_step = 0
) {
  const auto bundle = std::filesystem::canonical(Env("DAW_AE08_TEST_PLUGIN_BUNDLE")).string();
  daw::audio_host_macos::NativeVstAttachment attachment{
    .graph_node_id = node_id,
    .instance_id = std::string(instance_id),
    .class_id = "AE08C0DE7E57EFFEC700000000000001",
    .vendor_id = "DAW tests",
    .canonical_bundle_path = bundle,
    .canonical_executable_path = bundle + "/Contents/MacOS/ae08-test-effect",
    .architecture = 1,
    .scanner_catalog_version = 2,
    .role = daw::audio_host_macos::NativeVstRole::kEffect,
    .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .transport_latency_frames = kBlock,
    .playback_enabled = true,
    .transport = {.slot_count = 2, .maximum_frames = kBlock, .input_channels = 2, .output_channels = 2,
      .maximum_events_per_block = 8},
  };
  attachment.bundle_fingerprint = Fingerprint(Env("DAW_AE08_TEST_PLUGIN_BUNDLE_FINGERPRINT"));
  attachment.binary_fingerprint = Fingerprint(Env("DAW_AE08_TEST_PLUGIN_BINARY_FINGERPRINT"));
  if (startup_delay_step > 0) {
    // Plug-in state: version, latency, fault, startup delay step, reserved.
    for (const int value : {1, 0, 0, startup_delay_step, 0}) {
      const auto bytes = std::bit_cast<std::array<std::uint8_t, 4>>(value);
      attachment.initial_state.insert(attachment.initial_state.end(), bytes.begin(), bytes.end());
    }
    attachment.initial_state_sha256 = daw::plugin_host::Sha256(attachment.initial_state);
  }
  return attachment;
}

// Sources 1 and 2 read input bus 0 and meet at master 1000. `external` is the latency a
// source declares for its VST (0: none).
std::vector<std::uint8_t> Graph(const std::uint32_t revision, const std::array<std::uint32_t, 2> external) {
  std::vector<std::uint8_t> payload;
  AppendLeU32(payload, DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION_EXTERNAL_LATENCY);
  AppendLeU32(payload, revision);
  AppendLeU32(payload, 3);
  AppendLeU32(payload, 2);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 0);
  const auto append_node = [&payload](const std::uint64_t id, const std::uint32_t kind, const std::uint32_t latency) {
    AppendLeU64(payload, id);
    AppendLeU32(payload, kind);
    AppendLeU32(payload, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
    AppendLeU32(payload, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, latency);
    for (std::size_t field = 0; field < 20; ++field) AppendLeU32(payload, 0);
    AppendLeU64(payload, 0);
    AppendLeFloat(payload, 0.0F);
    AppendLeFloat(payload, 0.0F);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, 0);
  };
  append_node(1000, 6, 0);
  append_node(1, 1, external[0]);
  append_node(2, 1, external[1]);
  const auto longest = std::max(external[0], external[1]);
  for (const std::uint64_t source : {1, 2}) {
    AppendLeU64(payload, source);
    AppendLeU64(payload, source);
    AppendLeU64(payload, 1000);
    AppendLeU64(payload, 0);
    AppendLeFloat(payload, 1.0F);
    AppendLeU32(payload, DAW_AUDIO_GRAPH_EDGE_POST_FADER);
    AppendLeU32(payload, 0);
    // The shorter path waits for the longer one.
    AppendLeU32(payload, longest - external[source - 1]);
  }
  std::vector<std::uint8_t> frame;
  AppendBeU64(frame, revision);
  AppendBeU32(frame, static_cast<std::uint32_t>(payload.size()));
  frame.insert(frame.end(), payload.begin(), payload.end());
  return frame;
}

float Input(const std::size_t frame) {
  return 0.25F * static_cast<float>(std::sin(2.0 * 3.141592653589793 * 440.0 * static_cast<double>(frame) / kRate));
}

// A host running a 440 Hz input through the graph; `output` keeps every rendered frame.
struct Rig {
  daw::audio_host_macos::AudioHost host;
  std::vector<float> output;

  void Configure() {
    assert(host.Configure({
      .device_uid = "diagnostic", .sample_rate_hz = kRate, .max_frames_per_block = kBlock,
      .channel_count = 2, .revision = 1,
    }));
  }
  // Attach before this: the first graph binds what is attached, and the workers start with the host.
  void Start(const std::array<std::uint32_t, 2> external) {
    assert(host.PrepareGraphRevision(2, Graph(2, external)).code == GraphRevisionStatusCode::kPrepared);
    assert(host.PublishGraphRevision(2).code == GraphRevisionStatusCode::kPublished);
    assert(host.SetTransport(1, false, 0));
    assert(host.StartDiagnosticMode());
    assert(host.SetTransport(1, true, 0));
  }
  void Render(const unsigned blocks = 1) {
    for (unsigned block = 0; block < blocks; ++block) {
      std::array<float, kBlock> in{}, left{}, right{};
      for (std::size_t frame = 0; frame < kBlock; ++frame) in[frame] = Input(output.size() + frame);
      const std::array<const float*, 2> planes_in{in.data(), in.data()};
      const std::array<float*, 2> planes_out{left.data(), right.data()};
      assert(host.ProcessPlanar(planes_in, planes_out, kBlock));
      output.insert(output.end(), left.begin(), left.end());
      // About one block of wall time, so the worker answers as it would behind a device.
      std::this_thread::sleep_for(std::chrono::milliseconds(3));
    }
  }
  void Publish(const std::uint32_t revision, const std::array<std::uint32_t, 2> external) {
    PublishRunningGraph(host, revision, Graph(revision, external), [this] { Render(); });
  }
  bool Wait(const std::string_view instance_id, const NativeVstWorkerHealth health) {
    for (int attempt = 0; attempt < 3000; ++attempt) {
      if (host.NativeVstHealth(instance_id) == health) return true;
      Render();
    }
    return false;
  }
  void Set(const std::string_view instance_id, const std::uint32_t parameter, const double value) {
    std::vector<std::uint8_t> payload;
    AppendLeU32(payload, static_cast<std::uint32_t>(instance_id.size()));
    payload.insert(payload.end(), instance_id.begin(), instance_id.end());
    AppendLeU32(payload, 1);
    AppendLeU32(payload, parameter);
    AppendLeU32(payload, 0);
    AppendLeU64(payload, std::bit_cast<std::uint64_t>(value));
    assert(host.QueueNativeVstParameterEvents(payload));
  }
  // The next notification of `kind`. The worker reports from its block loop, so blocks keep rendering while waiting.
  std::optional<daw::audio_host_macos::WorkerNotification> Notification(const WorkerNotificationKind kind) {
    std::atomic<bool> running{true};
    auto pending = std::async(std::launch::async, [&] {
      for (;;) {
        const auto notification = host.WaitForWorkerNotification(&running);
        if (!notification || notification->kind == kind) return notification;
      }
    });
    for (unsigned block = 0; block < 3000 && pending.wait_for(std::chrono::seconds(0)) != std::future_status::ready; ++block) Render();
    running.store(false, std::memory_order_release);
    host.WakeWorkerNotificationWait();
    return pending.get();
  }
  // RMS of the last `blocks` blocks.
  double Level(const unsigned blocks) const {
    double sum = 0;
    const auto count = static_cast<std::size_t>(blocks) * kBlock;
    for (std::size_t index = output.size() - count; index < output.size(); ++index) sum += output[index] * output[index];
    return std::sqrt(sum / static_cast<double>(count));
  }
  bool Running() { return host.lifecycleState() == daw::audio_host_macos::LifecycleState::kRunning; }
};

// Largest |output(n) - scale * input(n - delay)| over the last `blocks` blocks.
double Mismatch(const Rig& rig, const unsigned blocks, const std::size_t delay, const double scale) {
  double worst = 0;
  for (std::size_t index = rig.output.size() - static_cast<std::size_t>(blocks) * kBlock; index < rig.output.size(); ++index) {
    worst = std::max(worst, std::abs(static_cast<double>(rig.output[index]) - scale * Input(index - delay)));
  }
  return worst;
}

// The delay at which the last `blocks` blocks equal `scale` times the input.
std::optional<std::size_t> DelayOf(const Rig& rig, const unsigned blocks, const double scale) {
  for (std::size_t delay = 0; delay <= 4 * kBlock; ++delay) {
    if (Mismatch(rig, blocks, delay, scale) < 1.0e-3) return delay;
  }
  return std::nullopt;
}

// A component restart is the plug-in re-setting itself up: the worker reactivates the
// component and reads the latency again, and a re-setup the plug-in refuses faults only it.
void TestComponentRestartResetsUpTheWorker() {
  Rig rig;
  rig.Configure();
  assert(rig.host.AttachNativeVst(Attachment(kFirst, 1)));
  rig.Start({kBlock, 0});
  assert(rig.Wait(kFirst, NativeVstWorkerHealth::kReady));
  rig.Render(30);
  const auto generation = AudioHostTestAccess::WorkerGeneration(rig.host, kFirst);
  rig.Set(kFirst, kRequestRestart, kStepThree);
  assert(rig.Notification(WorkerNotificationKind::kRestart));
  const auto latency = rig.Notification(WorkerNotificationKind::kLatency);
  assert(latency && latency->instance_id == kFirst && latency->value == 0);
  rig.Render(30);
  assert(rig.Running() && rig.host.NativeVstHealth(kFirst) == NativeVstWorkerHealth::kReady);
  assert(AudioHostTestAccess::WorkerGeneration(rig.host, kFirst) == generation);
  assert(rig.Level(10) > 0.1);
  // The plug-in now refuses to become active again, so the re-setup fails.
  rig.Set(kFirst, kFault, kStepThree);
  rig.Set(kFirst, kRequestRestart, 0.0);
  rig.Render(5);
  rig.Set(kFirst, kRequestRestart, kStepThree);
  const auto fault = rig.Notification(WorkerNotificationKind::kFault);
  assert(fault && fault->instance_id == kFirst);
  rig.Render(5);
  assert(rig.host.NativeVstHealth(kFirst) == NativeVstWorkerHealth::kFaulted);
  assert(rig.Running());
  rig.host.Stop();
}

// A new latency from the plug-in is published as a revision while the host keeps running.
void TestLatencySwitchPublishesWithoutStop() {
  Rig rig;
  rig.Configure();
  assert(rig.host.AttachNativeVst(Attachment(kFirst, 1)));
  rig.Start({kBlock, 0});
  assert(rig.Wait(kFirst, NativeVstWorkerHealth::kReady));
  rig.Render(30);
  const auto generation = AudioHostTestAccess::WorkerGeneration(rig.host, kFirst);
  const auto before = DelayOf(rig, 10, 2.0);
  assert(before);
  rig.Set(kFirst, kLatency, kStepOne);
  // The worker's report from loading (0 frames) may still be queued ahead of the new one.
  auto reported = rig.Notification(WorkerNotificationKind::kLatency);
  if (reported && reported->value == 0) reported = rig.Notification(WorkerNotificationKind::kLatency);
  assert(reported && reported->instance_id == kFirst && reported->value == 64);
  rig.host.ProcessNativeVstControl();
  assert(rig.Running());
  // The node now declares the plug-in's 64 frames on top of the transport's block.
  rig.Publish(3, {kBlock + 64, 0});
  rig.Render(30);
  assert(rig.Running() && rig.host.NativeVstHealth(kFirst) == NativeVstWorkerHealth::kReady);
  assert(AudioHostTestAccess::WorkerGeneration(rig.host, kFirst) == generation);
  // Both sources are compensated to the new latency and play on without a gap.
  const auto after = DelayOf(rig, 10, 2.0);
  assert(after && *after == *before + 64);
  rig.host.Stop();
}

// One crashing plug-in silences only its own node; the other node renders sample for sample.
void TestCrashMutesOnlyThatInstance() {
  Rig rig;
  rig.Configure();
  assert(rig.host.AttachNativeVst(Attachment(kFirst, 1)));
  assert(rig.host.AttachNativeVst(Attachment(kSecond, 2)));
  rig.Start({kBlock, kBlock});
  assert(rig.Wait(kFirst, NativeVstWorkerHealth::kReady) && rig.Wait(kSecond, NativeVstWorkerHealth::kReady));
  rig.Render(30);
  const auto delay = DelayOf(rig, 10, 2.0);
  assert(delay);
  rig.Set(kFirst, kFault, kStepOne);
  for (unsigned guard = 0; guard < 500 && rig.host.NativeVstHealth(kFirst) == NativeVstWorkerHealth::kReady; ++guard) rig.Render();
  assert(rig.host.NativeVstHealth(kFirst) == NativeVstWorkerHealth::kFaulted);
  const auto fault = rig.Notification(WorkerNotificationKind::kFault);
  assert(fault && fault->instance_id == kFirst);
  rig.Render(30);
  assert(rig.Running());
  assert(rig.host.NativeVstHealth(kSecond) == NativeVstWorkerHealth::kReady);
  // What remains is the second node alone: the same delay, one source's worth of signal.
  assert(Mismatch(rig, 10, *delay, 1.0) < 1.0e-4);
  rig.host.Stop();
}

// A plug-in that is still loading at a publication is left out of it and never stalls it; one
// that is ready joins the next revision.
void TestDelayedReadyAcrossAPublication() {
  Rig rig;
  rig.Configure();
  rig.Start({0, 0});
  rig.Render(30);
  const auto steady = rig.Level(10);
  assert(steady > 0.1);
  assert(rig.host.AttachNativeVst(Attachment(kFirst, 1, 1)));
  assert(AudioHostTestAccess::AttachmentOwnership(rig.host, kFirst) == Ownership::kStaged);
  assert(rig.host.NativeVstHealth(kFirst) == NativeVstWorkerHealth::kStarting);
  const auto started = std::chrono::steady_clock::now();
  rig.Publish(3, {0, 0});
  assert(std::chrono::steady_clock::now() - started < std::chrono::seconds(1));
  assert(rig.host.NativeVstHealth(kFirst) == NativeVstWorkerHealth::kStarting);
  assert(AudioHostTestAccess::AttachmentOwnership(rig.host, kFirst) != Ownership::kActive);
  // It finishes loading after the publication, and the graph never took it.
  std::this_thread::sleep_for(std::chrono::milliseconds(2500));
  rig.Render(30);
  rig.host.ProcessNativeVstControl();
  assert(AudioHostTestAccess::AttachmentOwnership(rig.host, kFirst) == Ownership::kAbsent);
  assert(Mismatch(rig, 10, 0, 2.0) < 1.0e-4);
  // Attached again and given time to load, it joins the next revision.
  assert(rig.host.AttachNativeVst(Attachment(kSecond, 1, 1)));
  assert(rig.Wait(kSecond, NativeVstWorkerHealth::kReady));
  rig.Publish(4, {kBlock, 0});
  rig.Render(30);
  assert(AudioHostTestAccess::AttachmentOwnership(rig.host, kSecond) == Ownership::kActive);
  assert(rig.Running() && rig.host.NativeVstHealth(kSecond) == NativeVstWorkerHealth::kReady);
  assert(DelayOf(rig, 10, 2.0) == kBlock);
  rig.host.Stop();
}

// Wall time of ten inserts into a running graph: attach to ready, then ready to bound
// (prepare, publish and the callback taking the new revision).
void MeasureInserts() {
  Rig rig;
  rig.Configure();
  rig.Start({0, 0});
  rig.Render(30);
  using Clock = std::chrono::steady_clock;
  const auto milliseconds = [](const Clock::duration span) {
    return std::chrono::duration<double, std::milli>(span).count();
  };
  std::vector<double> loading, binding;
  for (std::uint32_t insert = 0; insert < 10; ++insert) {
    const std::string id = "b0c4db1e-bd48-46d4-a4bc-" + std::to_string(100000000000ULL + insert);
    const auto attached = Clock::now();
    assert(rig.host.AttachNativeVst(Attachment(id, 1)));
    while (rig.host.NativeVstHealth(id) != NativeVstWorkerHealth::kReady) std::this_thread::sleep_for(std::chrono::microseconds(500));
    const auto ready = Clock::now();
    const std::uint32_t revision = 3 + 2 * insert;
    assert(rig.host.PrepareGraphRevision(revision, Graph(revision, {kBlock, 0})).code == GraphRevisionStatusCode::kPrepared);
    assert(rig.host.PublishGraphRevision(revision).code == GraphRevisionStatusCode::kPublishPending);
    rig.Render();
    assert(rig.host.InspectGraphRevision(revision).code == GraphRevisionStatusCode::kPublished);
    const auto bound = Clock::now();
    assert(AudioHostTestAccess::AttachmentOwnership(rig.host, id) == Ownership::kActive);
    loading.push_back(milliseconds(ready - attached));
    binding.push_back(milliseconds(bound - ready));
    while (rig.host.RetireGraphRevision(revision - 1).code != GraphRevisionStatusCode::kRetired) rig.Render();
    assert(rig.host.DetachVstReference(id));
    rig.Publish(revision + 1, {0, 0});
  }
  const auto summary = [](std::vector<double> samples) {
    std::sort(samples.begin(), samples.end());
    return std::pair{(samples[4] + samples[5]) / 2, samples.back()};
  };
  const auto [loading_median, loading_max] = summary(loading);
  const auto [binding_median, binding_max] = summary(binding);
  std::printf("AE08_INSERT_MS attach_to_ready median=%.1f max=%.1f ready_to_bound median=%.1f max=%.1f total_median=%.1f\n",
    loading_median, loading_max, binding_median, binding_max, loading_median + binding_median);
  rig.host.Stop();
}
}  // namespace plugin

int main() {
  if (std::getenv("DAW_AE08_MEASURE_INSERTS")) {
    plugin::MeasureInserts();
    return 0;
  }
  if (std::getenv("DAW_AE08_TEST_PLUGIN_BUNDLE")) {
    plugin::TestComponentRestartResetsUpTheWorker();
    plugin::TestLatencySwitchPublishesWithoutStop();
    plugin::TestCrashMutesOnlyThatInstance();
    plugin::TestDelayedReadyAcrossAPublication();
    return 0;
  }
  if (std::getenv("DAW_AE08_RETIRE_ONLY")) {
    TestRetireDuringPublicationKeepsTheWorkerTheCallbackReads();
    TestRetiringASlowWorkerDoesNotBlockTheCommandLoop();
    TestUndoBeforePublicationBindsNothing();
    TestRapidInsertUndoBurstKeepsEveryInstanceOwned();
    TestParkedInstanceRejoinsWithoutAReload();
    TestUndoBeforeTheDeletePublishesKeepsTheLiveBinding();
    TestParkedInstanceThatChangedIsLoadedAgain();
    TestRejoinInsideTheRetireWindowKeepsWhatTheCallbackReads();
    TestParkingIsBoundedByCountAndAge();
    return 0;
  }
  if (const auto* mode = std::getenv("DAW_AE08_OBSERVATION_ONLY")) {
    TestCheckpoint4ObservationHandoff(*mode); return 0;
  }
  for (const char mode : {'a', 'b', 'c', 'd', 'e', 'f'}) TestCheckpoint4ObservationHandoff(mode);
  if (const auto* mode = std::getenv("DAW_AE08_SOURCE_WIRE_ORIGIN_ONLY")) {
    TestCheckpoint3WireOrigin(static_cast<unsigned>(std::strtoul(mode, nullptr, 10))); return 0;
  }
  for (const unsigned mode : {0U, 1U, 2U, 3U, 4U}) TestCheckpoint3WireOrigin(mode);
  if (std::getenv("DAW_AE08_SOURCE_RAPID_NODE_ONLY")) { TestCheckpoint3RapidNodeReaddition(); return 0; }
  if (std::getenv("DAW_AE08_SOURCE_ORIGINS_ONLY")) { TestCheckpoint3FractionalOrigins(); return 0; }
  if (std::getenv("DAW_AE08_SOURCE_ENDPOINT_ONLY")) { TestCheckpoint3FractionalEndpoint(); return 0; }
  TestCheckpoint3RapidNodeReaddition();
  TestCheckpoint3FractionalOrigins();
  TestCheckpoint3FractionalEndpoint();
  if (std::getenv("DAW_AE08_SOURCE_NODE_READD_ONLY")) { TestCheckpoint3RemovedSourceNodeReaddition(); return 0; }
  TestCheckpoint3RemovedSourceNodeReaddition();
  if (std::getenv("DAW_AE08_SOURCE_FRACTION_ONLY")) { TestCheckpoint3FractionalSourceSeam(); return 0; }
  if (std::getenv("DAW_AE08_SOURCE_CAPACITY_ONLY")) { TestCheckpoint3SourceSeamCapacity(); return 0; }
  if (const auto* failure = std::getenv("DAW_AE08_SOURCE_SEAM_ONLY")) {
    TestCheckpoint3SourceSeam(*failure); return 0;
  }
  for (const char failure : {'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'}) TestCheckpoint3SourceSeam(failure);
  for (const char failure : {'a', 'b', 'c', 'd', 'e'})
    for (const unsigned cancellation : {1U, 2U}) TestCheckpoint3SourceSeam(failure, cancellation);
  TestCheckpoint3SourceSeamCapacity();
  TestCheckpoint3FractionalSourceSeam();
  if (std::getenv("DAW_AE08_ASSET_EPOCH_ONLY")) { TestCheckpoint3CompletedAssetEpoch(); return 0; }
  if (std::getenv("DAW_AE08_ASSET_INSTRUMENT_ONLY")) { TestCheckpoint3StagedInstrumentAssets(); return 0; }
  TestCheckpoint3CompletedAssetEpoch();
  if (const auto* failure = std::getenv("DAW_AE08_ASSET_ONLY")) {
    TestCheckpoint3Assets(*failure); return 0;
  }
  for (const char failure : {'a', 'b', 'c', 'd', 'e', 'f'}) TestCheckpoint3Assets(failure);
  TestCheckpoint3StagedInstrumentAssets();
  TestCheckpoint2SaturatedNoteOffSeam();
  TestCheckpoint2SaturatedNoteOffSeam(true);
  TestCheckpoint2SaturatedRebaseProgress();
  TestCheckpoint2OutOfOrderChunksAndCancellation();
  if (std::getenv("DAW_AE08_SATURATION_ONLY")) return 0;
  TestCheckpoint2RemovedTargetCancelsPendingLiveControl();
  TestCheckpoint2RebaseAndShortBlocks();
  TestCheckpoint2CapacityAndPreparedTargets();
  if (std::getenv("DAW_AE08_VST_BANK_ONLY")) { TestVstAutomationSegmentsReclaimWithinEpoch(); return 0; }
  TestCheckpoint2HeldNoteSeam();
  if (std::getenv("DAW_AE08_SEEK_ONLY")) { TestCheckpoint2SeekCancelsUnpublished(); return 0; }
  TestCheckpoint2LateFrame();
  TestCheckpoint2SeekCancelsUnpublished();
  TestCheckpoint2FuturePublication();
  TestCheckpoint2StagedBank();
  TestActiveScheduleRefillsDuringGraphPreparation();
  TestPrepareAutoRetiresCompletedRevision();
  if (std::getenv("DAW_AE08_PHASE5_ONLY") != nullptr) return 0;
  TestStopBeforeFirstCallbackDoesNotPublishEmptyProgress();
  TestDeviceLossTerminatesPendingTransition();
  TestKeepLatencyDiagnosticReply();
  TestLatencyMoveCompletionQueuesTheNextRevision();
  TestPublishEvidenceCarriesTheAppliedLatency();
  TestPausedPublicationReconcilesScheduledTargets();
  if (std::getenv("DAW_AE08_LATENCY_ONLY") != nullptr) return 0;
  if (std::getenv("DAW_PHASE2_VALIDATION_BENCHMARK") != nullptr) {
    MeasureInstrumentValidation();
    return 0;
  }
  TestScheduledInstrumentAdmission();
  for (const auto kind : {DAW_AUDIO_INSTRUMENT_KIND_SAMPLER, DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK,
    DAW_AUDIO_INSTRUMENT_KIND_GRANULAR}) TestPagedInstrumentOutput(kind, 0.98F, 1, true);
  TestInstrumentRejectionBurstRendersValidSubset();
  TestOfflineExportRejectsInjectedInstrumentFailure();
  if (std::getenv("DAW_R24_BURST_ONLY") != nullptr) return 0;
  if (std::getenv("DAW_R23_REJECTION_ONLY") != nullptr) {
    TestPermanentInstrumentRejectionRecovers();
    return 0;
  }
  TestInstrumentAdmissionAndVoiceStealing();
  TestPermanentInstrumentRejectionRecovers();
  TestMixedInstrumentSequenceDomains();
  TestMixedInstrumentSequenceDomains(true);
  {
    // A device may halt after claiming the request but before acknowledging.
    // Exercise the exact production wait helper without blocking an audio thread.
    std::atomic<std::uint32_t> requested{0}, acknowledged{0};
    std::mutex mutex;
    std::condition_variable wake;
    const auto started = std::chrono::steady_clock::now();
    const auto claimed = daw::audio_host_macos::WaitForCallbackRequest(
      wake, mutex, requested, acknowledged, 7U, [] { return false; });
    assert(claimed == daw::audio_host_macos::CallbackWait::kUnresolved);
    assert(std::chrono::steady_clock::now() - started < std::chrono::seconds(2));
    requested.store(8);
    const auto halted = daw::audio_host_macos::WaitForCallbackRequest(
      wake, mutex, requested, acknowledged, 8U, [] { return true; });
    assert(halted == daw::audio_host_macos::CallbackWait::kCancelled);
    acknowledged.store(7);
    const auto late = daw::audio_host_macos::WaitForCallbackRequest(
      wake, mutex, requested, acknowledged, 7U, [] { return false; });
    assert(late == daw::audio_host_macos::CallbackWait::kAcknowledged);
  }
  {
    // A processor patch the callback claimed but has not acknowledged keeps graph
    // preparation and further patches refused until the late acknowledgement.
    std::atomic<std::uint64_t> requested{0}, acknowledged{0};
    std::mutex mutex;
    std::condition_variable wake;
    daw::audio_host_macos::ClaimedRequest<std::uint64_t> claimed;
    assert(!claimed.Pending(acknowledged));
    assert(daw::audio_host_macos::WaitForCallbackRequest(
      wake, mutex, requested, acknowledged, 3ULL, [] { return false; })
      == daw::audio_host_macos::CallbackWait::kUnresolved);
    claimed.Record(3);
    assert(claimed.Pending(acknowledged));
    acknowledged.store(2);
    assert(claimed.Pending(acknowledged));
    acknowledged.store(3);
    assert(!claimed.Pending(acknowledged));
    assert(!claimed.Pending(acknowledged));
  }
  {
    // Callback/storage ownership: fill the bounded tap without a consumer,
    // overflow once, then drain off-thread and verify the durable failure proof.
    const auto directory = std::filesystem::temp_directory_path()
      / ("ae08-tap-isolation-" + std::to_string(getpid()));
    std::filesystem::create_directory(directory);
    setenv("DAW_AE08_EVIDENCE_DIR", directory.c_str(), 1);
    {
      daw::audio_host_macos::AcceptanceOutputTap tap;
      tap.Configure(48000, 2);
      std::array<float, 1024> left{}, right{};
      left.fill(0.25F); right.fill(-0.5F);
      float* planes[]{left.data(), right.data()};
      for (unsigned block = 0; block < 1025; ++block) tap.Push(planes, 1024);
      tap.Drain();
    }
    unsetenv("DAW_AE08_EVIDENCE_DIR");
    const auto log = directory / ("native-" + std::to_string(getpid()) + ".jsonl");
    auto* file = std::fopen(log.c_str(), "rb");
    assert(file != nullptr);
    std::array<char, 4096> bytes{};
    std::fseek(file, 0, SEEK_END);
    const auto size = std::ftell(file);
    std::fseek(file, std::max<long>(0, size - bytes.size()), SEEK_SET);
    const auto length = std::fread(bytes.data(), 1, bytes.size(), file);
    std::fclose(file);
    assert(std::string_view(bytes.data(), length).find("\"overflowFrames\":1024") != std::string_view::npos);
    std::filesystem::remove_all(directory);
  }
  TestWorkerAutomationSelection();
  TestDeviceNamespace();
  TestControlFrames();
  TestOfflineTerminalIsPublishedBeforeStop();
  TestNativeVstEventScheduler();
  TestNativeVstAutomationOverrideTable();
  TestCallbackPlanarBuffersAndSplitting();
  TestOfflineStartProcessesWithoutDevice();
  TestEmptyGranularInstrumentState();
  TestPackedInstrumentStatePayloadBounds();
  TestStaleUrgentInstrumentEventIsDiscardedAfterTransportEpochAdvance();
  TestPausedProcessDoesNotAdvanceTransportFrame();
  TestProcessorStatePatchTimeoutCancelsAndReusesSlot();
  TestPatchClaimResolvesWhilePausedAndQuiet();
  TestPatchClaimsAreSerializedUntilReported();
  TestPatchClaimAckBeforeRecordStillReports();
  TestPatchClaimResultsStayCoherentWhenAlternating();
  TestParameterBatchIsAllOrNothing();
  TestPatchStatusBranchesAreValid();
  TestNativeMeterQueueAggregatesPostGraphOutput();
  TestNativeVstAttachmentBoundsAndLatencyContract();
  TestInstalledAssetSurvivesCallerLifetimeAndMapGrowth();
  TestMappedAssetSurvivesGraphPublication();
  TestAudioCorePresenceIsTheUnavailableBoundary();
  TestInstrumentResidency();
  TestSharedInstrumentResidency();
  TestRestoredInstrumentAssetIdentity();
  TestInstrumentResidencyReplacementCapacityRollback();
  TestPagedInstrumentOutput(DAW_AUDIO_INSTRUMENT_KIND_SAMPLER);
  TestPagedInstrumentOutput(DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK);
  TestPagedInstrumentOutput(DAW_AUDIO_INSTRUMENT_KIND_GRANULAR);
  TestDrumRackPadsUseTheirOwnAssets();
  TestPagedInstrumentOutput(DAW_AUDIO_INSTRUMENT_KIND_GRANULAR, 0.05F, 0);
  TestPagedInstrumentOutput(DAW_AUDIO_INSTRUMENT_KIND_GRANULAR, 0.5F, 0.5F);
  TestMappedAssetWrittenRangeLedgerIsBounded();
  TestNativeVstRuntimeControlBounds();
  TestNativeVstWatchdogStartupGrace();
  TestRealtimeDurationHistogramBucketsAreBounded();
  TestNativeSessionWireRejectsMalformedFramesAndEvents();
  TestScheduledProcessorSetUsesAbsoluteFrame();
  TestScheduledProcessorRampExpandsAtAdaptiveStride();
  TestScheduledProcessorRampsStayWithinBlockCap();
  TestScheduleWindowCompletionSemantics();
  TestScheduleWindowRollback();
  TestLargeFinalScheduleWindowUsesPersistentStaging();
  TestVstAutomationSegmentsReclaimWithinEpoch();
  TestNoActiveDeviceFailsGracefully();
  TestRejectedBlockDiagnosticsIdentifyLifecycleRejection();
  TestCoreAudioDeviceLossRoutesBySessionRole();
  TestRollbackSafeGraphRevisionLifecycle();
  TestTransitionExhaustionFailsWithoutColdCore();
  TestUnorderableEditFailsWithoutColdCore();
  TestFallbackPublishesConfiguredInstrumentState();
  TestWorkerNotificationCarriesRevisionIdentity();
  TestWorkerNotificationQueuePolicy();
  TestLatencyReportPublishesWithoutStop();
  TestComponentRestartIsWorkerLocal();
  TestWorkerFaultIsolatesOnlyThatAttachment();
  TestStagedAttachmentJoinsAPublishedGraph();
  TestCaptureBoundRoutingIsLocked();
  TestCaptureDoesNotBindANodeAPreparedRevisionDrops();
  TestStagedAttachmentThatIsNotReadyIsRetiredAtPublication();
  TestRollbackRetiresEveryStagedAttachment();
  TestUndoBeforePublicationBindsNothing();
  TestRapidInsertUndoBurstKeepsEveryInstanceOwned();
  TestRetiringASlowWorkerDoesNotBlockTheCommandLoop();
  TestParkedInstanceRejoinsWithoutAReload();
  TestUndoBeforeTheDeletePublishesKeepsTheLiveBinding();
  TestParkedInstanceThatChangedIsLoadedAgain();
  TestRejoinInsideTheRetireWindowKeepsWhatTheCallbackReads();
  TestParkingIsBoundedByCountAndAge();
  TestRetireDuringPublicationKeepsTheWorkerTheCallbackReads();
  return 0;
}
