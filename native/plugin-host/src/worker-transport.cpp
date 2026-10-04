#include "worker-supervisor.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <bit>
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <limits>
#include <random>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

namespace daw::plugin_host {
namespace {

constexpr std::size_t kSampleBytes = sizeof(float);
constexpr std::size_t kCacheLineBytes = 64;
constexpr std::uint32_t kDiagnosticCapacity = 32;
constexpr std::uint64_t kTransportMagic = 0x444157575452414eULL;

struct alignas(kCacheLineBytes) SharedSlotControl {
  std::atomic<std::uint64_t> sequence{0};
  std::atomic<std::uint32_t> status{static_cast<std::uint32_t>(WorkerSlotStatus::kFree)};
  std::uint32_t numSamples = 0;
  std::uint32_t eventCount = 0;
  std::uint32_t contextFlags = 0;
  std::uint32_t transportEpoch = 0;
  std::int64_t projectTimeSamples = 0;
  std::int64_t continuousTimeSamples = 0;
  double tempoBpm = 0.0;
  double projectTimeMusic = 0.0;
  std::uint32_t timeSignatureNumerator = 0;
  std::uint32_t timeSignatureDenominator = 0;
  double cycleStartMusic = 0.0;
  double cycleEndMusic = 0.0;
  std::uint64_t outputSilenceFlags = 0;
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
  std::atomic<std::uint32_t> tailMetadataSequence{0};
  std::atomic<std::uint32_t> tailMetadataFrames{0};
  std::atomic<std::uint64_t> processingCount{0};
  std::atomic<std::uint64_t> processingMaximumNanoseconds{0};
  std::atomic<std::uint64_t> processingDeadlineMisses{0};
  std::atomic<std::uint64_t> processingBuckets[kWorkerProcessingHistogramBuckets]{};
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

}  // namespace

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
  const auto unalignedSlotBytes = Add(Align(sizeof(SharedSlotControl)), *slotDataBytes);
  const auto slotBytes = unalignedSlotBytes ? std::optional<std::size_t>{Align(*unalignedSlotBytes)} : std::nullopt;
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
  const std::span<const WorkerTransportEvent> events,
  const WorkerBlockContext& context
) {
  if (!OwnsSlot(slotIndex) || sequence == 0 || numSamples > layout_.maximumFrames
    || events.size() > layout_.maximumEventsPerBlock) {
    return false;
  }
  if (numSamples > 0 && (context.transportEpoch == 0 || context.projectTimeSamples < 0
    || !std::isfinite(context.tempoBpm) || context.tempoBpm < 0.0
    || !std::isfinite(context.projectTimeMusic)
    || !std::isfinite(context.cycleStartMusic) || !std::isfinite(context.cycleEndMusic)
    || context.timeSignatureNumerator > 32 || context.timeSignatureDenominator > 32)) return false;
  for (const auto& event : events) {
    if (event.sampleOffset >= numSamples) return false;
  }
  auto* control = reinterpret_cast<SharedSlotControl*>(SlotBytes(slotIndex));
  const auto status = static_cast<WorkerSlotStatus>(control->status.load(std::memory_order_acquire));
  if (status != WorkerSlotStatus::kFree && status != WorkerSlotStatus::kComplete) return false;
  control->numSamples = static_cast<std::uint32_t>(numSamples);
  control->eventCount = static_cast<std::uint32_t>(events.size());
  control->contextFlags = (context.playing ? 1U : 0U)
    | (context.recording ? 2U : 0U)
    | (context.cycleActive ? 4U : 0U)
    | (context.discontinuity ? 8U : 0U);
  control->transportEpoch = context.transportEpoch;
  control->projectTimeSamples = context.projectTimeSamples;
  control->continuousTimeSamples = context.continuousTimeSamples;
  control->tempoBpm = context.tempoBpm;
  control->projectTimeMusic = context.projectTimeMusic;
  control->timeSignatureNumerator = context.timeSignatureNumerator;
  control->timeSignatureDenominator = context.timeSignatureDenominator;
  control->cycleStartMusic = context.cycleStartMusic;
  control->cycleEndMusic = context.cycleEndMusic;
  control->outputSilenceFlags = 0;
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

std::optional<WorkerTailMetadata> WorkerTransport::ReadTailMetadata() const {
  if (!mapping_) return std::nullopt;
  const auto* header = static_cast<const SharedHeader*>(mapping_->address);
  const auto first = header->tailMetadataSequence.load(std::memory_order_acquire);
  if ((first & 1U) != 0) return std::nullopt;
  const auto frames = header->tailMetadataFrames.load(std::memory_order_relaxed);
  const auto second = header->tailMetadataSequence.load(std::memory_order_acquire);
  if (first == 0 || first != second || (second & 1U) != 0 || !IsValidWorkerTailFrames(frames)) {
    return std::nullopt;
  }
  return WorkerTailMetadata{
    .workerGeneration = header->token,
    .tailFrames = frames,
  };
}

WorkerProcessingMetrics WorkerTransport::ReadProcessingMetrics() const {
  WorkerProcessingMetrics result;
  if (!mapping_) return result;
  const auto* header = static_cast<const SharedHeader*>(mapping_->address);
  result.count = header->processingCount.load(std::memory_order_relaxed);
  result.maximum_nanoseconds = header->processingMaximumNanoseconds.load(std::memory_order_relaxed);
  result.deadline_misses = header->processingDeadlineMisses.load(std::memory_order_relaxed);
  for (std::size_t index = 0; index < result.buckets.size(); ++index) {
    result.buckets[index] = header->processingBuckets[index].load(std::memory_order_relaxed);
  }
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

WorkerBlockContext WorkerTransport::context(const std::size_t slotIndex) const {
  if (!OwnsSlot(slotIndex)) return {};
  const auto* control = reinterpret_cast<const SharedSlotControl*>(SlotBytes(slotIndex));
  const auto flags = control->contextFlags;
  return {
    .projectTimeSamples = control->projectTimeSamples,
    .continuousTimeSamples = control->continuousTimeSamples,
    .tempoBpm = control->tempoBpm,
    .projectTimeMusic = control->projectTimeMusic,
    .timeSignatureNumerator = control->timeSignatureNumerator,
    .timeSignatureDenominator = control->timeSignatureDenominator,
    .cycleStartMusic = control->cycleStartMusic,
    .cycleEndMusic = control->cycleEndMusic,
    .transportEpoch = control->transportEpoch,
    .playing = (flags & 1U) != 0,
    .recording = (flags & 2U) != 0,
    .cycleActive = (flags & 4U) != 0,
    .discontinuity = (flags & 8U) != 0,
  };
}

std::uint64_t WorkerTransport::outputSilenceFlags(const std::size_t slotIndex) const {
  if (!OwnsSlot(slotIndex)) return 0;
  return reinterpret_cast<const SharedSlotControl*>(SlotBytes(slotIndex))->outputSilenceFlags;
}

void WorkerTransport::SetOutputSilenceFlags(const std::size_t slotIndex, const std::uint64_t flags) {
  if (OwnsSlot(slotIndex)) {
    reinterpret_cast<SharedSlotControl*>(SlotBytes(slotIndex))->outputSilenceFlags = flags;
  }
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

void WorkerTransport::PublishTailMetadata(const std::uint32_t tailFrames) {
  if (!mapping_ || !IsValidWorkerTailFrames(tailFrames)) return;
  auto* header = static_cast<SharedHeader*>(mapping_->address);
  header->tailMetadataSequence.fetch_add(1, std::memory_order_acq_rel);
  header->tailMetadataFrames.store(tailFrames, std::memory_order_relaxed);
  header->tailMetadataSequence.fetch_add(1, std::memory_order_release);
}

void WorkerTransport::RecordProcessingDuration(
  const std::uint64_t durationNanoseconds,
  const std::uint64_t deadlineNanoseconds
) {
  if (!mapping_) return;
  auto* header = static_cast<SharedHeader*>(mapping_->address);
  header->processingCount.fetch_add(1, std::memory_order_relaxed);
  auto maximum = header->processingMaximumNanoseconds.load(std::memory_order_relaxed);
  while (durationNanoseconds > maximum && !header->processingMaximumNanoseconds.compare_exchange_weak(
    maximum, durationNanoseconds, std::memory_order_relaxed, std::memory_order_relaxed)) {}
  if (deadlineNanoseconds > 0 && durationNanoseconds > deadlineNanoseconds) {
    header->processingDeadlineMisses.fetch_add(1, std::memory_order_relaxed);
  }
  const auto bucket = durationNanoseconds == 0
    ? 0U
    : std::min<std::size_t>(
      kWorkerProcessingHistogramBuckets - 1,
      static_cast<std::size_t>(std::bit_width(durationNanoseconds) - 1));
  header->processingBuckets[bucket].fetch_add(1, std::memory_order_relaxed);
}

}  // namespace daw::plugin_host
