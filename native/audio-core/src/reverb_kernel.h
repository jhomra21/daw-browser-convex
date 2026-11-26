#pragma once

// Reverb DSP kernel, independent of the audio-core graph so it can be measured on its own.
//
// Signal path per frame: input filters (true Lo/Hi Cut) -> pre-delay ring. Two feeds leave the ring: the early reflections
// (a feed-forward cascade of delay-and-add stages, which Spin modulates) and the diffuse tail (read after the Shape-set onset,
// spread by a multichannel diffuser, then fed into a feedback delay network). Every network line carries a decay filter
// designed from a T60 curve (Jot): a broadband gain sets the mid-band RT60 from the line length, and a low and a high
// first-order shelf move the RT60 at the band edges, so with the shelves flat the Decay knob is the RT60. The lines are read
// through first-order allpass interpolation (unity gain at every frequency), so the Chorus modulation and the Size glide do not
// cost loop gain. The feedback matrix is a Householder reflection (orthogonal, so the line gains alone set the decay).
// Arithmetic runs in double and only the delay rings store float, so the legacy worklet reproduces it with Float32Array rings.
#include "dsp/numeric_safety.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <memory>
#include <new>

namespace daw::audio_core {

struct ReverbConfig {
  uint32_t smooth = 2;  // how fast Size glides: 0 none (a jump), 1 slow, 2 fast
  bool spin = true;     // modulate the early reflections
  bool chorus = true;   // modulate the tail lines
  bool high_shelf = true;
  bool low_shelf = true;
  bool freeze = false;  // the tail stops decaying
  bool flat = false;    // while frozen, bypass the shelves
  bool cut = false;     // while frozen, stop feeding the input into the tail
};

struct ReverbValues {
  float wet = 0.25F;
  float decay_sec = 2.2F;
  float pre_delay_ms = 20.0F;
  float reflections = 0.5F;
  float spin_amount_ms = 17.5F;
  float spin_rate_hz = 0.3F;
  float shape = 0.5F;
  float diffuse = 1.0F;
  float size = 0.65F;
  float diffusion = 0.75F;
  float low_cut_hz = 20.0F;
  float high_cut_hz = 20000.0F;
  float low_shelf_hz = 200.0F;
  float high_shelf_hz = 5000.0F;
  float low_shelf_db = 0.0F;
  float high_shelf_db = 0.0F;
  float chorus_amount_ms = 0.6F;
  float chorus_rate_hz = 0.6F;
  float stereo_degrees = 120.0F;
};

class ReverbKernel {
 public:
  static constexpr uint32_t kDensityCount = 4;
  static constexpr uint32_t kMaximumLines = 16;
  static constexpr uint32_t kMaximumChannels = 16;
  static constexpr uint32_t kMaximumSteps = 3;
  // Frames between control updates: the chorus and Spin delays, which move slowly, are recomputed once per tick.
  static constexpr uint32_t kControlFrames = 8;
  static constexpr uint32_t kReflectionStages = 8;

  // 48 kHz frame lengths of the sixteen loop lines at Size 1. Distinct primes keep the lines mutually incommensurate; Sparse
  // uses every other one, Low spreads twelve over the table, Mid and High use all sixteen. The shortest lines (10 ms) are what
  // fills the tail in before the diffuser has died away.
  static constexpr std::array<double, kMaximumLines> kLineFrames48k{
    503.0, 631.0, 773.0, 919.0, 1069.0, 1217.0, 1373.0, 1531.0, 1693.0, 1861.0, 2039.0, 2213.0, 2393.0, 2579.0, 2777.0, 3011.0};
  static constexpr std::array<uint32_t, kDensityCount> kLineCount{8, 12, 16, 16};
  static constexpr std::array<uint32_t, kDensityCount> kChannelCount{8, 8, 16, 16};
  static constexpr std::array<uint32_t, kDensityCount> kStepCount{2, 2, 2, 3};
  static constexpr std::array<uint32_t, kMaximumSteps> kDiffuserStride{3, 5, 7};
  static constexpr double kDiffuserBaseMs = 4.0;
  // Early-reflection stage delays in ms at the largest Size, one cascade per channel.
  static constexpr std::array<std::array<double, kReflectionStages>, 2> kReflectionStageMs{{
    {1.3, 2.3, 3.9, 6.1, 9.7, 13.9, 18.9, 24.1}, {1.5, 2.7, 4.3, 6.7, 10.3, 14.5, 19.7, 25.3}}};
  static constexpr std::array<double, 4> kChorusRateRatio{1.0, 1.071, 0.937, 1.123};
  static constexpr double kPi = 3.14159265358979323846;
  // Gain of the early reflections at Reflect 1 over the cascade normalised to the dry level. It puts their energy 6 dB under the
  // tail's (measured: 11.9 dB under without it), so the default Reflect of 0.5 sits 12 dB under.
  static constexpr double kReflectionLevel = 2.0;
  // Largest change of the longest line, in frames per frame, while Size glides: Fast moves the pitch of the lines by 1 % at most.
  static constexpr double kFastGlide = 0.01;
  static constexpr double kSlowGlide = 0.002;
  static constexpr double kPreDelayGlide = 0.1;
  static constexpr double kMaximumPreDelayMs = 250.0;
  static constexpr double kMaximumChorusMs = 5.0;
  // The diffuser reaches the output directly, so the tail fills in while the network lines are still on their first trip.
  static constexpr double kDiffuserTap = 0.7;
  // Gain of the whole wet path. It sets the impulse response of the defaults (Decay 2.2 s, Size 0.65, Reflect 0) to a total
  // energy of about 1 over both channels, which is what the previous network produced, so migrated projects keep their loudness.
  static constexpr double kWetLevel = 0.27;

