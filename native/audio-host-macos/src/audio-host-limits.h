#pragma once

#include "audio-host-test-hooks.h"
#include "worker-control-protocol.h"

#include <sys/sysctl.h>

#include <cstddef>
#include <cstdint>

namespace daw::audio_host_macos {

inline std::uint64_t InstrumentResidentBudget() {
#if defined(DAW_AUDIO_HOST_TEST_MEMORY_LOCK)
  const auto test_budget = daw_audio_host_test_resident_budget();
  if (test_budget != UINT64_MAX) return test_budget;
#endif
  // Reserve at most 1/8 of physical RAM for this host's native copy; renderer PCM and
  // live/export overlap are charged against a shared policy elsewhere.
  std::uint64_t bytes = 0;
  std::size_t size = sizeof(bytes);
  return sysctlbyname("hw.memsize", &bytes, &size, nullptr, 0) == 0 ? bytes / 8 : 0;
}

inline constexpr std::size_t kMaximumNativeVstAttachments = 64;
inline constexpr std::uint32_t kMaximumNativeVstFrames = daw::plugin_host::kMaximumWorkerFrames;
inline constexpr std::uint32_t kMaximumNativeVstChannels = 64;
inline constexpr std::uint32_t kMaximumNativeVstSlots = 8;

inline constexpr std::size_t kMaximumMeterQueueEntries = 1024;
inline constexpr std::size_t kMaximumSpectrumQueueEntries = 8;
inline constexpr std::uint32_t kSpectrumFftSize = 2048;

}  // namespace daw::audio_host_macos
