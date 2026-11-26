#pragma once

// Saturator DSP kernel, independent of the audio-core graph so it can be measured on its own.
//
// Signal path per channel: Color pre-EQ (a low and a high shelf) -> Drive -> warp -> Color post-EQ (the inverse shelves)
// -> Post Clip -> Output -> dry/wet. Hi-Quality runs the warp at twice the rate between a minimum-phase polyphase IIR
// half-band pair, with first-order antiderivative antialiasing (ADAA) on every shaped sample; without it the curve is evaluated
// directly. The Color filters run at the base rate; Post Clip has a half-band pair of its own. The half-bands add no reported latency: the wet path
// trails the dry path by their group delay (a little under three frames at low frequencies) and the dry/wet mix does not
// compensate for it.
//
// Every curve has a slope of one at the origin and an asymptote near one, so switching curves does not change the level
// of a quiet signal and Drive 0 passes it through. Arithmetic runs in double; only the smoothers round to float, so the legacy
// worklet reproduces it.
#include "dsp/biquad.h"
#include "dsp/numeric_safety.h"
#include "dsp/parameter_smoother.h"
#include "dsp/polyphase_iir_half_band.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

namespace daw::audio_core {

enum SaturatorCurve : uint32_t { kSoft, kMedium, kHard, kClip, kAnalog, kSine, kBass, kFold, kWarp };

struct SaturatorConfig {
  uint32_t curve = kSoft;
  uint32_t post_clip = 0;  // 0 off, 1 soft, 2 hard
  bool hi_quality = true;
  bool color = false;
};

struct SaturatorValues {
  float drive_db = 6.0F;
  float output_db = 0.0F;
  float dry_wet = 1.0F;
  float color_frequency_hz = 1200.0F;
  float color_width = 0.57F;  // 0 narrow .. 1 wide: the shelves' Q falls from 2 to 0.4
  float color_low_db = 0.0F;
  float color_high_db = 0.0F;
  float bass_threshold_db = -12.0F;
  float warp_depth = 0.5F;
  float warp_period = 0.5F;
};

// The shaped curves, their antiderivatives (zero at the origin) and the knee they share.
struct SaturatorShape {
  static constexpr double kPi = 3.14159265358979323846;
  static constexpr double kLn2 = 0.69314718055994530942;
  static constexpr double kHardSlope = 1.5707963267948966;  // pi / 2: slope one at the origin, asymptote one
  static constexpr double kMediumReach = 1.5;
  static constexpr double kAnalogThreshold = 0.5;
  static constexpr double kMinimumKnee = 1.0e-4;

  double threshold = 0.25;  // Bass Shaper, linear
  double depth = 0.5;
  double period = 0.5;

  static double logcosh(double x) {
    const double a = std::fabs(x);
    return a + std::log1p(std::exp(-2.0 * a)) - kLn2;
  }

  // Linear up to t, then t + h tanh((x - t) / h), h = 1 - t: slope one, asymptote one, no corner.
  static double knee(double a, double t) {
    if (a <= t) return a;
    const double h = std::max(1.0 - t, kMinimumKnee);
    return t + h * std::tanh((a - t) / h);
  }
  static double kneeIntegral(double a, double t) {
    if (a <= t) return 0.5 * a * a;
    const double h = std::max(1.0 - t, kMinimumKnee);
    return 0.5 * t * t + t * (a - t) + h * h * logcosh((a - t) / h);
  }

  double value(uint32_t curve, double u) const {
    switch (curve) {
      case kMedium: {
        const double c = std::clamp(u, -kMediumReach, kMediumReach);
        return c - c * c * c / 6.75;
      }
      case kHard: return std::atan(kHardSlope * u) / kHardSlope;
      case kClip: return std::clamp(u, -1.0, 1.0);
      case kAnalog: return std::copysign(knee(std::fabs(u), kAnalogThreshold), u);
      case kSine: return std::sin(std::clamp(u, -0.5 * kPi, 0.5 * kPi));
      case kBass: return std::copysign(knee(std::fabs(u), threshold), u);
      case kFold: return std::sin(u);
      case kWarp: return (1.0 - depth) * std::tanh(u) + depth * period * std::sin(u / period);
      default: return std::tanh(u);
    }
  }

