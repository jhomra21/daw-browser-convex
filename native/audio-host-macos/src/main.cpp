#include "daw/audio_host_macos.h"
#include "processor_contract_generated.h"

#include <array>
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <limits>
#include <memory>
#include <mutex>
#include <sys/resource.h>
#include <thread>
#include <vector>

namespace {

constexpr std::uint32_t kCapabilities = 0x000001ffU;

bool ReadExact(std::istream& input, std::uint8_t* bytes, const std::size_t size) {
  input.read(reinterpret_cast<char*>(bytes), static_cast<std::streamsize>(size));
  return input.gcount() == static_cast<std::streamsize>(size);
}

std::uint32_t ReadU32(const std::uint8_t* bytes) {
  return (static_cast<std::uint32_t>(bytes[0]) << 24U) | (static_cast<std::uint32_t>(bytes[1]) << 16U)
    | (static_cast<std::uint32_t>(bytes[2]) << 8U) | static_cast<std::uint32_t>(bytes[3]);
}

std::int64_t ReadI64(const std::uint8_t* bytes) {
  std::uint64_t value = 0;
  for (std::size_t index = 0; index < 8; ++index) value = (value << 8U) | bytes[index];
  return static_cast<std::int64_t>(value);
}

std::uint64_t ReadU64(const std::uint8_t* bytes) {
  std::uint64_t value = 0;
  for (std::size_t index = 0; index < 8; ++index) value = (value << 8U) | bytes[index];
  return value;
}

void WriteU32(std::vector<std::uint8_t>& payload, const std::uint32_t value) {
  payload.push_back(static_cast<std::uint8_t>(value >> 24U));
  payload.push_back(static_cast<std::uint8_t>(value >> 16U));
  payload.push_back(static_cast<std::uint8_t>(value >> 8U));
  payload.push_back(static_cast<std::uint8_t>(value));
}

void WriteString(std::vector<std::uint8_t>& payload, const std::string_view value) {
  WriteU32(payload, static_cast<std::uint32_t>(value.size()));
  payload.insert(payload.end(), value.begin(), value.end());
}

void WriteU64(std::vector<std::uint8_t>& payload, const std::uint64_t value) {
  for (int index = 7; index >= 0; --index) {
    payload.push_back(static_cast<std::uint8_t>(value >> (index * 8)));
  }
}

bool WriteFrame(const daw::audio_host_macos::ControlType type, const std::span<const std::uint8_t> payload) {
  static std::mutex output_mutex;
  const auto response = daw::audio_host_macos::EncodeControlFrame(type, payload);
  if (response.empty()) return false;
  const std::lock_guard lock(output_mutex);
  std::cout.write(reinterpret_cast<const char*>(response.data()), static_cast<std::streamsize>(response.size()));
  std::cout.flush();
  return std::cout.good();
}

bool WriteAck(const daw::audio_host_macos::ControlType request, const bool success) {
  std::vector<std::uint8_t> payload;
  payload.reserve(8);
  WriteU32(payload, static_cast<std::uint32_t>(request));
  WriteU32(payload, success ? 1U : 0U);
  return WriteFrame(daw::audio_host_macos::ControlType::kAck, payload);
}

bool WriteGraphRevisionStatus(const daw::audio_host_macos::GraphRevisionStatus& status) {
  std::vector<std::uint8_t> payload;
  payload.reserve(28);
  WriteU32(payload, static_cast<std::uint32_t>(status.code));
  WriteU32(payload, status.requested_revision);
  WriteU32(payload, status.active_revision);
  WriteU32(payload, status.prepared_revision);
  WriteU32(payload, status.retired_revision);
  WriteU64(payload, status.render_epoch);
  return WriteFrame(daw::audio_host_macos::ControlType::kGraphRevisionStatus, payload);
}

bool WriteWorkerNotification(const daw::audio_host_macos::WorkerNotification& notification) {
  if (notification.instance_id.empty() || notification.instance_id.size() > 256) return false;
  std::vector<std::uint8_t> payload;
  payload.reserve(24 + notification.instance_id.size());
  WriteU32(payload, static_cast<std::uint32_t>(notification.kind));
  WriteU32(payload, notification.graph_revision);
  WriteU64(payload, notification.graph_node_id);
  WriteU32(payload, notification.value);
  WriteString(payload, notification.instance_id);
  return WriteFrame(daw::audio_host_macos::ControlType::kNotification, payload);
}

void WriteFloat(std::vector<std::uint8_t>& payload, const float value) {
  std::uint32_t bits = 0;
  std::memcpy(&bits, &value, sizeof(bits));
  WriteU32(payload, bits);
}

float ReadFloat(const std::uint8_t* bytes) {
  const std::uint32_t bits = ReadU32(bytes);
  float value = 0.0F;
  std::memcpy(&value, &bits, sizeof(value));
  return value;
}

bool WriteRecordingStatus(const daw::audio_host_macos::RecordingStatus& status) {
  std::vector<std::uint8_t> payload;
  payload.reserve(64);
  WriteU32(payload, status.generation);
  WriteU64(payload, status.session_id);
  WriteU64(payload, static_cast<std::uint64_t>(status.timeline_frame));
  WriteU64(payload, status.captured_frames);
  WriteU64(payload, status.dropped_frames);
  WriteU32(payload, status.dropped_blocks);
  WriteU32(payload, status.available_blocks);
  WriteU32(payload, status.queued_blocks);
  WriteFloat(payload, status.rms);
  WriteFloat(payload, status.peak);
  WriteU32(payload, (status.fatal ? 1U : 0U) | (status.active ? 2U : 0U) | (status.configured ? 4U : 0U));
  return WriteFrame(daw::audio_host_macos::ControlType::kRecordingStatus, payload);
}

bool WriteRecordingBlock(const daw::audio_host_macos::RecordingBlock& block) {
  const std::size_t sample_bytes = block.samples.size() * sizeof(float);
  if (sample_bytes > daw::audio_host_macos::kMaximumControlPayloadBytes - 32) return false;
  std::vector<std::uint8_t> payload;
  payload.reserve(32 + sample_bytes);
  WriteU32(payload, block.generation);
  WriteU64(payload, block.session_id);
  WriteU32(payload, block.sequence);
  WriteU32(payload, block.frame_count);
  WriteU32(payload, block.channel_count);
  WriteFloat(payload, block.rms);
  WriteFloat(payload, block.peak);
  const auto* samples = reinterpret_cast<const std::uint8_t*>(block.samples.data());
  payload.insert(payload.end(), samples, samples + sample_bytes);
  return WriteFrame(daw::audio_host_macos::ControlType::kRecordingBlock, payload);
}

bool ReadString(const std::vector<std::uint8_t>& payload, std::size_t& offset, std::string& output) {
  if (offset + 4 > payload.size()) return false;
  const std::uint32_t length = ReadU32(payload.data() + offset);
  offset += 4;
  if (length == 0 || length > 256 || offset + length > payload.size()) return false;
  output.assign(reinterpret_cast<const char*>(payload.data() + offset), length);
  offset += length;
  return true;
}

bool ReadPath(const std::vector<std::uint8_t>& payload, std::size_t& offset, std::string& output) {
  if (offset + 4 > payload.size()) return false;
  const std::uint32_t length = ReadU32(payload.data() + offset);
  offset += 4;
  if (length == 0 || length > 4096 || offset + length > payload.size()) return false;
  output.assign(reinterpret_cast<const char*>(payload.data() + offset), length);
  offset += length;
  return true;
}

bool Configure(daw::audio_host_macos::AudioHost& host, const std::vector<std::uint8_t>& payload) {
  if (payload.size() < 20) return false;
  const std::uint32_t uidLength = ReadU32(payload.data() + 16);
  if (uidLength == 0 || uidLength > 4096 || payload.size() != 20 + uidLength) return false;
  const auto uid = daw::audio_host_macos::CoreAudioDeviceUid(
    std::string_view(reinterpret_cast<const char*>(payload.data() + 20), uidLength));
  if (!uid) return false;
  return host.Configure({
    .device_uid = *uid,
    .sample_rate_hz = ReadU32(payload.data()),
    .max_frames_per_block = ReadU32(payload.data() + 4),
    .channel_count = ReadU32(payload.data() + 8),
    .revision = ReadU32(payload.data() + 12),
  });
}

bool ConfigureRecording(daw::audio_host_macos::AudioHost& host, const std::vector<std::uint8_t>& payload) {
  if (payload.size() < 60) return false;
  const std::uint32_t flags = ReadU32(payload.data() + 48);
  const std::uint32_t uid_length = ReadU32(payload.data() + 56);
  if (flags > 1 || ReadU32(payload.data() + 52) != 0
    || uid_length == 0 || uid_length > 4096 || payload.size() != 60 + uid_length) return false;
  const auto device_uid = daw::audio_host_macos::CoreAudioDeviceUid(
    std::string_view(reinterpret_cast<const char*>(payload.data() + 60), uid_length));
  if (!device_uid) return false;
  return host.ConfigureRecording({
    .device_uid = *device_uid,
    .generation = ReadU32(payload.data()),
    .session_id = ReadU64(payload.data() + 4),
    .channel_count = ReadU32(payload.data() + 12),
    .input_channels = {ReadU32(payload.data() + 16), ReadU32(payload.data() + 20)},
    .gain = ReadFloat(payload.data() + 24),
    .polarity = static_cast<std::int32_t>(ReadU32(payload.data() + 28)),
    .punch_start_frame = ReadI64(payload.data() + 32),
    .punch_end_frame = ReadI64(payload.data() + 40),
    .monitoring = flags == 1,
  });
}

bool WriteDeviceList(const std::vector<std::uint8_t>& payload) {
  if (payload.size() > 4096) return false;
  std::optional<std::string> preferred_uid;
  std::string preferred_id;
  if (!payload.empty()) {
    preferred_id.assign(reinterpret_cast<const char*>(payload.data()), payload.size());
    preferred_uid = daw::audio_host_macos::CoreAudioDeviceUid(preferred_id);
    if (!preferred_uid) return false;
  }
  const auto selected = preferred_uid
    ? daw::audio_host_macos::SelectOutputDevice(*preferred_uid)
    : daw::audio_host_macos::SelectOutputDevice(std::nullopt);
  std::vector<std::uint8_t> response;
  response.reserve(64);
  WriteU32(response, selected ? 1 : 0);
  if (selected) {
    WriteString(response, daw::audio_host_macos::CoreAudioDeviceId(selected->uid));
    WriteString(response, selected->name);
    WriteU32(response, selected->nominal_sample_rate_hz);
    WriteU32(response, selected->output_channels);
    WriteU32(response, selected->maximum_frames_per_block);
    WriteU32(response, selected->available ? 1 : 0);
  }
  return WriteFrame(daw::audio_host_macos::ControlType::kDeviceList, response);
}

bool WriteInputDeviceList(const std::vector<std::uint8_t>& payload) {
  if (payload.size() > 4096) return false;
  std::optional<std::string> preferred_uid;
  if (!payload.empty()) {
    const auto uid = daw::audio_host_macos::CoreAudioDeviceUid(
      std::string_view(reinterpret_cast<const char*>(payload.data()), payload.size()));
    if (!uid) return false;
    preferred_uid = *uid;
  }
  const auto selected = daw::audio_host_macos::SelectInputDevice(
    preferred_uid ? std::optional<std::string_view>(*preferred_uid) : std::nullopt);
  std::vector<std::uint8_t> response;
  response.reserve(64);
  WriteU32(response, selected ? 1 : 0);
  if (selected) {
    WriteString(response, daw::audio_host_macos::CoreAudioDeviceId(selected->uid));
    WriteString(response, selected->name);
    WriteU32(response, selected->nominal_sample_rate_hz);
    WriteU32(response, selected->input_channels);
    WriteU32(response, selected->maximum_frames_per_block);
    WriteU32(response, selected->available ? 1 : 0);
  }
  return WriteFrame(daw::audio_host_macos::ControlType::kRecordingDeviceList, response);
}

bool InstallAsset(daw::audio_host_macos::AudioHost& host, const std::vector<std::uint8_t>& payload) {
  constexpr std::size_t header_bytes = 24;
  if (payload.size() < header_bytes || (payload.size() - header_bytes) % sizeof(float) != 0) return false;
  const std::uint32_t frames = ReadU32(payload.data() + 4);
  const std::uint32_t channels = ReadU32(payload.data() + 12);
  const std::size_t expectedSamples = static_cast<std::size_t>(frames) * channels;
  if (frames == 0 || frames > daw::audio_host_macos::kMaximumAssetFrames
    || channels == 0 || channels > daw::audio_host_macos::kMaximumAssetChannels
    || expectedSamples > (daw::audio_host_macos::kMaximumControlPayloadBytes - header_bytes) / sizeof(float)
    || payload.size() != header_bytes + expectedSamples * sizeof(float)) return false;
  std::vector<float> samples(expectedSamples);
  if (!samples.empty()) std::memcpy(samples.data(), payload.data() + header_bytes, samples.size() * sizeof(float));
  return host.InstallAsset(
    ReadU32(payload.data()),
    frames,
    ReadU32(payload.data() + 8),
    channels,
    ReadU64(payload.data() + 16),
    samples
  );
}

bool AttachVst(daw::audio_host_macos::AudioHost& host, const std::vector<std::uint8_t>& payload) {
  std::size_t offset = 0;
  daw::audio_host_macos::NativeVstAttachment attachment{};
  if (!ReadString(payload, offset, attachment.instance_id) || !ReadString(payload, offset, attachment.class_id)
    || !ReadString(payload, offset, attachment.vendor_id) || !ReadPath(payload, offset, attachment.canonical_bundle_path)
    || !ReadPath(payload, offset, attachment.canonical_executable_path) || offset + 8 + 1 + 32 + 32 + 4 + 4 + 4 + 4 + 5 * 4 != payload.size()) {
    return false;
  }
  attachment.graph_node_id = ReadU64(payload.data() + offset);
  offset += 8;
  attachment.architecture = payload[offset++];
  std::memcpy(attachment.bundle_fingerprint.data(), payload.data() + offset, attachment.bundle_fingerprint.size());
  offset += attachment.bundle_fingerprint.size();
  std::memcpy(attachment.binary_fingerprint.data(), payload.data() + offset, attachment.binary_fingerprint.size());
  offset += attachment.binary_fingerprint.size();
  attachment.scanner_catalog_version = ReadU32(payload.data() + offset);
  offset += 4;
  const std::uint8_t role = payload[offset++];
  const std::uint8_t input_layout = payload[offset++];
  const std::uint8_t output_layout = payload[offset++];
  const std::uint8_t playback_enabled = payload[offset++];
  if (playback_enabled > 1) return false;
  attachment.role = static_cast<daw::audio_host_macos::NativeVstRole>(role);
  attachment.input_layout = input_layout;
  attachment.output_layout = output_layout;
  attachment.declared_latency_frames = ReadU32(payload.data() + offset);
  offset += 4;
  attachment.transport_latency_frames = ReadU32(payload.data() + offset);
  offset += 4;
  attachment.playback_enabled = playback_enabled == 1;
  attachment.transport = {
    .slot_count = ReadU32(payload.data() + offset),
    .maximum_frames = ReadU32(payload.data() + offset + 4),
    .input_channels = ReadU32(payload.data() + offset + 8),
    .output_channels = ReadU32(payload.data() + offset + 12),
    .maximum_events_per_block = ReadU32(payload.data() + offset + 16),
  };
  return host.AttachNativeVst(attachment);
}

}  // namespace

