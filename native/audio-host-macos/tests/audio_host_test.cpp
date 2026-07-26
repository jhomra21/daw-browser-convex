#include "daw/audio_host_macos.h"

#include <array>
#include <cassert>
#include <chrono>
#include <cstring>
#include <limits>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace {

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

std::vector<std::uint8_t> GraphSnapshot(const std::uint32_t revision, const float gain) {
  std::vector<std::uint8_t> payload;
  AppendLeU32(payload, DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION);
  AppendLeU32(payload, revision);
  AppendLeU32(payload, 2);
  AppendLeU32(payload, 1);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 0);
  const auto append_node = [&payload](const std::uint64_t id, const std::uint32_t kind) {
    AppendLeU64(payload, id);
    AppendLeU32(payload, kind);
    AppendLeU32(payload, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
    AppendLeU32(payload, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, 0);
    for (std::size_t field = 0; field < 20; ++field) AppendLeU32(payload, 0);
    AppendLeU64(payload, 0);
    AppendLeFloat(payload, 0.0F);
    AppendLeFloat(payload, 0.0F);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, 0);
  };
  append_node(1, 1);
  append_node(2, 6);
  AppendLeU64(payload, 3);
  AppendLeU64(payload, 1);
  AppendLeU64(payload, 2);
  AppendLeU64(payload, 0);
  AppendLeFloat(payload, gain);
  AppendLeU32(payload, DAW_AUDIO_GRAPH_EDGE_POST_FADER);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 0);
  std::vector<std::uint8_t> frame;
  AppendBeU64(frame, revision);
  AppendBeU32(frame, static_cast<std::uint32_t>(payload.size()));
  frame.insert(frame.end(), payload.begin(), payload.end());
  return frame;
}

void AppendInstanceId(std::vector<std::uint8_t>& bytes, const std::string_view instance_id) {
  AppendLeU32(bytes, static_cast<std::uint32_t>(instance_id.size()));
  bytes.insert(bytes.end(), instance_id.begin(), instance_id.end());
}

void AppendLeDouble(std::vector<std::uint8_t>& bytes, const double value) {
  std::uint64_t encoded = 0;
  std::memcpy(&encoded, &value, sizeof(encoded));
  for (std::size_t index = 0; index < sizeof(encoded); ++index) bytes.push_back(static_cast<std::uint8_t>(encoded >> (index * 8U)));
}

void TestDeviceNamespace() {
  assert(daw::audio_host_macos::CoreAudioDeviceId("BuiltInOutput") == "coreaudio:BuiltInOutput");
  const auto uid = daw::audio_host_macos::CoreAudioDeviceUid("coreaudio:BuiltInOutput");
  assert(uid && *uid == "BuiltInOutput");
  assert(!daw::audio_host_macos::CoreAudioDeviceUid("default"));
  assert(!daw::audio_host_macos::CoreAudioDeviceUid("coreaudio:"));
  assert(!daw::audio_host_macos::SelectOutputDevice("definitely-unavailable-daw-device"));
}

void TestControlFrames() {
  const std::array<std::uint8_t, 3> payload{1, 2, 3};
  const auto encoded = daw::audio_host_macos::EncodeControlFrame(
    daw::audio_host_macos::ControlType::kDiagnostics, payload);
  const auto decoded = daw::audio_host_macos::DecodeControlFrame(encoded);
  assert(decoded && decoded->type == daw::audio_host_macos::ControlType::kDiagnostics);
  assert(decoded->payload == std::vector<std::uint8_t>(payload.begin(), payload.end()));
  const auto transport = daw::audio_host_macos::EncodeControlFrame(
    daw::audio_host_macos::ControlType::kTransport, {});
  const auto decodedTransport = daw::audio_host_macos::DecodeControlFrame(transport);
  assert(decodedTransport && decodedTransport->type == daw::audio_host_macos::ControlType::kTransport);
  const auto transaction = daw::audio_host_macos::EncodeControlFrame(
    daw::audio_host_macos::ControlType::kGraphRollback, {});
  assert(transaction == std::vector<std::uint8_t>({
    0x44, 0x41, 0x57, 0x48,
    0x00, 0x00, 0x00, 0x07,
    0x00, 0x00, 0x00, 0x27,
    0x00, 0x00, 0x00, 0x00,
  }));
  const auto decodedTransaction = daw::audio_host_macos::DecodeControlFrame(transaction);
  assert(decodedTransaction && decodedTransaction->type == daw::audio_host_macos::ControlType::kGraphRollback);
  const auto recording_device_query = daw::audio_host_macos::EncodeControlFrame(
    daw::audio_host_macos::ControlType::kRecordingDeviceQuery, {});
  const auto decoded_recording_device_query = daw::audio_host_macos::DecodeControlFrame(recording_device_query);
  assert(decoded_recording_device_query
    && decoded_recording_device_query->type == daw::audio_host_macos::ControlType::kRecordingDeviceQuery);
  auto malformed = encoded;
  malformed[4] = 2;
  assert(!daw::audio_host_macos::DecodeControlFrame(malformed));
  std::vector<std::uint8_t> oversized(daw::audio_host_macos::kControlFrameHeaderBytes);
  oversized[0] = 0x44;
  oversized[1] = 0x41;
  oversized[2] = 0x57;
  oversized[3] = 0x48;
  oversized[7] = daw::audio_host_macos::kControlProtocolVersion;
  oversized[11] = static_cast<std::uint8_t>(daw::audio_host_macos::ControlType::kAssetInstall);
  oversized[12] = 0x01;
  assert(!daw::audio_host_macos::DecodeControlFrame(oversized));
}

