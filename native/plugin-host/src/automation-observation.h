#pragma once

#include "worker-supervisor.h"

#include <cstdint>
#include <limits>

namespace daw::plugin_host {

// A block-local, allocation-free summary of scheduled points accepted into VST input queues.
struct AutomationObservation {
  std::uint32_t count = 0;
  std::uint32_t parameterId = 0;
  std::uint32_t transportEpoch = 0;

  void Accept(const WorkerTransportEvent& event, const std::uint32_t epoch) noexcept {
    if (event.kind != WorkerEventKind::kParameter || !event.scheduledAutomation) return;
    if (count < std::numeric_limits<std::uint32_t>::max()) ++count;
    parameterId = event.parameterId;
    transportEpoch = epoch;
  }
};

}  // namespace daw::plugin_host
