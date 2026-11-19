#include "daw/audio_core.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <string_view>
#include <vector>

namespace {

constexpr uint32_t kSampleRate = 48'000;
constexpr uint32_t kWarmupBlocks = 256;
constexpr uint32_t kMeasuredBlocks = 2'000;
constexpr std::array<uint32_t, 4> kVoiceCounts{1, 4, 8, 16};
constexpr std::array<uint32_t, 2> kBlockSizes{128, 512};

[[noreturn]] void fail(const char *operation, daw_audio_core_result result) {
  std::cerr << operation << " failed with audio-core result " << result << '\n';
  std::exit(1);
}

void check(const char *operation, daw_audio_core_result result) {
  if (result != DAW_AUDIO_CORE_OK) fail(operation, result);
}

daw_audio_synth_state synth_state(bool worst_case) {
  if (!worst_case) {
    return {
      .version = 1,
      .seed = 1,
      .oscillators = {
        {.enabled = 1, .waveform = DAW_AUDIO_SYNTH_WAVEFORM_SAWTOOTH, .level = 0.7F, .octave = 0, .semitone = 0, .detune_cents = -7.0F},
        {.enabled = 1, .waveform = DAW_AUDIO_SYNTH_WAVEFORM_SAWTOOTH, .level = 0.45F, .octave = 0, .semitone = 0, .detune_cents = 7.0F},
      },
      .noise_level = 0.25F,
      .filter_enabled = 1,
      .filter_mode = DAW_AUDIO_SYNTH_FILTER_MODE_LOWPASS,
      .filter_cutoff_hz = 12'000.0F,
      .filter_resonance = 0.7F,
      .filter_attack_ms = 5.0F,
      .filter_decay_ms = 150.0F,
      .filter_sustain = 0.0F,
      .filter_release_ms = 150.0F,
      .amp_attack_ms = 5.0F,
      .amp_decay_ms = 100.0F,
      .amp_sustain = 0.8F,
      .amp_release_ms = 120.0F,
      .lfo_waveform = DAW_AUDIO_SYNTH_WAVEFORM_SINE,
      .lfo_rate_hz = 5.0F,
      .output_gain = 0.8F,
    };
  }
  return {
    .version = 1,
    .seed = 0x12345678U,
    .oscillators = {
      {.enabled = 1, .waveform = DAW_AUDIO_SYNTH_WAVEFORM_SAWTOOTH, .level = 0.7F, .octave = 0, .semitone = 0, .detune_cents = -7.0F},
      {.enabled = 1, .waveform = DAW_AUDIO_SYNTH_WAVEFORM_SQUARE, .level = 0.45F, .octave = 0, .semitone = 0, .detune_cents = 7.0F},
    },
    .noise_enabled = 1,
    .noise_level = 0.25F,
    .filter_enabled = 1,
    .filter_mode = DAW_AUDIO_SYNTH_FILTER_MODE_LOWPASS,
    .filter_cutoff_hz = 4'000.0F,
    .filter_resonance = 0.707F,
    .filter_key_tracking = 0.5F,
    .filter_envelope_amount_octaves = 1.0F,
    .filter_attack_ms = 1.0F,
    .filter_decay_ms = 10.0F,
    .filter_sustain = 0.5F,
    .filter_release_ms = 4.0F,
    .amp_attack_ms = 1.0F,
    .amp_decay_ms = 10.0F,
    .amp_sustain = 0.7F,
    .amp_release_ms = 4.0F,
    .lfo_enabled = 1,
    .lfo_waveform = DAW_AUDIO_SYNTH_WAVEFORM_TRIANGLE,
    .lfo_rate_hz = 3.0F,
    .lfo_pitch_cents = 8.0F,
    .lfo_filter_octaves = 0.2F,
    .lfo_amplitude = 0.1F,
    .lfo_pan = 0.2F,
    .output_gain = 0.8F,
  };
}

struct Metrics {
  double median_us;
  double p95_us;
  double p99_us;
  double max_us;
  double budget_percent;
  double output_peak;
  uint64_t non_finite_samples;
  uint64_t subnormal_samples;
  uint32_t estimated_tracks_50;
  uint32_t estimated_tracks_70;
};

Metrics measure(uint32_t frames, uint32_t voices, bool worst_case) {
  const daw_audio_core_config config{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .max_frames_per_block = frames,
    .max_channels = 2,
    .max_assets = 1,
    .sample_rate_hz = kSampleRate,
  };
  daw_audio_core_handle core = 0;
  check("create", daw_audio_core_create(&config, &core));

  const daw_audio_graph_node_descriptor nodes[]{
    {.id = 1, .kind = DAW_AUDIO_GRAPH_NODE_INSTRUMENT, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0,
      .instrument = {.kind = DAW_AUDIO_INSTRUMENT_KIND_SYNTH, .version = 1, .voice_capacity = 16}},
    {.id = 2, .kind = DAW_AUDIO_GRAPH_NODE_MASTER, .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
      .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO, .input_bus = 0, .latency_frames = 0},
  };
  const daw_audio_graph_edge_descriptor edge{
    .id = 1, .from_node_id = 1, .to_node_id = 2, .gain = 1.0F,
    .tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER,
  };
  const daw_audio_graph_prepare_request request{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = 1,
    .node_count = 2, .edge_count = 1, .nodes = nodes, .edges = &edge,
  };
  check("prepare graph", daw_audio_core_prepare_graph(core, &request));
  const daw_audio_synth_state synth = synth_state(worst_case);
  check("configure synth", daw_audio_core_configure_synth(core, 1, &synth));
  check("publish graph", daw_audio_core_publish(core, 1));
  const daw_audio_transport_state transport{.epoch = 1, .running = 1, .frame = 0};
  check("set transport", daw_audio_core_set_transport(core, &transport));

  std::vector<daw_audio_instrument_event> notes;
  notes.reserve(voices);
  for (uint32_t voice = 0; voice < voices; ++voice) {
    notes.push_back({
      .node_id = 1, .note_id = voice + 1, .sequence = voice + 1, .epoch = 1,
      .frame_offset = 0, .type = DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON, .channel = 0,
      .note = 48 + voice * 3, .value = 0.8F,
    });
  }
  std::vector<float> left(frames), right(frames);
  float *outputs[]{left.data(), right.data()};
  const daw_audio_core_process_block start{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = frames, .channel_count = 2,
    .input_bus_count = 0, .inputs = nullptr, .outputs = outputs, .graph_revision = 1,
    .transport_epoch = 1, .instrument_event_count = voices, .instrument_events = notes.data(),
  };
  check("start held notes", daw_audio_core_process(core, &start));
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = frames, .channel_count = 2,
    .input_bus_count = 0, .inputs = nullptr, .outputs = outputs, .graph_revision = 1,
    .transport_epoch = 1,
  };
  for (uint32_t index = 0; index < kWarmupBlocks; ++index) {
    check("warmup render", daw_audio_core_process(core, &block));
  }

