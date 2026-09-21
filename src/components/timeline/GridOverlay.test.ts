import { describe, expect, test } from 'bun:test'
import { selectTimelineGridIntervals } from '~/lib/timeline-view'
import { timelineGridPhasePx } from '~/lib/timeline-grid-phase'

describe('GridOverlay phase projection', () => {
  test('keeps the grid phase bounded and aligned to the canonical major interval', () => {
    const pixelsPerSecond = 480_000
    const intervals = selectTimelineGridIntervals(pixelsPerSecond, 120, 4, true)
    const phase = timelineGridPhasePx(1_000_000, pixelsPerSecond, intervals.majorSec)
    const initial = timelineGridPhasePx(12.5, 100, intervals.majorSec)
    const panned = timelineGridPhasePx(12.75, 100, intervals.majorSec)

    expect(phase).toBeGreaterThan(-intervals.majorSec * pixelsPerSecond)
    expect(phase).toBeLessThanOrEqual(0)
    expect(panned - initial).toBeCloseTo(-25)
  })
})
