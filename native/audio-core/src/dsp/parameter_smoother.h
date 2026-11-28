#pragma once

#include <algorithm>
#include <cmath>

namespace daw::audio_core::dsp {

enum class SmoothDomain { Linear, Log };

// One-pole smoother for one parameter. `timeMs` is the time constant (63% of a step). Log smooths in the log
// domain, so a frequency sweep is exponential and never overshoots; its values must be positive.
// `tolerance` is the distance to the target, in the smoothing domain, below which the smoother snaps to the target
// and stops: settling() lets a processor skip coefficient work while every parameter is settled.
template <SmoothDomain Domain = SmoothDomain::Linear>
class ParameterSmoother {
 public:
  void prepare(double sampleRate, double timeMs, double tolerance = 1.0e-5) {
    coefficient_ = timeMs > 0.0 && sampleRate > 0.0 ? 1.0 - std::exp(-1000.0 / (timeMs * sampleRate)) : 1.0;
    tolerance_ = tolerance;
    settling_ = settling_ && std::fabs(target_ - current_) > tolerance_;
    if (!settling_) current_ = target_;
  }

  void reset(float value) {
    if (!std::isfinite(value)) return;
    targetValue_ = Domain == SmoothDomain::Log ? clampPositive(value) : value;
    target_ = toDomain(targetValue_);
    current_ = target_;
    settling_ = false;
    output_ = targetValue_;
  }

  void setTarget(float value) {
    if (!std::isfinite(value)) return;
    const float next = Domain == SmoothDomain::Log ? clampPositive(value) : value;
    if (next == targetValue_) return;
    targetValue_ = next;
    target_ = toDomain(next);
    settling_ = std::fabs(target_ - current_) > tolerance_;
    if (!settling_) {
      current_ = target_;
      output_ = targetValue_;
    }
  }

  bool settling() const { return settling_; }

  float target() const { return targetValue_; }

  float next() {
    if (!settling_) return targetValue_;
    current_ += coefficient_ * (target_ - current_);
    if (std::fabs(target_ - current_) <= tolerance_) {
      current_ = target_;
      settling_ = false;
      output_ = targetValue_;
    } else {
      output_ = fromDomain(current_);
    }
    return output_;
  }

 private:
  static float clampPositive(float value) { return std::max(value, 1.0e-12F); }
  static double toDomain(float value) {
    if constexpr (Domain == SmoothDomain::Log) return std::log(static_cast<double>(value));
    else return value;
  }
  static float fromDomain(double value) {
    if constexpr (Domain == SmoothDomain::Log) return static_cast<float>(std::exp(value));
    else return static_cast<float>(value);
  }

  double coefficient_ = 1.0;
  double tolerance_ = 1.0e-5;
  double current_ = 0.0;
  double target_ = 0.0;
  float targetValue_ = 0.0F;
  float output_ = 0.0F;
  bool settling_ = false;
};

}  // namespace daw::audio_core::dsp
