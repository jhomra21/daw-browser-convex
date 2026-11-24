// Tests for the shared DSP blocks in src/dsp. Every case prints the number it checks against its limit.
// Run with a group name (smoother, safety, latency, delay, oversampler, adaa, filters) or with no argument for all.
#include "../src/dsp/adaa.h"
#include "../src/dsp/fractional_delay.h"
#include "../src/dsp/half_band_oversampler.h"
#include "../src/dsp/latency.h"
#include "../src/dsp/numeric_safety.h"
#include "../src/dsp/parameter_smoother.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <complex>
#include <cstring>
#include <limits>
#include <vector>

namespace dsp = daw::audio_core::dsp;

namespace {

struct Case {
  const char *group;
  const char *name;
  void (*run)();
};

int failures = 0;
const char *currentName = "";

void expectTrue(const char *what, bool ok) {
  std::printf("  [%s] %s.%s\n", ok ? "pass" : "FAIL", currentName, what);
  if (!ok) ++failures;
}

void expectAtMost(const char *what, double measured, double limit) {
  const bool ok = measured <= limit;
  std::printf("  [%s] %s.%s measured=%.6g limit<=%.6g\n", ok ? "pass" : "FAIL", currentName, what, measured, limit);
  if (!ok) ++failures;
}

void expectAtLeast(const char *what, double measured, double limit) {
  const bool ok = measured >= limit;
  std::printf("  [%s] %s.%s measured=%.6g limit>=%.6g\n", ok ? "pass" : "FAIL", currentName, what, measured, limit);
  if (!ok) ++failures;
}

void expectNear(const char *what, double measured, double expected, double tolerance) {
  const bool ok = std::fabs(measured - expected) <= tolerance;
  std::printf("  [%s] %s.%s measured=%.6g expected=%.6g tol=%.3g\n", ok ? "pass" : "FAIL", currentName, what, measured,
    expected, tolerance);
  if (!ok) ++failures;
}

// ---- smoother ---------------------------------------------------------------------------------------------------

constexpr double kRates[] = {44100.0, 48000.0, 96000.0};

void smootherLinearStep() {
  for (const double rate : kRates) {
    dsp::ParameterSmoother<> smoother;
    smoother.prepare(rate, 10.0);
    smoother.reset(0.0F);
    smoother.setTarget(1.0F);
    const int tau = static_cast<int>(std::lround(0.010 * rate));
    float value = 0.0F;
    int settledAfter = -1;
    float atOneTau = 0.0F;
    float atFiveTau = 0.0F;
    for (int i = 1; i <= tau * 20; ++i) {
      value = smoother.next();
      if (i == tau) atOneTau = value;
      if (i == tau * 5) atFiveTau = value;
      if (settledAfter < 0 && !smoother.settling()) settledAfter = i;
    }
    std::printf("  rate=%.0f settledAfter=%d samples (%.2f time constants)\n", rate, settledAfter,
      static_cast<double>(settledAfter) / tau);
    expectNear("one_tau_is_63pct", atOneTau, 1.0 - std::exp(-1.0), 2e-3);
    expectAtLeast("five_tau_above_99pct", atFiveTau, 0.99);
    expectTrue("settles_within_13_time_constants", settledAfter > 0 && settledAfter <= tau * 13);
    expectTrue("snaps_exactly_to_target", value == 1.0F);
  }
}

void smootherSettlingQuery() {
  dsp::ParameterSmoother<> smoother;
  smoother.prepare(48000.0, 5.0);
  smoother.reset(2.0F);
  expectTrue("settled_after_reset", !smoother.settling());
  smoother.setTarget(2.0F);
  expectTrue("same_target_stays_settled", !smoother.settling());
  smoother.setTarget(3.0F);
  expectTrue("new_target_is_settling", smoother.settling());
  smoother.reset(7.0F);
  expectTrue("reset_mid_flight_settles", !smoother.settling());
  expectTrue("reset_snaps_value", smoother.next() == 7.0F);
}

void smootherRetargetContinuity() {
  dsp::ParameterSmoother<> smoother;
  smoother.prepare(48000.0, 10.0);
  smoother.reset(0.0F);
  smoother.setTarget(1.0F);
  for (int i = 0; i < 200; ++i) smoother.next();
  const float before = smoother.next();
  smoother.setTarget(-1.0F);
  const float after = smoother.next();
  const double step = std::fabs(static_cast<double>(after) - before);
  const double coefficient = 1.0 - std::exp(-1000.0 / (10.0 * 48000.0));
  std::printf("  retarget step=%.6g, one-pole bound=%.6g\n", step, coefficient * 2.0);
  expectAtMost("no_jump_on_retarget", step, coefficient * 2.0 * 1.001);
}

void smootherZeroTimeAndHostileTargets() {
  dsp::ParameterSmoother<> instant;
  instant.prepare(48000.0, 0.0);
  instant.reset(0.0F);
  instant.setTarget(5.0F);
  expectTrue("zero_time_reaches_target_in_one_sample", instant.next() == 5.0F && !instant.settling());

  dsp::ParameterSmoother<> smoother;
  smoother.prepare(48000.0, 10.0);
  smoother.reset(1.0F);
  smoother.setTarget(std::numeric_limits<float>::quiet_NaN());
  smoother.setTarget(std::numeric_limits<float>::infinity());
  expectTrue("non_finite_targets_are_ignored", !smoother.settling() && smoother.next() == 1.0F);

  dsp::ParameterSmoother<dsp::SmoothDomain::Log> log;
  log.prepare(48000.0, 10.0);
  log.reset(1000.0F);
  log.setTarget(0.0F);
  float last = 0.0F;
  bool finite = true;
  for (int i = 0; i < 48000; ++i) {
    last = log.next();
    finite = finite && std::isfinite(last) && last > 0.0F;
  }
  std::printf("  log smoother driven to 0 settles at %.6g\n", static_cast<double>(last));
  expectTrue("log_target_zero_stays_positive_and_finite", finite);
}

void smootherLogDomain() {
  for (const double rate : kRates) {
    dsp::ParameterSmoother<dsp::SmoothDomain::Log> smoother;
    smoother.prepare(rate, 20.0);
    smoother.reset(100.0F);
    smoother.setTarget(10000.0F);
    const int tau = static_cast<int>(std::lround(0.020 * rate));
    float previous = 100.0F;
    float peak = 0.0F;
    bool monotonic = true;
    float atOneTau = 0.0F;
    float value = 0.0F;
    for (int i = 1; i <= tau * 20; ++i) {
      value = smoother.next();
      monotonic = monotonic && value >= previous;
      peak = std::max(peak, value);
      previous = value;
      if (i == tau) atOneTau = value;
    }
    const double fraction = std::log(atOneTau / 100.0) / std::log(100.0);
    const double overshoot = static_cast<double>(peak) / 10000.0 - 1.0;
    std::printf("  rate=%.0f one-tau value=%.4f Hz, log-domain fraction=%.5f, overshoot=%.3g\n", rate,
      static_cast<double>(atOneTau), fraction, overshoot);
    expectNear("log_fraction_at_one_tau", fraction, 1.0 - std::exp(-1.0), 1e-3);
    expectAtMost("no_overshoot", overshoot, 0.0);
    expectTrue("monotonic_rise", monotonic);
    expectTrue("settles_exactly_on_target", value == 10000.0F && !smoother.settling());
  }
  dsp::ParameterSmoother<dsp::SmoothDomain::Log> down;
  down.prepare(48000.0, 20.0);
  down.reset(10000.0F);
  down.setTarget(100.0F);
  float low = 10000.0F;
  for (int i = 0; i < 48000; ++i) low = std::min(low, down.next());
  expectAtLeast("no_undershoot_going_down", low, 100.0);
}

// ---- safety -----------------------------------------------------------------------------------------------------

void safetyFlushValues() {
  expectTrue("subnormal_float_flushes", dsp::flushDenormal(1.0e-40F) == 0.0F);
  expectTrue("subnormal_double_flushes", dsp::flushDenormal(1.0e-310) == 0.0);
  expectTrue("small_normal_survives", dsp::flushDenormal(1.0e-10F) == 1.0e-10F);
  expectTrue("negative_survives", dsp::flushDenormal(-0.25F) == -0.25F);
  expectTrue("nan_passes_through_to_the_reset_path", std::isnan(dsp::flushDenormal(std::nanf(""))));
  expectTrue("inf_passes_through_to_the_reset_path", std::isinf(dsp::flushDenormal(-INFINITY)));
}

struct DecayLoop {
  float state = 0.0F;
  float step(float input, bool flush) {
    state = state * 0.999F + input;
    if (flush) state = dsp::flushDenormal(state);
    return state;
  }
};

long countSubnormal(bool flush) {
  DecayLoop loop;
  loop.step(1.0F, flush);
  long subnormal = 0;
  for (int i = 0; i < 400000; ++i) {
    loop.step(0.0F, flush);
    if (std::fpclassify(loop.state) == FP_SUBNORMAL) ++subnormal;
  }
  return subnormal;
}

void safetyDenormalsAfterSilence() {
  const long unflushed = countSubnormal(false);
  const long flushed = countSubnormal(true);
  std::printf("  subnormal samples in 400000 silent samples: unflushed=%ld flushed=%ld\n", unflushed, flushed);
  expectAtLeast("test_loop_does_reach_subnormals_without_the_flush", static_cast<double>(unflushed), 1.0);
  expectAtMost("no_subnormal_survives_the_flush", static_cast<double>(flushed), 0.0);
}

struct OnePole {
  float state = 0.0F;
  void reset() { state = 0.0F; }
  float process(float x) {
    state = 0.5F * state + 0.5F * x;
    return state;
  }
};

void safetyNonFiniteResetsBlock() {
  OnePole unguarded;
  OnePole guarded;
  unguarded.process(std::numeric_limits<float>::quiet_NaN());
  float guardedOut = dsp::finiteOrReset(guarded, guarded.process(std::numeric_limits<float>::infinity()));
  float unguardedOut = 0.0F;
  for (int i = 0; i < 100; ++i) unguardedOut = unguarded.process(0.0F);
  expectTrue("unguarded_state_stays_nan_forever", std::isnan(unguardedOut));
  expectTrue("guard_outputs_zero_on_the_bad_sample", guardedOut == 0.0F);
  OnePole fresh;
  bool identical = true;
  for (int i = 0; i < 64; ++i) {
    const float x = std::sin(0.1F * static_cast<float>(i));
    identical = identical && dsp::finiteOrReset(guarded, guarded.process(x)) == fresh.process(x);
  }
  expectTrue("block_after_reset_matches_a_fresh_block", identical);
  OnePole healthy;
  const float y = healthy.process(0.5F);
  expectTrue("finite_samples_pass_untouched", dsp::finiteOrReset(healthy, y) == y && healthy.state == y);
}

void safetyHardwareFlushScope() {
  if (!dsp::kHasHardwareDenormalFlush) {
    std::printf("  no hardware flush on this target (wasm or unknown arch): value-based flush only\n");
    return;
  }
  volatile float tiny = std::numeric_limits<float>::denorm_min();
  volatile float one = 1.0F;
  const bool subnormalOutside = tiny * one != 0.0F;
  bool flushedInside = false;
  {
    dsp::ScopedDenormalFlush scope;
    flushedInside = tiny * one == 0.0F;
  }
  const bool restored = tiny * one != 0.0F;
  expectTrue("subnormal_arithmetic_works_outside_the_scope", subnormalOutside);
  expectTrue("scope_flushes_subnormals", flushedInside);
  expectTrue("scope_restores_the_previous_mode", restored);
}

// ---- latency ----------------------------------------------------------------------------------------------------

void latencyConversions() {
  expectTrue("zero_by_default", dsp::Latency{}.frames == 0);
  expectTrue("ms_rounds_up_so_the_compensation_never_under_reports",
    dsp::Latency::fromMilliseconds(1.0, 48000.0).frames == 48 && dsp::Latency::fromMilliseconds(1.01, 48000.0).frames == 49);
  expectTrue("ms_scales_with_the_rate", dsp::Latency::fromMilliseconds(5.0, 96000.0).frames == 480);
  expectTrue("negative_and_non_finite_ms_are_zero",
    dsp::Latency::fromMilliseconds(-3.0, 48000.0).frames == 0 &&
      dsp::Latency::fromMilliseconds(std::nan(""), 48000.0).frames == 0 &&
      dsp::Latency::fromMilliseconds(1.0, 0.0).frames == 0);
  expectTrue("oversampled_frames_round_up_to_base_frames", dsp::Latency::fromOversampled(5, 2).frames == 3);
  expectTrue("oversampled_exact_division", dsp::Latency::fromOversampled(126, 2).frames == 63);
  expectTrue("sum_adds_lookahead_and_oversampling",
    (dsp::Latency::fromFrames(64) + dsp::Latency::fromOversampled(126, 2)).frames == 127);
  expectNear("milliseconds_round_trip", dsp::Latency::fromFrames(480).milliseconds(48000.0), 10.0, 1e-9);
  expectTrue("huge_values_saturate_instead_of_wrapping",
    dsp::Latency::fromMilliseconds(1.0e12, 48000.0).frames == std::numeric_limits<uint32_t>::max());
}

// ---- fractional delay -------------------------------------------------------------------------------------------

constexpr double kPi = 3.14159265358979323846;

void delayRingWrapsAtCapacity() {
  dsp::DelayRing<float> ring;
  ring.prepare(100);
  expectTrue("capacity_is_a_power_of_two_at_least_the_request", ring.capacity() == 128);
  const uint32_t pushes = ring.capacity() * 3 + 7;
  for (uint32_t n = 0; n < pushes; ++n) ring.push(static_cast<float>(n));
  bool exact = true;
  for (uint32_t age = 0; age < ring.capacity(); ++age) exact = exact && ring.read(age) == static_cast<float>(pushes - 1 - age);
  expectTrue("every_age_below_capacity_reads_the_right_sample_after_three_wraps", exact);
  expectTrue("age_at_capacity_is_clamped_not_out_of_bounds", ring.read(ring.capacity() + 50) == ring.read(ring.capacity() - 1));
  ring.reset();
  expectTrue("reset_clears_history", ring.read(0) == 0.0F && ring.read(60) == 0.0F);
  dsp::DelayRing<float> tiny;
  tiny.prepare(0);
  expectTrue("zero_request_still_has_room_for_the_cubic_taps", tiny.capacity() >= 8);
}

double maxInterpolationError(float (*read)(const dsp::DelayRing<float> &, float), double cyclesPerSample) {
  dsp::DelayRing<float> ring;
  ring.prepare(64);
  const int newest = 400;
  for (int n = 0; n <= newest; ++n) ring.push(static_cast<float>(std::sin(2.0 * kPi * cyclesPerSample * n)));
  double worst = 0.0;
  for (double delay = 1.0; delay <= 20.0; delay += 0.05) {
    const double expected = std::sin(2.0 * kPi * cyclesPerSample * (newest - delay));
    worst = std::max(worst, std::fabs(read(ring, static_cast<float>(delay)) - expected));
  }
  return worst;
}

float readLinear(const dsp::DelayRing<float> &ring, float delay) {
  const uint32_t whole = static_cast<uint32_t>(delay);
  const float fraction = delay - static_cast<float>(whole);
  return ring.read(whole) * (1.0F - fraction) + ring.read(whole + 1) * fraction;
}
float readHermite(const dsp::DelayRing<float> &ring, float delay) { return ring.readHermite(delay); }
float readLagrange(const dsp::DelayRing<float> &ring, float delay) { return ring.readLagrange3(delay); }

void delayCubicReadAccuracy() {
  for (const double frequency : {0.02, 0.05, 0.1}) {
    const double omega = 2.0 * kPi * frequency;
    const double linear = maxInterpolationError(readLinear, frequency);
    const double hermite = maxInterpolationError(readHermite, frequency);
    const double lagrange = maxInterpolationError(readLagrange, frequency);
    std::printf("  %.2f fs sine: max error linear=%.3g hermite=%.3g lagrange3=%.3g\n", frequency, linear, hermite, lagrange);
    expectAtMost("hermite_error_bound_omega3_over_10", hermite, std::pow(omega, 3) / 10.0 + 1e-6);
    expectAtMost("lagrange_error_bound_omega4_over_24", lagrange, std::pow(omega, 4) / 24.0 * 1.05 + 1e-6);
    expectAtMost("hermite_beats_linear_by_4x", hermite, linear / 4.0);
  }
}

void delayCubicExactAtIntegerDelaysAndClamped() {
  dsp::DelayRing<float> ring;
  ring.prepare(32);
  for (int n = 0; n < 100; ++n) ring.push(static_cast<float>(std::sin(0.3 * n)));
  bool exact = true;
  for (uint32_t age = 1; age < 20; ++age) {
    exact = exact && std::fabs(ring.readHermite(static_cast<float>(age)) - ring.read(age)) < 1e-6F &&
      std::fabs(ring.readLagrange3(static_cast<float>(age)) - ring.read(age)) < 1e-6F;
  }
  expectTrue("integer_delay_returns_the_stored_sample", exact);
  const float early = ring.readHermite(0.25F);
  expectTrue("delay_below_one_frame_is_clamped_to_one", early == ring.readHermite(1.0F));
  const float late = ring.readHermite(1.0e9F);
  expectTrue("delay_beyond_capacity_is_clamped_in_bounds", std::isfinite(late));
  expectTrue("nan_delay_is_clamped", std::isfinite(ring.readHermite(std::nanf(""))) && std::isfinite(ring.readLagrange3(std::nanf(""))));
  const float top = static_cast<float>(ring.capacity() - 3);
  expectTrue("largest_delay_is_capacity_minus_three", ring.readHermite(top + 0.9F) == ring.readHermite(top));
}

// ---- oversampler -------------------------------------------------------------------------------------------------

// Steady-state gain in dB of a base-rate sine through `process`, measured by projecting the output onto the input
// frequency over a whole number of cycles. Frequency is in cycles per base-rate sample.
template <class Process>
double sineGainDb(double frequency, Process process, int settle = 400, int span = 2000) {
  const int cycles = std::max(1, static_cast<int>(std::lround(frequency * span)));
  const int length = static_cast<int>(std::lround(cycles / frequency));
  double re = 0.0;
  double im = 0.0;
  for (int n = 0; n < settle + length; ++n) {
    const double y = process(static_cast<float>(std::sin(2.0 * kPi * frequency * n)));
    if (n >= settle) {
      re += y * std::sin(2.0 * kPi * frequency * n);
      im += y * std::cos(2.0 * kPi * frequency * n);
    }
  }
  const double amplitude = 2.0 * std::hypot(re, im) / length;
  return 20.0 * std::log10(std::max(amplitude, 1e-12));
}

void oversamplerLatencyAndDc() {
  dsp::HalfBandOversampler2x os;
  const int latency = static_cast<int>(dsp::HalfBandOversampler2x::latencyFrames());
  std::vector<float> response;
  for (int n = 0; n < latency * 3; ++n) {
    const auto pair = os.up(n == 0 ? 1.0F : 0.0F);
    response.push_back(os.down(pair.first, pair.second));
  }
  int peakAt = 0;
  for (int n = 0; n < static_cast<int>(response.size()); ++n) {
    if (std::fabs(response[n]) > std::fabs(response[peakAt])) peakAt = n;
  }
  std::printf("  round-trip impulse peaks at sample %d (reported latency %d), peak value %.6f\n", peakAt, latency,
    static_cast<double>(response[peakAt]));
  expectTrue("reported_latency_is_the_impulse_peak_position", peakAt == latency);
  // The transition band (0.45 to 0.55 fs_in) is attenuated, so the impulse peak sits a little under 1.
  expectTrue("impulse_peak_is_within_two_percent_of_unity", response[peakAt] > 0.97F && response[peakAt] < 1.0F);
  expectTrue("latency_helper_agrees", dsp::HalfBandOversampler2x::latency().frames == static_cast<uint32_t>(latency));

  os.reset();
  float last = 0.0F;
  for (int n = 0; n < latency * 4; ++n) {
    const auto pair = os.up(1.0F);
    last = os.down(pair.first, pair.second);
  }
  std::printf("  DC in 1.0 -> out %.9f\n", static_cast<double>(last));
  expectNear("dc_gain_is_unity", last, 1.0, 1e-6);
}

void oversamplerPassbandAndStopband() {
  dsp::HalfBandOversampler2x os;
  double worstRipple = 0.0;
  for (double f = 0.01; f <= 0.40; f += 0.01) {
    os.reset();
    const double gain = sineGainDb(f, [&](float x) {
      const auto pair = os.up(x);
      return os.down(pair.first, pair.second);
    });
    worstRipple = std::max(worstRipple, std::fabs(gain));
  }
  std::printf("  round-trip passband to 0.40 fs_in: worst deviation %.5f dB\n", worstRipple);
  expectAtMost("passband_ripple_db_to_0.40_fs_in", worstRipple, 0.01);

  // Down filter alone: a sine at `f` of the base rate, generated at the doubled rate, must vanish above 0.55 fs_in.
  double worstStop = -300.0;
  double worstAt = 0.0;
  for (double f = 0.55; f < 1.0; f += 0.0125) {
    os.reset();
    double re = 0.0;
    double im = 0.0;
    const int settle = 400;
    const int length = 2000;
    for (int n = 0; n < settle + length; ++n) {
      const double a = std::sin(2.0 * kPi * (f / 2.0) * (2 * n));
      const double b = std::sin(2.0 * kPi * (f / 2.0) * (2 * n + 1));
      const double y = os.down(static_cast<float>(a), static_cast<float>(b));
      if (n >= settle) {
        // The decimated tone lands at 1 - f of the base rate.
        const double folded = 1.0 - f;
        re += y * std::sin(2.0 * kPi * folded * n);
        im += y * std::cos(2.0 * kPi * folded * n);
      }
    }
    const double gain = 20.0 * std::log10(std::max(2.0 * std::hypot(re, im) / length, 1e-12));
    if (gain > worstStop) {
      worstStop = gain;
      worstAt = f;
    }
  }
  std::printf("  down filter worst stopband above 0.55 fs_in: %.2f dB at %.4f fs_in\n", worstStop, worstAt);
  expectAtMost("down_filter_stopband_db_above_0.55_fs_in", worstStop, -90.0);
}

void oversamplerImageRejection() {
  dsp::HalfBandOversampler2x os;
  // A sine at f upsampled has an image at 1 - f (of the base rate). Project the doubled-rate output onto it.
  for (const double f : {0.1, 0.25, 0.4}) {
    os.reset();
    const double image = 1.0 - f;
    double reFund = 0.0, imFund = 0.0, reImg = 0.0, imImg = 0.0;
    const int settle = 400;
    const int length = 2000;
    for (int n = 0; n < settle + length; ++n) {
      const auto pair = os.up(static_cast<float>(std::sin(2.0 * kPi * f * n)));
      if (n < settle) continue;
      const double outputs[2] = {pair.first, pair.second};
      for (int phase = 0; phase < 2; ++phase) {
        const double t = (2.0 * n + phase) / 2.0;  // in base-rate sample units
        reFund += outputs[phase] * std::sin(2.0 * kPi * f * t);
        imFund += outputs[phase] * std::cos(2.0 * kPi * f * t);
        reImg += outputs[phase] * std::sin(2.0 * kPi * image * t);
        imImg += outputs[phase] * std::cos(2.0 * kPi * image * t);
      }
    }
    const double fundamental = std::hypot(reFund, imFund);
    const double imageLevel = std::hypot(reImg, imImg);
    const double rejection = 20.0 * std::log10(std::max(imageLevel, 1e-12) / fundamental);
    std::printf("  f=%.2f fs_in: image at %.2f fs_in is %.1f dB below the tone\n", f, image, rejection);
    expectAtMost("image_rejection_db", rejection, -90.0);
  }
}

void oversamplerResetAndSilence() {
  dsp::HalfBandOversampler2x fresh;
  dsp::HalfBandOversampler2x used;
  for (int n = 0; n < 500; ++n) {
    const auto pair = used.up(std::sin(0.7F * static_cast<float>(n)));
    used.down(pair.first, pair.second);
  }
  used.reset();
  bool identical = true;
  for (int n = 0; n < 300; ++n) {
    const float x = n % 17 == 0 ? 1.0F : 0.0F;
    const auto a = fresh.up(x);
    const auto b = used.up(x);
    identical = identical && a.first == b.first && a.second == b.second && fresh.down(a.first, a.second) == used.down(b.first, b.second);
  }
  expectTrue("reset_matches_a_fresh_instance_bit_for_bit", identical);
  dsp::HalfBandOversampler2x quiet;
  float peak = 0.0F;
  for (int n = 0; n < 500; ++n) {
    const auto pair = quiet.up(0.0F);
    peak = std::max(peak, std::fabs(quiet.down(pair.first, pair.second)));
  }
  expectTrue("silence_in_is_exact_silence_out", peak == 0.0F);
}

// ---- ADAA --------------------------------------------------------------------------------------------------------

template <class Shaper>
void checkAntiderivative(const char *what) {
  double worst = 0.0;
  for (double x = -6.0; x <= 6.0; x += 0.0371) {
    const double h = 1e-5;
    const double derivative = (Shaper::antiderivative(x + h) - Shaper::antiderivative(x - h)) / (2.0 * h);
    worst = std::max(worst, std::fabs(derivative - Shaper::value(x)));
  }
  std::printf("  %s: max |F' - f| = %.3g\n", what, worst);
  expectAtMost("antiderivative_matches_the_curve", worst, 1e-6);
}

void adaaAntiderivatives() {
  checkAntiderivative<dsp::TanhShaper>("tanh");
  checkAntiderivative<dsp::HardClipShaper>("hard clip");
  checkAntiderivative<dsp::SoftCubicShaper>("soft cubic");
  expectTrue("tanh_antiderivative_does_not_overflow", std::isfinite(dsp::TanhShaper::antiderivative(1.0e4)) &&
    std::fabs(dsp::TanhShaper::antiderivative(-1.0e4) - dsp::TanhShaper::antiderivative(1.0e4)) < 1e-9);
  expectNear("soft_cubic_is_continuous_at_the_knee", dsp::SoftCubicShaper::value(1.0 + 1e-9), dsp::SoftCubicShaper::value(1.0 - 1e-9), 1e-8);
}

template <class Shaper>
void checkIllConditioned(const char *what) {
  dsp::Adaa1<Shaper> adaa;
  float worstConstant = 0.0F;
  for (const float level : {0.0F, 0.3F, -0.8F, 2.5F, -7.0F}) {
    adaa.reset();
    adaa.process(level);
    for (int n = 0; n < 8; ++n) {
      worstConstant = std::max(worstConstant, std::fabs(adaa.process(level) - static_cast<float>(Shaper::value(level))));
    }
  }
  // Steps of 1e-12 .. 1e-5 around a point where the curve has non-zero slope must not spike.
  float worstTiny = 0.0F;
  for (const double step : {1e-12, 1e-10, 1e-8, 1e-7, 1e-6, 1.1e-6, 1e-5}) {
    adaa.reset();
    adaa.process(0.4F);
    const float y = adaa.process(static_cast<float>(0.4 + step));
    worstTiny = std::max(worstTiny, std::fabs(y - static_cast<float>(Shaper::value(0.4))));
  }
  std::printf("  %s: constant-input error %.3g, tiny-step error %.3g\n", what, static_cast<double>(worstConstant),
    static_cast<double>(worstTiny));
  expectAtMost("constant_input_returns_the_curve_value", worstConstant, 1e-6);
  expectAtMost("tiny_steps_do_not_divide_by_zero", worstTiny, 1e-5);
  adaa.reset();
  adaa.process(0.5F);
  const float bad = adaa.process(std::numeric_limits<float>::quiet_NaN());
  const float after = adaa.process(0.25F);
  expectTrue("nan_input_resets_and_outputs_zero", bad == 0.0F && std::isfinite(after));
}

void adaaIllConditioned() {
  checkIllConditioned<dsp::TanhShaper>("tanh");
  checkIllConditioned<dsp::HardClipShaper>("hard clip");
  checkIllConditioned<dsp::SoftCubicShaper>("soft cubic");
  dsp::Adaa1<dsp::HardClipShaper> clip;
  clip.process(0.2F);
  expectNear("hard_clip_linear_region_is_the_midpoint", clip.process(0.6F), 0.4, 1e-6);
  clip.reset();
  clip.process(3.0F);
  expectTrue("hard_clip_both_samples_over_the_rail_is_exactly_the_rail", clip.process(5.0F) == 1.0F);
}

// 426 cycles in 4096 samples: 4992 Hz at 48 kHz, coherent, so every harmonic and alias lands on a whole bin.
constexpr int kAliasLength = 4096;
constexpr int kAliasCycles = 426;
constexpr double kAliasFrequency = static_cast<double>(kAliasCycles) / kAliasLength;  // cycles per base-rate sample

std::vector<std::complex<double>> fft(const std::vector<float> &signal) {
  const int length = static_cast<int>(signal.size());
  std::vector<std::complex<double>> x(signal.begin(), signal.end());
  for (int i = 1, j = 0; i < length; ++i) {
    int bit = length >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) std::swap(x[i], x[j]);
  }
  for (int size = 2; size <= length; size <<= 1) {
    const std::complex<double> step = std::polar(1.0, -2.0 * kPi / size);
    for (int start = 0; start < length; start += size) {
      std::complex<double> w = 1.0;
      for (int k = 0; k < size / 2; ++k, w *= step) {
        const std::complex<double> even = x[start + k];
        const std::complex<double> odd = x[start + k + size / 2] * w;
        x[start + k] = even + odd;
        x[start + k + size / 2] = even - odd;
      }
    }
  }
  return x;
}

