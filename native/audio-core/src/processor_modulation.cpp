#include "audio_core_internal.h"

namespace daw::audio_core_internal {
namespace {

using namespace daw::audio_core;

// The three Safe Bass / Width / Output targets sit together after each kind's own targets.
ChorusValues delay_modulation_values(const Core &core, const GraphRevision::Processor &processor, uint32_t frame) {
  const daw_audio_delay_modulation_state &state = processor.delay_modulation;
  const bool chorus = processor.kind == DAW_AUDIO_PROCESSOR_KIND_CHORUS;
  const uint32_t base = chorus ? DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_DELAY_MS : DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_DELAY_MS;
  const uint32_t finish = chorus ? DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_SAFE_BASS_HZ : DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_SAFE_BASS_HZ;
  const auto value = [&](uint32_t target, float fallback) { return processor_parameter_value(core, processor, target, frame, fallback); };
  return {
    .delay_ms = value(base, state.delay_ms),
    .depth_ms = value(base + 1, state.depth_ms),
    .rate_hz = value(base + 2, state.rate_hz),
    .feedback = value(base + 3, state.feedback),
    .stereo_phase = value(base + 4, state.stereo_phase),
    .mix = value(base + 5, state.mix),
    .safe_bass_hz = value(finish, state.safe_bass_hz),
    .width = value(finish + 1, state.width),
    .output_db = value(finish + 2, state.output_db),
  };
}

EnsembleValues ensemble_values(const Core &core, const GraphRevision::Processor &processor, uint32_t frame) {
  const daw_audio_ensemble_state &state = processor.ensemble;
  const auto value = [&](uint32_t target, float fallback) { return processor_parameter_value(core, processor, target, frame, fallback); };
  return {
    .delay_ms = value(DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_DELAY_MS, state.delay_ms),
    .depth_ms = value(DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_DEPTH_MS, state.depth_ms),
    .rate_hz = value(DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_RATE_HZ, state.rate_hz),
    .spread = value(DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_SPREAD, state.spread),
    .mix = value(DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_MIX, state.mix),
    .fast_depth_ms = value(DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_FAST_DEPTH_MS, state.fast_depth_ms),
    .fast_rate_hz = value(DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_FAST_RATE_HZ, state.fast_rate_hz),
    .safe_bass_hz = value(DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_SAFE_BASS_HZ, state.safe_bass_hz),
    .width = value(DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_WIDTH, state.width),
    .output_db = value(DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_OUTPUT_DB, state.output_db),
  };
}

PhaserValues phaser_values(const Core &core, const GraphRevision::Processor &processor, uint32_t frame) {
  const daw_audio_phaser_state &state = processor.phaser;
  const auto value = [&](uint32_t target, float fallback) { return processor_parameter_value(core, processor, target, frame, fallback); };
  return {
    .center_hz = value(DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_CENTER_HZ, state.center_hz),
    .depth_octaves = value(DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_DEPTH_OCTAVES, state.depth_octaves),
    .rate_hz = value(DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_RATE_HZ, state.rate_hz),
    .feedback = value(DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_FEEDBACK, state.feedback),
    .stereo_phase = value(DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_STEREO_PHASE, state.stereo_phase),
    .mix = value(DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_MIX, state.mix),
    .spread_octaves = value(DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_SPREAD_OCTAVES, state.spread_octaves),
    .blend = value(DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_BLEND, state.blend),
    .safe_bass_hz = value(DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_SAFE_BASS_HZ, state.safe_bass_hz),
    .output_db = value(DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_OUTPUT_DB, state.output_db),
  };
}

AmplitudeValues amplitude_values(const Core &core, const GraphRevision::Processor &processor, uint32_t frame) {
  const daw_audio_amplitude_modulation_state &state = processor.amplitude_modulation;
  const bool tremolo = processor.kind == DAW_AUDIO_PROCESSOR_KIND_TREMOLO;
  const uint32_t base = tremolo ? DAW_AUDIO_PROCESSOR_PARAMETER_TREMOLO_RATE_HZ : DAW_AUDIO_PROCESSOR_PARAMETER_AUTOPAN_RATE_HZ;
  const uint32_t stereo = tremolo ? DAW_AUDIO_PROCESSOR_PARAMETER_TREMOLO_STEREO_PHASE : DAW_AUDIO_PROCESSOR_PARAMETER_AUTOPAN_STEREO_PHASE;
  const auto value = [&](uint32_t target, float fallback) { return processor_parameter_value(core, processor, target, frame, fallback); };
  return {
    .rate_hz = value(base, state.rate_hz),
    .depth = value(base + 1, state.depth),
    .shape = value(base + 2, state.shape),
    .phase = value(base + 3, state.phase),
    .stereo_phase = value(stereo, state.stereo_phase),
  };
}
}  // namespace

bool is_modulation_kind(uint32_t kind) {
  return kind == DAW_AUDIO_PROCESSOR_KIND_CHORUS || kind == DAW_AUDIO_PROCESSOR_KIND_FLANGER
    || kind == DAW_AUDIO_PROCESSOR_KIND_ENSEMBLE || kind == DAW_AUDIO_PROCESSOR_KIND_PHASER
    || kind == DAW_AUDIO_PROCESSOR_KIND_TREMOLO || kind == DAW_AUDIO_PROCESSOR_KIND_AUTOPAN;
}

void prepare_modulation_history(ModulationHistory &history, uint32_t kind, uint32_t sample_rate_hz) {
  const double rate = static_cast<double>(sample_rate_hz);
  if (kind == DAW_AUDIO_PROCESSOR_KIND_CHORUS || kind == DAW_AUDIO_PROCESSOR_KIND_FLANGER) history.chorus.prepare(rate);
  else if (kind == DAW_AUDIO_PROCESSOR_KIND_ENSEMBLE) history.ensemble.prepare(rate);
  else if (kind == DAW_AUDIO_PROCESSOR_KIND_PHASER) history.phaser.prepare(rate);
  else history.amplitude.prepare(rate);
}

void render_modulation_processor(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float, float, float *output_left, float *output_right) {
  ModulationHistory &history = core.modulation_histories[processor.history_slot];
  const auto off = [&](uint32_t enabled) { return processor.bypassed != 0 || enabled == 0; };
  switch (processor.kind) {
    case DAW_AUDIO_PROCESSOR_KIND_CHORUS:
    case DAW_AUDIO_PROCESSOR_KIND_FLANGER: {
      const daw_audio_delay_modulation_state &state = processor.delay_modulation;
      advance_bypass(core, history.bypass, off(state.enabled));
      history.chorus.process(delay_modulation_values(core, processor, frame),
        {.mode = static_cast<ChorusMode>(state.mode), .waveform = state.waveform, .safe_bass = state.safe_bass != 0},
        history.bypass, input_left, input_right, *output_left, *output_right);
      return;
    }
    case DAW_AUDIO_PROCESSOR_KIND_ENSEMBLE: {
      const daw_audio_ensemble_state &state = processor.ensemble;
      advance_bypass(core, history.bypass, off(state.enabled));
      history.ensemble.process(ensemble_values(core, processor, frame), {.waveform = state.waveform, .safe_bass = state.safe_bass != 0},
        history.bypass, input_left, input_right, *output_left, *output_right);
      return;
    }
    case DAW_AUDIO_PROCESSOR_KIND_PHASER: {
      const daw_audio_phaser_state &state = processor.phaser;
      advance_bypass(core, history.bypass, off(state.enabled));
      history.phaser.process(phaser_values(core, processor, frame),
        {.stages = state.stages, .waveform = state.waveform, .safe_bass = state.safe_bass != 0},
        history.bypass, input_left, input_right, *output_left, *output_right);
      return;
    }
    default: {
      const daw_audio_amplitude_modulation_state &state = processor.amplitude_modulation;
      advance_bypass(core, history.bypass, off(state.enabled));
      // The wrapped project frame keeps a looped song's LFO on its bar; the block's start is where a mid-block loop wrap is ignored.
      const dsp::LfoTransport transport{
        .tempo_bpm = core.transport.tempo_bpm,
        .frame = project_time_frame(core) + static_cast<int64_t>(frame),
        .running = core.transport.running != 0,
      };
      history.amplitude.process(amplitude_values(core, processor, frame),
        {.kind = processor.kind == DAW_AUDIO_PROCESSOR_KIND_TREMOLO ? AmplitudeKind::Tremolo : AmplitudeKind::AutoPan,
          .waveform = state.waveform, .division = state.division, .sync = state.sync != 0, .invert = state.invert != 0},
        transport, history.bypass, input_left, input_right, *output_left, *output_right);
    }
  }
}
}  // namespace daw::audio_core_internal
