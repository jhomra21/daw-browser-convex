#include "daw/audio_host_macos.h"
#include "daw/audio_core_native.h"
#include "worker-control-service.h"

#include <mach-o/dyld.h>

#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <filesystem>
#include <limits>
#include <memory>
#include <mutex>
#include <thread>
#include <unordered_map>

namespace daw::audio_host_macos {
namespace {

constexpr std::uint32_t kFrameMagic = 0x44415748U;  // DAWH
constexpr std::size_t kMaximumNativeVstAttachments = 64;
constexpr std::uint32_t kMaximumNativeVstFrames = 8'192;
constexpr std::uint32_t kMaximumNativeVstChannels = 64;
constexpr std::uint32_t kMaximumNativeVstSlots = 8;
constexpr std::uint32_t kNativeVstMissLimit = 3;
constexpr std::size_t kMaximumWorkerNotifications = 64;

std::optional<std::string> WorkerExecutablePath() {
  std::uint32_t size = 0;
  if (_NSGetExecutablePath(nullptr, &size) != -1 || size == 0 || size > 16U * 1024U) return std::nullopt;
  std::vector<char> executable(size);
  if (_NSGetExecutablePath(executable.data(), &size) != 0) return std::nullopt;
  std::error_code error;
  const auto host = std::filesystem::canonical(executable.data(), error);
  if (error) return std::nullopt;
  const auto worker = std::filesystem::canonical(host.parent_path() / daw::plugin_host::kWorkerArtifactId, error);
  if (error || !std::filesystem::is_regular_file(worker, error) || error) return std::nullopt;
  return worker.string();
}

std::uint32_t ReadU32(const std::uint8_t* bytes) {
  return (static_cast<std::uint32_t>(bytes[0]) << 24U)
    | (static_cast<std::uint32_t>(bytes[1]) << 16U)
    | (static_cast<std::uint32_t>(bytes[2]) << 8U)
    | static_cast<std::uint32_t>(bytes[3]);
}

std::uint32_t ReadLeU32(const std::uint8_t* bytes) {
  return static_cast<std::uint32_t>(bytes[0])
    | (static_cast<std::uint32_t>(bytes[1]) << 8U)
    | (static_cast<std::uint32_t>(bytes[2]) << 16U)
    | (static_cast<std::uint32_t>(bytes[3]) << 24U);
}

std::uint64_t ReadLeU64(const std::uint8_t* bytes) {
  std::uint64_t value = 0;
  for (std::size_t index = 0; index < 8; ++index) value |= static_cast<std::uint64_t>(bytes[index]) << (index * 8U);
  return value;
}

float ReadLeFloat(const std::uint8_t* bytes) {
  const std::uint32_t bits = ReadLeU32(bytes);
  float value = 0.0F;
  std::memcpy(&value, &bits, sizeof(value));
  return value;
}

double ReadLeDouble(const std::uint8_t* bytes) {
  const std::uint64_t bits = ReadLeU64(bytes);
  double value = 0.0;
  std::memcpy(&value, &bits, sizeof(value));
  return value;
}

bool ReadNativeInstanceId(const std::span<const std::uint8_t> payload, std::size_t& offset, std::string& instance_id) {
  if (offset + 4 > payload.size()) return false;
  const std::uint32_t length = ReadLeU32(payload.data() + offset);
  offset += 4;
  if (length == 0 || length > 256 || offset + length > payload.size()) return false;
  instance_id.assign(reinterpret_cast<const char*>(payload.data() + offset), length);
  offset += length;
  return true;
}

void WriteU32(std::vector<std::uint8_t>& bytes, std::size_t offset, std::uint32_t value) {
  bytes[offset] = static_cast<std::uint8_t>(value >> 24U);
  bytes[offset + 1] = static_cast<std::uint8_t>(value >> 16U);
  bytes[offset + 2] = static_cast<std::uint8_t>(value >> 8U);
  bytes[offset + 3] = static_cast<std::uint8_t>(value);
}

bool ValidConfig(const HostConfig& config) {
  return !config.device_uid.empty()
    && config.sample_rate_hz > 0
    && config.max_frames_per_block > 0
    && config.channel_count > 0
    && config.revision > 0;
}

bool ValidNativeVstAttachment(const NativeVstAttachment& attachment) {
  const auto channels_for_layout = [](const std::uint32_t layout) {
    return layout == DAW_AUDIO_GRAPH_LAYOUT_MONO ? 1U
      : layout == DAW_AUDIO_GRAPH_LAYOUT_STEREO ? 2U : 0U;
  };
  const std::uint32_t input_channels = channels_for_layout(attachment.input_layout);
  const std::uint32_t output_channels = channels_for_layout(attachment.output_layout);
  if (attachment.graph_node_id == 0 || attachment.instance_id.empty() || attachment.instance_id.size() > 256
    || attachment.class_id.empty() || attachment.class_id.size() > 256 || attachment.vendor_id.empty()
    || attachment.vendor_id.size() > 256 || attachment.canonical_bundle_path.empty()
    || attachment.canonical_executable_path.empty()
    || !attachment.canonical_executable_path.starts_with(attachment.canonical_bundle_path + "/")
    || attachment.architecture != 1 || attachment.scanner_catalog_version != 2
    || (attachment.role != NativeVstRole::kEffect && attachment.role != NativeVstRole::kInstrument)
    || (attachment.input_layout != DAW_AUDIO_GRAPH_LAYOUT_MONO && attachment.input_layout != DAW_AUDIO_GRAPH_LAYOUT_STEREO)
    || (attachment.output_layout != DAW_AUDIO_GRAPH_LAYOUT_MONO && attachment.output_layout != DAW_AUDIO_GRAPH_LAYOUT_STEREO)
    || attachment.transport.slot_count == 0 || attachment.transport.slot_count > kMaximumNativeVstSlots
    || attachment.transport.maximum_frames == 0 || attachment.transport.maximum_frames > kMaximumNativeVstFrames
    || attachment.transport.input_channels == 0 || attachment.transport.input_channels > kMaximumNativeVstChannels
    || attachment.transport.output_channels == 0 || attachment.transport.output_channels > kMaximumNativeVstChannels
    || attachment.transport.maximum_events_per_block == 0 || attachment.transport.maximum_events_per_block > daw::plugin_host::kMaximumWorkerEvents
    || input_channels == 0 || output_channels == 0
    || attachment.transport.input_channels != input_channels || attachment.transport.output_channels != output_channels
    || attachment.transport_latency_frames != attachment.transport.maximum_frames
    || attachment.declared_latency_frames > std::numeric_limits<std::uint32_t>::max() - attachment.transport_latency_frames
    || std::all_of(attachment.bundle_fingerprint.begin(), attachment.bundle_fingerprint.end(), [](const auto value) { return value == 0; })
    || std::all_of(attachment.binary_fingerprint.begin(), attachment.binary_fingerprint.end(), [](const auto value) { return value == 0; })) {
    return false;
  }
  return attachment.role != NativeVstRole::kEffect || input_channels == output_channels;
}

std::string HexFingerprint(const std::array<std::uint8_t, 32>& fingerprint) {
  constexpr char kHex[] = "0123456789abcdef";
  std::string result;
  result.resize(fingerprint.size() * 2);
  for (std::size_t index = 0; index < fingerprint.size(); ++index) {
    result[index * 2] = kHex[fingerprint[index] >> 4U];
    result[index * 2 + 1] = kHex[fingerprint[index] & 0x0FU];
  }
  return result;
}

struct NativeVstWorkerAttachment {
  NativeVstAttachment metadata;
  struct WorkerNotificationSink* notification_sink = nullptr;
  daw::plugin_host::WorkerControlService worker;
  std::array<std::uint64_t, kMaximumNativeVstSlots> pending_sequences{};
  std::array<std::uint32_t, kMaximumNativeVstSlots> missed_callbacks{};
  std::array<float, kMaximumNativeVstFrames * 2> input{};
  std::array<float, kMaximumNativeVstFrames * 2> output{};
  std::uint64_t next_sequence = 1;
  std::uint32_t next_slot = 0;
  std::array<daw::plugin_host::WorkerTransportEvent, daw::plugin_host::kMaximumWorkerEvents> queued_events{};
  std::array<daw::plugin_host::WorkerTransportEvent, daw::plugin_host::kMaximumWorkerEvents> block_events{};
  std::atomic<std::uint32_t> event_read = 0;
  std::atomic<std::uint32_t> event_write = 0;

  bool QueueEvents(const std::span<const daw::plugin_host::WorkerTransportEvent> events) {
    const auto write = event_write.load(std::memory_order_relaxed);
    const auto read = event_read.load(std::memory_order_acquire);
    if (events.size() > queued_events.size() - (write - read)) return false;
    for (std::size_t index = 0; index < events.size(); ++index) queued_events[(write + index) % queued_events.size()] = events[index];
    event_write.store(write + static_cast<std::uint32_t>(events.size()), std::memory_order_release);
    return true;
  }

  void WriteFallback(const daw::audio_core::NativeGraphNodeRender& render) noexcept {
    if (metadata.role != NativeVstRole::kInstrument) return;
    for (std::uint32_t channel = 0; channel < render.channel_count; ++channel) {
      std::fill_n(render.planes[channel], render.frame_count, 0.0F);
    }
  }

