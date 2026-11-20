#pragma once

#include <cstddef>
#include <cstdint>
#include <string_view>

namespace daw::plugin_host {

constexpr std::uint32_t kWorkerTransportAbiVersion = 7;
constexpr std::uint32_t kWorkerManifestVersion = 1;
constexpr std::uint32_t kWorkerStartupProtocolVersion = 1;
constexpr std::uint32_t kWorkerControlProtocolVersion = 2;
constexpr std::string_view kWorkerArtifactId = "daw-vst3-worker";
constexpr std::string_view kWorkerArtifactVersion = "3";
constexpr std::size_t kMaximumControlFrameBytes = 1048576;
constexpr std::size_t kMaximumWorkerStateBytes = 524288;
constexpr std::size_t kMaximumWorkerFrames = 8192;
constexpr double kMaximumWorkerSampleRateHz = 384000.0;

// Fault-only values in the existing diagnostic value field; non-fault values keep their meanings.
enum class WorkerFaultOrigin : std::uint32_t {
  kUnknown = 0,
  kChildExit = 1,
  kChildSignal = 2,
  kTransportFault = 3,
  kDispatchFailure = 4,
  kCallbackMissTermination = 5,
  kStartupFailure = 6,
  kStartupException = 7,
  kConfigureFailure = 8,
  kConfigureException = 9,
  kProcessFailure = 10,
  kProcessException = 11,
  kWorkerNotification = 12,
  kUnknownWorkerNotification = 13,
  kOfflineCompletionFailure = 14,
  kControlIoFailure = 15,
  kLaunchNotTrusted = 16,
};

// A worker fault without an origin is the plug-in's component callback.
inline constexpr WorkerFaultOrigin kZeroDiagnosticFaultOrigin = WorkerFaultOrigin::kWorkerNotification;

constexpr bool IsPluginFaultOrigin(const std::uint32_t faultValue) noexcept {
  switch (static_cast<WorkerFaultOrigin>(faultValue & 0xffU)) {
    case WorkerFaultOrigin::kChildExit:
    case WorkerFaultOrigin::kChildSignal:
    case WorkerFaultOrigin::kConfigureFailure:
    case WorkerFaultOrigin::kConfigureException:
    case WorkerFaultOrigin::kProcessFailure:
    case WorkerFaultOrigin::kProcessException:
    case WorkerFaultOrigin::kWorkerNotification:
      return true;
    default:
      return false;
  }
}

}
