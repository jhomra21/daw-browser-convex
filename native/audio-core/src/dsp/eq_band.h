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

// RBJ cookbook biquad in double. Used where no matched design exists (band-pass, notch, all-pass) and for shelves
// outside the region where the matched shelf measures better (see designEqBand).
inline BiquadCoefficients rbjBiquad(EqBandType type, double frequency, double sampleRate, double q, double gainDb) {
  const double omega = 2.0 * kPi * std::clamp(frequency, 1.0, 0.49 * sampleRate) / sampleRate;
  const double cosine = std::cos(omega);
  const double alpha = std::sin(omega) / (2.0 * std::max(q, 0.01));
  const double a = std::pow(10.0, gainDb / 40.0);
  double b0 = 1.0, b1 = 0.0, b2 = 0.0, a0 = 1.0, a1 = 0.0, a2 = 0.0;
  switch (type) {
    case EqBandType::Lowpass:
    case EqBandType::Lowpass48:
      b0 = (1.0 - cosine) * 0.5; b1 = 1.0 - cosine; b2 = b0; a0 = 1.0 + alpha; a1 = -2.0 * cosine; a2 = 1.0 - alpha;
      break;
    case EqBandType::Highpass:
    case EqBandType::Highpass48:
      b0 = (1.0 + cosine) * 0.5; b1 = -(1.0 + cosine); b2 = b0; a0 = 1.0 + alpha; a1 = -2.0 * cosine; a2 = 1.0 - alpha;
      break;
    case EqBandType::Bandpass:
      b0 = alpha; b2 = -alpha; a0 = 1.0 + alpha; a1 = -2.0 * cosine; a2 = 1.0 - alpha;
      break;
    case EqBandType::Notch:
      b0 = 1.0; b1 = -2.0 * cosine; b2 = 1.0; a0 = 1.0 + alpha; a1 = b1; a2 = 1.0 - alpha;
      break;
    case EqBandType::Allpass:
      b0 = 1.0 - alpha; b1 = -2.0 * cosine; b2 = 1.0 + alpha; a0 = b2; a1 = b1; a2 = b0;
      break;
    case EqBandType::Lowshelf: {
      const double beta = 2.0 * std::sqrt(a) * alpha;
      b0 = a * ((a + 1.0) - (a - 1.0) * cosine + beta);
      b1 = 2.0 * a * ((a - 1.0) - (a + 1.0) * cosine);
      b2 = a * ((a + 1.0) - (a - 1.0) * cosine - beta);
      a0 = (a + 1.0) + (a - 1.0) * cosine + beta;
      a1 = -2.0 * ((a - 1.0) + (a + 1.0) * cosine);
      a2 = (a + 1.0) + (a - 1.0) * cosine - beta;
      break;
    }
    case EqBandType::Highshelf: {
      const double beta = 2.0 * std::sqrt(a) * alpha;
      b0 = a * ((a + 1.0) + (a - 1.0) * cosine + beta);
      b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cosine);
      b2 = a * ((a + 1.0) + (a - 1.0) * cosine - beta);
      a0 = (a + 1.0) - (a - 1.0) * cosine + beta;
      a1 = 2.0 * ((a - 1.0) - (a + 1.0) * cosine);
      a2 = (a + 1.0) - (a - 1.0) * cosine - beta;
      break;
    }
    case EqBandType::Peaking:
      b0 = 1.0 + alpha * a; b1 = -2.0 * cosine; b2 = 1.0 - alpha * a; a0 = 1.0 + alpha / a; a1 = b1; a2 = 1.0 - alpha / a;
      break;
  }
  return BiquadCoefficients{b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0};
}

// Butterworth 8th order as four sections: Q = 1 / (2 sin((2k - 1) pi / 16)). The highest-Q section carries the band's
// Q, scaled so that Q = 1/sqrt(2) is the plain Butterworth.
inline constexpr std::array<double, kEqMaxSections> kButterworth8Q = {0.5097955791041592, 0.6013448869350453, 0.8999762231364156, 2.5629154477415055};

}  // namespace detail

// Designs one band for a filter running at `sampleRate`. Choices, from measurements of the worst error against the analog
// prototype between 20 Hz and 0.45 fs of the project rate (random bands, Q 0.5 to 4, 6 to 15 dB, 44.1 and 48 kHz):
//   - bell, 12 dB and 48 dB cuts: matched (Vicanek). Processing at the project rate: bell 0.6/2.0/2.4/2.3 dB for corners
//     below 0.1/0.25/0.35/0.45 fs against RBJ 1.5/6.2/8.9/10.3; low cut 1.1 to 1.7 dB against RBJ 22 to 26;
//     high cut 0.15/0.9/1.3/5.3 against RBJ 0.6/4.2/10.1/26. At twice the project rate (Hi-Quality) bell 0.03 to 0.16
//     and cuts 0.01 to 0.16 dB, so the 0.5 dB target holds up to 0.45 fs.
//   - shelves: the matched shelf is better for Q <= 1.5 when boosting, or when cutting with the corner under 0.25 fs of the
//     processing rate; elsewhere RBJ is better (a matched cut shelf with the corner above 0.25 fs errs by 9 to 33 dB).
//   - band-pass, notch, all-pass: RBJ.
inline EqBandSections designEqBand(EqBandType type, double frequency, double sampleRate, double q, double gainDb) {
  EqBandSections band;
  band.count = 1;
  switch (type) {
    case EqBandType::Peaking:
      band.sections[0] = designMatchedBell(frequency, sampleRate, q, gainDb);
      break;
    case EqBandType::Lowpass:
      band.sections[0] = designMatchedLowPass(frequency, sampleRate, q);
      break;
    case EqBandType::Highpass:
      band.sections[0] = designMatchedHighPass(frequency, sampleRate, q);
      break;
    case EqBandType::Lowpass48:
    case EqBandType::Highpass48: {
      band.count = kEqMaxSections;
      for (uint32_t i = 0; i < kEqMaxSections; ++i) {
        const double sectionQ = i == kEqMaxSections - 1 ? detail::kButterworth8Q[i] * q * 1.4142135623730951 : detail::kButterworth8Q[i];
        band.sections[i] = type == EqBandType::Lowpass48 ? designMatchedLowPass(frequency, sampleRate, sectionQ)
                                                         : designMatchedHighPass(frequency, sampleRate, sectionQ);
      }
      break;
    }
    case EqBandType::Lowshelf:
    case EqBandType::Highshelf: {
      const double corner = std::clamp(frequency, 1.0, 0.49 * sampleRate) / sampleRate;
      const bool matched = q <= 1.5 && (gainDb >= 0.0 || corner < 0.25);
      band.sections[0] = !matched ? detail::rbjBiquad(type, frequency, sampleRate, q, gainDb)
                                  : type == EqBandType::Lowshelf ? designMatchedLowShelf(frequency, sampleRate, q, gainDb)
                                                                 : designMatchedHighShelf(frequency, sampleRate, q, gainDb);
      break;
    }
    case EqBandType::Bandpass:
    case EqBandType::Notch:
    case EqBandType::Allpass:
      band.sections[0] = detail::rbjBiquad(type, frequency, sampleRate, q, gainDb);
      break;
  }
  return band;
}

}  // namespace daw::audio_core::dsp
