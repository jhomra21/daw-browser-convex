#include "audio_core_internal.h"
#include "dsp/numeric_safety.h"

namespace daw::audio_core_internal {

void release_instrument_state(InstrumentNodeState &instrument) {
  for (InstrumentVoice &voice : instrument.voices) {
    if (!voice.active) continue;
    voice.held = false;
    voice.references = 0;
    voice.released = true;
  }
  for (SampleVoice &voice : instrument.sample_voices) {
    if (voice.active) voice.released = true;
  }
  instrument.grains = {};
  instrument.granular_note_ids = {};
  instrument.granular_note_ages = {};
  instrument.granular_note_count = 0;
  instrument.granular_next_note_age = 1;
  instrument.sustain = false;
}

void clear_instrument_state(InstrumentNodeState &instrument) {
  instrument.voices = {};
  instrument.dying_voices = {};
  instrument.sample_voices = {};
  instrument.dying_sample_voices = {};
  instrument.grains = {};
  instrument.granular_note_ids = {};
  instrument.granular_note_ages = {};
  instrument.granular_note_count = 0;
  instrument.granular_next_note_age = 1;
  instrument.granular_next_frame = 0.0;
  instrument.granular_frozen_position = -1.0F;
  instrument.granular_random_state = instrument.granular.seed == 0 ? 1 : instrument.granular.seed;
  instrument.expression = 1.0F;
  instrument.sustain = false;
  instrument.next_age = 1;
}
}  // namespace daw::audio_core_internal

