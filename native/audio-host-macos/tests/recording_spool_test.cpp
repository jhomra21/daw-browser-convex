#include "../src/recording-spool.h"

#include <array>
#include <atomic>
#include <bit>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <limits>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <vector>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

using namespace daw::audio_host_macos;

// Only the dedicated test compilation renames its dequeue calls. Production
// core and host objects have no timing seam, macro, hook, or wrapper.
#ifdef DAW_RECORDING_SPOOL_TEST_DEQUEUE
#undef daw_audio_recording_capture_dequeue
extern "C" daw_audio_core_result daw_audio_recording_capture_dequeue(
  daw_audio_core_handle, daw_audio_recording_capture_block*);
namespace {
struct EmptyDrainGate {
  daw_audio_core_handle capture = 0;
  std::mutex mutex;
  std::condition_variable changed;
  bool entered = false;
  bool released = false;
  void AwaitBlocked() {
    std::unique_lock lock(mutex);
    if (!changed.wait_for(lock, std::chrono::seconds(5), [&] { return entered; })) {
      throw std::runtime_error("empty-drain test gate timeout");
    }
  }
  void Release() {
    {
      std::lock_guard lock(mutex);
      released = true;
    }
    changed.notify_all();
  }
};
std::atomic<EmptyDrainGate*> empty_drain_gate{nullptr};
}
extern "C" daw_audio_core_result daw_recording_spool_test_dequeue(
  daw_audio_core_handle capture, daw_audio_recording_capture_block* block) {
  const auto result = daw_audio_recording_capture_dequeue(capture, block);
  auto* gate = empty_drain_gate.load(std::memory_order_acquire);
  if (result == DAW_AUDIO_CORE_NO_DATA && gate != nullptr && gate->capture == capture) {
    std::unique_lock lock(gate->mutex);
    if (!gate->entered) {
      gate->entered = true;
      gate->changed.notify_all();
      gate->changed.wait(lock, [&] { return gate->released; });
    }
  }
  return result;
}
#endif

