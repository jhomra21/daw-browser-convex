import { expect, test } from "bun:test"
import { createRecordingDeliveryTrace } from "../../../src/lib/recording/recording-diagnostics"
import { compareRecordingDeliveryClocks, parseRecordingDeliveryEvidence } from "./tier-three"

// Kept with the tools so desktop's package typecheck does not pull in the
// performance harness, which has its own existing TypeScript failures.
test("collection rejects private fields and over-capacity evidence", () => {
  const trace = createRecordingDeliveryTrace(true, 1, 1n, 0)
  trace.block(0, 17, 10, 0, 9)
  const dump = trace.dump(11)
  const evidence = { trace: dump, mainTrace: null, clockBefore: null, clockAfter: null }
  expect(parseRecordingDeliveryEvidence(JSON.stringify(evidence)).trace?.events[0]?.mainArrivalEpochMs).toBe(9)
  expect(() => parseRecordingDeliveryEvidence(JSON.stringify({ ...evidence, secret: "/private" }))).toThrow()
  expect(() => parseRecordingDeliveryEvidence(JSON.stringify({ ...evidence, trace: { ...dump, events: Array(513).fill(dump?.events[0]) } }))).toThrow()
})

test("clock comparison reports bounds rather than silently assuming shared origins", () => {
  const clock = { rendererBeforeEpochMs: 100, rendererAfterEpochMs: 104, mainEpochMs: 102, mainMonotonicEpochMs: 102, mainMinusRendererLowerMs: -2, mainMinusRendererUpperMs: 2 }
  expect(compareRecordingDeliveryClocks(clock, clock)).toEqual({ status: "zero-offset-compatible", lowerMs: -2, upperMs: 2 })
  expect(compareRecordingDeliveryClocks(clock, { ...clock, mainMinusRendererLowerMs: 10, mainMinusRendererUpperMs: 12 }).status).toBe("inconsistent-bounds")
  expect(compareRecordingDeliveryClocks(null, clock).status).toBe("unavailable")
})
