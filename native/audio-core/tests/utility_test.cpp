// Utility kernel measurements (src/utility_kernel.h). The executable prints each value and fails when a bound is broken; one ctest per
// group (see CMakeLists.txt).
#include "../src/utility_kernel.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <functional>
#include <utility>
#include <vector>

using namespace daw::audio_core;

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kRate = 48000.0;
int failures = 0;

void expect(bool ok, const char *what, double value) {
  std::printf("%s %s = %.6f\n", ok ? "PASS" : "FAIL", what, value);
  if (!ok) ++failures;
}

using Source = std::function<double(size_t)>;

Source tone(double hz, double amplitude, double sign = 1.0) {
  return [=](size_t i) { return sign * amplitude * std::sin(2.0 * kPi * hz * static_cast<double>(i) / kRate); };
}

struct Stereo {
  std::vector<double> left;
  std::vector<double> right;
};

// The values and config at each frame: the kernel reads them every kControlFrames.
using Controls = std::function<std::pair<UtilityValues, UtilityConfig>(size_t)>;

Stereo run(const Controls &controls, size_t frames, const Source &left_source, const Source &right_source) {
  UtilityKernel kernel;
  kernel.prepare(kRate);
  Stereo out{std::vector<double>(frames), std::vector<double>(frames)};
  for (size_t i = 0; i < frames; ++i) {
    const auto [values, config] = controls(i);
    float l = 0.0F, r = 0.0F;
    kernel.process(values, config, static_cast<float>(left_source(i)), static_cast<float>(right_source(i)), l, r);
    out.left[i] = l;
    out.right[i] = r;
  }
  return out;
}

Stereo run(const UtilityValues &values, const UtilityConfig &config, size_t frames, const Source &left_source, const Source &right_source) {
  return run([&](size_t) { return std::make_pair(values, config); }, frames, left_source, right_source);
}

Stereo source(size_t frames, const Source &left_source, const Source &right_source) {
  Stereo out{std::vector<double>(frames), std::vector<double>(frames)};
  for (size_t i = 0; i < frames; ++i) {
    out.left[i] = static_cast<float>(left_source(i));
    out.right[i] = static_cast<float>(right_source(i));
  }
  return out;
}

// Complex DFT bin of x at one frequency over [from, end), Hann-windowed.
std::pair<double, double> bin(const std::vector<double> &x, size_t from, double hz) {
  double re = 0.0, im = 0.0;
  const size_t n = x.size() - from;
  for (size_t i = 0; i < n; ++i) {
    const double w = 0.5 - 0.5 * std::cos(2.0 * kPi * static_cast<double>(i) / static_cast<double>(n));
    const double phase = 2.0 * kPi * hz * static_cast<double>(from + i) / kRate;
    re += w * x[from + i] * std::cos(phase);
    im -= w * x[from + i] * std::sin(phase);
  }
  return {re, im};
}

double magnitude(const std::vector<double> &x, size_t from, double hz) {
  const auto [re, im] = bin(x, from, hz);
  return std::sqrt(re * re + im * im);
}

double db(double ratio) { return 20.0 * std::log10(ratio); }

double rms(const std::vector<double> &x, size_t from = 0) {
  double sum = 0.0;
  for (size_t i = from; i < x.size(); ++i) sum += x[i] * x[i];
  return std::sqrt(sum / static_cast<double>(x.size() - from));
}

// U1: a gain step at the peak of a 100 Hz sine is a ramp, not a jump (before: 0.499 for 0 to -6 dB).
void step() {
  const size_t frames = 4800;
  const size_t at = 120;  // the peak of 100 Hz at 48 kHz, and a control frame
  const auto stepped = run([&](size_t i) { return std::make_pair(UtilityValues{.gain_db = i < at ? 0.0F : -6.0206F}, UtilityConfig{}); },
    frames, tone(100.0, 1.0), tone(100.0, 1.0));
  double largest = 0.0;
  for (size_t i = 1; i < frames; ++i) largest = std::max(largest, std::fabs(stepped.left[i] - stepped.left[i - 1]));
  expect(largest <= 0.05, "100 Hz peak, 0 to -6 dB: largest sample-to-sample change", largest);
  expect(std::fabs(stepped.left[frames - 1] - 0.5 * std::sin(2.0 * kPi * 100.0 * (frames - 1) / kRate)) < 1e-4, "settles to -6 dB", stepped.left[frames - 1]);

  // A balance, width and mid/side jump is a ramp too.
  const auto moved = run([&](size_t i) {
    return std::make_pair(UtilityValues{.balance = i < at ? 0.0F : 1.0F, .width = i < at ? 1.0F : 0.0F}, UtilityConfig{}); },
    frames, tone(100.0, 1.0), tone(100.0, 0.5));
  double move_step = 0.0;
  for (size_t i = 1; i < frames; ++i) move_step = std::max(move_step, std::fabs(moved.left[i] - moved.left[i - 1]));
  expect(move_step <= 0.05, "balance and width jump: largest sample-to-sample change", move_step);
}

