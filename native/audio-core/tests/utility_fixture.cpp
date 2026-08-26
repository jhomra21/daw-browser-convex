#include "utility_fixture.h"

#include <array>
#include <cstddef>
#include <cstdint>

namespace {

bool fixture_size_is_valid(const daw_audio_utility_fixture_header &header, size_t fixture_byte_count) {
  const size_t plane_count = static_cast<size_t>(header.input_bus_count) * header.channel_count;
  const size_t sample_count = plane_count * header.frame_count;
  return header.frame_count > 0
    && header.channel_count > 0
    && header.input_bus_count <= UINT32_MAX / header.channel_count
    && plane_count <= SIZE_MAX / header.frame_count
    && sample_count <= (SIZE_MAX - sizeof(header)) / sizeof(float)
    && fixture_byte_count == sizeof(header) + sample_count * sizeof(float);
}

}  // namespace

extern "C" daw_audio_core_result daw_audio_core_run_utility_fixture(
  const uint8_t *fixture_bytes,
  size_t fixture_byte_count,
  float *const *outputs) {
  if (fixture_bytes == nullptr || outputs == nullptr || fixture_byte_count < sizeof(daw_audio_utility_fixture_header)) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  const auto *header = reinterpret_cast<const daw_audio_utility_fixture_header *>(fixture_bytes);
  if (header->magic != DAW_AUDIO_UTILITY_FIXTURE_MAGIC || header->version != DAW_AUDIO_UTILITY_FIXTURE_VERSION || !fixture_size_is_valid(*header, fixture_byte_count)) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }

  daw_audio_core_handle core = 0;
  const daw_audio_core_config config{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .max_frames_per_block = header->frame_count,
    .max_channels = header->channel_count,
    .max_assets = 1,
    .sample_rate_hz = header->sample_rate_hz,
  };
  daw_audio_core_result result = daw_audio_core_create(&config, &core);
  if (result != DAW_AUDIO_CORE_OK) return result;

  const daw_audio_core_prepare_request request{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .graph_revision = 1,
    .reserved0 = 0,
    .reserved1 = 0,
  };
  result = daw_audio_core_prepare(core, &request);
  if (result == DAW_AUDIO_CORE_OK) result = daw_audio_core_publish(core, request.graph_revision);
  if (result == DAW_AUDIO_CORE_OK) result = daw_audio_core_configure_utility(core, &header->state);
  const auto *inputs = reinterpret_cast<const float *>(fixture_bytes + sizeof(*header));
  if (result == DAW_AUDIO_CORE_OK) {
    std::array<const float *, 4096> input_planes{};
    const uint32_t plane_count = header->input_bus_count * header->channel_count;
    for (uint32_t plane = 0; plane < plane_count; ++plane) input_planes[plane] = inputs + plane * header->frame_count;
    const daw_audio_core_process_block block{
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
      .frame_count = header->frame_count,
      .channel_count = header->channel_count,
      .input_bus_count = header->input_bus_count,
      .inputs = input_planes.data(),
      .outputs = outputs,
    };
    result = daw_audio_core_process(core, &block);
  }
  daw_audio_core_destroy(core);
  return result;
}
