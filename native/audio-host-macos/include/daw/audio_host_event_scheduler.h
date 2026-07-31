#pragma once

#include "worker-supervisor.h"

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <span>

namespace daw::audio_host_macos {

class NativeVstEventScheduler final {
 public:
  static constexpr std::size_t kCapacity = daw::plugin_host::kMaximumWorkerEvents;

  bool QueueEvents(const std::span<const daw::plugin_host::WorkerTransportEvent> events) noexcept {
    if (events.size() > kCapacity) return false;
    const auto write = event_write_.load(std::memory_order_relaxed);
    const auto read = event_read_.load(std::memory_order_acquire);
    const auto occupancy = write - read;
    if (occupancy > kCapacity || events.size() > kCapacity - occupancy) return false;
    auto used = event_count_.load(std::memory_order_acquire);
    for (;;) {
      if (used > kCapacity || events.size() > kCapacity - used) return false;
      if (event_count_.compare_exchange_weak(
        used,
        used + static_cast<std::uint32_t>(events.size()),
        std::memory_order_acq_rel,
        std::memory_order_acquire
      )) break;
    }
    for (std::size_t index = 0; index < events.size(); ++index) {
      queued_events_[(write + index) % kCapacity] = events[index];
    }
    event_write_.store(write + static_cast<std::uint32_t>(events.size()), std::memory_order_release);
    return true;
  }

  bool PrepareBlock(
    const std::uint32_t frame_count,
    const std::span<daw::plugin_host::WorkerTransportEvent> block_events,
    std::size_t& event_count,
    const std::size_t maximum_events
  ) noexcept {
    if (prepared_ || frame_count == 0 || maximum_events > block_events.size()
      || event_count > maximum_events) return false;
    previous_scheduled_count_ = scheduled_count_;
    const auto write = event_write_.load(std::memory_order_acquire);
    const auto read = event_read_.load(std::memory_order_relaxed);
    std::uint32_t cursor = read;
    while (cursor != write) {
      scheduled_events_[scheduled_count_++] = queued_events_[cursor % kCapacity];
      ++cursor;
    }
    captured_write_ = write;
    emitted_count_ = 0;
    next_scheduled_count_ = 0;
    for (std::size_t index = 0; index < scheduled_count_; ++index) {
      auto event = scheduled_events_[index];
      if (event.sampleOffset < frame_count && event_count < maximum_events) {
        block_events[event_count++] = event;
        ++emitted_count_;
        continue;
      }
      if (event.sampleOffset < frame_count) event.sampleOffset = 0;
      else event.sampleOffset -= frame_count;
      next_scheduled_events_[next_scheduled_count_++] = event;
    }
    prepared_ = true;
    return true;
  }

  void CommitBlock(const bool accepted) noexcept {
    if (!prepared_) return;
    if (!accepted) {
      scheduled_count_ = previous_scheduled_count_;
      prepared_ = false;
      return;
    }
    event_count_.fetch_sub(static_cast<std::uint32_t>(emitted_count_), std::memory_order_acq_rel);
    scheduled_events_.swap(next_scheduled_events_);
    scheduled_count_ = next_scheduled_count_;
    event_read_.store(captured_write_, std::memory_order_release);
    prepared_ = false;
  }

 private:
  std::array<daw::plugin_host::WorkerTransportEvent, kCapacity> queued_events_{};
  std::array<daw::plugin_host::WorkerTransportEvent, kCapacity> scheduled_events_{};
  std::array<daw::plugin_host::WorkerTransportEvent, kCapacity> next_scheduled_events_{};
  std::atomic<std::uint32_t> event_read_ = 0;
  std::atomic<std::uint32_t> event_write_ = 0;
  std::atomic<std::uint32_t> event_count_ = 0;
  std::uint32_t captured_write_ = 0;
  std::size_t previous_scheduled_count_ = 0;
  std::size_t scheduled_count_ = 0;
  std::size_t next_scheduled_count_ = 0;
  std::size_t emitted_count_ = 0;
  bool prepared_ = false;
};

}  // namespace daw::audio_host_macos
