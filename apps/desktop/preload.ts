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
  desktopApplicationMenuMessageSchema,
  desktopApplicationMenuStateSchema,
  type DesktopApplicationMenuMessage,
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
import { z } from "zod"
import type { DesktopBridge, DesktopVstEditorCapturedState, DesktopVstEditorState } from "../../src/types/desktop-bridge"
import { createRequestQueue, type PreloadHostRequest, type PreloadHostResponse } from "./request-queue"
import { offlinePcmMessageSchema } from "./offline-pcm-protocol"
import { deliverOfflinePcmChunk } from "./offline-pcm-ack"

const incomingChannel = "daw:host-request"
const outgoingChannel = "daw:host-response"
const offlinePcmAckChannel = "daw:audio-host:offline-pcm-ack"
const applicationMenuCommandChannel = "daw:application-menu:command"
const applicationMenuStateChannel = "daw:application-menu:state"
const queueLimit = 32
let closeHandler: (() => Promise<{ flushed: boolean }>) | undefined
let activeGeneration = 0
const ipcRendererListener = (
  listener: Parameters<typeof ipcRenderer.on>[1],
): Parameters<typeof ipcRenderer.on>[1] => listener

const incomingMessageSchema = z.object({
  generation: z.number().int().safe(),
  frame: z.union([desktopCancelSchemaV1, desktopTrustedRendererRequestSchemaV1]),
  trustedActorSubject: z.string().regex(/^local:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/).optional(),
}).passthrough()
const vstEditorStateSchema = z.object({
  projectId: z.string(),
  instanceId: z.string(),
  open: z.boolean(),
}).passthrough()
const vstEditorCapturedStateSchema = z.object({
  requestId: z.string().uuid(),
  projectId: z.string(),
  instanceId: z.string(),
  state: z.object({
    bytes: z.instanceof(Uint8Array),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
}).strict()
const audioLifecycleSchema = z.object({
  state: z.enum(["suspended", "recovering", "ready", "failed"]),
  powerGeneration: z.number(),
}).passthrough()
const hostLossSchema = z.string().max(256)

type NativeAudioHostDiagnosticsReply = Awaited<ReturnType<NonNullable<DesktopBridge["audioHost"]>["diagnostics"]>>
type PluginCatalogReply = Awaited<ReturnType<NonNullable<DesktopBridge["pluginCatalog"]>["read"]>>

const invokePluginCatalog = (channel: string, value?: { directory: string }): Promise<PluginCatalogReply> =>
  ipcRenderer.invoke(channel, value)

type NativeSessionReply = { ok: true } | { ok: false; error: string }
type NativeTransactionReply = { ok: true; transactionToken: string } | { ok: false; error: string }
type DeclaredAudioHostBridge = NonNullable<DesktopBridge["audioHost"]>
type PreloadDesktopBridge = Omit<DesktopBridge, "audioHost"> & {
  audioHost?: {
    session: Omit<DeclaredAudioHostBridge["session"], "setRequestHandler" | "onPrepareToClose"> & {
      configure(input: NativeHostDeviceConfiguration, transactionToken?: string): Promise<NativeSessionReply>
      beginTransaction(): Promise<NativeTransactionReply>
    }
  } & Omit<DeclaredAudioHostBridge, "session">
}
type NativeVstEditorCommand = Parameters<NonNullable<DesktopBridge["audioHost"]>["session"]["editor"]>[0]
type NativeVstEditorReply = Awaited<ReturnType<NonNullable<DesktopBridge["audioHost"]>["session"]["editor"]>>
type NativeOutputDeviceReply = { ok: true; device: NativeOutputDevice | null } | { ok: false; error: string }
type NativeInputDeviceReply = { ok: true; device: NativeInputDevice | null } | { ok: false; error: string }
type NativeVstAttachmentCoordinationInput = Parameters<NonNullable<DesktopBridge["audioHost"]>["session"]["coordinateVstAttachments"]>[0]
const invokeNativeSession = <Value>(channel: string, value?: Value, transactionToken?: string): Promise<NativeSessionReply> =>
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

ipcRenderer.on(incomingChannel, (_event, message) => {
  const incoming = incomingMessageSchema.safeParse(message)
  if (!incoming.success) return
  const { generation, frame } = incoming.data
  if (generation < activeGeneration) return
  if (generation > activeGeneration) {
    requestQueue.reset(generation)
    activeGeneration = generation
  }
  const cancel = desktopCancelSchemaV1.safeParse(frame)
  if (cancel.success) {
    requestQueue.cancel(cancel.data.id)
    return
  }
  const parsed = desktopTrustedRendererRequestSchemaV1.safeParse(frame)
  if (!parsed.success) return
  if (parsed.data.operation === "lifecycle.prepareToClose") {
    dispatchLifecycle(generation, parsed.data)
    return
  }
  requestQueue.dispatch(generation, parsed.data, incoming.data.trustedActorSubject)
})

const desktopBridge = {
  setRequestHandler(
    next: ((request: PreloadHostRequest) => Promise<PreloadHostResponse>) | undefined,
    onCancel?: (requestId: string) => void,
  ) {
    requestQueue.setRequestHandler(next, onCancel)
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
      onCommand(listener: (command: DesktopApplicationMenuMessage) => void) {
      const notify = ipcRendererListener((_event, value) => {
        const parsed = desktopApplicationMenuMessageSchema.safeParse(value)
        if (parsed.success) listener(parsed.data)
      })
      ipcRenderer.on(applicationMenuCommandChannel, notify)
      return () => ipcRenderer.removeListener(applicationMenuCommandChannel, notify)
    },
    setState(state: DesktopApplicationMenuState) {
      const parsed = desktopApplicationMenuStateSchema.safeParse(state)
      if (parsed.success) ipcRenderer.send(applicationMenuStateChannel, parsed.data)
    },
  },
  audioHost: process.platform === "darwin" && process.arch === "arm64" ? {
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
          const notify = ipcRendererListener((_event, value) => {
            const parsed = hostLossSchema.safeParse(value)
            listener(parsed.success ? parsed.data : undefined)
          })
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
          const notify = ipcRendererListener((_event, value) => {
            const payload = desktopVstParameterEditPayloadSchema.safeParse(value)
            if (payload.success) listener(payload.data)
          })
          ipcRenderer.on("daw:audio-host:vst-parameter-edit", notify)
          return () => ipcRenderer.removeListener("daw:audio-host:vst-parameter-edit", notify)
        },
      },
      offlineRender: {
        start: async (
          jobId: string,
          plan: NativeOfflineRenderPlan,
          listener: (chunk: NativeOfflinePcmChunk) => void | Promise<void>,
        ) => {
          if (!nativeOfflineRenderPlanSchema.safeParse(plan).success) {
            return { ok: false as const, error: "The native offline render plan is invalid." }
          }
          const notify = ipcRendererListener((_event, value) => {
            const parsed = offlinePcmMessageSchema.safeParse(value)
            if (!parsed.success) {
              void ipcRenderer.invoke("daw:audio-host:offline-cancel", jobId).catch(() => undefined)
              return
            }
            if (parsed.data.jobId !== jobId
              || parsed.data.chunk.planes.length !== parsed.data.chunk.channelCount
              || !parsed.data.chunk.planes.every((plane) => plane.length === parsed.data.chunk.frameCount)) return
            void deliverOfflinePcmChunk(
              jobId,
              parsed.data.sequence,
              parsed.data.chunk,
              listener,
              (ack) => ipcRenderer.send(offlinePcmAckChannel, ack),
            ).catch(() => {
              void ipcRenderer.invoke("daw:audio-host:offline-cancel", jobId).catch(() => undefined)
            })
          })
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
        const notify = ipcRendererListener((_event, value) => {
          const parsed = vstEditorStateSchema.safeParse(value)
          if (parsed.success) listener(parsed.data)
        })
        ipcRenderer.on("daw:audio-host:vst-editor-state", notify)
        return () => ipcRenderer.removeListener("daw:audio-host:vst-editor-state", notify)
      },
      onVstEditorCapturedState: (listener: (payload: DesktopVstEditorCapturedState) => Promise<void> | void) => {
        const notify = ipcRendererListener((_event, value) => {
          const parsed = vstEditorCapturedStateSchema.safeParse(value)
          if (parsed.success) {
            void Promise.resolve(listener(parsed.data)).then(
              () => ipcRenderer.invoke("daw:audio-host:vst-editor-captured-state-ack", {
                requestId: parsed.data.requestId,
                ok: true,
              }),
              (error) => ipcRenderer.invoke("daw:audio-host:vst-editor-captured-state-ack", {
                requestId: parsed.data.requestId,
                ok: false,
                error: error instanceof Error ? error.message : "Editor state persistence failed.",
              }),
            )
          }
        })
        ipcRenderer.on("daw:audio-host:vst-editor-captured-state", notify)
        return () => ipcRenderer.removeListener("daw:audio-host:vst-editor-captured-state", notify)
      },
      getLifecycle: () => ipcRenderer.invoke("daw:audio-host:lifecycle"),
      completeRecovery: (powerGeneration: number, result: "ready" | "failed") => (
        ipcRenderer.invoke("daw:audio-host:recovery-complete", { powerGeneration, result })
      ),
      retryRecovery: () => ipcRenderer.invoke("daw:audio-host:recovery-retry"),
      onLifecycle: (listener: Parameters<NonNullable<DesktopBridge["audioHost"]>["onLifecycle"]>[0]) => {
        const notify = ipcRendererListener((_event, value) => {
          const parsed = audioLifecycleSchema.safeParse(value)
          if (parsed.success) listener(parsed.data)
        })
        ipcRenderer.on("daw:audio-host:lifecycle", notify)
        return () => ipcRenderer.removeListener("daw:audio-host:lifecycle", notify)
      },
    } : undefined,
    pluginCatalog: {
      read: () => invokePluginCatalog("daw:plugin-catalog:read"),
      chooseDirectory: () => invokePluginCatalog("daw:plugin-catalog:choose-directory"),
      removeDirectory: (directory: string) => invokePluginCatalog("daw:plugin-catalog:remove-directory", { directory }),
      scan: () => invokePluginCatalog("daw:plugin-catalog:scan"),
      preflightInsertion: (input: NativeVst3InsertionPreflightRequest): Promise<NativeVst3InsertionPreflightResult> => (
        ipcRenderer.invoke("daw:plugin-catalog:preflight-insertion", input)
      ),
    },
} satisfies PreloadDesktopBridge

contextBridge.exposeInMainWorld("dawDesktop", desktopBridge)
