#pragma once

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
#include "acceptance-observer.h"

#include <mach-o/dyld.h>

#include <fcntl.h>
#include <sys/mman.h>
#include <sys/sysctl.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cctype>
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

inline std::uint64_t InstrumentResidentBudget() {
#if defined(DAW_AUDIO_HOST_TEST_MEMORY_LOCK)
  const auto test_budget = daw_audio_host_test_resident_budget();
  if (test_budget != UINT64_MAX) return test_budget;
#endif
  // Reserve at most 1/8 of physical RAM for this host's native copy; renderer PCM and
  // live/export overlap are charged against a shared policy elsewhere.
  std::uint64_t bytes = 0;
  std::size_t size = sizeof(bytes);
  return sysctlbyname("hw.memsize", &bytes, &size, nullptr, 0) == 0 ? bytes / 8 : 0;
}

inline constexpr std::size_t kMaximumNativeVstAttachments = 64;
inline constexpr std::uint32_t kMaximumNativeVstFrames = daw::plugin_host::kMaximumWorkerFrames;
inline constexpr std::uint32_t kMaximumNativeVstChannels = 64;
inline constexpr std::uint32_t kMaximumNativeVstSlots = 8;

inline constexpr std::size_t kMaximumMeterQueueEntries = 1024;
inline constexpr std::size_t kMaximumSpectrumQueueEntries = 8;
inline constexpr std::uint32_t kSpectrumFftSize = 2048;

#if defined(DAW_AUDIO_HOST_TEST_PATCH_CLAIM)
// Compiled only into the private test and acceptance targets (CMakeLists.txt). No runtime
// switch exists, so no environment can enable it in another artifact.
inline constexpr std::uint64_t kTestPatchClaimTokenBase = 1ULL << 53U;
// The acceptance executable always holds; the unit-test target opts in per test.
inline std::atomic<bool> test_patch_claim_hold{DAW_AUDIO_HOST_TEST_PATCH_CLAIM == 2};
#if DAW_AUDIO_HOST_TEST_PATCH_CLAIM == 1
inline std::atomic<void (*)()> test_patch_claim_hook{nullptr};
// Runs on the callback thread with the (ack, result) pair as it reads when the ack is stored.
inline std::atomic<void (*)(std::uint64_t, std::uint32_t)> test_patch_ack_hook{nullptr};
// Makes the next applied patch fail in the core (no staged patch left), so a claim can
// resolve with a failure result.
inline std::atomic<bool> test_patch_claim_discard{false};
// Starts attached workers without a plug-in, so the host's worker handling runs in CTest.
inline std::atomic<bool> test_no_plugin_workers{false};
// Replaces the worker executable (a child that is slow to exit). Set from the test thread
// before any attach; the command thread is that same thread.
inline std::string test_worker_executable;
// Stands in for the CoreAudio device: runs inside Start where the device would start its IO callback.
inline std::atomic<bool (*)(AudioHost*, void**)> test_device_start{nullptr};
#endif
#endif

