#include "audio_core_internal.h"

namespace daw::audio_core_internal {

bool valid_sample_source_event(const daw_audio_sample_source_event &event) {
  return valid_abi(event.abi_version)
    && event.epoch != 0
    && event.sequence != 0
    && event.asset != 0
    && event.stop_frame > event.start_frame
    && event.source_frame_count > 0
    && std::isfinite(event.gain)
    && std::isfinite(event.source_offset_fraction)
    && event.source_offset_fraction >= 0.0F
    && event.source_offset_fraction < 1.0F
    && event.fade_in_start_frame <= event.fade_in_end_frame
    && event.fade_out_start_frame <= event.fade_out_end_frame
    && std::isfinite(event.fade_in_curve)
    && event.fade_in_curve >= -1.0F && event.fade_in_curve <= 1.0F
    && std::isfinite(event.fade_in_curve_position)
    && event.fade_in_curve_position >= 0.0F && event.fade_in_curve_position <= 1.0F
    && std::isfinite(event.fade_out_curve)
    && event.fade_out_curve >= -1.0F && event.fade_out_curve <= 1.0F
    && std::isfinite(event.fade_out_curve_position)
    && event.fade_out_curve_position >= 0.0F && event.fade_out_curve_position <= 1.0F;
}
}  // namespace daw::audio_core_internal

namespace {

float linear_fade_gain(int64_t frame, int64_t start, int64_t end, float before, float after) {
  if (end <= start) return frame < end ? before : after;
  if (frame <= start) return before;
  if (frame >= end) return after;
  const double normalized = (static_cast<double>(frame) - static_cast<double>(start))
    / (static_cast<double>(end) - static_cast<double>(start));
  return before + (after - before) * static_cast<float>(normalized);
}

float curved_fade_gain(
  int64_t frame,
  int64_t start,
  int64_t end,
  float before,
  float after,
  float curve,
  float position) {
  if (end <= start) return frame < end ? before : after;
  if (frame <= start) return before;
  if (frame >= end) return after;
  if (curve == 0.0F) {
    return linear_fade_gain(frame, start, end, before, after);
  }
  const double u = (static_cast<double>(frame) - static_cast<double>(start))
    / (static_cast<double>(end) - static_cast<double>(start));
  const double p = static_cast<double>(position);
  const double c = static_cast<double>(curve);
  const double linear_gain = static_cast<double>(before) + (static_cast<double>(after) - static_cast<double>(before)) * p;
  const double control_gain = c >= 0.0
    ? linear_gain + (1.0 - linear_gain) * c
    : linear_gain + linear_gain * c;
  const double discriminant = std::max(0.0, p * p + (1.0 - 2.0 * p) * u);
  const double denominator = p + std::sqrt(discriminant);
  double t = denominator > 0.0 ? u / denominator : 0.0;
  t = std::min(1.0, std::max(0.0, t));
  const double inverse = 1.0 - t;
  const double gain = inverse * inverse * static_cast<double>(before)
    + 2.0 * inverse * t * control_gain
    + t * t * static_cast<double>(after);
  return static_cast<float>(std::min(1.0, std::max(0.0, gain)));
}

float source_envelope_gain(const SampleSource &source, int64_t transport_frame, int64_t envelope_frame) {
  const float fade_in = curved_fade_gain(
    envelope_frame, source.fade_in_start_frame, source.fade_in_end_frame, 0.0F, 1.0F,
    source.fade_in_curve, source.fade_in_curve_position);
  const float fade_out = curved_fade_gain(
    envelope_frame, source.fade_out_start_frame, source.fade_out_end_frame, 1.0F, 0.0F,
    source.fade_out_curve, source.fade_out_curve_position);
  const float termination = source.termination_end == 0 ? 1.F
    : transport_frame >= source.termination_end ? 0.F
    : 1.F - static_cast<float>(transport_frame - source.termination_start)
      / static_cast<float>(source.termination_end - source.termination_start);
  const float entry = source.entry_end == 0 ? 1.F
    : std::min(1.F, static_cast<float>(transport_frame - source.entry_start)
      / static_cast<float>(source.entry_end - source.entry_start));
  return source.gain * fade_in * fade_out * termination * entry;
}

float paged_asset_frame_sample(
  const Core &core,
  const PagedPreparation &preparation,
  uint64_t frame,
  uint32_t channel) {
  const uint64_t page_index = frame / core.paged_config.page_frames;
  if (page_index < preparation.first_page
    || page_index - preparation.first_page >= preparation.page_count) return 0.0F;
  const uint32_t position = static_cast<uint32_t>(page_index - preparation.first_page);
  const uint32_t slot_index = preparation.page_slots[position];
  const PagedPageSlot &page = core.paged_slots[slot_index];
  if (page.owner.load(std::memory_order_acquire) != preparation.asset) return 0.0F;
  const uint32_t page_frame = static_cast<uint32_t>(frame % core.paged_config.page_frames);
  if (page_frame >= page.valid_frames) return 0.0F;
  return paged_storage_plane(core, slot_index, channel)[page_frame];
}
}  // namespace

