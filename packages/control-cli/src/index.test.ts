import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createServer, type Socket } from "node:net"
import {
  desktopFrameSchemaV1,
  desktopProtocolVersion,
  type DesktopFrameV1,
  type DesktopOperationV1,
} from "@daw-browser/desktop-protocol"
import {
  canonicalJson,
  controlApprovalResultSchemaV1,
  controlCommitResultSchemaV1,
  controlHistoryResultSchemaV1,
  controlPreviewResultSchemaV1,
  controlRecoveriesResultSchemaV1,
  localControlCapabilitiesV1,
  projectSnapshotSchemaV1,
  type ControlErrorV1,
} from "@daw-browser/control"
import { createDesktopFrameDecoder, encodeDesktopFrame } from "@daw-browser/desktop-protocol/socket"
import { createCredentialStore, type ControlCredentials } from "./credentials"
import { runCli } from "./index"

const directories: string[] = []
const servers: ReturnType<typeof createServer>[] = []
const previousCredentialPath = process.env.DAW_CONTROL_AUTH_PATH
const previousUserDataPath = process.env.DAW_DESKTOP_USER_DATA
const previousFetch = globalThis.fetch

const credentials: ControlCredentials = {
  version: "v1",
  baseUrl: "https://control.example",
  clientId: "client-1",
  accessToken: "very-secret-access-token",
  refreshToken: "very-secret-refresh-token",
  expiresAt: 9_999_999_999_999,
  scopes: ["control:read", "control:write", "offline_access"],
  resource: "https://control.example/api",
  tokenEndpoint: "https://control.example/api/auth/oauth2/token",
  revocationEndpoint: "https://control.example/api/auth/oauth2/revoke",
}

