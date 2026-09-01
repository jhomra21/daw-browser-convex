import { afterEach, describe, expect, test } from 'bun:test'

import { limitTruePeakInPlace } from './export-fidelity'
import { createStreamingTruePeakLimiter } from './streaming-true-peak-limiter'
import { scanTruePeak } from './true-peak-scanner'

const originalAudioBuffer = globalThis.AudioBuffer

afterEach(() => {
  Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, value: originalAudioBuffer })
})

class TestAudioBuffer implements AudioBuffer {
  readonly duration: number
  readonly length: number
  readonly numberOfChannels: number
  readonly sampleRate: number
  private readonly channels: Float32Array[]

  constructor(options: AudioBufferOptions) {
    this.length = options.length
    this.numberOfChannels = options.numberOfChannels ?? 1
    this.sampleRate = options.sampleRate
    this.duration = this.length / this.sampleRate
    this.channels = Array.from({ length: this.numberOfChannels }, () => new Float32Array(this.length))
  }

  getChannelData(channel: number) {
    const data = this.channels[channel]
    if (!data) throw new Error('Missing channel')
    return data
  }

  copyFromChannel(destination: Float32Array, channelNumber: number, bufferOffset = 0) {
    destination.set(this.getChannelData(channelNumber).subarray(bufferOffset, bufferOffset + destination.length))
  }

  copyToChannel(source: Float32Array, channelNumber: number, bufferOffset = 0) {
    this.getChannelData(channelNumber).set(source, bufferOffset)
  }
}

const createProgram = () => {
  const sampleRate = 48_000
  const length = 8_192
  const buffer = new TestAudioBuffer({ numberOfChannels: 2, length, sampleRate })
  const left = buffer.getChannelData(0)
  const right = buffer.getChannelData(1)
  for (let frame = 0; frame < length; frame += 1) {
    left[frame] = 0.86 * Math.sin(2 * Math.PI * 19_000 * frame / sampleRate)
    right[frame] = 0.18 * Math.sin(2 * Math.PI * 700 * frame / sampleRate)
  }
  left[1_000] = 1
  right[4_097] = -0.97
  return buffer
}

const cloneBuffer = (source: TestAudioBuffer) => {
  const output = new TestAudioBuffer({
    numberOfChannels: source.numberOfChannels,
    length: source.length,
    sampleRate: source.sampleRate,
  })
  for (let channel = 0; channel < source.numberOfChannels; channel += 1) {
    output.getChannelData(channel).set(source.getChannelData(channel))
  }
  return output
}

const sliceBuffer = (buffer: TestAudioBuffer, startFrame: number, endFrame: number) => {
  const output = new TestAudioBuffer({
    numberOfChannels: buffer.numberOfChannels,
    length: endFrame - startFrame,
    sampleRate: buffer.sampleRate,
  })
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    output.getChannelData(channel).set(buffer.getChannelData(channel).subarray(startFrame, endFrame))
  }
  return output
}

const chunks = (buffer: TestAudioBuffer) => {
  const boundaries = [0, 1, 229, 997, 1_001, 2_043, 4_096, 4_100, 7_777, buffer.length]
  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1]
    if (end === undefined) throw new Error('Missing limiter split boundary')
    return sliceBuffer(buffer, start, end)
  })
}

const collect = async (source: AsyncIterable<AudioBuffer>, sampleRate: number, channelCount: number) => {
  const blocks: AudioBuffer[] = []
  for await (const block of source) blocks.push(block)
  const length = blocks.reduce((sum, block) => sum + block.length, 0)
  const output = new TestAudioBuffer({ numberOfChannels: channelCount, length, sampleRate })
  let offset = 0
  for (const block of blocks) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      output.getChannelData(channel).set(block.getChannelData(channel), offset)
    }
    offset += block.length
  }
  return output
}

