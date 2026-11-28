#pragma once

#include <cmath>
#include <limits>

#if defined(__aarch64__) && !defined(__EMSCRIPTEN__)
#define DAW_DSP_FLUSH_AARCH64 1
#elif defined(__SSE2__) && !defined(__EMSCRIPTEN__)
#include <xmmintrin.h>
#define DAW_DSP_FLUSH_X86 1
#endif

namespace daw::audio_core::dsp {

// Below this magnitude a recursive state is replaced by zero. It is the square root of the smallest normal number
// (about -380 dB for float): far under any audible tail, and far above the subnormal range where arithmetic slows down.
template <class T>
constexpr T denormalFloor() {
  if constexpr (sizeof(T) == sizeof(float)) return T(1.0e-19);
  else return T(1.0e-154);
}

// Value-based flush. Wasm has no FTZ/DAZ control, so recursive state (feedback loops, filter memory) must pass
// through this. NaN and infinity pass through unchanged on purpose: finiteOrReset owns them.
template <class T>
constexpr T flushDenormal(T value) {
  return std::fabs(value) < denormalFloor<T>() ? T(0) : value;
}

// A block's output is only trusted when finite. Otherwise the whole block returns to its clean state and the sample
// is silence, so one bad value cannot live on in feedback state. `block.reset()` must be allocation-free.
template <class Block, class T>
inline T finiteOrReset(Block &block, T output) {
  if (std::isfinite(output)) return output;
  block.reset();
  return T(0);
}

#if defined(DAW_DSP_FLUSH_AARCH64) || defined(DAW_DSP_FLUSH_X86)
inline constexpr bool kHasHardwareDenormalFlush = true;
#else
inline constexpr bool kHasHardwareDenormalFlush = false;
#endif

// Sets the CPU's flush-to-zero (and denormals-are-zero where it exists) for the audio thread's scope and restores
// the previous mode. The value-based flush is still required for wasm and for state that is read after the scope.
class ScopedDenormalFlush {
 public:
  ScopedDenormalFlush() {
#if defined(DAW_DSP_FLUSH_AARCH64)
    asm volatile("mrs %0, fpcr" : "=r"(saved_));
    const unsigned long long flushed = saved_ | (1ULL << 24);  // FPCR.FZ
    asm volatile("msr fpcr, %0" : : "r"(flushed));
#elif defined(DAW_DSP_FLUSH_X86)
    saved_ = _mm_getcsr();
    _mm_setcsr(saved_ | 0x8040U);  // FTZ | DAZ
#endif
  }
  ~ScopedDenormalFlush() {
#if defined(DAW_DSP_FLUSH_AARCH64)
    asm volatile("msr fpcr, %0" : : "r"(saved_));
#elif defined(DAW_DSP_FLUSH_X86)
    _mm_setcsr(saved_);
#endif
  }
  ScopedDenormalFlush(const ScopedDenormalFlush &) = delete;
  ScopedDenormalFlush &operator=(const ScopedDenormalFlush &) = delete;

 private:
#if defined(DAW_DSP_FLUSH_AARCH64)
  unsigned long long saved_ = 0;
#elif defined(DAW_DSP_FLUSH_X86)
  unsigned int saved_ = 0;
#endif
};

}  // namespace daw::audio_core::dsp
