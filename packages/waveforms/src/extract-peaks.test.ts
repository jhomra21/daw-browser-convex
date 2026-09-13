import { describe, expect, test } from 'bun:test'
import type { AudioPcmSourceDescriptor, DecodedAudioPage } from '@daw-browser/audio-engine/media-pages'
import { decodePeakByte, extractPeakAsset, getPeakChunkRecord } from './extract-peaks'

function createSource(input: {
  durationSec: number
  sampleRate: number
  channelCount: number
  page: DecodedAudioPage
}): AudioPcmSourceDescriptor {
  return {
    identity: 'test-source',
    durationSec: input.durationSec,
    frameCount: Math.round(input.durationSec * input.sampleRate),
    sampleRate: input.sampleRate,
    channelCount: input.channelCount,
    readPages: async function* (options = {}) {
      options.signal?.throwIfAborted()
      yield input.page
    },
  }
}

describe('bounded peak extraction', () => {
  test('stores signed min/max independently for a stereo impulse and polarity fixture', async () => {
    const source = createSource({
      durationSec: 1,
      sampleRate: 8,
      channelCount: 2,
      page: {
        startFrame: 0,
        frameCount: 8,
        sampleRate: 8,
        channelCount: 2,
        planes: [
          new Float32Array([1, 0, 0, 0, -1, 0, 0, 0]),
          new Float32Array([0, -1, 0, 0, 0, 1, 0, 0]),
        ],
      },
    })
    let high: readonly Uint8Array[] | undefined
    const record = await extractPeakAsset(source, 'stereo-fixture', {
      onChunk: async ({ chunks }) => {
        high = chunks[0]?.data
      },
    })
    const chunk = getPeakChunkRecord('stereo-fixture', record.levels[0]!, record, 0)
    expect(chunk.channelCount).toBe(2)
    expect(high).toHaveLength(2)
    expect(decodePeakByte(high?.[0]?.[0] ?? 128)).toBeCloseTo(1, 2)
    expect(decodePeakByte(high?.[0]?.[1] ?? 128)).toBeCloseTo(1, 2)
    expect(decodePeakByte(high?.[1]?.[100] ?? 128)).toBeCloseTo(-1, 2)
    expect(decodePeakByte(high?.[0]?.[100] ?? 128)).toBeCloseTo(0, 2)
  })

  test('persists arithmetic metadata independent of multi-hour duration', async () => {
    const source = createSource({
      durationSec: 3 * 60 * 60,
      sampleRate: 10,
      channelCount: 1,
      page: {
        startFrame: 0,
        frameCount: 1,
        sampleRate: 10,
        channelCount: 1,
        planes: [new Float32Array([0])],
      },
    })
    let persistedChunks = 0
    let maximumLiveChunkArrays = 0
    let liveChunkArrays = 0
    const record = await extractPeakAsset(source, 'long-asset', {
      onChunk: async ({ chunks }) => {
        persistedChunks += chunks.length
        liveChunkArrays += chunks.length
        maximumLiveChunkArrays = Math.max(maximumLiveChunkArrays, liveChunkArrays)
        liveChunkArrays = 0
      },
    })

    expect(record.levels.every((level) => !('chunks' in level))).toBe(true)
    expect(record.levels[0].chunkCount).toBe(5400)
    expect(persistedChunks).toBe(5400 * 3)
    expect(maximumLiveChunkArrays).toBe(3)
    expect(getPeakChunkRecord('long-asset', record.levels[0], record, 0).chunkKey).toBe('long-asset:400:0')
    expect(getPeakChunkRecord('long-asset', record.levels[0], record, 2700).chunkKey).toBe('long-asset:400:2700')
    expect(getPeakChunkRecord('long-asset', record.levels[0], record, 5399).endSec).toBe(10800)
  })

  test('computes page-boundary min/max values', async () => {
    const source = createSource({
      durationSec: 2,
      sampleRate: 10,
      channelCount: 1,
      page: {
        startFrame: 0,
        frameCount: 2,
        sampleRate: 10,
        channelCount: 1,
        planes: [new Float32Array([-1, 0.5])],
      },
    })
    const chunks: Uint8Array[] = []
    const record = await extractPeakAsset(source, 'values', {
      onChunk: async ({ chunks: next }) => {
        const channel = next[0]?.data[0]
        if (channel) chunks.push(channel)
      },
    })
    const firstChunk = getPeakChunkRecord('values', record.levels[0], record, 0)
    expect(firstChunk.chunkKey).toBe('values:400:0')
    expect(decodePeakByte(chunks[0][0])).toBeCloseTo(-1, 2)
    expect(decodePeakByte(chunks[0][1])).toBeCloseTo(-1, 2)
    expect(decodePeakByte(chunks[0][80])).toBeCloseTo(0.5, 2)
  })
})
