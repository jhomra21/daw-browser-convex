import { describe, expect, test } from 'bun:test'
import { isClipWithinRenderRange } from './clip-render-range'

describe('TrackLane clip render range', () => {
  test('keeps nearby clips mounted through viewport transitions, then disposes them after overscan exit', () => {
    const clip = { startSec: 0, duration: 2 }
    const strictVisibleRange = { startSec: 3, endSec: 27 }
    const clipVisibleRange = { startSec: 0, endSec: 30 }
    const outsideOverscanRange = { startSec: 3, endSec: 33 }

    expect(isClipWithinRenderRange(clip, clipVisibleRange)).toBe(true)
    expect(isClipWithinRenderRange(clip, strictVisibleRange)).toBe(false)
    expect(isClipWithinRenderRange(clip, outsideOverscanRange)).toBe(false)
  })
})
