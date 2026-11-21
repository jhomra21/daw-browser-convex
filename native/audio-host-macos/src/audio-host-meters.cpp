#include "audio-host-internal.h"

namespace daw::audio_host_macos {

bool AudioHost::WaitForMeterBatch(const std::atomic<bool>* running) {
  std::unique_lock lock(impl_->meter_wait_mutex);
  impl_->meter_wait.wait(lock, [this, running] {
    return !impl_->meter_observer.Empty()
      || (running != nullptr && !running->load(std::memory_order_acquire));
  });
  return !impl_->meter_observer.Empty();
}

std::optional<MeterBatch> AudioHost::DrainMeterBatch() {
  MeterBatch batch{};
  bool has_context = false;
  NativeMeterObserver::Event event{};
  while (impl_->meter_observer.Pop(event)) {
    if (!has_context || event.graph_revision != batch.graph_revision || event.transport_epoch != batch.transport_epoch) {
      batch = {};
      batch.graph_revision = event.graph_revision;
      batch.transport_epoch = event.transport_epoch;
      has_context = true;
    }
    std::size_t entry_index = 0;
    while (entry_index < batch.entry_count && batch.entries[entry_index].node_id != event.node_id) ++entry_index;
    if (entry_index == batch.entry_count && batch.entry_count < kMaximumMeterEntries) {
      batch.entries[entry_index].node_id = event.node_id;
      ++batch.entry_count;
    }
    if (entry_index < batch.entry_count) {
      batch.entries[entry_index].left_rms = std::isfinite(event.left_rms) ? std::max(0.0F, event.left_rms) : 0.0F;
      batch.entries[entry_index].right_rms = std::isfinite(event.right_rms) ? std::max(0.0F, event.right_rms) : 0.0F;
    }
  }
  if (!has_context) return std::nullopt;
  batch.sequence = ++impl_->meter_sequence;
  return batch;
}

bool AudioHost::SetSpectrumNode(const std::uint64_t node_id) {
  if (node_id == impl_->spectrum_selected_node.load(std::memory_order_acquire)) return true;
  // Share publication's nonblocking ownership gate so a control-thread lookup
  // cannot bind a removed identity across the callback's graph switch.
  Impl::ControlSubmissionClaim claim{impl_->schedule_owner};
  if (!claim.acquired) return false;
  if (node_id == 0) {
    impl_->spectrum_selected_node.store(0, std::memory_order_release);
    impl_->spectrum_observer.Clear();
    impl_->spectrum_has_previous = false;
    impl_->spectrum_history_count = 0;
    return true;
  }
  if (!impl_->observation_lookups[impl_->active_observation_lookup.load(
    std::memory_order_acquire)].Contains(node_id)) return false;
  impl_->spectrum_observer.Clear();
  impl_->spectrum_has_previous = false;
  impl_->spectrum_history_count = 0;
  impl_->spectrum_selected_node.store(node_id, std::memory_order_release);
  return true;
}

bool AudioHost::WaitForSpectrumFrame(const std::atomic<bool>* running) {
  std::unique_lock lock(impl_->spectrum_wait_mutex);
  impl_->spectrum_wait.wait(lock, [this, running] {
    return !impl_->spectrum_observer.Empty()
      || (running != nullptr && !running->load(std::memory_order_acquire));
  });
  return !impl_->spectrum_observer.Empty();
}

std::optional<SpectrumFrame> AudioHost::DrainSpectrumFrame() {
  NativeSpectrumObserver::Event event{};
  NativeSpectrumObserver::Event latest{};
  bool has_event = false;
  while (impl_->spectrum_observer.Pop(event)) {
    latest = event;
    has_event = true;
    const auto count = std::min<std::uint32_t>(event.frame_count, kSpectrumFftSize);
    const auto retained = std::min<std::uint32_t>(impl_->spectrum_history_count, kSpectrumFftSize - count);
    if (retained > 0) {
      std::copy(
        impl_->spectrum_history_left.begin() + (impl_->spectrum_history_count - retained),
        impl_->spectrum_history_left.begin() + impl_->spectrum_history_count,
        impl_->spectrum_history_left.begin());
      std::copy(
        impl_->spectrum_history_right.begin() + (impl_->spectrum_history_count - retained),
        impl_->spectrum_history_right.begin() + impl_->spectrum_history_count,
        impl_->spectrum_history_right.begin());
    }
    for (std::uint32_t frame = 0; frame < count; ++frame) {
      impl_->spectrum_history_left[retained + frame] = event.left[frame];
      impl_->spectrum_history_right[retained + frame] = event.right[frame];
    }
    impl_->spectrum_history_count = retained + count;
  }
  if (!has_event) return std::nullopt;
  std::array<double, kSpectrumFftSize> real{};
  std::array<double, kSpectrumFftSize> imaginary{};
  for (std::uint32_t frame = 0; frame < kSpectrumFftSize; ++frame) {
    const double progress = static_cast<double>(frame) / static_cast<double>(kSpectrumFftSize - 1);
    const double window = 0.42 - 0.5 * std::cos(6.2831853071795864769 * progress) + 0.08 * std::cos(12.566370614359172954 * progress);
    const auto history_index = frame >= kSpectrumFftSize - impl_->spectrum_history_count
      ? frame - (kSpectrumFftSize - impl_->spectrum_history_count)
      : kSpectrumFftSize;
    const double sample = history_index < impl_->spectrum_history_count
      ? (static_cast<double>(impl_->spectrum_history_left[history_index]) + static_cast<double>(impl_->spectrum_history_right[history_index])) * 0.5
      : 0.0;
    real[frame] = sample * window;
  }
  for (std::uint32_t index = 1, reversed = 0; index < kSpectrumFftSize; ++index) {
    std::uint32_t bit = kSpectrumFftSize >> 1U;
    for (; reversed & bit; bit >>= 1U) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      std::swap(real[index], real[reversed]);
      std::swap(imaginary[index], imaginary[reversed]);
    }
  }
  for (std::uint32_t length = 2; length <= kSpectrumFftSize; length <<= 1U) {
    const double angle = -6.2831853071795864769 / static_cast<double>(length);
    const double step_real = std::cos(angle);
    const double step_imaginary = std::sin(angle);
    for (std::uint32_t start = 0; start < kSpectrumFftSize; start += length) {
      double twiddle_real = 1.0;
      double twiddle_imaginary = 0.0;
      const auto half = length / 2U;
      for (std::uint32_t offset = 0; offset < half; ++offset) {
        const auto even = start + offset;
        const auto odd = even + half;
        const double product_real = twiddle_real * real[odd] - twiddle_imaginary * imaginary[odd];
        const double product_imaginary = twiddle_real * imaginary[odd] + twiddle_imaginary * real[odd];
        real[odd] = real[even] - product_real;
        imaginary[odd] = imaginary[even] - product_imaginary;
        real[even] += product_real;
        imaginary[even] += product_imaginary;
        const double next_twiddle_real = twiddle_real * step_real - twiddle_imaginary * step_imaginary;
        twiddle_imaginary = twiddle_real * step_imaginary + twiddle_imaginary * step_real;
        twiddle_real = next_twiddle_real;
      }
    }
  }
  for (std::uint32_t bin = 0; bin < kMaximumSpectrumBins; ++bin) {
    const double scale = bin == 0 ? 1.0 / kSpectrumFftSize : 2.0 / kSpectrumFftSize;
    const double current = std::hypot(real[bin], imaginary[bin]) * scale;
    const double smoothed = impl_->spectrum_has_previous
      ? 0.7 * impl_->spectrum_smoothed[bin] + 0.3 * current : current;
    impl_->spectrum_smoothed[bin] = std::isfinite(smoothed) ? static_cast<float>(smoothed) : 0.0F;
  }
  impl_->spectrum_has_previous = true;
  SpectrumFrame output{};
  output.graph_revision = latest.graph_revision;
  output.transport_epoch = latest.transport_epoch;
  output.sequence = ++impl_->spectrum_sequence;
  output.node_id = latest.node_id;
  output.sample_rate_hz = latest.sample_rate_hz;
  output.fft_size = kSpectrumFftSize;
  output.bin_count = kMaximumSpectrumBins;
  for (std::uint32_t bin = 0; bin < kMaximumSpectrumBins; ++bin) {
    const double db = std::clamp(20.0 * std::log10(std::max<double>(impl_->spectrum_smoothed[bin], std::numeric_limits<double>::min())), -100.0, -30.0);
    output.data[bin] = static_cast<float>((db + 100.0) / 70.0);
  }
  return output;
}

void AudioHost::WakeMeterWait() {
  impl_->meter_wait.notify_all();
}
void AudioHost::WakeSpectrumWait() {
  impl_->spectrum_wait.notify_all();
}

}  // namespace daw::audio_host_macos