  void Process(const daw::audio_core::NativeGraphNodeRender& render) noexcept {
    WriteFallback(render);
    const auto port = worker.callbackPort();
    const std::size_t samples = static_cast<std::size_t>(render.frame_count) * render.channel_count;
    for (std::uint32_t slot = 0; slot < metadata.transport.slot_count; ++slot) {
      const std::uint64_t sequence = pending_sequences[slot];
      if (sequence == 0) continue;
      if (port.ReadCompleted(slot, sequence)) {
        if (port.CopyCompletedOutput(slot, sequence, std::span<float>(output.data(), samples))) {
          for (std::uint32_t channel = 0; channel < render.channel_count; ++channel) {
            std::memcpy(render.planes[channel], output.data() + channel * render.frame_count, render.frame_count * sizeof(float));
          }
        }
        pending_sequences[slot] = 0;
        missed_callbacks[slot] = 0;
        continue;
      }
      if (++missed_callbacks[slot] == kNativeVstMissLimit) {
        static_cast<void>(port.DiscardLate(slot, sequence + 1));
        static_cast<void>(port.PublishDiagnostic({
          .kind = daw::plugin_host::WorkerDiagnosticKind::kMiss,
          .sequence = sequence,
        }));
        pending_sequences[slot] = 0;
        missed_callbacks[slot] = 0;
      }
    }
    for (std::uint32_t attempt = 0; attempt < metadata.transport.slot_count; ++attempt) {
      const std::uint32_t slot = (next_slot + attempt) % metadata.transport.slot_count;
      if (pending_sequences[slot] != 0) continue;
      for (std::uint32_t channel = 0; channel < render.channel_count; ++channel) {
        std::memcpy(input.data() + channel * render.frame_count, render.planes[channel], render.frame_count * sizeof(float));
      }
      if (!port.CopyInput(slot, std::span<const float>(input.data(), samples))) return;
      const std::uint64_t sequence = next_sequence++;
      const auto write = event_write.load(std::memory_order_acquire);
      std::uint32_t read = event_read.load(std::memory_order_relaxed);
      std::size_t event_count = 0;
      while (read != write && event_count < block_events.size()) {
        const auto event = queued_events[read % queued_events.size()];
        if (event.sampleOffset >= render.frame_count) break;
        block_events[event_count++] = event;
        ++read;
      }
      if (event_count > metadata.transport.maximum_events_per_block) return;
      if (port.Submit({.slotIndex = slot, .sequence = sequence, .numSamples = render.frame_count,
        .events = std::span<const daw::plugin_host::WorkerTransportEvent>(block_events.data(), event_count)})
        != daw::plugin_host::WorkerSubmissionStatus::kAccepted) return;
      event_read.store(read, std::memory_order_release);
      pending_sequences[slot] = sequence;
      next_slot = (slot + 1) % metadata.transport.slot_count;
      return;
    }
  }
};

struct WorkerNotificationSink {
  std::mutex mutex;
  std::condition_variable ready;
  std::deque<WorkerNotification> notifications;
  std::atomic<std::uint32_t>* active_revision = nullptr;
  std::atomic<bool> mute_requested = false;
};

void ForwardWorkerDiagnostic(
  const daw::plugin_host::WorkerDiagnostic& diagnostic,
  void* const context
) noexcept {
  auto* attachment = static_cast<NativeVstWorkerAttachment*>(context);
  if (attachment == nullptr || attachment->notification_sink == nullptr) return;
  std::optional<WorkerNotificationKind> kind;
  if (diagnostic.kind == daw::plugin_host::WorkerDiagnosticKind::kLatency) kind = WorkerNotificationKind::kLatency;
  else if (diagnostic.kind == daw::plugin_host::WorkerDiagnosticKind::kBuses) kind = WorkerNotificationKind::kBuses;
  else if (diagnostic.kind == daw::plugin_host::WorkerDiagnosticKind::kRestart) kind = WorkerNotificationKind::kRestart;
  else if (diagnostic.kind == daw::plugin_host::WorkerDiagnosticKind::kFault) kind = WorkerNotificationKind::kFault;
  else if (diagnostic.kind == daw::plugin_host::WorkerDiagnosticKind::kMiss) kind = WorkerNotificationKind::kMiss;
  if (!kind) return;
  WorkerNotificationSink& sink = *attachment->notification_sink;
  if (*kind == WorkerNotificationKind::kBuses || *kind == WorkerNotificationKind::kRestart
    || *kind == WorkerNotificationKind::kFault || *kind == WorkerNotificationKind::kMiss) {
    sink.mute_requested.store(true, std::memory_order_release);
  }
  const std::lock_guard lock(sink.mutex);
  if (sink.notifications.size() == kMaximumWorkerNotifications) sink.notifications.pop_front();
  sink.notifications.push_back(IdentifyWorkerNotification(
    attachment->metadata,
    sink.active_revision->load(std::memory_order_acquire),
    *kind,
    diagnostic.value
  ));
  sink.ready.notify_one();
}

void DispatchNativeVstGraphHook(const daw::audio_core::NativeGraphNodeRender& render) noexcept {
  auto* attachment = static_cast<NativeVstWorkerAttachment*>(render.attachment);
  if (attachment != nullptr) attachment->Process(render);
}

}  // namespace

WorkerNotification IdentifyWorkerNotification(
  const NativeVstAttachment& attachment,
  const std::uint32_t graph_revision,
  const WorkerNotificationKind kind,
  const std::uint32_t value
) {
  return {
    .kind = kind,
    .graph_revision = graph_revision,
    .graph_node_id = attachment.graph_node_id,
    .instance_id = attachment.instance_id,
    .value = value,
  };
}

std::optional<ControlFrame> DecodeControlFrame(std::span<const std::uint8_t> bytes) {
  if (bytes.size() < kControlFrameHeaderBytes) return std::nullopt;
  if (ReadU32(bytes.data()) != kFrameMagic || ReadU32(bytes.data() + 4) != kControlProtocolVersion) return std::nullopt;
  const std::uint32_t type = ReadU32(bytes.data() + 8);
  const std::uint32_t length = ReadU32(bytes.data() + 12);
  if (length > kMaximumControlPayloadBytes || bytes.size() != kControlFrameHeaderBytes + length) return std::nullopt;
  if (type < static_cast<std::uint32_t>(ControlType::kHostHello)
    || type > static_cast<std::uint32_t>(ControlType::kGraphRevisionStatus)) return std::nullopt;
  return ControlFrame{
    .type = static_cast<ControlType>(type),
    .payload = {bytes.begin() + static_cast<std::ptrdiff_t>(kControlFrameHeaderBytes), bytes.end()},
  };
}

std::vector<std::uint8_t> EncodeControlFrame(ControlType type, std::span<const std::uint8_t> payload) {
  if (payload.size() > kMaximumControlPayloadBytes) return {};
  std::vector<std::uint8_t> frame(kControlFrameHeaderBytes + payload.size());
  WriteU32(frame, 0, kFrameMagic);
  WriteU32(frame, 4, kControlProtocolVersion);
  WriteU32(frame, 8, static_cast<std::uint32_t>(type));
  WriteU32(frame, 12, static_cast<std::uint32_t>(payload.size()));
  if (!payload.empty()) std::memcpy(frame.data() + kControlFrameHeaderBytes, payload.data(), payload.size());
  return frame;
}

std::string CoreAudioDeviceId(std::string_view uid) {
  return uid.empty() ? std::string{} : "coreaudio:" + std::string(uid);
}

std::optional<std::string> CoreAudioDeviceUid(std::string_view device_id) {
  constexpr std::string_view prefix = "coreaudio:";
  if (!device_id.starts_with(prefix) || device_id.size() == prefix.size()) return std::nullopt;
  return std::string(device_id.substr(prefix.size()));
}

struct AudioHost::Impl {
  enum class RecordingCommand : std::uint32_t { kNone, kStop, kCancel };
  enum class QueuedControlKind : std::uint8_t { kProcessor, kInstrument, kSource };
  struct QueuedControlEvent {
    QueuedControlKind kind = QueuedControlKind::kProcessor;
    daw_audio_processor_event processor{};
    daw_audio_instrument_event instrument{};
    daw_audio_sample_source_event source{};
  };
  static constexpr std::uint32_t kControlQueueCapacity = 256;
  struct InstalledAsset {
    daw_audio_asset_handle handle = 0;
    std::vector<float> samples;
    std::array<const float*, 64> planes{};
    std::uint32_t frame_count = 0;
    std::uint32_t sample_rate_hz = 0;
    std::uint32_t channel_count = 0;
    std::uint64_t content_hash_prefix = 0;
  };
  std::atomic<daw_audio_core_handle> active_core = 0;
  daw_audio_core_handle prepared_core = 0;
  daw_audio_core_handle retired_core = 0;
  HostConfig config{};
  std::atomic<LifecycleState> state = LifecycleState::kIdle;
  std::atomic<std::uint64_t> callbacks = 0;
  std::atomic<std::uint64_t> split_blocks = 0;
  std::atomic<std::uint64_t> rejected_blocks = 0;
  std::atomic<std::uint32_t> active_revision = 0;
  std::atomic<std::uint32_t> prepared_revision = 0;
  std::atomic<std::uint32_t> retired_revision = 0;
  std::atomic<std::uint64_t> completed_render_epoch = 0;
  std::atomic<std::uint64_t> retired_after_epoch = 0;
  std::atomic<std::uint32_t> publish_requested_revision = 0;
  std::atomic<std::uint32_t> publish_acknowledged_revision = 0;
  std::mutex publish_wait_mutex;
  std::condition_variable publish_wait;
  std::atomic<std::uint32_t> transport_epoch = 0;
  std::atomic<std::int64_t> transport_frame = 0;
  std::atomic<bool> transport_running = false;
  std::atomic<std::uint32_t> last_graph_revision = 0;
  std::array<QueuedControlEvent, kControlQueueCapacity> control_queue{};
  std::atomic<std::uint32_t> control_queue_read = 0;
  std::atomic<std::uint32_t> control_queue_write = 0;
  bool graph_prepared = false;
  bool transport_prepared = false;
  void* device_session = nullptr;
  void* recording_device_session = nullptr;
  std::unordered_map<std::uint32_t, InstalledAsset> assets;
  std::unordered_map<std::uint32_t, daw_audio_asset_handle> prepared_asset_handles;
  std::unordered_map<std::string, std::unique_ptr<NativeVstWorkerAttachment>> native_vst_attachments;
  bool native_graph_revision_required = false;
  WorkerNotificationSink worker_notifications{};
  std::atomic<daw_audio_core_handle> recording_capture = 0;
  std::atomic<bool> recording_started = false;
  std::atomic<bool> recording_monitoring = false;
  std::atomic<std::uint32_t> recording_channel_count = 0;
  std::atomic<RecordingCommand> recording_command = RecordingCommand::kNone;
  std::atomic<std::int64_t> recording_stop_frame = -1;
  std::atomic<std::int64_t> recording_input_frame = 0;
  std::atomic<std::int64_t> recording_timeline_start_frame = 0;
  std::atomic<std::int64_t> recording_punch_start_frame = 0;
  std::atomic<std::uint64_t> recording_status_revision = 0;
  std::atomic<bool> recording_device_lost = false;
  std::array<std::array<float, DAW_AUDIO_RECORDING_CAPTURE_BLOCK_FRAMES>,
    DAW_AUDIO_RECORDING_CAPTURE_MAX_CHANNELS> recording_monitor{};
  std::array<float*, DAW_AUDIO_RECORDING_CAPTURE_MAX_CHANNELS> recording_monitor_planes{};
  static constexpr std::uint32_t kRecordingMonitorCapacity = 16384;
  std::array<std::array<float, kRecordingMonitorCapacity>,
    DAW_AUDIO_RECORDING_CAPTURE_MAX_CHANNELS> recording_monitor_ring{};
  std::atomic<std::uint64_t> recording_monitor_read = 0;
  std::atomic<std::uint64_t> recording_monitor_write = 0;
  mutable std::mutex recording_wait_mutex;
  std::condition_variable recording_wait;
  static constexpr std::uint32_t kRealtimePublishAcknowledged = 1U << 0U;
  static constexpr std::uint32_t kRealtimeRecordingStatus = 1U << 1U;
  std::atomic<std::uint32_t> realtime_bridge_pending = 0;
  std::atomic<bool> realtime_bridge_running = false;
  std::mutex realtime_bridge_wait_mutex;
  std::condition_variable realtime_bridge_wait;
  std::thread realtime_bridge_thread;

