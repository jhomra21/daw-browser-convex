#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <array>
#include <atomic>
#include <vector>

#include "daw/audio_core.h"

namespace daw::audio_host_macos {

constexpr std::uint32_t kControlProtocolVersion = 7;
constexpr std::size_t kMaximumControlPayloadBytes = 1'048'576;
constexpr std::size_t kControlFrameHeaderBytes = 16;
constexpr std::size_t kNativeGraphFrameHeaderBytes = 12;
constexpr std::uint32_t kMaximumAssetChannels = 64;
constexpr std::uint32_t kMaximumAssetFrames = 262'144;
constexpr std::size_t kMaximumInstalledAssets = 64;

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

/* Native-control-only attachment data. It intentionally contains resolved
 * paths and never crosses project, Wasm, preload, or renderer boundaries. */
struct NativeVstAttachment {
  std::uint64_t graph_node_id = 0;
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
  std::uint32_t transport_latency_frames = 0;
  bool playback_enabled = false;
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
};

struct GraphRevisionStatus {
  GraphRevisionStatusCode code = GraphRevisionStatusCode::kInvalidRevision;
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
};

struct WorkerNotification {
  WorkerNotificationKind kind = WorkerNotificationKind::kFault;
  std::uint32_t graph_revision = 0;
  std::uint64_t graph_node_id = 0;
  std::string instance_id;
  std::uint32_t value = 0;
};

WorkerNotification IdentifyWorkerNotification(
  const NativeVstAttachment& attachment,
  std::uint32_t graph_revision,
  WorkerNotificationKind kind,
  std::uint32_t value);

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

class AudioHost {
 public:
  AudioHost();
  ~AudioHost();
  AudioHost(const AudioHost&) = delete;
  AudioHost& operator=(const AudioHost&) = delete;

  bool Configure(const HostConfig& config);
  bool PrepareAndPublishGraph(std::uint32_t revision, std::span<const std::uint8_t> snapshot);
  GraphRevisionStatus PrepareGraphRevision(std::uint32_t revision, std::span<const std::uint8_t> snapshot);
  GraphRevisionStatus PublishGraphRevision(std::uint32_t revision);
  GraphRevisionStatus RollbackGraphRevision(std::uint32_t revision);
  GraphRevisionStatus RetireGraphRevision(std::uint32_t revision);
  bool QueueParameterEvents(std::span<const std::uint8_t> payload);
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
  bool SetTransport(std::uint32_t epoch, bool running, std::int64_t frame);
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
  void WakeWorkerNotificationWait();
  std::uint64_t recordingStatusRevision() const;
  bool AttachNativeVst(const NativeVstAttachment& attachment);
  bool DetachVstReference(std::string_view instance_id);
  bool Start();
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
