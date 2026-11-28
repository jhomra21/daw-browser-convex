#include "audio_core_internal.h"

namespace {

uint32_t spectral_warm_frames(const daw_audio_spectral_state &state) {
  return state.fft_size * 2u + (state.mode == DAW_AUDIO_SPECTRAL_MODE_HPSS
    ? (kSpectralHpssFrames - 1u) * (state.fft_size / state.overlap) : 0u);
}

float spectral_parameter(
  const Core &core, const GraphRevision::Processor &processor, uint32_t target, uint32_t frame, float fallback) {
  return processor_parameter_value(core, processor, target, frame, fallback);
}

float spectral_transform_parameter(
  const Core &core, const GraphRevision::Processor &processor, uint32_t target, uint32_t frame, float fallback) {
  return processor_parameter_value(core, processor, target, frame, fallback);
}

void spectral_fft(std::array<float, kMaximumSpectralFftSize> &real,
                  std::array<float, kMaximumSpectralFftSize> &imaginary,
                  uint32_t size, bool inverse) {
  for (uint32_t index = 1, reversed = 0; index < size; ++index) {
    uint32_t bit = size >> 1u;
    while ((reversed & bit) != 0) {
      reversed ^= bit;
      bit >>= 1u;
    }
    reversed ^= bit;
    if (index < reversed) {
      const float real_value = real[index]; real[index] = real[reversed]; real[reversed] = real_value;
      const float imaginary_value = imaginary[index]; imaginary[index] = imaginary[reversed]; imaginary[reversed] = imaginary_value;
    }
  }
  for (uint32_t length = 2; length <= size; length <<= 1u) {
    const float angle = (inverse ? 2.0F : -2.0F) * 3.14159265358979323846F / static_cast<float>(length);
    const float step_real = std::cos(angle);
    const float step_imaginary = std::sin(angle);
    for (uint32_t start = 0; start < size; start += length) {
      float twiddle_real = 1.0F;
      float twiddle_imaginary = 0.0F;
      for (uint32_t offset = 0; offset < length / 2; ++offset) {
        const uint32_t even = start + offset;
        const uint32_t odd = even + length / 2;
        const float odd_real = real[odd] * twiddle_real - imaginary[odd] * twiddle_imaginary;
        const float odd_imaginary = real[odd] * twiddle_imaginary + imaginary[odd] * twiddle_real;
        real[odd] = real[even] - odd_real; imaginary[odd] = imaginary[even] - odd_imaginary;
        real[even] += odd_real; imaginary[even] += odd_imaginary;
        const float next_real = twiddle_real * step_real - twiddle_imaginary * step_imaginary;
        twiddle_imaginary = twiddle_real * step_imaginary + twiddle_imaginary * step_real;
        twiddle_real = next_real;
      }
    }
  }
  if (inverse) for (uint32_t index = 0; index < size; ++index) {
    real[index] /= static_cast<float>(size); imaginary[index] /= static_cast<float>(size);
  }
}

float spectral_median(std::array<float, kMaximumSpectralBins> &values, uint32_t count) {
  for (uint32_t index = 1; index < count; ++index) {
    const float value = values[index];
    uint32_t cursor = index;
    while (cursor > 0 && values[cursor - 1] > value) {
      values[cursor] = values[cursor - 1];
      --cursor;
    }
    values[cursor] = value;
  }
  return values[count / 2];
}

void transform_spectrum(
  Core &core, GraphRevision::Processor &processor, SpectralHistory &history, uint32_t channel, uint32_t frame) {
  const daw_audio_spectral_state &state = processor.spectral;
  auto &real = history.real[channel];
  auto &imaginary = history.imaginary[channel];
  auto &side_real = history.side_real[channel];
  auto &side_imaginary = history.side_imaginary[channel];
  const uint32_t bins = state.fft_size / 2 + 1;
  const float freeze = history.replacement.freeze_source_latched
    ? (history.replacement.analysis_from_predecessor ? 1.0F : 0.0F)
    : spectral_transform_parameter(core, processor, 15, frame, state.freeze);
  const float threshold_db = spectral_transform_parameter(core, processor, 16, frame, state.gate_threshold_db);
  const float attack_ms = spectral_transform_parameter(core, processor, 17, frame, state.gate_attack_ms);
  const float release_ms = spectral_transform_parameter(core, processor, 18, frame, state.gate_release_ms);
  const float morph = spectral_transform_parameter(core, processor, 19, frame, state.morph);
  const float bin_shift = spectral_transform_parameter(core, processor, 20, frame, state.bin_shift);
  const float blur = spectral_transform_parameter(core, processor, 21, frame, state.blur);
  const float hpss_balance = spectral_transform_parameter(core, processor, 22, frame, state.harmonic_percussive_balance);
  const float noise_reduction = spectral_transform_parameter(core, processor, 23, frame, state.noise_reduction);
  const float profile_learn = spectral_transform_parameter(core, processor, 24, frame, state.profile_learn);
  if (state.mode == DAW_AUDIO_SPECTRAL_MODE_FREEZE) {
    if (freeze > 0.0F && !history.freeze_captured[channel]) {
      for (uint32_t bin = 0; bin < bins; ++bin) {
        history.frozen_magnitude[channel][bin] = std::hypot(real[bin], imaginary[bin]);
        history.frozen_phase[channel][bin] = std::atan2(imaginary[bin], real[bin]);
      }
      history.freeze_captured[channel] = true;
    } else if (freeze == 0.0F) history.freeze_captured[channel] = false;
    if (history.freeze_captured[channel]) for (uint32_t bin = 0; bin < bins; ++bin) {
      real[bin] = history.frozen_magnitude[channel][bin] * std::cos(history.frozen_phase[channel][bin]);
      imaginary[bin] = history.frozen_magnitude[channel][bin] * std::sin(history.frozen_phase[channel][bin]);
    }
  } else if (state.mode == DAW_AUDIO_SPECTRAL_MODE_GATE) {
    const float threshold = std::pow(10.0F, threshold_db / 20.0F);
    const float attack = std::exp(-static_cast<float>(history.hop_size) / std::fmax(1.0F, attack_ms * 0.001F * core.config.sample_rate_hz));
    const float release = std::exp(-static_cast<float>(history.hop_size) / std::fmax(1.0F, release_ms * 0.001F * core.config.sample_rate_hz));
    for (uint32_t bin = 0; bin < bins; ++bin) {
      const float target = std::hypot(real[bin], imaginary[bin]) >= threshold ? 1.0F : 0.0F;
      const float coefficient = target > history.gate_gain[channel][bin] ? attack : release;
      history.gate_gain[channel][bin] = target + coefficient * (history.gate_gain[channel][bin] - target);
      real[bin] *= history.gate_gain[channel][bin]; imaginary[bin] *= history.gate_gain[channel][bin];
    }
  } else if (state.mode == DAW_AUDIO_SPECTRAL_MODE_MORPH) {
    for (uint32_t bin = 0; bin < bins; ++bin) {
      const float phase = std::atan2(imaginary[bin], real[bin]);
      const float magnitude = std::hypot(real[bin], imaginary[bin]) * (1.0F - morph)
        + std::hypot(side_real[bin], side_imaginary[bin]) * morph;
      real[bin] = magnitude * std::cos(phase); imaginary[bin] = magnitude * std::sin(phase);
    }
  } else if (state.mode == DAW_AUDIO_SPECTRAL_MODE_SHIFT_BLUR) {
    for (uint32_t bin = 0; bin < bins; ++bin) history.scratch[channel][bin] = std::hypot(real[bin], imaginary[bin]);
    const int32_t radius = std::min(15, static_cast<int32_t>(std::ceil(blur * 15.0F)));
    for (uint32_t bin = 0; bin < bins; ++bin) {
      const float source = static_cast<float>(bin) - bin_shift;
      const int32_t lower = static_cast<int32_t>(std::floor(source));
      const float fraction = source - static_cast<float>(lower);
      const float shifted = lower >= 0 && static_cast<uint32_t>(lower + 1) < bins
        ? history.scratch[channel][static_cast<uint32_t>(lower)] * (1.0F - fraction) + history.scratch[channel][static_cast<uint32_t>(lower + 1)] * fraction : 0.0F;
      float sum = 0.0F; uint32_t count = 0;
      for (int32_t offset = -radius; offset <= radius; ++offset) {
        const int32_t candidate = lower + offset;
        if (candidate >= 0 && static_cast<uint32_t>(candidate) < bins) {
          sum += history.scratch[channel][static_cast<uint32_t>(candidate)]; ++count;
        }
      }
      const float magnitude = shifted * (1.0F - blur) + (count == 0 ? 0.0F : sum / static_cast<float>(count)) * blur;
      const float phase = std::atan2(imaginary[bin], real[bin]);
      real[bin] = magnitude * std::cos(phase); imaginary[bin] = magnitude * std::sin(phase);
    }
  } else if (state.mode == DAW_AUDIO_SPECTRAL_MODE_HPSS) {
    const uint32_t history_offset = history.hpss_index[channel] * kMaximumSpectralBins;
    for (uint32_t bin = 0; bin < bins; ++bin) history.hpss_history[channel][history_offset + bin] = std::hypot(real[bin], imaginary[bin]);
    history.hpss_index[channel] = (history.hpss_index[channel] + 1) % kSpectralHpssFrames;
    for (uint32_t bin = 0; bin < bins; ++bin) {
      uint32_t count = 0;
      for (int32_t offset = -15; offset <= 15; ++offset) {
        const int32_t candidate = static_cast<int32_t>(bin) + offset;
        if (candidate >= 0 && static_cast<uint32_t>(candidate) < bins) history.scratch[channel][count++] = history.hpss_history[channel][history_offset + static_cast<uint32_t>(candidate)];
      }
      const float percussive = spectral_median(history.scratch[channel], count);
      for (uint32_t sample = 0; sample < kSpectralHpssFrames; ++sample) history.scratch[channel][sample] = history.hpss_history[channel][sample * kMaximumSpectralBins + bin];
      const float harmonic = spectral_median(history.scratch[channel], kSpectralHpssFrames);
      const float balance = (hpss_balance + 1.0F) * 0.5F;
      const float mask = (harmonic * balance + percussive * (1.0F - balance)) / std::fmax(1e-12F, harmonic + percussive);
      real[bin] *= mask; imaginary[bin] *= mask;
    }
  } else {
    for (uint32_t bin = 0; bin < bins; ++bin) {
      const float magnitude = std::hypot(real[bin], imaginary[bin]);
      const float detector = std::hypot(side_real[bin], side_imaginary[bin]);
      const float profile_input = detector > 0.0F ? detector : magnitude;
      history.noise_profile[channel][bin] += (profile_input - history.noise_profile[channel][bin]) * profile_learn;
      const float gain = magnitude > 0.0F ? std::fmax(0.0F, 1.0F - noise_reduction * history.noise_profile[channel][bin] / magnitude) : 0.0F;
      real[bin] *= gain; imaginary[bin] *= gain;
    }
  }
  imaginary[0] = 0.0F;
  imaginary[state.fft_size / 2u] = 0.0F;
  for (uint32_t bin = 1; bin < state.fft_size / 2; ++bin) {
    real[state.fft_size - bin] = real[bin]; imaginary[state.fft_size - bin] = -imaginary[bin];
  }
}

void process_spectral_frame(Core &core, GraphRevision::Processor &processor, SpectralHistory &history, uint32_t frame) {
  if (history.analysis_frames < UINT32_MAX) ++history.analysis_frames;
  const uint32_t input_mask = kMaximumSpectralFftSize - 1;
  const uint32_t output_mask = kMaximumSpectralFftSize * 2 - 1;
  const uint32_t frame_start = (history.write_index - processor.spectral.fft_size + kMaximumSpectralFftSize) & input_mask;
  for (uint32_t channel = 0; channel < 2; ++channel) {
    for (uint32_t index = 0; index < processor.spectral.fft_size; ++index) {
      const uint32_t source = (frame_start + index) & input_mask;
      const float window = std::sqrt(0.5F - 0.5F * std::cos(6.2831853071795864769F * static_cast<float>(index) / processor.spectral.fft_size));
      history.real[channel][index] = history.input[channel][source] * window; history.imaginary[channel][index] = 0.0F;
      history.side_real[channel][index] = history.sidechain[channel][source] * window; history.side_imaginary[channel][index] = 0.0F;
    }
    spectral_fft(history.real[channel], history.imaginary[channel], processor.spectral.fft_size, false);
    if (processor.spectral.mode == DAW_AUDIO_SPECTRAL_MODE_MORPH || processor.spectral.mode == DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE) {
      spectral_fft(history.side_real[channel], history.side_imaginary[channel], processor.spectral.fft_size, false);
    }
    transform_spectrum(core, processor, history, channel, frame);
    spectral_fft(history.real[channel], history.imaginary[channel], processor.spectral.fft_size, true);
    for (uint32_t index = 0; index < processor.spectral.fft_size; ++index) {
      const float window = std::sqrt(0.5F - 0.5F * std::cos(6.2831853071795864769F * static_cast<float>(index) / processor.spectral.fft_size));
      const uint32_t target = (history.write_index + index) & output_mask;
      history.output[channel][target] += history.real[channel][index] * window * (2.0F / processor.spectral.overlap);
    }
  }
}

void render_spectral_sample(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float sidechain_left, float sidechain_right, float *output_left, float *output_right,
  const std::array<float, 2> *analysis_input = nullptr) {
  SpectralHistory &history = core.spectral_histories[processor.spectral_slot];
  reset_spectral_history(history, processor.spectral);
  const uint32_t input_mask = kMaximumSpectralFftSize - 1;
  const uint32_t output_mask = kMaximumSpectralFftSize * 2 - 1;
  const std::array<float, 2> input{std::isfinite(input_left) ? input_left : 0.0F, std::isfinite(input_right) ? input_right : 0.0F};
  const std::array<float, 2> sidechain{std::isfinite(sidechain_left) ? sidechain_left : 0.0F, std::isfinite(sidechain_right) ? sidechain_right : 0.0F};
  advance_bypass(core, history.bypass, processor.bypassed != 0 || processor.spectral.enabled == 0);
  std::array<float, 2> output{};
  for (uint32_t channel = 0; channel < 2; ++channel) {
    history.input[channel][history.write_index & input_mask] = analysis_input ? (*analysis_input)[channel] : input[channel];
    history.sidechain[channel][history.write_index & input_mask] = sidechain[channel];
    history.dry[channel][(history.write_index + processor.spectral.fft_size) & output_mask] = input[channel];
    const float wet = history.output[channel][history.write_index];
    history.wet_sample[channel] = wet;
    const float dry = history.dry[channel][history.write_index];
    history.output[channel][history.write_index] = 0.0F;
    history.dry[channel][history.write_index] = 0.0F;
    const float mix = spectral_parameter(core, processor, 25, frame, processor.spectral.mix);
    const float processed = dry * (1.0F - mix) + wet * mix;
    output[channel] = processed + (dry - processed) * history.bypass;
  }
  history.write_index = (history.write_index + 1) & output_mask;
  if (--history.samples_until_frame == 0) {
    const auto captured = history.freeze_captured;
    process_spectral_frame(core, processor, history, frame);
    history.samples_until_frame = history.hop_size;
    const auto mode = processor.spectral.mode;
    if (history.state_serial == 0 || history.state_mode != mode || mode == DAW_AUDIO_SPECTRAL_MODE_GATE
      || (mode == DAW_AUDIO_SPECTRAL_MODE_FREEZE && captured != history.freeze_captured)
      || (mode == DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE
        && spectral_transform_parameter(core, processor, 24, frame, processor.spectral.profile_learn) > 0.0F)) {
      ++history.state_serial;
      history.state_mode = mode;
      core.spectral_inputs[processor.spectral_slot].publish(history, mode);
    }
  }
  *output_left = output[0];
  *output_right = output[1];
  for (uint32_t channel = 0; channel < 2; ++channel)
    history.rendered[channel][(history.write_index - 1u) & output_mask] = output[channel];
}
}  // namespace

