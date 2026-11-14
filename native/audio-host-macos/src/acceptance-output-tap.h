#pragma once

#include "../../acceptance-evidence.h"
#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <memory>

namespace daw::audio_host_macos {

// Private acceptance diagnostic. One callback producer, existing RT bridge consumer.
// Storage is allocated/prefaulted before the device starts; never a recording target.
class AcceptanceOutputTap {
 public:
  static constexpr std::uint64_t kCapacity = 1U << 20U;
  AcceptanceOutputTap() : samples_(std::make_unique<float[]>(kCapacity * 2)) {
    static_assert(std::atomic<std::uint64_t>::is_always_lock_free);
    // Touch every page off-thread, including calloc-backed zero pages.
    volatile float* pages = samples_.get();
    for (std::uint64_t index = 0; index < kCapacity * 2; index += 1024) pages[index] = 0;
    // Control-thread ordinal distinguishes transaction hosts in the same process.
    static std::atomic<std::uint64_t> next{0};
    id_ = ++next;
  }
  ~AcceptanceOutputTap() { Finish(); }

  void Configure(std::uint32_t rate, std::uint32_t channels) {
    if (file_) return;
    char name[4096];
    std::snprintf(name, sizeof(name), "%s/output-%d-%llu.wav",
      std::getenv("DAW_AE08_EVIDENCE_DIR"), getpid(), static_cast<unsigned long long>(id_));
    const auto descriptor = open(name, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (descriptor >= 0) {
      file_ = fdopen(descriptor, "wb");
      if (!file_) close(descriptor);
    }
    rate_ = rate;
    supported_ = channels == 2 && file_ != nullptr;
    if (file_) {
      std::array<char, 44> header{};
      if (std::fwrite(header.data(), 1, header.size(), file_) != header.size()) failed_ = true;
    }
    if (!supported_) failed_ = true;
    acceptance::Event("capture-configure", supported_ ? ",\"supported\":true" : ",\"supported\":false");
  }

  // DAW_REALTIME_CALLBACK_HELPER_BEGIN acceptance-output-tap
  void Push(float* const* planes, std::uint32_t frames, std::uint32_t revision = 0,
    std::uint32_t epoch = 0, std::int64_t transport_frame = 0) noexcept {
    if (!supported_) return;
    const auto write = write_.load(std::memory_order_relaxed);
    const auto read = read_.load(std::memory_order_acquire);
    const auto packet = packet_write_.load(std::memory_order_relaxed);
    if (frames > kCapacity - (write - read)
      || packet - packet_read_.load(std::memory_order_acquire) >= packets_.size()) {
      overflow_.fetch_add(frames, std::memory_order_relaxed);
      return;
    }
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
      const auto at = ((write + frame) % kCapacity) * 2;
      samples_[at] = planes[0][frame];
      samples_[at + 1] = planes[1][frame];
    }
    // Darwin steady_clock reads mach_absolute_time, no allocation, lock or
    // scheduler call. The timestamp records device downtime, not wall-clock I/O.
    packets_[packet % packets_.size()] = {
      .offset = write, .frames = frames,
      .monotonic_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count(),
      .revision = revision, .epoch = epoch, .transport_frame = transport_frame,
    };
    write_.store(write + frames, std::memory_order_release);
    packet_write_.store(packet + 1, std::memory_order_release);
  }
  // DAW_REALTIME_CALLBACK_HELPER_END acceptance-output-tap

