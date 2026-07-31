import { app, BrowserWindow, dialog, ipcMain, net as electronNet, protocol, session, shell } from "electron"
import { createServer, type Socket } from "node:net"
import { chmod, mkdir, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  desktopFrameSchemaV1,
  desktopHelloSchemaV1,
  desktopHelloSchemaV2,
  desktopHostExportRunInputSchemaV1,
  desktopHostExportRunResultSchemaV1,
  desktopHostImportInputSchemaV1,
  desktopRendererExportInputSchemaV1,
  desktopRendererImportInputSchemaV1,
  desktopProtocolVersion,
  desktopProtocolVersionV2,
  desktopRegistrationSchemaV1,
  desktopRendererRequestSchemaV1,
  desktopTrustedRendererRequestSchemaV1,
  projectIdSchemaV1,
  hostError,
  hostErrorV2,
  hostErrorSchemaV1,
  isDesktopControlOperation,
  type DesktopFrameV1,
  type DesktopOperationV1,
  type DesktopProtocolVersion,
  type DesktopRendererRequestV1,
  type DesktopTrustedRendererRequestV1,
} from "@daw-browser/desktop-protocol"
import { controlErrorSchemaV1 } from "@daw-browser/control"
import { createDesktopFrameDecoder, encodeDesktopFrame } from "@daw-browser/desktop-protocol/socket"
import { serializeDesktopReply } from "@daw-browser/desktop-protocol/reply-chunks"
import { createCloseHandler } from "./close-flow"
import { createFileCapabilityManager } from "./file-capabilities"
import { createNativeFileCapabilityHelper } from "./native-file-capability-helper"
import { createRequestCorrelation } from "./request-correlation"
import { createPreparationRegistry } from "./preparation-registry"
import { desktopOperations } from "./desktop-operations"
import { createContentSecurityPolicy } from "./content-security-policy"
import { createPluginCatalogStore } from "./plugin-catalog"
import { createVst3ScannerSupervisor, packagedVst3ScannerPath } from "./vst3-scanner"
import { catalogViewForRenderer } from "./vst3-attachment"
import { preflightVst3Insertion } from "./vst3-insertion-preflight"
import { packagedVst3WorkerPath } from "./vst3-preflight"
import { coordinateNativeVst3Attachments } from "./native-vst3-coordinator"
import {
  createNativeAudioHostSupervisor,
  NativeAudioHostCommandError,
  nativeVstEditorOwnershipProbe,
  packagedAudioHostPath,
  type NativeVstEditorAnchor,
  type NativeVstEditorCommand,
} from "./audio-host"
import { createNativeVst3EditorSessionManager } from "./native-vst3-editor-session"
import {
  nativeReleaseArtifactManifestName,
  verifyPackagedNativeReleaseArtifacts,
} from "./native-release-artifacts"
import type {
  NativeHostDeviceConfiguration,
  NativeHostPcmAsset,
  NativeHostRecordingConfiguration,
  NativeHostTransport,
  NativeHostMeterBatch,
  NativeScheduleProgress,
} from "@daw-browser/audio-engine/native-host-wire"
import {
  decodeNativeExternalAttachmentPlan,
  nativeVst3InsertionPreflightRequestSchema,
} from "@daw-browser/plugin-host-protocol"
import {
  allowsTrustedAudioCapturePermission,
  allowsTrustedMidiPermission,
  isTrustedDesktopOrigin,
} from "./permission-policy"
import { packagedRendererRoot, rendererAssetPath } from "./renderer-path"
import { createNativeVstProjectBindings } from "./native-vst-project-bindings"

protocol.registerSchemesAsPrivileged([{ scheme: "daw", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])

const incomingChannel = "daw:host-request"
const outgoingChannel = "daw:host-response"
const appName = "daw-browser"
const sanitizeNativeVst3DiagnosticError = (error: unknown) => {
  const message = error instanceof Error
    ? error.message
    : "The native VST editor session is unavailable."
  return message.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s]*/g, "<path>").slice(0, 256)
}
const preloadPath = path.join(import.meta.dirname, "preload.js")
const externalUrl = (url: string) => {
  try {
    return new URL(url).protocol === "https:"
  } catch {
    return false
  }
}
const sameAppOrigin = isTrustedDesktopOrigin
type PendingRendererRequest = {
  generation: number
  resolve: (frame: Extract<DesktopFrameV1, { type: "reply" }>) => void
  reject: (error: Error) => void
}
let window_: BrowserWindow | undefined
let generation = 0
const rendererPending = new Map<string, PendingRendererRequest>()
const preparationRegistry = createPreparationRegistry()
const exportScopes = new Map<string, { requestId: string; rendererGeneration: number }>()
const preparedExportModes = new Map<string, "mixdown" | "stems">()
const terminalExportsAwaitingScope = new Set<string>()
const exportScopesHasScope = (scope: { requestId: string; rendererGeneration: number }) => (
  [...exportScopes.values()].some((exportScope) => (
    exportScope.requestId === scope.requestId
    && exportScope.rendererGeneration === scope.rendererGeneration
  ))
)
const instanceId = randomBytes(16).toString("hex")
const secret = randomBytes(32).toString("hex")
let registrationPath = ""
let socketPath = ""
let socketServer: ReturnType<typeof createServer> | undefined
const acceptedSockets = new Set<Socket>()
let finishingQuit = false
let nativeMediaAvailable = false
let pluginCatalogStore: ReturnType<typeof createPluginCatalogStore> | undefined
let audioHostPath: string | undefined
let vst3WorkerPath: string | undefined
let audioHostSupervisor: ReturnType<typeof createNativeAudioHostSupervisor> | undefined
let nativeVst3EditorSessionManager: ReturnType<typeof createNativeVst3EditorSessionManager> | undefined
let vst3ScannerSupervisor: ReturnType<typeof createVst3ScannerSupervisor> | undefined
let nativeReleaseArtifactVerification:
  | { status: "disabled" | "development" | "verified" }
  | { status: "failed"; reason: string } = { status: "disabled" }
let removeAudioHostLossListener: (() => void) | undefined
let removeAudioHostRecordingBlockListener: (() => void) | undefined
let removeAudioHostRecordingStatusListener: (() => void) | undefined
let removeAudioHostMeterBatchListener: (() => void) | undefined
let removeAudioHostScheduleProgressListener: (() => void) | undefined
let removeAudioHostWorkerNotificationListener: (() => void) | undefined
const activeEditorProjectBindings = createNativeVstProjectBindings()
const nativeFileCapabilityHelper = createNativeFileCapabilityHelper()
const fileCapabilities = createFileCapabilityManager({
  dialog: {
    showOpenDialog: (options) => dialog.showOpenDialog(options),
    showSaveDialog: (options) => dialog.showSaveDialog(options),
  },
  nativeHelper: nativeFileCapabilityHelper,
  nativeOutputEnabled: () => nativeMediaAvailable,
  privateTempDirectory: () => path.join(app.getPath("userData"), "output-temp"),
})
const settleCapabilityRevocation = (operation: Promise<void>) => {
  void operation.catch(() => undefined)
}
const availableDesktopOperations = () => desktopOperations(nativeMediaAvailable)
const operationFailure = (_operation: DesktopOperationV1, code: Parameters<typeof hostError>[0], message: string) => hostError(code, message)
const operationFailureV2 = (_operation: DesktopOperationV1, code: Parameters<typeof hostError>[0], message: string) => hostErrorV2(code, message)
const translateRendererError = (
  operation: DesktopOperationV1,
  error: unknown,
  protocolVersion: DesktopProtocolVersion,
) => {
  if (protocolVersion !== desktopProtocolVersionV2) return error
  if (isDesktopControlOperation(operation) && controlErrorSchemaV1.safeParse(error).success) return error
  const host = hostErrorSchemaV1.safeParse(error)
  return host.success ? hostErrorV2(host.data.code, host.data.message) : error
}
const writeSocketFailure = (
  socket: Socket,
  protocolVersion: DesktopProtocolVersion,
  operation: DesktopOperationV1,
  id: string,
  code: Parameters<typeof hostError>[0],
  message: string,
) => {
  if (protocolVersion === desktopProtocolVersionV2) {
    socket.write(encodeDesktopFrame({
      version: desktopProtocolVersionV2,
      type: "reply",
      id,
      error: operationFailureV2(operation, code, message),
    }))
    return
  }
  socket.write(encodeDesktopFrame({
    version: desktopProtocolVersion,
    type: "reply",
    id,
    error: operationFailure(operation, code, message),
  }))
}

