#pragma once

// Phaser kernel: a chain of first-order all-pass stages per channel, the LFO moving their frequencies.
//
// The feedback loop has no delay in it. A chain of stages is linear in its input, y = G u + P, where G (the product of
// the stage coefficients) and P (what the stage memories contribute) are known before the sample is: the loop
// u = x + fb y then solves in closed form. The feedback term goes through a soft limiter that is transparent below
// -12 dBFS and ends at -6 dBFS, so a high feedback setting bends the peaks instead of running away.
// Stage coefficients come from the LFO once per kControlFrames and ramp linearly between those points.
// Spread fans the stage frequencies apart (in octaves across the chain); Blend moves the LFO's reach from the centre
// frequency to the spread.
#include "dsp/lfo.h"
#include "dsp/numeric_safety.h"
#include "dsp/parameter_smoother.h"
#include "dsp/wet_finish.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

namespace daw::audio_core {

struct PhaserValues {
  float center_hz = 1000.0F;
  float depth_octaves = 3.0F;
  float rate_hz = 0.3F;
  float feedback = 0.3F;
  float stereo_phase = 0.5F;
  float mix = 0.5F;
  float spread_octaves = 0.0F;
  float blend = 0.0F;
  float safe_bass_hz = 20.0F;
  float output_db = 0.0F;
};

struct PhaserConfig {
  uint32_t stages = 6;    // 4, 6, 8 or 12
  uint32_t waveform = 0;  // dsp::lfoShape
  bool safe_bass = false;
};

class PhaserKernel {
 public:
  static constexpr uint32_t kMaximumStages = 12;
  static constexpr uint32_t kControlFrames = 8;
  static constexpr float kLimiterKnee = 0.25F;
  static constexpr float kLimiterCeiling = 0.5F;

  void prepare(double sampleRate) {
    sampleRate_ = sampleRate;
    center_.prepare(sampleRate, kSmoothMs);
    for (auto *smoother : {&depth_, &feedback_, &stereo_, &mix_, &spread_, &blend_}) smoother->prepare(sampleRate, kSmoothMs);
    finish_.prepare(sampleRate);
    initialized_ = false;
    reset();
  }

  void reset() {
    for (Channel &channel : channels_) channel = Channel{};
    finish_.reset();
    clock_ = {};
    frame_ = 0;
    applied_stages_ = 0;
  }

  static float soft_limit(float x) {
    const float magnitude = std::fabs(x);
    if (magnitude <= kLimiterKnee) return x;
    const float room = kLimiterCeiling - kLimiterKnee;
    return std::copysign(kLimiterKnee + room * std::tanh((magnitude - kLimiterKnee) / room), x);
  }

  void process(const PhaserValues &values, const PhaserConfig &config, float bypass, float inLeft, float inRight,
    float &outLeft, float &outRight) {
    if (!initialized_) initialize(values);
    center_.setTarget(values.center_hz);
    depth_.setTarget(values.depth_octaves);
    feedback_.setTarget(values.feedback);
    stereo_.setTarget(values.stereo_phase);
    mix_.setTarget(values.mix);
    spread_.setTarget(values.spread_octaves);
    blend_.setTarget(values.blend);
    center_value_ = center_.next();
    depth_value_ = depth_.next();
    const float feedback = feedback_.next();
    stereo_value_ = stereo_.next();
    const float mix = mix_.next();
    spread_value_ = spread_.next();
    blend_value_ = blend_.next();
    finish_.next(values.safe_bass_hz, 1.0F, values.output_db);
    if ((frame_++ & (kControlFrames - 1U)) == 0U) retarget(config);

    const float input[2] = {std::isfinite(inLeft) ? inLeft : 0.0F, std::isfinite(inRight) ? inRight : 0.0F};
    float wet[2];
    for (uint32_t c = 0; c < 2; ++c) wet[c] = run_chain(channels_[c], config.stages, feedback, input[c]);
    clock_.advance(static_cast<double>(values.rate_hz) / sampleRate_);
    finish_.apply(config.safe_bass, wet[0], wet[1]);
    const float gain = finish_.gain();
    float out[2];
    for (uint32_t c = 0; c < 2; ++c) {
      const float mixed = (input[c] * (1.0F - mix) + wet[c] * mix) * gain;
      out[c] = mixed + (input[c] - mixed) * bypass;
    }
    if (!std::isfinite(out[0]) || !std::isfinite(out[1])) {
      reset();
      out[0] = out[1] = 0.0F;
    }
    outLeft = out[0];
    outRight = out[1];
  }