namespace {

float next_granular_random(InstrumentNodeState &instrument) {
  instrument.granular_random_state = instrument.granular_random_state * 1664525U + 1013904223U;
  return static_cast<float>(instrument.granular_random_state) / 4294967296.0F;
}

float granular_window(uint32_t shape, float phase) {
  const float x = std::fmax(0.0F, std::fmin(1.0F, phase));
  if (shape == DAW_AUDIO_GRANULAR_WINDOW_TUKEY) {
    if (x < 0.25F) return 0.5F * (1.0F - std::cos(12.5663706143591729538F * x));
    if (x > 0.75F) return 0.5F * (1.0F - std::cos(12.5663706143591729538F * (1.0F - x)));
    return 1.0F;
  }
  if (shape == DAW_AUDIO_GRANULAR_WINDOW_GAUSSIAN) {
    const float normalized = (x - 0.5F) / 0.18F;
    return std::exp(-0.5F * normalized * normalized);
  }
  return 0.5F - 0.5F * std::cos(6.2831853071795864769F * x);
}

float midi_frequency(uint32_t note) {
  return 440.0F * std::pow(2.0F, (static_cast<float>(note) - 69.0F) / 12.0F);
}

float next_noise(InstrumentVoice &voice) {
  uint32_t value = voice.noise_state;
  value ^= value << 13U;
  value ^= value >> 17U;
  value ^= value << 5U;
  voice.noise_state = value == 0 ? 0xA341316CU : value;
  return static_cast<float>(voice.noise_state) / 2147483647.5F - 1.0F;
}

// Two-sample polynomial band-limited step: the correction for a unit discontinuity
// at phase 0, given the per-sample phase increment.
float poly_blep(float phase, float increment) {
  if (phase < increment) {
    const float x = phase / increment;
    return x + x - x * x - 1.0F;
  }
  if (phase > 1.0F - increment) {
    const float x = (phase - 1.0F) / increment;
    return x * x + x + x + 1.0F;
  }
  return 0.0F;
}

// The audio oscillator shapes: saw and square are band-limited, the rest are as in waveform().
// An LFO stays a naive shape, so it keeps calling waveform().
float oscillator_waveform(uint32_t shape, float phase, float increment) {
  const float step = std::fmin(increment, 0.5F);
  if (shape == DAW_AUDIO_SYNTH_WAVEFORM_SAWTOOTH) return waveform(shape, phase) - poly_blep(phase, step);
  if (shape == DAW_AUDIO_SYNTH_WAVEFORM_SQUARE) {
    const float falling_phase = phase + 0.5F - std::floor(phase + 0.5F);
    return waveform(shape, phase) + poly_blep(phase, step) - poly_blep(falling_phase, step);
  }
  return waveform(shape, phase);
}

// A stage takes its knob time. Attack is at least 1 ms (the Web Audio path clamps the
// same way); decay and release are at least one frame.
struct EnvelopeFrames {
  float attack;
  float decay;
  float release;
  float sustain_follow;
};

// A held note follows a moved Sustain knob with a 2 ms pole: no step, and settled
// (under 1% of a 0.5 move) within 20 ms, which the 5 ms parameter slew alone is not.
constexpr float kSustainFollowSeconds = 0.002F;

EnvelopeFrames envelope_frames(float attack_ms, float decay_ms, float release_ms, uint32_t sample_rate_hz) {
  const float rate = static_cast<float>(sample_rate_hz);
  const auto frames = [rate](float ms) { return std::fmax(1.0F, ms * rate / 1000.0F); };
  return {frames(std::fmax(1.0F, attack_ms)), frames(decay_ms), frames(release_ms), 1.0F / frames(kSustainFollowSeconds * 1000.0F)};
}

// Attack climbs to 1, decay falls from 1 to the sustain level, and from then on the
// level follows the sustain, so a moved knob is heard on a held note. Release falls
// from the level at note-off (`release_from`) to 0. A note-on on a releasing voice
// attacks again from where the level is.
float envelope_step(
  float level, uint32_t *stage, float *release_from, bool released, const EnvelopeFrames &frames, float sustain) {
  if (released) {
    if (*stage != 3) {
      *stage = 3;
      *release_from = level;
    }
    return std::fmax(0.0F, level - *release_from / frames.release);
  }
  if (*stage == 3) *stage = 0;
  if (*stage == 0) {
    level += 1.0F / frames.attack;
    if (level < 1.0F) return level;
    *stage = 1;
    return 1.0F;
  }
  if (*stage == 1) {
    level -= (1.0F - sustain) / frames.decay;
    if (level <= sustain) *stage = 2;
  }
  if (*stage != 2) return level;
  const float delta = sustain - level;
  return std::fabs(delta) < 1e-5F ? sustain : level + delta * frames.sustain_follow;
}

// Quietest released voice, then the oldest released, then the oldest held.
template <typename Voice>
Voice *steal_victim(std::array<Voice, kMaximumInstrumentVoices> &voices, uint32_t capacity) {
  const auto gives_way_to = [](const Voice &candidate, const Voice &current) {
    if (candidate.released != current.released) return candidate.released;
    if (candidate.released && candidate.amp_level != current.amp_level) return candidate.amp_level < current.amp_level;
    return candidate.age < current.age;
  };
  Voice *victim = &voices[0];
  for (uint32_t index = 1; index < capacity; ++index) {
    if (gives_way_to(voices[index], *victim)) victim = &voices[index];
  }
  return victim;
}

// The voice a new note takes the slot of keeps sounding in the dying pool and fades
// out there, so the slot never jumps. A full pool gives up its quietest voice.
template <typename Voice>
void fade_out_voice(std::array<Voice, kMaximumDyingVoices> &dying, const Voice &voice) {
  Voice *slot = &dying[0];
  for (Voice &candidate : dying) {
    if (!candidate.active) {
      slot = &candidate;
      break;
    }
    if (candidate.fade_gain < slot->fade_gain) slot = &candidate;
  }
  *slot = voice;
}

const PanGains &equal_power_pan(PanGains &cached, float pan) {
  if (cached.pan != pan) {
    const float angle = (pan + 1.0F) * 0.7853981633974483096F;
    cached = {pan, std::cos(angle) * 1.4142135623730950488F, std::sin(angle) * 1.4142135623730950488F};
  }
  return cached;
}

// Flushes denormal filter memory, and clears memory that is not finite (returns false:
// the sample that produced it is dropped).
bool settle_filter(BiquadHistory &history) {
  if (!std::isfinite(history.x1) || !std::isfinite(history.x2) || !std::isfinite(history.y1) || !std::isfinite(history.y2)) {
    history = {};
    return false;
  }
  history.x1 = dsp::flushDenormal(history.x1);
  history.x2 = dsp::flushDenormal(history.x2);
  history.y1 = dsp::flushDenormal(history.y1);
  history.y2 = dsp::flushDenormal(history.y2);
  return true;
}

InstrumentVoice new_synth_voice(const InstrumentNodeState &instrument, uint64_t age, const daw_audio_instrument_event &event) {
  uint32_t seed = instrument.synth.seed ^ static_cast<uint32_t>(event.note_id) ^ (event.note * 0x9E3779B1U);
  if (seed == 0) seed = 0xA341316CU;
  return {.note_id = event.note_id, .channel = event.channel, .note = event.note, .velocity = event.value, .references = 1,
    .age = age, .noise_state = seed, .frequency = midi_frequency(event.note), .held = true, .active = true, .released = false};
}

// A kept instrument's targets move at once; `applied` follows them. One pole per
// value, so a value reverses without overshoot, a burst of events ends where the
// last one says, and a value within 1e-4 of its target lands on it (nothing decays
// into subnormals). The time constant is the shortest the drag witnesses accept: at
// 2 ms a two-semitone step still changes a cycle's period by 3.5%, at 5 ms by less
// than 2.5%.
constexpr float kInstrumentSlewSeconds = 0.005F;
constexpr float kSampleEndFadeFrames = 64.0F;
}  // namespace

