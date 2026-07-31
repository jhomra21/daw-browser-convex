#include "vst3-worker.h"
#include "worker-control-protocol.h"

#include <cerrno>
#include <charconv>
#include <array>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <poll.h>
#include <string>
#include <string_view>
#include <sys/resource.h>
#include <unistd.h>

namespace {

constexpr int kEditorPollTimeoutMilliseconds = 8;

template <typename Number>
bool Parse(const std::string_view text, Number& result) {
  const auto parsed = std::from_chars(text.data(), text.data() + text.size(), result);
  return parsed.ec == std::errc{} && parsed.ptr == text.data() + text.size();
}

std::string EscapeJson(const std::string_view value) {
  std::string result;
  result.reserve(value.size() + 8);
  constexpr std::string_view digits{"0123456789abcdef"};
  for (const auto character : value) {
    switch (character) {
      case '"': result += "\\\""; break;
      case '\\': result += "\\\\"; break;
      case '\b': result += "\\b"; break;
      case '\f': result += "\\f"; break;
      case '\n': result += "\\n"; break;
      case '\r': result += "\\r"; break;
      case '\t': result += "\\t"; break;
      default:
        if (static_cast<unsigned char>(character) < 0x20U) {
          result += "\\u00";
          result += digits[(static_cast<unsigned char>(character) >> 4U) & 0x0FU];
          result += digits[static_cast<unsigned char>(character) & 0x0FU];
        } else {
          result += character;
        }
    }
  }
  return result;
}

std::string WorkerHelloJson(const daw::plugin_host::WorkerHello& hello) {
  const auto buses = [](const std::vector<daw::plugin_host::WorkerBusDescriptor>& values) {
    std::string result{"["};
    for (std::size_t index = 0; index < values.size(); ++index) {
      const auto& bus = values[index];
      if (index != 0) result += ',';
      result += "{\"name\":\"" + EscapeJson(bus.name) + "\",\"channels\":" + std::to_string(bus.channels)
        + ",\"enabled\":" + (bus.enabled ? "true" : "false") + "}";
    }
    return result + "]";
  };
  const auto parameters = [](const std::vector<daw::plugin_host::WorkerParameterDescriptor>& values) {
    std::string result{"["};
    for (std::size_t index = 0; index < values.size(); ++index) {
      const auto& parameter = values[index];
      if (index != 0) result += ',';
      result += "{\"id\":" + std::to_string(parameter.id)
        + ",\"title\":\"" + EscapeJson(parameter.title)
        + "\",\"unit\":\"" + EscapeJson(parameter.unit)
        + "\",\"minimum\":" + std::to_string(parameter.minimum)
        + ",\"maximum\":" + std::to_string(parameter.maximum)
        + ",\"defaultValue\":" + std::to_string(parameter.defaultValue)
        + ",\"stepCount\":" + std::to_string(parameter.stepCount)
        + ",\"readOnly\":" + (parameter.readOnly ? "true" : "false")
        + ",\"hidden\":" + (parameter.hidden ? "true" : "false") + "}";
    }
    return result + "]";
  };
  const auto& manifest = hello.manifest;
  return "{\"version\":1,\"type\":\"hello\",\"instanceId\":\"" + EscapeJson(hello.instanceId)
    + "\",\"manifest\":{\"version\":" + std::to_string(manifest.version)
    + ",\"artifact\":{\"id\":\"" + EscapeJson(manifest.artifact.id) + "\",\"version\":\""
    + EscapeJson(manifest.artifact.version) + "\"},\"startupProtocolVersion\":"
    + std::to_string(manifest.startupProtocolVersion) + ",\"controlProtocolVersion\":"
    + std::to_string(manifest.controlProtocolVersion) + ",\"transportAbiVersion\":"
    + std::to_string(manifest.transportAbiVersion) + ",\"architecture\":\"arm64\",\"role\":\""
    + (manifest.role == daw::plugin_host::WorkerPluginRole::kInstrument ? "instrument" : "effect")
    + "\",\"inputBuses\":" + buses(manifest.inputBuses) + ",\"outputBuses\":" + buses(manifest.outputBuses)
    + ",\"transport\":{\"slotCount\":" + std::to_string(manifest.transport.slotCount)
    + ",\"maximumFrames\":" + std::to_string(manifest.transport.maximumFrames)
    + ",\"inputChannels\":" + std::to_string(manifest.transport.inputChannels)
    + ",\"outputChannels\":" + std::to_string(manifest.transport.outputChannels)
    + ",\"maximumEventsPerBlock\":" + std::to_string(manifest.transport.maximumEventsPerBlock)
    + "},\"latencyFrames\":" + std::to_string(manifest.latencyFrames) + ",\"tailFrames\":"
    + (manifest.tailFrames ? std::to_string(*manifest.tailFrames) : "null")
    + ",\"stateRevision\":" + std::to_string(manifest.stateRevision)
    + ",\"parameters\":" + parameters(manifest.parameters)
    + ",\"supportsBypass\":" + (manifest.supportsBypass ? "true" : "false")
    + ",\"supportsEditor\":" + (manifest.supportsEditor ? "true" : "false")
    + ",\"supportsState\":" + (manifest.supportsState ? "true" : "false") + "}}";
}

bool WritePreflightHello(const daw::plugin_host::WorkerHello& hello) {
  if (!daw::plugin_host::IsValidWorkerHello(hello)) return false;
  const auto body = WorkerHelloJson(hello);
  if (body.empty() || body.size() > 16U * 1024U) return false;
  const auto size = static_cast<std::uint32_t>(body.size());
  const std::array<std::uint8_t, 4> header{
    static_cast<std::uint8_t>(size >> 24U),
    static_cast<std::uint8_t>(size >> 16U),
    static_cast<std::uint8_t>(size >> 8U),
    static_cast<std::uint8_t>(size),
  };
  std::cout.write(reinterpret_cast<const char*>(header.data()), static_cast<std::streamsize>(header.size()));
  std::cout.write(body.data(), static_cast<std::streamsize>(body.size()));
  std::cout.flush();
  return std::cout.good();
}

}  // namespace

