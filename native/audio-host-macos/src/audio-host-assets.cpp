#include "audio-host-internal.h"

namespace daw::audio_host_macos {

bool AudioHost::InstallAsset(
  const std::uint32_t asset_id,
  const std::uint32_t frame_count,
  const std::uint32_t sample_rate_hz,
  const std::uint32_t channel_count,
  const std::uint64_t content_hash_prefix,
  const std::span<const float> samples
) {
  impl_->asset_operation_error = kAssetRefusalInvalidAsset;
  const daw_audio_core_handle active_core = impl_->active_core.load(std::memory_order_acquire);
  if (impl_->publication_in_flight != 0) {
    impl_->asset_operation_error = kAssetRefusalPublicationPending; return false;
  }
  if (active_core == 0
    || asset_id == 0 || frame_count == 0 || frame_count > kMaximumAssetFrames
    || sample_rate_hz == 0 || channel_count == 0 || channel_count > kMaximumAssetChannels
    || samples.size() != static_cast<std::size_t>(frame_count) * channel_count) return false;
  if (!std::all_of(samples.begin(), samples.end(), [](const float sample) { return std::isfinite(sample); })) return false;
  if (const auto found = impl_->assets.find(asset_id); found != impl_->assets.end()) {
    auto& asset = found->second;
    if (asset.mapped || asset.frame_count != frame_count || asset.sample_rate_hz != sample_rate_hz
      || asset.channel_count != channel_count || asset.content_hash_prefix != content_hash_prefix
      || !std::equal(samples.begin(), samples.end(), asset.samples.begin(), asset.samples.end())) {
      impl_->asset_operation_error = kAssetRefusalIdentityConflict; return false;
    }
    impl_->ReuseAsset(asset);
    impl_->asset_operation_error = {};
    return true;
  }
  impl_->ReclaimAssets();
  if (impl_->assets.size() >= kMaximumInstalledAssets) {
    impl_->asset_operation_error = kAssetRefusalCapacityExceeded; return false;
  }
  Impl::InstalledAsset asset{
    .samples = {samples.begin(), samples.end()},
    .frame_count = frame_count,
    .sample_rate_hz = sample_rate_hz,
    .channel_count = channel_count,
    .content_hash_prefix = content_hash_prefix,
    .staged_revision = impl_->prepared_revision.load(std::memory_order_acquire),
  };
  const auto [asset_iterator, inserted] = impl_->assets.emplace(asset_id, std::move(asset));
  if (!inserted) return false;
  auto& stored = asset_iterator->second;
  stored.planes.fill(nullptr);
  for (std::uint32_t channel = 0; channel < channel_count; ++channel) {
    stored.planes[channel] = stored.samples.data() + static_cast<std::size_t>(channel) * stored.frame_count;
  }
  const daw_audio_asset_descriptor descriptor{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .revision = stored.staged_revision != 0 ? stored.staged_revision : impl_->active_revision.load(std::memory_order_acquire),
    .byte_length = static_cast<std::uint64_t>(samples.size_bytes()),
    .content_hash_prefix = content_hash_prefix,
    .frame_count = frame_count,
    .sample_rate_hz = sample_rate_hz,
    .channel_count = channel_count,
    .planes = stored.planes.data(),
  };
  if (daw_audio_core_create_asset(active_core, &descriptor, &stored.handle) != DAW_AUDIO_CORE_OK) {
    impl_->assets.erase(asset_iterator);
    return false;
  }
  impl_->asset_operation_error = {};
  return true;
}

bool AudioHost::CreateMappedAsset(
  const std::uint32_t asset_id,
  const std::uint64_t frame_count,
  const std::uint32_t sample_rate_hz,
  const std::uint32_t channel_count,
  const std::uint64_t content_hash_prefix
) {
  impl_->asset_operation_error = kAssetRefusalInvalidAsset;
  const daw_audio_core_handle active_core = impl_->active_core.load(std::memory_order_acquire);
  if (impl_->publication_in_flight != 0) {
    impl_->asset_operation_error = kAssetRefusalPublicationPending; return false;
  }
  if (active_core == 0
    || asset_id == 0 || frame_count == 0 || sample_rate_hz == 0
    || channel_count == 0 || channel_count > kMaximumAssetChannels
    || frame_count > std::numeric_limits<std::size_t>::max() / channel_count
    || frame_count * channel_count > std::numeric_limits<std::size_t>::max() / sizeof(float)) return false;
  if (const auto found = impl_->assets.find(asset_id); found != impl_->assets.end()) {
    auto& asset = found->second;
    if (!asset.mapped || asset.frame_count != frame_count || asset.sample_rate_hz != sample_rate_hz
      || asset.channel_count != channel_count || asset.content_hash_prefix != content_hash_prefix) {
      impl_->asset_operation_error = kAssetRefusalIdentityConflict; return false;
    }
    impl_->ReuseAsset(asset);
    impl_->asset_operation_error = {};
    return true;
  }
  impl_->ReclaimAssets();
  if (impl_->assets.size() >= kMaximumInstalledAssets) {
    impl_->asset_operation_error = kAssetRefusalCapacityExceeded; return false;
  }
  const std::size_t byte_length = static_cast<std::size_t>(frame_count)
    * channel_count * sizeof(float);
  char template_path[] = "/tmp/daw-native-asset-XXXXXX";
  const int file_descriptor = mkstemp(template_path);
  if (file_descriptor < 0) return false;
  unlink(template_path);
  if (byte_length > static_cast<std::size_t>(std::numeric_limits<off_t>::max())) {
    close(file_descriptor);
    return false;
  }
  if (ftruncate(file_descriptor, static_cast<off_t>(byte_length)) != 0) {
    close(file_descriptor);
    return false;
  }
  void* address = mmap(nullptr, byte_length, PROT_READ | PROT_WRITE, MAP_SHARED, file_descriptor, 0);
  if (address == MAP_FAILED) {
    close(file_descriptor);
    return false;
  }
  auto mapped = std::make_unique<Impl::InstalledAsset::MappedStorage>();
  mapped->file_descriptor = file_descriptor;
  mapped->address = address;
  mapped->byte_length = byte_length;
  Impl::InstalledAsset asset{
    .mapped = std::move(mapped),
    .frame_count = frame_count,
    .sample_rate_hz = sample_rate_hz,
    .channel_count = channel_count,
    .content_hash_prefix = content_hash_prefix,
    .staged_revision = impl_->prepared_revision.load(std::memory_order_acquire),
  };
  asset.planes.fill(nullptr);
  auto* samples = static_cast<float*>(asset.mapped->address);
  for (std::uint32_t channel = 0; channel < channel_count; ++channel) {
    asset.planes[channel] = samples + static_cast<std::size_t>(channel) * static_cast<std::size_t>(frame_count);
  }
  const auto [asset_iterator, inserted] = impl_->assets.emplace(asset_id, std::move(asset));
  if (!inserted) return false;
  auto& stored = asset_iterator->second;
  const daw_audio_mapped_asset_descriptor descriptor{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .revision = stored.staged_revision != 0 ? stored.staged_revision : impl_->active_revision.load(std::memory_order_acquire),
    .byte_length = byte_length,
    .content_hash_prefix = content_hash_prefix,
    .frame_count = frame_count,
    .sample_rate_hz = sample_rate_hz,
    .channel_count = channel_count,
    .planes = stored.planes.data(),
  };
  if (daw_audio_core_create_mapped_asset(active_core, &descriptor, &stored.handle) != DAW_AUDIO_CORE_OK) {
    impl_->assets.erase(asset_iterator);
    return false;
  }
  impl_->asset_operation_error = {};
  return true;
}

bool AudioHost::WriteMappedAssetPage(
  const std::uint32_t asset_id,
  const std::uint64_t start_frame,
  const std::uint32_t frame_count,
  const std::span<const float> samples
) {
  impl_->asset_operation_error = kAssetRefusalInvalidAssetPage;
  if (impl_->publication_in_flight != 0) {
    impl_->asset_operation_error = kAssetRefusalPublicationPending; return false;
  }
  const auto asset_iterator = impl_->assets.find(asset_id);
  if (asset_iterator == impl_->assets.end() || !asset_iterator->second.mapped
    || asset_iterator->second.mapped->locked_bytes != 0
    || asset_iterator->second.mapped->instrument_published
    || frame_count == 0 || start_frame >= asset_iterator->second.frame_count
    || frame_count > asset_iterator->second.frame_count - start_frame
    || samples.size() != static_cast<std::size_t>(frame_count) * asset_iterator->second.channel_count
    || !std::all_of(samples.begin(), samples.end(), [](const float sample) { return std::isfinite(sample); })) return false;
  auto& asset = asset_iterator->second;
  // Existing mapped pages are immutable once they can have readers. Hydration
  // adds disjoint pages; a repeated page is an idempotent read-only comparison.
  const auto end = start_frame + frame_count;
  const bool overlap = std::any_of(asset.mapped->written_ranges.begin(), asset.mapped->written_ranges.end(),
    [start_frame, end](const auto range) { return range.first < end && start_frame < range.second; });
  bool identical = false;
  if (overlap) {
    const auto* source = static_cast<const float*>(asset.mapped->address);
    for (std::uint32_t channel = 0; channel < asset.channel_count; ++channel) {
      if (!std::equal(samples.begin() + static_cast<std::size_t>(channel) * frame_count,
        samples.begin() + static_cast<std::size_t>(channel + 1) * frame_count,
        source + static_cast<std::size_t>(channel) * asset.frame_count + start_frame)) {
        impl_->asset_operation_error = kAssetRefusalPageIdentityConflict;
        return false;
      }
    }
    identical = true;
  }
  const std::uint64_t end_frame = start_frame + frame_count;
  auto& ranges = asset.mapped->written_ranges;
  std::vector<std::pair<std::uint64_t, std::uint64_t>> merged;
  merged.reserve(ranges.size() + 1);
  std::uint64_t merged_start = start_frame;
  std::uint64_t merged_end = end_frame;
  bool inserted = false;
  for (const auto [range_start, range_end] : ranges) {
    if (range_end < merged_start) {
      merged.emplace_back(range_start, range_end);
    } else if (merged_end < range_start) {
      if (!inserted) {
        merged.emplace_back(merged_start, merged_end);
        inserted = true;
      }
      merged.emplace_back(range_start, range_end);
    } else {
      merged_start = std::min(merged_start, range_start);
      merged_end = std::max(merged_end, range_end);
    }
  }
  if (!inserted) merged.emplace_back(merged_start, merged_end);
  if (merged.size() > kMaximumMappedAssetWrittenRanges) {
    impl_->asset_operation_error = kAssetRefusalPageCapacityExceeded;
    return false;
  }
  auto* destination = static_cast<float*>(asset.mapped->address) + static_cast<std::size_t>(start_frame);
  for (std::uint32_t channel = 0; channel < asset.channel_count && !identical; ++channel) {
    std::memcpy(destination + static_cast<std::size_t>(channel) * static_cast<std::size_t>(asset.frame_count),
      samples.data() + static_cast<std::size_t>(channel) * frame_count,
      static_cast<std::size_t>(frame_count) * sizeof(float));
  }
  ranges = std::move(merged);
  impl_->asset_operation_error = {};
  return true;
}

bool AudioHost::PrepareMappedAssetRange(
  const std::uint32_t asset_id,
  const std::uint64_t start_frame,
  const std::uint64_t frame_count
) {
  const auto asset_iterator = impl_->assets.find(asset_id);
  if (asset_iterator == impl_->assets.end() || !asset_iterator->second.mapped
    || frame_count == 0 || start_frame >= asset_iterator->second.frame_count
    || frame_count > asset_iterator->second.frame_count - start_frame) return false;
  const auto& ranges = asset_iterator->second.mapped->written_ranges;
  const std::uint64_t end_frame = start_frame + frame_count;
  const bool covered = std::any_of(ranges.begin(), ranges.end(), [start_frame, end_frame](const auto range) {
    return range.first <= start_frame && range.second >= end_frame;
  });
  if (!covered) return false;
  auto& asset = asset_iterator->second;
  const auto byte_offset = static_cast<std::size_t>(start_frame) * sizeof(float);
  const auto byte_length = static_cast<std::size_t>(frame_count) * sizeof(float);
  for (std::uint32_t channel = 0; channel < asset.channel_count; ++channel) {
    auto* address = static_cast<std::uint8_t*>(asset.mapped->address)
      + (static_cast<std::size_t>(channel) * static_cast<std::size_t>(asset.frame_count) * sizeof(float))
      + byte_offset;
    static_cast<void>(madvise(address, byte_length, MADV_WILLNEED));
  }
  return true;
}

std::string_view AudioHost::assetOperationError() const { return impl_->asset_operation_error; }

bool AudioHost::ReleaseAsset(const std::uint32_t asset_id) {
  const auto asset = impl_->assets.find(asset_id);
  if (asset == impl_->assets.end()) return true;
  asset->second.release_requested = true;
  impl_->asset_retirement_pending.store(true, std::memory_order_release);
  impl_->ReclaimAssets();
  return true;
}

}  // namespace daw::audio_host_macos
