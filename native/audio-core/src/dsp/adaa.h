#pragma once

#include <algorithm>
#include <cmath>

namespace daw::audio_core::dsp {

// Memoryless curves with their antiderivatives, for first-order antiderivative antialiasing.
struct TanhShaper {
  static double value(double x) { return std::tanh(x); }
  // log(cosh x) written so it cannot overflow.
  static double antiderivative(double x) {
    const double a = std::fabs(x);
    return a + std::log1p(std::exp(-2.0 * a)) - 0.69314718055994530942;
  }
};

struct HardClipShaper {
  static double value(double x) { return std::clamp(x, -1.0, 1.0); }
  static double antiderivative(double x) {
    const double a = std::fabs(x);
    return a <= 1.0 ? 0.5 * x * x : a - 0.5;
  }
};

// 1.5x - 0.5x^3 up to the rail at |x| = 1, where its slope is zero: continuous with the clamp.
struct SoftCubicShaper {
  static double value(double x) {
    const double c = std::clamp(x, -1.0, 1.0);
    return 1.5 * c - 0.5 * c * c * c;
  }
  static double antiderivative(double x) {
    const double a = std::fabs(x);
    return a <= 1.0 ? 0.75 * x * x - 0.125 * x * x * x * x : a - 0.375;
  }
};

// y[n] = (F(x[n]) - F(x[n-1])) / (x[n] - x[n-1]). When the two inputs are closer than kMinimumStep the quotient is
// ill-conditioned, so the curve is evaluated at their midpoint instead (the limit of the quotient). The state is
// double so the difference of antiderivatives keeps its precision. ADAA adds a half-sample delay and a gentle
// low-pass, which a 2x oversampler around it makes inaudible.
template <class Shaper>
class Adaa1 {
 public:
  static constexpr double kMinimumStep = 1.0e-6;

  void reset() {
    previousInput_ = 0.0;
    previousAntiderivative_ = Shaper::antiderivative(0.0);
  }

  float process(float input) {
    if (!std::isfinite(input)) {
      reset();
      return 0.0F;
    }
    const double x = input;
    const double antiderivative = Shaper::antiderivative(x);
    const double step = x - previousInput_;
    const double y = std::fabs(step) < kMinimumStep
      ? Shaper::value(0.5 * (x + previousInput_))
      : (antiderivative - previousAntiderivative_) / step;
    previousInput_ = x;
    previousAntiderivative_ = antiderivative;
    return static_cast<float>(y);
  }

 private:
  double previousInput_ = 0.0;
  double previousAntiderivative_ = Shaper::antiderivative(0.0);
};

}  // namespace daw::audio_core::dsp
