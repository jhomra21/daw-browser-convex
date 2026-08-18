import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

const preloadPath = new URL("./preload.ts", import.meta.url)
const mainPath = new URL("./main.ts", import.meta.url)
const rendererTypesPath = new URL("../../src/types/desktop-bridge.ts", import.meta.url)

test("exposes only the macOS arm64 typed PCM asset session surface to renderers", async () => {
  const [main, preload, rendererTypes] = await Promise.all([
    readFile(mainPath, "utf8"),
    readFile(preloadPath, "utf8"),
    readFile(rendererTypesPath, "utf8"),
  ])

  expect(main).toContain('process.platform === "darwin"')
  expect(main).toContain('process.arch === "arm64"')
  expect(main).toContain('sameAppOrigin(event.senderFrame.url)')
  expect(main).toContain('"daw:audio-host:loss"')
  expect(preload).toContain('process.platform === "darwin" && process.arch === "arm64"')
  expect(preload).toContain("installAsset")
  expect(preload).toContain("releaseAsset")
  expect(preload).toContain("queueSourceEvents")
  expect(preload).toContain("resolveOutputDevice")
  expect(preload).not.toContain("attachVst")
  expect(preload).toContain("detachVst")
  expect(preload).toContain("Float32Array")
  expect(preload).not.toContain("socket")
  expect(preload).not.toContain("AudioBuffer")
  expect(preload).not.toContain("path")
  expect(preload).not.toContain("canonicalBundlePath")
  expect(preload).not.toContain("canonicalExecutablePath")
  expect(rendererTypes).toContain("audioHost?:")
  expect(rendererTypes).toContain("resolveOutputDevice")
  expect(rendererTypes).toContain("NativeHostPcmAsset")
  expect(rendererTypes).toContain("serializedPlan")
  expect(rendererTypes).not.toContain("AudioEngine")
  expect(main).toContain('sameAppOrigin(event.senderFrame.url)')
  expect(main).toContain('catalogViewForRenderer')
})

test("keeps spectrum selection on the native session envelope contract", async () => {
  const [main, preload] = await Promise.all([
    readFile(mainPath, "utf8"),
    readFile(preloadPath, "utf8"),
  ])

  expect(preload).toContain('setSpectrumNode: (nodeId: bigint | null) => invokeNativeSession("daw:audio-host:session:set-spectrum-node", nodeId)')
  expect(main).toContain('const envelope = nativeSpectrumNodeEnvelopeSchema.safeParse(value)')
  expect(main).toContain('envelope.data.transactionToken !== undefined')
  expect(main).toContain('await supervisor.setSpectrumNode(envelope.data.value)')
  expect(main).not.toContain('[native-spectrum]')
})

test("preserves renderer transport transition IDs through native IPC mapping", async () => {
  const main = await readFile(mainPath, "utf8")

  expect(main).toContain("transitionId: z.bigint().positive().max(0xffff_ffff_ffff_ffffn).optional()")
  expect(main).toContain("transitionId: value.transitionId")
})

test("routes editor commands through the isolated session before the playback host", async () => {
  const main = await readFile(mainPath, "utf8")
  const isolatedRoute = main.indexOf("if (manager) {")
  const playbackRoute = main.indexOf("if (activeHostCandidate) {")

  expect(isolatedRoute).toBeGreaterThanOrEqual(0)
  expect(playbackRoute).toBeGreaterThan(isolatedRoute)
})
