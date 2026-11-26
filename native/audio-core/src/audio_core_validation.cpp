#include "audio_core_internal.h"

namespace daw::audio_core_internal {

bool valid_synth_state(const daw_audio_synth_state &state) {
  if (state.version != 1 || state.seed == 0 || state.noise_enabled > 1 || state.filter_enabled > 1
    || state.filter_mode > DAW_AUDIO_SYNTH_FILTER_MODE_NOTCH || state.lfo_enabled > 1
    || state.lfo_waveform > DAW_AUDIO_SYNTH_WAVEFORM_TRIANGLE
    || !std::isfinite(state.noise_level) || state.noise_level < 0.0F || state.noise_level > 1.0F
    || !std::isfinite(state.filter_cutoff_hz) || state.filter_cutoff_hz < 20.0F || state.filter_cutoff_hz > 20000.0F
    || !std::isfinite(state.filter_resonance) || state.filter_resonance < 0.0001F || state.filter_resonance > 30.0F
    || !std::isfinite(state.filter_key_tracking) || state.filter_key_tracking < 0.0F || state.filter_key_tracking > 1.0F
    || !std::isfinite(state.filter_envelope_amount_octaves) || state.filter_envelope_amount_octaves < -6.0F || state.filter_envelope_amount_octaves > 6.0F
    || !std::isfinite(state.filter_attack_ms) || state.filter_attack_ms < 0.0F || state.filter_attack_ms > 60000.0F
    || !std::isfinite(state.filter_decay_ms) || state.filter_decay_ms < 0.0F || state.filter_decay_ms > 60000.0F
    || !std::isfinite(state.filter_sustain) || state.filter_sustain < 0.0F || state.filter_sustain > 1.0F
    || !std::isfinite(state.filter_release_ms) || state.filter_release_ms < 0.0F || state.filter_release_ms > 60000.0F
    || !std::isfinite(state.amp_attack_ms) || state.amp_attack_ms < 0.0F || state.amp_attack_ms > 60000.0F
    || !std::isfinite(state.amp_decay_ms) || state.amp_decay_ms < 0.0F || state.amp_decay_ms > 60000.0F
    || !std::isfinite(state.amp_sustain) || state.amp_sustain < 0.0F || state.amp_sustain > 1.0F
    || !std::isfinite(state.amp_release_ms) || state.amp_release_ms < 0.0F || state.amp_release_ms > 60000.0F
    || !std::isfinite(state.lfo_rate_hz) || state.lfo_rate_hz < 0.01F || state.lfo_rate_hz > 100.0F
    || !std::isfinite(state.lfo_pitch_cents) || state.lfo_pitch_cents < -1200.0F || state.lfo_pitch_cents > 1200.0F
    || !std::isfinite(state.lfo_filter_octaves) || state.lfo_filter_octaves < -6.0F || state.lfo_filter_octaves > 6.0F
    || !std::isfinite(state.lfo_amplitude) || state.lfo_amplitude < 0.0F || state.lfo_amplitude > 1.0F
    || !std::isfinite(state.lfo_pan) || state.lfo_pan < 0.0F || state.lfo_pan > 1.0F
    || !std::isfinite(state.output_gain) || state.output_gain < 0.0F || state.output_gain > 1.5F
    || !std::isfinite(state.output_pan) || state.output_pan < -1.0F || state.output_pan > 1.0F) return false;
  for (const daw_audio_synth_oscillator_state &oscillator : state.oscillators) {
    if (oscillator.enabled > 1 || oscillator.waveform > DAW_AUDIO_SYNTH_WAVEFORM_TRIANGLE
      || !std::isfinite(oscillator.level) || oscillator.level < 0.0F || oscillator.level > 1.0F
      || oscillator.octave < -3 || oscillator.octave > 3 || oscillator.semitone < -12 || oscillator.semitone > 12
      || !std::isfinite(oscillator.detune_cents) || oscillator.detune_cents < -100.0F || oscillator.detune_cents > 100.0F) return false;
  }
  return true;
}

bool valid_sampler_state(const daw_audio_sampler_state &state) {
  return state.version == 1 && state.zone_count <= DAW_AUDIO_CORE_MAX_SAMPLE_ZONES
    && std::isfinite(state.amp_attack_ms) && state.amp_attack_ms >= 0.0F && state.amp_attack_ms <= 60000.0F
    && std::isfinite(state.amp_decay_ms) && state.amp_decay_ms >= 0.0F && state.amp_decay_ms <= 60000.0F
    && std::isfinite(state.amp_sustain) && state.amp_sustain >= 0.0F && state.amp_sustain <= 1.0F
    && std::isfinite(state.amp_release_ms) && state.amp_release_ms >= 0.0F && state.amp_release_ms <= 60000.0F
    && state.filter_enabled <= 1 && state.filter_mode <= DAW_AUDIO_SYNTH_FILTER_MODE_NOTCH
    && std::isfinite(state.filter_cutoff_hz) && state.filter_cutoff_hz >= 20.0F && state.filter_cutoff_hz <= 20000.0F
    && std::isfinite(state.filter_resonance) && state.filter_resonance >= 0.0001F && state.filter_resonance <= 30.0F
    && std::isfinite(state.filter_envelope_amount) && state.filter_envelope_amount >= -1.0F && state.filter_envelope_amount <= 1.0F
    && std::isfinite(state.filter_attack_ms) && state.filter_attack_ms >= 0.0F && state.filter_attack_ms <= 60000.0F
    && std::isfinite(state.filter_decay_ms) && state.filter_decay_ms >= 0.0F && state.filter_decay_ms <= 60000.0F
    && std::isfinite(state.filter_sustain) && state.filter_sustain >= 0.0F && state.filter_sustain <= 1.0F
    && std::isfinite(state.filter_release_ms) && state.filter_release_ms >= 0.0F && state.filter_release_ms <= 60000.0F
    && state.lfo_enabled <= 1
    && std::isfinite(state.lfo_rate_hz) && state.lfo_rate_hz >= 0.01F && state.lfo_rate_hz <= 100.0F
    && std::isfinite(state.lfo_pitch_cents) && state.lfo_pitch_cents >= -2400.0F && state.lfo_pitch_cents <= 2400.0F
    && std::isfinite(state.lfo_filter_hz) && state.lfo_filter_hz >= -20000.0F && state.lfo_filter_hz <= 20000.0F
    && std::isfinite(state.lfo_amplitude) && state.lfo_amplitude >= 0.0F && state.lfo_amplitude <= 1.0F
    && std::isfinite(state.lfo_pan) && state.lfo_pan >= 0.0F && state.lfo_pan <= 1.0F
    && state.retrigger <= 1;
}

bool valid_granular_state(Core &core, const daw_audio_granular_state &state) {
  const AssetSlot *asset = state.asset == 0 ? nullptr : find_asset(&core, state.asset);
  return state.version == 1 && (state.asset == 0 || (asset != nullptr && !asset->paged)) && state.seed != 0
    && state.max_grains > 0 && state.max_grains <= DAW_AUDIO_CORE_MAX_GRANULAR_GRAINS
    && state.window_shape <= DAW_AUDIO_GRANULAR_WINDOW_GAUSSIAN && state.freeze <= 1
    && std::isfinite(state.grain_size_ms) && state.grain_size_ms >= 5.0F && state.grain_size_ms <= 1000.0F
    && std::isfinite(state.density_hz) && state.density_hz >= 0.25F && state.density_hz <= 200.0F
    && std::isfinite(state.position) && state.position >= 0.0F && state.position <= 1.0F
    && std::isfinite(state.spray) && state.spray >= 0.0F && state.spray <= 1.0F
    && std::isfinite(state.pitch_semitones) && state.pitch_semitones >= -48.0F && state.pitch_semitones <= 48.0F
    && std::isfinite(state.reverse_probability) && state.reverse_probability >= 0.0F && state.reverse_probability <= 1.0F
    && std::isfinite(state.stereo_spread) && state.stereo_spread >= 0.0F && state.stereo_spread <= 1.0F;
}

bool valid_sample_zone(Core &core, const daw_audio_sample_zone &zone) {
  AssetSlot *asset = find_asset(&core, zone.asset);
  return asset != nullptr && !asset->paged && zone.key_low <= zone.key_high && zone.key_high <= 127
    && zone.velocity_low > 0 && zone.velocity_low <= zone.velocity_high && zone.velocity_high <= 127
    && zone.root_note <= 127 && std::isfinite(zone.tune_cents) && zone.tune_cents >= -4800.0F && zone.tune_cents <= 4800.0F
    && std::isfinite(zone.gain) && zone.gain >= 0.0F && zone.gain <= 4.0F
    && std::isfinite(zone.pan) && zone.pan >= -1.0F && zone.pan <= 1.0F
    && zone.playback_mode <= DAW_AUDIO_SAMPLE_PLAYBACK_CROSSFADE_LOOP
    && zone.start_frame < zone.end_frame && zone.end_frame <= asset->frame_count
    && (zone.playback_mode == DAW_AUDIO_SAMPLE_PLAYBACK_ONE_SHOT
      || (zone.loop_start_frame >= zone.start_frame && zone.loop_start_frame < zone.loop_end_frame && zone.loop_end_frame <= zone.end_frame
        && zone.crossfade_frame_count <= (zone.loop_end_frame - zone.loop_start_frame) / 2));
}

bool valid_instrument_descriptor(const daw_audio_graph_node_descriptor &node) {
  const daw_audio_instrument_state_descriptor &instrument = node.instrument;
  if (node.kind != DAW_AUDIO_GRAPH_NODE_INSTRUMENT) {
    return instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_NONE && instrument.version == 0
      && instrument.voice_capacity == 0 && instrument.parameter_count == 0;
  }
  if (node.input_layout != DAW_AUDIO_GRAPH_LAYOUT_STEREO || node.output_layout != DAW_AUDIO_GRAPH_LAYOUT_STEREO
    || node.input_bus != 0
    || instrument.version != 1 || instrument.voice_capacity == 0
    || instrument.voice_capacity > kMaximumInstrumentVoices
    || instrument.parameter_count > DAW_AUDIO_CORE_MAX_INSTRUMENT_PARAMETERS) return false;
  if (instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_SAMPLER || instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK
    || instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) {
    return instrument.parameter_count == 0;
  }
  if (instrument.kind != DAW_AUDIO_INSTRUMENT_KIND_SYNTH) return false;
  for (uint32_t index = 0; index < instrument.parameter_count; ++index) {
    const uint32_t target = instrument.parameter_targets[index];
    if (target < DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_GAIN || target > DAW_AUDIO_SYNTH_PARAMETER_AMP_RELEASE_MS) return false;
    for (uint32_t previous = 0; previous < index; ++previous) {
      if (instrument.parameter_targets[previous] == target) return false;
    }
  }
  return true;
}
}  // namespace daw::audio_core_internal

