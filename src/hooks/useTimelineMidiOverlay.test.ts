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

test("keeps editor close separate from live-note safety cleanup", async () => {
  const source = await readFile(new URL("./useTimelineMidiOverlay.ts", import.meta.url), "utf8")
  expect(source).not.toContain("if (!midiEditorClipId())")
  expect(source).toContain("stopAllLiveNotes()")
})