  std::vector<double> timings;
  timings.reserve(kMeasuredBlocks);
  uint64_t non_finite_samples = 0;
  uint64_t subnormal_samples = 0;
  double output_peak = 0.0;
  for (uint32_t index = 0; index < kMeasuredBlocks; ++index) {
    const auto before = std::chrono::steady_clock::now();
    check("measured render", daw_audio_core_process(core, &block));
    const auto after = std::chrono::steady_clock::now();
    timings.push_back(std::chrono::duration<double, std::micro>(after - before).count());
    for (uint32_t frame = 0; frame < frames; ++frame) {
      for (float sample : {left[frame], right[frame]}) {
        if (!std::isfinite(sample)) ++non_finite_samples;
        else {
          const double magnitude = std::abs(static_cast<double>(sample));
          output_peak = std::max(output_peak, magnitude);
          if (magnitude > 0.0 && magnitude < std::numeric_limits<float>::min()) ++subnormal_samples;
        }
      }
    }
  }
  std::sort(timings.begin(), timings.end());
  const auto percentile = [&timings](double p) {
    const auto index = static_cast<size_t>(std::ceil(p * static_cast<double>(timings.size()))) - 1;
    return timings[std::min(index, timings.size() - 1)];
  };
  const double budget_us = static_cast<double>(frames) * 1'000'000.0 / kSampleRate;
  const double median_us = percentile(0.5);
  const auto track_count = [budget_us, median_us](double fraction) {
    if (median_us <= 0.0) return uint32_t{0};
    return static_cast<uint32_t>(std::floor(fraction * budget_us / median_us));
  };
  const Metrics result{
    .median_us = median_us,
    .p95_us = percentile(0.95),
    .p99_us = percentile(0.99),
    .max_us = timings.back(),
    .budget_percent = median_us * 100.0 / budget_us,
    .output_peak = output_peak,
    .non_finite_samples = non_finite_samples,
    .subnormal_samples = subnormal_samples,
    .estimated_tracks_50 = track_count(0.5),
    .estimated_tracks_70 = track_count(0.7),
  };
  daw_audio_core_destroy(core);
  return result;
}

void print_result(uint32_t frames, uint32_t voices, std::string_view patch, const Metrics &m, bool &first) {
  if (!first) std::cout << ",\n";
  first = false;
  std::cout << "    {\"frames\":" << frames
            << ",\"voices\":" << voices
            << ",\"patch\":\"" << patch
            << "\",\"medianUs\":" << m.median_us
            << ",\"p95Us\":" << m.p95_us
            << ",\"p99Us\":" << m.p99_us
            << ",\"maxUs\":" << m.max_us
            << ",\"medianBudgetPercent\":" << m.budget_percent
            << ",\"outputPeak\":" << m.output_peak
            << ",\"nonFiniteSamples\":" << m.non_finite_samples
            << ",\"subnormalSamples\":" << m.subnormal_samples
            << ",\"estimated16VoiceTracksAt50Percent\":" << m.estimated_tracks_50
            << ",\"estimated16VoiceTracksAt70Percent\":" << m.estimated_tracks_70 << "}";
}

}  // namespace

int main() {
  std::cout.precision(10);
  std::cout << "{\n  \"sampleRateHz\":" << kSampleRate
            << ",\n  \"warmupBlocks\":" << kWarmupBlocks
            << ",\n  \"measuredBlocks\":" << kMeasuredBlocks
            << ",\n  \"results\":[\n";
  bool first = true;
  for (uint32_t frames : kBlockSizes) {
    for (uint32_t voices : kVoiceCounts) {
      print_result(frames, voices, "default", measure(frames, voices, false), first);
      print_result(frames, voices, "worst-case", measure(frames, voices, true), first);
    }
  }
  std::cout << "\n  ]\n}\n";
}
