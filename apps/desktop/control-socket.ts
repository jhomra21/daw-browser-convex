import { app } from "electron"
import { createServer, type Socket } from "node:net"
import { chmod, mkdir, rm, writeFile } from "node:fs/promises"
import { randomBytes, timingSafeEqual } from "node:crypto"
import path from "node:path"
import { desktopHelloSchemaV1, desktopHelloSchemaV2, desktopHostExportRunInputSchemaV1, desktopHostExportRunResultSchemaV1, desktopHostImportInputSchemaV1, desktopHostImportResultSchemaV1, desktopRendererExportInputSchemaV1, desktopRendererImportInputSchemaV1, desktopProtocolVersion, desktopProtocolVersionV2, desktopRegistrationSchemaV1, hostError, hostErrorSchemaV1, hostErrorV2, type DesktopOperationV1, type DesktopProtocolVersion } from "@daw-browser/desktop-protocol"
import { hostRequestChannel } from "@daw-browser/desktop-protocol/ipc-channels"
import { createDesktopFrameDecoder, encodeDesktopFrame } from "@daw-browser/desktop-protocol/socket"
import { serializeDesktopReply } from "@daw-browser/desktop-protocol/reply-chunks"
import { FileCapabilityError, type createFileCapabilityManager } from "./file-capabilities"
import { createRequestCorrelation } from "./request-correlation"
import { prepareDesktopReply } from "./renderer-reply"
import { ae08ControlCommitReceived, type createAe08Evidence } from "./ae08-evidence"
import type { createPreparationRegistry } from "./preparation-registry"
import type { RendererRequestInput, RendererSession } from "./renderer-session"
import type { desktopOperations } from "./desktop-operations"
import type { RequestScopes } from "./request-scopes"

