#pragma once

// Spectral STFT kernel, independent of the audio-core graph so it can be measured on its own.
//
// One analysis frame takes the last N input samples of both channels (a periodic sqrt-Hann window), packs them into one
// complex FFT (left real, right imaginary), splits the two spectra, runs the selected mode on each, packs them back, inverse
// transforms once and overlap-adds the sqrt-Hann synthesis window scaled by 2 / overlap. The window pair satisfies COLA at
// overlap 2 and 4, so an unmodified frame reconstructs the input. Everything between the float rings (input, sidechain, the
// published per-bin state) is double: the legacy worklet reproduces it with Float32Array only where this file stores float.
//
// Levels are normalised by 2 / (N * coherent gain), so a bin-centred full-scale sine reads 0 dBFS at every FFT size. That is
// the unit of the Gate threshold. Magnitudes the kernel keeps for a successor stage (Noise Reduce profile) stay raw because they
// are rescaled between FFT sizes by the ratio of the sizes.
//
// Modes:
//   Freeze      captures magnitude and, per spectral peak, the phase advance between two frames; every later frame advances the
//               captured phases by that amount, so a frozen sinusoid keeps its frequency instead of repeating one frame.
//   Gate        a per-bin gate on the normalised magnitude with attack and release at the hop rate.
//   Morph       magnitude blend with the sidechain, the phase stays the input's.
//   Shift/Blur  shifts and smooths magnitudes; each peak keeps its neighbourhood's phase relation (identity phase locking) and
//               advances by the frequency it was shifted to, so a shifted sinusoid stays one clean sinusoid.
//   HPSS        soft masks H^2 / (H^2 + P^2) from a causal median over the last 31 frames (harmonic) and over 31 bins
//               (percussive), kept as sorted windows so a frame costs O(bins * 31) moves instead of O(bins * 31 log 31).
//               The knob is a gain crossfade between the two stems: 0 passes the input at 0 dB.
//   Noise       Learn averages the power of every frame while it is on; afterwards a Wiener gain with a decision-directed a-priori
//               SNR (Ephraim and Malah), a spectral floor, time smoothing and a 3-bin frequency smoothing, raised to Reduction.
#include "dsp/numeric_safety.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

namespace daw::audio_core {

inline constexpr uint32_t kSpectralFftMax = 4096;
inline constexpr uint32_t kSpectralBinsMax = kSpectralFftMax / 2 + 1;
inline constexpr uint32_t kSpectralMedianFrames = 31;
inline constexpr uint32_t kSpectralMedianBins = 31;
// The entering bin is inserted before the leaving one is erased, so the window briefly holds one more than its width.
inline constexpr uint32_t kSpectralHpssWindowCapacity = kSpectralMedianBins + 1;
inline constexpr double kSpectralPi = 3.14159265358979323846264338327950288;

enum class SpectralMode : uint32_t { Freeze = 0, Gate = 1, Morph = 2, ShiftBlur = 3, Hpss = 4, NoiseReduce = 5 };

// The controls of one analysis frame, already smoothed by the caller.
struct SpectralControls {
  SpectralMode mode = SpectralMode::Freeze;
  bool freeze = false;
  bool learn = false;
  double sample_rate = 48000.0;
  double gate_threshold_db = -60.0;  // dBFS of a bin-centred sine
  double gate_attack_ms = 10.0;
  double gate_release_ms = 100.0;
  double morph = 0.0;
  double bin_shift = 0.0;
  double blur = 0.0;
  double hpss_balance = 0.0;
  double noise_reduction = 0.0;
  double noise_floor_db = -30.0;
};

// The per-bin state a replacement stage inherits (it is published across threads, hence float), for one channel.
struct SpectralChannelStore {
  float *frozen_magnitude = nullptr;
  float *frozen_phase = nullptr;
  float *frozen_advance = nullptr;
  float *gate_gain = nullptr;
  float *noise_profile = nullptr;  // RMS of the learned noise per bin, raw (unnormalised) FFT units
  bool *freeze_captured = nullptr;
  uint32_t *noise_frames = nullptr;
};

// The rings one frame reads and writes. Rings are power-of-two sized; the input rings hold floats, the output ring the
// unrounded overlap-add.
struct SpectralFrameIo {
  std::array<const float *, 2> input{};
  std::array<const float *, 2> sidechain{};
  uint32_t input_mask = 0;
  uint32_t input_start = 0;
  std::array<double *, 2> output{};
  uint32_t output_mask = 0;
  uint32_t output_start = 0;
};

// Sorted-array helpers for the HPSS medians; every array holds at most 31 floats.
inline void spectral_sorted_insert(float *sorted, uint32_t count, float value) {
  uint32_t at = count;

  while (at > 0 && sorted[at - 1] > value) {
    sorted[at] = sorted[at - 1];
    --at;
  }
  sorted[at] = value;
}

inline void spectral_sorted_erase(float *sorted, uint32_t count, float value) {
  uint32_t at = static_cast<uint32_t>(std::lower_bound(sorted, sorted + count, value) - sorted);

  for (; at + 1 < count; ++at) sorted[at] = sorted[at + 1];
}

// Replaces one occurrence of `old_value` by `value` and keeps the array sorted.
inline void spectral_sorted_replace(float *sorted, uint32_t count, float old_value, float value) {
  uint32_t at = static_cast<uint32_t>(std::lower_bound(sorted, sorted + count, old_value) - sorted);

  if (value > old_value) {
    while (at + 1 < count && sorted[at + 1] < value) {
      sorted[at] = sorted[at + 1];
      ++at;
    }
  } else {
    while (at > 0 && sorted[at - 1] > value) {
      sorted[at] = sorted[at - 1];
      --at;
    }
  }
  sorted[at] = value;
}

inline double spectral_wrap_phase(double phase) {
  return phase - 2.0 * kSpectralPi * std::round(phase / (2.0 * kSpectralPi));
}

class SpectralKernel {
 public:
  uint32_t fft_size() const { return size_; }
#ifdef DAW_SPECTRAL_TRACK_HPSS_WINDOW
  // Test builds only: the most values the percussive window has held at once.
  uint32_t hpss_window_peak() const { return hpss_window_peak_; }
#endif

