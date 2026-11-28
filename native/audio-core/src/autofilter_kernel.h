#pragma once

// Auto Filter DSP kernel, independent of the audio-core graph so it can be measured on its own.
//
// Signal path per channel: drive (tanh, antialiased at 2x in Hi-Quality) -> state-variable filter (12 or 24 dB, with a
// runaway guard on the integrator states) -> output gain -> optional soft clip -> dry/wet mix. Hi-Quality runs the
// drive, filter and clip at twice the rate between a half-band pair and delays the dry path by that pair's latency.
#include "dsp/adaa.h"
#include "dsp/half_band_oversampler.h"
#include "dsp/lfo.h"
#include "dsp/numeric_safety.h"
#include "dsp/parameter_smoother.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

namespace daw::audio_core {

struct AutoFilterConfig {
  uint32_t mode = 0;          // 0 low-pass, 1 high-pass, 2 band-pass, 3 notch, 4 peak
  uint32_t slope = 0;         // 0 = 12 dB/oct, 1 = 24 dB/oct
  uint32_t waveform = 0;      // 0 sine, 1 triangle, 2 saw down, 3 saw up, 4 square, 5 sample and hold
  uint32_t stereo_mode = 0;   // 0 = the stereo value offsets the right LFO's phase, 1 = it detunes the right LFO's rate
  uint32_t division = 5;      // index into the tempo-sync table
  bool hi_quality = false;
  bool clip = false;
  bool env_hold = false;      // the envelope finishes its attack before it releases
  bool env_link = false;      // both channels follow the louder of the two
  bool sync = false;          // LFO rate follows the tempo
};

struct AutoFilterValues {
  float frequency_hz = 1000.0F;
  float resonance = 0.0F;
  float drive_db = 0.0F;
  float mix = 1.0F;
  float output_db = 0.0F;
  float env_amount_octaves = 0.0F;
  float env_attack_ms = 10.0F;
  float env_release_ms = 100.0F;
  float lfo_rate_hz = 1.0F;
  float lfo_depth_octaves = 0.0F;
  float lfo_phase_offset = 0.0F;
  float lfo_stereo_phase = 0.0F;
};

class AutoFilterKernel {
 public:
  static constexpr float kMinimumQ = 0.70710678F;
  static constexpr float kMaximumQ = 8.0F;
  static constexpr uint32_t kHistoryFrames = 64;  // power of two above the oversampler latency

  void prepare(double sampleRate) {
    sampleRate_ = sampleRate;
    frequency_.prepare(sampleRate, 8.0);
    for (auto *smoother : {&resonance_, &drive_, &mix_, &output_}) smoother->prepare(sampleRate, 8.0);
    initialized_ = false;
    reset();
  }

  void reset() {
    for (Channel &channel : channels_) channel = Channel{};
    fading_ = false;
    envelope_[0] = envelope_[1] = 0.0F;
    attacking_[0] = attacking_[1] = false;
    held_peak_[0] = held_peak_[1] = 0.0F;
  }

  // Discrete settings may change at any frame; filter type and slope crossfade, quality resets the oversampler.
  void process(const AutoFilterValues &values, const AutoFilterConfig &config, const dsp::LfoTransport &transport, float bypass,
    float inLeft, float inRight, float &outLeft, float &outRight) {
    if (!initialized_) initialize(values, config);
    apply_config(config);
    smooth(values);
    const float input[2] = {std::isfinite(inLeft) ? inLeft : 0.0F, std::isfinite(inRight) ? inRight : 0.0F};
    update_envelope(values, config, input);
    const double base = config.sync ? dsp::lfoSyncRateHz(config.division, transport.tempo_bpm) : values.lfo_rate_hz;
    const bool locked = config.sync && transport.running;
    const double cycles = locked ? static_cast<double>(transport.frame) / sampleRate_ * base : 0.0;
    float output[2] = {0.0F, 0.0F};
    for (uint32_t c = 0; c < 2; ++c) {
      const double detune = (c == 1 && config.stereo_mode == 1) ? 1.0 + values.lfo_stereo_phase : 1.0;
      output[c] = render_channel(c, values, config, base * detune, locked, cycles * detune, input[c], bypass);
    }
    if (fading_ && ++fade_position_ >= fade_frames_) fading_ = false;
    outLeft = output[0];
    outRight = output[1];
  }

