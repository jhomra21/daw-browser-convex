#pragma once

// Limiter DSP kernel, independent of the audio-core graph so it can be measured on its own.
//
// Signal path per channel: input gain -> true-peak detector (8x polyphase FIR, flat to 0.45 fs, plus the raw samples)
// -> gain target -> min-hold over the lookahead window -> two cascaded moving averages -> release stage -> gain on the
// audio delayed by exactly the lookahead -> safety clip at the ceiling.
//
// The min-hold window and the averages are sized so that the smoothed gain at the moment a sample leaves the delay
// line is never above the target computed for that sample (Hamalainen, DAFx-02; Signalsmith, "Designing a
// straightforward limiter"). The release stage is a min(), so it can only add gain reduction. The clip is the last
// resort that makes the ceiling a promise; the kernel counts how often it had to act.
#include "dsp/latency.h"
#include "dsp/numeric_safety.h"
#include "dsp/parameter_smoother.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

namespace daw::audio_core {

struct LimiterValues {
  float ceiling_dbtp = -1.0F;
  float release_ms = 100.0F;
  float link = 1.0F;
  float gain_db = 0.0F;
};

struct LimiterConfig {
  float lookahead_ms = 6.0F;
  bool auto_release = false;
};

class LimiterKernel {
 public:
  static constexpr uint32_t kOversample = 8;
  // The detector reads kPast frames before the sample it judges, which cost nothing, and ahead_ frames after it, which
  // come out of the lookahead. It takes all it can up to kMaximumAhead; a short lookahead keeps kBoxFrames for the
  // averages and gets a window that is cut short on that side.
  static constexpr uint32_t kPast = 64;
  static constexpr uint32_t kMinimumAhead = 12;
  static constexpr uint32_t kMaximumAhead = 64;
  static constexpr uint32_t kMaximumTaps = kPast + kMaximumAhead;
  static constexpr uint32_t kBoxFrames = 48;
  // The gain aims 0.03 dB under the ceiling so that the detector's rounding never leaves a peak for the clip to flatten:
  // a clip that touches every cycle by a hair would be audible as distortion, one that only meets real misses is not.
  static constexpr float kDetectorMargin = 0.99655F;
  static constexpr uint32_t kCapacity = 2048;
  static constexpr uint32_t kMask = kCapacity - 1;
  static constexpr uint32_t kMaximumBox = 1024;
  // Auto release: the fast stage answers isolated peaks; the slow stage engages as the gain reduction is sustained.
  static constexpr float kAutoFastMs = 25.0F;
  static constexpr float kAutoSlowMs = 500.0F;
  // The sustain is the share of the recent past the limiter spent working: it fills with kAutoBuildMs and the release
  // turns slow once it passes kAutoSlowFrom, fully so at kAutoSlowTo.
  static constexpr float kAutoBuildMs = 150.0F;
  static constexpr float kAutoSlowFrom = 0.15F;
  static constexpr float kAutoSlowTo = 0.65F;

  // Frames of delay for a lookahead. Short rates still need room for the detector and the two averages.
  static uint32_t latency_frames(float lookahead_ms, double sample_rate) {
    const uint32_t wanted = dsp::Latency::fromMilliseconds(lookahead_ms, sample_rate).frames;
    return std::clamp(wanted, kMinimumAhead + 2, kCapacity - 48);
  }

  LimiterKernel() { reset(); }

  void prepare(double sample_rate) {
    rate_ = sample_rate;
    gain_.prepare(sample_rate, 10.0);
    primed_ = false;
    cached_ceiling_db_ = -1000.0F;
    cached_release_ms_ = -1.0F;
    reset();
  }

  void reset() {
    for (auto &channel : channels_) channel = Channel{};
    write_ = 0;
    box_lengths_ = {1, 1};
    delay_ = 0;
  }

  uint64_t safety_clips() const { return safety_clips_; }

