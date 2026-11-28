#include "audio_core_internal.h"

namespace {

struct TimeEffectBiquadCoefficients {
  float b0 = 0.0F;
  float b1 = 0.0F;
  float b2 = 0.0F;
  float a1 = 0.0F;
  float a2 = 0.0F;
};

TimeEffectBiquadCoefficients time_effect_biquad_coefficients(
  bool highpass,
  float frequency_hz,
  uint32_t sample_rate_hz) {
  const float rate = static_cast<float>(sample_rate_hz);
  const float frequency = std::fmax(0.0F, std::fmin(frequency_hz, rate * 0.5F));
  const float omega = 6.2831853071795864769F * frequency / rate;
  const float cosine = std::cos(omega);
  const float alpha = std::sin(omega) / (2.0F * 0.707F);
  const float a0 = 1.0F + alpha;
  return {
    (highpass ? (1.0F + cosine) * 0.5F : (1.0F - cosine) * 0.5F) / a0,
    (highpass ? -(1.0F + cosine) : 1.0F - cosine) / a0,
    (highpass ? (1.0F + cosine) * 0.5F : (1.0F - cosine) * 0.5F) / a0,
    -2.0F * cosine / a0,
    (1.0F - alpha) / a0,
  };
}

float process_time_effect_biquad(
  float input,
  const TimeEffectBiquadCoefficients &coefficients,
  BiquadHistory &history) {
  const float output = coefficients.b0 * input
    + coefficients.b1 * history.x1
    + coefficients.b2 * history.x2
    - coefficients.a1 * history.y1
    - coefficients.a2 * history.y2;
  history.x2 = history.x1;
  history.x1 = input;
  history.y2 = history.y1;
  history.y1 = output;
  return output;
}

void render_time_effect_processor_impl(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  DelayHistory &history, float input_left, float input_right, float, float,
  float *output_left, float *output_right) {
  const float dry_left = std::isfinite(input_left) ? input_left : 0.0F;
  const float dry_right = std::isfinite(input_right) ? input_right : 0.0F;
  const float rate = static_cast<float>(core.config.sample_rate_hz);
  daw_audio_delay_state delay_state = processor.delay;
  const float delay_parameter_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_TIME_MS, frame, delay_state.delay_ms);
  const float delay_feedback = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_FEEDBACK, frame, delay_state.feedback);
  const float delay_dry_wet = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_DRY_WET, frame, delay_state.dry_wet);
  const float delay_low_cut = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_LOW_CUT_HZ, frame, delay_state.low_cut_hz);
  const float delay_high_cut = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_HIGH_CUT_HZ, frame, delay_state.high_cut_hz);
  const float bounded_delay_ms = std::fmax(1.0F, std::fmin(delay_parameter_ms, 3000.0F));
  const float bounded_feedback = std::fmax(0.0F, std::fmin(delay_feedback, 0.95F));
  const float bounded_dry_wet = std::fmax(0.0F, std::fmin(delay_dry_wet, 1.0F));
  const float delay_frames = std::fmax(1.0F, bounded_delay_ms * rate / 1000.0F);
  const float raw_left = read_time_effect_delay(history.left, history.write, delay_frames);
  const float raw_right = read_time_effect_delay(history.right, history.write, delay_frames);
  const float low_cut = delay_state.filter_enabled != 0
    ? std::fmax(20.0F, std::fmin(delay_low_cut, 2000.0F)) : 20.0F;
  const float high_cut = delay_state.filter_enabled != 0
    ? std::fmax(1000.0F, std::fmin(delay_high_cut, 20000.0F)) : 20000.0F;
  const TimeEffectBiquadCoefficients highpass = time_effect_biquad_coefficients(
    true, low_cut, core.config.sample_rate_hz);
  const TimeEffectBiquadCoefficients lowpass = time_effect_biquad_coefficients(
    false, high_cut, core.config.sample_rate_hz);
  const float wet_left = process_time_effect_biquad(
    process_time_effect_biquad(raw_left, highpass, history.highpass_left),
    lowpass, history.lowpass_left);
  const float wet_right = process_time_effect_biquad(
    process_time_effect_biquad(raw_right, highpass, history.highpass_right),
    lowpass, history.lowpass_right);
  const float feedback_left = delay_state.ping_pong != 0 ? wet_right : wet_left;
  const float feedback_right = delay_state.ping_pong != 0 ? wet_left : wet_right;
  history.left[history.write] = dry_left + feedback_left * bounded_feedback;
  history.right[history.write] = dry_right + feedback_right * bounded_feedback;
  history.write = (history.write + 1) % static_cast<uint32_t>(history.left.size());
  float left = dry_left * (1.0F - bounded_dry_wet) + wet_left * bounded_dry_wet;
  float right = dry_right * (1.0F - bounded_dry_wet) + wet_right * bounded_dry_wet;
  if (!std::isfinite(left) || !std::isfinite(right)) {
    left = right = 0.0F;
    history = DelayHistory{};
  }
  advance_bypass(core, history.bypass, delay_state.enabled == 0 || processor.bypassed != 0);
  *output_left = left + (dry_left - left) * history.bypass;
  *output_right = right + (dry_right - right) * history.bypass;
}
}  // namespace

namespace daw::audio_core_internal {

void render_time_effect_processor(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float sidechain_left, float sidechain_right,
  float *output_left, float *output_right) {
  render_time_effect_processor_impl(
    core, processor, frame, core.delay_histories[processor.delay_slot],
    input_left, input_right, sidechain_left, sidechain_right, output_left, output_right);
}
}  // namespace daw::audio_core_internal
