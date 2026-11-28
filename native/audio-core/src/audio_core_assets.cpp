#include "audio_core_internal.h"

namespace daw::audio_core_internal {

bool initialize_paged_storage(Core &core, const daw_audio_paged_asset_config &config) {
  if (config.abi_version != DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION
    || config.page_frames == 0
    || config.slot_count == 0
    || config.slot_count > DAW_AUDIO_CORE_MAX_PAGED_PAGE_SLOTS
    || config.max_channels == 0
    || config.max_channels > DAW_AUDIO_CORE_WASM_PAGED_MAX_CHANNELS
    || config.max_channels > core.config.max_channels) return false;
  if (core.paged_config.slot_count != 0) return false;
  const uint64_t sample_count = static_cast<uint64_t>(config.slot_count)
    * static_cast<uint64_t>(config.max_channels) * static_cast<uint64_t>(config.page_frames);
  if (sample_count > std::numeric_limits<std::size_t>::max()) return false;
  const std::size_t samples = static_cast<std::size_t>(sample_count);
  auto slots = std::unique_ptr<PagedPageSlot[]>(new (std::nothrow) PagedPageSlot[config.slot_count]);
  auto storage = std::unique_ptr<float[]>(new (std::nothrow) float[samples]);
  auto preparations = std::unique_ptr<PagedPreparation[]>(
    new (std::nothrow) PagedPreparation[DAW_AUDIO_CORE_MAX_PAGED_PREPARATIONS]);
  if (slots == nullptr || storage == nullptr || preparations == nullptr) return false;
  core.paged_config = config;
  core.paged_slots = std::move(slots);
  core.paged_storage = std::move(storage);
  core.paged_preparations = std::move(preparations);
  core.paged_access_sequence = 0;
  return true;
}
}  // namespace daw::audio_core_internal

namespace {

uint64_t paged_page_count(const Core &core, uint64_t frame_count) {
  if (frame_count == 0) return 0;
  return (frame_count - 1u) / static_cast<uint64_t>(core.paged_config.page_frames) + 1u;
}

PagedPageSlot *find_paged_page(Core &core, daw_audio_asset_handle asset, uint64_t page_index) {
  if (core.paged_slots == nullptr) return nullptr;
  for (uint32_t slot = 0; slot < core.paged_config.slot_count; ++slot) {
    PagedPageSlot &page = core.paged_slots[slot];
    if (page.owner.load(std::memory_order_acquire) == asset && page.page_index == page_index) return &page;
  }
  return nullptr;
}

uint32_t select_paged_page_slot(Core &core, daw_audio_asset_handle asset, uint64_t page_index) {
  uint32_t free_slot = core.paged_config.slot_count;
  uint32_t lru_slot = core.paged_config.slot_count;
  uint64_t lru_sequence = UINT64_MAX;
  for (uint32_t slot = 0; slot < core.paged_config.slot_count; ++slot) {
    PagedPageSlot &page = core.paged_slots[slot];
    const uint64_t owner = page.owner.load(std::memory_order_acquire);
    if (owner == asset && page.page_index == page_index) return slot;
    if (owner == 0 && free_slot == core.paged_config.slot_count) {
      free_slot = slot;
      continue;
    }
    if (owner != 0 && page.pin_count.load(std::memory_order_acquire) == 0
      && page.access_sequence < lru_sequence) {
      lru_slot = slot;
      lru_sequence = page.access_sequence;
    }
  }
  return free_slot != core.paged_config.slot_count ? free_slot : lru_slot;
}

daw_audio_paged_preparation_handle make_paged_preparation_handle(uint32_t index, uint32_t generation) {
  return (static_cast<daw_audio_paged_preparation_handle>(generation) << 32u)
    | static_cast<daw_audio_paged_preparation_handle>(index + 1u);
}
}  // namespace

