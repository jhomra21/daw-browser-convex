#pragma once

#include "daw/audio_core.h"

#include <stddef.h>
#include <stdint.h>

#define DAW_AUDIO_GRAPH_FIXTURE_MAGIC 0x44474631u
#define DAW_AUDIO_GRAPH_FIXTURE_VERSION 3u
#define DAW_AUDIO_GRAPH_FIXTURE_VERSION_ASSETS 2u
#define DAW_AUDIO_GRAPH_FIXTURE_VERSION_LEGACY 1u
#define DAW_AUDIO_GRAPH_FIXTURE_HEADER_BYTES 80u
#define DAW_AUDIO_GRAPH_FIXTURE_HEADER_BYTES_LEGACY 64u
#define DAW_AUDIO_GRAPH_FIXTURE_MAX_ASSETS 4u
#define DAW_AUDIO_GRAPH_FIXTURE_MAX_ASSET_CHANNELS 2u
#define DAW_AUDIO_GRAPH_FIXTURE_MAX_ASSET_FRAMES 4096u

/* All fields are little-endian. The payload is graph envelope bytes, then
 * input_bus_count * channel_count planar float32 samples, then parameter,
 * processor-event, instrument-event, asset-operation, and instrument-state
 * envelopes. Version one omits the final two envelopes. Asset operation
 * records are: u32 count followed by (u32 identity, u32 generation, u32
 * operation, u32 frames, u32 sample_rate, u32 channels, u32 data_bytes,
 * planar f32 data). Operation 1 installs a new identity; operation 2 replaces
 * a live identity and therefore advances its generation. Identity is a
 * one-based fixture slot and configuration state references the resulting
 * native generation-safe handle. Instrument-state records are: u32 count
 * followed by (u64 node_id, u32 kind, u32 state_bytes, u32 zone_bytes,
 * state bytes, zone bytes). State and zone bytes use the portable
 * audio-core-contract encoders. The caller supplies output planes because
 * fixture bytes are immutable. Version three uses header offset 72 for an
 * optional block-partition envelope: u32 count followed by u32 frame counts
 * whose sum must equal the fixture frame count. */
#ifdef __cplusplus
extern "C" {
#endif

uint32_t daw_audio_core_graph_fixture_protocol_version(void);

daw_audio_core_result daw_audio_core_run_graph_fixture(
  const uint8_t *fixture_bytes,
  size_t fixture_byte_count,
  float *const *outputs);

#ifdef __cplusplus
}
#endif
