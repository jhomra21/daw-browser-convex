#include "graph_fixture.h"

#include <array>
#include <cstring>
#include <limits>

namespace {

uint32_t read_u32(const uint8_t *bytes, size_t offset) {
  return static_cast<uint32_t>(bytes[offset])
    | (static_cast<uint32_t>(bytes[offset + 1]) << 8u)
    | (static_cast<uint32_t>(bytes[offset + 2]) << 16u)
    | (static_cast<uint32_t>(bytes[offset + 3]) << 24u);
}

float read_f32(const uint8_t *bytes, size_t offset) {
  const uint32_t bits = read_u32(bytes, offset);
  float value = 0.0F;
  std::memcpy(&value, &bits, sizeof(value));
  return value;
}

int64_t read_i64(const uint8_t *bytes, size_t offset) {
  uint64_t value = 0;
  for (uint32_t index = 0; index < 8; ++index) value |= static_cast<uint64_t>(bytes[offset + index]) << (index * 8u);
  int64_t result = 0;
  std::memcpy(&result, &value, sizeof(result));
  return result;
}

bool add_bytes(size_t *total, size_t bytes) {
  if (bytes > std::numeric_limits<size_t>::max() - *total) return false;
  *total += bytes;
  return true;
}

bool read_bytes(const uint8_t *bytes, size_t byte_count, size_t *offset, size_t count, const uint8_t **out) {
  if (*offset > byte_count || count > byte_count - *offset) return false;
  *out = bytes + *offset;
  *offset += count;
  return true;
}

bool read_u32_at(const uint8_t *bytes, size_t byte_count, size_t *offset, uint32_t *out) {
  const uint8_t *field = nullptr;
  if (!read_bytes(bytes, byte_count, offset, sizeof(uint32_t), &field)) return false;
  *out = read_u32(field, 0);
  return true;
}

bool read_u64_at(const uint8_t *bytes, size_t byte_count, size_t *offset, uint64_t *out) {
  const uint8_t *field = nullptr;
  if (!read_bytes(bytes, byte_count, offset, sizeof(uint64_t), &field)) return false;
  uint64_t value = 0;
  for (uint32_t index = 0; index < 8; ++index) value |= static_cast<uint64_t>(field[index]) << (index * 8u);
  *out = value;
  return true;
}

struct FixtureAsset {
  bool installed = false;
  uint32_t generation = 0;
  daw_audio_asset_handle handle = 0;
  uint32_t frame_count = 0;
  uint32_t channel_count = 0;
  std::array<std::array<float, DAW_AUDIO_GRAPH_FIXTURE_MAX_ASSET_FRAMES>,
    DAW_AUDIO_GRAPH_FIXTURE_MAX_ASSET_CHANNELS> planes{};
  std::array<const float *, DAW_AUDIO_GRAPH_FIXTURE_MAX_ASSET_CHANNELS> plane_pointers{};
};

bool decode_assets(
  const uint8_t *bytes,
  size_t byte_count,
  std::array<FixtureAsset, DAW_AUDIO_GRAPH_FIXTURE_MAX_ASSETS> *assets) {
  size_t offset = 0;
  uint32_t count = 0;
  if (!read_u32_at(bytes, byte_count, &offset, &count) || count > DAW_AUDIO_GRAPH_FIXTURE_MAX_ASSETS) return false;
  for (uint32_t index = 0; index < count; ++index) {
    uint32_t identity = 0;
    uint32_t generation = 0;
    uint32_t operation = 0;
    uint32_t frames = 0;
    uint32_t sample_rate_hz = 0;
    uint32_t channels = 0;
    uint32_t data_bytes = 0;
    if (!read_u32_at(bytes, byte_count, &offset, &identity) || !read_u32_at(bytes, byte_count, &offset, &generation)
      || !read_u32_at(bytes, byte_count, &offset, &operation) || !read_u32_at(bytes, byte_count, &offset, &frames)
      || !read_u32_at(bytes, byte_count, &offset, &sample_rate_hz) || !read_u32_at(bytes, byte_count, &offset, &channels)
      || !read_u32_at(bytes, byte_count, &offset, &data_bytes) || identity == 0 || identity > assets->size()
      || generation == 0 || frames == 0 || frames > DAW_AUDIO_GRAPH_FIXTURE_MAX_ASSET_FRAMES
      || sample_rate_hz == 0 || channels == 0 || channels > DAW_AUDIO_GRAPH_FIXTURE_MAX_ASSET_CHANNELS
      || data_bytes != frames * channels * sizeof(float)) return false;
    FixtureAsset &asset = (*assets)[identity - 1];
    if ((operation == 1 && asset.installed) || (operation == 2 && !asset.installed)
      || (operation != 1 && operation != 2) || generation != asset.generation + 1) return false;
    if (operation == 2 && daw_audio_core_wasm_graph_release_asset(asset.handle) != DAW_AUDIO_CORE_OK) return false;
    const uint8_t *data = nullptr;
    if (!read_bytes(bytes, byte_count, &offset, data_bytes, &data)) return false;
    for (uint32_t channel = 0; channel < channels; ++channel) {
      std::memcpy(asset.planes[channel].data(), data + channel * frames * sizeof(float), frames * sizeof(float));
      asset.plane_pointers[channel] = asset.planes[channel].data();
    }
    daw_audio_asset_handle handle = 0;
    if (daw_audio_core_wasm_graph_register_pcm_asset(
      frames, sample_rate_hz, channels, asset.plane_pointers.data(), &handle) != DAW_AUDIO_CORE_OK) return false;
    const daw_audio_asset_handle expected_handle =
      (static_cast<daw_audio_asset_handle>(generation) << 32u) | static_cast<daw_audio_asset_handle>(identity);
    if (handle != expected_handle) return false;
    asset.installed = true;
    asset.generation = generation;
    asset.handle = handle;
    asset.frame_count = frames;
    asset.channel_count = channels;
  }
  return offset == byte_count;
}

bool decode_instrument_states(const uint8_t *bytes, size_t byte_count) {
  size_t offset = 0;
  uint32_t count = 0;
  if (!read_u32_at(bytes, byte_count, &offset, &count) || count > 64) return false;
  for (uint32_t index = 0; index < count; ++index) {
    uint64_t node_id = 0;
    uint32_t kind = 0;
    uint32_t state_bytes = 0;
    uint32_t zone_bytes = 0;
    const uint8_t *state = nullptr;
    const uint8_t *zones = nullptr;
    if (!read_u64_at(bytes, byte_count, &offset, &node_id) || !read_u32_at(bytes, byte_count, &offset, &kind)
      || !read_u32_at(bytes, byte_count, &offset, &state_bytes) || !read_u32_at(bytes, byte_count, &offset, &zone_bytes)
      || !read_bytes(bytes, byte_count, &offset, state_bytes, &state) || !read_bytes(bytes, byte_count, &offset, zone_bytes, &zones)) return false;
    daw_audio_core_result result = DAW_AUDIO_CORE_INVALID_ARGUMENT;
    if (kind == DAW_AUDIO_INSTRUMENT_KIND_SYNTH && state_bytes == sizeof(daw_audio_synth_state) && zone_bytes == 0) {
      daw_audio_synth_state decoded{};
      std::memcpy(&decoded, state, sizeof(decoded));
      result = daw_audio_core_wasm_graph_configure_synth(node_id, &decoded);
    } else if ((kind == DAW_AUDIO_INSTRUMENT_KIND_SAMPLER || kind == DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK)
      && state_bytes == sizeof(daw_audio_sampler_state) && zone_bytes > 0
      && zone_bytes % sizeof(daw_audio_sample_zone) == 0) {
      daw_audio_sampler_state decoded{};
      std::memcpy(&decoded, state, sizeof(decoded));
      if (zone_bytes != decoded.zone_count * sizeof(daw_audio_sample_zone)) return false;
      std::array<daw_audio_sample_zone, DAW_AUDIO_CORE_MAX_SAMPLE_ZONES> decoded_zones{};
      std::memcpy(decoded_zones.data(), zones, zone_bytes);
      result = daw_audio_core_wasm_graph_configure_sampler(node_id, &decoded, decoded_zones.data());
    } else if (kind == DAW_AUDIO_INSTRUMENT_KIND_GRANULAR && state_bytes == 60 && zone_bytes == 0) {
      daw_audio_granular_state decoded{
        .version = read_u32(state, 0),
        .asset = [&state] {
          uint64_t value = 0;
          for (uint32_t byte = 0; byte < 8; ++byte) value |= static_cast<uint64_t>(state[4 + byte]) << (byte * 8u);
          return value;
        }(),
        .seed = read_u32(state, 12),
        .max_grains = read_u32(state, 16),
        .window_shape = read_u32(state, 20),
        .freeze = read_u32(state, 24),
        .grain_size_ms = read_f32(state, 28),
        .density_hz = read_f32(state, 32),
        .position = read_f32(state, 36),
        .spray = read_f32(state, 40),
        .pitch_semitones = read_f32(state, 44),
        .reverse_probability = read_f32(state, 48),
        .stereo_spread = read_f32(state, 52),
      };
      result = daw_audio_core_wasm_graph_configure_granular(node_id, &decoded);
    }
    if (result != DAW_AUDIO_CORE_OK) return false;
  }
  return offset == byte_count;
}

bool decode_block_partitions(
  const uint8_t *bytes,
  size_t byte_count,
  uint32_t frame_count,
  uint32_t max_frames,
  std::array<uint32_t, 64> *partitions,
  uint32_t *partition_count) {
  size_t offset = 0;
  uint32_t count = 0;
  if (!read_u32_at(bytes, byte_count, &offset, &count) || count == 0 || count > partitions->size()) return false;
  uint64_t total = 0;
  for (uint32_t index = 0; index < count; ++index) {
    uint32_t frames = 0;
    if (!read_u32_at(bytes, byte_count, &offset, &frames) || frames == 0 || frames > max_frames) return false;
    (*partitions)[index] = frames;
    total += frames;
  }
  if (offset != byte_count || total != frame_count) return false;
  *partition_count = count;
  return true;
}

}  // namespace