  // Builds the window and FFT tables. Control side: it evaluates trigonometry for every table entry.
  void prepare(uint32_t fft_size, uint32_t overlap) {
    size_ = fft_size;
    overlap_ = overlap;
    double sum = 0.0, first_bin = 0.0;

    for (uint32_t index = 0; index < size_; ++index) {
      window_[index] = std::sqrt(0.5 - 0.5 * std::cos(2.0 * kSpectralPi * index / size_));
      sum += window_[index];
      first_bin += window_[index] * std::cos(2.0 * kSpectralPi * index / size_);
    }
    leakage_ = std::abs(first_bin / sum);
    normalization_ = 2.0 / sum;  // 2 / (N * coherent gain), the coherent gain being sum / N
    for (uint32_t index = 0; index < size_ / 2; ++index) {
      cosine_[index] = std::cos(2.0 * kSpectralPi * index / size_);
      sine_[index] = std::sin(2.0 * kSpectralPi * index / size_);
    }
    uint32_t bits = 0;

    while ((1u << bits) < size_) ++bits;
    for (uint32_t index = 0; index < size_; ++index) {
      uint32_t reversed = 0;

      for (uint32_t bit = 0; bit < bits; ++bit) reversed |= ((index >> bit) & 1u) << (bits - 1u - bit);
      reverse_[index] = static_cast<uint16_t>(reversed);
    }
  }

  // Multiply a raw bin magnitude by this to read it in full-scale units.
  double normalization() const { return normalization_; }

  void process(const SpectralFrameIo &io, const SpectralControls &controls, const std::array<SpectralChannelStore, 2> &stored) {
    const uint32_t bins = size_ / 2 + 1;

    for (uint32_t index = 0; index < size_; ++index) {
      const uint32_t source = (io.input_start + index) & io.input_mask;
      re_[index] = io.input[0][source] * window_[index];
      im_[index] = io.input[1][source] * window_[index];
    }
    fft(false);
    split(bins, bin_re_, bin_im_);
    if (controls.mode == SpectralMode::Morph) {
      for (uint32_t index = 0; index < size_; ++index) {
        const uint32_t source = (io.input_start + index) & io.input_mask;
        re_[index] = io.sidechain[0][source] * window_[index];
        im_[index] = io.sidechain[1][source] * window_[index];
      }
      fft(false);
      split(bins, side_re_, side_im_);
    }
    for (uint32_t channel = 0; channel < 2; ++channel) {
      transform(channel, bins, controls, stored[channel]);
      bin_im_[channel][0] = 0.0;
      bin_im_[channel][size_ / 2] = 0.0;
    }
    for (uint32_t bin = 0; bin < bins; ++bin) {
      re_[bin] = bin_re_[0][bin] - bin_im_[1][bin];
      im_[bin] = bin_im_[0][bin] + bin_re_[1][bin];
    }
    for (uint32_t bin = 1; bin < size_ / 2; ++bin) {
      re_[size_ - bin] = bin_re_[0][bin] + bin_im_[1][bin];
      im_[size_ - bin] = bin_re_[1][bin] - bin_im_[0][bin];
    }
    fft(true);
    const double scale = 2.0 / overlap_ / size_;

    for (uint32_t index = 0; index < size_; ++index) {
      const uint32_t target = (io.output_start + index) & io.output_mask;
      io.output[0][target] += re_[index] * window_[index] * scale;
      io.output[1][target] += im_[index] * window_[index] * scale;
    }
  }