  void Drain() {
    if (!file_) return;
    auto read = read_.load(std::memory_order_relaxed);
    const auto write = write_.load(std::memory_order_acquire);
    if (!started_ && write > read) {
      // Observed on the bridge, bounded by its existing 100us wake interval.
      char fields[384];
      std::snprintf(fields, sizeof(fields),
        ",\"sampleRate\":%u,\"captureId\":%llu,\"bufferedFrames\":%llu", rate_,
        static_cast<unsigned long long>(id_), static_cast<unsigned long long>(write - read));
      acceptance::Event("capture-first-drain", fields);
      started_ = true;
    }
    while (read < write) {
      const auto count = std::min(write - read, kCapacity - read % kCapacity);
      if (std::fwrite(samples_.get() + (read % kCapacity) * 2, sizeof(float) * 2, count, file_) != count) failed_ = true;
      read += count;
      written_ += count;
    }
    read_.store(read, std::memory_order_release);
    auto packet = packet_read_.load(std::memory_order_relaxed);
    const auto end = packet_write_.load(std::memory_order_acquire);
    while (packet < end) {
      const auto& value = packets_[packet % packets_.size()];
      // A newer packet may have arrived after this drain's audio snapshot.
      if (value.offset + value.frames > write) break;
      char fields[256];
      std::snprintf(fields, sizeof(fields),
        ",\"captureId\":%llu,\"offset\":%llu,\"frames\":%u,\"callbackMonotonicNs\":\"%lld\","
        "\"revision\":%u,\"transportEpoch\":%u,\"transportFrame\":%lld",
        static_cast<unsigned long long>(id_), static_cast<unsigned long long>(value.offset),
        value.frames, static_cast<long long>(value.monotonic_ns), value.revision, value.epoch,
        static_cast<long long>(value.transport_frame));
      acceptance::Event("capture-block", fields);
      ++packet;
    }
    packet_read_.store(packet, std::memory_order_release);
  }

 private:
  void Finish() {
    if (!file_) return;
    Drain();
    // macOS acceptance artifacts are little-endian IEEE float stereo WAV.
    std::array<unsigned char, 44> header{};
    const auto u32 = [&](std::size_t at, std::uint32_t value) {
      for (unsigned byte = 0; byte < 4; ++byte) header[at + byte] = value >> (byte * 8);
    };
    const auto bytes = written_ * 8;
    if (bytes > UINT32_MAX - 36) failed_ = true;
    std::memcpy(header.data(), "RIFF", 4); u32(4, 36 + bytes);
    std::memcpy(header.data() + 8, "WAVEfmt ", 8); u32(16, 16);
    header[20] = 3; header[22] = 2; u32(24, rate_); u32(28, rate_ * 8);
    header[32] = 8; header[34] = 32;
    std::memcpy(header.data() + 36, "data", 4); u32(40, bytes);
    if (std::fseek(file_, 0, SEEK_SET) != 0
      || std::fwrite(header.data(), 1, header.size(), file_) != header.size()) failed_ = true;
    if (std::fclose(file_) != 0) failed_ = true;
    file_ = nullptr;
    char fields[256];
    std::snprintf(fields, sizeof(fields),
      ",\"captureId\":%llu,\"frames\":%llu,\"overflowFrames\":%llu,\"failed\":%s",
      static_cast<unsigned long long>(id_),
      static_cast<unsigned long long>(written_),
      static_cast<unsigned long long>(overflow_.load()), failed_ ? "true" : "false");
    acceptance::Event("capture-complete", fields);
  }
  std::unique_ptr<float[]> samples_;
  alignas(64) std::atomic<std::uint64_t> write_ = 0;
  alignas(64) std::atomic<std::uint64_t> read_ = 0;
  std::atomic<std::uint64_t> overflow_ = 0;
  struct Packet { std::uint64_t offset = 0; std::uint32_t frames = 0; std::int64_t monotonic_ns = 0;
    std::uint32_t revision = 0; std::uint32_t epoch = 0; std::int64_t transport_frame = 0; };
  std::array<Packet, 8192> packets_{};
  std::atomic<std::uint64_t> packet_write_ = 0;
  std::atomic<std::uint64_t> packet_read_ = 0;
  FILE* file_ = nullptr;
  std::uint64_t written_ = 0;
  std::uint64_t id_ = 0;
  std::uint32_t rate_ = 0;
  bool supported_ = false;
  bool started_ = false;
  bool failed_ = false;
};

}  // namespace daw::audio_host_macos
