#include "daw/audio_host_macos.h"

#import <CoreAudio/CoreAudio.h>

#include <array>
#include <limits>
#include <memory>
#include <vector>

namespace daw::audio_host_macos {
namespace {

std::string StringProperty(AudioObjectID device, AudioObjectPropertySelector selector) {
  const AudioObjectPropertyAddress address{
    .mSelector = selector,
    .mScope = kAudioObjectPropertyScopeGlobal,
    .mElement = kAudioObjectPropertyElementMain,
  };
  CFStringRef value = nullptr;
  UInt32 size = sizeof(value);
  if (AudioObjectGetPropertyData(device, &address, 0, nullptr, &size, &value) != noErr || value == nullptr) return {};
  const CFIndex length = CFStringGetLength(value);
  const CFIndex capacity = CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
  std::vector<char> utf8(static_cast<std::size_t>(capacity));
  const bool converted = CFStringGetCString(value, utf8.data(), capacity, kCFStringEncodingUTF8);
  CFRelease(value);
  return converted ? std::string(utf8.data()) : std::string{};
}

std::uint32_t ChannelCount(AudioObjectID device, AudioObjectPropertyScope scope) {
  const AudioObjectPropertyAddress address{
    .mSelector = kAudioDevicePropertyStreamConfiguration,
    .mScope = scope,
    .mElement = kAudioObjectPropertyElementMain,
  };
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(device, &address, 0, nullptr, &size) != noErr || size < sizeof(AudioBufferList)) return 0;
  std::vector<std::uint8_t> storage(size);
  auto* buffers = reinterpret_cast<AudioBufferList*>(storage.data());
  if (AudioObjectGetPropertyData(device, &address, 0, nullptr, &size, buffers) != noErr) return 0;
  std::uint32_t channels = 0;
  for (UInt32 index = 0; index < buffers->mNumberBuffers; ++index) channels += buffers->mBuffers[index].mNumberChannels;
  return channels;
}

std::uint32_t UnsignedProperty(AudioObjectID device, AudioObjectPropertySelector selector) {
  const AudioObjectPropertyAddress address{
    .mSelector = selector,
    .mScope = kAudioObjectPropertyScopeGlobal,
    .mElement = kAudioObjectPropertyElementMain,
  };
  UInt32 value = 0;
  UInt32 size = sizeof(value);
  return AudioObjectGetPropertyData(device, &address, 0, nullptr, &size, &value) == noErr
    ? value
    : 0;
}

std::uint32_t NominalSampleRate(AudioObjectID device) {
  const AudioObjectPropertyAddress address{
    .mSelector = kAudioDevicePropertyNominalSampleRate,
    .mScope = kAudioObjectPropertyScopeGlobal,
    .mElement = kAudioObjectPropertyElementMain,
  };
  Float64 value = 0;
  UInt32 size = sizeof(value);
  if (AudioObjectGetPropertyData(device, &address, 0, nullptr, &size, &value) != noErr
    || value <= 0 || value > static_cast<Float64>(std::numeric_limits<std::uint32_t>::max())) return 0;
  return static_cast<std::uint32_t>(value);
}

bool DeviceIsAlive(AudioObjectID device) {
  return UnsignedProperty(device, kAudioDevicePropertyDeviceIsAlive) != 0;
}

AudioDeviceID DefaultOutputDevice() {
  const AudioObjectPropertyAddress address{
    .mSelector = kAudioHardwarePropertyDefaultOutputDevice,
    .mScope = kAudioObjectPropertyScopeGlobal,
    .mElement = kAudioObjectPropertyElementMain,
  };
  AudioDeviceID device = kAudioObjectUnknown;
  UInt32 size = sizeof(device);
  return AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, nullptr, &size, &device) == noErr
    ? device
    : kAudioObjectUnknown;
}

