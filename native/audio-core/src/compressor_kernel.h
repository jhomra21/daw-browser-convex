#pragma once

// Compressor DSP kernel, independent of the audio-core graph so it can be measured on its own.
//
// Signal path per sample: key (mean of the sidechain pair) -> optional sidechain biquad -> detector (RMS with a 10 ms time
// constant, or a 5 ms peak hold with a one-pole release) -> level in dB -> gain computer (quadratic soft knee) -> envelope in
// dB (branching attack / release, log or linear, program-dependent release) -> gain on the audio delayed by exactly the
// lookahead. Threshold, ratio, knee, makeup, output and dry/wet are smoothed so a jump or an automation step never clicks.
//
// Everything runs in double and the coefficients are cached until the value they come from changes, so a steady-state
// sample costs one logarithm and one exponential. The legacy worklet (public/audio-worklets/daw-compressor-processor-v1.js)
// repeats this arithmetic operation for operation; keep them in step.
#include "dsp/biquad.h"
#include "dsp/latency.h"
#include "dsp/numeric_safety.h"
#include "dsp/parameter_smoother.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

namespace daw::audio_core {

struct CompressorValues {
  float threshold_db = -24.0F;
  float ratio = 4.0F;
  float attack_ms = 10.0F;
  float release_ms = 120.0F;
  float makeup_db = 0.0F;
  float output_db = 0.0F;
  float dry_wet = 1.0F;
  float knee_db = 6.0F;
};

struct CompressorConfig {
  float lookahead_ms = 0.0F;
  bool auto_release = false;
  bool auto_makeup = false;
  bool rms = true;
  bool expand = false;
  bool linear = false;
};

class CompressorKernel {
 public:
  static constexpr uint32_t kCapacity = 2048;
  static constexpr uint32_t kMask = kCapacity - 1;
  static constexpr double kRmsMs = 10.0;
  // The peak detector holds each peak for this long before it lets go: a 50 Hz tone's rectified peaks are 10 ms apart, and a
  // detector that sags between them modulates the gain at twice the tone's frequency, which is audible as distortion.
  static constexpr double kPeakHoldMs = 5.0;
  static constexpr double kPeakReleaseMs = 5.0;
  static constexpr double kSmoothMs = 8.0;
  // Auto release: the fast stage answers a transient, the slow stage takes over as the compression is sustained. The
  // sustain fills with kAutoBuildMs while the gain computer is working and empties at the slow stage's pace.
  static constexpr double kAutoFast = 0.25;
  static constexpr double kAutoSlow = 2.0;
  static constexpr double kAutoBuildMs = 250.0;
  static constexpr double kAutoDecayMs = 1000.0;
  static constexpr double kEngagedDb = -0.1;
  static constexpr double kRecoveredDb = -0.5;
  // Below this the signal is silence: it is the level floor, and an expander never pushes the gain further down.
  static constexpr double kFloorDb = -120.0;
  static constexpr double kDbToNeper = 0.11512925464970228420;  // ln(10) / 20
  static constexpr double kEnvelopeEpsilonDb = 1.0e-9;

  // Frames of delay for a lookahead: the audio is held back exactly this long, so it is also the latency the device reports.
  static uint32_t latency_frames(float lookahead_ms, double sample_rate) {
    return std::min(dsp::Latency::fromMilliseconds(lookahead_ms, sample_rate).frames, kCapacity - 1);
  }

  CompressorKernel() { reset(); }

  void prepare(double sample_rate) {
    rate_ = sample_rate;
    for (dsp::ParameterSmoother<> *smoother : {&threshold_, &ratio_, &knee_, &makeup_, &output_, &wet_}) smoother->prepare(sample_rate, kSmoothMs);
    rms_decay_ = std::exp(-1.0 / (kRmsMs * 0.001 * sample_rate));
    rms_gain_ = 1.0 - rms_decay_;
    peak_hold_frames_ = static_cast<uint32_t>(std::lround(kPeakHoldMs * 0.001 * sample_rate));
    peak_release_ = std::exp(-1.0 / (kPeakReleaseMs * 0.001 * sample_rate));
    auto_build_ = 1.0 - std::exp(-1.0 / (kAutoBuildMs * 0.001 * sample_rate));
    auto_decay_ = std::exp(-1.0 / (kAutoDecayMs * 0.001 * sample_rate));
    primed_ = false;
    makeup_primed_ = false;
    cached_attack_ms_ = cached_release_ms_ = -1.0F;
    curve_ = Curve{};
    reset();
  }

  void reset() {
    for (auto &line : dry_) line.fill(0.0F);
    write_ = 0;
    sidechain_.reset();
    mean_square_ = 0.0;
    peak_ = 0.0;
    peak_hold_ = 0;
    envelope_db_ = 0.0;
    sustain_ = 0.0;
    gain_db_ = 0.0;
    gain_ = 1.0;
  }

  // The caller designs the detector filter (an RBJ high-pass, low-pass or band-pass) and tells the kernel when it changes.
  void set_sidechain(bool enabled, const dsp::BiquadCoefficients &coefficients) {
    sidechain_enabled_ = enabled;
    sidechain_coefficients_ = coefficients;
  }

