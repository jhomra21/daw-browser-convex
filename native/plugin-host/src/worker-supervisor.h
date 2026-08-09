#pragma once

#include <cstddef>
#include <cstdint>
#include <chrono>
#include <memory>
#include <optional>
#include <limits>
#include <span>
#include <string>
#include <string_view>
#include <type_traits>
#include <vector>

namespace daw::plugin_host {

enum class WorkerControlCommand : std::uint32_t;

constexpr std::size_t kMaximumWorkerTransportBytes = 128U * 1024U * 1024U;
constexpr std::size_t kMaximumWorkerSlots = 8;
constexpr std::size_t kMaximumWorkerChannels = 64;
constexpr std::size_t kMaximumWorkerFrames = 8'192;
constexpr std::size_t kMaximumWorkerEvents = 2'048;
constexpr std::size_t kMaximumWorkerRestarts = 3;
constexpr std::size_t kMaximumWorkerStateBytes = 512U * 1024U;
constexpr std::uint32_t kMaximumWorkerTailFrames = 100'000'000U;
constexpr std::uint32_t kInfiniteTailFrames = std::numeric_limits<std::uint32_t>::max();
constexpr std::uint32_t kWorkerTransportAbiVersion = 5;
constexpr std::uint32_t kWorkerManifestVersion = 1;
constexpr std::uint32_t kWorkerStartupProtocolVersion = 1;
constexpr std::uint32_t kWorkerControlProtocolVersion = 2;
constexpr std::string_view kWorkerArtifactId = "daw-vst3-worker";
constexpr std::string_view kWorkerArtifactVersion = "3";

[[nodiscard]] constexpr bool IsInfiniteTailFrames(const std::uint64_t tailFrames) noexcept {
  return tailFrames == kInfiniteTailFrames;
}

[[nodiscard]] constexpr bool IsValidWorkerTailFrames(const std::uint64_t tailFrames) noexcept {
  return IsInfiniteTailFrames(tailFrames) || tailFrames <= kMaximumWorkerTailFrames;
}

[[nodiscard]] constexpr bool IsValidFiniteWorkerTailFrames(const std::uint64_t tailFrames) noexcept {
  return tailFrames <= kMaximumWorkerTailFrames;
}

[[nodiscard]] constexpr std::optional<std::uint32_t> NormalizeWorkerTailFrames(
  const std::uint64_t tailFrames
) noexcept {
  return IsValidWorkerTailFrames(tailFrames)
    ? std::optional<std::uint32_t>(static_cast<std::uint32_t>(tailFrames))
    : std::nullopt;
}

[[nodiscard]] constexpr std::optional<std::uint64_t> ChannelMask(const std::size_t channelCount) noexcept {
  if (channelCount > kMaximumWorkerChannels) return std::nullopt;
  if (channelCount == kMaximumWorkerChannels) return std::numeric_limits<std::uint64_t>::max();
  return (std::uint64_t{1} << channelCount) - 1U;
}

struct WorkerArtifactIdentity {
  std::string id;
  std::string version;
};

struct WorkerHostConfiguration {
  std::string executable;
  WorkerArtifactIdentity artifact;
};

struct WorkerBusDescriptor {
  std::string name;
  std::uint32_t channels = 0;
  bool enabled = false;
};

enum class WorkerEditorCommand : std::uint32_t {
  kOpen = 1,
  kClose = 2,
  kFocus = 3,
  kResize = 4,
  kStatus = 5,
};

struct WorkerEditorStatus {
  bool supported = false;
  bool open = false;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
};

struct WorkerEditorAnchor {
  std::int32_t x = 0;
  std::int32_t y = 0;
};

struct WorkerEditorResponse {
  bool success = false;
  WorkerEditorStatus status;
};

struct WorkerLaunchEligibility {
  std::string canonicalBundlePath;
  std::string canonicalExecutablePath;
  std::string bundleFingerprint;
  std::string binaryFingerprint;
  bool arm64 = false;
  bool codeSignVerified = false;
  bool quarantinePresent = true;
  std::uint32_t scannerProtocolVersion = 0;
};

bool IsWorkerLaunchEligible(const WorkerLaunchEligibility& eligibility);

struct WorkerProcessSetup {
  enum class Mode : std::uint32_t {
    kRealtime = 1,
    kOffline = 2,
  };

