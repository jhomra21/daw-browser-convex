// Measurements for the Spectral kernel (src/spectral_kernel.h). Every case prints the number it checks.
// Run with a group name (gate, threshold, neutral, hpss, hpss-window, freeze, noise, shift, morph, cost) or with none for all.
#define DAW_SPECTRAL_TRACK_HPSS_WINDOW 1
#include "../src/spectral_kernel.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <functional>
#include <memory>
#include <vector>

namespace {

using namespace daw::audio_core;

constexpr double kRate = 48000.0;
constexpr std::array<uint32_t, 4> kSizes{512, 1024, 2048, 4096};
constexpr std::array<uint32_t, 2> kOverlaps{2, 4};

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

double toDb(double ratio) { return 20.0 * std::log10(std::max(ratio, 1.0e-15)); }

using Stereo = std::array<std::vector<float>, 2>;

struct Noise {
  uint32_t state;
  explicit Noise(uint32_t seed) : state(seed) {}
  double next() {
    state = state * 1664525U + 1013904223U;
    return static_cast<double>(state >> 8) / 8388608.0 - 1.0;
  }
};

std::vector<float> whiteNoise(size_t frames, double rms, uint32_t seed) {
  Noise noise(seed);
  std::vector<float> out(frames);
  for (float &sample : out) sample = static_cast<float>(noise.next() * rms * std::sqrt(3.0));
  return out;
}

// Paul Kellet's economy pink filter, scaled to an exact RMS.
std::vector<float> pinkNoise(size_t frames, double rms, uint32_t seed) {
  Noise noise(seed);
  double b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, energy = 0;
  std::vector<double> raw(frames);
  for (double &sample : raw) {
    const double white = noise.next();
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.96900 * b2 + white * 0.1538520;
    b3 = 0.86650 * b3 + white * 0.3104856;
    b4 = 0.55000 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.0168980;
    sample = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
    b6 = white * 0.115926;
    energy += sample * sample;
  }
  const double scale = rms / std::sqrt(energy / static_cast<double>(frames));
  std::vector<float> out(frames);
  for (size_t index = 0; index < frames; ++index) out[index] = static_cast<float>(raw[index] * scale);
  return out;
}

std::vector<float> sine(size_t frames, double hertz, double amplitude) {
  std::vector<float> out(frames);
  for (size_t index = 0; index < frames; ++index)
    out[index] = static_cast<float>(amplitude * std::sin(2.0 * kSpectralPi * hertz * static_cast<double>(index) / kRate));
  return out;
}

Stereo both(const std::vector<float> &signal) { return {signal, signal}; }

std::vector<float> sum(const std::vector<float> &a, const std::vector<float> &b) {
  std::vector<float> out(a.size());
  for (size_t index = 0; index < a.size(); ++index) out[index] = a[index] + b[index];
  return out;
}

double rms(const std::vector<double> &x, size_t begin, size_t end) {
  double energy = 0;
  for (size_t index = begin; index < end; ++index) energy += x[index] * x[index];
  return std::sqrt(energy / static_cast<double>(end - begin));
}
double rms(const std::vector<float> &x, size_t begin, size_t end) {
  double energy = 0;
  for (size_t index = begin; index < end; ++index) energy += static_cast<double>(x[index]) * x[index];
  return std::sqrt(energy / static_cast<double>(end - begin));
}

// Amplitude of the component at hertz; the span must hold whole periods.
double toneAmplitude(const std::vector<double> &x, size_t begin, size_t end, double hertz) {
  double cosine = 0, sine = 0;
  for (size_t index = begin; index < end; ++index) {
    const double angle = 2.0 * kSpectralPi * hertz * static_cast<double>(index) / kRate;
    cosine += x[index] * std::cos(angle);
    sine += x[index] * std::sin(angle);
  }
  return 2.0 * std::hypot(cosine, sine) / static_cast<double>(end - begin);
}

// Hann-windowed power spectrum of x[begin, begin + n) by direct summation, bin width kRate / n.
std::vector<double> powerSpectrum(const std::vector<double> &x, size_t begin, size_t n) {
  std::vector<double> cosine(n), sine(n), windowed(n), power(n / 2 + 1);
  for (size_t index = 0; index < n; ++index) {
    cosine[index] = std::cos(2.0 * kSpectralPi * static_cast<double>(index) / static_cast<double>(n));
    sine[index] = std::sin(2.0 * kSpectralPi * static_cast<double>(index) / static_cast<double>(n));
    windowed[index] = x[begin + index] * (0.5 - 0.5 * cosine[index]);
  }
  for (size_t bin = 0; bin <= n / 2; ++bin) {
    double re = 0, im = 0;
    for (size_t index = 0; index < n; ++index) {
      const size_t at = (bin * index) % n;
      re += windowed[index] * cosine[at];
      im -= windowed[index] * sine[at];
    }
    power[bin] = re * re + im * im;
  }
  return power;
}

// One kernel with the stores a stage keeps, fed a whole signal frame by frame the way the stage will feed it.
struct Rig {
  std::unique_ptr<SpectralKernel> kernel = std::make_unique<SpectralKernel>();
  std::array<std::vector<float>, 7> planes[2];
  std::array<SpectralChannelStore, 2> stores{};
  std::array<bool, 2> captured{};
  std::array<uint32_t, 2> noiseFrames{};
  uint32_t size = 0, overlap = 0;

