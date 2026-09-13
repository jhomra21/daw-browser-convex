import { expect, test } from 'bun:test'
import {
  getTimelineClipViewportSlice,
  intersectTimelineRangeWithViewport,
  projectTimelineTimeToViewport,
} from './timeline-viewport-geometry'
import { clampSampleDetailWaveformViewport } from './sample-detail-waveform-viewport'

const slice = (clipStartSec: number, clipDurationSec: number, startSec: number, endSec: number) => (
  getTimelineClipViewportSlice({
    clipStartSec,
    clipDurationSec,
    visibleRange: { startSec, endSec },
    pixelsPerSecond: 100,
  })
)

test('renders only the middle intersection of a long selected clip', () => {
  expect(slice(0, 100, 40, 50)).toEqual({
    startSec: 40,
    endSec: 50,
    startPx: 0,
    widthPx: 1000,
    hasLeftBoundary: false,
    hasRightBoundary: false,
  })
})

test('exposes only the left resize boundary when the right edge is offscreen', () => {
  expect(slice(10, 100, 0, 20)).toMatchObject({
    startSec: 10,
    endSec: 20,
    hasLeftBoundary: true,
    hasRightBoundary: false,
  })
})

test('exposes only the right resize boundary when the left edge is offscreen', () => {
  expect(slice(0, 20, 10, 30)).toMatchObject({
    startSec: 10,
    endSec: 20,
    hasLeftBoundary: false,
    hasRightBoundary: true,
  })
})

test('does not mount an offscreen clip intersection', () => {
  expect(slice(0, 10, 20, 30)).toBeNull()
})

test('clamps a sample detail viewport after same-clip source metadata changes', () => {
  expect(clampSampleDetailWaveformViewport(
    { startSec: 8, endSec: 12 },
    { clipDurationSec: 9, sampleRate: 48_000 },
  )).toEqual({ startSec: 5, endSec: 9 })
  expect(clampSampleDetailWaveformViewport(
    { startSec: 0, endSec: 1 },
    { clipDurationSec: 1, sampleRate: 96_000 },
  )).toEqual({ startSec: 0, endSec: 1 })
})

test('bounds an extreme-zoom selection overlay to the viewport', () => {
  const projection = intersectTimelineRangeWithViewport({
    range: { startSec: 0, endSec: 1_000_000 },
    visibleStartSec: 500_000,
    viewportWidthPx: 1000,
    pixelsPerSecond: 480_000,
  })
  expect(projection?.leftPx).toBe(0)
  expect(projection?.widthPx).toBeCloseTo(1000)
  expect(projection?.widthPx).toBeLessThanOrEqual(1000)
})

test('bounds a collapsed long clip overlay to the viewport', () => {
  const projection = intersectTimelineRangeWithViewport({
    range: { startSec: 0, endSec: 10_000 },
    visibleStartSec: 2_000,
    viewportWidthPx: 800,
    pixelsPerSecond: 480_000,
  })
  expect(projection).toEqual({ leftPx: 0, widthPx: 800 })
  expect(projection?.widthPx).toBeLessThanOrEqual(800)
})

test('does not project a distant playhead outside the viewport', () => {
  const geometry = {
    visibleStartSec: 360,
    viewportWidthPx: 1_000,
    pixelsPerSecond: 480_000,
    durationSec: 600,
  }

  expect(projectTimelineTimeToViewport(geometry, 359)).toBeNull()
  expect(projectTimelineTimeToViewport(geometry, 360)).toBe(0)
  expect(projectTimelineTimeToViewport(geometry, 360 + 1_000 / 480_000)).toBe(1_000)
  expect(projectTimelineTimeToViewport(geometry, 600)).toBeNull()
})
