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
  float left = dry_left;
  float right = dry_right;
  if (!std::isfinite(left) || !std::isfinite(right)) left = right = 0.0F;
  const float sanitized_dry_left = left;
  const float sanitized_dry_right = right;

  daw_audio_utility_state state = processor == nullptr ? core.utility : processor->utility;
  if (processor != nullptr) {
    state.gain_db = processor_parameter_value(core, *processor, DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB, frame, state.gain_db);
    state.pan = processor_parameter_value(core, *processor, DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_PAN, frame, state.pan);
    state.balance = processor_parameter_value(core, *processor, DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_BALANCE, frame, state.balance);
    state.width = processor_parameter_value(core, *processor, DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_WIDTH, frame, state.width);
  }
  if (state.input_mode == DAW_AUDIO_UTILITY_INPUT_MODE_MONO_SUM) left = right = 0.5F * left + 0.5F * right;
  if (state.polarity == DAW_AUDIO_UTILITY_POLARITY_INVERT) {
    left = -left;
    right = -right;
  }

  constexpr float sqrt_half = 0.7071067811865475244F;
  if (state.matrix == DAW_AUDIO_UTILITY_MATRIX_MID_SIDE_ENCODE) {
    const float mid = (left + right) * sqrt_half;
    right = (left - right) * sqrt_half;
    left = mid;
  } else if (state.matrix == DAW_AUDIO_UTILITY_MATRIX_MID_SIDE_DECODE) {
    const float mid = left;
    left = (mid + right) * sqrt_half;
    right = (mid - right) * sqrt_half;
  }

  if (state.swap != 0) {
    const float swapped = left;
    left = right;
    right = swapped;
  }

  const float mid = (left + right) * sqrt_half;
  const float side = (left - right) * sqrt_half * state.width;
  left = (mid + side) * sqrt_half;
  right = (mid - side) * sqrt_half;
  if (state.balance > 0.0F) left *= 1.0F - state.balance;
  if (state.balance < 0.0F) right *= 1.0F + state.balance;
  const float pan_angle = (state.pan + 1.0F) * 0.7853981633974483096F;
  left *= std::cos(pan_angle) * 1.4142135623730950488F;
  right *= std::sin(pan_angle) * 1.4142135623730950488F;
  const float gain = std::pow(10.0F, state.gain_db / 20.0F);
  left *= gain;
  right *= gain;

  if (state.dc_block != 0) {
    const float dc_coefficient = std::exp(-6.2831853071795864769F * 10.0F / static_cast<float>(core.config.sample_rate_hz));
    const float next_left = left - history.dc_x1_left + dc_coefficient * history.dc_y1_left;
    const float next_right = right - history.dc_x1_right + dc_coefficient * history.dc_y1_right;
    history.dc_x1_left = left;
    history.dc_x1_right = right;
    history.dc_y1_left = next_left;
    history.dc_y1_right = next_right;
    left = next_left;
    right = next_right;
  }

  if (!std::isfinite(left) || !std::isfinite(right)) {
    left = right = 0.0F;
    history.dc_x1_left = history.dc_x1_right = history.dc_y1_left = history.dc_y1_right = 0.0F;
  }

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
