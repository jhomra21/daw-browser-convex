#pragma once

#define DAW_RECORDING_SPOOL_BLOCK_HEADER_BYTES 4u
#define DAW_RECORDING_SPOOL_SAMPLE_BYTES 4u
#define DAW_RECORDING_SPOOL_MAX_BLOCK_FRAMES 2048u

#ifdef __cplusplus
#include <cstdint>

namespace daw::audio_host_macos {

enum class SpoolState {
  kPreparing = 0,
  kReady = 1,
  kComplete = 2,
  kFailed = 3,
  kCancelled = 4,
};

}
#endif