const cancelRendererRequest = (id: string, requestGeneration: number) => {
  const target = window_?.webContents
  if (!target || target.isDestroyed() || !sameAppOrigin(target.getURL())) return
  target.send(incomingChannel, {
    generation: requestGeneration,
    frame: { version: desktopProtocolVersion, type: "cancel", id },
  })
}

const cancelPreparedRendererExport = (id: string) => {
  const mode = preparedExportModes.get(id)
  if (!mode) return
  preparedExportModes.delete(id)
  const target = window_?.webContents
  if (!target || target.isDestroyed() || !sameAppOrigin(target.getURL())) return
  target.send(incomingChannel, {
    generation,
    frame: {
      version: desktopProtocolVersion,
      type: "request",
      id,
      operation: "host.export.run",
      input: desktopRendererExportInputSchemaV1.parse({ canceled: true, mode }),
    },
  })
}

const rejectRendererPending = (message: string) => {
  for (const [id, pending] of rendererPending) {
    cancelRendererRequest(id, pending.generation)
    pending.reject(new Error(message))
  }
  rendererPending.clear()
}
const rejectRendererRequest = (id: string, message: string) => {
  const pending = rendererPending.get(id)
  if (!pending) return
  rendererPending.delete(id)
  cancelRendererRequest(id, pending.generation)
  pending.reject(new Error(message))
}

const sendToRenderer = (request: DesktopRendererRequestV1 | DesktopTrustedRendererRequestV1) => new Promise<Extract<DesktopFrameV1, { type: "reply" }>>((resolve, reject) => {
  const target = window_?.webContents
  if (!target || target.isDestroyed() || !sameAppOrigin(target.getURL())) {
    reject(new Error("Renderer unavailable."))
    return
  }
  if (rendererPending.has(request.id)) {
    reject(new Error("Duplicate request ID."))
    return
  }
  const expectedGeneration = generation
  rendererPending.set(request.id, { generation: expectedGeneration, resolve, reject })
  target.send(incomingChannel, { generation: expectedGeneration, frame: request })
})

