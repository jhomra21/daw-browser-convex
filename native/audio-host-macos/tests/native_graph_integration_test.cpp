#include "daw/audio_host_macos.h"

#include <CommonCrypto/CommonDigest.h>

#include <atomic>
#include <array>
#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace {

constexpr std::size_t kFrames = 512;
constexpr std::uint32_t kSampleRate = 48'000;
constexpr char kBundlePath[] = "/Library/Audio/Plug-Ins/VST3/ValhallaSupermassive.vst3";
constexpr char kExecutablePath[] =
  "/Library/Audio/Plug-Ins/VST3/ValhallaSupermassive.vst3/Contents/MacOS/ValhallaSupermassive";
constexpr char kClassId[] = "565354734D617376616C68616C6C6173";
constexpr char kVendorId[] = "Valhalla DSP, LLC";
constexpr char kBundleFingerprint[] =
  "0db70288522e217dd5a3c3690e3d9da2416a0019aa2def7e956e938af35a0a16";
constexpr char kBinaryFingerprint[] =
  "6e45a98e5da42ad8bcbfb7096debc5dddda111a710f28efb439fa8048c139b7d";

void AppendLeU32(std::vector<std::uint8_t>& bytes, const std::uint32_t value) {
  bytes.push_back(static_cast<std::uint8_t>(value));
  bytes.push_back(static_cast<std::uint8_t>(value >> 8U));
  bytes.push_back(static_cast<std::uint8_t>(value >> 16U));
  bytes.push_back(static_cast<std::uint8_t>(value >> 24U));
}

void AppendLeU64(std::vector<std::uint8_t>& bytes, const std::uint64_t value) {
  for (std::size_t index = 0; index < 8; ++index) {
    bytes.push_back(static_cast<std::uint8_t>(value >> (index * 8U)));
  }
}

void AppendLeFloat(std::vector<std::uint8_t>& bytes, const float value) {
  std::uint32_t encoded = 0;
  std::memcpy(&encoded, &value, sizeof(encoded));
  AppendLeU32(bytes, encoded);
}

void AppendBeU32(std::vector<std::uint8_t>& bytes, const std::uint32_t value) {
  bytes.push_back(static_cast<std::uint8_t>(value >> 24U));
  bytes.push_back(static_cast<std::uint8_t>(value >> 16U));
  bytes.push_back(static_cast<std::uint8_t>(value >> 8U));
  bytes.push_back(static_cast<std::uint8_t>(value));
}

void AppendBeU64(std::vector<std::uint8_t>& bytes, const std::uint64_t value) {
  for (int index = 7; index >= 0; --index) {
    bytes.push_back(static_cast<std::uint8_t>(value >> (index * 8)));
  }
}

