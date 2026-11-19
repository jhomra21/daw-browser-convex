#include <cstddef>

#include "daw/audio_core.h"
#include "utility_fixture.h"

extern "C" uint32_t daw_audio_core_wasm_harness_abi_version(void) {
  return daw_audio_core_get_abi_version();
}

extern "C" uint32_t daw_audio_core_wasm_fixture_protocol_version(void) {
  return DAW_AUDIO_UTILITY_FIXTURE_VERSION;
}

// The wasm32 layout of the configuration structs the browser host writes at literal byte offsets.
extern "C" uint32_t daw_audio_core_wasm_harness_struct_layout(uint32_t index) {
  static constexpr uint32_t layout[] = {
    sizeof(daw_audio_synth_state), offsetof(daw_audio_synth_state, oscillators), sizeof(daw_audio_synth_oscillator_state),
    offsetof(daw_audio_synth_state, noise_enabled), offsetof(daw_audio_synth_state, filter_enabled),
    offsetof(daw_audio_synth_state, amp_attack_ms), offsetof(daw_audio_synth_state, lfo_enabled),
    offsetof(daw_audio_synth_state, output_gain), offsetof(daw_audio_synth_state, output_pan),
    sizeof(daw_audio_sampler_state), offsetof(daw_audio_sampler_state, zone_count),
    offsetof(daw_audio_sampler_state, filter_enabled), offsetof(daw_audio_sampler_state, filter_cutoff_hz),
    offsetof(daw_audio_sampler_state, lfo_rate_hz), offsetof(daw_audio_sampler_state, retrigger),
    sizeof(daw_audio_sample_zone), offsetof(daw_audio_sample_zone, key_low), offsetof(daw_audio_sample_zone, tune_cents),
    offsetof(daw_audio_sample_zone, round_robin_group), offsetof(daw_audio_sample_zone, choke_group),
    sizeof(daw_audio_granular_state), offsetof(daw_audio_granular_state, asset), offsetof(daw_audio_granular_state, seed),
    offsetof(daw_audio_granular_state, max_grains), offsetof(daw_audio_granular_state, window_shape),
    offsetof(daw_audio_granular_state, freeze), offsetof(daw_audio_granular_state, grain_size_ms),
    offsetof(daw_audio_granular_state, stereo_spread),
  };
  return index < sizeof(layout) / sizeof(layout[0]) ? layout[index] : UINT32_MAX;
}
