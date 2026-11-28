#include "audio_core_internal.h"

namespace daw::audio_core_internal {

// Plans name slots that the previous plan owned: those it neither keeps nor
// fades out are retired by publish. Computed here so publish stays an integer loop.
void collect_released_slots(Core &core) {
  const GraphRevision &current = *core.published_graph;
  GraphRevision &next = *core.prepared_graph;
  std::array<bool, kProcessorRuntimeSlots> processor_kept{};
  std::array<bool, kNodeRuntimeSlots> node_kept{};
  for (uint32_t index = 0; index < next.total_processor_count(); ++index) {
    processor_kept[next.processors[index].history_slot] = true;
  }
  for (uint32_t index = 0; index < next.spectral_predecessor_count; ++index)
    processor_kept[next.spectral_predecessors[index].history_slot] = true;
  for (uint32_t index = 0; index < next.total_node_count(); ++index) node_kept[next.node_slots[index]] = true;
  // A replaced instrument's slot stays active beside its replacement; the node
  // retires it itself once the fade has run.
  for (uint32_t index = 0; index < next.node_count; ++index) {
    if (next.node_replaces[index] != 0) node_kept[current.node_slots[next.node_replaces[index] - 1u]] = true;
  }
  next.released_processor_count = 0;
  next.released_node_count = 0;
  for (uint32_t index = 0; index < current.spectral_predecessor_count; ++index) {
    const auto &processor = current.spectral_predecessors[index];
    if (!processor_kept[processor.history_slot])
      next.released_processors[next.released_processor_count++] = {
        static_cast<uint16_t>(processor.history_slot), processor.generation};
  }
  for (uint32_t index = 0; index < current.total_processor_count(); ++index) {
    const auto &processor = current.processors[index];
    if (!processor_kept[processor.history_slot]) {
      next.released_processors[next.released_processor_count++] = {
        static_cast<uint16_t>(processor.history_slot), processor.generation};
    }
  }
  for (uint32_t index = 0; index < current.total_node_count(); ++index) {
    if (!node_kept[current.node_slots[index]]) {
      next.released_nodes[next.released_node_count++] = {current.node_slots[index], current.node_generations[index]};
    }
  }
}

// A node keeps its slot (and so its voices and live overrides) only when the
// latency verdict was accepted and, for instruments, the configuration is
// unchanged. A node whose own configuration changed gets a fresh slot initialized
// from the prepared configuration; no other node is touched.
// Returns false when no node slot is free.
bool assign_prepared_node(Core &core, uint32_t index) {
  GraphRevision &next = *core.prepared_graph;
  const GraphRevision &current = *core.published_graph;
  RuntimeSlot &previous_slot = core.node_slots[next.node_slots[index]];
  if (previous_slot.state.load(std::memory_order_relaxed) == kSlotPrepared
    && previous_slot.generation.load(std::memory_order_relaxed) == next.node_generations[index]) {
    previous_slot.state.store(kSlotInitialized, std::memory_order_release);
  }
  const auto &node = next.nodes[index];
  const int32_t previous = current.revision == 0 ? -1 : graph_node_index(current, node.id);
  const bool retained = core.prepared_continuity == ContinuityPreparationResult::kAccepted && previous >= 0
    && current.nodes[static_cast<uint32_t>(previous)].kind == node.kind
    && (node.kind != DAW_AUDIO_GRAPH_NODE_INSTRUMENT
      || (core.prepared_instrument_previous_nodes[index] == previous
        && same_instrument_configuration(
          current.nodes[static_cast<uint32_t>(previous)], node,
          (*core.published_instrument_configs)[static_cast<uint32_t>(previous)],
          (*core.prepared_instrument_configs)[index])));
  if (retained) {
    next.node_slots[index] = current.node_slots[static_cast<uint32_t>(previous)];
    next.node_generations[index] = current.node_generations[static_cast<uint32_t>(previous)];
    return true;
  }
  const int32_t slot_index = acquire_runtime_slot(core.node_slots);
  if (slot_index < 0) return false;
  core.prepared_runtime_held = true;
  next.node_slots[index] = static_cast<uint16_t>(slot_index);
  next.node_generations[index] = core.node_slots[slot_index].generation.load(std::memory_order_relaxed);
  InstrumentNodeState &runtime = core.instrument_runtime[slot_index];
  runtime = {};
  set_up_instrument(runtime, (*core.prepared_instrument_configs)[index]);
  return true;
}
}  // namespace daw::audio_core_internal

