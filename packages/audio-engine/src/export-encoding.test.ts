import { afterEach, describe, expect, test } from 'bun:test'
import type { StreamTargetChunk } from 'mediabunny'

import {
  encodeAudioBuffer,
  encodeAudioChunks,
  type EncodeAudioBufferOptions,
} from './export-encoding'

const originalAudioBuffer = globalThis.AudioBuffer

afterEach(() => {
  Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, value: originalAudioBuffer })
})

class TestAudioBuffer {
  readonly numberOfChannels: number
  readonly length: number
  readonly sampleRate: number
  readonly duration: number
  private readonly channels: Float32Array<ArrayBuffer>[]

  constructor(options: { numberOfChannels: number; length: number; sampleRate: number }) {
    this.numberOfChannels = options.numberOfChannels
    this.length = options.length
    this.sampleRate = options.sampleRate
    this.duration = options.length / options.sampleRate
    this.channels = Array.from({ length: options.numberOfChannels }, () => new Float32Array(options.length))
  }

  getChannelData(channel: number): Float32Array<ArrayBuffer> {
    const data = this.channels[channel]
    if (!data) throw new Error('Missing channel')
    return data
  }

  copyFromChannel(destination: Float32Array, channel: number, startInChannel = 0) {
    destination.set(this.getChannelData(channel).subarray(startInChannel, startInChannel + destination.length))
  }

  copyToChannel(source: Float32Array, channel: number, startInChannel = 0) {
    this.getChannelData(channel).set(source, startInChannel)
  }
}

const installTestAudioBuffer = () => {
  Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, value: TestAudioBuffer })
}

const audioBuffer = (samples: readonly number[], sampleRate = 48_000): TestAudioBuffer => {
  const buffer = new TestAudioBuffer({ numberOfChannels: 1, length: samples.length, sampleRate })
  buffer.getChannelData(0).set(samples)
  return buffer
}

const blobBytes = async (blob: Blob | undefined) => {
  if (!blob) throw new Error('Expected a buffer-target Blob.')
  return new Uint8Array(await blob.arrayBuffer())
}

