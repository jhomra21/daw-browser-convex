import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { createCredentialStore, type ControlCredentials } from "./credentials"
import { runCli } from "./index"

const directories: string[] = []
const previousCredentialPath = process.env.DAW_CONTROL_AUTH_PATH

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
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

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
})
