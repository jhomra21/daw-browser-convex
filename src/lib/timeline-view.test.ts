import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_PIXELS_PER_SECOND,
  MAX_PIXELS_PER_SECOND,
  MIN_PIXELS_PER_SECOND,
  clampPixelsPerSecond,
  minimumVisibleDuration,
  musicalBarLabelAtTime,
  normalizeTimelineRange,
  normalizeWheelZoomFactor,
  pixelsPerSecondForRange,
  pixelsToSeconds,
  scrollLeftForTimelineRange,
  secondsToPixels,
  selectTimelineGridIntervals,
  timelineViewportRange,
  zoomRangeAtAnchor,
} from './timeline-view'

describe('timeline view contracts', () => {
  test('converts between time and pixels at the default scale', () => {
    expect(secondsToPixels(2.5, DEFAULT_PIXELS_PER_SECOND)).toBe(250)
    expect(pixelsToSeconds(250, DEFAULT_PIXELS_PER_SECOND)).toBe(2.5)
  })

  test('normalizes invalid scales to bounded finite values', () => {
    expect(clampPixelsPerSecond(Number.NaN)).toBe(DEFAULT_PIXELS_PER_SECOND)
    expect(clampPixelsPerSecond(-1)).toBe(MIN_PIXELS_PER_SECOND)
    expect(clampPixelsPerSecond(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PIXELS_PER_SECOND)
    expect(clampPixelsPerSecond(9999)).toBe(MAX_PIXELS_PER_SECOND)
  })

  test('keeps the zoom anchor fixed when not clamped by arrangement bounds', () => {
    const range = { startSec: 10, endSec: 30 }
    const next = zoomRangeAtAnchor(range, 0.25, 2, 120, 1)
    expect(next).toEqual({ startSec: 12.5, endSec: 22.5 })
  })

  test('clamps viewport scroll to the arrangement duration', () => {
    expect(timelineViewportRange(50_000, 1000, 100, 20)).toEqual({ startSec: 10, endSec: 20 })
    expect(scrollLeftForTimelineRange({ startSec: 19, endSec: 20 }, 1000, 100, 20)).toBe(1000)
  })

  test('derives a fit scale for narrow and zero-width ranges', () => {
    expect(pixelsPerSecondForRange({ startSec: 0, endSec: 10 }, 1000)).toBe(100)
    expect(pixelsPerSecondForRange({ startSec: 2, endSec: 2 }, 0)).toBe(MIN_PIXELS_PER_SECOND)
  })

  test('normalizes inverted and collapsed ranges to the minimum zoom duration', () => {
    expect(normalizeTimelineRange({ startSec: 12, endSec: 4 }, 20, 2)).toEqual({
      startSec: 4,
      endSec: 12,
    })
    expect(normalizeTimelineRange({ startSec: 19, endSec: 19 }, 20, 2)).toEqual({
      startSec: 18,
      endSec: 20,
    })
    expect(minimumVisibleDuration(800)).toBe(1)
  })

  test('normalizes wheel deltas into smooth bounded factors', () => {
    expect(normalizeWheelZoomFactor(-100, 0)).toBeGreaterThan(1)
    expect(normalizeWheelZoomFactor(100, 0)).toBeLessThan(1)
    expect(normalizeWheelZoomFactor(-1, 1)).toBeCloseTo(normalizeWheelZoomFactor(-16, 0))
    expect(normalizeWheelZoomFactor(-10_000, 0)).toBeCloseTo(normalizeWheelZoomFactor(-240, 0))
  })

  test('labels adaptive musical markers by their actual bar time', () => {
    expect(musicalBarLabelAtTime(0, 120)).toBe(1)
    expect(musicalBarLabelAtTime(8, 120)).toBe(5)
    expect(musicalBarLabelAtTime(16, 120)).toBe(9)
  })

  test('selects readable shared grid intervals', () => {
    const musical = selectTimelineGridIntervals(10, 120, 16, true)
    expect(musical.minorSec * 10).toBeGreaterThanOrEqual(8)
    expect(musical.majorSec * 10).toBeGreaterThanOrEqual(56)
    const seconds = selectTimelineGridIntervals(10, 120, 4, false)
    expect(seconds.minorSec * 10).toBeGreaterThanOrEqual(8)
    expect(seconds.majorSec * 10).toBeGreaterThanOrEqual(56)
  })
})
