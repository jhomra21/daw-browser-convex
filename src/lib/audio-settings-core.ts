import type { AudioPreferences } from "./preferences/app-preferences-core"
import type { AudioRuntimeOptions } from "@daw-browser/audio-engine/audio-engine"

export const resolveAudioRuntimeConfiguration = (
  preferences: Pick<AudioPreferences, "sampleRate" | "latencyMode">
): AudioRuntimeOptions => ({
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

const browserDeviceAliases = new Set(["default", "communications"])

export const areAudioDeviceListsEqual = (
  previous: readonly MediaDeviceInfo[],
  next: readonly MediaDeviceInfo[]
): boolean => previous.length === next.length && previous.every((device, index) => {
  const candidate = next[index]
  return candidate?.kind === device.kind
    && candidate.deviceId === device.deviceId
    && candidate.groupId === device.groupId
    && candidate.label === device.label
})

export const filterAudioDevices = (devices: readonly MediaDeviceInfo[]): AudioDeviceLists => {
  const seen = new Set<string>()
  const unique = devices.filter((device) => {
    if (browserDeviceAliases.has(device.deviceId)) return false
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
