#pragma once

// Chorus and Flanger kernel, independent of the audio-core graph so it can be measured on its own.
//
// Per channel the input and the feedback go into one delay line (Hermite reads). The feedback tap is read before the
// new sample is written, so the loop is exactly as long as the tap's delay (2 frames at the shortest). The audible tap
// may go down to zero delay. Through-zero flanging delays the dry path by a fixed time, so the wet tap sweeps from
// before the dry signal to after it; that fixed time is the effect's declared latency. In that mode Delay and Depth
// are measured from the delayed dry path, so a Depth larger than Delay crosses it. Vintage runs the line like a
// bucket-brigade device: a low-pass before and after it at the clock's Nyquist, with a soft saturation going in.
#include "dsp/fractional_delay.h"
#include "dsp/latency.h"
#include "dsp/lfo.h"
#include "dsp/numeric_safety.h"
#include "dsp/parameter_smoother.h"
#include "dsp/wet_finish.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

namespace daw::audio_core {

enum class ChorusMode : uint32_t { Chorus = 0, Vibrato = 1, Vintage = 2, Flanger = 3, ThroughZero = 4 };

struct ChorusValues {
  float delay_ms = 12.0F;
  float depth_ms = 4.0F;
  float rate_hz = 0.8F;
  float feedback = 0.0F;
  float stereo_phase = 0.25F;
  float mix = 0.35F;
  float safe_bass_hz = 20.0F;
  float width = 1.0F;
  float output_db = 0.0F;
};

struct ChorusConfig {
  ChorusMode mode = ChorusMode::Chorus;
  uint32_t waveform = 0;  // dsp::lfoShape
  bool safe_bass = false;
};

class ChorusKernel {
 public:
  static constexpr float kThroughZeroDryMs = 5.0F;
  static constexpr double kMaximumLineMs = 40.5;
  static constexpr float kMinimumLoopFrames = 2.0F;
  static constexpr float kBbdStages = 1024.0F;
  static constexpr uint32_t kControlFrames = 8;

  static uint32_t latency_frames(ChorusMode mode, double sampleRate) {
    return mode == ChorusMode::ThroughZero ? dsp::Latency::fromMilliseconds(kThroughZeroDryMs, sampleRate).frames : 0U;
  }

  void prepare(double sampleRate) {
    sampleRate_ = sampleRate;
    for (Channel &channel : channels_) {
      channel.line.prepare(static_cast<uint32_t>(std::ceil(kMaximumLineMs * 0.001 * sampleRate)) + 8U);
      channel.dry.prepare(static_cast<uint32_t>(std::ceil(kThroughZeroDryMs * 0.001 * sampleRate)) + 8U);
    }
    for (auto *smoother : {&delay_, &depth_, &feedback_, &stereo_, &mix_}) smoother->prepare(sampleRate, kSmoothMs);
    finish_.prepare(sampleRate);
    initialized_ = false;
    reset();
  }

  void reset() {
    for (Channel &channel : channels_) {
      channel.line.reset();
      channel.dry.reset();
      channel.pre = channel.post = {};
    }
    finish_.reset();
    clock_ = {};
    frame_ = 0;
  }

