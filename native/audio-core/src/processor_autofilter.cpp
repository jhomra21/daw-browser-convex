#include "audio_core_internal.h"

namespace {

float autofilter_lfo(uint32_t waveform, float phase) {
  const float wrapped = phase - std::floor(phase);
  return waveform == 1
    ? 1.0F - 4.0F * std::abs(wrapped - 0.5F)
    : std::sin(6.2831853071795864769F * wrapped);
}

float autofilter_filter(
  AutoFilterChannelHistory &channel,
  float input,
  float cutoff,
  float q,
  uint32_t mode,
  uint32_t sample_rate_hz) {
  const float g = std::tan(3.14159265358979323846F * cutoff / (static_cast<float>(sample_rate_hz) * 2.0F));
  const float k = 1.0F / q;
  const float a1 = 1.0F / (1.0F + g * (g + k));
  const float v1 = a1 * (channel.ic1 + g * (input - channel.ic2));
  const float v2 = channel.ic2 + g * v1;
  channel.ic1 = 2.0F * v1 - channel.ic1;
  channel.ic2 = 2.0F * v2 - channel.ic2;
  const float high = input - k * v1 - v2;
  if (mode == DAW_AUDIO_AUTOFILTER_MODE_HIGHPASS) return high;
  if (mode == DAW_AUDIO_AUTOFILTER_MODE_BANDPASS) return v1;
  if (mode == DAW_AUDIO_AUTOFILTER_MODE_NOTCH) return high + v2;
  if (mode == DAW_AUDIO_AUTOFILTER_MODE_PEAK) return v2 - high;
  return v2;
}

float render_autofilter_channel(
  Core &core,
  GraphRevision::Processor &processor,
  AutoFilterChannelHistory &channel,
  uint32_t channel_index,
  uint32_t frame,
  float input) {
  const daw_audio_autofilter_state &state = processor.autofilter;
  const float attack_ms = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_ENVELOPE_ATTACK_MS, frame, state.envelope_attack_ms);
  const float release_ms = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_ENVELOPE_RELEASE_MS, frame, state.envelope_release_ms);
  const float attack = std::exp(-1.0F / (std::fmax(0.5F, attack_ms) * 0.001F * static_cast<float>(core.config.sample_rate_hz)));
  const float release = std::exp(-1.0F / (std::fmax(5.0F, release_ms) * 0.001F * static_cast<float>(core.config.sample_rate_hz)));
  const float peak = std::abs(input);
  channel.envelope = peak > channel.envelope
    ? attack * channel.envelope + (1.0F - attack) * peak
    : release * channel.envelope + (1.0F - release) * peak;
  const float rate = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_LFO_RATE_HZ, frame, state.lfo_rate_hz);
  const float phase_offset = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_LFO_PHASE_OFFSET, frame, state.lfo_phase_offset);
  const float stereo_phase = channel_index == 0 ? 0.0F : processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_LFO_STEREO_PHASE, frame, state.lfo_stereo_phase);
  const float lfo = autofilter_lfo(state.lfo_waveform, static_cast<float>(channel.phase) + phase_offset + stereo_phase);
  channel.phase += static_cast<double>(rate) / static_cast<double>(core.config.sample_rate_hz);
  channel.phase -= std::floor(channel.phase);
  const float envelope_amount = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_ENVELOPE_AMOUNT_OCTAVES, frame, state.envelope_amount_octaves);
  const float lfo_depth = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_LFO_DEPTH_OCTAVES, frame, state.lfo_depth_octaves);
  const float frequency = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_FREQUENCY_HZ, frame, state.frequency_hz);
  const float cutoff = std::fmax(
    20.0F,
    std::fmin(
      frequency * std::pow(2.0F, envelope_amount * channel.envelope + lfo_depth * lfo),
      0.45F * static_cast<float>(core.config.sample_rate_hz)));
  const float resonance = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_RESONANCE, frame, state.resonance);
  const float q = 0.5F + 19.5F * resonance;
  const float drive_db = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_DRIVE_DB, frame, state.drive_db);
  const float driven = std::tanh(input * std::pow(10.0F, drive_db / 20.0F));
  const float midpoint = 0.5F * (channel.previous + driven);
  autofilter_filter(channel, midpoint, cutoff, q, state.mode, core.config.sample_rate_hz);
  const float wet = autofilter_filter(channel, driven, cutoff, q, state.mode, core.config.sample_rate_hz);
  channel.previous = driven;
  const float mix = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_MIX, frame, state.mix);
  return input + (wet - input) * mix;
}
}  // namespace

namespace daw::audio_core_internal {

void render_autofilter_processor(
  Core &core,
  GraphRevision::Processor &processor,
  uint32_t frame,
  float input_left,
  float input_right,
  float,
  float,
  float *output_left,
  float *output_right) {
  AutoFilterHistory &history = core.autofilter_histories[processor.history_slot];
  const float left = std::isfinite(input_left) ? input_left : 0.0F;
  const float right = std::isfinite(input_right) ? input_right : 0.0F;
  advance_bypass(core, history.bypass, processor.bypassed != 0 || processor.autofilter.enabled == 0);
  const float processed_left = render_autofilter_channel(core, processor, history.channels[0], 0, frame, left);
  const float processed_right = render_autofilter_channel(core, processor, history.channels[1], 1, frame, right);
  const float mixed_left = std::isfinite(processed_left) ? processed_left + (left - processed_left) * history.bypass : 0.0F;
  const float mixed_right = std::isfinite(processed_right) ? processed_right + (right - processed_right) * history.bypass : 0.0F;
  if (!std::isfinite(processed_left)) history.channels[0] = {};
  if (!std::isfinite(processed_right)) history.channels[1] = {};
  *output_left = history.delay[0][history.delay_index];
  *output_right = history.delay[1][history.delay_index];
  history.delay[0][history.delay_index] = mixed_left;
  history.delay[1][history.delay_index] = mixed_right;
  history.delay_index = (history.delay_index + 1) % kAutoFilterLatencyFrames;
}
}  // namespace daw::audio_core_internal
