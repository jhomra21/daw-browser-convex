#include "audio_core_internal.h"

namespace daw::audio_core_internal {

void render_limiter_processor(
  Core &core,
  GraphRevision::Processor &processor,
  uint32_t frame,
  float input_left,
  float input_right,
  float,
  float,
  float *output_left,
  float *output_right) {
  LimiterHistory &history = core.limiter_histories[processor.limiter_slot];
  if (history.prepared_rate_hz != core.config.sample_rate_hz) {
    history.kernel.prepare(static_cast<double>(core.config.sample_rate_hz));
    history.prepared_rate_hz = core.config.sample_rate_hz;
  }
  const daw_audio_limiter_state &state = processor.limiter;
  const auto value = [&](uint32_t target, float fallback) {
    return processor_parameter_value(core, processor, target, frame, fallback);
  };
  const daw::audio_core::LimiterValues values{
    .ceiling_dbtp = value(DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_CEILING, state.ceiling_dbtp),
    .release_ms = value(DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_RELEASE, state.release_ms),
    .link = value(DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_LINK, state.link),
    .gain_db = value(DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_GAIN_DB, state.gain_db),
  };
  const daw::audio_core::LimiterConfig config{.lookahead_ms = state.lookahead_ms, .auto_release = state.auto_release != 0};
  advance_bypass(core, history.bypass, processor.bypassed != 0 || state.enabled == 0);
  history.kernel.process(values, config, history.bypass, input_left, input_right, *output_left, *output_right);
}
}  // namespace daw::audio_core_internal
