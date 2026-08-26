#pragma once

#include <cstdint>
#include <span>

#include "daw/audio_host_macos.h"

namespace daw::audio_host_macos {

constexpr std::uint32_t kProcessorAutomationExtensionMagic = 0x31524150U;
constexpr std::size_t kProcessorAutomationRecordBytes = 40;

bool QueueScheduleWindowWithProcessorAutomation(
  AudioHost& host,
  std::span<const std::uint8_t> payload);

bool QueueParameterEventsWithAutomationOverride(
  AudioHost& host,
  std::span<const std::uint8_t> payload);

bool ReenableScheduleAutomation(
  AudioHost& host,
  std::span<const std::uint8_t> payload);

bool ProcessPlanarWithProcessorAutomation(
  AudioHost& host,
  std::span<const float* const> input,
  std::span<float* const> output,
  std::uint32_t frame_count);

void ResetProcessorAutomationState() noexcept;

}  // namespace daw::audio_host_macos
