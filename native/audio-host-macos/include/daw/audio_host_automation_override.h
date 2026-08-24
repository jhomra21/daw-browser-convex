#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>

namespace daw::audio_host_macos {

class NativeVstAutomationOverrideTable final {
 public:
  enum class SetResult : std::uint8_t {
    kAlreadyPresent,
    kInserted,
    kFull,
  };
  static constexpr std::size_t kCapacity = 4'096;

  bool Has(const std::uint32_t parameter_id) const noexcept {
    std::size_t slot = Slot(parameter_id);
    for (std::size_t probe = 0; probe < kCapacity; ++probe) {
      const auto state = states_[slot].load(std::memory_order_acquire);
      if (state == kEmpty) return false;
      if (state == kOccupied && ids_[slot].load(std::memory_order_relaxed) == parameter_id) return true;
      slot = (slot + 1) % kCapacity;
    }
    return false;
  }

  SetResult Set(const std::uint32_t parameter_id) noexcept {
    std::size_t slot = Slot(parameter_id);
    std::size_t first_tombstone = kCapacity;
    bool saw_reserved = false;
    for (std::size_t probe = 0; probe < kCapacity; ++probe) {
      const auto state = states_[slot].load(std::memory_order_acquire);
      if (state == kOccupied && ids_[slot].load(std::memory_order_relaxed) == parameter_id) {
        return SetResult::kAlreadyPresent;
      }
      if (state == kReserved) {
        saw_reserved = true;
        slot = (slot + 1) % kCapacity;
        continue;
      }
      if (state == kTombstone) {
        if (first_tombstone == kCapacity) first_tombstone = slot;
      } else if (state == kEmpty) {
        if (saw_reserved) return SetResult::kFull;
        const auto insertion_slot = first_tombstone == kCapacity ? slot : first_tombstone;
        auto expected = states_[insertion_slot].load(std::memory_order_acquire);
        if (states_[insertion_slot].compare_exchange_weak(
          expected,
          kReserved,
          std::memory_order_acq_rel,
          std::memory_order_acquire
        )) {
          ids_[insertion_slot].store(parameter_id, std::memory_order_relaxed);
          states_[insertion_slot].store(kOccupied, std::memory_order_release);
          return SetResult::kInserted;
        }
        slot = Slot(parameter_id);
        first_tombstone = kCapacity;
        probe = static_cast<std::size_t>(-1);
        continue;
      }
      slot = (slot + 1) % kCapacity;
    }
    if (first_tombstone != kCapacity) {
      auto expected = kTombstone;
      if (states_[first_tombstone].compare_exchange_strong(
        expected,
        kReserved,
        std::memory_order_acq_rel,
        std::memory_order_acquire
      )) {
        ids_[first_tombstone].store(parameter_id, std::memory_order_relaxed);
        states_[first_tombstone].store(kOccupied, std::memory_order_release);
        return SetResult::kInserted;
      }
    }
    return SetResult::kFull;
  }

  void Clear(const std::uint32_t parameter_id) noexcept {
    std::size_t slot = Slot(parameter_id);
    for (std::size_t probe = 0; probe < kCapacity; ++probe) {
      const auto state = states_[slot].load(std::memory_order_acquire);
      if (state == kEmpty) return;
      if (state == kOccupied && ids_[slot].load(std::memory_order_relaxed) == parameter_id) {
        auto expected = kOccupied;
        if (states_[slot].compare_exchange_weak(
          expected,
          kTombstone,
          std::memory_order_acq_rel,
          std::memory_order_acquire
        )) return;
      }
      slot = (slot + 1) % kCapacity;
    }
  }

 private:
  static constexpr std::uint8_t kEmpty = 0;
  static constexpr std::uint8_t kOccupied = 1;
  static constexpr std::uint8_t kTombstone = 2;
  static constexpr std::uint8_t kReserved = 3;

  static std::size_t Slot(const std::uint32_t parameter_id) noexcept {
    return (static_cast<std::uint64_t>(parameter_id) * 2'654'435'761ULL) % kCapacity;
  }

  std::array<std::atomic<std::uint32_t>, kCapacity> ids_{};
  std::array<std::atomic<std::uint8_t>, kCapacity> states_{};
};

}  // namespace daw::audio_host_macos