  // Allocates the whole network in one block (the control thread's job); returns false when memory is short.
  bool prepare(double sample_rate, uint32_t density) {
    rate_ = sample_rate;
    k48_ = sample_rate / 48000.0;
    const uint32_t chosen = std::min(density, kDensityCount - 1);
    lines_ = kLineCount[chosen];
    channels_ = kChannelCount[chosen];
    steps_ = kStepCount[chosen];
    diffuser_scale_ = 1.0 / std::sqrt(static_cast<double>(channels_));
    feed_ = std::sqrt(2.0 / static_cast<double>(channels_));
    const auto frames_for = [&](double ms) { return static_cast<uint32_t>(std::ceil(ms * 0.001 * sample_rate)) + 8U; };
    input_mask_ = power_of_two_for(frames_for(kMaximumPreDelayMs + 30.0 + 12.5)) - 1U;
    reflection_mask_ = power_of_two_for(frames_for(kReflectionStageMs[1][kReflectionStages - 1] * 2.0)) - 1U;
    line_mask_ = power_of_two_for(static_cast<uint32_t>(std::ceil(kLineFrames48k[kMaximumLines - 1] * 1.2 * k48_ + kMaximumChorusMs * 0.001 * sample_rate)) + 8U) - 1U;
    size_t total = 2U * (input_mask_ + 1U) + 2U * kReflectionStages * (reflection_mask_ + 1U) + static_cast<size_t>(lines_) * (line_mask_ + 1U);
    for (uint32_t step = 0; step < steps_; ++step) {
      diffuser_mask_[step] = power_of_two_for(frames_for(kDiffuserBaseMs * static_cast<double>(1U << step))) - 1U;
      total += static_cast<size_t>(diffuser_mask_[step] + 1U) * channels_;
    }
    arena_.reset(new (std::nothrow) float[total]());
    if (!arena_) return false;
    float *cursor = arena_.get();
    const auto take = [&cursor](size_t count) {
      float *start = cursor;
      cursor += count;
      return start;
    };
    for (auto &channel : input_) channel = take(input_mask_ + 1U);
    for (auto &channel : reflection_) channel = take(static_cast<size_t>(reflection_mask_ + 1U) * kReflectionStages);
    for (uint32_t step = 0; step < steps_; ++step) {
      diffuser_[step] = take(static_cast<size_t>(diffuser_mask_[step] + 1U) * channels_);
      // Each step spreads its channels over one range; the stride deals the slots out so the Hadamard output order does not
      // set the delay order. A step's gain carries the sign flip and the 1/sqrt(N) of the Hadamard before it.
      const double range_ms = kDiffuserBaseMs * static_cast<double>(1U << step);
      for (uint32_t channel = 0; channel < channels_; ++channel) {
        const double position = 0.15 + 0.7 * fraction(0.6180339887498949 * static_cast<double>(1U + channel + 5U * step));
        const double slot = static_cast<double>((channel * kDiffuserStride[step]) % channels_);
        diffuser_delay_[step][channel] = static_cast<uint32_t>(std::max(1.0, std::round(range_ms * (slot + position) / static_cast<double>(channels_) * 0.001 * sample_rate)));
        const double flip = (channel * 13U + step * 7U + 5U) % 3U == 0U ? -1.0 : 1.0;
        diffuser_gain_[step][channel] = step == 0U ? flip : flip * diffuser_scale_;
      }
    }
    lines_buffer_ = take(static_cast<size_t>(line_mask_ + 1U) * lines_);
    arena_size_ = total;
    for (uint32_t line = 0; line < lines_; ++line) {
      const uint32_t slot = line * kMaximumLines / lines_;
      line_base_[line] = kLineFrames48k[slot] * k48_;
      tap_left_[line] = parity(slot & 6U) ? -1.0 : 1.0;
      tap_right_[line] = parity(slot & 11U) ? -1.0 : 1.0;
      const double angle = 2.0 * kPi * fraction(0.3819660112501051 * static_cast<double>(line + 1U));
      chorus_cos_[line] = std::cos(angle);
      chorus_sin_[line] = std::sin(angle);
    }
    // Walsh-pattern signs would pick out one Hadamard component of the diffuser output, so these are irregular.
    for (uint32_t channel = 0; channel < channels_; ++channel) {
      diffuser_tap_left_[channel] = kDiffuserTap * diffuser_scale_ * (fraction(0.7548776662466927 * static_cast<double>(channel + 1U)) < 0.5 ? 1.0 : -1.0);
      diffuser_tap_right_[channel] = kDiffuserTap * diffuser_scale_ * (fraction(0.5698402909980532 * static_cast<double>(channel + 3U)) < 0.5 ? 1.0 : -1.0);
    }
    for (uint32_t stage = 0; stage < kReflectionStages; ++stage) {
      for (uint32_t channel = 0; channel < 2; ++channel) {
        const double angle = 2.0 * kPi * fraction(0.6180339887498949 * static_cast<double>(stage + 1U) + 0.5 * static_cast<double>(channel));
        spin_cos_[channel][stage] = std::cos(angle);
        spin_sin_[channel][stage] = std::sin(angle);
        reflection_sign_[channel][stage] = (stage + channel) % 3U == 1U ? -1.0 : 1.0;
      }
    }
    wet_.prepare(rate_, 10.0);
    diffuse_.prepare(rate_, 20.0);
    reflect_.prepare(rate_, 20.0);
    diffusion_.prepare(rate_, 30.0);
    stereo_.prepare(rate_, 30.0);
    input_gain_.prepare(rate_, 20.0);
    freeze_.prepare(rate_, 50.0);
    pre_delay_.step = kPreDelayGlide;
    onset_.step = kPreDelayGlide;
    dc_coefficient_ = 1.0 - 2.0 * kPi * 8.0 / rate_;
    initialized_ = false;
    reset();
    return true;
  }

