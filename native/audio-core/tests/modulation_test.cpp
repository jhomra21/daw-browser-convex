// Measurements for the Chorus/Flanger, Ensemble, Phaser, Tremolo and Auto Pan kernels. Every case prints the number it checks.
// Run with a group name (loop, level, feedback, latency, safety, stereo, average, pan, sync, click) or with none for all.
#include "../src/amplitude_modulation_kernel.h"
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

// Gain envelopes of a Tremolo or Auto Pan: the kernel fed a constant 1 on both channels.
struct Envelope {
  std::vector<float> left, right;
};

Envelope envelope(const AmplitudeValues &values, const AmplitudeConfig &config, int frames, double rate = 48000.0,
  const dsp::LfoTransport &transport = {}) {
  AmplitudeModulationKernel kernel;
  kernel.prepare(rate);
  Envelope out;
  for (int i = 0; i < frames; ++i) {
    dsp::LfoTransport at = transport;
    at.frame += i;
    float left, right;
    kernel.process(values, config, at, 0.0F, 1.0F, 1.0F, left, right);
    out.left.push_back(left);
    out.right.push_back(right);
  }
  return out;
}

double correlation(const std::vector<float> &a, const std::vector<float> &b) {
  double meanA = 0.0, meanB = 0.0;
  for (size_t i = 0; i < a.size(); ++i) { meanA += a[i]; meanB += b[i]; }
  meanA /= a.size();
  meanB /= b.size();
  double ab = 0.0, aa = 0.0, bb = 0.0;
  for (size_t i = 0; i < a.size(); ++i) {
    ab += (a[i] - meanA) * (b[i] - meanB);
    aa += (a[i] - meanA) * (a[i] - meanA);
    bb += (b[i] - meanB) * (b[i] - meanB);
  }
  return ab / std::sqrt(aa * bb);
}

double mean(const std::vector<float> &x) {
  double sum = 0.0;
  for (const float v : x) sum += v;
  return sum / x.size();
}

// Stereo Phase moves the right LFO only: half a cycle puts the two gain envelopes in antiphase, none leaves them equal,
// and Phase moves both channels together.
void stereo() {
  currentName = "stereo";
  AmplitudeValues values;
  values.rate_hz = 4.0F;
  values.depth = 1.0F;
  AmplitudeConfig config;
  const int frames = 48000;
  values.stereo_phase = 0.5F;
  Envelope half = envelope(values, config, frames);
  expectAtMost("antiphase_correlation", correlation(half.left, half.right), -0.99);
  values.stereo_phase = 0.0F;
  Envelope none = envelope(values, config, frames);
  double worst = 0.0;
  for (int i = 0; i < frames; ++i) worst = std::max<double>(worst, std::fabs(none.left[i] - none.right[i]));
  expectAtMost("zero_stereo_phase_max_difference", worst, 1.0e-6);
  values.phase = 0.3F;
  Envelope shifted = envelope(values, config, frames);
  worst = 0.0;
  for (int i = 0; i < frames; ++i) worst = std::max<double>(worst, std::fabs(shifted.left[i] - shifted.right[i]));
  expectAtMost("phase_moves_both_channels_max_difference", worst, 1.0e-6);
  expectTrue("phase_moves_the_start", std::fabs(shifted.left[0] - none.left[0]) > 0.1);
}

// Tremolo keeps its average gain at 1 whatever Depth and Shape are, for every waveform with a known distribution.
void average() {
  currentName = "average";
  AmplitudeValues values;
  values.rate_hz = 4.0F;
  for (const uint32_t waveform : {0U, 1U, 2U, 3U}) {
    double worst = 0.0;
    for (const float depth : {0.0F, 0.25F, 0.5F, 1.0F}) {
      for (const float shape : {0.2F, 0.5F, 0.8F}) {
        values.depth = depth;
        values.shape = shape;
        AmplitudeConfig config;
        config.waveform = waveform;
        const Envelope e = envelope(values, config, 48000);
        worst = std::max(worst, std::fabs(mean(e.left) - 1.0));
      }
    }
    static char label[48];
    std::snprintf(label, sizeof label, "waveform_%u_mean_gain_error", waveform);
    expectAtMost(label, worst, 0.004);
  }
  values.depth = 0.0F;
  const Envelope off = envelope(values, AmplitudeConfig{}, 4800);
  double worst = 0.0;
  for (const float g : off.left) worst = std::max<double>(worst, std::fabs(g - 1.0F));
  expectAtMost("depth_zero_is_unity", worst, 1.0e-6);
  values.depth = 1.0F;
  values.shape = 0.5F;
  AmplitudeConfig triangle;
  triangle.waveform = 1;
  const Envelope tri = envelope(values, triangle, 12000);
  float low = 10.0F, high = 0.0F;
  for (const float g : tri.left) { low = std::min(low, g); high = std::max(high, g); }
  expectAtMost("depth_one_reaches_silence", low, 0.01);
  expectNear("depth_one_peak_gain", high, 2.0, 0.01);
}

