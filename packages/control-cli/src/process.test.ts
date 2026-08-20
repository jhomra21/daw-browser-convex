import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type Socket } from "node:net"
import { join } from "node:path"
import {
  desktopFrameSchemaV1,
  desktopProtocolVersion,
  type DesktopFrame,
} from "@daw-browser/desktop-protocol"
import { createDesktopFrameDecoder, encodeDesktopFrame } from "@daw-browser/desktop-protocol/socket"
import { projectSnapshotSchemaV1 } from "@daw-browser/control"

const directories: string[] = []
const servers: ReturnType<typeof createServer>[] = []
const entrypoint = new URL("./index.ts", import.meta.url).pathname
const mcpEntrypoint = new URL("./mcp.ts", import.meta.url).pathname

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("control CLI processes", () => {
  test("CLI help is human-readable and command failures use stderr JSON only", async () => {
    const help = Bun.spawn(["bun", entrypoint, "--help"], { stdout: "pipe", stderr: "pipe" })
    expect(await new Response(help.stdout).text()).toContain("Usage: daw-control")
    expect(await new Response(help.stderr).text()).toBe("")
    expect(await help.exited).toBe(0)

    const failed = Bun.spawn(["bun", entrypoint, "auth", "status", "--extra"], { stdout: "pipe", stderr: "pipe" })
    expect(await new Response(failed.stdout).text()).toBe("")
    expect(JSON.parse(await new Response(failed.stderr).text())).toMatchObject({
      version: "v1",
      ok: false,
      command: "auth status",
    })
    expect(await failed.exited).toBe(1)
  })

  test("stdio MCP starts without cloud credentials for local host routing", async () => {
    const directory = await mkdtemp("/tmp/daw-control-cli-")
    directories.push(directory)
    const credentialsPath = join(directory, "credentials.json")
    await Bun.write(credentialsPath, "{")
    const child = Bun.spawn(["bun", mcpEntrypoint], {
      env: { ...process.env, DAW_CONTROL_AUTH_PATH: credentialsPath },
      stdout: "pipe",
      stderr: "pipe",
    })
    await Bun.sleep(50)
    expect(child.exitCode).toBeNull()
    child.kill()
    expect(await new Response(child.stdout).text()).toBe("")
    expect(await new Response(child.stderr).text()).toBe("")
  })

  test("runs authenticated host JSONL RPC through the real CLI process", async () => {
    const directory = await mkdtemp("/tmp/daw-control-cli-")
    directories.push(directory)
    const hostDirectory = join(directory, "host")
    const socketPath = join(hostDirectory, "control.sock")
    await mkdir(hostDirectory, { recursive: true, mode: 0o700 })
    await chmod(hostDirectory, 0o700)
    const snapshot = projectSnapshotSchemaV1.parse({
      version: "v1",
      project: {
        id: "project-1",
        name: "Process fixture",
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
    const receivedFrames: string[] = []
    const server = createServer((socket: Socket) => {
      const decoder = createDesktopFrameDecoder((frame: DesktopFrame) => {
        receivedFrames.push(`${frame.version}:${frame.type}`)
        if (frame.type === "hello") {
          if (frame.version === "v2") {
            socket.write(encodeDesktopFrame(desktopFrameSchemaV1.parse({
              version: desktopProtocolVersion,
              type: "helloAck",
              sessionId: "process-session-fallback",
              capabilities: ["host.status", "control.snapshot"],
            })))
          } else {
            socket.write(encodeDesktopFrame(desktopFrameSchemaV1.parse({
              version: desktopProtocolVersion,
              type: "helloAck",
              sessionId: "process-session-v1",
              capabilities: ["host.status", "control.snapshot"],
            })))
          }
          return
        }
        if (frame.type !== "request") return
        const result = frame.operation === "host.status"
          ? { project: { id: "project-1", kind: "local" }, ready: true, transport: "stopped", capabilities: { playback: true, diagnostics: true } }
          : snapshot
        socket.write(encodeDesktopFrame(desktopFrameSchemaV1.parse({
          version: "v1",
          type: "reply",
          id: frame.id,
          result,
        })))
      })
      socket.on("data", decoder)
    })
    servers.push(server)
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socketPath, resolve))
    await writeFile(join(hostDirectory, "registration-v1.json"), JSON.stringify({
      version: "v1",
      instanceId: "a".repeat(32),
      pid: process.pid,
      createdAt: Date.now(),
      address: socketPath,
      secret: "b".repeat(64),
    }), { mode: 0o600 })
    await chmod(join(hostDirectory, "registration-v1.json"), 0o600)
    const child = Bun.spawn(["bun", entrypoint, "rpc", "--target", "host"], {
      env: {
        ...process.env,
        DAW_DESKTOP_USER_DATA: directory,
        DAW_CONTROL_AUTH_PATH: join(directory, "credentials.json"),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write('{"jsonrpc":"2.0","method":"project.current","params":{}}\n')
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"project.list","params":{}}\n')
    child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"control.snapshot","params":{"projectId":"project-1"}}\n')
    child.stdin.end()
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    const exitCode = await child.exited
    if (exitCode !== 0) throw new Error(`${stderr}frames=${receivedFrames.join(",")}`)
    expect(stderr).toBe("")
    const responses = stdout.trimEnd().split("\n").map((line) => JSON.parse(line))
    expect(responses).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: { projects: [{ projectId: "project-1" }] },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        result: { ...snapshot, version: "v2" },
      },
    ])
  })
})