  // Gain reduction of the envelope in dB, at most 0.
  float gain_reduction_db() const { return static_cast<float>(envelope_db_); }

  void process(const CompressorValues &values, const CompressorConfig &config, float bypass, float input_left, float input_right,
    float sidechain_left, float sidechain_right, float &output_left, float &output_right) {
    delay_ = latency_frames(config.lookahead_ms, rate_);
    if (!primed_) {
      threshold_.reset(values.threshold_db);
      ratio_.reset(values.ratio);
      knee_.reset(values.knee_db);
      output_.reset(values.output_db);
      wet_.reset(values.dry_wet);
      primed_ = true;
    }
    threshold_.setTarget(values.threshold_db);
    ratio_.setTarget(values.ratio);
    knee_.setTarget(values.knee_db);
    output_.setTarget(values.output_db);
    wet_.setTarget(values.dry_wet);
    const float threshold = threshold_.next();
    const float ratio = std::max(ratio_.next(), 1.0F);
    const float knee = std::max(knee_.next(), 0.0F);
    const float output = output_.next();
    const float wet = wet_.next();
    if (threshold != curve_.threshold || ratio != curve_.ratio || knee != curve_.knee || config.expand != curve_.expand || config.rms != curve_.rms) {
      design_curve(threshold, ratio, knee, config.expand, config.rms);
    }
    // Auto Makeup glides in and out through the same smoother as the knob, and follows the curve as it moves.
    const float makeup_target = config.auto_makeup ? static_cast<float>(curve_.auto_makeup_db) : values.makeup_db;
    if (!makeup_primed_) {
      makeup_.reset(makeup_target);
      makeup_primed_ = true;
    }
    makeup_.setTarget(makeup_target);
    const float makeup = makeup_.next();
    if (values.attack_ms != cached_attack_ms_) {
      cached_attack_ms_ = values.attack_ms;
      attack_ = one_pole(values.attack_ms);
      attack_step_ = slew(values.attack_ms);
    }
    if (values.release_ms != cached_release_ms_) {
      cached_release_ms_ = values.release_ms;
      const double release_ms = values.release_ms;
      release_ = {one_pole(release_ms), one_pole(release_ms * kAutoFast), one_pole(release_ms * kAutoSlow)};
      release_step_ = {slew(release_ms), slew(release_ms * kAutoFast), slew(release_ms * kAutoSlow)};
    }

    const float dry_left = clean(input_left);
    const float dry_right = clean(input_right);
    double key = 0.5 * (static_cast<double>(clean(sidechain_left)) + static_cast<double>(clean(sidechain_right)));
    if (sidechain_enabled_) key = sidechain_.process(key, sidechain_coefficients_);
    const uint32_t slot = write_ & kMask;
    dry_[0][slot] = dry_left;
    dry_[1][slot] = dry_right;
    const uint32_t read = (write_ - delay_) & kMask;
    ++write_;

    mean_square_ = dsp::flushDenormal(rms_decay_ * mean_square_ + rms_gain_ * key * key);
    const double magnitude = std::fabs(key);
    if (magnitude >= peak_) {
      peak_ = magnitude;
      peak_hold_ = peak_hold_frames_;
    } else if (peak_hold_ > 0) {
      --peak_hold_;
    } else {
      peak_ = dsp::flushDenormal(magnitude + (peak_ - magnitude) * peak_release_);
    }

    // A level on the quiet side of the gain computer's edge needs no logarithm: the target is 0 dB there.
    const double level = config.rms ? mean_square_ : peak_;
    double target = 0.0;
    if (config.expand ? level < curve_.edge_level : level > curve_.edge_level) {
      target = std::max(target_db(curve_.db_scale * std::log(std::max(level, curve_.floor_level))), kFloorDb);
    }

    if (config.linear) {
      const double step = target < envelope_db_ ? attack_step_ : release_step(config.auto_release);
      envelope_db_ += std::clamp(target - envelope_db_, -step, step);
    } else {
      const double coefficient = target < envelope_db_ ? attack_ : release_coefficient(config.auto_release);
      envelope_db_ = target + coefficient * (envelope_db_ - target);
    }
    if (std::fabs(envelope_db_) < kEnvelopeEpsilonDb) envelope_db_ = 0.0;
    if (config.auto_release) {
      // The sustain holds while the gain is still coming back, so the slow stage lasts as long as the release it governs.
      if (target < kEngagedDb) sustain_ += (1.0 - sustain_) * auto_build_;
      else if (envelope_db_ > kRecoveredDb) sustain_ = dsp::flushDenormal(sustain_ * auto_decay_);
    }

    const double gain_db = envelope_db_ + static_cast<double>(makeup) + output;
    if (gain_db != gain_db_) {
      gain_db_ = gain_db;
      gain_ = std::exp(gain_db * kDbToNeper);
    }
    const double mix = 1.0 + wet * (gain_ - 1.0);
    const float wet_left = static_cast<float>(static_cast<double>(dry_[0][read]) * mix);
    const float wet_right = static_cast<float>(static_cast<double>(dry_[1][read]) * mix);
    const float left = wet_left + (dry_[0][read] - wet_left) * bypass;
    const float right = wet_right + (dry_[1][read] - wet_right) * bypass;
    if (!std::isfinite(envelope_db_) || !std::isfinite(mean_square_) || !std::isfinite(peak_) || !std::isfinite(gain_)) reset();
    output_left = dsp::finiteOrReset(*this, left);
    output_right = dsp::finiteOrReset(*this, right);
  }

