import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import path from "node:path"
import { createHostClient, registrationFile } from "./host"

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

describe("desktop host handshake deadlines", () => {
  const directories: string[] = []
  const servers: ReturnType<typeof createServer>[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  test("rejects and closes an accepted but silent host before the handshake deadline", async () => {
    const userDataDirectory = await mkdtemp("/tmp/daw-host-")
    directories.push(userDataDirectory)
    const hostDirectory = path.join(userDataDirectory, "host")
    const socketPath = path.join(hostDirectory, "host.sock")
    await mkdir(hostDirectory, { recursive: true, mode: 0o700 })
    await chmod(hostDirectory, 0o700)
    const server = createServer()
    servers.push(server)
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socketPath, resolve))
    await writeFile(path.join(hostDirectory, "registration-v1.json"), JSON.stringify({
      version: "v1",
      instanceId: "a".repeat(32),
      pid: process.pid,
      createdAt: Date.now(),
      address: socketPath,
      secret: "b".repeat(64),
    }), { mode: 0o600 })
    await chmod(path.join(hostDirectory, "registration-v1.json"), 0o600)

    await expect(createHostClient({
      paths: { platform: "linux", homeDirectory: "/tmp", userDataDirectory },
      handshakeDeadlineMs: 20,
    })).rejects.toThrow("Desktop host handshake deadline exceeded.")
  })
})
