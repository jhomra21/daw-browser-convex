import { afterEach, describe, expect, test } from 'bun:test'

import {
  createNativeOfflinePcmSpool,
  NativeOfflinePcmSpoolError,
  nativeOfflinePcmSpoolRecoveryTtlMs,
  type NativeOfflinePcmSpoolDirectory,
  type NativeOfflinePcmSpoolFile,
  type NativeOfflinePcmSpoolFilesystem,
  type NativeOfflinePcmSpoolLockManager,
} from '~/lib/export/native-offline-pcm-spool'

const originalAudioBuffer = globalThis.AudioBuffer

afterEach(() => {
  Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, value: originalAudioBuffer })
})

class TestAudioBuffer {
  readonly duration: number
  private readonly channels: Float32Array[]

  constructor(readonly options: { numberOfChannels: number; length: number; sampleRate: number }) {
    this.duration = options.length / options.sampleRate
    this.channels = Array.from({ length: options.numberOfChannels }, () => new Float32Array(options.length))
  }

  get numberOfChannels() { return this.options.numberOfChannels }
  get length() { return this.options.length }
  get sampleRate() { return this.options.sampleRate }

  getChannelData(channel: number) {
    const data = this.channels[channel]
    if (!data) throw new Error('Missing channel')
    return data
  }
}

type MemoryFileState = {
  bytes: Uint8Array<ArrayBuffer>
  maximumReadBytes: number
  readFailures: number
}

type MemoryDirectoryState = {
  directories: Map<string, MemoryDirectoryState>
  files: Map<string, MemoryFileState>
}

const createDirectoryState = (): MemoryDirectoryState => ({
  directories: new Map(),
  files: new Map(),
})

const copyBytes = (data: Uint8Array): Uint8Array<ArrayBuffer> => {
  const copy = new Uint8Array(new ArrayBuffer(data.byteLength))
  copy.set(data)
  return copy
}

const wrapMemoryFile = (state: MemoryFileState): NativeOfflinePcmSpoolFile => ({
  createWritable: async () => {
    let closed = false
    return {
      write: async (data) => {
        if (closed) throw new Error('Memory file is closed')
        const next = new Uint8Array(new ArrayBuffer(state.bytes.byteLength + data.byteLength))
        next.set(state.bytes)
        next.set(data, state.bytes.byteLength)
        state.bytes = next
      },
      close: async () => { closed = true },
      abort: async () => { closed = true },
    }
  },
  read: async (startByte, endByte) => {
    if (state.readFailures > 0) {
      state.readFailures -= 1
      throw new Error('Memory file read failed')
    }
    const bytes = state.bytes.subarray(startByte, endByte)
    state.maximumReadBytes = Math.max(state.maximumReadBytes, bytes.byteLength)
    return copyBytes(bytes).buffer
  },
})

const wrapMemoryDirectory = (
  state: MemoryDirectoryState,
  failNextRemove: () => boolean,
): NativeOfflinePcmSpoolDirectory => ({
  getDirectory: async (name, create) => {
    const existing = state.directories.get(name)
    if (existing) return wrapMemoryDirectory(existing, failNextRemove)
    if (!create) throw new DOMException('Missing directory', 'NotFoundError')
    const created = createDirectoryState()
    state.directories.set(name, created)
    return wrapMemoryDirectory(created, failNextRemove)
  },
  getFile: async (name, create) => {
    const existing = state.files.get(name)
    if (existing) return wrapMemoryFile(existing)
    if (!create) throw new DOMException('Missing file', 'NotFoundError')
    const created: MemoryFileState = {
      bytes: new Uint8Array(new ArrayBuffer(0)),
      maximumReadBytes: 0,
      readFailures: 0,
    }
    state.files.set(name, created)
    return wrapMemoryFile(created)
  },
  remove: async (name) => {
    if (failNextRemove()) throw new Error('Memory directory removal failed')
    if (state.directories.delete(name)) return
    if (state.files.delete(name)) return
    throw new DOMException('Missing entry', 'NotFoundError')
  },
  entries: async function* () {
    for (const name of state.directories.keys()) yield { name, kind: 'directory' }
    for (const name of state.files.keys()) yield { name, kind: 'file' }
  },
})

