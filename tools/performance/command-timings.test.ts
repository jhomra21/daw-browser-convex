import { expect, test } from "bun:test"
import { createCommandTimings } from "./command-timings"

test("command timings remain opt-in and bound completed entries", () => {
  const disabled = createCommandTimings(false)
  disabled.record("browser", "eval", 1, 2, 0)
  expect(disabled.snapshot()).toEqual([])

  const enabled = createCommandTimings(true)
  for (let index = 0; index < 65; index += 1) {
    enabled.record("browser", "eval", index, index + 2, index === 64 ? null : 0)
  }
  const entries = enabled.snapshot()
  expect(entries).toHaveLength(64)
  expect(entries[0]).toEqual({ boundary: "browser", kind: "eval", startedAt: new Date(1).toISOString(), durationMs: 3, exitCode: 0 })
  expect(entries[63]?.exitCode).toBeNull()
})

test("command timing kinds cannot contain arguments", () => {
  const timings = createCommandTimings(true)
  timings.record("control-cli", "snapshot-v2 project-secret --target host", 0, 1, 1)
  expect(timings.snapshot()[0]?.kind).toBe("unknown")
})