// Power in the audible band (up to 20 kHz) that is neither the tone nor one of its in-band harmonics, relative to the
// tone, in dB. Energy between 20 kHz and Nyquist is not counted: a 2x half-band's transition band lets the harmonic just
// above Nyquist fold there, and that is not shaper aliasing.
double aliasLevelDb(const std::vector<float> &signal) {
  const std::vector<std::complex<double>> spectrum = fft(signal);
  const int audibleBins = static_cast<int>(20000.0 / 48000.0 * kAliasLength);
  double alias = 0.0;
  for (int bin = 1; bin <= audibleBins; ++bin) {
    if (bin % kAliasCycles != 0) alias += std::norm(spectrum[bin]);
  }
  return 10.0 * std::log10(std::max(alias, 1e-30) / std::norm(spectrum[kAliasCycles]));
}

// Reference: the sine generated directly at 8x, shaped naively, then low-passed (cutoff 0.40 fs_in, Kaiser beta 10, 513
// taps at 8x) and decimated. Independent of the blocks under test.
std::vector<float> eightTimesReference(double (*shape)(double), double gain) {
  constexpr int ratio = 8;
  constexpr int half = 256;
  const auto bessel = [](double x) {
    double sum = 1.0, term = 1.0;
    for (int m = 1; m < 60; ++m) {
      term *= (x / 2.0 / m) * (x / 2.0 / m);
      sum += term;
    }
    return sum;
  };
  std::vector<double> taps(2 * half + 1);
  double total = 0.0;
  for (int k = -half; k <= half; ++k) {
    const double cutoff = 0.40 / ratio;
    const double sinc = k == 0 ? 2.0 * cutoff : std::sin(2.0 * kPi * cutoff * k) / (kPi * k);
    const double r = static_cast<double>(k) / half;
    taps[k + half] = sinc * bessel(10.0 * std::sqrt(1.0 - r * r)) / bessel(10.0);
    total += taps[k + half];
  }
  for (double &tap : taps) tap /= total;
  std::vector<float> out(kAliasLength);
  for (int n = 0; n < kAliasLength; ++n) {
    double y = 0.0;
    for (int k = -half; k <= half; ++k) {
      const double i = static_cast<double>(n) * ratio + k;
      y += taps[k + half] * shape(gain * std::sin(2.0 * kPi * kAliasFrequency * i / ratio));
    }
    out[n] = static_cast<float>(y);
  }
  return out;
}

