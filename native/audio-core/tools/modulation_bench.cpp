// Prints what a modulation effect costs per frame and as a share of the realtime budget at 48 kHz, for each
// `with` fixture against the same graph without a processor. Not a pass/fail gate: the numbers are for comparing a change
// with the code before it. Fixtures come from native/audio-core/tools/modulation-bench-fixtures.ts.
// Usage: daw-modulation-bench <repeats> <without.fixture> <with.fixture>...
#include "graph_fixture_timing.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <vector>

int main(int argc, char **argv) {
  using namespace daw::audio_core::bench;
  if (argc < 4) return 2;
  const int repeats = std::max(1, std::atoi(argv[1]));
  std::vector<uint8_t> without;
  if (!read_file(argv[2], without)) return 2;
  const double base = nanoseconds_per_frame(without, repeats);
  if (base < 0.0) return 3;
  constexpr double rate = 48000.0;  // the rate modulation-bench-fixtures.ts writes
  for (int index = 3; index < argc; ++index) {
    std::vector<uint8_t> with;
    if (!read_file(argv[index], with)) return 2;
    const double full = nanoseconds_per_frame(with, repeats);
    if (full < 0.0) return 3;
    std::printf("%-40s %7.1f ns/frame %6.2f %% of realtime\n", argv[index], full - base, (full - base) * rate / 1.0e7);
  }
  return 0;
}
