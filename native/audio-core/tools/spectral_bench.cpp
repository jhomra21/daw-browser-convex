// Prints what one Spectral instance costs at 48 kHz, for each `with` fixture against the same graph without a processor:
// the mean per frame and the worst block (a hop's whole FFT work lands in one process call). Not a pass/fail gate: the numbers
// compare a change with the code before it. Fixtures come from native/audio-core/tools/spectral-bench-fixtures.ts.
// Usage: daw-spectral-bench <repeats> <without.fixture> <with.fixture>...
#include "graph_fixture_timing.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <vector>

namespace {

struct Cost {
  double mean_nanoseconds_per_frame;
  double worst_block_microseconds;
};

// Best of `repeats` runs for both numbers, so a preempted run does not count. Negative when the fixture fails.
Cost measure(const std::vector<uint8_t> &fixture, int repeats) {
  using namespace daw::audio_core::bench;
  const uint32_t frames = read_u32(fixture, 32);
  const uint32_t channels = read_u32(fixture, 20);
  std::vector<float> output(static_cast<size_t>(frames) * channels);
  std::vector<float *> planes(channels);
  for (uint32_t channel = 0; channel < channels; ++channel) planes[channel] = output.data() + static_cast<size_t>(channel) * frames;
  std::vector<double> blocks(64);
  Cost best{1.0e18, 1.0e18};
  for (int repeat = 0; repeat < repeats; ++repeat) {
    std::fill(blocks.begin(), blocks.end(), 0.0);
    if (daw_audio_core_run_graph_fixture_timed(fixture.data(), fixture.size(), planes.data(), blocks.data()) != DAW_AUDIO_CORE_OK) return {-1.0, -1.0};
    double total = 0.0, worst = 0.0;
    for (const double block : blocks) {
      total += block;
      worst = std::max(worst, block);
    }
    best.mean_nanoseconds_per_frame = std::min(best.mean_nanoseconds_per_frame, total / frames);
    best.worst_block_microseconds = std::min(best.worst_block_microseconds, worst / 1000.0);
  }
  return best;
}

}  // namespace

int main(int argc, char **argv) {
  using namespace daw::audio_core::bench;
  if (argc < 4) return 2;
  const int repeats = std::max(1, std::atoi(argv[1]));
  std::vector<uint8_t> without;
  if (!read_file(argv[2], without)) return 2;
  const Cost base = measure(without, repeats);
  if (base.mean_nanoseconds_per_frame < 0.0) return 3;
  constexpr double rate = 48000.0;
  for (int index = 3; index < argc; ++index) {
    std::vector<uint8_t> with;
    if (!read_file(argv[index], with)) return 2;
    const Cost full = measure(with, repeats);
    if (full.mean_nanoseconds_per_frame < 0.0) return 3;
    const double mean = full.mean_nanoseconds_per_frame - base.mean_nanoseconds_per_frame;
    std::printf("%-34s %8.1f ns/frame %6.2f %% of realtime   worst block %8.1f us (empty graph %.1f us)\n", argv[index], mean,
      mean * rate / 1.0e7, full.worst_block_microseconds, base.worst_block_microseconds);
  }
  return 0;
}
