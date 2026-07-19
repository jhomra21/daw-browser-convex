import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  desktopFrameSchemaV1,
  desktopProtocolVersion,
  maxDesktopReplyBytes,
  maxDesktopReplyFrameBytes,
  type DesktopFrameV1,
  type DesktopOperationV1,
} from "@daw-browser/desktop-protocol"
import type { ControlErrorV1 } from "@daw-browser/control"
import { createDesktopFrameDecoder, encodeDesktopFrame } from "@daw-browser/desktop-protocol/socket"
import { createHostClient, DesktopControlError, registrationFile } from "./host"

const originalActorPath = process.env.DAW_CONTROL_ACTOR_PATH
const originalAuthPath = process.env.DAW_CONTROL_AUTH_PATH
const directories: string[] = []
const servers: ReturnType<typeof createServer>[] = []
const sockets = new Set<Socket>()

const hostStatus = {
  project: { id: "project-1", kind: "local" },
  ready: true,
  transport: "stopped",
  capabilities: { playback: true, diagnostics: true },
}

const temporaryDirectory = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "daw-host-client-"))
  directories.push(directory)
  return directory
}

const writeRawFrame = (socket: Socket, value: unknown) => {
  const payload = Buffer.from(JSON.stringify(value))
  const frame = Buffer.alloc(payload.byteLength + 4)
  frame.writeUInt32BE(payload.byteLength)
  payload.copy(frame, 4)
  socket.write(frame)
}

const writePaddedRawFrame = (socket: Socket, value: unknown, payloadByteLength: number) => {
  const json = Buffer.from(JSON.stringify(value))
  const payload = Buffer.alloc(payloadByteLength, 0x20)
  json.copy(payload)
  const frame = Buffer.alloc(payload.byteLength + 4)
  frame.writeUInt32BE(payload.byteLength)
  payload.copy(frame, 4)
  socket.write(frame)
}

const writeFrame = (socket: Socket, value: unknown) => {
  socket.write(encodeDesktopFrame(desktopFrameSchemaV1.parse(value)))
}

const acknowledge = (socket: Socket, capabilities: DesktopOperationV1[]) => {
  writeFrame(socket, {
    version: desktopProtocolVersion,
    type: "helloAck",
    sessionId: "session-identifier",
    capabilities,
  })
}

const waitForClose = (socket: Socket) => (
  socket.destroyed
    ? Promise.resolve()
    : new Promise<void>((resolve) => socket.once("close", () => resolve()))
)

type HostFixture = {
  paths: {
    platform: "linux"
    homeDirectory: string
    userDataDirectory: string
    actorPath: string
  }
}

const createHostFixture = async (
  onFrame: (socket: Socket, frame: DesktopFrameV1) => void,
): Promise<HostFixture> => {
  const userDataDirectory = await temporaryDirectory()
  const hostDirectory = path.join(userDataDirectory, "host")
  const socketPath = path.join(hostDirectory, "host.sock")
  await mkdir(hostDirectory, { recursive: true, mode: 0o700 })
  await chmod(hostDirectory, 0o700)
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    const decoder = createDesktopFrameDecoder((frame) => onFrame(socket, frame))
    socket.on("data", decoder)
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socketPath, resolve))
  const registration = path.join(hostDirectory, "registration-v1.json")
  await writeFile(registration, JSON.stringify({
    version: "v1",
    instanceId: "a".repeat(32),
    pid: process.pid,
    createdAt: Date.now(),
    address: socketPath,
    secret: "b".repeat(64),
  }), { mode: 0o600 })
  await chmod(registration, 0o600)
  return {
    paths: {
      platform: "linux",
      homeDirectory: userDataDirectory,
      userDataDirectory,
      actorPath: path.join(userDataDirectory, "identity", "host-actor-v1.json"),
    },
  }
}

const replyChunks = (
  operation: DesktopOperationV1,
  id: string,
  reply: unknown,
) => {
  const bytes = Buffer.from(JSON.stringify(reply))
  const split = Math.ceil(bytes.byteLength / 2)
  const parts = [bytes.subarray(0, split), bytes.subarray(split)]
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  return parts.map((part, index) => ({
    version: desktopProtocolVersion,
    type: "replyChunk",
    id,
    operation,
    index,
    total: parts.length,
    byteLength: bytes.byteLength,
    sha256,
    payload: part.toString("base64"),
  }))
}

beforeEach(async () => {
  const directory = await temporaryDirectory()
  process.env.DAW_CONTROL_AUTH_PATH = path.join(directory, "credentials", "control-auth.json")
})

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
  if (originalActorPath === undefined) delete process.env.DAW_CONTROL_ACTOR_PATH
  else process.env.DAW_CONTROL_ACTOR_PATH = originalActorPath
  if (originalAuthPath === undefined) delete process.env.DAW_CONTROL_AUTH_PATH
  else process.env.DAW_CONTROL_AUTH_PATH = originalAuthPath
})

