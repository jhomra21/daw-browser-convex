// DAW AE08 Test Effect: a stereo VST3 effect whose only purpose is to make the host's
// dynamic-staging failure modes reproducible. It is never packaged or cataloged.
#include "ae08-test-editor.h"
#include "public.sdk/source/common/pluginview.h"
#include "public.sdk/source/main/pluginfactory.h"
#include "pluginterfaces/gui/iplugview.h"
#include "public.sdk/source/vst/vstsinglecomponenteffect.h"
#include "pluginterfaces/base/ibstream.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstparameterchanges.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "pluginterfaces/vst/vstspeaker.h"

#include <array>
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <thread>
#include <vector>

using namespace Steinberg;
using namespace Steinberg::Vst;

namespace {

enum ParameterId : ParamID {
  kLatency = 1,
  kFault = 2,
  kStartupDelay = 3,
  kRequestRestart = 4,
  kParameterOnlyRestart = 5,
};

enum FaultMode : int { kFaultOff = 0, kFaultCrash = 1, kFaultHang = 2, kFaultErrorOnSetActive = 3 };

constexpr std::array<int, 4> kLatencyFrames{0, 64, 512, 4096};
constexpr std::array<int, 4> kStartupDelaySeconds{0, 2, 10, 60};
constexpr int kStateVersion = 1;

int StepOf(const ParamValue normalized) {
  return normalized < 0.0 ? 0 : normalized > 1.0 ? 3 : static_cast<int>(normalized * 3.0 + 0.5);
}

class Ae08TestEditor final : public CPluginView {
 public:
  Ae08TestEditor() : CPluginView(&kBounds) {}
  tresult PLUGIN_API isPlatformTypeSupported(FIDString type) override {
    return FIDStringsEqual(type, kPlatformTypeNSView) ? kResultTrue : kResultFalse;
  }
  void attachedToParent() override { child_ = Ae08AttachPlainView(systemWindow, kBounds.getWidth(), kBounds.getHeight()); }
  void removedFromParent() override {
    if (child_) Ae08RemovePlainView(child_);
    child_ = nullptr;
  }

 private:
  static inline const ViewRect kBounds{0, 0, 240, 120};
  void* child_ = nullptr;
};

class Ae08TestEffect final : public SingleComponentEffect {
 public:
  IPlugView* PLUGIN_API createView(FIDString name) override {
    return FIDStringsEqual(name, ViewType::kEditor) ? new Ae08TestEditor : nullptr;
  }

  static FUnknown* createInstance(void*) { return static_cast<IAudioProcessor*>(new Ae08TestEffect); }

  tresult PLUGIN_API initialize(FUnknown* context) override {
    const auto result = SingleComponentEffect::initialize(context);
    if (result != kResultOk) return result;
    addAudioInput(STR16("In"), SpeakerArr::kStereo);
    addAudioOutput(STR16("Out"), SpeakerArr::kStereo);
    parameters.addParameter(STR16("Latency"), nullptr, 3, 0, ParameterInfo::kCanAutomate, kLatency);
    parameters.addParameter(STR16("Fault"), nullptr, 3, 0, ParameterInfo::kCanAutomate, kFault);
    parameters.addParameter(STR16("Startup delay"), nullptr, 3, 0, 0, kStartupDelay);
    parameters.addParameter(STR16("Request restart"), nullptr, 1, 0, ParameterInfo::kCanAutomate, kRequestRestart);
    parameters.addParameter(STR16("Parameter restart"), nullptr, 1, 0, ParameterInfo::kCanAutomate, kParameterOnlyRestart);
    return kResultOk;
  }

  tresult PLUGIN_API setActive(TBool state) override {
    if (state && fault_.load() == kFaultErrorOnSetActive) return kResultFalse;
    if (state) {
      delay_.assign(2 * (kLatencyFrames.back() + 1), 0.0F);
      write_ = 0;
    }
    return SingleComponentEffect::setActive(state);
  }

  uint32 PLUGIN_API getLatencySamples() override { return static_cast<uint32>(kLatencyFrames[latency_.load()]); }

  tresult PLUGIN_API canProcessSampleSize(int32 symbolicSampleSize) override {
    return symbolicSampleSize == kSample32 ? kResultTrue : kResultFalse;
  }

