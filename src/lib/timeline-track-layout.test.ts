import { describe, expect, test } from 'bun:test'
import { buildGroupClipOverview, buildTimelineTrackLayoutRows, buildTrackTree, computeDepthMap, flattenVisibleTracks, trackIdsInYRange, trackIndexAtY, trackLayoutRowAtY, wouldCreateCycle } from './timeline-track-layout'
import type { Track } from '@daw-browser/timeline-core/types'

const track = (id: string, groupId?: string, collapsed?: boolean): Track => ({
  id,
  name: id,
  volume: 1,
  clips: [],
  groupId,
  collapsed,
})

describe('timeline track layout grouping', () => {
  test('buildTrackTree preserves flat order', () => {
    const tree = buildTrackTree([track('a'), track('g'), track('b', 'g'), track('c')])
    expect(tree.map((node) => node.trackId)).toEqual(['a', 'g', 'c'])
    expect(tree[1]?.children.map((node) => node.trackId)).toEqual(['b'])
  })

  test('flattenVisibleTracks hides descendants of collapsed groups', () => {
    const tree = buildTrackTree([track('g', undefined, true), track('a', 'g'), track('b')])
    expect(flattenVisibleTracks(tree, { g: true })).toEqual(['g', 'b'])
  })

  test('computeDepthMap handles nested groups', () => {
    const depths = computeDepthMap(buildTrackTree([track('g'), track('nested', 'g'), track('a', 'nested')]))
    expect(depths.get('g')).toBe(0)
    expect(depths.get('nested')).toBe(1)
    expect(depths.get('a')).toBe(2)
  })

  test('wouldCreateCycle rejects invalid parent assignments', () => {
    expect(wouldCreateCycle([track('g'), track('a', 'g')], 'g', 'a')).toBe(true)
    expect(wouldCreateCycle([track('g'), track('a')], 'a', 'g')).toBe(false)
  })

  test('buildTimelineTrackLayoutRows emits only visible rows', () => {
    const rows = buildTimelineTrackLayoutRows({
      tracks: [track('g'), track('a', 'g'), track('b')],
      visibleTrackIds: ['g', 'b'],
      visibleByTrackId: {},
      heightsByLaneOwnerKey: {},
      visibleParameterIdsByTrackId: {},
    })
    expect(rows.map((row) => row.trackId)).toEqual(['g', 'b'])
    expect(trackIndexAtY(rows, 1)).toBe(0)
    expect(trackIdsInYRange(rows, 0, 160)).toEqual(['g', 'b'])
  })

  test('trackLayoutRowAtY finds rows by y position', () => {
    const rows = buildTimelineTrackLayoutRows({
      tracks: [track('a'), track('b'), track('c')],
      visibleByTrackId: { b: true },
      heightsByLaneOwnerKey: { b: 48 },
      visibleParameterIdsByTrackId: {},
    })

    expect(trackLayoutRowAtY(rows, 0)?.trackId).toBe('a')
    expect(trackLayoutRowAtY(rows, 95)?.trackId).toBe('a')
    expect(trackLayoutRowAtY(rows, 96)?.trackId).toBe('b')
    expect(trackLayoutRowAtY(rows, 239)?.trackId).toBe('b')
    expect(trackLayoutRowAtY(rows, 240)?.trackId).toBe('c')
    expect(trackLayoutRowAtY(rows, -1)).toBeUndefined()
    expect(trackLayoutRowAtY(rows, 336)).toBeUndefined()
    expect(trackIndexAtY(rows, 96)).toBe(1)
    expect(trackIndexAtY(rows, 336)).toBe(-1)
  })

  test('buildGroupClipOverview merges descendant clip ranges', () => {
    const child = track('a', 'g')
    child.clips = [
      { id: 'c1', name: 'c1', startSec: 0, duration: 2, color: 'clip-audio' },
      { id: 'c2', name: 'c2', startSec: 1, duration: 2, color: 'clip-audio' },
    ]
    expect(buildGroupClipOverview('g', [track('g'), child])).toEqual([{ startSec: 0, endSec: 3 }])
  })
})