// Auto Pan is equal power: left and right gains keep a constant power sum, -3 dB in the centre and 0 / -inf at the sides.
void pan() {
  currentName = "pan";
  AmplitudeConfig config;
  config.kind = AmplitudeKind::AutoPan;
  AmplitudeValues values;
  values.depth = 0.0F;
  Envelope centre = envelope(values, config, 100);
  expectNear("centre_gain_db_left", toDb(centre.left.back()), -3.0103, 0.02);
  expectNear("centre_gain_db_right", toDb(centre.right.back()), -3.0103, 0.02);
  values.depth = 1.0F;
  values.rate_hz = 1.0F;
  config.waveform = 1;
  Envelope sweep = envelope(values, config, 48000);
  double worst = 0.0, lowest = 10.0, highest = 0.0, hardest = 10.0;
  for (size_t i = 0; i < sweep.left.size(); ++i) {
    const double power = sweep.left[i] * sweep.left[i] + sweep.right[i] * sweep.right[i];
    worst = std::max(worst, std::fabs(toDb(std::sqrt(power))));
    lowest = std::min<double>(lowest, sweep.left[i]);
    highest = std::max<double>(highest, sweep.left[i]);
    hardest = std::min<double>(hardest, sweep.right[i]);
  }
  expectAtMost("power_sum_deviation_db", worst, 0.02);
  expectNear("hard_right_left_gain", lowest, 0.0, 1.0e-3);
  expectNear("hard_left_left_gain", highest, 1.0, 1.0e-3);
  expectNear("hard_left_right_gain", hardest, 0.0, 1.0e-3);
  // Half a cycle of Stereo Phase mirrors the right LFO, which makes both channels' pan angles mirror images: equal gains.
  values.stereo_phase = 0.5F;
  const Envelope mirrored = envelope(values, config, 48000);
  worst = 0.0;
  for (size_t i = 0; i < mirrored.left.size(); ++i) worst = std::max<double>(worst, std::fabs(mirrored.left[i] - mirrored.right[i]));
  expectAtMost("half_cycle_stereo_phase_gives_equal_gains", worst, 1.0e-3);
}

// A synced LFO's phase is a function of the song position: a fresh kernel started at a frame and one that has been running
// agree there, and the same beat of the next bar gives the same gain.
void sync() {
  currentName = "sync";
  AmplitudeValues values;
  values.depth = 1.0F;
  AmplitudeConfig config;
  config.waveform = 1;
  config.sync = true;
  config.division = 5;  // a quarter note
  dsp::LfoTransport transport;
  transport.tempo_bpm = 120.0;
  transport.running = true;
  transport.frame = 7000;
  const Envelope fresh = envelope(values, config, 200, 48000.0, transport);
  dsp::LfoTransport earlier = transport;
  earlier.frame = 0;
  const Envelope running = envelope(values, config, 7200, 48000.0, earlier);
  double worst = 0.0;
  for (int i = 0; i < 200; ++i) worst = std::max<double>(worst, std::fabs(fresh.left[i] - running.left[7000 + i]));
  expectAtMost("same_frame_same_gain", worst, 1.0e-5);
  dsp::LfoTransport next = transport;
  next.frame += 24000;  // one beat at 120 bpm
  const Envelope later = envelope(values, config, 200, 48000.0, next);
  worst = 0.0;
  for (int i = 0; i < 200; ++i) worst = std::max<double>(worst, std::fabs(fresh.left[i] - later.left[i]));
  expectAtMost("next_beat_same_gain", worst, 1.0e-5);
}

// Steps and parameter changes do not click: a Square LFO is slewed and a Depth step is smoothed.
void click() {
  currentName = "click";
  AmplitudeValues values;
  values.depth = 1.0F;
  values.rate_hz = 2.0F;
  AmplitudeConfig square;
  square.waveform = 4;
  const Envelope stepped = envelope(values, square, 48000);
  double largest = 0.0;
  for (size_t i = 1; i < stepped.left.size(); ++i) largest = std::max<double>(largest, std::fabs(stepped.left[i] - stepped.left[i - 1]));
  expectAtMost("square_max_step_per_frame", largest, 0.03);

  AmplitudeModulationKernel kernel;
  kernel.prepare(48000.0);
  AmplitudeConfig sine;
  values.depth = 0.0F;
  values.rate_hz = 4.0F;
  float previous = 1.0F;
  largest = 0.0;
  for (int i = 0; i < 4800; ++i) {
    if (i == 2400) values.depth = 1.0F;
    float left, right;
    kernel.process(values, sine, {}, 0.0F, 1.0F, 1.0F, left, right);
    if (i > 0) largest = std::max<double>(largest, std::fabs(left - previous));
    previous = left;
  }
  expectAtMost("depth_step_max_step_per_frame", largest, 0.02);

  AmplitudeConfig pan;
  pan.kind = AmplitudeKind::AutoPan;
  float a, b;
  bool finite = true;
  for (int i = 0; i < 4800; ++i) {
    kernel.process(values, pan, {}, 0.0F, i == 100 ? INFINITY : 0.5F, 0.5F, a, b);
    finite = finite && std::isfinite(a) && std::isfinite(b);
  }
  expectTrue("infinite_input_stays_finite", finite);
}
}  // namespace

int main(int argc, char **argv) {
  struct Group { const char *name; void (*run)(); };
  const Group groups[] = {{"loop", loop}, {"level", level}, {"feedback", feedback}, {"latency", latency}, {"safety", safety},
    {"stereo", stereo}, {"average", average}, {"pan", pan}, {"sync", sync}, {"click", click}};
  for (const Group &group : groups) {
    if (argc > 1 && std::strcmp(argv[1], group.name) != 0) continue;
    group.run();
  }
  std::printf("%d failure(s)\n", failures);
  return failures == 0 ? 0 : 1;
}
