import { expect, mock, test } from "bun:test"
import { readFile } from "node:fs/promises"
import {
  resolveOutputDeviceChannel,
  sessionConfigureRecordingChannel,
  sessionInstallAssetChannel,
  sessionQueueInstrumentEventsChannel,
  sessionQueueParameterEventsChannel,
  sessionQueueProcessorStatePatchChannel,
  sessionSetSpectrumNodeChannel,
  sessionStopRecordingChannel,
} from "@daw-browser/desktop-protocol/ipc-channels"
import type { NativeHostPcmAsset, NativeHostRecordingConfiguration } from "@daw-browser/audio-engine/native-host-wire"
import type { DesktopBridge } from "../../src/types/desktop-bridge"

const mainPath = new URL("./main.ts", import.meta.url)

type IpcEnvelope = { value?: object | bigint | number | string | null; transactionToken?: string }
type Invocation = { channel: string; args: Array<string | IpcEnvelope> }
const invocations: Invocation[] = []
const exposed = new Map<string, DesktopBridge>()
const ipcReply = { ok: true, marker: "from-main" }
mock.module("electron", () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: DesktopBridge) => exposed.set(name, api) },
  ipcRenderer: {
    invoke: (channel: string, ...args: Array<string | IpcEnvelope>) => {
      invocations.push({ channel, args })
      return Promise.resolve(ipcReply)
    },
    send: () => undefined,
    on: () => undefined,
    removeListener: () => undefined,
  },
}))

process.argv.push("--daw-total-memory-bytes=17179869184")

// Each variant is a distinct module instance, so preload re-evaluates its platform gate.
const bridges = new Map<string, DesktopBridge>()
const loadPreload = async (platform: string, arch: string) => {
  const variant = `${platform}-${arch}`
  const cached = bridges.get(variant)
  if (cached) return cached
  const original = { platform: process.platform, arch: process.arch }
  Object.defineProperty(process, "platform", { value: platform, configurable: true })
  Object.defineProperty(process, "arch", { value: arch, configurable: true })
  try {
    const specifier = `./preload.ts?${variant}`
    await import(specifier)
  } finally {
    Object.defineProperty(process, "platform", { value: original.platform, configurable: true })
    Object.defineProperty(process, "arch", { value: original.arch, configurable: true })
  }
  const bridge = exposed.get("dawDesktop")
  if (!bridge) throw new Error("preload did not expose dawDesktop")
  bridges.set(variant, bridge)
  return bridge
}

const darwinAudioHost = async () => {
  const { audioHost } = await loadPreload("darwin", "arm64")
  if (!audioHost) throw new Error("preload did not expose audioHost on macOS arm64")
  return audioHost
}

test("exposes only the macOS arm64 typed PCM asset session surface to renderers", async () => {
  const audioHost = await darwinAudioHost()
  expect(Object.keys(audioHost.session)).toEqual(expect.arrayContaining(["installAsset", "releaseAsset", "queueSourceEvents", "detachVst"]))
  expect(Object.keys(audioHost.session)).not.toContain("attachVst")
  expect(Object.keys(await loadPreload("darwin", "arm64")).filter((key) => /socket/i.test(key))).toEqual([])

  invocations.length = 0
  await audioHost.resolveOutputDevice("device-1")
  expect(invocations).toEqual([{ channel: resolveOutputDeviceChannel, args: ["device-1"] }])

  for (const [platform, arch] of [["linux", "arm64"], ["darwin", "x64"], ["win32", "x64"]]) {
    expect((await loadPreload(platform, arch)).audioHost).toBeUndefined()
  }
})

