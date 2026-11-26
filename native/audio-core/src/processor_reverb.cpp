#include "audio_core_internal.h"

namespace daw::audio_core_internal {
namespace {

daw::audio_core::ReverbValues read_reverb_values(const Core &core, const GraphRevision::Processor &processor, uint32_t frame) {
  const daw_audio_reverb_state &state = processor.reverb;
  const auto value = [&](uint32_t target, float fallback) {
    return processor_parameter_value(core, processor, target, frame, fallback);
  };
  return {
    .wet = value(DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_WET, state.wet),
    .decay_sec = value(DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DECAY_SEC, state.decay_sec),
    .pre_delay_ms = value(DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_PRE_DELAY_MS, state.pre_delay_ms),
    .reflections = value(DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTIONS, state.reflections),
    .spin_amount_ms = value(DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTION_MOD_AMOUNT_MS, state.reflection_mod_amount_ms),
    .spin_rate_hz = value(DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTION_MOD_RATE_HZ, state.reflection_mod_rate_hz),
    .shape = value(DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTION_SHAPE, state.reflection_shape),
    .diffuse = value(DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DIFFUSE, state.diffuse),
    .size = value(DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_SIZE, state.size),
    .diffusion = value(DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DIFFUSION, state.diffusion),
    .low_cut_hz = value(DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_LOW_CUT_HZ, state.low_cut_hz),
    .high_cut_hz = value(DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_HIGH_CUT_HZ, state.high_cut_hz),
    .low_shelf_hz = value(DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_LOW_SHELF_HZ, state.low_shelf_hz),
    .high_shelf_hz = value(DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_HIGH_SHELF_HZ, state.high_shelf_hz),
    .low_shelf_db = value(DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_LOW_SHELF_DB, state.low_shelf_db),
    .high_shelf_db = value(DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_HIGH_SHELF_DB, state.high_shelf_db),
    .chorus_amount_ms = value(DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_CHORUS_AMOUNT_MS, state.chorus_amount_ms),
    .chorus_rate_hz = value(DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_CHORUS_RATE_HZ, state.chorus_rate_hz),
    .stereo_degrees = value(DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_STEREO_WIDTH, state.stereo_width),
  };
}

daw::audio_core::ReverbConfig reverb_config(const daw_audio_reverb_state &state) {
  return {
    .smooth = state.smooth,
    .spin = state.reflection_spin != 0,
    .chorus = state.chorus != 0,
    .high_shelf = state.high_shelf_on != 0,
    .low_shelf = state.low_shelf_on != 0,
    .freeze = state.freeze != 0,
    .flat = state.flat != 0,
    .cut = state.cut != 0,
  };
}

}  // namespace

void render_reverb_processor(
  Core &core,
  GraphRevision::Processor &processor,
  uint32_t frame,
  float input_left,
  float input_right,
  float,
  float,
  float *output_left,
  float *output_right) {
  ReverbHistory &history = core.reverb_histories[processor.reverb_slot];
  // The kernel takes its controls once per few frames, so the parameter lookups run only then.
  if (history.kernel.control_due()) {
    history.values = read_reverb_values(core, processor, frame);
    history.config = reverb_config(processor.reverb);
  }
  const float dry_left = std::isfinite(input_left) ? input_left : 0.0F;
  const float dry_right = std::isfinite(input_right) ? input_right : 0.0F;
  float left = 0.0F;
  float right = 0.0F;
  history.kernel.process(history.values, history.config, dry_left, dry_right, left, right);
  advance_bypass(core, history.bypass, processor.bypassed != 0 || processor.reverb.enabled == 0);
  *output_left = left + (dry_left - left) * history.bypass;
  *output_right = right + (dry_right - right) * history.bypass;
}
}  // namespace daw::audio_core_internal
