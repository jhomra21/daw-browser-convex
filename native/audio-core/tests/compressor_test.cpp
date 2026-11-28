// Measurements for the Compressor kernel (src/compressor_kernel.h). Every case prints the number it checks.
// Run with a group name (detector, safety, smoothing, sidechain, latency, release, makeup, cpu) or with none for all.
#include "../src/compressor_kernel.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <vector>

namespace {

using daw::audio_core::CompressorConfig;
using daw::audio_core::CompressorKernel;
using daw::audio_core::CompressorValues;

constexpr double kPi = 3.14159265358979323846;
constexpr double kRates[] = {44100.0, 48000.0, 96000.0};
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

// RBJ cookbook high-pass / low-pass, as the graph's shared designer produces for the detector filter.
daw::audio_core::dsp::BiquadCoefficients rbj(bool highpass, double frequency, double q, double rate) {
  const double omega = 2.0 * kPi * frequency / rate;
  const double cosine = std::cos(omega);
  const double alpha = std::sin(omega) / (2.0 * q);
  const double a0 = 1.0 + alpha;
  const double edge = highpass ? (1.0 + cosine) * 0.5 : (1.0 - cosine) * 0.5;
  return {.b0 = edge / a0, .b1 = (highpass ? -(1.0 + cosine) : 1.0 - cosine) / a0, .b2 = edge / a0, .a1 = -2.0 * cosine / a0, .a2 = (1.0 - alpha) / a0};
}

struct Rig {
  double rate;
  CompressorKernel kernel;
  CompressorValues values;
  CompressorConfig config;
  explicit Rig(double sampleRate = 48000.0) : rate(sampleRate) {
    kernel.prepare(rate);
    config.rms = false;
  }
  uint32_t delay() const { return CompressorKernel::latency_frames(config.lookahead_ms, rate); }
  std::vector<float> run(const std::vector<float> &input, const std::vector<float> *key = nullptr) {
    std::vector<float> out(input.size());
    for (size_t n = 0; n < input.size(); ++n) {
      float l = 0.0F, r = 0.0F;
      const float k = key ? (*key)[n] : input[n];
      kernel.process(values, config, 0.0F, input[n], input[n], k, k, l, r);
      out[n] = l;
    }
    return out;
  }
};

std::vector<float> sine(size_t frames, double hz, double rate, double amplitude) {
  std::vector<float> out(frames);
  for (size_t n = 0; n < frames; ++n) out[n] = static_cast<float>(amplitude * std::sin(2.0 * kPi * hz * static_cast<double>(n) / rate));
  return out;
}

// THD+N of the last `length` frames: everything that a sine fit at hz leaves over, relative to the fit.
double thdPlusNoiseDb(const std::vector<float> &x, size_t length, double hz, double rate) {
  double sc = 0.0, ss = 0.0, total = 0.0;
  const size_t start = x.size() - length;
  for (size_t n = 0; n < length; ++n) {
    const double w = 2.0 * kPi * hz * static_cast<double>(start + n) / rate;
    sc += x[start + n] * std::cos(w);
    ss += x[start + n] * std::sin(w);
    total += static_cast<double>(x[start + n]) * x[start + n];
  }
  const double fundamental = (sc * sc + ss * ss) * 2.0 / static_cast<double>(length);
  return toDb(std::sqrt(std::max(total - fundamental, 0.0) / fundamental));
}

double peakOf(const std::vector<float> &x, size_t from, size_t to) {
  float peak = 0.0F;
  for (size_t n = from; n < to; ++n) peak = std::max(peak, std::fabs(x[n]));
  return peak;
}

double maxStep(const std::vector<float> &x, size_t from, size_t to) {
  double step = 0.0;
  for (size_t n = from; n < to; ++n) step = std::max(step, static_cast<double>(std::fabs(x[n] - x[n - 1])));
  return step;
}

void detector() {
  currentName = "detector";
  struct Case { bool rms; float attack; float release; double limit; };
  const Case cases[] = {{false, 10.0F, 120.0F, -55.0}, {true, 10.0F, 120.0F, -55.0}, {true, 1.0F, 50.0F, -45.0}};
  for (const double rate : kRates) for (const Case &c : cases) for (const double hz : {50.0, 100.0}) {
    Rig rig(rate);
    rig.config.rms = c.rms;
    rig.values = {.threshold_db = -24.0F, .ratio = 4.0F, .attack_ms = c.attack, .release_ms = c.release, .knee_db = 0.0F};
    const size_t length = static_cast<size_t>(rate);
    const auto out = rig.run(sine(3 * length, hz, rate, 0.5));
    char label[112];
    std::snprintf(label, sizeof label, "%.0f Hz %s %.0f Hz att %.0f rel %.0f THD+N dB", rate, c.rms ? "rms" : "peak", hz, static_cast<double>(c.attack), static_cast<double>(c.release));
    expectAtMost(label, thdPlusNoiseDb(out, length, hz, rate), c.limit);
  }
  // The detector's RMS time constant, read off a DC step: the gain starts to fall when the mean square crosses a level
  // that the step reaches after exactly one time constant (63.2 % of its final 0.25). Quantisation is the only rate effect.
  double first[3] = {};
  for (int i = 0; i < 3; ++i) {
    Rig rig(kRates[i]);
    rig.config.rms = true;
    rig.values = {.threshold_db = static_cast<float>(10.0 * std::log10(0.25 * (1.0 - std::exp(-1.0)))), .ratio = 100.0F, .attack_ms = 0.1F, .release_ms = 5.0F, .knee_db = 0.0F};
    for (size_t n = 0; n < 24000; ++n) {
      float l = 0.0F, r = 0.0F;
      rig.kernel.process(rig.values, rig.config, 0.0F, 0.5F, 0.5F, 0.5F, 0.5F, l, r);
      if (rig.kernel.gain_reduction_db() < -0.001F) { first[i] = static_cast<double>(n) * 1000.0 / kRates[i]; break; }
    }
    char label[64];
    std::snprintf(label, sizeof label, "%.0f Hz RMS crossing time ms", kRates[i]);
    info(label, first[i]);
  }
  const double mean = (first[0] + first[1] + first[2]) / 3.0;
  expectAtMost("RMS time constant spread across 44.1/48/96 kHz, relative", (*std::max_element(first, first + 3) - *std::min_element(first, first + 3)) / mean, 0.02);
  for (const double rate : kRates) {
    Rig rig(rate);
    rig.values = {.threshold_db = -24.0F, .ratio = 4.0F, .attack_ms = 1.0F, .release_ms = 50.0F, .knee_db = 0.0F};
    const size_t length = static_cast<size_t>(rate);
    const auto out = rig.run(sine(2 * length, 1000.0, rate, 0.5));
    char label[64];
    std::snprintf(label, sizeof label, "%.0f Hz peak mode steady output dBFS", rate);
    expectNear(label, toDb(peakOf(out, length, 2 * length)), -19.5, 0.1);
  }
}

void safety() {
  currentName = "safety";
  for (const bool rms : {false, true}) {
    auto input = sine(96000, 440.0, 48000.0, 0.5);
    auto key = sine(96000, 220.0, 48000.0, 0.5);
    const auto clean = [&](std::vector<float> &signal, size_t at) {
      signal[at] = std::numeric_limits<float>::quiet_NaN();
      signal[at + 1] = std::numeric_limits<float>::infinity();
      signal[at + 2] = -std::numeric_limits<float>::infinity();
      for (size_t n = 0; n < 200; ++n) signal[at + 10 + n] = 1.0e-40F * static_cast<float>(n);
    };
    auto dirtyInput = input;
    auto dirtyKey = key;
    clean(dirtyInput, 5000);
    clean(dirtyKey, 9000);
    Rig reference;
    reference.config.rms = rms;
    Rig rig;
    rig.config.rms = rms;
    const auto expected = reference.run(input, &key);
    const auto out = rig.run(dirtyInput, &dirtyKey);
    bool finite = true;
    for (const float v : out) finite = finite && std::isfinite(v);
    expectTrue(rms ? "rms: every output sample is finite" : "peak: every output sample is finite", finite);
    expectAtMost(rms ? "rms: level after recovery differs from the clean run, dB" : "peak: level after recovery differs from the clean run, dB",
      std::fabs(toDb(peakOf(out, 80000, 96000)) - toDb(peakOf(expected, 80000, 96000))), 0.1);
  }
  Rig denormal;
  const auto quiet = denormal.run(std::vector<float>(96000, 1.0e-39F));
  float largest = 0.0F;
  for (const float v : quiet) largest = std::max(largest, std::fabs(v));
  expectAtMost("denormal input leaves no residue", largest, 1.0e-30);
}

void smoothing() {
  currentName = "smoothing";
  for (const double rate : kRates) {
    const size_t frames = static_cast<size_t>(rate);
    const size_t at = frames / 2;
    const auto input = sine(frames, 1000.0, rate, 0.25);
    const double slope = maxStep(input, 1, frames);
    for (const int which : {0, 1, 2}) {
      Rig rig(rate);
      rig.values = {.threshold_db = 0.0F, .ratio = 1.0F, .knee_db = 0.0F};
      std::vector<float> out(frames);
      for (size_t n = 0; n < frames; ++n) {
        if (n == at) {
          if (which == 0) rig.values.makeup_db = -12.0F;
          if (which == 1) rig.values.output_db = -12.0F;
          if (which == 2) rig.values.dry_wet = 0.0F;
        }
        float l = 0.0F, r = 0.0F;
        rig.kernel.process(rig.values, rig.config, 0.0F, input[n], input[n], input[n], input[n], l, r);
        out[n] = l;
      }
      char label[96];
      std::snprintf(label, sizeof label, "%.0f Hz %s step, max sample delta / sine slope", rate, which == 0 ? "makeup" : which == 1 ? "output" : "dry/wet");
      expectAtMost(label, maxStep(out, at, at + 2048) / slope, 1.5);
    }
  }
  // Threshold and ratio move through the same smoothers: a 40 dB threshold step must not click either.
  Rig rig;
  rig.values = {.threshold_db = -60.0F, .ratio = 20.0F, .attack_ms = 0.1F, .release_ms = 5.0F, .knee_db = 0.0F};
  const auto input = sine(48000, 1000.0, 48000.0, 0.5);
  std::vector<float> out(input.size());
  for (size_t n = 0; n < input.size(); ++n) {
    if (n == 24000) rig.values.threshold_db = 0.0F;
    float l = 0.0F, r = 0.0F;
    rig.kernel.process(rig.values, rig.config, 0.0F, input[n], input[n], input[n], input[n], l, r);
    out[n] = l;
  }
  expectAtMost("threshold step -60 to 0 dB, max sample delta / sine slope", maxStep(out, 24000, 26000) / maxStep(input, 1, input.size()), 1.5);
}

// Gain of the detector path at hz, read off the compression it causes: RMS mode with equal slow attack and release averages the
// gain computer's output over the 2f ripple, so the steady gain reduction maps back to the key level.
double detectorGainDb(double hz, double rate, const daw::audio_core::dsp::BiquadCoefficients &filter) {
  Rig rig(rate);
  rig.config.rms = true;
  rig.values = {.threshold_db = -80.0F, .ratio = 20.0F, .attack_ms = 100.0F, .release_ms = 100.0F, .knee_db = 0.0F};
  rig.kernel.set_sidechain(true, filter);
  const double amplitude = 0.5;
  const size_t frames = static_cast<size_t>(4.0 * rate);
  const auto input = sine(frames, hz, rate, amplitude);
  for (const float v : input) {
    float l = 0.0F, r = 0.0F;
    rig.kernel.process(rig.values, rig.config, 0.0F, v, v, v, v, l, r);
  }
  const double reduction = rig.kernel.gain_reduction_db();
  const double keyDb = reduction / (1.0 / 20.0 - 1.0) + -80.0;
  return keyDb - 10.0 * std::log10(amplitude * amplitude / 2.0);
}

void sidechain() {
  currentName = "sidechain";
  for (const double rate : kRates) {
    char label[96];
    const auto highpass = rbj(true, 120.0, 0.707, rate);
    std::snprintf(label, sizeof label, "%.0f Hz high-pass 120 Hz Q 0.707, detector gain at 60 Hz dB", rate);
    expectNear(label, detectorGainDb(60.0, rate, highpass), -12.0, 0.5);
    std::snprintf(label, sizeof label, "%.0f Hz high-pass 120 Hz Q 0.707, detector gain at 120 Hz dB", rate);
    const double corner = detectorGainDb(120.0, rate, highpass);
    expectNear(label, corner, -3.0, 0.3);
    std::snprintf(label, sizeof label, "%.0f Hz Q 4 against Q 0.707 at the corner, dB", rate);
    expectAtLeast(label, detectorGainDb(120.0, rate, rbj(true, 120.0, 4.0, rate)) - corner, 6.0);
    std::snprintf(label, sizeof label, "%.0f Hz low-pass 120 Hz, detector gain at 240 Hz dB", rate);
    expectNear(label, detectorGainDb(240.0, rate, rbj(false, 120.0, 0.707, rate)), -12.0, 0.5);
  }
}

void latency() {
  currentName = "latency";
  for (const double rate : kRates) for (const float lookahead : {0.0F, 1.0F, 10.0F}) {
    Rig rig(rate);
    rig.config.lookahead_ms = lookahead;
    rig.values = {.threshold_db = 0.0F, .ratio = 1.0F, .knee_db = 0.0F};
    std::vector<float> impulse(2000, 0.0F);
    impulse[100] = 0.5F;
    const auto out = rig.run(impulse);
    size_t at = 0;
    for (size_t n = 0; n < out.size(); ++n) if (std::fabs(out[n]) > std::fabs(out[at])) at = n;
    char label[96];
    std::snprintf(label, sizeof label, "%.0f Hz %.0f ms impulse delay frames", rate, static_cast<double>(lookahead));
    expectNear(label, static_cast<double>(at - 100), std::ceil(static_cast<double>(lookahead) * rate / 1000.0), 1.0);
    expectNear("the declared latency is the delay", static_cast<double>(rig.delay()), std::ceil(static_cast<double>(lookahead) * rate / 1000.0), 0.0);
  }
}

// Frames from the end of a tone burst until the gain reduction has fallen to a tenth of its depth.
double recoveryFrames(double burstSeconds, bool automatic, double rate) {
  Rig rig(rate);
  rig.config.auto_release = automatic;
  rig.values = {.threshold_db = -40.0F, .ratio = 20.0F, .attack_ms = 0.1F, .release_ms = 500.0F, .knee_db = 0.0F};
  const size_t burst = static_cast<size_t>(burstSeconds * rate);
  const auto tone = sine(burst, 1000.0, rate, fromDb(-10.0));
  float l = 0.0F, r = 0.0F;
  for (const float v : tone) rig.kernel.process(rig.values, rig.config, 0.0F, v, v, v, v, l, r);
  const double depth = rig.kernel.gain_reduction_db();
  for (size_t n = 0; n < static_cast<size_t>(10.0 * rate); ++n) {
    rig.kernel.process(rig.values, rig.config, 0.0F, 0.0F, 0.0F, 0.0F, 0.0F, l, r);
    if (rig.kernel.gain_reduction_db() > 0.1 * depth) return static_cast<double>(n);
  }
  return 1.0e9;
}

void release() {
  currentName = "release";
  for (const double rate : kRates) {
    const double nominalBurst = recoveryFrames(0.02, false, rate);
    const double nominalSteady = recoveryFrames(2.0, false, rate);
    char label[96];
    std::snprintf(label, sizeof label, "%.0f Hz recovery after a 20 ms burst, auto over manual", rate);
    expectAtMost(label, recoveryFrames(0.02, true, rate) / nominalBurst, 0.5);
    std::snprintf(label, sizeof label, "%.0f Hz recovery after 2 s of compression, auto over manual", rate);
    const double steady = recoveryFrames(2.0, true, rate) / nominalSteady;
    expectAtLeast(label, steady, 1.5);
    expectAtMost(label, steady, 3.0);
  }
}

void makeup() {
  currentName = "makeup";
  for (const double rate : kRates) {
    Rig rig(rate);
    rig.config.auto_makeup = true;
    rig.values = {.threshold_db = -24.0F, .ratio = 4.0F, .attack_ms = 1.0F, .release_ms = 50.0F, .knee_db = 0.0F};
    const size_t frames = static_cast<size_t>(rate);
    auto out = rig.run(sine(2 * frames, 1000.0, rate, 1.0));
    char label[96];
    std::snprintf(label, sizeof label, "%.0f Hz auto makeup, 0 dBFS in, output dBFS", rate);
    expectNear(label, toDb(peakOf(out, frames, 2 * frames)), 0.0, 0.05);
    rig.values.threshold_db = -12.0F;
    rig.values.ratio = 2.0F;
    out = rig.run(sine(2 * frames, 1000.0, rate, 1.0));
    std::snprintf(label, sizeof label, "%.0f Hz auto makeup follows threshold and ratio, output dBFS", rate);
    expectNear(label, toDb(peakOf(out, frames, 2 * frames)), 0.0, 0.05);
    rig.config.auto_makeup = false;
    out = rig.run(sine(2 * frames, 1000.0, rate, 1.0));
    std::snprintf(label, sizeof label, "%.0f Hz manual makeup 0 dB, output dBFS", rate);
    expectNear(label, toDb(peakOf(out, frames, 2 * frames)), -6.0, 0.05);
  }
}

void cpu() {
  currentName = "cpu";
  for (const bool rms : {false, true}) {
    Rig rig;
    rig.config.rms = rms;
    rig.values = {.threshold_db = -24.0F, .ratio = 4.0F, .attack_ms = 10.0F, .release_ms = 120.0F, .knee_db = 6.0F};
    const size_t frames = 48000 * 10;
    std::vector<float> signal(frames);
    uint32_t s = 5;
    for (float &v : signal) {
      s = s * 1664525u + 1013904223u;
      v = static_cast<float>((static_cast<double>(s >> 8) / 8388608.0 - 1.0) * 0.25);
    }
    float l = 0.0F, r = 0.0F;
    const auto start = std::chrono::steady_clock::now();
    for (size_t n = 0; n < frames; ++n) rig.kernel.process(rig.values, rig.config, 0.0F, signal[n], signal[n], signal[n], signal[n], l, r);
    const double ns = std::chrono::duration<double, std::nano>(std::chrono::steady_clock::now() - start).count() / static_cast<double>(frames);
    info(rms ? "ns per frame, rms, noise at default settings" : "ns per frame, peak, noise at default settings", ns + (l + r) * 0.0);
  }
}

}  // namespace

int main(int argc, char **argv) {
  struct Group { const char *name; void (*run)(); };
  const Group groups[] = {{"detector", detector}, {"safety", safety}, {"smoothing", smoothing}, {"sidechain", sidechain},
    {"latency", latency}, {"release", release}, {"makeup", makeup}, {"cpu", cpu}};
  for (const Group &group : groups) {
    if (argc > 1 && std::strcmp(argv[1], group.name) != 0) continue;
    std::printf("%s\n", group.name);
    group.run();
  }
  std::printf("%d failure(s)\n", failures);
  return failures == 0 ? 0 : 1;
}