// U2: the DC filter is off by default and bit-exact; on, a 4 Hz one-pole high-pass that leaves 40 Hz alone.
void dc() {
  const size_t frames = 48000;
  const auto input = source(frames, tone(997.0, 0.5), tone(311.0, 0.25));
  const auto off = run(UtilityValues{}, UtilityConfig{}, frames, tone(997.0, 0.5), tone(311.0, 0.25));
  double worst = 0.0;
  for (size_t i = 0; i < frames; ++i) worst = std::max({worst, std::fabs(off.left[i] - input.left[i]), std::fabs(off.right[i] - input.right[i])});
  expect(worst == 0.0, "DC off nulls against the input (peak difference)", worst);

  UtilityConfig on;
  on.dc_block = true;
  const auto filtered = run(UtilityValues{}, on, frames, tone(40.0, 0.5), tone(40.0, 0.5));
  const auto reference = source(frames, tone(40.0, 0.5), tone(40.0, 0.5));
  const size_t from = 24000;  // past the settling of the filter
  const auto [out_re, out_im] = bin(filtered.left, from, 40.0);
  const auto [in_re, in_im] = bin(reference.left, from, 40.0);
  const double level = db(std::hypot(out_re, out_im) / std::hypot(in_re, in_im));
  double phase = (std::atan2(out_im, out_re) - std::atan2(in_im, in_re)) * 180.0 / kPi;
  while (phase > 180.0) phase -= 360.0;
  while (phase < -180.0) phase += 360.0;
  expect(std::fabs(level) <= 0.05, "DC on: level at 40 Hz (dB, before -0.26)", level);
  expect(std::fabs(phase) <= 8.0, "DC on: phase at 40 Hz (degrees, before +14)", phase);

  const auto decay = run(UtilityValues{}, on, frames, [](size_t) { return 0.1; }, [](size_t) { return 0.1; });
  double after_one_second = 0.0;
  for (size_t i = 47000; i < frames; ++i) after_one_second = std::max(after_one_second, std::fabs(decay.left[i]));
  expect(after_one_second < 1e-4, "DC input 0.1 after 1 s (peak)", after_one_second);

  const size_t silence = 10 * 48000;
  const auto quiet = run(UtilityValues{}, on, silence + 480, [](size_t i) { return i < 4800 ? 0.3 * std::sin(0.01 * static_cast<double>(i)) + 0.2 : 0.0; },
    [](size_t i) { return i < 4800 ? -0.2 : 0.0; });
  size_t subnormal = 0;
  for (size_t i = 0; i < quiet.left.size(); ++i) {
    if (std::fpclassify(static_cast<float>(quiet.left[i])) == FP_SUBNORMAL || std::fpclassify(static_cast<float>(quiet.right[i])) == FP_SUBNORMAL) ++subnormal;
  }
  expect(subnormal == 0, "denormal outputs over 10 s of silence", static_cast<double>(subnormal));
  expect(quiet.left.back() == 0.0 && quiet.right.back() == 0.0, "exact zero after 10 s of silence", quiet.left.back());
}

