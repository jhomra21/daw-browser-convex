#include "daw/audio_host_macos.h"
#include "daw/audio_core.h"
#include "daw/audio_core_instrument_wire.h"

#include <array>
#include <cassert>
#include <cstdint>
#include <cstring>
#include <cmath>
#include <optional>
#include <span>
#include <string_view>
#include <sys/wait.h>
#include <unistd.h>
#include <vector>

namespace {

void AppendU32(std::vector<std::uint8_t>& bytes, const std::uint32_t value) {
  bytes.push_back(static_cast<std::uint8_t>(value >> 24U));
  bytes.push_back(static_cast<std::uint8_t>(value >> 16U));
  bytes.push_back(static_cast<std::uint8_t>(value >> 8U));
  bytes.push_back(static_cast<std::uint8_t>(value));
}

void AppendU64(std::vector<std::uint8_t>& bytes, const std::uint64_t value) {
  for (int index = 7; index >= 0; --index) bytes.push_back(static_cast<std::uint8_t>(value >> (index * 8)));
}

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

void AppendLeDouble(std::vector<std::uint8_t>& bytes, const double value) {
  std::uint64_t encoded = 0;
  std::memcpy(&encoded, &value, sizeof(encoded));
  AppendLeU64(bytes, encoded);
}

void AppendLeFloat(std::vector<std::uint8_t>& bytes, const float value) {
  std::uint32_t encoded = 0;
  std::memcpy(&encoded, &value, sizeof(encoded));
  AppendLeU32(bytes, encoded);
}

void AppendLeString(std::vector<std::uint8_t>& bytes, const std::string_view value) {
  AppendLeU32(bytes, static_cast<std::uint32_t>(value.size()));
  bytes.insert(bytes.end(), value.begin(), value.end());
}

void AppendString(std::vector<std::uint8_t>& bytes, const std::string_view value) {
  AppendU32(bytes, static_cast<std::uint32_t>(value.size()));
  bytes.insert(bytes.end(), value.begin(), value.end());
}

bool WriteAll(const int descriptor, const std::span<const std::uint8_t> bytes) {
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    const auto written = write(descriptor, bytes.data() + offset, bytes.size() - offset);
    if (written <= 0) return false;
    offset += static_cast<std::size_t>(written);
  }
  return true;
}

bool ReadAll(const int descriptor, std::span<std::uint8_t> bytes) {
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    const auto read_bytes = read(descriptor, bytes.data() + offset, bytes.size() - offset);
    if (read_bytes <= 0) return false;
    offset += static_cast<std::size_t>(read_bytes);
  }
  return true;
}

std::uint32_t ReadU32(const std::uint8_t* bytes) {
  return (static_cast<std::uint32_t>(bytes[0]) << 24U) | (static_cast<std::uint32_t>(bytes[1]) << 16U)
    | (static_cast<std::uint32_t>(bytes[2]) << 8U) | static_cast<std::uint32_t>(bytes[3]);
}

std::optional<daw::audio_host_macos::ControlFrame> RoundTrip(
  const int input,
  const int output,
  const daw::audio_host_macos::ControlType type,
  const std::span<const std::uint8_t> payload = {}
) {
  const auto request = daw::audio_host_macos::EncodeControlFrame(type, payload);
  if (!WriteAll(input, request)) return std::nullopt;
  std::array<std::uint8_t, daw::audio_host_macos::kControlFrameHeaderBytes> header{};
  if (!ReadAll(output, header)) return std::nullopt;
  const auto payload_size = ReadU32(header.data() + 12);
  std::vector<std::uint8_t> response(header.begin(), header.end());
  response.resize(response.size() + payload_size);
  if (payload_size != 0 && !ReadAll(output, {response.data() + header.size(), payload_size})) return std::nullopt;
  return daw::audio_host_macos::DecodeControlFrame(response);
}

bool IsAck(
  const std::optional<daw::audio_host_macos::ControlFrame>& response,
  const daw::audio_host_macos::ControlType request,
  const bool success
) {
  return response && response->type == daw::audio_host_macos::ControlType::kAck
    && response->payload.size() >= 8 && response->payload.size() <= 264
    && ReadU32(response->payload.data()) == static_cast<std::uint32_t>(request)
    && ReadU32(response->payload.data() + 4) == static_cast<std::uint32_t>(success);
}

// The status word of a negative ACK, or nullopt if the frame is not an ACK for `request`.
std::optional<std::uint32_t> AckStatusWord(
  const std::optional<daw::audio_host_macos::ControlFrame>& response,
  const daw::audio_host_macos::ControlType request
) {
  if (!response || response->type != daw::audio_host_macos::ControlType::kAck || response->payload.size() < 8
    || ReadU32(response->payload.data()) != static_cast<std::uint32_t>(request)) return std::nullopt;
  return ReadU32(response->payload.data() + 4);
}