namespace {

// Where a processor's bypass position lives, whichever kind it is.
float *bypass_level(Core &core, const GraphRevision::Processor &processor) {
  switch (processor.kind) {
    case DAW_AUDIO_PROCESSOR_KIND_UTILITY: return &core.utility_histories[processor.history_slot].bypass;
    case DAW_AUDIO_PROCESSOR_KIND_SATURATOR: return &core.saturator_histories[processor.history_slot].bypass;
    case DAW_AUDIO_PROCESSOR_KIND_EQ: return &core.eq_histories[processor.history_slot].bypass;
    case DAW_AUDIO_PROCESSOR_KIND_GATE: return &core.dynamics_histories[processor.history_slot].bypass;
    case DAW_AUDIO_PROCESSOR_KIND_COMPRESSOR: return &core.compressor_histories[processor.compressor_slot].bypass;
    case DAW_AUDIO_PROCESSOR_KIND_LIMITER: return &core.limiter_histories[processor.limiter_slot].bypass;
    case DAW_AUDIO_PROCESSOR_KIND_AUTOFILTER: return &core.autofilter_histories[processor.history_slot].bypass;
    case DAW_AUDIO_PROCESSOR_KIND_LOFI: return &core.lofi_histories[processor.history_slot].bypass;
    case DAW_AUDIO_PROCESSOR_KIND_CHORUS:
    case DAW_AUDIO_PROCESSOR_KIND_FLANGER:
    case DAW_AUDIO_PROCESSOR_KIND_ENSEMBLE:
    case DAW_AUDIO_PROCESSOR_KIND_PHASER:
    case DAW_AUDIO_PROCESSOR_KIND_TREMOLO:
    case DAW_AUDIO_PROCESSOR_KIND_AUTOPAN: return &core.modulation_histories[processor.history_slot].bypass;
    case DAW_AUDIO_PROCESSOR_KIND_DELAY: return &core.delay_histories[processor.delay_slot].bypass;
    case DAW_AUDIO_PROCESSOR_KIND_REVERB: return &core.reverb_histories[processor.reverb_slot].bypass;
    case DAW_AUDIO_PROCESSOR_KIND_SPECTRAL: return &core.spectral_histories[processor.spectral_slot].bypass;
    default: return nullptr;
  }
}

// Whether the plan entry asks for its dry signal: bypassed, or its own enabled flag off.
bool bypass_requested(const GraphRevision::Processor &processor) {
  if (processor.bypassed != 0) return true;
  switch (processor.kind) {
    case DAW_AUDIO_PROCESSOR_KIND_UTILITY: return processor.utility.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_SATURATOR: return processor.saturator.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_EQ: return processor.eq.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_GATE: return processor.gate.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_COMPRESSOR: return processor.compressor.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_LIMITER: return processor.limiter.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_AUTOFILTER: return processor.autofilter.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_LOFI: return processor.lofi.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_CHORUS:
    case DAW_AUDIO_PROCESSOR_KIND_FLANGER: return processor.delay_modulation.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_ENSEMBLE: return processor.ensemble.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_PHASER: return processor.phaser.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_TREMOLO:
    case DAW_AUDIO_PROCESSOR_KIND_AUTOPAN: return processor.amplitude_modulation.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_DELAY: return processor.delay.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_REVERB: return processor.reverb.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_SPECTRAL: return processor.spectral.enabled == 0;
    default: return false;
  }
}

// A processor that gets a fresh slot starts its bypass where it is asked to sit, so
// one that is built bypassed (a graph's first plan, a replacement or an addition)
// is dry from its first sample instead of flashing wet while a ramp climbs from
// zero. One that joins a node that is already sounding starts on its dry signal
// and ramps in (an effect appearing in a sounding chain is a transition, not a
// cut). One that replaces another of the same identity is overwritten by
// hand_off_bypass at publish. Preparation only, on a slot the callback has not
// seen yet.
void seed_bypass(Core &core, const GraphRevision::Processor &fresh, bool joining) {
  if (float *level = bypass_level(core, fresh)) {
    *level = joining || bypass_requested(fresh) ? 1.0F : 0.0F;
  }
}

// Callback side of publish, integers and floats it owns only: a processor that
// replaced another of the same identity continues the bypass ramp where the old
// one actually stands, whether or not it has settled. The old slot is still
// active here (publish retires it afterwards) and the generation proves it is the
// one the plan was prepared against.
void hand_off_bypass(Core &core, const GraphRevision &replaced, const GraphRevision &plan) {
  for (uint32_t index = 0; index < plan.processor_count; ++index) {
    const GraphRevision::Processor &fresh = plan.processors[index];
    if (fresh.bypass_source < 0 || static_cast<uint32_t>(fresh.bypass_source) >= replaced.processor_count) continue;
    const GraphRevision::Processor &old = replaced.processors[static_cast<uint32_t>(fresh.bypass_source)];
    const RuntimeSlot &slot = core.processor_slots[old.history_slot];
    if (old.instance_id != fresh.instance_id || old.kind != fresh.kind
      || slot.state.load(std::memory_order_acquire) != kSlotActive
      || slot.generation.load(std::memory_order_relaxed) != old.generation) continue;
    float *from = bypass_level(core, old);
    float *to = bypass_level(core, fresh);
    if (from != nullptr && to != nullptr) *to = *from;
  }
}

// Preparation only, once slots are assigned: the surviving nodes whose stages run
// in a different order than they do now and so dip at publish. (A layout change and a
// replaced instrument crossfade their waveforms instead.) False when a replacement
// exceeds the blend capacity.
bool mark_reordered_nodes(
  const Core &core, const GraphRevision &current, GraphRevision &next, const ProcessorContinuityMap &processors) {
  bool capacity = true;
  for (uint32_t node = 0; node < next.node_count; ++node) {
    capacity = mark_replaced_node(core, current, next, node) && capacity;
    const int32_t previous = graph_node_index(current, next.nodes[node].id);
    if (previous < 0 || current.nodes[static_cast<uint32_t>(previous)].kind != next.nodes[node].kind) continue;
    const GraphRevision::Range old_chain = current.processor_ranges[static_cast<uint32_t>(previous)];
    const GraphRevision::Range new_chain = next.processor_ranges[node];
    int32_t last_position = -1;
    for (uint32_t link = new_chain.start; link < static_cast<uint32_t>(new_chain.start) + new_chain.count; ++link) {
      const uint32_t index = next.processor_indices[link];
      const int32_t kept = index < next.processor_count ? processors.previous[index] : -1;
      if (kept < 0) continue;
      int32_t position = -1;
      for (uint32_t old = 0; old < old_chain.count; ++old) {
        if (current.processor_indices[old_chain.start + old] == static_cast<uint32_t>(kept)) position = static_cast<int32_t>(old);
      }
      if (position < 0) continue;
      if (position < last_position) next.node_reordered[node] = true;
      last_position = std::max(last_position, position);
    }
  }
  return capacity;
}

// Carries the dip of the node `node` of `plan`, which stood at `previous` in the plan
// being left, across the publish. A node whose stages now run in a different order
// than the one it renders starts to dip; one already dipping keeps fading out
// through the order it was keeping, named in the new plan, and from where its
// output stands. A dip that has nothing left to keep returns from where it stands.
void carry_node_dip(
  Core &core, const GraphRevision &replaced, GraphRevision &plan, uint32_t node, uint32_t previous, bool reordered) {
  Core::NodeDip &dip = core.node_dips[plan.node_slots[node]];
  const bool keeping_order = dip.phase == Core::kDipFadingOut;
  if (!reordered && !keeping_order) return;
  // The order the node renders now: the published chain, with the stages a dip is
  // keeping back in the order they ran.
  const GraphRevision::Range published = replaced.processor_ranges[previous];
  const auto kept_end = dip.order.begin() + dip.count;
  std::array<uint16_t, kMaximumNodeChain> order{};
  uint32_t order_count = 0;
  uint32_t taken = 0;
  for (uint32_t link = published.start; link < static_cast<uint32_t>(published.start) + published.count; ++link) {
    uint32_t index = replaced.processor_indices[link];
    if (index >= replaced.total_processor_count()) continue;
    if (keeping_order && std::find(dip.order.begin(), kept_end, index) != kept_end) index = dip.order[taken++];
    const int32_t survivor = plan.processor_remap[index];
    if (survivor >= 0 && plan.processors[static_cast<uint32_t>(survivor)].node_index == node
      && find_processor_renderer(plan.processors[static_cast<uint32_t>(survivor)].kind) != nullptr) {
      order[order_count++] = static_cast<uint16_t>(survivor);
    }
  }
  // It differs when the plan's chain would run those stages another way round.
  bool differs = false;
  const GraphRevision::Range chain = plan.processor_ranges[node];
  const auto order_end = order.begin() + order_count;
  uint32_t position = 0;
  for (uint32_t link = chain.start; link < static_cast<uint32_t>(chain.start) + chain.count; ++link) {
    const uint32_t index = plan.processor_indices[link];
    if (index >= plan.total_processor_count() || std::find(order.begin(), order_end, index) == order_end) continue;
    differs = differs || order[position] != index;
    ++position;
  }
  if (differs) {
    dip.order = order;
    dip.count = order_count;
    if (!keeping_order) {
      if (dip.phase == Core::kDipNone) dip.level = dip_half_frames(plan);
      dip.phase = Core::kDipFadingOut;
    }
  } else if (keeping_order) {
    dip.phase = Core::kDipFadingIn;
    dip.count = 0;
  }
}

// The voices a full instrument of `capacity` would keep out of `voices`, best first
// by `outranks`; the rest are the ones it would give way.
template <typename Voice, typename Outranks>
std::array<bool, kMaximumInstrumentVoices> surviving_voices(
  const std::array<Voice, kMaximumInstrumentVoices> &voices, uint32_t capacity, Outranks outranks) {
  std::array<bool, kMaximumInstrumentVoices> keep{};
  for (uint32_t kept = 0; kept < capacity; ++kept) {
    int32_t best = -1;
    for (uint32_t index = 0; index < voices.size(); ++index) {
      if (voices[index].active && !keep[index] && (best < 0 || outranks(voices[index], voices[static_cast<uint32_t>(best)]))) {
        best = static_cast<int32_t>(index);
      }
    }
    if (best < 0) break;
    keep[static_cast<uint32_t>(best)] = true;
  }
  return keep;
}

template <typename Voice>
void carry_voices(
  const std::array<Voice, kMaximumInstrumentVoices> &voices, const std::array<bool, kMaximumInstrumentVoices> &keep,
  std::array<Voice, kMaximumInstrumentVoices> &into) {
  uint32_t carried = 0;
  for (uint32_t index = 0; index < voices.size(); ++index) {
    if (keep[index]) into[carried++] = voices[index];
  }
}

// Whether two zones are the same zone of a sampler, edited or not: a zone is named
// by what it answers to (its keys, velocities and round-robin place), never by its
// asset, tuning, gain, pan or ranges, which are what an edit changes.
bool same_sample_zone(const daw_audio_sample_zone &left, const daw_audio_sample_zone &right) {
  return left.key_low == right.key_low && left.key_high == right.key_high
    && left.velocity_low == right.velocity_low && left.velocity_high == right.velocity_high
    && left.round_robin_group == right.round_robin_group && left.round_robin_index == right.round_robin_index;
}

// Seeds the instrument that replaces another at publish: the replacement keeps its
// own configuration and takes over what the old one was playing, so a held note goes
// on at the phase it had and the edit applies to it at once (render reads every
// configured value per frame). It also takes over the continuous values the old one
// had applied (a zone's only while it is the same zone), so a drag already under way
// goes on from where it was and the edited targets slew from there. Callback side of publish, floats and integers only,
// into a slot nothing has rendered yet. Both slots then render the same voices
// across the 5 ms crossfade, whose weights sum to one, so the seam has no level bump.
//
// What carries, and why:
//
//  Synth (voices[], sustain, expression, next_age)
//   voices        carried whole: note, note_id, velocity, references, held and released,
//                 envelope levels and stages, oscillator, LFO and noise phase, filter
//                 history. All of it is signal state; every setting (waveform, filter
//                 mode, envelope times, level, pan) is read from the replacement's configuration
//                 each frame, so none is stored in a voice.
//   sustain       carried: the pedal is a held controller, not a setting. A note-off
//                 after the edit finds its voice by note_id and releases it.
//   expression    carried (controller state). next_age carried so ages stay ordered.
//   synth (live)  NOT carried: the replacement's configuration is the authority, as it is for a
//                 slot with no predecessor.
//   polyphony     lowered: the voices a full instrument would keep (not released
//                 first, then newest) carry into slots 0..capacity-1 and the rest stay
//                 in the old slot, fading with its crossfade. Raised: every voice carries.
//
//  Sampler and Drum Rack (sample_voices[], round_robin_cursors, next_age; no pedal)
//   voices        carried with their zone re-resolved in the replacement's zones by what the
//                 zone answers to (same index first). A voice whose zone is gone is not
//                 carried, nor is one a one-shot (or a swapped asset) left past the new
//                 zone's end: it stays in the old slot and ends on the crossfade.
//   zone values   end, loop, mode, crossfade, gain, pan and choke are read through the
//                 zone each frame; asset, tuning and start are re-derived by
//                 `follow_sample_zone` on the first frame, keeping the playhead (a start
//                 edit moves it by the same distance).
//   position, amp/filter/LFO state, forced release, velocity, note, note_id, age:
//                 carried (signal state and identity).
//   round_robin_cursors, next_age: carried (place in a rotation, age order).
//   sampler       NOT carried: configuration.
//
//  Granular (grains[], note ids and ages, count, next age, random state, next grain
//  frame, frozen position)
//   grains        carried (index below the replacement's max_grains): cursor, step, age, length and pan are
//                 what a grain was spawned with; window shape and the rest of the state
//                 are read from the configuration each frame. Grains past a lowered
//                 max_grains stay in the old slot and fade with it.
//   note state    carried: the held notes (ids, ages, count, next age) keep sounding and
//                 a note-off after the edit ends the right one.
//   random state, next grain frame: carried, so spawning goes on where it was.
//   frozen position: carried only while freeze is on before and after; otherwise the
//                 replacement captures it afresh.
void seed_instrument_runtime(
  const daw_audio_graph_node_descriptor &plan_node, const InstrumentNodeState &from, InstrumentNodeState &to) {
  const uint32_t capacity = plan_node.instrument.voice_capacity;
  const auto carry = [](float &applied, float before) { applied = before; };
  switch (plan_node.instrument.kind) {
    case DAW_AUDIO_INSTRUMENT_KIND_SYNTH:
      visit_synth(to.applied.synth, from.applied.synth, carry);
      to.sustain = from.sustain;
      to.expression = from.expression;
      to.next_age = from.next_age;
      carry_voices(from.voices, surviving_voices(from.voices, capacity, [](const InstrumentVoice &a, const InstrumentVoice &b) {
        return a.released != b.released ? !a.released : a.age > b.age;
      }), to.voices);
      break;
    case DAW_AUDIO_INSTRUMENT_KIND_SAMPLER:
    case DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK: {
      visit_sampler(to.applied.sampler, from.applied.sampler, carry);
      for (uint32_t zone = 0; zone < std::min(to.sampler.zone_count, from.sampler.zone_count); ++zone) {
        if (same_sample_zone(from.zones[zone], to.zones[zone])) visit_zone(to.applied.zones[zone], from.applied.zones[zone], carry);
      }
      to.round_robin_cursors = from.round_robin_cursors;
      to.next_age = from.next_age;
      std::array<SampleVoice, kMaximumInstrumentVoices> voices = from.sample_voices;
      for (SampleVoice &voice : voices) {
        if (!voice.active) continue;
        const daw_audio_sample_zone &before = from.zones[voice.zone];
        uint32_t zone = voice.zone;
        if (zone >= to.sampler.zone_count || !same_sample_zone(before, to.zones[zone])) {
          for (zone = 0; zone < to.sampler.zone_count && !same_sample_zone(before, to.zones[zone]); ++zone) {}
        }
        const bool found = zone < to.sampler.zone_count;
        const daw_audio_sample_zone &after = found ? to.zones[zone] : before;
        const double shifted = voice.position + static_cast<double>(after.start_frame) - static_cast<double>(voice.start_frame);
        const bool past_end = shifted >= static_cast<double>(after.end_frame)
          && (after.playback_mode == DAW_AUDIO_SAMPLE_PLAYBACK_ONE_SHOT || after.asset != voice.asset);
        voice.zone = zone;
        voice.active = found && !past_end;
      }
      carry_voices(voices, surviving_voices(voices, capacity, [](const SampleVoice &a, const SampleVoice &b) {
        return a.age > b.age;
      }), to.sample_voices);
      break;
    }
    case DAW_AUDIO_INSTRUMENT_KIND_GRANULAR: {
      visit_granular(to.applied.granular, from.applied.granular, carry);
      for (uint32_t index = 0; index < to.granular.max_grains; ++index) to.grains[index] = from.grains[index];
      to.granular_note_ids = from.granular_note_ids;
      to.granular_note_ages = from.granular_note_ages;
      to.granular_note_count = from.granular_note_count;
      to.granular_next_note_age = from.granular_next_note_age;
      to.granular_random_state = from.granular_random_state;
      to.granular_next_frame = from.granular_next_frame;
      if (from.granular.freeze != 0 && to.granular.freeze != 0) to.granular_frozen_position = from.granular_frozen_position;
      break;
    }
    default:
      break;
  }
}

// Callback side of publish, floats and integers it owns only. Every node starts or
// carries its dip (a deleted node's ghost too: its stages are ghosts now, and it
// keeps the order its output was fading through). A replaced instrument's
// predecessor stays active beside it (publish does not retire it): the node starts
// its fade-in against it, and takes over the predecessor's layout folds and dip so
// neither starts from nothing. `replaced` is the plan being left, whose slots are
// still active here and whose generation proves each is the one the plan was
// prepared against.
void begin_node_dips(Core &core, const GraphRevision &replaced, GraphRevision &plan) {
  for (uint32_t node = 0; node < plan.node_count; ++node) {
    const uint32_t slot = plan.node_slots[node];
    if (plan.node_replaces[node] != 0 && plan.node_replaces[node] <= replaced.node_count) {
      const uint32_t old_index = plan.node_replaces[node] - 1u;
      const uint32_t old_slot = replaced.node_slots[old_index];
      if (runtime_slot_renderable(core, core.node_slots[old_slot], replaced.node_generations[old_index])) {
        core.node_dips[slot] = core.node_dips[old_slot];
        core.node_folds[slot] = core.node_folds[old_slot];
        Core::NodeBlend &blend = core.node_blends[slot];
        blend.partner = static_cast<uint16_t>(old_slot + 1u);
        blend.partner_generation = replaced.node_generations[old_index];
        blend.elapsed = 0;
        blend.descriptor = replaced.nodes[old_index].instrument;
        blend.depth.store(core.node_blends[old_slot].depth.load(std::memory_order_acquire) + 1u, std::memory_order_release);
        if (replaced.nodes[old_index].instrument.kind == plan.nodes[node].instrument.kind) {
          seed_instrument_runtime(plan.nodes[node], core.instrument_runtime[old_slot], core.instrument_runtime[slot]);
        }
      }
    }
    const int32_t previous = graph_node_index(replaced, plan.nodes[node].id);
    if (previous >= 0) carry_node_dip(core, replaced, plan, node, static_cast<uint32_t>(previous), plan.node_reordered[node]);
  }
  for (uint32_t ghost = plan.node_count; ghost < plan.total_node_count(); ++ghost) {
    for (uint32_t old = 0; old < replaced.total_node_count(); ++old) {
      if (replaced.node_slots[old] == plan.node_slots[ghost]) carry_node_dip(core, replaced, plan, ghost, old, false);
    }
  }
}

// Callback side of publish. A kept instrument whose configuration changed (only in
// its continuous values, or it would have been replaced) takes the edited one as its
// targets: its voices go on and the values it applies slew there. An unchanged one
// keeps what a live event set.
void begin_instrument_edits(Core &core, const GraphRevision &replaced, const GraphRevision &plan) {
  for (uint32_t node = 0; node < plan.node_count; ++node) {
    if (plan.nodes[node].kind != DAW_AUDIO_GRAPH_NODE_INSTRUMENT) continue;
    const int32_t previous = graph_node_index(replaced, plan.nodes[node].id);
    if (previous < 0 || replaced.node_slots[static_cast<uint32_t>(previous)] != plan.node_slots[node]) continue;
    const InstrumentConfiguration &before = (*core.published_instrument_configs)[static_cast<uint32_t>(previous)];
    const InstrumentConfiguration &after = (*core.prepared_instrument_configs)[node];
    const bool same = std::memcmp(&before.synth, &after.synth, sizeof(after.synth)) == 0
      && std::memcmp(&before.sampler, &after.sampler, sizeof(after.sampler)) == 0
      && same_zones(before, after) && same_granular(before.granular, after.granular);
    if (!same) set_instrument_targets(core.instrument_runtime[plan.node_slots[node]], after);
  }
}

// Callback side of publish, beside the dips. Every retained node drops what it
// latched: the committed descriptor wins until the schedule sets a value again.
// When that or the descriptor changes what the node applies, its gains move there
// from the ones it applied last over the plan's fade, as its layout folds do.
void begin_mixer_ramps(Core &core, const GraphRevision &replaced, const GraphRevision &plan) {
  for (uint32_t node = 0; node < plan.node_count; ++node) {
    const int32_t previous = graph_node_index(replaced, plan.nodes[node].id);
    const uint32_t slot = plan.node_slots[node];
    if (previous < 0 || replaced.node_slots[static_cast<uint32_t>(previous)] != slot) continue;
    const daw_audio_mixer_state &before = replaced.nodes[static_cast<uint32_t>(previous)].mixer;
    const daw_audio_mixer_state &after = plan.nodes[node].mixer;
    Core::MixerLatch &latch = core.mixer_latches[slot];
    Core::MixerRamp &ramp = core.mixer_ramps[slot];
    const bool changed = latch.mask != 0 || before.instance_id != after.instance_id || before.gain != after.gain
      || before.pan != after.pan || before.muted != after.muted || before.soloed != after.soloed;
    if (ramp.seen && changed) {
      ramp.from = ramp.applied;
      ramp.elapsed = 0;
      ramp.frames = plan.fade_frames;
    }
    latch.mask = 0;
  }
}

// Callback side of publish, beside the fader ramps. An edge that carries on one of
// the plan being left keeps its move; once that edge has sounded, a gain the plan
// changes is reached from the one it applied last over the plan's fade, as a kept
// fader's is. A route the plan adds still enters against its join, and a dropped
// one still fades out as its ghost.
void begin_edge_ramps(Core &core, const GraphRevision &replaced, const GraphRevision &plan) {
  const auto &applied = core.edge_ramps[core.edge_ramp_bank];
  auto &ramps = core.edge_ramps[core.edge_ramp_bank ^ 1u];
  for (uint32_t edge = 0; edge < plan.total_edge_count(); ++edge) {
    ramps[edge] = {};
    if (plan.edge_previous[edge] == 0) continue;
    const uint32_t previous = plan.edge_previous[edge] - 1u;
    const Core::EdgeRamp &before = applied[previous];
    const float gain = replaced.edges[previous].gain;
    ramps[edge] = before;
    if (before.seen && gain != plan.edges[edge].gain) {
      ramps[edge] = {.from = edge_ramp_gain(before, gain, before.elapsed), .frames = plan.fade_frames, .seen = true};
    }
  }
  core.edge_ramp_bank ^= 1u;
}
}  // namespace

