#include "audio_core_internal.h"

namespace daw::audio_core_internal {

BiquadCoefficients rbj_coefficients(uint32_t type, float frequency_hz, float q, float gain_db, uint32_t sample_rate_hz) {
  const float frequency = std::fmin(frequency_hz, static_cast<float>(sample_rate_hz) * 0.49F);
  const float omega = 6.2831853071795864769F * frequency / static_cast<float>(sample_rate_hz);
  const float cosine = std::cos(omega);
  const float sine = std::sin(omega);
  const float alpha = sine / (2.0F * q);
  const float amplitude = std::pow(10.0F, gain_db / 40.0F);
  const float root_amplitude = std::sqrt(amplitude);
  float b0 = 1.0F;
  float b1 = 0.0F;
  float b2 = 0.0F;
  float a0 = 1.0F;
  float a1 = 0.0F;
  float a2 = 0.0F;
  if (type == DAW_AUDIO_EQ_BAND_LOWPASS) {
    b0 = (1.0F - cosine) * 0.5F; b1 = 1.0F - cosine; b2 = b0; a0 = 1.0F + alpha; a1 = -2.0F * cosine; a2 = 1.0F - alpha;
  } else if (type == DAW_AUDIO_EQ_BAND_HIGHPASS) {
    b0 = (1.0F + cosine) * 0.5F; b1 = -(1.0F + cosine); b2 = b0; a0 = 1.0F + alpha; a1 = -2.0F * cosine; a2 = 1.0F - alpha;
  } else if (type == DAW_AUDIO_EQ_BAND_BANDPASS) {
    b0 = alpha; b2 = -alpha; a0 = 1.0F + alpha; a1 = -2.0F * cosine; a2 = 1.0F - alpha;
  } else if (type == DAW_AUDIO_EQ_BAND_NOTCH) {
    b0 = 1.0F; b1 = -2.0F * cosine; b2 = 1.0F; a0 = 1.0F + alpha; a1 = b1; a2 = 1.0F - alpha;
  } else if (type == DAW_AUDIO_EQ_BAND_ALLPASS) {
    b0 = 1.0F - alpha; b1 = -2.0F * cosine; b2 = 1.0F + alpha; a0 = b2; a1 = b1; a2 = b0;
  } else if (type == DAW_AUDIO_EQ_BAND_LOWSHELF || type == DAW_AUDIO_EQ_BAND_HIGHSHELF) {
    const float beta = 2.0F * root_amplitude * alpha;
    if (type == DAW_AUDIO_EQ_BAND_LOWSHELF) {
      b0 = amplitude * ((amplitude + 1.0F) - (amplitude - 1.0F) * cosine + beta);
      b1 = 2.0F * amplitude * ((amplitude - 1.0F) - (amplitude + 1.0F) * cosine);
      b2 = amplitude * ((amplitude + 1.0F) - (amplitude - 1.0F) * cosine - beta);
      a0 = (amplitude + 1.0F) + (amplitude - 1.0F) * cosine + beta;
      a1 = -2.0F * ((amplitude - 1.0F) + (amplitude + 1.0F) * cosine);
      a2 = (amplitude + 1.0F) + (amplitude - 1.0F) * cosine - beta;
    } else {
      b0 = amplitude * ((amplitude + 1.0F) + (amplitude - 1.0F) * cosine + beta);
      b1 = -2.0F * amplitude * ((amplitude - 1.0F) + (amplitude + 1.0F) * cosine);
      b2 = amplitude * ((amplitude + 1.0F) + (amplitude - 1.0F) * cosine - beta);
      a0 = (amplitude + 1.0F) - (amplitude - 1.0F) * cosine + beta;
      a1 = 2.0F * ((amplitude - 1.0F) - (amplitude + 1.0F) * cosine);
      a2 = (amplitude + 1.0F) - (amplitude - 1.0F) * cosine - beta;
    }
  } else {
    b0 = 1.0F + alpha * amplitude; b1 = -2.0F * cosine; b2 = 1.0F - alpha * amplitude;
    a0 = 1.0F + alpha / amplitude; a1 = b1; a2 = 1.0F - alpha / amplitude;
  }
  return {.b0 = b0 / a0, .b1 = b1 / a0, .b2 = b2 / a0, .a1 = a1 / a0, .a2 = a2 / a0};
}

void render_eq_processor(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float, float, float *output_left, float *output_right) {
  EqHistory &history = core.eq_histories[processor.history_slot];
  float left = std::isfinite(input_left) ? input_left : 0.0F;
  float right = std::isfinite(input_right) ? input_right : 0.0F;
  const float dry_left = left;
  const float dry_right = right;
  if (processor.eq.mono != 0) left = right = 0.5F * (left + right);
  for (uint32_t index = 0; index < 8; ++index) {
    const daw_audio_eq_band_state &band = processor.eq.bands[index];
    if (band.enabled == 0) continue;
    const float frequency = processor_parameter_value(
      core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_FREQUENCY_HZ(index), frame, band.frequency_hz);
    const float gain_db = processor_parameter_value(
      core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_GAIN_DB(index), frame, band.gain_db);
    const float q = processor_parameter_value(
      core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_Q(index), frame, band.q);
    const BiquadCoefficients coefficients = rbj_coefficients(
      band.type, frequency, q, gain_db, core.config.sample_rate_hz);
    left = process_biquad(left, coefficients, history.bands[index][0]);
    right = process_biquad(right, coefficients, history.bands[index][1]);
  }
  advance_bypass(core, history.bypass, processor.bypassed != 0 || processor.eq.enabled == 0);
  *output_left = bypass_mix(std::isfinite(left) ? left : 0.0F, dry_left, history.bypass);
  *output_right = bypass_mix(std::isfinite(right) ? right : 0.0F, dry_right, history.bypass);
}
}  // namespace daw::audio_core_internal
