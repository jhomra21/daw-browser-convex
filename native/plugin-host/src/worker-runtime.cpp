#include "worker-supervisor.h"
#include "worker-control-protocol.h"

#include <algorithm>
#include <array>
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <limits>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <sys/event.h>
#include <sys/wait.h>
#include <unistd.h>

namespace daw::plugin_host {
namespace {

bool CreateCloseOnExecPipe(int (&descriptors)[2]) {
  if (pipe(descriptors) != 0) return false;
  for (const auto descriptor : descriptors) {
    const auto flags = fcntl(descriptor, F_GETFD);
    if (flags >= 0 && fcntl(descriptor, F_SETFD, flags | FD_CLOEXEC) == 0) continue;
    close(descriptors[0]);
    close(descriptors[1]);
    descriptors[0] = -1;
    descriptors[1] = -1;
    return false;
  }
  return true;
}

bool WaitForChildExit(const int childProcessId, const long milliseconds) {
  int status = 0;
  const auto initial = waitpid(childProcessId, &status, WNOHANG);
  if (initial == childProcessId || (initial < 0 && errno == ECHILD)) return true;
  const auto queue = kqueue();
  if (queue < 0) return false;
  struct kevent change {};
  EV_SET(&change, childProcessId, EVFILT_PROC, EV_ADD | EV_ONESHOT, NOTE_EXIT, 0, nullptr);
  if (kevent(queue, &change, 1, nullptr, 0, nullptr) != 0) {
    close(queue);
    return false;
  }
  const auto beforeWait = waitpid(childProcessId, &status, WNOHANG);
  if (beforeWait == childProcessId || (beforeWait < 0 && errno == ECHILD)) {
    close(queue);
    return true;
  }
  const timespec timeout{.tv_sec = 0, .tv_nsec = milliseconds * 1'000'000L};
  struct kevent event {};
  const auto received = kevent(queue, nullptr, 0, &event, 1, &timeout);
  close(queue);
  if (received != 1) return false;
  const auto finalWait = waitpid(childProcessId, &status, 0);
  return finalWait == childProcessId || (finalWait < 0 && errno == ECHILD);
}

bool SignalWorker(const int childProcessId, const int processGroupId, const int signal) {
  if (childProcessId < 0) return true;
  if (processGroupId > 0 && processGroupId != getpgrp()) {
    if (kill(-processGroupId, signal) == 0) return true;
  }
  return kill(childProcessId, signal) == 0 || errno == ESRCH;
}

bool SignalWorkerGroupOnly(const int processGroupId, const int signal) {
  if (processGroupId <= 0 || processGroupId == getpgrp()) return false;
  return kill(-processGroupId, signal) == 0 || errno == ESRCH;
}

}  // namespace

WorkerWakeSignal::~WorkerWakeSignal() {
  Close();
}

bool WorkerWakeSignal::Open() noexcept {
  if (readDescriptor_ >= 0 || writeDescriptor_ >= 0) return false;
  int descriptors[2]{-1, -1};
  if (!CreateCloseOnExecPipe(descriptors)) return false;
  const auto readFlags = fcntl(descriptors[0], F_GETFL);
  const auto writeFlags = fcntl(descriptors[1], F_GETFL);
  if (readFlags < 0 || writeFlags < 0
    || fcntl(descriptors[0], F_SETFL, readFlags | O_NONBLOCK) != 0
    || fcntl(descriptors[1], F_SETFL, writeFlags | O_NONBLOCK) != 0
    || fcntl(descriptors[1], F_SETNOSIGPIPE, 1) != 0) {
    close(descriptors[0]);
    close(descriptors[1]);
    return false;
  }
  readDescriptor_ = descriptors[0];
  writeDescriptor_ = descriptors[1];
  return true;
}

void WorkerWakeSignal::Close() noexcept {
  if (readDescriptor_ >= 0) {
    close(readDescriptor_);
    readDescriptor_ = -1;
  }
  if (writeDescriptor_ >= 0) {
    close(writeDescriptor_);
    writeDescriptor_ = -1;
  }
}

bool WorkerWakeSignal::Notify() const noexcept {
  if (writeDescriptor_ < 0) return false;
  constexpr std::uint8_t wakeByte = 1;
  const auto result = write(writeDescriptor_, &wakeByte, sizeof(wakeByte));
  return result == static_cast<ssize_t>(sizeof(wakeByte))
    || (result < 0 && (errno == EAGAIN || errno == EWOULDBLOCK));
}

int WorkerWakeSignal::readDescriptor() const noexcept {
  return readDescriptor_;
}

int WorkerWakeSignal::releaseReadDescriptor() noexcept {
  const auto descriptor = readDescriptor_;
  readDescriptor_ = -1;
  return descriptor;
}

int WorkerWakeSignal::releaseWriteDescriptor() noexcept {
  const auto descriptor = writeDescriptor_;
  writeDescriptor_ = -1;
  return descriptor;
}

void WorkerWakeSignal::Drain(const int descriptor) noexcept {
  if (descriptor < 0) return;
  std::array<std::uint8_t, 64> wakeBytes{};
  for (;;) {
    const auto readCount = read(descriptor, wakeBytes.data(), wakeBytes.size());
    if (readCount > 0) continue;
    if (readCount < 0 && errno == EINTR) continue;
    break;
  }
}

WorkerRuntime::WorkerRuntime() = default;
WorkerRuntime::~WorkerRuntime() {
  Stop();
}

bool WorkerRuntime::Start(
  const WorkerStartupRequest& startup,
  const WorkerHostConfiguration& configuration,
  const WorkerTransportRequest& request
) {
  if (transport_ && health() == WorkerHealth::kFaulted) ++restartCount_;
  Stop();
  if (restartCount_ > kMaximumWorkerRestarts || !IsValidWorkerHostConfiguration(configuration) || !IsValidWorkerStartupRequest(startup)
    || startup.setup.maximumBlockFrames != request.maximumFrames || startup.setup.inputChannels != request.inputChannels
    || startup.setup.outputChannels != request.outputChannels) {
    return false;
  }
  const auto layout = CreateWorkerTransportLayout(request);
  if (!layout) return false;
  auto transport = WorkerTransport::Create(*layout);
  if (!transport) return false;
  int control[2]{-1, -1};
  int response[2]{-1, -1};
  WorkerWakeSignal wake;
  if (!CreateCloseOnExecPipe(control) || !CreateCloseOnExecPipe(response)
    || !wake.Open()) {
    if (control[0] >= 0) close(control[0]);
    if (control[1] >= 0) close(control[1]);
    if (response[0] >= 0) close(response[0]);
    if (response[1] >= 0) close(response[1]);
    return false;
  }
  if (transport->fileDescriptor() <= STDERR_FILENO || control[0] <= STDERR_FILENO
    || response[1] <= STDERR_FILENO || wake.readDescriptor() <= STDERR_FILENO) {
    close(control[0]);
    close(control[1]);
    close(response[0]);
    close(response[1]);
    return false;
  }
  const auto fd = std::to_string(STDIN_FILENO);
  const auto controlFd = std::to_string(STDOUT_FILENO);
  // Keep child-side protocol descriptors above every parent-side source
  // descriptor. This prevents a close action for one source from closing a
  // different descriptor just installed by dup2 when the parent owns many FDs.
  const auto maximumSourceDescriptor = std::max({
    transport->fileDescriptor(), control[0], control[1], response[0], response[1], wake.readDescriptor(),
  });
  if (maximumSourceDescriptor > std::numeric_limits<int>::max() - 2) {
    close(control[0]);
    close(control[1]);
    close(response[0]);
    close(response[1]);
    return false;
  }
  const int responseFileDescriptor = maximumSourceDescriptor + 1;
  const int wakeFileDescriptor = maximumSourceDescriptor + 2;
  const auto responseFd = std::to_string(responseFileDescriptor);
  const auto wakeFd = std::to_string(wakeFileDescriptor);
  const auto token = std::to_string(transport->token());
  std::array<std::string, 11> argumentValues{
    configuration.executable,
    "--transport-fd",
    fd,
    "--control-fd",
    controlFd,
    "--response-fd",
    responseFd,
    "--token",
    token,
    "--wake-fd",
    wakeFd,
  };
  std::array<char*, 12> arguments{};
  for (std::size_t index = 0; index < argumentValues.size(); ++index) arguments[index] = argumentValues[index].data();
  posix_spawn_file_actions_t fileActions{};
  posix_spawnattr_t attributes{};
  const auto actionsReady = posix_spawn_file_actions_init(&fileActions) == 0;
  const auto attributesReady = actionsReady && posix_spawnattr_init(&attributes) == 0;
  const short flags = POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETPGROUP;
  const auto spawnConfigured = attributesReady
    && posix_spawnattr_setflags(&attributes, flags) == 0
    && posix_spawnattr_setpgroup(&attributes, 0) == 0
    && posix_spawn_file_actions_adddup2(&fileActions, transport->fileDescriptor(), STDIN_FILENO) == 0
    && posix_spawn_file_actions_adddup2(&fileActions, control[0], STDOUT_FILENO) == 0
    && posix_spawn_file_actions_adddup2(&fileActions, response[1], responseFileDescriptor) == 0
    && posix_spawn_file_actions_adddup2(&fileActions, wake.readDescriptor(), wakeFileDescriptor) == 0
    && posix_spawn_file_actions_addclose(&fileActions, control[1]) == 0
    && posix_spawn_file_actions_addclose(&fileActions, response[0]) == 0
    && posix_spawn_file_actions_addclose(&fileActions, wake.readDescriptor()) == 0;
  pid_t child = -1;
  char* const environment[] = {nullptr};
  const auto spawnResult = spawnConfigured
    ? posix_spawn(&child, configuration.executable.c_str(), &fileActions, &attributes, arguments.data(), environment)
    : EINVAL;
  if (attributesReady) posix_spawnattr_destroy(&attributes);
  if (actionsReady) posix_spawn_file_actions_destroy(&fileActions);
  if (spawnResult != 0) {
    close(control[0]);
    close(control[1]);
    close(response[0]);
    close(response[1]);
    return false;
  }
  close(control[0]);
  close(response[1]);
  close(wake.releaseReadDescriptor());
  controlWriteDescriptor_ = control[1];
  responseReadDescriptor_ = response[0];
  wakeWriteDescriptor_ = wake.releaseWriteDescriptor();
  childProcessId_ = child;
  childProcessGroupId_ = child;
  transport_ = std::move(*transport);
  if (!WriteWorkerStartupRequest(controlWriteDescriptor_, transport_->token(), startup)) {
    Stop();
    return false;
  }
  startup_ = startup;
  configuration_ = configuration;
  transportRequest_ = request;
  return true;
}

void WorkerRuntime::Stop() {
  bool childAlive = childProcessId_ >= 0;
  bool childGroupIdentitySafe = false;
  bool childAlreadyExited = false;
  if (childAlive) {
    siginfo_t childInfo{};
    const auto result = waitid(P_PID, childProcessId_, &childInfo, WEXITED | WNOHANG | WNOWAIT);
    if (result == 0) {
      childAlreadyExited = childInfo.si_pid == childProcessId_;
      childAlive = !childAlreadyExited;
      childGroupIdentitySafe = true;
    } else {
      childAlive = errno != ECHILD;
      childGroupIdentitySafe = childAlive;
    }
  }
  if (controlWriteDescriptor_ >= 0) {
    if (childAlive) {
      static_cast<void>(WriteWorkerControlCommand(controlWriteDescriptor_, WorkerControlCommand::kStop));
    }
    close(controlWriteDescriptor_);
    controlWriteDescriptor_ = -1;
  }
  if (responseReadDescriptor_ >= 0) {
    close(responseReadDescriptor_);
    responseReadDescriptor_ = -1;
  }
  if (wakeWriteDescriptor_ >= 0) {
    close(wakeWriteDescriptor_);
    wakeWriteDescriptor_ = -1;
  }
  if (childProcessId_ >= 0 && childAlive) {
    if (!WaitForChildExit(childProcessId_, 250)) {
      static_cast<void>(SignalWorker(childProcessId_, childProcessGroupId_, SIGTERM));
      if (!WaitForChildExit(childProcessId_, 250)) {
        static_cast<void>(SignalWorker(childProcessId_, childProcessGroupId_, SIGKILL));
        int status = 0;
        static_cast<void>(waitpid(childProcessId_, &status, 0));
      }
    }
  }
  if (childProcessId_ >= 0 && childGroupIdentitySafe) {
    // The direct child may have exited during the wait, but its process group
    // may still contain descendants. The group ID cannot be reused while that
    // group exists; ESRCH is the safe idempotent outcome when it is already
    // gone.
    static_cast<void>(SignalWorkerGroupOnly(childProcessGroupId_, SIGKILL));
  }
  if (childProcessId_ >= 0 && childAlreadyExited) {
    int status = 0;
    static_cast<void>(waitpid(childProcessId_, &status, 0));
  }
  childProcessId_ = -1;
  childProcessGroupId_ = -1;
  transport_.reset();
}

bool WorkerRuntime::TerminateForFault() {
  if (!transport_) return false;
  bool terminated = true;
  if (childProcessId_ >= 0) {
    siginfo_t childInfo{};
    const auto result = waitid(P_PID, childProcessId_, &childInfo, WEXITED | WNOHANG | WNOWAIT);
    const auto childAlreadyExited = result == 0 && childInfo.si_pid == childProcessId_;
    const auto childIsRunning = result == 0 && childInfo.si_pid == 0;
    if (childIsRunning || (result < 0 && errno != ECHILD)) {
      static_cast<void>(SignalWorker(childProcessId_, childProcessGroupId_, SIGKILL));
      terminated = WaitForChildExit(childProcessId_, 250);
      if (!terminated) {
        int status = 0;
        static_cast<void>(SignalWorker(childProcessId_, childProcessGroupId_, SIGKILL));
        const auto waited = waitpid(childProcessId_, &status, 0);
        terminated = waited == childProcessId_ || (waited < 0 && errno == ECHILD);
      }
      static_cast<void>(SignalWorkerGroupOnly(childProcessGroupId_, SIGKILL));
    } else if (childAlreadyExited) {
      // The direct child already exited. Descendants can remain in its
      // process group, so target the group before reaping and clearing its
      // identity.
      terminated = SignalWorkerGroupOnly(childProcessGroupId_, SIGKILL);
      int status = 0;
      static_cast<void>(waitpid(childProcessId_, &status, 0));
    }
    childProcessId_ = -1;
    childProcessGroupId_ = -1;
  }
  if (controlWriteDescriptor_ >= 0) {
    close(controlWriteDescriptor_);
    controlWriteDescriptor_ = -1;
  }
  if (responseReadDescriptor_ >= 0) {
    close(responseReadDescriptor_);
    responseReadDescriptor_ = -1;
  }
  transport_->PublishHealth(WorkerHealth::kFaulted);
  return terminated;
}

bool WorkerRuntime::SetState(const WorkerState& state) {
  if (!startup_ || !transport_ || !IsValidWorkerState(state)
    || !WriteWorkerControlCommand(controlWriteDescriptor_, WorkerControlCommand::kStateSet)
    || !WriteWorkerState(controlWriteDescriptor_, state)) return false;
  const auto response = ReadWorkerEditorResponse(responseReadDescriptor_);
  if (!response || !response->success) return false;
  startup_->state = state;
  return true;
}

std::optional<WorkerState> WorkerRuntime::GetState() {
  if (!transport_ || responseReadDescriptor_ < 0
    || !WriteWorkerControlCommand(controlWriteDescriptor_, WorkerControlCommand::kStateGet)) return std::nullopt;
  return ReadWorkerState(responseReadDescriptor_);
}

bool WorkerRuntime::Restart() {
  if (!startup_ || !IsValidWorkerHostConfiguration(configuration_) || restartCount_ >= kMaximumWorkerRestarts) return false;
  ++restartCount_;
  const auto startup = *startup_;
  const auto configuration = configuration_;
  const auto request = transportRequest_;
  Stop();
  return Start(startup, configuration, request);
}

bool WorkerRuntime::PublishSubmission(
  const std::size_t slotIndex,
  const std::uint64_t sequence,
  const std::size_t numSamples,
  const std::span<const WorkerTransportEvent> events,
  const WorkerBlockContext& context
) {
  return transport_ && transport_->Submit(slotIndex, sequence, numSamples, events, context);
}

bool WorkerRuntime::CancelPublishedSubmission(const std::size_t slotIndex, const std::uint64_t sequence) {
  return transport_ && transport_->CancelSubmit(slotIndex, sequence);
}

bool WorkerRuntime::DispatchPublishedSubmission(const std::size_t slotIndex, const std::uint64_t sequence) {
  if (!transport_ || transport_->slot(slotIndex).sequence != sequence) return false;
  if (startup_ && startup_->setup.mode == WorkerProcessSetup::Mode::kRealtime) {
    return true;
  }
  return WriteWorkerControlCommand(controlWriteDescriptor_, WorkerControlCommand::kProcess);
}

bool WorkerRuntime::NotifyRealtimeWorker() noexcept {
  if (wakeWriteDescriptor_ < 0) return false;
  constexpr std::uint8_t wakeByte = 1;
  while (true) {
    const auto result = write(wakeWriteDescriptor_, &wakeByte, sizeof(wakeByte));
    if (result == static_cast<ssize_t>(sizeof(wakeByte))) return true;
    if (result < 0 && errno == EINTR) continue;
    return result < 0 && (errno == EAGAIN || errno == EWOULDBLOCK);
  }
}

bool WorkerRuntime::WaitForOfflineCompletion(
  const std::size_t slotIndex,
  const std::uint64_t sequence,
  const std::chrono::milliseconds timeout
) {
  if (!transport_ || !startup_ || startup_->setup.mode != WorkerProcessSetup::Mode::kOffline
    || responseReadDescriptor_ < 0 || sequence == 0) return false;
  pollfd descriptor{.fd = responseReadDescriptor_, .events = POLLIN, .revents = 0};
  const auto result = poll(&descriptor, 1, static_cast<int>(timeout.count()));
  if (result <= 0 || (descriptor.revents & POLLIN) == 0) return false;
  const auto response = ReadWorkerProcessResponse(responseReadDescriptor_);
  return response
    && response->first == sequence
    && response->second
    && transport_->Read(slotIndex, sequence);
}

std::optional<WorkerEditorResponse> WorkerRuntime::ExecuteEditorCommand(
  const WorkerControlCommand command,
  const std::uint32_t width,
  const std::uint32_t height,
  const std::optional<WorkerEditorAnchor> anchor
) {
  if (!transport_ || responseReadDescriptor_ < 0
    || command < WorkerControlCommand::kEditorOpen || command > WorkerControlCommand::kEditorStatus
    || (anchor && command != WorkerControlCommand::kEditorOpen && command != WorkerControlCommand::kEditorFocus)
    || !WriteWorkerControlCommand(controlWriteDescriptor_, command, width, height, anchor)) {
    return std::nullopt;
  }
  return ReadWorkerEditorResponse(responseReadDescriptor_);
}

bool WorkerRuntime::ReadCompleted(const std::size_t slotIndex, const std::uint64_t expectedSequence) const {
  return transport_ && transport_->Read(slotIndex, expectedSequence);
}

bool WorkerRuntime::CopyCompletedOutput(
  const std::size_t slotIndex,
  const std::uint64_t expectedSequence,
  const std::span<float> output,
  std::uint64_t* const outputSilenceFlags
) {
  if (!transport_ || !transport_->Read(slotIndex, expectedSequence)) return false;
  const auto source = transport_->output(slotIndex);
  const std::size_t samples = transport_->numSamples(slotIndex);
  const std::size_t channels = transport_->outputChannels();
  const auto silenceFlags = transport_->outputSilenceFlags(slotIndex);
  if (output.size() < samples * channels) {
    static_cast<void>(transport_->ReleaseCompleted(slotIndex, expectedSequence));
    return false;
  }
  for (std::size_t channel = 0; channel < channels; ++channel) {
    std::memcpy(
      output.data() + channel * samples,
      source.data() + channel * transport_->maximumFrames(),
      samples * sizeof(float)
    );
  }
  if (outputSilenceFlags != nullptr) *outputSilenceFlags = silenceFlags;
  return transport_->ReleaseCompleted(slotIndex, expectedSequence);
}

bool WorkerRuntime::CopyInput(const std::size_t slotIndex, const std::span<const float> input) {
  if (!transport_) return false;
  auto destination = transport_->input(slotIndex);
  const std::size_t channels = transport_->inputChannels();
  if (channels == 0 || input.size() % channels != 0) return false;
  const std::size_t samples = input.size() / channels;
  if (samples > transport_->maximumFrames()) return false;
  for (std::size_t channel = 0; channel < channels; ++channel) {
    std::memcpy(
      destination.data() + channel * transport_->maximumFrames(),
      input.data() + channel * samples,
      samples * sizeof(float)
    );
  }
  return true;
}

bool WorkerRuntime::DiscardLate(const std::size_t slotIndex, const std::uint64_t sequence) {
  return transport_ && transport_->DropLate(slotIndex, sequence);
}

WorkerHealth WorkerRuntime::callbackHealth() const {
  return transport_ ? transport_->health() : WorkerHealth::kStopped;
}

WorkerHealth WorkerRuntime::health() const {
  if (!transport_) return WorkerHealth::kStopped;
  if (childProcessId_ >= 0) {
    siginfo_t childInfo{};
    const auto result = waitid(P_PID, childProcessId_, &childInfo, WEXITED | WNOHANG | WNOWAIT);
    if (result == 0 && childInfo.si_pid == childProcessId_) return WorkerHealth::kFaulted;
  }
  return transport_->health();
}

int WorkerRuntime::processGroupId() const noexcept {
  return childProcessGroupId_;
}

std::optional<WorkerDiagnostic> WorkerRuntime::ReadDiagnostic() {
  return transport_ ? transport_->ReadDiagnostic() : std::nullopt;
}

std::optional<WorkerTailMetadata> WorkerRuntime::ReadTailMetadata() const {
  return transport_ ? transport_->ReadTailMetadata() : std::nullopt;
}

const WorkerTransport* WorkerRuntime::transport() const {
  return transport_ ? &*transport_ : nullptr;
}

}  // namespace daw::plugin_host
