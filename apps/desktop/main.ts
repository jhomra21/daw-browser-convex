import { app, BrowserWindow, contentTracing, dialog, ipcMain, Menu, powerMonitor, protocol } from "electron"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { z } from "zod"
import { nativeEditorCommandSchema, nativeSessionEnvelopeSchema } from "./native-session-schemas"
import { nativeSessionOperations, type nativeSessionAssetSchema } from "./ipc/native-session-operations"
import { requestIdSchema, sha256HexPattern, sha256HexSchema, unsigned32Schema, uuidSchema } from "@daw-browser/desktop-protocol/wire-patterns"
import {
  desktopFrameSchemaV1,
  projectIdSchemaV1,
  recordingSpoolMaximumReadBytes,
} from "@daw-browser/desktop-protocol"
import type { DesktopApplicationMenuMessage } from "@daw-browser/desktop-protocol/application-menu"
import {
  applicationMenuCommandChannel,
  diagnosticsChannel,
  diagnosticsV2TraceChannel,
  hostResponseChannel,
  lifecycleChannel,
  listDevicesChannel,
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
  sessionCoordinateVstAttachmentsChannel,
  sessionEditorChannel,
  sessionGetVstStateChannel,
  sessionPrepareGraphRevisionChannel,
  sessionPublishGraphRevisionChannel,
  sessionInspectGraphRevisionChannel,
  sessionRollbackGraphRevisionChannel,
  sessionRetireGraphRevisionChannel,
  sessionRollbackTransactionChannel,
  sessionStartChannel,
  sessionStopChannel,
  sessionTeardownChannel,
  spectrumFrameChannel,
  vstEditorCapturedStateChannel,
  vstEditorStateChannel,
  vstInstanceEventChannel,
  vstParameterEditChannel,
} from "@daw-browser/desktop-protocol/ipc-channels"

import { initializeRecordingSpoolRegistry, recordingSpoolReleaseSchema } from "./recording-spool"
import { createRecordingSessionOwner } from "./recording-session-owner"
import { createRecordingSpoolOrderEvidence } from "./recording-spool-evidence"
import { createFileCapabilityManager } from "./file-capabilities"
import { registerFileCapabilitiesIpc } from "./ipc/file-capabilities-ipc"
import { registerApplicationMenuIpc } from "./ipc/application-menu-ipc"
import { registerVstEditorStateAckIpc } from "./ipc/vst-editor-state-ack-ipc"
import { registerNativeSessionTransportIpc } from "./ipc/native-session-transport-ipc"
import { registerNativeSessionRecordingIpc } from "./ipc/native-session-recording-ipc"
import { nativeSessionRequestAllowed, type NativeSessionEvent } from "./ipc/native-session-access"
import { rendererSenderAllowed, type RendererSenderEvent } from "./ipc/renderer-sender"
import { createNativeFileCapabilityHelper } from "./native-file-capability-helper"
import { createPreparationRegistry } from "./preparation-registry"
import { desktopOperations } from "./desktop-operations"
import { canonicalVst3SearchPaths, createPluginCatalogStore } from "./plugin-catalog"
import { createVst3ScannerSupervisor } from "./vst3-scanner"
import { catalogViewForRenderer } from "./vst3-attachment"
import { preflightVst3Insertion } from "./vst3-insertion-preflight"
import {
  coordinateNativeVst3Attachments,
  createNativeVst3SessionLedger,
  nativeVst3CoordinationFailureReply,
  resolveNativeVst3AttachmentPlan,
} from "./native-vst3-coordinator"
import { createNativeVst3HostEventHandlers } from "./native-vst3-host-events"
import {
  nativeHostConfigurationIdentityFor,
  createNativeAudioHostSupervisor,
  renderNativeOffline,
  probeNativeAudioOutputDevice,
  nativeProcessorPatchReply,
  nativeSessionFailure,
  nativeVstEditorOwnershipProbe,
  type NativeVstEditorAnchor,
  type NativeVstEditorCommand,
} from "./audio-host"
import { createNativeVst3EditorSessionManager } from "./native-vst3-editor-session"
/* oxlint-disable eslint/no-restricted-imports -- desktop-audio-lifecycle needs the bridge types, which stay in src/types until the batch that owns the certification-pinned playback files moves it */
import {
  completeDesktopAudioRecovery,
  type DesktopAudioLifecycle,
} from "../../src/lib/desktop-audio-lifecycle"
/* oxlint-enable eslint/no-restricted-imports */
import { resolveNativeArtifacts, type NativeReleaseArtifactVerification } from "./native-artifacts"
import type {
  NativeAudioDevice,
  NativeHostDeviceConfiguration,
  NativeHostPcmAsset,
  NativeHostMappedAssetPage,
  NativeHostMeterBatch,
  NativeScheduleProgress,
  NativeOfflineRenderPlan,
} from "@daw-browser/audio-engine/native-host-wire"
import { stampGraphRevision } from "@daw-browser/audio-engine/native-host-wire"
import {
  decodeNativeExternalAttachmentPlan,
  maxVst3WorkerFrames,
  maxVst3WorkerSampleRateHz,
  maxVst3WorkerStateBytes,
  nativeVst3InsertionPreflightRequestSchema,
} from "@daw-browser/plugin-host-protocol"
import {
  nativeAudioHostMaximumMappedAssetPageBytes,
  nativeAudioHostMaximumPayloadBytes,
  nativeAudioHostMaximumSerializedPlanBytes,
  nativeAudioHostScheduleProgressBytes,
  nativeOfflineRenderPlanSchema,
} from "@daw-browser/desktop-protocol/native-audio-host"
import {
  createTrustedDesktopOriginPolicy,
} from "./permission-policy"

import { createNativeVstProjectBindings } from "./native-vst-project-bindings"
import { createApplicationMenuController } from "./application-menu"
import { createAe08Evidence, ae08StartTrace, ae08StopTrace } from "./ae08-evidence"
import { ae08RendererMarkChannel, ae08RendererMarkSchema } from "@daw-browser/desktop-protocol/acceptance-marks"
import { createOfflinePcmAckTracker } from "./offline-pcm-ack"
import { createMainWindow } from "./main-window"
import { installRendererContent } from "./renderer-content"
import { createControlSocket } from "./control-socket"
import { createRequestScopes } from "./request-scopes"
import { createRendererSession } from "./renderer-session"
import {
  createBenchmarkRecordingTelemetry,
  createBenchmarkStartupReporter,
  installBenchmarkHeartbeat,
} from "./benchmark-runtime"
import { offlinePcmAckSchema } from "./offline-pcm-protocol"
import { createRecordingStartDiagnostic } from "./recording-start-diagnostic"
import { desktopEnv } from "./env"

protocol.registerSchemesAsPrivileged([{ scheme: "daw", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])

const captureInhibited = desktopEnv.recordingStartDiagnostic()

const recordingStartDiagnostic = createRecordingStartDiagnostic(
  desktopEnv.recordingStartDiagnostic() || desktopEnv.recordingStartEvidence(),
  (event) => console.log("[recording-start-diagnostic]", JSON.stringify(event)),
)

const positiveUnsigned32Schema = unsigned32Schema.min(1)

const recoveryCompletionSchema = z.object({
  powerGeneration: z.number().int().safe(),
  result: z.enum(["ready", "failed"]),
}).passthrough()

const rendererMessageSchema = z.object({
  generation: z.number().int().safe(),
  frame: desktopFrameSchemaV1,
}).passthrough()

const offlineRenderRequestSchema = z.object({
  jobId: z.string().min(1).max(128),
  plan: nativeOfflineRenderPlanSchema,
}).passthrough()

const offlineMappedPageResponseSchema = z.object({
  jobId: z.string().min(1).max(128),
  requestId: requestIdSchema,
  page: z.object({
    sessionAssetId: positiveUnsigned32Schema,
    startFrame: z.number().int().nonnegative().safe(),
    frameCount: positiveUnsigned32Schema,
    planarPcm: z.instanceof(Uint8Array).refine((value) => (
      value.byteLength > 0
      && value.byteLength <= nativeAudioHostMaximumMappedAssetPageBytes
    )),
  }).strict().optional(),
  error: z.string().max(256).optional(),
}).strict().refine((value) => (value.page !== undefined) !== (value.error !== undefined))

const optionalDeviceIdSchema = z.string().optional()

const nativeSessionConfigurationSchema = z.object({
  deviceId: z.string(),
  sampleRateHz: unsigned32Schema,
  maxFramesPerBlock: unsigned32Schema,
  channelCount: unsigned32Schema,
  revision: unsigned32Schema,
}).passthrough()

const nativeAttachmentCoordinationSchema = z.object({
  projectId: projectIdSchemaV1,
  serializedPlan: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= nativeAudioHostMaximumSerializedPlanBytes),
  sampleRateHz: z.number().finite().positive().max(maxVst3WorkerSampleRateHz),
  requiredVstStateInstanceIds: z.array(uuidSchema).max(64).optional(),
  capturedVstStates: z.array(z.object({
    instanceId: uuidSchema,
    bytes: z.instanceof(Uint8Array).refine((value) => value.byteLength <= maxVst3WorkerStateBytes),
    sha256: sha256HexSchema,
  }).strict()).max(64).optional(),
}).passthrough()