namespace daw::audio_core_internal {

bool paged_asset_is_referenced(const Core &core, daw_audio_asset_handle asset) {
  for (const SampleSource &source : *core.active_sample_sources) {
    if (source.active && source.asset == asset) return true;
  }
  if (core.paged_preparations != nullptr) {
    for (uint32_t index = 0; index < DAW_AUDIO_CORE_MAX_PAGED_PREPARATIONS; ++index) {
      const PagedPreparation &preparation = core.paged_preparations[index];
      if (preparation.occupied && preparation.asset == asset) return true;
    }
  }
  for (uint32_t slot = 0; slot < kNodeRuntimeSlots; ++slot) {
    const uint32_t state = core.node_slots[slot].state.load(std::memory_order_acquire);
    if (state != kSlotPrepared && state != kSlotActive) continue;
    const InstrumentNodeState &instrument = core.instrument_runtime[slot];
    for (uint32_t index = 0; index < instrument.sampler.zone_count; ++index) {
      if (instrument.zones[index].asset == asset) return true;
    }
    for (const SampleVoice &voice : instrument.sample_voices) {
      if (voice.active && voice.asset == asset) return true;
    }
    for (const SampleVoice &voice : instrument.dying_sample_voices) {
      if (voice.active && voice.asset == asset) return true;
    }
    if (instrument.granular.asset == asset && (instrument.granular_note_count > 0
      || std::any_of(instrument.grains.begin(), instrument.grains.end(),
        [](const GranularGrain &grain) { return grain.active; }))) return true;
  }
  return false;
}
}  // namespace daw::audio_core_internal


extern "C" uint32_t daw_audio_core_get_paged_sub_abi_version(void) {
  return DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION;
}