  float cutoff_hz(uint32_t channel) const { return channels_[channel].cutoff; }

  static uint32_t latency_frames(bool hiQuality) { return hiQuality ? dsp::HalfBandOversampler2x::latencyFrames() : 0; }

  static float q_from_resonance(float resonance) {
    return kMinimumQ * std::pow(kMaximumQ / kMinimumQ, std::clamp(resonance, 0.0F, 1.0F));
  }

 private:
  struct Stage {
    float ic1 = 0.0F;
    float ic2 = 0.0F;
  };
  struct Path {
    std::array<Stage, 2> stages{};
    uint32_t mode = 0;
    uint32_t slope = 0;
  };
  struct Coefficients {
    float a1 = 1.0F;
    float a2 = 0.0F;
    float a3 = 0.0F;
    float k = 1.0F;
  };
  struct Channel {
    std::array<Path, 2> paths{};
    std::array<Coefficients, 2> coefficients{};
    std::array<bool, 2> valid{};
    dsp::HalfBandOversampler2x oversampler;
    dsp::Adaa1<dsp::TanhShaper> drive_adaa;
    dsp::Adaa1<dsp::TanhShaper> clip_adaa;
    std::array<float, kHistoryFrames> dry{};
    uint32_t write = 0;
    double phase = 0.0;
    uint32_t cycle = 0;
    float cutoff = 1000.0F;
    float last_cutoff = -1.0F;
    float last_q = -1.0F;
  };

  void initialize(const AutoFilterValues &values, const AutoFilterConfig &config) {
    frequency_.reset(values.frequency_hz);
    resonance_.reset(values.resonance);
    drive_.reset(values.drive_db);
    mix_.reset(values.mix);
    output_.reset(values.output_db);
    for (Channel &channel : channels_) {
      channel.paths[0].mode = config.mode;
      channel.paths[0].slope = config.slope;
    }
    applied_ = config;
    initialized_ = true;
  }

  void apply_config(const AutoFilterConfig &config) {
    if (config.hi_quality != applied_.hi_quality) {
      for (Channel &channel : channels_) {
        channel.oversampler.reset();
        channel.drive_adaa.reset();
        channel.clip_adaa.reset();
        channel.dry.fill(0.0F);
        channel.valid.fill(false);  // the filter now runs at the other rate
      }
    }
    if (config.mode != applied_.mode || config.slope != applied_.slope) {
      // The new type starts from silent state and fades in over 10 ms while the old one fades out.
      const uint32_t incoming = 1 - active_;
      for (Channel &channel : channels_) {
        channel.paths[incoming] = Path{};
        channel.paths[incoming].mode = config.mode;
        channel.paths[incoming].slope = config.slope;
        channel.valid.fill(false);
      }
      active_ = incoming;
      fading_ = true;
      fade_position_ = 0;
      fade_frames_ = std::max<uint32_t>(1, static_cast<uint32_t>(0.010 * sampleRate_));
    }
    applied_ = config;
  }

  void smooth(const AutoFilterValues &values) {
    frequency_.setTarget(values.frequency_hz);
    resonance_.setTarget(values.resonance);
    drive_.setTarget(values.drive_db);
    mix_.setTarget(values.mix);
    output_.setTarget(values.output_db);
    base_frequency_ = frequency_.next();
    const float resonance = resonance_.next();
    if (resonance != last_resonance_) {
      q_ = q_from_resonance(resonance);
      last_resonance_ = resonance;
    }
    const float drive = drive_.next();
    if (drive != last_drive_) {
      drive_gain_ = std::pow(10.0F, drive / 20.0F);
      drive_blend_ = std::min(1.0F, drive / 6.0F);
      last_drive_ = drive;
    }
    mix_value_ = mix_.next();
    const float output = output_.next();
    if (output != last_output_) {
      output_gain_ = std::pow(10.0F, output / 20.0F);
      last_output_ = output;
    }
  }

