#include "control-frame.h"

#include <array>

namespace daw::plugin_host {

std::optional<std::size_t> ReadFrameLength(std::span<const std::uint8_t> header) {
  if (header.size() != 4) return std::nullopt;
  const auto size = (static_cast<std::size_t>(header[0]) << 24U)
    | (static_cast<std::size_t>(header[1]) << 16U)
    | (static_cast<std::size_t>(header[2]) << 8U)
    | static_cast<std::size_t>(header[3]);
  if (size == 0 || size > kMaximumControlFrameBytes) return std::nullopt;
  return size;
}

std::optional<ControlMessage> DecodeControlMessage(std::string_view type) {
  constexpr std::array<std::pair<std::string_view, ControlMessage>, 6> messages{{
    {"scan", ControlMessage::kScan},
    {"instantiate", ControlMessage::kInstantiate},
    {"dispose", ControlMessage::kDispose},
    {"set-parameters", ControlMessage::kSetParameters},
    {"editor", ControlMessage::kEditor},
    {"state", ControlMessage::kState},
  }};
  for (const auto& [name, message] : messages) {
    if (type == name) return message;
  }
  return std::nullopt;
}

}  // namespace daw::plugin_host