  void NotifyRecordingStatus() {
    recording_status_revision.fetch_add(1, std::memory_order_release);
    recording_wait.notify_all();
  }

  // DAW_REALTIME_CALLBACK_HELPER_BEGIN audio-host
  void SignalRealtimeBridge(const std::uint32_t events) noexcept {
    realtime_bridge_pending.fetch_or(events, std::memory_order_release);
  }
  // DAW_REALTIME_CALLBACK_HELPER_END audio-host

  void StartRealtimeBridge() {
    realtime_bridge_running.store(true, std::memory_order_release);
    realtime_bridge_thread = std::thread([this] {
      while (realtime_bridge_running.load(std::memory_order_acquire)) {
        const std::uint32_t pending = realtime_bridge_pending.exchange(0, std::memory_order_acq_rel);
        if ((pending & kRealtimePublishAcknowledged) != 0) publish_wait.notify_all();
        if ((pending & kRealtimeRecordingStatus) != 0) NotifyRecordingStatus();
        if (pending != 0) continue;
        // CoreAudio callbacks cannot wake scheduler primitives. This bounded
        // non-realtime bridge observes callback atomics within 100 microseconds.
        std::unique_lock lock(realtime_bridge_wait_mutex);
        realtime_bridge_wait.wait_for(lock, std::chrono::microseconds(100), [this] {
          return !realtime_bridge_running.load(std::memory_order_acquire)
            || realtime_bridge_pending.load(std::memory_order_acquire) != 0;
        });
      }
      const std::uint32_t pending = realtime_bridge_pending.exchange(0, std::memory_order_acq_rel);
      if ((pending & kRealtimePublishAcknowledged) != 0) publish_wait.notify_all();
      if ((pending & kRealtimeRecordingStatus) != 0) NotifyRecordingStatus();
    });
  }

  void StopRealtimeBridge() {
    if (!realtime_bridge_running.exchange(false, std::memory_order_acq_rel)) return;
    realtime_bridge_wait.notify_all();
    if (realtime_bridge_thread.joinable()) realtime_bridge_thread.join();
  }

