#include "ebur128.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <limits>
#include <string>
#include <vector>

namespace {

bool ParseUnsigned(const char* value, unsigned long& output) {
  if (value == nullptr || *value == '\0') return false;
  char* end = nullptr;
  errno = 0;
  const auto parsed = std::strtoul(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0') return false;
  output = parsed;
  return true;
}

void WriteNullableNumber(const double value) {
  if (std::isfinite(value)) {
    std::cout << value;
  } else {
    std::cout << "null";
  }
}

int Fail(const std::string& message) {
  std::cerr << message << '\n';
  return 1;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 4) {
    return Fail("usage: daw-loudness-reference <sample-rate> <channels> <interleaved-f32-file>");
  }

  unsigned long sample_rate = 0;
  unsigned long channel_count_value = 0;
  if (!ParseUnsigned(argv[1], sample_rate) || sample_rate == 0) {
    return Fail("sample rate must be a positive integer");
  }
  if (!ParseUnsigned(argv[2], channel_count_value)
      || (channel_count_value != 1 && channel_count_value != 2)) {
    return Fail("channel count must be 1 or 2");
  }
  const auto channel_count = static_cast<unsigned int>(channel_count_value);

  std::ifstream input(argv[3], std::ios::binary | std::ios::ate);
  if (!input) return Fail("failed to open PCM input");
  const auto byte_count = input.tellg();
  if (byte_count < 0 || byte_count % static_cast<std::streamoff>(sizeof(float) * channel_count) != 0) {
    return Fail("PCM input must contain complete interleaved float32 frames");
  }
  input.seekg(0, std::ios::beg);
  std::vector<float> samples(static_cast<std::size_t>(byte_count) / sizeof(float));
  if (!samples.empty()) {
    input.read(reinterpret_cast<char*>(samples.data()), byte_count);
    if (!input) return Fail("failed to read PCM input");
  }

  const auto mode = EBUR128_MODE_I | EBUR128_MODE_LRA | EBUR128_MODE_TRUE_PEAK;
  ebur128_state* state = ebur128_init(channel_count, sample_rate, mode);
  if (state == nullptr) return Fail("ebur128_init failed");

  const auto frame_count = samples.size() / channel_count;
  constexpr std::size_t kChunkFrames = 4096;
  for (std::size_t frame = 0; frame < frame_count; frame += kChunkFrames) {
    const auto frames = std::min(kChunkFrames, frame_count - frame);
    if (ebur128_add_frames_float(state, samples.data() + frame * channel_count, frames) != EBUR128_SUCCESS) {
      ebur128_destroy(&state);
      return Fail("ebur128_add_frames_float failed");
    }
  }

  double integrated_lufs = std::numeric_limits<double>::quiet_NaN();
  double loudness_range_lu = std::numeric_limits<double>::quiet_NaN();
  if (ebur128_loudness_global(state, &integrated_lufs) != EBUR128_SUCCESS) {
    ebur128_destroy(&state);
    return Fail("ebur128_loudness_global failed");
  }
  if (ebur128_loudness_range(state, &loudness_range_lu) != EBUR128_SUCCESS) {
    ebur128_destroy(&state);
    return Fail("ebur128_loudness_range failed");
  }

  double true_peak = 0;
  for (unsigned int channel = 0; channel < channel_count; channel += 1) {
    double channel_peak = 0;
    if (ebur128_true_peak(state, channel, &channel_peak) != EBUR128_SUCCESS) {
      ebur128_destroy(&state);
      return Fail("ebur128_true_peak failed");
    }
    true_peak = std::max(true_peak, channel_peak);
  }

  int version_major = 0;
  int version_minor = 0;
  int version_patch = 0;
  ebur128_get_version(&version_major, &version_minor, &version_patch);
  ebur128_destroy(&state);

  std::cout << "{\"reference\":\"libebur128\",\"version\":\""
            << version_major << "." << version_minor << "." << version_patch
            << "\",\"integratedLufs\":";
  WriteNullableNumber(integrated_lufs);
  std::cout << ",\"loudnessRangeLu\":";
  WriteNullableNumber(loudness_range_lu);
  std::cout << ",\"truePeak\":" << true_peak << ",\"truePeakDbtp\":";
  WriteNullableNumber(true_peak > 0 ? 20 * std::log10(true_peak) : std::numeric_limits<double>::quiet_NaN());
  std::cout << "}\n";
  return 0;
}