const createMemoryFilesystem = () => {
  const root = createDirectoryState()
  let removeFailures = 0
  const activeLocks = new Set<string>()
  const lockManager: NativeOfflinePcmSpoolLockManager = {
    request: async (name, options, callback) => {
      if (options.ifAvailable && activeLocks.has(name)) return await callback(undefined)
      activeLocks.add(name)
      try {
        return await callback({ name, mode: 'exclusive' })
      } finally {
        activeLocks.delete(name)
      }
    },
  }
  const filesystem: NativeOfflinePcmSpoolFilesystem = {
    root: async () => wrapMemoryDirectory(root, () => {
      if (removeFailures === 0) return false
      removeFailures -= 1
      return true
    }),
  }
  return {
    filesystem,
    lockManager,
    root,
    failNextRemove: () => { removeFailures += 1 },
  }
}

const createSpool = (
  memory: ReturnType<typeof createMemoryFilesystem>,
  options: { replayFrames?: number; now?: () => number; recoveryBatchSize?: number } = {},
) => createNativeOfflinePcmSpool({
  ...options,
  filesystem: memory.filesystem,
  lockManager: memory.lockManager,
})

const seedSession = (
  memory: ReturnType<typeof createMemoryFilesystem>,
  sessionId: string,
  createdAt: number | string,
) => {
  const sessions = createDirectoryState()
  sessions.files.set('metadata.json', {
    bytes: new TextEncoder().encode(JSON.stringify({
      version: 1,
      sessionId,
      createdAt,
    })),
    maximumReadBytes: 0,
    readFailures: 0,
  })
  memory.root.directories.set('native-export-spools', memory.root.directories.get('native-export-spools') ?? createDirectoryState())
  const spoolDirectory = memory.root.directories.get('native-export-spools')
  if (!spoolDirectory) throw new Error('Missing spool directory')
  spoolDirectory.directories.set(sessionId, sessions)
}

const seedSessionWithoutMetadata = (
  memory: ReturnType<typeof createMemoryFilesystem>,
  sessionId: string,
) => {
  memory.root.directories.set('native-export-spools', memory.root.directories.get('native-export-spools') ?? createDirectoryState())
  const spoolDirectory = memory.root.directories.get('native-export-spools')
  if (!spoolDirectory) throw new Error('Missing spool directory')
  spoolDirectory.directories.set(sessionId, createDirectoryState())
}

const chunk = (
  startFrame: number,
  left: readonly number[],
  right: readonly number[] = left,
) => ({
  startFrame,
  frameCount: left.length,
  channelCount: 2,
  planes: [new Float32Array(left), new Float32Array(right)],
})

const collectReplay = async (source: AsyncIterable<AudioBuffer>) => {
  const output: AudioBuffer[] = []
  for await (const buffer of source) output.push(buffer)
  return output
}