  bool ApplyRecordingCommand(const std::int64_t current_frame) {
    const daw_audio_core_handle capture = recording_capture.load(std::memory_order_acquire);
    const RecordingCommand command = recording_command.exchange(RecordingCommand::kNone, std::memory_order_acq_rel);
    if (capture == 0 || command == RecordingCommand::kNone) return false;
    if (command == RecordingCommand::kCancel) {
      static_cast<void>(daw_audio_recording_capture_cancel(capture));
    } else {
      const std::int64_t requested = recording_stop_frame.exchange(-1, std::memory_order_acq_rel);
      static_cast<void>(daw_audio_recording_capture_finalize(capture, requested < 0 ? current_frame : requested));
    }
    recording_started.store(false, std::memory_order_release);
    return true;
  }
  [[nodiscard]] bool StartNativeVstWorkers() {
    const bool has_enabled_attachment = std::any_of(
      native_vst_attachments.begin(),
      native_vst_attachments.end(),
      [](const auto& entry) { return entry.second->metadata.playback_enabled; }
    );
    const auto worker_executable = has_enabled_attachment ? WorkerExecutablePath() : std::optional<std::string>{};
    if (has_enabled_attachment && !worker_executable) return false;
    std::array<NativeVstWorkerAttachment*, kMaximumNativeVstAttachments> started{};
    std::size_t started_count = 0;
    for (auto& [instance_id, attachment] : native_vst_attachments) {
      static_cast<void>(instance_id);
      if (!attachment->metadata.playback_enabled) continue;
      const auto& metadata = attachment->metadata;
      const daw::plugin_host::WorkerStartupRequest startup{
        .eligibility = {
          .canonicalBundlePath = metadata.canonical_bundle_path,
          .canonicalExecutablePath = metadata.canonical_executable_path,
          .bundleFingerprint = HexFingerprint(metadata.bundle_fingerprint),
          .binaryFingerprint = HexFingerprint(metadata.binary_fingerprint),
          .arm64 = metadata.architecture == 1,
          .codeSignVerified = true,
          .quarantinePresent = false,
          .scannerProtocolVersion = metadata.scanner_catalog_version,
        },
        .classId = metadata.class_id,
        .setup = {
          .sampleRate = static_cast<double>(config.sample_rate_hz),
          .maximumBlockFrames = metadata.transport.maximum_frames,
          .inputChannels = metadata.transport.input_channels,
          .outputChannels = metadata.transport.output_channels,
        },
      };
      const daw::plugin_host::WorkerTransportRequest transport{
        .slotCount = metadata.transport.slot_count,
        .maximumFrames = metadata.transport.maximum_frames,
        .inputChannels = metadata.transport.input_channels,
        .outputChannels = metadata.transport.output_channels,
        .maximumEventsPerBlock = metadata.transport.maximum_events_per_block,
      };
      const daw::plugin_host::WorkerHostConfiguration worker_configuration{
        .executable = *worker_executable,
        .artifact = {
          .id = std::string(daw::plugin_host::kWorkerArtifactId),
          .version = std::string(daw::plugin_host::kWorkerArtifactVersion),
        },
      };
      attachment->worker.SetDiagnosticListener(ForwardWorkerDiagnostic, attachment.get());
      if (!attachment->worker.Start(startup, worker_configuration, transport)) {
        for (std::size_t index = 0; index < started_count; ++index) started[index]->worker.Stop();
        return false;
      }
      started[started_count++] = attachment.get();
    }
    return true;
  }
  void StopNativeVstWorkers() {
    for (auto& [instance_id, attachment] : native_vst_attachments) {
      static_cast<void>(instance_id);
      attachment->worker.Stop();
      attachment->pending_sequences.fill(0);
      attachment->missed_callbacks.fill(0);
    }
  }
  bool EnqueueControlEvent(const QueuedControlEvent& event) {
    const std::uint32_t write = control_queue_write.load(std::memory_order_relaxed);
    const std::uint32_t read = control_queue_read.load(std::memory_order_acquire);
    if (write - read >= kControlQueueCapacity) return false;
    control_queue[write % kControlQueueCapacity] = event;
    control_queue_write.store(write + 1, std::memory_order_release);
    return true;
  }
  [[nodiscard]] bool HasQueuedControl() const {
    return control_queue_read.load(std::memory_order_acquire) != control_queue_write.load(std::memory_order_acquire);
  }
  [[nodiscard]] daw_audio_core_handle CreateRevisionCore(const std::uint32_t revision) {
    daw_audio_core_handle core = 0;
    const daw_audio_core_config core_config{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
      .max_frames_per_block = config.max_frames_per_block,
      .max_channels = config.channel_count,
      .max_assets = 64,
      .sample_rate_hz = config.sample_rate_hz,
    };
    if (daw_audio_core_create(&core_config, &core) != DAW_AUDIO_CORE_OK) return 0;
    prepared_asset_handles.clear();
    for (const auto& [asset_id, asset] : assets) {
      const daw_audio_asset_descriptor descriptor{
        .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
        .revision = revision,
        .byte_length = static_cast<std::uint64_t>(asset.samples.size() * sizeof(float)),
        .content_hash_prefix = asset.content_hash_prefix,
        .frame_count = asset.frame_count,
        .sample_rate_hz = asset.sample_rate_hz,
        .channel_count = asset.channel_count,
        .planes = asset.planes.data(),
      };
      daw_audio_asset_handle handle = 0;
      if (daw_audio_core_create_asset(core, &descriptor, &handle) != DAW_AUDIO_CORE_OK) {
        daw_audio_core_destroy(core);
        prepared_asset_handles.clear();
        return 0;
      }
      prepared_asset_handles.emplace(asset_id, handle);
    }
    if (transport_prepared) {
      const daw_audio_transport_state state{
        .epoch = transport_epoch.load(std::memory_order_acquire),
        .running = transport_running.load(std::memory_order_acquire) ? 1U : 0U,
        .frame = transport_frame.load(std::memory_order_acquire),
      };
      if (daw_audio_core_set_transport(core, &state) != DAW_AUDIO_CORE_OK) {
        daw_audio_core_destroy(core);
        prepared_asset_handles.clear();
        return 0;
      }
    }
    return core;
  }
};

AudioHost::AudioHost() : impl_(new Impl) {
  impl_->worker_notifications.active_revision = &impl_->active_revision;
  impl_->StartRealtimeBridge();
}

AudioHost::~AudioHost() {
  Stop();
  impl_->StopRealtimeBridge();
  const daw_audio_core_handle capture = impl_->recording_capture.exchange(0, std::memory_order_acq_rel);
  if (capture != 0) daw_audio_recording_capture_destroy(capture);
  const daw_audio_core_handle active_core = impl_->active_core.load(std::memory_order_acquire);
  if (active_core != 0) daw_audio_core_destroy(active_core);
  if (impl_->prepared_core != 0) daw_audio_core_destroy(impl_->prepared_core);
  if (impl_->retired_core != 0) daw_audio_core_destroy(impl_->retired_core);
  delete impl_;
}

bool AudioHost::Configure(const HostConfig& config) {
  if (!ValidConfig(config) || impl_->state.load(std::memory_order_acquire) == LifecycleState::kRunning) return false;
  daw_audio_core_handle next_core = 0;
  const daw_audio_core_config core_config{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .max_frames_per_block = config.max_frames_per_block,
    .max_channels = config.channel_count,
    .max_assets = 64,
    .sample_rate_hz = config.sample_rate_hz,
  };
  if (daw_audio_core_create(&core_config, &next_core) != DAW_AUDIO_CORE_OK) return false;
  const daw_audio_core_prepare_request prepare{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .graph_revision = config.revision,
    .reserved0 = 0,
    .reserved1 = 0,
  };
  if (daw_audio_core_prepare(next_core, &prepare) != DAW_AUDIO_CORE_OK
    || daw_audio_core_publish(next_core, config.revision) != DAW_AUDIO_CORE_OK) {
    daw_audio_core_destroy(next_core);
    return false;
  }
  const daw_audio_core_handle previous_core = impl_->active_core.exchange(next_core, std::memory_order_acq_rel);
  if (previous_core != 0) daw_audio_core_destroy(previous_core);
  if (impl_->prepared_core != 0) daw_audio_core_destroy(impl_->prepared_core);
  if (impl_->retired_core != 0) daw_audio_core_destroy(impl_->retired_core);
  impl_->prepared_core = 0;
  impl_->retired_core = 0;
  impl_->config = config;
  impl_->assets.clear();
  impl_->prepared_asset_handles.clear();
  impl_->graph_prepared = false;
  impl_->transport_prepared = false;
  impl_->transport_frame.store(0, std::memory_order_release);
  impl_->transport_running.store(false, std::memory_order_release);
  impl_->state.store(LifecycleState::kConfigured, std::memory_order_release);
  impl_->active_revision.store(config.revision, std::memory_order_release);
  impl_->prepared_revision.store(0, std::memory_order_release);
  impl_->retired_revision.store(0, std::memory_order_release);
  impl_->publish_requested_revision.store(0, std::memory_order_release);
  impl_->publish_acknowledged_revision.store(0, std::memory_order_release);
  impl_->completed_render_epoch.store(0, std::memory_order_release);
  impl_->last_graph_revision.store(0, std::memory_order_release);
  impl_->control_queue_read.store(0, std::memory_order_release);
  impl_->control_queue_write.store(0, std::memory_order_release);
  impl_->worker_notifications.mute_requested.store(false, std::memory_order_release);
  return true;
}

bool AudioHost::PrepareAndPublishGraph(const std::uint32_t revision, const std::span<const std::uint8_t> snapshot) {
  const auto prepared = PrepareGraphRevision(revision, snapshot);
  if (prepared.code != GraphRevisionStatusCode::kPrepared) return false;
  const auto published = PublishGraphRevision(revision);
  if (published.code != GraphRevisionStatusCode::kPublished) {
    static_cast<void>(RollbackGraphRevision(revision));
    return false;
  }
  if (published.retired_revision != 0) {
    const auto retired = RetireGraphRevision(published.retired_revision);
    if (retired.code != GraphRevisionStatusCode::kRetired) return false;
  }
  return true;
}

GraphRevisionStatus AudioHost::PrepareGraphRevision(
  const std::uint32_t revision,
  const std::span<const std::uint8_t> snapshot
) {
  const auto status = [this, revision](const GraphRevisionStatusCode code) {
    return GraphRevisionStatus{
      .code = code,
      .requested_revision = revision,
      .active_revision = impl_->active_revision.load(std::memory_order_acquire),
      .prepared_revision = impl_->prepared_revision.load(std::memory_order_acquire),
      .retired_revision = impl_->retired_revision.load(std::memory_order_acquire),
      .render_epoch = impl_->completed_render_epoch.load(std::memory_order_acquire),
    };
  };
  if (impl_->active_core.load(std::memory_order_acquire) == 0 || revision == 0
    || snapshot.size() <= kNativeGraphFrameHeaderBytes || snapshot.size() > kMaximumControlPayloadBytes) {
    return status(GraphRevisionStatusCode::kInvalidRevision);
  }
  if (impl_->HasQueuedControl() || impl_->prepared_core != 0 || impl_->retired_core != 0
    || revision <= impl_->last_graph_revision.load(std::memory_order_acquire)) {
    return status(GraphRevisionStatusCode::kStaleRevision);
  }
  const std::uint64_t framed_revision = (static_cast<std::uint64_t>(snapshot[0]) << 56U)
    | (static_cast<std::uint64_t>(snapshot[1]) << 48U)
    | (static_cast<std::uint64_t>(snapshot[2]) << 40U)
    | (static_cast<std::uint64_t>(snapshot[3]) << 32U)
    | (static_cast<std::uint64_t>(snapshot[4]) << 24U)
    | (static_cast<std::uint64_t>(snapshot[5]) << 16U)
    | (static_cast<std::uint64_t>(snapshot[6]) << 8U)
    | static_cast<std::uint64_t>(snapshot[7]);
  const std::uint32_t payload_size = ReadU32(snapshot.data() + 8);
  if (framed_revision != revision || framed_revision > std::numeric_limits<std::uint32_t>::max()
    || payload_size != snapshot.size() - kNativeGraphFrameHeaderBytes) {
    return status(GraphRevisionStatusCode::kInvalidRevision);
  }
  const daw_audio_core_handle prepared_core = impl_->CreateRevisionCore(revision);
  if (prepared_core == 0) return status(GraphRevisionStatusCode::kPrepareFailed);
  const auto payload = snapshot.subspan(kNativeGraphFrameHeaderBytes);
  if (daw_audio_core_prepare_graph_bytes(prepared_core, payload.data(), static_cast<std::uint32_t>(payload.size()))
    != DAW_AUDIO_CORE_OK) {
    daw_audio_core_destroy(prepared_core);
    impl_->prepared_asset_handles.clear();
    return status(GraphRevisionStatusCode::kPrepareFailed);
  }
  std::vector<daw::audio_core::NativeGraphHookBinding> bindings;
  bindings.reserve(impl_->native_vst_attachments.size());
  for (auto& [instance_id, attachment] : impl_->native_vst_attachments) {
    static_cast<void>(instance_id);
    if (!attachment->metadata.playback_enabled) continue;
    if (attachment->metadata.transport.maximum_frames < impl_->config.max_frames_per_block) {
      daw_audio_core_destroy(prepared_core);
      impl_->prepared_asset_handles.clear();
      return status(GraphRevisionStatusCode::kPrepareFailed);
    }
    bindings.push_back({
      .node_id = attachment->metadata.graph_node_id,
      .output_layout = attachment->metadata.output_layout,
      .pdc_latency_frames = attachment->metadata.declared_latency_frames + attachment->metadata.transport_latency_frames,
      .attachment = attachment.get(),
    });
  }
  if ((!bindings.empty() && daw::audio_core::RegisterNativeGraphHook(
    prepared_core, {.graph_revision = revision, .hook = DispatchNativeVstGraphHook, .bindings = bindings}
  ) != DAW_AUDIO_CORE_OK) || daw_audio_core_publish(prepared_core, revision) != DAW_AUDIO_CORE_OK) {
    daw_audio_core_destroy(prepared_core);
    impl_->prepared_asset_handles.clear();
    return status(GraphRevisionStatusCode::kPrepareFailed);
  }
  impl_->prepared_core = prepared_core;
  impl_->prepared_revision.store(revision, std::memory_order_release);
  return status(GraphRevisionStatusCode::kPrepared);
}

GraphRevisionStatus AudioHost::PublishGraphRevision(const std::uint32_t revision) {
  const auto status = [this, revision](const GraphRevisionStatusCode code) {
    return GraphRevisionStatus{
      .code = code,
      .requested_revision = revision,
      .active_revision = impl_->active_revision.load(std::memory_order_acquire),
      .prepared_revision = impl_->prepared_revision.load(std::memory_order_acquire),
      .retired_revision = impl_->retired_revision.load(std::memory_order_acquire),
      .render_epoch = impl_->completed_render_epoch.load(std::memory_order_acquire),
    };
  };
  if (revision == 0 || impl_->prepared_core == 0
    || impl_->prepared_revision.load(std::memory_order_acquire) != revision) {
    return status(GraphRevisionStatusCode::kStaleRevision);
  }
  const auto publish_at_boundary = [this, revision] {
    const daw_audio_core_handle previous_core = impl_->active_core.exchange(impl_->prepared_core, std::memory_order_acq_rel);
    const std::uint32_t previous_revision = impl_->active_revision.exchange(revision, std::memory_order_acq_rel);
    impl_->prepared_core = 0;
    impl_->prepared_revision.store(0, std::memory_order_release);
    impl_->retired_core = previous_core;
    impl_->retired_revision.store(previous_revision, std::memory_order_release);
    impl_->retired_after_epoch.store(impl_->completed_render_epoch.load(std::memory_order_acquire), std::memory_order_release);
    impl_->last_graph_revision.store(revision, std::memory_order_release);
    impl_->graph_prepared = true;
    impl_->native_graph_revision_required = false;
  };
  const auto publish_asset_handles = [this] {
    for (const auto& [asset_id, handle] : impl_->prepared_asset_handles) {
      const auto asset = impl_->assets.find(asset_id);
      if (asset != impl_->assets.end()) asset->second.handle = handle;
    }
    impl_->prepared_asset_handles.clear();
  };
  if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kRunning) {
    const bool replacing_graph = impl_->graph_prepared;
    publish_at_boundary();
    publish_asset_handles();
    if (!replacing_graph) {
      daw_audio_core_destroy(impl_->retired_core);
      impl_->retired_core = 0;
      impl_->retired_revision.store(0, std::memory_order_release);
    }
    return status(GraphRevisionStatusCode::kPublished);
  }
  impl_->publish_acknowledged_revision.store(0, std::memory_order_release);
  impl_->publish_requested_revision.store(revision, std::memory_order_release);
  std::unique_lock lock(impl_->publish_wait_mutex);
  if (!impl_->publish_wait.wait_for(lock, std::chrono::seconds(1), [this, revision] {
    return impl_->publish_acknowledged_revision.load(std::memory_order_acquire) == revision;
  })) {
    std::uint32_t expected = revision;
    if (impl_->publish_requested_revision.compare_exchange_strong(
      expected,
      0,
      std::memory_order_acq_rel,
      std::memory_order_acquire
    )) {
      return status(GraphRevisionStatusCode::kPublishFailed);
    }
    impl_->publish_wait.wait(lock, [this, revision] {
      return impl_->publish_acknowledged_revision.load(std::memory_order_acquire) == revision;
    });
  }
  if (impl_->publish_acknowledged_revision.load(std::memory_order_acquire) != revision) {
    return status(GraphRevisionStatusCode::kPublishFailed);
  }
  publish_asset_handles();
  impl_->graph_prepared = true;
  impl_->native_graph_revision_required = false;
  return status(GraphRevisionStatusCode::kPublished);
}

GraphRevisionStatus AudioHost::RollbackGraphRevision(const std::uint32_t revision) {
  const auto code = revision != 0 && impl_->prepared_core != 0
    && impl_->prepared_revision.load(std::memory_order_acquire) == revision
    ? GraphRevisionStatusCode::kRolledBack
    : GraphRevisionStatusCode::kStaleRevision;
  if (code == GraphRevisionStatusCode::kRolledBack) {
    daw_audio_core_destroy(impl_->prepared_core);
    impl_->prepared_core = 0;
    impl_->prepared_revision.store(0, std::memory_order_release);
    impl_->prepared_asset_handles.clear();
  }
  return {
    .code = code,
    .requested_revision = revision,
    .active_revision = impl_->active_revision.load(std::memory_order_acquire),
    .prepared_revision = impl_->prepared_revision.load(std::memory_order_acquire),
    .retired_revision = impl_->retired_revision.load(std::memory_order_acquire),
    .render_epoch = impl_->completed_render_epoch.load(std::memory_order_acquire),
  };
}

