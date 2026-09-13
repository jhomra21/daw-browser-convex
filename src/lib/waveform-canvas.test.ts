import { describe, expect, test } from 'bun:test'
import {
  MAX_WAVEFORM_BACKING_PIXELS,
  MAX_WAVEFORM_RASTER_WIDTH_PX,
  boundedWaveformRasterWidth,
  waveformCanvasSize,
} from './waveform-canvas'

describe('waveform canvas bounds', () => {
  test('bounds a tile-sized raster independently of source tile span', () => {
    expect(boundedWaveformRasterWidth(163_840)).toBe(MAX_WAVEFORM_RASTER_WIDTH_PX)
  })

  test('never exceeds the backing pixel budget', () => {
    for (const dpr of [1, 2, 3, 4]) {
      const size = waveformCanvasSize({
        cssWidthPx: 2_000,
        cssHeightPx: 47,
        devicePixelRatio: dpr,
      })
      expect(size.cssWidthPx).toBe(2_000)
      expect(size.backingWidthPx * size.backingHeightPx).toBeLessThanOrEqual(MAX_WAVEFORM_BACKING_PIXELS)
      expect(size.contextScaleX * size.cssWidthPx).toBeCloseTo(size.backingWidthPx)
    }
  })

  test('keeps the logical right edge drawable at extreme zoom', () => {
    const size = waveformCanvasSize({
      cssWidthPx: 163_840,
      cssHeightPx: 47,
      devicePixelRatio: 4,
    })
    expect(size.cssWidthPx).toBe(MAX_WAVEFORM_RASTER_WIDTH_PX)
    expect(size.contextScaleX * size.cssWidthPx).toBeCloseTo(size.backingWidthPx)
    expect(size.backingWidthPx * size.backingHeightPx).toBeLessThanOrEqual(MAX_WAVEFORM_BACKING_PIXELS)
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
