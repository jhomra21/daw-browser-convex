import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

test("uses the compile-time desktop build flag for native-only audio controls", async () => {
  const source = await readFile(new URL("./audio-view.tsx", import.meta.url), "utf8")

  expect(source).toContain('const requiresNativeAudio = import.meta.env.VITE_DESKTOP === "true"')
  expect(source).not.toContain("window.dawDesktop?.audioHost")
  expect(source).toContain('<Show when={requiresNativeAudio} fallback={')
  expect(source).toContain("Native CoreAudio is required in the Electron app.")
  expect(source).toContain('<Show when={!requiresNativeAudio}>')
})