std::vector<std::uint8_t> GraphSnapshot(const bool instrument, const bool active) {
  std::vector<std::uint8_t> payload;
  AppendLeU32(payload, active ? DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION_EXTERNAL_LATENCY
    : DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION);
  AppendLeU32(payload, 2);
  AppendLeU32(payload, 2);
  AppendLeU32(payload, 1);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 0);
  const auto append_node = [&payload, instrument, active](
    const std::uint64_t id,
    const std::uint32_t kind,
    const bool synth,
    const std::uint32_t latency
  ) {
    AppendLeU64(payload, id);
    AppendLeU32(payload, kind);
    AppendLeU32(payload, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
    AppendLeU32(payload, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
    AppendLeU32(payload, 0);
    const std::uint64_t attached_node = instrument ? 1 : 2;
    AppendLeU32(payload, active && id == attached_node ? 0 : latency);
    if (active) AppendLeU32(payload, id == attached_node ? latency : 0);
    if (synth) {
      AppendLeU32(payload, DAW_AUDIO_INSTRUMENT_KIND_SYNTH);
      AppendLeU32(payload, 1);
      AppendLeU32(payload, 8);
      AppendLeU32(payload, 8);
      for (const auto target : {
        DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_GAIN,
        DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_PAN,
        DAW_AUDIO_SYNTH_PARAMETER_FILTER_CUTOFF_HZ,
        DAW_AUDIO_SYNTH_PARAMETER_FILTER_RESONANCE,
        DAW_AUDIO_SYNTH_PARAMETER_AMP_ATTACK_MS,
        DAW_AUDIO_SYNTH_PARAMETER_AMP_DECAY_MS,
        DAW_AUDIO_SYNTH_PARAMETER_AMP_SUSTAIN,
        DAW_AUDIO_SYNTH_PARAMETER_AMP_RELEASE_MS,
      }) AppendLeU32(payload, target);
      for (std::size_t target = 8; target < DAW_AUDIO_CORE_MAX_INSTRUMENT_PARAMETERS; ++target) AppendLeU32(payload, 0);
    } else {
      for (std::size_t field = 0; field < 20; ++field) AppendLeU32(payload, 0);
    }
    AppendLeU64(payload, synth ? 1 : 0);
    AppendLeFloat(payload, synth ? 1.0F : 0.0F);
    AppendLeFloat(payload, 0.0F);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, 0);
  };
  append_node(1, instrument ? 2 : DAW_AUDIO_GRAPH_NODE_SOURCE, instrument, instrument && active ? static_cast<std::uint32_t>(kFrames) : 0);
  append_node(2, 6, false, instrument ? 0 : static_cast<std::uint32_t>(kFrames));
  AppendLeU64(payload, 3);
  AppendLeU64(payload, 1);
  AppendLeU64(payload, 2);
  AppendLeU64(payload, 0);
  AppendLeFloat(payload, 1.0F);
  AppendLeU32(payload, DAW_AUDIO_GRAPH_EDGE_POST_FADER);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 0);
  std::vector<std::uint8_t> frame;
  AppendBeU64(frame, 2);
  AppendBeU32(frame, static_cast<std::uint32_t>(payload.size()));
  frame.insert(frame.end(), payload.begin(), payload.end());
  return frame;
}

std::vector<std::uint8_t> MultipleSourceGraphSnapshot() {
  constexpr std::uint32_t source_count = 6;
  std::vector<std::uint8_t> payload;
  AppendLeU32(payload, DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION);
  AppendLeU32(payload, 2);
  AppendLeU32(payload, source_count + 1);
  AppendLeU32(payload, source_count);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 0);
  const auto append_node = [&payload](
    const std::uint64_t id,
    const std::uint32_t kind,
    const std::uint32_t input_bus,
    const std::uint32_t latency
  ) {
    AppendLeU64(payload, id);
    AppendLeU32(payload, kind);
    AppendLeU32(payload, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
    AppendLeU32(payload, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
    AppendLeU32(payload, input_bus);
    AppendLeU32(payload, latency);
    for (std::size_t field = 0; field < 20; ++field) AppendLeU32(payload, 0);
    AppendLeU64(payload, 0);
    AppendLeFloat(payload, 0.0F);
    AppendLeFloat(payload, 0.0F);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, 0);
  };
  for (std::uint32_t index = 0; index < source_count; ++index) {
    append_node(index + 1, DAW_AUDIO_GRAPH_NODE_SOURCE, DAW_AUDIO_GRAPH_INPUT_BUS_DISCONNECTED, 0);
  }
  append_node(source_count + 1, 6, 0, static_cast<std::uint32_t>(kFrames));
  for (std::uint32_t index = 0; index < source_count; ++index) {
    AppendLeU64(payload, source_count + 2 + index);
    AppendLeU64(payload, index + 1);
    AppendLeU64(payload, source_count + 1);
    AppendLeU64(payload, 0);
    AppendLeFloat(payload, 1.0F);
    AppendLeU32(payload, DAW_AUDIO_GRAPH_EDGE_POST_FADER);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, 0);
  }
  std::vector<std::uint8_t> frame;
  AppendBeU64(frame, 2);
  AppendBeU32(frame, static_cast<std::uint32_t>(payload.size()));
  frame.insert(frame.end(), payload.begin(), payload.end());
  return frame;
}

