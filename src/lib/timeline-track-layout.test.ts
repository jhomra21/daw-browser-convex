import { describe, expect, test } from 'bun:test'
import { buildGroupClipOverview, buildTimelineTrackLayout, buildTimelineTrackLayoutRows, buildTrackTree, computeDepthMap, flattenVisibleTracks, trackIdsInYRange, trackIndexAtY, trackLayoutRowAtY, wouldCreateCycle } from './timeline-track-layout'
import type { Track } from '@daw-browser/timeline-core/types'
import { COLLAPSED_LANE_HEIGHT, LANE_HEIGHT } from '~/lib/timeline-utils'

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

  test('buildTimelineTrackLayoutRows preserves reordered visible row order and excludes collapsed descendants from hit testing', () => {
    const tracks = [track('b'), track('g', undefined, true), track('a', 'g'), track('c')]
    const tree = buildTrackTree(tracks)
    const visibleTrackIds = flattenVisibleTracks(tree, { g: true })
    const rows = buildTimelineTrackLayoutRows({
      tracks,
      visibleTrackIds,
      depthByTrackId: computeDepthMap(tree),
      visibleByTrackId: {},
      heightsByLaneOwnerKey: {},
      visibleParameterIdsByTrackId: {},
    })

    expect(rows.map((row) => row.trackId)).toEqual(['b', 'g', 'c'])
    expect(trackLayoutRowAtY(rows, 0)?.trackId).toBe('b')
    expect(trackLayoutRowAtY(rows, LANE_HEIGHT)?.trackId).toBe('g')
    expect(trackLayoutRowAtY(rows, LANE_HEIGHT + COLLAPSED_LANE_HEIGHT)?.trackId).toBe('c')
    expect(rows.some((row) => row.trackId === 'a')).toBe(false)
  })

  test('collapsed track uses slim row and suppresses automation height', () => {
    const rows = buildTimelineTrackLayoutRows({
      tracks: [track('a', undefined, true), track('b')],
      visibleByTrackId: { a: true, b: true },
      heightsByLaneOwnerKey: { a: 48, b: 48 },
      visibleParameterIdsByTrackId: { a: ['volume'], b: ['volume'] },
    })
    expect(rows[0]?.heightPx).toBe(COLLAPSED_LANE_HEIGHT)
    expect(rows[0]?.clipLaneHeightPx).toBe(COLLAPSED_LANE_HEIGHT)
    expect(rows[0]?.automationHeightPx).toBe(0)
    expect(rows[1]?.topPx).toBe(COLLAPSED_LANE_HEIGHT)
    expect(rows[1]?.heightPx).toBe(LANE_HEIGHT + 48)
  })

  test('partitions Return tracks into an independent zero-based layout', () => {
    const normal = track('normal')
    const returnTrack: Track = { ...track('return', undefined, true), channelRole: 'return' }
    const layout = buildTimelineTrackLayout({
      tracks: [returnTrack, normal],
      visibleTrackIds: ['return', 'normal'],
      visibleByTrackId: { return: true },
      heightsByLaneOwnerKey: { return: 48 },
      visibleParameterIdsByTrackId: { return: ['volume'] },
    })

    expect(layout.displayTrackIds).toEqual(['normal', 'return'])
    expect(layout.scrollingRows[0]?.topPx).toBe(0)
    expect(layout.returnRows[0]?.topPx).toBe(0)
    expect(layout.returnRows[0]?.automationHeightPx).toBe(0)
    expect(layout.returnHeightPx).toBe(COLLAPSED_LANE_HEIGHT)
  })

  test('keeps expanded Return automation in the sticky layout', () => {
    const normal = track('normal')
    const returnTrack: Track = { ...track('return'), channelRole: 'return', collapsed: false }
    const layout = buildTimelineTrackLayout({
      tracks: [returnTrack, normal],
      visibleTrackIds: ['return', 'normal'],
      visibleByTrackId: { return: true },
      heightsByLaneOwnerKey: { return: 48 },
      visibleParameterIdsByTrackId: { return: ['volume', 'pan'] },
    })

    expect(layout.returnRows[0]).toMatchObject({
      trackId: 'return',
      topPx: 0,
      automationHeightPx: 96,
      heightPx: LANE_HEIGHT + 96,
    })
    expect(layout.returnHeightPx).toBe(LANE_HEIGHT + 96)
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
    expect(buildGroupClipOverview('g', [track('g'), child])).toEqual([{ startSec: 0, endSec: 3, color: 'clip-audio' }])
  })
})
