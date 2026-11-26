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
    impl_->spectrum_analyzer.Reset();
    impl_->spectrum_history_count = 0;
    return true;
  }
  if (!impl_->observation_lookups[impl_->active_observation_lookup.load(
    std::memory_order_acquire)].Contains(node_id)) return false;
  impl_->spectrum_observer.Clear();
  impl_->spectrum_analyzer.Reset();
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
  std::uint64_t drained_frames = 0;
  while (impl_->spectrum_observer.Pop(event)) {
    latest = event;
    drained_frames += event.frame_count;
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
  std::vector<double> block(kSpectrumFftSize, 0.0);
  const auto missing = kSpectrumFftSize - impl_->spectrum_history_count;
  for (std::uint32_t index = 0; index < impl_->spectrum_history_count; ++index) {
    block[missing + index] = (static_cast<double>(impl_->spectrum_history_left[index])
      + static_cast<double>(impl_->spectrum_history_right[index])) * 0.5;
  }
  impl_->spectrum_analyzer.Analyze(block, static_cast<double>(drained_frames) / latest.sample_rate_hz);
  SpectrumFrame output{};
  output.graph_revision = latest.graph_revision;
  output.transport_epoch = latest.transport_epoch;
  output.sequence = ++impl_->spectrum_sequence;
  output.node_id = latest.node_id;
  output.sample_rate_hz = latest.sample_rate_hz;
  output.fft_size = kSpectrumFftSize;
  output.bin_count = kMaximumSpectrumBins;
  for (std::uint32_t bin = 0; bin < kMaximumSpectrumBins; ++bin) output.data[bin] = impl_->spectrum_analyzer.Level(bin);
  return output;
}

void AudioHost::WakeMeterWait() {
  impl_->meter_wait.notify_all();
}
void AudioHost::WakeSpectrumWait() {
  impl_->spectrum_wait.notify_all();
}

}  // namespace daw::audio_host_macos
