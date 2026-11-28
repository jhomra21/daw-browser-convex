#include "audio_core_internal.h"

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
  // The kernel takes its controls once per few frames, so the parameter lookups run only then.
  if (history.kernel.control_due()) {
    const daw_audio_lofi_state &state = processor.lofi;
    const auto value = [&](uint32_t target, float fallback) { return processor_parameter_value(core, processor, target, frame, fallback); };
    history.values = {
      .bit_depth = value(DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_BIT_DEPTH, static_cast<float>(state.bit_depth)),
      .rate_hz = value(DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_SAMPLE_RATE_HZ, state.sample_rate_hz),
      .jitter = value(DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_JITTER, state.jitter),
      .noise_db = value(DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_NOISE_DB, state.noise_db),
      .mix = value(DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_MIX, state.mix),
    };
    history.config = {.quantization = state.quantization, .dither = state.dither, .seed = state.seed,
      .pre_filter = state.pre_filter != 0, .post_filter = state.post_filter != 0, .dc_correction = state.dc_correction != 0,
      .sub_sample_clock = state.sub_sample_clock != 0};
  }
  const float dry_left = std::isfinite(input_left) ? input_left : 0.0F;
  const float dry_right = std::isfinite(input_right) ? input_right : 0.0F;
  float left = 0.0F;
  float right = 0.0F;
  history.kernel.process(history.values, history.config, dry_left, dry_right, left, right);
  advance_bypass(core, history.bypass, processor.bypassed != 0 || processor.lofi.enabled == 0);
  *output_left = bypass_mix(left, dry_left, history.bypass);
  *output_right = bypass_mix(right, dry_right, history.bypass);
}
}  // namespace daw::audio_core_internal