GraphRevisionStatus AudioHost::RetireGraphRevision(const std::uint32_t revision) {
  GraphRevisionStatusCode code = GraphRevisionStatusCode::kStaleRevision;
  if (revision != 0 && impl_->retired_core != 0
    && impl_->retired_revision.load(std::memory_order_acquire) == revision) {
    if (impl_->completed_render_epoch.load(std::memory_order_acquire)
      < impl_->retired_after_epoch.load(std::memory_order_acquire)) {
      code = GraphRevisionStatusCode::kRetirementNotSafe;
    } else {
      daw_audio_core_destroy(impl_->retired_core);
      impl_->retired_core = 0;
      impl_->retired_revision.store(0, std::memory_order_release);
      code = GraphRevisionStatusCode::kRetired;
    }
  }
  return {
    .code = code,
    .requested_revision = revision,
    .active_revision = impl_->active_revision.load(std::memory_order_acquire),
    .prepared_revision = impl_->prepared_revision.load(std::memory_order_acquire),
    .retired_revision = impl_->retired_revision.load(std::memory_order_acquire),
    .render_epoch = impl_->completed_render_epoch.load(std::memory_order_acquire),
  };
}

bool AudioHost::QueueParameterEvents(const std::span<const std::uint8_t> payload) {
  if (impl_->prepared_core != 0 || payload.size() < 4) return false;
  const std::uint32_t count = ReadLeU32(payload.data());
  if (count > DAW_AUDIO_CORE_MAX_PROCESSOR_EVENTS || payload.size() != 4 + static_cast<std::size_t>(count) * 20) return false;
  const std::uint32_t write = impl_->control_queue_write.load(std::memory_order_relaxed);
  const std::uint32_t read = impl_->control_queue_read.load(std::memory_order_acquire);
  if (count > Impl::kControlQueueCapacity - (write - read)) return false;
  for (std::uint32_t index = 0; index < count; ++index) {
    const auto* bytes = payload.data() + 4 + index * 20;
    Impl::QueuedControlEvent event{};
    event.kind = Impl::QueuedControlKind::kProcessor;
    event.processor = {.processor_instance_id = ReadLeU64(bytes), .parameter_target = ReadLeU32(bytes + 8),
      .frame_offset = ReadLeU32(bytes + 12), .value = ReadLeFloat(bytes + 16)};
    if (!impl_->EnqueueControlEvent(event)) return false;
  }
  return true;
}

bool AudioHost::QueueInstrumentEvents(const std::span<const std::uint8_t> payload) {
  if (impl_->prepared_core != 0 || payload.size() < 4) return false;
  const std::uint32_t count = ReadLeU32(payload.data());
  if (count > DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS || payload.size() != 4 + static_cast<std::size_t>(count) * 48) return false;
  const std::uint32_t write = impl_->control_queue_write.load(std::memory_order_relaxed);
  const std::uint32_t read = impl_->control_queue_read.load(std::memory_order_acquire);
  if (count > Impl::kControlQueueCapacity - (write - read)) return false;
  for (std::uint32_t index = 0; index < count; ++index) {
    const auto* bytes = payload.data() + 4 + index * 48;
    Impl::QueuedControlEvent event{};
    event.kind = Impl::QueuedControlKind::kInstrument;
    event.instrument = {.node_id = ReadLeU64(bytes), .note_id = ReadLeU64(bytes + 8), .sequence = ReadLeU64(bytes + 16),
      .epoch = ReadLeU32(bytes + 24), .frame_offset = ReadLeU32(bytes + 28), .type = ReadLeU32(bytes + 32),
      .channel = ReadLeU32(bytes + 36), .note = ReadLeU32(bytes + 40), .value = ReadLeFloat(bytes + 44)};
    if (!impl_->EnqueueControlEvent(event)) return false;
  }
  return true;
}

bool AudioHost::QueueSourceEvents(const std::span<const std::uint8_t> payload) {
  if (impl_->prepared_core != 0 || payload.size() < 4) return false;
  const std::uint32_t count = ReadLeU32(payload.data());
  if (count > DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS || payload.size() != 4 + static_cast<std::size_t>(count) * 92) return false;
  const std::uint32_t write = impl_->control_queue_write.load(std::memory_order_relaxed);
  const std::uint32_t read = impl_->control_queue_read.load(std::memory_order_acquire);
  if (count > Impl::kControlQueueCapacity - (write - read)) return false;
  for (std::uint32_t index = 0; index < count; ++index) {
    const auto* bytes = payload.data() + 4 + index * 92;
    if (!impl_->assets.contains(ReadLeU32(bytes + 20))) return false;
  }
  for (std::uint32_t index = 0; index < count; ++index) {
    const auto* bytes = payload.data() + 4 + index * 92;
    const auto asset = impl_->assets.find(ReadLeU32(bytes + 20));
    Impl::QueuedControlEvent event{};
    event.kind = Impl::QueuedControlKind::kSource;
    event.source = {.abi_version = DAW_AUDIO_CORE_ABI_VERSION, .epoch = ReadLeU32(bytes), .sequence = ReadLeU64(bytes + 4),
      .source_node_id = ReadLeU64(bytes + 12), .asset = asset->second.handle, .start_frame = static_cast<std::int64_t>(ReadLeU64(bytes + 24)),
      .stop_frame = static_cast<std::int64_t>(ReadLeU64(bytes + 32)), .source_offset_frame = ReadLeU64(bytes + 40),
      .source_frame_count = ReadLeU64(bytes + 48), .gain = ReadLeFloat(bytes + 56),
      .fade_in_start_frame = static_cast<std::int64_t>(ReadLeU64(bytes + 60)), .fade_in_end_frame = static_cast<std::int64_t>(ReadLeU64(bytes + 68)),
      .fade_out_start_frame = static_cast<std::int64_t>(ReadLeU64(bytes + 76)), .fade_out_end_frame = static_cast<std::int64_t>(ReadLeU64(bytes + 84))};
    if (!impl_->EnqueueControlEvent(event)) return false;
  }
  return true;
}

bool AudioHost::QueueNativeVstParameterEvents(const std::span<const std::uint8_t> payload) {
  std::size_t offset = 0;
  std::string instance_id;
  if (!ReadNativeInstanceId(payload, offset, instance_id) || offset + 4 > payload.size()) return false;
  const std::uint32_t count = ReadLeU32(payload.data() + offset);
  offset += 4;
  if (count > daw::plugin_host::kMaximumWorkerEvents || payload.size() != offset + static_cast<std::size_t>(count) * 16) return false;
  const auto attachment = impl_->native_vst_attachments.find(instance_id);
  if (attachment == impl_->native_vst_attachments.end() || !attachment->second->metadata.playback_enabled
    || count > attachment->second->metadata.transport.maximum_events_per_block) return false;
  std::array<daw::plugin_host::WorkerTransportEvent, daw::plugin_host::kMaximumWorkerEvents> events{};
  for (std::uint32_t index = 0; index < count; ++index) {
    const auto* bytes = payload.data() + offset + index * 16;
    const double value = ReadLeDouble(bytes + 8);
    if (ReadLeU32(bytes + 4) >= attachment->second->metadata.transport.maximum_frames
      || !std::isfinite(value) || value < 0.0 || value > 1.0) return false;
    events[index] = {.kind = daw::plugin_host::WorkerEventKind::kParameter, .sampleOffset = ReadLeU32(bytes + 4),
      .parameterId = ReadLeU32(bytes), .parameterValue = value};
  }
  return attachment->second->QueueEvents(std::span<const daw::plugin_host::WorkerTransportEvent>(events.data(), count));
}

bool AudioHost::QueueNativeVstMidiEvents(const std::span<const std::uint8_t> payload) {
  std::size_t offset = 0;
  std::string instance_id;
  if (!ReadNativeInstanceId(payload, offset, instance_id) || offset + 4 > payload.size()) return false;
  const std::uint32_t count = ReadLeU32(payload.data() + offset);
  offset += 4;
  if (count > daw::plugin_host::kMaximumWorkerEvents || payload.size() != offset + static_cast<std::size_t>(count) * 8) return false;
  const auto attachment = impl_->native_vst_attachments.find(instance_id);
  if (attachment == impl_->native_vst_attachments.end() || !attachment->second->metadata.playback_enabled
    || count > attachment->second->metadata.transport.maximum_events_per_block) return false;
  std::array<daw::plugin_host::WorkerTransportEvent, daw::plugin_host::kMaximumWorkerEvents> events{};
  for (std::uint32_t index = 0; index < count; ++index) {
    const auto* bytes = payload.data() + offset + index * 8;
    if (ReadLeU32(bytes) >= attachment->second->metadata.transport.maximum_frames || bytes[7] != 0) return false;
    events[index] = {.kind = daw::plugin_host::WorkerEventKind::kMidi, .sampleOffset = ReadLeU32(bytes),
      .midiData = {bytes[4], bytes[5], bytes[6]}};
  }
  return attachment->second->QueueEvents(std::span<const daw::plugin_host::WorkerTransportEvent>(events.data(), count));
}

bool AudioHost::SetNativeVstState(const std::span<const std::uint8_t> payload) {
  std::size_t offset = 0;
  std::string instance_id;
  if (!ReadNativeInstanceId(payload, offset, instance_id) || offset + 8 > payload.size()) return false;
  const std::uint32_t bytes = ReadLeU32(payload.data() + offset);
  const std::uint32_t hash_bytes = ReadLeU32(payload.data() + offset + 4);
  offset += 8;
  if (bytes > daw::plugin_host::kMaximumWorkerStateBytes || hash_bytes != 64 || payload.size() != offset + bytes + hash_bytes) return false;
  const auto attachment = impl_->native_vst_attachments.find(instance_id);
  if (attachment == impl_->native_vst_attachments.end() || !attachment->second->metadata.playback_enabled) return false;
  daw::plugin_host::WorkerState state{
    .bytes = {payload.begin() + static_cast<std::ptrdiff_t>(offset), payload.begin() + static_cast<std::ptrdiff_t>(offset + bytes)},
    .sha256 = {reinterpret_cast<const char*>(payload.data() + offset + bytes), hash_bytes},
  };
  return daw::plugin_host::IsValidWorkerState(state) && attachment->second->worker.SetState(state);
}

