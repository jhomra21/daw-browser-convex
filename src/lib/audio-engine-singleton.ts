import { AudioEngine } from "@daw-browser/audio-engine/audio-engine"
import type { AudioRuntimeConfiguration } from "./audio-settings-core"

let audioEngineSingleton: AudioEngine | null = null
let desiredConfiguration: AudioRuntimeConfiguration = { latencyHint: "interactive" }
let desiredOutputDeviceId = ""
let sinkRequestId = 0
let sinkStatus: AudioSinkStatus = { state: "idle" }
const sinkListeners = new Set<() => void>()

type AudioSinkStatus =
  | { state: "idle" }
  | { state: "pending"; deviceId: string }
  | { state: "applied"; deviceId: string }
  | { state: "unsupported" }
  | { state: "uninitialized"; deviceId: string }
  | { state: "error"; deviceId: string; message: string }

const publishSinkStatus = (status: AudioSinkStatus) => {
  sinkStatus = status
  for (const listener of sinkListeners) listener()
}

export const getAudioEngine = () => {
  if (!audioEngineSingleton) {
    audioEngineSingleton = new AudioEngine(desiredConfiguration)
    if (desiredOutputDeviceId) void applyAudioOutputDevice(desiredOutputDeviceId)
  }
  return audioEngineSingleton
}

export const configureAudioEngine = (configuration: AudioRuntimeConfiguration) => {
  desiredConfiguration = configuration
  audioEngineSingleton?.configureNextRuntime(configuration)
}

export const configureDesiredAudioOutputDevice = (deviceId: string) => {
  desiredOutputDeviceId = deviceId
  if (audioEngineSingleton) void applyAudioOutputDevice(deviceId)
}

const applyAudioOutputDevice = async (deviceId: string) => {
  desiredOutputDeviceId = deviceId
  const requestId = ++sinkRequestId
  publishSinkStatus({ state: "pending", deviceId })
  try {
    const result = await getAudioEngine().setOutputDevice(deviceId)
    if (requestId !== sinkRequestId) return
    if (result === "unsupported") publishSinkStatus({ state: "unsupported" })
    else if (result === "uninitialized") publishSinkStatus({ state: "uninitialized", deviceId })
    else publishSinkStatus({ state: "applied", deviceId })
  } catch (error) {
    if (requestId !== sinkRequestId) return
    publishSinkStatus({
      state: "error",
      deviceId,
      message: error instanceof Error ? error.message : "Unable to select audio output."
    })
  }
}

export const getAudioSinkStatus = () => sinkStatus
export const subscribeAudioSinkStatus = (listener: () => void) => {
  sinkListeners.add(listener)
  return () => sinkListeners.delete(listener)
}

export const resetAudioEngine = () => {
  audioEngineSingleton = null
}