 private:
  struct ChannelState {
    ChannelState() { noise_gain.fill(1.0); }
    std::array<double, kSpectralBinsMax> previous_phase{};
    std::array<double, kSpectralBinsMax> running_phase{};
    std::array<double, kSpectralBinsMax> noise_prior{};
    std::array<double, kSpectralBinsMax> noise_gain{};
    std::array<uint32_t, kSpectralBinsMax> previous_peak_bin{};
    std::array<double, kSpectralBinsMax> previous_peak_offset{};
    std::array<float, kSpectralBinsMax * kSpectralMedianFrames> hpss_ring{};
    std::array<float, kSpectralBinsMax * kSpectralMedianFrames> hpss_sorted{};
    uint32_t previous_peak_count = 0;
    uint32_t hpss_index = 0;
    uint32_t hpss_count = 0;
    bool previous_phase_valid = false;
    bool running_valid = false;
  };

  // In-place iterative radix-2 FFT of re_ and im_ with table twiddles; the inverse is unscaled.
  void fft(bool inverse) {
    for (uint32_t index = 0; index < size_; ++index) {
      const uint32_t other = reverse_[index];

      if (index < other) {
        std::swap(re_[index], re_[other]);
        std::swap(im_[index], im_[other]);
      }
    }
    for (uint32_t index = 0; index < size_; index += 2) {
      const double a = re_[index], b = re_[index + 1], c = im_[index], d = im_[index + 1];
      re_[index] = a + b; re_[index + 1] = a - b;
      im_[index] = c + d; im_[index + 1] = c - d;
    }
    for (uint32_t index = 0; index < size_; index += 4) {
      // The second stage's twiddles are 1 and -j (+j inverse).
      const double a = re_[index], b = re_[index + 1], c = re_[index + 2], d = re_[index + 3];
      const double e = im_[index], f = im_[index + 1], g = im_[index + 2], h = im_[index + 3];
      re_[index] = a + c; re_[index + 2] = a - c;
      im_[index] = e + g; im_[index + 2] = e - g;
      const double rotated_re = inverse ? -h : h;
      const double rotated_im = inverse ? d : -d;
      re_[index + 1] = b + rotated_re; re_[index + 3] = b - rotated_re;
      im_[index + 1] = f + rotated_im; im_[index + 3] = f - rotated_im;
    }
    const double direction = inverse ? 1.0 : -1.0;

    for (uint32_t length = 8; length <= size_; length <<= 1u) {
      const uint32_t half = length / 2;
      const uint32_t step = size_ / length;

      for (uint32_t start = 0; start < size_; start += length) {
        for (uint32_t offset = 0; offset < half; ++offset) {
          const double wr = cosine_[offset * step];
          const double wi = direction * sine_[offset * step];
          const uint32_t even = start + offset;
          const uint32_t odd = even + half;
          const double product_re = re_[odd] * wr - im_[odd] * wi;
          const double product_im = re_[odd] * wi + im_[odd] * wr;
          re_[odd] = re_[even] - product_re;
          im_[odd] = im_[even] - product_im;
          re_[even] += product_re;
          im_[even] += product_im;
        }
      }
    }
  }