  double sampleRate = 0.0;
  std::size_t maximumBlockFrames = 0;
  std::size_t inputChannels = 0;
  std::size_t outputChannels = 0;
  Mode mode = Mode::kRealtime;
};

struct WorkerState {
  std::vector<std::uint8_t> bytes;
  std::string sha256;
};

struct WorkerStartupRequest {
  // This is constructed by the native control layer from a scanner-validated
  // record. `noPluginTestMode` is exclusively for the native CTest harness.
  WorkerLaunchEligibility eligibility;
  std::string classId;
  WorkerProcessSetup setup;
  std::optional<WorkerState> state;
  bool noPluginTestMode = false;
};

bool IsValidWorkerState(const WorkerState& state);
bool IsValidWorkerStartupRequest(const WorkerStartupRequest& request);

struct WorkerTransportRequest {
  std::size_t slotCount = 0;
  std::size_t maximumFrames = 0;
  std::size_t inputChannels = 0;
  std::size_t outputChannels = 0;
  std::size_t maximumEventsPerBlock = 0;
};

enum class WorkerPluginRole : std::uint32_t {
  kEffect = 1,
  kInstrument = 2,
};

struct WorkerParameterDescriptor {
  std::uint32_t id = 0;
  std::string title;
  std::string unit;
  double minimum = 0.0;
  double maximum = 1.0;
  double defaultValue = 0.0;
  std::uint32_t stepCount = 0;
  bool readOnly = false;
  bool hidden = false;
};

struct WorkerManifest {
  std::uint32_t version = 0;
  WorkerArtifactIdentity artifact;
  std::uint32_t startupProtocolVersion = 0;
  std::uint32_t controlProtocolVersion = 0;
  std::uint32_t transportAbiVersion = 0;
  bool arm64 = false;
  WorkerPluginRole role = WorkerPluginRole::kEffect;
  std::vector<WorkerBusDescriptor> inputBuses;
  std::vector<WorkerBusDescriptor> outputBuses;
  WorkerTransportRequest transport;
  std::uint32_t latencyFrames = 0;
  std::optional<std::uint32_t> tailFrames;
  std::uint32_t stateRevision = 0;
  std::vector<WorkerParameterDescriptor> parameters;
  bool supportsBypass = false;
  bool supportsEditor = false;
  bool supportsState = false;
};

struct WorkerHello {
  std::string instanceId;
  WorkerManifest manifest;
};

struct WorkerPreflightRequirements {
  WorkerArtifactIdentity artifact;
  std::uint32_t startupProtocolVersion = 0;
  std::uint32_t controlProtocolVersion = 0;
  std::uint32_t transportAbiVersion = 0;
  bool arm64 = false;
};

struct WorkerPreflightRequest {
  std::uint32_t version = 0;
  std::string requestId;
  WorkerPreflightRequirements requirements;
};

enum class WorkerPreflightStatus : std::uint32_t {
  kAvailable = 1,
  kUnavailable = 2,
};

struct WorkerPreflightResult {
  std::uint32_t version = 0;
  std::string requestId;
  WorkerPreflightStatus status = WorkerPreflightStatus::kUnavailable;
  std::string code;
  std::string message;
  WorkerPreflightRequirements requirements;
  std::optional<WorkerHello> hello;
};

bool IsValidWorkerArtifactIdentity(const WorkerArtifactIdentity& identity);
bool IsValidWorkerHostConfiguration(const WorkerHostConfiguration& configuration);
bool IsValidWorkerManifest(const WorkerManifest& manifest);
bool IsValidWorkerHello(const WorkerHello& hello);
bool IsValidWorkerPreflightRequest(const WorkerPreflightRequest& request);
bool IsValidWorkerPreflightResult(const WorkerPreflightResult& result);

struct WorkerTransportLayout {
  std::size_t bytes = 0;
  std::size_t slotBytes = 0;
  std::size_t audioBytesPerSlot = 0;
  std::size_t eventBytesPerSlot = 0;
  std::size_t maximumFrames = 0;
  std::size_t inputChannels = 0;
  std::size_t outputChannels = 0;
  std::size_t maximumEventsPerBlock = 0;
};

std::optional<WorkerTransportLayout> CreateWorkerTransportLayout(const WorkerTransportRequest& request);

struct WorkerSharedMemoryDescriptor {
  std::string name;
  std::size_t byteLength = 0;
};

std::optional<WorkerSharedMemoryDescriptor> CreatePortableSharedMemoryDescriptor(
  const std::string& name,
  const WorkerTransportLayout& layout
);

enum class WorkerSlotStatus : std::uint32_t {
  kFree,
  kSubmitted,
  kProcessing,
  kComplete,
  kDropped,
};

struct WorkerSlot {
  std::uint64_t sequence = 0;
  WorkerSlotStatus status = WorkerSlotStatus::kFree;
};

enum class WorkerHealth : std::uint32_t {
  kStarting,
  kReady,
  kStopping,
  kStopped,
  kFaulted,
};

enum class WorkerDiagnosticKind : std::uint32_t {
  kReady,
  kLatency,
  kBuses,
  kRestart,
  kFault,
  kStopped,
  kMiss,
  kEditorInteraction,
  kParameterEdit,
  kTail,
  kEditorState,
};

struct WorkerDiagnostic {
  WorkerDiagnosticKind kind = WorkerDiagnosticKind::kFault;
  std::uint32_t value = 0;
  std::uint64_t sequence = 0;
  std::uint32_t parameter_id = 0;
  double normalized_value = 0.0;
};
static_assert(std::is_trivially_copyable_v<WorkerDiagnostic>);

struct WorkerTailMetadata {
  std::uint64_t workerGeneration = 0;
  std::uint32_t tailFrames = 0;
};
static_assert(std::is_trivially_copyable_v<WorkerTailMetadata>);

enum class WorkerEventKind : std::uint8_t {
  kParameter,
  kMidi,
};

struct WorkerTransportEvent {
  WorkerEventKind kind = WorkerEventKind::kParameter;
  std::uint32_t sampleOffset = 0;
  std::uint32_t parameterId = 0;
  double parameterValue = 0.0;
  std::uint8_t midiData[3]{};
};

struct WorkerBlockContext {
  std::int64_t projectTimeSamples = 0;
  std::int64_t continuousTimeSamples = 0;
  double tempoBpm = 0.0;
  double projectTimeMusic = 0.0;
  std::uint32_t timeSignatureNumerator = 0;
  std::uint32_t timeSignatureDenominator = 0;
  double cycleStartMusic = 0.0;
  double cycleEndMusic = 0.0;
  std::uint32_t transportEpoch = 1;
  bool playing = false;
  bool recording = false;
  bool cycleActive = false;
  bool discontinuity = false;
};

class WorkerTransport {
 public:
  ~WorkerTransport();
  WorkerTransport(WorkerTransport&&) noexcept;
  WorkerTransport& operator=(WorkerTransport&&) noexcept;
  WorkerTransport(const WorkerTransport&) = delete;
  WorkerTransport& operator=(const WorkerTransport&) = delete;

