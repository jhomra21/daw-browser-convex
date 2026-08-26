#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace daw::audio_host_macos {

struct NativeScheduleAutomationSegment {
  std::uint32_t parameter_id = 0;
  std::uint64_t start_frame = 0;
  std::uint64_t end_frame = 0;
  double start_value = 0.0;
  double end_value = 0.0;
  bool linear = false;
};

struct NativeScheduleAutomationGroup {
  void* attachment = nullptr;
  std::array<NativeScheduleAutomationSegment, 2'048> segments{};
  std::size_t count = 0;
};

struct NativeScheduleAutomationState {
  static constexpr std::size_t kMaximumAttachments = 64;
  static constexpr std::size_t kMaximumSegments = 2'048;
  std::array<NativeScheduleAutomationGroup, kMaximumAttachments> groups{};
  std::size_t group_count = 0;
  std::size_t segment_count = 0;
  void clear() noexcept;
};

}  // namespace daw::audio_host_macos