test("sends each native session call as a channel envelope with its transaction token and returns the main reply", async () => {
  const { session } = await darwinAudioHost()
  const bytes = new Uint8Array([1, 2, 3])
  const token = "18446744073709551615"
  const asset: NativeHostPcmAsset = { sessionAssetId: 7, frameCount: 1, sampleRateHz: 48_000, channelCount: 1, planarPcm: new Uint8Array(4) }
  const calls: Array<[() => Promise<object>, string, object]> = [
    [() => session.installAsset(asset, token), sessionInstallAssetChannel, asset],
    [() => session.queueProcessorStatePatch(bytes, token), sessionQueueProcessorStatePatchChannel, bytes],
    [() => session.queueParameterEvents(bytes, token), sessionQueueParameterEventsChannel, bytes],
    [() => session.queueInstrumentEvents(bytes, token), sessionQueueInstrumentEventsChannel, bytes],
  ]
  for (const [call, channel, value] of calls) {
    invocations.length = 0
    expect(await call()).toBe(ipcReply)
    expect(invocations).toEqual([{ channel, args: [{ value, transactionToken: token }] }])
  }
})

test("keeps spectrum selection on the native session envelope contract", async () => {
  const { session } = await darwinAudioHost()
  for (const nodeId of [5n, null]) {
    invocations.length = 0
    await session.setSpectrumNode(nodeId)
    expect(invocations).toEqual([{ channel: sessionSetSpectrumNodeChannel, args: [{ value: nodeId, transactionToken: undefined }] }])
  }
})

test("routes recording configure and stop through native session envelopes", async () => {
  const { session } = await darwinAudioHost()
  const input: NativeHostRecordingConfiguration & { spoolImportVersion: 1 } = {
    projectId: "project", deviceUid: "device", generation: 1, sessionId: 1n, channelCount: 2, inputChannels: [0, 1],
    gain: 1, polarity: 1, punchStartFrame: 0, punchEndFrame: null, monitoring: false, spoolImportVersion: 1,
  }
  invocations.length = 0
  await session.configureRecording(input)
  expect(invocations).toEqual([{ channel: sessionConfigureRecordingChannel, args: [{ value: input, transactionToken: undefined }] }])
  for (const stopFrame of [12, undefined]) {
    invocations.length = 0
    await session.stopRecording(stopFrame)
    expect(invocations).toEqual([{ channel: sessionStopRecordingChannel, args: [{ value: stopFrame, transactionToken: undefined }] }])
  }
})

test("gates the native session IPC to the macOS arm64 app origin", async () => {
  const main = await readFile(mainPath, "utf8")

  expect(main).toContain('process.platform === "darwin"')
  expect(main).toContain('process.arch === "arm64"')
  expect(main).toContain('sameAppOrigin(event.senderFrame.url)')
  expect(main).toContain('sendRendererMessage(lossChannel, error)')
  expect(main).toContain('catalogViewForRenderer')
})

test("preserves bounded native request diagnostics through session IPC", async () => {
  const [main, audioHost] = await Promise.all([
    readFile(mainPath, "utf8"),
    readFile(new URL("./audio-host.ts", import.meta.url), "utf8"),
  ])

  expect(audioHost).toContain("requestName")
  expect(main).toContain("error.requestName")
  expect(main).toContain('error.requestName === "instrumentStates" ? ` ${error.message.slice(0, 256)}`')
  expect(main).toContain("thrown instanceof NativeAudioHostCommandError ? thrown : undefined")
  expect(main).toContain("kind: nativeDeliveryFailureKind(thrown)")
})

test("classifies a failed revision command by its type, never dropping the thrown error", async () => {
  const main = await readFile(mainPath, "utf8")
  const handler = main.slice(main.indexOf("for (const [operation, channel] of Object.entries(revisionChannels))"))
  const revisionHandler = handler.slice(0, handler.indexOf("registerNativeSessionBytes(sessionPublishGraphChannel"))

  // A refused, unavailable or lost reply keeps its kind: the renderer classifies the publication from it.
  expect(revisionHandler).toContain("} catch (error) { return nativeSessionFailure(error) }")
  expect(revisionHandler).not.toContain("catch { return nativeSessionFailure() }")
  // The command ran, but this renderer no longer owns the result: it may have been taken.
  expect(revisionHandler).toContain("return nativeSessionFailure(new Error(")
})

