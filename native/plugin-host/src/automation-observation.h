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

// Block-local watched Mix counters; never attributes another parameter to Mix.
struct WatchedMixObservation {
  std::uint32_t submitted = 0;
  std::uint32_t added = 0;
  std::uint32_t processed = 0;
  std::uint32_t transportEpoch = 0;

  void Submitted(const WorkerTransportEvent& event, const std::uint32_t epoch) noexcept {
    if (event.kind != WorkerEventKind::kParameter || !event.scheduledAutomation
      || event.parameterId != 48 || epoch == 0) return;
    if (submitted < std::numeric_limits<std::uint32_t>::max()) ++submitted;
    transportEpoch = epoch;
  }

  void Added(const WorkerTransportEvent& event, const std::uint32_t epoch) noexcept {
    if (event.kind != WorkerEventKind::kParameter || !event.scheduledAutomation
      || event.parameterId != 48 || epoch == 0) return;
    if (added < std::numeric_limits<std::uint32_t>::max()) ++added;
    transportEpoch = epoch;
  }

  void Processed(const bool success) noexcept {
    if (success) processed = added;
  }
};

}  // namespace daw::plugin_host
