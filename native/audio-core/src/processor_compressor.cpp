#include "audio_core_internal.h"

namespace daw::audio_core_internal {

void render_compressor_processor(
  Core &core,
  GraphRevision::Processor &processor,
  uint32_t frame,
  float input_left,
  float input_right,
  float sidechain_left,
  float sidechain_right,
  float *output_left,
  float *output_right) {
  CompressorHistory &history = core.compressor_histories[processor.compressor_slot];
  if (history.prepared_rate_hz != core.config.sample_rate_hz) {
    history.kernel.prepare(static_cast<double>(core.config.sample_rate_hz));
    history.prepared_rate_hz = core.config.sample_rate_hz;
    history.filter_frequency_hz = 0.0F;
  }
  const daw_audio_compressor_state &state = processor.compressor;
  const auto value = [&](uint32_t target, float fallback) {
    return processor_parameter_value(core, processor, target, frame, fallback);
  };
  const daw::audio_core::CompressorValues values{
    .threshold_db = value(DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_THRESHOLD_DB, state.threshold_db),
    .ratio = value(DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_RATIO, state.ratio),
    .attack_ms = value(DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_ATTACK_MS, state.attack_ms),
    .release_ms = value(DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_RELEASE_MS, state.release_ms),
    .makeup_db = value(DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_MAKEUP_DB, state.makeup_db),
    .output_db = value(DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_OUTPUT_DB, state.output_db),
    .dry_wet = value(DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_DRY_WET, state.dry_wet),
    .knee_db = value(DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_KNEE_DB, state.knee_db),
  };
  if (state.sidechain_enabled != 0) {
    const float frequency_hz = value(DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_SIDECHAIN_FREQUENCY_HZ, state.sidechain_frequency_hz);
    const float q = value(DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_SIDECHAIN_Q, state.sidechain_q);
    if (frequency_hz != history.filter_frequency_hz || q != history.filter_q) {
      history.filter_frequency_hz = frequency_hz;
      history.filter_q = q;
      const BiquadCoefficients filter = rbj_coefficients(sidechain_band_type(state.sidechain_filter_type), frequency_hz, q, 0.0F, core.config.sample_rate_hz);
      history.kernel.set_sidechain(true, {.b0 = filter.b0, .b1 = filter.b1, .b2 = filter.b2, .a1 = filter.a1, .a2 = filter.a2});
    }
  } else {
    history.kernel.set_sidechain(false, {});
    history.filter_frequency_hz = 0.0F;
  }
  const daw::audio_core::CompressorConfig config{
    .lookahead_ms = state.lookahead_ms,
    .auto_release = state.auto_release != 0,
    .auto_makeup = state.auto_makeup != 0 && !history.external_key,
    .rms = state.detector_mode != 0,
    .expand = state.dynamics_mode != 0,
    .linear = state.envelope_curve != 0,
  };
  advance_bypass(core, history.bypass, processor.bypassed != 0 || state.enabled == 0);
  history.kernel.process(values, config, history.bypass, input_left, input_right, sidechain_left, sidechain_right, *output_left, *output_right);
}
}  // namespace daw::audio_core_internal
