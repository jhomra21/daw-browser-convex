import { connect } from "node:net"
import { constants } from "node:fs"
import { lstat, open, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { homedir, platform } from "node:os"
import { randomBytes } from "node:crypto"
import {
  desktopProtocolVersion,
  desktopProtocolVersionV2,
  desktopControlCapabilitiesInputSchemaV2,
  desktopControlSnapshotInputSchemaV2,
  desktopControlCapabilitiesInputSchemaV1,
  desktopControlSnapshotInputSchemaV1,
  desktopRegistrationSchemaV1,
  hostErrorSchemaV1,
  hostErrorSchemaV2,
  parseDesktopReplyError,
  parseDesktopResult,
  isDesktopControlOperation,
  type HostErrorV1,
  type HostErrorV2,
  type DesktopOperationV1,
  type DesktopJsonValue,
  type DesktopProtocolVersion,
} from "@daw-browser/desktop-protocol"
import { controlErrorSchemaV1, type ControlErrorV1 } from "@daw-browser/control"
import { createDesktopFrameDecoder, encodeDesktopFrame } from "@daw-browser/desktop-protocol/socket"
import { createDesktopReplyReassembler, maxDesktopReplyFrameBytes } from "@daw-browser/desktop-protocol/reply-chunks"
import { loadHostActorIdentity } from "./host-identity"
import { credentialPath } from "./credentials"

type HostPlatform = "darwin" | "win32" | "linux"
type HostPaths = {
  platform: HostPlatform
  homeDirectory: string
  appDataDirectory?: string
  xdgConfigDirectory?: string
  userDataDirectory?: string
  actorPath?: string
}
export class DesktopControlError extends Error {
  constructor(readonly data: ControlErrorV1) {
    super(data.message)
    this.name = "DesktopControlError"
  }
}
export class DesktopHostError extends Error {
  constructor(readonly data: HostErrorV1 | HostErrorV2) {
    super(data.message)
    this.name = "DesktopHostError"
  }
}
export class HostTargetUnavailableError extends Error {
  readonly data = {
    version: "v1" as const,
    code: "unavailable" as const,
    message: "Desktop control host is unavailable.",
  }

  constructor() {
    super("Desktop control host is unavailable.")
    this.name = "HostTargetUnavailableError"
  }
}

const maxRegistrationBytes = 4 * 1024

const currentHostPlatform = (): HostPlatform => {
  const current = platform()
  if (current === "win32") return "win32"
  if (current === "darwin") return "darwin"
  return "linux"
}

const hostDirectory = (paths: HostPaths) => paths.userDataDirectory
  ? path.join(paths.userDataDirectory, "host")
  : paths.platform === "win32"
    ? path.join(paths.appDataDirectory ?? path.join(paths.homeDirectory, "AppData", "Roaming"), "daw-browser", "host")
    : paths.platform === "darwin"
      ? path.join(paths.homeDirectory, "Library", "Application Support", "daw-browser", "host")
      : path.join(paths.xdgConfigDirectory ?? path.join(paths.homeDirectory, ".config"), "daw-browser", "host")

export const registrationFile = (paths: HostPaths = {
  platform: currentHostPlatform(),
  homeDirectory: homedir(),
  appDataDirectory: process.env.APPDATA,
  xdgConfigDirectory: process.env.XDG_CONFIG_HOME,
  userDataDirectory: process.env.DAW_DESKTOP_USER_DATA,
}) => path.join(hostDirectory(paths), "registration-v1.json")

const privateFile = async (file: string, platform_: HostPlatform) => {
  const info = await lstat(file)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Desktop host registration is not private.")
  const directoryPath = path.dirname(file)
  const resolvedDirectory = await realpath(directoryPath)
  const resolvedFile = await realpath(file)
  if (path.dirname(resolvedFile) !== resolvedDirectory) throw new Error("Desktop host registration is not contained by its directory.")
  if (platform_ !== "win32") {
    if ((info.mode & 0o077) !== 0) throw new Error("Desktop host registration is not private.")
    const directory = await stat(directoryPath)
    if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) throw new Error("Desktop host directory is not private.")
  }
  return resolvedDirectory
}

