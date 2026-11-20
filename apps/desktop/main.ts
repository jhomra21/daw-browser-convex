import { app, BrowserWindow, contentTracing, dialog, ipcMain, Menu, protocol } from "electron"
import { createHash } from "node:crypto"
import path from "node:path"
import { z } from "zod"
import { nativeEditorCommandSchema, nativeSessionEnvelopeSchema, positiveUnsigned32Schema } from "./native-session-schemas"
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
  recordingFailureChannel,
  recordingSpoolListChannel,
  recordingSpoolReadChannel,
  recordingSpoolReleaseChannel,
  recordingStatusChannel,
  recoveryCompleteChannel,
  recoveryRetryChannel,
  resolveInputDeviceChannel,
  resolveOutputDeviceChannel,
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
  vstEditorStateChannel,
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
import { rendererSenderAllowed, type RendererSenderEvent } from "./ipc/renderer-sender"
import { createNativeFileCapabilityHelper } from "./native-file-capability-helper"
import { createPreparationRegistry } from "./preparation-registry"
import { desktopOperations } from "./desktop-operations"
import { createPluginCatalogOwner } from "./plugin-catalog-owner"
import { registerPluginCatalogIpc } from "./plugin-catalog-ipc"
import {
  coordinateNativeVst3Attachments,
  nativeVst3CoordinationFailureReply,
} from "./native-vst3-coordinator"

import {
  nativeHostConfigurationIdentityFor,
  nativeProcessorPatchReply,
  nativeSessionFailure,
  nativeVstEditorOwnershipProbe,
  type NativeVstEditorAnchor,
  type NativeVstEditorCommand,
} from "./audio-host"

/* oxlint-disable eslint/no-restricted-imports -- desktop-audio-lifecycle needs the bridge types, which stay in src/types until the batch that owns the certification-pinned playback files moves it */
import {
  completeDesktopAudioRecovery,
} from "../../src/lib/desktop-audio-lifecycle"
/* oxlint-enable eslint/no-restricted-imports */
import { resolveNativeArtifacts } from "./native-artifacts"
import type {
  NativeAudioDevice,
  NativeHostDeviceConfiguration,
  NativeHostPcmAsset,
} from "@daw-browser/audio-engine/native-host-wire"
import { stampGraphRevision } from "@daw-browser/audio-engine/native-host-wire"
import {
  decodeNativeExternalAttachmentPlan,
  maxVst3WorkerSampleRateHz,
  maxVst3WorkerStateBytes,
} from "@daw-browser/plugin-host-protocol"
import {
  nativeAudioHostMaximumPayloadBytes,
  nativeAudioHostMaximumSerializedPlanBytes,
} from "@daw-browser/desktop-protocol/native-audio-host"
import {
  createTrustedDesktopOriginPolicy,
} from "./permission-policy"

import { createApplicationMenuController } from "./application-menu"
import { createAe08Evidence, ae08StartTrace, ae08StopTrace } from "./ae08-evidence"
import { ae08RendererMarkChannel, ae08RendererMarkSchema } from "@daw-browser/desktop-protocol/acceptance-marks"
import { createMainWindow } from "./main-window"
import { installRendererContent } from "./renderer-content"
import { createNativeAudioSession } from "./native-audio-session"
import { sanitizeNativeVst3DiagnosticError } from "./native-vst3-diagnostic-error"
import { createOfflineRender } from "./offline-render"
import { createControlSocket } from "./control-socket"
import { createRequestScopes } from "./request-scopes"
import { createRendererSession } from "./renderer-session"
import {
  createBenchmarkStartupReporter,
  installBenchmarkHeartbeat,
} from "./benchmark-runtime"

import { createRecordingStartDiagnostic } from "./recording-start-diagnostic"
import { desktopEnv } from "./env"

