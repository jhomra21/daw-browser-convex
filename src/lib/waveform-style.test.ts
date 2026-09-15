import { describe, expect, test } from 'bun:test'
import { resolveWaveformPaintStyle } from './waveform-style'

describe('waveform paint style', () => {
  test('resolves one color and device-pixel global minimum physical thickness for every surface', () => {
    expect(resolveWaveformPaintStyle({
      color: '#4ade80',
      backingScaleY: 1,
    })).toEqual({
      fillStyle: '#4ade80',
      maxHeightFraction: 0.9,
      minimumThicknessCssPx: 1,
      backingScaleY: 1,
      pointRadius: undefined,
    })
    expect(resolveWaveformPaintStyle({
      color: '#4ade80',
      backingScaleY: 3,
      pointRadius: 0.5,
    })).toEqual({
      fillStyle: '#4ade80',
      maxHeightFraction: 0.9,
      minimumThicknessCssPx: 1 / 3,
      backingScaleY: 3,
      pointRadius: 0.5,
    })
  })

  test('keeps global minimum physical thickness at one backing pixel across supported DPR values', () => {
    for (const dpr of [1, 2, 3]) {
      const style = resolveWaveformPaintStyle({
        color: '#4ade80',
        backingScaleY: dpr,
      })
      expect((style.minimumThicknessCssPx ?? 0) * dpr).toBe(1)
    }
  })
})
