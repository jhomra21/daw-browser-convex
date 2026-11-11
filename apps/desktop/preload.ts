import { contextBridge, ipcRenderer } from "electron"
import { nativeInstrumentBudgetPolicy } from "../../src/lib/desktop/native-instrument-budget-policy"
import {
  desktopCancelSchemaV1,
  desktopExportTerminalSchemaV1,
  desktopImportTerminalSchemaV1,
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
import {
  applicationMenuCommandChannel,
  applicationMenuStateChannel,
  benchmarkHeartbeatChannel,
  benchmarkRendererPingChannel,
  benchmarkRendererPongChannel,
  capabilityAbortChannel,
  capabilityBeginWriteChannel,
  capabilityCommitChannel,
  capabilityReadChunkChannel,
  capabilityWriteChunkChannel,
  diagnosticsChannel,
  diagnosticsV2TraceChannel,
  exportPickOutputDirectoryChannel,
  exportPickOutputFileChannel,
  exportReleaseOutputChannel,
  hostRequestChannel,
  hostResponseChannel,
  lifecycleChannel,
  lossChannel,
  meterBatchChannel,
  offlineCancelChannel,
  offlineMappedPageRequestChannel,
  offlineMappedPageResponseChannel,
  offlinePcmAckChannel,
  offlinePcmChannel,
  offlineRenderChannel,
  pluginCatalogChooseDirectoryChannel,
  pluginCatalogPreflightInsertionChannel,
  pluginCatalogReadChannel,
  pluginCatalogRemoveDirectoryChannel,
  pluginCatalogScanChannel,
  recordingFailureChannel,
  recordingSpoolListChannel,
  recordingSpoolReadChannel,
  recordingSpoolReleaseChannel,
  recordingStatusChannel,
  recoveryCompleteChannel,
  recoveryRetryChannel,
  resolveInputDeviceChannel,
  resolveOutputDeviceChannel,
  scheduleProgressChannel,
  sessionBeginTransactionChannel,
  sessionCancelRecordingChannel,
  sessionCommitTransactionChannel,
  sessionConfigureChannel,
  sessionConfigureInstrumentStatesChannel,
  sessionConfigureRecordingChannel,
  sessionCoordinateVstAttachmentsChannel,
  sessionCreateMappedAssetChannel,
  sessionDetachVstChannel,
  sessionEditorChannel,
  sessionGetVstStateChannel,
  sessionInstallAssetChannel,
  sessionPrepareMappedAssetRangeChannel,
  sessionPublishGraphChannel,
  sessionPrepareGraphRevisionChannel, sessionPublishGraphRevisionChannel, sessionInspectGraphRevisionChannel,
  sessionRollbackGraphRevisionChannel, sessionRetireGraphRevisionChannel,
  sessionQueueInstrumentEventsChannel,
  sessionQueueParameterEventsChannel,
  sessionQueueProcessorStatePatchChannel,
  sessionQueueScheduleWindowChannel,
  sessionQueueSourceEventsChannel,
  sessionQueueVstParameterEventsChannel,
  sessionReenableVstScheduleAutomationChannel,
  sessionReleaseAssetChannel,
  sessionReleaseMappedAssetChannel,
  sessionRollbackTransactionChannel,
  sessionSetSpectrumNodeChannel,
  sessionSetTransportChannel,
  sessionStartChannel,
  sessionStartRecordingChannel,
  sessionStopChannel,
  sessionStopRecordingChannel,
  sessionTeardownChannel,
  sessionWriteMappedAssetPageChannel,
  spectrumFrameChannel,
  vstEditorCapturedStateAckChannel,
  vstEditorCapturedStateChannel,
  vstEditorStateChannel,
  vstParameterEditChannel,
} from "@daw-browser/desktop-protocol/ipc-channels"
import {
  nativeAudioHostMappedAssetPageHeaderBytes,
  nativeAudioHostMaximumMappedAssetRanges,
  nativeAudioHostMaximumPayloadBytes,
  nativeOfflineRenderPlanSchema,
} from "@daw-browser/desktop-protocol/native-audio-host"
import type {
  NativeHostDeviceConfiguration,
  NativeHostPcmAsset,
  NativeHostMappedAsset,
  NativeHostMappedAssetPage,
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
  NativeOfflineMappedAsset,
} from "@daw-browser/audio-engine/native-host-wire"
import type {
  NativeVst3InsertionPreflightRequest,
  NativeVst3InsertionPreflightResult,
} from "@daw-browser/plugin-host-protocol"
import { isExportAudioFormat, type ExportAudioFormat } from "@daw-browser/shared"
import { z } from "zod"
import type {
  DesktopBridge,
  DesktopVstEditorCapturedState,
  DesktopVstEditorState,
  NativeDeliveryReply,
  NativeProcessorPatchReply,
} from "../../src/types/desktop-bridge"
import { createRequestQueue, type PreloadHostRequest, type PreloadHostResponse } from "./request-queue"
import { offlinePcmMessageSchema } from "./offline-pcm-protocol"
import { deliverOfflinePcmChunk } from "./offline-pcm-ack"
import { diagnosticValidationPaths } from "./diagnostics-trace"
import { safePreloadReply } from "./preload-reply"

if (process.env.DAW_BENCHMARK_HEARTBEAT === "1") {
  ipcRenderer.on(benchmarkRendererPingChannel, (_event, sequence) => {
    const parsed = z.number().int().safe().safeParse(sequence)
    if (parsed.success) {
      ipcRenderer.send(benchmarkRendererPongChannel, parsed.data)
    }
  })
}
const diagnosticsTraceStarts = new Map<string, number>()
const traceDiagnostics = (id: string, stage: string) => {
  const start = diagnosticsTraceStarts.get(id)
  if (start === undefined) return
  ipcRenderer.send(diagnosticsV2TraceChannel, { stage, elapsedMs: Math.max(0, Date.now() - start) })
  if (stage === "preload-reply-sent" || stage === "preload-reply-invalid") diagnosticsTraceStarts.delete(id)
}
const maximumNativeMappedPageBytes = nativeAudioHostMaximumPayloadBytes - nativeAudioHostMappedAssetPageHeaderBytes
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

import { createNativeRevisionSession } from "../../src/lib/desktop/native-revision-session"

type NativeSessionReply = { ok: true } | { ok: false; error: string }
type NativeConfigureReply =
  | { ok: true; hostIdentity: { pid: number; generation: number; configurationGeneration: number } }
  | { ok: false; error: string }
type NativeTransactionReply = { ok: true; transactionToken: string } | { ok: false; error: string }
type DeclaredAudioHostBridge = NonNullable<DesktopBridge["audioHost"]>
type PreloadDesktopBridge = Omit<DesktopBridge, "audioHost"> & {
  audioHost?: {
    session: Omit<DeclaredAudioHostBridge["session"], "setRequestHandler" | "onPrepareToClose"> & {
      configure(input: NativeHostDeviceConfiguration, transactionToken?: string): Promise<NativeConfigureReply>
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
const invokeNativeDelivery = (channel: string, value: Uint8Array, transactionToken?: string): Promise<NativeDeliveryReply> =>
  ipcRenderer.invoke(channel, { value, transactionToken })
const invokeNativePatch = (value: Uint8Array, transactionToken?: string): Promise<NativeProcessorPatchReply> =>
  ipcRenderer.invoke(sessionQueueProcessorStatePatchChannel, { value, transactionToken })
const invokeNativeTransaction = (): Promise<NativeTransactionReply> =>
  ipcRenderer.invoke(sessionBeginTransactionChannel, { value: undefined, transactionToken: undefined })
const invokeNativeEditor = (input: NativeVstEditorCommand, transactionToken?: string): Promise<NativeVstEditorReply> =>
  ipcRenderer.invoke(sessionEditorChannel, { value: input, transactionToken })
const invokeNativeOutputDevice = (preferredDeviceId?: string): Promise<NativeOutputDeviceReply> =>
  ipcRenderer.invoke(resolveOutputDeviceChannel, preferredDeviceId)
const invokeNativeInputDevice = (preferredDeviceId?: string): Promise<NativeInputDeviceReply> =>
  ipcRenderer.invoke(resolveInputDeviceChannel, preferredDeviceId)
const validExportRequestId = (requestId: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requestId)
const invalidExportRequest = () => Promise.reject(new Error("Invalid export output request."))

const reply = (generation: number, response: PreloadHostResponse) => {
  traceDiagnostics(response.id, "preload-reply")
  const parsed = desktopReplySchemaV1.safeParse({
    version: "v1",
    type: "reply",
    id: response.id,
    ...(response.error === undefined ? { result: response.result } : { error: response.error }),
  })
  if (parsed.success) {
    ipcRenderer.send(hostResponseChannel, { generation, frame: parsed.data })
    traceDiagnostics(response.id, "preload-reply-sent")
  } else {
    if (diagnosticsTraceStarts.has(response.id)) {
      traceDiagnostics(response.id, "preload-reply-invalid")
      ipcRenderer.send(diagnosticsV2TraceChannel, { stage: "preload-reply-invalid-path", elapsedMs: 0, paths: diagnosticValidationPaths(parsed.error) })
    }
    ipcRenderer.send(hostResponseChannel, { generation, frame: safePreloadReply(response) })
  }
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

ipcRenderer.on(hostRequestChannel, (_event, message) => {
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
  if (incoming.data.diagnosticsTrace === true && parsed.data.operation === "diagnostics.snapshot.v2") {
    diagnosticsTraceStarts.set(parsed.data.id, Date.now())
    traceDiagnostics(parsed.data.id, "preload-received")
  }
  if (parsed.data.operation === "lifecycle.prepareToClose") {
    dispatchLifecycle(generation, parsed.data)
    return
  }
  requestQueue.dispatch(generation, parsed.data, incoming.data.trustedActorSubject)
})

const desktopBridge = {
  benchmarkSabRecording: process.env.DAW_BENCHMARK_SAB_RECORDING === "1",
  acceptanceExternalNativeSession: process.env.DAW_AE08_EXTERNAL_NATIVE_SESSION === "1",
  benchmarkHeartbeat: (): Promise<{ mainEpochMs: number } | null> =>
    process.env.DAW_BENCHMARK_HEARTBEAT === "1" ? ipcRenderer.invoke(benchmarkHeartbeatChannel) : Promise.resolve(null),
  traceDiagnosticsV2(id: string, stage: "controller-before-native" | "controller-after-native" | "controller-parsed") {
    traceDiagnostics(id, stage)
  },
  setRequestHandler(
    next: ((request: PreloadHostRequest) => Promise<PreloadHostResponse>) | undefined,
    onCancel?: (requestId: string) => void,
  ) {
    requestQueue.setRequestHandler(next && ((request) => {
      traceDiagnostics(request.id, "preload-handler")
      return next(request)
    }), onCancel)
  },
  onPrepareToClose(next: typeof closeHandler) {
    closeHandler = next
  },
  async prepareToClose() {
    return closeHandler ? await closeHandler() : { flushed: false }
  },
  pickOutputFile(requestId: string, format: ExportAudioFormat) {
    if (!validExportRequestId(requestId) || !isExportAudioFormat(format)) return invalidExportRequest()
    return ipcRenderer.invoke(exportPickOutputFileChannel, { requestId, format })
  },
  pickOutputDirectory(requestId: string) {
    if (!validExportRequestId(requestId)) return invalidExportRequest()
    return ipcRenderer.invoke(exportPickOutputDirectoryChannel, { requestId })
  },
  releaseExportOutput(requestId: string) {
    if (!validExportRequestId(requestId)) return invalidExportRequest()
    return ipcRenderer.invoke(exportReleaseOutputChannel, { requestId })
  },
  readChunk(requestId: string, token: string, offset: number, length: number) {
    return ipcRenderer.invoke(capabilityReadChunkChannel, { requestId, token, offset, length })
  },
  beginWrite(requestId: string, token: string, relativePath?: string) {
    return ipcRenderer.invoke(capabilityBeginWriteChannel, { requestId, token, relativePath })
  },
  writeChunk(requestId: string, writerId: string, offset: number, chunk: Uint8Array) {
    return ipcRenderer.invoke(capabilityWriteChunkChannel, { requestId, writerId, offset, chunk })
  },
  commit(requestId: string, writerId: string) {
    return ipcRenderer.invoke(capabilityCommitChannel, { requestId, writerId })
  },
  abort(requestId: string, writerId: string) {
    return ipcRenderer.invoke(capabilityAbortChannel, { requestId, writerId })
  },
  exportTerminal(jobId: string, status: "success" | "canceled" | "error") {
    const frame = desktopExportTerminalSchemaV1.parse({ version: "v1", type: "export-terminal", jobId, status })
    ipcRenderer.send(hostResponseChannel, { generation: activeGeneration, frame })
  },
  importTerminal(jobId: string) {
    const frame = desktopImportTerminalSchemaV1.parse({ version: "v1", type: "import-terminal", jobId })
    ipcRenderer.send(hostResponseChannel, { generation: activeGeneration, frame })
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
      instrumentBudgetPolicy: nativeInstrumentBudgetPolicy(Number(
        process.argv.find((argument) => argument.startsWith("--daw-total-memory-bytes="))?.split("=")[1],
      )),
      recordingSpool: {
        list: (scope, cursor) => ipcRenderer.invoke(recordingSpoolListChannel, { scope, cursor }),
        read: (scope, takeId, offset, length) => ipcRenderer.invoke(recordingSpoolReadChannel, { scope, takeId, offset, length }),
        release: (scope, takeId, acknowledgment) => ipcRenderer.invoke(recordingSpoolReleaseChannel, { scope, takeId, acknowledgment }),
      },
      diagnostics: (): Promise<NativeAudioHostDiagnosticsReply> => ipcRenderer.invoke(diagnosticsChannel),
      resolveOutputDevice: invokeNativeOutputDevice,
      resolveInputDevice: invokeNativeInputDevice,
      session: {
        revisions: createNativeRevisionSession((operation, input) => ipcRenderer.invoke({
          prepare: sessionPrepareGraphRevisionChannel, publish: sessionPublishGraphRevisionChannel,
          inspect: sessionInspectGraphRevisionChannel, rollback: sessionRollbackGraphRevisionChannel,
          retire: sessionRetireGraphRevisionChannel,
        }[operation], input)),
        configure: (input: NativeHostDeviceConfiguration, transactionToken?: string): Promise<NativeConfigureReply> =>
          ipcRenderer.invoke(sessionConfigureChannel, { value: input, transactionToken }),
        beginTransaction: invokeNativeTransaction,
        commitTransaction: (transactionToken: string) => invokeNativeSession(sessionCommitTransactionChannel, undefined, transactionToken),
        rollbackTransaction: (transactionToken: string) => invokeNativeSession(sessionRollbackTransactionChannel, undefined, transactionToken),
        detachVst: (instanceId: string, transactionToken?: string) => invokeNativeSession(sessionDetachVstChannel, instanceId, transactionToken),
        captureVstState: (instanceId: string) => ipcRenderer.invoke(sessionGetVstStateChannel, instanceId),
        editor: (input: NativeVstEditorCommand): Promise<NativeVstEditorReply> => invokeNativeEditor(input, input.transactionToken),
        installAsset: (input: NativeHostPcmAsset, transactionToken?: string) => invokeNativeSession(sessionInstallAssetChannel, input, transactionToken),
        releaseAsset: (sessionAssetId: number, transactionToken?: string) => invokeNativeSession(sessionReleaseAssetChannel, sessionAssetId, transactionToken),
        createMappedAsset: (input: NativeHostMappedAsset, transactionToken?: string) => invokeNativeSession(sessionCreateMappedAssetChannel, input, transactionToken),
        writeMappedAssetPage: (input: NativeHostMappedAssetPage, transactionToken?: string) => invokeNativeSession(sessionWriteMappedAssetPageChannel, input, transactionToken),
        prepareMappedAssetRange: (sessionAssetId: number, startFrame: number, frameCount: number, transactionToken?: string) => invokeNativeSession(sessionPrepareMappedAssetRangeChannel, { sessionAssetId, startFrame, frameCount }, transactionToken),
        releaseMappedAsset: (sessionAssetId: number, transactionToken?: string) => invokeNativeSession(sessionReleaseMappedAssetChannel, sessionAssetId, transactionToken),
        publishGraph: (bytes: Uint8Array, transactionToken?: string) => invokeNativeSession(sessionPublishGraphChannel, bytes, transactionToken),
        configureInstrumentStates: (bytes: Uint8Array, transactionToken?: string) => invokeNativeSession(sessionConfigureInstrumentStatesChannel, bytes, transactionToken),
        queueParameterEvents: (bytes: Uint8Array, transactionToken?: string) => invokeNativeDelivery(sessionQueueParameterEventsChannel, bytes, transactionToken),
        queueProcessorStatePatch: (bytes: Uint8Array, transactionToken?: string) => invokeNativePatch(bytes, transactionToken),
        queueVstParameterEvents: (bytes: Uint8Array, transactionToken?: string) => invokeNativeSession(sessionQueueVstParameterEventsChannel, bytes, transactionToken),
        queueInstrumentEvents: (bytes: Uint8Array, transactionToken?: string) => invokeNativeDelivery(sessionQueueInstrumentEventsChannel, bytes, transactionToken),
        queueScheduleWindow: (bytes: Uint8Array, transactionToken?: string) => invokeNativeSession(sessionQueueScheduleWindowChannel, bytes, transactionToken),
        reenableVstScheduleAutomation: (bytes: Uint8Array, transactionToken?: string) => invokeNativeSession(sessionReenableVstScheduleAutomationChannel, bytes, transactionToken),
        queueSourceEvents: (bytes: Uint8Array, transactionToken?: string) => invokeNativeSession(sessionQueueSourceEventsChannel, bytes, transactionToken),
        coordinateVstAttachments: (input: NativeVstAttachmentCoordinationInput, transactionToken?: string) => invokeNativeSession(sessionCoordinateVstAttachmentsChannel, input, transactionToken),
        setTransport: (input: NativeHostTransport, transactionToken?: string) => invokeNativeSession(sessionSetTransportChannel, input, transactionToken),
        configureRecording: (input: NativeHostRecordingConfiguration & { spoolImportVersion: 1 }): ReturnType<DeclaredAudioHostBridge["session"]["configureRecording"]> =>
          ipcRenderer.invoke(sessionConfigureRecordingChannel, { value: input, transactionToken: undefined }),
        startRecording: (binding?: Pick<NativeHostRecordingConfiguration, "projectId" | "projectGeneration" | "generation" | "sessionId">) =>
          invokeNativeSession(sessionStartRecordingChannel, binding),
        stopRecording: (stopFrame?: number) => invokeNativeSession(sessionStopRecordingChannel, stopFrame),
        cancelRecording: () => invokeNativeSession(sessionCancelRecordingChannel),
        start: () => invokeNativeSession(sessionStartChannel),
        stop: (reason?: string) => invokeNativeSession(sessionStopChannel, reason ?? "unspecified"),
        teardown: (reason: string) => invokeNativeSession(sessionTeardownChannel, reason),
        onLoss: (listener: (error?: string) => void) => {
          const notify = ipcRendererListener((_event, value) => {
            const parsed = hostLossSchema.safeParse(value)
            listener(parsed.success ? parsed.data : undefined)
          })
          ipcRenderer.on(lossChannel, notify)
          return () => ipcRenderer.removeListener(lossChannel, notify)
        },
        onRecordingFailure: (listener) => {
          const schema = z.object({ generation: z.number().int().nonnegative(), sessionId: z.bigint().positive(), message: z.string().max(256) }).strict()
          const notify = ipcRendererListener((_event, value) => {
            const parsed = schema.safeParse(value)
            if (parsed.success) listener(parsed.data)
          })
          ipcRenderer.on(recordingFailureChannel, notify)
          return () => ipcRenderer.removeListener(recordingFailureChannel, notify)
        },
        onRecordingStatus: (listener: (status: NativeHostRecordingStatus) => void) => {
          const notify = (_event: Electron.IpcRendererEvent, status: NativeHostRecordingStatus) => listener(status)
          ipcRenderer.on(recordingStatusChannel, notify)
          return () => ipcRenderer.removeListener(recordingStatusChannel, notify)
        },
        onMeterBatch: (listener: (batch: NativeHostMeterBatch) => void) => {
          const notify = (_event: Electron.IpcRendererEvent, batch: NativeHostMeterBatch) => listener(batch)
          ipcRenderer.on(meterBatchChannel, notify)
          return () => ipcRenderer.removeListener(meterBatchChannel, notify)
        },
        setSpectrumNode: (nodeId: bigint | null) => invokeNativeSession(sessionSetSpectrumNodeChannel, nodeId),
        onSpectrumFrame: (listener: (frame: NativeHostSpectrumFrame) => void) => {
          const notify = (_event: Electron.IpcRendererEvent, frame: NativeHostSpectrumFrame) => listener(frame)
          ipcRenderer.on(spectrumFrameChannel, notify)
          return () => ipcRenderer.removeListener(spectrumFrameChannel, notify)
        },
        onScheduleProgress: (listener: (progress: NativeScheduleProgress) => void) => {
          const notify = (_event: Electron.IpcRendererEvent, progress: NativeScheduleProgress) => listener(progress)
          ipcRenderer.on(scheduleProgressChannel, notify)
          return () => ipcRenderer.removeListener(scheduleProgressChannel, notify)
        },
        onVstParameterEdit: (listener: (payload: DesktopVstParameterEditPayload) => void) => {
          const notify = ipcRendererListener((_event, value) => {
            const payload = desktopVstParameterEditPayloadSchema.safeParse(value)
            if (payload.success) listener(payload.data)
          })
          ipcRenderer.on(vstParameterEditChannel, notify)
          return () => ipcRenderer.removeListener(vstParameterEditChannel, notify)
        },
      },
      offlineRender: {
        start: async (
          jobId: string,
          plan: NativeOfflineRenderPlan,
          listener: (chunk: NativeOfflinePcmChunk) => void | Promise<void>,
          pageListener: (
            requestId: string,
            asset: NativeOfflineMappedAsset,
            startFrame: number,
            frameCount: number,
          ) => Promise<NativeHostMappedAssetPage>,
        ) => {
          if (!nativeOfflineRenderPlanSchema.safeParse(plan).success) {
            return { ok: false as const, error: "The native offline render plan is invalid." }
          }
          const notify = ipcRendererListener((_event, value) => {
            const parsed = offlinePcmMessageSchema.safeParse(value)
            if (!parsed.success) {
              void ipcRenderer.invoke(offlineCancelChannel, jobId).catch(() => undefined)
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
              void ipcRenderer.invoke(offlineCancelChannel, jobId).catch(() => undefined)
            })
          })
          ipcRenderer.on(offlinePcmChannel, notify)
          const pageNotify = ipcRendererListener((_event, value) => {
            const request = z.object({
              jobId: z.string(),
              requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
              asset: z.object({
                sessionAssetId: z.number().int().positive().safe(),
                sourceAssetKey: z.string().min(1),
                projectId: z.string().optional(),
                sourceKind: z.enum(["upload", "url", "recording"]).optional(),
                sampleUrl: z.string().optional(),
                frameCount: z.number().int().positive().safe(),
                sampleRateHz: z.number().int().positive().safe(),
                channelCount: z.number().int().positive().safe().max(64),
                preparedStretchArtifactId: z.string().min(1).max(512).optional(),
                ranges: z.array(z.object({
                  startFrame: z.number().int().nonnegative().safe(),
                  frameCount: z.number().int().positive().safe(),
                }).strict()).max(nativeAudioHostMaximumMappedAssetRanges),
              }).strict(),
              startFrame: z.number().int().nonnegative().safe(),
              frameCount: z.number().int().positive().safe(),
            }).strict().safeParse(value)
            if (!request.success || request.data.jobId !== jobId) return
            if (
              !Number.isSafeInteger(request.data.startFrame + request.data.frameCount)
              || request.data.startFrame + request.data.frameCount > request.data.asset.frameCount
              || !Number.isSafeInteger(
                request.data.frameCount * request.data.asset.channelCount * Float32Array.BYTES_PER_ELEMENT,
              )
              || request.data.frameCount * request.data.asset.channelCount * Float32Array.BYTES_PER_ELEMENT > maximumNativeMappedPageBytes
            ) return
            void pageListener(
              request.data.requestId,
              request.data.asset,
              request.data.startFrame,
              request.data.frameCount,
            ).then(
              (page) => ipcRenderer.invoke(offlineMappedPageResponseChannel, {
                jobId,
                requestId: request.data.requestId,
                page,
              }),
              (error) => ipcRenderer.invoke(offlineMappedPageResponseChannel, {
                jobId,
                requestId: request.data.requestId,
                error: error instanceof Error ? error.message : "Offline mapped page hydration failed.",
              }),
            )
          })
          ipcRenderer.on(offlineMappedPageRequestChannel, pageNotify)
          try {
            return await ipcRenderer.invoke(offlineRenderChannel, { jobId, plan })
          } finally {
            ipcRenderer.removeListener(offlinePcmChannel, notify)
            ipcRenderer.removeListener(offlineMappedPageRequestChannel, pageNotify)
          }
        },
        cancel: (jobId: string) => ipcRenderer.invoke(offlineCancelChannel, jobId),
      },
      onVstEditorState: (listener: (payload: DesktopVstEditorState) => void) => {
        const notify = ipcRendererListener((_event, value) => {
          const parsed = vstEditorStateSchema.safeParse(value)
          if (parsed.success) listener(parsed.data)
        })
        ipcRenderer.on(vstEditorStateChannel, notify)
        return () => ipcRenderer.removeListener(vstEditorStateChannel, notify)
      },
      onVstEditorCapturedState: (listener: (payload: DesktopVstEditorCapturedState) => Promise<void> | void) => {
        const notify = ipcRendererListener((_event, value) => {
          const parsed = vstEditorCapturedStateSchema.safeParse(value)
          if (parsed.success) {
            void Promise.resolve(listener(parsed.data)).then(
              () => ipcRenderer.invoke(vstEditorCapturedStateAckChannel, {
                requestId: parsed.data.requestId,
                ok: true,
              }),
              (error) => ipcRenderer.invoke(vstEditorCapturedStateAckChannel, {
                requestId: parsed.data.requestId,
                ok: false,
                error: error instanceof Error ? error.message : "Editor state persistence failed.",
              }),
            )
          }
        })
        ipcRenderer.on(vstEditorCapturedStateChannel, notify)
        return () => ipcRenderer.removeListener(vstEditorCapturedStateChannel, notify)
      },
      getLifecycle: () => ipcRenderer.invoke(lifecycleChannel),
      completeRecovery: (powerGeneration: number, result: "ready" | "failed") => (
        ipcRenderer.invoke(recoveryCompleteChannel, { powerGeneration, result })
      ),
      retryRecovery: () => ipcRenderer.invoke(recoveryRetryChannel),
      onLifecycle: (listener: Parameters<NonNullable<DesktopBridge["audioHost"]>["onLifecycle"]>[0]) => {
        const notify = ipcRendererListener((_event, value) => {
          const parsed = audioLifecycleSchema.safeParse(value)
          if (parsed.success) listener(parsed.data)
        })
        ipcRenderer.on(lifecycleChannel, notify)
        return () => ipcRenderer.removeListener(lifecycleChannel, notify)
      },
    } : undefined,
    pluginCatalog: {
      read: () => invokePluginCatalog(pluginCatalogReadChannel),
      chooseDirectory: () => invokePluginCatalog(pluginCatalogChooseDirectoryChannel),
      removeDirectory: (directory: string) => invokePluginCatalog(pluginCatalogRemoveDirectoryChannel, { directory }),
      scan: () => invokePluginCatalog(pluginCatalogScanChannel),
      preflightInsertion: (input: NativeVst3InsertionPreflightRequest): Promise<NativeVst3InsertionPreflightResult> => (
        ipcRenderer.invoke(pluginCatalogPreflightInsertionChannel, input)
      ),
    },
} satisfies PreloadDesktopBridge

contextBridge.exposeInMainWorld("dawDesktop", desktopBridge)