const renderRequest = async (operation: DesktopOperationV1 | "lifecycle.prepareToClose", input: unknown, id: string, deadlineMs = 10_000, actorSubject?: string) => {
  const request = { version: desktopProtocolVersion, type: "request" as const, id, operation, input, deadlineMs }
  const parsed = operation !== "lifecycle.prepareToClose" && isDesktopControlOperation(operation)
    ? desktopTrustedRendererRequestSchemaV1.parse({ ...request, actorSubject })
    : desktopRendererRequestSchemaV1.parse(request)
  // This is a bounded deadline guard for a renderer IPC round trip; it is always cleared on completion.
  let timeout: ReturnType<typeof setTimeout> | undefined
  let deadlineElapsed = false
  try {
    return await Promise.race([
      sendToRenderer(parsed),
      new Promise<Extract<DesktopFrameV1, { type: "reply" }>>((_resolve, reject) => {
        timeout = setTimeout(() => {
          deadlineElapsed = true
          reject(new Error("Renderer deadline exceeded."))
        }, deadlineMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
    const pending = rendererPending.get(id)
    if (deadlineElapsed && pending) cancelRendererRequest(id, pending.generation)
    rendererPending.delete(id)
  }
}

const prepareRendererInput = async (
  operation: DesktopOperationV1,
  input: unknown,
  scope: { requestId: string; rendererGeneration: number },
  signal: AbortSignal,
) => {
  signal.throwIfAborted()
  if (operation === "host.import.audio") {
    const request = desktopHostImportInputSchemaV1.parse(input)
    const selection = request.source.kind === "picker"
      ? await fileCapabilities.pickReadFiles(scope)
      : { canceled: false as const, files: [await fileCapabilities.grantReadFile(scope, request.source.path)] }
    signal.throwIfAborted()
    return desktopRendererImportInputSchemaV1.parse(
      selection.canceled ? { canceled: true } : { canceled: false, files: selection.files },
    )
  }
  if (operation === "host.export.run") {
    const request = desktopHostExportRunInputSchemaV1.parse(input)
    const extension = request.mode === "mixdown"
      ? request.format === "ogg-opus" ? "ogg" : request.format
      : undefined
    const placeholderDestination: {
      kind: "capability-file"
      token: string
      basename: string
    } | {
      kind: "capability-directory"
      token: string
      basename: string
    } = request.mode === "mixdown"
      ? { kind: "capability-file", token: "0".repeat(64), basename: `preflight.${extension}` }
      : { kind: "capability-directory", token: "0".repeat(64), basename: "preflight" }
    const preflight = await renderRequest("host.export.run", desktopRendererExportInputSchemaV1.parse({
      ...request,
      canceled: false,
      preflightOnly: true,
      destination: placeholderDestination,
    }), scope.requestId)
    if (preflight.error) throw new Error(preflight.error.message)
    preparedExportModes.set(scope.requestId, request.mode)
    try {
      signal.throwIfAborted()
      const destination = request.destination
      if (destination.kind === "file" || destination.kind === "file-picker") {
        const selected = destination.kind === "file-picker"
          ? await fileCapabilities.pickOutputFile(scope, request.mode === "mixdown" ? request.format : undefined)
          : { canceled: false as const, file: await fileCapabilities.grantOutputFile(scope, destination.path) }
        signal.throwIfAborted()
        if (selected.canceled) return desktopRendererExportInputSchemaV1.parse({ canceled: true, mode: "mixdown" })
        return desktopRendererExportInputSchemaV1.parse({ ...request, destination: { kind: "capability-file", token: selected.file.token, basename: selected.file.basename }, canceled: false })
      }
      const selected = destination.kind === "directory-picker"
        ? await fileCapabilities.pickDirectory(scope)
        : { canceled: false as const, directory: await fileCapabilities.grantDirectory(scope, destination.path) }
      signal.throwIfAborted()
      if (selected.canceled) return desktopRendererExportInputSchemaV1.parse({ canceled: true, mode: "stems" })
      return desktopRendererExportInputSchemaV1.parse({ ...request, destination: { kind: "capability-directory", token: selected.directory.token, basename: selected.directory.basename }, canceled: false })
    } catch (error) {
      cancelPreparedRendererExport(scope.requestId)
      throw error
    } finally {
      preparedExportModes.delete(scope.requestId)
    }
  }
  return input
}

const closeSocket = async () => {
  for (const socket of acceptedSockets) socket.destroy()
  acceptedSockets.clear()
  await new Promise<void>((resolve) => socketServer?.close(() => resolve()) ?? resolve())
  socketServer = undefined
  if (socketPath) await rm(socketPath, { force: true }).catch(() => undefined)
  if (registrationPath) await rm(registrationPath, { force: true }).catch(() => undefined)
}

const registrationDirectory = () => path.join(app.getPath("userData"), "host")
const localSocketAddress = () => process.platform === "win32"
  ? `\\\\.\\pipe\\${appName}-${instanceId}`
  : path.join(registrationDirectory(), `${instanceId}.sock`)

const authenticate = (value: string) => {
  const supplied = Buffer.from(value, "hex")
  const expected = Buffer.from(secret, "hex")
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected)
}

const startSocket = async () => {
  const directory = registrationDirectory()
  if (process.platform === "win32") await mkdir(directory, { recursive: true })
  else {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
  }
  socketPath = localSocketAddress()
  if (process.platform !== "win32") await rm(socketPath, { force: true })
  socketServer = createServer((socket) => handleSocket(socket))
  await new Promise<void>((resolve, reject) => socketServer?.once("error", reject).listen(socketPath, resolve))
  if (process.platform !== "win32") await chmod(socketPath, 0o600)
  registrationPath = path.join(directory, "registration-v1.json")
  const registration = desktopRegistrationSchemaV1.parse({
    version: desktopProtocolVersion,
    instanceId,
    pid: process.pid,
    createdAt: Date.now(),
    address: socketPath,
    secret,
  })
  await writeFile(registrationPath, JSON.stringify(registration), process.platform === "win32" ? undefined : { mode: 0o600 })
  if (process.platform !== "win32") await chmod(registrationPath, 0o600)
}

const handleSocket = (socket: Socket) => {
  let authenticated = false
  let protocolVersion: DesktopProtocolVersion | undefined
  let actorSubject: string | undefined
  const correlation = createRequestCorrelation()
  const preparationControllers = new Map<string, AbortController>()
  const finalExportCandidates = new Set<string>()
  const sessionId = randomBytes(16).toString("hex")
  acceptedSockets.add(socket)
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    acceptedSockets.delete(socket)
    for (const controller of preparationControllers.values()) {
      controller.abort()
      preparationRegistry.delete(controller)
    }
    preparationControllers.clear()
    const rendererIds = [...correlation.internalIds()]
    for (const rendererId of rendererIds) {
      cancelPreparedRendererExport(rendererId)
      if (!finalExportCandidates.has(rendererId)) rejectRendererRequest(rendererId, "Desktop host connection closed.")
    }
    correlation.clear()
    for (const rendererId of rendererIds) {
      if (finalExportCandidates.has(rendererId)) continue
      settleCapabilityRevocation(fileCapabilities.revokeRequest({ requestId: rendererId, rendererGeneration: generation }))
    }
  }
  const decoder = createDesktopFrameDecoder((frame) => {
    if (!authenticated) {
      const hello = desktopHelloSchemaV1.safeParse(frame).success
        ? desktopHelloSchemaV1.safeParse(frame)
        : desktopHelloSchemaV2.safeParse(frame)
      if (!hello.success || !authenticate(hello.data.secret)) {
        socket.destroy()
        return
      }
      authenticated = true
      protocolVersion = hello.data.version
      actorSubject = `local:${hello.data.actorId}`
      socket.write(encodeDesktopFrame(
        protocolVersion === desktopProtocolVersionV2
          ? { version: desktopProtocolVersionV2, type: "helloAck", selectedVersion: desktopProtocolVersionV2, sessionId, capabilities: availableDesktopOperations() }
          : { version: desktopProtocolVersion, type: "helloAck", sessionId, capabilities: availableDesktopOperations() },
      ))
      return
    }
    const sessionProtocolVersion = protocolVersion
    if (
      sessionProtocolVersion === "v1"
      && frame.version === desktopProtocolVersionV2
      && frame.type === "request"
    ) {
      writeSocketFailure(socket, sessionProtocolVersion, frame.operation, frame.id, "unsupported-version", "Protocol version v2 is not available in this session.")
      return
    }
    if (sessionProtocolVersion === undefined || frame.version !== sessionProtocolVersion) {
      socket.destroy()
      return
    }
    if (frame.type === "cancel") {
      const rendererId = correlation.removeExternal(frame.id)
      if (rendererId) {
        finalExportCandidates.delete(rendererId)
        cancelPreparedRendererExport(rendererId)
        const controller = preparationControllers.get(rendererId)
        controller?.abort()
        if (controller) preparationRegistry.delete(controller)
        preparationControllers.delete(rendererId)
        const canceledScope = { requestId: rendererId, rendererGeneration: generation }
        settleCapabilityRevocation(fileCapabilities.revokeRequest(canceledScope).finally(() => {
          rejectRendererRequest(rendererId, "Desktop host request cancelled.")
        }))
      }
      return
    }
    if (frame.type !== "request" || correlation.getInternal(frame.id)) {
      socket.destroy()
      return
    }
    if (!availableDesktopOperations().includes(frame.operation)) {
      writeSocketFailure(socket, sessionProtocolVersion, frame.operation, frame.id, "unavailable", "The requested desktop operation is unavailable on this platform.")
      return
    }
    const rendererId = correlation.create(frame.id)
    const preparation = new AbortController()
    preparationRegistry.add(preparation)
    preparationControllers.set(rendererId, preparation)
    const scope = { requestId: rendererId, rendererGeneration: generation }
    void prepareRendererInput(frame.operation, frame.input, scope, preparation.signal)
      .then((input) => {
        preparation.signal.throwIfAborted()
        if (frame.operation === "host.export.run") {
          const parsed = desktopRendererExportInputSchemaV1.parse(input)
          if (!parsed.canceled && !parsed.preflightOnly) finalExportCandidates.add(rendererId)
        }
        return renderRequest(frame.operation, input, rendererId, frame.deadlineMs, actorSubject)
      }).then(async (reply) => {
      preparationControllers.delete(rendererId)
      preparationRegistry.delete(preparation)
      finalExportCandidates.delete(rendererId)
      if (frame.operation === "host.export.run" && !reply.error) {
        const result = desktopHostExportRunResultSchemaV1.safeParse(reply.result)
        if (result.success && result.data.status === "queued" && result.data.jobId) {
          exportScopes.set(result.data.jobId, scope)
          if (terminalExportsAwaitingScope.delete(result.data.jobId)) {
            exportScopes.delete(result.data.jobId)
            await fileCapabilities.revokeRequest(scope)
          }
        }
      }
      const externalId = correlation.getExternal(rendererId)
      if (!externalId) {
        if (frame.operation !== "host.export.run" || ![...exportScopes.values()].some((exportScope) => exportScope.requestId === scope.requestId && exportScope.rendererGeneration === scope.rendererGeneration)) {
          await fileCapabilities.revokeRequest(scope)
        }
        return
      }
      correlation.removeExternal(externalId)
      if (socket.destroyed) {
        if (frame.operation !== "host.export.run" || ![...exportScopes.values()].some((exportScope) => exportScope.requestId === scope.requestId && exportScope.rendererGeneration === scope.rendererGeneration)) {
          await fileCapabilities.revokeRequest(scope)
        }
        return
      }
      if (frame.operation === "host.import.audio" || (frame.operation === "host.export.run" && !exportScopesHasScope(scope))) {
        await fileCapabilities.revokeRequest(scope)
      }
      try {
        const translatedError = translateRendererError(
          frame.operation,
          reply.error,
          sessionProtocolVersion,
        )
        for (const outbound of serializeDesktopReply(
          frame.operation,
          frame.input,
          { ...reply, error: translatedError, id: externalId, version: sessionProtocolVersion },
          sessionProtocolVersion,
        )) {
          socket.write(encodeDesktopFrame(outbound))
        }
      } catch {
        writeSocketFailure(socket, sessionProtocolVersion, frame.operation, externalId, "internal", "The desktop response could not be serialized.")
      }
    }).catch(async (error: unknown) => {
      preparationControllers.delete(rendererId)
      preparationRegistry.delete(preparation)
      finalExportCandidates.delete(rendererId)
      await fileCapabilities.revokeRequest(scope)
      const externalId = correlation.getExternal(rendererId)
      if (!externalId) return
      correlation.removeExternal(externalId)
      const message = error instanceof Error && error.message === "Renderer deadline exceeded." ? "The request deadline elapsed." : "The renderer is unavailable."
      const code = error instanceof Error && error.message === "Renderer deadline exceeded." ? "deadline-exceeded" : "unavailable"
      writeSocketFailure(socket, sessionProtocolVersion, frame.operation, externalId, code, message)
    })
  })
  socket.on("data", (chunk: Buffer) => {
    try {
      decoder(chunk)
    } catch {
      socket.destroy()
    }
  })
  socket.on("close", close)
  socket.on("error", close)
}

const registerIpc = () => {
  ipcMain.on(outgoingChannel, (event, message: unknown) => {
    if (!window_ || event.sender.id !== window_.webContents.id || !event.senderFrame || !sameAppOrigin(event.senderFrame.url)) return
    if (typeof message !== "object" || message === null || !("generation" in message) || !("frame" in message)) return
    const messageGeneration = message.generation
    if (typeof messageGeneration !== "number" || !Number.isSafeInteger(messageGeneration) || messageGeneration !== generation) return
    const parsed = desktopFrameSchemaV1.safeParse(message.frame)
    if (!parsed.success) return
    if (parsed.data.type === "export-terminal") {
      const scope = exportScopes.get(parsed.data.jobId)
      if (scope) {
        exportScopes.delete(parsed.data.jobId)
        settleCapabilityRevocation(fileCapabilities.revokeRequest(scope))
      } else if (terminalExportsAwaitingScope.size < 1024) terminalExportsAwaitingScope.add(parsed.data.jobId)
      return
    }
    if (parsed.data.type !== "reply") return
    const pending = rendererPending.get(parsed.data.id)
    if (!pending || pending.generation !== messageGeneration) return
    pending.resolve(parsed.data)
  })
  const scopeFor = (event: Electron.IpcMainInvokeEvent, value: unknown) => {
    if (!window_ || event.sender.id !== window_.webContents.id || !event.senderFrame || !sameAppOrigin(event.senderFrame.url)) return undefined
    if (typeof value !== "object" || value === null || !("requestId" in value) || typeof value.requestId !== "string") return undefined
    return { requestId: value.requestId, rendererGeneration: generation }
  }
  const catalogAllowed = (event: Electron.IpcMainInvokeEvent) => (
    process.platform === "darwin"
    && window_ !== undefined
    && event.sender.id === window_.webContents.id
    && event.senderFrame !== null
    && sameAppOrigin(event.senderFrame.url)
    && pluginCatalogStore !== undefined
  )
  const catalogFailure = (message: string): { ok: false; error: string } => ({ ok: false, error: message })
  const catalogStoreFor = (event: Electron.IpcMainInvokeEvent) => (
    catalogAllowed(event) ? pluginCatalogStore : undefined
  )
  const audioHostAllowed = (event: Electron.IpcMainInvokeEvent) => (
    process.platform === "darwin"
    && process.arch === "arm64"
    && window_ !== undefined
    && event.sender.id === window_.webContents.id
    && event.senderFrame !== null
    && sameAppOrigin(event.senderFrame.url)
  )
  ipcMain.handle("daw:audio-host:diagnostics", async (event) => {
    if (!audioHostAllowed(event) || !audioHostSupervisor) {
      return {
        ok: false,
        error: "The native audio host is unavailable.",
        artifactVerification: nativeReleaseArtifactVerification,
      }
    }
    try {
      return {
        ok: true,
        hello: await audioHostSupervisor.start(),
        status: audioHostSupervisor.status(),
        diagnostics: await audioHostSupervisor.diagnostics(),
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
  ipcMain.handle("daw:audio-host:resolve-output-device", async (event, value: unknown) => {
    if (!audioHostAllowed(event) || !audioHostSupervisor || (value !== undefined && typeof value !== "string")) {
      return { ok: false as const, error: "The native audio host is unavailable." }
    }
    try {
      return { ok: true as const, device: await audioHostSupervisor.resolveOutputDevice(value) }
    } catch {
      return { ok: false as const, error: "The native audio host is unavailable." }
    }
  })
  ipcMain.handle("daw:audio-host:resolve-input-device", async (event, value: unknown) => {
    if (!audioHostAllowed(event) || !audioHostSupervisor || (value !== undefined && typeof value !== "string")) {
      return { ok: false as const, error: "The native audio host is unavailable." }
    }
    try {
      return { ok: true as const, device: await audioHostSupervisor.resolveInputDevice(value) }
    } catch {
      return { ok: false as const, error: "The native audio host is unavailable." }
    }
  })
  const nativeSessionFailure = (error?: unknown) => ({
    ok: false as const,
    error: error instanceof NativeAudioHostCommandError
      ? `The native audio session rejected request ${error.requestType}.`
      : "The native audio session is unavailable.",
  })
  const sessionSupervisorFor = (event: Electron.IpcMainInvokeEvent) => (
    audioHostAllowed(event) ? audioHostSupervisor : undefined
  )
  const validUnsigned32 = (value: unknown): value is number => (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff
  )
  const nativeTransactionToken = (value: unknown): string | undefined => (
    value === undefined
      ? undefined
      : typeof value === "string"
        && /^[A-Za-z0-9_-]{43}$/.test(value)
        ? value
        : undefined
  )
  const nativeSessionEnvelope = (value: unknown): { value: unknown; transactionToken?: string } | undefined => {
    if (typeof value !== "object" || value === null || !("value" in value) || !("transactionToken" in value)) return undefined
    const transactionToken = nativeTransactionToken(value.transactionToken)
    if (value.transactionToken !== undefined && transactionToken === undefined) return undefined
    return { value: value.value, ...(transactionToken === undefined ? {} : { transactionToken }) }
  }
  const nativeSessionConfiguration = (value: unknown): NativeHostDeviceConfiguration | undefined => {
    if (
      typeof value !== "object" || value === null
      || !("deviceId" in value) || typeof value.deviceId !== "string"
      || !("sampleRateHz" in value) || !validUnsigned32(value.sampleRateHz)
      || !("maxFramesPerBlock" in value) || !validUnsigned32(value.maxFramesPerBlock)
      || !("channelCount" in value) || !validUnsigned32(value.channelCount)
      || !("revision" in value) || !validUnsigned32(value.revision)
    ) return undefined
    return {
      deviceId: value.deviceId,
      sampleRateHz: value.sampleRateHz,
      maxFramesPerBlock: value.maxFramesPerBlock,
      channelCount: value.channelCount,
      revision: value.revision,
    }
  }
  const nativeSessionTransport = (value: unknown): NativeHostTransport | undefined => {
    if (
      typeof value !== "object" || value === null
      || !("epoch" in value) || !validUnsigned32(value.epoch)
      || !("running" in value) || typeof value.running !== "boolean"
      || !("frame" in value) || typeof value.frame !== "number" || !Number.isSafeInteger(value.frame)
    ) return undefined
    return { epoch: value.epoch, running: value.running, frame: value.frame }
  }
  const nativeSessionRecordingConfiguration = (value: unknown): NativeHostRecordingConfiguration | undefined => {
    if (
      typeof value !== "object" || value === null
      || !Object.keys(value).every((key) => (
        key === "deviceUid" || key === "generation" || key === "sessionId" || key === "channelCount"
        || key === "inputChannels" || key === "gain" || key === "polarity"
        || key === "punchStartFrame" || key === "punchEndFrame" || key === "monitoring"
      ))
      || !("deviceUid" in value) || typeof value.deviceUid !== "string"
      || !("generation" in value) || !validUnsigned32(value.generation) || value.generation === 0
      || !("sessionId" in value) || typeof value.sessionId !== "bigint" || value.sessionId <= 0n
      || !("channelCount" in value) || (value.channelCount !== 1 && value.channelCount !== 2)
      || !("inputChannels" in value) || !Array.isArray(value.inputChannels)
      || value.inputChannels.length !== value.channelCount
      || !value.inputChannels.every(validUnsigned32)
      || !("gain" in value) || typeof value.gain !== "number" || !Number.isFinite(value.gain) || value.gain < 0
      || !("polarity" in value) || (value.polarity !== 1 && value.polarity !== -1)
      || !("punchStartFrame" in value) || typeof value.punchStartFrame !== "number"
      || !Number.isSafeInteger(value.punchStartFrame) || value.punchStartFrame < 0
      || !("punchEndFrame" in value)
      || (value.punchEndFrame !== null && (
        typeof value.punchEndFrame !== "number"
        || !Number.isSafeInteger(value.punchEndFrame)
        || value.punchEndFrame < value.punchStartFrame
      ))
      || !("monitoring" in value) || typeof value.monitoring !== "boolean"
    ) return undefined
    return {
      deviceUid: value.deviceUid,
      generation: value.generation,
      sessionId: value.sessionId,
      channelCount: value.channelCount,
      inputChannels: value.inputChannels,
      gain: value.gain,
      polarity: value.polarity,
      punchStartFrame: value.punchStartFrame,
      punchEndFrame: value.punchEndFrame,
      monitoring: value.monitoring,
    }
  }
  const nativeSessionAsset = (value: unknown): NativeHostPcmAsset | undefined => {
    if (
      typeof value !== "object" || value === null
      || !Object.keys(value).every((key) => (
        key === "sessionAssetId" || key === "frameCount" || key === "sampleRateHz"
        || key === "channelCount" || key === "planarPcm" || key === "contentHashPrefix"
      ))
      || !("sessionAssetId" in value) || !validUnsigned32(value.sessionAssetId)
      || !("frameCount" in value) || !validUnsigned32(value.frameCount)
      || !("sampleRateHz" in value) || !validUnsigned32(value.sampleRateHz)
      || !("channelCount" in value) || !validUnsigned32(value.channelCount)
      || !("planarPcm" in value) || !(value.planarPcm instanceof Uint8Array)
      || ("contentHashPrefix" in value && value.contentHashPrefix !== undefined && !(value.contentHashPrefix instanceof Uint8Array))
    ) return undefined
    return {
      sessionAssetId: value.sessionAssetId,
      frameCount: value.frameCount,
      sampleRateHz: value.sampleRateHz,
      channelCount: value.channelCount,
      planarPcm: value.planarPcm,
      ...("contentHashPrefix" in value && value.contentHashPrefix instanceof Uint8Array
        ? { contentHashPrefix: value.contentHashPrefix }
        : {}),
    }
  }
  const nativeSessionBytes = (value: unknown) => value instanceof Uint8Array ? value : undefined
  const nativeEditorAnchor = (
    event: Electron.IpcMainInvokeEvent,
    value: unknown,
  ): NativeVstEditorAnchor | null | undefined => {
    if (typeof value !== "object" || value === null) return null
    if (!("anchor" in value)) return undefined
    if (
      typeof value.anchor !== "object"
      || value.anchor === null
      || !("x" in value.anchor)
      || !("y" in value.anchor)
      || typeof value.anchor.x !== "number"
      || typeof value.anchor.y !== "number"
      || !Number.isFinite(value.anchor.x)
      || !Number.isFinite(value.anchor.y)
      || Math.abs(value.anchor.x) > 8_000_000
      || Math.abs(value.anchor.y) > 8_000_000
    ) return null
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
  ipcMain.handle("daw:audio-host:session:configure", async (event, value: unknown) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = nativeSessionEnvelope(value)
    const configuration = nativeSessionConfiguration(envelope?.value)
    if (!supervisor || !envelope || !configuration) return nativeSessionFailure()
    try {
      await supervisor.configure(configuration, envelope.transactionToken)
      return { ok: true as const }
    } catch (error) {
      return nativeSessionFailure(error)
    }
  })
  ipcMain.handle("daw:audio-host:session:install-asset", async (event, value: unknown) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = nativeSessionEnvelope(value)
    const asset = nativeSessionAsset(envelope?.value)
    if (!supervisor || !envelope || !asset) return nativeSessionFailure()
    try {
      await supervisor.installAsset(asset, envelope.transactionToken)
      return { ok: true as const }
    } catch (error) {
      return nativeSessionFailure(error)
    }
  })
  ipcMain.handle("daw:audio-host:session:release-asset", async (event, value: unknown) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = nativeSessionEnvelope(value)
    if (!supervisor || !envelope || !validUnsigned32(envelope.value) || envelope.value === 0) return nativeSessionFailure()
    try {
      await supervisor.releaseAsset(envelope.value, envelope.transactionToken)
      return { ok: true as const }
    } catch (error) {
      return nativeSessionFailure(error)
    }
  })
  ipcMain.handle("daw:audio-host:session:detach-vst", async (event, value: unknown) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = nativeSessionEnvelope(value)
    if (!supervisor || !envelope || typeof envelope.value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(envelope.value)) {
      return nativeSessionFailure()
    }
    try {
      await supervisor.detachVst(envelope.value, envelope.transactionToken)
      activeEditorProjectBindings.remove(envelope.value, envelope.transactionToken)
      return { ok: true as const }
    } catch (error) {
      return nativeSessionFailure(error)
    }
  })
  ipcMain.handle("daw:audio-host:session:editor", async (event, rawValue: unknown) => {
    const envelope = nativeSessionEnvelope(rawValue)
    const value = envelope?.value
    const allowed = audioHostAllowed(event)
    const activeHostCandidate = allowed && audioHostSupervisor?.status().running
      ? audioHostSupervisor
      : undefined
    const manager = allowed ? nativeVst3EditorSessionManager : undefined
    const parsedProjectId = typeof value === "object"
      && value !== null
      && "projectId" in value
      ? projectIdSchemaV1.safeParse(value.projectId)
      : undefined
    if (
      (!manager && !activeHostCandidate)
      || typeof value !== "object"
      || value === null
      || !("instanceId" in value)
      || typeof value.instanceId !== "string"
      || !parsedProjectId?.success
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.instanceId)
      || !("command" in value)
      || (value.command !== "open" && value.command !== "close" && value.command !== "focus" && value.command !== "resize" && value.command !== "status")
      || ("width" in value && (typeof value.width !== "number" || !validUnsigned32(value.width) || value.width > 8192))
      || ("height" in value && (typeof value.height !== "number" || !validUnsigned32(value.height) || value.height > 8192))
      || ("anchor" in value && value.command !== "open" && value.command !== "focus")
      || ("serializedPlan" in value && (typeof value.serializedPlan !== "string" || Buffer.byteLength(value.serializedPlan, "utf8") > 1_048_576))
      || ((value.command === "open" || value.command === "focus" || value.command === "status")
        && (!("serializedPlan" in value) || typeof value.serializedPlan !== "string"))
    ) {
      return { ok: false as const, error: "The native VST editor command is invalid." }
    }
    const anchor = nativeEditorAnchor(event, value)
    if (anchor === null) {
      return { ok: false as const, error: "The native VST editor command is invalid." }
    }
    try {
      const editorCommand: NativeVstEditorCommand = value.command
      const projectId = parsedProjectId.data
      const command = {
        projectId,
        instanceId: value.instanceId,
        command: editorCommand,
        ...("serializedPlan" in value && typeof value.serializedPlan === "string" ? { serializedPlan: value.serializedPlan } : {}),
        ...("width" in value && typeof value.width === "number" ? { width: value.width } : {}),
        ...("height" in value && typeof value.height === "number" ? { height: value.height } : {}),
        ...(anchor === undefined ? {} : { anchor }),
      }
      if (activeHostCandidate) {
        try {
          if (activeHostCandidate.transactionOpen() && !envelope?.transactionToken) {
            throw new Error("The native audio host transaction token is required.")
          }
          const boundProjectId = activeEditorProjectBindings.projectFor(command.instanceId)
          if (boundProjectId !== undefined && boundProjectId !== projectId) {
            throw new Error("The active native VST editor project binding changed.")
          }
          if (boundProjectId === undefined) throw new Error("The active native VST editor is not owned by a committed project binding.")
          const ownership = await activeHostCandidate.executeVstEditorCommand(
            nativeVstEditorOwnershipProbe(command.instanceId),
            envelope?.transactionToken,
          )
          if (!ownership.owned) throw new Error("The active native VST editor is not owned by the committed project binding.")
          const { projectId: _projectId, ...nativeCommand } = command
          const status = command.command === "status"
            ? ownership
            : await activeHostCandidate.executeVstEditorCommand(nativeCommand, envelope?.transactionToken)
          return { ok: true as const, status }
        } catch (error) {
          console.error("[native-vst3] editor active route failed", {
            error: sanitizeNativeVst3DiagnosticError(error),
          })
          const diagnostics = await activeHostCandidate.diagnostics().catch(() => undefined)
          if (diagnostics?.state === "running" || !manager) throw error
        }
      }
      if (!manager) {
        return { ok: false as const, error: "The isolated native VST editor session is unavailable." }
      }
      if (activeHostCandidate?.transactionOpen() && !envelope?.transactionToken) {
        throw new Error("The native audio host transaction token is required.")
      }
      const status = await manager.execute(command)
      return { ok: true as const, status }
    } catch (error) {
      console.error("[native-vst3] editor command failed", {
        error: sanitizeNativeVst3DiagnosticError(error),
      })
      return { ok: false as const, error: sanitizeNativeVst3DiagnosticError(error) }
    }
  })
  ipcMain.handle("daw:audio-host:session:coordinate-vst-attachments", async (event, value: unknown) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = nativeSessionEnvelope(value)
    const sessionValue = envelope?.value
    const workerPath = vst3WorkerPath
    if (
      !supervisor
      || !pluginCatalogStore
      || !workerPath
      || !envelope
      || typeof sessionValue !== "object"
      || sessionValue === null
      || !("projectId" in sessionValue)
      || !projectIdSchemaV1.safeParse(sessionValue.projectId).success
      || !("serializedPlan" in sessionValue)
      || typeof sessionValue.serializedPlan !== "string"
      || Buffer.byteLength(sessionValue.serializedPlan, "utf8") > 1_048_576
      || !("sampleRateHz" in sessionValue)
      || typeof sessionValue.sampleRateHz !== "number"
      || !Number.isFinite(sessionValue.sampleRateHz)
      || sessionValue.sampleRateHz <= 0
      || sessionValue.sampleRateHz > 384_000
    ) return nativeSessionFailure()
    const result = await coordinateNativeVst3Attachments({
      serializedPlan: sessionValue.serializedPlan,
      sampleRateHz: sessionValue.sampleRateHz,
      workerPath,
      catalogStore: pluginCatalogStore,
      audioHost: supervisor,
      transactionToken: envelope.transactionToken,
    })
    if (!result.ok) {
      activeEditorProjectBindings.rollback(envelope.transactionToken)
      return { ok: false as const, error: result.message }
    }
    try {
      const plan = decodeNativeExternalAttachmentPlan(sessionValue.serializedPlan)
      const projectId = projectIdSchemaV1.parse(sessionValue.projectId)
      activeEditorProjectBindings.stage(
        plan.attachments.map((attachment) => attachment.instanceId),
        projectId,
        envelope.transactionToken,
      )
      return { ok: true as const }
    } catch {
      activeEditorProjectBindings.rollback(envelope.transactionToken)
      return nativeSessionFailure()
    }
  })
  const registerNativeSessionBytes = (
    channel: string,
    operation: (supervisor: NonNullable<typeof audioHostSupervisor>, bytes: Uint8Array, transactionToken?: string) => Promise<void>,
  ) => ipcMain.handle(channel, async (event, value: unknown) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = nativeSessionEnvelope(value)
    const bytes = nativeSessionBytes(envelope?.value)
    if (!supervisor || !envelope || !bytes) return nativeSessionFailure()
    try {
      await operation(supervisor, bytes, envelope.transactionToken)
      return { ok: true as const }
    } catch (error) {
      return nativeSessionFailure(error)
    }
  })
  registerNativeSessionBytes("daw:audio-host:session:publish-graph", (supervisor, bytes, transactionToken) => supervisor.publishGraph(bytes, transactionToken))
  registerNativeSessionBytes("daw:audio-host:session:queue-parameter-events", (supervisor, bytes, transactionToken) => supervisor.queueParameterEvents(bytes, transactionToken))
  registerNativeSessionBytes("daw:audio-host:session:queue-vst-parameter-events", (supervisor, bytes, transactionToken) => supervisor.queueVstParameterEvents(bytes, transactionToken))
  registerNativeSessionBytes("daw:audio-host:session:queue-instrument-events", (supervisor, bytes, transactionToken) => supervisor.queueInstrumentEvents(bytes, transactionToken))
  registerNativeSessionBytes("daw:audio-host:session:queue-schedule-window", (supervisor, bytes, transactionToken) => supervisor.queueScheduleWindow(bytes, transactionToken))
  registerNativeSessionBytes("daw:audio-host:session:reenable-vst-schedule-automation", (supervisor, bytes, transactionToken) => supervisor.reenableVstScheduleAutomation(bytes, transactionToken))
  registerNativeSessionBytes("daw:audio-host:session:queue-source-events", (supervisor, bytes, transactionToken) => supervisor.queueSourceEvents(bytes, transactionToken))
  ipcMain.handle("daw:audio-host:session:set-transport", async (event, value: unknown) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = nativeSessionEnvelope(value)
    const transport = nativeSessionTransport(envelope?.value)
    if (!supervisor || !envelope || !transport) return nativeSessionFailure()
    try {
      await supervisor.setTransport(transport, envelope.transactionToken)
      return { ok: true as const }
    } catch {
      return nativeSessionFailure()
    }
  })
  ipcMain.handle("daw:audio-host:session:configure-recording", async (event, value: unknown) => {
    const supervisor = sessionSupervisorFor(event)
    const configuration = nativeSessionRecordingConfiguration(value)
    if (!supervisor || !configuration) return nativeSessionFailure()
    try {
      await supervisor.configureRecording(configuration)
      return { ok: true as const }
    } catch {
      return nativeSessionFailure()
    }
  })
  ipcMain.handle("daw:audio-host:session:stop-recording", async (event, value: unknown) => {
    const supervisor = sessionSupervisorFor(event)
    if (!supervisor || (value !== undefined && (
      typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
    ))) return nativeSessionFailure()
    try {
      await supervisor.stopRecording(value)
      return { ok: true as const }
    } catch {
      return nativeSessionFailure()
    }
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
    } catch {
      return nativeSessionFailure()
    }
  })
  ipcMain.handle("daw:audio-host:session:begin-transaction", async (event, value: unknown) => {
    const supervisor = sessionSupervisorFor(event)
    if (!supervisor || !nativeSessionEnvelope(value)) return nativeSessionFailure()
    try {
      const transactionToken = await supervisor.beginTransaction()
      activeEditorProjectBindings.stageEmpty(transactionToken)
      return { ok: true as const, transactionToken }
    } catch {
      return nativeSessionFailure()
    }
  })
  ipcMain.handle("daw:audio-host:session:commit-transaction", async (event, value: unknown) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = nativeSessionEnvelope(value)
    if (!supervisor || !envelope?.transactionToken) return nativeSessionFailure()
    try {
      await supervisor.commitTransaction(envelope.transactionToken)
      activeEditorProjectBindings.commit(envelope.transactionToken)
      return { ok: true as const }
    } catch {
      activeEditorProjectBindings.rollback(envelope.transactionToken)
      return nativeSessionFailure()
    }
  })
  ipcMain.handle("daw:audio-host:session:rollback-transaction", async (event, value: unknown) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = nativeSessionEnvelope(value)
    if (!supervisor || !envelope?.transactionToken) return nativeSessionFailure()
    try {
      await supervisor.rollbackTransaction(envelope.transactionToken)
      return { ok: true as const }
    } catch {
      return nativeSessionFailure()
    } finally {
      activeEditorProjectBindings.rollback(envelope.transactionToken)
    }
  })
  registerNativeSessionControl("daw:audio-host:session:start", (supervisor) => supervisor.startAudio())
  registerNativeSessionControl("daw:audio-host:session:stop", (supervisor) => supervisor.stopAudio())
  registerNativeSessionControl("daw:audio-host:session:start-recording", (supervisor) => supervisor.startRecording())
  registerNativeSessionControl("daw:audio-host:session:cancel-recording", (supervisor) => supervisor.cancelRecording())
  ipcMain.handle("daw:audio-host:session:teardown", async (event) => {
    const supervisor = sessionSupervisorFor(event)
    if (!supervisor) return nativeSessionFailure()
    try {
      await supervisor.teardown()
      activeEditorProjectBindings.clear()
      return { ok: true as const }
    } catch {
      activeEditorProjectBindings.clear()
      return nativeSessionFailure()
    }
  })
  ipcMain.handle("daw:plugin-catalog:read", async (event) => {
    const store = catalogStoreFor(event)
    if (!store) return catalogFailure("The desktop plug-in catalog is unavailable.")
    try {
      return { ok: true, catalog: catalogViewForRenderer(await store.load()) }
    } catch {
      return catalogFailure("The plug-in catalog could not be read.")
    }
  })
  ipcMain.handle("daw:plugin-catalog:choose-directory", async (event) => {
    const store = catalogStoreFor(event)
    const currentWindow = window_
    if (!store || !currentWindow) return catalogFailure("The desktop plug-in catalog is unavailable.")
    const selection = await dialog.showOpenDialog(currentWindow, { properties: ["openDirectory", "createDirectory"] })
    if (selection.canceled || selection.filePaths.length !== 1) return { ok: true, canceled: true }
    try {
      return { ok: true, canceled: false, catalog: catalogViewForRenderer(await store.addDirectory(selection.filePaths[0])) }
    } catch {
      return catalogFailure("The selected plug-in directory could not be added.")
    }
  })
  ipcMain.handle("daw:plugin-catalog:remove-directory", async (event, value: unknown) => {
    const store = catalogStoreFor(event)
    if (!store) return catalogFailure("The desktop plug-in catalog is unavailable.")
    if (typeof value !== "object" || value === null || !("directory" in value) || typeof value.directory !== "string") {
      return catalogFailure("A plug-in directory is required.")
    }
    try {
      return { ok: true, catalog: catalogViewForRenderer(await store.removeDirectory(value.directory)) }
    } catch {
      return catalogFailure("The plug-in directory could not be removed.")
    }
  })
  ipcMain.handle("daw:plugin-catalog:scan", async (event) => {
    const store = catalogStoreFor(event)
    const scanner = vst3ScannerSupervisor
    if (!store || !scanner) return catalogFailure("The desktop plug-in catalog is unavailable.")
    try {
      const catalog = await store.load()
      return { ok: true, catalog: catalogViewForRenderer(await store.scan((entry) => scanner.scan(entry, catalog.directories))) }
    } catch {
      return catalogFailure("The plug-in catalog could not be scanned.")
    }
  })
  ipcMain.handle("daw:plugin-catalog:preflight-insertion", async (event, value: unknown) => {
    const store = catalogStoreFor(event)
    const request = nativeVst3InsertionPreflightRequestSchema.safeParse(value)
    const workerPath = vst3WorkerPath
    if (!store || !request.success) {
      return { ok: false as const, code: "untrusted-catalog" as const, message: "The native VST3 insertion request is invalid." }
    }
    if (!audioHostAllowed(event) || !audioHostSupervisor || !workerPath) {
      return { ok: false as const, code: "host-unavailable" as const, message: "The native VST3 host is unavailable." }
    }
    try {
      const device = await audioHostSupervisor.resolveOutputDevice()
      if (!device?.available) {
        return { ok: false as const, code: "host-unavailable" as const, message: "No native audio output device is available." }
      }
      return await preflightVst3Insertion({
        request: request.data,
        catalog: await store.reload(),
        workerPath,
        sampleRateHz: device.nominalSampleRateHz,
      })
    } catch {
      return { ok: false as const, code: "host-unavailable" as const, message: "The native VST3 host preflight failed." }
    }
  })
  ipcMain.handle("daw:capability:readChunk", async (event, value: unknown) => {
    const scope = scopeFor(event, value)
    if (!scope || typeof value !== "object" || value === null || !("token" in value) || typeof value.token !== "string") throw new Error("Invalid capability request.")
    return fileCapabilities.readFile(scope, value.token)
  })
  ipcMain.handle("daw:capability:beginWrite", async (event, value: unknown) => {
    const scope = scopeFor(event, value)
    if (!scope || typeof value !== "object" || value === null || !("token" in value) || typeof value.token !== "string" || ("relativePath" in value && value.relativePath !== undefined && typeof value.relativePath !== "string")) throw new Error("Invalid capability request.")
    const relativePath = "relativePath" in value && typeof value.relativePath === "string" ? value.relativePath : undefined
    return fileCapabilities.beginWrite(scope, value.token, relativePath)
  })
  ipcMain.handle("daw:capability:writeChunk", async (event, value: unknown) => {
    const scope = scopeFor(event, value)
    if (!scope || typeof value !== "object" || value === null || !("writerId" in value) || !("offset" in value) || !("chunk" in value) || typeof value.writerId !== "string" || typeof value.offset !== "number" || !(value.chunk instanceof Uint8Array)) throw new Error("Invalid capability request.")
    return fileCapabilities.writeChunk(scope, value.writerId, value.offset, value.chunk)
  })
  ipcMain.handle("daw:capability:commit", async (event, value: unknown) => {
    const scope = scopeFor(event, value)
    if (!scope || typeof value !== "object" || value === null || !("writerId" in value) || typeof value.writerId !== "string") throw new Error("Invalid capability request.")
    return fileCapabilities.commitWrite(scope, value.writerId)
  })
  ipcMain.handle("daw:capability:abort", async (event, value: unknown) => {
    const scope = scopeFor(event, value)
    if (!scope || typeof value !== "object" || value === null || !("writerId" in value) || typeof value.writerId !== "string") throw new Error("Invalid capability request.")
    await fileCapabilities.abortWrite(scope, value.writerId)
  })
}

