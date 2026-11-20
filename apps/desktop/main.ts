import { app, contentTracing, dialog, ipcMain, Menu, protocol } from "electron"
import path from "node:path"
import { z } from "zod"
import { requestIdSchema } from "@daw-browser/desktop-protocol/wire-patterns"
import {
  desktopFrameSchemaV1,
} from "@daw-browser/desktop-protocol"
import type { DesktopApplicationMenuMessage } from "@daw-browser/desktop-protocol/application-menu"
import {
  applicationMenuCommandChannel,
  diagnosticsV2TraceChannel,
  hostResponseChannel,
  recordingFailureChannel,
  recordingStatusChannel,
} from "@daw-browser/desktop-protocol/ipc-channels"
import { initializeRecordingSpoolRegistry } from "./recording-spool"
import { createRecordingSessionOwner } from "./recording-session-owner"
import { createRecordingSpoolOrderEvidence } from "./recording-spool-evidence"
import { createFileCapabilityManager } from "./file-capabilities"
import { registerFileCapabilitiesIpc } from "./ipc/file-capabilities-ipc"
import { registerApplicationMenuIpc } from "./ipc/application-menu-ipc"
import { registerVstEditorStateAckIpc } from "./ipc/vst-editor-state-ack-ipc"
import { rendererSenderAllowed, type RendererSenderEvent } from "./ipc/renderer-sender"
import { createNativeFileCapabilityHelper } from "./native-file-capability-helper"
import { createPreparationRegistry } from "./preparation-registry"
import { desktopOperations } from "./desktop-operations"
import { createPluginCatalogOwner } from "./plugin-catalog-owner"
import { registerPluginCatalogIpc } from "./plugin-catalog-ipc"
import { resolveNativeArtifacts } from "./native-artifacts"
import {
  createTrustedDesktopOriginPolicy,
} from "./permission-policy"
import { createApplicationMenuController } from "./application-menu"
import { createAe08Evidence, ae08StartTrace, ae08StopTrace } from "./ae08-evidence"
import { ae08RendererMarkChannel, ae08RendererMarkSchema } from "@daw-browser/desktop-protocol/acceptance-marks"
import { createMainWindow } from "./main-window"
import { installRendererContent } from "./renderer-content"
import { createNativeAudioSession } from "./native-audio-session"
import { createOfflineRender } from "./offline-render"
import { registerNativeAudioSessionIpc } from "./ipc/native-audio-session-ipc"
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

const rendererMessageSchema = z.object({
  generation: z.number().int().safe(),
  frame: desktopFrameSchemaV1,
}).passthrough()

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
  registerNativeAudioSessionIpc({ ipcMain, audio, rendererSession, pluginCatalog, recordingSessionOwner, ae08Evidence, ae08WorkerEnvironment })
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
