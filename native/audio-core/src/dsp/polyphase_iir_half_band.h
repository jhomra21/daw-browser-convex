#pragma once

#include "latency.h"
#include "numeric_safety.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

namespace daw::audio_core::dsp {

// 2x half-band oversampler built from two polyphase all-pass branches, H(z) = 0.5 (A0(z^2) + z^-1 A1(z^2)). Each branch
// is a cascade of first-order all-passes, so the magnitude is exactly 1 at DC and the cost is one multiply per section.
// Coefficients are the elliptic half-band design used by Laurent de Soras' HIIR (transition-band design after Lutovac),
// computed once here from the order and the transition width.
//   Passband: flat to 0.45 fs_in (the transition spans 0.45 to 0.55 fs_in).
//   Stopband: see kCoefficients; every added coefficient buys about 11 dB.
//   Latency: not constant. The up + down round trip is an all-pass, so its group delay is about 2.5 base-rate frames
//   at low frequencies and rises toward the band edge. latencyFrames() reports the low-frequency value rounded up.
// State is double and passes through flushDenormal; a non-finite input resets the filter.
class PolyphaseIirHalfBand2x {
 public:
  struct Pair {
    double first;
    double second;
  };

  static constexpr uint32_t kCoefficients = 6;
  static constexpr double kTransitionWidth = 0.05;  // of the doubled rate: 0.225 to 0.275 fs_out
  static constexpr uint32_t latencyFrames() { return 3; }
  static constexpr Latency latency() { return Latency::fromFrames(latencyFrames()); }

  PolyphaseIirHalfBand2x() { design(); }

  void reset() {
    up0_.fill(Section{});
    up1_.fill(Section{});
    down0_.fill(Section{});
    down1_.fill(Section{});
    downDelay_ = 0.0;
  }

  // One base-rate sample in, two doubled-rate samples out (in time order).
  Pair up(double x) {
    if (!std::isfinite(x)) {
      reset();
      return Pair{0.0, 0.0};
    }
    return Pair{cascade(up0_, coefficients0_, x), cascade(up1_, coefficients1_, x)};
  }

  // Two doubled-rate samples (in time order) in, one base-rate sample out.
  double down(double first, double second) {
    if (!std::isfinite(first) || !std::isfinite(second)) {
      reset();
      return 0.0;
    }
    const double y = 0.5 * (cascade(down0_, coefficients0_, first) + downDelay_);
    downDelay_ = cascade(down1_, coefficients1_, second);
    return y;
  }

 private:
  static constexpr uint32_t kBranch0 = (kCoefficients + 1) / 2;
  static constexpr uint32_t kBranch1 = kCoefficients / 2;

  struct Section {
    double state = 0.0;
  };

  // y[n] = a x[n] + x[n-1] - a y[n-1], transposed so a single state per section carries both delays.
  template <size_t N>
  static double cascade(std::array<Section, N> &sections, const std::array<double, N> &coefficients, double x) {
    for (size_t i = 0; i < N; ++i) {
      const double y = coefficients[i] * x + sections[i].state;
      sections[i].state = flushDenormal(x - coefficients[i] * y);
      x = y;
    }
    return x;
  }

  static double accumulateNumerator(double q, int order, int c) {
    constexpr double kPi = 3.14159265358979323846;
    double sum = 0.0;
    double sign = 1.0;
    for (int i = 0; i < 40; ++i) {
      sum += std::pow(q, i * (i + 1)) * std::sin((2 * i + 1) * c * kPi / order) * sign;
      sign = -sign;
    }
    return sum;
  }

  static double accumulateDenominator(double q, int order, int c) {
    constexpr double kPi = 3.14159265358979323846;
    double sum = 0.0;
    double sign = -1.0;
    for (int i = 1; i < 40; ++i) {
      sum += std::pow(q, i * i) * std::cos(2 * i * c * kPi / order) * sign;
      sign = -sign;
    }
    return sum;
  }

  void design() {
    constexpr double kPi = 3.14159265358979323846;
    const double k = std::tan((1.0 - 2.0 * kTransitionWidth) * kPi / 4.0);
    const double root = std::pow(1.0 - k * k, 0.25);
    const double e = 0.5 * (1.0 - root) / (1.0 + root);
    const double e4 = e * e * e * e;
    const double q = e * (1.0 + e4 * (2.0 + e4 * (15.0 + 150.0 * e4)));
    constexpr int order = 2 * kCoefficients + 1;
    std::array<double, kCoefficients> sorted{};
    for (uint32_t i = 0; i < kCoefficients; ++i) {
      const int c = static_cast<int>(i) + 1;
      const double w = accumulateNumerator(q, order, c) * std::pow(q, 0.25) / (accumulateDenominator(q, order, c) + 0.5);
      const double w2 = w * w;
      const double x = std::sqrt((1.0 - w2 * k) * (1.0 - w2 / k)) / (1.0 + w2);
      sorted[i] = (1.0 - x) / (1.0 + x);
    }
    std::sort(sorted.begin(), sorted.end());
    for (uint32_t i = 0; i < kCoefficients; ++i) (i % 2 == 0 ? coefficients0_[i / 2] : coefficients1_[i / 2]) = sorted[i];
    reset();
  }

  std::array<double, kBranch0> coefficients0_{};
  std::array<double, kBranch1> coefficients1_{};
  std::array<Section, kBranch0> up0_{};
  std::array<Section, kBranch1> up1_{};
  std::array<Section, kBranch0> down0_{};
  std::array<Section, kBranch1> down1_{};
  double downDelay_ = 0.0;
};

}  // namespace daw::audio_core::dsp