// U3: Bass Mono. 4th-order Linkwitz-Riley split at 150 Hz.
void bassmono() {
  const size_t frames = 24000;
  const size_t from = 12000;
  UtilityConfig config;
  config.bass_mono = true;
  UtilityValues values;
  values.bass_mono_hz = 150.0F;

  // The side signal (L - R) / 2 of an out-of-phase tone is the tone itself. The lows of both channels are summed and cancel exactly;
  // what is left is the tone's share in the high band. A 4th-order Linkwitz-Riley high-pass at fc leaves x^4 / (1 + x^4) of a tone at
  // x = f / fc: -22.5 dB at 80 Hz (x = 0.533) and -46 dB at 40 Hz (x = 0.267). The research's 40 dB at 80 Hz needs an 8th-order split.
  const auto side_level = [&](double hz) {
    const auto out = run(values, config, frames, tone(hz, 0.5), tone(hz, 0.5, -1.0));
    std::vector<double> side(frames);
    for (size_t i = 0; i < frames; ++i) side[i] = 0.5 * (out.left[i] - out.right[i]);
    return db(rms(side, from) / (0.5 / std::sqrt(2.0)));
  };
  const auto lr4 = [](double hz) { const double x4 = std::pow(hz / 150.0, 4.0); return db(x4 / (1.0 + x4)); };
  const double side_80 = side_level(80.0);
  expect(std::fabs(side_80 - lr4(80.0)) <= 0.2, "out-of-phase 80 Hz at 150 Hz: side level (dB), the LR4 value -22.5 within 0.2", side_80);
  const double side_40 = side_level(40.0);
  expect(side_40 <= -40.0, "out-of-phase 40 Hz at 150 Hz: side level at least 40 dB below the input (dB)", side_40);

  const auto high = run(values, config, frames, tone(2000.0, 0.5), tone(2000.0, 0.5, -1.0));
  const auto high_in = source(frames, tone(2000.0, 0.5), tone(2000.0, 0.5, -1.0));
  const double high_change = db(magnitude(high.left, from, 2000.0) / magnitude(high_in.left, from, 2000.0));
  expect(std::fabs(high_change) <= 0.1, "out-of-phase 2 kHz at 150 Hz: level change (dB)", high_change);

  // Mono material passes the all-pass sum unchanged, whatever the cutoff.
  double worst = 0.0;
  for (const double cutoff : {50.0, 150.0, 500.0}) {
    UtilityValues at;
    at.bass_mono_hz = static_cast<float>(cutoff);
    for (const double hz : {40.0, cutoff, 3.0 * cutoff, 5000.0}) {
      const auto out = run(at, config, frames, tone(hz, 0.5), tone(hz, 0.5));
      const auto in = source(frames, tone(hz, 0.5), tone(hz, 0.5));
      worst = std::max(worst, std::fabs(db(magnitude(out.left, from, hz) / magnitude(in.left, from, hz))));
    }
  }
  expect(worst <= 0.1, "mono material through the split: largest level change (dB)", worst);

  UtilityConfig audition = config;
  audition.bass_mono_audition = true;
  const auto lows = run(values, audition, frames, tone(80.0, 0.5), tone(80.0, 0.5));
  const auto lows_in = source(frames, tone(80.0, 0.5), tone(80.0, 0.5));
  const double kept = db(magnitude(lows.left, from, 80.0) / magnitude(lows_in.left, from, 80.0));
  expect(std::fabs(kept) <= 1.0, "audition: 80 Hz stays (dB)", kept);
  const auto highs = run(values, audition, frames, tone(2000.0, 0.5), tone(2000.0, 0.5));
  const double cut = db(magnitude(highs.left, from, 2000.0) / magnitude(high_in.left, from, 2000.0));
  expect(cut <= -40.0, "audition: 2 kHz is removed (dB)", cut);
}

