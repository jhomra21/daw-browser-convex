// Tests for the shared DSP blocks in src/dsp. Every case prints the number it checks against its limit.
// Run with a group name (smoother, safety, latency, delay, oversampler, adaa, filters) or with no argument for all.
// "bench" prints the cost per sample of each block; it is only meaningful in an optimised build.
#include "../src/dsp/adaa.h"
#include "../src/dsp/biquad.h"
#include "../src/dsp/fractional_delay.h"
#include "../src/dsp/half_band_oversampler.h"
#include "../src/dsp/polyphase_iir_half_band.h"
#include "../src/dsp/latency.h"
#include "../src/dsp/numeric_safety.h"
#include "../src/dsp/parameter_smoother.h"
#include "../src/dsp/svf.h"

#include <algorithm>
#include <chrono>
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

// Out of line so the compiler cannot schedule the multiply across the scope's control-register write.
[[gnu::noinline]] float multiplyOpaque(float a, float b) {
  volatile float x = a;
  volatile float y = b;
  return x * y;
}

void safetyHardwareFlushScope() {
  if (!dsp::kHasHardwareDenormalFlush) {
    std::printf("  no hardware flush on this target (wasm or unknown arch): value-based flush only\n");
    return;
  }
  const float tiny = std::numeric_limits<float>::denorm_min();
  const bool subnormalOutside = multiplyOpaque(tiny, 1.0F) != 0.0F;
  bool flushedInside = false;
  {
    dsp::ScopedDenormalFlush scope;
    flushedInside = multiplyOpaque(tiny, 1.0F) == 0.0F;
  }
  const bool restored = multiplyOpaque(tiny, 1.0F) != 0.0F;
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

// ---- polyphase IIR half-band (low-latency alternative to the linear-phase FIR above) -------------------------------

// Group delay of the up + down round trip at a low frequency, in base-rate frames, from the phase of a steady sine.
double iirRoundTripGroupDelay(dsp::PolyphaseIirHalfBand2x &os, double frequency) {
  const auto phaseAt = [&](double f) {
    os.reset();
    double re = 0.0;
    double im = 0.0;
    for (int n = 0; n < 4000; ++n) {
      const auto pair = os.up(std::sin(2.0 * kPi * f * n));
      const double y = os.down(pair.first, pair.second);
      if (n >= 2000) {
        re += y * std::cos(2.0 * kPi * f * n);
        im += y * std::sin(2.0 * kPi * f * n);
      }
    }
    return std::atan2(-im, re);
  };
  const double step = frequency * 0.05;
  return -(phaseAt(frequency + step) - phaseAt(frequency - step)) / (2.0 * kPi * 2.0 * step);
}

void iirLatencyAndDc() {
  dsp::PolyphaseIirHalfBand2x os;
  const double delay = iirRoundTripGroupDelay(os, 0.01);
  std::printf("  round-trip group delay at 0.01 fs_in: %.3f base frames (reported %u, FIR %u)\n", delay,
    dsp::PolyphaseIirHalfBand2x::latencyFrames(), dsp::HalfBandOversampler2x::latencyFrames());
  expectTrue("reported_latency_is_the_low_frequency_group_delay_rounded_up",
    static_cast<double>(dsp::PolyphaseIirHalfBand2x::latencyFrames()) >= delay
      && static_cast<double>(dsp::PolyphaseIirHalfBand2x::latencyFrames()) < delay + 1.0);
  expectTrue("latency_is_far_below_the_fir", dsp::PolyphaseIirHalfBand2x::latencyFrames() * 10 < dsp::HalfBandOversampler2x::latencyFrames());
  expectTrue("latency_helper_agrees",
    dsp::PolyphaseIirHalfBand2x::latency().frames == dsp::PolyphaseIirHalfBand2x::latencyFrames());
  os.reset();
  double last = 0.0;
  for (int n = 0; n < 400; ++n) {
    const auto pair = os.up(1.0);
    last = os.down(pair.first, pair.second);
  }
  expectNear("dc_gain_is_unity", last, 1.0, 1e-6);
}

void iirPassbandAndStopband() {
  dsp::PolyphaseIirHalfBand2x os;
  double worstRipple = 0.0;
  for (double f = 0.01; f <= 0.45; f += 0.01) {
    os.reset();
    const double gain = sineGainDb(f, [&](float x) {
      const auto pair = os.up(x);
      return static_cast<float>(os.down(pair.first, pair.second));
    });
    worstRipple = std::max(worstRipple, std::fabs(gain));
  }
  std::printf("  round-trip passband to 0.45 fs_in: worst deviation %.5f dB\n", worstRipple);
  expectAtMost("passband_ripple_db_to_0.45_fs_in", worstRipple, 0.01);

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
      const double y = os.down(a, b);
      if (n >= settle) {
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
  std::printf("  IIR down filter worst stopband above 0.55 fs_in: %.2f dB at %.4f fs_in\n", worstStop, worstAt);
  expectAtMost("down_filter_stopband_db_above_0.55_fs_in", worstStop, -60.0);
}

void iirImageRejection() {
  dsp::PolyphaseIirHalfBand2x os;
  for (const double f : {0.1, 0.25, 0.4}) {
    os.reset();
    const double image = 1.0 - f;
    double reFund = 0.0, imFund = 0.0, reImg = 0.0, imImg = 0.0;
    const int settle = 400;
    const int length = 2000;
    for (int n = 0; n < settle + length; ++n) {
      const auto pair = os.up(std::sin(2.0 * kPi * f * n));
      if (n < settle) continue;
      const double outputs[2] = {pair.first, pair.second};
      for (int phase = 0; phase < 2; ++phase) {
        const double t = (2.0 * n + phase) / 2.0;
        reFund += outputs[phase] * std::sin(2.0 * kPi * f * t);
        imFund += outputs[phase] * std::cos(2.0 * kPi * f * t);
        reImg += outputs[phase] * std::sin(2.0 * kPi * image * t);
        imImg += outputs[phase] * std::cos(2.0 * kPi * image * t);
      }
    }
    const double rejection = 20.0 * std::log10(std::max(std::hypot(reImg, imImg), 1e-12) / std::hypot(reFund, imFund));
    std::printf("  f=%.2f fs_in: IIR image at %.2f fs_in is %.1f dB below the tone\n", f, image, rejection);
    expectAtMost("image_rejection_db", rejection, -60.0);
  }
}

void iirResetAndSafety() {
  dsp::PolyphaseIirHalfBand2x fresh;
  dsp::PolyphaseIirHalfBand2x used;
  for (int n = 0; n < 500; ++n) {
    const auto pair = used.up(std::sin(0.7 * n));
    used.down(pair.first, pair.second);
  }
  used.reset();
  bool identical = true;
  for (int n = 0; n < 300; ++n) {
    const double x = n % 17 == 0 ? 1.0 : 0.0;
    const auto a = fresh.up(x);
    const auto b = used.up(x);
    identical = identical && a.first == b.first && a.second == b.second && fresh.down(a.first, a.second) == used.down(b.first, b.second);
  }
  expectTrue("reset_matches_a_fresh_instance_bit_for_bit", identical);

  // A loud burst then silence: the recursive state must decay below float range without ever entering the double
  // subnormal range, where arithmetic slows down.
  dsp::PolyphaseIirHalfBand2x tail;
  for (int n = 0; n < 200; ++n) {
    const auto pair = tail.up(n < 100 ? std::sin(0.3 * n) : 0.0);
    tail.down(pair.first, pair.second);
  }
  double smallest = 1.0;
  double last = 1.0;
  for (int n = 0; n < 200000; ++n) {
    const auto pair = tail.up(0.0);
    last = tail.down(pair.first, pair.second);
    if (last != 0.0) smallest = std::min(smallest, std::fabs(last));
  }
  std::printf("  smallest nonzero output in the tail %.3g, last %.3g\n", smallest, last);
  expectTrue("tail_decays_below_float_range_without_subnormals", std::fabs(last) < 1.0e-30 && smallest >= 1.0e-300);

  // One NaN must not live on in the recursive state.
  dsp::PolyphaseIirHalfBand2x poisoned;
  const auto bad = poisoned.up(std::numeric_limits<double>::quiet_NaN());
  poisoned.down(bad.first, bad.second);
  bool finite = true;
  for (int n = 0; n < 50; ++n) {
    const auto pair = poisoned.up(0.5);
    finite = finite && std::isfinite(poisoned.down(pair.first, pair.second));
  }
  expectTrue("a_nan_input_does_not_poison_later_output", finite);
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

// ---- filters -----------------------------------------------------------------------------------------------------

enum class Kind { Bell, LowShelf, HighShelf, LowPass, HighPass };

// Analog prototypes (RBJ cookbook forms, s normalised to the corner so x = Omega / Omega0). a = 10^(dB/40).
double analogDb(Kind kind, double x, double q, double gainDb) {
  const double a = std::pow(10.0, gainDb / 40.0);
  const double base = 1.0 - x * x;
  using C = std::complex<double>;
  switch (kind) {
    case Kind::Bell: return 20.0 * std::log10(std::abs(C(base, x * a / q)) / std::abs(C(base, x / (a * q))));
    case Kind::LowShelf:
      return 20.0 * std::log10(a * std::abs(C(a - x * x, x * std::sqrt(a) / q)) / std::abs(C(1.0 - a * x * x, x * std::sqrt(a) / q)));
    case Kind::HighShelf:
      return 20.0 * std::log10(a * std::abs(C(1.0 - a * x * x, x * std::sqrt(a) / q)) / std::abs(C(a - x * x, x * std::sqrt(a) / q)));
    case Kind::LowPass: return -20.0 * std::log10(std::abs(C(base, x / q)));
    case Kind::HighPass: return 20.0 * std::log10(x * x / std::abs(C(base, x / q)));
  }
  return 0.0;
}

double digitalDb(const dsp::BiquadCoefficients &c, double omega) {
  using C = std::complex<double>;
  const C z1 = std::polar(1.0, -omega);
  const C z2 = z1 * z1;
  return 20.0 * std::log10(std::abs(c.b0 + c.b1 * z1 + c.b2 * z2) / std::abs(1.0 + c.a1 * z1 + c.a2 * z2));
}

// RBJ cookbook designs, kept here to show what the matched designs improve on.
dsp::BiquadCoefficients rbj(Kind kind, double frequency, double rate, double q, double gainDb) {
  const double w0 = 2.0 * kPi * frequency / rate;
  const double c = std::cos(w0);
  const double alpha = std::sin(w0) / (2.0 * q);
  const double a = std::pow(10.0, gainDb / 40.0);
  const double r = 2.0 * std::sqrt(a) * alpha;
  double b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
  switch (kind) {
    case Kind::Bell: b0 = 1 + alpha * a; b1 = -2 * c; b2 = 1 - alpha * a; a0 = 1 + alpha / a; a1 = -2 * c; a2 = 1 - alpha / a; break;
    case Kind::LowPass: b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; break;
    case Kind::HighPass: b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; break;
    case Kind::LowShelf:
      b0 = a * ((a + 1) - (a - 1) * c + r); b1 = 2 * a * ((a - 1) - (a + 1) * c); b2 = a * ((a + 1) - (a - 1) * c - r);
      a0 = (a + 1) + (a - 1) * c + r; a1 = -2 * ((a - 1) + (a + 1) * c); a2 = (a + 1) + (a - 1) * c - r; break;
    case Kind::HighShelf:
      b0 = a * ((a + 1) + (a - 1) * c + r); b1 = -2 * a * ((a - 1) + (a + 1) * c); b2 = a * ((a + 1) + (a - 1) * c - r);
      a0 = (a + 1) - (a - 1) * c + r; a1 = 2 * ((a - 1) - (a + 1) * c); a2 = (a + 1) - (a - 1) * c - r; break;
  }
  return dsp::BiquadCoefficients{b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0};
}

dsp::BiquadCoefficients matched(Kind kind, double frequency, double rate, double q, double gainDb) {
  switch (kind) {
    case Kind::Bell: return dsp::designMatchedBell(frequency, rate, q, gainDb);
    case Kind::LowShelf: return dsp::designMatchedLowShelf(frequency, rate, q, gainDb);
    case Kind::HighShelf: return dsp::designMatchedHighShelf(frequency, rate, q, gainDb);
    case Kind::LowPass: return dsp::designMatchedLowPass(frequency, rate, q);
    case Kind::HighPass: return dsp::designMatchedHighPass(frequency, rate, q);
  }
  return {};
}

// Largest |digital - analog| in dB over 20 Hz .. 0.45 fs (log spaced), where the prototype is above -60 dB (below that
// impulse-invariant poles alias their own tail and no biquad numerator matters).
double maxErrorDb(const dsp::BiquadCoefficients &c, Kind kind, double frequency, double rate, double q, double gainDb) {
  double worst = 0.0;
  const double top = 0.45 * rate;
  for (int i = 0; i <= 240; ++i) {
    const double f = 20.0 * std::pow(top / 20.0, i / 240.0);
    const double omega = 2.0 * kPi * f / rate;
    const double analog = analogDb(kind, f / frequency, q, gainDb);
    if (analog > -60.0) worst = std::max(worst, std::fabs(digitalDb(c, omega) - analog));
  }
  return worst;
}

void filtersAnchorsFromResearch() {
  // eq-filters.md section 1.2 (48 kHz): bell 12 kHz, +12 dB, Q=1 is +1.15 dB at 20 kHz digital (RBJ), +5.66 dB analog;
  // low-pass 16 kHz Q=0.707 is -13.5 dB at 20 kHz digital, -5.4 dB analog.
  const double omega20k = 2.0 * kPi * 20000.0 / 48000.0;
  const dsp::BiquadCoefficients rbjBell = rbj(Kind::Bell, 12000, 48000, 1.0, 12.0);
  const dsp::BiquadCoefficients matchedBell = matched(Kind::Bell, 12000, 48000, 1.0, 12.0);
  const double analogBell = analogDb(Kind::Bell, 20000.0 / 12000.0, 1.0, 12.0);
  std::printf("  bell 12k +12 dB Q1 at 20 kHz: analog %.2f, RBJ %.2f, matched %.2f dB\n", analogBell, digitalDb(rbjBell, omega20k),
    digitalDb(matchedBell, omega20k));
  expectNear("analog_prototype_matches_the_research_number", analogBell, 5.66, 0.02);
  expectNear("rbj_reproduces_the_research_cramping", digitalDb(rbjBell, omega20k), 1.15, 0.05);
  expectAtMost("matched_bell_within_0.6_db_at_20k", std::fabs(digitalDb(matchedBell, omega20k) - analogBell), 0.6);
  const dsp::BiquadCoefficients rbjLp = rbj(Kind::LowPass, 16000, 48000, 0.7071, 0.0);
  const dsp::BiquadCoefficients matchedLp = matched(Kind::LowPass, 16000, 48000, 0.7071, 0.0);
  const double analogLp = analogDb(Kind::LowPass, 20000.0 / 16000.0, 0.7071, 0.0);
  std::printf("  low-pass 16k Q0.707 at 20 kHz: analog %.2f, RBJ %.2f, matched %.2f dB\n", analogLp, digitalDb(rbjLp, omega20k),
    digitalDb(matchedLp, omega20k));
  expectNear("analog_lowpass_matches_the_research_number", analogLp, -5.4, 0.05);
  expectNear("rbj_lowpass_reproduces_the_research_number", digitalDb(rbjLp, omega20k), -13.5, 0.1);
  expectAtMost("matched_lowpass_within_one_db_at_20k", std::fabs(digitalDb(matchedLp, omega20k) - analogLp), 1.0);
  // 44.1 kHz: a band at 18 kHz is within 1 dB of analog up to 21 kHz (eq-filters.md E3 acceptance).
  const dsp::BiquadCoefficients nearNyquist = matched(Kind::Bell, 18000, 44100, 1.0, 12.0);
  double worst = 0.0;
  for (double f = 1000.0; f <= 21000.0; f += 250.0) {
    worst = std::max(worst, std::fabs(digitalDb(nearNyquist, 2.0 * kPi * f / 44100.0) - analogDb(Kind::Bell, f / 18000.0, 1.0, 12.0)));
  }
  const dsp::BiquadCoefficients rbjNear = rbj(Kind::Bell, 18000, 44100, 1.0, 12.0);
  double worstRbj = 0.0;
  for (double f = 1000.0; f <= 21000.0; f += 250.0) {
    worstRbj = std::max(worstRbj, std::fabs(digitalDb(rbjNear, 2.0 * kPi * f / 44100.0) - analogDb(Kind::Bell, f / 18000.0, 1.0, 12.0)));
  }
  std::printf("  44.1 kHz bell 18k +12 dB Q1, worst error to 21 kHz: RBJ %.2f dB, matched %.2f dB\n", worstRbj, worst);
  expectAtMost("near_nyquist_bell_within_1_db_to_21k_at_44k1", worst, 1.0);
}

struct Lcg {
  uint64_t state = 0x9E3779B97F4A7C15ULL;
  double next() {
    state = state * 6364136223846793005ULL + 1442695040888963407ULL;
    return static_cast<double>(state >> 11) / 9007199254740992.0;
  }
  double between(double lo, double hi) { return lo + (hi - lo) * next(); }
  double logBetween(double lo, double hi) { return lo * std::pow(hi / lo, next()); }
};

// 500 random bands per rate. The matched designs are regression-gated by corner-frequency region: Vicanek's fits do
// not constrain Nyquist, so error grows with the corner, and the numbers below are the bounds this code achieves.
struct BandLimits {
  double qLow, qHigh, gainRange;
  double belowTenthFs;    // corner below 0.1 fs
  double belowQuarterFs;  // corner below 0.25 fs
  double allCorners;      // corner up to 0.45 fs
};

void runRandomBands(Kind kind, const char *name, const BandLimits &limits) {
  for (const double rate : {44100.0, 48000.0, 96000.0}) {
    Lcg rng;
    double worstMatched[3] = {0.0, 0.0, 0.0};  // corner below 0.1 fs, below 0.25 fs, up to 0.45 fs
    double worstRbj[3] = {0.0, 0.0, 0.0};
    for (int i = 0; i < 500; ++i) {
      const double frequency = rng.logBetween(20.0, 0.45 * rate);
      const double q = rng.logBetween(limits.qLow, limits.qHigh);
      const double gain = rng.between(-limits.gainRange, limits.gainRange);
      const double matchedError = maxErrorDb(matched(kind, frequency, rate, q, gain), kind, frequency, rate, q, gain);
      const double rbjError = maxErrorDb(rbj(kind, frequency, rate, q, gain), kind, frequency, rate, q, gain);
      const int region = frequency < 0.1 * rate ? 0 : frequency < 0.25 * rate ? 1 : 2;
      for (int r = region; r < 3; ++r) {
        worstMatched[r] = std::max(worstMatched[r], matchedError);
        worstRbj[r] = std::max(worstRbj[r], rbjError);
      }
    }
    std::printf("  %s Q %.1f..%.0f +-%.0f dB, %.0f Hz, worst error by corner <0.1fs / <0.25fs / <=0.45fs: matched %.2f / %.2f / %.2f dB, RBJ %.2f / %.2f / %.2f dB\n",
      name, limits.qLow, limits.qHigh, limits.gainRange, rate, worstMatched[0], worstMatched[1], worstMatched[2], worstRbj[0], worstRbj[1], worstRbj[2]);
    expectAtMost("matched_error_db_corner_below_0.1_fs", worstMatched[0], limits.belowTenthFs);
    expectAtMost("matched_error_db_corner_below_0.25_fs", worstMatched[1], limits.belowQuarterFs);
    expectAtMost("matched_error_db_all_corners", worstMatched[2], limits.allCorners);
    expectAtMost("matched_beats_rbj_below_0.25_fs", worstMatched[1], worstRbj[1]);
  }
}

void filtersRandomBells() {
  runRandomBands(Kind::Bell, "bell", {0.5, 4.0, 15.0, 1.2, 1.7, 2.2});
  runRandomBands(Kind::Bell, "bell", {0.2, 18.0, 24.0, 3.0, 3.0, 3.5});
}
void filtersRandomLowShelves() { runRandomBands(Kind::LowShelf, "low shelf", {0.5, 2.0, 15.0, 1.7, 2.8, 99.0}); }
void filtersRandomHighShelves() { runRandomBands(Kind::HighShelf, "high shelf", {0.5, 2.0, 15.0, 1.0, 2.0, 99.0}); }
void filtersRandomLowPass() { runRandomBands(Kind::LowPass, "low-pass", {0.5, 4.0, 0.0, 99.0, 99.0, 99.0}); }
void filtersRandomHighPass() { runRandomBands(Kind::HighPass, "high-pass", {0.5, 4.0, 0.0, 0.2, 1.1, 3.6}); }

// Resonant shelves, low-pass and high-pass at the full Q range: reported, not gated. No biquad follows a Q=18 shelf
// notch near Nyquist, and RBJ is as bad.
void filtersWideQReport() {
  for (const Kind kind : {Kind::LowShelf, Kind::HighShelf, Kind::LowPass, Kind::HighPass}) {
    Lcg rng;
    double worstMatched = 0.0;
    double worstRbj = 0.0;
    for (int i = 0; i < 500; ++i) {
      const double frequency = rng.logBetween(20.0, 0.45 * 48000.0);
      const double q = rng.logBetween(0.2, 18.0);
      const double gain = rng.between(-24.0, 24.0);
      worstMatched = std::max(worstMatched, maxErrorDb(matched(kind, frequency, 48000.0, q, gain), kind, frequency, 48000.0, q, gain));
      worstRbj = std::max(worstRbj, maxErrorDb(rbj(kind, frequency, 48000.0, q, gain), kind, frequency, 48000.0, q, gain));
    }
    const char *const names[] = {"bell", "low shelf", "high shelf", "low-pass", "high-pass"};
    std::printf("  %s, Q 0.2..18 +-24 dB, 48 kHz, all corners: worst error matched %.2f dB, RBJ %.2f dB\n", names[static_cast<int>(kind)], worstMatched, worstRbj);
  }
}

void filtersCoefficientStability() {
  int unstable = 0;
  int nonFinite = 0;
  int designs = 0;
  for (const Kind kind : {Kind::Bell, Kind::LowShelf, Kind::HighShelf, Kind::LowPass, Kind::HighPass}) {
    for (const double rate : {44100.0, 96000.0}) {
      for (const double frequency : {1.0, 20.0, 100.0, 1000.0, 10000.0, 0.45 * rate, 0.49 * rate, 0.499 * rate, 0.9 * rate}) {
        for (const double q : {0.05, 0.2, 0.7071, 4.0, 18.0, 100.0}) {
          for (const double gain : {-24.0, -6.0, 0.0, 6.0, 24.0}) {
            const dsp::BiquadCoefficients c = matched(kind, frequency, rate, q, gain);
            ++designs;
            const bool finite = std::isfinite(c.b0) && std::isfinite(c.b1) && std::isfinite(c.b2) && std::isfinite(c.a1) && std::isfinite(c.a2);
            if (!finite) ++nonFinite;
            else if (!(std::fabs(c.a2) < 1.0 && std::fabs(c.a1) < 1.0 + c.a2)) ++unstable;
          }
        }
      }
    }
  }
  std::printf("  %d extreme designs: %d non-finite, %d with poles outside the unit circle\n", designs, nonFinite, unstable);
  expectTrue("every_extreme_design_is_finite", nonFinite == 0);
  expectTrue("every_extreme_design_is_stable", unstable == 0);
}

// Frequency response of the SVF as actually processed: impulse response, then a direct DFT at the probe frequency.
double svfDb(dsp::SvfMode mode, double frequency, double rate, double q, double gainDb, double probe) {
  dsp::Svf<double> svf;
  const dsp::SvfCoefficients c = dsp::designSvf(mode, frequency, rate, q, gainDb);
  const int length = 1 << 15;
  std::complex<double> sum = 0.0;
  for (int n = 0; n < length; ++n) {
    const double y = svf.process(n == 0 ? 1.0 : 0.0, c);
    sum += y * std::polar(1.0, -2.0 * kPi * probe / rate * n);
  }
  return 20.0 * std::log10(std::abs(sum));
}

// The SVF is a bilinear design: its response is the analog prototype at the pre-warped frequency tan(w/2)/tan(w0/2).
double warpedAnalogDb(Kind kind, double frequency, double rate, double q, double gainDb, double probe) {
  const double x = std::tan(kPi * probe / rate) / std::tan(kPi * frequency / rate);
  return analogDb(kind, x, q, gainDb);
}

void filtersSvfMatchesWarpedPrototype() {
  struct Row { dsp::SvfMode mode; Kind kind; const char *name; double gain; };
  const Row rows[] = {
    {dsp::SvfMode::Bell, Kind::Bell, "bell+9", 9.0}, {dsp::SvfMode::Bell, Kind::Bell, "bell-9", -9.0},
    {dsp::SvfMode::LowShelf, Kind::LowShelf, "lowshelf+9", 9.0}, {dsp::SvfMode::LowShelf, Kind::LowShelf, "lowshelf-9", -9.0},
    {dsp::SvfMode::HighShelf, Kind::HighShelf, "highshelf+9", 9.0}, {dsp::SvfMode::HighShelf, Kind::HighShelf, "highshelf-9", -9.0},
    {dsp::SvfMode::LowPass, Kind::LowPass, "lowpass", 0.0}, {dsp::SvfMode::HighPass, Kind::HighPass, "highpass", 0.0},
  };
  for (const double rate : {44100.0, 48000.0, 96000.0}) {
    for (const Row &row : rows) {
      double worst = 0.0;
      for (const double frequency : {200.0, 3000.0}) {
        for (const double q : {0.7071, 3.0}) {
          for (int i = 0; i <= 24; ++i) {
            const double probe = 20.0 * std::pow(0.45 * rate / 20.0, i / 24.0);
            worst = std::max(worst, std::fabs(svfDb(row.mode, frequency, rate, q, row.gain, probe) -
              warpedAnalogDb(row.kind, frequency, rate, q, row.gain, probe)));
          }
        }
      }
      std::printf("  %.0f Hz %s: SVF vs warped analog prototype, worst %.5f dB\n", rate, row.name, worst);
      expectAtMost("svf_matches_the_prewarped_prototype_db", worst, 0.01);
    }
  }
  // Modes with no gain parameter: unity band-pass peak, notch null, all-pass flatness, peak = LP - HP.
  const double bandPeak = svfDb(dsp::SvfMode::BandPass, 1000.0, 48000.0, 5.0, 0.0, 1000.0);
  const double notchNull = svfDb(dsp::SvfMode::Notch, 1000.0, 48000.0, 5.0, 0.0, 1000.0);
  double allPassSpread = 0.0;
  for (const double probe : {50.0, 500.0, 1000.0, 5000.0, 15000.0}) {
    allPassSpread = std::max(allPassSpread, std::fabs(svfDb(dsp::SvfMode::AllPass, 1000.0, 48000.0, 5.0, 0.0, probe)));
  }
  const double peakAtCentre = svfDb(dsp::SvfMode::Peak, 1000.0, 48000.0, 5.0, 0.0, 1000.0);
  std::printf("  SVF band-pass peak %.4f dB, notch at centre %.1f dB, all-pass spread %.5f dB, peak mode at centre %.4f dB\n", bandPeak,
    notchNull, allPassSpread, peakAtCentre);
  expectNear("bandpass_has_unity_gain_at_the_centre", bandPeak, 0.0, 0.01);
  expectAtMost("notch_nulls_the_centre", notchNull, -60.0);
  expectAtMost("allpass_is_flat", allPassSpread, 0.01);
  expectNear("peak_mode_is_twice_the_bandpass_gain_at_the_centre", peakAtCentre, 20.0, 0.05);
}

void filtersSvfCramping() {
  // Same cramping as RBJ (both bilinear): reported so the Phase 1 decision has the number.
  double worst = 0.0;
  for (int i = 0; i <= 120; ++i) {
    const double probe = 20.0 * std::pow(0.45 * 48000.0 / 20.0, i / 120.0);
    worst = std::max(worst, std::fabs(svfDb(dsp::SvfMode::Bell, 12000.0, 48000.0, 1.0, 12.0, probe) - analogDb(Kind::Bell, probe / 12000.0, 1.0, 12.0)));
  }
  std::printf("  SVF bell 12k +12 dB Q1 vs the true analog prototype: worst %.2f dB (bilinear cramping, as RBJ)\n", worst);
  expectAtLeast("svf_is_bilinear_so_it_cramps_like_rbj", worst, 1.0);
}

double snrDb(const std::vector<double> &signal, const std::vector<double> &reference) {
  double signalPower = 0.0, errorPower = 0.0;
  for (size_t i = 0; i < signal.size(); ++i) {
    signalPower += reference[i] * reference[i];
    errorPower += (signal[i] - reference[i]) * (signal[i] - reference[i]);
  }
  return 10.0 * std::log10(signalPower / std::max(errorPower, 1e-300));
}

void filtersLowFrequencyPrecision() {
  const double rate = 48000.0;
  struct Setting { double frequency; double q; double gain; };
  const Setting settings[] = {{40.0, 1.0, 12.0}, {20.0, 0.5, -12.0}, {100.0, 18.0, 12.0}};
  for (const Setting &setting : settings) {
    const dsp::BiquadCoefficients c = dsp::designMatchedBell(setting.frequency, rate, setting.q, setting.gain);
    const dsp::SvfCoefficients s = dsp::designSvf(dsp::SvfMode::Bell, setting.frequency, rate, setting.q, setting.gain);
    dsp::Biquad<double> biquadDouble;
    dsp::Biquad<float> biquadFloat;
    dsp::Svf<double> svfDouble;
    dsp::Svf<float> svfFloat;
    Lcg rng;
    std::vector<double> reference, biquadReference, floatBiquad, floatSvf;
    for (int n = 0; n < 96000; ++n) {
      const float x = static_cast<float>(0.1 * std::sin(2.0 * kPi * 60.0 / rate * n) + 0.02 * (rng.next() - 0.5));
      const double ref = svfDouble.process(x, s);
      reference.push_back(ref);
      floatSvf.push_back(svfFloat.process(x, s));
      floatBiquad.push_back(biquadFloat.process(x, c));
      biquadReference.push_back(biquadDouble.process(x, c));
    }
    std::printf("  bell %.0f Hz Q%.1f %+.0f dB: SNR vs float64 of same structure: biquad float %.1f dB, SVF float %.1f dB\n", setting.frequency,
      setting.q, setting.gain, snrDb(floatBiquad, biquadReference), snrDb(floatSvf, reference));
    expectAtLeast("svf_with_float_state_snr_db", snrDb(floatSvf, reference), 100.0);
    expectAtLeast("biquad_float_snr_is_measured_for_comparison", snrDb(floatBiquad, biquadReference), 40.0);
  }
}

void filtersSafety() {
  dsp::Biquad<float> biquad;
  dsp::Svf<float> svf;
  const dsp::BiquadCoefficients c = dsp::designMatchedBell(500.0, 48000.0, 4.0, 12.0);
  const dsp::SvfCoefficients s = dsp::designSvf(dsp::SvfMode::Bell, 500.0, 48000.0, 4.0, 12.0);
  for (int n = 0; n < 200; ++n) {
    biquad.process(std::sin(0.05F * static_cast<float>(n)), c);
    svf.process(std::sin(0.05F * static_cast<float>(n)), s);
  }
  expectTrue("nan_input_gives_silence", biquad.process(std::nanf(""), c) == 0.0F && svf.process(std::nanf(""), s) == 0.0F);
  dsp::Biquad<float> freshBiquad;
  dsp::Svf<float> freshSvf;
  bool clean = true;
  for (int n = 0; n < 500; ++n) {
    const float x = std::sin(0.03F * static_cast<float>(n));
    clean = clean && biquad.process(x, c) == freshBiquad.process(x, c) && svf.process(x, s) == freshSvf.process(x, s);
  }
  expectTrue("blocks_match_fresh_blocks_after_a_nan", clean);

  // A long-ringing 40 Hz, Q 18 band: after a burst and 6 s of silence nothing may be subnormal.
  const dsp::BiquadCoefficients ring = dsp::designMatchedBell(40.0, 48000.0, 18.0, 24.0);
  const dsp::SvfCoefficients ringSvf = dsp::designSvf(dsp::SvfMode::Bell, 40.0, 48000.0, 18.0, 24.0);
  dsp::Biquad<float> b;
  dsp::Svf<float> v;
  long subnormal = 0;
  for (int n = 0; n < 48000 * 7; ++n) {
    const float x = n < 480 ? 1.0F : 0.0F;
    if (std::fpclassify(b.process(x, ring)) == FP_SUBNORMAL) ++subnormal;
    if (std::fpclassify(v.process(x, ringSvf)) == FP_SUBNORMAL) ++subnormal;
  }
  std::printf("  subnormal outputs after a burst and silence: %ld\n", subnormal);
  expectTrue("no_subnormal_outputs", subnormal == 0);
}

void filtersSvfPerSampleUpdate() {
  dsp::Svf<float> constant;
  dsp::Svf<float> perSample;
  const dsp::SvfCoefficients fixed = dsp::designSvf(dsp::SvfMode::LowPass, 1500.0, 48000.0, 2.0, 0.0);
  bool identical = true;
  for (int n = 0; n < 2000; ++n) {
    const float x = std::sin(0.2F * static_cast<float>(n));
    identical = identical && constant.process(x, fixed) == perSample.process(x, dsp::designSvf(dsp::SvfMode::LowPass, 1500.0, 48000.0, 2.0, 0.0));
  }
  expectTrue("redesigning_every_sample_is_identical_to_constant_coefficients", identical);

  // Cutoff swept 20 Hz .. 20 kHz and back every sample with high resonance on noise: must stay finite and bounded.
  Lcg rng;
  dsp::Svf<float> swept;
  float peak = 0.0F;
  for (int n = 0; n < 96000; ++n) {
    const double phase = std::fabs(2.0 * (n / 48000.0) - 1.0);
    const double cutoff = 20.0 * std::pow(1000.0, 1.0 - phase);
    const float y = swept.process(static_cast<float>(rng.between(-1.0, 1.0)), dsp::designSvf(dsp::SvfMode::LowPass, cutoff, 48000.0, 20.0, 0.0));
    peak = std::max(peak, std::fabs(y));
  }
  std::printf("  per-sample swept SVF, Q 20 on full-scale noise: peak output %.2f\n", static_cast<double>(peak));
  expectAtMost("swept_resonant_svf_stays_bounded", peak, 100.0);
}

constexpr Case kCases[] = {
  {"filters", "research_anchors", filtersAnchorsFromResearch},
  {"filters", "random_bells", filtersRandomBells},
  {"filters", "random_low_shelves", filtersRandomLowShelves},
  {"filters", "random_high_shelves", filtersRandomHighShelves},
  {"filters", "random_low_pass", filtersRandomLowPass},
  {"filters", "random_high_pass", filtersRandomHighPass},
  {"filters", "wide_q_report", filtersWideQReport},
  {"filters", "coefficient_stability", filtersCoefficientStability},
  {"filters", "svf_matches_warped_prototype", filtersSvfMatchesWarpedPrototype},
  {"filters", "svf_cramping", filtersSvfCramping},
  {"filters", "low_frequency_precision", filtersLowFrequencyPrecision},
  {"filters", "safety", filtersSafety},
  {"filters", "svf_per_sample_update", filtersSvfPerSampleUpdate},
  {"oversampler", "latency_and_dc", oversamplerLatencyAndDc},
  {"oversampler", "passband_and_stopband", oversamplerPassbandAndStopband},
  {"oversampler", "image_rejection", oversamplerImageRejection},
  {"oversampler", "reset_and_silence", oversamplerResetAndSilence},
  {"oversampler", "iir_latency_and_dc", iirLatencyAndDc},
  {"oversampler", "iir_passband_and_stopband", iirPassbandAndStopband},
  {"oversampler", "iir_image_rejection", iirImageRejection},
  {"oversampler", "iir_reset_and_safety", iirResetAndSafety},
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

// ---- cost per sample (only with the "bench" argument) -----------------------------------------------------------------

template <class Body>
void bench(const char *name, Body body) {
  constexpr int samples = 4000000;
  float sink = 0.0F;
  for (int n = 0; n < 100000; ++n) sink += body(n);
  const auto start = std::chrono::steady_clock::now();
  for (int n = 0; n < samples; ++n) sink += body(n);
  const auto stop = std::chrono::steady_clock::now();
  std::printf("  %-52s %7.2f ns/sample%s\n", name, std::chrono::duration<double, std::nano>(stop - start).count() / samples,
    sink == 12345.678F ? " " : "");
}

void runBench() {
  const auto input = [](int n) { return 0.5F * std::sin(0.01F * static_cast<float>(n & 4095)); };
  bench("baseline: the test signal alone (subtract from the rows below)", [&](int n) { return input(n); });
  dsp::ParameterSmoother<> linear;
  linear.prepare(48000.0, 10.0);
  linear.reset(0.0F);
  bench("smoother, linear, settled", [&](int) { return linear.next(); });
  linear.setTarget(1.0F);
  bench("smoother, linear, settling (re-targeted each 20000)", [&](int n) {
    if (n % 20000 == 0) linear.setTarget(n % 40000 == 0 ? 1.0F : 0.0F);
    return linear.next();
  });
  dsp::ParameterSmoother<dsp::SmoothDomain::Log> log;
  log.prepare(48000.0, 10.0);
  log.reset(100.0F);
  bench("smoother, log, settling (re-targeted each 20000)", [&](int n) {
    if (n % 20000 == 0) log.setTarget(n % 40000 == 0 ? 8000.0F : 100.0F);
    return log.next();
  });
  dsp::DelayRing<float> ring;
  ring.prepare(4096);
  bench("delay ring push + Hermite read", [&](int n) {
    ring.push(input(n));
    return ring.readHermite(100.37F + static_cast<float>(n & 7));
  });
  bench("delay ring push + Lagrange3 read", [&](int n) {
    ring.push(input(n));
    return ring.readLagrange3(100.37F + static_cast<float>(n & 7));
  });
  bench("delay ring push + linear read", [&](int n) {
    ring.push(input(n));
    return readLinear(ring, 100.37F + static_cast<float>(n & 7));
  });
  dsp::HalfBandOversampler2x os;
  bench("oversampler up + down, per base-rate sample", [&](int n) {
    const auto pair = os.up(input(n));
    return os.down(pair.first, pair.second);
  });
  dsp::PolyphaseIirHalfBand2x iirOs;
  bench("IIR half-band up + down, per base-rate sample", [&](int n) {
    const auto pair = iirOs.up(input(n));
    return static_cast<float>(iirOs.down(pair.first, pair.second));
  });
  bench("std::tanh (reference)", [&](int n) { return std::tanh(4.0F * input(n)); });
  dsp::Adaa1<dsp::TanhShaper> adaaTanh;
  bench("ADAA1 tanh", [&](int n) { return adaaTanh.process(4.0F * input(n)); });
  dsp::Adaa1<dsp::HardClipShaper> adaaClip;
  bench("ADAA1 hard clip", [&](int n) { return adaaClip.process(4.0F * input(n)); });
  dsp::Adaa1<dsp::SoftCubicShaper> adaaCubic;
  bench("ADAA1 soft cubic", [&](int n) { return adaaCubic.process(4.0F * input(n)); });
  dsp::Adaa1<dsp::TanhShaper> adaaTanh2x;
  dsp::HalfBandOversampler2x os2;
  bench("oversampler 2x + ADAA1 tanh, per base-rate sample", [&](int n) {
    const auto pair = os2.up(4.0F * input(n));
    return os2.down(adaaTanh2x.process(pair.first), adaaTanh2x.process(pair.second));
  });
  const dsp::SvfCoefficients svfCoefficients = dsp::designSvf(dsp::SvfMode::Bell, 1000.0, 48000.0, 1.0, 6.0);
  dsp::Svf<float> svfFloat;
  dsp::Svf<double> svfDouble;
  bench("SVF float, fixed coefficients", [&](int n) { return svfFloat.process(input(n), svfCoefficients); });
  bench("SVF double, fixed coefficients", [&](int n) { return static_cast<float>(svfDouble.process(input(n), svfCoefficients)); });
  dsp::Svf<float> svfModulated;
  bench("SVF float, designSvf (tan) every sample", [&](int n) {
    return svfModulated.process(input(n), dsp::designSvf(dsp::SvfMode::LowPass, 200.0 + static_cast<double>(n & 1023), 48000.0, 2.0));
  });
  const dsp::BiquadCoefficients biquadCoefficients = dsp::designMatchedBell(1000.0, 48000.0, 1.0, 6.0);
  dsp::Biquad<float> biquadFloat;
  dsp::Biquad<double> biquadDouble;
  bench("biquad float, fixed coefficients", [&](int n) { return biquadFloat.process(input(n), biquadCoefficients); });
  bench("biquad double, fixed coefficients", [&](int n) { return static_cast<float>(biquadDouble.process(input(n), biquadCoefficients)); });
  bench("designMatchedBell every sample", [&](int n) {
    return static_cast<float>(dsp::designMatchedBell(200.0 + static_cast<double>(n & 1023), 48000.0, 1.0, 6.0).b0);
  });
  bench("designMatchedLowShelf every sample", [&](int n) {
    return static_cast<float>(dsp::designMatchedLowShelf(200.0 + static_cast<double>(n & 1023), 48000.0, 0.7, 6.0).b0);
  });
  bench("RBJ bell design every sample (reference)", [&](int n) {
    return static_cast<float>(rbj(Kind::Bell, 200.0 + static_cast<double>(n & 1023), 48000.0, 1.0, 6.0).b0);
  });
}

}  // namespace

int main(int argc, char **argv) {
  const char *group = argc > 1 ? argv[1] : nullptr;
  if (group && std::strcmp(group, "bench") == 0) {
    runBench();
    return 0;
  }
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
