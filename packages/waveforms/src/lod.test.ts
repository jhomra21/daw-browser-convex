import { describe, expect, test } from 'bun:test'
import {
  maximumCachedPeaksPerSecond,
  samplePointMinimumPixelsPerSample,
  selectWaveformLod,
} from './lod'

describe('selectWaveformLod', () => {
  test('uses the exact cached-peak boundary', () => {
    for (const sampleRate of [44_100, 48_000, 96_000]) {
      expect(selectWaveformLod({ sampleRate, sourceStartSec: 0, sourceEndSec: 1, widthPx: 399 })?.mode).toBe('cached-peaks')
      expect(selectWaveformLod({ sampleRate, sourceStartSec: 0, sourceEndSec: 1, widthPx: 400 })?.mode).toBe('cached-peaks')
      expect(selectWaveformLod({ sampleRate, sourceStartSec: 0, sourceEndSec: 1, widthPx: 401 })?.mode).toBe('pcm-envelope')
    }
  })

  test('uses source sample rate at the one-sample-per-pixel boundary', () => {
    expect(selectWaveformLod({ sampleRate: 47_999, sourceStartSec: 0, sourceEndSec: 1, widthPx: 48_000 })?.mode).toBe('pcm-line')
    expect(selectWaveformLod({ sampleRate: 48_000, sourceStartSec: 0, sourceEndSec: 1, widthPx: 48_000 })?.mode).toBe('pcm-envelope')
    expect(selectWaveformLod({ sampleRate: 48_001, sourceStartSec: 0, sourceEndSec: 1, widthPx: 48_000 })?.mode).toBe('pcm-envelope')
    expect(selectWaveformLod({ sampleRate: 48_000, sourceStartSec: 0, sourceEndSec: 1, widthPx: 48_001 })?.mode).toBe('pcm-line')
  })

  test('enables sample points at the exact 240,000 pixel-per-second threshold', () => {
    const lod = selectWaveformLod({
      sampleRate: 48_000,
      sourceStartSec: 0,
      sourceEndSec: 1,
      widthPx: 48_000 * samplePointMinimumPixelsPerSample,
    })
    expect(lod).toMatchObject({
      mode: 'pcm-line',
      pixelsPerSample: samplePointMinimumPixelsPerSample,
      showPoints: true,
    })
    expect(48_000 * samplePointMinimumPixelsPerSample).toBe(240_000)
    expect(maximumCachedPeaksPerSecond).toBe(400)
  })
})