namespace {

float read_f32_le(const uint8_t *input) {
  const uint32_t bits = read_u32_le(input);
  float value = 0.0F;
  static_assert(sizeof(value) == sizeof(bits));
  __builtin_memcpy(&value, &bits, sizeof(value));
  return value;
}
}  // namespace

namespace daw::audio_core_internal {

bool valid_utility_state(const daw_audio_utility_state &state) {
  return (state.enabled == 0 || state.enabled == 1)
    && std::isfinite(state.gain_db)
    && state.gain_db >= DAW_AUDIO_CORE_UTILITY_GAIN_DB_MIN
    && state.gain_db <= DAW_AUDIO_CORE_UTILITY_GAIN_DB_MAX
    && (state.polarity == DAW_AUDIO_UTILITY_POLARITY_NORMAL || state.polarity == DAW_AUDIO_UTILITY_POLARITY_INVERT)
    && (state.input_mode == DAW_AUDIO_UTILITY_INPUT_MODE_STEREO || state.input_mode == DAW_AUDIO_UTILITY_INPUT_MODE_MONO_SUM)
    && std::isfinite(state.pan)
    && state.pan >= DAW_AUDIO_CORE_UTILITY_PAN_MIN
    && state.pan <= DAW_AUDIO_CORE_UTILITY_PAN_MAX
    && std::isfinite(state.balance)
    && state.balance >= DAW_AUDIO_CORE_UTILITY_BALANCE_MIN
    && state.balance <= DAW_AUDIO_CORE_UTILITY_BALANCE_MAX
    && std::isfinite(state.width)
    && state.width >= DAW_AUDIO_CORE_UTILITY_WIDTH_MIN
    && state.width <= DAW_AUDIO_CORE_UTILITY_WIDTH_MAX
    && (state.matrix == DAW_AUDIO_UTILITY_MATRIX_STEREO
      || state.matrix == DAW_AUDIO_UTILITY_MATRIX_MID_SIDE_ENCODE
      || state.matrix == DAW_AUDIO_UTILITY_MATRIX_MID_SIDE_DECODE)
    && (state.swap == 0 || state.swap == 1)
    && (state.dc_block == 0 || state.dc_block == 1);
}
}  // namespace daw::audio_core_internal

