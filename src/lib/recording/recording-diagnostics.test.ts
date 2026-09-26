import { describe, expect, test } from "bun:test"
import { getRecordingDiagnostics, resetRecordingDiagnostics, updateRecordingDiagnostics, recordRecordingTermination, recordRecordingLifecycle, recordNativeBlockTiming } from "./recording-diagnostics"

describe("recording diagnostics", () => {
  test("retains first terminal cause, sanitizes errors and bounds lifecycle history", () => {
    resetRecordingDiagnostics()
    for (let index = 0; index < 12; index++) recordRecordingLifecycle(index % 2 ? "ready" : "recovering")
    recordRecordingTermination("native-fatal", new Error("/Users/private/recording.wav failed " + "x".repeat(300)))
    recordRecordingTermination("controller-cleanup", new Error("later"))
    expect(getRecordingDiagnostics().termination).toMatchObject({ cause: "native-fatal" })
    expect(getRecordingDiagnostics().termination?.error).not.toContain("/Users/private")
    expect(getRecordingDiagnostics().termination?.error?.length).toBeLessThanOrEqual(256)
    expect(getRecordingDiagnostics().lifecycleTransitions).toHaveLength(8)
    resetRecordingDiagnostics()
    expect(getRecordingDiagnostics().termination).toBeNull()
  })
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

  test("retains peak writer backlog after the queue drains", () => {
    resetRecordingDiagnostics()
    updateRecordingDiagnostics({ queuedFrames: 4_096 })
    updateRecordingDiagnostics({ queuedFrames: 16_384 })
    updateRecordingDiagnostics({ queuedFrames: 0 })
    expect(getRecordingDiagnostics().peakQueuedFrames).toBe(16_384)
  })

  test("retains bounded buffer return aggregates and oldest age after overflow", () => {
    resetRecordingDiagnostics()
    updateRecordingDiagnostics({ writerReturnedBuffers: 2, writerReturnMaxMs: 15, writerOldestOutstandingMs: 120 })
    updateRecordingDiagnostics({ writerReturnedBuffers: 3, writerReturnMaxMs: 8, writerOldestOutstandingMs: 350 })
    expect(getRecordingDiagnostics()).toMatchObject({
      writerReturnedBuffers: 3, writerReturnMaxMs: 15, writerOldestOutstandingMs: 350,
    })
  })

  test("tracks writer pool depth separately from native queued frames", () => {
    resetRecordingDiagnostics()
    updateRecordingDiagnostics({ writerOutstandingBuffers: 8, queuedFrames: 34_816, sabWriterOccupancy: 8 })
    updateRecordingDiagnostics({ writerOutstandingBuffers: 0, queuedFrames: 0 })
    expect(getRecordingDiagnostics().peakSabWriterOccupancy).toBe(8)
    expect(getRecordingDiagnostics()).toMatchObject({
      peakWriterOutstandingBuffers: 8, writerOutstandingBuffers: 0, peakQueuedFrames: 34_816,
    })
  })

  test("records native block arrival gaps and handler duration without retaining blocks", () => {
    resetRecordingDiagnostics()
    recordNativeBlockTiming(0, 0.2)
    recordNativeBlockTiming(43, 0.3)
    recordNativeBlockTiming(800, 2)
    expect(getRecordingDiagnostics()).toMatchObject({
      nativeReceivedBlocks: 3, nativeArrivalGapMaxMs: 757, nativeHandlerMaxMs: 2,
    })
  })
})