// A host that has no audio session answers delivery requests with kUnavailable, not kRefused, whatever its text says.
void TestUnavailableAckStatus(const char* const executable) {
  using daw::audio_host_macos::ControlAckStatus;
  using daw::audio_host_macos::ControlType;
  int input[2]{};
  int output[2]{};
  assert(pipe(input) == 0 && pipe(output) == 0);
  const auto child = fork();
  assert(child >= 0);
  if (child == 0) {
    close(input[1]);
    close(output[0]);
    assert(dup2(input[0], STDIN_FILENO) >= 0);
    assert(dup2(output[1], STDOUT_FILENO) >= 0);
    close(input[0]);
    close(output[1]);
    execl(executable, executable, nullptr);
    _exit(127);
  }
  close(input[0]);
  close(output[1]);
  // A count with no events behind it is never admitted, so each request is a negative ACK on a host with no core.
  const std::vector<std::uint8_t> truncated_batch{1, 0, 0, 0};
  for (const auto type : {ControlType::kParameterEvents, ControlType::kMidiEvents, ControlType::kInstrumentStates}) {
    const auto response = RoundTrip(input[1], output[0], type, truncated_batch);
    assert(AckStatusWord(response, type) == static_cast<std::uint32_t>(ControlAckStatus::kUnavailable));
  }
  close(input[1]);
  close(output[0]);
  int status = 0;
  assert(waitpid(child, &status, 0) == child);
}

std::vector<std::uint8_t> Attachment() {
  std::vector<std::uint8_t> payload;
  AppendString(payload, "b0c4db1e-bd48-46d4-a4bc-f5ad1fe6c6f1");
  AppendString(payload, "0123456789abcdef0123456789abcdef");
  AppendString(payload, "Example Vendor");
  AppendString(payload, "/private/catalog/Example.vst3");
  AppendString(payload, "/private/catalog/Example.vst3/Contents/MacOS/Example");
  AppendU32(payload, 0);
  AppendU32(payload, 0);
  AppendU64(payload, 17);
  payload.push_back(1);
  payload.insert(payload.end(), 32, 1);
  payload.insert(payload.end(), 32, 2);
  AppendU32(payload, 2);
  payload.insert(payload.end(), {1, 2, 2, 1, 1});
  AppendU32(payload, 32);
  AppendU32(payload, 0xffff'ffffU);
  AppendU32(payload, 4);
  AppendU32(payload, 2);
  AppendU32(payload, 4);
  AppendU32(payload, 2);
  AppendU32(payload, 2);
  AppendU32(payload, 128);
  AppendU32(payload, 0);
  AppendU32(payload, 0);
  AppendU32(payload, 0);
  AppendU32(payload, 2);
  AppendU32(payload, 7);
  AppendU32(payload, 8);
  return payload;
}

std::vector<std::uint8_t> Configure() {
  std::vector<std::uint8_t> payload;
  AppendU32(payload, 48'000);
  AppendU32(payload, 512);
  AppendU32(payload, 2);
  AppendU32(payload, 1);
  AppendString(payload, "coreaudio:diagnostic");
  return payload;
}

std::vector<std::uint8_t> Transport(const std::uint32_t epoch, const bool running, const std::int64_t frame) {
  std::vector<std::uint8_t> payload;
  AppendU32(payload, epoch);
  payload.push_back(running ? 1 : 0);
  payload.insert(payload.end(), {0, 0, 0});
  AppendU64(payload, static_cast<std::uint64_t>(frame));
  AppendU64(payload, epoch);
  return payload;
}

std::vector<std::uint8_t> VstParameterEvents() {
  std::vector<std::uint8_t> payload;
  AppendLeString(payload, "b0c4db1e-bd48-46d4-a4bc-f5ad1fe6c6f1");
  AppendLeU32(payload, 1);
  AppendLeU32(payload, 7);
  AppendLeU32(payload, 0);
  AppendLeDouble(payload, 0.5);
  return payload;
}

std::vector<std::uint8_t> VstMidiEvents() {
  std::vector<std::uint8_t> payload;
  AppendLeString(payload, "b0c4db1e-bd48-46d4-a4bc-f5ad1fe6c6f1");
  AppendLeU32(payload, 1);
  AppendLeU32(payload, 0);
  payload.insert(payload.end(), {0x90, 60, 127, 0});
  return payload;
}

std::vector<std::uint8_t> InstrumentEvents() {
  std::vector<std::uint8_t> payload;
  AppendLeU32(payload, 1);
  AppendLeU64(payload, 17);
  AppendLeU64(payload, 1);
  AppendLeU64(payload, 1);
  AppendLeU32(payload, 1);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 1);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 60);
  AppendLeFloat(payload, 1.0F);
  return payload;
}

