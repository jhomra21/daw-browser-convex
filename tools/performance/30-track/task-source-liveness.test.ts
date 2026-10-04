import { expect, test } from "bun:test"
import { classifyTaskSourceGap, summarizeTaskSourceGaps, taskSourceProbeScript, parseTaskSourceEvidence, analyzeTaskSourceEvidence, diagnosticReturnInterval } from "./task-source-liveness"

test("reads the control command envelope rather than treating it as diagnostics", () => {
  const interval = { returnedAtEpochMs: 100, receivedAtEpochMs: 1100 }
  expect(diagnosticReturnInterval({ data: { recording: { writerReturnDeliveryWorst: interval } } })).toEqual(interval)
  expect(diagnosticReturnInterval({ recording: { writerReturnDeliveryWorst: interval } })).toBeNull()
})

test("probe starts three bounded task sources and has deterministic cleanup", () => {
  const script = taskSourceProbeScript()
  expect(script).toContain("new MessageChannel()")
  expect(script).toContain("requestAnimationFrame")
  expect(script).toContain("benchmarkHeartbeat")
  expect(script).toContain("clearInterval(timer)")
  expect(script).toContain("channel.port1.close()")
  expect(script).toContain("channel.port2.close()")
  expect(script).toContain("messageDelivery")
  expect(script).toContain("electronMainToRenderer")
  expect(script).toContain("performance.timeOrigin+performance.now()")
})

test("evidence parser rejects oversized or private properties", () => {
  const source = { samples: [{ startEpochMs: 1, endEpochMs: 2 }], total: 1 }
  const encoded = JSON.stringify(JSON.stringify({ message: source, animation: source, electron: source,
    messageDelivery: source, electronToMain: source, electronMainToRenderer: source, supported: true, clockOffsetMs: 0 }))
  expect(parseTaskSourceEvidence(encoded).message.samples).toHaveLength(1)
  expect(() => parseTaskSourceEvidence(JSON.stringify(JSON.stringify({ message: { ...source, token: "private" }, animation: source, electron: source,
    messageDelivery: source, electronToMain: source, electronMainToRenderer: source, supported: true, clockOffsetMs: 0 })))).toThrow()
  expect(() => parseTaskSourceEvidence("x".repeat(150_000))).toThrow()
})

test("does not claim continuous liveness when samples do not cover the delayed return", () => {
  const delayed = { returnedAtEpochMs: 100, receivedAtEpochMs: 1100 }
  const source = { samples: [
    { startEpochMs: 0, endEpochMs: 150 },
    { startEpochMs: 150, endEpochMs: 1150 },
  ], total: 2 }
  const evidence = { supported: true, clockOffsetMs: 0, message: source, animation: source, electron: source,
    messageDelivery: source, electronToMain: source, electronMainToRenderer: source }
  expect(analyzeTaskSourceEvidence(evidence, delayed).classification).toBe("renderer-global-stall")
  expect(analyzeTaskSourceEvidence({ ...evidence, message: { samples: source.samples.slice(1), total: 2 } }, delayed).classification).toBe("unknown")
  expect(analyzeTaskSourceEvidence({ ...evidence, supported: false }, delayed).classification).toBe("unknown")
})

test("attributes simultaneous posted-message delays only with rAF and main-thread evidence", () => {
  const delayed = { returnedAtEpochMs: 100, receivedAtEpochMs: 1100 }
  const ticks = { samples: Array.from({ length: 12 }, (_, i) => ({ startEpochMs: i * 100, endEpochMs: (i + 1) * 100 })), total: 12 }
  const delayedDelivery = { samples: [{ startEpochMs: 90, endEpochMs: 1110 }], total: 1 }
  const mainFast = { samples: [{ startEpochMs: 200, endEpochMs: 201 }], total: 1 }
  const evidence = {
    supported: true, clockOffsetMs: 0, message: ticks, animation: ticks, electron: ticks,
    messageDelivery: delayedDelivery, electronToMain: mainFast, electronMainToRenderer: delayedDelivery,
  }
  expect(analyzeTaskSourceEvidence(evidence, delayed).dispatchBoundary).toBe("renderer-message-delivery-delay")
  expect(analyzeTaskSourceEvidence({ ...evidence, electronToMain: delayedDelivery }, delayed).dispatchBoundary).toBe("unknown")
  expect(analyzeTaskSourceEvidence({ ...evidence, animation: { samples: ticks.samples.slice(3), total: 9 } }, delayed).dispatchBoundary).toBe("unknown")
})

test("reports bounded quantiles and the timestamped worst gap", () => {
  expect(summarizeTaskSourceGaps([
    { startEpochMs: 100, endEpochMs: 120 },
    { startEpochMs: 120, endEpochMs: 160 },
    { startEpochMs: 160, endEpochMs: 260 },
    { startEpochMs: 260, endEpochMs: 460 },
  ])).toEqual({
    count: 4, p50Ms: 40, p95Ms: 200, p99Ms: 200, maxMs: 200,
    worst: { startEpochMs: 260, endEpochMs: 460 },
    firstEpochMs: 100, lastEpochMs: 460,
  })
  expect(summarizeTaskSourceGaps([])).toBeNull()
})

test("refuses classification without contemporaneous complete samples", () => {
  const delayed = { startEpochMs: 100, endEpochMs: 1100 }
  const ticking = { startEpochMs: 150, endEpochMs: 180 }
  expect(classifyTaskSourceGap(delayed, { message: ticking, animation: ticking, electron: ticking })).toBe("worker-message-starvation")
  expect(classifyTaskSourceGap(delayed, { message: delayed, animation: delayed, electron: delayed })).toBe("renderer-global-stall")
  expect(classifyTaskSourceGap(delayed, { message: ticking, animation: ticking, electron: delayed })).toBe("electron-ipc-delay")
  expect(classifyTaskSourceGap(delayed, { message: null, animation: ticking, electron: ticking })).toBe("unknown")
  expect(classifyTaskSourceGap(delayed, { message: { startEpochMs: 1200, endEpochMs: 1300 }, animation: ticking, electron: ticking })).toBe("unknown")
})
