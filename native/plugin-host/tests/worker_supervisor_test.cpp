#include "worker-control-service.h"
#include "worker-supervisor.h"
#include "worker-control-protocol.h"

#include <array>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>
#include <unistd.h>

namespace {

using daw::plugin_host::CreateWorkerTransportLayout;
using daw::plugin_host::CreatePortableSharedMemoryDescriptor;
using daw::plugin_host::IsWorkerLaunchEligible;
using daw::plugin_host::WorkerDiagnosticKind;
using daw::plugin_host::WorkerHealth;
using daw::plugin_host::WorkerLaunchEligibility;
using daw::plugin_host::WorkerSlotStatus;
using daw::plugin_host::WorkerTransportEvent;
using daw::plugin_host::WorkerEventKind;
using daw::plugin_host::WorkerTransport;
using daw::plugin_host::WorkerTransportRequest;
using daw::plugin_host::SpscQueue;
using daw::plugin_host::WorkerCallbackPort;
using daw::plugin_host::WorkerControlService;
using daw::plugin_host::WorkerProcessSetup;
using daw::plugin_host::WorkerStartupRequest;
using daw::plugin_host::WorkerSubmissionStatus;
using daw::plugin_host::WorkerState;
using daw::plugin_host::WorkerArtifactIdentity;
using daw::plugin_host::WorkerBusDescriptor;
using daw::plugin_host::WorkerHello;
using daw::plugin_host::WorkerHostConfiguration;
using daw::plugin_host::WorkerManifest;
using daw::plugin_host::WorkerPluginRole;
using daw::plugin_host::WorkerPreflightResult;
using daw::plugin_host::WorkerPreflightStatus;

bool Check(const bool condition, const char* message) {
  if (condition) return true;
  std::cerr << message << '\n';
  return false;
}

WorkerLaunchEligibility Eligible() {
  return WorkerLaunchEligibility{
    .canonicalBundlePath = "/Plugins/Example.vst3",
    .canonicalExecutablePath = "/Plugins/Example.vst3/Contents/MacOS/Example",
    .bundleFingerprint = std::string(64, 'b'),
    .binaryFingerprint = std::string(64, 'a'),
    .arm64 = true,
    .codeSignVerified = true,
    .quarantinePresent = false,
    .scannerProtocolVersion = 2,
  };
}

WorkerTransportRequest Request() {
  return WorkerTransportRequest{
    .slotCount = 2,
    .maximumFrames = 512,
    .inputChannels = 2,
    .outputChannels = 2,
    .maximumEventsPerBlock = 64,
  };
}

WorkerStartupRequest NoPluginStartup() {
  return WorkerStartupRequest{
    .setup = WorkerProcessSetup{
      .sampleRate = 48'000.0,
      .maximumBlockFrames = 512,
      .inputChannels = 2,
      .outputChannels = 2,
    },
    .noPluginTestMode = true,
  };
}

WorkerHostConfiguration Configuration(const std::string& executable) {
  return WorkerHostConfiguration{
    .executable = executable,
    .artifact = {
      .id = std::string(daw::plugin_host::kWorkerArtifactId),
      .version = std::string(daw::plugin_host::kWorkerArtifactVersion),
    },
  };
}

WorkerHello Hello() {
  return WorkerHello{
    .instanceId = "b0c4db1e-bd48-46d4-a4bc-f5ad1fe6c6f1",
    .manifest = WorkerManifest{
      .version = daw::plugin_host::kWorkerManifestVersion,
      .artifact = WorkerArtifactIdentity{
        .id = std::string(daw::plugin_host::kWorkerArtifactId),
        .version = std::string(daw::plugin_host::kWorkerArtifactVersion),
      },
      .startupProtocolVersion = daw::plugin_host::kWorkerStartupProtocolVersion,
      .controlProtocolVersion = daw::plugin_host::kWorkerControlProtocolVersion,
      .transportAbiVersion = daw::plugin_host::kWorkerTransportAbiVersion,
      .arm64 = true,
      .role = WorkerPluginRole::kEffect,
      .inputBuses = {WorkerBusDescriptor{.name = "Main Input", .channels = 2, .enabled = true}},
      .outputBuses = {WorkerBusDescriptor{.name = "Main Output", .channels = 2, .enabled = true}},
      .transport = Request(),
      .latencyFrames = 32,
      .tailFrames = 480,
      .stateRevision = 7,
    },
  };
}

WorkerPreflightResult UnavailablePreflight() {
  return WorkerPreflightResult{
    .version = 1,
    .requestId = "preflight-1",
    .status = WorkerPreflightStatus::kUnavailable,
    .code = "worker-timeout",
    .message = "The packaged worker timed out.",
    .requirements = {
      .artifact = {
        .id = std::string(daw::plugin_host::kWorkerArtifactId),
        .version = std::string(daw::plugin_host::kWorkerArtifactVersion),
      },
      .startupProtocolVersion = daw::plugin_host::kWorkerStartupProtocolVersion,
      .controlProtocolVersion = daw::plugin_host::kWorkerControlProtocolVersion,
      .transportAbiVersion = daw::plugin_host::kWorkerTransportAbiVersion,
      .arm64 = true,
    },
  };
}

WorkerPreflightResult AvailablePreflight() {
  auto result = UnavailablePreflight();
  result.status = WorkerPreflightStatus::kAvailable;
  result.code.clear();
  result.message.clear();
  result.hello = Hello();
  return result;
}

}  // namespace