 private:
  static constexpr double kSmoothMs = 12.0;

  struct Channel {
    std::array<float, kMaximumStages> coefficient{};
    std::array<float, kMaximumStages> target{};
    std::array<float, kMaximumStages> step{};
    std::array<float, kMaximumStages> x1{};
    std::array<float, kMaximumStages> y1{};
  };

  void initialize(const PhaserValues &values) {
    center_.reset(values.center_hz);
    depth_.reset(values.depth_octaves);
    feedback_.reset(values.feedback);
    stereo_.reset(values.stereo_phase);
    mix_.reset(values.mix);
    spread_.reset(values.spread_octaves);
    blend_.reset(values.blend);
    initialized_ = true;
  }

  float stage_coefficient(float octaves) const {
    const float frequency = std::clamp(center_value_ * std::exp2(octaves), 20.0F, 0.49F * static_cast<float>(sampleRate_));
    const float tangent = std::tan(3.14159265358979323846F * frequency / static_cast<float>(sampleRate_));
    return (tangent - 1.0F) / (tangent + 1.0F);
  }

  void retarget(const PhaserConfig &config) {
    const bool snap = applied_stages_ != config.stages;
    const bool uniform = spread_value_ == 0.0F && blend_value_ == 0.0F;
    for (uint32_t c = 0; c < 2; ++c) {
      Channel &channel = channels_[c];
      const float lfo = clock_.shape(config.waveform, c == 1 ? static_cast<double>(stereo_value_) : 0.0);
      const float sweep = depth_value_ * lfo;
      float shared = 0.0F;
      if (uniform) shared = stage_coefficient(sweep);
      for (uint32_t k = 0; k < config.stages; ++k) {
        float next = shared;
        if (!uniform) {
          const float position = config.stages > 1 ? static_cast<float>(k) / static_cast<float>(config.stages - 1) - 0.5F : 0.0F;
          next = stage_coefficient(sweep * (1.0F - blend_value_) + (spread_value_ + blend_value_ * sweep) * position);
        }
        if (snap) channel.coefficient[k] = next;
        channel.target[k] = next;
        channel.step[k] = (next - channel.coefficient[k]) / static_cast<float>(kControlFrames);
      }
    }
    applied_stages_ = config.stages;
  }

  float run_chain(Channel &channel, uint32_t stages, float feedback, float x) {
    float gain = 1.0F;
    float past = 0.0F;
    std::array<float, kMaximumStages> memory;
    for (uint32_t k = 0; k < stages; ++k) {
      channel.coefficient[k] += channel.step[k];
      const float c = channel.coefficient[k];
      memory[k] = channel.x1[k] - c * channel.y1[k];
      gain *= c;
      past = c * past + memory[k];
    }
    float u = (x + feedback * past) / (1.0F - feedback * gain);
    const float fed = feedback * (gain * u + past);
    if (std::fabs(fed) > kLimiterKnee) u = x + soft_limit(fed);
    float value = u;
    for (uint32_t k = 0; k < stages; ++k) {
      const float out = channel.coefficient[k] * value + memory[k];
      channel.x1[k] = dsp::flushDenormal(value);
      channel.y1[k] = dsp::flushDenormal(out);
      value = out;
    }
    return value;
  }

  double sampleRate_ = 48000.0;
  bool initialized_ = false;
  std::array<Channel, 2> channels_{};
  dsp::ParameterSmoother<dsp::SmoothDomain::Log> center_;
  dsp::ParameterSmoother<> depth_, feedback_, stereo_, mix_, spread_, blend_;
  dsp::WetFinish finish_;
  dsp::LfoClock clock_;
  float center_value_ = 1000.0F;
  float depth_value_ = 0.0F;
  float stereo_value_ = 0.0F;
  float spread_value_ = 0.0F;
  float blend_value_ = 0.0F;
  uint32_t frame_ = 0;
  uint32_t applied_stages_ = 0;
};

}  // namespace daw::audio_core