std::vector<std::uint8_t> InstrumentGraph(const std::uint32_t kind = DAW_AUDIO_INSTRUMENT_KIND_SYNTH) {
  std::vector<std::uint8_t> graph;
  AppendLeU32(graph, DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION);
  AppendLeU32(graph, 1);
  AppendLeU32(graph, 2);
  AppendLeU32(graph, 1);
  AppendLeU32(graph, 0);
  AppendLeU32(graph, 0);
  for (const auto id : {17U, 18U}) {
    AppendLeU64(graph, id);
    AppendLeU32(graph, id == 17 ? 2 : 6); // Graph envelope instrument/master kinds.
    AppendLeU32(graph, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
    AppendLeU32(graph, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
    AppendLeU32(graph, 0);
    AppendLeU32(graph, 0);
    AppendLeU32(graph, id == 17 ? kind : 0);
    AppendLeU32(graph, id == 17 ? 1 : 0);
    AppendLeU32(graph, id == 17 ? 2 : 0);
    AppendLeU32(graph, 0); // No declared parameter targets.
    for (unsigned field = 0; field < 16; ++field) AppendLeU32(graph, 0);
    AppendLeU64(graph, 0);
    AppendLeFloat(graph, 0);
    AppendLeFloat(graph, 0);
    AppendLeU32(graph, 0);
    AppendLeU32(graph, 0);
  }
  AppendLeU64(graph, 1);
  AppendLeU64(graph, 17);
  AppendLeU64(graph, 18);
  AppendLeU64(graph, 0);
  AppendLeFloat(graph, 1);
  AppendLeU32(graph, DAW_AUDIO_GRAPH_EDGE_POST_FADER);
  AppendLeU32(graph, 0);
  AppendLeU32(graph, 0);
  std::vector<std::uint8_t> framed;
  AppendU64(framed, 1);
  AppendU32(framed, static_cast<std::uint32_t>(graph.size()));
  framed.insert(framed.end(), graph.begin(), graph.end());
  return framed;
}

std::vector<std::uint8_t> ScheduleWindow(const bool invalid_target) {
  std::vector<std::uint8_t> payload;
  AppendLeU32(payload, 1);
  AppendLeU32(payload, 1);
  AppendLeU64(payload, 1);
  AppendLeU64(payload, 0);
  AppendLeU64(payload, 128);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 1);
  AppendLeU32(payload, 1);
  AppendLeU32(payload, 1);
  for (unsigned field = 0; field < 3; ++field) AppendLeU32(payload, 0);
  AppendLeU32(payload, 0);
  AppendLeU64(payload, 0);
  AppendLeU64(payload, 17);
  AppendLeU64(payload, 1);
  AppendLeU64(payload, 1);
  AppendLeU32(payload, 1);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, invalid_target ? DAW_AUDIO_INSTRUMENT_EVENT_PARAMETER : DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, invalid_target ? 127 : 60);
  AppendLeFloat(payload, 0.5F);
  return payload;
}

std::vector<std::uint8_t> GranularState() {
  std::vector<std::uint8_t> payload;
  AppendLeU32(payload, 1); AppendLeU64(payload, 17); AppendLeU32(payload, 4);
  AppendLeU32(payload, 60); AppendLeU32(payload, 0); AppendLeU32(payload, 0);
  AppendLeU32(payload, 1); AppendLeU64(payload, (1ULL << 32) | 1);
  AppendLeU32(payload, 1); AppendLeU32(payload, 16); AppendLeU32(payload, 0); AppendLeU32(payload, 0);
  for (const float value : {100.0F, 10.0F, 0.98F, 1.0F, 0.0F, 1.0F, 0.5F})
    AppendLeFloat(payload, value);
  AppendLeU32(payload, 0);
  return payload;
}

