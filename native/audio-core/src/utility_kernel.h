#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

#include "dsp/biquad.h"
#include "dsp/numeric_safety.h"
#include "dsp/parameter_smoother.h"

namespace daw::audio_core {

struct UtilityValues {
  float gain_db = 0.0F;
  float balance = 0.0F;
  float width = 1.0F;
  float mid_side = 0.0F;
  float bass_mono_hz = 120.0F;
};

// matrix, channel_mode and width_mode are the daw_audio_utility_matrix, daw_audio_utility_channel_mode and daw_audio_utility_width_mode values.
struct UtilityConfig {
  bool phase_left = false;
  bool phase_right = false;
  bool mono = false;
  uint32_t matrix = 0;
  uint32_t channel_mode = 0;
  uint32_t width_mode = 0;
  bool mute = false;
  bool bass_mono = false;
  bool bass_mono_audition = false;
  bool dc_block = false;
};

// Phase L/R, Mono, Channel Mode, Width (or Mid/Side), Balance, Gain with Mute, Bass Mono and the DC filter, in that order.
// Every continuous control is smoothed, and the transcendental math (the gain power, the crossover design) runs only when its
// control changes. The legacy worklet (daw-utility-processor-v1.js) mirrors this operation for operation and must stay within
// 1e-5 of it; Math.fround stands there where this rounds to float.
class UtilityKernel {
 public:
  static constexpr uint32_t kControlFrames = 8;
  static constexpr double kPi = 3.14159265358979323846;
  // The DC filter's corner: low enough that 40 Hz keeps its level (-0.04 dB) and phase (5.7 degrees).
  static constexpr double kDcCornerHz = 4.0;
  // A gain at or below this is minus infinity: exact silence once the ramp has finished.
  static constexpr float kGainFloorDb = -70.0F;
  static constexpr double kSqrtHalf = 0.7071067811865475244;

  bool prepared_for(double sample_rate) const { return rate_ == sample_rate; }

  void prepare(double sample_rate) {
    rate_ = sample_rate;
    gain_.prepare(rate_, 10.0);
    audible_.prepare(rate_, 10.0);
    balance_.prepare(rate_, 10.0);
    width_.prepare(rate_, 10.0);
    mid_side_.prepare(rate_, 10.0);
    bass_hz_.prepare(rate_, 20.0);
    dc_coefficient_ = std::exp(-2.0 * kPi * kDcCornerHz / rate_);
    initialized_ = false;
    reset();
  }

  void reset() {
    channels_ = {};
    frame_ = 0;
    filter_stale_ = true;
  }

  // A stopped seek starts a fresh input timeline: the DC estimate goes, the crossover state and the ramps stay.
  void reset_dc() {
    for (Channel &channel : channels_) channel.x1 = channel.y1 = 0.0;
  }

  // The values and config are read once per kControlFrames: the caller builds them only when this is true.
  bool control_due() const { return (frame_ & (kControlFrames - 1U)) == 0U; }

  void process(const UtilityValues &values, const UtilityConfig &config, float input_left, float input_right, float &output_left, float &output_right) {
    const bool tick = control_due();
    if (!initialized_) initialize(values, config);
    if (tick) apply(values, config);
    const double gain = static_cast<double>(gain_.next()) * static_cast<double>(audible_.next());
    const double balance = balance_.next();
    const double width = width_.next();
    const double mid_side = mid_side_.next();
    const float bass_hz = bass_hz_.next();
    if (bass_hz != last_bass_hz_) {
      last_bass_hz_ = bass_hz;
      filter_stale_ = true;
    }
    if (tick && filter_stale_ && config_.bass_mono) {
      design_crossover(static_cast<double>(bass_hz));
      filter_stale_ = false;
    }

    double left = std::isfinite(input_left) ? static_cast<double>(input_left) : 0.0;
    double right = std::isfinite(input_right) ? static_cast<double>(input_right) : 0.0;
    if (config_.mono) left = right = 0.5 * left + 0.5 * right;
    if (config_.phase_left) left = -left;
    if (config_.phase_right) right = -right;

    if (config_.matrix == 1U) {
      const double mid = (left + right) * kSqrtHalf;
      right = (left - right) * kSqrtHalf;
      left = mid;
    } else if (config_.matrix == 2U) {
      const double mid = left;
      left = (mid + right) * kSqrtHalf;
      right = (mid - right) * kSqrtHalf;
    }

    if (config_.channel_mode == 1U) {
      right = left;
    } else if (config_.channel_mode == 2U) {
      left = right;
    } else {
      if (config_.channel_mode == 3U) std::swap(left, right);
      const bool by_side = config_.width_mode == 1U;
      const double mid_gain = by_side && mid_side > 0.0 ? 1.0 - mid_side : 1.0;
      const double side_gain = by_side ? (mid_side < 0.0 ? 1.0 + mid_side : 1.0) : width;
      const double mid = (left + right) * kSqrtHalf * mid_gain;
      const double side = (left - right) * kSqrtHalf * side_gain;
      left = (mid + side) * kSqrtHalf;
      right = (mid - side) * kSqrtHalf;
    }

    if (balance > 0.0) left *= 1.0 - balance;
    if (balance < 0.0) right *= 1.0 + balance;
    left *= gain;
    right *= gain;

    if (config_.bass_mono) split_bass(left, right);
    if (config_.dc_block) {
      left = block_dc(channels_[0], left);
      right = block_dc(channels_[1], right);
    }

    if (!std::isfinite(left) || !std::isfinite(right)) {
      left = right = 0.0;
      channels_ = {};
    }
    ++frame_;
    output_left = static_cast<float>(left);
    output_right = static_cast<float>(right);
  }