  [[nodiscard]] static std::optional<WorkerTransport> Create(const WorkerTransportLayout& layout);
  [[nodiscard]] static std::optional<WorkerTransport> MapInherited(int fileDescriptor, std::uint64_t token);
  [[nodiscard]] bool Submit(std::size_t slotIndex, std::uint64_t sequence);
  [[nodiscard]] bool Submit(
    std::size_t slotIndex,
    std::uint64_t sequence,
    std::size_t numSamples,
    std::span<const WorkerTransportEvent> events,
    const WorkerBlockContext& context = {}
  );
  [[nodiscard]] bool Complete(std::size_t slotIndex, std::uint64_t sequence);
  [[nodiscard]] bool DropLate(std::size_t slotIndex, std::uint64_t expectedSequence);
  [[nodiscard]] std::optional<std::uint64_t> BeginProcessing(std::size_t slotIndex);
  [[nodiscard]] bool ReleaseDropped(std::size_t slotIndex);
  [[nodiscard]] bool ReleaseCompleted(std::size_t slotIndex, std::uint64_t sequence);
  [[nodiscard]] bool CancelSubmit(std::size_t slotIndex, std::uint64_t sequence);
  [[nodiscard]] WorkerSlot slot(std::size_t slotIndex) const;
  [[nodiscard]] bool Read(std::size_t slotIndex, std::uint64_t expectedSequence) const;
  [[nodiscard]] WorkerHealth health() const;
  [[nodiscard]] std::optional<WorkerDiagnostic> ReadDiagnostic();
  [[nodiscard]] std::optional<WorkerTailMetadata> ReadTailMetadata() const;
  [[nodiscard]] int fileDescriptor() const;
  [[nodiscard]] std::uint64_t token() const;
  [[nodiscard]] bool valid() const;
  [[nodiscard]] const WorkerTransportLayout& layout() const;
  [[nodiscard]] std::size_t maximumFrames() const;
  [[nodiscard]] std::size_t inputChannels() const;
  [[nodiscard]] std::size_t outputChannels() const;
  [[nodiscard]] std::size_t numSamples(std::size_t slotIndex) const;
  [[nodiscard]] std::span<const WorkerTransportEvent> events(std::size_t slotIndex) const;
  [[nodiscard]] WorkerBlockContext context(std::size_t slotIndex) const;
  [[nodiscard]] std::uint64_t outputSilenceFlags(std::size_t slotIndex) const;
  void SetOutputSilenceFlags(std::size_t slotIndex, std::uint64_t flags);
  [[nodiscard]] std::span<float> input(std::size_t slotIndex);
  [[nodiscard]] std::span<const float> output(std::size_t slotIndex) const;
  [[nodiscard]] std::span<float> output(std::size_t slotIndex);
  void PublishHealth(WorkerHealth health);
  [[nodiscard]] bool PublishDiagnostic(WorkerDiagnostic diagnostic);
  void PublishTailMetadata(std::uint32_t tailFrames);