const nativeUndefinedEnvelopeSchema = nativeSessionEnvelopeSchema(z.undefined())
const nativeEditorEnvelopeSchema = nativeSessionEnvelopeSchema(nativeEditorCommandSchema)
const nativeAttachmentEnvelopeSchema = nativeSessionEnvelopeSchema(nativeAttachmentCoordinationSchema)
const nativeConfigurationEnvelopeSchema = nativeSessionEnvelopeSchema(nativeSessionConfigurationSchema)
const pluginDirectorySchema = z.object({ directory: z.string() }).passthrough()


const diagnosticsTraceMessageSchema = z.object({
  stage: z.enum(["preload-received", "preload-handler", "controller-before-native", "controller-after-native", "controller-parsed", "preload-reply", "preload-reply-sent", "preload-reply-invalid", "preload-reply-invalid-path"]),
  elapsedMs: z.number().int().nonnegative().max(60_000),
  paths: z.string().max(512).regex(/^[a-z.,]*$/).optional(),
}).strict()

const appName = "daw-browser"

const sanitizeNativeVst3DiagnosticError = (error: Error | undefined) => {
  const message = error?.message ?? "The native VST editor session is unavailable."

  return message.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s]*/g, "<path>").slice(0, 256)
}

const sameAppOrigin = createTrustedDesktopOriginPolicy(MAIN_WINDOW_VITE_DEV_SERVER_URL)

let quitCleanupStarted = false

const evidenceDirectory = desktopEnv.ae08EvidenceDirectory()
const ae08Evidence = createAe08Evidence(evidenceDirectory)

const ae08WorkerEnvironment: NodeJS.ProcessEnv = evidenceDirectory
  ? { DAW_AE08_EVIDENCE_DIR: evidenceDirectory }
  : {}

const rendererSession = createRendererSession({ sameAppOrigin, ae08Evidence })

const applicationMenuController = createApplicationMenuController<Menu>({
  platform: process.platform === "darwin"
    ? "darwin"
    : process.platform === "win32"
      ? "win32"
      : "linux",
  sendCommand: (command: DesktopApplicationMenuMessage) => {
    rendererSession.send(applicationMenuCommandChannel, command)
  },
})

const preparationRegistry = createPreparationRegistry()
let nativeMediaAvailable = false
let pluginCatalogStore: ReturnType<typeof createPluginCatalogStore> | undefined
let audioHostPath: string | undefined
let vst3WorkerPath: string | undefined
let audioHostSupervisor: ReturnType<typeof createNativeAudioHostSupervisor> | undefined

let offlineRenderJob: {
  jobId: string
  controller: AbortController
  nextSequence: number
  mappedPageRequests: Map<string, {
    sessionAssetId: number
    startFrame: number
    frameCount: number
    channelCount: number
    resolve: (page: NativeHostMappedAssetPage) => void
    reject: (error: Error) => void
    cleanup: () => void
  }>
} | undefined

const maximumPendingOfflineMappedPageRequests = 4
const offlinePcmAcks = createOfflinePcmAckTracker()

const abortOfflineRenderJobs = () => {
  offlinePcmAcks.cancel(new DOMException("Native offline rendering canceled.", "AbortError"))
  offlineRenderJob?.controller.abort()
}

let nativeVst3EditorSessionManager: ReturnType<typeof createNativeVst3EditorSessionManager> | undefined
let audioLifecycle: DesktopAudioLifecycle = { state: "ready", powerGeneration: 0 }
let audioSuspendPromise: Promise<void> | undefined
let audioRecoveryGeneration: number | undefined
let vst3ScannerSupervisor: ReturnType<typeof createVst3ScannerSupervisor> | undefined

let nativeReleaseArtifactVerification: NativeReleaseArtifactVerification = { status: "disabled" }

let removeAudioHostLossListener: (() => void) | undefined
let removeAudioHostRecordingStatusListener: (() => void) | undefined
let removeAudioHostMeterBatchListener: (() => void) | undefined
let removeAudioHostSpectrumListener: (() => void) | undefined
let removeAudioHostScheduleProgressListener: (() => void) | undefined
let removeAudioHostWorkerNotificationListener: (() => void) | undefined
const activeEditorProjectBindings = createNativeVstProjectBindings()
const attachmentLedger = createNativeVst3SessionLedger()
const activeRendererTransactions = new Map<string, { generation: number; senderId: number }>()
const nativeFileCapabilityHelper = createNativeFileCapabilityHelper()

const recordingSessionOwner = createRecordingSessionOwner({
  diagnostic: recordingStartDiagnostic,
  captureInhibited,
  currentRendererGeneration: () => rendererSession.generation(),
  userData: () => app.getPath("userData"),
  verifyDirectory: nativeFileCapabilityHelper.statDirectory,
  sendToRenderer: (channel, value) => rendererSession.send(channel, value),
  statusChannel: recordingStatusChannel,
  failureChannel: recordingFailureChannel,
})

const fileCapabilities = createFileCapabilityManager({
  dialog: {
    showOpenDialog: (options) => dialog.showOpenDialog(options),
    showSaveDialog: (options) => dialog.showSaveDialog(options),
  },
  nativeHelper: nativeFileCapabilityHelper,
  nativeOutputEnabled: () => nativeMediaAvailable,
  privateTempDirectory: () => path.join(app.getPath("userData"), "output-temp"),
})

const scopes = createRequestScopes(fileCapabilities)

const controlSocket = createControlSocket({
  appName,
  rendererSession,
  preparationRegistry,
  fileCapabilities,
  scopes,
  ae08Evidence,
  availableOperations: () => desktopOperations(nativeMediaAvailable),
})

const publishAudioLifecycle = () => {
  rendererSession.send(lifecycleChannel, audioLifecycle)
}

const recoverAudioHost = (recoveryGeneration: number) => {
  if (audioRecoveryGeneration === recoveryGeneration) return
  audioRecoveryGeneration = recoveryGeneration
  void (async () => {
    try {
      await audioSuspendPromise

      if (audioLifecycle.state !== "suspended" || audioLifecycle.powerGeneration !== recoveryGeneration) return
      await audioHostSupervisor?.resume()
      await audioHostSupervisor?.start()

      if (audioLifecycle.state !== "suspended" || audioLifecycle.powerGeneration !== recoveryGeneration) return
      audioLifecycle = { state: "recovering", powerGeneration: recoveryGeneration }
      publishAudioLifecycle()
    } catch {
      if (audioLifecycle.state !== "suspended" || audioLifecycle.powerGeneration !== recoveryGeneration) return
      audioLifecycle = { state: "failed", powerGeneration: recoveryGeneration }
      publishAudioLifecycle()
    } finally {
      if (audioRecoveryGeneration === recoveryGeneration) audioRecoveryGeneration = undefined
    }
  })()
}

const invalidateRendererGeneration = (message: string) => {
  const invalidation = rendererSession.lifecycle.invalidateActiveDocument()

  if (!invalidation) return
  applyRendererInvalidation(invalidation, message)
}

const applyRendererInvalidation = (
  invalidation: { previousGeneration: number; generation: number },
  message: string,
) => {
  const previousGeneration = invalidation.previousGeneration
  rendererSession.advanceGeneration(invalidation.generation)
  recordingSessionOwner.invalidateRenderer()
  scopes.releaseImports()
  rendererSession.rejectEditorStateAcks(message)
  abortOfflineRenderJobs()
  applicationMenuController.reset()
  preparationRegistry.abortAll()
  scopes.settleCapabilityRevocation(fileCapabilities.revokeRendererGeneration(previousGeneration))

  for (const [token, transaction] of activeRendererTransactions) {
    if (transaction.generation !== previousGeneration) continue
    activeRendererTransactions.delete(token)

    try {
      activeEditorProjectBindings.rollback(token)
    } catch {
      // A newer staged transaction owns the binding registry.
    }
  }

  rendererSession.rejectAllPending(message)
  scopes.settleCapabilityRevocation(audioHostSupervisor?.invalidateManualTransaction() ?? Promise.resolve())
}

