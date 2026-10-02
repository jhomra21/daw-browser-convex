#include <array>
#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <poll.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <signal.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

namespace {

constexpr std::size_t kWorkers = 8;
constexpr std::uint64_t kScanSlots = 8;
constexpr std::uint64_t kDurationSeconds = 60;

struct Counter {
  std::uint64_t iterations = 0;
  std::uint64_t scans = 0;
};

struct SharedCounters {
  std::array<Counter, kWorkers> workers{};
};

enum class Mode {
  kPoll,
  kEvent,
};

std::uint64_t MonotonicNanoseconds() {
  timespec now{};
  clock_gettime(CLOCK_MONOTONIC_RAW, &now);
  return static_cast<std::uint64_t>(now.tv_sec) * 1'000'000'000ULL
    + static_cast<std::uint64_t>(now.tv_nsec);
}

[[noreturn]] void RunWorker(
  const std::size_t index,
  const Mode mode,
  const int pollMilliseconds,
  const int readDescriptor,
  SharedCounters* const counters
) {
  if (mode == Mode::kEvent) {
    pollfd descriptor{.fd = readDescriptor, .events = POLLIN, .revents = 0};
    while (poll(&descriptor, 1, -1) < 0 && errno == EINTR) {}
    _exit(EXIT_SUCCESS);
  }
  while (true) {
    poll(nullptr, 0, pollMilliseconds);
    ++counters->workers[index].iterations;
    counters->workers[index].scans += kScanSlots;
  }
}

int ParseInterval(const char* value) {
  char* end = nullptr;
  const auto parsed = std::strtol(value, &end, 10);
  if (end == value || *end != '\0' || parsed < 1 || parsed > 8) return -1;
  return static_cast<int>(parsed);
}

}  // namespace

int main(const int argc, char* argv[]) {
  if (argc != 2) {
    std::fprintf(stderr, "usage: native-wake-benchmark <1|2|4|8|event>\n");
    return EXIT_FAILURE;
  }
  const bool eventMode = std::strcmp(argv[1], "event") == 0;
  const auto mode = eventMode ? Mode::kEvent : Mode::kPoll;
  const auto pollMilliseconds = eventMode ? 1 : ParseInterval(argv[1]);
  if (pollMilliseconds < 0) return EXIT_FAILURE;
  auto* const counters = static_cast<SharedCounters*>(
    mmap(nullptr, sizeof(SharedCounters), PROT_READ | PROT_WRITE, MAP_ANON | MAP_SHARED, -1, 0)
  );
  if (counters == MAP_FAILED) return EXIT_FAILURE;
  std::array<int, kWorkers> readDescriptors{};
  std::array<int, kWorkers> writeDescriptors{};
  std::array<pid_t, kWorkers> children{};
  readDescriptors.fill(-1);
  writeDescriptors.fill(-1);
  const auto started = MonotonicNanoseconds();
  for (std::size_t index = 0; index < kWorkers; ++index) {
    int descriptors[2]{-1, -1};
    if (pipe(descriptors) != 0) return EXIT_FAILURE;
    readDescriptors[index] = descriptors[0];
    writeDescriptors[index] = descriptors[1];
    const auto child = fork();
    if (child < 0) return EXIT_FAILURE;
    if (child == 0) {
      for (std::size_t other = 0; other < index; ++other) {
        close(readDescriptors[other]);
        close(writeDescriptors[other]);
      }
      close(writeDescriptors[index]);
      RunWorker(index, mode, pollMilliseconds, readDescriptors[index], counters);
    }
    children[index] = child;
    close(readDescriptors[index]);
    readDescriptors[index] = -1;
  }
  timespec duration{.tv_sec = static_cast<time_t>(kDurationSeconds), .tv_nsec = 0};
  while (nanosleep(&duration, &duration) != 0 && errno == EINTR) {}
  if (eventMode) {
    for (const auto descriptor : writeDescriptors) close(descriptor);
  } else {
    for (const auto descriptor : children) kill(descriptor, SIGTERM);
  }
  std::uint64_t userMicroseconds = 0;
  std::uint64_t systemMicroseconds = 0;
  for (const auto child : children) {
    int status = 0;
    rusage usage{};
    if (wait4(child, &status, 0, &usage) != child) return EXIT_FAILURE;
    userMicroseconds += static_cast<std::uint64_t>(usage.ru_utime.tv_sec) * 1'000'000ULL
      + static_cast<std::uint64_t>(usage.ru_utime.tv_usec);
    systemMicroseconds += static_cast<std::uint64_t>(usage.ru_stime.tv_sec) * 1'000'000ULL
      + static_cast<std::uint64_t>(usage.ru_stime.tv_usec);
  }
  const auto elapsedNanoseconds = MonotonicNanoseconds() - started;
  std::uint64_t iterations = 0;
  std::uint64_t scans = 0;
  for (const auto counter : counters->workers) {
    iterations += counter.iterations;
    scans += counter.scans;
  }
  const auto cpuMicroseconds = userMicroseconds + systemMicroseconds;
  std::printf(
    "{\"mode\":\"%s\",\"workers\":%zu,\"durationSeconds\":%llu,\"elapsedSeconds\":%.3f,"
    "\"pollMilliseconds\":%d,\"iterations\":%llu,\"scans\":%llu,\"cpuUserMicroseconds\":%llu,"
    "\"cpuSystemMicroseconds\":%llu,\"cpuAggregatePercent\":%.4f}\n",
    eventMode ? "event" : "poll",
    kWorkers,
    static_cast<unsigned long long>(kDurationSeconds),
    static_cast<double>(elapsedNanoseconds) / 1'000'000'000.0,
    pollMilliseconds,
    static_cast<unsigned long long>(iterations),
    static_cast<unsigned long long>(scans),
    static_cast<unsigned long long>(userMicroseconds),
    static_cast<unsigned long long>(systemMicroseconds),
    static_cast<double>(cpuMicroseconds) / (static_cast<double>(elapsedNanoseconds) / 1'000.0)
  );
  munmap(counters, sizeof(SharedCounters));
  return EXIT_SUCCESS;
}
