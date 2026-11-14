import { expect, spyOn, test } from "bun:test"
import { createRecordingIpcDiagnostics, createRendererTrafficDiagnostics } from "./recording-ipc-diagnostics"
import { beginRecordingDeliveryTrace, createRecordingDeliveryTrace, finishRecordingDeliveryTrace, recordRecordingTermination, resetRecordingDiagnostics } from "../../src/lib/recording/recording-diagnostics"
import { createBenchmarkRecordingTelemetry } from "./benchmark-runtime"
import type { NativeHostRecordingBlock } from "@daw-browser/audio-engine/native-host-wire"

test("terminal status forwards the main ring exactly once without PCM", () => {
  const log = spyOn(console, "error").mockImplementation(() => undefined)
  try {
    const telemetry = createBenchmarkRecordingTelemetry(true)
    const status = { generation: 1, sessionId: 1n, timelineFrame: 0, capturedFrames: 2048, droppedFrames: 0, droppedBlocks: 0, availableBlocks: 32, queuedBlocks: 0, rms: 0, peak: 0, fatal: false, active: true, configured: true }
    telemetry.recordStatus(status)
    const block: NativeHostRecordingBlock = { generation: 1, sessionId: 1n, sequence: 0, frameCount: 2048, channelCount: 1, rms: 0, peak: 0, planarPcm: new Uint8Array(8192) }
    telemetry.sendBlock(block, () => { expect(block).toHaveProperty("benchmarkMainArrivalEpochMs") })
    const stopped = { ...status, active: false }
    telemetry.recordStatus(stopped)
    expect(stopped).toHaveProperty("benchmarkRecordingDelivery.capacity", 512)
    const repeat = { ...status, active: false }
    telemetry.recordStatus(repeat)
    expect(repeat).not.toHaveProperty("benchmarkRecordingDelivery")
  } finally { log.mockRestore() }
})

test("renderer opt-out allocates no live trace and reset preserves the completed fatal evidence", () => {
  delete globalThis.__dawRecordingDeliveryTraceEnabled
  expect(beginRecordingDeliveryTrace(1, 1n)).toBeNull()
  globalThis.__dawRecordingDeliveryTraceEnabled = true
  try {
    resetRecordingDiagnostics()
    beginRecordingDeliveryTrace(1, 1n)?.block(0, 17, 10)
    recordRecordingTermination("writer-failure", "/private/token.wav")
    recordRecordingTermination("controller-cleanup")
    finishRecordingDeliveryTrace()
    const completed = globalThis.__dawRecordingDeliveryEvidence
    resetRecordingDiagnostics()
    expect(globalThis.__dawRecordingDeliveryEvidence).toBe(completed)
    expect(completed?.firstTermination?.cause).toBe("writer-failure")
    expect(completed?.events.at(-1)?.kind).toBe("cleanup")
    expect(JSON.stringify(completed)).not.toContain("/private")
    beginRecordingDeliveryTrace(2, 2n)
    expect(globalThis.__dawRecordingDeliveryEvidence).toBeNull()
    finishRecordingDeliveryTrace()
    expect(globalThis.__dawRecordingDeliveryEvidence?.observedFrames).toBe(0)
  } finally {
    finishRecordingDeliveryTrace()
    delete globalThis.__dawRecordingDeliveryTraceEnabled
    delete globalThis.__dawRecordingDeliveryEvidence
    delete globalThis.__dawRecordingMainDeliveryEvidence
  }
})

test("main benchmark opt-out forwards unchanged and produces no evidence", () => {
  const log = spyOn(console, "error").mockImplementation(() => undefined)
  try {
    const telemetry = createBenchmarkRecordingTelemetry(false)
    let sends = 0
    telemetry.sendBlock({ generation: 1, sessionId: 1n, sequence: 0, frameCount: 42, channelCount: 1, rms: 0, peak: 0, planarPcm: new Uint8Array(168) }, () => { sends++ })
    expect(sends).toBe(1)
    expect(log).not.toHaveBeenCalled()
  } finally { log.mockRestore() }
})

test("main benchmark waits for capture then dumps once per session with scalar metadata", () => {
  const logs: string[] = []
  const log = spyOn(console, "error").mockImplementation((message) => { logs.push(String(message)) })
  try {
    const telemetry = createBenchmarkRecordingTelemetry(true)
    const status = { generation: 1, sessionId: 1n, timelineFrame: 0, capturedFrames: 0, droppedFrames: 0, droppedBlocks: 0, availableBlocks: 32, queuedBlocks: 0, rms: 0, peak: 0, fatal: false, active: false, configured: true }
    telemetry.recordStatus(status)
    expect(logs).toHaveLength(0)
    telemetry.recordStatus({ ...status, active: true, queuedBlocks: 11 })
    telemetry.sendBlock({ generation: 1, sessionId: 1n, sequence: 0, frameCount: 42, channelCount: 1, rms: 0, peak: 0, planarPcm: new Uint8Array(168) }, () => undefined)
    telemetry.recordStatus({ ...status, fatal: true })
    telemetry.recordStatus(status)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('"frameCount":42')
    expect(logs[0]).toContain('"nativeQueuedBlocks":11')
    expect(logs[0]).not.toContain("planarPcm")
    const next = { ...status, generation: 2, sessionId: 2n }
    telemetry.recordStatus({ ...next, active: true })
    telemetry.recordStatus(next)
    expect(logs).toHaveLength(2)
    expect(logs[1]).toContain('"observedFrames":0')
  } finally { log.mockRestore() }
})

