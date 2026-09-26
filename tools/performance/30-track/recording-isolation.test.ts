import { describe, expect, test } from "bun:test"
import { assessRecording, recordedAudioClip, rendererAttachmentState, recordingTimingResult, verifyReopenedRecording } from "./recording-isolation"

describe("isolated native recording gates", () => {
  test("waits through initial blank renderer and selects navigated app target", () => {
    expect(rendererAttachmentState("→ [t1]  - about:blank")).toEqual({ kind: "waiting" })
    expect(rendererAttachmentState("→ [t1] DAW - daw://app/")).toEqual({ kind: "ready", targetId: "t1" })
  })
  const before = { capturedFrames: 12, activeSampleRate: 48_000, droppedFrames: 0, overrunFrames: 0, lastFailurePresent: false }
  const after = { ...before, capturedFrames: 48_012 }
  test("requires active capture over the full interval and increasing frames", () => {
    expect(assessRecording(before, after, true, true, 15_000)).toBeNull()
    expect(assessRecording({ ...before, capturedFrames: null }, after, true, true, 15_000)).toBeNull()
    expect(assessRecording(before, after, true, false, 15_000)).toBe("recording ended before explicit stop")
    expect(assessRecording(before, after, true, true, 14_999)).toBe("recording interval shorter than 15 seconds")
    expect(assessRecording(before, { ...after, capturedFrames: 12 }, true, true, 15_000)).toBe("captured frames did not increase")
    expect(assessRecording(before, { ...after, droppedFrames: 1 }, true, true, 15_000)).toBe("recording diagnostics reported a failure")
  })
  test("requires exactly one new recording clip on the armed track", () => {
    const beforeClips = [{ id: "existing", trackId: "audio", duration: 2, source: { sourceKind: "recording" } }]
    const afterClips = [...beforeClips, { id: "new", trackId: "audio", duration: 1, source: { sourceKind: "recording" } }]
    expect(recordedAudioClip(beforeClips, afterClips, "audio")).toBe("new")
    expect(() => recordedAudioClip(beforeClips, [...afterClips, { ...afterClips[1]!, id: "other" }], "audio")).toThrow()
    expect(() => recordedAudioClip(beforeClips, beforeClips, "audio")).toThrow()
  })
  test("retains bounded worker timing on successful explicit stop", () => {
    const timing = { append: { count: 300, startDelayMs: { total: 10, max: 2 }, durationMs: { total: 500, max: 8 } }, storage: null }
    expect(recordingTimingResult({ ...after, writerTiming: timing })).toEqual(timing)
  })
  test("cold reopen requires the same recording clip and intact asset metadata", () => {
    const clip = { id: "clip", trackId: "audio", duration: 1, source: { sourceKind: "recording", assetId: "asset" } }
    const asset = { id: "asset", sourceKind: "recording", sizeBytes: 1024, contentSha256: "digest", durationSec: 1, sampleRate: 48000, channelCount: 2 }
    const expected = { clips: [clip], assets: [asset] }
    expect(() => verifyReopenedRecording(expected, expected, "clip")).not.toThrow()
    expect(() => verifyReopenedRecording(expected, { clips: [clip], assets: [] }, "clip")).toThrow()
    expect(() => verifyReopenedRecording(expected, { clips: [clip], assets: [{ ...asset, contentSha256: "changed" }] }, "clip")).toThrow()
    expect(() => verifyReopenedRecording(expected, { clips: [{ ...clip, source: { ...clip.source, assetId: "missing" } }], assets: [asset] }, "clip")).toThrow()
    expect(() => verifyReopenedRecording(expected, { clips: [], assets: [asset] }, "clip")).toThrow()
  })
})
