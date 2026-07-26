#include "vst3-worker.h"

#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/utility/stringconvert.h"
#include "pluginterfaces/base/ibstream.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivsthostapplication.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "pluginterfaces/gui/iplugview.h"

#include <CommonCrypto/CommonDigest.h>
#include <Security/Security.h>
#include <libkern/OSByteOrder.h>
#include <mach-o/fat.h>
#include <mach-o/loader.h>
#include <sys/xattr.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <limits>
#include <memory>
#include <string_view>
#include <utility>

namespace daw::plugin_host {
namespace {

using Steinberg::FUnknown;
using Steinberg::FUnknownPrivate::iidEqual;
using Steinberg::IBStream;
using Steinberg::IPtr;
using Steinberg::TUID;
using Steinberg::Vst::AudioBusBuffers;
using Steinberg::Vst::BusInfo;
using Steinberg::Vst::Event;
using Steinberg::Vst::EventList;
using Steinberg::Vst::IAudioProcessor;
using Steinberg::Vst::IComponent;
using Steinberg::Vst::IComponentHandler;
using Steinberg::Vst::IEditController;
using Steinberg::Vst::IHostApplication;
using Steinberg::IPlugView;
using Steinberg::Vst::ParameterChanges;
using Steinberg::Vst::ProcessContext;
using Steinberg::Vst::ProcessData;
using Steinberg::Vst::ProcessSetup;

constexpr std::size_t kMaximumPluginBinaryBytes = 2U * 1024U * 1024U * 1024U;

class BoundedStateStream final : public IBStream {
 public:
  explicit BoundedStateStream(std::span<const std::uint8_t> input = {}) : bytes_(kMaximumWorkerStateBytes), length_(input.size()) {
    if (!input.empty()) std::memcpy(bytes_.data(), input.data(), input.size());
  }

  [[nodiscard]] std::vector<std::uint8_t> TakeBytes() const {
    return {bytes_.begin(), bytes_.begin() + static_cast<std::ptrdiff_t>(length_)};
  }

  Steinberg::tresult PLUGIN_API read(void* buffer, Steinberg::int32 numBytes, Steinberg::int32* numBytesRead) override {
    if (!buffer || numBytes < 0 || !numBytesRead) return Steinberg::kInvalidArgument;
    const auto available = length_ - cursor_;
    const auto count = std::min<std::size_t>(available, static_cast<std::size_t>(numBytes));
    std::memcpy(buffer, bytes_.data() + cursor_, count);
    cursor_ += count;
    *numBytesRead = static_cast<Steinberg::int32>(count);
    return Steinberg::kResultOk;
  }

  Steinberg::tresult PLUGIN_API write(void* buffer, Steinberg::int32 numBytes, Steinberg::int32* numBytesWritten) override {
    if (!buffer || numBytes < 0 || !numBytesWritten || cursor_ > kMaximumWorkerStateBytes
      || static_cast<std::size_t>(numBytes) > kMaximumWorkerStateBytes - cursor_) {
      return Steinberg::kOutOfMemory;
    }
    std::memcpy(bytes_.data() + cursor_, buffer, static_cast<std::size_t>(numBytes));
    cursor_ += static_cast<std::size_t>(numBytes);
    length_ = std::max(length_, cursor_);
    *numBytesWritten = numBytes;
    return Steinberg::kResultOk;
  }

  Steinberg::tresult PLUGIN_API seek(Steinberg::int64 pos, Steinberg::int32 mode, Steinberg::int64* result) override {
    const auto base = mode == Steinberg::IBStream::kIBSeekSet ? 0 : mode == Steinberg::IBStream::kIBSeekCur
      ? static_cast<Steinberg::int64>(cursor_) : static_cast<Steinberg::int64>(length_);
    if (!result || (pos > 0 && pos > static_cast<Steinberg::int64>(kMaximumWorkerStateBytes) - base)
      || (pos < 0 && -pos > base)) return Steinberg::kInvalidArgument;
    cursor_ = static_cast<std::size_t>(base + pos);
    *result = static_cast<Steinberg::int64>(cursor_);
    return Steinberg::kResultOk;
  }

  Steinberg::tresult PLUGIN_API tell(Steinberg::int64* pos) override {
    if (!pos) return Steinberg::kInvalidArgument;
    *pos = static_cast<Steinberg::int64>(cursor_);
    return Steinberg::kResultOk;
  }

