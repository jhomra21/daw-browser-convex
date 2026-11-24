#include "audio-host-bytes.h"
#include "daw/audio_host_macos.h"

namespace daw::audio_host_macos {

bool ReadNativeInstanceId(const std::span<const std::uint8_t> payload, std::size_t& offset, std::string& instance_id) {
  if (offset + 4 > payload.size()) return false;
  const std::uint32_t length = ReadLeU32(payload.data() + offset);
  offset += 4;
  if (length == 0 || length > 256 || offset + length > payload.size()) return false;
  instance_id.assign(reinterpret_cast<const char*>(payload.data() + offset), length);
  offset += length;
  return true;
}

std::optional<ControlFrame> DecodeControlFrame(std::span<const std::uint8_t> bytes) {
  if (bytes.size() < kControlFrameHeaderBytes) return std::nullopt;
  if (ReadU32(bytes.data()) != kFrameMagic || ReadU32(bytes.data() + 4) != kControlProtocolVersion) return std::nullopt;
  const std::uint32_t type = ReadU32(bytes.data() + 8);
  const std::uint32_t length = ReadU32(bytes.data() + 12);
  if (length > kMaximumControlPayloadBytes || bytes.size() != kControlFrameHeaderBytes + length) return std::nullopt;
  if (type < static_cast<std::uint32_t>(ControlType::kHostHello)
    || type > static_cast<std::uint32_t>(ControlType::kCpuLoad)) return std::nullopt;
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

std::vector<std::uint8_t> EncodeScheduleProgress(const ScheduleProgress& progress) {
  // Protocol 29 retains protocol 28's 96 bytes and adds the resolved patch token, its
  // result and a reserved word.
  std::vector<std::uint8_t> payload(112);
  const auto write64 = [&payload](const std::size_t offset, const std::uint64_t value) {
    WriteU32(payload, offset, static_cast<std::uint32_t>(value >> 32U));
    WriteU32(payload, offset + 4, static_cast<std::uint32_t>(value));
  };
  WriteU32(payload, 0, progress.revision);
  WriteU32(payload, 4, progress.epoch);
  write64(8, progress.progress_sequence);
  write64(16, progress.rendered_through_frame);
  write64(24, progress.accepted_through_frame);
  write64(32, progress.last_accepted_window_id);
  write64(40, progress.applied_transport_transition_id);
  write64(48, progress.applied_urgent_sequence);
  write64(56, progress.applied_processor_sequence);
  WriteU32(payload, 64, (progress.running ? 1U : 0U) | (progress.schedule_complete ? 2U : 0U));
  WriteU32(payload, 68, progress.instrument_credits);
  WriteU32(payload, 72, progress.source_credits);
  WriteU32(payload, 76, progress.automation_credits);
  write64(80, progress.admission_capacity_generation);
  write64(88, progress.latency_completion_generation);
  write64(96, progress.processor_patch_resolved_token);
  WriteU32(payload, 104, progress.processor_patch_resolved_result);
  WriteU32(payload, 108, 0);
  return payload;
}

std::string CoreAudioDeviceId(std::string_view uid) {
  return uid.empty() ? std::string{} : "coreaudio:" + std::string(uid);
}

std::optional<std::string> CoreAudioDeviceUid(std::string_view device_id) {
  constexpr std::string_view prefix = "coreaudio:";
  if (!device_id.starts_with(prefix) || device_id.size() == prefix.size()) return std::nullopt;
  return std::string(device_id.substr(prefix.size()));
}

}  // namespace daw::audio_host_macos