namespace {

bool valid_saturator_state(const daw_audio_saturator_state &state) {
  return (state.enabled == 0 || state.enabled == 1)
    && std::isfinite(state.drive_db) && state.drive_db >= 0.0F && state.drive_db <= 36.0F
    && state.curve <= DAW_AUDIO_SATURATOR_CURVE_CLIP
    && (state.color == 0 || state.color == 1)
    && std::isfinite(state.color_frequency_hz) && state.color_frequency_hz >= 100.0F && state.color_frequency_hz <= 10000.0F
    && std::isfinite(state.color_amount) && state.color_amount >= 0.0F && state.color_amount <= 1.0F
    && std::isfinite(state.output_db) && state.output_db >= -24.0F && state.output_db <= 12.0F
    && std::isfinite(state.dry_wet) && state.dry_wet >= 0.0F && state.dry_wet <= 1.0F;
}

bool valid_eq_band(const daw_audio_eq_band_state &band) {
  return (band.enabled == 0 || band.enabled == 1)
    && band.type <= DAW_AUDIO_EQ_BAND_HIGHPASS_48
    && std::isfinite(band.frequency_hz) && band.frequency_hz >= 20.0F && band.frequency_hz <= 20000.0F
    && std::isfinite(band.gain_db) && band.gain_db >= -24.0F && band.gain_db <= 24.0F
    && std::isfinite(band.q) && band.q >= 0.2F && band.q <= 18.0F;
}

bool valid_eq_state(const daw_audio_eq_state &state) {
  if ((state.enabled != 0 && state.enabled != 1) || state.mode > DAW_AUDIO_EQ_MODE_MID_SIDE
    || state.adaptive_q > 1 || state.high_quality > 1
    || !std::isfinite(state.scale) || state.scale < 0.0F || state.scale > DAW_AUDIO_CORE_EQ_SCALE_MAX
    || !std::isfinite(state.output_db) || std::fabs(state.output_db) > DAW_AUDIO_CORE_EQ_OUTPUT_DB_MAX) return false;
  for (const daw_audio_eq_band_state &band : state.bands) {
    if (!valid_eq_band(band)) return false;
  }
  return true;
}

bool valid_delay_modulation_state(const daw_audio_delay_modulation_state &state, bool chorus) {
  return (state.enabled == 0 || state.enabled == 1)
    && std::isfinite(state.delay_ms) && state.delay_ms >= (chorus ? 5.0F : 0.1F) && state.delay_ms <= (chorus ? 30.0F : 10.0F)
    && std::isfinite(state.depth_ms) && state.depth_ms >= 0.0F && state.depth_ms <= (chorus ? 10.0F : 5.0F)
    && std::isfinite(state.rate_hz) && state.rate_hz >= 0.01F && state.rate_hz <= 20.0F
    && std::isfinite(state.feedback) && state.feedback >= (chorus ? 0.0F : -0.95F) && state.feedback <= (chorus ? 0.5F : 0.95F)
    && std::isfinite(state.stereo_phase) && state.stereo_phase >= -0.5F && state.stereo_phase <= 0.5F
    && std::isfinite(state.mix) && state.mix >= 0.0F && state.mix <= 1.0F;
}

bool valid_phaser_state(const daw_audio_phaser_state &state) {
  return (state.enabled == 0 || state.enabled == 1)
    && (state.stages == 4 || state.stages == 6 || state.stages == 8 || state.stages == 12)
    && std::isfinite(state.center_hz) && state.center_hz >= 100.0F && state.center_hz <= 8000.0F
    && std::isfinite(state.depth_octaves) && state.depth_octaves >= 0.0F && state.depth_octaves <= 5.0F
    && std::isfinite(state.rate_hz) && state.rate_hz >= 0.01F && state.rate_hz <= 20.0F
    && std::isfinite(state.feedback) && state.feedback >= -0.95F && state.feedback <= 0.95F
    && std::isfinite(state.stereo_phase) && state.stereo_phase >= -0.5F && state.stereo_phase <= 0.5F
    && std::isfinite(state.mix) && state.mix >= 0.0F && state.mix <= 1.0F;
}

bool valid_amplitude_modulation_state(const daw_audio_amplitude_modulation_state &state) {
  return (state.enabled == 0 || state.enabled == 1) && state.waveform <= 1
    && std::isfinite(state.rate_hz) && state.rate_hz >= 0.01F && state.rate_hz <= 20.0F
    && std::isfinite(state.depth) && state.depth >= 0.0F && state.depth <= 1.0F
    && std::isfinite(state.shape) && state.shape >= 0.0F && state.shape <= 1.0F
    && std::isfinite(state.phase) && state.phase >= 0.0F && state.phase <= 1.0F;
}

bool valid_ensemble_state(const daw_audio_ensemble_state &state) {
  return (state.enabled == 0 || state.enabled == 1) && state.voices == 3
    && std::isfinite(state.delay_ms) && state.delay_ms >= 10.0F && state.delay_ms <= 30.0F
    && std::isfinite(state.depth_ms) && state.depth_ms >= 1.0F && state.depth_ms <= 12.0F
    && std::isfinite(state.rate_hz) && state.rate_hz >= 0.05F && state.rate_hz <= 5.0F
    && std::isfinite(state.spread) && state.spread >= 0.0F && state.spread <= 1.0F
    && std::isfinite(state.mix) && state.mix >= 0.0F && state.mix <= 1.0F;
}

bool valid_gate_state(const daw_audio_gate_state &state) {
  return state.enabled <= 1 && state.mode <= 1
    && std::isfinite(state.threshold_db) && state.threshold_db >= -80.0F && state.threshold_db <= 0.0F
    && std::isfinite(state.ratio) && state.ratio >= 1.0F && state.ratio <= 20.0F
    && std::isfinite(state.attack_ms) && state.attack_ms >= 0.1F && state.attack_ms <= 100.0F
    && std::isfinite(state.hold_ms) && state.hold_ms >= 0.0F && state.hold_ms <= 500.0F
    && std::isfinite(state.release_ms) && state.release_ms >= 5.0F && state.release_ms <= 2000.0F
    && std::isfinite(state.hysteresis_db) && state.hysteresis_db >= 0.0F && state.hysteresis_db <= 24.0F
    && std::isfinite(state.range_db) && state.range_db >= -80.0F && state.range_db <= 0.0F
    && (state.lookahead_ms == 0.0F || state.lookahead_ms == 1.0F || state.lookahead_ms == 10.0F)
    && state.detector <= 1 && std::isfinite(state.link) && state.link >= 0.0F && state.link <= 1.0F
    && state.sidechain_enabled <= 1 && std::isfinite(state.sidechain_frequency_hz)
    && state.sidechain_frequency_hz >= 20.0F && state.sidechain_frequency_hz <= 20000.0F
    && std::isfinite(state.sidechain_q) && state.sidechain_q >= 0.1F && state.sidechain_q <= 18.0F
    && state.flip <= 1 && state.sidechain_filter_type <= 2
    && std::isfinite(state.sidechain_gain_db) && state.sidechain_gain_db >= DAW_AUDIO_CORE_GATE_SIDECHAIN_GAIN_DB_MIN && state.sidechain_gain_db <= DAW_AUDIO_CORE_GATE_SIDECHAIN_GAIN_DB_MAX
    && std::isfinite(state.sidechain_mix) && state.sidechain_mix >= DAW_AUDIO_CORE_GATE_SIDECHAIN_MIX_MIN && state.sidechain_mix <= DAW_AUDIO_CORE_GATE_SIDECHAIN_MIX_MAX;
}

bool valid_compressor_state(const daw_audio_compressor_state &state) {
  return state.enabled <= 1 && std::isfinite(state.threshold_db) && state.threshold_db >= -60.0F && state.threshold_db <= 0.0F
    && std::isfinite(state.ratio) && state.ratio >= 1.0F && state.ratio <= 100.0F
    && std::isfinite(state.attack_ms) && state.attack_ms >= 0.1F && state.attack_ms <= 100.0F
    && std::isfinite(state.release_ms) && state.release_ms >= 5.0F && state.release_ms <= 1000.0F
    && state.auto_release <= 1 && std::isfinite(state.makeup_db) && state.makeup_db >= -36.0F && state.makeup_db <= 36.0F
    && std::isfinite(state.output_db) && state.output_db >= -36.0F && state.output_db <= 36.0F
    && std::isfinite(state.dry_wet) && state.dry_wet >= 0.0F && state.dry_wet <= 1.0F
    && std::isfinite(state.knee_db) && state.knee_db >= 0.0F && state.knee_db <= 24.0F
    && (state.lookahead_ms == 0.0F || state.lookahead_ms == 1.0F || state.lookahead_ms == 10.0F) && state.auto_makeup <= 1
    && state.detector_mode <= 1 && state.dynamics_mode <= 1 && state.envelope_curve <= 1 && state.sidechain_enabled <= 1
    && state.sidechain_filter_type <= 2 && std::isfinite(state.sidechain_frequency_hz)
    && state.sidechain_frequency_hz >= 20.0F && state.sidechain_frequency_hz <= 20000.0F
    && std::isfinite(state.sidechain_q) && state.sidechain_q >= 0.1F && state.sidechain_q <= 18.0F;
}

bool valid_limiter_state(const daw_audio_limiter_state &state) {
  return state.enabled <= 1 && std::isfinite(state.ceiling_dbtp) && state.ceiling_dbtp >= -12.0F && state.ceiling_dbtp <= 0.0F
    && std::isfinite(state.release_ms) && state.release_ms >= 20.0F && state.release_ms <= 1000.0F
    && (state.lookahead_ms == 1.5F || state.lookahead_ms == 3.0F || state.lookahead_ms == 6.0F)
    && std::isfinite(state.link) && state.link >= 0.0F && state.link <= 1.0F && state.auto_release <= 1
    && std::isfinite(state.gain_db) && state.gain_db >= DAW_AUDIO_CORE_LIMITER_GAIN_DB_MIN && state.gain_db <= DAW_AUDIO_CORE_LIMITER_GAIN_DB_MAX;
}

bool valid_delay_state(const daw_audio_delay_state &state) {
  return state.enabled <= 1 && std::isfinite(state.delay_ms) && state.delay_ms >= DAW_AUDIO_CORE_DELAY_TIME_MS_MIN && state.delay_ms <= DAW_AUDIO_CORE_DELAY_TIME_MS_MAX
    && std::isfinite(state.feedback) && state.feedback >= 0.0F && state.feedback <= 0.95F
    && std::isfinite(state.dry_wet) && state.dry_wet >= 0.0F && state.dry_wet <= 1.0F
    && state.ping_pong <= 1 && state.filter_enabled <= 1
    && std::isfinite(state.low_cut_hz) && state.low_cut_hz >= 20.0F && state.low_cut_hz <= 2000.0F
    && std::isfinite(state.high_cut_hz) && state.high_cut_hz >= 1000.0F && state.high_cut_hz <= 20000.0F
    && state.high_cut_hz >= state.low_cut_hz;
}

bool valid_reverb_state(const daw_audio_reverb_state &state) {
  return state.enabled <= 1 && std::isfinite(state.wet) && state.wet >= 0.0F && state.wet <= 1.0F
    && std::isfinite(state.decay_sec) && state.decay_sec >= 0.05F && state.decay_sec <= 12.0F
    && std::isfinite(state.pre_delay_ms) && state.pre_delay_ms >= 0.0F && state.pre_delay_ms <= 250.0F
    && std::isfinite(state.reflections) && state.reflections >= 0.0F && state.reflections <= 1.0F
    && state.reflection_spin <= 1 && std::isfinite(state.reflection_mod_amount_ms)
    && state.reflection_mod_amount_ms >= 0.0F && state.reflection_mod_amount_ms <= 25.0F
    && std::isfinite(state.reflection_mod_rate_hz) && state.reflection_mod_rate_hz >= 0.01F && state.reflection_mod_rate_hz <= 5.0F
    && std::isfinite(state.reflection_shape) && state.reflection_shape >= 0.0F && state.reflection_shape <= 1.0F
    && std::isfinite(state.diffuse) && state.diffuse >= 0.0F && state.diffuse <= 1.0F
    && std::isfinite(state.size) && state.size >= 0.0F && state.size <= 1.0F
    && std::isfinite(state.diffusion) && state.diffusion >= 0.0F && state.diffusion <= 1.0F
    && state.density <= DAW_AUDIO_REVERB_DENSITY_HIGH
    && std::isfinite(state.low_cut_hz) && state.low_cut_hz >= 20.0F && state.low_cut_hz <= 1200.0F
    && std::isfinite(state.high_cut_hz) && state.high_cut_hz >= 1200.0F && state.high_cut_hz <= 20000.0F
    && std::isfinite(state.low_shelf_hz) && state.low_shelf_hz >= 20.0F && state.low_shelf_hz <= 1200.0F
    && std::isfinite(state.high_shelf_hz) && state.high_shelf_hz >= 1200.0F && state.high_shelf_hz <= 20000.0F
    && std::isfinite(state.stereo_width) && state.stereo_width >= 0.0F && state.stereo_width <= 120.0F
    && state.smooth <= DAW_AUDIO_REVERB_SMOOTH_FAST && state.freeze <= 1 && state.flat <= 1 && state.cut <= 1 && state.chorus <= 1
    && std::isfinite(state.chorus_amount_ms) && state.chorus_amount_ms >= 0.0F && state.chorus_amount_ms <= 5.0F
    && std::isfinite(state.chorus_rate_hz) && state.chorus_rate_hz >= 0.01F && state.chorus_rate_hz <= 5.0F
    && state.low_shelf_on <= 1 && state.high_shelf_on <= 1
    && std::isfinite(state.low_shelf_db) && state.low_shelf_db >= -24.0F && state.low_shelf_db <= 12.0F
    && std::isfinite(state.high_shelf_db) && state.high_shelf_db >= -24.0F && state.high_shelf_db <= 12.0F;
}

bool valid_spectral_state(const daw_audio_spectral_state &state) {
  return state.enabled <= 1
    && (state.fft_size == 512 || state.fft_size == 1024 || state.fft_size == 2048 || state.fft_size == 4096)
    && (state.overlap == 2 || state.overlap == 4)
    && state.mode <= DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE
    && std::isfinite(state.freeze) && state.freeze >= 0.0F && state.freeze <= 1.0F
    && std::isfinite(state.gate_threshold_db) && state.gate_threshold_db >= -120.0F && state.gate_threshold_db <= 0.0F
    && std::isfinite(state.gate_attack_ms) && state.gate_attack_ms >= 0.1F && state.gate_attack_ms <= 1000.0F
    && std::isfinite(state.gate_release_ms) && state.gate_release_ms >= 1.0F && state.gate_release_ms <= 5000.0F
    && std::isfinite(state.morph) && state.morph >= 0.0F && state.morph <= 1.0F
    && std::isfinite(state.bin_shift) && state.bin_shift >= -2048.0F && state.bin_shift <= 2048.0F
    && std::isfinite(state.blur) && state.blur >= 0.0F && state.blur <= 1.0F
    && std::isfinite(state.harmonic_percussive_balance) && state.harmonic_percussive_balance >= -1.0F && state.harmonic_percussive_balance <= 1.0F
    && std::isfinite(state.noise_reduction) && state.noise_reduction >= 0.0F && state.noise_reduction <= 1.0F
    && std::isfinite(state.profile_learn) && state.profile_learn >= 0.0F && state.profile_learn <= 1.0F
    && std::isfinite(state.mix) && state.mix >= 0.0F && state.mix <= 1.0F;
}

bool valid_autofilter_state(const daw_audio_autofilter_state &state) {
  return state.enabled <= 1 && state.mode <= DAW_AUDIO_AUTOFILTER_MODE_PEAK && state.hi_quality <= 1
    && state.slope <= 1 && state.clip <= 1 && state.envelope_hold <= 1 && state.envelope_link <= 1 && state.lfo_sync <= 1
    && state.lfo_division < daw::audio_core::AutoFilterKernel::kDivisionCount && state.lfo_stereo_mode <= 1
    && std::isfinite(state.output_db) && state.output_db >= -24.0F && state.output_db <= 24.0F
    && std::isfinite(state.frequency_hz) && state.frequency_hz >= 20.0F && state.frequency_hz <= 20000.0F
    && std::isfinite(state.resonance) && state.resonance >= 0.0F && state.resonance <= 1.0F
    && std::isfinite(state.drive_db) && state.drive_db >= 0.0F && state.drive_db <= 24.0F
    && std::isfinite(state.mix) && state.mix >= 0.0F && state.mix <= 1.0F
    && std::isfinite(state.envelope_amount_octaves) && state.envelope_amount_octaves >= -6.0F && state.envelope_amount_octaves <= 6.0F
    && std::isfinite(state.envelope_attack_ms) && state.envelope_attack_ms >= 0.5F && state.envelope_attack_ms <= 500.0F
    && std::isfinite(state.envelope_release_ms) && state.envelope_release_ms >= 5.0F && state.envelope_release_ms <= 2000.0F
    && state.lfo_waveform <= 5 && std::isfinite(state.lfo_rate_hz) && state.lfo_rate_hz >= 0.01F && state.lfo_rate_hz <= 20.0F
    && std::isfinite(state.lfo_depth_octaves) && state.lfo_depth_octaves >= 0.0F && state.lfo_depth_octaves <= 6.0F
    && std::isfinite(state.lfo_phase_offset) && state.lfo_phase_offset >= 0.0F && state.lfo_phase_offset <= 1.0F
    && std::isfinite(state.lfo_stereo_phase) && state.lfo_stereo_phase >= -0.5F && state.lfo_stereo_phase <= 0.5F;
}

bool valid_lofi_state(const daw_audio_lofi_state &state) {
  return state.enabled <= 1
    && state.bit_depth >= 2 && state.bit_depth <= 24
    && std::isfinite(state.sample_rate_ratio) && state.sample_rate_ratio >= 0.01F && state.sample_rate_ratio <= 1.0F
    && std::isfinite(state.jitter) && state.jitter >= 0.0F && state.jitter <= 1.0F
    && std::isfinite(state.noise_db) && state.noise_db >= -120.0F && state.noise_db <= -24.0F
    && state.quantization <= DAW_AUDIO_LOFI_QUANTIZATION_TRUNCATE
    && state.dither <= DAW_AUDIO_LOFI_DITHER_TRIANGULAR
    && std::isfinite(state.mix) && state.mix >= 0.0F && state.mix <= 1.0F
    && state.seed != 0;
}
}  // namespace