void TestCallbackPlanarBuffersAndSplitting() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  assert(!host.Start());
  assert(host.StartDiagnosticMode());
  std::array<float, 10> left{};
  std::array<float, 10> right{};
  std::array<float, 10> output_left{};
  std::array<float, 10> output_right{};
  for (std::size_t index = 0; index < left.size(); ++index) {
    left[index] = static_cast<float>(index);
    right[index] = -static_cast<float>(index);
  }
  const std::array<const float*, 2> input{left.data(), right.data()};
  const std::array<float*, 2> output{output_left.data(), output_right.data()};
  assert(host.ProcessPlanar(input, output, 10));
  for (std::size_t index = 0; index < left.size(); ++index) {
    assert(output_left[index] == left[index]);
    assert(output_right[index] == right[index]);
  }
  const auto diagnostics = host.diagnostics();
  assert(diagnostics.callbacks == 1);
  assert(diagnostics.split_blocks == 2);
  host.Stop();
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 44100,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 2,
  }));
  assert(host.diagnostics().active_revision == 2);
  assert(host.SetTransport(1, true, 100));
  assert(host.diagnostics().transport_epoch == 1);
  assert(host.Retire(2));
  host.Teardown();
  assert(host.diagnostics().state == daw::audio_host_macos::LifecycleState::kIdle);
}

void TestNativeVstAttachmentBoundsAndLatencyContract() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  const std::array<float, 8> samples{};
  assert(!host.InstallAsset(1, 4, 48000, 2, 0, std::span<const float>(samples.data(), 7)));
  assert(!host.InstallAsset(1, 4, 48000, daw::audio_host_macos::kMaximumAssetChannels + 1, 0, samples));
  auto non_finite_samples = samples;
  non_finite_samples[0] = std::numeric_limits<float>::quiet_NaN();
  assert(!host.InstallAsset(1, 4, 48000, 2, 0, non_finite_samples));
  assert(host.InstallAsset(1, 4, 48000, 2, 0x1234, samples));
  assert(host.diagnostics().installed_assets == 1);
  assert(host.ReleaseAsset(1));
  assert(host.diagnostics().installed_assets == 0);
  assert(host.ReleaseAsset(1));
  for (std::uint32_t asset_id = 2; asset_id <= daw::audio_host_macos::kMaximumInstalledAssets + 1; ++asset_id) {
    assert(host.InstallAsset(asset_id, 4, 48000, 2, 0, samples));
  }
  assert(!host.InstallAsset(daw::audio_host_macos::kMaximumInstalledAssets + 2, 4, 48000, 2, 0, samples));
  host.Teardown();
  daw::audio_host_macos::NativeVstAttachment reference{
    .graph_node_id = 17,
    .instance_id = "b0c4db1e-bd48-46d4-a4bc-f5ad1fe6c6f1",
    .class_id = "class-id",
    .vendor_id = "vendor-id",
    .canonical_bundle_path = "/private/catalog/Example.vst3",
    .canonical_executable_path = "/private/catalog/Example.vst3/Contents/MacOS/Example",
    .architecture = 1,
    .scanner_catalog_version = 2,
    .role = daw::audio_host_macos::NativeVstRole::kEffect,
    .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .declared_latency_frames = 32,
    .transport_latency_frames = 4,
    .transport = {.slot_count = 2, .maximum_frames = 4, .input_channels = 2, .output_channels = 2, .maximum_events_per_block = 128},
  };
  reference.bundle_fingerprint.fill(1);
  reference.binary_fingerprint.fill(2);
  assert(host.AttachNativeVst(reference));
  assert(!host.AttachNativeVst(reference));
  assert(!host.DetachVstReference("class-id"));
  assert(host.DetachVstReference(reference.instance_id));
  reference.binary_fingerprint.fill(0);
  assert(!host.AttachNativeVst(reference));
  reference.binary_fingerprint.fill(2);
  reference.transport_latency_frames = 3;
  assert(!host.AttachNativeVst(reference));
}

