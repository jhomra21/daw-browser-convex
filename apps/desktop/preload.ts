import { contextBridge, ipcRenderer } from "electron"
import {
  desktopCancelSchemaV1,
  desktopExportTerminalSchemaV1,
  desktopReplySchemaV1,
  desktopTrustedRendererRequestSchemaV1,
  desktopVstParameterEditPayloadSchema,
  hostError,
  type DesktopRendererRequestV1,
  type DesktopVstParameterEditPayload,
} from "@daw-browser/desktop-protocol"
import {
  desktopApplicationMenuCommandSchema,
  desktopApplicationMenuStateSchema,
  type DesktopApplicationMenuCommand,
  type DesktopApplicationMenuState,
} from "@daw-browser/desktop-protocol/application-menu"
import { nativeOfflineRenderPlanSchema } from "@daw-browser/desktop-protocol/native-audio-host"
import type {
  NativeHostDeviceConfiguration,
  NativeHostPcmAsset,
  NativeHostRecordingBlock,
  NativeHostRecordingConfiguration,
  NativeHostRecordingStatus,
  NativeHostMeterBatch,
  NativeHostSpectrumFrame,
  NativeHostTransport,
  NativeScheduleProgress,
  NativeInputDevice,
  NativeOutputDevice,
  NativeOfflineRenderPlan,
  NativeOfflinePcmChunk,
} from "@daw-browser/audio-engine/native-host-wire"
import type {
  NativeVst3InsertionPreflightRequest,
  NativeVst3InsertionPreflightResult,
} from "@daw-browser/plugin-host-protocol"
import { isExportAudioFormat, type ExportAudioFormat } from "@daw-browser/shared"
import type { DesktopBridge, DesktopVstEditorState } from "../../src/types/desktop-bridge"
import { createRequestQueue, type PreloadHostRequest, type PreloadHostResponse } from "./request-queue"

const incomingChannel = "daw:host-request"
const outgoingChannel = "daw:host-response"
const applicationMenuCommandChannel = "daw:application-menu:command"
const applicationMenuStateChannel = "daw:application-menu:state"
const queueLimit = 32
let closeHandler: (() => Promise<{ flushed: boolean }>) | undefined
let activeGeneration = 0

type NativeAudioHostDiagnosticsReply = Awaited<ReturnType<NonNullable<DesktopBridge["audioHost"]>["diagnostics"]>>
type PluginCatalogReply = Awaited<ReturnType<NonNullable<DesktopBridge["pluginCatalog"]>["read"]>>

const invokePluginCatalog = (channel: string, value?: unknown): Promise<PluginCatalogReply> =>
  ipcRenderer.invoke(channel, value)

type NativeSessionReply = { ok: true } | { ok: false; error: string }
type NativeTransactionReply = { ok: true; transactionToken: string } | { ok: false; error: string }
type NativeVstEditorCommand = Parameters<NonNullable<DesktopBridge["audioHost"]>["session"]["editor"]>[0]
type NativeVstEditorReply = Awaited<ReturnType<NonNullable<DesktopBridge["audioHost"]>["session"]["editor"]>>
type NativeOutputDeviceReply = { ok: true; device: NativeOutputDevice | null } | { ok: false; error: string }
type NativeInputDeviceReply = { ok: true; device: NativeInputDevice | null } | { ok: false; error: string }
type NativeVstAttachmentCoordinationInput = Parameters<NonNullable<DesktopBridge["audioHost"]>["session"]["coordinateVstAttachments"]>[0]
const invokeNativeSession = (channel: string, value?: unknown, transactionToken?: string): Promise<NativeSessionReply> =>
  ipcRenderer.invoke(channel, { value, transactionToken })
const invokeNativeTransaction = (): Promise<NativeTransactionReply> =>
  ipcRenderer.invoke("daw:audio-host:session:begin-transaction", { value: undefined, transactionToken: undefined })
const invokeNativeEditor = (input: NativeVstEditorCommand, transactionToken?: string): Promise<NativeVstEditorReply> =>
  ipcRenderer.invoke("daw:audio-host:session:editor", { value: input, transactionToken })
const invokeNativeOutputDevice = (preferredDeviceId?: string): Promise<NativeOutputDeviceReply> =>
  ipcRenderer.invoke("daw:audio-host:resolve-output-device", preferredDeviceId)
