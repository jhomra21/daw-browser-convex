import { expect, spyOn, test } from "bun:test"
import { chmod, lstat, mkdtemp, open, readFile, rm, symlink, rename, mkdir, readdir, writeFile, type FileHandle } from "node:fs/promises"
import path from "node:path"
import { createRecordingSpoolRegistry, prepareRecordingSpool, type RecordingSpoolReleaseEvent } from "./recording-spool"

test("persists private staged intent before admission and verified rate before start", async () => {
  const root = await mkdtemp("/private/tmp/daw-spool-intent-")
  try {
    const take = await prepareRecordingSpool({
      userData: root, projectId: "local:project-a", rendererGeneration: 3,
      hostGeneration: 4, generation: 5, sessionId: 6n, channelCount: 2,
    })
    expect(take.token).toMatch(/^[0-9a-f]{64}$/)
    expect(take.root.device).toBeTypeOf("bigint")
    expect((await lstat(take.rootPath)).mode & 0o777).toBe(0o700)
    expect((await lstat(take.manifestPath)).mode & 0o777).toBe(0o600)
    const staged = JSON.parse(await readFile(take.manifestPath, "utf8"))
    expect(staged.projectIntent).toBe("local:project-a")
    expect(staged.sampleRateHz).toBeNull()
    expect(staged.stage).toBe("configuring")
    await take.confirmReady({ generation: 5, sessionId: 6n, channelCount: 2, sampleRateHz: 48000 })
    const ready = JSON.parse(await readFile(take.manifestPath, "utf8"))
    expect(ready.stage).toBe("ready")
    expect(ready.sampleRateHz).toBe(48000)
    expect(Buffer.byteLength(await readFile(take.manifestPath, "utf8"))).toBeLessThanOrEqual(4096)
    await expect(take.confirmReady({ generation: 5, sessionId: 6n, channelCount: 1, sampleRateHz: 48000 }))
      .rejects.toThrow("binding")
    expect(JSON.parse(await readFile(take.manifestPath, "utf8")).sampleRateHz).toBe(48000)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("does not realpath away the intended spool symlink", async () => {
  const root = await mkdtemp("/private/tmp/daw-spool-symlink-")
  const target = await mkdtemp("/private/tmp/daw-spool-target-")
  try {
    await symlink(target, path.join(root, "recording-spool"))
    await expect(prepareRecordingSpool({
      userData: root, projectId: "local:a", rendererGeneration: 1,
      hostGeneration: 1, generation: 1, sessionId: 1n, channelCount: 1,
    })).rejects.toThrow("private")
    expect((await lstat(path.join(root, "recording-spool"))).isSymbolicLink()).toBeTrue()
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(target, { recursive: true, force: true })
  }
})

test("rejects nonprivate existing root and unsafe project binding without touching source", async () => {
  const root = await mkdtemp("/private/tmp/daw-spool-mode-")
  try {
    const input = {
      userData: root, projectId: "local:a", rendererGeneration: 1,
      hostGeneration: 1, generation: 1, sessionId: 1n, channelCount: 1,
    }
    const take = await prepareRecordingSpool(input)
    await chmod(take.rootPath, 0o755)
    await expect(prepareRecordingSpool(input)).rejects.toThrow("private")
    expect(await readFile(take.manifestPath, "utf8")).toContain("local:a")
    await expect(prepareRecordingSpool({ ...input, projectId: "" })).rejects.toThrow("intent")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("keeps immutable declared project scope and refuses ready writes into a replaced root", async () => {
  const root = await mkdtemp("/private/tmp/daw-spool-bound-")
  try {
    const input = {
      userData: root, projectId: "local:project-original", rendererGeneration: 1,
      projectGeneration: 7, hostGeneration: 1, generation: 1, sessionId: 1n, channelCount: 1,
    }
    const take = await prepareRecordingSpool(input)
    input.projectId = "local:project-switched"
    input.generation = 2
    await take.confirmReady({ generation: 1, sessionId: 1n, channelCount: 1, sampleRateHz: 48000 })
    const ready = JSON.parse(await readFile(take.manifestPath, "utf8"))
    expect(ready.projectIntent).toBe("local:project-original")
    expect(ready.projectGeneration).toBe(7)
    await rename(take.rootPath, `${take.rootPath}-retained`)
    await mkdir(take.rootPath, { mode: 0o700 })
    await expect(take.confirmReady({ generation: 1, sessionId: 1n, channelCount: 1, sampleRateHz: 48000 }))
      .rejects.toThrow("identity")
    expect(await readdir(take.rootPath)).toEqual([])
    expect(await readdir(`${take.rootPath}-retained`)).toHaveLength(2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("refuses the production component-walk identity mismatch before manifest creation", async () => {
  const root = await mkdtemp("/private/tmp/daw-spool-verified-")
  try {
    await expect(prepareRecordingSpool({
      userData: root, projectId: "local:a", rendererGeneration: 1, hostGeneration: 1,
      generation: 1, sessionId: 1n, channelCount: 1,
      verifyDirectory: async () => ({ device: "0", inode: "0" }),
    })).rejects.toThrow("identity")
    expect(await readdir(path.join(root, "recording-spool"))).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})

// Registry failures are specified before its implementation. All sources live in
// disposable private roots; no test scavenges production storage.
import type { NativeRecordingRelease } from "../../src/types/desktop-bridge"

const scope = { projectId: "local:registry", projectGeneration: 7, rendererGeneration: 3 }
const registryFixture = async (options: Omit<Parameters<typeof createRecordingSpoolRegistry>[0], "userData"> = {}) => {
  const userData = await mkdtemp("/private/tmp/daw-spool-registry-")
  const registry = createRecordingSpoolRegistry({ userData, ...options })
  const take = await prepareRecordingSpool({ userData, ...scope, hostGeneration: 1,
    generation: 5, sessionId: 6n, channelCount: 2 })
  registry.bind(scope)
  const takeId = registry.admit(take, scope)
  await take.confirmReady({ generation: 5, sessionId: 6n, channelCount: 2, sampleRateHz: 48000 })
  const source = path.join(take.rootPath, `${take.token}.pcm`)
  const bytes = Buffer.alloc(28)
  bytes.writeUInt32LE(3)
  for (let i = 0; i < 6; i++) bytes.writeFloatLE(i + 0.5, 4 + i * 4)
  await writeFile(source, bytes, { mode: 0o600 })
  const stat = await lstat(source, { bigint: true })
  const complete = { generation: 5, sessionId: 6n, capturedFrames: 3, droppedFrames: 0,
    droppedBlocks: 0, active: false, fatal: false, configured: true, availableBlocks: 32,
    queuedBlocks: 0, rms: 0, peak: 0, timelineFrame: 3, fileDevice: stat.dev, fileInode: stat.ino,
    spool: { state: 2, error: 0, systemError: 0, writtenFrames: 3, writtenBytes: 28,
      writtenBlocks: 1, published: true, partialRetained: false, sampleRateHz: 48000, channelCount: 2 } }
  return { userData, registry, take, takeId, source, bytes, complete }
}

test("pins Complete proof, grants bounded scoped reads and verifies import acknowledgment before idempotent release", async () => {
  const f = await registryFixture()
  try {
    await expect(f.registry.read(scope, f.takeId, 0, 28)).rejects.toThrow()
    await f.registry.complete(f.takeId, f.complete)
    const listed = await f.registry.list(scope)
    expect(listed.takes[0]).toMatchObject({ takeId: f.takeId, state: "complete", frames: 3, bytes: 28, blocks: 1 })
    expect(JSON.stringify(listed)).not.toContain(f.take.token)
    expect(await f.registry.read(scope, f.takeId, 0, 13)).toEqual(new Uint8Array(f.bytes.subarray(0, 13)))
    await expect(f.registry.read(scope, f.takeId, 0, 1048577)).rejects.toThrow()
    await expect(f.registry.read({ ...scope, projectId: "local:other" }, f.takeId, 0, 1)).rejects.toThrow()
    const ack: NativeRecordingRelease = { reason: "imported", sessionId: "opfs-take", frames: 3, bytes: 28, blocks: 1,
      sampleRateHz: 48000, channelCount: 2, finalized: true, savedClip: { clipId: "local:clip", sourceAssetKey: "local:asset" } }
    await expect(f.registry.release(scope, f.takeId, { ...ack, frames: 2 })).rejects.toThrow()
    expect(await readFile(f.source)).toEqual(f.bytes)
    await f.registry.release(scope, f.takeId, ack)
    await f.registry.release(scope, f.takeId, ack)
    await expect(lstat(f.source)).rejects.toThrow()
  } finally { await rm(f.userData, { recursive: true, force: true }) }
})

test("refuses symlink, mode and replaced file identities and retains ambiguous completion", async () => {
  const f = await registryFixture()
  try {
    await f.registry.complete(f.takeId, f.complete)
    await chmod(f.source, 0o644)
    await expect(f.registry.read(scope, f.takeId, 0, 1)).rejects.toThrow()
    await expect(f.registry.release(scope, f.takeId, { reason: "discard" })).rejects.toThrow()
    await chmod(f.source, 0o600)
    await rename(f.source, `${f.source}.saved`)
    await symlink(`${f.source}.saved`, f.source)
    await expect(f.registry.read(scope, f.takeId, 0, 1)).rejects.toThrow()
    await expect(f.registry.release(scope, f.takeId, { reason: "discard" })).rejects.toThrow()
    expect((await lstat(f.source)).isSymbolicLink()).toBeTrue()
    await rm(f.source)
    await writeFile(f.source, f.bytes, { mode: 0o600 })
    await expect(f.registry.read(scope, f.takeId, 0, 1)).rejects.toThrow()
    expect(await readFile(`${f.source}.saved`)).toEqual(f.bytes)
  } finally { await rm(f.userData, { recursive: true, force: true }) }
})

test("startup refuses recovery while a writer may exist and recovers only durable Complete proofs", async () => {
  const f = await registryFixture()
  try {
    await f.registry.complete(f.takeId, f.complete)
    const recovered = createRecordingSpoolRegistry({ userData: f.userData })
    recovered.bind(scope)
    await recovered.discover()
    const takes = (await recovered.list(scope)).takes
    expect(takes).toHaveLength(1)
    expect(takes[0]?.state).toBe("complete")
    expect(await recovered.read(scope, takes[0]!.takeId, 0, 28)).toEqual(new Uint8Array(f.bytes))
    recovered.bind({ ...scope, rendererGeneration: 4 })
    await expect(recovered.read(scope, takes[0]!.takeId, 0, 1)).rejects.toThrow()
    const newScope = { ...scope, rendererGeneration: 4 }
    await recovered.release(newScope, takes[0]!.takeId, { reason: "discard" })
  } finally { await rm(f.userData, { recursive: true, force: true }) }
})

test("unproven published sources and partials are discoverable but never guessed or age deleted", async () => {
  const f = await registryFixture()
  try {
    const recovered = createRecordingSpoolRegistry({ userData: f.userData })
    recovered.bind(scope)
    await recovered.discover()
    const result = await recovered.list(scope)
    expect(result.takes[0]?.state).toBe("pending")
    await expect(recovered.read(scope, result.takes[0]!.takeId, 0, 1)).rejects.toThrow()
    await expect(recovered.release(scope, result.takes[0]!.takeId, { reason: "discard" })).rejects.toThrow()
    expect(await readFile(f.source)).toEqual(f.bytes)
    expect(await readdir(f.take.rootPath)).toHaveLength(3)
  } finally { await rm(f.userData, { recursive: true, force: true }) }
})

test("Complete refuses wrong formula, negotiated rate, scope and native identity", async () => {
  // A failed proof outcome is intentionally sticky for its take. Fresh takes
  // ensure each malformed field really reaches its own validation gate.
  for (const variant of ["inode", "blocks", "rate", "frames"]) {
    const f = await registryFixture()
    try {
      const bad = variant === "inode" ? { ...f.complete, fileInode: f.complete.fileInode + 1n }
        : variant === "blocks" ? { ...f.complete, spool: { ...f.complete.spool, writtenBlocks: 2 } }
        : variant === "rate" ? { ...f.complete, spool: { ...f.complete.spool, sampleRateHz: 44100 } }
        : { ...f.complete, capturedFrames: 4 }
      const message = variant === "inode" ? "identity" : variant === "blocks" ? "totals" : variant === "rate" ? "format" : "binding"
      await expect(f.registry.complete(f.takeId, bad)).rejects.toThrow(message)
      await expect(f.registry.complete(f.takeId, f.complete)).rejects.toThrow(message)
      expect(await readFile(f.source)).toEqual(f.bytes)
    } finally { await rm(f.userData, { recursive: true, force: true }) }
  }
  const f = await registryFixture()
  try {
    await f.registry.complete(f.takeId, f.complete)
    f.registry.bind({ ...scope, projectGeneration: 8 })
    await expect(f.registry.read(scope, f.takeId, 0, 1)).rejects.toThrow("scope")
  } finally { await rm(f.userData, { recursive: true, force: true }) }
})


test("M3 unsafe registry startup isolates failure and cannot create a recording intent", async () => {
  const root = await mkdtemp("/private/tmp/daw-registry-startup-")
  try {
    await mkdir(path.join(root, "recording-spool"), { mode: 0o755 })
    const { initializeRecordingSpoolRegistry } = await import("./recording-spool")
    const result = await initializeRecordingSpoolRegistry({ userData: root })
    expect(result.registry).toBeUndefined()
    expect(result.error?.message).toContain("private")
    expect(await readdir(path.join(root, "recording-spool"))).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("M1 import proof alone cannot release nonempty source without a saved durable clip receipt", async () => {
  const f = await registryFixture()
  try {
    await f.registry.complete(f.takeId, f.complete)
    await expect(f.registry.release(scope, f.takeId, { reason: "imported", sessionId: "opfs", frames: 3,
      bytes: 28, blocks: 1, channelCount: 2, sampleRateHz: 48000, finalized: true })).rejects.toThrow()
    expect(await readFile(f.source)).toEqual(f.bytes)
  } finally { await rm(f.userData, { recursive: true, force: true }) }
})

test("M5 matched source-less terminal resolves but ambiguous or retained source never does", async () => {
  for (const variant of ["absent", "partial", "published", "wrong-session", "retained-flag"]) {
    const f = await registryFixture()
    try {
      await rm(f.source)
      if (variant === "partial") await writeFile(path.join(f.take.rootPath, `${f.take.token}.partial`), f.bytes, { mode: 0o600 })
      const status = { ...f.complete, sessionId: variant === "wrong-session" ? 7n : 6n,
        spool: { ...f.complete.spool, state: 3, error: 6, writtenFrames: 0, writtenBytes: 0, writtenBlocks: 0,
          published: variant === "published", partialRetained: variant === "retained-flag" } }
      if (variant === "absent") {
        await f.registry.resolveTerminal(f.takeId, status)
        expect((await f.registry.list(scope)).takes).toEqual([])
        const restart = createRecordingSpoolRegistry({ userData: f.userData }); restart.bind(scope)
        await restart.discover()
        expect((await restart.list(scope)).takes).toEqual([])
      } else {
        await expect(f.registry.resolveTerminal(f.takeId, status)).rejects.toThrow()
        expect((await f.registry.list(scope)).takes).toHaveLength(1)
      }
    } finally { await rm(f.userData, { recursive: true, force: true }) }
  }
})

test("M6 receipt precedes unlink and restart converges only matching identity", async () => {
  for (const replace of [false, true]) {
    const f = await registryFixture()
    try {
      await f.registry.complete(f.takeId, f.complete)
      const receiptPath = path.join(f.take.rootPath, `${f.take.token}.released.json`)
      // Deliberately refuse root ownership after the durable receipt seam.
      const registry = createRecordingSpoolRegistry({ userData: f.userData,
        beforeReleaseUnlink: async () => { expect(await lstat(receiptPath)).toBeDefined(); await chmod(f.take.rootPath, 0o500) } })
      registry.bind(scope); await registry.discover()
      const takeId = (await registry.list(scope)).takes[0]!.takeId
      await expect(registry.release(scope, takeId, { reason: "discard" })).rejects.toThrow()
      expect(await readFile(f.source)).toEqual(f.bytes)
      await chmod(f.take.rootPath, 0o700)
      if (replace) { await rename(f.source, `${f.source}.saved`); await writeFile(f.source, f.bytes, { mode: 0o600 }) }
      const restart = createRecordingSpoolRegistry({ userData: f.userData }); restart.bind(scope)
      if (replace) {
        await expect(restart.discover()).rejects.toThrow("identity")
        expect(await readFile(f.source)).toEqual(f.bytes)
      } else {
        await restart.discover()
        expect((await restart.list(scope)).takes).toEqual([])
        await expect(lstat(f.source)).rejects.toThrow()
      }
    } finally { await chmod(f.take.rootPath, 0o700).catch(() => undefined); await rm(f.userData, { recursive: true, force: true }) }
  }
})

test("M6 conflicting concurrent acknowledgments never join another release", async () => {
  const f = await registryFixture()
  const entered = Promise.withResolvers<void>(); const gate = Promise.withResolvers<void>()
  try {
    await f.registry.complete(f.takeId, f.complete)
    const registry = createRecordingSpoolRegistry({ userData: f.userData,
      beforeReleaseUnlink: async () => { entered.resolve(); await gate.promise } })
    registry.bind(scope); await registry.discover()
    const takeId = (await registry.list(scope)).takes[0]!.takeId
    const first = registry.release(scope, takeId, { reason: "discard" })
    await entered.promise
    await expect(registry.release(scope, takeId, { reason: "imported", sessionId: "opfs", frames: 3, bytes: 28,
      blocks: 1, channelCount: 2, sampleRateHz: 48000, finalized: true,
      savedClip: { clipId: "local:clip", sourceAssetKey: "local:asset" } })).rejects.toThrow("changed")
    gate.resolve(); await first
  } finally { gate.resolve(); await rm(f.userData, { recursive: true, force: true }) }
})

test("M7 component helper is admission-only, never spawned for bounded reads", async () => {
  const root = await mkdtemp("/private/tmp/daw-registry-helper-")
  let calls = 0
  try {
    const take = await prepareRecordingSpool({ userData: root, ...scope, hostGeneration: 1, generation: 5,
      sessionId: 6n, channelCount: 2, verifyDirectory: async (name) => {
        calls++; const info = await lstat(name, { bigint: true }); return { device: info.dev.toString(), inode: info.ino.toString() }
      } })
    const registry = createRecordingSpoolRegistry({ userData: root }); registry.bind(scope)
    const takeId = registry.admit(take, scope)
    await take.confirmReady({ generation: 5, sessionId: 6n, channelCount: 2, sampleRateHz: 48000 })
    const source = path.join(take.rootPath, `${take.token}.pcm`); await writeFile(source, Buffer.alloc(0), { mode: 0o600 })
    const info = await lstat(source, { bigint: true })
    const f = await registryFixture()
    try { await registry.complete(takeId, { ...f.complete, capturedFrames: 0, fileDevice: info.dev, fileInode: info.ino,
      spool: { ...f.complete.spool, writtenFrames: 0, writtenBytes: 0, writtenBlocks: 0 } }) }
    finally { await rm(f.userData, { recursive: true, force: true }) }
    expect(calls).toBe(1)
    for (let i = 0; i < 10; i++) expect(await registry.read(scope, takeId, 0, 1)).toHaveLength(0)
    expect(calls).toBe(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})


test("M2 main storage lifecycle settlement does not erase failed proof outcome or veto quit", async () => {
  const f = await registryFixture()
  try {
    const bad = { ...f.complete, fileInode: f.complete.fileInode + 1n }
    await expect(f.registry.complete(f.takeId, bad)).rejects.toThrow("identity")
    await expect(f.registry.waitForSettlement()).resolves.toBeUndefined()
    expect(await readFile(f.source)).toEqual(f.bytes)
  } finally { await rm(f.userData, { recursive: true, force: true }) }
})

const releasePhases: RecordingSpoolReleaseEvent["kind"][] = ["receipt-file-synced", "receipt-directory-synced", "source-unlink-started", "source-unlinked", "source-directory-synced"]
const expectedReleaseEvents = (releaseOrdinal: number): RecordingSpoolReleaseEvent[] => [
  { version: 1, releaseOrdinal, sequence: 1, kind: "receipt-file-synced", succeeded: true, frames: 3, bytes: 28, blocks: 1, sampleRateHz: 48000, channelCount: 2 },
  { version: 1, releaseOrdinal, sequence: 2, kind: "receipt-directory-synced", succeeded: true, frames: 3, bytes: 28, blocks: 1, sampleRateHz: 48000, channelCount: 2 },
  { version: 1, releaseOrdinal, sequence: 3, kind: "source-unlink-started", succeeded: true, frames: 3, bytes: 28, blocks: 1, sampleRateHz: 48000, channelCount: 2 },
  { version: 1, releaseOrdinal, sequence: 4, kind: "source-unlinked", succeeded: true, frames: 3, bytes: 28, blocks: 1, sampleRateHz: 48000, channelCount: 2 },
  { version: 1, releaseOrdinal, sequence: 5, kind: "source-directory-synced", succeeded: true, frames: 3, bytes: 28, blocks: 1, sampleRateHz: 48000, channelCount: 2 },
]

test("release observer records exact successful IO order and no intent/ready/Complete/discovery events", async () => {
  const events: RecordingSpoolReleaseEvent[] = []
  const f = await registryFixture({ observeRelease: (event) => events.push(event) })
  try {
    await f.registry.complete(f.takeId, f.complete)
    await f.registry.discover()
    expect(events).toEqual([])
    await f.registry.release(scope, f.takeId, { reason: "discard" })
    expect(events).toEqual(expectedReleaseEvents(1))
    await expect(lstat(f.source)).rejects.toThrow("ENOENT")
    await f.registry.release(scope, f.takeId, { reason: "discard" })
    expect(events).toEqual(expectedReleaseEvents(1))
    const serialized = JSON.stringify(events)
    for (const secret of [f.take.token, f.takeId, f.userData, scope.projectId, "sessionId", "fileInode", "fileDevice", "rootInode", "rootDevice", "pcm"]) {
      expect(serialized).not.toContain(secret)
    }
  } finally { await rm(f.userData, { recursive: true, force: true }) }
})

test("real FileHandle sync rejection emits no later success and receipt sync failure retains source", async () => {
  // Close only the selected real handle before calling its original sync:
  // the actual fs sync rejects EBADF, not a fabricated observer exception.
  for (const failedSync of [1, 2, 3]) {
    const events: RecordingSpoolReleaseEvent[] = []
    const f = await registryFixture({ observeRelease: (event) => events.push(event) })
    await f.registry.complete(f.takeId, f.complete)
    const sample = await open(f.source, "r")
    const prototype: { sync: FileHandle["sync"] } = Object.getPrototypeOf(sample)
    const originalSync = prototype.sync
    await sample.close()
    let syncs = 0
    const intercepted = spyOn(prototype, "sync").mockImplementation(async function(this: FileHandle) {
      syncs++
      if (syncs === failedSync) await this.close()
      return originalSync.call(this)
    })
    try {
      await expect(f.registry.release(scope, f.takeId, { reason: "discard" })).rejects.toMatchObject({ code: "EBADF" })
      expect(syncs).toBe(failedSync)
      expect(events.map((event) => event.kind)).toEqual(releasePhases.slice(0, failedSync === 1 ? 0 : failedSync === 2 ? 1 : 4))
      expect(events.every((event) => event.succeeded)).toBeTrue()
      if (failedSync < 3) expect(await readFile(f.source)).toEqual(f.bytes)
      else await expect(lstat(f.source)).rejects.toThrow("ENOENT")
    } finally {
      intercepted.mockRestore()
      await rm(f.userData, { recursive: true, force: true })
    }
  }
})

test("throwing synchronous release observer cannot veto saved release or later events", async () => {
  let calls = 0
  const f = await registryFixture({ observeRelease: () => { calls++; throw new Error("diagnostic output unavailable") } })
  try {
    await f.registry.complete(f.takeId, f.complete)
    await expect(f.registry.release(scope, f.takeId, { reason: "imported", sessionId: "saved",
      frames: 3, bytes: 28, blocks: 1, sampleRateHz: 48000, channelCount: 2, finalized: true,
      savedClip: { clipId: "local:clip", sourceAssetKey: "local:asset" } })).resolves.toBeUndefined()
    expect(calls).toBe(5)
    await expect(lstat(f.source)).rejects.toThrow("ENOENT")
    expect((await f.registry.list(scope)).takes).toEqual([])
  } finally { await rm(f.userData, { recursive: true, force: true }) }
})

test("existing receipt retry reports only actual unlink IO and recovery manufactures no observations", async () => {
  for (const branch of ["retry-present", "retry-absent", "recovery"]) {
    const events: RecordingSpoolReleaseEvent[] = []
    let interrupted = true
    const f = await registryFixture({
      observeRelease: (event) => events.push(event),
      beforeReleaseUnlink: async () => { if (interrupted) throw new Error("stop after actual receipt sync") },
    })
    try {
      await f.registry.complete(f.takeId, f.complete)
      await expect(f.registry.release(scope, f.takeId, { reason: "discard" })).rejects.toThrow("stop after")
      expect(events).toEqual(expectedReleaseEvents(1).slice(0, 2))
      expect(await readFile(f.source)).toEqual(f.bytes)
      events.length = 0
      if (branch === "recovery") {
        const restart = createRecordingSpoolRegistry({ userData: f.userData, observeRelease: (event) => events.push(event) })
        restart.bind(scope); await restart.discover()
        expect(events).toEqual([])
        expect((await restart.list(scope)).takes).toEqual([])
      } else {
        interrupted = false
        if (branch === "retry-absent") await rm(f.source)
        await f.registry.release(scope, f.takeId, { reason: "discard" })
        expect(events).toEqual(expectedReleaseEvents(2).slice(branch === "retry-absent" ? 4 : 2)
          .map((event, index) => ({ ...event, sequence: index + 1 })))
      }
      await expect(lstat(f.source)).rejects.toThrow("ENOENT")
    } finally { await rm(f.userData, { recursive: true, force: true }) }
  }
})

test("stdout order evidence is opt-in with exact readiness and bounded lines; cap never gates release", async () => {
  const { createRecordingSpoolOrderEvidence } = await import("./recording-spool")
  const lines: string[] = []
  for (const flag of [undefined, "", "0", "true", "2"]) {
    expect(createRecordingSpoolOrderEvidence(flag, (line) => lines.push(line))).toBeUndefined()
  }
  expect(lines).toEqual([])
  const evidence = createRecordingSpoolOrderEvidence("1", (line) => lines.push(line))
  if (!evidence) throw new Error("Expected enabled ordering evidence")
  evidence.ready()
  expect(lines).toEqual(['[recording-spool-order] {"version":1,"kind":"observer-ready"}\n'])
  const registry = createRecordingSpoolRegistry({ userData: "/private/tmp/unused-order-observer-root", observeRelease: evidence.observeRelease })
  registry.bind(scope)
  for (let ordinal = 1; ordinal <= 4; ordinal++) {
    const f = await registryFixture()
    try {
      const takeId = registry.admit(f.take, scope)
      await registry.complete(takeId, f.complete)
      await registry.release(scope, takeId, { reason: "discard" })
      await expect(lstat(f.source)).rejects.toThrow("ENOENT")
    } finally { await rm(f.userData, { recursive: true, force: true }) }
  }
  expect(lines).toHaveLength(17) // One readiness + at most sixteen operation lines.
  expect(lines.slice(1)).toEqual([1, 2, 3, 4].flatMap((ordinal) => expectedReleaseEvents(ordinal))
    .slice(0, 16).map((event) => `[recording-spool-order] ${JSON.stringify(event)}\n`))
  for (const line of lines) {
    expect(line.startsWith("[recording-spool-order] ")).toBeTrue()
    expect(line.length).toBeLessThanOrEqual(1024)
  }
})

test("stdout order evidence emits readiness once and only then accepts bounded release events", async () => {
  const { createRecordingSpoolOrderEvidence } = await import("./recording-spool")
  const lines: string[] = []
  const evidence = createRecordingSpoolOrderEvidence("1", (line) => lines.push(line))
  if (!evidence) throw new Error("Expected enabled ordering evidence")
  evidence.observeRelease(expectedReleaseEvents(1)[0]!)
  expect(lines).toEqual([])
  evidence.ready()
  evidence.ready()
  for (const event of expectedReleaseEvents(1)) evidence.observeRelease(event)
  expect(lines).toEqual([
    '[recording-spool-order] {"version":1,"kind":"observer-ready"}\n',
    ...expectedReleaseEvents(1).map((event) => `[recording-spool-order] ${JSON.stringify(event)}\n`),
  ])
})

test("disabled ordering evidence makes no writes; stdout errors are isolated for readiness and release", async () => {
  const { createRecordingSpoolOrderEvidence, initializeRecordingSpoolRegistry } = await import("./recording-spool")
  let writes = 0
  const writer = () => { writes++; throw new Error("stdout failed") }
  const disabled = createRecordingSpoolOrderEvidence(undefined, writer)
  const f = await registryFixture({ observeRelease: disabled?.observeRelease })
  try {
    await f.registry.complete(f.takeId, f.complete)
    await f.registry.release(scope, f.takeId, { reason: "discard" })
    expect(writes).toBe(0)
    const enabled = createRecordingSpoolOrderEvidence("1", writer)
    if (!enabled) throw new Error("Expected enabled ordering evidence")
    expect(() => enabled.ready()).not.toThrow()
    for (const event of expectedReleaseEvents(1)) expect(() => enabled.observeRelease(event)).not.toThrow()
    expect(writes).toBe(6)
    const startup = await initializeRecordingSpoolRegistry({ userData: f.userData, observeRelease: enabled.observeRelease })
    expect(startup.error).toBeUndefined()
    expect(startup.registry).toBeDefined()
    expect(writes).toBe(6) // Discovery/recovery never emits operation facts.
  } finally { await rm(f.userData, { recursive: true, force: true }) }
})
