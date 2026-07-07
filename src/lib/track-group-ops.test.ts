import { describe, expect, test } from 'bun:test'
import type { Track } from '@daw-browser/timeline-core/types'
import {
  normalizeDragMoveSet,
  planAssignGroupColor,
  planGroupTracks,
  planMoveTrackToGroup,
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

const clip = (input: Pick<Track['clips'][number], 'id' | 'startSec' | 'duration' | 'color'>): Track['clips'][number] => ({
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

  test('planAssignGroupColor updates descendants and clips', () => {
    expect(planAssignGroupColor([
      track({ id: 'g', channelRole: 'group', color: '#f00' }),
      track({ id: 'a', groupId: 'g', color: '#0f0', clips: [clip({ id: 'c', startSec: 0, duration: 1, color: '#00f' })] }),
      track({ id: 'b', groupId: 'g', color: '#f00', clips: [clip({ id: 'd', startSec: 0, duration: 1, color: '#f00' })] }),
    ], 'g')).toEqual({
      trackUpdates: [{ trackId: 'a', from: '#0f0', to: '#f00' }],
      clipUpdates: [{ clipId: 'c', trackId: 'a', from: '#00f', to: '#f00' }],
    })
    expect(planAssignGroupColor([track({ id: 'g', channelRole: 'group' })], 'g')).toBeNull()
  })
})