  void reset() {
    std::fill_n(arena_.get(), arena_size_, 0.0F);
    line_allpass_.fill(0.0);
    low_state_.fill(0.0);
    high_state_.fill(0.0);
    for (auto &channel : input_filter_) channel = {};
    dc_in_.fill(0.0);
    dc_out_.fill(0.0);
    chorus_sine_.fill(0.0);
    chorus_cosine_.fill(1.0);
    spin_sine_ = 0.0;
    spin_cosine_ = 1.0;
    frame_ = 0;
  }

  // The values and config are read once per kControlFrames: the caller builds them only when this is true.
  bool control_due() const { return (frame_ & (kControlFrames - 1U)) == 0U; }

  void process(const ReverbValues &values, const ReverbConfig &config, float input_left, float input_right, float &output_left, float &output_right) {
    const double dry_left = std::isfinite(input_left) ? static_cast<double>(input_left) : 0.0;
    const double dry_right = std::isfinite(input_right) ? static_cast<double>(input_right) : 0.0;
    if (control_due()) apply(values, config);

    const double wet = wet_.next();
    const double diffuse = diffuse_.next();
    const double reflect = reflect_.next();
    const double diffusion = diffusion_.next();
    const double input_gain = input_gain_.next();
    const double freeze = freeze_.next();
    const double size = size_.next();
    const double pre_delay = pre_delay_.next();
    const double onset = onset_.next();
    const double stereo = stereo_.next();
    if (stereo != stereo_last_) {
      stereo_last_ = stereo;
      stereo_cos_ = std::cos(stereo);
      stereo_sin_ = std::sin(stereo);
    }
    const bool moved = size != size_last_ || freeze != freeze_last_;
    size_last_ = size;
    freeze_last_ = freeze;
    if (moved) gliding_ = true;
    if (dirty_ || (gliding_ && (frame_ & 31U) == 0U)) {
      design(size, freeze);
      dirty_ = false;
      if (!moved) gliding_ = false;
    }

    // Input filters.
    double left = dry_left;
    double right = dry_right;
    if (low_cut_active_) {
      left = input_filter_[0].low.run(left, low_cut_);
      right = input_filter_[1].low.run(right, low_cut_);
    }
    if (high_cut_active_) {
      left = input_filter_[0].high.run(left, high_cut_);
      right = input_filter_[1].high.run(right, high_cut_);
    }

    const uint32_t n = frame_;
    if ((n & (kControlFrames - 1U)) == 0U) control_tick(size);
    const double tail_delay = pre_delay + onset;
    const std::array<double, 2> tail_input{read_input(0, tail_delay), read_input(1, tail_delay)};
    std::array<double, 2> early{0.0, 0.0};
    if (reflect > 0.0) early = reflections(n, pre_delay, reflect);

    std::array<double, kMaximumChannels> bus;
    if (channels_ == 16U) run_diffuser<16>(n, tail_input, bus);
    else run_diffuser<8>(n, tail_input, bus);

    // Loop lines. The diffuser also reaches the output directly, so the tail is already dense while the lines are on their first trip.
    const double inject = std::sqrt(static_cast<double>(channels_) / static_cast<double>(lines_)) * input_gain;
    std::array<double, kMaximumLines> out;
    double sum = 0.0;
    double tail_left = 0.0;
    double tail_right = 0.0;
    for (uint32_t channel = 0; channel < channels_; ++channel) {
      tail_left += diffuser_tap_left_[channel] * bus[channel];
      tail_right += diffuser_tap_right_[channel] * bus[channel];
    }
    for (uint32_t line = 0; line < lines_; ++line) {
      const float *ring = lines_buffer_ + line;
      const uint32_t whole = line_whole_[line];
      double value = static_cast<double>(ring[static_cast<size_t>((n - whole - 1U) & line_mask_) * lines_]);
      if (dynamic_) {
        const double newer = static_cast<double>(ring[static_cast<size_t>((n - whole) & line_mask_) * lines_]);
        value += line_eta_[line] * (newer - line_allpass_[line]);
        line_allpass_[line] = dsp::flushDenormal(value);
      }
      value *= line_gain_[line];
      if (low_active_) {
        const double filtered = low_coefficient_[line].b0 * value + low_state_[line];
        low_state_[line] = low_coefficient_[line].b1 * value - low_coefficient_[line].a1 * filtered;
        value = filtered;
      }
      if (high_active_) {
        const double filtered = high_coefficient_[line].b0 * value + high_state_[line];
        high_state_[line] = high_coefficient_[line].b1 * value - high_coefficient_[line].a1 * filtered;
        value = filtered;
      }
      out[line] = value;
      sum += value;
      tail_left += tap_left_[line] * value;
      tail_right += tap_right_[line] * value;
    }
    const double reflection = 2.0 * sum / static_cast<double>(lines_);
    const double crossfade = diffusion * diffuser_scale_;
    for (uint32_t line = 0; line < lines_; ++line) {
      const double fed = tail_input[line & 1U] * feed_ * (1.0 - diffusion) + bus[line % channels_] * crossfade;
      const double injected = (line >= channels_ ? -fed : fed) * inject;
      lines_buffer_[static_cast<size_t>(n & line_mask_) * lines_ + line] = dsp::flushDenormal(static_cast<float>(out[line] - reflection + injected));
    }

    input_[0][n & input_mask_] = static_cast<float>(left);
    input_[1][n & input_mask_] = static_cast<float>(right);
    ++frame_;

    // Output: tail and reflections through the DC blocker, the Stereo matrix, then the dry/wet mix.
    const double tail_gain = diffuse * size_compensation_;
    const double wet_left = dc_block(0, (tail_left * tail_gain + early[0]) * kWetLevel);
    const double wet_right = dc_block(1, (tail_right * tail_gain + early[1]) * kWetLevel);
    const double mid = (wet_left + wet_right) * 0.7071067811865476;
    const double side = (wet_left - wet_right) * 0.7071067811865476;
    const double stereo_left = stereo_cos_ * mid + stereo_sin_ * side;
    const double stereo_right = stereo_cos_ * mid - stereo_sin_ * side;
    const double mixed_left = dry_left * (1.0 - wet) + stereo_left * wet;
    const double mixed_right = dry_right * (1.0 - wet) + stereo_right * wet;
    output_left = static_cast<float>(dsp::finiteOrReset(*this, mixed_left));
    output_right = static_cast<float>(dsp::finiteOrReset(*this, mixed_right));
  }