  // Butterworth sections for a Linkwitz-Riley split: two identical 2nd-order sections in series, low-pass and high-pass.
  static void design_sections(double cutoff_hz, double rate, dsp::BiquadCoefficients &low, dsp::BiquadCoefficients &high) {
    const double k = std::tan(kPi * std::clamp(cutoff_hz, 20.0, 0.45 * rate) / rate);
    const double root_two = 1.4142135623730950488;
    const double norm = 1.0 / (1.0 + root_two * k + k * k);
    const double a1 = 2.0 * (k * k - 1.0) * norm;
    const double a2 = (1.0 - root_two * k + k * k) * norm;
    low = dsp::BiquadCoefficients{k * k * norm, 2.0 * k * k * norm, k * k * norm, a1, a2};
    high = dsp::BiquadCoefficients{norm, -2.0 * norm, norm, a1, a2};
  }

 private:
  struct Channel {
    double x1 = 0.0;
    double y1 = 0.0;
    std::array<dsp::Biquad<double>, 2> low{};
    std::array<dsp::Biquad<double>, 2> high{};
  };

  static float gain_target(float gain_db) {
    return gain_db <= kGainFloorDb ? 0.0F : static_cast<float>(std::pow(10.0, static_cast<double>(gain_db) / 20.0));
  }

  void initialize(const UtilityValues &values, const UtilityConfig &config) {
    gain_.reset(gain_target(values.gain_db));
    audible_.reset(config.mute ? 0.0F : 1.0F);
    balance_.reset(values.balance);
    width_.reset(values.width);
    mid_side_.reset(values.mid_side);
    bass_hz_.reset(values.bass_mono_hz);
    last_gain_db_ = values.gain_db;
    config_ = config;
    initialized_ = true;
  }

  void apply(const UtilityValues &values, const UtilityConfig &config) {
    if (config.bass_mono != config_.bass_mono) {
      for (Channel &channel : channels_) {
        for (auto &section : channel.low) section.reset();
        for (auto &section : channel.high) section.reset();
      }
      filter_stale_ = true;
    }
    config_ = config;
    if (values.gain_db != last_gain_db_) {
      last_gain_db_ = values.gain_db;
      gain_.setTarget(gain_target(values.gain_db));
    }
    audible_.setTarget(config.mute ? 0.0F : 1.0F);
    balance_.setTarget(values.balance);
    width_.setTarget(values.width);
    mid_side_.setTarget(values.mid_side);
    bass_hz_.setTarget(values.bass_mono_hz);
  }

  void design_crossover(double cutoff_hz) { design_sections(cutoff_hz, rate_, low_, high_); }

  // The lows of both channels are summed to one signal; the highs stay per channel. The two bands of a 4th-order split add to
  // an all-pass, so mono material keeps its level.
  void split_bass(double &left, double &right) {
    const auto band = [&](Channel &channel, double x, double &low, double &high) {
      low = channel.low[1].process(channel.low[0].process(x, low_), low_);
      high = channel.high[1].process(channel.high[0].process(x, high_), high_);
    };
    double low_left = 0.0;
    double high_left = 0.0;
    double low_right = 0.0;
    double high_right = 0.0;
    band(channels_[0], left, low_left, high_left);
    band(channels_[1], right, low_right, high_right);
    const double low = 0.5 * (low_left + low_right);
    left = config_.bass_mono_audition ? low : low + high_left;
    right = config_.bass_mono_audition ? low : low + high_right;
  }

  // y[n] = x[n] - x[n-1] + R y[n-1]. The state is flushed at the float floor so silence settles to exact zeros.
  double block_dc(Channel &channel, double x) const {
    const double y = x - channel.x1 + dc_coefficient_ * channel.y1;
    channel.x1 = x;
    channel.y1 = std::fabs(y) < dsp::denormalFloor<float>() ? 0.0 : y;
    return channel.y1;
  }

  double rate_ = 0.0;
  dsp::ParameterSmoother<> gain_;
  dsp::ParameterSmoother<> audible_;
  dsp::ParameterSmoother<> balance_;
  dsp::ParameterSmoother<> width_;
  dsp::ParameterSmoother<> mid_side_;
  dsp::ParameterSmoother<dsp::SmoothDomain::Log> bass_hz_;
  bool initialized_ = false;
  UtilityConfig config_{};
  std::array<Channel, 2> channels_{};
  dsp::BiquadCoefficients low_{};
  dsp::BiquadCoefficients high_{};
  double dc_coefficient_ = 0.0;
  uint32_t frame_ = 0;
  float last_gain_db_ = 0.0F;
  float last_bass_hz_ = -1.0F;
  bool filter_stale_ = true;
};

}  // namespace daw::audio_core
