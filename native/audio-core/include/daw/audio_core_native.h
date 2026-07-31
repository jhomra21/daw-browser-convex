#pragma once

#if !defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
#error "audio_core_native.h is unavailable in portable and Wasm builds."
#endif

#include "daw/audio_core.h"

#include <array>
#include <cstdint>
#include <span>

namespace daw::audio_core {

/* Native-only event meanings. They are intentionally outside the portable
 * event enum so Wasm and browser callers cannot accidentally depend on host
 * voice ownership semantics. */
enum class NativeInstrumentEventType : std::uint32_t {
  kLiveNoteOn = 101,
  kLiveNoteOff = 102,
  kTransportRelease = 103,
  kAllSoundOff = 104,
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
  std::array<float*, 2> planes{};
  std::span<const daw_audio_instrument_event> instrument_events{};
  void* attachment = nullptr;
};

using NativeGraphNodeHook = void (*)(const NativeGraphNodeRender&) noexcept;

struct NativeGraphHookBinding {
  std::uint64_t node_id = 0;
  std::uint32_t chain_index = 0;
  std::uint32_t output_layout = 0;
  std::uint32_t pdc_latency_frames = 0;
  std::uint32_t external_latency_frames = 0;
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