 private:
  struct OnePole {
    double current = 0.0;
    double target = 0.0;
    double coefficient = 1.0;
    void prepare(double rate, double ms) { coefficient = 1.0 - std::exp(-1000.0 / (ms * rate)); }
    double next() {
      if (current != target) {
        current += coefficient * (target - current);
        if (std::fabs(target - current) < 1.0e-6) current = target;
      }
      return current;
    }
  };

  struct Glide {
    double current = 0.0;
    double target = 0.0;
    double step = 1.0;
    double next() {
      const double distance = target - current;
      if (distance > step) current += step;
      else if (distance < -step) current -= step;
      else current = target;
      return current;
    }
  };

  struct Section {
    double b0 = 1.0, b1 = 0.0, a1 = 0.0;
  };

  struct Biquad {
    double b0 = 1.0, b1 = 0.0, b2 = 0.0, a1 = 0.0, a2 = 0.0;
  };

  struct BiquadState {
    double s1 = 0.0, s2 = 0.0;
    double run(double x, const Biquad &c) {
      const double y = c.b0 * x + s1;
      s1 = c.b1 * x - c.a1 * y + s2;
      s2 = c.b2 * x - c.a2 * y;
      return y;
    }
  };

  struct InputFilter {
    BiquadState low;
    BiquadState high;
  };

  static uint32_t power_of_two_for(uint32_t frames) {
    uint32_t size = 1;
    while (size < frames) size <<= 1U;
    return size;
  }
  static double fraction(double value) { return value - std::floor(value); }
  static bool parity(uint32_t value) {
    bool odd = false;
    for (; value != 0U; value >>= 1U) odd = odd != ((value & 1U) != 0U);
    return odd;
  }

  template <uint32_t N>
  static void hadamard(std::array<double, N> &x) {
    for (uint32_t span = 1; span < N; span <<= 1U) {
      for (uint32_t start = 0; start < N; start += 2U * span) {
        for (uint32_t index = start; index < start + span; ++index) {
          const double sum = x[index] + x[index + span];
          x[index + span] = x[index] - x[index + span];
          x[index] = sum;
        }
      }
    }
  }

