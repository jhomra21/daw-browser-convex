#pragma once

// Delay DSP kernel, independent of the audio-core graph so it can be measured on its own.
//
// Signal path per channel: read the line (a 4-point Hermite tap), then write input + feedback into the same slot, so the loop is
// exactly the delay time. The feedback is soft-limited (transparent below -6 dBFS), may cross to the other channel (Ping Pong) and
// goes through an optional band-pass before the line, inside the loop, so every repeat is filtered. Freeze stops the input,
// closes the loop at unity and takes the limiter, the band-pass and the fractional part of the delay out of the loop so the loop
// content stays as it is. A change of delay time follows Repitch (the delay slews, so the pitch glides like a tape), Fade (a
// second tap crossfades in) or Jump (the delay moves at once). Sync resolves a division, its feel and an offset against the tempo.
// Arithmetic runs in double; the lines store float and the smoothers round to float, so the legacy worklet reproduces it.
#include "dsp/numeric_safety.h"
#include "dsp/parameter_smoother.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <memory>
#include <new>

namespace daw::audio_core {

struct DelayConfig {
  bool link = true;       // the right channel follows the left channel's time
  bool ping_pong = false;
  bool freeze = false;
  bool filter = false;
  uint32_t smoothing = 0;  // how a change of time is followed: 0 Repitch, 1 Fade, 2 Jump
  std::array<bool, 2> sync{{true, true}};
  std::array<uint32_t, 2> division{{2, 2}};  // index into the division table
  std::array<uint32_t, 2> feel{{0, 0}};      // 0 straight, 1 dotted, 2 triplet
};

struct DelayValues {
  std::array<float, 2> time_ms{{250.0F, 250.0F}};
  std::array<float, 2> offset_percent{{0.0F, 0.0F}};  // swing of a synced time
  float feedback = 0.25F;
  float dry_wet = 0.2F;
  float filter_hz = 1000.0F;
  float filter_width = 5.0F;  // octaves
  double tempo_bpm = 0.0;     // 0 when the host has not sent a tempo yet: kDefaultTempoBpm is used
};

class DelayKernel {
 public:
  // Frames between control updates: the delay targets and the band-pass design are taken once per tick.
  static constexpr uint32_t kControlFrames = 8;
  static constexpr double kMinimumDelayMs = 1.0;
  static constexpr double kMaximumDelayMs = 5000.0;
  static constexpr double kDefaultTempoBpm = 120.0;
  static constexpr std::array<double, 6> kDivisionBeats{0.125, 0.25, 0.5, 1.0, 2.0, 4.0};
  static constexpr std::array<double, 3> kFeelScale{1.0, 1.5, 2.0 / 3.0};
  // Repitch: the delay approaches its target with this time constant, at most kRepitchMaxSlope frames per frame, which keeps the
  // pitch of a repeat between 0.5 and 1.5 of the original however far the time moves.
  static constexpr double kRepitchGlideMs = 120.0;
  static constexpr double kRepitchMaxSlope = 0.5;
  static constexpr double kFadeMs = 40.0;
  // A retarget smaller than this does not start a fade.
  static constexpr double kFadeThresholdFrames = 0.01;
  // Below this level the loop is linear; above it the feedback bends towards 1.
  static constexpr double kLimiterKnee = 0.5;
  static constexpr double kPi = 3.14159265358979323846;

  // Allocates both lines for the longest time from the sample rate (the control thread's job).
  bool prepare(double sample_rate) {
    rate_ = sample_rate;
    uint32_t capacity = 8;
    const double needed = std::ceil(kMaximumDelayMs * 0.001 * sample_rate) + 8.0;
    while (capacity < needed) capacity <<= 1;
    arena_.reset(new (std::nothrow) float[2U * static_cast<size_t>(capacity)]());
    if (!arena_) return false;
    capacity_ = capacity;
    write_ = 0;
    feedback_.prepare(rate_, 20.0);
    wet_.prepare(rate_, 10.0);
    filter_hz_.prepare(rate_, 30.0);
    filter_width_.prepare(rate_, 30.0);
    filter_amount_.prepare(rate_, 20.0);
    freeze_.prepare(rate_, 30.0);
    glide_ = 1.0 - std::exp(-1000.0 / (kRepitchGlideMs * rate_));
    fade_step_ = 1.0 / (kFadeMs * 0.001 * rate_);
    initialized_ = false;
    reset();
    return true;
  }

  void reset() {
    std::fill_n(arena_.get(), 2U * static_cast<size_t>(capacity_), 0.0F);
    write_ = 0;
    for (auto &state : filter_state_) state = {};
    filter_active_ = false;
    frame_ = 0;
    initialized_ = false;
  }

  // The values and config are read once per kControlFrames: the caller builds them only when this is true.
  bool control_due() const { return (frame_ & (kControlFrames - 1U)) == 0U; }

