import { afterEach, describe, expect, test } from 'bun:test'

import {
  createNativeOfflinePcmSpool,
  NativeOfflinePcmSpoolError,
  type NativeOfflinePcmSpoolDirectory,
  type NativeOfflinePcmSpoolFile,
  type NativeOfflinePcmSpoolFilesystem,
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
    const bytes = state.bytes.subarray(startByte, endByte)
    state.maximumReadBytes = Math.max(state.maximumReadBytes, bytes.byteLength)
    return copyBytes(bytes).buffer
  },
})

const wrapMemoryDirectory = (state: MemoryDirectoryState): NativeOfflinePcmSpoolDirectory => ({
  getDirectory: async (name, create) => {
    const existing = state.directories.get(name)
    if (existing) return wrapMemoryDirectory(existing)
    if (!create) throw new DOMException('Missing directory', 'NotFoundError')
    const created = createDirectoryState()
    state.directories.set(name, created)
    return wrapMemoryDirectory(created)
  },
  getFile: async (name, create) => {
    const existing = state.files.get(name)
    if (existing) return wrapMemoryFile(existing)
    if (!create) throw new DOMException('Missing file', 'NotFoundError')
    const created: MemoryFileState = {
      bytes: new Uint8Array(new ArrayBuffer(0)),
      maximumReadBytes: 0,
    }
    state.files.set(name, created)
    return wrapMemoryFile(created)
  },
  remove: async (name) => {
    if (state.directories.delete(name)) return
    if (state.files.delete(name)) return
    throw new DOMException('Missing entry', 'NotFoundError')
  },
})

const createMemoryFilesystem = () => {
  const root = createDirectoryState()
  const filesystem: NativeOfflinePcmSpoolFilesystem = {
    root: async () => wrapMemoryDirectory(root),
  }
  return { filesystem, root }
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
    const spool = createNativeOfflinePcmSpool({ filesystem: memory.filesystem, replayFrames: 2 })
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
    const session = await createNativeOfflinePcmSpool({ filesystem: memory.filesystem, replayFrames: 2 }).createSession({
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
    const session = await createNativeOfflinePcmSpool({ filesystem: memory.filesystem, replayFrames: 2 }).createSession({
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
    const spool = createNativeOfflinePcmSpool({ filesystem: memory.filesystem })
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
    const spool = createNativeOfflinePcmSpool({ filesystem: memory.filesystem })
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
    const spool = createNativeOfflinePcmSpool({ filesystem: memory.filesystem, replayFrames: 2 })
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
})
