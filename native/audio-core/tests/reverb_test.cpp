// Reverb kernel measurements (src/reverb_kernel.h). The executable prints each value and fails when a bound is broken;
// one ctest per group (see CMakeLists.txt).
#include "../src/reverb_kernel.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <vector>

using namespace daw::audio_core;

namespace {

int failures = 0;
void expect(bool ok, const char *what, double value) {
  std::printf("%s %s = %.4f\n", ok ? "PASS" : "FAIL", what, value);
  if (!ok) ++failures;
}

struct Render {
  std::vector<double> left, right;
};

Render run(ReverbKernel &kernel, const ReverbValues &values, const ReverbConfig &config, size_t frames, float impulse = 1.0F) {
  Render out{std::vector<double>(frames), std::vector<double>(frames)};
  for (size_t i = 0; i < frames; ++i) {
    float l = 0.0F, r = 0.0F;
    const float x = i == 0 ? impulse : 0.0F;
    kernel.process(values, config, x, x, l, r);
    out.left[i] = l;
    out.right[i] = r;
  }
  return out;
}

// RBJ band-pass at centre hz, applied in place.
void bandpass(std::vector<double> &x, double hz, double rate) {
  const double w = 2.0 * 3.14159265358979323846 * hz / rate, alpha = std::sin(w) / (2.0 * 1.4142), a0 = 1.0 + alpha;
  const double b0 = alpha / a0, b2 = -alpha / a0, a1 = -2.0 * std::cos(w) / a0, a2 = (1.0 - alpha) / a0;
  double x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (double &v : x) {
    const double y = b0 * v + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = y;
    v = y;
  }
}

// T60 estimated from the -5 to -35 dB span of the backward-integrated energy.
double t60(const std::vector<double> &x, double rate) {
  std::vector<double> s(x.size() + 1, 0.0);
  for (size_t i = x.size(); i-- > 0;) s[i] = s[i + 1] + x[i] * x[i];
  double a = -1, b = -1;
  for (size_t i = 0; i < x.size(); ++i) {
    const double db = 10.0 * std::log10(s[i] / s[0] + 1e-30);
    if (a < 0 && db < -5.0) a = static_cast<double>(i);
    if (b < 0 && db < -35.0) { b = static_cast<double>(i); break; }
  }
  return b < 0 ? -1.0 : 2.0 * (b - a) / rate;
}

double band_t60(const Render &r, double hz, double rate) {
  std::vector<double> x = r.left;
  // Two passes: the skirts of a single band reach the slower high-band tail when a shelf lengthens it, and would read as decay.
  bandpass(x, hz, rate);
  bandpass(x, hz, rate);
  return t60(x, rate);
}

ReverbValues tail_only() {
  ReverbValues v;
  v.wet = 1.0F; v.reflections = 0.0F; v.pre_delay_ms = 0.0F; v.chorus_amount_ms = 0.3F;
  return v;
}

void decay() {
  for (uint32_t density = 0; density < ReverbKernel::kDensityCount; ++density) {
    for (const float seconds : {0.3F, 1.0F, 2.2F, 5.0F, 12.0F}) {
      ReverbKernel kernel;
      kernel.prepare(48000.0, density);
      ReverbValues v = tail_only();
      v.decay_sec = seconds;
      const Render r = run(kernel, v, ReverbConfig{}, static_cast<size_t>(48000 * (seconds * 1.4 + 0.5)));
      std::vector<double> power(r.left.size());
      for (size_t i = 0; i < power.size(); ++i) power[i] = std::sqrt(r.left[i] * r.left[i] + r.right[i] * r.right[i]);
      const double rt60 = t60(power, 48000.0);
      char label[64];
      std::snprintf(label, sizeof label, "density %u decay %.1f s RT60 ratio", density, seconds);
      expect(std::fabs(rt60 / seconds - 1.0) < 0.1, label, rt60 / seconds);
    }
  }
}

void shelves() {
  for (const double rate : {48000.0}) {
    ReverbValues v = tail_only();
    v.decay_sec = 3.0F;
    ReverbKernel flat;
    flat.prepare(rate, 3);
    const Render base = run(flat, v, ReverbConfig{}, static_cast<size_t>(rate * 14));
    const double base8 = band_t60(base, 8000.0, rate), base250 = band_t60(base, 250.0, rate);
    v.high_shelf_db = 6.0F;
    ReverbKernel boosted;
    boosted.prepare(rate, 3);
    const Render up = run(boosted, v, ReverbConfig{}, static_cast<size_t>(rate * 24));
    expect(band_t60(up, 8000.0, rate) / base8 > 1.5, "+6 dB high shelf lengthens the 8 kHz T60", band_t60(up, 8000.0, rate) / base8);
    expect(std::fabs(band_t60(up, 250.0, rate) / base250 - 1.0) < 0.1, "+6 dB high shelf leaves the 250 Hz T60", band_t60(up, 250.0, rate) / base250);
    v.high_shelf_db = -6.0F;
    ReverbKernel cut;
    cut.prepare(rate, 3);
    const Render down = run(cut, v, ReverbConfig{}, static_cast<size_t>(rate * 14));
    expect(band_t60(down, 8000.0, rate) / base8 < 0.7, "-6 dB high shelf shortens the 8 kHz T60", band_t60(down, 8000.0, rate) / base8);
    // The input cut sits before the network and leaves the decay alone.
    v.high_shelf_db = 0.0F;
    v.low_cut_hz = 1000.0F;
    ReverbKernel filtered;
    filtered.prepare(rate, 3);
    const Render input_cut = run(filtered, v, ReverbConfig{}, static_cast<size_t>(rate * 14));
    expect(std::fabs(band_t60(input_cut, 8000.0, rate) / base8 - 1.0) < 0.05, "input low cut leaves the 8 kHz T60", band_t60(input_cut, 8000.0, rate) / base8);
  }
}

double level_db(const std::vector<double> &x, size_t from, size_t to) {
  double sum = 0.0;
  for (size_t i = from; i < to; ++i) sum += x[i] * x[i];
  return 10.0 * std::log10(sum / static_cast<double>(to - from) + 1e-30);
}

void freeze() {
  const size_t rate = 48000;
  ReverbValues v = tail_only();
  v.decay_sec = 2.0F;
  ReverbConfig frozen;
  frozen.freeze = true;
  frozen.flat = true;
  ReverbKernel kernel;
  kernel.prepare(rate, 3);
  // Excite the tail, then freeze: the level must not drift over 30 s.
  run(kernel, v, ReverbConfig{}, rate / 4);
  run(kernel, v, frozen, rate * 3, 0.0F);
  const Render held = run(kernel, v, frozen, rate * 30, 0.0F);
  const double drift = std::fabs(level_db(held.left, 0, rate) - level_db(held.left, rate * 29, rate * 30));
  expect(drift < 0.5, "frozen flat tail drift in dB over 30 s", drift);

  // Cut: a frozen tail must ignore new input, so an impulse sent while it holds changes the output by under -80 dB of it.
  ReverbConfig cut = frozen;
  cut.cut = true;
  ReverbKernel with_impulse, without_impulse;
  with_impulse.prepare(rate, 3);
  without_impulse.prepare(rate, 3);
  for (ReverbKernel *kernel : {&with_impulse, &without_impulse}) {
    run(*kernel, v, ReverbConfig{}, rate / 4);
    run(*kernel, v, cut, rate, 0.0F);
  }
  const Render reference = run(without_impulse, v, cut, rate * 2, 0.0F);
  const Render disturbed = run(with_impulse, v, cut, rate * 2, 1.0F);
  double difference = 0.0, tail = 0.0;
  for (size_t i = rate / 2; i < reference.left.size(); ++i) {
    difference += (disturbed.left[i] - reference.left[i]) * (disturbed.left[i] - reference.left[i]);
    tail += reference.left[i] * reference.left[i];
  }
  expect(10.0 * std::log10(difference / tail + 1e-30) < -80.0, "frozen cut: impulse adds, dB below the tail", 10.0 * std::log10(difference / tail + 1e-30));
}

void stereo() {
  ReverbValues v = tail_only();
  double energy_reference = 0.0;
  for (const float degrees : {120.0F, 100.0F, 60.0F, 0.0F}) {
    v.stereo_degrees = degrees;
    ReverbKernel kernel;
    kernel.prepare(48000.0, 3);
    const Render r = run(kernel, v, ReverbConfig{}, 48000 * 3);
    double energy = 0.0, cross = 0.0, l2 = 0.0, r2 = 0.0;
    for (size_t i = 0; i < r.left.size(); ++i) { l2 += r.left[i] * r.left[i]; r2 += r.right[i] * r.right[i]; cross += r.left[i] * r.right[i]; }
    energy = l2 + r2;
    if (degrees == 120.0F) energy_reference = energy;
    char label[64];
    std::snprintf(label, sizeof label, "stereo %.0f degrees energy vs 120 in dB", degrees);
    expect(std::fabs(10.0 * std::log10(energy / energy_reference)) < 1.0, label, 10.0 * std::log10(energy / energy_reference));
    std::snprintf(label, sizeof label, "stereo %.0f degrees correlation", degrees);
    expect(cross / std::sqrt(l2 * r2) > -0.1, label, cross / std::sqrt(l2 * r2));
  }
}

void guards() {
  ReverbKernel kernel;
  kernel.prepare(48000.0, 3);
  ReverbValues v;
  v.wet = 1.0F;
  float l = 0.0F, r = 0.0F;
  bool finite = true;
  for (int i = 0; i < 48000; ++i) {
    const float bad[3] = {NAN, INFINITY, -INFINITY};
    const float x = i % 100 == 0 ? bad[(i / 100) % 3] : 0.5F;
    kernel.process(v, ReverbConfig{}, x, x, l, r);
    finite = finite && std::isfinite(l) && std::isfinite(r);
  }
  expect(finite, "non-finite input leaves the output finite", finite ? 1.0 : 0.0);
  // A tail left to fall under the denormal range must reach exact zero.
  ReverbKernel quiet;
  quiet.prepare(48000.0, 3);
  ReverbValues short_decay = tail_only();
  short_decay.decay_sec = 0.05F;
  const Render tail = run(quiet, short_decay, ReverbConfig{}, 48000 * 3);
  expect(tail.left.back() == 0.0 && tail.right.back() == 0.0, "decayed tail is exactly zero", std::fabs(tail.left.back()));
  // Extreme settings at once stay bounded.
  ReverbKernel extreme;
  extreme.prepare(48000.0, 3);
  ReverbValues loud;
  loud.wet = 1.0F; loud.decay_sec = 12.0F; loud.size = 1.0F; loud.high_shelf_db = 12.0F; loud.low_shelf_db = 12.0F; loud.chorus_amount_ms = 5.0F;
  ReverbConfig freeze_on;
  freeze_on.freeze = true;
  double peak = 0.0;
  for (int i = 0; i < 48000 * 20; ++i) {
    kernel.process(v, ReverbConfig{}, 0.0F, 0.0F, l, r);
    extreme.process(loud, i > 48000 ? freeze_on : ReverbConfig{}, i < 4800 ? 0.5F : 0.0F, 0.0F, l, r);
    peak = std::max(peak, std::fabs(static_cast<double>(l)));
  }
  expect(peak < 4.0, "frozen boosted shelves stay bounded, peak", peak);
}

void rates() {
  // The same milliseconds must land on the same time at every rate: the pre-delay tap and the line lengths scale with the rate.
  double reference_ms = 0.0;
  for (const double rate : {48000.0, 44100.0, 96000.0, 192000.0}) {
    ReverbKernel kernel;
    expect(kernel.prepare(rate, 3), "prepare succeeds", rate);
    ReverbValues v = tail_only();
    v.pre_delay_ms = 250.0F;
    const Render r = run(kernel, v, ReverbConfig{}, static_cast<size_t>(rate * 0.6));
    size_t first = 0;
    while (first < r.left.size() && std::fabs(r.left[first]) < 1e-6 && std::fabs(r.right[first]) < 1e-6) ++first;
    const double ms = 1000.0 * static_cast<double>(first) / rate;
    if (reference_ms == 0.0) reference_ms = ms;
    expect(ms > 250.0 && std::fabs(ms - reference_ms) < 1.0, "first tail energy lands on the same ms as at 48 kHz, ms", ms);
  }
}

}  // namespace

int main(int argc, char **argv) {
  const char *group = argc > 1 ? argv[1] : "";
  if (std::strcmp(group, "decay") == 0) decay();
  else if (std::strcmp(group, "shelves") == 0) shelves();
  else if (std::strcmp(group, "freeze") == 0) freeze();
  else if (std::strcmp(group, "stereo") == 0) stereo();
  else if (std::strcmp(group, "guards") == 0) guards();
  else if (std::strcmp(group, "rates") == 0) rates();
  else { std::printf("unknown group '%s'\n", group); return 2; }
  return failures == 0 ? 0 : 1;
}
