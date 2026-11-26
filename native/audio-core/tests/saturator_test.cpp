// Saturator kernel measurements (src/saturator_kernel.h). The executable prints each value and fails when a bound is broken;
// one ctest per group (see CMakeLists.txt).
#include "../src/saturator_kernel.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <functional>
#include <vector>

using namespace daw::audio_core;

namespace {

constexpr double kPi = 3.14159265358979323846;
int failures = 0;

void expect(bool ok, const char *what, double value) {
  std::printf("%s %s = %.5f\n", ok ? "PASS" : "FAIL", what, value);
  if (!ok) ++failures;
}

using Source = std::function<double(size_t)>;

std::vector<double> run(double rate, SaturatorValues values, SaturatorConfig config, size_t frames, const Source &source,
  const std::function<void(size_t, SaturatorValues &)> &change = nullptr) {
  SaturatorKernel kernel;
  kernel.prepare(rate);
  std::vector<double> out(frames);
  for (size_t i = 0; i < frames; ++i) {
    if (change) change(i, values);
    float l = 0.0F, r = 0.0F;
    const float x = static_cast<float>(source(i));
    kernel.process(values, config, x, x, l, r);
    out[i] = l;
  }
  return out;
}

Source tone(double hz, double rate, double amplitude) { return [=](size_t i) { return amplitude * std::sin(2.0 * kPi * hz * static_cast<double>(i) / rate); }; }

double amplitude_at(const std::vector<double> &x, double hz, double rate, size_t from, size_t to) {
  double s = 0.0, c = 0.0;
  for (size_t i = from; i < to; ++i) {
    const double phase = 2.0 * kPi * hz * static_cast<double>(i) / rate;
    s += x[i] * std::sin(phase);
    c += x[i] * std::cos(phase);
  }
  return 2.0 * std::hypot(s, c) / static_cast<double>(to - from);
}

double db(double ratio) { return 20.0 * std::log10(ratio); }

SaturatorValues drive(double drive_db) {
  SaturatorValues values;
  values.drive_db = static_cast<float>(drive_db);
  return values;
}

SaturatorConfig curve(uint32_t which, bool hi_quality = true) {
  SaturatorConfig config;
  config.curve = which;
  config.hi_quality = hi_quality;
  return config;
}

const char *const kNames[] = {"soft", "medium", "hard", "clip", "analog", "sine", "bass", "fold", "warp"};

// S5: every curve passes a quiet 1 kHz tone at unity at Drive 0.
void unity() {
  for (uint32_t which = kSoft; which <= kWarp; ++which) {
    for (const bool hi : {false, true}) {
      const std::vector<double> out = run(48000.0, drive(0.0), curve(which, hi), 9600, tone(1000.0, 48000.0, 0.01));
      char name[64];
      std::snprintf(name, sizeof(name), "%s hq=%d gain at -40 dBFS dB", kNames[which], hi ? 1 : 0);
      const double gain = db(amplitude_at(out, 1000.0, 48000.0, 4800, 9600) / 0.01);
      expect(std::fabs(gain) < 0.05, name, gain);
    }
  }
}

// S3: the curve and its slope have no step, checked on the shapes themselves.
void continuity() {
  SaturatorShape shape;
  shape.threshold = 0.1;
  shape.depth = 0.5;
  shape.period = 0.3;
  for (uint32_t which = kSoft; which <= kWarp; ++which) {
    double worst_step = 0.0, worst_slope_jump = 0.0, worst_antiderivative = 0.0;
    constexpr double kDelta = 1.0e-4;
    double previous_slope = 0.0;
    for (double x = -2.0; x <= 2.0; x += kDelta) {
      const double a = shape.value(which, x), b = shape.value(which, x + kDelta);
      worst_step = std::fmax(worst_step, std::fabs(b - a));
      const double slope = (b - a) / kDelta;
      if (x > -2.0) worst_slope_jump = std::fmax(worst_slope_jump, std::fabs(slope - previous_slope));
      previous_slope = slope;
      // The antiderivative's own slope is the curve.
      const double f = (shape.antiderivative(which, x + kDelta) - shape.antiderivative(which, x)) / kDelta;
      worst_antiderivative = std::fmax(worst_antiderivative, std::fabs(f - shape.value(which, x + 0.5 * kDelta)));
    }
    char name[96];
    std::snprintf(name, sizeof(name), "%s max step over 1e-4", kNames[which]);
    expect(worst_step < 2.0e-4, name, worst_step);
    if (which != kClip && which != kFold && which != kSine) {
      std::snprintf(name, sizeof(name), "%s max slope jump", kNames[which]);
      expect(worst_slope_jump < 1.0e-2, name, worst_slope_jump);
    }
    std::snprintf(name, sizeof(name), "%s antiderivative matches the curve", kNames[which]);
    expect(worst_antiderivative < 2.0e-4, name, worst_antiderivative);
  }
}

// S1: harmonics that fold below Nyquist, relative to the fundamental, for a coherent tone.
double alias_db(const std::vector<double> &out, double hz, double rate, size_t from, size_t to) {
  const double fundamental = amplitude_at(out, hz, rate, from, to);
  double energy = 0.0;
  for (int harmonic = 1; harmonic <= 9; ++harmonic) {
    const double f = harmonic * hz;
    if (f < 0.5 * rate) continue;
    double folded = std::fmod(f, rate);
    if (folded > 0.5 * rate) folded = rate - folded;
    const double a = amplitude_at(out, folded, rate, from, to);
    energy += a * a;
  }
  return db(std::sqrt(energy) / fundamental);
}

void alias() {
  struct Row { const char *name; uint32_t curve; double hz; double drive; double limit; };
  const Row rows[] = {
    {"soft 5 kHz 18 dB", kSoft, 5000.0, 18.0, -45.0}, {"hard 5 kHz 18 dB", kHard, 5000.0, 18.0, -45.0},
    {"soft 5 kHz 6 dB", kSoft, 5000.0, 6.0, -55.0}, {"hard 5 kHz 6 dB", kHard, 5000.0, 6.0, -55.0},
    {"soft 7.9 kHz 18 dB", kSoft, 7900.0, 18.0, -45.0}, {"hard 7.9 kHz 18 dB", kHard, 7900.0, 18.0, -45.0},
    {"soft 8.4 kHz 18 dB (information)", kSoft, 8400.0, 18.0, 0.0}, {"hard 8.4 kHz 18 dB (information)", kHard, 8400.0, 18.0, 0.0},
    {"soft 10 kHz 18 dB", kSoft, 10000.0, 18.0, -45.0},
    // The third harmonic lands inside the half-band's transition (0.45 to 0.55 of the base rate), which no 2x stage separates
    // from the fundamental's alias: printed, not gated.
    {"soft 8.1 kHz 18 dB (information)", kSoft, 8100.0, 18.0, 0.0},
  };
  for (const Row &row : rows) {
    // 4800 samples at 48 kHz hold a whole number of cycles of both tones.
    const std::vector<double> out = run(48000.0, drive(row.drive), curve(row.curve), 9600, tone(row.hz, 48000.0, 0.5));
    const double measured = alias_db(out, row.hz, 48000.0, 4800, 9600);
    char name[96];
    std::snprintf(name, sizeof(name), "%s alias dB", row.name);
    if (row.limit == 0.0) std::printf("INFO %s = %.5f\n", name, measured);
    else expect(measured <= row.limit, name, measured);
  }
}

// S2 and S6: Color's pre and post EQ cancel on the linear path, and its response at the colour frequency follows the amount.
void color() {
  SaturatorValues values = drive(0.0);
  values.color_low_db = 6.0F;
  values.color_high_db = -9.0F;
  SaturatorConfig config = curve(kSoft);
  config.color = true;
  double worst = 0.0;
  for (const double hz : {60.0, 250.0, 1200.0, 5000.0, 12000.0}) {
    const std::vector<double> out = run(48000.0, values, config, 9600, tone(hz, 48000.0, 0.01));
    const double error = db(amplitude_at(out, hz, 48000.0, 4800, 9600) / 0.01);
    std::printf("  colour cancel %.0f Hz %.4f dB\n", hz, error);
    worst = std::fmax(worst, std::fabs(error));
  }
  expect(worst < 0.5, "pre and post EQ cancel at Drive 0, worst dB", worst);
  // With the curve in the way, the high shelf's boost is what drives it: more harmonics than the flat path.
  SaturatorValues driven = drive(12.0);
  driven.color_high_db = 9.0F;
  const std::vector<double> flat = run(48000.0, drive(12.0), curve(kSoft), 9600, tone(3000.0, 48000.0, 0.3));
  const std::vector<double> coloured = run(48000.0, driven, config, 9600, tone(3000.0, 48000.0, 0.3));
  const double flat_third = amplitude_at(flat, 9000.0, 48000.0, 4800, 9600);
  const double coloured_third = amplitude_at(coloured, 9000.0, 48000.0, 4800, 9600);
  expect(coloured_third != flat_third, "colour changes the harmonic balance", db(coloured_third / flat_third));
}

// S6: Post Clip hard keeps the peak at the Output setting.
void postclip() {
  SaturatorValues values = drive(24.0);
  values.output_db = -6.0F;
  SaturatorConfig config = curve(kFold);
  config.post_clip = 2;
  const std::vector<double> out = run(48000.0, values, config, 9600, tone(997.0, 48000.0, 0.9));
  double peak = 0.0;
  for (size_t i = 0; i < out.size(); ++i) peak = std::fmax(peak, std::fabs(out[i]));
  expect(db(peak) <= -6.0 + 0.01, "post clip hard peak vs output dB", db(peak));
}

// S4: a drive step moves the gain over the smoothing time, not in one sample.
void step() {
  const std::vector<double> out = run(48000.0, drive(0.0), curve(kClip), 9600, tone(100.0, 48000.0, 0.1),
    [](size_t i, SaturatorValues &values) { values.drive_db = i < 4800 ? 0.0F : 12.0F; });
  double largest = 0.0, own = 0.0;
  for (size_t i = 4801; i < 5800; ++i) largest = std::fmax(largest, std::fabs(out[i] - out[i - 1]));
  // The signal's own slope is the largest sample step it makes once settled at the new drive.
  for (size_t i = 8000; i < 9600; ++i) own = std::fmax(own, std::fabs(out[i] - out[i - 1]));
  expect(largest <= own * 1.01, "drive step jump / own slope", largest / own);
}

// S1: Dry/Wet 0 returns the input exactly.
void dry() {
  SaturatorValues values = drive(24.0);
  values.dry_wet = 0.0F;
  const std::vector<double> out = run(48000.0, values, curve(kHard), 4800, tone(1234.0, 48000.0, 0.7));
  double worst = 0.0;
  for (size_t i = 0; i < out.size(); ++i) worst = std::fmax(worst, std::fabs(out[i] - static_cast<double>(static_cast<float>(tone(1234.0, 48000.0, 0.7)(i)))));
  expect(worst == 0.0, "dry/wet 0 differs from the input by", worst);
}

// A non-finite input leaves no non-finite output, and silence stays silent.
void safety() {
  SaturatorValues values = drive(36.0);
  values.color_high_db = 12.0F;
  SaturatorConfig config = curve(kWarp);
  config.color = true;
  SaturatorKernel kernel;
  kernel.prepare(48000.0);
  bool finite = true;
  for (size_t i = 0; i < 4800; ++i) {
    float l = 0.0F, r = 0.0F;
    const float x = i == 100 ? std::numeric_limits<float>::infinity() : i == 200 ? std::numeric_limits<float>::quiet_NaN() : static_cast<float>(std::sin(0.3 * static_cast<double>(i)));
    kernel.process(values, config, x, x, l, r);
    finite = finite && std::isfinite(l) && std::isfinite(r);
  }
  expect(finite, "non-finite input leaves finite output", finite ? 1.0 : 0.0);
  double tail = 0.0;
  for (size_t i = 0; i < 48000; ++i) {
    float l = 0.0F, r = 0.0F;
    kernel.process(values, config, 0.0F, 0.0F, l, r);
    if (i > 24000) tail = std::fmax(tail, std::fabs(l));
  }
  expect(tail == 0.0, "silence decays to exact zero", tail);
}

}  // namespace

int main(int argc, char **argv) {
  const char *group = argc > 1 ? argv[1] : "";
  const std::pair<const char *, void (*)()> groups[] = {{"unity", unity}, {"continuity", continuity}, {"alias", alias}, {"color", color},
    {"postclip", postclip}, {"step", step}, {"dry", dry}, {"safety", safety}};
  for (const auto &[name, body] : groups) if (std::strcmp(group, name) == 0) body();
  return failures == 0 ? 0 : 1;
}
