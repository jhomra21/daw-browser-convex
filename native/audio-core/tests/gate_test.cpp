// Measurements for the Gate kernel (src/gate_kernel.h). Every case prints the number it checks.
// Run with a group name (detector, timing, hold, expander, controls, sidechain, safety, latency, cpu) or with none for all.
#include "../src/gate_kernel.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <vector>

namespace {

using daw::audio_core::GateConfig;
using daw::audio_core::GateKernel;
using daw::audio_core::GateValues;

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

// RBJ cookbook high-pass / low-pass / band-pass, as the graph's shared designer produces for the detector filter.
daw::audio_core::dsp::BiquadCoefficients rbj(char type, double frequency, double q, double rate) {
  const double omega = 2.0 * kPi * frequency / rate;
  const double cosine = std::cos(omega);
  const double alpha = std::sin(omega) / (2.0 * q);
  const double a0 = 1.0 + alpha;
  if (type == 'b') return {.b0 = alpha / a0, .b1 = 0.0, .b2 = -alpha / a0, .a1 = -2.0 * cosine / a0, .a2 = (1.0 - alpha) / a0};
  const bool highpass = type == 'h';
  const double edge = highpass ? (1.0 + cosine) * 0.5 : (1.0 - cosine) * 0.5;
  return {.b0 = edge / a0, .b1 = (highpass ? -(1.0 + cosine) : 1.0 - cosine) / a0, .b2 = edge / a0, .a1 = -2.0 * cosine / a0, .a2 = (1.0 - alpha) / a0};
}

struct Rig {
  double rate;
  GateKernel kernel;
  GateValues values;
  GateConfig config;
  std::vector<float> gain_db;  // the kernel's gain per frame, filled by run
  explicit Rig(double sampleRate = 48000.0) : rate(sampleRate) { kernel.prepare(rate); }
  uint32_t delay() const { return GateKernel::latency_frames(config.lookahead_ms, rate); }
  std::vector<float> run(const std::vector<float> &input, const std::vector<float> *key = nullptr) {
    std::vector<float> out(input.size());
    gain_db.assign(input.size(), 0.0F);
    for (size_t n = 0; n < input.size(); ++n) {
      float l = 0.0F, r = 0.0F;
      const float k = key ? (*key)[n] : input[n];
      kernel.process(values, config, 0.0F, input[n], input[n], k, k, l, r);
      out[n] = l;
      gain_db[n] = kernel.gain_reduction_db();
    }
    return out;
  }
};

std::vector<float> sine(size_t frames, double hz, double rate, double amplitude, double phase = 0.0) {
  std::vector<float> out(frames);
  for (size_t n = 0; n < frames; ++n) out[n] = static_cast<float>(amplitude * std::sin(phase + 2.0 * kPi * hz * static_cast<double>(n) / rate));
  return out;
}

std::vector<float> concat(std::vector<float> a, const std::vector<float> &b) {
  a.insert(a.end(), b.begin(), b.end());
  return a;
}

// THD+N of the last length frames: everything that a sine fit at hz leaves over, relative to the fit.
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

// Milliseconds from frame from to the first frame where the predicate holds; a large number when it never does.
template <class Predicate>
double msUntil(const std::vector<float> &gain, size_t from, double rate, Predicate predicate) {
  for (size_t n = from; n < gain.size(); ++n) if (predicate(gain[n])) return static_cast<double>(n - from) * 1000.0 / rate;
  return 1.0e9;
}

void detector() {
  currentName = "detector";
  for (const bool rms : {false, true}) for (const double rate : kRates) for (const double hz : {30.0, 60.0, 100.0, 200.0}) {
    Rig rig(rate);
    rig.config.rms = rms;
    rig.values = {.threshold_db = -40.0F, .hold_ms = 0.0F, .hysteresis_db = 6.0F, .range_db = -60.0F};
    const size_t length = static_cast<size_t>(rate);
    // RMS reads 3 dB under the peak, so the tone sits 3 dB over the threshold for the detector that is being measured.
    const auto out = rig.run(sine(3 * length, hz, rate, fromDb(rms ? -34.0 : -37.0)));
    char label[96];
    std::snprintf(label, sizeof label, "%.0f Hz %s %.0f Hz at threshold +3 dB, hold 0, THD+N dB", rate, rms ? "rms" : "peak", hz);
    expectAtMost(label, thdPlusNoiseDb(out, length, hz, rate), -100.0);
    float lowest = 0.0F;
    for (size_t n = length / 2; n < rig.gain_db.size(); ++n) lowest = std::min(lowest, rig.gain_db[n]);
    std::snprintf(label, sizeof label, "%.0f Hz %s %.0f Hz lowest gain after the first half second dB", rate, rms ? "rms" : "peak", hz);    expectAtLeast(label, lowest, 0.0);
  }
  for (const double rate : kRates) {
    Rig rig(rate);
    rig.values = {.threshold_db = -40.0F, .hold_ms = 0.0F, .release_ms = 100.0F, .range_db = -60.0F};
    const size_t length = static_cast<size_t>(rate);
    const auto out = rig.run(sine(2 * length, 1000.0, rate, fromDb(-50.0)));
    char label[96];
    std::snprintf(label, sizeof label, "%.0f Hz closed gate gain after hold and release, dB", rate);
    expectAtMost(label, toDb(peakOf(out, length, 2 * length) / fromDb(-50.0)), -59.5);
  }
}

void timing() {
  currentName = "timing";
  for (const double rate : kRates) {
    Rig rig(rate);
    rig.values = {.threshold_db = -40.0F, .attack_ms = 10.0F, .hold_ms = 0.0F, .release_ms = 100.0F, .hysteresis_db = 6.0F, .range_db = -60.0F};
    const size_t second = static_cast<size_t>(rate);
    const auto quiet = sine(second, 1000.0, rate, fromDb(-50.0));
    const auto loud = sine(second, 1000.0, rate, fromDb(-10.0), kPi / 2.0);
    rig.run(concat(concat(quiet, loud), concat(loud, quiet)));
    char label[112];
    std::snprintf(label, sizeof label, "%.0f Hz attack 10 ms from -60 dB, time to 90 %% of unity ms", rate);
    expectNear(label, msUntil(rig.gain_db, second, rate, [](float g) { return g >= toDb(0.9); }), 10.0, 1.0);
    std::snprintf(label, sizeof label, "%.0f Hz attack 10 ms from -60 dB, time to 0 dB, ms over 10 ms plus a frame", rate);
    expectAtMost(label, msUntil(rig.gain_db, second, rate, [](float g) { return g >= 0.0F; }) - 10.0 - 1000.0 / rate, 0.0);
    std::snprintf(label, sizeof label, "%.0f Hz release 100 ms from open, time to the floor plus 1 dB, ms", rate);
    expectNear(label, msUntil(rig.gain_db, 3 * second, rate, [](float g) { return g <= -59.0F; }), 100.0, 5.0);
    std::snprintf(label, sizeof label, "%.0f Hz release 100 ms from open, time to the floor, ms", rate);
    expectNear(label, msUntil(rig.gain_db, 3 * second, rate, [](float g) { return g <= -60.0F; }), 100.0, 5.0);
  }
  // The slew is linear in dB: halfway through the attack the gain is halfway to unity in dB.
  Rig rig;
  rig.values = {.threshold_db = -40.0F, .attack_ms = 10.0F, .hold_ms = 0.0F, .range_db = -60.0F};
  rig.run(concat(sine(48000, 1000.0, 48000.0, fromDb(-50.0)), sine(48000, 1000.0, 48000.0, fromDb(-10.0), kPi / 2.0)));
  expectNear("gain 5 ms into a 10 ms attack from -60 dB, dB", rig.gain_db[48000 + 239], -30.0, 0.3);
}

void hold() {
  currentName = "hold";
  for (const double rate : kRates) {
    Rig rig(rate);
    rig.values = {.threshold_db = -40.0F, .hold_ms = 50.0F, .release_ms = 100.0F, .hysteresis_db = 6.0F, .range_db = -60.0F};
    const size_t second = static_cast<size_t>(rate);
    rig.run(concat(sine(second, 1000.0, rate, fromDb(-10.0)), sine(second, 1000.0, rate, fromDb(-60.0))));
    char label[96];
    std::snprintf(label, sizeof label, "%.0f Hz gain starts to fall after the hold plus the 4 ms window, ms", rate);
    expectNear(label, msUntil(rig.gain_db, second, rate, [](float g) { return g < 0.0F; }), 54.0, 1.0);
    std::snprintf(label, sizeof label, "%.0f Hz gain at the end of the hold, dB", rate);
    expectNear(label, rig.gain_db[second + static_cast<size_t>(0.053 * rate)], 0.0, 0.0);
  }
}

void expander() {
  currentName = "expander";
  for (const double rate : kRates) {
    Rig rig(rate);
    rig.config.expander = true;
    rig.values = {.threshold_db = -40.0F, .ratio = 2.0F, .hold_ms = 0.0F, .release_ms = 20.0F, .range_db = -60.0F};
    const size_t second = static_cast<size_t>(rate);
    rig.run(concat(sine(second, 1000.0, rate, fromDb(-10.0)), sine(2 * second, 1000.0, rate, fromDb(-50.0))));
    char label[96];
    std::snprintf(label, sizeof label, "%.0f Hz expander ratio 2, 10 dB under the threshold, gain dB", rate);
    expectNear(label, rig.gain_db.back(), -10.0, 0.1);
    rig.run(sine(second, 1000.0, rate, fromDb(-80.0)));
    std::snprintf(label, sizeof label, "%.0f Hz expander never goes under the floor, gain dB", rate);
    expectAtLeast(label, rig.gain_db.back(), -60.0);
  }
}

// A drum-like fixture: 100 ms tone bursts, 300 ms of low-level tone between them.
std::vector<float> drums(double rate) {
  std::vector<float> out;
  const size_t burst = static_cast<size_t>(0.1 * rate);
  const size_t gap = static_cast<size_t>(0.3 * rate);
  for (int hit = 0; hit < 6; ++hit) {
    out = concat(out, sine(burst, 220.0, rate, fromDb(-10.0), kPi / 2.0));
    out = concat(out, sine(gap, 330.0, rate, fromDb(-60.0)));
  }
  return out;
}

void controls() {
  currentName = "controls";
  for (const double rate : kRates) {
    const auto input = drums(rate);
    const size_t burst = static_cast<size_t>(0.1 * rate);
    const size_t period = burst + static_cast<size_t>(0.3 * rate);
    char label[112];
    for (const bool flip : {false, true}) {
      Rig rig(rate);
      rig.config.flip = flip;
      rig.values = {.threshold_db = -40.0F, .attack_ms = 1.0F, .hold_ms = 10.0F, .release_ms = 20.0F, .hysteresis_db = 6.0F, .range_db = -60.0F};
      const auto out = rig.run(input);
      const size_t hit = 4 * period;
      std::snprintf(label, sizeof label, "%.0f Hz flip %s, level of the burst, dB", rate, flip ? "on" : "off");
      expectNear(label, toDb(peakOf(out, hit + burst / 2, hit + burst) / peakOf(input, hit + burst / 2, hit + burst)), flip ? -60.0 : 0.0, flip ? 0.5 : 0.01);
      std::snprintf(label, sizeof label, "%.0f Hz flip %s, level of the gap, dB", rate, flip ? "on" : "off");
      expectNear(label, toDb(peakOf(out, hit + period - burst, hit + period) / peakOf(input, hit + period - burst, hit + period)), flip ? 0.0 : -60.0, flip ? 0.01 : 0.5);
    }
  }
  // Dry/Wet at 0 % is the gate's own input as the key: bit for bit the same output with or without a key routed.
  const auto input = drums(48000.0);
  const std::vector<float> key = sine(input.size(), 90.0, 48000.0, 0.8);
  Rig internal;
  Rig external;
  external.config.external_key = true;
  external.values.sidechain_mix = 0.0F;
  external.values.sidechain_gain_db = 12.0F;
  internal.values = external.values;
  const auto expected = internal.run(input);
  const auto out = external.run(input, &key);
  expectTrue("mix 0 % with an external key is bit-exact with the internal key", std::memcmp(expected.data(), out.data(), expected.size() * sizeof(float)) == 0);
  // Mix 100 % keys on the external signal alone: a quiet input opens when the key is loud, and Gain scales the key.
  const auto quiet = sine(48000, 500.0, 48000.0, fromDb(-60.0));
  const auto gainAfter = [&](float gainDb, float mix, double keyDb) {
    Rig keyed;
    keyed.config.external_key = true;
    keyed.values = {.threshold_db = -30.0F, .attack_ms = 0.1F, .hold_ms = 0.0F, .range_db = -60.0F, .sidechain_gain_db = gainDb, .sidechain_mix = mix};
    const auto key = sine(48000, 500.0, 48000.0, fromDb(keyDb));
    keyed.run(quiet, &key);
    return static_cast<double>(keyed.gain_db.back());
  };
  expectAtMost("a key 10 dB under the threshold keeps the gate closed, gain dB", gainAfter(0.0F, 1.0F, -40.0), -59.5);
  expectNear("the same key with Gain +12 dB opens the gate, gain dB", gainAfter(12.0F, 1.0F, -40.0), 0.0, 0.0);
  expectAtMost("a loud key at Dry/Wet 10 % leaves the quiet input's own level in charge, gain dB", gainAfter(0.0F, 0.1F, -20.0), -59.5);
  expectNear("the same key at Dry/Wet 50 % opens the gate, gain dB", gainAfter(0.0F, 0.5F, -20.0), 0.0, 0.0);
  expectNear("the same key at Dry/Wet 100 % opens the gate, gain dB", gainAfter(0.0F, 1.0F, -20.0), 0.0, 0.0);
}
// Level a steady tone must have to open the gate: the detector's gain at hz is the inverse of this, in dB.
double openingLevelDb(double hz, double rate, char type, double frequency, double q) {
  const auto opens = [&](double amplitude) {
    Rig rig(rate);
    rig.config.rms = true;
    rig.values = {.threshold_db = -40.0F, .hold_ms = 0.0F, .release_ms = 5.0F, .range_db = -80.0F};
    rig.kernel.set_sidechain(true, rbj(type, frequency, q, rate));
    // The gate starts open and closes once it has heard the tone below the threshold, so it is open at the end only when the key reaches it.
    rig.run(sine(static_cast<size_t>(2.0 * rate), hz, rate, amplitude));
    return rig.gain_db.back() > -40.0F;
  };
  double low = fromDb(-120.0);
  double high = fromDb(20.0);
  for (int i = 0; i < 40; ++i) {
    const double middle = std::sqrt(low * high);
    (opens(middle) ? high : low) = middle;
  }
  return toDb(std::sqrt(low * high));
}

void sidechain() {
  currentName = "sidechain";
  for (const double rate : kRates) {
    char label[112];
    const double reference = openingLevelDb(1000.0, rate, 'h', 120.0, 0.707);
    std::snprintf(label, sizeof label, "%.0f Hz high-pass 120 Hz Q 0.707, detector gain at 60 Hz dB", rate);
    expectNear(label, reference - openingLevelDb(60.0, rate, 'h', 120.0, 0.707), -12.0, 0.5);
    std::snprintf(label, sizeof label, "%.0f Hz high-pass 120 Hz Q 0.707, detector gain at 120 Hz dB", rate);
    const double corner = reference - openingLevelDb(120.0, rate, 'h', 120.0, 0.707);
    expectNear(label, corner, -3.0, 0.3);
    std::snprintf(label, sizeof label, "%.0f Hz Q 4 against Q 0.707 at the corner, dB", rate);
    expectAtLeast(label, (openingLevelDb(120.0, rate, 'h', 120.0, 0.707) - openingLevelDb(120.0, rate, 'h', 120.0, 4.0)) - 0.0, 6.0);
    std::snprintf(label, sizeof label, "%.0f Hz low-pass 120 Hz, detector gain at 240 Hz against 100 Hz (analog -12.3 and -1.7 dB) dB", rate);
    expectNear(label, openingLevelDb(100.0, rate, 'l', 120.0, 0.707) - openingLevelDb(240.0, rate, 'l', 120.0, 0.707), -10.6, 0.5);
    std::snprintf(label, sizeof label, "%.0f Hz band-pass 1 kHz Q 2, detector gain at 250 Hz dB", rate);
    expectAtMost(label, openingLevelDb(1000.0, rate, 'b', 1000.0, 2.0) - openingLevelDb(250.0, rate, 'b', 1000.0, 2.0), -10.0);
  }
}

void safety() {
  currentName = "safety";
  for (const bool rms : {false, true}) for (const bool external : {false, true}) {
    const auto input = sine(96000, 440.0, 48000.0, 0.5);
    const auto key = sine(96000, 220.0, 48000.0, 0.5);
    const auto dirty = [&](std::vector<float> &signal, size_t at) {
      signal[at] = std::numeric_limits<float>::quiet_NaN();
      signal[at + 1] = std::numeric_limits<float>::infinity();
      signal[at + 2] = -std::numeric_limits<float>::infinity();
      for (size_t n = 0; n < 200; ++n) signal[at + 10 + n] = 1.0e-40F * static_cast<float>(n);
    };
    auto dirtyInput = input;
    auto dirtyKey = key;
    dirty(dirtyInput, 5000);
    dirty(dirtyKey, 9000);
    Rig reference;
    Rig rig;
    for (Rig *r : {&reference, &rig}) {
      r->config.rms = rms;
      r->config.external_key = external;
      r->values.threshold_db = -20.0F;
    }
    const auto expected = reference.run(input, &key);
    const auto out = rig.run(dirtyInput, &dirtyKey);
    bool finite = true;
    for (const float v : out) finite = finite && std::isfinite(v);
    char label[96];
    std::snprintf(label, sizeof label, "%s %s key: every output sample is finite", rms ? "rms" : "peak", external ? "external" : "internal");
    expectTrue(label, finite);
    std::snprintf(label, sizeof label, "%s %s key: level after recovery differs from the clean run, dB", rms ? "rms" : "peak", external ? "external" : "internal");
    expectAtMost(label, std::fabs(toDb(peakOf(out, 80000, 96000)) - toDb(peakOf(expected, 80000, 96000))), 0.1);
  }
  Rig denormal;
  const auto quiet = denormal.run(std::vector<float>(96000, 1.0e-39F));
  float largest = 0.0F;
  for (const float v : quiet) largest = std::max(largest, std::fabs(v));
  expectAtMost("denormal input leaves no residue", largest, 1.0e-30);
}

void latency() {
  currentName = "latency";
  for (const double rate : kRates) for (const float lookahead : {0.0F, 1.0F, 10.0F}) {
    Rig rig(rate);
    rig.config.lookahead_ms = lookahead;
    rig.values.threshold_db = -80.0F;
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
  // With lookahead the gate has opened by the time the onset leaves the delay line.
  Rig rig;
  rig.config.lookahead_ms = 10.0F;
  rig.values = {.threshold_db = -40.0F, .attack_ms = 10.0F, .hold_ms = 0.0F, .range_db = -60.0F};
  const auto out = rig.run(concat(std::vector<float>(48000, 0.0F), sine(48000, 1000.0, 48000.0, 0.5, kPi / 2.0)));
  expectNear("10 ms lookahead against a 10 ms attack: the onset is passed at full level, dB", toDb(std::fabs(out[48000 + 480]) / 0.5), 0.0, 0.05);
}

void cpu() {
  currentName = "cpu";
  for (const bool rms : {false, true}) {
    Rig rig;
    rig.config.rms = rms;
    rig.values.threshold_db = -30.0F;
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
  const Group groups[] = {{"detector", detector}, {"timing", timing}, {"hold", hold}, {"expander", expander}, {"controls", controls},
    {"sidechain", sidechain}, {"safety", safety}, {"latency", latency}, {"cpu", cpu}};
  for (const Group &group : groups) {
    if (argc > 1 && std::strcmp(argv[1], group.name) != 0) continue;
    std::printf("%s\n", group.name);
    group.run();
  }
  std::printf("%d failure(s)\n", failures);
  return failures == 0 ? 0 : 1;
}