  double antiderivative(uint32_t curve, double u) const {
    const double a = std::fabs(u);
    switch (curve) {
      case kMedium: return a <= kMediumReach ? 0.5 * u * u - u * u * u * u / 27.0 : a - 0.5625;
      case kHard: return (u * std::atan(kHardSlope * u) - std::log1p(kHardSlope * kHardSlope * u * u) / (2.0 * kHardSlope)) / kHardSlope;
      case kClip: return a <= 1.0 ? 0.5 * u * u : a - 0.5;
      case kAnalog: return kneeIntegral(a, kAnalogThreshold);
      case kSine: return a <= 0.5 * kPi ? 1.0 - std::cos(u) : a - 0.5 * kPi + 1.0;
      case kBass: return kneeIntegral(a, threshold);
      case kFold: return 1.0 - std::cos(u);
      case kWarp: return (1.0 - depth) * logcosh(u) + depth * period * period * (1.0 - std::cos(u / period));
      default: return logcosh(u);
    }
  }
};

// y[n] = (F(x[n]) - F(x[n-1])) / (x[n] - x[n-1]); the curve at the midpoint when the inputs are closer than kMinimumStep.
// F(x[n-1]) is evaluated again when the curve's own parameters moved, so a change does not leak into the quotient.
// The quotient averages the curve over one sample of the doubled rate, a low-pass that costs 0.7 dB at 12 kHz and 2.4 dB at
// 0.45 of the base rate even where the curve is linear; kDroopCompensation, run on the base-rate result, undoes it.
class SaturatorAdaa {
 public:
  static constexpr double kMinimumStep = 1.0e-5;

  void reset() { previous_ = 0.0; previousIntegral_ = 0.0; }

  double process(const SaturatorShape &shape, uint32_t curve, double x, bool shapeMoved) {
    const double integral = shape.antiderivative(curve, x);
    if (shapeMoved) previousIntegral_ = shape.antiderivative(curve, previous_);
    const double step = x - previous_;
    const double y = std::fabs(step) < kMinimumStep ? shape.value(curve, 0.5 * (x + previous_)) : (integral - previousIntegral_) / step;
    previous_ = x;
    previousIntegral_ = integral;
    return y;
  }

 private:
  double previous_ = 0.0;
  double previousIntegral_ = 0.0;
};

// 1 / cos(pi f / (2 fs)) over 0 to 0.45 fs within 0.04 dB, as a biquad (least-squares-free minimax fit, Nelder-Mead on the
// log magnitude, scaled to unity at DC). The ADAA droop depends only on f / fs, so the coefficients hold at every sample rate.
inline constexpr dsp::BiquadCoefficients kDroopCompensation{1.1184109778187417, -0.3453123670227823, -0.1566534332029562, -0.17724601331356163, -0.2063088090934353};

class SaturatorKernel {
 public:
  static constexpr uint32_t kControlFrames = 8;
  static constexpr double kPi = 3.14159265358979323846;

  void prepare(double sample_rate) {
    rate_ = sample_rate;
    drive_.prepare(rate_, 10.0);
    output_.prepare(rate_, 10.0);
    wet_.prepare(rate_, 10.0);
    frequency_.prepare(rate_, 20.0);
    for (auto *smoother : {&width_, &low_, &high_, &threshold_, &depth_, &period_}) smoother->prepare(rate_, 20.0);
    initialized_ = false;
    reset();
  }

  void reset() {
    for (Channel &channel : channels_) channel = Channel{};
    frame_ = 0;
    designed_ = {};
    shelves_active_ = false;
  }

  // The values and config are read once per kControlFrames: the caller builds them only when this is true.
  bool control_due() const { return (frame_ & (kControlFrames - 1U)) == 0U; }

