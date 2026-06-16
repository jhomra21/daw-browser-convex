import { describe, expect, test } from 'bun:test'
import { audioStretchCacheTestInternals } from './audio-stretch-cache'

const createTestBuffer = (values: number[]) => ({
  duration: values.length / 10,
  sampleRate: 10,
  numberOfChannels: 1,
  length: values.length,
  getChannelData: () => new Float32Array(values),
})

describe('audio stretch cache eviction helpers', () => {
  test('accounts stored render bytes from channel buffers', () => {
    expect(audioStretchCacheTestInternals.getStoredRenderByteSize({
      channels: [
        new Float32Array(10),
        new Float32Array(5),
      ],
    })).toBe(60)
  })

  test('selects least-recently-used renders until under budget', () => {
    const keys = audioStretchCacheTestInternals.selectStoredRenderEvictionKeys([
      { key: 'newest', updatedAt: 30, byteSize: 30 },
      { key: 'oldest', updatedAt: 10, byteSize: 50 },
      { key: 'middle', updatedAt: 20, byteSize: 40 },
    ], 70)

    expect(keys.join(',')).toBe('oldest')
  })

  test('evicts the newest render too when one render exceeds the budget', () => {
    const keys = audioStretchCacheTestInternals.selectStoredRenderEvictionKeys([
      { key: 'older', updatedAt: 10, byteSize: 10 },
      { key: 'oversized', updatedAt: 20, byteSize: 100 },
    ], 50)

    expect(keys.join(',')).toBe('older,oversized')
  })
})

describe('audio stretch cache key identity', () => {
  test('uses stable source asset metadata and fingerprint instead of clip id for persisted keys', () => {
    const buffer = createTestBuffer([0, 0.5, 1])
    const left = audioStretchCacheTestInternals.createCacheKey({
      id: 'clip-a',
      sourceAssetKey: 'asset-key',
      sourceDurationSec: 12,
      sourceSampleRate: 48_000,
      sourceChannelCount: 2,
      startSec: 0,
      duration: 4,
      audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 120 },
    }, buffer, 120)
    const right = audioStretchCacheTestInternals.createCacheKey({
      id: 'clip-b',
      sourceAssetKey: 'asset-key',
      sourceDurationSec: 12,
      sourceSampleRate: 48_000,
      sourceChannelCount: 2,
      startSec: 0,
      duration: 4,
      audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 120 },
    }, buffer, 120)

    expect(left).toBe(right)
    expect(left.startsWith('asset:asset-key')).toBe(true)
  })

  test('separates asset-backed buffers with changed content', () => {
    const leftBuffer = createTestBuffer([0, 0.5, 1])
    const rightBuffer = createTestBuffer([0, 0.25, 1])

    expect(audioStretchCacheTestInternals.createSourceCacheIdentity({
      id: 'clip',
      sourceAssetKey: 'asset-key',
      sourceDurationSec: 12,
      sourceSampleRate: 48_000,
      sourceChannelCount: 2,
      startSec: 0,
      duration: 1,
    }, leftBuffer)).not.toBe(audioStretchCacheTestInternals.createSourceCacheIdentity({
      id: 'clip',
      sourceAssetKey: 'asset-key',
      sourceDurationSec: 12,
      sourceSampleRate: 48_000,
      sourceChannelCount: 2,
      startSec: 0,
      duration: 1,
    }, rightBuffer))
  })

  test('falls back to buffer fingerprint for transient source buffers', () => {
    const leftBuffer = createTestBuffer([0, 0.5, 1])
    const rightBuffer = createTestBuffer([0, 0.25, 1])

    expect(audioStretchCacheTestInternals.createSourceCacheIdentity({
      id: 'clip',
      startSec: 0,
      duration: 1,
    }, leftBuffer)).not.toBe(audioStretchCacheTestInternals.createSourceCacheIdentity({
      id: 'clip',
      startSec: 0,
      duration: 1,
    }, rightBuffer))
  })
})
