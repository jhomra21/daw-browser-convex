import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"

const directories: string[] = []
const entrypoint = new URL("./index.ts", import.meta.url).pathname
const mcpEntrypoint = new URL("./mcp.ts", import.meta.url).pathname

afterEach(async () => {
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
})