test("carries the processor patch status and its decimal token to the renderer unchanged", async () => {
  const main = await readFile(mainPath, "utf8")

  expect(main).toContain("nativeProcessorPatchReply(await supervisor.queueProcessorStatePatch(")
})

test("validates the spectrum selection envelope in the main process", async () => {
  const main = await readFile(mainPath, "utf8")

  expect(main).toContain('const envelope = nativeSpectrumNodeEnvelopeSchema.safeParse(value)')
  expect(main).toContain('envelope.data.transactionToken !== undefined')
  expect(main).toContain('await supervisor.setSpectrumNode(envelope.data.value)')
  expect(main).not.toContain('[native-spectrum]')
})

test("validates recording IPC through production native session envelopes in the main process", async () => {
  const main = await readFile(mainPath, "utf8")

  const configureStart = main.indexOf('ipcMain.handle(sessionConfigureRecordingChannel')
  const stopStart = main.indexOf('ipcMain.handle(sessionStopRecordingChannel')
  const controlStart = main.indexOf("  const registerNativeSessionControl", stopStart)
  const configureHandler = main.slice(configureStart, stopStart)
  const stopHandler = main.slice(stopStart, controlStart)

  expect(configureHandler).toContain("nativeSessionEnvelopeSchema(nativeSessionRecordingConfigurationSchema).safeParse(value)")
  expect(configureHandler).toContain("envelope.data.transactionToken !== undefined")
  expect(configureHandler).toContain("nativeSessionRecordingConfiguration(envelope.data.value)")
  expect(configureHandler).toContain("await supervisor.configureRecording(configuration, { rootPath: take.rootPath")
  expect(configureHandler).not.toContain("nativeSessionRecordingConfigurationSchema.safeParse(value)")

  expect(stopHandler).toContain("nativeSessionEnvelopeSchema(z.number().int().safe().min(0).optional()).safeParse(value)")
  expect(stopHandler).toContain("envelope.data.transactionToken !== undefined")
  expect(stopHandler).toContain("await supervisor.stopRecording(envelope.data.value)")
  expect(stopHandler).not.toContain("const endFrame = z.number().int().safe().min(0).optional().safeParse(value)")
})

test("preserves renderer transport transition IDs through native IPC mapping", async () => {
  const main = await readFile(mainPath, "utf8")

  expect(main).toContain("transitionId: z.bigint().positive().max(0xffff_ffff_ffff_ffffn).optional()")
  expect(main).toContain("transitionId: value.transitionId")
})

test("scopes configuration identity to each native host process generation", async () => {
  const main = await readFile(mainPath, "utf8")
  expect(main).toContain("const configurationGeneration = currentGeneration + 1")
  expect(main).toContain("configuredHost = nativeHostConfigurationIdentityFor(configuredHost, host)")
})

test("routes editor commands through the isolated session before the playback host", async () => {
  const main = await readFile(mainPath, "utf8")
  const isolatedRoute = main.indexOf("if (manager) {")
  const playbackRoute = main.indexOf("if (activeHostCandidate) {")

  expect(isolatedRoute).toBeGreaterThanOrEqual(0)
  expect(playbackRoute).toBeGreaterThan(isolatedRoute)
})

test("commits renderer navigation before native transaction registration", async () => {
  const main = await readFile(mainPath, "utf8")
  const didNavigate = main.indexOf('window_.webContents.on("did-navigate"')
  const didFailLoad = main.indexOf('window_.webContents.on("did-fail-load"', didNavigate)
  const navigationHandler = main.slice(didNavigate, didFailLoad)
  expect(didNavigate).toBeGreaterThanOrEqual(0)
  expect(navigationHandler).toContain("rendererLifecycle.commitMainFrameNavigation(url)")
  expect(navigationHandler).not.toContain("activateInitialCommittedDocument")
  expect(main).toContain('ipcMain.handle(sessionBeginTransactionChannel')
})
