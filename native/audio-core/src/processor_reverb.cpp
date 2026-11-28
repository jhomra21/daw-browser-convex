#include "audio_core_internal.h"

namespace {

constexpr float kTwoPi = 6.2831853071795864769F;
constexpr float kLineOutputScale = 0.35355339059327376220F;  // 1/sqrt(kReverbLineCount)
float flush_denormal(float value) { return std::fabs(value) < 1.0e-20F ? 0.0F : value; }

// Line lengths in frames at 48 kHz for size 1.0. Distinct primes keep the lines mutually
// incommensurate; size and rate scale them 0.7x to 1.2x (21 to 75 ms at 48 kHz), keeping
// the 20 to 100 ms character, and interpolated reads keep them from re-aligning.
constexpr std::array<float, kReverbLineCount> kReverbLineFrames48k{
  1447.0F, 1583.0F, 1789.0F, 1951.0F, 2203.0F, 2399.0F, 2663.0F, 3011.0F};
// Input diffusion allpass lengths in frames at 48 kHz, one chain per channel.
constexpr std::array<std::array<float, kReverbDiffusionStages>, 2> kReverbDiffusionFrames48k{{
  {113.0F, 163.0F, 241.0F}, {127.0F, 179.0F, 263.0F}}};
// Orthogonal, zero-mean sign patterns that tap the lines into the left and right channel.
// Neither is a row of the Hadamard mix (a row would read back a single line and leave its
// period audible), so each tap blends several mix rows.
constexpr std::array<std::array<float, kReverbLineCount>, 2> kReverbOutputSigns{{
  {1.0F, -1.0F, -1.0F, -1.0F, -1.0F, 1.0F, 1.0F, 1.0F},
  {1.0F, -1.0F, -1.0F, 1.0F, 1.0F, -1.0F, 1.0F, -1.0F}}};
// Early-reflection tap offsets in ms (before the size scale) for each channel.
constexpr std::array<std::array<float, 4>, 2> kReverbEarlyTapsMs{{
  {0.0F, 11.3F, 19.7F, 29.1F}, {0.0F, 9.1F, 23.3F, 31.7F}}};

// Each line loses 10^(-3 L / (decay * rate)) per trip, so the tail falls 60 dB in decay seconds.
void update_reverb_lines(ReverbNetwork &network, float decay_sec, float size, uint32_t rate_hz) {
  if (network.decay_key == decay_sec && network.size_key == size && network.rate_key == rate_hz) return;
  const float rate = static_cast<float>(rate_hz);
  const float scale = (0.7F + 0.5F * size) * rate / 48000.0F;
  for (uint32_t line = 0; line < kReverbLineCount; ++line) {
    // Whole frames: a fractional read would low-pass the loop and shorten the decay.
    const float frames = std::fmin(std::round(kReverbLineFrames48k[line] * scale), static_cast<float>(kReverbLineFrames - 512));
    network.line_frames[line] = frames;
    network.line_gain[line] = std::fmin(0.9999F, std::pow(10.0F, -3.0F * frames / (decay_sec * rate)));
  }
  network.decay_key = decay_sec;
  network.size_key = size;
  network.rate_key = rate_hz;
}

// Series Schroeder allpasses; the coefficient follows diffusion.
float diffuse_reverb_input(ReverbNetwork &network, uint32_t channel, float input, float coefficient, float rate) {
  float signal = input;
  for (uint32_t stage = 0; stage < kReverbDiffusionStages; ++stage) {
    std::array<float, kReverbDiffusionFrames> &buffer = network.diffusion[channel * kReverbDiffusionStages + stage];
    const uint32_t delay = std::min(
      kReverbDiffusionFrames - 1,
      std::max(1U, static_cast<uint32_t>(kReverbDiffusionFrames48k[channel][stage] * rate / 48000.0F)));
    const float delayed = buffer[(network.diffusion_write + kReverbDiffusionFrames - delay) % kReverbDiffusionFrames];
    const float state = signal + coefficient * delayed;
    buffer[network.diffusion_write] = state;
    signal = delayed - coefficient * state;
  }
  return signal;
}
}  // namespace

