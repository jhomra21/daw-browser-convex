#include "audio_core_internal.h"

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
  if (history.prepared_rate_hz != core.config.sample_rate_hz) {
    history.kernel.prepare(static_cast<double>(core.config.sample_rate_hz));
    history.prepared_rate_hz = core.config.sample_rate_hz;
  }
  const daw_audio_autofilter_state &state = processor.autofilter;
  const auto value = [&](uint32_t target, float fallback) {
    return processor_parameter_value(core, processor, target, frame, fallback);
  };
  const daw::audio_core::AutoFilterValues values{
    .frequency_hz = value(DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_FREQUENCY_HZ, state.frequency_hz),
    .resonance = value(DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_RESONANCE, state.resonance),
    .drive_db = value(DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_DRIVE_DB, state.drive_db),
    .mix = value(DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_MIX, state.mix),
    .output_db = value(DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_OUTPUT_DB, state.output_db),
    .env_amount_octaves = value(DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_ENVELOPE_AMOUNT_OCTAVES, state.envelope_amount_octaves),
    .env_attack_ms = value(DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_ENVELOPE_ATTACK_MS, state.envelope_attack_ms),
    .env_release_ms = value(DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_ENVELOPE_RELEASE_MS, state.envelope_release_ms),
    .lfo_rate_hz = value(DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_LFO_RATE_HZ, state.lfo_rate_hz),
    .lfo_depth_octaves = value(DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_LFO_DEPTH_OCTAVES, state.lfo_depth_octaves),
    .lfo_phase_offset = value(DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_LFO_PHASE_OFFSET, state.lfo_phase_offset),
    .lfo_stereo_phase = value(DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_LFO_STEREO_PHASE, state.lfo_stereo_phase),
  };
  const daw::audio_core::AutoFilterConfig config{
    .mode = state.mode,
    .slope = state.slope,
    .waveform = state.lfo_waveform,
    .stereo_mode = state.lfo_stereo_mode,
    .division = state.lfo_division,
    .hi_quality = state.hi_quality != 0,
    .clip = state.clip != 0,
    .env_hold = state.envelope_hold != 0,
    .env_link = state.envelope_link != 0,
    .sync = state.lfo_sync != 0,
  };
  advance_bypass(core, history.bypass, processor.bypassed != 0 || state.enabled == 0);
  // The wrapped project frame keeps a looped song's LFO on its bar; the block's start is where a mid-block loop wrap is ignored.
  const daw::audio_core::dsp::LfoTransport transport{
    .tempo_bpm = core.transport.tempo_bpm,
    .frame = project_time_frame(core) + static_cast<int64_t>(frame),
    .running = core.transport.running != 0,
  };
  history.kernel.process(values, config, transport, history.bypass, input_left, input_right, *output_left, *output_right);
}
}  // namespace daw::audio_core_internal