std::optional<std::vector<std::uint8_t>> AudioHost::GetNativeVstState(const std::span<const std::uint8_t> payload) {
  std::size_t offset = 0;
  std::string instance_id;
  if (!ReadNativeInstanceId(payload, offset, instance_id) || offset != payload.size()) return std::nullopt;
  const auto attachment = impl_->native_vst_attachments.find(instance_id);
  if (attachment == impl_->native_vst_attachments.end() || !attachment->second->metadata.playback_enabled) return std::nullopt;
  const auto state = attachment->second->worker.GetState();
  if (!state) return std::nullopt;
  std::vector<std::uint8_t> result;
  result.reserve(4 + instance_id.size() + 8 + state->bytes.size() + state->sha256.size());
  const auto append_le = [&result](const std::uint32_t value) {
    result.push_back(static_cast<std::uint8_t>(value));
    result.push_back(static_cast<std::uint8_t>(value >> 8U));
    result.push_back(static_cast<std::uint8_t>(value >> 16U));
    result.push_back(static_cast<std::uint8_t>(value >> 24U));
  };
  append_le(static_cast<std::uint32_t>(instance_id.size()));
  result.insert(result.end(), instance_id.begin(), instance_id.end());
  append_le(static_cast<std::uint32_t>(state->bytes.size()));
  append_le(static_cast<std::uint32_t>(state->sha256.size()));
  result.insert(result.end(), state->bytes.begin(), state->bytes.end());
  result.insert(result.end(), state->sha256.begin(), state->sha256.end());
  return result;
}

void AudioHost::ProcessNativeVstControl() {
  bool restart = false;
  bool faulted = false;
  for (auto& [instance_id, attachment] : impl_->native_vst_attachments) {
    static_cast<void>(instance_id);
    while (const auto diagnostic = attachment->worker.ReadDiagnostic()) {
      if (diagnostic->kind == daw::plugin_host::WorkerDiagnosticKind::kLatency) {
        if (diagnostic->value != attachment->metadata.declared_latency_frames) {
          attachment->metadata.declared_latency_frames = diagnostic->value;
          impl_->native_graph_revision_required = true;
        }
      } else if (diagnostic->kind == daw::plugin_host::WorkerDiagnosticKind::kBuses) {
        impl_->native_graph_revision_required = true;
      } else if (diagnostic->kind == daw::plugin_host::WorkerDiagnosticKind::kRestart) {
        restart = true;
      } else if (diagnostic->kind == daw::plugin_host::WorkerDiagnosticKind::kFault) {
        faulted = true;
      }
    }
  }
  if ((faulted || impl_->native_graph_revision_required)
    && impl_->state.load(std::memory_order_acquire) == LifecycleState::kRunning) Stop();
  if (restart && impl_->state.load(std::memory_order_acquire) == LifecycleState::kRunning) {
    Stop();
    static_cast<void>(Start());
  }
}

bool AudioHost::InstallAsset(
  const std::uint32_t asset_id,
  const std::uint32_t frame_count,
  const std::uint32_t sample_rate_hz,
  const std::uint32_t channel_count,
  const std::uint64_t content_hash_prefix,
  const std::span<const float> samples
) {
  const daw_audio_core_handle active_core = impl_->active_core.load(std::memory_order_acquire);
  if (active_core == 0 || impl_->prepared_core != 0 || impl_->retired_core != 0
    || asset_id == 0 || frame_count == 0 || frame_count > kMaximumAssetFrames
    || sample_rate_hz == 0 || channel_count == 0 || channel_count > kMaximumAssetChannels
    || samples.size() != static_cast<std::size_t>(frame_count) * channel_count
    || impl_->assets.contains(asset_id) || impl_->assets.size() >= kMaximumInstalledAssets) return false;
  if (!std::all_of(samples.begin(), samples.end(), [](const float sample) { return std::isfinite(sample); })) return false;
  Impl::InstalledAsset asset{
    .samples = {samples.begin(), samples.end()},
    .frame_count = frame_count,
    .sample_rate_hz = sample_rate_hz,
    .channel_count = channel_count,
    .content_hash_prefix = content_hash_prefix,
  };
  for (std::uint32_t channel = 0; channel < channel_count; ++channel) {
    asset.planes[channel] = asset.samples.data() + static_cast<std::size_t>(channel) * frame_count;
  }
  const daw_audio_asset_descriptor descriptor{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .revision = impl_->active_revision.load(std::memory_order_acquire),
    .byte_length = static_cast<std::uint64_t>(samples.size_bytes()),
    .content_hash_prefix = content_hash_prefix,
    .frame_count = frame_count,
    .sample_rate_hz = sample_rate_hz,
    .channel_count = channel_count,
    .planes = asset.planes.data(),
  };
  if (daw_audio_core_create_asset(active_core, &descriptor, &asset.handle) != DAW_AUDIO_CORE_OK) return false;
  impl_->assets.emplace(asset_id, std::move(asset));
  return true;
}

bool AudioHost::ReleaseAsset(const std::uint32_t asset_id) {
  const auto asset = impl_->assets.find(asset_id);
  if (asset == impl_->assets.end()) return true;
  const daw_audio_core_handle active_core = impl_->active_core.load(std::memory_order_acquire);
  if (active_core == 0 || impl_->prepared_core != 0 || impl_->retired_core != 0 || impl_->HasQueuedControl()) return false;
  if (daw_audio_core_release_asset(active_core, asset->second.handle) != DAW_AUDIO_CORE_OK) return false;
  impl_->assets.erase(asset);
  return true;
}

bool AudioHost::SetTransport(const std::uint32_t epoch, const bool running, const std::int64_t frame) {
  const daw_audio_core_handle active_core = impl_->active_core.load(std::memory_order_acquire);
  if (active_core == 0 || impl_->prepared_core != 0 || frame < 0) return false;
  const daw_audio_transport_state state{.epoch = epoch, .running = running ? 1U : 0U, .frame = frame};
  if (daw_audio_core_set_transport(active_core, &state) != DAW_AUDIO_CORE_OK) return false;
  impl_->transport_epoch.store(epoch, std::memory_order_release);
  impl_->transport_frame.store(frame, std::memory_order_release);
  impl_->transport_running.store(running, std::memory_order_release);
  impl_->transport_prepared = true;
  return true;
}

bool AudioHost::ConfigureRecording(const RecordingConfig& config) {
  if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kRunning
    || config.generation == 0 || config.session_id == 0
    || config.channel_count == 0 || config.channel_count > DAW_AUDIO_RECORDING_CAPTURE_MAX_CHANNELS
    || !std::isfinite(config.gain) || config.gain < 0.0F
    || (config.polarity != 1 && config.polarity != -1)
    || config.device_uid.empty()
    || config.punch_start_frame < 0
    || (config.punch_end_frame != -1 && config.punch_end_frame < config.punch_start_frame)
    || impl_->recording_capture.load(std::memory_order_acquire) != 0) return false;
  std::uint32_t input_bus_channels = 0;
  for (std::uint32_t channel = 0; channel < config.channel_count; ++channel) {
    if (config.input_channels[channel] >= 64) return false;
    input_bus_channels = std::max(input_bus_channels, config.input_channels[channel] + 1);
  }
  const daw_audio_recording_capture_config capture_config{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .generation = config.generation,
    .session_id = config.session_id,
    .channel_count = config.channel_count,
    .input_channels = {config.input_channels[0], config.input_channels[1]},
    .gain = config.gain,
    .polarity = config.polarity,
    .punch_start_frame = config.punch_start_frame,
    .punch_end_frame = config.punch_end_frame,
  };
  daw_audio_core_handle capture = 0;
  if (daw_audio_recording_capture_create(&capture_config, &capture) != DAW_AUDIO_CORE_OK) return false;
  if (!StartCoreAudioInputDevice(
    config.device_uid,
    impl_->config.sample_rate_hz,
    input_bus_channels,
    this,
    &impl_->recording_device_session)) {
    daw_audio_recording_capture_destroy(capture);
    return false;
  }
  impl_->recording_channel_count.store(config.channel_count, std::memory_order_release);
  impl_->recording_device_lost.store(false, std::memory_order_release);
  impl_->recording_monitor_read.store(0, std::memory_order_release);
  impl_->recording_monitor_write.store(0, std::memory_order_release);
  impl_->recording_monitoring.store(config.monitoring, std::memory_order_release);
  impl_->recording_command.store(Impl::RecordingCommand::kNone, std::memory_order_release);
  impl_->recording_stop_frame.store(-1, std::memory_order_release);
  impl_->recording_started.store(false, std::memory_order_release);
  impl_->recording_input_frame.store(impl_->transport_frame.load(std::memory_order_acquire), std::memory_order_release);
  impl_->recording_punch_start_frame.store(config.punch_start_frame, std::memory_order_release);
  impl_->recording_capture.store(capture, std::memory_order_release);
  impl_->NotifyRecordingStatus();
  return true;
}

bool AudioHost::StartRecording() {
  if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kRunning
    || impl_->recording_capture.load(std::memory_order_acquire) == 0
    || impl_->recording_started.load(std::memory_order_acquire)) return false;
  const std::int64_t start_frame = impl_->transport_frame.load(std::memory_order_acquire);
  impl_->recording_input_frame.store(start_frame, std::memory_order_release);
  impl_->recording_timeline_start_frame.store(
    std::max(start_frame, impl_->recording_punch_start_frame.load(std::memory_order_acquire)),
    std::memory_order_release);
  impl_->recording_started.store(true, std::memory_order_release);
  impl_->NotifyRecordingStatus();
  return true;
}

bool AudioHost::StopRecording(const std::optional<std::int64_t> stop_frame) {
  if (!impl_->recording_started.load(std::memory_order_acquire)
    || (stop_frame && *stop_frame < 0)) return false;
  impl_->recording_stop_frame.store(stop_frame.value_or(-1), std::memory_order_release);
  impl_->recording_command.store(Impl::RecordingCommand::kStop, std::memory_order_release);
  impl_->NotifyRecordingStatus();
  return true;
}

bool AudioHost::CancelRecording() {
  const daw_audio_core_handle capture = impl_->recording_capture.load(std::memory_order_acquire);
  if (capture == 0) return true;
  if (!impl_->recording_started.load(std::memory_order_acquire)) {
    if (daw_audio_recording_capture_cancel(capture) != DAW_AUDIO_CORE_OK) return false;
    impl_->NotifyRecordingStatus();
    return true;
  }
  impl_->recording_command.store(Impl::RecordingCommand::kCancel, std::memory_order_release);
  impl_->NotifyRecordingStatus();
  return true;
}

void AudioHost::NotifyRecordingDeviceLost() {
  impl_->recording_device_lost.store(true, std::memory_order_release);
  impl_->NotifyRecordingStatus();
}

void AudioHost::NotifyOutputDeviceLost() {
  if (impl_->state.load(std::memory_order_acquire) == LifecycleState::kRunning) {
    impl_->state.store(LifecycleState::kFaulted, std::memory_order_release);
  }
}

