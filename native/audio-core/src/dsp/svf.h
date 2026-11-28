#pragma once

#include "numeric_safety.h"

#include <algorithm>
#include <cmath>

namespace daw::audio_core::dsp {

enum class SvfMode { LowPass, BandPass, HighPass, Notch, Peak, AllPass, Bell, LowShelf, HighShelf };

// Cytomic/Simper trapezoidal-integrated state variable filter (bilinear, so it warps toward Nyquist like RBJ; its
// strengths are low-frequency numerics and safe per-sample coefficient changes). out = m0 * x + m1 * band + m2 * low.
// q is the resonance (the pole Q); for Bell and the shelves it is the RBJ-prototype Q and gainDb the boost or cut.
// BandPass has unity gain at the centre frequency; Peak is the high-pass minus the low-pass (gain 2Q at the centre).
struct SvfCoefficients {
  double a1 = 1.0;
  double a2 = 0.0;
  double a3 = 0.0;
  double m0 = 1.0;
  double m1 = 0.0;
  double m2 = 0.0;
};

inline SvfCoefficients designSvf(SvfMode mode, double frequency, double sampleRate, double q, double gainDb = 0.0) {
  constexpr double kPi = 3.14159265358979323846;
  const double bounded = std::clamp(frequency, 1.0, 0.499 * sampleRate);
  const double resonance = std::max(q, 0.01);
  const double a = std::pow(10.0, gainDb / 40.0);
  double g = std::tan(kPi * bounded / sampleRate);
  double k = 1.0 / resonance;
  double m0 = 0.0, m1 = 0.0, m2 = 0.0;
  switch (mode) {
    case SvfMode::LowPass: m2 = 1.0; break;
    case SvfMode::BandPass: m1 = k; break;
    case SvfMode::HighPass: m0 = 1.0; m1 = -k; m2 = -1.0; break;
    case SvfMode::Notch: m0 = 1.0; m1 = -k; break;
    case SvfMode::Peak: m0 = 1.0; m1 = -k; m2 = -2.0; break;
    case SvfMode::AllPass: m0 = 1.0; m1 = -2.0 * k; break;
    case SvfMode::Bell: k = 1.0 / (resonance * a); m0 = 1.0; m1 = k * (a * a - 1.0); break;
    case SvfMode::LowShelf: g /= std::sqrt(a); m0 = 1.0; m1 = k * (a - 1.0); m2 = a * a - 1.0; break;
    case SvfMode::HighShelf: g *= std::sqrt(a); m0 = a * a; m1 = k * (1.0 - a) * a; m2 = 1.0 - a * a; break;
  }
  const double a1 = 1.0 / (1.0 + g * (g + k));
  return SvfCoefficients{a1, g * a1, g * g * a1, m0, m1, m2};
}

// Coefficients are an argument of process() so a processor can pass new ones every sample.
template <class State = float>
class Svf {
 public:
  void reset() { ic1_ = ic2_ = State(0); }

  State process(State input, const SvfCoefficients &c) {
    const State v3 = input - ic2_;
    const State v1 = static_cast<State>(c.a1) * ic1_ + static_cast<State>(c.a2) * v3;
    const State v2 = ic2_ + static_cast<State>(c.a2) * ic1_ + static_cast<State>(c.a3) * v3;
    ic1_ = flushDenormal(State(2) * v1 - ic1_);
    ic2_ = flushDenormal(State(2) * v2 - ic2_);
    return finiteOrReset(*this, static_cast<State>(c.m0) * input + static_cast<State>(c.m1) * v1 + static_cast<State>(c.m2) * v2);
  }

 private:
  State ic1_ = State(0);
  State ic2_ = State(0);
};

}  // namespace daw::audio_core::dsp
