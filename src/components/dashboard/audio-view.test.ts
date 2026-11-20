import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

test("uses the compile-time desktop build flag for native-only audio controls", async () => {
  const source = await readFile(new URL("./audio-view.tsx", import.meta.url), "utf8")

  expect(source).toContain('const requiresNativeAudio = isDesktopRenderer()')
  expect(source).not.toContain("window.dawDesktop?.audioHost")
  expect(source).toContain('<Show when={!requiresNativeAudio} fallback={')
  expect(source).toContain("Native CoreAudio is required in the Electron app.")
  expect(source).toContain('<Show when={!requiresNativeAudio}>')
  expect(source).toContain("Portable Wasm when supported; otherwise Web Audio.")
  expect(source).toContain("audioHost?.listDevices()")
  expect(source).toContain("onSelect={preferences.audio.setNativeInputDeviceId}")
  expect(source).toContain("onSelect={preferences.audio.setNativeOutputDeviceId}")
  expect(source).not.toContain("portableBrowserPlaybackEnabled")
  expect(source).not.toContain("setPortableBrowserPlaybackEnabled")
})
