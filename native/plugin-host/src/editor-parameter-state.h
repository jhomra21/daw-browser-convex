#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <span>
#include <mutex>
#include <atomic>

namespace daw::plugin_host {

struct PendingEditorParameterEdit {
  std::uint32_t parameter_id = 0;
  double normalized_value = 0.0;
  std::uint64_t generation = 0;
};

template <std::size_t Capacity>
class BoundedEditorParameterState final {
 public:
  [[nodiscard]] bool Queue(
    const std::uint32_t parameter_id,
    const double normalized_value
  ) noexcept {
    if (!std::isfinite(normalized_value) || normalized_value < 0.0 || normalized_value > 1.0) return false;
    std::lock_guard lock(feedback_mutex_);
    const auto process_write = process_write_.load(std::memory_order_relaxed);
    const auto process_read = process_read_.load(std::memory_order_acquire);
    const auto feedback_index = Find(feedback_, feedback_size_, parameter_id);
    if (process_write - process_read >= Capacity
      || (feedback_index == Capacity && feedback_size_ >= Capacity)) return false;
    const auto generation = next_generation_++;
    const auto edit = PendingEditorParameterEdit{
      .parameter_id = parameter_id,
      .normalized_value = normalized_value,
      .generation = generation == 0 ? next_generation_++ : generation,
    };
    process_[process_write % Capacity] = edit;
    process_write_.store(process_write + 1, std::memory_order_release);
    if (feedback_index == Capacity) feedback_[feedback_size_++] = edit;
    else feedback_[feedback_index] = edit;
    return true;
  }

  std::size_t DrainProcess(const std::span<PendingEditorParameterEdit> destination) noexcept {
    const auto read = process_read_.load(std::memory_order_relaxed);
    const auto write = process_write_.load(std::memory_order_acquire);
    const auto count = std::min<std::size_t>(write - read, destination.size());
    for (std::size_t index = 0; index < count; ++index) {
      destination[index] = process_[(read + index) % Capacity];
    }
    process_read_.store(read + count, std::memory_order_release);
    return count;
  }

  [[nodiscard]] bool PeekFeedback(PendingEditorParameterEdit& destination) const noexcept {
    std::lock_guard lock(feedback_mutex_);
    if (feedback_size_ == 0) return false;
    destination = feedback_[0];
    return true;
  }

  [[nodiscard]] bool AckFeedback(
    const std::uint32_t parameter_id,
    const std::uint64_t generation
  ) noexcept {
    std::lock_guard lock(feedback_mutex_);
    const auto index = Find(feedback_, feedback_size_, parameter_id);
    if (index == Capacity || feedback_[index].generation != generation) return false;
    feedback_[index] = feedback_[feedback_size_ - 1];
    --feedback_size_;
    return true;
  }

  void Clear() noexcept {
    std::lock_guard lock(feedback_mutex_);
    const auto write = process_write_.load(std::memory_order_acquire);
    process_read_.store(write, std::memory_order_release);
    feedback_size_ = 0;
  }

 private:
  static std::size_t Find(
    const std::array<PendingEditorParameterEdit, Capacity>& values,
    const std::size_t size,
    const std::uint32_t parameter_id
  ) noexcept {
    for (std::size_t index = 0; index < size; ++index) {
      if (values[index].parameter_id == parameter_id) return index;
    }
    return Capacity;
  }

  mutable std::mutex feedback_mutex_;
  std::array<PendingEditorParameterEdit, Capacity> process_{};
  std::array<PendingEditorParameterEdit, Capacity> feedback_{};
  std::atomic<std::size_t> process_write_ = 0;
  std::atomic<std::size_t> process_read_ = 0;
  std::size_t feedback_size_ = 0;
  std::uint64_t next_generation_ = 1;
};

}  // namespace daw::plugin_host