const registerIpc = () => {
  const senderAllowed = (event: RendererSenderEvent, options: { privileged: boolean; mainFrameOnly: boolean }) => rendererSenderAllowed(event, {
    rendererId: rendererSession.window()?.webContents.id,
    sameAppOrigin,
    privileged: { required: options.privileged, accepted: rendererSession.lifecycle.acceptsPrivilegedRequests() },
    mainFrameOnly: options.mainFrameOnly,
  })

  const applicationMenuStateAllowed = (event: RendererSenderEvent) => senderAllowed(event, { privileged: true, mainFrameOnly: true })

  registerApplicationMenuIpc({
    ipcMain,
    applicationMenuStateAllowed,
    applicationMenuController,
  })
  registerVstEditorStateAckIpc({
    ipcMain,
    allowed: applicationMenuStateAllowed,
    takePendingEditorStateAck: (requestId) => {
      const pending = rendererSession.editorStateAcks.get(requestId)

      if (pending) rendererSession.editorStateAcks.delete(requestId)

      return pending
    },
  })
  ipcMain.handle(lifecycleChannel, (event) => {
    if (!audioHostAllowed(event)) return { state: "failed" as const, powerGeneration: audioLifecycle.powerGeneration }

    return audioLifecycle
  })
  ipcMain.handle(recoveryCompleteChannel, (event, value) => {
    if (!audioHostAllowed(event)) return { accepted: false }
    const completionRequest = recoveryCompletionSchema.safeParse(value)

    if (!completionRequest.success) return { accepted: false }

    const completion = completeDesktopAudioRecovery(
      audioLifecycle,
      completionRequest.data.powerGeneration,
      completionRequest.data.result,
    )

    if (!completion.accepted) return { accepted: false }
    audioLifecycle = completion.lifecycle
    publishAudioLifecycle()

    return { accepted: true }
  })
  ipcMain.handle(recoveryRetryChannel, (event) => {
    if (!audioHostAllowed(event) || audioLifecycle.state !== "failed") return { accepted: false }
    audioLifecycle = {
      state: "suspended",
      powerGeneration: audioLifecycle.powerGeneration + 1,
    }
    recoverAudioHost(audioLifecycle.powerGeneration)

    return { accepted: true }
  })
  ipcMain.on(hostResponseChannel, (event, message) => {
    if (!senderAllowed(event, { privileged: false, mainFrameOnly: false })) return
    const parsed = rendererMessageSchema.safeParse(message)

    if (!parsed.success || parsed.data.generation !== rendererSession.generation()) return

    if (parsed.data.frame.type === "export-terminal") {
      scopes.exportTerminal(parsed.data.frame.jobId)

      return
    }

    if (parsed.data.frame.type === "import-terminal") {
      scopes.importTerminal(parsed.data.frame.jobId)

      return
    }

    if (parsed.data.frame.type !== "reply") return
    const pending = rendererSession.pending.get(parsed.data.frame.id)

    if (!pending || pending.generation !== parsed.data.generation) return
    const traceStart = rendererSession.diagnostics.starts.get(parsed.data.frame.id)

    if (traceStart !== undefined) rendererSession.diagnostics.trace.mark(traceStart, "renderer-reply")
    pending.resolve(parsed.data.frame)
  })
  ipcMain.on(diagnosticsV2TraceChannel, (event, message) => {
    if (!rendererSession.diagnostics.enabled || !senderAllowed(event, { privileged: false, mainFrameOnly: false })) return
    const parsed = diagnosticsTraceMessageSchema.safeParse(message)

    if (parsed.success) {
      if (parsed.data.stage === "preload-reply-invalid-path" && parsed.data.paths) console.error(`[diagnostics-v2-validation] paths=${parsed.data.paths}`)
      else console.error(`[diagnostics-v2-boundary] operation=diagnostics.snapshot.v2 stage=${parsed.data.stage} elapsedMs=${parsed.data.elapsedMs}`)
    }
  })

  const scopeAllowed = applicationMenuStateAllowed

  const scopeFor = (event: Electron.IpcMainInvokeEvent, requestId: string) => (
    scopeAllowed(event) ? { requestId, rendererGeneration: rendererSession.generation() } : undefined
  )

  const catalogAllowed = (event: Electron.IpcMainInvokeEvent) => (
    process.platform === "darwin"
    && senderAllowed(event, { privileged: true, mainFrameOnly: false })
    && pluginCatalogStore !== undefined
  )

  const catalogFailure = (message: string) => ({ ok: false as const, error: message })

  const catalogStoreFor = (event: Electron.IpcMainInvokeEvent) => (
    catalogAllowed(event) ? pluginCatalogStore : undefined
  )

  const audioHostAllowed = (event: NativeSessionEvent) => (
    rendererSession.window() !== undefined && nativeSessionRequestAllowed({
      platform: process.platform,
      architecture: process.arch,
      rendererId: rendererSession.window()?.webContents.id,
      acceptsPrivilegedRequests: rendererSession.lifecycle.acceptsPrivilegedRequests(),
      event,
      sameAppOrigin,
    })
  )

  if (ae08Evidence) ipcMain.on(ae08RendererMarkChannel, (event, message) => {
    const mark = ae08RendererMarkSchema.safeParse(message)

    if (mark.success && audioHostAllowed(event)) ae08Evidence(mark.data[0], { key: mark.data[1] })
  })
  installBenchmarkHeartbeat({
    app,
    ipcMain,
    allowed: (event) => audioHostAllowed(event) && event.senderFrame === event.sender.mainFrame,
  })
  ipcMain.on(offlinePcmAckChannel, (event, value) => {
    if (!audioHostAllowed(event)) return
    const parsed = offlinePcmAckSchema.safeParse(value)

    if (!parsed.success) {
      offlinePcmAcks.cancel(new Error("The native offline PCM acknowledgement is invalid."))

      return
    }

    offlinePcmAcks.acknowledge(parsed.data)
  })
  ipcMain.handle(offlineMappedPageResponseChannel, (event, value) => {
    if (!audioHostAllowed(event)) return { accepted: false }
    const parsed = offlineMappedPageResponseSchema.safeParse(value)

    if (!parsed.success || !offlineRenderJob || parsed.data.jobId !== offlineRenderJob.jobId) {
      return { accepted: false }
    }

    const pending = offlineRenderJob.mappedPageRequests.get(parsed.data.requestId)

    if (!pending) return { accepted: false }

    if (parsed.data.page && (
      parsed.data.page.sessionAssetId !== pending.sessionAssetId
      || parsed.data.page.startFrame !== pending.startFrame
      || parsed.data.page.frameCount !== pending.frameCount
      || parsed.data.page.planarPcm.byteLength
        !== pending.frameCount * pending.channelCount * Float32Array.BYTES_PER_ELEMENT
    )) {
      offlineRenderJob.mappedPageRequests.delete(parsed.data.requestId)
      pending.cleanup()
      pending.reject(new Error("The native offline mapped page response does not match its request."))

      return { accepted: false }
    }

    offlineRenderJob.mappedPageRequests.delete(parsed.data.requestId)
    pending.cleanup()

    if (parsed.data.error) pending.reject(new Error(parsed.data.error))
    else if (parsed.data.page) pending.resolve(parsed.data.page)
    else pending.reject(new Error("The offline mapped page response is invalid."))

    return { accepted: true }
  })

  const offlinePlan = (value: NativeOfflineRenderPlan): NativeOfflineRenderPlan | undefined => {
    for (const state of value.capturedVstStates ?? []) {
      if (createHash("sha256").update(state.bytes).digest("hex") !== state.sha256) return undefined
    }

    return value
  }

  ipcMain.handle(offlineRenderChannel, async (event, value) => {
    if (!audioHostAllowed(event) || !audioHostPath) {
      return { ok: false as const, error: "The native offline renderer is unavailable." }
    }

    const request = offlineRenderRequestSchema.safeParse(value)

    if (!request.success) {
      return { ok: false as const, error: "The native offline renderer is unavailable." }
    }

    const jobId = request.data.jobId
    const plan = offlinePlan(request.data.plan)

    if (!plan) {
      return { ok: false as const, error: "The native offline render plan is invalid." }
    }

    if (offlineRenderJob?.jobId === jobId) {
      return { ok: false as const, error: "An offline render with this job ID is already active." }
    }

    if (offlineRenderJob) {
      return { ok: false as const, error: "Only one native offline render may be active at a time." }
    }

    const controller = new AbortController()
    const cancelOnDestroy = () => controller.abort()
    event.sender.once("destroyed", cancelOnDestroy)

    const job = {
      jobId,
      controller,
      nextSequence: 1,
      mappedPageRequests: new Map<string, {
        sessionAssetId: number
        startFrame: number
        frameCount: number
        channelCount: number
        resolve: (page: NativeHostMappedAssetPage) => void
        reject: (error: Error) => void
        cleanup: () => void
      }>(),
    }

    offlineRenderJob = job

    try {
      let vstAttachments: Awaited<ReturnType<typeof resolveNativeVst3AttachmentPlan>> | undefined

      if (plan.externalAttachments) {
        if (!pluginCatalogStore || !vst3WorkerPath) {
          throw new Error("The trusted native VST3 catalog or worker is unavailable.")
        }

        vstAttachments = await resolveNativeVst3AttachmentPlan({
          plan: plan.externalAttachments,
          sampleRateHz: plan.sampleRateHz,
          workerPath: vst3WorkerPath,
          catalogStore: pluginCatalogStore,
          capturedVstStates: new Map(
            (plan.capturedVstStates ?? []).map((state) => [state.instanceId, state]),
          ),
          signal: controller.signal,
        })
      }

      await renderNativeOffline({
        hostPath: audioHostPath,
        jobId,
        plan,
        vstAttachments,
        signal: controller.signal,
        onMappedPage: (request, signal) => new Promise((resolve, reject) => {
          if (job.mappedPageRequests.size >= maximumPendingOfflineMappedPageRequests) {
            reject(new Error("Too many native offline mapped page requests are pending."))

            return
          }

          if (job.mappedPageRequests.has(request.requestId)) {
            reject(new Error("The native offline mapped page request ID is duplicated."))

            return
          }

          const cleanup = () => signal.removeEventListener("abort", abort)

          const abort = () => {
            if (job.mappedPageRequests.get(request.requestId)?.cleanup !== cleanup) return
            job.mappedPageRequests.delete(request.requestId)
            reject(new DOMException("Native offline mapped page request canceled.", "AbortError"))
          }

          job.mappedPageRequests.set(request.requestId, {
            sessionAssetId: request.asset.sessionAssetId,
            startFrame: request.startFrame,
            frameCount: request.frameCount,
            channelCount: request.asset.channelCount,
            resolve,
            reject,
            cleanup,
          })
          signal.addEventListener("abort", abort, { once: true })

          if (!rendererSession.send(offlineMappedPageRequestChannel, request)) {
            job.mappedPageRequests.delete(request.requestId)
            cleanup()
            reject(new Error("Renderer unavailable."))
          }
        }),
        onChunk: (chunk) => {
          if (offlineRenderJob !== job) throw new Error("The native offline render is no longer active.")
          const sequence = job.nextSequence
          job.nextSequence += 1
          const endFrame = chunk.startFrame + chunk.frameCount
          const acknowledgment = offlinePcmAcks.begin({ jobId, sequence, endFrame })

          if (!rendererSession.send(offlinePcmChannel, { jobId, sequence, chunk })) {
            offlinePcmAcks.cancel(new Error("Renderer unavailable."))
          }

          return acknowledgment
        },
      })

      return { ok: true as const }
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : "Native offline rendering failed." }
    } finally {
      for (const pending of job.mappedPageRequests.values()) {
        pending.cleanup()
        pending.reject(new Error("The native offline render is no longer active."))
      }

      job.mappedPageRequests.clear()
      offlinePcmAcks.cancel(new Error("The native offline render is no longer active."))
      event.sender.removeListener("destroyed", cancelOnDestroy)

      if (offlineRenderJob === job) offlineRenderJob = undefined
    }
  })
  ipcMain.handle(offlineCancelChannel, (event, value) => {
    if (!audioHostAllowed(event)) return { accepted: false }
    const jobId = z.string().min(1).max(128).safeParse(value)

    if (!jobId.success) return { accepted: false }

    if (!offlineRenderJob || offlineRenderJob.jobId !== jobId.data) return { accepted: false }
    offlineRenderJob.controller.abort()

    return { accepted: true }
  })
  let configuredHost: { pid: number; generation: number; configurationGeneration: number } | undefined

  const configurationGenerationFor = (host: { pid?: number; generation: number }) => {
    configuredHost = nativeHostConfigurationIdentityFor(configuredHost, host)

    return configuredHost?.configurationGeneration
  }

  ipcMain.handle(diagnosticsChannel, async (event) => {
    if (!audioHostAllowed(event) || !audioHostSupervisor) {
      return {
        ok: false,
        error: "The native audio host is unavailable.",
        artifactVerification: nativeReleaseArtifactVerification,
      }
    }

    try {
      const hello = await audioHostSupervisor.start()
      const diagnostics = await audioHostSupervisor.diagnostics()
      const status = audioHostSupervisor.status()
      const configurationGeneration = configurationGenerationFor(status)

      if (configurationGeneration === undefined) throw new Error("The native audio host identity is unavailable.")

      return {
        ok: true,
        hello,
        status,
        configurationGeneration,
        diagnostics,
        artifactVerification: nativeReleaseArtifactVerification,
      }
    } catch {
      return {
        ok: false,
        error: "The native audio host is unavailable.",
        artifactVerification: nativeReleaseArtifactVerification,
      }
    }
  })
  ipcMain.handle(resolveOutputDeviceChannel, async (event, value) => {
    if (!audioHostAllowed(event) || !audioHostSupervisor) {
      return { ok: false as const, error: "The native audio host is unavailable." }
    }

    const deviceId = optionalDeviceIdSchema.safeParse(value)

    if (!deviceId.success) {
      return { ok: false as const, error: "The native audio host is unavailable." }
    }

    try {
      return { ok: true as const, device: await audioHostSupervisor.resolveOutputDevice(deviceId.data) }
    } catch {
      return { ok: false as const, error: "The native audio host is unavailable." }
    }
  })
  ipcMain.handle(resolveInputDeviceChannel, async (event, value) => {
    if (!audioHostAllowed(event) || !audioHostSupervisor) {
      return { ok: false as const, error: "The native audio host is unavailable." }
    }

    const deviceId = optionalDeviceIdSchema.safeParse(value)

    if (!deviceId.success) {
      return { ok: false as const, error: "The native audio host is unavailable." }
    }

    try {
      return { ok: true as const, device: await audioHostSupervisor.resolveInputDevice(deviceId.data) }
    } catch {
      return { ok: false as const, error: "The native audio host is unavailable." }
    }
  })
  ipcMain.handle(listDevicesChannel, async (event): Promise<{ ok: true; devices: NativeAudioDevice[] } | { ok: false; error: string }> => {
    if (!audioHostAllowed(event) || !audioHostSupervisor) {
      return { ok: false, error: "The native audio host is unavailable." }
    }

    try {
      return { ok: true, devices: await audioHostSupervisor.listDevices() }
    } catch {
      return { ok: false, error: "The native audio host is unavailable." }
    }
  })

  const sessionSupervisorFor = (event: Electron.IpcMainInvokeEvent) => (
    audioHostAllowed(event) ? audioHostSupervisor : undefined
  )

  // One handler shape for the envelope operations: authorize the sender, parse the request, run, reply ok or the failure.
  const registerNativeSessionOperation = <Value>(
    operation: { channel: string; request: z.ZodType<{ value: Value; transactionToken?: string | undefined }> },
    run: (supervisor: NonNullable<typeof audioHostSupervisor>, value: Value, transactionToken?: string) => Promise<void>,
  ) => ipcMain.handle(operation.channel, async (event, value) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = operation.request.safeParse(value)

    if (!supervisor || !envelope.success) return nativeSessionFailure()

    try {
      await run(supervisor, envelope.data.value, envelope.data.transactionToken)

      return { ok: true as const }
    } catch (error) {
      return nativeSessionFailure(error)
    }
  })

  const nativeSessionConfiguration = (
    value: z.infer<typeof nativeSessionConfigurationSchema>,
  ): NativeHostDeviceConfiguration => {
    return {
      deviceId: value.deviceId,
      sampleRateHz: value.sampleRateHz,
      maxFramesPerBlock: value.maxFramesPerBlock,
      channelCount: value.channelCount,
      revision: value.revision,
    }
  }

  const nativeSessionAsset = (
    value: z.infer<typeof nativeSessionAssetSchema>,
  ): NativeHostPcmAsset => {
    return {
      sessionAssetId: value.sessionAssetId,
      frameCount: value.frameCount,
      sampleRateHz: value.sampleRateHz,
      channelCount: value.channelCount,
      planarPcm: value.planarPcm,
      contentHashPrefix: value.contentHashPrefix,
    }
  }

  const nativeEditorAnchor = (
    event: Electron.IpcMainInvokeEvent,
    value: z.infer<typeof nativeEditorCommandSchema>,
  ): NativeVstEditorAnchor | null | undefined => {
    if (!value.anchor) return undefined
    const ownerWindow = BrowserWindow.fromWebContents(event.sender)

    if (!ownerWindow) return null
    const contentBounds = ownerWindow.getContentBounds()
    const zoomFactor = event.sender.getZoomFactor()
    const x = Math.round(contentBounds.x + value.anchor.x * zoomFactor)
    const y = Math.round(contentBounds.y + value.anchor.y * zoomFactor)

    if (
      !Number.isSafeInteger(x)
      || !Number.isSafeInteger(y)
      || x < -0x8000_0000
      || x > 0x7fff_ffff
      || y < -0x8000_0000
      || y > 0x7fff_ffff
    ) return null

    return { x, y }
  }

  let revisionProjectOwner: { projectId: string; rendererGeneration: number; hostGeneration: number } | undefined
  ipcMain.handle(sessionConfigureChannel, async (event, value) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = nativeConfigurationEnvelopeSchema.safeParse(value)

    if (!supervisor || !envelope.success) return nativeSessionFailure()
    const configuration = nativeSessionConfiguration(envelope.data.value)

    const configuredProject = event.senderFrame === event.sender.mainFrame
      ? new URL(event.senderFrame.url).searchParams.get("projectId") : null

    const configuredRendererGeneration = rendererSession.generation()

    try {
      await supervisor.configure(configuration, envelope.data.transactionToken)

      if (configuredProject && configuredRendererGeneration === rendererSession.generation() && audioHostAllowed(event)
        && event.senderFrame === event.sender.mainFrame
        && new URL(event.senderFrame.url).searchParams.get("projectId") === configuredProject) {
        revisionProjectOwner = { projectId: configuredProject, rendererGeneration: rendererSession.generation(),
          hostGeneration: supervisor.status().generation }
      } else revisionProjectOwner = undefined
      const host = supervisor.status()

      if (host.pid === undefined) return nativeSessionFailure()
      const currentGeneration = configurationGenerationFor(host)

      if (currentGeneration === undefined) return nativeSessionFailure()
      const configurationGeneration = currentGeneration + 1
      configuredHost = { pid: host.pid, generation: host.generation, configurationGeneration }

      return { ok: true, hostIdentity: { pid: host.pid, generation: host.generation, configurationGeneration } }
    } catch (error) {
      return nativeSessionFailure(error)
    }
  })
  registerNativeSessionOperation(nativeSessionOperations.installAsset, (supervisor, asset, token) => supervisor.installAsset(nativeSessionAsset(asset), token))
  registerNativeSessionOperation(nativeSessionOperations.releaseAsset, (supervisor, sessionAssetId, token) => supervisor.releaseAsset(sessionAssetId, token))
  registerNativeSessionOperation(nativeSessionOperations.createMappedAsset, (supervisor, asset, token) => supervisor.createMappedAsset(asset, token))
  registerNativeSessionOperation(nativeSessionOperations.writeMappedAssetPage, (supervisor, page, token) => supervisor.writeMappedAssetPage(page, token))
  registerNativeSessionOperation(nativeSessionOperations.prepareMappedAssetRange, (supervisor, range, token) => (
    supervisor.prepareMappedAssetRange(range.sessionAssetId, range.startFrame, range.frameCount, token)
  ))
  registerNativeSessionOperation(nativeSessionOperations.releaseMappedAsset, (supervisor, sessionAssetId, token) => supervisor.releaseMappedAsset(sessionAssetId, token))
  registerNativeSessionOperation(nativeSessionOperations.detachVst, async (supervisor, instanceId, token) => {
    await supervisor.detachVst(instanceId, token)
    activeEditorProjectBindings.remove(instanceId, token)
  })
  ipcMain.handle(sessionGetVstStateChannel, async (event, value) => {
    const supervisor = sessionSupervisorFor(event)
    const instanceId = uuidSchema.safeParse(value)

    if (!supervisor || !instanceId.success) return { ok: false as const, error: "The native VST state request is invalid." }

    try {
      const state = await supervisor.getVstState(instanceId.data)

      if (
        state.bytes.byteLength > maxVst3WorkerStateBytes
        || !sha256HexPattern.test(state.sha256)
        || createHash("sha256").update(state.bytes).digest("hex") !== state.sha256
      ) return { ok: false as const, error: "The native VST state response is invalid." }
      attachmentLedger.capturedFromLive(instanceId.data, state.sha256)

      return { ok: true as const, bytes: state.bytes, sha256: state.sha256 }
    } catch (error) {
      return nativeSessionFailure(error)
    }
  })
  ipcMain.handle(sessionEditorChannel, async (event, rawValue) => {
    const envelope = nativeEditorEnvelopeSchema.safeParse(rawValue)
    const allowed = audioHostAllowed(event)

    const activeHostCandidate = allowed && audioHostSupervisor?.status().running
      ? audioHostSupervisor
      : undefined

    const manager = allowed ? nativeVst3EditorSessionManager : undefined

    if ((!manager && !activeHostCandidate) || !envelope.success) {
      return { ok: false as const, error: "The native VST editor command is invalid." }
    }

    const value = envelope.data.value
    const anchor = nativeEditorAnchor(event, value)

    if (anchor === null) {
      return { ok: false as const, error: "The native VST editor command is invalid." }
    }

    try {
      const editorCommand: NativeVstEditorCommand = value.command
      const projectId = value.projectId

      const command = {
        projectId,
        instanceId: value.instanceId,
        command: editorCommand,
        serializedPlan: value.serializedPlan,
        initialState: value.initialState,
        requiresState: value.requiresState,
        captureState: value.captureState,
        width: value.width,
        height: value.height,
        anchor,
      }

      // Prefer the isolated editor host. A plug-in editor can allocate UI or
      // runtime state outside the realtime graph, so its failure should remain
      // independent from playback whenever the isolated manager is available.
      if (manager) {
        const status = await manager.execute(command)

        // The editor session does not read an instance playback owns, so a close of one reaches the renderer as
        // the closed event, which captures from the playback worker.
        if (command.command === "close") rendererSession.send(vstEditorStateChannel, { projectId, instanceId: command.instanceId, open: false })

        return { ok: true as const, status }
      }

      if (activeHostCandidate) {
        try {
          if (activeHostCandidate.transactionOpen() && !envelope.data.transactionToken) {
            throw new Error("The native audio host transaction token is required.")
          }

          const boundProjectId = activeEditorProjectBindings.projectFor(command.instanceId)

          if (boundProjectId !== undefined && boundProjectId !== projectId) {
            throw new Error("The active native VST editor project binding changed.")
          }

          if (boundProjectId === undefined) throw new Error("The active native VST editor is not owned by a committed project binding.")

          const ownership = await activeHostCandidate.executeVstEditorCommand(
            nativeVstEditorOwnershipProbe(command.instanceId),
            envelope.data.transactionToken,
          )

          if (!ownership.owned) throw new Error("The active native VST editor is not owned by the committed project binding.")

          const {
            projectId: _projectId,
            initialState: _initialState,
            requiresState: _requiresState,
            captureState: _captureState,
            ...nativeCommand
          } = command

          const capturedState = command.command === "close"
            ? await activeHostCandidate.getVstState(command.instanceId)
            : undefined

          let status = command.command === "status"
            ? ownership
            : undefined

          if (status === undefined) {
            try {
              status = await activeHostCandidate.executeVstEditorCommand(nativeCommand, envelope.data.transactionToken)
            } catch (error) {
              if (command.command !== "close") throw error
              status = {
                ...ownership,
                success: false,
                open: false,
                closeError: error instanceof Error ? error.message : "The native editor close command failed.",
              }
            }
          }

          if (command.command !== "close") return { ok: true as const, status }

          return { ok: true as const, status: { ...status, capturedState } }
        } catch (error) {
          console.error("[native-vst3] editor active route failed", {
            error: sanitizeNativeVst3DiagnosticError(error instanceof Error ? error : undefined),
          })
          throw error
        }
      }

      return { ok: false as const, error: "The native VST editor session is unavailable." }
    } catch (error) {
      console.error("[native-vst3] editor command failed", {
        error: sanitizeNativeVst3DiagnosticError(error instanceof Error ? error : undefined),
      })

      return {
        ok: false as const,
        error: sanitizeNativeVst3DiagnosticError(error instanceof Error ? error : undefined),
      }
    }
  })
  // What this native session has attached, so a live plan reaches the host as a delta. Every session begins in a
  // transaction, which starts a ledger; a live coordination (no transaction) continues it.
  ipcMain.handle(sessionCoordinateVstAttachmentsChannel, async (event, value) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = nativeAttachmentEnvelopeSchema.safeParse(value)
    const workerPath = vst3WorkerPath

    if (
      !supervisor
      || !pluginCatalogStore
      || !workerPath
      || !envelope.success
    ) return nativeSessionFailure()
    const sessionValue = envelope.data.value
    let result: Awaited<ReturnType<typeof coordinateNativeVst3Attachments>>
    const hostHello = supervisor.status().hello

    if (!hostHello) return nativeSessionFailure()
    const ledger = attachmentLedger.forHost(supervisor, hostHello)

    try {
      result = await coordinateNativeVst3Attachments({
        serializedPlan: sessionValue.serializedPlan,
        sampleRateHz: sessionValue.sampleRateHz,
        workerPath,
        catalogStore: pluginCatalogStore,
        audioHost: supervisor,
        ledger,
        transactionToken: envelope.data.transactionToken,
        capturedVstStates: new Map(
          (sessionValue.capturedVstStates ?? []).map((state) => [state.instanceId, state]),
        ),
        requiredVstStateInstanceIds: new Set(sessionValue.requiredVstStateInstanceIds ?? []),
        evidence: ae08Evidence,
        workerEnvironment: ae08WorkerEnvironment,
      })
    } catch (error) {
      activeEditorProjectBindings.rollback(envelope.data.transactionToken)

      return nativeSessionFailure(error)
    }

    if (!result.ok) {
      activeEditorProjectBindings.rollback(envelope.data.transactionToken)

      return nativeVst3CoordinationFailureReply(result)
    }

    try {
      const plan = decodeNativeExternalAttachmentPlan(sessionValue.serializedPlan)
      const projectId = projectIdSchemaV1.parse(sessionValue.projectId)
      activeEditorProjectBindings.stage(
        plan.attachments.map((attachment) => attachment.instanceId),
        projectId,
        envelope.data.transactionToken,
      )

      // A live plan has no transaction to commit it: the project owns these instances from now.
      if (envelope.data.transactionToken === undefined) activeEditorProjectBindings.commit()

      return { ok: true as const }
    } catch {
      activeEditorProjectBindings.rollback(envelope.data.transactionToken)

      return nativeSessionFailure()
    }
  })

  // Internal session-only revision lifecycle, never a desktop protocol operation.
  // The authenticated main frame must still own the mounted project at reply.
  const revisionChannels = {
    prepare: sessionPrepareGraphRevisionChannel, publish: sessionPublishGraphRevisionChannel,
    inspect: sessionInspectGraphRevisionChannel, rollback: sessionRollbackGraphRevisionChannel,
    retire: sessionRetireGraphRevisionChannel,
  }

  const revisionBinding = z.object({ projectId: projectIdSchemaV1 })

  const revisionRequest = revisionBinding.extend({
    revision: positiveUnsigned32Schema,
    hostGeneration: unsigned32Schema,
    requestedPublicationFrame: z.bigint().nonnegative().max(0x7fff_ffff_ffff_ffffn).optional(),
  }).strict()

  const revisionPrepare = revisionBinding.extend({
    bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength >= 36 && bytes.byteLength <= nativeAudioHostMaximumPayloadBytes),
    projectRevision: z.number().int().nonnegative().safe(),
    requestedPublicationFrame: z.bigint().nonnegative().max(0x7fff_ffff_ffff_ffffn).optional(),
  }).strict()

  const ownsRevisionProject = (event: Electron.IpcMainInvokeEvent, projectId: string) => {
    if (!audioHostAllowed(event) || event.senderFrame !== event.sender.mainFrame) return false

    if (revisionProjectOwner?.projectId !== projectId || revisionProjectOwner.rendererGeneration !== rendererSession.generation()
      || revisionProjectOwner.hostGeneration !== audioHostSupervisor?.status().generation) return false

    try { return new URL(event.senderFrame.url).searchParams.get("projectId") === projectId }
    catch { return false }
  }

  for (const [operation, channel] of Object.entries(revisionChannels)) {
    ipcMain.handle(channel, async (event, raw) => {
      const supervisor = sessionSupervisorFor(event)
      const parsed = (operation === "prepare" ? revisionPrepare : revisionRequest).safeParse(raw)

      if (!supervisor || !parsed.success || !ownsRevisionProject(event, parsed.data.projectId)
        || supervisor.transactionOpen() || !supervisor.status().running) return nativeSessionFailure()
      const owner = supervisor.status(), rendererGeneration = rendererSession.generation()

      if (operation === "inspect") ae08Evidence?.("inspect-handler-entry", { pid: owner.pid ?? null })
      const sendsAtEntry = ae08Evidence?.rendererSendCount() ?? 0

      try {
        let result

        if ("bytes" in parsed.data) {
          const revision = supervisor.allocateRuntimeRevision()
          ae08Evidence?.("revision-allocate", { pid: owner.pid ?? null, lifecycleGeneration: owner.generation,
            runtimeRevision: revision, projectRevision: parsed.data.projectRevision })
          result = await supervisor.prepareGraphRevision(stampGraphRevision(parsed.data.bytes, revision), parsed.data.requestedPublicationFrame ?? 0n)
        } else {
          if (parsed.data.hostGeneration !== owner.generation) return nativeSessionFailure()
          const revision = parsed.data.revision
          result = operation === "publish" ? await supervisor.publishGraphRevision(
            revision, parsed.data.requestedPublicationFrame ?? 0n,
          )
            : operation === "inspect" ? await supervisor.inspectGraphRevision(revision)
            : operation === "rollback" ? await supervisor.rollbackGraphRevision(revision)
            : await supervisor.retireGraphRevision(revision)
        }

        if (result.status === "published") attachmentLedger.published()

        if (operation === "rollback") attachmentLedger.rolledBack()
        const current = supervisor.status()

        if (rendererSession.generation() !== rendererGeneration || current.generation !== owner.generation
          || current.pid !== owner.pid || !ownsRevisionProject(event, parsed.data.projectId)) {
          // The command ran, but this renderer no longer owns its result: it may have been taken.
          return nativeSessionFailure(new Error("The native audio session changed owner during the request."))
        }

        if (operation === "inspect") ae08Evidence?.("inspect-handler-return", { pid: current.pid ?? null,
          rendererSends: (ae08Evidence?.rendererSendCount() ?? 0) - sendsAtEntry })

        return { ok: true, revision: result, hostGeneration: current.generation, hostPid: current.pid }
      } catch (error) { return nativeSessionFailure(error) }
    })
  }

  registerNativeSessionOperation(nativeSessionOperations.publishGraph, (supervisor, bytes, token) => supervisor.publishGraph(bytes, token))
  registerNativeSessionOperation(nativeSessionOperations.configureInstrumentStates, (supervisor, bytes, token) => supervisor.configureInstrumentStates(bytes, token))
  registerNativeSessionOperation(nativeSessionOperations.queueParameterEvents, (supervisor, bytes, token) => supervisor.queueParameterEvents(bytes, token))
  ipcMain.handle(nativeSessionOperations.queueProcessorStatePatch.channel, async (event, value) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = nativeSessionOperations.queueProcessorStatePatch.request.safeParse(value)

    if (!supervisor || !envelope.success) return nativeSessionFailure()

    try {
      return nativeProcessorPatchReply(await supervisor.queueProcessorStatePatch(envelope.data.value, envelope.data.transactionToken))
    } catch (error) {
      return nativeSessionFailure(error)
    }
  })
  registerNativeSessionOperation(nativeSessionOperations.queueVstParameterEvents, (supervisor, bytes, token) => supervisor.queueVstParameterEvents(bytes, token))
  registerNativeSessionOperation(nativeSessionOperations.queueInstrumentEvents, (supervisor, bytes, token) => supervisor.queueInstrumentEvents(bytes, token))
  registerNativeSessionOperation(nativeSessionOperations.queueScheduleWindow, (supervisor, bytes, token) => supervisor.queueScheduleWindow(bytes, token))
  registerNativeSessionOperation(nativeSessionOperations.reenableVstScheduleAutomation, (supervisor, bytes, token) => supervisor.reenableVstScheduleAutomation(bytes, token))
  registerNativeSessionOperation(nativeSessionOperations.queueSourceEvents, (supervisor, bytes, token) => supervisor.queueSourceEvents(bytes, token))
  registerNativeSessionTransportIpc({
    ipcMain,
    allowed: audioHostAllowed,
    supervisor: () => audioHostSupervisor,
    fail: nativeSessionFailure,
  })
  registerNativeSessionRecordingIpc({
    ipcMain,
    allowed: audioHostAllowed,
    supervisor: () => audioHostSupervisor,
    owner: recordingSessionOwner,
    rendererGeneration: () => rendererSession.generation(),
    hostGeneration: () => audioLifecycle.powerGeneration,
    fail: nativeSessionFailure,
  })
  const spoolScopeSchema = z.object({ projectId: projectIdSchemaV1, projectGeneration: unsigned32Schema }).strict()
  const spoolTakeIdSchema = z.string().uuid()

  const spoolFor = (event: Electron.IpcMainInvokeEvent) => {
    if (!audioHostAllowed(event) || event.senderFrame !== event.sender.mainFrame)
      throw new Error("Recording spool is unavailable.")

    return recordingSessionOwner.spool()
  }

  ipcMain.handle(recordingSpoolListChannel, async (event, value) => {
    const request = z.object({ scope: spoolScopeSchema, cursor: spoolTakeIdSchema.optional() }).strict().parse(value)
    const registry = spoolFor(event)
    const scope = { ...request.scope, rendererGeneration: rendererSession.generation() }
    // Explicitly caller-declared scope, bound to the authenticated top-level
    // lifecycle. No invented cloud-project authorization is performed here.
    registry.bind(scope)

    return registry.list(scope, request.cursor)
  })
  ipcMain.handle(recordingSpoolReadChannel, async (event, value) => {
    const request = z.object({ scope: spoolScopeSchema, takeId: spoolTakeIdSchema,
      offset: z.number().int().nonnegative().safe(), length: z.number().int().min(1).max(recordingSpoolMaximumReadBytes) }).strict().parse(value)

    return spoolFor(event).read({ ...request.scope, rendererGeneration: rendererSession.generation() }, request.takeId, request.offset, request.length)
  })
  ipcMain.handle(recordingSpoolReleaseChannel, async (event, value) => {
    const request = z.object({ scope: spoolScopeSchema, takeId: spoolTakeIdSchema, acknowledgment: recordingSpoolReleaseSchema }).strict().parse(value)
    await spoolFor(event).release({ ...request.scope, rendererGeneration: rendererSession.generation() }, request.takeId, request.acknowledgment)
  })

  const registerNativeSessionControl = (
    channel: string,
    operation: (supervisor: NonNullable<typeof audioHostSupervisor>) => Promise<void>,
  ) => ipcMain.handle(channel, async (event) => {
    const supervisor = sessionSupervisorFor(event)

    if (!supervisor) return nativeSessionFailure()

    try {
      await operation(supervisor)

      return { ok: true as const }
    } catch (error) {
      return nativeSessionFailure(error)
    }
  })

  ipcMain.handle(sessionBeginTransactionChannel, async (event, value) => {
    const supervisor = sessionSupervisorFor(event)

    if (!supervisor || !nativeUndefinedEnvelopeSchema.safeParse(value).success) return nativeSessionFailure()
    const requestGeneration = rendererSession.generation()
    const senderId = event.sender.id

    try {
      const transactionToken = await supervisor.beginTransaction()
      attachmentLedger.begin()

      if (
        rendererSession.generation() !== requestGeneration
        || rendererSession.window()?.webContents.id !== senderId
        || !audioHostAllowed(event)
      ) {
        await supervisor.invalidateManualTransaction()

        return nativeSessionFailure()
      }

      activeEditorProjectBindings.stageEmpty(transactionToken)
      activeRendererTransactions.set(transactionToken, { generation: requestGeneration, senderId })

      return { ok: true as const, transactionToken }
    } catch (error) {
      return nativeSessionFailure(error)
    }
  })
  ipcMain.handle(sessionCommitTransactionChannel, async (event, value) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = nativeUndefinedEnvelopeSchema.safeParse(value)

    if (!supervisor || !envelope.success || !envelope.data.transactionToken) return nativeSessionFailure()
    const transaction = activeRendererTransactions.get(envelope.data.transactionToken)

    if (
      !transaction
      || transaction.generation !== rendererSession.generation()
      || transaction.senderId !== event.sender.id
      || !audioHostAllowed(event)
    ) return nativeSessionFailure()

    try {
      await supervisor.commitTransaction(envelope.data.transactionToken)
      activeRendererTransactions.delete(envelope.data.transactionToken)
      activeEditorProjectBindings.commit(envelope.data.transactionToken)
      attachmentLedger.published()

      return { ok: true as const }
    } catch (error) {
      activeRendererTransactions.delete(envelope.data.transactionToken)
      activeEditorProjectBindings.rollback(envelope.data.transactionToken)

      return nativeSessionFailure(error)
    }
  })
  ipcMain.handle(sessionRollbackTransactionChannel, async (event, value) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = nativeUndefinedEnvelopeSchema.safeParse(value)

    if (!supervisor || !envelope.success || !envelope.data.transactionToken) return nativeSessionFailure()
    const transaction = activeRendererTransactions.get(envelope.data.transactionToken)

    if (
      !transaction
      || transaction.generation !== rendererSession.generation()
      || transaction.senderId !== event.sender.id
      || !audioHostAllowed(event)
    ) return nativeSessionFailure()

    try {
      await supervisor.rollbackTransaction(envelope.data.transactionToken)
      attachmentLedger.rolledBack()

      return { ok: true as const }
    } catch (error) {
      return nativeSessionFailure(error)
    } finally {
      activeRendererTransactions.delete(envelope.data.transactionToken)
      activeEditorProjectBindings.rollback(envelope.data.transactionToken)
    }
  })
  registerNativeSessionControl(sessionStartChannel, (supervisor) => supervisor.startAudio())
  ipcMain.handle(sessionStopChannel, async (event, rawReason) => {
    const supervisor = sessionSupervisorFor(event)

    const envelope = nativeSessionEnvelopeSchema(z.string().trim().min(1).max(120)
      .refine((reason) => Buffer.byteLength(reason, "utf8") <= 120)).safeParse(rawReason)

    if (!supervisor || !envelope.success || envelope.data.transactionToken !== undefined) return nativeSessionFailure()

    try {
      console.info("[native-audio-session-stop]", JSON.stringify({
        reason: envelope.data.value,
        timestamp: Date.now(),
        generation: supervisor.status().generation,
        pid: supervisor.status().pid ?? null,
      }))
      await supervisor.stopAudio(envelope.data.value)

      return { ok: true as const }
    } catch (error) {
      return nativeSessionFailure(error)
    }
  })
  registerNativeSessionControl(sessionCancelRecordingChannel, (supervisor) => supervisor.cancelRecording())
  ipcMain.handle(sessionTeardownChannel, async (event, rawReason) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = nativeSessionEnvelopeSchema(z.string().trim().min(1).max(120)).safeParse(rawReason)

    if (!supervisor || !envelope.success || envelope.data.transactionToken !== undefined) return nativeSessionFailure()

    try {
      console.info("[native-audio-session-teardown]", JSON.stringify({
        reason: envelope.data.value,
        timestamp: Date.now(),
        generation: supervisor.status().generation,
      }))
      await supervisor.teardownSession()
      activeEditorProjectBindings.clear()

      return { ok: true as const }
    } catch (error) {
      activeEditorProjectBindings.clear()

      return nativeSessionFailure(error)
    }
  })
  ipcMain.handle(pluginCatalogReadChannel, async (event) => {
    const store = catalogStoreFor(event)

    if (!store) return catalogFailure("The desktop plug-in catalog is unavailable.")

    try {
      return { ok: true, catalog: catalogViewForRenderer(await store.load()) }
    } catch {
      return catalogFailure("The plug-in catalog could not be read.")
    }
  })
  ipcMain.handle(pluginCatalogChooseDirectoryChannel, async (event) => {
    const store = catalogStoreFor(event)
    const currentWindow = rendererSession.window()

    if (!store || !currentWindow) return catalogFailure("The desktop plug-in catalog is unavailable.")
    const selection = await dialog.showOpenDialog(currentWindow, { properties: ["openDirectory", "createDirectory"] })

    if (selection.canceled || selection.filePaths.length !== 1) return { ok: true, canceled: true }

    try {
      return { ok: true, canceled: false, catalog: catalogViewForRenderer(await store.addDirectory(selection.filePaths[0])) }
    } catch {
      return catalogFailure("The selected plug-in directory could not be added.")
    }
  })
  ipcMain.handle(pluginCatalogRemoveDirectoryChannel, async (event, value) => {
    const store = catalogStoreFor(event)

    if (!store) return catalogFailure("The desktop plug-in catalog is unavailable.")
    const request = pluginDirectorySchema.safeParse(value)

    if (!request.success) return catalogFailure("A plug-in directory is required.")

    try {
      return { ok: true, catalog: catalogViewForRenderer(await store.removeDirectory(request.data.directory)) }
    } catch {
      return catalogFailure("The plug-in directory could not be removed.")
    }
  })
  ipcMain.handle(pluginCatalogScanChannel, async (event) => {
    const store = catalogStoreFor(event)
    const scanner = vst3ScannerSupervisor

    if (!store || !scanner) return catalogFailure("The desktop plug-in catalog is unavailable.")

    try {
      return { ok: true, catalog: catalogViewForRenderer(await store.scan((entry, directories) => scanner.scan(entry, directories))) }
    } catch {
      return catalogFailure("The plug-in catalog could not be scanned.")
    }
  })
  ipcMain.handle(pluginCatalogPreflightInsertionChannel, async (event, value) => {
    const store = catalogStoreFor(event)
    const request = nativeVst3InsertionPreflightRequestSchema.safeParse(value)
    const workerPath = vst3WorkerPath

    if (!store || !request.success) {
      return { ok: false as const, code: "untrusted-catalog" as const, message: "The native VST3 insertion request is invalid." }
    }

    if (!audioHostAllowed(event) || !audioHostPath || !workerPath) {
      return { ok: false as const, code: "host-unavailable" as const, message: "The native VST3 host is unavailable." }
    }

    const scanner = vst3ScannerSupervisor

    if (!scanner) {
      return { ok: false as const, code: "host-unavailable" as const, message: "The native VST3 scanner is unavailable." }
    }

    try {
      const device = await probeNativeAudioOutputDevice(audioHostPath)

      if (!device?.available) {
        return { ok: false as const, code: "host-unavailable" as const, message: "No native audio output device is available." }
      }

      const preflightInput: Parameters<typeof preflightVst3Insertion>[0] = {
        request: request.data,
        catalog: await store.load(),
        workerPath,
        sampleRateHz: device.nominalSampleRateHz,
        maximumFramesPerBlock: Math.min(device.maximumFramesPerBlock, maxVst3WorkerFrames),
        evidence: ae08Evidence,
        workerEnvironment: ae08WorkerEnvironment,
        rememberVerdict: (attachment, result) => {
          attachmentLedger.rememberVerdict(attachment, device.nominalSampleRateHz, result)
        },
      }

      const first = await preflightVst3Insertion(preflightInput)

      if (first.ok || first.code !== "stale-catalog") return first
      await store.revalidate((entry, directories) => scanner.scan(entry, directories))

      return preflightVst3Insertion({
        ...preflightInput,
        catalog: await store.load(),
      })
    } catch {
      return { ok: false as const, code: "host-unavailable" as const, message: "The native VST3 host preflight failed." }
    }
  })
  registerFileCapabilitiesIpc({
    ipcMain,
    scopeAllowed,
    scopeFor,
    fileCapabilities,
    requestIdSchema,
  })
}

