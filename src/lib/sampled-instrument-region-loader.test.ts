import { expect, test } from 'bun:test'
import { loadSampledInstrumentRegion } from './sampled-instrument-region-loader'
import type { DecodedAudioPage } from '@daw-browser/audio-engine/media-pages'

class TestAudioBuffer implements AudioBuffer {
  readonly duration: number
  readonly length: number
  readonly numberOfChannels: number
  readonly sampleRate: number
  private readonly channels: Float32Array<ArrayBuffer>[]

  constructor(channels: number, length: number, sampleRate: number) {
    this.duration = length / sampleRate
    this.length = length
    this.numberOfChannels = channels
    this.sampleRate = sampleRate
    this.channels = Array.from(
      { length: channels },
      () => new Float32Array(new ArrayBuffer(length * Float32Array.BYTES_PER_ELEMENT)),
    )
  }

  copyFromChannel(destination: Float32Array<ArrayBuffer>, channelNumber: number): void {
    destination.set(this.channels[channelNumber]?.subarray(0, destination.length))
  }

  copyToChannel(source: Float32Array<ArrayBuffer>, channelNumber: number): void {
    this.channels[channelNumber]?.set(source)
  }

  getChannelData(channelNumber: number): Float32Array<ArrayBuffer> {
    const channel = this.channels[channelNumber]
    if (!channel) throw new Error('missing channel')
    return channel
  }
}

const input = {
  assetKey: 'asset-a',
  url: '/sample.wav',
  sourceKind: 'upload' as const,
  source: { durationSec: 3, sampleRate: 4, channelCount: 2 },
}

const page = (startFrame: number, values: readonly number[]): DecodedAudioPage => ({
  startFrame,
  frameCount: values.length,
  sampleRate: 4,
  channelCount: 2,
  planes: [Float32Array.from(values), Float32Array.from(values, (value) => value * 10)],
})

const decoder = (pages: readonly DecodedAudioPage[]) => async function* (): AsyncGenerator<DecodedAudioPage> {
  for (const value of pages) yield value
}

test('allocates and returns only the requested regional PCM', async () => {
  let allocations = 0
  const result = await loadSampledInstrumentRegion(
    input,
    { sourceStartFrame: 4, sourceEndFrame: 8 },
    32,
    undefined,
    {
      decodePages: decoder([page(4, [1, 2]), page(6, [3, 4])]),
      createBuffer: (channels, frames, rate) => {
        allocations += 1
        return new TestAudioBuffer(channels, frames, rate)
      },
    },
  )
  expect(allocations).toBe(1)
  expect(result?.sourceStartFrame).toBe(4)
  expect(result?.buffer.length).toBe(4)
  expect([...result?.buffer.getChannelData(0) ?? []]).toEqual([1, 2, 3, 4])
  expect([...result?.buffer.getChannelData(1) ?? []]).toEqual([10, 20, 30, 40])
})

test('passes exact integer frame bounds through to page decoding', async () => {
  const requests: Array<{ startSec?: number; endSec?: number; startFrame?: number; endFrame?: number }> = []
  const result = await loadSampledInstrumentRegion(
    {
      ...input,
      source: { durationSec: 1, sampleRate: 48_000, channelCount: 1 },
    },
    { sourceStartFrame: 7, sourceEndFrame: 19 },
    48,
    undefined,
    {
      decodePages: async function* (_source, options) {
        requests.push({
          startSec: options?.startSec,
          endSec: options?.endSec,
          startFrame: options?.startFrame,
          endFrame: options?.endFrame,
        })
        yield {
          startFrame: 7,
          frameCount: 12,
          sampleRate: 48_000,
          channelCount: 1,
          planes: [new Float32Array(12)],
        }
      },
      createBuffer: (_channels, frames, sampleRate) => new TestAudioBuffer(1, frames, sampleRate),
    },
  )
  expect(result?.buffer.length).toBe(12)
  expect(requests).toEqual([{
    startSec: 7 / 48_000,
    endSec: 19 / 48_000,
    startFrame: 7,
    endFrame: 19,
  }])
})

test('rejects budget before reading or allocating', async () => {
  let reads = 0
  let allocations = 0
  await expect(loadSampledInstrumentRegion(
    input,
    { sourceStartFrame: 0, sourceEndFrame: 2 },
    15,
    undefined,
    {
      decodePages: async function* () {
        reads += 1
        if (reads < 0) yield page(0, [])
      },
      createBuffer: () => {
        allocations += 1
        return new TestAudioBuffer(2, 2, 4)
      },
    },
  )).rejects.toThrow('byte limit')
  expect(reads).toBe(0)
  expect(allocations).toBe(0)
})

test('rejects gaps, overlaps, and extra frames', async () => {
  await expect(loadSampledInstrumentRegion(
    input,
    { sourceStartFrame: 0, sourceEndFrame: 4 },
    128,
    undefined,
    { decodePages: decoder([page(0, [1]), page(2, [2, 3])]) },
  )).rejects.toThrow()
  await expect(loadSampledInstrumentRegion(
    input,
    { sourceStartFrame: 0, sourceEndFrame: 4 },
    128,
    undefined,
    { decodePages: decoder([page(0, [1, 2]), page(1, [3, 4])]) },
  )).rejects.toThrow()
})

test('cancels before source access', async () => {
  const controller = new AbortController()
  controller.abort()
  let reads = 0
  await expect(loadSampledInstrumentRegion(
    input,
    { sourceStartFrame: 0, sourceEndFrame: 2 },
    128,
    controller.signal,
    {
      resolveUrl: () => {
        reads += 1
        return '/sample.wav'
      },
    },
  )).rejects.toBeDefined()
  expect(reads).toBe(0)
})
