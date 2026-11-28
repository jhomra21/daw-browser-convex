#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <utility>
#include <vector>

namespace daw::audio_host_macos {

inline constexpr double kSpectrumFloorDb = -90.0;
inline constexpr double kSpectrumAveragingSeconds = 0.1;

// Windowed-FFT level meter: a sine of amplitude A reads 20*log10(A) dBFS at its bin centre, and the
// per-bin power relaxes toward each new block with a time constant in seconds, so the reading does not
// depend on how often blocks are delivered.
class SpectrumAnalyzer {
 public:
  explicit SpectrumAnalyzer(const std::uint32_t fft_size) : size_(fft_size), window_(fft_size),
    real_(fft_size), imaginary_(fft_size), power_(fft_size / 2U, 0.0) {
    double sum = 0.0;
    for (std::uint32_t index = 0; index < size_; ++index) {
      const double progress = static_cast<double>(index) / static_cast<double>(size_ - 1U);
      window_[index] = 0.42 - 0.5 * std::cos(2.0 * kPi * progress) + 0.08 * std::cos(4.0 * kPi * progress);
      sum += window_[index];
    }
    amplitude_scale_ = 2.0 / sum;
  }

  [[nodiscard]] std::uint32_t FftSize() const noexcept { return size_; }
  [[nodiscard]] std::uint32_t BinCount() const noexcept { return size_ / 2U; }
  void Reset() { has_previous_ = false; }

  // Analyses the newest size() samples; elapsed_seconds is the audio time since the previous call.
  void Analyze(const std::vector<double>& block, const double elapsed_seconds,
    const double averaging_seconds = kSpectrumAveragingSeconds) {
    for (std::uint32_t index = 0; index < size_; ++index) {
      real_[index] = block[index] * window_[index];
      imaginary_[index] = 0.0;
    }
    Transform();
    const double blend = has_previous_ && averaging_seconds > 0.0
      ? 1.0 - std::exp(-std::max(elapsed_seconds, 0.0) / averaging_seconds) : 1.0;
    for (std::uint32_t bin = 0; bin < BinCount(); ++bin) {
      // The one-sided amplitude of bin 0 has no mirrored half.
      const double scale = bin == 0 ? amplitude_scale_ * 0.5 : amplitude_scale_;
      const double amplitude = std::hypot(real_[bin], imaginary_[bin]) * scale;
      const double power = amplitude * amplitude;
      power_[bin] = std::isfinite(power) ? power_[bin] + blend * (power - power_[bin]) : 0.0;
    }
    has_previous_ = true;
  }

  [[nodiscard]] double Decibels(const std::uint32_t bin) const noexcept {
    return 10.0 * std::log10(std::max(power_[bin], std::numeric_limits<double>::min()));
  }

  // Display value 0..1 across kSpectrumFloorDb..0 dBFS.
  [[nodiscard]] float Level(const std::uint32_t bin) const noexcept {
    return static_cast<float>(std::clamp((Decibels(bin) - kSpectrumFloorDb) / -kSpectrumFloorDb, 0.0, 1.0));
  }

  // Parabolic fit through the dB values either side of a local maximum: the peak's offset from the centre
  // bin (in bins) and its level in dB.
  [[nodiscard]] static std::pair<double, double> InterpolatedPeak(const double left, const double centre, const double right) noexcept {
    const double curvature = left - 2.0 * centre + right;
    if (curvature >= 0.0) return {0.0, centre};
    const double offset = 0.5 * (left - right) / curvature;
    return {offset, centre - 0.25 * (left - right) * offset};
  }

 private:
  static constexpr double kPi = 3.14159265358979323846;

  void Transform() {
    for (std::uint32_t index = 1, reversed = 0; index < size_; ++index) {
      std::uint32_t bit = size_ >> 1U;
      for (; reversed & bit; bit >>= 1U) reversed ^= bit;
      reversed ^= bit;
      if (index < reversed) {
        std::swap(real_[index], real_[reversed]);
        std::swap(imaginary_[index], imaginary_[reversed]);
      }
    }
    for (std::uint32_t length = 2; length <= size_; length <<= 1U) {
      const double angle = -2.0 * kPi / static_cast<double>(length);
      const double step_real = std::cos(angle);
      const double step_imaginary = std::sin(angle);
      for (std::uint32_t start = 0; start < size_; start += length) {
        double twiddle_real = 1.0;
        double twiddle_imaginary = 0.0;
        const auto half = length / 2U;
        for (std::uint32_t offset = 0; offset < half; ++offset) {
          const auto even = start + offset;
          const auto odd = even + half;
          const double product_real = twiddle_real * real_[odd] - twiddle_imaginary * imaginary_[odd];
          const double product_imaginary = twiddle_real * imaginary_[odd] + twiddle_imaginary * real_[odd];
          real_[odd] = real_[even] - product_real;
          imaginary_[odd] = imaginary_[even] - product_imaginary;
          real_[even] += product_real;
          imaginary_[even] += product_imaginary;
          const double next_twiddle_real = twiddle_real * step_real - twiddle_imaginary * step_imaginary;
          twiddle_imaginary = twiddle_real * step_imaginary + twiddle_imaginary * step_real;
          twiddle_real = next_twiddle_real;
        }
      }
    }
  }

  std::uint32_t size_;
  std::vector<double> window_, real_, imaginary_, power_;
  double amplitude_scale_ = 0.0;
  bool has_previous_ = false;
};

}  // namespace daw::audio_host_macos
