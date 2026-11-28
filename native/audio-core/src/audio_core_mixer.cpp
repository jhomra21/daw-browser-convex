#include "audio_core_internal.h"

namespace {

constexpr uint32_t mixer_value_index(uint32_t target) {
  return target - DAW_AUDIO_MIXER_PARAMETER_GAIN;
}
}  // namespace

namespace daw::audio_core_internal {

MixerBlock begin_mixer_block(const Core &core, const daw_audio_mixer_state &mixer, uint32_t slot) {
  MixerBlock block{.slot = slot, .active = mixer.instance_id != 0};
  if (!block.active) return block;
  block.values = {mixer.gain, mixer.pan, mixer.muted == 0 ? 0.0F : 1.0F, mixer.soloed == 0 ? 0.0F : 1.0F};
  const Core::MixerLatch &latch = core.mixer_latches[slot];
  for (uint32_t index = 0; index < kMixerParameterCount; ++index) {
    if ((latch.mask & (1u << index)) != 0) block.values[index] = latch.values[index];
  }
  const daw_audio_processor_event *events_end = core.active_events + core.active_event_count;
  block.next = std::lower_bound(core.active_events, events_end, mixer.instance_id,
    [](const daw_audio_processor_event &event, uint64_t id) { return event.processor_instance_id < id; });
  block.end = std::upper_bound(block.next, events_end, mixer.instance_id,
    [](uint64_t id, const daw_audio_processor_event &event) { return id < event.processor_instance_id; });
  return block;
}
}  // namespace daw::audio_core_internal

namespace {

void advance_mixer_block(MixerBlock &mixer, uint32_t frame) {
  for (; mixer.next != mixer.end && mixer.next->frame_offset <= frame; ++mixer.next) {
    const uint32_t index = mixer_value_index(mixer.next->parameter_target);
    if (index >= kMixerParameterCount) continue;
    mixer.values[index] = mixer.next->value;
    mixer.written = static_cast<uint8_t>(mixer.written | (1u << index));
  }
}
}  // namespace

namespace daw::audio_core_internal {

bool resolve_mixer_solo(Core &core, const GraphRevision &graph, uint32_t frame_count) {
  bool soloed = false;
  for (uint32_t node = 0; node < graph.node_count; ++node) {
    MixerBlock mixer = begin_mixer_block(core, graph.nodes[node].mixer, graph.node_slots[node]);
    for (uint32_t frame = 0; mixer.active && frame < frame_count;) {
      advance_mixer_block(mixer, frame);
      const uint32_t until = mixer.next == mixer.end ? frame_count : mixer.next->frame_offset;
      if (mixer.values[mixer_value_index(DAW_AUDIO_MIXER_PARAMETER_SOLO)] == 1.0F) {
        if (!soloed) std::fill_n(core.mixer_solo_frames.begin(), frame_count, uint8_t{0});
        soloed = true;
        std::fill(core.mixer_solo_frames.begin() + frame, core.mixer_solo_frames.begin() + until, uint8_t{1});
      }
      frame = until;
    }
  }
  return soloed;
}

// One frame of a fader. A publish that changed what a retained node applies moves
// its gains there over the plan's fade (begin_mixer_ramps); otherwise they follow
// the values at once.
void apply_mixer_frame(Core &core, MixerBlock &mixer, uint32_t frame, bool solo_active,
  float *left, float *right) {
  if (!mixer.active) return;
  advance_mixer_block(mixer, frame);
  const bool silent = mixer.values[mixer_value_index(DAW_AUDIO_MIXER_PARAMETER_MUTE)] == 1.0F
    || (solo_active && mixer.values[mixer_value_index(DAW_AUDIO_MIXER_PARAMETER_SOLO)] != 1.0F);
  std::array<float, 2> gains{};
  if (!silent) {
    const float gain = mixer.values[mixer_value_index(DAW_AUDIO_MIXER_PARAMETER_GAIN)];
    const float pan = mixer.values[mixer_value_index(DAW_AUDIO_MIXER_PARAMETER_PAN)];
    gains = {std::min(1.0F, 1.0F - pan) * gain, std::min(1.0F, 1.0F + pan) * gain};
  }
  Core::MixerRamp &ramp = core.mixer_ramps[mixer.slot];
  ramp.seen = true;
  if (ramp.elapsed < ramp.frames) {
    const float progress = static_cast<float>(++ramp.elapsed) / static_cast<float>(ramp.frames);
    for (uint32_t channel = 0; channel < 2; ++channel) {
      gains[channel] = ramp.from[channel] + (gains[channel] - ramp.from[channel]) * progress;
    }
  } else if (silent) {
    ramp.applied = gains;
    *left = 0.0F;
    *right = 0.0F;
    return;
  }
  ramp.applied = gains;
  *left *= gains[0];
  *right *= gains[1];
}
}  // namespace daw::audio_core_internal