  Steinberg::tresult PLUGIN_API queryInterface(const TUID iid, void** object) override {
    if (!object) return Steinberg::kInvalidArgument;
    if (iidEqual(iid, Steinberg::FUnknown::iid) || iidEqual(iid, IBStream::iid)) {
      *object = static_cast<IBStream*>(this);
      return Steinberg::kResultOk;
    }
    *object = nullptr;
    return Steinberg::kNoInterface;
  }
  Steinberg::uint32 PLUGIN_API addRef() override { return 1; }
  Steinberg::uint32 PLUGIN_API release() override { return 1; }

 private:
  std::vector<std::uint8_t> bytes_;
  std::size_t length_ = 0;
  std::size_t cursor_ = 0;
};

class WorkerHostContext final : public IHostApplication, public IComponentHandler {
 public:
  explicit WorkerHostContext(std::vector<WorkerNotification>& notifications) : notifications_(notifications) {}

  Steinberg::tresult PLUGIN_API getName(Steinberg::Vst::String128 name) override {
    constexpr std::u16string_view workerName = u"daw-vst3-worker";
    std::copy(workerName.begin(), workerName.end(), name);
    name[workerName.size()] = 0;
    return Steinberg::kResultOk;
  }
  Steinberg::tresult PLUGIN_API createInstance(TUID, TUID, void** object) override {
    if (object) *object = nullptr;
    return Steinberg::kNoInterface;
  }
  Steinberg::tresult PLUGIN_API beginEdit(Steinberg::Vst::ParamID) override { return Steinberg::kResultOk; }
  Steinberg::tresult PLUGIN_API performEdit(Steinberg::Vst::ParamID, Steinberg::Vst::ParamValue) override { return Steinberg::kResultOk; }
  Steinberg::tresult PLUGIN_API endEdit(Steinberg::Vst::ParamID) override { return Steinberg::kResultOk; }
  Steinberg::tresult PLUGIN_API restartComponent(Steinberg::int32 flags) override {
    if (notifications_.size() < notifications_.capacity()) {
      notifications_.push_back({.kind = WorkerNotificationKind::kRestart, .message = "Plugin requested a bounded component restart.", .value = static_cast<std::uint32_t>(flags)});
    }
    return Steinberg::kResultOk;
  }
  Steinberg::tresult PLUGIN_API queryInterface(const TUID iid, void** object) override {
    if (!object) return Steinberg::kInvalidArgument;
    if (iidEqual(iid, Steinberg::FUnknown::iid) || iidEqual(iid, IHostApplication::iid)) {
      *object = static_cast<IHostApplication*>(this);
      return Steinberg::kResultOk;
    }
    if (iidEqual(iid, IComponentHandler::iid)) {
      *object = static_cast<IComponentHandler*>(this);
      return Steinberg::kResultOk;
    }
    *object = nullptr;
    return Steinberg::kNoInterface;
  }
  Steinberg::uint32 PLUGIN_API addRef() override { return 1; }
  Steinberg::uint32 PLUGIN_API release() override { return 1; }

