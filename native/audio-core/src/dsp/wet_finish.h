#pragma once

#include "numeric_safety.h"
#include "parameter_smoother.h"

#include <cmath>
#include <cstdint>

namespace daw::audio_core::dsp {

// What every modulation effect does to its wet signal before the dry/wet mix: two one-pole high-passes in cascade (Safe Bass, 12 dB per octave, -6 dB at the set frequency) so
// the bass is not modulated, Width on the mid/side balance of the wet signal, and the Output gain. Width, Output and the
// high-pass frequency are smoothed. Call next() once per frame, then apply() per frame.
class WetFinish {
 public:
  void prepare(double sampleRate) {
    sampleRate_ = sampleRate;
    for (auto *smoother : {&width_, &output_}) smoother->prepare(sampleRate, kSmoothMs);
    bass_.prepare(sampleRate, kSmoothMs);
    initialized_ = false;
    reset();
  }

  void reset() { low_[0] = low_[1] = low_[2] = low_[3] = 0.0F; }

  void next(float bassHz, float width, float outputDb) {
    if (!initialized_) {
      bass_.reset(bassHz);
      width_.reset(width);
      output_.reset(outputDb);
      initialized_ = true;
    }
    bass_.setTarget(bassHz);
    width_.setTarget(width);
    output_.setTarget(outputDb);
    const float hz = bass_.next();
    if (hz != lastBassHz_) {
      coefficient_ = 1.0F - std::exp(-6.2831853071795864769F * hz / static_cast<float>(sampleRate_));
      lastBassHz_ = hz;
    }
    width_value_ = width_.next();
    const float db = output_.next();
    if (db != lastOutputDb_) {
      gain_ = std::pow(10.0F, db / 20.0F);
      lastOutputDb_ = db;
    }
  }

  void apply(bool safeBass, float &left, float &right) {
    if (safeBass) {
      low_[0] = flushDenormal(low_[0] + coefficient_ * (left - low_[0]));
      low_[1] = flushDenormal(low_[1] + coefficient_ * (right - low_[1]));
      left -= low_[0];
      right -= low_[1];
      low_[2] = flushDenormal(low_[2] + coefficient_ * (left - low_[2]));
      low_[3] = flushDenormal(low_[3] + coefficient_ * (right - low_[3]));
      left -= low_[2];
      right -= low_[3];
    }
    const float mid = 0.5F * (left + right);
    const float side = 0.5F * (left - right) * width_value_;
    left = mid + side;
    right = mid - side;
  }

  float gain() const { return gain_; }

 private:
  static constexpr double kSmoothMs = 12.0;

  double sampleRate_ = 48000.0;
  bool initialized_ = false;
  float low_[4] = {0.0F, 0.0F, 0.0F, 0.0F};
  ParameterSmoother<SmoothDomain::Log> bass_;
  ParameterSmoother<> width_, output_;
  float coefficient_ = 0.0F;
  float lastBassHz_ = -1.0F;
  float width_value_ = 1.0F;
  float gain_ = 1.0F;
  float lastOutputDb_ = -1000.0F;
};

}  // namespace daw::audio_core::dsp
