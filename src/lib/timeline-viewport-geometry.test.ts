import { describe, expect, test } from 'bun:test'
import {
  clampedVisibleStartSec,
  createTimelineViewport,
  timeToViewportX,
  visibleDurationSec,
  visibleEndSec,
  visibleStartAfterScrollDelta,
  viewportXToTime,
} from './timeline-viewport-geometry'

const viewport = {
  visibleStartSec: 10,
  viewportWidthPx: 1000,
  pixelsPerSecond: 100,
  durationSec: 60,
}

describe('timeline viewport geometry', () => {
  test('derives a clamped visible range without multiplying duration by scale', () => {
    expect(visibleDurationSec(viewport)).toBe(10)
    expect(clampedVisibleStartSec(viewport)).toBe(10)
    expect(visibleEndSec(viewport)).toBe(20)
    expect(timeToViewportX(viewport, 15)).toBe(500)
    expect(viewportXToTime(viewport, 500)).toBe(15)
  })

  test('projects a nonzero-origin viewport into screen coordinates', () => {
    const projected = createTimelineViewport(viewport)
    expect(projected.timeToX(12.5)).toBe(250)
    expect(projected.xToTime(250)).toBe(12.5)
    expect(projected.overscanRange.startSec).toBeCloseTo(4.88)
  })

  test('keeps runway geometry independent of arrangement duration', () => {
    const projected = createTimelineViewport({
      ...viewport,
      durationSec: 360,
      pixelsPerSecond: 240_000,
    })

    expect(projected.width).toBe(1000)
  })

  test('applies scroll deltas from the current clamped start', () => {
    expect(visibleStartAfterScrollDelta({
      visibleStartSec: 50,
      viewportWidthPx: 1000,
      pixelsPerSecond: 100,
      durationSec: 20,
    }, 100)).toBe(10)
  })
})
