import { describe, expect, test } from 'bun:test'
import { selectTimelineGridIntervals } from './timeline-view'
import { timelineGridPhasePx } from './timeline-grid-phase'

const phaseDistance = (from: number, to: number, period: number) => (
  ((to - from) % period + period) % period
)

describe('timeline grid phase', () => {
  test('advances with logical pan instead of the physical runway', () => {
    const pixelsPerSecond = 100
    const stepSec = 0.5
    const periodPx = stepSec * pixelsPerSecond
    const initial = timelineGridPhasePx(12.5, pixelsPerSecond, stepSec)
    const next = timelineGridPhasePx(12.75, pixelsPerSecond, stepSec)

    expect(next - initial).toBe(-25)
    expect(phaseDistance(initial, next, periodPx)).toBe(25)
  })

  test('keeps phase bounded at deep zoom', () => {
    const phase = timelineGridPhasePx(1_000_000, 480_000, 0.0005)

    expect(phase).toBeGreaterThan(-240)
    expect(phase).toBeLessThanOrEqual(0)
  })

  test('uses the canonical adaptive major interval for ruler and grid', () => {
    const intervals = selectTimelineGridIntervals(100, 120, 4, true)

    expect(timelineGridPhasePx(3.125, 100, intervals.majorSec)).toBe(
      -((3.125 * 100) % (intervals.majorSec * 100)),
    )
  })
})