const invokeNativeInputDevice = (preferredDeviceId?: string): Promise<NativeInputDeviceReply> =>
  ipcRenderer.invoke("daw:audio-host:resolve-input-device", preferredDeviceId)
const validExportRequestId = (requestId: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requestId)
const invalidExportRequest = () => Promise.reject(new Error("Invalid export output request."))
const offlinePcmChunk = (value: unknown): { jobId: string; chunk: NativeOfflinePcmChunk } | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const jobId = Reflect.get(value, "jobId")
  const chunk = Reflect.get(value, "chunk")
  if (typeof jobId !== "string" || typeof chunk !== "object" || chunk === null) return undefined
  const startFrame = Reflect.get(chunk, "startFrame")
  const frameCount = Reflect.get(chunk, "frameCount")
  const channelCount = Reflect.get(chunk, "channelCount")
  const planes = Reflect.get(chunk, "planes")
  if (
    !Number.isSafeInteger(startFrame) || startFrame < 0
    || !Number.isSafeInteger(frameCount) || frameCount <= 0
    || (channelCount !== 1 && channelCount !== 2)
    || !Array.isArray(planes)
    || planes.length !== channelCount
    || !planes.every((plane) => plane instanceof Float32Array && plane.length === frameCount)
  ) return undefined
  return { jobId, chunk: { startFrame, frameCount, channelCount, planes } }
}

const reply = (generation: number, response: PreloadHostResponse) => {
  const parsed = desktopReplySchemaV1.safeParse({
    version: "v1",
    type: "reply",
    id: response.id,
    ...(response.error === undefined ? { result: response.result } : { error: response.error }),
  })
  if (parsed.success) ipcRenderer.send(outgoingChannel, { generation, frame: parsed.data })
}

const requestQueue = createRequestQueue({ reply, queueLimit })

const dispatchLifecycle = (
  generation: number,
  request: Extract<DesktopRendererRequestV1, { operation: "lifecycle.prepareToClose" }>,
) => {
  void (closeHandler ? closeHandler() : Promise.resolve({ flushed: false }))
    .then((response) => reply(generation, { id: request.id, result: response }))
    .catch(() => reply(generation, { id: request.id, error: hostError("internal", "The timeline could not prepare to close.") }))
}

ipcRenderer.on(incomingChannel, (_event, message: unknown) => {
  if (typeof message !== "object" || message === null || !("generation" in message) || !("frame" in message)) return
  const generation = message.generation
  if (typeof generation !== "number" || !Number.isSafeInteger(generation)) return
  if (generation < activeGeneration) return
  if (generation > activeGeneration) {
    requestQueue.reset(generation)
    activeGeneration = generation
  }
  const cancel = desktopCancelSchemaV1.safeParse(message.frame)
  if (cancel.success) {
    requestQueue.cancel(cancel.data.id)
    return
  }
  const parsed = desktopTrustedRendererRequestSchemaV1.safeParse(message.frame)
  if (!parsed.success) return
  if (parsed.data.operation === "lifecycle.prepareToClose") {
    dispatchLifecycle(generation, parsed.data)
    return
  }
  requestQueue.dispatch(generation, parsed.data)
})