extern "C" uint32_t daw_audio_core_graph_fixture_protocol_version(void) {
  return DAW_AUDIO_GRAPH_FIXTURE_VERSION;
}

extern "C" daw_audio_core_result daw_audio_core_run_graph_fixture(
  const uint8_t *fixture_bytes,
  size_t fixture_byte_count,
  float *const *outputs) {
  if (fixture_bytes == nullptr || outputs == nullptr || fixture_byte_count < DAW_AUDIO_GRAPH_FIXTURE_HEADER_BYTES_LEGACY) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  const uint32_t version = read_u32(fixture_bytes, 4);
  if (read_u32(fixture_bytes, 0) != DAW_AUDIO_GRAPH_FIXTURE_MAGIC
    || (version != DAW_AUDIO_GRAPH_FIXTURE_VERSION
      && version != DAW_AUDIO_GRAPH_FIXTURE_VERSION_ASSETS
      && version != DAW_AUDIO_GRAPH_FIXTURE_VERSION_LEGACY)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  const size_t header_bytes = version == DAW_AUDIO_GRAPH_FIXTURE_VERSION_LEGACY
    ? DAW_AUDIO_GRAPH_FIXTURE_HEADER_BYTES_LEGACY : DAW_AUDIO_GRAPH_FIXTURE_HEADER_BYTES;
  if (fixture_byte_count < header_bytes) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  const uint32_t sample_rate_hz = read_u32(fixture_bytes, 8);
  const uint32_t max_frames = read_u32(fixture_bytes, 12);
  const uint32_t input_bus_count = read_u32(fixture_bytes, 16);
  const uint32_t channel_count = read_u32(fixture_bytes, 20);
  const uint32_t graph_revision = read_u32(fixture_bytes, 24);
  const uint32_t graph_bytes = read_u32(fixture_bytes, 28);
  const uint32_t frame_count = read_u32(fixture_bytes, 32);
  const uint32_t parameter_bytes = read_u32(fixture_bytes, 36);
  const uint32_t event_bytes = read_u32(fixture_bytes, 40);
  const uint32_t instrument_event_bytes = read_u32(fixture_bytes, 44);
  const uint32_t transport_epoch = read_u32(fixture_bytes, 48);
  const uint32_t transport_running = read_u32(fixture_bytes, 52);
  const int64_t transport_frame = read_i64(fixture_bytes, 56);
  const uint32_t asset_bytes = version == DAW_AUDIO_GRAPH_FIXTURE_VERSION_LEGACY ? 0 : read_u32(fixture_bytes, 64);
  const uint32_t instrument_state_bytes = version == DAW_AUDIO_GRAPH_FIXTURE_VERSION_LEGACY ? 0 : read_u32(fixture_bytes, 68);
  const uint32_t block_partition_bytes = version == DAW_AUDIO_GRAPH_FIXTURE_VERSION ? read_u32(fixture_bytes, 72) : 0;
  if (version == DAW_AUDIO_GRAPH_FIXTURE_VERSION_ASSETS
    && (read_u32(fixture_bytes, 72) != 0 || read_u32(fixture_bytes, 76) != 0)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (version == DAW_AUDIO_GRAPH_FIXTURE_VERSION && read_u32(fixture_bytes, 76) != 0) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (sample_rate_hz == 0 || max_frames == 0 || frame_count == 0
    || input_bus_count > 64 || channel_count == 0 || channel_count > 2 || graph_revision == 0
    || transport_epoch == 0 || transport_running > 1) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  const uint64_t plane_count = static_cast<uint64_t>(input_bus_count) * channel_count;
  const uint64_t input_bytes64 = plane_count * frame_count * sizeof(float);
  if (input_bytes64 > std::numeric_limits<size_t>::max()) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  size_t expected_bytes = header_bytes;
  if (!add_bytes(&expected_bytes, graph_bytes) || !add_bytes(&expected_bytes, static_cast<size_t>(input_bytes64))
    || !add_bytes(&expected_bytes, parameter_bytes) || !add_bytes(&expected_bytes, event_bytes)
    || !add_bytes(&expected_bytes, instrument_event_bytes) || !add_bytes(&expected_bytes, asset_bytes)
    || !add_bytes(&expected_bytes, instrument_state_bytes) || !add_bytes(&expected_bytes, block_partition_bytes)
    || expected_bytes != fixture_byte_count) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  const uint8_t *graph = fixture_bytes + header_bytes;
  const auto *input_samples = reinterpret_cast<const float *>(graph + graph_bytes);
  const uint8_t *parameters = reinterpret_cast<const uint8_t *>(input_samples) + input_bytes64;
  const uint8_t *events = parameters + parameter_bytes;
  const uint8_t *instrument_events = events + event_bytes;
  const uint8_t *assets = instrument_events + instrument_event_bytes;
  const uint8_t *instrument_states = assets + asset_bytes;
  const uint8_t *block_partitions = instrument_states + instrument_state_bytes;
  std::array<uint32_t, 64> partitions{};
  uint32_t partition_count = 1;
  partitions[0] = frame_count;
  if (block_partition_bytes == 0) {
    if (frame_count > max_frames) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  } else if (parameter_bytes != 0 || event_bytes != 0 || instrument_event_bytes != 0
    || !decode_block_partitions(
      block_partitions, block_partition_bytes, frame_count, max_frames, &partitions, &partition_count)) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  daw_audio_core_result result = daw_audio_core_wasm_graph_initialize_planar(
    sample_rate_hz, max_frames, input_bus_count == 0 ? 1 : input_bus_count, channel_count, DAW_AUDIO_GRAPH_FIXTURE_MAX_ASSETS);
  if (result == DAW_AUDIO_CORE_OK) result = daw_audio_core_wasm_graph_prepare(graph, graph_bytes);
  if (result == DAW_AUDIO_CORE_OK) result = daw_audio_core_wasm_graph_publish(graph_revision);
  std::array<FixtureAsset, DAW_AUDIO_GRAPH_FIXTURE_MAX_ASSETS> asset_storage{};
  if (result == DAW_AUDIO_CORE_OK && asset_bytes != 0
    && !decode_assets(assets, asset_bytes, &asset_storage)) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  if (result == DAW_AUDIO_CORE_OK && instrument_state_bytes != 0
    && !decode_instrument_states(instrument_states, instrument_state_bytes)) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  uint32_t frame_offset = 0;
  for (uint32_t partition = 0; result == DAW_AUDIO_CORE_OK && partition < partition_count; ++partition) {
    const uint32_t partition_frames = partitions[partition];
    if (transport_frame > std::numeric_limits<int64_t>::max() - frame_offset) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    result = daw_audio_core_wasm_graph_set_transport(
      transport_epoch, transport_running, transport_frame + static_cast<int64_t>(frame_offset));
    if (result != DAW_AUDIO_CORE_OK) break;
    std::array<const float *, 128> inputs{};
    std::array<float *, 2> partition_outputs{};
    for (uint32_t plane = 0; plane < plane_count; ++plane) {
      inputs[plane] = input_samples + plane * frame_count + frame_offset;
    }
    for (uint32_t channel = 0; channel < channel_count; ++channel) {
      partition_outputs[channel] = outputs[channel] + frame_offset;
    }
    result = daw_audio_core_wasm_graph_process_planar(
      partition_frames, input_bus_count, channel_count, input_bus_count == 0 ? nullptr : inputs.data(), partition_outputs.data(),
      graph_revision, parameter_bytes == 0 ? nullptr : parameters, parameter_bytes,
      event_bytes == 0 ? nullptr : events, event_bytes,
      instrument_event_bytes == 0 ? nullptr : instrument_events, instrument_event_bytes);
    frame_offset += partition_frames;
  }
  return result;
}