void AssertMultipleSourceGraphPublishes() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = kSampleRate,
    .max_frames_per_block = static_cast<std::uint32_t>(kFrames),
    .channel_count = 2,
    .revision = 1,
  }));
  const std::array<float, 8> prepared_stretch_asset{0.0F, 0.25F, 0.5F, 0.75F, 0.0F, -0.25F, -0.5F, -0.75F};
  assert(host.InstallAsset(1, 4, 44'100, 2, 0x0123'4567'89ab'cdefULL, prepared_stretch_asset));
  const auto graph_status = host.PrepareGraphRevision(2, MultipleSourceGraphSnapshot());
  assert(graph_status.code == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  assert(host.PublishGraphRevision(2).code == daw::audio_host_macos::GraphRevisionStatusCode::kPublished);
  std::vector<std::uint8_t> source_event;
  AppendLeU32(source_event, 1);
  AppendLeU32(source_event, 1);
  AppendLeU64(source_event, 1);
  AppendLeU64(source_event, 1);
  AppendLeU32(source_event, 1);
  AppendLeU64(source_event, 0);
  AppendLeU64(source_event, 4);
  AppendLeU64(source_event, 0);
  AppendLeU64(source_event, 4);
  AppendLeFloat(source_event, 1.0F);
  AppendLeU64(source_event, 0);
  AppendLeU64(source_event, 0);
  AppendLeU64(source_event, 0);
  AppendLeU64(source_event, 4);
  AppendLeFloat(source_event, 0.0F);
  assert(host.QueueSourceEvents(source_event));
  assert(host.SetTransport(1, true, 0));
  assert(host.StartDiagnosticMode());
  std::array<float, kFrames> input_left{};
  std::array<float, kFrames> input_right{};
  std::array<float, kFrames> output_left{};
  std::array<float, kFrames> output_right{};
  input_left.fill(3.0F);
  input_right.fill(-5.0F);
  const std::array<const float*, 2> input{input_left.data(), input_right.data()};
  const std::array<float*, 2> output{output_left.data(), output_right.data()};
  assert(host.ProcessPlanar(input, output, static_cast<std::uint32_t>(kFrames)));
  assert(std::abs(output_left[0]) <= 1e-6F);
  assert(std::abs(output_right[0]) <= 1e-6F);
  assert(output_left[0] != input_left[0] && output_right[0] != input_right[0]);
  host.Stop();
}

std::vector<std::uint8_t> InstrumentEvents() {
  std::vector<std::uint8_t> payload;
  AppendLeU32(payload, 2);
  AppendLeU64(payload, 1);
  AppendLeU64(payload, 1);
  AppendLeU64(payload, 1);
  AppendLeU32(payload, 1);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 60);
  AppendLeFloat(payload, 0.9F);
  AppendLeU64(payload, 1);
  AppendLeU64(payload, 1);
  AppendLeU64(payload, 2);
  AppendLeU32(payload, 1);
  AppendLeU32(payload, 12'000);
  AppendLeU32(payload, DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 60);
  AppendLeFloat(payload, 0.0F);
  return payload;
}

std::array<std::uint8_t, 32> Fingerprint(const std::string_view value) {
  std::array<std::uint8_t, 32> result{};
  for (std::size_t index = 0; index < result.size(); ++index) {
    result[index] = static_cast<std::uint8_t>(
      std::stoul(std::string(value.substr(index * 2, 2)), nullptr, 16)
    );
  }
  return result;
}

daw::audio_host_macos::NativeVstAttachment ValhallaAttachment(const std::uint64_t graph_node_id) {
  auto attachment = daw::audio_host_macos::NativeVstAttachment{
    .graph_node_id = graph_node_id,
    .instance_id = "11111111-1111-4111-8111-111111111111",
    .class_id = kClassId,
    .vendor_id = kVendorId,
    .canonical_bundle_path = kBundlePath,
    .canonical_executable_path = kExecutablePath,
    .architecture = 1,
    .scanner_catalog_version = 2,
    .role = daw::audio_host_macos::NativeVstRole::kEffect,
    .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .declared_latency_frames = 0,
    .transport_latency_frames = static_cast<std::uint32_t>(kFrames),
    .playback_enabled = true,
    .transport = {
      .slot_count = 2,
      .maximum_frames = static_cast<std::uint32_t>(kFrames),
      .input_channels = 2,
      .output_channels = 2,
      .maximum_events_per_block = 128,
    },
  };
  attachment.bundle_fingerprint = Fingerprint(kBundleFingerprint);
  attachment.binary_fingerprint = Fingerprint(kBinaryFingerprint);
  return attachment;
}

