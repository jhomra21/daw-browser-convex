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

namespace {

constexpr float kSmoothingMs = 10.0F;
constexpr uint32_t kBandsPerCurve = DAW_AUDIO_CORE_EQ_BANDS_PER_CURVE;

bool band_active(const daw_audio_eq_state &eq, uint32_t band) {
  return eq.bands[band].enabled != 0 && (band < kBandsPerCurve || eq.mode == DAW_AUDIO_EQ_MODE_LEFT_RIGHT
    || eq.mode == DAW_AUDIO_EQ_MODE_MID_SIDE);
}

// Points every smoother at this frame's parameter values. The first call snaps them instead of gliding from zero.
void aim_eq_smoothers(Core &core, GraphRevision::Processor &processor, EqHistory &history, uint32_t frame) {
  const daw_audio_eq_state &eq = processor.eq;
  const bool first = !history.initialized;
  const auto aim = [first](auto &smoother, float value) { first ? smoother.reset(value) : smoother.setTarget(value); };
  for (uint32_t index = 0; index < DAW_AUDIO_CORE_EQ_BAND_COUNT; ++index) {
    if (!band_active(eq, index)) continue;
    const daw_audio_eq_band_state &band = eq.bands[index];
    aim(history.frequency[index], processor_parameter_value(
      core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_FREQUENCY_HZ(index), frame, band.frequency_hz));
    aim(history.q[index], processor_parameter_value(
      core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_Q(index), frame, band.q));
    if (dsp::eqBandHasGain(static_cast<dsp::EqBandType>(band.type))) {
      aim(history.gain_db[index], processor_parameter_value(
        core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_GAIN_DB(index), frame, band.gain_db));
    }
  }
  aim(history.scale, processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_EQ_SCALE, frame, eq.scale));
  aim(history.output_db, processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_EQ_OUTPUT_DB, frame, eq.output_db));
  if (first) {
    const double rate = static_cast<double>(core.config.sample_rate_hz);
    for (uint32_t index = 0; index < DAW_AUDIO_CORE_EQ_BAND_COUNT; ++index) {
      history.frequency[index].prepare(rate, kSmoothingMs);
      history.gain_db[index].prepare(rate, kSmoothingMs);
      history.q[index].prepare(rate, kSmoothingMs);
    }
    history.scale.prepare(rate, kSmoothingMs);
    history.output_db.prepare(rate, kSmoothingMs);
    history.initialized = true;
  }
}

// Advances the smoothers one sample and redesigns the sections of every band whose effective values moved. Adaptive Q
// is this device's own law (Live's manual only says Q grows with the amount of boost or cut): Q * (1 + |gain| / 24).
void advance_eq_bands(EqHistory &history, const daw_audio_eq_state &eq, double design_rate, double project_rate) {
  const float scale = history.scale.next();
  for (uint32_t index = 0; index < DAW_AUDIO_CORE_EQ_BAND_COUNT; ++index) {
    if (!band_active(eq, index)) continue;
    const dsp::EqBandType type = static_cast<dsp::EqBandType>(eq.bands[index].type);
    const bool has_gain = dsp::eqBandHasGain(type);
    const float frequency = history.frequency[index].next();
    const float gain = has_gain ? history.gain_db[index].next() * scale : 0.0F;
    const float q = history.q[index].next() * (eq.adaptive_q != 0 && has_gain ? 1.0F + std::fabs(gain) / 24.0F : 1.0F);
    std::array<float, 3> &designed = history.designed[index];
    if (history.sections[index].count != 0 && designed[0] == frequency && designed[1] == gain && designed[2] == q) continue;
    designed = {frequency, gain, q};
    history.sections[index] = dsp::designEqBand(type, frequency, design_rate, q, gain, project_rate);
  }
}

double run_eq_curve(EqHistory &history, const daw_audio_eq_state &eq, uint32_t curve, uint32_t channel, double sample) {
  for (uint32_t band = 0; band < kBandsPerCurve; ++band) {
    const uint32_t index = curve * kBandsPerCurve + band;
    if (!band_active(eq, index)) continue;
    const dsp::EqBandSections &sections = history.sections[index];
    for (uint32_t section = 0; section < sections.count; ++section) {
      sample = history.filters[channel][band][section].process(sample, sections.sections[section]);
    }
  }
  return sample;
}

}  // namespace

void render_eq_processor(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float, float, float *output_left, float *output_right) {
  EqHistory &history = core.eq_histories[processor.history_slot];
  const daw_audio_eq_state &eq = processor.eq;
  const bool high_quality = eq.high_quality != 0;
  const bool two_curves = eq.mode == DAW_AUDIO_EQ_MODE_LEFT_RIGHT || eq.mode == DAW_AUDIO_EQ_MODE_MID_SIDE;
  aim_eq_smoothers(core, processor, history, frame);
  advance_eq_bands(history, eq, static_cast<double>(core.config.sample_rate_hz) * (high_quality ? 2.0 : 1.0), static_cast<double>(core.config.sample_rate_hz));
  const float output_db = history.output_db.next();
  if (output_db != history.output_gain_db) {
    history.output_gain_db = output_db;
    history.output_gain = std::pow(10.0F, output_db / 20.0F);
  }

  const float left = std::isfinite(input_left) ? input_left : 0.0F;
  const float right = std::isfinite(input_right) ? input_right : 0.0F;
  double channels[2] = {left, right};
  if (eq.mode == DAW_AUDIO_EQ_MODE_MONO) channels[0] = channels[1] = 0.5 * (static_cast<double>(left) + right);
  if (eq.mode == DAW_AUDIO_EQ_MODE_MID_SIDE) {
    channels[0] = 0.5 * (static_cast<double>(left) + right);
    channels[1] = 0.5 * (static_cast<double>(left) - right);
  }
  for (uint32_t channel = 0; channel < 2; ++channel) {
    const uint32_t curve = two_curves ? channel : 0;
    if (!high_quality) {
      channels[channel] = run_eq_curve(history, eq, curve, channel, channels[channel]);
      continue;
    }
    const dsp::PolyphaseIirHalfBand2x::Pair up = history.oversamplers[channel].up(channels[channel]);
    const double first = run_eq_curve(history, eq, curve, channel, up.first);
    channels[channel] = history.oversamplers[channel].down(first, run_eq_curve(history, eq, curve, channel, up.second));
  }
  if (eq.mode == DAW_AUDIO_EQ_MODE_MID_SIDE) {
    const double mid = channels[0];
    channels[0] = mid + channels[1];
    channels[1] = mid - channels[1];
  }

  float dry[2] = {left, right};
  if (high_quality) {
    for (uint32_t channel = 0; channel < 2; ++channel) {
      float &slot = history.dry[channel][history.dry_index];
      std::swap(slot, dry[channel]);
    }
    history.dry_index = (history.dry_index + 1) % EqHistory::kDryDelay;
  }
  advance_bypass(core, history.bypass, processor.bypassed != 0 || eq.enabled == 0);
  const auto finish = [&](double processed, float aligned_dry) {
    const float wet = dsp::flushDenormal(static_cast<float>(processed * history.output_gain));
    return bypass_mix(std::isfinite(wet) ? wet : 0.0F, aligned_dry, history.bypass);
  };
  *output_left = finish(channels[0], dry[0]);
  *output_right = finish(channels[1], dry[1]);
}
}  // namespace daw::audio_core_internal
