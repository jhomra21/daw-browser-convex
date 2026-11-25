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

// Impulse-invariant poles sit where the analog poles do, which is wrong once they are near Nyquist: a shelf whose pole
// frequency omega0 / sqrt(a) or omega0 * sqrt(a) reaches 0.9 fs, or a bell at 19 kHz, leaves 0.3 to 0.6 dB inside the
// band whatever the numerator is. When the fit is further than kPolishTriggerDb from the prototype anywhere on a log grid
// over the EQ range (20 Hz at 96 kHz up to 0.45 fs), all five coefficients are moved by damped Gauss-Newton on the dB error (Lawson weights, as above, so a
// pass can raise the worst error before the next lowers it). The best pass is kept, and the search stops if the poles leave
// the unit circle. Bands that fit already are
// left exactly as fittedNumerator made them. Points where the prototype is below -60 dB are not judged.
inline constexpr int kPolishPoints = 96;
inline constexpr int kPolishPasses = 8;
inline constexpr double kPolishTriggerDb = 0.1;
inline constexpr double kPolishDamping = 1.0e-3;
inline constexpr double kPolishFloorDb = -60.0;  // the stop band is not judged below this, as in the harness

using Coefficients5 = std::array<double, 5>;  // b0 b1 b2 a1 a2

inline double responseDb(const Coefficients5 &c, double omega) {
  const double c1 = std::cos(omega);
  const double c2 = std::cos(2.0 * omega);
  const double num = c[0] * c[0] + c[1] * c[1] + c[2] * c[2] + 2.0 * (c[0] * c[1] + c[1] * c[2]) * c1 + 2.0 * c[0] * c[2] * c2;
  const double den = 1.0 + c[3] * c[3] + c[4] * c[4] + 2.0 * (c[3] + c[3] * c[4]) * c1 + 2.0 * c[4] * c2;
  return 10.0 * std::log10(num / den);
}

inline bool polesInside(const Coefficients5 &c) { return std::abs(c[4]) < 0.9999 && std::abs(c[3]) < 1.0 + c[4] - 1.0e-6; }

// Gaussian elimination with partial pivoting on the 5 x 5 system a x = b.
inline Coefficients5 solve5(std::array<Coefficients5, 5> a, Coefficients5 b) {
  for (int i = 0; i < 5; ++i) {
    int pivot = i;
    for (int k = i + 1; k < 5; ++k) {
      if (std::abs(a[k][i]) > std::abs(a[pivot][i])) pivot = k;
    }
    std::swap(a[i], a[pivot]);
    std::swap(b[i], b[pivot]);
    for (int k = i + 1; k < 5; ++k) {
      const double m = a[k][i] / a[i][i];
      for (int j = i; j < 5; ++j) a[k][j] -= m * a[i][j];
      b[k] -= m * b[i];
    }
  }
  Coefficients5 x{};
  for (int i = 4; i >= 0; --i) {
    double sum = b[i];
    for (int j = i + 1; j < 5; ++j) sum -= a[i][j] * x[j];
    x[i] = sum / a[i][i];
  }
  return x;
}

template <class AnalogSquared>
inline BiquadCoefficients polished(const BiquadCoefficients &fitted, double omega0, double span, AnalogSquared analogSquared) {
  std::array<double, kPolishPoints> omegas{};
  std::array<double, kPolishPoints> targets{};
  std::array<double, kPolishPoints> weights{};
  for (int i = 0; i < kPolishPoints; ++i) {
    omegas[i] = span * 4.0e-4 * std::pow(2500.0, static_cast<double>(i) / (kPolishPoints - 1));
    targets[i] = 10.0 * std::log10(analogSquared(omegas[i] / omega0));
    weights[i] = targets[i] > kPolishFloorDb ? 1.0 : 0.0;
  }
  const auto worst = [&](const Coefficients5 &c) {
    double result = 0.0;
    for (int i = 0; i < kPolishPoints; ++i) {
      if (targets[i] > kPolishFloorDb) result = std::max(result, std::abs(responseDb(c, omegas[i]) - targets[i]));
    }
    return result;
  };

  Coefficients5 best = {fitted.b0, fitted.b1, fitted.b2, fitted.a1, fitted.a2};
  double bestError = worst(best);
  if (bestError <= kPolishTriggerDb) return fitted;

  Coefficients5 current = best;
  for (int pass = 0; pass < kPolishPasses; ++pass) {
    std::array<Coefficients5, kPolishPoints> jacobian{};
    std::array<double, kPolishPoints> residual{};
    for (int i = 0; i < kPolishPoints; ++i) {
      residual[i] = responseDb(current, omegas[i]) - targets[i];
      for (int k = 0; k < 5; ++k) {
        Coefficients5 moved = current;
        const double step = 1.0e-6 * std::max(std::abs(current[k]), 1.0e-3);
        moved[k] += step;
        jacobian[i][k] = (responseDb(moved, omegas[i]) - responseDb(current, omegas[i])) / step;
      }
    }
    std::array<Coefficients5, 5> normal{};
    Coefficients5 gradient{};
    for (int i = 0; i < kPolishPoints; ++i) {
      for (int j = 0; j < 5; ++j) {
        gradient[j] -= weights[i] * jacobian[i][j] * residual[i];
        for (int k = 0; k < 5; ++k) normal[j][k] += weights[i] * jacobian[i][j] * jacobian[i][k];
      }
    }
    for (int j = 0; j < 5; ++j) normal[j][j] *= 1.0 + kPolishDamping;

    Coefficients5 next = solve5(normal, gradient);
    for (int k = 0; k < 5; ++k) next[k] += current[k];
    if (!polesInside(next)) break;
    current = next;

    const double error = worst(current);
    if (error < bestError) {
      best = current;
      bestError = error;
    }

    double total = 0.0;
    for (int i = 0; i < kPolishPoints; ++i) {
      weights[i] *= std::max(std::abs(responseDb(current, omegas[i]) - targets[i]), 1.0e-4);
      total += weights[i];
    }
    for (int i = 0; i < kPolishPoints; ++i) weights[i] = weights[i] * kPolishPoints / total;
  }
  return BiquadCoefficients{best[0], best[1], best[2], best[3], best[4]};
}

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
  return polished(withNumerator(p, B0, (corner - B2 * corner2) / corner1, B2), omega0, span, analogSquared);
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
