#include "audio_core_internal.h"

namespace {

float dynamics_db_to_gain(float db) {
  return std::pow(10.0F, db / 20.0F);
}

float dynamics_gain_to_db(float gain) {
  return gain > 0.0F ? 20.0F * std::log10(gain) : -120.0F;
}

uint32_t dynamics_delay_frames(float milliseconds, uint32_t sample_rate) {
  return std::min(kMaximumDynamicsDelayFrames - 1, static_cast<uint32_t>(std::ceil(milliseconds * static_cast<float>(sample_rate) / 1000.0F)));
}

double limiter_true_peak(const std::array<double, 12> &history, uint32_t history_write) {
  double peak = 0.0;
  for (uint32_t phase = 0; phase < 4; ++phase) {
    double value = 0.0;
    for (uint32_t tap = 0; tap < 12; ++tap) {
      const uint32_t history_index = (history_write + 11 - tap) % 12;
      value += history[history_index] * kLimiterTruePeakFir[tap * 4 + phase];
    }
    peak = std::max(peak, std::abs(value));
  }
  // Tap t reads the frame t + 1 behind history_write, so the centre taps interpolate between the frames 6 and 7
  // behind it, and no phase lands on an input frame. Include those raw frames: a sample on the grid is never read low.
  for (const uint32_t frames_behind : {6u, 7u}) peak = std::max(peak, std::abs(history[(history_write + 12 - frames_behind) % 12]));
  return peak;
}

// Minimum of the targets pushed over the last `window` + 1 frames; window < kMaximumDynamicsDelayFrames
// keeps the deque within capacity.
float limiter_window_minimum(LimiterTargetWindow &targets, float target, uint32_t window) {
  const auto slot = [&targets](uint32_t offset) { return (targets.head + offset) % kMaximumDynamicsDelayFrames; };
  while (targets.count > 0 && targets.value[slot(targets.count - 1)] >= target) --targets.count;
  while (targets.count > 0 && targets.now - targets.frame[slot(0)] > window) {
    targets.head = slot(1);
    --targets.count;
  }
  const uint32_t tail = slot(targets.count);
  targets.value[tail] = target;
  targets.frame[tail] = targets.now++;
  ++targets.count;
  return targets.value[slot(0)];
}

float compressor_curve_db(float input_db, const daw_audio_compressor_state &state) {
  if (state.dynamics_mode != 0) {
    if (input_db >= state.threshold_db) return input_db;
    const float expanded = state.threshold_db + (input_db - state.threshold_db) * state.ratio;
    if (state.knee_db <= 0.0F || input_db <= state.threshold_db - state.knee_db * 0.5F) return expanded;
    const float distance = state.threshold_db - input_db;
    return input_db - (2.0F * (state.ratio - 1.0F) * distance * distance) / state.knee_db;
  }
  const float compressed = state.threshold_db + (input_db - state.threshold_db) / state.ratio;
  if (state.knee_db <= 0.0F) return input_db <= state.threshold_db ? input_db : compressed;
  const float lower = state.threshold_db - state.knee_db * 0.5F;
  const float upper = state.threshold_db + state.knee_db * 0.5F;
  if (input_db <= lower) return input_db;
  if (input_db >= upper) return compressed;
  const float x = input_db - lower;
  return input_db + ((1.0F / state.ratio - 1.0F) * x * x) / (2.0F * state.knee_db);
}
}  // namespace

