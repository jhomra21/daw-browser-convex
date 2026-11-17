import { expect, test } from "bun:test"
import { createRecordingStartDiagnostic, type RecordingStartDiagnosticEvent } from "./recording-start-diagnostic"

test("diagnostic observation never decides whether native capture starts", () => {
  const events: RecordingStartDiagnosticEvent[] = []
  const diagnostic = createRecordingStartDiagnostic(true, (event) => events.push(event))
  diagnostic.observeStart({ ok: true })
  expect(events).toEqual([{ kind: "native-start-result", outcome: "succeeded" }])
})

test("disabled diagnostics do not alter a native start result", () => {
  const events: RecordingStartDiagnosticEvent[] = []
  const diagnostic = createRecordingStartDiagnostic(false, (event) => events.push(event))
  const result = { ok: false, error: "native-start-failed" }
  diagnostic.observeStart(result)
  expect(result).toEqual({ ok: false, error: "native-start-failed" })
  expect(events).toEqual([])
})

test("diagnostic events retain only safe allowlisted scalars", () => {
  const events: RecordingStartDiagnosticEvent[] = []
  const diagnostic = createRecordingStartDiagnostic(true, (event) => events.push(event))

  diagnostic.observe({
    kind: "configure-result",
    outcome: "rejected",
    category: "command-rejected",
    deviceId: "private-device-id",
    projectId: "private-project",
    error: "token=/private/user/path",
  })
  diagnostic.observe({
    kind: "readiness",
    configured: false,
    active: false,
    sampleRateHz: 48_000,
    channelCount: 1,
    spool: { state: 1, error: 7, systemError: 0 },
    deviceId: "private-device-id",
    projectId: "private-project",
    token: "secret",
  })

  expect(events).toEqual([
    { kind: "configure-result", outcome: "rejected", category: "command-rejected",
      sampleRateHz: null, channelCount: null },
    { kind: "readiness", configured: false, active: false, sampleRateHz: 48_000, channelCount: 1,
      spoolState: 1, spoolError: 7, spoolSystemError: 0 },
  ])
  expect(JSON.stringify(events)).not.toMatch(/private|token|path/)
})

test("diagnostic event count is bounded", () => {
  const events: RecordingStartDiagnosticEvent[] = []
  const diagnostic = createRecordingStartDiagnostic(true, (event) => events.push(event))

  for (let index = 0; index < 100; index += 1) diagnostic.observe({ kind: "backend", backend: "native" })
  diagnostic.observeCaptureBlocked()
  expect(events).toHaveLength(64)
  expect(events.at(-1)).toEqual({ kind: "native-start-blocked" })
})

test("an unrecognized backend value is reported as unknown, never verbatim", () => {
  const events: RecordingStartDiagnosticEvent[] = []
  const diagnostic = createRecordingStartDiagnostic(true, (event) => events.push(event))

  expect(() => diagnostic.observe({ kind: "backend", backend: "raw-device-name" })).not.toThrow()
  expect(events).toEqual([{ kind: "backend", backend: "unknown" }])
})