template <class Shaper>
void adaaAliasFor(const char *what) {
  constexpr int warmup = 600;
  const double drive = std::pow(10.0, 18.0 / 20.0);
  const double gain = 0.5 * drive;
  std::vector<float> naive(kAliasLength), adaa1x(kAliasLength), adaa2x(kAliasLength), naive2x(kAliasLength);
  dsp::Adaa1<Shaper> single;
  dsp::Adaa1<Shaper> doubled;
  dsp::HalfBandOversampler2x os;
  dsp::HalfBandOversampler2x osNaive;
  for (int n = -warmup; n < kAliasLength; ++n) {
    const float x = static_cast<float>(gain * std::sin(2.0 * kPi * kAliasFrequency * n));
    const float a = static_cast<float>(Shaper::value(x));
    const float b = single.process(x);
    const auto up = os.up(x);
    const float c = os.down(doubled.process(up.first), doubled.process(up.second));
    const auto upNaive = osNaive.up(x);
    const float e = osNaive.down(static_cast<float>(Shaper::value(upNaive.first)), static_cast<float>(Shaper::value(upNaive.second)));
    if (n >= 0) {
      naive[n] = a;
      adaa1x[n] = b;
      adaa2x[n] = c;
      naive2x[n] = e;
    }
  }
  const double naiveDb = aliasLevelDb(naive);
  const double adaaDb = aliasLevelDb(adaa1x);
  const double adaa2xDb = aliasLevelDb(adaa2x);
  const double naive2xDb = aliasLevelDb(naive2x);
  const double referenceDb = aliasLevelDb(eightTimesReference(Shaper::value, gain));
  std::printf("  %s, 4992 Hz sine, 18 dB drive, alias to 20 kHz vs tone: naive 1x %.1f dB, ADAA 1x %.1f dB, naive 2x %.1f dB, "
    "ADAA 2x %.1f dB, 8x reference %.1f dB\n", what, naiveDb, adaaDb, naive2xDb, adaa2xDb, referenceDb);
  expectAtMost("reference_is_clean", referenceDb, -60.0);
  expectAtLeast("naive_1x_does_alias", naiveDb, -30.0);
  expectAtMost("adaa_1x_beats_naive_1x_by_8_db", adaaDb, naiveDb - 8.0);
  expectAtMost("adaa_2x_beats_naive_2x_by_15_db", adaa2xDb, naive2xDb - 15.0);
  expectAtMost("adaa_2x_beats_naive_1x_by_30_db", adaa2xDb, naiveDb - 30.0);
}

