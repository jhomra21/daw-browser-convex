#pragma once

// Gate DSP kernel, independent of the audio-core graph so it can be measured on its own.
//
// Signal path per channel and sample: key (the gate's own input, or the external key blended in at the Dry/Wet amount and
// scaled by the sidechain Gain) -> optional sidechain biquad -> level (the maximum over a 4 ms window, or RMS with a 10 ms time
// constant) -> link toward the louder channel -> open / hold / return decision on the level -> target in dB (0 when open, the
// Floor when closed, or the expander curve) -> gain in dB that slews toward the target at |Floor| / time dB per frame, so
// Attack and Release are the time the gain takes to cover the whole range -> gain on the audio delayed by exactly the lookahead.
//
// The coefficients are cached until the value they come from changes. The legacy worklet
// (public/audio-worklets/daw-gate-processor-v1.js) repeats this arithmetic operation for operation; keep them in step.
#include "dsp/biquad.h"
#include "dsp/latency.h"
#include "dsp/numeric_safety.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

namespace daw::audio_core {

struct GateValues {
  float threshold_db = -40.0F;
  float ratio = 4.0F;
  float attack_ms = 1.0F;
  float hold_ms = 20.0F;
  float release_ms = 120.0F;
  float hysteresis_db = 6.0F;
  float range_db = -80.0F;
  float link = 1.0F;
  float sidechain_gain_db = 0.0F;
  float sidechain_mix = 1.0F;
};

struct GateConfig {
  float lookahead_ms = 0.0F;
  bool expander = false;
  bool rms = false;
  bool flip = false;
  // A key from another track is routed to the gate. Without one the sidechain pair is the gate's own input, and Gain
  // and Dry/Wet have nothing to act on.
  bool external_key = false;
};

class GateKernel {
 public:
  static constexpr uint32_t kCapacity = 2048;
  static constexpr uint32_t kMask = kCapacity - 1;
  static constexpr uint32_t kWindowCapacity = 1024;
  static constexpr uint32_t kWindowMask = kWindowCapacity - 1;
  static constexpr double kRmsMs = 10.0;
  // The window must reach back over the gap between the peaks of a rectified low tone, or the level sags between them and the
  // gate chatters at twice the tone's frequency (at 4 ms a 30 Hz tone's level dips 3.3 dB between peaks, and the Return is 6 dB
  // or more); it must also be short enough that a drop in level is seen in time for the Release to be the time the gain takes
  // to fall to the Floor.
  static constexpr double kPeakWindowMs = 4.0;
  // Below this the signal is silence. A gate that has not heard anything stays open.
  static constexpr double kSilence = 1.0e-8;
  static constexpr double kDbToNeper = 0.11512925464970228420;  // ln(10) / 20
  static constexpr double kNeperToDb = 8.68588963806503655302;  // 20 / ln(10)
  static constexpr float kUnset = 1.0e30F;

  // Frames of delay for a lookahead: the audio is held back exactly this long, so it is also the latency the device reports.
  static uint32_t latency_frames(float lookahead_ms, double sample_rate) {
    return std::min(dsp::Latency::fromMilliseconds(lookahead_ms, sample_rate).frames, kCapacity - 1);
  }

  GateKernel() { reset(); }

  void prepare(double sample_rate) {
    rate_ = sample_rate;
    rms_decay_ = std::exp(-1.0 / (kRmsMs * 0.001 * sample_rate));
    rms_gain_ = 1.0 - rms_decay_;
    window_frames_ = std::clamp(static_cast<uint32_t>(std::lround(kPeakWindowMs * 0.001 * sample_rate)), 1U, kWindowCapacity - 1);
    cached_threshold_db_ = cached_hysteresis_db_ = cached_hold_ms_ = cached_attack_ms_ = cached_release_ms_ = kUnset;
    cached_sidechain_gain_db_ = kUnset;
    reset();
  }

  void reset() {
    for (auto &line : dry_) line.fill(0.0F);
    write_ = 0;
    tick_ = 0;
    for (auto &filter : filters_) filter.reset();
    for (uint32_t channel = 0; channel < 2; ++channel) {
      windows_[channel] = Window{};
      mean_square_[channel] = 0.0;
      open_[channel] = true;
      started_[channel] = false;
      hold_[channel] = 0;
      gain_db_[channel] = 0.0;
      gain_applied_db_[channel] = 0.0;
      gain_[channel] = 1.0;
    }
  }