  void process(const LimiterValues &values, const LimiterConfig &config, float bypass, float input_left, float input_right,
    float &output_left, float &output_right) {
    configure(config.lookahead_ms);
    if (!primed_) {
      gain_.reset(values.gain_db);
      primed_ = true;
    }
    gain_.setTarget(values.gain_db);
    const float gain_db = gain_.next();
    if (gain_db != cached_gain_db_) {
      cached_gain_db_ = gain_db;
      input_gain_ = std::pow(10.0F, gain_db / 20.0F);
    }
    if (values.ceiling_dbtp != cached_ceiling_db_) {
      cached_ceiling_db_ = values.ceiling_dbtp;
      ceiling_ = std::pow(10.0F, values.ceiling_dbtp / 20.0F);
    }
    if (values.release_ms != cached_release_ms_) {
      cached_release_ms_ = values.release_ms;
      release_ = one_pole(values.release_ms);
    }

    const std::array<float, 2> input{
      dsp::flushDenormal(std::isfinite(input_left) ? input_left : 0.0F),
      dsp::flushDenormal(std::isfinite(input_right) ? input_right : 0.0F)};
    const uint32_t slot = write_ & kMask;
    std::array<float, 2> target{};
    for (uint32_t c = 0; c < 2; ++c) {
      channels_[c].dry[slot] = input[c];
      channels_[c].gained[slot] = input[c] * input_gain_;
    }
    for (uint32_t c = 0; c < 2; ++c) target[c] = std::min(1.0F, ceiling_ * kDetectorMargin / std::max(true_peak(channels_[c]), 1.0e-12F));
    const float linked = std::min(target[0], target[1]);

    const uint32_t read = (write_ - delay_) & kMask;
    std::array<float, 2> wet{};
    for (uint32_t c = 0; c < 2; ++c) {
      Channel &channel = channels_[c];
      const float held = channel.minimum.push(target[c] + (linked - target[c]) * values.link, delay_ - ahead_ + 1);
      const float smooth = channel.second.push(channel.first.push(held, box_lengths_[0]), box_lengths_[1]);
      channel.gain = std::min(smooth, 1.0F + release_coefficient(channel, config.auto_release) * (channel.gain - 1.0F));
      if (config.auto_release) track_sustain(channel, smooth);
      float out = channel.gained[read] * channel.gain;
      if (std::fabs(out) > ceiling_) {
        // Rounding of the gain itself is not an event; anything past it is the detector's miss.
        if (std::fabs(out) > ceiling_ * 1.00001F) ++safety_clips_;
        out = std::copysign(ceiling_, out);
      }
      wet[c] = out;
    }
    const float left = wet[0] + (channels_[0].dry[read] - wet[0]) * bypass;
    const float right = wet[1] + (channels_[1].dry[read] - wet[1]) * bypass;
    ++write_;
    if (!std::isfinite(channels_[0].gain) || !std::isfinite(channels_[1].gain)) reset();
    output_left = dsp::finiteOrReset(*this, left);
    output_right = dsp::finiteOrReset(*this, right);
  }

 private:
  // Sliding minimum of the last window + 1 pushes, in O(1) per push.
  struct SlidingMinimum {
    std::array<float, kCapacity> value{};
    std::array<uint32_t, kCapacity> frame{};
    uint32_t head = 0;
    uint32_t count = 0;
    uint32_t now = 0;

    float push(float target, uint32_t window) {
      const auto slot = [this](uint32_t offset) { return (head + offset) & kMask; };
      while (count > 0 && value[slot(count - 1)] >= target) --count;
      while (count > 0 && now - frame[slot(0)] > window) {
        head = slot(1);
        --count;
      }
      const uint32_t tail = slot(count);
      value[tail] = target;
      frame[tail] = now++;
      ++count;
      return value[slot(0)];
    }
  };

  // Moving average of the last `length` pushes, started at unity gain. The sum is exact: every ring entry is a float
  // held in a double.
  struct Box {
    std::array<float, kMaximumBox> ring{};
    double sum = 0.0;
    uint32_t index = 0;

    void start(uint32_t length) {
      ring.fill(1.0F);
      sum = static_cast<double>(length);
      index = 0;
    }