namespace daw::audio_core_internal {

void advance_applied(const Core &core, InstrumentNodeState &instrument, uint32_t kind) {
  const float rate = 1.0F / std::fmax(1.0F, static_cast<float>(core.config.sample_rate_hz) * kInstrumentSlewSeconds);
  const auto slew = [rate](float &applied, float target) {
    const float delta = target - applied;
    applied = std::fabs(delta) <= 1e-4F * std::fmax(1.0F, std::fabs(target)) ? target : applied + delta * rate;
  };
  if (kind == DAW_AUDIO_INSTRUMENT_KIND_SYNTH) {
    visit_synth(instrument.applied.synth, instrument.synth, slew);
  } else if (kind == DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) {
    visit_granular(instrument.applied.granular, instrument.granular, slew);
  } else {
    visit_sampler(instrument.applied.sampler, instrument.sampler, slew);
    for (uint32_t index = 0; index < instrument.sampler.zone_count; ++index) {
      visit_zone(instrument.applied.zones[index], instrument.zones[index], slew);
    }
  }
}

bool set_synth_parameter(daw_audio_synth_state &synth, uint32_t target, float value) {
  if (!std::isfinite(value)) return false;
  if (target == DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_GAIN && value >= 0.0F && value <= 1.5F) synth.output_gain = value;
  else if (target == DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_PAN && value >= -1.0F && value <= 1.0F) synth.output_pan = value;
  else if (target == DAW_AUDIO_SYNTH_PARAMETER_FILTER_CUTOFF_HZ && value >= 20.0F && value <= 20000.0F) synth.filter_cutoff_hz = value;
  else if (target == DAW_AUDIO_SYNTH_PARAMETER_FILTER_RESONANCE && value >= 0.0001F && value <= 30.0F) synth.filter_resonance = value;
  else if (target == DAW_AUDIO_SYNTH_PARAMETER_AMP_ATTACK_MS && value >= 0.0F && value <= 60000.0F) synth.amp_attack_ms = value;
  else if (target == DAW_AUDIO_SYNTH_PARAMETER_AMP_DECAY_MS && value >= 0.0F && value <= 60000.0F) synth.amp_decay_ms = value;
  else if (target == DAW_AUDIO_SYNTH_PARAMETER_AMP_SUSTAIN && value >= 0.0F && value <= 1.0F) synth.amp_sustain = value;
  else if (target == DAW_AUDIO_SYNTH_PARAMETER_AMP_RELEASE_MS && value >= 0.0F && value <= 60000.0F) synth.amp_release_ms = value;
  else return false;
  return true;
}

void render_instrument_frame(
  InstrumentNodeState &instrument,
  const daw_audio_instrument_state_descriptor &descriptor,
  uint32_t sample_rate_hz,
  float *left_output,
  float *right_output) {
  float left = 0.0F;
  float right = 0.0F;
  const daw_audio_synth_state &synth = instrument.applied.synth;
  const EnvelopeFrames amp_frames = envelope_frames(synth.amp_attack_ms, synth.amp_decay_ms, synth.amp_release_ms, sample_rate_hz);
  const EnvelopeFrames filter_frames = envelope_frames(synth.filter_attack_ms, synth.filter_decay_ms, synth.filter_release_ms, sample_rate_hz);
  const bool pitch_modulated = synth.lfo_enabled != 0 && synth.lfo_pitch_cents != 0.0F;
  const float detune_ratios[2] = {
    pitch_modulated ? 1.0F : std::pow(2.0F, synth.oscillators[0].detune_cents / 1200.0F),
    pitch_modulated ? 1.0F : std::pow(2.0F, synth.oscillators[1].detune_cents / 1200.0F)};
  const auto render_voice = [&](InstrumentVoice &voice) {
    voice.amp_level = envelope_step(voice.amp_level, &voice.amp_stage, &voice.amp_release_level, voice.released, amp_frames, instrument.synth.amp_sustain);
    voice.filter_level = envelope_step(voice.filter_level, &voice.filter_stage, &voice.filter_release_level, voice.released, filter_frames, instrument.synth.filter_sustain);
    if (voice.amp_level <= 0.0F && voice.released) {
      voice = {};
      return;
    }
    voice.lfo_phase += synth.lfo_rate_hz / static_cast<float>(sample_rate_hz);
    voice.lfo_phase -= std::floor(voice.lfo_phase);
    const float lfo = synth.lfo_enabled == 0 ? 0.0F : waveform(synth.lfo_waveform, voice.lfo_phase);
    float sample = synth.noise_enabled != 0 ? next_noise(voice) * synth.noise_level : 0.0F;
    for (uint32_t oscillator_index = 0; oscillator_index < 2; ++oscillator_index) {
      const daw_audio_synth_oscillator_state &oscillator = synth.oscillators[oscillator_index];
      if (oscillator.enabled == 0) continue;
      const float ratio = pitch_modulated
        ? std::pow(2.0F, (oscillator.detune_cents + lfo * synth.lfo_pitch_cents) / 1200.0F)
        : detune_ratios[oscillator_index];
      const float increment = voice.frequency * ratio / static_cast<float>(sample_rate_hz);
      float &phase = voice.oscillator_phase[oscillator_index];
      phase += increment;
      phase -= std::floor(phase);
      if (!std::isfinite(phase)) phase = 0.0F;
      sample += oscillator_waveform(oscillator.waveform, phase, increment) * oscillator.level;
    }
    float cutoff = synth.filter_cutoff_hz;
    cutoff *= std::pow(2.0F, (static_cast<float>(voice.note) - 60.0F) / 12.0F * synth.filter_key_tracking
      + voice.filter_level * synth.filter_envelope_amount_octaves + lfo * synth.lfo_filter_octaves);
    cutoff = std::fmax(20.0F, std::fmin(cutoff, static_cast<float>(sample_rate_hz) * 0.45F));
    const float resonance = synth.filter_resonance;
    const uint32_t filter_type = synth.filter_mode == DAW_AUDIO_SYNTH_FILTER_MODE_HIGHPASS
      ? DAW_AUDIO_EQ_BAND_HIGHPASS
      : synth.filter_mode == DAW_AUDIO_SYNTH_FILTER_MODE_BANDPASS
        ? DAW_AUDIO_EQ_BAND_BANDPASS
        : synth.filter_mode == DAW_AUDIO_SYNTH_FILTER_MODE_NOTCH
          ? DAW_AUDIO_EQ_BAND_NOTCH
          : DAW_AUDIO_EQ_BAND_LOWPASS;
    const BiquadCoefficients filter_coefficients = rbj_coefficients(
      filter_type, cutoff, std::fmax(0.0001F, resonance), 0.0F, sample_rate_hz);
    float filtered = sample;
    if (synth.filter_enabled != 0) {
      filtered = process_biquad(sample, filter_coefficients, voice.filter_history[0]);
      if (!settle_filter(voice.filter_history[0])) filtered = 0.0F;
    }
    const float amplitude = voice.amp_level * voice.velocity * instrument.expression * synth.output_gain * voice.fade_gain
      * std::fmax(0.0F, 1.0F - lfo * synth.lfo_amplitude);
    const PanGains &pan = equal_power_pan(
      voice.pan_gains, std::fmax(-1.0F, std::fmin(1.0F, synth.output_pan + lfo * synth.lfo_pan)));
    left += filtered * amplitude * pan.left;
    right += filtered * amplitude * pan.right;
  };
  for (uint32_t index = 0; index < descriptor.voice_capacity; ++index) {
    if (instrument.voices[index].active) render_voice(instrument.voices[index]);
  }
  const float fade_step = 1.0F / std::fmax(1.0F, static_cast<float>(sample_rate_hz) * kVoiceStealFadeMilliseconds / 1000.0F);
  for (InstrumentVoice &voice : instrument.dying_voices) {
    if (!voice.active) continue;
    voice.fade_gain -= fade_step;
    if (voice.fade_gain <= 0.0F) voice = {};
    else render_voice(voice);
  }
  *left_output = std::isfinite(left) ? left : 0.0F;
  *right_output = std::isfinite(right) ? right : 0.0F;
}
}  // namespace daw::audio_core_internal