  // The follower runs on the linear peak; its level maps to the modulation through dB so the amount means the same
  // octaves at any input level: -60 dBFS gives none, 0 dBFS gives the full amount.
  void update_envelope(const AutoFilterValues &values, const AutoFilterConfig &config, const float (&input)[2]) {
    const float attack = std::exp(-1.0F / (std::fmax(0.5F, values.env_attack_ms) * 0.001F * static_cast<float>(sampleRate_)));
    const float release = std::exp(-1.0F / (std::fmax(5.0F, values.env_release_ms) * 0.001F * static_cast<float>(sampleRate_)));
    const float linked = std::fmax(std::fabs(input[0]), std::fabs(input[1]));
    for (uint32_t c = 0; c < (config.env_link ? 1U : 2U); ++c) {
      const float level = config.env_link ? linked : std::fabs(input[c]);
      float &env = envelope_[c];
      if (config.env_hold) {
        if (!attacking_[c] && level > env) {
          attacking_[c] = true;
          held_peak_[c] = level;
        }
        if (attacking_[c]) {
          held_peak_[c] = std::fmax(held_peak_[c], level);
          env = attack * env + (1.0F - attack) * held_peak_[c];
          if (env >= 0.95F * held_peak_[c]) attacking_[c] = false;
        } else {
          env = release * env + (1.0F - release) * level;
        }
      } else {
        attacking_[c] = false;
        env = level > env ? attack * env + (1.0F - attack) * level : release * env + (1.0F - release) * level;
      }
      env = dsp::flushDenormal(env);
    }
    if (config.env_link) envelope_[1] = envelope_[0];
  }

  // The state-variable filter is linear and stable at any fixed cutoff and Q, so with Drive 0 and Clip off it must not
  // colour the signal. This guard only catches a runaway under extreme automation or non-finite input: it sits at 60 dB
  // above full scale, far over the integrator states of a +6 dBFS input at Q 8 (about 30), and bends smoothly above it.
  static constexpr float kStateGuard = 1024.0F;
  static float limit_state(float s) {
    const float a = std::fabs(s);
    if (a <= kStateGuard) return s;
    return std::copysign(kStateGuard * (1.0F + 2.0F * std::tanh((a / kStateGuard - 1.0F) * 0.5F)), s);
  }

  static float stage_output(Stage &stage, const Coefficients &c, uint32_t mode, float x) {
    const float v3 = x - stage.ic2;
    const float v1 = c.a1 * stage.ic1 + c.a2 * v3;
    const float v2 = stage.ic2 + c.a2 * stage.ic1 + c.a3 * v3;
    stage.ic1 = dsp::flushDenormal(limit_state(2.0F * v1 - stage.ic1));
    stage.ic2 = dsp::flushDenormal(limit_state(2.0F * v2 - stage.ic2));
    const float band = c.k * v1;
    switch (mode) {
      case 1: return x - band - v2;
      case 2: return band;
      case 3: return x - band;
      case 4: return 2.0F * v2 + band - x;
      default: return v2;
    }
  }

  const Coefficients &coefficients(Channel &channel, uint32_t slope, float cutoff, float rate) {
    if (cutoff != channel.last_cutoff || q_ != channel.last_q) {
      channel.valid.fill(false);
      channel.last_cutoff = cutoff;
      channel.last_q = q_;
    }
    if (!channel.valid[slope]) {
      const float stageQ = slope == 0 ? q_ : std::sqrt(q_);
      const float g = std::tan(3.14159265358979323846F * cutoff / rate);
      const float k = 1.0F / stageQ;
      const float a1 = 1.0F / (1.0F + g * (g + k));
      channel.coefficients[slope] = Coefficients{a1, g * a1, g * g * a1, k};
      channel.valid[slope] = true;
    }
    return channel.coefficients[slope];
  }

  float run_path(Channel &channel, uint32_t index, float cutoff, float rate, float x) {
    Path &path = channel.paths[index];
    const Coefficients &c = coefficients(channel, path.slope, cutoff, rate);
    float y = stage_output(path.stages[0], c, path.mode, x);
    if (path.slope == 1) y = stage_output(path.stages[1], c, path.mode, y);
    return y;
  }

  float filter_sample(Channel &channel, float cutoff, float rate, float x) {
    if (!fading_) return run_path(channel, active_, cutoff, rate, x);
    const float weight = static_cast<float>(fade_position_) / static_cast<float>(fade_frames_);
    const float outgoing = run_path(channel, 1 - active_, cutoff, rate, x);
    const float incoming = run_path(channel, active_, cutoff, rate, x);
    return outgoing + (incoming - outgoing) * weight;
  }