const createWindow = () => {
  if (!MAIN_WINDOW_VITE_DEV_SERVER_URL && !existsSync(preloadPath)) {
    throw new Error(`Desktop preload bundle is missing: ${preloadPath}`)
  }
  window_ = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  window_.webContents.on("did-start-navigation", () => {
    preparationRegistry.abortAll()
    settleCapabilityRevocation(fileCapabilities.revokeRendererGeneration(generation))
    generation += 1
    rejectRendererPending("Renderer reloaded.")
  })
  window_.webContents.on("render-process-gone", () => {
    preparationRegistry.abortAll()
    settleCapabilityRevocation(fileCapabilities.revokeRendererGeneration(generation))
    rejectRendererPending("Renderer crashed.")
  })
  window_.webContents.setWindowOpenHandler(({ url }) => {
    if (externalUrl(url)) void shell.openExternal(url)
    return { action: "deny" }
  })
  window_.webContents.on("will-navigate", (event, url) => {
    if (!sameAppOrigin(url)) event.preventDefault()
  })
  const close = createCloseHandler({
    prepare: async () => {
      try {
        const reply = await renderRequest("lifecycle.prepareToClose", {}, randomUUID(), 10_000)
        const result = reply.result
        return typeof result === "object" && result !== null && "flushed" in result && result.flushed === true
      } catch {
        return false
      }
    },
    confirmDiscard: async () => {
      const choice = await dialog.showMessageBox(window_!, {
        type: "warning",
        buttons: ["Cancel", "Quit and Discard"],
        defaultId: 0,
        cancelId: 0,
        message: "The project could not finish saving before closing.",
        detail: "Cancel keeps the project open. Quit and Discard closes without waiting for recording finalization or pending writes.",
        noLink: true,
      })
      return choice.response === 1
    },
    destroy: () => window_?.destroy(),
    finishQuit,
  })
  window_.on("close", (event) => {
    if (window_?.isDestroyed() || finishingQuit) return
    event.preventDefault()
    void close()
  })
  void window_.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL ?? "daw://app/")
}

