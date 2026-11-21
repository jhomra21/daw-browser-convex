#include "audio_core_internal.h"

namespace {

float saturator_curve(uint32_t curve, float input) {
  if (curve == DAW_AUDIO_SATURATOR_CURVE_SOFT) return std::tanh(1.8F * input);
  if (curve == DAW_AUDIO_SATURATOR_CURVE_MEDIUM) return input < -0.666F ? -1.0F : input > 0.666F ? 1.0F : 1.5F * input - 0.5F * input * input * input;
  if (curve == DAW_AUDIO_SATURATOR_CURVE_HARD) return std::atan(4.0F * input) / std::atan(4.0F);
  return std::fmax(-0.82F, std::fmin(0.82F, input)) / 0.82F;
}

float render_saturator_channel(
  Core &core, GraphRevision::Processor &processor, uint32_t frame, float input, float *previous,
  BiquadHistory &color_history) {
  daw_audio_saturator_state state = processor.saturator;
  state.drive_db = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_DRIVE_DB, frame, state.drive_db);
  state.color_frequency_hz = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_COLOR_FREQUENCY_HZ, frame, state.color_frequency_hz);
  state.color_amount = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_COLOR_AMOUNT, frame, state.color_amount);
  state.output_db = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_OUTPUT_DB, frame, state.output_db);
  state.dry_wet = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_DRY_WET, frame, state.dry_wet);
  const float dry = std::isfinite(input) ? input : 0.0F;
  const float drive = std::pow(10.0F, state.drive_db / 20.0F);
  const BiquadCoefficients color = rbj_coefficients(DAW_AUDIO_EQ_BAND_PEAKING, state.color_frequency_hz, 0.8F,
    state.color != 0 ? state.color_amount * 12.0F : 0.0F, core.config.sample_rate_hz);
  float wet = 0.0F;
  for (uint32_t phase = 1; phase <= 4; ++phase) {
    const float interpolated = *previous + (dry - *previous) * static_cast<float>(phase) * 0.25F;
    wet += saturator_curve(state.curve, process_biquad(interpolated * drive, color, color_history));
  }
  *previous = dry;
  wet = wet * 0.25F * std::pow(10.0F, state.output_db / 20.0F);
  return dry + (wet - dry) * state.dry_wet;
}
}  // namespace

namespace daw::audio_core_internal {

void render_saturator_processor(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float, float, float *output_left, float *output_right) {
  SaturatorHistory &history = core.saturator_histories[processor.history_slot];
  const float wet_left = render_saturator_channel(core, processor, frame, input_left, &history.previous_left, history.color_left);
  const float wet_right = render_saturator_channel(core, processor, frame, input_right, &history.previous_right, history.color_right);
  advance_bypass(core, history.bypass, processor.bypassed != 0 || processor.saturator.enabled == 0);
  *output_left = bypass_mix(wet_left, std::isfinite(input_left) ? input_left : 0.0F, history.bypass);
  *output_right = bypass_mix(wet_right, std::isfinite(input_right) ? input_right : 0.0F, history.bypass);
}
}  // namespace daw::audio_core_internal
