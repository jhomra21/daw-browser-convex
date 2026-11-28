// Tests for the EQ band designs in src/dsp/eq_band.h against the analog prototypes (RBJ cookbook s-domain filters).
// Run with a group name (accuracy, nearNyquistPoles, poleTable, slopes, stability) or with no argument for all. Every check prints its measured value.
#include "../src/dsp/eq_band.h"
#include "../tools/eq_pole_table_fit.h"

#include <algorithm>
#include <complex>
#include <cstdio>
#include <cstring>
#include <random>

namespace dsp = daw::audio_core::dsp;
namespace tools = daw::audio_core::dsp::tools;
using Complex = std::complex<double>;
using Type = dsp::EqBandType;

namespace {

constexpr double kPi = 3.14159265358979323846;
int failures = 0;

void expectAtMost(const char *what, double measured, double limit) {
  const bool ok = measured <= limit;
  std::printf("  [%s] %s measured=%.4g limit<=%.4g\n", ok ? "pass" : "FAIL", what, measured, limit);
  if (!ok) ++failures;
}

void expectAtLeast(const char *what, double measured, double limit) {
  const bool ok = measured >= limit;
  std::printf("  [%s] %s measured=%.4g limit>=%.4g\n", ok ? "pass" : "FAIL", what, measured, limit);
  if (!ok) ++failures;
}

double digitalDb(const dsp::EqBandSections &band, double frequency, double sampleRate) {
  const double omega = 2.0 * kPi * frequency / sampleRate;
  const Complex z1 = std::polar(1.0, -omega);
  const Complex z2 = z1 * z1;
  Complex h = 1.0;
  for (uint32_t i = 0; i < band.count; ++i) {
    const dsp::BiquadCoefficients &c = band.sections[i];
    h *= (c.b0 + c.b1 * z1 + c.b2 * z2) / (1.0 + c.a1 * z1 + c.a2 * z2);
  }
  return 20.0 * std::log10(std::abs(h));
}

Complex section(double q, bool low, Complex s) { return (low ? Complex(1.0) : s * s) / (s * s + s / q + 1.0); }

double analogDb(Type type, double f0, double q, double gainDb, double f) {
  const Complex s(0.0, f / f0);
  const double a = std::pow(10.0, gainDb / 40.0);
  Complex h = 1.0;
  switch (type) {
    case Type::Peaking: h = (s * s + s * (a / q) + 1.0) / (s * s + s * (1.0 / (a * q)) + 1.0); break;
    case Type::Lowpass: h = section(q, true, s); break;
    case Type::Highpass: h = section(q, false, s); break;
    case Type::Lowshelf: h = a * (s * s + s * (std::sqrt(a) / q) + a) / (a * s * s + s * (std::sqrt(a) / q) + 1.0); break;
    case Type::Highshelf: h = a * (a * s * s + s * (std::sqrt(a) / q) + 1.0) / (s * s + s * (std::sqrt(a) / q) + a); break;
    case Type::Lowpass48:
    case Type::Highpass48:
      for (int i = 0; i < 4; ++i) {
        const double sectionQ = i == 3 ? dsp::detail::kButterworth8Q[i] * q * std::sqrt(2.0) : dsp::detail::kButterworth8Q[i];
        h *= section(sectionQ, type == Type::Lowpass48, s);
      }
      break;
    default: break;
  }
  return 20.0 * std::log10(std::abs(h));
}

// Worst |digital - analog| over 20 Hz to 0.45 fs of the project rate, where the filter runs at `processingRate`.
double worstError(Type type, double f0, double q, double gainDb, double projectRate, double processingRate) {
  const dsp::EqBandSections band = dsp::designEqBand(type, f0, processingRate, q, gainDb, projectRate);
  double worst = 0.0;
  for (int k = 0; k < 200; ++k) {
    const double f = 20.0 * std::pow(0.45 * projectRate / 20.0, k / 199.0);
    const double analog = analogDb(type, f0, q, gainDb, f);
    if (analog < -60.0) continue;
    worst = std::max(worst, std::fabs(digitalDb(band, f, processingRate) - analog));
  }
  return worst;
}

struct Range {
  Type type;
  const char *name;
};

// Random bands per type, corner anywhere between 20 Hz and 0.45 fs of the project rate.
double worstOverRandomBands(Type type, double projectRate, double processingRate, bool report) {
  std::mt19937 rng(11);
  std::uniform_real_distribution<double> unit(0.0, 1.0);
  double worst = 0.0;
  for (int i = 0; i < 400; ++i) {
    const double f0 = 20.0 * std::pow(0.45 * projectRate / 20.0, unit(rng));
    const double q = 0.5 + 3.5 * unit(rng);
    const double gain = dsp::eqBandHasGain(type) ? (unit(rng) < 0.5 ? -1.0 : 1.0) * (6.0 + 9.0 * unit(rng)) : 0.0;
    worst = std::max(worst, worstError(type, f0, q, gain, projectRate, processingRate));
  }
  if (report) std::printf("    worst error over 400 random bands: %.3f dB\n", worst);
  return worst;
}

void accuracy() {
  const Range ranges[] = {{Type::Peaking, "bell"}, {Type::Lowpass, "high cut 12"}, {Type::Highpass, "low cut 12"},
    {Type::Lowpass48, "high cut 48"}, {Type::Highpass48, "low cut 48"}};
  for (const double rate : {44100.0, 48000.0}) {
    for (const Range &range : ranges) {
      std::printf("  %s at %.0f Hz, Hi-Quality (design at 2x)\n", range.name, rate);
      expectAtMost(range.name, worstOverRandomBands(range.type, rate, 2.0 * rate, true), 0.5);
    }
    for (const Range &range : {Range{Type::Lowshelf, "low shelf"}, Range{Type::Highshelf, "high shelf"}}) {
      std::printf("  %s at %.0f Hz\n", range.name, rate);
      const double hq = worstOverRandomBands(range.type, rate, 2.0 * rate, true);
      const double plain = worstOverRandomBands(range.type, rate, rate, true);
      std::printf("    shelf worst error: Hi-Quality %.2f dB, normal %.2f dB (reported, not gated)\n", hq, plain);
      expectAtMost("shelf stays within RBJ-class accuracy with Hi-Quality", hq, 4.0);
    }
  }
}

// Bands whose pole or corner is near Nyquist: the impulse-invariant poles alone leave 0.46 to 0.57 dB (low shelf pole at
// omega0 / sqrt(a) = 1.9 omega0; bell at 0.4 fs). Limits are the ones of the harness row band-response-vs-analog.
void nearNyquistPoles() {
  for (const double rate : {44100.0, 48000.0, 96000.0}) {
    const double limit = rate >= 96000.0 ? 0.25 : 0.5;
    std::printf("  at %.0f Hz\n", rate);
    expectAtMost("low shelf 11.4 kHz Q 0.29 -22 dB", worstError(Type::Lowshelf, 11401.0, 0.287, -22.04, rate, rate), limit);
    expectAtMost("bell 19 kHz Q 0.45 +22.4 dB", worstError(Type::Peaking, 19050.0, 0.45, 22.4, rate, rate), limit);
  }
}

// The checked-in pole tables must be what the fit in tools/eq_pole_table_fit.h produces; regenerate them with
// tools/eq_pole_table_generator.cpp after changing the fit or the prototypes. The tolerance covers libm differences between
// platforms: the fit is deterministic, but a flat valley of the worst error can settle a little differently.
void poleTable() {
  const auto compare = [](const char *name, tools::Shape shape, const double *checkedIn) {
    const std::vector<double> fitted = tools::fitTable(shape);
    double worst = 0.0;
    for (size_t i = 0; i < fitted.size(); ++i) worst = std::max(worst, std::fabs(fitted[i] - checkedIn[i]));
    expectAtMost(name, worst, 2.0e-3);
  };
  compare("bell table, largest difference from a fresh fit", tools::Shape::Bell, dsp::detail::kBellPoleTable);
  compare("low shelf table, largest difference from a fresh fit", tools::Shape::LowShelf, dsp::detail::kLowShelfPoleTable);
  compare("low-pass table, largest difference from a fresh fit", tools::Shape::LowPass, dsp::detail::kLowPassPoleTable);
}

void slopes() {
  for (const bool high : {false, true}) {
    const Type type = high ? Type::Highpass48 : Type::Lowpass48;
    const double rate = 48000.0;
    const dsp::EqBandSections band = dsp::designEqBand(type, 1000.0, rate, std::sqrt(0.5), 0.0);
    const double octaves2 = digitalDb(band, high ? 250.0 : 4000.0, rate);
    std::printf("  %s 1 kHz: %.1f dB two octaves into the stopband\n", high ? "low cut 48" : "high cut 48", octaves2);
    expectAtMost("two octaves out at least 44 dB down", octaves2, -44.0);
    expectAtMost("Butterworth: -3 dB at the corner", std::fabs(digitalDb(band, 1000.0, rate) + 3.01), 0.1);
  }
  const dsp::EqBandSections twelve = dsp::designEqBand(Type::Highpass, 1000.0, 48000.0, std::sqrt(0.5), 0.0);
  expectAtLeast("12 dB cut is 24 dB down two octaves out", -digitalDb(twelve, 250.0, 48000.0), 23.0);
}

void stability() {
  std::mt19937 rng(5);
  std::uniform_real_distribution<double> unit(0.0, 1.0);
  int unstable = 0;
  int nonFinite = 0;
  for (int i = 0; i < 20000; ++i) {
    const Type type = static_cast<Type>(rng() % 10);
    const double rate = (rng() & 1) ? 96000.0 : 44100.0;
    const double f0 = 20.0 * std::pow(20000.0 / 20.0, unit(rng));
    const dsp::EqBandSections band = dsp::designEqBand(type, f0, rate, 0.2 * std::pow(90.0, unit(rng)), 48.0 * unit(rng) - 24.0);
    for (uint32_t s = 0; s < band.count; ++s) {
      const dsp::BiquadCoefficients &c = band.sections[s];
      if (!std::isfinite(c.b0 + c.b1 + c.b2 + c.a1 + c.a2)) { ++nonFinite; continue; }
      if (!(std::fabs(c.a2) < 1.0 && std::fabs(c.a1) < 1.0 + c.a2)) ++unstable;
    }
  }
  expectAtMost("non-finite coefficient sets", nonFinite, 0);
  expectAtMost("sections with a pole outside the unit circle", unstable, 0);
  const dsp::EqBandSections flat = dsp::designEqBand(Type::Peaking, 1000.0, 48000.0, 1.0, 0.0);
  double worst = 0.0;
  for (double f = 20.0; f < 20000.0; f *= 1.3) worst = std::max(worst, std::fabs(digitalDb(flat, f, 48000.0)));
  expectAtMost("a 0 dB bell is flat (dB)", worst, 1.0e-6);
}

}  // namespace

int main(int argc, char **argv) {
  const char *group = argc > 1 ? argv[1] : nullptr;
  const struct { const char *name; void (*run)(); } cases[] = {{"accuracy", accuracy}, {"nearNyquistPoles", nearNyquistPoles}, {"poleTable", poleTable}, {"slopes", slopes}, {"stability", stability}};
  for (const auto &testCase : cases) {
    if (group != nullptr && std::strcmp(group, testCase.name) != 0) continue;
    std::printf("%s\n", testCase.name);
    testCase.run();
  }
  std::printf("%d failed checks\n", failures);
  return failures == 0 ? 0 : 1;
}
