import { expect, test } from 'bun:test'

import { planTrackReorder } from '~/lib/track-group-ops'
import { buildTimelineTrackRow } from '~/lib/timeline-repository/track-row-builder'
import { toLocalTimelineTrack } from '~/lib/timeline-repository/track-row-adapter'
import type { TimelineTrackRow } from '~/lib/timeline-repository/types'
import type { Track } from '@daw-browser/timeline-core/types'
import { projectLocalTrackCreation } from './useTimelineActions'

const localTrack = (
  id: string,
  index: number,
  options: { channelRole?: 'track' | 'return' | 'group'; groupId?: string } = {},
) => toLocalTimelineTrack(buildTimelineTrackRow({
  id,
  index,
  channelRole: options.channelRole,
  groupId: options.groupId,
  timestamp: 1,
}))

const projectCreation = (
  current: Array<{ track: Track; index: number }>,
  created: Track,
  creationIndex: number,
  canonicalRows: TimelineTrackRow[],
) => {
  let projected = current
  projectLocalTrackCreation(
    current.map((entry) => entry.track),
    created,
    creationIndex,
    canonicalRows,
    (track, index, patch) => {
      projected = projected.map((entry) => entry.track.id === track.id
        ? {
          index: patch.index ?? index,
          track: { ...entry.track, ...patch },
        }
        : entry)
    },
    (track, index) => {
      projected = [...projected, { track, index }]
        .sort((left, right) => left.index - right.index)
    },
  )
  return projected
}

test('projects local creation repairs immediately so canonical tracks can reorder', () => {
  const initial = [
    { track: localTrack('normal-a', 0, { groupId: 'group-a' }), index: 0 },
    { track: localTrack('return-a', 1, { channelRole: 'return' }), index: 1 },
    { track: localTrack('normal-b', 2), index: 2 },
    { track: localTrack('return-b', 3, { channelRole: 'return', groupId: 'legacy-group' }), index: 3 },
  ]
  const normal = localTrack('normal-new', 2)
  const afterNormal = projectCreation(initial, normal, 2, [
    buildTimelineTrackRow({ id: 'normal-a', index: 0, groupId: 'group-a', timestamp: 1 }),
    buildTimelineTrackRow({ id: 'normal-b', index: 1, timestamp: 1 }),
    buildTimelineTrackRow({ id: 'normal-new', index: 2, timestamp: 1 }),
    buildTimelineTrackRow({ id: 'return-a', index: 3, channelRole: 'return', timestamp: 1 }),
    buildTimelineTrackRow({ id: 'return-b', index: 4, channelRole: 'return', timestamp: 1 }),
  ])
  const returnTrack = localTrack('return-new', 3, { channelRole: 'return' })
  const projected = projectCreation(afterNormal, returnTrack, 3, [
    buildTimelineTrackRow({ id: 'normal-a', index: 0, groupId: 'group-a', timestamp: 1 }),
    buildTimelineTrackRow({ id: 'normal-b', index: 1, timestamp: 1 }),
    buildTimelineTrackRow({ id: 'normal-new', index: 2, timestamp: 1 }),
    buildTimelineTrackRow({ id: 'return-new', index: 3, channelRole: 'return', timestamp: 1 }),
    buildTimelineTrackRow({ id: 'return-a', index: 4, channelRole: 'return', timestamp: 1 }),
    buildTimelineTrackRow({ id: 'return-b', index: 5, channelRole: 'return', timestamp: 1 }),
  ])

  expect(projected.map((entry) => ({
    id: entry.track.id,
    groupId: entry.track.groupId,
    index: entry.index,
  }))).toEqual([
    { id: 'normal-a', groupId: 'group-a', index: 0 },
    { id: 'normal-b', groupId: undefined, index: 1 },
    { id: 'normal-new', groupId: undefined, index: 2 },
    { id: 'return-new', groupId: undefined, index: 3 },
    { id: 'return-a', groupId: undefined, index: 4 },
    { id: 'return-b', groupId: undefined, index: 5 },
  ])
  expect(planTrackReorder({
    tracks: projected.map((entry) => ({ ...entry.track, index: entry.index })),
    moveRootIds: ['normal-new'],
    target: { trackId: 'normal-b', zone: 'above' },
  })).not.toBeNull()
})

test('projects only repaired local tracks before inserting the created track', () => {
  const tracks = [
    localTrack('unchanged', 0),
    localTrack('repaired', 1, { groupId: 'legacy-group' }),
  ]
  const created = localTrack('created', 2)
  const updates: Array<{ trackId: string; index: number; groupId?: string }> = []
  const inserts: Array<{ trackId: string; index: number }> = []

  projectLocalTrackCreation(
    tracks,
    created,
    2,
    [
      buildTimelineTrackRow({ id: 'unchanged', index: 0, timestamp: 1 }),
      buildTimelineTrackRow({ id: 'repaired', index: 3, timestamp: 1 }),
      buildTimelineTrackRow({ id: 'created', index: 2, timestamp: 1 }),
      buildTimelineTrackRow({ id: 'missing', index: 4, timestamp: 1 }),
    ],
    (track, index, patch) => {
      updates.push({ trackId: track.id, index, groupId: patch.groupId })
    },
    (track, index) => {
      inserts.push({ trackId: track.id, index })
    },
  )

  expect(updates).toEqual([
    { trackId: 'repaired', index: 1, groupId: undefined },
  ])
  expect(inserts).toEqual([{ trackId: 'created', index: 2 }])
})