protocol.registerSchemesAsPrivileged([{ scheme: "daw", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])

const captureInhibited = desktopEnv.recordingStartDiagnostic()

const recordingStartDiagnostic = createRecordingStartDiagnostic(
  desktopEnv.recordingStartDiagnostic() || desktopEnv.recordingStartEvidence(),
  (event) => console.log("[recording-start-diagnostic]", JSON.stringify(event)),
)

const recoveryCompletionSchema = z.object({
  powerGeneration: z.number().int().safe(),
  result: z.enum(["ready", "failed"]),
}).passthrough()

const rendererMessageSchema = z.object({
  generation: z.number().int().safe(),
  frame: desktopFrameSchemaV1,
}).passthrough()

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



const diagnosticsTraceMessageSchema = z.object({
  stage: z.enum(["preload-received", "preload-handler", "controller-before-native", "controller-after-native", "controller-parsed", "preload-reply", "preload-reply-sent", "preload-reply-invalid", "preload-reply-invalid-path"]),
  elapsedMs: z.number().int().nonnegative().max(60_000),
  paths: z.string().max(512).regex(/^[a-z.,]*$/).optional(),
}).strict()

const appName = "daw-browser"

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

const audio = createNativeAudioSession({ rendererSession, sameAppOrigin, recordingSessionOwner, ae08Evidence, ae08WorkerEnvironment })

const offlineRender = createOfflineRender(rendererSession)

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
  offlineRender.abort()
  applicationMenuController.reset()
  preparationRegistry.abortAll()
  scopes.settleCapabilityRevocation(fileCapabilities.revokeRendererGeneration(previousGeneration))

  for (const [token, transaction] of audio.transactions) {
    if (transaction.generation !== previousGeneration) continue
    audio.transactions.delete(token)

    try {
      audio.bindings.rollback(token)
    } catch {
      // A newer staged transaction owns the binding registry.
    }
  }

  rendererSession.rejectAllPending(message)
  scopes.settleCapabilityRevocation(audio.supervisor?.invalidateManualTransaction() ?? Promise.resolve())
}