 private:
  struct Mapping;
  explicit WorkerTransport(std::unique_ptr<Mapping> mapping);
  [[nodiscard]] bool OwnsSlot(std::size_t slotIndex) const;
  [[nodiscard]] std::byte* SlotBytes(std::size_t slotIndex) const;
  WorkerTransportLayout layout_;
  std::unique_ptr<Mapping> mapping_;
};

class WorkerRuntime {
 public:
  WorkerRuntime();
  ~WorkerRuntime();
  WorkerRuntime(const WorkerRuntime&) = delete;
  WorkerRuntime& operator=(const WorkerRuntime&) = delete;

  [[nodiscard]] bool Start(
    const WorkerStartupRequest& startup,
    const WorkerHostConfiguration& configuration,
    const WorkerTransportRequest& request
  );
  void Stop();
  [[nodiscard]] bool SetState(const WorkerState& state);
  [[nodiscard]] std::optional<WorkerState> GetState();
  [[nodiscard]] bool Restart();
  // Control-service-only lifecycle and command operations. The callback-facing
  // methods below never write the control pipe, allocate, or acquire a lock.
  [[nodiscard]] bool PublishSubmission(
    std::size_t slotIndex,
    std::uint64_t sequence,
    std::size_t numSamples,
    std::span<const WorkerTransportEvent> events,
    const WorkerBlockContext& context = {}
  );
  [[nodiscard]] bool CancelPublishedSubmission(std::size_t slotIndex, std::uint64_t sequence);
  [[nodiscard]] bool DispatchPublishedSubmission(std::size_t slotIndex, std::uint64_t sequence);
  [[nodiscard]] bool WaitForOfflineCompletion(
    std::size_t slotIndex,
    std::uint64_t sequence,
    std::chrono::milliseconds timeout
  );
  [[nodiscard]] std::optional<WorkerEditorResponse> ExecuteEditorCommand(
    WorkerControlCommand command,
    std::uint32_t width = 0,
    std::uint32_t height = 0,
    std::optional<WorkerEditorAnchor> anchor = std::nullopt
  );
  [[nodiscard]] bool ReadCompleted(std::size_t slotIndex, std::uint64_t expectedSequence) const;
  [[nodiscard]] bool CopyCompletedOutput(
    std::size_t slotIndex,
    std::uint64_t expectedSequence,
    std::span<float> output,
    std::uint64_t* outputSilenceFlags = nullptr
  );
  [[nodiscard]] bool CopyInput(std::size_t slotIndex, std::span<const float> input);
  [[nodiscard]] bool DiscardLate(std::size_t slotIndex, std::uint64_t sequence);
  [[nodiscard]] WorkerHealth callbackHealth() const;
  [[nodiscard]] WorkerHealth health() const;
  [[nodiscard]] std::optional<WorkerDiagnostic> ReadDiagnostic();
  [[nodiscard]] std::optional<WorkerTailMetadata> ReadTailMetadata() const;
  [[nodiscard]] const WorkerTransport* transport() const;

 private:
  std::optional<WorkerTransport> transport_;
  int controlWriteDescriptor_ = -1;
  int responseReadDescriptor_ = -1;
  int childProcessId_ = -1;
  std::size_t restartCount_ = 0;
  std::optional<WorkerStartupRequest> startup_;
  WorkerHostConfiguration configuration_;
  WorkerTransportRequest transportRequest_;
};

}  // namespace daw::plugin_host
