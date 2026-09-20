import { describe, expect, test } from 'bun:test'
import {
  pointRadiusForPixelsPerSample,
  selectWaveformTier,
  waveformTierSelectionThreshold,
} from './lod'

describe('waveform level of detail', () => {
  test('uses effective backing density deterministically', () => {
    const input = {
      sourceFrameSpan: 48_000,
      cssSegmentWidth: 480,
      backingPixelsPerCssPixel: 1,
      tiers: [1, 2, 4, 8, 16, 32, 64, 128],
    }
    expect(selectWaveformTier(input)?.framesPerInterval).toBe(8)
    expect(selectWaveformTier({
      ...input,
      sourceFrameSpan: 96_000,
    })?.framesPerInterval).toBe(16)
  })

  test('does not make tier selection depend on a previous zoom tier', () => {
    const first = selectWaveformTier({
      sourceFrameSpan: 40,
      cssSegmentWidth: 7,
      backingPixelsPerCssPixel: 1,
      tiers: [1, 2, 4],
    })?.framesPerInterval
    const second = selectWaveformTier({
      sourceFrameSpan: 20,
      cssSegmentWidth: 7,
      backingPixelsPerCssPixel: 1,
      tiers: [1, 2, 4],
    })?.framesPerInterval
    expect(first).toBe(1)
    expect(second).toBe(1)
  })

  test('keeps the early acquisition threshold explicit', () => {
    expect(waveformTierSelectionThreshold).toBe(0.125)
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