 private:
  std::vector<WorkerNotification>& notifications_;
};

std::optional<std::string> HashFile(const std::filesystem::path& path, CC_SHA256_CTX& hash, std::size_t& bytes) {
  std::error_code error;
  const auto size = std::filesystem::file_size(path, error);
  if (error || size > kMaximumPluginBinaryBytes - bytes) return std::nullopt;
  std::ifstream file(path, std::ios::binary);
  if (!file) return std::nullopt;
  std::array<char, 64 * 1024> chunk{};
  while (file) {
    file.read(chunk.data(), static_cast<std::streamsize>(chunk.size()));
    const auto count = file.gcount();
    if (count > 0) {
      CC_SHA256_Update(&hash, chunk.data(), static_cast<CC_LONG>(count));
      bytes += static_cast<std::size_t>(count);
    }
  }
  return path.string();
}

std::optional<std::string> HashBinary(const std::filesystem::path& path) {
  CC_SHA256_CTX hash{};
  CC_SHA256_Init(&hash);
  std::size_t bytes = 0;
  if (!HashFile(path, hash, bytes)) return std::nullopt;
  std::array<unsigned char, CC_SHA256_DIGEST_LENGTH> digest{};
  CC_SHA256_Final(digest.data(), &hash);
  static constexpr char digits[] = "0123456789abcdef";
  std::string result;
  result.reserve(digest.size() * 2);
  for (const auto byte : digest) {
    result += digits[byte >> 4U];
    result += digits[byte & 0x0FU];
  }
  return result;
}

std::optional<std::string> HashBundle(const std::filesystem::path& bundle) {
  CC_SHA256_CTX hash{};
  CC_SHA256_Init(&hash);
  std::size_t bytes = 0;
  const auto visit = [&](const auto& self, const std::filesystem::path& directory, const std::string& relative) -> bool {
    std::error_code error;
    std::vector<std::filesystem::directory_entry> entries;
    for (std::filesystem::directory_iterator iterator(directory, error), end; !error && iterator != end; iterator.increment(error)) {
      entries.push_back(*iterator);
    }
    if (error) return false;
    std::sort(entries.begin(), entries.end(), [](const auto& left, const auto& right) {
      return left.path().filename().string() < right.path().filename().string();
    });
    for (const auto& entry : entries) {
      const auto name = entry.path().filename().string();
      const auto entryRelative = relative.empty() ? name : relative + "/" + name;
      if (entry.is_symlink(error) || error) return false;
      if (entry.is_directory(error)) {
        if (error) return false;
        const auto header = "directory:" + entryRelative + "\n";
        CC_SHA256_Update(&hash, header.data(), static_cast<CC_LONG>(header.size()));
        if (!self(self, entry.path(), entryRelative)) return false;
        continue;
      }
      if (!entry.is_regular_file(error) || error) return false;
      const auto size = entry.file_size(error);
      if (error || size > kMaximumPluginBinaryBytes - bytes) return false;
      const auto header = "file:" + entryRelative + ":" + std::to_string(size) + "\n";
      CC_SHA256_Update(&hash, header.data(), static_cast<CC_LONG>(header.size()));
      if (!HashFile(entry.path(), hash, bytes)) return false;
    }
    return true;
  };
  if (!visit(visit, bundle, "")) return std::nullopt;
  std::array<unsigned char, CC_SHA256_DIGEST_LENGTH> digest{};
  CC_SHA256_Final(digest.data(), &hash);
  static constexpr char digits[] = "0123456789abcdef";
  std::string result;
  result.reserve(digest.size() * 2);
  for (const auto byte : digest) {
    result += digits[byte >> 4U];
    result += digits[byte & 0x0FU];
  }
  return result;
}

bool IsTrustedLaunch(const WorkerLaunchEligibility& eligibility) {
  if (!IsWorkerLaunchEligible(eligibility)) return false;
  std::error_code error;
  const auto bundle = std::filesystem::canonical(eligibility.canonicalBundlePath, error);
  const auto executable = std::filesystem::canonical(eligibility.canonicalExecutablePath, error);
  if (error || !std::filesystem::is_directory(bundle) || !std::filesystem::is_regular_file(executable)
    || executable.string() != eligibility.canonicalExecutablePath
    || !executable.string().starts_with(bundle.string() + "/")) return false;
  const auto binaryHash = HashBinary(executable);
  const auto bundleHash = HashBundle(bundle);
  const auto quarantineAbsent = [](const std::filesystem::path& target) {
    errno = 0;
    const auto quarantineBytes = getxattr(
      target.c_str(), "com.apple.quarantine", nullptr, 0, 0, XATTR_NOFOLLOW
    );
    return quarantineBytes < 0 && errno == ENOATTR;
  };
  if (!quarantineAbsent(bundle) || !quarantineAbsent(executable)) return false;
  std::ifstream binary(executable, std::ios::binary);
  std::uint32_t magic = 0;
  binary.read(reinterpret_cast<char*>(&magic), sizeof(magic));
  if (!binary) return false;
  bool arm64 = false;
  if (magic == MH_MAGIC_64) {
    mach_header_64 header{};
    binary.seekg(0);
    binary.read(reinterpret_cast<char*>(&header), sizeof(header));
    arm64 = binary && header.cputype == CPU_TYPE_ARM64;
  } else if (OSSwapBigToHostInt32(magic) == FAT_MAGIC || OSSwapBigToHostInt32(magic) == FAT_MAGIC_64) {
    fat_header header{};
    binary.seekg(0);
    binary.read(reinterpret_cast<char*>(&header), sizeof(header));
    const auto architectures = OSSwapBigToHostInt32(header.nfat_arch);
    if (!binary || architectures > 64) return false;
    for (std::uint32_t index = 0; index < architectures; ++index) {
      if (OSSwapBigToHostInt32(magic) == FAT_MAGIC_64) {
        fat_arch_64 architecture{};
        binary.read(reinterpret_cast<char*>(&architecture), sizeof(architecture));
        if (!binary) return false;
        arm64 = OSSwapBigToHostInt32(architecture.cputype) == CPU_TYPE_ARM64;
      } else {
        fat_arch architecture{};
        binary.read(reinterpret_cast<char*>(&architecture), sizeof(architecture));
        if (!binary) return false;
        arm64 = OSSwapBigToHostInt32(architecture.cputype) == CPU_TYPE_ARM64;
      }
      if (arm64) break;
    }
  }
  if (!arm64) return false;
  const auto bundlePath = bundle.string();
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(
    kCFAllocatorDefault,
    reinterpret_cast<const UInt8*>(bundlePath.data()),
    static_cast<CFIndex>(bundlePath.size()),
    true
  );
  SecStaticCodeRef code = nullptr;
  const auto validSignature = url && SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code) == errSecSuccess
    && SecStaticCodeCheckValidity(code, kSecCSStrictValidate, nullptr) == errSecSuccess;
  if (code) CFRelease(code);
  if (url) CFRelease(url);
  return validSignature && binaryHash && bundleHash
    && *binaryHash == eligibility.binaryFingerprint && *bundleHash == eligibility.bundleFingerprint;
}

bool ValidSetup(const WorkerProcessSetup& setup) {
  return std::isfinite(setup.sampleRate) && setup.sampleRate > 0.0 && setup.sampleRate <= 384'000.0
    && setup.maximumBlockFrames > 0 && setup.maximumBlockFrames <= kMaximumWorkerFrames
    && setup.inputChannels <= kMaximumWorkerChannels && setup.outputChannels > 0 && setup.outputChannels <= kMaximumWorkerChannels;
}

}  // namespace

