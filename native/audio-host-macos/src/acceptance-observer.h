#pragma once

#include "acceptance-output-tap.h"
#include "daw/audio_core_native.h"

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>

namespace daw::audio_host_macos {

class AcceptanceObserver {
 public:
  explicit AcceptanceObserver(std::string evidence_directory)
    : evidence_directory_(std::move(evidence_directory)),
      tap_(std::make_unique<AcceptanceOutputTap>(evidence_directory_)) {}

  AcceptanceOutputTap* tap() noexcept { return tap_.get(); }
  void FinishCapture() { tap_.reset(); }
  const char* evidenceDirectory() const noexcept { return evidence_directory_.c_str(); }
  void Event(const char* event, const char* fields = "") const {
    daw::acceptance::Event(evidenceDirectory(), event, fields);
  }
  void Report(const char* event, const char* cause, std::uint32_t revision,
    std::uint32_t transport_epoch, std::int64_t frame, std::uint64_t render_epoch,
    std::int64_t publication_frame, std::uint64_t publication_epoch, std::uint32_t requested_revision,
    std::uint64_t retirement_epoch, const char* detail = "") const {
    char fields[768];
    std::snprintf(fields, sizeof(fields),
      ",\"cause\":\"%s\",\"revision\":%u,\"transportEpoch\":%u,\"frame\":%lld,"
      "\"renderEpoch\":\"%llu\",\"publicationFrame\":%lld,\"publicationEpoch\":\"%llu\","
      "\"requestedRevision\":%u,\"retirementEpoch\":\"%llu\"%s",
      cause, revision, transport_epoch, static_cast<long long>(frame),
      static_cast<unsigned long long>(render_epoch), static_cast<long long>(publication_frame),
      static_cast<unsigned long long>(publication_epoch), requested_revision,
      static_cast<unsigned long long>(retirement_epoch), detail);
    Event(event, fields);
  }
  void PublicationCommitted(const char* cause, std::uint32_t revision, std::uint32_t transport_epoch,
    std::int64_t frame, std::uint64_t render_epoch, std::int64_t publication_frame,
    std::uint64_t publication_epoch, std::uint64_t retirement_epoch) const {
    char detail[128];
    std::snprintf(detail, sizeof(detail),
      ",\"pinnedLatencyFrames\":%u,\"graphLatencyFrames\":%u,\"spectralPredecessors\":%u",
      pinnedLatency(), graphLatency(), spectralPredecessors());
    Report("graph-publish", cause, revision, transport_epoch, frame, render_epoch,
      publication_frame, publication_epoch, 0, retirement_epoch, detail);
  }
  struct PrepareMarks {
    std::chrono::steady_clock::time_point entered, controlled, before_core, after_core;
  };
  void ReportPrepare(std::uint32_t revision, daw_audio_core_handle core, const PrepareMarks& marks,
    std::uint32_t transport_epoch, std::int64_t frame, std::uint64_t render_epoch,
    std::int64_t publication_frame, std::uint64_t publication_epoch, std::uint64_t retirement_epoch) const {
    const auto done = std::chrono::steady_clock::now();
    char detail[512] = ",\"stepsUs\":\"";
    std::size_t used = std::strlen(detail);
    const auto add = [&](const char* step, std::uint64_t microseconds) {
      if (used + 48 >= sizeof(detail)) return;
      used += static_cast<std::size_t>(std::snprintf(detail + used, sizeof(detail) - used,
        "%s=%llu;", step, static_cast<unsigned long long>(microseconds)));
    };
    const auto between = [](const auto from, const auto to) {
      return static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::microseconds>(to - from).count());
    };
    add("vst-control", between(marks.entered, marks.controlled));
    add("host-pre", between(marks.controlled, marks.before_core));
    add("core", between(marks.before_core, marks.after_core));
    for (const auto& step : daw::audio_core::LastPrepareProfile(core)) add(step.step, step.nanoseconds / 1000);
    add("host-post", between(marks.after_core, done));
    detail[used] = '"';
    detail[used + 1] = '\0';
    Report("prepare-profile", "", revision, transport_epoch, frame, render_epoch,
      publication_frame, publication_epoch, revision, retirement_epoch, detail);
  }

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
  std::string evidence_directory_;
  std::unique_ptr<AcceptanceOutputTap> tap_;
  std::atomic<std::int64_t> publication_frame_ = 0;
  std::atomic<std::uint64_t> publication_epoch_ = 0;
  std::atomic<std::uint32_t> pinned_latency_ = 0;
  std::atomic<std::uint32_t> graph_latency_ = 0;
  std::atomic<std::uint32_t> spectral_predecessors_ = 0;
};

}  // namespace daw::audio_host_macos
