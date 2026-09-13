import { describe, expect, test } from 'bun:test'
import {
  calculateBoundedPhysicalRunway,
  clampedVisibleStartSec,
  createTimelineViewport,
  scaleViewportAtPointer,
  timeToViewportX,
  visibleDurationSec,
  visibleEndSec,
  visibleIntersectionWithOverscan,
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

  test('intersects visible content with fixed-pixel overscan', () => {
    expect(visibleIntersectionWithOverscan(viewport, { startSec: 0, endSec: 12 }, 100)).toEqual({
      startSec: 10,
      endSec: 13,
      startPx: 0,
      endPx: 300,
    })
    expect(visibleIntersectionWithOverscan(viewport, { startSec: 30, endSec: 40 }, 100)).toBeNull()
  })

  test('keeps a pointer time fixed while changing scale', () => {
    const next = scaleViewportAtPointer(viewport, 250, 200)
    expect(viewportXToTime(next, 250)).toBe(12.5)
    expect(next.pixelsPerSecond).toBe(200)
  })

  test('calculates a bounded physical runway and a recenter point', () => {
    const runway = calculateBoundedPhysicalRunway({
      visibleStartSec: 1000,
      viewportWidthPx: 1000,
      pixelsPerSecond: 100,
      maxRunwayWidthPx: 4000,
    })
    expect(runway.widthPx).toBe(4000)
    expect(runway.visibleStartPx).toBe(1500)
    expect(runway.visibleEndPx).toBe(2500)
    expect(runway.recenteredStartSec).toBe(985)
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
    const runway = calculateBoundedPhysicalRunway({
      visibleStartSec: projected.visibleRange.startSec,
      viewportWidthPx: projected.width,
      pixelsPerSecond: projected.pixelsPerSecond,
      maxRunwayWidthPx: 200_000,
    })
    expect(projected.width).toBe(1000)
    expect(runway.widthPx).toBe(200_000)
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