  // Separates the packed transform in re_/im_ (left + j right) into the two channel spectra.
  void split(uint32_t bins, std::array<std::array<double, kSpectralBinsMax>, 2> &out_re, std::array<std::array<double, kSpectralBinsMax>, 2> &out_im) const {
    for (uint32_t bin = 0; bin < bins; ++bin) {
      const uint32_t mirror = (size_ - bin) & (size_ - 1u);

      out_re[0][bin] = 0.5 * (re_[bin] + re_[mirror]);
      out_im[0][bin] = 0.5 * (im_[bin] - im_[mirror]);
      out_re[1][bin] = 0.5 * (im_[bin] + im_[mirror]);
      out_im[1][bin] = -0.5 * (re_[bin] - re_[mirror]);
    }
  }

  void transform(uint32_t channel, uint32_t bins, const SpectralControls &controls, const SpectralChannelStore &store) {
    double *re = bin_re_[channel].data();
    double *im = bin_im_[channel].data();
    ChannelState &state = channel_[channel];

    switch (controls.mode) {
      case SpectralMode::Freeze: freeze(state, bins, re, im, controls, store); break;
      case SpectralMode::Gate: gate(bins, re, im, controls, store); break;
      case SpectralMode::Morph: morph(channel, bins, re, im, controls); break;
      case SpectralMode::ShiftBlur: shift_blur(state, bins, re, im, controls); break;
      case SpectralMode::Hpss: hpss(state, bins, re, im, controls); break;
      case SpectralMode::NoiseReduce: noise_reduce(state, bins, re, im, controls, store); break;
    }
  }

  // Peaks are local maxima over +-2 bins; every bin belongs to the peak whose valley-bounded region holds it.
  void assign_peaks(uint32_t bins) {
    peak_count_ = 0;
    for (uint32_t bin = 0; bin < bins; ++bin) {
      bool peak = magnitude_[bin] > 0.0;

      for (uint32_t distance = 1; peak && distance <= 2; ++distance) {
        if (bin >= distance && magnitude_[bin - distance] >= magnitude_[bin]) peak = false;
        if (bin + distance < bins && magnitude_[bin + distance] > magnitude_[bin]) peak = false;
      }
      if (peak) peaks_[peak_count_++] = bin;
    }
    if (peak_count_ == 0) {
      for (uint32_t bin = 0; bin < bins; ++bin) peak_of_[bin] = bin;
      return;
    }
    uint32_t bin = 0;

    for (uint32_t peak = 0; peak < peak_count_; ++peak) {
      uint32_t boundary = bins - 1;

      if (peak + 1 < peak_count_) {
        boundary = peaks_[peak];
        for (uint32_t candidate = peaks_[peak]; candidate <= peaks_[peak + 1]; ++candidate) {
          if (magnitude_[candidate] < magnitude_[boundary]) boundary = candidate;
        }
      }
      for (; bin <= boundary; ++bin) peak_of_[bin] = peaks_[peak];
    }
  }

  void polar(uint32_t bins, const double *re, const double *im) {
    for (uint32_t bin = 0; bin < bins; ++bin) {
      magnitude_[bin] = std::sqrt(re[bin] * re[bin] + im[bin] * im[bin]);
      phase_[bin] = std::atan2(im[bin], re[bin]);
    }
  }

  void freeze(ChannelState &state, uint32_t bins, double *re, double *im, const SpectralControls &controls, const SpectralChannelStore &store) {
    if (controls.freeze && !*store.freeze_captured) {
      polar(bins, re, im);
      assign_peaks(bins);
      for (uint32_t bin = 0; bin < bins; ++bin) {
        const uint32_t peak = peak_of_[bin];
        store.frozen_magnitude[bin] = static_cast<float>(magnitude_[bin]);
        store.frozen_phase[bin] = static_cast<float>(phase_[bin]);
        // Without an earlier frame the best estimate of a peak's advance is the advance of its bin centre.
        const double advance = state.previous_phase_valid ? phase_[peak] - state.previous_phase[peak]
          : 2.0 * kSpectralPi * static_cast<double>(peak % overlap_) / overlap_;
        store.frozen_advance[bin] = static_cast<float>(spectral_wrap_phase(advance));
      }
      state.running_valid = false;
      *store.freeze_captured = true;
    } else if (!controls.freeze) {
      *store.freeze_captured = false;
      state.running_valid = false;
    }
    if (!*store.freeze_captured) {
      polar(bins, re, im);
      for (uint32_t bin = 0; bin < bins; ++bin) state.previous_phase[bin] = phase_[bin];
      state.previous_phase_valid = true;
      return;
    }
    if (!state.running_valid) {
      for (uint32_t bin = 0; bin < bins; ++bin) state.running_phase[bin] = store.frozen_phase[bin];
      state.running_valid = true;
    } else {
      for (uint32_t bin = 0; bin < bins; ++bin) {
        state.running_phase[bin] = spectral_wrap_phase(state.running_phase[bin] + store.frozen_advance[bin]);
      }
    }
    for (uint32_t bin = 0; bin < bins; ++bin) {
      re[bin] = store.frozen_magnitude[bin] * std::cos(state.running_phase[bin]);
      im[bin] = store.frozen_magnitude[bin] * std::sin(state.running_phase[bin]);
    }
  }