describe('chunked export encoding', () => {
  test('encodes bounded chunks as the same continuous WAV track as one AudioBuffer', async () => {
    installTestAudioBuffer()
    const first = audioBuffer([0.1, -0.2, 0.3])
    const second = audioBuffer([-0.4, 0.5, -0.6])
    const combined = audioBuffer([0.1, -0.2, 0.3, -0.4, 0.5, -0.6])
    const options: EncodeAudioBufferOptions = {
      format: 'wav',
      wav: { codec: 'pcm-s16', dither: 'none' },
    }

    const streamed = await encodeAudioChunks([first, second], options)
    const contiguous = await encodeAudioBuffer(combined, options)

    expect(streamed.durationSec).toBe(6 / 48_000)
    expect(streamed.sampleRate).toBe(48_000)
    expect(await blobBytes(streamed.blob)).toEqual(await blobBytes(contiguous.blob))
  })

  test('keeps WAV dither state continuous across chunk boundaries and channels', async () => {
    installTestAudioBuffer()
    const first = new TestAudioBuffer({ numberOfChannels: 2, length: 3, sampleRate: 48_000 })
    const second = new TestAudioBuffer({ numberOfChannels: 2, length: 2, sampleRate: 48_000 })
    const combined = new TestAudioBuffer({ numberOfChannels: 2, length: 5, sampleRate: 48_000 })
    first.getChannelData(0).set([0.1, -0.2, 0.3])
    first.getChannelData(1).set([-0.4, 0.5, -0.6])
    second.getChannelData(0).set([0.7, -0.8])
    second.getChannelData(1).set([-0.9, 0.25])
    combined.getChannelData(0).set([0.1, -0.2, 0.3, 0.7, -0.8])
    combined.getChannelData(1).set([-0.4, 0.5, -0.6, -0.9, 0.25])
    const options: EncodeAudioBufferOptions = {
      format: 'wav',
      wav: { codec: 'pcm-s16', dither: 'tpdf' },
      ditherSeed: 19,
    }

    const streamed = await encodeAudioChunks([first, second], options)
    const contiguous = await encodeAudioBuffer(combined, options)

    expect(await blobBytes(streamed.blob)).toEqual(await blobBytes(contiguous.blob))
  })

  test('never allocates an AudioBuffer sized to the total logical stream', async () => {
    let maximumConstructedLength = 0
    class BoundedAudioBuffer extends TestAudioBuffer {
      constructor(options: { numberOfChannels: number; length: number; sampleRate: number }) {
        if (options.length > 8) throw new Error('duration-sized AudioBuffer allocation')
        super(options)
        maximumConstructedLength = Math.max(maximumConstructedLength, options.length)
      }
    }
    Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, value: BoundedAudioBuffer })

    const makeChunk = () => {
      const chunk = new BoundedAudioBuffer({ numberOfChannels: 1, length: 8, sampleRate: 48_000 })
      chunk.getChannelData(0).fill(0.25)
      return chunk
    }
    const result = await encodeAudioChunks([makeChunk(), makeChunk(), makeChunk()], {
      format: 'wav',
      wav: { codec: 'pcm-s16', dither: 'none' },
    })

    expect(result.durationSec).toBe(24 / 48_000)
    expect(maximumConstructedLength).toBe(8)
  })

  test('rejects metadata changes between chunks', async () => {
    installTestAudioBuffer()
    await expect(encodeAudioChunks([
      audioBuffer([0.1, 0.2], 48_000),
      audioBuffer([0.3, 0.4], 44_100),
    ], {
      format: 'wav',
      wav: { codec: 'pcm-f32', dither: 'none' },
    })).rejects.toThrow('sample rate changed')
  })

  test('rejects channel-count changes between chunks', async () => {
    installTestAudioBuffer()
    const stereo = new TestAudioBuffer({ numberOfChannels: 2, length: 2, sampleRate: 48_000 })

    await expect(encodeAudioChunks([
      audioBuffer([0.1, 0.2]),
      stereo,
    ], {
      format: 'wav',
      wav: { codec: 'pcm-f32', dither: 'none' },
    })).rejects.toThrow('channel count changed')
  })

  test('rejects an empty iterable explicitly', async () => {
    await expect(encodeAudioChunks([], {
      format: 'wav',
      wav: { codec: 'pcm-f32', dither: 'none' },
    })).rejects.toThrow('no audio frames')
  })

  test('rejects zero-length chunks explicitly', async () => {
    installTestAudioBuffer()
    await expect(encodeAudioChunks([
      new TestAudioBuffer({ numberOfChannels: 1, length: 0, sampleRate: 48_000 }),
    ], {
      format: 'wav',
      wav: { codec: 'pcm-f32', dither: 'none' },
    })).rejects.toThrow('metadata is invalid')
  })

  test('accepts an async iterable and preserves chunk order', async () => {
    installTestAudioBuffer()
    const first = audioBuffer([0.1, -0.2])
    const second = audioBuffer([0.3, -0.4])
    const combined = audioBuffer([0.1, -0.2, 0.3, -0.4])
    const options: EncodeAudioBufferOptions = {
      format: 'wav',
      wav: { codec: 'pcm-s16', dither: 'none' },
    }
    async function* chunks() {
      yield first
      await Promise.resolve()
      yield second
    }

    const streamed = await encodeAudioChunks(chunks(), options)
    const contiguous = await encodeAudioBuffer(combined, options)

    expect(await blobBytes(streamed.blob)).toEqual(await blobBytes(contiguous.blob))
  })

  test('aborts between chunks and invokes the stream abort hook', async () => {
    installTestAudioBuffer()
    const controller = new AbortController()
    let aborted = false
    let yielded = 0
    const writable = new WritableStream<StreamTargetChunk>({
      write() {},
    })
    async function* chunks() {
      yielded += 1
      yield audioBuffer([0.1, -0.2])
      controller.abort()
      yielded += 1
      yield audioBuffer([0.3, -0.4])
    }

    await expect(encodeAudioChunks(chunks(), {
      format: 'wav',
      wav: { codec: 'pcm-f32', dither: 'none' },
      signal: controller.signal,
      target: {
        mode: 'stream',
        writable,
        abort: async () => {
          aborted = true
        },
      },
    })).rejects.toThrow()
    expect(aborted).toBe(true)
    expect(yielded).toBe(2)
  })

  test('writes incrementally to a stream target and closes on success', async () => {
    installTestAudioBuffer()
    const writes: StreamTargetChunk[] = []
    const positions: number[] = []
    let writesBeforeFinalChunk = 0
    let chunkIndex = 0
    const progress: number[] = []
    const writable = new WritableStream<StreamTargetChunk>({
      write(chunk) {
        writes.push(chunk)
        positions.push(chunk.position)
      },
    })
    const makeLargeChunk = () => new TestAudioBuffer({
      numberOfChannels: 1,
      length: 1_000_000,
      sampleRate: 48_000,
    })
    async function* chunks() {
      for (let index = 0; index < 6; index += 1) {
        chunkIndex = index
        yield makeLargeChunk()
        await Promise.resolve()
        if (index === 4) writesBeforeFinalChunk = writes.length
      }
    }
    let closed = false

    const result = await encodeAudioChunks(chunks(), {
      format: 'wav',
      wav: { codec: 'pcm-f32', dither: 'none' },
      onWrite: (sizeBytes) => progress.push(sizeBytes),
      target: {
        mode: 'stream',
        writable,
        close: async () => {
          closed = true
        },
      },
    })

    expect(chunkIndex).toBe(5)
    expect(writesBeforeFinalChunk).toBeGreaterThan(0)
    expect(writes.length).toBeGreaterThan(writesBeforeFinalChunk)
    expect(closed).toBe(true)
    expect(result.blob).toBeUndefined()
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.every((size, index) => index === 0 || size >= (progress[index - 1] ?? 0))).toBe(true)
    expect(positions.every((position, index) => index === 0 || position >= (positions[index - 1] ?? 0))).toBe(true)
  })

  test('waits for stream backpressure before completing', async () => {
    installTestAudioBuffer()
    let resolveWriteStarted: (() => void) | undefined
    let releaseFirstWrite: (() => void) | undefined
    const writeStarted = new Promise<void>((resolve) => {
      resolveWriteStarted = resolve
    })
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })
    let writeCount = 0
    const writable = new WritableStream<StreamTargetChunk>({
      write() {
        writeCount += 1
        if (writeCount === 1) {
          resolveWriteStarted?.()
          return firstWrite
        }
      },
    })
    const makeLargeChunk = () => new TestAudioBuffer({
      numberOfChannels: 1,
      length: 1_000_000,
      sampleRate: 48_000,
    })
    async function* chunks() {
      for (let index = 0; index < 6; index += 1) yield makeLargeChunk()
    }
    let settled = false
    const encoding = encodeAudioChunks(chunks(), {
      format: 'wav',
      wav: { codec: 'pcm-f32', dither: 'none' },
      target: { mode: 'stream', writable },
    }).then(() => {
      settled = true
    })

    await writeStarted
    await Promise.resolve()
    expect(settled).toBe(false)
    releaseFirstWrite?.()
    await encoding
    expect(writeCount).toBeGreaterThan(0)
  })

  test('rejects malformed channel data explicitly', async () => {
    installTestAudioBuffer()
    class MalformedAudioBuffer extends TestAudioBuffer {
      override getChannelData(_channel: number): Float32Array<ArrayBuffer> {
        return new Float32Array(0)
      }
    }

    await expect(encodeAudioChunks([
      new MalformedAudioBuffer({ numberOfChannels: 1, length: 2, sampleRate: 48_000 }),
    ], {
      format: 'wav',
      wav: { codec: 'pcm-f32', dither: 'none' },
    })).rejects.toThrow('channel data is invalid')
  })

  test('invokes the stream abort hook on an encoding failure', async () => {
    installTestAudioBuffer()
    let aborted = false
    const writable = new WritableStream<StreamTargetChunk>({
      write() {},
    })

    await expect(encodeAudioChunks([
      audioBuffer([0.1, -0.2]),
      new TestAudioBuffer({ numberOfChannels: 2, length: 2, sampleRate: 48_000 }),
    ], {
      format: 'wav',
      wav: { codec: 'pcm-f32', dither: 'none' },
      target: {
        mode: 'stream',
        writable,
        abort: async () => {
          aborted = true
        },
      },
    })).rejects.toThrow('channel count changed')
    expect(aborted).toBe(true)
  })
})
