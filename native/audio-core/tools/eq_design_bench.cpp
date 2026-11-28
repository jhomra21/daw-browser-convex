// Prints what one EQ band design costs (designEqBand in src/dsp/eq_band.h) over a grid of corner frequency, Q and gain,
// for every band type at the project rates and at their Hi-Quality (2x) design rates. Not a pass/fail gate: the numbers
// are for comparing a change with the code before it. The processor redesigns each moving band every 32 samples, about
// 1500 times a second at 48 kHz, so a worst-case design cost of 1 us is 0.15 % of one core.
// Build: c++ -std=c++20 -O2 -I native/audio-core/src native/audio-core/tools/eq_design_bench.cpp -o /tmp/eq-design-bench
#include "../src/dsp/eq_band.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

namespace dsp = daw::audio_core::dsp;
using Type = dsp::EqBandType;

namespace {

struct Config {
  const char *label;
  double projectRate;
  double designRate;
};

struct Cell {
  double frequency;
  double q;
  double gainDb;
};

// Nanoseconds per design for one cell: the fastest of three timed batches, so a preempted batch does not count.
double nanosecondsPerDesign(Type type, const Config &config, const Cell &cell, int batch) {
  double fastest = 1.0e18;
  float sink = 0.0F;
  for (int repeat = 0; repeat < 3; ++repeat) {
    const auto start = std::chrono::steady_clock::now();
    for (int i = 0; i < batch; ++i) {
      // A different corner every call, as in an automated sweep, so no call repeats the one before.
      const dsp::EqBandSections band = dsp::designEqBand(type, cell.frequency * (1.0 + 1.0e-4 * i), config.designRate, cell.q, cell.gainDb, config.projectRate);
      sink += static_cast<float>(band.sections[0].b0);
    }
    const double elapsed = std::chrono::duration<double, std::nano>(std::chrono::steady_clock::now() - start).count();
    fastest = std::min(fastest, elapsed / batch);
  }
  if (sink == 12345.678F) std::printf("\n");
  return fastest;
}

}  // namespace

// Argument: designs per timed batch (default 200). A design that takes 100 us or more wants a smaller batch.
int main(int argc, char **argv) {
  const int batch = argc > 1 ? std::max(1, std::atoi(argv[1])) : 200;
  const struct { Type type; const char *name; bool hasGain; } types[] = {
    {Type::Peaking, "bell", true}, {Type::Lowshelf, "low shelf", true}, {Type::Highshelf, "high shelf", true},
    {Type::Lowpass, "low-pass 12", false}, {Type::Highpass, "high-pass 12", false}, {Type::Lowpass48, "low-pass 48", false},
    {Type::Highpass48, "high-pass 48", false}, {Type::Bandpass, "band-pass", false}, {Type::Notch, "notch", false},
    {Type::Allpass, "all-pass", false}};
  const Config configs[] = {{"44.1 kHz", 44100.0, 44100.0}, {"48 kHz", 48000.0, 48000.0}, {"96 kHz", 96000.0, 96000.0},
    {"44.1 kHz Hi-Quality", 44100.0, 88200.0}, {"48 kHz Hi-Quality", 48000.0, 96000.0}, {"96 kHz Hi-Quality", 96000.0, 192000.0}};
  constexpr double kQs[] = {0.2, 0.45, 1.0, 4.0, 18.0, 36.0};
  constexpr double kGains[] = {-24.0, -12.0, -3.0, 0.0, 3.0, 12.0, 24.0};
  constexpr int kFrequencies = 14;

  std::printf("Design cost in microseconds over %d corner frequencies (20 Hz to 0.45 of the project rate) x %d Q x up to %d gains.\n", kFrequencies,
    static_cast<int>(std::size(kQs)), static_cast<int>(std::size(kGains)));
  std::printf("| band | rate | median | worst | worst cell (Hz, Q, dB) |\n|---|---|---|---|---|\n");
  double overall = 0.0;
  for (const auto &entry : types) {
    for (const Config &config : configs) {
      std::vector<double> costs;
      double worst = 0.0;
      Cell worstCell{};
      for (int f = 0; f < kFrequencies; ++f) {
        const double frequency = 20.0 * std::pow(0.45 * config.projectRate / 20.0, static_cast<double>(f) / (kFrequencies - 1));
        for (const double q : kQs) {
          for (const double gain : kGains) {
            if (!entry.hasGain && gain != 0.0) continue;
            const Cell cell{frequency, q, gain};
            const double cost = nanosecondsPerDesign(entry.type, config, cell, batch);
            costs.push_back(cost);
            if (cost > worst) {
              worst = cost;
              worstCell = cell;
            }
          }
        }
      }
      std::sort(costs.begin(), costs.end());
      overall = std::max(overall, worst);
      std::printf("| %s | %s | %.2f | %.2f | %.0f, %.2f, %+.0f |\n", entry.name, config.label, costs[costs.size() / 2] / 1000.0, worst / 1000.0, worstCell.frequency, worstCell.q, worstCell.gainDb);
    }
  }
  std::printf("\nWorst design of any band: %.2f us\n", overall / 1000.0);
  return 0;
}
