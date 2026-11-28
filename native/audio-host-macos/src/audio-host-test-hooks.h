#pragma once

#include "daw/audio_host_macos.h"

#include <atomic>
#include <cstdint>
#include <string>

#if defined(DAW_AUDIO_HOST_TEST_MEMORY_LOCK)
extern "C" bool daw_audio_host_test_fail_memory_lock();
extern "C" std::uint64_t daw_audio_host_test_resident_budget();
extern "C" void daw_audio_host_test_validation_memory(bool begin);
extern "C" void daw_audio_host_test_transport_context(
  std::int64_t frame, double bpm, std::uint32_t numerator, std::uint32_t denominator);
#endif

namespace daw::audio_host_macos {

#if defined(DAW_AUDIO_HOST_TEST_PATCH_CLAIM)
// Compiled only into the private test and acceptance targets (CMakeLists.txt). No runtime
// switch exists, so no environment can enable it in another artifact.
inline constexpr std::uint64_t kTestPatchClaimTokenBase = 1ULL << 53U;
// The acceptance executable always holds; the unit-test target opts in per test.
inline std::atomic<bool> test_patch_claim_hold{DAW_AUDIO_HOST_TEST_PATCH_CLAIM == 2};
#if DAW_AUDIO_HOST_TEST_PATCH_CLAIM == 1
inline std::atomic<void (*)()> test_patch_claim_hook{nullptr};
// Runs on the callback thread with the (ack, result) pair as it reads when the ack is stored.
inline std::atomic<void (*)(std::uint64_t, std::uint32_t)> test_patch_ack_hook{nullptr};
// Makes the next applied patch fail in the core (no staged patch left), so a claim can
// resolve with a failure result.
inline std::atomic<bool> test_patch_claim_discard{false};
// Starts attached workers without a plug-in, so the host's worker handling runs in CTest.
inline std::atomic<bool> test_no_plugin_workers{false};
// Replaces the worker executable (a child that is slow to exit). Set from the test thread
// before any attach; the command thread is that same thread.
inline std::string test_worker_executable;
// Stands in for the CoreAudio device: runs inside Start where the device would start its IO callback.
inline std::atomic<bool (*)(AudioHost*, void**)> test_device_start{nullptr};
#endif
#endif

}  // namespace daw::audio_host_macos
