import { expect, test } from 'bun:test'
import { waveformCanvasSize } from '~/lib/waveform-canvas'

test('ClipComponent waveform canvas remount uses bounded backing storage', () => {
  const hidden = waveformCanvasSize({
    cssWidthPx: 0,
    cssHeightPx: 47,
    devicePixelRatio: 2,
  })
  const remounted = waveformCanvasSize({
    cssWidthPx: 16_384,
    cssHeightPx: 47,
    devicePixelRatio: 2,
  })

  expect(hidden.backingWidthPx).toBe(2)
  expect(remounted.backingWidthPx).toBeGreaterThan(hidden.backingWidthPx)
  expect(remounted.backingWidthPx * remounted.backingHeightPx).toBeLessThanOrEqual(2_000_000)
})