  // Feed-forward multichannel diffuser: each step delays every channel by its own time, flips some signs and mixes the channels
  // with a Hadamard matrix. Its rings hold the N channels of a frame side by side. The output is left unscaled (diffuser_scale_).
  template <uint32_t N>
  void run_diffuser(uint32_t n, const std::array<double, 2> &input, std::array<double, kMaximumChannels> &bus) {
    std::array<double, N> x;
    for (uint32_t channel = 0; channel < N; ++channel) x[channel] = input[channel & 1U] * feed_;
    for (uint32_t step = 0; step < steps_; ++step) {
      const uint32_t mask = diffuser_mask_[step];
      float *ring = diffuser_[step];
      float *row = ring + static_cast<size_t>(n & mask) * N;
      for (uint32_t channel = 0; channel < N; ++channel) row[channel] = static_cast<float>(x[channel]);
      for (uint32_t channel = 0; channel < N; ++channel) {
        x[channel] = diffuser_gain_[step][channel] * static_cast<double>(ring[static_cast<size_t>((n - diffuser_delay_[step][channel]) & mask) * N + channel]);
      }
      hadamard<N>(x);
    }
    for (uint32_t channel = 0; channel < N; ++channel) bus[channel] = x[channel];
  }

  double read_input(uint32_t channel, double delay) const {
    const double clamped = std::max(1.0, delay);
    const uint32_t whole = static_cast<uint32_t>(clamped);
    const double fractional = clamped - static_cast<double>(whole);
    const uint32_t n = frame_;
    const double newer = static_cast<double>(input_[channel][(n - whole) & input_mask_]);
    const double older = static_cast<double>(input_[channel][(n - whole - 1U) & input_mask_]);
    return newer + (older - newer) * fractional;
  }

  // Feed-forward cascade: every stage adds a delayed, scaled copy of what the stages before it produced, so eight stages leave
  // 256 echoes whose level falls with their delay. The Shape sets the stage gain; Spin moves each stage's delay (see control_tick).
  std::array<double, 2> reflections(uint32_t n, double pre_delay, double level) {
    std::array<double, 2> result{0.0, 0.0};
    for (uint32_t channel = 0; channel < 2; ++channel) {
      double x = read_input(channel, pre_delay);
      for (uint32_t stage = 0; stage < kReflectionStages; ++stage) {
        float *ring = reflection_[channel] + stage;
        ring[static_cast<size_t>(n & reflection_mask_) * kReflectionStages] = static_cast<float>(x);
        const uint32_t whole = reflection_whole_[channel][stage];
        const double newer = static_cast<double>(ring[static_cast<size_t>((n - whole) & reflection_mask_) * kReflectionStages]);
        const double older = static_cast<double>(ring[static_cast<size_t>((n - whole - 1U) & reflection_mask_) * kReflectionStages]);
        x += reflection_gain_ * reflection_sign_[channel][stage] * (newer + (older - newer) * reflection_fraction_[channel][stage]);
      }
      result[channel] = x * reflection_norm_ * level;
    }
    return result;
  }

  double dc_block(uint32_t channel, double x) {
    const double y = x - dc_in_[channel] + dc_coefficient_ * dc_out_[channel];
    dc_in_[channel] = x;
    dc_out_[channel] = dsp::flushDenormal(y);
    return y;
  }

  // Once per kControlFrames: moves the chorus and Spin oscillators on and recomputes the delays they steer. The steps are far
  // under a frame for the amounts the controls allow (Chorus 5 ms at 5 Hz moves a line 0.4 frame per tick at most).
  void control_tick(double size) {
    for (uint32_t base = 0; base < 4; ++base) {
      const double sine = chorus_sine_[base] * chorus_step_cos_[base] + chorus_cosine_[base] * chorus_step_sin_[base];
      chorus_cosine_[base] = chorus_cosine_[base] * chorus_step_cos_[base] - chorus_sine_[base] * chorus_step_sin_[base];
      chorus_sine_[base] = sine;
    }
    const double spin = spin_sine_ * spin_step_cos_ + spin_cosine_ * spin_step_sin_;
    spin_cosine_ = spin_cosine_ * spin_step_cos_ - spin_sine_ * spin_step_sin_;
    spin_sine_ = spin;
    if (((frame_ / kControlFrames) & 127U) == 127U) {
      for (uint32_t base = 0; base < 4; ++base) {
        const double norm = std::sqrt(chorus_sine_[base] * chorus_sine_[base] + chorus_cosine_[base] * chorus_cosine_[base]);
        chorus_sine_[base] /= norm;
        chorus_cosine_[base] /= norm;
      }
      const double norm = std::sqrt(spin_sine_ * spin_sine_ + spin_cosine_ * spin_cosine_);
      spin_sine_ /= norm;
      spin_cosine_ /= norm;
    }

    // A modulated allpass read is not exactly lossless (a frozen tail drifted 0.7 dB in 30 s), so Freeze holds the lines still.
    const double depth = chorus_depth_ * chorus_gain_ * (1.0 - freeze_.current);
    const bool dynamic = depth > 0.0 || gliding_;
    if (dynamic_ && !dynamic) dirty_ = true;
    dynamic_ = dynamic;
    if (dynamic) {
      const double line_scale = 0.7 + 0.5 * size;
      for (uint32_t line = 0; line < lines_; ++line) {
        const uint32_t base = line & 3U;
        const double modulation = chorus_sine_[base] * chorus_cos_[line] + chorus_cosine_[base] * chorus_sin_[line];
        const double position = line_base_[line] * line_scale + depth * modulation - 0.5;
        const double floor_position = std::floor(position);
        line_whole_[line] = static_cast<uint32_t>(floor_position);
        const double fractional = position + 0.5 - floor_position;
        line_eta_[line] = (1.0 - fractional) / (1.0 + fractional);
      }
    }
    if (reflect_.current > 0.0 || reflect_.target > 0.0) {
      const double ms_scale = (0.4 + 0.6 * size) * 0.001 * rate_;
      for (uint32_t channel = 0; channel < 2; ++channel) {
        for (uint32_t stage = 0; stage < kReflectionStages; ++stage) {
          double delay = kReflectionStageMs[channel][stage] * ms_scale;
          if (spin_depth_ > 0.0) {
            delay *= 1.0 + spin_depth_ * (spin_sine_ * spin_cos_[channel][stage] + spin_cosine_ * spin_sin_[channel][stage]);
          }
          delay = std::max(1.0, delay);
          const double whole = std::floor(delay);
          reflection_whole_[channel][stage] = static_cast<uint32_t>(whole);
          reflection_fraction_[channel][stage] = delay - whole;
        }
      }
    }
  }