namespace daw::audio_core_internal {

bool decode_processor_state(
  const daw_audio_processor_descriptor &descriptor,
  uint32_t sample_rate_hz,
  GraphRevision::Processor *out_processor) {
  const double rate = static_cast<double>(sample_rate_hz);
  const ProcessorContract *contract = find_processor_contract(descriptor.kind);
  if (contract == nullptr || descriptor.state_version != contract->schema_version
    || descriptor.state == nullptr
    || !valid_processor_parameter_targets(descriptor)) return false;
  if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_UTILITY && descriptor.state_size == 40) {
    const daw_audio_utility_state state{
      .enabled = read_u32_le(descriptor.state), .gain_db = read_f32_le(descriptor.state + 4),
      .polarity = read_u32_le(descriptor.state + 8), .input_mode = read_u32_le(descriptor.state + 12),
      .pan = read_f32_le(descriptor.state + 16), .balance = read_f32_le(descriptor.state + 20),
      .width = read_f32_le(descriptor.state + 24), .matrix = read_u32_le(descriptor.state + 28),
      .swap = read_u32_le(descriptor.state + 32), .dc_block = read_u32_le(descriptor.state + 36),
    };
    if (!valid_utility_state(state)) return false;
    out_processor->utility = state;
    return true;
  }
  if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_SATURATOR && descriptor.state_size == 32) {
    const daw_audio_saturator_state state{
      .enabled = read_u32_le(descriptor.state), .drive_db = read_f32_le(descriptor.state + 4),
      .curve = read_u32_le(descriptor.state + 8), .color = read_u32_le(descriptor.state + 12),
      .color_frequency_hz = read_f32_le(descriptor.state + 16), .color_amount = read_f32_le(descriptor.state + 20),
      .output_db = read_f32_le(descriptor.state + 24), .dry_wet = read_f32_le(descriptor.state + 28),
    };
    if (!valid_saturator_state(state) || descriptor.latency_frames != 0
      || descriptor.tail_frames != 0) return false;
    out_processor->saturator = state;
    return true;
  }
  if ((descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_CHORUS || descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_FLANGER) && descriptor.state_size == 28) {
    const daw_audio_delay_modulation_state state{
      .enabled = read_u32_le(descriptor.state), .delay_ms = read_f32_le(descriptor.state + 4),
      .depth_ms = read_f32_le(descriptor.state + 8), .rate_hz = read_f32_le(descriptor.state + 12),
      .feedback = read_f32_le(descriptor.state + 16), .stereo_phase = read_f32_le(descriptor.state + 20), .mix = read_f32_le(descriptor.state + 24),
    };
    if (!valid_delay_modulation_state(state, descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_CHORUS)) return false;
    out_processor->delay_modulation = state;
    return true;
  }
  if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_PHASER && descriptor.state_size == 32) {
    const daw_audio_phaser_state state{
      .enabled = read_u32_le(descriptor.state), .stages = read_u32_le(descriptor.state + 4),
      .center_hz = read_f32_le(descriptor.state + 8), .depth_octaves = read_f32_le(descriptor.state + 12),
      .rate_hz = read_f32_le(descriptor.state + 16), .feedback = read_f32_le(descriptor.state + 20),
      .stereo_phase = read_f32_le(descriptor.state + 24), .mix = read_f32_le(descriptor.state + 28),
    };
    if (!valid_phaser_state(state)) return false;
    out_processor->phaser = state;
    return true;
  }
  if ((descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_TREMOLO || descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_AUTOPAN) && descriptor.state_size == 24) {
    const daw_audio_amplitude_modulation_state state{
      .enabled = read_u32_le(descriptor.state), .waveform = read_u32_le(descriptor.state + 4),
      .rate_hz = read_f32_le(descriptor.state + 8), .depth = read_f32_le(descriptor.state + 12),
      .shape = read_f32_le(descriptor.state + 16), .phase = read_f32_le(descriptor.state + 20),
    };
    if (!valid_amplitude_modulation_state(state)) return false;
    out_processor->amplitude_modulation = state;
    return true;
  }
  if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_ENSEMBLE && descriptor.state_size == 28) {
    const daw_audio_ensemble_state state{
      .enabled = read_u32_le(descriptor.state), .voices = read_u32_le(descriptor.state + 4),
      .delay_ms = read_f32_le(descriptor.state + 8), .depth_ms = read_f32_le(descriptor.state + 12),
      .rate_hz = read_f32_le(descriptor.state + 16), .spread = read_f32_le(descriptor.state + 20), .mix = read_f32_le(descriptor.state + 24),
    };
    if (!valid_ensemble_state(state)) return false;
    out_processor->ensemble = state;
    return true;
  }
  if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_GATE && descriptor.state_size == 76) {
    const daw_audio_gate_state state{
      .enabled = read_u32_le(descriptor.state), .mode = read_u32_le(descriptor.state + 4),
      .threshold_db = read_f32_le(descriptor.state + 8), .ratio = read_f32_le(descriptor.state + 12),
      .attack_ms = read_f32_le(descriptor.state + 16), .hold_ms = read_f32_le(descriptor.state + 20),
      .release_ms = read_f32_le(descriptor.state + 24), .hysteresis_db = read_f32_le(descriptor.state + 28),
      .range_db = read_f32_le(descriptor.state + 32), .lookahead_ms = read_f32_le(descriptor.state + 36),
      .detector = read_u32_le(descriptor.state + 40), .link = read_f32_le(descriptor.state + 44),
      .sidechain_enabled = read_u32_le(descriptor.state + 48), .sidechain_frequency_hz = read_f32_le(descriptor.state + 52),
      .sidechain_q = read_f32_le(descriptor.state + 56), .flip = read_u32_le(descriptor.state + 60),
      .sidechain_filter_type = read_u32_le(descriptor.state + 64), .sidechain_gain_db = read_f32_le(descriptor.state + 68),
      .sidechain_mix = read_f32_le(descriptor.state + 72),
    };
    if (!valid_gate_state(state)
      || descriptor.latency_frames != daw::audio_core::GateKernel::latency_frames(state.lookahead_ms, rate)) return false;
    out_processor->gate = state;
    return true;
  }
  if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_COMPRESSOR && descriptor.state_size == 76) {
    const daw_audio_compressor_state state{
      .enabled = read_u32_le(descriptor.state), .threshold_db = read_f32_le(descriptor.state + 4),
      .ratio = read_f32_le(descriptor.state + 8), .attack_ms = read_f32_le(descriptor.state + 12),
      .release_ms = read_f32_le(descriptor.state + 16), .auto_release = read_u32_le(descriptor.state + 20),
      .makeup_db = read_f32_le(descriptor.state + 24), .output_db = read_f32_le(descriptor.state + 28),
      .dry_wet = read_f32_le(descriptor.state + 32), .knee_db = read_f32_le(descriptor.state + 36),
      .lookahead_ms = read_f32_le(descriptor.state + 40), .detector_mode = read_u32_le(descriptor.state + 44),
      .dynamics_mode = read_u32_le(descriptor.state + 48), .envelope_curve = read_u32_le(descriptor.state + 52),
      .sidechain_enabled = read_u32_le(descriptor.state + 56), .sidechain_filter_type = read_u32_le(descriptor.state + 60),
      .sidechain_frequency_hz = read_f32_le(descriptor.state + 64), .sidechain_q = read_f32_le(descriptor.state + 68),
      .auto_makeup = read_u32_le(descriptor.state + 72),
    };
    if (!valid_compressor_state(state)
      || descriptor.latency_frames != daw::audio_core::CompressorKernel::latency_frames(state.lookahead_ms, rate)) return false;
    out_processor->compressor = state;
    return true;
  }
  if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_LIMITER && descriptor.state_size == 28) {
    const daw_audio_limiter_state state{
      .enabled = read_u32_le(descriptor.state), .ceiling_dbtp = read_f32_le(descriptor.state + 4),
      .release_ms = read_f32_le(descriptor.state + 8), .lookahead_ms = read_f32_le(descriptor.state + 12),
      .link = read_f32_le(descriptor.state + 16), .auto_release = read_u32_le(descriptor.state + 20),
      .gain_db = read_f32_le(descriptor.state + 24),
    };
    if (!valid_limiter_state(state)
      || descriptor.latency_frames != daw::audio_core::LimiterKernel::latency_frames(state.lookahead_ms, rate)) return false;
    out_processor->limiter = state;
    return true;
  }
  if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_DELAY && descriptor.state_size == 32) {
    const daw_audio_delay_state state{
      .enabled = read_u32_le(descriptor.state), .delay_ms = read_f32_le(descriptor.state + 4),
      .feedback = read_f32_le(descriptor.state + 8), .dry_wet = read_f32_le(descriptor.state + 12),
      .ping_pong = read_u32_le(descriptor.state + 16), .filter_enabled = read_u32_le(descriptor.state + 20),
      .low_cut_hz = read_f32_le(descriptor.state + 24), .high_cut_hz = read_f32_le(descriptor.state + 28),
    };
    if (!valid_delay_state(state)) return false;
    out_processor->delay = state;
    return true;
  }
  if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_REVERB && descriptor.state_size == 116) {
    const daw_audio_reverb_state state{
      .enabled = read_u32_le(descriptor.state), .wet = read_f32_le(descriptor.state + 4),
      .decay_sec = read_f32_le(descriptor.state + 8), .pre_delay_ms = read_f32_le(descriptor.state + 12),
      .reflections = read_f32_le(descriptor.state + 16), .reflection_spin = read_u32_le(descriptor.state + 20),
      .reflection_mod_amount_ms = read_f32_le(descriptor.state + 24), .reflection_mod_rate_hz = read_f32_le(descriptor.state + 28),
      .reflection_shape = read_f32_le(descriptor.state + 32), .diffuse = read_f32_le(descriptor.state + 36),
      .size = read_f32_le(descriptor.state + 40), .diffusion = read_f32_le(descriptor.state + 44),
      .density = read_u32_le(descriptor.state + 48), .low_cut_hz = read_f32_le(descriptor.state + 52),
      .high_cut_hz = read_f32_le(descriptor.state + 56), .low_shelf_hz = read_f32_le(descriptor.state + 60),
      .high_shelf_hz = read_f32_le(descriptor.state + 64), .stereo_width = read_f32_le(descriptor.state + 68),
      .smooth = read_u32_le(descriptor.state + 72), .freeze = read_u32_le(descriptor.state + 76),
      .flat = read_u32_le(descriptor.state + 80), .cut = read_u32_le(descriptor.state + 84),
      .chorus = read_u32_le(descriptor.state + 88), .chorus_amount_ms = read_f32_le(descriptor.state + 92),
      .chorus_rate_hz = read_f32_le(descriptor.state + 96), .low_shelf_on = read_u32_le(descriptor.state + 100),
      .high_shelf_on = read_u32_le(descriptor.state + 104), .low_shelf_db = read_f32_le(descriptor.state + 108),
      .high_shelf_db = read_f32_le(descriptor.state + 112),
    };
    if (!valid_reverb_state(state)) return false;
    out_processor->reverb = state;
    return true;
  }
  if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_SPECTRAL && descriptor.state_size == 60) {
    const daw_audio_spectral_state state{
      .enabled = read_u32_le(descriptor.state), .fft_size = read_u32_le(descriptor.state + 4),
      .overlap = read_u32_le(descriptor.state + 8), .mode = read_u32_le(descriptor.state + 12),
      .freeze = read_f32_le(descriptor.state + 16), .gate_threshold_db = read_f32_le(descriptor.state + 20),
      .gate_attack_ms = read_f32_le(descriptor.state + 24), .gate_release_ms = read_f32_le(descriptor.state + 28),
      .morph = read_f32_le(descriptor.state + 32), .bin_shift = read_f32_le(descriptor.state + 36),
      .blur = read_f32_le(descriptor.state + 40), .harmonic_percussive_balance = read_f32_le(descriptor.state + 44),
      .noise_reduction = read_f32_le(descriptor.state + 48), .profile_learn = read_f32_le(descriptor.state + 52),
      .mix = read_f32_le(descriptor.state + 56),
    };
    if (!valid_spectral_state(state) || descriptor.latency_frames != state.fft_size || descriptor.tail_frames != 0) return false;
    out_processor->spectral = state;
    return true;
  }
  if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_AUTOFILTER && descriptor.state_size == 92) {
    const daw_audio_autofilter_state state{
      .enabled = read_u32_le(descriptor.state), .mode = read_u32_le(descriptor.state + 4),
      .hi_quality = read_u32_le(descriptor.state + 8), .frequency_hz = read_f32_le(descriptor.state + 12),
      .resonance = read_f32_le(descriptor.state + 16), .drive_db = read_f32_le(descriptor.state + 20),
      .mix = read_f32_le(descriptor.state + 24), .envelope_amount_octaves = read_f32_le(descriptor.state + 28),
      .envelope_attack_ms = read_f32_le(descriptor.state + 32), .envelope_release_ms = read_f32_le(descriptor.state + 36),
      .lfo_waveform = read_u32_le(descriptor.state + 40), .lfo_rate_hz = read_f32_le(descriptor.state + 44),
      .lfo_depth_octaves = read_f32_le(descriptor.state + 48), .lfo_phase_offset = read_f32_le(descriptor.state + 52),
      .lfo_stereo_phase = read_f32_le(descriptor.state + 56), .slope = read_u32_le(descriptor.state + 60),
      .output_db = read_f32_le(descriptor.state + 64), .clip = read_u32_le(descriptor.state + 68),
      .envelope_hold = read_u32_le(descriptor.state + 72), .envelope_link = read_u32_le(descriptor.state + 76),
      .lfo_sync = read_u32_le(descriptor.state + 80), .lfo_division = read_u32_le(descriptor.state + 84),
      .lfo_stereo_mode = read_u32_le(descriptor.state + 88),
    };
    if (!valid_autofilter_state(state)
      || descriptor.latency_frames != daw::audio_core::AutoFilterKernel::latency_frames(state.hi_quality != 0)
      || descriptor.tail_frames != 0) return false;
    out_processor->autofilter = state;
    return true;
  }
  if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_LOFI && descriptor.state_size == 36) {
    const daw_audio_lofi_state state{
      .enabled = read_u32_le(descriptor.state), .bit_depth = read_u32_le(descriptor.state + 4),
      .sample_rate_ratio = read_f32_le(descriptor.state + 8), .jitter = read_f32_le(descriptor.state + 12),
      .noise_db = read_f32_le(descriptor.state + 16), .quantization = read_u32_le(descriptor.state + 20),
      .dither = read_u32_le(descriptor.state + 24), .mix = read_f32_le(descriptor.state + 28),
      .seed = read_u32_le(descriptor.state + 32),
    };
    if (!valid_lofi_state(state) || descriptor.latency_frames != 0 || descriptor.tail_frames != 0) return false;
    out_processor->lofi = state;
    return true;
  }
  if (descriptor.kind != DAW_AUDIO_PROCESSOR_KIND_EQ || descriptor.state_size != DAW_AUDIO_CORE_PROCESSOR_EQ_STATE_BYTES) return false;
  daw_audio_eq_state state{
    .enabled = read_u32_le(descriptor.state),
    .mode = read_u32_le(descriptor.state + 4),
    .adaptive_q = read_u32_le(descriptor.state + 8),
    .high_quality = read_u32_le(descriptor.state + 12),
    .scale = read_f32_le(descriptor.state + 16),
    .output_db = read_f32_le(descriptor.state + 20),
    .bands = {},
  };
  for (uint32_t index = 0; index < DAW_AUDIO_CORE_EQ_BAND_COUNT; ++index) {
    const uint32_t offset = 24 + index * 24;
    state.bands[index] = {
      .enabled = read_u32_le(descriptor.state + offset), .type = read_u32_le(descriptor.state + offset + 4),
      .frequency_hz = read_f32_le(descriptor.state + offset + 8), .gain_db = read_f32_le(descriptor.state + offset + 12),
      .q = read_f32_le(descriptor.state + offset + 16), .reserved = 0,
    };
  }
  if (!valid_eq_state(state) || descriptor.tail_frames != 0
    || descriptor.latency_frames != (state.high_quality != 0 ? DAW_AUDIO_CORE_EQ_HIGH_QUALITY_LATENCY_FRAMES : 0u)) return false;
  out_processor->eq = state;
  return true;
}

