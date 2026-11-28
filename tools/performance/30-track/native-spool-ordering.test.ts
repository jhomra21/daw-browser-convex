import { expect, test } from "bun:test"
import { assessSpoolDurability, createSpoolOrderCollector, type SpoolOrderEvent } from "./native-spool-ordering"

const proof = { frames: 3, bytes: 28, blocks: 1, sampleRateHz: 48000, channelCount: 2 }
const kinds: SpoolOrderEvent["kind"][] = ["receipt-file-synced", "receipt-directory-synced", "source-unlink-started", "source-unlinked", "source-directory-synced"]
const context = { savedClipObserved: true, assetObserved: true, releaseCalls: 1, originalReleaseSucceeded: true }
type Trace = { ready: boolean; invalid: boolean; overflow: boolean; events: SpoolOrderEvent[] }
const trace = (): Trace => ({
  ready: true, invalid: false, overflow: false,
  events: kinds.map((kind, index) => ({ version: 1, releaseOrdinal: 1, sequence: index + 1, kind, succeeded: true, ...proof })),
})
test("requires actual successful file and directory sync before owned unlink", () => {
  expect(assessSpoolDurability(trace(), proof, context)).toEqual([])
  const reversed = trace()
  reversed.events.reverse()
  expect(assessSpoolDurability(reversed, proof, context)).toContain("durability-event-order")
  for (const index of [0, 1, 2, 3, 4]) {
    const missing = trace()
    missing.events.splice(index, 1)
    expect(assessSpoolDurability(missing, proof, context)).not.toEqual([])
    const failed = trace()
    failed.events[index]!.succeeded = false
    expect(assessSpoolDurability(failed, proof, context)).toContain("durability-operation-failed")
  }
})
test("filesystem notifications and receipt existence alone are inconclusive", () => {
  expect(assessSpoolDurability({ ...trace(), events: [] }, proof, context)).toContain("durable-sync-before-unlink-unavailable")
  const collector = createSpoolOrderCollector()
  collector.observeLine('{"kind":"receipt-file-event","sourcePresent":true}')
  collector.observeLine('{"kind":"source-absent-event"}')
  expect(collector.evidence().events).toEqual([])
  expect(collector.evidence().ready).toBe(false)
})
test("saved clip and asset must already be observed before original release", () => {
  expect(assessSpoolDurability(trace(), proof, { ...context, savedClipObserved: false })).toContain("saved-clip-asset-before-release")
  expect(assessSpoolDurability(trace(), proof, { ...context, assetObserved: false })).toContain("saved-clip-asset-before-release")
  expect(assessSpoolDurability(trace(), proof, { ...context, releaseCalls: 2 })).toContain("durability-release")
  expect(assessSpoolDurability(trace(), proof, { ...context, originalReleaseSucceeded: false })).toContain("durability-release")
})
test("correlates exact proof totals and one fresh release without private identities", () => {
  for (const field of ["frames", "bytes", "blocks", "sampleRateHz", "channelCount"]) {
    expect(assessSpoolDurability(trace(), { ...proof, [field]: 0 }, context)).toContain("durability-proof")
  }
  const wrong = trace()
  wrong.events[2]!.releaseOrdinal = 2
  expect(assessSpoolDurability(wrong, proof, context)).toContain("durability-event-order")
  expect(assessSpoolDurability({ ...trace(), ready: false }, proof, context)).toContain("durable-sync-before-unlink-unavailable")
})
test("collector admits only strict bounded main-hook events and preserves delivery order", () => {
  const collector = createSpoolOrderCollector()
  collector.observeLine('[recording-spool-order] {"version":1,"kind":"observer-ready"}')
  for (const event of trace().events) collector.observeLine(`[recording-spool-order] ${JSON.stringify(event)}`)
  expect(collector.evidence()).toEqual(trace())
  collector.observeLine(`[recording-spool-order] ${JSON.stringify({ ...trace().events[0], token: "private" })}`)
  expect(collector.evidence().invalid).toBe(true)
  expect(JSON.stringify(collector.evidence())).not.toContain("private")
  for (let index = 0; index < 20; index++) collector.observeLine(`[recording-spool-order] ${JSON.stringify(trace().events[0])}`)
  expect(collector.evidence().events.length).toBeLessThanOrEqual(16)
  expect(collector.evidence().overflow).toBe(true)
})
test("collector fails closed for events before readiness, duplicate readiness, and malformed operation facts", () => {
  const beforeReady = createSpoolOrderCollector()
  beforeReady.observeLine(`[recording-spool-order] ${JSON.stringify(trace().events[0])}`)
  beforeReady.observeLine('[recording-spool-order] {"version":1,"kind":"observer-ready"}')
  expect(assessSpoolDurability(beforeReady.evidence(), proof, context)).toContain("durability-observer-invalid")

  const duplicateReady = createSpoolOrderCollector()
  duplicateReady.observeLine('[recording-spool-order] {"version":1,"kind":"observer-ready"}')
  duplicateReady.observeLine('[recording-spool-order] {"version":1,"kind":"observer-ready"}')
  expect(assessSpoolDurability(duplicateReady.evidence(), proof, context)).toContain("durability-observer-invalid")

  const malformed = createSpoolOrderCollector()
  malformed.observeLine('[recording-spool-order] {"version":1,"kind":"observer-ready"}')
  malformed.observeLine(`[recording-spool-order] ${JSON.stringify({ ...trace().events[0], succeeded: false })}`)
  expect(assessSpoolDurability(malformed.evidence(), proof, context)).toContain("durability-operation-failed")

  const oversized = createSpoolOrderCollector()
  oversized.observeLine(`[recording-spool-order] ${"x".repeat(1025)}`)
  expect(oversized.evidence().invalid).toBe(true)
  expect(assessSpoolDurability(oversized.evidence(), proof, context)).toContain("durability-observer-invalid")
})
test("late pipe delivery is event-driven with a bounded observation wait", async () => {
  const collector = createSpoolOrderCollector()
  const waiting = collector.waitForTerminal(100)
  collector.observeLine('[recording-spool-order] {"version":1,"kind":"observer-ready"}')
  for (const event of trace().events) collector.observeLine(`[recording-spool-order] ${JSON.stringify(event)}`)
  await waiting
  const absent = createSpoolOrderCollector()
  await expect(absent.waitForTerminal(1)).rejects.toThrow("durability observation")
  const closing = createSpoolOrderCollector()
  const pending = closing.waitForTerminal(100)
  closing.close()
  await expect(pending).rejects.toThrow("closed")
})