inline std::optional<std::string> WorkerExecutablePath() {
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

inline std::uint32_t ReadU32(const std::uint8_t* bytes) {
  return (static_cast<std::uint32_t>(bytes[0]) << 24U)
    | (static_cast<std::uint32_t>(bytes[1]) << 16U)
    | (static_cast<std::uint32_t>(bytes[2]) << 8U)
    | static_cast<std::uint32_t>(bytes[3]);
}

inline std::uint32_t ReadLeU32(const std::uint8_t* bytes) {
  return static_cast<std::uint32_t>(bytes[0])
    | (static_cast<std::uint32_t>(bytes[1]) << 8U)
    | (static_cast<std::uint32_t>(bytes[2]) << 16U)
    | (static_cast<std::uint32_t>(bytes[3]) << 24U);
}

inline std::uint64_t ReadLeU64(const std::uint8_t* bytes) {
  std::uint64_t value = 0;
  for (std::size_t index = 0; index < 8; ++index) value |= static_cast<std::uint64_t>(bytes[index]) << (index * 8U);
  return value;
}

inline std::int64_t ReadLeI64(const std::uint8_t* bytes) {
  return static_cast<std::int64_t>(ReadLeU64(bytes));
}

inline float ReadLeFloat(const std::uint8_t* bytes) {
  const std::uint32_t bits = ReadLeU32(bytes);
  float value = 0.0F;
  std::memcpy(&value, &bits, sizeof(value));
  return value;
}

inline double ReadLeDouble(const std::uint8_t* bytes) {
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

// Every edge on a path leaving `target`, sorted: its output, through any group or send, to the master.
inline std::vector<RouteEdge> DownstreamRoute(const PlanRouting& plan, const std::uint64_t target) {
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

inline bool PlanContainsNode(const PlanRouting& plan, const std::uint64_t node) {
  return std::find(plan.nodes.begin(), plan.nodes.end(), node) != plan.nodes.end();
}

inline bool CaptureTargetKept(const PlanRouting& published, const PlanRouting& proposed, const std::uint64_t target) {
  return PlanContainsNode(proposed, target) && DownstreamRoute(published, target) == DownstreamRoute(proposed, target);
}

inline void WriteU32(std::vector<std::uint8_t>& bytes, std::size_t offset, std::uint32_t value) {
  bytes[offset] = static_cast<std::uint8_t>(value >> 24U);
  bytes[offset + 1] = static_cast<std::uint8_t>(value >> 16U);
  bytes[offset + 2] = static_cast<std::uint8_t>(value >> 8U);
  bytes[offset + 3] = static_cast<std::uint8_t>(value);
}

inline std::string HexFingerprint(const std::array<std::uint8_t, 32>& fingerprint) {
  constexpr char kHex[] = "0123456789abcdef";
  std::string result;
  result.resize(fingerprint.size() * 2);
  for (std::size_t index = 0; index < fingerprint.size(); ++index) {
    result[index * 2] = kHex[fingerprint[index] >> 4U];
    result[index * 2 + 1] = kHex[fingerprint[index] & 0x0FU];
  }
  return result;
}

inline std::uint8_t MidiValue(const float value) noexcept {
  if (!std::isfinite(value) || value <= 0.0F) return 0;
  if (value >= 1.0F) return 127;
  return static_cast<std::uint8_t>(value * 127.0F);
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
  AcceptanceObserver* observer = nullptr;
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

  // The worker applies queued parameters on its next block, which a paused session never runs, so a state
  // read first delivers the ones still queued: the captured blob is never one change behind.
  std::optional<daw::plugin_host::WorkerState> CheckpointState() {
    std::array<daw::plugin_host::WorkerTransportEvent, daw::plugin_host::kMaximumWorkerEvents> pending{};
    const auto pending_count = event_scheduler.PendingParameters(pending);
    if (!worker.FlushParameters(std::span<const daw::plugin_host::WorkerTransportEvent>(pending.data(), pending_count))) {
      return std::nullopt;
    }
    return worker.GetState();
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

inline void ForwardWorkerDiagnostic(
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
  if (*kind == WorkerNotificationKind::kEditorState && attachment->observer) {
    char fields[384];
    std::snprintf(fields, sizeof(fields), ",\"instanceId\":\"%s\",\"open\":%s",
      attachment->metadata.instance_id.c_str(), diagnostic.value != 0 ? "true" : "false");
    attachment->observer->Event("vst-editor-state", fields);
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

inline void DispatchNativeVstGraphHook(const daw::audio_core::NativeGraphNodeRender& render) noexcept {
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
  // Each host owns its capture: a staged host replaces the active one while the old callback can still push to its tap.
  std::unique_ptr<AcceptanceObserver> observer;
  std::atomic<std::int64_t> publication_frame = 0;
  // The core's pinned budget and the published graph's own latency, recorded where the publication happens so a
  // later move cannot change what its event reports. A lower while playing leaves the budget where it was.
  void RecordPublicationLatency() {
    if (!observer) return;
    const auto core = active_core.load(std::memory_order_acquire);
    observer->SetPublicationLatency(
      daw::audio_core::InspectLatencyTransition(core).budget,
      daw::audio_core::PublishedGraphLatency(core),
      daw::audio_core::PublishedGraphSpectralPredecessors(core));
  }
  // Evidence-only ordinal. WorkerControlService::workerGeneration is a private
  // transport authentication value and must never be written to artifacts.

  void Evidence(const char* event, const char* cause = "", const std::uint32_t requested = 0,
    const char* detail = "") const {
    if (!observer) return;
    observer->Report(event, cause, active_revision.load(), applied_transport_epoch.load(),
      applied_transport_frame.load(), completed_render_epoch.load(), observer->publicationFrame(),
      observer->publicationEpoch(), requested, retired_after_epoch.load(), detail);
  }
  void PublicationEvidence(const char* cause) const {
    if (!observer) return;
    observer->PublicationCommitted(cause, active_revision.load(), applied_transport_epoch.load(),
      applied_transport_frame.load(), completed_render_epoch.load(), observer->publicationFrame(),
      observer->publicationEpoch(), retired_after_epoch.load());
  }
  // One line per prepared revision: the host's own stages and the core's sub-steps, in microseconds. `core` holds the
  // sub-steps that follow it, and a sub-step nested in another is counted in both (audio_core_native.h).
  using PrepareMarks = AcceptanceObserver::PrepareMarks;
  void PrepareProfileEvidence(const std::uint32_t revision, const daw_audio_core_handle core, const PrepareMarks& marks) const {
    if (!observer) return;
    observer->ReportPrepare(revision, core, marks, applied_transport_epoch.load(),
      applied_transport_frame.load(), completed_render_epoch.load(), observer->publicationFrame(),
      observer->publicationEpoch(), retired_after_epoch.load());
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
  // A prepared graph lives in the active core; this is nonzero from prepare until publish or rollback.
  daw_audio_core_handle prepared_core = 0;
  GraphRevisionContinuity prepared_continuity = GraphRevisionContinuity::kNotEvaluated;
  const std::uint64_t instrument_resident_budget = InstrumentResidentBudget();
  std::string_view instrument_preparation_error;
  std::string_view schedule_window_error;
  // The previous revision was published over on the active core. Its slots are
  // retired inside the core and only reusable once a block has completed.
  [[nodiscard]] bool HasRetiredPlan() const { return retired_revision.load(std::memory_order_acquire) != 0; }
  void RetirePreviousPlan(const std::uint32_t previous_revision) {
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
  // The callback is the only writer of the resolved record (acknowledged flag and result);
  // the drainer reads the result only for the recorded claim and only until that
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
  // A prepared graph is ready once every instrument target holds retained states; the prepare itself
  // answers that for a graph that adds no instrument, so the renderer sends no empty states call.
  void SettlePreparedInstruments() {
    instrument_preparation_error = {};
    prepared_instruments_ready = std::all_of(prepared_instrument_targets.begin(), prepared_instrument_targets.end(),
      [this](const auto& target) { return prepared_instrument_assets.contains(target.first); });
  }
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
    PublishAutomationCredits();
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
  std::array<std::atomic<std::uint32_t>, 2> automation_credit_totals{};
  // Set while the workers run, so an instance added to a live graph starts at once.
  std::optional<daw::plugin_host::WorkerProcessSetup::Mode> native_worker_mode;
  std::chrono::steady_clock::duration parked_age = std::chrono::milliseconds(kParkedNativeVstAgeMs);
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
  static constexpr std::uint32_t kRealtimeAcceptanceCapture = 1U << 7U;
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
      .publication_frame = publication_frame.load(std::memory_order_acquire),
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

  void DrainAcceptanceCapture() {
    if (observer && observer->tap()) observer->tap()->Drain();
  }

  // Non-realtime only. Before the first callback there is no populated revision/epoch to
  // report; the first real progress snapshot carries the counters this change touched.
  void PublishScheduleProgressChange() {
    if (schedule_progress_sequence.load(std::memory_order_acquire) == 0) return;
    schedule_progress_sequence.fetch_add(1, std::memory_order_release);
    NotifyScheduleProgress();
  }

  void ReportInstrumentRejections() {
    std::fprintf(stderr, "[native-instrument] permanent event rejection {total:%llu,firstNode:%llu,firstSequence:%llu}; valid subset rendered\n",
      static_cast<unsigned long long>(rejected_instrument_count.load(std::memory_order_acquire)),
      static_cast<unsigned long long>(rejected_instrument_node.load(std::memory_order_relaxed)),
      static_cast<unsigned long long>(rejected_instrument_sequence.load(std::memory_order_relaxed)));
    Evidence("instrument-event-rejected", "permanent-core-validation-failure");
  }

  void DispatchRealtimeBridge(const std::uint32_t pending, const bool final_drain) {
    if ((pending & kRealtimeAssetReaders) != 0) WakeAssetControl();
    // The capture tap can hold samples whose pending bit was consumed by an earlier drain; the last drain empties it.
    if (final_drain || (pending & kRealtimeAcceptanceCapture) != 0) DrainAcceptanceCapture();
    if ((pending & kRealtimePublishAcknowledged) != 0) PublicationEvidence("block-boundary");
    if ((pending & kRealtimeInstrumentRejected) != 0) ReportInstrumentRejections();
    if ((pending & kRealtimeLatencyCompleted) != 0) Evidence("latency-move-complete", "reader-epoch");
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
      if (observer
        && (observer->observedEpoch != schedule_progress_epoch.load()
          || observer->observedRunning != schedule_progress_running.load())) {
        observer->observedEpoch = schedule_progress_epoch.load();
        observer->observedRunning = schedule_progress_running.load();
        Evidence("transport");
      }
      // A live parameter write, such as a manual override of an automated one, publishes no graph: the callback's
      // applied sequence is the only sign it landed. Reset to zero by a stop, which is not an application.
      const auto processor_sequence = schedule_progress_processor.load(std::memory_order_acquire);
      if (observer && processor_sequence != observer->observedProcessorSequence) {
        observer->observedProcessorSequence = processor_sequence;
        if (processor_sequence != 0) {
          char detail[64];
          std::snprintf(detail, sizeof(detail), ",\"appliedProcessorSequence\":\"%llu\"",
            static_cast<unsigned long long>(processor_sequence));
          Evidence("processor-sequence-applied", "block-boundary", 0, detail);
        }
      }
      NotifyScheduleProgress();
    }
  }

  void StartRealtimeBridge() {
    realtime_bridge_running.store(true, std::memory_order_release);
    realtime_bridge_thread = std::thread([this] {
      while (realtime_bridge_running.load(std::memory_order_acquire)) {
        const std::uint32_t pending = realtime_bridge_pending.exchange(0, std::memory_order_acq_rel);
        DispatchRealtimeBridge(pending, false);
        if (pending != 0) continue;
        // CoreAudio callbacks cannot wake scheduler primitives. This bounded
        // non-realtime bridge observes callback atomics within 100 microseconds.
        std::unique_lock lock(realtime_bridge_wait_mutex);
        realtime_bridge_wait.wait_for(lock, std::chrono::microseconds(100), [this] {
          return !realtime_bridge_running.load(std::memory_order_acquire)
            || realtime_bridge_pending.load(std::memory_order_acquire) != 0;
        });
      }
      DispatchRealtimeBridge(realtime_bridge_pending.exchange(0, std::memory_order_acq_rel), true);
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
      .evidence_directory = observer ? observer->evidenceDirectory() : "",
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
    if (observer) {
      char fields[256];
      std::snprintf(fields, sizeof(fields), ",\"workerGeneration\":\"%llu\",\"nodeId\":\"%llu\"",
        static_cast<unsigned long long>(++observer->workerOrdinal),
        static_cast<unsigned long long>(metadata.graph_node_id));
      observer->Event("worker-supervisor-started", fields);
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
    PublishAutomationCredits();
  }
  // The schedule thread reads the total of the active bank instead of walking the attachment
  // map, which only the control thread may touch. Both banks are kept current so the realtime
  // bank flip publishes nothing. Called by the control thread after anything that changes the
  // map or an attachment's used segment count.
  void PublishAutomationCredits() {
    for (std::uint32_t bank = 0; bank < automation_credit_totals.size(); ++bank) {
      std::uint32_t credits = 0;
      for (const auto& [instance_id, attachment] : native_vst_attachments) {
        static_cast<void>(instance_id);
        const auto& automation = attachment->automation_banks[bank];
        const auto capacity = static_cast<std::uint32_t>(automation.segments[0].size());
        credits += capacity - std::min(automation.count.load(std::memory_order_acquire), capacity);
      }
      automation_credit_totals[bank].store(credits, std::memory_order_release);
    }
  }
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
  std::array<daw_audio_sample_source_event, daw::audio_core::kMaximumSourceDeclarations> seam_sources{};
  struct SourceSeam {
    daw::audio_core::SourceReconciliation admitted;
    std::uint32_t cursor = 0;
  };
  // Freezes the prepared bank's declarations that start by `frame`; the lane is consumed only by the commit.
  [[nodiscard]] std::optional<SourceSeam> AdmitSourceSeam(const std::int64_t frame) noexcept {
    auto& lane = PreparedSchedule().source_queue;
    const auto write = lane.write.load(std::memory_order_acquire);
    auto cursor = lane.read.load(std::memory_order_relaxed);
    std::size_t count = 0;
    for (; cursor != write; ++cursor) {
      const auto& event = lane.events[cursor % kSourceQueueCapacity];
      if (event.source.start_frame > frame) break;
      if (count == seam_sources.size()) return std::nullopt;
      seam_sources[count++] = event.source;
    }
    const auto admitted = daw::audio_core::AdmitSampleSources(active_core.load(std::memory_order_acquire),
      std::span<const daw_audio_sample_source_event>{seam_sources.data(), count}, frame);
    if (!admitted) return std::nullopt;
    return SourceSeam{.admitted = *admitted, .cursor = cursor};
  }
  void CommitSourceSeam(const SourceSeam& seam) noexcept {
    daw::audio_core::CommitSampleSources(active_core.load(std::memory_order_acquire), seam.admitted);
    PreparedSchedule().source_queue.read.store(seam.cursor, std::memory_order_release);
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
  // A staged instance whose worker is still loading has not joined: a graph prepared now would leave it out and
  // retire it at publication.
  bool StagedVstStarting() const {
    return std::any_of(native_vst_attachments.begin(), native_vst_attachments.end(), [](const auto& entry) {
      return entry.second->metadata.playback_enabled
        && entry.second->ownership == NativeVstWorkerAttachment::Ownership::kStaged
        && entry.second->worker.health() == daw::plugin_host::WorkerHealth::kStarting;
    });
  }
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

}  // namespace daw::audio_host_macos
