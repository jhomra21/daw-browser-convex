#include "audio_core_internal.h"

namespace daw::audio_core_internal {

void process_utility_frame(
  Core &core,
  const GraphRevision::Processor *processor,
  UtilityHistory &history,
  uint32_t frame,
  float dry_left,
  float dry_right,
  float *left_output,
  float *right_output) {
  if (!history.kernel.prepared_for(static_cast<double>(core.config.sample_rate_hz))) {
    history.kernel.prepare(static_cast<double>(core.config.sample_rate_hz));
  }
  const float sanitized_dry_left = std::isfinite(dry_left) ? dry_left : 0.0F;
  const float sanitized_dry_right = std::isfinite(dry_right) ? dry_right : 0.0F;
  const daw_audio_utility_state &state = processor == nullptr ? core.utility : processor->utility;

  // The kernel takes its controls once per few frames, so the parameter lookups run only then.
  if (history.kernel.control_due()) {
    const auto value = [&](uint32_t target, float fallback) {
      return processor == nullptr ? fallback : processor_parameter_value(core, *processor, target, frame, fallback);
    };
    history.values = {
      .gain_db = value(DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB, state.gain_db),
      .balance = value(DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_BALANCE, state.balance),
      .width = value(DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_WIDTH, state.width),
      .mid_side = value(DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_MID_SIDE, state.mid_side),
      .bass_mono_hz = value(DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_BASS_MONO_HZ, state.bass_mono_hz),
    };
    history.config = {
      .phase_left = state.phase_left != 0, .phase_right = state.phase_right != 0,
      .mono = state.input_mode == DAW_AUDIO_UTILITY_INPUT_MODE_MONO_SUM,
      .matrix = state.matrix, .channel_mode = state.channel_mode, .width_mode = state.width_mode,
      .mute = state.mute != 0, .bass_mono = state.bass_mono != 0, .bass_mono_audition = state.bass_mono_audition != 0,
      .dc_block = state.dc_block != 0,
    };
  }
  float left = 0.0F;
  float right = 0.0F;
  history.kernel.process(history.values, history.config, sanitized_dry_left, sanitized_dry_right, left, right);
  advance_bypass(core, history.bypass, state.enabled == 0 || (processor != nullptr && processor->bypassed != 0));
  *left_output = bypass_mix(left, sanitized_dry_left, history.bypass);
  *right_output = bypass_mix(right, sanitized_dry_right, history.bypass);
}

void render_utility_processor(
  Core &core,
  GraphRevision::Processor &processor,
  uint32_t frame,
  float input_left,
  float input_right,
  float,
  float,
  float *output_left,
  float *output_right) {
  daw_audio_utility_state state = processor.utility;
  state.enabled = processor.bypassed == 0 ? state.enabled : 0;
  const daw_audio_utility_state previous_state = core.utility;
  const bool previous_configured = core.utility_configured;
  core.utility = state;
  core.utility_configured = true;
  process_utility_frame(
    core, processor.parameter_count == 0 ? nullptr : &processor,
    core.utility_histories[processor.history_slot], frame, input_left, input_right, output_left, output_right);
  core.utility = previous_state;
  core.utility_configured = previous_configured;
}
}  // namespace daw::audio_core_internal
