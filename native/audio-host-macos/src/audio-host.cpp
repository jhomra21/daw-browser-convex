#include "daw/audio_host_macos.h"
#include "revision-publication-wait.h"
#include "daw/audio_host_automation_override.h"
#include "daw/native-schedule-state.h"
#include "daw/audio_host_event_scheduler.h"
#include "daw/audio_core_native.h"
#include "daw/audio_core_instrument_wire.h"
#include "worker-control-protocol.h"
#include "worker-control-service.h"
#include "worker-supervisor.h"
#include "acceptance-output-tap.h"

#include <mach-o/dyld.h>

#include <fcntl.h>
#include <sys/mman.h>
#include <sys/sysctl.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <deque>
#include <filesystem>
#include <limits>
#include <memory>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <unordered_set>

#if defined(DAW_AUDIO_HOST_TEST_MEMORY_LOCK)
extern "C" bool daw_audio_host_test_fail_memory_lock();
extern "C" std::uint64_t daw_audio_host_test_resident_budget();
extern "C" void daw_audio_host_test_validation_memory(bool begin);
extern "C" void daw_audio_host_test_transport_context(
  std::int64_t frame, double bpm, std::uint32_t numerator, std::uint32_t denominator);
#endif

namespace daw::audio_host_macos {
namespace {

constexpr std::uint64_t kInstrumentDeviceBytes = 1ULL << 30;

std::uint64_t InstrumentResidentBudget() {
#if defined(DAW_AUDIO_HOST_TEST_MEMORY_LOCK)
  const auto test_budget = daw_audio_host_test_resident_budget();
  if (test_budget != UINT64_MAX) return test_budget;
#endif
  // Reserve at most 1/8 of physical RAM for this host's native copy. Phase 3
  // also charges renderer PCM and live/export overlap against its shared policy.
  std::uint64_t bytes = 0;
  std::size_t size = sizeof(bytes);
  return sysctlbyname("hw.memsize", &bytes, &size, nullptr, 0) == 0 ? bytes / 8 : 0;
}

bool LockInstrumentMemory(void* address, const std::size_t bytes) {
#if defined(DAW_AUDIO_HOST_TEST_MEMORY_LOCK)
  if (daw_audio_host_test_fail_memory_lock()) return false;
#endif
  return mlock(address, bytes) == 0;
}

constexpr std::uint32_t kFrameMagic = 0x44415748U;  // DAWH
constexpr std::size_t kMaximumNativeVstAttachments = 64;
constexpr std::uint32_t kMaximumNativeVstFrames = 8'192;
constexpr std::uint32_t kMaximumNativeVstChannels = 64;
constexpr std::uint32_t kMaximumNativeVstSlots = 8;
constexpr std::size_t kGranularStateWireBytes = 60;
constexpr std::size_t kMaximumMeterQueueEntries = 1024;
constexpr std::size_t kMaximumSpectrumQueueEntries = 8;
constexpr std::uint32_t kSpectrumFftSize = 2048;

#if defined(DAW_AUDIO_HOST_TEST_PATCH_CLAIM)
// Compiled only into the private test and acceptance targets (CMakeLists.txt). No runtime
// switch exists, so no environment can enable it in another artifact.
constexpr std::uint64_t kTestPatchClaimTokenBase = 1ULL << 53U;
// The acceptance executable always holds; the unit-test target opts in per test.
std::atomic<bool> test_patch_claim_hold{DAW_AUDIO_HOST_TEST_PATCH_CLAIM == 2};
#if DAW_AUDIO_HOST_TEST_PATCH_CLAIM == 1
std::atomic<void (*)()> test_patch_claim_hook{nullptr};
// Runs on the callback thread with the (ack, result) pair as it reads when the ack is stored.
std::atomic<void (*)(std::uint64_t, std::uint32_t)> test_patch_ack_hook{nullptr};
// Makes the next applied patch fail in the core (no staged patch left), so a claim can
// resolve with a failure result.
std::atomic<bool> test_patch_claim_discard{false};
// Starts attached workers without a plug-in, so the host's worker handling runs in CTest.
std::atomic<bool> test_no_plugin_workers{false};
// Replaces the worker executable (a child that is slow to exit). Set from the test thread
// before any attach; the command thread is that same thread.
std::string test_worker_executable;
#endif
#endif

template <std::size_t Size>
Diagnostics::DurationQuantiles DurationQuantiles(
  const std::array<std::uint64_t, Size>& buckets,
  const std::uint64_t count,
  const std::uint64_t maximum
) {
  Diagnostics::DurationQuantiles result{.maximum_nanoseconds = maximum};
  if (count == 0) return result;
  const auto value = [&](const std::uint64_t numerator, const std::uint64_t denominator) {
    const auto target = std::max<std::uint64_t>(1, (count * numerator + denominator - 1) / denominator);
    std::uint64_t cumulative = 0;
    for (std::size_t index = 0; index < buckets.size(); ++index) {
      cumulative += buckets[index];
      if (cumulative >= target) return std::uint64_t{1} << index;
    }
    return maximum;
  };
  result.p50_nanoseconds = value(50, 100);
  result.p95_nanoseconds = value(95, 100);
  result.p99_nanoseconds = value(99, 100);
  return result;
}

std::optional<std::string> WorkerExecutablePath() {
#if defined(DAW_AUDIO_HOST_TEST_PATCH_CLAIM) && DAW_AUDIO_HOST_TEST_PATCH_CLAIM == 1
  if (!test_worker_executable.empty()) return test_worker_executable;
#endif
  std::uint32_t size = 0;
  if (_NSGetExecutablePath(nullptr, &size) != -1 || size == 0 || size > 16U * 1024U) return std::nullopt;
  std::vector<char> executable(size);
  if (_NSGetExecutablePath(executable.data(), &size) != 0) return std::nullopt;
  std::error_code error;
  const auto host = std::filesystem::canonical(executable.data(), error);
  if (error) return std::nullopt;
  const std::array candidates{
    host.parent_path() / daw::plugin_host::kWorkerArtifactId,
    host.parent_path().parent_path() / "plugin-host" / daw::plugin_host::kWorkerArtifactId,
  };
  for (const auto& candidate : candidates) {
    error.clear();
    const auto worker = std::filesystem::canonical(candidate, error);
    if (!error && std::filesystem::is_regular_file(worker, error) && !error) return worker.string();
  }
  return std::nullopt;
}

std::uint32_t ReadU32(const std::uint8_t* bytes) {
  return (static_cast<std::uint32_t>(bytes[0]) << 24U)
    | (static_cast<std::uint32_t>(bytes[1]) << 16U)
    | (static_cast<std::uint32_t>(bytes[2]) << 8U)
    | static_cast<std::uint32_t>(bytes[3]);
}

std::uint32_t ReadLeU32(const std::uint8_t* bytes) {
  return static_cast<std::uint32_t>(bytes[0])
    | (static_cast<std::uint32_t>(bytes[1]) << 8U)
    | (static_cast<std::uint32_t>(bytes[2]) << 16U)
    | (static_cast<std::uint32_t>(bytes[3]) << 24U);
}

void LogGraphPrepareFailure(
  const std::uint32_t revision,
  const daw_audio_core_result result,
  const daw_audio_core_handle core
) {
  const auto diagnostic = daw_audio_core_get_graph_validation_diagnostic(core);
  if (diagnostic.code == DAW_AUDIO_CORE_GRAPH_VALIDATION_PDC_DELAY_EXCEEDS_RING_CAPACITY) {
    std::fprintf(stderr, "This path requires %u frames of compensation delay. The product maximum is 65,536 frames (1.37 s at 48 kHz).\n", diagnostic.actual);
  } else if (diagnostic.code == DAW_AUDIO_CORE_GRAPH_VALIDATION_PATH_LATENCY_EXCEEDS_PRODUCT_MAXIMUM) {
    std::fprintf(stderr, "This graph path reports %u frames of latency. The product maximum is 65,536 frames (1.37 s at 48 kHz).\n", diagnostic.actual);
  } else if (diagnostic.code == DAW_AUDIO_CORE_GRAPH_VALIDATION_KEEP_LATENCY_DIVERGENT_MIXED_BUS) {
    std::fprintf(stderr, "Keep Latency cannot mix monitored and compensated signals in a bus with unequal downstream latency paths (%u versus %u frames). Route them through separate buses.\n", diagnostic.actual, diagnostic.limit);
  }
  std::fprintf(
    stderr,
    "[native-graph] prepare rejected {revision:%u,result:%u,diagnostic:%u,index:%u,actual:%u,limit:%u}\n",
    revision,
    static_cast<unsigned int>(result),
    diagnostic.code,
    diagnostic.index,
    diagnostic.actual,
    diagnostic.limit);
}

std::uint64_t ReadLeU64(const std::uint8_t* bytes) {
  std::uint64_t value = 0;
  for (std::size_t index = 0; index < 8; ++index) value |= static_cast<std::uint64_t>(bytes[index]) << (index * 8U);
  return value;
}
std::int64_t ReadLeI64(const std::uint8_t* bytes) {
  return static_cast<std::int64_t>(ReadLeU64(bytes));
}

float ReadLeFloat(const std::uint8_t* bytes) {
  const std::uint32_t bits = ReadLeU32(bytes);
  float value = 0.0F;
  std::memcpy(&value, &bits, sizeof(value));
  return value;
}

double ReadLeDouble(const std::uint8_t* bytes) {
  const std::uint64_t bits = ReadLeU64(bytes);
  double value = 0.0;
  std::memcpy(&value, &bits, sizeof(value));
  return value;
}

// An edge as routing sees it. Gain and delay compensation are not routing: a level change or a latency
// recompute must never read as a reroute.
struct RouteEdge {
  std::uint64_t from = 0;
  std::uint64_t to = 0;
  std::uint64_t processor = 0;
  std::uint32_t tap = 0;
  std::uint32_t sidechain = 0;
  auto operator<=>(const RouteEdge&) const = default;
};

struct PlanRouting {
  std::vector<std::uint64_t> nodes;
  std::vector<RouteEdge> edges;
};

// Bytes one node takes in a graph envelope of this version.
std::size_t GraphNodeBytes(const std::uint32_t version) {
  return version == DAW_AUDIO_CORE_NATIVE_GRAPH_ENVELOPE_VERSION_KEEP_LATENCY ? 140U
    : version >= DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION_EXTERNAL_LATENCY ? 136U : 132U;
}

std::optional<PlanRouting> ParsePlanRouting(const std::span<const std::uint8_t> payload) {
  if (payload.size() < 24) return std::nullopt;
  const std::size_t node_bytes = GraphNodeBytes(ReadLeU32(payload.data()));
  const std::size_t node_count = ReadLeU32(payload.data() + 8);
  const std::size_t edge_count = ReadLeU32(payload.data() + 12);
  const std::size_t edges_at = 24 + node_count * node_bytes;
  if (node_count > 64 || payload.size() < edges_at || (payload.size() - edges_at) / 48 < edge_count) return std::nullopt;
  PlanRouting plan;
  for (std::size_t index = 0; index < node_count; ++index)
    plan.nodes.push_back(ReadLeU64(payload.data() + 24 + index * node_bytes));
  for (std::size_t index = 0; index < edge_count; ++index) {
    const auto* edge = payload.data() + edges_at + index * 48;
    plan.edges.push_back({ReadLeU64(edge + 8), ReadLeU64(edge + 16), ReadLeU64(edge + 24),
      ReadLeU32(edge + 36), ReadLeU32(edge + 40)});
  }
  return plan;
}

// Every edge on a path leaving `target`, sorted: its output, through any group or send, to the master.
std::vector<RouteEdge> DownstreamRoute(const PlanRouting& plan, const std::uint64_t target) {
  std::vector<RouteEdge> route;
  std::vector<std::uint64_t> frontier{target};
  std::unordered_set<std::uint64_t> seen{target};
  while (!frontier.empty()) {
    const auto node = frontier.back();
    frontier.pop_back();
    for (const auto& edge : plan.edges) {
      if (edge.from != node) continue;
      route.push_back(edge);
      if (seen.insert(edge.to).second) frontier.push_back(edge.to);
    }
  }
  std::sort(route.begin(), route.end());
  return route;
}

bool PlanContainsNode(const PlanRouting& plan, const std::uint64_t node) {
  return std::find(plan.nodes.begin(), plan.nodes.end(), node) != plan.nodes.end();
}

bool CaptureTargetKept(const PlanRouting& published, const PlanRouting& proposed, const std::uint64_t target) {
  return PlanContainsNode(proposed, target) && DownstreamRoute(published, target) == DownstreamRoute(proposed, target);
}

bool ReadNativeInstanceId(const std::span<const std::uint8_t> payload, std::size_t& offset, std::string& instance_id) {
  if (offset + 4 > payload.size()) return false;
  const std::uint32_t length = ReadLeU32(payload.data() + offset);
  offset += 4;
  if (length == 0 || length > 256 || offset + length > payload.size()) return false;
  instance_id.assign(reinterpret_cast<const char*>(payload.data() + offset), length);
  offset += length;
  return true;
}

void WriteU32(std::vector<std::uint8_t>& bytes, std::size_t offset, std::uint32_t value) {
  bytes[offset] = static_cast<std::uint8_t>(value >> 24U);
  bytes[offset + 1] = static_cast<std::uint8_t>(value >> 16U);
  bytes[offset + 2] = static_cast<std::uint8_t>(value >> 8U);
  bytes[offset + 3] = static_cast<std::uint8_t>(value);
}

bool ValidConfig(const HostConfig& config) {
  return !config.device_uid.empty()
    && config.sample_rate_hz > 0
    && config.max_frames_per_block > 0
    && config.channel_count > 0
    && config.revision > 0;
}

bool ValidNativeVstAttachment(const NativeVstAttachment& attachment) {
  const auto channels_for_layout = [](const std::uint32_t layout) {
    return layout == DAW_AUDIO_GRAPH_LAYOUT_MONO ? 1U
      : layout == DAW_AUDIO_GRAPH_LAYOUT_STEREO ? 2U : 0U;
  };
  const std::uint32_t input_channels = channels_for_layout(attachment.input_layout);
  const std::uint32_t output_channels = channels_for_layout(attachment.output_layout);
  const bool instrument = attachment.role == NativeVstRole::kInstrument;
  if (attachment.graph_node_id == 0 || attachment.instance_id.empty() || attachment.instance_id.size() > 256
    || attachment.class_id.empty() || attachment.class_id.size() > 256 || attachment.vendor_id.empty()
    || attachment.vendor_id.size() > 256 || attachment.canonical_bundle_path.empty()
    || attachment.canonical_executable_path.empty()
    || !attachment.canonical_executable_path.starts_with(attachment.canonical_bundle_path + "/")
    || attachment.architecture != 1 || attachment.scanner_catalog_version != 2
    || (attachment.role != NativeVstRole::kEffect && attachment.role != NativeVstRole::kInstrument)
    || (!instrument && attachment.input_layout != DAW_AUDIO_GRAPH_LAYOUT_MONO
      && attachment.input_layout != DAW_AUDIO_GRAPH_LAYOUT_STEREO)
    || (instrument && attachment.input_layout != 0)
    || (attachment.output_layout != DAW_AUDIO_GRAPH_LAYOUT_MONO && attachment.output_layout != DAW_AUDIO_GRAPH_LAYOUT_STEREO)
    || attachment.transport.slot_count == 0 || attachment.transport.slot_count > kMaximumNativeVstSlots
    || attachment.transport.maximum_frames == 0 || attachment.transport.maximum_frames > kMaximumNativeVstFrames
    || attachment.transport.input_channels > kMaximumNativeVstChannels
    || attachment.transport.output_channels == 0 || attachment.transport.output_channels > kMaximumNativeVstChannels
    || attachment.transport.maximum_events_per_block == 0 || attachment.transport.maximum_events_per_block > daw::plugin_host::kMaximumWorkerEvents
    || (!instrument && input_channels == 0) || output_channels == 0
    || attachment.transport.input_channels != input_channels || attachment.transport.output_channels != output_channels
    || attachment.transport_latency_frames != attachment.transport.maximum_frames
    || attachment.declared_latency_frames > std::numeric_limits<std::uint32_t>::max() - attachment.transport_latency_frames
    || (attachment.infinite_tail && attachment.declared_tail_frames)
    || (attachment.declared_tail_frames
      && !daw::plugin_host::IsValidFiniteWorkerTailFrames(*attachment.declared_tail_frames))
    || std::all_of(attachment.bundle_fingerprint.begin(), attachment.bundle_fingerprint.end(), [](const auto value) { return value == 0; })
    || std::all_of(attachment.binary_fingerprint.begin(), attachment.binary_fingerprint.end(), [](const auto value) { return value == 0; })) {
    return false;
  }
  if (attachment.stage_index >= DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE * 2u) return false;
  if (instrument && attachment.source_index != 0) return false;
  return instrument
    ? attachment.transport.input_channels == 0
    : input_channels == output_channels && attachment.transport.input_channels > 0;
}

std::string HexFingerprint(const std::array<std::uint8_t, 32>& fingerprint) {
  constexpr char kHex[] = "0123456789abcdef";
  std::string result;
  result.resize(fingerprint.size() * 2);
  for (std::size_t index = 0; index < fingerprint.size(); ++index) {
    result[index * 2] = kHex[fingerprint[index] >> 4U];
    result[index * 2 + 1] = kHex[fingerprint[index] & 0x0FU];
  }
  return result;
}

std::uint8_t MidiValue(const float value) noexcept {
  if (!std::isfinite(value) || value <= 0.0F) return 0;
  if (value >= 1.0F) return 127;
  return static_cast<std::uint8_t>(value * 127.0F);
}

bool ValidNativeInstrumentEvent(const daw_audio_instrument_event& event) {
  const bool portable = event.type >= DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON
    && event.type <= DAW_AUDIO_INSTRUMENT_EVENT_PARAMETER;
  const bool native = event.type >= static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOn)
    && event.type <= static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kAllSoundOff);
  if (event.node_id == 0 || event.epoch == 0 || event.sequence == 0 || event.channel > 15
    || event.note > 127 || !std::isfinite(event.value) || (!portable && !native)) return false;
  if ((event.type == DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON
      || event.type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOn))
    && (event.note_id == 0 || event.value < 0.0F || event.value > 1.0F)) return false;
  if ((event.type == DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF
      || event.type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOff))
    && event.note_id == 0) return false;
  return true;
}

bool ValidNativeSampleSourceEvent(const daw_audio_sample_source_event& event) {
  return event.epoch != 0
    && event.sequence != 0
    && event.asset != 0
    && event.stop_frame > event.start_frame
    && event.source_frame_count > 0
    && std::isfinite(event.gain)
    && std::isfinite(event.source_offset_fraction)
    && event.source_offset_fraction >= 0.0F && event.source_offset_fraction < 1.0F
    && event.fade_in_start_frame <= event.fade_in_end_frame
    && event.fade_out_start_frame <= event.fade_out_end_frame
    && std::isfinite(event.fade_in_curve)
    && event.fade_in_curve >= -1.0F && event.fade_in_curve <= 1.0F
    && std::isfinite(event.fade_in_curve_position)
    && event.fade_in_curve_position >= 0.0F && event.fade_in_curve_position <= 1.0F
    && std::isfinite(event.fade_out_curve)
    && event.fade_out_curve >= -1.0F && event.fade_out_curve <= 1.0F
    && std::isfinite(event.fade_out_curve_position)
    && event.fade_out_curve_position >= 0.0F && event.fade_out_curve_position <= 1.0F;
}

using NativeVstAutomationSegment = NativeScheduleAutomationSegment;

struct NativeVstWorkerAttachment {
  using AutomationOverrideSetResult = NativeVstAutomationOverrideTable::SetResult;
  struct ActiveNote {
    std::uint64_t note_id = 0;
    std::uint32_t channel = 0;
    std::uint32_t note = 0;
    bool active = false;
  };
  static constexpr std::size_t kActiveNoteCapacity = 256;
  // An instance added to a live graph is staged until a published revision binds it,
  // then active; it is retired when it was never ready, was undone, or its revision
  // rolled back. A detached ready instance is parked for a bounded count and age so an
  // undo rejoins it without loading the plug-in again. Control thread only.
  enum class Ownership : std::uint8_t { kStaged, kActive, kParked, kRetired };
  Ownership ownership = Ownership::kActive;
  std::chrono::steady_clock::time_point parked_at{};
  [[nodiscard]] bool Detached() const { return ownership == Ownership::kParked || ownership == Ownership::kRetired; }
  // Which plans still hold this object's address. Retired objects are freed once neither does.
  bool bound_prepared = false;
  bool bound_active = false;
  NativeVstAttachment metadata;
  std::optional<Diagnostics::WorkerAutomation> worker_automation;
  bool offline = false;
  bool offline_started = false;
  bool offline_parameters_applied = false;
  std::atomic<bool>* offline_failure = nullptr;
  struct WorkerNotificationSink* notification_sink = nullptr;
  daw::plugin_host::WorkerControlService worker;
  std::array<std::uint64_t, kMaximumNativeVstSlots> pending_sequences{};
  std::array<std::uint32_t, kMaximumNativeVstSlots> pending_frames{};
  std::array<std::uint32_t, kMaximumNativeVstSlots> missed_callbacks{};
  std::array<std::uint64_t, kMaximumNativeVstSlots> missed_frames{};
  std::atomic<std::uint64_t> watchdog_misses{0};
  bool realtime_started = false;
  std::array<float, kMaximumNativeVstFrames * 2> input{};
  std::array<float, kMaximumNativeVstFrames * 2> output{};
  static constexpr std::size_t kCompletedOutputFrames = kMaximumNativeVstFrames * kMaximumNativeVstSlots;
  std::array<float, kCompletedOutputFrames * 2> completed_output{};
  std::size_t completed_output_read = 0;
  std::size_t completed_output_write = 0;
  std::uint64_t next_sequence = 1;
  std::uint32_t next_slot = 0;
  std::array<daw::plugin_host::WorkerTransportEvent, daw::plugin_host::kMaximumWorkerEvents> block_events{};
  std::array<daw::plugin_host::WorkerTransportEvent, daw::plugin_host::kMaximumWorkerEvents> sorted_block_events{};
  std::array<std::uint16_t, kMaximumNativeVstFrames> event_offsets{};
  NativeVstEventScheduler event_scheduler{};
  struct AutomationBank {
    std::array<std::array<NativeVstAutomationSegment, kMaximumScheduleAutomationSegments>, 2> segments{};
    std::atomic<std::uint32_t> count = 0;
    std::array<std::uint32_t, 2> buffer_counts{};
    std::atomic<std::uint32_t> buffer = 0;
    std::atomic<std::uint32_t> epoch = 0;
    std::atomic<bool> reading = false;
    std::atomic<std::uint32_t> callback_buffer = 0;
  };
  std::array<AutomationBank, 2> automation_banks{};
  const std::atomic<std::uint32_t>* active_schedule_bank = nullptr;
  NativeVstAutomationOverrideTable automation_overrides{};
  std::array<ActiveNote, kActiveNoteCapacity> arranged_notes{};
  std::array<ActiveNote, kActiveNoteCapacity> live_notes{};
  std::atomic<std::uint32_t> note_epoch = 0;

  bool HasAutomationOverride(const std::uint32_t parameter_id) const noexcept {
    return automation_overrides.Has(parameter_id);
  }

  AutomationOverrideSetResult SetAutomationOverride(const std::uint32_t parameter_id) noexcept {
    return automation_overrides.Set(parameter_id);
  }

  void ClearAutomationOverride(const std::uint32_t parameter_id) noexcept {
    automation_overrides.Clear(parameter_id);
  }

  bool QueueEvents(const std::span<const daw::plugin_host::WorkerTransportEvent> events) {
    return event_scheduler.QueueEvents(events);
  }

  bool ProjectAutomation(
    const std::int64_t block_start,
    const std::uint32_t frame_count,
    std::span<daw::plugin_host::WorkerTransportEvent> events,
    std::size_t& event_count,
    const std::size_t maximum_events
  ) noexcept {
    auto& bank = automation_banks[active_schedule_bank->load(std::memory_order_acquire)];
    auto& automation_callback_reading = bank.reading;
    auto& automation_callback_buffer = bank.callback_buffer;
    auto& automation_buffer = bank.buffer;
    auto& automation_segments = bank.segments;
    const std::uint64_t block_end = static_cast<std::uint64_t>(block_start)
      + static_cast<std::uint64_t>(frame_count);
    const auto buffer = automation_callback_reading.load(std::memory_order_acquire)
      ? automation_callback_buffer.load(std::memory_order_relaxed)
      : automation_buffer.load(std::memory_order_acquire);
    const auto segment_count = bank.buffer_counts[buffer];
    for (std::size_t index = 0; index < segment_count; ++index) {
      const auto& segment = automation_segments[buffer][index];
      if (segment.end_frame <= static_cast<std::uint64_t>(block_start)
        || segment.start_frame >= block_end) continue;
      if (HasAutomationOverride(segment.parameter_id)) {
        continue;
      }
      const auto value_at = [&segment](const std::uint64_t frame) {
        if (!segment.linear || frame <= segment.start_frame) return segment.start_value;
        if (frame >= segment.end_frame) return segment.end_value;
        return segment.start_value + (segment.end_value - segment.start_value)
          * static_cast<double>(frame - segment.start_frame)
          / static_cast<double>(segment.end_frame - segment.start_frame);
      };
      const std::uint64_t first_frame = std::max<std::uint64_t>(
        segment.start_frame,
        static_cast<std::uint64_t>(block_start)
      );
      if (event_count >= maximum_events || event_count >= events.size()) return false;
      events[event_count++] = {
        .kind = daw::plugin_host::WorkerEventKind::kParameter,
        .sampleOffset = static_cast<std::uint32_t>(first_frame - static_cast<std::uint64_t>(block_start)),
        .parameterId = segment.parameter_id,
        .parameterValue = value_at(first_frame),
        .scheduledAutomation = true,
      };
      if (segment.linear && segment.end_frame < block_end
        && segment.end_frame > first_frame) {
        if (event_count >= maximum_events || event_count >= events.size()) return false;
        events[event_count++] = {
          .kind = daw::plugin_host::WorkerEventKind::kParameter,
          .sampleOffset = static_cast<std::uint32_t>(segment.end_frame - static_cast<std::uint64_t>(block_start)),
          .parameterId = segment.parameter_id,
          .parameterValue = value_at(segment.end_frame),
          .scheduledAutomation = true,
        };
        }
    }
    return true;
  }

  struct AutomationPublication {
    AutomationBank* bank = nullptr;
    std::uint32_t buffer = 0;
    std::uint32_t count = 0;
  };
  bool StageAutomation(
    const std::uint32_t epoch,
    const std::uint64_t rendered_through_frame,
    std::span<const NativeVstAutomationSegment> additions,
    const std::uint32_t bank_index,
    AutomationPublication& publication
  ) noexcept {
    auto& bank = automation_banks[bank_index];
    auto& automation_callback_reading = bank.reading;
    auto& automation_callback_buffer = bank.callback_buffer;
    auto& automation_buffer = bank.buffer;
    auto& automation_segments = bank.segments;
    auto& automation_epoch = bank.epoch;
    const auto active_buffer = automation_buffer.load(std::memory_order_acquire);
    const auto inactive_buffer = 1U - active_buffer;
    if (
      automation_callback_reading.load(std::memory_order_acquire)
      && automation_callback_buffer.load(std::memory_order_acquire) == inactive_buffer
    ) return false;
    const auto retained_epoch = automation_epoch.load(std::memory_order_acquire);
    const auto retained_count = retained_epoch == epoch
      ? bank.buffer_counts[active_buffer]
      : 0U;
    std::size_t count = 0;
    auto& destination = automation_segments[inactive_buffer];
    const auto value_at = [](const NativeVstAutomationSegment& segment, const std::uint64_t frame) {
      if (!segment.linear || frame <= segment.start_frame) return segment.start_value;
      if (frame >= segment.end_frame) return segment.end_value;
      return segment.start_value + (segment.end_value - segment.start_value)
        * static_cast<double>(frame - segment.start_frame)
        / static_cast<double>(segment.end_frame - segment.start_frame);
    };
    for (std::size_t index = 0; index < retained_count; ++index) {
      const auto& source = automation_segments[active_buffer][index];
      if (source.end_frame <= rendered_through_frame) continue;
      auto retained = source;
      if (retained.start_frame < rendered_through_frame) {
        retained.start_frame = rendered_through_frame;
        retained.start_value = value_at(source, rendered_through_frame);
      }
      if (count >= destination.size()) return false;
      destination[count++] = retained;
    }
    for (const auto& addition : additions) {
      bool already_covered = false;
      for (std::size_t index = 0; index < count; ++index) {
        const auto& retained = destination[index];
        if (
          retained.parameter_id == addition.parameter_id
          && retained.start_frame == addition.start_frame
          && retained.linear == addition.linear
          && retained.start_value == addition.start_value
          && retained.end_value == addition.end_value
          && retained.end_frame >= addition.end_frame
        ) {
          already_covered = true;
          break;
        }
      }
      if (already_covered) continue;
      if (count >= destination.size()) return false;
      destination[count++] = addition;
    }
    publication = {&bank, inactive_buffer, static_cast<std::uint32_t>(count)};
    return true;
  }

  bool AddMidi(
    const std::uint32_t sample_offset,
    const std::uint8_t status,
    const std::uint32_t channel,
    const std::uint32_t note,
    const std::uint8_t value,
    std::size_t& event_count
  ) noexcept {
    if (event_count >= block_events.size()) return false;
    block_events[event_count++] = {
      .kind = daw::plugin_host::WorkerEventKind::kMidi,
      .sampleOffset = sample_offset,
      .midiData = {
        static_cast<std::uint8_t>(status | std::min(channel, 15U)),
        static_cast<std::uint8_t>(std::min(note, 127U)),
        value,
      },
    };
    return true;
  }

  bool UpdateLedger(
    std::array<ActiveNote, kActiveNoteCapacity>& ledger,
    const daw_audio_instrument_event& event,
    const bool note_on
  ) noexcept {
    if (note_on) {
      for (auto& note : ledger) {
        if (!note.active) {
          note = {.note_id = event.note_id, .channel = event.channel, .note = event.note, .active = true};
          return true;
        }
      }
      return false;
    }
    for (auto& note : ledger) {
      if (note.active && note.note_id == event.note_id) {
        note.active = false;
        return true;
      }
    }
    return true;
  }

  bool ReleaseArranged(
    const std::uint32_t sample_offset,
    std::size_t& event_count
  ) noexcept {
    for (auto& note : arranged_notes) {
      if (!note.active) continue;
      if (!AddMidi(sample_offset, 0x80, note.channel, note.note, 0, event_count)) return false;
      note.active = false;
    }
    return true;
  }

  void ClearLedgers() noexcept {
    arranged_notes.fill({});
    live_notes.fill({});
  }

  void WriteFallback(const daw::audio_core::NativeGraphNodeRender& render) noexcept {
    for (std::uint32_t channel = 0; channel < render.channel_count; ++channel) {
      std::fill_n(render.planes[channel], render.frame_count, 0.0F);
    }
  }

  bool ProcessOffline(const daw::audio_core::NativeGraphNodeRender& render) {
    const std::uint32_t input_channels = metadata.transport.input_channels;
    const std::uint32_t output_channels = metadata.transport.output_channels;
    if (!metadata.render_enabled) {
      if (metadata.role == NativeVstRole::kInstrument) WriteFallback(render);
      return true;
    }
    if (render.frame_count == 0 || render.channel_count != output_channels
      || render.channel_count > 2 || output_channels > 2
      || render.frame_count > metadata.transport.maximum_frames) {
      WriteFallback(render);
      return false;
    }
    if (input_channels > 0) {
      for (std::uint32_t channel = 0; channel < input_channels; ++channel) {
        std::memcpy(input.data() + channel * render.frame_count, render.planes[channel],
          render.frame_count * sizeof(float));
      }
    }
    std::size_t event_count = 0;
    const auto initial_parameter_count = metadata.initial_parameter_values.size();
    const auto maximum_events = std::min<std::size_t>(
      daw::plugin_host::kMaximumWorkerEvents,
      metadata.transport.maximum_events_per_block + initial_parameter_count
    );
    const bool discontinuity = !offline_started
      || note_epoch.exchange(render.transport_epoch, std::memory_order_acq_rel) != render.transport_epoch;
    offline_started = true;
    if (!offline_parameters_applied) {
      for (const auto& [parameter_id, parameter_value] : metadata.initial_parameter_values) {
        if (event_count >= block_events.size()) return false;
        block_events[event_count++] = {
          .kind = daw::plugin_host::WorkerEventKind::kParameter,
          .sampleOffset = 0,
          .parameterId = parameter_id,
          .parameterValue = parameter_value,
        };
      }
      offline_parameters_applied = true;
    }
    if (!ProjectAutomation(
      render.transport_frame,
      render.frame_count,
      std::span<daw::plugin_host::WorkerTransportEvent>(block_events.data(), block_events.size()),
      event_count,
      maximum_events
    )) {
      WriteFallback(render);
      return false;
    }
    for (const auto& event : render.instrument_events) {
      if (event.node_id != metadata.graph_node_id || event.epoch != render.transport_epoch
        || event.frame_offset >= render.frame_count) continue;
      std::uint8_t status = 0;
      if (event.type == DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON
        || event.type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOn)) status = 0x90;
      else if (event.type == DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF
        || event.type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOff)) status = 0x80;
      else if (event.type == DAW_AUDIO_INSTRUMENT_EVENT_SUSTAIN) status = 0xB0;
      else if (event.type == DAW_AUDIO_INSTRUMENT_EVENT_EXPRESSION) status = 0xB0;
      else if (event.type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kTransportRelease)) {
        if (!ReleaseArranged(event.frame_offset, event_count)) return false;
        continue;
      } else if (event.type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kAllSoundOff)) {
        if (!AddMidi(event.frame_offset, 0xB0, event.channel, 123, 0, event_count)
          || !AddMidi(event.frame_offset, 0xB0, event.channel, 120, 0, event_count)) return false;
        continue;
      } else continue;
      if (!AddMidi(
        event.frame_offset,
        status,
        event.channel,
        status == 0xB0 ? (event.type == DAW_AUDIO_INSTRUMENT_EVENT_SUSTAIN ? 64 : 11) : event.note,
        MidiValue(event.value),
        event_count
      )) return false;
    }
    if (event_count > maximum_events) return false;
    std::stable_sort(
      block_events.begin(),
      block_events.begin() + static_cast<std::ptrdiff_t>(event_count),
      [](const auto& left, const auto& right) { return left.sampleOffset < right.sampleOffset; }
    );
    const auto port = worker.callbackPort();
    std::uint32_t slot = 0;
    while (slot < metadata.transport.slot_count && slot < kMaximumNativeVstSlots
      && port.health() != daw::plugin_host::WorkerHealth::kFaulted) {
      const auto& candidate = port;
      const auto sequence = next_sequence++;
      if (candidate.CopyInput(slot, std::span<const float>(
        input.data(), static_cast<std::size_t>(render.frame_count) * input_channels))
        || input_channels == 0) {
        const auto status = worker.ProcessOffline({
          .slotIndex = slot,
          .sequence = sequence,
          .numSamples = render.frame_count,
          .events = std::span<const daw::plugin_host::WorkerTransportEvent>(block_events.data(), event_count),
          .context = {
            .projectTimeSamples = render.project_time_samples,
            .continuousTimeSamples = render.transport_frame,
            .tempoBpm = render.tempo_bpm,
            .projectTimeMusic = render.project_time_music,
            .timeSignatureNumerator = render.time_signature_numerator,
            .timeSignatureDenominator = render.time_signature_denominator,
            .cycleStartMusic = render.cycle_start_music,
            .cycleEndMusic = render.cycle_end_music,
            .transportEpoch = render.transport_epoch,
            .playing = render.transport_running,
            .cycleActive = render.cycle_active,
            .discontinuity = discontinuity,
          },
        }, std::chrono::seconds(5));
        if (status != daw::plugin_host::WorkerSubmissionStatus::kAccepted) break;
        const auto outputCopied = port.CopyCompletedOutput(
          slot,
          sequence,
          std::span<float>(output.data(), output.size())
        );
        if (!outputCopied) break;
        for (std::uint32_t channel = 0; channel < render.channel_count; ++channel) {
          std::memcpy(render.planes[channel], output.data() + channel * render.frame_count,
            render.frame_count * sizeof(float));
        }
        return true;
      }
      ++slot;
    }
    WriteFallback(render);
    return false;
  }

  void Process(const daw::audio_core::NativeGraphNodeRender& render) noexcept {
    if (offline) {
      if (!ProcessOffline(render) && offline_failure != nullptr) {
        offline_failure->store(true, std::memory_order_release);
      }
      return;
    }
    const std::uint32_t input_channels = metadata.transport.input_channels;
    const std::uint32_t output_channels = metadata.transport.output_channels;
    if (!metadata.render_enabled) {
      if (metadata.role == NativeVstRole::kInstrument) WriteFallback(render);
      return;
    }
    if (render.frame_count == 0 || render.channel_count != output_channels
      || render.channel_count > 2 || output_channels > 2) {
      WriteFallback(render);
      return;
    }
    const auto port = worker.callbackPort();
    // CoreAudio can begin callbacks before the isolated worker has completed
    // plugin instantiation. Do not occupy a worker slot while it is starting:
    // the startup watchdog is intentionally finite.
    if (port.health() != daw::plugin_host::WorkerHealth::kReady) {
      WriteFallback(render);
      return;
    }
    if (input_channels > 0) {
      for (std::uint32_t channel = 0; channel < input_channels; ++channel) {
        std::memcpy(input.data() + channel * render.frame_count, render.planes[channel], render.frame_count * sizeof(float));
      }
    }
    for (std::uint32_t slot = 0; slot < metadata.transport.slot_count; ++slot) {
      const std::uint64_t sequence = pending_sequences[slot];
      if (sequence == 0) continue;
      if (port.ReadCompleted(slot, sequence)) {
        const std::size_t completed_frames = pending_frames[slot];
        if (port.CopyCompletedOutput(
          slot,
          sequence,
          std::span<float>(output.data(), output.size())
        )
          && completed_frames <= kCompletedOutputFrames
          && completed_output_write - completed_output_read + completed_frames <= kCompletedOutputFrames) {
          const std::size_t write_offset = completed_output_write % kCompletedOutputFrames;
          const std::size_t first_write = std::min(completed_frames, kCompletedOutputFrames - write_offset);
          for (std::uint32_t channel = 0; channel < render.channel_count; ++channel) {
            std::memcpy(
              completed_output.data() + channel * kCompletedOutputFrames + write_offset,
              output.data() + channel * completed_frames,
              first_write * sizeof(float)
            );
            if (first_write < completed_frames) {
              std::memcpy(
                completed_output.data() + channel * kCompletedOutputFrames,
                output.data() + channel * completed_frames + first_write,
                (completed_frames - first_write) * sizeof(float)
              );
            }
          }
          completed_output_write += completed_frames;
        }
        pending_sequences[slot] = 0;
        pending_frames[slot] = 0;
        realtime_started = true;
        missed_callbacks.fill(0);
        missed_frames.fill(0);
        continue;
      }
      if (daw::audio_host_macos::detail::NativeVstWatchdogShouldMiss(
        realtime_started,
        render.sample_rate_hz,
        render.frame_count,
        missed_frames[slot],
        missed_callbacks[slot]
      )) {
        const auto slot_status = port.ReadStatus(slot, sequence);
        watchdog_misses.fetch_add(1, std::memory_order_relaxed);
        static_cast<void>(port.DiscardLate(slot, sequence + 1));
        static_cast<void>(port.PublishDiagnostic({
          .kind = daw::plugin_host::WorkerDiagnosticKind::kMiss,
          .value = static_cast<std::uint32_t>(slot_status),
          .sequence = sequence,
        }));
        pending_sequences[slot] = 0;
        pending_frames[slot] = 0;
        missed_callbacks[slot] = 0;
        missed_frames[slot] = 0;
      }
    }
    const std::size_t available_frames = completed_output_write - completed_output_read;
    const std::size_t copied_frames = std::min<std::size_t>(available_frames, render.frame_count);
    if (copied_frames > 0) {
      const std::size_t read_offset = completed_output_read % kCompletedOutputFrames;
      const std::size_t first_copy = std::min(copied_frames, kCompletedOutputFrames - read_offset);
      const auto copy_channel = [&](const std::size_t channel, const std::size_t offset, const std::size_t count) {
        std::memcpy(
          render.planes[channel] + offset,
          completed_output.data() + channel * kCompletedOutputFrames + read_offset,
          count * sizeof(float)
        );
      };
      for (std::uint32_t channel = 0; channel < render.channel_count; ++channel) {
        copy_channel(channel, 0, first_copy);
        if (first_copy < copied_frames) {
          std::memcpy(
            render.planes[channel] + first_copy,
            completed_output.data() + channel * kCompletedOutputFrames,
            (copied_frames - first_copy) * sizeof(float)
          );
        }
      }
      completed_output_read += copied_frames;
    }
    for (std::uint32_t channel = 0; channel < render.channel_count; ++channel) {
      std::fill(
        render.planes[channel] + copied_frames,
        render.planes[channel] + render.frame_count,
        0.0F
      );
    }
    // Keep the declared one-block transport pipeline bounded. Do not submit
    // another block while an older completed block is still buffered, or
    // editor control can trail the audible output by multiple blocks.
    if (completed_output_write != completed_output_read) return;
    for (std::uint32_t attempt = 0; attempt < metadata.transport.slot_count; ++attempt) {
      const std::uint32_t slot = (next_slot + attempt) % metadata.transport.slot_count;
      if (pending_sequences[slot] != 0) continue;
      if (input_channels > 0
        && !port.CopyInput(slot, std::span<const float>(
          input.data(),
          static_cast<std::size_t>(render.frame_count) * input_channels))) return;
      const std::uint64_t sequence = next_sequence++;
      const bool discontinuity = note_epoch.exchange(render.transport_epoch, std::memory_order_acq_rel)
        != render.transport_epoch;
      if (discontinuity) {
        ClearLedgers();
      }
      std::size_t event_count = 0;
      auto& automation = automation_banks[active_schedule_bank->load(std::memory_order_acquire)];
      const bool automation_current = automation.epoch.load(std::memory_order_acquire) == render.transport_epoch;
      if (automation_current) {
        automation.callback_buffer.store(
          automation.buffer.load(std::memory_order_acquire),
          std::memory_order_relaxed
        );
        automation.reading.store(true, std::memory_order_release);
        const bool projected = ProjectAutomation(
          render.transport_frame,
          render.frame_count,
          std::span<daw::plugin_host::WorkerTransportEvent>(block_events.data(), block_events.size()),
          event_count,
          metadata.transport.maximum_events_per_block
        );
        automation.reading.store(false, std::memory_order_release);
        if (!projected) return;
      }
      for (const auto& event : render.instrument_events) {
        if (event.node_id != metadata.graph_node_id || event.epoch != render.transport_epoch
          || event.frame_offset >= render.frame_count) continue;
        const auto live_on = event.type == static_cast<std::uint32_t>(
          daw::audio_core::NativeInstrumentEventType::kLiveNoteOn
        );
        const auto live_off = event.type == static_cast<std::uint32_t>(
          daw::audio_core::NativeInstrumentEventType::kLiveNoteOff
        );
        const auto transport_release = event.type == static_cast<std::uint32_t>(
          daw::audio_core::NativeInstrumentEventType::kTransportRelease
        );
        const auto all_sound_off = event.type == static_cast<std::uint32_t>(
          daw::audio_core::NativeInstrumentEventType::kAllSoundOff
        );
        if (transport_release) {
          if (!ReleaseArranged(event.frame_offset, event_count)) return;
          continue;
        }
        if (all_sound_off) {
          if (!AddMidi(event.frame_offset, 0xB0, event.channel, 123, 0, event_count)
            || !AddMidi(event.frame_offset, 0xB0, event.channel, 120, 0, event_count)) return;
          ClearLedgers();
          continue;
        }
        std::uint8_t status = 0;
        if (event.type == DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON || live_on) status = 0x90;
        else if (event.type == DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF || live_off) status = 0x80;
        else if (event.type == DAW_AUDIO_INSTRUMENT_EVENT_SUSTAIN) status = 0xB0;
        else if (event.type == DAW_AUDIO_INSTRUMENT_EVENT_EXPRESSION) status = 0xB0;
        else continue;
        if (live_on && !UpdateLedger(live_notes, event, true)) return;
        if (live_off && !UpdateLedger(live_notes, event, false)) return;
        if (event.type == DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON
          && !UpdateLedger(arranged_notes, event, true)) return;
        if (event.type == DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF
          && !UpdateLedger(arranged_notes, event, false)) return;
        if (event_count >= block_events.size()) return;
        const std::uint8_t channel = static_cast<std::uint8_t>(std::min(event.channel, 15U));
        const std::uint8_t data1 = status == 0xB0
          ? static_cast<std::uint8_t>(event.type == DAW_AUDIO_INSTRUMENT_EVENT_SUSTAIN ? 64 : 11)
          : static_cast<std::uint8_t>(std::min(event.note, 127U));
        block_events[event_count++] = {
          .kind = daw::plugin_host::WorkerEventKind::kMidi,
          .sampleOffset = event.frame_offset,
          .midiData = {
            static_cast<std::uint8_t>(status | channel),
            data1,
            status == 0xB0 ? MidiValue(event.value) : MidiValue(event.value),
          },
        };
      }
      if (event_count > metadata.transport.maximum_events_per_block
        || !event_scheduler.PrepareBlock(
          render.frame_count,
          std::span<daw::plugin_host::WorkerTransportEvent>(block_events.data(), block_events.size()),
          event_count,
          metadata.transport.maximum_events_per_block
        )) return;
      event_offsets.fill(0);
      for (std::size_t index = 0; index < event_count; ++index) ++event_offsets[block_events[index].sampleOffset];
      std::uint16_t offset = 0;
      for (std::uint32_t frame = 0; frame < render.frame_count; ++frame) {
        const auto count = event_offsets[frame];
        event_offsets[frame] = offset;
        offset = static_cast<std::uint16_t>(offset + count);
      }
      for (std::size_t index = 0; index < event_count; ++index) {
        const auto event = block_events[index];
        sorted_block_events[event_offsets[event.sampleOffset]++] = event;
      }
      std::copy_n(sorted_block_events.data(), event_count, block_events.data());
      // A render-enabled VST owns state that can produce audio after arbitrary
      // silent gaps. Tail metadata is informational; only attachment and
      // session lifecycle transitions stop realtime submissions.
      if (port.Submit({.slotIndex = slot, .sequence = sequence, .numSamples = render.frame_count,
        .events = std::span<const daw::plugin_host::WorkerTransportEvent>(block_events.data(), event_count),
        .context = {
          .projectTimeSamples = render.project_time_samples,
          .continuousTimeSamples = render.transport_frame,
          .tempoBpm = render.tempo_bpm,
          .projectTimeMusic = render.project_time_music,
          .timeSignatureNumerator = render.time_signature_numerator,
          .timeSignatureDenominator = render.time_signature_denominator,
          .cycleStartMusic = render.cycle_start_music,
          .cycleEndMusic = render.cycle_end_music,
          .transportEpoch = render.transport_epoch,
          .playing = render.transport_running,
          .recording = false,
          .cycleActive = render.cycle_active,
          .discontinuity = discontinuity,
        }})
        != daw::plugin_host::WorkerSubmissionStatus::kAccepted) {
        event_scheduler.CommitBlock(false);
        return;
      }
      event_scheduler.CommitBlock(true);
      pending_sequences[slot] = sequence;
      pending_frames[slot] = render.frame_count;
      next_slot = (slot + 1) % metadata.transport.slot_count;
      return;
    }
  }
};

struct WorkerNotificationSink {
  std::mutex mutex;
  std::condition_variable ready;
  WorkerNotificationQueue notifications;
  std::atomic<std::uint32_t>* active_revision = nullptr;
};

void ForwardWorkerDiagnostic(
  const daw::plugin_host::WorkerDiagnostic& diagnostic,
  void* const context
) noexcept {
  auto* attachment = static_cast<NativeVstWorkerAttachment*>(context);
  if (attachment == nullptr) return;
  if (diagnostic.kind == daw::plugin_host::WorkerDiagnosticKind::kParameterEditBegin) {
    static_cast<void>(attachment->SetAutomationOverride(diagnostic.parameter_id));
    return;
  }
  if (attachment->notification_sink == nullptr) return;
  std::optional<WorkerNotificationKind> kind;
  if (diagnostic.kind == daw::plugin_host::WorkerDiagnosticKind::kLatency) kind = WorkerNotificationKind::kLatency;
  else if (diagnostic.kind == daw::plugin_host::WorkerDiagnosticKind::kBuses) kind = WorkerNotificationKind::kBuses;
  else if (diagnostic.kind == daw::plugin_host::WorkerDiagnosticKind::kRestart) kind = WorkerNotificationKind::kRestart;
  else if (diagnostic.kind == daw::plugin_host::WorkerDiagnosticKind::kFault) kind = WorkerNotificationKind::kFault;
  else if (diagnostic.kind == daw::plugin_host::WorkerDiagnosticKind::kMiss) kind = WorkerNotificationKind::kMiss;
  else if (diagnostic.kind == daw::plugin_host::WorkerDiagnosticKind::kTail) kind = WorkerNotificationKind::kTail;
  else if (diagnostic.kind == daw::plugin_host::WorkerDiagnosticKind::kEditorInteraction) kind = WorkerNotificationKind::kEditorInteraction;
  else if (diagnostic.kind == daw::plugin_host::WorkerDiagnosticKind::kParameterEdit) kind = WorkerNotificationKind::kParameterEdit;
  else if (diagnostic.kind == daw::plugin_host::WorkerDiagnosticKind::kEditorState) kind = WorkerNotificationKind::kEditorState;
  if (!kind) return;
  WorkerNotificationSink& sink = *attachment->notification_sink;
  if (*kind == WorkerNotificationKind::kParameterEdit) {
    static_cast<void>(attachment->SetAutomationOverride(diagnostic.parameter_id));
  }
  const std::lock_guard lock(sink.mutex);
  static_cast<void>(sink.notifications.Push(IdentifyWorkerNotification(
    attachment->metadata,
    sink.active_revision->load(std::memory_order_acquire),
    *kind,
    diagnostic.value,
    diagnostic.parameter_id,
    diagnostic.normalized_value
  )));
  sink.ready.notify_one();
}

void DispatchNativeVstGraphHook(const daw::audio_core::NativeGraphNodeRender& render) noexcept {
  auto* attachment = static_cast<NativeVstWorkerAttachment*>(render.attachment);
  if (attachment != nullptr) attachment->Process(render);
}

struct NativeMeterObserver {
  static constexpr std::uint32_t kMeterReadyBit = 1U << 2U;
  struct Event {
    std::uint32_t graph_revision = 0;
    std::uint32_t transport_epoch = 0;
    std::uint64_t node_id = 0;
    float left_rms = 0.0F;
    float right_rms = 0.0F;
  };
  daw::plugin_host::SpscQueue<Event, kMaximumMeterQueueEntries> queue;
  std::atomic<std::uint32_t>* bridge_pending = nullptr;

  void Observe(const daw::audio_core::NativeGraphNodeRender& render) noexcept {
    if (!queue.HasSpace() || render.frame_count == 0 || render.channel_count == 0 || render.planes[0] == nullptr) return;
    double left_sum = 0.0;
    double right_sum = 0.0;
    const float* const left = render.planes[0];
    const float* const right = render.channel_count > 1 && render.planes[1] != nullptr ? render.planes[1] : left;
    for (std::uint32_t frame = 0; frame < render.frame_count; ++frame) {
      const float left_sample = std::isfinite(left[frame]) ? left[frame] : 0.0F;
      const float right_sample = std::isfinite(right[frame]) ? right[frame] : 0.0F;
      left_sum += static_cast<double>(left_sample) * left_sample;
      right_sum += static_cast<double>(right_sample) * right_sample;
    }
    if (!queue.TryPush({
      .graph_revision = render.graph_revision,
      .transport_epoch = render.transport_epoch,
      .node_id = render.node_id,
      .left_rms = static_cast<float>(std::sqrt(left_sum / render.frame_count)),
      .right_rms = static_cast<float>(std::sqrt(right_sum / render.frame_count)),
    })) return;
    if (bridge_pending != nullptr) bridge_pending->fetch_or(kMeterReadyBit, std::memory_order_release);
  }

  [[nodiscard]] bool Empty() const noexcept { return queue.Empty(); }

  bool Pop(Event& event) noexcept { return queue.TryPop(event); }

  void Clear() noexcept {
    Event event{};
    while (Pop(event)) {}
  }

  static void Dispatch(const daw::audio_core::NativeGraphNodeRender& render) noexcept {
    auto* observer = static_cast<NativeMeterObserver*>(render.attachment);
    if (observer != nullptr) observer->Observe(render);
  }
};

struct NativeSpectrumObserver {
  struct Event {
    std::uint32_t graph_revision = 0;
    std::uint32_t transport_epoch = 0;
    std::uint64_t node_id = 0;
    std::uint32_t frame_count = 0;
    std::uint32_t sample_rate_hz = 0;
    std::array<float, kSpectrumFftSize> left{};
    std::array<float, kSpectrumFftSize> right{};
  };
  daw::plugin_host::SpscQueue<Event, kMaximumSpectrumQueueEntries> queue;
  std::atomic<std::uint64_t>* selected_node = nullptr;
  std::atomic<std::uint32_t>* bridge_pending = nullptr;
  void Observe(const daw::audio_core::NativeGraphNodeRender& render) noexcept {
    if (selected_node == nullptr || render.node_id != selected_node->load(std::memory_order_acquire)
      || render.frame_count == 0 || render.frame_count > kSpectrumFftSize
      || render.planes[0] == nullptr) return;
    Event event{};
    event.graph_revision = render.graph_revision;
    event.transport_epoch = render.transport_epoch;
    event.node_id = render.node_id;
    event.frame_count = render.frame_count;
    event.sample_rate_hz = render.sample_rate_hz;
    for (std::uint32_t frame = 0; frame < render.frame_count; ++frame) {
      event.left[frame] = std::isfinite(render.planes[0][frame]) ? render.planes[0][frame] : 0.0F;
      event.right[frame] = render.channel_count > 1 && render.planes[1] != nullptr && std::isfinite(render.planes[1][frame])
        ? render.planes[1][frame] : event.left[frame];
    }
    if (queue.TryPush(event) && bridge_pending != nullptr) {
      bridge_pending->fetch_or(1U << 4U, std::memory_order_release);
    }
  }
  [[nodiscard]] bool Empty() const noexcept { return queue.Empty(); }
  bool Pop(Event& event) noexcept { return queue.TryPop(event); }
  void Clear() noexcept { Event event{}; while (Pop(event)) {} }
  static void Dispatch(const daw::audio_core::NativeGraphNodeRender& render) noexcept {
    auto* observer = static_cast<NativeSpectrumObserver*>(render.attachment);
    if (observer != nullptr) observer->Observe(render);
  }
};

struct NativeTelemetryObserver {
  NativeMeterObserver* meter = nullptr;
  NativeSpectrumObserver* spectrum = nullptr;
  static void Dispatch(const daw::audio_core::NativeGraphNodeRender& render) noexcept {
    auto* observer = static_cast<NativeTelemetryObserver*>(render.attachment);
    if (observer == nullptr) return;
    if (observer->meter != nullptr) observer->meter->Observe(render);
    if (observer->spectrum != nullptr) observer->spectrum->Observe(render);
  }
};

}  // namespace

bool WorkerNotificationQueue::Push(WorkerNotification notification) {
  for (auto& current : notifications_) {
    if (IsParameterEdit(current)
      && IsParameterEdit(notification)
      && current.instance_id == notification.instance_id
      && current.parameter_id == notification.parameter_id) {
      current = std::move(notification);
      return true;
    }
  }
  if (notifications_.size() < kCapacity) {
    notifications_.push_back(std::move(notification));
    return true;
  }
  if (IsParameterEdit(notification)) {
    const auto parameter = std::find_if(
      notifications_.begin(),
      notifications_.end(),
      [](const WorkerNotification& current) { return IsParameterEdit(current); }
    );
    if (parameter != notifications_.end()) {
      notifications_.erase(parameter);
      notifications_.push_back(std::move(notification));
      return true;
    }
  }
  const auto informational = std::find_if(
    notifications_.begin(),
    notifications_.end(),
    [](const WorkerNotification& current) { return !IsCritical(current); }
  );
  if (informational == notifications_.end()) return false;
  notifications_.erase(informational);
  notifications_.push_back(std::move(notification));
  return true;
}

WorkerNotification WorkerNotificationQueue::Pop() {
  WorkerNotification notification = std::move(notifications_.front());
  notifications_.pop_front();
  return notification;
}

WorkerNotification IdentifyWorkerNotification(
  const NativeVstAttachment& attachment,
  const std::uint32_t graph_revision,
  const WorkerNotificationKind kind,
  const std::uint32_t value,
  const std::uint32_t parameter_id,
  const double normalized_value
) {
  return {
    .kind = kind,
    .graph_revision = graph_revision,
    .graph_node_id = attachment.graph_node_id,
    .instance_id = attachment.instance_id,
    .value = value,
    .parameter_id = parameter_id,
    .normalized_value = normalized_value,
  };
}

std::optional<ControlFrame> DecodeControlFrame(std::span<const std::uint8_t> bytes) {
  if (bytes.size() < kControlFrameHeaderBytes) return std::nullopt;
  if (ReadU32(bytes.data()) != kFrameMagic || ReadU32(bytes.data() + 4) != kControlProtocolVersion) return std::nullopt;
  const std::uint32_t type = ReadU32(bytes.data() + 8);
  const std::uint32_t length = ReadU32(bytes.data() + 12);
  if (length > kMaximumControlPayloadBytes || bytes.size() != kControlFrameHeaderBytes + length) return std::nullopt;
  if (type < static_cast<std::uint32_t>(ControlType::kHostHello)
    || type > static_cast<std::uint32_t>(ControlType::kProcessorStatePatchStatus)) return std::nullopt;
  return ControlFrame{
    .type = static_cast<ControlType>(type),
    .payload = {bytes.begin() + static_cast<std::ptrdiff_t>(kControlFrameHeaderBytes), bytes.end()},
  };
}

std::vector<std::uint8_t> EncodeControlFrame(ControlType type, std::span<const std::uint8_t> payload) {
  if (payload.size() > kMaximumControlPayloadBytes) return {};
  std::vector<std::uint8_t> frame(kControlFrameHeaderBytes + payload.size());
  WriteU32(frame, 0, kFrameMagic);
  WriteU32(frame, 4, kControlProtocolVersion);
  WriteU32(frame, 8, static_cast<std::uint32_t>(type));
  WriteU32(frame, 12, static_cast<std::uint32_t>(payload.size()));
  if (!payload.empty()) std::memcpy(frame.data() + kControlFrameHeaderBytes, payload.data(), payload.size());
  return frame;
}

std::vector<std::uint8_t> EncodeScheduleProgress(const ScheduleProgress& progress) {
  // Protocol 29 retains protocol 28's 96 bytes and adds the resolved patch token, its
  // result and a reserved word.
  std::vector<std::uint8_t> payload(112);
  const auto write64 = [&payload](const std::size_t offset, const std::uint64_t value) {
    WriteU32(payload, offset, static_cast<std::uint32_t>(value >> 32U));
    WriteU32(payload, offset + 4, static_cast<std::uint32_t>(value));
  };
  WriteU32(payload, 0, progress.revision);
  WriteU32(payload, 4, progress.epoch);
  write64(8, progress.progress_sequence);
  write64(16, progress.rendered_through_frame);
  write64(24, progress.accepted_through_frame);
  write64(32, progress.last_accepted_window_id);
  write64(40, progress.applied_transport_transition_id);
  write64(48, progress.applied_urgent_sequence);
  write64(56, progress.applied_processor_sequence);
  WriteU32(payload, 64, (progress.running ? 1U : 0U) | (progress.schedule_complete ? 2U : 0U));
  WriteU32(payload, 68, progress.instrument_credits);
  WriteU32(payload, 72, progress.source_credits);
  WriteU32(payload, 76, progress.automation_credits);
  write64(80, progress.admission_capacity_generation);
  write64(88, progress.latency_completion_generation);
  write64(96, progress.processor_patch_resolved_token);
  WriteU32(payload, 104, progress.processor_patch_resolved_result);
  WriteU32(payload, 108, 0);
  return payload;
}

std::string CoreAudioDeviceId(std::string_view uid) {
  return uid.empty() ? std::string{} : "coreaudio:" + std::string(uid);
}

std::optional<std::string> CoreAudioDeviceUid(std::string_view device_id) {
  constexpr std::string_view prefix = "coreaudio:";
  if (!device_id.starts_with(prefix) || device_id.size() == prefix.size()) return std::nullopt;
  return std::string(device_id.substr(prefix.size()));
}

// Destroys retired attachments off the command thread: a worker's Stop() waits up to about
// 500 ms for its child to exit. Event driven; the thread sleeps on the queue.
class RetiredAttachmentReaper {
 public:
  RetiredAttachmentReaper() : thread_([this] { Run(); }) {}
  ~RetiredAttachmentReaper() {
    {
      const std::lock_guard lock(mutex_);
      stopping_ = true;
    }
    wake_.notify_one();
    thread_.join();
  }
  RetiredAttachmentReaper(const RetiredAttachmentReaper&) = delete;
  RetiredAttachmentReaper& operator=(const RetiredAttachmentReaper&) = delete;
  void Reap(std::unique_ptr<NativeVstWorkerAttachment> attachment) {
    {
      const std::lock_guard lock(mutex_);
      queue_.push_back(std::move(attachment));
    }
    wake_.notify_one();
  }

 private:
  void Run() {
    std::unique_lock lock(mutex_);
    for (;;) {
      wake_.wait(lock, [this] { return stopping_ || !queue_.empty(); });
      if (queue_.empty()) return;
      auto attachment = std::move(queue_.front());
      queue_.pop_front();
      lock.unlock();
      attachment.reset();  // stops its worker
      lock.lock();
    }
  }
  std::mutex mutex_;
  std::condition_variable wake_;
  std::deque<std::unique_ptr<NativeVstWorkerAttachment>> queue_;
  bool stopping_ = false;
  std::thread thread_;
};

struct AudioHost::Impl {
  std::unique_ptr<AcceptanceOutputTap> acceptance_tap = daw::acceptance::Enabled()
    ? std::make_unique<AcceptanceOutputTap>() : nullptr;
  std::atomic<std::int64_t> acceptance_publication_frame = 0;
  std::atomic<std::uint64_t> acceptance_publication_epoch = 0;
  // The core's pinned budget and the published graph's own latency, recorded where the publication happens so a
  // later move cannot change what its event reports. A lower while playing leaves the budget where it was.
  std::atomic<std::uint32_t> acceptance_pinned_latency = 0;
  std::atomic<std::uint32_t> acceptance_graph_latency = 0;
  void RecordPublicationLatency() {
    const auto core = active_core.load(std::memory_order_acquire);
    acceptance_pinned_latency.store(daw::audio_core::InspectLatencyTransition(core).budget, std::memory_order_relaxed);
    acceptance_graph_latency.store(daw::audio_core::PublishedGraphLatency(core), std::memory_order_relaxed);
  }
  std::uint64_t acceptance_observed_processor_sequence = 0;
  std::uint32_t acceptance_observed_epoch = UINT32_MAX;
  bool acceptance_observed_running = false;
  // Evidence-only ordinal. WorkerControlService::workerGeneration is a private
  // transport authentication value and must never be written to artifacts.
  std::uint64_t acceptance_worker_ordinal = 0;

  void Evidence(const char* event, const char* cause = "", const std::uint32_t requested = 0,
    const char* detail = "") const {
    if (!daw::acceptance::Enabled()) return;
    char fields[768];
    std::snprintf(fields, sizeof(fields),
      ",\"cause\":\"%s\",\"revision\":%u,\"transportEpoch\":%u,\"frame\":%lld,"
      "\"renderEpoch\":\"%llu\",\"publicationFrame\":%lld,\"publicationEpoch\":\"%llu\","
      "\"requestedRevision\":%u,\"retirementEpoch\":\"%llu\"%s",
      cause, active_revision.load(), applied_transport_epoch.load(),
      static_cast<long long>(applied_transport_frame.load()),
      static_cast<unsigned long long>(completed_render_epoch.load()),
      static_cast<long long>(acceptance_publication_frame.load()),
      static_cast<unsigned long long>(acceptance_publication_epoch.load()), requested,
      static_cast<unsigned long long>(retired_after_epoch.load()), detail);
    daw::acceptance::Event(event, fields);
  }
  void PublicationEvidence(const char* cause) const {
    if (!daw::acceptance::Enabled()) return;
    char detail[96];
    std::snprintf(detail, sizeof(detail), ",\"pinnedLatencyFrames\":%u,\"graphLatencyFrames\":%u",
      acceptance_pinned_latency.load(), acceptance_graph_latency.load());
    Evidence("graph-publish", cause, 0, detail);
  }
  enum class RecordingCommand : std::uint32_t { kNone, kStop, kCancel };
  enum class QueuedControlKind : std::uint8_t { kUrgent, kProcessor, kInstrument, kSource };
  struct QueuedControlEvent {
    QueuedControlKind kind = QueuedControlKind::kProcessor;
    std::uint64_t window_id = 0;
    std::uint64_t absolute_frame = 0;
    bool scheduled = false;
    bool cancelled = false;
    std::uint32_t processor_revision = 0;
    std::uint32_t processor_epoch = 0;
    std::uint64_t processor_sequence = 0;
    // A scheduled processor record is a linear segment when it ends after it starts; `processor.value` is its start value.
    std::uint64_t processor_end_frame = 0;
    float processor_end_value = 0.0F;
    daw_audio_processor_event processor{};
    daw_audio_instrument_event instrument{};
    daw_audio_sample_source_event source{};
  };
  struct ScheduleStaging {
    bool active = false;
    std::uint32_t revision = 0;
    std::uint32_t epoch = 0;
    std::uint64_t window_id = 0;
    std::uint64_t start_frame = 0;
    std::uint64_t end_frame = 0;
    std::uint32_t chunk_count = 0;
    std::array<bool, kMaximumScheduleChunks> received_chunks{};
    std::array<std::uint64_t, kMaximumScheduleChunks> chunk_digests{};
    bool ends_schedule = false;
    std::size_t record_count = 0;
    std::array<QueuedControlEvent, kMaximumScheduleRecords> events{};
    NativeScheduleAutomationState automation_state{};
    std::array<std::size_t, NativeScheduleAutomationState::kMaximumAttachments>
      rollback_automation_group_counts{};

    void clear() noexcept {
      for (std::size_t index = 0; index < record_count; ++index) {
        events[index] = {};
      }
      for (std::size_t index = 0; index < automation_state.group_count; ++index) {
        auto& group = automation_state.groups[index];
        for (std::size_t segment = 0; segment < group.count; ++segment) {
          group.segments[segment] = {};
        }
        group.attachment = nullptr;
        group.count = 0;
      }
      active = false;
      revision = 0;
      epoch = 0;
      window_id = 0;
      start_frame = 0;
      end_frame = 0;
      chunk_count = 0;
      received_chunks.fill(false);
      chunk_digests.fill(0);
      ends_schedule = false;
      record_count = 0;
      automation_state.clear();
      rollback_automation_group_counts.fill(0);
    }
  };
  static constexpr std::uint32_t kUrgentQueueCapacity = 256;
  static constexpr std::uint32_t kInstrumentQueueCapacity = 2'048;
  static constexpr std::uint32_t kSourceQueueCapacity = 1'024;
  static constexpr std::uint32_t kProcessorQueueCapacity = 2'048;
  static constexpr std::uint32_t kTransportQueueCapacity = 32;
  template <std::size_t Capacity>
  struct ControlLane {
    std::array<QueuedControlEvent, Capacity> events{};
    std::atomic<std::uint32_t> read = 0;
    std::atomic<std::uint32_t> write = 0;
  };
  struct TransportCommand {
    std::uint32_t epoch = 0;
    bool running = false;
    std::int64_t frame = 0;
    double bpm = 0.0;
    std::uint32_t time_signature_numerator = 0;
    std::uint32_t time_signature_denominator = 0;
    bool cycle_active = false;
    std::int64_t cycle_start_frame = 0;
    std::int64_t cycle_end_frame = 0;
    std::uint64_t transition_id = 0;
  };
  struct TransportLane {
    std::array<TransportCommand, kTransportQueueCapacity> commands{};
    std::atomic<std::uint32_t> read = 0;
    std::atomic<std::uint32_t> write = 0;
  };
  std::optional<TransportCommand> prepared_transport_context;
  // DAW_REALTIME_CALLBACK_HELPER_BEGIN prepared-transport-context
  void ApplyPreparedTransportContext() {
    if (!prepared_transport_context) return;
    const auto& context = *prepared_transport_context;
    const daw_audio_transport_state state{
      .epoch = applied_transport_epoch.load(std::memory_order_relaxed),
      .running = applied_transport_running.load(std::memory_order_relaxed) ? 1U : 0U,
      .frame = applied_transport_frame.load(std::memory_order_relaxed),
      .tempo_bpm = context.bpm,
      .time_signature_numerator = context.time_signature_numerator,
      .time_signature_denominator = context.time_signature_denominator,
      .cycle_active = context.cycle_active ? 1U : 0U,
      .cycle_start_frame = context.cycle_start_frame,
      .cycle_end_frame = context.cycle_end_frame,
    };
    static_cast<void>(daw_audio_core_set_transport(active_core.load(std::memory_order_relaxed), &state));
#if defined(DAW_AUDIO_HOST_TEST_MEMORY_LOCK)
    daw_audio_host_test_transport_context(state.frame, state.tempo_bpm,
      state.time_signature_numerator, state.time_signature_denominator);
#endif
    prepared_transport_context.reset();
  }
  // DAW_REALTIME_CALLBACK_HELPER_END prepared-transport-context
  struct RealtimeProcessScratch {
    std::array<const float*, 64> input_slice{};
    std::array<float*, 64> output_slice{};
    std::array<daw_audio_processor_event, DAW_AUDIO_CORE_MAX_PROCESSOR_EVENTS> processor_events{};
    std::array<daw_audio_instrument_event, DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS> instrument_events{};
    std::array<daw_audio_instrument_event, DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS> render_instrument_events{};
    std::array<std::uint8_t, DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS> rejected_instrument_events{};
    std::array<std::uint16_t, DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS> instrument_order{};
  };
  // A scheduled linear segment the callback holds until it ends, expanding it into core events per block.
  struct ProcessorRamp {
    daw_audio_processor_event processor{};
    std::uint64_t start_frame = 0;
    std::uint64_t end_frame = 0;
    float end_value = 0.0F;
    std::uint32_t revision = 0;
    std::uint32_t epoch = 0;
    bool cancelled = false;
  };
  std::array<ProcessorRamp, DAW_AUDIO_CORE_MAX_PROCESSOR_EVENTS> processor_ramps{};
  std::uint32_t processor_ramp_count = 0;
  struct InstalledAsset {
    struct MappedStorage {
      int file_descriptor = -1;
      void* address = MAP_FAILED;
      std::size_t byte_length = 0;
      std::size_t locked_bytes = 0;
      bool instrument_published = false;
      std::vector<std::pair<std::uint64_t, std::uint64_t>> written_ranges;

      void Unlock() {
        if (locked_bytes == 0) return;
        munlock(address, locked_bytes);
        locked_bytes = 0;
      }
      ~MappedStorage() {
        Unlock();
        if (address != MAP_FAILED) munmap(address, byte_length);
        if (file_descriptor >= 0) close(file_descriptor);
      }

      MappedStorage() = default;
      MappedStorage(const MappedStorage&) = delete;
      MappedStorage& operator=(const MappedStorage&) = delete;
    };
    daw_audio_asset_handle handle = 0;
    std::vector<float> samples;
    std::unique_ptr<MappedStorage> mapped;
    std::array<const float*, 64> planes{};
    std::uint64_t frame_count = 0;
    std::uint32_t sample_rate_hz = 0;
    std::uint32_t channel_count = 0;
    std::uint64_t content_hash_prefix = 0;
    std::uint32_t staged_revision = 0;
    bool release_requested = false;
    std::optional<std::uint64_t> release_after_epoch;
  };
  std::atomic<daw_audio_core_handle> active_core = 0;
  daw_audio_core_handle prepared_core = 0;
  bool prepared_core_is_same_core = false;
  GraphRevisionContinuity prepared_continuity = GraphRevisionContinuity::kNotEvaluated;
  const std::uint64_t instrument_resident_budget = InstrumentResidentBudget();
  std::string_view instrument_preparation_error;
  std::string_view schedule_window_error;
  daw_audio_core_handle retired_core = 0;
  // The previous revision was published over on the active core. Its slots are
  // retired inside the core and only reusable once a block has completed.
  bool retired_same_core = false;
  [[nodiscard]] bool HasRetiredPlan() const { return retired_core != 0 || retired_same_core; }
  void RetireSameCorePlan(const std::uint32_t previous_revision) {
    retired_same_core = previous_revision != 0;
    retired_revision.store(previous_revision, std::memory_order_release);
    retired_after_epoch.store(completed_render_epoch.load(std::memory_order_acquire)
      + (state.load(std::memory_order_acquire) == LifecycleState::kRunning ? 1 : 0), std::memory_order_release);
  }
  HostConfig config{};
  std::atomic<LifecycleState> state = LifecycleState::kIdle;
  std::atomic<std::uint64_t> callback_attempts = 0;
  std::atomic<std::uint64_t> callbacks = 0;
  std::atomic<std::uint32_t> callback_frames = 0;
  std::atomic<std::uint64_t> callback_timing_count = 0;
  std::atomic<std::uint64_t> callback_timing_maximum_nanoseconds = 0;
  std::atomic<std::uint64_t> callback_deadline_misses = 0;
  std::array<std::atomic<std::uint64_t>, detail::kRealtimeDurationHistogramBuckets>
    callback_timing_buckets{};
  std::atomic<std::uint64_t> vst_worker_faults = 0;
  std::atomic<std::uint64_t> vst_worker_restarts = 0;
  std::atomic<std::uint64_t> split_blocks = 0;
  std::atomic<std::uint64_t> rejected_blocks = 0;
  std::atomic<RejectedBlockReason> last_rejected_reason = RejectedBlockReason::kNone;
  std::atomic<std::uint64_t> last_rejected_callback = 0;
  std::atomic<std::uint64_t> last_rejected_render_epoch = 0;
  std::atomic<std::uint32_t> last_rejected_transport_epoch = 0;
  std::atomic<std::uint32_t> last_rejected_core_result = DAW_AUDIO_CORE_OK;
  std::atomic<std::uint32_t> last_rejected_frame_count = 0;
  std::atomic<std::uint32_t> last_rejected_channel_count = 0;
  std::atomic<std::uint32_t> last_rejected_processor_event_count = 0;
  std::atomic<std::uint32_t> last_rejected_instrument_event_count = 0;
  std::atomic<std::uint32_t> last_rejected_graph_revision = 0;
  std::atomic<std::uint32_t> active_revision = 0;
  std::atomic<std::uint32_t> prepared_revision = 0;
  std::atomic<std::uint32_t> retired_revision = 0;
  std::atomic<std::uint64_t> completed_render_epoch = 0;
  NativeMeterObserver meter_observer{};
  std::uint64_t meter_sequence = 0;
  NativeSpectrumObserver spectrum_observer{};
  NativeTelemetryObserver telemetry_observer{};
  std::atomic<std::uint64_t> spectrum_selected_node{0};
  std::uint64_t spectrum_sequence = 0;
  std::array<float, kMaximumSpectrumBins> spectrum_smoothed{};
  bool spectrum_has_previous = false;
  std::array<float, kSpectrumFftSize> spectrum_history_left{};
  std::array<float, kSpectrumFftSize> spectrum_history_right{};
  std::uint32_t spectrum_history_count = 0;
  struct ObservationLookup {
    std::array<std::uint64_t, 64> node_ids{};
    std::uint32_t node_count = 0;
    bool Contains(const std::uint64_t id) const noexcept {
      return id != 0 && std::find(node_ids.begin(), node_ids.begin() + node_count, id)
        != node_ids.begin() + node_count;
    }
  };
  std::array<ObservationLookup, 2> observation_lookups{};
  std::atomic<std::uint32_t> active_observation_lookup{0};

  // DAW_REALTIME_CALLBACK_HELPER_BEGIN observation-identity-handoff
  void PromoteObservationLookup() noexcept {
    const auto next = 1U - active_observation_lookup.load(std::memory_order_relaxed);
    auto selected = spectrum_selected_node.load(std::memory_order_acquire);
    // Fixed-capacity identity lookup, no queue drain or history reset at the seam.
    // Deletion tails must not continue a removed target's observation.
    if (!observation_lookups[next].Contains(selected))
      spectrum_selected_node.compare_exchange_strong(selected, 0, std::memory_order_acq_rel);
    active_observation_lookup.store(next, std::memory_order_release);
  }
  // DAW_REALTIME_CALLBACK_HELPER_END observation-identity-handoff
  std::atomic<std::uint64_t> retired_after_epoch = 0;
  std::atomic<std::uint32_t> publish_requested_revision = 0;
  std::atomic<std::uint32_t> publish_acknowledged_revision = 0;
  // Control-thread ownership survives a callback claim and a timed-out reply.
  std::uint32_t publication_in_flight = 0;
  std::mutex publish_wait_mutex;
  std::condition_variable publish_wait;
  std::atomic<std::uint32_t> publish_deferred_revision = 0;
  static constexpr std::uint32_t kRealtimeLatencyCompleted = 1U << 9U;
  std::atomic<std::uint64_t> processor_patch_requested = 0;
  std::atomic<std::uint64_t> processor_patch_acknowledged = 0;
  std::atomic<std::uint32_t> processor_patch_result = DAW_AUDIO_CORE_NO_DATA;
#if defined(DAW_AUDIO_HOST_TEST_PATCH_CLAIM)
  std::uint64_t processor_patch_sequence = kTestPatchClaimTokenBase;
  // Callback-owned: a taken request waits here until the hold's frames have elapsed.
  std::atomic<std::uint64_t> test_patch_claim_held_token = 0;
  std::atomic<std::int64_t> test_patch_claim_hold_frames = 0;
#else
  std::uint64_t processor_patch_sequence = 0;
#endif
  ClaimedRequest<std::uint64_t> claimed_processor_patch;
  // processor_patch_acknowledged and processor_patch_result are the resolved record. The callback is
  // their only writer; the drainer reads the result only for the recorded claim and only until that
  // claim is reported. See ApplyRequestedProcessorPatch.
  std::atomic<std::uint64_t> processor_patch_reported_token = 0;  // drainer; ends the claim
  struct ReportedPatch {
    std::uint64_t token = 0;
    std::uint32_t result = 0;
  };
  ReportedPatch last_reported_patch;  // drainer only
  static_assert(std::atomic<std::uint64_t>::is_always_lock_free && std::atomic<std::uint32_t>::is_always_lock_free);

  // DAW_REALTIME_CALLBACK_HELPER_BEGIN processor-patch-apply
  void ApplyRequestedProcessorPatch() noexcept {
    std::uint64_t token = processor_patch_requested.exchange(0, std::memory_order_acq_rel);
#if defined(DAW_AUDIO_HOST_TEST_PATCH_CLAIM)
    if (token != 0 && test_patch_claim_hold.load(std::memory_order_relaxed)) {
#if DAW_AUDIO_HOST_TEST_PATCH_CLAIM == 2
      test_patch_claim_hold_frames.store(static_cast<std::int64_t>(config.sample_rate_hz) + 1, std::memory_order_relaxed);
#else
      test_patch_claim_hold_frames.store(1, std::memory_order_relaxed);
#endif
      test_patch_claim_held_token.store(token, std::memory_order_relaxed);
      return;
    }
    if (token == 0) {
      token = test_patch_claim_held_token.load(std::memory_order_relaxed);
      if (token == 0 || test_patch_claim_hold_frames.load(std::memory_order_relaxed) > 0) return;
      test_patch_claim_held_token.store(0, std::memory_order_relaxed);
    }
#else
    if (token == 0) return;
#endif
    const daw_audio_core_handle core = active_core.load(std::memory_order_acquire);
#if defined(DAW_AUDIO_HOST_TEST_PATCH_CLAIM) && DAW_AUDIO_HOST_TEST_PATCH_CLAIM == 1
    if (core != 0 && test_patch_claim_discard.load(std::memory_order_relaxed)) {
      static_cast<void>(daw_audio_core_cancel_staged_processor_state_patch(core));
    }
#endif
    const auto result = core == 0 ? DAW_AUDIO_CORE_INVALID_HANDLE : daw_audio_core_apply_staged_processor_state_patch(core);
    processor_patch_result.store(result, std::memory_order_release);
    processor_patch_acknowledged.store(token, std::memory_order_release);
#if defined(DAW_AUDIO_HOST_TEST_PATCH_CLAIM) && DAW_AUDIO_HOST_TEST_PATCH_CLAIM == 1
    // Observes the pair at the instant the ack becomes visible: the result must already be this claim's.
    if (const auto hook = test_patch_ack_hook.load(std::memory_order_acquire)) {
      hook(processor_patch_acknowledged.load(std::memory_order_acquire), processor_patch_result.load(std::memory_order_acquire));
    }
#endif
    SignalRealtimeBridge(kRealtimeProcessorPatchAcknowledged);
  }
  // DAW_REALTIME_CALLBACK_HELPER_END processor-patch-apply
  std::atomic<std::uint32_t> transport_epoch = 0;
  std::atomic<std::int64_t> transport_frame = 0;
  std::atomic<bool> transport_running = false;
  std::atomic<std::uint32_t> applied_transport_epoch = 0;
  std::atomic<std::int64_t> applied_transport_frame = 0;
  std::atomic<bool> applied_transport_running = false;
  std::atomic<std::uint64_t> applied_transport_transition_id = 0;
  std::atomic<std::uint64_t> last_queued_transport_transition_id = 0;
  std::atomic<std::uint32_t> last_queued_transport_epoch = 0;
  TransportLane transport_queue{};
  std::atomic<std::uint64_t> applied_urgent_sequence = 0;
  std::atomic<std::uint64_t> applied_processor_sequence = 0;
  std::atomic<std::uint64_t> last_queued_processor_sequence = 0;
  std::atomic<std::uint32_t> last_graph_revision = 0;
  ControlLane<kUrgentQueueCapacity> urgent_queue{};
  ControlLane<kInstrumentQueueCapacity> instrument_queue{};
  ControlLane<kProcessorQueueCapacity> processor_queue{};
  // The control thread resets the inactive bank only after callback acknowledgement.
  // Both banks reuse the existing bounded lanes and window decoder.
  struct ScheduleBank {
  std::atomic<std::uint64_t> published_schedule_window_id = 0;
  std::atomic<std::uint32_t> accepted_schedule_epoch = 0;
  std::atomic<std::uint64_t> accepted_schedule_through_frame = 0;
  std::atomic<bool> schedule_complete = false;
  std::uint64_t last_accepted_schedule_window_id = 0;
  std::uint32_t last_accepted_schedule_epoch = 0;
  std::uint64_t last_schedule_start_frame = 0;
  ScheduleStaging schedule_staging{};
  std::array<std::uint64_t, 3> schedule_digest_windows{};
  std::array<std::array<std::uint64_t, kMaximumScheduleChunks>, 3> schedule_chunk_digests{};
  std::size_t schedule_digest_cursor = 0;
    ControlLane<kInstrumentQueueCapacity> instrument_queue{};
    ControlLane<kSourceQueueCapacity> source_queue{};
    ControlLane<kProcessorQueueCapacity> scheduled_processor_queue{};
    std::uint32_t revision = 0;
    std::uint32_t epoch = 0;
    std::uint64_t publication_frame = 0;
    // A refused seam gives scheduled notes priority until the bank retires.
    // Live refills cannot starve the finite accepted pre-seam backlog.
    bool instrument_drain_priority = false;
    void Reset(std::uint32_t next_revision, std::uint32_t next_epoch, std::uint64_t frame) {
      revision = next_revision;
      epoch = next_epoch;
      publication_frame = frame;
      instrument_drain_priority = false;
      instrument_queue.read.store(0);
      instrument_queue.write.store(0);
      source_queue.read.store(0);
      source_queue.write.store(0);
      scheduled_processor_queue.read.store(0);
      scheduled_processor_queue.write.store(0);
      published_schedule_window_id.store(0);
      accepted_schedule_epoch.store(next_epoch);
      accepted_schedule_through_frame.store(frame);
      schedule_complete.store(false);
      last_accepted_schedule_window_id = 0;
      last_accepted_schedule_epoch = next_epoch;
      last_schedule_start_frame = frame;
      schedule_staging.clear();
      schedule_digest_windows = {};
      schedule_chunk_digests = {};
      schedule_digest_cursor = 0;
    }
  };
  std::array<ScheduleBank, 2> schedule_banks{};
  std::atomic<std::uint32_t> active_schedule_bank = 0;
  std::atomic<std::uint64_t> requested_publication_frame = 0;
  std::uint32_t prepared_transport_epoch = 0;
  bool prepared_instruments_ready = true;
  std::unordered_map<std::uint64_t, daw_audio_instrument_state_descriptor> prepared_instrument_targets;
  bool ValidPreparedInstrumentEvent(const daw_audio_instrument_event& event) const {
    const auto found = prepared_instrument_targets.find(event.node_id);
    if (found == prepared_instrument_targets.end()) return false;
    if (event.type != DAW_AUDIO_INSTRUMENT_EVENT_PARAMETER) return true;
    const auto& descriptor = found->second;
    if (descriptor.kind != DAW_AUDIO_INSTRUMENT_KIND_SYNTH
      || std::find(descriptor.parameter_targets, descriptor.parameter_targets + descriptor.parameter_count, event.note)
        == descriptor.parameter_targets + descriptor.parameter_count) return false;
    // Feed the authoritative core state validator scalar candidate data only.
    // Never read mutable live instrument runtime on the control thread.
    daw_audio_synth_state candidate{.version = 1, .seed = 1, .filter_cutoff_hz = 20.F,
      .filter_resonance = 1.F, .lfo_rate_hz = 1.F};
    switch (event.note) {
      case DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_GAIN: candidate.output_gain = event.value; break;
      case DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_PAN: candidate.output_pan = event.value; break;
      case DAW_AUDIO_SYNTH_PARAMETER_FILTER_CUTOFF_HZ: candidate.filter_cutoff_hz = event.value; break;
      case DAW_AUDIO_SYNTH_PARAMETER_FILTER_RESONANCE: candidate.filter_resonance = event.value; break;
      case DAW_AUDIO_SYNTH_PARAMETER_AMP_ATTACK_MS: candidate.amp_attack_ms = event.value; break;
      case DAW_AUDIO_SYNTH_PARAMETER_AMP_DECAY_MS: candidate.amp_decay_ms = event.value; break;
      case DAW_AUDIO_SYNTH_PARAMETER_AMP_SUSTAIN: candidate.amp_sustain = event.value; break;
      case DAW_AUDIO_SYNTH_PARAMETER_AMP_RELEASE_MS: candidate.amp_release_ms = event.value; break;
      default: return false;
    }
    return daw::audio_core::ValidateInstrumentState(active_core.load(std::memory_order_acquire), event.node_id, candidate);
  }
  std::atomic<bool> publication_rebase_required = false;
  // 0 idle, 1 control producer, 2 callback publication until acknowledgement.
  // A callback never waits for the producer; a missed seam requires rebase.
  std::atomic<std::uint32_t> schedule_owner = 0;
  struct ControlSubmissionClaim {
    std::atomic<std::uint32_t>& owner;
    bool acquired;
    explicit ControlSubmissionClaim(std::atomic<std::uint32_t>& value) : owner(value), acquired(false) {
      std::uint32_t unowned = 0;
      acquired = owner.compare_exchange_strong(unowned, 1, std::memory_order_acq_rel);
    }
    ~ControlSubmissionClaim() { if (acquired) owner.store(0, std::memory_order_release); }
  };
  // DAW_REALTIME_CALLBACK_HELPER_BEGIN active-schedule-bank
  ScheduleBank& ActiveSchedule() noexcept {
    return schedule_banks[active_schedule_bank.load(std::memory_order_acquire)];
  }
  const ScheduleBank& ActiveSchedule() const noexcept {
    return schedule_banks[active_schedule_bank.load(std::memory_order_acquire)];
  }
  // DAW_REALTIME_CALLBACK_HELPER_END active-schedule-bank
  ScheduleBank& PreparedSchedule() noexcept {
    return schedule_banks[1U - active_schedule_bank.load(std::memory_order_acquire)];
  }
  void ResetPreparedSchedule(std::uint32_t revision, std::uint32_t epoch, std::uint64_t frame) {
    PreparedSchedule().Reset(revision, epoch, frame);
    const auto bank = 1U - active_schedule_bank.load(std::memory_order_acquire);
    for (const auto& [id, attachment] : native_vst_attachments) {
      attachment->automation_banks[bank].count.store(0, std::memory_order_release);
      attachment->automation_banks[bank].buffer_counts = {};
      attachment->automation_banks[bank].epoch.store(epoch, std::memory_order_release);
    }
  }
  RealtimeProcessScratch realtime_process_scratch{};
  bool graph_prepared = false;
  bool transport_prepared = false;
  void* device_session = nullptr;
  void* recording_device_session = nullptr;
  RecordingSpoolService* recording_spool = nullptr;
  RecordingInputDevice default_recording_device;
  RecordingInputDevice* recording_device = nullptr;
  std::shared_ptr<RecordingSpoolSession> recording_session;
  RecordingConfig recording_config;
  std::shared_ptr<RecordingStatusChannel> recording_status_channel;
  mutable std::mutex recording_owner_mutex;
  std::thread recording_advance_thread;
  std::atomic<bool> recording_advance_running{false};
  bool recording_finish_accepted = false;
  bool recording_capture_retired = false;
  bool recording_input_failed = false;
  std::uint32_t recording_rate = 0;
  std::unordered_map<std::uint32_t, InstalledAsset> assets;
  std::string_view asset_operation_error;
  std::atomic<bool> asset_retirement_pending{false};
  // Host-lifetime admission signal, independent of ordinary render progress.
  std::atomic<std::uint64_t> admission_capacity_generation{0};
  // Completed latency transitions; kept apart from reclaims so the controller
  // never infers which admission opportunities were capacity.
  std::atomic<std::uint64_t> latency_completion_generation{0};
  std::array<int, 2> control_wake{-1, -1};
  static constexpr std::uint32_t kRealtimeAssetReaders = 1U << 10U;
  void WakeAssetControl() {
    if (control_wake[1] < 0) return;
    const std::uint8_t wake = 1;
    static_cast<void>(write(control_wake[1], &wake, sizeof(wake)));
  }
  using InstrumentAssets = std::unordered_map<std::uint64_t, std::unordered_set<InstalledAsset*>>;
  InstrumentAssets published_instrument_assets;
  InstrumentAssets prepared_instrument_assets;
  // Control thread only. What a bound capture checks the next revision against.
  std::optional<PlanRouting> published_routing;
  std::optional<PlanRouting> prepared_routing;
  std::unordered_map<std::uint32_t, daw_audio_asset_handle> prepared_asset_handles;
  bool AssetVisible(const InstalledAsset& asset, const std::uint32_t revision) const {
    return asset.staged_revision == 0 || asset.staged_revision == revision;
  }
  void RetainAsset(InstalledAsset& asset) {
    if (!asset.release_after_epoch) return;
    daw::audio_core::CancelAssetRetirement(active_core.load(std::memory_order_acquire), asset.handle);
    asset.release_after_epoch.reset();
  }
  void ReuseAsset(InstalledAsset& asset) {
    RetainAsset(asset);
    asset.release_requested = false;
    if (asset.staged_revision != 0)
      asset.staged_revision = prepared_revision.load(std::memory_order_acquire);
  }
  void PromoteAssets(const std::uint32_t revision) {
    for (auto& [id, asset] : assets) {
      static_cast<void>(id);
      if (asset.staged_revision == revision) asset.staged_revision = 0;
    }
  }
  void ReclaimAssets() {
    if (!asset_retirement_pending.load(std::memory_order_acquire)) return;
    const auto core = active_core.load(std::memory_order_acquire);
    if (core == 0 || publication_in_flight != 0 || prepared_core != 0 || HasRetiredPlan()) return;
    ControlSubmissionClaim claim{schedule_owner};
    if (!claim.acquired) return;
    std::unordered_set<daw_audio_asset_handle> queued;
    std::unordered_set<const InstalledAsset*> configured;
    for (const auto& [node, owners] : published_instrument_assets) {
      static_cast<void>(node);
      configured.insert(owners.begin(), owners.end());
    }
    const auto& bank = ActiveSchedule();
    const auto read = bank.source_queue.read.load(std::memory_order_acquire);
    const auto write = bank.source_queue.write.load(std::memory_order_acquire);
    for (auto index = read; index != write; ++index)
      queued.insert(bank.source_queue.events[index % kSourceQueueCapacity].source.asset);
    for (std::size_t index = 0; index < bank.schedule_staging.record_count; ++index) {
      const auto& event = bank.schedule_staging.events[index];
      if (event.kind == QueuedControlKind::kSource) queued.insert(event.source.asset);
    }
    const auto completed = completed_render_epoch.load(std::memory_order_acquire);
    const auto lifecycle = state.load(std::memory_order_acquire);
    const bool stopped = lifecycle == LifecycleState::kConfigured || lifecycle == LifecycleState::kIdle;
    for (auto iterator = assets.begin(); iterator != assets.end();) {
      auto& asset = iterator->second;
      if (!asset.release_requested || configured.contains(&asset) || queued.contains(asset.handle)) { ++iterator; continue; }
      if (!asset.release_after_epoch) {
        asset.release_after_epoch = completed;
        daw::audio_core::RequestAssetRetirement(core, asset.handle);
      }
      if ((stopped || completed > *asset.release_after_epoch)
        && daw::audio_core::ReclaimAsset(core, asset.handle, stopped, completed)) {
        iterator = assets.erase(iterator); // Only the control thread destroys PCM/mappings.
        admission_capacity_generation.fetch_add(1, std::memory_order_release);
        PublishScheduleProgressChange();
      } else ++iterator;
    }
    asset_retirement_pending.store(std::any_of(assets.begin(), assets.end(),
      [](const auto& entry) { return entry.second.release_requested; }), std::memory_order_release);
  }
  std::unordered_map<std::string, std::unique_ptr<NativeVstWorkerAttachment>> native_vst_attachments;
  // Set while the workers run, so an instance added to a live graph starts at once.
  std::optional<daw::plugin_host::WorkerProcessSetup::Mode> native_worker_mode;
  static constexpr std::size_t kMaximumParkedNativeVsts = 4;
  std::chrono::steady_clock::duration parked_age = std::chrono::seconds(60);
  std::uint64_t superseded_vst_ordinal = 0;
  WorkerNotificationSink worker_notifications{};
  // Declared after the sink its attachments report to, so it is destroyed first.
  std::optional<RetiredAttachmentReaper> retired_attachment_reaper;
  std::atomic<daw_audio_core_handle> recording_capture = 0;
  std::atomic<bool> recording_started = false;
  std::atomic<bool> recording_monitoring = false;
  std::atomic<std::uint32_t> recording_channel_count = 0;
  std::atomic<RecordingCommand> recording_command = RecordingCommand::kNone;
  std::atomic<std::int64_t> recording_stop_frame = -1;
  std::atomic<std::int64_t> recording_input_frame = 0;
  std::atomic<std::int64_t> recording_timeline_start_frame = 0;
  std::atomic<std::int64_t> recording_punch_start_frame = 0;
  std::atomic<std::uint64_t> recording_status_revision = 0;
  std::atomic<bool> recording_device_lost = false;
  std::atomic<bool> offline_failure = false;
  bool strict_offline_export = false;
  std::array<std::array<float, DAW_AUDIO_RECORDING_CAPTURE_BLOCK_FRAMES>,
    DAW_AUDIO_RECORDING_CAPTURE_MAX_CHANNELS> recording_monitor{};
  std::array<float*, DAW_AUDIO_RECORDING_CAPTURE_MAX_CHANNELS> recording_monitor_planes{};
  static constexpr std::uint32_t kRecordingMonitorCapacity = 16384;
  std::array<std::array<float, kRecordingMonitorCapacity>,
    DAW_AUDIO_RECORDING_CAPTURE_MAX_CHANNELS> recording_monitor_ring{};
  std::atomic<std::uint64_t> recording_monitor_read = 0;
  std::atomic<std::uint64_t> recording_monitor_write = 0;
  mutable std::mutex recording_wait_mutex;
  std::condition_variable recording_wait;
  static constexpr std::uint32_t kRealtimePublishAcknowledged = 1U << 0U;
  static constexpr std::uint32_t kRealtimeProcessorPatchAcknowledged = 1U << 2U;
  static constexpr std::uint32_t kRealtimeRecordingStatus = 1U << 1U;
  std::atomic<std::uint32_t> realtime_bridge_pending = 0;
  std::atomic<bool> realtime_bridge_running = false;
  std::mutex realtime_bridge_wait_mutex;
  std::condition_variable realtime_bridge_wait;
  std::thread realtime_bridge_thread;
  static constexpr std::uint32_t kRealtimeScheduleProgress = 1U << 3U;
  static constexpr std::uint32_t kRealtimeInstrumentRejected = 1U << 8U;
  std::atomic<std::uint64_t> rejected_instrument_count = 0;
  std::atomic<std::uint64_t> rejected_instrument_sequence = 0;
  std::atomic<std::uint64_t> rejected_instrument_node = 0;
  std::atomic<std::uint64_t> schedule_progress_sequence = 0;
  std::atomic<std::uint32_t> schedule_progress_revision = 0;
  std::atomic<std::uint32_t> schedule_progress_epoch = 0;
  std::atomic<std::uint64_t> schedule_progress_rendered_frame = 0;
  std::atomic<std::uint64_t> schedule_progress_accepted_frame = 0;
  std::atomic<std::uint64_t> schedule_progress_window_id = 0;
  std::atomic<std::uint64_t> schedule_progress_applied_transition = 0;
  std::atomic<std::uint64_t> schedule_progress_urgent = 0;
  std::atomic<std::uint64_t> schedule_progress_processor = 0;
  std::atomic<bool> schedule_progress_running = false;
  std::atomic<bool> schedule_progress_complete = false;
  std::atomic<bool> schedule_progress_ready = false;
  bool schedule_progress_has_notification = false;
  std::uint64_t schedule_progress_notified_frame = 0;
  std::uint32_t schedule_progress_notified_revision = 0;
  std::uint32_t schedule_progress_notified_epoch = 0;
  std::uint64_t schedule_progress_notified_accepted_frame = 0;
  std::uint64_t schedule_progress_notified_window_id = 0;
  std::uint64_t schedule_progress_notified_transition = 0;
  std::uint64_t schedule_progress_notified_urgent = 0;
  std::uint64_t schedule_progress_notified_processor = 0;
  bool schedule_progress_notified_running = false;
  bool schedule_progress_notified_complete = false;
  mutable std::mutex schedule_progress_mutex;
  std::condition_variable schedule_progress_wait;

  mutable std::mutex meter_wait_mutex;
  std::condition_variable meter_wait;
  mutable std::mutex spectrum_wait_mutex;
  std::condition_variable spectrum_wait;
  void NotifyRecordingStatus() {
    {
      std::lock_guard lock(recording_wait_mutex);
      recording_status_revision.fetch_add(1, std::memory_order_release);
    }
    recording_wait.notify_all();
    if (recording_spool) {
      recording_spool->NotifyCapture();
      recording_spool->StatusSignal()->Notify();
    }
  }

  // DAW_REALTIME_CALLBACK_HELPER_BEGIN audio-host
  void SignalRealtimeBridge(const std::uint32_t events) noexcept {
    realtime_bridge_pending.fetch_or(events, std::memory_order_release);
  }

  void RejectBlock(
    const RejectedBlockReason reason,
    const std::uint64_t callback_attempt,
    const std::uint32_t core_result = DAW_AUDIO_CORE_OK,
    const std::uint32_t frame_count = 0,
    const std::uint32_t channel_count = 0,
    const std::uint32_t processor_event_count = 0,
    const std::uint32_t instrument_event_count = 0,
    const std::uint32_t graph_revision = 0) noexcept {
    rejected_blocks.fetch_add(1, std::memory_order_relaxed);
    last_rejected_reason.store(reason, std::memory_order_relaxed);
    last_rejected_callback.store(callback_attempt, std::memory_order_relaxed);
    last_rejected_render_epoch.store(completed_render_epoch.load(std::memory_order_relaxed), std::memory_order_relaxed);
    last_rejected_transport_epoch.store(applied_transport_epoch.load(std::memory_order_relaxed), std::memory_order_relaxed);
    last_rejected_core_result.store(core_result, std::memory_order_relaxed);
    last_rejected_frame_count.store(frame_count, std::memory_order_relaxed);
    last_rejected_channel_count.store(channel_count, std::memory_order_relaxed);
    last_rejected_processor_event_count.store(processor_event_count, std::memory_order_relaxed);
    last_rejected_instrument_event_count.store(instrument_event_count, std::memory_order_relaxed);
    last_rejected_graph_revision.store(graph_revision, std::memory_order_relaxed);
  }

  GraphRevisionStatus GraphStatus(
    const GraphRevisionStatusCode code,
    const std::uint32_t revision
  ) const {
    return {
      .code = code,
      .continuity = prepared_continuity,
      .requested_revision = revision,
      .active_revision = active_revision.load(std::memory_order_acquire),
      .prepared_revision = prepared_revision.load(std::memory_order_acquire),
      .retired_revision = retired_revision.load(std::memory_order_acquire),
      .render_epoch = completed_render_epoch.load(std::memory_order_acquire),
      .publication_frame = acceptance_publication_frame.load(std::memory_order_acquire),
      .requested_publication_frame = requested_publication_frame,
      .progress_frame = static_cast<std::uint64_t>(applied_transport_frame.load(std::memory_order_acquire)),
      .transport_epoch = transport_epoch.load(std::memory_order_acquire),
    };
  }

  // DAW_REALTIME_CALLBACK_HELPER_END audio-host

  bool LatencyTransitionPending() const {
    const auto transition = daw::audio_core::InspectLatencyTransition(active_core.load(std::memory_order_acquire));
    const auto lifecycle = state.load(std::memory_order_acquire);
    // A fault notification does not quiesce an in-flight device reader.
    // Stop owns cancellation only after StopCoreAudioDevice has joined it.
    return transition.completed_revision < transition.revision
      && (lifecycle == LifecycleState::kRunning || lifecycle == LifecycleState::kFaulted);
  }

  void NotifyScheduleProgress() {
    // Non-realtime only. Pair the predicate store with the waiter's mutex so
    // the final completion notification cannot be lost between check and sleep.
    {
      std::lock_guard lock(schedule_progress_mutex);
      schedule_progress_ready.store(true, std::memory_order_release);
    }
    schedule_progress_wait.notify_all();
  }

  // Non-realtime only. Before the first callback there is no populated revision/epoch to
  // report; the first real progress snapshot carries the counters this change touched.
  void PublishScheduleProgressChange() {
    if (schedule_progress_sequence.load(std::memory_order_acquire) == 0) return;
    schedule_progress_sequence.fetch_add(1, std::memory_order_release);
    NotifyScheduleProgress();
  }

  void StartRealtimeBridge() {
    realtime_bridge_running.store(true, std::memory_order_release);
    realtime_bridge_thread = std::thread([this] {
      const auto report_instrument_rejections = [this] {
        std::fprintf(stderr, "[native-instrument] permanent event rejection {total:%llu,firstNode:%llu,firstSequence:%llu}; valid subset rendered\n",
          static_cast<unsigned long long>(rejected_instrument_count.load(std::memory_order_acquire)),
          static_cast<unsigned long long>(rejected_instrument_node.load(std::memory_order_relaxed)),
          static_cast<unsigned long long>(rejected_instrument_sequence.load(std::memory_order_relaxed)));
        Evidence("instrument-event-rejected", "permanent-core-validation-failure");
      };
      while (realtime_bridge_running.load(std::memory_order_acquire)) {
        const std::uint32_t pending = realtime_bridge_pending.exchange(0, std::memory_order_acq_rel);
        if ((pending & kRealtimeAssetReaders) != 0) WakeAssetControl();
        if ((pending & (1U << 7U)) != 0 && acceptance_tap) acceptance_tap->Drain();
        if ((pending & kRealtimePublishAcknowledged) != 0) PublicationEvidence("block-boundary");
        if ((pending & kRealtimeInstrumentRejected) != 0) report_instrument_rejections();
        if ((pending & kRealtimeLatencyCompleted) != 0) {
          Evidence("latency-move-complete", "reader-epoch");
        }
        if ((pending & kRealtimePublishAcknowledged) != 0) publish_wait.notify_all();
        if ((pending & kRealtimeProcessorPatchAcknowledged) != 0) {
          publish_wait.notify_all();
          // The ack of a claimed patch is reported on a progress frame even while paused and quiet.
          PublishScheduleProgressChange();
        }
        if ((pending & kRealtimeRecordingStatus) != 0) NotifyRecordingStatus();
        if ((pending & NativeMeterObserver::kMeterReadyBit) != 0) meter_wait.notify_all();
        if ((pending & (1U << 4U)) != 0) spectrum_wait.notify_all();
        if ((pending & (kRealtimeScheduleProgress | kRealtimeLatencyCompleted)) != 0) {
          if (acceptance_tap
            && (acceptance_observed_epoch != schedule_progress_epoch.load()
              || acceptance_observed_running != schedule_progress_running.load())) {
            acceptance_observed_epoch = schedule_progress_epoch.load();
            acceptance_observed_running = schedule_progress_running.load();
            Evidence("transport");
          }
          // A live parameter write, such as a manual override of an automated one, publishes no graph: the callback's
          // applied sequence is the only sign it landed. Reset to zero by a stop, which is not an application.
          const auto processor_sequence = schedule_progress_processor.load(std::memory_order_acquire);
          if (acceptance_tap && processor_sequence != acceptance_observed_processor_sequence) {
            acceptance_observed_processor_sequence = processor_sequence;
            if (processor_sequence != 0) {
              char detail[64];
              std::snprintf(detail, sizeof(detail), ",\"appliedProcessorSequence\":\"%llu\"",
                static_cast<unsigned long long>(processor_sequence));
              Evidence("processor-sequence-applied", "block-boundary", 0, detail);
            }
          }
          NotifyScheduleProgress();
        }
        if (pending != 0) continue;
        // CoreAudio callbacks cannot wake scheduler primitives. This bounded
        // non-realtime bridge observes callback atomics within 100 microseconds.
        std::unique_lock lock(realtime_bridge_wait_mutex);
        realtime_bridge_wait.wait_for(lock, std::chrono::microseconds(100), [this] {
          return !realtime_bridge_running.load(std::memory_order_acquire)
            || realtime_bridge_pending.load(std::memory_order_acquire) != 0;
        });
      }
      const std::uint32_t pending = realtime_bridge_pending.exchange(0, std::memory_order_acq_rel);
      if ((pending & kRealtimeInstrumentRejected) != 0) report_instrument_rejections();
      if (acceptance_tap) acceptance_tap->Drain();
      if ((pending & kRealtimePublishAcknowledged) != 0) publish_wait.notify_all();
      if ((pending & kRealtimeProcessorPatchAcknowledged) != 0) {
        publish_wait.notify_all();
        PublishScheduleProgressChange();
      }
      if ((pending & kRealtimeRecordingStatus) != 0) NotifyRecordingStatus();
      if ((pending & NativeMeterObserver::kMeterReadyBit) != 0) meter_wait.notify_all();
      if ((pending & (1U << 4U)) != 0) spectrum_wait.notify_all();
      if ((pending & (kRealtimeScheduleProgress | kRealtimeLatencyCompleted)) != 0) {
        NotifyScheduleProgress();
      }
    });
  }

  void StopRealtimeBridge() {
    if (!realtime_bridge_running.exchange(false, std::memory_order_acq_rel)) return;
    realtime_bridge_wait.notify_all();
    meter_wait.notify_all();
    if (realtime_bridge_thread.joinable()) realtime_bridge_thread.join();
  }

  bool ApplyRecordingCommand(const std::int64_t current_frame) {
    const daw_audio_core_handle capture = recording_capture.load(std::memory_order_acquire);
    const RecordingCommand command = recording_command.exchange(RecordingCommand::kNone, std::memory_order_acq_rel);
    if (capture == 0 || command == RecordingCommand::kNone) return false;
    if (command == RecordingCommand::kCancel) {
      static_cast<void>(daw_audio_recording_capture_cancel(capture));
    } else {
      const std::int64_t requested = recording_stop_frame.exchange(-1, std::memory_order_acq_rel);
      static_cast<void>(daw_audio_recording_capture_finalize(capture, requested < 0 ? current_frame : requested));
    }
    recording_started.store(false, std::memory_order_release);
    return true;
  }
  // Spawns one worker. The plug-in loads inside that process, so this never waits for it.
  [[nodiscard]] bool StartNativeVstWorker(
    NativeVstWorkerAttachment* const attachment,
    const daw::plugin_host::WorkerProcessSetup::Mode mode,
    const std::string& worker_executable
  ) {
    attachment->offline = mode == daw::plugin_host::WorkerProcessSetup::Mode::kOffline;
    attachment->offline_started = false;
    attachment->offline_parameters_applied = false;
    attachment->realtime_started = false;
    attachment->missed_callbacks.fill(0);
    attachment->missed_frames.fill(0);
    const auto& metadata = attachment->metadata;
    const auto initial_state = metadata.initial_state_sha256.empty()
      ? std::optional<daw::plugin_host::WorkerState>{}
      : std::optional<daw::plugin_host::WorkerState>(
        daw::plugin_host::WorkerState{
          .bytes = metadata.initial_state,
          .sha256 = metadata.initial_state_sha256,
        });
    daw::plugin_host::WorkerStartupRequest startup{
      .eligibility = {
        .canonicalBundlePath = metadata.canonical_bundle_path,
        .canonicalExecutablePath = metadata.canonical_executable_path,
        .bundleFingerprint = HexFingerprint(metadata.bundle_fingerprint),
        .binaryFingerprint = HexFingerprint(metadata.binary_fingerprint),
        .arm64 = metadata.architecture == 1,
        .codeSignVerified = true,
        .quarantinePresent = false,
        .scannerProtocolVersion = metadata.scanner_catalog_version,
      },
      .classId = metadata.class_id,
      .setup = {
        .sampleRate = static_cast<double>(config.sample_rate_hz),
        .maximumBlockFrames = metadata.transport.maximum_frames,
        .inputChannels = metadata.transport.input_channels,
        .outputChannels = metadata.transport.output_channels,
        .mode = mode,
      },
      .state = initial_state,
    };
#if defined(DAW_AUDIO_HOST_TEST_PATCH_CLAIM) && DAW_AUDIO_HOST_TEST_PATCH_CLAIM == 1
    if (test_no_plugin_workers.load(std::memory_order_acquire)) {
      startup.eligibility = {};
      startup.classId.clear();
      startup.state.reset();
      startup.noPluginTestMode = true;
    }
#endif
    const daw::plugin_host::WorkerTransportRequest transport{
      .slotCount = metadata.transport.slot_count,
      .maximumFrames = metadata.transport.maximum_frames,
      .inputChannels = metadata.transport.input_channels,
      .outputChannels = metadata.transport.output_channels,
      .maximumEventsPerBlock = static_cast<std::uint32_t>(std::min<std::size_t>(
        daw::plugin_host::kMaximumWorkerEvents,
        metadata.transport.maximum_events_per_block + metadata.initial_parameter_values.size()
      )),
    };
    const daw::plugin_host::WorkerHostConfiguration worker_configuration{
      .executable = worker_executable,
      .artifact = {
        .id = std::string(daw::plugin_host::kWorkerArtifactId),
        .version = std::string(daw::plugin_host::kWorkerArtifactVersion),
      },
    };
    attachment->worker.SetDiagnosticListener(ForwardWorkerDiagnostic, attachment);
    if (!attachment->worker.Start(startup, worker_configuration, transport)) return false;
    if (attachment->worker.workerGeneration() == 0) {
      attachment->worker.Stop();
      return false;
    }
    if (daw::acceptance::Enabled()) {
      char fields[256];
      std::snprintf(fields, sizeof(fields), ",\"workerGeneration\":\"%llu\",\"nodeId\":\"%llu\"",
        static_cast<unsigned long long>(++acceptance_worker_ordinal),
        static_cast<unsigned long long>(metadata.graph_node_id));
      daw::acceptance::Event("worker-supervisor-started", fields);
    }
    return true;
  }
  [[nodiscard]] bool StartNativeVstWorkers(
    const daw::plugin_host::WorkerProcessSetup::Mode mode
  ) {
    offline_failure.store(false, std::memory_order_release);
    const bool has_enabled_attachment = std::any_of(
      native_vst_attachments.begin(),
      native_vst_attachments.end(),
      [](const auto& entry) {
        return entry.second->metadata.playback_enabled && !entry.second->Detached();
      }
    );
    const auto worker_executable = has_enabled_attachment ? WorkerExecutablePath() : std::optional<std::string>{};
    if (has_enabled_attachment && !worker_executable) return false;
    std::array<NativeVstWorkerAttachment*, kMaximumNativeVstAttachments> started{};
    std::size_t started_count = 0;
    for (auto& [instance_id, attachment] : native_vst_attachments) {
      static_cast<void>(instance_id);
      if (!attachment->metadata.playback_enabled || attachment->Detached()) continue;
      if (!StartNativeVstWorker(attachment.get(), mode, *worker_executable)) {
        for (std::size_t index = 0; index < started_count; ++index) started[index]->worker.Stop();
        return false;
      }
      started[started_count++] = attachment.get();
    }
    native_worker_mode = mode;
    return true;
  }
  // A retired instance is handed to the reaper (which stops its worker) once no plan
  // holds its address. Control thread only.
  void RetireNativeVst(NativeVstWorkerAttachment& attachment) {
    attachment.ownership = NativeVstWorkerAttachment::Ownership::kRetired;
  }
  [[nodiscard]] static bool SameLoadedPlugin(const NativeVstAttachment& left, const NativeVstAttachment& right) {
    return left.class_id == right.class_id && left.vendor_id == right.vendor_id
      && left.canonical_bundle_path == right.canonical_bundle_path
      && left.canonical_executable_path == right.canonical_executable_path
      && left.architecture == right.architecture
      && left.bundle_fingerprint == right.bundle_fingerprint && left.binary_fingerprint == right.binary_fingerprint
      && left.scanner_catalog_version == right.scanner_catalog_version
      && left.role == right.role && left.input_layout == right.input_layout && left.output_layout == right.output_layout
      && left.playback_enabled == right.playback_enabled
      && left.initial_state_sha256 == right.initial_state_sha256
      && left.parameter_ids == right.parameter_ids
      && left.initial_parameter_values == right.initial_parameter_values
      && left.transport.slot_count == right.transport.slot_count
      && left.transport.maximum_frames == right.transport.maximum_frames
      && left.transport.input_channels == right.transport.input_channels
      && left.transport.output_channels == right.transport.output_channels
      && left.transport.maximum_events_per_block == right.transport.maximum_events_per_block;
  }
  [[nodiscard]] static bool SameBinding(const NativeVstAttachment& left, const NativeVstAttachment& right) {
    return left.graph_node_id == right.graph_node_id && left.stage_index == right.stage_index
      && left.source_index == right.source_index && left.render_enabled == right.render_enabled
      && left.declared_latency_frames == right.declared_latency_frames
      && left.declared_tail_frames == right.declared_tail_frames && left.infinite_tail == right.infinite_tail
      && left.transport_latency_frames == right.transport_latency_frames;
  }
  // A ready instance parks instead of retiring; the newest kMaximumParkedNativeVsts stay.
  void ParkNativeVst(NativeVstWorkerAttachment& attachment) {
    attachment.ownership = NativeVstWorkerAttachment::Ownership::kParked;
    attachment.parked_at = std::chrono::steady_clock::now();
    std::vector<NativeVstWorkerAttachment*> parked;
    for (auto& [instance_id, held] : native_vst_attachments) {
      static_cast<void>(instance_id);
      if (held->ownership == NativeVstWorkerAttachment::Ownership::kParked) parked.push_back(held.get());
    }
    if (parked.size() <= kMaximumParkedNativeVsts) return;
    std::sort(parked.begin(), parked.end(), [](const auto* left, const auto* right) {
      return left->parked_at < right->parked_at;
    });
    for (std::size_t index = 0; index + kMaximumParkedNativeVsts < parked.size(); ++index) RetireNativeVst(*parked[index]);
  }
  // Takes back a parked instance of the same loaded plug-in. A plan still holding the
  // object's address needs an identical binding, because the callback reads its metadata;
  // a retired plan not yet reclaimed still holds the address of an instance the newer plan dropped.
  [[nodiscard]] bool RejoinParkedNativeVst(NativeVstWorkerAttachment& parked, const NativeVstAttachment& attachment) {
    if (parked.ownership != NativeVstWorkerAttachment::Ownership::kParked
      || parked.worker.health() != daw::plugin_host::WorkerHealth::kReady
      || !SameLoadedPlugin(parked.metadata, attachment)) return false;
    const bool held_by_plan = parked.bound_active || parked.bound_prepared || HasRetiredPlan();
    if (held_by_plan && !SameBinding(parked.metadata, attachment)) return false;
    if (!held_by_plan) parked.metadata = attachment;
    parked.ownership = parked.bound_active || !graph_prepared
      ? NativeVstWorkerAttachment::Ownership::kActive
      : NativeVstWorkerAttachment::Ownership::kStaged;
    return true;
  }
  void ExpireParkedNativeVsts() {
    const auto now = std::chrono::steady_clock::now();
    for (auto& [instance_id, attachment] : native_vst_attachments) {
      static_cast<void>(instance_id);
      if (attachment->ownership == NativeVstWorkerAttachment::Ownership::kParked
        && now - attachment->parked_at >= parked_age) RetireNativeVst(*attachment);
    }
  }
  void ReclaimRetiredNativeVsts() {
    ExpireParkedNativeVsts();
    if (HasRetiredPlan()) return;
    for (auto entry = native_vst_attachments.begin(); entry != native_vst_attachments.end();) {
      const auto& attachment = *entry->second;
      if (attachment.ownership != NativeVstWorkerAttachment::Ownership::kRetired
        || attachment.bound_active || attachment.bound_prepared) {
        ++entry;
        continue;
      }
      if (!retired_attachment_reaper) retired_attachment_reaper.emplace();
      retired_attachment_reaper->Reap(std::move(entry->second));
      entry = native_vst_attachments.erase(entry);
    }
  }
  // The prepared revision became the active plan: staged instances it bound are now
  // active, and a staged instance it could not bind (not ready) is retired.
  void AdoptPublishedNativeVsts() {
    for (auto& [instance_id, attachment] : native_vst_attachments) {
      static_cast<void>(instance_id);
      attachment->bound_active = attachment->bound_prepared;
      attachment->bound_prepared = false;
      if (attachment->ownership != NativeVstWorkerAttachment::Ownership::kStaged) continue;
      if (attachment->bound_active || !attachment->metadata.playback_enabled) {
        attachment->ownership = NativeVstWorkerAttachment::Ownership::kActive;
      } else {
        RetireNativeVst(*attachment);
      }
    }
  }
  void AdoptPublishedRouting() {
    published_routing = std::move(prepared_routing);
    prepared_routing.reset();
  }
  // The node an unfinished capture is bound to. The advance thread retires captures, so this takes the owner mutex.
  std::optional<std::uint64_t> CaptureTarget() const {
    std::lock_guard lock(recording_owner_mutex);
    if (!recording_session || recording_capture_retired || recording_finish_accepted
      || recording_config.target_node_id == 0) return std::nullopt;
    return recording_config.target_node_id;
  }
  // The prepared revision was dropped: everything it staged is retired.
  void RollbackStagedNativeVsts() {
    for (auto& [instance_id, attachment] : native_vst_attachments) {
      static_cast<void>(instance_id);
      attachment->bound_prepared = false;
      if (attachment->ownership == NativeVstWorkerAttachment::Ownership::kStaged) RetireNativeVst(*attachment);
    }
  }
  void StopNativeVstWorkers() {
    native_worker_mode.reset();
    for (auto& [instance_id, attachment] : native_vst_attachments) {
      static_cast<void>(instance_id);
      attachment->worker.Stop();
      attachment->offline = false;
      attachment->offline_started = false;
      attachment->offline_parameters_applied = false;
      attachment->pending_sequences.fill(0);
      attachment->pending_frames.fill(0);
      attachment->missed_callbacks.fill(0);
      attachment->missed_frames.fill(0);
      attachment->realtime_started = false;
      attachment->completed_output_read = 0;
      attachment->completed_output_write = 0;
    }
  }
  template <std::size_t Capacity>
  static bool EnqueueControlEvent(ControlLane<Capacity>& lane, const QueuedControlEvent& event) {
    const std::uint32_t write = lane.write.load(std::memory_order_relaxed);
    const std::uint32_t read = lane.read.load(std::memory_order_acquire);
    if (write - read >= Capacity) return false;
    lane.events[write % Capacity] = event;
    lane.write.store(write + 1, std::memory_order_release);
    return true;
  }
  static bool EnqueueTransportCommand(TransportLane& lane, const TransportCommand& command) noexcept {
    const auto write = lane.write.load(std::memory_order_relaxed);
    const auto read = lane.read.load(std::memory_order_acquire);
    if (write - read >= kTransportQueueCapacity) return false;
    lane.commands[write % kTransportQueueCapacity] = command;
    lane.write.store(write + 1, std::memory_order_release);
    return true;
  }
  void ClearScheduledLanes() noexcept {
    ActiveSchedule().instrument_queue.read.store(ActiveSchedule().instrument_queue.write.load(std::memory_order_acquire), std::memory_order_release);
    urgent_queue.read.store(urgent_queue.write.load(std::memory_order_acquire), std::memory_order_release);
    instrument_queue.read.store(instrument_queue.write.load(std::memory_order_acquire), std::memory_order_release);
    ActiveSchedule().source_queue.read.store(ActiveSchedule().source_queue.write.load(std::memory_order_acquire), std::memory_order_release);
    ActiveSchedule().scheduled_processor_queue.read.store(
      ActiveSchedule().scheduled_processor_queue.write.load(std::memory_order_acquire), std::memory_order_release);
    processor_queue.read.store(processor_queue.write.load(std::memory_order_acquire), std::memory_order_release);
    transport_queue.read.store(transport_queue.write.load(std::memory_order_acquire), std::memory_order_release);
    ActiveSchedule().published_schedule_window_id.store(0, std::memory_order_release);
    ActiveSchedule().accepted_schedule_epoch.store(0, std::memory_order_release);
    ActiveSchedule().accepted_schedule_through_frame.store(transport_frame.load(std::memory_order_acquire), std::memory_order_release);
    ActiveSchedule().schedule_complete.store(false, std::memory_order_release);
    ActiveSchedule().last_accepted_schedule_window_id = 0;
    ActiveSchedule().last_accepted_schedule_epoch = 0;
    ActiveSchedule().last_schedule_start_frame = 0;
    ActiveSchedule().schedule_digest_windows = {};
    ActiveSchedule().schedule_chunk_digests = {};
    ActiveSchedule().schedule_digest_cursor = 0;
    ActiveSchedule().schedule_staging.clear();
  }
  [[nodiscard]] bool EnqueueControlEvent(const QueuedControlEvent& event) {
    if (event.kind == QueuedControlKind::kUrgent) return EnqueueControlEvent(urgent_queue, event);
    if (event.kind == QueuedControlKind::kInstrument) return EnqueueControlEvent(instrument_queue, event);
    if (event.kind == QueuedControlKind::kSource) return EnqueueControlEvent(ActiveSchedule().source_queue, event);
    return EnqueueControlEvent(processor_queue, event);
  }
  template <std::size_t Capacity>
  static bool HasCapacity(const ControlLane<Capacity>& lane, const std::uint32_t count) {
    const auto write = lane.write.load(std::memory_order_relaxed);
    const auto read = lane.read.load(std::memory_order_acquire);
    return count <= Capacity && write - read <= Capacity - count;
  }
  [[nodiscard]] bool HasCapacity(const QueuedControlKind kind, const std::uint32_t count) const {
    if (kind == QueuedControlKind::kUrgent) return HasCapacity(urgent_queue, count);
    if (kind == QueuedControlKind::kInstrument) return HasCapacity(instrument_queue, count);
    if (kind == QueuedControlKind::kSource) return HasCapacity(ActiveSchedule().source_queue, count);
    return HasCapacity(processor_queue, count);
  }
  template <std::size_t Capacity>
  static bool HasQueuedControl(const ControlLane<Capacity>& lane) {
    return lane.read.load(std::memory_order_acquire) != lane.write.load(std::memory_order_acquire);
  }
  [[nodiscard]] bool HasQueuedControl() const {
    return HasQueuedControl(urgent_queue) || HasQueuedControl(instrument_queue)
      || HasQueuedControl(ActiveSchedule().instrument_queue)
      || HasQueuedControl(ActiveSchedule().source_queue) || HasQueuedControl(ActiveSchedule().scheduled_processor_queue)
      || HasQueuedControl(processor_queue);
  }
  [[nodiscard]] bool HasQueuedGraphControl() const {
    // Scheduled lanes cannot drain while paused. Publication reconciles their
    // targets; only immediate graph controls must drain before preparation.
    return HasQueuedControl(urgent_queue) || HasQueuedControl(processor_queue);
  }
  // DAW_REALTIME_CALLBACK_HELPER_BEGIN reconcile-scheduled-targets
  std::array<daw_audio_sample_source_event, 256> seam_sources{};
  bool ReconcileSourceSeam(const bool apply, const std::int64_t frame) noexcept {
    auto& lane = PreparedSchedule().source_queue;
    const auto read = lane.read.load(std::memory_order_relaxed);
    const auto write = lane.write.load(std::memory_order_acquire);
    auto cursor = read;
    std::size_t count = 0;
    for (; cursor != write; ++cursor) {
      const auto& event = lane.events[cursor % kSourceQueueCapacity];
      if (event.source.start_frame > frame) break;
      if (count == seam_sources.size()) return false;
      seam_sources[count++] = event.source;
    }
    if (!daw::audio_core::ReconcileSampleSources(active_core.load(std::memory_order_acquire),
      std::span<const daw_audio_sample_source_event>{seam_sources.data(), count}, frame, apply)) return false;
    if (apply) lane.read.store(cursor, std::memory_order_release);
    return true;
  }

  void ReconcileScheduledTargets(const daw_audio_core_handle core,
    const std::uint32_t previous_revision, const std::uint32_t revision, const bool include_schedule = true) noexcept {
    const auto reconcile = [&]<std::size_t Capacity>(ControlLane<Capacity>& lane) {
      const auto read = lane.read.load(std::memory_order_relaxed);
      const auto write = lane.write.load(std::memory_order_acquire);
      // Consumer owns these entries until read advances. Producers can only
      // append beyond this captured write cursor; never compact a live SPSC lane.
      for (auto cursor = read; cursor != write; ++cursor) {
        auto& event = lane.events[cursor % Capacity];
        if (event.cancelled) continue;
        if (event.kind == QueuedControlKind::kSource) {
          event.cancelled = !daw::audio_core::RetainsScheduledTarget(core, previous_revision, event.source);
        } else if (event.kind == QueuedControlKind::kInstrument || event.kind == QueuedControlKind::kUrgent) {
          const daw_audio_sample_source_event target{.source_node_id = event.instrument.node_id};
          event.cancelled = !daw::audio_core::RetainsScheduledTarget(core, previous_revision, target);
        } else {
          event.cancelled = (event.processor_revision != 0 && event.processor_revision != previous_revision)
            || !daw::audio_core::RetainsScheduledTarget(core, previous_revision, event.processor);
          if (!event.cancelled && event.processor_revision != 0) event.processor_revision = revision;
        }
      }
    };
    reconcile(urgent_queue);
    reconcile(instrument_queue);
    reconcile(processor_queue);
    if (include_schedule) {
      reconcile(ActiveSchedule().source_queue);
      reconcile(ActiveSchedule().scheduled_processor_queue);
      reconcile(ActiveSchedule().instrument_queue);
      for (std::uint32_t index = 0; index < processor_ramp_count; ++index) {
        auto& ramp = processor_ramps[index];
        ramp.cancelled = ramp.cancelled || ramp.revision != previous_revision
          || !daw::audio_core::RetainsScheduledTarget(core, previous_revision, ramp.processor);
        if (!ramp.cancelled) ramp.revision = revision;
      }
    }
  }
  // DAW_REALTIME_CALLBACK_HELPER_END reconcile-scheduled-targets
  bool RegisterPreparedGraphHooks(
    const daw_audio_core_handle core,
    const std::uint32_t revision
  ) {
    std::vector<daw::audio_core::NativeGraphHookBinding> bindings;
    bindings.reserve(native_vst_attachments.size());
    std::unordered_map<std::uint64_t, std::vector<NativeVstWorkerAttachment*>> chains;
    for (auto& [instance_id, attachment] : native_vst_attachments) {
      static_cast<void>(instance_id);
      if (!attachment->metadata.playback_enabled || attachment->Detached()) continue;
      // A staged instance binds only once its worker is ready; otherwise it is left out
      // and retired when this revision publishes.
      if (attachment->ownership == NativeVstWorkerAttachment::Ownership::kStaged
        && attachment->worker.health() != daw::plugin_host::WorkerHealth::kReady) continue;
      if (attachment->metadata.transport.maximum_frames < config.max_frames_per_block) return false;
      chains[attachment->metadata.graph_node_id].push_back(attachment.get());
    }
    for (auto& [node_id, chain] : chains) {
      std::unordered_set<std::uint32_t> stage_indices;
      for (const auto* attachment : chain) {
        if (attachment->metadata.role == NativeVstRole::kEffect
          && !stage_indices.insert(attachment->metadata.stage_index).second) return false;
      }
      std::sort(chain.begin(), chain.end(), [](const auto* left, const auto* right) {
        const auto left_source = left->metadata.role == NativeVstRole::kInstrument;
        const auto right_source = right->metadata.role == NativeVstRole::kInstrument;
        return left_source != right_source
          ? left_source
          : left->metadata.stage_index < right->metadata.stage_index;
      });
      std::uint64_t total_latency = 0;
      for (std::size_t index = 0; index < chain.size(); ++index) {
        if (!chain[index]->metadata.render_enabled) continue;
        total_latency += chain[index]->metadata.declared_latency_frames
          + chain[index]->metadata.transport_latency_frames;
      }
      if (total_latency > std::numeric_limits<std::uint32_t>::max()) return false;
      for (auto* attachment : chain) {
        bindings.push_back({
          .node_id = node_id,
          .stage_index = attachment->metadata.role == NativeVstRole::kInstrument
            ? attachment->metadata.source_index
            : attachment->metadata.stage_index,
          .output_layout = attachment->metadata.output_layout,
          .pdc_latency_frames = 0,
          .external_latency_frames = static_cast<std::uint32_t>(total_latency),
          .stage_role = attachment->metadata.role == NativeVstRole::kInstrument
            ? daw::audio_core::NativeGraphStageRole::kInstrument
            : daw::audio_core::NativeGraphStageRole::kEffect,
          .attachment = attachment,
        });
      }
    }
    if (daw::audio_core::RegisterNativeGraphHook(
      core,
      {
        .graph_revision = revision,
        .hook = bindings.empty() ? nullptr : DispatchNativeVstGraphHook,
        .bindings = bindings,
        .observer = NativeTelemetryObserver::Dispatch,
        .observer_attachment = &telemetry_observer,
      }
    ) != DAW_AUDIO_CORE_OK) return false;
    std::unordered_set<const void*> bound;
    for (const auto& binding : bindings) bound.insert(binding.attachment);
    for (auto& [instance_id, attachment] : native_vst_attachments) {
      static_cast<void>(instance_id);
      attachment->bound_prepared = bound.contains(attachment.get());
    }
    return true;
  }
};

bool RecordingInputDevice::Start(std::string_view uid, std::uint32_t rate, std::uint32_t channels,
  AudioHost* host, void** session) { return StartCoreAudioInputDevice(uid, rate, channels, host, session); }
void RecordingInputDevice::Stop(void* session) { StopCoreAudioDevice(session); }
std::uint32_t RecordingInputDevice::Rate(std::string_view uid) {
  const auto device = SelectInputDevice(uid);
  return device ? device->nominal_sample_rate_hz : 0;
}

void RecordingStatusChannel::Publish(RecordingStatus status) {
  {
    std::lock_guard lock(mutex_);
    latest_ = std::move(status);
    ++revision_;
  }
  changed_.notify_all();
}
std::optional<RecordingStatus> RecordingStatusChannel::Wait(std::uint64_t& revision, const std::atomic<bool>& running) {
  std::unique_lock lock(mutex_);
  changed_.wait(lock, [&] { return revision_ != revision || !running.load(std::memory_order_acquire); });
  revision = revision_;
  return running.load(std::memory_order_acquire) ? latest_ : std::nullopt;
}
void RecordingStatusChannel::Wake() {
  // Pair the external shutdown flag with Wait's predicate mutex, so a wake
  // cannot fall between its predicate check and condition-variable sleep.
  std::lock_guard lock(mutex_);
  changed_.notify_all();
}

AudioHost::AudioHost(RecordingSpoolService* spool, RecordingInputDevice* recording_device,
  std::shared_ptr<RecordingStatusChannel> recording_status) : impl_(new Impl) {
  if (pipe(impl_->control_wake.data()) == 0) {
    bool ready = true;
    for (const auto descriptor : impl_->control_wake) {
      ready = fcntl(descriptor, F_SETFL, O_NONBLOCK) == 0 && ready;
      ready = fcntl(descriptor, F_SETFD, FD_CLOEXEC) == 0 && ready;
    }
    if (!ready) {
      for (const auto descriptor : impl_->control_wake) close(descriptor);
      impl_->control_wake.fill(-1);
    }
  }
  impl_->recording_spool = spool;
  impl_->recording_status_channel = std::move(recording_status);
  impl_->recording_device = recording_device ? recording_device : &impl_->default_recording_device;
  impl_->worker_notifications.active_revision = &impl_->active_revision;
  impl_->meter_observer.bridge_pending = &impl_->realtime_bridge_pending;
  impl_->spectrum_observer.selected_node = &impl_->spectrum_selected_node;
  impl_->spectrum_observer.bridge_pending = &impl_->realtime_bridge_pending;
  impl_->telemetry_observer.meter = &impl_->meter_observer;
  impl_->telemetry_observer.spectrum = &impl_->spectrum_observer;
  impl_->StartRealtimeBridge();
  if (spool) {
    impl_->recording_advance_running.store(true, std::memory_order_release);
    impl_->recording_advance_thread = std::thread([this, signal = spool->StatusSignal()] {
      auto revision = signal->Revision();
      while (impl_->recording_advance_running.load(std::memory_order_acquire)) {
        AdvanceRecording();
        if (impl_->recording_status_channel) {
          const auto status = RecordingSnapshot();
          if (status.generation != 0) impl_->recording_status_channel->Publish(status);
        }
        revision = signal->Wait(revision);
      }
    });
  }
}

AudioHost::~AudioHost() {
  Stop();
  impl_->StopRealtimeBridge();
  for (const auto descriptor : impl_->control_wake) if (descriptor >= 0) close(descriptor);
  impl_->recording_advance_running.store(false, std::memory_order_release);
  if (impl_->recording_spool) impl_->recording_spool->StatusSignal()->Notify();
  if (impl_->recording_advance_thread.joinable()) impl_->recording_advance_thread.join();
  impl_->recording_capture.store(0, std::memory_order_release);
  impl_->recording_session.reset();
  const daw_audio_core_handle active_core = impl_->active_core.load(std::memory_order_acquire);
  if (active_core != 0) daw_audio_core_destroy(active_core);
  if (impl_->prepared_core != 0 && !impl_->prepared_core_is_same_core) daw_audio_core_destroy(impl_->prepared_core);
  if (impl_->retired_core != 0) daw_audio_core_destroy(impl_->retired_core);
  delete impl_;
}

bool AudioHost::Configure(const HostConfig& config) {
  if (impl_->control_wake[0] < 0 || impl_->publication_in_flight != 0
    || !ValidConfig(config) || impl_->state.load(std::memory_order_acquire) == LifecycleState::kRunning) return false;
  daw_audio_core_handle next_core = 0;
  const daw_audio_core_config core_config{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .max_frames_per_block = config.max_frames_per_block,
    .max_channels = config.channel_count,
    .max_assets = 64,
    .sample_rate_hz = config.sample_rate_hz,
  };
  if (daw_audio_core_create(&core_config, &next_core) != DAW_AUDIO_CORE_OK) return false;
  const daw_audio_core_prepare_request prepare{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .graph_revision = config.revision,
    .reserved0 = 0,
    .reserved1 = 0,
  };
  if (daw_audio_core_prepare(next_core, &prepare) != DAW_AUDIO_CORE_OK
    || daw_audio_core_publish(next_core, config.revision) != DAW_AUDIO_CORE_OK) {
    daw_audio_core_destroy(next_core);
    return false;
  }
  const daw_audio_core_handle previous_core = impl_->active_core.exchange(next_core, std::memory_order_acq_rel);
  if (previous_core != 0) daw_audio_core_destroy(previous_core);
  if (impl_->prepared_core != 0 && !impl_->prepared_core_is_same_core) daw_audio_core_destroy(impl_->prepared_core);
  if (impl_->retired_core != 0) daw_audio_core_destroy(impl_->retired_core);
  impl_->prepared_core = 0;
  impl_->prepared_core_is_same_core = false;
  impl_->prepared_continuity = GraphRevisionContinuity::kNotEvaluated;
  impl_->retired_core = 0;
  impl_->retired_same_core = false;
  impl_->config = config;
  if (impl_->acceptance_tap) impl_->acceptance_tap->Configure(config.sample_rate_hz, config.channel_count);
  impl_->Evidence("device-configure");
  impl_->schedule_progress_has_notification = false;
  impl_->schedule_progress_notified_frame = 0;
  impl_->schedule_progress_notified_revision = 0;
  impl_->schedule_progress_notified_epoch = 0;
  impl_->schedule_progress_notified_accepted_frame = 0;
  impl_->schedule_progress_notified_window_id = 0;
  impl_->schedule_progress_notified_transition = 0;
  impl_->schedule_progress_notified_urgent = 0;
  impl_->schedule_progress_notified_running = false;
  impl_->schedule_progress_notified_complete = false;
  impl_->assets.clear();
  impl_->asset_retirement_pending.store(false, std::memory_order_release);
  impl_->published_instrument_assets.clear();
  impl_->prepared_instrument_assets.clear();
  impl_->published_routing.reset();
  impl_->prepared_routing.reset();
  impl_->prepared_asset_handles.clear();
  for (auto& [instance_id, attachment] : impl_->native_vst_attachments) {
    attachment->realtime_started = false;
    attachment->missed_callbacks.fill(0);
    attachment->missed_frames.fill(0);
  }
  impl_->graph_prepared = false;
  impl_->transport_prepared = false;
  impl_->transport_frame.store(0, std::memory_order_release);
  impl_->transport_running.store(false, std::memory_order_release);
  impl_->applied_transport_epoch.store(0, std::memory_order_release);
  impl_->applied_transport_frame.store(0, std::memory_order_release);
  impl_->applied_transport_running.store(false, std::memory_order_release);
  impl_->applied_transport_transition_id.store(0, std::memory_order_release);
  impl_->last_queued_transport_epoch.store(0, std::memory_order_release);
  impl_->last_queued_transport_transition_id.store(0, std::memory_order_release);
  impl_->schedule_banks[0].Reset(0, 0, 0);
  impl_->schedule_banks[1].Reset(0, 0, 0);
  impl_->active_schedule_bank.store(0, std::memory_order_release);
  impl_->requested_publication_frame.store(0, std::memory_order_release);
  impl_->schedule_owner.store(0, std::memory_order_release);
  impl_->transport_queue.read.store(0, std::memory_order_release);
  impl_->transport_queue.write.store(0, std::memory_order_release);
  impl_->ActiveSchedule().accepted_schedule_epoch.store(0, std::memory_order_release);
  impl_->ActiveSchedule().accepted_schedule_through_frame.store(0, std::memory_order_release);
  impl_->ActiveSchedule().published_schedule_window_id.store(0, std::memory_order_release);
  impl_->ActiveSchedule().schedule_complete.store(false, std::memory_order_release);
  impl_->ActiveSchedule().last_accepted_schedule_window_id = 0;
  impl_->ActiveSchedule().last_accepted_schedule_epoch = 0;
  impl_->ActiveSchedule().last_schedule_start_frame = 0;
  impl_->ActiveSchedule().schedule_digest_windows = {};
  impl_->ActiveSchedule().schedule_chunk_digests = {};
  impl_->ActiveSchedule().schedule_digest_cursor = 0;
  impl_->state.store(LifecycleState::kConfigured, std::memory_order_release);
  impl_->active_revision.store(config.revision, std::memory_order_release);
  impl_->prepared_revision.store(0, std::memory_order_release);
  impl_->retired_revision.store(0, std::memory_order_release);
  impl_->publish_requested_revision.store(0, std::memory_order_release);
  impl_->publish_acknowledged_revision.store(0, std::memory_order_release);
  impl_->callback_attempts.store(0, std::memory_order_release);
  impl_->callbacks.store(0, std::memory_order_release);
  impl_->split_blocks.store(0, std::memory_order_release);
  impl_->rejected_blocks.store(0, std::memory_order_release);
  impl_->last_rejected_reason.store(RejectedBlockReason::kNone, std::memory_order_release);
  impl_->last_rejected_callback.store(0, std::memory_order_release);
  impl_->last_rejected_render_epoch.store(0, std::memory_order_release);
  impl_->last_rejected_transport_epoch.store(0, std::memory_order_release);
  impl_->last_rejected_core_result.store(DAW_AUDIO_CORE_OK, std::memory_order_release);
  impl_->last_rejected_frame_count.store(0, std::memory_order_release);
  impl_->last_rejected_channel_count.store(0, std::memory_order_release);
  impl_->last_rejected_processor_event_count.store(0, std::memory_order_release);
  impl_->last_rejected_instrument_event_count.store(0, std::memory_order_release);
  impl_->last_rejected_graph_revision.store(0, std::memory_order_release);
  impl_->completed_render_epoch.store(0, std::memory_order_release);
  impl_->meter_observer.Clear();
  impl_->spectrum_observer.Clear();
  impl_->spectrum_selected_node.store(0, std::memory_order_release);
  impl_->spectrum_smoothed.fill(0.0F);
  impl_->spectrum_has_previous = false;
    impl_->spectrum_history_left.fill(0.0F);
    impl_->spectrum_history_right.fill(0.0F);
    impl_->spectrum_history_count = 0;
  impl_->meter_sequence = 0;
  impl_->spectrum_sequence = 0;
  impl_->last_graph_revision.store(0, std::memory_order_release);
  impl_->urgent_queue.read.store(0, std::memory_order_release);
  impl_->urgent_queue.write.store(0, std::memory_order_release);
  impl_->instrument_queue.read.store(0, std::memory_order_release);
  impl_->instrument_queue.write.store(0, std::memory_order_release);
  impl_->ActiveSchedule().source_queue.read.store(0, std::memory_order_release);
  impl_->ActiveSchedule().source_queue.write.store(0, std::memory_order_release);
  impl_->ActiveSchedule().scheduled_processor_queue.read.store(0, std::memory_order_release);
  impl_->ActiveSchedule().scheduled_processor_queue.write.store(0, std::memory_order_release);
  impl_->processor_queue.read.store(0, std::memory_order_release);
  impl_->processor_queue.write.store(0, std::memory_order_release);
  impl_->processor_ramp_count = 0;
  return true;
}

bool AudioHost::PrepareAndPublishGraph(const std::uint32_t revision, const std::span<const std::uint8_t> snapshot) {
  const auto prepared = PrepareGraphRevision(revision, snapshot);
  if (prepared.code != GraphRevisionStatusCode::kPrepared) return false;
  const auto published = PublishGraphRevision(revision);
  if (published.code != GraphRevisionStatusCode::kPublished) {
    const auto reconciled = InspectGraphRevision(revision);
    if (reconciled.code == GraphRevisionStatusCode::kPrepared)
      static_cast<void>(RollbackGraphRevision(revision));
    return false;
  }
  if (published.retired_revision != 0) {
    const auto retired = RetireGraphRevision(published.retired_revision);
    if (retired.code != GraphRevisionStatusCode::kRetired) return false;
  }
  return true;
}

GraphRevisionStatus AudioHost::PrepareGraphRevision(
  const std::uint32_t revision,
  const std::span<const std::uint8_t> snapshot,
  const std::uint64_t requested_frame
) {
  impl_->Evidence("graph-prepare", "", revision);
  const auto status = [this, revision](const GraphRevisionStatusCode code) {
    return impl_->GraphStatus(code, revision);
  };
  if (impl_->active_core.load(std::memory_order_acquire) == 0 || revision == 0
    || snapshot.size() <= kNativeGraphFrameHeaderBytes || snapshot.size() > kMaximumControlPayloadBytes) {
    return status(GraphRevisionStatusCode::kInvalidRevision);
  }
  // Existing pending code: admission is retryable, not a failed preparation.
  if (impl_->LatencyTransitionPending()) return status(GraphRevisionStatusCode::kPublishPending);
  if (impl_->publication_in_flight != 0) return status(GraphRevisionStatusCode::kPublishPending);
  if (requested_frame != 0) {
    const auto progress = static_cast<std::uint64_t>(impl_->applied_transport_frame.load(std::memory_order_acquire));
    if (requested_frame > INT64_MAX - impl_->config.max_frames_per_block
      || requested_frame <= progress || (requested_frame - progress) % impl_->config.max_frames_per_block != 0)
      return status(GraphRevisionStatusCode::kInvalidRevision);
  }
  if (impl_->prepared_core != 0
    || revision <= impl_->last_graph_revision.load(std::memory_order_acquire)) {
    return status(GraphRevisionStatusCode::kStaleRevision);
  }
  // Accepted controls still belong to the active graph. Let callbacks consume
  // them before preparing, without rejecting the user's newer graph as stale.
  if (impl_->HasQueuedGraphControl()) return status(GraphRevisionStatusCode::kPublishPending);
  // Preparing copies the published plan the claimed patch is still mutating. The claim
  // lasts until its resolution has been reported.
  if (impl_->claimed_processor_patch.Pending(impl_->processor_patch_reported_token)) {
    return status(GraphRevisionStatusCode::kPrepareFailed);
  }
  const std::uint64_t framed_revision = (static_cast<std::uint64_t>(snapshot[0]) << 56U)
    | (static_cast<std::uint64_t>(snapshot[1]) << 48U)
    | (static_cast<std::uint64_t>(snapshot[2]) << 40U)
    | (static_cast<std::uint64_t>(snapshot[3]) << 32U)
    | (static_cast<std::uint64_t>(snapshot[4]) << 24U)
    | (static_cast<std::uint64_t>(snapshot[5]) << 16U)
    | (static_cast<std::uint64_t>(snapshot[6]) << 8U)
    | static_cast<std::uint64_t>(snapshot[7]);
  const std::uint32_t payload_size = ReadU32(snapshot.data() + 8);
  if (framed_revision != revision || framed_revision > std::numeric_limits<std::uint32_t>::max()
    || payload_size != snapshot.size() - kNativeGraphFrameHeaderBytes) {
    return status(GraphRevisionStatusCode::kInvalidRevision);
  }
  const auto payload = snapshot.subspan(kNativeGraphFrameHeaderBytes);
  // The last invariant of capture-bound routing, checked before anything is prepared or reclaimed: a take bound to
  // node X records X's signal through its output, group and send chain, so no revision may remove or reroute it.
  auto routing = ParsePlanRouting(payload);
  if (const auto target = impl_->CaptureTarget();
    target && (!impl_->published_routing || !routing || !CaptureTargetKept(*impl_->published_routing, *routing, *target))) {
    return status(GraphRevisionStatusCode::kCaptureTargetLocked);
  }
  // Control-thread reclamation only. A completed predecessor must not make a
  // newer edit stale; an unfinished reader/transition keeps admission retryable.
  if (impl_->HasRetiredPlan()
    && RetireGraphRevision(impl_->retired_revision.load(std::memory_order_acquire)).code
      != GraphRevisionStatusCode::kRetired) {
    return status(GraphRevisionStatusCode::kPublishPending);
  }
  impl_->prepared_instrument_assets = impl_->published_instrument_assets;
  // Graph envelopes have already been validated below before publication.
  // Drop removed nodes from the next bank without releasing their resident data.
  if (payload.size() >= 24) {
    std::unordered_set<std::uint64_t> nodes;
    const auto node_bytes = GraphNodeBytes(ReadLeU32(payload.data()));
    const auto node_count = ReadLeU32(payload.data() + 8);
    if (node_count <= 64 && payload.size() >= 24 + static_cast<std::size_t>(node_count) * node_bytes) {
      for (unsigned index = 0; index < node_count; ++index) {
        const auto* node = payload.data() + 24 + index * node_bytes;
        if (ReadLeU32(node + 8) != 2) continue;
        const auto id = ReadLeU64(node);
        nodes.insert(id);
        if (ReadLeU32(node + node_bytes - 104) == DAW_AUDIO_INSTRUMENT_KIND_SYNTH) {
          const auto found = impl_->prepared_instrument_assets.find(id);
          if (found != impl_->prepared_instrument_assets.end()) found->second.clear();
        }
      }
      std::erase_if(impl_->prepared_instrument_assets, [&](const auto& entry) { return !nodes.contains(entry.first); });
    }
  }
  const daw_audio_core_handle prepared_core = impl_->active_core.load(std::memory_order_acquire);
  const auto prepare_result = daw_audio_core_prepare_graph_bytes(
    prepared_core, payload.data(), static_cast<std::uint32_t>(payload.size()));
  if (prepare_result == DAW_AUDIO_CORE_LATENCY_MOVE_PENDING)
    return status(GraphRevisionStatusCode::kPublishPending);
  if (prepare_result != DAW_AUDIO_CORE_OK || daw_audio_core_prepared_graph_continuity(prepared_core) == 0) {
    // Capacity/trust/malformed-plan failures leave ongoing audio alone. Native
    // latency edits never select a cold core or portable continuity fallback.
    if (prepare_result == DAW_AUDIO_CORE_OK)
      static_cast<void>(daw_audio_core_cancel_prepared_graph(prepared_core, revision));
    impl_->prepared_continuity = GraphRevisionContinuity::kRejected;
    LogGraphPrepareFailure(revision, prepare_result, prepared_core);
    auto rejected = status(GraphRevisionStatusCode::kPrepareFailed);
    rejected.diagnostic_code = daw_audio_core_get_graph_validation_diagnostic(prepared_core).code;
    return rejected;
  }
  impl_->requested_publication_frame = requested_frame;
  impl_->prepared_transport_context.reset();
  impl_->prepared_transport_epoch = impl_->transport_epoch.load(std::memory_order_acquire);
  impl_->ResetPreparedSchedule(revision, impl_->prepared_transport_epoch, requested_frame);
  impl_->publication_rebase_required.store(false);
  impl_->prepared_instruments_ready = false;
  impl_->prepared_continuity = GraphRevisionContinuity::kAccepted;
  const auto discard_prepared = [&] {
    static_cast<void>(daw_audio_core_cancel_prepared_graph(prepared_core, revision));
    impl_->prepared_asset_handles.clear();
  };
  auto& candidate_lookup = impl_->observation_lookups[
    1U - impl_->active_observation_lookup.load(std::memory_order_acquire)];
  candidate_lookup = {};
  impl_->prepared_instrument_targets.clear();
  if (payload.size() >= 24) {
    const auto envelope_version = ReadLeU32(payload.data());
    const auto node_count = ReadLeU32(payload.data() + 8);
    const auto node_bytes = GraphNodeBytes(envelope_version);
    if ((envelope_version == DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION
      || envelope_version == DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION_EXTERNAL_LATENCY
      || envelope_version == DAW_AUDIO_CORE_NATIVE_GRAPH_ENVELOPE_VERSION_KEEP_LATENCY)
      && node_count <= 64
      && payload.size() >= 24 + static_cast<std::size_t>(node_count) * node_bytes) {
      candidate_lookup.node_count = node_count;
      for (std::uint32_t index = 0; index < node_count; ++index) {
        candidate_lookup.node_ids[index] = ReadLeU64(payload.data() + 24 + static_cast<std::size_t>(index) * node_bytes);
        const auto* node = payload.data() + 24 + static_cast<std::size_t>(index) * node_bytes;
        if (ReadLeU32(node + 8) == 2) {  // Graph-envelope instrument tag, not C ABI enum.
          const auto* instrument = node + node_bytes - 104;
          daw_audio_instrument_state_descriptor descriptor{.kind = ReadLeU32(instrument),
            .version = ReadLeU32(instrument + 4), .voice_capacity = ReadLeU32(instrument + 8),
            .parameter_count = ReadLeU32(instrument + 12)};
          for (std::size_t parameter = 0; parameter < descriptor.parameter_count; ++parameter)
            descriptor.parameter_targets[parameter] = ReadLeU32(instrument + 16 + parameter * 4);
          impl_->prepared_instrument_targets.emplace(candidate_lookup.node_ids[index], descriptor);
        }
      }
    }
  }
  if (!impl_->RegisterPreparedGraphHooks(prepared_core, revision)) {
    impl_->prepared_continuity = GraphRevisionContinuity::kRejected;
    discard_prepared();
    return status(GraphRevisionStatusCode::kPrepareFailed);
  }
  impl_->prepared_core = prepared_core;
  impl_->prepared_core_is_same_core = true;
  impl_->prepared_revision.store(revision, std::memory_order_release);
  impl_->prepared_routing = std::move(routing);
  return status(GraphRevisionStatusCode::kPrepared);
}

bool AudioHost::ConfigureInstrumentStates(const std::span<const std::uint8_t> payload) {
  impl_->instrument_preparation_error = "invalid instrument state payload";
  if (impl_->publication_in_flight != 0) {
    impl_->instrument_preparation_error = "graph publication is still pending";
    return false;
  }
  const daw_audio_core_handle target_core = impl_->prepared_core != 0
    ? impl_->prepared_core
    : impl_->active_core.load(std::memory_order_acquire);
  if (target_core == 0) {
    impl_->instrument_preparation_error = "audio session is unavailable";
    return false;
  }
  if (payload.size() < 4) return false;
  const std::uint32_t count = ReadLeU32(payload.data());
  if (count > 64) return false;
  if (count == 0 && payload.size() == 4) {
    impl_->instrument_preparation_error = {};
    impl_->prepared_instruments_ready = std::all_of(impl_->prepared_instrument_targets.begin(),
      impl_->prepared_instrument_targets.end(), [this](auto node) {
        return impl_->prepared_instrument_assets.contains(node.first);
      });
    return true;
  }
#if defined(DAW_AUDIO_HOST_TEST_MEMORY_LOCK)
  daw_audio_host_test_validation_memory(true);
#endif
  std::unordered_set<Impl::InstalledAsset*> candidates;
  Impl::InstrumentAssets configured_assets;
  const auto configure = [&](const daw_audio_core_handle core, const bool validate) {
    std::size_t offset = 4;
    for (std::uint32_t index = 0; index < count; ++index) {
      std::unordered_set<Impl::InstalledAsset*> device_assets;
      std::uint64_t device_bytes = 0;
      const auto admit = [&](daw_audio_asset_handle& handle) {
        if (handle == 0) return true;
        // Instrument wire references encode generation 1 + the session asset ID,
        // not the core slot/generation, which depends on installation and reuse.
        const auto id = static_cast<std::uint32_t>(handle);
        const auto found = impl_->assets.find(id);
        if ((handle >> 32U) != 1 || found == impl_->assets.end()) {
          impl_->instrument_preparation_error = "instrument sample session asset is not installed";
          return false;
        }
        auto* asset = &found->second;
        if (!impl_->AssetVisible(*asset, impl_->prepared_core != 0
          ? impl_->prepared_revision.load(std::memory_order_acquire)
          : impl_->active_revision.load(std::memory_order_acquire))) return false;
        impl_->RetainAsset(*asset);
        const auto prepared = impl_->prepared_asset_handles.find(id);
        handle = prepared == impl_->prepared_asset_handles.end() ? asset->handle : prepared->second;
        if (!validate) return true;
        if (device_assets.insert(asset).second) {
          device_bytes += asset->frame_count * asset->channel_count * sizeof(float);
          if (device_bytes > kInstrumentDeviceBytes) {
            impl_->instrument_preparation_error = "sample memory budget exceeded (1 GiB per device)";
            return false;
          }
        }
        candidates.insert(asset);
        if (asset->mapped) {
          const auto& ranges = asset->mapped->written_ranges;
          if (ranges.size() != 1 || ranges.front().first != 0 || ranges.front().second != asset->frame_count) {
            impl_->instrument_preparation_error = "sample upload incomplete; retry loading the sample";
            return false;
          }
        }
        return true;
      };
      if (payload.size() - offset < 24) return false;
      const std::uint64_t node_id = ReadLeU64(payload.data() + offset);
      const std::uint32_t kind = ReadLeU32(payload.data() + offset + 8);
      const std::uint32_t state_size = ReadLeU32(payload.data() + offset + 12);
      const std::uint32_t zones_size = ReadLeU32(payload.data() + offset + 16);
      offset += 24;
      if (state_size > kMaximumControlPayloadBytes || zones_size > kMaximumControlPayloadBytes
        || payload.size() - offset < static_cast<std::size_t>(state_size) + zones_size) return false;
      const auto* state_bytes = payload.data() + offset;
      offset += state_size;
      const auto* zones_bytes = payload.data() + offset;
      offset += zones_size;
      daw_audio_core_result result = DAW_AUDIO_CORE_INVALID_ARGUMENT;
      if (kind == 1 && zones_size == 0) {
        daw_audio_synth_state state{};
        if (daw::audio_core_wire::DecodeSynthState(
          std::span<const std::uint8_t>(state_bytes, state_size), &state)) {
          result = validate
            ? (daw::audio_core::ValidateInstrumentState(core, node_id, state)
              ? DAW_AUDIO_CORE_OK : DAW_AUDIO_CORE_INVALID_ARGUMENT)
            : daw_audio_core_configure_synth(core, node_id, &state);
        }
      } else if ((kind == 2 || kind == 3)
        && zones_size <= kMaximumControlPayloadBytes) {
        daw_audio_sampler_state state{};
        if (!daw::audio_core_wire::DecodeSamplerState(
          std::span<const std::uint8_t>(state_bytes, state_size), &state)
          || state.zone_count > DAW_AUDIO_CORE_MAX_SAMPLE_ZONES
          || zones_size != static_cast<std::size_t>(state.zone_count)
            * daw::audio_core_wire::kSampleZoneBytes) {
          return false;
        }
        std::array<daw_audio_sample_zone, DAW_AUDIO_CORE_MAX_SAMPLE_ZONES> zones{};
        bool decoded = true;
        for (std::uint32_t zone = 0; zone < state.zone_count; ++zone) {
          decoded = daw::audio_core_wire::DecodeSampleZone(
            std::span<const std::uint8_t>(
              zones_bytes + static_cast<std::size_t>(zone) * daw::audio_core_wire::kSampleZoneBytes,
              daw::audio_core_wire::kSampleZoneBytes
            ),
            &zones[zone]
          );
          if (!decoded) break;
          if (!admit(zones[zone].asset)) return false;
        }
        if (decoded) {
          result = validate
            ? (daw::audio_core::ValidateInstrumentState(core, node_id, kind, state,
                std::span(zones).first(state.zone_count))
              ? DAW_AUDIO_CORE_OK : DAW_AUDIO_CORE_INVALID_ARGUMENT)
            : daw_audio_core_configure_sampler(
                core, node_id, &state, state.zone_count == 0 ? nullptr : zones.data());
        }
      } else if (kind == 4 && state_size == kGranularStateWireBytes && zones_size == 0) {
        daw_audio_granular_state state{};
        state.version = ReadLeU32(state_bytes);
        state.asset = ReadLeU64(state_bytes + 4);
        state.seed = ReadLeU32(state_bytes + 12);
        state.max_grains = ReadLeU32(state_bytes + 16);
        state.window_shape = ReadLeU32(state_bytes + 20);
        state.freeze = ReadLeU32(state_bytes + 24);
        state.grain_size_ms = ReadLeFloat(state_bytes + 28);
        state.density_hz = ReadLeFloat(state_bytes + 32);
        state.position = ReadLeFloat(state_bytes + 36);
        state.spray = ReadLeFloat(state_bytes + 40);
        state.pitch_semitones = ReadLeFloat(state_bytes + 44);
        state.reverse_probability = ReadLeFloat(state_bytes + 48);
        state.stereo_spread = ReadLeFloat(state_bytes + 52);
        if (!admit(state.asset)) return false;
        result = validate
          ? (daw::audio_core::ValidateInstrumentState(core, node_id, state)
            ? DAW_AUDIO_CORE_OK : DAW_AUDIO_CORE_INVALID_ARGUMENT)
          : daw_audio_core_configure_granular(core, node_id, &state);
      }
      if (result != DAW_AUDIO_CORE_OK) {
        if (result == DAW_AUDIO_CORE_CAPACITY_EXCEEDED)
          impl_->instrument_preparation_error = "instrument replacement capacity exceeded; let audio transitions finish, then prepare and retry";
        else
          impl_->instrument_preparation_error = "instrument parameters, sample zone bounds, or graph target are invalid";
        return false;
      }
      if (validate) configured_assets[node_id] = std::move(device_assets);
    }
    return offset == payload.size();
  };
  // Validate the entire candidate batch with the core's authoritative validators
  // before locking memory or changing any live/prepared instrument configuration.
  if (!configure(target_core, true)) return false;
#if defined(DAW_AUDIO_HOST_TEST_MEMORY_LOCK)
  daw_audio_host_test_validation_memory(false);
#endif
  std::vector<Impl::InstalledAsset::MappedStorage*> newly_locked;
  newly_locked.reserve(candidates.size());
  const auto rollback = [&] {
    for (auto* mapped : newly_locked) mapped->Unlock();
  };
  if (impl_->config.device_uid != "offline:render") {
    const auto page_size = static_cast<std::size_t>(getpagesize());
    auto admitted_bytes = instrumentLockedBytes();
    for (auto* asset : candidates) {
      if (!asset->mapped) continue;
      auto& mapped = *asset->mapped;
      if (mapped.locked_bytes != 0) continue;
      const auto bytes = (mapped.byte_length + page_size - 1) / page_size * page_size;
      if (admitted_bytes > impl_->instrument_resident_budget
        || bytes > impl_->instrument_resident_budget - admitted_bytes) {
        impl_->instrument_preparation_error = "sample memory budget exceeded; release unused samples and retry";
        return false;
      }
      admitted_bytes += bytes;
    }
    for (auto* asset : candidates) {
      if (!asset->mapped) continue;
      auto& mapped = *asset->mapped;
      if (mapped.locked_bytes != 0) continue;
      const auto bytes = (mapped.byte_length + page_size - 1) / page_size * page_size;
      if (!LockInstrumentMemory(mapped.address, bytes)) {
        // POSIX does not promise an unsuccessful lock left every page unlocked.
        munlock(mapped.address, bytes);
        rollback();
        impl_->instrument_preparation_error = "memory locking unavailable; release unused samples or restart the audio host and retry";
        return false;
      }
      mapped.locked_bytes = bytes;
      newly_locked.push_back(&mapped);
    }
  }
  if (!configure(target_core, false)) {
    // Valid states can still exhaust prepared runtime/blend capacity. Cancel the
    // entire unpublished bank before unlocking newly acquired sample memory.
    if (impl_->prepared_core != 0) {
      RollbackGraphRevision(impl_->prepared_revision.load(std::memory_order_acquire));
      rollback();
    } else {
      // Active-core setters update existing runtime directly, without capacity
      // admission. Retain owners conservatively if a future setter can fail here;
      // unlike an unpublished bank, this path has no cancel API.
      for (const auto& [node, assets] : configured_assets) {
        auto& retained = impl_->published_instrument_assets[node];
        retained.insert(assets.begin(), assets.end());
      }
      for (auto* asset : candidates) if (asset->mapped) asset->mapped->instrument_published = true;
    }
    return false;
  }
  for (auto* asset : candidates) if (asset->mapped) asset->mapped->instrument_published = true;
  auto& retained = impl_->prepared_core != 0 ? impl_->prepared_instrument_assets : impl_->published_instrument_assets;
  for (auto& [node, assets] : configured_assets) retained[node] = std::move(assets);
  impl_->instrument_preparation_error = {};
  impl_->prepared_instruments_ready = std::all_of(impl_->prepared_instrument_targets.begin(),
    impl_->prepared_instrument_targets.end(), [this](auto node) {
      return impl_->prepared_instrument_assets.contains(node.first);
    });
  return true;
}

std::uint64_t AudioHost::instrumentLockedBytes() const {
  std::uint64_t bytes = 0;
  for (const auto& [id, asset] : impl_->assets) {
    static_cast<void>(id);
    if (asset.mapped) bytes += asset.mapped->locked_bytes;
  }
  return bytes;
}

std::uint64_t AudioHost::instrumentResidentBudgetBytes() const { return impl_->instrument_resident_budget; }
std::string_view AudioHost::instrumentPreparationError() const { return impl_->instrument_preparation_error; }
bool AudioHost::HasAudioCore() const {
  return impl_->prepared_core != 0 || impl_->active_core.load(std::memory_order_acquire) != 0;
}

GraphRevisionStatus AudioHost::PublishGraphRevision(const std::uint32_t revision, const std::uint64_t requested_frame) {
  impl_->Evidence("graph-publish-request", "", revision);
  const auto status = [this, revision](const GraphRevisionStatusCode code) {
    return impl_->GraphStatus(code, revision);
  };
  if (impl_->publication_in_flight != 0)
    return status(GraphRevisionStatusCode::kPublishPending);
  if (impl_->LatencyTransitionPending()) return status(GraphRevisionStatusCode::kPublishPending);
  if (revision == 0 || impl_->prepared_core == 0
    || impl_->prepared_revision.load(std::memory_order_acquire) != revision) {
    return status(GraphRevisionStatusCode::kStaleRevision);
  }
  const auto progress = static_cast<std::uint64_t>(impl_->applied_transport_frame.load(std::memory_order_acquire));
  if (requested_frame != 0 && requested_frame != impl_->requested_publication_frame) {
    if (requested_frame > INT64_MAX - impl_->config.max_frames_per_block
      || requested_frame <= progress || (requested_frame - progress) % impl_->config.max_frames_per_block != 0)
      return status(GraphRevisionStatusCode::kInvalidRevision);
    // Rebase discards only the entire unpublished schedule bank, including
    // partial chunks and duplicate digests. The prepared graph/config stay.
    impl_->requested_publication_frame = requested_frame;
    impl_->prepared_transport_epoch = impl_->transport_epoch.load(std::memory_order_acquire);
    impl_->ResetPreparedSchedule(revision, impl_->prepared_transport_epoch, requested_frame);
    impl_->publication_rebase_required.store(false, std::memory_order_release);
    return status(GraphRevisionStatusCode::kPrepared);
  }
  if (impl_->requested_publication_frame != 0) {
    const auto frame = impl_->requested_publication_frame.load(std::memory_order_acquire);
    if (impl_->prepared_transport_epoch != impl_->transport_epoch.load(std::memory_order_acquire)
      || frame <= static_cast<std::uint64_t>(impl_->applied_transport_frame.load(std::memory_order_acquire))) {
      impl_->publication_rebase_required.store(true, std::memory_order_release);
      return status(GraphRevisionStatusCode::kRebaseRequired);
    }
    if (!impl_->prepared_instruments_ready
      || impl_->ActiveSchedule().accepted_schedule_epoch.load(std::memory_order_acquire) != impl_->prepared_transport_epoch
      || impl_->ActiveSchedule().accepted_schedule_through_frame.load(std::memory_order_acquire) < frame
      || impl_->PreparedSchedule().accepted_schedule_through_frame.load(std::memory_order_acquire)
        < frame + impl_->config.max_frames_per_block) return status(GraphRevisionStatusCode::kPublishPending);
    if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kRunning)
      return status(GraphRevisionStatusCode::kPublishPending);
  }
  const auto publish_at_boundary = [this, revision] {
    if (impl_->prepared_core_is_same_core) {
      if (daw_audio_core_publish(impl_->active_core.load(std::memory_order_acquire), revision) != DAW_AUDIO_CORE_OK) {
        return false;
      }
      impl_->ReconcileScheduledTargets(impl_->active_core.load(std::memory_order_acquire),
        impl_->active_revision.load(std::memory_order_acquire), revision);
      impl_->PromoteObservationLookup();
      impl_->RetireSameCorePlan(impl_->active_revision.exchange(revision, std::memory_order_acq_rel));
      impl_->prepared_core = 0;
      impl_->prepared_core_is_same_core = false;
      impl_->prepared_revision.store(0, std::memory_order_release);
      impl_->last_graph_revision.store(revision, std::memory_order_release);
      impl_->graph_prepared = true;
      impl_->AdoptPublishedNativeVsts();
      impl_->AdoptPublishedRouting();
      return true;
    }
    if (daw_audio_core_publish(impl_->prepared_core, revision) != DAW_AUDIO_CORE_OK) return false;
    impl_->PromoteObservationLookup();
    const daw_audio_core_handle previous_core = impl_->active_core.exchange(impl_->prepared_core, std::memory_order_acq_rel);
    const std::uint32_t previous_revision = impl_->active_revision.exchange(revision, std::memory_order_acq_rel);
    impl_->prepared_core = 0;
    impl_->prepared_revision.store(0, std::memory_order_release);
    impl_->retired_core = previous_core;
    impl_->retired_revision.store(previous_revision, std::memory_order_release);
    impl_->retired_after_epoch.store(impl_->completed_render_epoch.load(std::memory_order_acquire), std::memory_order_release);
    impl_->last_graph_revision.store(revision, std::memory_order_release);
    impl_->graph_prepared = true;
    impl_->AdoptPublishedNativeVsts();
    impl_->AdoptPublishedRouting();
    return true;
  };
  const auto publish_asset_handles = [this] {
    impl_->PromoteAssets(impl_->active_revision.load(std::memory_order_acquire));
    impl_->published_instrument_assets = std::move(impl_->prepared_instrument_assets);
    for (const auto& [asset_id, handle] : impl_->prepared_asset_handles) {
      const auto asset = impl_->assets.find(asset_id);
      if (asset != impl_->assets.end()) asset->second.handle = handle;
    }
    impl_->prepared_asset_handles.clear();
  };
  if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kRunning) {
    const bool replacing_graph = impl_->graph_prepared;
    if (!publish_at_boundary()) return status(GraphRevisionStatusCode::kPublishFailed);
    publish_asset_handles();
    if (!replacing_graph) {
      daw_audio_core_destroy(impl_->retired_core);
      impl_->retired_core = 0;
      impl_->retired_same_core = false;
      impl_->retired_revision.store(0, std::memory_order_release);
    }
    impl_->acceptance_publication_frame.store(impl_->applied_transport_frame.load());
    impl_->acceptance_publication_epoch.store(impl_->completed_render_epoch.load());
    impl_->RecordPublicationLatency();
    impl_->PublicationEvidence("configured-boundary");
    return status(GraphRevisionStatusCode::kPublished);
  }
  impl_->publish_acknowledged_revision.store(0, std::memory_order_release);
  impl_->publish_deferred_revision.store(0, std::memory_order_release);
  impl_->publication_in_flight = revision;
  impl_->publish_requested_revision.store(revision, std::memory_order_release);
  // Callback ownership is reconciled by inspection, never by a control wait.
  return status(GraphRevisionStatusCode::kPublishPending);
}

GraphRevisionStatus AudioHost::InspectGraphRevision(const std::uint32_t revision) {
  impl_->ReclaimAssets();
  if (impl_->publication_in_flight != 0
    && impl_->publish_deferred_revision.load(std::memory_order_acquire) == impl_->publication_in_flight) {
    impl_->publication_in_flight = 0;
    impl_->schedule_owner.store(0, std::memory_order_release);
  }
  if (impl_->publication_in_flight != 0) {
    if (impl_->publish_acknowledged_revision.load(std::memory_order_acquire) != impl_->publication_in_flight)
      return impl_->GraphStatus(GraphRevisionStatusCode::kPublishPending, revision);
    if (impl_->active_revision.load(std::memory_order_acquire) == impl_->publication_in_flight) {
      impl_->PromoteAssets(impl_->publication_in_flight);
      // Finalize only the acknowledged publication, not a newer prepared bank
      // when an ordinary status read names the still-active older revision.
      for (const auto& [asset_id, handle] : impl_->prepared_asset_handles) {
        const auto asset = impl_->assets.find(asset_id);
        if (asset != impl_->assets.end()) asset->second.handle = handle;
      }
      impl_->prepared_asset_handles.clear();
      impl_->published_instrument_assets = std::move(impl_->prepared_instrument_assets);
      impl_->graph_prepared = true;
      impl_->AdoptPublishedNativeVsts();
      impl_->AdoptPublishedRouting();
    } else {
      impl_->publication_in_flight = 0;
      impl_->schedule_owner.store(0, std::memory_order_release);
      return impl_->GraphStatus(GraphRevisionStatusCode::kPublishFailed, revision);
    }
    impl_->publication_in_flight = 0;
    impl_->schedule_owner.store(0, std::memory_order_release);
  }
  if (revision != 0 && impl_->active_revision.load(std::memory_order_acquire) == revision) {
    return impl_->GraphStatus(GraphRevisionStatusCode::kPublished, revision);
  }
  if (impl_->prepared_core != 0 && impl_->requested_publication_frame != 0
    && (impl_->publication_rebase_required.load(std::memory_order_acquire)
      || static_cast<std::uint64_t>(impl_->applied_transport_frame.load(std::memory_order_acquire))
        > impl_->requested_publication_frame))
    return impl_->GraphStatus(GraphRevisionStatusCode::kRebaseRequired, revision);
  if (impl_->LatencyTransitionPending())
    return impl_->GraphStatus(GraphRevisionStatusCode::kPublishPending, revision);
  if (revision > impl_->last_graph_revision.load(std::memory_order_acquire)
    && impl_->prepared_core == 0 && impl_->HasQueuedGraphControl())
    return impl_->GraphStatus(GraphRevisionStatusCode::kPublishPending, revision);
  return impl_->GraphStatus(
    revision != 0 && impl_->prepared_revision.load(std::memory_order_acquire) == revision
      ? GraphRevisionStatusCode::kPrepared : GraphRevisionStatusCode::kStaleRevision, revision);
}

GraphRevisionStatus AudioHost::RollbackGraphRevision(const std::uint32_t revision) {
  if (impl_->publication_in_flight != 0)
    return impl_->GraphStatus(GraphRevisionStatusCode::kPublishPending, revision);
  const auto code = revision != 0 && impl_->prepared_core != 0
    && impl_->prepared_revision.load(std::memory_order_acquire) == revision
    ? GraphRevisionStatusCode::kRolledBack
    : GraphRevisionStatusCode::kStaleRevision;
  if (code == GraphRevisionStatusCode::kRolledBack) {
    impl_->prepared_transport_context.reset();
    impl_->ResetPreparedSchedule(0, 0, 0);
    if (impl_->prepared_core_is_same_core) {
      static_cast<void>(daw_audio_core_cancel_prepared_graph(impl_->prepared_core, revision));
    } else {
      daw_audio_core_destroy(impl_->prepared_core);
    }
    impl_->prepared_core = 0;
    impl_->prepared_core_is_same_core = false;
    impl_->prepared_revision.store(0, std::memory_order_release);
    impl_->prepared_asset_handles.clear();
    impl_->prepared_instrument_assets.clear();
    impl_->prepared_routing.reset();
    impl_->RollbackStagedNativeVsts();
    for (auto& [id, asset] : impl_->assets) {
      static_cast<void>(id);
      if (asset.staged_revision == revision) {
        asset.release_requested = true;
        impl_->asset_retirement_pending.store(true, std::memory_order_release);
      }
    }
  }
  return {
    .code = code,
    .requested_revision = revision,
    .active_revision = impl_->active_revision.load(std::memory_order_acquire),
    .prepared_revision = impl_->prepared_revision.load(std::memory_order_acquire),
    .retired_revision = impl_->retired_revision.load(std::memory_order_acquire),
    .render_epoch = impl_->completed_render_epoch.load(std::memory_order_acquire),
    .publication_frame = impl_->acceptance_publication_frame.load(std::memory_order_acquire),
    .requested_publication_frame = impl_->requested_publication_frame.load(std::memory_order_acquire),
    .progress_frame = static_cast<std::uint64_t>(impl_->applied_transport_frame.load(std::memory_order_acquire)),
    .transport_epoch = impl_->transport_epoch.load(std::memory_order_acquire),
  };
}

GraphRevisionStatus AudioHost::RetireGraphRevision(const std::uint32_t revision) {
  if (impl_->publication_in_flight != 0)
    return impl_->GraphStatus(GraphRevisionStatusCode::kPublishPending, revision);
  impl_->Evidence("graph-retire-request", "", revision);
  GraphRevisionStatusCode code = GraphRevisionStatusCode::kStaleRevision;
  if (revision != 0 && impl_->HasRetiredPlan()
    && impl_->retired_revision.load(std::memory_order_acquire) == revision) {
    if (impl_->LatencyTransitionPending())
      return impl_->GraphStatus(GraphRevisionStatusCode::kRetirementNotSafe, revision);
    if (impl_->completed_render_epoch.load(std::memory_order_acquire)
      < impl_->retired_after_epoch.load(std::memory_order_acquire)) {
      code = GraphRevisionStatusCode::kRetirementNotSafe;
    } else {
      if (impl_->retired_core != 0) daw_audio_core_destroy(impl_->retired_core);
      else daw_audio_core_reclaim_retired_runtime(impl_->active_core.load(std::memory_order_acquire));
      impl_->retired_core = 0;
      impl_->retired_same_core = false;
      impl_->retired_revision.store(0, std::memory_order_release);
      code = GraphRevisionStatusCode::kRetired;
      impl_->Evidence("graph-retire");
      impl_->ReclaimAssets();
    }
  }
  return {
    .code = code,
    .requested_revision = revision,
    .active_revision = impl_->active_revision.load(std::memory_order_acquire),
    .prepared_revision = impl_->prepared_revision.load(std::memory_order_acquire),
    .retired_revision = impl_->retired_revision.load(std::memory_order_acquire),
    .render_epoch = impl_->completed_render_epoch.load(std::memory_order_acquire),
    .publication_frame = impl_->acceptance_publication_frame.load(std::memory_order_acquire),
    .requested_publication_frame = impl_->requested_publication_frame.load(std::memory_order_acquire),
    .progress_frame = static_cast<std::uint64_t>(impl_->applied_transport_frame.load(std::memory_order_acquire)),
    .transport_epoch = impl_->transport_epoch.load(std::memory_order_acquire),
  };
}

bool AudioHost::QueueParameterEvents(const std::span<const std::uint8_t> payload) {
  Impl::ControlSubmissionClaim claim{impl_->schedule_owner};
  if (!claim.acquired) return false;
  if (payload.size() < 4) return false;
  const std::uint32_t count = ReadLeU32(payload.data());
  const bool has_batch = payload.size() == 20 + static_cast<std::size_t>(count) * 20;
  if (count == 0 && has_batch) return false;
  if (count > DAW_AUDIO_CORE_MAX_PROCESSOR_EVENTS
    || (!has_batch && payload.size() != 4 + static_cast<std::size_t>(count) * 20)) return false;
  const auto batch_revision = has_batch ? ReadLeU32(payload.data() + 4) : 0;
  const auto batch_epoch = has_batch ? ReadLeU32(payload.data() + 8) : 0;
  const auto batch_sequence = has_batch ? ReadLeU64(payload.data() + 12) : 0;
  if (has_batch && (batch_revision == 0 || batch_epoch == 0 || batch_sequence == 0
    || batch_revision != impl_->active_revision.load(std::memory_order_acquire)
    || batch_epoch != impl_->transport_epoch.load(std::memory_order_acquire))) return false;
  // All-or-nothing: every event is validated before capacity, before the sequence is
  // consumed and before anything is enqueued, so a refused batch leaves no trace.
  const std::size_t offset = has_batch ? 20 : 4;
  std::array<Impl::QueuedControlEvent, DAW_AUDIO_CORE_MAX_PROCESSOR_EVENTS> validated{};
  for (std::uint32_t index = 0; index < count; ++index) {
    const auto* bytes = payload.data() + offset + index * 20;
    if (ReadLeU64(bytes) == 0
      || ReadLeU32(bytes + 8) == 0
      || ReadLeU32(bytes + 12) >= impl_->config.max_frames_per_block
      || !std::isfinite(ReadLeFloat(bytes + 16))) return false;
    auto& event = validated[index];
    event.kind = Impl::QueuedControlKind::kProcessor;
    event.processor_revision = batch_revision;
    event.processor_epoch = batch_epoch;
    event.processor_sequence = batch_sequence;
    event.processor = {.processor_instance_id = ReadLeU64(bytes), .parameter_target = ReadLeU32(bytes + 8),
      .frame_offset = ReadLeU32(bytes + 12), .value = ReadLeFloat(bytes + 16)};
  }
  if (!impl_->HasCapacity(Impl::QueuedControlKind::kProcessor, count)) return false;
  if (has_batch) {
    auto last_sequence = impl_->last_queued_processor_sequence.load(std::memory_order_acquire);
    while (batch_sequence > last_sequence
      && !impl_->last_queued_processor_sequence.compare_exchange_weak(
        last_sequence, batch_sequence, std::memory_order_acq_rel, std::memory_order_acquire)) {}
    if (batch_sequence <= last_sequence) return false;
  }
  for (std::uint32_t index = 0; index < count; ++index) {
    if (!impl_->EnqueueControlEvent(validated[index])) return false;
  }
  return true;
}

#if defined(DAW_AUDIO_HOST_TEST_PATCH_CLAIM) && DAW_AUDIO_HOST_TEST_PATCH_CLAIM == 1
void SetTestPatchClaimHook(void (*const hook)()) {
  test_patch_claim_hook.store(hook, std::memory_order_release);
}

void SetTestPatchAckHook(void (*const hook)(std::uint64_t, std::uint32_t)) {
  test_patch_ack_hook.store(hook, std::memory_order_release);
}

void SetTestPatchClaimHold(const bool hold) {
  test_patch_claim_hold.store(hold, std::memory_order_release);
}

void SetTestPatchClaimDiscard(const bool discard) {
  test_patch_claim_discard.store(discard, std::memory_order_release);
}

void AudioHostTestAccess::UseNoPluginWorkers(const bool use) {
  test_no_plugin_workers.store(use, std::memory_order_release);
}

void AudioHostTestAccess::SetParkedAge(AudioHost& host, const std::chrono::milliseconds age) {
  host.impl_->parked_age = age;
}

void AudioHostTestAccess::UseWorkerExecutable(std::string path) {
  test_worker_executable = std::move(path);
}

bool AudioHostTestAccess::PublishWorkerDiagnostic(
  AudioHost& host,
  const std::string_view instance_id,
  const daw::plugin_host::WorkerDiagnostic& diagnostic
) {
  const auto attachment = host.impl_->native_vst_attachments.find(std::string(instance_id));
  return attachment != host.impl_->native_vst_attachments.end()
    && attachment->second->worker.callbackPort().PublishDiagnostic(diagnostic);
}

std::uint64_t AudioHostTestAccess::WorkerGeneration(AudioHost& host, const std::string_view instance_id) {
  const auto attachment = host.impl_->native_vst_attachments.find(std::string(instance_id));
  return attachment == host.impl_->native_vst_attachments.end() ? 0 : attachment->second->worker.workerGeneration();
}

AudioHostTestAccess::Ownership AudioHostTestAccess::AttachmentOwnership(
  AudioHost& host,
  const std::string_view instance_id
) {
  const auto attachment = host.impl_->native_vst_attachments.find(std::string(instance_id));
  if (attachment == host.impl_->native_vst_attachments.end()) return Ownership::kAbsent;
  switch (attachment->second->ownership) {
    case NativeVstWorkerAttachment::Ownership::kStaged: return Ownership::kStaged;
    case NativeVstWorkerAttachment::Ownership::kActive: return Ownership::kActive;
    case NativeVstWorkerAttachment::Ownership::kParked: return Ownership::kParked;
    case NativeVstWorkerAttachment::Ownership::kRetired: return Ownership::kRetired;
  }
  return Ownership::kAbsent;
}

int AudioHostTestAccess::WorkerProcessGroup(AudioHost& host, const std::string_view instance_id) {
  const auto attachment = host.impl_->native_vst_attachments.find(std::string(instance_id));
  return attachment == host.impl_->native_vst_attachments.end() ? -1 : attachment->second->worker.workerProcessGroupId();
}
#endif

ProcessorPatchStatus AudioHost::QueueProcessorStatePatch(const std::span<const std::uint8_t> payload) {
  using Refusal = ProcessorPatchRefusal;
  const auto refused = [](const Refusal refusal, const std::uint32_t core_result = 0, const std::uint64_t token = 0) {
    return ProcessorPatchStatus{ProcessorPatchOutcome::kRefused, refusal, core_result, token};
  };
  const auto applied_or_failed = [&refused](const std::uint32_t result) {
    return result == DAW_AUDIO_CORE_OK
      ? ProcessorPatchStatus{ProcessorPatchOutcome::kApplied, Refusal::kNone, 0, 0}
      : refused(Refusal::kApplyFailed, result);
  };
  if (payload.size() < 56 || payload.size() > 512) return refused(Refusal::kInvalid);
  if (impl_->active_core.load(std::memory_order_acquire) == 0) return refused(Refusal::kUnavailable);
  if (impl_->prepared_core != 0) return refused(Refusal::kPreparing);
  if (impl_->claimed_processor_patch.Pending(impl_->processor_patch_reported_token)) {
    return refused(Refusal::kClaimPending, 0, impl_->claimed_processor_patch.Recorded());
  }
  if (ReadLeU32(payload.data()) != 1) return refused(Refusal::kInvalid);
  const std::uint32_t revision = ReadLeU32(payload.data() + 4);
  const std::uint64_t node_id = ReadLeU64(payload.data() + 8);
  const std::uint32_t instance_id = ReadLeU32(payload.data() + 16);
  const std::uint32_t kind = ReadLeU32(payload.data() + 20);
  const std::uint32_t state_version = ReadLeU32(payload.data() + 24);
  const std::uint32_t state_size = ReadLeU32(payload.data() + 28);
  const std::uint32_t bypassed = ReadLeU32(payload.data() + 32);
  const std::uint32_t input_layout = ReadLeU32(payload.data() + 36);
  const std::uint32_t output_layout = ReadLeU32(payload.data() + 40);
  const std::uint32_t parameter_count = ReadLeU32(payload.data() + 44);
  const std::uint32_t latency_frames = ReadLeU32(payload.data() + 48);
  const std::uint32_t tail_frames = ReadLeU32(payload.data() + 52);
  if (revision == 0 || node_id == 0 || instance_id == 0 || kind == 0
    || state_size > DAW_AUDIO_CORE_MAX_PROCESSOR_STATE_BYTES
    || parameter_count > DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS
    || bypassed > 1 || (input_layout != DAW_AUDIO_GRAPH_LAYOUT_MONO && input_layout != DAW_AUDIO_GRAPH_LAYOUT_STEREO)
    || (output_layout != DAW_AUDIO_GRAPH_LAYOUT_MONO && output_layout != DAW_AUDIO_GRAPH_LAYOUT_STEREO)
    || payload.size() != 56 + static_cast<std::size_t>(state_size) + static_cast<std::size_t>(parameter_count) * 4) {
    return refused(Refusal::kInvalid);
  }
  if (revision != impl_->active_revision.load(std::memory_order_acquire)) return refused(Refusal::kStaleRevision);
  std::array<std::uint32_t, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS> targets{};
  for (std::uint32_t index = 0; index < parameter_count; ++index) {
    targets[index] = ReadLeU32(payload.data() + 56 + state_size + index * 4);
  }
  const daw_audio_processor_state_patch patch{
    .graph_revision = revision,
    .node_id = node_id,
    .instance_id = instance_id,
    .kind = kind,
    .state_version = state_version,
    .state_size = state_size,
    .bypassed = bypassed,
    .input_layout = input_layout,
    .output_layout = output_layout,
    .parameter_count = parameter_count,
    .latency_frames = latency_frames,
    .tail_frames = tail_frames,
    .parameter_targets = targets.data(),
    .state = payload.data() + 56,
  };
  const daw_audio_core_handle core = impl_->active_core.load(std::memory_order_acquire);
  const auto staged = daw_audio_core_stage_processor_state_patch(core, &patch);
  if (staged != DAW_AUDIO_CORE_OK) return refused(Refusal::kStageFailed, staged);
  // A patch the core applied is the only line a state change that publishes no graph leaves, so it is the settle point.
  const auto applied_with_evidence = [&](const std::uint32_t result) {
    const auto status = applied_or_failed(result);
    if (status.outcome == ProcessorPatchOutcome::kApplied && daw::acceptance::Enabled()) {
      char detail[96];
      std::snprintf(detail, sizeof(detail), ",\"nodeId\":\"%llu\",\"instanceId\":%u,\"kind\":%u",
        static_cast<unsigned long long>(node_id), instance_id, kind);
      impl_->Evidence("processor-patch-applied", "", revision, detail);
    }
    return status;
  };
  if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kRunning) {
    return applied_with_evidence(daw_audio_core_apply_staged_processor_state_patch(core));
  }
  const std::uint64_t token = ++impl_->processor_patch_sequence;
  impl_->processor_patch_requested.store(token, std::memory_order_release);
  const auto wait = WaitForCallbackRequest(impl_->publish_wait, impl_->publish_wait_mutex,
    impl_->processor_patch_requested, impl_->processor_patch_acknowledged, token, [this] {
      return impl_->state.load(std::memory_order_acquire) != LifecycleState::kRunning;
    });
  if (wait == CallbackWait::kCancelled) {
    // The callback never claimed it, so the staged copy is still ours to discard.
    static_cast<void>(daw_audio_core_cancel_staged_processor_state_patch(core));
    return refused(Refusal::kNotClaimed);
  }
  if (wait == CallbackWait::kUnresolved) {
    // The callback owns the claimed patch and is mutating the published plan. Graph
    // and patch work are refused until its resolution has been reported.
#if defined(DAW_AUDIO_HOST_TEST_PATCH_CLAIM) && DAW_AUDIO_HOST_TEST_PATCH_CLAIM == 1
    if (const auto hook = test_patch_claim_hook.load(std::memory_order_acquire)) hook();
#endif
    impl_->claimed_processor_patch.Record(token);
    // An ack that landed before the claim was recorded still needs a frame to carry it.
    impl_->PublishScheduleProgressChange();
    impl_->Evidence("processor-patch-timeout", "callback-claimed-patch-unresolved");
    return {ProcessorPatchOutcome::kClaimed, Refusal::kNone, 0, token};
  }
  return applied_with_evidence(impl_->processor_patch_result.load(std::memory_order_acquire));
}

bool AudioHost::QueueInstrumentEvents(const std::span<const std::uint8_t> payload) {
  Impl::ControlSubmissionClaim claim{impl_->schedule_owner};
  if (!claim.acquired) return false;
  if (payload.size() < 4) return false;
  const std::uint32_t count = ReadLeU32(payload.data());
  if (count > DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS || payload.size() != 4 + static_cast<std::size_t>(count) * 48) return false;
  const auto is_urgent = [&](const std::uint32_t index) {
    const auto type = ReadLeU32(payload.data() + 4 + index * 48 + 32);
    // Built-in instrument targets are not processor instances. Reuse the live
    // instrument lane and its post-process acknowledgement, ahead of notes.
    return type == DAW_AUDIO_INSTRUMENT_EVENT_PARAMETER
      || type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOn)
      || type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOff)
      || type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kTransportRelease)
      || type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kAllSoundOff);
  };
  std::uint32_t urgent_count = 0;
  for (std::uint32_t index = 0; index < count; ++index) if (is_urgent(index)) ++urgent_count;
  if (!impl_->HasCapacity(Impl::QueuedControlKind::kUrgent, urgent_count)
    || !impl_->HasCapacity(Impl::QueuedControlKind::kInstrument, count - urgent_count)) return false;
  std::array<Impl::QueuedControlEvent, DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS> validated{};
  for (std::uint32_t index = 0; index < count; ++index) {
    const auto* bytes = payload.data() + 4 + index * 48;
    Impl::QueuedControlEvent event{};
    event.kind = is_urgent(index) ? Impl::QueuedControlKind::kUrgent : Impl::QueuedControlKind::kInstrument;
    event.instrument = {.node_id = ReadLeU64(bytes), .note_id = ReadLeU64(bytes + 8), .sequence = ReadLeU64(bytes + 16),
      .epoch = ReadLeU32(bytes + 24), .frame_offset = ReadLeU32(bytes + 28), .type = ReadLeU32(bytes + 32),
      .channel = ReadLeU32(bytes + 36), .note = ReadLeU32(bytes + 40), .value = ReadLeFloat(bytes + 44)};
    if (!ValidNativeInstrumentEvent(event.instrument)
      || daw_audio_core_validate_instrument_target(
        impl_->active_core.load(std::memory_order_acquire), &event.instrument) != DAW_AUDIO_CORE_OK) {
      impl_->Evidence("instrument-admission-rejected", "invalid-graph-target-or-parameter-range");
      return false;
    }
    validated[index] = event;
  }
  for (std::uint32_t index = 0; index < count; ++index) {
    if (!impl_->EnqueueControlEvent(validated[index])) return false;
  }
  return true;
}

bool AudioHost::QueueSourceEvents(const std::span<const std::uint8_t> payload) {
  Impl::ControlSubmissionClaim claim{impl_->schedule_owner};
  if (!claim.acquired) return false;
  if (impl_->prepared_core != 0 || payload.size() < 4) return false;
  const std::uint32_t count = ReadLeU32(payload.data());
  if (count > DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS || payload.size() != 4 + static_cast<std::size_t>(count) * 112) return false;
  if (!impl_->HasCapacity(Impl::QueuedControlKind::kSource, count)) return false;
  for (std::uint32_t index = 0; index < count; ++index) {
    const auto* bytes = payload.data() + 4 + index * 112;
    const auto asset = impl_->assets.find(ReadLeU32(bytes + 20));
    if (asset == impl_->assets.end()
      || !impl_->AssetVisible(asset->second, impl_->active_revision.load(std::memory_order_acquire))) return false;
    impl_->RetainAsset(asset->second);
    const daw_audio_sample_source_event event{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
      .epoch = ReadLeU32(bytes),
      .sequence = ReadLeU64(bytes + 4),
      .source_node_id = ReadLeU64(bytes + 12),
      .asset = asset->second.handle,
      .start_frame = ReadLeI64(bytes + 24),
      .stop_frame = ReadLeI64(bytes + 32),
      .source_offset_frame = ReadLeU64(bytes + 40),
      .source_frame_count = ReadLeU64(bytes + 48),
      .gain = ReadLeFloat(bytes + 56),
      .fade_in_start_frame = ReadLeI64(bytes + 60),
      .fade_in_end_frame = ReadLeI64(bytes + 68),
      .fade_out_start_frame = ReadLeI64(bytes + 76),
      .fade_out_end_frame = ReadLeI64(bytes + 84),
      .source_offset_fraction = ReadLeFloat(bytes + 92),
      .fade_in_curve = ReadLeFloat(bytes + 96),
      .fade_in_curve_position = ReadLeFloat(bytes + 100),
      .fade_out_curve = ReadLeFloat(bytes + 104),
      .fade_out_curve_position = ReadLeFloat(bytes + 108),
    };
    if (!ValidNativeSampleSourceEvent(event)
      || event.source_offset_frame >= asset->second.frame_count
      || event.source_frame_count > asset->second.frame_count - event.source_offset_frame) return false;
  }
  for (std::uint32_t index = 0; index < count; ++index) {
    const auto* bytes = payload.data() + 4 + index * 112;
    const auto asset = impl_->assets.find(ReadLeU32(bytes + 20));
    Impl::QueuedControlEvent event{};
    event.kind = Impl::QueuedControlKind::kSource;
    event.source = {.abi_version = DAW_AUDIO_CORE_ABI_VERSION, .epoch = ReadLeU32(bytes), .sequence = ReadLeU64(bytes + 4),
      .source_node_id = ReadLeU64(bytes + 12), .asset = asset->second.handle, .start_frame = ReadLeI64(bytes + 24),
      .stop_frame = ReadLeI64(bytes + 32), .source_offset_frame = ReadLeU64(bytes + 40),
      .source_frame_count = ReadLeU64(bytes + 48), .gain = ReadLeFloat(bytes + 56),
      .fade_in_start_frame = ReadLeI64(bytes + 60), .fade_in_end_frame = ReadLeI64(bytes + 68),
      .fade_out_start_frame = ReadLeI64(bytes + 76), .fade_out_end_frame = ReadLeI64(bytes + 84),
      .source_offset_fraction = ReadLeFloat(bytes + 92),
      .fade_in_curve = ReadLeFloat(bytes + 96), .fade_in_curve_position = ReadLeFloat(bytes + 100),
      .fade_out_curve = ReadLeFloat(bytes + 104), .fade_out_curve_position = ReadLeFloat(bytes + 108)};
    if (!impl_->EnqueueControlEvent(event)) return false;
  }
  return true;
}

bool AudioHost::QueueScheduleWindow(const std::span<const std::uint8_t> payload) {
  impl_->schedule_window_error = "invalid schedule payload or graph publication still pending";
  Impl::ControlSubmissionClaim claim{impl_->schedule_owner};
  if (!claim.acquired) return false;
  const auto accepted = [&] {
    impl_->schedule_window_error = {};
    return true;
  };
  // Preparation does not own the active lanes. Only the callback's publication
  // claim excludes appends until target reconciliation has been acknowledged.
  if (payload.size() < 72) return false;
  const std::uint32_t revision = ReadLeU32(payload.data());
  const std::uint32_t epoch = ReadLeU32(payload.data() + 4);
  const std::uint64_t window_id = ReadLeU64(payload.data() + 8);
  const std::uint64_t start_frame = ReadLeU64(payload.data() + 16);
  const std::uint64_t end_frame = ReadLeU64(payload.data() + 24);
  const std::uint32_t chunk_index = ReadLeU32(payload.data() + 32);
  const std::uint32_t chunk_count = ReadLeU32(payload.data() + 36);
  const std::uint32_t ends_schedule = ReadLeU32(payload.data() + 40);
  const std::uint32_t instrument_count = ReadLeU32(payload.data() + 44);
  const std::uint32_t source_count = ReadLeU32(payload.data() + 48);
  const std::uint32_t automation_count = ReadLeU32(payload.data() + 52);
  const std::uint32_t processor_automation_count = ReadLeU32(payload.data() + 56);
  const auto prepared_binding = ReadLeU32(payload.data() + 60);
  const auto publication_frame = ReadLeU64(payload.data() + 64);
  const bool prepared = prepared_binding != 0;
  // Future publication freezes the prepared bank only, not active SPSC refills.
  if (impl_->publication_in_flight != 0
    && (prepared || impl_->requested_publication_frame == 0)) return false;
  auto& bank = prepared ? impl_->PreparedSchedule() : impl_->ActiveSchedule();
  if (prepared) {
    if (impl_->prepared_core == 0 || prepared_binding != revision
      || revision != impl_->prepared_revision.load(std::memory_order_acquire)
      || epoch != impl_->prepared_transport_epoch
      || publication_frame != impl_->requested_publication_frame
      || start_frame < publication_frame || impl_->publication_rebase_required.load()) return false;
    if (publication_frame <= static_cast<std::uint64_t>(impl_->applied_transport_frame.load(std::memory_order_acquire))) {
      impl_->publication_rebase_required.store(true, std::memory_order_release);
      impl_->schedule_window_error = "publication rebase required; inspect progress and resubmit unpublished windows";
      return false;
    }
  } else if (publication_frame != 0) return false;
  impl_->schedule_window_error = "invalid schedule header, revision, epoch or limits";
  if (revision == 0 || (!prepared && revision != impl_->active_revision.load(std::memory_order_acquire))
    || epoch == 0 || epoch != impl_->transport_epoch.load(std::memory_order_acquire)
    || window_id == 0 || start_frame >= end_frame || end_frame > std::numeric_limits<std::int64_t>::max()
    || chunk_count == 0 || chunk_count > kMaximumScheduleChunks || chunk_index >= chunk_count
    || ends_schedule > 1
    || (ends_schedule == 1 && chunk_index + 1 != chunk_count)
    || instrument_count + source_count + automation_count + processor_automation_count > kMaximumScheduleRecords
    || instrument_count > DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS
    || source_count > DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS
    || automation_count > kMaximumScheduleAutomationSegments
    || processor_automation_count > kMaximumScheduleAutomationSegments) return false;
  if (bank.last_accepted_schedule_epoch != epoch) {
    bank.last_accepted_schedule_window_id = 0;
    bank.last_accepted_schedule_epoch = epoch;
    bank.last_schedule_start_frame = 0;
    bank.schedule_digest_windows = {};
    bank.schedule_chunk_digests = {};
    bank.schedule_digest_cursor = 0;
    bank.schedule_staging.clear();
    bank.schedule_complete.store(false, std::memory_order_release);
  }
  const auto digest = [&] {
    std::uint64_t result = 1469598103934665603ULL;
    for (const auto byte : payload) {
      result ^= byte;
      result *= 1099511628211ULL;
    }
    return result;
  }();
  impl_->schedule_window_error = "schedule chunk conflicts with an accepted window";
  for (std::size_t index = 0; index < bank.schedule_digest_windows.size(); ++index) {
    if (bank.schedule_digest_windows[index] != window_id) continue;
    const auto existing = bank.schedule_chunk_digests[index][chunk_index];
    if (existing == digest) return accepted();
    return false;
  }
  auto& staging = bank.schedule_staging;
  impl_->schedule_window_error = "schedule is already complete";
  if (!staging.active && bank.schedule_complete.load(std::memory_order_acquire)) return false;
  const bool staging_was_active = staging.active;
  const auto staging_revision_before = staging.revision;
  const auto staging_epoch_before = staging.epoch;
  const auto staging_window_id_before = staging.window_id;
  const auto staging_start_frame_before = staging.start_frame;
  const auto staging_end_frame_before = staging.end_frame;
  const auto staging_chunk_count_before = staging.chunk_count;
  const auto record_count_before = staging.record_count;
  const auto automation_count_before = staging.automation_state.segment_count;
  const auto automation_group_count_before = staging.automation_state.group_count;
  for (std::size_t index = 0; index < staging.automation_state.group_count; ++index) {
    staging.rollback_automation_group_counts[index] = staging.automation_state.groups[index].count;
  }
  const auto ends_schedule_before = staging.ends_schedule;
  const auto received_chunk_before = staging.received_chunks[chunk_index];
  const auto chunk_digest_before = staging.chunk_digests[chunk_index];
  bool keep_staging = false;
  struct StagingRollback {
    Impl::ScheduleStaging& staging;
    bool was_active;
    std::uint32_t revision;
    std::uint32_t epoch;
    std::uint64_t window_id;
    std::uint64_t start_frame;
    std::uint64_t end_frame;
    std::uint32_t chunk_count;
    std::size_t record_count;
    std::size_t automation_count;
    std::size_t automation_group_count;
    bool ends_schedule;
    std::uint32_t chunk_index;
    bool received_chunk;
    std::uint64_t chunk_digest;
    bool& keep;
    ~StagingRollback() {
      if (keep) return;
      if (!was_active) {
        staging.clear();
        return;
      }
      staging.active = was_active;
      staging.revision = revision;
      staging.epoch = epoch;
      staging.window_id = window_id;
      staging.start_frame = start_frame;
      staging.end_frame = end_frame;
      staging.chunk_count = chunk_count;
      for (std::size_t index = record_count; index < staging.record_count; ++index) {
        staging.events[index] = {};
      }
      staging.record_count = record_count;
      staging.automation_state.segment_count = automation_count;
      staging.automation_state.group_count = automation_group_count;
      for (std::size_t index = 0; index < automation_group_count; ++index) {
        const auto previous_count = staging.rollback_automation_group_counts[index];
        for (std::size_t segment = previous_count;
             segment < staging.automation_state.groups[index].count; ++segment) {
          staging.automation_state.groups[index].segments[segment] = {};
        }
        staging.automation_state.groups[index].count = previous_count;
      }
      for (std::size_t index = automation_group_count;
           index < staging.automation_state.groups.size(); ++index) {
        auto& group = staging.automation_state.groups[index];
        for (std::size_t segment = 0; segment < group.count; ++segment) {
          group.segments[segment] = {};
        }
        group.attachment = nullptr;
        group.count = 0;
      }
      staging.active = was_active;
      staging.ends_schedule = ends_schedule;
      staging.received_chunks[chunk_index] = received_chunk;
      staging.chunk_digests[chunk_index] = chunk_digest;
    }
  } rollback{
    staging,
    staging_was_active,
    staging_revision_before,
    staging_epoch_before,
    staging_window_id_before,
    staging_start_frame_before,
    staging_end_frame_before,
    staging_chunk_count_before,
    record_count_before,
    automation_count_before,
    automation_group_count_before,
    ends_schedule_before,
    chunk_index,
    received_chunk_before,
    chunk_digest_before,
    keep_staging,
  };
  if (!staging.active) {
    impl_->schedule_window_error = "schedule window is stale or not contiguous";
    if (window_id <= bank.last_accepted_schedule_window_id
      || start_frame != bank.accepted_schedule_through_frame.load(std::memory_order_acquire)) return false;
    staging.clear();
    staging.active = true;
    staging.revision = revision;
    staging.epoch = epoch;
    staging.window_id = window_id;
    staging.start_frame = start_frame;
    staging.end_frame = end_frame;
    staging.chunk_count = chunk_count;
  }
  impl_->schedule_window_error = "schedule chunk does not match the pending window";
  if (!staging.active || staging.revision != revision || staging.epoch != epoch
    || staging.window_id != window_id || staging.start_frame != start_frame
    || staging.end_frame != end_frame || staging.chunk_count != chunk_count
  ) return false;
  if (staging.received_chunks[chunk_index]) {
    return staging.chunk_digests[chunk_index] == digest ? accepted() : false;
  }
  std::size_t offset = 72;
  std::uint64_t previous_frame = 0;
  std::uint64_t previous_sequence = 0;
  bool has_previous = false;
  for (std::uint32_t index = 0; index < instrument_count; ++index) {
    impl_->schedule_window_error = "invalid instrument event length, frame or ordering";
    if (offset + 48 > payload.size()) return false;
    const auto* bytes = payload.data() + offset;
    const std::uint64_t frame = start_frame + ReadLeU32(bytes + 28);
    const std::uint64_t sequence = ReadLeU64(bytes + 16);
    if (frame < start_frame || frame >= end_frame || sequence == 0
      || (has_previous && (frame < previous_frame || (frame == previous_frame && sequence <= previous_sequence)))) {
      return false;
    }
    Impl::QueuedControlEvent event{};
    event.kind = Impl::QueuedControlKind::kInstrument;
    event.window_id = window_id;
    event.absolute_frame = frame;
    event.scheduled = true;
    event.instrument = {
      .node_id = ReadLeU64(bytes),
      .note_id = ReadLeU64(bytes + 8),
      .sequence = sequence,
      .epoch = ReadLeU32(bytes + 24),
      .frame_offset = static_cast<std::uint32_t>(frame),
      .type = ReadLeU32(bytes + 32),
      .channel = ReadLeU32(bytes + 36),
      .note = ReadLeU32(bytes + 40),
      .value = ReadLeFloat(bytes + 44),
    };
    impl_->schedule_window_error = "invalid instrument event epoch, value or capacity";
    if (event.instrument.epoch != epoch || !ValidNativeInstrumentEvent(event.instrument)
      || staging.record_count >= staging.events.size()) return false;
    impl_->schedule_window_error = "instrument target is missing or its parameter is unsupported";
    if (prepared && !impl_->ValidPreparedInstrumentEvent(event.instrument)) return false;
    if (!prepared && daw_audio_core_validate_instrument_target(
        impl_->active_core.load(std::memory_order_acquire), &event.instrument) != DAW_AUDIO_CORE_OK) return false;
    staging.events[staging.record_count++] = event;
    previous_frame = frame;
    previous_sequence = sequence;
    has_previous = true;
    offset += 48;
  }
  std::uint64_t previous_source_frame = 0;
  std::uint64_t previous_source_sequence = 0;
  bool has_previous_source = false;
  for (std::uint32_t index = 0; index < source_count; ++index) {
    impl_->schedule_window_error = "invalid source event or sample coverage";
    if (offset + 112 > payload.size()) return false;
    const auto* bytes = payload.data() + offset;
    const auto source_start = ReadLeU64(bytes + 24);
    const auto source_sequence = ReadLeU64(bytes + 4);
    const auto source_stop = ReadLeU64(bytes + 32);
    const auto source_offset = ReadLeU64(bytes + 40);
    const auto source_frames = ReadLeU64(bytes + 48);
    const auto fade_in_start = ReadLeI64(bytes + 60);
    const auto fade_in_end = ReadLeI64(bytes + 68);
    const auto fade_out_start = ReadLeI64(bytes + 76);
    const auto fade_out_end = ReadLeI64(bytes + 84);
    const auto fade_in_curve = ReadLeFloat(bytes + 96);
    const auto fade_in_curve_position = ReadLeFloat(bytes + 100);
    const auto fade_out_curve = ReadLeFloat(bytes + 104);
    const auto fade_out_curve_position = ReadLeFloat(bytes + 108);
    const bool seam_origin = prepared && start_frame == publication_frame && source_start <= start_frame;
    const auto scheduled_start = seam_origin ? start_frame : source_start;
    if ((!seam_origin && source_start < start_frame) || source_start >= end_frame || source_sequence == 0
      || (seam_origin && source_stop <= publication_frame)
      || source_stop <= source_start || source_stop > std::numeric_limits<std::int64_t>::max()
      || source_frames == 0 || source_offset > std::numeric_limits<std::uint64_t>::max() - source_frames
      || fade_in_start > fade_in_end || fade_out_start > fade_out_end
      || !std::isfinite(fade_in_curve) || fade_in_curve < -1.0F || fade_in_curve > 1.0F
      || !std::isfinite(fade_in_curve_position) || fade_in_curve_position < 0.0F || fade_in_curve_position > 1.0F
      || !std::isfinite(fade_out_curve) || fade_out_curve < -1.0F || fade_out_curve > 1.0F
      || !std::isfinite(fade_out_curve_position) || fade_out_curve_position < 0.0F || fade_out_curve_position > 1.0F
      || (has_previous_source && (scheduled_start < previous_source_frame
        || (scheduled_start == previous_source_frame && source_sequence <= previous_source_sequence)))) return false;
    const auto asset = impl_->assets.find(ReadLeU32(bytes + 20));
    if (asset == impl_->assets.end() || !impl_->AssetVisible(asset->second, revision)
      || source_offset + source_frames > asset->second.frame_count
      || staging.record_count >= staging.events.size()) return false;
    impl_->RetainAsset(asset->second);
    if (asset->second.mapped) {
      const auto source_end = source_offset + source_frames;
      const auto& ranges = asset->second.mapped->written_ranges;
      if (!std::any_of(ranges.begin(), ranges.end(), [source_offset, source_end](const auto range) {
        return range.first <= source_offset && range.second >= source_end;
      })) return false;
    }
    Impl::QueuedControlEvent event{};
    event.kind = Impl::QueuedControlKind::kSource;
    event.window_id = window_id;
    event.scheduled = true;
    event.source = {
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
      .epoch = ReadLeU32(bytes),
      .sequence = source_sequence,
      .source_node_id = ReadLeU64(bytes + 12),
      .asset = asset->second.handle,
      .start_frame = static_cast<std::int64_t>(source_start),
      .stop_frame = static_cast<std::int64_t>(source_stop),
      .source_offset_frame = source_offset,
      .source_frame_count = source_frames,
      .gain = ReadLeFloat(bytes + 56),
      .fade_in_start_frame = fade_in_start,
      .fade_in_end_frame = fade_in_end,
      .fade_out_start_frame = fade_out_start,
      .fade_out_end_frame = fade_out_end,
      .source_offset_fraction = ReadLeFloat(bytes + 92),
      .fade_in_curve = fade_in_curve,
      .fade_in_curve_position = fade_in_curve_position,
      .fade_out_curve = fade_out_curve,
      .fade_out_curve_position = fade_out_curve_position};
    if (event.source.epoch != epoch || staging.record_count >= staging.events.size()) return false;
    staging.events[staging.record_count++] = event;
    previous_source_frame = scheduled_start;
    previous_source_sequence = source_sequence;
    has_previous_source = true;
    offset += 112;
  }
  std::string previous_automation_instance;
  std::uint32_t previous_automation_parameter = 0;
  std::uint64_t previous_automation_start = 0;
  bool has_previous_automation = false;
  for (std::uint32_t index = 0; index < automation_count; ++index) {
    impl_->schedule_window_error = "invalid plugin automation or unavailable plugin";
    if (offset + 4 > payload.size()) return false;
    const std::uint32_t instance_bytes = ReadLeU32(payload.data() + offset);
    offset += 4;
    if (instance_bytes == 0 || instance_bytes > kMaximumScheduleInstanceIdBytes
      || offset + instance_bytes + 40 > payload.size()) return false;
    const std::string instance_id(
      reinterpret_cast<const char*>(payload.data() + offset),
      instance_bytes
    );
    offset += instance_bytes;
    const auto attachment = impl_->native_vst_attachments.find(instance_id);
    if (attachment == impl_->native_vst_attachments.end() || !attachment->second->metadata.playback_enabled) return false;
    NativeVstAutomationSegment segment{
      .parameter_id = ReadLeU32(payload.data() + offset),
      .start_frame = ReadLeU64(payload.data() + offset + 4),
      .end_frame = ReadLeU64(payload.data() + offset + 12),
      .start_value = ReadLeDouble(payload.data() + offset + 20),
      .end_value = ReadLeDouble(payload.data() + offset + 28),
      .linear = ReadLeU32(payload.data() + offset + 36) == 1,
    };
    if (has_previous_automation
      && (instance_id < previous_automation_instance
        || (instance_id == previous_automation_instance
          && (segment.parameter_id < previous_automation_parameter
            || (segment.parameter_id == previous_automation_parameter
              && segment.start_frame <= previous_automation_start))))) return false;
    if (ReadLeU32(payload.data() + offset + 36) > 1
      || segment.start_frame < start_frame || segment.start_frame >= segment.end_frame
      || segment.end_frame > end_frame || !std::isfinite(segment.start_value)
      || !std::isfinite(segment.end_value) || segment.start_value < 0.0 || segment.start_value > 1.0
      || segment.end_value < 0.0 || segment.end_value > 1.0
      || staging.automation_state.segment_count >= kMaximumScheduleAutomationSegments) return false;
    auto group = std::find_if(
      staging.automation_state.groups.begin(),
      staging.automation_state.groups.begin() + staging.automation_state.group_count,
      [&attachment](const auto& candidate) { return candidate.attachment == attachment->second.get(); }
    );
    if (group == staging.automation_state.groups.begin() + staging.automation_state.group_count) {
      if (staging.automation_state.group_count >= staging.automation_state.groups.size()) return false;
      group = staging.automation_state.groups.begin() + staging.automation_state.group_count++;
      group->attachment = attachment->second.get();
    }
    if (group->count >= group->segments.size()) return false;
    group->segments[group->count++] = segment;
    ++staging.automation_state.segment_count;
    previous_automation_instance = instance_id;
    previous_automation_parameter = segment.parameter_id;
    previous_automation_start = segment.start_frame;
    has_previous_automation = true;
    offset += 40;
  }
  std::uint64_t previous_processor_frame = 0;
  std::uint64_t previous_processor_instance = 0;
  std::uint32_t previous_processor_target = 0;
  bool has_previous_processor = false;
  for (std::uint32_t index = 0; index < processor_automation_count; ++index) {
    impl_->schedule_window_error = "invalid processor automation";
    if (offset + 40 > payload.size()) return false;
    const auto* bytes = payload.data() + offset;
    const std::uint64_t processor_instance = ReadLeU64(bytes);
    const std::uint32_t parameter_target = ReadLeU32(bytes + 8);
    const std::uint32_t kind = ReadLeU32(bytes + 12);
    const std::uint64_t frame = ReadLeU64(bytes + 16);
    const std::uint64_t processor_end_frame = ReadLeU64(bytes + 24);
    const float start_value = ReadLeFloat(bytes + 32);
    const float end_value = ReadLeFloat(bytes + 36);
    if (processor_instance == 0 || parameter_target == 0 || kind > 1
      || frame < start_frame || frame >= end_frame
      || !std::isfinite(start_value) || !std::isfinite(end_value)
      || (kind == 0 && processor_end_frame != frame)
      || (kind == 1 && (processor_end_frame <= frame || processor_end_frame > end_frame))
      || (has_previous_processor && (frame < previous_processor_frame
        || (frame == previous_processor_frame && (processor_instance < previous_processor_instance
          || (processor_instance == previous_processor_instance
            && parameter_target <= previous_processor_target)))))
      || staging.record_count >= staging.events.size()) return false;
    Impl::QueuedControlEvent event{};
    event.kind = Impl::QueuedControlKind::kProcessor;
    event.window_id = window_id;
    event.absolute_frame = frame;
    event.scheduled = true;
    event.processor_end_frame = processor_end_frame;
    event.processor_end_value = end_value;
    event.processor_revision = revision;
    event.processor_epoch = epoch;
    event.processor = {
      .processor_instance_id = processor_instance,
      .parameter_target = parameter_target,
      .frame_offset = 0,
      .value = start_value,
    };
    staging.events[staging.record_count++] = event;
    previous_processor_frame = frame;
    previous_processor_instance = processor_instance;
    previous_processor_target = parameter_target;
    has_previous_processor = true;
    offset += 40;
  }
  impl_->schedule_window_error = "unexpected trailing schedule data";
  if (offset != payload.size()) return false;
  staging.received_chunks[chunk_index] = true;
  staging.chunk_digests[chunk_index] = digest;
  staging.ends_schedule = staging.ends_schedule || ends_schedule == 1;
  if (std::count(staging.received_chunks.begin(),
      staging.received_chunks.begin() + staging.chunk_count, true) != staging.chunk_count) {
    keep_staging = true;
    return accepted();
  }
  const std::uint32_t instrument_events = static_cast<std::uint32_t>(
    std::count_if(staging.events.begin(), staging.events.begin() + staging.record_count,
      [](const auto& event) { return event.kind == Impl::QueuedControlKind::kInstrument; })
  );
  const std::uint32_t source_events = static_cast<std::uint32_t>(
    std::count_if(staging.events.begin(), staging.events.begin() + staging.record_count,
      [](const auto& event) { return event.kind == Impl::QueuedControlKind::kSource; })
  );
  const std::uint32_t processor_events = static_cast<std::uint32_t>(
    std::count_if(staging.events.begin(), staging.events.begin() + staging.record_count,
      [](const auto& event) { return event.kind == Impl::QueuedControlKind::kProcessor; })
  );
  if (prepared && start_frame == publication_frame && std::count_if(staging.events.begin(),
    staging.events.begin() + staging.record_count, [publication_frame](const auto& event) {
      return event.kind == Impl::QueuedControlKind::kSource
        && event.source.start_frame <= static_cast<std::int64_t>(publication_frame);
    }) > 256) {
    impl_->schedule_window_error = "source seam capacity exceeded";
    return false;
  }
  impl_->schedule_window_error = "schedule queue capacity exceeded";
  if (!Impl::HasCapacity(bank.instrument_queue, instrument_events)
    || !Impl::HasCapacity(bank.source_queue, source_events)
    || !Impl::HasCapacity(bank.scheduled_processor_queue, processor_events)) {
    staging.clear();
    return false;
  }
  const auto rendered_epoch = impl_->schedule_progress_epoch.load(std::memory_order_acquire);
  const auto rendered_through_frame = rendered_epoch == epoch
    ? impl_->schedule_progress_rendered_frame.load(std::memory_order_acquire)
    : 0;
  std::array<NativeVstWorkerAttachment::AutomationPublication, NativeScheduleAutomationState::kMaximumAttachments>
    automation_publications{};
  for (std::size_t index = 0; index < staging.automation_state.group_count; ++index) {
    impl_->schedule_window_error = "plugin automation could not be published";
    const auto& group = staging.automation_state.groups[index];
    auto* attachment = static_cast<NativeVstWorkerAttachment*>(group.attachment);
    if (attachment == nullptr || !attachment->StageAutomation(
      epoch,
      rendered_through_frame,
      std::span<const NativeVstAutomationSegment>(group.segments.data(), group.count),
      prepared ? 1U - impl_->active_schedule_bank.load(std::memory_order_acquire)
        : impl_->active_schedule_bank.load(std::memory_order_acquire), automation_publications[index]
    )) {
      staging.clear();
      return false;
    }
  }
  // Chunk arrival order is not timeline order. Sort only on the control
  // thread so a future head cannot hide an accepted overdue event.
  std::sort(staging.events.begin(), staging.events.begin() + staging.record_count,
    [publication_frame](const auto& left, const auto& right) {
      const auto left_frame = left.kind == Impl::QueuedControlKind::kSource
        ? std::max(publication_frame, static_cast<std::uint64_t>(left.source.start_frame)) : left.absolute_frame;
      const auto right_frame = right.kind == Impl::QueuedControlKind::kSource
        ? std::max(publication_frame, static_cast<std::uint64_t>(right.source.start_frame)) : right.absolute_frame;
      if (left_frame != right_frame) return left_frame < right_frame;
      if (left.kind != right.kind) return left.kind < right.kind;
      if (left.kind == Impl::QueuedControlKind::kInstrument)
        return left.instrument.sequence < right.instrument.sequence;
      if (left.kind == Impl::QueuedControlKind::kSource)
        return left.source.sequence < right.source.sequence;
      return left.processor.processor_instance_id < right.processor.processor_instance_id
        || (left.processor.processor_instance_id == right.processor.processor_instance_id
          && left.processor.parameter_target < right.processor.parameter_target);
    });
  for (std::size_t index = 0; index < staging.record_count; ++index) {
    impl_->schedule_window_error = "schedule event queue is full";
    const auto& event = staging.events[index];
    const bool queued = event.kind == Impl::QueuedControlKind::kProcessor
      ? Impl::EnqueueControlEvent(bank.scheduled_processor_queue, event)
      : event.kind == Impl::QueuedControlKind::kInstrument
        ? Impl::EnqueueControlEvent(bank.instrument_queue, event)
        : Impl::EnqueueControlEvent(bank.source_queue, event);
    if (!queued) {
      staging.clear();
      return false;
    }
  }
  // All groups and lanes have passed admission. Nothing from a rejected
  // multi-attachment window can leak into the active automation buffers.
  for (std::size_t index = 0; index < staging.automation_state.group_count; ++index) {
    const auto& publication = automation_publications[index];
    publication.bank->buffer_counts[publication.buffer] = publication.count;
    publication.bank->count.store(publication.count, std::memory_order_release);
    publication.bank->epoch.store(epoch, std::memory_order_release);
    publication.bank->buffer.store(publication.buffer, std::memory_order_release);
  }
  bank.published_schedule_window_id.store(window_id, std::memory_order_release);
  bank.accepted_schedule_epoch.store(epoch, std::memory_order_release);
  bank.accepted_schedule_through_frame.store(end_frame, std::memory_order_release);
  bank.last_accepted_schedule_window_id = window_id;
  bank.last_schedule_start_frame = start_frame;
  bank.schedule_complete.store(staging.ends_schedule, std::memory_order_release);
  const auto cursor = bank.schedule_digest_cursor++ % bank.schedule_digest_windows.size();
  bank.schedule_digest_windows[cursor] = window_id;
  bank.schedule_chunk_digests[cursor] = staging.chunk_digests;
  staging.clear();
  keep_staging = true;
  return accepted();
}

std::string_view AudioHost::scheduleWindowError() const { return impl_->schedule_window_error; }

bool AudioHost::ReenableVstScheduleAutomation(const std::span<const std::uint8_t> payload) {
  if (payload.size() < 8) return false;
  const auto instance_bytes = ReadLeU32(payload.data());
  if (instance_bytes == 0 || instance_bytes > kMaximumScheduleInstanceIdBytes
    || payload.size() < 8 + instance_bytes) return false;
  const std::string instance_id(reinterpret_cast<const char*>(payload.data() + 4), instance_bytes);
  const auto attachment = impl_->native_vst_attachments.find(instance_id);
  if (attachment == impl_->native_vst_attachments.end()) return false;
  const auto count = ReadLeU32(payload.data() + 4 + instance_bytes);
  if (count > kMaximumScheduleAutomationSegments
    || payload.size() != 8 + instance_bytes + static_cast<std::size_t>(count) * 4) return false;
  for (std::uint32_t index = 0; index < count; ++index) {
    const auto parameter_id = ReadLeU32(payload.data() + 8 + instance_bytes + index * 4);
    if (std::find(
      attachment->second->metadata.parameter_ids.begin(),
      attachment->second->metadata.parameter_ids.end(),
      parameter_id
    ) == attachment->second->metadata.parameter_ids.end()) return false;
  }
  for (std::uint32_t index = 0; index < count; ++index) {
    attachment->second->ClearAutomationOverride(ReadLeU32(payload.data() + 8 + instance_bytes + index * 4));
  }
  return true;
}

bool AudioHost::QueueNativeVstParameterEvents(const std::span<const std::uint8_t> payload) {
  std::size_t offset = 0;
  std::string instance_id;
  if (!ReadNativeInstanceId(payload, offset, instance_id) || offset + 4 > payload.size()) return false;
  const std::uint32_t count = ReadLeU32(payload.data() + offset);
  offset += 4;
  if (count > daw::plugin_host::kMaximumWorkerEvents || payload.size() != offset + static_cast<std::size_t>(count) * 16) return false;
  const auto attachment = impl_->native_vst_attachments.find(instance_id);
  if (attachment == impl_->native_vst_attachments.end() || !attachment->second->metadata.playback_enabled
    || count > attachment->second->metadata.transport.maximum_events_per_block) return false;
  std::array<daw::plugin_host::WorkerTransportEvent, daw::plugin_host::kMaximumWorkerEvents> events{};
  std::array<std::uint32_t, daw::plugin_host::kMaximumWorkerEvents> candidate_override_ids{};
  std::array<std::uint32_t, daw::plugin_host::kMaximumWorkerEvents> inserted_override_ids{};
  std::size_t candidate_override_count = 0;
  std::size_t inserted_override_count = 0;
  const auto rollback_overrides = [&]() noexcept {
    for (std::size_t index = 0; index < inserted_override_count; ++index) {
      attachment->second->ClearAutomationOverride(inserted_override_ids[index]);
    }
  };
  for (std::uint32_t index = 0; index < count; ++index) {
    const auto* bytes = payload.data() + offset + index * 16;
    const auto parameter_id = ReadLeU32(bytes);
    const double value = ReadLeDouble(bytes + 8);
    if (ReadLeU32(bytes + 4) >= attachment->second->metadata.transport.maximum_frames
      || !std::isfinite(value) || value < 0.0 || value > 1.0
      || (!attachment->second->metadata.parameter_ids.empty()
        && std::find(
          attachment->second->metadata.parameter_ids.begin(),
          attachment->second->metadata.parameter_ids.end(),
          parameter_id
        ) == attachment->second->metadata.parameter_ids.end())) return false;
    if (std::find(candidate_override_ids.begin(), candidate_override_ids.begin() + static_cast<std::ptrdiff_t>(candidate_override_count), parameter_id)
      == candidate_override_ids.begin() + static_cast<std::ptrdiff_t>(candidate_override_count)) {
      if (candidate_override_count >= candidate_override_ids.size()) return false;
      candidate_override_ids[candidate_override_count++] = parameter_id;
    }
    events[index] = {.kind = daw::plugin_host::WorkerEventKind::kParameter, .sampleOffset = ReadLeU32(bytes + 4),
      .parameterId = parameter_id, .parameterValue = value};
  }
  if (ShouldOverrideNativeVstAutomation(impl_->transport_running.load(std::memory_order_acquire))) {
    for (std::size_t index = 0; index < candidate_override_count; ++index) {
      const auto result = attachment->second->SetAutomationOverride(candidate_override_ids[index]);
      if (result == NativeVstWorkerAttachment::AutomationOverrideSetResult::kFull) {
        rollback_overrides();
        return false;
      }
      if (result == NativeVstWorkerAttachment::AutomationOverrideSetResult::kInserted) {
        inserted_override_ids[inserted_override_count++] = candidate_override_ids[index];
      }
    }
  }
  if (!attachment->second->QueueEvents(
    std::span<const daw::plugin_host::WorkerTransportEvent>(events.data(), count)
  )) {
    rollback_overrides();
    return false;
  }
  return true;
}

bool AudioHost::QueueNativeVstMidiEvents(const std::span<const std::uint8_t> payload) {
  std::size_t offset = 0;
  std::string instance_id;
  if (!ReadNativeInstanceId(payload, offset, instance_id) || offset + 4 > payload.size()) return false;
  const std::uint32_t count = ReadLeU32(payload.data() + offset);
  offset += 4;
  if (count > daw::plugin_host::kMaximumWorkerEvents || payload.size() != offset + static_cast<std::size_t>(count) * 8) return false;
  const auto attachment = impl_->native_vst_attachments.find(instance_id);
  if (attachment == impl_->native_vst_attachments.end() || !attachment->second->metadata.playback_enabled
    || count > attachment->second->metadata.transport.maximum_events_per_block) return false;
  std::array<daw::plugin_host::WorkerTransportEvent, daw::plugin_host::kMaximumWorkerEvents> events{};
  for (std::uint32_t index = 0; index < count; ++index) {
    const auto* bytes = payload.data() + offset + index * 8;
    if (ReadLeU32(bytes) >= attachment->second->metadata.transport.maximum_frames || bytes[7] != 0) return false;
    events[index] = {.kind = daw::plugin_host::WorkerEventKind::kMidi, .sampleOffset = ReadLeU32(bytes),
      .midiData = {bytes[4], bytes[5], bytes[6]}};
  }
  return attachment->second->QueueEvents(std::span<const daw::plugin_host::WorkerTransportEvent>(events.data(), count));
}

bool AudioHost::SetNativeVstState(const std::span<const std::uint8_t> payload) {
  std::size_t offset = 0;
  std::string instance_id;
  if (!ReadNativeInstanceId(payload, offset, instance_id) || offset + 8 > payload.size()) return false;
  const std::uint32_t bytes = ReadLeU32(payload.data() + offset);
  const std::uint32_t hash_bytes = ReadLeU32(payload.data() + offset + 4);
  offset += 8;
  if (bytes > daw::plugin_host::kMaximumWorkerStateBytes || hash_bytes != 64 || payload.size() != offset + bytes + hash_bytes) return false;
  const auto attachment = impl_->native_vst_attachments.find(instance_id);
  if (attachment == impl_->native_vst_attachments.end() || !attachment->second->metadata.playback_enabled) return false;
  daw::plugin_host::WorkerState state{
    .bytes = {payload.begin() + static_cast<std::ptrdiff_t>(offset), payload.begin() + static_cast<std::ptrdiff_t>(offset + bytes)},
    .sha256 = {reinterpret_cast<const char*>(payload.data() + offset + bytes), hash_bytes},
  };
  return daw::plugin_host::IsValidWorkerState(state) && attachment->second->worker.SetState(state);
}

std::optional<std::vector<std::uint8_t>> AudioHost::GetNativeVstState(const std::span<const std::uint8_t> payload) {
  std::size_t offset = 0;
  std::string instance_id;
  if (!ReadNativeInstanceId(payload, offset, instance_id) || offset != payload.size()) return std::nullopt;
  const auto attachment = impl_->native_vst_attachments.find(instance_id);
  if (attachment == impl_->native_vst_attachments.end() || !attachment->second->metadata.playback_enabled) return std::nullopt;
  const auto state = attachment->second->worker.GetState();
  if (!state) return std::nullopt;
  std::vector<std::uint8_t> result;
  result.reserve(4 + instance_id.size() + 8 + state->bytes.size() + state->sha256.size());
  const auto append_le = [&result](const std::uint32_t value) {
    result.push_back(static_cast<std::uint8_t>(value));
    result.push_back(static_cast<std::uint8_t>(value >> 8U));
    result.push_back(static_cast<std::uint8_t>(value >> 16U));
    result.push_back(static_cast<std::uint8_t>(value >> 24U));
  };
  append_le(static_cast<std::uint32_t>(instance_id.size()));
  result.insert(result.end(), instance_id.begin(), instance_id.end());
  append_le(static_cast<std::uint32_t>(state->bytes.size()));
  append_le(static_cast<std::uint32_t>(state->sha256.size()));
  result.insert(result.end(), state->bytes.begin(), state->bytes.end());
  result.insert(result.end(), state->sha256.begin(), state->sha256.end());
  return result;
}

void AudioHost::ProcessNativeVstControl() {
  impl_->ReclaimAssets();
  impl_->ReclaimRetiredNativeVsts();
  for (auto& [map_key, attachment] : impl_->native_vst_attachments) {
    static_cast<void>(map_key);
    while (const auto diagnostic = attachment->worker.ReadDiagnostic()) {
      if (diagnostic->kind == daw::plugin_host::WorkerDiagnosticKind::kScheduledAutomationInput) {
        const auto epoch = diagnostic->transport_epoch;
        if (diagnostic->value > 0 && epoch != 0
          && epoch == impl_->transport_epoch.load(std::memory_order_acquire)
          && (!attachment->worker_automation || attachment->worker_automation->transport_epoch != epoch
            || diagnostic->sequence > attachment->worker_automation->sequence)) {
          attachment->worker_automation = Diagnostics::WorkerAutomation{
            diagnostic->value, diagnostic->parameter_id, epoch, diagnostic->sequence,
            attachment->metadata.instance_id,
          };
        }
      } else if (diagnostic->kind == daw::plugin_host::WorkerDiagnosticKind::kLatency) {
        if (diagnostic->value != attachment->metadata.declared_latency_frames) {
          char detail[128];
          std::snprintf(detail, sizeof(detail), ",\"oldLatencyFrames\":%u,\"newLatencyFrames\":%u",
            attachment->metadata.declared_latency_frames, diagnostic->value);
          // The notification sink already carries the value to the typed latency
          // publish path; the host keeps running while it recomputes compensation.
          impl_->Evidence("attachment-latency-report", "worker-notification", 0, detail);
          attachment->metadata.declared_latency_frames = diagnostic->value;
        }
      } else if (diagnostic->kind == daw::plugin_host::WorkerDiagnosticKind::kTail) {
        if (!daw::plugin_host::IsValidWorkerTailFrames(diagnostic->value)) {
          continue;
        }
        if (daw::plugin_host::IsInfiniteTailFrames(diagnostic->value)) {
          attachment->metadata.infinite_tail = true;
          attachment->metadata.declared_tail_frames.reset();
        } else {
          attachment->metadata.infinite_tail = false;
          attachment->metadata.declared_tail_frames = diagnostic->value;
        }
      } else if (diagnostic->kind == daw::plugin_host::WorkerDiagnosticKind::kBuses) {
        // The worker emits its validated active-bus summary during every
        // successful startup. Attachment preflight and transport dimensions
        // already prove the supported stereo bus contract; this notification
        // is informational and must not mute or tear down the graph.
      } else if (diagnostic->kind == daw::plugin_host::WorkerDiagnosticKind::kRestart) {
        char detail[64];
        std::snprintf(detail, sizeof(detail), ",\"restartFlags\":%u", diagnostic->value);
        impl_->Evidence("host-restart-request", "plugin-restartComponent", 0, detail);
        // The worker re-sets its own component up; nothing else restarts.
        attachment->worker_automation.reset();
        impl_->vst_worker_restarts.fetch_add(1, std::memory_order_relaxed);
      } else if (diagnostic->kind == daw::plugin_host::WorkerDiagnosticKind::kFault) {
        // A faulted worker is no longer ready, so its callback writes silence for
        // this instance only. Every other attachment and the graph keep rendering.
        impl_->Evidence("attachment-fault-isolated",
          daw::plugin_host::IsPluginFaultOrigin(diagnostic->value) ? "plugin-fault" : "host-defect");
        attachment->worker_automation.reset();
        impl_->vst_worker_faults.fetch_add(1, std::memory_order_relaxed);
      }
    }
  }
}

int AudioHost::controlWakeDescriptor() const { return impl_->control_wake[0]; }

void AudioHost::DrainControlWake() {
  std::array<std::uint8_t, 256> pending{};
  while (read(impl_->control_wake[0], pending.data(), pending.size()) > 0) {}
}

bool AudioHost::InstallAsset(
  const std::uint32_t asset_id,
  const std::uint32_t frame_count,
  const std::uint32_t sample_rate_hz,
  const std::uint32_t channel_count,
  const std::uint64_t content_hash_prefix,
  const std::span<const float> samples
) {
  impl_->asset_operation_error = "invalid-asset";
  const daw_audio_core_handle active_core = impl_->active_core.load(std::memory_order_acquire);
  if (impl_->publication_in_flight != 0) {
    impl_->asset_operation_error = "asset-publication-pending"; return false;
  }
  if (active_core == 0
    || asset_id == 0 || frame_count == 0 || frame_count > kMaximumAssetFrames
    || sample_rate_hz == 0 || channel_count == 0 || channel_count > kMaximumAssetChannels
    || samples.size() != static_cast<std::size_t>(frame_count) * channel_count) return false;
  if (!std::all_of(samples.begin(), samples.end(), [](const float sample) { return std::isfinite(sample); })) return false;
  if (const auto found = impl_->assets.find(asset_id); found != impl_->assets.end()) {
    auto& asset = found->second;
    if (asset.mapped || asset.frame_count != frame_count || asset.sample_rate_hz != sample_rate_hz
      || asset.channel_count != channel_count || asset.content_hash_prefix != content_hash_prefix
      || !std::equal(samples.begin(), samples.end(), asset.samples.begin(), asset.samples.end())) {
      impl_->asset_operation_error = "asset-identity-conflict"; return false;
    }
    impl_->ReuseAsset(asset);
    impl_->asset_operation_error = {};
    return true;
  }
  impl_->ReclaimAssets();
  if (impl_->assets.size() >= kMaximumInstalledAssets) {
    impl_->asset_operation_error = "asset-capacity-exceeded"; return false;
  }
  Impl::InstalledAsset asset{
    .samples = {samples.begin(), samples.end()},
    .frame_count = frame_count,
    .sample_rate_hz = sample_rate_hz,
    .channel_count = channel_count,
    .content_hash_prefix = content_hash_prefix,
    .staged_revision = impl_->prepared_revision.load(std::memory_order_acquire),
  };
  const auto [asset_iterator, inserted] = impl_->assets.emplace(asset_id, std::move(asset));
  if (!inserted) return false;
  auto& stored = asset_iterator->second;
  stored.planes.fill(nullptr);
  for (std::uint32_t channel = 0; channel < channel_count; ++channel) {
    stored.planes[channel] = stored.samples.data() + static_cast<std::size_t>(channel) * stored.frame_count;
  }
  const daw_audio_asset_descriptor descriptor{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .revision = stored.staged_revision != 0 ? stored.staged_revision : impl_->active_revision.load(std::memory_order_acquire),
    .byte_length = static_cast<std::uint64_t>(samples.size_bytes()),
    .content_hash_prefix = content_hash_prefix,
    .frame_count = frame_count,
    .sample_rate_hz = sample_rate_hz,
    .channel_count = channel_count,
    .planes = stored.planes.data(),
  };
  if (daw_audio_core_create_asset(active_core, &descriptor, &stored.handle) != DAW_AUDIO_CORE_OK) {
    impl_->assets.erase(asset_iterator);
    return false;
  }
  impl_->asset_operation_error = {};
  return true;
}

bool AudioHost::CreateMappedAsset(
  const std::uint32_t asset_id,
  const std::uint64_t frame_count,
  const std::uint32_t sample_rate_hz,
  const std::uint32_t channel_count,
  const std::uint64_t content_hash_prefix
) {
  impl_->asset_operation_error = "invalid-asset";
  const daw_audio_core_handle active_core = impl_->active_core.load(std::memory_order_acquire);
  if (impl_->publication_in_flight != 0) {
    impl_->asset_operation_error = "asset-publication-pending"; return false;
  }
  if (active_core == 0
    || asset_id == 0 || frame_count == 0 || sample_rate_hz == 0
    || channel_count == 0 || channel_count > kMaximumAssetChannels
    || frame_count > std::numeric_limits<std::size_t>::max() / channel_count
    || frame_count * channel_count > std::numeric_limits<std::size_t>::max() / sizeof(float)) return false;
  if (const auto found = impl_->assets.find(asset_id); found != impl_->assets.end()) {
    auto& asset = found->second;
    if (!asset.mapped || asset.frame_count != frame_count || asset.sample_rate_hz != sample_rate_hz
      || asset.channel_count != channel_count || asset.content_hash_prefix != content_hash_prefix) {
      impl_->asset_operation_error = "asset-identity-conflict"; return false;
    }
    impl_->ReuseAsset(asset);
    impl_->asset_operation_error = {};
    return true;
  }
  impl_->ReclaimAssets();
  if (impl_->assets.size() >= kMaximumInstalledAssets) {
    impl_->asset_operation_error = "asset-capacity-exceeded"; return false;
  }
  const std::size_t byte_length = static_cast<std::size_t>(frame_count)
    * channel_count * sizeof(float);
  char template_path[] = "/tmp/daw-native-asset-XXXXXX";
  const int file_descriptor = mkstemp(template_path);
  if (file_descriptor < 0) return false;
  unlink(template_path);
  if (byte_length > static_cast<std::size_t>(std::numeric_limits<off_t>::max())) {
    close(file_descriptor);
    return false;
  }
  if (ftruncate(file_descriptor, static_cast<off_t>(byte_length)) != 0) {
    close(file_descriptor);
    return false;
  }
  void* address = mmap(nullptr, byte_length, PROT_READ | PROT_WRITE, MAP_SHARED, file_descriptor, 0);
  if (address == MAP_FAILED) {
    close(file_descriptor);
    return false;
  }
  auto mapped = std::make_unique<Impl::InstalledAsset::MappedStorage>();
  mapped->file_descriptor = file_descriptor;
  mapped->address = address;
  mapped->byte_length = byte_length;
  Impl::InstalledAsset asset{
    .mapped = std::move(mapped),
    .frame_count = frame_count,
    .sample_rate_hz = sample_rate_hz,
    .channel_count = channel_count,
    .content_hash_prefix = content_hash_prefix,
    .staged_revision = impl_->prepared_revision.load(std::memory_order_acquire),
  };
  asset.planes.fill(nullptr);
  auto* samples = static_cast<float*>(asset.mapped->address);
  for (std::uint32_t channel = 0; channel < channel_count; ++channel) {
    asset.planes[channel] = samples + static_cast<std::size_t>(channel) * static_cast<std::size_t>(frame_count);
  }
  const auto [asset_iterator, inserted] = impl_->assets.emplace(asset_id, std::move(asset));
  if (!inserted) return false;
  auto& stored = asset_iterator->second;
  const daw_audio_mapped_asset_descriptor descriptor{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .revision = stored.staged_revision != 0 ? stored.staged_revision : impl_->active_revision.load(std::memory_order_acquire),
    .byte_length = byte_length,
    .content_hash_prefix = content_hash_prefix,
    .frame_count = frame_count,
    .sample_rate_hz = sample_rate_hz,
    .channel_count = channel_count,
    .planes = stored.planes.data(),
  };
  if (daw_audio_core_create_mapped_asset(active_core, &descriptor, &stored.handle) != DAW_AUDIO_CORE_OK) {
    impl_->assets.erase(asset_iterator);
    return false;
  }
  impl_->asset_operation_error = {};
  return true;
}

bool AudioHost::WriteMappedAssetPage(
  const std::uint32_t asset_id,
  const std::uint64_t start_frame,
  const std::uint32_t frame_count,
  const std::span<const float> samples
) {
  impl_->asset_operation_error = "invalid-asset-page";
  if (impl_->publication_in_flight != 0) {
    impl_->asset_operation_error = "asset-publication-pending"; return false;
  }
  const auto asset_iterator = impl_->assets.find(asset_id);
  if (asset_iterator == impl_->assets.end() || !asset_iterator->second.mapped
    || asset_iterator->second.mapped->locked_bytes != 0
    || asset_iterator->second.mapped->instrument_published
    || frame_count == 0 || start_frame >= asset_iterator->second.frame_count
    || frame_count > asset_iterator->second.frame_count - start_frame
    || samples.size() != static_cast<std::size_t>(frame_count) * asset_iterator->second.channel_count
    || !std::all_of(samples.begin(), samples.end(), [](const float sample) { return std::isfinite(sample); })) return false;
  auto& asset = asset_iterator->second;
  // Existing mapped pages are immutable once they can have readers. Hydration
  // adds disjoint pages; a repeated page is an idempotent read-only comparison.
  const auto end = start_frame + frame_count;
  const bool overlap = std::any_of(asset.mapped->written_ranges.begin(), asset.mapped->written_ranges.end(),
    [start_frame, end](const auto range) { return range.first < end && start_frame < range.second; });
  bool identical = false;
  if (overlap) {
    const auto* source = static_cast<const float*>(asset.mapped->address);
    for (std::uint32_t channel = 0; channel < asset.channel_count; ++channel) {
      if (!std::equal(samples.begin() + static_cast<std::size_t>(channel) * frame_count,
        samples.begin() + static_cast<std::size_t>(channel + 1) * frame_count,
        source + static_cast<std::size_t>(channel) * asset.frame_count + start_frame)) {
        impl_->asset_operation_error = "asset-page-identity-conflict";
        return false;
      }
    }
    identical = true;
  }
  const std::uint64_t end_frame = start_frame + frame_count;
  auto& ranges = asset.mapped->written_ranges;
  std::vector<std::pair<std::uint64_t, std::uint64_t>> merged;
  merged.reserve(ranges.size() + 1);
  std::uint64_t merged_start = start_frame;
  std::uint64_t merged_end = end_frame;
  bool inserted = false;
  for (const auto [range_start, range_end] : ranges) {
    if (range_end < merged_start) {
      merged.emplace_back(range_start, range_end);
    } else if (merged_end < range_start) {
      if (!inserted) {
        merged.emplace_back(merged_start, merged_end);
        inserted = true;
      }
      merged.emplace_back(range_start, range_end);
    } else {
      merged_start = std::min(merged_start, range_start);
      merged_end = std::max(merged_end, range_end);
    }
  }
  if (!inserted) merged.emplace_back(merged_start, merged_end);
  if (merged.size() > kMaximumMappedAssetWrittenRanges) {
    impl_->asset_operation_error = "asset-page-capacity-exceeded";
    return false;
  }
  auto* destination = static_cast<float*>(asset.mapped->address) + static_cast<std::size_t>(start_frame);
  for (std::uint32_t channel = 0; channel < asset.channel_count && !identical; ++channel) {
    std::memcpy(destination + static_cast<std::size_t>(channel) * static_cast<std::size_t>(asset.frame_count),
      samples.data() + static_cast<std::size_t>(channel) * frame_count,
      static_cast<std::size_t>(frame_count) * sizeof(float));
  }
  ranges = std::move(merged);
  impl_->asset_operation_error = {};
  return true;
}

bool AudioHost::PrepareMappedAssetRange(
  const std::uint32_t asset_id,
  const std::uint64_t start_frame,
  const std::uint64_t frame_count
) {
  const auto asset_iterator = impl_->assets.find(asset_id);
  if (asset_iterator == impl_->assets.end() || !asset_iterator->second.mapped
    || frame_count == 0 || start_frame >= asset_iterator->second.frame_count
    || frame_count > asset_iterator->second.frame_count - start_frame) return false;
  const auto& ranges = asset_iterator->second.mapped->written_ranges;
  const std::uint64_t end_frame = start_frame + frame_count;
  const bool covered = std::any_of(ranges.begin(), ranges.end(), [start_frame, end_frame](const auto range) {
    return range.first <= start_frame && range.second >= end_frame;
  });
  if (!covered) return false;
  auto& asset = asset_iterator->second;
  const auto byte_offset = static_cast<std::size_t>(start_frame) * sizeof(float);
  const auto byte_length = static_cast<std::size_t>(frame_count) * sizeof(float);
  for (std::uint32_t channel = 0; channel < asset.channel_count; ++channel) {
    auto* address = static_cast<std::uint8_t*>(asset.mapped->address)
      + (static_cast<std::size_t>(channel) * static_cast<std::size_t>(asset.frame_count) * sizeof(float))
      + byte_offset;
    static_cast<void>(madvise(address, byte_length, MADV_WILLNEED));
  }
  return true;
}

std::string_view AudioHost::assetOperationError() const { return impl_->asset_operation_error; }

bool AudioHost::ReleaseAsset(const std::uint32_t asset_id) {
  const auto asset = impl_->assets.find(asset_id);
  if (asset == impl_->assets.end()) return true;
  asset->second.release_requested = true;
  impl_->asset_retirement_pending.store(true, std::memory_order_release);
  impl_->ReclaimAssets();
  return true;
}

bool AudioHost::SetTransport(
  const std::uint32_t epoch,
  const bool running,
  const std::int64_t frame,
  const double bpm,
  const std::uint32_t time_signature_numerator,
  const std::uint32_t time_signature_denominator,
  const bool cycle_active,
  const double cycle_start_sec,
  const double cycle_end_sec,
  const std::uint64_t transition_id
) {
  const daw_audio_core_handle active_core = impl_->active_core.load(std::memory_order_acquire);
  const auto lifecycle = impl_->state.load(std::memory_order_acquire);
  const bool configured_offline_host = lifecycle == LifecycleState::kConfigured
    && impl_->config.device_uid == "offline:render";
  if ((running && lifecycle != LifecycleState::kRunning && !configured_offline_host)
    || active_core == 0 || frame < 0 || epoch == 0
    || (bpm != 0.0 && (!std::isfinite(bpm) || bpm <= 0.0))
    || time_signature_numerator > 32 || time_signature_denominator > 32
    || (time_signature_numerator == 0) != (time_signature_denominator == 0)
    || (cycle_active && (
      !std::isfinite(cycle_start_sec) || !std::isfinite(cycle_end_sec)
      || cycle_start_sec < 0.0 || cycle_end_sec <= cycle_start_sec
    ))) return false;
  const auto sample_rate = static_cast<double>(impl_->config.sample_rate_hz);
  const auto cycle_start_frame = cycle_active
    ? static_cast<std::int64_t>(std::llround(cycle_start_sec * sample_rate)) : 0;
  const auto cycle_end_frame = cycle_active
    ? static_cast<std::int64_t>(std::llround(cycle_end_sec * sample_rate)) : 0;
  if (cycle_active && cycle_end_frame <= cycle_start_frame) return false;
  const auto previous_epoch = impl_->last_queued_transport_epoch.load(std::memory_order_acquire);
  const auto previous_transition = impl_->last_queued_transport_transition_id.load(std::memory_order_acquire);
  const auto effective_transition = transition_id == 0 ? previous_transition + 1 : transition_id;
  if (epoch < previous_epoch || effective_transition < previous_transition) return false;
  // Reusing the running transition with an explicit musical context updates
  // only the prepared bank's context. The publication callback supplies its
  // seam frame, so IPC latency cannot turn this into a running locate.
  const bool context_only = transition_id != 0 && effective_transition == previous_transition
    && epoch == previous_epoch && running && bpm > 0.0
    && impl_->transport_running.load(std::memory_order_acquire);
  if (context_only && impl_->prepared_core != 0) {
    if (impl_->publication_in_flight != 0) return false;
    impl_->prepared_transport_context = Impl::TransportCommand{
      .epoch = epoch, .running = running, .frame = frame, .bpm = bpm,
      .time_signature_numerator = time_signature_numerator,
      .time_signature_denominator = time_signature_denominator,
      .cycle_active = cycle_active, .cycle_start_frame = cycle_start_frame,
      .cycle_end_frame = cycle_end_frame, .transition_id = effective_transition,
    };
    return true;
  }
  if (effective_transition == previous_transition) {
    return epoch == previous_epoch
      && impl_->transport_running.load(std::memory_order_acquire) == running
      && impl_->transport_frame.load(std::memory_order_acquire) == frame;
  }
  const auto transport_write = impl_->transport_queue.write.load(std::memory_order_relaxed);
  const auto transport_read = impl_->transport_queue.read.load(std::memory_order_acquire);
  if (transport_write - transport_read >= Impl::kTransportQueueCapacity) return false;
  if (impl_->publication_in_flight != 0) {
    const auto cancelled = impl_->publish_requested_revision.exchange(0, std::memory_order_acq_rel);
    if (cancelled != 0) impl_->publication_in_flight = 0;
    else if (InspectGraphRevision(impl_->publication_in_flight).code == GraphRevisionStatusCode::kPublishPending) return false;
  }
  if (impl_->prepared_core != 0) {
    const auto prepared = impl_->prepared_revision.load(std::memory_order_acquire);
    if (RollbackGraphRevision(prepared).code != GraphRevisionStatusCode::kRolledBack) return false;
  }
  if (!Impl::EnqueueTransportCommand(impl_->transport_queue, {
    .epoch = epoch,
    .running = running,
    .frame = frame,
    .bpm = bpm,
    .time_signature_numerator = time_signature_numerator,
    .time_signature_denominator = time_signature_denominator,
    .cycle_active = cycle_active,
    .cycle_start_frame = cycle_start_frame,
    .cycle_end_frame = cycle_end_frame,
    .transition_id = effective_transition,
  })) return false;
  impl_->last_queued_transport_epoch.store(epoch, std::memory_order_release);
  impl_->last_queued_transport_transition_id.store(effective_transition, std::memory_order_release);
  impl_->transport_epoch.store(epoch, std::memory_order_release);
  impl_->transport_frame.store(frame, std::memory_order_release);
  impl_->transport_running.store(running, std::memory_order_release);
  impl_->transport_prepared = true;
  return true;
}

bool AudioHost::ConfigureRecording(const RecordingConfig& config, SpoolRequest request) {
  std::lock_guard lock(impl_->recording_owner_mutex);
  if (!impl_->recording_spool || impl_->state.load(std::memory_order_acquire) != LifecycleState::kRunning
    || config.generation == 0 || config.session_id == 0 || config.channel_count == 0 || config.channel_count > 2
    || !std::isfinite(config.gain) || config.gain < 0 || (config.polarity != 1 && config.polarity != -1)
    || config.device_uid.empty() || config.punch_start_frame < 0
    || (config.punch_end_frame != -1 && config.punch_end_frame < config.punch_start_frame)) return false;
  // A take binds only a node the plan in force has, and one a prepared revision does not drop or reroute.
  if (config.target_node_id != 0
    && (!impl_->published_routing || !PlanContainsNode(*impl_->published_routing, config.target_node_id)
      || (impl_->prepared_routing
        && !CaptureTargetKept(*impl_->published_routing, *impl_->prepared_routing, config.target_node_id)))) return false;
  if (impl_->recording_session) {
    const auto state = impl_->recording_session->Snapshot().state;
    if (state == SpoolState::kPreparing || state == SpoolState::kReady) return false;
  }
  for (std::uint32_t channel = 0; channel < config.channel_count; ++channel) if (config.input_channels[channel] >= 64) return false;
  request.capture = {.abi_version = DAW_AUDIO_CORE_ABI_VERSION, .generation = config.generation,
    .session_id = config.session_id, .channel_count = config.channel_count,
    .input_channels = {config.input_channels[0], config.input_channels[1]}, .gain = config.gain,
    .polarity = config.polarity, .punch_start_frame = config.punch_start_frame, .punch_end_frame = config.punch_end_frame};
  auto session = impl_->recording_spool->Start(std::move(request));
  if (!session) return false;
  if (impl_->recording_device_session)
    impl_->recording_device->Stop(std::exchange(impl_->recording_device_session, nullptr));
  impl_->recording_capture.store(0, std::memory_order_release);
  impl_->recording_session = std::move(session);
  impl_->recording_config = config;
  impl_->recording_finish_accepted = false;
  impl_->recording_capture_retired = false;
  impl_->recording_input_failed = false;
  impl_->recording_rate = 0;
  impl_->recording_device_lost.store(false, std::memory_order_release);
  impl_->recording_started.store(false, std::memory_order_release);
  impl_->recording_monitoring.store(config.monitoring, std::memory_order_release);
  impl_->recording_channel_count.store(config.channel_count, std::memory_order_release);
  impl_->recording_monitor_read.store(0, std::memory_order_release);
  impl_->recording_monitor_write.store(0, std::memory_order_release);
  impl_->recording_command.store(Impl::RecordingCommand::kNone, std::memory_order_release);
  impl_->recording_punch_start_frame.store(config.punch_start_frame, std::memory_order_release);
  impl_->recording_input_frame.store(impl_->transport_frame.load(std::memory_order_acquire), std::memory_order_release);
  impl_->NotifyRecordingStatus();
  return true;
}

void AudioHost::AdvanceRecording() {
  std::lock_guard lock(impl_->recording_owner_mutex);
  const auto session = impl_->recording_session;
  if (!session) return;
  const auto snapshot = session->Snapshot();
  if (snapshot.state == SpoolState::kReady && !impl_->recording_finish_accepted
    && !impl_->recording_capture_retired
    && !impl_->recording_input_failed && impl_->recording_capture.load(std::memory_order_acquire) == 0) {
    std::uint32_t channels = 0;
    for (std::uint32_t index = 0; index < impl_->recording_config.channel_count; ++index)
      channels = std::max(channels, impl_->recording_config.input_channels[index] + 1);
    if (!impl_->recording_device->Start(impl_->recording_config.device_uid, impl_->config.sample_rate_hz,
      channels, this, &impl_->recording_device_session)) impl_->recording_input_failed = true;
    else {
      impl_->recording_rate = impl_->recording_device->Rate(impl_->recording_config.device_uid);
      if (impl_->recording_rate != impl_->config.sample_rate_hz) impl_->recording_input_failed = true;
    }
    if (impl_->recording_input_failed) {
      if (impl_->recording_device_session) impl_->recording_device->Stop(std::exchange(impl_->recording_device_session, nullptr));
      session->Abandon();
    } else impl_->recording_capture.store(session->CaptureHandle(), std::memory_order_release);
  }
  if (impl_->recording_device_lost.load(std::memory_order_acquire)) {
    if (impl_->recording_device_session) impl_->recording_device->Stop(std::exchange(impl_->recording_device_session, nullptr));
    impl_->recording_started.store(false, std::memory_order_release);
    impl_->recording_input_failed = true;
    session->Abandon();
  }
  if (snapshot.state == SpoolState::kFailed || snapshot.state == SpoolState::kCancelled
    || snapshot.state == SpoolState::kComplete) {
    if (impl_->recording_device_session)
      impl_->recording_device->Stop(std::exchange(impl_->recording_device_session, nullptr));
    impl_->recording_started.store(false, std::memory_order_release);
    impl_->recording_capture.store(0, std::memory_order_release);
    impl_->recording_capture_retired = true;
  }
  // Scalar observer wake only; do not signal StatusSignal again (self-wake loop).
  {
    std::lock_guard wait_lock(impl_->recording_wait_mutex);
    impl_->recording_status_revision.fetch_add(1, std::memory_order_release);
  }
  impl_->recording_wait.notify_all();
}

bool AudioHost::StartRecording() {
  std::lock_guard lock(impl_->recording_owner_mutex);
  if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kRunning
    || !impl_->recording_session || impl_->recording_session->Snapshot().state != SpoolState::kReady
    || impl_->recording_input_failed || impl_->recording_capture.load(std::memory_order_acquire) == 0
    || impl_->recording_started.load(std::memory_order_acquire) || impl_->recording_finish_accepted) return false;
  const auto start = impl_->transport_frame.load(std::memory_order_acquire);
  impl_->recording_input_frame.store(start, std::memory_order_release);
  impl_->recording_timeline_start_frame.store(std::max(start, impl_->recording_punch_start_frame.load()), std::memory_order_release);
  impl_->recording_started.store(true, std::memory_order_release);
  impl_->NotifyRecordingStatus();
  return true;
}

bool AudioHost::StopRecording(const std::optional<std::int64_t> stop_frame) {
  std::lock_guard lock(impl_->recording_owner_mutex);
  if (!impl_->recording_session || !impl_->recording_started.load(std::memory_order_acquire)
    || impl_->recording_finish_accepted || (stop_frame && *stop_frame < 0)) return false;
  // StopCoreAudioDevice synchronously quiesces the sole producer. Finalize only
  // afterwards; callback logic remains unchanged and never sees these IO locks.
  if (impl_->recording_device_session) impl_->recording_device->Stop(std::exchange(impl_->recording_device_session, nullptr));
  const auto capture = impl_->recording_capture.load(std::memory_order_acquire);
  impl_->recording_started.store(false, std::memory_order_release);
  if (daw_audio_recording_capture_finalize(capture, stop_frame.value_or(impl_->recording_input_frame.load())) != DAW_AUDIO_CORE_OK) return false;
  daw_audio_recording_capture_diagnostics diagnostics{};
  if (daw_audio_recording_capture_get_diagnostics(capture, &diagnostics) != DAW_AUDIO_CORE_OK) return false;
  impl_->recording_finish_accepted = impl_->recording_session->Finish(diagnostics.captured_frames);
  impl_->NotifyRecordingStatus();
  return impl_->recording_finish_accepted;
}

bool AudioHost::CancelRecording() {
  std::lock_guard lock(impl_->recording_owner_mutex);
  if (!impl_->recording_session) return true;
  if (impl_->recording_finish_accepted) return false;
  impl_->recording_capture_retired = true;
  if (impl_->recording_device_session) impl_->recording_device->Stop(std::exchange(impl_->recording_device_session, nullptr));
  impl_->recording_started.store(false, std::memory_order_release);
  const auto capture = impl_->recording_capture.load(std::memory_order_acquire);
  if (capture) static_cast<void>(daw_audio_recording_capture_cancel(capture));
  const bool accepted = impl_->recording_session->Abandon();
  impl_->NotifyRecordingStatus();
  return accepted;
}

void AudioHost::NotifyRecordingDeviceLost() {
  impl_->recording_device_lost.store(true, std::memory_order_release);
  impl_->NotifyRecordingStatus();
}

void AudioHost::NotifyOutputDeviceLost() {
  auto expected = LifecycleState::kRunning;
  if (impl_->state.compare_exchange_strong(expected, LifecycleState::kFaulted,
      std::memory_order_acq_rel)) {
    // Wake the existing event bridge even though no further callback will run.
    // Ownership is unchanged until Stop synchronously quiesces the device.
    impl_->NotifyScheduleProgress();
  }
}

RecordingStatus AudioHost::RecordingSnapshot() const {
  std::lock_guard lock(impl_->recording_owner_mutex);
  RecordingStatus status{};
  const auto session = impl_->recording_session;
  if (!session) return status;
  status.generation = impl_->recording_config.generation;
  status.session_id = impl_->recording_config.session_id;
  status.channel_count = impl_->recording_config.channel_count;
  status.sample_rate_hz = impl_->recording_rate;
  status.timeline_frame = impl_->recording_timeline_start_frame.load();
  status.spool = session->Snapshot();
  if (status.spool.state == SpoolState::kReady && status.sample_rate_hz == 0 && !impl_->recording_input_failed)
    status.spool.state = SpoolState::kPreparing;
  status.configured = status.spool.state == SpoolState::kReady && status.sample_rate_hz != 0 && !impl_->recording_input_failed;
  status.active = impl_->recording_started.load(std::memory_order_acquire);
  status.fatal = impl_->recording_input_failed || impl_->recording_device_lost.load() || status.spool.state == SpoolState::kFailed;
  if (impl_->recording_input_failed) { status.spool.state = SpoolState::kFailed; status.spool.error = SpoolError::kCapture; }
  const auto capture = session->CaptureHandle();
  daw_audio_recording_capture_diagnostics diagnostics{};
  if (capture && daw_audio_recording_capture_get_diagnostics(capture, &diagnostics) == DAW_AUDIO_CORE_OK) {
    status.captured_frames = diagnostics.captured_frames;
    status.dropped_frames = diagnostics.dropped_frames;
    status.dropped_blocks = diagnostics.dropped_blocks;
    status.available_blocks = diagnostics.available_blocks;
    status.queued_blocks = diagnostics.queued_blocks;
    status.rms = diagnostics.rms;
    status.peak = diagnostics.peak;
    status.fatal |= diagnostics.fatal != 0;
  }
  if (const auto result = session->Result()) { status.file_device = result->file_device; status.file_inode = result->file_inode; }
  return status;
}

std::optional<RecordingMessage> AudioHost::WaitForRecordingMessage(
  const std::uint64_t revision, const std::atomic<bool>* running) {
  {
    std::unique_lock lock(impl_->recording_wait_mutex);
    impl_->recording_wait.wait(lock, [&] { return impl_->recording_status_revision.load(std::memory_order_acquire) != revision
      || (running && !running->load(std::memory_order_acquire)); });
  }
  if (running && !running->load(std::memory_order_acquire)) return std::nullopt;
  return RecordingMessage{.block = std::nullopt, .status = RecordingSnapshot()};
}

void AudioHost::WakeRecordingWait() {
  impl_->recording_wait.notify_all();
}

std::optional<WorkerNotification> AudioHost::WaitForWorkerNotification(const std::atomic<bool>* running) {
  std::unique_lock lock(impl_->worker_notifications.mutex);
  impl_->worker_notifications.ready.wait(lock, [this, running] {
    return !impl_->worker_notifications.notifications.Empty()
      || (running != nullptr && !running->load(std::memory_order_acquire));
  });
  if (impl_->worker_notifications.notifications.Empty()) return std::nullopt;
  return impl_->worker_notifications.notifications.Pop();
}

bool AudioHost::WaitForMeterBatch(const std::atomic<bool>* running) {
  std::unique_lock lock(impl_->meter_wait_mutex);
  impl_->meter_wait.wait(lock, [this, running] {
    return !impl_->meter_observer.Empty()
      || (running != nullptr && !running->load(std::memory_order_acquire));
  });
  return !impl_->meter_observer.Empty();
}

std::optional<MeterBatch> AudioHost::DrainMeterBatch() {
  MeterBatch batch{};
  bool has_context = false;
  NativeMeterObserver::Event event{};
  while (impl_->meter_observer.Pop(event)) {
    if (!has_context || event.graph_revision != batch.graph_revision || event.transport_epoch != batch.transport_epoch) {
      batch = {};
      batch.graph_revision = event.graph_revision;
      batch.transport_epoch = event.transport_epoch;
      has_context = true;
    }
    std::size_t entry_index = 0;
    while (entry_index < batch.entry_count && batch.entries[entry_index].node_id != event.node_id) ++entry_index;
    if (entry_index == batch.entry_count && batch.entry_count < kMaximumMeterEntries) {
      batch.entries[entry_index].node_id = event.node_id;
      ++batch.entry_count;
    }
    if (entry_index < batch.entry_count) {
      batch.entries[entry_index].left_rms = std::isfinite(event.left_rms) ? std::max(0.0F, event.left_rms) : 0.0F;
      batch.entries[entry_index].right_rms = std::isfinite(event.right_rms) ? std::max(0.0F, event.right_rms) : 0.0F;
    }
  }
  if (!has_context) return std::nullopt;
  batch.sequence = ++impl_->meter_sequence;
  return batch;
}

bool AudioHost::SetSpectrumNode(const std::uint64_t node_id) {
  if (node_id == impl_->spectrum_selected_node.load(std::memory_order_acquire)) return true;
  // Share publication's nonblocking ownership gate so a control-thread lookup
  // cannot bind a removed identity across the callback's graph switch.
  Impl::ControlSubmissionClaim claim{impl_->schedule_owner};
  if (!claim.acquired) return false;
  if (node_id == 0) {
    impl_->spectrum_selected_node.store(0, std::memory_order_release);
    impl_->spectrum_observer.Clear();
    impl_->spectrum_has_previous = false;
    impl_->spectrum_history_count = 0;
    return true;
  }
  if (!impl_->observation_lookups[impl_->active_observation_lookup.load(
    std::memory_order_acquire)].Contains(node_id)) return false;
  impl_->spectrum_observer.Clear();
  impl_->spectrum_has_previous = false;
  impl_->spectrum_history_count = 0;
  impl_->spectrum_selected_node.store(node_id, std::memory_order_release);
  return true;
}

bool AudioHost::WaitForSpectrumFrame(const std::atomic<bool>* running) {
  std::unique_lock lock(impl_->spectrum_wait_mutex);
  impl_->spectrum_wait.wait(lock, [this, running] {
    return !impl_->spectrum_observer.Empty()
      || (running != nullptr && !running->load(std::memory_order_acquire));
  });
  return !impl_->spectrum_observer.Empty();
}

std::optional<SpectrumFrame> AudioHost::DrainSpectrumFrame() {
  NativeSpectrumObserver::Event event{};
  NativeSpectrumObserver::Event latest{};
  bool has_event = false;
  while (impl_->spectrum_observer.Pop(event)) {
    latest = event;
    has_event = true;
    const auto count = std::min<std::uint32_t>(event.frame_count, kSpectrumFftSize);
    const auto retained = std::min<std::uint32_t>(impl_->spectrum_history_count, kSpectrumFftSize - count);
    if (retained > 0) {
      std::copy(
        impl_->spectrum_history_left.begin() + (impl_->spectrum_history_count - retained),
        impl_->spectrum_history_left.begin() + impl_->spectrum_history_count,
        impl_->spectrum_history_left.begin());
      std::copy(
        impl_->spectrum_history_right.begin() + (impl_->spectrum_history_count - retained),
        impl_->spectrum_history_right.begin() + impl_->spectrum_history_count,
        impl_->spectrum_history_right.begin());
    }
    for (std::uint32_t frame = 0; frame < count; ++frame) {
      impl_->spectrum_history_left[retained + frame] = event.left[frame];
      impl_->spectrum_history_right[retained + frame] = event.right[frame];
    }
    impl_->spectrum_history_count = retained + count;
  }
  if (!has_event) return std::nullopt;
  std::array<double, kSpectrumFftSize> real{};
  std::array<double, kSpectrumFftSize> imaginary{};
  for (std::uint32_t frame = 0; frame < kSpectrumFftSize; ++frame) {
    const double progress = static_cast<double>(frame) / static_cast<double>(kSpectrumFftSize - 1);
    const double window = 0.42 - 0.5 * std::cos(6.2831853071795864769 * progress) + 0.08 * std::cos(12.566370614359172954 * progress);
    const auto history_index = frame >= kSpectrumFftSize - impl_->spectrum_history_count
      ? frame - (kSpectrumFftSize - impl_->spectrum_history_count)
      : kSpectrumFftSize;
    const double sample = history_index < impl_->spectrum_history_count
      ? (static_cast<double>(impl_->spectrum_history_left[history_index]) + static_cast<double>(impl_->spectrum_history_right[history_index])) * 0.5
      : 0.0;
    real[frame] = sample * window;
  }
  for (std::uint32_t index = 1, reversed = 0; index < kSpectrumFftSize; ++index) {
    std::uint32_t bit = kSpectrumFftSize >> 1U;
    for (; reversed & bit; bit >>= 1U) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      std::swap(real[index], real[reversed]);
      std::swap(imaginary[index], imaginary[reversed]);
    }
  }
  for (std::uint32_t length = 2; length <= kSpectrumFftSize; length <<= 1U) {
    const double angle = -6.2831853071795864769 / static_cast<double>(length);
    const double step_real = std::cos(angle);
    const double step_imaginary = std::sin(angle);
    for (std::uint32_t start = 0; start < kSpectrumFftSize; start += length) {
      double twiddle_real = 1.0;
      double twiddle_imaginary = 0.0;
      const auto half = length / 2U;
      for (std::uint32_t offset = 0; offset < half; ++offset) {
        const auto even = start + offset;
        const auto odd = even + half;
        const double product_real = twiddle_real * real[odd] - twiddle_imaginary * imaginary[odd];
        const double product_imaginary = twiddle_real * imaginary[odd] + twiddle_imaginary * real[odd];
        real[odd] = real[even] - product_real;
        imaginary[odd] = imaginary[even] - product_imaginary;
        real[even] += product_real;
        imaginary[even] += product_imaginary;
        const double next_twiddle_real = twiddle_real * step_real - twiddle_imaginary * step_imaginary;
        twiddle_imaginary = twiddle_real * step_imaginary + twiddle_imaginary * step_real;
        twiddle_real = next_twiddle_real;
      }
    }
  }
  for (std::uint32_t bin = 0; bin < kMaximumSpectrumBins; ++bin) {
    const double scale = bin == 0 ? 1.0 / kSpectrumFftSize : 2.0 / kSpectrumFftSize;
    const double current = std::hypot(real[bin], imaginary[bin]) * scale;
    const double smoothed = impl_->spectrum_has_previous
      ? 0.7 * impl_->spectrum_smoothed[bin] + 0.3 * current : current;
    impl_->spectrum_smoothed[bin] = std::isfinite(smoothed) ? static_cast<float>(smoothed) : 0.0F;
  }
  impl_->spectrum_has_previous = true;
  SpectrumFrame output{};
  output.graph_revision = latest.graph_revision;
  output.transport_epoch = latest.transport_epoch;
  output.sequence = ++impl_->spectrum_sequence;
  output.node_id = latest.node_id;
  output.sample_rate_hz = latest.sample_rate_hz;
  output.fft_size = kSpectrumFftSize;
  output.bin_count = kMaximumSpectrumBins;
  for (std::uint32_t bin = 0; bin < kMaximumSpectrumBins; ++bin) {
    const double db = std::clamp(20.0 * std::log10(std::max<double>(impl_->spectrum_smoothed[bin], std::numeric_limits<double>::min())), -100.0, -30.0);
    output.data[bin] = static_cast<float>((db + 100.0) / 70.0);
  }
  return output;
}

bool AudioHost::WaitForScheduleProgress(const std::atomic<bool>* running) {
  std::unique_lock lock(impl_->schedule_progress_mutex);
  impl_->schedule_progress_wait.wait(lock, [this, running] {
    return impl_->schedule_progress_ready.load(std::memory_order_acquire)
      || (running != nullptr && !running->load(std::memory_order_acquire));
  });
  return impl_->schedule_progress_ready.load(std::memory_order_acquire);
}

std::optional<ScheduleProgress> AudioHost::DrainScheduleProgress() {
  if (!impl_->schedule_progress_ready.exchange(false, std::memory_order_acq_rel)) return std::nullopt;
  // Stop/completion can wake the bridge before the first successful callback.
  // Such a wake is not a populated schedule-progress snapshot.
  if (impl_->schedule_progress_sequence.load(std::memory_order_acquire) == 0) return std::nullopt;
  // Report the recorded claim's resolution once. Reading the result only for the token
  // that was acquired, and ending the claim only after that read, is what keeps the
  // callback from overwriting a result that has not been reported (no torn pair).
  const auto claim = impl_->claimed_processor_patch.Recorded();
  if (claim != 0 && claim != impl_->last_reported_patch.token
    && impl_->processor_patch_acknowledged.load(std::memory_order_acquire) == claim) {
    impl_->last_reported_patch = {claim, impl_->processor_patch_result.load(std::memory_order_relaxed)};
    impl_->processor_patch_reported_token.store(claim, std::memory_order_release);
  }
  const auto instrument_write = impl_->instrument_queue.write.load(std::memory_order_acquire);
  const auto instrument_read = impl_->instrument_queue.read.load(std::memory_order_acquire);
  const auto source_write = impl_->ActiveSchedule().source_queue.write.load(std::memory_order_acquire);
  const auto source_read = impl_->ActiveSchedule().source_queue.read.load(std::memory_order_acquire);
  std::uint32_t automation_credits = 0;
  for (const auto& [instance_id, attachment] : impl_->native_vst_attachments) {
    const auto& automation = attachment->automation_banks[impl_->active_schedule_bank.load(std::memory_order_acquire)];
    const auto used = automation.count.load(std::memory_order_acquire);
    automation_credits += static_cast<std::uint32_t>(
      automation.segments[0].size() - std::min<std::uint32_t>(
        used,
        static_cast<std::uint32_t>(automation.segments[0].size())
      )
    );
  }
  return ScheduleProgress{
    .admission_capacity_generation = impl_->admission_capacity_generation.load(std::memory_order_acquire),
    .latency_completion_generation = impl_->latency_completion_generation.load(std::memory_order_acquire),
    .revision = impl_->schedule_progress_revision.load(std::memory_order_acquire),
    .epoch = impl_->schedule_progress_epoch.load(std::memory_order_acquire),
    .progress_sequence = impl_->schedule_progress_sequence.load(std::memory_order_acquire),
    .rendered_through_frame = impl_->schedule_progress_rendered_frame.load(std::memory_order_acquire),
    .accepted_through_frame = impl_->schedule_progress_accepted_frame.load(std::memory_order_acquire),
    .last_accepted_window_id = impl_->schedule_progress_window_id.load(std::memory_order_acquire),
    .applied_transport_transition_id = impl_->schedule_progress_applied_transition.load(std::memory_order_acquire),
    .applied_urgent_sequence = impl_->schedule_progress_urgent.load(std::memory_order_acquire),
    .applied_processor_sequence = impl_->schedule_progress_processor.load(std::memory_order_acquire),
    .running = impl_->schedule_progress_running.load(std::memory_order_acquire),
    .schedule_complete = impl_->schedule_progress_complete.load(std::memory_order_acquire),
    .instrument_credits = Impl::kInstrumentQueueCapacity - std::min<std::uint32_t>(
      Impl::kInstrumentQueueCapacity,
      instrument_write - instrument_read
    ),
    .source_credits = Impl::kSourceQueueCapacity - std::min<std::uint32_t>(
      Impl::kSourceQueueCapacity,
      source_write - source_read
    ),
    .automation_credits = automation_credits,
    .processor_patch_resolved_token = impl_->last_reported_patch.token,
    .processor_patch_resolved_result = impl_->last_reported_patch.result,
  };
}

void AudioHost::WakeWorkerNotificationWait() {
  impl_->worker_notifications.ready.notify_all();
}

void AudioHost::WakeMeterWait() {
  impl_->meter_wait.notify_all();
}
void AudioHost::WakeSpectrumWait() {
  impl_->spectrum_wait.notify_all();
}

void AudioHost::WakeScheduleProgressWait() {
  impl_->schedule_progress_wait.notify_all();
}

std::uint64_t AudioHost::recordingStatusRevision() const {
  return impl_->recording_status_revision.load(std::memory_order_acquire);
}

std::uint64_t AudioHost::appliedUrgentSequence() const {
  return impl_->applied_urgent_sequence.load(std::memory_order_acquire);
}

bool AudioHost::AttachNativeVst(const NativeVstAttachment& attachment) {
  NativeVstAttachment normalized = attachment;
  impl_->ReclaimRetiredNativeVsts();
  if (!ValidNativeVstAttachment(normalized)) return false;
  if (const auto held = impl_->native_vst_attachments.find(normalized.instance_id);
    held != impl_->native_vst_attachments.end()) {
    if (impl_->RejoinParkedNativeVst(*held->second, normalized)) return true;
    if (!held->second->Detached()) return false;
    // A parked or retired object that cannot be reused is moved aside, still owned until
    // reclaimed, so the instance ID is free for the new load.
    auto superseded = impl_->native_vst_attachments.extract(held);
    impl_->RetireNativeVst(*superseded.mapped());
    superseded.key() = "superseded:" + std::to_string(++impl_->superseded_vst_ordinal);
    impl_->native_vst_attachments.insert(std::move(superseded));
  }
  if (impl_->native_vst_attachments.size() >= kMaximumNativeVstAttachments) return false;
  auto worker_attachment = std::make_unique<NativeVstWorkerAttachment>();
  worker_attachment->active_schedule_bank = &impl_->active_schedule_bank;
  worker_attachment->metadata = normalized;
  worker_attachment->notification_sink = &impl_->worker_notifications;
  worker_attachment->offline_failure = &impl_->offline_failure;
  // Added to a graph that is already live, the instance waits for a published revision to bind it.
  if (impl_->graph_prepared) worker_attachment->ownership = NativeVstWorkerAttachment::Ownership::kStaged;
  auto* const staged = worker_attachment.get();
  impl_->native_vst_attachments.emplace(normalized.instance_id, std::move(worker_attachment));
  if (impl_->native_worker_mode && staged->metadata.playback_enabled) {
    // A spawn failure leaves the instance not ready, so no revision binds it.
    if (const auto executable = WorkerExecutablePath()) {
      static_cast<void>(impl_->StartNativeVstWorker(staged, *impl_->native_worker_mode, *executable));
    }
  }
  return true;
}

std::optional<NativeVstWorkerHealth> AudioHost::NativeVstHealth(const std::string_view instance_id) const {
  const auto attachment = impl_->native_vst_attachments.find(std::string(instance_id));
  if (attachment == impl_->native_vst_attachments.end()) return std::nullopt;
  switch (attachment->second->worker.health()) {
    case daw::plugin_host::WorkerHealth::kStarting: return NativeVstWorkerHealth::kStarting;
    case daw::plugin_host::WorkerHealth::kReady: return NativeVstWorkerHealth::kReady;
    case daw::plugin_host::WorkerHealth::kStopping: return NativeVstWorkerHealth::kStopping;
    case daw::plugin_host::WorkerHealth::kStopped: return NativeVstWorkerHealth::kStopped;
    case daw::plugin_host::WorkerHealth::kFaulted: return NativeVstWorkerHealth::kFaulted;
  }
  return std::nullopt;
}

std::optional<NativeVstEditorStatus> AudioHost::ExecuteNativeVstEditorCommand(
  const std::string_view instance_id,
  const NativeVstEditorCommand command,
  const std::uint32_t width,
  const std::uint32_t height,
  const std::optional<NativeVstEditorAnchor> anchor
) {
  const auto attachment = impl_->native_vst_attachments.find(std::string(instance_id));
  if (attachment == impl_->native_vst_attachments.end()) return std::nullopt;
  if (!attachment->second->metadata.playback_enabled
    || attachment->second->worker.health() != daw::plugin_host::WorkerHealth::kReady) {
    return NativeVstEditorStatus{.owned = true};
  }
  const auto workerCommand = static_cast<daw::plugin_host::WorkerControlCommand>(
    static_cast<std::uint32_t>(command) + static_cast<std::uint32_t>(daw::plugin_host::WorkerControlCommand::kEditorOpen) - 1U
  );
  const auto response = attachment->second->worker.ExecuteEditorCommand(
    workerCommand,
    width,
    height,
    anchor
      ? std::optional<daw::plugin_host::WorkerEditorAnchor>(
        daw::plugin_host::WorkerEditorAnchor{.x = anchor->x, .y = anchor->y})
      : std::nullopt
  );
  if (!response) return std::nullopt;
  return NativeVstEditorStatus{
    .success = response->success,
    .owned = true,
    .supported = response->status.supported,
    .open = response->status.open,
    .width = response->status.width,
    .height = response->status.height,
  };
}

bool AudioHost::DetachVstReference(const std::string_view instance_id) {
  const auto attachment = impl_->native_vst_attachments.find(std::string(instance_id));
  if (attachment == impl_->native_vst_attachments.end()) return false;
  auto& detached = *attachment->second;
  if (detached.Detached() || detached.worker.health() != daw::plugin_host::WorkerHealth::kReady) {
    impl_->RetireNativeVst(detached);
  } else {
    impl_->ParkNativeVst(detached);
  }
  impl_->ReclaimRetiredNativeVsts();
  return true;
}

bool AudioHost::Start() {
  impl_->Evidence("device-start-request");
  if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kConfigured || impl_->config.device_uid.empty()
    || !impl_->graph_prepared || !impl_->transport_prepared) return false;
  if (!impl_->StartNativeVstWorkers(daw::plugin_host::WorkerProcessSetup::Mode::kRealtime)) return false;
  impl_->strict_offline_export = false;
  // CoreAudio may invoke the IO callback synchronously while the device is
  // being started. Publish the running state before opening the device so
  // that the first callback is processed rather than counted as rejected.
  impl_->state.store(LifecycleState::kRunning, std::memory_order_release);
  if (!StartCoreAudioDevice(
    impl_->config.device_uid,
    impl_->config.sample_rate_hz,
    impl_->config.channel_count,
    this,
    &impl_->device_session)) {
    impl_->state.store(LifecycleState::kConfigured, std::memory_order_release);
    impl_->StopNativeVstWorkers();
    return false;
  }
  if (daw::acceptance::Enabled()) {
    char fields[256];
    std::snprintf(fields, sizeof(fields), ",\"deviceSession\":\"%d-%p\",\"sampleRate\":%u,\"blockSize\":%u",
      getpid(), impl_->device_session, impl_->config.sample_rate_hz, impl_->config.max_frames_per_block);
    daw::acceptance::Event("device-session", fields);
  }
  return true;
}

bool AudioHost::StartOffline() {
  if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kConfigured
    || !impl_->graph_prepared || !impl_->transport_prepared) return false;
  if (!impl_->StartNativeVstWorkers(daw::plugin_host::WorkerProcessSetup::Mode::kOffline)) return false;
  impl_->strict_offline_export = impl_->config.device_uid == "offline:render";
  impl_->state.store(LifecycleState::kRunning, std::memory_order_release);
  return true;
}

bool AudioHost::StartDiagnosticMode() {
  if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kConfigured) return false;
  if (!impl_->StartNativeVstWorkers(daw::plugin_host::WorkerProcessSetup::Mode::kRealtime)) return false;
  impl_->strict_offline_export = false;
  impl_->state.store(LifecycleState::kRunning, std::memory_order_release);
  return true;
}

void AudioHost::Stop(const std::string& reason) {
  using Clock = std::chrono::steady_clock;
  const auto stop_started = Clock::now();
  const auto log_stage = [&](const char* stage, const char* phase, const Clock::time_point started) {
    const auto now = Clock::now();
    const auto elapsed = std::chrono::duration_cast<std::chrono::microseconds>(now - started).count();
    const auto total = std::chrono::duration_cast<std::chrono::microseconds>(now - stop_started).count();
    std::fprintf(stderr, "[native-audio-host-stop] phase=%s stage=%s elapsed_us=%lld total_us=%lld reason=%s\n",
      phase, stage, static_cast<long long>(elapsed), static_cast<long long>(total), reason.c_str());
  };
  impl_->Evidence("device-stop");
  const LifecycleState state = impl_->state.load(std::memory_order_acquire);
  std::fprintf(stderr,
    "[native-audio-host-stop] phase=entry reason=%s lifecycle=%u device=%p recording_device=%p recording_active=%u vst_attachments=%zu\n",
    reason.c_str(), static_cast<unsigned int>(state), impl_->device_session, impl_->recording_device_session,
    impl_->recording_started.load(std::memory_order_acquire) ? 1U : 0U, impl_->native_vst_attachments.size());
  if (state != LifecycleState::kRunning && state != LifecycleState::kFaulted) {
    if (impl_->prepared_core != 0)
      static_cast<void>(RollbackGraphRevision(impl_->prepared_revision.load(std::memory_order_acquire)));
    const auto stage_started = Clock::now();
    impl_->ClearScheduledLanes();
    log_stage("schedule-clear", "end", stage_started);
    return;
  }
  if (impl_->device_session != nullptr) {
    const auto stage_started = Clock::now();
    std::fprintf(stderr, "[native-audio-host-stop] phase=begin stage=coreaudio-output-stop reason=%s\n", reason.c_str());
    StopCoreAudioDevice(impl_->device_session);
    impl_->device_session = nullptr;
    log_stage("coreaudio-output-stop", "end", stage_started);
  }
  // The device reader is quiescent. Settle an already-published graph before
  // cancelling unpublished state, so its asset ownership cannot be forgotten.
  if (impl_->publication_in_flight != 0) {
    if (impl_->publish_requested_revision.exchange(0, std::memory_order_acq_rel) != 0)
      impl_->publication_in_flight = 0;
    else static_cast<void>(InspectGraphRevision(impl_->publication_in_flight));
  }
  {
    const auto stage_started = Clock::now();
    std::fprintf(stderr, "[native-audio-host-stop] phase=begin stage=recording-cleanup reason=%s\n", reason.c_str());
    std::lock_guard lock(impl_->recording_owner_mutex);
    impl_->recording_capture_retired = true;
    if (impl_->recording_device_session) impl_->recording_device->Stop(std::exchange(impl_->recording_device_session, nullptr));
    impl_->recording_started.store(false, std::memory_order_release);
    const auto capture = impl_->recording_capture.exchange(0, std::memory_order_acq_rel);
    if (impl_->recording_session && !impl_->recording_finish_accepted) {
      if (capture) static_cast<void>(daw_audio_recording_capture_cancel(capture));
      impl_->recording_session->Abandon();
    }
    impl_->recording_monitoring.store(false, std::memory_order_release);
    impl_->recording_command.store(Impl::RecordingCommand::kNone, std::memory_order_release);
    log_stage("recording-cleanup", "end", stage_started);
  }
  const auto worker_started = Clock::now();
  std::fprintf(stderr, "[native-audio-host-stop] phase=begin stage=worker-shutdown reason=%s\n", reason.c_str());
  impl_->StopNativeVstWorkers();
  log_stage("worker-shutdown", "end", worker_started);
  const auto schedule_started = Clock::now();
  std::fprintf(stderr, "[native-audio-host-stop] phase=begin stage=schedule-clear reason=%s\n", reason.c_str());
  impl_->ClearScheduledLanes();
  log_stage("schedule-clear", "end", schedule_started);
  impl_->state.store(LifecycleState::kConfigured, std::memory_order_release);
  impl_->publish_requested_revision.store(0, std::memory_order_release);
  daw::audio_core::StopLatencyTransition(impl_->active_core.load(std::memory_order_acquire));
  impl_->publish_wait.notify_all();
  impl_->publication_in_flight = 0;
  impl_->publish_deferred_revision.store(0, std::memory_order_release);
  impl_->schedule_owner.store(0, std::memory_order_release);
  if (impl_->prepared_core != 0) {
    static_cast<void>(RollbackGraphRevision(impl_->prepared_revision.load(std::memory_order_acquire)));
  }
  impl_->SignalRealtimeBridge(Impl::kRealtimeLatencyCompleted);
  log_stage("stop-total", "end", stop_started);
}

void AudioHost::Teardown() {
  Stop();
  if (impl_->acceptance_tap) {
    impl_->StopRealtimeBridge();
    impl_->acceptance_tap.reset();
    impl_->StartRealtimeBridge();
  }
  const daw_audio_core_handle active_core = impl_->active_core.exchange(0, std::memory_order_acq_rel);
  if (active_core != 0) daw_audio_core_destroy(active_core);
  if (impl_->prepared_core != 0 && !impl_->prepared_core_is_same_core) daw_audio_core_destroy(impl_->prepared_core);
  if (impl_->retired_core != 0) daw_audio_core_destroy(impl_->retired_core);
  impl_->prepared_core = 0;
  impl_->retired_core = 0;
  impl_->retired_same_core = false;
  impl_->assets.clear();
  impl_->published_instrument_assets.clear();
  impl_->prepared_instrument_assets.clear();
  impl_->published_routing.reset();
  impl_->prepared_routing.reset();
  impl_->prepared_asset_handles.clear();
  impl_->native_vst_attachments.clear();
  impl_->active_revision.store(0, std::memory_order_release);
  impl_->prepared_revision.store(0, std::memory_order_release);
  impl_->retired_revision.store(0, std::memory_order_release);
  impl_->transport_epoch.store(0, std::memory_order_release);
  impl_->transport_frame.store(0, std::memory_order_release);
  impl_->transport_running.store(false, std::memory_order_release);
  impl_->ActiveSchedule().accepted_schedule_epoch.store(0, std::memory_order_release);
  impl_->ActiveSchedule().accepted_schedule_through_frame.store(0, std::memory_order_release);
  impl_->ActiveSchedule().published_schedule_window_id.store(0, std::memory_order_release);
  impl_->ActiveSchedule().schedule_complete.store(false, std::memory_order_release);
  impl_->ActiveSchedule().last_accepted_schedule_window_id = 0;
  impl_->ActiveSchedule().last_accepted_schedule_epoch = 0;
  impl_->ActiveSchedule().last_schedule_start_frame = 0;
  impl_->ActiveSchedule().schedule_digest_windows = {};
  impl_->ActiveSchedule().schedule_chunk_digests = {};
  impl_->ActiveSchedule().schedule_digest_cursor = 0;
  impl_->ActiveSchedule().schedule_staging.clear();
  impl_->processor_ramp_count = 0;
  impl_->applied_urgent_sequence.store(0, std::memory_order_release);
  impl_->applied_processor_sequence.store(0, std::memory_order_release);
  impl_->last_queued_processor_sequence.store(0, std::memory_order_release);
  impl_->schedule_progress_processor.store(0, std::memory_order_release);
  impl_->schedule_progress_notified_processor = 0;
  impl_->graph_prepared = false;
  impl_->transport_prepared = false;
  impl_->state.store(LifecycleState::kIdle, std::memory_order_release);
}

bool AudioHost::Retire(std::uint32_t revision) {
  if (impl_->state.load(std::memory_order_acquire) == LifecycleState::kRunning
    || impl_->prepared_core != 0 || impl_->HasRetiredPlan()
    || revision != impl_->active_revision.load(std::memory_order_acquire)) return false;
  const daw_audio_core_handle active_core = impl_->active_core.exchange(0, std::memory_order_acq_rel);
  if (active_core == 0) return false;
  daw_audio_core_destroy(active_core);
  impl_->active_revision.store(0, std::memory_order_release);
  impl_->state.store(LifecycleState::kIdle, std::memory_order_release);
  return true;
}

// DAW_REALTIME_CALLBACK_REGION_BEGIN audio-host
bool AudioHost::ProcessPlanar(
  std::span<const float* const> input,
  std::span<float* const> output,
  std::uint32_t frame_count) {
  const auto callback_attempt = impl_->callback_attempts.fetch_add(1, std::memory_order_relaxed) + 1;
  if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kRunning
    || impl_->active_core.load(std::memory_order_acquire) == 0
    || input.size() < impl_->config.channel_count
    || output.size() < impl_->config.channel_count) {
    impl_->RejectBlock(RejectedBlockReason::kNotRunningOrCoreUnavailable, callback_attempt);
    return false;
  }
  for (std::uint32_t channel = 0; channel < impl_->config.channel_count; ++channel) {
    if (input[channel] == nullptr || output[channel] == nullptr) {
      impl_->RejectBlock(RejectedBlockReason::kNullChannel, callback_attempt);
      return false;
    }
  }
#if defined(DAW_AUDIO_HOST_TEST_PATCH_CLAIM)
  impl_->test_patch_claim_hold_frames.fetch_sub(frame_count, std::memory_order_relaxed);
#endif
  impl_->ApplyRequestedProcessorPatch();
  const float* const* inputs = input.data();
  float* const* outputs = output.data();
  std::uint32_t offset = 0;
  while (offset < frame_count) {
    impl_->ApplyRequestedProcessorPatch();
    {
      std::uint32_t read = impl_->transport_queue.read.load(std::memory_order_relaxed);
      const std::uint32_t write = impl_->transport_queue.write.load(std::memory_order_acquire);
      while (read != write) {
        const auto command = impl_->transport_queue.commands[read % Impl::kTransportQueueCapacity];
        const auto current_epoch = impl_->applied_transport_epoch.load(std::memory_order_acquire);
        const auto current_transition = impl_->applied_transport_transition_id.load(std::memory_order_acquire);
        if (command.transition_id > current_transition && command.epoch >= current_epoch) {
          const daw_audio_transport_state state{
            .epoch = command.epoch,
            .running = command.running ? 1U : 0U,
            .frame = command.frame,
            .tempo_bpm = command.bpm,
            .time_signature_numerator = command.time_signature_numerator,
            .time_signature_denominator = command.time_signature_denominator,
            .cycle_active = command.cycle_active ? 1U : 0U,
            .cycle_start_frame = command.cycle_start_frame,
            .cycle_end_frame = command.cycle_end_frame,
          };
          const daw_audio_core_handle core = impl_->active_core.load(std::memory_order_acquire);
          const auto result = core == 0 ? DAW_AUDIO_CORE_INVALID_HANDLE : daw_audio_core_set_transport(core, &state);
          if (result != DAW_AUDIO_CORE_OK) {
            impl_->RejectBlock(RejectedBlockReason::kTransport, callback_attempt, result);
            return false;
          }
          if (impl_->ActiveSchedule().accepted_schedule_epoch.load(std::memory_order_acquire) != command.epoch) {
            impl_->ActiveSchedule().published_schedule_window_id.store(0, std::memory_order_release);
            impl_->ActiveSchedule().accepted_schedule_through_frame.store(command.frame, std::memory_order_release);
            impl_->ActiveSchedule().schedule_complete.store(false, std::memory_order_release);
            impl_->ActiveSchedule().accepted_schedule_epoch.store(command.epoch, std::memory_order_release);
          }
          impl_->applied_transport_epoch.store(command.epoch, std::memory_order_release);
          impl_->applied_transport_frame.store(command.frame, std::memory_order_release);
          impl_->applied_transport_running.store(command.running, std::memory_order_release);
          impl_->applied_transport_transition_id.store(command.transition_id, std::memory_order_release);
          if (!command.running) impl_->SignalRealtimeBridge(Impl::kRealtimeLatencyCompleted);
        }
        ++read;
      }
      impl_->transport_queue.read.store(read, std::memory_order_release);
    }
    const auto pending_revision = impl_->publish_requested_revision.load(std::memory_order_acquire);
    const auto requested_frame = pending_revision == 0 ? 0 : impl_->requested_publication_frame.load(std::memory_order_acquire);
    const auto current_frame = static_cast<std::uint64_t>(impl_->applied_transport_frame.load(std::memory_order_acquire));
    const std::uint32_t requested_revision = pending_revision != 0
      && (requested_frame == 0 || current_frame >= requested_frame)
      ? impl_->publish_requested_revision.exchange(0, std::memory_order_acq_rel) : 0;
    std::uint32_t unowned_schedule = 0;
    const bool schedule_claimed = requested_revision != 0 && impl_->schedule_owner.compare_exchange_strong(
      unowned_schedule, 2, std::memory_order_acq_rel);
    // Complete windows are sorted, so instrument/processor heads suffice.
    // Legacy direct source commands share the source lane without ordering;
    // inspect its bounded capacity rather than let a future head hide work.
    // Automation segments are projected per block, not deferred in a queue.
    const auto has_pre_seam_event = [requested_frame]<std::size_t Capacity>(
      const Impl::ControlLane<Capacity>& lane, const bool source) {
      const auto read = lane.read.load(std::memory_order_relaxed);
      const auto count = std::min<std::uint32_t>(lane.write.load(std::memory_order_acquire) - read,
        source ? Capacity : 1);
      for (std::uint32_t index = 0; index < count; ++index) {
        const auto& event = lane.events[(read + index) % Capacity];
        if ((source ? static_cast<std::uint64_t>(event.source.start_frame) : event.absolute_frame)
          < requested_frame) return true;
      }
      return false;
    };
    const bool old_bank_pending = schedule_claimed && requested_frame != 0
      && (has_pre_seam_event(impl_->ActiveSchedule().instrument_queue, false)
        || has_pre_seam_event(impl_->ActiveSchedule().scheduled_processor_queue, false)
        || has_pre_seam_event(impl_->ActiveSchedule().source_queue, true));
    if (old_bank_pending) impl_->ActiveSchedule().instrument_drain_priority = true;
    if (requested_revision != 0 && (!schedule_claimed
      || (requested_frame != 0 && current_frame != requested_frame) || old_bank_pending)) {
      impl_->publication_rebase_required.store(true, std::memory_order_release);
      impl_->publish_deferred_revision.store(requested_revision, std::memory_order_release);
      impl_->SignalRealtimeBridge(Impl::kRealtimeScheduleProgress);
    } else if (requested_revision != 0
      && impl_->prepared_core != 0
      && impl_->prepared_revision.load(std::memory_order_acquire) == requested_revision) {
      if (impl_->prepared_core_is_same_core) {
        const bool sources_ready = requested_frame == 0
          || impl_->ReconcileSourceSeam(false, static_cast<std::int64_t>(requested_frame));
        if (!sources_ready) impl_->publication_rebase_required.store(true, std::memory_order_release);
        const auto result = sources_ready ? daw_audio_core_publish(
          impl_->active_core.load(std::memory_order_acquire), requested_revision)
          : DAW_AUDIO_CORE_LATENCY_MOVE_PENDING;
        if (result == DAW_AUDIO_CORE_OK) {
          impl_->ApplyPreparedTransportContext();
          impl_->PromoteObservationLookup();
          if (requested_frame != 0) static_cast<void>(
            impl_->ReconcileSourceSeam(true, static_cast<std::int64_t>(requested_frame)));
          impl_->ReconcileScheduledTargets(impl_->active_core.load(std::memory_order_acquire),
            impl_->active_revision.load(std::memory_order_acquire), requested_revision, requested_frame == 0);
          if (requested_frame != 0) impl_->active_schedule_bank.store(
            1U - impl_->active_schedule_bank.load(std::memory_order_relaxed), std::memory_order_release);
          impl_->acceptance_publication_frame.store(impl_->applied_transport_frame.load(std::memory_order_relaxed));
          impl_->acceptance_publication_epoch.store(impl_->completed_render_epoch.load(std::memory_order_relaxed));
          impl_->RecordPublicationLatency();
          impl_->RetireSameCorePlan(impl_->active_revision.exchange(requested_revision, std::memory_order_acq_rel));
          impl_->prepared_core = 0;
          impl_->prepared_core_is_same_core = false;
          impl_->prepared_revision.store(0, std::memory_order_release);
          impl_->last_graph_revision.store(requested_revision, std::memory_order_release);
        }
        if (result == DAW_AUDIO_CORE_LATENCY_MOVE_PENDING) {
          // Not admitted: preserve the prepared bank for explicit event retry.
          impl_->publish_deferred_revision.store(requested_revision, std::memory_order_release);
          impl_->SignalRealtimeBridge(Impl::kRealtimeScheduleProgress);
        } else {
          impl_->publish_acknowledged_revision.store(requested_revision, std::memory_order_release);
          impl_->SignalRealtimeBridge(Impl::kRealtimePublishAcknowledged);
        }
      } else {
        const auto result = daw_audio_core_publish(impl_->prepared_core, requested_revision);
        if (result == DAW_AUDIO_CORE_LATENCY_MOVE_PENDING) {
          impl_->publish_deferred_revision.store(requested_revision, std::memory_order_release);
          impl_->SignalRealtimeBridge(Impl::kRealtimeScheduleProgress);
          continue;
        }
        if (result != DAW_AUDIO_CORE_OK) {
          impl_->publish_acknowledged_revision.store(requested_revision, std::memory_order_release);
          impl_->SignalRealtimeBridge(Impl::kRealtimePublishAcknowledged);
          continue;
        }
        const daw_audio_core_handle previous_core = impl_->active_core.exchange(impl_->prepared_core, std::memory_order_acq_rel);
        impl_->ApplyPreparedTransportContext();
        impl_->PromoteObservationLookup();
        impl_->acceptance_publication_frame.store(impl_->applied_transport_frame.load(std::memory_order_relaxed));
        impl_->acceptance_publication_epoch.store(impl_->completed_render_epoch.load(std::memory_order_relaxed));
        const std::uint32_t previous_revision = impl_->active_revision.exchange(requested_revision, std::memory_order_acq_rel);
        impl_->prepared_core = 0;
        impl_->prepared_core_is_same_core = false;
        impl_->prepared_revision.store(0, std::memory_order_release);
        impl_->retired_core = previous_core;
        impl_->retired_revision.store(previous_revision, std::memory_order_release);
        impl_->retired_after_epoch.store(
          impl_->completed_render_epoch.load(std::memory_order_acquire) + 1,
          std::memory_order_release
        );
        impl_->last_graph_revision.store(requested_revision, std::memory_order_release);
        impl_->publish_acknowledged_revision.store(requested_revision, std::memory_order_release);
        impl_->SignalRealtimeBridge(Impl::kRealtimePublishAcknowledged);
      }
    }
    const daw_audio_core_handle active_core = impl_->active_core.load(std::memory_order_acquire);
    const std::uint32_t maximum_frames = std::min(
      impl_->config.max_frames_per_block,
      static_cast<std::uint32_t>(DAW_AUDIO_RECORDING_CAPTURE_BLOCK_FRAMES));
    std::uint32_t frames = frame_count - offset > maximum_frames
      ? maximum_frames
      : frame_count - offset;
    // Device callbacks can be shorter than the configured maximum. Split the
    // final old-bank slice at the seam, never overshoot it or publish late.
    if (pending_revision != 0 && requested_frame > current_frame)
      frames = static_cast<std::uint32_t>(std::min<std::uint64_t>(frames, requested_frame - current_frame));
    auto& input_slice = impl_->realtime_process_scratch.input_slice;
    auto& output_slice = impl_->realtime_process_scratch.output_slice;
    if (impl_->config.channel_count > input_slice.size()) {
      impl_->RejectBlock(RejectedBlockReason::kScratchCapacity, callback_attempt);
      return false;
    }
    for (std::uint32_t channel = 0; channel < impl_->config.channel_count; ++channel) {
      input_slice[channel] = inputs[channel] + offset;
      output_slice[channel] = outputs[channel] + offset;
    }
    auto& processor_events = impl_->realtime_process_scratch.processor_events;
    auto& instrument_events = impl_->realtime_process_scratch.instrument_events;
    auto& render_instrument_events = impl_->realtime_process_scratch.render_instrument_events;
    auto& rejected_instrument_events = impl_->realtime_process_scratch.rejected_instrument_events;
    auto& instrument_order = impl_->realtime_process_scratch.instrument_order;
    std::uint32_t processor_event_count = 0;
    std::uint64_t processor_sequence_applied = 0;
    std::uint32_t instrument_event_count = 0;
    std::uint64_t urgent_sequence_applied = 0;
    std::uint32_t urgent_read = impl_->urgent_queue.read.load(std::memory_order_relaxed);
    std::uint32_t scheduled_instrument_read = impl_->ActiveSchedule().instrument_queue.read.load(std::memory_order_relaxed);
    std::uint32_t instrument_read = impl_->instrument_queue.read.load(std::memory_order_relaxed);
    const auto block_start_frame = impl_->applied_transport_frame.load(std::memory_order_acquire);
    const auto block_end_frame = block_start_frame + static_cast<std::int64_t>(frames);
    const auto applied_epoch = impl_->applied_transport_epoch.load(std::memory_order_acquire);
    const auto published_window = impl_->ActiveSchedule().published_schedule_window_id.load(std::memory_order_acquire);
    const auto drain_scheduled_processor_lane = [&]<std::size_t Capacity>(Impl::ControlLane<Capacity>& lane) {
      std::uint32_t read = lane.read.load(std::memory_order_relaxed);
      const std::uint32_t write = lane.write.load(std::memory_order_acquire);
      while (read != write) {
        const auto& event = lane.events[read % Capacity];
        if (event.cancelled || event.processor_revision != impl_->active_revision.load(std::memory_order_acquire)
          || event.processor_epoch != applied_epoch) {
          ++read;
          continue;
        }
        if (!impl_->applied_transport_running.load(std::memory_order_acquire)) break;
        if (event.window_id > published_window) break;
        if (event.absolute_frame >= static_cast<std::uint64_t>(block_end_frame)) break;
        if (event.processor_end_frame > event.absolute_frame) {
          if (event.processor_end_frame > static_cast<std::uint64_t>(block_start_frame)) {
            if (impl_->processor_ramp_count >= impl_->processor_ramps.size()) return false;
            impl_->processor_ramps[impl_->processor_ramp_count++] = {
              .processor = event.processor,
              .start_frame = event.absolute_frame,
              .end_frame = event.processor_end_frame,
              .end_value = event.processor_end_value,
              .revision = event.processor_revision,
              .epoch = event.processor_epoch,
            };
          }
          ++read;
          continue;
        }
        if (event.absolute_frame < static_cast<std::uint64_t>(block_start_frame)) {
          ++read;
          continue;
        }
        if (processor_event_count >= processor_events.size()) return false;
        processor_events[processor_event_count] = event.processor;
        processor_events[processor_event_count].frame_offset = event.absolute_frame <= static_cast<std::uint64_t>(block_start_frame)
          ? 0
          : static_cast<std::uint32_t>(event.absolute_frame - static_cast<std::uint64_t>(block_start_frame));
        ++processor_event_count;
        ++read;
      }
      lane.read.store(read, std::memory_order_release);
      return true;
    };
    const auto drain_processor_lane = [&]<std::size_t Capacity>(Impl::ControlLane<Capacity>& lane) {
      std::uint32_t read = lane.read.load(std::memory_order_relaxed);
      const std::uint32_t write = lane.write.load(std::memory_order_acquire);
      while (read != write) {
        const auto& event = lane.events[read % Capacity];
        if (event.cancelled || (event.processor_revision != 0
          && (event.processor_revision != impl_->active_revision.load(std::memory_order_acquire)
            || event.processor_epoch != applied_epoch))) {
          ++read;
          continue;
        }
        if (event.processor.frame_offset >= frames) break;
        if (processor_event_count >= processor_events.size()) return false;
        processor_events[processor_event_count] = event.processor;
        ++processor_event_count;
        processor_sequence_applied = std::max(processor_sequence_applied, event.processor_sequence);
        ++read;
      }
      lane.read.store(read, std::memory_order_release);
      return true;
    };
    // Each block writes a ramp value every `stride` frames, the smallest power of two that keeps the block's events inside
    // the core's capacity less headroom for the VST automation the coordinator counts with them. Ramps stay in `processor_ramps`
    // until they end, so a rejected block retries with the same ramps.
    constexpr std::uint32_t kRampVstHeadroom = 32;
    const auto expand_processor_ramps = [&]() {
      if (!impl_->applied_transport_running.load(std::memory_order_acquire)) return true;
      const auto& ramps = impl_->processor_ramps;
      const std::uint64_t block_start = static_cast<std::uint64_t>(block_start_frame);
      const std::uint64_t block_end = static_cast<std::uint64_t>(block_end_frame);
      const auto span_of = [&](const Impl::ProcessorRamp& ramp) {
        return std::min(ramp.end_frame, block_end) - std::max(ramp.start_frame, block_start);
      };
      const std::uint32_t reserved = std::min<std::uint32_t>(
        static_cast<std::uint32_t>(processor_events.size()), processor_event_count + kRampVstHeadroom);
      const std::uint32_t budget = static_cast<std::uint32_t>(processor_events.size()) - reserved;
      std::uint32_t stride = 1;
      for (; stride < frames; stride *= 2) {
        std::uint64_t needed = 0;
        for (std::uint32_t index = 0; index < impl_->processor_ramp_count; ++index)
          needed += (span_of(ramps[index]) + stride - 1) / stride;
        if (needed <= budget) break;
      }
      for (std::uint32_t index = 0; index < impl_->processor_ramp_count; ++index) {
        const auto& ramp = ramps[index];
        const std::uint64_t last = std::min(ramp.end_frame, block_end);
        const double slope = (static_cast<double>(ramp.end_value) - ramp.processor.value)
          / static_cast<double>(ramp.end_frame - ramp.start_frame);
        for (std::uint64_t frame = std::max(ramp.start_frame, block_start); frame < last; frame += stride) {
          if (processor_event_count >= processor_events.size()) return false;
          processor_events[processor_event_count] = ramp.processor;
          processor_events[processor_event_count].frame_offset = static_cast<std::uint32_t>(frame - block_start);
          processor_events[processor_event_count].value = static_cast<float>(
            ramp.processor.value + slope * static_cast<double>(frame - ramp.start_frame));
          ++processor_event_count;
        }
      }
      return true;
    };
    const auto drain_instrument_lane = [&]<std::size_t Capacity>(
      Impl::ControlLane<Capacity>& lane, std::uint32_t& read, const bool urgent) {
      const std::uint32_t write = lane.write.load(std::memory_order_acquire);
      while (read != write) {
        auto& event = lane.events[read % Capacity];
        if (event.cancelled || event.instrument.epoch != applied_epoch) {
          ++read;
          continue;
        }
        if (event.scheduled && !impl_->applied_transport_running.load(std::memory_order_acquire)) break;
        if (event.scheduled && event.window_id > published_window) break;
        const auto event_frame = event.scheduled ? event.absolute_frame
          : static_cast<std::uint64_t>(event.instrument.frame_offset);
        if (event_frame >= static_cast<std::uint64_t>(block_end_frame)) break;
        // Keep excess scheduled notes in their lane when live controls use
        // block capacity. Render them at offset zero next time, never consume
        // a live control in a block that we reject for merge overflow.
        if (instrument_event_count >= instrument_events.size()) break;
        instrument_order[instrument_event_count] = static_cast<std::uint16_t>(instrument_event_count);
        instrument_events[instrument_event_count] = event.instrument;
        if (urgent) urgent_sequence_applied = std::max(urgent_sequence_applied, event.instrument.sequence);
        instrument_events[instrument_event_count].frame_offset = event_frame <= static_cast<std::uint64_t>(block_start_frame)
          ? 0
          : static_cast<std::uint32_t>(event_frame - static_cast<std::uint64_t>(block_start_frame));
        ++instrument_event_count;
        ++read;
      }
      // Publish consumption only after core processing succeeds. Producers
      // cannot overwrite controls retained for a rejected block's retry.
      return true;
    };
    const auto drain_source_lane = [&]<std::size_t Capacity>(Impl::ControlLane<Capacity>& lane) {
      std::uint32_t read = lane.read.load(std::memory_order_relaxed);
      const std::uint32_t write = lane.write.load(std::memory_order_acquire);
      while (read != write) {
        const auto& event = lane.events[read % Capacity];
        if (event.cancelled) {
          ++read;
          continue;
        }
        if (event.scheduled && !impl_->applied_transport_running.load(std::memory_order_acquire)) break;
        if (event.scheduled && event.source.epoch != applied_epoch) {
          ++read;
          continue;
        }
        if (event.scheduled && event.window_id > published_window) break;
        if (event.scheduled && event.source.start_frame >= block_end_frame) break;
        if (daw_audio_core_schedule_sample_source(active_core, &event.source) != DAW_AUDIO_CORE_OK) return false;
        ++read;
      }
      const auto previous_read = lane.read.exchange(read, std::memory_order_release);
      if (read != previous_read && impl_->asset_retirement_pending.load(std::memory_order_acquire))
        impl_->SignalRealtimeBridge(Impl::kRealtimeAssetReaders);
      return true;
    };
    {
      auto& ramps = impl_->processor_ramps;
      std::uint32_t kept = 0;
      for (std::uint32_t index = 0; index < impl_->processor_ramp_count; ++index) {
        const auto& ramp = ramps[index];
        if (ramp.cancelled || ramp.revision != impl_->active_revision.load(std::memory_order_acquire)
          || ramp.epoch != applied_epoch || ramp.end_frame <= static_cast<std::uint64_t>(block_start_frame)) continue;
        ramps[kept++] = ramp;
      }
      impl_->processor_ramp_count = kept;
    }
    // After a saturation rebase, new live controls cannot starve the finite
    // accepted schedule backlog. All lanes retain excess events for retry.
    if ((impl_->ActiveSchedule().instrument_drain_priority
        && !drain_instrument_lane(impl_->ActiveSchedule().instrument_queue, scheduled_instrument_read, false))
      || !drain_instrument_lane(impl_->urgent_queue, urgent_read, true)
      || !drain_instrument_lane(impl_->instrument_queue, instrument_read, false)
      || !drain_instrument_lane(impl_->ActiveSchedule().instrument_queue, scheduled_instrument_read, false)
      || !drain_scheduled_processor_lane(impl_->ActiveSchedule().scheduled_processor_queue)
      || !drain_processor_lane(impl_->processor_queue)
      || !expand_processor_ramps()
      || !drain_source_lane(impl_->ActiveSchedule().source_queue)) {
      const auto reason = instrument_event_count >= instrument_events.size()
        ? RejectedBlockReason::kInstrumentEventCapacity
        : processor_event_count >= processor_events.size()
          || impl_->processor_ramp_count >= impl_->processor_ramps.size()
          ? RejectedBlockReason::kProcessorEventCapacity
          : RejectedBlockReason::kSourceSchedule;
      impl_->RejectBlock(reason, callback_attempt);
      return false;
    }
    const auto processor_before = [](const auto& left, const auto& right) {
      return left.processor_instance_id < right.processor_instance_id
        || (left.processor_instance_id == right.processor_instance_id && (
          left.frame_offset < right.frame_offset
          || (left.frame_offset == right.frame_offset && left.parameter_target < right.parameter_target)));
    };
    for (std::uint32_t index = 1; index < processor_event_count; ++index) {
      const auto event = processor_events[index];
      std::uint32_t position = index;
      while (position > 0 && processor_before(event, processor_events[position - 1])) {
        processor_events[position] = processor_events[position - 1];
        --position;
      }
      processor_events[position] = event;
    }
    std::sort(instrument_order.begin(), instrument_order.begin() + instrument_event_count,
      [&instrument_events](const auto left_index, const auto right_index) {
        const auto& left = instrument_events[left_index];
        const auto& right = instrument_events[right_index];
        return left.frame_offset < right.frame_offset
          || (left.frame_offset == right.frame_offset && left.sequence < right.sequence);
      });
    // Queue sequence domains are independent. Preserve their acknowledgement
    // identity above; the core requires increasing sequences across this block.
    for (std::uint32_t index = 0; index < instrument_event_count; ++index) {
      render_instrument_events[index] = instrument_events[instrument_order[index]];
      render_instrument_events[index].sequence = index + 1;
    }
    const daw_audio_core_process_block block{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
      .frame_count = frames,
      .channel_count = impl_->config.channel_count,
      .input_bus_count = 1,
      .inputs = input_slice.data(),
      .outputs = output_slice.data(),
      .graph_revision = impl_->active_revision.load(std::memory_order_acquire),
      .parameter_block_count = 0,
      .parameter_blocks = nullptr,
      .event_count = processor_event_count,
      .events = processor_event_count == 0 ? nullptr : processor_events.data(),
      .transport_epoch = applied_epoch,
      .instrument_event_count = instrument_event_count,
      .instrument_events = instrument_event_count == 0 ? nullptr : render_instrument_events.data(),
    };
    const auto latency_before = daw::audio_core::InspectLatencyTransition(active_core);
    const auto result = impl_->strict_offline_export
      ? daw_audio_core_process(active_core, &block)
      : daw_audio_core_process_valid_instrument_events(
        active_core, &block, rejected_instrument_events.data());
    if (result != DAW_AUDIO_CORE_OK) {
      const auto rejected_index = daw_audio_core_rejected_instrument_event_index(active_core);
      impl_->RejectBlock(
        RejectedBlockReason::kCoreProcess,
        callback_attempt,
        result,
        frames,
        impl_->config.channel_count,
        processor_event_count,
        impl_->strict_offline_export && rejected_index == UINT32_MAX
          ? 0 : instrument_event_count,
        block.graph_revision
      );
      return false;
    }
    const auto latency_after = daw::audio_core::InspectLatencyTransition(active_core);
    const bool latency_completed = latency_after.completed_revision != latency_before.completed_revision;
    if (impl_->offline_failure.load(std::memory_order_acquire)) {
      impl_->RejectBlock(
        RejectedBlockReason::kCoreProcess,
        callback_attempt,
        DAW_AUDIO_CORE_INVALID_ARGUMENT,
        frames,
        impl_->config.channel_count,
        processor_event_count,
        instrument_event_count,
        block.graph_revision
      );
      return false;
    }
    std::uint32_t rejected_count = 0;
    std::uint32_t first_rejected = 0;
    for (std::uint32_t index = 0; index < instrument_event_count; ++index) {
      if (rejected_instrument_events[index] == 0) continue;
      if (rejected_count == 0) first_rejected = index;
      ++rejected_count;
    }
    if (rejected_count != 0) {
      const auto& first = instrument_events[instrument_order[first_rejected]];
      // Lifetime cumulative reporting coalesces bridge wakeups without losing
      // counts or racing replacement of the first rejection's identity.
      if (impl_->rejected_instrument_count.load(std::memory_order_relaxed) == 0) {
        impl_->rejected_instrument_node.store(first.node_id, std::memory_order_relaxed);
        impl_->rejected_instrument_sequence.store(first.sequence, std::memory_order_relaxed);
      }
      impl_->rejected_instrument_count.fetch_add(rejected_count, std::memory_order_release);
      impl_->SignalRealtimeBridge(Impl::kRealtimeInstrumentRejected);
    }
    auto applied_processor_sequence = impl_->applied_processor_sequence.load(std::memory_order_relaxed);
    while (processor_sequence_applied > applied_processor_sequence
      && !impl_->applied_processor_sequence.compare_exchange_weak(
        applied_processor_sequence, processor_sequence_applied, std::memory_order_release, std::memory_order_relaxed)) {}
    impl_->urgent_queue.read.store(urgent_read, std::memory_order_release);
    impl_->instrument_queue.read.store(instrument_read, std::memory_order_release);
    impl_->ActiveSchedule().instrument_queue.read.store(scheduled_instrument_read, std::memory_order_release);
    auto applied_urgent = impl_->applied_urgent_sequence.load(std::memory_order_relaxed);
    while (urgent_sequence_applied > applied_urgent
      && !impl_->applied_urgent_sequence.compare_exchange_weak(
        applied_urgent, urgent_sequence_applied, std::memory_order_release, std::memory_order_relaxed)) {}
    if (impl_->recording_monitoring.load(std::memory_order_acquire)) {
      const std::uint64_t read = impl_->recording_monitor_read.load(std::memory_order_relaxed);
      const std::uint64_t write = impl_->recording_monitor_write.load(std::memory_order_acquire);
      const std::uint32_t monitored_frames = std::min<std::uint64_t>(frames, write - read);
      const std::uint32_t recording_channels = impl_->recording_channel_count.load(std::memory_order_acquire);
      for (std::uint32_t channel = 0; channel < impl_->config.channel_count && recording_channels > 0; ++channel) {
        const std::uint32_t monitor_channel = std::min(channel, recording_channels - 1);
        for (std::uint32_t frame = 0; frame < monitored_frames; ++frame) {
          output_slice[channel][frame] +=
            impl_->recording_monitor_ring[monitor_channel][(read + frame) % Impl::kRecordingMonitorCapacity];
        }
      }
      impl_->recording_monitor_read.store(read + monitored_frames, std::memory_order_release);
    }
    if (impl_->applied_transport_running.load(std::memory_order_acquire)) {
      impl_->applied_transport_frame.fetch_add(frames, std::memory_order_release);
      impl_->transport_frame.store(
        impl_->applied_transport_frame.load(std::memory_order_acquire),
        std::memory_order_release
      );
    }
    if (impl_->acceptance_tap) {
      impl_->acceptance_tap->Push(output_slice.data(), frames, block.graph_revision, applied_epoch, block_start_frame);
      impl_->SignalRealtimeBridge(1U << 7U);
    }
    impl_->schedule_progress_revision.store(
      impl_->active_revision.load(std::memory_order_acquire),
      std::memory_order_release
    );
    impl_->schedule_progress_epoch.store(applied_epoch, std::memory_order_release);
    impl_->schedule_progress_rendered_frame.store(
      static_cast<std::uint64_t>(std::max<std::int64_t>(
        0,
        impl_->applied_transport_frame.load(std::memory_order_acquire)
      )),
      std::memory_order_release
    );
    impl_->schedule_progress_accepted_frame.store(
      impl_->ActiveSchedule().accepted_schedule_through_frame.load(std::memory_order_acquire),
      std::memory_order_release
    );
    impl_->schedule_progress_window_id.store(
      impl_->ActiveSchedule().published_schedule_window_id.load(std::memory_order_acquire),
      std::memory_order_release
    );
    impl_->schedule_progress_applied_transition.store(
      impl_->applied_transport_transition_id.load(std::memory_order_acquire),
      std::memory_order_release
    );
    impl_->schedule_progress_urgent.store(
      impl_->applied_urgent_sequence.load(std::memory_order_acquire),
      std::memory_order_release
    );
    impl_->schedule_progress_processor.store(
      impl_->applied_processor_sequence.load(std::memory_order_acquire),
      std::memory_order_release
    );
    impl_->schedule_progress_running.store(
      impl_->applied_transport_running.load(std::memory_order_acquire),
      std::memory_order_release
    );
    impl_->schedule_progress_complete.store(
      impl_->ActiveSchedule().schedule_complete.load(std::memory_order_acquire),
      std::memory_order_release
    );
    const auto rendered_frame = impl_->schedule_progress_rendered_frame.load(std::memory_order_relaxed);
    const auto revision = impl_->schedule_progress_revision.load(std::memory_order_relaxed);
    const auto epoch = impl_->schedule_progress_epoch.load(std::memory_order_relaxed);
    const auto accepted_frame = impl_->schedule_progress_accepted_frame.load(std::memory_order_relaxed);
    const auto window_id = impl_->schedule_progress_window_id.load(std::memory_order_relaxed);
    const auto transition = impl_->schedule_progress_applied_transition.load(std::memory_order_relaxed);
    const auto urgent = impl_->schedule_progress_urgent.load(std::memory_order_relaxed);
    const auto processor = impl_->schedule_progress_processor.load(std::memory_order_relaxed);
    const auto running = impl_->schedule_progress_running.load(std::memory_order_relaxed);
    const auto complete = impl_->schedule_progress_complete.load(std::memory_order_relaxed);
    const auto frame_quantum = std::max<std::uint64_t>(
      static_cast<std::uint64_t>(impl_->config.max_frames_per_block),
      512
    );
    const bool meaningful = !impl_->schedule_progress_has_notification
      || rendered_frame >= impl_->schedule_progress_notified_frame + frame_quantum
      || revision != impl_->schedule_progress_notified_revision
      || epoch != impl_->schedule_progress_notified_epoch
      || accepted_frame != impl_->schedule_progress_notified_accepted_frame
      || window_id != impl_->schedule_progress_notified_window_id
      || transition != impl_->schedule_progress_notified_transition
      || urgent != impl_->schedule_progress_notified_urgent
      || processor != impl_->schedule_progress_notified_processor
      || running != impl_->schedule_progress_notified_running
      || complete != impl_->schedule_progress_notified_complete;
    if (meaningful) {
      impl_->schedule_progress_has_notification = true;
      impl_->schedule_progress_notified_frame = rendered_frame;
      impl_->schedule_progress_notified_revision = revision;
      impl_->schedule_progress_notified_epoch = epoch;
      impl_->schedule_progress_notified_accepted_frame = accepted_frame;
      impl_->schedule_progress_notified_window_id = window_id;
      impl_->schedule_progress_notified_transition = transition;
      impl_->schedule_progress_notified_urgent = urgent;
      impl_->schedule_progress_notified_processor = processor;
      impl_->schedule_progress_notified_running = running;
      impl_->schedule_progress_notified_complete = complete;
      impl_->schedule_progress_sequence.fetch_add(1, std::memory_order_release);
    }
    const bool assets_ready = daw::audio_core::CompleteAssetReaders(active_core,
      impl_->completed_render_epoch.load(std::memory_order_relaxed) + 1);
    impl_->completed_render_epoch.fetch_add(1, std::memory_order_release);
    if (assets_ready) impl_->SignalRealtimeBridge(Impl::kRealtimeAssetReaders);
    // Publish readiness only after the retiring callback's reader epoch and
    // progress fields are visible, including completions below the frame quantum.
    if (latency_completed) {
      impl_->latency_completion_generation.fetch_add(1, std::memory_order_release);
      if (!meaningful) impl_->schedule_progress_sequence.fetch_add(1, std::memory_order_release);
      impl_->SignalRealtimeBridge(Impl::kRealtimeLatencyCompleted | Impl::kRealtimeScheduleProgress);
    } else if (meaningful) impl_->SignalRealtimeBridge(Impl::kRealtimeScheduleProgress);
    if (offset != 0) impl_->split_blocks.fetch_add(1, std::memory_order_relaxed);
    offset += frames;
  }
  impl_->callbacks.fetch_add(1, std::memory_order_relaxed);
  return true;
}

bool AudioHost::ProcessRecordingPlanar(
  const std::span<const float* const> input,
  const std::uint32_t frame_count) {
  const daw_audio_core_handle capture = impl_->recording_capture.load(std::memory_order_acquire);
  if (capture == 0 || input.empty() || input.size() > 64 || frame_count == 0) return false;
  for (const float* plane : input) {
    if (plane == nullptr) return false;
  }
  std::uint32_t offset = 0;
  while (offset < frame_count) {
    const std::uint32_t frames = std::min(
      frame_count - offset,
      static_cast<std::uint32_t>(DAW_AUDIO_RECORDING_CAPTURE_BLOCK_FRAMES));
    std::array<const float*, 64> input_slice{};
    for (std::size_t channel = 0; channel < input.size(); ++channel) input_slice[channel] = input[channel] + offset;
    const std::int64_t block_start_frame = impl_->recording_input_frame.load(std::memory_order_acquire);
    bool recording_status_changed = impl_->ApplyRecordingCommand(block_start_frame);
    if (impl_->recording_started.load(std::memory_order_acquire)) {
      const std::uint32_t recording_channels = impl_->recording_channel_count.load(std::memory_order_acquire);
      const bool monitoring = impl_->recording_monitoring.load(std::memory_order_acquire);
      for (std::uint32_t channel = 0; channel < recording_channels; ++channel) {
        impl_->recording_monitor_planes[channel] = impl_->recording_monitor[channel].data();
      }
      const daw_audio_core_result result = monitoring
        ? daw_audio_recording_capture_process_monitor(
          capture,
          input_slice.data(),
          static_cast<std::uint32_t>(input.size()),
          impl_->recording_monitor_planes.data(),
          recording_channels,
          frames,
          block_start_frame)
        : daw_audio_recording_capture_process(
          capture,
          input_slice.data(),
          static_cast<std::uint32_t>(input.size()),
          frames,
          block_start_frame);
      if (result == DAW_AUDIO_CORE_CAPACITY_EXCEEDED) {
        impl_->recording_started.store(false, std::memory_order_release);
      } else if (result != DAW_AUDIO_CORE_OK) {
        return false;
      }
      recording_status_changed = true;
      if (monitoring) {
        const std::uint64_t write = impl_->recording_monitor_write.load(std::memory_order_relaxed);
        const std::uint64_t read = impl_->recording_monitor_read.load(std::memory_order_acquire);
        if (write - read + frames <= Impl::kRecordingMonitorCapacity) {
          for (std::uint32_t channel = 0; channel < recording_channels; ++channel) {
            for (std::uint32_t frame = 0; frame < frames; ++frame) {
              impl_->recording_monitor_ring[channel][(write + frame) % Impl::kRecordingMonitorCapacity]
                = impl_->recording_monitor[channel][frame];
            }
          }
          impl_->recording_monitor_write.store(write + frames, std::memory_order_release);
        }
      }
    }
    if (recording_status_changed) impl_->SignalRealtimeBridge(Impl::kRealtimeRecordingStatus);
    impl_->recording_input_frame.fetch_add(frames, std::memory_order_release);
    offset += frames;
  }
  return true;
}
// DAW_REALTIME_CALLBACK_REGION_END audio-host

void AudioHost::RecordOutputCallback(
  const std::uint32_t frame_count,
  const std::uint64_t duration_nanoseconds
) noexcept {
  if (!impl_->applied_transport_running.load(std::memory_order_acquire)
    || frame_count == 0 || duration_nanoseconds == 0) return;
  impl_->callback_frames.store(frame_count, std::memory_order_relaxed);
  impl_->callback_timing_count.fetch_add(1, std::memory_order_relaxed);
  auto maximum = impl_->callback_timing_maximum_nanoseconds.load(std::memory_order_relaxed);
  while (duration_nanoseconds > maximum && !impl_->callback_timing_maximum_nanoseconds.compare_exchange_weak(
    maximum, duration_nanoseconds, std::memory_order_relaxed, std::memory_order_relaxed)) {}
  const auto deadline_nanoseconds = impl_->config.sample_rate_hz == 0
    ? 0
    : static_cast<std::uint64_t>(
      static_cast<double>(frame_count) * 1'000'000'000.0
        / static_cast<double>(impl_->config.sample_rate_hz)
    );
  if (deadline_nanoseconds > 0 && duration_nanoseconds > deadline_nanoseconds) {
    impl_->callback_deadline_misses.fetch_add(1, std::memory_order_relaxed);
  }
  impl_->callback_timing_buckets[detail::RealtimeDurationHistogramBucket(duration_nanoseconds)]
    .fetch_add(1, std::memory_order_relaxed);
}

LifecycleState AudioHost::lifecycleState() const {
  return impl_->state.load(std::memory_order_acquire);
}

Diagnostics AudioHost::diagnostics() const {
  std::optional<Diagnostics::WorkerAutomation> automation;
  std::array<std::uint64_t, detail::kRealtimeDurationHistogramBuckets> callback_buckets{};
  std::array<std::uint64_t, daw::plugin_host::kWorkerProcessingHistogramBuckets> worker_buckets{};
  for (std::size_t index = 0; index < callback_buckets.size(); ++index) {
    callback_buckets[index] = impl_->callback_timing_buckets[index].load(std::memory_order_relaxed);
  }
  std::uint64_t worker_observations = 0;
  std::uint64_t worker_maximum = 0;
  std::uint64_t worker_deadline_misses = 0;
  std::uint64_t worker_watchdog_misses = 0;
  std::uint32_t active_workers = 0;
  const auto epoch = impl_->transport_epoch.load(std::memory_order_acquire);
  for (const auto& [instance_id, attachment] : impl_->native_vst_attachments) {
    static_cast<void>(instance_id);
    const auto& candidate = attachment->worker_automation;
    if (candidate && candidate->instance_id == instance_id)
      automation = SelectWorkerAutomation(std::move(automation), *candidate, epoch);
    if (attachment->worker.health() == daw::plugin_host::WorkerHealth::kReady) {
      ++active_workers;
    }
    const auto worker_metrics = attachment->worker.processingMetrics();
    worker_observations += worker_metrics.count;
    worker_maximum = std::max(worker_maximum, worker_metrics.maximum_nanoseconds);
    worker_deadline_misses += worker_metrics.deadline_misses;
    worker_watchdog_misses += attachment->watchdog_misses.load(std::memory_order_relaxed);
    for (std::size_t index = 0; index < worker_buckets.size(); ++index) {
      worker_buckets[index] += worker_metrics.buckets[index];
    }
  }
  const auto callback_count = impl_->callback_timing_count.load(std::memory_order_relaxed);
  return {
    .worker_automation = automation,
    .realtime_performance = {
      .sample_rate_hz = impl_->config.sample_rate_hz,
      .frames_per_callback = impl_->callback_frames.load(std::memory_order_relaxed),
      .observation_count = callback_count,
      .processing = DurationQuantiles(
        callback_buckets,
        callback_count,
        impl_->callback_timing_maximum_nanoseconds.load(std::memory_order_relaxed)
      ),
      .deadline_misses = impl_->callback_deadline_misses.load(std::memory_order_relaxed),
    },
    .vst_worker_performance = {
      .active_workers = active_workers,
      .observation_count = worker_observations,
      .processing = DurationQuantiles(worker_buckets, worker_observations, worker_maximum),
      .deadline_misses = worker_deadline_misses,
      .watchdog_misses = worker_watchdog_misses,
      .faults = impl_->vst_worker_faults.load(std::memory_order_relaxed),
      .restarts = impl_->vst_worker_restarts.load(std::memory_order_relaxed),
    },
    .state = impl_->state.load(std::memory_order_acquire),
    .callbacks = impl_->callbacks.load(std::memory_order_relaxed),
    .split_blocks = impl_->split_blocks.load(std::memory_order_relaxed),
    .rejected_blocks = impl_->rejected_blocks.load(std::memory_order_relaxed),
    .active_revision = impl_->active_revision.load(std::memory_order_acquire),
    .prepared_revision = impl_->prepared_revision.load(std::memory_order_acquire),
    .retired_revision = impl_->retired_revision.load(std::memory_order_acquire),
    .transport_epoch = impl_->transport_epoch.load(std::memory_order_acquire),
    .render_epoch = impl_->completed_render_epoch.load(std::memory_order_acquire),
    .installed_assets = static_cast<std::uint32_t>(impl_->assets.size()),
    .transport_frame = impl_->transport_frame.load(std::memory_order_acquire),
    .last_rejected_reason = impl_->last_rejected_reason.load(std::memory_order_relaxed),
    .last_rejected_callback = impl_->last_rejected_callback.load(std::memory_order_relaxed),
    .last_rejected_render_epoch = impl_->last_rejected_render_epoch.load(std::memory_order_relaxed),
    .last_rejected_transport_epoch = impl_->last_rejected_transport_epoch.load(std::memory_order_relaxed),
    .last_rejected_core_result = impl_->last_rejected_core_result.load(std::memory_order_relaxed),
    .last_rejected_frame_count = impl_->last_rejected_frame_count.load(std::memory_order_relaxed),
    .last_rejected_channel_count = impl_->last_rejected_channel_count.load(std::memory_order_relaxed),
    .last_rejected_processor_event_count = impl_->last_rejected_processor_event_count.load(std::memory_order_relaxed),
    .last_rejected_instrument_event_count = impl_->last_rejected_instrument_event_count.load(std::memory_order_relaxed),
    .last_rejected_graph_revision = impl_->last_rejected_graph_revision.load(std::memory_order_relaxed),
  };
}

DeviceReadinessReason AudioHost::readinessReason() const {
  if (impl_->state.load(std::memory_order_acquire) == LifecycleState::kIdle
    || impl_->config.device_uid.empty()) return DeviceReadinessReason::kDeviceNotConfigured;
  if (!impl_->graph_prepared) return DeviceReadinessReason::kGraphNotPrepared;
  if (!impl_->transport_prepared) return DeviceReadinessReason::kTransportNotPrepared;
  return DeviceReadinessReason::kReady;
}

}  // namespace daw::audio_host_macos
