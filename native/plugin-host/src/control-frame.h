#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string_view>

namespace daw::plugin_host {

constexpr std::size_t kMaximumControlFrameBytes = 1'048'576;

enum class ControlMessage {
  kScan,
  kInstantiate,
  kDispose,
  kSetParameters,
  kEditor,
  kState,
};

std::optional<std::size_t> ReadFrameLength(std::span<const std::uint8_t> header);
std::optional<ControlMessage> DecodeControlMessage(std::string_view type);

}  // namespace daw::plugin_host
