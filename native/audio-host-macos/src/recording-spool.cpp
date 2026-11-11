#include "recording-spool.h"

#include <array>
#include <bit>
#include <cerrno>
#include <condition_variable>
#include <cstdio>
#include <fcntl.h>
#include <limits>
#include <mutex>
#include <span>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>
#include <utility>

namespace daw::audio_host_macos {
namespace {

template <typename Call>
auto RetryInterrupted(Call&& call) {
  auto result = call();
  while (result < 0 && errno == EINTR) result = call();
  return result;
}

bool Identity(const struct stat& status, std::uint64_t device, std::uint64_t inode) {
  return std::uint64_t(status.st_dev) == device && std::uint64_t(status.st_ino) == inode;
}

bool PrivateDirectory(const struct stat& status) {
  return S_ISDIR(status.st_mode) && status.st_uid == getuid() && (status.st_mode & 07777) == 0700;
}

bool PrivateFile(const struct stat& status) {
  return S_ISREG(status.st_mode) && status.st_uid == getuid()
    && (status.st_mode & 07777) == 0600 && status.st_nlink == 1;
}

// Same component-walk boundary as desktop/native/file-capability-helper.c.
// /tmp and /var aliases on macOS must be canonicalized by main beforehand.
int OpenRoot(const std::string& path) {
  errno = 0;
  if (path.empty() || path.size() > 4096 || path.front() != '/' || path.back() == '/'
    || path.find('\0') != std::string::npos) return -1;
  int current = RetryInterrupted([] { return open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC); });
  if (current < 0) return -1;
  std::size_t start = 1;
  std::size_t components = 0;
  while (start < path.size()) {
    const auto end = path.find('/', start);
    const auto component = path.substr(start, end == std::string::npos ? path.size() - start : end - start);
    if (component.empty() || component == "." || component == ".."
      || component.size() > 255 || ++components > 256) {
      close(current);
      errno = 0;
      return -1;
    }
    const int next = RetryInterrupted([&] {
      return openat(current, component.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    });
    const int saved_error = errno;
    // close is deliberately never retried (fd reuse), matching desktop helper.
    close(current);
    if (next < 0) { errno = saved_error; return -1; }
    current = next;
    start = end == std::string::npos ? path.size() : end + 1;
  }
  return current;
}

bool ValidRequest(const SpoolRequest& request) {
  return request.token.size() == 64
    && request.token.find_first_not_of("0123456789abcdef") == std::string::npos
    && request.capture.abi_version == DAW_AUDIO_CORE_ABI_VERSION
    && request.capture.generation != 0 && request.capture.session_id != 0
    && request.capture.channel_count > 0
    && request.capture.channel_count <= DAW_AUDIO_RECORDING_CAPTURE_MAX_CHANNELS;
}

void EncodeWord(std::span<unsigned char, 4> bytes, std::uint32_t value) {
  for (std::size_t index = 0; index < bytes.size(); ++index) bytes[index] = value >> (index * 8);
}

std::optional<std::uint64_t> ExpectedBytes(
  std::uint64_t frames, std::uint64_t blocks, std::uint32_t channels) {
  const auto maximum = std::numeric_limits<std::uint64_t>::max();
  const std::uint64_t bytes_per_frame = std::uint64_t(channels) * 4;
  if (blocks > maximum / 4) return std::nullopt;
  const auto header_bytes = blocks * 4;
  if (frames > (maximum - header_bytes) / bytes_per_frame) return std::nullopt;
  const auto bytes = header_bytes + frames * bytes_per_frame;
  if (bytes > std::uint64_t(std::numeric_limits<off_t>::max())) return std::nullopt;
  return bytes;
}

}  // namespace

ssize_t RecordingSpoolIo::Write(int fd, const void* bytes, std::size_t count) {
  return write(fd, bytes, count);
}
int RecordingSpoolIo::Sync(int fd) { return fsync(fd); }
int RecordingSpoolIo::Close(int fd) { return close(fd); }
int RecordingSpoolIo::StatCreated(int fd, struct stat* status) { return fstat(fd, status); }
int RecordingSpoolIo::Publish(int root_fd, const char* partial, const char* final) {
  // No overwrite fallback on filesystems lacking exclusive rename support.
  return renameatx_np(root_fd, partial, root_fd, final, RENAME_EXCL);
}

struct RecordingSpoolFile::Impl {
  SpoolRequest request;
  std::shared_ptr<RecordingSpoolIo> io;
  std::string partial;
  std::string final;
  int root_fd = -1;
  int file_fd = -1;
  struct stat created{};
  SpoolTotals written;
  SpoolError error = SpoolError::kNone;
  int system_error = 0;
  bool opened = false;
  bool created_partial = false;
  bool identity_known = false;
  bool published = false;
  bool unlinked = false;
  bool abandoned = false;
  std::optional<SpoolResult> result;

