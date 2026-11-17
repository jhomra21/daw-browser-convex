import { expect, mock, test } from "bun:test"
import {
  applicationMenuCommandChannel,
  applicationMenuStateChannel,
  listDevicesChannel,
  resolveOutputDeviceChannel,
  sessionConfigureRecordingChannel,
  sessionInspectGraphRevisionChannel,
  sessionInstallAssetChannel,
  sessionPrepareGraphRevisionChannel,
  sessionPublishGraphRevisionChannel,
  sessionQueueInstrumentEventsChannel,
  sessionQueueParameterEventsChannel,
  sessionQueueProcessorStatePatchChannel,
  sessionRetireGraphRevisionChannel,
  sessionRollbackGraphRevisionChannel,
  sessionSetSpectrumNodeChannel,
  sessionSetTransportChannel,
  sessionStartRecordingChannel,
  sessionStopRecordingChannel,
} from "@daw-browser/desktop-protocol/ipc-channels"
import { nativeAudioHostControlTypes, type NativeRecordingSpoolImportVersion } from "@daw-browser/desktop-protocol/native-audio-host"
import type { NativeHostPcmAsset, NativeHostRecordingConfiguration } from "@daw-browser/audio-engine/native-host-wire"
import type { IpcRenderer, IpcRendererEvent } from "electron"
import type { DesktopApplicationMenuMessage, DesktopApplicationMenuState } from "@daw-browser/desktop-protocol/application-menu"
import type { DesktopBridge } from "../../src/types/desktop-bridge"
import {
  NativeAudioHostCommandError,
  nativeHostConfigurationIdentityFor,
  nativeProcessorPatchReply,
  nativeSessionFailure,
} from "./audio-host"
import { NativeAudioHostNotSentError } from "./native-request-broker"
import { nativeEditorCommand } from "../../src/components/timeline/external-plugin-editor"
import { nativeEditorCommandSchema } from "./native-session-schemas"
import { createRendererLifecycleOwner } from "./renderer-lifecycle"
import { registerNativeSessionTransportIpc } from "./ipc/native-session-transport-ipc"
import { registerNativeSessionRecordingIpc } from "./ipc/native-session-recording-ipc"
import type { RecordingSessionOwner } from "./ipc/native-session-recording-ipc"
import { nativeSessionRequestAllowed } from "./ipc/native-session-access"
import type { NativeSessionEvent, NativeSessionIpcHandler } from "./ipc/native-session-access"

type IpcEnvelope = { value?: object | bigint | number | string | null; transactionToken?: string }
type Invocation = { channel: string; args: Array<string | IpcEnvelope> }
const invocations: Invocation[] = []
const exposed = new Map<string, DesktopBridge>()
const ipcReply = { ok: true, marker: "from-main" }
const sentToMain: Array<Parameters<IpcRenderer["send"]>> = []
const rendererListeners = new Map<string, Parameters<IpcRenderer["on"]>[1]>()
mock.module("electron", () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: DesktopBridge) => exposed.set(name, api) },
  ipcRenderer: {
    invoke: (channel: string, ...args: Array<string | IpcEnvelope>) => {
      invocations.push({ channel, args })
      return Promise.resolve(ipcReply)
    },
    send: (...args: Parameters<IpcRenderer["send"]>) => { sentToMain.push(args) },
    on: (channel: string, listener: Parameters<IpcRenderer["on"]>[1]) => { rendererListeners.set(channel, listener) },
    removeListener: (channel: string, listener: Parameters<IpcRenderer["on"]>[1]) => {
      if (rendererListeners.get(channel) === listener) rendererListeners.delete(channel)
    },
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

  invocations.length = 0
  await audioHost.listDevices()
  expect(invocations).toEqual([{ channel: listDevicesChannel, args: [] }])

  for (const [platform, arch] of [["linux", "arm64"], ["darwin", "x64"], ["win32", "x64"]]) {
    expect((await loadPreload(platform, arch)).audioHost).toBeUndefined()
  }
})