app.setName(appName)
const finishQuit = async () => {
  if (finishingQuit) return
  finishingQuit = true
  preparationRegistry.abortAll()
  rejectRendererPending("Application is closing.")
  activeEditorProjectBindings.clear()
  await fileCapabilities.revokeAll()
  await nativeVst3EditorSessionManager?.teardownAll()
  await audioHostSupervisor?.teardown()
  removeAudioHostLossListener?.()
  removeAudioHostRecordingBlockListener?.()
  removeAudioHostRecordingStatusListener?.()
  removeAudioHostMeterBatchListener?.()
  removeAudioHostScheduleProgressListener?.()
  removeAudioHostWorkerNotificationListener?.()
  await closeSocket()
  app.exit()
}
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()
else {
  app.on("second-instance", () => {
    window_?.show()
    window_?.focus()
  })
  app.whenReady().then(async () => {
    nativeMediaAvailable = await nativeFileCapabilityHelper.selfTest()
    let scannerPath: string | undefined
    if (process.platform === "darwin" && app.isPackaged) {
      const manifestPath = path.join(process.resourcesPath, nativeReleaseArtifactManifestName)
      if (existsSync(manifestPath)) {
        try {
          const artifacts = await verifyPackagedNativeReleaseArtifacts(process.resourcesPath)
          scannerPath = artifacts.scannerPath
          vst3WorkerPath = artifacts.workerPath
          audioHostPath = artifacts.audioHostPath
          nativeReleaseArtifactVerification = { status: "verified" }
        } catch (error) {
          nativeReleaseArtifactVerification = {
            status: "failed",
            reason: error instanceof Error ? error.message : "Native release artifact verification failed.",
          }
        }
      }
    } else if (process.platform === "darwin") {
      scannerPath = packagedVst3ScannerPath(process.resourcesPath, false, process.env.DAW_VST3_SCANNER_PATH)
      vst3WorkerPath = packagedVst3WorkerPath(process.resourcesPath, false, process.env.DAW_VST3_WORKER_PATH)
      audioHostPath = packagedAudioHostPath(process.resourcesPath, false, process.env.DAW_AUDIO_HOST_PATH)
      nativeReleaseArtifactVerification = { status: "development" }
    }
    vst3ScannerSupervisor = scannerPath ? createVst3ScannerSupervisor({
      platform: process.platform,
      arch: process.arch,
      scannerPath,
    }) : undefined
    pluginCatalogStore = createPluginCatalogStore({
      filePath: path.join(app.getPath("userData"), "plugin-catalog-v1.json"),
    })
    audioHostSupervisor = audioHostPath ? createNativeAudioHostSupervisor(audioHostPath) : undefined
    const sendVstParameterEdit = (input: {
      projectId: string
      source: "active-playback" | "editor-session"
      instanceId: string
      parameterId: number
      normalizedValue: number
    }) => {
      const target = window_?.webContents
      if (!target || target.isDestroyed() || !sameAppOrigin(target.getURL())) return
      target.send("daw:audio-host:vst-parameter-edit", input)
    }
    removeAudioHostWorkerNotificationListener = audioHostSupervisor?.onWorkerNotification((notification) => {
      if (notification.kind !== "parameter-edit") return
      const projectId = activeEditorProjectBindings.projectFor(notification.instanceId)
      if (!projectId) return
      sendVstParameterEdit({
        projectId,
        source: "active-playback",
        instanceId: notification.instanceId,
        parameterId: notification.parameterId,
        normalizedValue: notification.normalizedValue,
      })
    })
    const editorHostPath = audioHostPath
    nativeVst3EditorSessionManager = editorHostPath && vst3WorkerPath
      ? createNativeVst3EditorSessionManager({
        workerPath: vst3WorkerPath,
        catalogStore: pluginCatalogStore,
        createSupervisor: () => createNativeAudioHostSupervisor(editorHostPath),
        onEditorInteraction: () => {
          const target = window_
          if (!target || target.isDestroyed() || finishingQuit) return
          target.show()
          app.focus({ steal: true })
          target.focus()
        },
        onParameterEdit: (input) => sendVstParameterEdit({
          projectId: input.projectId,
          source: "editor-session",
          instanceId: input.instanceId,
          parameterId: input.parameterId,
          normalizedValue: input.normalizedValue,
        }),
      })
      : undefined
    removeAudioHostLossListener = audioHostSupervisor?.onLoss(() => {
      activeEditorProjectBindings.clear()
      const target = window_?.webContents
      if (target && !target.isDestroyed() && sameAppOrigin(target.getURL())) target.send("daw:audio-host:loss")
    })
    removeAudioHostRecordingBlockListener = audioHostSupervisor?.onRecordingBlock((block) => {
      const target = window_?.webContents
      if (target && !target.isDestroyed() && sameAppOrigin(target.getURL())) {
        target.send("daw:audio-host:recording-block", block)
      }
    })
    removeAudioHostRecordingStatusListener = audioHostSupervisor?.onRecordingStatus((status) => {
      const target = window_?.webContents
      if (target && !target.isDestroyed() && sameAppOrigin(target.getURL())) {
        target.send("daw:audio-host:recording-status", status)
      }
    })
    removeAudioHostMeterBatchListener = audioHostSupervisor?.onMeterBatch((batch: NativeHostMeterBatch) => {
      const target = window_?.webContents
      if (target && !target.isDestroyed() && sameAppOrigin(target.getURL())) {
        target.send("daw:audio-host:meter-batch", batch)
      }
    })
    removeAudioHostScheduleProgressListener = audioHostSupervisor?.onScheduleProgress((progress: NativeScheduleProgress) => {
      const target = window_?.webContents
      if (target && !target.isDestroyed() && sameAppOrigin(target.getURL())) {
        target.send("daw:audio-host:schedule-progress", progress)
      }
    })
    protocol.handle("daw", (request) => {
      const rendererRoot = MAIN_WINDOW_VITE_DEV_SERVER_URL
        ? path.join(import.meta.dirname, "../renderer/main_window")
        : packagedRendererRoot(app.getAppPath())
      const safePath = rendererAssetPath(rendererRoot, request.url)
      if (!safePath || !existsSync(safePath)) return new Response("Not found", { status: 404 })
      return electronNet.fetch(pathToFileURL(safePath).toString())
    })
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [createContentSecurityPolicy(Boolean(MAIN_WINDOW_VITE_DEV_SERVER_URL))],
      },
    }))
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => callback(
      (
        allowsTrustedAudioCapturePermission({
          permission,
          requestingUrl: webContents.getURL(),
          mediaTypes: "mediaTypes" in details ? details.mediaTypes : undefined,
        })
      )
      || allowsTrustedMidiPermission({
        permission,
        trustedRendererId: window_?.webContents.id,
        requestingRendererId: webContents.id,
        requestingUrl: details.requestingUrl,
        isMainFrame: details.isMainFrame,
      }),
    ))
    session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) =>
      (
        webContents !== null
        && allowsTrustedAudioCapturePermission({
          permission,
          requestingUrl: requestingOrigin,
          mediaTypes: details.mediaType === "audio" ? ["audio"] : undefined,
        })
      )
      || allowsTrustedMidiPermission({
        permission,
        trustedRendererId: window_?.webContents.id,
        requestingRendererId: webContents?.id,
        requestingUrl: requestingOrigin,
        isMainFrame: details.isMainFrame,
      }))
    registerIpc()
    await startSocket()
    createWindow()
  }).catch(() => app.quit())
  app.on("before-quit", (event) => {
    if (finishingQuit) return
    event.preventDefault()
    if (window_ && !window_.isDestroyed()) window_.close()
    else void finishQuit()
  })
  app.on("window-all-closed", () => void finishQuit())
}