std::optional<RecordingMessage> AudioHost::WaitForRecordingMessage(
  const std::uint64_t last_status_revision,
  const std::atomic<bool>* running) {
  bool queued_block_ready = false;
  const daw_audio_core_handle current_capture = impl_->recording_capture.load(std::memory_order_acquire);
  if (current_capture != 0) {
    daw_audio_recording_capture_diagnostics current_diagnostics{};
    queued_block_ready = daw_audio_recording_capture_get_diagnostics(current_capture, &current_diagnostics)
      == DAW_AUDIO_CORE_OK && current_diagnostics.queued_blocks > 0;
  }
  const auto wait_until_changed = [&] {
    return impl_->recording_status_revision.load(std::memory_order_acquire) != last_status_revision
      || (running != nullptr && !running->load(std::memory_order_acquire));
  };
  if (!queued_block_ready) {
    std::unique_lock lock(impl_->recording_wait_mutex);
    impl_->recording_wait.wait(lock, wait_until_changed);
  }
  if (running != nullptr && !running->load(std::memory_order_acquire)) return std::nullopt;
  const bool device_lost = impl_->recording_device_lost.load(std::memory_order_acquire);
  if (device_lost && impl_->recording_device_session != nullptr) {
    StopCoreAudioDevice(impl_->recording_device_session);
    impl_->recording_device_session = nullptr;
    const daw_audio_core_handle failed_capture = impl_->recording_capture.load(std::memory_order_acquire);
    if (failed_capture != 0) static_cast<void>(daw_audio_recording_capture_cancel(failed_capture));
    impl_->recording_started.store(false, std::memory_order_release);
  }
  const daw_audio_core_handle capture = impl_->recording_capture.load(std::memory_order_acquire);
  if (capture == 0) return std::nullopt;
  RecordingMessage message{};
  daw_audio_recording_capture_block block{};
  const daw_audio_core_result dequeue = daw_audio_recording_capture_dequeue(capture, &block);
  if (dequeue == DAW_AUDIO_CORE_OK) {
    RecordingBlock output{
      .generation = block.generation,
      .session_id = block.session_id,
      .sequence = block.sequence,
      .frame_count = block.frame_count,
      .channel_count = block.channel_count,
      .rms = block.rms,
      .peak = block.peak,
      .samples = std::vector<float>(static_cast<std::size_t>(block.frame_count) * block.channel_count),
    };
    for (std::uint32_t channel = 0; channel < block.channel_count; ++channel) {
      std::memcpy(
        output.samples.data() + static_cast<std::size_t>(channel) * block.frame_count,
        block.planes[channel],
        block.frame_count * sizeof(float));
    }
    if (daw_audio_recording_capture_release_block(capture, block.block_id) != DAW_AUDIO_CORE_OK) return std::nullopt;
    message.block = std::move(output);
  } else if (dequeue != DAW_AUDIO_CORE_NO_DATA) {
    return std::nullopt;
  }
  daw_audio_recording_capture_diagnostics diagnostics{};
  if (daw_audio_recording_capture_get_diagnostics(capture, &diagnostics) != DAW_AUDIO_CORE_OK) return std::nullopt;
  message.status = {
    .generation = diagnostics.generation,
    .session_id = diagnostics.session_id,
    .timeline_frame = impl_->recording_timeline_start_frame.load(std::memory_order_acquire),
    .captured_frames = diagnostics.captured_frames,
    .dropped_frames = diagnostics.dropped_frames,
    .dropped_blocks = diagnostics.dropped_blocks,
    .available_blocks = diagnostics.available_blocks,
    .queued_blocks = diagnostics.queued_blocks,
    .rms = diagnostics.rms,
    .peak = diagnostics.peak,
    .fatal = diagnostics.fatal != 0 || device_lost,
    .active = diagnostics.active != 0,
    .configured = true,
  };
  if (!message.status.active && message.status.queued_blocks == 0) {
    if (impl_->recording_device_session != nullptr) {
      StopCoreAudioDevice(impl_->recording_device_session);
      impl_->recording_device_session = nullptr;
    }
    const daw_audio_core_handle completed = impl_->recording_capture.exchange(0, std::memory_order_acq_rel);
    if (completed != 0) daw_audio_recording_capture_destroy(completed);
    impl_->recording_channel_count.store(0, std::memory_order_release);
    impl_->recording_monitoring.store(false, std::memory_order_release);
    impl_->recording_device_lost.store(false, std::memory_order_release);
  }
  return message;
}

void AudioHost::WakeRecordingWait() {
  impl_->recording_wait.notify_all();
}

std::optional<WorkerNotification> AudioHost::WaitForWorkerNotification(const std::atomic<bool>* running) {
  std::unique_lock lock(impl_->worker_notifications.mutex);
  impl_->worker_notifications.ready.wait(lock, [this, running] {
    return !impl_->worker_notifications.notifications.empty()
      || (running != nullptr && !running->load(std::memory_order_acquire));
  });
  if (impl_->worker_notifications.notifications.empty()) return std::nullopt;
  WorkerNotification notification = std::move(impl_->worker_notifications.notifications.front());
  impl_->worker_notifications.notifications.pop_front();
  return notification;
}

void AudioHost::WakeWorkerNotificationWait() {
  impl_->worker_notifications.ready.notify_all();
}

std::uint64_t AudioHost::recordingStatusRevision() const {
  return impl_->recording_status_revision.load(std::memory_order_acquire);
}

bool AudioHost::AttachNativeVst(const NativeVstAttachment& attachment) {
  if (impl_->graph_prepared || !ValidNativeVstAttachment(attachment) || impl_->native_vst_attachments.contains(attachment.instance_id)
    || impl_->native_vst_attachments.size() >= kMaximumNativeVstAttachments) return false;
  auto worker_attachment = std::make_unique<NativeVstWorkerAttachment>();
  worker_attachment->metadata = attachment;
  worker_attachment->notification_sink = &impl_->worker_notifications;
  impl_->native_vst_attachments.emplace(attachment.instance_id, std::move(worker_attachment));
  return true;
}

bool AudioHost::DetachVstReference(const std::string_view instance_id) {
  if (impl_->graph_prepared) return false;
  return impl_->native_vst_attachments.erase(std::string(instance_id)) == 1;
}

bool AudioHost::Start() {
  if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kConfigured || impl_->config.device_uid.empty()
    || !impl_->graph_prepared || !impl_->transport_prepared) return false;
  if (!impl_->StartNativeVstWorkers()) return false;
  if (!StartCoreAudioDevice(
    impl_->config.device_uid,
    impl_->config.sample_rate_hz,
    impl_->config.channel_count,
    this,
    &impl_->device_session)) {
    impl_->StopNativeVstWorkers();
    return false;
  }
  impl_->state.store(LifecycleState::kRunning, std::memory_order_release);
  return true;
}

bool AudioHost::StartDiagnosticMode() {
  if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kConfigured) return false;
  if (!impl_->StartNativeVstWorkers()) return false;
  impl_->state.store(LifecycleState::kRunning, std::memory_order_release);
  return true;
}

void AudioHost::Stop() {
  const LifecycleState state = impl_->state.load(std::memory_order_acquire);
  if (state != LifecycleState::kRunning && state != LifecycleState::kFaulted) return;
  if (impl_->device_session != nullptr) {
    StopCoreAudioDevice(impl_->device_session);
    impl_->device_session = nullptr;
  }
  if (impl_->recording_device_session != nullptr) {
    StopCoreAudioDevice(impl_->recording_device_session);
    impl_->recording_device_session = nullptr;
  }
  const daw_audio_core_handle capture = impl_->recording_capture.exchange(0, std::memory_order_acq_rel);
  if (capture != 0) {
    static_cast<void>(daw_audio_recording_capture_cancel(capture));
    daw_audio_recording_capture_destroy(capture);
    impl_->recording_started.store(false, std::memory_order_release);
    impl_->recording_channel_count.store(0, std::memory_order_release);
    impl_->recording_monitoring.store(false, std::memory_order_release);
    impl_->recording_command.store(Impl::RecordingCommand::kNone, std::memory_order_release);
    impl_->recording_device_lost.store(false, std::memory_order_release);
  }
  impl_->StopNativeVstWorkers();
  impl_->state.store(LifecycleState::kConfigured, std::memory_order_release);
  impl_->publish_requested_revision.store(0, std::memory_order_release);
  impl_->publish_wait.notify_all();
}

void AudioHost::Teardown() {
  Stop();
  const daw_audio_core_handle active_core = impl_->active_core.exchange(0, std::memory_order_acq_rel);
  if (active_core == 0 && impl_->prepared_core == 0 && impl_->retired_core == 0) return;
  if (active_core != 0) daw_audio_core_destroy(active_core);
  if (impl_->prepared_core != 0) daw_audio_core_destroy(impl_->prepared_core);
  if (impl_->retired_core != 0) daw_audio_core_destroy(impl_->retired_core);
  impl_->prepared_core = 0;
  impl_->retired_core = 0;
  impl_->assets.clear();
  impl_->prepared_asset_handles.clear();
  impl_->native_vst_attachments.clear();
  impl_->active_revision.store(0, std::memory_order_release);
  impl_->prepared_revision.store(0, std::memory_order_release);
  impl_->retired_revision.store(0, std::memory_order_release);
  impl_->transport_epoch.store(0, std::memory_order_release);
  impl_->transport_frame.store(0, std::memory_order_release);
  impl_->transport_running.store(false, std::memory_order_release);
  impl_->graph_prepared = false;
  impl_->transport_prepared = false;
  impl_->state.store(LifecycleState::kIdle, std::memory_order_release);
}

bool AudioHost::Retire(std::uint32_t revision) {
  if (impl_->state.load(std::memory_order_acquire) == LifecycleState::kRunning
    || impl_->prepared_core != 0 || impl_->retired_core != 0
    || revision != impl_->active_revision.load(std::memory_order_acquire)) return false;
  const daw_audio_core_handle active_core = impl_->active_core.exchange(0, std::memory_order_acq_rel);
  if (active_core == 0) return false;
  daw_audio_core_destroy(active_core);
  impl_->active_revision.store(0, std::memory_order_release);
  impl_->state.store(LifecycleState::kIdle, std::memory_order_release);
  return true;
}