bool valid_processor_parameter_target(uint32_t kind, uint32_t target) {
  switch (kind) {
    case DAW_AUDIO_PROCESSOR_KIND_UTILITY:
      return target >= DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_WIDTH;
    case DAW_AUDIO_PROCESSOR_KIND_SATURATOR:
      return target >= DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_DRIVE_DB
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_DRY_WET;
    case DAW_AUDIO_PROCESSOR_KIND_EQ:
      return (target >= DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_TARGET_BASE
          && target <= DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_TARGET_LAST)
        || (target >= DAW_AUDIO_PROCESSOR_PARAMETER_EQ_SECOND_BAND_TARGET_BASE
          && target <= DAW_AUDIO_PROCESSOR_PARAMETER_EQ_OUTPUT_DB);
    case DAW_AUDIO_PROCESSOR_KIND_CHORUS:
      return target >= DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_DELAY_MS
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_MIX;
    case DAW_AUDIO_PROCESSOR_KIND_FLANGER:
      return target >= DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_DELAY_MS
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_MIX;
    case DAW_AUDIO_PROCESSOR_KIND_PHASER:
      return target >= DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_CENTER_HZ
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_MIX;
    case DAW_AUDIO_PROCESSOR_KIND_TREMOLO:
      return target >= DAW_AUDIO_PROCESSOR_PARAMETER_TREMOLO_RATE_HZ
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_TREMOLO_PHASE;
    case DAW_AUDIO_PROCESSOR_KIND_AUTOPAN:
      return target >= DAW_AUDIO_PROCESSOR_PARAMETER_AUTOPAN_RATE_HZ
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_AUTOPAN_PHASE;
    case DAW_AUDIO_PROCESSOR_KIND_ENSEMBLE:
      return target >= DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_DELAY_MS
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_MIX;
    case DAW_AUDIO_PROCESSOR_KIND_GATE:
      return (target >= DAW_AUDIO_PROCESSOR_PARAMETER_GATE_THRESHOLD_DB
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_GATE_RANGE_DB)
        || (target >= DAW_AUDIO_PROCESSOR_PARAMETER_GATE_LINK
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_GATE_SIDECHAIN_Q)
        || target == DAW_AUDIO_PROCESSOR_PARAMETER_GATE_SIDECHAIN_GAIN_DB
        || target == DAW_AUDIO_PROCESSOR_PARAMETER_GATE_SIDECHAIN_MIX;
    case DAW_AUDIO_PROCESSOR_KIND_COMPRESSOR:
      return (target >= DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_THRESHOLD_DB
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_KNEE_DB)
        || target == DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_SIDECHAIN_FREQUENCY_HZ
        || target == DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_SIDECHAIN_Q;
    case DAW_AUDIO_PROCESSOR_KIND_LIMITER:
      return (target >= DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_CEILING
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_RELEASE)
        || target == DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_LINK
        || target == DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_GAIN_DB;
    case DAW_AUDIO_PROCESSOR_KIND_DELAY:
      return target >= DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_TIME_MS
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_HIGH_CUT_HZ;
    case DAW_AUDIO_PROCESSOR_KIND_REVERB:
      return (target >= DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_WET
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_STEREO_WIDTH)
        || (target >= DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DECAY_SEC
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DIFFUSION)
        || target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_LOW_SHELF_HZ
        || target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_HIGH_SHELF_HZ
        || (target >= DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_CHORUS_AMOUNT_MS
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_HIGH_SHELF_DB);
    case DAW_AUDIO_PROCESSOR_KIND_SPECTRAL:
      return target >= DAW_AUDIO_PROCESSOR_PARAMETER_SPECTRAL_FREEZE
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_SPECTRAL_MIX;
    case DAW_AUDIO_PROCESSOR_KIND_AUTOFILTER:
      return (target >= DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_FREQUENCY_HZ
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_LFO_STEREO_PHASE)
        || target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_OUTPUT_DB;
    case DAW_AUDIO_PROCESSOR_KIND_LOFI:
      return (target >= DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_SAMPLE_RATE_RATIO
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_MIX)
        || target == DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_BIT_DEPTH;
    default:
      return false;
  }
}