namespace daw::audio_core_internal {

// Advances the reverb one frame and returns whether it is enabled; left and right are the
// wet/dry mix, before bypass.
bool render_reverb_sample(
  Core &core, GraphRevision::Processor &processor, uint32_t frame, ReverbHistory &history,
  float dry_left, float dry_right, float *left, float *right) {
  const float rate = static_cast<float>(core.config.sample_rate_hz);
  ReverbNetwork &network = history.network;
  daw_audio_reverb_state reverb_state = processor.reverb;
  reverb_state.wet = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_WET, frame, reverb_state.wet);
  reverb_state.pre_delay_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_PRE_DELAY_MS, frame, reverb_state.pre_delay_ms);
  reverb_state.low_cut_hz = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_LOW_CUT_HZ, frame, reverb_state.low_cut_hz);
  reverb_state.high_cut_hz = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_HIGH_CUT_HZ, frame, reverb_state.high_cut_hz);
  reverb_state.stereo_width = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_STEREO_WIDTH, frame, reverb_state.stereo_width);
  reverb_state.decay_sec = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DECAY_SEC, frame, reverb_state.decay_sec);
  reverb_state.reflections = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTIONS, frame, reverb_state.reflections);
  reverb_state.reflection_mod_amount_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTION_MOD_AMOUNT_MS, frame, reverb_state.reflection_mod_amount_ms);
  reverb_state.reflection_mod_rate_hz = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTION_MOD_RATE_HZ, frame, reverb_state.reflection_mod_rate_hz);
  reverb_state.reflection_shape = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTION_SHAPE, frame, reverb_state.reflection_shape);
  reverb_state.diffuse = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DIFFUSE, frame, reverb_state.diffuse);
  reverb_state.size = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_SIZE, frame, reverb_state.size);
  reverb_state.diffusion = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DIFFUSION, frame, reverb_state.diffusion);
  reverb_state.density = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DENSITY, frame, reverb_state.density);
  reverb_state.diffusion_low_cut_hz = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DIFFUSION_LOW_CUT_HZ, frame, reverb_state.diffusion_low_cut_hz);
  reverb_state.diffusion_high_cut_hz = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DIFFUSION_HIGH_CUT_HZ, frame, reverb_state.diffusion_high_cut_hz);
  const float reverb_modulation_ms = reverb_state.reflections > 0.0F && reverb_state.reflection_spin != 0
    ? std::sin(static_cast<float>(history.phase) * kTwoPi) * reverb_state.reflection_mod_amount_ms * 0.5F
    : 0.0F;
  const float bounded_wet = std::fmax(0.0F, std::fmin(reverb_state.wet, 1.0F));
  const float bounded_pre_delay_ms = std::fmax(0.0F, std::fmin(reverb_state.pre_delay_ms, 250.0F));
  const float bounded_low_cut_hz = std::fmax(20.0F, std::fmin(reverb_state.low_cut_hz, 1200.0F));
  const float bounded_high_cut_hz = std::fmax(1200.0F, std::fmin(reverb_state.high_cut_hz, 20000.0F));
  const float bounded_width = std::fmax(0.0F, std::fmin(reverb_state.stereo_width, 2.0F));
  const float bounded_size = std::fmax(0.0F, std::fmin(reverb_state.size, 1.0F));
  const float bounded_shape = std::fmax(0.0F, std::fmin(reverb_state.reflection_shape, 1.0F));
  const float pre_delay_frames = std::fmax(
    1.0F,
    bounded_pre_delay_ms * rate / 1000.0F + reverb_modulation_ms * rate / 1000.0F);
  const float stereo_spread_frames = processor.input_layout == DAW_AUDIO_GRAPH_LAYOUT_MONO
    ? (6.0F + bounded_size * 8.0F) * rate / 1000.0F
    : 0.0F;
  const float raw_left = read_time_effect_delay(history.left, history.write, pre_delay_frames);
  const float raw_right = read_time_effect_delay(history.right, history.write, pre_delay_frames + stereo_spread_frames);

  // Early reflections are taps of the pre-delay line; the shape sets how slowly they fade.
  const float tap_fade = 0.55F + 0.4F * bounded_shape;
  const float tap_scale = (0.5F + bounded_size) * rate / 1000.0F;
  float early_left = 0.0F;
  float early_right = 0.0F;
  float tap_weight = 1.0F;
  float tap_energy = 0.0F;
  for (uint32_t tap = 0; tap < kReverbEarlyTapsMs[0].size(); ++tap) {
    early_left += tap_weight * read_time_effect_delay(
      history.left, history.write, pre_delay_frames + kReverbEarlyTapsMs[0][tap] * tap_scale);
    early_right += tap_weight * read_time_effect_delay(
      history.right, history.write, pre_delay_frames + stereo_spread_frames + kReverbEarlyTapsMs[1][tap] * tap_scale);
    tap_energy += tap_weight * tap_weight;
    tap_weight *= tap_fade;
  }
  const float reflection_gain = reverb_state.reflections * (0.65F + reverb_state.reflection_shape * 0.7F)
    / std::sqrt(tap_energy);

  const bool has_late_texture = reverb_state.diffuse > 0.0F
    && reverb_state.density > 0.0F
    && reverb_state.diffusion > 0.0F;
  const float texture_gain = std::fmax(0.0F, std::fmin(
    reverb_state.diffuse * reverb_state.density
    * (0.5F + 0.5F * reverb_state.diffusion), 1.0F));
  update_reverb_lines(network, std::fmax(0.05F, reverb_state.decay_sec), bounded_size, core.config.sample_rate_hz);
  const float diffusion_coefficient = 0.7F * std::fmax(0.0F, std::fmin(reverb_state.diffusion, 1.0F));
  const float diffused[2]{
    diffuse_reverb_input(network, 0, raw_left, diffusion_coefficient, rate),
    diffuse_reverb_input(network, 1, raw_right, diffusion_coefficient, rate)};
  const float low_cut = std::fmax(bounded_low_cut_hz, reverb_state.diffusion_low_cut_hz);
  const float high_cut = std::fmin(bounded_high_cut_hz, reverb_state.diffusion_high_cut_hz);
  const float lowpass_alpha = 1.0F - std::exp(-kTwoPi * std::fmin(high_cut, rate * 0.49F) / rate);
  const float highpass_alpha = std::exp(-kTwoPi * low_cut / rate);
  const float modulation_frames = std::fmin(reverb_state.reflections > 0.0F && reverb_state.reflection_spin != 0
    ? reverb_state.reflection_mod_amount_ms * 0.5F : 0.0F, 2.0F) * rate / 1000.0F;
  std::array<float, kReverbLineCount> filtered{};
  float late_left = 0.0F;
  float late_right = 0.0F;
  for (uint32_t line = 0; line < kReverbLineCount; ++line) {
    const float delay = network.line_frames[line] + (modulation_frames > 0.0F
      ? modulation_frames * std::sin(kTwoPi * (static_cast<float>(history.phase) + static_cast<float>(line) / kReverbLineCount))
      : 0.0F);
    const float delayed = read_time_effect_delay(network.lines[line], network.line_write, delay) * network.line_gain[line];
    network.low[line] += lowpass_alpha * (delayed - network.low[line]);
    network.high[line] = highpass_alpha * (network.high[line] + network.low[line] - network.high_input[line]);
    network.high_input[line] = network.low[line];
    filtered[line] = network.high[line];
    late_left += kReverbOutputSigns[0][line] * filtered[line];
    late_right += kReverbOutputSigns[1][line] * filtered[line];
  }
  // Hadamard mix: orthogonal, so the per-line gains alone set the decay, and every line
  // feeds every other one.
  for (uint32_t span = 1; span < kReverbLineCount; span <<= 1) {
    for (uint32_t start = 0; start < kReverbLineCount; start += 2 * span) {
      for (uint32_t index = start; index < start + span; ++index) {
        const float sum = filtered[index] + filtered[index + span];
        filtered[index + span] = filtered[index] - filtered[index + span];
        filtered[index] = sum;
      }
    }
  }
  for (uint32_t line = 0; line < kReverbLineCount; ++line) {
    network.lines[line][network.line_write] = flush_denormal(filtered[line] * kLineOutputScale
      + (has_late_texture ? 0.5F * diffused[line & 1U] : 0.0F));
  }
  network.line_write = (network.line_write + 1) % kReverbLineFrames;
  network.diffusion_write = (network.diffusion_write + 1) % kReverbDiffusionFrames;
  history.left[history.write] = dry_left;
  history.right[history.write] = dry_right;
  history.write = (history.write + 1) % static_cast<uint32_t>(history.left.size());
  const float output_late_left = has_late_texture ? late_left * kLineOutputScale * texture_gain : 0.0F;
  const float output_late_right = has_late_texture ? late_right * kLineOutputScale * texture_gain : 0.0F;
  const float wide_left = output_late_left * (1.0F + bounded_width) * 0.5F
    + output_late_right * (1.0F - bounded_width) * 0.5F;
  const float wide_right = output_late_right * (1.0F + bounded_width) * 0.5F
    + output_late_left * (1.0F - bounded_width) * 0.5F;
  *left = dry_left * (1.0F - bounded_wet) + (wide_left + early_left * reflection_gain) * bounded_wet;
  *right = dry_right * (1.0F - bounded_wet) + (wide_right + early_right * reflection_gain) * bounded_wet;
  history.phase += static_cast<double>(reverb_state.reflection_mod_rate_hz) / static_cast<double>(core.config.sample_rate_hz);
  history.phase -= std::floor(history.phase);
  return reverb_state.enabled != 0;
}
}  // namespace daw::audio_core_internal
