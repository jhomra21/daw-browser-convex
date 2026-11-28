#include "audio_core_internal.h"

namespace {

float modulation_lfo(uint32_t waveform, float phase) {
  const float wrapped = phase - std::floor(phase);
  return waveform == 1 ? 1.0F - 4.0F * std::abs(wrapped - 0.5F) : std::sin(6.2831853071795864769F * wrapped);
}

float shaped_unipolar(const daw_audio_amplitude_modulation_state &state, float phase) {
  return std::pow(0.5F + 0.5F * modulation_lfo(state.waveform, phase), std::pow(2.0F, 4.0F * (state.shape - 0.5F)));
}

float read_modulation_delay(const std::array<float, kMaximumModulationDelayFrames> &buffer, uint32_t write, float delay_frames) {
  float position = static_cast<float>(write) - delay_frames;
  while (position < 0.0F) position += static_cast<float>(buffer.size());
  const uint32_t index1 = static_cast<uint32_t>(std::floor(position)) % buffer.size();
  const float fraction = position - std::floor(position);
  const uint32_t index0 = (index1 + buffer.size() - 1) % buffer.size();
  const uint32_t index2 = (index1 + 1) % buffer.size();
  const uint32_t index3 = (index1 + 2) % buffer.size();
  const float a = buffer[index1];
  const float b = 0.5F * (-buffer[index0] + buffer[index2]);
  const float c = 0.5F * (2.0F * buffer[index0] - 5.0F * buffer[index1] + 4.0F * buffer[index2] - buffer[index3]);
  const float d = 0.5F * (-buffer[index0] + 3.0F * buffer[index1] - 3.0F * buffer[index2] + buffer[index3]);
  return ((d * fraction + c) * fraction + b) * fraction + a;
}

float phaser_sample(
  Core &core, const daw_audio_phaser_state &state, ModulationHistory &history,
  float input, uint32_t channel, float lfo) {
  const float center = state.center_hz * std::pow(2.0F, state.depth_octaves * lfo);
  const float frequency = std::fmax(20.0F, std::fmin(static_cast<float>(core.config.sample_rate_hz) * 0.49F, center));
  const float tangent = std::tan(3.14159265358979323846F * frequency / static_cast<float>(core.config.sample_rate_hz));
  const float coefficient = (tangent - 1.0F) / (tangent + 1.0F);
  auto &xs = channel == 0 ? history.allpass_x_left : history.allpass_x_right;
  auto &ys = channel == 0 ? history.allpass_y_left : history.allpass_y_right;
  float value = input + (channel == 0 ? history.feedback_left : history.feedback_right) * state.feedback;
  for (uint32_t stage = 0; stage < state.stages; ++stage) {
    const float output = coefficient * value + xs[stage] - coefficient * ys[stage];
    xs[stage] = value; ys[stage] = output; value = output;
  }
  if (channel == 0) history.feedback_left = value; else history.feedback_right = value;
  return value;
}
}  // namespace

