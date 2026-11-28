// Fits the pole correction tables of src/dsp/biquad.h (see PoleCorrection there). Each node of the table is a corner
// frequency, Q and gain; its value is the pair of denominator corrections (at DC and at Nyquist, as natural logs) that
// minimises the worst |digital - analog| over the EQ range, found by Nelder-Mead on the real design (fit of the numerator
// included), so the table moves exactly what the design uses. Used by eq_pole_table_generator.cpp, which writes the tables,
// and by eq_design_test.cpp, which checks that the checked-in tables are what this produces.
#pragma once

#include "../src/dsp/biquad.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <vector>

namespace daw::audio_core::dsp::tools {

using detail::PoleCorrection;

enum class Shape { Bell, LowShelf, LowPass };

struct Node {
  Shape shape;
  double omega0;
  double quality;
  double gainDb;
};

// The judged range: 256 log-spaced points from 4e-4 of the fit span up to it (20 Hz up to 0.45 fs at 96 kHz); points where
// the prototype is below -60 dB are not judged, because the float32 render floor dominates there.
inline constexpr int kJudgePoints = 256;
inline constexpr double kJudgeFloorDb = -60.0;
// A node is kept only if the correction takes the worst error down by at least this much, and to at most three quarters of what it was.
// The rest are zero: a correction fitted to noise would be interpolated into neighbours that are sensitive to it.
inline constexpr double kMinGainDb = 0.03;
inline constexpr double kMinGainRatio = 0.75;
// Nodes with a corner below this many pi stay zero, see kPoleTableOmegaNodes in biquad.h.
inline constexpr double kZeroBelowOmega = 0.05;
// Pulls a flat valley of the worst error toward no correction.
inline constexpr double kRegularisation = 0.5;
inline constexpr double kLimit = 0.9;

inline double responseDb(const BiquadCoefficients &c, double omega) {
  const double c1 = std::cos(omega);
  const double c2 = std::cos(2.0 * omega);
  const double num = c.b0 * c.b0 + c.b1 * c.b1 + c.b2 * c.b2 + 2.0 * (c.b0 * c.b1 + c.b1 * c.b2) * c1 + 2.0 * c.b0 * c.b2 * c2;
  const double den = 1.0 + c.a1 * c.a1 + c.a2 * c.a2 + 2.0 * (c.a1 + c.a1 * c.a2) * c1 + 2.0 * c.a2 * c2;
  return 10.0 * std::log10(num / den);
}

inline double analogSquared(const Node &node, double x) {
  if (node.shape == Shape::Bell) return detail::bellMagnitudeSquared(std::pow(10.0, node.gainDb / 20.0), node.quality, x);
  if (node.shape == Shape::LowPass) return detail::lowPassMagnitudeSquared(node.quality, x);
  const double a = std::pow(10.0, node.gainDb / 40.0);
  return detail::shelfMagnitudeSquared(true, a, std::sqrt(a), node.quality, x);
}

inline BiquadCoefficients design(const Node &node, const PoleCorrection &correction) {
  const double span = detail::kFitSpanDefault;
  switch (node.shape) {
    case Shape::Bell: return detail::designBellAt(node.omega0, node.quality, node.gainDb, span, correction);
    case Shape::LowShelf: return detail::designShelfAt(true, node.omega0, node.quality, node.gainDb, span, correction);
    case Shape::LowPass: return detail::designLowPassAt(node.omega0, node.quality, span, correction);
  }
  return {};
}

inline double worstError(const Node &node, const BiquadCoefficients &c) {
  double worst = 0.0;
  for (int i = 0; i < kJudgePoints; ++i) {
    const double omega = detail::kFitSpanDefault * 4.0e-4 * std::pow(2500.0, static_cast<double>(i) / (kJudgePoints - 1));
    const double target = 10.0 * std::log10(analogSquared(node, omega / node.omega0));
    if (target > kJudgeFloorDb) worst = std::max(worst, std::abs(responseDb(c, omega) - target));
  }
  return worst;
}

struct Solution {
  PoleCorrection correction;
  double cost;
};

// Nelder-Mead on the two corrections. The cost is the worst error plus a small pull toward zero.
inline Solution minimise(const Node &node, const PoleCorrection &start, double step) {
  const auto cost = [&](const PoleCorrection &c) {
    if (std::abs(c.dc) > kLimit || std::abs(c.nyquist) > kLimit) return 1.0e9;
    return worstError(node, design(node, c)) + kRegularisation * (c.dc * c.dc + c.nyquist * c.nyquist);
  };
  std::array<Solution, 3> simplex{{
    {start, 0.0}, {{start.dc + step, start.nyquist}, 0.0}, {{start.dc, start.nyquist + step}, 0.0}}};
  for (Solution &vertex : simplex) vertex.cost = cost(vertex.correction);
  const auto along = [&](const PoleCorrection &from, const PoleCorrection &to, double t) {
    return PoleCorrection{from.dc + t * (to.dc - from.dc), from.nyquist + t * (to.nyquist - from.nyquist)};
  };
  for (int iteration = 0; iteration < 120; ++iteration) {
    std::sort(simplex.begin(), simplex.end(), [](const Solution &a, const Solution &b) { return a.cost < b.cost; });
    const PoleCorrection &best = simplex[0].correction;
    const PoleCorrection &worst = simplex[2].correction;
    if (simplex[2].cost - simplex[0].cost < 1.0e-6 && std::hypot(worst.dc - best.dc, worst.nyquist - best.nyquist) < 1.0e-4) break;
    const PoleCorrection centre = along(simplex[0].correction, simplex[1].correction, 0.5);
    const PoleCorrection reflected = along(worst, centre, 2.0);
    const double reflectedCost = cost(reflected);
    if (reflectedCost < simplex[0].cost) {
      const PoleCorrection expanded = along(worst, centre, 3.0);
      const double expandedCost = cost(expanded);
      simplex[2] = expandedCost < reflectedCost ? Solution{expanded, expandedCost} : Solution{reflected, reflectedCost};
    } else if (reflectedCost < simplex[1].cost) {
      simplex[2] = {reflected, reflectedCost};
    } else {
      const PoleCorrection contracted = along(worst, centre, 0.5);
      const double contractedCost = cost(contracted);
      if (contractedCost < simplex[2].cost) {
        simplex[2] = {contracted, contractedCost};
      } else {
        for (int i = 1; i < 3; ++i) {
          simplex[i].correction = along(best, simplex[i].correction, 0.5);
          simplex[i].cost = cost(simplex[i].correction);
        }
      }
    }
  }
  return *std::min_element(simplex.begin(), simplex.end(), [](const Solution &a, const Solution &b) { return a.cost < b.cost; });
}

inline double nodeOmega(int i) {
  const double t = detail::kPoleTableOmegaTop * i / (detail::kPoleTableOmegaNodes - 1);
  return detail::kPi * t * t;
}
inline double nodeQuality(int j) {
  return detail::kPoleTableMinQ * std::pow(detail::kPoleTableMaxQ / detail::kPoleTableMinQ, static_cast<double>(j) / (detail::kPoleTableQNodes - 1));
}
inline double nodeGainDb(int k) {
  return detail::kPoleTableMaxGainDb * (2.0 * k / (detail::kPoleTableGainNodes - 1) - 1.0);
}

// The table of one shape in the layout biquad.h reads: omega, Q, gain, then (dc, nyquist). Each node starts from zero and
// from the already fitted neighbours at the next lower omega, Q and gain, so a valley that runs through the table is followed.
inline std::vector<double> fitTable(Shape shape) {
  constexpr int kO = detail::kPoleTableOmegaNodes;
  constexpr int kQ = detail::kPoleTableQNodes;
  const int kG = shape == Shape::LowPass ? 1 : detail::kPoleTableGainNodes;
  const auto index = [&](int i, int j, int k) { return (i * kQ + j) * kG + k; };
  std::vector<PoleCorrection> fitted(kO * kQ * kG);
  std::vector<double> table(2 * kO * kQ * kG, 0.0);
  for (int k = 0; k < kG; ++k) {
    for (int j = 0; j < kQ; ++j) {
      for (int i = 0; i < kO; ++i) {
        const Node node{shape, nodeOmega(i), nodeQuality(j), kG == 1 ? 0.0 : nodeGainDb(k)};
        if (node.omega0 < kZeroBelowOmega * detail::kPi) continue;
        std::vector<PoleCorrection> starts{PoleCorrection{}};
        if (i > 0) starts.push_back(fitted[index(i - 1, j, k)]);
        if (j > 0) starts.push_back(fitted[index(i, j - 1, k)]);
        if (k > 0) starts.push_back(fitted[index(i, j, k - 1)]);
        Solution best{PoleCorrection{}, 1.0e18};
        for (const PoleCorrection &start : starts) {
          const Solution candidate = minimise(node, start, 0.03);
          if (candidate.cost < best.cost) best = candidate;
        }
        for (const double step : {0.01, 0.003}) {
          const Solution candidate = minimise(node, best.correction, step);
          if (candidate.cost < best.cost) best = candidate;
        }
        fitted[index(i, j, k)] = best.correction;
        const double before = worstError(node, design(node, PoleCorrection{}));
        const double after = worstError(node, design(node, best.correction));
        if (before - after < kMinGainDb || after > kMinGainRatio * before) continue;
        table[2 * index(i, j, k)] = best.correction.dc;
        table[2 * index(i, j, k) + 1] = best.correction.nyquist;
      }
    }
  }
  return table;
}

}  // namespace daw::audio_core::dsp::tools