int main(const int argc, char* argv[]) {
  const rlimit coreLimit{.rlim_cur = 0, .rlim_max = 0};
  if (setrlimit(RLIMIT_CORE, &coreLimit) != 0) return EXIT_FAILURE;
  if (argc == 28 && std::string_view(argv[1]) == "--preflight"
    && std::string_view(argv[2]) == "--instance-id"
    && std::string_view(argv[4]) == "--bundle-path"
    && std::string_view(argv[6]) == "--executable-path"
    && std::string_view(argv[8]) == "--bundle-fingerprint"
    && std::string_view(argv[10]) == "--binary-fingerprint"
    && std::string_view(argv[12]) == "--class-id"
    && std::string_view(argv[14]) == "--sample-rate"
    && std::string_view(argv[16]) == "--maximum-frames"
    && std::string_view(argv[18]) == "--input-channels"
    && std::string_view(argv[20]) == "--output-channels"
    && std::string_view(argv[22]) == "--slot-count"
    && std::string_view(argv[24]) == "--maximum-events"
    && std::string_view(argv[26]) == "--state-revision") {
    daw::plugin_host::WorkerProcessSetup setup{};
    daw::plugin_host::WorkerTransportRequest transport{};
    std::uint32_t stateRevision = 0;
    if (!Parse(argv[15], setup.sampleRate)
      || !Parse(argv[17], setup.maximumBlockFrames)
      || !Parse(argv[19], setup.inputChannels)
      || !Parse(argv[21], setup.outputChannels)
      || !Parse(argv[23], transport.slotCount)
      || !Parse(argv[25], transport.maximumEventsPerBlock)
      || !Parse(argv[27], stateRevision)) {
      return EXIT_FAILURE;
    }
    transport.maximumFrames = setup.maximumBlockFrames;
    transport.inputChannels = setup.inputChannels;
    transport.outputChannels = setup.outputChannels;
    daw::plugin_host::Vst3Worker plugin;
    const daw::plugin_host::WorkerInstanceRequest instance{
      .eligibility = {
        .canonicalBundlePath = argv[5],
        .canonicalExecutablePath = argv[7],
        .bundleFingerprint = argv[9],
        .binaryFingerprint = argv[11],
        .arm64 = true,
        .codeSignVerified = true,
        .quarantinePresent = false,
        .scannerProtocolVersion = 2,
      },
      .classId = argv[13],
      .setup = setup,
    };
    if (!plugin.Instantiate(instance)) return EXIT_FAILURE;
    const auto manifest = plugin.PreflightManifest(transport, stateRevision);
    if (!manifest || !WritePreflightHello({
      .instanceId = argv[3],
      .manifest = *manifest,
    })) return EXIT_FAILURE;
    plugin.Dispose();
    return EXIT_SUCCESS;
  }
  if (argc != 9 || std::string_view(argv[1]) != "--transport-fd"
    || std::string_view(argv[3]) != "--control-fd" || std::string_view(argv[5]) != "--response-fd"
    || std::string_view(argv[7]) != "--token") {
    return EXIT_FAILURE;
  }
  int transportFileDescriptor = -1;
  int controlFileDescriptor = -1;
  int responseFileDescriptor = -1;
  std::uint64_t token = 0;
  if (!Parse(argv[2], transportFileDescriptor) || !Parse(argv[4], controlFileDescriptor)
    || !Parse(argv[6], responseFileDescriptor) || !Parse(argv[8], token)) return EXIT_FAILURE;
  auto transport = daw::plugin_host::WorkerTransport::MapInherited(transportFileDescriptor, token);
  if (!transport) return EXIT_FAILURE;
  const auto startup = daw::plugin_host::ReadWorkerStartupRequest(controlFileDescriptor, token);
  if (!startup || startup->setup.maximumBlockFrames != transport->maximumFrames()
    || startup->setup.inputChannels != transport->inputChannels()
    || startup->setup.outputChannels != transport->outputChannels()) {
    transport->PublishHealth(daw::plugin_host::WorkerHealth::kFaulted);
    static_cast<void>(transport->PublishDiagnostic({.kind = daw::plugin_host::WorkerDiagnosticKind::kFault}));
    return EXIT_FAILURE;
  }

  daw::plugin_host::Vst3Worker plugin;
  if (!startup->noPluginTestMode) {
    const daw::plugin_host::WorkerInstanceRequest instance{
      .eligibility = startup->eligibility,
      .classId = startup->classId,
      .setup = startup->setup,
    };
    if (!plugin.Instantiate(instance) || !plugin.ConfigureTransport(*transport)
      || (startup->state && !plugin.SetState(*startup->state))) {
      transport->PublishHealth(daw::plugin_host::WorkerHealth::kFaulted);
      static_cast<void>(transport->PublishDiagnostic({.kind = daw::plugin_host::WorkerDiagnosticKind::kFault}));
      return EXIT_FAILURE;
    }
  }
  std::size_t notificationCount = 0;
  const auto publishNotifications = [&] {
    if (startup->noPluginTestMode) return;
    const auto& notifications = plugin.notifications();
    while (notificationCount < notifications.size()) {
      const auto& notification = notifications[notificationCount++];
      const auto kind = notification.kind == daw::plugin_host::WorkerNotificationKind::kLatency
        ? daw::plugin_host::WorkerDiagnosticKind::kLatency
        : notification.kind == daw::plugin_host::WorkerNotificationKind::kBuses
          ? daw::plugin_host::WorkerDiagnosticKind::kBuses
        : notification.kind == daw::plugin_host::WorkerNotificationKind::kRestart
          ? daw::plugin_host::WorkerDiagnosticKind::kRestart
        : notification.kind == daw::plugin_host::WorkerNotificationKind::kEditorInteraction
          ? daw::plugin_host::WorkerDiagnosticKind::kEditorInteraction
        : notification.kind == daw::plugin_host::WorkerNotificationKind::kParameterEdit
          ? daw::plugin_host::WorkerDiagnosticKind::kParameterEdit
          : daw::plugin_host::WorkerDiagnosticKind::kFault;
      static_cast<void>(transport->PublishDiagnostic({
        .kind = kind,
        .value = notification.value,
        .parameter_id = notification.parameter_id,
        .normalized_value = notification.normalized_value,
      }));
    }
  };
  const auto publishEditorFeedback = [&] {
    if (startup->noPluginTestMode) return;
    daw::plugin_host::PendingEditorParameterEdit edit{};
    while (plugin.PeekEditorParameterFeedback(edit)) {
      const bool published = transport->PublishDiagnostic({
        .kind = daw::plugin_host::WorkerDiagnosticKind::kParameterEdit,
        .parameter_id = edit.parameter_id,
        .normalized_value = edit.normalized_value,
      });
      if (!published) break;
      static_cast<void>(plugin.AckEditorParameterFeedback(edit.parameter_id, edit.generation));
    }
  };
  publishNotifications();
  publishEditorFeedback();
  transport->PublishHealth(daw::plugin_host::WorkerHealth::kReady);
  static_cast<void>(transport->PublishDiagnostic({.kind = daw::plugin_host::WorkerDiagnosticKind::kReady}));
  bool editorOpen = false;
  for (;;) {
    if (editorOpen) {
      daw::plugin_host::PumpVst3EditorEvents();
      editorOpen = !startup->noPluginTestMode && plugin.EditorStatus().open;
      if (daw::plugin_host::ConsumeVst3EditorInteraction()) {
        static_cast<void>(transport->PublishDiagnostic({
          .kind = daw::plugin_host::WorkerDiagnosticKind::kEditorInteraction,
        }));
      }
      publishEditorFeedback();
    }
    struct pollfd readyControl{.fd = controlFileDescriptor, .events = POLLIN, .revents = 0};
    const auto pollResult = poll(&readyControl, 1, editorOpen ? kEditorPollTimeoutMilliseconds : -1);
    if (pollResult < 0 && errno == EINTR) continue;
    if (pollResult <= 0) continue;
    const auto command = daw::plugin_host::ReadWorkerControlCommand(controlFileDescriptor);
    if (!command || command->command == daw::plugin_host::WorkerControlCommand::kStop) {
      plugin.Dispose();
      transport->PublishHealth(daw::plugin_host::WorkerHealth::kStopped);
      static_cast<void>(transport->PublishDiagnostic({.kind = daw::plugin_host::WorkerDiagnosticKind::kStopped}));
      return command ? EXIT_SUCCESS : EXIT_FAILURE;
    }
    if (command->command == daw::plugin_host::WorkerControlCommand::kStateSet) {
      const auto state = daw::plugin_host::ReadWorkerState(controlFileDescriptor);
      const auto success = !startup->noPluginTestMode && state && plugin.SetState(*state);
      if (!daw::plugin_host::WriteWorkerEditorResponse(responseFileDescriptor, {.success = success})) return EXIT_FAILURE;
      continue;
    }
    if (command->command == daw::plugin_host::WorkerControlCommand::kStateGet) {
      const auto state = startup->noPluginTestMode ? std::optional<daw::plugin_host::WorkerState>{} : plugin.GetState();
      if (!state || !daw::plugin_host::WriteWorkerState(responseFileDescriptor, *state)) return EXIT_FAILURE;
      continue;
    }
    const auto editorCommand = [&]() -> std::optional<daw::plugin_host::WorkerEditorCommand> {
      switch (command->command) {
        case daw::plugin_host::WorkerControlCommand::kEditorOpen: return daw::plugin_host::WorkerEditorCommand::kOpen;
        case daw::plugin_host::WorkerControlCommand::kEditorClose: return daw::plugin_host::WorkerEditorCommand::kClose;
        case daw::plugin_host::WorkerControlCommand::kEditorFocus: return daw::plugin_host::WorkerEditorCommand::kFocus;
        case daw::plugin_host::WorkerControlCommand::kEditorResize: return daw::plugin_host::WorkerEditorCommand::kResize;
        case daw::plugin_host::WorkerControlCommand::kEditorStatus: return daw::plugin_host::WorkerEditorCommand::kStatus;
        default: return std::nullopt;
      }
    }();
    if (editorCommand) {
      const auto success = !startup->noPluginTestMode
        && plugin.ExecuteEditorCommand(*editorCommand, command->width, command->height, command->anchor);
      const auto status = startup->noPluginTestMode ? daw::plugin_host::WorkerEditorStatus{} : plugin.EditorStatus();
      editorOpen = status.open;
      if (!daw::plugin_host::WriteWorkerEditorResponse(responseFileDescriptor, {.success = success, .status = status})) return EXIT_FAILURE;
      continue;
    }
    bool failed = false;
    for (std::size_t slotIndex = 0; slotIndex < transport->layout().bytes / transport->layout().slotBytes; ++slotIndex) {
      const auto slot = transport->slot(slotIndex);
      if (slot.status == daw::plugin_host::WorkerSlotStatus::kDropped) {
        static_cast<void>(transport->ReleaseDropped(slotIndex));
        continue;
      }
      if (slot.status != daw::plugin_host::WorkerSlotStatus::kSubmitted) continue;
      const auto sequence = transport->BeginProcessing(slotIndex);
      if (!sequence) continue;
      try {
        if (startup->noPluginTestMode) {
          // CTest-only transport verification; regular launches always use Vst3Worker.
          const auto samples = transport->numSamples(slotIndex);
          const auto input = transport->input(slotIndex);
          auto output = transport->output(slotIndex);
          for (std::size_t channel = 0; channel < transport->outputChannels(); ++channel) {
            auto* outputPlane = output.data() + channel * transport->maximumFrames();
            if (channel < transport->inputChannels()) {
              const auto* inputPlane = input.data() + channel * transport->maximumFrames();
              std::memcpy(outputPlane, inputPlane, samples * sizeof(float));
            } else {
              std::memset(outputPlane, 0, samples * sizeof(float));
            }
          }
          if (!transport->Complete(slotIndex, *sequence)) failed = true;
        } else if (!plugin.ProcessSubmittedSlot(slotIndex)) {
          failed = true;
        }
      } catch (...) {
        failed = true;
      }
      if (failed) {
        transport->PublishHealth(daw::plugin_host::WorkerHealth::kFaulted);
        static_cast<void>(transport->PublishDiagnostic({.kind = daw::plugin_host::WorkerDiagnosticKind::kFault, .sequence = *sequence}));
        plugin.Dispose();
        return EXIT_FAILURE;
      }
    }
    publishNotifications();
    publishEditorFeedback();
  }
}