  // Takes the values and config of this frame; anything that needs more than a compare is done only when it changed.
  void apply(const ReverbValues &v, const ReverbConfig &c) {
    const double wet = std::clamp(static_cast<double>(v.wet), 0.0, 1.0);
    const double pre_delay_ms = std::clamp(static_cast<double>(v.pre_delay_ms), 0.0, kMaximumPreDelayMs);
    const double size = std::clamp(static_cast<double>(v.size), 0.0, 1.0);
    const double shape = std::clamp(static_cast<double>(v.shape), 0.0, 1.0);
    const double decay = std::max(0.05, static_cast<double>(v.decay_sec));
    const bool freeze = c.freeze;
    wet_.target = wet;
    diffuse_.target = std::clamp(static_cast<double>(v.diffuse), 0.0, 1.0);
    reflect_.target = std::clamp(static_cast<double>(v.reflections), 0.0, 1.0);
    diffusion_.target = std::clamp(static_cast<double>(v.diffusion), 0.0, 1.0);
    input_gain_.target = freeze && c.cut ? 0.0 : 1.0;
    freeze_.target = freeze ? 1.0 : 0.0;
    stereo_.target = std::clamp(static_cast<double>(v.stereo_degrees), 0.0, 120.0) / 120.0 * kPi * 0.25;
    pre_delay_.target = std::max(1.0, pre_delay_ms * 0.001 * rate_);
    onset_.target = 0.024 * shape * rate_;
    size_.target = size;
    if (!initialized_) snap();
    if (c.smooth != smooth_) {
      smooth_ = c.smooth;
      size_.step = c.smooth == 0U ? 2.0 : (c.smooth == 1U ? kSlowGlide : kFastGlide) / (0.5 * kLineFrames48k[kMaximumLines - 1] * k48_);
    }
    if (shape != shape_) {
      shape_ = shape;
      const double stage_gain = 0.9 - 0.4 * shape;
      double energy = 1.0;
      for (uint32_t stage = 0; stage < kReflectionStages; ++stage) energy *= 1.0 + stage_gain * stage_gain;
      reflection_gain_ = stage_gain;
      reflection_norm_ = kReflectionLevel * (0.65 + 0.7 * shape) / std::sqrt(energy);
    }
    // Amount is the peak-to-peak size of the delay change as a fraction of each stage's delay (at 25 ms, 2.5 % either way of it).
    spin_depth_ = c.spin ? std::clamp(static_cast<double>(v.spin_amount_ms), 0.0, 25.0) / 2000.0 : 0.0;
    if (v.spin_rate_hz != spin_rate_) {
      spin_rate_ = v.spin_rate_hz;
      const double step = 2.0 * kPi * static_cast<double>(spin_rate_) * kControlFrames / rate_;
      spin_step_cos_ = std::cos(step);
      spin_step_sin_ = std::sin(step);
    }
    chorus_depth_ = std::clamp(static_cast<double>(v.chorus_amount_ms), 0.0, kMaximumChorusMs) * 0.001 * rate_;
    chorus_gain_ = c.chorus ? 1.0 : 0.0;
    if (v.chorus_rate_hz != chorus_rate_) {
      chorus_rate_ = v.chorus_rate_hz;
      for (uint32_t base = 0; base < 4; ++base) {
        const double step = 2.0 * kPi * static_cast<double>(chorus_rate_) * kChorusRateRatio[base] * kControlFrames / rate_;
        chorus_step_cos_[base] = std::cos(step);
        chorus_step_sin_[base] = std::sin(step);
      }
    }
    if (v.low_cut_hz != low_cut_hz_) {
      low_cut_hz_ = v.low_cut_hz;
      low_cut_active_ = low_cut_hz_ > 20.0F;
      if (low_cut_active_) low_cut_ = design_biquad(true, std::min(static_cast<double>(low_cut_hz_), 0.45 * rate_));
    }
    if (v.high_cut_hz != high_cut_hz_) {
      high_cut_hz_ = v.high_cut_hz;
      high_cut_active_ = high_cut_hz_ < 20000.0F;
      if (high_cut_active_) high_cut_ = design_biquad(false, std::min(static_cast<double>(high_cut_hz_), 0.45 * rate_));
    }
    if (decay != decay_ || v.low_shelf_hz != low_shelf_hz_ || v.high_shelf_hz != high_shelf_hz_ || v.low_shelf_db != low_shelf_db_
      || v.high_shelf_db != high_shelf_db_ || c.low_shelf != low_shelf_on_ || c.high_shelf != high_shelf_on_ || c.flat != flat_) {
      decay_ = decay;
      low_shelf_hz_ = v.low_shelf_hz;
      high_shelf_hz_ = v.high_shelf_hz;
      low_shelf_db_ = v.low_shelf_db;
      high_shelf_db_ = v.high_shelf_db;
      low_shelf_on_ = c.low_shelf;
      high_shelf_on_ = c.high_shelf;
      flat_ = c.flat;
      low_active_ = low_shelf_on_ && std::fabs(static_cast<double>(low_shelf_db_)) > 0.01;
      high_active_ = high_shelf_on_ && std::fabs(static_cast<double>(high_shelf_db_)) > 0.01;
      dirty_ = true;
    }
  }

