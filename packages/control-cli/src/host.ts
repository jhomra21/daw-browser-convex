import { connect } from "node:net"
import { lstat, readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { homedir, platform } from "node:os"
import { randomBytes } from "node:crypto"
import {
  desktopHelloAckSchemaV1,
  desktopProtocolVersion,
  desktopRegistrationSchemaV1,
  type DesktopOperationV1,
} from "@daw-browser/desktop-protocol"
import { createDesktopFrameDecoder, encodeDesktopFrame } from "@daw-browser/desktop-protocol/socket"

type HostPlatform = "darwin" | "win32" | "linux"
type HostPaths = {
  platform: HostPlatform
  homeDirectory: string
  appDataDirectory?: string
  xdgConfigDirectory?: string
  userDataDirectory?: string
}

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
  if (platform_ === "win32") return
  if ((info.mode & 0o077) !== 0) throw new Error("Desktop host registration is not private.")
  const directory = await stat(directoryPath)
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) throw new Error("Desktop host directory is not private.")
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
  await privateFile(file, resolvedPaths.platform)
  const registration = desktopRegistrationSchemaV1.parse(JSON.parse(await readFile(file, "utf8")))
  if (resolvedPaths.platform === "win32") {
    if (!registration.address.startsWith("\\\\.\\pipe\\")) throw new Error("Desktop host address is invalid.")
  } else if (!path.isAbsolute(registration.address) || path.dirname(registration.address) !== path.dirname(file)) {
    throw new Error("Desktop host address is invalid.")
  }
  return registration
}

export const createHostClient = async (options: { paths?: HostPaths; handshakeDeadlineMs?: number } = {}) => {
  const registration = await readHostRegistration(options.paths)
  const socket = connect(registration.address)
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>()
  let acceptHello: (() => void) | undefined
  let rejectHello: ((error: Error) => void) | undefined
  let closed = false
  const hello = new Promise<void>((resolve, reject) => {
    acceptHello = () => {
      clearTimeout(handshakeTimer)
      resolve()
    }
    rejectHello = (error) => {
      clearTimeout(handshakeTimer)
      reject(error)
    }
  })
  const decoder = createDesktopFrameDecoder((frame) => {
    if (frame.type === "helloAck") {
      const parsed = desktopHelloAckSchemaV1.safeParse(frame)
      if (!parsed.success) socket.destroy(new Error("Invalid desktop host handshake."))
      else acceptHello?.()
      return
    }
    if (frame.type !== "reply") return
    const request = pending.get(frame.id)
    if (!request) return
    pending.delete(frame.id)
    clearTimeout(request.timeout)
    if (frame.error) request.reject(new Error(frame.error.message))
    else request.resolve(frame.result)
  })
  socket.on("data", (chunk: Buffer) => {
    try {
      decoder(chunk)
    } catch {
      socket.destroy(new Error("Invalid desktop host frame."))
    }
  })
  const rejectPending = (error: Error) => {
    if (closed) return
    closed = true
    rejectHello?.(error)
    for (const request of pending.values()) {
      clearTimeout(request.timeout)
      request.reject(error)
    }
    pending.clear()
  }
  socket.on("error", rejectPending)
  socket.on("close", () => {
    rejectPending(new Error("Desktop host connection closed."))
  })
  socket.on("connect", () => {
    socket.write(encodeDesktopFrame({ version: desktopProtocolVersion, type: "hello", secret: registration.secret, client: "daw-control" }))
  })
  // The deadline starts before connection so an accepted but silent server cannot hang the CLI.
  const handshakeTimer = setTimeout(() => {
    const error = new Error("Desktop host handshake deadline exceeded.")
    rejectPending(error)
    socket.destroy(error)
  }, options.handshakeDeadlineMs ?? 5_000)
  await hello
  return {
    request: (operation: DesktopOperationV1, input: unknown, deadlineMs = 10_000): Promise<unknown> => {
      const id = randomBytes(16).toString("hex")
      return new Promise((resolve, reject) => {
        // A client deadline prevents a wedged renderer from retaining a CLI request.
        const timeout = setTimeout(() => {
          if (!pending.delete(id)) return
          socket.write(encodeDesktopFrame({ version: desktopProtocolVersion, type: "cancel", id }))
          reject(new Error("Desktop host request deadline exceeded."))
        }, deadlineMs)
        pending.set(id, { resolve, reject, timeout })
        socket.write(encodeDesktopFrame({ version: desktopProtocolVersion, type: "request", id, operation, input, deadlineMs }))
      })
    },
    close: () => {
      rejectPending(new Error("Desktop host connection closed."))
      socket.destroy()
    },
  }
}
