import { expect, test } from "bun:test"
import { createRecordingStartDiagnostic, type RecordingStartDiagnosticEvent } from "./recording-start-diagnostic"

test("diagnostic mode blocks native start before the supplied command can run", async () => {
  const events: RecordingStartDiagnosticEvent[] = []
  const diagnostic = createRecordingStartDiagnostic(true, (event) => events.push(event))
  let nativeStarts = 0

  const result = await diagnostic.start(() => {
    nativeStarts += 1
    return Promise.resolve({ ok: true })
  })

  expect(result).toEqual({ ok: false, error: "diagnostic-capture-blocked" })
  expect(nativeStarts).toBe(0)
  expect(events).toEqual([{ kind: "native-start-blocked" }])
})

test("normal mode forwards native start unchanged", async () => {
  const events: RecordingStartDiagnosticEvent[] = []
  const diagnostic = createRecordingStartDiagnostic(false, (event) => events.push(event))
  const result = await diagnostic.start(() => Promise.resolve({ ok: true }))

  expect(result).toEqual({ ok: true })
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

test("diagnostic event count and values are bounded", async () => {
  const events: RecordingStartDiagnosticEvent[] = []
  const diagnostic = createRecordingStartDiagnostic(true, (event) => events.push(event))

  for (let index = 0; index < 100; index += 1) diagnostic.observe({ kind: "backend", backend: "native" })
  const blocked = diagnostic.start(() => Promise.resolve({ ok: true }))

  expect(events).toHaveLength(64)
  await expect(blocked).resolves.toEqual({ ok: false, error: "diagnostic-capture-blocked" })
  expect(events.at(-1)).toEqual({ kind: "native-start-blocked" })
  expect(() => diagnostic.observe({ kind: "backend", backend: "raw-device-name" })).not.toThrow()
  expect(JSON.stringify(events)).not.toContain("raw-device-name")
})
