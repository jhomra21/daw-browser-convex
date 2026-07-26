#include "graph_fixture.h"

#include <array>
#include <cmath>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <vector>

namespace {

uint32_t read_u32(const std::vector<uint8_t> &bytes, size_t offset) {
  return static_cast<uint32_t>(bytes[offset])
    | (static_cast<uint32_t>(bytes[offset + 1]) << 8u)
    | (static_cast<uint32_t>(bytes[offset + 2]) << 16u)
    | (static_cast<uint32_t>(bytes[offset + 3]) << 24u);
}

}  // namespace

int main(int argc, char **argv) {
  const bool repeat = argc == 2 && std::strcmp(argv[1], "--repeat") == 0;
  if (argc > 2 || (argc == 2 && !repeat)) return 1;
  std::vector<uint8_t> fixture;
  std::array<uint8_t, 4096> chunk{};
  while (true) {
    const size_t count = std::fread(chunk.data(), 1, chunk.size(), stdin);
    fixture.insert(fixture.end(), chunk.begin(), chunk.begin() + count);
    if (count < chunk.size()) break;
  }
  if (fixture.size() < DAW_AUDIO_GRAPH_FIXTURE_HEADER_BYTES_LEGACY) return 2;
  const uint32_t frames = read_u32(fixture, 32);
  const uint32_t channels = read_u32(fixture, 20);
  if (frames == 0 || channels == 0 || channels > 2) return 2;
  std::vector<float> output(static_cast<size_t>(frames) * channels);
  std::array<float *, 2> planes{};
  for (uint32_t channel = 0; channel < channels; ++channel) planes[channel] = output.data() + channel * frames;
  if (daw_audio_core_run_graph_fixture(fixture.data(), fixture.size(), planes.data()) != DAW_AUDIO_CORE_OK) return 3;
  if (repeat) {
    const std::vector<float> first = output;
    if (daw_audio_core_run_graph_fixture(fixture.data(), fixture.size(), planes.data()) != DAW_AUDIO_CORE_OK) return 3;
    for (size_t index = 0; index < output.size(); ++index) {
      if (!std::isfinite(output[index]) || !std::isfinite(first[index])
        || std::abs(output[index] - first[index]) > 1e-6F) return 5;
    }
  }
  return std::fwrite(output.data(), sizeof(float), output.size(), stdout) == output.size() ? 0 : 4;
}