std::vector<float> InputPcm() {
  std::vector<float> input(kFrames * 2);
  for (std::size_t frame = 0; frame < kFrames; ++frame) {
    const float value = static_cast<float>(
      0.25 * std::sin(2.0 * 3.141592653589793 * 440.0 * static_cast<double>(frame) / kSampleRate)
    );
    input[frame] = value;
    input[kFrames + frame] = value;
  }
  return input;
}

struct RenderResult {
  std::vector<float> output;
  daw::audio_host_macos::Diagnostics diagnostics{};
  std::optional<daw::audio_host_macos::NativeVstWorkerHealth> worker_health;
  std::uint32_t worker_latency_frames = 0;
  bool worker_faulted = false;
};

RenderResult Render(const bool active, const bool instrument, const std::vector<float>& input) {
  const auto graph_bytes = GraphSnapshot(instrument, active);
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = kSampleRate,
    .max_frames_per_block = static_cast<std::uint32_t>(kFrames),
    .channel_count = 2,
    .revision = 1,
  }));
  if (active) assert(host.AttachNativeVst(ValhallaAttachment(instrument ? 1 : 2)));
  const auto graph_status = host.PrepareGraphRevision(2, graph_bytes);
  assert(graph_status.code == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  assert(host.PublishGraphRevision(2).code == daw::audio_host_macos::GraphRevisionStatusCode::kPublished);
  assert(host.SetTransport(1, true, 0));
  assert(host.StartDiagnosticMode());
  std::this_thread::sleep_for(std::chrono::milliseconds(500));
  constexpr std::size_t kBlocks = 32;
  const std::size_t total_frames = kFrames * kBlocks;
  std::vector<float> output(total_frames * 2);
  for (std::size_t block = 0; block < kBlocks; ++block) {
    std::vector<float> block_input = input;
    const float block_gain = block % 2 == 0 ? 1.0F : 0.2F;
    for (float& sample : block_input) sample *= block_gain;
    const std::array<const float*, 2> input_planes{block_input.data(), block_input.data() + kFrames};
    const std::array<float*, 2> output_planes{
      output.data() + block * kFrames,
      output.data() + total_frames + block * kFrames,
    };
    if (instrument && block == 0) assert(host.QueueInstrumentEvents(InstrumentEvents()));
    assert(host.ProcessPlanar(input_planes, output_planes, static_cast<std::uint32_t>(kFrames)));
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  std::optional<std::uint32_t> worker_latency_frames;
  bool worker_faulted = false;
  std::atomic<bool> notifications_running = false;
  host.WakeWorkerNotificationWait();
  while (const auto notification = host.WaitForWorkerNotification(&notifications_running)) {
    if (notification->kind == daw::audio_host_macos::WorkerNotificationKind::kLatency) {
      worker_latency_frames = notification->value;
    }
    if (notification->kind == daw::audio_host_macos::WorkerNotificationKind::kFault
      || notification->kind == daw::audio_host_macos::WorkerNotificationKind::kMiss
      || notification->kind == daw::audio_host_macos::WorkerNotificationKind::kRestart) {
      worker_faulted = true;
    }
  }
  const auto diagnostics = host.diagnostics();
  const auto worker_health = active
    ? host.NativeVstHealth("11111111-1111-4111-8111-111111111111")
    : std::nullopt;
  if (active) assert(worker_health && *worker_health == daw::audio_host_macos::NativeVstWorkerHealth::kReady);
  host.Stop();
  return {
    .output = std::move(output),
    .diagnostics = diagnostics,
    .worker_health = worker_health,
    .worker_latency_frames = worker_latency_frames.value_or(kFrames),
    .worker_faulted = worker_faulted,
  };
}

std::string Sha256(const std::vector<float>& samples) {
  std::array<std::uint8_t, CC_SHA256_DIGEST_LENGTH> digest{};
  CC_SHA256(
    reinterpret_cast<const std::uint8_t*>(samples.data()),
    static_cast<CC_LONG>(samples.size() * sizeof(float)),
    digest.data()
  );
  constexpr char hex[] = "0123456789abcdef";
  std::string result;
  result.reserve(digest.size() * 2);
  for (const auto byte : digest) {
    result.push_back(hex[byte >> 4U]);
    result.push_back(hex[byte & 0x0FU]);
  }
  return result;
}

double Rms(const std::vector<float>& samples) {
  double sum = 0.0;
  for (const float sample : samples) sum += static_cast<double>(sample) * sample;
  return std::sqrt(sum / samples.size());
}

double RmsRange(const std::vector<float>& samples, const std::size_t offset, const std::size_t count) {
  assert(offset + count <= samples.size());
  double sum = 0.0;
  for (std::size_t index = offset; index < offset + count; ++index) {
    sum += static_cast<double>(samples[index]) * samples[index];
  }
  return std::sqrt(sum / count);
}

double DifferenceRms(const std::vector<float>& left, const std::vector<float>& right) {
  assert(left.size() == right.size());
  double sum = 0.0;
  for (std::size_t index = 0; index < left.size(); ++index) {
    const double difference = static_cast<double>(left[index]) - right[index];
    sum += difference * difference;
  }
  return std::sqrt(sum / left.size());
}

}  // namespace