// U4: one Balance, as Live's. The near side stays at 0 dB, the far side fades, nothing gets louder.
void balance() {
  const size_t frames = 9600;
  const auto steady = [&](float balance, double left_in, double right_in) {
    UtilityValues values;
    values.balance = balance;
    const auto out = run(values, UtilityConfig{}, frames, [=](size_t) { return left_in; }, [=](size_t) { return right_in; });
    return std::make_pair(out.left[frames - 1], out.right[frames - 1]);
  };
  double louder = 0.0;
  for (int step = -20; step <= 20; ++step) {
    const float b = static_cast<float>(step) / 20.0F;
    const auto [l, r] = steady(b, 1.0, 1.0);
    louder = std::max({louder, l - 1.0, r - 1.0});
    const double far = 1.0 - std::fabs(b);
    if (b > 0.0F && std::fabs(l - far) > 1e-6) expect(false, "far side follows 1 - |balance| (left)", l);
    if (b < 0.0F && std::fabs(r - far) > 1e-6) expect(false, "far side follows 1 - |balance| (right)", r);
  }
  expect(louder <= 1e-6, "no balance setting is louder than the input", louder);
  const auto [half_left, half_right] = steady(0.5F, 1.0, 1.0);
  expect(std::fabs(db(half_left) + 6.0206) < 1e-3 && half_right == 1.0, "balance 50%: far side -6.02 dB, near side 0 dB", db(half_left));
  const auto [centre_left, centre_right] = steady(0.0F, 0.3, -0.7);
  expect(std::fabs(centre_left - 0.3) < 1e-6 && std::fabs(centre_right + 0.7) < 1e-6, "balance centre is transparent", centre_left);
  const auto [hard_left, hard_right] = steady(-1.0F, 1.0, 1.0);
  expect(hard_right == 0.0 && hard_left == 1.0, "hard left: no +3 dB boost, right silent", hard_left);

  // Balance cannot carry a left-only signal to the right; Channel Mode Swap does.
  UtilityConfig swap;
  swap.channel_mode = 3;
  const auto swapped = run(UtilityValues{}, swap, frames, [](size_t) { return 1.0; }, [](size_t) { return 0.0; });
  expect(swapped.left[frames - 1] == 0.0 && std::fabs(swapped.right[frames - 1] - 1.0) < 1e-6, "swap moves a left-only signal to the right", swapped.right[frames - 1]);
}

// U5: Mute, Phase L/R, Channel Mode and a Gain that reaches minus infinity.
void channel() {
  const size_t frames = 9600;
  const Source left = tone(440.0, 0.5);
  const Source right = tone(660.0, 0.25);
  const auto input = source(frames, left, right);

  UtilityValues floor;
  floor.gain_db = -70.0F;
  const auto silent = run(floor, UtilityConfig{}, frames, left, right);
  double peak = 0.0;
  for (size_t i = 4800; i < frames; ++i) peak = std::max({peak, std::fabs(silent.left[i]), std::fabs(silent.right[i])});
  expect(peak == 0.0, "gain at minimum is digital silence (peak |x|)", peak);

  UtilityConfig muted;
  muted.mute = true;
  const auto mute = run(UtilityValues{}, muted, frames, left, right);
  peak = 0.0;
  for (size_t i = 4800; i < frames; ++i) peak = std::max({peak, std::fabs(mute.left[i]), std::fabs(mute.right[i])});
  expect(peak == 0.0, "mute is digital silence (peak |x|)", peak);

  UtilityConfig phase;
  phase.phase_left = true;
  const auto inverted = run(UtilityValues{}, phase, frames, left, right);
  // Summed with the original, Phase L leaves the right channel alone and nothing on the left.
  double left_sum = 0.0, right_sum = 0.0;
  for (size_t i = 0; i < frames; ++i) {
    left_sum = std::max(left_sum, std::fabs(inverted.left[i] + input.left[i]));
    right_sum = std::max(right_sum, std::fabs(inverted.right[i] + input.right[i] - 2.0 * input.right[i]));
  }
  expect(left_sum <= 1e-7 && right_sum <= 1e-7, "Phase L: the sum with the original is the right channel only (peak)", left_sum + right_sum);

  const auto expect_modes = [&](uint32_t mode, const std::vector<double> &want_left, const std::vector<double> &want_right, const char *what) {
    UtilityConfig config;
    config.channel_mode = mode;
    const auto out = run(UtilityValues{}, config, frames, left, right);
    double worst = 0.0;
    for (size_t i = 0; i < frames; ++i) worst = std::max({worst, std::fabs(out.left[i] - want_left[i]), std::fabs(out.right[i] - want_right[i])});
    expect(worst <= 1e-6, what, worst);
  };
  expect_modes(1, input.left, input.left, "channel mode Left: the left channel on both sides");
  expect_modes(2, input.right, input.right, "channel mode Right: the right channel on both sides");
  expect_modes(3, input.right, input.left, "channel mode Swap");
  expect_modes(0, input.left, input.right, "channel mode Both");

  // Left and Right ignore Width.
  UtilityValues narrow;
  narrow.width = 0.0F;
  UtilityConfig only_left;
  only_left.channel_mode = 1;
  const auto kept = run(narrow, only_left, frames, left, right);
  double drift = 0.0;
  for (size_t i = 0; i < frames; ++i) drift = std::max(drift, std::fabs(kept.left[i] - input.left[i]));
  expect(drift <= 1e-6, "channel mode Left ignores Width (peak difference)", drift);
}