namespace daw::audio_core_internal {

float asset_sample(
  const Core &core,
  const AssetSlot &asset,
  const PagedPreparation *preparation,
  double position,
  uint32_t channel) {
  const double bounded = std::fmax(0.0, std::fmin(position, static_cast<double>(asset.frame_count - 1)));
  const uint64_t frame = static_cast<uint64_t>(bounded);
  const uint64_t next = frame + 1 < asset.frame_count ? frame + 1 : frame;
  const float fraction = static_cast<float>(bounded - static_cast<double>(frame));
  const float first = preparation == nullptr
    ? asset.planes[channel][frame]
    : paged_asset_frame_sample(core, *preparation, frame, channel);
  if (fraction == 0.0F) return std::isfinite(first) ? first : 0.0F;
  const float second = preparation == nullptr
    ? asset.planes[channel][next]
    : paged_asset_frame_sample(core, *preparation, next, channel);
  const float value = first + (second - first) * fraction;
  return std::isfinite(value) ? value : 0.0F;
}
}  // namespace daw::audio_core_internal

namespace {

bool sample_source_node_alive(const Core &core, const SampleSource &source) {
  if (source.node_runtime_generation == 0) return true;
  const auto &slot = core.node_slots[source.node_runtime_slot];
  return slot.state.load(std::memory_order_acquire) == kSlotActive
    && slot.generation.load(std::memory_order_relaxed) == source.node_runtime_generation;
}
}  // namespace