namespace {

void Check(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

struct Fixture {
  std::string parent;
  SpoolRequest request;
  std::atomic<bool> cancelled{false};
  Fixture() {
    char path[] = "/private/tmp/daw-recording-spool-XXXXXX";
    Check(mkdtemp(path) != nullptr, "mkdtemp");
    parent = path;
    request.root_path = parent + "/recording-spool";
    Check(mkdir(request.root_path.c_str(), 0700) == 0, "mkdir");
    struct stat status{};
    Check(stat(request.root_path.c_str(), &status) == 0, "stat root");
    request.root_device = status.st_dev;
    request.root_inode = status.st_ino;
    request.token = std::string(64, 'a');
    request.capture = {
      .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
      .generation = 7,
      .session_id = 91,
      .channel_count = 2,
      .input_channels = {0, 1},
      .gain = 1,
      .polarity = 1,
      .punch_start_frame = 0,
      .punch_end_frame = -1,
    };
  }
  ~Fixture() { std::filesystem::remove_all(parent); }
  std::string Partial() const { return request.root_path + "/" + request.token + ".partial"; }
  std::string Final() const { return request.root_path + "/" + request.token + ".pcm"; }
};

struct InjectedIo final : RecordingSpoolIo {
  enum class Fault { kNone, kShortEintr, kZero, kDiskFull, kOversized, kSync, kDirectorySync, kClose, kPublish, kCreatedStat };
  Fault fault = Fault::kNone;
  int writes = 0;
  int syncs = 0;
  int publications = 0;
  std::size_t written = 0;
  bool block_write = false;
  bool block_publish = false;
  bool block_sync = false;
  std::mutex mutex;
  std::condition_variable changed;
  bool entered = false;
  bool released = false;

  void Block() {
    std::unique_lock lock(mutex);
    entered = true;
    changed.notify_all();
    changed.wait(lock, [&] { return released; });
  }
  void AwaitBlocked() {
    std::unique_lock lock(mutex);
    Check(changed.wait_for(lock, std::chrono::seconds(5), [&] { return entered; }), "test IO did not block");
  }
  void Release() {
    std::lock_guard lock(mutex);
    released = true;
    changed.notify_all();
  }
  ssize_t Write(int fd, const void* bytes, std::size_t count) override {
    ++writes;
    if (block_write) Block();
    if (fault == Fault::kShortEintr && writes == 1) { errno = EINTR; return -1; }
    if (fault == Fault::kZero) return 0;
    if (fault == Fault::kOversized) return count + 1;
    if (fault == Fault::kDiskFull && writes > 2) { errno = ENOSPC; return -1; }
    if (fault == Fault::kShortEintr || fault == Fault::kDiskFull) count = std::min<std::size_t>(count, 3);
    const auto result = RecordingSpoolIo::Write(fd, bytes, count);
    if (result > 0) written += result;
    return result;
  }
  int Sync(int fd) override {
    ++syncs;
    if (block_sync) Block();
    struct stat status{};
    Check(fstat(fd, &status) == 0, "stat sync fd");
    if (fault == Fault::kSync || (fault == Fault::kDirectorySync && S_ISDIR(status.st_mode))) {
      errno = EIO;
      return -1;
    }
    if (fault == Fault::kShortEintr && syncs == 1) { errno = EINTR; return -1; }
    return RecordingSpoolIo::Sync(fd);
  }
  int Close(int fd) override {
    const int result = RecordingSpoolIo::Close(fd);
    if (fault == Fault::kClose) { errno = EIO; return -1; }
    return result;
  }
  int Publish(int root, const char* partial, const char* final) override {
    ++publications;
    if (block_publish) Block();
    if (fault == Fault::kPublish) { errno = EIO; return -1; }
    return RecordingSpoolIo::Publish(root, partial, final);
  }
  int StatCreated(int fd, struct stat* status) override {
    if (fault == Fault::kCreatedStat) { errno = EIO; return -1; }
    return RecordingSpoolIo::StatCreated(fd, status);
  }
};

const std::array<float, 3> left{1.0F, -2.0F, 0.5F};
const std::array<float, 3> right{3.0F, 4.0F, -0.25F};
daw_audio_recording_capture_block Block(std::uint64_t sequence = 0, std::uint32_t frames = 3) {
  return {
    .generation = 7, .session_id = 91, .sequence = sequence, .block_id = 0,
    .frame_count = frames, .channel_count = 2,
    .planes = {left.data(), right.data()}, .rms = 0, .peak = 0,
  };
}
std::vector<unsigned char> Read(const std::string& path) {
  std::ifstream input(path, std::ios::binary);
  return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}
void AppendBytes(std::vector<unsigned char>& bytes, std::uint32_t value) {
  for (int shift = 0; shift < 32; shift += 8) bytes.push_back(value >> shift);
}
void Await(const std::function<bool()>& predicate) {
  // Test-only bounded wait; production uses capture notifications, never polling.
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (!predicate()) {
    Check(std::chrono::steady_clock::now() < deadline, "test status timeout");
    std::this_thread::yield();
  }
}
void FinishCore(const std::shared_ptr<RecordingSpoolSession>& session, std::uint32_t frames = 3) {
  const float* planes[]{left.data(), right.data()};
  Check(daw_audio_recording_capture_process(session->CaptureHandle(), planes, 2, frames, 0) == DAW_AUDIO_CORE_OK, "process");
  Check(daw_audio_recording_capture_finalize(session->CaptureHandle(), frames) == DAW_AUDIO_CORE_OK, "finalize");
}

void ExactFormat() {
  Fixture fixture;
  auto io = std::make_shared<InjectedIo>();
  io->fault = InjectedIo::Fault::kShortEintr;
  RecordingSpoolFile file(fixture.request, io);
  Check(file.Open(), "open");
  Check(file.Append(Block(), fixture.cancelled), "append short/EINTR");
  Check(file.Append(Block(1, 1), fixture.cancelled), "short final block");
  Check(file.Finish({4, 40, 2}, fixture.cancelled), "finish");
  const auto result = file.Result();
  Check(result && result->totals.frames == 4 && result->totals.bytes == 40 && result->totals.blocks == 2, "totals");
  struct stat status{};
  Check(stat(fixture.Final().c_str(), &status) == 0 && (status.st_mode & 0777) == 0600, "file mode");
  Check(result->file_device == std::uint64_t(status.st_dev) && result->file_inode == std::uint64_t(status.st_ino), "file identity");
  std::vector<unsigned char> expected;
  AppendBytes(expected, 3);
  for (float value : left) AppendBytes(expected, std::bit_cast<std::uint32_t>(value));
  for (float value : right) AppendBytes(expected, std::bit_cast<std::uint32_t>(value));
  AppendBytes(expected, 1);
  AppendBytes(expected, std::bit_cast<std::uint32_t>(left[0]));
  AppendBytes(expected, std::bit_cast<std::uint32_t>(right[0]));
  Check(Read(fixture.Final()) == expected, "exact OPFS byte encoding");
  const auto publications = io->publications;
  Check(file.Finish({4, 40, 2}, fixture.cancelled), "double finish idempotent");
  Check(io->publications == publications, "double publish");
  file.Abandon();
  file.Abandon();
  Check(std::filesystem::exists(fixture.Final()), "late abandon removed finalized source");
}

void WriteFailures() {
  for (auto fault : {InjectedIo::Fault::kZero, InjectedIo::Fault::kDiskFull, InjectedIo::Fault::kOversized}) {
    Fixture fixture;
    auto io = std::make_shared<InjectedIo>();
    io->fault = fault;
    RecordingSpoolFile file(fixture.request, io);
    Check(file.Open(), "open");
    Check(!file.Append(Block(), fixture.cancelled), "expected write failure");
    const auto progress = file.Progress();
    Check(progress.frames == 0 && progress.blocks == 0 && progress.bytes == io->written, "partial physical bytes not exact");
    const auto calls = io->writes;
    Check(!file.Append(Block(), fixture.cancelled) && io->writes == calls, "write failure not sticky");
    Check(!file.Finish({3, 28, 1}, fixture.cancelled) && !file.Result(), "partial success");
    file.Abandon();
    Check(!std::filesystem::exists(fixture.Partial()), "partial leaked");
  }
}
void InvalidBlocks() {
  for (int fault = 0; fault < 8; ++fault) {
    Fixture fixture;
    RecordingSpoolFile file(fixture.request);
    Check(file.Open(), "open");
    auto block = Block();
    switch (fault) {
      case 0: block.sequence = 1; break;
      case 1: block.generation++; break;
      case 2: block.session_id++; break;
      case 3: block.frame_count = 0; break;
      case 4: block.frame_count = 2049; break;
      case 5: block.channel_count = 1; break;
      case 6: block.planes[1] = nullptr; break;
      case 7:
        Check(file.Append(block, fixture.cancelled), "initial append");
        break;
    }
    Check(!file.Append(block, fixture.cancelled), "invalid block accepted");
    Check(!file.Finish(file.Progress(), fixture.cancelled) && !file.Result(), "invalid block finalized");
  }
}
void BadRootsTokens() {
  for (int fault = 0; fault < 11; ++fault) {
    Fixture fixture;
    switch (fault) {
      case 0: fixture.request.root_inode++; break;
      case 1: fixture.request.root_device++; break;
      case 2: chmod(fixture.request.root_path.c_str(), 0755); break;
      case 3: fixture.request.root_path += "/"; break;
      case 4: fixture.request.root_path = "relative"; break;
      case 5: fixture.request.root_path = fixture.parent + "/../recording-spool"; break;
      case 6: fixture.request.token = "../escape"; break;
      case 7: fixture.request.token = std::string(64, 'G'); break;
      case 8: fixture.request.token = std::string(63, 'a'); break;
      case 9: {
        const auto alias = fixture.parent + "/alias";
        Check(symlink(fixture.request.root_path.c_str(), alias.c_str()) == 0, "symlink");
        fixture.request.root_path = alias;
        break;
      }
      case 10: {
        const auto alias = fixture.parent + "/alias";
        Check(symlink(fixture.parent.c_str(), alias.c_str()) == 0, "symlink intermediate");
        fixture.request.root_path = alias + "/recording-spool";
        break;
      }
    }
    RecordingSpoolFile file(fixture.request);
    Check(!file.Open() && !file.Result(), "unsafe root/token accepted");
  }
}
void ExclusiveAndIdentity() {
  {
    Fixture fixture;
    std::ofstream(fixture.Partial()) << "existing";
    RecordingSpoolFile file(fixture.request);
    Check(!file.Open(), "partial collision accepted");
    file.Abandon();
    Check(Read(fixture.Partial()).size() == 8, "unowned partial removed");
  }
  {
    Fixture fixture;
    Check(symlink("missing", fixture.Partial().c_str()) == 0, "partial symlink");
    RecordingSpoolFile file(fixture.request);
    Check(!file.Open(), "partial symlink accepted");
    Check(std::filesystem::is_symlink(fixture.Partial()), "unowned symlink removed");
  }
  {
    Fixture fixture;
    RecordingSpoolFile file(fixture.request);
    Check(file.Open(), "open");
    Check(file.Append(Block(), fixture.cancelled), "append");
    Check(rename(fixture.Partial().c_str(), (fixture.Partial() + ".owned").c_str()) == 0, "move partial");
    std::ofstream(fixture.Partial()) << "replacement";
    Check(!file.Finish({3, 28, 1}, fixture.cancelled), "replaced partial published");
    file.Abandon();
    Check(Read(fixture.Partial()).size() == 11, "replacement removed");
  }
  {
    Fixture fixture;
    RecordingSpoolFile file(fixture.request);
    Check(file.Open() && file.Append(Block(), fixture.cancelled), "append");
    const auto original = fixture.request.root_path + ".original";
    Check(rename(fixture.request.root_path.c_str(), original.c_str()) == 0, "move root");
    Check(mkdir(fixture.request.root_path.c_str(), 0700) == 0, "replacement root");
    Check(!file.Finish({3, 28, 1}, fixture.cancelled), "moved root finalized");
    file.Abandon();
    Check(!std::filesystem::exists(original + "/" + fixture.request.token + ".partial"), "owned partial not cleaned via retained root");
  }
}
void FinishFailures() {
  for (auto fault : {InjectedIo::Fault::kSync, InjectedIo::Fault::kClose, InjectedIo::Fault::kPublish, InjectedIo::Fault::kDirectorySync}) {
    Fixture fixture;
    auto io = std::make_shared<InjectedIo>();
    io->fault = fault;
    RecordingSpoolFile file(fixture.request, io);
    Check(file.Open() && file.Append(Block(), fixture.cancelled), "append");
    Check(!file.Finish({3, 28, 1}, fixture.cancelled) && !file.Result(), "finish failure reported success");
    Check(!file.Finish({3, 28, 1}, fixture.cancelled), "finish error not sticky");
    file.Abandon();
    Check(!std::filesystem::exists(fixture.Partial()), "failed partial remains");
    Check(std::filesystem::exists(fixture.Final()) == (fault == InjectedIo::Fault::kDirectorySync), "published indeterminate source not retained");
  }
  {
    Fixture fixture;
    RecordingSpoolFile file(fixture.request);
    Check(file.Open() && file.Append(Block(), fixture.cancelled), "append");
    std::ofstream(fixture.Final()) << "retain";
    Check(!file.Finish({3, 28, 1}, fixture.cancelled), "exclusive publish collision accepted");
    file.Abandon();
    Check(Read(fixture.Final()).size() == 6, "existing finalized source overwritten/deleted");
  }
  for (auto totals : {SpoolTotals{4, 28, 1}, SpoolTotals{3, 29, 1}, SpoolTotals{3, 28, 2}}) {
    Fixture fixture;
    RecordingSpoolFile file(fixture.request);
    Check(file.Open() && file.Append(Block(), fixture.cancelled), "append");
    Check(!file.Finish(totals, fixture.cancelled) && !file.Result(), "totals mismatch accepted");
  }
}
void Cancellation() {
  {
    Fixture fixture;
    auto io = std::make_shared<InjectedIo>();
    io->block_sync = true;
    RecordingSpoolFile file(fixture.request, io);
    Check(file.Open() && file.Append(Block(), fixture.cancelled), "append");
    bool finished = true;
    std::thread writer([&] { finished = file.Finish({3, 28, 1}, fixture.cancelled); });
    io->AwaitBlocked();
    fixture.cancelled.store(true);
    io->Release();
    writer.join();
    Check(!finished && !file.Result() && !std::filesystem::exists(fixture.Final()), "cancel during fsync published");
    file.Abandon();
  }
  {
    Fixture fixture;
    auto io = std::make_shared<InjectedIo>();
    io->block_write = true;
    RecordingSpoolFile file(fixture.request, io);
    Check(file.Open(), "open");
    bool appended = true;
    std::thread writer([&] { appended = file.Append(Block(), fixture.cancelled); });
    io->AwaitBlocked();
    fixture.cancelled.store(true);
    Check(std::filesystem::exists(fixture.Partial()), "unlink while IO owned");
    io->Release();
    writer.join();
    Check(!appended && !file.Result(), "cancelled write completed take");
    file.Abandon();
    Check(!std::filesystem::exists(fixture.Partial()), "cancel cleanup");
  }
  {
    Fixture fixture;
    auto io = std::make_shared<InjectedIo>();
    io->block_publish = true;
    RecordingSpoolFile file(fixture.request, io);
    Check(file.Open() && file.Append(Block(), fixture.cancelled), "append");
    bool finished = false;
    std::thread writer([&] { finished = file.Finish({3, 28, 1}, fixture.cancelled); });
    io->AwaitBlocked();
    fixture.cancelled.store(true);
    io->Release();
    writer.join();
    Check(finished && file.Result(), "successful publication must be retained/observable despite late cancel");
    file.Abandon();
    Check(std::filesystem::exists(fixture.Final()), "late cancel deleted publication");
  }
}
void ServiceDrain() {
  Fixture fixture;
  RecordingSpoolService service;
  auto session = service.Start(fixture.request);
  Check(session != nullptr, "start");
  Await([&] { return session->Snapshot().state != SpoolState::kPreparing; });
  Check(session->Snapshot().state == SpoolState::kReady && session->CaptureHandle() != 0, "ready");
  FinishCore(session);
  Check(session->Finish(3), "request finish");
  Check(!session->Finish(3), "double session finish accepted");
  Await([&] { return session->Snapshot().state == SpoolState::kComplete; });
  Check(session->Result() && session->Result()->totals.frames == 3, "native drain result");
  daw_audio_recording_capture_diagnostics diagnostics{};
  Check(daw_audio_recording_capture_get_diagnostics(session->CaptureHandle(), &diagnostics) == DAW_AUDIO_CORE_OK, "diagnostics");
  Check(diagnostics.queued_blocks == 0 && diagnostics.available_blocks == 32 && diagnostics.dropped_frames == 0, "core slot release");
  session->Abandon();
  Check(std::filesystem::exists(fixture.Final()), "session late cancel removed take");
}
void ServiceRetirement() {
  Fixture fixture;
  auto io = std::make_shared<InjectedIo>();
  io->block_write = true;
  RecordingSpoolService service(io);
  auto session = service.Start(fixture.request);
  Check(session != nullptr, "start");
  Await([&] { return session->Snapshot().state == SpoolState::kReady; });
  FinishCore(session);
  service.NotifyCapture();
  io->AwaitBlocked();
  std::weak_ptr<RecordingSpoolSession> lifetime = session;
  session->Abandon();
  session.reset();
  Check(!lifetime.expired(), "blocked IO session freed with caller");
  Check(!service.Start(fixture.request), "retired writer allowed additional start");
  Check(std::filesystem::exists(fixture.Partial()), "blocked retired partial unlinked");
  io->Release();
  Await([&] { return lifetime.expired(); });
  Check(!std::filesystem::exists(fixture.Partial()), "retired cleanup");
  io->block_write = false;
  auto replacement = service.Start(fixture.request);
  Check(replacement != nullptr, "retirement never released admission");
  Await([&] { return replacement->Snapshot().state == SpoolState::kReady; });
  replacement->Abandon();
  Await([&] { return replacement->Snapshot().state == SpoolState::kCancelled; });
}
void ServiceFailureAndRepeatedSessions() {
  Fixture fixture;
  RecordingSpoolService service;
  for (int index = 0; index < 20; ++index) {
    auto session = service.Start(fixture.request);
    Check(session != nullptr, "repeated start");
    Await([&] { return session->Snapshot().state == SpoolState::kReady; });
    FinishCore(session);
    Check(session->Finish(4), "finish request");
    Await([&] { return session->Snapshot().state == SpoolState::kFailed; });
    Check(!session->Result(), "native mismatch accepted");
    Check(!std::filesystem::exists(fixture.Partial()), "failure leaked partial");
  }
}
void ServiceEmptyActiveAndOverflow() {
  {
    Fixture fixture;
    RecordingSpoolService service;
    auto session = service.Start(fixture.request);
    Check(session != nullptr, "start empty");
    Await([&] { return session->Snapshot().state == SpoolState::kReady; });
    Check(daw_audio_recording_capture_finalize(session->CaptureHandle(), 0) == DAW_AUDIO_CORE_OK, "empty finalize");
    Check(session->Finish(0), "empty finish");
    Await([&] { return session->Snapshot().state == SpoolState::kComplete; });
    Check(session->Result() && Read(fixture.Final()).empty(), "empty exact take");
  }
  {
    Fixture fixture;
    RecordingSpoolService service;
    auto session = service.Start(fixture.request);
    Check(session != nullptr, "start active");
    Await([&] { return session->Snapshot().state == SpoolState::kReady; });
    Check(session->Finish(0), "active finish request");
    Await([&] { return session->Snapshot().state == SpoolState::kFailed; });
    Check(!session->Result() && !std::filesystem::exists(fixture.Final()), "active take finalized");
  }
  {
    Fixture fixture;
    RecordingSpoolService service;
    auto session = service.Start(fixture.request);
    Check(session != nullptr, "start overflow");
    Await([&] { return session->Snapshot().state == SpoolState::kReady; });
    std::array<float, 2048> plane{};
    const float* planes[]{plane.data(), plane.data()};
    bool overflow = false;
    for (int block = 0; block < 34; ++block) {
      overflow |= daw_audio_recording_capture_process(session->CaptureHandle(), planes, 2, 2048, block * 2048)
        != DAW_AUDIO_CORE_OK;
    }
    Check(overflow, "failure-first overload fixture did not overflow original 32slot core");
    service.NotifyCapture();
    Await([&] { return session->Snapshot().state == SpoolState::kFailed; });
    Check(!session->Result() && !std::filesystem::exists(fixture.Final()), "real native drop accepted");
  }
}

bool Terminal(SpoolState state) {
  return state == SpoolState::kComplete || state == SpoolState::kFailed || state == SpoolState::kCancelled;
}
void AcceptedFinishSurvivesCancelAndShutdown() {
  for (bool shutdown : {false, true}) {
    Fixture fixture;
    auto io = std::make_shared<InjectedIo>();
    io->block_sync = true;
    auto service = std::make_unique<RecordingSpoolService>(io);
    auto session = service->Start(fixture.request);
    Check(session != nullptr, "finish start");
    Await([&] { return session->Snapshot().state == SpoolState::kReady; });
    FinishCore(session);
    Check(session->Finish(3), "accepted finish");
    io->AwaitBlocked();
    const bool abandoned = shutdown ? false : session->Abandon();
    std::atomic<bool> shutdown_entered{false};
    std::thread destroyer;
    if (shutdown) {
      destroyer = std::thread([&] {
        shutdown_entered.store(true, std::memory_order_release);
        service.reset();
      });
      Await([&] { return shutdown_entered.load(std::memory_order_acquire); });
    }
    io->Release();
    if (destroyer.joinable()) destroyer.join();
    Await([&] { return Terminal(session->Snapshot().state); });
    Check(!abandoned, "Abandon must refuse accepted Finish");
    Check(session->Snapshot().state == SpoolState::kComplete && session->Result(), "accepted finish cancelled");
    Check(std::filesystem::exists(fixture.Final()) && !std::filesystem::exists(fixture.Partial()), "finished source lost");
  }
  {
    Fixture fixture;
    RecordingSpoolService service;
    auto session = service.Start(fixture.request);
    Check(session != nullptr, "abandon-first start");
    Await([&] { return session->Snapshot().state == SpoolState::kReady; });
    Check(session->Abandon(), "abandon-first rejected");
    Check(!session->Finish(0), "finish after accepted abandon");
    Await([&] { return session->Snapshot().state == SpoolState::kCancelled; });
  }
  {
    Fixture fixture;
    auto io = std::make_shared<InjectedIo>();
    io->fault = InjectedIo::Fault::kSync;
    io->block_sync = true;
    RecordingSpoolService service(io);
    auto session = service.Start(fixture.request);
    Check(session != nullptr, "error start");
    Await([&] { return session->Snapshot().state == SpoolState::kReady; });
    FinishCore(session);
    Check(session->Finish(3), "error finish");
    io->AwaitBlocked();
    const bool abandoned = session->Abandon();
    io->Release();
    Await([&] { return Terminal(session->Snapshot().state); });
    Check(!abandoned && session->Snapshot().state == SpoolState::kFailed
      && session->Snapshot().error == SpoolError::kSync, "storage failure disguised by cancellation");
  }
}

void RetentionFacts() {
  {
    Fixture fixture;
    auto io = std::make_shared<InjectedIo>();
    io->fault = InjectedIo::Fault::kDirectorySync;
    RecordingSpoolService service(io);
    auto session = service.Start(fixture.request);
    Check(session != nullptr, "retention start");
    Await([&] { return session->Snapshot().state == SpoolState::kReady; });
    FinishCore(session);
    Check(session->Finish(3), "retention finish");
    Await([&] { return Terminal(session->Snapshot().state); });
    const auto snapshot = session->Snapshot();
    Check(snapshot.state == SpoolState::kFailed && snapshot.published && !snapshot.partial_retained
      && snapshot.error == SpoolError::kSync && !session->Result(), "indeterminate published source invisible");
    Check(std::filesystem::exists(fixture.Final()), "published source removed");
  }
  for (bool unknown_identity : {false, true}) {
    Fixture fixture;
    auto io = std::make_shared<InjectedIo>();
    io->fault = unknown_identity ? InjectedIo::Fault::kCreatedStat : InjectedIo::Fault::kNone;
    io->block_sync = !unknown_identity;
    RecordingSpoolService service(io);
    auto session = service.Start(fixture.request);
    Check(session != nullptr, "partial retention start");
    if (!unknown_identity) {
      Await([&] { return session->Snapshot().state == SpoolState::kReady; });
      FinishCore(session);
      Check(session->Finish(3), "partial retention finish");
      io->AwaitBlocked();
      Check(rename(fixture.Partial().c_str(), (fixture.Partial() + ".owned").c_str()) == 0, "replace partial");
      std::ofstream(fixture.Partial()) << "replacement";
      io->Release();
    }
    Await([&] { return Terminal(session->Snapshot().state); });
    const auto snapshot = session->Snapshot();
    Check(snapshot.state == SpoolState::kFailed && !snapshot.published && snapshot.partial_retained
      && snapshot.error == SpoolError::kIdentity && !session->Result(), "unknown/replaced owned source not reported");
    Check(std::filesystem::exists(fixture.Partial()), "unknown/replaced partial deleted");
    if (!unknown_identity) Check(snapshot.system_error == 0, "pure identity mismatch retained stale errno");
  }
}

void StatusSignalEvents() {
  Fixture fixture;
  auto signal = std::make_shared<RecordingStatusSignal>();
  const auto initial = signal->Revision();
  RecordingSpoolService service({}, signal);
  auto session = service.Start(fixture.request);
  Check(session != nullptr, "signal start");
  const auto ready_revision = signal->Wait(initial);
  Check(ready_revision == initial + 1 && session->Snapshot().state == SpoolState::kReady, "ready wake before publication");
  FinishCore(session);
  Check(session->Finish(3), "signal finish");
  const auto terminal_revision = signal->Wait(ready_revision);
  Check(terminal_revision == ready_revision + 1 && session->Snapshot().state == SpoolState::kComplete
    && session->Result(), "terminal wake before publication");
  Check(signal->Wait(initial) == terminal_revision, "lost wake when observer starts late");
  const auto wake_revision = signal->Revision();
  std::uint64_t observed = 0;
  std::thread observer([&] { observed = signal->Wait(wake_revision); });
  signal->Notify();
  observer.join();
  Check(observed == wake_revision + 1, "independent shutdown wake lost");
}

void ExpectedBytesAndErrno() {
  for (auto totals : {SpoolTotals{std::numeric_limits<std::uint64_t>::max(), 0, 1},
    SpoolTotals{1, 0, std::numeric_limits<std::uint64_t>::max()}}) {
    Fixture fixture;
    RecordingSpoolFile file(fixture.request);
    Check(file.Open(), "overflow open");
    Check(!file.Finish(totals, fixture.cancelled) && file.Error() == SpoolError::kTotals
      && file.SystemError() == EOVERFLOW, "arithmetic overflow not distinguished");
  }
  {
    Fixture fixture;
    RecordingSpoolFile file(fixture.request);
    Check(file.Open() && file.Append(Block(), fixture.cancelled), "errno append");
    chmod(fixture.Partial().c_str(), 0644);
    errno = ENOSPC;
    Check(!file.Finish({3, 28, 1}, fixture.cancelled) && file.Error() == SpoolError::kIdentity
      && file.SystemError() == 0, "pure metadata mismatch echoes stale errno");
  }
}

void FinishArrivesDuringEmptyDrain() {
#ifdef DAW_RECORDING_SPOOL_TEST_DEQUEUE
  Fixture fixture;
  RecordingSpoolService service;
  auto session = service.Start(fixture.request);
  Check(session != nullptr, "race start");
  Await([&] { return session->Snapshot().state == SpoolState::kReady; });
  EmptyDrainGate gate;
  gate.capture = session->CaptureHandle();
  empty_drain_gate.store(&gate, std::memory_order_release);
  service.NotifyCapture();
  gate.AwaitBlocked();
  FinishCore(session);
  const bool accepted = session->Finish(3);
  gate.Release();
  Await([&] { return Terminal(session->Snapshot().state); });
  empty_drain_gate.store(nullptr, std::memory_order_release);
  Check(accepted && session->Snapshot().state == SpoolState::kComplete && session->Result(),
    "NO_DATA then final block/Finish rejected valid take");
  Check(session->Result()->totals == SpoolTotals{3, 28, 1}, "race exact final totals");
#else
  throw std::runtime_error("dedicated test dequeue seam not enabled");
#endif
}

void FinishDrainStress() {
  Fixture fixture;
  RecordingSpoolService service;
  for (int iteration = 0; iteration < 10000; ++iteration) {
    auto session = service.Start(fixture.request);
    Check(session != nullptr, "stress start");
    Await([&] { return session->Snapshot().state == SpoolState::kReady; });
    service.NotifyCapture();
    FinishCore(session);
    Check(session->Finish(3), "stress finish");
    Await([&] { return Terminal(session->Snapshot().state); });
    if (session->Snapshot().state != SpoolState::kComplete) {
      std::fprintf(stderr, "stochastic finish/drain failure at iteration %d\n", iteration);
      throw std::runtime_error("stochastic finish/drain race lost take");
    }
    Check(session->Result() && session->Result()->totals == SpoolTotals{3, 28, 1}, "stress result totals");
    Check(unlink(fixture.Final().c_str()) == 0, "remove verified test fixture");
  }
}
}

int main(int argc, char** argv) {
  if (argc == 2 && std::string(argv[1]) == "--stress") {
    try { FinishDrainStress(); std::puts("PASS 10000 finish/drain interleavings"); return 0; }
    catch (const std::exception& error) { std::fprintf(stderr, "FAIL stress: %s\n", error.what()); return 1; }
  }
  const std::array<std::pair<const char*, void(*)()>, 16> tests{{
    {"exact format / short writes / EINTR / idempotence", ExactFormat},
    {"sticky zero / diskfull / oversized write", WriteFailures},
    {"sequence / generation / session / layout", InvalidBlocks},
    {"root / mode / identity / token / symlink", BadRootsTokens},
    {"exclusive creation / retained inode / root replacement", ExclusiveAndIdentity},
    {"totals / fsync / close / publication / collision", FinishFailures},
    {"blocked write cancel / late publish cancel", Cancellation},
    {"independent native capture drain / exact slot release", ServiceDrain},
    {"blocked retirement / safe lifetime / bounded admission", ServiceRetirement},
    {"native mismatch / repeated service sessions", ServiceFailureAndRepeatedSessions},
    {"empty take / active finish / actual native overflow", ServiceEmptyActiveAndOverflow},
    {"accepted finish / abandon / process-scope shutdown", AcceptedFinishSurvivesCancelAndShutdown},
    {"published / unknown / replaced retained-source facts", RetentionFacts},
    {"ready / terminal / independent shared status wakes", StatusSignalEvents},
    {"derived byte overflow / pure identity errno", ExpectedBytesAndErrno},
    {"controlled empty drain then final publication", FinishArrivesDuringEmptyDrain},
  }};
  int failed = 0;
  for (const auto& [name, test] : tests) {
    try { test(); std::printf("PASS %s\n", name); }
    catch (const std::exception& error) { ++failed; std::fprintf(stderr, "FAIL %s: %s\n", name, error.what()); }
  }
  return failed == 0 ? 0 : 1;
}