  void process(const SaturatorValues &values, const SaturatorConfig &config, float input_left, float input_right, float &output_left, float &output_right) {
    const bool tick = control_due();
    if (!initialized_) initialize(values, config);
    if (tick) apply(values, config);
    const float drive_db = drive_.next();
    if (drive_db != last_drive_db_) {
      drive_gain_ = std::pow(10.0, static_cast<double>(drive_db) / 20.0);
      last_drive_db_ = drive_db;
    }
    const float output_db = output_.next();
    if (output_db != last_output_db_) {
      output_gain_ = std::pow(10.0, static_cast<double>(output_db) / 20.0);
      last_output_db_ = output_db;
    }
    const double wet_mix = wet_.next();
    const float threshold_db = threshold_.next();
    const float depth = depth_.next();
    const float period = period_.next();
    const bool shape_moved = threshold_db != last_threshold_db_ || depth != last_depth_ || period != last_period_;
    if (shape_moved) {
      shape_.threshold = std::pow(10.0, static_cast<double>(threshold_db) / 20.0);
      shape_.depth = depth;
      shape_.period = period;
      last_threshold_db_ = threshold_db;
      last_depth_ = depth;
      last_period_ = period;
    }
    const float frequency = frequency_.next();
    const float width = width_.next();
    const float low = low_.next();
    const float high = high_.next();
    if (tick) design_shelves(frequency, width, low, high);
    const std::array<double, 2> dry{std::isfinite(input_left) ? static_cast<double>(input_left) : 0.0,
      std::isfinite(input_right) ? static_cast<double>(input_right) : 0.0};
    std::array<double, 2> result{};
    for (uint32_t c = 0; c < 2; ++c) result[c] = render_channel(channels_[c], config, dry[c], wet_mix, shape_moved);
    ++frame_;
    output_left = static_cast<float>(result[0]);
    output_right = static_cast<float>(result[1]);
  }

  // The two RBJ shelf designs of the Color curve: the pre-EQ at +gain and the post-EQ at -gain, which inverts it exactly.
  struct Shelves {
    std::array<dsp::BiquadCoefficients, 2> pre{};
    std::array<dsp::BiquadCoefficients, 2> post{};
  };

  static dsp::BiquadCoefficients shelf(bool low, double hz, double q, double gain_db, double rate) {
    const double a = std::pow(10.0, gain_db / 40.0);
    const double w = 2.0 * kPi * std::min(hz, 0.49 * rate) / rate;
    const double c = std::cos(w);
    const double beta = 2.0 * std::sqrt(a) * (std::sin(w) / (2.0 * q));
    const double sign = low ? 1.0 : -1.0;
    const double a0 = (a + 1.0) + sign * (a - 1.0) * c + beta;
    return dsp::BiquadCoefficients{
      a * ((a + 1.0) - sign * (a - 1.0) * c + beta) / a0,
      sign * 2.0 * a * ((a - 1.0) - sign * (a + 1.0) * c) / a0,
      a * ((a + 1.0) - sign * (a - 1.0) * c - beta) / a0,
      -sign * 2.0 * ((a - 1.0) + sign * (a + 1.0) * c) / a0,
      ((a + 1.0) + sign * (a - 1.0) * c - beta) / a0};
  }

  static double color_q(double width) { return 2.0 * std::pow(0.2, std::clamp(width, 0.0, 1.0)); }

 private:
  struct Channel {
    std::array<dsp::Biquad<double>, 2> pre{};
    std::array<dsp::Biquad<double>, 2> post{};
    dsp::PolyphaseIirHalfBand2x oversampler;
    dsp::PolyphaseIirHalfBand2x clip_oversampler;
    dsp::Biquad<double> droop;
    dsp::Biquad<double> clip_droop;
    SaturatorAdaa shaper;
    SaturatorAdaa clip;
  };

  void initialize(const SaturatorValues &values, const SaturatorConfig &config) {
    drive_.reset(values.drive_db);
    output_.reset(values.output_db);
    wet_.reset(values.dry_wet);
    frequency_.reset(values.color_frequency_hz);
    width_.reset(values.color_width);
    low_.reset(config.color ? values.color_low_db : 0.0F);
    high_.reset(config.color ? values.color_high_db : 0.0F);
    threshold_.reset(values.bass_threshold_db);
    depth_.reset(values.warp_depth);
    period_.reset(values.warp_period);
    applied_ = config;
    initialized_ = true;
  }

  void apply(const SaturatorValues &values, const SaturatorConfig &config) {
    if (config.hi_quality != applied_.hi_quality || config.curve != applied_.curve || config.post_clip != applied_.post_clip) {
      for (Channel &channel : channels_) {
        channel.oversampler.reset();
        channel.clip_oversampler.reset();
        channel.shaper.reset();
        channel.clip.reset();
      }
    }
    applied_ = config;
    drive_.setTarget(values.drive_db);
    output_.setTarget(values.output_db);
    wet_.setTarget(values.dry_wet);
    frequency_.setTarget(values.color_frequency_hz);
    width_.setTarget(values.color_width);
    low_.setTarget(config.color ? values.color_low_db : 0.0F);
    high_.setTarget(config.color ? values.color_high_db : 0.0F);
    threshold_.setTarget(values.bass_threshold_db);
    depth_.setTarget(values.warp_depth);
    period_.setTarget(values.warp_period);
  }