namespace daw::audio_core_internal {

void render_modulation_processor(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float, float, float *output_left, float *output_right) {
  ModulationHistory &history = core.modulation_histories[processor.history_slot];
  const float dry_left = std::isfinite(input_left) ? input_left : 0.0F;
  const float dry_right = std::isfinite(input_right) ? input_right : 0.0F;
  float left = dry_left;
  float right = dry_right;
  const bool is_delay = processor.kind == DAW_AUDIO_PROCESSOR_KIND_CHORUS || processor.kind == DAW_AUDIO_PROCESSOR_KIND_FLANGER;
  const bool is_amplitude = processor.kind == DAW_AUDIO_PROCESSOR_KIND_TREMOLO || processor.kind == DAW_AUDIO_PROCESSOR_KIND_AUTOPAN;
  float rate = 0.0F;
  bool enabled = false;
  if (is_delay) {
    daw_audio_delay_modulation_state state = processor.delay_modulation;
    const uint32_t base = processor.kind == DAW_AUDIO_PROCESSOR_KIND_CHORUS
      ? DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_DELAY_MS : DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_DELAY_MS;
    state.delay_ms = processor_parameter_value(core, processor, base, frame, state.delay_ms);
    state.depth_ms = processor_parameter_value(core, processor, base + 1, frame, state.depth_ms);
    state.rate_hz = processor_parameter_value(core, processor, base + 2, frame, state.rate_hz);
    state.feedback = processor_parameter_value(core, processor, base + 3, frame, state.feedback);
    state.stereo_phase = processor_parameter_value(core, processor, base + 4, frame, state.stereo_phase);
    state.mix = processor_parameter_value(core, processor, base + 5, frame, state.mix);
    const float phase_left = static_cast<float>(history.phase);
    const float phase_right = phase_left + state.stereo_phase;
    history.delay_left[history.write] = dry_left + history.feedback_left * state.feedback;
    history.delay_right[history.write] = dry_right + history.feedback_right * state.feedback;
    const float left_delay = std::fmax(1.0F, (state.delay_ms + state.depth_ms * modulation_lfo(0, phase_left)) * static_cast<float>(core.config.sample_rate_hz) / 1000.0F);
    const float right_delay = std::fmax(1.0F, (state.delay_ms + state.depth_ms * modulation_lfo(0, phase_right)) * static_cast<float>(core.config.sample_rate_hz) / 1000.0F);
    const float wet_left = read_modulation_delay(history.delay_left, history.write, left_delay);
    const float wet_right = read_modulation_delay(history.delay_right, history.write, right_delay);
    history.feedback_left = wet_left; history.feedback_right = wet_right;
    history.write = (history.write + 1) % kMaximumModulationDelayFrames;
    left = dry_left * (1.0F - state.mix) + wet_left * state.mix;
    right = dry_right * (1.0F - state.mix) + wet_right * state.mix;
    rate = state.rate_hz; enabled = state.enabled != 0;
  } else if (processor.kind == DAW_AUDIO_PROCESSOR_KIND_ENSEMBLE) {
    daw_audio_ensemble_state state = processor.ensemble;
    state.delay_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_DELAY_MS, frame, state.delay_ms);
    state.depth_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_DEPTH_MS, frame, state.depth_ms);
    state.rate_hz = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_RATE_HZ, frame, state.rate_hz);
    state.spread = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_SPREAD, frame, state.spread);
    state.mix = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_MIX, frame, state.mix);
    history.delay_left[history.write] = dry_left; history.delay_right[history.write] = dry_right;
    float wet_left = 0.0F; float wet_right = 0.0F;
    for (uint32_t voice = 0; voice < 3; ++voice) {
      const float voice_phase = static_cast<float>(history.phase) + static_cast<float>(voice) / 3.0F;
      const float spread = state.spread * (static_cast<float>(voice) - 1.0F) * 0.25F;
      wet_left += read_modulation_delay(history.delay_left, history.write, std::fmax(1.0F, (state.delay_ms + state.depth_ms * modulation_lfo(0, voice_phase - spread)) * static_cast<float>(core.config.sample_rate_hz) / 1000.0F));
      wet_right += read_modulation_delay(history.delay_right, history.write, std::fmax(1.0F, (state.delay_ms + state.depth_ms * modulation_lfo(0, voice_phase + spread)) * static_cast<float>(core.config.sample_rate_hz) / 1000.0F));
    }
    history.write = (history.write + 1) % kMaximumModulationDelayFrames;
    left = dry_left * (1.0F - state.mix) + wet_left * state.mix / 3.0F;
    right = dry_right * (1.0F - state.mix) + wet_right * state.mix / 3.0F;
    rate = state.rate_hz; enabled = state.enabled != 0;
  } else if (processor.kind == DAW_AUDIO_PROCESSOR_KIND_PHASER) {
    daw_audio_phaser_state state = processor.phaser;
    state.center_hz = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_CENTER_HZ, frame, state.center_hz);
    state.depth_octaves = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_DEPTH_OCTAVES, frame, state.depth_octaves);
    state.rate_hz = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_RATE_HZ, frame, state.rate_hz);
    state.feedback = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_FEEDBACK, frame, state.feedback);
    state.stereo_phase = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_STEREO_PHASE, frame, state.stereo_phase);
    state.mix = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_MIX, frame, state.mix);
    const float wet_left = phaser_sample(core, state, history, dry_left, 0, modulation_lfo(0, static_cast<float>(history.phase)));
    const float wet_right = phaser_sample(core, state, history, dry_right, 1, modulation_lfo(0, static_cast<float>(history.phase) + state.stereo_phase));
    left = dry_left * (1.0F - state.mix) + wet_left * state.mix;
    right = dry_right * (1.0F - state.mix) + wet_right * state.mix;
    rate = state.rate_hz; enabled = state.enabled != 0;
  } else if (is_amplitude) {
    daw_audio_amplitude_modulation_state state = processor.amplitude_modulation;
    const uint32_t base = processor.kind == DAW_AUDIO_PROCESSOR_KIND_TREMOLO
      ? DAW_AUDIO_PROCESSOR_PARAMETER_TREMOLO_RATE_HZ : DAW_AUDIO_PROCESSOR_PARAMETER_AUTOPAN_RATE_HZ;
    state.rate_hz = processor_parameter_value(core, processor, base, frame, state.rate_hz);
    state.depth = processor_parameter_value(core, processor, base + 1, frame, state.depth);
    state.shape = processor_parameter_value(core, processor, base + 2, frame, state.shape);
    state.phase = processor_parameter_value(core, processor, base + 3, frame, state.phase);
    const float shaped = shaped_unipolar(state, static_cast<float>(history.phase) + state.phase);
    if (processor.kind == DAW_AUDIO_PROCESSOR_KIND_TREMOLO) {
      const float gain = 1.0F - state.depth + state.depth * shaped;
      left = dry_left * gain; right = dry_right * gain;
    } else {
      const float position = state.depth * (2.0F * shaped - 1.0F);
      left = dry_left * std::cos((position + 1.0F) * 0.7853981633974483096F) * 1.4142135623730950488F;
      right = dry_right * std::sin((position + 1.0F) * 0.7853981633974483096F) * 1.4142135623730950488F;
    }
    rate = state.rate_hz; enabled = state.enabled != 0;
  }
  history.phase += static_cast<double>(rate) / static_cast<double>(core.config.sample_rate_hz);
  history.phase -= std::floor(history.phase);
  if (!std::isfinite(left) || !std::isfinite(right)) {
    left = right = 0.0F; history.feedback_left = history.feedback_right = 0.0F;
  }
  advance_bypass(core, history.bypass, !enabled || processor.bypassed != 0);
  *output_left = left + (dry_left - left) * history.bypass;
  *output_right = right + (dry_right - right) * history.bypass;
}
}  // namespace daw::audio_core_internal