    float push(float value, uint32_t length) {
      sum += static_cast<double>(value) - static_cast<double>(ring[index]);
      ring[index] = value;
      index = index + 1 >= length ? 0 : index + 1;
      return static_cast<float>(sum / static_cast<double>(length));
    }
  };

  struct Channel {
    std::array<float, kCapacity> dry{};
    std::array<float, kCapacity> gained{};
    SlidingMinimum minimum{};
    Box first{};
    Box second{};
    float gain = 1.0F;
    float sustain = 0.0F;
  };

  // The detector reads kGrid points per input sample at 1/kOversample spacing, from one point before the sample it judges
  // to one after the next, so a parabola can be fitted around the largest.
  static constexpr uint32_t kGrid = kOversample + 3;

  struct Coefficients {
    std::array<std::array<float, kMaximumTaps>, kGrid> point{};
    float bound = 1.0F;  // largest sum of |tap| over the points: no interpolated value exceeds bound * max |x|
  };

  // Windowed sinc cut at fs/2, kPast + ahead taps per point, each point normalised to unit gain at DC. The window is cos^0.75:
  // a rectangular window leaves the sinc's ripple at low frequencies, which would show as gain wobble on a steady tone,
  // and cos^2 (Hann) narrows the passband so much that content near fs/2 is read low. This one leaves the 997 Hz reading
  // flat to about 0.002 dB and reads white noise within 0.05 dB.
  void design(uint32_t ahead) {
    constexpr double kPi = 3.14159265358979323846;
    coefficients_.bound = 1.0F;
    for (uint32_t i = 0; i < kGrid; ++i) {
      if (i == 1 || i == kOversample + 1) continue;  // the raw samples
      double sum = 0.0;
      std::array<double, kMaximumTaps> weights{};
      for (uint32_t j = 0; j < kPast + ahead; ++j) {
        // Sample j sits at offset j - (kPast - 1) from the sample the detector judges. The window spans kPast frames on
        // the side of earlier samples and `ahead` on the other.
        const double distance = (static_cast<double>(i) - 1.0) / kOversample - (static_cast<double>(j) - (kPast - 1.0));
        const double ratio = distance > 0.0 ? distance / kPast : distance / ahead;
        const double window = std::fabs(ratio) >= 1.0 ? 0.0 : std::pow(std::cos(0.5 * kPi * ratio), 0.75);
        weights[j] = (distance == 0.0 ? 1.0 : std::sin(kPi * distance) / (kPi * distance)) * window;
        sum += weights[j];
      }
      double absolute = 0.0;
      for (uint32_t j = 0; j < kPast + ahead; ++j) {
        coefficients_.point[i][j] = static_cast<float>(weights[j] / sum);
        absolute += std::fabs(weights[j] / sum);
      }
      coefficients_.bound = std::max(coefficients_.bound, static_cast<float>(absolute));
    }
  }

