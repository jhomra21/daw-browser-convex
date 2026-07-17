import { describe, expect, test } from "bun:test"
import {
  APP_PREFERENCES_VERSION,
  defaultAppPreferences,
  normalizeAppPreferences,
  normalizeRecordingCalibration,
  normalizeRecordingCalibrations,
  normalizeRecordingInputPreferences,
  normalizeRecordingManualOffsetFrames,
  parseAppTheme,
  timelineDefaultCreateColor,
  updateRecordingCalibrations,
  updateRecordingInputPreferences
} from "./app-preferences-core"
import { themeColorInputValue } from "./theme-color-input"
import type { RecordingInputPreferences } from "~/lib/recording/recording-preferences"
import { DEFAULT_DAW_THEME_ID } from "~/lib/theme/theme-registry"
import { resolveDawThemeById } from "~/lib/theme/theme-resolver"

describe("normalizeAppPreferences", () => {
  test("falls back to defaults for malformed data", () => {
    expect(normalizeAppPreferences(null)).toEqual(defaultAppPreferences)
    expect(normalizeAppPreferences({ appearance: { theme: "blue" }, sidebar: { open: "yes" } })).toEqual({
      ...defaultAppPreferences,
      appearance: { theme: "system", themeId: "default" },
      sidebar: { open: true },
      timeline: defaultAppPreferences.timeline
    })
    expect(normalizeAppPreferences({ version: 99, appearance: { theme: "dark" } })).toEqual(defaultAppPreferences)
  })

  test("preserves valid preference fields", () => {
    expect(
      normalizeAppPreferences({
        version: 1,
        appearance: { theme: "dark", themeId: "catppuccin" },
        sidebar: { open: false },
        timeline: { defaultTrackColor: "#123456", defaultGroupColor: "#abcdef" }
      })
    ).toEqual({
      version: 3,
      appearance: { theme: "dark", themeId: "catppuccin" },
      sidebar: { open: false },
      timeline: { defaultTrackColor: "#123456", defaultGroupColor: "#abcdef" },
      audio: defaultAppPreferences.audio,
      recording: defaultAppPreferences.recording
    })
  })

  test("normalizes missing and unknown theme ids without dropping valid fields", () => {
    expect(
      normalizeAppPreferences({
        version: 1,
        appearance: { theme: "light" },
        sidebar: { open: false }
      })
    ).toEqual({
      version: 3,
      appearance: { theme: "light", themeId: "default" },
      sidebar: { open: false },
      timeline: defaultAppPreferences.timeline,
      audio: defaultAppPreferences.audio,
      recording: defaultAppPreferences.recording
    })

    expect(
      normalizeAppPreferences({
        version: 1,
        appearance: { theme: "dark", themeId: "unknown" },
        sidebar: { open: false },
        timeline: { defaultTrackColor: "red", defaultGroupColor: "#fedcba" }
      })
    ).toEqual({
      version: 3,
      appearance: { theme: "dark", themeId: "default" },
      sidebar: { open: false },
      timeline: { defaultTrackColor: defaultAppPreferences.timeline.defaultTrackColor, defaultGroupColor: "#fedcba" },
      audio: defaultAppPreferences.audio,
      recording: defaultAppPreferences.recording
    })
  })

  test("normalizes malformed version 2 audio fields independently", () => {
    expect(normalizeAppPreferences({
      ...defaultAppPreferences,
      audio: {
        inputDeviceId: 4,
        outputDeviceId: "speaker",
        sampleRate: 12345,
        latencyMode: "fast",
        echoCancellation: false,
        noiseSuppression: "yes",
        autoGainControl: true
      }
    }).audio).toEqual({
      inputDeviceId: "",
      outputDeviceId: "speaker",
      sampleRate: "default",
      latencyMode: "interactive",
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: true
    })
  })

  test("preserves version 2 audio preferences while defaulting recording preferences", () => {
    expect(normalizeAppPreferences({
      version: 2,
      audio: {
        inputDeviceId: "mic",
        outputDeviceId: "speakers",
        sampleRate: 48000,
        latencyMode: "balanced",
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })).toEqual({
      ...defaultAppPreferences,
      audio: {
        inputDeviceId: "mic",
        outputDeviceId: "speakers",
        sampleRate: 48000,
        latencyMode: "balanced",
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
  })

  test("normalizes recording bounds and keeps the newest 32 stable calibrations", () => {
    const calibrations = Array.from({ length: 35 }, (_, index) => ({
      inputDeviceId: `input-${index}`,
      outputDeviceId: `output-${index}`,
      sampleRate: 48000,
      measuredRoundTripFrames: 512,
      recordingOffsetFrames: -128,
      confidence: 0.9,
      platformIdentity: "browser-platform",
      createdAtMs: index
    }))
    const recording = normalizeAppPreferences({
      version: APP_PREFERENCES_VERSION,
      recording: {
        layout: "stereo",
        inputChannel: 99,
        monitor: "auto",
        gainDb: -100,
        invertPolarity: true,
        manualOffsetFrames: 3_000_000,
        calibrations
      }
    }).recording

    expect(recording.inputChannel).toBe(31)
    expect(recording.gainDb).toBe(-60)
    expect(recording.manualOffsetFrames).toBe(1_920_000)
    expect(recording.calibrations).toHaveLength(32)
    expect(recording.calibrations[0]?.createdAtMs).toBe(34)
    expect(recording.calibrations[31]?.createdAtMs).toBe(3)
  })

  test("normalizes recording runtime updates before persistence", () => {
    const input: RecordingInputPreferences = {
      layout: "stereo",
      inputChannel: Number.POSITIVE_INFINITY,
      monitor: "auto",
      gainDb: Number.NaN,
      invertPolarity: true
    }
    expect(normalizeRecordingInputPreferences(input)).toEqual({
      ...input,
      inputChannel: 0,
      gainDb: 0
    })
    const inputUpdated = updateRecordingInputPreferences(defaultAppPreferences.recording, input)
    expect(inputUpdated).toEqual({
      ...defaultAppPreferences.recording,
      layout: "stereo",
      monitor: "auto",
      invertPolarity: true
    })
    expect(normalizeRecordingManualOffsetFrames(Number.NEGATIVE_INFINITY)).toBe(0)
    expect(normalizeRecordingManualOffsetFrames(3_000_000)).toBe(1_920_000)

    const calibrations = Array.from({ length: 35 }, (_, index) => ({
      inputDeviceId: `input-${index}`,
      outputDeviceId: `output-${index}`,
      sampleRate: 48000,
      measuredRoundTripFrames: 512,
      recordingOffsetFrames: 0,
      confidence: 1,
      platformIdentity: "browser-platform",
      createdAtMs: index
    }))
    expect(normalizeRecordingCalibrations(calibrations)).toHaveLength(32)
    const calibrationUpdated = updateRecordingCalibrations(defaultAppPreferences.recording, calibrations)
    expect(calibrationUpdated.calibrations).toHaveLength(32)
    expect(calibrationUpdated.calibrations[0]?.createdAtMs).toBe(34)
    expect(normalizeRecordingCalibration({ ...calibrations[0], confidence: 2 })).toBeNull()
  })

  test("keeps audio inputDeviceId as the only persisted recording device selection", () => {
    const normalized = normalizeAppPreferences({
      version: APP_PREFERENCES_VERSION,
      audio: { inputDeviceId: "canonical-input" },
      recording: { deviceId: "legacy-duplicate" }
    })
    expect(normalized.audio.inputDeviceId).toBe("canonical-input")
    expect("deviceId" in normalized.recording).toBeFalse()
  })

  test("discards invalid and unstable recording calibrations", () => {
    expect(normalizeAppPreferences({
      version: APP_PREFERENCES_VERSION,
      recording: {
        calibrations: [
          {
            inputDeviceId: "default",
            outputDeviceId: "speaker",
            sampleRate: 48000,
            measuredRoundTripFrames: 512,
            recordingOffsetFrames: 0,
            confidence: 1,
            platformIdentity: "browser-platform",
            createdAtMs: 1
          },
          {
            inputDeviceId: "mic",
            outputDeviceId: "speaker",
            sampleRate: "48000",
            measuredRoundTripFrames: 512,
            recordingOffsetFrames: 0,
            confidence: 1,
            platformIdentity: "browser-platform",
            createdAtMs: 2
          }
        ]
      }
    }).recording.calibrations).toEqual([])
  })

  test("normalizes branch-introduced row color defaults back to timeline surface", () => {
    expect(
      normalizeAppPreferences({
        version: APP_PREFERENCES_VERSION,
        timeline: { defaultTrackColor: "#64748b", defaultGroupColor: "#475569" }
      }).timeline
    ).toEqual(defaultAppPreferences.timeline)
    expect(
      normalizeAppPreferences({
        version: APP_PREFERENCES_VERSION,
        timeline: { defaultTrackColor: "#181824", defaultGroupColor: "#181824" }
      }).timeline
    ).toEqual(defaultAppPreferences.timeline)
  })
})

describe("theme helpers", () => {
  test("parses stored themes with fallback", () => {
    expect(parseAppTheme("system")).toBe("system")
    expect(parseAppTheme("light")).toBe("light")
    expect(parseAppTheme("dark")).toBe("dark")
    expect(parseAppTheme("blue")).toBe("system")
  })

  test("maps default timeline surface tokens to color input values", () => {
    expect(themeColorInputValue("timeline-surface", resolveDawThemeById(DEFAULT_DAW_THEME_ID, "light"), DEFAULT_DAW_THEME_ID, "light")).toBe("#e2e8f0")
    expect(themeColorInputValue("timeline-surface", resolveDawThemeById(DEFAULT_DAW_THEME_ID, "dark"), DEFAULT_DAW_THEME_ID, "dark")).toBe("#181824")
  })

  test("keeps token-backed row defaults out of persisted track colors", () => {
    expect(timelineDefaultCreateColor("timeline-surface")).toBeUndefined()
    expect(timelineDefaultCreateColor("#123456")).toBe("#123456")
  })

  test("preserves custom hex colors and hex theme token values for color inputs", () => {
    expect(themeColorInputValue("#123456", resolveDawThemeById(DEFAULT_DAW_THEME_ID, "light"), DEFAULT_DAW_THEME_ID, "light")).toBe("#123456")
    expect(themeColorInputValue("#123", resolveDawThemeById(DEFAULT_DAW_THEME_ID, "light"), DEFAULT_DAW_THEME_ID, "light")).toBe("#112233")
    expect(themeColorInputValue("timeline-surface", resolveDawThemeById("catppuccin", "light"), "catppuccin", "light")).toBe("#e2e8f0")
    expect(themeColorInputValue("red", resolveDawThemeById(DEFAULT_DAW_THEME_ID, "light"), DEFAULT_DAW_THEME_ID, "light")).toBe("#181824")
  })
})
