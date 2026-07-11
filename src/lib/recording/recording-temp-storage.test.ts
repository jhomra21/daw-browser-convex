import { describe, expect, test } from "bun:test"
import {
  createRecordingTempStorage,
  decodePlanarPcmBlocks,
  RecordingTempStorageError,
  type RecordingStorageDirectory,
  type RecordingStorageDirectoryEntry,
  type RecordingStorageFile,
  type RecordingStorageFilesystem,
  type RecordingStorageWritable
} from "./recording-temp-storage"

type MemoryFile = {
  kind: "file"
  bytes: Uint8Array
}

type MemoryDirectory = {
  kind: "directory"
  children: Map<string, MemoryNode>
}

type MemoryNode = MemoryFile | MemoryDirectory

const createMemoryFilesystem = (failWriteAt = Number.POSITIVE_INFINITY) => {
  const root: MemoryDirectory = { kind: "directory", children: new Map() }
  let writes = 0

  const wrapFile = (file: MemoryFile): RecordingStorageFile => ({
    createWritable: async (): Promise<RecordingStorageWritable> => {
      const chunks: Uint8Array[] = []
      return {
        write: async (data) => {
          writes += 1
          if (writes === failWriteAt) throw new DOMException("full", "QuotaExceededError")
          chunks.push(new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)))
        },
        close: async () => {
          const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
          const bytes = new Uint8Array(length)
          let offset = 0
          for (const chunk of chunks) {
            bytes.set(chunk, offset)
            offset += chunk.byteLength
          }
          file.bytes = bytes
        },
        abort: async () => undefined
      }
    },
    text: async () => new TextDecoder().decode(file.bytes)
  })

  const wrapDirectory = (directory: MemoryDirectory): RecordingStorageDirectory => ({
    getDirectory: async (name, create) => {
      const existing = directory.children.get(name)
      if (existing?.kind === "directory") return wrapDirectory(existing)
      if (!create) throw new DOMException("missing", "NotFoundError")
      const child: MemoryDirectory = { kind: "directory", children: new Map() }
      directory.children.set(name, child)
      return wrapDirectory(child)
    },
    getFile: async (name, create) => {
      const existing = directory.children.get(name)
      if (existing?.kind === "file") return wrapFile(existing)
      if (!create) throw new DOMException("missing", "NotFoundError")
      const child: MemoryFile = { kind: "file", bytes: new Uint8Array() }
      directory.children.set(name, child)
      return wrapFile(child)
    },
    entries: async function* (): AsyncIterable<RecordingStorageDirectoryEntry> {
      for (const [name, node] of directory.children) yield { name, kind: node.kind }
    },
    remove: async (name) => {
      directory.children.delete(name)
    }
  })

  const filesystem: RecordingStorageFilesystem = {
    root: async () => wrapDirectory(root)
  }

  const readBytes = (path: readonly string[]): Uint8Array | null => {
    let node: MemoryNode = root
    for (const part of path) {
      if (node.kind !== "directory") return null
      const child = node.children.get(part)
      if (!child) return null
      node = child
    }
    return node.kind === "file" ? node.bytes : null
  }

  const directoryAt = (path: readonly string[]): MemoryDirectory | null => {
    let node: MemoryNode = root
    for (const part of path) {
      if (node.kind !== "directory") return null
      const child = node.children.get(part)
      if (!child) return null
      node = child
    }
    return node.kind === "directory" ? node : null
  }

  return { filesystem, root, readBytes, directoryAt }
}