test("the preload forwards only schema-valid application menu messages and state, and unsubscribes its listener", async () => {
  const { applicationMenu } = await loadPreload("darwin", "arm64")
  if (!applicationMenu) throw new Error("preload did not expose applicationMenu")
  const state: DesktopApplicationMenuState = {
    ready: true, canExportArchive: false, canUndo: false, canRedo: false, canCut: false, canCopy: false,
    canPaste: false, canSelectAll: false, canDuplicateSelection: false, canDeleteSelection: false,
    editableFocused: false, signedIn: false, metronomeEnabled: false, loopEnabled: false, gridEnabled: false,
    followEnabled: false, syncMix: false, gridDenominator: 4,
  }
  const event: IpcRendererEvent = Object.create(null)

  sentToMain.length = 0
  applicationMenu.setState(JSON.parse(JSON.stringify({ ...state, ready: "yes" })))
  expect(sentToMain).toEqual([])
  applicationMenu.setState(state)
  expect(sentToMain).toEqual([[applicationMenuStateChannel, state]])

  const received: DesktopApplicationMenuMessage[] = []
  const unsubscribe = applicationMenu.onCommand((command) => received.push(command))
  const deliver = rendererListeners.get(applicationMenuCommandChannel)
  if (!deliver) throw new Error("onCommand did not subscribe to the menu command channel")
  deliver(event, "not-a-command")
  deliver(event, "undo")
  expect(received).toEqual(["undo"])
  unsubscribe()
  expect(rendererListeners.has(applicationMenuCommandChannel)).toBe(false)
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

test("sends each revision call to its own channel with the input unchanged", async () => {
  const { session } = await darwinAudioHost()
  const request = { projectId: "project", revision: 3, hostGeneration: 2 }
  const prepare = { projectId: "project", bytes: new Uint8Array([1]), projectRevision: 4 }
  const calls: Array<[() => Promise<object>, string, object]> = [
    [() => session.revisions.prepare(prepare), sessionPrepareGraphRevisionChannel, prepare],
    [() => session.revisions.publish(request), sessionPublishGraphRevisionChannel, request],
    [() => session.revisions.inspect(request), sessionInspectGraphRevisionChannel, request],
    [() => session.revisions.rollback(request), sessionRollbackGraphRevisionChannel, request],
    [() => session.revisions.retire(request), sessionRetireGraphRevisionChannel, request],
  ]
  for (const [call, channel, input] of calls) {
    invocations.length = 0
    expect(await call()).toBe(ipcReply)
    expect(invocations).toEqual([{ channel, args: [input] }])
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
  const input: NativeHostRecordingConfiguration & { spoolImportVersion: NativeRecordingSpoolImportVersion } = {
    projectId: "project", deviceUid: "device", generation: 1, sessionId: 1n, channelCount: 2, inputChannels: [0, 1],
    gain: 1, polarity: 1, punchStartFrame: 0, punchEndFrame: null, monitoring: false, targetNodeId: 1n, spoolImportVersion: 1,
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

test("gates registered native session IPC to the macOS arm64 app origin", async () => {
  const handlers = new Map<string, NativeSessionIpcHandler>()
  const spectrumCalls: Array<bigint | null> = []
  let platform = "darwin"
  let architecture = "arm64"
  registerNativeSessionTransportIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    allowed: (event) => nativeSessionRequestAllowed({
      platform,
      architecture,
      rendererId: 7,
      acceptsPrivilegedRequests: true,
      event,
      sameAppOrigin: (url) => url.startsWith("daw://app/"),
    }),
    supervisor: () => ({ setSpectrumNode: async (nodeId) => { spectrumCalls.push(nodeId) }, setTransport: async () => undefined }),
    fail: nativeSessionFailure,
  })

  const handler = handlers.get(sessionSetSpectrumNodeChannel)
  if (!handler) throw new Error("Spectrum handler was not registered")
  const mainFrame = { url: "daw://app/index.html" }
  const validEvent = { sender: { id: 7, mainFrame }, senderFrame: mainFrame }
  expect(await handler(validEvent, { value: 9n, transactionToken: undefined })).toEqual({ ok: true })
  expect(await handler({ sender: { id: 7, mainFrame }, senderFrame: { url: "https://example.test" } }, { value: 10n, transactionToken: undefined }))
    .toEqual(nativeSessionFailure())
  expect(await handler({ sender: { id: 8, mainFrame }, senderFrame: validEvent.senderFrame }, { value: 11n, transactionToken: undefined }))
    .toEqual(nativeSessionFailure())
  expect(await handler({ sender: { id: 7, mainFrame }, senderFrame: { url: "daw://app/frame" } }, { value: 14n, transactionToken: undefined }))
    .toEqual({ ok: true })
  platform = "linux"
  expect(await handler(validEvent, { value: 12n, transactionToken: undefined })).toEqual(nativeSessionFailure())
  platform = "darwin"
  architecture = "x64"
  expect(await handler(validEvent, { value: 13n, transactionToken: undefined })).toEqual(nativeSessionFailure())
  expect(spectrumCalls).toEqual([9n, 14n])
})

test("a failed native request keeps its bounded diagnostic only when its request allows one", () => {
  const rejected = new NativeAudioHostCommandError(nativeAudioHostControlTypes.instrumentStates, "x".repeat(300))
  expect(nativeSessionFailure(rejected)).toEqual({
    ok: false,
    kind: "refused",
    error: `The native audio session rejected instrumentStates request ${nativeAudioHostControlTypes.instrumentStates}. ${"x".repeat(256)}`,
  })
  expect(nativeSessionFailure(new NativeAudioHostCommandError(nativeAudioHostControlTypes.deviceConfigure, "private native text"))).toEqual({
    ok: false,
    kind: "refused",
    error: `The native audio session rejected deviceConfigure request ${nativeAudioHostControlTypes.deviceConfigure}.`,
  })
})

test("classifies a failed revision command by its type, never dropping the thrown error", () => {
  const unavailable = "The native audio session is unavailable."
  // Nothing was sent, native said nothing could be done, or the reply never came: each keeps its own kind.
  expect(nativeSessionFailure()).toEqual({ ok: false, kind: "unavailable", error: unavailable })
  expect(nativeSessionFailure(new NativeAudioHostNotSentError("not sent"))).toEqual({ ok: false, kind: "unavailable", error: unavailable })
  expect(nativeSessionFailure(new Error("lost reply"))).toEqual({ ok: false, kind: "unconfirmed", error: unavailable })
  expect(nativeSessionFailure(new NativeAudioHostCommandError(nativeAudioHostControlTypes.deviceConfigure, undefined, "unavailable")).kind)
    .toBe("unavailable")
})

test("carries the processor patch status and its decimal token to the renderer unchanged", () => {
  expect(nativeProcessorPatchReply({ outcome: "claimed", token: 9007199254740993n }))
    .toEqual({ ok: true, outcome: "claimed", token: "9007199254740993" })
  expect(nativeProcessorPatchReply({ outcome: "applied" })).toEqual({ ok: true, outcome: "applied" })
})

test("validates spectrum selection through the registered native session handler", async () => {
  const handlers = new Map<string, NativeSessionIpcHandler>()
  const calls: Array<bigint | null> = []
  registerNativeSessionTransportIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    allowed: () => true,
    supervisor: () => ({ setSpectrumNode: async (nodeId) => { calls.push(nodeId) }, setTransport: async () => undefined }),
    fail: nativeSessionFailure,
  })
  const handler = handlers.get(sessionSetSpectrumNodeChannel)
  if (!handler) throw new Error("Spectrum handler was not registered")
  const mainFrame = { url: "daw://app/index.html" }
  const event = { sender: { id: 1, mainFrame }, senderFrame: mainFrame }

  expect(await handler(event, { value: 42n, transactionToken: undefined })).toEqual({ ok: true })
  expect(await handler(event, { value: 42n, transactionToken: "A".repeat(43) })).toEqual(nativeSessionFailure())
  expect(await handler(event, { value: "42", transactionToken: undefined })).toEqual(nativeSessionFailure())
  expect(calls).toEqual([42n])
})

test("validates recording envelopes through the registered production handlers", async () => {
  const handlers = new Map<string, NativeSessionIpcHandler>()
  const calls: Array<{ kind: string; input: unknown }> = []
  const owner: RecordingSessionOwner = {
    configure: async (_context, _supervisor, request) => {
      calls.push({ kind: "configure", input: request })
      return request === undefined ? nativeSessionFailure() : { ok: true, takeId: "123e4567-e89b-12d3-a456-426614174000", sampleRateHz: 48_000, channelCount: 2 }
    },
    start: async (_context, _supervisor, request) => {
      calls.push({ kind: "start", input: request })
      return request === undefined ? nativeSessionFailure() : { ok: true }
    },
    stop: async (_context, _supervisor, request) => {
      calls.push({ kind: "stop", input: request })
      return request === undefined ? nativeSessionFailure() : { ok: true }
    },
  }
  registerNativeSessionRecordingIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    allowed: () => true,
    supervisor: () => ({
      configureRecording: async () => { throw new Error("not called") },
      startRecording: async () => { throw new Error("not called") },
      stopRecording: async () => { throw new Error("not called") },
      waitForRecordingOutcome: async () => { throw new Error("not called") },
      recordingAdmissionAvailable: () => true,
    }),
    owner,
    rendererGeneration: () => 3,
    hostGeneration: () => 4,
    fail: nativeSessionFailure,
  })
  const configure = handlers.get(sessionConfigureRecordingChannel)
  const start = handlers.get(sessionStartRecordingChannel)
  const stop = handlers.get(sessionStopRecordingChannel)
  if (!configure || !start || !stop) throw new Error("Recording handlers were not registered")
  const mainFrame = { url: "daw://app/index.html" }
  const event: NativeSessionEvent = { sender: { id: 1, mainFrame }, senderFrame: mainFrame }
  const configuration: NativeHostRecordingConfiguration & { spoolImportVersion: NativeRecordingSpoolImportVersion } = {
    projectId: "project", projectGeneration: 2, deviceUid: "device", generation: 3, sessionId: 4n,
    channelCount: 2, inputChannels: [0, 1], gain: 1, polarity: 1, punchStartFrame: 0,
    punchEndFrame: null, monitoring: false, targetNodeId: 1n, spoolImportVersion: 1,
  }
  expect(await configure(event, { value: configuration, transactionToken: undefined })).toEqual({
    ok: true, takeId: "123e4567-e89b-12d3-a456-426614174000", sampleRateHz: 48_000, channelCount: 2,
  })
  expect(await configure(event, { value: configuration, transactionToken: "A".repeat(43) })).toEqual(nativeSessionFailure())
  expect(await start(event, { value: { projectId: "project", projectGeneration: 2, generation: 3, sessionId: 4n }, transactionToken: undefined }))
    .toEqual({ ok: true })
  expect(await stop(event, { value: 12, transactionToken: undefined })).toEqual({ ok: true })
  expect(await stop(event, { value: 12, transactionToken: "A".repeat(43) })).toEqual(nativeSessionFailure())
  expect(calls).toEqual([
    { kind: "configure", input: { configuration: { projectId: "project", projectGeneration: 2, deviceUid: "device", generation: 3,
      sessionId: 4n, channelCount: 2, inputChannels: [0, 1], gain: 1, polarity: 1, punchStartFrame: 0,
      punchEndFrame: null, monitoring: false, targetNodeId: 1n }, projectId: "project", projectGeneration: 2, spoolImportVersion: 1 } },
    { kind: "configure", input: undefined },
    { kind: "start", input: { projectId: "project", projectGeneration: 2, generation: 3, sessionId: 4n } },
    { kind: "stop", input: { endFrame: 12 } },
    { kind: "stop", input: undefined },
  ])
})