int main() {
  const rlimit coreLimit{.rlim_cur = 0, .rlim_max = 0};
  if (setrlimit(RLIMIT_CORE, &coreLimit) != 0) return EXIT_FAILURE;
  auto host = std::make_unique<daw::audio_host_macos::AudioHost>();
  std::unique_ptr<daw::audio_host_macos::AudioHost> staged_host;
  std::atomic<bool> recording_thread_running = false;
  std::atomic<bool> notification_thread_running = false;
  std::thread recording_thread;
  std::thread notification_thread;
  struct RecordingThreadGuard {
    std::atomic<bool>& running;
    std::thread& thread;
    std::unique_ptr<daw::audio_host_macos::AudioHost>& host;
    ~RecordingThreadGuard() {
      running.store(false, std::memory_order_release);
      host->WakeRecordingWait();
      if (thread.joinable()) thread.join();
    }
  } recording_thread_guard{recording_thread_running, recording_thread, host};
  struct NotificationThreadGuard {
    std::atomic<bool>& running;
    std::thread& thread;
    std::unique_ptr<daw::audio_host_macos::AudioHost>& host;
    ~NotificationThreadGuard() {
      running.store(false, std::memory_order_release);
      host->WakeWorkerNotificationWait();
      if (thread.joinable()) thread.join();
    }
  } notification_thread_guard{notification_thread_running, notification_thread, host};
  auto stop_recording_thread = [&] {
    recording_thread_running.store(false, std::memory_order_release);
    host->WakeRecordingWait();
    if (recording_thread.joinable()) recording_thread.join();
  };
  auto start_recording_thread = [&] {
    stop_recording_thread();
    recording_thread_running.store(true, std::memory_order_release);
    auto* recording_host = host.get();
    recording_thread = std::thread([&recording_thread_running, recording_host] {
      std::uint64_t revision = recording_host->recordingStatusRevision();
      while (recording_thread_running.load(std::memory_order_acquire)) {
        const auto message = recording_host->WaitForRecordingMessage(revision, &recording_thread_running);
        revision = recording_host->recordingStatusRevision();
        if (!message) continue;
        if (message->block && !WriteRecordingBlock(*message->block)) break;
        if (!WriteRecordingStatus(message->status)) break;
        if (!message->status.active && message->status.queued_blocks == 0) break;
      }
      recording_thread_running.store(false, std::memory_order_release);
    });
  };
  auto stop_notification_thread = [&] {
    notification_thread_running.store(false, std::memory_order_release);
    host->WakeWorkerNotificationWait();
    if (notification_thread.joinable()) notification_thread.join();
  };
  auto start_notification_thread = [&] {
    stop_notification_thread();
    notification_thread_running.store(true, std::memory_order_release);
    auto* notification_host = host.get();
    notification_thread = std::thread([&notification_thread_running, notification_host] {
      while (notification_thread_running.load(std::memory_order_acquire)) {
        const auto notification = notification_host->WaitForWorkerNotification(&notification_thread_running);
        if (notification && !WriteWorkerNotification(*notification)) break;
      }
      notification_thread_running.store(false, std::memory_order_release);
    });
  };
  start_notification_thread();
  for (;;) {
    std::array<std::uint8_t, daw::audio_host_macos::kControlFrameHeaderBytes> header{};
    if (!ReadExact(std::cin, header.data(), header.size())) return std::cin.eof() ? EXIT_SUCCESS : EXIT_FAILURE;
    const std::uint32_t length = ReadU32(header.data() + 12);
    if (length > daw::audio_host_macos::kMaximumControlPayloadBytes) return EXIT_FAILURE;
    std::vector<std::uint8_t> bytes(header.begin(), header.end());
    bytes.resize(header.size() + length);
    if (length != 0 && !ReadExact(std::cin, bytes.data() + header.size(), length)) return EXIT_FAILURE;
    const auto request = daw::audio_host_macos::DecodeControlFrame(bytes);
    if (!request) return EXIT_FAILURE;
    const auto& payload = request->payload;
    if (request->type == daw::audio_host_macos::ControlType::kHostHello) {
      if (!payload.empty()) return EXIT_FAILURE;
      std::vector<std::uint8_t> response;
      WriteU32(response, daw::audio_host_macos::kControlProtocolVersion);
      WriteU32(response, kCapabilities);
      WriteU32(response, DAW_AUDIO_CORE_ABI_VERSION);
      WriteString(response, DAW_AUDIO_CORE_PROCESSOR_CONTRACT_HASH);
      WriteString(response, DAW_AUDIO_CORE_PORTABLE_GRAPH_CONTRACT_HASH);
      WriteString(response, "daw-audio-host-macos/v3");
      WriteU32(response, static_cast<std::uint32_t>(host->diagnostics().state));
      WriteU32(response, static_cast<std::uint32_t>(host->readinessReason()));
      if (!WriteFrame(daw::audio_host_macos::ControlType::kHostCapabilities, response)) return EXIT_FAILURE;
      continue;
    }
    if (request->type == daw::audio_host_macos::ControlType::kDiagnostics) {
      if (!payload.empty()) return EXIT_FAILURE;
      const auto diagnostics = host->diagnostics();
      std::vector<std::uint8_t> response;
      response.reserve(40);
      WriteU32(response, static_cast<std::uint32_t>(diagnostics.state));
      WriteU32(response, diagnostics.active_revision);
      WriteU32(response, diagnostics.prepared_revision);
      WriteU32(response, diagnostics.retired_revision);
      WriteU32(response, diagnostics.transport_epoch);
      WriteU32(response, diagnostics.installed_assets);
      WriteU32(response, static_cast<std::uint32_t>(diagnostics.callbacks));
      WriteU32(response, static_cast<std::uint32_t>(diagnostics.rejected_blocks));
      WriteU64(response, diagnostics.render_epoch);
      if (!WriteFrame(daw::audio_host_macos::ControlType::kDiagnostics, response)) return EXIT_FAILURE;
      continue;
    }
    if (request->type == daw::audio_host_macos::ControlType::kDeviceList) {
      if (!WriteDeviceList(payload)) return EXIT_FAILURE;
      continue;
    }
    if (request->type == daw::audio_host_macos::ControlType::kTransactionBegin) {
      if (!payload.empty() || staged_host) return EXIT_FAILURE;
      staged_host = std::make_unique<daw::audio_host_macos::AudioHost>();
      if (!WriteAck(request->type, true)) return EXIT_FAILURE;
      continue;
    }
    if (request->type == daw::audio_host_macos::ControlType::kTransactionCommit) {
      if (!payload.empty() || !staged_host) return EXIT_FAILURE;
      stop_recording_thread();
      stop_notification_thread();
      host.swap(staged_host);
      staged_host.reset();
      start_notification_thread();
      if (!WriteAck(request->type, true)) return EXIT_FAILURE;
      continue;
    }
    if (request->type == daw::audio_host_macos::ControlType::kTransactionRollback) {
      if (!payload.empty() || !staged_host) return EXIT_FAILURE;
      staged_host.reset();
      if (!WriteAck(request->type, true)) return EXIT_FAILURE;
      continue;
    }
    auto* session = staged_host.get();
    auto* active_session = host.get();
    bool accepted = false;
    switch (request->type) {
      case daw::audio_host_macos::ControlType::kDeviceConfigure: accepted = session && Configure(*session, payload); break;
      case daw::audio_host_macos::ControlType::kGraphSnapshot:
        accepted = (session || active_session) && payload.size() > daw::audio_host_macos::kNativeGraphFrameHeaderBytes
          && ReadU64(payload.data()) <= std::numeric_limits<std::uint32_t>::max()
          && (session ? session : active_session)->PrepareAndPublishGraph(static_cast<std::uint32_t>(ReadU64(payload.data())), payload);
        break;
      case daw::audio_host_macos::ControlType::kGraphPrepare:
        if (!active_session || payload.size() <= daw::audio_host_macos::kNativeGraphFrameHeaderBytes
          || ReadU64(payload.data()) > std::numeric_limits<std::uint32_t>::max()) return EXIT_FAILURE;
        if (!WriteGraphRevisionStatus(active_session->PrepareGraphRevision(
          static_cast<std::uint32_t>(ReadU64(payload.data())),
          payload
        ))) return EXIT_FAILURE;
        continue;
      case daw::audio_host_macos::ControlType::kGraphPublish:
        if (!active_session || payload.size() != 4) return EXIT_FAILURE;
        if (!WriteGraphRevisionStatus(active_session->PublishGraphRevision(ReadU32(payload.data())))) return EXIT_FAILURE;
        continue;
      case daw::audio_host_macos::ControlType::kGraphRetire:
        if (!active_session || payload.size() != 4) return EXIT_FAILURE;
        if (!WriteGraphRevisionStatus(active_session->RetireGraphRevision(ReadU32(payload.data())))) return EXIT_FAILURE;
        continue;
      case daw::audio_host_macos::ControlType::kGraphRollback:
        if (!active_session || payload.size() != 4) return EXIT_FAILURE;
        if (!WriteGraphRevisionStatus(active_session->RollbackGraphRevision(ReadU32(payload.data())))) return EXIT_FAILURE;
        continue;
      case daw::audio_host_macos::ControlType::kAssetInstall: accepted = session && InstallAsset(*session, payload); break;
      case daw::audio_host_macos::ControlType::kAssetRelease:
        accepted = active_session && payload.size() == 4 && active_session->ReleaseAsset(ReadU32(payload.data()));
        break;
      case daw::audio_host_macos::ControlType::kTransport:
        accepted = session && payload.size() == 16 && (payload[4] == 0 || payload[4] == 1)
          && payload[5] == 0 && payload[6] == 0 && payload[7] == 0
          && session->SetTransport(ReadU32(payload.data()), payload[4] == 1, ReadI64(payload.data() + 8));
        break;
      case daw::audio_host_macos::ControlType::kParameterEvents:
        accepted = session && session->QueueParameterEvents(payload);
        break;
      case daw::audio_host_macos::ControlType::kMidiEvents: accepted = session && session->QueueInstrumentEvents(payload); break;
      case daw::audio_host_macos::ControlType::kSourceEvents: accepted = session && session->QueueSourceEvents(payload); break;
      case daw::audio_host_macos::ControlType::kVstParameterEvents:
        accepted = active_session && active_session->QueueNativeVstParameterEvents(payload);
        break;
      case daw::audio_host_macos::ControlType::kVstMidiEvents:
        accepted = active_session && active_session->QueueNativeVstMidiEvents(payload);
        break;
      case daw::audio_host_macos::ControlType::kVstStateSet:
        accepted = active_session && active_session->SetNativeVstState(payload);
        break;
      case daw::audio_host_macos::ControlType::kVstStateGet: {
        const auto state = active_session ? active_session->GetNativeVstState(payload) : std::nullopt;
        if (!state || !WriteFrame(daw::audio_host_macos::ControlType::kVstState, *state)) return EXIT_FAILURE;
        continue;
      }
      case daw::audio_host_macos::ControlType::kRecordingConfigure:
        accepted = active_session && ConfigureRecording(*active_session, payload);
        if (accepted) start_recording_thread();
        break;
      case daw::audio_host_macos::ControlType::kRecordingStart:
        accepted = active_session && payload.empty() && active_session->StartRecording();
        break;
      case daw::audio_host_macos::ControlType::kRecordingStop:
        accepted = active_session && (payload.empty() || payload.size() == 8)
          && active_session->StopRecording(payload.empty()
            ? std::nullopt
            : std::optional<std::int64_t>(ReadI64(payload.data())));
        break;
      case daw::audio_host_macos::ControlType::kRecordingCancel:
        accepted = active_session && payload.empty() && active_session->CancelRecording();
        break;
      case daw::audio_host_macos::ControlType::kRecordingDeviceQuery:
        if (!WriteInputDeviceList(payload)) return EXIT_FAILURE;
        continue;
      case daw::audio_host_macos::ControlType::kVstAttach: accepted = session && AttachVst(*session, payload); break;
      case daw::audio_host_macos::ControlType::kVstDetach: {
        std::size_t offset = 0;
        std::string instanceId;
        accepted = session && ReadString(payload, offset, instanceId) && offset == payload.size() && session->DetachVstReference(instanceId);
        break;
      }
      case daw::audio_host_macos::ControlType::kStart: {
        if (!payload.empty()) return EXIT_FAILURE;
        accepted = active_session && active_session->Start();
        break;
      }
      case daw::audio_host_macos::ControlType::kStop:
        if (!payload.empty()) return EXIT_FAILURE;
        stop_recording_thread();
        if (active_session) active_session->Stop();
        accepted = active_session != nullptr;
        break;
      case daw::audio_host_macos::ControlType::kTeardown:
        if (!payload.empty()) return EXIT_FAILURE;
        stop_recording_thread();
        if (active_session) active_session->Teardown();
        accepted = active_session != nullptr;
        break;
      default: return EXIT_FAILURE;
    }
    if (!WriteAck(request->type, accepted)) return EXIT_FAILURE;
  }
}