  // A bin is judged on the loudest of itself and its two neighbours. DC and Nyquist are real, so their magnitude crosses zero
  // with the signal's phase even under a loud partial; judged alone, that frame closes the gate and the slow attack leaves
  // the bin attenuated for the frames after it, so a gate set below the signal would not be the identity.
  void gate(uint32_t bins, double *re, double *im, const SpectralControls &controls, const SpectralChannelStore &store) {
    const double hop = static_cast<double>(size_ / overlap_);
    const double threshold = std::pow(10.0, controls.gate_threshold_db / 20.0) / normalization_;
    const double attack = std::exp(-hop / std::fmax(1.0, controls.gate_attack_ms * 0.001 * controls.sample_rate));
    const double release = std::exp(-hop / std::fmax(1.0, controls.gate_release_ms * 0.001 * controls.sample_rate));

    for (uint32_t bin = 0; bin < bins; ++bin) magnitude_[bin] = std::sqrt(re[bin] * re[bin] + im[bin] * im[bin]);
    for (uint32_t bin = 0; bin < bins; ++bin) {
      const double loudest = std::fmax(magnitude_[bin], std::fmax(magnitude_[bin > 0 ? bin - 1 : bin], magnitude_[bin + 1 < bins ? bin + 1 : bin]));
      const double target = loudest >= threshold ? 1.0 : 0.0;
      const double gain = store.gate_gain[bin];
      const double coefficient = target > gain ? attack : release;
      const double next = dsp::flushDenormal(target + coefficient * (gain - target));

      store.gate_gain[bin] = static_cast<float>(next);
      re[bin] *= next;
      im[bin] *= next;
    }
  }

  void morph(uint32_t channel, uint32_t bins, double *re, double *im, const SpectralControls &controls) const {
    for (uint32_t bin = 0; bin < bins; ++bin) {
      const double phase = std::atan2(im[bin], re[bin]);
      const double magnitude = std::sqrt(re[bin] * re[bin] + im[bin] * im[bin]) * (1.0 - controls.morph)
        + std::sqrt(side_re_[channel][bin] * side_re_[channel][bin] + side_im_[channel][bin] * side_im_[channel][bin]) * controls.morph;

      re[bin] = magnitude * std::cos(phase);
      im[bin] = magnitude * std::sin(phase);
    }
  }

