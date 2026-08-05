import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

import { shouldUseNativeLiveMidi } from "~/lib/midi/live-midi-backend"

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

test("falls through to browser live MIDI when native start is synchronously unavailable", async () => {
  const source = await readFile(new URL("./useTimelineMidiOverlay.ts", import.meta.url), "utf8")
  const nativeStart = source.slice(
    source.indexOf("const startLiveNote"),
    source.indexOf("  createEffect(() =>", source.indexOf("const startLiveNote")),
  )
  expect(nativeStart).toContain("if (handle) {")
  expect(nativeStart).toContain("options.audioEngine.startLiveMidiNote")
  expect(nativeStart).not.toContain("if (handle) activeLiveNotes.set(pitch, { handle, backend: \"native\" })\n        return")
})

test("replaces same-pitch native auditions without stale timer release", async () => {
  const source = await readFile(new URL("./useTimelineMidiOverlay.ts", import.meta.url), "utf8")
  const audition = source.slice(
    source.indexOf("const auditionNote"),
    source.indexOf("const startLiveNote", source.indexOf("const auditionNote")),
  )
  expect(audition.indexOf("stopLiveNote(pitch)")).toBeLessThan(audition.indexOf("nativeLiveMidi.start"))
  expect(audition).toContain("auditionReleaseTimers.set(handle.noteId, timer)")
  expect(audition).toContain("stopLiveNote(pitch, handle.noteId)")
  expect(source).toContain("const timer = auditionReleaseTimers.get(noteId)")
  expect(source).toContain("for (const timer of auditionReleaseTimers.values()) clearTimeout(timer)")
})

test("native-required MIDI ingress never calls the browser audio engine", async () => {
  const source = await readFile(new URL("./useTimelineMidiOverlay.ts", import.meta.url), "utf8")
  const keyboard = source.slice(
    source.indexOf("const startLiveNote"),
    source.indexOf("  createEffect(() =>", source.indexOf("const startLiveNote")),
  )
  const hardware = source.slice(
    source.indexOf("startNote: (event)"),
    source.indexOf("    releaseNote:", source.indexOf("startNote: (event)")),
  )
  const audition = source.slice(
    source.indexOf("const auditionNote"),
    source.indexOf("const startLiveNote", source.indexOf("const auditionNote")),
  )
  expect(keyboard).toContain("if (requiresNativeAudio)")
  expect(keyboard).toContain("return")
  expect(keyboard.indexOf("if (requiresNativeAudio)")).toBeLessThan(keyboard.indexOf("options.audioEngine.startLiveMidiNote"))
  expect(hardware).toContain("if (requiresNativeAudio)")
  expect(hardware).toContain("return undefined")
  expect(hardware).toContain("options.audioEngine.startLiveMidiNote")
  expect(hardware.indexOf("if (requiresNativeAudio)")).toBeLessThan(hardware.indexOf("options.audioEngine.startLiveMidiNote"))
  expect(audition).toContain("if (requiresNativeAudio)")
  expect(audition).toContain("return")
  expect(audition.indexOf("if (requiresNativeAudio)")).toBeLessThan(audition.indexOf("options.audioEngine.ensureAudio"))
})

test("hardware MIDI falls through when native readiness or handle is unavailable", async () => {
  const source = await readFile(new URL("./useTimelineMidiOverlay.ts", import.meta.url), "utf8")
  const hardwareStart = source.slice(
    source.indexOf("startNote: (event)"),
    source.indexOf("    releaseNote:", source.indexOf("startNote: (event)")),
  )
  expect(hardwareStart).toContain("nativeMidiReady")
  expect(hardwareStart).toContain("if (handle) {")
  expect(hardwareStart).toContain("options.audioEngine.startLiveMidiNote")
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
  expect(source).toContain("stopAllLiveNotes()")
})

test("reconciles router-owned held notes when native preview ownership is rebuilt", async () => {
  const source = await readFile(new URL("./useTimelineMidiOverlay.ts", import.meta.url), "utf8")
  const reset = source.slice(
    source.indexOf("removeNativeLiveMidiReset ="),
    source.indexOf("  const closeMidiEditor", source.indexOf("removeNativeLiveMidiReset =")),
  )
  expect(reset).toContain("stopAllLiveNotes()")
  expect(reset).toContain("hardwareRouter.panic()")
})
