#include "daw/audio_core.h"
#include "utility_fixture.h"

extern "C" uint32_t daw_audio_core_wasm_harness_abi_version(void) {
  return daw_audio_core_get_abi_version();
}

extern "C" uint32_t daw_audio_core_wasm_fixture_protocol_version(void) {
  return DAW_AUDIO_UTILITY_FIXTURE_VERSION;
}
