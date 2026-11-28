#pragma once

#include "numeric_safety.h"

#include <algorithm>
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
//   bell, low-pass, high-pass: Vicanek, "Matched Second Order Digital Filters" (2016), sections 4.1, 4.2 and 4.4:
//     match at DC and at the corner or centre frequency (bell also has zero slope there).
//   shelves (free Q, which Vicanek's 2025 shelf paper does not cover): match at DC, at the corner and at Nyquist.
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

inline BiquadCoefficients designShelf(bool low, double frequency, double sampleRate, double q, double gainDb) {
  const double omega0 = cornerOmega(frequency, sampleRate);
  const double a = std::pow(10.0, gainDb / 40.0);
  const Poles poles = impulseInvariantPoles(0.5 / std::max(q, 0.01), low ? omega0 / std::sqrt(a) : omega0 * std::sqrt(a));
  const Quadratic den = denominator(poles);
  const double B0 = den.c0 * shelfMagnitudeSquared(low, a, q, 0.0);
  const double B1 = den.c1 * shelfMagnitudeSquared(low, a, q, kPi / omega0);
  const double s = std::sin(0.5 * omega0);
  const double phi1 = s * s;
  const double phi2 = 4.0 * (1.0 - phi1) * phi1;
  const double mid = den.at(omega0) * a * a;
  const double B2 = phi2 > 1.0e-12 ? (mid - B0 * (1.0 - phi1) - B1 * phi1) / phi2 : 0.0;
  return withNumerator(poles, B0, B1, B2);
}

}  // namespace detail

inline BiquadCoefficients designMatchedBell(double frequency, double sampleRate, double q, double gainDb) {
  using namespace detail;
  const double omega0 = cornerOmega(frequency, sampleRate);
  const double gain = std::pow(10.0, gainDb / 20.0);
  const Poles poles = impulseInvariantPoles(0.5 / (std::sqrt(gain) * std::max(q, 0.01)), omega0);
  const Quadratic den = denominator(poles);
  const double s = std::sin(0.5 * omega0);
  const double phi1 = s * s;
  const double phi0 = 1.0 - phi1;
  const double B0 = den.c0;
  const double R1 = den.at(omega0) * gain * gain;
  const double R2 = (-den.c0 + den.c1 + 4.0 * (phi0 - phi1) * den.c2) * gain * gain;
  const double B2 = (R1 - R2 * phi1 - B0) / (4.0 * phi1 * phi1);
  const double B1 = R2 + B0 + 4.0 * (phi1 - phi0) * B2;
  return withNumerator(poles, B0, B1, B2);
}

inline BiquadCoefficients designMatchedLowPass(double frequency, double sampleRate, double q) {
  using namespace detail;
  const double omega0 = cornerOmega(frequency, sampleRate);
  const double quality = std::max(q, 0.01);
  const Poles poles = impulseInvariantPoles(0.5 / quality, omega0);
  const Quadratic den = denominator(poles);
  const double s = std::sin(0.5 * omega0);
  const double phi1 = s * s;
  const double R1 = den.at(omega0) * quality * quality;
  const double B1 = (R1 - den.c0 * (1.0 - phi1)) / phi1;
  return withNumerator(poles, den.c0, B1, 0.0);
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

inline BiquadCoefficients designMatchedLowShelf(double frequency, double sampleRate, double q, double gainDb) {
  return detail::designShelf(true, frequency, sampleRate, q, gainDb);
}

inline BiquadCoefficients designMatchedHighShelf(double frequency, double sampleRate, double q, double gainDb) {
  return detail::designShelf(false, frequency, sampleRate, q, gainDb);
}

}  // namespace daw::audio_core::dsp
