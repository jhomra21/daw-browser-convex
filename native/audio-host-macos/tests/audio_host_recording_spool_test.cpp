#include "daw/audio_host_macos.h"
#include "../src/recording-spool.h"
#include <array>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <filesystem>
#include <mutex>
#include <stdexcept>
#include <source_location>
#include <thread>
#include <sys/stat.h>
#include <unistd.h>
#include <fcntl.h>
using namespace daw::audio_host_macos;
namespace {
void Check(bool condition, std::source_location location = std::source_location::current()) {
  if (!condition) throw std::runtime_error("recording host invariant at line " + std::to_string(location.line()));
}
template <typename Predicate> void Await(Predicate predicate, std::source_location location = std::source_location::current()) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (!predicate()) { Check(std::chrono::steady_clock::now() < deadline, location); std::this_thread::yield(); }
}
struct Device : RecordingInputDevice {
  std::atomic<unsigned> starts{0};
  bool available = true;
  std::uint32_t rate = 48000;
  bool Start(std::string_view, std::uint32_t, std::uint32_t, AudioHost*, void** session) override {
    ++starts;
    *session = available ? this : nullptr;
    return available;
  }
  void Stop(void*) override {}
  std::uint32_t Rate(std::string_view) override { return rate; }
};
void FailureAndBackpressureChecks() {
  char root[] = "/private/tmp/daw-host-spool-independent-XXXXXX";
  Check(mkdtemp(root) != nullptr);
  struct stat identity{};
  Check(stat(root, &identity) == 0);
  SpoolRequest request;
  request.root_path = root;
  request.root_device = identity.st_dev;
  request.root_inode = identity.st_ino;
  RecordingSpoolService service;
  Device device;
  auto channel = std::make_shared<RecordingStatusChannel>();
  AudioHost host(&service, &device, channel);
  Check(host.Configure({"offline:render", 48000, 2048, 2, 1}));
  Check(host.StartDiagnosticMode());
  RecordingConfig config{
    .device_uid = "fixture", .generation = 1, .session_id = 1,
    .channel_count = 2, .input_channels = {0, 1}, .gain = 1, .polarity = 1,
    .punch_start_frame = 0, .punch_end_frame = -1, .monitoring = false,
  };
  // A scalar publisher stuck in an actual pipe write cannot own host progress.
  int descriptors[2]{};
  Check(pipe(descriptors) == 0);
  Check(fcntl(descriptors[1], F_SETFL, O_NONBLOCK) == 0);
  std::array<char, 4096> bytes{};
  while (write(descriptors[1], bytes.data(), bytes.size()) > 0) {}
  Check(errno == EAGAIN);
  Check(fcntl(descriptors[1], F_SETFL, 0) == 0);
  std::atomic<bool> running{true};
  std::atomic<bool> writing{false};
  std::thread publisher([&] {
    std::uint64_t revision = 0;
    if (channel->Wait(revision, running)) {
      writing = true;
      Check(write(descriptors[1], bytes.data(), 120) == 120);
    }
  });
  struct UnblockPublisher {
    std::thread& publisher;
    std::shared_ptr<RecordingStatusChannel> channel;
    std::atomic<bool>& running;
    int* descriptors;
    ~UnblockPublisher() {
      running = false;
      channel->Wake();
      std::array<char, 4096> discard{};
      static_cast<void>(read(descriptors[0], discard.data(), discard.size()));
      if (publisher.joinable()) publisher.join();
      close(descriptors[0]);
      close(descriptors[1]);
    }
  } cleanup{publisher, channel, running, descriptors};
  request.token = std::string(64, 'b');
  Check(host.ConfigureRecording(config, request));
  Await([&] { return writing.load() && host.RecordingSnapshot().configured; });
  Check(host.StartRecording());
  std::array<float, 2048> plane{};
  const float* inputs[]{plane.data(), plane.data()};
  for (unsigned index = 1; index <= 100; ++index) {
    Check(host.ProcessRecordingPlanar(inputs, 2048));
    Await([&] {
      // Audio core retains one completed tail block for stop-frame trimming.
      return std::filesystem::file_size(std::string(root) + "/" + request.token + ".partial") == (index - 1) * 16388;
    });
  }
  Check(host.StopRecording(std::nullopt));
  Await([&] { return host.RecordingSnapshot().spool.state == SpoolState::kComplete; });
  Check(host.RecordingSnapshot().spool.written == SpoolTotals{204800, 1638800, 100});
  Check(read(descriptors[0], bytes.data(), bytes.size()) > 0);
  publisher.join();
  // A second take cannot reuse the retired capture handle or lose readiness.
  ++config.generation;
  ++config.session_id;
  config.punch_end_frame = 17;
  request.token = std::string(64, 'c');
  Check(host.ConfigureRecording(config, request));
  Await([&] { return host.RecordingSnapshot().configured; });
  Check(host.StartRecording());
  Check(host.ProcessRecordingPlanar(inputs, 17));
  Check(host.StopRecording(17));
  Await([&] { return host.RecordingSnapshot().spool.state == SpoolState::kComplete; });
  Check(host.RecordingSnapshot().spool.written.frames == 17);
  // Negotiated-rate mismatch must never become ready or capture-enabled.
  ++config.generation;
  ++config.session_id;
  request.token = std::string(64, 'd');
  device.rate = 44100;
  Check(host.ConfigureRecording(config, request));
  Await([&] { return host.RecordingSnapshot().fatal; });
  Check(!host.StartRecording());
  host.Stop();
  host.Teardown();
  std::filesystem::remove_all(root);
}
struct BlockSync : RecordingSpoolIo {
  std::mutex mutex;
  std::condition_variable changed;
  bool blocked = false;
  bool released = false;
  int Sync(int fd) override {
    {
      std::unique_lock lock(mutex);
      blocked = true;
      changed.notify_all();
      changed.wait(lock, [&] { return released; });
    }
    return RecordingSpoolIo::Sync(fd);
  }
};
void Run() {
  char root[] = "/private/tmp/daw-host-spool-XXXXXX";
  Check(mkdtemp(root) != nullptr);
  struct stat status{};
  Check(stat(root, &status) == 0);
  SpoolRequest request;
  request.root_path = root;
  request.root_device = status.st_dev;
  request.root_inode = status.st_ino;
  request.token = std::string(64, 'a');
  auto io = std::make_shared<BlockSync>();
  RecordingSpoolService service(io);
  Device device;
  {
    AudioHost host(&service, &device);
    Check(host.Configure({"offline:render", 48000, 2048, 2, 1}));
    Check(host.StartDiagnosticMode());
    RecordingConfig config{
      .device_uid = "fixture", .generation = 1, .session_id = 1,
      .channel_count = 2, .input_channels = {0, 1}, .gain = 1, .polarity = 1,
      .punch_start_frame = 0, .punch_end_frame = -1, .monitoring = false,
    };
    Check(host.ConfigureRecording(config, request));
    Check(!host.ConfigureRecording(config, request));
    Await([&] { return host.RecordingSnapshot().spool.state == SpoolState::kReady; });
    Check(host.RecordingSnapshot().sample_rate_hz == 48000);
    Check(host.StartRecording());
    std::array<float, 17> plane{};
    const float* inputs[]{plane.data(), plane.data()};
    Check(host.ProcessRecordingPlanar(inputs, 17));
    Check(host.StopRecording(std::nullopt));
    {
      std::unique_lock lock(io->mutex);
      Check(io->changed.wait_for(lock, std::chrono::seconds(5), [&] { return io->blocked; }));
    }
    Check(!host.CancelRecording()); // accepted finish, not just inactive capture
    host.Stop(); // must release host without joining blocked persistence
    Check(!std::filesystem::exists(std::string(root) + "/" + request.token + ".pcm"));
    {
      std::lock_guard lock(io->mutex);
      io->released = true;
    }
    io->changed.notify_all();
    Await([&] { return host.RecordingSnapshot().spool.state == SpoolState::kComplete; });
    Check(host.RecordingSnapshot().spool.written == SpoolTotals{17, 140, 1});
    Check(std::filesystem::exists(std::string(root) + "/" + request.token + ".pcm"));
  }
  std::filesystem::remove_all(root);
}
}
int main() {
  try {
    Run();
    FailureAndBackpressureChecks();
    std::puts("PASS device-less finish ownership, blocked publisher, second take, rate refusal");
    return 0;
  }
  catch (const std::exception& error) { std::fprintf(stderr, "%s\n", error.what()); return 1; }
}
