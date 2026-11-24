#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

namespace daw::audio_core::dsp {

// Power-of-two ring with masked indexing. Delays are ages: read(0) is the newest pushed sample. The 4-point reads
// use the sample one frame newer than the integer part, so their delay is clamped to [1, capacity - 3].
// prepare() allocates; push and the reads never do.
template <class T = float>
class DelayRing {
 public:
  void prepare(uint32_t minimumFrames) {
    uint32_t capacity = 8;
    while (capacity < minimumFrames) capacity <<= 1;
    buffer_.assign(capacity, T(0));
    mask_ = capacity - 1;
    write_ = 0;
  }

  void reset() {
    std::fill(buffer_.begin(), buffer_.end(), T(0));
    write_ = 0;
  }

  uint32_t capacity() const { return mask_ + 1; }

  void push(T value) { buffer_[write_++ & mask_] = value; }

  T read(uint32_t age) const { return buffer_[(write_ - 1 - std::min(age, mask_)) & mask_]; }

  // 4-point, 3rd-order Hermite (Catmull-Rom).
  T readHermite(float delay) const {
    const Taps w = taps(delay);
    const T c1 = T(0.5) * (w.p[2] - w.p[0]);
    const T c2 = w.p[0] - T(2.5) * w.p[1] + T(2) * w.p[2] - T(0.5) * w.p[3];
    const T c3 = T(0.5) * (w.p[3] - w.p[0]) + T(1.5) * (w.p[1] - w.p[2]);
    return ((c3 * w.t + c2) * w.t + c1) * w.t + w.p[1];
  }

  // 4-point Lagrange: flatter passband than Hermite at low frequencies, same cost.
  T readLagrange3(float delay) const {
    const Taps w = taps(delay);
    const T t = w.t;
    return -t * (t - 1) * (t - 2) / 6 * w.p[0] + (t + 1) * (t - 1) * (t - 2) / 2 * w.p[1] -
      (t + 1) * t * (t - 2) / 2 * w.p[2] + (t + 1) * t * (t - 1) / 6 * w.p[3];
  }

 private:
  struct Taps {
    T p[4];  // oldest to newest around the read position
    T t;     // position between p[1] and p[2]
  };

  Taps taps(float delay) const {
    const float bounded = std::isnan(delay) ? 1.0F : std::clamp(delay, 1.0F, static_cast<float>(mask_ - 2));
    const uint32_t whole = static_cast<uint32_t>(bounded);
    const T fraction = static_cast<T>(bounded - static_cast<float>(whole));
    return Taps{{read(whole + 2), read(whole + 1), read(whole), read(whole - 1)}, T(1) - fraction};
  }

  std::vector<T> buffer_;
  uint32_t mask_ = 7;
  uint32_t write_ = 0;
};

}  // namespace daw::audio_core::dsp
