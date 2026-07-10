import type { AudioPreferences } from "./preferences/app-preferences-core"

export type AudioRuntimeConfiguration = {
  sampleRate?: number
  latencyHint: AudioContextLatencyCategory
}

export const resolveAudioRuntimeConfiguration = (
  preferences: Pick<AudioPreferences, "sampleRate" | "latencyMode">
): AudioRuntimeConfiguration => ({
  ...(preferences.sampleRate === "default" ? {} : { sampleRate: preferences.sampleRate }),
  latencyHint: preferences.latencyMode
})

export const buildRecordingConstraints = (
  preferences: AudioPreferences,
  supported: MediaTrackSupportedConstraints
): MediaTrackConstraints => ({
  ...(preferences.inputDeviceId ? { deviceId: { exact: preferences.inputDeviceId } } : {}),
  ...(supported.echoCancellation ? { echoCancellation: preferences.echoCancellation } : {}),
  ...(supported.noiseSuppression ? { noiseSuppression: preferences.noiseSuppression } : {}),
  ...(supported.autoGainControl ? { autoGainControl: preferences.autoGainControl } : {})
})

type AudioDeviceLists = {
  inputs: MediaDeviceInfo[]
  outputs: MediaDeviceInfo[]
}

export const filterAudioDevices = (devices: readonly MediaDeviceInfo[]): AudioDeviceLists => {
  const seen = new Set<string>()
  const unique = devices.filter((device) => {
    const key = `${device.kind}:${device.deviceId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return {
    inputs: unique.filter((device) => device.kind === "audioinput"),
    outputs: unique.filter((device) => device.kind === "audiooutput")
  }
}

export const isSelectedDeviceAvailable = (
  deviceId: string,
  devices: readonly MediaDeviceInfo[]
): boolean => !deviceId || devices.some((device) => device.deviceId === deviceId)
