// Prints what one Reverb instance costs per frame: the best of several timed runs of a graph fixture with the Reverb,
// minus the same graph without it. Not a pass/fail gate: the numbers are for comparing a change with the code before it.
// Fixtures come from native/audio-core/tools/reverb-bench-fixtures.ts.
// Usage: daw-reverb-bench <without.fixture> <with.fixture> [repeats]
#include "graph_fixture_timing.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <vector>

int main(int argc, char **argv) {
  using namespace daw::audio_core::bench;
  if (argc < 3) return 2;
  std::vector<uint8_t> without, with;
  if (!read_file(argv[1], without) || !read_file(argv[2], with)) return 2;
  const int repeats = argc > 3 ? std::max(1, std::atoi(argv[3])) : 5;
  const double base = nanoseconds_per_frame(without, repeats);
  const double full = nanoseconds_per_frame(with, repeats);
  if (base < 0.0 || full < 0.0) return 3;
  std::printf("%.1f ns/frame\n", full - base);
  return 0;
}