AudioDevice DescribeOutputDevice(AudioDeviceID id) {
  const std::uint32_t input_channels = ChannelCount(id, kAudioDevicePropertyScopeInput);
  const std::uint32_t output_channels = ChannelCount(id, kAudioDevicePropertyScopeOutput);
  return {
    .uid = StringProperty(id, kAudioDevicePropertyDeviceUID),
    .name = StringProperty(id, kAudioObjectPropertyName),
    .input_channels = input_channels,
    .output_channels = output_channels,
    .nominal_sample_rate_hz = NominalSampleRate(id),
    .maximum_frames_per_block = UnsignedProperty(id, kAudioDevicePropertyBufferFrameSize),
    .available = DeviceIsAlive(id),
  };
}

AudioDeviceID DeviceForUid(std::string_view uid) {
  const auto address = AudioObjectPropertyAddress{
    .mSelector = kAudioHardwarePropertyDevices,
    .mScope = kAudioObjectPropertyScopeGlobal,
    .mElement = kAudioObjectPropertyElementMain,
  };
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, nullptr, &size) != noErr) return kAudioObjectUnknown;
  std::vector<AudioDeviceID> ids(size / sizeof(AudioDeviceID));
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, nullptr, &size, ids.data()) != noErr) return kAudioObjectUnknown;
  for (const auto id : ids) {
    if (StringProperty(id, kAudioDevicePropertyDeviceUID) == uid) return id;
  }
  return kAudioObjectUnknown;
}

struct DeviceSession {
  AudioDeviceID device = kAudioObjectUnknown;
  AudioDeviceIOProcID io_proc = nullptr;
  AudioHost* host = nullptr;
  CoreAudioDeviceRole role = CoreAudioDeviceRole::kOutput;
  std::uint32_t max_frames = 0;
  std::uint32_t channel_count = 0;
  std::array<std::vector<float>, 64> input{};
  std::array<std::vector<float>, 64> output{};
  std::array<const float*, 64> input_planes{};
  std::array<float*, 64> output_planes{};
  bool watches_device_liveness = false;
};

OSStatus DeviceAliveChanged(
  AudioObjectID,
  UInt32,
  const AudioObjectPropertyAddress*,
  void* client_data) {
  auto* session = static_cast<DeviceSession*>(client_data);
  if (session != nullptr && !DeviceIsAlive(session->device)) {
    NotifyCoreAudioDeviceLost(*session->host, session->role);
  }
  return noErr;
}

std::uint32_t AudioBufferListChannels(const AudioBufferList* buffers) {
  std::uint32_t channels = 0;
  for (UInt32 index = 0; index < buffers->mNumberBuffers; ++index) channels += buffers->mBuffers[index].mNumberChannels;
  return channels;
}

float ReadPlanarSample(const AudioBufferList* buffers, std::uint32_t channel, std::uint32_t frame) {
  std::uint32_t offset = channel;
  for (UInt32 index = 0; index < buffers->mNumberBuffers; ++index) {
    const auto& buffer = buffers->mBuffers[index];
    if (offset >= buffer.mNumberChannels) {
      offset -= buffer.mNumberChannels;
      continue;
    }
    const auto* samples = static_cast<const float*>(buffer.mData);
    return samples == nullptr ? 0.0F : samples[frame * buffer.mNumberChannels + offset];
  }
  return 0.0F;
}

void WritePlanarSample(AudioBufferList* buffers, std::uint32_t channel, std::uint32_t frame, float value) {
  std::uint32_t offset = channel;
  for (UInt32 index = 0; index < buffers->mNumberBuffers; ++index) {
    auto& buffer = buffers->mBuffers[index];
    if (offset >= buffer.mNumberChannels) {
      offset -= buffer.mNumberChannels;
      continue;
    }
    auto* samples = static_cast<float*>(buffer.mData);
    if (samples != nullptr) samples[frame * buffer.mNumberChannels + offset] = value;
    return;
  }
}

