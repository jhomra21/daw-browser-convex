import { describe, expect, test } from 'bun:test'
import type { Track } from '@daw-browser/timeline-core/types'
import { planGroupTracks, planMoveTrackToGroup, planUngroupTracks } from './track-group-ops'

const track = (input: Pick<Track, 'id'> & Partial<Track>): Track => ({
  name: input.id,
  volume: 1,
  clips: [],
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
})
