import { expect, test } from "bun:test"
import { assertArchiveSnapshot, countMidiNotes, parseBrowserProjectId, quietCapture, recoverQuietTarget, importedProjectTarget, classifyQuietCapture } from "./v3-import-acceptance"

test("classifies live but unresponsive renderer without calling it", () => {
  expect(classifyQuietCapture({ mainAlive: true, rendererAlive: true, targetFound: true,
    stopPresent: null, stopSucceeded: false, rendererFailure: false })).toBe("renderer-unresponsive")
  expect(classifyQuietCapture({ mainAlive: true, rendererAlive: false, targetFound: false,
    stopPresent: null, stopSucceeded: false, rendererFailure: true })).toBe("renderer-gone")
  expect(classifyQuietCapture({ mainAlive: true, rendererAlive: true, targetFound: true,
    stopPresent: false, stopSucceeded: false, rendererFailure: false })).toBe("recording-ended-before-stop")
})

test("reconnect selects only the mounted imported project, never about:blank", () => {
  const tabs = "[t1] about:blank\n[t2] daw://app/?projectId=project:expected\n[t3] daw://app/?projectId=project:other"
  expect(importedProjectTarget(tabs, "project:expected")).toBe("t2")
  expect(importedProjectTarget(tabs, "project:absent")).toBeNull()
})

test("lost browser session reconnects to the verified app target", async () => {
  const events: string[] = []
  const result = await recoverQuietTarget({
    original: async () => { events.push("original"); throw new Error("session lost") },
    reconnect: async () => { events.push("reconnect"); return "daw://app/?projectId=project:one" },
  })
  expect(result).toEqual({ recovered: true, url: "daw://app/?projectId=project:one" })
  expect(events).toEqual(["original", "reconnect"])
})

test("target recovery refuses an unrelated or blank renderer", async () => {
  await expect(recoverQuietTarget({
    original: async () => { throw new Error("session lost") },
    reconnect: async () => "about:blank",
  })).rejects.toThrow("Verified app target unavailable")
})

test("quiet capture performs no observations between start and explicit stop", async () => {
  const events: string[] = []
  await quietCapture({
    start: async () => { events.push("start") },
    wait: async () => { events.push("wait") },
    stop: async () => { events.push("stop") },
    observe: async () => { events.push("observe") },
  })
  expect(events).toEqual(["start", "wait", "stop", "observe"])
})

test("decodes browser JSON project ID before public host command", () => {
  expect(parseBrowserProjectId(JSON.stringify(JSON.stringify("project:12345678-1234-1234-1234-123456789abc"))))
    .toBe("project:12345678-1234-1234-1234-123456789abc")
})

test("counts MIDI notes in actual snapshot clip shape", () => {
  expect(countMidiNotes([
    { midi: { notes: [{ beat: 0 }, { beat: 1 }] } },
    { midi: { notes: [{ beat: 0 }] } },
    {},
  ])).toBe(3)
})

test("rejects an unparsed v3 snapshot at the API boundary", () => {
  expect(() => assertArchiveSnapshot(null)).toThrow()
})