  void process(const DelayValues &values, const DelayConfig &config, float input_left, float input_right, float &output_left, float &output_right) {
    const std::array<double, 2> dry{
      std::isfinite(input_left) ? static_cast<double>(input_left) : 0.0, std::isfinite(input_right) ? static_cast<double>(input_right) : 0.0};
    const bool tick = control_due();
    if (tick) apply(values, config);
    const double feedback = feedback_.next();
    const double wet = wet_.next();
    const double freeze = freeze_.next();
    const double filter_amount = filter_amount_.next();
    filter_hz_value_ = filter_hz_.next();
    filter_width_value_ = filter_width_.next();
    if (tick) design_filter();
    if (filter_amount <= 0.0 && filter_active_) {
      for (auto &state : filter_state_) state = {};
      filter_active_ = false;
    }
    if (filter_amount > 0.0) filter_active_ = true;
    const double loop_gain = feedback + (1.0 - feedback) * freeze;
    const double input_gain = 1.0 - freeze;
    const std::array<double, 2> tap{read_tap(0, freeze), read_tap(1, freeze)};
    std::array<double, 2> mixed{};
    for (uint32_t channel = 0; channel < 2; ++channel) {
      const double source = ping_pong_ ? tap[1 - channel] : tap[channel];
      const double limited = soft_limit(source);
      const double line_in = dry[channel] * input_gain + loop_gain * (limited + freeze * (source - limited));
      const double shaped = filter_active_ ? line_in + filter_amount * (band_pass(channel, line_in) - line_in) : line_in;
      arena_[static_cast<size_t>(channel) * capacity_ + (write_ & (capacity_ - 1U))] = dsp::flushDenormal(static_cast<float>(shaped));
      mixed[channel] = dry[channel] * (1.0 - wet) + tap[channel] * wet;
    }
    ++write_;
    ++frame_;
    output_left = static_cast<float>(dsp::finiteOrReset(*this, mixed[0]));
    output_right = static_cast<float>(dsp::finiteOrReset(*this, mixed[1]));
  }

 private:
  // One channel's read position. Repitch moves `to` along its slew; Fade keeps the outgoing `from` and crossfades with t.
  struct Head {
    double target = 0.0;
    double from = 0.0;
    double to = 0.0;
    double t = 1.0;
  };

  struct FilterState {
    double x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0;
  };

  void apply(const DelayValues &values, const DelayConfig &config) {
    ping_pong_ = config.ping_pong;
    smoothing_ = config.smoothing;
    const float freeze = config.freeze ? 1.0F : 0.0F;
    const float filter_amount = config.filter && !config.freeze ? 1.0F : 0.0F;
    std::array<double, 2> target{};
    for (uint32_t channel = 0; channel < 2; ++channel) target[channel] = delay_frames(values, config, config.link ? 0U : channel);
    if (!initialized_) {
      feedback_.reset(values.feedback);
      wet_.reset(values.dry_wet);
      filter_hz_.reset(values.filter_hz);
      filter_width_.reset(values.filter_width);
      filter_amount_.reset(filter_amount);
      freeze_.reset(freeze);
      filter_hz_value_ = values.filter_hz;
      filter_width_value_ = values.filter_width;
      for (uint32_t channel = 0; channel < 2; ++channel) head_[channel] = {target[channel], target[channel], target[channel], 1.0};
      initialized_ = true;
      return;
    }
    feedback_.setTarget(values.feedback);
    wet_.setTarget(values.dry_wet);
    filter_hz_.setTarget(values.filter_hz);
    filter_width_.setTarget(values.filter_width);
    filter_amount_.setTarget(filter_amount);
    freeze_.setTarget(freeze);
    for (uint32_t channel = 0; channel < 2; ++channel) head_[channel].target = target[channel];
  }

  double delay_frames(const DelayValues &values, const DelayConfig &config, uint32_t source) const {
    double ms = values.time_ms[source];
    if (config.sync[source]) {
      const double bpm = values.tempo_bpm > 0.0 ? values.tempo_bpm : kDefaultTempoBpm;
      const double beats = kDivisionBeats[std::min<uint32_t>(config.division[source], kDivisionBeats.size() - 1)]
        * kFeelScale[std::min<uint32_t>(config.feel[source], kFeelScale.size() - 1)];
      ms = beats * 60000.0 / bpm * (1.0 + values.offset_percent[source] / 100.0);
    }
    return std::clamp(ms, kMinimumDelayMs, kMaximumDelayMs) * 0.001 * rate_;
  }

  // The delay a head reads at. A frozen loop reads whole frames, because a fractional read filters the content on every pass.
  static double settled(double frames, double freeze) { return frames + freeze * (std::round(frames) - frames); }