  void snap() {
    for (OnePole *smoother : {&wet_, &diffuse_, &reflect_, &diffusion_, &input_gain_, &freeze_, &stereo_}) smoother->current = smoother->target;
    pre_delay_.current = pre_delay_.target;
    onset_.current = onset_.target;
    size_.current = size_.target;
    stereo_last_ = -1.0;
    size_last_ = size_.current;
    freeze_last_ = freeze_.current;
    dirty_ = true;
    gliding_ = false;
    initialized_ = true;
  }

  Biquad design_biquad(bool highpass, double hz) const {
    const double omega = 2.0 * kPi * hz / rate_;
    const double cosine = std::cos(omega);
    const double alpha = std::sin(omega) / (2.0 * 0.7071067811865476);
    const double a0 = 1.0 + alpha;
    const double edge = highpass ? (1.0 + cosine) * 0.5 : (1.0 - cosine) * 0.5;
    return {edge / a0, (highpass ? -(1.0 + cosine) : 1.0 - cosine) / a0, edge / a0, -2.0 * cosine / a0, (1.0 - alpha) / a0};
  }

  // Per-line decay design. A line of L frames must lose A0 = 60 L / (rate T60) dB per trip at the mid band. The shelves move
  // the T60 at the band edges by their gain: a shelf of G dB makes the edge T60 10^(G/20) times the mid one, which costs the
  // line A0 (10^(-G/20) - 1) more dB per trip there. Freeze lifts the mid band to unity; Flat also lifts the shelf losses.
  void design(double size, double freeze) {
    const double scale = 0.7 + 0.5 * size;
    const double shelf_weight = 1.0 - (flat_ ? freeze : 0.0);
    // Short lines hold more energy in the tail than long ones at the same decay: a quadratic fit of the measured excess (+1.5 dB
    // at Size 0, -0.6 dB at Size 1 against Size 0.65) keeps the loudness of the tail within a dB over the whole Size range.
    size_compensation_ = std::exp(-(1.48 - 2.643 * size + 0.5626 * size * size) * 0.11512925464970229);
    const double low_tan = std::tan(kPi * std::min(static_cast<double>(low_shelf_hz_), 0.45 * rate_) / rate_);
    const double high_tan = std::tan(kPi * std::min(static_cast<double>(high_shelf_hz_), 0.45 * rate_) / rate_);
    const double low_ratio = std::pow(10.0, static_cast<double>(low_shelf_db_) / 20.0);
    const double high_ratio = std::pow(10.0, static_cast<double>(high_shelf_db_) / 20.0);
    for (uint32_t line = 0; line < lines_; ++line) {
      const double frames = line_base_[line] * scale;
      const double loss_db = 60.0 * frames / (rate_ * decay_);
      line_gain_[line] = std::pow(10.0, -loss_db * (1.0 - freeze) / 20.0);
      // A shelf boost may not lift the edge loop gain over unity, which a frozen tail with the shelves left on would otherwise do.
      const double headroom_db = loss_db * (1.0 - freeze);
      if (low_active_) {
        const double q = std::pow(10.0, std::min(loss_db * shelf_weight * (1.0 - 1.0 / low_ratio), headroom_db) / 40.0);
        const double den = 1.0 + low_tan / q;
        low_coefficient_[line] = {(1.0 + low_tan * q) / den, (low_tan * q - 1.0) / den, (low_tan / q - 1.0) / den};
      }
      if (high_active_) {
        const double q = std::pow(10.0, std::min(loss_db * shelf_weight * (1.0 - 1.0 / high_ratio), headroom_db) / 40.0);
        const double den = 1.0 + high_tan * q;
        const double gain = q * q;
        high_coefficient_[line] = {gain * (1.0 + high_tan / q) / den, gain * (high_tan / q - 1.0) / den, (high_tan * q - 1.0) / den};
      }
      const double rounded = std::round(frames);
      const double floor_position = rounded - 1.0;
      line_whole_[line] = static_cast<uint32_t>(floor_position);
      line_eta_[line] = 0.0;
    }
  }

