import { describe, expect, test } from 'bun:test'
import { createSamplerBufferCache } from './sampled-instrument-buffer-cache'

describe('sampled instrument buffer cache', () => {
  test('evicts decoded buffers deterministically by least recent use', () => {
    const cache = createSamplerBufferCache<string>(10)
    cache.set('a', 'A', 5)
    cache.set('b', 'B', 5)
    cache.get('a')
    cache.set('c', 'C', 5)
    expect(cache.keys()).toEqual(['a', 'c'])
    expect(cache.byteLength()).toBe(10)
  })

  test('does not evict pinned decoded buffers', () => {
    const cache = createSamplerBufferCache<string>(10)
    cache.set('a', 'A', 5)
    const pin = cache.pin('a')
    cache.set('b', 'B', 5)
    cache.set('c', 'C', 5)
    expect(cache.keys()).toEqual(['a', 'c'])
    pin?.release()
    cache.set('d', 'D', 6)
    expect(cache.keys()).toEqual(['d'])
  })

  test('reports pinned over-budget state and evicts after the final unpin', () => {
    const cache = createSamplerBufferCache<string>(10)
    cache.set('active', 'A', 10)
    const pin = cache.pin('active')
    cache.setMaxByteLength(5)
    expect(cache.overBudgetPinned()).toBe(true)
    expect(cache.byteLength()).toBe(10)
    pin?.release()
    expect(cache.overBudgetPinned()).toBe(false)
    expect(cache.byteLength()).toBe(0)
  })

  test('reports evicted values so holders can release decoded buffers', () => {
    const evicted: Array<[string, string]> = []
    const cache = createSamplerBufferCache<string>(5, (key, value) => evicted.push([key, value]))
    cache.set('a', 'A', 5)
    cache.set('b', 'B', 5)
    expect(evicted).toEqual([['a', 'A']])
  })

  test('retains a replaced pinned value until its pin is released', () => {
    const cache = createSamplerBufferCache<string>(10)
    cache.set('region', 'old', 5)
    const pin = cache.pin('region')
    cache.set('region', 'new', 5)
    expect(cache.get('region')).toBe('new')
    expect(cache.byteLength()).toBe(10)
    pin?.release()
    expect(cache.byteLength()).toBe(5)
  })
})
