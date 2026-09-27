import { expect, test } from "bun:test"
import { createRecordingBlockForwarder, createRecordingIpcDiagnostics, createRendererTrafficDiagnostics, createStatusSampler, parseRecordingForwardMode } from "./recording-ipc-diagnostics"

test("parses benchmark recording forwarding modes fail closed", () => {
  expect(parseRecordingForwardMode(undefined)).toBe("full")
  expect(parseRecordingForwardMode("batch4")).toBe("batch4")
  expect(parseRecordingForwardMode("unknown")).toBe("full")
})

test("batches full recording blocks without reordering or unbounded retention", () => {
  const forwarder = createRecordingBlockForwarder("batch4")
  const blocks = Array.from({ length: 5 }, (_, sequence) => ({
    generation: 1, sessionId: 2n, sequence, frameCount: 128, channelCount: 1, planarPcm: new Uint8Array(512),
  }))
  expect(forwarder.push(blocks[0]!)).toEqual([])
  expect(forwarder.push(blocks[1]!)).toEqual([])
  expect(forwarder.push(blocks[2]!)).toEqual([])
  expect(forwarder.push(blocks[3]!)).toEqual([{ kind: "blocks", blocks: blocks.slice(0, 4) }])
  expect(forwarder.push(blocks[4]!)).toEqual([])
  expect(forwarder.flush()).toEqual([{ kind: "blocks", blocks: blocks.slice(4) }])
})

test("routes metadata separately and drops PCM only in explicit modes", () => {
  const block = { generation: 1, sessionId: 2n, sequence: 3, frameCount: 128, channelCount: 2, planarPcm: new Uint8Array(1024) }
  expect(createRecordingBlockForwarder("drop").push(block)).toEqual([])
  expect(createRecordingBlockForwarder("metadata").push(block)).toEqual([{
    kind: "metadata",
    metadata: { generation: 1, sessionId: 2n, sequence: 3, frameCount: 128, channelCount: 2, payloadByteLength: 1024 },
  }])
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

test("status sampler preserves transitions and caps unchanged active status at four hertz", () => {
  const sampler = createStatusSampler()
  const active = { generation: 1, sessionId: 2n, configured: true, active: true, fatal: false, queuedBlocks: 1 }
  expect(sampler.shouldForward(active, 0)).toBe(true)
  expect(sampler.shouldForward(active, 100)).toBe(false)
  expect(sampler.shouldForward(active, 250)).toBe(true)
  expect(sampler.shouldForward({ ...active, active: false }, 251)).toBe(true)
  expect(sampler.shouldForward({ ...active, active: false, queuedBlocks: 0 }, 252)).toBe(true)
  expect(sampler.shouldForward({ ...active, sessionId: 3n }, 253)).toBe(true)
})
