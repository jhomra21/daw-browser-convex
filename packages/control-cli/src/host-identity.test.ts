import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadHostActorIdentity } from "./host-identity"

const directories: string[] = []
const originalActorPath = process.env.DAW_CONTROL_ACTOR_PATH
const actorId = "9d8ab7cb-6203-4a25-84d5-b7a58436b7f4"

const temporaryDirectory = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "daw-host-identity-"))
  directories.push(directory)
  return directory
}

const writeIdentity = async (file: string, contents: string, mode = 0o600) => {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") await chmod(path.dirname(file), 0o700)
  await writeFile(file, contents, { mode })
  if (process.platform !== "win32") await chmod(file, mode)
}

beforeEach(() => {
  delete process.env.DAW_CONTROL_ACTOR_PATH
})

afterEach(async () => {
  if (originalActorPath === undefined) delete process.env.DAW_CONTROL_ACTOR_PATH
  else process.env.DAW_CONTROL_ACTOR_PATH = originalActorPath
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe("host actor identity", () => {
  test("creates one stable private identity", async () => {
    const root = await temporaryDirectory()
    const file = path.join(root, "nested", "host-actor-v1.json")

    const first = await loadHostActorIdentity(file)
    const second = await loadHostActorIdentity(file)

    expect(second).toBe(first)
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: "v1",
      actorId: first,
    })
    if (process.platform !== "win32") {
      expect((await lstat(path.dirname(file))).mode & 0o777).toBe(0o700)
      expect((await lstat(file)).mode & 0o777).toBe(0o600)
    }
  })

  test("publishes one winner across concurrent loads without temporary files", async () => {
    const root = await temporaryDirectory()
    const directory = path.join(root, "identity")
    const file = path.join(directory, "host-actor-v1.json")

    const identities = await Promise.all(
      Array.from({ length: 32 }, () => loadHostActorIdentity(file)),
    )

    expect(new Set(identities).size).toBe(1)
    expect((await readdir(directory)).sort()).toEqual(["host-actor-v1.json"])
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: "v1",
      actorId: identities[0],
    })
  })

  test("uses the environment override without touching the default path", async () => {
    const root = await temporaryDirectory()
    const defaultFile = path.join(root, "default", "host-actor-v1.json")
    const overrideFile = path.join(root, "override", "host-actor-v1.json")
    process.env.DAW_CONTROL_ACTOR_PATH = overrideFile

    const identity = await loadHostActorIdentity(defaultFile)

    expect(JSON.parse(await readFile(overrideFile, "utf8"))).toEqual({
      version: "v1",
      actorId: identity,
    })
    await expect(lstat(defaultFile)).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("rejects a parent symlink without creating a file in its target", async () => {
    const root = await temporaryDirectory()
    const target = path.join(root, "target")
    const linkedDirectory = path.join(root, "linked")
    await mkdir(target, { mode: 0o700 })
    await symlink(target, linkedDirectory, "dir")

    await expect(
      loadHostActorIdentity(path.join(linkedDirectory, "host-actor-v1.json")),
    ).rejects.toThrow("Host actor directory is not private.")
    expect(await readdir(target)).toEqual([])
  })

  test("rejects an existing non-directory parent", async () => {
    const root = await temporaryDirectory()
    const parent = path.join(root, "identity")
    await writeFile(parent, "unchanged")

    await expect(
      loadHostActorIdentity(path.join(parent, "host-actor-v1.json")),
    ).rejects.toThrow("Host actor directory is not private.")
    expect(await readFile(parent, "utf8")).toBe("unchanged")
  })

  test("rejects an unsafe existing parent without changing its mode", async () => {
    if (process.platform === "win32") return
    const root = await temporaryDirectory()
    const directory = path.join(root, "identity")
    await mkdir(directory, { mode: 0o755 })
    await chmod(directory, 0o755)

    await expect(
      loadHostActorIdentity(path.join(directory, "host-actor-v1.json")),
    ).rejects.toThrow("Host actor directory is not private.")
    expect((await lstat(directory)).mode & 0o777).toBe(0o755)
    expect(await readdir(directory)).toEqual([])
  })

  test("rejects a file symlink without changing its target", async () => {
    const root = await temporaryDirectory()
    const directory = path.join(root, "identity")
    const target = path.join(root, "target.json")
    const file = path.join(directory, "host-actor-v1.json")
    await mkdir(directory, { mode: 0o700 })
    if (process.platform !== "win32") await chmod(directory, 0o700)
    await writeFile(target, "unchanged")
    await symlink(target, file, "file")

    await expect(loadHostActorIdentity(file)).rejects.toThrow(
      "Host actor identity is not private.",
    )
    expect(await readFile(target, "utf8")).toBe("unchanged")
  })

  test("rejects a directory at the identity path without replacing it", async () => {
    const root = await temporaryDirectory()
    const file = path.join(root, "identity", "host-actor-v1.json")
    await mkdir(file, { recursive: true, mode: 0o700 })
    if (process.platform !== "win32") {
      await chmod(path.dirname(file), 0o700)
      await chmod(file, 0o700)
    }

    await expect(loadHostActorIdentity(file)).rejects.toThrow(
      "Host actor identity is not private.",
    )
    expect((await lstat(file)).isDirectory()).toBe(true)
  })

  test("rejects an unsafe identity file without changing it", async () => {
    if (process.platform === "win32") return
    const root = await temporaryDirectory()
    const file = path.join(root, "identity", "host-actor-v1.json")
    const contents = JSON.stringify({ version: "v1", actorId })
    await writeIdentity(file, contents, 0o644)

    await expect(loadHostActorIdentity(file)).rejects.toThrow(
      "Host actor identity is not private.",
    )
    expect(await readFile(file, "utf8")).toBe(contents)
    expect((await lstat(file)).mode & 0o777).toBe(0o644)
  })

  test("rejects corrupt and oversized identity files without regenerating them", async () => {
    const invalidContents = [
      "{",
      JSON.stringify({ version: "v1", actorId, extra: true }),
      JSON.stringify({ version: "v1", actorId: "9D8AB7CB-6203-4A25-84D5-B7A58436B7F4" }),
      " ".repeat(1025),
    ]

    for (const contents of invalidContents) {
      const root = await temporaryDirectory()
      const file = path.join(root, "identity", "host-actor-v1.json")
      await writeIdentity(file, contents)

      await expect(loadHostActorIdentity(file)).rejects.toThrow()
      expect(await readFile(file, "utf8")).toBe(contents)
    }
  })

  test("accepts a valid identity at the 1024-byte limit", async () => {
    const root = await temporaryDirectory()
    const file = path.join(root, "identity", "host-actor-v1.json")
    const identity = JSON.stringify({ version: "v1", actorId })
    const contents = identity.padEnd(1024, " ")
    await writeIdentity(file, contents)

    expect(await loadHostActorIdentity(file)).toBe(actorId)
    expect(await readFile(file, "utf8")).toBe(contents)
  })
})
