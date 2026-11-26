// Measurements for the Chorus/Flanger, Ensemble and Phaser kernels. Every case prints the number it checks.
// Run with a group name (loop, level, feedback, latency, safety) or with none for all.
#include "../src/chorus_kernel.h"
#include "../src/ensemble_kernel.h"
#include "../src/phaser_kernel.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <vector>

namespace {

using namespace daw::audio_core;

int failures = 0;
const char *currentName = "";

void report(const char *what, bool ok, double measured, const char *relation, double limit) {
  std::printf("  [%s] %s.%s measured=%.6g %s %.6g\n", ok ? "pass" : "FAIL", currentName, what, measured, relation, limit);
  if (!ok) ++failures;
}
void expectAtMost(const char *what, double measured, double limit) { report(what, measured <= limit, measured, "<=", limit); }
void expectNear(const char *what, double measured, double expected, double tolerance) {
  report(what, std::fabs(measured - expected) <= tolerance, measured, "~", expected);
}
void expectTrue(const char *what, bool ok) { report(what, ok, ok ? 1.0 : 0.0, "==", 1.0); }

double toDb(double ratio) { return 20.0 * std::log10(std::max(ratio, 1.0e-12)); }

struct Noise {
  uint32_t state = 12345;
  float next() {
    state = state * 1664525U + 1013904223U;
    return static_cast<float>(state >> 8) / 8388608.0F - 1.0F;
  }
};

// Flanger loop length: a fixed delay with feedback echoes at exactly that many frames.
void loop() {
  currentName = "loop";
  for (const double rate : {44100.0, 48000.0, 96000.0}) {
    for (const float ms : {0.5F, 1.0F, 1.5F}) {
      ChorusKernel kernel;
      kernel.prepare(rate);
      ChorusValues values;
      values.delay_ms = ms;
      values.depth_ms = 0.0F;
      values.feedback = 0.5F;
      values.mix = 1.0F;
      ChorusConfig config;
      config.mode = ChorusMode::Flanger;
      std::vector<float> out(4000);
      for (size_t i = 0; i < out.size(); ++i) {
        float left, right;
        kernel.process(values, config, 0.0F, i == 0 ? 1.0F : 0.0F, 0.0F, left, right);
        out[i] = left;
      }
      // Echo centre of mass of the first two peaks; their spacing is the loop length.
      const double expected = ms * 0.001 * rate;
      auto centroid = [&](size_t from, size_t to) {
        double sum = 0.0, weight = 0.0;
        for (size_t i = from; i < to; ++i) { sum += i * out[i]; weight += out[i]; }
        return sum / weight;
      };
      const size_t half = static_cast<size_t>(expected) + 1;
      const double first = centroid(half / 2, half + half / 2);
      const double second = centroid(half + half / 2, 2 * half + half / 2 + 1);
      static char label[64];
      std::snprintf(label, sizeof label, "loop_%.0fhz_%.1fms_error_frames", rate, ms);
      expectNear(label, second - first, expected, 0.05);
    }
  }
}

// White noise through a mix=1 Ensemble keeps its level (uncorrelated voices, 1/sqrt(3) per voice). Hermite reads at
// fractional delays low-pass white noise slightly, which is the remaining 0.86 dB.
void level() {
  currentName = "level";
  EnsembleKernel kernel;
  kernel.prepare(48000.0);
  EnsembleValues values;
  values.mix = 1.0F;
  EnsembleConfig config;
  Noise noise;
  double wet = 0.0, dry = 0.0;
  for (int i = 0; i < 48000 * 6; ++i) {
    const float x = 0.3F * noise.next();
    float left, right;
    kernel.process(values, config, 0.0F, x, x, left, right);
    if (i > 4800) { wet += left * left; dry += x * x; }
  }
  expectNear("noise_level_db", toDb(std::sqrt(wet / dry)), 0.0, 1.0);
}

// Phaser feedback near 1 stays within 12 dB of the input.
void feedback() {
  currentName = "feedback";
  for (const float fb : {0.5F, 0.95F, -0.95F}) {
    PhaserKernel kernel;
    kernel.prepare(48000.0);
    PhaserValues values;
    values.feedback = fb;
    values.mix = 1.0F;
    PhaserConfig config;
    double peakIn = 0.0, peakOut = 0.0;
    for (int i = 0; i < 48000 * 3; ++i) {
      const float x = 0.25F * std::sin(0.13F * static_cast<float>(i));
      float left, right;
      kernel.process(values, config, 0.0F, x, x, left, right);
      peakIn = std::max<double>(peakIn, std::fabs(x));
      peakOut = std::max<double>(peakOut, std::fabs(left));
    }
    static char label[48];
    std::snprintf(label, sizeof label, "peak_gain_db_fb_%.2f", fb);
    expectAtMost(label, toDb(peakOut / peakIn), 12.0);
  }
}

void latency() {
  currentName = "latency";
  expectTrue("through_zero_declares_dry_delay", ChorusKernel::latency_frames(ChorusMode::ThroughZero, 48000.0) == 240U);
  expectTrue("other_modes_declare_none", ChorusKernel::latency_frames(ChorusMode::Flanger, 48000.0) == 0U);
  ChorusKernel kernel;
  kernel.prepare(48000.0);
  ChorusValues values;
  values.mix = 0.0F;
  ChorusConfig config;
  config.mode = ChorusMode::ThroughZero;
  size_t peak = 0;
  float best = 0.0F;
  for (size_t i = 0; i < 600; ++i) {
    float left, right;
    kernel.process(values, config, 0.0F, i == 0 ? 1.0F : 0.0F, 0.0F, left, right);
    if (std::fabs(left) > best) { best = std::fabs(left); peak = i; }
  }
  expectTrue("dry_appears_at_declared_latency", peak == 240U);
}

void safety() {
  currentName = "safety";
  ChorusKernel chorus;
  chorus.prepare(48000.0);
  PhaserKernel phaser;
  phaser.prepare(48000.0);
  ChorusValues cv;
  cv.feedback = 0.95F;
  PhaserValues pv;
  pv.feedback = 0.99F;
  ChorusConfig cc;
  cc.mode = ChorusMode::Vintage;
  PhaserConfig pc;
  pc.stages = 12;
  bool finite = true;
  Noise noise;
  for (int i = 0; i < 48000 * 2; ++i) {
    const float x = i == 1000 ? INFINITY : noise.next();
    float a, b, c, d;
    chorus.process(cv, cc, 0.0F, x, x, a, b);
    phaser.process(pv, pc, 0.0F, x, x, c, d);
    finite = finite && std::isfinite(a) && std::isfinite(b) && std::isfinite(c) && std::isfinite(d);
  }
  expectTrue("output_stays_finite_with_infinite_input", finite);
}

}  // namespace

int main(int argc, char **argv) {
  struct Group { const char *name; void (*run)(); };
  const Group groups[] = {{"loop", loop}, {"level", level}, {"feedback", feedback}, {"latency", latency}, {"safety", safety}};
  for (const Group &group : groups) {
    if (argc > 1 && std::strcmp(argv[1], group.name) != 0) continue;
    group.run();
  }
  std::printf("%d failure(s)\n", failures);
  return failures == 0 ? 0 : 1;
}