namespace daw::audio_core_internal {

void render_spectral_processor(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float sidechain_left, float sidechain_right, float *output_left, float *output_right) {
  render_spectral_sample(core, processor, frame, input_left, input_right, sidechain_left, sidechain_right,
    output_left, output_right);
}
}  // namespace daw::audio_core_internal

namespace {

SpectralTransferMap prepare_spectral_transfer(uint32_t before, uint32_t after) {
  SpectralTransferMap map{};
  map.before = before; map.after = after;
  map.level = static_cast<float>(after) / before;
  const double ratio = static_cast<double>(after) / before;
  const uint32_t last = before / 2u;
  for (uint32_t bin = 0; bin <= after / 2u; ++bin) {
    auto &band = map.bands[bin];
    const double at = bin / ratio;
    if (after >= before) {
      band.first = static_cast<uint32_t>(at);
      band.last = std::min(band.first + 1u, last);
      band.first_weight = 1.0 - (at - band.first);
      band.last_weight = at - band.first;
      if (band.first == band.last) { band.first_weight = 1; band.last_weight = 0; }
    } else {
      const double left = std::max(0.0, (bin - 0.5) / ratio);
      const double right = std::min(static_cast<double>(last), (bin + 0.5) / ratio);
      band.first = static_cast<uint32_t>(left + 0.5);
      band.last = std::min(last, static_cast<uint32_t>(right + 0.5));
      band.inner_weight = 1.0 / (right - left);
      band.first_weight = (std::min(right, band.first + 0.5) - left) / (right - left);
      band.last_weight = (right - std::max(left, band.last - 0.5)) / (right - left);
    }
  }
  return map;
}

void apply_spectral_transfer(const SpectralHistory &prior, const daw_audio_spectral_state &before,
  SpectralHistory &history, const daw_audio_spectral_state &after, const SpectralTransferMap &map) {
  if (before.mode != after.mode || map.before != before.fft_size || map.after != after.fft_size) return;
  if (before.fft_size == after.fft_size) {
    history.frozen_magnitude = prior.frozen_magnitude;
    history.frozen_phase = prior.frozen_phase;
    history.noise_profile = prior.noise_profile;
    history.gate_gain = prior.gate_gain;
    history.freeze_captured = prior.freeze_captured;
    return;
  }
  const bool gate = after.mode == DAW_AUDIO_SPECTRAL_MODE_GATE;
  if (!gate && after.mode != DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE) return;
  for (uint32_t channel = 0; channel < 2; ++channel) {
    const auto &source = gate ? prior.gate_gain[channel] : prior.noise_profile[channel];
    auto &destination = gate ? history.gate_gain[channel] : history.noise_profile[channel];
    const auto power = [&](uint32_t k) { return source[k] * source[k]; };
    for (uint32_t bin = 0; bin <= after.fft_size / 2u; ++bin) {
      const auto &band = map.bands[bin];
      float sum = power(band.first) * band.first_weight + power(band.last) * band.last_weight;
      // Disjoint, control-prepared bands touch each source bin at most twice.
      // Validated sizes <=4096 bound total work by 2*2049/channel.
      for (uint32_t k = band.first + 1u; k < band.last; ++k) sum += power(k) * band.inner_weight;
      destination[bin] = std::sqrt(sum * (gate ? 1.0F : map.level));
    }
  }
}

// Control-side only. The callback applies the immutable map once if the tagged
// state changed after prepare; it never constructs weights or calls trig/log.
void transfer_spectral_persistent(const SpectralHistory &prior, const daw_audio_spectral_state &before,
  SpectralHistory &history, const daw_audio_spectral_state &after) {
  history.replacement.transfer_map = prepare_spectral_transfer(before.fft_size, after.fft_size);
  apply_spectral_transfer(prior, before, history, after, history.replacement.transfer_map);
}
}  // namespace

