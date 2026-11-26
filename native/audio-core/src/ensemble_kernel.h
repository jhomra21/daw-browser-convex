#pragma once

// Ensemble kernel: three delay lines like a Solina string ensemble. Each line's delay is moved by a slow and a fast
// 3-phase LFO whose phases sit a third of a cycle apart, so the three taps never agree. Spread offsets the left and
// right LFO phases of each line. The three lines sum at 1/sqrt(3): uncorrelated voices then keep the input's level.
#include "dsp/fractional_delay.h"
#include "dsp/lfo.h"
#include "dsp/parameter_smoother.h"
#include "dsp/wet_finish.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

namespace daw::audio_core {

struct EnsembleValues {
  float delay_ms = 18.0F;
  float depth_ms = 6.0F;
  float rate_hz = 0.6F;
  float spread = 1.0F;
  float mix = 0.5F;
  float fast_depth_ms = 0.0F;
  float fast_rate_hz = 6.0F;
  float safe_bass_hz = 20.0F;
  float width = 1.0F;
  float output_db = 0.0F;
};

struct EnsembleConfig {
  uint32_t waveform = 0;  // dsp::lfoShape
  bool safe_bass = false;
};

class EnsembleKernel {
 public:
  static constexpr uint32_t kVoices = 3;
  static constexpr double kMaximumLineMs = 46.0;

  void prepare(double sampleRate) {
    sampleRate_ = sampleRate;
    for (dsp::DelayRing<float> &line : lines_) line.prepare(static_cast<uint32_t>(std::ceil(kMaximumLineMs * 0.001 * sampleRate)) + 8U);
    for (auto *smoother : {&delay_, &depth_, &spread_, &mix_, &fast_depth_}) smoother->prepare(sampleRate, kSmoothMs);
    finish_.prepare(sampleRate);
    initialized_ = false;
    reset();
  }

  void reset() {
    for (dsp::DelayRing<float> &line : lines_) line.reset();
    finish_.reset();
    slow_ = {};
    fast_ = {};
  }

  void process(const EnsembleValues &values, const EnsembleConfig &config, float bypass, float inLeft, float inRight,
    float &outLeft, float &outRight) {
    if (!initialized_) initialize(values);
    delay_.setTarget(values.delay_ms);
    depth_.setTarget(values.depth_ms);
    spread_.setTarget(values.spread);
    mix_.setTarget(values.mix);
    fast_depth_.setTarget(values.fast_depth_ms);
    const float delayMs = delay_.next();
    const float depthMs = depth_.next();
    const float spread = spread_.next();
    const float mix = mix_.next();
    const float fastDepthMs = fast_depth_.next();
    finish_.next(values.safe_bass_hz, values.width, values.output_db);

    const float framesPerMs = static_cast<float>(sampleRate_ * 0.001);
    const float input[2] = {std::isfinite(inLeft) ? inLeft : 0.0F, std::isfinite(inRight) ? inRight : 0.0F};
    float wet[2] = {0.0F, 0.0F};
    for (uint32_t c = 0; c < 2; ++c) lines_[c].push(input[c]);
    for (uint32_t voice = 0; voice < kVoices; ++voice) {
      const double third = static_cast<double>(voice) / kVoices;
      const double offset = static_cast<double>(spread * (static_cast<float>(voice) - 1.0F) * 0.25F);
      for (uint32_t c = 0; c < 2; ++c) {
        const double shifted = third + (c == 0 ? -offset : offset);
        const float lfo = depthMs * slow_.shape(config.waveform, shifted) + fastDepthMs * fast_.shape(config.waveform, shifted);
        const float limit = static_cast<float>(lines_[c].capacity() - 4U);
        wet[c] += lines_[c].readHermiteOrLinear(std::clamp((delayMs + lfo) * framesPerMs, 0.0F, limit));
      }
    }
    slow_.advance(static_cast<double>(values.rate_hz) / sampleRate_);
    fast_.advance(static_cast<double>(values.fast_rate_hz) / sampleRate_);
    for (float &sample : wet) sample *= kVoiceGain;
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
  static constexpr float kVoiceGain = 0.57735026918962576451F;  // 1 / sqrt(3)

  void initialize(const EnsembleValues &values) {
    delay_.reset(values.delay_ms);
    depth_.reset(values.depth_ms);
    spread_.reset(values.spread);
    mix_.reset(values.mix);
    fast_depth_.reset(values.fast_depth_ms);
    initialized_ = true;
  }

  double sampleRate_ = 48000.0;
  bool initialized_ = false;
  std::array<dsp::DelayRing<float>, 2> lines_{};
  dsp::ParameterSmoother<> delay_, depth_, spread_, mix_, fast_depth_;
  dsp::WetFinish finish_;
  dsp::LfoClock slow_;
  dsp::LfoClock fast_;
};

}  // namespace daw::audio_core