std::string Sha256(const std::span<const std::uint8_t> bytes) {
  std::array<unsigned char, CC_SHA256_DIGEST_LENGTH> digest{};
  CC_SHA256(bytes.data(), static_cast<CC_LONG>(bytes.size()), digest.data());
  static constexpr char digits[] = "0123456789abcdef";
  std::string result;
  result.reserve(digest.size() * 2);
  for (const auto byte : digest) {
    result += digits[byte >> 4U];
    result += digits[byte & 0x0FU];
  }
  return result;
}

bool IsValidWorkerState(const WorkerState& state) {
  return state.bytes.size() <= kMaximumWorkerStateBytes && state.sha256 == Sha256(state.bytes);
}

class Vst3Worker::Implementation {
 public:
  std::vector<WorkerNotification> notifications;
  WorkerHostContext context{notifications};
  VST3::Hosting::Module::Ptr module;
  IPtr<IComponent> component;
  IPtr<IAudioProcessor> processor;
  IPtr<IEditController> controller;
  IPtr<IPlugView> editorView;
  std::optional<Vst3EditorWindow> editorWindow;
  std::vector<AudioBusBuffers> inputs;
  std::vector<AudioBusBuffers> outputs;
  std::vector<std::vector<Steinberg::Vst::Sample32*>> inputPointers;
  std::vector<std::vector<Steinberg::Vst::Sample32*>> outputPointers;
  ParameterChanges parameters{static_cast<Steinberg::int32>(kMaximumWorkerEvents)};
  EventList events{static_cast<Steinberg::int32>(kMaximumWorkerEvents)};
  ProcessContext processContext{};
  WorkerProcessSetup setup{};
  WorkerPluginRole role = WorkerPluginRole::kEffect;
  WorkerTransport* transport = nullptr;
  bool controllerIsComponent = false;
  bool editorUnsupported = false;
  bool active = false;
  bool processing = false;

  Implementation() {
    notifications.reserve(128);
  }
};

Vst3Worker::Vst3Worker() : implementation_(new Implementation()) {}

