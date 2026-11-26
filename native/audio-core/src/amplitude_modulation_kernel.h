#pragma once

// Tremolo and Auto Pan kernel, independent of the audio-core graph so it can be measured on its own.
//
// One LFO per channel. Phase offsets both channels (where a synced LFO starts in the bar); Stereo Phase offsets the
// right channel only. The LFO's unipolar value is bent by Shape (an exponent, 1 at Shape 0.5) and then drives
//   Tremolo:  gain = (1 - depth + depth * shaped) / (1 - depth + depth * mean), where mean is the shape's average over
//             one cycle, so the average gain is 1 whatever Depth is;
//   Auto Pan: each channel's gain is the equal-power curve (sine of a quarter-cycle angle) of its own LFO, as in Live's two
//             LFOs driving the left and right amplitudes. At Stereo Phase 0.5 (180 degrees, Auto Pan's default) the LFOs are
//             opposite, so the pair holds constant power and sits at -3 dB in the centre; at 0 both channels move together.
// Square and random shapes are slewed for a couple of milliseconds so their steps do not click.
// With Sync on and the transport running, the LFO phase comes from the song position.
#include "dsp/lfo.h"
#include "dsp/numeric_safety.h"
#include "dsp/parameter_smoother.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

namespace daw::audio_core {

enum class AmplitudeKind : uint32_t { Tremolo = 0, AutoPan = 1 };

struct AmplitudeValues {
  float rate_hz = 4.0F;
  float depth = 0.5F;
  float shape = 0.5F;
  float phase = 0.0F;         // cycles, both channels
  float stereo_phase = 0.0F;  // cycles, right channel only
};

struct AmplitudeConfig {
  AmplitudeKind kind = AmplitudeKind::Tremolo;
  uint32_t waveform = 0;  // dsp::lfoShape
  uint32_t division = 5;  // index into the tempo-sync table
  bool sync = false;
  bool invert = false;
};

class AmplitudeModulationKernel {
 public:
  static constexpr uint32_t kControlFrames = 8;
  static constexpr uint32_t kSquare = 4;
  static constexpr uint32_t kSampleAndHold = 5;

  void prepare(double sampleRate) {
    sampleRate_ = sampleRate;
    for (auto *smoother : {&depth_, &shape_, &phase_, &stereo_}) smoother->prepare(sampleRate, kSmoothMs);
    slew_coefficient_ = static_cast<float>(1.0 - std::exp(-1000.0 / (kSlewMs * sampleRate)));
    initialized_ = false;
    reset();
  }

  void reset() {
    clock_ = {};
    slew_ = {};
    frame_ = 0;
  }

  // Average of the shaped unipolar LFO over a cycle, for an exponent > 0. The sine's is the Beta-function integral
  // of cos^(2 exponent); the stepped square only visits 0 and 1; the other shapes are uniform on [0, 1].
  static float mean_shaped(uint32_t waveform, float exponent) {
    if (waveform == 0) return std::exp(std::lgamma(exponent + 0.5F) - std::lgamma(exponent + 1.0F)) * 0.56418958354775628695F;
    if (waveform == kSquare) return 0.5F;
    return 1.0F / (exponent + 1.0F);
  }

  void process(const AmplitudeValues &values, const AmplitudeConfig &config, const dsp::LfoTransport &transport,
    float bypass, float inLeft, float inRight, float &outLeft, float &outRight) {
    if (!initialized_) initialize(values);
    depth_.setTarget(values.depth);
    shape_.setTarget(values.shape);
    phase_.setTarget(values.phase);
    stereo_.setTarget(values.stereo_phase);
    const float depth = depth_.next();
    const float shape = shape_.next();
    const float phase = phase_.next();
    const float stereo = stereo_.next();
    if ((frame_++ & (kControlFrames - 1U)) == 0U) {
      exponent_ = std::exp2(4.0F * (shape - 0.5F));
      mean_ = mean_shaped(config.waveform, exponent_);
    }

    const double base = config.sync ? dsp::lfoSyncRateHz(config.division, transport.tempo_bpm) : values.rate_hz;
    const bool locked = config.sync && transport.running;
    const double cycles = locked ? static_cast<double>(transport.frame) / sampleRate_ * base : 0.0;
    const bool stepped = config.waveform == kSquare || config.waveform == kSampleAndHold;
    const float input[2] = {std::isfinite(inLeft) ? inLeft : 0.0F, std::isfinite(inRight) ? inRight : 0.0F};
    float shaped[2];
    for (uint32_t c = 0; c < 2; ++c) {
      const double offset = static_cast<double>(phase) + (c == 1 ? static_cast<double>(stereo) : 0.0);
      float lfo = locked ? dsp::lfoAtPhase(config.waveform, cycles + offset, 0) : clock_.shape(config.waveform, offset);
      if (config.invert) lfo = -lfo;
      const float unipolar = std::clamp(0.5F + 0.5F * lfo, 0.0F, 1.0F);
      const float bent = exponent_ == 1.0F ? unipolar : std::pow(unipolar, exponent_);
      slew_[c] = stepped ? slew_[c] + slew_coefficient_ * (bent - slew_[c]) : bent;
      shaped[c] = slew_[c];
    }
    clock_.advance(base / sampleRate_);

    float gain[2];
    if (config.kind == AmplitudeKind::Tremolo) {
      const float average = 1.0F - depth + depth * mean_;
      for (uint32_t c = 0; c < 2; ++c) gain[c] = (1.0F - depth + depth * shaped[c]) / average;
    } else {
      // Each channel's angle runs 0 (silent) to 0.25 (full) in cycles; opposite LFOs make the two angles sum to 0.25.
      const float angleLeft = (depth * (2.0F * shaped[0] - 1.0F) + 1.0F) * 0.125F;
      const float angleRight = (depth * (2.0F * shaped[1] - 1.0F) + 1.0F) * 0.125F;
      gain[0] = dsp::fastSineCycles(angleLeft);
      gain[1] = dsp::fastSineCycles(angleRight);
    }
    float out[2];
    for (uint32_t c = 0; c < 2; ++c) {
      const float processed = input[c] * gain[c];
      out[c] = processed + (input[c] - processed) * bypass;
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
  static constexpr double kSlewMs = 2.0;

  void initialize(const AmplitudeValues &values) {
    depth_.reset(values.depth);
    shape_.reset(values.shape);
    phase_.reset(values.phase);
    stereo_.reset(values.stereo_phase);
    initialized_ = true;
  }

  double sampleRate_ = 48000.0;
  bool initialized_ = false;
  dsp::ParameterSmoother<> depth_, shape_, phase_, stereo_;
  dsp::LfoClock clock_;
  std::array<float, 2> slew_{};
  float slew_coefficient_ = 1.0F;
  float exponent_ = 1.0F;
  float mean_ = 0.5F;
  uint32_t frame_ = 0;
};

}  // namespace daw::audio_core
