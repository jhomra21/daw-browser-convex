#include "audio_core_internal.h"

namespace {

uint32_t lofi_next_random(uint32_t *state) {
  uint32_t value = *state;
  value ^= value << 13u;
  value ^= value >> 17u;
  value ^= value << 5u;
  *state = value == 0 ? 1u : value;
  return *state;
}

float lofi_random(uint32_t *state) {
  return static_cast<float>(lofi_next_random(state)) / 4294967296.0F;
}

float lofi_quantize(float scaled, uint32_t mode) {
  if (mode == DAW_AUDIO_LOFI_QUANTIZATION_FLOOR) return std::floor(scaled);
  if (mode == DAW_AUDIO_LOFI_QUANTIZATION_TRUNCATE) return std::trunc(scaled);
  // JavaScript Math.round rounds ties toward positive infinity.
  return std::floor(scaled + 0.5F);
}
}  // namespace

namespace daw::audio_core_internal {

void render_lofi_processor(
  Core &core,
  GraphRevision::Processor &processor,
  uint32_t frame,
  float input_left,
  float input_right,
  float,
  float,
  float *output_left,
  float *output_right) {
  LoFiHistory &history = core.lofi_histories[processor.history_slot];
  daw_audio_lofi_state state = processor.lofi;
  state.bit_depth = static_cast<uint32_t>(processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_BIT_DEPTH, frame, static_cast<float>(state.bit_depth)));
  const float dry_left = std::isfinite(input_left) ? input_left : 0.0F;
  const float dry_right = std::isfinite(input_right) ? input_right : 0.0F;
  const float bit_depth = static_cast<float>(state.bit_depth);
  const float levels = std::pow(2.0F, bit_depth - 1.0F) - 1.0F;
  const float lsb = 1.0F / levels;
  const float ratio = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_SAMPLE_RATE_RATIO, frame, state.sample_rate_ratio);
  const float jitter = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_JITTER, frame, state.jitter);
  const float noise_db = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_NOISE_DB, frame, state.noise_db);
  const float mix = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_MIX, frame, state.mix);
  for (uint32_t channel_index = 0; channel_index < 2; ++channel_index) {
    LoFiChannelHistory &channel = history.channels[channel_index];
    if (channel.random_state == 0) {
      channel.random_state = state.seed ^ (channel_index == 0 ? 0u : 0x9e3779b9u);
      if (channel.random_state == 0) channel.random_state = 1u;
    }
    const float dry = channel_index == 0 ? dry_left : dry_right;
    channel.phase += ratio;
    if (channel.phase >= channel.interval) {
      channel.phase -= channel.interval;
      channel.interval = 1.0F + (lofi_random(&channel.random_state) - 0.5F) * jitter;
      const float noise = (lofi_random(&channel.random_state) * 2.0F - 1.0F) * std::pow(10.0F, noise_db / 20.0F);
      float sample = dry + noise;
      if (state.dither == DAW_AUDIO_LOFI_DITHER_RECTANGULAR) {
        sample += (lofi_random(&channel.random_state) - 0.5F) * lsb;
      } else if (state.dither == DAW_AUDIO_LOFI_DITHER_TRIANGULAR) {
        sample += (lofi_random(&channel.random_state) - lofi_random(&channel.random_state)) * lsb;
      }
      const float quantized = lofi_quantize(sample * levels, state.quantization);
      channel.held = std::fmax(-1.0F, std::fmin(1.0F, quantized / levels));
    }
    const float processed = dry + (channel.held - dry) * mix;
    if (channel_index == 0) *output_left = processed;
    else *output_right = processed;
  }
  advance_bypass(core, history.bypass, processor.bypassed != 0 || state.enabled == 0);
  *output_left = std::isfinite(*output_left)
    ? *output_left + (dry_left - *output_left) * history.bypass : dry_left;
  *output_right = std::isfinite(*output_right)
    ? *output_right + (dry_right - *output_right) * history.bypass : dry_right;
}
}  // namespace daw::audio_core_internal