  void process(const ChorusValues &values, const ChorusConfig &config, float bypass, float inLeft, float inRight,
    float &outLeft, float &outRight) {
    if (!initialized_) initialize(values);
    delay_.setTarget(values.delay_ms);
    depth_.setTarget(values.depth_ms);
    feedback_.setTarget(values.feedback);
    stereo_.setTarget(values.stereo_phase);
    mix_.setTarget(values.mix);
    const float delayMs = delay_.next();
    const float depthMs = depth_.next();
    const float stereo = stereo_.next();
    const bool vibrato = config.mode == ChorusMode::Vibrato;
    const bool vintage = config.mode == ChorusMode::Vintage;
    const bool throughZero = config.mode == ChorusMode::ThroughZero;
    const float smoothedFeedback = feedback_.next();
    const float smoothedMix = mix_.next();
    const float feedback = vibrato ? 0.0F : smoothedFeedback;
    const float mix = vibrato ? 1.0F : smoothedMix;
    finish_.next(values.safe_bass_hz, values.width, values.output_db);
    if ((frame_++ & (kControlFrames - 1U)) == 0U) bbd_coefficient_ = bbd_coefficient(delayMs);

    const float framesPerMs = static_cast<float>(sampleRate_ * 0.001);
    const float tapMs = delayMs + (throughZero ? kThroughZeroDryMs : 0.0F);
    const uint32_t dryFrames = latency_frames(ChorusMode::ThroughZero, sampleRate_);
    const float input[2] = {std::isfinite(inLeft) ? inLeft : 0.0F, std::isfinite(inRight) ? inRight : 0.0F};
    float wet[2];
    float dry[2];
    for (uint32_t c = 0; c < 2; ++c) {
      Channel &channel = channels_[c];
      const float lfo = clock_.shape(config.waveform, c == 1 ? static_cast<double>(stereo) : 0.0);
      const float limit = static_cast<float>(channel.line.capacity() - 4U);
      const float frames = std::clamp((tapMs + depthMs * lfo) * framesPerMs, 0.0F, limit);
      const float loop = std::max(frames, kMinimumLoopFrames);
      const float fed = channel.line.readHermite(loop - 1.0F);
      float written = input[c] + feedback * fed;
      if (vintage) written = saturate(lowpass(channel.pre, written));
      channel.line.push(dsp::flushDenormal(written));
      float tap = frames >= kMinimumLoopFrames ? fed : channel.line.readHermiteOrLinear(frames);
      if (vintage) tap = lowpass(channel.post, tap);
      wet[c] = tap;
      channel.dry.push(input[c]);
      dry[c] = throughZero ? channel.dry.read(dryFrames) : input[c];
    }
    clock_.advance(static_cast<double>(values.rate_hz) / sampleRate_);
    finish_.apply(config.safe_bass, wet[0], wet[1]);
    const float gain = finish_.gain();
    float out[2];
    for (uint32_t c = 0; c < 2; ++c) {
      const float mixed = (dry[c] * (1.0F - mix) + wet[c] * mix) * gain;
      out[c] = mixed + (dry[c] - mixed) * bypass;
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

  struct Lowpass {
    float first = 0.0F;
    float second = 0.0F;
  };

  struct Channel {
    dsp::DelayRing<float> line;
    dsp::DelayRing<float> dry;
    Lowpass pre;
    Lowpass post;
  };

  void initialize(const ChorusValues &values) {
    delay_.reset(values.delay_ms);
    depth_.reset(values.depth_ms);
    feedback_.reset(values.feedback);
    stereo_.reset(values.stereo_phase);
    mix_.reset(values.mix);
    initialized_ = true;
  }

  // A bucket-brigade line with kBbdStages stages is clocked at stages / (2 delay): its Nyquist sets the filters.
  float bbd_coefficient(float delayMs) const {
    const float clock = kBbdStages / (2.0F * std::max(delayMs, 0.05F) * 0.001F);
    const float cutoff = std::min(0.4F * clock, 0.45F * static_cast<float>(sampleRate_));
    return 1.0F - std::exp(-6.2831853071795864769F * cutoff / static_cast<float>(sampleRate_));
  }

  float lowpass(Lowpass &state, float x) const {
    state.first = dsp::flushDenormal(state.first + bbd_coefficient_ * (x - state.first));
    state.second = dsp::flushDenormal(state.second + bbd_coefficient_ * (state.first - state.second));
    return state.second;
  }

  static float saturate(float x) { return std::tanh(1.2F * x) / 1.2F; }

  double sampleRate_ = 48000.0;
  bool initialized_ = false;
  std::array<Channel, 2> channels_{};
  dsp::ParameterSmoother<> delay_, depth_, feedback_, stereo_, mix_;
  dsp::WetFinish finish_;
  dsp::LfoClock clock_;
  float bbd_coefficient_ = 1.0F;
  uint32_t frame_ = 0;
};

}  // namespace daw::audio_core
