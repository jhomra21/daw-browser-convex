import { describe, expect, test } from "bun:test"
import { buildRecordingConstraints, filterAudioDevices, isSelectedDeviceAvailable, resolveAudioRuntimeConfiguration } from "./audio-settings-core"
import { defaultAppPreferences } from "./preferences/app-preferences-core"

describe("audio settings policy", () => {
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

  test("deduplicates devices and preserves missing selections", () => {
    const input: MediaDeviceInfo = { deviceId: "mic", groupId: "g", kind: "audioinput", label: "Mic", toJSON: () => ({}) }
    const output: MediaDeviceInfo = { deviceId: "speaker", groupId: "g", kind: "audiooutput", label: "Speaker", toJSON: () => ({}) }
    const result = filterAudioDevices([input, input, output])
    expect(result.inputs).toHaveLength(1)
    expect(result.outputs).toHaveLength(1)
    expect(isSelectedDeviceAvailable("missing", result.inputs)).toBe(false)
    expect(isSelectedDeviceAvailable("", result.inputs)).toBe(true)
  })
})