app.setName(appName)

let quitCleanupPrepared = false

const prepareQuit = async () => {
  if (quitCleanupPrepared) return
  // Resolve the persistence barrier before renderer invalidation or app exit.
  // A failed barrier is not swallowed and must keep the application alive.
  await audioHostSupervisor?.waitForRecordingFinish()
  // Native Complete releases writer ownership; main's durable identity proof
  // must also finish before normal process exit invalidates renderer recovery.
  await recordingSessionOwner.waitForSettlement()
  await audioHostSupervisor?.teardown()
  await nativeVst3EditorSessionManager?.teardownAll()
  await controlSocket.close()
  await fileCapabilities.revokeAll()
  await ae08StopTrace().catch(() => console.error("[ae08] trace could not be saved"))
  quitCleanupPrepared = true
}

const finishQuit = async () => {
  if (quitCleanupStarted) return
  // Normal window close already performed every fallible async operation
  // before destruction. Headless quit uses the same prerequisite.
  await prepareQuit()
  quitCleanupStarted = true
  rendererSession.beginQuit()
  preparationRegistry.abortAll()
  invalidateRendererGeneration("Application is closing.")
  rendererSession.rejectAllPending("Application is closing.")
  activeEditorProjectBindings.clear()
  powerMonitor.removeAllListeners("suspend")
  powerMonitor.removeAllListeners("resume")
  removeAudioHostLossListener?.()
  removeAudioHostRecordingStatusListener?.()
  removeAudioHostMeterBatchListener?.()
  removeAudioHostSpectrumListener?.()
  removeAudioHostScheduleProgressListener?.()
  removeAudioHostWorkerNotificationListener?.()
  app.exit()
}

