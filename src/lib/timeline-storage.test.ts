import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { DEFAULT_PIXELS_PER_SECOND, MAX_PIXELS_PER_SECOND, MIN_PIXELS_PER_SECOND } from './timeline-view'
import { loadTimelineScale, saveTimelineScale } from './timeline-storage'

class MemoryStorage {
  private values = new Map<string, string>()

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

describe('timeline scale storage', () => {
  const previousWindow = globalThis.window
  const previousLocalStorage = globalThis.localStorage
  const storage = new MemoryStorage()

  beforeEach(() => {
    Reflect.set(globalThis, 'window', { localStorage: storage })
    Reflect.set(globalThis, 'localStorage', storage)
  })

  afterEach(() => {
    Reflect.set(globalThis, 'window', previousWindow)
    Reflect.set(globalThis, 'localStorage', previousLocalStorage)
  })

  test('uses the default scale when no value is stored', () => {
    expect(loadTimelineScale('missing')).toBe(DEFAULT_PIXELS_PER_SECOND)
  })

  test('uses the default scale for invalid stored values', () => {
    storage.setItem('mb:timeline-scale:invalid', 'not-a-number')

    expect(loadTimelineScale('invalid')).toBe(DEFAULT_PIXELS_PER_SECOND)
  })

  test('bounds stored scale values to the canonical limits', () => {
    storage.setItem('mb:timeline-scale:low', String(Number.MIN_VALUE))
    storage.setItem('mb:timeline-scale:high', '900')

    expect(loadTimelineScale('low')).toBe(MIN_PIXELS_PER_SECOND)
    expect(loadTimelineScale('high')).toBe(MAX_PIXELS_PER_SECOND)
  })

  test('preserves valid stored values and saves them through the shared clamp', () => {
    storage.setItem('mb:timeline-scale:valid', '125')

    expect(loadTimelineScale('valid')).toBe(125)

    saveTimelineScale('saved', 900)

    expect(storage.getItem('mb:timeline-scale:saved')).toBe(String(MAX_PIXELS_PER_SECOND))
  })
})
