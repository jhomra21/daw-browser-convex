#pragma once

#include "daw/audio_host_macos.h"
#include <string>
#include <string_view>

namespace daw::audio_host_macos {

inline std::string_view RejectedBlockReasonName(const RejectedBlockReason reason) {
  switch (reason) {
    case RejectedBlockReason::kNotRunningOrCoreUnavailable: return "not-running-or-core-unavailable";
    case RejectedBlockReason::kInsufficientChannels: return "insufficient-channels";
    case RejectedBlockReason::kNullChannel: return "null-channel";
    case RejectedBlockReason::kTransport: return "transport";
    case RejectedBlockReason::kScratchCapacity: return "scratch-capacity";
    case RejectedBlockReason::kProcessorEventCapacity: return "processor-event-capacity";
    case RejectedBlockReason::kInstrumentEventCapacity: return "instrument-event-capacity";
    case RejectedBlockReason::kSourceSchedule: return "source-schedule";
    case RejectedBlockReason::kCoreProcess: return "core-process";
    case RejectedBlockReason::kNone: return "none";
  }
  return "unknown";
}

inline std::string NativeOfflineFailureMessage(const Diagnostics& diagnostics) {
  if (diagnostics.last_rejected_reason == RejectedBlockReason::kCoreProcess
    && diagnostics.last_rejected_instrument_event_count > 0) {
    return "Native offline rendering failed because one or more instrument events were rejected; the export was not completed.";
  }
  return "Native offline rendering failed (reason: "
    + std::string(RejectedBlockReasonName(diagnostics.last_rejected_reason))
    + ", core result: " + std::to_string(diagnostics.last_rejected_core_result)
    + ", frames: " + std::to_string(diagnostics.last_rejected_frame_count)
    + ", channels: " + std::to_string(diagnostics.last_rejected_channel_count)
    + ").";
}

} // namespace daw::audio_host_macos
