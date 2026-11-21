#pragma once

#include "audio-host-limits.h"
#include "worker-control-service.h"
#include "daw/audio_core_native.h"

#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>

namespace daw::audio_host_macos {

struct NativeMeterObserver {
  static constexpr std::uint32_t kMeterReadyBit = 1U << 2U;
  struct Event {
    std::uint32_t graph_revision = 0;
    std::uint32_t transport_epoch = 0;
    std::uint64_t node_id = 0;
    float left_rms = 0.0F;
    float right_rms = 0.0F;
  };
  daw::plugin_host::SpscQueue<Event, kMaximumMeterQueueEntries> queue;
  std::atomic<std::uint32_t>* bridge_pending = nullptr;

  void Observe(const daw::audio_core::NativeGraphNodeRender& render) noexcept {
    if (!queue.HasSpace() || render.frame_count == 0 || render.channel_count == 0 || render.planes[0] == nullptr) return;
    double left_sum = 0.0;
    double right_sum = 0.0;
    const float* const left = render.planes[0];
    const float* const right = render.channel_count > 1 && render.planes[1] != nullptr ? render.planes[1] : left;
    for (std::uint32_t frame = 0; frame < render.frame_count; ++frame) {
      const float left_sample = std::isfinite(left[frame]) ? left[frame] : 0.0F;
      const float right_sample = std::isfinite(right[frame]) ? right[frame] : 0.0F;
      left_sum += static_cast<double>(left_sample) * left_sample;
      right_sum += static_cast<double>(right_sample) * right_sample;
    }
    if (!queue.TryPush({
      .graph_revision = render.graph_revision,
      .transport_epoch = render.transport_epoch,
      .node_id = render.node_id,
      .left_rms = static_cast<float>(std::sqrt(left_sum / render.frame_count)),
      .right_rms = static_cast<float>(std::sqrt(right_sum / render.frame_count)),
    })) return;
    if (bridge_pending != nullptr) bridge_pending->fetch_or(kMeterReadyBit, std::memory_order_release);
  }

  [[nodiscard]] bool Empty() const noexcept { return queue.Empty(); }

  bool Pop(Event& event) noexcept { return queue.TryPop(event); }

  void Clear() noexcept {
    Event event{};
    while (Pop(event)) {}
  }

  static void Dispatch(const daw::audio_core::NativeGraphNodeRender& render) noexcept {
    auto* observer = static_cast<NativeMeterObserver*>(render.attachment);
    if (observer != nullptr) observer->Observe(render);
  }
};

struct NativeSpectrumObserver {
  struct Event {
    std::uint32_t graph_revision = 0;
    std::uint32_t transport_epoch = 0;
    std::uint64_t node_id = 0;
    std::uint32_t frame_count = 0;
    std::uint32_t sample_rate_hz = 0;
    std::array<float, kSpectrumFftSize> left{};
    std::array<float, kSpectrumFftSize> right{};
  };
  daw::plugin_host::SpscQueue<Event, kMaximumSpectrumQueueEntries> queue;
  std::atomic<std::uint64_t>* selected_node = nullptr;
  std::atomic<std::uint32_t>* bridge_pending = nullptr;
  void Observe(const daw::audio_core::NativeGraphNodeRender& render) noexcept {
    if (selected_node == nullptr || render.node_id != selected_node->load(std::memory_order_acquire)
      || render.frame_count == 0 || render.frame_count > kSpectrumFftSize
      || render.planes[0] == nullptr) return;
    Event event{};
    event.graph_revision = render.graph_revision;
    event.transport_epoch = render.transport_epoch;
    event.node_id = render.node_id;
    event.frame_count = render.frame_count;
    event.sample_rate_hz = render.sample_rate_hz;
    for (std::uint32_t frame = 0; frame < render.frame_count; ++frame) {
      event.left[frame] = std::isfinite(render.planes[0][frame]) ? render.planes[0][frame] : 0.0F;
      event.right[frame] = render.channel_count > 1 && render.planes[1] != nullptr && std::isfinite(render.planes[1][frame])
        ? render.planes[1][frame] : event.left[frame];
    }
    if (queue.TryPush(event) && bridge_pending != nullptr) {
      bridge_pending->fetch_or(1U << 4U, std::memory_order_release);
    }
  }
  [[nodiscard]] bool Empty() const noexcept { return queue.Empty(); }
  bool Pop(Event& event) noexcept { return queue.TryPop(event); }
  void Clear() noexcept { Event event{}; while (Pop(event)) {} }
  static void Dispatch(const daw::audio_core::NativeGraphNodeRender& render) noexcept {
    auto* observer = static_cast<NativeSpectrumObserver*>(render.attachment);
    if (observer != nullptr) observer->Observe(render);
  }
};

struct NativeTelemetryObserver {
  NativeMeterObserver* meter = nullptr;
  NativeSpectrumObserver* spectrum = nullptr;
  static void Dispatch(const daw::audio_core::NativeGraphNodeRender& render) noexcept {
    auto* observer = static_cast<NativeTelemetryObserver*>(render.attachment);
    if (observer == nullptr) return;
    if (observer->meter != nullptr) observer->meter->Observe(render);
    if (observer->spectrum != nullptr) observer->spectrum->Observe(render);
  }
};

}  // namespace daw::audio_host_macos
