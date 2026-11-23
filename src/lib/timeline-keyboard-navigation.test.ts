import { describe, expect, test } from 'bun:test'

import {
  adjacentClipOnTrack,
  clampNudgeDeltaSec,
  nearestClipOnAdjacentTrack,
  nudgeLoopRegion,
  resizeLoopRegionEnd,
  resolveClipNavigationTarget,
  resolveClipTabStopId,
  stepPlayheadSec,
} from './timeline-keyboard-navigation'

const clip = (id: string, startSec: number) => ({ id, startSec })

const tracks = [
  { id: 't1', clips: [clip('b', 4), clip('a', 0)] },
  { id: 't2', clips: [] },
  { id: 't3', collapsed: true, clips: [clip('hidden', 1)] },
  { id: 't4', clips: [clip('c', 1), clip('d', 6)] },
]

describe('clip nudge', () => {
  test('moves the whole selection by the requested step', () => {
    expect(clampNudgeDeltaSec([2, 5], 0.5)).toBe(0.5)
    expect(clampNudgeDeltaSec([2, 5], -0.5)).toBe(-0.5)
  })

  test('clamps at zero without breaking the spacing of a multi selection', () => {
    expect(clampNudgeDeltaSec([0.25, 3], -0.5)).toBe(-0.25)
    expect(clampNudgeDeltaSec([0, 3], -0.5)).toBe(0)
  })
})

describe('roving tab stop', () => {
  test('prefers the primary selected clip', () => {
    expect(resolveClipTabStopId(tracks, 'd')).toBe('d')
  })

  test('falls back to the first clip in track then time order', () => {
    expect(resolveClipTabStopId(tracks, null)).toBe('a')
    expect(resolveClipTabStopId(tracks, 'gone')).toBe('a')
  })

  test('only considers clips that are rendered, so the tab stop always exists on screen', () => {
    const rendered = (clipId: string) => clipId === 'c' || clipId === 'd'

    expect(resolveClipTabStopId(tracks, 'a', rendered)).toBe('c')
    expect(resolveClipTabStopId(tracks, 'd', rendered)).toBe('d')
  })

  test('is undefined for an empty arrangement', () => {
    expect(resolveClipTabStopId([{ id: 't', clips: [] }], null)).toBeUndefined()
  })
})

describe('adjacent clip navigation', () => {
  test('walks the same track in time order and stops at the ends', () => {
    expect(adjacentClipOnTrack(tracks[0], 'a', 1)).toBe('b')
    expect(adjacentClipOnTrack(tracks[0], 'b', -1)).toBe('a')
    expect(adjacentClipOnTrack(tracks[0], 'a', -1)).toBeUndefined()
    expect(adjacentClipOnTrack(tracks[0], 'b', 1)).toBeUndefined()
  })

  test('picks the clip on the neighbouring track nearest in time, skipping empty and collapsed tracks', () => {
    expect(nearestClipOnAdjacentTrack(tracks, 'b', 1)).toEqual({ trackId: 't4', clipId: 'd' })
    expect(nearestClipOnAdjacentTrack(tracks, 'a', 1)).toEqual({ trackId: 't4', clipId: 'c' })
    expect(nearestClipOnAdjacentTrack(tracks, 'd', -1)).toEqual({ trackId: 't1', clipId: 'b' })
  })

  test('returns nothing past the first or last track', () => {
    expect(nearestClipOnAdjacentTrack(tracks, 'a', -1)).toBeUndefined()
    expect(nearestClipOnAdjacentTrack(tracks, 'd', 1)).toBeUndefined()
    expect(nearestClipOnAdjacentTrack(tracks, 'missing', 1)).toBeUndefined()
  })
})

describe('clip navigation target', () => {
  test('alt+left/right stays on the track, alt+up/down changes track', () => {
    expect(resolveClipNavigationTarget(tracks, 'a', 'time', 1)).toEqual({ trackId: 't1', clipId: 'b' })
    expect(resolveClipNavigationTarget(tracks, 'a', 'time', -1)).toBeUndefined()
    expect(resolveClipNavigationTarget(tracks, 'a', 'track', 1)).toEqual({ trackId: 't4', clipId: 'c' })
    expect(resolveClipNavigationTarget(tracks, 'missing', 'time', 1)).toBeUndefined()
  })
})

describe('loop brace keyboard edits', () => {
  const loop = { startSec: 2, endSec: 4 }

  test('nudges the brace by the grid and keeps its length', () => {
    expect(nudgeLoopRegion(loop, 0.5, 1, 30)).toEqual({ startSec: 2.5, endSec: 4.5 })
    expect(nudgeLoopRegion(loop, 0.5, -1, 30)).toEqual({ startSec: 1.5, endSec: 3.5 })
  })

  test('does not nudge before zero or past the arrangement end', () => {
    expect(nudgeLoopRegion({ startSec: 0.25, endSec: 2.25 }, 0.5, -1, 30)).toEqual({ startSec: 0, endSec: 2 })
    expect(nudgeLoopRegion({ startSec: 27.5, endSec: 29.75 }, 0.5, 1, 30)).toEqual({ startSec: 27.75, endSec: 30 })
  })

  test('lengthens and shortens by the grid with a minimum of one step', () => {
    expect(resizeLoopRegionEnd(loop, 0.5, 1)).toEqual({ startSec: 2, endSec: 4.5 })
    expect(resizeLoopRegionEnd(loop, 0.5, -1)).toEqual({ startSec: 2, endSec: 3.5 })
    expect(resizeLoopRegionEnd({ startSec: 2, endSec: 2.75 }, 0.5, -1)).toEqual({ startSec: 2, endSec: 2.5 })
    expect(resizeLoopRegionEnd({ startSec: 2, endSec: 2.5 }, 0.5, -1)).toEqual({ startSec: 2, endSec: 2.5 })
  })
})

describe('playhead step', () => {
  test('moves by the grid step inside the arrangement', () => {
    expect(stepPlayheadSec(1, 0.5, 1, 30)).toBe(1.5)
    expect(stepPlayheadSec(0.25, 0.5, -1, 30)).toBe(0)
    expect(stepPlayheadSec(29.9, 0.5, 1, 30)).toBe(30)
  })
})
