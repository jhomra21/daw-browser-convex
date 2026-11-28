#include "audio_core_internal.h"

namespace {

enum class RecordingBlockOwner : uint8_t {
  available,
  capture,
  queued,
  transport,
};

struct RecordingCaptureBlock {
  std::array<std::array<float, DAW_AUDIO_RECORDING_CAPTURE_BLOCK_FRAMES>,
    DAW_AUDIO_RECORDING_CAPTURE_MAX_CHANNELS> planes{};
  std::atomic<RecordingBlockOwner> owner{RecordingBlockOwner::available};
  uint64_t sequence = 0;
  uint32_t frame_count = 0;
  int64_t start_frame = 0;
};

struct RecordingCapture {
  daw_audio_recording_capture_config config{};
  std::array<RecordingCaptureBlock, DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS> blocks{};
  uint32_t current = DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS;
  uint32_t pending = DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS;
  uint64_t next_sequence = 0;
  std::atomic<uint64_t> captured_frames{0};
  std::atomic<uint64_t> dropped_frames{0};
  std::atomic<uint32_t> dropped_blocks{0};
  std::atomic<float> rms{0.0F};
  std::atomic<float> peak{0.0F};
  std::atomic<bool> fatal{false};
  std::atomic<bool> active{true};
};

RecordingCapture *to_capture(daw_audio_core_handle handle) {
  return reinterpret_cast<RecordingCapture *>(static_cast<uintptr_t>(handle));
}

daw_audio_core_handle to_capture_handle(RecordingCapture *capture) {
  return static_cast<daw_audio_core_handle>(reinterpret_cast<uintptr_t>(capture));
}

bool valid_recording_capture_config(const daw_audio_recording_capture_config &config) {
  if (!valid_abi(config.abi_version)
    || config.channel_count == 0 || config.channel_count > DAW_AUDIO_RECORDING_CAPTURE_MAX_CHANNELS
    || !std::isfinite(config.gain) || config.gain < 0.0F
    || (config.polarity != 1 && config.polarity != -1)
    || config.punch_start_frame < 0
    || (config.punch_end_frame != -1 && config.punch_end_frame < config.punch_start_frame)) return false;
  for (uint32_t channel = 0; channel < config.channel_count; ++channel) {
    if (config.input_channels[channel] >= kMaximumChannels) return false;
  }
  return true;
}

uint32_t recording_acquire_block(RecordingCapture &capture) {
  for (uint32_t index = 0; index < capture.blocks.size(); ++index) {
    RecordingBlockOwner expected = RecordingBlockOwner::available;
    if (!capture.blocks[index].owner.compare_exchange_strong(
      expected, RecordingBlockOwner::capture, std::memory_order_acq_rel)) continue;
    return index;
  }
  return DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS;
}

void recording_update_meter(RecordingCapture &capture, const RecordingCaptureBlock &block) {
  double sum = 0.0;
  float peak = 0.0F;
  for (uint32_t channel = 0; channel < capture.config.channel_count; ++channel) {
    for (uint32_t frame = 0; frame < block.frame_count; ++frame) {
      const float value = block.planes[channel][frame];
      sum += static_cast<double>(value) * static_cast<double>(value);
      peak = std::fmax(peak, std::abs(value));
    }
  }
  const uint64_t samples = static_cast<uint64_t>(block.frame_count) * capture.config.channel_count;
  capture.rms.store(samples == 0 ? 0.0F : static_cast<float>(std::sqrt(sum / samples)), std::memory_order_release);
  capture.peak.store(peak, std::memory_order_release);
}

void recording_queue_pending(RecordingCapture &capture) {
  if (capture.pending == DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS) return;
  RecordingCaptureBlock &block = capture.blocks[capture.pending];
  block.sequence = capture.next_sequence++;
  block.owner.store(RecordingBlockOwner::queued, std::memory_order_release);
  recording_update_meter(capture, block);
  capture.pending = DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS;
}

void recording_discard_current(RecordingCapture &capture) {
  if (capture.current == DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS) return;
  RecordingCaptureBlock &block = capture.blocks[capture.current];
  capture.captured_frames.fetch_sub(block.frame_count, std::memory_order_relaxed);
  block.sequence = 0;
  block.frame_count = 0;
  block.start_frame = 0;
  block.owner.store(RecordingBlockOwner::available, std::memory_order_release);
  capture.current = DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS;
}

void recording_complete_current(RecordingCapture &capture) {
  if (capture.current == DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS) return;
  recording_queue_pending(capture);
  capture.pending = capture.current;
  capture.current = DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS;
}

float recording_processed_sample(
  const RecordingCapture &capture,
  const float *const *inputs,
  uint32_t input_channel_count,
  uint32_t output_channel,
  uint32_t frame) {
  const uint32_t input_channel = capture.config.input_channels[output_channel];
  const float *input = input_channel < input_channel_count ? inputs[input_channel] : nullptr;
  const float sample = input == nullptr ? 0.0F : input[frame];
  return std::isfinite(sample)
    ? sample * capture.config.gain * static_cast<float>(capture.config.polarity)
    : 0.0F;
}

daw_audio_core_result recording_capture_process(
  RecordingCapture &capture,
  const float *const *inputs,
  uint32_t input_channel_count,
  float *const *monitor_outputs,
  uint32_t monitor_channel_count,
  uint32_t frame_count,
  int64_t start_frame) {
  if (!capture.active.load(std::memory_order_acquire) || capture.fatal.load(std::memory_order_acquire)) {
    return DAW_AUDIO_CORE_NOT_PREPARED;
  }
  if (frame_count > DAW_AUDIO_RECORDING_CAPTURE_BLOCK_FRAMES || start_frame < 0) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  if (monitor_channel_count > 0 && monitor_outputs == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  for (uint32_t channel = 0; channel < monitor_channel_count; ++channel) {
    if (monitor_outputs[channel] == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  for (uint32_t frame = 0; frame < frame_count; ++frame) {
    for (uint32_t channel = 0; channel < monitor_channel_count; ++channel) {
      monitor_outputs[channel][frame] = channel < capture.config.channel_count
        ? recording_processed_sample(capture, inputs, input_channel_count, channel, frame)
        : 0.0F;
    }
    const int64_t absolute_frame = start_frame + static_cast<int64_t>(frame);
    if (absolute_frame < capture.config.punch_start_frame
      || (capture.config.punch_end_frame != -1 && absolute_frame >= capture.config.punch_end_frame)) continue;
    if (capture.current == DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS) {
      capture.current = recording_acquire_block(capture);
      if (capture.current != DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS) {
        capture.blocks[capture.current].start_frame = absolute_frame;
      }
    }
    if (capture.current == DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS) {
      const uint64_t dropped = capture.dropped_frames.fetch_add(1, std::memory_order_relaxed) + 1;
      if ((dropped - 1) % DAW_AUDIO_RECORDING_CAPTURE_BLOCK_FRAMES == 0) {
        capture.dropped_blocks.fetch_add(1, std::memory_order_relaxed);
      }
      capture.fatal.store(true, std::memory_order_release);
      return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    }
    RecordingCaptureBlock &block = capture.blocks[capture.current];
    for (uint32_t channel = 0; channel < capture.config.channel_count; ++channel) {
      block.planes[channel][block.frame_count] =
        recording_processed_sample(capture, inputs, input_channel_count, channel, frame);
    }
    ++block.frame_count;
    capture.captured_frames.fetch_add(1, std::memory_order_relaxed);
    if (block.frame_count == DAW_AUDIO_RECORDING_CAPTURE_BLOCK_FRAMES) recording_complete_current(capture);
  }
  return DAW_AUDIO_CORE_OK;
}
}  // namespace


extern "C" daw_audio_core_result daw_audio_recording_capture_create(
  const daw_audio_recording_capture_config *config,
  daw_audio_core_handle *out_capture) {
  if (config == nullptr || out_capture == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (!valid_abi(config->abi_version)) return DAW_AUDIO_CORE_UNSUPPORTED_VERSION;
  if (!valid_recording_capture_config(*config)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  RecordingCapture *capture = new (std::nothrow) RecordingCapture{};
  if (capture == nullptr) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  capture->config = *config;
  *out_capture = to_capture_handle(capture);
  return DAW_AUDIO_CORE_OK;
}

extern "C" void daw_audio_recording_capture_destroy(daw_audio_core_handle capture) {
  delete to_capture(capture);
}

extern "C" daw_audio_core_result daw_audio_recording_capture_process(
  daw_audio_core_handle capture_handle,
  const float *const *inputs,
  uint32_t input_channel_count,
  uint32_t frame_count,
  int64_t start_frame) {
  RecordingCapture *capture = to_capture(capture_handle);
  if (capture == nullptr || (input_channel_count > 0 && inputs == nullptr)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  return recording_capture_process(*capture, inputs, input_channel_count, nullptr, 0, frame_count, start_frame);
}

extern "C" daw_audio_core_result daw_audio_recording_capture_process_monitor(
  daw_audio_core_handle capture_handle,
  const float *const *inputs,
  uint32_t input_channel_count,
  float *const *monitor_outputs,
  uint32_t monitor_channel_count,
  uint32_t frame_count,
  int64_t start_frame) {
  RecordingCapture *capture = to_capture(capture_handle);
  if (capture == nullptr || (input_channel_count > 0 && inputs == nullptr)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  return recording_capture_process(
    *capture, inputs, input_channel_count, monitor_outputs, monitor_channel_count, frame_count, start_frame);
}

extern "C" daw_audio_core_result daw_audio_recording_capture_dequeue(
  daw_audio_core_handle capture_handle,
  daw_audio_recording_capture_block *out_block) {
  RecordingCapture *capture = to_capture(capture_handle);
  if (capture == nullptr || out_block == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  uint32_t selected = DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS;
  uint64_t sequence = UINT64_MAX;
  for (uint32_t index = 0; index < capture->blocks.size(); ++index) {
    const RecordingCaptureBlock &block = capture->blocks[index];
    if (block.owner.load(std::memory_order_acquire) == RecordingBlockOwner::queued && block.sequence < sequence) {
      selected = index;
      sequence = block.sequence;
    }
  }
  if (selected == DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS) return DAW_AUDIO_CORE_NO_DATA;
  RecordingCaptureBlock &block = capture->blocks[selected];
  block.owner.store(RecordingBlockOwner::transport, std::memory_order_release);
  *out_block = {
    .generation = capture->config.generation,
    .session_id = capture->config.session_id,
    .sequence = block.sequence,
    .block_id = selected,
    .frame_count = block.frame_count,
    .channel_count = capture->config.channel_count,
    .planes = {block.planes[0].data(), block.planes[1].data()},
    .rms = capture->rms.load(std::memory_order_acquire),
    .peak = capture->peak.load(std::memory_order_acquire),
  };
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_recording_capture_release_block(
  daw_audio_core_handle capture_handle,
  uint32_t block_id) {
  RecordingCapture *capture = to_capture(capture_handle);
  if (capture == nullptr || block_id >= capture->blocks.size()) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  RecordingCaptureBlock &block = capture->blocks[block_id];
  if (block.owner.load(std::memory_order_acquire) != RecordingBlockOwner::transport) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  block.sequence = 0;
  block.frame_count = 0;
  block.start_frame = 0;
  block.owner.store(RecordingBlockOwner::available, std::memory_order_release);
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_recording_capture_finalize(
  daw_audio_core_handle capture_handle,
  int64_t stop_frame) {
  RecordingCapture *capture = to_capture(capture_handle);
  if (capture == nullptr || stop_frame < 0) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (!capture->active.load(std::memory_order_acquire)) return DAW_AUDIO_CORE_OK;
  if (capture->fatal.load(std::memory_order_acquire)) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  if (capture->current != DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS) {
    RecordingCaptureBlock &current = capture->blocks[capture->current];
    const int64_t retained = std::clamp(stop_frame - current.start_frame, int64_t{0}, static_cast<int64_t>(current.frame_count));
    capture->captured_frames.fetch_sub(current.frame_count - static_cast<uint32_t>(retained), std::memory_order_relaxed);
    current.frame_count = static_cast<uint32_t>(retained);
    if (current.frame_count == 0) recording_discard_current(*capture);
    else recording_complete_current(*capture);
  }
  recording_queue_pending(*capture);
  capture->active.store(false, std::memory_order_release);
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_recording_capture_cancel(daw_audio_core_handle capture_handle) {
  RecordingCapture *capture = to_capture(capture_handle);
  if (capture == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (capture->current != DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS) {
    RecordingCaptureBlock &current = capture->blocks[capture->current];
    current.sequence = 0;
    current.frame_count = 0;
    current.start_frame = 0;
    current.owner.store(RecordingBlockOwner::available, std::memory_order_release);
  }
  if (capture->pending != DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS) {
    RecordingCaptureBlock &pending = capture->blocks[capture->pending];
    pending.sequence = 0;
    pending.frame_count = 0;
    pending.start_frame = 0;
    pending.owner.store(RecordingBlockOwner::available, std::memory_order_release);
  }
  capture->current = DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS;
  capture->pending = DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS;
  capture->captured_frames.store(0, std::memory_order_release);
  capture->rms.store(0.0F, std::memory_order_release);
  capture->peak.store(0.0F, std::memory_order_release);
  capture->active.store(false, std::memory_order_release);
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_recording_capture_get_diagnostics(
  daw_audio_core_handle capture_handle,
  daw_audio_recording_capture_diagnostics *out_diagnostics) {
  RecordingCapture *capture = to_capture(capture_handle);
  if (capture == nullptr || out_diagnostics == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  uint32_t available = 0;
  uint32_t queued = 0;
  for (const RecordingCaptureBlock &block : capture->blocks) {
    const RecordingBlockOwner owner = block.owner.load(std::memory_order_acquire);
    available += owner == RecordingBlockOwner::available ? 1 : 0;
    queued += owner == RecordingBlockOwner::queued || owner == RecordingBlockOwner::transport ? 1 : 0;
  }
  *out_diagnostics = {
    .generation = capture->config.generation, .session_id = capture->config.session_id,
    .captured_frames = capture->captured_frames.load(std::memory_order_acquire),
    .dropped_frames = capture->dropped_frames.load(std::memory_order_acquire),
    .dropped_blocks = capture->dropped_blocks.load(std::memory_order_acquire),
    .available_blocks = available, .queued_blocks = queued,
    .rms = capture->rms.load(std::memory_order_acquire),
    .peak = capture->peak.load(std::memory_order_acquire),
    .fatal = capture->fatal.load(std::memory_order_acquire) ? 1u : 0u,
    .active = capture->active.load(std::memory_order_acquire) ? 1u : 0u,
  };
  return DAW_AUDIO_CORE_OK;
}
