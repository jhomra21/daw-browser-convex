// Measurements for the Limiter kernel (src/limiter_kernel.h). Every case prints the number it checks.
// Run with a group name (attack, ceiling, gain, auto, latency, clean, safety, cpu) or with none for all.
#include "../src/limiter_kernel.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <vector>

namespace {

using daw::audio_core::LimiterConfig;
using daw::audio_core::LimiterKernel;
using daw::audio_core::LimiterValues;

constexpr double kPi = 3.14159265358979323846;
int failures = 0;
const char *currentName = "";

void report(const char *what, bool ok, double measured, const char *relation, double limit) {
  std::printf("  [%s] %s.%s measured=%.6g %s %.6g\n", ok ? "pass" : "FAIL", currentName, what, measured, relation, limit);
  if (!ok) ++failures;
}
void expectAtMost(const char *what, double measured, double limit) { report(what, measured <= limit, measured, "<=", limit); }
void expectAtLeast(const char *what, double measured, double limit) { report(what, measured >= limit, measured, ">=", limit); }
void expectNear(const char *what, double measured, double expected, double tolerance) {
  report(what, std::fabs(measured - expected) <= tolerance, measured, "~", expected);
}
void expectTrue(const char *what, bool ok) { report(what, ok, ok ? 1.0 : 0.0, "==", 1.0); }
void info(const char *what, double measured) { std::printf("  [info] %s.%s measured=%.6g\n", currentName, what, measured); }

double toDb(double ratio) { return 20.0 * std::log10(std::max(ratio, 1.0e-12)); }
double fromDb(double db) { return std::pow(10.0, db / 20.0); }

struct Rig {
  double rate;
  LimiterKernel kernel;
  LimiterValues values;
  LimiterConfig config;
  explicit Rig(double sampleRate = 48000.0) : rate(sampleRate) {
    kernel.prepare(rate);
    values.gain_db = 0.0F;
  }
  uint32_t delay() const { return LimiterKernel::latency_frames(config.lookahead_ms, rate); }
  std::vector<float> run(const std::vector<float> &input) {
    std::vector<float> out(input.size());
    for (size_t n = 0; n < input.size(); ++n) {
      float l = 0.0F, r = 0.0F;
      kernel.process(values, config, 0.0F, input[n], input[n], l, r);
      out[n] = l;
    }
    return out;
  }
};

std::vector<float> sine(size_t frames, double hz, double rate, double amplitude, double phase = 0.0) {
  std::vector<float> out(frames);
  for (size_t n = 0; n < frames; ++n) out[n] = static_cast<float>(amplitude * std::sin(2.0 * kPi * hz * static_cast<double>(n) / rate + phase));
  return out;
}

std::vector<float> noise(size_t frames, uint32_t seed) {
  std::vector<float> out(frames);
  uint32_t s = seed;
  for (float &v : out) {
    s = s * 1664525u + 1013904223u;
    v = static_cast<float>(static_cast<double>(s >> 8) / 8388608.0 - 1.0);
  }
  return out;
}

std::vector<float> lowpass(const std::vector<float> &input, double cutoff) {
  constexpr int kHalf = 200;
  std::vector<double> taps(2 * kHalf + 1);
  for (int i = -kHalf; i <= kHalf; ++i) {
    const double sinc = i == 0 ? 2.0 * cutoff : std::sin(2.0 * kPi * cutoff * i) / (kPi * i);
    taps[static_cast<size_t>(i + kHalf)] = sinc * (0.42 + 0.5 * std::cos(kPi * i / kHalf) + 0.08 * std::cos(2.0 * kPi * i / kHalf));
  }
  std::vector<float> out(input.size(), 0.0F);
  for (size_t n = kHalf; n + kHalf < input.size(); ++n) {
    double sum = 0.0;
    for (int i = -kHalf; i <= kHalf; ++i) sum += input[n + static_cast<size_t>(i + 0)] * taps[static_cast<size_t>(i + kHalf)];
    out[n] = static_cast<float>(sum);
  }
  return out;
}

void scaleToPeak(std::vector<float> &signal, double peak) {
  float largest = 0.0F;
  for (const float v : signal) largest = std::max(largest, std::fabs(v));
  for (float &v : signal) v = static_cast<float>(v * peak / largest);
}

// Reference true peak: Kaiser-windowed sinc, 16x, half-width 128 input samples. Only the neighbourhood of large samples
// is evaluated; a point between two samples cannot exceed the larger of them by more than the filter's overshoot.
double truePeakDb(const std::vector<float> &x) {
  constexpr int kHalf = 128;
  constexpr int kFactor = 16;
  float sampleMax = 0.0F;
  for (const float v : x) sampleMax = std::max(sampleMax, std::fabs(v));
  double peak = sampleMax;
  const auto bessel = [](double v) {
    double term = 1.0, sum = 1.0;
    for (int k = 1; k < 60; ++k) { term *= (v / (2.0 * k)) * (v / (2.0 * k)); sum += term; }
    return sum;
  };
  const double normaliser = bessel(9.0);
  std::vector<double> kernel(static_cast<size_t>(2 * kHalf * kFactor + 1));
  for (int i = -kHalf * kFactor; i <= kHalf * kFactor; ++i) {
    const double d = static_cast<double>(i) / kFactor;
    const double r = d / kHalf;
    kernel[static_cast<size_t>(i + kHalf * kFactor)] = (i == 0 ? 1.0 : std::sin(kPi * d) / (kPi * d)) * bessel(9.0 * std::sqrt(std::max(0.0, 1.0 - r * r))) / normaliser;
  }
  for (size_t k = kHalf; k + kHalf + 1 < x.size(); ++k) {
    if (std::max(std::fabs(x[k]), std::fabs(x[k + 1])) < 0.35F * sampleMax) continue;
    for (int p = 1; p < kFactor; ++p) {
      double sum = 0.0;
      for (int o = -kHalf + 1; o <= kHalf; ++o) sum += x[static_cast<size_t>(static_cast<long>(k) + o)] * kernel[static_cast<size_t>((p - o * kFactor) + kHalf * kFactor)];
      peak = std::max(peak, std::fabs(sum));
    }
  }
  return toDb(peak);
}

struct Case {
  const char *name;
  std::vector<float> signal;
};

std::vector<Case> ceilingSignals(double rate, double ceilingDb) {
  const double ceilingLinear = fromDb(ceilingDb);
  const size_t frames = static_cast<size_t>(rate);
  std::vector<Case> cases;
  auto full = noise(frames, 11);
  scaleToPeak(full, ceilingLinear * fromDb(4.0));
  cases.push_back({"white-noise +4 dB", full});
  auto band = lowpass(noise(frames, 23), 0.45);
  scaleToPeak(band, ceilingLinear * fromDb(4.0));
  cases.push_back({"noise lowpassed at 0.45 fs +4 dB", band});
  cases.push_back({"fs/4 sine at 45 deg +6 dB", sine(frames, rate / 4.0, rate, ceilingLinear * fromDb(6.0) , kPi / 4.0)});
  std::vector<float> square(frames);
  for (size_t n = 0; n < frames; ++n) square[n] = std::fmod(static_cast<double>(n) * 1000.0 / rate, 1.0) < 0.5 ? 1.5F : -1.5F;
  cases.push_back({"1 kHz square at 1.5", square});
  std::vector<float> clicks(frames, 0.0F);
  for (size_t n = frames / 8; n < frames; n += frames / 8) { clicks[n] = 1.9F; clicks[n + 1] = 1.9F * (n % 2 == 0 ? 1.0F : 0.0F); }
  cases.push_back({"isolated clicks", clicks});
  cases.push_back({"0.45 fs sine +4 dB", sine(frames, rate * 0.45, rate, ceilingLinear * fromDb(4.0))});
  return cases;
}

const double kRates[] = {44100.0, 48000.0, 96000.0};
const float kLookaheads[] = {1.5F, 3.0F, 6.0F};

void attack() {
  currentName = "attack";
  for (const float lookahead : kLookaheads) {
    std::printf(" lookahead %.1f ms\n", static_cast<double>(lookahead));
    {
      // A DC level makes the applied gain readable on every sample: out[n] / in[n - delay].
      Rig rig;
      rig.config.lookahead_ms = lookahead;
      std::vector<float> input(24000, 0.1F);
      const size_t click = 12000;
      input[click] = 1.9F;
      const auto out = rig.run(input);
      const uint32_t delay = rig.delay();
      double largestStep = 0.0, previous = 0.0, deepest = 0.0;
      for (size_t n = delay + 1; n < out.size(); ++n) {
        if (n - delay == click) continue;
        const double gain = toDb(std::fabs(out[n]) / 0.1);
        deepest = std::min(deepest, gain);
        largestStep = std::max(largestStep, std::fabs(gain - previous));
        previous = gain;
      }
      expectAtMost("max per-sample gain change dB", largestStep, 0.3);
      expectNear("click gain reduction dB", deepest, toDb(fromDb(-1.0) / 1.9), 0.05);
    }
    {
      Rig clean, clicked;
      clean.config.lookahead_ms = clicked.config.lookahead_ms = lookahead;
      auto tone = sine(24000, 1000.0, 48000.0, 0.1);
      auto withClick = tone;
      const size_t click = 12000;
      withClick[click] += 1.9F;
      const auto a = clean.run(tone);
      const auto b = clicked.run(withClick);
      const auto energy = [&](const std::vector<float> &x, size_t from, size_t to) {
        double sum = 0.0;
        for (size_t n = from; n < to; ++n) { const double d = x[n] - 3.0 * x[n - 1] + 3.0 * x[n - 2] - x[n - 3]; sum += d * d; }
        return sum;
      };
      const size_t arrival = click + clicked.delay();
      const double splatter = toDb(std::sqrt(energy(b, arrival - 480, arrival - 4) / energy(a, arrival - 480, arrival - 4)));
      expectAtMost("3rd-difference energy before the click vs tone alone dB", splatter, 3.0);
    }
  }
}

void ceiling() {
  currentName = "ceiling";
  const double ceilingDb = -1.0;
  for (const double rate : kRates) {
    for (const float lookahead : kLookaheads) {
      for (const Case &item : ceilingSignals(rate, ceilingDb)) {
        Rig rig(rate);
        rig.config.lookahead_ms = lookahead;
        rig.values.ceiling_dbtp = static_cast<float>(ceilingDb);
        const auto out = rig.run(item.signal);
        const double peak = truePeakDb(out);
        char label[160];
        std::snprintf(label, sizeof label, "%.0f Hz %.1f ms %s true peak over ceiling dB (clips %llu)", rate, static_cast<double>(lookahead), item.name,
          static_cast<unsigned long long>(rig.kernel.safety_clips()));
        // Full-band noise reaches fs/2, where inter-sample peaks depend on samples beyond any lookahead.
        if (std::strcmp(item.name, "white-noise +4 dB") == 0) info(label, peak - ceilingDb);
        else expectAtMost(label, peak - ceilingDb, 0.05);
      }
    }
  }
}

void gain() {
  currentName = "gain";
  // The ceiling sits at -9 dBTP so that a -10 dBFS tone raised by 6 dB (-4 dBFS) needs exactly 5 dB of reduction.
  Rig rig;
  rig.values.ceiling_dbtp = -9.0F;
  rig.values.gain_db = 6.0F;
  const auto out = rig.run(sine(48000, 997.0, 48000.0, fromDb(-10.0)));
  float peak = 0.0F;
  for (size_t n = 24000; n < out.size(); ++n) peak = std::max(peak, std::fabs(out[n]));
  expectNear("output peak dBFS", toDb(peak), -9.0, 0.05);
  expectNear("gain reduction dB", -10.0 + 6.0 - toDb(peak), 5.0, 0.1);
  Rig unity;
  const auto through = unity.run(sine(48000, 997.0, 48000.0, 0.25));
  float unityPeak = 0.0F;
  for (size_t n = 24000; n < through.size(); ++n) unityPeak = std::max(unityPeak, std::fabs(through[n]));
  expectNear("gain 0 dB below the ceiling passes the level", toDb(unityPeak), toDb(0.25), 0.01);
}

// Time for the gain, read from a DC bed under the ceiling, to come within 0.5 dB of unity after the limiter stops working.
double recoveryMs(Rig &rig, size_t burstFrames, double burstLevel) {
  const size_t lead = 4800;
  std::vector<float> input(lead + burstFrames + 96000, 0.1F);
  for (size_t n = lead; n < lead + burstFrames; ++n) input[n] = static_cast<float>(burstLevel);
  const auto out = rig.run(input);
  const size_t end = lead + burstFrames + rig.delay();
  for (size_t n = end; n < out.size(); ++n) {
    if (toDb(std::fabs(out[n]) / 0.1) > -0.5) return static_cast<double>(n - end) * 1000.0 / rig.rate;
  }
  return -1.0;
}

void autoRelease() {
  currentName = "auto";
  Rig isolated, sustained, manual;
  isolated.config.auto_release = sustained.config.auto_release = true;
  manual.config.auto_release = false;
  manual.values.release_ms = 1000.0F;
  const double fast = recoveryMs(isolated, 240, 2.0);
  const double slow = recoveryMs(sustained, 96000, 2.0);
  info("recovery after a 5 ms peak ms", fast);
  info("recovery after 2 s of limiting ms", slow);
  expectAtMost("recovery after an isolated peak <= 4x the fast stage ms", fast, 4.0 * static_cast<double>(LimiterKernel::kAutoFastMs));
  expectAtLeast("recovery after sustained limiting is at least 3x the isolated one", slow, 3.0 * fast);
  expectAtMost("recovery after sustained limiting <= 4x the slow stage ms", slow, 4.0 * static_cast<double>(LimiterKernel::kAutoSlowMs));
  // Steady limiting: the gain of a steady tone does not ripple.
  for (const bool automatic : {false, true}) {
    Rig rig;
    rig.config.auto_release = automatic;
    const auto out = rig.run(sine(96000, 997.0, 48000.0, 1.0));
    double low = 1.0e9, high = -1.0e9;
    const auto reference = sine(96000, 997.0, 48000.0, 1.0);
    const uint32_t delay = rig.delay();
    for (size_t n = 48000; n < out.size(); ++n) {
      if (std::fabs(reference[n - delay]) < 0.5F) continue;
      const double g = toDb(out[n] / reference[n - delay]);
      low = std::min(low, g);
      high = std::max(high, g);
    }
    expectAtMost(automatic ? "auto steady gain ripple p-p dB" : "manual steady gain ripple p-p dB", high - low, 0.1);
  }
}

void latency() {
  currentName = "latency";
  for (const double rate : kRates) {
    for (const float lookahead : kLookaheads) {
      Rig rig(rate);
      rig.config.lookahead_ms = lookahead;
      std::vector<float> impulse(static_cast<size_t>(rate / 10.0), 0.0F);
      impulse[100] = 0.2F;
      const auto out = rig.run(impulse);
      size_t at = 0;
      for (size_t n = 0; n < out.size(); ++n) if (std::fabs(out[n]) > std::fabs(out[at])) at = n;
      char label[96];
      std::snprintf(label, sizeof label, "%.0f Hz %.1f ms impulse delay frames", rate, static_cast<double>(lookahead));
      expectNear(label, static_cast<double>(at - 100), std::ceil(static_cast<double>(lookahead) * rate / 1000.0), 1.0);
    }
  }
}

void clean() {
  currentName = "clean";
  for (const double rate : kRates) for (const float lookahead : kLookaheads) {
    Rig rig(rate);
    rig.config.lookahead_ms = lookahead;
    rig.values.ceiling_dbtp = -1.0F;
    // A whole number of cycles in the half second that is analysed, so the fit has no leakage.
    const size_t length = static_cast<size_t>(std::round(rate * 0.5));
    const double hz = std::round(997.0 * 0.5) * rate / static_cast<double>(length);
    const auto out = rig.run(sine(2 * length, hz, rate, fromDb(-1.0) * fromDb(6.0)));
    double sc = 0.0, ss = 0.0, total = 0.0;
    for (size_t n = 0; n < length; ++n) {
      const double w = 2.0 * kPi * hz * static_cast<double>(n) / rate;
      sc += out[length + n] * std::cos(w);
      ss += out[length + n] * std::sin(w);
      total += static_cast<double>(out[length + n]) * out[length + n];
    }
    const double fundamental = (sc * sc + ss * ss) * 2.0 / static_cast<double>(length);
    const double residual = std::max(total - fundamental, 0.0);
    char label[96];
    std::snprintf(label, sizeof label, "%.0f Hz %.1f ms 997 Hz THD+N dB", rate, static_cast<double>(lookahead));
    expectAtMost(label, toDb(std::sqrt(residual / fundamental)), -100.0);
  }
}

void safety() {
  currentName = "safety";
  Rig rig;
  auto input = sine(48000, 440.0, 48000.0, 0.2);
  input[2000] = std::numeric_limits<float>::quiet_NaN();
  input[2001] = std::numeric_limits<float>::infinity();
  input[2002] = -std::numeric_limits<float>::infinity();
  for (size_t n = 3000; n < 3100; ++n) input[n] = 1.0e-40F;
  const auto out = rig.run(input);
  bool finite = true;
  for (const float v : out) finite = finite && std::isfinite(v);
  expectTrue("every output sample is finite", finite);
  const auto reference = sine(48000, 440.0, 48000.0, 0.2);
  double error = 0.0;
  for (size_t n = 40000; n < 48000; ++n) error = std::max(error, static_cast<double>(std::fabs(out[n] - reference[n - rig.delay()])));
  expectAtMost("a clean tone after the bad samples is unchanged", error, 1.0e-6);
  Rig denormal;
  const auto quiet = denormal.run(std::vector<float>(96000, 1.0e-39F));
  float largest = 0.0F;
  for (const float v : quiet) largest = std::max(largest, std::fabs(v));
  expectAtMost("denormal input leaves no residue", largest, 1.0e-30);
}

void cpu() {
  currentName = "cpu";
  for (const bool loud : {false, true}) {
    Rig rig;
    const size_t frames = 48000 * 10;
    auto signal = noise(frames, 5);
    if (!loud) for (float &v : signal) v *= 0.1F;
    float l = 0.0F, r = 0.0F;
    const auto start = std::chrono::steady_clock::now();
    for (size_t n = 0; n < frames; ++n) rig.kernel.process(rig.values, rig.config, 0.0F, signal[n], signal[n], l, r);
    const double ns = std::chrono::duration<double, std::nano>(std::chrono::steady_clock::now() - start).count() / static_cast<double>(frames);
    info(loud ? "ns per frame, noise 6 dB over the ceiling" : "ns per frame, noise 14 dB under the ceiling", ns + (l + r) * 0.0);
  }
}

}  // namespace

int main(int argc, char **argv) {
  struct Group { const char *name; void (*run)(); };
  const Group groups[] = {{"attack", attack}, {"ceiling", ceiling}, {"gain", gain}, {"auto", autoRelease}, {"latency", latency},
    {"clean", clean}, {"safety", safety}, {"cpu", cpu}};
  for (const Group &group : groups) {
    if (argc > 1 && std::strcmp(argv[1], group.name) != 0) continue;
    std::printf("%s\n", group.name);
    group.run();
  }
  std::printf("%d failure(s)\n", failures);
  return failures == 0 ? 0 : 1;
}
