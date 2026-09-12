import { expect, test } from 'bun:test'
import { retainedWaveformTransform } from './ClipComponent'
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

test('retained waveform projection changes with live geometry without changing raster data', () => {
  const raster = {
    timelineStartSec: 1,
    timelineEndSec: 5,
    pixelsPerSecond: 1_000,
    widthPx: 4_000,
    timingSignature: 'stable',
    dataRevision: 7,
  }

  expect(retainedWaveformTransform(raster, 0, 1_000))
    .not.toBe(retainedWaveformTransform(raster, 0.25, 1_250))
  expect(raster.dataRevision).toBe(7)
})