  // Redesigned only when a Color value moved; both shelves are skipped while the curve is flat and settled.
  void design_shelves(float frequency, float width, float low, float high) {
    const std::array<float, 4> now{frequency, width, low, high};
    shelves_active_ = low != 0.0F || high != 0.0F || low_.settling() || high_.settling();
    if (!shelves_active_) {
      for (Channel &channel : channels_) for (auto &section : channel.pre) section.reset();
      for (Channel &channel : channels_) for (auto &section : channel.post) section.reset();
      designed_ = {};
      return;
    }
    if (now == designed_) return;
    designed_ = now;
    const double q = color_q(width);
    shelves_.pre = {shelf(true, frequency, q, low, rate_), shelf(false, frequency, q, high, rate_)};
    shelves_.post = {shelf(true, frequency, q, -static_cast<double>(low), rate_), shelf(false, frequency, q, -static_cast<double>(high), rate_)};
  }

  double clip_sample(Channel &channel, const SaturatorConfig &config, bool hi_quality, double x) const {
    const uint32_t curve = config.post_clip == 1 ? kAnalog : kClip;
    if (!hi_quality) return shape_.value(curve, x);
    const dsp::PolyphaseIirHalfBand2x::Pair pair = channel.clip_oversampler.up(x);
    const double first = channel.clip.process(shape_, curve, pair.first, false);
    const double second = channel.clip.process(shape_, curve, pair.second, false);
    // The compensation and the half-band overshoot a clipped peak; Post Clip's job is to bound it, so the last word is a clamp.
    return std::clamp(channel.clip_droop.process(channel.clip_oversampler.down(first, second), kDroopCompensation), -1.0, 1.0);
  }

  double render_channel(Channel &channel, const SaturatorConfig &config, double dry, double wet_mix, bool shape_moved) {
    double x = dry;
    if (shelves_active_) {
      x = channel.pre[0].process(x, shelves_.pre[0]);
      x = channel.pre[1].process(x, shelves_.pre[1]);
    }
    const double u = x * drive_gain_;
    double wet = 0.0;
    if (config.hi_quality) {
      const dsp::PolyphaseIirHalfBand2x::Pair pair = channel.oversampler.up(u);
      const double first = channel.shaper.process(shape_, config.curve, pair.first, shape_moved);
      const double second = channel.shaper.process(shape_, config.curve, pair.second, false);
      wet = channel.droop.process(channel.oversampler.down(first, second), kDroopCompensation);
    } else {
      wet = shape_.value(config.curve, u);
    }
    if (shelves_active_) {
      wet = channel.post[1].process(wet, shelves_.post[1]);
      wet = channel.post[0].process(wet, shelves_.post[0]);
    }
    if (config.post_clip != 0) wet = clip_sample(channel, config, config.hi_quality, wet);
    wet *= output_gain_;
    if (!std::isfinite(wet)) {
      channel = Channel{};
      wet = 0.0;
    }
    return dsp::flushDenormal(dry + (wet - dry) * wet_mix);
  }

  double rate_ = 48000.0;
  bool initialized_ = false;
  SaturatorConfig applied_{};
  std::array<Channel, 2> channels_{};
  dsp::ParameterSmoother<> drive_, output_, wet_, width_, low_, high_, threshold_, depth_, period_;
  dsp::ParameterSmoother<dsp::SmoothDomain::Log> frequency_;
  SaturatorShape shape_{};
  Shelves shelves_{};
  std::array<float, 4> designed_{};
  bool shelves_active_ = false;
  double drive_gain_ = 1.0;
  double output_gain_ = 1.0;
  float last_drive_db_ = -1000.0F;
  float last_output_db_ = -1000.0F;
  float last_threshold_db_ = 1000.0F;
  float last_depth_ = -1.0F;
  float last_period_ = -1.0F;
  uint32_t frame_ = 0;
};

}  // namespace daw::audio_core