Vst3Worker::~Vst3Worker() {
  Dispose();
  delete implementation_;
}

bool Vst3Worker::Instantiate(const WorkerInstanceRequest& request) {
  Dispose();
  if (!IsTrustedLaunch(request.eligibility) || request.classId.size() != 32 || !ValidSetup(request.setup)) {
    implementation_->notifications.push_back({.kind = WorkerNotificationKind::kFault, .message = "Worker launch record is not trusted.", .value = 0});
    return false;
  }
  const auto classId = VST3::UID::fromString(request.classId);
  if (!classId) return false;
  std::string error;
  implementation_->module = VST3::Hosting::Module::create(request.eligibility.canonicalBundlePath, error);
  if (!implementation_->module) return false;
  const auto factory = implementation_->module->getFactory();
  const auto classInfo = std::find_if(factory.classInfos().begin(), factory.classInfos().end(), [&](const auto& candidate) {
    return candidate.ID() == *classId;
  });
  if (classInfo == factory.classInfos().end()) {
    Dispose();
    return false;
  }
  implementation_->role = std::find(classInfo->subCategories().begin(), classInfo->subCategories().end(), "Instrument")
      == classInfo->subCategories().end()
    ? WorkerPluginRole::kEffect
    : WorkerPluginRole::kInstrument;
  implementation_->module->getFactory().setHostContext(static_cast<IHostApplication*>(&implementation_->context));
  implementation_->component = implementation_->module->getFactory().createInstance<IComponent>(*classId);
  if (!implementation_->component || implementation_->component->initialize(static_cast<IHostApplication*>(&implementation_->context)) != Steinberg::kResultOk) {
    Dispose();
    return false;
  }
  implementation_->processor = Steinberg::FUnknownPtr<IAudioProcessor>(implementation_->component);
  if (!implementation_->processor) {
    Dispose();
    return false;
  }
  Steinberg::TUID controllerId{};
  if (implementation_->component->getControllerClassId(controllerId) == Steinberg::kResultOk) {
    implementation_->controller = implementation_->module->getFactory().createInstance<IEditController>(VST3::UID(controllerId));
  }
  if (!implementation_->controller) {
    implementation_->controller = Steinberg::FUnknownPtr<IEditController>(implementation_->component);
    implementation_->controllerIsComponent = true;
  }
  if (implementation_->controller) {
    if ((!implementation_->controllerIsComponent
      && implementation_->controller->initialize(static_cast<IHostApplication*>(&implementation_->context)) != Steinberg::kResultOk)
      || implementation_->controller->setComponentHandler(&implementation_->context) != Steinberg::kResultOk) {
      Dispose();
      return false;
    }
    const auto parameterCount = implementation_->controller->getParameterCount();
    for (Steinberg::int32 index = 0; index < parameterCount; ++index) {
      Steinberg::Vst::ParameterInfo info{};
      if (implementation_->controller->getParameterInfo(index, info) != Steinberg::kResultOk) {
        Dispose();
        return false;
      }
    }
  }
  implementation_->setup = request.setup;
  return true;
}