  // The caller designs the detector filter (an RBJ high-pass, low-pass or band-pass) and tells the kernel when it changes.
  void set_sidechain(bool enabled, const dsp::BiquadCoefficients &coefficients) {
    filter_enabled_ = enabled;
    filter_coefficients_ = coefficients;
  }

  // Gain reduction of the deeper channel in dB, at most 0.
  float gain_reduction_db() const { return static_cast<float>(std::min(gain_db_[0], gain_db_[1])); }

  void process(const GateValues &values, const GateConfig &config, float bypass, float input_left, float input_right,
    float sidechain_left, float sidechain_right, float &output_left, float &output_right) {
    delay_ = latency_frames(config.lookahead_ms, rate_);
    refresh(values);
    const std::array<float, 2> input{clean(input_left), clean(input_right)};
    const std::array<float, 2> external{clean(sidechain_left), clean(sidechain_right)};
    const uint32_t slot = write_ & kMask;
    const uint32_t read = (write_ - delay_) & kMask;
    ++write_;
    std::array<double, 2> level{};
    for (uint32_t channel = 0; channel < 2; ++channel) {
      dry_[channel][slot] = input[channel];
      double key = input[channel];
      if (config.external_key) key += mix_ * (sidechain_gain_ * static_cast<double>(external[channel]) - key);
      if (filter_enabled_) key = filters_[channel].process(key, filter_coefficients_);
      level[channel] = config.rms ? rms_level(channel, key) : peak_level(channel, key);
    }
    ++tick_;
    const double linked = std::max(level[0], level[1]);
    const double link = std::clamp(static_cast<double>(values.link), 0.0, 1.0);
    const double floor_db = std::min(static_cast<double>(values.range_db), 0.0);
    const double scale = std::max(-floor_db, 1.0);
    const double attack_step = scale * attack_per_frame_;
    const double release_step = scale * release_per_frame_;
    const double slope = static_cast<double>(values.ratio) - 1.0;

    std::array<float, 2> output{};
    for (uint32_t channel = 0; channel < 2; ++channel) {
      const double key_level = level[channel] + (linked - level[channel]) * link;
      if (key_level > kSilence) started_[channel] = true;
      if (!open_[channel] && key_level >= open_level_) {
        open_[channel] = true;
        hold_[channel] = hold_frames_;
      } else if (open_[channel] && started_[channel]) {
        if (key_level >= close_level_) hold_[channel] = hold_frames_;
        else if (hold_[channel] > 0) --hold_[channel];
        else open_[channel] = false;
      }
      double target = 0.0;
      if (open_[channel] == config.flip) {
        target = floor_db;
        if (config.expander && !config.flip) {
          const double db = kNeperToDb * std::log(std::max(key_level, kSilence));
          target = std::clamp((db - static_cast<double>(values.threshold_db)) * slope, floor_db, 0.0);
        }
      }
      double &gain_db = gain_db_[channel];
      if (target > gain_db) gain_db = std::min(target, gain_db + attack_step);
      else if (target < gain_db) gain_db = std::max(target, gain_db - release_step);
      if (gain_db != gain_applied_db_[channel]) {
        gain_applied_db_[channel] = gain_db;
        gain_[channel] = std::exp(gain_db * kDbToNeper);
      }
      const float wet = static_cast<float>(static_cast<double>(dry_[channel][read]) * gain_[channel]);
      output[channel] = wet + (dry_[channel][read] - wet) * bypass;
    }
    if (!std::isfinite(gain_[0]) || !std::isfinite(gain_[1]) || !std::isfinite(mean_square_[0]) || !std::isfinite(mean_square_[1])) reset();
    output_left = dsp::finiteOrReset(*this, output[0]);
    output_right = dsp::finiteOrReset(*this, output[1]);
  }

 private:
  // Sliding maximum of the magnitude over the last window_frames_ samples: a deque of the candidates, largest first.
  struct Window {
    std::array<double, kWindowCapacity> value{};
    std::array<uint32_t, kWindowCapacity> position{};
    uint32_t head = 0;
    uint32_t tail = 0;
  };

