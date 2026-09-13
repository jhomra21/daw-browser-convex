import { describe, expect, test } from 'bun:test'
import { createWaveformRequestPlans, densityBucketFor } from './retained-waveform'

describe('retained waveform request density', () => {
  test('holds density inside the hysteresis band', () => {
    expect(densityBucketFor(1_100, 1_000)).toBe(1_000)
  })

  test('refines only when a bucket boundary is crossed', () => {
    expect(densityBucketFor(1_600, 1_000)).toBe(1_600)
    expect(densityBucketFor(20_000, 1_500)).toBe(4_096)
  })

  test('converges immediately for large zoom changes and downshifts', () => {
    expect(densityBucketFor(4_000, 100)).toBe(4_000)
    expect(densityBucketFor(2_000, 1_000)).toBe(2_000)
    expect(densityBucketFor(400, 1_000)).toBe(400)
  })

  test('shares one tile request while retaining canonical segment boundaries', () => {
    const result = createWaveformRequestPlans({
      sampleRate: 48_000,
      sourceDurationSec: 2,
      sampleDetail: false,
      segments: [
        {
          drawCols: 100,
          sourceStartSec: 0.1,
          sourceEndSec: 0.2,
          startPx: 0,
          endPx: 100,
          canvasStartSec: 0,
          canvasEndSec: 1,
        },
        {
          drawCols: 100,
          sourceStartSec: 0.2,
          sourceEndSec: 0.3,
          startPx: 100,
          endPx: 200,
          canvasStartSec: 1,
          canvasEndSec: 2,
        },
      ],
    })
    expect(result.requests).toHaveLength(1)
    expect(result.segments).toHaveLength(2)
    expect(result.segments.map((item) => [
      item.segment.sourceStartSec,
      item.segment.sourceEndSec,
    ])).toEqual([[0.1, 0.2], [0.2, 0.3]])
    expect(new Set(result.segments.map((item) => item.requestKey)).size).toBe(1)
  })
})
