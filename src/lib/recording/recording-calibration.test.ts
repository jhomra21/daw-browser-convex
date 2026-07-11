import { describe, expect, test } from "bun:test"
import { findExactCalibration, replaceExactCalibration, resolveCalibrationPlatformIdentity, resolveRecordingOffsetFrames } from "./recording-calibration"
import type { RecordingCalibration } from "./recording-preferences"

const identity = {
  inputDeviceId: "input-1",
  outputDeviceId: "output-1",
  sampleRate: 48_000,
  platform: "macOS",
  userAgentData: {
    platform: "macOS",
    brands: [{ brand: "Chromium", version: "140.0.0.0" }],
  },
}
const calibration: RecordingCalibration = {
  inputDeviceId: "input-1",
  outputDeviceId: "output-1",
  sampleRate: 48_000,
  measuredRoundTripFrames: 500,
  recordingOffsetFrames: -500,
  confidence: 0.9,
  platformIdentity: "Chromium:140:macOS",
  createdAtMs: 1,
}

describe("recording calibration identity", () => {
  test("requires an exact stable configuration and otherwise uses manual offset", () => {
    expect(findExactCalibration([calibration], identity)).toEqual(calibration)
    expect(findExactCalibration([calibration], { ...identity, sampleRate: 44_100 })).toBeNull()
    expect(findExactCalibration([calibration], { ...identity, inputDeviceId: "" })).toBeNull()
    expect(resolveRecordingOffsetFrames([calibration], { ...identity, outputDeviceId: "other" }, 17)).toEqual({ frames: 17, reusable: false })
  })

  test("uses async Chromium identity and conservative browser fallback", async () => {
    let requestedHints: readonly string[] = []
    expect(await resolveCalibrationPlatformIdentity({
      platform: "MacIntel",
      userAgent: "ignored",
      userAgentData: {
        platform: "macOS",
        brands: [{ brand: "Chromium", version: "140.1" }],
        getHighEntropyValues: async (hints) => {
          requestedHints = hints
          return { platformVersion: "15.3.0" }
        },
      },
    })).toBe("Chromium:140:macOS")
    expect(requestedHints).toEqual(["platformVersion"])
    expect(await resolveCalibrationPlatformIdentity({
      platform: "MacIntel",
      userAgent: "Mozilla/5.0 (Macintosh) Version/18.5 Safari/605.1.15",
    })).toBe("Safari:18:macOS")
  })

  test("applies reusable calibration only to the exact production configuration", () => {
    expect(resolveRecordingOffsetFrames([calibration], identity, 17)).toEqual({ frames: -500, reusable: true })
    expect(resolveRecordingOffsetFrames([calibration], { ...identity, sampleRate: 96_000 }, 17)).toEqual({ frames: 17, reusable: false })
  })

  test("replaces an exact key and bounds newest entries", () => {
    const entries = Array.from({ length: 35 }, (_, index) => ({ ...calibration, inputDeviceId: `input-${index}`, createdAtMs: index }))
    const result = replaceExactCalibration(entries, { ...calibration, confidence: 0.95, createdAtMs: 100 })
    expect(result).toHaveLength(32)
    expect(result[0]?.confidence).toBe(0.95)
    expect(result.filter((entry) => entry.inputDeviceId === "input-1")).toHaveLength(1)
  })
})
