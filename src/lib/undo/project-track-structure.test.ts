import { expect, test } from 'bun:test'
import { createRoot } from 'solid-js'

import { createLocalTrack } from '~/lib/tracks'
import { RECORDING_TARGET_LOCKED_REASON, createRecordingTargetLock } from '~/lib/track-recording-target'
import {
  buildTrackClipCreateHistoryEntry,
  buildTrackCreateHistoryEntry,
  buildTrackDeleteHistoryEntry,
  buildTrackUngroupHistoryEntry,
} from './builders'
import { projectTrackStructure, type ClosureTrack } from './project-track-structure'

const projectId = 'project'
const track = (id: string, patch: Partial<Parameters<typeof createLocalTrack>[0]> = {}) => createLocalTrack({ id, index: 0, ...patch })
const byId = (tracks: readonly ClosureTrack[], id: string) => tracks.find((entry) => entry.id === id)
const ids = (tracks: readonly ClosureTrack[]) => tracks.map((entry) => entry.id)

test('redoing a track create adds the track the executor recreates', () => {
  const entry = buildTrackCreateHistoryEntry({ projectId, trackId: 'new', index: 1 })
  expect(ids(projectTrackStructure(entry, 'redo', [track('a')]))).toEqual(['a', 'new'])
  expect(ids(projectTrackStructure(entry, 'undo', [track('a'), track('new')]))).toEqual(['a'])
})

test('redoing a track-and-clip create adds the track the executor recreates', () => {
  const created = track('new')

  const entry = buildTrackClipCreateHistoryEntry({
    projectId,
    track: created,
    tracks: [track('a'), created],
    clipId: 'clip',
    clip: { startSec: 0, duration: 1 },
  })

  expect(ids(projectTrackStructure(entry, 'redo', [track('a')]))).toEqual(['a', 'new'])
})

test('undoing a track delete restores the track with its group and its own routing', () => {
  const group = track('group', { channelRole: 'group' })
  const out = track('out')
  const send = track('send')

  const deleted = track('deleted', {
    groupId: 'group',
    outputTargetId: 'out',
    sends: [{ targetId: 'send', amount: 0.5 }],
  })

  const entry = buildTrackDeleteHistoryEntry({ projectId, track: deleted, tracks: [group, out, send, deleted] })
  const restored = byId(projectTrackStructure(entry, 'undo', [group, out, send]), 'deleted')
  expect(restored?.groupId).toBe('group')
  expect(restored?.outputTargetId).toBe('out')
  expect(restored?.sends).toEqual([{ targetId: 'send' }])
})

test('undoing a track delete restores inbound routing onto its sources', () => {
  const deleted = track('deleted')
  const source = track('source', { outputTargetId: 'deleted', sends: [{ targetId: 'deleted', amount: 1 }] })
  const entry = buildTrackDeleteHistoryEntry({ projectId, track: deleted, tracks: [deleted, source] })
  const restored = projectTrackStructure(entry, 'undo', [track('source')])
  expect(byId(restored, 'source')?.outputTargetId).toBe('deleted')
  expect(byId(restored, 'source')?.sends).toEqual([{ targetId: 'deleted' }])
})

test('undoing an ungroup restores the group with its parent group and its own routing', () => {
  const parent = track('parent', { channelRole: 'group' })
  const out = track('out')
  const group = track('group', { channelRole: 'group', groupId: 'parent', outputTargetId: 'out' })
  const child = track('child', { groupId: 'group', outputTargetId: 'group' })
  const entry = buildTrackUngroupHistoryEntry({ projectId, tracks: [parent, out, group, child], groupTrack: group, childTrackIds: ['child'] })
  const restored = projectTrackStructure(entry, 'undo', [parent, out, track('child')])
  expect(byId(restored, 'group')?.groupId).toBe('parent')
  expect(byId(restored, 'group')?.outputTargetId).toBe('out')
  expect(byId(restored, 'child')?.groupId).toBe('group')
})

test('the recording guard refuses a redo that re-creates a track the take is routed into', () => {
  const target = track('target', { outputTargetId: 'bus' })
  const entry = buildTrackCreateHistoryEntry({ projectId, trackId: 'bus', index: 1 })

  const refusal = createRoot((dispose) => {
    const lock = createRecordingTargetLock(() => [target])
    lock.start('target')
    const result = lock.refuseHistory(entry, 'redo')
    dispose()

    return result
  })

  expect(refusal).toBe(RECORDING_TARGET_LOCKED_REASON)
})
