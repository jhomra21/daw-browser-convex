// Measurements for the Auto Filter kernel (src/autofilter_kernel.h). Every case prints the number it checks.
// Run with a group name (clean, alias, latency, resonance, slope, switch, modulation, safety) or with none for all.
#include "../src/autofilter_kernel.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <complex>
#include <cstdio>
#include <cstring>
#include <limits>
#include <vector>

namespace {

using daw::audio_core::AutoFilterConfig;
using daw::audio_core::AutoFilterKernel;
using daw::audio_core::AutoFilterTransport;
using daw::audio_core::AutoFilterValues;

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

double toDb(double ratio) { return 20.0 * std::log10(std::max(ratio, 1.0e-12)); }

struct Rig {
  double rate;
  AutoFilterKernel kernel;
  AutoFilterValues values;
  AutoFilterConfig config;
  AutoFilterTransport transport{.tempo_bpm = 120.0, .frame = 0, .running = false};
  explicit Rig(double sampleRate = 48000.0) : rate(sampleRate) {
    kernel.prepare(rate);
    values.frequency_hz = 20000.0F;
    values.resonance = 0.0F;
  }
  std::vector<float> run(const std::vector<float> &input, std::vector<float> *right = nullptr) {
    std::vector<float> out(input.size());
    if (right != nullptr) right->assign(input.size(), 0.0F);
    for (size_t n = 0; n < input.size(); ++n) {
      float l = 0.0F, r = 0.0F;
      kernel.process(values, config, transport, 0.0F, input[n], input[n], l, r);
      if (transport.running) ++transport.frame;
      out[n] = l;
      if (right != nullptr) (*right)[n] = r;
    }
    return out;
  }
};

std::vector<float> sine(size_t frames, double hz, double rate, double amplitude) {
  std::vector<float> out(frames);
  for (size_t n = 0; n < frames; ++n) out[n] = static_cast<float>(amplitude * std::sin(2.0 * kPi * hz * static_cast<double>(n) / rate));
  return out;
}

std::vector<float> noise(size_t frames, double amplitude, uint32_t seed) {
  std::vector<float> out(frames);
  uint32_t s = seed;
  for (float &v : out) {
    s = s * 1664525u + 1013904223u;
    v = static_cast<float>(amplitude * (static_cast<double>(s >> 8) / 8388608.0 - 1.0));
  }
  return out;
}

// Frequency that fits a whole number of cycles in `frames`, so a rectangular window has no leakage.
double coherent(double hz, size_t frames, double rate) { return std::round(hz * static_cast<double>(frames) / rate) * rate / static_cast<double>(frames); }

struct ToneFit {
  double amplitude;
  double residualRms;
  double fundamentalRms;
};

ToneFit fitTone(const std::vector<float> &signal, size_t from, double hz, double rate) {
  double sc = 0.0, ss = 0.0;
  const size_t count = signal.size() - from;
  for (size_t n = 0; n < count; ++n) {
    const double phase = 2.0 * kPi * hz * static_cast<double>(n + from) / rate;
    sc += signal[n + from] * std::cos(phase);
    ss += signal[n + from] * std::sin(phase);
  }
  const double a = 2.0 * sc / static_cast<double>(count), b = 2.0 * ss / static_cast<double>(count);
  double residual = 0.0;
  for (size_t n = 0; n < count; ++n) {
    const double phase = 2.0 * kPi * hz * static_cast<double>(n + from) / rate;
    const double e = signal[n + from] - a * std::cos(phase) - b * std::sin(phase);
    residual += e * e;
  }
  const double amplitude = std::sqrt(a * a + b * b);
  return {amplitude, std::sqrt(residual / static_cast<double>(count)), amplitude / std::sqrt(2.0)};
}

double peakAbs(const std::vector<float> &v, size_t from = 0) {
  double p = 0.0;
  for (size_t n = from; n < v.size(); ++n) p = std::max(p, static_cast<double>(std::fabs(v[n])));
  return p;
}

double maxStep(const std::vector<float> &v, size_t from, size_t to) {
  double s = 0.0;
  for (size_t n = std::max<size_t>(from, 1); n < std::min(to, v.size()); ++n) s = std::max(s, static_cast<double>(std::fabs(v[n] - v[n - 1])));
  return s;
}

// Energy outside the harmonics of `hz` below Nyquist, relative to the fundamental (Hann-windowed DFT of one second).
double aliasDb(const std::vector<float> &signal, size_t from, double hz, double rate) {
  const size_t n = 2048;
  std::vector<double> window(n);
  for (size_t i = 0; i < n; ++i) window[i] = 0.5 - 0.5 * std::cos(2.0 * kPi * static_cast<double>(i) / static_cast<double>(n));
  const double binHz = rate / static_cast<double>(n);
  double total = 0.0, fundamental = 0.0;
  for (size_t bin = 1; bin < n / 2; ++bin) {
    std::complex<double> sum = 0.0;
    for (size_t i = 0; i < n; ++i) sum += static_cast<double>(signal[from + i]) * window[i] * std::polar(1.0, -2.0 * kPi * static_cast<double>(bin) * static_cast<double>(i) / static_cast<double>(n));
    const double power = std::norm(sum);
    const double freq = static_cast<double>(bin) * binHz;
    bool harmonic = false;
    for (int h = 1; h <= 8 && h * hz < rate / 2.0; ++h) harmonic = harmonic || std::fabs(freq - h * hz) < 3.0 * binHz;
    if (std::fabs(freq - hz) < 3.0 * binHz) fundamental += power;
    else if (!harmonic) total += power;
  }
  return 10.0 * std::log10(std::max(total, 1.0e-30) / fundamental);
}

double gainAt(Rig &rig, double hz, double amplitude = 0.1) {
  const double f = coherent(hz, static_cast<size_t>(rig.rate), rig.rate);
  const auto out = rig.run(sine(static_cast<size_t>(2 * rig.rate), f, rig.rate, amplitude));
  return toDb(fitTone(out, static_cast<size_t>(rig.rate), f, rig.rate).amplitude / amplitude);
}

// ---- A1: clean at drive 0, real oversampling and ADAA -------------------------------------------------------------

void cleanDriveZero() {
  for (const bool hq : {false, true}) {
    Rig rig;
    rig.config.hi_quality = hq;
    rig.values.resonance = 0.0F;
    const double f = coherent(1000.0, 24000, rig.rate);
    const auto out = rig.run(sine(48000, f, rig.rate, 0.5));
    // 192 = 4 cycles of 1 kHz at 48 kHz, so the fitted window holds whole cycles after the oversampler settles.
    const ToneFit fit = fitTone(out, 24000 + (hq ? 192 : 0), f, rig.rate);
    expectAtMost(hq ? "hq thd+n at drive 0 dB (dB)" : "thd+n at drive 0 dB (dB)", toDb(fit.residualRms / fit.fundamentalRms), -90.0);
    expectNear(hq ? "hq gain at drive 0 dB (dB)" : "gain at drive 0 dB (dB)", toDb(fit.amplitude / 0.5), 0.0, 0.05);
  }
}

// 4992 Hz sits on a bin of the 2048-point DFT, so the measurement has no leakage. Its fifth harmonic (24.96 kHz) lands in
// the half-band's transition band, which is what limits the hardest drive.
double aliasAt(float driveDb, bool quality) {
  Rig rig;
  rig.config.hi_quality = quality;
  rig.values.drive_db = driveDb;
  const double f = coherent(4992.0, 4096, rig.rate);
  return aliasDb(rig.run(sine(8192, f, rig.rate, 0.5)), 4096, f, rig.rate);
}

void aliasReduction() {
  expectAtMost("hq alias energy at 12 dB drive, 4992 Hz (dB rel. fundamental)", aliasAt(12.0F, true), -50.0);
  expectAtMost("hq alias energy at 24 dB drive, 4992 Hz (dB rel. fundamental)", aliasAt(24.0F, true), -40.0);
  expectAtLeast("standard alias energy at 24 dB is the unoversampled reference (dB)", aliasAt(24.0F, false), aliasAt(24.0F, true) + 15.0);
}

void driveLevel() {
  Rig rig;
  rig.values.drive_db = 24.0F;
  const double f = coherent(1000.0, 24000, rig.rate);
  const auto quiet = rig.run(sine(48000, f, rig.rate, 0.001));
  expectNear("small-signal gain stays 0 dB at drive 24 dB (dB)", toDb(fitTone(quiet, 24000, f, rig.rate).amplitude / 0.001), 0.0, 0.2);
  Rig loud;
  loud.values.drive_db = 24.0F;
  const auto hot = loud.run(sine(48000, f, rig.rate, 0.5));
  expectAtMost("a hot signal is limited by the drive (peak)", peakAbs(hot, 24000), 0.2);
}

// ---- A2: latency ----------------------------------------------------------------------------------------------------

void latencyReported() {
  expectTrue("standard reports 0 frames", AutoFilterKernel::latency_frames(false) == 0);
  expectTrue("hq reports 63 frames (the half-band pair)", AutoFilterKernel::latency_frames(true) == 63);
}

void latencyAligned() {
  for (const bool hq : {false, true}) {
    const uint32_t latency = AutoFilterKernel::latency_frames(hq);
    Rig rig;
    rig.config.hi_quality = hq;
    rig.values.mix = 0.0F;
    const auto in = noise(4096, 0.5, 5);
    const auto out = rig.run(in);
    double worst = 0.0;
    for (size_t n = latency; n < in.size(); ++n) worst = std::max(worst, static_cast<double>(std::fabs(out[n] - in[n - latency])));
    expectAtMost(hq ? "hq dry path is the input delayed by the declared latency (abs)" : "dry path is the input, undelayed (abs)", worst, 1.0e-6);
  }
  Rig rig;
  rig.config.hi_quality = true;
  std::vector<float> impulse(2048, 0.0F);
  impulse[512] = 1.0F;
  const auto out = rig.run(impulse);
  size_t peak = 0;
  for (size_t n = 0; n < out.size(); ++n) if (std::fabs(out[n]) > std::fabs(out[peak])) peak = n;
  expectNear("hq open filter impulse peak vs declared latency (frames)", static_cast<double>(peak) - 512.0, 63.0, 1.0);
}

// ---- A3: resonance -----------------------------------------------------------------------------------------------------

void resonanceMapping() {
  expectNear("resonance 0 is Butterworth Q", AutoFilterKernel::q_from_resonance(0.0F), 0.70710678, 1.0e-4);
  expectNear("resonance 1 is the top Q", AutoFilterKernel::q_from_resonance(1.0F), 8.0, 1.0e-3);
  const float low = AutoFilterKernel::q_from_resonance(0.3F), high = AutoFilterKernel::q_from_resonance(0.6F);
  expectTrue("resonance is monotonic and exponential (equal steps scale Q equally)",
    std::fabs(AutoFilterKernel::q_from_resonance(0.9F) / high - high / low) < 0.02);
}

void resonanceLevel() {
  Rig rig;
  rig.values.frequency_hz = 1000.0F;
  rig.values.resonance = 1.0F;
  const auto in = noise(4 * 48000, 0.1, 17);
  const auto out = rig.run(in);
  expectAtMost("peak(out) - peak(in), resonance 1.0, noise -20 dBFS (dB)", toDb(peakAbs(out, 48000) / peakAbs(in, 48000)), 6.0);
}

void resonancePeakHeight() {
  Rig rig;
  rig.values.frequency_hz = 1000.0F;
  rig.values.resonance = 0.5F;
  const float q = AutoFilterKernel::q_from_resonance(0.5F);
  expectNear("low-pass peak at the cutoff equals Q (dB)", gainAt(rig, 1000.0), toDb(q), 0.4);
}

void bandPassUnity() {
  for (const uint32_t slope : {0u, 1u}) {
    for (const float resonance : {0.0F, 0.25F, 0.5F, 1.0F}) {
      Rig rig;
      rig.config.mode = 2;
      rig.config.slope = slope;
      rig.values.frequency_hz = static_cast<float>(coherent(1000.0, 48000, rig.rate));
      rig.values.resonance = resonance;
      char label[96];
      std::snprintf(label, sizeof label, "band-pass centre gain, slope %u, resonance %.2f (dB)", slope == 0 ? 12u : 24u, resonance);
      expectNear(label, gainAt(rig, rig.values.frequency_hz), 0.0, 0.5);
    }
  }
}

void clipAndOutput() {
  Rig rig;
  rig.values.output_db = -6.0206F;
  const double f = coherent(1000.0, 24000, rig.rate);
  const auto out = rig.run(sine(48000, f, rig.rate, 0.5));
  expectNear("output -6 dB halves the level", fitTone(out, 24000, f, rig.rate).amplitude, 0.25, 0.005);
  Rig hot;
  hot.config.clip = true;
  hot.values.output_db = 12.0F;
  const auto clipped = hot.run(sine(48000, f, hot.rate, 1.0));
  expectAtMost("clip holds a +12 dB hot signal under full scale (peak)", peakAbs(clipped, 24000), 1.0);
  Rig open;
  open.values.output_db = 12.0F;
  expectAtLeast("without clip the same signal exceeds full scale (peak)", peakAbs(open.run(sine(48000, f, open.rate, 1.0)), 24000), 3.0);
}

// ---- A5: slopes ---------------------------------------------------------------------------------------------------------

void slopes() {
  Rig lp;
  lp.config.slope = 1;
  lp.values.frequency_hz = 1000.0F;
  expectAtLeast("24 dB low-pass 1 kHz attenuation at 4 kHz (dB)", -gainAt(lp, 4000.0), 44.0);
  Rig hp;
  hp.config.mode = 1;
  hp.config.slope = 1;
  hp.values.frequency_hz = 1000.0F;
  expectAtLeast("24 dB high-pass 1 kHz attenuation at 250 Hz (dB)", -gainAt(hp, 250.0), 44.0);
  Rig twelve;
  twelve.values.frequency_hz = 1000.0F;
  expectNear("12 dB low-pass 1 kHz attenuation at 4 kHz (dB)", -gainAt(twelve, 4000.0), 24.0, 1.5);
  Rig notch;
  notch.config.mode = 3;
  notch.config.slope = 1;
  notch.values.frequency_hz = static_cast<float>(coherent(1000.0, 48000, notch.rate));
  expectAtLeast("24 dB notch removes its centre (dB)", -gainAt(notch, notch.values.frequency_hz), 40.0);
  Rig passband;
  passband.config.slope = 1;
  passband.values.frequency_hz = 1000.0F;
  expectNear("24 dB low-pass is flat well below the cutoff (dB)", gainAt(passband, 100.0), 0.0, 0.2);
}

// ---- A7: smoothing and click-free switching ---------------------------------------------------------------------------------

void cutoffStepClick() {
  Rig rig;
  rig.values.frequency_hz = 400.0F;
  const std::vector<float> input = sine(2 * 48000, 220.0, rig.rate, 0.3);
  const std::vector<float> before = rig.run(std::vector<float>(input.begin(), input.begin() + 48000));
  const double steady = maxStep(before, 24000, 48000);
  rig.values.frequency_hz = 4000.0F;
  const auto after = rig.run(std::vector<float>(input.begin() + 48000, input.end()));
  expectAtMost("max sample step after a 400 Hz to 4 kHz cutoff step vs steady state (ratio)", maxStep(after, 0, 4096) / steady, 1.5);
}

void switchClick() {
  struct Switch { const char *name; uint32_t mode0, slope0, mode1, slope1; };
  const Switch cases[] = {
    {"low-pass to band-pass", 0, 0, 2, 0}, {"low-pass to high-pass", 0, 0, 1, 0}, {"12 dB to 24 dB", 0, 0, 0, 1},
    {"band-pass to notch", 2, 0, 3, 0}, {"24 dB high-pass to 12 dB low-pass", 1, 1, 0, 0},
  };
  for (const Switch &c : cases) {
    Rig rig;
    rig.config.mode = c.mode0;
    rig.config.slope = c.slope0;
    rig.values.frequency_hz = 1000.0F;
    rig.values.resonance = 0.4F;
    const auto input = sine(3 * 48000, 700.0, rig.rate, 0.5);
    std::vector<float> first(input.begin(), input.begin() + 48000), rest(input.begin() + 48000, input.end());
    const auto a = rig.run(first);
    const double steadyPeak = std::max(peakAbs(a, 24000), 0.05);
    rig.config.mode = c.mode1;
    rig.config.slope = c.slope1;
    const auto b = rig.run(rest);
    char label[128];
    std::snprintf(label, sizeof label, "%s: peak sample step after the switch vs the steady-state peak (ratio)", c.name);
    expectAtMost(label, maxStep(b, 0, 2048) / (2.0 * std::max(steadyPeak, peakAbs(b, 24000))), 0.3);
    std::snprintf(label, sizeof label, "%s: output peak after the switch vs steady-state peak (ratio)", c.name);
    expectAtMost(label, peakAbs(b, 0) / std::max(steadyPeak, peakAbs(b, 24000)), 1.6);
  }
}

// ---- A4/A5: modulation ---------------------------------------------------------------------------------------------------------

void lfoShapes() {
  for (uint32_t waveform = 0; waveform < 6; ++waveform) {
    double sum = 0.0, low = 10.0, high = -10.0;
    const uint32_t steps = 4096, cycles = waveform == 5 ? 4000 : 1;
    for (uint32_t cycle = 0; cycle < cycles; ++cycle) {
      for (uint32_t i = 0; i < steps; ++i) {
        const float v = AutoFilterKernel::lfo_shape(waveform, static_cast<double>(i) / steps, cycle);
        sum += v;
        low = std::min<double>(low, v);
        high = std::max<double>(high, v);
      }
    }
    char label[64];
    std::snprintf(label, sizeof label, "waveform %u mean over a full cycle", waveform);
    expectNear(label, sum / (static_cast<double>(steps) * cycles), 0.0, waveform == 5 ? 0.03 : 0.002);
    std::snprintf(label, sizeof label, "waveform %u reaches both rails", waveform);
    expectTrue(label, low >= -1.0001 && high <= 1.0001 && low < -0.9 && high > 0.9);
  }
  expectNear("sine starts at 0 (legacy shape)", AutoFilterKernel::lfo_shape(0, 0.0, 0), 0.0, 1.0e-6);
  expectNear("triangle starts at -1 (legacy shape)", AutoFilterKernel::lfo_shape(1, 0.0, 0), -1.0, 1.0e-6);
  expectTrue("saw down falls, saw up rises",
    AutoFilterKernel::lfo_shape(2, 0.25, 0) > AutoFilterKernel::lfo_shape(2, 0.75, 0)
      && AutoFilterKernel::lfo_shape(3, 0.25, 0) < AutoFilterKernel::lfo_shape(3, 0.75, 0));
  expectTrue("sample-and-hold is constant inside a cycle and changes between cycles",
    AutoFilterKernel::lfo_shape(5, 0.1, 7) == AutoFilterKernel::lfo_shape(5, 0.9, 7)
      && AutoFilterKernel::lfo_shape(5, 0.1, 7) != AutoFilterKernel::lfo_shape(5, 0.1, 8));
}

void tempoSync() {
  expectNear("1/4 note at 120 BPM is 2 Hz", AutoFilterKernel::sync_rate_hz(5, 120.0), 2.0, 1.0e-4);
  expectNear("2 bars at 120 BPM is 0.25 Hz", AutoFilterKernel::sync_rate_hz(0, 120.0), 0.25, 1.0e-4);
  expectNear("dotted 1/8 is 4/3 of the eighth rate", AutoFilterKernel::sync_rate_hz(7, 120.0) / AutoFilterKernel::sync_rate_hz(8, 120.0), 2.0 / 3.0 * 1.0, 1.0e-3);
  Rig rig;
  rig.config.sync = true;
  rig.config.division = 5;
  rig.values.frequency_hz = 1000.0F;
  rig.values.lfo_depth_octaves = 1.0F;
  rig.values.lfo_rate_hz = 7.0F;
  rig.run(std::vector<float>(12000, 0.0F));
  const float quarter = rig.kernel.cutoff_hz(0);
  rig.run(std::vector<float>(24000, 0.0F));
  expectNear("a synced LFO returns after 2 beats at 120 BPM (cutoff Hz)", rig.kernel.cutoff_hz(0), quarter, quarter * 0.02);
}

// With Sync on and the transport running, the LFO follows the song position, so where rendering starts does not matter.
void syncFollowsSongPosition() {
  constexpr size_t bar = 96000;  // 4 beats at 120 BPM and 48 kHz
  const auto cutoffAtBar3 = [&](size_t startBar) {
    Rig rig;
    rig.config.sync = true;
    rig.config.division = 5;
    rig.config.waveform = 5;  // sample and hold: the strictest shape, it also depends on the cycle count
    rig.values.frequency_hz = 1000.0F;
    rig.values.lfo_depth_octaves = 2.0F;
    rig.values.lfo_phase_offset = 0.3F;
    rig.transport.running = true;
    rig.transport.frame = static_cast<int64_t>(startBar * bar);
    rig.run(std::vector<float>((3 - startBar) * bar + 1000, 0.0F));
    return rig.kernel.cutoff_hz(0);
  };
  expectTrue("the cutoff at bar 3 is the same when rendering starts at bar 1 or bar 2 (Hz)", cutoffAtBar3(1) == cutoffAtBar3(2));
  expectTrue("it also matches a render that started at bar 0 (Hz)", cutoffAtBar3(0) == cutoffAtBar3(2));

  const auto rateAt = [&](double bpm) {
    Rig rig;
    rig.config.sync = true;
    rig.config.division = 5;
    rig.values.frequency_hz = 1000.0F;
    rig.values.lfo_depth_octaves = 1.0F;
    rig.transport = {.tempo_bpm = bpm, .frame = 7000, .running = true};
    rig.run(std::vector<float>(1, 0.0F));
    const float start = rig.kernel.cutoff_hz(0);
    // One beat later the sine is back where it started; half a beat later it is not.
    const size_t beat = static_cast<size_t>(std::llround(60.0 / bpm * rig.rate));
    rig.transport.frame = 7000 + static_cast<int64_t>(beat);
    rig.run(std::vector<float>(1, 0.0F));
    const float afterBeat = rig.kernel.cutoff_hz(0);
    rig.transport.frame = 7000 + static_cast<int64_t>(beat / 4);
    rig.run(std::vector<float>(1, 0.0F));
    return std::array<float, 3>{start, afterBeat, rig.kernel.cutoff_hz(0)};
  };
  const auto at90 = rateAt(90.0);
  expectNear("90 BPM: a 1/4-note LFO is back after one beat of 0.667 s (cutoff Hz)", at90[1], at90[0], at90[0] * 0.002);
  expectTrue("90 BPM: a quarter of a beat later it has moved", std::fabs(at90[2] - at90[0]) > at90[0] * 0.2);
  expectNear("tempo 90 gives 1.5 Hz for a 1/4 note", AutoFilterKernel::sync_rate_hz(5, 90.0), 1.5, 1.0e-4);

  Rig stopped;
  stopped.config.sync = true;
  stopped.config.division = 5;
  stopped.values.frequency_hz = 1000.0F;
  stopped.values.lfo_depth_octaves = 1.0F;
  stopped.transport.frame = 5000;
  stopped.run(std::vector<float>(6000, 0.0F));
  const float first = stopped.kernel.cutoff_hz(0);
  stopped.run(std::vector<float>(6000, 0.0F));
  expectTrue("a stopped transport leaves the synced LFO free-running", std::fabs(stopped.kernel.cutoff_hz(0) - first) > first * 0.05);
}

// Resonance 1, loud noise and a cutoff swept by an a-rate LFO at the fastest rate: the state guard must never be what keeps it finite.
void automationStability() {
  for (const bool hq : {false, true}) {
    for (const uint32_t slope : {0u, 1u}) {
      Rig rig;
      rig.config.hi_quality = hq;
      rig.config.slope = slope;
      rig.config.waveform = 4;  // square: the cutoff jumps three octaves every half cycle
      rig.values.frequency_hz = 200.0F;
      rig.values.resonance = 1.0F;
      rig.values.lfo_rate_hz = 20.0F;
      rig.values.lfo_depth_octaves = 3.0F;
      const auto out = rig.run(noise(4 * 48000, 2.0, 41));
      expectAtMost(hq ? (slope == 0 ? "hq 12 dB peak output under square cutoff automation at Q 8 (abs)" : "hq 24 dB peak output under square cutoff automation at Q 8 (abs)")
                      : (slope == 0 ? "12 dB peak output under square cutoff automation at Q 8 (abs)" : "24 dB peak output under square cutoff automation at Q 8 (abs)"),
        peakAbs(out), 200.0);
    }
  }
}

void envelopeInDb() {
  float previous = 0.0F;
  for (const double level : {-30.0, -20.0, -10.0}) {
    Rig rig;
    rig.values.frequency_hz = 1000.0F;
    rig.values.env_amount_octaves = 2.0F;
    rig.values.env_attack_ms = 1.0F;
    rig.values.env_release_ms = 50.0F;
    const double amplitude = std::pow(10.0, level / 20.0);
    rig.run(sine(24000, 1000.0, rig.rate, amplitude));
    const float cutoff = rig.kernel.cutoff_hz(0);
    const double expected = 1000.0 * std::pow(2.0, 2.0 * (level + 60.0) / 60.0);
    char label[96];
    std::snprintf(label, sizeof label, "envelope law at %.0f dBFS: cutoff vs 2 oct x (dB+60)/60 (Hz)", level);
    expectNear(label, cutoff, expected, expected * 0.08);
    expectTrue("envelope excursion rises with level", cutoff > previous);
    previous = cutoff;
  }
}

void envelopeLinkAndHold() {
  for (const bool link : {false, true}) {
    Rig rig;
    rig.config.env_link = link;
    rig.values.frequency_hz = 1000.0F;
    rig.values.env_amount_octaves = 2.0F;
    rig.values.env_attack_ms = 1.0F;
    for (size_t n = 0; n < 24000; ++n) {
      float l = 0.0F, r = 0.0F;
      rig.kernel.process(rig.values, rig.config, rig.transport, 0.0F, static_cast<float>(0.3 * std::sin(2.0 * kPi * 1000.0 * n / rig.rate)), 0.01F, l, r);
    }
    const double ratio = static_cast<double>(rig.kernel.cutoff_hz(0)) / rig.kernel.cutoff_hz(1);
    expectTrue(link ? "linked envelopes give identical cutoffs for L and R" : "unlinked envelopes follow each channel", link ? std::fabs(ratio - 1.0) < 1.0e-4 : ratio > 1.5);
  }
  Rig held, free;
  held.config.env_hold = true;
  for (Rig *rig : {&held, &free}) {
    rig->values.frequency_hz = 1000.0F;
    rig->values.env_amount_octaves = 3.0F;
    rig->values.env_attack_ms = 100.0F;
    rig->values.env_release_ms = 20.0F;
  }
  std::vector<float> burst = sine(2400, 1000.0, 48000.0, 0.5);
  burst.resize(9600, 0.0F);
  held.run(burst);
  free.run(burst);
  expectTrue("with hold the envelope finishes its attack before it releases", held.kernel.cutoff_hz(0) > free.kernel.cutoff_hz(0) * 1.05);
}

void stereoPhase() {
  Rig rig;
  rig.values.frequency_hz = 1000.0F;
  rig.values.lfo_depth_octaves = 1.0F;
  rig.values.lfo_rate_hz = 1.0F;
  rig.values.lfo_stereo_phase = 0.5F;
  rig.run(std::vector<float>(12000, 0.0F));
  expectNear("phase 180 deg: left and right are mirrored around the base cutoff", static_cast<double>(rig.kernel.cutoff_hz(0)) * rig.kernel.cutoff_hz(1), 1.0e6, 2.0e4);
  Rig spin;
  spin.config.stereo_mode = 1;
  spin.values.frequency_hz = 1000.0F;
  spin.values.lfo_depth_octaves = 1.0F;
  spin.values.lfo_rate_hz = 2.0F;
  spin.values.lfo_stereo_phase = 0.25F;
  spin.run(std::vector<float>(12000, 0.0F));
  const double ratio = static_cast<double>(spin.kernel.cutoff_hz(0)) / spin.kernel.cutoff_hz(1);
  expectTrue("spin detunes the two LFO rates so the channels drift apart", std::fabs(ratio - 1.0) > 0.05);
}

// ---- robustness and cost -------------------------------------------------------------------------------------------------------

void safety() {
  for (const bool hq : {false, true}) {
    Rig rig;
    rig.config.hi_quality = hq;
    rig.values.frequency_hz = 1000.0F;
    rig.values.resonance = 1.0F;
    rig.values.drive_db = 12.0F;
    std::vector<float> in = sine(4800, 440.0, rig.rate, 0.5);
    in[100] = std::numeric_limits<float>::quiet_NaN();
    in[200] = std::numeric_limits<float>::infinity();
    in.resize(4800 + 48000, 0.0F);
    const auto out = rig.run(in);
    size_t nonFinite = 0, subnormal = 0;
    for (size_t n = 0; n < out.size(); ++n) {
      nonFinite += std::isfinite(out[n]) ? 0 : 1;
      if (n > 4800 + 24000) subnormal += (out[n] != 0.0F && std::fabs(out[n]) < 1.0e-20F) ? 1 : 0;
    }
    expectAtMost(hq ? "hq non-finite output samples" : "non-finite output samples", static_cast<double>(nonFinite), 0.0);
    expectAtMost(hq ? "hq subnormal output samples after silence" : "subnormal output samples after silence", static_cast<double>(subnormal), 0.0);
  }
}

void cost() {
  for (const bool hq : {false, true}) {
    for (const uint32_t slope : {0u, 1u}) {
      Rig rig;
      rig.config.hi_quality = hq;
      rig.config.slope = slope;
      rig.values.drive_db = 6.0F;
      rig.values.frequency_hz = 1000.0F;
      rig.values.lfo_depth_octaves = 1.0F;
      const auto input = noise(48000, 0.3, 3);
      const auto start = std::chrono::steady_clock::now();
      for (int pass = 0; pass < 20; ++pass) rig.run(input);
      const double ns = std::chrono::duration<double, std::nano>(std::chrono::steady_clock::now() - start).count() / (20.0 * 48000.0);
      std::printf("  [info] cost.%s %u dB: %.1f ns per stereo frame\n", hq ? "hq" : "standard", slope == 0 ? 12u : 24u, ns);
    }
  }
}

struct Case {
  const char *group;
  const char *name;
  void (*run)();
};

const Case kCases[] = {
  {"clean", "cleanDriveZero", cleanDriveZero}, {"clean", "driveLevel", driveLevel}, {"alias", "aliasReduction", aliasReduction},
  {"latency", "latencyReported", latencyReported}, {"latency", "latencyAligned", latencyAligned},
  {"resonance", "resonanceMapping", resonanceMapping}, {"resonance", "resonanceLevel", resonanceLevel},
  {"resonance", "resonancePeakHeight", resonancePeakHeight}, {"resonance", "bandPassUnity", bandPassUnity},
  {"resonance", "clipAndOutput", clipAndOutput}, {"slope", "slopes", slopes},
  {"switch", "cutoffStepClick", cutoffStepClick}, {"switch", "switchClick", switchClick},
  {"modulation", "lfoShapes", lfoShapes}, {"modulation", "tempoSync", tempoSync}, {"modulation", "syncFollowsSongPosition", syncFollowsSongPosition}, {"modulation", "envelopeInDb", envelopeInDb},
  {"modulation", "envelopeLinkAndHold", envelopeLinkAndHold}, {"modulation", "stereoPhase", stereoPhase},
  {"safety", "safety", safety}, {"safety", "automationStability", automationStability}, {"cost", "cost", cost},
};

}  // namespace

int main(int argc, char **argv) {
  const char *group = argc > 1 ? argv[1] : nullptr;
  for (const Case &c : kCases) {
    if (group != nullptr && std::strcmp(group, c.group) != 0) continue;
    currentName = c.name;
    std::printf("%s/%s\n", c.group, c.name);
    c.run();
  }
  std::printf("%d failure(s)\n", failures);
  return failures == 0 ? 0 : 1;
}
