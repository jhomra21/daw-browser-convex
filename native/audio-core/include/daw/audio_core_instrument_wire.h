#ifndef DAW_AUDIO_CORE_INSTRUMENT_WIRE_H
#define DAW_AUDIO_CORE_INSTRUMENT_WIRE_H

#include "daw/audio_core.h"

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <span>

namespace daw::audio_core_wire {

inline constexpr std::size_t kSynthStateBytes = 156;
inline constexpr std::size_t kSamplerStateBytes = 88;
inline constexpr std::size_t kSampleZoneBytes = 80;

inline std::uint32_t ReadU32(const std::uint8_t* bytes) {
  return static_cast<std::uint32_t>(bytes[0])
    | (static_cast<std::uint32_t>(bytes[1]) << 8U)
    | (static_cast<std::uint32_t>(bytes[2]) << 16U)
    | (static_cast<std::uint32_t>(bytes[3]) << 24U);
}

inline std::uint64_t ReadU64(const std::uint8_t* bytes) {
  std::uint64_t value = 0;
  for (std::size_t index = 0; index < 8; ++index) {
    value |= static_cast<std::uint64_t>(bytes[index]) << (index * 8U);
  }
  return value;
}

inline std::int32_t ReadI32(const std::uint8_t* bytes) {
  const std::uint32_t encoded = ReadU32(bytes);
  std::int32_t value = 0;
  std::memcpy(&value, &encoded, sizeof(value));
  return value;
}

inline float ReadFloat(const std::uint8_t* bytes) {
  const std::uint32_t encoded = ReadU32(bytes);
  float value = 0.0F;
  std::memcpy(&value, &encoded, sizeof(value));
  return value;
}

inline bool DecodeSynthState(
  const std::span<const std::uint8_t> bytes,
  daw_audio_synth_state* const output
) {
  if (output == nullptr || bytes.size() != kSynthStateBytes) return false;
  daw_audio_synth_state state{};
  state.version = ReadU32(bytes.data());
  state.seed = ReadU32(bytes.data() + 4);
  for (std::size_t index = 0; index < 2; ++index) {
    const std::size_t offset = 8 + index * 24;
    state.oscillators[index] = {
      .enabled = ReadU32(bytes.data() + offset),
      .waveform = ReadU32(bytes.data() + offset + 4),
      .level = ReadFloat(bytes.data() + offset + 8),
      .octave = ReadI32(bytes.data() + offset + 12),
      .semitone = ReadI32(bytes.data() + offset + 16),
      .detune_cents = ReadFloat(bytes.data() + offset + 20),
    };
  }
  state.noise_enabled = ReadU32(bytes.data() + 56);
  state.noise_level = ReadFloat(bytes.data() + 60);
  state.filter_enabled = ReadU32(bytes.data() + 64);
  state.filter_mode = ReadU32(bytes.data() + 68);
  state.filter_cutoff_hz = ReadFloat(bytes.data() + 72);
  state.filter_resonance = ReadFloat(bytes.data() + 76);
  state.filter_key_tracking = ReadFloat(bytes.data() + 80);
  state.filter_envelope_amount_octaves = ReadFloat(bytes.data() + 84);
  state.filter_attack_ms = ReadFloat(bytes.data() + 88);
  state.filter_decay_ms = ReadFloat(bytes.data() + 92);
  state.filter_sustain = ReadFloat(bytes.data() + 96);
  state.filter_release_ms = ReadFloat(bytes.data() + 100);
  state.amp_attack_ms = ReadFloat(bytes.data() + 104);
  state.amp_decay_ms = ReadFloat(bytes.data() + 108);
  state.amp_sustain = ReadFloat(bytes.data() + 112);
  state.amp_release_ms = ReadFloat(bytes.data() + 116);
  state.lfo_enabled = ReadU32(bytes.data() + 120);
  state.lfo_waveform = ReadU32(bytes.data() + 124);
  state.lfo_rate_hz = ReadFloat(bytes.data() + 128);
  state.lfo_pitch_cents = ReadFloat(bytes.data() + 132);
  state.lfo_filter_octaves = ReadFloat(bytes.data() + 136);
  state.lfo_amplitude = ReadFloat(bytes.data() + 140);
  state.lfo_pan = ReadFloat(bytes.data() + 144);
  state.output_gain = ReadFloat(bytes.data() + 148);
  state.output_pan = ReadFloat(bytes.data() + 152);
  *output = state;
  return true;
}

inline bool DecodeSamplerState(
  const std::span<const std::uint8_t> bytes,
  daw_audio_sampler_state* const output
) {
  if (output == nullptr || bytes.size() != kSamplerStateBytes) return false;
  daw_audio_sampler_state state{
    .version = ReadU32(bytes.data()),
    .zone_count = ReadU32(bytes.data() + 4),
    .amp_attack_ms = ReadFloat(bytes.data() + 8),
    .amp_decay_ms = ReadFloat(bytes.data() + 12),
    .amp_sustain = ReadFloat(bytes.data() + 16),
    .amp_release_ms = ReadFloat(bytes.data() + 20),
    .filter_enabled = ReadU32(bytes.data() + 24),
    .filter_mode = ReadU32(bytes.data() + 28),
    .filter_cutoff_hz = ReadFloat(bytes.data() + 32),
    .filter_resonance = ReadFloat(bytes.data() + 36),
    .filter_envelope_amount = ReadFloat(bytes.data() + 40),
    .filter_attack_ms = ReadFloat(bytes.data() + 44),
    .filter_decay_ms = ReadFloat(bytes.data() + 48),
    .filter_sustain = ReadFloat(bytes.data() + 52),
    .filter_release_ms = ReadFloat(bytes.data() + 56),
    .lfo_enabled = ReadU32(bytes.data() + 60),
    .lfo_rate_hz = ReadFloat(bytes.data() + 64),
    .lfo_pitch_cents = ReadFloat(bytes.data() + 68),
    .lfo_filter_hz = ReadFloat(bytes.data() + 72),
    .lfo_amplitude = ReadFloat(bytes.data() + 76),
    .lfo_pan = ReadFloat(bytes.data() + 80),
    .retrigger = ReadU32(bytes.data() + 84),
  };
  *output = state;
  return true;
}

inline bool DecodeSampleZone(
  const std::span<const std::uint8_t> bytes,
  daw_audio_sample_zone* const output
) {
  if (output == nullptr || bytes.size() != kSampleZoneBytes) return false;
  *output = {
    .asset = ReadU64(bytes.data()),
    .key_low = ReadU32(bytes.data() + 8),
    .key_high = ReadU32(bytes.data() + 12),
    .velocity_low = ReadU32(bytes.data() + 16),
    .velocity_high = ReadU32(bytes.data() + 20),
    .root_note = ReadU32(bytes.data() + 24),
    .tune_cents = ReadFloat(bytes.data() + 28),
    .gain = ReadFloat(bytes.data() + 32),
    .pan = ReadFloat(bytes.data() + 36),
    .round_robin_group = ReadU32(bytes.data() + 40),
    .round_robin_index = ReadU32(bytes.data() + 44),
    .playback_mode = ReadU32(bytes.data() + 48),
    .start_frame = ReadU32(bytes.data() + 52),
    .end_frame = ReadU32(bytes.data() + 56),
    .loop_start_frame = ReadU32(bytes.data() + 60),
    .loop_end_frame = ReadU32(bytes.data() + 64),
    .crossfade_frame_count = ReadU32(bytes.data() + 68),
    .choke_group = ReadU32(bytes.data() + 72),
  };
  return true;
}

}  // namespace daw::audio_core_wire

#endif