void TestNativeVstRuntimeControlBounds() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  constexpr std::string_view instance_id = "b0c4db1e-bd48-46d4-a4bc-f5ad1fe6c6f1";
  daw::audio_host_macos::NativeVstAttachment attachment{
    .graph_node_id = 17,
    .instance_id = std::string(instance_id),
    .class_id = "class-id",
    .vendor_id = "vendor-id",
    .canonical_bundle_path = "/private/catalog/Example.vst3",
    .canonical_executable_path = "/private/catalog/Example.vst3/Contents/MacOS/Example",
    .architecture = 1,
    .scanner_catalog_version = 2,
    .role = daw::audio_host_macos::NativeVstRole::kEffect,
    .input_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .output_layout = DAW_AUDIO_GRAPH_LAYOUT_STEREO,
    .transport_latency_frames = 4,
    .playback_enabled = true,
    .transport = {.slot_count = 2, .maximum_frames = 4, .input_channels = 2, .output_channels = 2, .maximum_events_per_block = 2},
  };
  attachment.bundle_fingerprint.fill(1);
  attachment.binary_fingerprint.fill(2);
  assert(host.AttachNativeVst(attachment));
  std::vector<std::uint8_t> parameters;
  AppendInstanceId(parameters, instance_id);
  AppendLeU32(parameters, 2);
  AppendLeU32(parameters, 7);
  AppendLeU32(parameters, 1);
  AppendLeDouble(parameters, 0.25);
  AppendLeU32(parameters, 8);
  AppendLeU32(parameters, 3);
  AppendLeDouble(parameters, 1.0);
  assert(host.QueueNativeVstParameterEvents(parameters));
  parameters.back() = 0x40;
  assert(!host.QueueNativeVstParameterEvents(parameters));
  std::vector<std::uint8_t> midi;
  AppendInstanceId(midi, instance_id);
  AppendLeU32(midi, 1);
  AppendLeU32(midi, 3);
  midi.insert(midi.end(), {0x90, 60, 100, 0});
  assert(host.QueueNativeVstMidiEvents(midi));
  midi.back() = 1;
  assert(!host.QueueNativeVstMidiEvents(midi));
  std::vector<std::uint8_t> invalid_state;
  AppendInstanceId(invalid_state, instance_id);
  AppendLeU32(invalid_state, 1);
  AppendLeU32(invalid_state, 64);
  invalid_state.insert(invalid_state.end(), 65, 0);
  assert(!host.SetNativeVstState(invalid_state));
}

void TestNativeSessionWireRejectsMalformedFramesAndEvents() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  const std::array<std::uint8_t, 4> empty_events{0, 0, 0, 0};
  assert(host.QueueParameterEvents(empty_events));
  assert(host.QueueInstrumentEvents(empty_events));
  assert(host.QueueSourceEvents(empty_events));
  std::array<std::uint8_t, 96> source_before_install{};
  source_before_install[0] = 1;
  source_before_install[24] = 1;
  assert(!host.QueueSourceEvents(source_before_install));
  const std::array<float, 8> samples{};
  assert(host.InstallAsset(1, 4, 48000, 2, 0, samples));
  std::array<std::uint8_t, 188> mixed_source_events{};
  mixed_source_events[0] = 2;
  mixed_source_events[24] = 1;
  mixed_source_events[116] = 2;
  assert(!host.QueueSourceEvents(mixed_source_events));
  assert(host.ReleaseAsset(1));
  const std::array<std::uint8_t, 12> empty_graph{};
  assert(!host.PrepareAndPublishGraph(1, empty_graph));
  const std::array<std::uint8_t, 5> malformed_events{1, 0, 0, 0, 0};
  assert(!host.QueueParameterEvents(malformed_events));
}