/** The local control socket: authenticates clients, prepares their requests for the renderer and relays the replies. */
export const createControlSocket = (options: {
  appName: string
  rendererSession: RendererSession
  preparationRegistry: ReturnType<typeof createPreparationRegistry>
  fileCapabilities: ReturnType<typeof createFileCapabilityManager>
  scopes: RequestScopes
  ae08Evidence: ReturnType<typeof createAe08Evidence>
  availableOperations: () => ReturnType<typeof desktopOperations>
}) => {
  const { appName, rendererSession, preparationRegistry, fileCapabilities, scopes, ae08Evidence, availableOperations: availableDesktopOperations } = options

  const {
    importScopes,
    exportScopes,
    importCandidates,
    terminalExportsAwaitingScope,
    terminalImportsAwaitingScope,
    exportScopesHasScope,
    importScopesHasScope,
    settleCapabilityRevocation,
  } = scopes

  const instanceId = randomBytes(16).toString("hex")
  const secret = randomBytes(32).toString("hex")
  let registrationPath = ""
  let socketPath = ""
  let socketServer: ReturnType<typeof createServer> | undefined
  const acceptedSockets = new Set<Socket>()
  const preparedExportModes = new Map<string, "mixdown" | "stems">()

  const operationFailure = (_operation: DesktopOperationV1, code: Parameters<typeof hostError>[0], message: string) => hostError(code, message)
  const operationFailureV2 = (_operation: DesktopOperationV1, code: Parameters<typeof hostError>[0], message: string) => hostErrorV2(code, message)

  class RendererRefusal extends Error {
    constructor(readonly code: Parameters<typeof hostError>[0], message: string) {
      super(message)
    }
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

  const cancelPreparedRendererExport = (id: string) => {
    const mode = preparedExportModes.get(id)

    if (!mode) return
    preparedExportModes.delete(id)
    rendererSession.send(hostRequestChannel, {
      generation: rendererSession.generation(),
      frame: {
        version: desktopProtocolVersion,
        type: "request",
        id,
        operation: "host.export.run",
        input: desktopRendererExportInputSchemaV1.parse({ canceled: true, mode }),
      },
    })
  }

  const prepareRendererInput = async (
    operation: DesktopOperationV1,
    input: RendererRequestInput,
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
        selection.canceled
          ? { canceled: true }
          : {
            canceled: false,
            files: selection.files.map(({ token, basename, byteLength, mime }) => ({ token, basename, byteLength, mime })),
          },
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

      const preflight = await rendererSession.request("host.export.run", desktopRendererExportInputSchemaV1.parse({
        ...request,
        canceled: false,
        preflightOnly: true,
        destination: placeholderDestination,
      }), scope.requestId)

      if (preflight.error) {
        const refusal = hostErrorSchemaV1.safeParse(preflight.error)
        throw new RendererRefusal(refusal.success ? refusal.data.code : "internal", preflight.error.message)
      }

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
    const finalImportCandidates = new Set<string>()
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

        if (!finalExportCandidates.has(rendererId) && !finalImportCandidates.has(rendererId)) {
          rendererSession.reject(rendererId, "Desktop host connection closed.")
        }
      }

      correlation.clear()

      for (const rendererId of rendererIds) {
        if (finalExportCandidates.has(rendererId)
          || finalImportCandidates.has(rendererId)
          || importScopesHasScope({ requestId: rendererId, rendererGeneration: rendererSession.generation() })) continue
        settleCapabilityRevocation(fileCapabilities.revokeRequest({ requestId: rendererId, rendererGeneration: rendererSession.generation() }))
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
          finalImportCandidates.delete(rendererId)
          importCandidates.delete(rendererId)
          cancelPreparedRendererExport(rendererId)
          const controller = preparationControllers.get(rendererId)
          controller?.abort()

          if (controller) preparationRegistry.delete(controller)
          preparationControllers.delete(rendererId)
          const canceledScope = { requestId: rendererId, rendererGeneration: rendererSession.generation() }
          settleCapabilityRevocation(fileCapabilities.revokeRequest(canceledScope).finally(() => {
            rendererSession.reject(rendererId, "Desktop host request cancelled.")
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
      ae08ControlCommitReceived(ae08Evidence, frame)

      if (rendererSession.diagnostics.enabled && frame.operation === "diagnostics.snapshot.v2") {
        const start = rendererSession.diagnostics.trace.start()
        rendererSession.diagnostics.starts.set(rendererId, start)
        rendererSession.diagnostics.trace.mark(start, "socket-received")
      }

      const preparation = new AbortController()
      preparationRegistry.add(preparation)
      preparationControllers.set(rendererId, preparation)
      const scope = { requestId: rendererId, rendererGeneration: rendererSession.generation() }
      void prepareRendererInput(frame.operation, frame.input, scope, preparation.signal)
        .then((input) => {
          preparation.signal.throwIfAborted()

          if (frame.operation === "host.export.run") {
            const parsed = desktopRendererExportInputSchemaV1.parse(input)

            if (!parsed.canceled && !parsed.preflightOnly) finalExportCandidates.add(rendererId)
          }

          if (frame.operation === "host.import.audio") {
            const parsed = desktopRendererImportInputSchemaV1.parse(input)

            if (!parsed.canceled) {
              finalImportCandidates.add(rendererId)
              importCandidates.set(rendererId, scope)
            }
          }

          return rendererSession.request(frame.operation, input, rendererId, frame.deadlineMs, actorSubject)
        }).then(async (reply) => {
        preparationControllers.delete(rendererId)
        preparationRegistry.delete(preparation)
        finalExportCandidates.delete(rendererId)
        finalImportCandidates.delete(rendererId)
        importCandidates.delete(rendererId)

        if (scope.rendererGeneration !== rendererSession.generation()) {
          await fileCapabilities.revokeRequest(scope)

          return
        }

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

        if (frame.operation === "host.import.audio" && !reply.error) {
          const result = desktopHostImportResultSchemaV1.safeParse(reply.result)

          if (result.success && result.data.status === "queued" && result.data.jobId) {
            importScopes.set(result.data.jobId, scope)

            if (terminalImportsAwaitingScope.delete(result.data.jobId)) {
              importScopes.delete(result.data.jobId)
              await fileCapabilities.revokeRequest(scope)
            }
          }
        }

        const externalId = correlation.getExternal(rendererId)

        if (!externalId) {
          if (
            (frame.operation !== "host.export.run" || !exportScopesHasScope(scope))
            && (frame.operation !== "host.import.audio" || !importScopesHasScope(scope))
          ) {
            await fileCapabilities.revokeRequest(scope)
          }

          return
        }

        correlation.removeExternal(externalId)

        if (socket.destroyed) {
          if (
            (frame.operation !== "host.export.run" || !exportScopesHasScope(scope))
            && (frame.operation !== "host.import.audio" || !importScopesHasScope(scope))
          ) {
            await fileCapabilities.revokeRequest(scope)
          }

          return
        }

        if (
          (frame.operation === "host.import.audio" && !importScopesHasScope(scope))
          || (frame.operation === "host.export.run" && !exportScopesHasScope(scope))
        ) {
          await fileCapabilities.revokeRequest(scope)
        }

        try {
          const outboundReply = prepareDesktopReply(
            frame.operation,
            reply,
            externalId,
            sessionProtocolVersion,
          )

          for (const outbound of serializeDesktopReply(
            frame.operation,
            frame.input,
            outboundReply,
            sessionProtocolVersion,
          )) {
            socket.write(encodeDesktopFrame(outbound))
          }

          if (frame.operation === "diagnostics.snapshot.v2") rendererSession.diagnostics.trace.mark(rendererSession.diagnostics.starts.get(rendererId) ?? rendererSession.diagnostics.trace.start(), "socket-reply")
        } catch {
          writeSocketFailure(socket, sessionProtocolVersion, frame.operation, externalId, "internal", "The desktop response could not be serialized.")
        }

        rendererSession.diagnostics.starts.delete(rendererId)
      }).catch(async (error) => {
        preparationControllers.delete(rendererId)
        preparationRegistry.delete(preparation)
        finalExportCandidates.delete(rendererId)
        finalImportCandidates.delete(rendererId)
        importCandidates.delete(rendererId)
        await fileCapabilities.revokeRequest(scope)
        const externalId = correlation.getExternal(rendererId)

        if (!externalId) return
        correlation.removeExternal(externalId)

        // Renderer refusals and file capability errors carry messages written for the user (an existing output
        // path, a stem mode the native renderer cannot produce); anything else stays an opaque failure.
        const failure = error instanceof RendererRefusal ? hostError(error.code, error.message)
          : error instanceof FileCapabilityError ? hostError("invalid-request", error.message)
          : error instanceof Error && error.message === "Renderer deadline exceeded." ? hostError("deadline-exceeded", "The request deadline elapsed.")
          : hostError("unavailable", "The renderer is unavailable.")

        writeSocketFailure(socket, sessionProtocolVersion, frame.operation, externalId, failure.code, failure.message)

        if (frame.operation === "diagnostics.snapshot.v2") rendererSession.diagnostics.trace.mark(rendererSession.diagnostics.starts.get(rendererId) ?? rendererSession.diagnostics.trace.start(), "socket-error-reply")
        rendererSession.diagnostics.starts.delete(rendererId)
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

  return { start: startSocket, close: closeSocket }
}
