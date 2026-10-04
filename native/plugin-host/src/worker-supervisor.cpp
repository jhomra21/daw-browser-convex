#include "worker-supervisor.h"

#include <algorithm>
#include <cmath>
#include <cctype>
#include <unordered_set>

namespace daw::plugin_host {
namespace {

bool IsSha256(const std::string& fingerprint) {
  if (fingerprint.size() != 64) return false;
  for (const char character : fingerprint) {
    if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) return false;
  }
  return true;
}

bool IsClassId(const std::string& classId) {
  return classId.size() == 32 && std::all_of(classId.begin(), classId.end(), [](const unsigned char value) {
    return std::isxdigit(value) != 0;
  });
}

bool IsValidSetup(const WorkerProcessSetup& setup) {
  return std::isfinite(setup.sampleRate) && setup.sampleRate > 0.0 && setup.sampleRate <= 384'000.0
    && setup.maximumBlockFrames > 0 && setup.maximumBlockFrames <= kMaximumWorkerFrames
    && setup.inputChannels <= kMaximumWorkerChannels && setup.outputChannels > 0
    && setup.outputChannels <= kMaximumWorkerChannels
    && (setup.mode == WorkerProcessSetup::Mode::kRealtime || setup.mode == WorkerProcessSetup::Mode::kOffline);
}

bool IsUuid(const std::string& value) {
  if (value.size() != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-') return false;
  for (std::size_t index = 0; index < value.size(); ++index) {
    if (index == 8 || index == 13 || index == 18 || index == 23) continue;
    if (std::isxdigit(static_cast<unsigned char>(value[index])) == 0) return false;
  }
  const auto version = static_cast<unsigned char>(value[14]);
  const auto variant = static_cast<unsigned char>(std::tolower(static_cast<unsigned char>(value[19])));
  return version >= '1' && version <= '8' && (variant == '8' || variant == '9' || variant == 'a' || variant == 'b');
}

bool IsRequestId(const std::string& value) {
  return !value.empty() && value.size() <= 96 && std::all_of(value.begin(), value.end(), [](const unsigned char character) {
    return std::isalnum(character) != 0 || character == '.' || character == '_' || character == '-';
  });
}

bool IsValidBus(const WorkerBusDescriptor& bus) {
  return !bus.name.empty() && bus.name.size() <= 128 && bus.channels <= kMaximumWorkerChannels;
}

std::optional<std::size_t> EnabledChannels(const std::vector<WorkerBusDescriptor>& buses) {
  std::size_t channels = 0;
  for (const auto& bus : buses) {
    if (!IsValidBus(bus)) return std::nullopt;
    if (bus.enabled) {
      if (bus.channels > kMaximumWorkerChannels - channels) return std::nullopt;
      channels += bus.channels;
    }
  }
  return channels;
}

bool IsValidPreflightRequirements(const WorkerPreflightRequirements& requirements) {
  return IsValidWorkerArtifactIdentity(requirements.artifact)
    && requirements.startupProtocolVersion == kWorkerStartupProtocolVersion
    && requirements.controlProtocolVersion == kWorkerControlProtocolVersion
    && requirements.transportAbiVersion == kWorkerTransportAbiVersion
    && requirements.arm64;
}

}  // namespace

bool IsValidWorkerArtifactIdentity(const WorkerArtifactIdentity& identity) {
  return identity.id == kWorkerArtifactId && identity.version == kWorkerArtifactVersion;
}

bool IsValidWorkerHostConfiguration(const WorkerHostConfiguration& configuration) {
  return !configuration.executable.empty() && IsValidWorkerArtifactIdentity(configuration.artifact);
}

bool IsValidWorkerManifest(const WorkerManifest& manifest) {
  if (manifest.version != kWorkerManifestVersion || !IsValidWorkerArtifactIdentity(manifest.artifact)
    || manifest.startupProtocolVersion != kWorkerStartupProtocolVersion
    || manifest.controlProtocolVersion != kWorkerControlProtocolVersion
    || manifest.transportAbiVersion != kWorkerTransportAbiVersion || !manifest.arm64
    || (manifest.role != WorkerPluginRole::kEffect && manifest.role != WorkerPluginRole::kInstrument)
    || manifest.inputBuses.size() > 32 || manifest.outputBuses.empty() || manifest.outputBuses.size() > 32
    || manifest.transport.slotCount < 2 || manifest.transport.slotCount > kMaximumWorkerSlots
    || manifest.transport.maximumFrames == 0 || manifest.transport.maximumFrames > kMaximumWorkerFrames
    || manifest.transport.inputChannels > kMaximumWorkerChannels
    || manifest.transport.outputChannels == 0 || manifest.transport.outputChannels > kMaximumWorkerChannels
    || manifest.transport.maximumEventsPerBlock > kMaximumWorkerEvents || manifest.latencyFrames > 10'000'000
    || (manifest.tailFrames && !IsValidFiniteWorkerTailFrames(*manifest.tailFrames))
    || manifest.stateRevision > 0x7fff'ffffU
    || manifest.parameters.size() > 16'384) {
    return false;
  }
  std::unordered_set<std::uint32_t> parameterIds;
  for (const auto& parameter : manifest.parameters) {
    if (parameter.title.empty() || parameter.title.size() > 256
      || parameter.unit.size() > 64 || !std::isfinite(parameter.minimum) || !std::isfinite(parameter.maximum)
      || !std::isfinite(parameter.defaultValue) || parameter.minimum > parameter.maximum
      || parameter.defaultValue < parameter.minimum || parameter.defaultValue > parameter.maximum
      || parameter.stepCount > 1'000'000 || !parameterIds.insert(parameter.id).second) return false;
  }
  const auto inputChannels = EnabledChannels(manifest.inputBuses);
  const auto outputChannels = EnabledChannels(manifest.outputBuses);
  return inputChannels.has_value() && outputChannels.has_value()
    && *inputChannels == manifest.transport.inputChannels
    && *outputChannels == manifest.transport.outputChannels
    && (manifest.role == WorkerPluginRole::kInstrument
      ? manifest.transport.inputChannels == 0
      : manifest.transport.inputChannels > 0);
}

bool IsValidWorkerHello(const WorkerHello& hello) {
  return IsUuid(hello.instanceId) && IsValidWorkerManifest(hello.manifest);
}

bool IsValidWorkerPreflightRequest(const WorkerPreflightRequest& request) {
  return request.version == 1 && IsRequestId(request.requestId) && IsValidPreflightRequirements(request.requirements);
}

bool IsValidWorkerPreflightResult(const WorkerPreflightResult& result) {
  if (result.version != 1 || !IsRequestId(result.requestId) || !IsValidPreflightRequirements(result.requirements)) return false;
  if (result.status == WorkerPreflightStatus::kAvailable) {
    return result.code.empty() && result.message.empty() && result.hello && IsValidWorkerHello(*result.hello);
  }
  const bool knownCode = result.code == "worker-unavailable" || result.code == "worker-timeout"
    || result.code == "worker-crashed" || result.code == "worker-invalid-response";
  return result.status == WorkerPreflightStatus::kUnavailable && knownCode
    && !result.message.empty() && result.message.size() <= 512 && !result.hello;
}

bool IsWorkerLaunchEligible(const WorkerLaunchEligibility& eligibility) {
  return !eligibility.canonicalBundlePath.empty()
    && !eligibility.canonicalExecutablePath.empty()
    && eligibility.canonicalExecutablePath.starts_with(eligibility.canonicalBundlePath + "/")
    && IsSha256(eligibility.bundleFingerprint)
    && IsSha256(eligibility.binaryFingerprint)
    && eligibility.arm64
    && eligibility.codeSignVerified
    && !eligibility.quarantinePresent
    && eligibility.scannerProtocolVersion == 2;
}

bool IsValidWorkerStartupRequest(const WorkerStartupRequest& request) {
  if (!IsValidSetup(request.setup)) return false;
  if (request.state && !IsValidWorkerState(*request.state)) return false;
  if (request.noPluginTestMode) {
    return request.classId.empty() && request.eligibility.canonicalBundlePath.empty()
      && request.eligibility.canonicalExecutablePath.empty() && !request.state;
  }
  return !request.noPluginTestMode && IsWorkerLaunchEligible(request.eligibility) && IsClassId(request.classId);
}

}  // namespace daw::plugin_host
