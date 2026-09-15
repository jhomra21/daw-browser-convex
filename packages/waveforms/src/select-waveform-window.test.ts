import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, test } from 'bun:test'
import type { AudioPcmSourceDescriptor } from '@daw-browser/audio-engine/media-pages'
import { clearWaveformAssetCache, ensurePeakAsset } from './asset-store'
import { getPeakChunkRecord } from './extract-peaks'
import { loadPeakAssetRecord, storePeakChunk } from './peak-db'
import { loadWaveformSourceData } from './select-waveform-window'

const source = (pages: readonly {
  readonly startFrame: number
  readonly values: readonly number[]
}[]): AudioPcmSourceDescriptor => ({
  identity: 'window-source',
  durationSec: 8 / 8,
  frameCount: 8,
  sampleRate: 8,
  channelCount: 1,
  readPages: async function* (options = {}) {
    options.signal?.throwIfAborted()
    for (const page of pages) {
      if (page.startFrame < (options.startFrame ?? 0)) continue
      yield {
        startFrame: page.startFrame,
        frameCount: page.values.length,
        sampleRate: 8,
        channelCount: 1,
        planes: [Float32Array.from(page.values)],
      }
    }
  },
})

describe('waveform source windows', () => {
  beforeEach(() => clearWaveformAssetCache())

  test('preserves frame windows and turns page gaps into silence', async () => {
    const data = await loadWaveformSourceData({
      assetKey: 'window-gap',
      source: source([
        { startFrame: 0, values: [1, 0] },
        { startFrame: 5, values: [-1, 0, 0] },
      ]),
      sourceStartFrame: 0,
      sourceEndFrame: 8,
      framesPerInterval: 2,
    })
    expect(data?.kind).toBe('intervals')
    if (!data || data.kind !== 'intervals' || data.encoding !== 'float32') throw new Error('Expected float intervals')
    expect(data.firstFrame).toBe(0)
    expect(data.intervalCount).toBe(4)
    expect(Array.from(data.channels[0] ?? [])).toEqual([0, 1, 0, 0, -1, 0, 0, 0])
  })

  test('handles huge sparse gaps with interval-bounded gap processing', async () => {
    let yieldedPages = 0
    const sparseSource: AudioPcmSourceDescriptor = {
      ...source([]),
      frameCount: 1_000_000_000,
      durationSec: 125_000_000,
      readPages: async function* () {
        yieldedPages += 1
        yield {
          startFrame: 0,
          frameCount: 1,
          sampleRate: 8,
          channelCount: 1,
          planes: [new Float32Array([1])],
        }
        yieldedPages += 1
        yield {
          startFrame: 999_999_999,
          frameCount: 1,
          sampleRate: 8,
          channelCount: 1,
          planes: [new Float32Array([-1])],
        }
      },
    }
    const data = await loadWaveformSourceData({
      assetKey: 'huge-sparse-gap',
      source: sparseSource,
      sourceStartFrame: 0,
      sourceEndFrame: sparseSource.frameCount,
      framesPerInterval: 1_000_000,
    })
    expect(yieldedPages).toBe(2)
    expect(data?.kind).toBe('intervals')
    if (!data || data.kind !== 'intervals' || data.encoding !== 'float32') {
      throw new Error('Expected float intervals')
    }
    expect(data.intervalCount).toBe(1_000)
    expect(data.channels[0]?.[0]).toBe(0)
    expect(data.channels[0]?.[data.channels[0].length - 2]).toBe(-1)
    expect(data.channels[0]?.[data.channels[0].length - 1]).toBe(0)
  })

  test('returns exact source samples without stretching', async () => {
    const data = await loadWaveformSourceData({
      assetKey: 'window-samples',
      source: source([{ startFrame: 2, values: [0.25, -0.5] }]),
      sourceStartFrame: 2,
      sourceEndFrame: 4,
      framesPerInterval: 1,
    })
    expect(data?.kind).toBe('samples')
    if (!data || data.kind !== 'samples') throw new Error('Expected samples')
    expect(data.firstFrame).toBe(2)
    expect(Array.from(data.channels[0] ?? [])).toEqual([0.25, -0.5])
  })

  test('normalizes buffer-only requests and reads an interval window at EOF', async () => {
    const samples = new Float32Array([0, 0.25, -0.5, 0.75, -1])
    const buffer: AudioBuffer = {
      duration: samples.length / 8,
      length: samples.length,
      numberOfChannels: 1,
      sampleRate: 8,
      copyFromChannel: (destination, channelNumber = 0, startInChannel = 0) => {
        if (channelNumber !== 0) return
        destination.set(samples.subarray(startInChannel, startInChannel + destination.length))
      },
      copyToChannel: () => {},
      getChannelData: () => samples,
    }
    const data = await loadWaveformSourceData({
      assetKey: 'buffer-only',
      buffer,
      sourceStartFrame: 3,
      sourceEndFrame: 5,
      framesPerInterval: 2,
    })
    expect(data?.kind).toBe('intervals')
    if (!data || data.kind !== 'intervals' || data.encoding !== 'float32') {
      throw new Error('Expected float intervals')
    }
    expect(data.firstFrame).toBe(2)
    expect(Array.from(data.channels[0] ?? [])).toEqual([-.5, .75, -1, -1])
  })

  test('keeps interval ownership globally aligned across tiny source-window pans', async () => {
    const alignedSource: AudioPcmSourceDescriptor = {
      ...source([
      { startFrame: 0, values: [1, 0, 0, 0, 0, 0, 0, 0] },
      { startFrame: 8, values: [0, 0, 0, 0, -1, 0, 0, 0] },
      ]),
      frameCount: 16,
      durationSec: 2,
    }
    const first = await loadWaveformSourceData({
      assetKey: 'aligned-window-a',
      source: alignedSource,
      sourceStartFrame: 3,
      sourceEndFrame: 13,
      framesPerInterval: 4,
    })
    const panned = await loadWaveformSourceData({
      assetKey: 'aligned-window-b',
      source: alignedSource,
      sourceStartFrame: 4,
      sourceEndFrame: 14,
      framesPerInterval: 4,
    })
    expect(first?.kind).toBe('intervals')
    expect(panned?.kind).toBe('intervals')
    if (!first || first.kind !== 'intervals' || !panned || panned.kind !== 'intervals') {
      throw new Error('Expected interval data')
    }
    expect(first.firstFrame).toBe(0)
    expect(panned.firstFrame).toBe(4)
    expect(first.firstFrame % first.framesPerInterval).toBe(0)
    expect(panned.firstFrame % panned.framesPerInterval).toBe(0)
    expect(first.framesPerInterval).toBe(panned.framesPerInterval)
  })

  test('does not silently substitute a coarser persisted tier', async () => {
    const data = await loadWaveformSourceData({
      assetKey: 'unsupported-tier',
      source: source([{ startFrame: 0, values: [1, -1, 0, 0] }]),
      sourceStartFrame: 0,
      sourceEndFrame: 4,
      framesPerInterval: 3,
    })
    expect(data?.kind).toBe('intervals')
    if (!data || data.kind !== 'intervals') throw new Error('Expected intervals')
    expect(data.encoding).toBe('float32')
    expect(data.framesPerInterval).toBe(3)
  })

  test('regenerates a persisted asset when a declared chunk is malformed', async () => {
    const assetKey = 'malformed-window'
    const persistable: AudioPcmSourceDescriptor = {
      ...source([{ startFrame: 0, values: [1, -1, 0, 0] }]),
      identity: 'persisted-window',
      persistable: true,
    }
    const record = await ensurePeakAsset({ assetKey, source: persistable })
    if (!record) throw new Error('Expected persisted asset')
    const chunk = getPeakChunkRecord(assetKey, record.generationId, record.levels[0]!, record.channelCount, 0)
    await storePeakChunk(chunk.chunkKey, [new Uint8Array([1])])
    clearWaveformAssetCache()
    const data = await loadWaveformSourceData({
      assetKey,
      source: persistable,
      sourceIdentity: {
        assetKey,
        identity: persistable.identity,
        frameCount: persistable.frameCount,
        durationSec: persistable.durationSec,
        sampleRate: persistable.sampleRate,
        channelCount: persistable.channelCount,
      },
      sourceStartFrame: 0,
      sourceEndFrame: 4,
      framesPerInterval: record.levels[0]?.framesPerInterval ?? 1,
    })
    expect(data).not.toBeNull()
    expect(await loadPeakAssetRecord(assetKey)).not.toBeNull()
  })
})
