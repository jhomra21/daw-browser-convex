import { expect, spyOn, test } from "bun:test"
import { createRecordingIpcDiagnostics, createRendererTrafficDiagnostics } from "./recording-ipc-diagnostics"
import { createRecordingDeliveryTrace } from "../../src/lib/recording/recording-delivery-trace"
import { createBenchmarkRecordingTelemetry } from "./benchmark-runtime"

test("terminal benchmark evidence is logged once without mutating the status", () => {
  const log = spyOn(console, "error").mockImplementation(() => undefined)
  try {
    const telemetry = createBenchmarkRecordingTelemetry(true)
    const active = { generation: 1, sessionId: 1n, timelineFrame: 0, capturedFrames: 2048, droppedFrames: 0, droppedBlocks: 0, availableBlocks: 32, queuedBlocks: 0, rms: 0, peak: 0, fatal: false, active: true, configured: true }
    telemetry.recordStatus(active)
    const stopped = { ...active, active: false }
    telemetry.recordStatus(stopped)
    expect(log).toHaveBeenCalledTimes(1)
    const evidence = JSON.parse(String(log.mock.calls[0]?.[0]).replace("[quiet-recording-ipc] ", ""))
    expect(evidence.status).toMatchObject({ generation: 1, sessionId: "1", active: false })
    expect(evidence.delivery.capacity).toBe(512)
    expect(stopped).toEqual({ ...active, active: false })
    telemetry.recordStatus({ ...active, active: false })
    expect(log).toHaveBeenCalledTimes(1)
  } finally { log.mockRestore() }
})

test("main benchmark opt-out produces no evidence", () => {
  const log = spyOn(console, "error").mockImplementation(() => undefined)
  try {
    const telemetry = createBenchmarkRecordingTelemetry(false)
    telemetry.recordStatus({ generation: 1, sessionId: 1n, timelineFrame: 0, capturedFrames: 0, droppedFrames: 0,
      droppedBlocks: 0, availableBlocks: 32, queuedBlocks: 0, rms: 0, peak: 0, fatal: false, active: false, configured: true })
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
    telemetry.recordStatus({ ...status, fatal: true })
    telemetry.recordStatus(status)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('"observedFrames":0')
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

test("delivery trace exposes only its bounded numeric event fields", () => {
  const trace = createRecordingDeliveryTrace(true, 1, 1n, 0)
  trace.block(0, 42, 10, 3)
  trace.writer(11, 8, 2, 5, 7, 9, 4)
  expect(trace.dump(12)).toMatchObject({ observedFrames: 42, events: [
    { kind: "block", sequence: 0, frameCount: 42 },
    { kind: "writer", outstanding: 8, deliveryMs: 7 },
  ] })
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