// DAW_REALTIME_CALLBACK_REGION_BEGIN coreaudio-hal
OSStatus Process(
  AudioDeviceID,
  const AudioTimeStamp*,
  const AudioBufferList* input,
  const AudioTimeStamp*,
  AudioBufferList* output,
  const AudioTimeStamp*,
  void* client_data) {
  auto* session = static_cast<DeviceSession*>(client_data);
  if (session == nullptr || output == nullptr || output->mNumberBuffers == 0) return noErr;
  const auto& first_output = output->mBuffers[0];
  if (first_output.mNumberChannels == 0) return noErr;
  const std::uint32_t frames = first_output.mDataByteSize / (sizeof(float) * first_output.mNumberChannels);
  if (frames == 0 || frames > session->max_frames) return noErr;
  const std::uint32_t available_output_channels = AudioBufferListChannels(output);
  if (available_output_channels < session->channel_count) return noErr;
  for (std::uint32_t channel = 0; channel < session->channel_count; ++channel) {
    auto& input_plane = session->input[channel];
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
      input_plane[frame] = input == nullptr ? 0.0F : ReadPlanarSample(input, channel, frame);
    }
    session->input_planes[channel] = input_plane.data();
    session->output_planes[channel] = session->output[channel].data();
  }
  const bool processed = session->host->ProcessPlanar(
    {session->input_planes.data(), session->channel_count},
    {session->output_planes.data(), session->channel_count},
    frames);
  for (std::uint32_t channel = 0; channel < available_output_channels; ++channel) {
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
      WritePlanarSample(output, channel, frame, processed && channel < session->channel_count ? session->output[channel][frame] : 0.0F);
    }
  }
  return noErr;
}

OSStatus ProcessInput(
  AudioDeviceID,
  const AudioTimeStamp*,
  const AudioBufferList* input,
  const AudioTimeStamp*,
  AudioBufferList*,
  const AudioTimeStamp*,
  void* client_data) {
  auto* session = static_cast<DeviceSession*>(client_data);
  if (session == nullptr || input == nullptr || input->mNumberBuffers == 0) return noErr;
  const auto& first_input = input->mBuffers[0];
  if (first_input.mNumberChannels == 0) return noErr;
  const std::uint32_t frames = first_input.mDataByteSize / (sizeof(float) * first_input.mNumberChannels);
  if (frames == 0 || frames > session->max_frames) return noErr;
  const std::uint32_t available_input_channels = AudioBufferListChannels(input);
  if (available_input_channels < session->channel_count) return noErr;
  for (std::uint32_t channel = 0; channel < session->channel_count; ++channel) {
    auto& input_plane = session->input[channel];
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
      input_plane[frame] = ReadPlanarSample(input, channel, frame);
    }
    session->input_planes[channel] = input_plane.data();
  }
  static_cast<void>(session->host->ProcessRecordingPlanar(
    {session->input_planes.data(), session->channel_count},
    frames));
  return noErr;
}
// DAW_REALTIME_CALLBACK_REGION_END coreaudio-hal

}  // namespace

void NotifyCoreAudioDeviceLost(AudioHost& host, const CoreAudioDeviceRole role) {
  if (role == CoreAudioDeviceRole::kOutput) host.NotifyOutputDeviceLost();
  else host.NotifyRecordingDeviceLost();
}

std::vector<AudioDevice> EnumerateDevices() {
  const AudioObjectPropertyAddress address{
    .mSelector = kAudioHardwarePropertyDevices,
    .mScope = kAudioObjectPropertyScopeGlobal,
    .mElement = kAudioObjectPropertyElementMain,
  };
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, nullptr, &size) != noErr
    || size % sizeof(AudioDeviceID) != 0) return {};
  std::vector<AudioDeviceID> ids(size / sizeof(AudioDeviceID));
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, nullptr, &size, ids.data()) != noErr) return {};
  std::vector<AudioDevice> devices;
  devices.reserve(ids.size());
  for (const AudioDeviceID id : ids) {
    const std::string uid = StringProperty(id, kAudioDevicePropertyDeviceUID);
    if (uid.empty()) continue;
    devices.push_back(DescribeOutputDevice(id));
  }
  return devices;
}

