#pragma once

#include "biquad.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

namespace daw::audio_core::dsp {

// The EQ band definition shared by the processor and (through its TypeScript twin in packages/shared/src/eq-design.ts)
// the device graph. The numeric values are the daw_audio_eq_band_type values of the public header.
// Lowpass and Highpass are the 12 dB/oct "High cut" and "Low cut"; the 48 dB variants are 8th-order Butterworth.
enum class EqBandType : uint32_t {
  Lowpass = 0,
  Highpass = 1,
  Bandpass = 2,
  Lowshelf = 3,
  Highshelf = 4,
  Peaking = 5,
  Notch = 6,
  Allpass = 7,
  Lowpass48 = 8,
  Highpass48 = 9,
};

inline constexpr uint32_t kEqMaxSections = 4;

struct EqBandSections {
  std::array<BiquadCoefficients, kEqMaxSections> sections{};
  uint32_t count = 0;
};

inline bool eqBandHasGain(EqBandType type) {
  return type == EqBandType::Lowshelf || type == EqBandType::Highshelf || type == EqBandType::Peaking;
}

namespace detail {

// RBJ cookbook biquad in double, for band-pass, notch and all-pass, which have no matched design.
inline BiquadCoefficients rbjBiquad(EqBandType type, double frequency, double sampleRate, double q) {
  const double omega = 2.0 * kPi * std::clamp(frequency, 1.0, 0.49 * sampleRate) / sampleRate;
  const double cosine = std::cos(omega);
  const double alpha = std::sin(omega) / (2.0 * std::max(q, 0.01));
  double b0 = 1.0, b1 = 0.0, b2 = 0.0, a0 = 1.0, a1 = -2.0 * cosine, a2 = 1.0 - alpha;
  switch (type) {
    case EqBandType::Bandpass:
      b0 = alpha; b2 = -alpha; a0 = 1.0 + alpha;
      break;
    case EqBandType::Notch:
      b0 = 1.0; b1 = a1; b2 = 1.0; a0 = 1.0 + alpha;
      break;
    default:
      b0 = 1.0 - alpha; b1 = a1; b2 = 1.0 + alpha; a0 = b2;
      break;
  }
  return BiquadCoefficients{b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0};
}

// Butterworth 8th order as four sections: Q = 1 / (2 sin((2k - 1) pi / 16)). The highest-Q section carries the band's
// Q, scaled so that Q = 1/sqrt(2) is the plain Butterworth.
inline constexpr std::array<double, kEqMaxSections> kButterworth8Q = {0.5097955791041592, 0.6013448869350453, 0.8999762231364156, 2.5629154477415055};

}  // namespace detail

// Designs one band for a filter running at `sampleRate`: matched designs (impulse-invariant poles, numerator fitted to the
// analog prototype, see biquad.h) for bells, shelves, low-pass and high-pass, RBJ for band-pass, notch and all-pass.
// Worst error against the analog prototype between 20 Hz and 0.45 fs of the project rate (20 random bands, Q 0.2 to 18,
// gain +-24 dB; tools/effects-harness, row band-response-vs-analog), before -> after:
//   44.1 kHz  5.9 -> 0.14 dB     48 kHz  2.1 -> 0.14 dB     96 kHz  1.6 -> 0.20 dB
//   Hi-Quality (processing at twice the rate): 44.1 kHz 0.94 -> 0.06, 48 kHz 0.91 -> 0.06, 96 kHz 0.67 -> 0.04 dB.
// The fitted numerator alone left 0.55, 0.57 and 0.46 dB on the same bands: the impulse-invariant poles are off when they
// sit near Nyquist (low shelf 11.4 kHz Q 0.29 -22 dB, bell 19 kHz Q 0.45 +22 dB), so the poles are moved by a table-driven
// correction (see biquad.h).
// `projectRate` is the rate the EQ range (up to 0.45 of it) is judged at when `sampleRate` is oversampled.
inline EqBandSections designEqBand(EqBandType type, double frequency, double sampleRate, double q, double gainDb, double projectRate = 0.0) {
  const double span = detail::kFitSpanDefault * (projectRate > 0.0 ? projectRate : sampleRate) / sampleRate;
  EqBandSections band;
  band.count = 1;
  switch (type) {
    case EqBandType::Peaking:
      band.sections[0] = designMatchedBell(frequency, sampleRate, q, gainDb, span);
      break;
    case EqBandType::Lowpass:
      band.sections[0] = designMatchedLowPass(frequency, sampleRate, q, span);
      break;
    case EqBandType::Highpass:
      band.sections[0] = designMatchedHighPass(frequency, sampleRate, q);
      break;
    case EqBandType::Lowpass48:
    case EqBandType::Highpass48: {
      band.count = kEqMaxSections;
      for (uint32_t i = 0; i < kEqMaxSections; ++i) {
        const double sectionQ = i == kEqMaxSections - 1 ? detail::kButterworth8Q[i] * q * 1.4142135623730951 : detail::kButterworth8Q[i];
        band.sections[i] = type == EqBandType::Lowpass48 ? designMatchedLowPass(frequency, sampleRate, sectionQ, span)
                                                         : designMatchedHighPass(frequency, sampleRate, sectionQ);
      }
      break;
    }
    case EqBandType::Lowshelf:
      band.sections[0] = designMatchedLowShelf(frequency, sampleRate, q, gainDb, span);
      break;
    case EqBandType::Highshelf:
      band.sections[0] = designMatchedHighShelf(frequency, sampleRate, q, gainDb, span);
      break;
    case EqBandType::Bandpass:
    case EqBandType::Notch:
    case EqBandType::Allpass:
      band.sections[0] = detail::rbjBiquad(type, frequency, sampleRate, q);
      break;
  }
  return band;
}

}  // namespace daw::audio_core::dsp
