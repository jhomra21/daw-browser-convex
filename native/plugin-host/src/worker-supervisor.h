#pragma once

#include <cstddef>
#include <cstdint>
#include <array>
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
constexpr std::uint32_t kWorkerTransportAbiVersion = 7;
constexpr std::size_t kWorkerProcessingHistogramBuckets = 32;
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

constexpr bool WorkerProcessModeUsesEditorRuntime(const WorkerProcessSetup::Mode mode) noexcept {
  return mode == WorkerProcessSetup::Mode::kRealtime;
}

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
  kParameterEditBegin,
  kScheduledAutomationInput,
};

// VST3 `IComponentHandler::restartComponent` flags; vst3-worker.cpp asserts they match the SDK.
namespace RestartFlag {
constexpr std::uint32_t kReloadComponent = 1U << 0U;
constexpr std::uint32_t kIoChanged = 1U << 1U;
constexpr std::uint32_t kParamValuesChanged = 1U << 2U;
constexpr std::uint32_t kLatencyChanged = 1U << 3U;
constexpr std::uint32_t kParamTitlesChanged = 1U << 4U;
constexpr std::uint32_t kMidiCCAssignmentChanged = 1U << 5U;
constexpr std::uint32_t kNoteExpressionChanged = 1U << 6U;
}  // namespace RestartFlag

// What a plug-in's restart request asks of the worker. Only a component restart
// needs the worker to re-set the component up; the others refresh what the host
// already knows and never reach the host as a restart.
struct RestartEffects {
  bool refreshMetadata = false;
  bool latencyChanged = false;
  bool componentRestart = false;
};

constexpr RestartEffects DecodeRestartFlags(const std::uint32_t flags) noexcept {
  return {
    .refreshMetadata = (flags & (RestartFlag::kParamValuesChanged | RestartFlag::kParamTitlesChanged)) != 0,
    .latencyChanged = (flags & RestartFlag::kLatencyChanged) != 0,
    .componentRestart = (flags & (RestartFlag::kReloadComponent | RestartFlag::kIoChanged)) != 0,
  };
}

// Fault-only value semantics; other diagnostic values retain their contracts.
// Bits 0..7: origin, 8..15: waitid si_code, 16..23: si_status, 24..31: reserved.
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
};

constexpr std::uint32_t EncodeWorkerFault(
  const WorkerFaultOrigin origin,
  const std::uint32_t childCode = 0,
  const std::uint32_t childStatus = 0
) noexcept {
  return (static_cast<std::uint32_t>(origin) & 0xffU)
    | ((childCode & 0xffU) << 8U) | ((childStatus & 0xffU) << 16U);
}

struct WorkerDiagnostic {
  WorkerDiagnosticKind kind = WorkerDiagnosticKind::kFault;
  std::uint32_t value = 0;
  std::uint64_t sequence = 0;
  std::uint32_t parameter_id = 0;
  std::uint32_t transport_epoch = 0;
  double normalized_value = 0.0;
};

struct WorkerProcessingMetrics {
  std::uint64_t count = 0;
  std::uint64_t maximum_nanoseconds = 0;
  std::uint64_t deadline_misses = 0;
  std::array<std::uint64_t, kWorkerProcessingHistogramBuckets> buckets{};
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
  bool scheduledAutomation = false;
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
  [[nodiscard]] WorkerProcessingMetrics ReadProcessingMetrics() const;
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
  void RecordProcessingDuration(std::uint64_t durationNanoseconds, std::uint64_t deadlineNanoseconds);

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
  // Control-plane-only watchdog termination. Keeps the shared transport alive
  // until the host has quiesced callback ports and calls Stop().
  [[nodiscard]] bool TerminateForFault();
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
  // Nonblocking callback wake hint. The submitted slot remains the source of
  // truth; a full pipe is therefore a successful no-op rather than a fault.
  [[nodiscard]] bool NotifyRealtimeWorker() noexcept;
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
  [[nodiscard]] std::uint32_t faultValue() const;
  [[nodiscard]] int processGroupId() const noexcept;
  [[nodiscard]] std::optional<WorkerDiagnostic> ReadDiagnostic();
  [[nodiscard]] std::optional<WorkerTailMetadata> ReadTailMetadata() const;
  [[nodiscard]] const WorkerTransport* transport() const;

 private:
  std::optional<WorkerTransport> transport_;
  int controlWriteDescriptor_ = -1;
  int responseReadDescriptor_ = -1;
  int wakeWriteDescriptor_ = -1;
  int childProcessId_ = -1;
  int childProcessGroupId_ = -1;
  std::size_t restartCount_ = 0;
  std::optional<WorkerStartupRequest> startup_;
  WorkerHostConfiguration configuration_;
  WorkerTransportRequest transportRequest_;
};

class WorkerWakeSignal {
 public:
  WorkerWakeSignal() = default;
  ~WorkerWakeSignal();
  WorkerWakeSignal(const WorkerWakeSignal&) = delete;
  WorkerWakeSignal& operator=(const WorkerWakeSignal&) = delete;

  [[nodiscard]] bool Open() noexcept;
  void Close() noexcept;
  [[nodiscard]] bool Notify() const noexcept;
  [[nodiscard]] int readDescriptor() const noexcept;
  [[nodiscard]] int releaseReadDescriptor() noexcept;
  [[nodiscard]] int releaseWriteDescriptor() noexcept;
  static void Drain(int descriptor) noexcept;

 private:
  int readDescriptor_ = -1;
  int writeDescriptor_ = -1;
};

}  // namespace daw::plugin_host