std::optional<AudioDevice> SelectOutputDevice(const std::optional<std::string_view> preferred_uid) {
  const AudioDeviceID id = preferred_uid ? DeviceForUid(*preferred_uid) : DefaultOutputDevice();
  if (id == kAudioObjectUnknown) return std::nullopt;
  const AudioDevice device = DescribeOutputDevice(id);
  if (device.uid.empty() || device.output_channels == 0) return std::nullopt;
  return device;
}

std::optional<AudioDevice> SelectInputDevice(const std::optional<std::string_view> preferred_uid) {
  AudioDeviceID id = preferred_uid ? DeviceForUid(*preferred_uid) : kAudioObjectUnknown;
  if (id == kAudioObjectUnknown) {
    const AudioObjectPropertyAddress address{
      .mSelector = kAudioHardwarePropertyDefaultInputDevice,
      .mScope = kAudioObjectPropertyScopeGlobal,
      .mElement = kAudioObjectPropertyElementMain,
    };
    UInt32 size = sizeof(id);
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, nullptr, &size, &id) != noErr) {
      return std::nullopt;
    }
  }
  if (id == kAudioObjectUnknown) return std::nullopt;
  const AudioDevice device = DescribeOutputDevice(id);
  if (device.uid.empty() || device.input_channels == 0) return std::nullopt;
  return device;
}

bool StartCoreAudioDevice(
  std::string_view uid,
  std::uint32_t sample_rate_hz,
  std::uint32_t channel_count,
  AudioHost* host,
  void** session_out) {
  if (host == nullptr || session_out == nullptr || channel_count == 0 || channel_count > 64) return false;
  const AudioDeviceID device = DeviceForUid(uid);
  if (device == kAudioObjectUnknown) return false;
  const AudioObjectPropertyAddress rate_address{
    .mSelector = kAudioDevicePropertyNominalSampleRate,
    .mScope = kAudioObjectPropertyScopeGlobal,
    .mElement = kAudioObjectPropertyElementMain,
  };
  Float64 rate = sample_rate_hz;
  if (AudioObjectSetPropertyData(device, &rate_address, 0, nullptr, sizeof(rate), &rate) != noErr) return false;
  const AudioObjectPropertyAddress frame_address{
    .mSelector = kAudioDevicePropertyBufferFrameSize,
    .mScope = kAudioObjectPropertyScopeGlobal,
    .mElement = kAudioObjectPropertyElementMain,
  };
  UInt32 max_frames = 0;
  UInt32 size = sizeof(max_frames);
  if (AudioObjectGetPropertyData(device, &frame_address, 0, nullptr, &size, &max_frames) != noErr || max_frames == 0) return false;
  auto session = std::make_unique<DeviceSession>();
  session->device = device;
  session->host = host;
  session->role = CoreAudioDeviceRole::kOutput;
  session->max_frames = max_frames;
  session->channel_count = channel_count;
  for (std::uint32_t channel = 0; channel < channel_count; ++channel) {
    session->input[channel].assign(max_frames, 0.0F);
    session->output[channel].assign(max_frames, 0.0F);
  }
  if (AudioDeviceCreateIOProcID(device, Process, session.get(), &session->io_proc) != noErr) return false;
  const AudioObjectPropertyAddress alive_address{
    .mSelector = kAudioDevicePropertyDeviceIsAlive,
    .mScope = kAudioObjectPropertyScopeGlobal,
    .mElement = kAudioObjectPropertyElementMain,
  };
  if (AudioObjectAddPropertyListener(device, &alive_address, DeviceAliveChanged, session.get()) != noErr) {
    AudioDeviceDestroyIOProcID(device, session->io_proc);
    return false;
  }
  session->watches_device_liveness = true;
  if (AudioDeviceStart(device, session->io_proc) != noErr) {
    AudioObjectRemovePropertyListener(device, &alive_address, DeviceAliveChanged, session.get());
    AudioDeviceDestroyIOProcID(device, session->io_proc);
    return false;
  }
  *session_out = session.release();
  return true;
}

