import { AudioEngine, type AudioRuntimeOptions } from "@daw-browser/audio-engine/audio-engine"

let audioEngineSingleton: AudioEngine | null = null
let desiredConfiguration: AudioRuntimeOptions = { latencyHint: "interactive" }
let desiredOutputDeviceId = ""
let sinkRequestId = 0
let sinkStatus: AudioSinkStatus = { state: "idle" }
let activeSinkRequest: {
  engine: AudioEngine
  deviceId: string
  promise: Promise<boolean>
} | null = null
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
    let runtimeInitialized = false
    audioEngineSingleton.subscribeRuntimeSnapshot(() => {
      const initialized = audioEngineSingleton?.getRuntimeSnapshot().state !== "uninitialized"
      if (initialized && !runtimeInitialized && desiredOutputDeviceId) {
        void applyAudioOutputDevice(desiredOutputDeviceId)
      }
      runtimeInitialized = initialized
    })
    if (desiredOutputDeviceId) void applyAudioOutputDevice(desiredOutputDeviceId)
  }
  return audioEngineSingleton
}

export const configureAudioEngine = (configuration: AudioRuntimeOptions) => {
  desiredConfiguration = configuration
  audioEngineSingleton?.configureNextRuntime(configuration)
}

export const configureDesiredAudioOutputDevice = (deviceId: string) => {
  desiredOutputDeviceId = deviceId
  if (audioEngineSingleton) void applyAudioOutputDevice(deviceId)
}

const applyAudioOutputDevice = async (deviceId: string) => {
  desiredOutputDeviceId = deviceId
  const engine = getAudioEngine()
  if (activeSinkRequest?.engine === engine && activeSinkRequest.deviceId === deviceId) {
    return activeSinkRequest.promise
  }
  const requestId = ++sinkRequestId
  publishSinkStatus({ state: "pending", deviceId })
  const promise = (async () => {
    try {
      const result = await engine.setOutputDevice(deviceId)
      if (requestId !== sinkRequestId) return false
      if (result === "unsupported") publishSinkStatus({ state: "unsupported" })
      else if (result === "uninitialized") publishSinkStatus({ state: "uninitialized", deviceId })
      else publishSinkStatus({ state: "applied", deviceId })
      return result === "applied"
    } catch (error) {
      if (requestId !== sinkRequestId) return false
      publishSinkStatus({
        state: "error",
        deviceId,
        message: error instanceof Error ? error.message : "Unable to select audio output."
      })
      return false
    }
  })()
  activeSinkRequest = { engine, deviceId, promise }
  void promise.finally(() => {
    if (activeSinkRequest?.promise === promise) activeSinkRequest = null
  })
  return promise
}

export const playAudioOutputTestTone = async () => {
  const engine = getAudioEngine()
  engine.ensureAudio()
  if (desiredOutputDeviceId && !await applyAudioOutputDevice(desiredOutputDeviceId)) {
    throw new Error("Unable to apply the selected audio output.")
  }
  await engine.playOutputTestTone()
}

export const getAudioSinkStatus = () => sinkStatus
export const subscribeAudioSinkStatus = (listener: () => void) => {
  sinkListeners.add(listener)
  return () => sinkListeners.delete(listener)
}

export const resetAudioEngine = () => {
  audioEngineSingleton = null
  activeSinkRequest = null
  sinkRequestId += 1
  publishSinkStatus({ state: "idle" })
}