afterEach(async () => {
  if (previousCredentialPath === undefined) delete process.env.DAW_CONTROL_AUTH_PATH
  else process.env.DAW_CONTROL_AUTH_PATH = previousCredentialPath
  if (previousUserDataPath === undefined) delete process.env.DAW_DESKTOP_USER_DATA
  else process.env.DAW_DESKTOP_USER_DATA = previousUserDataPath
  globalThis.fetch = previousFetch
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const allControlOperations = [
  "control.capabilities",
  "control.snapshot",
  "control.preview",
  "control.commit",
  "control.requestApproval",
  "control.history",
  "control.recoveries",
] satisfies DesktopOperationV1[]

const snapshot = projectSnapshotSchemaV1.parse({
  version: "v1",
  project: {
    id: "project-1",
    name: "Project",
    revision: 0,
    tempoBpm: 120,
    timeSignature: { numerator: 4, denominator: 4 },
    loop: { enabled: false, startSec: 0, endSec: 0 },
    masterVolume: 1,
    updatedAt: 0,
  },
  tracks: [],
  clips: [],
  processors: [],
  automation: [],
  sidechains: [],
  assets: [],
  assetFolders: [],
})

const planningResult = controlPreviewResultSchemaV1.parse({
  version: "v1",
  projectId: "project-1",
  priorRevision: 0,
  revision: 0,
  applied: false,
  requestDigest: "0".repeat(64),
  resolvedRefs: [],
  warnings: [],
  changeSummary: { actionCount: 0, changes: [] },
})

const controlResults = {
  "control.capabilities": localControlCapabilitiesV1,
  "control.snapshot": snapshot,
  "control.preview": planningResult,
  "control.commit": controlCommitResultSchemaV1.parse({
    ...planningResult,
    idempotencyReplay: false,
    recoveries: [],
    restored: [],
  }),
  "control.requestApproval": controlApprovalResultSchemaV1.parse({
    version: "v1",
    approvalToken: "a".repeat(32),
    requestDigest: "0".repeat(64),
    baseRevision: 0,
    actionIndexes: [0],
    expiresAt: 0,
  }),
  "control.history": controlHistoryResultSchemaV1.parse({
    entries: [],
    continueCursor: "end",
    isDone: true,
  }),
  "control.recoveries": controlRecoveriesResultSchemaV1.parse({
    entries: [],
    continueCursor: "end",
    isDone: true,
  }),
}

const controlResultFor = (operation: DesktopOperationV1) => {
  if (operation === "control.capabilities") return controlResults[operation]
  if (operation === "control.snapshot") return controlResults[operation]
  if (operation === "control.preview") return controlResults[operation]
  if (operation === "control.commit") return controlResults[operation]
  if (operation === "control.requestApproval") return controlResults[operation]
  if (operation === "control.history") return controlResults[operation]
  if (operation === "control.recoveries") return controlResults[operation]
  throw new Error("Unexpected host operation.")
}

const createHost = async (
  onRequest: (socket: Socket, frame: Extract<DesktopFrameV1, { type: "request" }>) => void,
  capabilities: DesktopOperationV1[] = allControlOperations,
) => {
  const directory = await mkdtemp("/tmp/daw-control-cli-")
  directories.push(directory)
  const hostDirectory = join(directory, "host")
  const socketPath = join(hostDirectory, "control.sock")
  await mkdir(hostDirectory, { recursive: true, mode: 0o700 })
  await chmod(hostDirectory, 0o700)
  const server = createServer((socket) => {
    const decoder = createDesktopFrameDecoder((frame) => {
      if (frame.version !== "v1") {
        socket.destroy()
        return
      }
      if (frame.type === "hello") {
        socket.write(encodeDesktopFrame(desktopFrameSchemaV1.parse({
          version: desktopProtocolVersion,
          type: "helloAck",
          sessionId: "session-identifier",
          capabilities,
        })))
      } else if (frame.type === "request") {
        onRequest(socket, frame)
      }
    })
    socket.on("data", decoder)
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socketPath, resolve))
  await writeFile(join(hostDirectory, "registration-v1.json"), JSON.stringify({
    version: desktopProtocolVersion,
    instanceId: "a".repeat(32),
    pid: process.pid,
    createdAt: Date.now(),
    address: socketPath,
    secret: "b".repeat(64),
  }), { mode: 0o600 })
  await chmod(join(hostDirectory, "registration-v1.json"), 0o600)
  process.env.DAW_DESKTOP_USER_DATA = directory
}

const io = () => {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    value: {
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
      readStdin: async () => "",
    },
  }
}

describe("control CLI output", () => {
  test("status emits one redacted JSON envelope", async () => {
    const directory = await mkdtemp("/tmp/daw-control-cli-")
    directories.push(directory)
    process.env.DAW_CONTROL_AUTH_PATH = join(directory, "credentials.json")
    await createCredentialStore().write(credentials)
    const stdout: string[] = []
    const stderr: string[] = []
    const exitCode = await runCli(["auth", "status"], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      readStdin: async () => "",
    })
    expect(exitCode).toBe(0)
    expect(stdout).toHaveLength(1)
    expect(stderr).toEqual([])
    expect(stdout[0]).not.toContain("very-secret")
    expect(JSON.parse(stdout[0])).toEqual({
      version: "v1",
      ok: true,
      command: "auth status",
      data: {
        authenticated: true,
        baseUrl: "https://control.example",
        expiresAt: credentials.expiresAt,
        scopes: credentials.scopes,
      },
    })
  })

  test("command failures only emit a structured stderr envelope", async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const exitCode = await runCli(["snapshot"], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      readStdin: async () => "",
    })
    expect(exitCode).toBe(1)
    expect(stdout).toEqual([])
    expect(stderr).toHaveLength(1)
    expect(JSON.parse(stderr[0])).toMatchObject({
      version: "v1",
      ok: false,
      command: "snapshot",
      error: { version: "v1", code: "invalid-request" },
    })
  })

  test("rejects unconsumed auth arguments before login, status, or logout side effects", async () => {
    const attempts = [
      ["auth", "login", "--unknown", "https://control.example"],
      ["auth", "login", "--base-url", "https://control.example", "extra"],
      ["auth", "status", "--verbose"],
      ["auth", "logout", "extra"],
    ]
    for (const arguments_ of attempts) {
      const stdout: string[] = []
      const stderr: string[] = []
      const exitCode = await runCli(arguments_, {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
        readStdin: async () => "",
      })
      expect(exitCode).toBe(1)
      expect(stdout).toEqual([])
      expect(stderr).toHaveLength(1)
      expect(JSON.parse(stderr[0]).error.code).toBe("invalid-request")
    }
  })

  test("rejects invalid host payloads before host discovery", async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const exitCode = await runCli(["host", "seek", "86401"], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      readStdin: async () => "",
    })
    expect(exitCode).toBe(1)
    expect(stdout).toEqual([])
    expect(JSON.parse(stderr[0]).error.message).toBe("Invalid host command.")
  })

  test("dispatches host transport-status with the canonical protocol input and output", async () => {
    const observed: Array<{ operation: DesktopOperationV1; input: unknown }> = []
    await createHost((socket, frame) => {
      observed.push({ operation: frame.operation, input: frame.input })
      socket.write(encodeDesktopFrame(desktopFrameSchemaV1.parse({
        version: "v1",
        type: "reply",
        id: frame.id,
        result: { state: "paused", playheadSec: 12.5 },
      })))
    }, ["transport.status"])
    const output = io()
    expect(await runCli(["host", "transport-status"], output.value)).toBe(0)
    expect(observed).toEqual([{ operation: "transport.status", input: {} }])
    expect(JSON.parse(output.stdout[0])).toEqual({
      version: "v1",
      ok: true,
      command: "host transport-status",
      data: { state: "paused", playheadSec: 12.5 },
    })
    expect(output.stderr).toEqual([])
  })

  test("preserves host transport failures as transport errors", async () => {
    await createHost((socket, frame) => {
      socket.write(encodeDesktopFrame(desktopFrameSchemaV1.parse({
        version: "v1",
        type: "reply",
        id: frame.id,
        error: { version: "v1", code: "unavailable", message: "Host unavailable." },
      })))
    }, ["host.status"])
    const output = io()
    expect(await runCli(["host", "status"], output.value)).toBe(1)
    expect(JSON.parse(output.stderr[0])).toEqual({
      version: "v1",
      ok: false,
      command: "host",
      error: { version: "v1", code: "unavailable", message: "Host unavailable." },
    })
  })
})