// U6: Width, and Mid/Side mode from mono through as played to the side alone.
void width() {
  const size_t frames = 4800;
  const Source left = tone(440.0, 0.5);
  const Source right = tone(660.0, 0.25);
  const auto input = source(frames, left, right);

  UtilityValues mono;
  mono.width = 0.0F;
  const auto summed = run(mono, UtilityConfig{}, frames, left, right);
  double worst = 0.0;
  for (size_t i = 0; i < frames; ++i) worst = std::max({worst, std::fabs(summed.left[i] - summed.right[i]), std::fabs(summed.left[i] - 0.5 * (input.left[i] + input.right[i]))});
  expect(worst <= 1e-6, "width 0% is the mono sum (peak difference)", worst);

  UtilityConfig by_side;
  by_side.width_mode = 1;
  const auto energy = [&](float mid_side) {
    UtilityValues values;
    values.mid_side = mid_side;
    const auto out = run(values, by_side, frames, left, right);
    double mid = 0.0, side = 0.0;
    for (size_t i = 2400; i < frames; ++i) {
      mid += 0.25 * (out.left[i] + out.right[i]) * (out.left[i] + out.right[i]);
      side += 0.25 * (out.left[i] - out.right[i]) * (out.left[i] - out.right[i]);
    }
    return std::make_pair(std::sqrt(mid), std::sqrt(side));
  };
  const auto [mono_mid, mono_side] = energy(-1.0F);
  expect(mono_side < 1e-6 && mono_mid > 0.1, "mid/side -1 is mono (side level)", mono_side);
  const auto [played_mid, played_side] = energy(0.0F);
  const auto [source_mid, source_side] = [&] {
    double mid = 0.0, side = 0.0;
    for (size_t i = 2400; i < frames; ++i) {
      mid += 0.25 * (input.left[i] + input.right[i]) * (input.left[i] + input.right[i]);
      side += 0.25 * (input.left[i] - input.right[i]) * (input.left[i] - input.right[i]);
    }
    return std::make_pair(std::sqrt(mid), std::sqrt(side));
  }();
  expect(std::fabs(played_mid - source_mid) < 1e-6 && std::fabs(played_side - source_side) < 1e-6, "mid/side 0 is as played (mid level difference)", played_mid - source_mid);
  const auto [side_mid, side_only] = energy(1.0F);
  expect(side_mid < 1e-6 && side_only > 0.1, "mid/side +1 is the side alone (mid level)", side_mid);

  double step = 0.0, previous = 0.0;
  for (int i = -40; i <= 40; ++i) {
    const auto [mid, side] = energy(static_cast<float>(i) / 40.0F);
    const double ratio = side / (mid + side);
    if (i > -40) step = std::max(step, std::fabs(ratio - previous));
    previous = ratio;
  }
  expect(step < 0.05, "mid/side sweep is continuous (largest step in side share)", step);
}

// Non-finite input, extreme settings.
void safety() {
  const size_t frames = 9600;
  UtilityValues extreme;
  extreme.gain_db = 35.0F;
  extreme.balance = -1.0F;
  extreme.width = 2.0F;
  extreme.mid_side = 1.0F;
  extreme.bass_mono_hz = 50.0F;
  UtilityConfig everything;
  everything.phase_left = everything.bass_mono = everything.dc_block = true;
  everything.matrix = 1;
  everything.width_mode = 1;
  const auto out = run(extreme, everything, frames,
    [](size_t i) { return i % 97 == 0 ? std::nan("") : (i % 89 == 0 ? INFINITY : 0.9); }, [](size_t i) { return i % 83 == 0 ? -INFINITY : 0.7; });
  bool finite = true;
  for (size_t i = 0; i < frames; ++i) finite = finite && std::isfinite(out.left[i]) && std::isfinite(out.right[i]);
  expect(finite, "non-finite input and extreme settings stay finite", finite ? 1.0 : 0.0);
}

}  // namespace

int main(int argc, char **argv) {
  const char *group = argc > 1 ? argv[1] : "";
  const std::pair<const char *, void (*)()> groups[] = {{"step", step}, {"dc", dc}, {"bassmono", bassmono}, {"balance", balance},
    {"channel", channel}, {"width", width}, {"safety", safety}};
  for (const auto &[name, body] : groups) if (std::strcmp(group, name) == 0) body();
  return failures == 0 ? 0 : 1;
}