namespace daw::audio_core_internal {
// DAW_REALTIME_CALLBACK_HELPER_END sample-source-node-ownership

SampleSource make_sample_source(const daw_audio_sample_source_event &event) {
  return {
    .source_node_id = event.source_node_id,
    .asset = event.asset,
    .start_frame = event.start_frame,
    .stop_frame = event.stop_frame,
    .source_offset_frame = event.source_offset_frame,
    .source_offset_fraction = event.source_offset_fraction,
    .source_frame_count = event.source_frame_count,
    .gain = event.gain,
    .fade_in_start_frame = event.fade_in_start_frame,
    .fade_in_end_frame = event.fade_in_end_frame,
    .fade_out_start_frame = event.fade_out_start_frame,
    .fade_out_end_frame = event.fade_out_end_frame,
    .fade_in_curve = event.fade_in_curve,
    .fade_in_curve_position = event.fade_in_curve_position,
    .fade_out_curve = event.fade_out_curve,
    .fade_out_curve_position = event.fade_out_curve_position,
    .active = true,
  };
}

bool plan_sample_source_reconciliation(Core &core, std::span<const SampleSource> next, int64_t frame,
  SourceReconciliationPlan &plan) {
  plan.duration = std::max<int64_t>(1,
    static_cast<int64_t>(core.config.sample_rate_hz * kSampleTerminationFadeMilliseconds / 1000.F));
  if (frame < 0 || frame > INT64_MAX - plan.duration || next.size() > kMaximumSampleSources) return false;
  auto &matches = plan.matches;
  auto &retained = plan.retained;
  auto &fading_nodes = plan.fading_nodes;
  auto &fading_count = plan.fading_count;
  const auto signature = [](const SampleSource &source) {
    // The running cursor retains its accepted wire origin. Projected f32
    // positions can collide for distinct origins, so never use them as identity.
    return std::make_tuple(source.source_node_id, source.node_runtime_slot, source.node_runtime_generation,
      source.asset, source.paged, source.start_frame, source.source_offset_frame,
      std::bit_cast<uint32_t>(source.source_offset_fraction), source.gain,
      source.fade_in_start_frame, source.fade_in_end_frame,
      source.fade_out_start_frame, source.fade_out_end_frame,
      source.fade_in_curve, source.fade_in_curve_position,
      source.fade_out_curve, source.fade_out_curve_position);
  };
  using Signature = decltype(signature(next[0]));
  using IndexedSignature = std::pair<Signature, uint32_t>;
  std::array<IndexedSignature, kMaximumSampleSources> old_sources{}, next_sources{};
  uint32_t old_count = 0, next_count = 0;
  // Fixed storage, O(n log n) multiset matching. Equal wire origins match
  // once each, including genuinely overlapping identical clips.
  for (uint32_t slot = 0; slot < kMaximumSampleSources; ++slot) {
    const auto &source = (*core.active_sample_sources)[slot];
    if (!source.active || !sample_source_node_alive(core, source)
      || source.start_frame > frame || source.stop_frame <= frame) continue;
    if (find_asset(&core, source.asset) == nullptr) continue;
    old_sources[old_count++] = {signature(source), slot};
  }
  for (uint32_t index = 0; index < next.size(); ++index) {
    matches[index] = -1;
    if (next[index].start_frame <= frame && next[index].stop_frame > frame) {
      next_sources[next_count++] = {signature(next[index]), index};
    }
  }
  std::sort(old_sources.begin(), old_sources.begin() + old_count);
  std::sort(next_sources.begin(), next_sources.begin() + next_count);
  uint32_t previous = 0, following = 0;
  while (previous < old_count && following < next_count) {
    if (old_sources[previous].first < next_sources[following].first) { ++previous; continue; }
    if (next_sources[following].first < old_sources[previous].first) { ++following; continue; }
    const auto slot = old_sources[previous++].second;
    matches[next_sources[following++].second] = static_cast<int32_t>(slot);
    retained[slot] = true;
  }
  uint32_t tails = 0, available = 0;
  for (uint32_t slot = 0; slot < kSampleSourceSlots; ++slot) {
    const auto &source = (*core.active_sample_sources)[slot];
    const bool audible = source.active && sample_source_node_alive(core, source) && source.start_frame <= frame
      && (source.termination_end == 0 ? source.stop_frame > frame : source.termination_end > frame);
    if (slot < kMaximumSampleSources) {
      if (audible && !retained[slot]) {
        ++tails;
        fading_nodes[fading_count++] = {source.node_runtime_slot, source.node_runtime_generation};
      }
    } else if (audible) fading_nodes[fading_count++] = {source.node_runtime_slot, source.node_runtime_generation};
    else ++available;
  }
  return tails <= available;
}

void apply_sample_source_reconciliation(Core &core, std::span<const SampleSource> next, int64_t frame,
  SourceReconciliationPlan &plan) {
  const auto duration = plan.duration;
  const auto &matches = plan.matches;
  const auto &retained = plan.retained;
  auto &fading_nodes = plan.fading_nodes;
  const auto fading_count = plan.fading_count;
  using NodeOwner = SourceReconciliationPlan::NodeOwner;
  std::sort(fading_nodes.begin(), fading_nodes.begin() + fading_count);
  uint32_t tail_slot = kMaximumSampleSources;
  for (uint32_t slot = 0; slot < kMaximumSampleSources; ++slot) {
    auto &source = (*core.active_sample_sources)[slot];
    if (retained[slot]) continue;
    if (source.active && sample_source_node_alive(core, source)
      && source.start_frame <= frame && source.stop_frame > frame) {
      while (tail_slot < kSampleSourceSlots) {
        const auto &tail = (*core.active_sample_sources)[tail_slot];
        if (!tail.active || !sample_source_node_alive(core, tail) || tail.termination_end <= frame) break;
        ++tail_slot;
      }
      auto &tail = (*core.active_sample_sources)[tail_slot++];
      tail = source;
      tail.termination_start = frame;
      tail.termination_end = frame + duration;
      tail.termination_read_frame = source.stop_frame - 1;
      const auto *asset = find_asset(&core, source.asset);
      if (asset != nullptr) {
        // Hold the last readable sample if the old region ends during the
        // declick. Compute once at the seam, never ceil/divide per tail sample.
        const double rate = static_cast<double>(asset->sample_rate_hz) / core.config.sample_rate_hz;
        const double read_count = source.reconciled_read_end == 0.0
          ? static_cast<double>(source.source_frame_count)
          : source.reconciled_read_end - (static_cast<double>(source.source_offset_frame)
            + static_cast<double>(source.source_offset_fraction));
        const double last = std::max(0.0, std::ceil(std::min(read_count,
          static_cast<double>(asset->frame_count - source.source_offset_frame)
            - source.source_offset_fraction) / rate) - 1.0);
        tail.termination_read_frame = source.start_frame + static_cast<int64_t>(std::min(last,
          static_cast<double>(source.stop_frame - source.start_frame - 1)));
      }
    }
    source.active = false;
  }
  uint32_t free_slot = 0;
  for (uint32_t index = 0; index < next.size(); ++index) {
    const auto &declared = next[index];
    if (declared.stop_frame <= frame) continue;
    if (matches[index] >= 0) {
      auto &source = (*core.active_sample_sources)[static_cast<uint32_t>(matches[index])];
      source.stop_frame = declared.stop_frame;
      source.paged_preparation = declared.paged_preparation;
      source.reconciled_read_end = (static_cast<double>(declared.source_offset_frame)
        + static_cast<double>(declared.source_offset_fraction)) + static_cast<double>(declared.source_frame_count);
      continue;
    }
    while ((*core.active_sample_sources)[free_slot].active) ++free_slot;
    auto &source = (*core.active_sample_sources)[free_slot];
    source = declared;
    if (declared.start_frame > frame) continue;
    source.entry_start = frame;
    source.entry_end = std::binary_search(fading_nodes.begin(), fading_nodes.begin() + fading_count,
      NodeOwner{source.node_runtime_slot, source.node_runtime_generation}) ? frame + duration : 0;
  }
}
}  // namespace daw::audio_core_internal