bool StartCoreAudioInputDevice(
  std::string_view uid,
  std::uint32_t sample_rate_hz,
  std::uint32_t channel_count,
  AudioHost* host,
  void** session_out) {
  if (host == nullptr || session_out == nullptr || channel_count == 0 || channel_count > 64) return false;
  const AudioDeviceID device = DeviceForUid(uid);
  if (device == kAudioObjectUnknown || ChannelCount(device, kAudioDevicePropertyScopeInput) < channel_count) return false;
  const AudioObjectPropertyAddress rate_address{
    .mSelector = kAudioDevicePropertyNominalSampleRate,
    .mScope = kAudioObjectPropertyScopeGlobal,
    .mElement = kAudioObjectPropertyElementMain,
  };
  Float64 rate = sample_rate_hz;
  if (AudioObjectSetPropertyData(device, &rate_address, 0, nullptr, sizeof(rate), &rate) != noErr) return false;
  const AudioObjectPropertyAddress frame_address{
    .mSelector = kAudioDevicePropertyBufferFrameSize,
    .mScope = kAudioObjectPropertyScopeGlobal,
    .mElement = kAudioObjectPropertyElementMain,
  };
  UInt32 max_frames = 0;
  UInt32 size = sizeof(max_frames);
  if (AudioObjectGetPropertyData(device, &frame_address, 0, nullptr, &size, &max_frames) != noErr || max_frames == 0) return false;
  auto session = std::make_unique<DeviceSession>();
  session->device = device;
  session->host = host;
  session->role = CoreAudioDeviceRole::kRecordingInput;
  session->max_frames = max_frames;
  session->channel_count = channel_count;
  for (std::uint32_t channel = 0; channel < channel_count; ++channel) {
    session->input[channel].assign(max_frames, 0.0F);
  }
  if (AudioDeviceCreateIOProcID(device, ProcessInput, session.get(), &session->io_proc) != noErr) return false;
  const AudioObjectPropertyAddress alive_address{
    .mSelector = kAudioDevicePropertyDeviceIsAlive,
    .mScope = kAudioObjectPropertyScopeGlobal,
    .mElement = kAudioObjectPropertyElementMain,
  };
  if (AudioObjectAddPropertyListener(device, &alive_address, DeviceAliveChanged, session.get()) != noErr) {
    AudioDeviceDestroyIOProcID(device, session->io_proc);
    return false;
  }
  session->watches_device_liveness = true;
  if (AudioDeviceStart(device, session->io_proc) != noErr) {
    AudioObjectRemovePropertyListener(device, &alive_address, DeviceAliveChanged, session.get());
    AudioDeviceDestroyIOProcID(device, session->io_proc);
    return false;
  }
  *session_out = session.release();
  return true;
}

void StopCoreAudioDevice(void* opaque_session) {
  auto* session = static_cast<DeviceSession*>(opaque_session);
  if (session == nullptr) return;
  AudioDeviceStop(session->device, session->io_proc);
  if (session->watches_device_liveness) {
    const AudioObjectPropertyAddress alive_address{
      .mSelector = kAudioDevicePropertyDeviceIsAlive,
      .mScope = kAudioObjectPropertyScopeGlobal,
      .mElement = kAudioObjectPropertyElementMain,
    };
    AudioObjectRemovePropertyListener(session->device, &alive_address, DeviceAliveChanged, session);
  }
  AudioDeviceDestroyIOProcID(session->device, session->io_proc);
  delete session;
}

}  // namespace daw::audio_host_macos