// DAW_REALTIME_CALLBACK_REGION_BEGIN audio-host
bool AudioHost::ProcessPlanar(
  std::span<const float* const> input,
  std::span<float* const> output,
  std::uint32_t frame_count) {
  if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kRunning
    || impl_->active_core.load(std::memory_order_acquire) == 0
    || input.size() < impl_->config.channel_count
    || output.size() < impl_->config.channel_count) {
    impl_->rejected_blocks.fetch_add(1, std::memory_order_relaxed);
    return false;
  }
  for (std::uint32_t channel = 0; channel < impl_->config.channel_count; ++channel) {
    if (input[channel] == nullptr || output[channel] == nullptr) {
      impl_->rejected_blocks.fetch_add(1, std::memory_order_relaxed);
      return false;
    }
  }
  if (impl_->worker_notifications.mute_requested.load(std::memory_order_acquire)) {
    for (std::uint32_t channel = 0; channel < impl_->config.channel_count; ++channel) {
      std::fill_n(output[channel], frame_count, 0.0F);
    }
    impl_->callbacks.fetch_add(1, std::memory_order_relaxed);
    return true;
  }
  const float* const* inputs = input.data();
  float* const* outputs = output.data();
  std::uint32_t offset = 0;
  while (offset < frame_count) {
    const std::uint32_t requested_revision = impl_->publish_requested_revision.exchange(0, std::memory_order_acq_rel);
    if (requested_revision != 0
      && impl_->prepared_core != 0
      && impl_->prepared_revision.load(std::memory_order_acquire) == requested_revision) {
      const daw_audio_core_handle previous_core = impl_->active_core.exchange(impl_->prepared_core, std::memory_order_acq_rel);
      const std::uint32_t previous_revision = impl_->active_revision.exchange(requested_revision, std::memory_order_acq_rel);
      impl_->prepared_core = 0;
      impl_->prepared_revision.store(0, std::memory_order_release);
      impl_->retired_core = previous_core;
      impl_->retired_revision.store(previous_revision, std::memory_order_release);
      impl_->retired_after_epoch.store(
        impl_->completed_render_epoch.load(std::memory_order_acquire),
        std::memory_order_release
      );
      impl_->last_graph_revision.store(requested_revision, std::memory_order_release);
      impl_->publish_acknowledged_revision.store(requested_revision, std::memory_order_release);
      impl_->SignalRealtimeBridge(Impl::kRealtimePublishAcknowledged);
    }
    const daw_audio_core_handle active_core = impl_->active_core.load(std::memory_order_acquire);
    const std::uint32_t maximum_frames = std::min(
      impl_->config.max_frames_per_block,
      static_cast<std::uint32_t>(DAW_AUDIO_RECORDING_CAPTURE_BLOCK_FRAMES));
    const std::uint32_t frames = frame_count - offset > maximum_frames
      ? maximum_frames
      : frame_count - offset;
    std::array<const float*, 64> input_slice{};
    std::array<float*, 64> output_slice{};
    if (impl_->config.channel_count > input_slice.size()) {
      impl_->rejected_blocks.fetch_add(1, std::memory_order_relaxed);
      return false;
    }
    for (std::uint32_t channel = 0; channel < impl_->config.channel_count; ++channel) {
      input_slice[channel] = inputs[channel] + offset;
      output_slice[channel] = outputs[channel] + offset;
    }
    std::array<daw_audio_processor_event, DAW_AUDIO_CORE_MAX_PROCESSOR_EVENTS> processor_events{};
    std::array<daw_audio_instrument_event, DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS> instrument_events{};
    std::uint32_t processor_event_count = 0;
    std::uint32_t instrument_event_count = 0;
    const std::uint32_t write = impl_->control_queue_write.load(std::memory_order_acquire);
    std::uint32_t read = impl_->control_queue_read.load(std::memory_order_relaxed);
    while (read != write) {
      const auto& event = impl_->control_queue[read % Impl::kControlQueueCapacity];
      if (event.kind == Impl::QueuedControlKind::kProcessor) {
        processor_events[processor_event_count++] = event.processor;
      } else if (event.kind == Impl::QueuedControlKind::kInstrument) {
        instrument_events[instrument_event_count++] = event.instrument;
      } else if (daw_audio_core_schedule_sample_source(active_core, &event.source) != DAW_AUDIO_CORE_OK) {
        impl_->rejected_blocks.fetch_add(1, std::memory_order_relaxed);
        return false;
      }
      ++read;
    }
    impl_->control_queue_read.store(read, std::memory_order_release);
    const daw_audio_core_process_block block{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
      .frame_count = frames,
      .channel_count = impl_->config.channel_count,
      .input_bus_count = 1,
      .inputs = input_slice.data(),
      .outputs = output_slice.data(),
      .graph_revision = impl_->active_revision.load(std::memory_order_acquire),
      .parameter_block_count = 0,
      .parameter_blocks = nullptr,
      .event_count = processor_event_count,
      .events = processor_event_count == 0 ? nullptr : processor_events.data(),
      .transport_epoch = impl_->transport_epoch.load(std::memory_order_acquire),
      .instrument_event_count = instrument_event_count,
      .instrument_events = instrument_event_count == 0 ? nullptr : instrument_events.data(),
    };
    if (daw_audio_core_process(active_core, &block) != DAW_AUDIO_CORE_OK) {
      impl_->rejected_blocks.fetch_add(1, std::memory_order_relaxed);
      return false;
    }
    if (impl_->recording_monitoring.load(std::memory_order_acquire)) {
      const std::uint64_t read = impl_->recording_monitor_read.load(std::memory_order_relaxed);
      const std::uint64_t write = impl_->recording_monitor_write.load(std::memory_order_acquire);
      const std::uint32_t monitored_frames = std::min<std::uint64_t>(frames, write - read);
      const std::uint32_t recording_channels = impl_->recording_channel_count.load(std::memory_order_acquire);
      for (std::uint32_t channel = 0; channel < impl_->config.channel_count && recording_channels > 0; ++channel) {
        const std::uint32_t monitor_channel = std::min(channel, recording_channels - 1);
        for (std::uint32_t frame = 0; frame < monitored_frames; ++frame) {
          output_slice[channel][frame] +=
            impl_->recording_monitor_ring[monitor_channel][(read + frame) % Impl::kRecordingMonitorCapacity];
        }
      }
      impl_->recording_monitor_read.store(read + monitored_frames, std::memory_order_release);
    }
    impl_->transport_frame.fetch_add(frames, std::memory_order_release);
    impl_->completed_render_epoch.fetch_add(1, std::memory_order_release);
    if (offset != 0) impl_->split_blocks.fetch_add(1, std::memory_order_relaxed);
    offset += frames;
  }
  impl_->callbacks.fetch_add(1, std::memory_order_relaxed);
  return true;
}

bool AudioHost::ProcessRecordingPlanar(
  const std::span<const float* const> input,
  const std::uint32_t frame_count) {
  const daw_audio_core_handle capture = impl_->recording_capture.load(std::memory_order_acquire);
  if (capture == 0 || input.empty() || input.size() > 64 || frame_count == 0) return false;
  for (const float* plane : input) {
    if (plane == nullptr) return false;
  }
  std::uint32_t offset = 0;
  while (offset < frame_count) {
    const std::uint32_t frames = std::min(
      frame_count - offset,
      static_cast<std::uint32_t>(DAW_AUDIO_RECORDING_CAPTURE_BLOCK_FRAMES));
    std::array<const float*, 64> input_slice{};
    for (std::size_t channel = 0; channel < input.size(); ++channel) input_slice[channel] = input[channel] + offset;
    const std::int64_t block_start_frame = impl_->recording_input_frame.load(std::memory_order_acquire);
    bool recording_status_changed = impl_->ApplyRecordingCommand(block_start_frame);
    if (impl_->recording_started.load(std::memory_order_acquire)) {
      const std::uint32_t recording_channels = impl_->recording_channel_count.load(std::memory_order_acquire);
      const bool monitoring = impl_->recording_monitoring.load(std::memory_order_acquire);
      for (std::uint32_t channel = 0; channel < recording_channels; ++channel) {
        impl_->recording_monitor_planes[channel] = impl_->recording_monitor[channel].data();
      }
      const daw_audio_core_result result = monitoring
        ? daw_audio_recording_capture_process_monitor(
          capture,
          input_slice.data(),
          static_cast<std::uint32_t>(input.size()),
          impl_->recording_monitor_planes.data(),
          recording_channels,
          frames,
          block_start_frame)
        : daw_audio_recording_capture_process(
          capture,
          input_slice.data(),
          static_cast<std::uint32_t>(input.size()),
          frames,
          block_start_frame);
      if (result == DAW_AUDIO_CORE_CAPACITY_EXCEEDED) {
        impl_->recording_started.store(false, std::memory_order_release);
      } else if (result != DAW_AUDIO_CORE_OK) {
        return false;
      }
      recording_status_changed = true;
      if (monitoring) {
        const std::uint64_t write = impl_->recording_monitor_write.load(std::memory_order_relaxed);
        const std::uint64_t read = impl_->recording_monitor_read.load(std::memory_order_acquire);
        if (write - read + frames <= Impl::kRecordingMonitorCapacity) {
          for (std::uint32_t channel = 0; channel < recording_channels; ++channel) {
            for (std::uint32_t frame = 0; frame < frames; ++frame) {
              impl_->recording_monitor_ring[channel][(write + frame) % Impl::kRecordingMonitorCapacity]
                = impl_->recording_monitor[channel][frame];
            }
          }
          impl_->recording_monitor_write.store(write + frames, std::memory_order_release);
        }
      }
    }
    if (recording_status_changed) impl_->SignalRealtimeBridge(Impl::kRealtimeRecordingStatus);
    impl_->recording_input_frame.fetch_add(frames, std::memory_order_release);
    offset += frames;
  }
  return true;
}
// DAW_REALTIME_CALLBACK_REGION_END audio-host

Diagnostics AudioHost::diagnostics() const {
  return {
    .state = impl_->state.load(std::memory_order_acquire),
    .callbacks = impl_->callbacks.load(std::memory_order_relaxed),
    .split_blocks = impl_->split_blocks.load(std::memory_order_relaxed),
    .rejected_blocks = impl_->rejected_blocks.load(std::memory_order_relaxed),
    .active_revision = impl_->active_revision.load(std::memory_order_acquire),
    .prepared_revision = impl_->prepared_revision.load(std::memory_order_acquire),
    .retired_revision = impl_->retired_revision.load(std::memory_order_acquire),
    .transport_epoch = impl_->transport_epoch.load(std::memory_order_acquire),
    .render_epoch = impl_->completed_render_epoch.load(std::memory_order_acquire),
    .installed_assets = static_cast<std::uint32_t>(impl_->assets.size()),
  };
}

DeviceReadinessReason AudioHost::readinessReason() const {
  if (impl_->state.load(std::memory_order_acquire) == LifecycleState::kIdle
    || impl_->config.device_uid.empty()) return DeviceReadinessReason::kDeviceNotConfigured;
  if (!impl_->graph_prepared) return DeviceReadinessReason::kGraphNotPrepared;
  if (!impl_->transport_prepared) return DeviceReadinessReason::kTransportNotPrepared;
  return DeviceReadinessReason::kReady;
}

}  // namespace daw::audio_host_macos
