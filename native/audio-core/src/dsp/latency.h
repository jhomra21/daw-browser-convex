#pragma once

#include <cmath>
#include <cstdint>
#include <limits>

namespace daw::audio_core::dsp {

// Latency a processor declares, in frames at the project rate. Lookahead and oversampling latency add.
struct Latency {
  uint32_t frames = 0;

  static constexpr Latency fromFrames(uint32_t frames) { return Latency{frames}; }

  // Rounds up: reporting less than the real delay misaligns the dry path by a frame.
  static Latency fromMilliseconds(double milliseconds, double sampleRate) {
    const double frames = std::ceil(milliseconds * sampleRate / 1000.0);
    if (!(frames > 0.0)) return Latency{};
    if (frames >= static_cast<double>(std::numeric_limits<uint32_t>::max())) {
      return Latency{std::numeric_limits<uint32_t>::max()};
    }
    return Latency{static_cast<uint32_t>(frames)};
  }

  // Latency measured in frames of an oversampled stream, in base-rate frames.
  static constexpr Latency fromOversampled(uint32_t oversampledFrames, uint32_t factor) {
    return Latency{factor == 0 ? 0 : (oversampledFrames + factor - 1) / factor};
  }

  constexpr Latency operator+(Latency other) const {
    const uint32_t sum = frames + other.frames;
    return Latency{sum < frames ? std::numeric_limits<uint32_t>::max() : sum};
  }

  double milliseconds(double sampleRate) const { return sampleRate > 0.0 ? frames * 1000.0 / sampleRate : 0.0; }
};

}  // namespace daw::audio_core::dsp