  double read_tap(uint32_t channel, double freeze) {
    Head &head = head_[channel];
    if (smoothing_ == 2U) {
      head.to = head.target;
      head.t = 1.0;
    } else if (smoothing_ == 0U) {
      const double step = std::clamp((head.target - head.to) * glide_, -kRepitchMaxSlope, kRepitchMaxSlope);
      head.to = std::fabs(head.target - head.to) < kFadeThresholdFrames ? head.target : head.to + step;
      head.t = 1.0;
    } else if (head.t >= 1.0) {
      if (std::fabs(head.target - head.to) > kFadeThresholdFrames) {
        head.from = head.to;
        head.to = head.target;
        head.t = 0.0;
      }
    } else {
      head.t = std::min(1.0, head.t + fade_step_);
    }
    const double incoming = hermite(channel, settled(head.to, freeze));
    if (head.t >= 1.0) return incoming;
    const double outgoing = hermite(channel, settled(head.from, freeze));
    return std::sqrt(head.t) * incoming + std::sqrt(1.0 - head.t) * outgoing;
  }

  float sample(uint32_t channel, uint32_t age) const {
    return arena_[static_cast<size_t>(channel) * capacity_ + ((write_ - 1U - age) & (capacity_ - 1U))];
  }

  // Catmull-Rom between the two samples around the delay. The read happens before this frame's write, so a delay of d frames is
  // age d - 1; the minimum delay keeps every tap inside the written history.
  double hermite(uint32_t channel, double delay) const {
    const double age = delay - 1.0;
    const uint32_t whole = static_cast<uint32_t>(age);
    const double t = age - whole;
    const double p0 = sample(channel, whole - 1U), p1 = sample(channel, whole), p2 = sample(channel, whole + 1U), p3 = sample(channel, whole + 2U);
    const double c1 = 0.5 * (p2 - p0);
    const double c2 = p0 - 2.5 * p1 + 2.0 * p2 - 0.5 * p3;
    const double c3 = 0.5 * (p3 - p0) + 1.5 * (p1 - p2);
    return ((c3 * t + c2) * t + c1) * t + p1;
  }

  // Linear up to the knee, then a tanh that approaches 1: the slope is continuous at the knee.
  static double soft_limit(double x) {
    const double magnitude = std::fabs(x);
    if (magnitude <= kLimiterKnee) return x;
    return std::copysign(kLimiterKnee + (1.0 - kLimiterKnee) * std::tanh((magnitude - kLimiterKnee) / (1.0 - kLimiterKnee)), x);
  }

  // RBJ band-pass with constant 0 dB peak gain; the width is the -3 dB bandwidth in octaves. Redesigned only when a value moved.
  void design_filter() {
    if (filter_hz_value_ == designed_hz_ && filter_width_value_ == designed_width_) return;
    designed_hz_ = filter_hz_value_;
    designed_width_ = filter_width_value_;
    const double omega = 2.0 * kPi * std::clamp(static_cast<double>(filter_hz_value_), 20.0, rate_ * 0.49) / rate_;
    const double sine = std::sin(omega);
    const double alpha = sine * std::sinh(0.5 * std::log(2.0) * filter_width_value_ * omega / sine);
    const double a0 = 1.0 + alpha;
    gain_ = alpha / a0;
    a1_ = -2.0 * std::cos(omega) / a0;
    a2_ = (1.0 - alpha) / a0;
  }

  double band_pass(uint32_t channel, double input) {
    FilterState &state = filter_state_[channel];
    const double output = gain_ * (input - state.x2) - a1_ * state.y1 - a2_ * state.y2;
    state.x2 = state.x1;
    state.x1 = input;
    state.y2 = dsp::flushDenormal(state.y1);
    state.y1 = dsp::flushDenormal(output);
    return output;
  }

  double rate_ = 48000.0;
  double glide_ = 1.0;
  double fade_step_ = 1.0;
  std::unique_ptr<float[]> arena_;
  uint32_t capacity_ = 8;
  uint32_t write_ = 0;
  std::array<Head, 2> head_{};
  dsp::ParameterSmoother<> feedback_;
  dsp::ParameterSmoother<> wet_;
  dsp::ParameterSmoother<dsp::SmoothDomain::Log> filter_hz_;
  dsp::ParameterSmoother<> filter_width_;
  dsp::ParameterSmoother<> filter_amount_;
  dsp::ParameterSmoother<> freeze_;
  float filter_hz_value_ = 1000.0F;
  float filter_width_value_ = 5.0F;
  float designed_hz_ = 0.0F;
  float designed_width_ = 0.0F;
  double gain_ = 0.0, a1_ = 0.0, a2_ = 0.0;
  std::array<FilterState, 2> filter_state_{};
  bool filter_active_ = false;
  bool ping_pong_ = false;
  uint32_t smoothing_ = 0;
  uint32_t frame_ = 0;
  bool initialized_ = false;
};

}  // namespace daw::audio_core