namespace {

double sample_voice_increment(
  const Core &core, const AssetSlot &asset, uint32_t note, const daw_audio_sample_zone &zone) {
  const float cents = (static_cast<float>(note) - static_cast<float>(zone.root_note)) * 100.0F + zone.tune_cents;
  return std::pow(2.0, cents / 1200.0) * static_cast<double>(asset.sample_rate_hz) / core.config.sample_rate_hz;
}

// Re-derives what a voice took from its zone when the zone no longer says the same:
// a swapped asset or a tuning edit changes the step (the playhead stays where it
// is), and a start edit moves the playhead by the same distance as the start, so the
// note plays on from the same offset into the sample.
void follow_sample_zone(
  const Core &core, SampleVoice &voice, const daw_audio_sample_zone &zone, const AssetSlot &asset) {
  if (voice.asset != zone.asset || voice.root_note != zone.root_note || voice.tune_cents != zone.tune_cents) {
    voice.asset = zone.asset;
    voice.root_note = zone.root_note;
    voice.tune_cents = zone.tune_cents;
    voice.increment = sample_voice_increment(core, asset, voice.note, zone);
  }
  if (voice.start_frame != zone.start_frame) {
    voice.position += static_cast<double>(zone.start_frame) - static_cast<double>(voice.start_frame);
    voice.start_frame = zone.start_frame;
  }
}
}  // namespace

