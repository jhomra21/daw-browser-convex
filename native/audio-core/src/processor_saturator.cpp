#include "audio_core_internal.h"

namespace daw::audio_core_internal {
namespace {

daw::audio_core::SaturatorValues read_saturator_values(const Core &core, const GraphRevision::Processor &processor, uint32_t frame) {
  const daw_audio_saturator_state &state = processor.saturator;
  const auto value = [&](uint32_t target, float fallback) { return processor_parameter_value(core, processor, target, frame, fallback); };
  return {
    .drive_db = value(DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_DRIVE_DB, state.drive_db),
    .output_db = value(DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_OUTPUT_DB, state.output_db),
    .dry_wet = value(DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_DRY_WET, state.dry_wet),
    .color_frequency_hz = value(DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_COLOR_FREQUENCY_HZ, state.color_frequency_hz),
    .color_width = value(DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_COLOR_WIDTH, state.color_width),
    .color_low_db = value(DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_COLOR_LOW_DB, state.color_low_db),
    .color_high_db = value(DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_COLOR_HIGH_DB, state.color_high_db),
    .bass_threshold_db = value(DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_BASS_THRESHOLD_DB, state.bass_threshold_db),
    .warp_depth = value(DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_WARP_DEPTH, state.warp_depth),
    .warp_period = value(DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_WARP_PERIOD, state.warp_period),
  };
}

}  // namespace

void render_saturator_processor(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float, float, float *output_left, float *output_right) {
  SaturatorHistory &history = core.saturator_histories[processor.history_slot];
  // The kernel takes its controls once per few frames, so the parameter lookups run only then.
  if (history.kernel.control_due()) {
    history.values = read_saturator_values(core, processor, frame);
    history.config = {.curve = processor.saturator.curve, .post_clip = processor.saturator.post_clip,
      .hi_quality = processor.saturator.hi_quality != 0, .color = processor.saturator.color != 0};
  }
  const float dry_left = std::isfinite(input_left) ? input_left : 0.0F;
  const float dry_right = std::isfinite(input_right) ? input_right : 0.0F;
  float left = 0.0F;
  float right = 0.0F;
  history.kernel.process(history.values, history.config, dry_left, dry_right, left, right);
  advance_bypass(core, history.bypass, processor.bypassed != 0 || processor.saturator.enabled == 0);
  *output_left = bypass_mix(left, dry_left, history.bypass);
  *output_right = bypass_mix(right, dry_right, history.bypass);
}
}  // namespace daw::audio_core_internal