test("maps registered native transport handlers with transition IDs intact", async () => {
  const handlers = new Map<string, NativeSessionIpcHandler>()
  const calls: unknown[] = []
  registerNativeSessionTransportIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    allowed: () => true,
    supervisor: () => ({
      setSpectrumNode: async () => undefined,
      setTransport: async (transport, token) => { calls.push({ transport, token }) },
    }),
    fail: nativeSessionFailure,
  })
  const handler = handlers.get(sessionSetTransportChannel)
  if (!handler) throw new Error("Transport handler was not registered")
  const transitionId = 9_007_199_254_740_993n
  const transport = { epoch: 1, running: true, frame: 10, transitionId }
  const mainFrame = { url: "daw://app/index.html" }
  expect(await handler({ sender: { id: 1, mainFrame }, senderFrame: mainFrame }, {
    value: transport, transactionToken: undefined,
  })).toEqual({ ok: true })
  expect(calls).toEqual([{ transport: { ...transport, bpm: undefined, timeSignatureNumerator: undefined,
    timeSignatureDenominator: undefined, cycleActive: undefined, cycleStartSec: undefined, cycleEndSec: undefined }, token: undefined }])
})

test("scopes configuration identity to each native host process generation", () => {
  const first = nativeHostConfigurationIdentityFor(undefined, { pid: 10, generation: 1 })
  expect(first).toEqual({ pid: 10, generation: 1, configurationGeneration: 0 })
  const advanced = { pid: 10, generation: 1, configurationGeneration: 4 }
  expect(nativeHostConfigurationIdentityFor(advanced, { pid: 10, generation: 1 })).toBe(advanced)
  expect(nativeHostConfigurationIdentityFor(advanced, { pid: 10, generation: 2 })).toEqual({ pid: 10, generation: 2, configurationGeneration: 0 })
  expect(nativeHostConfigurationIdentityFor(advanced, { pid: 11, generation: 1 })).toEqual({ pid: 11, generation: 1, configurationGeneration: 0 })
  expect(nativeHostConfigurationIdentityFor(advanced, { generation: 1 })).toBeUndefined()
})


