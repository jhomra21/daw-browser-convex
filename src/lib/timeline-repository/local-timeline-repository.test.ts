import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'

import {
  createLocalProjectEntityRow,
  openLocalProjectDb,
} from '~/lib/local-project-db'
import { buildTimelineTrackRow } from './track-row-builder'
import { createLocalTimelineRepository } from './local-timeline-repository'
import { externalPluginEntityKind } from '@daw-browser/external-plugins'

test('deletes external processor rows with their target track', async () => {
  const projectId = `project:external-delete-${crypto.randomUUID()}`
  const repository = createLocalTimelineRepository(projectId)
  const track = await repository.createTrack({ id: 'audio-track', kind: 'audio' })
  const db = await openLocalProjectDb(projectId)
  await db.put('entities', createLocalProjectEntityRow(
    externalPluginEntityKind,
    'external-plugin:test',
    { targetId: track.id },
    1,
  ))

  await repository.deleteTrack(track.id)

  expect(await db.getAllFromIndex('entities', 'by-kind', externalPluginEntityKind)).toEqual([])
})

test('normalizes and preserves expanded local MIDI without reference equality', async () => {
  const projectId = 'project:local-expanded-midi'
  const repository = createLocalTimelineRepository(projectId)
  const track = await repository.createTrack({ id: 'instrument-track', kind: 'instrument' })
  const clip = await repository.createClip({
    id: 'midi-clip',
    trackId: track.id,
    startSec: 0,
    duration: 1,
    midi: {
      wave: 'sine',
      notes: [{ beat: 0, length: 1, pitch: 60 }],
      cc: [{ id: 'cc-1', beat: 0, controller: 1, value: 0.5, channel: 2 }],
      mappings: [{
        id: 'mapping-1',
        source: { kind: 'cc', controller: 1 },
        target: { parameterId: 'opaque-parameter' },
        outputMin: 0,
        outputMax: 1,
      }],
    },
  })
  const snapshot = await repository.loadSnapshot()
  const stored = snapshot.clips[0]
  expect(stored?.midi).toEqual(expect.objectContaining({
    cc: [{ id: 'cc-1', beat: 0, controller: 1, value: 0.5, channel: 2 }],
    mappings: clip.midi?.mappings,
  }))
  if (!stored?.midi) throw new Error('Expected normalized MIDI clip.')
  const updated = await repository.updateClip({
    clipId: clip.id,
    midi: stored.midi,
  })
  expect(updated?.updatedAt).toBe(clip.updatedAt)
})

test('hydrates persisted legacy MIDI wave and gain without dropping the clip', async () => {
  const projectId = 'project:local-legacy-midi'
  const repository = createLocalTimelineRepository(projectId)
  const track = await repository.createTrack({ id: 'instrument-track', kind: 'instrument' })
  const db = await openLocalProjectDb(projectId)
  await db.put('entities', createLocalProjectEntityRow('clip', 'legacy-midi-clip', {
    id: 'legacy-midi-clip',
    trackId: track.id,
    historyRef: 'legacy-midi-clip',
    name: 'Legacy MIDI',
    startSec: 0,
    duration: 1,
    color: 'clip-midi',
    midi: { wave: 'custom-legacy', gain: 7, notes: [] },
    createdAt: 1,
    updatedAt: 1,
  }, 1))

  expect((await repository.loadSnapshot()).clips).toEqual([
    expect.objectContaining({
      id: 'legacy-midi-clip',
      midi: expect.objectContaining({ wave: 'custom-legacy', gain: 7 }),
    }),
  ])
})

test('restores historical local MIDI through the dedicated legacy path', async () => {
  const projectId = 'project:local-history-midi'
  const repository = createLocalTimelineRepository(projectId)
  const track = await repository.createTrack({ id: 'instrument-track', kind: 'instrument' })
  const restored = await repository.restoreHistoryClip({
    id: 'restored-midi',
    historyRef: 'historical-midi',
    trackId: track.id,
    startSec: 0,
    duration: 1,
    midi: {
      wave: '',
      gain: 7,
      notes: [
        { beat: 0, length: 1, pitch: 60 },
        { beat: 1, length: -1, pitch: 200 },
        ...Array.from({ length: 501 }, (_, beat) => ({ beat: beat + 2, length: 1, pitch: 60 })),
      ],
    },
  })
  expect(restored.midi).toMatchObject({ wave: '', gain: 7 })
  expect(restored.midi?.notes).toHaveLength(503)
  await expect(repository.createClip({
    trackId: track.id,
    startSec: 2,
    duration: 1,
    midi: { wave: '', gain: 7, notes: [] },
  })).rejects.toThrow()
})

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

test('persists fades with clip creation and atomically clamps them on duration updates', async () => {
  const projectId = 'project:local-clip-fades'
  const repository = createLocalTimelineRepository(projectId)
  await repository.createTrack({ id: 'track' })
  await repository.createClip({
    id: 'clip',
    trackId: 'track',
    startSec: 0,
    duration: 8,
    fades: { fadeInSec: 2, fadeOutSec: 3, fadeInCurve: 0, fadeOutCurve: 0 },
  })
  const updated = await repository.updateClip({ clipId: 'clip', duration: 4 })
  expect(updated?.fades).toMatchObject({
    fadeInSec: 2,
    fadeOutSec: 2,
    fadeInCurve: 0,
    fadeOutCurve: 0,
  })
  expect((await repository.loadSnapshot()).clips[0]?.fades).toEqual(updated?.fades)
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