int main(int argc, char* argv[]) {
  if (argc != 2) return EXIT_FAILURE;
  auto eligibility = Eligible();
  if (!Check(IsWorkerLaunchEligible(eligibility), "eligible worker record was rejected")) return EXIT_FAILURE;
  eligibility.quarantinePresent = true;
  if (!Check(!IsWorkerLaunchEligible(eligibility), "quarantined worker record was accepted")) return EXIT_FAILURE;
  eligibility = Eligible();
  eligibility.scannerProtocolVersion = 1;
  if (!Check(!IsWorkerLaunchEligible(eligibility), "old scanner protocol was accepted")) return EXIT_FAILURE;
  if (!Check(daw::plugin_host::IsValidWorkerStartupRequest(NoPluginStartup()), "no-plugin CTest startup was rejected")) return EXIT_FAILURE;
  auto invalidStartup = NoPluginStartup();
  invalidStartup.classId = "not-allowed";
  if (!Check(!daw::plugin_host::IsValidWorkerStartupRequest(invalidStartup), "no-plugin startup accepted plugin data")) return EXIT_FAILURE;
  if (!Check(daw::plugin_host::IsValidWorkerHostConfiguration(Configuration(argv[1])), "valid worker configuration was rejected")) return EXIT_FAILURE;
  auto invalidConfiguration = Configuration(argv[1]);
  invalidConfiguration.artifact.version = "2";
  if (!Check(!daw::plugin_host::IsValidWorkerHostConfiguration(invalidConfiguration), "unknown worker artifact was accepted")) return EXIT_FAILURE;

  const auto layout = CreateWorkerTransportLayout(Request());
  if (!Check(layout.has_value() && layout->bytes > 0, "valid transport layout was rejected")) return EXIT_FAILURE;
  const auto invalidLayout = CreateWorkerTransportLayout(WorkerTransportRequest{.slotCount = 1});
  if (!Check(!invalidLayout.has_value(), "invalid transport layout was accepted")) return EXIT_FAILURE;
  auto maximumRequest = Request();
  maximumRequest.slotCount = 9;
  if (!Check(!CreateWorkerTransportLayout(maximumRequest).has_value(), "over-capacity transport layout was accepted")) return EXIT_FAILURE;
  if (!Check(CreatePortableSharedMemoryDescriptor("daw.worker.1", *layout).has_value(), "valid shared memory descriptor was rejected")) return EXIT_FAILURE;
  if (!Check(!CreatePortableSharedMemoryDescriptor("../unsafe", *layout).has_value(), "unsafe shared memory descriptor was accepted")) return EXIT_FAILURE;

  auto transportResult = WorkerTransport::Create(*layout);
  if (!Check(transportResult.has_value(), "shared transport creation failed")) return EXIT_FAILURE;
  WorkerTransport transport = std::move(*transportResult);
  if (!Check(transport.Submit(0, 1), "transport submit failed")) return EXIT_FAILURE;
  if (!Check(!transport.Complete(0, 2), "late response was accepted")) return EXIT_FAILURE;
  if (!Check(transport.DropLate(0, 2), "late response was not dropped")) return EXIT_FAILURE;
  if (!Check(transport.slot(0).status == WorkerSlotStatus::kDropped, "dropped slot status missing")) return EXIT_FAILURE;
  const WorkerTransportEvent events[] {
    {.kind = WorkerEventKind::kParameter, .sampleOffset = 3, .parameterId = 9, .parameterValue = 0.5},
    {.kind = WorkerEventKind::kMidi, .sampleOffset = 7, .midiData = {0x90, 60, 100}},
  };
  if (!Check(transport.Submit(1, 2, 64, events), "variable-sized transport submit failed")) return EXIT_FAILURE;
  if (!Check(transport.numSamples(1) == 64 && transport.events(1).size() == 2, "transport lost event offsets")) return EXIT_FAILURE;
  if (!Check(!transport.Submit(1, 3, 64, std::span<const WorkerTransportEvent>(events, 1)), "occupied transport slot was reused")) return EXIT_FAILURE;
  if (!Check(!transport.Submit(0, 3, 4, std::span<const WorkerTransportEvent>(events + 1, 1)), "out-of-range event offset was accepted")) return EXIT_FAILURE;
  const std::array<WorkerTransportEvent, 65> tooManyEvents{};
  if (!Check(!transport.Submit(0, 3, 64, tooManyEvents), "over-capacity control events were accepted")) return EXIT_FAILURE;

  const auto duplicate = dup(transport.fileDescriptor());
  if (!Check(!WorkerTransport::MapInherited(duplicate, transport.token() + 1).has_value(), "malformed transport token was accepted")) return EXIT_FAILURE;
  const auto validDuplicate = dup(transport.fileDescriptor());
  if (!Check(WorkerTransport::MapInherited(validDuplicate, transport.token()).has_value(), "valid inherited transport was rejected")) return EXIT_FAILURE;

  SpscQueue<std::uint32_t, 2> queue;
  std::uint32_t queued = 0;
  if (!Check(queue.TryPush(1) && queue.TryPush(2) && !queue.TryPush(3), "SPSC queue overflow policy failed")) return EXIT_FAILURE;
  if (!Check(queue.TryPop(queued) && queued == 1 && queue.TryPop(queued) && queued == 2 && !queue.TryPop(queued), "SPSC queue ordering failed")) return EXIT_FAILURE;

  int protocol[2]{};
  if (!Check(pipe(protocol) == 0, "startup protocol pipe creation failed")) return EXIT_FAILURE;
  if (!Check(daw::plugin_host::WriteWorkerStartupRequest(protocol[1], transport.token(), NoPluginStartup()), "startup protocol write failed")) return EXIT_FAILURE;
  close(protocol[1]);
  const auto decodedStartup = daw::plugin_host::ReadWorkerStartupRequest(protocol[0], transport.token());
  close(protocol[0]);
  if (!Check(decodedStartup.has_value() && decodedStartup->noPluginTestMode, "startup protocol decode failed")) return EXIT_FAILURE;
  int editorProtocol[2]{};
  if (!Check(pipe(editorProtocol) == 0, "editor protocol pipe creation failed")) return EXIT_FAILURE;
  if (!Check(
    daw::plugin_host::WriteWorkerControlCommand(
      editorProtocol[1],
      daw::plugin_host::WorkerControlCommand::kEditorResize,
      640,
      480),
    "editor command write failed"
  )) return EXIT_FAILURE;
  close(editorProtocol[1]);
  const auto editorCommand = daw::plugin_host::ReadWorkerControlCommand(editorProtocol[0]);
  close(editorProtocol[0]);
  if (!Check(editorCommand && editorCommand->command == daw::plugin_host::WorkerControlCommand::kEditorResize
    && editorCommand->width == 640 && editorCommand->height == 480, "editor command validation failed")) return EXIT_FAILURE;
  int editorResponseProtocol[2]{};
  if (!Check(pipe(editorResponseProtocol) == 0, "editor response pipe creation failed")) return EXIT_FAILURE;
  if (!Check(
    daw::plugin_host::WriteWorkerEditorResponse(editorResponseProtocol[1], {
      .success = false,
      .status = {.supported = false},
    }),
    "unsupported editor response write failed"
  )) return EXIT_FAILURE;
  close(editorResponseProtocol[1]);
  const auto editorResponse = daw::plugin_host::ReadWorkerEditorResponse(editorResponseProtocol[0]);
  close(editorResponseProtocol[0]);
  if (!Check(editorResponse && !editorResponse->success && !editorResponse->status.supported,
    "unsupported editor fallback response failed")) return EXIT_FAILURE;
  const WorkerState emptyState{
    .bytes = {},
    .sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  };
  int stateProtocol[2]{};
  if (!Check(pipe(stateProtocol) == 0, "state protocol pipe creation failed")) return EXIT_FAILURE;
  if (!Check(daw::plugin_host::WriteWorkerState(stateProtocol[1], emptyState), "state protocol write failed")) return EXIT_FAILURE;
  close(stateProtocol[1]);
  const auto decodedState = daw::plugin_host::ReadWorkerState(stateProtocol[0]);
  close(stateProtocol[0]);
  if (!Check(decodedState && decodedState->bytes.empty() && decodedState->sha256 == emptyState.sha256,
    "state protocol hash round trip failed")) return EXIT_FAILURE;
  int helloProtocol[2]{};
  if (!Check(pipe(helloProtocol) == 0, "worker hello protocol pipe creation failed")) return EXIT_FAILURE;
  if (!Check(daw::plugin_host::WriteWorkerHello(helloProtocol[1], Hello()), "worker hello protocol write failed")) return EXIT_FAILURE;
  close(helloProtocol[1]);
  const auto decodedHello = daw::plugin_host::ReadWorkerHello(helloProtocol[0]);
  close(helloProtocol[0]);
  if (!Check(decodedHello && decodedHello->instanceId == Hello().instanceId
    && decodedHello->manifest.artifact.id == daw::plugin_host::kWorkerArtifactId
    && decodedHello->manifest.transport.maximumFrames == Request().maximumFrames,
    "worker hello protocol round trip failed")) return EXIT_FAILURE;
  auto invalidHello = Hello();
  invalidHello.manifest.inputBuses[0].channels = 1;
  if (!Check(!daw::plugin_host::IsValidWorkerHello(invalidHello), "worker hello accepted mismatched bus dimensions")) return EXIT_FAILURE;
  if (!Check(daw::plugin_host::IsValidWorkerPreflightResult(UnavailablePreflight()),
    "typed unavailable worker preflight was rejected")) return EXIT_FAILURE;
  if (!Check(daw::plugin_host::IsValidWorkerPreflightResult(AvailablePreflight()),
    "available worker preflight was rejected")) return EXIT_FAILURE;
  const auto preflight = UnavailablePreflight();
  if (!Check(daw::plugin_host::IsValidWorkerPreflightRequest({
    .version = 1,
    .requestId = preflight.requestId,
    .requirements = preflight.requirements,
  }), "worker preflight request was rejected")) return EXIT_FAILURE;
  auto invalidPreflight = UnavailablePreflight();
  invalidPreflight.code = "available";
  if (!Check(!daw::plugin_host::IsValidWorkerPreflightResult(invalidPreflight),
    "worker preflight accepted an unknown failure code")) return EXIT_FAILURE;
  invalidPreflight = AvailablePreflight();
  invalidPreflight.hello.reset();
  if (!Check(!daw::plugin_host::IsValidWorkerPreflightResult(invalidPreflight),
    "available worker preflight omitted its hello")) return EXIT_FAILURE;

  WorkerControlService service;
  if (!Check(service.Start(NoPluginStartup(), Configuration(argv[1]), Request()), "worker control service launch failed")) return EXIT_FAILURE;
  const WorkerCallbackPort callback = service.callbackPort();
  if (!Check(
    callback.Submit({.slotIndex = 0, .sequence = 7, .numSamples = 64, .events = events}) == WorkerSubmissionStatus::kAccepted,
    "callback-safe worker submission failed"
  )) return EXIT_FAILURE;
  for (int attempt = 0; attempt < 500 && !callback.ReadCompleted(0, 7); ++attempt) {
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
  if (!Check(callback.ReadCompleted(0, 7), "worker did not complete callback submission")) return EXIT_FAILURE;
  if (!Check(callback.health() == WorkerHealth::kReady, "worker health was not available from the callback port")) return EXIT_FAILURE;
  std::array<float, 128> worker_input{};
  std::array<float, 128> worker_output{};
  worker_input[0] = 0.25F;
  worker_input[64] = -0.5F;
  if (!Check(callback.CopyInput(1, worker_input), "callback-safe input mapping failed")) return EXIT_FAILURE;
  if (!Check(!callback.ReadCompleted(0, 8), "late response was accepted by callback port")) return EXIT_FAILURE;
  if (!Check(
    callback.Submit({.slotIndex = 1, .sequence = 8, .numSamples = 64, .events = events}) == WorkerSubmissionStatus::kAccepted,
    "second callback-safe worker submission failed"
  )) return EXIT_FAILURE;
  for (int attempt = 0; attempt < 500 && !callback.ReadCompleted(1, 8); ++attempt) {
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
  if (!Check(callback.CopyCompletedOutput(1, 8, worker_output), "callback-safe output mapping failed")) return EXIT_FAILURE;
  if (!Check(worker_output[0] == worker_input[0] && worker_output[64] == worker_input[64],
    "worker output did not preserve mapped channel planes")) return EXIT_FAILURE;
  std::this_thread::sleep_for(std::chrono::milliseconds(10));
  const auto diagnostic = service.ReadDiagnostic();
  if (!Check(diagnostic.has_value() && diagnostic->kind == WorkerDiagnosticKind::kReady, "worker ready diagnostic missing")) return EXIT_FAILURE;
  if (!Check(service.Restart(), "worker control service restart failed")) return EXIT_FAILURE;
  for (int attempt = 0; attempt < 500 && callback.health() != WorkerHealth::kReady; ++attempt) {
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
  if (!Check(callback.health() == WorkerHealth::kReady, "worker restart did not restore callback health")) return EXIT_FAILURE;
  service.Stop();
  if (!Check(service.health() == WorkerHealth::kStopped, "worker control service cleanup failed")) return EXIT_FAILURE;

  WorkerControlService deadWorker;
  if (!Check(deadWorker.Start(NoPluginStartup(), Configuration("/usr/bin/false"), Request()), "death test child launch failed")) return EXIT_FAILURE;
  std::this_thread::sleep_for(std::chrono::milliseconds(10));
  const auto deadCallback = deadWorker.callbackPort();
  static_cast<void>(deadCallback.Submit({.slotIndex = 0, .sequence = 8, .numSamples = 64, .events = events}));
  std::this_thread::sleep_for(std::chrono::milliseconds(10));
  if (!Check(deadWorker.health() == WorkerHealth::kFaulted, "worker death was not surfaced")) return EXIT_FAILURE;
  deadWorker.Stop();
  return EXIT_SUCCESS;
}