  tresult PLUGIN_API setState(IBStream* stream) override {
    int values[5]{};
    int32 read = 0;
    if (!stream || stream->read(values, sizeof(values), &read) != kResultOk || read != sizeof(values)
      || values[0] != kStateVersion) return kResultFalse;
    latency_ = values[1];
    fault_ = values[2];
    startupDelay_ = values[3];
    if (kStartupDelaySeconds[startupDelay_.load()] > 0) {
      std::this_thread::sleep_for(std::chrono::seconds(kStartupDelaySeconds[startupDelay_.load()]));
    }
    return kResultOk;
  }

  // The controller half is this same object, so the component state it is offered is already applied.
  tresult PLUGIN_API setComponentState(IBStream*) override { return kResultOk; }

  tresult PLUGIN_API getState(IBStream* stream) override {
    const int values[5]{kStateVersion, latency_.load(), fault_.load(), startupDelay_.load(), 0};
    int32 written = 0;
    return stream && stream->write(const_cast<int*>(values), sizeof(values), &written) == kResultOk
        && written == sizeof(values) ? kResultOk : kResultFalse;
  }

  tresult PLUGIN_API setParamNormalized(ParamID id, ParamValue value) override {
    Apply(id, value);
    return SingleComponentEffect::setParamNormalized(id, value);
  }

  tresult PLUGIN_API process(ProcessData& data) override {
    if (data.inputParameterChanges) {
      for (int32 index = 0; index < data.inputParameterChanges->getParameterCount(); ++index) {
        auto* queue = data.inputParameterChanges->getParameterData(index);
        ParamValue value = 0;
        int32 offset = 0;
        if (queue && queue->getPointCount() > 0
          && queue->getPoint(queue->getPointCount() - 1, offset, value) == kResultTrue) {
          Apply(queue->getParameterId(), value);
        }
      }
    }
    if (fault_.load() == kFaultCrash) std::abort();
    if (fault_.load() == kFaultHang) {
      for (volatile bool spin = true; spin;) {}
    }
    if (data.numSamples <= 0 || data.numInputs == 0 || data.numOutputs == 0) return kResultOk;
    const auto latency = static_cast<std::size_t>(kLatencyFrames[latency_.load()]);
    const auto ring = static_cast<std::size_t>(kLatencyFrames.back() + 1);
    const auto channels = static_cast<std::size_t>(
      std::min(data.inputs[0].numChannels, data.outputs[0].numChannels));
    for (std::size_t channel = 0; channel < channels && channel < 2; ++channel) {
      auto* history = delay_.data() + channel * ring;
      for (std::size_t frame = 0; frame < static_cast<std::size_t>(data.numSamples); ++frame) {
        const auto position = (write_ + frame) % ring;
        history[position] = data.inputs[0].channelBuffers32[channel][frame];
        data.outputs[0].channelBuffers32[channel][frame] = history[(position + ring - latency) % ring];
      }
    }
    write_ = (write_ + static_cast<std::size_t>(data.numSamples)) % ring;
    return kResultOk;
  }

 private:
  void Apply(const ParamID id, const ParamValue value) {
    switch (id) {
      case kLatency: {
        const auto step = StepOf(value);
        if (latency_.exchange(step) != step) componentHandler->restartComponent(kLatencyChanged);
        break;
      }
      case kFault: fault_ = StepOf(value); break;
      case kStartupDelay: startupDelay_ = StepOf(value); break;
      case kRequestRestart:
        if (value > 0.5 && componentHandler) componentHandler->restartComponent(kReloadComponent);
        break;
      case kParameterOnlyRestart:
        if (value > 0.5 && componentHandler) componentHandler->restartComponent(kParamValuesChanged);
        break;
      default: break;
    }
  }

  std::atomic<int> latency_{0};
  std::atomic<int> fault_{kFaultOff};
  std::atomic<int> startupDelay_{0};
  std::vector<float> delay_;
  std::size_t write_ = 0;
};

}  // namespace

BEGIN_FACTORY_DEF("DAW tests", "https://example.invalid", "mailto:tests@example.invalid")
  DEF_CLASS2(INLINE_UID(0xAE08C0DE, 0x7E57EFFE, 0xC7000000, 0x00000001), PClassInfo::kManyInstances,
    kVstAudioEffectClass, "DAW AE08 Test Effect", 0, "Fx", "1.0.0", kVstVersionString,
    Ae08TestEffect::createInstance)
END_FACTORY