namespace daw::audio_core_internal {

// The replacement stage runs beside its predecessor until a 10 ms linear seam hands the output over.
void render_spectral_replacement_step(Core &core, GraphRevision &graph, GraphRevision::Processor &processor,
  GraphRevision::Processor &old, RuntimeSlot &slot, uint32_t frame, float left, float right,
  float sidechain_left, float sidechain_right, float &processed_left, float &processed_right) {
  auto &history = core.spectral_histories[processor.spectral_slot];
  auto &input = core.spectral_inputs[old.spectral_slot];
  const uint64_t end = input.end.load(std::memory_order_relaxed);
  // The predecessor has no parameter-cache entry of its own. Freeze must
  // nevertheless follow the replacement's resolved live control so it is
  // the audible released reference while fresh live analysis fills.
  const float freeze = spectral_transform_parameter(core, processor, 15, frame, processor.spectral.freeze);
  const bool freeze_resize = old.spectral.mode == DAW_AUDIO_SPECTRAL_MODE_FREEZE
    && processor.spectral.mode == DAW_AUDIO_SPECTRAL_MODE_FREEZE
    && old.spectral.fft_size != processor.spectral.fft_size;
  const bool latch_now = freeze_resize && !history.replacement.freeze_source_latched
    && core.graph_write_frame + frame >= history.replacement.freeze_source_deadline;
  const bool recapture = freeze_resize
    && (history.replacement.freeze_source_latched ? history.replacement.analysis_from_predecessor : freeze > 0.0F);
  if (history.replacement.freeze_source_latched && (freeze > 0.0F) != history.replacement.analysis_from_predecessor)
    history.replacement.freeze_changed_after_latch = true;
  if (old.spectral.mode == DAW_AUDIO_SPECTRAL_MODE_FREEZE
    && processor.spectral.mode == DAW_AUDIO_SPECTRAL_MODE_FREEZE) old.spectral.freeze = freeze;
  if (!history.replacement.persistent_state_transferred) {
    history.replacement.persistent_state_transferred = true;
    const auto &prior = core.spectral_histories[old.spectral_slot];
    if ((history.replacement.prepared_state_serial != prior.state_serial
      || history.replacement.prepared_state_mode != old.spectral.mode
      || history.replacement.prepared_state_fft_size != old.spectral.fft_size)
      && prior.state_mode == old.spectral.mode && prior.fft_size == old.spectral.fft_size)
      apply_spectral_transfer(prior, old.spectral, history, processor.spectral, history.replacement.transfer_map);
    if (recapture) {
      // Only fresh predecessor wet samples may reach the existing capture
      // step. Old prepared live-input OLA drains while the predecessor stays
      // audible; no bulk reset or spectrum conversion runs on the callback.
      history.freeze_captured.fill(false);
      history.samples_until_frame = processor.spectral.fft_size;
      history.analysis_frames = 0;
      history.replacement.warm_cursor = end;
      history.replacement.analysis_from_predecessor = true;
    }
    const bool same_mode = old.spectral.mode == processor.spectral.mode;
    ++history.state_serial;
    history.state_mode = processor.spectral.mode;
    core.spectral_inputs[processor.spectral_slot].publish(history, processor.spectral.mode);
    if (same_mode && (processor.spectral.mode == DAW_AUDIO_SPECTRAL_MODE_GATE
      || processor.spectral.mode == DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE
      || (processor.spectral.mode == DAW_AUDIO_SPECTRAL_MODE_FREEZE && freeze > 0.0F))) {
      history.replacement.warm_cursor = end - std::min<uint64_t>(end, spectral_warm_frames(processor.spectral));
      // Current envelopes/profiles are not historical state. Replaying
      // past samples would apply release or profile learning twice.
      if (recapture || processor.spectral.mode == DAW_AUDIO_SPECTRAL_MODE_GATE
        || processor.spectral.mode == DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE) history.replacement.warm_cursor = end;
      history.analysis_frames = 0;
    }
  }
  if (!history.replacement.transition_started) {
    history.replacement.warm_cursor = end - std::min<uint64_t>(end, spectral_warm_frames(processor.spectral));
    history.replacement.transition_started = true;
  }
  if (!history.replacement.freeze_source_latched && history.replacement.analysis_from_predecessor != recapture) {
    // Use the same resolved event/automation value as synthesis. A source
    // change needs N fresh samples and the ordinary N+C OLA fill before
    // fading; keep the released predecessor audible during that bounded
    // warm-up. Never replay pre-gesture input with post-gesture parameters.
    history.replacement.analysis_from_predecessor = recapture;
    history.freeze_captured.fill(false);
    history.samples_until_frame = processor.spectral.fft_size;
    history.analysis_frames = 0;
    history.replacement.warm_cursor = end;
  }
  // The publication-relative deadline never restarts. Freeze this final
  // analysis source and replacement Freeze until the ready fade
  // ends; further controls remain in the parameter cache for steady state.
  if (latch_now) history.replacement.freeze_source_latched = true;
  // A command delayed longer than its warm window restarts bounded
  // catch-up from the newest complete warm window. The old stage continues
  // at unity, and at least two FFTs replace any stale algorithm history
  // before this replacement can become audible.
  const uint32_t warm_frames = spectral_warm_frames(processor.spectral) + processor.spectral_compensation;
  if (end - history.replacement.warm_cursor > warm_frames) {
    history.replacement.warm_cursor = end - std::min<uint64_t>(end, warm_frames);
    history.analysis_frames = 0;
    history.replacement.transition_elapsed = 0;
  }
  record_spectral_input(core, old.spectral_slot, left, right, sidechain_left, sidechain_right);
  float old_left = 0.0F, old_right = 0.0F;
  render_spectral_processor(core, old, frame, left, right, sidechain_left, sidechain_right, &old_left, &old_right);
  if (recapture) {
    render_spectral_sample(core, processor, frame, left, right, sidechain_left, sidechain_right,
      &processed_left, &processed_right, &core.spectral_histories[old.spectral_slot].wet_sample);
    history.replacement.warm_cursor = end + 1u;
  }
  // At most two replacement samples per input sample: bounded catch-up
  // from retained stage input, without a publish-time FFT burst or upstream
  // rerender. Only these two stages run until the 10 ms linear seam ends.
  for (uint32_t work = 0; !recapture && work < 2 && history.replacement.warm_cursor < end + 1u; ++work) {
    const uint32_t at = history.replacement.warm_cursor++ & (kSpectralInputFrames - 1u);
    render_spectral_processor(core, processor, frame,
      input.sample(0, at), input.sample(1, at),
      input.sample(2, at), input.sample(3, at),
      &processed_left, &processed_right);
  }
  const uint32_t ola_frames = processor.spectral.overlap;
  bool ready = history.analysis_frames >= ola_frames + 1u;
  if (processor.spectral.mode == DAW_AUDIO_SPECTRAL_MODE_HPSS)
    ready = history.analysis_frames >= kSpectralHpssFrames + ola_frames;
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  const uint64_t absolute = core.graph_write_frame + frame;
  const uint64_t raise_seam = graph.latency_origin + core.latency_publication_shift
    + (graph.latency_raise != 0 ? graph.fade_frames : 0u);
  const bool running = core.transport.running != 0 && core.latency_shrunk_revision != graph.revision
    && graph.nodes[processor.node_index].keep_latency == 0;
  const uint32_t common_latency = processor.spectral.fft_size + processor.spectral_compensation;
  const uint32_t old_delay = !running ? 0u : absolute < raise_seam ? old.spectral_compensation
    : common_latency - old.spectral.fft_size;
  old_left = spectral_delayed_output(core.spectral_histories[old.spectral_slot], 0, old_delay);
  old_right = spectral_delayed_output(core.spectral_histories[old.spectral_slot], 1, old_delay);
  const uint32_t new_delay = running ? processor.spectral_compensation : 0u;
  processed_left = spectral_delayed_output(history, 0, new_delay);
  processed_right = spectral_delayed_output(history, 1, new_delay);
  const uint32_t algorithm_frames = processor.spectral.mode == DAW_AUDIO_SPECTRAL_MODE_HPSS
    ? kSpectralHpssFrames + ola_frames : ola_frames + 1u;
  ready = ready && absolute >= raise_seam
    && history.analysis_frames >= algorithm_frames + (new_delay + history.hop_size - 1u) / history.hop_size;
#endif
  const bool advance_transition = ready && history.replacement.warm_cursor == end + 1u;
  // A gesture can arrive after fading has begun. Hold the last coefficient
  // during replacement-source fill instead of jumping back to predecessor-only.
  const uint32_t fade_at = advance_transition ? history.replacement.transition_elapsed++
    : history.replacement.transition_elapsed - std::min(history.replacement.transition_elapsed, 1u);
  const float mix = std::min(1.0F, static_cast<float>(fade_at) / (graph.fade_frames * 2u));
  processed_left = old_left * (1.0F - mix) + processed_left * mix;
  processed_right = old_right * (1.0F - mix) + processed_right * mix;
  if (mix == 1.0F) {
    if (history.replacement.analysis_from_predecessor && history.replacement.freeze_changed_after_latch) {
      // The existing dry delay retains exactly N live stage-input samples.
      // Restore that analysis window at the seam so a deferred engage
      // captures live input, not the predecessor's wet tail. This bounded
      // 2N copy leaves the capture spectrum, OLA and aligned output intact.
      const uint32_t size = processor.spectral.fft_size;
      for (uint32_t channel = 0; channel < 2; ++channel)
        for (uint32_t i = 0; i < size; ++i)
          history.input[channel][(history.write_index - size + i) & (kMaximumSpectralFftSize - 1u)]
            = history.dry[channel][(history.write_index + i) & (kMaximumSpectralFftSize * 2u - 1u)];
    }
    // Even release -> engage ending at the latched value needs a fresh
    // normal capture. Clear only capture ownership, never the OLA tail.
    if (history.replacement.freeze_changed_after_latch) {
      history.freeze_captured.fill(false);
      ++history.state_serial;
      core.spectral_inputs[processor.spectral_slot].publish(history, processor.spectral.mode);
    }
    history.replacement.freeze_source_latched = false;
    retire_runtime_slot(core, slot);
  }
}

// Control side of a spectral stage replacing a predecessor of another FFT size or mode: the
// predecessor keeps rendering beside it, and the stage is warmed from the predecessor's retained input.
daw_audio_core_result prepare_spectral_replacement(Core &core, const GraphRevision &current, GraphRevision &next,
  GraphRevision::Processor &processor, uint32_t previous, uint32_t owned) {
  if (next.spectral_predecessor_count == kMaximumSpectralProcessors) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  processor.spectral_predecessor = static_cast<int32_t>(next.spectral_predecessor_count++);
  next.spectral_predecessors[processor.spectral_predecessor] = current.processors[previous];
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  const auto &prior = current.processors[previous];
  if (core.transport_running.load(std::memory_order_acquire)
    && next.nodes[processor.node_index].keep_latency == 0) {
    const uint32_t padding = core.latency_shrunk_revision.load(std::memory_order_acquire) == current.revision
      ? 0u : prior.spectral_compensation;
    processor.spectral_compensation = std::max(prior.spectral.fft_size + padding,
      processor.spectral.fft_size) - processor.spectral.fft_size;
  }
#endif
  next.spectral_predecessors[processor.spectral_predecessor].spectral_predecessor = -1;
  // The old stage has no cache entry. render_chain_frame forwards the
  // effective Freeze control; other controls retain this configuration.
  next.spectral_predecessors[processor.spectral_predecessor].parameter_count = 0;
  // Prepare the new algorithm from an atomic, retained stage-input
  // window. This is control-side only; it never reads mutable FFT state
  // or executes an upstream processor. Publication catches up only the
  // samples that arrived while this immutable revision was in flight.
  auto &input = core.spectral_inputs[current.processors[previous].spectral_slot];
  auto &history = core.spectral_histories[owned];
  const bool valid_snapshot = input.read(core.spectral_state_snapshot, current.processors[previous].spectral);
  const uint64_t end = input.end.load(std::memory_order_acquire);
  const uint64_t begin = end - std::min<uint64_t>(end,
    spectral_warm_frames(processor.spectral) + processor.spectral_compensation);
  const uint32_t parameters = processor.parameter_count;
  processor.parameter_count = 0;
  {
    PrepareScope warm_scope(core, "spectral-warm");
    for (uint64_t cursor = begin; cursor < end; ++cursor) {
      const uint32_t at = cursor & (kSpectralInputFrames - 1u);
      float left = 0.0F, right = 0.0F;
      render_spectral_processor(core, processor, 0,
        input.sample(0, at), input.sample(1, at),
        input.sample(2, at), input.sample(3, at),
        &left, &right);
    }
  }
  processor.parameter_count = parameters;
  if (valid_snapshot)
    transfer_spectral_persistent(core.spectral_state_snapshot, current.processors[previous].spectral,
      history, processor.spectral);
  else history.replacement.transfer_map = prepare_spectral_transfer(current.processors[previous].spectral.fft_size,
    processor.spectral.fft_size);
  // Serial zero means no analysis frame has been published yet. In
  // particular, an unobserved Gate starts at unity, not snapshot zeros.
  history.replacement.prepared_state_serial = core.spectral_state_snapshot.state_serial == 0
    ? UINT64_MAX : core.spectral_state_snapshot.state_serial;
  history.replacement.prepared_state_mode = valid_snapshot ? current.processors[previous].spectral.mode : UINT32_MAX;
  history.replacement.prepared_state_fft_size = valid_snapshot ? current.processors[previous].spectral.fft_size : 0;
  // A preempted preparation may have lost its oldest samples. Do not
  // expose that partial warmup or race an overwritten window: this is
  // genuine bounded-history exhaustion, not a published transition.
  const uint64_t completed = input.end.load(std::memory_order_acquire);
  if (completed - begin >= kSpectralInputFrames) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  history.replacement.warm_cursor = end;
  history.replacement.transition_started = true;
  return DAW_AUDIO_CORE_OK;
}
}  // namespace daw::audio_core_internal