std::optional<WorkerManifest> Vst3Worker::PreflightManifest(
  const WorkerTransportRequest& transport,
  const std::uint32_t stateRevision
) {
  if (!implementation_->component || !implementation_->processor
    || transport.maximumFrames != implementation_->setup.maximumBlockFrames
    || transport.inputChannels != implementation_->setup.inputChannels
    || transport.outputChannels != implementation_->setup.outputChannels
    || !CreateWorkerTransportLayout(transport)) {
    return std::nullopt;
  }
  const auto inspectBuses = [&](const Steinberg::Vst::BusDirection direction) -> std::optional<std::vector<WorkerBusDescriptor>> {
    const auto count = implementation_->component->getBusCount(Steinberg::Vst::kAudio, direction);
    if (count < 0 || count > 32) return std::nullopt;
    std::vector<WorkerBusDescriptor> buses;
    buses.reserve(static_cast<std::size_t>(count));
    for (Steinberg::int32 index = 0; index < count; ++index) {
      BusInfo info{};
      if (implementation_->component->getBusInfo(Steinberg::Vst::kAudio, direction, index, info) != Steinberg::kResultOk
        || info.channelCount < 0 || info.channelCount > static_cast<Steinberg::int32>(kMaximumWorkerChannels)) {
        return std::nullopt;
      }
      auto name = Steinberg::Vst::StringConvert::convert(info.name, 128);
      if (name.empty()) name = direction == Steinberg::Vst::kInput ? "Input" : "Output";
      if (name.size() > 128) name.resize(128);
      buses.push_back({
        .name = std::move(name),
        .channels = static_cast<std::uint32_t>(info.channelCount),
        .enabled = (info.flags & Steinberg::Vst::BusInfo::kDefaultActive) != 0,
      });
    }
    return buses;
  };
  const auto inputBuses = inspectBuses(Steinberg::Vst::kInput);
  const auto outputBuses = inspectBuses(Steinberg::Vst::kOutput);
  if (!inputBuses || !outputBuses || outputBuses->empty()) return std::nullopt;
  ProcessSetup setup{
    Steinberg::Vst::kRealtime,
    Steinberg::Vst::kSample32,
    static_cast<Steinberg::int32>(implementation_->setup.maximumBlockFrames),
    implementation_->setup.sampleRate,
  };
  if (implementation_->processor->setupProcessing(setup) != Steinberg::kResultOk) return std::nullopt;
  const auto latency = implementation_->processor->getLatencySamples();
  const auto tail = implementation_->processor->getTailSamples();
  if (latency > 10'000'000 || (tail != Steinberg::Vst::kInfiniteTail && tail > 100'000'000)) return std::nullopt;
  WorkerManifest manifest{
    .version = kWorkerManifestVersion,
    .artifact = {
      .id = std::string(kWorkerArtifactId),
      .version = std::string(kWorkerArtifactVersion),
    },
    .startupProtocolVersion = kWorkerStartupProtocolVersion,
    .controlProtocolVersion = kWorkerControlProtocolVersion,
    .transportAbiVersion = kWorkerTransportAbiVersion,
    .arm64 = true,
    .role = implementation_->role,
    .inputBuses = *inputBuses,
    .outputBuses = *outputBuses,
    .transport = transport,
    .latencyFrames = latency,
    .tailFrames = tail == Steinberg::Vst::kInfiniteTail ? std::nullopt : std::optional<std::uint32_t>(tail),
    .stateRevision = stateRevision,
  };
  return IsValidWorkerManifest(manifest) ? std::optional<WorkerManifest>(std::move(manifest)) : std::nullopt;
}

bool Vst3Worker::ConfigureTransport(WorkerTransport& transport) {
  if (!implementation_->component || !implementation_->processor || transport.maximumFrames() < implementation_->setup.maximumBlockFrames
    || transport.inputChannels() != implementation_->setup.inputChannels || transport.outputChannels() != implementation_->setup.outputChannels) {
    return false;
  }
  const auto prepare = [&](const Steinberg::Vst::BusDirection direction, std::vector<AudioBusBuffers>& buses, std::vector<std::vector<Steinberg::Vst::Sample32*>>& pointers, const std::size_t expectedChannels) {
    const auto count = implementation_->component->getBusCount(Steinberg::Vst::kAudio, direction);
    if (count < 0) return false;
    if (expectedChannels == 0) return true;
    std::size_t channels = 0;
    for (Steinberg::int32 index = 0; index < count; ++index) {
      BusInfo info{};
      if (implementation_->component->getBusInfo(Steinberg::Vst::kAudio, direction, index, info) != Steinberg::kResultOk || info.channelCount < 0) return false;
      const auto busChannels = static_cast<std::size_t>(info.channelCount);
      if (busChannels > expectedChannels - channels) return false;
      if (implementation_->component->activateBus(Steinberg::Vst::kAudio, direction, index, true) != Steinberg::kResultOk) return false;
      buses.emplace_back();
      buses.back().numChannels = info.channelCount;
      pointers.emplace_back(busChannels);
      buses.back().channelBuffers32 = pointers.back().data();
      channels += busChannels;
      if (channels == expectedChannels) break;
    }
    return channels == expectedChannels;
  };
  if (!prepare(Steinberg::Vst::kInput, implementation_->inputs, implementation_->inputPointers, transport.inputChannels())
    || !prepare(Steinberg::Vst::kOutput, implementation_->outputs, implementation_->outputPointers, transport.outputChannels())) return false;
  ProcessSetup setup{Steinberg::Vst::kRealtime, Steinberg::Vst::kSample32, static_cast<Steinberg::int32>(implementation_->setup.maximumBlockFrames), implementation_->setup.sampleRate};
  if (implementation_->processor->setupProcessing(setup) != Steinberg::kResultOk
    || implementation_->component->setActive(true) != Steinberg::kResultOk
    || implementation_->processor->setProcessing(true) != Steinberg::kResultOk) {
    return false;
  }
  implementation_->active = true;
  implementation_->processing = true;
  implementation_->transport = &transport;
  implementation_->notifications.push_back({.kind = WorkerNotificationKind::kLatency, .message = "Plugin latency.", .value = implementation_->processor->getLatencySamples()});
  implementation_->notifications.push_back({.kind = WorkerNotificationKind::kBuses, .message = "Plugin buses are active.", .value = static_cast<std::uint32_t>(implementation_->inputs.size() + implementation_->outputs.size())});
  return true;
}

