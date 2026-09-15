import { describe, expect, test } from 'bun:test'
import { pointRadiusForPixelsPerSample, selectWaveformTier } from './lod'

describe('waveform level of detail', () => {
  test('uses effective backing density and hysteresis', () => {
    const input = {
      sourceFrameSpan: 48_000,
      cssSegmentWidth: 480,
      backingPixelsPerCssPixel: 1,
      tiers: [1, 2, 4, 8, 16, 32, 64, 128],
    }
    expect(selectWaveformTier(input)?.framesPerInterval).toBe(64)
    expect(selectWaveformTier({ ...input, previousFramesPerInterval: 32 })?.framesPerInterval).toBe(32)
    expect(selectWaveformTier({
      ...input,
      sourceFrameSpan: 96_000,
      previousFramesPerInterval: 32,
    })?.framesPerInterval).toBe(32)
  })

  test('returns continuous point radius only above the point threshold', () => {
    expect(pointRadiusForPixelsPerSample(4)).toBe(0)
    expect(pointRadiusForPixelsPerSample(5)).toBe(0.5)
    expect(pointRadiusForPixelsPerSample(6)).toBe(1)
    expect(pointRadiusForPixelsPerSample(8)).toBe(1)
  })

  test('rejects invalid density inputs', () => {
    expect(selectWaveformTier({
      sourceFrameSpan: 0,
      cssSegmentWidth: 100,
      backingPixelsPerCssPixel: 1,
      tiers: [1],
    })).toBeNull()
    expect(selectWaveformTier({
      sourceFrameSpan: 100,
      cssSegmentWidth: 100,
      backingPixelsPerCssPixel: 1,
      tiers: [],
    })).toBeNull()
  })
})
