#pragma once

#include "numeric_safety.h"

#include <algorithm>
#include <array>
#include <cmath>

namespace daw::audio_core::dsp {

// H(z) = (b0 + b1 z^-1 + b2 z^-2) / (1 + a1 z^-1 + a2 z^-2)
struct BiquadCoefficients {
  double b0 = 1.0;
  double b1 = 0.0;
  double b2 = 0.0;
  double a1 = 0.0;
  double a2 = 0.0;
};

// Transposed direct form II. State is float for most bands and double for low-frequency ones, where float state
// loses 30+ dB of signal-to-noise.
template <class State = float>
class Biquad {
 public:
  void reset() { s1_ = s2_ = State(0); }

  State process(State input, const BiquadCoefficients &c) {
    const State y = static_cast<State>(c.b0) * input + s1_;
    s1_ = flushDenormal(static_cast<State>(c.b1) * input - static_cast<State>(c.a1) * y + s2_);
    s2_ = flushDenormal(static_cast<State>(c.b2) * input - static_cast<State>(c.a2) * y);
    return finiteOrReset(*this, y);
  }

 private:
  State s1_ = State(0);
  State s2_ = State(0);
};

// Matched-magnitude designs. The poles come from impulse invariance (z = e^s), so a resonance does not narrow toward
// Nyquist. The numerator is then fitted to the analog prototype's magnitude:
//   high-pass: Vicanek, "Matched Second Order Digital Filters" (2016), section 4.2: double zero at DC, match at the corner.
//   bell, low-pass, shelves: match at DC and at the corner, as Vicanek's sections 4.1 and 4.4 do, then fit the one degree of
//     freedom left over 0 to 0.45 fs (fittedNumerator). Vicanek fixes it with B2 = 0 (low-pass), zero slope at the centre
//     (bell) or the Nyquist magnitude (shelves, section 5). Measured against the analog prototype, those leave 1 to 6 dB
//     inside the band for wide boosts, deep cuts and resonant low-passes, where the analog response is still moving at Nyquist.
// Prototypes are the RBJ cookbook analog filters, so Q and gain mean what they mean in the existing EQ.
// Frequencies above 0.49 fs are held there. All designs keep both poles inside the unit circle.
namespace detail {

constexpr double kPi = 3.14159265358979323846;

struct Poles {
  double a1;
  double a2;
};

// q is the pole damping 1 / (2 Q); omega is the pole frequency in radians per sample.
inline Poles impulseInvariantPoles(double q, double omega) {
  const double decay = std::exp(-q * omega);
  const double a1 = q <= 1.0 ? -2.0 * decay * std::cos(std::sqrt(1.0 - q * q) * omega)
                             : -2.0 * decay * std::cosh(std::sqrt(q * q - 1.0) * omega);
  return Poles{a1, decay * decay};
}

// |H|^2 = (B0 phi0 + B1 phi1 + B2 phi2) / (A0 phi0 + A1 phi1 + A2 phi2), phi0 = cos^2(w/2), phi1 = sin^2(w/2).
struct Quadratic {
  double c0;
  double c1;
  double c2;
  double at(double omega) const {
    const double s = std::sin(0.5 * omega);
    const double p1 = s * s;
    const double p0 = 1.0 - p1;
    return c0 * p0 + c1 * p1 + c2 * 4.0 * p0 * p1;
  }
};

inline Quadratic denominator(const Poles &p) {
  return Quadratic{(1.0 + p.a1 + p.a2) * (1.0 + p.a1 + p.a2), (1.0 - p.a1 + p.a2) * (1.0 - p.a1 + p.a2), -4.0 * p.a2};
}

// Vicanek eq. (29): the minimum-phase numerator with the given B0, B1, B2. A real numerator needs B2 >= -W^2. A fit
// that asks for less (a deep cut near Nyquist that no biquad can follow) is pulled back to 0.9 of that bound: held at
// the bound the zeros sit on the unit circle and the response has a null, which is far worse than a shallow cut.
inline BiquadCoefficients withNumerator(const Poles &p, double B0, double B1, double B2) {
  const double r0 = std::sqrt(std::max(B0, 0.0));
  const double r1 = std::sqrt(std::max(B1, 0.0));
  const double w = 0.5 * (r0 + r1);
  const double held = B2 < -w * w ? -0.9 * w * w : B2;
  const double b0 = 0.5 * (w + std::sqrt(w * w + held));
  return BiquadCoefficients{b0, 0.5 * (r0 - r1), b0 > 0.0 ? -held / (4.0 * b0) : 0.0, p.a1, p.a2};
}

inline double cornerOmega(double frequency, double sampleRate) {
  return 2.0 * kPi * std::clamp(frequency, 1.0, 0.49 * sampleRate) / sampleRate;
}

// |H|^2 of the RBJ shelf prototype at x = Omega / Omega0.
inline double shelfMagnitudeSquared(bool low, double a, double q, double x) {
  const double c = x * std::sqrt(a) / q;
  const double plain = (a - x * x) * (a - x * x) + c * c;
  const double scaled = (1.0 - a * x * x) * (1.0 - a * x * x) + c * c;
  return a * a * (low ? plain / scaled : scaled / plain);
}

// Numerator for the analog |H|^2 (a function of x = Omega / Omega0). |H|^2 is linear in B0, B1, B2 once the poles are fixed.
// DC (B0) and the corner are matched exactly, which leaves one degree of freedom: B2, with B1 following from the corner.
// B2 is fitted from DC to `span` (0.45 of the project rate, the top of the EQ range) by least squares on the relative error,
// repeated with each point weighted by its previous error (Lawson) so the error spreads evenly instead of piling up at the
// band edge.
inline constexpr double kFitTop = 0.45;
inline constexpr double kFitSpanDefault = 2.0 * kPi * kFitTop;
// 48 points and 3 passes land within 0.1 dB of 64 points and 8 passes on 300 random bands at 44.1, 48 and 96 kHz, at a
// third of the cost. Fewer points fit as well but follow float32 input rounding more closely, which widens the drawn-curve
// vs render difference at 96 kHz past 1e-4 dB.
inline constexpr int kFitPoints = 48;
inline constexpr int kFitPasses = 3;

template <class AnalogSquared>
inline BiquadCoefficients fittedNumerator(const Poles &p, double omega0, double span, AnalogSquared analogSquared) {
  const Quadratic den = denominator(p);
  const double B0 = den.c0 * analogSquared(0.0);
  const double s0 = std::sin(0.5 * omega0);
  const double corner1 = s0 * s0;
  const double corner2 = 4.0 * (1.0 - corner1) * corner1;
  const double corner = den.at(omega0) * analogSquared(1.0) - B0 * (1.0 - corner1);

  // Residual of point i is rest - B2 * slope, with B1 = (corner - B2 corner2) / corner1 substituted.
  std::array<double, kFitPoints> rest{};
  std::array<double, kFitPoints> slope{};
  std::array<double, kFitPoints> weights{};
  for (int i = 0; i < kFitPoints; ++i) {
    const double omega = span * (i + 1) / kFitPoints;
    const double s = std::sin(0.5 * omega);
    const double phi1 = s * s;
    const double scale = 1.0 / (den.at(omega) * analogSquared(omega / omega0));
    const double u1 = phi1 * scale;
    const double u2 = 4.0 * (1.0 - phi1) * phi1 * scale;
    rest[i] = 1.0 - B0 * (1.0 - phi1) * scale - u1 * corner / corner1;
    slope[i] = u2 - u1 * corner2 / corner1;
    weights[i] = 1.0;
  }

  double B2 = 0.0;
  for (int pass = 0; pass < kFitPasses; ++pass) {
    double num = 0.0;
    double dn = 0.0;
    for (int i = 0; i < kFitPoints; ++i) {
      num += weights[i] * slope[i] * rest[i];
      dn += weights[i] * slope[i] * slope[i];
    }
    B2 = dn > 0.0 ? num / dn : 0.0;
    double total = 0.0;
    for (int i = 0; i < kFitPoints; ++i) {
      weights[i] *= std::max(std::abs(rest[i] - B2 * slope[i]), 1.0e-6);
      total += weights[i];
    }
    for (int i = 0; i < kFitPoints; ++i) weights[i] = weights[i] * kFitPoints / total;
  }
  return withNumerator(p, B0, (corner - B2 * corner2) / corner1, B2);
}

inline BiquadCoefficients designShelf(bool low, double frequency, double sampleRate, double span, double q, double gainDb) {
  const double omega0 = cornerOmega(frequency, sampleRate);
  const double a = std::pow(10.0, gainDb / 40.0);
  const double quality = std::max(q, 0.01);
  const Poles poles = impulseInvariantPoles(0.5 / quality, low ? omega0 / std::sqrt(a) : omega0 * std::sqrt(a));
  return fittedNumerator(poles, omega0, span, [&](double x) { return shelfMagnitudeSquared(low, a, quality, x); });
}

}  // namespace detail

inline BiquadCoefficients designMatchedBell(double frequency, double sampleRate, double q, double gainDb, double span = detail::kFitSpanDefault) {
  using namespace detail;
  const double omega0 = cornerOmega(frequency, sampleRate);
  const double gain = std::pow(10.0, gainDb / 20.0);
  const double quality = std::max(q, 0.01);
  const Poles poles = impulseInvariantPoles(0.5 / (std::sqrt(gain) * quality), omega0);
  return fittedNumerator(poles, omega0, span, [&](double x) {
    const double plain = (1.0 - x * x) * (1.0 - x * x);
    const double c = x / quality;
    return (plain + gain * c * c) / (plain + c * c / gain);
  });
}

inline BiquadCoefficients designMatchedLowPass(double frequency, double sampleRate, double q, double span = detail::kFitSpanDefault) {
  using namespace detail;
  const double omega0 = cornerOmega(frequency, sampleRate);
  const double quality = std::max(q, 0.01);
  return fittedNumerator(impulseInvariantPoles(0.5 / quality, omega0), omega0, span, [&](double x) {
    return 1.0 / ((1.0 - x * x) * (1.0 - x * x) + (x / quality) * (x / quality));
  });
}

inline BiquadCoefficients designMatchedHighPass(double frequency, double sampleRate, double q) {
  using namespace detail;
  const double omega0 = cornerOmega(frequency, sampleRate);
  const double quality = std::max(q, 0.01);
  const Poles poles = impulseInvariantPoles(0.5 / quality, omega0);
  const double s = std::sin(0.5 * omega0);
  const double phi1 = s * s;
  const double b0 = std::sqrt(denominator(poles).at(omega0)) * quality / (4.0 * phi1);
  return BiquadCoefficients{b0, -2.0 * b0, b0, poles.a1, poles.a2};
}

inline BiquadCoefficients designMatchedLowShelf(double frequency, double sampleRate, double q, double gainDb, double span = detail::kFitSpanDefault) {
  return detail::designShelf(true, frequency, sampleRate, span, q, gainDb);
}

inline BiquadCoefficients designMatchedHighShelf(double frequency, double sampleRate, double q, double gainDb, double span = detail::kFitSpanDefault) {
  return detail::designShelf(false, frequency, sampleRate, span, q, gainDb);
}

}  // namespace daw::audio_core::dsp