namespace daw::audio_core_internal {

void render_dynamics_processor(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float sidechain_left, float sidechain_right, float *output_left, float *output_right) {
  DynamicsHistory &history = core.dynamics_histories[processor.history_slot];
  const float dry_left = std::isfinite(input_left) ? input_left : 0.0F;
  const float dry_right = std::isfinite(input_right) ? input_right : 0.0F;
  const bool gate = processor.kind == DAW_AUDIO_PROCESSOR_KIND_GATE;
  const bool compressor = processor.kind == DAW_AUDIO_PROCESSOR_KIND_COMPRESSOR;
  const uint32_t fixed_delay = dynamics_delay_frames(
    gate ? 2.0F : compressor ? 10.0F : 5.0F, core.config.sample_rate_hz);
  const uint32_t write = history.write;
  const uint32_t read = (write + kMaximumDynamicsDelayFrames - fixed_delay) % kMaximumDynamicsDelayFrames;
  history.delay_left[write] = dry_left;
  history.delay_right[write] = dry_right;
  history.detector_left[write] = dry_left;
  history.detector_right[write] = dry_right;
  float left = history.delay_left[read];
  float right = history.delay_right[read];
  // Bypass crossfades to the input as delayed by the processor's fixed latency, so
  // it never shifts the signal in time.
  const float delayed_left = left;
  const float delayed_right = right;
  if (gate) {
    daw_audio_gate_state state = processor.gate;
    state.threshold_db = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_GATE_THRESHOLD_DB, frame, state.threshold_db);
    state.ratio = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_GATE_RATIO, frame, state.ratio);
    state.attack_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_GATE_ATTACK_MS, frame, state.attack_ms);
    state.hold_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_GATE_HOLD_MS, frame, state.hold_ms);
    state.release_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_GATE_RELEASE_MS, frame, state.release_ms);
    state.hysteresis_db = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_GATE_HYSTERESIS_DB, frame, state.hysteresis_db);
    state.range_db = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_GATE_RANGE_DB, frame, state.range_db);
    state.lookahead_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_GATE_LOOKAHEAD_MS, frame, state.lookahead_ms);
    state.link = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_GATE_LINK, frame, state.link);
    state.sidechain_frequency_hz = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_GATE_SIDECHAIN_FREQUENCY_HZ, frame, state.sidechain_frequency_hz);
    state.sidechain_q = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_GATE_SIDECHAIN_Q, frame, state.sidechain_q);
    float detector_left = sidechain_left;
    float detector_right = sidechain_right;
    if (state.sidechain_enabled != 0) {
      const BiquadCoefficients filter = rbj_coefficients(DAW_AUDIO_EQ_BAND_HIGHPASS, state.sidechain_frequency_hz, state.sidechain_q, 0.0F, core.config.sample_rate_hz);
      detector_left = process_biquad(detector_left, filter, history.sidechain[0]);
      detector_right = process_biquad(detector_right, filter, history.sidechain[1]);
    }
    history.detector_left[write] = detector_left;
    history.detector_right[write] = detector_right;
    const uint32_t detector_delay = fixed_delay - std::min(fixed_delay, dynamics_delay_frames(state.lookahead_ms, core.config.sample_rate_hz));
    const uint32_t detector_read = (write + kMaximumDynamicsDelayFrames - detector_delay) % kMaximumDynamicsDelayFrames;
    const std::array<float, 2> detector{history.detector_left[detector_read], history.detector_right[detector_read]};
    std::array<float, 2> levels{std::abs(detector[0]), std::abs(detector[1])};
    if (state.detector != 0) {
      const float alpha = std::exp(-1.0F / (0.01F * static_cast<float>(core.config.sample_rate_hz)));
      for (uint32_t channel = 0; channel < 2; ++channel) {
        history.rms[channel] = alpha * history.rms[channel] + (1.0F - alpha) * detector[channel] * detector[channel];
        levels[channel] = std::sqrt(history.rms[channel]);
      }
    }
    const float linked = std::fmax(levels[0], levels[1]);
    for (uint32_t channel = 0; channel < 2; ++channel) {
      const float level = levels[channel] + (linked - levels[channel]) * state.link;
      const float db = dynamics_gain_to_db(std::fmax(level, 1e-8F));
      if (level > 1e-8F) history.started[channel] = 1;
      const uint32_t hold = static_cast<uint32_t>(std::round(state.hold_ms * static_cast<float>(core.config.sample_rate_hz) / 1000.0F));
      if (history.open[channel] == 0 && db >= state.threshold_db) {
        history.open[channel] = 1; history.hold[channel] = hold;
      } else if (history.open[channel] != 0 && history.started[channel] != 0) {
        if (db >= state.threshold_db - state.hysteresis_db) history.hold[channel] = hold;
        else if (history.hold[channel] > 0) --history.hold[channel];
        else history.open[channel] = 0;
      }
      const float target_db = history.open[channel] != 0 ? 0.0F
        : state.mode != 0 ? std::fmax(state.range_db, (db - state.threshold_db) * (state.ratio - 1.0F)) : state.range_db;
      const float target = dynamics_db_to_gain(target_db);
      const float milliseconds = target > history.gain[channel] ? state.attack_ms : state.release_ms;
      const float coefficient = std::exp(-1.0F / (std::fmax(0.1F, milliseconds) * 0.001F * static_cast<float>(core.config.sample_rate_hz)));
      history.gain[channel] = target + coefficient * (history.gain[channel] - target);
    }
  } else if (compressor) {
    daw_audio_compressor_state state = processor.compressor;
    state.threshold_db = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_THRESHOLD_DB, frame, state.threshold_db);
    state.ratio = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_RATIO, frame, state.ratio);
    state.attack_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_ATTACK_MS, frame, state.attack_ms);
    state.release_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_RELEASE_MS, frame, state.release_ms);
    state.makeup_db = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_MAKEUP_DB, frame, state.makeup_db);
    state.output_db = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_OUTPUT_DB, frame, state.output_db);
    state.dry_wet = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_DRY_WET, frame, state.dry_wet);
    state.knee_db = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_KNEE_DB, frame, state.knee_db);
    state.lookahead_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_LOOKAHEAD_MS, frame, state.lookahead_ms);
    state.sidechain_frequency_hz = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_SIDECHAIN_FREQUENCY_HZ, frame, state.sidechain_frequency_hz);
    state.sidechain_q = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_SIDECHAIN_Q, frame, state.sidechain_q);
    const uint32_t detector_read = (write + kMaximumDynamicsDelayFrames - (fixed_delay - std::min(fixed_delay, dynamics_delay_frames(state.lookahead_ms, core.config.sample_rate_hz)))) % kMaximumDynamicsDelayFrames;
    history.detector_left[write] = 0.5F * (sidechain_left + sidechain_right);
    float detector = history.detector_left[detector_read];
    if (state.sidechain_enabled != 0) {
      const float coefficient = 1.0F - std::exp(-6.2831853071795864769F * std::fmin(state.sidechain_frequency_hz, static_cast<float>(core.config.sample_rate_hz) * 0.45F) / static_cast<float>(core.config.sample_rate_hz));
      history.compressor_sc_low += coefficient * (detector - history.compressor_sc_low);
      history.compressor_sc_band += coefficient * (detector - history.compressor_sc_low - history.compressor_sc_band / state.sidechain_q);
      detector = state.sidechain_filter_type == 1 ? history.compressor_sc_low : state.sidechain_filter_type == 2 ? history.compressor_sc_band : detector - history.compressor_sc_low;
    }
    const float level = state.detector_mode != 0
      ? std::sqrt(history.compressor_rms = history.compressor_rms * 0.99F + detector * detector * 0.01F)
      : std::abs(detector);
    const float target_db = compressor_curve_db(dynamics_gain_to_db(level), state) - dynamics_gain_to_db(level);
    const float release_ms = state.auto_release != 0 ? std::fmax(state.release_ms, state.release_ms * (1.0F + std::fmin(1.0F, -history.compressor_envelope_db / 24.0F))) : state.release_ms;
    if (state.envelope_curve != 0) {
      const float milliseconds = target_db < history.compressor_envelope_db ? state.attack_ms : release_ms;
      const float step_db = 60.0F / std::fmax(1.0F, static_cast<float>(core.config.sample_rate_hz) * milliseconds / 1000.0F);
      history.compressor_envelope_db += std::fmax(-step_db, std::fmin(step_db, target_db - history.compressor_envelope_db));
    } else {
      const float milliseconds = target_db < history.compressor_envelope_db ? state.attack_ms : release_ms;
      const float coefficient = std::exp(-1.0F / std::fmax(1.0F, static_cast<float>(core.config.sample_rate_hz) * milliseconds / 1000.0F));
      history.compressor_envelope_db = target_db + coefficient * (history.compressor_envelope_db - target_db);
    }
    const float gain = dynamics_db_to_gain(history.compressor_envelope_db + state.makeup_db + state.output_db);
    left = left * (1.0F - state.dry_wet) + left * gain * state.dry_wet;
    right = right * (1.0F - state.dry_wet) + right * gain * state.dry_wet;
  } else {
    daw_audio_limiter_state state = processor.limiter;
    state.ceiling_dbtp = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_CEILING, frame, state.ceiling_dbtp);
    state.release_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_RELEASE, frame, state.release_ms);
    state.lookahead_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_LOOKAHEAD_MS, frame, state.lookahead_ms);
    state.link = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_LINK, frame, state.link);
    const uint32_t detector_read = (write + kMaximumDynamicsDelayFrames - (fixed_delay - std::min(fixed_delay, dynamics_delay_frames(state.lookahead_ms, core.config.sample_rate_hz)))) % kMaximumDynamicsDelayFrames;
    const uint32_t true_peak_write = history.limiter_true_peak_write;
    history.limiter_true_peak_left[true_peak_write] = history.detector_left[detector_read];
    history.limiter_true_peak_right[true_peak_write] = history.detector_right[detector_read];
    const double detector_left = limiter_true_peak(history.limiter_true_peak_left, true_peak_write);
    const double detector_right = limiter_true_peak(history.limiter_true_peak_right, true_peak_write);
    history.limiter_true_peak_write = (true_peak_write + 1) % 12;
    const float ceiling = dynamics_db_to_gain(state.ceiling_dbtp);
    const float target_left = static_cast<float>(std::fmin(1.0, static_cast<double>(ceiling) / std::fmax(detector_left, 1e-12)));
    const float target_right = static_cast<float>(std::fmin(1.0, static_cast<double>(ceiling) / std::fmax(detector_right, 1e-12)));
    const float linked = std::fmin(target_left, target_right);
    const std::array<float, 2> targets{target_left + (linked - target_left) * state.link, target_right + (linked - target_right) * state.link};
    const float release = std::exp(-1.0F / (state.release_ms * 0.001F * static_cast<float>(core.config.sample_rate_hz)));
    // The detector runs `lookahead` frames ahead of the output, so a target must hold for that many frames
    // after it is computed; the true-peak window only reaches back to samples that are still in the delay line.
    const uint32_t lookahead = std::min(fixed_delay, dynamics_delay_frames(state.lookahead_ms, core.config.sample_rate_hz));
    for (uint32_t channel = 0; channel < 2; ++channel) {
      const float floor = limiter_window_minimum(history.limiter_targets[channel], targets[channel], lookahead);
      history.gain[channel] = std::fmin(floor, 1.0F + release * (history.gain[channel] - 1.0F));
    }
  }
  history.write = (write + 1) % kMaximumDynamicsDelayFrames;
  if (gate) {
    left *= history.gain[0];
    right *= history.gain[1];
  } else if (!compressor) {
    left *= history.gain[0];
    right *= history.gain[1];
  }
  const bool enabled = gate ? processor.gate.enabled != 0 : compressor ? processor.compressor.enabled != 0 : processor.limiter.enabled != 0;
  advance_bypass(core, history.bypass, processor.bypassed != 0 || !enabled);
  *output_left = bypass_mix(std::isfinite(left) ? left : 0.0F, delayed_left, history.bypass);
  *output_right = bypass_mix(std::isfinite(right) ? right : 0.0F, delayed_right, history.bypass);
}
}  // namespace daw::audio_core_internal