  Rig(uint32_t fftSize, uint32_t overlapCount) : size(fftSize), overlap(overlapCount) {
    kernel->prepare(fftSize, overlapCount);
    for (uint32_t channel = 0; channel < 2; ++channel) {
      for (auto &plane : planes[channel]) plane.assign(kSpectralBinsMax, 0.0F);
      std::fill(planes[channel][3].begin(), planes[channel][3].end(), 1.0F);
      stores[channel] = {planes[channel][0].data(), planes[channel][1].data(), planes[channel][2].data(), planes[channel][3].data(),
        planes[channel][4].data(), &captured[channel], &noiseFrames[channel]};
    }
  }

  // The output sample i is complete once the frame starting at or before i has run: it holds the input at i, with no latency.
  std::array<std::vector<double>, 2> run(const Stereo &input, const Stereo &sidechain, SpectralControls controls,
    const std::function<void(uint32_t, SpectralControls &)> &adjust = {}) {
    const size_t total = input[0].size();
    size_t ring = 1;
    while (ring < total) ring <<= 1u;
    Stereo in{input[0], input[1]}, side{sidechain[0], sidechain[1]};
    for (auto &plane : in) plane.resize(ring);
    for (auto &plane : side) plane.resize(ring);
    std::array<std::vector<double>, 2> out{std::vector<double>(ring), std::vector<double>(ring)};
    const uint32_t hop = size / overlap;
    SpectralFrameIo io;
    io.input = {in[0].data(), in[1].data()};
    io.sidechain = {side[0].data(), side[1].data()};
    io.input_mask = static_cast<uint32_t>(ring - 1);
    io.output = {out[0].data(), out[1].data()};
    io.output_mask = static_cast<uint32_t>(ring - 1);
    uint32_t frame = 0;
    for (size_t position = 0; position + size <= total; position += hop, ++frame) {
      io.input_start = io.output_start = static_cast<uint32_t>(position);
      if (adjust) adjust(frame, controls);
      kernel->process(io, controls, stores);
    }
    out[0].resize(total);
    out[1].resize(total);
    return out;
  }
};

double identityErrorDb(const std::array<std::vector<double>, 2> &out, const Stereo &in, uint32_t size) {
  double worst = 0;
  for (uint32_t channel = 0; channel < 2; ++channel)
    for (size_t index = size; index + size < in[channel].size(); ++index)
      worst = std::max(worst, std::fabs(out[channel][index] - static_cast<double>(in[channel][index])));
  return toDb(worst);
}

Stereo stereoNoise(size_t frames, double rmsLevel) { return {whiteNoise(frames, rmsLevel, 11), whiteNoise(frames, rmsLevel, 29)}; }

// An open gate must be the identity: the threshold sits far below everything, including the rounding noise of the input.
void gate() {
  currentName = "gate";
  for (const uint32_t size : kSizes) {
    for (const uint32_t overlap : kOverlaps) {
      Rig rig(size, overlap);
      SpectralControls controls;
      controls.mode = SpectralMode::Gate;
      controls.gate_threshold_db = -200.0;
      const Stereo input = both(sine(size * 16, 1000.0, 0.5));
      char name[48];
      std::snprintf(name, sizeof name, "open_error_db_N%u_ov%u", size, overlap);
      expectAtMost(name, identityErrorDb(rig.run(input, input, controls), input, size), -130.0);
    }
  }
}

// P1: the threshold is in dBFS of a sine, whatever the FFT size.
void threshold() {
  currentName = "threshold";
  for (const uint32_t size : kSizes) {
    for (const double thresholdDb : {-45.0, -35.0}) {
      Rig rig(size, 4);
      SpectralControls controls;
      controls.mode = SpectralMode::Gate;
      controls.gate_threshold_db = thresholdDb;
      controls.gate_attack_ms = 1.0;
      controls.gate_release_ms = 10.0;
      const size_t total = static_cast<size_t>(size) * 24;
      const Stereo input = both(sine(total, 1000.0, 0.01));
      const auto out = rig.run(input, input, controls);
      const double gainDb = toDb(rms(out[0], total - size * 4, total - size) / rms(input[0], total - size * 4, total - size));
      char name[48];
      std::snprintf(name, sizeof name, "%s_N%u", thresholdDb < -40.0 ? "open_gain_db" : "closed_gain_db", size);
      if (thresholdDb < -40.0) expectNear(name, gainDb, 0.0, 0.1);
      else expectAtMost(name, gainDb, -60.0);
    }
  }
}

// Every mode at its neutral setting passes two different noises unchanged.
void neutral() {
  currentName = "neutral";
  struct Case { const char *name; SpectralMode mode; };
  for (const Case &item : {Case{"freeze_off", SpectralMode::Freeze}, Case{"morph_0", SpectralMode::Morph},
         Case{"shift_0_blur_0", SpectralMode::ShiftBlur}, Case{"hpss_0", SpectralMode::Hpss},
         Case{"noise_unlearned", SpectralMode::NoiseReduce}}) {
    for (const uint32_t size : kSizes) {
      for (const uint32_t overlap : kOverlaps) {
        Rig rig(size, overlap);
        SpectralControls controls;
        controls.mode = item.mode;
        const Stereo input = stereoNoise(static_cast<size_t>(size) * 40, 0.1);
        char name[64];
        std::snprintf(name, sizeof name, "%s_error_db_N%u_ov%u", item.name, size, overlap);
        expectAtMost(name, identityErrorDb(rig.run(input, input, controls), input, size), -130.0);
      }
    }
  }
}

// P2: soft masks, the knob is a gain crossfade between the stems.
void hpss() {
  currentName = "hpss";
  for (const uint32_t size : kSizes) {
    const uint32_t hop = size / 4;
    const size_t total = size + static_cast<size_t>(hop) * 96;
    {
      Rig rig(size, 4);
      SpectralControls controls;
      controls.mode = SpectralMode::Hpss;
      const Stereo tone = both(sine(total, 1000.0, 0.3));
      const Stereo noise = stereoNoise(total, 0.1);
      const auto toneOut = rig.run(tone, tone, controls);
      Rig noiseRig(size, 4);
      const auto noiseOut = noiseRig.run(noise, noise, controls);
      char name[48];
      std::snprintf(name, sizeof name, "sine_gain_db_N%u", size);
      expectNear(name, toDb(rms(toneOut[0], total / 2, total - size) / rms(tone[0], total / 2, total - size)), 0.0, 0.3);
      std::snprintf(name, sizeof name, "noise_gain_db_N%u", size);
      expectNear(name, toDb(rms(noiseOut[0], total / 2, total - size) / rms(noise[0], total / 2, total - size)), 0.0, 0.3);
    }
  }
  // Balance -1 keeps the percussive stem: a click train over a sine loses the sine and keeps the clicks.
  const uint32_t size = 2048;
  const size_t total = 48000 * 6;
  std::vector<float> clicks(total), clean = sine(total, 1000.0, 0.3);
  for (size_t at = 12000; at + 64 < total; at += 12000) clicks[at] = 0.5F;
  Rig rig(size, 4);
  SpectralControls controls;
  controls.mode = SpectralMode::Hpss;
  controls.hpss_balance = -1.0;
  const Stereo input = both(sum(clicks, clean));
  const auto out = rig.run(input, input, controls);
  const size_t begin = 12000 * 3 + 6000;  // between two clicks, clear of both
  const double sineLeftDb = toDb(rms(out[0], begin, begin + 6000) / rms(clean, begin, begin + 6000));
  expectAtMost("sine_suppression_db", sineLeftDb, -20.0);
  double kept = 0, original = 0;
  for (size_t at = 12000 * 3; at <= 12000 * 4; at += 12000) {
    for (size_t index = at - 8; index <= at + 8; ++index) {
      kept += out[0][index] * out[0][index];
      original += static_cast<double>(clicks[index]) * clicks[index];
    }
  }
  expectNear("click_energy_db", 10.0 * std::log10(kept / original), 0.0, 3.0);
  // The stems add back to the input.
  Rig harmonicRig(size, 4);
  controls.hpss_balance = 1.0;
  const auto harmonic = harmonicRig.run(input, input, controls);
  double worst = 0;
  for (size_t index = size; index + size < total; ++index)
    worst = std::max(worst, std::fabs(out[0][index] + harmonic[0][index] - static_cast<double>(input[0][index])));
  expectAtMost("stems_sum_error_db", toDb(worst), -130.0);
}

// The percussive median window holds one value more than its width while the entering bin is inserted. Every FFT size has more
// bins than the window is wide, so each one reaches the window's edge. Under AddressSanitizer an overrun aborts the run.
void hpssWindow() {
  currentName = "hpss_window";
  for (const uint32_t size : kSizes) {
    Rig rig(size, 4);
    SpectralControls controls;
    controls.mode = SpectralMode::Hpss;
    const size_t total = size + static_cast<size_t>(size / 4) * 4;
    const Stereo noise = stereoNoise(total, 0.1);
    rig.run(noise, noise, controls);
    char name[48];
    std::snprintf(name, sizeof name, "window_peak_N%u", size);
    expectAtMost(name, rig.kernel->hpss_window_peak(), kSpectralHpssWindowCapacity);
    std::snprintf(name, sizeof name, "window_reaches_capacity_N%u", size);
    expectAtLeast(name, rig.kernel->hpss_window_peak(), kSpectralHpssWindowCapacity);
  }
}

// P3: a frozen sine stays one steady partial at its own frequency.
void freeze() {
  currentName = "freeze";
  for (const uint32_t size : kSizes) {
    for (const uint32_t overlap : kOverlaps) {
      Rig rig(size, overlap);
      SpectralControls controls;
      controls.mode = SpectralMode::Freeze;
      const uint32_t hop = size / overlap;
      const uint32_t engage = size / hop * 4;
      const size_t total = std::max<size_t>(static_cast<size_t>(size) * 20, 48000);
      const Stereo input = both(sine(total, 1000.0, 0.5));
      const auto out = rig.run(input, input, controls, [&](uint32_t frame, SpectralControls &c) { c.freeze = frame >= engage; });
      // The sliding RMS over exactly one period (48 samples) is flat for a steady sinusoid.
      double low = 1e9, high = 0;
      for (size_t at = static_cast<size_t>(engage) * hop + size * 3; at + 48 + size < total; at += 8) {
        const double level = rms(out[0], at, at + 48);
        low = std::min(low, level);
        high = std::max(high, level);
      }
      char name[48];
      std::snprintf(name, sizeof name, "ripple_db_N%u_ov%u", size, overlap);
      expectAtMost(name, toDb(high / low), 0.1);
      std::snprintf(name, sizeof name, "level_db_N%u_ov%u", size, overlap);
      expectNear(name, toDb(high * std::sqrt(2.0) / 0.5), 0.0, 1.0);
    }
  }
  Rig rig(2048, 4);
  SpectralControls controls;
  controls.mode = SpectralMode::Freeze;
  const size_t total = 48000 * 2;
  const Stereo input = both(sine(total, 1000.0, 0.5));
  const auto out = rig.run(input, input, controls, [](uint32_t frame, SpectralControls &c) { c.freeze = frame >= 16; });
  const auto power = powerSpectrum(out[0], total - 16384, 16384);
  size_t peak = 0;
  double all = 0, near = 0;
  for (size_t bin = 0; bin < power.size(); ++bin) {
    all += power[bin];
    if (power[bin] > power[peak]) peak = bin;
  }
  const double width = kRate / 16384.0;
  for (size_t bin = 0; bin < power.size(); ++bin)
    if (std::fabs(static_cast<double>(bin) * width - 1000.0) <= 50.0) near += power[bin];
  expectNear("peak_hz", static_cast<double>(peak) * width, 1000.0, 2.0);
  expectAtLeast("energy_within_50hz", near / all, 0.999);
}

// P4: Learn captures the noise while it is on; afterwards the noise is reduced and a tone survives.
void noise() {
  currentName = "noise";
  const uint32_t size = 2048;
  SpectralControls learn;
  learn.mode = SpectralMode::NoiseReduce;
  learn.learn = true;
  SpectralControls reduce;
  reduce.mode = SpectralMode::NoiseReduce;
  reduce.noise_reduction = 1.0;
  const size_t learned = 48000 * 2, tested = 48000;
  Rig rig(size, 4);
  const Stereo training{pinkNoise(learned, 0.01, 3), pinkNoise(learned, 0.01, 5)};
  rig.run(training, training, learn);
  const Stereo fresh{pinkNoise(tested, 0.01, 7), pinkNoise(tested, 0.01, 9)};
  const auto cleaned = rig.run(fresh, fresh, reduce);
  expectAtMost("reduction_db", toDb(rms(cleaned[0], size * 8, tested - size) / rms(fresh[0], size * 8, tested - size)), -20.0);
  const Stereo tone{sum(fresh[0], sine(tested, 1000.0, 0.0316228)), sum(fresh[1], sine(tested, 1000.0, 0.0316228))};
  Rig toneRig(size, 4);
  toneRig.run(training, training, learn);
  const auto kept = toneRig.run(tone, tone, reduce);
  expectNear("tone_change_db", toDb(toneAmplitude(kept[0], 24000, 48000 - 24000 % 48 - 0, 1000.0) / 0.0316228), 0.0, 1.0);
  // Musical noise shows as bins that flicker: the spread of each bin's magnitude over time relative to its mean.
  const auto flicker = [&](const std::vector<double> &x) {
    constexpr size_t frame = 512, hop = 256, bins = frame / 2 + 1;
    std::vector<double> mean(bins), square(bins);
    size_t count = 0;
    for (size_t at = size * 8; at + frame < tested - size; at += hop, ++count) {
      const auto power = powerSpectrum(x, at, frame);
      for (size_t bin = 0; bin < bins; ++bin) {
        const double magnitude = std::sqrt(power[bin]);
        mean[bin] += magnitude;
        square[bin] += magnitude * magnitude;
      }
    }
    double variation = 0;
    for (size_t bin = 4; bin < bins - 4; ++bin) {
      const double average = mean[bin] / static_cast<double>(count);
      variation += std::sqrt(std::max(square[bin] / static_cast<double>(count) - average * average, 0.0)) / average;
    }
    return variation / static_cast<double>(bins - 8);
  };
  expectAtMost("residual_variation", flicker(cleaned[0]), 0.94);
  // Learn off and never learned: nothing to subtract.
  Rig blank(size, 4);
  expectAtMost("unlearned_error_db", identityErrorDb(blank.run(fresh, fresh, reduce), fresh, size), -130.0);
}

// P5: Shift moves a sinusoid and keeps it one partial.
void shift() {
  currentName = "shift";
  const uint32_t size = 2048;
  Rig rig(size, 4);
  SpectralControls controls;
  controls.mode = SpectralMode::ShiftBlur;
  controls.bin_shift = 10.0;
  const size_t total = size * 24;
  const Stereo input = both(sine(total, 1000.0, 0.5));
  const auto out = rig.run(input, input, controls);
  const size_t length = 16384;
  const auto power = powerSpectrum(out[0], total - size * 2 - length, length);
  size_t peak = 0;
  double all = 0;
  for (size_t bin = 0; bin < power.size(); ++bin) {
    all += power[bin];
    if (power[bin] > power[peak]) peak = bin;
  }
  const double width = kRate / static_cast<double>(length);
  const double expected = 1000.0 + 10.0 * kRate / size;
  // Parabolic interpolation of the log peak refines the frequency below the bin width.
  const double left = std::log(power[peak - 1]), centre = std::log(power[peak]), right = std::log(power[peak + 1]);
  const double refined = (static_cast<double>(peak) + 0.5 * (left - right) / (left - 2.0 * centre + right)) * width;
  expectNear("peak_hz", refined, expected, 5.0);
  double near = 0;
  for (size_t bin = 0; bin < power.size(); ++bin)
    if (std::fabs(static_cast<double>(bin) * width - expected) <= 4.0 * kRate / size) near += power[bin];
  expectAtLeast("energy_within_4_bins", near / all, 0.9);
}

// Morph keeps the input's phase and takes the sidechain's magnitude.
void morph() {
  currentName = "morph";
  const uint32_t size = 2048;
  Rig rig(size, 4);
  SpectralControls controls;
  controls.mode = SpectralMode::Morph;
  controls.morph = 1.0;
  const size_t total = size * 16;
  const Stereo input = both(sine(total, 1000.0, 0.5)), side = both(sine(total, 1000.0, 0.25));
  const auto out = rig.run(input, side, controls);
  const size_t begin = size * 4, end = begin + 48 * 100;
  expectNear("amplitude_db", toDb(toneAmplitude(out[0], begin, end, 1000.0) / 0.25), 0.0, 0.5);
}

// P6: cost of one stereo frame per mode. Asserted only in optimised builds.
void cost() {
  currentName = "cost";
  for (const uint32_t size : kSizes) {
    for (const SpectralMode mode : {SpectralMode::Freeze, SpectralMode::Hpss, SpectralMode::NoiseReduce, SpectralMode::ShiftBlur}) {
      Rig rig(size, 4);
      SpectralControls controls;
      controls.mode = mode;
      controls.freeze = true;
      const size_t total = size + static_cast<size_t>(size / 4) * 160;
      const Stereo input = stereoNoise(total, 0.1);
      if (mode == SpectralMode::NoiseReduce) {
        SpectralControls learn = controls;
        learn.learn = true;
        rig.run(input, input, learn);
      }
      const auto begin = std::chrono::steady_clock::now();
      rig.run(input, input, controls);
      const double micros = std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - begin).count() / 161.0;
      char name[64];
      std::snprintf(name, sizeof name, "frame_us_mode%u_N%u", static_cast<uint32_t>(mode), size);
      if (mode == SpectralMode::Hpss && size == 4096) {
#if defined(__OPTIMIZE__)
        expectAtMost(name, micros, 600.0);
#else
        std::printf("  [info] %s.%s measured=%.6g (unoptimised, not asserted)\n", currentName, name, micros);
#endif
      } else std::printf("  [info] %s.%s measured=%.6g\n", currentName, name, micros);
    }
  }
}

}  // namespace

int main(int argc, char **argv) {
  struct Group { const char *name; void (*run)(); };
  const Group groups[] = {{"gate", gate}, {"threshold", threshold}, {"neutral", neutral}, {"hpss", hpss}, {"hpss-window", hpssWindow}, {"freeze", freeze},
    {"noise", noise}, {"shift", shift}, {"morph", morph}, {"cost", cost}};
  bool ran = false;
  for (const Group &group : groups) {
    if (argc > 1 && std::strcmp(argv[1], group.name) != 0) continue;
    group.run();
    ran = true;
  }
  if (!ran) {
    std::printf("unknown group\n");
    return 2;
  }
  std::printf(failures == 0 ? "ok\n" : "%d failure(s)\n", failures);
  return failures == 0 ? 0 : 1;
}
