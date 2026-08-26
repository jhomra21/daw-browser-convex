#include "daw/native-schedule-state.h"

namespace daw::audio_host_macos {
void NativeScheduleAutomationState::clear() noexcept {
  for (std::size_t index = 0; index < group_count; ++index) {
    groups[index].attachment = nullptr;
    groups[index].count = 0;
  }
  group_count = 0;
  segment_count = 0;
}
}
