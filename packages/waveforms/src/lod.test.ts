import { describe, expect, test } from 'bun:test'

import {
  maximumCachedPeaksPerSecond,
  samplePointMinimumPixelsPerSample,
  selectWaveformLod,
} from './lod'

describe('selectWaveformLod', () => {
  test('uses persisted peaks only while they satisfy the requested display rate', () => {
    expect(selectWaveformLod({
      sampleRate: 48_000,
      sourceStartSec: 0,
      sourceEndSec: 2,
      widthPx: maximumCachedPeaksPerSecond * 2,
    })?.mode).toBe('cached-peaks')

    expect(selectWaveformLod({
      sampleRate: 48_000,
      sourceStartSec: 0,
      sourceEndSec: 2,
      widthPx: maximumCachedPeaksPerSecond * 2 + 1,
    })?.mode).toBe('pcm-envelope')
  })

  test('uses a raw envelope while multiple samples still occupy each pixel', () => {
    const lod = selectWaveformLod({
      sampleRate: 48_000,
      sourceStartSec: 0,
      sourceEndSec: 1,
      widthPx: 24_000,
    })

    expect(lod).toMatchObject({ mode: 'pcm-envelope', samplesPerPixel: 2 })
  })

  test('switches to raw samples below one sample per pixel and enables points only when useful', () => {
    const line = selectWaveformLod({
      sampleRate: 48_000,
      sourceStartSec: 0,
      sourceEndSec: 1,
      widthPx: 96_000,
    })
    expect(line).toMatchObject({ mode: 'pcm-line', pixelsPerSample: 2, showPoints: false })

    const points = selectWaveformLod({
      sampleRate: 48_000,
      sourceStartSec: 0,
      sourceEndSec: 1,
      widthPx: 48_000 * samplePointMinimumPixelsPerSample,
    })
    expect(points).toMatchObject({
      mode: 'pcm-line',
      pixelsPerSample: samplePointMinimumPixelsPerSample,
      showPoints: true,
    })
  })

  test('rejects invalid viewport or source metadata', () => {
    expect(selectWaveformLod({ sampleRate: 0, sourceStartSec: 0, sourceEndSec: 1, widthPx: 100 })).toBeNull()
    expect(selectWaveformLod({ sampleRate: 48_000, sourceStartSec: 1, sourceEndSec: 1, widthPx: 100 })).toBeNull()
    expect(selectWaveformLod({ sampleRate: 48_000, sourceStartSec: 0, sourceEndSec: 1, widthPx: 0 })).toBeNull()
  })
})
