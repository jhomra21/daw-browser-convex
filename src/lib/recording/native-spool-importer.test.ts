import { expect, test } from "bun:test"
import { mkdtemp, mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { createRecordingTempStorage, decodePlanarPcmBlocks, type RecordingStorageDirectory } from "./recording-temp-storage"
import { importNativeRecordingSpool } from "./native-spool-importer"
import type { NativeRecordingTake, NativeRecordingSpoolBridge } from "~/types/desktop-bridge"

// Real temp-file adapter exercises the canonical storage writer/descriptor, not
// a mocked importer result. Failure cases precede importer implementation.
const fixture = async (chunkSize = 13, frames = [2048, 3]) => {
  const root = await mkdtemp("/private/tmp/daw-spool-import-")
  const directory = (base: string): RecordingStorageDirectory => ({
    getDirectory: async (name, create) => {
      const target = path.join(base, name)
      if (create) await mkdir(target, { recursive: true })
      else if (!await stat(target).catch(() => undefined)) throw new DOMException("missing", "NotFoundError")
      return directory(target)
    },
    getFile: async (name) => {
      const target = path.join(base, name)
      return {
        text: () => readFile(target, "utf8"),
        createWritable: async () => {
          const handle = await open(target, "w")
          return { write: async (data) => { await handle.write(data) }, close: () => handle.close(), abort: () => handle.close() }
        },
      }
    },
    entries: async function* () { for (const entry of await readdir(base, { withFileTypes: true })) yield { name: entry.name, kind: entry.isDirectory() ? "directory" : "file" } },
    remove: async (name) => { await rm(path.join(base, name), { recursive: true, force: true }) },
  })
  const storage = createRecordingTempStorage({ filesystem: { root: async () => directory(root) } })
  const chunks = frames.map((frameCount) => {
    const block = Buffer.alloc(4 + frameCount * 8)
    block.writeUInt32LE(frameCount)
    for (let i = 0; i < frameCount * 2; i++) block.writeFloatLE(i / 2, 4 + i * 4)
    return block
  })
  const source = Buffer.concat(chunks)
  const take: NativeRecordingTake = { takeId: "opaque-take", state: "complete", sampleRateHz: 48000,
    channelCount: 2, frames: frames.reduce((a, b) => a + b, 0), bytes: source.length, blocks: frames.length }
  const releases: unknown[] = []
  const reads: { offset: number; length: number }[] = []
  const bridge: NativeRecordingSpoolBridge = {
    list: async () => ({ takes: [take], nextCursor: null }),
    read: async (_scope, _takeId, offset, length) => {
      reads.push({ offset, length })
      return new Uint8Array(source.subarray(offset, offset + Math.min(length, chunkSize)))
    },
    release: async (_scope, _takeId, ack) => { releases.push(ack) },
  }
  const input = { bridge, scope: { projectId: "local:a", projectGeneration: 1 }, take,
    sessionId: "imported", expectedSampleRateHz: 48000, isCurrent: () => true, storage,
    verifyFileSize: async (sessionId: string) => (await stat(path.join(root, "recording-sessions", sessionId, "capture.pcm"))).size }
  return { root, input, bridge, storage, take, source, releases, reads }
}

test("bounded chunk splitting preserves exact stereo short tails in canonical storage before source release", async () => {
  for (const chunk of [1, 3, 4, 13, 16387, 1048576]) {
    const f = await fixture(chunk)
    try {
      const result = await importNativeRecordingSpool(f.input)
      expect(result).toMatchObject({ capturedFrames: 2051, byteLength: 16416, finalizedAtMs: expect.any(Number) })
      const { nativeTake, ...descriptor } = result
      expect(await f.storage.open("imported")).toEqual(descriptor)
      expect(nativeTake).toMatchObject({ scope: f.input.scope, takeId: f.take.takeId,
        acknowledgment: { frames: 2051, bytes: 16416, blocks: 2, finalized: true } })
      const pcm = await readFile(path.join(f.root, "recording-sessions/imported/capture.pcm"))
      expect(pcm).toEqual(f.source)
      expect(decodePlanarPcmBlocks(pcm, 2).at(-1)?.channels).toEqual([Float32Array.of(0, 0.5, 1), Float32Array.of(1.5, 2, 2.5)])
      expect(f.releases).toHaveLength(0)
      expect(f.reads.every((read) => read.length <= 1048576)).toBeTrue()
    } finally { await rm(f.root, { recursive: true, force: true }) }
  }
})

test("zero-frame native Complete imports an exact empty finalized descriptor", async () => {
  const f = await fixture(13, [])
  try {
    expect(await importNativeRecordingSpool(f.input)).toMatchObject({ capturedFrames: 0, byteLength: 0 })
    expect(f.releases).toHaveLength(0)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test("truncated malformed duplicate and mismatched totals never release the source", async () => {
  for (const failure of ["truncated", "malformed", "extra", "frames", "blocks", "rate", "size", "read", "storage", "descriptor"]) {
    const f = await fixture(13, [3])
    try {
      if (failure === "truncated") f.bridge.read = async () => new Uint8Array()
      if (failure === "malformed") f.source.writeUInt32LE(2049)
      if (failure === "extra") f.take.bytes = (f.take.bytes ?? 0) + 28
      if (failure === "frames") f.take.frames = (f.take.frames ?? 0) + 1
      if (failure === "blocks") f.take.blocks = (f.take.blocks ?? 0) + 1
      if (failure === "rate") f.take.sampleRateHz = 44100
      if (failure === "size") f.input.verifyFileSize = async () => 0
      if (failure === "read") f.bridge.read = async () => { throw new Error("host read lost") }
      if (failure === "storage") f.storage.createSession = async () => { throw new Error("quota exceeded") }
      if (failure === "descriptor") f.storage.open = async () => null
      await expect(importNativeRecordingSpool(f.input)).rejects.toThrow()
      expect(f.releases).toEqual([])
    } finally { await rm(f.root, { recursive: true, force: true }) }
  }
})

test("project switch or reload during read or finalized-size verification retains native source", async () => {
  for (const phase of ["read", "verify", "initial"]) {
    const f = await fixture(13, [3])
    let current = phase !== "initial"
    f.input.isCurrent = () => current
    try {
      if (phase === "read") {
        const read = f.bridge.read
        f.bridge.read = async (...args) => { const bytes = await read(...args); current = false; return bytes }
      }
      if (phase === "verify") {
        const verify = f.input.verifyFileSize
        f.input.verifyFileSize = async (...args) => { const size = await verify(...args); current = false; return size }
      }
      await expect(importNativeRecordingSpool(f.input)).rejects.toThrow("scope")
      expect(f.releases).toEqual([])
    } finally { await rm(f.root, { recursive: true, force: true }) }
  }
})

test("release failure leaves canonical import and native source retryable, duplicate destination is never overwritten", async () => {
  const f = await fixture(13, [3])
  try {
    f.bridge.release = async () => { throw new Error("must not release during import") }
    const result = await importNativeRecordingSpool(f.input)
    expect(result.nativeTake).toMatchObject({ takeId: f.take.takeId, scope: f.input.scope,
      acknowledgment: { frames: 3, bytes: 28, blocks: 1 } })
    expect(await f.storage.open("imported")).toMatchObject({ finalizedAtMs: expect.any(Number), capturedFrames: 3 })
    await expect(importNativeRecordingSpool(f.input)).rejects.toThrow("exists")
    expect(f.releases).toEqual([])
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