  void shift_blur(ChannelState &state, uint32_t bins, double *re, double *im, const SpectralControls &controls) {
    polar(bins, re, im);
    assign_peaks(bins);
    // Each peak's output phase is its own plus an offset that grows by the phase the shift adds per hop; a peak inherits the
    // offset of the nearest peak of the previous frame, so a moving partial keeps its phase.
    const double advance = 2.0 * kSpectralPi * controls.bin_shift / overlap_;
    uint32_t previous = 0;

    for (uint32_t peak = 0; peak < peak_count_; ++peak) {
      const uint32_t bin = peaks_[peak];

      while (previous + 1 < state.previous_peak_count
        && std::abs(static_cast<double>(state.previous_peak_bin[previous + 1]) - bin) <= std::abs(static_cast<double>(state.previous_peak_bin[previous]) - bin)) ++previous;
      const bool inherited = state.previous_peak_count > 0
        && std::abs(static_cast<double>(state.previous_peak_bin[previous]) - bin) <= 2.0;

      offset_[bin] = inherited ? spectral_wrap_phase(state.previous_peak_offset[previous] + advance) : 0.0;
    }
    state.previous_peak_count = peak_count_;
    for (uint32_t peak = 0; peak < peak_count_; ++peak) {
      state.previous_peak_bin[peak] = peaks_[peak];
      state.previous_peak_offset[peak] = offset_[peaks_[peak]];
    }
    for (uint32_t bin = 0; bin < bins; ++bin) previous_[bin] = magnitude_[bin];
    const int32_t radius = std::min(15, static_cast<int32_t>(std::ceil(controls.blur * 15.0)));

    for (uint32_t bin = 0; bin < bins; ++bin) {
      const double source = static_cast<double>(bin) - controls.bin_shift;
      const int32_t lower = static_cast<int32_t>(std::floor(source));
      const double fraction = source - lower;
      const auto magnitude_at = [&](int32_t index) { return index >= 0 && static_cast<uint32_t>(index) < bins ? previous_[static_cast<uint32_t>(index)] : 0.0; };
      const double shifted = magnitude_at(lower) * (1.0 - fraction) + magnitude_at(lower + 1) * fraction;
      double sum = 0.0;
      uint32_t count = 0;

      for (int32_t offset = -radius; offset <= radius; ++offset) {
        const int32_t candidate = lower + offset;

        if (candidate >= 0 && static_cast<uint32_t>(candidate) < bins) {
          sum += previous_[static_cast<uint32_t>(candidate)];
          ++count;
        }
      }
      const double magnitude = shifted * (1.0 - controls.blur) + (count == 0 ? 0.0 : sum / count) * controls.blur;
      const int32_t nearest = std::clamp(static_cast<int32_t>(std::lround(source)), 0, static_cast<int32_t>(bins) - 1);
      const uint32_t source_bin = static_cast<uint32_t>(nearest);
      const double phase = phase_[source_bin] + offset_[peak_of_[source_bin]];

      re[bin] = magnitude * std::cos(phase);
      im[bin] = magnitude * std::sin(phase);
    }
  }

  void hpss(ChannelState &state, uint32_t bins, double *re, double *im, const SpectralControls &controls) {
    const uint32_t slot = state.hpss_index;
    const bool filling = state.hpss_count < kSpectralMedianFrames;

    for (uint32_t bin = 0; bin < bins; ++bin) {
      const float value = static_cast<float>(std::sqrt(re[bin] * re[bin] + im[bin] * im[bin]));
      float *sorted = state.hpss_sorted.data() + bin * kSpectralMedianFrames;
      float &stored = state.hpss_ring[slot * kSpectralBinsMax + bin];

      if (filling) spectral_sorted_insert(sorted, state.hpss_count, value);
      else spectral_sorted_replace(sorted, kSpectralMedianFrames, stored, value);
      stored = value;
      current_[bin] = value;
    }
    if (filling) ++state.hpss_count;
    state.hpss_index = (slot + 1) % kSpectralMedianFrames;
    const double harmonic_gain = controls.hpss_balance < 0.0 ? 1.0 + controls.hpss_balance : 1.0;
    const double percussive_gain = controls.hpss_balance > 0.0 ? 1.0 - controls.hpss_balance : 1.0;
    std::array<float, kSpectralHpssWindowCapacity> window{};
    uint32_t count = 0;

    for (uint32_t bin = 0; bin < std::min(bins, kSpectralMedianBins / 2 + 1); ++bin) spectral_sorted_insert(window.data(), count++, current_[bin]);
    for (uint32_t bin = 0; bin < bins; ++bin) {
      const double harmonic = state.hpss_sorted[bin * kSpectralMedianFrames + state.hpss_count / 2];
      const double percussive = window[count / 2];
      const double harmonic_power = harmonic * harmonic;
      const double percussive_power = percussive * percussive;
      const double total = harmonic_power + percussive_power;
      const double harmonic_mask = total > 0.0 ? harmonic_power / total : 0.5;
      const double gain = percussive_gain + (harmonic_gain - percussive_gain) * harmonic_mask;

      re[bin] *= gain;
      im[bin] *= gain;
      const uint32_t entering = bin + kSpectralMedianBins / 2 + 1;

      if (entering < bins) spectral_sorted_insert(window.data(), count++, current_[entering]);
#ifdef DAW_SPECTRAL_TRACK_HPSS_WINDOW
      hpss_window_peak_ = std::max(hpss_window_peak_, count);
#endif
      if (bin >= kSpectralMedianBins / 2) spectral_sorted_erase(window.data(), count--, current_[bin - kSpectralMedianBins / 2]);
    }
  }

