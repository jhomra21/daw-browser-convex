#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <array>
#include <deque>
#include <atomic>
#include <vector>
#include <utility>

#include "daw/audio_core.h"

namespace daw::audio_host_macos {

constexpr std::uint32_t kControlProtocolVersion = 16;
constexpr std::size_t kMaximumControlPayloadBytes = 1'048'576;
constexpr std::size_t kControlFrameHeaderBytes = 16;
constexpr std::size_t kNativeGraphFrameHeaderBytes = 12;
constexpr std::uint32_t kMaximumAssetChannels = 64;
constexpr std::uint32_t kMaximumAssetFrames = 262'144;
constexpr std::size_t kMaximumInstalledAssets = 64;
constexpr std::size_t kMaximumMeterEntries = 64;
constexpr std::size_t kMaximumSpectrumBins = 1024;
constexpr std::size_t kMaximumScheduleChunks = 16;
constexpr std::size_t kMaximumScheduleRecords = 2'048;
constexpr std::size_t kMaximumScheduleAutomationSegments = 2'048;
constexpr std::size_t kMaximumScheduleInstanceIdBytes = 256;

namespace detail {

template <typename PublishTerminal, typename Stop>
bool PublishOfflineTerminalBeforeStop(PublishTerminal&& publish_terminal, Stop&& stop) {
  const auto published = publish_terminal();
  stop();
  return published;
}

constexpr bool NativeVstWatchdogShouldMiss(
  const bool realtime_started,
  const std::uint32_t sample_rate_hz,
  const std::uint32_t frame_count,
  std::uint64_t& missed_frames,
  std::uint32_t& missed_callbacks
) noexcept {
  if (realtime_started) {
    constexpr std::uint32_t kNativeVstMissLimit = 3;
    ++missed_callbacks;
    return missed_callbacks >= kNativeVstMissLimit;
  }
  const auto half_sample_rate = sample_rate_hz / 2;
  const auto startup_grace_frames = half_sample_rate == 0 ? 1U : half_sample_rate;
  missed_frames += frame_count;
  return missed_frames >= startup_grace_frames;
}

}  // namespace detail

enum class ControlType : std::uint32_t {
  kHostHello = 1,
  kHostCapabilities = 2,
  kDeviceConfigure = 3,
  kGraphSnapshot = 4,
  kAssetInstall = 5,
  kAssetRelease = 6,
  kTransport = 7,
  kParameterEvents = 8,
  kMidiEvents = 9,
  kVstAttach = 10,
  kVstDetach = 11,
  kDiagnostics = 12,
  kAck = 13,
  kNotification = 14,
  kStart = 15,
  kStop = 16,
  kTeardown = 17,
  kSourceEvents = 18,
  kDeviceList = 19,
  kTransactionBegin = 20,
  kTransactionCommit = 21,
  kTransactionRollback = 22,
  kVstParameterEvents = 23,
  kVstMidiEvents = 24,
  kVstStateSet = 25,
  kVstStateGet = 26,
  kVstState = 27,
  kRecordingConfigure = 28,
  kRecordingStart = 29,
  kRecordingStop = 30,
  kRecordingCancel = 31,
  kRecordingBlock = 32,
  kRecordingStatus = 33,
  kRecordingDeviceQuery = 34,
  kRecordingDeviceList = 35,
  kGraphPrepare = 36,
  kGraphPublish = 37,
  kGraphRetire = 38,
  kGraphRollback = 39,
  kGraphRevisionStatus = 40,
  kVstEditor = 41,
  kVstEditorStatus = 42,
  kDiagnosticStart = 43,
  kMeterBatch = 44,
  kScheduleWindow = 45,
  kScheduleProgress = 46,
  kVstScheduleAutomationEnable = 47,
  kInstrumentStates = 48,
  kSpectrumSelection = 49,
  kSpectrumFrame = 50,
  kProcessorStatePatch = 51,
  kOfflineConfigure = 52,
  kOfflineStart = 53,
  kOfflinePcmChunk = 54,
  kOfflineComplete = 55,
  kOfflineError = 56,
};

struct ControlFrame {
  ControlType type;
  std::vector<std::uint8_t> payload;
};

std::optional<ControlFrame> DecodeControlFrame(std::span<const std::uint8_t> bytes);
std::vector<std::uint8_t> EncodeControlFrame(ControlType type, std::span<const std::uint8_t> payload);

std::string CoreAudioDeviceId(std::string_view uid);
std::optional<std::string> CoreAudioDeviceUid(std::string_view device_id);

enum class LifecycleState {
  kIdle,
  kConfigured,
  kRunning,
  kFaulted,
};

enum class CoreAudioDeviceRole {
  kOutput,
  kRecordingInput,
};

enum class DeviceReadinessReason : std::uint32_t {
  kReady = 0,
  kDeviceNotConfigured = 1,
  kGraphNotPrepared = 2,
  kTransportNotPrepared = 3,
};

enum class RejectedBlockReason : std::uint32_t {
  kNone = 0,
  kNotRunningOrCoreUnavailable = 1,
  kInsufficientChannels = 2,
  kNullChannel = 3,
  kTransport = 4,
  kScratchCapacity = 5,
  kProcessorEventCapacity = 6,
  kInstrumentEventCapacity = 7,
  kSourceSchedule = 8,
  kCoreProcess = 9,
};

struct HostConfig {
  std::string device_uid;
  std::uint32_t sample_rate_hz;
  std::uint32_t max_frames_per_block;
  std::uint32_t channel_count;
  std::uint32_t revision;
};

enum class NativeVstRole : std::uint8_t {
  kEffect = 1,
  kInstrument = 2,
};

struct NativeVstWorkerTransportConfig {
  std::uint32_t slot_count = 0;
  std::uint32_t maximum_frames = 0;
  std::uint32_t input_channels = 0;
  std::uint32_t output_channels = 0;
  std::uint32_t maximum_events_per_block = 0;
};

enum class NativeVstEditorCommand : std::uint32_t {
  kOpen = 1,
  kClose = 2,
  kFocus = 3,
  kResize = 4,
  kStatus = 5,
};

struct NativeVstEditorStatus {
  bool success = false;
  bool owned = false;
  bool supported = false;
  bool open = false;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
};

struct NativeVstEditorAnchor {
  std::int32_t x = 0;
  std::int32_t y = 0;
};

/* Native-control-only attachment data. It intentionally contains resolved
 * paths and never crosses project, Wasm, preload, or renderer boundaries. */
struct NativeVstAttachment {
  std::uint64_t graph_node_id = 0;
  std::uint32_t stage_index = 0;
  std::uint32_t source_index = 0;
  std::string instance_id;
  std::string class_id;
  std::string vendor_id;
  std::string canonical_bundle_path;
  std::string canonical_executable_path;
  std::uint8_t architecture = 0;
  std::array<std::uint8_t, 32> bundle_fingerprint{};
  std::array<std::uint8_t, 32> binary_fingerprint{};
  std::uint32_t scanner_catalog_version = 0;
  NativeVstRole role = NativeVstRole::kEffect;
  std::uint32_t input_layout = 0;
  std::uint32_t output_layout = 0;
  std::uint32_t declared_latency_frames = 0;
  std::optional<std::uint32_t> declared_tail_frames;
  bool infinite_tail = false;
  std::uint32_t transport_latency_frames = 0;
  bool playback_enabled = false;
  bool render_enabled = true;
  std::vector<std::uint8_t> initial_state;
  std::string initial_state_sha256;
  std::vector<std::uint32_t> parameter_ids;
  std::vector<std::pair<std::uint32_t, double>> initial_parameter_values;
  NativeVstWorkerTransportConfig transport{};
};

struct Diagnostics {
  LifecycleState state;
  std::uint64_t callbacks;
  std::uint64_t split_blocks;
  std::uint64_t rejected_blocks;
  std::uint32_t active_revision;
  std::uint32_t prepared_revision;
  std::uint32_t retired_revision;
  std::uint32_t transport_epoch;
  std::uint64_t render_epoch;
  std::uint32_t installed_assets;
  std::int64_t transport_frame;
  RejectedBlockReason last_rejected_reason;
  std::uint64_t last_rejected_callback;
  std::uint64_t last_rejected_render_epoch;
  std::uint32_t last_rejected_transport_epoch;
  std::uint32_t last_rejected_core_result;
  std::uint32_t last_rejected_frame_count;
  std::uint32_t last_rejected_channel_count;
  std::uint32_t last_rejected_processor_event_count;
  std::uint32_t last_rejected_instrument_event_count;
  std::uint32_t last_rejected_graph_revision;
};

enum class GraphRevisionStatusCode : std::uint32_t {
  kPrepared = 1,
  kPublished = 2,
  kRetired = 3,
  kRolledBack = 4,
  kStaleRevision = 5,
  kInvalidRevision = 6,
  kPrepareFailed = 7,
  kPublishFailed = 8,
  kRetirementNotSafe = 9,
  kRetirementCapacityExceeded = 10,
};

enum class GraphRevisionContinuity : std::uint32_t {
  kNotEvaluated = 0,
  kAccepted = 1,
  kFallback = 2,
  kRejected = 3,
};

struct GraphRevisionStatus {
  GraphRevisionStatusCode code = GraphRevisionStatusCode::kInvalidRevision;
  GraphRevisionContinuity continuity = GraphRevisionContinuity::kNotEvaluated;
  std::uint32_t requested_revision = 0;
  std::uint32_t active_revision = 0;
  std::uint32_t prepared_revision = 0;
  std::uint32_t retired_revision = 0;
  std::uint64_t render_epoch = 0;
};

enum class WorkerNotificationKind : std::uint32_t {
  kLatency = 1,
  kBuses = 2,
  kRestart = 3,
  kFault = 4,
  kMiss = 5,
  kEditorInteraction = 6,
  kParameterEdit = 7,
  kTail = 8,
  kEditorState = 9,
};

enum class NativeVstWorkerHealth : std::uint32_t {
  kStarting = 0,
  kReady = 1,
  kStopping = 2,
  kStopped = 3,
  kFaulted = 4,
};

struct WorkerNotification {
  WorkerNotificationKind kind = WorkerNotificationKind::kFault;
  std::uint32_t graph_revision = 0;
  std::uint64_t graph_node_id = 0;
  std::string instance_id;
  std::uint32_t value = 0;
  std::uint32_t parameter_id = 0;
  double normalized_value = 0.0;
};

class WorkerNotificationQueue final {
 public:
  static constexpr std::size_t kCapacity = 64;