bool Vst3Worker::ProcessSubmittedSlot(const std::size_t slotIndex) {
  if (!ready() || !implementation_->transport || implementation_->transport->slot(slotIndex).status != WorkerSlotStatus::kProcessing) return false;
  const auto sequence = implementation_->transport->slot(slotIndex).sequence;
  const auto samples = implementation_->transport->numSamples(slotIndex);
  if (samples > implementation_->setup.maximumBlockFrames) return false;
  implementation_->parameters.clearQueue();
  implementation_->events.clear();
  for (const auto& event : implementation_->transport->events(slotIndex)) {
    if (event.sampleOffset >= samples) return false;
    if (event.kind == WorkerEventKind::kParameter) {
      if (!std::isfinite(event.parameterValue) || event.parameterValue < 0.0 || event.parameterValue > 1.0) return false;
      Steinberg::int32 index = 0;
      auto* queue = implementation_->parameters.addParameterData(event.parameterId, index);
      Steinberg::int32 point = 0;
      if (!queue || queue->addPoint(static_cast<Steinberg::int32>(event.sampleOffset), event.parameterValue, point) != Steinberg::kResultOk) return false;
      continue;
    }
    const auto status = static_cast<std::uint8_t>(event.midiData[0] & 0xF0U);
    if (status != 0x90U && status != 0x80U) continue;
    Event vstEvent{};
    vstEvent.busIndex = 0;
    vstEvent.sampleOffset = static_cast<Steinberg::int32>(event.sampleOffset);
    vstEvent.type = status == 0x90U && event.midiData[2] != 0 ? Event::kNoteOnEvent : Event::kNoteOffEvent;
    vstEvent.noteOn.channel = static_cast<Steinberg::int16>(event.midiData[0] & 0x0FU);
    vstEvent.noteOn.pitch = static_cast<Steinberg::int16>(event.midiData[1]);
    vstEvent.noteOn.velocity = static_cast<float>(event.midiData[2]) / 127.0F;
    vstEvent.noteOn.noteId = -1;
    if (implementation_->events.addEvent(vstEvent) != Steinberg::kResultOk) return false;
  }
  auto input = implementation_->transport->input(slotIndex);
  auto output = implementation_->transport->output(slotIndex);
  std::size_t inputChannel = 0;
  for (std::size_t bus = 0; bus < implementation_->inputs.size(); ++bus) {
    for (std::size_t channel = 0; channel < implementation_->inputPointers[bus].size(); ++channel) {
      implementation_->inputPointers[bus][channel] = input.data() + (inputChannel++ * implementation_->transport->maximumFrames());
    }
  }
  std::size_t outputChannel = 0;
  for (std::size_t bus = 0; bus < implementation_->outputs.size(); ++bus) {
    for (std::size_t channel = 0; channel < implementation_->outputPointers[bus].size(); ++channel) {
      implementation_->outputPointers[bus][channel] = output.data() + (outputChannel++ * implementation_->transport->maximumFrames());
    }
  }
  implementation_->processContext = {};
  implementation_->processContext.sampleRate = implementation_->setup.sampleRate;
  implementation_->processContext.projectTimeSamples = 0;
  ProcessData data{};
  data.processMode = Steinberg::Vst::kRealtime;
  data.symbolicSampleSize = Steinberg::Vst::kSample32;
  data.numSamples = static_cast<Steinberg::int32>(samples);
  data.numInputs = static_cast<Steinberg::int32>(implementation_->inputs.size());
  data.numOutputs = static_cast<Steinberg::int32>(implementation_->outputs.size());
  data.inputs = implementation_->inputs.data();
  data.outputs = implementation_->outputs.data();
  data.inputParameterChanges = &implementation_->parameters;
  data.inputEvents = &implementation_->events;
  data.processContext = &implementation_->processContext;
  if (implementation_->processor->process(data) != Steinberg::kResultOk) return false;
  return implementation_->transport->Complete(slotIndex, sequence);
}