describe('streaming true-peak limiter', () => {
  test('matches the whole-buffer linked lookahead limiter across arbitrary chunk boundaries', async () => {
    Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, value: TestAudioBuffer })
    const source = createProgram()
    const expected = cloneBuffer(source)
    const expectedLimited = limitTruePeakInPlace(expected, -3)

    const limiter = createStreamingTruePeakLimiter({
      sampleRate: source.sampleRate,
      channelCount: source.numberOfChannels,
      ceilingDbtp: -3,
      outputChunkFrames: 257,
    })
    const actual = await collect(
      limiter.transform(chunks(source)),
      source.sampleRate,
      source.numberOfChannels,
    )

    expect(actual.length).toBe(expected.length)
    expect(limiter.wasLimited()).toBe(expectedLimited)
    for (let channel = 0; channel < source.numberOfChannels; channel += 1) {
      const actualSamples = actual.getChannelData(channel)
      const expectedSamples = expected.getChannelData(channel)
      for (let frame = 0; frame < source.length; frame += 1) {
        expect(actualSamples[frame]).toBeCloseTo(expectedSamples[frame] ?? 0, 7)
      }
    }
    expect(scanTruePeak(actual).peakDbtp).toBeLessThanOrEqual(-2.9)
  })

  test('preserves linked stereo release behavior', async () => {
    Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, value: TestAudioBuffer })
    const source = new TestAudioBuffer({ numberOfChannels: 2, length: 8_192, sampleRate: 48_000 })
    source.getChannelData(0).fill(0.2)
    source.getChannelData(1).fill(0.2)
    source.getChannelData(0)[1_000] = 1
    const limiter = createStreamingTruePeakLimiter({
      sampleRate: 48_000,
      channelCount: 2,
      ceilingDbtp: -3,
      outputChunkFrames: 511,
    })
    const output = await collect(limiter.transform(chunks(source)), 48_000, 2)

    expect(output.getChannelData(1)[0]).toBeCloseTo(0.2, 6)
    expect(output.getChannelData(1)[1_000]).toBeLessThan(0.2)
    expect(output.getChannelData(1).at(-1) ?? 0).toBeGreaterThan(output.getChannelData(1)[1_000] ?? 0)
  })

  test('keeps output allocations bounded while logical input spans many blocks', async () => {
    let maximumConstructedLength = 0
    class BoundedAudioBuffer extends TestAudioBuffer {
      constructor(options: AudioBufferOptions) {
        if (options.length > 64) throw new Error('duration-sized limiter output allocation')
        super(options)
        maximumConstructedLength = Math.max(maximumConstructedLength, options.length)
      }
    }
    Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, value: BoundedAudioBuffer })
    const limiter = createStreamingTruePeakLimiter({
      sampleRate: 8_000,
      channelCount: 1,
      ceilingDbtp: -1,
      outputChunkFrames: 64,
    })
    async function* source() {
      for (let block = 0; block < 128; block += 1) {
        const value = new BoundedAudioBuffer({ numberOfChannels: 1, length: 64, sampleRate: 8_000 })
        value.getChannelData(0).fill(block === 32 ? 1 : 0.1)
        yield value
      }
    }
    let totalFrames = 0
    for await (const output of limiter.transform(source())) totalFrames += output.length

    expect(totalFrames).toBe(128 * 64)
    expect(maximumConstructedLength).toBe(64)
  })

  test('respects cancellation and rejects metadata changes', async () => {
    Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, value: TestAudioBuffer })
    const limiter = createStreamingTruePeakLimiter({
      sampleRate: 48_000,
      channelCount: 1,
      ceilingDbtp: -1,
    })
    const controller = new AbortController()
    controller.abort()
    const canceled = limiter.transform([
      new TestAudioBuffer({ numberOfChannels: 1, length: 4, sampleRate: 48_000 }),
    ], controller.signal)
    await expect(canceled.next()).rejects.toMatchObject({ name: 'AbortError' })

    const mismatchLimiter = createStreamingTruePeakLimiter({
      sampleRate: 48_000,
      channelCount: 1,
      ceilingDbtp: -1,
    })
    const mismatch = mismatchLimiter.transform([
      new TestAudioBuffer({ numberOfChannels: 1, length: 4, sampleRate: 44_100 }),
    ])
    await expect(mismatch.next()).rejects.toThrow('metadata is invalid')
  })
})