  // Largest magnitude of the waveform between the sample the detector judges and the next one.
  // Nothing needs computing while the window cannot reach the ceiling even at the filter's largest gain.
  float true_peak(const Channel &channel) const {
    const uint32_t taps = kPast + ahead_;
    std::array<float, kMaximumTaps> window{};
    float largest = 0.0F;
    for (uint32_t j = 0; j < taps; ++j) {
      window[j] = channel.gained[(write_ - (taps - 1) + j) & kMask];
      largest = std::max(largest, std::fabs(window[j]));
    }
    if (largest * coefficients_.bound <= ceiling_ * kDetectorMargin) return largest * coefficients_.bound;
    std::array<float, kGrid> grid{};
    grid[1] = std::fabs(window[kPast - 1]);
    grid[kOversample + 1] = std::fabs(window[kPast]);
    for (uint32_t i = 0; i < kGrid; ++i) {
      if (i == 1 || i == kOversample + 1) continue;
      const float *point = coefficients_.point[i].data();
      std::array<float, 4> partial{};
      for (uint32_t j = 0; j < taps; j += 4) {
        partial[0] += window[j] * point[j];
        partial[1] += window[j + 1] * point[j + 1];
        partial[2] += window[j + 2] * point[j + 2];
        partial[3] += window[j + 3] * point[j + 3];
      }
      grid[i] = std::fabs((partial[0] + partial[1]) + (partial[2] + partial[3]));
    }
    uint32_t at = 1;
    for (uint32_t i = 2; i <= kOversample + 1; ++i) if (grid[i] > grid[at]) at = i;
    // The vertex of the parabola through the largest point and its neighbours: the spacing alone would under-read a
    // sine near 0.45 fs by up to 0.14 dB. A largest point that is not a local maximum means the peak lies in a
    // neighbouring interval, whose own pass reads it.
    if (grid[at - 1] > grid[at] || grid[at + 1] > grid[at]) return grid[at];
    const float curvature = 2.0F * grid[at] - grid[at - 1] - grid[at + 1];
    return curvature > 0.0F ? grid[at] + (grid[at + 1] - grid[at - 1]) * (grid[at + 1] - grid[at - 1]) / (8.0F * curvature) : grid[at];
  }

  float one_pole(float milliseconds) const {
    return std::exp(-1.0F / (std::max(milliseconds, 0.01F) * 0.001F * static_cast<float>(rate_)));
  }

  float release_coefficient(const Channel &channel, bool auto_release) const {
    if (!auto_release) return release_;
    const float slow = std::clamp((channel.sustain - kAutoSlowFrom) / (kAutoSlowTo - kAutoSlowFrom), 0.0F, 1.0F);
    return one_pole(kAutoFastMs + (kAutoSlowMs - kAutoFastMs) * slow);
  }

  // The sustain only rises while the smoothed gain is what sets the output, that is while the limiter is working; it
  // falls at the slow stage's pace once the gain is released, so the slow stage outlasts the signal that built it.
  void track_sustain(Channel &channel, float smooth) const {
    const bool working = smooth < 1.0F && channel.gain == smooth;
    channel.sustain = dsp::flushDenormal(working ? channel.sustain + (1.0F - channel.sustain) * (1.0F - auto_build_)
                                                 : channel.sustain * auto_decay_);
  }

  void configure(float lookahead_ms) {
    const uint32_t delay = latency_frames(lookahead_ms, rate_);
    if (delay == delay_) return;
    reset();
    delay_ = delay;
    ahead_ = std::clamp(delay_ - kBoxFrames, kMinimumAhead, kMaximumAhead) & ~1U;
    design(ahead_);
    // The detector judges the interval after the sample D - H frames back, and the held targets must cover that interval
    // and its two neighbours: a min-hold window of D - H + 2 frames, and two boxes whose supports add to D - H.
    const uint32_t span = delay_ - ahead_ + 1;
    box_lengths_ = {std::min((span + 1) / 2, kMaximumBox), std::min(span / 2, kMaximumBox)};
    for (Channel &channel : channels_) {
      channel.first.start(box_lengths_[0]);
      channel.second.start(box_lengths_[1]);
    }
    auto_build_ = one_pole(kAutoBuildMs);
    auto_decay_ = one_pole(kAutoSlowMs);
  }

  double rate_ = 48000.0;
  dsp::ParameterSmoother<> gain_{};
  bool primed_ = false;
  std::array<Channel, 2> channels_{};
  std::array<uint32_t, 2> box_lengths_{1, 1};
  Coefficients coefficients_{};
  uint32_t delay_ = 0;
  uint32_t ahead_ = kMinimumAhead;
  uint32_t write_ = 0;
  float input_gain_ = 1.0F;
  float ceiling_ = 0.891F;
  float release_ = 0.0F;
  float auto_build_ = 0.0F;
  float auto_decay_ = 0.0F;
  float cached_gain_db_ = 0.0F;
  float cached_ceiling_db_ = -1000.0F;
  float cached_release_ms_ = -1.0F;
  uint64_t safety_clips_ = 0;
};

}  // namespace daw::audio_core