  double rate_ = 48000.0;
  double k48_ = 1.0;
  uint32_t lines_ = 16;
  uint32_t channels_ = 16;
  uint32_t steps_ = 4;
  uint32_t frame_ = 0;
  bool initialized_ = false;
  bool dirty_ = true;
  bool gliding_ = false;
  bool dynamic_ = false;
  double size_compensation_ = 1.0;
  double feed_ = 0.5;

  std::unique_ptr<float[]> arena_;
  size_t arena_size_ = 0;
  std::array<float *, 2> input_{};
  uint32_t input_mask_ = 0;
  std::array<float *, 2> reflection_{};
  uint32_t reflection_mask_ = 0;
  std::array<double, kMaximumChannels> diffuser_tap_left_{};
  std::array<double, kMaximumChannels> diffuser_tap_right_{};
  std::array<float *, kMaximumSteps> diffuser_{};
  std::array<uint32_t, kMaximumSteps> diffuser_mask_{};
  std::array<std::array<uint32_t, kMaximumChannels>, kMaximumSteps> diffuser_delay_{};
  std::array<std::array<double, kMaximumChannels>, kMaximumSteps> diffuser_gain_{};
  double diffuser_scale_ = 0.25;
  float *lines_buffer_ = nullptr;
  uint32_t line_mask_ = 0;
  std::array<double, kMaximumLines> line_base_{};
  std::array<double, kMaximumLines> line_gain_{};
  std::array<double, kMaximumLines> line_eta_{};
  std::array<uint32_t, kMaximumLines> line_whole_{};
  std::array<double, kMaximumLines> line_allpass_{};
  std::array<double, kMaximumLines> tap_left_{};
  std::array<double, kMaximumLines> tap_right_{};
  std::array<Section, kMaximumLines> low_coefficient_{};
  std::array<Section, kMaximumLines> high_coefficient_{};
  std::array<double, kMaximumLines> low_state_{};
  std::array<double, kMaximumLines> high_state_{};
  bool low_active_ = false;
  bool high_active_ = false;
  bool low_shelf_on_ = true;
  bool high_shelf_on_ = true;
  bool flat_ = false;
  double decay_ = 0.0;
  float low_shelf_hz_ = 0.0F;
  float high_shelf_hz_ = 0.0F;
  float low_shelf_db_ = 1.0e9F;
  float high_shelf_db_ = 1.0e9F;

  std::array<double, 4> chorus_sine_{};
  std::array<double, 4> chorus_cosine_{};
  std::array<double, 4> chorus_step_sin_{};
  std::array<double, 4> chorus_step_cos_{};
  std::array<double, kMaximumLines> chorus_cos_{};
  std::array<double, kMaximumLines> chorus_sin_{};
  double chorus_depth_ = 0.0;
  double chorus_gain_ = 1.0;
  float chorus_rate_ = -1.0F;
  double spin_sine_ = 0.0;
  double spin_cosine_ = 1.0;
  double spin_step_sin_ = 0.0;
  double spin_step_cos_ = 1.0;
  float spin_rate_ = -1.0F;
  double spin_depth_ = 0.0;
  std::array<std::array<double, kReflectionStages>, 2> spin_cos_{};
  std::array<std::array<double, kReflectionStages>, 2> spin_sin_{};
  std::array<std::array<double, kReflectionStages>, 2> reflection_sign_{};
  std::array<std::array<uint32_t, kReflectionStages>, 2> reflection_whole_{};
  std::array<std::array<double, kReflectionStages>, 2> reflection_fraction_{};
  double reflection_gain_ = 0.0;
  double reflection_norm_ = 0.0;
  double shape_ = -1.0;

  OnePole wet_, diffuse_, reflect_, diffusion_, input_gain_, freeze_, stereo_;
  Glide pre_delay_, onset_, size_;
  uint32_t smooth_ = 99;
  double size_last_ = 0.0;
  double freeze_last_ = 0.0;
  double stereo_last_ = -1.0;
  double stereo_cos_ = 1.0;
  double stereo_sin_ = 0.0;

  float low_cut_hz_ = -1.0F;
  float high_cut_hz_ = -1.0F;
  bool low_cut_active_ = false;
  bool high_cut_active_ = false;
  Biquad low_cut_;
  Biquad high_cut_;
  std::array<InputFilter, 2> input_filter_{};
  std::array<double, 2> dc_in_{};
  std::array<double, 2> dc_out_{};
  double dc_coefficient_ = 0.999;
};

}  // namespace daw::audio_core
