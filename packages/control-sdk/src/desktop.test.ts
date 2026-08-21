import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { createCanonicalControlClient } from "@daw-browser/control-sdk"
import { connectDesktopControl } from "@daw-browser/control-sdk/desktop"
import {
  canonicalLocalControlCapabilities,
  localControlCapabilitiesV1,
  localControlCapabilitiesV2,
} from "@daw-browser/control"
import { desktopProtocolVersion, desktopProtocolVersionV2 } from "@daw-browser/desktop-protocol"
import { createDesktopFrameDecoder, encodeDesktopFrame } from "@daw-browser/desktop-protocol/socket"

const directories: string[] = []
const servers: ReturnType<typeof createServer>[] = []
const sockets = new Set<Socket>()
const secret = "b".repeat(64)

const status = {
  project: { id: "project-1", kind: "local" },
  ready: true,
  transport: "stopped",
  capabilities: { playback: true, diagnostics: true },
}

const temporaryDirectory = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "daw-control-sdk-"))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close(() => resolve())
  })))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  delete process.env.DAW_CONTROL_AUTH_PATH
  delete process.env.DAW_DESKTOP_USER_DATA
})

const createHost = async (version: "v1" | "v2" = "v2", respond = true) => {
  const directory = await temporaryDirectory()
  const hostDirectory = path.join(directory, "host")
  await mkdir(hostDirectory, { recursive: true, mode: 0o700 })
  await chmod(hostDirectory, 0o700)
  const socketPath = path.join(hostDirectory, "host.sock")
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    const decode = createDesktopFrameDecoder((frame) => {
      if (frame.type === "hello") {
        if (!respond) return
        socket.write(encodeDesktopFrame(version === "v2"
          ? {
              version: desktopProtocolVersionV2,
              type: "helloAck",
              selectedVersion: desktopProtocolVersionV2,
              sessionId: "session-identifier",
              capabilities: ["host.status", "control.capabilities", "control.snapshot"],
            }
          : {
              version: desktopProtocolVersion,
              type: "helloAck",
              sessionId: "session-identifier",
              capabilities: ["host.status", "control.capabilities", "control.snapshot"],
            }))
        return
      }
      if (frame.type !== "request") return
      const result = frame.operation === "host.status"
        ? status
        : version === "v2"
          ? localControlCapabilitiesV2
          : localControlCapabilitiesV1
      socket.write(encodeDesktopFrame({
        version,
        type: "reply",
        id: frame.id,
        result,
      }))
    })
    socket.on("data", decode)
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socketPath, resolve))
  await writeFile(path.join(hostDirectory, "registration-v1.json"), JSON.stringify({
    version: "v1",
    instanceId: "a".repeat(32),
    pid: process.pid,
    createdAt: Date.now(),
    address: socketPath,
    secret,
  }), { mode: 0o600 })
  await chmod(path.join(hostDirectory, "registration-v1.json"), 0o600)
  process.env.DAW_DESKTOP_USER_DATA = directory
  process.env.DAW_CONTROL_AUTH_PATH = path.join(directory, "credentials", "control-auth.json")
  return directory
}

describe("public desktop control SDK", () => {
  test("connects through public imports and maps canonical desktop methods", async () => {
    await createHost()
    const connection = await connectDesktopControl()
    const client = createCanonicalControlClient(connection.invoker)

    await expect(client.projects.list({})).resolves.toEqual({ projects: [{ projectId: "project-1" }] })
    await expect(client.control.capabilities({})).resolves.toEqual(localControlCapabilitiesV2)

    connection.close()
    connection.close()
  })

  test("validates deadlines and client names before opening a connection", async () => {
    await expect(connectDesktopControl({ requestDeadlineMs: 0 })).rejects.toThrow("requestDeadlineMs")
    await expect(connectDesktopControl({ handshakeDeadlineMs: 60_001 })).rejects.toThrow("handshakeDeadlineMs")
    await expect(connectDesktopControl({ clientName: "x".repeat(129) })).rejects.toThrow("clientName")
  })

  test("does not disclose the registration secret in setup errors", async () => {
    await createHost("v2", false)
    const error = await connectDesktopControl({ handshakeDeadlineMs: 20 }).catch((cause) => cause)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toHaveProperty("message", expect.stringContaining(secret))
  })

  test("projects V1 desktop reads into the canonical client", async () => {
    await createHost("v1")
    const connection = await connectDesktopControl()
    const client = createCanonicalControlClient(connection.invoker)

    await expect(client.projects.current({})).resolves.toEqual({
      status: "present",
      project: { projectId: "project-1" },
    })
    await expect(client.control.capabilities({})).resolves.toEqual(canonicalLocalControlCapabilities)

    connection.close()
  })

  test("uses an explicit profile instead of the environment profile", async () => {
    const profile = await createHost()
    const environmentProfile = await temporaryDirectory()
    const actorProfile = await temporaryDirectory()
    process.env.DAW_DESKTOP_USER_DATA = environmentProfile

    const connection = await connectDesktopControl({
      userDataDirectory: profile,
      actorPath: path.join(actorProfile, "sdk-actor.json"),
    })
    const client = createCanonicalControlClient(connection.invoker)

    await expect(client.projects.list({})).resolves.toEqual({ projects: [{ projectId: "project-1" }] })

    connection.close()
  })
})