  bool Push(WorkerNotification notification);
  [[nodiscard]] bool Empty() const noexcept { return notifications_.empty(); }
  WorkerNotification Pop();

 private:
  static bool IsParameterEdit(const WorkerNotification& notification) noexcept {
    return notification.kind == WorkerNotificationKind::kParameterEdit;
  }
  static bool IsCritical(const WorkerNotification& notification) noexcept {
    return notification.kind == WorkerNotificationKind::kRestart
      || notification.kind == WorkerNotificationKind::kFault;
  }

  std::deque<WorkerNotification> notifications_;
};

WorkerNotification IdentifyWorkerNotification(
  const NativeVstAttachment& attachment,
  std::uint32_t graph_revision,
  WorkerNotificationKind kind,
  std::uint32_t value,
  std::uint32_t parameter_id = 0,
  double normalized_value = 0.0);

struct RecordingConfig {
  std::string device_uid;
  std::uint32_t generation = 0;
  std::uint64_t session_id = 0;
  std::uint32_t channel_count = 0;
  std::array<std::uint32_t, DAW_AUDIO_RECORDING_CAPTURE_MAX_CHANNELS> input_channels{};
  float gain = 1.0F;
  std::int32_t polarity = 1;
  std::int64_t punch_start_frame = 0;
  std::int64_t punch_end_frame = -1;
  bool monitoring = false;
};

struct RecordingBlock {
  std::uint32_t generation = 0;
  std::uint64_t session_id = 0;
  std::uint32_t sequence = 0;
  std::uint32_t frame_count = 0;
  std::uint32_t channel_count = 0;
  float rms = 0.0F;
  float peak = 0.0F;
  std::vector<float> samples;
};

struct RecordingStatus {
  std::uint32_t generation = 0;
  std::uint64_t session_id = 0;
  std::int64_t timeline_frame = 0;
  std::uint64_t captured_frames = 0;
  std::uint64_t dropped_frames = 0;
  std::uint32_t dropped_blocks = 0;
  std::uint32_t available_blocks = 0;
  std::uint32_t queued_blocks = 0;
  float rms = 0.0F;
  float peak = 0.0F;
  bool fatal = false;
  bool active = false;
  bool configured = false;
};

struct RecordingMessage {
  std::optional<RecordingBlock> block;
  RecordingStatus status;
};

struct MeterEntry {
  std::uint64_t node_id = 0;
  float left_rms = 0.0F;
  float right_rms = 0.0F;
};

struct MeterBatch {
  std::uint32_t graph_revision = 0;
  std::uint32_t transport_epoch = 0;
  std::uint64_t sequence = 0;
  std::uint32_t entry_count = 0;
  std::array<MeterEntry, kMaximumMeterEntries> entries{};
};

struct SpectrumFrame {
  std::uint32_t graph_revision = 0;
  std::uint32_t transport_epoch = 0;
  std::uint64_t sequence = 0;
  std::uint64_t node_id = 0;
  std::uint32_t sample_rate_hz = 0;
  std::uint32_t fft_size = 0;
  std::uint32_t bin_count = 0;
  std::array<float, kMaximumSpectrumBins> data{};
};

struct ScheduleProgress {
  std::uint32_t revision = 0;
  std::uint32_t epoch = 0;
  std::uint64_t progress_sequence = 0;
  std::uint64_t rendered_through_frame = 0;
  std::uint64_t accepted_through_frame = 0;
  std::uint64_t last_accepted_window_id = 0;
  std::uint64_t applied_transport_transition_id = 0;
  std::uint64_t applied_urgent_sequence = 0;
  std::uint64_t applied_processor_sequence = 0;
  bool running = false;
  bool schedule_complete = false;
  std::uint32_t instrument_credits = 0;
  std::uint32_t source_credits = 0;
  std::uint32_t automation_credits = 0;
};

class AudioHost {
 public:
  AudioHost();
  ~AudioHost();
  AudioHost(const AudioHost&) = delete;
  AudioHost& operator=(const AudioHost&) = delete;

