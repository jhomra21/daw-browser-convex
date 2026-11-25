#include "audio_core_internal.h"

namespace daw::audio_core_internal {

void render_gate_processor(
  Core &core,
  GraphRevision::Processor &processor,
  uint32_t frame,
  float input_left,
  float input_right,
  float sidechain_left,
  float sidechain_right,
  float *output_left,
  float *output_right) {
  GateHistory &history = core.gate_histories[processor.gate_slot];
  if (history.prepared_rate_hz != core.config.sample_rate_hz) {
    history.kernel.prepare(static_cast<double>(core.config.sample_rate_hz));
    history.prepared_rate_hz = core.config.sample_rate_hz;
    history.filter_frequency_hz = 0.0F;
  }
  const daw_audio_gate_state &state = processor.gate;
  const auto value = [&](uint32_t target, float fallback) {
    return processor_parameter_value(core, processor, target, frame, fallback);
  };
  const daw::audio_core::GateValues values{
    .threshold_db = value(DAW_AUDIO_PROCESSOR_PARAMETER_GATE_THRESHOLD_DB, state.threshold_db),
    .ratio = value(DAW_AUDIO_PROCESSOR_PARAMETER_GATE_RATIO, state.ratio),
    .attack_ms = value(DAW_AUDIO_PROCESSOR_PARAMETER_GATE_ATTACK_MS, state.attack_ms),
    .hold_ms = value(DAW_AUDIO_PROCESSOR_PARAMETER_GATE_HOLD_MS, state.hold_ms),
    .release_ms = value(DAW_AUDIO_PROCESSOR_PARAMETER_GATE_RELEASE_MS, state.release_ms),
    .hysteresis_db = value(DAW_AUDIO_PROCESSOR_PARAMETER_GATE_HYSTERESIS_DB, state.hysteresis_db),
    .range_db = value(DAW_AUDIO_PROCESSOR_PARAMETER_GATE_RANGE_DB, state.range_db),
    .link = value(DAW_AUDIO_PROCESSOR_PARAMETER_GATE_LINK, state.link),
    .sidechain_gain_db = value(DAW_AUDIO_PROCESSOR_PARAMETER_GATE_SIDECHAIN_GAIN_DB, state.sidechain_gain_db),
    .sidechain_mix = value(DAW_AUDIO_PROCESSOR_PARAMETER_GATE_SIDECHAIN_MIX, state.sidechain_mix),
  };
  if (state.sidechain_enabled != 0) {
    const float frequency_hz = value(DAW_AUDIO_PROCESSOR_PARAMETER_GATE_SIDECHAIN_FREQUENCY_HZ, state.sidechain_frequency_hz);
    const float q = value(DAW_AUDIO_PROCESSOR_PARAMETER_GATE_SIDECHAIN_Q, state.sidechain_q);
    if (frequency_hz != history.filter_frequency_hz || q != history.filter_q || state.sidechain_filter_type != history.filter_type) {
      history.filter_frequency_hz = frequency_hz;
      history.filter_q = q;
      history.filter_type = state.sidechain_filter_type;
      const BiquadCoefficients filter = rbj_coefficients(sidechain_band_type(state.sidechain_filter_type), frequency_hz, q, 0.0F, core.config.sample_rate_hz);
      history.kernel.set_sidechain(true, {.b0 = filter.b0, .b1 = filter.b1, .b2 = filter.b2, .a1 = filter.a1, .a2 = filter.a2});
    }
  } else {
    history.kernel.set_sidechain(false, {});
    history.filter_frequency_hz = 0.0F;
  }
  const daw::audio_core::GateConfig config{
    .lookahead_ms = state.lookahead_ms,
    .expander = state.mode != 0,
    .rms = state.detector != 0,
    .flip = state.flip != 0,
    .external_key = history.external_key,
  };
  advance_bypass(core, history.bypass, processor.bypassed != 0 || state.enabled == 0);
  history.kernel.process(values, config, history.bypass, input_left, input_right, sidechain_left, sidechain_right, *output_left, *output_right);
}
}  // namespace daw::audio_core_internal