describe("desktop host registration paths", () => {
  test("uses Electron-compatible platform application data directories", () => {
    expect(registrationFile({
      platform: "win32",
      homeDirectory: "C:\\Users\\Daw",
      appDataDirectory: "C:\\Users\\Daw\\AppData\\Roaming",
    })).toBe("C:\\Users\\Daw\\AppData\\Roaming/daw-browser/host/registration-v1.json")
    expect(registrationFile({
      platform: "darwin",
      homeDirectory: "/Users/daw",
    })).toBe("/Users/daw/Library/Application Support/daw-browser/host/registration-v1.json")
    expect(registrationFile({
      platform: "linux",
      homeDirectory: "/home/daw",
      xdgConfigDirectory: "/config",
    })).toBe("/config/daw-browser/host/registration-v1.json")
  })
})

describe("desktop host client", () => {
  test("rejects and closes an accepted but silent host before the handshake deadline", async () => {
    const fixture = await createHostFixture(() => undefined)
    await expect(createHostClient({
      paths: fixture.paths,
      handshakeDeadlineMs: 20,
    })).rejects.toThrow("Desktop host handshake deadline exceeded.")
  })

  test("persists the hello actor ID beside credentials and reuses it on reconnect", async () => {
    const actorIds: string[] = []
    const fixture = await createHostFixture((socket, frame) => {
      if (frame.type !== "hello") return
      actorIds.push(frame.actorId)
      acknowledge(socket, ["host.status"])
    })

    const first = await createHostClient({ paths: fixture.paths })
    first.close()
    const second = await createHostClient({ paths: fixture.paths })
    second.close()

    expect(actorIds).toHaveLength(2)
    expect(actorIds[0]).toBe(actorIds[1])
    expect(JSON.parse(await readFile(
      fixture.paths.actorPath,
      "utf8",
    ))).toEqual({ version: "v1", actorId: actorIds[0] })
  })

  test("uses the explicitly configured actor identity", async () => {
    const actorId = "9d8ab7cb-6203-4a25-84d5-b7a58436b7f4"
    const received = Promise.withResolvers<string>()
    const fixture = await createHostFixture((socket, frame) => {
      if (frame.type !== "hello") return
      received.resolve(frame.actorId)
      acknowledge(socket, [])
    })
    const actorPath = fixture.paths.actorPath
    await mkdir(path.dirname(actorPath), { recursive: true, mode: 0o700 })
    await chmod(path.dirname(actorPath), 0o700)
    await writeFile(actorPath, JSON.stringify({ version: "v1", actorId }), { mode: 0o600 })
    await chmod(actorPath, 0o600)
    const client = await createHostClient({ paths: fixture.paths })
    expect(await received.promise).toBe(actorId)
    client.close()
  })

  test("round trips a regular host status reply", async () => {
    const fixture = await createHostFixture((socket, frame) => {
      if (frame.type === "hello") acknowledge(socket, ["host.status"])
      if (frame.type === "request") {
        writeFrame(socket, {
          version: "v1",
          type: "reply",
          id: frame.id,
          result: hostStatus,
        })
      }
    })
    const client = await createHostClient({ paths: fixture.paths })
    expect(await client.request("host.status", {})).toEqual(hostStatus)
    client.close()
  })

  test("rejects a normal reply whose wire JSON exceeds the reply frame limit", async () => {
    const connectionClosed = Promise.withResolvers<void>()
    const fixture = await createHostFixture((socket, frame) => {
      socket.once("close", () => connectionClosed.resolve())
      if (frame.type === "hello") acknowledge(socket, ["host.status"])
      if (frame.type !== "request") return
      writePaddedRawFrame(socket, {
        version: "v1",
        type: "reply",
        id: frame.id,
        result: hostStatus,
      }, maxDesktopReplyFrameBytes + 1)
    })
    const client = await createHostClient({ paths: fixture.paths })
    await expect(client.request("host.status", {})).rejects.toThrow("frame size limit")
    await connectionClosed.promise
  })

  test("returns non-control host errors as ordinary errors", async () => {
    const fixture = await createHostFixture((socket, frame) => {
      if (frame.type === "hello") acknowledge(socket, ["host.status"])
      if (frame.type === "request") {
        writeFrame(socket, {
          version: "v1",
          type: "reply",
          id: frame.id,
          error: { version: "v1", code: "unavailable", message: "Host unavailable." },
        })
      }
    })
    const client = await createHostClient({ paths: fixture.paths })
    const error = await client.request("host.status", {}).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(DesktopControlError)
    expect(error).toHaveProperty("message", "Host unavailable.")
    client.close()
  })

  test("preserves all valid control error fields in DesktopControlError", async () => {
    const errors = [
      { version: "v1", code: "forbidden", message: "Denied." },
      {
        version: "v1",
        code: "validation",
        message: "Invalid action.",
        actionIndex: 3,
        details: { name: "Required." },
      },
    ] satisfies ControlErrorV1[]
    let nextError = 0
    const fixture = await createHostFixture((socket, frame) => {
      if (frame.type === "hello") acknowledge(socket, ["control.capabilities"])
      if (frame.type === "request") {
        writeFrame(socket, {
          version: "v1",
          type: "reply",
          id: frame.id,
          error: errors[nextError],
        })
        nextError += 1
      }
    })
    const client = await createHostClient({ paths: fixture.paths })
    for (const expected of errors) {
      const error = await client.request("control.capabilities", {}).catch((failure: unknown) => failure)
      expect(error).toBeInstanceOf(DesktopControlError)
      if (!(error instanceof DesktopControlError)) throw new Error("Expected DesktopControlError.")
      expect(error.data).toEqual(expected)
    }
    client.close()
  })

  test("reassembles a valid chunked host result", async () => {
    const fixture = await createHostFixture((socket, frame) => {
      if (frame.type === "hello") acknowledge(socket, ["host.status"])
      if (frame.type !== "request") return
      const chunks = replyChunks("host.status", frame.id, {
        version: "v1",
        type: "reply",
        id: frame.id,
        result: hostStatus,
      })
      for (const chunk of chunks) writeFrame(socket, chunk)
    })
    const client = await createHostClient({ paths: fixture.paths })
    expect(await client.request("host.status", {})).toEqual(hostStatus)
    client.close()
  })

  test("rejects a normal reply after a partial chunk and closes the connection", async () => {
    const connectionClosed = Promise.withResolvers<void>()
    const fixture = await createHostFixture((socket, frame) => {
      if (frame.type === "hello") acknowledge(socket, ["host.status"])
      if (frame.type !== "request") return
      const chunks = replyChunks("host.status", frame.id, {
        version: "v1",
        type: "reply",
        id: frame.id,
        result: hostStatus,
      })
      void waitForClose(socket).then(connectionClosed.resolve)
      writeFrame(socket, chunks[0])
      writeFrame(socket, { version: "v1", type: "reply", id: frame.id, result: hostStatus })
    })
    const client = await createHostClient({ paths: fixture.paths })
    await expect(client.request("host.status", {})).rejects.toThrow("Mixed desktop reply framing.")
    await connectionClosed.promise
  })

  test("rejects a duplicate terminal reply and closes the connection", async () => {
    const connectionClosed = Promise.withResolvers<void>()
    const fixture = await createHostFixture((socket, frame) => {
      if (frame.type === "hello") acknowledge(socket, ["host.status"])
      if (frame.type !== "request") return
      void waitForClose(socket).then(connectionClosed.resolve)
      const reply = { version: "v1", type: "reply", id: frame.id, result: hostStatus }
      writeFrame(socket, reply)
      writeFrame(socket, reply)
    })
    const client = await createHostClient({ paths: fixture.paths })
    expect(await client.request("host.status", {})).toEqual(hostStatus)
    await connectionClosed.promise
    await expect(client.request("host.status", {})).rejects.toThrow("Desktop host connection closed.")
  })

  for (const scenario of [
    {
      name: "empty payload",
      mutate: (chunks: ReturnType<typeof replyChunks>) => ({ ...chunks[0], payload: "" }),
    },
    {
      name: "out-of-order index",
      mutate: (chunks: ReturnType<typeof replyChunks>) => chunks[1],
    },
    {
      name: "oversized aggregate",
      mutate: (chunks: ReturnType<typeof replyChunks>) => ({
        ...chunks[0],
        total: 1,
        byteLength: maxDesktopReplyBytes + 1,
      }),
    },
    {
      name: "invalid hash",
      mutate: (chunks: ReturnType<typeof replyChunks>) => ({
        ...chunks[0],
        total: 1,
        byteLength: Buffer.from(chunks[0]?.payload ?? "", "base64").byteLength,
        sha256: "0".repeat(64),
      }),
    },
  ]) {
    test(`rejects and closes for a ${scenario.name} reply chunk`, async () => {
      const connectionClosed = Promise.withResolvers<void>()
      const fixture = await createHostFixture((socket, frame) => {
        if (frame.type === "hello") acknowledge(socket, ["host.status"])
        if (frame.type !== "request") return
        const chunks = replyChunks("host.status", frame.id, {
          version: "v1",
          type: "reply",
          id: frame.id,
          result: hostStatus,
        })
        void waitForClose(socket).then(connectionClosed.resolve)
        writeRawFrame(socket, scenario.mutate(chunks))
      })
      const client = await createHostClient({ paths: fixture.paths })
      await expect(client.request("host.status", {})).rejects.toBeInstanceOf(Error)
      await connectionClosed.promise
    })
  }

  test("rejects duplicate hello acknowledgements even with empty capabilities", async () => {
    const fixture = await createHostFixture((socket, frame) => {
      if (frame.type !== "hello") return
      const acknowledgement = desktopFrameSchemaV1.parse({
        version: "v1",
        type: "helloAck",
        sessionId: "session-identifier",
        capabilities: [],
      })
      socket.write(Buffer.concat([
        Buffer.from(encodeDesktopFrame(acknowledgement)),
        Buffer.from(encodeDesktopFrame(acknowledgement)),
      ]))
    })
    await expect(createHostClient({ paths: fixture.paths })).rejects.toThrow("Desktop host connection closed.")
  })

  test("rejects a non-acknowledgement frame before hello completes", async () => {
    const fixture = await createHostFixture((socket, frame) => {
      if (frame.type !== "hello") return
      writeFrame(socket, { version: "v1", type: "lifecycle", event: "closing" })
    })
    await expect(createHostClient({ paths: fixture.paths })).rejects.toThrow(
      "Desktop host sent a frame before the handshake acknowledgement.",
    )
  })

  test("rejects a malformed hello acknowledgement", async () => {
    const fixture = await createHostFixture((socket, frame) => {
      if (frame.type !== "hello") return
      writeRawFrame(socket, {
        version: "v1",
        type: "helloAck",
        sessionId: "",
        capabilities: ["host.status"],
      })
    })
    await expect(createHostClient({ paths: fixture.paths })).rejects.toBeInstanceOf(Error)
  })

  for (const scenario of [
    {
      name: "host result",
      operation: "host.status",
      value: { version: "v1", type: "reply", result: { ready: true } },
    },
    {
      name: "host error",
      operation: "host.status",
      value: {
        version: "v1",
        type: "reply",
        error: { version: "v1", code: "validation", message: "Wrong error domain." },
      },
    },
  ] satisfies Array<{
    name: string
    operation: DesktopOperationV1
    value: { version: string; type: string; result?: unknown; error?: unknown }
  }>) {
    test(`rejects and closes for a malformed operation-specific ${scenario.name}`, async () => {
      const connectionClosed = Promise.withResolvers<void>()
      const fixture = await createHostFixture((socket, frame) => {
        if (frame.type === "hello") acknowledge(socket, [scenario.operation])
        if (frame.type !== "request") return
        void waitForClose(socket).then(connectionClosed.resolve)
        writeFrame(socket, { ...scenario.value, id: frame.id })
      })
      const client = await createHostClient({ paths: fixture.paths })
      await expect(client.request(scenario.operation, {})).rejects.toBeInstanceOf(Error)
      await connectionClosed.promise
    })
  }

  test("sends one cancel on request timeout and closes for a late reply", async () => {
    const cancelReceived = Promise.withResolvers<void>()
    const connectionClosed = Promise.withResolvers<void>()
    let requestId = ""
    let cancelCount = 0
    const fixture = await createHostFixture((socket, frame) => {
      if (frame.type === "hello") acknowledge(socket, ["host.status"])
      if (frame.type === "request") {
        requestId = frame.id
        void waitForClose(socket).then(connectionClosed.resolve)
      }
      if (frame.type === "cancel") {
        cancelCount += 1
        cancelReceived.resolve()
        writeFrame(socket, { version: "v1", type: "reply", id: requestId, result: hostStatus })
      }
    })
    const client = await createHostClient({ paths: fixture.paths })
    await expect(client.request("host.status", {}, 20)).rejects.toThrow(
      "Desktop host request deadline exceeded.",
    )
    await cancelReceived.promise
    await connectionClosed.promise
    expect(cancelCount).toBe(1)
  })

  test("rejects a pending request when the socket closes", async () => {
    const fixture = await createHostFixture((socket, frame) => {
      if (frame.type === "hello") acknowledge(socket, ["host.status"])
      if (frame.type === "request") socket.end()
    })
    const client = await createHostClient({ paths: fixture.paths })
    await expect(client.request("host.status", {})).rejects.toThrow("Desktop host connection closed.")
  })

  test("rejects a pending request when the client closes", async () => {
    const requestReceived = Promise.withResolvers<void>()
    const fixture = await createHostFixture((socket, frame) => {
      if (frame.type === "hello") acknowledge(socket, ["host.status"])
      if (frame.type === "request") requestReceived.resolve()
    })
    const client = await createHostClient({ paths: fixture.paths })
    const request = client.request("host.status", {})
    await requestReceived.promise
    client.close()
    await expect(request).rejects.toThrow("Desktop host connection closed.")
  })
})