void TestFramedInstrumentPages(const int input, const int output) {
  using daw::audio_host_macos::ControlType;
  constexpr unsigned frames = 200'000;
  const auto send = [&](const ControlType type, const std::vector<std::uint8_t>& payload, const bool success) {
    const auto response = RoundTrip(input, output, type, payload);
    assert(IsAck(response, type, success));
    return response;
  };
  // Timeline assets can be installed before a lexically earlier sample region.
  // Leave the timeline mapping empty to detect accidental core-slot references.
  std::vector<std::uint8_t> timeline;
  AppendU32(timeline, 2); AppendU64(timeline, frames); AppendU32(timeline, 48000);
  AppendU32(timeline, 2); AppendU64(timeline, 0);
  send(ControlType::kMappedAssetCreate, timeline, true);
  std::vector<std::uint8_t> create;
  AppendU32(create, 1); AppendU64(create, frames); AppendU32(create, 48000);
  AppendU32(create, 2); AppendU64(create, 0);
  send(ControlType::kMappedAssetCreate, create, true);
  std::vector<std::uint8_t> prepare;
  AppendU32(prepare, 1); AppendU64(prepare, 0); AppendU64(prepare, frames);
  send(ControlType::kMappedAssetPrepareRange, prepare, false);
  send(ControlType::kGraphSnapshot, InstrumentGraph(DAW_AUDIO_INSTRUMENT_KIND_GRANULAR), true);
  const auto missing = send(ControlType::kInstrumentStates, GranularState(), false);
  assert(std::string_view(reinterpret_cast<const char*>(missing->payload.data() + 8),
    missing->payload.size() - 8).find("incomplete") != std::string_view::npos);
  for (unsigned start = 0; start < frames; start += 16384) {
    const auto count = std::min(16384U, frames - start);
    std::vector<std::uint8_t> page;
    AppendU32(page, 1); AppendU64(page, start); AppendU32(page, count);
    for (unsigned channel = 0; channel < 2; ++channel)
      for (unsigned frame = 0; frame < count; ++frame) AppendLeFloat(page, channel ? -0.2F : 0.3F);
    if (start == 0) {
      auto malformed = page;
      malformed.pop_back();
      send(ControlType::kMappedAssetWritePage, malformed, false);
    }
    send(ControlType::kMappedAssetWritePage, page, true);
  }
  send(ControlType::kMappedAssetPrepareRange, prepare, true);
  send(ControlType::kInstrumentStates, GranularState(), true);
  auto unknown = GranularState();
  unknown[32] = 63;
  const auto rejected = send(ControlType::kInstrumentStates, unknown, false);
  assert(std::string_view(reinterpret_cast<const char*>(rejected->payload.data() + 8),
    rejected->payload.size() - 8) == "instrument sample session asset is not installed");
  std::vector<std::uint8_t> rewrite;
  AppendU32(rewrite, 1); AppendU64(rewrite, 0); AppendU32(rewrite, 1);
  AppendLeFloat(rewrite, 0.1F); AppendLeFloat(rewrite, -0.1F);
  send(ControlType::kMappedAssetWritePage, rewrite, false);
}

void TestCheckpoint3AssetCapacityWire(const int input, const int output) {
  using daw::audio_host_macos::ControlType;
  const auto install = [&](const unsigned id, const bool success) {
    std::vector<std::uint8_t> payload;
    AppendU32(payload, id); AppendU32(payload, 4); AppendU32(payload, 48000);
    AppendU32(payload, 2); AppendU64(payload, id);
    for (unsigned sample = 0; sample < 8; ++sample) AppendLeFloat(payload, 0.25F);
    const auto response = RoundTrip(input, output, ControlType::kAssetInstall, payload);
    assert(IsAck(response, ControlType::kAssetInstall, success));
    return response;
  };
  for (unsigned id = 1; id <= daw::audio_host_macos::kMaximumInstalledAssets; ++id) install(id, true);
  install(1, true); // Same session ID is retained, not installed twice.
  const auto full = install(65, false);
  assert(std::string_view(reinterpret_cast<const char*>(full->payload.data() + 8),
    full->payload.size() - 8) == "asset-capacity-exceeded");
  const auto release = [&](const unsigned id) {
    std::vector<std::uint8_t> payload; AppendU32(payload, id);
    assert(IsAck(RoundTrip(input, output, ControlType::kAssetRelease, payload), ControlType::kAssetRelease, true));
  };
  release(1); install(65, true);
  for (unsigned id = 2; id <= 65; ++id) release(id);
}

