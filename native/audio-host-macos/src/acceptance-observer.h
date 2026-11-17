#pragma once

#include "acceptance-output-tap.h"

#include <atomic>
#include <cstdint>
#include <memory>

namespace daw::audio_host_macos {

class AcceptanceObserver {
 public:
  AcceptanceObserver() : tap_(std::make_unique<AcceptanceOutputTap>()) {}

  AcceptanceOutputTap* tap() noexcept { return tap_.get(); }
  void FinishCapture() { tap_.reset(); }

  void SetPublicationPosition(std::int64_t frame, std::uint64_t epoch) noexcept {
    publication_frame_.store(frame, std::memory_order_relaxed);
    publication_epoch_.store(epoch, std::memory_order_relaxed);
  }

  [[nodiscard]] std::int64_t publicationFrame() const noexcept {
    return publication_frame_.load(std::memory_order_acquire);
  }

  [[nodiscard]] std::uint64_t publicationEpoch() const noexcept {
    return publication_epoch_.load(std::memory_order_acquire);
  }

  void SetPublicationLatency(std::uint32_t pinned, std::uint32_t graph, std::uint32_t predecessors) noexcept {
    pinned_latency_.store(pinned, std::memory_order_relaxed);
    graph_latency_.store(graph, std::memory_order_relaxed);
    spectral_predecessors_.store(predecessors, std::memory_order_relaxed);
  }

  [[nodiscard]] std::uint32_t pinnedLatency() const noexcept {
    return pinned_latency_.load(std::memory_order_relaxed);
  }

  [[nodiscard]] std::uint32_t graphLatency() const noexcept {
    return graph_latency_.load(std::memory_order_relaxed);
  }

  [[nodiscard]] std::uint32_t spectralPredecessors() const noexcept {
    return spectral_predecessors_.load(std::memory_order_relaxed);
  }

  std::uint64_t observedProcessorSequence = 0;
  std::uint32_t observedEpoch = UINT32_MAX;
  bool observedRunning = false;
  std::uint64_t workerOrdinal = 0;

 private:
  std::unique_ptr<AcceptanceOutputTap> tap_;
  std::atomic<std::int64_t> publication_frame_ = 0;
  std::atomic<std::uint64_t> publication_epoch_ = 0;
  std::atomic<std::uint32_t> pinned_latency_ = 0;
  std::atomic<std::uint32_t> graph_latency_ = 0;
  std::atomic<std::uint32_t> spectral_predecessors_ = 0;
};

}  // namespace daw::audio_host_macos