int main() {
  AssertMultipleSourceGraphPublishes();
  if (!std::filesystem::is_regular_file(kExecutablePath)) {
    std::cout << "SKIP: installed ValhallaSupermassive VST3 is unavailable\n";
    return 0;
  }
  const auto input = InputPcm();
  const auto bypass = Render(false, false, input);
  const auto active = Render(true, false, input);
  const auto synth_bypass = Render(false, true, input);
  const auto synth_active = Render(true, true, input);
  const auto diff = DifferenceRms(bypass.output, active.output);
  const auto synth_diff = DifferenceRms(synth_bypass.output, synth_active.output);
  assert(Rms(bypass.output) > 1.0e-3);
  assert(Rms(active.output) > 1.0e-3);
  assert(RmsRange(active.output, 0, kFrames) < 1.0e-9);
  assert(diff > 1.0e-4);
  assert(Rms(synth_bypass.output) > 1.0e-3);
  assert(Rms(synth_active.output) > 1.0e-3);
  assert(synth_diff > 1.0e-4);
  assert(!active.worker_faulted && !synth_active.worker_faulted);
  std::cout << "real_plugin=ValhallaSupermassive"
            << " input_sha256=" << Sha256(input)
            << " audio_bypass_sha256=" << Sha256(bypass.output)
            << " audio_active_sha256=" << Sha256(active.output)
            << " audio_bypass_rms=" << Rms(bypass.output)
            << " audio_active_rms=" << Rms(active.output)
            << " audio_diff_rms=" << diff
            << " audio_graph_revision=" << active.diagnostics.active_revision
            << " audio_worker_health=" << static_cast<std::uint32_t>(*active.worker_health)
            << " audio_worker_latency_frames=" << active.worker_latency_frames
            << " synth_bypass_sha256=" << Sha256(synth_bypass.output)
            << " synth_active_sha256=" << Sha256(synth_active.output)
            << " synth_bypass_rms=" << Rms(synth_bypass.output)
            << " synth_active_rms=" << Rms(synth_active.output)
            << " synth_diff_rms=" << synth_diff
            << " synth_graph_revision=" << synth_active.diagnostics.active_revision
            << " synth_worker_health=" << static_cast<std::uint32_t>(*synth_active.worker_health)
            << " synth_worker_latency_frames=" << synth_active.worker_latency_frames
            << " transport_latency_frames=" << kFrames << '\n';
  return 0;
}
