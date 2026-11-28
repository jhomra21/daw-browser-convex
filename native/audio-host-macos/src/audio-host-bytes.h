#pragma once

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace daw::audio_host_macos {

inline std::uint32_t ReadU32(const std::uint8_t* bytes) {
  return (static_cast<std::uint32_t>(bytes[0]) << 24U)
    | (static_cast<std::uint32_t>(bytes[1]) << 16U)
    | (static_cast<std::uint32_t>(bytes[2]) << 8U)
    | static_cast<std::uint32_t>(bytes[3]);
}

inline std::uint32_t ReadLeU32(const std::uint8_t* bytes) {
  return static_cast<std::uint32_t>(bytes[0])
    | (static_cast<std::uint32_t>(bytes[1]) << 8U)
    | (static_cast<std::uint32_t>(bytes[2]) << 16U)
    | (static_cast<std::uint32_t>(bytes[3]) << 24U);
}

inline std::uint64_t ReadLeU64(const std::uint8_t* bytes) {
  std::uint64_t value = 0;
  for (std::size_t index = 0; index < 8; ++index) value |= static_cast<std::uint64_t>(bytes[index]) << (index * 8U);
  return value;
}

inline std::int64_t ReadLeI64(const std::uint8_t* bytes) {
  return static_cast<std::int64_t>(ReadLeU64(bytes));
}

inline float ReadLeFloat(const std::uint8_t* bytes) {
  const std::uint32_t bits = ReadLeU32(bytes);
  float value = 0.0F;
  std::memcpy(&value, &bits, sizeof(value));
  return value;
}

inline double ReadLeDouble(const std::uint8_t* bytes) {
  const std::uint64_t bits = ReadLeU64(bytes);
  double value = 0.0;
  std::memcpy(&value, &bits, sizeof(value));
  return value;
}

inline void WriteU32(std::vector<std::uint8_t>& bytes, std::size_t offset, std::uint32_t value) {
  bytes[offset] = static_cast<std::uint8_t>(value >> 24U);
  bytes[offset + 1] = static_cast<std::uint8_t>(value >> 16U);
  bytes[offset + 2] = static_cast<std::uint8_t>(value >> 8U);
  bytes[offset + 3] = static_cast<std::uint8_t>(value);
}

inline std::string HexFingerprint(const std::array<std::uint8_t, 32>& fingerprint) {
  constexpr char kHex[] = "0123456789abcdef";
  std::string result;
  result.resize(fingerprint.size() * 2);
  for (std::size_t index = 0; index < fingerprint.size(); ++index) {
    result[index * 2] = kHex[fingerprint[index] >> 4U];
    result[index * 2 + 1] = kHex[fingerprint[index] & 0x0FU];
  }
  return result;
}

inline std::uint8_t MidiValue(const float value) noexcept {
  if (!std::isfinite(value) || value <= 0.0F) return 0;
  if (value >= 1.0F) return 127;
  return static_cast<std::uint8_t>(value * 127.0F);
}

}  // namespace daw::audio_host_macos
