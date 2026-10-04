import { expect, test } from "bun:test"
import type { z } from "zod"
import {
  desktopDiagnosticsSchemaV2,
  desktopReplySchemaV1,
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
    peakQueuedFrames: 0,
    writerReturnedBuffers: 0,
    writerOutstandingBuffers: 0,
    nativeReceivedBlocks: 0,
    nativeArrivalGapMaxMs: 0,
    nativeHandlerMaxMs: 0,
    peakWriterOutstandingBuffers: 0,
    writerReturnMaxMs: 0,
    writerReturnDeliveryMaxMs: 0,
    writerReturnDeliveryWorst: null,
    writerOldestOutstandingMs: 0,
    writerTiming: null,
    muted: false,
    deviceLost: false,
    lastFailurePresent: false,
    termination: null,
    lifecycleTransitions: [],
    lastNativeStatus: null,
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

test("diagnostics v2 retains bounded SAB occupancy alongside the recording transport", () => {
  const recording = {
    ...diagnostics.recording,
    transport: "sab" as const,
    sabWriterOccupancy: 2,
    peakSabWriterOccupancy: 8,
  }
  expect(desktopDiagnosticsSchemaV2.parse({ ...diagnostics, recording }).recording).toEqual(recording)
  expect(desktopDiagnosticsSchemaV2.safeParse({
    ...diagnostics, recording: { ...recording, peakSabWriterOccupancy: 9 },
  }).success).toBe(false)
})

test("diagnostics v2 accepts bounded scheduler timing only when present", () => {
  const scheduler = { progressCount: 2, compileCount: 3, compileTotalMs: 4.5, compileMaxMs: 2.5, submittedVstSegments: 4 }
  expect(desktopDiagnosticsSchemaV2.parse({ ...diagnostics, scheduler }).scheduler).toEqual(scheduler)
  expect(desktopDiagnosticsSchemaV2.parse(diagnostics).scheduler).toBeUndefined()
  expect(() => desktopDiagnosticsSchemaV2.parse({ ...diagnostics, scheduler: { ...scheduler, compileCount: -1 } })).toThrow()
  expect(() => desktopDiagnosticsSchemaV2.parse({ ...diagnostics, scheduler: { ...scheduler, raw: "private" } })).toThrow()
})

test("diagnostics without a scheduler remains a valid desktop reply", () => {
  const result = desktopDiagnosticsSchemaV2.parse(diagnostics)
  expect(desktopReplySchemaV1.safeParse({ version: "v1", type: "reply", id: "diagnostics-1", result }).success).toBe(true)
  const invalid = desktopDiagnosticsSchemaV2.parse({ ...diagnostics, scheduler: undefined })
  expect(desktopReplySchemaV1.safeParse({ version: "v1", type: "reply", id: "diagnostics-1", result: invalid }).success).toBe(false)
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

test("diagnostics v2 requires explicit missing or current worker automation evidence", () => {
  const native = {
    status: "available" as const,
    artifactVerification: { status: "verified" as const },
    diagnostics: {
      state: "running" as const, activeRevision: 1, preparedRevision: 0, retiredRevision: 0,
      transportEpoch: 7, renderEpoch: "2", installedAssets: 0, callbacks: 0, rejectedBlocks: 0,
      lastRejectedReason: 0, lastRejectedCallback: "0", lastRejectedRenderEpoch: "0",
      lastRejectedTransportEpoch: 0, lastRejectedCoreResult: 0, lastRejectedFrameCount: 0,
      lastRejectedChannelCount: 0, lastRejectedProcessorEventCount: 0,
      lastRejectedInstrumentEventCount: 0, lastRejectedGraphRevision: 0,
    },
  }
  expect(() => desktopDiagnosticsSchemaV2.parse({ ...diagnostics, native })).toThrow()
  const missing = { ...native, diagnostics: { ...native.diagnostics, workerAutomation: null } }
  expect(desktopDiagnosticsSchemaV2.parse({ ...diagnostics, native: missing }).native).toEqual(missing)
  expect(() => desktopDiagnosticsSchemaV2.parse({ ...diagnostics, native: {
    ...missing, diagnostics: { ...missing.diagnostics, watchedMixProcessed: {
      instanceId: "mix", acceptedPoints: 1, lastParameterId: 48, transportEpoch: 7, sequence: "2",
    } },
  } })).toThrow()
  expect(() => desktopDiagnosticsSchemaV2.parse({ ...diagnostics, native: {
    ...missing, diagnostics: { ...missing.diagnostics, watchedMixHost: {
      instanceId: "mix", published: 2, projected: 1, overrideSkips: 1, submitted: 1, transportEpoch: 7,
    } },
  } })).toThrow()
  const stale = { ...native, diagnostics: { ...native.diagnostics, workerAutomation: {
    acceptedPoints: 2, lastParameterId: 9, transportEpoch: 6, sequence: "12",
  } } }
  expect(() => desktopDiagnosticsSchemaV2.parse({ ...diagnostics, native: stale })).toThrow()
  const matched = { ...native, diagnostics: { ...native.diagnostics, workerAutomation: {
    acceptedPoints: 2, lastParameterId: 9, transportEpoch: 7, sequence: "12",
    instanceId: "11111111-1111-4111-8111-111111111111",
  } } }
  expect(desktopDiagnosticsSchemaV2.parse({ ...diagnostics, native: matched }).native).toEqual(matched)
  expect(() => desktopDiagnosticsSchemaV2.parse({ ...diagnostics, native: {
    ...matched, diagnostics: { ...matched.diagnostics, workerAutomation: {
      ...matched.diagnostics.workerAutomation, instanceId: "",
    } },
  } })).toThrow()
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

test("diagnostics v2 retains bounded native termination evidence without raw errors", () => {
  const recording: z.input<typeof desktopDiagnosticsSchemaV2>["recording"] = {
    ...diagnostics.recording,
    termination: { cause: "native-fatal" },
    lifecycleTransitions: ["ready", "recovering"],
    lastNativeStatus: { active: false, fatal: true, capturedFrames: 2048, droppedFrames: 2048, queuedBlocks: 8 },
  }
  expect(desktopDiagnosticsSchemaV2.parse({ ...diagnostics, recording }).recording).toEqual(recording)
  expect(() => desktopDiagnosticsSchemaV2.parse({
    ...diagnostics, recording: { ...recording, termination: { cause: "native-fatal", error: "raw private error" } },
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
