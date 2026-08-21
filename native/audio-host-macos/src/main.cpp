#include "daw/audio_host_macos.h"
#include "worker-supervisor.h"
#include "processor_contract_generated.h"

#include <array>
#include <atomic>
#include <cstdlib>
#include <cmath>
#include <cstring>
#include <iostream>
#include <limits>
#include <memory>
#include <mutex>
#include <sys/resource.h>
#include <thread>
#include <vector>

namespace {

constexpr std::uint32_t kCapabilities = 0x000003ffU;

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

std::int32_t ReadI32(const std::uint8_t* bytes) {
  return static_cast<std::int32_t>(ReadU32(bytes));
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

std::string_view RejectedBlockReasonName(const daw::audio_host_macos::RejectedBlockReason reason) {
  using Reason = daw::audio_host_macos::RejectedBlockReason;
  switch (reason) {
    case Reason::kNotRunningOrCoreUnavailable: return "not-running-or-core-unavailable";
    case Reason::kInsufficientChannels: return "insufficient-channels";
    case Reason::kNullChannel: return "null-channel";
    case Reason::kTransport: return "transport";
    case Reason::kScratchCapacity: return "scratch-capacity";
    case Reason::kProcessorEventCapacity: return "processor-event-capacity";
    case Reason::kInstrumentEventCapacity: return "instrument-event-capacity";
    case Reason::kSourceSchedule: return "source-schedule";
    case Reason::kCoreProcess: return "core-process";
    case Reason::kNone: return "none";
  }
  return "unknown";
}

std::string NativeOfflineFailureMessage(const daw::audio_host_macos::Diagnostics& diagnostics) {
  return "Native offline rendering failed (reason: "
    + std::string(RejectedBlockReasonName(diagnostics.last_rejected_reason))
    + ", core result: " + std::to_string(diagnostics.last_rejected_core_result)
    + ", frames: " + std::to_string(diagnostics.last_rejected_frame_count)
    + ", channels: " + std::to_string(diagnostics.last_rejected_channel_count)
    + ").";
}

bool WriteFrame(const daw::audio_host_macos::ControlType type, std::span<const std::uint8_t> payload);

bool WriteScheduleProgress(const daw::audio_host_macos::ScheduleProgress& progress) {
  std::vector<std::uint8_t> payload;
  payload.reserve(80);
  WriteU32(payload, progress.revision);
  WriteU32(payload, progress.epoch);
  WriteU64(payload, progress.progress_sequence);
  WriteU64(payload, progress.rendered_through_frame);
  WriteU64(payload, progress.accepted_through_frame);
  WriteU64(payload, progress.last_accepted_window_id);
  WriteU64(payload, progress.applied_transport_transition_id);
  WriteU64(payload, progress.applied_urgent_sequence);
  WriteU64(payload, progress.applied_processor_sequence);
  WriteU32(payload, (progress.running ? 1U : 0U) | (progress.schedule_complete ? 2U : 0U));
  WriteU32(payload, progress.instrument_credits);
  WriteU32(payload, progress.source_credits);
  WriteU32(payload, progress.automation_credits);
  return WriteFrame(daw::audio_host_macos::ControlType::kScheduleProgress, payload);
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
  payload.reserve(32);
  WriteU32(payload, static_cast<std::uint32_t>(status.code));
  WriteU32(payload, static_cast<std::uint32_t>(status.continuity));
  WriteU32(payload, status.requested_revision);
  WriteU32(payload, status.active_revision);
  WriteU32(payload, status.prepared_revision);
  WriteU32(payload, status.retired_revision);
  WriteU64(payload, status.render_epoch);
  return WriteFrame(daw::audio_host_macos::ControlType::kGraphRevisionStatus, payload);
}

bool WriteVstEditorStatus(const daw::audio_host_macos::NativeVstEditorStatus& status) {
  std::vector<std::uint8_t> payload;
  payload.reserve(24);
  WriteU32(payload, status.success ? 1U : 0U);
  WriteU32(payload, status.owned ? 1U : 0U);
  WriteU32(payload, status.supported ? 1U : 0U);
  WriteU32(payload, status.open ? 1U : 0U);
  WriteU32(payload, status.width);
  WriteU32(payload, status.height);
  return WriteFrame(daw::audio_host_macos::ControlType::kVstEditorStatus, payload);
}

bool WriteWorkerNotification(const daw::audio_host_macos::WorkerNotification& notification) {
  if (notification.instance_id.empty() || notification.instance_id.size() > 256) return false;
  std::vector<std::uint8_t> payload;
  if (notification.kind == daw::audio_host_macos::WorkerNotificationKind::kParameterEdit) {
    if (!std::isfinite(notification.normalized_value)
      || notification.normalized_value < 0.0
      || notification.normalized_value > 1.0) return false;
    payload.reserve(32 + notification.instance_id.size());
    WriteU32(payload, static_cast<std::uint32_t>(notification.kind));
    WriteU32(payload, notification.graph_revision);
    WriteU64(payload, notification.graph_node_id);
    WriteU32(payload, notification.parameter_id);
    std::uint64_t bits = 0;
    std::memcpy(&bits, &notification.normalized_value, sizeof(bits));
    WriteU64(payload, bits);
    WriteString(payload, notification.instance_id);
    return WriteFrame(daw::audio_host_macos::ControlType::kNotification, payload);
  }
  payload.reserve(24 + notification.instance_id.size());
  WriteU32(payload, static_cast<std::uint32_t>(notification.kind));
  WriteU32(payload, notification.graph_revision);
  WriteU64(payload, notification.graph_node_id);
  WriteU32(payload, notification.value);
  WriteString(payload, notification.instance_id);
  return WriteFrame(daw::audio_host_macos::ControlType::kNotification, payload);
}

void WriteFloat(std::vector<std::uint8_t>& payload, float value);

bool WriteMeterBatch(const daw::audio_host_macos::MeterBatch& batch) {
  if (batch.entry_count > daw::audio_host_macos::kMaximumMeterEntries) return false;
  std::vector<std::uint8_t> payload;
  payload.reserve(20 + static_cast<std::size_t>(batch.entry_count) * 16);
  WriteU32(payload, batch.graph_revision);
  WriteU32(payload, batch.transport_epoch);
  WriteU64(payload, batch.sequence);
  WriteU32(payload, batch.entry_count);
  for (std::uint32_t index = 0; index < batch.entry_count; ++index) {
    const auto& entry = batch.entries[index];
    WriteU64(payload, entry.node_id);
    WriteFloat(payload, entry.left_rms);
    WriteFloat(payload, entry.right_rms);
  }
  return WriteFrame(daw::audio_host_macos::ControlType::kMeterBatch, payload);
}

bool WriteSpectrumFrame(const daw::audio_host_macos::SpectrumFrame& frame) {
  if (frame.bin_count == 0 || frame.bin_count > daw::audio_host_macos::kMaximumSpectrumBins
    || frame.bin_count != frame.fft_size / 2) return false;
  std::vector<std::uint8_t> payload;
  payload.reserve(40 + static_cast<std::size_t>(frame.bin_count) * 4);
  WriteU32(payload, frame.graph_revision);
  WriteU32(payload, frame.transport_epoch);
  WriteU64(payload, frame.sequence);
  WriteU64(payload, frame.node_id);
  WriteU32(payload, frame.sample_rate_hz);
  WriteU32(payload, frame.fft_size);
  WriteU32(payload, frame.bin_count);
  WriteU32(payload, frame.bin_count * 4);
  for (std::uint32_t index = 0; index < frame.bin_count; ++index) {
    if (!std::isfinite(frame.data[index]) || frame.data[index] < 0.0F || frame.data[index] > 1.0F) return false;
    WriteFloat(payload, frame.data[index]);
  }
  return WriteFrame(daw::audio_host_macos::ControlType::kSpectrumFrame, payload);
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

double ReadDouble(const std::uint8_t* bytes) {
  const std::uint64_t bits = ReadU64(bytes);
  double value = 0.0;
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

bool WriteOfflineChunk(
  const std::uint64_t start_frame,
  const std::uint32_t frame_count,
  const std::uint32_t channel_count,
  const std::vector<std::vector<float>>& planes) {
  const std::size_t sample_bytes = static_cast<std::size_t>(frame_count) * channel_count * sizeof(float);
  if (planes.size() != channel_count
    || sample_bytes > daw::audio_host_macos::kMaximumControlPayloadBytes - 16) return false;
  std::vector<std::uint8_t> payload;
  payload.reserve(16 + sample_bytes);
  WriteU64(payload, start_frame);
  WriteU32(payload, frame_count);
  WriteU32(payload, channel_count);
  for (const auto& plane : planes) {
    if (plane.size() != frame_count) return false;
    for (const auto sample : plane) WriteFloat(payload, sample);
  }
  return WriteFrame(daw::audio_host_macos::ControlType::kOfflinePcmChunk, payload);
}

bool RenderOffline(
  daw::audio_host_macos::AudioHost& host,
  const std::uint64_t total_frames,
  const std::uint32_t block_frames,
  const std::uint32_t channel_count) {
  if (total_frames == 0 || block_frames == 0 || channel_count == 0) return false;
  const auto process_channels = std::max(channel_count, 2U);
  std::vector<std::vector<float>> input_planes(process_channels);
  std::vector<std::vector<float>> output_planes(process_channels);
  std::vector<const float*> inputs(process_channels);
  std::vector<float*> outputs(process_channels);
  std::uint64_t rendered = 0;
  while (rendered < total_frames) {
    const auto frames = static_cast<std::uint32_t>(
      std::min<std::uint64_t>(block_frames, total_frames - rendered));
    for (std::uint32_t channel = 0; channel < process_channels; ++channel) {
      input_planes[channel].assign(frames, 0.0F);
      output_planes[channel].assign(frames, 0.0F);
      inputs[channel] = input_planes[channel].data();
      outputs[channel] = output_planes[channel].data();
    }
    if (!host.ProcessPlanar(inputs, outputs, frames)) return false;
    if (channel_count == 1) {
      std::vector<float> mono(frames);
      for (std::uint32_t frame = 0; frame < frames; ++frame) {
        mono[frame] = 0.5F * (output_planes[0][frame] + output_planes[1][frame]);
      }
      if (!WriteOfflineChunk(rendered, frames, 1, {mono})) return false;
    } else if (!WriteOfflineChunk(rendered, frames, channel_count, output_planes)) return false;
    rendered += frames;
  }
  return true;
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
    .channel_count = std::max(ReadU32(payload.data() + 8), 2U),
    .revision = ReadU32(payload.data() + 12),
  });
}

bool ConfigureOffline(daw::audio_host_macos::AudioHost& host, const std::vector<std::uint8_t>& payload) {
  if (payload.size() != 16) return false;
  return host.Configure({
    .device_uid = "offline:render",
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
    || !ReadPath(payload, offset, attachment.canonical_executable_path)) {
    return false;
  }
  constexpr std::size_t fixed_attachment_bytes = 4 + 4 + 8 + 1 + 32 + 32 + 4 + 5 + 8 * 4;
  if (payload.size() < offset + fixed_attachment_bytes) return false;
  attachment.stage_index = ReadU32(payload.data() + offset);
  offset += 4;
  attachment.source_index = ReadU32(payload.data() + offset);
  offset += 4;
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
  const std::uint8_t render_enabled = payload[offset++];
  if (playback_enabled > 1) return false;
  if (render_enabled > 1) return false;
  attachment.playback_enabled = playback_enabled != 0;
  attachment.render_enabled = render_enabled != 0;
  attachment.role = static_cast<daw::audio_host_macos::NativeVstRole>(role);
  attachment.input_layout = input_layout;
  attachment.output_layout = output_layout;
  attachment.declared_latency_frames = ReadU32(payload.data() + offset);
  offset += 4;
  const auto declared_tail_frames = ReadU32(payload.data() + offset);
  offset += 4;
  attachment.infinite_tail = daw::plugin_host::IsInfiniteTailFrames(declared_tail_frames);
  if (!attachment.infinite_tail) attachment.declared_tail_frames = declared_tail_frames;
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
  offset += 5 * 4;
  if (offset == payload.size()) return host.AttachNativeVst(attachment);
  if (payload.size() < offset + 8) return false;
  const auto state_bytes = ReadU32(payload.data() + offset);
  const auto state_hash_bytes = ReadU32(payload.data() + offset + 4);
  offset += 8;
  if (state_bytes > daw::plugin_host::kMaximumWorkerStateBytes
    || state_hash_bytes > 64
    || (state_bytes > 0 && state_hash_bytes != 64)
    || (state_bytes == 0 && state_hash_bytes != 0 && state_hash_bytes != 64)
    || payload.size() < offset + state_bytes + state_hash_bytes + 4) return false;
  attachment.initial_state.assign(payload.begin() + static_cast<std::ptrdiff_t>(offset),
    payload.begin() + static_cast<std::ptrdiff_t>(offset + state_bytes));
  offset += state_bytes;
  attachment.initial_state_sha256.assign(
    reinterpret_cast<const char*>(payload.data() + offset), state_hash_bytes);
  offset += state_hash_bytes;
  const auto parameter_count = ReadU32(payload.data() + offset);
  offset += 4;
  if (parameter_count > 2'048 || payload.size() != offset + static_cast<std::size_t>(parameter_count) * 12) return false;
  for (std::uint32_t index = 0; index < parameter_count; ++index) {
    const auto parameter_id = ReadU32(payload.data() + offset);
    const auto value = ReadDouble(payload.data() + offset + 4);
    if (!std::isfinite(value) || value < 0.0 || value > 1.0) return false;
    attachment.initial_parameter_values.emplace_back(parameter_id, value);
    offset += 12;
  }
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
  std::atomic<bool> meter_thread_running = false;
  std::atomic<bool> spectrum_thread_running = false;
  std::atomic<bool> schedule_thread_running = false;
  std::thread recording_thread;
  std::thread notification_thread;
  std::thread meter_thread;
  std::thread spectrum_thread;
  std::thread schedule_thread;
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
  struct MeterThreadGuard {
    std::atomic<bool>& running;
    std::thread& thread;
    std::unique_ptr<daw::audio_host_macos::AudioHost>& host;
    ~MeterThreadGuard() {
      running.store(false, std::memory_order_release);
      host->WakeMeterWait();
      if (thread.joinable()) thread.join();
    }
  } meter_thread_guard{meter_thread_running, meter_thread, host};
  struct SpectrumThreadGuard {
    std::atomic<bool>& running;
    std::thread& thread;
    std::unique_ptr<daw::audio_host_macos::AudioHost>& host;
    ~SpectrumThreadGuard() {
      running.store(false, std::memory_order_release);
      host->WakeSpectrumWait();
      if (thread.joinable()) thread.join();
    }
  } spectrum_thread_guard{spectrum_thread_running, spectrum_thread, host};
  struct ScheduleThreadGuard {
    std::atomic<bool>& running;
    std::thread& thread;
    std::unique_ptr<daw::audio_host_macos::AudioHost>& host;
    ~ScheduleThreadGuard() {
      running.store(false, std::memory_order_release);
      host->WakeScheduleProgressWait();
      if (thread.joinable()) thread.join();
    }
  } schedule_thread_guard{schedule_thread_running, schedule_thread, host};
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
  auto stop_meter_thread = [&] {
    meter_thread_running.store(false, std::memory_order_release);
    host->WakeMeterWait();
    if (meter_thread.joinable()) meter_thread.join();
  };
  auto stop_spectrum_thread = [&] {
    spectrum_thread_running.store(false, std::memory_order_release);
    host->WakeSpectrumWait();
    if (spectrum_thread.joinable()) spectrum_thread.join();
  };
  auto start_spectrum_thread = [&] {
    stop_spectrum_thread();
    spectrum_thread_running.store(true, std::memory_order_release);
    auto* spectrum_host = host.get();
    spectrum_thread = std::thread([&spectrum_thread_running, spectrum_host] {
      while (spectrum_thread_running.load(std::memory_order_acquire)) {
        if (!spectrum_host->WaitForSpectrumFrame(&spectrum_thread_running)) break;
        const auto frame = spectrum_host->DrainSpectrumFrame();
        if (frame && !WriteSpectrumFrame(*frame)) break;
      }
      spectrum_thread_running.store(false, std::memory_order_release);
    });
  };
  auto start_meter_thread = [&] {
    stop_meter_thread();
    meter_thread_running.store(true, std::memory_order_release);
    auto* meter_host = host.get();
    meter_thread = std::thread([&meter_thread_running, meter_host] {
      while (meter_thread_running.load(std::memory_order_acquire)) {
        if (!meter_host->WaitForMeterBatch(&meter_thread_running)) break;
        const auto batch = meter_host->DrainMeterBatch();
        if (batch && !WriteMeterBatch(*batch)) break;
      }
      meter_thread_running.store(false, std::memory_order_release);
    });
  };
  auto stop_schedule_thread = [&] {
    schedule_thread_running.store(false, std::memory_order_release);
    host->WakeScheduleProgressWait();
    if (schedule_thread.joinable()) schedule_thread.join();
  };
  auto start_schedule_thread = [&] {
    stop_schedule_thread();
    schedule_thread_running.store(true, std::memory_order_release);
    auto* schedule_host = host.get();
    schedule_thread = std::thread([&schedule_thread_running, schedule_host] {
      while (schedule_thread_running.load(std::memory_order_acquire)) {
        if (!schedule_host->WaitForScheduleProgress(&schedule_thread_running)) break;
        const auto progress = schedule_host->DrainScheduleProgress();
        if (progress && !WriteScheduleProgress(*progress)) break;
      }
      schedule_thread_running.store(false, std::memory_order_release);
    });
  };
  start_notification_thread();
  start_meter_thread();
  start_spectrum_thread();
  start_schedule_thread();
  for (;;) {
    if (host) host->ProcessNativeVstControl();
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
      WriteString(response, "daw-audio-host-macos/v4");
      WriteU32(response, static_cast<std::uint32_t>(host->diagnostics().state));
      WriteU32(response, static_cast<std::uint32_t>(host->readinessReason()));
      if (!WriteFrame(daw::audio_host_macos::ControlType::kHostCapabilities, response)) return EXIT_FAILURE;
      continue;
    }
    if (request->type == daw::audio_host_macos::ControlType::kDiagnostics) {
      if (!payload.empty()) return EXIT_FAILURE;
      const auto diagnostics = host->diagnostics();
      std::vector<std::uint8_t> response;
      response.reserve(88);
      WriteU32(response, static_cast<std::uint32_t>(diagnostics.state));
      WriteU32(response, diagnostics.active_revision);
      WriteU32(response, diagnostics.prepared_revision);
      WriteU32(response, diagnostics.retired_revision);
      WriteU32(response, diagnostics.transport_epoch);
      WriteU32(response, diagnostics.installed_assets);
      WriteU32(response, static_cast<std::uint32_t>(diagnostics.callbacks));
      WriteU32(response, static_cast<std::uint32_t>(diagnostics.rejected_blocks));
      WriteU64(response, diagnostics.render_epoch);
      WriteU32(response, static_cast<std::uint32_t>(diagnostics.last_rejected_reason));
      WriteU64(response, diagnostics.last_rejected_callback);
      WriteU64(response, diagnostics.last_rejected_render_epoch);
      WriteU32(response, diagnostics.last_rejected_transport_epoch);
      WriteU32(response, diagnostics.last_rejected_core_result);
      WriteU32(response, diagnostics.last_rejected_frame_count);
      WriteU32(response, diagnostics.last_rejected_channel_count);
      WriteU32(response, diagnostics.last_rejected_processor_event_count);
      WriteU32(response, diagnostics.last_rejected_instrument_event_count);
      WriteU32(response, diagnostics.last_rejected_graph_revision);
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
      stop_meter_thread();
      stop_spectrum_thread();
      stop_schedule_thread();
      host.swap(staged_host);
      staged_host.reset();
      start_notification_thread();
      start_meter_thread();
      start_spectrum_thread();
      start_schedule_thread();
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
    auto* control_session = session != nullptr ? session : active_session;
    bool accepted = false;
    switch (request->type) {
      case daw::audio_host_macos::ControlType::kDeviceConfigure: accepted = session && Configure(*session, payload); break;
      case daw::audio_host_macos::ControlType::kOfflineConfigure: accepted = active_session && ConfigureOffline(*active_session, payload); break;
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
      case daw::audio_host_macos::ControlType::kInstrumentStates:
        accepted = control_session && control_session->ConfigureInstrumentStates(payload);
        break;
      case daw::audio_host_macos::ControlType::kAssetInstall: accepted = control_session && InstallAsset(*control_session, payload); break;
      case daw::audio_host_macos::ControlType::kAssetRelease:
        accepted = active_session && payload.size() == 4 && active_session->ReleaseAsset(ReadU32(payload.data()));
        break;
      case daw::audio_host_macos::ControlType::kTransport:
        if (control_session && (payload.size() == 24 || payload.size() == 64)
          && (payload[4] == 0 || payload[4] == 1)
          && payload[5] == 0 && payload[6] == 0 && payload[7] == 0) {
          accepted = payload.size() == 24
            ? control_session->SetTransport(
              ReadU32(payload.data()), payload[4] == 1, ReadI64(payload.data() + 8),
              0.0, 0, 0, false, 0.0, 0.0, ReadU64(payload.data() + 16))
            : control_session->SetTransport(
              ReadU32(payload.data()), payload[4] == 1, ReadI64(payload.data() + 8),
              ReadDouble(payload.data() + 24), ReadU32(payload.data() + 36),
              ReadU32(payload.data() + 40), ReadU32(payload.data() + 32) == 1,
              ReadDouble(payload.data() + 48), ReadDouble(payload.data() + 56),
              ReadU64(payload.data() + 16));
        }
        break;
      case daw::audio_host_macos::ControlType::kParameterEvents:
        accepted = control_session && control_session->QueueParameterEvents(payload);
        break;
      case daw::audio_host_macos::ControlType::kProcessorStatePatch:
        accepted = active_session && active_session->QueueProcessorStatePatch(payload);
        break;
      case daw::audio_host_macos::ControlType::kMidiEvents:
        accepted = control_session && control_session->QueueInstrumentEvents(payload);
        break;
      case daw::audio_host_macos::ControlType::kScheduleWindow: {
        accepted = control_session && control_session->QueueScheduleWindow(payload);
        break;
      }
      case daw::audio_host_macos::ControlType::kVstScheduleAutomationEnable:
        accepted = control_session && control_session->ReenableVstScheduleAutomation(payload);
        break;
      case daw::audio_host_macos::ControlType::kSourceEvents:
        accepted = control_session && control_session->QueueSourceEvents(payload);
        break;
      case daw::audio_host_macos::ControlType::kSpectrumSelection:
        accepted = active_session && payload.size() == 8
          && active_session->SetSpectrumNode(ReadU64(payload.data()));
        break;
      case daw::audio_host_macos::ControlType::kVstParameterEvents:
        accepted = control_session && control_session->QueueNativeVstParameterEvents(payload);
        break;
      case daw::audio_host_macos::ControlType::kVstMidiEvents:
        accepted = control_session && control_session->QueueNativeVstMidiEvents(payload);
        break;
      case daw::audio_host_macos::ControlType::kVstStateSet:
        accepted = control_session && control_session->SetNativeVstState(payload);
        break;
      case daw::audio_host_macos::ControlType::kVstStateGet: {
        const auto state = active_session ? active_session->GetNativeVstState(payload) : std::nullopt;
        if (!state) {
          if (!WriteAck(request->type, false)) return EXIT_FAILURE;
          continue;
        }
        if (!WriteFrame(daw::audio_host_macos::ControlType::kVstState, *state)) return EXIT_FAILURE;
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
      case daw::audio_host_macos::ControlType::kVstAttach:
        accepted = (session || active_session) && AttachVst(*(session ? session : active_session), payload);
        break;
      case daw::audio_host_macos::ControlType::kVstDetach: {
        std::size_t offset = 0;
        std::string instanceId;
        accepted = session && ReadString(payload, offset, instanceId) && offset == payload.size() && session->DetachVstReference(instanceId);
        break;
      }
      case daw::audio_host_macos::ControlType::kVstEditor: {
        if (!active_session || payload.size() < 28) return EXIT_FAILURE;
        const auto command = ReadU32(payload.data());
        if (command < 1 || command > 5
          || ReadU32(payload.data() + 4) > 8192
          || ReadU32(payload.data() + 8) > 8192
          || ReadU32(payload.data() + 12) > 1
          || (ReadU32(payload.data() + 12) == 1 && command != 1 && command != 3)) return EXIT_FAILURE;
        std::size_t offset = 24;
        std::string instanceId;
        if (!ReadString(payload, offset, instanceId) || offset != payload.size()) return EXIT_FAILURE;
        const auto anchor = ReadU32(payload.data() + 12) == 1
          ? std::optional<daw::audio_host_macos::NativeVstEditorAnchor>(
            daw::audio_host_macos::NativeVstEditorAnchor{
              .x = ReadI32(payload.data() + 16),
              .y = ReadI32(payload.data() + 20),
            })
          : std::nullopt;
        const auto status = active_session->ExecuteNativeVstEditorCommand(
          instanceId,
          static_cast<daw::audio_host_macos::NativeVstEditorCommand>(command),
          ReadU32(payload.data() + 4),
          ReadU32(payload.data() + 8),
          anchor
        );
        if (!status) {
          if (!WriteVstEditorStatus({
            .success = false,
            .owned = false,
            .supported = false,
            .open = false,
            .width = 0,
            .height = 0,
          })) return EXIT_FAILURE;
          continue;
        }
        if (!WriteVstEditorStatus(*status)) return EXIT_FAILURE;
        continue;
      }
      case daw::audio_host_macos::ControlType::kStart: {
        if (!payload.empty()) return EXIT_FAILURE;
        accepted = active_session && active_session->Start();
        break;
      }
      case daw::audio_host_macos::ControlType::kOfflineStart:
        if (payload.size() != 16 || !active_session) return EXIT_FAILURE;
        accepted = active_session->StartOffline();
        break;
      case daw::audio_host_macos::ControlType::kDiagnosticStart:
        if (!payload.empty()) return EXIT_FAILURE;
        accepted = active_session && active_session->StartDiagnosticMode();
        break;
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
    if (request->type == daw::audio_host_macos::ControlType::kOfflineStart && accepted) {
      const auto total_frames = ReadU64(payload.data());
      const auto block_frames = ReadU32(payload.data() + 8);
      const auto channel_count = ReadU32(payload.data() + 12);
      const auto rendered = RenderOffline(*active_session, total_frames, block_frames, channel_count);
      active_session->Stop();
      if (!rendered) {
        std::vector<std::uint8_t> error;
        WriteString(error, NativeOfflineFailureMessage(active_session->diagnostics()));
        if (!WriteFrame(daw::audio_host_macos::ControlType::kOfflineError, error)) return EXIT_FAILURE;
        continue;
      }
      std::vector<std::uint8_t> complete;
      WriteU64(complete, total_frames);
      if (!WriteFrame(daw::audio_host_macos::ControlType::kOfflineComplete, complete)) return EXIT_FAILURE;
    }
  }
}
