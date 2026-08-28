#include "daw/audio_host_macos.h"
#include "daw/audio_host_automation_override.h"
#include "daw/native-schedule-state.h"
#include "daw/audio_host_event_scheduler.h"
#include "daw/audio_core_native.h"
#include "daw/audio_core_instrument_wire.h"
#include "worker-control-protocol.h"
#include "worker-control-service.h"
#include "worker-supervisor.h"

#include <mach-o/dyld.h>

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

namespace daw::audio_host_macos {
namespace {

constexpr std::uint32_t kFrameMagic = 0x44415748U;  // DAWH
constexpr std::size_t kMaximumNativeVstAttachments = 64;
constexpr std::uint32_t kMaximumNativeVstFrames = 8'192;
constexpr std::uint32_t kMaximumNativeVstChannels = 64;
constexpr std::uint32_t kMaximumNativeVstSlots = 8;
constexpr std::size_t kGranularStateWireBytes = 60;
constexpr std::size_t kMaximumMeterQueueEntries = 1024;
constexpr std::size_t kMaximumSpectrumQueueEntries = 8;
constexpr std::uint32_t kSpectrumFftSize = 2048;

std::optional<std::string> WorkerExecutablePath() {
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
  NativeVstAttachment metadata;
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
  std::array<std::array<NativeVstAutomationSegment, kMaximumScheduleAutomationSegments>, 2>
    automation_segments{};
  std::atomic<std::uint32_t> automation_segment_count = 0;
  std::atomic<std::uint32_t> automation_buffer = 0;
  std::atomic<std::uint32_t> automation_epoch = 0;
  mutable std::atomic<bool> automation_callback_reading = false;
  mutable std::atomic<std::uint32_t> automation_callback_buffer = 0;
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
  ) const noexcept {
    const std::uint64_t block_end = static_cast<std::uint64_t>(block_start)
      + static_cast<std::uint64_t>(frame_count);
    const auto buffer = automation_callback_reading.load(std::memory_order_acquire)
      ? automation_callback_buffer.load(std::memory_order_relaxed)
      : automation_buffer.load(std::memory_order_acquire);
    const auto segment_count = automation_segment_count.load(std::memory_order_acquire);
    for (std::size_t index = 0; index < segment_count; ++index) {
      const auto& segment = automation_segments[buffer][index];
      if (segment.end_frame <= static_cast<std::uint64_t>(block_start)
        || segment.start_frame >= block_end
        || HasAutomationOverride(segment.parameter_id)) continue;
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
      };
      if (segment.linear && segment.end_frame < block_end
        && segment.end_frame > first_frame) {
        if (event_count >= maximum_events || event_count >= events.size()) return false;
        events[event_count++] = {
          .kind = daw::plugin_host::WorkerEventKind::kParameter,
          .sampleOffset = static_cast<std::uint32_t>(segment.end_frame - static_cast<std::uint64_t>(block_start)),
          .parameterId = segment.parameter_id,
          .parameterValue = value_at(segment.end_frame),
        };
      }
    }
    return true;
  }

