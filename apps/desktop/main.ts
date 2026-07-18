import { app, BrowserWindow, dialog, ipcMain, net as electronNet, protocol, session, shell } from "electron"
import { createServer, type Socket } from "node:net"
import { chmod, mkdir, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import path from "node:path"
import {
  desktopFrameSchemaV1,
  desktopHelloSchemaV1,
  desktopProtocolVersion,
  desktopRegistrationSchemaV1,
  desktopRendererRequestSchemaV1,
  hostError,
  type DesktopFrameV1,
  type DesktopRendererRequestV1,
} from "@daw-browser/desktop-protocol"
import { createDesktopFrameDecoder, encodeDesktopFrame } from "@daw-browser/desktop-protocol/socket"
import { createCloseHandler } from "./close-flow"
import { createRequestCorrelation } from "./request-correlation"

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
  resolve: (frame: DesktopFrameV1) => void
  reject: (error: Error) => void
}

let window_: BrowserWindow | undefined
let generation = 0
const rendererPending = new Map<string, PendingRendererRequest>()
const instanceId = randomBytes(16).toString("hex")
const secret = randomBytes(32).toString("hex")
let registrationPath = ""
let socketPath = ""
let socketServer: ReturnType<typeof createServer> | undefined
const acceptedSockets = new Set<Socket>()
let finishingQuit = false

const cancelRendererRequest = (id: string, requestGeneration: number) => {
  const target = window_?.webContents
  if (!target || target.isDestroyed() || !sameAppOrigin(target.getURL())) return
  target.send(incomingChannel, {
    generation: requestGeneration,
    frame: { version: desktopProtocolVersion, type: "cancel", id },
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

const sendToRenderer = (request: DesktopRendererRequestV1) => new Promise<DesktopFrameV1>((resolve, reject) => {
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

const renderRequest = async (operation: DesktopRendererRequestV1["operation"], input: unknown, id: string, deadlineMs = 10_000) => {
  const parsed = desktopRendererRequestSchemaV1.parse({ version: desktopProtocolVersion, type: "request", id, operation, input, deadlineMs })
  if (parsed.type !== "request") throw new Error("Invalid desktop request.")
  // This is a bounded deadline guard for a renderer IPC round trip; it is always cleared on completion.
  let timeout: ReturnType<typeof setTimeout> | undefined
  let deadlineElapsed = false
  try {
    return await Promise.race([
      sendToRenderer(parsed),
      new Promise<DesktopFrameV1>((_resolve, reject) => {
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
  const correlation = createRequestCorrelation()
  const sessionId = randomBytes(16).toString("hex")
  acceptedSockets.add(socket)
  const close = () => {
    acceptedSockets.delete(socket)
    for (const rendererId of correlation.internalIds()) rejectRendererRequest(rendererId, "Desktop host connection closed.")
    correlation.clear()
  }
  const decoder = createDesktopFrameDecoder((frame) => {
    if (!authenticated) {
      const hello = desktopHelloSchemaV1.safeParse(frame)
      if (!hello.success || !authenticate(hello.data.secret)) {
        socket.destroy()
        return
      }
      authenticated = true
      socket.write(encodeDesktopFrame({ version: desktopProtocolVersion, type: "helloAck", sessionId, capabilities: ["host.status", "transport.status", "transport.play", "transport.pause", "transport.stop", "transport.seek", "diagnostics.snapshot"] }))
      return
    }
    if (frame.type === "cancel") {
      const rendererId = correlation.removeExternal(frame.id)
      if (rendererId) rejectRendererRequest(rendererId, "Desktop host request cancelled.")
      return
    }
    if (frame.type !== "request" || correlation.getInternal(frame.id)) {
      socket.destroy()
      return
    }
    const rendererId = correlation.create(frame.id)
    void renderRequest(frame.operation, frame.input, rendererId, frame.deadlineMs).then((reply) => {
      const externalId = correlation.getExternal(rendererId)
      if (!externalId || !correlation.removeExternal(externalId) || socket.destroyed) return
      if (reply.type !== "reply") return
      socket.write(encodeDesktopFrame({ ...reply, id: externalId }))
    }).catch((error: unknown) => {
      const externalId = correlation.getExternal(rendererId)
      if (!externalId || !correlation.removeExternal(externalId)) return
      const message = error instanceof Error && error.message === "Renderer deadline exceeded." ? "The request deadline elapsed." : "The renderer is unavailable."
      const code = error instanceof Error && error.message === "Renderer deadline exceeded." ? "deadline-exceeded" : "unavailable"
      socket.write(encodeDesktopFrame({ version: desktopProtocolVersion, type: "reply", id: externalId, error: hostError(code, message) }))
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
    if (!parsed.success || parsed.data.type !== "reply") return
    const pending = rendererPending.get(parsed.data.id)
    if (!pending || pending.generation !== messageGeneration) return
    pending.resolve(parsed.data)
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
    generation += 1
    rejectRendererPending("Renderer reloaded.")
  })
  window_.webContents.on("render-process-gone", () => rejectRendererPending("Renderer crashed."))
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
        const result = reply.type === "reply" ? reply.result : undefined
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
  rejectRendererPending("Application is closing.")
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
