#pragma once

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fcntl.h>
#include <unistd.h>

namespace daw::acceptance {

// Control/telemetry threads only. No plug-in paths, state or authentication data.
inline bool Enabled() { return std::getenv("DAW_AE08_EVIDENCE_DIR") != nullptr; }

inline void Event(const char* event, const char* fields = "") {
  const auto* directory = std::getenv("DAW_AE08_EVIDENCE_DIR");
  if (!directory) return;
  char file[4096];
  const auto length = std::snprintf(file, sizeof(file), "%s/native-%d.jsonl", directory, getpid());
  if (length <= 0 || static_cast<std::size_t>(length) >= sizeof(file)) return;
  const int descriptor = open(file, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (descriptor < 0) return;
  const auto monotonic = std::chrono::duration_cast<std::chrono::nanoseconds>(
    std::chrono::steady_clock::now().time_since_epoch()).count();
  const auto wall = std::chrono::duration_cast<std::chrono::milliseconds>(
    std::chrono::system_clock::now().time_since_epoch()).count();
  char record[2048];
  const auto bytes = std::snprintf(record, sizeof(record),
    "{\"event\":\"%s\",\"pid\":%d,\"wallMs\":%lld,\"monotonicNs\":\"%lld\"%s}\n",
    event, getpid(), static_cast<long long>(wall), static_cast<long long>(monotonic), fields);
  if (bytes > 0 && static_cast<std::size_t>(bytes) < sizeof(record)) {
    static_cast<void>(write(descriptor, record, bytes));
  }
  close(descriptor);
}

class Step {
 public:
  explicit Step(const char* name) : name_(name),
    started_(Enabled() ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{}) {}
  ~Step() { Finish(); }
  void Finish() {
    if (finished_ || !Enabled()) return;
    finished_ = true;
    const auto elapsed = std::chrono::duration<double, std::milli>(
      std::chrono::steady_clock::now() - started_).count();
    char fields[256];
    std::snprintf(fields, sizeof(fields), ",\"step\":\"%s\",\"durationMs\":%.6f", name_, elapsed);
    Event("vst-startup-step", fields);
  }
 private:
  const char* name_;
  std::chrono::steady_clock::time_point started_;
  bool finished_ = false;
};

}  // namespace daw::acceptance
