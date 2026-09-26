import { expect, test } from "bun:test"
import { onceAsync, rendererTraceCategories, rendererTraceWindowMs, summarizeRendererTrace, traceEpochRange } from "./renderer-trace"

test("awaits an in-flight timed trace stop before app cleanup", async () => {
  let release = () => {}
  const pending = new Promise<void>((resolve) => { release = resolve })
  const stop = onceAsync(() => pending)
  const first = stop()
  expect(stop()).toBe(first)
  release()
  await first
})

test("bounds timeline trace to the first second before raw stream exceeds its cap", () => {
  expect(rendererTraceWindowMs).toBe(1_000)
})

test("collects timeline tasks without broad script and paint categories", () => {
  expect(rendererTraceCategories).toContain("devtools.timeline")
  expect(rendererTraceCategories).not.toContain("blink")
  expect(rendererTraceCategories).not.toContain(",v8")
  expect(rendererTraceCategories).not.toContain(",ipc")
})

test("trace output retains only allowlisted names and numeric timings", () => {
  const output = summarizeRendererTrace(JSON.stringify({ traceEvents: [
    { cat: "devtools.timeline", name: "RunTask", ts: 100, dur: 40, args: { url: "secret" } },
    { cat: "v8", name: "V8.Execute", ts: 150, dur: 20, args: { token: "secret" } },
    { cat: "devtools.timeline", name: "secret", ts: 170, args: { data: "secret" } },
  ] }))
  expect(output).toEqual({ events: [{ name: "RunTask", ts: 100, dur: 40 }, { name: "V8.Execute", ts: 150, dur: 20 }], counts: { RunTask: 1, "V8.Execute": 1 } })
  expect(JSON.stringify(output)).not.toContain("secret")
})

test("requires the delayed return interval to fit inside the trace clock range", () => {
  expect(traceEpochRange({ startedAtEpochMs: 1000, stoppedAtEpochMs: 2000 },
    { returnedAtEpochMs: 1200, receivedAtEpochMs: 1900 })).toBe(true)
  expect(traceEpochRange({ startedAtEpochMs: 1000, stoppedAtEpochMs: 2000 },
    { returnedAtEpochMs: 1900, receivedAtEpochMs: 2500 })).toBe(false)
})


test("trace rejects excessive event counts", () => {
  const trace = summarizeRendererTrace(JSON.stringify({ traceEvents: Array(20_001).fill({ name: "irrelevant", ts: 1 }) }))
  expect(trace.events).toEqual([])
  expect(trace.counts).toEqual({})
  expect(() => summarizeRendererTrace(JSON.stringify({ traceEvents: Array(100_001).fill({ name: "irrelevant", ts: 1 }) }))).toThrow()
})

test("rejects a high-volume trace rather than persisting raw fields", () => {
  expect(() => summarizeRendererTrace(JSON.stringify({ traceEvents: Array(120_000).fill({ name: "irrelevant", ts: 1, args: { token: "secret" } }) }))).toThrow()
})
