#include "audio_core_internal.h"

namespace daw::audio_core_internal {
namespace {

daw::audio_core::DelayValues read_delay_values(const Core &core, const GraphRevision::Processor &processor, uint32_t frame) {
  const daw_audio_delay_state &state = processor.delay;
  const auto value = [&](uint32_t target, float fallback) {
    return processor_parameter_value(core, processor, target, frame, fallback);
  };
  return {
    .time_ms = {value(DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_TIME_LEFT_MS, state.time_left_ms),
      value(DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_TIME_RIGHT_MS, state.time_right_ms)},
    .offset_percent = {value(DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_OFFSET_LEFT_PERCENT, state.offset_left_percent),
      value(DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_OFFSET_RIGHT_PERCENT, state.offset_right_percent)},
    .feedback = value(DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_FEEDBACK, state.feedback),
    .dry_wet = value(DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_DRY_WET, state.dry_wet),
    .filter_hz = value(DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_FILTER_HZ, state.filter_hz),
    .filter_width = value(DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_FILTER_WIDTH, state.filter_width),
    .tempo_bpm = core.transport.tempo_bpm,
  };
}

daw::audio_core::DelayConfig delay_config(const daw_audio_delay_state &state) {
  return {
    .link = state.link != 0,
    .ping_pong = state.ping_pong != 0,
    .freeze = state.freeze != 0,
    .filter = state.filter_enabled != 0,
    .smoothing = state.smoothing,
    .sync = {state.sync_left != 0, state.sync_right != 0},
    .division = {state.division_left, state.division_right},
    .feel = {state.feel_left, state.feel_right},
  };
}

}  // namespace

void render_time_effect_processor(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float, float,
  float *output_left, float *output_right) {
  DelayHistory &history = core.delay_histories[processor.delay_slot];
  // The kernel takes its controls once per few frames, so the parameter lookups run only then.
  if (history.kernel.control_due()) {
    history.values = read_delay_values(core, processor, frame);
    history.config = delay_config(processor.delay);
  }
  const float dry_left = std::isfinite(input_left) ? input_left : 0.0F;
  const float dry_right = std::isfinite(input_right) ? input_right : 0.0F;
  float left = 0.0F;
  float right = 0.0F;
  history.kernel.process(history.values, history.config, dry_left, dry_right, left, right);
  advance_bypass(core, history.bypass, processor.delay.enabled == 0 || processor.bypassed != 0);
  *output_left = left + (dry_left - left) * history.bypass;
  *output_right = right + (dry_right - right) * history.bypass;
}

}  // namespace daw::audio_core_internal