const registerIpc = (pluginCatalog: ReturnType<typeof createPluginCatalogOwner>) => {
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
    if (!audio.allowed(event)) return { state: "failed" as const, powerGeneration: audio.lifecycle.powerGeneration }

    return audio.lifecycle
  })
  ipcMain.handle(recoveryCompleteChannel, (event, value) => {
    if (!audio.allowed(event)) return { accepted: false }
    const completionRequest = recoveryCompletionSchema.safeParse(value)

    if (!completionRequest.success) return { accepted: false }

    const completion = completeDesktopAudioRecovery(
      audio.lifecycle,
      completionRequest.data.powerGeneration,
      completionRequest.data.result,
    )

    if (!completion.accepted) return { accepted: false }
    audio.setLifecycle(completion.lifecycle)
    audio.publishLifecycle()

    return { accepted: true }
  })
  ipcMain.handle(recoveryRetryChannel, (event) => {
    if (!audio.allowed(event) || audio.lifecycle.state !== "failed") return { accepted: false }
    audio.setLifecycle({
      state: "suspended",
      powerGeneration: audio.lifecycle.powerGeneration + 1,
    })
    audio.recoverHost(audio.lifecycle.powerGeneration)

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

  if (ae08Evidence) ipcMain.on(ae08RendererMarkChannel, (event, message) => {
    const mark = ae08RendererMarkSchema.safeParse(message)

    if (mark.success && audio.allowed(event)) ae08Evidence(mark.data[0], { key: mark.data[1] })
  })
  installBenchmarkHeartbeat({
    app,
    ipcMain,
    allowed: (event) => audio.allowed(event) && event.senderFrame === event.sender.mainFrame,
  })
  offlineRender.register({ ipcMain, allowed: audio.allowed, pluginCatalog, hostPath: audio.hostPath })
  let configuredHost: { pid: number; generation: number; configurationGeneration: number } | undefined

  const configurationGenerationFor = (host: { pid?: number; generation: number }) => {
    configuredHost = nativeHostConfigurationIdentityFor(configuredHost, host)

    return configuredHost?.configurationGeneration
  }

  ipcMain.handle(diagnosticsChannel, async (event) => {
    if (!audio.allowed(event) || !audio.supervisor) {
      return {
        ok: false,
        error: "The native audio host is unavailable.",
        artifactVerification: audio.artifactVerification,
      }
    }

    try {
      const hello = await audio.supervisor.start()
      const diagnostics = await audio.supervisor.diagnostics()
      const status = audio.supervisor.status()
      const configurationGeneration = configurationGenerationFor(status)

      if (configurationGeneration === undefined) throw new Error("The native audio host identity is unavailable.")

      return {
        ok: true,
        hello,
        status,
        configurationGeneration,
        diagnostics,
        artifactVerification: audio.artifactVerification,
      }
    } catch {
      return {
        ok: false,
        error: "The native audio host is unavailable.",
        artifactVerification: audio.artifactVerification,
      }
    }
  })
  ipcMain.handle(resolveOutputDeviceChannel, async (event, value) => {
    if (!audio.allowed(event) || !audio.supervisor) {
      return { ok: false as const, error: "The native audio host is unavailable." }
    }

    const deviceId = optionalDeviceIdSchema.safeParse(value)

    if (!deviceId.success) {
      return { ok: false as const, error: "The native audio host is unavailable." }
    }

    try {
      return { ok: true as const, device: await audio.supervisor.resolveOutputDevice(deviceId.data) }
    } catch {
      return { ok: false as const, error: "The native audio host is unavailable." }
    }
  })
  ipcMain.handle(resolveInputDeviceChannel, async (event, value) => {
    if (!audio.allowed(event) || !audio.supervisor) {
      return { ok: false as const, error: "The native audio host is unavailable." }
    }

    const deviceId = optionalDeviceIdSchema.safeParse(value)

    if (!deviceId.success) {
      return { ok: false as const, error: "The native audio host is unavailable." }
    }

    try {
      return { ok: true as const, device: await audio.supervisor.resolveInputDevice(deviceId.data) }
    } catch {
      return { ok: false as const, error: "The native audio host is unavailable." }
    }
  })
  ipcMain.handle(listDevicesChannel, async (event): Promise<{ ok: true; devices: NativeAudioDevice[] } | { ok: false; error: string }> => {
    if (!audio.allowed(event) || !audio.supervisor) {
      return { ok: false, error: "The native audio host is unavailable." }
    }

    try {
      return { ok: true, devices: await audio.supervisor.listDevices() }
    } catch {
      return { ok: false, error: "The native audio host is unavailable." }
    }
  })

  const sessionSupervisorFor = (event: Electron.IpcMainInvokeEvent) => (
    audio.allowed(event) ? audio.supervisor : undefined
  )

  // One handler shape for the envelope operations: authorize the sender, parse the request, run, reply ok or the failure.
  const registerNativeSessionOperation = <Value>(
    operation: { channel: string; request: z.ZodType<{ value: Value; transactionToken?: string | undefined }> },
    run: (supervisor: NonNullable<typeof audio.supervisor>, value: Value, transactionToken?: string) => Promise<void>,
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

      if (configuredProject && configuredRendererGeneration === rendererSession.generation() && audio.allowed(event)
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
    audio.bindings.remove(instanceId, token)
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
      audio.ledger.capturedFromLive(instanceId.data, state.sha256)

      return { ok: true as const, bytes: state.bytes, sha256: state.sha256 }
    } catch (error) {
      return nativeSessionFailure(error)
    }
  })
  ipcMain.handle(sessionEditorChannel, async (event, rawValue) => {
    const envelope = nativeEditorEnvelopeSchema.safeParse(rawValue)
    const allowed = audio.allowed(event)

    const activeHostCandidate = allowed && audio.supervisor?.status().running
      ? audio.supervisor
      : undefined

    const manager = allowed ? audio.editorSessions : undefined

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

          const boundProjectId = audio.bindings.projectFor(command.instanceId)

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
    const workerPath = pluginCatalog.workerPath

    if (
      !supervisor
      || !workerPath
      || !envelope.success
    ) return nativeSessionFailure()
    const sessionValue = envelope.data.value
    let result: Awaited<ReturnType<typeof coordinateNativeVst3Attachments>>
    const hostHello = supervisor.status().hello

    if (!hostHello) return nativeSessionFailure()
    const ledger = audio.ledger.forHost(supervisor, hostHello)

    try {
      result = await coordinateNativeVst3Attachments({
        serializedPlan: sessionValue.serializedPlan,
        sampleRateHz: sessionValue.sampleRateHz,
        workerPath,
        catalogStore: pluginCatalog.store,
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
      audio.bindings.rollback(envelope.data.transactionToken)

      return nativeSessionFailure(error)
    }

    if (!result.ok) {
      audio.bindings.rollback(envelope.data.transactionToken)

      return nativeVst3CoordinationFailureReply(result)
    }

    try {
      const plan = decodeNativeExternalAttachmentPlan(sessionValue.serializedPlan)
      const projectId = projectIdSchemaV1.parse(sessionValue.projectId)
      audio.bindings.stage(
        plan.attachments.map((attachment) => attachment.instanceId),
        projectId,
        envelope.data.transactionToken,
      )

      // A live plan has no transaction to commit it: the project owns these instances from now.
      if (envelope.data.transactionToken === undefined) audio.bindings.commit()

      return { ok: true as const }
    } catch {
      audio.bindings.rollback(envelope.data.transactionToken)

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
    if (!audio.allowed(event) || event.senderFrame !== event.sender.mainFrame) return false

    if (revisionProjectOwner?.projectId !== projectId || revisionProjectOwner.rendererGeneration !== rendererSession.generation()
      || revisionProjectOwner.hostGeneration !== audio.supervisor?.status().generation) return false

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

        if (result.status === "published") audio.ledger.published()

        if (operation === "rollback") audio.ledger.rolledBack()
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
    allowed: audio.allowed,
    supervisor: () => audio.supervisor,
    fail: nativeSessionFailure,
  })
  registerNativeSessionRecordingIpc({
    ipcMain,
    allowed: audio.allowed,
    supervisor: () => audio.supervisor,
    owner: recordingSessionOwner,
    rendererGeneration: () => rendererSession.generation(),
    hostGeneration: () => audio.lifecycle.powerGeneration,
    fail: nativeSessionFailure,
  })
  const spoolScopeSchema = z.object({ projectId: projectIdSchemaV1, projectGeneration: unsigned32Schema }).strict()
  const spoolTakeIdSchema = z.string().uuid()

  const spoolFor = (event: Electron.IpcMainInvokeEvent) => {
    if (!audio.allowed(event) || event.senderFrame !== event.sender.mainFrame)
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
    operation: (supervisor: NonNullable<typeof audio.supervisor>) => Promise<void>,
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
      audio.ledger.begin()

      if (
        rendererSession.generation() !== requestGeneration
        || rendererSession.window()?.webContents.id !== senderId
        || !audio.allowed(event)
      ) {
        await supervisor.invalidateManualTransaction()

        return nativeSessionFailure()
      }

      audio.bindings.stageEmpty(transactionToken)
      audio.transactions.set(transactionToken, { generation: requestGeneration, senderId })

      return { ok: true as const, transactionToken }
    } catch (error) {
      return nativeSessionFailure(error)
    }
  })
  ipcMain.handle(sessionCommitTransactionChannel, async (event, value) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = nativeUndefinedEnvelopeSchema.safeParse(value)

    if (!supervisor || !envelope.success || !envelope.data.transactionToken) return nativeSessionFailure()
    const transaction = audio.transactions.get(envelope.data.transactionToken)

    if (
      !transaction
      || transaction.generation !== rendererSession.generation()
      || transaction.senderId !== event.sender.id
      || !audio.allowed(event)
    ) return nativeSessionFailure()

    try {
      await supervisor.commitTransaction(envelope.data.transactionToken)
      audio.transactions.delete(envelope.data.transactionToken)
      audio.bindings.commit(envelope.data.transactionToken)
      audio.ledger.published()

      return { ok: true as const }
    } catch (error) {
      audio.transactions.delete(envelope.data.transactionToken)
      audio.bindings.rollback(envelope.data.transactionToken)

      return nativeSessionFailure(error)
    }
  })
  ipcMain.handle(sessionRollbackTransactionChannel, async (event, value) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = nativeUndefinedEnvelopeSchema.safeParse(value)

    if (!supervisor || !envelope.success || !envelope.data.transactionToken) return nativeSessionFailure()
    const transaction = audio.transactions.get(envelope.data.transactionToken)

    if (
      !transaction
      || transaction.generation !== rendererSession.generation()
      || transaction.senderId !== event.sender.id
      || !audio.allowed(event)
    ) return nativeSessionFailure()

    try {
      await supervisor.rollbackTransaction(envelope.data.transactionToken)
      audio.ledger.rolledBack()

      return { ok: true as const }
    } catch (error) {
      return nativeSessionFailure(error)
    } finally {
      audio.transactions.delete(envelope.data.transactionToken)
      audio.bindings.rollback(envelope.data.transactionToken)
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
      audio.bindings.clear()

      return { ok: true as const }
    } catch (error) {
      audio.bindings.clear()

      return nativeSessionFailure(error)
    }
  })
  registerPluginCatalogIpc({
    ipcMain,
    catalog: pluginCatalog,
    senderAllowed,
    audioHostAllowed: audio.allowed,
    getWindow: rendererSession.window,
    hostPath: audio.hostPath,
    attachmentLedger: audio.ledger,
    ae08Evidence,
    ae08WorkerEnvironment,
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
  await audio.supervisor?.waitForRecordingFinish()
  // Native Complete releases writer ownership; main's durable identity proof
  // must also finish before normal process exit invalidates renderer recovery.
  await recordingSessionOwner.waitForSettlement()
  await audio.supervisor?.teardown()
  await audio.editorSessions?.teardownAll()
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
  audio.bindings.clear()
  audio.dispose()
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

    const pluginCatalog = createPluginCatalogOwner({
      userData: app.getPath("userData"),
      home: app.getPath("home"),
      scannerPath: artifacts.scannerPath,
      workerPath: artifacts.vst3WorkerPath,
    })

    await pluginCatalog.initialize()

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
    audio.start({ hostPath: artifacts.audioHostPath, verification: artifacts.verification, pluginCatalog })
    installRendererContent(rendererSession, sameAppOrigin)
    registerIpc(pluginCatalog)
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
      audioHost: () => audio.supervisor,
      editorSessions: () => audio.editorSessions,
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
