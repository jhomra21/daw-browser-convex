#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

#include "dsp/biquad.h"
#include "dsp/parameter_smoother.h"

namespace daw::audio_core {

struct LoFiValues {
  float bit_depth = 16.0F;
  float rate_hz = 96000.0F;
  float jitter = 0.0F;
  float noise_db = -120.0F;
  float mix = 1.0F;
};

// quantization and dither are the daw_audio_lofi_quantization and daw_audio_lofi_dither values.
struct LoFiConfig {
  uint32_t quantization = 0;
  uint32_t dither = 0;
  uint32_t seed = 1;
  bool pre_filter = false;
  bool post_filter = false;
  bool dc_correction = false;
  bool sub_sample_clock = false;
};

// Sample-and-hold rate reduction and bit reduction. With sub_sample_clock on, a held value is the input at the instant the rate clock
// fired, between two host frames, not at the frame that notices it: a cubic through the last four inputs. A non-integer host/rate ratio
// then holds the right values (the hold lengths stay whole frames, 3 and 4 at 44.1 kHz and 12 kHz). The rate is in Hz (a phase accumulator against the host rate), so a setting
// sounds the same at every host rate. The legacy worklet (daw-lofi-processor-v1.js) mirrors this operation for operation and
// must stay within 1e-5 of it; Math.fround stands there where this rounds to float.
class LoFiKernel {
 public:
  static constexpr uint32_t kControlFrames = 8;
  static constexpr double kPi = 3.14159265358979323846;
  static constexpr uint32_t kMinimumBits = 2;
  static constexpr uint32_t kMaximumBits = 24;
  // The band-limiting filters sit at this fraction of the reduced rate: 6th-order Chebyshev, 0.5 dB ripple. Each adds about two periods of
  // the reduced rate of delay (1.9 at 0.05 of the rate, 2.8 at 0.3; lofi6-filter-latency). That is 1 to thousands of host frames as the
  // automatable rate moves, so no latency is declared.
  static constexpr double kCutoffOfRate = 0.4;
  static constexpr double kRippleDb = 0.5;
  static constexpr uint32_t kSections = 3;

  // The bit depth the core uses for a control value: nearest whole number (ties up, as Math.round), within the range.
  static uint32_t bit_count(float value) {
    const double rounded = std::floor(static_cast<double>(value) + 0.5);
    return static_cast<uint32_t>(std::clamp(rounded, static_cast<double>(kMinimumBits), static_cast<double>(kMaximumBits)));
  }

  void prepare(double sample_rate) {
    rate_ = sample_rate;
    mix_.prepare(rate_, 10.0);
    noise_.prepare(rate_, 20.0);
    rate_hz_.prepare(rate_, 20.0);
    initialized_ = false;
    reset();
  }

  void reset() {
    channels_ = {};
    frame_ = 0;
    filter_stale_ = true;
  }

  // The values and config are read once per kControlFrames: the caller builds them only when this is true.
  bool control_due() const { return (frame_ & (kControlFrames - 1U)) == 0U; }

  void process(const LoFiValues &values, const LoFiConfig &config, float input_left, float input_right, float &output_left, float &output_right) {
    const bool tick = control_due();
    if (!initialized_) initialize(values, config);
    if (tick) apply(values, config);
    const double mix = mix_.next();
    const float noise_db = noise_.next();
    if (noise_db != last_noise_db_) {
      noise_gain_ = std::pow(10.0, static_cast<double>(noise_db) / 20.0);
      last_noise_db_ = noise_db;
    }
    const float rate_hz = rate_hz_.next();
    if (rate_hz != last_rate_hz_) {
      ratio_ = std::min(1.0, static_cast<double>(rate_hz) / rate_);
      last_rate_hz_ = rate_hz;
      filter_stale_ = true;
    }
    const bool reduced = ratio_ < 1.0;
    const bool pre = config_.pre_filter && reduced;
    const bool post = config_.post_filter && reduced;
    if (tick && filter_stale_ && (pre || post)) {
      sections_ = design_filter(kCutoffOfRate * static_cast<double>(rate_hz), rate_);
      filter_stale_ = false;
    }
    const std::array<double, 2> dry{std::isfinite(input_left) ? static_cast<double>(input_left) : 0.0,
      std::isfinite(input_right) ? static_cast<double>(input_right) : 0.0};
    std::array<double, 2> result{};
    for (uint32_t c = 0; c < 2; ++c) result[c] = render_channel(channels_[c], dry[c], mix, reduced, pre, post);
    ++frame_;
    output_left = static_cast<float>(result[0]);
    output_right = static_cast<float>(result[1]);
  }

  // Chebyshev type I, even order, as three biquads by the bilinear transform; the DC gain is brought back to unity.
  static std::array<dsp::BiquadCoefficients, kSections> design_filter(double cutoff_hz, double rate) {
    const double epsilon = std::sqrt(std::pow(10.0, kRippleDb / 10.0) - 1.0);
    const double mu = std::asinh(1.0 / epsilon) / static_cast<double>(2U * kSections);
    const double k = 1.0 / std::tan(kPi * std::min(cutoff_hz, 0.49 * rate) / rate);
    std::array<dsp::BiquadCoefficients, kSections> sections{};
    for (uint32_t i = 0; i < kSections; ++i) {
      const double theta = static_cast<double>(2U * i + 1U) * kPi / static_cast<double>(4U * kSections);
      const double sigma = std::sinh(mu) * std::sin(theta);
      const double omega = std::cosh(mu) * std::cos(theta);
      const double rho = sigma * sigma + omega * omega;
      const double a0 = k * k + 2.0 * sigma * k + rho;
      const double gain = (i == 0 ? std::pow(10.0, kRippleDb / 20.0) : 1.0) * rho / a0;
      sections[i] = dsp::BiquadCoefficients{gain, 2.0 * gain, gain, (2.0 * rho - 2.0 * k * k) / a0, (k * k - 2.0 * sigma * k + rho) / a0};
    }
    return sections;
  }

