#pragma once

#include "audio-host-test-hooks.h"
#include "plugin-host-contract-generated.h"

#include <mach-o/dyld.h>

#include <array>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <system_error>
#include <vector>

namespace daw::audio_host_macos {

inline std::optional<std::string> WorkerExecutablePath() {
#if defined(DAW_AUDIO_HOST_TEST_PATCH_CLAIM) && DAW_AUDIO_HOST_TEST_PATCH_CLAIM == 1
  if (!test_worker_executable.empty()) return test_worker_executable;
#endif
  std::uint32_t size = 0;
  if (_NSGetExecutablePath(nullptr, &size) != -1 || size == 0 || size > 16U * 1024U) return std::nullopt;
  std::vector<char> executable(size);
  if (_NSGetExecutablePath(executable.data(), &size) != 0) return std::nullopt;
  std::error_code error;
  const auto host = std::filesystem::canonical(executable.data(), error);
  if (error) return std::nullopt;
  const std::array candidates{
    host.parent_path() / daw::plugin_host::kWorkerArtifactId,
    host.parent_path().parent_path() / "plugin-host" / daw::plugin_host::kWorkerArtifactId,
  };
  for (const auto& candidate : candidates) {
    error.clear();
    const auto worker = std::filesystem::canonical(candidate, error);
    if (!error && std::filesystem::is_regular_file(worker, error) && !error) return worker.string();
  }
  return std::nullopt;
}

}  // namespace daw::audio_host_macos
