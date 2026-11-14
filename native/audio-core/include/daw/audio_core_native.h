#pragma once

#if !defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
#error "audio_core_native.h is unavailable in portable and Wasm builds."
#endif

#include "daw/audio_core.h"

#include <array>
#include <cstdint>
#include <span>

namespace daw::audio_core {

// Callback seam only. Admission is read-only; apply follows successful graph
// publication with the same frozen bank. False leaves all source state intact.
// Spanning declarations preserve the accepted wire start/offset origin; frame
// is the publication time, not necessarily the declaration's start time.
[[nodiscard]] bool ReconcileSampleSources(daw_audio_core_handle core,
  std::span<const daw_audio_sample_source_event> sources, std::int64_t frame,
  bool apply) noexcept;

// Host closes queue/configuration admission before requesting reclamation.
// The callback acknowledges only after its last source/voice/page reader ends.
// Ready slots remain closed until the control thread frees or cancels them.
void RequestAssetRetirement(daw_audio_core_handle core, daw_audio_asset_handle asset) noexcept;
void CancelAssetRetirement(daw_audio_core_handle core, daw_audio_asset_handle asset) noexcept;
[[nodiscard]] bool CompleteAssetReaders(daw_audio_core_handle core, std::uint64_t completing_epoch) noexcept;
[[nodiscard]] bool ReclaimAsset(daw_audio_core_handle core, daw_audio_asset_handle asset,
  bool device_stopped, std::uint64_t completed_epoch) noexcept;

struct NativeLatencyTransition {
  std::uint32_t budget = 0;
  std::uint32_t revision = 0;
  std::uint32_t completed_revision = 0;
  std::uint64_t completed_frame = 0;
};

// Atomic observation only. Completion is published after the last fade sample
// and the reader epoch; the host forwards that event through its RT bridge.
[[nodiscard]] NativeLatencyTransition InspectLatencyTransition(daw_audio_core_handle core) noexcept;
// The published graph's own latency, not the pinned budget a lower leaves in place. The graph pointer is
// swapped by publication, so call it only on the thread that publishes, right after the publish returns.
[[nodiscard]] std::uint32_t PublishedGraphLatency(daw_audio_core_handle core) noexcept;
// Device-stop boundary only, after the last callback has returned.
void StopLatencyTransition(daw_audio_core_handle core) noexcept;

// Publication boundary only, before the previous bank can be prepared again.
// Compare live identities, not fading ghosts. No allocation or runtime mutation.
[[nodiscard]] bool RetainsScheduledTarget(daw_audio_core_handle core,
  std::uint32_t previous_revision, const daw_audio_sample_source_event& event) noexcept;
[[nodiscard]] bool RetainsScheduledTarget(daw_audio_core_handle core,
  std::uint32_t previous_revision, const daw_audio_processor_event& event) noexcept;

// Control-thread, allocation-free admission against the selected prepared or
// published graph and its asset table. Reuses the configure-state validators
// without mutating configuration, runtime slots, voices, or asset ownership.
[[nodiscard]] bool ValidateInstrumentState(
  daw_audio_core_handle core, std::uint64_t node_id,
  const daw_audio_synth_state& state) noexcept;
[[nodiscard]] bool ValidateInstrumentState(
  daw_audio_core_handle core, std::uint64_t node_id, std::uint32_t kind,
  const daw_audio_sampler_state& state, std::span<const daw_audio_sample_zone> zones) noexcept;
[[nodiscard]] bool ValidateInstrumentState(
  daw_audio_core_handle core, std::uint64_t node_id,
  const daw_audio_granular_state& state) noexcept;

constexpr std::uint32_t kNativeGraphStageAppend = 0xffff'ffffU;

/* Native-only event meanings. They are intentionally outside the portable
 * event enum so Wasm and browser callers cannot accidentally depend on host
 * voice ownership semantics. */
enum class NativeInstrumentEventType : std::uint32_t {
  kLiveNoteOn = 101,
  kLiveNoteOff = 102,
  kTransportRelease = 103,
  kAllSoundOff = 104,
};

enum class NativeGraphStageRole : std::uint8_t {
  kEffect = 1,
  kInstrument = 2,
};

/* This is a native host extension, deliberately separate from the portable C
 * ABI and graph envelope. The callback runs synchronously on the audio thread:
 * it must not allocate, lock, perform IPC, or invoke a plug-in SDK. */
struct NativeGraphNodeRender {
  std::uint32_t graph_revision = 0;
  std::uint32_t node_index = 0;
  std::uint64_t node_id = 0;
  std::uint32_t frame_count = 0;
  std::uint32_t channel_count = 0;
  std::uint32_t sample_rate_hz = 0;
  std::uint32_t transport_epoch = 0;
  bool transport_running = false;
  std::int64_t transport_frame = 0;
  std::int64_t project_time_samples = 0;
  double tempo_bpm = 0.0;
  double project_time_music = 0.0;
  std::uint32_t time_signature_numerator = 0;
  std::uint32_t time_signature_denominator = 0;
  bool cycle_active = false;
  double cycle_start_music = 0.0;
  double cycle_end_music = 0.0;
  std::uint32_t stage_index = 0;
  NativeGraphStageRole stage_role = NativeGraphStageRole::kEffect;
  std::array<float*, 2> planes{};
  std::span<const daw_audio_instrument_event> instrument_events{};
  void* attachment = nullptr;
};

using NativeGraphNodeHook = void (*)(const NativeGraphNodeRender&) noexcept;

struct NativeGraphHookBinding {
  std::uint64_t node_id = 0;
  std::uint32_t stage_index = kNativeGraphStageAppend;
  std::uint32_t output_layout = 0;
  std::uint32_t pdc_latency_frames = 0;
  std::uint32_t external_latency_frames = 0;
  NativeGraphStageRole stage_role = NativeGraphStageRole::kEffect;
  void* attachment = nullptr;
};

struct NativeGraphHookRegistration {
  std::uint32_t graph_revision = 0;
  NativeGraphNodeHook hook = nullptr;
  std::span<const NativeGraphHookBinding> bindings{};
  NativeGraphNodeHook observer = nullptr;
  void* observer_attachment = nullptr;
};

[[nodiscard]] daw_audio_core_result RegisterNativeGraphHook(
  daw_audio_core_handle core,
  const NativeGraphHookRegistration& registration) noexcept;

}  // namespace daw::audio_core
