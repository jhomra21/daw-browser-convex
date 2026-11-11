import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'
import { createRoot, createSignal, type Accessor } from 'solid-js'

import { createLocalProject } from '~/lib/local-project-db'
import { RECORDING_TARGET_LOCKED_REASON, createRecordingTargetLock, type RecordingTargetLock } from '~/lib/track-recording-target'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import { convexApi, convexClient } from '~/lib/convex'
import { useTimelineClipActions } from './useTimelineClipActions'

import { createTimelineTrackIndex } from '@daw-browser/timeline-core/track-index'
import type { RuntimeTrack } from '~/lib/timeline-runtime-types'
import { planTrackReorder } from '~/lib/track-group-ops'
import { buildTimelineTrackRow } from '~/lib/timeline-repository/track-row-builder'
import { toLocalTimelineTrack } from '~/lib/timeline-repository/track-row-adapter'
import type { TimelineTrackRow } from '~/lib/timeline-repository/types'
import type { Track } from '@daw-browser/timeline-core/types'
import { projectLocalTrackCreation, useTimelineActions } from './useTimelineActions'
import { useTimelineSelectionState } from './useTimelineSelectionState'

const jumpToClipWhile = (playing: boolean, startSec: number) => createRoot((dispose) => {
  const tracks: RuntimeTrack[] = [{
    id: 'track', name: 'Track', volume: 1,
    clips: [{ id: 'clip', name: 'Clip', startSec, duration: 2, color: '#ffffff' }],
  }]
  const [projectId] = createSignal('project:jump')
  const selection = useTimelineSelectionState({ projectId, tracks: () => tracks })
  const playheads: number[] = []
  const opened: string[] = []
  const actions = useTimelineActions({
    tracks: () => tracks,
    room: { projectId, setProjectId: () => undefined, userId: () => 'user' },
    creation: {
      selection,
      insertLocalTrack: () => undefined,
      removeLocalTrack: () => undefined,
      replaceLocalClip: () => undefined,
      updateLocalTrack: () => undefined,
      removeCloudTrack: async () => undefined,
      grantTrackWrite: () => undefined,
      pushHistory: () => undefined,
    },
    automationEnvelopes: () => [],
    sidechainRoutes: () => [],
    applyAutomationEnvelope: () => undefined,
    navigation: {
      trackLookup: () => createTimelineTrackIndex(tracks),
      selection,
      isPlaying: () => playing,
      setPlayhead: (sec) => { playheads.push(sec) },
      openClipDetailFor: (clipId) => { opened.push(clipId) },
      ensureClipBuffer: async () => undefined,
      getScrollElement: () => undefined,
      visibleStartSec: () => 0,
      setVisibleStartSec: () => undefined,
      pixelsPerSecond: () => 100,
    },
  })
  actions.jumpToClip('track', 'clip', startSec)
  const selected = selection.selectedClip()
  dispose()
  return { playheads, opened, selected }
})

test('jumping to a clip selects it and moves the playhead only while stopped', () => {
  expect(jumpToClipWhile(false, 4)).toEqual({ playheads: [4], opened: ['clip'], selected: { trackId: 'track', clipId: 'clip' } })
  expect(jumpToClipWhile(false, -3).playheads).toEqual([0])
  expect(jumpToClipWhile(true, 4)).toEqual({ playheads: [], opened: ['clip'], selected: { trackId: 'track', clipId: 'clip' } })
})

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

// A take that starts while an edit is still preparing its durable write must refuse that write.
const lockedEditActions = (projectId: Accessor<string>, tracks: RuntimeTrack[], lock: RecordingTargetLock) => {
  const notices: string[] = []
  const removed: string[] = []
  const selection = useTimelineSelectionState({ projectId, tracks: () => tracks })
  const actions = useTimelineActions({
    tracks: () => tracks,
    room: { projectId, setProjectId: () => undefined, userId: () => 'user' },
    creation: {
      selection,
      insertLocalTrack: () => undefined,
      removeLocalTrack: (trackId) => { removed.push(trackId) },
      replaceLocalClip: () => undefined,
      updateLocalTrack: () => undefined,
      removeCloudTrack: async () => undefined,
      grantTrackWrite: () => undefined,
      pushHistory: () => undefined,
    },
    recordingTargetLock: lock,
    notify: (_title, message) => { notices.push(message) },
    automationEnvelopes: () => [],
    sidechainRoutes: () => [],
    applyAutomationEnvelope: () => undefined,
    navigation: {
      trackLookup: () => createTimelineTrackIndex(tracks),
      selection,
      isPlaying: () => false,
      setPlayhead: () => undefined,
      openClipDetailFor: () => undefined,
      ensureClipBuffer: async () => undefined,
      getScrollElement: () => undefined,
      visibleStartSec: () => 0,
      setVisibleStartSec: () => undefined,
      pixelsPerSecond: () => 100,
    },
  })
  return { actions, notices, removed }
}

