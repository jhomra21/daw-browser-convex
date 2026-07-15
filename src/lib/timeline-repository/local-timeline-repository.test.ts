import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'

import {
  createLocalProjectEntityRow,
  openLocalProjectDb,
} from '~/lib/local-project-db'
import { buildTimelineTrackRow } from './track-row-builder'
import { createLocalTimelineRepository } from './local-timeline-repository'

test('creation repairs interleaved legacy Return indexes atomically', async () => {
  const projectId = 'project:local-return-creation-repair'
  const db = await openLocalProjectDb(projectId)
  const timestamp = 1
  const legacyTracks = [
    buildTimelineTrackRow({
      id: 'normal-a',
      index: 0,
      groupId: 'group-a',
      timestamp,
    }),
    buildTimelineTrackRow({
      id: 'return-a',
      index: 1,
      channelRole: 'return',
      collapsed: false,
      timestamp,
    }),
    buildTimelineTrackRow({
      id: 'normal-b',
      index: 2,
      timestamp,
    }),
    buildTimelineTrackRow({
      id: 'return-b',
      index: 3,
      channelRole: 'return',
      groupId: 'legacy-group',
      timestamp,
    }),
  ]
  await Promise.all(legacyTracks.map((track) =>
    db.put(
      'entities',
      createLocalProjectEntityRow('track', track.id, track, timestamp),
    ),
  ))

  const repository = createLocalTimelineRepository(projectId)
  const normal = await repository.createTrack({ id: 'normal-new' })
  const returnTrack = await repository.createTrack({
    id: 'return-new',
    channelRole: 'return',
    index: 0,
    collapsed: false,
  })
  const snapshot = await repository.loadSnapshot()

  expect(normal.index).toBe(2)
  expect(returnTrack).toMatchObject({
    index: 3,
    channelRole: 'return',
    groupId: undefined,
    collapsed: false,
  })
  expect(snapshot.tracks.map((track) => ({
    id: track.id,
    index: track.index,
    channelRole: track.channelRole,
    groupId: track.groupId,
  }))).toEqual([
    { id: 'normal-a', index: 0, channelRole: 'track', groupId: 'group-a' },
    { id: 'normal-b', index: 1, channelRole: 'track', groupId: undefined },
    { id: 'normal-new', index: 2, channelRole: 'track', groupId: undefined },
    { id: 'return-new', index: 3, channelRole: 'return', groupId: undefined },
    { id: 'return-a', index: 4, channelRole: 'return', groupId: undefined },
    { id: 'return-b', index: 5, channelRole: 'return', groupId: undefined },
  ])
})

test('rejects assigning a Return track to a group', async () => {
  const projectId = 'project:local-return-group-update'
  const repository = createLocalTimelineRepository(projectId)
  await repository.createTrack({ id: 'group', channelRole: 'group' })
  await repository.createTrack({ id: 'return', channelRole: 'return' })

  await expect(repository.updateTrack({
    trackId: 'return',
    groupId: 'group',
  })).rejects.toThrow('Return tracks cannot belong to a group.')

  const snapshot = await repository.loadSnapshot()
  expect(snapshot.tracks.find((track) => track.id === 'return')?.groupId).toBeUndefined()
})

test('allows ungrouping a legacy Return track and unrelated updates', async () => {
  const projectId = 'project:local-return-ungroup-update'
  const db = await openLocalProjectDb(projectId)
  const legacyReturn = buildTimelineTrackRow({
    id: 'return',
    index: 0,
    channelRole: 'return',
    groupId: 'legacy-group',
    timestamp: 1,
  })
  await db.put(
    'entities',
    createLocalProjectEntityRow('track', legacyReturn.id, legacyReturn, 1),
  )

  const repository = createLocalTimelineRepository(projectId)
  const ungrouped = await repository.updateTrack({ trackId: 'return', groupId: null })
  const renamedByColor = await repository.updateTrack({ trackId: 'return', color: 'track-red' })

  expect(ungrouped?.groupId).toBeUndefined()
  expect(renamedByColor).toMatchObject({
    id: 'return',
    groupId: undefined,
    color: 'track-red',
  })
})

test('restores a group immediately before the Return partition', async () => {
  const projectId = 'project:local-return-restore-before-return'
  const repository = createLocalTimelineRepository(projectId)
  await repository.createTrack({ id: 'normal' })
  await repository.createTrack({ id: 'return', channelRole: 'return' })
  const group = buildTimelineTrackRow({
    id: 'restored-group',
    index: 1,
    channelRole: 'group',
    timestamp: 1,
  })

  await repository.restoreUngroup({
    group,
    children: [],
    effects: [],
    automation: [],
    sidechainRoutes: [],
  })

  expect((await repository.loadSnapshot()).tracks.map((track) => ({
    id: track.id,
    index: track.index,
  }))).toEqual([
    { id: 'normal', index: 0 },
    { id: 'restored-group', index: 1 },
    { id: 'return', index: 2 },
  ])
})

test('rejects restoring a group with a Return child without writing any tracks', async () => {
  const projectId = 'project:local-return-restore-ungroup'
  const repository = createLocalTimelineRepository(projectId)
  await repository.createTrack({ id: 'return', channelRole: 'return' })
  const before = await repository.loadSnapshot()
  const group = buildTimelineTrackRow({
    id: 'restored-group',
    index: 0,
    channelRole: 'group',
    timestamp: 1,
  })

  await expect(repository.restoreUngroup({
    group,
    children: [{
      trackId: 'return',
      outputTargetId: 'restored-group',
      outputToGroup: true,
    }],
    effects: [],
    automation: [],
    sidechainRoutes: [],
  })).rejects.toThrow('Return tracks must remain ungrouped at the end.')

  expect(await repository.loadSnapshot()).toEqual(before)
})
