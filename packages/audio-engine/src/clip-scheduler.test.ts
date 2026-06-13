import { describe, expect, test } from 'bun:test'
import { clipSchedulerTestInternals } from './clip-scheduler'

describe('clip scheduler stretch render horizon', () => {
  test('pre-renders all scheduled stretched clips with the default unbounded horizon', () => {
    expect(clipSchedulerTestInternals.shouldEnsureStretchRender({
      playheadSec: 10,
      renderAheadSec: clipSchedulerTestInternals.defaultStretchRenderAheadSec,
      timelineStartSec: 120,
      timelineDurationSec: 4,
    })).toBe(true)
  })

  test('pre-renders stretched clips inside the live horizon', () => {
    expect(clipSchedulerTestInternals.shouldEnsureStretchRender({
      playheadSec: 10,
      renderAheadSec: 30,
      timelineStartSec: 35,
      timelineDurationSec: 4,
    })).toBe(true)
  })

  test('does not pre-render stretched clips beyond the live horizon', () => {
    expect(clipSchedulerTestInternals.shouldEnsureStretchRender({
      playheadSec: 10,
      renderAheadSec: 30,
      timelineStartSec: 40,
      timelineDurationSec: 4,
    })).toBe(false)
  })

  test('uses loop end as the live horizon when it is sooner', () => {
    expect(clipSchedulerTestInternals.shouldEnsureStretchRender({
      playheadSec: 10,
      renderAheadSec: 30,
      endLimitSec: 24,
      timelineStartSec: 25,
      timelineDurationSec: 4,
    })).toBe(false)
  })

  test('pre-renders stretched clips already overlapping the playhead', () => {
    expect(clipSchedulerTestInternals.shouldEnsureStretchRender({
      playheadSec: 10,
      renderAheadSec: 30,
      timelineStartSec: 8,
      timelineDurationSec: 4,
    })).toBe(true)
  })
})
