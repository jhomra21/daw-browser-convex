// Delay kernel measurements (src/delay_kernel.h). The executable prints each value and fails when a bound is broken;
// one ctest per group (see CMakeLists.txt).
#include "../src/delay_kernel.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <functional>
#include <limits>
#include <tuple>
#include <vector>

using namespace daw::audio_core;

namespace {

constexpr double kPi = 3.14159265358979323846;
int failures = 0;

void expect(bool ok, const char *what, double value) {
  std::printf("%s %s = %.4f\n", ok ? "PASS" : "FAIL", what, value);
  if (!ok) ++failures;
}

struct Render {
  std::vector<double> left, right;
};

using Source = std::function<double(size_t)>;
using Change = std::function<void(size_t, DelayValues &, DelayConfig &)>;

// Runs a fresh kernel; the same input feeds both channels unless right is given. change may edit the values and config per frame.
Render run(double rate, DelayValues values, DelayConfig config, size_t frames, const Source &left, const Source &right = nullptr, const Change &change = nullptr) {
  DelayKernel kernel;
  if (!kernel.prepare(rate)) std::printf("FAIL prepare\n");
  Render out{std::vector<double>(frames), std::vector<double>(frames)};
  for (size_t i = 0; i < frames; ++i) {
    if (change) change(i, values, config);
    float l = 0.0F, r = 0.0F;
    kernel.process(values, config, static_cast<float>(left(i)), static_cast<float>((right ? right : left)(i)), l, r);
    out.left[i] = l;
    out.right[i] = r;
  }
  return out;
}

DelayValues free_time(double ms, double feedback, double dry_wet = 1.0) {
  DelayValues values;
  values.time_ms = {static_cast<float>(ms), static_cast<float>(ms)};
  values.feedback = static_cast<float>(feedback);
  values.dry_wet = static_cast<float>(dry_wet);
  return values;
}

DelayConfig free_config() {
  DelayConfig config;
  config.sync = {false, false};
  return config;
}

Source impulse_at(size_t at, double amplitude) { return [=](size_t i) { return i == at ? amplitude : 0.0; }; }

Source tone(double hz, double rate, double amplitude) { return [=](size_t i) { return amplitude * std::sin(2.0 * kPi * hz * static_cast<double>(i) / rate); }; }

// Position of the largest sample in [from, to).
size_t peak_between(const std::vector<double> &x, size_t from, size_t to) {
  size_t best = from;
  for (size_t i = from; i < to; ++i) if (std::fabs(x[i]) > std::fabs(x[best])) best = i;
  return best;
}

// Amplitude of the hz component over [from, to) by projection on a sine and a cosine.
double tone_amplitude(const std::vector<double> &x, double hz, double rate, size_t from, size_t to) {
  double s = 0.0, c = 0.0;
  for (size_t i = from; i < to; ++i) {
    const double phase = 2.0 * kPi * hz * static_cast<double>(i) / rate;
    s += x[i] * std::sin(phase);
    c += x[i] * std::cos(phase);
  }
  return 2.0 * std::hypot(s, c) / static_cast<double>(to - from);
}

double db(double ratio) { return 20.0 * std::log10(ratio + 1e-30); }

double rms_db(const std::vector<double> &x, size_t from, size_t to) {
  double sum = 0.0;
  for (size_t i = from; i < to; ++i) sum += x[i] * x[i];
  return 10.0 * std::log10(sum / static_cast<double>(to - from) + 1e-30);
}

// DEL-2: echo positions within a frame and, for whole-frame delays, the level of the second echo within 0.1 dB.
void position() {
  for (const double rate : {44100.0, 48000.0, 96000.0}) {
    for (const double ms : {1.0, 5.0, 250.0}) {
      const double spacing = ms * rate / 1000.0;
      const size_t lead = 200, frames = lead + static_cast<size_t>(4.0 * spacing) + 64;
      const Render out = run(rate, free_time(ms, 0.5), free_config(), frames, impulse_at(lead, 0.2));
      for (const int k : {1, 2, 4}) {
        const double expected = static_cast<double>(lead) + k * spacing;
        const size_t half = static_cast<size_t>(std::min(20.0, std::floor(spacing / 2.0)));
        const size_t found = peak_between(out.left, static_cast<size_t>(std::llround(expected)) - half, static_cast<size_t>(std::llround(expected)) + half);
        char what[96];
        std::snprintf(what, sizeof what, "%.0f Hz %.0f ms echo %d position error (frames)", rate, ms, k);
        expect(std::fabs(static_cast<double>(found) - expected) <= 1.0, what, static_cast<double>(found) - expected);
      }
      if (spacing == std::floor(spacing)) {
        const size_t at = lead + static_cast<size_t>(2.0 * spacing);
        char what[96];
        std::snprintf(what, sizeof what, "%.0f Hz %.0f ms echo 2 level error (dB)", rate, ms);
        expect(std::fabs(db(std::fabs(out.left[at]) / 0.1)) <= 0.1, what, db(std::fabs(out.left[at]) / 0.1));
      }
    }
  }
}

// DEL-3: a 10 kHz tone through a fractional delay keeps its level.
void fractional() {
  for (const double rate : {44100.0, 48000.0, 96000.0}) {
    for (const double ms : {10.37, 10.5}) {
      const Render out = run(rate, free_time(ms, 0.0), free_config(), static_cast<size_t>(rate), tone(10000.0, rate, 0.3));
      const double gain = db(tone_amplitude(out.left, 10000.0, rate, static_cast<size_t>(0.3 * rate), static_cast<size_t>(0.9 * rate)) / 0.3);
      char what[96];
      std::snprintf(what, sizeof what, "%.0f Hz %.2f ms 10 kHz gain (dB)", rate, ms);
      expect(gain >= -0.7, what, gain);
    }
  }
}

// DEL-1: the largest step after a time change, relative to the largest step of the unchanged render.
double step_ratio(uint32_t smoothing, size_t frames, size_t at, size_t window, double rate) {
  DelayConfig config = free_config();
  config.smoothing = smoothing;
  const Render reference = run(rate, free_time(250.0, 0.0), config, frames, tone(440.0, rate, 0.3));
  const Render stepped = run(rate, free_time(250.0, 0.0), config, frames, tone(440.0, rate, 0.3), nullptr,
    [&](size_t i, DelayValues &values, DelayConfig &) { if (i == at) values.time_ms = {251.3F, 251.3F}; });
  double largest = 0.0, after = 0.0;
  for (size_t i = at; i < at + window; ++i) {
    largest = std::max(largest, std::fabs(reference.left[i] - reference.left[i - 1]));
    after = std::max(after, std::fabs(stepped.left[i] - stepped.left[i - 1]));
  }
  return after / largest;
}

void click() {
  const double rate = 48000.0;
  const size_t at = static_cast<size_t>(1.5 * rate);
  const double repitch = step_ratio(0, 3 * static_cast<size_t>(rate), at, 4096, rate);
  expect(repitch <= 1.5, "Repitch: largest step / steady step, 250 to 251.3 ms", repitch);
  const double fade = step_ratio(1, 3 * static_cast<size_t>(rate), at, 4096, rate);
  expect(fade <= 1.5, "Fade: largest step / steady step, 250 to 251.3 ms", fade);
}

void filter() {
  const double rate = 48000.0;
  // DEL-4: with the filter off, an 18 kHz burst keeps its level through 10 echoes at feedback 0.9.
  const size_t echo = static_cast<size_t>(0.05 * rate);
  const Render off = run(rate, free_time(50.0, 0.9), free_config(), 12 * echo + 2048, [&](size_t i) { return i < 960 ? 0.3 * std::sin(2.0 * kPi * 18000.0 * static_cast<double>(i) / rate) : 0.0; });
  const auto level = [&](size_t k) { return rms_db(off.left, k * echo + 240, k * echo + 720); };
  const double drift = std::fabs(level(10) - level(1) - 9.0 * db(0.9));
  expect(drift <= 0.05, "filter off: 18 kHz level error after 10 echoes at feedback 0.9 (dB)", drift);

  // The band-pass: 0 dB at its frequency, and down at two octaves either side with a width of 2.
  DelayConfig config = free_config();
  config.filter = true;
  DelayValues values = free_time(20.0, 0.0);
  values.filter_hz = 1000.0F;
  values.filter_width = 2.0F;
  for (const auto &[hz, low, high] : {std::tuple{1000.0, -0.2, 0.2}, {4000.0, -40.0, -6.0}, {250.0, -40.0, -6.0}}) {
    const Render out = run(rate, values, config, static_cast<size_t>(rate), tone(hz, rate, 0.3));
    const double gain = db(tone_amplitude(out.left, hz, rate, static_cast<size_t>(0.5 * rate), static_cast<size_t>(0.9 * rate)) / 0.3);
    char what[96];
    std::snprintf(what, sizeof what, "band-pass at 1 kHz, width 2: gain at %.0f Hz (dB)", hz);
    expect(gain >= low && gain <= high, what, gain);
  }
}

// DEL-5: the echo of a synced time sits at the tempo's note length.
void sync() {
  const double rate = 48000.0;
  struct Case { const char *name; uint32_t division; uint32_t feel; double offset; double bpm; double expected_ms; };
  for (const Case &c : {Case{"dotted 1/8 at 120 bpm", 2, 1, 0.0, 120.0, 375.0}, {"triplet 1/4 at 120 bpm", 3, 2, 0.0, 120.0, 1000.0 / 3.0},
         {"1/32 at 120 bpm", 0, 0, 0.0, 120.0, 62.5}, {"1/8 with +10% offset at 120 bpm", 2, 0, 10.0, 120.0, 275.0},
         {"1/8 with -33% offset at 120 bpm", 2, 0, -33.0, 120.0, 167.5}, {"1/4 at 90 bpm", 3, 0, 0.0, 90.0, 666.6667},
         {"1/4 with no tempo yet (120 bpm)", 3, 0, 0.0, 0.0, 500.0}}) {
    DelayConfig config;
    config.division = {c.division, c.division};
    config.feel = {c.feel, c.feel};
    DelayValues values = free_time(250.0, 0.0);
    values.offset_percent = {static_cast<float>(c.offset), static_cast<float>(c.offset)};
    values.tempo_bpm = c.bpm;
    const size_t lead = 100, frames = lead + static_cast<size_t>(c.expected_ms * rate / 1000.0) + 64;
    const Render out = run(rate, values, config, frames, impulse_at(lead, 0.3));
    const double expected = static_cast<double>(lead) + c.expected_ms * rate / 1000.0;
    const size_t found = peak_between(out.left, static_cast<size_t>(std::llround(expected)) - 20, static_cast<size_t>(std::llround(expected)) + 20);
    char what[96];
    std::snprintf(what, sizeof what, "%s: echo position error (frames)", c.name);
    expect(std::fabs(static_cast<double>(found) - expected) <= 1.0, what, static_cast<double>(found) - expected);
  }
}

// DEL-6: Freeze keeps the loop as it is and ignores the input; the longest time is 5 s at every rate.
void freeze() {
  const double rate = 48000.0;
  DelayConfig config = free_config();
  const size_t freeze_at = static_cast<size_t>(0.13 * rate), frames = static_cast<size_t>(6.0 * rate);
  const Source burst = [&](size_t i) { return i < 4800 ? 0.3 * std::sin(2.0 * kPi * 1000.0 * static_cast<double>(i) / rate) : (i > freeze_at + 24000 && i < freeze_at + 48000 ? 0.3 * std::sin(2.0 * kPi * 3000.0 * static_cast<double>(i) / rate) : 0.0); };
  const Render out = run(rate, free_time(100.0, 0.3), config, frames, burst, nullptr, [&](size_t i, DelayValues &, DelayConfig &c) { c.freeze = i >= freeze_at; });
  const size_t loop = static_cast<size_t>(0.1 * rate);
  const double early = rms_db(out.left, freeze_at + 9600, freeze_at + 9600 + loop);
  const double late = rms_db(out.left, frames - loop - 1, frames - 1);
  expect(std::fabs(late - early) <= 0.5, "frozen loop level after 5 s against 0.2 s after Freeze (dB)", late - early);
  expect(early > -40.0, "frozen loop is audible (dB rms)", early);
  double three_khz = 0.0;
  three_khz = tone_amplitude(out.left, 3000.0, rate, frames - loop - 1, frames - 1);
  expect(three_khz < 0.002, "input played while frozen does not enter the loop (3 kHz amplitude)", three_khz);

  for (const double rate_hz : {44100.0, 48000.0, 96000.0}) {
    const size_t lead = 100, total = lead + static_cast<size_t>(5.0 * rate_hz) + 64;
    const Render longest = run(rate_hz, free_time(9000.0, 0.0), free_config(), total, impulse_at(lead, 0.3));
    const double expected = static_cast<double>(lead) + 5.0 * rate_hz;
    const size_t found = peak_between(longest.left, static_cast<size_t>(expected) - 20, static_cast<size_t>(expected) + 20);
    char what[96];
    std::snprintf(what, sizeof what, "%.0f Hz: a 9 s time is held at 5 s, echo position error (frames)", rate_hz);
    expect(std::fabs(static_cast<double>(found) - expected) <= 1.0, what, static_cast<double>(found) - expected);
  }
}

// Ping Pong, the soft-limited loop and bad input.
void safety() {
  const double rate = 48000.0;
  DelayConfig config = free_config();
  config.ping_pong = true;
  const Render pong = run(rate, free_time(50.0, 0.5), config, 6 * 2400, impulse_at(10, 0.2), [](size_t) { return 0.0; });
  const size_t echo = 2400;
  expect(std::fabs(pong.left[10 + echo]) > 0.15 && std::fabs(pong.right[10 + echo]) < 1e-6, "ping pong: first echo of a left impulse stays on the left", pong.left[10 + echo]);
  expect(std::fabs(pong.right[10 + 2 * echo]) > 0.05 && std::fabs(pong.left[10 + 2 * echo]) < 1e-6, "ping pong: second echo crosses to the right", pong.right[10 + 2 * echo]);
  expect(std::fabs(pong.left[10 + 3 * echo]) > 0.02 && std::fabs(pong.right[10 + 3 * echo]) < 1e-6, "ping pong: third echo is back on the left", pong.left[10 + 3 * echo]);

  DelayConfig plain = free_config();
  const Render loud = run(rate, free_time(30.0, 1.0), plain, 10 * static_cast<size_t>(rate), [](size_t i) { return i < 48000 ? ((i * 2654435761U) % 2001) / 1000.0 - 1.0 : 0.0; });
  double peak = 0.0;
  for (const double sample : loud.left) peak = std::max(peak, std::fabs(sample));
  expect(peak <= 2.0, "feedback 1 on loud noise stays bounded (peak)", peak);

  const Render dirty = run(rate, free_time(50.0, 0.5), plain, 4 * static_cast<size_t>(rate), [&](size_t i) -> double {
    if (i == 5000) return std::nan("");
    if (i == 9000) return std::numeric_limits<double>::infinity();
    return i < 20000 ? 0.2 * std::sin(0.05 * static_cast<double>(i)) : 0.0;
  });
  size_t bad = 0;
  for (const double sample : dirty.left) if (!std::isfinite(sample)) ++bad;
  expect(bad == 0, "non-finite input leaves no non-finite output samples", static_cast<double>(bad));

  const Render quiet = run(rate, free_time(50.0, 0.9), plain, 6 * static_cast<size_t>(rate), [](size_t i) { return i < 48000 ? 0.4 * std::sin(0.3 * static_cast<double>(i)) : 0.0; });
  size_t tiny = 0;
  for (size_t i = 5 * static_cast<size_t>(rate); i < quiet.left.size(); ++i) if (quiet.left[i] != 0.0 && std::fabs(quiet.left[i]) < 1e-20) ++tiny;
  expect(tiny == 0, "output samples in (0, 1e-20) after silence", static_cast<double>(tiny));
}

}  // namespace

int main(int argc, char **argv) {
  const char *group = argc > 1 ? argv[1] : "";
  if (std::strcmp(group, "position") == 0) position();
  else if (std::strcmp(group, "fractional") == 0) fractional();
  else if (std::strcmp(group, "click") == 0) click();
  else if (std::strcmp(group, "filter") == 0) filter();
  else if (std::strcmp(group, "sync") == 0) sync();
  else if (std::strcmp(group, "freeze") == 0) freeze();
  else if (std::strcmp(group, "safety") == 0) safety();
  else { std::printf("unknown group\n"); return 2; }
  return failures == 0 ? 0 : 1;
}
