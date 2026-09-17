import { describe, expect, test } from 'bun:test'
import {
  MAX_WAVEFORM_BACKING_PIXELS,
  waveformCanvasSize,
} from './waveform-canvas'

describe('waveform canvas bounds', () => {
  test('never exceeds the backing pixel budget', () => {
    for (const dpr of [1, 1.5, 2, 3]) {
      const size = waveformCanvasSize({
        cssWidthPx: 2_000,
        cssHeightPx: 47,
        devicePixelRatio: dpr,
      })
      expect(size.cssWidthPx).toBe(2_000)
      expect(size.backingHeightPx).toBe(Math.ceil(47 * dpr))
      expect(size.backingWidthPx * size.backingHeightPx).toBeLessThanOrEqual(MAX_WAVEFORM_BACKING_PIXELS)
      expect(size.contextScaleX * size.cssWidthPx).toBeCloseTo(size.backingWidthPx)
    }
  })

  test('keeps the logical right edge drawable at extreme zoom', () => {
    const size = waveformCanvasSize({
      cssWidthPx: 4_096,
      cssHeightPx: 47,
      devicePixelRatio: 3,
    })
    expect(size.cssWidthPx).toBe(4_096)
    expect(size.backingWidthPx).toBe(12_288)
    expect(size.backingHeightPx).toBe(141)
    expect(size.contextScaleX * size.cssWidthPx).toBeCloseTo(size.backingWidthPx)
    expect(size.backingWidthPx * size.backingHeightPx).toBeLessThanOrEqual(MAX_WAVEFORM_BACKING_PIXELS)
  })

  test('normalizes device pixel ratios above the supported cap', () => {
    const capped = waveformCanvasSize({
      cssWidthPx: 1_000,
      cssHeightPx: 40,
      devicePixelRatio: 6,
    })
    const maximum = waveformCanvasSize({
      cssWidthPx: 1_000,
      cssHeightPx: 40,
      devicePixelRatio: 3,
    })
    expect(capped.dpr).toBe(3)
    expect(capped).toEqual(maximum)
  })

  test('keeps a two-million-pixel canvas within budget', () => {
    const size = waveformCanvasSize({
      cssWidthPx: 20_000,
      cssHeightPx: 220,
      devicePixelRatio: 3,
    })
    expect(size.backingWidthPx * size.backingHeightPx).toBeLessThanOrEqual(MAX_WAVEFORM_BACKING_PIXELS)
    expect(size.backingWidthPx).toBe(Math.floor(MAX_WAVEFORM_BACKING_PIXELS / size.backingHeightPx))
    expect(size.contextScaleY).toBe(3)
  })

  test('remounts as a fresh bounded canvas size after suspension', () => {
    const hidden = waveformCanvasSize({
      cssWidthPx: 0,
      cssHeightPx: 47,
      devicePixelRatio: 2,
    })
    const remounted = waveformCanvasSize({
      cssWidthPx: 1_000,
      cssHeightPx: 47,
      devicePixelRatio: 2,
    })
    expect(hidden.backingWidthPx).toBe(2)
    expect(remounted.backingWidthPx).toBeGreaterThan(hidden.backingWidthPx)
  })
})