  void noise_reduce(ChannelState &state, uint32_t bins, double *re, double *im, const SpectralControls &controls, const SpectralChannelStore &store) {
    constexpr double kDecisionDirected = 0.98;
    constexpr double kGainRise = 0.35;
    constexpr double kGainFall = 0.8;
    constexpr double kTinyPower = 1.0e-30;
    const uint32_t frames = *store.noise_frames;

    if (controls.learn) {
      const double weight = 1.0 / (static_cast<double>(std::min(frames, 1u << 16)) + 1.0);

      for (uint32_t bin = 0; bin < bins; ++bin) {
        const double power = re[bin] * re[bin] + im[bin] * im[bin];
        const double mean = static_cast<double>(store.noise_profile[bin]) * store.noise_profile[bin];

        store.noise_profile[bin] = static_cast<float>(std::sqrt(mean + (power - mean) * weight));
        state.noise_prior[bin] = 0.0;
        state.noise_gain[bin] = 1.0;
      }
      *store.noise_frames = std::min(frames + 1, 1u << 16);
      return;
    }
    if (frames == 0) return;
    const double floor_gain = std::pow(10.0, controls.noise_floor_db / 20.0);

    for (uint32_t bin = 0; bin < bins; ++bin) {
      // A learned line leaks into the bins beside it by at least the window's first-bin response. A profile resampled to another
      // FFT size keeps the line but not that leakage, so each bin is held to that floor from its neighbours.
      const double profile = std::fmax(store.noise_profile[bin], leakage_ * std::fmax(
        store.noise_profile[bin > 0 ? bin - 1 : bin], store.noise_profile[bin + 1 < bins ? bin + 1 : bin]));
      const double noise_power = std::fmax(profile * profile, kTinyPower);
      const double ratio = (re[bin] * re[bin] + im[bin] * im[bin]) / noise_power;
      const double prior = kDecisionDirected * state.noise_prior[bin] + (1.0 - kDecisionDirected) * std::fmax(ratio - 1.0, 0.0);
      const double wiener = std::fmax(prior / (1.0 + prior), floor_gain);
      const double previous = state.noise_gain[bin];

      state.noise_prior[bin] = wiener * wiener * ratio;
      state.noise_gain[bin] = dsp::flushDenormal(previous + (wiener - previous) * (wiener > previous ? kGainRise : kGainFall));
    }
    for (uint32_t bin = 0; bin < bins; ++bin) {
      const double left = state.noise_gain[bin > 0 ? bin - 1 : bin];
      const double right = state.noise_gain[bin + 1 < bins ? bin + 1 : bin];
      const double smoothed = 0.25 * left + 0.5 * state.noise_gain[bin] + 0.25 * right;
      const double gain = controls.noise_reduction == 1.0 ? smoothed : std::pow(smoothed, controls.noise_reduction);

      re[bin] *= gain;
      im[bin] *= gain;
    }
  }

#ifdef DAW_SPECTRAL_TRACK_HPSS_WINDOW
  uint32_t hpss_window_peak_ = 0;
#endif
  uint32_t size_ = 0;
  uint32_t overlap_ = 0;
  double normalization_ = 1.0;
  double leakage_ = 0.0;  // window response one bin off a bin-centred sine, relative to its peak
  std::array<double, kSpectralFftMax> window_{};
  std::array<double, kSpectralFftMax / 2> cosine_{};
  std::array<double, kSpectralFftMax / 2> sine_{};
  std::array<uint16_t, kSpectralFftMax> reverse_{};
  std::array<double, kSpectralFftMax> re_{};
  std::array<double, kSpectralFftMax> im_{};
  std::array<std::array<double, kSpectralBinsMax>, 2> bin_re_{};
  std::array<std::array<double, kSpectralBinsMax>, 2> bin_im_{};
  std::array<std::array<double, kSpectralBinsMax>, 2> side_re_{};
  std::array<std::array<double, kSpectralBinsMax>, 2> side_im_{};
  std::array<ChannelState, 2> channel_{};
  // One channel at a time uses these.
  std::array<double, kSpectralBinsMax> magnitude_{};
  std::array<double, kSpectralBinsMax> phase_{};
  std::array<double, kSpectralBinsMax> previous_{};
  std::array<double, kSpectralBinsMax> offset_{};
  std::array<float, kSpectralBinsMax> current_{};
  std::array<uint32_t, kSpectralBinsMax> peaks_{};
  std::array<uint32_t, kSpectralBinsMax> peak_of_{};
  uint32_t peak_count_ = 0;
};

}  // namespace daw::audio_core