void adaaAliasTanh() { adaaAliasFor<dsp::TanhShaper>("tanh"); }
void adaaAliasHardClip() { adaaAliasFor<dsp::HardClipShaper>("hard clip"); }
void adaaAliasSoftCubic() { adaaAliasFor<dsp::SoftCubicShaper>("soft cubic"); }

constexpr Case kCases[] = {
  {"oversampler", "latency_and_dc", oversamplerLatencyAndDc},
  {"oversampler", "passband_and_stopband", oversamplerPassbandAndStopband},
  {"oversampler", "image_rejection", oversamplerImageRejection},
  {"oversampler", "reset_and_silence", oversamplerResetAndSilence},
  {"adaa", "antiderivatives", adaaAntiderivatives},
  {"adaa", "ill_conditioned_inputs", adaaIllConditioned},
  {"adaa", "alias_tanh", adaaAliasTanh},
  {"adaa", "alias_hard_clip", adaaAliasHardClip},
  {"adaa", "alias_soft_cubic", adaaAliasSoftCubic},
  {"delay", "ring_wraps_at_capacity", delayRingWrapsAtCapacity},
  {"delay", "cubic_read_accuracy", delayCubicReadAccuracy},
  {"delay", "cubic_exact_and_clamped", delayCubicExactAtIntegerDelaysAndClamped},
  {"smoother", "linear_step", smootherLinearStep},
  {"smoother", "settling_query", smootherSettlingQuery},
  {"smoother", "retarget_continuity", smootherRetargetContinuity},
  {"smoother", "zero_time_and_hostile_targets", smootherZeroTimeAndHostileTargets},
  {"smoother", "log_domain", smootherLogDomain},
  {"safety", "flush_values", safetyFlushValues},
  {"safety", "denormals_after_silence", safetyDenormalsAfterSilence},
  {"safety", "non_finite_resets_block", safetyNonFiniteResetsBlock},
  {"safety", "hardware_flush_scope", safetyHardwareFlushScope},
  {"latency", "conversions", latencyConversions},
};

}  // namespace

int main(int argc, char **argv) {
  const char *group = argc > 1 ? argv[1] : nullptr;
  int ran = 0;
  for (const Case &testCase : kCases) {
    if (group && std::strcmp(group, testCase.group) != 0) continue;
    currentName = testCase.name;
    std::printf("%s.%s\n", testCase.group, testCase.name);
    testCase.run();
    ++ran;
  }
  if (ran == 0) {
    std::printf("no test group named '%s'\n", group ? group : "");
    return 2;
  }
  std::printf("%d cases, %d failed checks\n", ran, failures);
  return failures == 0 ? 0 : 1;
}
