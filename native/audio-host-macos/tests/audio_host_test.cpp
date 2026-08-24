#include "daw/audio_host_macos.h"
#include "daw/audio_host_automation_override.h"
#include "daw/audio_host_event_scheduler.h"
#include "daw/audio_core_native.h"
#include "daw/audio_core_instrument_wire.h"
#include <array>
#include <cassert>
#include <chrono>
#include <cstring>
#include <future>
#include <limits>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace {

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
    AppendLeU32(payload, 0);
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
  }
  std::vector<std::uint8_t> frame;
  AppendBeU64(frame, revision);
  AppendBeU32(frame, static_cast<std::uint32_t>(payload.size()));
  frame.insert(frame.end(), payload.begin(), payload.end());
  return frame;
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
  AppendLeU32(payload, 0);
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
    AppendLeU64(payload, 2);
    AppendLeU64(payload, index + 1);
    AppendLeU64(payload, index + 1);
    AppendLeU32(payload, epoch);
    AppendLeU32(payload, static_cast<std::uint32_t>(start_frame + index));
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
  assert(transaction == std::vector<std::uint8_t>({
    0x44, 0x41, 0x57, 0x48,
    0x00, 0x00, 0x00, 0x10,
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
  assert(host.StartOffline());
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
  assert(!timed_out.get());

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
  assert(applied.get());
  assert(output_left[0] > 1.99F && output_left[0] < 2.01F);
  host.Stop();
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
  assert(invalid.QueueScheduleWindow(ScheduleWindow(2, 1, 1, 0, 4, 0, 2, false)));
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
  assert(host.PrepareAndPublishGraph(2, GraphSnapshot(2, 1.0F)));
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

void TestLargeFinalScheduleWindowUsesPersistentStaging() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 512,
    .channel_count = 2,
    .revision = 1,
  }));
  assert(host.PrepareAndPublishGraph(2, GraphSnapshot(2, 1.0F)));
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

void TestRollbackSafeGraphRevisionLifecycle() {
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
  const auto prepared = host.PrepareGraphRevision(2, second_graph);
  assert(prepared.code == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  daw::audio_host_macos::GraphRevisionStatus published{};
  std::thread publisher([&] {
    published = host.PublishGraphRevision(2);
  });
  std::this_thread::sleep_for(std::chrono::milliseconds(1));
  output_left.fill(0.0F);
  output_right.fill(0.0F);
  assert(host.ProcessPlanar(input, output, 4));
  publisher.join();
  assert(published.code == daw::audio_host_macos::GraphRevisionStatusCode::kPublished);
  assert(published.active_revision == 2 && published.retired_revision == 1);
  assert(output_left[0] == 0.25F && output_right[0] == 0.25F);
  const auto stale = host.PublishGraphRevision(1);
  assert(stale.code == daw::audio_host_macos::GraphRevisionStatusCode::kStaleRevision);
  const auto retired = host.RetireGraphRevision(1);
  assert(retired.code == daw::audio_host_macos::GraphRevisionStatusCode::kRetired);
  assert(retired.render_epoch >= published.render_epoch);
  const auto third_graph = GraphSnapshot(3, 0.5F);
  assert(host.PrepareGraphRevision(3, third_graph).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  const auto publish_timeout = host.PublishGraphRevision(3);
  assert(publish_timeout.code == daw::audio_host_macos::GraphRevisionStatusCode::kPublishFailed);
  assert(publish_timeout.active_revision == 2 && publish_timeout.prepared_revision == 3);
  assert(host.RollbackGraphRevision(3).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kRolledBack);
  host.Stop();
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

int main() {
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
  TestNativeMeterQueueAggregatesPostGraphOutput();
  TestNativeVstAttachmentBoundsAndLatencyContract();
  TestNativeVstRuntimeControlBounds();
  TestNativeVstWatchdogStartupGrace();
  TestNativeSessionWireRejectsMalformedFramesAndEvents();
  TestScheduleWindowCompletionSemantics();
  TestScheduleWindowRollback();
  TestLargeFinalScheduleWindowUsesPersistentStaging();
  TestVstAutomationSegmentsReclaimWithinEpoch();
  TestNoActiveDeviceFailsGracefully();
  TestRejectedBlockDiagnosticsIdentifyLifecycleRejection();
  TestCoreAudioDeviceLossRoutesBySessionRole();
  TestRollbackSafeGraphRevisionLifecycle();
  TestFallbackPublishesConfiguredInstrumentState();
  TestWorkerNotificationCarriesRevisionIdentity();
  TestWorkerNotificationQueuePolicy();
  return 0;
}