describe('native offline PCM spool', () => {
  test('writes contiguous chunks and replays bounded buffers with gain', async () => {
    Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, value: TestAudioBuffer })
    const memory = createMemoryFilesystem()
    const spool = createSpool(memory, { replayFrames: 2 })
    const session = await spool.createSession({
      sessionId: 'render-a',
      sampleRate: 48_000,
      channelCount: 2,
      totalFrames: 5,
    })

    await session.append(chunk(0, [0.25, -0.5, 0.75], [-0.25, 0.5, -0.75]))
    await session.append(chunk(3, [1, -0.125], [-1, 0.125]))
    const descriptor = await session.finalize()

    expect(descriptor.totalFrames).toBe(5)
    expect(descriptor.byteLength).toBe(5 * 2 * Float32Array.BYTES_PER_ELEMENT)
    expect(descriptor.samplePeak).toBe(1)

    const replay = await collectReplay(session.replay({ gain: 0.5 }))
    expect(replay.map((buffer) => buffer.length)).toEqual([2, 2, 1])
    expect(Array.from(replay[0]?.getChannelData(0) ?? [])).toEqual([0.125, -0.25])
    expect(Array.from(replay[0]?.getChannelData(1) ?? [])).toEqual([-0.125, 0.25])
    expect(Array.from(replay[2]?.getChannelData(0) ?? [])).toEqual([-0.0625])
    expect(Array.from(replay[2]?.getChannelData(1) ?? [])).toEqual([0.0625])
  })

  test('never allocates a replay AudioBuffer sized to total logical duration', async () => {
    let maximumLength = 0
    class BoundedAudioBuffer extends TestAudioBuffer {
      constructor(options: { numberOfChannels: number; length: number; sampleRate: number }) {
        if (options.length > 2) throw new Error('duration-sized AudioBuffer allocation')
        super(options)
        maximumLength = Math.max(maximumLength, options.length)
      }
    }
    Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, value: BoundedAudioBuffer })
    const memory = createMemoryFilesystem()
    const session = await createSpool(memory, { replayFrames: 2 }).createSession({
      sessionId: 'render-b',
      sampleRate: 48_000,
      channelCount: 2,
      totalFrames: 6,
    })

    await session.append(chunk(0, [0, 1, 0], [0, -1, 0]))
    await session.append(chunk(3, [0.5, 0, -0.5], [-0.5, 0, 0.5]))
    await session.finalize()
    const replay = await collectReplay(session.replay())

    expect(replay).toHaveLength(3)
    expect(maximumLength).toBe(2)
  })

  test('partial replay reads only requested bounded byte ranges', async () => {
    Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, value: TestAudioBuffer })
    const memory = createMemoryFilesystem()
    const session = await createSpool(memory, { replayFrames: 2 }).createSession({
      sessionId: 'render-c',
      sampleRate: 48_000,
      channelCount: 2,
      totalFrames: 6,
    })

    await session.append(chunk(0, [0, 1, 2], [3, 4, 5]))
    await session.append(chunk(3, [6, 7, 8], [9, 10, 11]))
    await session.finalize()
    const replay = await collectReplay(session.replay({ endFrame: 3 }))

    expect(replay.map((buffer) => buffer.length)).toEqual([2, 1])
    const spoolDirectory = memory.root.directories.get('native-export-spools')
    const sessionDirectory = spoolDirectory?.directories.get('render-c')
    const file = sessionDirectory?.files.get('render.f32')
    expect(file?.maximumReadBytes).toBe(2 * 2 * Float32Array.BYTES_PER_ELEMENT)
  })

  test('rejects noncontiguous chunks and removes the abandoned session', async () => {
    const memory = createMemoryFilesystem()
    const spool = createSpool(memory)
    const session = await spool.createSession({
      sessionId: 'render-d',
      sampleRate: 48_000,
      channelCount: 2,
      totalFrames: 4,
    })

    await session.append(chunk(0, [0, 0]))
    await expect(session.append(chunk(3, [0, 0]))).rejects.toBeInstanceOf(NativeOfflinePcmSpoolError)

    const replacement = await spool.createSession({
      sessionId: 'render-d',
      sampleRate: 48_000,
      channelCount: 2,
      totalFrames: 1,
    })
    await replacement.append(chunk(0, [0]))
    await replacement.finalize()
  })

  test('requires complete output before finalization and cleans the spool', async () => {
    const memory = createMemoryFilesystem()
    const spool = createSpool(memory)
    const session = await spool.createSession({
      sessionId: 'render-e',
      sampleRate: 48_000,
      channelCount: 2,
      totalFrames: 4,
    })

    await session.append(chunk(0, [0, 0]))
    await expect(session.finalize()).rejects.toMatchObject({ failure: 'invalid-chunk' })

    const spoolDirectory = memory.root.directories.get('native-export-spools')
    expect(spoolDirectory?.directories.has('render-e')).toBe(false)
  })

  test('abort removes an open session and replay respects cancellation', async () => {
    Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, value: TestAudioBuffer })
    const memory = createMemoryFilesystem()
    const spool = createSpool(memory, { replayFrames: 2 })
    const openSession = await spool.createSession({
      sessionId: 'render-f',
      sampleRate: 48_000,
      channelCount: 2,
      totalFrames: 2,
    })
    await openSession.abort()
    const spoolDirectory = memory.root.directories.get('native-export-spools')
    expect(spoolDirectory?.directories.has('render-f')).toBe(false)

    const finalized = await spool.createSession({
      sessionId: 'render-g',
      sampleRate: 48_000,
      channelCount: 2,
      totalFrames: 2,
    })
    await finalized.append(chunk(0, [0, 0]))
    await finalized.finalize()
    const controller = new AbortController()
    controller.abort()
    const iterator = finalized.replay({ signal: controller.signal })
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('retains removable state when cleanup fails and allows a later retry', async () => {
    const memory = createMemoryFilesystem()
    const session = await createSpool(memory).createSession({
      sessionId: 'render-h',
      sampleRate: 48_000,
      channelCount: 2,
      totalFrames: 1,
    })
    await session.append(chunk(0, [0]))
    await session.finalize()

    memory.failNextRemove()
    await expect(session.remove()).rejects.toThrow('Memory directory removal failed')
    const spoolDirectory = memory.root.directories.get('native-export-spools')
    expect(spoolDirectory?.directories.has('render-h')).toBe(true)

    await session.remove()
    expect(spoolDirectory?.directories.has('render-h')).toBe(false)
  })

  test('does not delete an old active foreign session', async () => {
    const memory = createMemoryFilesystem()
    const oldNow = Date.now() - nativeOfflinePcmSpoolRecoveryTtlMs - 1
    const active = createSpool(memory, { now: () => oldNow }).createSession({
      sessionId: 'foreign-active',
      sampleRate: 48_000,
      channelCount: 2,
      totalFrames: 1,
    })
    const activeSession = await active
    const replacement = await createSpool(memory, { now: () => Date.now() }).createSession({
      sessionId: 'replacement',
      sampleRate: 48_000,
      channelCount: 2,
      totalFrames: 1,
    })

    expect(memory.root.directories.get('native-export-spools')?.directories.has('foreign-active')).toBe(true)
    await activeSession.abort()
    await replacement.abort()
  })

  test('deletes crashed old sessions and retains fresh sessions', async () => {
    const memory = createMemoryFilesystem()
    const now = 10_000_000
    seedSession(memory, 'crashed-old', now - nativeOfflinePcmSpoolRecoveryTtlMs - 1)
    seedSession(memory, 'fresh', now)

    const session = await createSpool(memory, { now: () => now }).createSession({
      sessionId: 'new-session',
      sampleRate: 48_000,
      channelCount: 2,
      totalFrames: 1,
    })

    const directories = memory.root.directories.get('native-export-spools')?.directories
    expect(directories?.has('crashed-old')).toBe(false)
    expect(directories?.has('fresh')).toBe(true)
    await session.abort()
  })

  test('progresses recovery in bounded batches across export starts', async () => {
    const memory = createMemoryFilesystem()
    const now = 20_000_000
    for (const sessionId of ['old-a', 'old-b', 'old-c']) {
      seedSession(memory, sessionId, now - nativeOfflinePcmSpoolRecoveryTtlMs - 1)
    }

    for (const sessionId of ['new-a', 'new-b', 'new-c']) {
      const session = await createSpool(memory, {
        now: () => now,
        recoveryBatchSize: 1,
      }).createSession({
        sessionId,
        sampleRate: 48_000,
        channelCount: 2,
        totalFrames: 1,
      })
      await session.abort()
    }

    const directories = memory.root.directories.get('native-export-spools')?.directories
    expect(directories?.has('old-a')).toBe(false)
    expect(directories?.has('old-b')).toBe(false)
    expect(directories?.has('old-c')).toBe(false)
  })

  test('wraps bounded recovery after fresh entries to reach a later stale session', async () => {
    const memory = createMemoryFilesystem()
    const now = 25_000_000
    for (let index = 0; index < 8; index += 1) seedSession(memory, `fresh-${index}`, now)
    seedSession(memory, 'stale-ninth', now - nativeOfflinePcmSpoolRecoveryTtlMs - 1)

    let session = await createSpool(memory, { now: () => now }).createSession({
      sessionId: 'first-pass',
      sampleRate: 48_000,
      channelCount: 2,
      totalFrames: 1,
    })
    await session.abort()
    const directories = memory.root.directories.get('native-export-spools')?.directories
    expect(directories?.has('stale-ninth')).toBe(true)

    session = await createSpool(memory, { now: () => now }).createSession({
      sessionId: 'second-pass',
      sampleRate: 48_000,
      channelCount: 2,
      totalFrames: 1,
    })
    await session.abort()
    expect(directories?.has('stale-ninth')).toBe(false)
  })

  test('removes abandoned sessions with missing, malformed, or unreadable metadata', async () => {
    const memory = createMemoryFilesystem()
    const now = 30_000_000
    seedSessionWithoutMetadata(memory, 'missing')
    seedSession(memory, 'malformed', 'not-a-timestamp')
    seedSession(memory, 'unreadable', now)
    const spoolDirectory = memory.root.directories.get('native-export-spools')
    const unreadableMetadata = spoolDirectory?.directories.get('unreadable')?.files.get('metadata.json')
    if (!unreadableMetadata) throw new Error('Missing seeded metadata')
    unreadableMetadata.readFailures = 1

    const session = await createSpool(memory, { now: () => now, recoveryBatchSize: 3 }).createSession({
      sessionId: 'first',
      sampleRate: 48_000,
      channelCount: 2,
      totalFrames: 1,
    })
    await session.abort()
    expect(spoolDirectory?.directories.has('missing')).toBe(false)
    expect(spoolDirectory?.directories.has('malformed')).toBe(false)
    expect(spoolDirectory?.directories.has('unreadable')).toBe(false)
  })

  test('retains cleanup failures for retry while advancing the recovery cursor', async () => {
    const memory = createMemoryFilesystem()
    const now = 35_000_000
    seedSession(memory, 'retryable', now - nativeOfflinePcmSpoolRecoveryTtlMs - 1)
    seedSession(memory, 'later', now - nativeOfflinePcmSpoolRecoveryTtlMs - 1)
    memory.failNextRemove()

    let session = await createSpool(memory, { now: () => now, recoveryBatchSize: 1 }).createSession({
      sessionId: 'first',
      sampleRate: 48_000,
      channelCount: 2,
      totalFrames: 1,
    })
    await session.abort()
    const directories = memory.root.directories.get('native-export-spools')?.directories
    expect(directories?.has('retryable')).toBe(true)

    session = await createSpool(memory, { now: () => now, recoveryBatchSize: 1 }).createSession({
      sessionId: 'second',
      sampleRate: 48_000,
      channelCount: 2,
      totalFrames: 1,
    })
    await session.abort()
    expect(directories?.has('later')).toBe(false)
    expect(directories?.has('retryable')).toBe(true)

    session = await createSpool(memory, { now: () => now, recoveryBatchSize: 1 }).createSession({
      sessionId: 'third',
      sampleRate: 48_000,
      channelCount: 2,
      totalFrames: 1,
    })
    await session.abort()
    expect(directories?.has('retryable')).toBe(false)
  })

  test('fails closed when the lock manager is unsupported', async () => {
    const memory = createMemoryFilesystem()
    const unsupported: NativeOfflinePcmSpoolLockManager = {
      request: async () => {
        throw new NativeOfflinePcmSpoolError('unsupported', 'Web Locks are unavailable.')
      },
    }

    await expect(createNativeOfflinePcmSpool({
      filesystem: memory.filesystem,
      lockManager: unsupported,
    }).createSession({
      sessionId: 'unsupported',
      sampleRate: 48_000,
      channelCount: 2,
      totalFrames: 1,
    })).rejects.toMatchObject({ failure: 'unsupported' })
  })
})
