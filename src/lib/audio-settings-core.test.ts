import { describe, expect, test } from "bun:test"
import { areAudioDeviceListsEqual, buildActiveInputProbeConstraints, buildRecordingConstraints, canUseStereoRecording, filterAudioDevices, isSelectedDeviceAvailable, resolveAudioRuntimeConfiguration, resolveRecordingChannelOptions } from "./audio-settings-core"
import { defaultAppPreferences } from "./preferences/app-preferences-core"

describe("audio settings policy", () => {
  test("disables unavailable recording channels without rewriting preferences", () => {
    const options = resolveRecordingChannelOptions(2)
    expect(options[0]).toEqual({ channel: 0, label: "Input 1", disabled: false })
    expect(options[2]?.disabled).toBe(true)
    expect(canUseStereoRecording(2, 0)).toBe(true)
    expect(canUseStereoRecording(2, 1)).toBe(false)
    expect(canUseStereoRecording(undefined, 31)).toBe(true)
  })

  test("resolves constructor options", () => {
    expect(resolveAudioRuntimeConfiguration({ sampleRate: "default", latencyMode: "interactive" })).toEqual({ latencyHint: "interactive" })
    expect(resolveAudioRuntimeConfiguration({ sampleRate: 48000, latencyMode: "balanced" })).toEqual({ sampleRate: 48000, latencyHint: "balanced" })
  })

  test("builds supported recording constraints", () => {
    expect(buildRecordingConstraints(
      { ...defaultAppPreferences.audio, inputDeviceId: "mic", echoCancellation: true },
      { echoCancellation: true, noiseSuppression: true }
    )).toEqual({
      deviceId: { exact: "mic" },
      echoCancellation: true,
      noiseSuppression: false
    })
  })

  test("probes the explicit input device or the system default", () => {
    expect(buildActiveInputProbeConstraints("mic")).toEqual({
      audio: { deviceId: { exact: "mic" } },
    })
    expect(buildActiveInputProbeConstraints("")).toEqual({ audio: true })
  })

  test("deduplicates devices and preserves missing selections", () => {
    const input: MediaDeviceInfo = { deviceId: "mic", groupId: "g", kind: "audioinput", label: "Mic", toJSON: () => ({}) }
    const output: MediaDeviceInfo = { deviceId: "speaker", groupId: "g", kind: "audiooutput", label: "Speaker", toJSON: () => ({}) }
    const defaultInput: MediaDeviceInfo = { ...input, deviceId: "default", label: "Default - Mic" }
    const communicationsInput: MediaDeviceInfo = { ...input, deviceId: "communications", label: "Communications - Mic" }
    const result = filterAudioDevices([defaultInput, communicationsInput, input, input, output])
    expect(result.inputs).toHaveLength(1)
    expect(result.inputs[0]?.deviceId).toBe("mic")
    expect(result.outputs).toHaveLength(1)
    expect(isSelectedDeviceAvailable("missing", result.inputs)).toBe(false)
    expect(isSelectedDeviceAvailable("", result.inputs)).toBe(true)
  })

  test("compares device lists by observable identity", () => {
    const device = (label: string): MediaDeviceInfo => ({
      deviceId: "mic",
      groupId: "group",
      kind: "audioinput",
      label,
      toJSON: () => ({})
    })
    expect(areAudioDeviceListsEqual([device("Microphone")], [device("Microphone")])).toBe(true)
    expect(areAudioDeviceListsEqual([device("")], [device("Microphone")])).toBe(false)
  })
})