// Offline failure cases: a provider stops before full coverage, cancellation
// closes the job before Start, and neither may publish a successful terminal.
// Success compares every child-host sample with independent contiguous core PCM,
// including a rebased custom-range note, release tail and non-block-aligned end.
void TestOfflineInstrumentPages(const char* executable, const std::uint32_t kind, const unsigned failure = 0) {
  using daw::audio_host_macos::ControlType;
  constexpr unsigned frames = 200'000, total = 16003, block = 128, note_on = 97, note_off = 12097;
  int input[2]{}, output[2]{};
  assert(pipe(input) == 0 && pipe(output) == 0);
  const auto child = fork();
  assert(child >= 0);
  if (child == 0) {
    close(input[1]); close(output[0]);
    assert(dup2(input[0], STDIN_FILENO) >= 0 && dup2(output[1], STDOUT_FILENO) >= 0);
    close(input[0]); close(output[1]);
    execl(executable, executable, nullptr);
    _exit(127);
  }
  close(input[0]); close(output[1]);
  const auto send = [&](const ControlType type, const std::vector<std::uint8_t>& payload, const bool success = true) {
    assert(IsAck(RoundTrip(input[1], output[0], type, payload), type, success));
  };
  std::vector<std::uint8_t> configure;
  for (const auto value : {48000U, block, 2U, 1U}) AppendU32(configure, value);
  send(ControlType::kOfflineConfigure, configure);
  std::vector<float> pcm(frames * 2);
  std::vector<float> timeline_pcm(frames * 2);
  for (unsigned frame = 0; frame < frames; ++frame) {
    pcm[frame] = 0.2F + static_cast<float>(frame % 97) / 500;
    pcm[frames + frame] = -0.3F + static_cast<float>(frame % 113) / 600;
    timeline_pcm[frame] = -0.7F + static_cast<float>(frame % 31) / 200;
    timeline_pcm[frames + frame] = 0.6F - static_cast<float>(frame % 29) / 180;
  }
  // Install a fully hydrated, unrelated timeline asset first. Its distinct
  // PCM makes a mistaken core-handle lookup fail the sample-by-sample oracle.
  std::vector<std::uint8_t> timeline_create;
  AppendU32(timeline_create, 2); AppendU64(timeline_create, frames);
  AppendU32(timeline_create, 48000); AppendU32(timeline_create, 2); AppendU64(timeline_create, 0);
  send(ControlType::kMappedAssetCreate, timeline_create);
  for (unsigned start = 0; start < frames; start += 16384) {
    const auto count = std::min(16384U, frames - start);
    std::vector<std::uint8_t> page;
    AppendU32(page, 2); AppendU64(page, start); AppendU32(page, count);
    for (unsigned channel = 0; channel < 2; ++channel)
      for (unsigned frame = 0; frame < count; ++frame)
        AppendLeFloat(page, timeline_pcm[channel * frames + start + frame]);
    send(ControlType::kMappedAssetWritePage, page);
  }
  std::vector<std::uint8_t> create;
  AppendU32(create, 1); AppendU64(create, frames); AppendU32(create, 48000); AppendU32(create, 2); AppendU64(create, 0);
  send(ControlType::kMappedAssetCreate, create);
  auto state = GranularState();
  if (kind != DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) {
    state.clear();
    AppendLeU32(state, 1); AppendLeU64(state, 17); AppendLeU32(state, kind);
    AppendLeU32(state, daw::audio_core_wire::kSamplerStateBytes);
    AppendLeU32(state, daw::audio_core_wire::kSampleZoneBytes); AppendLeU32(state, 0);
    std::vector<std::uint8_t> sampler(daw::audio_core_wire::kSamplerStateBytes, 0);
    sampler[0] = 1; sampler[4] = 1;
    const auto put = [&](unsigned offset, float value) { std::memcpy(sampler.data() + offset, &value, 4); };
    put(16, 1); put(20, 10); put(32, 1000); put(36, 0.7F); put(64, 1);
    state.insert(state.end(), sampler.begin(), sampler.end());
    AppendLeU64(state, (1ULL << 32) | 1);
    for (const auto value : {60U, 60U, 1U, 127U, 60U}) AppendLeU32(state, value);
    AppendLeFloat(state, 0); AppendLeFloat(state, 0.8F); AppendLeFloat(state, 0);
    for (const auto value : {0U, 0U, static_cast<unsigned>(DAW_AUDIO_SAMPLE_PLAYBACK_CROSSFADE_LOOP), 16380U, frames, 16380U, 16420U, 8U, 0U, 0U})
      AppendLeU32(state, value);
  }
  for (unsigned start = 0; start < frames; start += 16384) {
    const auto count = std::min(16384U, frames - start);
    std::vector<std::uint8_t> page;
    AppendU32(page, 1); AppendU64(page, start); AppendU32(page, count);
    for (unsigned channel = 0; channel < 2; ++channel)
      for (unsigned frame = 0; frame < count; ++frame) AppendLeFloat(page, pcm[channel * frames + start + frame]);
    send(ControlType::kMappedAssetWritePage, page);
    if (failure != 0) break;
  }
  const auto graph = InstrumentGraph(kind);
  if (failure != 0) {
    send(ControlType::kGraphSnapshot, graph);
    if (failure == 1) send(ControlType::kInstrumentStates, state, false);
    close(input[1]); // Provider failure/cancel ends this child without OfflineStart.
    std::array<std::uint8_t, 16> remaining{};
    assert(read(output[0], remaining.data(), remaining.size()) == 0);
    close(output[0]);
    int status = 0;
    assert(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
    return;
  }
  std::vector<std::uint8_t> prepare;
  AppendU32(prepare, 1); AppendU64(prepare, 0); AppendU64(prepare, frames);
  send(ControlType::kMappedAssetPrepareRange, prepare);
  send(ControlType::kGraphSnapshot, graph);
  send(ControlType::kInstrumentStates, state);
  send(ControlType::kTransport, Transport(1, true, 0));
  std::vector<std::uint8_t> schedule;
  AppendLeU32(schedule, 1); AppendLeU32(schedule, 1); AppendLeU64(schedule, 1);
  AppendLeU64(schedule, 0); AppendLeU64(schedule, total);
  for (const auto value : {0U, 1U, 1U, 2U, 0U, 0U, 0U}) AppendLeU32(schedule, value);
  AppendLeU32(schedule, 0); AppendLeU64(schedule, 0);
  for (unsigned index = 0; index < 2; ++index) {
    AppendLeU64(schedule, 17); AppendLeU64(schedule, 1); AppendLeU64(schedule, index + 1);
    AppendLeU32(schedule, 1); AppendLeU32(schedule, index == 0 ? note_on : note_off);
    AppendLeU32(schedule, index == 0 ? DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON : DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF);
    AppendLeU32(schedule, 0); AppendLeU32(schedule, 60); AppendLeFloat(schedule, index == 0 ? 0.5F : 0);
  }
  send(ControlType::kScheduleWindow, schedule);
  daw_audio_core_handle reference = 0;
  const daw_audio_core_config config{.abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .max_frames_per_block = block, .max_channels = 2, .max_assets = 1, .sample_rate_hz = 48000};
  assert(daw_audio_core_create(&config, &reference) == DAW_AUDIO_CORE_OK);
  const std::array<const float*, 2> planes{pcm.data(), pcm.data() + frames};
  const daw_audio_asset_descriptor descriptor{.abi_version = DAW_AUDIO_CORE_ABI_VERSION, .revision = 1,
    .byte_length = pcm.size() * sizeof(float), .frame_count = frames, .sample_rate_hz = 48000,
    .channel_count = 2, .planes = planes.data()};
  daw_audio_asset_handle asset = 0;
  assert(daw_audio_core_create_asset(reference, &descriptor, &asset) == DAW_AUDIO_CORE_OK);
  assert(daw_audio_core_prepare_graph_bytes(reference, graph.data() + 12, graph.size() - 12) == DAW_AUDIO_CORE_OK);
  if (kind == DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) {
    const daw_audio_granular_state decoded{.version = 1, .asset = asset, .seed = 1, .max_grains = 16,
      .window_shape = 0, .freeze = 0, .grain_size_ms = 100, .density_hz = 10,
      .position = 0.98F, .spray = 1, .pitch_semitones = 0, .reverse_probability = 1, .stereo_spread = 0.5F};
    assert(daw_audio_core_configure_granular(reference, 17, &decoded) == DAW_AUDIO_CORE_OK);
  } else {
    daw_audio_sampler_state decoded{}; daw_audio_sample_zone zone{};
    assert(daw::audio_core_wire::DecodeSamplerState(std::span(state).subspan(28, daw::audio_core_wire::kSamplerStateBytes), &decoded));
    assert(daw::audio_core_wire::DecodeSampleZone(std::span(state).subspan(28 + daw::audio_core_wire::kSamplerStateBytes), &zone));
    zone.asset = asset;
    assert(daw_audio_core_configure_sampler(reference, 17, &decoded, &zone) == DAW_AUDIO_CORE_OK);
  }
  assert(daw_audio_core_publish(reference, 1) == DAW_AUDIO_CORE_OK);
  const daw_audio_transport_state transport{.epoch = 1, .running = 1, .frame = 0};
  assert(daw_audio_core_set_transport(reference, &transport) == DAW_AUDIO_CORE_OK);
  std::vector<std::uint8_t> start;
  AppendU64(start, total); AppendU32(start, block); AppendU32(start, 2);
  send(ControlType::kOfflineStart, start);
  unsigned rendered = 0; bool audible = false, tail = false;
  while (rendered < total) {
    std::array<std::uint8_t, 16> header{};
    assert(ReadAll(output[0], header));
    const auto type = ReadU32(header.data() + 8);
    std::vector<std::uint8_t> payload(ReadU32(header.data() + 12));
    assert(ReadAll(output[0], payload));
    if (type != static_cast<unsigned>(ControlType::kOfflinePcmChunk)) {
      assert(type != static_cast<unsigned>(ControlType::kOfflineComplete) && type != static_cast<unsigned>(ControlType::kOfflineError));
      continue; // Event-driven telemetry may precede PCM.
    }
    const auto count = ReadU32(payload.data() + 8);
    assert(ReadU32(payload.data() + 4) == rendered && count == std::min(block, total - rendered));
    assert(ReadU32(payload.data() + 12) == 2 && payload.size() == 16 + count * 8);
    std::array<float, block> silence{}, left{}, right{};
    const std::array<const float*, 2> inputs{silence.data(), silence.data()};
    const std::array<float*, 2> outputs{left.data(), right.data()};
    std::vector<daw_audio_instrument_event> events;
    for (const auto frame : {note_on, note_off}) if (frame >= rendered && frame < rendered + count) {
      events.push_back({.node_id = 17, .note_id = 1, .sequence = frame == note_on ? 1U : 2U, .epoch = 1,
        .frame_offset = frame - rendered, .type = frame == note_on ? DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON : DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF,
        .channel = 0, .note = 60, .value = frame == note_on ? 0.5F : 0});
    }
    const daw_audio_core_process_block process{.abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = count,
      .channel_count = 2, .input_bus_count = 1, .inputs = inputs.data(), .outputs = outputs.data(),
      .graph_revision = 1, .transport_epoch = 1, .instrument_event_count = static_cast<unsigned>(events.size()), .instrument_events = events.data()};
    assert(daw_audio_core_process(reference, &process) == DAW_AUDIO_CORE_OK);
    for (unsigned channel = 0; channel < 2; ++channel) for (unsigned frame = 0; frame < count; ++frame) {
      const auto bits = ReadU32(payload.data() + 16 + (channel * count + frame) * 4);
      float value = 0; std::memcpy(&value, &bits, 4);
      assert(std::isfinite(value) && value == outputs[channel][frame]);
      audible = audible || value != 0;
      tail = tail || (rendered + frame > note_off && value != 0);
    }
    rendered += count;
  }
  assert(audible && rendered == total);
  // Granular clears its final note's grains immediately; sampler/drums retain
  // release voices. Both must match the independent reference through the tail.
  assert(kind == DAW_AUDIO_INSTRUMENT_KIND_GRANULAR ? !tail : tail);
  // Drain telemetry until the one successful, exact-length terminal arrives.
  for (;;) {
    std::array<std::uint8_t, 16> header{}; assert(ReadAll(output[0], header));
    std::vector<std::uint8_t> payload(ReadU32(header.data() + 12)); assert(ReadAll(output[0], payload));
    const auto type = ReadU32(header.data() + 8);
    assert(type != static_cast<unsigned>(ControlType::kOfflineError) && type != static_cast<unsigned>(ControlType::kOfflinePcmChunk));
    if (type == static_cast<unsigned>(ControlType::kOfflineComplete)) {
      assert(payload.size() == 8 && ReadU32(payload.data() + 4) == total); break;
    }
  }
  daw_audio_core_destroy(reference);
  close(input[1]);
  std::array<std::uint8_t, 4096> drained{};
  while (read(output[0], drained.data(), drained.size()) > 0) {}
  close(output[0]);
  int status = 0; assert(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
}

}  // namespace

int main(int argc, char* argv[]) {
  assert(argc == 2);
  for (const auto kind : {DAW_AUDIO_INSTRUMENT_KIND_SAMPLER, DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK,
    DAW_AUDIO_INSTRUMENT_KIND_GRANULAR}) TestOfflineInstrumentPages(argv[1], kind);
  TestOfflineInstrumentPages(argv[1], DAW_AUDIO_INSTRUMENT_KIND_GRANULAR, 1);
  TestOfflineInstrumentPages(argv[1], DAW_AUDIO_INSTRUMENT_KIND_GRANULAR, 2);
  TestUnavailableAckStatus(argv[1]);
  int to_host[2]{};
  int from_host[2]{};
  assert(pipe(to_host) == 0 && pipe(from_host) == 0);
  const auto child = fork();
  assert(child >= 0);
  if (child == 0) {
    close(to_host[1]);
    close(from_host[0]);
    assert(dup2(to_host[0], STDIN_FILENO) >= 0);
    assert(dup2(from_host[1], STDOUT_FILENO) >= 0);
    close(to_host[0]);
    close(from_host[1]);
    execl(argv[1], argv[1], nullptr);
    _exit(127);
  }
  close(to_host[0]);
  close(from_host[1]);
  assert(IsAck(RoundTrip(to_host[1], from_host[0], daw::audio_host_macos::ControlType::kTransactionBegin),
    daw::audio_host_macos::ControlType::kTransactionBegin, true));
  const auto attachment = Attachment();
  assert(IsAck(RoundTrip(to_host[1], from_host[0], daw::audio_host_macos::ControlType::kVstAttach, attachment),
    daw::audio_host_macos::ControlType::kVstAttach, true));
  assert(IsAck(RoundTrip(to_host[1], from_host[0], daw::audio_host_macos::ControlType::kVstParameterEvents, VstParameterEvents()),
    daw::audio_host_macos::ControlType::kVstParameterEvents, true));
  assert(IsAck(RoundTrip(to_host[1], from_host[0], daw::audio_host_macos::ControlType::kVstMidiEvents, VstMidiEvents()),
    daw::audio_host_macos::ControlType::kVstMidiEvents, true));
  assert(IsAck(RoundTrip(to_host[1], from_host[0], daw::audio_host_macos::ControlType::kTransactionRollback),
    daw::audio_host_macos::ControlType::kTransactionRollback, true));
  assert(IsAck(RoundTrip(to_host[1], from_host[0], daw::audio_host_macos::ControlType::kTransactionBegin),
    daw::audio_host_macos::ControlType::kTransactionBegin, true));
  std::vector<std::uint8_t> instance_id;
  AppendString(instance_id, "b0c4db1e-bd48-46d4-a4bc-f5ad1fe6c6f1");
  assert(IsAck(RoundTrip(to_host[1], from_host[0], daw::audio_host_macos::ControlType::kVstDetach, instance_id),
    daw::audio_host_macos::ControlType::kVstDetach, false));
  assert(IsAck(RoundTrip(to_host[1], from_host[0], daw::audio_host_macos::ControlType::kTransactionRollback),
    daw::audio_host_macos::ControlType::kTransactionRollback, true));
  assert(IsAck(RoundTrip(to_host[1], from_host[0], daw::audio_host_macos::ControlType::kTransactionBegin),
    daw::audio_host_macos::ControlType::kTransactionBegin, true));
  assert(IsAck(RoundTrip(to_host[1], from_host[0], daw::audio_host_macos::ControlType::kDeviceConfigure, Configure()),
    daw::audio_host_macos::ControlType::kDeviceConfigure, true));
  assert(IsAck(RoundTrip(to_host[1], from_host[0], daw::audio_host_macos::ControlType::kVstAttach, attachment),
    daw::audio_host_macos::ControlType::kVstAttach, true));
  // A detach inside the open transaction reaches the staged host.
  assert(IsAck(RoundTrip(to_host[1], from_host[0], daw::audio_host_macos::ControlType::kVstDetach, instance_id),
    daw::audio_host_macos::ControlType::kVstDetach, true));
  assert(IsAck(RoundTrip(to_host[1], from_host[0], daw::audio_host_macos::ControlType::kVstAttach, attachment),
    daw::audio_host_macos::ControlType::kVstAttach, true));
  assert(IsAck(RoundTrip(to_host[1], from_host[0], daw::audio_host_macos::ControlType::kTransactionCommit),
    daw::audio_host_macos::ControlType::kTransactionCommit, true));
  // With no transaction open, a detach reaches the committed host that holds the instance.
  assert(IsAck(RoundTrip(to_host[1], from_host[0], daw::audio_host_macos::ControlType::kVstDetach, instance_id),
    daw::audio_host_macos::ControlType::kVstDetach, true));
  TestCheckpoint3AssetCapacityWire(to_host[1], from_host[0]);
  const std::vector<std::uint8_t> malformed_state_request{0};
  assert(IsAck(RoundTrip(
    to_host[1],
    from_host[0],
    daw::audio_host_macos::ControlType::kVstStateGet,
    malformed_state_request
  ), daw::audio_host_macos::ControlType::kVstStateGet, false));
  assert(IsAck(RoundTrip(to_host[1], from_host[0], daw::audio_host_macos::ControlType::kTransport, Transport(1, true, 0)),
    daw::audio_host_macos::ControlType::kTransport, false));
  assert(IsAck(RoundTrip(to_host[1], from_host[0], daw::audio_host_macos::ControlType::kTransport, Transport(1, false, 0)),
    daw::audio_host_macos::ControlType::kTransport, true));
  const auto instrument_events = InstrumentEvents();
  // Device configuration alone has no instrument graph target. Reject the
  // request at admission instead of poisoning the next process callback.
  const auto rejected_midi = RoundTrip(to_host[1], from_host[0], daw::audio_host_macos::ControlType::kMidiEvents, instrument_events);
  assert(IsAck(rejected_midi, daw::audio_host_macos::ControlType::kMidiEvents, false));
  // A session exists, so this refusal is on its merits: kRefused, never kUnavailable.
  assert(AckStatusWord(rejected_midi, daw::audio_host_macos::ControlType::kMidiEvents)
    == static_cast<std::uint32_t>(daw::audio_host_macos::ControlAckStatus::kRefused));
  TestFramedInstrumentPages(to_host[1], from_host[0]);
  const auto rejected_schedule = RoundTrip(to_host[1], from_host[0],
    daw::audio_host_macos::ControlType::kScheduleWindow, ScheduleWindow(true));
  assert(IsAck(rejected_schedule, daw::audio_host_macos::ControlType::kScheduleWindow, false));
  const std::string_view schedule_error(
    reinterpret_cast<const char*>(rejected_schedule->payload.data() + 8), rejected_schedule->payload.size() - 8);
  assert(schedule_error == "instrument target is missing or its parameter is unsupported");
  assert(IsAck(RoundTrip(to_host[1], from_host[0], daw::audio_host_macos::ControlType::kScheduleWindow, ScheduleWindow(false)),
    daw::audio_host_macos::ControlType::kScheduleWindow, true));
  std::vector<std::uint8_t> stop_reason;
  AppendString(stop_reason, "protocol-test-stop");
  assert(IsAck(RoundTrip(to_host[1], from_host[0], daw::audio_host_macos::ControlType::kStop, stop_reason),
    daw::audio_host_macos::ControlType::kStop, true));
  close(to_host[1]);
  close(from_host[0]);
  int status = 0;
  assert(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
  return 0;
}