namespace {

bool reconcile_sample_sources(Core &core, std::span<const SampleSource> next, int64_t frame) {
  SourceReconciliationPlan plan;
  if (!plan_sample_source_reconciliation(core, next, frame, plan)) return false;
  apply_sample_source_reconciliation(core, next, frame, plan);
  return true;
}
}  // namespace

namespace daw::audio_core_internal {
// DAW_REALTIME_CALLBACK_HELPER_END native-source-seam

void prepare_active_source_ranges(Core &core, const GraphRevision *graph) {
  // A deleted node's sources expire when its existing fade retires the slot.
  // This also drops owners removed without a ghost, before resource collection.
  for (auto &source : *core.active_sample_sources)
    if (source.active && !sample_source_node_alive(core, source)) source.active = false;
  core.active_source_ranges = {};
  core.root_source_range = {};
  uint16_t count = 0;
  if (graph != nullptr) {
    // A fading source keeps playing its scheduled clips until it reaches silence.
    for (uint32_t node_index = 0; node_index < graph->total_node_count(); ++node_index) {
      GraphRevision::Range &range = core.active_source_ranges[node_index];
      range.start = count;
      if (graph->nodes[node_index].kind != DAW_AUDIO_GRAPH_NODE_SOURCE) continue;
      for (uint32_t source_index = 0; source_index < core.active_sample_sources->size(); ++source_index) {
        const SampleSource &source = (*core.active_sample_sources)[source_index];
        if (source.active && source.source_node_id == graph->nodes[node_index].id
          && source.node_runtime_slot == graph->node_slots[node_index]
          && source.node_runtime_generation == graph->node_generations[node_index]) {
          core.active_source_indices[count++] = static_cast<uint16_t>(source_index);
          ++range.count;
        }
      }
    }
  }
  core.root_source_range.start = count;
  for (uint32_t source_index = 0; source_index < core.active_sample_sources->size(); ++source_index) {
    const SampleSource &source = (*core.active_sample_sources)[source_index];
    if (source.active && source.source_node_id == 0) {
      core.active_source_indices[count++] = static_cast<uint16_t>(source_index);
      ++core.root_source_range.count;
    }
  }
}

void render_sample_source_range(
  Core &core,
  GraphRevision::Range range,
  int64_t transport_frame,
  float *left_output,
  float *right_output) {
  if (core.transport.running == 0) return;
  const uint32_t end = static_cast<uint32_t>(range.start) + range.count;
  for (uint32_t position = range.start; position < end; ++position) {
    SampleSource &source = (*core.active_sample_sources)[core.active_source_indices[position]];
    if (!source.active) continue;
    if ((source.termination_end == 0 && transport_frame >= source.stop_frame)
      || (source.termination_end != 0 && transport_frame >= source.termination_end)) {
      source.active = false;
      continue;
    }
    if (transport_frame < source.start_frame) continue;
    AssetSlot *asset = find_asset(&core, source.asset);
    if (asset == nullptr) {
      source.active = false;
      continue;
    }
    const int64_t read_frame = source.termination_end == 0 ? transport_frame
      : std::min(transport_frame, source.termination_read_frame);
    const uint64_t elapsed_output_frames = static_cast<uint64_t>(read_frame - source.start_frame);
    const double source_position = static_cast<double>(source.source_offset_frame)
      + static_cast<double>(source.source_offset_fraction)
      + static_cast<double>(elapsed_output_frames) * static_cast<double>(asset->sample_rate_hz)
        / static_cast<double>(core.config.sample_rate_hz);
    const double source_end = source.reconciled_read_end != 0.0 ? source.reconciled_read_end
      : static_cast<double>(source.source_offset_frame)
      + static_cast<double>(source.source_offset_fraction)
      + static_cast<double>(source.source_frame_count);
    if (source_position >= source_end
      || source.source_offset_frame >= asset->frame_count
      || source_position < 0.0
      || source_position >= static_cast<double>(asset->frame_count)) {
      source.active = false;
      continue;
    }
    const float gain = source_envelope_gain(source, transport_frame, read_frame);
    const uint32_t right_channel = asset->channel_count > 1 ? 1 : 0;
    const float left = asset_sample(core, *asset, source.paged ? source.paged_preparation : nullptr, source_position, 0);
    const float right = asset_sample(core, *asset, source.paged ? source.paged_preparation : nullptr, source_position, right_channel);
    *left_output += left * gain;
    if (right_output != left_output) *right_output += right * gain;
  }
}
}  // namespace daw::audio_core_internal


