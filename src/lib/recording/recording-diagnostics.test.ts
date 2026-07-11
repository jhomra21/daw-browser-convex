import { describe, expect, test } from "bun:test"
import { getRecordingDiagnostics, resetRecordingDiagnostics, updateRecordingDiagnostics } from "./recording-diagnostics"

describe("recording diagnostics", () => {
  test("keeps counters bounded in browser memory and resets failures", () => {
    resetRecordingDiagnostics()
    updateRecordingDiagnostics({
      capturedFrames: Number.MAX_SAFE_INTEGER + 10,
      droppedFrames: -3,
      queuedFrames: Number.NaN,
      lastFailure: "writer-failed",
    })
    expect(getRecordingDiagnostics()).toMatchObject({
      capturedFrames: null,
      droppedFrames: 0,
      queuedFrames: null,
      lastFailure: "writer-failed",
    })
    resetRecordingDiagnostics()
    expect(getRecordingDiagnostics().lastFailure).toBeNull()
    expect(getRecordingDiagnostics()).toMatchObject({
      capturedFrames: null,
      overrunFrames: null,
      droppedFrames: null,
      queuedFrames: null,
    })
  })

  test("publishes bounded live capture and queue updates", () => {
    resetRecordingDiagnostics()
    updateRecordingDiagnostics({ capturedFrames: 4_096, queuedFrames: 2_048 })
    expect(getRecordingDiagnostics()).toMatchObject({ capturedFrames: 4_096, queuedFrames: 2_048 })
  })
})
