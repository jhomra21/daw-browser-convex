#pragma once

#include "daw/audio_host_macos.h"
#include "daw/audio_host_automation_override.h"
#include "daw/native-schedule-state.h"
#include "daw/audio_host_event_scheduler.h"
#include "daw/audio_core_native.h"
#include "daw/audio_core_instrument_wire.h"
#include "worker-control-service.h"
#include "acceptance-observer.h"
#include "audio-host-limits.h"
#include "audio-host-bytes.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <optional>
#include <span>

namespace daw::audio_host_macos {

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

}  // namespace daw::audio_host_macos