extern "C" daw_audio_core_result daw_audio_core_schedule_sample_source(
  daw_audio_core_handle core_handle,
  const daw_audio_sample_source_event *event) {
  Core *core = to_core(core_handle);
  if (core == nullptr || event == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (!valid_abi(event->abi_version)) return DAW_AUDIO_CORE_UNSUPPORTED_VERSION;
  if (!valid_sample_source_event(*event)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (event->epoch != core->transport.epoch || event->sequence <= core->last_event_sequence) return DAW_AUDIO_CORE_STALE_REVISION;
  AssetSlot *asset = find_asset(core, event->asset);
  if (asset == nullptr
    || event->source_offset_frame >= asset->frame_count
    || event->source_frame_count > asset->frame_count - event->source_offset_frame) return DAW_AUDIO_CORE_INVALID_HANDLE;
  if ((*core->published_graph).revision == core->published_revision) {
    const int32_t node_index = graph_node_index((*core->published_graph), event->source_node_id);
    if (node_index < 0 || (*core->published_graph).nodes[static_cast<uint32_t>(node_index)].kind != DAW_AUDIO_GRAPH_NODE_SOURCE) {
      return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
  } else if (event->source_node_id != 0) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  SampleSource *target = nullptr;
  for (uint32_t index = 0; index < kMaximumSampleSources; ++index) {
    auto &source = (*core->active_sample_sources)[index];
    if (!source.active) {
      target = &source;
      break;
    }
  }
  if (target == nullptr) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  *target = make_sample_source(*event);
  bind_sample_source_node(*target, *core->published_graph);
  core->last_event_sequence = event->sequence;
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_replace_sample_sources(
  daw_audio_core_handle core_handle,
  uint32_t revision,
  uint32_t epoch,
  const daw_audio_sample_source_replacement_event *events,
  uint32_t event_count) {
  Core *core = to_core(core_handle);
  if (core == nullptr || revision == 0 || epoch == 0
    || revision != core->published_revision || epoch != core->transport.epoch
    || event_count > kMaximumSampleSources || (event_count != 0 && events == nullptr)) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  auto *staged = &inactive_sample_source_table(*core);
  for (SampleSource &source : *staged) source.active = false;
  uint64_t previous_sequence = 0;
  for (uint32_t index = 0; index < event_count; ++index) {
    const daw_audio_sample_source_replacement_event &event = events[index];
    if (event.abi_version != DAW_AUDIO_CORE_ABI_VERSION
      || event.epoch != epoch || event.sequence == 0 || event.sequence <= previous_sequence
      || event.kind > 1) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    if (event.kind == 0) {
      const daw_audio_sample_source_event ordinary{
        .abi_version = event.abi_version,
        .epoch = event.epoch,
        .sequence = event.sequence,
        .source_node_id = event.source_node_id,
        .asset = event.asset,
        .start_frame = event.start_frame,
        .stop_frame = event.stop_frame,
        .source_offset_frame = event.source_offset_frame,
        .source_frame_count = event.source_frame_count,
        .gain = event.gain,
        .fade_in_start_frame = event.fade_in_start_frame,
        .fade_in_end_frame = event.fade_in_end_frame,
        .fade_out_start_frame = event.fade_out_start_frame,
        .fade_out_end_frame = event.fade_out_end_frame,
        .source_offset_fraction = event.source_offset_fraction,
        .fade_in_curve = event.fade_in_curve,
        .fade_in_curve_position = event.fade_in_curve_position,
        .fade_out_curve = event.fade_out_curve,
        .fade_out_curve_position = event.fade_out_curve_position,
      };
      if (!valid_sample_source_event(ordinary)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
      AssetSlot *asset = find_asset(core, ordinary.asset);
      if (asset == nullptr
        || ordinary.source_offset_frame >= asset->frame_count
        || ordinary.source_frame_count > asset->frame_count - ordinary.source_offset_frame) {
        return DAW_AUDIO_CORE_INVALID_HANDLE;
      }
    } else {
      PagedPreparation *preparation = find_paged_preparation(*core, event.preparation);
      if (preparation == nullptr
        || event.stop_frame <= event.start_frame
        || event.source_frame_count == 0
        || !std::isfinite(event.gain)
        || !std::isfinite(event.source_offset_fraction)
        || event.source_offset_fraction < 0.0F || event.source_offset_fraction >= 1.0F
        || event.source_offset_frame < preparation->source_offset_frame
        || event.source_offset_frame > preparation->source_offset_frame + preparation->source_frame_count
        || event.source_frame_count > preparation->source_offset_frame + preparation->source_frame_count
          - event.source_offset_frame
        || event.fade_in_start_frame > event.fade_in_end_frame
        || event.fade_out_start_frame > event.fade_out_end_frame
        || !std::isfinite(event.fade_in_curve) || event.fade_in_curve < -1.0F || event.fade_in_curve > 1.0F
        || !std::isfinite(event.fade_in_curve_position)
        || event.fade_in_curve_position < 0.0F || event.fade_in_curve_position > 1.0F
        || !std::isfinite(event.fade_out_curve) || event.fade_out_curve < -1.0F || event.fade_out_curve > 1.0F
        || !std::isfinite(event.fade_out_curve_position)
        || event.fade_out_curve_position < 0.0F || event.fade_out_curve_position > 1.0F) {
        return preparation == nullptr ? DAW_AUDIO_CORE_INVALID_HANDLE : DAW_AUDIO_CORE_INVALID_ARGUMENT;
      }
    }
    if ((*core->published_graph).revision == core->published_revision) {
      const int32_t node_index = graph_node_index((*core->published_graph), event.source_node_id);
      if (node_index < 0
        || (*core->published_graph).nodes[static_cast<uint32_t>(node_index)].kind != DAW_AUDIO_GRAPH_NODE_SOURCE) {
        return DAW_AUDIO_CORE_INVALID_ARGUMENT;
      }
    } else if (event.source_node_id != 0) {
      return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
    PagedPreparation *preparation = event.kind == 1
      ? find_paged_preparation(*core, event.preparation) : nullptr;
    (*staged)[index] = {
      .source_node_id = event.source_node_id,
      .asset = event.kind == 0 ? event.asset : preparation->asset,
      .start_frame = event.start_frame,
      .stop_frame = event.stop_frame,
      .source_offset_frame = event.source_offset_frame,
      .source_offset_fraction = event.source_offset_fraction,
      .source_frame_count = event.source_frame_count,
      .gain = event.gain,
      .fade_in_start_frame = event.fade_in_start_frame,
      .fade_in_end_frame = event.fade_in_end_frame,
      .fade_out_start_frame = event.fade_out_start_frame,
      .fade_out_end_frame = event.fade_out_end_frame,
      .fade_in_curve = event.fade_in_curve,
      .fade_in_curve_position = event.fade_in_curve_position,
      .fade_out_curve = event.fade_out_curve,
      .fade_out_curve_position = event.fade_out_curve_position,
      .paged_preparation = preparation,
      .paged = event.kind == 1,
      .active = true,
    };
    bind_sample_source_node((*staged)[index], *core->published_graph);
    previous_sequence = event.sequence;
  }
  if (core->transport.running != 0) {
    // A running transport swaps at its own frame: sources that match keep their cursor and the rest fade over 6 ms
    // instead of cutting. A stopped one has nothing sounding, so the table is simply replaced.
    if (!reconcile_sample_sources(*core, {staged->data(), event_count}, core->transport.frame)) {
      return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    }
  } else {
    core->active_sample_sources = staged;
  }
  core->last_event_sequence = event_count == 0 ? 0 : previous_sequence;
  return DAW_AUDIO_CORE_OK;
}
