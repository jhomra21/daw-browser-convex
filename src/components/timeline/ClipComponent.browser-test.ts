import { describe, expect, test } from 'bun:test'
import { waveformCanvasSize } from '~/lib/waveform-canvas'

describe('clip waveform backing size', () => {
  test('uses effective horizontal density without shrinking CSS width', () => {
    const size = waveformCanvasSize({ cssWidthPx: 4096, cssHeightPx: 47, devicePixelRatio: 3 })
    expect(size.cssWidthPx).toBe(4096)
    expect(size.backingWidthPx).toBe(12288)
    expect(size.contextScaleX).toBe(3)
  })
})
