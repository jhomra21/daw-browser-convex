import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

import { shouldUseNativeLiveMidi } from "~/lib/midi/live-midi-backend"
import { createAuditionReleaseTimerOwnership } from "~/lib/audition-release-timer-ownership"

const nativeLiveMidi = (active: boolean, available: boolean) => ({
  isActive: () => active,
  isAvailable: () => available,
  start: () => undefined,
  stop: () => undefined,
})

test("keeps native live MIDI selected while native startup is pending", () => {
  expect(shouldUseNativeLiveMidi(nativeLiveMidi(false, false))).toBeFalse()
  expect(shouldUseNativeLiveMidi(nativeLiveMidi(false, true))).toBeTrue()
  expect(shouldUseNativeLiveMidi(nativeLiveMidi(true, false))).toBeTrue()
  expect(shouldUseNativeLiveMidi(nativeLiveMidi(true, true))).toBeTrue()
})

test("keeps browser live MIDI as the fallback when native is unavailable", () => {
  expect(shouldUseNativeLiveMidi(nativeLiveMidi(false, false))).toBeFalse()
  expect(shouldUseNativeLiveMidi(undefined)).toBeFalse()
})

test("routes all live MIDI through the shared arpeggiator before backend dispatch", async () => {
  const source = await readFile(new URL("./useTimelineMidiOverlay.ts", import.meta.url), "utf8")
  expect(source).toContain("createLiveMidiArpeggiator")
  expect(source).toContain("liveArpeggiator.noteOn")
  expect(source).toContain("liveArpeggiator.noteOff")
})

test("owns audition release timers by pitch when source IDs collide", () => {
  const callbacks = new Map<number, () => void>()
  const cleared: number[] = []
  let nextTimer = 1
  const ownership = createAuditionReleaseTimerOwnership({
    schedule: (callback) => {
      const timer = nextTimer
      nextTimer += 1
      callbacks.set(timer, callback)
      return timer
    },
    clear: (timer) => {
      cleared.push(timer)
      callbacks.delete(timer)
    },
  })
  const releases: string[] = []
  const firstArpeggiator = { noteOff: (handle: number) => releases.push(`first:${handle}`) }
  const secondArpeggiator = { noteOff: (handle: number) => releases.push(`second:${handle}`) }
  ownership.schedule(60, 100, () => firstArpeggiator.noteOff(1))
  ownership.schedule(64, 200, () => secondArpeggiator.noteOff(1))

  callbacks.get(1)?.()
  expect(releases).toEqual(["first:1"])
  expect(ownership.has(60)).toBeFalse()
  expect(ownership.has(64)).toBeTrue()

  callbacks.get(2)?.()
  expect(releases).toEqual(["first:1", "second:1"])
  expect(ownership.size()).toBe(0)
  expect(cleared).toEqual([])
})

test("replacing an audition pitch cancels its prior bounded release", () => {
  const callbacks = new Map<number, () => void>()
  const cleared: number[] = []
  let nextTimer = 1
  const ownership = createAuditionReleaseTimerOwnership({
    schedule: (callback) => {
      const timer = nextTimer
      nextTimer += 1
      callbacks.set(timer, callback)
      return timer
    },
    clear: (timer) => {
      cleared.push(timer)
      callbacks.delete(timer)
    },
  })
  const releases: string[] = []
  ownership.schedule(60, 100, () => releases.push("first"))
  ownership.cancel(60)
  ownership.schedule(60, 100, () => releases.push("second"))
  callbacks.get(1)?.()
  expect(releases).toEqual([])
  callbacks.get(2)?.()
  expect(releases).toEqual(["second"])
  expect(cleared).toEqual([1])
  expect(ownership.size()).toBe(0)
})

test("native-required MIDI ingress stays silent while native preparation is pending", async () => {
  const source = await readFile(new URL("./useTimelineMidiOverlay.ts", import.meta.url), "utf8")
  const audition = source.slice(
    source.indexOf("const auditionNote"),
    source.indexOf("const startLiveNote", source.indexOf("const auditionNote")),
  )
  expect(source).toContain("if (requiresNativeAudio)")
  expect(source).toContain("options.audioEngine.startLiveMidiNote")
  expect(source).not.toContain("Native MIDI unavailable")
  expect(audition.indexOf("if (requiresNativeAudio)")).toBeLessThan(audition.indexOf("options.audioEngine.ensureAudio"))
})

test("hardware MIDI falls through when native readiness or handle is unavailable", async () => {
  const source = await readFile(new URL("./useTimelineMidiOverlay.ts", import.meta.url), "utf8")
  const hardwareStart = source.slice(
    source.indexOf("startNote: (event)"),
    source.indexOf("    releaseNote:", source.indexOf("startNote: (event)")),
  )
  expect(hardwareStart).toContain("liveArpeggiator.noteOn")
})

test("only suspended lifecycle blocks MIDI and lifecycle readiness gates native MIDI", async () => {
  const source = await readFile(new URL("./useTimelineMidiOverlay.ts", import.meta.url), "utf8")
  expect(source).toContain("let midiSuspended = false")
  expect(source).toContain("nativeMidiReady = lifecycle.state === \"ready\"")
  expect(source).toContain("if (midiSuspended) return")
})

test("keeps editor close separate from live-note safety cleanup", async () => {
  const source = await readFile(new URL("./useTimelineMidiOverlay.ts", import.meta.url), "utf8")
  expect(source).not.toContain("if (!midiEditorClipId())")
  expect(source).toContain("forceStopAllLiveNotes()")
})

test("reconciles router-owned held notes when native preview ownership is rebuilt", async () => {
  const source = await readFile(new URL("./useTimelineMidiOverlay.ts", import.meta.url), "utf8")
  const reset = source.slice(
    source.indexOf("removeNativeLiveMidiReset ="),
    source.indexOf("  const closeMidiEditor", source.indexOf("removeNativeLiveMidiReset =")),
  )
  expect(reset).toContain("forceStopAllLiveNotes()")
})

test("resets live ownership on target and arpeggiator configuration changes", async () => {
  const source = await readFile(new URL("./useTimelineMidiOverlay.ts", import.meta.url), "utf8")
  expect(source).toContain("options.projectId()")
  expect(source).toContain("resolveTargetTrackId()")
  expect(source).toContain("liveArpeggiator.panic()")
  expect(source).toContain("options.audioEngine.subscribeArpeggiator")
  expect(source).toContain("liveArpeggiator.configure()")
})

test("scopes arpeggiator notifications and force-cleans lifecycle ownership", async () => {
  const source = await readFile(new URL("./useTimelineMidiOverlay.ts", import.meta.url), "utf8")
  expect(source).toContain("subscribeArpeggiator((trackId)")
  expect(source).toContain("if (untrack(resolveTargetTrackId) !== trackId) return")
  expect(source).toContain("forceStopAllLiveNotes()")
  expect(source).toContain("if (lifecycle.state === \"suspended\")")
})

test("retains held live sources for same-target arp and BPM changes", async () => {
  const source = await readFile(new URL("./useTimelineMidiOverlay.ts", import.meta.url), "utf8")
  expect(source).toContain("liveArpeggiator.configure()")
  expect(source).toContain("options.bpm()")
  expect(source).toContain("if (liveTargetKey !== undefined && liveTargetKey !== targetKey)")
  expect(source).not.toContain("forceStopAllLiveNotes()\n    liveArpeggiator.configure()")
})