namespace daw::audio_core_internal {

void render_sample_instrument_frame(
  Core &core,
  InstrumentNodeState &instrument,
  const daw_audio_instrument_state_descriptor &descriptor,
  float *left_output,
  float *right_output) {
  float left = 0.0F;
  float right = 0.0F;
  const daw_audio_sampler_state &state = instrument.applied.sampler;
  const uint32_t sample_rate_hz = core.config.sample_rate_hz;
  const EnvelopeFrames filter_frames = envelope_frames(state.filter_attack_ms, state.filter_decay_ms, state.filter_release_ms, sample_rate_hz);
  const bool pitch_modulated = state.lfo_enabled != 0 && state.lfo_pitch_cents != 0.0F;
  const auto render_voice = [&](SampleVoice &voice) {
    const float release_ms = voice.forced_release_ms > 0.0F ? voice.forced_release_ms : state.amp_release_ms;
    voice.amp_level = envelope_step(voice.amp_level, &voice.amp_stage, &voice.amp_release_level, voice.released,
      envelope_frames(state.amp_attack_ms, state.amp_decay_ms, release_ms, sample_rate_hz), instrument.sampler.amp_sustain);
    voice.filter_level = envelope_step(voice.filter_level, &voice.filter_stage, &voice.filter_release_level, voice.released, filter_frames, instrument.sampler.filter_sustain);
    const daw_audio_sample_zone &zone = instrument.applied.zones[voice.zone];
    AssetSlot *asset = find_asset(&core, zone.asset);
    if (asset == nullptr || (voice.amp_level <= 0.0F && voice.released)) {
      voice = {};
      return;
    }
    follow_sample_zone(core, voice, zone, *asset);
    const bool one_shot = zone.playback_mode == DAW_AUDIO_SAMPLE_PLAYBACK_ONE_SHOT;
    if (voice.position >= static_cast<double>(zone.end_frame)) {
      if (one_shot) {
        voice = {};
        return;
      }
      const double loop_length = static_cast<double>(zone.loop_end_frame - zone.loop_start_frame);
      voice.position = static_cast<double>(zone.loop_start_frame) + std::fmod(
        voice.position - static_cast<double>(zone.loop_start_frame), loop_length);
    }
    const auto sample_at = [&core, asset](double position, uint32_t channel) {
      return asset_sample(core, *asset, nullptr, position, channel);
    };
    const uint32_t right_channel = asset->channel_count > 1 ? 1 : 0;
    float sample_left = sample_at(voice.position, 0);
    float sample_right = sample_at(voice.position, right_channel);
    if (zone.playback_mode == DAW_AUDIO_SAMPLE_PLAYBACK_CROSSFADE_LOOP
      && zone.crossfade_frame_count > 0
      && voice.position >= static_cast<double>(zone.loop_end_frame - zone.crossfade_frame_count)) {
      const double fade = (voice.position - static_cast<double>(zone.loop_end_frame - zone.crossfade_frame_count))
        / static_cast<double>(zone.crossfade_frame_count);
      const double loop_position = static_cast<double>(zone.loop_start_frame)
        + (voice.position - static_cast<double>(zone.loop_end_frame - zone.crossfade_frame_count));
      sample_left = sample_left * static_cast<float>(1.0 - fade) + sample_at(loop_position, 0) * static_cast<float>(fade);
      sample_right = sample_right * static_cast<float>(1.0 - fade) + sample_at(loop_position, right_channel) * static_cast<float>(fade);
    }
    voice.lfo_phase += state.lfo_rate_hz / static_cast<float>(sample_rate_hz);
    voice.lfo_phase -= std::floor(voice.lfo_phase);
    const float lfo = state.lfo_enabled == 0 ? 0.0F : std::sin(6.2831853071795864769F * voice.lfo_phase);
    float filtered_left = sample_left;
    float filtered_right = sample_right;
    if (state.filter_enabled != 0) {
      const float cutoff = std::fmax(20.0F, std::fmin(
        state.filter_cutoff_hz + state.filter_envelope_amount * 20000.0F * voice.filter_level + lfo * state.lfo_filter_hz,
        static_cast<float>(sample_rate_hz) * 0.45F));
      const uint32_t filter_type = state.filter_mode == DAW_AUDIO_SYNTH_FILTER_MODE_HIGHPASS
        ? DAW_AUDIO_EQ_BAND_HIGHPASS
        : state.filter_mode == DAW_AUDIO_SYNTH_FILTER_MODE_BANDPASS
          ? DAW_AUDIO_EQ_BAND_BANDPASS
          : state.filter_mode == DAW_AUDIO_SYNTH_FILTER_MODE_NOTCH
            ? DAW_AUDIO_EQ_BAND_NOTCH
            : DAW_AUDIO_EQ_BAND_LOWPASS;
      const BiquadCoefficients coefficients = rbj_coefficients(filter_type, cutoff, state.filter_resonance, 0.0F, sample_rate_hz);
      filtered_left = process_biquad(sample_left, coefficients, voice.filter_history[0]);
      filtered_right = process_biquad(sample_right, coefficients, voice.filter_history[1]);
      if (!settle_filter(voice.filter_history[0])) filtered_left = 0.0F;
      if (!settle_filter(voice.filter_history[1])) filtered_right = 0.0F;
    }
    // A one-shot ends in a short fade, so a region that stops off zero does not click.
    const float end_fade = one_shot
      ? static_cast<float>(std::fmin(1.0, (static_cast<double>(zone.end_frame) - voice.position) / (kSampleEndFadeFrames * voice.increment)))
      : 1.0F;
    const float gain = zone.gain * voice.velocity * voice.amp_level * voice.fade_gain * end_fade
      * std::fmax(0.0F, 1.0F - lfo * state.lfo_amplitude);
    const PanGains &pan = equal_power_pan(
      voice.pan_gains, std::fmax(-1.0F, std::fmin(1.0F, zone.pan + lfo * state.lfo_pan)));
    left += filtered_left * gain * pan.left;
    right += filtered_right * gain * pan.right;
    voice.position += pitch_modulated
      ? voice.increment * std::pow(2.0, static_cast<double>(lfo * state.lfo_pitch_cents) / 1200.0)
      : voice.increment;
  };
  for (uint32_t index = 0; index < descriptor.voice_capacity; ++index) {
    if (instrument.sample_voices[index].active) render_voice(instrument.sample_voices[index]);
  }
  const float fade_step = 1.0F / std::fmax(1.0F, static_cast<float>(sample_rate_hz) * kVoiceStealFadeMilliseconds / 1000.0F);
  for (SampleVoice &voice : instrument.dying_sample_voices) {
    if (!voice.active) continue;
    voice.fade_gain -= fade_step;
    if (voice.fade_gain <= 0.0F) voice = {};
    else render_voice(voice);
  }
  *left_output = std::isfinite(left) ? left : 0.0F;
  *right_output = std::isfinite(right) ? right : 0.0F;
}

void render_granular_instrument_frame(
  Core &core,
  InstrumentNodeState &instrument,
  float *left_output,
  float *right_output) {
  const daw_audio_granular_state &state = instrument.applied.granular;
  AssetSlot *asset = find_asset(&core, state.asset);
  if (asset == nullptr || instrument.granular_note_count == 0) {
    *left_output = 0.0F;
    *right_output = 0.0F;
    return;
  }
  if (instrument.granular_next_frame <= 0.0) {
    GranularGrain *grain = nullptr;
    for (uint32_t index = 0; index < state.max_grains; ++index) {
      if (!instrument.grains[index].active) {
        grain = &instrument.grains[index];
        break;
      }
    }
    if (grain != nullptr) {
      const float requested_position = state.position;
      if (state.freeze != 0 && instrument.granular_frozen_position < 0.0F) instrument.granular_frozen_position = requested_position;
      const float position = state.freeze != 0 ? instrument.granular_frozen_position : requested_position;
      const float spray = state.freeze != 0 ? 0.0F : (next_granular_random(instrument) * 2.0F - 1.0F) * state.spray * asset->frame_count;
      const bool reverse = next_granular_random(instrument) < state.reverse_probability;
      const double rate = std::pow(2.0, static_cast<double>(state.pitch_semitones) / 12.0)
        * static_cast<double>(asset->sample_rate_hz) / core.config.sample_rate_hz;
      *grain = {
        .cursor = std::fmax(0.0, std::fmin(static_cast<double>(asset->frame_count - 1),
          static_cast<double>(position) * static_cast<double>(asset->frame_count - 1) + spray)),
        .step = reverse ? -rate : rate,
        .age = 0,
        .length = std::max(1U, static_cast<uint32_t>(std::lround(state.grain_size_ms * 0.001F * core.config.sample_rate_hz))),
        .pan = (next_granular_random(instrument) * 2.0F - 1.0F) * state.stereo_spread,
        .active = true,
      };
    }
    instrument.granular_next_frame += std::fmax(1.0, static_cast<double>(core.config.sample_rate_hz) / state.density_hz);
  }
  instrument.granular_next_frame -= 1.0;
  float left = 0.0F;
  float right = 0.0F;
  for (uint32_t index = 0; index < state.max_grains; ++index) {
    GranularGrain &grain = instrument.grains[index];
    if (!grain.active) continue;
    const int64_t base = static_cast<int64_t>(std::floor(grain.cursor));
    if (base < 0 || static_cast<uint64_t>(base + 1) >= asset->frame_count || grain.age >= grain.length) {
      grain = {};
      continue;
    }
    const uint32_t frame = static_cast<uint32_t>(base);
    const float fraction = static_cast<float>(grain.cursor - base);
    const float source_left = asset->planes[0][frame] + (asset->planes[0][frame + 1] - asset->planes[0][frame]) * fraction;
    const uint32_t right_channel = asset->channel_count > 1 ? 1 : 0;
    const float source_right = asset->planes[right_channel][frame]
      + (asset->planes[right_channel][frame + 1] - asset->planes[right_channel][frame]) * fraction;
    const float window = granular_window(state.window_shape, static_cast<float>(grain.age) / std::max(1U, grain.length - 1));
    const float pan = grain.pan;
    left += source_left * window * std::sqrt((1.0F - pan) * 0.5F);
    right += source_right * window * std::sqrt((1.0F + pan) * 0.5F);
    grain.cursor += grain.step;
    ++grain.age;
  }
  *left_output = std::isfinite(left) ? left : 0.0F;
  *right_output = std::isfinite(right) ? right : 0.0F;
}

bool apply_granular_instrument_event(
  InstrumentNodeState &instrument,
  const daw_audio_instrument_event &event) {
  const std::uint32_t type = portable_instrument_event_type(event.type);
  if (type == DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON) {
    uint32_t oldest_index = 0;
    uint32_t empty_index = static_cast<uint32_t>(instrument.granular_note_ids.size());
    for (uint32_t index = 0; index < instrument.granular_note_ids.size(); ++index) {
      const uint64_t note_id = instrument.granular_note_ids[index];
      if (note_id == event.note_id) return true;
      if (note_id == 0) {
        empty_index = index;
        continue;
      }
      if (instrument.granular_note_ages[index] < instrument.granular_note_ages[oldest_index]) {
        oldest_index = index;
      }
    }
    if (instrument.granular_next_note_age == UINT64_MAX) {
      const auto previous_ages = instrument.granular_note_ages;
      for (uint32_t index = 0; index < instrument.granular_note_ids.size(); ++index) {
        if (instrument.granular_note_ids[index] == 0) continue;
        uint64_t rank = 1;
        for (uint32_t other = 0; other < instrument.granular_note_ids.size(); ++other) {
          if (instrument.granular_note_ids[other] != 0
            && previous_ages[other] < previous_ages[index]) ++rank;
        }
        instrument.granular_note_ages[index] = rank;
      }
      instrument.granular_next_note_age = static_cast<uint64_t>(instrument.granular_note_count) + 1;
    }
    const uint32_t target_index = empty_index < instrument.granular_note_ids.size() ? empty_index : oldest_index;
    instrument.granular_note_ids[target_index] = event.note_id;
    instrument.granular_note_ages[target_index] = instrument.granular_next_note_age++;
    if (empty_index < instrument.granular_note_ids.size()) ++instrument.granular_note_count;
    return true;
  }
  if (type == DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF) {
    for (uint32_t index = 0; index < instrument.granular_note_ids.size(); ++index) {
      if (instrument.granular_note_ids[index] == event.note_id) {
        instrument.granular_note_ids[index] = 0;
        instrument.granular_note_ages[index] = 0;
        --instrument.granular_note_count;
        if (instrument.granular_note_count == 0) instrument.grains = {};
        return true;
      }
    }
    return true;
  }
  return type == DAW_AUDIO_INSTRUMENT_EVENT_SUSTAIN || type == DAW_AUDIO_INSTRUMENT_EVENT_EXPRESSION;
}

bool apply_sample_instrument_event(
  Core &core,
  InstrumentNodeState &instrument,
  const daw_audio_instrument_state_descriptor &descriptor,
  const daw_audio_instrument_event &event) {
  const std::uint32_t type = portable_instrument_event_type(event.type);
  if (type == DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF) {
    for (SampleVoice &voice : instrument.sample_voices) if (voice.active && voice.note_id == event.note_id) voice.released = true;
    return true;
  }
  if (type != DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON) return type != DAW_AUDIO_INSTRUMENT_EVENT_PARAMETER;
  const daw_audio_sample_zone *selected = nullptr;
  uint32_t matching_group = 0;
  uint32_t *round_robin_cursor = nullptr;
  for (uint32_t index = 0; index < instrument.sampler.zone_count; ++index) {
    const daw_audio_sample_zone &zone = instrument.zones[index];
    if (event.note >= zone.key_low && event.note <= zone.key_high
      && event.value * 127.0F >= zone.velocity_low && event.value * 127.0F <= zone.velocity_high) {
      matching_group = zone.round_robin_group;
      if (matching_group == 0) {
        selected = &zone;
        break;
      }
      round_robin_cursor = &instrument.round_robin_cursors[matching_group % DAW_AUDIO_CORE_MAX_SAMPLE_ZONES];
      const uint32_t cursor = *round_robin_cursor;
      uint32_t group_count = 0;
      for (uint32_t group_index = 0; group_index < instrument.sampler.zone_count; ++group_index) {
        const daw_audio_sample_zone &candidate = instrument.zones[group_index];
        if (candidate.round_robin_group == matching_group
          && event.note >= candidate.key_low && event.note <= candidate.key_high
          && event.value * 127.0F >= candidate.velocity_low && event.value * 127.0F <= candidate.velocity_high) {
          ++group_count;
        }
      }
      const uint32_t selected_rank = cursor % group_count;
      for (uint32_t group_index = 0; group_index < instrument.sampler.zone_count; ++group_index) {
        const daw_audio_sample_zone &candidate = instrument.zones[group_index];
        if (candidate.round_robin_group != matching_group
          || event.note < candidate.key_low || event.note > candidate.key_high
          || event.value * 127.0F < candidate.velocity_low || event.value * 127.0F > candidate.velocity_high) continue;
        uint32_t rank = 0;
        for (uint32_t other_index = 0; other_index < instrument.sampler.zone_count; ++other_index) {
          const daw_audio_sample_zone &other = instrument.zones[other_index];
          if (other.round_robin_group == matching_group
            && event.note >= other.key_low && event.note <= other.key_high
            && event.value * 127.0F >= other.velocity_low && event.value * 127.0F <= other.velocity_high
            && (other.round_robin_index < candidate.round_robin_index
              || (other.round_robin_index == candidate.round_robin_index && other_index < group_index))) {
            ++rank;
          }
        }
        if (rank == selected_rank) {
          selected = &candidate;
          break;
        }
      }
      if (selected == nullptr) selected = &zone;
      break;
    }
  }
  if (selected == nullptr) return true;
  AssetSlot *asset = find_asset(&core, selected->asset);
  if (asset == nullptr) return false;
  if (round_robin_cursor != nullptr) ++*round_robin_cursor;
  if (instrument.sampler.retrigger != 0) {
    for (SampleVoice &voice : instrument.sample_voices) {
      if (voice.active && voice.note == event.note) {
        voice.released = true;
        voice.forced_release_ms = kSampleTerminationFadeMilliseconds;
      }
    }
  }
  if (selected->choke_group != 0) {
    for (SampleVoice &voice : instrument.sample_voices) {
      if (voice.active && instrument.zones[voice.zone].choke_group == selected->choke_group) {
        voice.released = true;
        voice.forced_release_ms = kSampleTerminationFadeMilliseconds;
      }
    }
  }
  SampleVoice *voice = nullptr;
  for (uint32_t index = 0; index < descriptor.voice_capacity; ++index) {
    if (!instrument.sample_voices[index].active) {
      voice = &instrument.sample_voices[index];
      break;
    }
  }
  if (voice == nullptr) {
    voice = steal_victim(instrument.sample_voices, descriptor.voice_capacity);
    fade_out_voice(instrument.dying_sample_voices, *voice);
  }
  *voice = {.note_id = event.note_id, .note = event.note, .zone = static_cast<uint32_t>(selected - instrument.zones.data()),
    .velocity = event.value, .asset = selected->asset, .start_frame = selected->start_frame, .root_note = selected->root_note,
    .tune_cents = selected->tune_cents, .position = static_cast<double>(selected->start_frame),
    .increment = sample_voice_increment(core, *asset, event.note, *selected), .age = instrument.next_age++, .active = true};
  return true;
}

bool apply_instrument_event(
  InstrumentNodeState &instrument,
  const daw_audio_instrument_state_descriptor &descriptor,
  const daw_audio_instrument_event &event) {
  const uint32_t capacity = descriptor.voice_capacity;
  const std::uint32_t type = portable_instrument_event_type(event.type);
  if (type == DAW_AUDIO_INSTRUMENT_EVENT_PARAMETER) {
    return instrument_declares_target(descriptor, event.note)
      && set_synth_parameter(instrument.synth, event.note, event.value);
  }
  if (type == DAW_AUDIO_INSTRUMENT_EVENT_SUSTAIN) {
    instrument.sustain = event.value >= 0.5F;
    if (!instrument.sustain) {
      for (InstrumentVoice &voice : instrument.voices) {
        if (voice.active && !voice.held && voice.references == 0) voice.released = true;
      }
    }
    return true;
  }
  if (type == DAW_AUDIO_INSTRUMENT_EVENT_EXPRESSION) {
    instrument.expression = event.value;
    return true;
  }
  if (type == DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF) {
    for (InstrumentVoice &voice : instrument.voices) {
      if (voice.active && voice.note_id == event.note_id) {
        if (voice.references > 1) {
          --voice.references;
          return true;
        }
        voice.references = 0;
        voice.held = false;
        voice.released = !instrument.sustain;
        return true;
      }
    }
    return true;
  }
  if (type != DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON) return false;
  for (uint32_t index = 0; index < capacity; ++index) {
    InstrumentVoice &voice = instrument.voices[index];
    if (voice.active && voice.note_id == event.note_id) {
      ++voice.references;
      voice.held = true;
      voice.released = false;
      return true;
    }
    if (!voice.active) {
      voice = new_synth_voice(instrument, instrument.next_age++, event);
      return true;
    }
  }
  InstrumentVoice &victim = *steal_victim(instrument.voices, capacity);
  fade_out_voice(instrument.dying_voices, victim);
  victim = new_synth_voice(instrument, instrument.next_age++, event);
  return true;
}
}  // namespace daw::audio_core_internal
