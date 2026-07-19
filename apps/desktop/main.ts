import { app, BrowserWindow, dialog, ipcMain, net as electronNet, protocol, session, shell } from "electron"
import { createServer, type Socket } from "node:net"
import { chmod, mkdir, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import path from "node:path"
import {
  desktopFrameSchemaV1,
  desktopHelloSchemaV1,
  desktopHostExportRunInputSchemaV1,
  desktopHostExportRunResultSchemaV1,
  desktopHostImportInputSchemaV1,
  desktopRendererExportInputSchemaV1,
  desktopRendererImportInputSchemaV1,
  desktopProtocolVersion,
  desktopRegistrationSchemaV1,
  desktopRendererRequestSchemaV1,
  desktopTrustedRendererRequestSchemaV1,
  hostError,
  isDesktopControlOperation,
  type DesktopFrameV1,
  type DesktopOperationV1,
  type DesktopRendererRequestV1,
  type DesktopTrustedRendererRequestV1,
} from "@daw-browser/desktop-protocol"
import { createDesktopFrameDecoder, encodeDesktopFrame } from "@daw-browser/desktop-protocol/socket"
import { serializeDesktopReply } from "@daw-browser/desktop-protocol/reply-chunks"
import { createCloseHandler } from "./close-flow"
import { createFileCapabilityManager } from "./file-capabilities"
import { createNativeFileCapabilityHelper } from "./native-file-capability-helper"
import { createRequestCorrelation } from "./request-correlation"
import { createPreparationRegistry } from "./preparation-registry"
import { desktopOperations } from "./desktop-operations"

protocol.registerSchemesAsPrivileged([{ scheme: "daw", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])

const incomingChannel = "daw:host-request"
const outgoingChannel = "daw:host-response"
const allowedOrigin = "daw://app"
const appName = "daw-browser"
const rendererRoot = path.join(import.meta.dirname, "../renderer/main_window")
const preloadPath = path.join(import.meta.dirname, "preload.js")
const externalUrl = (url: string) => {
  try {
    return new URL(url).protocol === "https:"
  } catch {
    return false
  }
}
const sameAppOrigin = (url: string) => url === allowedOrigin || url.startsWith(`${allowedOrigin}/`)
const isAudioCaptureRequest = (details: Electron.PermissionRequest | Electron.FilesystemPermissionRequest | Electron.MediaAccessPermissionRequest | Electron.OpenExternalPermissionRequest) =>
  "mediaTypes" in details && details.mediaTypes !== undefined && details.mediaTypes.length === 1 && details.mediaTypes[0] === "audio"

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
      const hello = desktopHelloSchemaV1.safeParse(frame)
      if (!hello.success || !authenticate(hello.data.secret)) {
        socket.destroy()
        return
      }
      authenticated = true
      actorSubject = `local:${hello.data.actorId}`
      socket.write(encodeDesktopFrame({ version: desktopProtocolVersion, type: "helloAck", sessionId, capabilities: availableDesktopOperations() }))
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
      socket.write(encodeDesktopFrame({ version: desktopProtocolVersion, type: "reply", id: frame.id, error: operationFailure(frame.operation, "unavailable", "The requested desktop operation is unavailable on this platform.") }))
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
        for (const outbound of serializeDesktopReply(frame.operation, { ...reply, id: externalId })) {
          socket.write(encodeDesktopFrame(outbound))
        }
      } catch {
        socket.write(encodeDesktopFrame({ version: desktopProtocolVersion, type: "reply", id: externalId, error: operationFailure(frame.operation, "internal", "The desktop response could not be serialized.") }))
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
      socket.write(encodeDesktopFrame({ version: desktopProtocolVersion, type: "reply", id: externalId, error: operationFailure(frame.operation, code, message) }))
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
  void window_.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL ?? "daw://app/index.html")
}

app.setName(appName)
const finishQuit = async () => {
  if (finishingQuit) return
  finishingQuit = true
  preparationRegistry.abortAll()
  rejectRendererPending("Application is closing.")
  await fileCapabilities.revokeAll()
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
    protocol.handle("daw", (request) => {
      const relative = new URL(request.url).pathname
      const safePath = path.resolve(rendererRoot, `.${relative === "/" ? "/index.html" : relative}`)
      if (!safePath.startsWith(path.resolve(rendererRoot)) || !existsSync(safePath)) return new Response("Not found", { status: 404 })
      return electronNet.fetch(new URL(`file://${safePath}`).toString())
    })
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https: wss:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"],
      },
    }))
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => callback(
      permission === "media"
      && sameAppOrigin(webContents.getURL())
      && isAudioCaptureRequest(details),
    ))
    session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) =>
      webContents !== null
      && permission === "media"
      && sameAppOrigin(requestingOrigin)
      && details.mediaType === "audio")
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