const showQuitFailure = () => dialog.showErrorBox(
  "The application could not close safely.",
  "Recording sources have been retained. The application has not exited.",
)

const gotLock = app.requestSingleInstanceLock()

if (!gotLock) app.quit()
else {
  app.on("second-instance", () => {
    rendererSession.window()?.show()
    rendererSession.window()?.focus()
  })
  app.whenReady().then(async () => {
    await ae08StartTrace(contentTracing).catch(() => console.error("[ae08] trace could not start"))
    const stage = createBenchmarkStartupReporter()
    stage("before-native-helper")
    nativeMediaAvailable = await nativeFileCapabilityHelper.selfTest()
    stage("after-native-helper")
    const artifacts = await resolveNativeArtifacts()
    const scannerPath = artifacts.scannerPath
    vst3WorkerPath = artifacts.vst3WorkerPath
    audioHostPath = artifacts.audioHostPath
    nativeReleaseArtifactVerification = artifacts.verification

    vst3ScannerSupervisor = scannerPath ? createVst3ScannerSupervisor({
      platform: process.platform,
      arch: process.arch,
      scannerPath,
    }) : undefined
    pluginCatalogStore = createPluginCatalogStore({
      filePath: path.join(app.getPath("userData"), "plugin-catalog-v1.json"),
    })

    if (process.platform === "darwin") {
      const startupScanner = vst3ScannerSupervisor
      await pluginCatalogStore.initialize(
        canonicalVst3SearchPaths(app.getPath("home")),
        startupScanner
          ? (entry, directories) => startupScanner.scan(entry, directories)
          : undefined,
      )
    }

    const recordingOrderEvidence = createRecordingSpoolOrderEvidence(
      desktopEnv.recordingSpoolOrderEvidence(),
      (line) => { process.stdout.write(line) },
    )

    // Only the opt-in process uses stdout diagnostics. Keep its stream-error
    // handler for that stream's process lifetime; a closed collector is not a
    // DAW startup/release failure, just unavailable acceptance evidence.
    if (recordingOrderEvidence) process.stdout.on("error", () => undefined)

    const recordingStartup = await initializeRecordingSpoolRegistry({ userData: app.getPath("userData"),
      verifyDirectory: nativeFileCapabilityHelper.statDirectory, observeRelease: recordingOrderEvidence?.observeRelease })

    recordingSessionOwner.attachRegistry(recordingStartup.registry)

    if (recordingStartup.registry) recordingOrderEvidence?.ready()

    if (recordingStartup.error) console.error("[recording-spool] recording storage unavailable; DAW startup continues", recordingStartup.error)
    audioHostSupervisor = audioHostPath ? createNativeAudioHostSupervisor(audioHostPath, undefined, {
      evidence: ae08Evidence,
      hostEnvironment: ae08WorkerEnvironment,
    }) : undefined

    // Only a lost host ends the native session. One plug-in's fault, miss or restart is that instance's business.
    const publishNativeSessionLoss = (error: string) => {
      activeEditorProjectBindings.clear()
      rendererSession.send(lossChannel, error)
    }

    const sendVstParameterEdit = (input: {
      projectId: string
      source: "active-playback" | "editor-session"
      instanceId: string
      parameterId: number
      normalizedValue: number
    }) => {
      rendererSession.send(vstParameterEditChannel, input)
    }

    const hostEvents = createNativeVst3HostEventHandlers({
      sendInstanceEvent: (event) => { rendererSession.send(vstInstanceEventChannel, event) },
      sendParameterEdit: (input) => sendVstParameterEdit({ ...input, source: "active-playback" }),
      sendEditorState: (input) => { rendererSession.send(vstEditorStateChannel, input) },
      projectFor: (instanceId) => activeEditorProjectBindings.projectFor(instanceId),
      endSession: (error) => publishNativeSessionLoss(sanitizeNativeVst3DiagnosticError(error)),
    })

    removeAudioHostWorkerNotificationListener = audioHostSupervisor?.onWorkerNotification(hostEvents.onNotification)
    const editorHostPath = audioHostPath
    nativeVst3EditorSessionManager = editorHostPath && vst3WorkerPath
      ? createNativeVst3EditorSessionManager({
        workerPath: vst3WorkerPath,
        catalogStore: pluginCatalogStore,
        createSupervisor: () => createNativeAudioHostSupervisor(editorHostPath, undefined, {
          evidence: ae08Evidence,
          hostEnvironment: ae08WorkerEnvironment,
        }),
        playbackOwns: (instanceId) => activeEditorProjectBindings.projectFor(instanceId) !== undefined,
        onEditorInteraction: () => {
          const target = rendererSession.window()

          if (!target || target.isDestroyed() || rendererSession.finishingQuit()) return
          target.show()
          app.focus({ steal: true })
          target.focus()
        },
        onEditorOpenState: (input) => {
          rendererSession.send(vstEditorStateChannel, input)
        },
        onCapturedState: (input) => new Promise<void>((resolve, reject) => {
          const requestId = randomUUID()

          const timeout = setTimeout(() => {
            if (!rendererSession.editorStateAcks.delete(requestId)) return
            reject(new Error("Renderer editor state persistence timed out."))
          }, 10_000)

          rendererSession.editorStateAcks.set(requestId, {
            resolve: () => {
              clearTimeout(timeout)
              resolve()
            },
            reject: (error) => {
              clearTimeout(timeout)
              reject(error)
            },
          })

          if (!rendererSession.send(vstEditorCapturedStateChannel, { ...input, requestId })) {
            rendererSession.editorStateAcks.delete(requestId)
            clearTimeout(timeout)
            reject(new Error("Renderer unavailable."))
          }
        }),
        onParameterEdit: (input) => sendVstParameterEdit({
          projectId: input.projectId,
          source: "editor-session",
          instanceId: input.instanceId,
          parameterId: input.parameterId,
          normalizedValue: input.normalizedValue,
        }),
      })
      : undefined

    const handleSuspend = () => {
      if (rendererSession.finishingQuit() || (audioLifecycle.state === "suspended" && audioRecoveryGeneration === undefined)) return
      audioRecoveryGeneration = undefined
      audioLifecycle = { state: "suspended", powerGeneration: audioLifecycle.powerGeneration + 1 }
      publishAudioLifecycle()
      audioSuspendPromise = Promise.allSettled([
        audioHostSupervisor?.suspend(),
        nativeVst3EditorSessionManager?.suspendAll(),
      ]).then(() => undefined)
    }

    const handleResume = () => {
      if (rendererSession.finishingQuit() || audioLifecycle.state !== "suspended") return
      audioLifecycle = { state: "suspended", powerGeneration: audioLifecycle.powerGeneration + 1 }
      const recoveryGeneration = audioLifecycle.powerGeneration
      recoverAudioHost(recoveryGeneration)
    }

    powerMonitor.on("suspend", handleSuspend)
    powerMonitor.on("resume", handleResume)
    removeAudioHostLossListener = audioHostSupervisor?.onLoss(hostEvents.onLoss)
    const recordingBenchmark = createBenchmarkRecordingTelemetry()
    removeAudioHostRecordingStatusListener = audioHostSupervisor?.onRecordingStatus((status) => {
      recordingBenchmark.recordStatus(status)
      recordingSessionOwner.onStatus(status)
    })
    removeAudioHostMeterBatchListener = audioHostSupervisor?.onMeterBatch((batch: NativeHostMeterBatch) => {
      recordingBenchmark.recordTraffic("meter-batch", 32 + batch.entries.length * 24)
      rendererSession.send(meterBatchChannel, batch)
    })
    removeAudioHostSpectrumListener = audioHostSupervisor?.onSpectrumFrame((frame) => {
      recordingBenchmark.recordTraffic("spectrum-frame", 48 + frame.data.byteLength)
      rendererSession.send(spectrumFrameChannel, frame)
    })
    removeAudioHostScheduleProgressListener = audioHostSupervisor?.onScheduleProgress((progress: NativeScheduleProgress) => {
      recordingBenchmark.recordTraffic("schedule-progress", 16 + nativeAudioHostScheduleProgressBytes)
      rendererSession.send(scheduleProgressChannel, progress)
    })
    installRendererContent(rendererSession, sameAppOrigin)
    registerIpc()
    applicationMenuController.install({
      buildFromTemplate: (template) => Menu.buildFromTemplate(template),
      setApplicationMenu: (menu) => Menu.setApplicationMenu(menu),
    })
    stage("before-socket")
    await controlSocket.start()
    stage("after-socket")
    createMainWindow({
      rendererSession,
      sameAppOrigin,
      invalidateRendererGeneration,
      applyRendererInvalidation,
      audioHost: () => audioHostSupervisor,
      editorSessions: () => nativeVst3EditorSessionManager,
      prepareQuit,
      finishQuit,
    })
    stage("window-created")
  }).catch((error) => {
    console.error("[desktop] startup failed", error)
    app.quit()
  })
  app.on("before-quit", (event) => {
    if (rendererSession.finishingQuit()) return
    event.preventDefault()

    const mainWindow = rendererSession.window()

    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
    else void finishQuit().catch(showQuitFailure)
  })
  app.on("window-all-closed", () => void finishQuit().catch(showQuitFailure))
}
