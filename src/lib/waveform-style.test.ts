import { describe, expect, test } from 'bun:test'
import { resolveWaveformPaintStyle } from './waveform-style'

describe('waveform paint style', () => {
  test('resolves one color and a two-backing-pixel minimum for every surface', () => {
    expect(resolveWaveformPaintStyle({
      color: '#4ade80',
      backingScaleY: 1,
    })).toEqual({
      fillStyle: '#4ade80',
      maxHeightFraction: 0.9,
      minimumThicknessCssPx: 2,
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
      minimumThicknessCssPx: 2 / 3,
      backingScaleY: 3,
      pointRadius: 0.5,
    })
  })

  test('keeps the shared backing-pixel floor across supported DPR values', () => {
    for (const dpr of [1, 2, 3]) {
      const style = resolveWaveformPaintStyle({
        color: '#4ade80',
        backingScaleY: dpr,
      })
      expect(style.minimumThicknessCssPx).toBe(2 / dpr)
    }
  })
})
