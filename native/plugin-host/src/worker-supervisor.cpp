#include "worker-supervisor.h"
#include "worker-control-protocol.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <cmath>
#include <cctype>
#include <cstring>
#include <fcntl.h>
#include <limits>
#include <random>
#include <signal.h>
#include <spawn.h>
#include <sys/mman.h>
#include <sys/event.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

namespace daw::plugin_host {
namespace {

constexpr std::size_t kSampleBytes = sizeof(float);
constexpr std::size_t kCacheLineBytes = 64;
constexpr std::uint32_t kDiagnosticCapacity = 32;
constexpr std::uint64_t kTransportMagic = 0x444157575452414eULL;

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

struct alignas(kCacheLineBytes) SharedSlotControl {
  std::atomic<std::uint64_t> sequence{0};
  std::atomic<std::uint32_t> status{static_cast<std::uint32_t>(WorkerSlotStatus::kFree)};
  std::uint32_t numSamples = 0;
  std::uint32_t eventCount = 0;
  std::uint32_t reserved = 0;
};

struct alignas(kCacheLineBytes) SharedHeader {
  std::uint64_t magic = kTransportMagic;
  std::uint32_t abiVersion = kWorkerTransportAbiVersion;
  std::uint32_t headerBytes = sizeof(SharedHeader);
  std::uint64_t token = 0;
  std::uint64_t mappedBytes = 0;
  std::uint64_t layoutHash = 0;
  std::uint32_t slotCount = 0;
  std::uint32_t maximumFrames = 0;
  std::uint32_t inputChannels = 0;
  std::uint32_t outputChannels = 0;
  std::uint32_t maximumEvents = 0;
  std::uint32_t slotBytes = 0;
  std::uint64_t slotsOffset = 0;
  std::atomic<std::uint32_t> health{static_cast<std::uint32_t>(WorkerHealth::kStarting)};
  std::atomic<std::uint32_t> diagnosticWrite{0};
  std::atomic<std::uint32_t> diagnosticRead{0};
  WorkerDiagnostic diagnostics[kDiagnosticCapacity]{};
};
static_assert(alignof(SharedHeader) >= alignof(std::atomic<std::uint64_t>));

constexpr std::size_t Align(std::size_t bytes) {
  return (bytes + kCacheLineBytes - 1U) & ~(kCacheLineBytes - 1U);
}

std::optional<std::size_t> Multiply(std::size_t left, std::size_t right) {
  if (left != 0 && right > std::numeric_limits<std::size_t>::max() / left) return std::nullopt;
  return left * right;
}

std::optional<std::size_t> Add(std::size_t left, std::size_t right) {
  if (right > std::numeric_limits<std::size_t>::max() - left) return std::nullopt;
  return left + right;
}

bool IsSha256(const std::string& fingerprint) {
  if (fingerprint.size() != 64) return false;
  for (const char character : fingerprint) {
    if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) return false;
  }
  return true;
}

bool IsClassId(const std::string& classId) {
  return classId.size() == 32 && std::all_of(classId.begin(), classId.end(), [](const unsigned char value) {
    return std::isxdigit(value) != 0;
  });
}

bool IsValidSetup(const WorkerProcessSetup& setup) {
  return std::isfinite(setup.sampleRate) && setup.sampleRate > 0.0 && setup.sampleRate <= 384'000.0
    && setup.maximumBlockFrames > 0 && setup.maximumBlockFrames <= kMaximumWorkerFrames
    && setup.inputChannels <= kMaximumWorkerChannels && setup.outputChannels > 0
    && setup.outputChannels <= kMaximumWorkerChannels;
}

bool IsUuid(const std::string& value) {
  if (value.size() != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-') return false;
  for (std::size_t index = 0; index < value.size(); ++index) {
    if (index == 8 || index == 13 || index == 18 || index == 23) continue;
    if (std::isxdigit(static_cast<unsigned char>(value[index])) == 0) return false;
  }
  const auto version = static_cast<unsigned char>(value[14]);
  const auto variant = static_cast<unsigned char>(std::tolower(static_cast<unsigned char>(value[19])));
  return version >= '1' && version <= '8' && (variant == '8' || variant == '9' || variant == 'a' || variant == 'b');
}

bool IsRequestId(const std::string& value) {
  return !value.empty() && value.size() <= 96 && std::all_of(value.begin(), value.end(), [](const unsigned char character) {
    return std::isalnum(character) != 0 || character == '.' || character == '_' || character == '-';
  });
}

bool IsValidBus(const WorkerBusDescriptor& bus) {
  return !bus.name.empty() && bus.name.size() <= 128 && bus.channels <= kMaximumWorkerChannels;
}

std::optional<std::size_t> EnabledChannels(const std::vector<WorkerBusDescriptor>& buses) {
  std::size_t channels = 0;
  for (const auto& bus : buses) {
    if (!IsValidBus(bus)) return std::nullopt;
    if (bus.enabled) {
      if (bus.channels > kMaximumWorkerChannels - channels) return std::nullopt;
      channels += bus.channels;
    }
  }
  return channels;
}

bool IsValidPreflightRequirements(const WorkerPreflightRequirements& requirements) {
  return IsValidWorkerArtifactIdentity(requirements.artifact)
    && requirements.startupProtocolVersion == kWorkerStartupProtocolVersion
    && requirements.controlProtocolVersion == kWorkerControlProtocolVersion
    && requirements.transportAbiVersion == kWorkerTransportAbiVersion
    && requirements.arm64;
}

std::uint64_t HashLayout(const WorkerTransportLayout& layout) {
  std::uint64_t hash = 1469598103934665603ULL;
  const std::array<std::uint64_t, 8> values{
    layout.bytes, layout.slotBytes, layout.audioBytesPerSlot, layout.eventBytesPerSlot,
    layout.maximumFrames, layout.inputChannels, layout.outputChannels, layout.maximumEventsPerBlock,
  };
  for (const auto value : values) {
    hash ^= value;
    hash *= 1099511628211ULL;
  }
  return hash;
}

std::uint64_t RandomToken() {
  std::random_device random;
  const auto high = static_cast<std::uint64_t>(random()) << 32U;
  return high | random() | 1U;
}

bool ValidHeader(const SharedHeader& header, const std::size_t mappedBytes, const std::uint64_t token) {
  if (header.magic != kTransportMagic || header.abiVersion != kWorkerTransportAbiVersion
    || header.headerBytes != sizeof(SharedHeader) || header.token != token || header.mappedBytes != mappedBytes
    || header.slotCount < 2 || header.slotCount > kMaximumWorkerSlots || header.maximumFrames == 0
    || header.maximumFrames > kMaximumWorkerFrames || header.inputChannels > kMaximumWorkerChannels
    || header.outputChannels == 0 || header.outputChannels > kMaximumWorkerChannels
    || header.maximumEvents > kMaximumWorkerEvents || header.slotsOffset != Align(sizeof(SharedHeader))) {
    return false;
  }
  WorkerTransportLayout layout{
    .bytes = mappedBytes - header.slotsOffset,
    .slotBytes = header.slotBytes,
    .audioBytesPerSlot = (static_cast<std::size_t>(header.inputChannels) + header.outputChannels) * header.maximumFrames * kSampleBytes,
    .eventBytesPerSlot = static_cast<std::size_t>(header.maximumEvents) * sizeof(WorkerTransportEvent),
    .maximumFrames = header.maximumFrames,
    .inputChannels = header.inputChannels,
    .outputChannels = header.outputChannels,
    .maximumEventsPerBlock = header.maximumEvents,
  };
  return layout.slotBytes != 0 && layout.bytes == layout.slotBytes * header.slotCount && header.layoutHash == HashLayout(layout);
}

bool PushDiagnostic(SharedHeader& header, const WorkerDiagnostic diagnostic) {
  const auto write = header.diagnosticWrite.load(std::memory_order_relaxed);
  const auto read = header.diagnosticRead.load(std::memory_order_acquire);
  if (write - read >= kDiagnosticCapacity) return false;
  header.diagnostics[write % kDiagnosticCapacity] = diagnostic;
  header.diagnosticWrite.store(write + 1, std::memory_order_release);
  return true;
}

bool WaitForChildExit(const int childProcessId, const long milliseconds) {
  int status = 0;
  if (waitpid(childProcessId, &status, WNOHANG) == childProcessId) return true;
  const auto queue = kqueue();
  if (queue < 0) return false;
  struct kevent change {};
  EV_SET(&change, childProcessId, EVFILT_PROC, EV_ADD | EV_ONESHOT, NOTE_EXIT, 0, nullptr);
  if (kevent(queue, &change, 1, nullptr, 0, nullptr) != 0) {
    close(queue);
    return false;
  }
  if (waitpid(childProcessId, &status, WNOHANG) == childProcessId) {
    close(queue);
    return true;
  }
  const timespec timeout{.tv_sec = 0, .tv_nsec = milliseconds * 1'000'000L};
  struct kevent event {};
  const auto received = kevent(queue, nullptr, 0, &event, 1, &timeout);
  close(queue);
  if (received != 1) return false;
  return waitpid(childProcessId, &status, 0) == childProcessId;
}

}  // namespace

bool IsValidWorkerArtifactIdentity(const WorkerArtifactIdentity& identity) {
  return identity.id == kWorkerArtifactId && identity.version == kWorkerArtifactVersion;
}

bool IsValidWorkerHostConfiguration(const WorkerHostConfiguration& configuration) {
  return !configuration.executable.empty() && IsValidWorkerArtifactIdentity(configuration.artifact);
}

bool IsValidWorkerManifest(const WorkerManifest& manifest) {
  if (manifest.version != kWorkerManifestVersion || !IsValidWorkerArtifactIdentity(manifest.artifact)
    || manifest.startupProtocolVersion != kWorkerStartupProtocolVersion
    || manifest.controlProtocolVersion != kWorkerControlProtocolVersion
    || manifest.transportAbiVersion != kWorkerTransportAbiVersion || !manifest.arm64
    || (manifest.role != WorkerPluginRole::kEffect && manifest.role != WorkerPluginRole::kInstrument)
    || manifest.inputBuses.size() > 32 || manifest.outputBuses.empty() || manifest.outputBuses.size() > 32
    || manifest.transport.slotCount < 2 || manifest.transport.slotCount > kMaximumWorkerSlots
    || manifest.transport.maximumFrames == 0 || manifest.transport.maximumFrames > kMaximumWorkerFrames
    || manifest.transport.inputChannels > kMaximumWorkerChannels
    || manifest.transport.outputChannels == 0 || manifest.transport.outputChannels > kMaximumWorkerChannels
    || manifest.transport.maximumEventsPerBlock > kMaximumWorkerEvents || manifest.latencyFrames > 10'000'000
    || (manifest.tailFrames && *manifest.tailFrames > 100'000'000) || manifest.stateRevision > 0x7fff'ffffU) {
    return false;
  }
  const auto inputChannels = EnabledChannels(manifest.inputBuses);
  const auto outputChannels = EnabledChannels(manifest.outputBuses);
  return inputChannels && outputChannels && *inputChannels == manifest.transport.inputChannels
    && *outputChannels == manifest.transport.outputChannels;
}

bool IsValidWorkerHello(const WorkerHello& hello) {
  return IsUuid(hello.instanceId) && IsValidWorkerManifest(hello.manifest);
}

bool IsValidWorkerPreflightRequest(const WorkerPreflightRequest& request) {
  return request.version == 1 && IsRequestId(request.requestId) && IsValidPreflightRequirements(request.requirements);
}

bool IsValidWorkerPreflightResult(const WorkerPreflightResult& result) {
  if (result.version != 1 || !IsRequestId(result.requestId) || !IsValidPreflightRequirements(result.requirements)) return false;
  if (result.status == WorkerPreflightStatus::kAvailable) {
    return result.code.empty() && result.message.empty() && result.hello && IsValidWorkerHello(*result.hello);
  }
  const bool knownCode = result.code == "worker-unavailable" || result.code == "worker-timeout"
    || result.code == "worker-crashed" || result.code == "worker-invalid-response";
  return result.status == WorkerPreflightStatus::kUnavailable && knownCode
    && !result.message.empty() && result.message.size() <= 512 && !result.hello;
}

bool IsWorkerLaunchEligible(const WorkerLaunchEligibility& eligibility) {
  return !eligibility.canonicalBundlePath.empty()
    && !eligibility.canonicalExecutablePath.empty()
    && eligibility.canonicalExecutablePath.starts_with(eligibility.canonicalBundlePath + "/")
    && IsSha256(eligibility.bundleFingerprint)
    && IsSha256(eligibility.binaryFingerprint)
    && eligibility.arm64
    && eligibility.codeSignVerified
    && !eligibility.quarantinePresent
    && eligibility.scannerProtocolVersion == 2;
}

bool IsValidWorkerStartupRequest(const WorkerStartupRequest& request) {
  if (!IsValidSetup(request.setup)) return false;
  if (request.state && !IsValidWorkerState(*request.state)) return false;
  if (request.noPluginTestMode) {
    return request.classId.empty() && request.eligibility.canonicalBundlePath.empty()
      && request.eligibility.canonicalExecutablePath.empty() && !request.state;
  }
  return !request.noPluginTestMode && IsWorkerLaunchEligible(request.eligibility) && IsClassId(request.classId);
}

std::optional<WorkerTransportLayout> CreateWorkerTransportLayout(const WorkerTransportRequest& request) {
  if (request.slotCount < 2 || request.slotCount > kMaximumWorkerSlots
    || request.maximumFrames == 0 || request.maximumFrames > kMaximumWorkerFrames
    || request.inputChannels > kMaximumWorkerChannels || request.outputChannels == 0
    || request.outputChannels > kMaximumWorkerChannels || request.maximumEventsPerBlock > kMaximumWorkerEvents) {
    return std::nullopt;
  }
  const auto channels = Add(request.inputChannels, request.outputChannels);
  if (!channels) return std::nullopt;
  const auto samples = Multiply(*channels, request.maximumFrames);
  if (!samples) return std::nullopt;
  const auto audioBytes = Multiply(*samples, kSampleBytes);
  const auto eventBytes = Multiply(request.maximumEventsPerBlock, sizeof(WorkerTransportEvent));
  if (!audioBytes || !eventBytes) return std::nullopt;
  const auto slotDataBytes = Add(*eventBytes, *audioBytes);
  if (!slotDataBytes) return std::nullopt;
  const auto slotBytes = Add(Align(sizeof(SharedSlotControl)), *slotDataBytes);
  if (!slotBytes) return std::nullopt;
  const auto bytes = Multiply(request.slotCount, *slotBytes);
  if (!bytes || *bytes > kMaximumWorkerTransportBytes - Align(sizeof(SharedHeader))) return std::nullopt;
  return WorkerTransportLayout{
    .bytes = *bytes,
    .slotBytes = *slotBytes,
    .audioBytesPerSlot = *audioBytes,
    .eventBytesPerSlot = *eventBytes,
    .maximumFrames = request.maximumFrames,
    .inputChannels = request.inputChannels,
    .outputChannels = request.outputChannels,
    .maximumEventsPerBlock = request.maximumEventsPerBlock,
  };
}

std::optional<WorkerSharedMemoryDescriptor> CreatePortableSharedMemoryDescriptor(
  const std::string& name,
  const WorkerTransportLayout& layout
) {
  if (name.empty() || name.size() > 128 || layout.bytes == 0 || layout.bytes > kMaximumWorkerTransportBytes) return std::nullopt;
  for (const char character : name) {
    if (!((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z')
      || (character >= '0' && character <= '9') || character == '_' || character == '-' || character == '.')) {
      return std::nullopt;
    }
  }
  return WorkerSharedMemoryDescriptor{.name = name, .byteLength = layout.bytes};
}

struct WorkerTransport::Mapping {
  int fileDescriptor = -1;
  void* address = MAP_FAILED;
  std::size_t bytes = 0;
  std::uint64_t token = 0;

  ~Mapping() {
    if (address != MAP_FAILED) munmap(address, bytes);
    if (fileDescriptor >= 0) close(fileDescriptor);
  }
};

WorkerTransport::WorkerTransport(std::unique_ptr<Mapping> mapping) : mapping_(std::move(mapping)) {
  const auto* header = static_cast<const SharedHeader*>(mapping_->address);
  layout_ = WorkerTransportLayout{
    .bytes = mapping_->bytes - header->slotsOffset,
    .slotBytes = header->slotBytes,
    .audioBytesPerSlot = (static_cast<std::size_t>(header->inputChannels) + header->outputChannels) * header->maximumFrames * kSampleBytes,
    .eventBytesPerSlot = static_cast<std::size_t>(header->maximumEvents) * sizeof(WorkerTransportEvent),
    .maximumFrames = header->maximumFrames,
    .inputChannels = header->inputChannels,
    .outputChannels = header->outputChannels,
    .maximumEventsPerBlock = header->maximumEvents,
  };
}

WorkerTransport::~WorkerTransport() = default;
WorkerTransport::WorkerTransport(WorkerTransport&&) noexcept = default;
WorkerTransport& WorkerTransport::operator=(WorkerTransport&&) noexcept = default;

std::optional<WorkerTransport> WorkerTransport::Create(const WorkerTransportLayout& layout) {
  const auto totalBytes = Add(Align(sizeof(SharedHeader)), layout.bytes);
  if (!totalBytes || *totalBytes > kMaximumWorkerTransportBytes) return std::nullopt;
  const auto name = "/daw-vst3-" + std::to_string(RandomToken());
  const auto fileDescriptor = shm_open(name.c_str(), O_RDWR | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR);
  if (fileDescriptor < 0) return std::nullopt;
  shm_unlink(name.c_str());
  if (ftruncate(fileDescriptor, static_cast<off_t>(*totalBytes)) != 0) {
    close(fileDescriptor);
    return std::nullopt;
  }
  void* address = mmap(nullptr, *totalBytes, PROT_READ | PROT_WRITE, MAP_SHARED, fileDescriptor, 0);
  if (address == MAP_FAILED) {
    close(fileDescriptor);
    return std::nullopt;
  }
  std::memset(address, 0, *totalBytes);
  auto* header = new (address) SharedHeader{};
  header->token = RandomToken();
  header->mappedBytes = *totalBytes;
  header->layoutHash = HashLayout(layout);
  header->slotCount = static_cast<std::uint32_t>(layout.bytes / layout.slotBytes);
  header->maximumFrames = static_cast<std::uint32_t>(layout.maximumFrames);
  header->inputChannels = static_cast<std::uint32_t>(layout.inputChannels);
  header->outputChannels = static_cast<std::uint32_t>(layout.outputChannels);
  header->maximumEvents = static_cast<std::uint32_t>(layout.maximumEventsPerBlock);
  header->slotBytes = static_cast<std::uint32_t>(layout.slotBytes);
  header->slotsOffset = Align(sizeof(SharedHeader));
  auto mapping = std::make_unique<Mapping>();
  mapping->fileDescriptor = fileDescriptor;
  mapping->address = address;
  mapping->bytes = *totalBytes;
  mapping->token = header->token;
  return WorkerTransport(std::move(mapping));
}

std::optional<WorkerTransport> WorkerTransport::MapInherited(const int fileDescriptor, const std::uint64_t token) {
  struct stat details {};
  if (fileDescriptor < 0 || fstat(fileDescriptor, &details) != 0 || details.st_size < static_cast<off_t>(sizeof(SharedHeader))) return std::nullopt;
  const auto bytes = static_cast<std::size_t>(details.st_size);
  void* address = mmap(nullptr, bytes, PROT_READ | PROT_WRITE, MAP_SHARED, fileDescriptor, 0);
  if (address == MAP_FAILED) return std::nullopt;
  const auto transportBytes = static_cast<const SharedHeader*>(address)->mappedBytes;
  if (transportBytes > bytes || !ValidHeader(*static_cast<const SharedHeader*>(address), transportBytes, token)) {
    munmap(address, bytes);
    close(fileDescriptor);
    return std::nullopt;
  }
  munmap(address, bytes);
  address = mmap(nullptr, transportBytes, PROT_READ | PROT_WRITE, MAP_SHARED, fileDescriptor, 0);
  if (address == MAP_FAILED) {
    close(fileDescriptor);
    return std::nullopt;
  }
  auto mapping = std::make_unique<Mapping>();
  mapping->fileDescriptor = fileDescriptor;
  mapping->address = address;
  mapping->bytes = transportBytes;
  mapping->token = token;
  return WorkerTransport(std::move(mapping));
}

bool WorkerTransport::OwnsSlot(const std::size_t slotIndex) const {
  return mapping_ && slotIndex < layout_.bytes / layout_.slotBytes;
}

std::byte* WorkerTransport::SlotBytes(const std::size_t slotIndex) const {
  auto* base = static_cast<std::byte*>(mapping_->address);
  const auto* header = static_cast<const SharedHeader*>(mapping_->address);
  return base + header->slotsOffset + slotIndex * layout_.slotBytes;
}

bool WorkerTransport::Submit(const std::size_t slotIndex, const std::uint64_t sequence) {
  return Submit(slotIndex, sequence, 0, {});
}

bool WorkerTransport::Submit(
  const std::size_t slotIndex,
  const std::uint64_t sequence,
  const std::size_t numSamples,
  const std::span<const WorkerTransportEvent> events
) {
  if (!OwnsSlot(slotIndex) || sequence == 0 || numSamples > layout_.maximumFrames
    || events.size() > layout_.maximumEventsPerBlock) {
    return false;
  }
  for (const auto& event : events) {
    if (event.sampleOffset >= numSamples) return false;
  }
  auto* control = reinterpret_cast<SharedSlotControl*>(SlotBytes(slotIndex));
  const auto status = static_cast<WorkerSlotStatus>(control->status.load(std::memory_order_acquire));
  if (status != WorkerSlotStatus::kFree && status != WorkerSlotStatus::kComplete) return false;
  control->numSamples = static_cast<std::uint32_t>(numSamples);
  control->eventCount = static_cast<std::uint32_t>(events.size());
  auto* storedEvents = reinterpret_cast<WorkerTransportEvent*>(SlotBytes(slotIndex) + Align(sizeof(SharedSlotControl)));
  std::memcpy(storedEvents, events.data(), events.size_bytes());
  control->sequence.store(sequence, std::memory_order_relaxed);
  control->status.store(static_cast<std::uint32_t>(WorkerSlotStatus::kSubmitted), std::memory_order_release);
  return true;
}

bool WorkerTransport::Complete(const std::size_t slotIndex, const std::uint64_t sequence) {
  if (!OwnsSlot(slotIndex)) return false;
  auto* control = reinterpret_cast<SharedSlotControl*>(SlotBytes(slotIndex));
  if (static_cast<WorkerSlotStatus>(control->status.load(std::memory_order_acquire)) != WorkerSlotStatus::kProcessing
    || control->sequence.load(std::memory_order_relaxed) != sequence) return false;
  control->status.store(static_cast<std::uint32_t>(WorkerSlotStatus::kComplete), std::memory_order_release);
  return true;
}

bool WorkerTransport::DropLate(const std::size_t slotIndex, const std::uint64_t expectedSequence) {
  if (!OwnsSlot(slotIndex)) return false;
  auto* control = reinterpret_cast<SharedSlotControl*>(SlotBytes(slotIndex));
  if (control->sequence.load(std::memory_order_acquire) >= expectedSequence) return false;
  auto status = static_cast<std::uint32_t>(WorkerSlotStatus::kComplete);
  if (control->status.compare_exchange_strong(
    status, static_cast<std::uint32_t>(WorkerSlotStatus::kFree), std::memory_order_acq_rel
  )) return true;
  status = static_cast<std::uint32_t>(WorkerSlotStatus::kSubmitted);
  return control->status.compare_exchange_strong(
    status, static_cast<std::uint32_t>(WorkerSlotStatus::kDropped), std::memory_order_acq_rel
  );
}

std::optional<std::uint64_t> WorkerTransport::BeginProcessing(const std::size_t slotIndex) {
  if (!OwnsSlot(slotIndex)) return std::nullopt;
  auto* control = reinterpret_cast<SharedSlotControl*>(SlotBytes(slotIndex));
  auto status = static_cast<std::uint32_t>(WorkerSlotStatus::kSubmitted);
  if (!control->status.compare_exchange_strong(
    status, static_cast<std::uint32_t>(WorkerSlotStatus::kProcessing), std::memory_order_acq_rel
  )) {
    return std::nullopt;
  }
  return control->sequence.load(std::memory_order_acquire);
}

bool WorkerTransport::ReleaseDropped(const std::size_t slotIndex) {
  if (!OwnsSlot(slotIndex)) return false;
  auto* control = reinterpret_cast<SharedSlotControl*>(SlotBytes(slotIndex));
  auto status = static_cast<std::uint32_t>(WorkerSlotStatus::kDropped);
  return control->status.compare_exchange_strong(
    status, static_cast<std::uint32_t>(WorkerSlotStatus::kFree), std::memory_order_acq_rel
  );
}

bool WorkerTransport::ReleaseCompleted(const std::size_t slotIndex, const std::uint64_t sequence) {
  if (!OwnsSlot(slotIndex)) return false;
  auto* control = reinterpret_cast<SharedSlotControl*>(SlotBytes(slotIndex));
  if (control->sequence.load(std::memory_order_acquire) != sequence) return false;
  auto status = static_cast<std::uint32_t>(WorkerSlotStatus::kComplete);
  return control->status.compare_exchange_strong(
    status, static_cast<std::uint32_t>(WorkerSlotStatus::kFree), std::memory_order_acq_rel
  );
}

bool WorkerTransport::CancelSubmit(const std::size_t slotIndex, const std::uint64_t sequence) {
  if (!OwnsSlot(slotIndex)) return false;
  auto* control = reinterpret_cast<SharedSlotControl*>(SlotBytes(slotIndex));
  if (control->sequence.load(std::memory_order_acquire) != sequence) return false;
  auto status = static_cast<std::uint32_t>(WorkerSlotStatus::kSubmitted);
  return control->status.compare_exchange_strong(
    status, static_cast<std::uint32_t>(WorkerSlotStatus::kFree), std::memory_order_acq_rel
  );
}

WorkerSlot WorkerTransport::slot(const std::size_t slotIndex) const {
  if (!OwnsSlot(slotIndex)) return {};
  const auto* control = reinterpret_cast<const SharedSlotControl*>(SlotBytes(slotIndex));
  return WorkerSlot{
    .sequence = control->sequence.load(std::memory_order_acquire),
    .status = static_cast<WorkerSlotStatus>(control->status.load(std::memory_order_acquire)),
  };
}

bool WorkerTransport::Read(const std::size_t slotIndex, const std::uint64_t expectedSequence) const {
  if (!OwnsSlot(slotIndex)) return false;
  const auto current = slot(slotIndex);
  return current.status == WorkerSlotStatus::kComplete && current.sequence == expectedSequence;
}

WorkerHealth WorkerTransport::health() const {
  if (!mapping_) return WorkerHealth::kFaulted;
  return static_cast<WorkerHealth>(static_cast<const SharedHeader*>(mapping_->address)->health.load(std::memory_order_acquire));
}

std::optional<WorkerDiagnostic> WorkerTransport::ReadDiagnostic() {
  if (!mapping_) return std::nullopt;
  auto* header = static_cast<SharedHeader*>(mapping_->address);
  const auto read = header->diagnosticRead.load(std::memory_order_relaxed);
  if (read == header->diagnosticWrite.load(std::memory_order_acquire)) return std::nullopt;
  const auto result = header->diagnostics[read % kDiagnosticCapacity];
  header->diagnosticRead.store(read + 1, std::memory_order_release);
  return result;
}

int WorkerTransport::fileDescriptor() const {
  return mapping_ ? mapping_->fileDescriptor : -1;
}

std::uint64_t WorkerTransport::token() const {
  return mapping_ ? mapping_->token : 0;
}

bool WorkerTransport::valid() const {
  return mapping_ != nullptr;
}

const WorkerTransportLayout& WorkerTransport::layout() const {
  return layout_;
}

std::size_t WorkerTransport::maximumFrames() const {
  return layout_.maximumFrames;
}

std::size_t WorkerTransport::inputChannels() const {
  return layout_.inputChannels;
}

std::size_t WorkerTransport::outputChannels() const {
  return layout_.outputChannels;
}

std::size_t WorkerTransport::numSamples(const std::size_t slotIndex) const {
  if (!OwnsSlot(slotIndex)) return 0;
  return reinterpret_cast<const SharedSlotControl*>(SlotBytes(slotIndex))->numSamples;
}

std::span<const WorkerTransportEvent> WorkerTransport::events(const std::size_t slotIndex) const {
  if (!OwnsSlot(slotIndex)) return {};
  const auto* control = reinterpret_cast<const SharedSlotControl*>(SlotBytes(slotIndex));
  if (control->eventCount > layout_.maximumEventsPerBlock) return {};
  return {reinterpret_cast<const WorkerTransportEvent*>(SlotBytes(slotIndex) + Align(sizeof(SharedSlotControl))), control->eventCount};
}

std::span<float> WorkerTransport::input(const std::size_t slotIndex) {
  if (!OwnsSlot(slotIndex)) return {};
  return {reinterpret_cast<float*>(SlotBytes(slotIndex) + Align(sizeof(SharedSlotControl)) + layout_.eventBytesPerSlot), layout_.maximumFrames * layout_.inputChannels};
}

std::span<const float> WorkerTransport::output(const std::size_t slotIndex) const {
  if (!OwnsSlot(slotIndex)) return {};
  const auto* bytes = SlotBytes(slotIndex) + Align(sizeof(SharedSlotControl)) + layout_.eventBytesPerSlot + layout_.maximumFrames * layout_.inputChannels * kSampleBytes;
  return {reinterpret_cast<const float*>(bytes), layout_.maximumFrames * layout_.outputChannels};
}

std::span<float> WorkerTransport::output(const std::size_t slotIndex) {
  if (!OwnsSlot(slotIndex)) return {};
  auto* bytes = SlotBytes(slotIndex) + Align(sizeof(SharedSlotControl)) + layout_.eventBytesPerSlot + layout_.maximumFrames * layout_.inputChannels * kSampleBytes;
  return {reinterpret_cast<float*>(bytes), layout_.maximumFrames * layout_.outputChannels};
}

void WorkerTransport::PublishHealth(const WorkerHealth health) {
  if (mapping_) static_cast<SharedHeader*>(mapping_->address)->health.store(static_cast<std::uint32_t>(health), std::memory_order_release);
}

bool WorkerTransport::PublishDiagnostic(const WorkerDiagnostic diagnostic) {
  return mapping_ && PushDiagnostic(*static_cast<SharedHeader*>(mapping_->address), diagnostic);
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
  if (!CreateCloseOnExecPipe(control) || !CreateCloseOnExecPipe(response)) {
    if (control[0] >= 0) close(control[0]);
    if (control[1] >= 0) close(control[1]);
    if (response[0] >= 0) close(response[0]);
    if (response[1] >= 0) close(response[1]);
    return false;
  }
  if (transport->fileDescriptor() <= STDERR_FILENO || control[0] <= STDERR_FILENO || response[1] <= STDERR_FILENO) {
    close(control[0]);
    close(control[1]);
    close(response[0]);
    close(response[1]);
    return false;
  }
  const auto fd = std::to_string(STDIN_FILENO);
  const auto controlFd = std::to_string(STDOUT_FILENO);
  const auto responseFd = std::to_string(STDERR_FILENO);
  const auto token = std::to_string(transport->token());
  std::array<std::string, 9> argumentValues{
    configuration.executable,
    "--transport-fd",
    fd,
    "--control-fd",
    controlFd,
    "--response-fd",
    responseFd,
    "--token",
    token,
  };
  std::array<char*, 10> arguments{};
  for (std::size_t index = 0; index < argumentValues.size(); ++index) arguments[index] = argumentValues[index].data();
  posix_spawn_file_actions_t fileActions{};
  posix_spawnattr_t attributes{};
  const auto actionsReady = posix_spawn_file_actions_init(&fileActions) == 0;
  const auto attributesReady = actionsReady && posix_spawnattr_init(&attributes) == 0;
  short flags = POSIX_SPAWN_CLOEXEC_DEFAULT;
  const auto spawnConfigured = attributesReady
    && posix_spawnattr_setflags(&attributes, flags) == 0
    && posix_spawn_file_actions_adddup2(&fileActions, transport->fileDescriptor(), STDIN_FILENO) == 0
    && posix_spawn_file_actions_adddup2(&fileActions, control[0], STDOUT_FILENO) == 0
    && posix_spawn_file_actions_adddup2(&fileActions, response[1], STDERR_FILENO) == 0;
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
  controlWriteDescriptor_ = control[1];
  responseReadDescriptor_ = response[0];
  childProcessId_ = child;
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
  if (childAlive) {
    int status = 0;
    childAlive = waitpid(childProcessId_, &status, WNOHANG) == 0;
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
  if (childProcessId_ >= 0 && childAlive) {
    if (!WaitForChildExit(childProcessId_, 250)) {
      kill(childProcessId_, SIGTERM);
      if (!WaitForChildExit(childProcessId_, 250)) {
        kill(childProcessId_, SIGKILL);
        int status = 0;
        static_cast<void>(waitpid(childProcessId_, &status, 0));
      }
    }
  }
  childProcessId_ = -1;
  transport_.reset();
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
  const std::span<const WorkerTransportEvent> events
) {
  return transport_ && transport_->Submit(slotIndex, sequence, numSamples, events);
}

bool WorkerRuntime::CancelPublishedSubmission(const std::size_t slotIndex, const std::uint64_t sequence) {
  return transport_ && transport_->CancelSubmit(slotIndex, sequence);
}

bool WorkerRuntime::DispatchPublishedSubmission(const std::size_t slotIndex, const std::uint64_t sequence) {
  if (!transport_ || transport_->slot(slotIndex).sequence != sequence
    || !WriteWorkerControlCommand(controlWriteDescriptor_, WorkerControlCommand::kProcess)) {
    return false;
  }
  return true;
}

std::optional<WorkerEditorResponse> WorkerRuntime::ExecuteEditorCommand(
  const WorkerControlCommand command,
  const std::uint32_t width,
  const std::uint32_t height
) {
  if (!transport_ || responseReadDescriptor_ < 0
    || command < WorkerControlCommand::kEditorOpen || command > WorkerControlCommand::kEditorStatus
    || !WriteWorkerControlCommand(controlWriteDescriptor_, command, width, height)) {
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
  const std::span<float> output
) {
  if (!transport_ || !transport_->Read(slotIndex, expectedSequence)) return false;
  const auto source = transport_->output(slotIndex);
  const std::size_t samples = transport_->numSamples(slotIndex);
  const std::size_t channels = transport_->outputChannels();
  if (output.size() != samples * channels) return false;
  for (std::size_t channel = 0; channel < channels; ++channel) {
    std::memcpy(
      output.data() + channel * samples,
      source.data() + channel * transport_->maximumFrames(),
      samples * sizeof(float)
    );
  }
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
    int status = 0;
    if (waitpid(childProcessId_, &status, WNOHANG) == childProcessId_) return WorkerHealth::kFaulted;
  }
  return transport_->health();
}

std::optional<WorkerDiagnostic> WorkerRuntime::ReadDiagnostic() {
  return transport_ ? transport_->ReadDiagnostic() : std::nullopt;
}

const WorkerTransport* WorkerRuntime::transport() const {
  return transport_ ? &*transport_ : nullptr;
}

}  // namespace daw::plugin_host
