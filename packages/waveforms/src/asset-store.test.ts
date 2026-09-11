import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, test } from 'bun:test'
import type { AudioPcmSourceDescriptor } from '@daw-browser/audio-engine/media-pages'
import { loadPeakAssetRecord, loadPeakChunk } from './peak-db'
import { getPeakChunkRecord } from './extract-peaks'
import { clearWaveformAssetCache, ensurePeakAsset, getWaveformCacheSizes, waveformCacheLimits } from './asset-store'

function createDeferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

function createTestBuffer(duration: number): AudioBuffer {
  const sampleRate = 10
  const data = new Float32Array(Math.max(1, Math.round(duration * sampleRate)))

  return {
    duration,
    length: data.length,
    numberOfChannels: 1,
    sampleRate,
    getChannelData: () => data,
    copyFromChannel: (destination) => {
      destination.set(data.subarray(0, destination.length))
    },
    copyToChannel: (source) => {
      data.set(source.subarray(0, data.length))
    },
  }
}

function createDelayedSource(input: {
  durationSec: number
  started: { resolve: () => void }
  release: Promise<void>
}): AudioPcmSourceDescriptor {
  return {
    identity: 'shared-source',
    durationSec: input.durationSec,
    frameCount: Math.round(input.durationSec * 10),
    sampleRate: 10,
    channelCount: 1,
    readPages: async function* (options = {}) {
      input.started.resolve()
      await input.release
      options.signal?.throwIfAborted()
      yield {
        startFrame: 0,
        frameCount: 1,
        sampleRate: 10,
        channelCount: 1,
        planes: [new Float32Array([0])],
      }
    },
  }
}

describe('ensurePeakAsset', () => {
  beforeEach(() => {
    clearWaveformAssetCache()
  })

  test('serializes source changes for one asset key and rechecks identity before extraction', async () => {
    const firstIdentity = {
      assetKey: 'project:asset',
      durationSec: 1,
      sampleRate: 10,
      channelCount: 1,
    }
    const secondIdentity = {
      assetKey: 'project:asset',
      durationSec: 2,
      sampleRate: 10,
      channelCount: 1,
    }

    const [first, second] = await Promise.all([
      ensurePeakAsset({
        assetKey: 'project:asset',
        sourceIdentity: firstIdentity,
        buffer: createTestBuffer(1),
      }),
      ensurePeakAsset({
        assetKey: 'project:asset',
        sourceIdentity: secondIdentity,
        buffer: createTestBuffer(2),
      }),
    ])

    expect(first).toBeNull()
    expect(second?.durationSec).toBe(2)

    const cachedSecond = await ensurePeakAsset({
      assetKey: 'project:asset',
      sourceIdentity: secondIdentity,
    })

    expect(cachedSecond?.durationSec).toBe(2)
  })

  test('derives source identity from buffers when no explicit identity is passed', async () => {
    const first = await ensurePeakAsset({
      assetKey: 'project:asset',
      buffer: createTestBuffer(1),
    })
    const second = await ensurePeakAsset({
      assetKey: 'project:asset',
      buffer: createTestBuffer(2),
    })

    expect(first?.durationSec).toBe(1)
    expect(second?.durationSec).toBe(2)
  })

  test('does not publish an aborted generation and bounds record cache size', async () => {
    const controller = new AbortController()
    const aborted = ensurePeakAsset({
      assetKey: 'aborted',
      buffer: createTestBuffer(2),
      signal: controller.signal,
    })
    controller.abort()
    expect(await aborted).toBeNull()

    for (let index = 0; index < waveformCacheLimits.recordEntries + 4; index++) {
      await ensurePeakAsset({
        assetKey: `asset-${index}`,
        buffer: createTestBuffer(0.1),
      })
    }
    expect(getWaveformCacheSizes().recordEntries).toBe(waveformCacheLimits.recordEntries)
    expect(getWaveformCacheSizes().chunkEntries).toBeLessThanOrEqual(waveformCacheLimits.chunkEntries)
    expect(getWaveformCacheSizes().generationEntries).toBe(0)
  })

  test('detaches an aborted waiter without aborting shared generation', async () => {
    const started = createDeferred()
    const release = createDeferred()
    const source = createDelayedSource({ durationSec: 1, started, release: release.promise })
    const controller = new AbortController()
    const first = ensurePeakAsset({ assetKey: 'shared', source, signal: controller.signal })
    await started.promise
    const second = ensurePeakAsset({ assetKey: 'shared', source })

    controller.abort()
    expect(await first).toBeNull()
    release.resolve()
    expect((await second)?.durationSec).toBe(1)
  })

  test('does not persist session-only source records or chunks', async () => {
    const assetKey = `session:${crypto.randomUUID()}`
    const record = await ensurePeakAsset({
      assetKey,
      buffer: createTestBuffer(0.1),
    })
    if (!record) throw new Error('Expected session waveform record')

    const chunk = getPeakChunkRecord(assetKey, record.levels[0], record, 0)
    expect(await loadPeakAssetRecord(assetKey)).toBeNull()
    expect(await loadPeakChunk(chunk.chunkKey)).toBeNull()
  })
})
