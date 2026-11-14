import { expect, test } from "bun:test"
import { createSpoolStatusObservation } from "./native-spool-status"

const healthy = { capturedFrames: 2048, droppedFrames: 0, droppedBlocks: 0, availableBlocks: 31, queuedBlocks: 1,
  fatal: false, active: true, configured: true, spool: { state: 1, error: 0, systemError: 0 } }
test("records actual native bounds and retains transient failures beyond the 64-status ring", () => {
  const observed = createSpoolStatusObservation()
  observed.observe({ ...healthy, availableBlocks: 32, queuedBlocks: 2, droppedBlocks: 1, fatal: true })
  for (let index = 0; index < 80; index++) observed.observe(healthy)
  expect(observed.statuses.length).toBe(64)
  expect(observed.summary.count).toBe(81)
  expect(observed.summary.overwritten).toBe(17)
  expect(observed.summary.maxQueuedBlocks).toBe(2)
  expect(observed.summary.maxPoolBlocks).toBe(34)
  expect(observed.summary.failed).toBe(true)
})
test("spool errors cannot become successful legacy zero-counter recording", () => {
  const observed = createSpoolStatusObservation()
  observed.observe({ ...healthy, spool: { ...healthy.spool, systemError: 5 } })
  observed.observe(healthy)
  expect(observed.summary.failed).toBe(true)
  expect(createSpoolStatusObservation().summary.count).toBe(0)
})