std::optional<WorkerState> Vst3Worker::GetState() {
  if (!ready()) return std::nullopt;
  BoundedStateStream stream;
  if (implementation_->component->getState(&stream) != Steinberg::kResultOk) return std::nullopt;
  auto bytes = stream.TakeBytes();
  return WorkerState{.bytes = bytes, .sha256 = Sha256(bytes)};
}

bool Vst3Worker::SetState(const WorkerState& state) {
  if (!ready() || !IsValidWorkerState(state)) return false;
  BoundedStateStream stream{state.bytes};
  return implementation_->component->setState(&stream) == Steinberg::kResultOk;
}

bool Vst3Worker::EditorCommandSupported() const {
  return ready() && implementation_->controller && !implementation_->editorUnsupported;
}

WorkerEditorStatus Vst3Worker::EditorStatus() const {
  if (!implementation_->editorWindow) return {.supported = EditorCommandSupported()};
  const auto status = implementation_->editorWindow->status();
  return {.supported = status.supported, .open = status.open, .width = status.width, .height = status.height};
}

bool Vst3Worker::ExecuteEditorCommand(
  const WorkerEditorCommand command,
  const std::uint32_t width,
  const std::uint32_t height
) {
  if (!ready() || !implementation_->controller) return false;
  if (command == WorkerEditorCommand::kStatus) return true;
  if (command == WorkerEditorCommand::kOpen) {
    if (implementation_->editorWindow) {
      if (implementation_->editorWindow->Focus()) return true;
      implementation_->editorWindow.reset();
      implementation_->editorView = nullptr;
    }
    implementation_->editorView = implementation_->controller->createView(Steinberg::Vst::ViewType::kEditor);
    if (!implementation_->editorView) {
      implementation_->editorUnsupported = true;
      return false;
    }
    implementation_->editorWindow.emplace();
    if (!implementation_->editorWindow->Open(*implementation_->editorView)) {
      implementation_->editorWindow.reset();
      implementation_->editorView = nullptr;
      implementation_->editorUnsupported = true;
      return false;
    }
    return true;
  }
  if (!implementation_->editorWindow) return false;
  if (command == WorkerEditorCommand::kClose) {
    const auto closed = implementation_->editorWindow->Close();
    if (closed) {
      implementation_->editorWindow.reset();
      implementation_->editorView = nullptr;
    }
    return closed;
  }
  if (command == WorkerEditorCommand::kFocus) return implementation_->editorWindow->Focus();
  return command == WorkerEditorCommand::kResize && implementation_->editorWindow->Resize(width, height);
}

void Vst3Worker::Dispose() {
  if (!implementation_) return;
  implementation_->editorWindow.reset();
  implementation_->editorView = nullptr;
  if (implementation_->processing && implementation_->processor) implementation_->processor->setProcessing(false);
  if (implementation_->active && implementation_->component) implementation_->component->setActive(false);
  if (implementation_->controller && !implementation_->controllerIsComponent) implementation_->controller->terminate();
  if (implementation_->component) implementation_->component->terminate();
  implementation_->transport = nullptr;
  implementation_->controller = nullptr;
  implementation_->processor = nullptr;
  implementation_->component = nullptr;
  implementation_->module.reset();
  implementation_->controllerIsComponent = false;
  implementation_->editorUnsupported = false;
  implementation_->active = false;
  implementation_->processing = false;
}

bool Vst3Worker::ready() const {
  return implementation_->active && implementation_->processing && implementation_->component && implementation_->processor;
}

const std::vector<WorkerNotification>& Vst3Worker::notifications() const {
  return implementation_->notifications;
}

}  // namespace daw::plugin_host
