import { expect, test } from "bun:test"
import { createRecordingIpcDiagnostics, createRendererTrafficDiagnostics } from "./recording-ipc-diagnostics"

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