test('ungroup refuses when a take starts while the group effects load', async () => {
  const project = await createLocalProject(`Take during ungroup ${crypto.randomUUID()}`)
  const tracks: RuntimeTrack[] = [
    { id: 'group', name: 'Group', volume: 1, clips: [], channelRole: 'group' },
    { id: 'child', name: 'Child', volume: 1, clips: [], groupId: 'group', outputTargetId: 'group' },
  ]
  const lock = createRecordingTargetLock(() => tracks)
  const { notices, removed } = await createRoot(async (dispose) => {
    const edit = lockedEditActions(() => project.id, tracks, lock)
    const pending = edit.actions.ungroupTrack('group')
    lock.start('child')
    await pending
    dispose()
    return edit
  })
  expect(notices).toEqual([RECORDING_TARGET_LOCKED_REASON])
  expect(removed).toEqual([])
})

test('group discards its new group track when a take starts while it is created', async () => {
  const project = await createLocalProject(`Take during group ${crypto.randomUUID()}`)
  const repository = createLocalTimelineRepository(project.id)
  const created = await repository.createTrack({ index: 0 })
  const before = (await repository.loadSnapshot()).tracks.map((track) => track.id)
  const tracks: RuntimeTrack[] = [{ id: created.id, name: 'Child', volume: 1, clips: [] }]
  const lock = createRecordingTargetLock(() => tracks)
  const { notices, removed } = await createRoot(async (dispose) => {
    const edit = lockedEditActions(() => project.id, tracks, lock)
    const pending = edit.actions.groupSelectedTracks([created.id])
    lock.start(created.id)
    await pending
    dispose()
    return edit
  })
  expect(notices).toEqual([RECORDING_TARGET_LOCKED_REASON])
  expect(removed).toHaveLength(1)
  expect((await repository.loadSnapshot()).tracks.map((track) => track.id)).toEqual(before)
})

test('track delete refuses when a take starts while the delete is prepared', async () => {
  const project = await createLocalProject(`Take during delete ${crypto.randomUUID()}`)
  const repository = createLocalTimelineRepository(project.id)
  const created = await repository.createTrack({ index: 0 })
  const tracks: RuntimeTrack[] = [{ id: created.id, name: 'Doomed', volume: 1, clips: [] }]
  const lock = createRecordingTargetLock(() => tracks)
  const notices: string[] = []
  const removed: string[] = []
  await createRoot(async (dispose) => {
    const [projectId] = createSignal(project.id)
    const selection = useTimelineSelectionState({ projectId, tracks: () => tracks })
    const [, setPendingDeleteTrackId] = createSignal<string | null>(null)
    const [, setConfirmOpen] = createSignal(false)
    const actions = useTimelineClipActions({
      tracks: () => tracks,
      insertLocalClip: () => undefined,
      removeLocalClips: () => undefined,
      commitClipTiming: () => undefined,
      commitClipAudioWarp: () => undefined,
      removeLocalTrack: (trackId) => { removed.push(trackId) },
      canWriteClip: () => true,
      selection,
      setPendingDeleteTrackId,
      setConfirmOpen,
      projectId,
      userId: () => 'user',
      convexClient,
      convexApi,
      audioBufferCache: {
        getBuffer: () => undefined,
        getMediaStatus: () => undefined,
        preload: async () => undefined,
        writer: { storeBuffer: () => undefined, storeBuffers: () => undefined, removeBuffer: () => undefined },
      },
      bpm: () => 120,
      playheadSec: () => 0,
      gridEnabled: () => false,
      gridDenominator: () => 4,
      historyPush: () => undefined,
      automationEnvelopes: () => [],
      sidechainRoutes: () => [],
      applyAutomationEnvelope: () => undefined,
      recordingTargetLock: lock,
      notify: (_title, message) => { notices.push(message) },
    })
    const pending = actions.performDeleteTrack(created.id)
    lock.start(created.id)
    await pending
    dispose()
  })
  expect(notices).toEqual([RECORDING_TARGET_LOCKED_REASON])
  expect(removed).toEqual([])
  expect((await repository.loadSnapshot()).tracks.map((track) => track.id)).toContain(created.id)
})