test("navigation commit activates the privileged native session IPC", async () => {
  const rendererLifecycle = createRendererLifecycleOwner()
  const mainFrame = { url: "daw://app/project" }
  const handlers = new Map<string, NativeSessionIpcHandler>()
  const spectrumCalls: Array<bigint | null> = []
  registerNativeSessionTransportIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    allowed: (event) => nativeSessionRequestAllowed({
      platform: "darwin",
      architecture: "arm64",
      rendererId: 4,
      acceptsPrivilegedRequests: rendererLifecycle.acceptsPrivilegedRequests(),
      event,
      sameAppOrigin: (url) => url.startsWith("daw://app/"),
    }),
    supervisor: () => ({ setSpectrumNode: async (nodeId) => { spectrumCalls.push(nodeId) }, setTransport: async () => undefined }),
    fail: nativeSessionFailure,
  })
  const spectrumHandler = handlers.get(sessionSetSpectrumNodeChannel)
  if (!spectrumHandler) throw new Error("Spectrum handler was not registered")
  const event: NativeSessionEvent = { sender: { id: 4, mainFrame }, senderFrame: mainFrame }
  const value = { value: 17n, transactionToken: undefined }
  expect(await spectrumHandler(event, value)).toEqual(nativeSessionFailure())
  rendererLifecycle.beginMainFrameNavigation(mainFrame.url)
  rendererLifecycle.commitMainFrameNavigation(mainFrame.url)
  expect(await spectrumHandler(event, value)).toEqual({ ok: true })
  expect(spectrumCalls).toEqual([17n])
})

test("the plug-in card's close command parses with main's editor command schema", () => {
  const common = {
    projectId: "project-1",
    instanceId: "123e4567-e89b-12d3-a456-426614174000",
    requiresState: true,
    captureState: true,
  }
  expect(nativeEditorCommandSchema.safeParse(nativeEditorCommand({
    ...common, command: "close", serializedPlan: undefined, initialState: undefined, anchor: undefined,
  })).success).toBe(true)
  expect(nativeEditorCommandSchema.safeParse(nativeEditorCommand({
    ...common, command: "open", serializedPlan: "plan", initialState: undefined, anchor: { x: 1, y: 2 },
  })).success).toBe(true)
})
