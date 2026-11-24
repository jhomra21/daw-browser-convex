// Tests for the shared DSP blocks in src/dsp. Every case prints the number it checks against its limit.
// Run with a group name (smoother, safety, latency, delay, oversampler, adaa, filters) or with no argument for all.
#include "../src/dsp/latency.h"
#include "../src/dsp/numeric_safety.h"
#include "../src/dsp/parameter_smoother.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
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

constexpr Case kCases[] = {
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
