#pragma once

#include "pluginterfaces/base/funknown.h"
#include "pluginterfaces/vst/vsttypes.h"
#include "pluginterfaces/vst/vstspeaker.h"

#include <cstddef>
#include <optional>
#include <span>
#include <vector>

namespace daw::plugin_host {

[[nodiscard]] inline bool IsAcceptedWorkerProcessingTransitionResult(const Steinberg::tresult result) {
  return result == Steinberg::kResultOk
    || result == Steinberg::kResultTrue
    || result == Steinberg::kNotImplemented;
}

[[nodiscard]] inline std::optional<std::vector<Steinberg::Vst::SpeakerArrangement>>
SelectWorkerBusArrangements(
  const std::span<const Steinberg::Vst::SpeakerArrangement> current,
  const std::size_t expectedChannels
) {
  using Steinberg::Vst::SpeakerArrangement;
  using Steinberg::Vst::SpeakerArr::getChannelCount;

  if (expectedChannels == 0) {
    return current.empty() ? std::optional<std::vector<SpeakerArrangement>>(std::vector<SpeakerArrangement>{})
                           : std::nullopt;
  }
  if (current.empty()) return std::nullopt;

  std::size_t currentChannels = 0;
  for (std::size_t index = 0; index < current.size(); ++index) {
    const auto arrangement = current[index];
    const auto channels = getChannelCount(arrangement);
    if (channels <= 0 || static_cast<std::size_t>(channels) > expectedChannels
      || currentChannels > expectedChannels - static_cast<std::size_t>(channels)) {
      break;
    }
    currentChannels += static_cast<std::size_t>(channels);
    if (currentChannels == expectedChannels) {
      return std::vector<SpeakerArrangement>(current.begin(), current.begin() + static_cast<std::ptrdiff_t>(index + 1));
    }
  }
  return std::nullopt;
}

}  // namespace daw::plugin_host