namespace daw::audio_core_internal {

// Prepares the runtime of the plan just copied into the prepared slot: instrument
// configuration, the topology verdict, deletion ghosts, and slot ownership. All of
// it happens off the callback; on failure nothing the callback uses has changed.
daw_audio_core_result prepare_runtime_ownership(Core &core) {
  GraphRevision &next = *core.prepared_graph;
  const GraphRevision &current = *core.published_graph;
  const bool has_current = current.revision != 0 && core.published_revision != 0;
  core.prepared_instrument_previous_nodes.fill(-1);
  for (uint32_t index = 0; index < next.node_count; ++index) {
    auto &configuration = (*core.prepared_instrument_configs)[index];
    configuration = {};
    const int32_t previous = has_current ? graph_node_index(current, next.nodes[index].id) : -1;
    if (previous >= 0) {
      const auto &current_node = current.nodes[static_cast<uint32_t>(previous)];
      if (current_node.kind == next.nodes[index].kind
        && current_node.instrument.kind == next.nodes[index].instrument.kind) {
        core.prepared_instrument_previous_nodes[index] = previous;
        configuration = (*core.published_instrument_configs)[static_cast<uint32_t>(previous)];
      }
    }
    if (next.nodes[index].kind == DAW_AUDIO_GRAPH_NODE_INSTRUMENT
      && next.nodes[index].instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_SYNTH
      && configuration.synth.version == 0) configuration.synth = default_synth_state();
  }
  next.fade_frames = deletion_fade_frames(core.config.sample_rate_hz);
  PrepareScope continuity_scope(core, "continuity");
  const auto processors = has_current ? build_processor_continuity_map(current, next) : ProcessorContinuityMap{};
  continuity_scope.Finish();
  core.prepared_continuity = ContinuityPreparationResult::kAccepted;
  next.node_reordered.fill(false);
  next.processor_remap.fill(-1);
  next.node_replaces.fill(0);
  next.edge_previous.fill(0);
  if (has_current) {
    const daw_audio_core_result ghosts = append_deletion_ghosts(core, current, next, processors);
    if (ghosts != DAW_AUDIO_CORE_OK) return ghosts;
  }
  build_graph_ranges(next);
  for (uint32_t index = 0; index < next.processor_count; ++index) {
    auto &processor = next.processors[index];
    // Each processor keeps its slot unless its own structure changed; a latency
    // change starts every processor from fresh slots. Fresh slots are initialized
    // here rather than reset by publish.
    const int32_t previous = has_current && core.prepared_continuity == ContinuityPreparationResult::kAccepted
      ? processors.previous[index] : -1;
    if (previous >= 0 && compatible_processor_history(current.processors[static_cast<uint32_t>(previous)], processor)) {
      const auto &kept = current.processors[static_cast<uint32_t>(previous)];
      processor.history_slot = kept.history_slot;
      processor.delay_slot = kept.delay_slot;
      processor.reverb_slot = kept.reverb_slot;
      processor.limiter_slot = kept.limiter_slot;
      processor.compressor_slot = kept.compressor_slot;
      processor.spectral_slot = kept.spectral_slot;
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
      processor.spectral_compensation = core.transport_running.load(std::memory_order_acquire)
        && core.latency_shrunk_revision.load(std::memory_order_acquire) != current.revision
          ? kept.spectral_compensation : 0u;
#endif
      processor.generation = kept.generation;
      if (kept.spectral_predecessor >= 0
        && core.processor_slots[current.spectral_predecessors[kept.spectral_predecessor].history_slot].state.load(std::memory_order_acquire) == kSlotActive
        && core.processor_slots[current.spectral_predecessors[kept.spectral_predecessor].history_slot].generation.load(std::memory_order_relaxed)
          == current.spectral_predecessors[kept.spectral_predecessor].generation) {
        if (next.spectral_predecessor_count == kMaximumSpectralProcessors) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
        processor.spectral_predecessor = static_cast<int32_t>(next.spectral_predecessor_count++);
        next.spectral_predecessors[processor.spectral_predecessor] = current.spectral_predecessors[kept.spectral_predecessor];
      }
      continue;
    }
    const int32_t slot = acquire_runtime_slot(core.processor_slots);
    if (slot < 0) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    core.prepared_runtime_held = true;
    processor.history_slot = static_cast<uint32_t>(slot);
    processor.generation = core.processor_slots[slot].generation.load(std::memory_order_relaxed);
    if (processor.kind == DAW_AUDIO_PROCESSOR_KIND_DELAY) {
      const int32_t owned = acquire_history_owner(core.delay_slot_owners, processor.history_slot);
      if (owned < 0) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
      processor.delay_slot = static_cast<uint32_t>(owned);
      std::destroy_at(&core.delay_histories[owned]);
      std::construct_at(&core.delay_histories[owned]);
    } else if (processor.kind == DAW_AUDIO_PROCESSOR_KIND_REVERB) {
      const int32_t owned = acquire_history_owner(core.reverb_slot_owners, processor.history_slot);
      if (owned < 0) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
      processor.reverb_slot = static_cast<uint32_t>(owned);
      std::destroy_at(&core.reverb_histories[owned]);
      std::construct_at(&core.reverb_histories[owned]);
    } else if (processor.kind == DAW_AUDIO_PROCESSOR_KIND_LIMITER) {
      const int32_t owned = acquire_history_owner(core.limiter_slot_owners, processor.history_slot);
      if (owned < 0) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
      processor.limiter_slot = static_cast<uint32_t>(owned);
      std::destroy_at(&core.limiter_histories[owned]);
      std::construct_at(&core.limiter_histories[owned]);
    } else if (processor.kind == DAW_AUDIO_PROCESSOR_KIND_COMPRESSOR) {
      const int32_t owned = acquire_history_owner(core.compressor_slot_owners, processor.history_slot);
      if (owned < 0) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
      processor.compressor_slot = static_cast<uint32_t>(owned);
      std::destroy_at(&core.compressor_histories[owned]);
      std::construct_at(&core.compressor_histories[owned]);
    } else if (processor.kind == DAW_AUDIO_PROCESSOR_KIND_SPECTRAL) {
      PrepareScope setup_scope(core, "spectral-setup");
      const int32_t owned = acquire_history_owner(core.spectral_slot_owners, processor.history_slot);
      if (owned < 0) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
      processor.spectral_slot = static_cast<uint32_t>(owned);
      {
        PrepareScope reset_scope(core, "spectral-reset");
        std::destroy_at(&core.spectral_histories[owned]);
        std::construct_at(&core.spectral_histories[owned]);
        reset_spectral_history(core.spectral_histories[owned], processor.spectral);
        std::destroy_at(&core.spectral_inputs[owned]);
        std::construct_at(&core.spectral_inputs[owned]);
        core.spectral_inputs[owned].initialize_samples();
      }
      if (previous >= 0 && current.processors[previous].kind == DAW_AUDIO_PROCESSOR_KIND_SPECTRAL) {
        const auto replaced = prepare_spectral_replacement(core, current, next, processor, static_cast<uint32_t>(previous),
          static_cast<uint32_t>(owned));
        if (replaced != DAW_AUDIO_CORE_OK) return replaced;
      }
    }
    seed_bypass(core, processor, has_current && previous < 0 && graph_node_index(current, processor.node_id) >= 0);
    if (previous >= 0 && current.processors[static_cast<uint32_t>(previous)].kind == processor.kind) {
      processor.bypass_source = previous;
    }
  }
  for (uint32_t index = next.processor_count; index < next.total_processor_count(); ++index) {
    auto &ghost = next.processors[index];
    if (ghost.spectral_predecessor < 0) continue;
    const auto &predecessor = current.spectral_predecessors[ghost.spectral_predecessor];
    if (next.spectral_predecessor_count == kMaximumSpectralProcessors) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    ghost.spectral_predecessor = static_cast<int32_t>(next.spectral_predecessor_count++);
    next.spectral_predecessors[ghost.spectral_predecessor] = predecessor;
  }
  for (uint32_t index = 0; index < next.node_count; ++index) {
    if (!assign_prepared_node(core, index)) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
  if (has_current && core.prepared_continuity == ContinuityPreparationResult::kAccepted
    && !mark_reordered_nodes(core, current, next, processors)) {
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
  collect_released_slots(core);
  return DAW_AUDIO_CORE_OK;
}
}  // namespace daw::audio_core_internal

namespace {

// Callback side of publish, integers only: every slot the plan names must still be
// prepared or active at the generation the plan recorded.
bool prepared_runtime_current(const Core &core, const GraphRevision &plan) {
  const auto current = [](const RuntimeSlot &slot, uint32_t generation) {
    const uint32_t state = slot.state.load(std::memory_order_acquire);
    return (state == kSlotPrepared || state == kSlotActive)
      && slot.generation.load(std::memory_order_relaxed) == generation;
  };
  // Ghosts are exempt: one may finish fading between prepare and publish, and
  // then simply does not render.
  for (uint32_t index = 0; index < plan.processor_count; ++index) {
    if (!current(core.processor_slots[plan.processors[index].history_slot], plan.processors[index].generation)) return false;
  }
  for (uint32_t index = 0; index < plan.node_count; ++index) {
    if (!current(core.node_slots[plan.node_slots[index]], plan.node_generations[index])) return false;
  }
  return true;
}

void activate_prepared_runtime(Core &core, const GraphRevision &plan) {
  const auto activate = [](RuntimeSlot &slot) {
    uint32_t expected = kSlotPrepared;
    slot.state.compare_exchange_strong(expected, kSlotActive, std::memory_order_release, std::memory_order_relaxed);
  };
  for (uint32_t index = 0; index < plan.processor_count; ++index) activate(core.processor_slots[plan.processors[index].history_slot]);
  for (uint32_t index = 0; index < plan.total_node_count(); ++index) activate(core.node_slots[plan.node_slots[index]]);
  const auto retire = [&core](RuntimeSlot &slot, uint32_t generation) {
    if (slot.state.load(std::memory_order_relaxed) == kSlotActive
      && slot.generation.load(std::memory_order_relaxed) == generation) retire_runtime_slot(core, slot);
  };
  for (uint32_t index = 0; index < plan.released_processor_count; ++index) {
    retire(core.processor_slots[plan.released_processors[index].index], plan.released_processors[index].generation);
  }
  for (uint32_t index = 0; index < plan.released_node_count; ++index) {
    retire(core.node_slots[plan.released_nodes[index].index], plan.released_nodes[index].generation);
  }
}
}  // namespace


extern "C" daw_audio_core_result daw_audio_core_publish(
  daw_audio_core_handle core_handle,
  uint32_t expected_revision) {
  Core *core = to_core(core_handle);
  if (core == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (expected_revision == 0) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (core->prepared_revision != expected_revision) return DAW_AUDIO_CORE_STALE_REVISION;
  if (core->latency_move_revision.load(std::memory_order_acquire)
    > core->latency_completed_revision.load(std::memory_order_acquire))
    return DAW_AUDIO_CORE_LATENCY_MOVE_PENDING;
  if ((*core->prepared_graph).revision == expected_revision) {
    if (!prepared_runtime_current(*core, *core->prepared_graph)) {
      core->stale_references.fetch_add(1, std::memory_order_relaxed);
      return DAW_AUDIO_CORE_STALE_REVISION;
    }
    hand_off_bypass(*core, *core->published_graph, *core->prepared_graph);
    begin_node_dips(*core, *core->published_graph, *core->prepared_graph);
    begin_instrument_edits(*core, *core->published_graph, *core->prepared_graph);
    begin_mixer_ramps(*core, *core->published_graph, *core->prepared_graph);
    begin_edge_ramps(*core, *core->published_graph, *core->prepared_graph);
    activate_prepared_runtime(*core, *core->prepared_graph);
    for (uint32_t index = 0; index < core->prepared_graph->processor_count; ++index) {
      const auto &processor = core->prepared_graph->processors[index];
      if (processor.spectral_predecessor < 0) continue;
      auto &history = core->spectral_histories[processor.spectral_slot];
      history.replacement.freeze_source_deadline = core->graph_write_frame + 2u * processor.spectral.fft_size
        + processor.spectral_compensation + 2u * core->prepared_graph->fade_frames
        + core->config.max_frames_per_block;
      history.replacement.freeze_source_latched = false;
      history.replacement.freeze_changed_after_latch = false;
    }
    // This is the same block-boundary/reader-epoch handoff as runtime slots.
    // Delayed ghosts keep their reserved histories; only fresh live owners reset.
    for (uint32_t node = 0; node < core->prepared_graph->node_count; ++node) {
      for (uint32_t tap = 0; tap < kGraphStageCount; ++tap) {
        if (!core->prepared_graph->reset_tap_histories[node][tap]) continue;
        auto &history = core->graph_tap_histories[core->prepared_graph->tap_history_slots[node][tap]];
        history.first_frame = core->graph_write_frame;
        history.end_frame = core->graph_write_frame;
      }
    }
    core->prepared_runtime_held = false;
    core->latency_publication_shift = core->graph_write_frame - core->prepared_graph->latency_origin;
    const bool running = core->transport_running.load(std::memory_order_acquire);
    core->latency_shrunk_revision = running ? 0u : expected_revision;
    core->latency_budget.store(running ? core->prepared_graph->latency_budget
      : core->prepared_graph->minimum_latency, std::memory_order_release);
    core->latency_move_revision.store(expected_revision, std::memory_order_release);
    if (!running || (core->prepared_graph->latency_end == core->prepared_graph->latency_origin
      && core->prepared_graph->spectral_predecessor_count == 0))
      core->latency_completed_revision.store(expected_revision, std::memory_order_release);
    std::swap(core->published_graph, core->prepared_graph);
    std::swap(core->published_instrument_configs, core->prepared_instrument_configs);
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
    std::swap(core->published_native_hooks, core->prepared_native_hooks);
#endif
  }
  core->published_revision = expected_revision;
  core->prepared_revision = 0;
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_cancel_prepared_graph(
  daw_audio_core_handle core_handle,
  uint32_t expected_revision) {
  Core *core = to_core(core_handle);
  if (core == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (expected_revision == 0 || core->prepared_revision != expected_revision) {
    return DAW_AUDIO_CORE_STALE_REVISION;
  }
  release_prepared_runtime(*core);
  core->prepared_revision = 0;
  core->prepared_continuity = ContinuityPreparationResult::kAccepted;
  return DAW_AUDIO_CORE_OK;
}

extern "C" uint32_t daw_audio_core_prepared_graph_continuity(
  daw_audio_core_handle core_handle) {
  Core *core = to_core(core_handle);
  return core != nullptr && core->prepared_continuity == ContinuityPreparationResult::kAccepted ? 1U : 0U;
}

extern "C" uint32_t daw_audio_core_reclaim_retired_runtime(daw_audio_core_handle core_handle) {
  Core *core = to_core(core_handle);
  if (core == nullptr) return 0;
  const uint32_t before = core->reclaimed_slots;
  reclaim_retired_slots(*core);
  return core->reclaimed_slots - before;
}
