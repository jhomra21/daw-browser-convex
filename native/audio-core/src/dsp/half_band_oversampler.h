#pragma once

#include "latency.h"

#include <array>
#include <cmath>
#include <cstdint>

namespace daw::audio_core::dsp {

// 2x linear-phase half-band oversampler (Kaiser window, beta 10, 127 taps). Both directions use the same filter.
//   Passband: ripple under 0.01 dB to 0.40 fs_in.
//   Stopband: at least 90 dB of rejection above 0.55 fs_in (the down filter's aliasing band, the up filter's images).
//   Latency: up then down delays the signal by exactly latencyFrames() base-rate frames (63).
// A half-band has every second tap zero, so each direction costs one multiply per two taps, folded by symmetry.
// The filter is a pure FIR: there is no recursive state to flush, and a non-finite input leaves after kHalfLength * 2
// samples or on reset().
class HalfBandOversampler2x {
 public:
  struct Pair {
    float first;
    float second;
  };

  static constexpr uint32_t kHalfLength = 32;                          // M: filter has 4M - 1 taps
  static constexpr uint32_t kHistory = 2 * kHalfLength;                // power of two
  static constexpr uint32_t latencyFrames() { return 2 * kHalfLength - 1; }
  static constexpr Latency latency() { return Latency::fromFrames(latencyFrames()); }

  HalfBandOversampler2x() { design(); }

  void reset() {
    input_.fill(0.0F);
    even_.fill(0.0F);
    odd_.fill(0.0F);
    inputWrite_ = evenWrite_ = oddWrite_ = 0;
  }

  // One base-rate sample in, two doubled-rate samples out (in time order).
  Pair up(float x) {
    input_[inputWrite_++ & kMask] = x;
    return Pair{2.0F * fold(input_, inputWrite_), at(input_, inputWrite_, kHalfLength - 1)};
  }

  // Two doubled-rate samples (in time order) in, one base-rate sample out.
  float down(float first, float second) {
    even_[evenWrite_++ & kMask] = first;
    const float y = fold(even_, evenWrite_) + 0.5F * at(odd_, oddWrite_, kHalfLength - 1);
    odd_[oddWrite_++ & kMask] = second;
    return y;
  }

 private:
  static constexpr uint32_t kMask = kHistory - 1;

  using History = std::array<float, kHistory>;

  static float at(const History &history, uint32_t write, uint32_t age) { return history[(write - 1 - age) & kMask]; }

  float fold(const History &history, uint32_t write) const {
    float sum = 0.0F;
    for (uint32_t j = 0; j < kHalfLength; ++j) {
      sum += taps_[j] * (at(history, write, j) + at(history, write, kHistory - 1 - j));
    }
    return sum;
  }

  static double besselI0(double x) {
    double sum = 1.0;
    double term = 1.0;
    for (int k = 1; k < 60; ++k) {
      term *= (x / (2.0 * k)) * (x / (2.0 * k));
      sum += term;
    }
    return sum;
  }

  // taps_[j] = h[2j] of the windowed-sinc half-band, whose centre tap 0.5 and zero odd-offset taps are not stored.
  // The non-centre taps are scaled so the half-band sums to exactly 1 (unity DC gain in both directions).
  void design() {
    constexpr double kBeta = 10.0;
    constexpr int kCentre = 2 * kHalfLength - 1;
    constexpr double kPi = 3.14159265358979323846;
    std::array<double, kHistory> raw{};
    double side = 0.0;
    for (uint32_t j = 0; j < kHistory; ++j) {
      const int offset = static_cast<int>(2 * j) - kCentre;
      const double ratio = static_cast<double>(offset) / kCentre;
      const double window = besselI0(kBeta * std::sqrt(1.0 - ratio * ratio)) / besselI0(kBeta);
      raw[j] = std::sin(kPi * offset / 2.0) / (kPi * offset) * window;
      side += raw[j];
    }
    for (uint32_t j = 0; j < kHalfLength; ++j) taps_[j] = static_cast<float>(raw[j] * 0.5 / side);
    reset();
  }

  std::array<float, kHalfLength> taps_{};
  History input_{};
  History even_{};
  History odd_{};
  uint32_t inputWrite_ = 0;
  uint32_t evenWrite_ = 0;
  uint32_t oddWrite_ = 0;
};

}  // namespace daw::audio_core::dsp