bool valid_processor_parameter_targets(const daw_audio_processor_descriptor &descriptor) {
  if (descriptor.parameter_count > DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS
    || (descriptor.parameter_count > 0 && descriptor.parameter_targets == nullptr)) return false;
  for (uint32_t parameter = 0; parameter < descriptor.parameter_count; ++parameter) {
    const uint32_t target = descriptor.parameter_targets[parameter];
    if (!valid_processor_parameter_target(descriptor.kind, target)) return false;
    for (uint32_t previous = 0; previous < parameter; ++previous) {
      if (descriptor.parameter_targets[previous] == target) return false;
    }
  }
  return true;
}

bool valid_processor_parameter_value(uint32_t target, float value) {
  if (!std::isfinite(value)) return false;
  if (target == 1) return value >= -60.0F && value <= 24.0F;
  if (target == 2 || target == 3) return value >= -1.0F && value <= 1.0F;
  if (target == 4) return value >= 0.0F && value <= 2.0F;
  if (target == 5) return value >= 1.0F && value <= 3000.0F;
  if (target == 6) return value >= 0.0F && value <= 0.95F;
  if (target == 7 || target == 10) return value >= 0.0F && value <= 1.0F;
  if (target == 8) return value >= 20.0F && value <= 2000.0F;
  if (target == 9 || target == 13) return value >= 1000.0F && value <= 20000.0F;
  if (target == 11) return value >= 0.0F && value <= 250.0F;
  if (target == 12) return value >= 20.0F && value <= 1200.0F;
  if (target == 13) return value >= 1000.0F && value <= 20000.0F;
  if (target == 14) return value >= 0.0F && value <= 120.0F;
  if (target == 15 || target == 19 || target == 21 || target == 23 || target == 24 || target == 25) return value >= 0.0F && value <= 1.0F;
  if (target == 16) return value >= -120.0F && value <= 0.0F;
  if (target == 17) return value >= 0.1F && value <= 1000.0F;
  if (target == 18) return value >= 1.0F && value <= 5000.0F;
  if (target == 20) return value >= -2048.0F && value <= 2048.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_FREQUENCY_HZ) return value >= 20.0F && value <= 20000.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_RESONANCE) return value >= 0.0F && value <= 1.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_DRIVE_DB) return value >= 0.0F && value <= 24.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_MIX) return value >= 0.0F && value <= 1.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_ENVELOPE_AMOUNT_OCTAVES) return value >= -6.0F && value <= 6.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_ENVELOPE_ATTACK_MS) return value >= 0.5F && value <= 500.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_ENVELOPE_RELEASE_MS) return value >= 5.0F && value <= 2000.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_LFO_RATE_HZ) return value >= 0.01F && value <= 20.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_LFO_DEPTH_OCTAVES) return value >= 0.0F && value <= 6.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_LFO_PHASE_OFFSET) return value >= 0.0F && value <= 1.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_LFO_STEREO_PHASE) return value >= -0.5F && value <= 0.5F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_OUTPUT_DB) return value >= -24.0F && value <= 24.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_SAMPLE_RATE_RATIO) return value >= 0.01F && value <= 1.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_JITTER) return value >= 0.0F && value <= 1.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_NOISE_DB) return value >= -120.0F && value <= -24.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_MIX) return value >= 0.0F && value <= 1.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_BIT_DEPTH) {
    return value >= DAW_AUDIO_CORE_LOFI_BIT_DEPTH_MIN
      && value <= DAW_AUDIO_CORE_LOFI_BIT_DEPTH_MAX
      && std::floor(value) == value;
  }
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_DRIVE_DB) {
    return value >= DAW_AUDIO_CORE_SATURATOR_DRIVE_DB_MIN
      && value <= DAW_AUDIO_CORE_SATURATOR_DRIVE_DB_MAX;
  }
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_COLOR_FREQUENCY_HZ) {
    return value >= DAW_AUDIO_CORE_SATURATOR_COLOR_FREQUENCY_HZ_MIN
      && value <= DAW_AUDIO_CORE_SATURATOR_COLOR_FREQUENCY_HZ_MAX;
  }
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_COLOR_AMOUNT) {
    return value >= DAW_AUDIO_CORE_SATURATOR_COLOR_AMOUNT_MIN
      && value <= DAW_AUDIO_CORE_SATURATOR_COLOR_AMOUNT_MAX;
  }
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_OUTPUT_DB) {
    return value >= DAW_AUDIO_CORE_SATURATOR_OUTPUT_DB_MIN
      && value <= DAW_AUDIO_CORE_SATURATOR_OUTPUT_DB_MAX;
  }
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_DRY_WET) {
    return value >= DAW_AUDIO_CORE_SATURATOR_DRY_WET_MIN
      && value <= DAW_AUDIO_CORE_SATURATOR_DRY_WET_MAX;
  }
  if (target >= DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_DELAY_MS && target <= DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_MIX) {
    if (target == DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_DELAY_MS) return value >= DAW_AUDIO_CORE_CHORUS_DELAY_MS_MIN && value <= DAW_AUDIO_CORE_CHORUS_DELAY_MS_MAX;
    if (target == DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_DEPTH_MS) return value >= DAW_AUDIO_CORE_CHORUS_DEPTH_MS_MIN && value <= DAW_AUDIO_CORE_CHORUS_DEPTH_MS_MAX;
    if (target == DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_RATE_HZ) return value >= DAW_AUDIO_CORE_CHORUS_RATE_HZ_MIN && value <= DAW_AUDIO_CORE_CHORUS_RATE_HZ_MAX;
    if (target == DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_FEEDBACK) return value >= DAW_AUDIO_CORE_CHORUS_FEEDBACK_MIN && value <= DAW_AUDIO_CORE_CHORUS_FEEDBACK_MAX;
    if (target == DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_STEREO_PHASE) return value >= DAW_AUDIO_CORE_CHORUS_STEREO_PHASE_MIN && value <= DAW_AUDIO_CORE_CHORUS_STEREO_PHASE_MAX;
    return value >= DAW_AUDIO_CORE_CHORUS_MIX_MIN && value <= DAW_AUDIO_CORE_CHORUS_MIX_MAX;
  }
  if (target >= DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_DELAY_MS && target <= DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_MIX) {
    if (target == DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_DELAY_MS) return value >= DAW_AUDIO_CORE_FLANGER_DELAY_MS_MIN && value <= DAW_AUDIO_CORE_FLANGER_DELAY_MS_MAX;
    if (target == DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_DEPTH_MS) return value >= DAW_AUDIO_CORE_FLANGER_DEPTH_MS_MIN && value <= DAW_AUDIO_CORE_FLANGER_DEPTH_MS_MAX;
    if (target == DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_RATE_HZ) return value >= DAW_AUDIO_CORE_FLANGER_RATE_HZ_MIN && value <= DAW_AUDIO_CORE_FLANGER_RATE_HZ_MAX;
    if (target == DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_FEEDBACK) return value >= DAW_AUDIO_CORE_FLANGER_FEEDBACK_MIN && value <= DAW_AUDIO_CORE_FLANGER_FEEDBACK_MAX;
    if (target == DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_STEREO_PHASE) return value >= DAW_AUDIO_CORE_FLANGER_STEREO_PHASE_MIN && value <= DAW_AUDIO_CORE_FLANGER_STEREO_PHASE_MAX;
    return value >= DAW_AUDIO_CORE_FLANGER_MIX_MIN && value <= DAW_AUDIO_CORE_FLANGER_MIX_MAX;
  }
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_CENTER_HZ) return value >= DAW_AUDIO_CORE_PHASER_CENTER_HZ_MIN && value <= DAW_AUDIO_CORE_PHASER_CENTER_HZ_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_DEPTH_OCTAVES) return value >= DAW_AUDIO_CORE_PHASER_DEPTH_OCTAVES_MIN && value <= DAW_AUDIO_CORE_PHASER_DEPTH_OCTAVES_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_RATE_HZ) return value >= DAW_AUDIO_CORE_PHASER_RATE_HZ_MIN && value <= DAW_AUDIO_CORE_PHASER_RATE_HZ_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_FEEDBACK) return value >= DAW_AUDIO_CORE_PHASER_FEEDBACK_MIN && value <= DAW_AUDIO_CORE_PHASER_FEEDBACK_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_STEREO_PHASE) return value >= DAW_AUDIO_CORE_PHASER_STEREO_PHASE_MIN && value <= DAW_AUDIO_CORE_PHASER_STEREO_PHASE_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_MIX) return value >= DAW_AUDIO_CORE_PHASER_MIX_MIN && value <= DAW_AUDIO_CORE_PHASER_MIX_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_TREMOLO_RATE_HZ) return value >= DAW_AUDIO_CORE_TREMOLO_RATE_HZ_MIN && value <= DAW_AUDIO_CORE_TREMOLO_RATE_HZ_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_TREMOLO_DEPTH) return value >= DAW_AUDIO_CORE_TREMOLO_DEPTH_MIN && value <= DAW_AUDIO_CORE_TREMOLO_DEPTH_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_TREMOLO_SHAPE) return value >= DAW_AUDIO_CORE_TREMOLO_SHAPE_MIN && value <= DAW_AUDIO_CORE_TREMOLO_SHAPE_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_TREMOLO_PHASE) return value >= DAW_AUDIO_CORE_TREMOLO_PHASE_MIN && value <= DAW_AUDIO_CORE_TREMOLO_PHASE_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOPAN_RATE_HZ) return value >= DAW_AUDIO_CORE_AUTOPAN_RATE_HZ_MIN && value <= DAW_AUDIO_CORE_AUTOPAN_RATE_HZ_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOPAN_DEPTH) return value >= DAW_AUDIO_CORE_AUTOPAN_DEPTH_MIN && value <= DAW_AUDIO_CORE_AUTOPAN_DEPTH_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOPAN_SHAPE) return value >= DAW_AUDIO_CORE_AUTOPAN_SHAPE_MIN && value <= DAW_AUDIO_CORE_AUTOPAN_SHAPE_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOPAN_PHASE) return value >= DAW_AUDIO_CORE_AUTOPAN_PHASE_MIN && value <= DAW_AUDIO_CORE_AUTOPAN_PHASE_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_DELAY_MS) return value >= DAW_AUDIO_CORE_ENSEMBLE_DELAY_MS_MIN && value <= DAW_AUDIO_CORE_ENSEMBLE_DELAY_MS_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_DEPTH_MS) return value >= DAW_AUDIO_CORE_ENSEMBLE_DEPTH_MS_MIN && value <= DAW_AUDIO_CORE_ENSEMBLE_DEPTH_MS_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_RATE_HZ) return value >= DAW_AUDIO_CORE_ENSEMBLE_RATE_HZ_MIN && value <= DAW_AUDIO_CORE_ENSEMBLE_RATE_HZ_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_SPREAD) return value >= DAW_AUDIO_CORE_ENSEMBLE_SPREAD_MIN && value <= DAW_AUDIO_CORE_ENSEMBLE_SPREAD_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_MIX) return value >= DAW_AUDIO_CORE_ENSEMBLE_MIX_MIN && value <= DAW_AUDIO_CORE_ENSEMBLE_MIX_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_GATE_THRESHOLD_DB) return value >= DAW_AUDIO_CORE_GATE_THRESHOLD_DB_MIN && value <= DAW_AUDIO_CORE_GATE_THRESHOLD_DB_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_GATE_RATIO) return value >= DAW_AUDIO_CORE_GATE_RATIO_MIN && value <= DAW_AUDIO_CORE_GATE_RATIO_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_GATE_ATTACK_MS) return value >= DAW_AUDIO_CORE_GATE_ATTACK_MS_MIN && value <= DAW_AUDIO_CORE_GATE_ATTACK_MS_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_GATE_HOLD_MS) return value >= DAW_AUDIO_CORE_GATE_HOLD_MS_MIN && value <= DAW_AUDIO_CORE_GATE_HOLD_MS_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_GATE_RELEASE_MS) return value >= DAW_AUDIO_CORE_GATE_RELEASE_MS_MIN && value <= DAW_AUDIO_CORE_GATE_RELEASE_MS_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_GATE_HYSTERESIS_DB) return value >= DAW_AUDIO_CORE_GATE_HYSTERESIS_DB_MIN && value <= DAW_AUDIO_CORE_GATE_HYSTERESIS_DB_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_GATE_RANGE_DB) return value >= DAW_AUDIO_CORE_GATE_RANGE_DB_MIN && value <= DAW_AUDIO_CORE_GATE_RANGE_DB_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_GATE_LINK) return value >= DAW_AUDIO_CORE_GATE_LINK_MIN && value <= DAW_AUDIO_CORE_GATE_LINK_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_GATE_SIDECHAIN_FREQUENCY_HZ) return value >= DAW_AUDIO_CORE_GATE_SIDECHAIN_FREQUENCY_HZ_MIN && value <= DAW_AUDIO_CORE_GATE_SIDECHAIN_FREQUENCY_HZ_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_GATE_SIDECHAIN_Q) return value >= DAW_AUDIO_CORE_GATE_SIDECHAIN_Q_MIN && value <= DAW_AUDIO_CORE_GATE_SIDECHAIN_Q_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_GATE_SIDECHAIN_GAIN_DB) return value >= DAW_AUDIO_CORE_GATE_SIDECHAIN_GAIN_DB_MIN && value <= DAW_AUDIO_CORE_GATE_SIDECHAIN_GAIN_DB_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_GATE_SIDECHAIN_MIX) return value >= DAW_AUDIO_CORE_GATE_SIDECHAIN_MIX_MIN && value <= DAW_AUDIO_CORE_GATE_SIDECHAIN_MIX_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_THRESHOLD_DB) return value >= DAW_AUDIO_CORE_COMPRESSOR_THRESHOLD_DB_MIN && value <= DAW_AUDIO_CORE_COMPRESSOR_THRESHOLD_DB_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_RATIO) return value >= DAW_AUDIO_CORE_COMPRESSOR_RATIO_MIN && value <= DAW_AUDIO_CORE_COMPRESSOR_RATIO_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_ATTACK_MS) return value >= DAW_AUDIO_CORE_COMPRESSOR_ATTACK_MS_MIN && value <= DAW_AUDIO_CORE_COMPRESSOR_ATTACK_MS_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_RELEASE_MS) return value >= DAW_AUDIO_CORE_COMPRESSOR_RELEASE_MS_MIN && value <= DAW_AUDIO_CORE_COMPRESSOR_RELEASE_MS_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_MAKEUP_DB) return value >= DAW_AUDIO_CORE_COMPRESSOR_MAKEUP_DB_MIN && value <= DAW_AUDIO_CORE_COMPRESSOR_MAKEUP_DB_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_OUTPUT_DB) return value >= DAW_AUDIO_CORE_COMPRESSOR_OUTPUT_DB_MIN && value <= DAW_AUDIO_CORE_COMPRESSOR_OUTPUT_DB_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_DRY_WET) return value >= DAW_AUDIO_CORE_COMPRESSOR_DRY_WET_MIN && value <= DAW_AUDIO_CORE_COMPRESSOR_DRY_WET_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_KNEE_DB) return value >= DAW_AUDIO_CORE_COMPRESSOR_KNEE_DB_MIN && value <= DAW_AUDIO_CORE_COMPRESSOR_KNEE_DB_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_SIDECHAIN_FREQUENCY_HZ) return value >= DAW_AUDIO_CORE_COMPRESSOR_SIDECHAIN_FREQUENCY_HZ_MIN && value <= DAW_AUDIO_CORE_COMPRESSOR_SIDECHAIN_FREQUENCY_HZ_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_SIDECHAIN_Q) return value >= DAW_AUDIO_CORE_COMPRESSOR_SIDECHAIN_Q_MIN && value <= DAW_AUDIO_CORE_COMPRESSOR_SIDECHAIN_Q_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_CEILING) return value >= DAW_AUDIO_CORE_LIMITER_CEILING_MIN && value <= DAW_AUDIO_CORE_LIMITER_CEILING_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_RELEASE) return value >= DAW_AUDIO_CORE_LIMITER_RELEASE_MIN && value <= DAW_AUDIO_CORE_LIMITER_RELEASE_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_GAIN_DB) return value >= DAW_AUDIO_CORE_LIMITER_GAIN_DB_MIN && value <= DAW_AUDIO_CORE_LIMITER_GAIN_DB_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_LINK) return value >= DAW_AUDIO_CORE_LIMITER_LINK_MIN && value <= DAW_AUDIO_CORE_LIMITER_LINK_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DECAY_SEC) return value >= DAW_AUDIO_CORE_REVERB_DECAY_SEC_MIN && value <= DAW_AUDIO_CORE_REVERB_DECAY_SEC_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTIONS) return value >= DAW_AUDIO_CORE_REVERB_REFLECTIONS_MIN && value <= DAW_AUDIO_CORE_REVERB_REFLECTIONS_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTION_SHAPE) return value >= DAW_AUDIO_CORE_REVERB_REFLECTION_SHAPE_MIN && value <= DAW_AUDIO_CORE_REVERB_REFLECTION_SHAPE_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DIFFUSE) return value >= DAW_AUDIO_CORE_REVERB_DIFFUSE_MIN && value <= DAW_AUDIO_CORE_REVERB_DIFFUSE_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_SIZE) return value >= DAW_AUDIO_CORE_REVERB_SIZE_MIN && value <= DAW_AUDIO_CORE_REVERB_SIZE_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DIFFUSION) return value >= DAW_AUDIO_CORE_REVERB_DIFFUSION_MIN && value <= DAW_AUDIO_CORE_REVERB_DIFFUSION_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTION_MOD_AMOUNT_MS) return value >= DAW_AUDIO_CORE_REVERB_REFLECTION_MOD_AMOUNT_MS_MIN && value <= DAW_AUDIO_CORE_REVERB_REFLECTION_MOD_AMOUNT_MS_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTION_MOD_RATE_HZ) return value >= DAW_AUDIO_CORE_REVERB_REFLECTION_MOD_RATE_HZ_MIN && value <= DAW_AUDIO_CORE_REVERB_REFLECTION_MOD_RATE_HZ_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_LOW_SHELF_HZ) return value >= DAW_AUDIO_CORE_REVERB_LOW_SHELF_HZ_MIN && value <= DAW_AUDIO_CORE_REVERB_LOW_SHELF_HZ_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_HIGH_SHELF_HZ) return value >= DAW_AUDIO_CORE_REVERB_HIGH_SHELF_HZ_MIN && value <= DAW_AUDIO_CORE_REVERB_HIGH_SHELF_HZ_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_CHORUS_AMOUNT_MS) return value >= DAW_AUDIO_CORE_REVERB_CHORUS_AMOUNT_MS_MIN && value <= DAW_AUDIO_CORE_REVERB_CHORUS_AMOUNT_MS_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_CHORUS_RATE_HZ) return value >= DAW_AUDIO_CORE_REVERB_CHORUS_RATE_HZ_MIN && value <= DAW_AUDIO_CORE_REVERB_CHORUS_RATE_HZ_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_LOW_SHELF_DB) return value >= DAW_AUDIO_CORE_REVERB_LOW_SHELF_DB_MIN && value <= DAW_AUDIO_CORE_REVERB_LOW_SHELF_DB_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_HIGH_SHELF_DB) return value >= DAW_AUDIO_CORE_REVERB_HIGH_SHELF_DB_MIN && value <= DAW_AUDIO_CORE_REVERB_HIGH_SHELF_DB_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_EQ_SCALE) return value >= 0.0F && value <= DAW_AUDIO_CORE_EQ_SCALE_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_EQ_OUTPUT_DB) return std::fabs(value) <= DAW_AUDIO_CORE_EQ_OUTPUT_DB_MAX;
  if ((target >= DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_TARGET_BASE && target <= DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_TARGET_LAST)
    || (target >= DAW_AUDIO_PROCESSOR_PARAMETER_EQ_SECOND_BAND_TARGET_BASE
      && target <= DAW_AUDIO_PROCESSOR_PARAMETER_EQ_SECOND_BAND_TARGET_LAST)) {
    const uint32_t base = target >= DAW_AUDIO_PROCESSOR_PARAMETER_EQ_SECOND_BAND_TARGET_BASE
      ? DAW_AUDIO_PROCESSOR_PARAMETER_EQ_SECOND_BAND_TARGET_BASE : DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_TARGET_BASE;
    switch ((target - base) % DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_TARGET_STRIDE) {
      case 0: return value >= 20.0F && value <= 20000.0F;
      case 1: return value >= -24.0F && value <= 24.0F;
      default: return value >= 0.2F && value <= 18.0F;
    }
  }
  return target == 22 && value >= -1.0F && value <= 1.0F;
}
}  // namespace daw::audio_core_internal
