import { describe, expect, test } from 'bun:test'
import type { Track } from '@daw-browser/timeline-core/types'
import {
  normalizeDragMoveSet,
  planAssignTrackColorToClips,
  planGroupTracks,
  planMoveTrackToGroup,
  planResetClipColors,
  planSetTrackColor,
  planTrackReorder,
  planUngroupTracks,
  resolveTrackDropZone,
} from './track-group-ops'

type TestTrackInput = Pick<Track, 'id'> & Partial<Track> & { index?: number }
type TestTrack = Track & { index?: number }
type ReorderTrack = Track & { index: number }

const track = (input: TestTrackInput): TestTrack => ({
  name: input.id,
  volume: 1,
  clips: [],
  ...input,
})

const reorderTrack = (input: Pick<Track, 'id'> & Partial<Track> & { index: number }): ReorderTrack => ({
  name: input.id,
  volume: 1,
  clips: [],
  ...input,
})

const clip = (input: Pick<Track['clips'][number], 'id' | 'startSec' | 'duration' | 'color'> & Partial<Track['clips'][number]>): Track['clips'][number] => ({
  name: input.id,
  ...input,
})

describe('track group operations', () => {
  test('planGroupTracks chooses first selected index and preserves custom routing', () => {
    const plan = planGroupTracks({
      tracks: [
        track({ id: 'a' }),
        track({ id: 'b', outputTargetId: 'custom' }),
      ],
      selectedTrackIds: ['b', 'a'],
      groupTrackId: 'g',
    })
    expect(plan?.groupTrack.index).toBe(0)
    expect(plan?.childUpdates).toEqual([
      { trackId: 'a', groupId: 'g', outputTargetId: 'g' },
      { trackId: 'b', groupId: 'g', outputTargetId: 'custom' },
    ])
  })

  test('planGroupTracks rejects return tracks', () => {
    expect(planGroupTracks({
      tracks: [track({ id: 'r', channelRole: 'return' })],
      selectedTrackIds: ['r'],
      groupTrackId: 'g',
    })).toBeNull()
  })

  test('planGroupTracks reroutes old automatic group outputs to the new group', () => {
    const plan = planGroupTracks({
      tracks: [
        track({ id: 'a', groupId: 'old-g', outputTargetId: 'old-g' }),
        track({ id: 'old-g', channelRole: 'group' }),
      ],
      selectedTrackIds: ['a'],
      groupTrackId: 'new-g',
    })
    expect(plan?.childUpdates).toEqual([
      { trackId: 'a', groupId: 'new-g', outputTargetId: 'new-g' },
    ])
  })

  test('planUngroupTracks resets output only when output targets the group', () => {
    expect(planUngroupTracks({
      tracks: [
        track({ id: 'a', groupId: 'g', outputTargetId: 'g' }),
        track({ id: 'b', groupId: 'g', outputTargetId: 'custom' }),
      ],
      groupId: 'g',
    }).childUpdates).toEqual([
      { trackId: 'a', groupId: undefined, outputTargetId: undefined },
      { trackId: 'b', groupId: undefined, outputTargetId: 'custom' },
    ])
  })

  test('planMoveTrackToGroup rejects cycles and non-group parents', () => {
    expect(planMoveTrackToGroup({
      tracks: [track({ id: 'g', channelRole: 'group' }), track({ id: 'a', groupId: 'g' })],
      trackId: 'g',
      groupId: 'a',
    })).toBeNull()
    expect(planMoveTrackToGroup({
      tracks: [track({ id: 'a' }), track({ id: 'b' })],
      trackId: 'a',
      groupId: 'b',
    })).toBeNull()
  })

  test('resolveTrackDropZone resolves edges and group interior', () => {
    expect(resolveTrackDropZone({ localY: 4, rowHeightPx: 64, targetIsGroup: true })).toBe('above')
    expect(resolveTrackDropZone({ localY: 60, rowHeightPx: 64, targetIsGroup: true })).toBe('below')
    expect(resolveTrackDropZone({ localY: 32, rowHeightPx: 64, targetIsGroup: true })).toBe('inside')
  })

  test('normalizeDragMoveSet removes descendants of selected parents', () => {
    expect(normalizeDragMoveSet([
      track({ id: 'g' }),
      track({ id: 'a', groupId: 'g' }),
      track({ id: 'b' }),
    ], new Set(['g', 'a', 'b']))).toEqual(['g', 'b'])
  })

  test('planTrackReorder moves a track above another track', () => {
    expect(planTrackReorder({
      tracks: [reorderTrack({ id: 'a', index: 0 }), reorderTrack({ id: 'b', index: 1 })],
      moveRootIds: ['b'],
      target: { trackId: 'a', zone: 'above' },
    })?.patches).toEqual([
      { trackId: 'b', index: 0, groupId: undefined, outputTargetId: undefined },
      { trackId: 'a', index: 1, groupId: undefined, outputTargetId: undefined },
    ])
  })

  test('planTrackReorder moves multiple root tracks together', () => {
    expect(planTrackReorder({
      tracks: [
        reorderTrack({ id: 'a', index: 0 }),
        reorderTrack({ id: 'b', index: 1 }),
        reorderTrack({ id: 'c', index: 2 }),
        reorderTrack({ id: 'd', index: 3 }),
      ],
      moveRootIds: ['b', 'd'],
      target: { trackId: 'a', zone: 'above' },
    })?.patches.map((patch) => [patch.trackId, patch.index])).toEqual([
      ['b', 0],
      ['d', 1],
      ['a', 2],
      ['c', 3],
    ])
  })

  test('planTrackReorder inserts below a group after its descendants', () => {
    expect(planTrackReorder({
      tracks: [
        reorderTrack({ id: 'c', index: 0 }),
        reorderTrack({ id: 'g', index: 1, channelRole: 'group' }),
        reorderTrack({ id: 'a', index: 2, groupId: 'g' }),
        reorderTrack({ id: 'b', index: 3, groupId: 'g' }),
      ],
      moveRootIds: ['c'],
      target: { trackId: 'g', zone: 'below' },
    })?.patches.map((patch) => [patch.trackId, patch.index])).toEqual([
      ['g', 0],
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ])
  })

  test('planTrackReorder rejects inside drops on non-group tracks', () => {
    expect(planTrackReorder({
      tracks: [reorderTrack({ id: 'a', index: 0 }), reorderTrack({ id: 'b', index: 1 })],
      moveRootIds: ['a'],
      target: { trackId: 'b', zone: 'inside' },
    })).toBeNull()
  })

  test('planTrackReorder allows return tracks to be reordered', () => {
    expect(planTrackReorder({
      tracks: [
        reorderTrack({ id: 'a', index: 0 }),
        reorderTrack({ id: 'r', index: 1, channelRole: 'return' }),
      ],
      moveRootIds: ['r'],
      target: { trackId: 'a', zone: 'above' },
    })?.patches).toEqual([
      { trackId: 'r', index: 0, groupId: undefined, outputTargetId: undefined },
      { trackId: 'a', index: 1, groupId: undefined, outputTargetId: undefined },
    ])
  })

  test('planTrackReorder rejects drops targeting moved subtree descendants', () => {
    expect(planTrackReorder({
      tracks: [
        reorderTrack({ id: 'g', index: 0, channelRole: 'group' }),
        reorderTrack({ id: 'a', index: 1, groupId: 'g' }),
        reorderTrack({ id: 'b', index: 2 }),
      ],
      moveRootIds: ['g'],
      target: { trackId: 'a', zone: 'below' },
    })).toBeNull()
  })

  test('planTrackReorder moves subtrees and rejects cycles', () => {
    expect(planTrackReorder({
      tracks: [
        reorderTrack({ id: 'g', index: 0, channelRole: 'group' }),
        reorderTrack({ id: 'a', index: 1, groupId: 'g' }),
        reorderTrack({ id: 'b', index: 2 }),
      ],
      moveRootIds: ['g'],
      target: { trackId: 'b', zone: 'below' },
    })?.patches.map((patch) => [patch.trackId, patch.index])).toEqual([['b', 0], ['g', 1], ['a', 2]])
    expect(planTrackReorder({
      tracks: [
        reorderTrack({ id: 'g', index: 0, channelRole: 'group' }),
        reorderTrack({ id: 'a', index: 1, groupId: 'g' }),
      ],
      moveRootIds: ['g'],
      target: { trackId: 'a', zone: 'inside' },
    })).toBeNull()
  })

  test('planTrackReorder reparents inside collapsed groups and expands target', () => {
    expect(planTrackReorder({
      tracks: [
        reorderTrack({ id: 'a', index: 0 }),
        reorderTrack({ id: 'g', index: 1, channelRole: 'group', collapsed: true }),
      ],
      moveRootIds: ['a'],
      target: { trackId: 'g', zone: 'inside' },
    })).toEqual({
      patches: [
        { trackId: 'g', index: 0, groupId: undefined, outputTargetId: undefined },
        { trackId: 'a', index: 1, groupId: 'g', outputTargetId: 'g' },
      ],
      expandGroupIds: ['g'],
    })
  })

  test('planSetTrackColor cascades group colors to descendant tracks and clips', () => {
    expect(planSetTrackColor([
      track({ id: 'g', channelRole: 'group', color: '#f00' }),
      track({ id: 'a', groupId: 'g', color: '#0f0', clips: [clip({ id: 'c', startSec: 0, duration: 1, color: '#00f' })] }),
      track({ id: 'b', groupId: 'g', color: '#f00', clips: [clip({ id: 'd', startSec: 0, duration: 1, color: '#f00' })] }),
    ], 'g', '#f00')).toEqual({
      trackUpdates: [{ trackId: 'a', from: '#0f0', to: '#f00' }],
      clipUpdates: [{ clipId: 'c', trackId: 'a', from: '#00f', to: '#f00' }],
    })
    expect(planSetTrackColor([track({ id: 'g', channelRole: 'group', color: '#f00' })], 'g', undefined)).toEqual({
      trackUpdates: [{ trackId: 'g', from: '#f00', to: undefined }],
      clipUpdates: [],
    })
    expect(planSetTrackColor([
      track({ id: 'a', color: '#0f0', clips: [clip({ id: 'c', startSec: 0, duration: 1, color: '#00f' })] }),
    ], 'a', '#f00')).toEqual({
      trackUpdates: [{ trackId: 'a', from: '#0f0', to: '#f00' }],
      clipUpdates: [],
    })
    expect(planSetTrackColor([
      track({ id: 'g', channelRole: 'group', color: '#0f0' }),
      track({ id: 'a', groupId: 'g', color: '#0f0', clips: [clip({ id: 'c', startSec: 0, duration: 1, color: '#00f' })] }),
    ], 'g', 'timeline-surface')).toEqual({
      trackUpdates: [
        { trackId: 'g', from: '#0f0', to: 'timeline-surface' },
        { trackId: 'a', from: '#0f0', to: 'timeline-surface' },
      ],
      clipUpdates: [],
    })
    expect(planSetTrackColor([track({ id: 'g', channelRole: 'group' })], 'missing', '#f00')).toBeNull()
  })

  test('planAssignTrackColorToClips explicitly assigns track colors to clips', () => {
    expect(planAssignTrackColorToClips([
      track({ id: 'g', channelRole: 'group', color: '#f00' }),
      track({ id: 'a', groupId: 'g', color: '#0f0', clips: [clip({ id: 'c', startSec: 0, duration: 1, color: '#00f' })] }),
      track({ id: 'b', groupId: 'g', color: '#f00', clips: [clip({ id: 'd', startSec: 0, duration: 1, color: '#f00' })] }),
    ], 'g')).toEqual({
      clipUpdates: [{ clipId: 'c', trackId: 'a', from: '#00f', to: '#0f0' }],
    })
    expect(planAssignTrackColorToClips([track({ id: 'a', clips: [clip({ id: 'c', startSec: 0, duration: 1, color: 'clip-audio' })] })], 'a')).toBeNull()
    expect(planAssignTrackColorToClips([track({ id: 'a', color: 'timeline-surface', clips: [clip({ id: 'c', startSec: 0, duration: 1, color: '#00f' })] })], 'a')).toBeNull()
    expect(planAssignTrackColorToClips([track({ id: 'a', color: '#f00', clips: [clip({ id: 'c', startSec: 0, duration: 1, color: '#f00' })] })], 'a')).toBeNull()
  })

  test('planResetClipColors restores source-kind default clip colors', () => {
    expect(planResetClipColors([
      track({ id: 'g', channelRole: 'group' }),
      track({ id: 'a', groupId: 'g', clips: [clip({ id: 'c', startSec: 0, duration: 1, color: '#00f' })] }),
      track({ id: 'b', groupId: 'g', clips: [clip({ id: 'd', startSec: 0, duration: 1, color: 'clip-audio' })] }),
    ], 'g')).toEqual({
      clipUpdates: [{ clipId: 'c', trackId: 'a', from: '#00f', to: 'clip-audio' }],
    })
    expect(planResetClipColors([
      track({ id: 'a', clips: [clip({ id: 'c', startSec: 0, duration: 1, color: '#f00', sourceKind: 'recording' })] }),
    ], 'a')).toEqual({
      clipUpdates: [{ clipId: 'c', trackId: 'a', from: '#f00', to: 'clip-recording' }],
    })
    expect(planResetClipColors([track({ id: 'a', clips: [clip({ id: 'c', startSec: 0, duration: 1, color: 'clip-audio' })] })], 'a')).toBeNull()
  })
})
