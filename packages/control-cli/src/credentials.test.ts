import { afterEach, describe, expect, test } from "bun:test"
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { createCredentialStore, type ControlCredentials } from "./credentials"

const directories: string[] = []

const temporaryStore = async () => {
  const directory = await mkdtemp("/tmp/daw-control-cli-")
  directories.push(directory)
  return createCredentialStore(join(directory, "nested", "credentials.json"))
}

const credentials: ControlCredentials = {
  version: "v1",
  baseUrl: "https://control.example",
  clientId: "client-1",
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: Date.now() + 60_000,
  scopes: ["control:read", "control:write", "offline_access"],
  resource: "https://control.example/api",
  tokenEndpoint: "https://control.example/api/auth/oauth2/token",
  revocationEndpoint: "https://control.example/api/auth/oauth2/revoke",
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("control credential store", () => {
  test("writes private files atomically and redacts nothing into the API", async () => {
    const store = await temporaryStore()
    await store.write(credentials)
    expect(await store.read()).toEqual(credentials)
    expect((await lstat(store.path)).mode & 0o077).toBe(0)
    expect((await lstat(join(store.path, ".."))).mode & 0o077).toBe(0)
    expect(await readFile(store.path, "utf8")).toContain("access-token")
  })

  test("rejects symlinks and corrupt credential files", async () => {
    const store = await temporaryStore()
    await mkdir(join(store.path, ".."), { recursive: true })
    await Bun.write(store.path, "{")
    await chmod(store.path, 0o600)
    await expect(store.read()).rejects.toThrow("Credential file is invalid.")
    await rm(store.path)
    await Bun.write(join(store.path, "..", "target"), "token")
    await symlink(join(store.path, "..", "target"), store.path)
    await expect(store.read()).rejects.toThrow("Credential file permissions are unsafe.")
  })
})