describe("canonical CLI target routing", () => {
  test("lists cloud projects and discovers host list/current", async () => {
    const directory = await mkdtemp("/tmp/daw-control-cli-")
    directories.push(directory)
    process.env.DAW_CONTROL_AUTH_PATH = join(directory, "credentials.json")
    await createCredentialStore().write(credentials)
    const cloudRequests: string[] = []
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        cloudRequests.push(url.pathname)
        return Response.json({ projects: [{ projectId: "cloud-project", name: "Cloud" }] })
      },
      { preconnect: previousFetch.preconnect },
    )
    const cloudOutput = io()
    expect(await runCli(["project", "list"], cloudOutput.value)).toBe(0)
    expect(JSON.parse(cloudOutput.stdout[0]).data).toEqual({
      projects: [{ projectId: "cloud-project", name: "Cloud" }],
    })

    await createHost((socket, frame) => {
      const result = frame.operation === "host.status"
        ? { project: { id: "host-project", kind: "local" }, ready: true, transport: "stopped", capabilities: { playback: true, diagnostics: true } }
        : controlResultFor(frame.operation)
      socket.write(encodeDesktopFrame(desktopFrameSchemaV1.parse({
        version: "v1",
        type: "reply",
        id: frame.id,
        result,
      })))
    }, ["host.status", "control.capabilities", "control.snapshot"])
    const hostListOutput = io()
    const hostCurrentOutput = io()
    expect(await runCli(["project", "list", "--target", "host"], hostListOutput.value)).toBe(0)
    expect(await runCli(["project", "current", "--target", "host"], hostCurrentOutput.value)).toBe(0)
    expect(JSON.parse(hostListOutput.stdout[0]).data).toEqual({
      projects: [{ projectId: "host-project" }],
    })
    expect(JSON.parse(hostCurrentOutput.stdout[0]).data).toEqual({
      status: "present",
      project: { projectId: "host-project" },
    })
    expect(cloudRequests).toEqual(["/api/control/v1/projects"])
    expect(hostListOutput.stderr).toEqual([])
    expect(hostCurrentOutput.stderr).toEqual([])
  })

  test("advertises targets only for canonical control commands", async () => {
    const output = io()
    expect(await runCli(["--help"], output.value)).toBe(0)
    expect(output.stdout[0]).toContain("capabilities [--target <cloud|host>]")
    expect(output.stdout[0]).toContain("recoveries <project-id> [--cursor <cursor>] [--limit <number>] [--target <cloud|host>]")
    expect(output.stdout[0]).not.toContain("host play [--target")
  })

  test("maps every canonical command identically for cloud and host", async () => {
    const observed: Array<{ operation: DesktopOperationV1; input: unknown }> = []
    await createHost((socket, frame) => {
      observed.push({ operation: frame.operation, input: frame.input })
      socket.write(encodeDesktopFrame(desktopFrameSchemaV1.parse({
        version: "v1",
        type: "reply",
        id: frame.id,
        result: controlResultFor(frame.operation),
      })))
    })
    const directory = directories[directories.length - 1]
    if (!directory) throw new Error("Missing test directory.")
    process.env.DAW_CONTROL_AUTH_PATH = join(directory, "credentials.json")
    await createCredentialStore().write(credentials)
    const requestPath = join(directory, "request.json")
    const action = { kind: "project.rename", name: "Renamed" }
    await writeFile(requestPath, JSON.stringify({ version: "v1", projectId: "project-1", actions: [action] }))
    const commitPath = join(directory, "commit.json")
    await writeFile(commitPath, JSON.stringify({ version: "v1", projectId: "project-1", actions: [action], idempotencyKey: "request-1" }))
    const cloudRequests: Array<{ url: string; method: string; body: string | undefined }> = []
    const cloudFetch: typeof globalThis.fetch = Object.assign(
      async (...arguments_: Parameters<typeof globalThis.fetch>) => {
        const [input, init] = arguments_
        const url = new URL(String(input))
        cloudRequests.push({
          url: `${url.pathname}${url.search}`,
          method: init?.method ?? "GET",
          body: init?.body === undefined ? undefined : String(init.body),
        })
        const operation = url.pathname.endsWith("/capabilities") ? "control.capabilities"
          : url.pathname.endsWith("/snapshot") ? "control.snapshot"
            : url.pathname.endsWith("/preview") ? "control.preview"
              : url.pathname.endsWith("/approvals") ? "control.requestApproval"
                : url.pathname.endsWith("/commit") ? "control.commit"
                  : url.pathname.endsWith("/history") ? "control.history"
                    : "control.recoveries"
        return Response.json(controlResultFor(operation))
      },
      { preconnect: previousFetch.preconnect },
    )
    globalThis.fetch = cloudFetch
    const commands = [
      { command: "capabilities", arguments_: [], operation: "control.capabilities" },
      { command: "snapshot", arguments_: ["project-1"], operation: "control.snapshot" },
      { command: "preview", arguments_: ["--request", requestPath], operation: "control.preview" },
      { command: "approval", arguments_: ["--request", requestPath], operation: "control.requestApproval" },
      { command: "commit", arguments_: ["--request", commitPath], operation: "control.commit" },
      { command: "history", arguments_: ["project-1", "--cursor", "cursor-1", "--limit", "2"], operation: "control.history" },
      { command: "recoveries", arguments_: ["project-1", "--cursor", "cursor-1", "--limit", "2"], operation: "control.recoveries" },
    ] satisfies Array<{ command: string; arguments_: string[]; operation: DesktopOperationV1 }>
    for (const command of commands) {
      const omitted = io()
      const explicit = io()
      const host = io()
      expect(await runCli([command.command, ...command.arguments_], omitted.value)).toBe(0)
      expect(await runCli([command.command, ...command.arguments_, "--target", "cloud"], explicit.value)).toBe(0)
      expect(await runCli([command.command, ...command.arguments_, "--target", "host"], host.value)).toBe(0)
      expect(JSON.parse(explicit.stdout[0])).toEqual(JSON.parse(omitted.stdout[0]))
      expect(JSON.parse(host.stdout[0])).toEqual(JSON.parse(omitted.stdout[0]))
      expect(JSON.parse(host.stdout[0])).toEqual({
        version: "v1",
        ok: true,
        command: command.command,
        data: controlResultFor(command.operation),
      })
    }
    expect(observed).toEqual([
      { operation: "control.capabilities", input: {} },
      { operation: "control.snapshot", input: { projectId: "project-1" } },
      { operation: "control.preview", input: { version: "v1", projectId: "project-1", actions: [action] } },
      { operation: "control.requestApproval", input: { version: "v1", projectId: "project-1", actions: [action] } },
      { operation: "control.commit", input: { version: "v1", projectId: "project-1", actions: [action], idempotencyKey: "request-1" } },
      { operation: "control.history", input: { projectId: "project-1", cursor: "cursor-1", limit: 2 } },
      { operation: "control.recoveries", input: { projectId: "project-1", cursor: "cursor-1", limit: 2 } },
    ])
    expect(cloudRequests).toEqual([
      { url: "/api/control/v1/capabilities", method: "GET", body: undefined },
      { url: "/api/control/v1/capabilities", method: "GET", body: undefined },
      { url: "/api/control/v1/projects/project-1/snapshot", method: "GET", body: undefined },
      { url: "/api/control/v1/projects/project-1/snapshot", method: "GET", body: undefined },
      { url: "/api/control/v1/projects/project-1/preview", method: "POST", body: canonicalJson({ version: "v1", projectId: "project-1", actions: [action] }) },
      { url: "/api/control/v1/projects/project-1/preview", method: "POST", body: canonicalJson({ version: "v1", projectId: "project-1", actions: [action] }) },
      { url: "/api/control/v1/projects/project-1/approvals", method: "POST", body: canonicalJson({ version: "v1", projectId: "project-1", actions: [action] }) },
      { url: "/api/control/v1/projects/project-1/approvals", method: "POST", body: canonicalJson({ version: "v1", projectId: "project-1", actions: [action] }) },
      { url: "/api/control/v1/projects/project-1/commit", method: "POST", body: canonicalJson({ version: "v1", projectId: "project-1", actions: [action], idempotencyKey: "request-1" }) },
      { url: "/api/control/v1/projects/project-1/commit", method: "POST", body: canonicalJson({ version: "v1", projectId: "project-1", actions: [action], idempotencyKey: "request-1" }) },
      { url: "/api/control/v1/projects/project-1/history?limit=2&cursor=cursor-1", method: "GET", body: undefined },
      { url: "/api/control/v1/projects/project-1/history?limit=2&cursor=cursor-1", method: "GET", body: undefined },
      { url: "/api/control/v1/projects/project-1/recoveries?limit=2&cursor=cursor-1", method: "GET", body: undefined },
      { url: "/api/control/v1/projects/project-1/recoveries?limit=2&cursor=cursor-1", method: "GET", body: undefined },
    ])
  })

  test("does not read malformed cloud credentials for host routing", async () => {
    const directory = await mkdtemp("/tmp/daw-control-cli-")
    directories.push(directory)
    process.env.DAW_CONTROL_AUTH_PATH = join(directory, "credentials.json")
    await writeFile(process.env.DAW_CONTROL_AUTH_PATH, "{ malformed")
    await createHost((socket, frame) => {
      socket.write(encodeDesktopFrame(desktopFrameSchemaV1.parse({
        version: "v1",
        type: "reply",
        id: frame.id,
        result: localControlCapabilitiesV1,
      })))
    }, ["control.capabilities"])
    const output = io()
    expect(await runCli(["capabilities", "--target", "host"], output.value)).toBe(0)
    expect(JSON.parse(output.stdout[0])).toMatchObject({ ok: true, command: "capabilities" })
  })

  test("defaults to cloud, and explicit cloud has the same credential behavior", async () => {
    const directory = await mkdtemp("/tmp/daw-control-cli-")
    directories.push(directory)
    process.env.DAW_CONTROL_AUTH_PATH = join(directory, "missing.json")
    let hostRequests = 0
    await createHost(() => { hostRequests += 1 })
    for (const command of [["capabilities"], ["capabilities", "--target", "cloud"]]) {
      const output = io()
      expect(await runCli(command, output.value)).toBe(1)
      expect(JSON.parse(output.stderr[0])).toMatchObject({
        error: { code: "invalid-request", message: "Run daw-control auth login first." },
      })
    }
    expect(hostRequests).toBe(0)
  })

  test("rejects invalid target options and strict request target fields before host dispatch", async () => {
    let requests = 0
    await createHost((socket, frame) => {
      requests += 1
      socket.write(encodeDesktopFrame(desktopFrameSchemaV1.parse({
        version: "v1",
        type: "reply",
        id: frame.id,
        result: localControlCapabilitiesV1,
      })))
    })
    const directory = directories[directories.length - 1]
    if (!directory) throw new Error("Missing test directory.")
    const requestPath = join(directory, "invalid-request.json")
    await writeFile(requestPath, JSON.stringify({
      version: "v1",
      projectId: "project-1",
      actions: [{ kind: "project.rename", name: "Renamed" }],
      target: "host",
    }))
    for (const command of [
      ["capabilities", "--target"],
      ["capabilities", "--target", "invalid"],
      ["capabilities", "--target", "host", "--target", "cloud"],
      ["preview", "--target", "host", "--request", requestPath],
    ]) {
      const output = io()
      expect(await runCli(command, output.value)).toBe(1)
      expect(JSON.parse(output.stderr[0]).error.code).toBe("invalid-request")
    }
    expect(requests).toBe(0)
  })

  test("rejects inherited object command names deterministically", async () => {
    for (const command of ["toString", "constructor", "__proto__"]) {
      const output = io()
      expect(await runCli([command], output.value)).toBe(1)
      expect(JSON.parse(output.stderr[0])).toEqual({
        version: "v1",
        ok: false,
        command,
        error: { version: "v1", code: "invalid-request", message: "Unknown command." },
      })
    }
  })

  test("preserves desktop control errors and hides unavailable host paths", async () => {
    const controlError: ControlErrorV1 = {
      version: "v1",
      code: "validation",
      message: "Invalid action.",
      actionIndex: 3,
      details: { action: "unsupported" },
    }
    await createHost((socket, frame) => {
      socket.write(encodeDesktopFrame(desktopFrameSchemaV1.parse({
        version: "v1",
        type: "reply",
        id: frame.id,
        error: controlError,
      })))
    }, ["control.snapshot"])
    const hostError = io()
    expect(await runCli(["snapshot", "project-1", "--target", "host"], hostError.value)).toBe(1)
    expect(JSON.parse(hostError.stderr[0]).error).toEqual(controlError)

    delete process.env.DAW_DESKTOP_USER_DATA
    process.env.DAW_CONTROL_AUTH_PATH = "/not/a/credential/path"
    const unavailable = io()
    expect(await runCli(["capabilities", "--target", "host"], unavailable.value)).toBe(1)
    expect(JSON.parse(unavailable.stderr[0])).toMatchObject({
      error: { code: "unavailable", message: "Desktop control host is unavailable." },
    })
    expect(unavailable.stderr[0]).not.toContain("/not/a/credential/path")
  })

  test("maps SDK cloud transport failures to a sanitized host envelope", async () => {
    const directory = await mkdtemp("/tmp/daw-control-cli-")
    directories.push(directory)
    process.env.DAW_CONTROL_AUTH_PATH = join(directory, "credentials.json")
    await createCredentialStore().write(credentials)
    globalThis.fetch = Object.assign(
      async () => { throw new Error("https://secret.example/private") },
      { preconnect: previousFetch.preconnect },
    )
    const output = io()
    expect(await runCli(["capabilities"], output.value)).toBe(1)
    expect(JSON.parse(output.stderr[0]).error).toEqual({
      version: "v1",
      code: "unavailable",
      message: "Cloud control service is unavailable.",
    })
    expect(output.stderr[0]).not.toContain("secret.example")
  })

  test("requires an advertised host capability before dispatch", async () => {
    let requests = 0
    await createHost(() => { requests += 1 }, [])
    const output = io()
    expect(await runCli(["capabilities", "--target", "host"], output.value)).toBe(1)
    expect(JSON.parse(output.stderr[0])).toMatchObject({
      error: { code: "unavailable", message: "Desktop control host is unavailable." },
    })
    expect(requests).toBe(0)
  })
})
