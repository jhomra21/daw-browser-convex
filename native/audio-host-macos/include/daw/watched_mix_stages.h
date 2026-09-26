#pragma once

#include <atomic>
#include <cstdint>
#include <limits>

namespace daw::audio_host_macos {

struct WatchedMixStageSnapshot {
  std::uint32_t published = 0;
  std::uint32_t projected = 0;
  std::uint32_t override_skips = 0;
  std::uint32_t submitted = 0;
};

// Per-attachment atomic breadcrumbs. Counts saturate; a mismatched epoch is never reported.
struct WatchedMixStages {
  std::atomic<std::uint32_t> epoch{0};
  std::atomic<std::uint32_t> published{0};
  std::atomic<std::uint32_t> projected{0};
  std::atomic<std::uint32_t> override_skips{0};
  std::atomic<std::uint32_t> submitted{0};

  static void Increment(std::atomic<std::uint32_t>& counter, std::uint32_t amount) noexcept {
    auto value = counter.load(std::memory_order_relaxed);
    while (value != std::numeric_limits<std::uint32_t>::max()) {
      const auto next = amount > std::numeric_limits<std::uint32_t>::max() - value
        ? std::numeric_limits<std::uint32_t>::max() : value + amount;
      if (counter.compare_exchange_weak(value, next, std::memory_order_relaxed)) break;
    }
  }

  void Publish(std::uint32_t current, std::uint32_t parameter, std::uint32_t count) noexcept {
    if (current == 0 || parameter != 48 || count == 0) return;
    if (epoch.load(std::memory_order_acquire) != current) {
      published.store(0, std::memory_order_relaxed);
      projected.store(0, std::memory_order_relaxed);
      override_skips.store(0, std::memory_order_relaxed);
      submitted.store(0, std::memory_order_relaxed);
      epoch.store(current, std::memory_order_release);
    }
    Increment(published, count);
  }

  void Project(std::uint32_t current, std::uint32_t parameter, std::uint32_t count) noexcept {
    if (parameter == 48 && current != 0 && epoch.load(std::memory_order_acquire) == current)
      Increment(projected, count);
  }
  void Override(std::uint32_t current, std::uint32_t parameter) noexcept {
    if (parameter == 48 && current != 0 && epoch.load(std::memory_order_acquire) == current)
      Increment(override_skips, 1);
  }
  void Submit(std::uint32_t current, std::uint32_t parameter, bool accepted) noexcept {
    if (accepted && parameter == 48 && current != 0 && epoch.load(std::memory_order_acquire) == current)
      Increment(submitted, 1);
  }
  WatchedMixStageSnapshot Read(std::uint32_t current) const noexcept {
    if (current == 0 || epoch.load(std::memory_order_acquire) != current) return {};
    const WatchedMixStageSnapshot result{
      published.load(std::memory_order_relaxed), projected.load(std::memory_order_relaxed),
      override_skips.load(std::memory_order_relaxed), submitted.load(std::memory_order_relaxed),
    };
    return epoch.load(std::memory_order_acquire) == current ? result : WatchedMixStageSnapshot{};
  }
};
}  // namespace daw::audio_host_macos