  bool Configure(const HostConfig& config);
  bool PrepareAndPublishGraph(std::uint32_t revision, std::span<const std::uint8_t> snapshot);
  GraphRevisionStatus PrepareGraphRevision(std::uint32_t revision, std::span<const std::uint8_t> snapshot);
  bool ConfigureInstrumentStates(std::span<const std::uint8_t> payload);
  GraphRevisionStatus PublishGraphRevision(std::uint32_t revision);
  GraphRevisionStatus RollbackGraphRevision(std::uint32_t revision);
  GraphRevisionStatus RetireGraphRevision(std::uint32_t revision);
  bool QueueParameterEvents(std::span<const std::uint8_t> payload);
  bool QueueProcessorStatePatch(std::span<const std::uint8_t> payload);
  bool QueueInstrumentEvents(std::span<const std::uint8_t> payload);
  bool QueueSourceEvents(std::span<const std::uint8_t> payload);
  bool QueueNativeVstParameterEvents(std::span<const std::uint8_t> payload);
  bool QueueNativeVstMidiEvents(std::span<const std::uint8_t> payload);
  bool SetNativeVstState(std::span<const std::uint8_t> payload);
  std::optional<std::vector<std::uint8_t>> GetNativeVstState(std::span<const std::uint8_t> payload);
  void ProcessNativeVstControl();
  bool InstallAsset(
    std::uint32_t asset_id,
    std::uint32_t frame_count,
    std::uint32_t sample_rate_hz,
    std::uint32_t channel_count,
    std::uint64_t content_hash_prefix,
    std::span<const float> samples);
  bool ReleaseAsset(std::uint32_t asset_id);
  bool SetTransport(
    std::uint32_t epoch,
    bool running,
    std::int64_t frame,
    double bpm = 0.0,
    std::uint32_t time_signature_numerator = 0,
    std::uint32_t time_signature_denominator = 0,
    bool cycle_active = false,
    double cycle_start_sec = 0.0,
    double cycle_end_sec = 0.0,
    std::uint64_t transition_id = 0
  );
  bool QueueScheduleWindow(std::span<const std::uint8_t> payload);
  bool ReenableVstScheduleAutomation(std::span<const std::uint8_t> payload);
  bool ConfigureRecording(const RecordingConfig& config);
  bool StartRecording();
  bool StopRecording(std::optional<std::int64_t> stop_frame);
  bool CancelRecording();
  void NotifyOutputDeviceLost();
  void NotifyRecordingDeviceLost();
  std::optional<RecordingMessage> WaitForRecordingMessage(
    std::uint64_t last_status_revision,
    const std::atomic<bool>* running);
  void WakeRecordingWait();
  std::optional<WorkerNotification> WaitForWorkerNotification(const std::atomic<bool>* running);
  bool WaitForMeterBatch(const std::atomic<bool>* running);
  std::optional<MeterBatch> DrainMeterBatch();
  bool SetSpectrumNode(std::uint64_t node_id);
  bool WaitForSpectrumFrame(const std::atomic<bool>* running);
  std::optional<SpectrumFrame> DrainSpectrumFrame();
  bool WaitForScheduleProgress(const std::atomic<bool>* running);
  std::optional<ScheduleProgress> DrainScheduleProgress();
  void WakeWorkerNotificationWait();
  void WakeMeterWait();
  void WakeSpectrumWait();
  void WakeScheduleProgressWait();
  std::uint64_t recordingStatusRevision() const;
  std::uint64_t appliedUrgentSequence() const;
  bool AttachNativeVst(const NativeVstAttachment& attachment);
  std::optional<NativeVstWorkerHealth> NativeVstHealth(std::string_view instance_id) const;
  std::optional<NativeVstEditorStatus> ExecuteNativeVstEditorCommand(
    std::string_view instance_id,
    NativeVstEditorCommand command,
    std::uint32_t width = 0,
    std::uint32_t height = 0,
    std::optional<NativeVstEditorAnchor> anchor = std::nullopt);
  bool DetachVstReference(std::string_view instance_id);
  bool Start();
  bool StartOffline();
  bool StartDiagnosticMode();
  void Stop();
  void Teardown();
  bool Retire(std::uint32_t revision);
  bool ProcessPlanar(std::span<const float* const> input, std::span<float* const> output, std::uint32_t frame_count);
  bool ProcessRecordingPlanar(std::span<const float* const> input, std::uint32_t frame_count);
  Diagnostics diagnostics() const;
  DeviceReadinessReason readinessReason() const;

 private:
  struct Impl;
  Impl* impl_;
};

struct AudioDevice {
  std::string uid;
  std::string name;
  std::uint32_t input_channels;
  std::uint32_t output_channels;
  std::uint32_t nominal_sample_rate_hz;
  std::uint32_t maximum_frames_per_block;
  bool available;
};

std::vector<AudioDevice> EnumerateDevices();
std::optional<AudioDevice> SelectOutputDevice(std::optional<std::string_view> preferred_uid);
std::optional<AudioDevice> SelectInputDevice(std::optional<std::string_view> preferred_uid);
void NotifyCoreAudioDeviceLost(AudioHost& host, CoreAudioDeviceRole role);
bool StartCoreAudioDevice(
  std::string_view uid,
  std::uint32_t sample_rate_hz,
  std::uint32_t channel_count,
  AudioHost* host,
  void** session);
void StopCoreAudioDevice(void* session);
bool StartCoreAudioInputDevice(
  std::string_view uid,
  std::uint32_t sample_rate_hz,
  std::uint32_t channel_count,
  AudioHost* host,
  void** session);

}  // namespace daw::audio_host_macos
