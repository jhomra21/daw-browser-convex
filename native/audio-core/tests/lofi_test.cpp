// Lo-Fi kernel measurements (src/lofi_kernel.h). The executable prints each value and fails when a bound is broken; one ctest per
// group (see CMakeLists.txt).
#include "../src/lofi_kernel.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <functional>
#include <set>
#include <vector>

using namespace daw::audio_core;

namespace {

constexpr double kPi = 3.14159265358979323846;
int failures = 0;

void expect(bool ok, const char *what, double value) {
  std::printf("%s %s = %.6f\n", ok ? "PASS" : "FAIL", what, value);
  if (!ok) ++failures;
}

using Source = std::function<double(size_t)>;

Source tone(double hz, double rate, double amplitude) {
  return [=](size_t i) { return amplitude * std::sin(2.0 * kPi * hz * static_cast<double>(i) / rate); };
}

std::vector<double> run(double rate, const LoFiValues &values, const LoFiConfig &config, size_t frames, const Source &source) {
  LoFiKernel kernel;
  kernel.prepare(rate);
  std::vector<double> out(frames);
  for (size_t i = 0; i < frames; ++i) {
    float l = 0.0F, r = 0.0F;
    const float x = static_cast<float>(source(i));
    kernel.process(values, config, x, x, l, r);
    out[i] = l;
  }
  return out;
}

// Magnitude of the Hann-windowed DFT at one frequency.
double magnitude(const std::vector<double> &x, size_t from, double hz, double rate) {
  double re = 0.0, im = 0.0;
  const size_t n = x.size() - from;
  for (size_t i = 0; i < n; ++i) {
    const double w = 0.5 - 0.5 * std::cos(2.0 * kPi * static_cast<double>(i) / static_cast<double>(n));
    const double phase = 2.0 * kPi * hz * static_cast<double>(from + i) / rate;
    re += w * x[from + i] * std::cos(phase);
    im -= w * x[from + i] * std::sin(phase);
  }
  return std::sqrt(re * re + im * im) / static_cast<double>(n);
}

double rms(const std::vector<double> &x, size_t from) {
  double sum = 0.0;
  for (size_t i = from; i < x.size(); ++i) sum += x[i] * x[i];
  return std::sqrt(sum / static_cast<double>(x.size() - from));
}

double db(double ratio) { return 20.0 * std::log10(std::fmax(ratio, 1.0e-30)); }

// L1: a reported fractional bit depth rounds the same way everywhere (ties up, as Math.round).
void bits() {
  const double expected[][2] = {{11.4, 11.0}, {11.5, 12.0}, {11.9, 12.0}, {2.0, 2.0}, {24.0, 24.0}, {1.2, 2.0}, {30.0, 24.0}};
  for (const auto &[reported, bits_used] : expected) {
    expect(LoFiKernel::bit_count(static_cast<float>(reported)) == static_cast<uint32_t>(bits_used), "bit count for a reported depth", reported);
  }
  for (const auto &[reported, bits_used] : {std::pair{11.4, 11U}, std::pair{11.5, 12U}, std::pair{11.9, 12U}}) {
    LoFiValues values;
    values.bit_depth = static_cast<float>(reported);
    values.noise_db = -120.0F;
    const auto out = run(48000.0, values, {}, 8192, tone(997.0, 48000.0, 0.9));
    std::set<long> levels;
    for (size_t i = 1000; i < out.size(); ++i) levels.insert(std::lround(out[i] * (std::pow(2.0, bits_used - 1) - 1.0)));
    const size_t most = static_cast<size_t>(2.0 * (std::pow(2.0, bits_used - 1) - 1.0) * 0.9) + 2;
    expect(levels.size() <= most && levels.size() > most * 3 / 4, "distinct levels of a reported depth", static_cast<double>(levels.size()));
  }
}

// L2: the same Hz setting puts the alias and image tones at the same frequencies on every host rate.
void rate() {
  LoFiValues values;
  values.bit_depth = 24.0F;
  values.rate_hz = 12000.0F;
  values.noise_db = -120.0F;
  for (const double host : {44100.0, 48000.0, 96000.0}) {
    const size_t frames = static_cast<size_t>(host);
    const auto out = run(host, values, {}, frames, tone(5000.0, host, 0.5));
    double best = 0.0, best_hz = 0.0;
    for (double hz = 6800.0; hz <= 7200.0; hz += 1.0) {
      const double m = magnitude(out, frames / 4, hz, host);
      if (m > best) { best = m; best_hz = hz; }
    }
    expect(std::fabs(best_hz - 7000.0) <= 1.0, "image of 5 kHz at a 12 kHz rate, peak frequency (Hz)", best_hz);
    expect(db(best / 0.25) > -20.0, "image of 5 kHz at a 12 kHz rate, level rel. input (dB)", db(best / 0.25));
  }
}

// L3: the pre-filter leaves no alias, and passes what the reduced rate can carry.
void prefilter() {
  LoFiValues values;
  values.bit_depth = 24.0F;
  values.rate_hz = 12000.0F;
  values.noise_db = -120.0F;
  LoFiConfig config;
  const size_t frames = 48000;
  const auto open = run(48000.0, values, config, frames, tone(10000.0, 48000.0, 0.5));
  config.pre_filter = true;
  const auto filtered = run(48000.0, values, config, frames, tone(10000.0, 48000.0, 0.5));
  const double input = 0.5 / std::sqrt(2.0);
  expect(db(rms(open, 12000) / input) > -20.0, "10 kHz at ratio 0.25, pre-filter off: output rel. input (dB)", db(rms(open, 12000) / input));
  expect(db(rms(filtered, 12000) / input) <= -40.0, "10 kHz at ratio 0.25, pre-filter on: output rel. input (dB)", db(rms(filtered, 12000) / input));
  expect(db(magnitude(filtered, 12000, 2000.0, 48000.0) / 0.25) <= -40.0, "alias at 2 kHz rel. input (dB)", db(magnitude(filtered, 12000, 2000.0, 48000.0) / 0.25));
  const auto passband = run(48000.0, values, config, frames, tone(2000.0, 48000.0, 0.5));
  const auto gain = db(rms(passband, 12000) / input);
  expect(gain > -3.0 && gain < 1.0, "2 kHz through the pre-filter (dB)", gain);
}

// L3 (sub-sample clock): the held value is the input at the instant the rate clock fired. The clock is replayed here from its definition
// (a phase that gains rate / host per frame and fires at one), and the input is read at that instant, between two frames. At a
// whole ratio the instant is a frame and the option changes nothing.
void subsample() {
  LoFiValues values;
  values.bit_depth = 24.0F;
  values.rate_hz = 12000.0F;
  values.noise_db = -120.0F;
  for (const double host : {44100.0, 88200.0}) {
    const size_t frames = static_cast<size_t>(host / 4);
    const double hz = 5000.0;
    LoFiConfig config;
    const auto nearest = run(host, values, config, frames, tone(hz, host, 0.5));
    config.sub_sample_clock = true;
    const auto exact = run(host, values, config, frames, tone(hz, host, 0.5));
    double nearest_error = 0.0, exact_error = 0.0, energy = 0.0, phase = 1.0, held = 0.0;
    const double ratio = 12000.0 / host;
    for (size_t n = 0; n < frames; ++n) {
      phase += ratio;
      if (phase >= 1.0) {
        phase -= 1.0;
        held = 0.5 * std::sin(2.0 * kPi * hz * (static_cast<double>(n) - phase / ratio) / host);
      }
      if (n < 100) continue;
      nearest_error += (nearest[n] - held) * (nearest[n] - held);
      exact_error += (exact[n] - held) * (exact[n] - held);
      energy += held * held;
    }
    std::printf("host %.0f: nearest-frame error %.2f dB, sub-sample error %.2f dB\n", host, db(std::sqrt(nearest_error / energy)), db(std::sqrt(exact_error / energy)));
    expect(db(std::sqrt(exact_error / energy)) <= -35.0, "held values vs the input at the clock instant, sub-sample on, error rel. (dB)", db(std::sqrt(exact_error / energy)));
    expect(db(std::sqrt(nearest_error / energy)) >= -25.0, "held values vs the input at the clock instant, sub-sample off, error rel. (dB)", db(std::sqrt(nearest_error / energy)));
  }
  LoFiConfig on;
  on.sub_sample_clock = true;
  const auto whole_off = run(48000.0, values, {}, 9600, tone(5000.0, 48000.0, 0.5));
  const auto whole_on = run(48000.0, values, on, 9600, tone(5000.0, 48000.0, 0.5));
  double largest = 0.0;
  for (size_t n = 0; n < whole_off.size(); ++n) largest = std::fmax(largest, std::fabs(whole_off[n] - whole_on[n]));
  expect(largest < 1.0e-9, "whole ratio (48 kHz at 12 kHz): sub-sample on vs off, largest difference", largest);
}

// L4: clipping at one applies only when the signal is quantized or the rate is reduced.
void clip() {
  LoFiValues values;
  values.bit_depth = 24.0F;
  values.rate_hz = 96000.0F;
  values.noise_db = -120.0F;
  const size_t frames = 48000;
  const auto source = tone(997.0, 48000.0, 4.0);
  const auto passed = run(48000.0, values, {}, frames, source);
  double error = 0.0, energy = 0.0;
  for (size_t i = 0; i < frames; ++i) {
    const double x = static_cast<double>(static_cast<float>(source(i)));
    error += (passed[i] - x) * (passed[i] - x);
    energy += x * x;
  }
  expect(db(std::sqrt(error / energy)) <= -120.0, "24 bit at full rate, error rel. input, input to 4 (dB)", db(std::sqrt(error / energy)));
  values.bit_depth = 16.0F;
  const auto sixteen = run(48000.0, values, {}, frames, source);
  double peak = 0.0;
  for (const double v : sixteen) peak = std::fmax(peak, std::fabs(v));
  expect(peak <= 1.0, "16 bit clips at the rail, peak", peak);
  values.bit_depth = 24.0F;
  values.rate_hz = 24000.0F;
  const auto halved = run(48000.0, values, {}, frames, source);
  peak = 0.0;
  for (const double v : halved) peak = std::fmax(peak, std::fabs(v));
  expect(peak <= 1.0, "24 bit at half rate clips at the rail, peak", peak);
}

// L5: Floor leaves silence at minus one LSB; the correction brings it to zero.
void floor_offset() {
  LoFiValues values;
  values.bit_depth = 8.0F;
  values.noise_db = -120.0F;
  LoFiConfig config;
  config.quantization = 1;
  const auto raw = run(48000.0, values, config, 9600, [](size_t) { return 0.0; });
  expect(std::fabs(rms(raw, 1000)) > 0.003, "Floor on silence, 8 bit, correction off: rms", rms(raw, 1000));
  config.dc_correction = true;
  const auto fixed = run(48000.0, values, config, 9600, [](size_t) { return 0.0; });
  double peak = 0.0;
  for (const double v : fixed) peak = std::fmax(peak, std::fabs(v));
  expect(peak < 1.0e-6, "Floor on silence, 8 bit, correction on: peak", peak);
}

// A non-finite input leaves no non-finite output.
void safety() {
  LoFiValues values;
  values.bit_depth = 4.0F;
  values.rate_hz = 5000.0F;
  values.jitter = 1.0F;
  LoFiConfig config;
  config.pre_filter = true;
  config.post_filter = true;
  LoFiKernel kernel;
  kernel.prepare(48000.0);
  bool finite = true;
  for (size_t i = 0; i < 9600; ++i) {
    float l = 0.0F, r = 0.0F;
    const float x = i == 100 ? std::numeric_limits<float>::infinity() : i == 200 ? std::numeric_limits<float>::quiet_NaN() : static_cast<float>(std::sin(0.3 * static_cast<double>(i)));
    kernel.process(values, config, x, x, l, r);
    finite = finite && std::isfinite(l) && std::isfinite(r);
  }
  expect(finite, "non-finite input leaves finite output", finite ? 1.0 : 0.0);
}

}  // namespace

int main(int argc, char **argv) {
  const char *group = argc > 1 ? argv[1] : "";
  const std::pair<const char *, void (*)()> groups[] = {{"bits", bits}, {"rate", rate}, {"prefilter", prefilter}, {"subsample", subsample}, {"clip", clip},
    {"floor", floor_offset}, {"safety", safety}};
  for (const auto &[name, body] : groups) if (std::strcmp(group, name) == 0) body();
  return failures == 0 ? 0 : 1;
}