extern "C" daw_audio_core_result daw_audio_core_configure_paged_assets(
  daw_audio_core_handle core_handle,
  const daw_audio_paged_asset_config *config) {
  Core *core = to_core(core_handle);
  if (core == nullptr || config == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  return initialize_paged_storage(*core, *config)
    ? DAW_AUDIO_CORE_OK
    : DAW_AUDIO_CORE_INVALID_ARGUMENT;
}

extern "C" daw_audio_core_result daw_audio_core_create_paged_asset(
  daw_audio_core_handle core_handle,
  const daw_audio_paged_asset_descriptor *descriptor,
  daw_audio_asset_handle *out_asset) {
  Core *core = to_core(core_handle);
  if (core == nullptr || descriptor == nullptr || out_asset == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (descriptor->abi_version != DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION
    || descriptor->revision == 0 || descriptor->frame_count == 0
    || descriptor->sample_rate_hz == 0 || descriptor->channel_count == 0
    || descriptor->channel_count > core->paged_config.max_channels
    || core->paged_config.slot_count == 0) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (descriptor->frame_count > UINT64_MAX / descriptor->channel_count / sizeof(float)
    || descriptor->byte_length != descriptor->frame_count * descriptor->channel_count * sizeof(float)) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  for (uint32_t index = 0; index < core->config.max_assets; ++index) {
    AssetSlot &slot = core->assets[index];
    if (slot.occupied) continue;
    slot.occupied = true;
    slot.paged = true;
    slot.revision = descriptor->revision;
    slot.frame_count = descriptor->frame_count;
    slot.sample_rate_hz = descriptor->sample_rate_hz;
    slot.channel_count = descriptor->channel_count;
    slot.planes = nullptr;
    *out_asset = make_asset_handle(index, slot.generation);
    return DAW_AUDIO_CORE_OK;
  }
  return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
}

extern "C" daw_audio_core_result daw_audio_core_write_paged_asset_page(
  daw_audio_core_handle core_handle,
  const daw_audio_paged_asset_page_write *write) {
  Core *core = to_core(core_handle);
  if (core == nullptr || write == nullptr || write->planes == nullptr
    || write->abi_version != DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  AssetSlot *asset = find_asset(core, write->asset);
  if (asset == nullptr || !asset->paged) return DAW_AUDIO_CORE_INVALID_HANDLE;
  if (write->channel_count != asset->channel_count
    || write->channel_count > core->paged_config.max_channels
    || write->page_index >= paged_page_count(*core, asset->frame_count)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  const uint64_t page_start = write->page_index
    * static_cast<uint64_t>(core->paged_config.page_frames);
  const uint32_t expected_frames = static_cast<uint32_t>(
    std::min<uint64_t>(core->paged_config.page_frames, asset->frame_count - page_start));
  if (write->valid_frames != expected_frames) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  for (uint32_t channel = 0; channel < write->channel_count; ++channel) {
    if (write->planes[channel] == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  PagedPageSlot *existing = find_paged_page(*core, write->asset, write->page_index);
  if (existing != nullptr) {
    bool duplicate = true;
    for (uint32_t channel = 0; channel < write->channel_count && duplicate; ++channel) {
      const float *destination = paged_storage_plane(*core,
        static_cast<uint32_t>(existing - core->paged_slots.get()), channel);
      for (uint32_t frame = 0; frame < expected_frames; ++frame) {
        if (destination[frame] != write->planes[channel][frame]) {
          duplicate = false;
          break;
        }
      }
    }
    if (duplicate) return DAW_AUDIO_CORE_OK;
    if (existing->pin_count.load(std::memory_order_acquire) != 0) return DAW_AUDIO_CORE_ASSET_IN_USE;
  }
  const uint32_t selected = existing == nullptr
    ? select_paged_page_slot(*core, write->asset, write->page_index)
    : static_cast<uint32_t>(existing - core->paged_slots.get());
  if (selected >= core->paged_config.slot_count) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  PagedPageSlot &page = core->paged_slots[selected];
  if (page.pin_count.load(std::memory_order_acquire) != 0) return DAW_AUDIO_CORE_ASSET_IN_USE;
  page.owner.store(0, std::memory_order_release);
  for (uint32_t channel = 0; channel < core->paged_config.max_channels; ++channel) {
    float *destination = paged_storage_plane(*core, selected, channel);
    if (channel < write->channel_count) {
      for (uint32_t frame = 0; frame < expected_frames; ++frame) destination[frame] = write->planes[channel][frame];
    }
    for (uint32_t frame = expected_frames; frame < core->paged_config.page_frames; ++frame) destination[frame] = 0.0F;
  }
  page.page_index = write->page_index;
  page.valid_frames = expected_frames;
  page.access_sequence = ++core->paged_access_sequence;
  page.owner.store(write->asset, std::memory_order_release);
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_prepare_paged_asset(
  daw_audio_core_handle core_handle,
  const daw_audio_paged_asset_prepare_request *request,
  daw_audio_paged_preparation_handle *out_preparation,
  uint64_t *out_first_missing_page) {
  Core *core = to_core(core_handle);
  if (out_preparation != nullptr) *out_preparation = 0;
  if (out_first_missing_page != nullptr) *out_first_missing_page = 0;
  if (core == nullptr || request == nullptr || out_preparation == nullptr
    || out_first_missing_page == nullptr
    || request->abi_version != DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION
    || request->source_frame_count == 0) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  AssetSlot *asset = find_asset(core, request->asset);
  if (asset == nullptr || !asset->paged) return DAW_AUDIO_CORE_INVALID_HANDLE;
  if (request->source_offset_frame >= asset->frame_count
    || request->source_frame_count > asset->frame_count - request->source_offset_frame
    || request->interpolation_guard_frames > 1) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (request->source_frame_count > UINT64_MAX - request->source_offset_frame
    || request->interpolation_guard_frames > UINT64_MAX
      - request->source_offset_frame - request->source_frame_count) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  const uint64_t source_end = request->source_offset_frame + request->source_frame_count;
  const uint64_t guarded_end = source_end > UINT64_MAX - request->interpolation_guard_frames
    ? UINT64_MAX
    : source_end + request->interpolation_guard_frames;
  const uint64_t end = std::min(asset->frame_count, guarded_end);
  const uint64_t first_page = request->source_offset_frame
    / static_cast<uint64_t>(core->paged_config.page_frames);
  const uint64_t last_page = (end - 1u)
    / static_cast<uint64_t>(core->paged_config.page_frames);
  const uint64_t page_count64 = last_page - first_page + 1u;
  if (page_count64 > core->paged_config.slot_count
    || page_count64 > DAW_AUDIO_CORE_MAX_PAGED_PREPARATION_PAGES) {
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
  for (uint64_t index = 0; index < page_count64; ++index) {
    const uint64_t page_index = first_page + index;
    if (find_paged_page(*core, request->asset, page_index) == nullptr) {
      *out_first_missing_page = page_index;
      return DAW_AUDIO_CORE_NO_DATA;
    }
  }
  uint32_t preparation_index = DAW_AUDIO_CORE_MAX_PAGED_PREPARATIONS;
  for (uint32_t index = 0; index < DAW_AUDIO_CORE_MAX_PAGED_PREPARATIONS; ++index) {
    if (!core->paged_preparations[index].occupied) {
      preparation_index = index;
      break;
    }
  }
  if (preparation_index == DAW_AUDIO_CORE_MAX_PAGED_PREPARATIONS) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  PagedPreparation &preparation = core->paged_preparations[preparation_index];
  preparation.asset = request->asset;
  preparation.source_offset_frame = request->source_offset_frame;
  preparation.source_frame_count = request->source_frame_count;
  preparation.first_page = first_page;
  preparation.page_count = static_cast<uint32_t>(page_count64);
  for (uint32_t index = 0; index < preparation.page_count; ++index) {
    PagedPageSlot *page = find_paged_page(*core, request->asset, first_page + index);
    preparation.page_slots[index] = static_cast<uint16_t>(page - core->paged_slots.get());
    page->pin_count.fetch_add(1, std::memory_order_acq_rel);
    page->access_sequence = ++core->paged_access_sequence;
  }
  preparation.occupied = true;
  *out_preparation = make_paged_preparation_handle(preparation_index, preparation.generation);
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_schedule_prepared_sample_source(
  daw_audio_core_handle core_handle,
  const daw_audio_paged_sample_source_event *event) {
  Core *core = to_core(core_handle);
  if (core == nullptr || event == nullptr
    || event->abi_version != DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION
    || event->preparation == 0 || event->epoch == 0 || event->sequence == 0
    || event->stop_frame <= event->start_frame || event->source_frame_count == 0
    || !std::isfinite(event->gain) || !std::isfinite(event->source_offset_fraction)
    || event->source_offset_fraction < 0.0F || event->source_offset_fraction >= 1.0F
    || event->epoch != core->transport.epoch || event->sequence <= core->last_event_sequence) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  PagedPreparation *preparation = find_paged_preparation(*core, event->preparation);
  if (preparation == nullptr) return DAW_AUDIO_CORE_INVALID_HANDLE;
  if (event->source_offset_frame < preparation->source_offset_frame
    || event->source_offset_frame > preparation->source_offset_frame + preparation->source_frame_count
    || event->source_frame_count > preparation->source_offset_frame + preparation->source_frame_count
      - event->source_offset_frame) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if ((*core->published_graph).revision == core->published_revision) {
    const int32_t node_index = graph_node_index((*core->published_graph), event->source_node_id);
    if (node_index < 0 || (*core->published_graph).nodes[static_cast<uint32_t>(node_index)].kind
      != DAW_AUDIO_GRAPH_NODE_SOURCE) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  } else if (event->source_node_id != 0) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  SampleSource *target = nullptr;
  for (uint32_t index = 0; index < kMaximumSampleSources; ++index) {
    auto &source = (*core->active_sample_sources)[index];
    if (!source.active) {
      target = &source;
      break;
    }
  }
  if (target == nullptr) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  *target = {
    .source_node_id = event->source_node_id, .asset = preparation->asset,
    .start_frame = event->start_frame, .stop_frame = event->stop_frame,
    .source_offset_frame = event->source_offset_frame,
    .source_offset_fraction = event->source_offset_fraction,
    .source_frame_count = event->source_frame_count, .gain = event->gain,
    .fade_in_start_frame = event->fade_in_start_frame, .fade_in_end_frame = event->fade_in_end_frame,
    .fade_out_start_frame = event->fade_out_start_frame, .fade_out_end_frame = event->fade_out_end_frame,
    .fade_in_curve = event->fade_in_curve, .fade_in_curve_position = event->fade_in_curve_position,
    .fade_out_curve = event->fade_out_curve, .fade_out_curve_position = event->fade_out_curve_position,
    .paged_preparation = preparation, .paged = true, .active = true,
  };
  bind_sample_source_node(*target, *core->published_graph);
  core->last_event_sequence = event->sequence;
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_release_paged_preparation(
  daw_audio_core_handle core_handle,
  daw_audio_paged_preparation_handle handle) {
  Core *core = to_core(core_handle);
  if (core == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  PagedPreparation *preparation = find_paged_preparation(*core, handle);
  if (preparation == nullptr) return DAW_AUDIO_CORE_INVALID_HANDLE;
  for (const SampleSource &source : *core->active_sample_sources) {
    if (source.active && source.paged_preparation == preparation) return DAW_AUDIO_CORE_ASSET_IN_USE;
  }
  for (uint32_t index = 0; index < preparation->page_count; ++index) {
    PagedPageSlot &page = core->paged_slots[preparation->page_slots[index]];
    uint32_t pin_count = page.pin_count.load(std::memory_order_acquire);
    while (pin_count != 0
      && !page.pin_count.compare_exchange_weak(
        pin_count, pin_count - 1, std::memory_order_acq_rel, std::memory_order_acquire)) {
    }
  }
  preparation->occupied = false;
  preparation->asset = 0;
  preparation->page_count = 0;
  ++preparation->generation;
  if (preparation->generation == 0) ++preparation->generation;
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_trim_paged_asset(
  daw_audio_core_handle core_handle,
  daw_audio_asset_handle asset_handle,
  uint64_t first_page,
  uint32_t page_count) {
  Core *core = to_core(core_handle);
  if (core == nullptr || page_count == 0) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (first_page > UINT64_MAX - page_count) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  AssetSlot *asset = find_asset(core, asset_handle);
  if (asset == nullptr || !asset->paged) return DAW_AUDIO_CORE_INVALID_HANDLE;
  const uint64_t last_page = first_page + page_count;
  for (uint32_t index = 0; index < DAW_AUDIO_CORE_MAX_PAGED_PREPARATIONS; ++index) {
    const PagedPreparation &preparation = core->paged_preparations[index];
    if (!preparation.occupied || preparation.asset != asset_handle) continue;
    const uint64_t preparation_last_page = preparation.first_page
      > UINT64_MAX - preparation.page_count
      ? UINT64_MAX
      : preparation.first_page + preparation.page_count;
    if (preparation.first_page < last_page
      && preparation_last_page > first_page) return DAW_AUDIO_CORE_ASSET_IN_USE;
  }
  for (uint32_t slot = 0; slot < core->paged_config.slot_count; ++slot) {
    PagedPageSlot &page = core->paged_slots[slot];
    if (page.owner.load(std::memory_order_acquire) == asset_handle
      && page.page_index >= first_page && page.page_index < last_page) {
      if (page.pin_count.load(std::memory_order_acquire) != 0) return DAW_AUDIO_CORE_ASSET_IN_USE;
    }
  }
  for (uint32_t slot = 0; slot < core->paged_config.slot_count; ++slot) {
    PagedPageSlot &page = core->paged_slots[slot];
    if (page.owner.load(std::memory_order_acquire) == asset_handle
      && page.page_index >= first_page && page.page_index < last_page) page.owner.store(0, std::memory_order_release);
  }
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_create_asset(
  daw_audio_core_handle core_handle,
  const daw_audio_asset_descriptor *descriptor,
  daw_audio_asset_handle *out_asset) {
  if (descriptor == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  const daw_audio_mapped_asset_descriptor mapped_descriptor{
    .abi_version = descriptor->abi_version,
    .revision = descriptor->revision,
    .byte_length = descriptor->byte_length,
    .content_hash_prefix = descriptor->content_hash_prefix,
    .frame_count = descriptor->frame_count,
    .sample_rate_hz = descriptor->sample_rate_hz,
    .channel_count = descriptor->channel_count,
    .planes = descriptor->planes,
  };
  return daw_audio_core_create_mapped_asset(core_handle, &mapped_descriptor, out_asset);
}

extern "C" daw_audio_core_result daw_audio_core_create_mapped_asset(
  daw_audio_core_handle core_handle,
  const daw_audio_mapped_asset_descriptor *descriptor,
  daw_audio_asset_handle *out_asset) {
  Core *core = to_core(core_handle);
  if (core == nullptr || descriptor == nullptr || out_asset == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (!valid_abi(descriptor->abi_version)) return DAW_AUDIO_CORE_UNSUPPORTED_VERSION;
  if (!valid_asset_descriptor(*descriptor)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  for (uint32_t index = 0; index < core->config.max_assets; ++index) {
    AssetSlot &slot = core->assets[index];
    if (slot.occupied) continue;
    slot.occupied = true;
    slot.paged = false;
    slot.revision = descriptor->revision;
    slot.frame_count = descriptor->frame_count;
    slot.sample_rate_hz = descriptor->sample_rate_hz;
    slot.channel_count = descriptor->channel_count;
    slot.planes = descriptor->planes;
    *out_asset = make_asset_handle(index, slot.generation);
    return DAW_AUDIO_CORE_OK;
  }
  return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
}

extern "C" daw_audio_core_result daw_audio_core_get_asset_revision(
  daw_audio_core_handle core_handle,
  daw_audio_asset_handle asset,
  uint32_t *out_revision) {
  Core *core = to_core(core_handle);
  if (core == nullptr || out_revision == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  AssetSlot *slot = find_asset(core, asset);
  if (slot == nullptr) return DAW_AUDIO_CORE_INVALID_HANDLE;
  *out_revision = slot->revision;
  return DAW_AUDIO_CORE_OK;
}
namespace daw::audio_core_internal {

void release_asset_storage(Core *core, AssetSlot *slot, daw_audio_asset_handle asset) {
  slot->occupied = false;
  slot->revision = 0;
  slot->frame_count = 0;
  slot->sample_rate_hz = 0;
  slot->channel_count = 0;
  slot->planes = nullptr;
  slot->paged = false;
  if (core->paged_slots != nullptr) {
    for (uint32_t index = 0; index < core->paged_config.slot_count; ++index) {
      PagedPageSlot &page = core->paged_slots[index];
      if (page.owner.load(std::memory_order_acquire) == asset) page.owner.store(0, std::memory_order_release);
    }
  }
  ++slot->generation;
  if (slot->generation == 0) ++slot->generation;
}
}  // namespace daw::audio_core_internal


extern "C" daw_audio_core_result daw_audio_core_release_asset(
  daw_audio_core_handle core_handle,
  daw_audio_asset_handle asset) {
  Core *core = to_core(core_handle);
  if (core == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  AssetSlot *slot = find_asset(core, asset);
  if (slot == nullptr) return DAW_AUDIO_CORE_INVALID_HANDLE;
  if (asset_is_active(*core, asset)) return DAW_AUDIO_CORE_ASSET_IN_USE;
  release_asset_storage(core, slot, asset);
  return DAW_AUDIO_CORE_OK;
}