  static float clean(float sample) { return dsp::flushDenormal(std::isfinite(sample) ? sample : 0.0F); }

  double peak_level(uint32_t channel, double key) {
    Window &window = windows_[channel];
    const double magnitude = std::fabs(key);
    while (window.tail != window.head && window.value[(window.tail - 1) & kWindowMask] <= magnitude) --window.tail;
    window.value[window.tail & kWindowMask] = magnitude;
    window.position[window.tail & kWindowMask] = tick_;
    ++window.tail;
    while (tick_ - window.position[window.head & kWindowMask] >= window_frames_) ++window.head;
    return window.value[window.head & kWindowMask];
  }

  double rms_level(uint32_t channel, double key) {
    mean_square_[channel] = dsp::flushDenormal(rms_decay_ * mean_square_[channel] + rms_gain_ * key * key);
    return std::sqrt(mean_square_[channel]);
  }

  void refresh(const GateValues &values) {
    if (values.threshold_db != cached_threshold_db_ || values.hysteresis_db != cached_hysteresis_db_) {
      cached_threshold_db_ = values.threshold_db;
      cached_hysteresis_db_ = values.hysteresis_db;
      open_level_ = std::exp(static_cast<double>(values.threshold_db) * kDbToNeper);
      close_level_ = std::exp((static_cast<double>(values.threshold_db) - static_cast<double>(values.hysteresis_db)) * kDbToNeper);
    }
    if (values.hold_ms != cached_hold_ms_) {
      cached_hold_ms_ = values.hold_ms;
      hold_frames_ = static_cast<uint32_t>(std::lround(static_cast<double>(values.hold_ms) * 0.001 * rate_));
    }
    if (values.attack_ms != cached_attack_ms_) {
      cached_attack_ms_ = values.attack_ms;
      attack_per_frame_ = 1.0 / std::max(1.0, rate_ * static_cast<double>(values.attack_ms) / 1000.0);
    }
    if (values.release_ms != cached_release_ms_) {
      cached_release_ms_ = values.release_ms;
      release_per_frame_ = 1.0 / std::max(1.0, rate_ * static_cast<double>(values.release_ms) / 1000.0);
    }
    if (values.sidechain_gain_db != cached_sidechain_gain_db_) {
      cached_sidechain_gain_db_ = values.sidechain_gain_db;
      sidechain_gain_ = std::exp(static_cast<double>(values.sidechain_gain_db) * kDbToNeper);
    }
    mix_ = std::clamp(static_cast<double>(values.sidechain_mix), 0.0, 1.0);
  }

  double rate_ = 48000.0;
  std::array<std::array<float, kCapacity>, 2> dry_{};
  uint32_t write_ = 0;
  uint32_t tick_ = 0;
  uint32_t delay_ = 0;
  bool filter_enabled_ = false;
  dsp::BiquadCoefficients filter_coefficients_{};
  std::array<dsp::Biquad<double>, 2> filters_{};
  double rms_decay_ = 0.0;
  double rms_gain_ = 0.0;
  uint32_t window_frames_ = 240;
  std::array<Window, 2> windows_{};
  std::array<double, 2> mean_square_{};
  std::array<bool, 2> open_{};
  std::array<bool, 2> started_{};
  std::array<uint32_t, 2> hold_{};
  std::array<double, 2> gain_db_{};
  std::array<double, 2> gain_applied_db_{};
  std::array<double, 2> gain_{};
  double open_level_ = 0.0;
  double close_level_ = 0.0;
  uint32_t hold_frames_ = 0;
  double attack_per_frame_ = 0.0;
  double release_per_frame_ = 0.0;
  double sidechain_gain_ = 1.0;
  double mix_ = 1.0;
  float cached_threshold_db_ = kUnset;
  float cached_hysteresis_db_ = kUnset;
  float cached_hold_ms_ = kUnset;
  float cached_attack_ms_ = kUnset;
  float cached_release_ms_ = kUnset;
  float cached_sidechain_gain_db_ = kUnset;
};

}  // namespace daw::audio_core
