import { expect, test } from "bun:test"
import { createDiagnosticsTrace, diagnosticValidationPaths } from "./diagnostics-trace"
import { z } from "zod"

test("opt-in diagnostics trace records bounded stages and distinguishes timeout boundaries", () => {
  const lines: string[] = []
  let now = 100
  const trace = createDiagnosticsTrace(true, (line) => lines.push(line), () => now)
  const start = trace.start()
  trace.mark(start, "socket-received")
  now = 104
  trace.mark(start, "renderer-dispatched")
  now = 10_100
  trace.mark(start, "renderer-deadline")
  expect(lines).toEqual([
    "[diagnostics-v2-boundary] operation=diagnostics.snapshot.v2 stage=socket-received elapsedMs=0",
    "[diagnostics-v2-boundary] operation=diagnostics.snapshot.v2 stage=renderer-dispatched elapsedMs=4",
    "[diagnostics-v2-boundary] operation=diagnostics.snapshot.v2 stage=renderer-deadline elapsedMs=10000",
  ])
  const disabled: string[] = []
  createDiagnosticsTrace(false, (line) => disabled.push(line)).mark(0, "socket-received")
  expect(disabled).toEqual([])
})

test("validation trace exposes only schema paths, not private values", () => {
  const result = z.object({ counts: z.object({ tracks: z.number() }) }).safeParse({ counts: { tracks: "secret" } })
  if (result.success) throw new Error("Expected invalid fixture")
  expect(diagnosticValidationPaths(result.error)).toEqual("counts.tracks")
})