describe("recording temp storage", () => {
  test("serializes planar blocks in append order and reports bounded descriptors", async () => {
    const memory = createMemoryFilesystem()
    const storage = createRecordingTempStorage({ filesystem: memory.filesystem, maxBytes: 32, now: () => 100 })
    const session = await storage.createSession({ sessionId: "take-1", sampleRate: 48000, channelCount: 2 })

    const first = session.append([new Float32Array([1, 2]), new Float32Array([3, 4])])
    const second = session.append([new Float32Array([5]), new Float32Array([6])])
    await Promise.all([first, second])
    const descriptor = await session.finalize()

    expect(descriptor).toEqual({
      version: 1,
      sessionId: "take-1",
      format: "planar-float32-blocks",
      sampleRate: 48000,
      channelCount: 2,
      capturedFrames: 3,
      byteLength: 32,
      createdAtMs: 100,
      finalizedAtMs: 100
    })
    const bytes = memory.readBytes(["recording-sessions", "take-1", "capture.pcm"])
    const blocks = bytes ? decodePlanarPcmBlocks(bytes, 2) : []
    expect(blocks.map((block) => ({
      frameCount: block.frameCount,
      channels: block.channels.map((channel) => Array.from(channel))
    }))).toEqual([
      { frameCount: 2, channels: [[1, 2], [3, 4]] },
      { frameCount: 1, channels: [[5], [6]] }
    ])
    expect(await storage.open("take-1")).toEqual(descriptor)
    expect(await session.finalize()).toEqual(descriptor)
  })

  test("rejects duplicate session creation without changing the first session", async () => {
    const memory = createMemoryFilesystem()
    const storage = createRecordingTempStorage({ filesystem: memory.filesystem, now: () => 100 })
    const first = await storage.createSession({ sessionId: "owned", sampleRate: 48000, channelCount: 1 })
    await first.append([new Float32Array([1, 2])])

    await expect(storage.createSession({
      sessionId: "owned",
      sampleRate: 44100,
      channelCount: 2
    })).rejects.toMatchObject({ failure: "session-exists" })

    await first.append([new Float32Array([3])])
    const descriptor = await first.finalize()
    const bytes = memory.readBytes(["recording-sessions", "owned", "capture.pcm"])
    const blocks = bytes ? decodePlanarPcmBlocks(bytes, 1) : []

    expect(descriptor).toMatchObject({
      sampleRate: 48000,
      channelCount: 1,
      capturedFrames: 3
    })
    expect(blocks.map((block) => Array.from(block.channels[0] ?? []))).toEqual([[1, 2], [3]])
  })

  test("a duplicate requester cannot abort or remove another storage owner's session", async () => {
    const memory = createMemoryFilesystem()
    const firstStorage = createRecordingTempStorage({ filesystem: memory.filesystem })
    const duplicateStorage = createRecordingTempStorage({ filesystem: memory.filesystem })
    const first = await firstStorage.createSession({ sessionId: "shared", sampleRate: 48000, channelCount: 1 })
    await first.append([new Float32Array([4])])

    await expect(duplicateStorage.createSession({
      sessionId: "shared",
      sampleRate: 48000,
      channelCount: 1
    })).rejects.toMatchObject({ failure: "session-exists" })

    expect(memory.directoryAt(["recording-sessions"])?.children.has("shared")).toBeTrue()
    await first.append([new Float32Array([5])])
    await first.finalize()
    expect(await firstStorage.open("shared")).not.toBeNull()
  })

  test("rejects blocks beyond the configured byte bound without writing them", async () => {
    const memory = createMemoryFilesystem()
    const storage = createRecordingTempStorage({ filesystem: memory.filesystem, maxBytes: 12 })
    const session = await storage.createSession({ sessionId: "bounded", sampleRate: 44100, channelCount: 1 })
    await session.append([new Float32Array([1, 2])])
    await expect(session.append([new Float32Array([3])])).rejects.toMatchObject({ failure: "capacity-exceeded" })
    expect(await storage.open("bounded")).toBeNull()
    await expect(session.finalize()).rejects.toMatchObject({ failure: "write-failed" })
  })

  test("makes abort idempotent and prevents finalization", async () => {
    const memory = createMemoryFilesystem()
    const storage = createRecordingTempStorage({ filesystem: memory.filesystem })
    const session = await storage.createSession({ sessionId: "cancelled", sampleRate: 48000, channelCount: 1 })
    await session.abort()
    await session.abort()
    expect(await storage.open("cancelled")).toBeNull()
    await expect(session.finalize()).rejects.toBeInstanceOf(RecordingTempStorageError)
  })

  test("surfaces explicit write failures", async () => {
    const memory = createMemoryFilesystem(3)
    const storage = createRecordingTempStorage({ filesystem: memory.filesystem })
    const session = await storage.createSession({ sessionId: "failed", sampleRate: 48000, channelCount: 1 })
    await expect(session.append([new Float32Array([1])])).rejects.toMatchObject({ failure: "quota-exceeded" })
    expect(await storage.open("failed")).toBeNull()
    await expect(session.finalize()).rejects.toMatchObject({ failure: "write-failed" })
  })

  test("removes the session when initial metadata cannot be written", async () => {
    const memory = createMemoryFilesystem(2)
    const storage = createRecordingTempStorage({ filesystem: memory.filesystem })
    await expect(storage.createSession({
      sessionId: "metadata-failed",
      sampleRate: 48000,
      channelCount: 1
    })).rejects.toMatchObject({ failure: "quota-exceeded" })
    expect(await storage.open("metadata-failed")).toBeNull()
    expect(memory.directoryAt(["recording-sessions"])?.children.has("metadata-failed")).toBeFalse()
  })

  test("only cleans stale session directories in the recording scope", async () => {
    const memory = createMemoryFilesystem()
    let now = 0
    const storage = createRecordingTempStorage({ filesystem: memory.filesystem, now: () => now })
    const stale = await storage.createSession({ sessionId: "stale", sampleRate: 48000, channelCount: 1 })
    await stale.finalize()
    now = 24 * 60 * 60 * 1000 + 1
    const fresh = await storage.createSession({ sessionId: "fresh", sampleRate: 48000, channelCount: 1 })
    await fresh.finalize()
    memory.root.children.set("unrelated", { kind: "directory", children: new Map() })

    expect(await storage.cleanupStale()).toBe(1)
    expect(await storage.open("stale")).toBeNull()
    expect(await storage.open("fresh")).not.toBeNull()
    expect(memory.root.children.has("unrelated")).toBeTrue()
  })

  test("reclaims stale malformed or missing descriptors but preserves fresh sessions", async () => {
    const memory = createMemoryFilesystem()
    let now = 0
    const storage = createRecordingTempStorage({ filesystem: memory.filesystem, now: () => now })
    const staleMalformed = await storage.createSession({
      sessionId: "stale-malformed",
      sampleRate: 48000,
      channelCount: 1
    })
    await staleMalformed.finalize()
    const staleMissing = await storage.createSession({
      sessionId: "stale-missing",
      sampleRate: 48000,
      channelCount: 1
    })
    await staleMissing.finalize()

    now = 24 * 60 * 60 * 1000 + 1
    const freshMissing = await storage.createSession({
      sessionId: "fresh-missing",
      sampleRate: 48000,
      channelCount: 1
    })
    memory.directoryAt(["recording-sessions", "stale-malformed"])?.children.set(
      "session.json",
      { kind: "file", bytes: new TextEncoder().encode("{bad") },
    )
    memory.directoryAt(["recording-sessions", "stale-missing"])?.children.delete("session.json")
    memory.directoryAt(["recording-sessions", "fresh-missing"])?.children.delete("session.json")

    expect(await storage.cleanupStale()).toBe(2)
    expect(memory.directoryAt(["recording-sessions"])?.children.has("stale-malformed")).toBeFalse()
    expect(memory.directoryAt(["recording-sessions"])?.children.has("stale-missing")).toBeFalse()
    expect(memory.directoryAt(["recording-sessions"])?.children.has("fresh-missing")).toBeTrue()
    await freshMissing.abort()
  })
})
