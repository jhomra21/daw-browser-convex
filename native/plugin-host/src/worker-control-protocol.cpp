#include "worker-control-protocol.h"

#include <array>
#include <cerrno>
#include <csignal>
#include <cstring>
#include <limits>
#include <pthread.h>
#include <string_view>
#include <unistd.h>

namespace daw::plugin_host {
namespace {

constexpr std::uint64_t kStartupMagic = 0x4441575653545354ULL;
constexpr std::uint32_t kStartupVersion = 1;
constexpr std::uint32_t kMaximumStartupBytes = kMaximumWorkerStateBytes + 16U * 1024U;
constexpr std::uint32_t kMaximumPathBytes = 4U * 1024U;
constexpr std::uint32_t kMaximumClassIdBytes = 32;
constexpr std::uint32_t kMaximumFingerprintBytes = 64;
constexpr std::uint64_t kHelloMagic = 0x444157565354484cULL;
constexpr std::uint32_t kHelloVersion = 1;
constexpr std::uint32_t kMaximumHelloBytes = 16U * 1024U;
constexpr std::uint32_t kMaximumInstanceIdBytes = 36;
constexpr std::uint32_t kMaximumArtifactTextBytes = 64;
constexpr std::uint32_t kMaximumBusNameBytes = 128;

struct StartupHeader {
  std::uint64_t magic = kStartupMagic;
  std::uint32_t version = kStartupVersion;
  std::uint32_t bytes = 0;
  std::uint64_t transportToken = 0;
  std::uint32_t noPluginTestMode = 0;
  std::uint32_t arm64 = 0;
  std::uint32_t codeSignVerified = 0;
  std::uint32_t quarantinePresent = 0;
  std::uint32_t scannerProtocolVersion = 0;
  double sampleRate = 0.0;
  std::uint32_t maximumBlockFrames = 0;
  std::uint32_t inputChannels = 0;
  std::uint32_t outputChannels = 0;
  std::uint32_t processMode = 0;
  std::uint32_t classIdBytes = 0;
  std::uint32_t bundlePathBytes = 0;
  std::uint32_t executablePathBytes = 0;
  std::uint32_t bundleFingerprintBytes = 0;
  std::uint32_t binaryFingerprintBytes = 0;
  std::uint32_t stateBytes = 0;
  std::uint32_t stateHashBytes = 0;
};

struct CommandFrame {
  std::uint32_t command = 0;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::uint32_t hasAnchor = 0;
  std::int32_t anchorX = 0;
  std::int32_t anchorY = 0;
};

struct ProcessResponseFrame {
  std::uint64_t sequence = 0;
  std::uint32_t success = 0;
};

struct EditorResponseFrame {
  std::uint32_t success = 0;
  std::uint32_t supported = 0;
  std::uint32_t open = 0;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
};

struct StateFrame {
  std::uint32_t bytes = 0;
  std::uint32_t hashBytes = 0;
};

struct HelloHeader {
  std::uint64_t magic = kHelloMagic;
  std::uint32_t version = kHelloVersion;
  std::uint32_t bytes = 0;
  std::uint32_t instanceIdBytes = 0;
  std::uint32_t artifactIdBytes = 0;
  std::uint32_t artifactVersionBytes = 0;
  std::uint32_t manifestVersion = 0;
  std::uint32_t startupProtocolVersion = 0;
  std::uint32_t controlProtocolVersion = 0;
  std::uint32_t transportAbiVersion = 0;
  std::uint32_t arm64 = 0;
  std::uint32_t role = 0;
  std::uint32_t inputBusCount = 0;
  std::uint32_t outputBusCount = 0;
  std::uint32_t slotCount = 0;
  std::uint32_t maximumFrames = 0;
  std::uint32_t inputChannels = 0;
  std::uint32_t outputChannels = 0;
  std::uint32_t maximumEventsPerBlock = 0;
  std::uint32_t latencyFrames = 0;
  std::uint32_t hasTailFrames = 0;
  std::uint32_t tailFrames = 0;
  std::uint32_t stateRevision = 0;
  std::uint32_t supportsBypass = 0;
  std::uint32_t supportsEditor = 0;
  std::uint32_t supportsState = 0;
};

struct BusFrame {
  std::uint32_t nameBytes = 0;
  std::uint32_t channels = 0;
  std::uint32_t enabled = 0;
};

bool ReadExactly(const int descriptor, void* bytes, const std::size_t count) {
  auto* cursor = static_cast<std::byte*>(bytes);
  std::size_t remaining = count;
  while (remaining > 0) {
    const auto readCount = read(descriptor, cursor, remaining);
    if (readCount == 0) return false;
    if (readCount < 0) {
      if (errno == EINTR) continue;
      return false;
    }
    cursor += readCount;
    remaining -= static_cast<std::size_t>(readCount);
  }
  return true;
}

ssize_t WriteWithoutSigpipe(const int descriptor, const void* bytes, const std::size_t count) {
  sigset_t blocked{};
  sigset_t previous{};
  sigset_t pending{};
  sigemptyset(&blocked);
  sigaddset(&blocked, SIGPIPE);
  if (pthread_sigmask(SIG_BLOCK, &blocked, &previous) != 0) {
    errno = EINVAL;
    return -1;
  }
  const bool was_pending = sigpending(&pending) == 0 && sigismember(&pending, SIGPIPE) == 1;
  const ssize_t result = write(descriptor, bytes, count);
  const int write_error = errno;
  if (result < 0 && write_error == EPIPE && !was_pending) {
    int received = 0;
    static_cast<void>(sigwait(&blocked, &received));
  }
  static_cast<void>(pthread_sigmask(SIG_SETMASK, &previous, nullptr));
  errno = write_error;
  return result;
}

bool WriteExactly(const int descriptor, const void* bytes, const std::size_t count) {
  const auto* cursor = static_cast<const std::byte*>(bytes);
  std::size_t remaining = count;
  while (remaining > 0) {
    const auto writeCount = WriteWithoutSigpipe(descriptor, cursor, remaining);
    if (writeCount < 0) {
      if (errno == EINTR) continue;
      return false;
    }
    cursor += writeCount;
    remaining -= static_cast<std::size_t>(writeCount);
  }
  return true;
}

bool Fits(const std::size_t total, const std::uint32_t value) {
  return value <= total;
}

bool ValidTextLength(const std::string& value, const std::uint32_t maximum) {
  return value.size() <= maximum;
}

void Append(std::vector<std::uint8_t>& destination, const std::string& source) {
  destination.insert(destination.end(), source.begin(), source.end());
}

template <typename Value>
void AppendValue(std::vector<std::uint8_t>& destination, const Value& value) {
  const auto offset = destination.size();
  destination.resize(offset + sizeof(Value));
  std::memcpy(destination.data() + offset, &value, sizeof(Value));
}

std::optional<std::string> ReadText(std::span<const std::uint8_t> payload, std::size_t& cursor, const std::uint32_t length) {
  if (!Fits(payload.size() - cursor, length)) return std::nullopt;
  const auto begin = payload.begin() + static_cast<std::ptrdiff_t>(cursor);
  cursor += length;
  return std::string(begin, begin + static_cast<std::ptrdiff_t>(length));
}

template <typename Value>
std::optional<Value> ReadValue(std::span<const std::uint8_t> payload, std::size_t& cursor) {
  if (payload.size() - cursor < sizeof(Value)) return std::nullopt;
  Value value{};
  std::memcpy(&value, payload.data() + cursor, sizeof(Value));
  cursor += sizeof(Value);
  return value;
}

}  // namespace

bool WriteWorkerStartupRequest(
  const int fileDescriptor,
  const std::uint64_t transportToken,
  const WorkerStartupRequest& request
) {
  if (fileDescriptor < 0 || !IsValidWorkerStartupRequest(request)
    || !ValidTextLength(request.classId, kMaximumClassIdBytes)
    || !ValidTextLength(request.eligibility.canonicalBundlePath, kMaximumPathBytes)
    || !ValidTextLength(request.eligibility.canonicalExecutablePath, kMaximumPathBytes)
    || !ValidTextLength(request.eligibility.bundleFingerprint, kMaximumFingerprintBytes)
    || !ValidTextLength(request.eligibility.binaryFingerprint, kMaximumFingerprintBytes)) {
    return false;
  }
  const auto stateBytes = request.state ? request.state->bytes.size() : 0;
  const auto stateHash = request.state ? request.state->sha256 : std::string{};
  std::vector<std::uint8_t> payload;
  payload.reserve(
    request.classId.size() + request.eligibility.canonicalBundlePath.size() + request.eligibility.canonicalExecutablePath.size()
    + request.eligibility.bundleFingerprint.size() + request.eligibility.binaryFingerprint.size() + stateBytes + stateHash.size()
  );
  Append(payload, request.classId);
  Append(payload, request.eligibility.canonicalBundlePath);
  Append(payload, request.eligibility.canonicalExecutablePath);
  Append(payload, request.eligibility.bundleFingerprint);
  Append(payload, request.eligibility.binaryFingerprint);
  if (request.state) {
    payload.insert(payload.end(), request.state->bytes.begin(), request.state->bytes.end());
    Append(payload, stateHash);
  }
  if (payload.size() > kMaximumStartupBytes) return false;
  const StartupHeader header{
    .bytes = static_cast<std::uint32_t>(payload.size()),
    .transportToken = transportToken,
    .noPluginTestMode = request.noPluginTestMode ? 1U : 0U,
    .arm64 = request.eligibility.arm64 ? 1U : 0U,
    .codeSignVerified = request.eligibility.codeSignVerified ? 1U : 0U,
    .quarantinePresent = request.eligibility.quarantinePresent ? 1U : 0U,
    .scannerProtocolVersion = request.eligibility.scannerProtocolVersion,
    .sampleRate = request.setup.sampleRate,
    .maximumBlockFrames = static_cast<std::uint32_t>(request.setup.maximumBlockFrames),
    .inputChannels = static_cast<std::uint32_t>(request.setup.inputChannels),
    .outputChannels = static_cast<std::uint32_t>(request.setup.outputChannels),
    .processMode = static_cast<std::uint32_t>(request.setup.mode),
    .classIdBytes = static_cast<std::uint32_t>(request.classId.size()),
    .bundlePathBytes = static_cast<std::uint32_t>(request.eligibility.canonicalBundlePath.size()),
    .executablePathBytes = static_cast<std::uint32_t>(request.eligibility.canonicalExecutablePath.size()),
    .bundleFingerprintBytes = static_cast<std::uint32_t>(request.eligibility.bundleFingerprint.size()),
    .binaryFingerprintBytes = static_cast<std::uint32_t>(request.eligibility.binaryFingerprint.size()),
    .stateBytes = static_cast<std::uint32_t>(stateBytes),
    .stateHashBytes = static_cast<std::uint32_t>(stateHash.size()),
  };
  return WriteExactly(fileDescriptor, &header, sizeof(header))
    && WriteExactly(fileDescriptor, payload.data(), payload.size());
}

std::optional<WorkerStartupRequest> ReadWorkerStartupRequest(
  const int fileDescriptor,
  const std::uint64_t transportToken
) {
  StartupHeader header{};
  if (fileDescriptor < 0 || !ReadExactly(fileDescriptor, &header, sizeof(header))
    || header.magic != kStartupMagic || header.version != kStartupVersion || header.transportToken != transportToken
    || header.bytes > kMaximumStartupBytes || header.noPluginTestMode > 1 || header.arm64 > 1
    || header.codeSignVerified > 1 || header.quarantinePresent > 1 || header.classIdBytes > kMaximumClassIdBytes
    || header.bundlePathBytes > kMaximumPathBytes || header.executablePathBytes > kMaximumPathBytes
    || header.bundleFingerprintBytes > kMaximumFingerprintBytes || header.binaryFingerprintBytes > kMaximumFingerprintBytes
    || header.stateBytes > kMaximumWorkerStateBytes || header.stateHashBytes > kMaximumFingerprintBytes
    || (header.processMode != static_cast<std::uint32_t>(WorkerProcessSetup::Mode::kRealtime)
      && header.processMode != static_cast<std::uint32_t>(WorkerProcessSetup::Mode::kOffline))) {
    return std::nullopt;
  }
  const std::array<std::uint32_t, 7> lengths{
    header.classIdBytes, header.bundlePathBytes, header.executablePathBytes, header.bundleFingerprintBytes,
    header.binaryFingerprintBytes, header.stateBytes, header.stateHashBytes,
  };
  std::size_t expectedBytes = 0;
  for (const auto length : lengths) {
    if (length > std::numeric_limits<std::size_t>::max() - expectedBytes) return std::nullopt;
    expectedBytes += length;
  }
  if (expectedBytes != header.bytes) return std::nullopt;
  std::vector<std::uint8_t> payload(header.bytes);
  if (!ReadExactly(fileDescriptor, payload.data(), payload.size())) return std::nullopt;
  std::size_t cursor = 0;
  const auto classId = ReadText(payload, cursor, header.classIdBytes);
  const auto bundlePath = ReadText(payload, cursor, header.bundlePathBytes);
  const auto executablePath = ReadText(payload, cursor, header.executablePathBytes);
  const auto bundleFingerprint = ReadText(payload, cursor, header.bundleFingerprintBytes);
  const auto binaryFingerprint = ReadText(payload, cursor, header.binaryFingerprintBytes);
  const auto stateBytes = ReadText(payload, cursor, header.stateBytes);
  const auto stateHash = ReadText(payload, cursor, header.stateHashBytes);
  if (!classId || !bundlePath || !executablePath || !bundleFingerprint || !binaryFingerprint || !stateBytes || !stateHash) return std::nullopt;
  WorkerStartupRequest request{
    .eligibility = {
      .canonicalBundlePath = *bundlePath,
      .canonicalExecutablePath = *executablePath,
      .bundleFingerprint = *bundleFingerprint,
      .binaryFingerprint = *binaryFingerprint,
      .arm64 = header.arm64 != 0,
      .codeSignVerified = header.codeSignVerified != 0,
      .quarantinePresent = header.quarantinePresent != 0,
      .scannerProtocolVersion = header.scannerProtocolVersion,
    },
    .classId = *classId,
    .setup = {
      .sampleRate = header.sampleRate,
      .maximumBlockFrames = header.maximumBlockFrames,
      .inputChannels = header.inputChannels,
      .outputChannels = header.outputChannels,
      .mode = static_cast<WorkerProcessSetup::Mode>(header.processMode),
    },
    .noPluginTestMode = header.noPluginTestMode != 0,
  };
  if (header.stateBytes != 0 || header.stateHashBytes != 0) {
    request.state = WorkerState{
      .bytes = std::vector<std::uint8_t>(stateBytes->begin(), stateBytes->end()),
      .sha256 = *stateHash,
    };
  }
  if (!IsValidWorkerStartupRequest(request)) return std::nullopt;
  return request;
}

bool WriteWorkerControlCommand(
  const int fileDescriptor,
  const WorkerControlCommand command,
  const std::uint32_t width,
  const std::uint32_t height,
  const std::optional<WorkerEditorAnchor> anchor
) {
  const CommandFrame frame{
    .command = static_cast<std::uint32_t>(command),
    .width = width,
    .height = height,
    .hasAnchor = anchor ? 1U : 0U,
    .anchorX = anchor ? anchor->x : 0,
    .anchorY = anchor ? anchor->y : 0,
  };
  return fileDescriptor >= 0 && WriteExactly(fileDescriptor, &frame, sizeof(frame));
}

std::optional<WorkerControlRequest> ReadWorkerControlCommand(const int fileDescriptor) {
  CommandFrame frame{};
  if (fileDescriptor < 0 || !ReadExactly(fileDescriptor, &frame, sizeof(frame))) return std::nullopt;
  if (frame.command >= static_cast<std::uint32_t>(WorkerControlCommand::kProcess)
    && frame.command <= static_cast<std::uint32_t>(WorkerControlCommand::kStateGet)
    && frame.hasAnchor <= 1) {
    return WorkerControlRequest{
      .command = static_cast<WorkerControlCommand>(frame.command),
      .width = frame.width,
      .height = frame.height,
      .anchor = frame.hasAnchor == 1
        ? std::optional<WorkerEditorAnchor>(WorkerEditorAnchor{.x = frame.anchorX, .y = frame.anchorY})
        : std::nullopt,
    };
  }
  return std::nullopt;
}

bool WriteWorkerProcessResponse(
  const int fileDescriptor,
  const std::uint64_t sequence,
  const bool success
) {
  if (fileDescriptor < 0 || sequence == 0) return false;
  const ProcessResponseFrame frame{
    .sequence = sequence,
    .success = success ? 1U : 0U,
  };
  return WriteExactly(fileDescriptor, &frame, sizeof(frame));
}

std::optional<std::pair<std::uint64_t, bool>> ReadWorkerProcessResponse(const int fileDescriptor) {
  ProcessResponseFrame frame{};
  if (fileDescriptor < 0 || !ReadExactly(fileDescriptor, &frame, sizeof(frame))
    || frame.sequence == 0 || frame.success > 1) return std::nullopt;
  return std::pair{frame.sequence, frame.success != 0};
}

bool WriteWorkerEditorResponse(const int fileDescriptor, const WorkerEditorResponse& response) {
  const EditorResponseFrame frame{
    .success = response.success ? 1U : 0U,
    .supported = response.status.supported ? 1U : 0U,
    .open = response.status.open ? 1U : 0U,
    .width = response.status.width,
    .height = response.status.height,
  };
  return fileDescriptor >= 0 && WriteExactly(fileDescriptor, &frame, sizeof(frame));
}

std::optional<WorkerEditorResponse> ReadWorkerEditorResponse(const int fileDescriptor) {
  EditorResponseFrame frame{};
  if (fileDescriptor < 0 || !ReadExactly(fileDescriptor, &frame, sizeof(frame))
    || frame.success > 1 || frame.supported > 1 || frame.open > 1) return std::nullopt;
  return WorkerEditorResponse{
    .success = frame.success != 0,
    .status = {.supported = frame.supported != 0, .open = frame.open != 0, .width = frame.width, .height = frame.height},
  };
}

bool WriteWorkerState(const int fileDescriptor, const WorkerState& state) {
  if (fileDescriptor < 0 || !IsValidWorkerState(state) || state.sha256.size() > kMaximumFingerprintBytes) return false;
  const StateFrame frame{
    .bytes = static_cast<std::uint32_t>(state.bytes.size()),
    .hashBytes = static_cast<std::uint32_t>(state.sha256.size()),
  };
  return WriteExactly(fileDescriptor, &frame, sizeof(frame))
    && WriteExactly(fileDescriptor, state.bytes.data(), state.bytes.size())
    && WriteExactly(fileDescriptor, state.sha256.data(), state.sha256.size());
}

std::optional<WorkerState> ReadWorkerState(const int fileDescriptor) {
  StateFrame frame{};
  if (fileDescriptor < 0 || !ReadExactly(fileDescriptor, &frame, sizeof(frame))
    || frame.bytes > kMaximumWorkerStateBytes || frame.hashBytes > kMaximumFingerprintBytes) {
    return std::nullopt;
  }
  WorkerState state{.bytes = std::vector<std::uint8_t>(frame.bytes), .sha256 = std::string(frame.hashBytes, '\0')};
  if (!ReadExactly(fileDescriptor, state.bytes.data(), state.bytes.size())
    || !ReadExactly(fileDescriptor, state.sha256.data(), state.sha256.size()) || !IsValidWorkerState(state)) {
    return std::nullopt;
  }
  return state;
}

bool WriteWorkerHello(const int fileDescriptor, const WorkerHello& hello) {
  if (fileDescriptor < 0 || !IsValidWorkerHello(hello)
    || !ValidTextLength(hello.instanceId, kMaximumInstanceIdBytes)
    || !ValidTextLength(hello.manifest.artifact.id, kMaximumArtifactTextBytes)
    || !ValidTextLength(hello.manifest.artifact.version, kMaximumArtifactTextBytes)) {
    return false;
  }
  std::vector<std::uint8_t> payload;
  Append(payload, hello.instanceId);
  Append(payload, hello.manifest.artifact.id);
  Append(payload, hello.manifest.artifact.version);
  const auto appendBuses = [&](const std::vector<WorkerBusDescriptor>& buses) {
    for (const auto& bus : buses) {
      const BusFrame frame{
        .nameBytes = static_cast<std::uint32_t>(bus.name.size()),
        .channels = bus.channels,
        .enabled = bus.enabled ? 1U : 0U,
      };
      AppendValue(payload, frame);
      Append(payload, bus.name);
    }
  };
  appendBuses(hello.manifest.inputBuses);
  appendBuses(hello.manifest.outputBuses);
  if (payload.size() > kMaximumHelloBytes) return false;
  const HelloHeader header{
    .bytes = static_cast<std::uint32_t>(payload.size()),
    .instanceIdBytes = static_cast<std::uint32_t>(hello.instanceId.size()),
    .artifactIdBytes = static_cast<std::uint32_t>(hello.manifest.artifact.id.size()),
    .artifactVersionBytes = static_cast<std::uint32_t>(hello.manifest.artifact.version.size()),
    .manifestVersion = hello.manifest.version,
    .startupProtocolVersion = hello.manifest.startupProtocolVersion,
    .controlProtocolVersion = hello.manifest.controlProtocolVersion,
    .transportAbiVersion = hello.manifest.transportAbiVersion,
    .arm64 = hello.manifest.arm64 ? 1U : 0U,
    .role = static_cast<std::uint32_t>(hello.manifest.role),
    .inputBusCount = static_cast<std::uint32_t>(hello.manifest.inputBuses.size()),
    .outputBusCount = static_cast<std::uint32_t>(hello.manifest.outputBuses.size()),
    .slotCount = static_cast<std::uint32_t>(hello.manifest.transport.slotCount),
    .maximumFrames = static_cast<std::uint32_t>(hello.manifest.transport.maximumFrames),
    .inputChannels = static_cast<std::uint32_t>(hello.manifest.transport.inputChannels),
    .outputChannels = static_cast<std::uint32_t>(hello.manifest.transport.outputChannels),
    .maximumEventsPerBlock = static_cast<std::uint32_t>(hello.manifest.transport.maximumEventsPerBlock),
    .latencyFrames = hello.manifest.latencyFrames,
    .hasTailFrames = hello.manifest.tailFrames ? 1U : 0U,
    .tailFrames = hello.manifest.tailFrames.value_or(0),
    .stateRevision = hello.manifest.stateRevision,
    .supportsBypass = hello.manifest.supportsBypass ? 1U : 0U,
    .supportsEditor = hello.manifest.supportsEditor ? 1U : 0U,
    .supportsState = hello.manifest.supportsState ? 1U : 0U,
  };
  return WriteExactly(fileDescriptor, &header, sizeof(header))
    && WriteExactly(fileDescriptor, payload.data(), payload.size());
}

std::optional<WorkerHello> ReadWorkerHello(const int fileDescriptor) {
  HelloHeader header{};
  if (fileDescriptor < 0 || !ReadExactly(fileDescriptor, &header, sizeof(header))
    || header.magic != kHelloMagic || header.version != kHelloVersion || header.bytes > kMaximumHelloBytes
    || header.instanceIdBytes == 0 || header.instanceIdBytes > kMaximumInstanceIdBytes
    || header.artifactIdBytes == 0 || header.artifactIdBytes > kMaximumArtifactTextBytes
    || header.artifactVersionBytes == 0 || header.artifactVersionBytes > kMaximumArtifactTextBytes
    || header.arm64 > 1 || header.hasTailFrames > 1 || header.supportsBypass > 1
    || header.supportsEditor > 1 || header.supportsState > 1 || header.inputBusCount > 32
    || header.outputBusCount == 0 || header.outputBusCount > 32) {
    return std::nullopt;
  }
  std::vector<std::uint8_t> payload(header.bytes);
  if (!ReadExactly(fileDescriptor, payload.data(), payload.size())) return std::nullopt;
  std::size_t cursor = 0;
  const auto instanceId = ReadText(payload, cursor, header.instanceIdBytes);
  const auto artifactId = ReadText(payload, cursor, header.artifactIdBytes);
  const auto artifactVersion = ReadText(payload, cursor, header.artifactVersionBytes);
  if (!instanceId || !artifactId || !artifactVersion) return std::nullopt;
  const auto readBuses = [&](const std::uint32_t count) -> std::optional<std::vector<WorkerBusDescriptor>> {
    std::vector<WorkerBusDescriptor> buses;
    buses.reserve(count);
    for (std::uint32_t index = 0; index < count; ++index) {
      const auto frame = ReadValue<BusFrame>(payload, cursor);
      if (!frame || frame->nameBytes == 0 || frame->nameBytes > kMaximumBusNameBytes || frame->enabled > 1) return std::nullopt;
      const auto name = ReadText(payload, cursor, frame->nameBytes);
      if (!name) return std::nullopt;
      buses.push_back({.name = *name, .channels = frame->channels, .enabled = frame->enabled != 0});
    }
    return buses;
  };
  const auto inputBuses = readBuses(header.inputBusCount);
  const auto outputBuses = readBuses(header.outputBusCount);
  if (!inputBuses || !outputBuses || cursor != payload.size()) return std::nullopt;
  WorkerHello hello{
    .instanceId = *instanceId,
    .manifest = {
      .version = header.manifestVersion,
      .artifact = {.id = *artifactId, .version = *artifactVersion},
      .startupProtocolVersion = header.startupProtocolVersion,
      .controlProtocolVersion = header.controlProtocolVersion,
      .transportAbiVersion = header.transportAbiVersion,
      .arm64 = header.arm64 != 0,
      .role = static_cast<WorkerPluginRole>(header.role),
      .inputBuses = *inputBuses,
      .outputBuses = *outputBuses,
      .transport = {
        .slotCount = header.slotCount,
        .maximumFrames = header.maximumFrames,
        .inputChannels = header.inputChannels,
        .outputChannels = header.outputChannels,
        .maximumEventsPerBlock = header.maximumEventsPerBlock,
      },
      .latencyFrames = header.latencyFrames,
      .tailFrames = header.hasTailFrames != 0 ? std::optional<std::uint32_t>(header.tailFrames) : std::nullopt,
      .stateRevision = header.stateRevision,
      .supportsBypass = header.supportsBypass != 0,
      .supportsEditor = header.supportsEditor != 0,
      .supportsState = header.supportsState != 0,
    },
  };
  if (!IsValidWorkerHello(hello)) return std::nullopt;
  return hello;
}

}  // namespace daw::plugin_host