const desktopBridge = {
  setRequestHandler(next: ((request: PreloadHostRequest) => Promise<PreloadHostResponse>) | undefined) {
    requestQueue.setRequestHandler(next)
  },
  onPrepareToClose(next: typeof closeHandler) {
    closeHandler = next
  },
  async prepareToClose() {
    return closeHandler ? await closeHandler() : { flushed: false }
  },
  pickOutputFile(requestId: string, format: ExportAudioFormat) {
    if (!validExportRequestId(requestId) || !isExportAudioFormat(format)) return invalidExportRequest()
    return ipcRenderer.invoke("daw:export:pick-output-file", { requestId, format })
  },
  pickOutputDirectory(requestId: string) {
    if (!validExportRequestId(requestId)) return invalidExportRequest()
    return ipcRenderer.invoke("daw:export:pick-output-directory", { requestId })
  },
  releaseExportOutput(requestId: string) {
    if (!validExportRequestId(requestId)) return invalidExportRequest()
    return ipcRenderer.invoke("daw:export:release-output", { requestId })
  },
  readChunk(requestId: string, token: string) {
    return ipcRenderer.invoke("daw:capability:readChunk", { requestId, token })
  },
  beginWrite(requestId: string, token: string, relativePath?: string) {
    return ipcRenderer.invoke("daw:capability:beginWrite", { requestId, token, relativePath })
  },
  writeChunk(requestId: string, writerId: string, offset: number, chunk: Uint8Array) {
    return ipcRenderer.invoke("daw:capability:writeChunk", { requestId, writerId, offset, chunk })
  },
  commit(requestId: string, writerId: string) {
    return ipcRenderer.invoke("daw:capability:commit", { requestId, writerId })
  },
  abort(requestId: string, writerId: string) {
    return ipcRenderer.invoke("daw:capability:abort", { requestId, writerId })
  },
  exportTerminal(jobId: string, status: "success" | "canceled" | "error") {
    const frame = desktopExportTerminalSchemaV1.parse({ version: "v1", type: "export-terminal", jobId, status })
    ipcRenderer.send(outgoingChannel, { generation: activeGeneration, frame })
  },
  applicationMenu: {
    onCommand(listener: (command: DesktopApplicationMenuCommand) => void) {
      const notify = (_event: Electron.IpcRendererEvent, value: unknown) => {
        const parsed = desktopApplicationMenuCommandSchema.safeParse(value)
        if (parsed.success) listener(parsed.data)
      }
      ipcRenderer.on(applicationMenuCommandChannel, notify)
      return () => ipcRenderer.removeListener(applicationMenuCommandChannel, notify)
    },
    setState(state: DesktopApplicationMenuState) {
      const parsed = desktopApplicationMenuStateSchema.safeParse(state)
      if (parsed.success) ipcRenderer.send(applicationMenuStateChannel, parsed.data)
    },
  },
  ...(process.platform === "darwin" && process.arch === "arm64" ? {
    audioHost: {
      diagnostics: (): Promise<NativeAudioHostDiagnosticsReply> => ipcRenderer.invoke("daw:audio-host:diagnostics"),
      resolveOutputDevice: invokeNativeOutputDevice,
      resolveInputDevice: invokeNativeInputDevice,
      session: {
        configure: (input: NativeHostDeviceConfiguration, transactionToken?: string) => invokeNativeSession("daw:audio-host:session:configure", input, transactionToken),
        beginTransaction: invokeNativeTransaction,
        commitTransaction: (transactionToken: string) => invokeNativeSession("daw:audio-host:session:commit-transaction", undefined, transactionToken),
        rollbackTransaction: (transactionToken: string) => invokeNativeSession("daw:audio-host:session:rollback-transaction", undefined, transactionToken),
        detachVst: (instanceId: string, transactionToken?: string) => invokeNativeSession("daw:audio-host:session:detach-vst", instanceId, transactionToken),
        captureVstState: (instanceId: string) => ipcRenderer.invoke("daw:audio-host:session:get-vst-state", instanceId),
        editor: (input: NativeVstEditorCommand): Promise<NativeVstEditorReply> => invokeNativeEditor(input, input.transactionToken),
        installAsset: (input: NativeHostPcmAsset, transactionToken?: string) => invokeNativeSession("daw:audio-host:session:install-asset", input, transactionToken),
        releaseAsset: (sessionAssetId: number, transactionToken?: string) => invokeNativeSession("daw:audio-host:session:release-asset", sessionAssetId, transactionToken),
        publishGraph: (bytes: Uint8Array, transactionToken?: string) => invokeNativeSession("daw:audio-host:session:publish-graph", bytes, transactionToken),
        configureInstrumentStates: (bytes: Uint8Array, transactionToken?: string) => invokeNativeSession("daw:audio-host:session:configure-instrument-states", bytes, transactionToken),
        queueParameterEvents: (bytes: Uint8Array, transactionToken?: string) => invokeNativeSession("daw:audio-host:session:queue-parameter-events", bytes, transactionToken),
        queueProcessorStatePatch: (bytes: Uint8Array, transactionToken?: string) => invokeNativeSession("daw:audio-host:session:queue-processor-state-patch", bytes, transactionToken),
        queueVstParameterEvents: (bytes: Uint8Array, transactionToken?: string) => invokeNativeSession("daw:audio-host:session:queue-vst-parameter-events", bytes, transactionToken),
        queueInstrumentEvents: (bytes: Uint8Array, transactionToken?: string) => invokeNativeSession("daw:audio-host:session:queue-instrument-events", bytes, transactionToken),
        queueScheduleWindow: (bytes: Uint8Array, transactionToken?: string) => invokeNativeSession("daw:audio-host:session:queue-schedule-window", bytes, transactionToken),
        reenableVstScheduleAutomation: (bytes: Uint8Array, transactionToken?: string) => invokeNativeSession("daw:audio-host:session:reenable-vst-schedule-automation", bytes, transactionToken),
        queueSourceEvents: (bytes: Uint8Array, transactionToken?: string) => invokeNativeSession("daw:audio-host:session:queue-source-events", bytes, transactionToken),
        coordinateVstAttachments: (input: NativeVstAttachmentCoordinationInput, transactionToken?: string) => invokeNativeSession("daw:audio-host:session:coordinate-vst-attachments", input, transactionToken),
        setTransport: (input: NativeHostTransport, transactionToken?: string) => invokeNativeSession("daw:audio-host:session:set-transport", input, transactionToken),
        configureRecording: (input: NativeHostRecordingConfiguration) => invokeNativeSession("daw:audio-host:session:configure-recording", input),
        startRecording: () => invokeNativeSession("daw:audio-host:session:start-recording"),
        stopRecording: (stopFrame?: number) => invokeNativeSession("daw:audio-host:session:stop-recording", stopFrame),
        cancelRecording: () => invokeNativeSession("daw:audio-host:session:cancel-recording"),
        start: () => invokeNativeSession("daw:audio-host:session:start"),
        stop: () => invokeNativeSession("daw:audio-host:session:stop"),
        teardown: () => invokeNativeSession("daw:audio-host:session:teardown"),
        onLoss: (listener: (error?: string) => void) => {
          const notify = (_event: Electron.IpcRendererEvent, value: unknown) => {
            listener(typeof value === "string" && value.length <= 256 ? value : undefined)
          }
          ipcRenderer.on("daw:audio-host:loss", notify)
          return () => ipcRenderer.removeListener("daw:audio-host:loss", notify)
        },
        onRecordingBlock: (listener: (block: NativeHostRecordingBlock) => void) => {
          const notify = (_event: Electron.IpcRendererEvent, block: NativeHostRecordingBlock) => listener(block)
          ipcRenderer.on("daw:audio-host:recording-block", notify)
          return () => ipcRenderer.removeListener("daw:audio-host:recording-block", notify)
        },
        onRecordingStatus: (listener: (status: NativeHostRecordingStatus) => void) => {
          const notify = (_event: Electron.IpcRendererEvent, status: NativeHostRecordingStatus) => listener(status)
          ipcRenderer.on("daw:audio-host:recording-status", notify)
          return () => ipcRenderer.removeListener("daw:audio-host:recording-status", notify)
        },
        onMeterBatch: (listener: (batch: NativeHostMeterBatch) => void) => {
          const notify = (_event: Electron.IpcRendererEvent, batch: NativeHostMeterBatch) => listener(batch)
          ipcRenderer.on("daw:audio-host:meter-batch", notify)
          return () => ipcRenderer.removeListener("daw:audio-host:meter-batch", notify)
        },
        setSpectrumNode: (nodeId: bigint | null) => invokeNativeSession("daw:audio-host:session:set-spectrum-node", nodeId),
        onSpectrumFrame: (listener: (frame: NativeHostSpectrumFrame) => void) => {
          const notify = (_event: Electron.IpcRendererEvent, frame: NativeHostSpectrumFrame) => listener(frame)
          ipcRenderer.on("daw:audio-host:spectrum-frame", notify)
          return () => ipcRenderer.removeListener("daw:audio-host:spectrum-frame", notify)
        },
        onScheduleProgress: (listener: (progress: NativeScheduleProgress) => void) => {
          const notify = (_event: Electron.IpcRendererEvent, progress: NativeScheduleProgress) => listener(progress)
          ipcRenderer.on("daw:audio-host:schedule-progress", notify)
          return () => ipcRenderer.removeListener("daw:audio-host:schedule-progress", notify)
        },
        onVstParameterEdit: (listener: (payload: DesktopVstParameterEditPayload) => void) => {
          const notify = (_event: Electron.IpcRendererEvent, value: unknown) => {
            const payload = desktopVstParameterEditPayloadSchema.safeParse(value)
            if (payload.success) listener(payload.data)
          }
          ipcRenderer.on("daw:audio-host:vst-parameter-edit", notify)
          return () => ipcRenderer.removeListener("daw:audio-host:vst-parameter-edit", notify)
        },
      },
      offlineRender: {
        start: async (
          jobId: string,
          plan: NativeOfflineRenderPlan,
          listener: (chunk: NativeOfflinePcmChunk) => void,
        ) => {
          if (!nativeOfflineRenderPlanSchema.safeParse(plan).success) {
            return { ok: false as const, error: "The native offline render plan is invalid." }
          }
          const notify = (_event: Electron.IpcRendererEvent, value: unknown) => {
            const parsed = offlinePcmChunk(value)
            if (parsed?.jobId === jobId) listener(parsed.chunk)
          }
          ipcRenderer.on("daw:audio-host:offline-pcm", notify)
          try {
            return await ipcRenderer.invoke("daw:audio-host:offline-render", { jobId, plan })
          } finally {
            ipcRenderer.removeListener("daw:audio-host:offline-pcm", notify)
          }
        },
        cancel: (jobId: string) => ipcRenderer.invoke("daw:audio-host:offline-cancel", jobId),
      },
      onVstEditorState: (listener: (payload: DesktopVstEditorState) => void) => {
        const notify = (_event: Electron.IpcRendererEvent, value: unknown) => {
          if (typeof value !== "object" || value === null
            || !("projectId" in value) || typeof value.projectId !== "string"
            || !("instanceId" in value) || typeof value.instanceId !== "string"
            || !("open" in value) || typeof value.open !== "boolean") return
          listener({ projectId: value.projectId, instanceId: value.instanceId, open: value.open })
        }
        ipcRenderer.on("daw:audio-host:vst-editor-state", notify)
        return () => ipcRenderer.removeListener("daw:audio-host:vst-editor-state", notify)
      },
      getLifecycle: () => ipcRenderer.invoke("daw:audio-host:lifecycle"),
      completeRecovery: (powerGeneration: number, result: "ready" | "failed") => (
        ipcRenderer.invoke("daw:audio-host:recovery-complete", { powerGeneration, result })
      ),
      retryRecovery: () => ipcRenderer.invoke("daw:audio-host:recovery-retry"),
      onLifecycle: (listener: Parameters<NonNullable<DesktopBridge["audioHost"]>["onLifecycle"]>[0]) => {
        const notify = (_event: Electron.IpcRendererEvent, value: unknown) => {
          if (typeof value !== "object" || value === null || !("state" in value) || !("powerGeneration" in value)) return
          if (
            (value.state !== "suspended" && value.state !== "recovering" && value.state !== "ready" && value.state !== "failed")
            || typeof value.powerGeneration !== "number"
          ) return
          listener({ state: value.state, powerGeneration: value.powerGeneration })
        }
        ipcRenderer.on("daw:audio-host:lifecycle", notify)
        return () => ipcRenderer.removeListener("daw:audio-host:lifecycle", notify)
      },
    },
    pluginCatalog: {
      read: () => invokePluginCatalog("daw:plugin-catalog:read"),
      chooseDirectory: () => invokePluginCatalog("daw:plugin-catalog:choose-directory"),
      removeDirectory: (directory: string) => invokePluginCatalog("daw:plugin-catalog:remove-directory", { directory }),
      scan: () => invokePluginCatalog("daw:plugin-catalog:scan"),
      preflightInsertion: (input: NativeVst3InsertionPreflightRequest): Promise<NativeVst3InsertionPreflightResult> => (
        ipcRenderer.invoke("daw:plugin-catalog:preflight-insertion", input)
      ),
    },
  } : {}),
} satisfies DesktopBridge

contextBridge.exposeInMainWorld("dawDesktop", desktopBridge)
