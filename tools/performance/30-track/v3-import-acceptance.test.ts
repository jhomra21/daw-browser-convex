import { expect, test } from "bun:test"
import { assertArchiveSnapshot, controlDurationMs, countMidiNotes, parseBrowserProjectId, quietCapture, recoverQuietTarget, importedProjectTarget, classifyQuietCapture, parseControlMode, matchesControlProjectUrl, selectedProjectCdpTarget, playbackCountersValid } from "./v3-import-acceptance"

test("playback validates post-start native callbacks when baseline host was unavailable", () => {
  expect(playbackCountersValid(null, { callbacks: 1121, rejectedBlocks: 0 })).toBe(true)
  expect(playbackCountersValid({ callbacks: 10, rejectedBlocks: 0 }, { callbacks: 10, rejectedBlocks: 0 })).toBe(false)
})

test("selects only a unique imported-project page CDP target", () => {
  const targets = [
    { id: "blank", type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://127.0.0.1/blank" },
    { id: "project", type: "page", url: "daw://app/?projectId=project%3Aone", webSocketDebuggerUrl: "ws://127.0.0.1/project" },
  ]
  expect(selectedProjectCdpTarget(targets, "project:one")?.id).toBe("project")
  expect(selectedProjectCdpTarget(targets, "project:other")).toBeNull()
  expect(selectedProjectCdpTarget([...targets, targets[1]!], "project:one")).toBeNull()
})

test("recognizes encoded project IDs in browser URL replies", () => {
  expect(matchesControlProjectUrl("daw://app/?projectId=project%3Aone", "project:one")).toBe(true)
  expect(matchesControlProjectUrl("daw://app/?projectId=project%3Aother", "project:one")).toBe(false)
})

test("control modes require a 60-second quiet window without recording", () => {
  expect(parseControlMode("--idle-control")).toBe("idle")
  expect(parseControlMode("--playback-control")).toBe("playback")
  expect(parseControlMode("--ui-control")).toBe("ui")
  expect(parseControlMode("--dsp-control")).toBe("dsp")
  expect(parseControlMode("--dsp-soak")).toBe("dsp-soak")
  expect(parseControlMode("--dsp-recording")).toBe("dsp-recording")
  expect(parseControlMode("--media-recording")).toBe("media-recording")
  expect(parseControlMode("--media-recording-probe")).toBe("media-recording-probe")
  expect(parseControlMode("--media-recording-probe-drop")).toBe("media-recording-probe-drop")
  expect(parseControlMode("--media-recording-probe-drop-no-meters")).toBe("media-recording-probe-drop-no-meters")
  expect(parseControlMode("--media-recording-probe-metadata")).toBe("media-recording-probe-metadata")
  expect(parseControlMode("--media-recording-probe-batch4")).toBe("media-recording-probe-batch4")
  expect(parseControlMode("--media-recording-probe-batch8")).toBe("media-recording-probe-batch8")
  expect(parseControlMode("--media-recording-portable")).toBe("media-recording-portable")
  expect(parseControlMode("--dsp-one-control")).toBe("dsp-one")
  expect(parseControlMode("--quiet-recording")).toBe("recording")
  expect(() => parseControlMode("--unsupported")).toThrow()
})

test("five-minute DSP soak extends only the measured control window", () => {
  expect(controlDurationMs("dsp")).toBe(60_000)
  expect(controlDurationMs("dsp-soak")).toBe(300_000)
})

test("control summary rejects an unresponsive renderer after quiet interval", async () => {
  const steps: string[] = []
  await expect(quietCapture({
    start: async () => { steps.push("start") },
    wait: async () => { steps.push("wait") },
    stop: async () => { steps.push("verify"); throw new Error("renderer-unresponsive") },
    observe: async () => { steps.push("observe") },
  })).rejects.toThrow("renderer-unresponsive")
  expect(steps).toEqual(["start", "wait", "verify"])
})

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