void TestNoActiveDeviceFailsGracefully() {
  daw::audio_host_macos::AudioHost host;
  assert(host.readinessReason() == daw::audio_host_macos::DeviceReadinessReason::kDeviceNotConfigured);
  assert(!host.Start());
  assert(!host.Configure({
    .device_uid = "",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
}

void TestCoreAudioDeviceLossRoutesBySessionRole() {
  daw::audio_host_macos::AudioHost output_host;
  assert(output_host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  assert(output_host.StartDiagnosticMode());
  const auto output_recording_revision = output_host.recordingStatusRevision();
  daw::audio_host_macos::NotifyCoreAudioDeviceLost(
    output_host,
    daw::audio_host_macos::CoreAudioDeviceRole::kOutput);
  assert(output_host.diagnostics().state == daw::audio_host_macos::LifecycleState::kFaulted);
  assert(output_host.recordingStatusRevision() == output_recording_revision);
  output_host.Stop();

  daw::audio_host_macos::AudioHost input_host;
  assert(input_host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  assert(input_host.StartDiagnosticMode());
  const auto input_recording_revision = input_host.recordingStatusRevision();
  daw::audio_host_macos::NotifyCoreAudioDeviceLost(
    input_host,
    daw::audio_host_macos::CoreAudioDeviceRole::kRecordingInput);
  assert(input_host.diagnostics().state == daw::audio_host_macos::LifecycleState::kRunning);
  assert(input_host.recordingStatusRevision() == input_recording_revision + 1);
  input_host.Stop();
}

void TestRollbackSafeGraphRevisionLifecycle() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  const auto first_graph = GraphSnapshot(1, 1.0F);
  assert(host.PrepareAndPublishGraph(1, first_graph));
  assert(host.SetTransport(1, true, 0));
  assert(host.StartDiagnosticMode());

  auto invalid_graph = GraphSnapshot(2, 0.5F);
  invalid_graph[12] = 99;
  const auto failed = host.PrepareGraphRevision(2, invalid_graph);
  assert(failed.code == daw::audio_host_macos::GraphRevisionStatusCode::kPrepareFailed);
  assert(failed.active_revision == 1);
  std::array<float, 4> left{1.0F, 1.0F, 1.0F, 1.0F};
  std::array<float, 4> right{1.0F, 1.0F, 1.0F, 1.0F};
  std::array<float, 4> output_left{};
  std::array<float, 4> output_right{};
  const std::array<const float*, 2> input{left.data(), right.data()};
  const std::array<float*, 2> output{output_left.data(), output_right.data()};
  assert(host.ProcessPlanar(input, output, 4));
  assert(output_left[0] == 1.0F && output_right[0] == 1.0F);

  const auto second_graph = GraphSnapshot(2, 0.25F);
  const auto discarded = host.PrepareGraphRevision(2, second_graph);
  assert(discarded.code == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  const auto rolled_back = host.RollbackGraphRevision(2);
  assert(rolled_back.code == daw::audio_host_macos::GraphRevisionStatusCode::kRolledBack);
  assert(rolled_back.active_revision == 1 && rolled_back.prepared_revision == 0);
  const auto prepared = host.PrepareGraphRevision(2, second_graph);
  assert(prepared.code == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  daw::audio_host_macos::GraphRevisionStatus published{};
  std::thread publisher([&] {
    published = host.PublishGraphRevision(2);
  });
  std::this_thread::sleep_for(std::chrono::milliseconds(1));
  output_left.fill(0.0F);
  output_right.fill(0.0F);
  assert(host.ProcessPlanar(input, output, 4));
  publisher.join();
  assert(published.code == daw::audio_host_macos::GraphRevisionStatusCode::kPublished);
  assert(published.active_revision == 2 && published.retired_revision == 1);
  assert(output_left[0] == 0.25F && output_right[0] == 0.25F);
  const auto stale = host.PublishGraphRevision(1);
  assert(stale.code == daw::audio_host_macos::GraphRevisionStatusCode::kStaleRevision);
  const auto retired = host.RetireGraphRevision(1);
  assert(retired.code == daw::audio_host_macos::GraphRevisionStatusCode::kRetired);
  assert(retired.render_epoch >= published.render_epoch);
  const auto third_graph = GraphSnapshot(3, 0.5F);
  assert(host.PrepareGraphRevision(3, third_graph).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kPrepared);
  const auto publish_timeout = host.PublishGraphRevision(3);
  assert(publish_timeout.code == daw::audio_host_macos::GraphRevisionStatusCode::kPublishFailed);
  assert(publish_timeout.active_revision == 2 && publish_timeout.prepared_revision == 3);
  assert(host.RollbackGraphRevision(3).code
    == daw::audio_host_macos::GraphRevisionStatusCode::kRolledBack);
  host.Stop();
}

void TestWorkerNotificationCarriesRevisionIdentity() {
  daw::audio_host_macos::NativeVstAttachment attachment{
    .graph_node_id = 91,
    .instance_id = "attachment-instance",
  };
  const auto notification = daw::audio_host_macos::IdentifyWorkerNotification(
    attachment,
    7,
    daw::audio_host_macos::WorkerNotificationKind::kLatency,
    128
  );
  assert(notification.graph_revision == 7);
  assert(notification.graph_node_id == 91);
  assert(notification.instance_id == "attachment-instance");
  assert(notification.value == 128);
}

}  // namespace

int main() {
  TestDeviceNamespace();
  TestControlFrames();
  TestCallbackPlanarBuffersAndSplitting();
  TestNativeVstAttachmentBoundsAndLatencyContract();
  TestNativeVstRuntimeControlBounds();
  TestNativeSessionWireRejectsMalformedFramesAndEvents();
  TestNoActiveDeviceFailsGracefully();
  TestCoreAudioDeviceLossRoutesBySessionRole();
  TestRollbackSafeGraphRevisionLifecycle();
  TestWorkerNotificationCarriesRevisionIdentity();
  return 0;
}