  float drive_sample(Channel &channel, bool hiQuality, float x) {
    if (drive_blend_ <= 0.0F) {
      channel.drive_adaa.reset();
      return x;
    }
    const float u = drive_gain_ * x;
    const float shaped = (hiQuality ? channel.drive_adaa.process(u) : std::tanh(u)) / drive_gain_;
    return x + drive_blend_ * (shaped - x);
  }

  float clip_sample(Channel &channel, bool hiQuality, bool clip, float x) {
    if (!clip) return x;
    return hiQuality ? channel.clip_adaa.process(x) : std::tanh(x);
  }

  // `locked` takes the LFO position from the song (`cycles` since song start) instead of the channel's own counter.
  float render_channel(uint32_t index, const AutoFilterValues &values, const AutoFilterConfig &config, double rate,
    bool locked, double cycles, float input, float bypass) {
    Channel &channel = channels_[index];
    double phase = values.lfo_phase_offset;
    if (index == 1 && config.stereo_mode == 0) phase += values.lfo_stereo_phase;
    uint32_t cycle = 0;
    if (locked) {
      phase += cycles;
    } else {
      phase += channel.phase;
      cycle = channel.cycle;
    }
    const double whole = std::floor(phase);
    const float lfo = dsp::lfoShape(config.waveform, phase - whole, cycle + static_cast<uint32_t>(static_cast<int64_t>(whole)));
    if (!locked) {
      channel.phase += rate / sampleRate_;
      if (channel.phase >= 1.0) {
        const double wraps = std::floor(channel.phase);
        channel.phase -= wraps;
        channel.cycle += static_cast<uint32_t>(wraps);
      }
    }
    const float env_unit = std::clamp((20.0F * std::log10(std::fmax(envelope_[index], 1.0e-6F)) + 60.0F) / 60.0F, 0.0F, 1.0F);
    const float octaves = values.env_amount_octaves * env_unit + values.lfo_depth_octaves * lfo;
    const float cutoff = std::clamp(base_frequency_ * std::exp2(octaves), 20.0F, 0.45F * static_cast<float>(sampleRate_));
    channel.cutoff = cutoff;

    channel.dry[channel.write & (kHistoryFrames - 1)] = input;
    const float dry = channel.dry[(channel.write - latency_frames(config.hi_quality)) & (kHistoryFrames - 1)];
    ++channel.write;

    float wet = 0.0F;
    if (config.hi_quality) {
      const auto pair = channel.oversampler.up(input);
      const float rate2 = static_cast<float>(2.0 * sampleRate_);
      float doubled[2] = {pair.first, pair.second};
      for (float &sample : doubled) {
        sample = filter_sample(channel, cutoff, rate2, drive_sample(channel, true, sample));
        sample = clip_sample(channel, true, config.clip, sample * output_gain_);
      }
      wet = channel.oversampler.down(doubled[0], doubled[1]);
    } else {
      const float filtered = filter_sample(channel, cutoff, static_cast<float>(sampleRate_), drive_sample(channel, false, input));
      wet = clip_sample(channel, false, config.clip, filtered * output_gain_);
    }
    if (!std::isfinite(wet)) {
      channel.paths[0].stages = {};
      channel.paths[1].stages = {};
      channel.oversampler.reset();
      channel.drive_adaa.reset();
      channel.clip_adaa.reset();
      wet = 0.0F;
    }
    const float mixed = dry + (wet - dry) * mix_value_;
    return dsp::flushDenormal(mixed + (dry - mixed) * bypass);
  }

  double sampleRate_ = 48000.0;
  bool initialized_ = false;
  AutoFilterConfig applied_{};
  std::array<Channel, 2> channels_{};
  dsp::ParameterSmoother<dsp::SmoothDomain::Log> frequency_;
  dsp::ParameterSmoother<> resonance_, drive_, mix_, output_;
  float base_frequency_ = 1000.0F;
  float q_ = kMinimumQ;
  float last_resonance_ = -1.0F;
  float drive_gain_ = 1.0F;
  float drive_blend_ = 0.0F;
  float last_drive_ = -1.0F;
  float mix_value_ = 1.0F;
  float output_gain_ = 1.0F;
  float last_output_ = -1000.0F;
  std::array<float, 2> envelope_{};
  std::array<bool, 2> attacking_{};
  std::array<float, 2> held_peak_{};
  uint32_t active_ = 0;
  bool fading_ = false;
  uint32_t fade_position_ = 0;
  uint32_t fade_frames_ = 480;
};

}  // namespace daw::audio_core
