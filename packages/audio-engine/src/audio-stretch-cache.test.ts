import { describe, expect, test } from 'bun:test'
import { audioStretchCacheTestInternals } from './audio-stretch-cache'

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
