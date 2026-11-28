#include "audio_core_internal.h"

namespace {

struct ProcessorImplementation {
  uint32_t kind;
  ProcessorRenderer render;
};

constexpr std::array<ProcessorImplementation, 17> kProcessorImplementations{{
  {DAW_AUDIO_PROCESSOR_KIND_UTILITY, render_utility_processor},
  {DAW_AUDIO_PROCESSOR_KIND_SATURATOR, render_saturator_processor},
  {DAW_AUDIO_PROCESSOR_KIND_EQ, render_eq_processor},
  {DAW_AUDIO_PROCESSOR_KIND_CHORUS, render_modulation_processor},
  {DAW_AUDIO_PROCESSOR_KIND_FLANGER, render_modulation_processor},
  {DAW_AUDIO_PROCESSOR_KIND_PHASER, render_modulation_processor},
  {DAW_AUDIO_PROCESSOR_KIND_TREMOLO, render_modulation_processor},
  {DAW_AUDIO_PROCESSOR_KIND_AUTOPAN, render_modulation_processor},
  {DAW_AUDIO_PROCESSOR_KIND_ENSEMBLE, render_modulation_processor},
  {DAW_AUDIO_PROCESSOR_KIND_GATE, render_gate_processor},
  {DAW_AUDIO_PROCESSOR_KIND_COMPRESSOR, render_compressor_processor},
  {DAW_AUDIO_PROCESSOR_KIND_LIMITER, render_limiter_processor},
  {DAW_AUDIO_PROCESSOR_KIND_DELAY, render_time_effect_processor},
  {DAW_AUDIO_PROCESSOR_KIND_REVERB, render_time_effect_processor},
  {DAW_AUDIO_PROCESSOR_KIND_SPECTRAL, render_spectral_processor},
  {DAW_AUDIO_PROCESSOR_KIND_AUTOFILTER, render_autofilter_processor},
  {DAW_AUDIO_PROCESSOR_KIND_LOFI, render_lofi_processor},
}};
}  // namespace

namespace daw::audio_core_internal {

ProcessorRenderer find_processor_renderer(uint32_t kind) {
  for (const ProcessorImplementation &implementation : kProcessorImplementations) {
    if (implementation.kind == kind) return implementation.render;
  }
  return nullptr;
}
}  // namespace daw::audio_core_internal
