import { expect, test } from "bun:test"
import { serializeNativeDiagnostics } from "./native-diagnostics-serialization"
import type { NativeHostDiagnostics } from "@daw-browser/audio-engine/native-host-wire"

test("serializes worker automation sequence to desktop JSON", () => {
  const serialized = serializeNativeDiagnostics({
    workerAutomation: { instanceId: "trusted", acceptedPoints: 1, lastParameterId: 48,
      transportEpoch: 9, sequence: 9007199254740993n },
    renderEpoch: 1n, lastRejectedCallback: 0n, lastRejectedRenderEpoch: 0n,
    transportFrame: 480n,
    realtimePerformance: {
      sampleRateHz: 48_000, framesPerCallback: 512, observationCount: 2n,
      processingP50Nanoseconds: 1n, processingP95Nanoseconds: 2n,
      processingP99Nanoseconds: 3n, processingMaximumNanoseconds: 4n,
      deadlineMisses: 0n,
    },
    vstWorkerPerformance: {
      activeWorkers: 8, observationCount: 16n,
      processingP50Nanoseconds: 5n, processingP95Nanoseconds: 6n,
      processingP99Nanoseconds: 7n, processingMaximumNanoseconds: 8n,
      deadlineMisses: 0n, watchdogMisses: 0n, faults: 0n, restarts: 0n,
    },
  } satisfies Pick<NativeHostDiagnostics, "workerAutomation"
    | "renderEpoch" | "lastRejectedCallback" | "lastRejectedRenderEpoch" | "transportFrame"
    | "realtimePerformance" | "vstWorkerPerformance">)
  expect(serialized.workerAutomation?.sequence).toBe("9007199254740993")
  expect(JSON.parse(JSON.stringify(serialized))).toEqual({
    workerAutomation: { instanceId: "trusted", acceptedPoints: 1, lastParameterId: 48,
      transportEpoch: 9, sequence: "9007199254740993" },
    renderEpoch: "1", transportFrame: "480",
    realtimePerformance: {
      sampleRateHz: 48_000, framesPerCallback: 512, observationCount: "2",
      processingP50Nanoseconds: "1", processingP95Nanoseconds: "2",
      processingP99Nanoseconds: "3", processingMaximumNanoseconds: "4",
      deadlineMisses: "0",
    },
    vstWorkerPerformance: {
      activeWorkers: 8, observationCount: "16",
      processingP50Nanoseconds: "5", processingP95Nanoseconds: "6",
      processingP99Nanoseconds: "7", processingMaximumNanoseconds: "8",
      deadlineMisses: "0", watchdogMisses: "0", faults: "0", restarts: "0",
    },
    lastRejectedCallback: "0", lastRejectedRenderEpoch: "0",
  })
})