const readHostRegistration = async (paths?: HostPaths) => {
  const resolvedPaths = paths ?? {
    platform: currentHostPlatform(),
    homeDirectory: homedir(),
    appDataDirectory: process.env.APPDATA,
    xdgConfigDirectory: process.env.XDG_CONFIG_HOME,
    userDataDirectory: process.env.DAW_DESKTOP_USER_DATA,
  }
  const file = registrationFile(resolvedPaths)
  const resolvedDirectory = await privateFile(file, resolvedPaths.platform)
  const handle = await open(
    file,
    resolvedPaths.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NOFOLLOW,
  )
  let contents: string
  try {
    const info = await handle.stat()
    if (
      !info.isFile()
      || (resolvedPaths.platform !== "win32" && (info.mode & 0o077) !== 0)
      || info.size > maxRegistrationBytes
    ) {
      throw new Error("Desktop host registration is not private.")
    }
    const buffer = Buffer.alloc(maxRegistrationBytes + 1)
    let bytesRead = 0
    while (bytesRead < buffer.byteLength) {
      const result = await handle.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    if (bytesRead > maxRegistrationBytes) throw new Error("Desktop host registration is invalid.")
    contents = buffer.subarray(0, bytesRead).toString("utf8")
  } finally {
    await handle.close()
  }
  const registration = desktopRegistrationSchemaV1.parse(JSON.parse(contents))
  if (resolvedPaths.platform === "win32") {
    if (!registration.address.startsWith("\\\\.\\pipe\\")) throw new Error("Desktop host address is invalid.")
  } else if (!path.isAbsolute(registration.address)) {
    throw new Error("Desktop host address is invalid.")
  } else {
    let resolvedAddressDirectory: string
    try {
      resolvedAddressDirectory = await realpath(path.dirname(registration.address))
    } catch {
      throw new Error("Desktop host address is invalid.")
    }
    if (resolvedAddressDirectory !== resolvedDirectory) throw new Error("Desktop host address is invalid.")
  }
  return registration
}

type HostClient = {
  protocolVersion: DesktopProtocolVersion
  capabilities: () => Set<DesktopOperationV1>
  request: (operation: DesktopOperationV1, input: DesktopJsonValue, deadlineMs?: number) => Promise<DesktopJsonValue>
  requestV2: (operation: "control.capabilities" | "control.snapshot", input: DesktopJsonValue, deadlineMs?: number) => Promise<DesktopJsonValue>
  close: () => void
}

export const createHostClient = async (options: { paths?: HostPaths; handshakeDeadlineMs?: number } = {}): Promise<HostClient> => {
  const registration = await readHostRegistration(options.paths)
  const actorId = await loadHostActorIdentity(
    path.join(path.dirname(credentialPath()), "host-actor-v1.json"),
    options.paths?.actorPath,
  )
  const connectWithVersion = async (protocolVersion: DesktopProtocolVersion): Promise<HostClient> => {
  const socket = connect(registration.address)
  type PendingRequest = {
    operation: DesktopOperationV1
    input: DesktopJsonValue
    mode: "normal" | "chunks" | undefined
    resolve: (value: DesktopJsonValue) => void
    reject: (error: Error) => void
    timeout: ReturnType<typeof setTimeout>
    reassembler: ReturnType<typeof createDesktopReplyReassembler>
  }
  const pending = new Map<string, PendingRequest>()
  let acceptHello: (() => void) | undefined
  let rejectHello: ((error: Error) => void) | undefined
  let closed = false
  let helloAccepted = false
  let capabilities = new Set<DesktopOperationV1>()
  const hello = new Promise<void>((resolve, reject) => {
    acceptHello = resolve
    rejectHello = reject
  })

  const disposeRequest = (id: string, request: PendingRequest) => {
    pending.delete(id)
    clearTimeout(request.timeout)
    request.reassembler.dispose()
  }

  const rejectPending = (error: Error) => {
    if (closed) return
    closed = true
    clearTimeout(handshakeTimer)
    rejectHello?.(error)
    for (const [id, request] of pending) {
      disposeRequest(id, request)
      request.reject(error)
    }
  }

  const closeConnection = (error: Error) => {
    rejectPending(error)
    socket.destroy()
  }

  // The deadline starts before connection so an accepted but silent server cannot hang the CLI.
  const handshakeTimer = setTimeout(() => {
    closeConnection(new Error("Desktop host handshake deadline exceeded."))
  }, options.handshakeDeadlineMs ?? 5_000)

  const rejectInvalidReply = (id: string, request: PendingRequest, failure: Error) => {
    disposeRequest(id, request)
    request.reject(failure)
    closeConnection(failure)
  }

  const settleReply = (
    id: string,
    request: PendingRequest,
    reply: { result?: DesktopJsonValue; error?: DesktopJsonValue },
  ) => {
    disposeRequest(id, request)
    try {
      if (reply.error !== undefined) {
        const parsedError = parseDesktopReplyError(request.operation, reply.error, protocolVersion)
        const controlError = controlErrorSchemaV1.safeParse(parsedError)
        if (isDesktopControlOperation(request.operation) && controlError.success) {
          request.reject(new DesktopControlError(controlError.data))
        } else {
          request.reject(new DesktopHostError((protocolVersion === desktopProtocolVersionV2 ? hostErrorSchemaV2 : hostErrorSchemaV1).parse(parsedError)))
        }
      } else {
        if (reply.result === undefined) throw new Error("Desktop host reply is missing a result.")
        request.resolve(parseDesktopResult(request.operation, reply.result, request.input, protocolVersion))
      }
    } catch (error) {
      request.reject(error instanceof Error ? error : new Error("Invalid desktop host reply."))
      closeConnection(error instanceof Error ? error : new Error("Invalid desktop host reply."))
    }
  }

  const decoder = createDesktopFrameDecoder((frame, payloadByteLength) => {
    if (frame.type === "helloAck") {
      const validAck = protocolVersion === desktopProtocolVersionV2
        ? frame.version === desktopProtocolVersionV2 && "selectedVersion" in frame && frame.selectedVersion === desktopProtocolVersionV2
        : frame.version === desktopProtocolVersion
      if (helloAccepted || !validAck) closeConnection(new Error("Invalid desktop host handshake."))
      else {
        helloAccepted = true
        capabilities = new Set(frame.capabilities)
        clearTimeout(handshakeTimer)
        acceptHello?.()
      }
      return
    }
    if (!helloAccepted) {
      closeConnection(new Error("Desktop host sent a frame before the handshake acknowledgement."))
      return
    }
    if (frame.version !== protocolVersion) {
      closeConnection(new Error("Desktop host sent a mixed protocol frame."))
      return
    }
    if (frame.type !== "reply" && frame.type !== "replyChunk") return
    const request = pending.get(frame.id)
    if (!request) {
      closeConnection(new Error("Unsolicited desktop host reply."))
      return
    }
    if (payloadByteLength > maxDesktopReplyFrameBytes) {
      rejectInvalidReply(frame.id, request, new Error("Desktop reply exceeds the frame size limit."))
      return
    }
    if (frame.type === "replyChunk") {
      try {
        if (request.mode === "normal") throw new Error("Mixed desktop reply framing.")
        request.mode = "chunks"
        const reply = request.reassembler.push(frame, payloadByteLength)
        if (!reply) return
        settleReply(frame.id, request, reply)
      } catch (error) {
        rejectInvalidReply(frame.id, request, error instanceof Error ? error : new Error("Invalid desktop reply chunk."))
      }
      return
    }
    if (request.mode === "chunks") {
      rejectInvalidReply(frame.id, request, new Error("Mixed desktop reply framing."))
      return
    }
    request.mode = "normal"
    settleReply(frame.id, request, frame)
  })
  socket.on("data", (chunk: Buffer) => {
    try {
      decoder(chunk)
    } catch (error) {
      closeConnection(error instanceof Error ? error : new Error("Invalid desktop host frame."))
    }
  })
  socket.on("error", (error) => {
    rejectPending(error)
    socket.destroy()
  })
  socket.on("end", () => {
    rejectPending(new Error("Desktop host connection closed."))
  })
  socket.on("close", () => {
    rejectPending(new Error("Desktop host connection closed."))
  })
  socket.on("connect", () => {
    socket.write(encodeDesktopFrame(
      protocolVersion === desktopProtocolVersionV2
        ? { version: desktopProtocolVersionV2, type: "hello", secret: registration.secret, client: "daw-control", actorId, supportedVersions: [desktopProtocolVersion, desktopProtocolVersionV2] }
        : { version: desktopProtocolVersion, type: "hello", secret: registration.secret, client: "daw-control", actorId },
    ))
  })
  await hello
  if (closed || socket.destroyed) throw new Error("Desktop host connection closed.")
  const request = (operation: DesktopOperationV1, input: DesktopJsonValue, deadlineMs = 10_000): Promise<DesktopJsonValue> => {
    if (closed || socket.destroyed) return Promise.reject(new Error("Desktop host connection closed."))
    if (!capabilities.has(operation)) return Promise.reject(new Error(`Desktop host does not advertise ${operation}.`))
    const id = randomBytes(16).toString("hex")
    return new Promise((resolve, reject) => {
      // A client deadline prevents a wedged renderer from retaining a CLI request.
      const timeout = setTimeout(() => {
        const pendingRequest = pending.get(id)
        if (!pendingRequest) return
        disposeRequest(id, pendingRequest)
        if (!closed && !socket.destroyed) {
          socket.write(encodeDesktopFrame({ version: protocolVersion, type: "cancel", id }))
        }
        reject(new Error("Desktop host request deadline exceeded."))
      }, deadlineMs)
      pending.set(id, {
        operation,
        input,
        mode: undefined,
        resolve,
        reject,
        timeout,
        reassembler: createDesktopReplyReassembler(id, operation, input, protocolVersion),
      })
      socket.write(encodeDesktopFrame({ version: protocolVersion, type: "request", id, operation, input, deadlineMs }))
    })
  }
  return {
    protocolVersion,
    capabilities: () => new Set(capabilities),
    request,
    requestV2: (operation, input, deadlineMs = 10_000) => {
      if (protocolVersion !== desktopProtocolVersionV2) {
        return Promise.reject(new DesktopHostError({
          version: desktopProtocolVersion,
          code: "unsupported-version",
          message: "Desktop host does not support protocol V2 control reads.",
        }))
      }
      const v2Input = operation === "control.capabilities"
        ? desktopControlCapabilitiesInputSchemaV2.parse({
            ...desktopControlCapabilitiesInputSchemaV1.parse(input),
            readVersion: "v2",
          })
        : desktopControlSnapshotInputSchemaV2.parse({
            ...desktopControlSnapshotInputSchemaV1.parse(input),
            readVersion: "v2",
          })
      return request(operation, v2Input, deadlineMs)
    },
    close: () => {
      rejectPending(new Error("Desktop host connection closed."))
      socket.destroy()
    },
  }
  }
  try {
    return await connectWithVersion(desktopProtocolVersionV2)
  } catch {
    return connectWithVersion(desktopProtocolVersion)
  }
}

export const createAvailableHostClient = async (
  options: { paths?: HostPaths; handshakeDeadlineMs?: number } = {},
): Promise<HostClient> => {
  try {
    return await createHostClient(options)
  } catch (cause) {
    if (cause instanceof DesktopControlError || cause instanceof DesktopHostError || cause instanceof HostTargetUnavailableError) {
      throw cause
    }
    throw new HostTargetUnavailableError()
  }
}