 private:
  struct Channel {
    double phase = 1.0;
    double interval = 1.0;
    double held = 0.0;
    std::array<double, 3> recent{};
    uint32_t random_state = 0;
    std::array<dsp::Biquad<double>, kSections> pre{};
    std::array<dsp::Biquad<double>, kSections> post{};
  };

  static uint32_t next_random(uint32_t &state) {
    uint32_t value = state;
    value ^= value << 13U;
    value ^= value >> 17U;
    value ^= value << 5U;
    state = value == 0 ? 1U : value;
    return state;
  }

  static double random(uint32_t &state) { return static_cast<double>(next_random(state)) / 4294967296.0; }

  static double quantize(double scaled, uint32_t mode) {
    if (mode == 1U) return std::floor(scaled);
    if (mode == 2U) return std::trunc(scaled);
    return std::floor(scaled + 0.5);
  }

  // The input `behind` frames before the current one (0 to 1) by the cubic through the last four inputs.
  static double input_behind(const Channel &channel, double current, double behind) {
    const double p = 3.0 - behind;
    return -(p - 1.0) * (p - 2.0) * (p - 3.0) / 6.0 * channel.recent[0] + p * (p - 2.0) * (p - 3.0) / 2.0 * channel.recent[1]
      - p * (p - 1.0) * (p - 3.0) / 2.0 * channel.recent[2] + p * (p - 1.0) * (p - 2.0) / 6.0 * current;
  }

  void initialize(const LoFiValues &values, const LoFiConfig &config) {
    mix_.reset(values.mix);
    noise_.reset(values.noise_db);
    rate_hz_.reset(values.rate_hz);
    config_ = config;
    for (uint32_t c = 0; c < 2; ++c) {
      uint32_t seed = config.seed ^ (c == 0 ? 0U : 0x9e3779b9U);
      channels_[c].random_state = seed == 0 ? 1U : seed;
    }
    initialized_ = true;
  }

  void apply(const LoFiValues &values, const LoFiConfig &config) {
    if (config.pre_filter != config_.pre_filter || config.post_filter != config_.post_filter) {
      for (Channel &channel : channels_) {
        for (auto &section : channel.pre) section.reset();
        for (auto &section : channel.post) section.reset();
      }
      filter_stale_ = true;
    }
    config_ = config;
    mix_.setTarget(values.mix);
    noise_.setTarget(values.noise_db);
    rate_hz_.setTarget(values.rate_hz);
    bits_ = bit_count(values.bit_depth);
    levels_ = std::pow(2.0, static_cast<double>(bits_) - 1.0) - 1.0;
    jitter_ = values.jitter;
  }

  double render_channel(Channel &channel, double dry, double mix, bool reduced, bool pre, bool post) {
    double x = dry;
    if (pre) {
      for (uint32_t i = 0; i < kSections; ++i) x = channel.pre[i].process(x, sections_[i]);
    }
    channel.phase += ratio_;
    if (channel.phase >= channel.interval) {
      channel.phase -= channel.interval;
      channel.interval = 1.0 + (random(channel.random_state) - 0.5) * static_cast<double>(jitter_);
      const double captured = config_.sub_sample_clock && reduced ? input_behind(channel, x, std::min(channel.phase / ratio_, 1.0)) : x;
      double sample = captured + (random(channel.random_state) * 2.0 - 1.0) * noise_gain_;
      const double lsb = 1.0 / levels_;
      if (config_.dither == 1U) {
        sample += (random(channel.random_state) - 0.5) * lsb;
      } else if (config_.dither == 2U) {
        const double first = random(channel.random_state);
        const double second = random(channel.random_state);
        sample += (first - second) * lsb;
      }
      // Floor rounds every value down, so its error averages minus half an LSB and silence sits at minus one LSB. The correction shifts
      // the decision point by half an LSB, which centres that error (and makes silence exact).
      const double bias = config_.dc_correction && config_.quantization == 1U ? 0.5 : 0.0;
      const double quantized = quantize(sample * levels_ + bias, config_.quantization) / levels_;
      // Past one only a full-rate 24-bit signal is left alone; anything else is a converter and stops at the rail.
      channel.held = bits_ < kMaximumBits || reduced ? std::clamp(quantized, -1.0, 1.0) : quantized;
    }
    channel.recent = {channel.recent[1], channel.recent[2], x};
    double wet = channel.held;
    if (post) {
      for (uint32_t i = 0; i < kSections; ++i) wet = channel.post[i].process(wet, sections_[i]);
    }
    return dry + (wet - dry) * mix;
  }

  double rate_ = 48000.0;
  dsp::ParameterSmoother<> mix_;
  dsp::ParameterSmoother<> noise_;
  dsp::ParameterSmoother<dsp::SmoothDomain::Log> rate_hz_;
  bool initialized_ = false;
  LoFiConfig config_{};
  std::array<Channel, 2> channels_{};
  std::array<dsp::BiquadCoefficients, kSections> sections_{};
  uint32_t frame_ = 0;
  uint32_t bits_ = 12;
  double levels_ = 2047.0;
  float jitter_ = 0.0F;
  double noise_gain_ = 1.0;
  float last_noise_db_ = 1000.0F;
  double ratio_ = 1.0;
  float last_rate_hz_ = -1.0F;
  bool filter_stale_ = true;
};

}  // namespace daw::audio_core