 private:
  struct Curve {
    float threshold = 1.0e9F;
    float ratio = 0.0F;
    float knee = -1.0F;
    bool expand = false;
    bool rms = false;
    double slope = 0.0;
    double lower = 0.0;
    double upper = 0.0;
    double edge_level = 0.0;
    double floor_level = 0.0;
    double db_scale = 0.0;
    double auto_makeup_db = 0.0;
  };

  static float clean(float sample) { return dsp::flushDenormal(std::isfinite(sample) ? sample : 0.0F); }

  double one_pole(double milliseconds) const { return std::exp(-1.0 / std::max(1.0, rate_ * milliseconds / 1000.0)); }

  // dB per frame of the linear envelope's 60 dB / time slew.
  double slew(double milliseconds) const { return 60.0 / std::max(1.0, rate_ * milliseconds / 1000.0); }

  double release_coefficient(bool automatic) const {
    return automatic ? release_[1] + (release_[2] - release_[1]) * sustain_ : release_[0];
  }

  double release_step(bool automatic) const {
    return automatic ? release_step_[1] + (release_step_[2] - release_step_[1]) * sustain_ : release_step_[0];
  }

  // Gain change in dB for a level in dB: the static curve minus the identity.
  double target_db(double db) const {
    const double threshold = curve_.threshold;
    if (curve_.expand) {
      if (db >= threshold) return 0.0;
      if (curve_.knee <= 0.0F || db <= curve_.lower) return (db - threshold) * curve_.slope;
      const double distance = threshold - db;
      return -2.0 * curve_.slope * distance * distance / curve_.knee;
    }
    if (curve_.knee <= 0.0F) return db <= threshold ? 0.0 : (db - threshold) * curve_.slope;
    if (db <= curve_.lower) return 0.0;
    if (db >= curve_.upper) return (db - threshold) * curve_.slope;
    const double x = db - curve_.lower;
    return curve_.slope * x * x / (2.0 * curve_.knee);
  }

  void design_curve(float threshold, float ratio, float knee, bool expand, bool rms) {
    curve_.threshold = threshold;
    curve_.ratio = ratio;
    curve_.knee = knee;
    curve_.expand = expand;
    curve_.rms = rms;
    curve_.slope = expand ? ratio - 1.0 : 1.0 / ratio - 1.0;
    curve_.lower = threshold - 0.5 * knee;
    curve_.upper = threshold + 0.5 * knee;
    // The detector's level is a mean square in RMS mode and a magnitude in peak mode.
    const double per_db = rms ? 2.0 * kDbToNeper : kDbToNeper;
    curve_.db_scale = 1.0 / per_db;
    curve_.edge_level = std::exp((expand ? static_cast<double>(threshold) : curve_.lower) * per_db);
    curve_.floor_level = std::exp(kFloorDb * per_db);
    curve_.auto_makeup_db = 0.0;
    if (!expand) curve_.auto_makeup_db = -target_db(0.0);
  }

  double rate_ = 48000.0;
  dsp::ParameterSmoother<> threshold_{};
  dsp::ParameterSmoother<> ratio_{};
  dsp::ParameterSmoother<> knee_{};
  dsp::ParameterSmoother<> makeup_{};
  dsp::ParameterSmoother<> output_{};
  dsp::ParameterSmoother<> wet_{};
  bool primed_ = false;
  bool makeup_primed_ = false;
  Curve curve_{};
  std::array<std::array<float, kCapacity>, 2> dry_{};
  uint32_t write_ = 0;
  uint32_t delay_ = 0;
  bool sidechain_enabled_ = false;
  dsp::BiquadCoefficients sidechain_coefficients_{};
  dsp::Biquad<double> sidechain_{};
  double rms_decay_ = 0.0;
  double rms_gain_ = 0.0;
  double mean_square_ = 0.0;
  double peak_ = 0.0;
  double peak_release_ = 0.0;
  uint32_t peak_hold_ = 0;
  uint32_t peak_hold_frames_ = 0;
  double envelope_db_ = 0.0;
  double sustain_ = 0.0;
  double auto_build_ = 0.0;
  double auto_decay_ = 0.0;
  double attack_ = 0.0;
  double attack_step_ = 0.0;
  std::array<double, 3> release_{};
  std::array<double, 3> release_step_{};
  float cached_attack_ms_ = -1.0F;
  float cached_release_ms_ = -1.0F;
  double gain_db_ = 0.0;
  double gain_ = 1.0;
};

}  // namespace daw::audio_core
