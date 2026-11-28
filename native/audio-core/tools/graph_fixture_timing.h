// Shared by the bench tools that time a graph fixture: the cost of a processor is the best of several runs of the graph with it
// minus the same graph without it. Not a pass/fail gate.
#pragma once

#include "../tests/graph_fixture.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <vector>

namespace daw::audio_core::bench {

inline bool read_file(const char *path, std::vector<uint8_t> &bytes) {
  std::FILE *file = std::fopen(path, "rb");
  if (file == nullptr) return false;
  uint8_t chunk[65536];
  size_t count = 0;
  while ((count = std::fread(chunk, 1, sizeof chunk, file)) > 0) bytes.insert(bytes.end(), chunk, chunk + count);
  std::fclose(file);
  return bytes.size() >= DAW_AUDIO_GRAPH_FIXTURE_HEADER_BYTES;
}

inline uint32_t read_u32(const std::vector<uint8_t> &bytes, size_t offset) {
  return static_cast<uint32_t>(bytes[offset]) | (static_cast<uint32_t>(bytes[offset + 1]) << 8u)
    | (static_cast<uint32_t>(bytes[offset + 2]) << 16u) | (static_cast<uint32_t>(bytes[offset + 3]) << 24u);
}

// Nanoseconds per frame of the fastest of `repeats` runs, so a preempted run does not count; negative when the fixture fails.
inline double nanoseconds_per_frame(const std::vector<uint8_t> &fixture, int repeats) {
  const uint32_t frames = read_u32(fixture, 32);
  const uint32_t channels = read_u32(fixture, 20);
  std::vector<float> output(static_cast<size_t>(frames) * channels);
  std::vector<float *> planes(channels);
  for (uint32_t channel = 0; channel < channels; ++channel) planes[channel] = output.data() + static_cast<size_t>(channel) * frames;
  double fastest = 1.0e18;
  for (int repeat = 0; repeat < repeats; ++repeat) {
    const auto start = std::chrono::steady_clock::now();
    const daw_audio_core_result result = daw_audio_core_run_graph_fixture(fixture.data(), fixture.size(), planes.data());
    if (result != DAW_AUDIO_CORE_OK) {
      std::fprintf(stderr, "fixture run failed with result %d\n", static_cast<int>(result));
      return -1.0;
    }
    fastest = std::min(fastest, std::chrono::duration<double, std::nano>(std::chrono::steady_clock::now() - start).count() / frames);
  }
  return fastest;
}

}  // namespace daw::audio_core::bench
