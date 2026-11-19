#pragma once

#include "daw/audio_core.h"

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <sys/types.h>
#include <sys/stat.h>

namespace daw::audio_host_macos {

struct SpoolTotals {
  std::uint64_t frames = 0;
  std::uint64_t bytes = 0;
  std::uint64_t blocks = 0;
  bool operator==(const SpoolTotals&) const = default;
};

// Main supplies a canonical, already-created userData/recording-spool root
// (0700, current uid), its verified identity and 32 random bytes as lowercase hex.
// Native never accepts a renderer path or creates/chmods the authorized root.
struct SpoolRequest {
  std::string root_path;
  std::uint64_t root_device = 0;
  std::uint64_t root_inode = 0;
  std::string token;
  daw_audio_recording_capture_config capture{};
};

enum class SpoolError {
  kNone = 0,
  kInvalidRequest = 1,
  kInvalidRoot = 2,
  kIdentity = 3,
  kCollision = 4,
  kLayout = 5,
  kWrite = 6,
  kTotals = 7,
  kSync = 8,
  kClose = 9,
  kPublish = 10,
  kCapture = 11,
  kCancelled = 12,
  kCleanup = 13,
};

struct SpoolResult {
  std::string token;
  std::uint32_t generation = 0;
  std::uint64_t session_id = 0;
  std::uint32_t channel_count = 0;
  std::uint64_t root_device = 0;
  std::uint64_t root_inode = 0;
  std::uint64_t file_device = 0;
  std::uint64_t file_inode = 0;
  SpoolTotals totals;
};

// Bounded fault-injection seam: only potentially blocking persistence syscalls.
// Shared ownership keeps a test adapter alive until retired IO actually exits.
class RecordingSpoolIo {
 public:
  virtual ~RecordingSpoolIo() = default;
  virtual ssize_t Write(int fd, const void* bytes, std::size_t count);
  virtual int Sync(int fd);
  virtual int Close(int fd);
  virtual int Publish(int root_fd, const char* partial, const char* final);
  virtual int StatCreated(int fd, struct stat* status);
};

// Single IO-owner only. Never call from an audio callback or host control.
// Cancel is an atomic request, not a concurrent close/unlink of writer-owned fds.
class RecordingSpoolFile {
 public:
  explicit RecordingSpoolFile(SpoolRequest request, std::shared_ptr<RecordingSpoolIo> io = {});
  ~RecordingSpoolFile();
  RecordingSpoolFile(const RecordingSpoolFile&) = delete;
  RecordingSpoolFile& operator=(const RecordingSpoolFile&) = delete;
  bool Open();
  bool Append(const daw_audio_recording_capture_block& block, const std::atomic<bool>& cancelled);
  bool Finish(SpoolTotals expected, const std::atomic<bool>& cancelled);
  void Abandon();
  SpoolTotals Progress() const;
  SpoolError Error() const;
  int SystemError() const;
  bool Published() const;
  // Conservative recovery fact: created source not published or safely
  // unlinked, including unknown identity or an externally replaced/moved path.
  bool PartialRetained() const;
  std::optional<SpoolResult> Result() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

enum class SpoolState { kPreparing = 0, kReady = 1, kComplete = 2, kFailed = 3, kCancelled = 4 };
struct SpoolSnapshot {
  SpoolState state = SpoolState::kPreparing;
  SpoolTotals written;
  SpoolError error = SpoolError::kNone;
  int system_error = 0;
  bool published = false;
  bool partial_retained = false;
};

// Independent observer lifetime; never stores a host/session callback.
// Wait returns on revision change, including a change before the wait starts.
// Observer shutdown sets its own stop flag then calls Notify to wake its wait.
class RecordingStatusSignal {
 public:
  std::uint64_t Revision() const;
  std::uint64_t Wait(std::uint64_t observed);
  void Notify();

 private:
  mutable std::mutex mutex_;
  std::condition_variable changed_;
  std::uint64_t revision_ = 0;
};

struct RecordingSpoolWake;
class RecordingSpoolService;

// Independent ownership: no AudioHost pointer, callback, stdout, or transport.
// Producer must retain this session while using CaptureHandle(). Finalize/cancel
// capture only on its existing producer lane; quiesce that lane before Abandon.
class RecordingSpoolSession {
 public:
  ~RecordingSpoolSession();
  daw_audio_core_handle CaptureHandle() const;
  // Existing native diagnostics supply authoritative captured frames, not an
  // independently known block/byte count. Writer derives/checks those itself.
  bool Finish(std::uint64_t captured_frames);
  // Linearizable with Finish. Refuses accepted finish/terminal sessions.
  // Does not wait for IO, destroy capture, close fds, unlink, or delete PCM.
  bool Abandon();
  // Scalar/result reads use a separate short-held lock, never an IO lock.
  // Capture progress publication is try-lock/coalesced, never waits on readers.
  SpoolSnapshot Snapshot() const;
  std::optional<SpoolResult> Result() const;

 private:
  friend class RecordingSpoolService;
  struct Impl;
  RecordingSpoolSession(SpoolRequest request, std::weak_ptr<RecordingSpoolWake> wake,
    std::shared_ptr<RecordingStatusSignal> status);
  void NotifyWriter();
  std::unique_ptr<Impl> impl_;
};

// Exactly one persistent writer thread and one admitted session; a blocked
// retired session occupies that slot and refuses further starts. No extra PCM
// queue: writer holds at most one existing capture-pool slot until write ends.
// Own once at native PROCESS scope, outside AudioHost. Destruction joins only
// at process shutdown and can wait for kernel IO; NEVER destroy from host
// teardown/control. No fabricated IO deadline or per-take detached thread.
class RecordingSpoolService {
 public:
  explicit RecordingSpoolService(std::shared_ptr<RecordingSpoolIo> io = {},
    std::shared_ptr<RecordingStatusSignal> status = {});
  ~RecordingSpoolService();
  RecordingSpoolService(const RecordingSpoolService&) = delete;
  RecordingSpoolService& operator=(const RecordingSpoolService&) = delete;
  // Admission only, no synchronous filesystem IO; null means writer busy.
  std::shared_ptr<RecordingSpoolSession> Start(SpoolRequest request);
  // Off-realtime bridge targets the process-owned service, never races a
  // host's shared-session replacement and does not mutate session state.
  void NotifyCapture();
  std::shared_ptr<RecordingStatusSignal> StatusSignal() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
  void Run();
  void RunSession(const std::shared_ptr<RecordingSpoolSession>& session);
};

}  // namespace daw::audio_host_macos