  bool Fail(SpoolError failure, int native_error = 0) {
    if (error == SpoolError::kNone) {
      error = failure;
      system_error = native_error;
    }
    return false;
  }
  bool Cancelled(const std::atomic<bool>& cancelled) {
    if (!cancelled.load(std::memory_order_acquire) || published) return false;
    Fail(SpoolError::kCancelled);
    return true;
  }
  bool Matches(const char* name) const {
    struct stat status{};
    if (RetryInterrupted([&] { return fstatat(root_fd, name, &status, AT_SYMLINK_NOFOLLOW); }) != 0) return false;
    if (!PrivateFile(status) || !Identity(status, created.st_dev, created.st_ino)) {
      errno = 0;
      return false;
    }
    return true;
  }
  bool VerifyRoot() {
    const int current = OpenRoot(request.root_path);
    if (current < 0) return Fail(SpoolError::kInvalidRoot, errno);
    struct stat status{};
    const int result = RetryInterrupted([&] { return fstat(current, &status); });
    const int native_error = result != 0 ? errno : 0;
    close(current);
    if (result != 0) return Fail(SpoolError::kIdentity, native_error);
    return (PrivateDirectory(status) && Identity(status, request.root_device, request.root_inode))
      || Fail(SpoolError::kIdentity);
  }
  bool WriteAll(std::span<const unsigned char> bytes, const std::atomic<bool>& cancelled) {
    while (!bytes.empty()) {
      if (Cancelled(cancelled)) return false;
      const auto count = io->Write(file_fd, bytes.data(), bytes.size());
      if (count < 0 && errno == EINTR) continue;
      if (count <= 0 || std::uint64_t(count) > bytes.size()) {
        return Fail(SpoolError::kWrite, count < 0 ? errno : EIO);
      }
      written.bytes += count;
      bytes = bytes.subspan(count);
    }
    return !Cancelled(cancelled);
  }
  bool CloseFile() {
    if (file_fd < 0) return true;
    const int fd = std::exchange(file_fd, -1);
    return io->Close(fd) == 0 || Fail(SpoolError::kClose, errno);
  }
};

RecordingSpoolFile::RecordingSpoolFile(SpoolRequest request, std::shared_ptr<RecordingSpoolIo> io)
  : impl_(std::make_unique<Impl>()) {
  impl_->request = std::move(request);
  impl_->io = io ? std::move(io) : std::make_shared<RecordingSpoolIo>();
  impl_->partial = impl_->request.token + ".partial";
  impl_->final = impl_->request.token + ".pcm";
}

RecordingSpoolFile::~RecordingSpoolFile() {
  Abandon();
  if (impl_->root_fd >= 0) close(impl_->root_fd);
}

bool RecordingSpoolFile::Open() {
  auto& file = *impl_;
  if (file.error != SpoolError::kNone || file.opened || file.abandoned) return false;
  if (!ValidRequest(file.request)) return file.Fail(SpoolError::kInvalidRequest);
  file.root_fd = OpenRoot(file.request.root_path);
  if (file.root_fd < 0) return file.Fail(SpoolError::kInvalidRoot, errno);
  struct stat root{};
  if (RetryInterrupted([&] { return fstat(file.root_fd, &root); }) != 0) return file.Fail(SpoolError::kInvalidRoot, errno);
  if (!PrivateDirectory(root)) return file.Fail(SpoolError::kInvalidRoot);
  if (!Identity(root, file.request.root_device, file.request.root_inode)) return file.Fail(SpoolError::kIdentity);
  file.file_fd = RetryInterrupted([&] {
    return openat(file.root_fd, file.partial.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  });
  if (file.file_fd < 0) return file.Fail(errno == EEXIST ? SpoolError::kCollision : SpoolError::kWrite, errno);
  file.created_partial = true;
  if (RetryInterrupted([&] { return file.io->StatCreated(file.file_fd, &file.created); }) != 0) {
    // Identity unknown: never guess ownership and unlink another inode.
    return file.Fail(SpoolError::kIdentity, errno);
  }
  file.identity_known = true;
  if (!PrivateFile(file.created) || file.created.st_size != 0 || !file.Matches(file.partial.c_str())) {
    return file.Fail(SpoolError::kIdentity);
  }
  file.opened = true;
  return true;
}

bool RecordingSpoolFile::Append(
  const daw_audio_recording_capture_block& block, const std::atomic<bool>& cancelled) {
  auto& file = *impl_;
  if (file.error != SpoolError::kNone || !file.opened || file.published || file.abandoned) return false;
  if (file.Cancelled(cancelled)) return false;
  if (block.generation != file.request.capture.generation || block.session_id != file.request.capture.session_id
    || block.sequence != file.written.blocks || block.frame_count == 0
    || block.frame_count > DAW_AUDIO_RECORDING_CAPTURE_BLOCK_FRAMES
    || block.channel_count != file.request.capture.channel_count) return file.Fail(SpoolError::kLayout);
  for (std::uint32_t channel = 0; channel < block.channel_count; ++channel) {
    if (block.planes[channel] == nullptr) return file.Fail(SpoolError::kLayout);
  }
  const std::uint64_t block_bytes = 4 + std::uint64_t(block.frame_count) * block.channel_count * 4;
  if (file.written.bytes > std::uint64_t(std::numeric_limits<off_t>::max()) - block_bytes
    || file.written.frames > std::numeric_limits<std::uint64_t>::max() - block.frame_count
    || file.written.blocks == std::numeric_limits<std::uint64_t>::max()) return file.Fail(SpoolError::kTotals, EOVERFLOW);
  std::array<unsigned char, 4> header{};
  EncodeWord(header, block.frame_count);
  if (!file.WriteAll(header, cancelled)) return false;
  // Only fixed encoding scratch, not a second block queue. Core retains the
  // sole transport-owned slot through every synchronous write of its planes.
  std::array<unsigned char, DAW_AUDIO_RECORDING_CAPTURE_BLOCK_FRAMES * 4> plane{};
  static_assert(sizeof(float) == 4 && std::numeric_limits<float>::is_iec559);
  for (std::uint32_t channel = 0; channel < block.channel_count; ++channel) {
    for (std::uint32_t frame = 0; frame < block.frame_count; ++frame) {
      EncodeWord(std::span<unsigned char, 4>(plane.data() + frame * 4, 4),
        std::bit_cast<std::uint32_t>(block.planes[channel][frame]));
    }
    if (!file.WriteAll(std::span(plane).first(block.frame_count * 4), cancelled)) return false;
  }
  file.written.frames += block.frame_count;
  ++file.written.blocks;
  return true;
}

bool RecordingSpoolFile::Finish(SpoolTotals expected, const std::atomic<bool>& cancelled) {
  auto& file = *impl_;
  if (file.result) return expected == file.result->totals;
  if (file.error != SpoolError::kNone || !file.opened || file.abandoned) return false;
  if (file.Cancelled(cancelled)) return false;
  const auto bytes = ExpectedBytes(expected.frames, expected.blocks, file.request.capture.channel_count);
  if (!bytes) return file.Fail(SpoolError::kTotals, EOVERFLOW);
  if (expected.bytes != *bytes || expected != file.written) return file.Fail(SpoolError::kTotals);
  struct stat status{};
  if (RetryInterrupted([&] { return fstat(file.file_fd, &status); }) != 0) return file.Fail(SpoolError::kIdentity, errno);
  if (!PrivateFile(status) || !Identity(status, file.created.st_dev, file.created.st_ino)
    || status.st_size < 0 || std::uint64_t(status.st_size) != *bytes) return file.Fail(SpoolError::kIdentity);
  if (!file.VerifyRoot()) return false;
  if (!file.Matches(file.partial.c_str())) return file.Fail(SpoolError::kIdentity, errno);
  if (RetryInterrupted([&] { return file.io->Sync(file.file_fd); }) != 0) return file.Fail(SpoolError::kSync, errno);
  if (file.Cancelled(cancelled)) return false;
  if (!file.CloseFile()) return false;
  if (file.Cancelled(cancelled)) return false;
  if (!file.VerifyRoot()) return false;
  if (!file.Matches(file.partial.c_str())) return file.Fail(SpoolError::kIdentity, errno);
  if (RetryInterrupted([&] { return file.io->Publish(file.root_fd, file.partial.c_str(), file.final.c_str()); }) != 0) {
    return file.Fail(errno == EEXIST ? SpoolError::kCollision : SpoolError::kPublish, errno);
  }
  // Exclusive rename is the ownership handoff. Even if cancellation or a later
  // durability check fails, this published source is main-owned, never unlink it.
  file.published = true;
  if (RetryInterrupted([&] { return file.io->Sync(file.root_fd); }) != 0) return file.Fail(SpoolError::kSync, errno);
  if (!file.VerifyRoot()) return false;
  if (!file.Matches(file.final.c_str())) return file.Fail(SpoolError::kIdentity, errno);
  file.result = {
    .token = file.request.token,
    .generation = file.request.capture.generation,
    .session_id = file.request.capture.session_id,
    .channel_count = file.request.capture.channel_count,
    .root_device = file.request.root_device,
    .root_inode = file.request.root_inode,
    .file_device = std::uint64_t(file.created.st_dev),
    .file_inode = std::uint64_t(file.created.st_ino),
    .totals = file.written,
  };
  return true;
}

void RecordingSpoolFile::Abandon() {
  auto& file = *impl_;
  if (file.abandoned) return;
  file.abandoned = true;
  file.CloseFile();
  if (file.identity_known && !file.published && file.Matches(file.partial.c_str())) {
    if (RetryInterrupted([&] { return unlinkat(file.root_fd, file.partial.c_str(), 0); }) != 0) {
      file.Fail(SpoolError::kCleanup, errno);
      return;
    }
    file.unlinked = true;
    if (RetryInterrupted([&] { return file.io->Sync(file.root_fd); }) != 0) file.Fail(SpoolError::kCleanup, errno);
  }
}
SpoolTotals RecordingSpoolFile::Progress() const { return impl_->written; }
SpoolError RecordingSpoolFile::Error() const { return impl_->error; }
int RecordingSpoolFile::SystemError() const { return impl_->system_error; }
bool RecordingSpoolFile::Published() const { return impl_->published; }
bool RecordingSpoolFile::PartialRetained() const {
  return impl_->created_partial && !impl_->published && !impl_->unlinked;
}
std::optional<SpoolResult> RecordingSpoolFile::Result() const { return impl_->result; }

std::uint64_t RecordingStatusSignal::Revision() const {
  std::lock_guard lock(mutex_);
  return revision_;
}
std::uint64_t RecordingStatusSignal::Wait(std::uint64_t observed) {
  std::unique_lock lock(mutex_);
  changed_.wait(lock, [&] { return revision_ != observed; });
  return revision_;
}
void RecordingStatusSignal::Notify() {
  {
    std::lock_guard lock(mutex_);
    ++revision_;
  }
  changed_.notify_all();
}

struct RecordingSpoolWake {
  std::mutex mutex;
  std::condition_variable changed;
  std::shared_ptr<RecordingSpoolSession> session;
  std::uint64_t revision = 0;
  bool stopping = false;
};

struct RecordingSpoolSession::Impl {
  SpoolRequest request;
  std::weak_ptr<RecordingSpoolWake> wake;
  std::shared_ptr<RecordingStatusSignal> status;
  std::atomic<daw_audio_core_handle> capture{0};
  std::atomic<bool> cancelled{false};
  std::atomic<bool> finish_requested{false};
  mutable std::mutex mutex;
  SpoolSnapshot snapshot;
  std::optional<std::uint64_t> finish;
  std::optional<SpoolResult> result;
};

RecordingSpoolSession::RecordingSpoolSession(SpoolRequest request, std::weak_ptr<RecordingSpoolWake> wake,
  std::shared_ptr<RecordingStatusSignal> status)
  : impl_(std::make_unique<Impl>()) {
  impl_->request = std::move(request);
  impl_->wake = std::move(wake);
  impl_->status = std::move(status);
}
RecordingSpoolSession::~RecordingSpoolSession() {
  const auto capture = impl_->capture.load(std::memory_order_acquire);
  if (capture != 0) daw_audio_recording_capture_destroy(capture);
}
daw_audio_core_handle RecordingSpoolSession::CaptureHandle() const {
  return impl_->capture.load(std::memory_order_acquire);
}
void RecordingSpoolSession::NotifyWriter() {
  if (auto wake = impl_->wake.lock()) {
    {
      std::lock_guard lock(wake->mutex);
      ++wake->revision;
    }
    wake->changed.notify_one();
  }
}
bool RecordingSpoolSession::Finish(std::uint64_t captured_frames) {
  {
    std::lock_guard lock(impl_->mutex);
    if (impl_->snapshot.state != SpoolState::kReady || impl_->finish || impl_->cancelled.load(std::memory_order_acquire)) {
      return false;
    }
    impl_->finish = captured_frames;
    impl_->finish_requested.store(true, std::memory_order_release);
  }
  NotifyWriter();
  return true;
}
bool RecordingSpoolSession::Abandon() {
  {
    std::lock_guard lock(impl_->mutex);
    if (impl_->finish || impl_->snapshot.state == SpoolState::kComplete
      || impl_->snapshot.state == SpoolState::kFailed || impl_->snapshot.state == SpoolState::kCancelled) return false;
    impl_->cancelled.store(true, std::memory_order_release);
  }
  NotifyWriter();
  return true;
}
SpoolSnapshot RecordingSpoolSession::Snapshot() const {
  std::lock_guard lock(impl_->mutex);
  return impl_->snapshot;
}
std::optional<SpoolResult> RecordingSpoolSession::Result() const {
  std::lock_guard lock(impl_->mutex);
  return impl_->result;
}

struct RecordingSpoolService::Impl {
  std::shared_ptr<RecordingSpoolWake> wake = std::make_shared<RecordingSpoolWake>();
  std::shared_ptr<RecordingSpoolIo> io;
  std::shared_ptr<RecordingStatusSignal> status;
  std::thread writer;
};

RecordingSpoolService::RecordingSpoolService(std::shared_ptr<RecordingSpoolIo> io,
  std::shared_ptr<RecordingStatusSignal> status)
  : impl_(std::make_unique<Impl>()) {
  impl_->io = io ? std::move(io) : std::make_shared<RecordingSpoolIo>();
  impl_->status = status ? std::move(status) : std::make_shared<RecordingStatusSignal>();
  impl_->writer = std::thread([this] { Run(); });
}
RecordingSpoolService::~RecordingSpoolService() {
  std::shared_ptr<RecordingSpoolSession> session;
  {
    std::lock_guard lock(impl_->wake->mutex);
    impl_->wake->stopping = true;
    session = impl_->wake->session;
  }
  // Same linearization point as ordinary cancel: accepted Finish is not revoked.
  if (session) session->Abandon();
  NotifyCapture();
  impl_->writer.join();
}
std::shared_ptr<RecordingSpoolSession> RecordingSpoolService::Start(SpoolRequest request) {
  std::shared_ptr<RecordingSpoolSession> session;
  {
    std::lock_guard lock(impl_->wake->mutex);
    if (impl_->wake->stopping || impl_->wake->session) return {};
    session = std::shared_ptr<RecordingSpoolSession>(
      new RecordingSpoolSession(std::move(request), impl_->wake, impl_->status));
    impl_->wake->session = session;
    ++impl_->wake->revision;
  }
  impl_->wake->changed.notify_one();
  return session;
}
void RecordingSpoolService::NotifyCapture() {
  {
    std::lock_guard lock(impl_->wake->mutex);
    ++impl_->wake->revision;
  }
  impl_->wake->changed.notify_one();
}
std::shared_ptr<RecordingStatusSignal> RecordingSpoolService::StatusSignal() const { return impl_->status; }
void RecordingSpoolService::Run() {
  for (;;) {
    std::shared_ptr<RecordingSpoolSession> session;
    {
      std::unique_lock lock(impl_->wake->mutex);
      impl_->wake->changed.wait(lock, [&] { return impl_->wake->stopping || impl_->wake->session; });
      if (!impl_->wake->session) return;
      session = impl_->wake->session;
    }
    RunSession(session);
  }
}
void RecordingSpoolService::RunSession(const std::shared_ptr<RecordingSpoolSession>& session) {
  auto& owner = *session->impl_;
  SpoolSnapshot snapshot;
  std::optional<SpoolResult> result;
  {
    RecordingSpoolFile file(owner.request, impl_->io);
    bool ready = !owner.cancelled.load(std::memory_order_acquire) && file.Open();
    daw_audio_core_handle capture = 0;
    if (ready && daw_audio_recording_capture_create(&owner.request.capture, &capture) != DAW_AUDIO_CORE_OK) {
      ready = false;
      snapshot.error = SpoolError::kCapture;
    }
    std::uint64_t observed = 0;
    {
      std::lock_guard lock(impl_->wake->mutex);
      observed = impl_->wake->revision;
    }
    if (ready) {
      owner.capture.store(capture, std::memory_order_release);
      {
        std::lock_guard lock(owner.mutex);
        owner.snapshot.state = SpoolState::kReady;
        owner.snapshot.partial_retained = file.PartialRetained();
      }
      owner.status->Notify();
    }
    while (ready) {
      {
        std::unique_lock lock(impl_->wake->mutex);
        impl_->wake->changed.wait(lock, [&] {
          return owner.cancelled.load(std::memory_order_acquire)
            || impl_->wake->revision != observed;
        });
        observed = impl_->wake->revision;
      }
      if (owner.cancelled.load(std::memory_order_acquire)) break;
      // Acquire Finish BEFORE dequeue. A Finish arriving during/after this
      // drain has its own wake revision and must receive a fresh final drain.
      std::optional<std::uint64_t> expected;
      if (owner.finish_requested.load(std::memory_order_acquire)) expected = owner.finish;
      daw_audio_recording_capture_diagnostics diagnostics{};
      const auto healthy = [&] {
        return daw_audio_recording_capture_get_diagnostics(capture, &diagnostics) == DAW_AUDIO_CORE_OK
          && diagnostics.fatal == 0 && diagnostics.dropped_frames == 0 && diagnostics.dropped_blocks == 0;
      };
      if (!healthy()) { snapshot.error = SpoolError::kCapture; break; }
      for (;;) {
        if (owner.cancelled.load(std::memory_order_acquire)) break;
        daw_audio_recording_capture_block block{};
        const auto dequeue = daw_audio_recording_capture_dequeue(capture, &block);
        if (dequeue == DAW_AUDIO_CORE_NO_DATA) break;
        if (dequeue != DAW_AUDIO_CORE_OK) { snapshot.error = SpoolError::kCapture; break; }
        const bool appended = file.Append(block, owner.cancelled);
        const auto release = daw_audio_recording_capture_release_block(capture, block.block_id);
        if (release != DAW_AUDIO_CORE_OK) snapshot.error = SpoolError::kCapture;
        if (!appended || snapshot.error != SpoolError::kNone) break;
      }
      snapshot.written = file.Progress();
      if (owner.cancelled.load(std::memory_order_acquire) || file.Error() != SpoolError::kNone
        || snapshot.error != SpoolError::kNone) break;
      {
        // An observer paused while reading status must never stall capture.
        // Intermediate status may coalesce; terminal publication is reliable.
        std::unique_lock lock(owner.mutex, std::try_to_lock);
        if (lock.owns_lock()) owner.snapshot.written = snapshot.written;
      }
      if (!healthy()) { snapshot.error = SpoolError::kCapture; break; }
      if (expected) {
        if (diagnostics.active != 0 || diagnostics.queued_blocks != 0
          || diagnostics.captured_frames != *expected) snapshot.error = SpoolError::kTotals;
        else {
          const auto bytes = ExpectedBytes(*expected, snapshot.written.blocks, owner.request.capture.channel_count);
          if (!bytes) {
            snapshot.error = SpoolError::kTotals;
            snapshot.system_error = EOVERFLOW;
          } else if (file.Finish({*expected, *bytes, snapshot.written.blocks}, owner.cancelled)) result = file.Result();
        }
        break;
      }
    }
    // Cleanup/close finishes on this sole writer, never on host teardown.
    file.Abandon();
    snapshot.written = file.Progress();
    snapshot.published = file.Published();
    snapshot.partial_retained = file.PartialRetained();
    if (snapshot.error == SpoolError::kNone) {
      snapshot.error = file.Error();
      snapshot.system_error = file.SystemError();
    }
    if (result) snapshot.state = SpoolState::kComplete;
    else if (owner.cancelled.load(std::memory_order_acquire)
      && (snapshot.error == SpoolError::kNone || snapshot.error == SpoolError::kCancelled)) {
      snapshot.state = SpoolState::kCancelled;
      if (snapshot.error == SpoolError::kNone) snapshot.error = SpoolError::kCancelled;
    } else snapshot.state = SpoolState::kFailed;
  }
  // Release admission only after all file IO ownership, including root close,
  // has ended. Publish terminal separately; observers never invoke stdout here.
  {
    std::lock_guard admission(impl_->wake->mutex);
    impl_->wake->session.reset();
    std::lock_guard publication(owner.mutex);
    owner.snapshot = snapshot;
    owner.result = std::move(result);
  }
  owner.status->Notify();
}

}  // namespace daw::audio_host_macos
