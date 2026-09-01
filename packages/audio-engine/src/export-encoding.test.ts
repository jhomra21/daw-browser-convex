import { afterEach, describe, expect, test } from 'bun:test'

import { encodeAudioBuffer, encodeAudioChunks } from './export-encoding'

const originalAudioBuffer = globalThis.AudioBuffer

afterEach(() => {
  Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, value: originalAudioBuffer })
})

class TestAudioBuffer {
  readonly numberOfChannels: number
  readonly length: number
  readonly sampleRate: number
  readonly duration: number
  private readonly channels: Float32Array[]

  constructor(options: { numberOfChannels: number; length: number; sampleRate: number }) {
    this.numberOfChannels = options.numberOfChannels
    this.length = options.length
    this.sampleRate = options.sampleRate
    this.duration = options.length / options.sampleRate
    this.channels = Array.from({ length: options.numberOfChannels }, () => new Float32Array(options.length))
  }

  getChannelData(channel: number) {
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

const audioBuffer = (samples: readonly number[], sampleRate = 48_000) => {
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
    const options = {
      format: 'wav' as const,
      wav: { codec: 'pcm-s16' as const, dither: 'none' as const },
    }

    const streamed = await encodeAudioChunks([first, second], options)
    const contiguous = await encodeAudioBuffer(combined, options)

    expect(streamed.durationSec).toBe(6 / 48_000)
    expect(streamed.sampleRate).toBe(48_000)
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
})
