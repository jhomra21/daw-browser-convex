#include "daw/audio_host_macos.h"

#include <array>
#include <cassert>
#include <cstdint>
#include <cstring>
#include <optional>
#include <span>
#include <string_view>
#include <sys/wait.h>
#include <unistd.h>
#include <vector>

namespace {

void AppendU32(std::vector<std::uint8_t>& bytes, const std::uint32_t value) {
  bytes.push_back(static_cast<std::uint8_t>(value >> 24U));
  bytes.push_back(static_cast<std::uint8_t>(value >> 16U));
  bytes.push_back(static_cast<std::uint8_t>(value >> 8U));
  bytes.push_back(static_cast<std::uint8_t>(value));
}

void AppendU64(std::vector<std::uint8_t>& bytes, const std::uint64_t value) {
  for (int index = 7; index >= 0; --index) bytes.push_back(static_cast<std::uint8_t>(value >> (index * 8)));
}

void AppendString(std::vector<std::uint8_t>& bytes, const std::string_view value) {
  AppendU32(bytes, static_cast<std::uint32_t>(value.size()));
  bytes.insert(bytes.end(), value.begin(), value.end());
}

bool WriteAll(const int descriptor, const std::span<const std::uint8_t> bytes) {
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    const auto written = write(descriptor, bytes.data() + offset, bytes.size() - offset);
    if (written <= 0) return false;
    offset += static_cast<std::size_t>(written);
  }
  return true;
}

bool ReadAll(const int descriptor, std::span<std::uint8_t> bytes) {
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    const auto read_bytes = read(descriptor, bytes.data() + offset, bytes.size() - offset);
    if (read_bytes <= 0) return false;
    offset += static_cast<std::size_t>(read_bytes);
  }
  return true;
}

std::uint32_t ReadU32(const std::uint8_t* bytes) {
  return (static_cast<std::uint32_t>(bytes[0]) << 24U) | (static_cast<std::uint32_t>(bytes[1]) << 16U)
    | (static_cast<std::uint32_t>(bytes[2]) << 8U) | static_cast<std::uint32_t>(bytes[3]);
}

std::optional<daw::audio_host_macos::ControlFrame> RoundTrip(
  const int input,
  const int output,
  const daw::audio_host_macos::ControlType type,
  const std::span<const std::uint8_t> payload = {}
) {
  const auto request = daw::audio_host_macos::EncodeControlFrame(type, payload);
  if (!WriteAll(input, request)) return std::nullopt;
  std::array<std::uint8_t, daw::audio_host_macos::kControlFrameHeaderBytes> header{};
  if (!ReadAll(output, header)) return std::nullopt;
  const auto payload_size = ReadU32(header.data() + 12);
  std::vector<std::uint8_t> response(header.begin(), header.end());
  response.resize(response.size() + payload_size);
  if (payload_size != 0 && !ReadAll(output, {response.data() + header.size(), payload_size})) return std::nullopt;
  return daw::audio_host_macos::DecodeControlFrame(response);
}

bool IsAck(
  const std::optional<daw::audio_host_macos::ControlFrame>& response,
  const daw::audio_host_macos::ControlType request,
  const bool success
) {
  return response && response->type == daw::audio_host_macos::ControlType::kAck
    && response->payload.size() == 8
    && ReadU32(response->payload.data()) == static_cast<std::uint32_t>(request)
    && ReadU32(response->payload.data() + 4) == static_cast<std::uint32_t>(success);
}

std::vector<std::uint8_t> Attachment() {
  std::vector<std::uint8_t> payload;
  AppendString(payload, "b0c4db1e-bd48-46d4-a4bc-f5ad1fe6c6f1");
  AppendString(payload, "0123456789abcdef0123456789abcdef");
  AppendString(payload, "Example Vendor");
  AppendString(payload, "/private/catalog/Example.vst3");
  AppendString(payload, "/private/catalog/Example.vst3/Contents/MacOS/Example");
  AppendU64(payload, 17);
  payload.push_back(1);
  payload.insert(payload.end(), 32, 1);
  payload.insert(payload.end(), 32, 2);
  AppendU32(payload, 2);
  payload.insert(payload.end(), {1, 2, 2, 0});
  AppendU32(payload, 32);
  AppendU32(payload, 4);
  AppendU32(payload, 2);
  AppendU32(payload, 4);
  AppendU32(payload, 2);
  AppendU32(payload, 2);
  AppendU32(payload, 128);
  return payload;
}

}  // namespace

int main(int argc, char* argv[]) {
  assert(argc == 2);
  int to_host[2]{};
  int from_host[2]{};
  assert(pipe(to_host) == 0 && pipe(from_host) == 0);
  const auto child = fork();
  assert(child >= 0);
  if (child == 0) {
    close(to_host[1]);
    close(from_host[0]);
    assert(dup2(to_host[0], STDIN_FILENO) >= 0);
    assert(dup2(from_host[1], STDOUT_FILENO) >= 0);
    close(to_host[0]);
    close(from_host[1]);
    execl(argv[1], argv[1], nullptr);
    _exit(127);
  }
  close(to_host[0]);
  close(from_host[1]);
  assert(IsAck(RoundTrip(to_host[1], from_host[0], daw::audio_host_macos::ControlType::kTransactionBegin),
    daw::audio_host_macos::ControlType::kTransactionBegin, true));
  const auto attachment = Attachment();
  assert(IsAck(RoundTrip(to_host[1], from_host[0], daw::audio_host_macos::ControlType::kVstAttach, attachment),
    daw::audio_host_macos::ControlType::kVstAttach, true));
  assert(IsAck(RoundTrip(to_host[1], from_host[0], daw::audio_host_macos::ControlType::kTransactionRollback),
    daw::audio_host_macos::ControlType::kTransactionRollback, true));
  assert(IsAck(RoundTrip(to_host[1], from_host[0], daw::audio_host_macos::ControlType::kTransactionBegin),
    daw::audio_host_macos::ControlType::kTransactionBegin, true));
  std::vector<std::uint8_t> instance_id;
  AppendString(instance_id, "b0c4db1e-bd48-46d4-a4bc-f5ad1fe6c6f1");
  assert(IsAck(RoundTrip(to_host[1], from_host[0], daw::audio_host_macos::ControlType::kVstDetach, instance_id),
    daw::audio_host_macos::ControlType::kVstDetach, false));
  assert(IsAck(RoundTrip(to_host[1], from_host[0], daw::audio_host_macos::ControlType::kTransactionRollback),
    daw::audio_host_macos::ControlType::kTransactionRollback, true));
  close(to_host[1]);
  close(from_host[0]);
  int status = 0;
  assert(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
  return 0;
}