  bool PublishAutomation(
    const std::uint32_t epoch,
    const std::uint64_t rendered_through_frame,
    std::span<const NativeVstAutomationSegment> additions
  ) noexcept {
    const auto active_buffer = automation_buffer.load(std::memory_order_acquire);
    const auto inactive_buffer = 1U - active_buffer;
    if (
      automation_callback_reading.load(std::memory_order_acquire)
      && automation_callback_buffer.load(std::memory_order_acquire) == inactive_buffer
    ) return false;
    const auto retained_epoch = automation_epoch.load(std::memory_order_acquire);
    const auto retained_count = retained_epoch == epoch
      ? automation_segment_count.load(std::memory_order_acquire)
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
    automation_segment_count.store(static_cast<std::uint32_t>(count), std::memory_order_release);
    automation_epoch.store(epoch, std::memory_order_release);
    automation_buffer.store(inactive_buffer, std::memory_order_release);
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
    if (input_channels > 0) {
      for (std::uint32_t channel = 0; channel < input_channels; ++channel) {
        std::memcpy(input.data() + channel * render.frame_count, render.planes[channel], render.frame_count * sizeof(float));
      }
    }
    const auto port = worker.callbackPort();
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
        static_cast<void>(port.DiscardLate(slot, sequence + 1));
        static_cast<void>(port.PublishDiagnostic({
          .kind = daw::plugin_host::WorkerDiagnosticKind::kMiss,
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
      const bool automation_current = automation_epoch.load(std::memory_order_acquire) == render.transport_epoch;
      if (automation_current) {
        automation_callback_buffer.store(
          automation_buffer.load(std::memory_order_acquire),
          std::memory_order_relaxed
        );
        automation_callback_reading.store(true, std::memory_order_release);
        const bool projected = ProjectAutomation(
          render.transport_frame,
          render.frame_count,
          std::span<daw::plugin_host::WorkerTransportEvent>(block_events.data(), block_events.size()),
          event_count,
          metadata.transport.maximum_events_per_block
        );
        automation_callback_reading.store(false, std::memory_order_release);
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
  std::atomic<bool> mute_requested = false;
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
  if (*kind == WorkerNotificationKind::kRestart || *kind == WorkerNotificationKind::kFault) {
    sink.mute_requested.store(true, std::memory_order_release);
  }
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
  std::atomic<std::uint32_t>* selected_index = nullptr;
  std::atomic<bool>* enabled = nullptr;
  std::atomic<std::uint32_t>* bridge_pending = nullptr;
  void Observe(const daw::audio_core::NativeGraphNodeRender& render) noexcept {
    if (enabled == nullptr || !enabled->load(std::memory_order_acquire)
      || selected_index == nullptr || render.node_index != selected_index->load(std::memory_order_acquire)
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
    || type > static_cast<std::uint32_t>(ControlType::kOfflineError)) return std::nullopt;
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

std::string CoreAudioDeviceId(std::string_view uid) {
  return uid.empty() ? std::string{} : "coreaudio:" + std::string(uid);
}

std::optional<std::string> CoreAudioDeviceUid(std::string_view device_id) {
  constexpr std::string_view prefix = "coreaudio:";
  if (!device_id.starts_with(prefix) || device_id.size() == prefix.size()) return std::nullopt;
  return std::string(device_id.substr(prefix.size()));
}

struct AudioHost::Impl {
  enum class RecordingCommand : std::uint32_t { kNone, kStop, kCancel };
  enum class QueuedControlKind : std::uint8_t { kUrgent, kProcessor, kInstrument, kSource };
  struct QueuedControlEvent {
    QueuedControlKind kind = QueuedControlKind::kProcessor;
    std::uint64_t window_id = 0;
    std::uint64_t absolute_frame = 0;
    bool scheduled = false;
    std::uint32_t processor_revision = 0;
    std::uint32_t processor_epoch = 0;
    std::uint64_t processor_sequence = 0;
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
  struct RealtimeProcessScratch {
    std::array<const float*, 64> input_slice{};
    std::array<float*, 64> output_slice{};
    std::array<daw_audio_processor_event, DAW_AUDIO_CORE_MAX_PROCESSOR_EVENTS> processor_events{};
    std::array<daw_audio_instrument_event, DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS> instrument_events{};
  };
  struct InstalledAsset {
    daw_audio_asset_handle handle = 0;
    std::vector<float> samples;
    std::array<const float*, 64> planes{};
    std::uint32_t frame_count = 0;
    std::uint32_t sample_rate_hz = 0;
    std::uint32_t channel_count = 0;
    std::uint64_t content_hash_prefix = 0;
  };
  std::atomic<daw_audio_core_handle> active_core = 0;
  daw_audio_core_handle prepared_core = 0;
  bool prepared_core_is_same_core = false;
  GraphRevisionContinuity prepared_continuity = GraphRevisionContinuity::kNotEvaluated;
  std::vector<std::uint8_t> prepared_graph_payload;
  daw_audio_core_handle retired_core = 0;
  HostConfig config{};
  std::atomic<LifecycleState> state = LifecycleState::kIdle;
  std::atomic<std::uint64_t> callback_attempts = 0;
  std::atomic<std::uint64_t> callbacks = 0;
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
  std::atomic<std::uint32_t> spectrum_selected_index{0};
  std::atomic<bool> spectrum_enabled{false};
  std::uint64_t spectrum_sequence = 0;
  std::array<float, kMaximumSpectrumBins> spectrum_smoothed{};
  bool spectrum_has_previous = false;
  std::array<float, kSpectrumFftSize> spectrum_history_left{};
  std::array<float, kSpectrumFftSize> spectrum_history_right{};
  std::uint32_t spectrum_history_count = 0;
  std::array<std::uint64_t, 64> spectrum_node_ids{};
  std::uint32_t spectrum_node_count = 0;
  std::atomic<std::uint64_t> retired_after_epoch = 0;
  std::atomic<std::uint32_t> publish_requested_revision = 0;
  std::atomic<std::uint32_t> publish_acknowledged_revision = 0;
  std::mutex publish_wait_mutex;
  std::condition_variable publish_wait;
  std::atomic<std::uint64_t> processor_patch_requested = 0;
  std::atomic<std::uint64_t> processor_patch_acknowledged = 0;
  std::atomic<std::uint32_t> processor_patch_result = DAW_AUDIO_CORE_NO_DATA;
  std::uint64_t processor_patch_sequence = 0;
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
  std::atomic<std::uint64_t> applied_urgent_sequence = 0;
  std::atomic<std::uint64_t> applied_processor_sequence = 0;
  std::atomic<std::uint64_t> last_queued_processor_sequence = 0;
  std::atomic<std::uint32_t> last_graph_revision = 0;
  ControlLane<kUrgentQueueCapacity> urgent_queue{};
  ControlLane<kInstrumentQueueCapacity> instrument_queue{};
  ControlLane<kSourceQueueCapacity> source_queue{};
  ControlLane<kProcessorQueueCapacity> processor_queue{};
  RealtimeProcessScratch realtime_process_scratch{};
  bool graph_prepared = false;
  bool transport_prepared = false;
  void* device_session = nullptr;
  void* recording_device_session = nullptr;
  std::unordered_map<std::uint32_t, InstalledAsset> assets;
  std::unordered_map<std::uint32_t, daw_audio_asset_handle> prepared_asset_handles;
  std::unordered_map<std::string, std::unique_ptr<NativeVstWorkerAttachment>> native_vst_attachments;
  bool native_graph_revision_required = false;
  WorkerNotificationSink worker_notifications{};
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
    recording_status_revision.fetch_add(1, std::memory_order_release);
    recording_wait.notify_all();
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
    };
  }

  // DAW_REALTIME_CALLBACK_HELPER_END audio-host

  void StartRealtimeBridge() {
    realtime_bridge_running.store(true, std::memory_order_release);
    realtime_bridge_thread = std::thread([this] {
      while (realtime_bridge_running.load(std::memory_order_acquire)) {
        const std::uint32_t pending = realtime_bridge_pending.exchange(0, std::memory_order_acq_rel);
        if ((pending & kRealtimePublishAcknowledged) != 0) publish_wait.notify_all();
        if ((pending & kRealtimeProcessorPatchAcknowledged) != 0) publish_wait.notify_all();
        if ((pending & kRealtimeRecordingStatus) != 0) NotifyRecordingStatus();
        if ((pending & NativeMeterObserver::kMeterReadyBit) != 0) meter_wait.notify_all();
        if ((pending & (1U << 4U)) != 0) spectrum_wait.notify_all();
        if ((pending & kRealtimeScheduleProgress) != 0) {
          schedule_progress_ready.store(true, std::memory_order_release);
          schedule_progress_wait.notify_all();
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
      if ((pending & kRealtimePublishAcknowledged) != 0) publish_wait.notify_all();
      if ((pending & kRealtimeProcessorPatchAcknowledged) != 0) publish_wait.notify_all();
      if ((pending & kRealtimeRecordingStatus) != 0) NotifyRecordingStatus();
      if ((pending & NativeMeterObserver::kMeterReadyBit) != 0) meter_wait.notify_all();
      if ((pending & (1U << 4U)) != 0) spectrum_wait.notify_all();
      if ((pending & kRealtimeScheduleProgress) != 0) {
        schedule_progress_ready.store(true, std::memory_order_release);
        schedule_progress_wait.notify_all();
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
  [[nodiscard]] bool StartNativeVstWorkers(
    const daw::plugin_host::WorkerProcessSetup::Mode mode
  ) {
    offline_failure.store(false, std::memory_order_release);
    const bool has_enabled_attachment = std::any_of(
      native_vst_attachments.begin(),
      native_vst_attachments.end(),
      [](const auto& entry) { return entry.second->metadata.playback_enabled; }
    );
    const auto worker_executable = has_enabled_attachment ? WorkerExecutablePath() : std::optional<std::string>{};
    if (has_enabled_attachment && !worker_executable) return false;
    std::array<NativeVstWorkerAttachment*, kMaximumNativeVstAttachments> started{};
    std::size_t started_count = 0;
    for (auto& [instance_id, attachment] : native_vst_attachments) {
      static_cast<void>(instance_id);
      if (!attachment->metadata.playback_enabled) continue;
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
      const daw::plugin_host::WorkerStartupRequest startup{
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
        .executable = *worker_executable,
        .artifact = {
          .id = std::string(daw::plugin_host::kWorkerArtifactId),
          .version = std::string(daw::plugin_host::kWorkerArtifactVersion),
        },
      };
      attachment->worker.SetDiagnosticListener(ForwardWorkerDiagnostic, attachment.get());
      if (!attachment->worker.Start(startup, worker_configuration, transport)) {
        for (std::size_t index = 0; index < started_count; ++index) {
          started[index]->worker.Stop();
        }
        return false;
      }
      if (attachment->worker.workerGeneration() == 0) {
        attachment->worker.Stop();
        for (std::size_t index = 0; index < started_count; ++index) {
          started[index]->worker.Stop();
        }
        return false;
      }
      started[started_count++] = attachment.get();
    }
    return true;
  }
  void StopNativeVstWorkers() {
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
    urgent_queue.read.store(urgent_queue.write.load(std::memory_order_acquire), std::memory_order_release);
    instrument_queue.read.store(instrument_queue.write.load(std::memory_order_acquire), std::memory_order_release);
    source_queue.read.store(source_queue.write.load(std::memory_order_acquire), std::memory_order_release);
    processor_queue.read.store(processor_queue.write.load(std::memory_order_acquire), std::memory_order_release);
    transport_queue.read.store(transport_queue.write.load(std::memory_order_acquire), std::memory_order_release);
    published_schedule_window_id.store(0, std::memory_order_release);
    accepted_schedule_epoch.store(0, std::memory_order_release);
    accepted_schedule_through_frame.store(transport_frame.load(std::memory_order_acquire), std::memory_order_release);
    schedule_complete.store(false, std::memory_order_release);
    last_accepted_schedule_window_id = 0;
    last_accepted_schedule_epoch = 0;
    last_schedule_start_frame = 0;
    schedule_digest_windows = {};
    schedule_chunk_digests = {};
    schedule_digest_cursor = 0;
    schedule_staging.clear();
  }
  [[nodiscard]] bool EnqueueControlEvent(const QueuedControlEvent& event) {
    if (event.kind == QueuedControlKind::kUrgent) return EnqueueControlEvent(urgent_queue, event);
    if (event.kind == QueuedControlKind::kInstrument) return EnqueueControlEvent(instrument_queue, event);
    if (event.kind == QueuedControlKind::kSource) return EnqueueControlEvent(source_queue, event);
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
    if (kind == QueuedControlKind::kSource) return HasCapacity(source_queue, count);
    return HasCapacity(processor_queue, count);
  }
  template <std::size_t Capacity>
  static bool HasQueuedControl(const ControlLane<Capacity>& lane) {
    return lane.read.load(std::memory_order_acquire) != lane.write.load(std::memory_order_acquire);
  }
  [[nodiscard]] bool HasQueuedControl() const {
    return HasQueuedControl(urgent_queue) || HasQueuedControl(instrument_queue)
      || HasQueuedControl(source_queue) || HasQueuedControl(processor_queue);
  }
  [[nodiscard]] daw_audio_core_handle CreateRevisionCore(const std::uint32_t revision) {
    daw_audio_core_handle core = 0;
    const daw_audio_core_config core_config{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
      .max_frames_per_block = config.max_frames_per_block,
      .max_channels = config.channel_count,
      .max_assets = 64,
      .sample_rate_hz = config.sample_rate_hz,
    };
    if (daw_audio_core_create(&core_config, &core) != DAW_AUDIO_CORE_OK) return 0;
    prepared_asset_handles.clear();
    std::vector<std::uint32_t> asset_ids;
    asset_ids.reserve(assets.size());
    for (const auto& [asset_id, asset] : assets) {
      static_cast<void>(asset);
      asset_ids.push_back(asset_id);
    }
    std::sort(asset_ids.begin(), asset_ids.end());
    for (const auto asset_id : asset_ids) {
      const auto asset_iterator = assets.find(asset_id);
      if (asset_iterator == assets.end()) continue;
      const auto& asset = asset_iterator->second;
      const daw_audio_asset_descriptor descriptor{
        .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
        .revision = revision,
        .byte_length = static_cast<std::uint64_t>(asset.samples.size() * sizeof(float)),
        .content_hash_prefix = asset.content_hash_prefix,
        .frame_count = asset.frame_count,
        .sample_rate_hz = asset.sample_rate_hz,
        .channel_count = asset.channel_count,
        .planes = asset.planes.data(),
      };
      daw_audio_asset_handle handle = 0;
      if (daw_audio_core_create_asset(core, &descriptor, &handle) != DAW_AUDIO_CORE_OK) {
        daw_audio_core_destroy(core);
        prepared_asset_handles.clear();
        return 0;
      }
      prepared_asset_handles.emplace(asset_id, handle);
    }
    if (transport_prepared) {
      const daw_audio_transport_state state{
        .epoch = transport_epoch.load(std::memory_order_acquire),
        .running = transport_running.load(std::memory_order_acquire) ? 1U : 0U,
        .frame = transport_frame.load(std::memory_order_acquire),
        .tempo_bpm = 0.0,
        .time_signature_numerator = 0,
        .time_signature_denominator = 0,
        .cycle_active = 0,
        .cycle_start_frame = 0,
        .cycle_end_frame = 0,
      };
      if (daw_audio_core_set_transport(core, &state) != DAW_AUDIO_CORE_OK) {
        daw_audio_core_destroy(core);
        prepared_asset_handles.clear();
        return 0;
      }
    }
    return core;
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
      if (!attachment->metadata.playback_enabled) continue;
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
    return daw::audio_core::RegisterNativeGraphHook(
      core,
      {
        .graph_revision = revision,
        .hook = bindings.empty() ? nullptr : DispatchNativeVstGraphHook,
        .bindings = bindings,
        .observer = NativeTelemetryObserver::Dispatch,
        .observer_attachment = &telemetry_observer,
      }
    ) == DAW_AUDIO_CORE_OK;
  }
};

AudioHost::AudioHost() : impl_(new Impl) {
  impl_->worker_notifications.active_revision = &impl_->active_revision;
  impl_->meter_observer.bridge_pending = &impl_->realtime_bridge_pending;
  impl_->spectrum_observer.selected_index = &impl_->spectrum_selected_index;
  impl_->spectrum_observer.enabled = &impl_->spectrum_enabled;
  impl_->spectrum_observer.bridge_pending = &impl_->realtime_bridge_pending;
  impl_->telemetry_observer.meter = &impl_->meter_observer;
  impl_->telemetry_observer.spectrum = &impl_->spectrum_observer;
  impl_->StartRealtimeBridge();
}

AudioHost::~AudioHost() {
  Stop();
  impl_->StopRealtimeBridge();
  const daw_audio_core_handle capture = impl_->recording_capture.exchange(0, std::memory_order_acq_rel);
  if (capture != 0) daw_audio_recording_capture_destroy(capture);
  const daw_audio_core_handle active_core = impl_->active_core.load(std::memory_order_acquire);
  if (active_core != 0) daw_audio_core_destroy(active_core);
  if (impl_->prepared_core != 0 && !impl_->prepared_core_is_same_core) daw_audio_core_destroy(impl_->prepared_core);
  if (impl_->retired_core != 0) daw_audio_core_destroy(impl_->retired_core);
  delete impl_;
}

bool AudioHost::Configure(const HostConfig& config) {
  if (!ValidConfig(config) || impl_->state.load(std::memory_order_acquire) == LifecycleState::kRunning) return false;
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
  if (impl_->prepared_core != 0) daw_audio_core_destroy(impl_->prepared_core);
  if (impl_->retired_core != 0) daw_audio_core_destroy(impl_->retired_core);
  impl_->prepared_core = 0;
  impl_->prepared_core_is_same_core = false;
  impl_->prepared_continuity = GraphRevisionContinuity::kNotEvaluated;
  impl_->prepared_graph_payload.clear();
  impl_->retired_core = 0;
  impl_->config = config;
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
  impl_->prepared_asset_handles.clear();
  for (auto& [instance_id, attachment] : impl_->native_vst_attachments) {
    static_cast<void>(instance_id);
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
  impl_->transport_queue.read.store(0, std::memory_order_release);
  impl_->transport_queue.write.store(0, std::memory_order_release);
  impl_->accepted_schedule_epoch.store(0, std::memory_order_release);
  impl_->accepted_schedule_through_frame.store(0, std::memory_order_release);
  impl_->published_schedule_window_id.store(0, std::memory_order_release);
  impl_->schedule_complete.store(false, std::memory_order_release);
  impl_->last_accepted_schedule_window_id = 0;
  impl_->last_accepted_schedule_epoch = 0;
  impl_->last_schedule_start_frame = 0;
  impl_->schedule_digest_windows = {};
  impl_->schedule_chunk_digests = {};
  impl_->schedule_digest_cursor = 0;
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
  impl_->spectrum_enabled.store(false, std::memory_order_release);
  impl_->spectrum_selected_index.store(0, std::memory_order_release);
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
  impl_->source_queue.read.store(0, std::memory_order_release);
  impl_->source_queue.write.store(0, std::memory_order_release);
  impl_->processor_queue.read.store(0, std::memory_order_release);
  impl_->processor_queue.write.store(0, std::memory_order_release);
  impl_->worker_notifications.mute_requested.store(false, std::memory_order_release);
  return true;
}

bool AudioHost::PrepareAndPublishGraph(const std::uint32_t revision, const std::span<const std::uint8_t> snapshot) {
  const auto prepared = PrepareGraphRevision(revision, snapshot);
  if (prepared.code != GraphRevisionStatusCode::kPrepared) return false;
  const auto published = PublishGraphRevision(revision);
  if (published.code != GraphRevisionStatusCode::kPublished) {
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
  const std::span<const std::uint8_t> snapshot
) {
  const auto status = [this, revision](const GraphRevisionStatusCode code) {
    return impl_->GraphStatus(code, revision);
  };
  if (impl_->active_core.load(std::memory_order_acquire) == 0 || revision == 0
    || snapshot.size() <= kNativeGraphFrameHeaderBytes || snapshot.size() > kMaximumControlPayloadBytes) {
    return status(GraphRevisionStatusCode::kInvalidRevision);
  }
  if (impl_->HasQueuedControl() || impl_->prepared_core != 0 || impl_->retired_core != 0
    || revision <= impl_->last_graph_revision.load(std::memory_order_acquire)) {
    return status(GraphRevisionStatusCode::kStaleRevision);
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
  impl_->prepared_graph_payload.assign(payload.begin(), payload.end());
  const daw_audio_core_handle active_core = impl_->active_core.load(std::memory_order_acquire);
  daw_audio_core_handle prepared_core = active_core;
  bool same_core = false;
  impl_->prepared_continuity = GraphRevisionContinuity::kFallback;
  daw_audio_core_result same_core_result = DAW_AUDIO_CORE_OK;
  if (active_core != 0) {
    same_core_result = daw_audio_core_prepare_graph_bytes(
      active_core,
      payload.data(),
      static_cast<std::uint32_t>(payload.size()));
    if (same_core_result == DAW_AUDIO_CORE_OK
      && daw_audio_core_prepared_graph_continuity(active_core) != 0) {
      same_core = true;
      impl_->prepared_continuity = GraphRevisionContinuity::kAccepted;
    } else if (same_core_result != DAW_AUDIO_CORE_OK
      && same_core_result != DAW_AUDIO_CORE_GRAPH_COMPATIBILITY_REJECTED
      && same_core_result != DAW_AUDIO_CORE_LATENCY_CHANGE_DEFERRED
      && same_core_result != DAW_AUDIO_CORE_RETIREMENT_CAPACITY_EXCEEDED
      && same_core_result != DAW_AUDIO_CORE_CAPACITY_EXCEEDED) {
      impl_->prepared_continuity = GraphRevisionContinuity::kRejected;
      LogGraphPrepareFailure(revision, same_core_result, active_core);
      return status(GraphRevisionStatusCode::kPrepareFailed);
    }
  }
  if (!same_core && (same_core_result == DAW_AUDIO_CORE_OK
      || same_core_result == DAW_AUDIO_CORE_RETIREMENT_CAPACITY_EXCEEDED
      || same_core_result == DAW_AUDIO_CORE_CAPACITY_EXCEEDED)) {
    static_cast<void>(daw_audio_core_cancel_prepared_graph(active_core, revision));
  }
  if (!same_core) prepared_core = impl_->CreateRevisionCore(revision);
  if (prepared_core == 0) {
    impl_->prepared_continuity = GraphRevisionContinuity::kRejected;
    return status(GraphRevisionStatusCode::kPrepareFailed);
  }
  const auto discard_prepared = [&] {
    if (same_core) {
      static_cast<void>(daw_audio_core_cancel_prepared_graph(prepared_core, revision));
    } else {
      daw_audio_core_destroy(prepared_core);
    }
    impl_->prepared_asset_handles.clear();
    impl_->prepared_graph_payload.clear();
  };
  impl_->spectrum_node_count = 0;
  impl_->spectrum_node_ids.fill(0);
  const auto prepare_result = same_core
    ? DAW_AUDIO_CORE_OK
    : daw_audio_core_prepare_graph_bytes(
      prepared_core,
      payload.data(),
      static_cast<std::uint32_t>(payload.size()));
  if (prepare_result != DAW_AUDIO_CORE_OK) {
    impl_->prepared_continuity = GraphRevisionContinuity::kRejected;
    LogGraphPrepareFailure(revision, prepare_result, prepared_core);
    discard_prepared();
    return status(GraphRevisionStatusCode::kPrepareFailed);
  }
  if (payload.size() >= 24) {
    const auto envelope_version = ReadLeU32(payload.data());
    const auto node_count = ReadLeU32(payload.data() + 8);
    const auto node_bytes = envelope_version >= DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION_EXTERNAL_LATENCY ? 136U : 132U;
    if ((envelope_version == DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION
      || envelope_version == DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION_EXTERNAL_LATENCY)
      && node_count <= 64
      && payload.size() >= 24 + static_cast<std::size_t>(node_count) * node_bytes) {
      impl_->spectrum_node_count = node_count;
      for (std::uint32_t index = 0; index < node_count; ++index) {
        impl_->spectrum_node_ids[index] = ReadLeU64(payload.data() + 24 + static_cast<std::size_t>(index) * node_bytes);
      }
    }
  }
  if (!impl_->RegisterPreparedGraphHooks(prepared_core, revision)) {
    impl_->prepared_continuity = GraphRevisionContinuity::kRejected;
    discard_prepared();
    return status(GraphRevisionStatusCode::kPrepareFailed);
  }
  impl_->prepared_core = prepared_core;
  impl_->prepared_core_is_same_core = same_core;
  impl_->prepared_revision.store(revision, std::memory_order_release);
  return status(GraphRevisionStatusCode::kPrepared);
}

bool AudioHost::ConfigureInstrumentStates(const std::span<const std::uint8_t> payload) {
  const daw_audio_core_handle target_core = impl_->prepared_core != 0
    ? impl_->prepared_core
    : impl_->active_core.load(std::memory_order_acquire);
  if (target_core == 0 || payload.size() < 4) return false;
  const std::uint32_t count = ReadLeU32(payload.data());
  if (count > 64) return false;
  const auto configure = [&](const daw_audio_core_handle core) {
    std::size_t offset = 4;
    for (std::uint32_t index = 0; index < count; ++index) {
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
          result = daw_audio_core_configure_synth(core, node_id, &state);
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
        }
        if (decoded) {
          result = daw_audio_core_configure_sampler(
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
        result = daw_audio_core_configure_granular(core, node_id, &state);
      }
      if (result != DAW_AUDIO_CORE_OK) return false;
    }
    return offset == payload.size();
  };
  if (!configure(target_core)) return false;
  if (impl_->prepared_core == 0 || !impl_->prepared_core_is_same_core
    || daw_audio_core_prepared_graph_continuity(target_core) != 0) return true;

  const std::uint32_t revision = impl_->prepared_revision.load(std::memory_order_acquire);
  if (revision == 0 || impl_->prepared_graph_payload.empty()
    || daw_audio_core_cancel_prepared_graph(target_core, revision) != DAW_AUDIO_CORE_OK) return false;
  impl_->prepared_core = 0;
  impl_->prepared_core_is_same_core = false;
  impl_->prepared_revision.store(0, std::memory_order_release);
  const daw_audio_core_handle fallback_core = impl_->CreateRevisionCore(revision);
  if (fallback_core == 0
    || daw_audio_core_prepare_graph_bytes(
      fallback_core,
      impl_->prepared_graph_payload.data(),
      static_cast<std::uint32_t>(impl_->prepared_graph_payload.size())) != DAW_AUDIO_CORE_OK
    || !configure(fallback_core)
    || !impl_->RegisterPreparedGraphHooks(fallback_core, revision)) {
    if (fallback_core != 0) daw_audio_core_destroy(fallback_core);
    impl_->prepared_asset_handles.clear();
    impl_->prepared_graph_payload.clear();
    return false;
  }
  impl_->prepared_core = fallback_core;
  impl_->prepared_core_is_same_core = false;
  impl_->prepared_revision.store(revision, std::memory_order_release);
  impl_->prepared_continuity = GraphRevisionContinuity::kFallback;
  return true;
}

GraphRevisionStatus AudioHost::PublishGraphRevision(const std::uint32_t revision) {
  const auto status = [this, revision](const GraphRevisionStatusCode code) {
    return impl_->GraphStatus(code, revision);
  };
  if (revision == 0 || impl_->prepared_core == 0
    || impl_->prepared_revision.load(std::memory_order_acquire) != revision) {
    return status(GraphRevisionStatusCode::kStaleRevision);
  }
  const auto publish_at_boundary = [this, revision] {
    if (impl_->prepared_core_is_same_core) {
      if (daw_audio_core_publish(impl_->active_core.load(std::memory_order_acquire), revision) != DAW_AUDIO_CORE_OK) {
        return false;
      }
      impl_->active_revision.store(revision, std::memory_order_release);
      impl_->prepared_core = 0;
      impl_->prepared_core_is_same_core = false;
      impl_->prepared_revision.store(0, std::memory_order_release);
      impl_->last_graph_revision.store(revision, std::memory_order_release);
      return true;
    }
    if (daw_audio_core_publish(impl_->prepared_core, revision) != DAW_AUDIO_CORE_OK) return false;
    const daw_audio_core_handle previous_core = impl_->active_core.exchange(impl_->prepared_core, std::memory_order_acq_rel);
    const std::uint32_t previous_revision = impl_->active_revision.exchange(revision, std::memory_order_acq_rel);
    impl_->prepared_core = 0;
    impl_->prepared_revision.store(0, std::memory_order_release);
    impl_->retired_core = previous_core;
    impl_->retired_revision.store(previous_revision, std::memory_order_release);
    impl_->retired_after_epoch.store(impl_->completed_render_epoch.load(std::memory_order_acquire), std::memory_order_release);
    impl_->last_graph_revision.store(revision, std::memory_order_release);
    impl_->graph_prepared = true;
    impl_->native_graph_revision_required = false;
    return true;
  };
  const auto publish_asset_handles = [this] {
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
    impl_->prepared_graph_payload.clear();
    if (!replacing_graph) {
      daw_audio_core_destroy(impl_->retired_core);
      impl_->retired_core = 0;
      impl_->retired_revision.store(0, std::memory_order_release);
    }
    return status(GraphRevisionStatusCode::kPublished);
  }
  impl_->publish_acknowledged_revision.store(0, std::memory_order_release);
  impl_->publish_requested_revision.store(revision, std::memory_order_release);
  std::unique_lock lock(impl_->publish_wait_mutex);
  if (!impl_->publish_wait.wait_for(lock, std::chrono::seconds(1), [this, revision] {
    return impl_->publish_acknowledged_revision.load(std::memory_order_acquire) == revision;
  })) {
    std::uint32_t expected = revision;
    if (impl_->publish_requested_revision.compare_exchange_strong(
      expected,
      0,
      std::memory_order_acq_rel,
      std::memory_order_acquire
    )) {
      return status(GraphRevisionStatusCode::kPublishFailed);
    }
    impl_->publish_wait.wait(lock, [this, revision] {
      return impl_->publish_acknowledged_revision.load(std::memory_order_acquire) == revision;
    });
  }
  if (impl_->publish_acknowledged_revision.load(std::memory_order_acquire) != revision) {
    return status(GraphRevisionStatusCode::kPublishFailed);
  }
  publish_asset_handles();
  impl_->graph_prepared = true;
  impl_->native_graph_revision_required = false;
  return status(GraphRevisionStatusCode::kPublished);
}

GraphRevisionStatus AudioHost::RollbackGraphRevision(const std::uint32_t revision) {
  const auto code = revision != 0 && impl_->prepared_core != 0
    && impl_->prepared_revision.load(std::memory_order_acquire) == revision
    ? GraphRevisionStatusCode::kRolledBack
    : GraphRevisionStatusCode::kStaleRevision;
  if (code == GraphRevisionStatusCode::kRolledBack) {
    if (impl_->prepared_core_is_same_core) {
      static_cast<void>(daw_audio_core_cancel_prepared_graph(impl_->prepared_core, revision));
    } else {
      daw_audio_core_destroy(impl_->prepared_core);
    }
    impl_->prepared_core = 0;
    impl_->prepared_core_is_same_core = false;
    impl_->prepared_revision.store(0, std::memory_order_release);
    impl_->prepared_asset_handles.clear();
    impl_->prepared_graph_payload.clear();
  }
  return {
    .code = code,
    .requested_revision = revision,
    .active_revision = impl_->active_revision.load(std::memory_order_acquire),
    .prepared_revision = impl_->prepared_revision.load(std::memory_order_acquire),
    .retired_revision = impl_->retired_revision.load(std::memory_order_acquire),
    .render_epoch = impl_->completed_render_epoch.load(std::memory_order_acquire),
  };
}

GraphRevisionStatus AudioHost::RetireGraphRevision(const std::uint32_t revision) {
  GraphRevisionStatusCode code = GraphRevisionStatusCode::kStaleRevision;
  if (revision != 0 && impl_->retired_core != 0
    && impl_->retired_revision.load(std::memory_order_acquire) == revision) {
    if (impl_->completed_render_epoch.load(std::memory_order_acquire)
      < impl_->retired_after_epoch.load(std::memory_order_acquire)) {
      code = GraphRevisionStatusCode::kRetirementNotSafe;
    } else {
      daw_audio_core_destroy(impl_->retired_core);
      impl_->retired_core = 0;
      impl_->retired_revision.store(0, std::memory_order_release);
      code = GraphRevisionStatusCode::kRetired;
    }
  }
  return {
    .code = code,
    .requested_revision = revision,
    .active_revision = impl_->active_revision.load(std::memory_order_acquire),
    .prepared_revision = impl_->prepared_revision.load(std::memory_order_acquire),
    .retired_revision = impl_->retired_revision.load(std::memory_order_acquire),
    .render_epoch = impl_->completed_render_epoch.load(std::memory_order_acquire),
  };
}

bool AudioHost::QueueParameterEvents(const std::span<const std::uint8_t> payload) {
  if (impl_->prepared_core != 0 || payload.size() < 4) return false;
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
  if (has_batch) {
    auto last_sequence = impl_->last_queued_processor_sequence.load(std::memory_order_acquire);
    while (batch_sequence > last_sequence
      && !impl_->last_queued_processor_sequence.compare_exchange_weak(
        last_sequence, batch_sequence, std::memory_order_acq_rel, std::memory_order_acquire)) {}
    if (batch_sequence <= last_sequence) return false;
  }
  if (!impl_->HasCapacity(Impl::QueuedControlKind::kProcessor, count)) return false;
  const std::size_t offset = has_batch ? 20 : 4;
  for (std::uint32_t index = 0; index < count; ++index) {
    const auto* bytes = payload.data() + offset + index * 20;
    if (ReadLeU64(bytes) == 0
      || ReadLeU32(bytes + 8) == 0
      || ReadLeU32(bytes + 12) >= impl_->config.max_frames_per_block
      || !std::isfinite(ReadLeFloat(bytes + 16))) return false;
    Impl::QueuedControlEvent event{};
    event.kind = Impl::QueuedControlKind::kProcessor;
    event.processor_revision = batch_revision;
    event.processor_epoch = batch_epoch;
    event.processor_sequence = batch_sequence;
    event.processor = {.processor_instance_id = ReadLeU64(bytes), .parameter_target = ReadLeU32(bytes + 8),
      .frame_offset = ReadLeU32(bytes + 12), .value = ReadLeFloat(bytes + 16)};
    if (!impl_->EnqueueControlEvent(event)) return false;
  }
  return true;
}

bool AudioHost::QueueProcessorStatePatch(const std::span<const std::uint8_t> payload) {
  if (impl_->prepared_core != 0 || payload.size() < 56 || payload.size() > 512
    || impl_->active_core.load(std::memory_order_acquire) == 0) return false;
  if (ReadLeU32(payload.data()) != 1) return false;
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
    || payload.size() != 56 + static_cast<std::size_t>(state_size) + static_cast<std::size_t>(parameter_count) * 4
    || revision != impl_->active_revision.load(std::memory_order_acquire)) return false;
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
  if (staged != DAW_AUDIO_CORE_OK) return false;
  if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kRunning) {
    return daw_audio_core_apply_staged_processor_state_patch(core) == DAW_AUDIO_CORE_OK;
  }
  const std::uint64_t token = ++impl_->processor_patch_sequence;
  impl_->processor_patch_result.store(DAW_AUDIO_CORE_NO_DATA, std::memory_order_release);
  impl_->processor_patch_acknowledged.store(0, std::memory_order_release);
  impl_->processor_patch_requested.store(token, std::memory_order_release);
  std::unique_lock lock(impl_->publish_wait_mutex);
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
  if (!impl_->publish_wait.wait_until(lock, deadline, [this, token] {
    return impl_->processor_patch_acknowledged.load(std::memory_order_acquire) == token;
  })) {
    std::uint64_t expected = token;
    if (impl_->processor_patch_requested.compare_exchange_strong(
      expected, 0, std::memory_order_acq_rel, std::memory_order_acquire)) {
      const auto cancelled = daw_audio_core_cancel_staged_processor_state_patch(core);
      if (cancelled == DAW_AUDIO_CORE_OK) return false;
    }
    if (!impl_->publish_wait.wait_for(lock, std::chrono::seconds(1), [this, token] {
      return impl_->processor_patch_acknowledged.load(std::memory_order_acquire) == token;
    })) return false;
  }
  return impl_->processor_patch_result.load(std::memory_order_acquire) == DAW_AUDIO_CORE_OK;
}

bool AudioHost::QueueInstrumentEvents(const std::span<const std::uint8_t> payload) {
  if (impl_->prepared_core != 0 || payload.size() < 4) return false;
  const std::uint32_t count = ReadLeU32(payload.data());
  if (count > DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS || payload.size() != 4 + static_cast<std::size_t>(count) * 48) return false;
  const auto is_urgent = [&](const std::uint32_t index) {
    const auto type = ReadLeU32(payload.data() + 4 + index * 48 + 32);
    return type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOn)
      || type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOff)
      || type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kTransportRelease)
      || type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kAllSoundOff);
  };
  std::uint32_t urgent_count = 0;
  for (std::uint32_t index = 0; index < count; ++index) if (is_urgent(index)) ++urgent_count;
  if (!impl_->HasCapacity(Impl::QueuedControlKind::kUrgent, urgent_count)
    || !impl_->HasCapacity(Impl::QueuedControlKind::kInstrument, count - urgent_count)) return false;
  for (std::uint32_t index = 0; index < count; ++index) {
    const auto* bytes = payload.data() + 4 + index * 48;
    Impl::QueuedControlEvent event{};
    event.kind = is_urgent(index) ? Impl::QueuedControlKind::kUrgent : Impl::QueuedControlKind::kInstrument;
    event.instrument = {.node_id = ReadLeU64(bytes), .note_id = ReadLeU64(bytes + 8), .sequence = ReadLeU64(bytes + 16),
      .epoch = ReadLeU32(bytes + 24), .frame_offset = ReadLeU32(bytes + 28), .type = ReadLeU32(bytes + 32),
      .channel = ReadLeU32(bytes + 36), .note = ReadLeU32(bytes + 40), .value = ReadLeFloat(bytes + 44)};
    if (!ValidNativeInstrumentEvent(event.instrument)) return false;
    if (!impl_->EnqueueControlEvent(event)) return false;
  }
  return true;
}

bool AudioHost::QueueSourceEvents(const std::span<const std::uint8_t> payload) {
  if (impl_->prepared_core != 0 || payload.size() < 4) return false;
  const std::uint32_t count = ReadLeU32(payload.data());
  if (count > DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS || payload.size() != 4 + static_cast<std::size_t>(count) * 112) return false;
  if (!impl_->HasCapacity(Impl::QueuedControlKind::kSource, count)) return false;
  for (std::uint32_t index = 0; index < count; ++index) {
    const auto* bytes = payload.data() + 4 + index * 112;
    const auto asset = impl_->assets.find(ReadLeU32(bytes + 20));
    if (asset == impl_->assets.end()) return false;
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
  if (payload.size() < 56 || impl_->prepared_core != 0) return false;
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
  if (revision == 0 || revision != impl_->active_revision.load(std::memory_order_acquire)
    || epoch == 0 || epoch != impl_->transport_epoch.load(std::memory_order_acquire)
    || window_id == 0 || start_frame >= end_frame || end_frame > std::numeric_limits<std::int64_t>::max()
    || chunk_count == 0 || chunk_count > kMaximumScheduleChunks || chunk_index >= chunk_count
    || ends_schedule > 1
    || (ends_schedule == 1 && chunk_index + 1 != chunk_count)
    || instrument_count + source_count + automation_count > kMaximumScheduleRecords
    || instrument_count > DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS
    || source_count > DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS
    || automation_count > kMaximumScheduleAutomationSegments) return false;
  if (impl_->last_accepted_schedule_epoch != epoch) {
    impl_->last_accepted_schedule_window_id = 0;
    impl_->last_accepted_schedule_epoch = epoch;
    impl_->last_schedule_start_frame = 0;
    impl_->schedule_digest_windows = {};
    impl_->schedule_chunk_digests = {};
    impl_->schedule_digest_cursor = 0;
    impl_->schedule_staging.clear();
    impl_->schedule_complete.store(false, std::memory_order_release);
  }
  const auto digest = [&] {
    std::uint64_t result = 1469598103934665603ULL;
    for (const auto byte : payload) {
      result ^= byte;
      result *= 1099511628211ULL;
    }
    return result;
  }();
  for (std::size_t index = 0; index < impl_->schedule_digest_windows.size(); ++index) {
    if (impl_->schedule_digest_windows[index] != window_id) continue;
    const auto existing = impl_->schedule_chunk_digests[index][chunk_index];
    if (existing == digest) return true;
    return false;
  }
  auto& staging = impl_->schedule_staging;
  if (!staging.active && impl_->schedule_complete.load(std::memory_order_acquire)) return false;
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
    if (window_id <= impl_->last_accepted_schedule_window_id
      || start_frame != impl_->accepted_schedule_through_frame.load(std::memory_order_acquire)) return false;
    staging.clear();
    staging.active = true;
    staging.revision = revision;
    staging.epoch = epoch;
    staging.window_id = window_id;
    staging.start_frame = start_frame;
    staging.end_frame = end_frame;
    staging.chunk_count = chunk_count;
  }
  if (!staging.active || staging.revision != revision || staging.epoch != epoch
    || staging.window_id != window_id || staging.start_frame != start_frame
    || staging.end_frame != end_frame || staging.chunk_count != chunk_count
  ) return false;
  if (staging.received_chunks[chunk_index]) {
    return staging.chunk_digests[chunk_index] == digest;
  }
  std::size_t offset = 56;
  std::uint64_t previous_frame = 0;
  std::uint64_t previous_sequence = 0;
  bool has_previous = false;
  for (std::uint32_t index = 0; index < instrument_count; ++index) {
    if (offset + 48 > payload.size()) return false;
    const auto* bytes = payload.data() + offset;
    const std::uint64_t frame = ReadLeU32(bytes + 28);
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
    if (event.instrument.epoch != epoch || !ValidNativeInstrumentEvent(event.instrument)
      || staging.record_count >= staging.events.size()) return false;
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
    if (source_start < start_frame || source_start >= end_frame || source_sequence == 0
      || source_stop <= source_start || source_stop > std::numeric_limits<std::int64_t>::max()
      || source_frames == 0 || source_offset > std::numeric_limits<std::uint64_t>::max() - source_frames
      || fade_in_start > fade_in_end || fade_out_start > fade_out_end
      || !std::isfinite(fade_in_curve) || fade_in_curve < -1.0F || fade_in_curve > 1.0F
      || !std::isfinite(fade_in_curve_position) || fade_in_curve_position < 0.0F || fade_in_curve_position > 1.0F
      || !std::isfinite(fade_out_curve) || fade_out_curve < -1.0F || fade_out_curve > 1.0F
      || !std::isfinite(fade_out_curve_position) || fade_out_curve_position < 0.0F || fade_out_curve_position > 1.0F
      || (has_previous_source && (source_start < previous_source_frame
        || (source_start == previous_source_frame && source_sequence <= previous_source_sequence)))) return false;
    const auto asset = impl_->assets.find(ReadLeU32(bytes + 20));
    if (asset == impl_->assets.end() || source_offset + source_frames > asset->second.frame_count
      || staging.record_count >= staging.events.size()) return false;
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
    previous_source_frame = source_start;
    previous_source_sequence = source_sequence;
    has_previous_source = true;
    offset += 112;
  }
  std::string previous_automation_instance;
  std::uint32_t previous_automation_parameter = 0;
  std::uint64_t previous_automation_start = 0;
  bool has_previous_automation = false;
  for (std::uint32_t index = 0; index < automation_count; ++index) {
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
  if (offset != payload.size()) return false;
  staging.received_chunks[chunk_index] = true;
  staging.chunk_digests[chunk_index] = digest;
  staging.ends_schedule = staging.ends_schedule || ends_schedule == 1;
  if (std::count(staging.received_chunks.begin(),
      staging.received_chunks.begin() + staging.chunk_count, true) != staging.chunk_count) {
    keep_staging = true;
    return true;
  }
  const std::uint32_t instrument_events = static_cast<std::uint32_t>(
    std::count_if(staging.events.begin(), staging.events.begin() + staging.record_count,
      [](const auto& event) { return event.kind == Impl::QueuedControlKind::kInstrument; })
  );
  const std::uint32_t source_events = static_cast<std::uint32_t>(staging.record_count) - instrument_events;
  if (!impl_->HasCapacity(Impl::QueuedControlKind::kInstrument, instrument_events)
    || !impl_->HasCapacity(Impl::QueuedControlKind::kSource, source_events)) {
    staging.clear();
    return false;
  }
  const auto rendered_epoch = impl_->schedule_progress_epoch.load(std::memory_order_acquire);
  const auto rendered_through_frame = rendered_epoch == epoch
    ? impl_->schedule_progress_rendered_frame.load(std::memory_order_acquire)
    : 0;
  for (std::size_t index = 0; index < staging.automation_state.group_count; ++index) {
    const auto& group = staging.automation_state.groups[index];
    auto* attachment = static_cast<NativeVstWorkerAttachment*>(group.attachment);
    if (attachment == nullptr || !attachment->PublishAutomation(
      epoch,
      rendered_through_frame,
      std::span<const NativeVstAutomationSegment>(group.segments.data(), group.count)
    )) {
      staging.clear();
      return false;
    }
  }
  for (std::size_t index = 0; index < staging.record_count; ++index) {
    if (!impl_->EnqueueControlEvent(staging.events[index])) {
      staging.clear();
      return false;
    }
  }
  impl_->published_schedule_window_id.store(window_id, std::memory_order_release);
  impl_->accepted_schedule_epoch.store(epoch, std::memory_order_release);
  impl_->accepted_schedule_through_frame.store(end_frame, std::memory_order_release);
  impl_->last_accepted_schedule_window_id = window_id;
  impl_->last_schedule_start_frame = start_frame;
  impl_->schedule_complete.store(staging.ends_schedule, std::memory_order_release);
  const auto cursor = impl_->schedule_digest_cursor++ % impl_->schedule_digest_windows.size();
  impl_->schedule_digest_windows[cursor] = window_id;
  impl_->schedule_chunk_digests[cursor] = staging.chunk_digests;
  staging.clear();
  keep_staging = true;
  return true;
}

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
  bool restart = false;
  bool faulted = false;
  for (auto& [instance_id, attachment] : impl_->native_vst_attachments) {
    static_cast<void>(instance_id);
    while (const auto diagnostic = attachment->worker.ReadDiagnostic()) {
      if (diagnostic->kind == daw::plugin_host::WorkerDiagnosticKind::kLatency) {
        if (diagnostic->value != attachment->metadata.declared_latency_frames) {
          attachment->metadata.declared_latency_frames = diagnostic->value;
          impl_->native_graph_revision_required = true;
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
        restart = true;
      } else if (diagnostic->kind == daw::plugin_host::WorkerDiagnosticKind::kFault) {
        faulted = true;
      }
    }
  }
  if ((faulted || impl_->native_graph_revision_required)
    && impl_->state.load(std::memory_order_acquire) == LifecycleState::kRunning) {
    Stop();
  }
  if (restart && impl_->state.load(std::memory_order_acquire) == LifecycleState::kRunning) {
    Stop();
    static_cast<void>(Start());
  }
}

bool AudioHost::InstallAsset(
  const std::uint32_t asset_id,
  const std::uint32_t frame_count,
  const std::uint32_t sample_rate_hz,
  const std::uint32_t channel_count,
  const std::uint64_t content_hash_prefix,
  const std::span<const float> samples
) {
  const daw_audio_core_handle active_core = impl_->active_core.load(std::memory_order_acquire);
  if (active_core == 0 || impl_->prepared_core != 0 || impl_->retired_core != 0
    || asset_id == 0 || frame_count == 0 || frame_count > kMaximumAssetFrames
    || sample_rate_hz == 0 || channel_count == 0 || channel_count > kMaximumAssetChannels
    || samples.size() != static_cast<std::size_t>(frame_count) * channel_count
    || impl_->assets.contains(asset_id) || impl_->assets.size() >= kMaximumInstalledAssets) return false;
  if (!std::all_of(samples.begin(), samples.end(), [](const float sample) { return std::isfinite(sample); })) return false;
  Impl::InstalledAsset asset{
    .samples = {samples.begin(), samples.end()},
    .frame_count = frame_count,
    .sample_rate_hz = sample_rate_hz,
    .channel_count = channel_count,
    .content_hash_prefix = content_hash_prefix,
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
    .revision = impl_->active_revision.load(std::memory_order_acquire),
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
  return true;
}

bool AudioHost::ReleaseAsset(const std::uint32_t asset_id) {
  const auto asset = impl_->assets.find(asset_id);
  if (asset == impl_->assets.end()) return true;
  const daw_audio_core_handle active_core = impl_->active_core.load(std::memory_order_acquire);
  if (active_core == 0 || impl_->prepared_core != 0 || impl_->retired_core != 0 || impl_->HasQueuedControl()) return false;
  if (daw_audio_core_release_asset(active_core, asset->second.handle) != DAW_AUDIO_CORE_OK) return false;
  impl_->assets.erase(asset);
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
    || active_core == 0 || impl_->prepared_core != 0 || frame < 0 || epoch == 0
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
  if (effective_transition == previous_transition) {
    return epoch == previous_epoch
      && impl_->transport_running.load(std::memory_order_acquire) == running
      && impl_->transport_frame.load(std::memory_order_acquire) == frame;
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

bool AudioHost::ConfigureRecording(const RecordingConfig& config) {
  if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kRunning
    || config.generation == 0 || config.session_id == 0
    || config.channel_count == 0 || config.channel_count > DAW_AUDIO_RECORDING_CAPTURE_MAX_CHANNELS
    || !std::isfinite(config.gain) || config.gain < 0.0F
    || (config.polarity != 1 && config.polarity != -1)
    || config.device_uid.empty()
    || config.punch_start_frame < 0
    || (config.punch_end_frame != -1 && config.punch_end_frame < config.punch_start_frame)
    || impl_->recording_capture.load(std::memory_order_acquire) != 0) return false;
  std::uint32_t input_bus_channels = 0;
  for (std::uint32_t channel = 0; channel < config.channel_count; ++channel) {
    if (config.input_channels[channel] >= 64) return false;
    input_bus_channels = std::max(input_bus_channels, config.input_channels[channel] + 1);
  }
  const daw_audio_recording_capture_config capture_config{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .generation = config.generation,
    .session_id = config.session_id,
    .channel_count = config.channel_count,
    .input_channels = {config.input_channels[0], config.input_channels[1]},
    .gain = config.gain,
    .polarity = config.polarity,
    .punch_start_frame = config.punch_start_frame,
    .punch_end_frame = config.punch_end_frame,
  };
  daw_audio_core_handle capture = 0;
  if (daw_audio_recording_capture_create(&capture_config, &capture) != DAW_AUDIO_CORE_OK) return false;
  if (!StartCoreAudioInputDevice(
    config.device_uid,
    impl_->config.sample_rate_hz,
    input_bus_channels,
    this,
    &impl_->recording_device_session)) {
    daw_audio_recording_capture_destroy(capture);
    return false;
  }
  impl_->recording_channel_count.store(config.channel_count, std::memory_order_release);
  impl_->recording_device_lost.store(false, std::memory_order_release);
  impl_->recording_monitor_read.store(0, std::memory_order_release);
  impl_->recording_monitor_write.store(0, std::memory_order_release);
  impl_->recording_monitoring.store(config.monitoring, std::memory_order_release);
  impl_->recording_command.store(Impl::RecordingCommand::kNone, std::memory_order_release);
  impl_->recording_stop_frame.store(-1, std::memory_order_release);
  impl_->recording_started.store(false, std::memory_order_release);
  impl_->recording_input_frame.store(impl_->transport_frame.load(std::memory_order_acquire), std::memory_order_release);
  impl_->recording_punch_start_frame.store(config.punch_start_frame, std::memory_order_release);
  impl_->recording_capture.store(capture, std::memory_order_release);
  impl_->NotifyRecordingStatus();
  return true;
}

bool AudioHost::StartRecording() {
  if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kRunning
    || impl_->recording_capture.load(std::memory_order_acquire) == 0
    || impl_->recording_started.load(std::memory_order_acquire)) return false;
  const std::int64_t start_frame = impl_->transport_frame.load(std::memory_order_acquire);
  impl_->recording_input_frame.store(start_frame, std::memory_order_release);
  impl_->recording_timeline_start_frame.store(
    std::max(start_frame, impl_->recording_punch_start_frame.load(std::memory_order_acquire)),
    std::memory_order_release);
  impl_->recording_started.store(true, std::memory_order_release);
  impl_->NotifyRecordingStatus();
  return true;
}

bool AudioHost::StopRecording(const std::optional<std::int64_t> stop_frame) {
  if (!impl_->recording_started.load(std::memory_order_acquire)
    || (stop_frame && *stop_frame < 0)) return false;
  impl_->recording_stop_frame.store(stop_frame.value_or(-1), std::memory_order_release);
  impl_->recording_command.store(Impl::RecordingCommand::kStop, std::memory_order_release);
  impl_->NotifyRecordingStatus();
  return true;
}

bool AudioHost::CancelRecording() {
  const daw_audio_core_handle capture = impl_->recording_capture.load(std::memory_order_acquire);
  if (capture == 0) return true;
  if (!impl_->recording_started.load(std::memory_order_acquire)) {
    if (daw_audio_recording_capture_cancel(capture) != DAW_AUDIO_CORE_OK) return false;
    impl_->NotifyRecordingStatus();
    return true;
  }
  impl_->recording_command.store(Impl::RecordingCommand::kCancel, std::memory_order_release);
  impl_->NotifyRecordingStatus();
  return true;
}

void AudioHost::NotifyRecordingDeviceLost() {
  impl_->recording_device_lost.store(true, std::memory_order_release);
  impl_->NotifyRecordingStatus();
}

void AudioHost::NotifyOutputDeviceLost() {
  if (impl_->state.load(std::memory_order_acquire) == LifecycleState::kRunning) {
    impl_->state.store(LifecycleState::kFaulted, std::memory_order_release);
  }
}

std::optional<RecordingMessage> AudioHost::WaitForRecordingMessage(
  const std::uint64_t last_status_revision,
  const std::atomic<bool>* running) {
  bool queued_block_ready = false;
  const daw_audio_core_handle current_capture = impl_->recording_capture.load(std::memory_order_acquire);
  if (current_capture != 0) {
    daw_audio_recording_capture_diagnostics current_diagnostics{};
    queued_block_ready = daw_audio_recording_capture_get_diagnostics(current_capture, &current_diagnostics)
      == DAW_AUDIO_CORE_OK && current_diagnostics.queued_blocks > 0;
  }
  const auto wait_until_changed = [&] {
    return impl_->recording_status_revision.load(std::memory_order_acquire) != last_status_revision
      || (running != nullptr && !running->load(std::memory_order_acquire));
  };
  if (!queued_block_ready) {
    std::unique_lock lock(impl_->recording_wait_mutex);
    impl_->recording_wait.wait(lock, wait_until_changed);
  }
  if (running != nullptr && !running->load(std::memory_order_acquire)) return std::nullopt;
  const bool device_lost = impl_->recording_device_lost.load(std::memory_order_acquire);
  if (device_lost && impl_->recording_device_session != nullptr) {
    StopCoreAudioDevice(impl_->recording_device_session);
    impl_->recording_device_session = nullptr;
    const daw_audio_core_handle failed_capture = impl_->recording_capture.load(std::memory_order_acquire);
    if (failed_capture != 0) static_cast<void>(daw_audio_recording_capture_cancel(failed_capture));
    impl_->recording_started.store(false, std::memory_order_release);
  }
  const daw_audio_core_handle capture = impl_->recording_capture.load(std::memory_order_acquire);
  if (capture == 0) return std::nullopt;
  RecordingMessage message{};
  daw_audio_recording_capture_block block{};
  const daw_audio_core_result dequeue = daw_audio_recording_capture_dequeue(capture, &block);
  if (dequeue == DAW_AUDIO_CORE_OK) {
    RecordingBlock output{
      .generation = block.generation,
      .session_id = block.session_id,
      .sequence = block.sequence,
      .frame_count = block.frame_count,
      .channel_count = block.channel_count,
      .rms = block.rms,
      .peak = block.peak,
      .samples = std::vector<float>(static_cast<std::size_t>(block.frame_count) * block.channel_count),
    };
    for (std::uint32_t channel = 0; channel < block.channel_count; ++channel) {
      std::memcpy(
        output.samples.data() + static_cast<std::size_t>(channel) * block.frame_count,
        block.planes[channel],
        block.frame_count * sizeof(float));
    }
    if (daw_audio_recording_capture_release_block(capture, block.block_id) != DAW_AUDIO_CORE_OK) return std::nullopt;
    message.block = std::move(output);
  } else if (dequeue != DAW_AUDIO_CORE_NO_DATA) {
    return std::nullopt;
  }
  daw_audio_recording_capture_diagnostics diagnostics{};
  if (daw_audio_recording_capture_get_diagnostics(capture, &diagnostics) != DAW_AUDIO_CORE_OK) return std::nullopt;
  message.status = {
    .generation = diagnostics.generation,
    .session_id = diagnostics.session_id,
    .timeline_frame = impl_->recording_timeline_start_frame.load(std::memory_order_acquire),
    .captured_frames = diagnostics.captured_frames,
    .dropped_frames = diagnostics.dropped_frames,
    .dropped_blocks = diagnostics.dropped_blocks,
    .available_blocks = diagnostics.available_blocks,
    .queued_blocks = diagnostics.queued_blocks,
    .rms = diagnostics.rms,
    .peak = diagnostics.peak,
    .fatal = diagnostics.fatal != 0 || device_lost,
    .active = diagnostics.active != 0,
    .configured = true,
  };
  if (!message.status.active && message.status.queued_blocks == 0) {
    if (impl_->recording_device_session != nullptr) {
      StopCoreAudioDevice(impl_->recording_device_session);
      impl_->recording_device_session = nullptr;
    }
    const daw_audio_core_handle completed = impl_->recording_capture.exchange(0, std::memory_order_acq_rel);
    if (completed != 0) daw_audio_recording_capture_destroy(completed);
    impl_->recording_channel_count.store(0, std::memory_order_release);
    impl_->recording_monitoring.store(false, std::memory_order_release);
    impl_->recording_device_lost.store(false, std::memory_order_release);
  }
  return message;
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
  if (node_id == 0) {
    impl_->spectrum_enabled.store(false, std::memory_order_release);
    impl_->spectrum_selected_index.store(0, std::memory_order_release);
    impl_->spectrum_observer.Clear();
    impl_->spectrum_has_previous = false;
    impl_->spectrum_history_count = 0;
    return true;
  }
  std::uint32_t index = 0;
  for (; index < impl_->spectrum_node_count; ++index) {
    if (impl_->spectrum_node_ids[index] == node_id) break;
  }
  if (index >= impl_->spectrum_node_count) return false;
  impl_->spectrum_observer.Clear();
  impl_->spectrum_has_previous = false;
  impl_->spectrum_history_count = 0;
  impl_->spectrum_selected_index.store(index, std::memory_order_release);
  impl_->spectrum_enabled.store(true, std::memory_order_release);
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
  const auto instrument_write = impl_->instrument_queue.write.load(std::memory_order_acquire);
  const auto instrument_read = impl_->instrument_queue.read.load(std::memory_order_acquire);
  const auto source_write = impl_->source_queue.write.load(std::memory_order_acquire);
  const auto source_read = impl_->source_queue.read.load(std::memory_order_acquire);
  std::uint32_t automation_credits = 0;
  for (const auto& [instance_id, attachment] : impl_->native_vst_attachments) {
    static_cast<void>(instance_id);
    const auto used = attachment->automation_segment_count.load(std::memory_order_acquire);
    automation_credits += static_cast<std::uint32_t>(
      attachment->automation_segments[0].size() - std::min<std::uint32_t>(
        used,
        static_cast<std::uint32_t>(attachment->automation_segments[0].size())
      )
    );
  }
  return ScheduleProgress{
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
  if (impl_->graph_prepared || !ValidNativeVstAttachment(normalized)
    || impl_->native_vst_attachments.contains(normalized.instance_id)
    || impl_->native_vst_attachments.size() >= kMaximumNativeVstAttachments) return false;
  auto worker_attachment = std::make_unique<NativeVstWorkerAttachment>();
  worker_attachment->metadata = normalized;
  worker_attachment->notification_sink = &impl_->worker_notifications;
  worker_attachment->offline_failure = &impl_->offline_failure;
  impl_->native_vst_attachments.emplace(normalized.instance_id, std::move(worker_attachment));
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
  if (impl_->graph_prepared) return false;
  return impl_->native_vst_attachments.erase(std::string(instance_id)) == 1;
}

bool AudioHost::Start() {
  if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kConfigured || impl_->config.device_uid.empty()
    || !impl_->graph_prepared || !impl_->transport_prepared) return false;
  if (!impl_->StartNativeVstWorkers(daw::plugin_host::WorkerProcessSetup::Mode::kRealtime)) return false;
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
  return true;
}

bool AudioHost::StartOffline() {
  if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kConfigured
    || !impl_->graph_prepared || !impl_->transport_prepared) return false;
  if (!impl_->StartNativeVstWorkers(daw::plugin_host::WorkerProcessSetup::Mode::kOffline)) return false;
  impl_->state.store(LifecycleState::kRunning, std::memory_order_release);
  return true;
}

bool AudioHost::StartDiagnosticMode() {
  if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kConfigured) return false;
  if (!impl_->StartNativeVstWorkers(daw::plugin_host::WorkerProcessSetup::Mode::kRealtime)) return false;
  impl_->state.store(LifecycleState::kRunning, std::memory_order_release);
  return true;
}

void AudioHost::Stop() {
  const LifecycleState state = impl_->state.load(std::memory_order_acquire);
  if (state != LifecycleState::kRunning && state != LifecycleState::kFaulted) {
    impl_->ClearScheduledLanes();
    return;
  }
  if (impl_->device_session != nullptr) {
    StopCoreAudioDevice(impl_->device_session);
    impl_->device_session = nullptr;
  }
  if (impl_->recording_device_session != nullptr) {
    StopCoreAudioDevice(impl_->recording_device_session);
    impl_->recording_device_session = nullptr;
  }
  const daw_audio_core_handle capture = impl_->recording_capture.exchange(0, std::memory_order_acq_rel);
  if (capture != 0) {
    static_cast<void>(daw_audio_recording_capture_cancel(capture));
    daw_audio_recording_capture_destroy(capture);
    impl_->recording_started.store(false, std::memory_order_release);
    impl_->recording_channel_count.store(0, std::memory_order_release);
    impl_->recording_monitoring.store(false, std::memory_order_release);
    impl_->recording_command.store(Impl::RecordingCommand::kNone, std::memory_order_release);
    impl_->recording_device_lost.store(false, std::memory_order_release);
  }
  impl_->StopNativeVstWorkers();
  impl_->ClearScheduledLanes();
  impl_->state.store(LifecycleState::kConfigured, std::memory_order_release);
  impl_->publish_requested_revision.store(0, std::memory_order_release);
  impl_->publish_wait.notify_all();
}

void AudioHost::Teardown() {
  Stop();
  const daw_audio_core_handle active_core = impl_->active_core.exchange(0, std::memory_order_acq_rel);
  if (active_core == 0 && impl_->prepared_core == 0 && impl_->retired_core == 0) return;
  if (active_core != 0) daw_audio_core_destroy(active_core);
  if (impl_->prepared_core != 0 && !impl_->prepared_core_is_same_core) daw_audio_core_destroy(impl_->prepared_core);
  if (impl_->retired_core != 0) daw_audio_core_destroy(impl_->retired_core);
  impl_->prepared_core = 0;
  impl_->retired_core = 0;
  impl_->assets.clear();
  impl_->prepared_asset_handles.clear();
  impl_->native_vst_attachments.clear();
  impl_->active_revision.store(0, std::memory_order_release);
  impl_->prepared_revision.store(0, std::memory_order_release);
  impl_->retired_revision.store(0, std::memory_order_release);
  impl_->transport_epoch.store(0, std::memory_order_release);
  impl_->transport_frame.store(0, std::memory_order_release);
  impl_->transport_running.store(false, std::memory_order_release);
  impl_->accepted_schedule_epoch.store(0, std::memory_order_release);
  impl_->accepted_schedule_through_frame.store(0, std::memory_order_release);
  impl_->published_schedule_window_id.store(0, std::memory_order_release);
  impl_->schedule_complete.store(false, std::memory_order_release);
  impl_->last_accepted_schedule_window_id = 0;
  impl_->last_accepted_schedule_epoch = 0;
  impl_->last_schedule_start_frame = 0;
  impl_->schedule_digest_windows = {};
  impl_->schedule_chunk_digests = {};
  impl_->schedule_digest_cursor = 0;
  impl_->schedule_staging.clear();
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
    || impl_->prepared_core != 0 || impl_->retired_core != 0
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
  const std::uint64_t processor_patch = impl_->processor_patch_requested.exchange(0, std::memory_order_acq_rel);
  if (processor_patch != 0) {
    const daw_audio_core_handle core = impl_->active_core.load(std::memory_order_acquire);
    const auto result = core == 0
      ? DAW_AUDIO_CORE_INVALID_HANDLE
      : daw_audio_core_apply_staged_processor_state_patch(core);
    impl_->processor_patch_result.store(result, std::memory_order_release);
    impl_->processor_patch_acknowledged.store(processor_patch, std::memory_order_release);
    impl_->SignalRealtimeBridge(Impl::kRealtimeProcessorPatchAcknowledged);
  }
  if (impl_->worker_notifications.mute_requested.load(std::memory_order_acquire)) {
    for (std::uint32_t channel = 0; channel < impl_->config.channel_count; ++channel) {
      std::fill_n(output[channel], frame_count, 0.0F);
    }
    impl_->callbacks.fetch_add(1, std::memory_order_relaxed);
    return true;
  }
  const float* const* inputs = input.data();
  float* const* outputs = output.data();
  std::uint32_t offset = 0;
  while (offset < frame_count) {
    const std::uint64_t processor_patch = impl_->processor_patch_requested.exchange(0, std::memory_order_acq_rel);
    if (processor_patch != 0) {
      const daw_audio_core_handle core = impl_->active_core.load(std::memory_order_acquire);
      const auto result = core == 0
        ? DAW_AUDIO_CORE_INVALID_HANDLE
        : daw_audio_core_apply_staged_processor_state_patch(core);
      impl_->processor_patch_result.store(result, std::memory_order_release);
      impl_->processor_patch_acknowledged.store(processor_patch, std::memory_order_release);
      impl_->SignalRealtimeBridge(Impl::kRealtimeProcessorPatchAcknowledged);
    }
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
          if (impl_->accepted_schedule_epoch.load(std::memory_order_acquire) != command.epoch) {
            impl_->published_schedule_window_id.store(0, std::memory_order_release);
            impl_->accepted_schedule_through_frame.store(command.frame, std::memory_order_release);
            impl_->schedule_complete.store(false, std::memory_order_release);
            impl_->accepted_schedule_epoch.store(command.epoch, std::memory_order_release);
          }
          impl_->applied_transport_epoch.store(command.epoch, std::memory_order_release);
          impl_->applied_transport_frame.store(command.frame, std::memory_order_release);
          impl_->applied_transport_running.store(command.running, std::memory_order_release);
          impl_->applied_transport_transition_id.store(command.transition_id, std::memory_order_release);
        }
        ++read;
      }
      impl_->transport_queue.read.store(read, std::memory_order_release);
    }
    const std::uint32_t requested_revision = impl_->publish_requested_revision.exchange(0, std::memory_order_acq_rel);
    if (requested_revision != 0
      && impl_->prepared_core != 0
      && impl_->prepared_revision.load(std::memory_order_acquire) == requested_revision) {
      if (impl_->prepared_core_is_same_core) {
        const auto result = daw_audio_core_publish(
          impl_->active_core.load(std::memory_order_acquire), requested_revision);
        if (result == DAW_AUDIO_CORE_OK) {
          impl_->active_revision.store(requested_revision, std::memory_order_release);
          impl_->prepared_core = 0;
          impl_->prepared_core_is_same_core = false;
          impl_->prepared_revision.store(0, std::memory_order_release);
          impl_->last_graph_revision.store(requested_revision, std::memory_order_release);
          impl_->publish_acknowledged_revision.store(requested_revision, std::memory_order_release);
          impl_->SignalRealtimeBridge(Impl::kRealtimePublishAcknowledged);
        }
      } else {
        if (daw_audio_core_publish(impl_->prepared_core, requested_revision) != DAW_AUDIO_CORE_OK) {
          impl_->publish_acknowledged_revision.store(requested_revision, std::memory_order_release);
          impl_->SignalRealtimeBridge(Impl::kRealtimePublishAcknowledged);
          continue;
        }
        const daw_audio_core_handle previous_core = impl_->active_core.exchange(impl_->prepared_core, std::memory_order_acq_rel);
        const std::uint32_t previous_revision = impl_->active_revision.exchange(requested_revision, std::memory_order_acq_rel);
        impl_->prepared_core = 0;
        impl_->prepared_core_is_same_core = false;
        impl_->prepared_revision.store(0, std::memory_order_release);
        impl_->retired_core = previous_core;
        impl_->retired_revision.store(previous_revision, std::memory_order_release);
        impl_->retired_after_epoch.store(
          impl_->completed_render_epoch.load(std::memory_order_acquire),
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
    const std::uint32_t frames = frame_count - offset > maximum_frames
      ? maximum_frames
      : frame_count - offset;
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
    std::uint32_t processor_event_count = 0;
    std::uint64_t processor_sequence_applied = 0;
    std::uint32_t instrument_event_count = 0;
    const auto block_start_frame = impl_->applied_transport_frame.load(std::memory_order_acquire);
    const auto block_end_frame = block_start_frame + static_cast<std::int64_t>(frames);
    const auto applied_epoch = impl_->applied_transport_epoch.load(std::memory_order_acquire);
    const auto published_window = impl_->published_schedule_window_id.load(std::memory_order_acquire);
    const auto drain_processor_lane = [&]<std::size_t Capacity>(Impl::ControlLane<Capacity>& lane) {
      std::uint32_t read = lane.read.load(std::memory_order_relaxed);
      const std::uint32_t write = lane.write.load(std::memory_order_acquire);
      while (read != write) {
        const auto& event = lane.events[read % Capacity];
        if (event.processor_revision != 0
          && (event.processor_revision != impl_->active_revision.load(std::memory_order_acquire)
            || event.processor_epoch != applied_epoch)) {
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
    const auto drain_instrument_lane = [&]<std::size_t Capacity>(Impl::ControlLane<Capacity>& lane) {
      std::uint32_t read = lane.read.load(std::memory_order_relaxed);
      const std::uint32_t write = lane.write.load(std::memory_order_acquire);
      while (read != write) {
        const auto& event = lane.events[read % Capacity];
        if (event.instrument.epoch != applied_epoch) {
          ++read;
          continue;
        }
        if (event.scheduled && !impl_->applied_transport_running.load(std::memory_order_acquire)) break;
        if (event.scheduled && event.window_id > published_window) break;
        const auto event_frame = event.scheduled ? event.absolute_frame
          : static_cast<std::uint64_t>(event.instrument.frame_offset);
        if (event_frame >= static_cast<std::uint64_t>(block_end_frame)) break;
        if (instrument_event_count >= instrument_events.size()) return false;
        if (event.scheduled && event_frame < static_cast<std::uint64_t>(block_start_frame)) {
          ++read;
          continue;
        }
        instrument_events[instrument_event_count] = event.instrument;
        instrument_events[instrument_event_count].frame_offset = event_frame <= static_cast<std::uint64_t>(block_start_frame)
          ? 0
          : static_cast<std::uint32_t>(event_frame - static_cast<std::uint64_t>(block_start_frame));
        ++instrument_event_count;
        ++read;
      }
      lane.read.store(read, std::memory_order_release);
      return true;
    };
    const auto drain_source_lane = [&]<std::size_t Capacity>(Impl::ControlLane<Capacity>& lane) {
      std::uint32_t read = lane.read.load(std::memory_order_relaxed);
      const std::uint32_t write = lane.write.load(std::memory_order_acquire);
      while (read != write) {
        const auto& event = lane.events[read % Capacity];
        if (event.scheduled && !impl_->applied_transport_running.load(std::memory_order_acquire)) break;
        if (event.scheduled && event.source.epoch != applied_epoch) {
          ++read;
          continue;
        }
        if (event.scheduled && event.window_id > published_window) break;
        if (daw_audio_core_schedule_sample_source(active_core, &event.source) != DAW_AUDIO_CORE_OK) return false;
        ++read;
      }
      lane.read.store(read, std::memory_order_release);
      return true;
    };
    if (!drain_instrument_lane(impl_->urgent_queue)
      || !drain_instrument_lane(impl_->instrument_queue)
      || !drain_processor_lane(impl_->processor_queue)
      || !drain_source_lane(impl_->source_queue)) {
      const auto reason = instrument_event_count >= instrument_events.size()
        ? RejectedBlockReason::kInstrumentEventCapacity
        : processor_event_count >= processor_events.size()
          ? RejectedBlockReason::kProcessorEventCapacity
          : RejectedBlockReason::kSourceSchedule;
      impl_->RejectBlock(reason, callback_attempt);
      return false;
    }
    std::sort(processor_events.begin(), processor_events.begin() + processor_event_count,
      [](const auto& left, const auto& right) {
        return left.processor_instance_id < right.processor_instance_id
          || (left.processor_instance_id == right.processor_instance_id && (
            left.frame_offset < right.frame_offset
            || (left.frame_offset == right.frame_offset && left.parameter_target < right.parameter_target)));
      });
    std::sort(instrument_events.begin(), instrument_events.begin() + instrument_event_count,
      [](const auto& left, const auto& right) {
        return left.frame_offset < right.frame_offset
          || (left.frame_offset == right.frame_offset && left.sequence < right.sequence);
      });
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
      .instrument_events = instrument_event_count == 0 ? nullptr : instrument_events.data(),
    };
    const auto result = daw_audio_core_process(active_core, &block);
    if (result != DAW_AUDIO_CORE_OK) {
      impl_->RejectBlock(
        RejectedBlockReason::kCoreProcess,
        callback_attempt,
        result,
        frames,
        impl_->config.channel_count,
        processor_event_count,
        instrument_event_count,
        block.graph_revision
      );
      return false;
    }
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
    auto applied_processor_sequence = impl_->applied_processor_sequence.load(std::memory_order_relaxed);
    while (processor_sequence_applied > applied_processor_sequence
      && !impl_->applied_processor_sequence.compare_exchange_weak(
        applied_processor_sequence, processor_sequence_applied, std::memory_order_release, std::memory_order_relaxed)) {}
    for (std::uint32_t index = 0; index < instrument_event_count; ++index) {
      const auto type = instrument_events[index].type;
      if (type >= static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOn)
        && type <= static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kAllSoundOff)) {
        auto applied = impl_->applied_urgent_sequence.load(std::memory_order_relaxed);
        while (instrument_events[index].sequence > applied
          && !impl_->applied_urgent_sequence.compare_exchange_weak(
            applied, instrument_events[index].sequence, std::memory_order_release, std::memory_order_relaxed)) {}
      }
    }
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
      impl_->accepted_schedule_through_frame.load(std::memory_order_acquire),
      std::memory_order_release
    );
    impl_->schedule_progress_window_id.store(
      impl_->published_schedule_window_id.load(std::memory_order_acquire),
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
      impl_->schedule_complete.load(std::memory_order_acquire),
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
      impl_->SignalRealtimeBridge(Impl::kRealtimeScheduleProgress);
    }
    impl_->completed_render_epoch.fetch_add(1, std::memory_order_release);
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

Diagnostics AudioHost::diagnostics() const {
  return {
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