// Failure modes: opt-out collection, unbounded growth, duplicate dumps, stale
// sessions, payload retention, lost fatal transitions, and incompatible clocks.
test("delivery tracing is a no-op when disabled", () => {
  const trace = createRecordingDeliveryTrace(false, 1, 1n, 0)
  trace.block(0, 2048, 10, 0)
  trace.transition("writer-failure", 11)
  expect(trace.dump(12)).toBeNull()
})

test("delivery trace wraps at 512 entries in arrival order and dumps once", () => {
  const trace = createRecordingDeliveryTrace(true, 1, 1n, 0)
  for (let sequence = 0; sequence < 600; sequence++) trace.block(sequence, sequence === 599 ? 17 : 2048, sequence, 2)
  const dump = trace.dump(601)
  expect(dump?.events).toHaveLength(512)
  expect(dump?.events[0]?.sequence).toBe(88)
  expect(dump?.events.at(-1)?.frameCount).toBe(17)
  expect(dump?.overwritten).toBe(88)
  expect(dump?.observedFrames).toBe(599 * 2048 + 17)
  expect(trace.dump(602)).toBeNull()
  trace.block(600, 2048, 603, 0)
  expect(dump?.events).toHaveLength(512)
})

test("new delivery sessions reset counts and retain first fatal through cleanup and wrap", () => {
  const trace = createRecordingDeliveryTrace(true, 1, 1n, 0)
  trace.status(10, 11, true, true, 22528)
  trace.transition("native-fatal", 11)
  for (let index = 0; index < 520; index++) trace.block(index, 128, index + 12, 0)
  trace.status(533, 0, false, false, 0)
  trace.transition("controller-cleanup", 534)
  const dump = trace.dump(535)
  expect(dump?.firstTermination).toEqual({ cause: "native-fatal", atEpochMs: 11 })
  expect(dump?.firstFatalStatus).toEqual({ atEpochMs: 10, queuedBlocks: 11, capturedFrames: 22528 })
  expect(dump?.events.at(-1)?.kind).toBe("controller-cleanup")
  const next = createRecordingDeliveryTrace(true, 2, 2n, 536)
  expect(next.dump(537)).toMatchObject({ generation: 2, sessionId: "2", observedFrames: 0, overwritten: 0, firstTermination: null })
})

test("delivery evidence copies only scalar metadata, never PCM, paths or errors", () => {
  const payload = { sequence: 0, frameCount: 42, planarPcm: new Uint8Array([123]), path: "/private/take.wav", secret: "token" }
  const trace = createRecordingDeliveryTrace(true, 1, 1n, 0)
  trace.block(payload.sequence, payload.frameCount, 10, 3)
  trace.writer(11, 8, 2, 5, 7, 9, 4)
  const encoded = JSON.stringify(trace.dump(12))
  expect(encoded).not.toContain("planarPcm")
  expect(encoded).not.toContain("/private")
  expect(encoded).not.toContain("token")
  expect(encoded).toContain('"outstanding":8')
  expect(encoded).toContain('"deliveryMs":7')
})

test("reports bounded recording rate, payload and send percentiles", () => {
  const diagnostics = createRecordingIpcDiagnostics(0)
  diagnostics.recordBlock({ frameCount: 128, channelCount: 2, payloadBytes: 1024 })
  diagnostics.recordSend(1)
  diagnostics.recordBlock({ frameCount: 256, channelCount: 2, payloadBytes: 2048 })
  diagnostics.recordSend(2)
  expect(diagnostics.report(1_000)).toEqual({
    seconds: 1,
    count: 2,
    blocksPerSecond: 2,
    channelCounts: [2],
    frameCount: { min: 128, p50: 128, p95: 256, max: 256 },
    payloadBytes: { min: 1024, p50: 1024, p95: 2048, max: 2048 },
    payloadBytesPerSecond: 3072,
    sendMs: { p50: 1, p95: 2, p99: 2, max: 2 },
  })
})

test("reports per-channel renderer traffic rates and estimated bytes", () => {
  const traffic = createRendererTrafficDiagnostics(0)
  traffic.record("recording-block", 1024)
  traffic.record("recording-status", 96)
  traffic.record("recording-block", 1024)
  expect(traffic.report(1_000)).toEqual({
    seconds: 1,
    channels: {
      "recording-block": { count: 2, messagesPerSecond: 2, estimatedBytesPerSecond: 2048 },
      "recording-status": { count: 1, messagesPerSecond: 1, estimatedBytesPerSecond: 96 },
    },
  })
})
