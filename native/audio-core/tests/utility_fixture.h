#pragma once

#include "daw/audio_core.h"

#include <stddef.h>
#include <stdint.h>

#define DAW_AUDIO_UTILITY_FIXTURE_MAGIC 0x44554631u
#define DAW_AUDIO_UTILITY_FIXTURE_VERSION 1u

typedef struct daw_audio_utility_fixture_header {
  uint32_t magic;
  uint32_t version;
  uint32_t sample_rate_hz;
  uint32_t frame_count;
  uint32_t channel_count;
  uint32_t input_bus_count;
  daw_audio_utility_state state;
} daw_audio_utility_fixture_header;

/*
 * The fixture is a contiguous native/Wasm memory payload: header followed by
 * input_bus_count * channel_count planar float32 buffers. Output buffers are
 * supplied separately so the payload can be shared without mutation.
 */
#ifdef __cplusplus
extern "C" {
#endif

daw_audio_core_result daw_audio_core_run_utility_fixture(
  const uint8_t *fixture_bytes,
  size_t fixture_byte_count,
  float *const *outputs);

#ifdef __cplusplus
}
#endif
