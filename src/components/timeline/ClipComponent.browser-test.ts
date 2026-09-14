import { expect, test } from 'bun:test'
import { createEffect, createRoot, createSignal, untrack } from 'solid-js'
import { normalizeClipFades, normalizedFadeGainAtClipTime } from '@daw-browser/timeline-core/clip-fades'
import { drawWaveformPeaks } from '@daw-browser/waveforms/render-waveform'
import { createFadeScale } from './ClipComponent'
import { waveformCanvasSize } from '~/lib/waveform-canvas'

test('waveform render revisions invalidate redraws without a scheduler', async () => {
  await new Promise<void>((resolve, reject) => createRoot((dispose) => {
    const [renderRevision, setRenderRevision] = createSignal(0)
    let redraws = 0
    createEffect(() => {
      renderRevision()
      untrack(() => { redraws += 1 })
    })
    void (async () => {
      await Promise.resolve()
      expect(redraws).toBe(1)
      setRenderRevision(1)
      await Promise.resolve()
      expect(redraws).toBe(2)
      dispose()
      resolve()
    })().catch((error) => {
      dispose()
      reject(error)
    })
  }))
})

test('ClipComponent uses current slice width and native-DPR backing dimensions', () => {
  const size = waveformCanvasSize({ cssWidthPx: 4_096, cssHeightPx: 47, devicePixelRatio: 3 })
  expect(size.cssWidthPx).toBe(4_096)
  expect(size.backingWidthPx).toBe(12_288)
  expect(size.backingHeightPx).toBe(141)
  expect(size.contextScaleX * size.cssWidthPx).toBeCloseTo(size.backingWidthPx)
  expect(size.contextScaleY * size.cssHeightPx).toBeCloseTo(size.backingHeightPx)
})

test('ClipComponent preserves CSS width when backing pixels are budgeted', () => {
  const size = waveformCanvasSize({ cssWidthPx: 100_000, cssHeightPx: 47, devicePixelRatio: 3 })
  expect(size.cssWidthPx).toBe(100_000)
  expect(size.backingWidthPx * size.backingHeightPx).toBeLessThanOrEqual(2_000_000)
  expect(size.contextScaleX).toBeLessThan(3)
})

test('ClipComponent scales current peak segments from canonical clip timing', () => {
  const fades = normalizeClipFades({ fadeInSec: 2 }, 4)
  const scale = createFadeScale(fades, 4, 1, 2, 2)
  const rectangles: number[] = []
  drawWaveformPeaks({
    ctx: {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
      fillRect(_x, _y, _width, height) { rectangles.push(height) },
    },
    peaks: new Uint8Array([0, 255, 0, 255]),
    drawCols: 2,
    padPx: 0,
    topY: 0,
    contentH: 100,
    cssW: 2,
    cssH: 100,
    maxHeightFraction: 0.9,
    amplitudeScaleAtColumn: scale,
    drawBoundary: false,
  })
  expect(scale(0)).toBeCloseTo(normalizedFadeGainAtClipTime(fades, 4, 1.5))
  expect(scale(1)).toBeCloseTo(normalizedFadeGainAtClipTime(fades, 4, 2.5))
  expect(rectangles).toEqual([67.5, 90])
})
