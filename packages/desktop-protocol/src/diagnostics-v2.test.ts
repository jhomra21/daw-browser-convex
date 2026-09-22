import { expect, test } from "bun:test"
import type { z } from "zod"
import {
  desktopDiagnosticsSchemaV2,
  desktopRequestSchemaV1,
  parseDesktopResult,
} from "./index"

const diagnostics = {
  version: "v2",
  audio: {
    state: "uninitialized",
    sampleRate: null,
    requestedSampleRate: null,
    latencyHint: null,
    baseLatencySec: null,
    outputLatencySec: null,
    totalOutputLatencySec: null,
    graphPdcLatencyFrames: null,
    workletFaultCount: 0,
    runtimeFaults: {
      eventCount: 0,
      uniqueSignatureCount: 0,
      byKind: { compressor: 0, "owned-processor": 0, "track-meter": 0, recorder: 0 },
      last: null,
    },
    inferredApplicationStallCount: 0,
  },
  recording: {
    requestedFormat: "pcm",
    activeFormat: "pcm",
    requestedLayout: "mono",
    activeChannels: null,
    requestedSampleRate: null,
    activeSampleRate: null,
    transport: null,
    capturedFrames: null,
    overrunFrames: null,
    droppedFrames: null,
    queuedFrames: null,
    muted: false,
    deviceLost: false,
    lastFailurePresent: false,
  },
  counts: { tracks: 30, clips: 30 },
  waveform: { available: false, reason: "not-exposed-at-controller-boundary" },
  native: { status: "unavailable", reason: "desktop-bridge-unavailable" },
} satisfies z.input<typeof desktopDiagnosticsSchemaV2>

test("diagnostics v2 is strict and preserves decimal BigInt fields", () => {
  expect(desktopDiagnosticsSchemaV2.parse(diagnostics)).toEqual(diagnostics)
  expect(() => desktopDiagnosticsSchemaV2.parse({ ...diagnostics, extra: true })).toThrow()
  expect(parseDesktopResult("diagnostics.snapshot.v2", diagnostics)).toEqual(diagnostics)
})

test("diagnostics v2 distinguishes native IPC failure from an unavailable bridge", () => {
  expect(desktopDiagnosticsSchemaV2.parse({
    ...diagnostics,
    native: {
      status: "failed",
      errorCode: "native-diagnostics-unavailable",
      artifactVerification: { status: "failed" },
    },
  }).native).toEqual({
    status: "failed",
    errorCode: "native-diagnostics-unavailable",
    artifactVerification: { status: "failed" },
  })
})

test("diagnostics v2 rejects raw failure details", () => {
  expect(() => desktopDiagnosticsSchemaV2.parse({
    ...diagnostics,
    audio: {
      ...diagnostics.audio,
      runtimeFaults: { ...diagnostics.audio.runtimeFaults, last: { kind: "recorder", code: "raw", context: "secret" } },
    },
    recording: { ...diagnostics.recording, lastFailure: "raw failure" },
  })).toThrow()
})

test("diagnostics v2 is a distinct public operation", () => {
  expect(desktopRequestSchemaV1.parse({
    version: "v1",
    type: "request",
    id: "diagnostics-v2",
    operation: "diagnostics.snapshot.v2",
    input: {},
  }).operation).toBe("diagnostics.snapshot.v2")
})
