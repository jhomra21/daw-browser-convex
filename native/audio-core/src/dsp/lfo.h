#pragma once

#include <cmath>
#include <cstdint>

namespace daw::audio_core::dsp {

// Parabolic sine of 2 pi * phase for phase in cycles, from the fast-sine approximation: t = phase - round(phase),
// d = 8t - 16t|t|, sin ~ 0.225 (d|d| - d) + d. Largest error 1.09e-3 (-59 dBFS), THD -62 dB, and about 1.3 % low
// near zero. It only uses +, *, abs and round, so the float AudioWorklet port matches it step for step.
// Only for LFOs, modulation shapes and pan laws: not for audio-rate oscillators or filter coefficient design.
inline float fastSineCycles(float phase) {
  const float t = phase - std::floor(phase + 0.5F);
  const float quadratic = 16.0F * t * std::fabs(t);
  const float d = 8.0F * t - quadratic;
  const float correction = d * std::fabs(d) - d;
  return 0.225F * correction + d;
}

// Stepped random in [-1, 1] for one cycle of a sample-and-hold LFO. A hash of the cycle number, so left and right
// channels, native and worklet all read one sequence.
inline float lfoRandom(uint32_t cycle) {
  uint32_t x = cycle * 2654435761U;
  x ^= x >> 16;
  x *= 0x45D9F3BU;
  x ^= x >> 16;
  return static_cast<float>(x) * (2.0F / 4294967295.0F) - 1.0F;
}

// Bipolar LFO shape at `fraction` of a cycle. `cycle` seeds the random shapes.
//   0 sine, 1 triangle (starts at -1), 2 saw down, 3 saw up, 4 square, 5 sample and hold, 6 wander (smooth random).
inline float lfoShape(uint32_t waveform, double fraction, uint32_t cycle) {
  const float f = static_cast<float>(fraction);
  switch (waveform) {
    case 1: return 1.0F - 4.0F * std::fabs(f - 0.5F);
    case 2: return 1.0F - 2.0F * f;
    case 3: return 2.0F * f - 1.0F;
    case 4: return f < 0.5F ? 1.0F : -1.0F;
    case 5: return lfoRandom(cycle);
    case 6: {
      const float eased = f * f * (3.0F - 2.0F * f);
      const float from = lfoRandom(cycle);
      return from + (lfoRandom(cycle + 1U) - from) * eased;
    }
    default: return fastSineCycles(f);
  }
}

constexpr uint32_t kLfoWaveformCount = 7;

// The shape at `phase` cycles (any real, offsets included). `cycleBase` is the cycle count the phase starts from, so
// the random shapes read one sequence however the phase was reached.
inline float lfoAtPhase(uint32_t waveform, double phase, uint32_t cycleBase) {
  const double whole = std::floor(phase);
  return lfoShape(waveform, phase - whole, cycleBase + static_cast<uint32_t>(static_cast<int64_t>(whole)));
}

// A free-running LFO position: the phase in cycles and how many cycles it has completed.
struct LfoClock {
  double phase = 0.0;
  uint32_t cycle = 0;

  float shape(uint32_t waveform, double offset) const { return lfoAtPhase(waveform, phase + offset, cycle); }

  void advance(double cycles) {
    phase += cycles;
    if (phase >= 1.0) {
      const double wraps = std::floor(phase);
      phase -= wraps;
      cycle += static_cast<uint32_t>(wraps);
    }
  }
};

// Where the song is at the current frame. With Sync on and the transport running, an LFO's phase is a function of this
// position, so the same bar always sweeps the same way whatever frame rendering started from. A stopped transport keeps
// the LFO free-running at the tempo, so live input still moves.
struct LfoTransport {
  double tempo_bpm = 0.0;  // 0 when the host has not sent a tempo yet: kDefaultTempoBpm is used
  int64_t frame = 0;       // song position in sample frames
  bool running = false;
};

constexpr uint32_t kLfoDivisionCount = 16;
constexpr double kDefaultTempoBpm = 120.0;

// LFO cycle length in quarter-note beats: 2 bars, 1 bar, then straight, dotted and triplet values down to 1/32.
inline float lfoSyncRateHz(uint32_t division, double tempoBpm) {
  static constexpr float kBeats[kLfoDivisionCount] = {8.0F, 4.0F, 3.0F, 2.0F, 1.5F, 1.0F, 2.0F / 3.0F, 0.75F, 0.5F,
    1.0F / 3.0F, 0.375F, 0.25F, 1.0F / 6.0F, 0.1875F, 0.125F, 1.0F / 12.0F};
  const double bpm = tempoBpm > 0.0 ? tempoBpm : kDefaultTempoBpm;
  return static_cast<float>(bpm / 60.0 / kBeats[division < kLfoDivisionCount ? division : kLfoDivisionCount - 1]);
}

}  // namespace daw::audio_core::dsp
