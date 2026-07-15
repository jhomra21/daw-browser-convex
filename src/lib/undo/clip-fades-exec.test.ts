import { expect, test } from 'bun:test'
import 'fake-indexeddb/auto'

import { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import { convexApi, convexClient } from '~/lib/convex'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import type { Track } from '@daw-browser/timeline-core/types'

import { execRedo, execUndo } from './exec'
import type { HistoryEntry } from './types'

const from = { fadeInSec: 0, fadeOutSec: 1, fadeInCurve: 0, fadeOutCurve: 0 }
const to = { fadeInSec: 2, fadeOutSec: 1, fadeInCurve: 0.5, fadeOutCurve: -0.5 }

const createTrack = (fades = to): Track => ({
  id: 'track-1',
  historyRef: 'track-1',
  name: 'Track 1',
  volume: 0.8,
  clips: [{
    id: 'clip-1',
    historyRef: 'clip-ref-1',
    name: 'Clip 1',
    startSec: 0,
    duration: 4,
    color: 'track-blue',
    fades,
  }],
  muted: false,
  soloed: false,
  kind: 'audio',
  channelRole: 'track',
  sends: [],
})

test('undo and redo persist directional clip fades, update the projection, and reschedule', async () => {
  const projectId = 'project:history-clip-fades-exec'
  const repository = createLocalTimelineRepository(projectId)
  await repository.createTrack({ id: 'track-1' })
  await repository.createClip({
    id: 'clip-1',
    trackId: 'track-1',
    startSec: 0,
    duration: 4,
    fades: to,
  })
  let tracks = [createTrack()]
  const entry: HistoryEntry = {
    type: 'clip-fades',
    projectId,
    data: {
      clipRef: 'clip-ref-1',
      from,
      to,
    },
  }
  const committed: Array<{ clipId: string; fades: NonNullable<Track['clips'][number]['fades']> }> = []
  const rescheduled: string[][] = []
  const deps: Parameters<typeof execUndo>[1] = {
    convexClient,
    convexApi,
    getTracks: () => tracks,
    getHistoryEntries: () => [entry],
    projectId,
    userId: 'user',
    persistLocalMix: () => {},
    audioEngine: new AudioEngine(),
    grantTrackWrite: () => {},
    grantClipWrite: () => {},
    actions: {
      insertLocalTrack: () => {},
      removeLocalTrack: () => {},
      insertLocalClip: () => {},
      replaceLocalClip: () => {},
      removeLocalClips: () => {},
      commitClipMoves: () => {},
      commitClipTiming: () => {},
      commitClipAudioWarp: () => {},
      commitClipFades: (clipId, fades) => {
        committed.push({ clipId, fades })
        tracks = tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) => clip.id === clipId ? { ...clip, fades } : clip),
        }))
      },
      rescheduleChangedClips: (clipIds) => rescheduled.push(clipIds),
      cancelTrackVolumeWrite: () => {},
      cancelTrackRoutingWrite: () => {},
      cancelTrackMixWrite: () => {},
      applyTrackVolume: () => {},
      applyTrackMixState: () => {},
      applyTrackRouting: () => {},
      applyTrackPatch: () => {},
      applyAutomationEnvelope: () => {},
    },
  }

  await execUndo(entry, deps)
  expect((await repository.loadSnapshot()).clips[0]?.fades).toMatchObject(from)
  expect(tracks[0]?.clips[0]?.fades).toMatchObject(from)

  await execRedo(entry, deps)
  expect((await repository.loadSnapshot()).clips[0]?.fades).toMatchObject(to)
  expect(tracks[0]?.clips[0]?.fades).toMatchObject(to)
  expect(committed).toEqual([
    { clipId: 'clip-1', fades: from },
    { clipId: 'clip-1', fades: to },
  ])
  expect(rescheduled).toEqual([['clip-1'], ['clip-1']])
})

test('timing history persists transformed fades atomically', async () => {
  const projectId = 'project:history-clip-timing-fades'
  const repository = createLocalTimelineRepository(projectId)
  await repository.createTrack({ id: 'track-1' })
  await repository.createClip({
    id: 'clip-1',
    trackId: 'track-1',
    startSec: 0,
    duration: 4,
    fades: to,
  })
  const entry: HistoryEntry = {
    type: 'clip-timing',
    projectId,
    data: {
      clipRef: 'clip-ref-1',
      from: { startSec: 0, duration: 2, fades: { ...from, fadeOutSec: 0 } },
      to: { startSec: 0, duration: 4, fades: to },
    },
  }
  const timingCommits: Array<Extract<HistoryEntry, { type: 'clip-timing' }>['data']['from']> = []
  const deps: Parameters<typeof execUndo>[1] = {
    convexClient,
    convexApi,
    getTracks: () => [createTrack()],
    getHistoryEntries: () => [entry],
    projectId,
    userId: 'user',
    persistLocalMix: () => {},
    audioEngine: new AudioEngine(),
    grantTrackWrite: () => {},
    grantClipWrite: () => {},
    actions: {
      insertLocalTrack: () => {},
      removeLocalTrack: () => {},
      insertLocalClip: () => {},
      replaceLocalClip: () => {},
      removeLocalClips: () => {},
      commitClipMoves: () => {},
      commitClipTiming: (_clipId, timing) => timingCommits.push(timing),
      commitClipAudioWarp: () => {},
      commitClipFades: () => {},
      rescheduleChangedClips: () => {},
      cancelTrackVolumeWrite: () => {},
      cancelTrackRoutingWrite: () => {},
      cancelTrackMixWrite: () => {},
      applyTrackVolume: () => {},
      applyTrackMixState: () => {},
      applyTrackRouting: () => {},
      applyTrackPatch: () => {},
      applyAutomationEnvelope: () => {},
    },
  }

  await execUndo(entry, deps)

  expect((await repository.loadSnapshot()).clips[0]).toMatchObject({
    duration: 2,
    fades: { ...from, fadeOutSec: 0 },
  })
  expect(timingCommits).toEqual([entry.data.from])
})

test('undo recreates deleted faded clips in the local repository', async () => {
  const projectId = 'project:history-recreated-faded-clip'
  const repository = createLocalTimelineRepository(projectId)
  await repository.createTrack({ id: 'track-1' })
  const entry: HistoryEntry = {
    type: 'clip-delete',
    projectId,
    data: {
      items: [{
        trackRef: 'track-1',
        clip: {
          clipRef: 'clip-ref-1',
          startSec: 1,
          duration: 4,
          fades: to,
        },
      }],
    },
  }
  const recreated = createTrack()
  const deps: Parameters<typeof execUndo>[1] = {
    convexClient,
    convexApi,
    getTracks: () => [recreated],
    getHistoryEntries: () => [entry],
    projectId,
    userId: 'user',
    persistLocalMix: () => {},
    audioEngine: new AudioEngine(),
    grantTrackWrite: () => {},
    grantClipWrite: () => {},
    actions: {
      insertLocalTrack: () => {},
      removeLocalTrack: () => {},
      insertLocalClip: () => {},
      replaceLocalClip: () => {},
      removeLocalClips: () => {},
      commitClipMoves: () => {},
      commitClipTiming: () => {},
      commitClipAudioWarp: () => {},
      commitClipFades: () => {},
      rescheduleChangedClips: () => {},
      cancelTrackVolumeWrite: () => {},
      cancelTrackRoutingWrite: () => {},
      cancelTrackMixWrite: () => {},
      applyTrackVolume: () => {},
      applyTrackMixState: () => {},
      applyTrackRouting: () => {},
      applyTrackPatch: () => {},
      applyAutomationEnvelope: () => {},
    },
  }

  await execUndo(entry, deps)

  expect((await repository.loadSnapshot()).clips[0]).toMatchObject({
    startSec: 1,
    duration: 4,
    fades: to,
  })
})

test('undo recreates faded clips inside deleted local tracks', async () => {
  const projectId = 'project:history-recreated-faded-track-clip'
  const repository = createLocalTimelineRepository(projectId)
  const entry: HistoryEntry = {
    type: 'track-delete',
    projectId,
    data: {
      track: {
        trackRef: 'track-ref-1',
        index: 0,
        name: 'Track 1',
        volume: 1,
        routing: { sends: [] },
      },
      clips: [{
        clipRef: 'clip-ref-1',
        startSec: 0,
        duration: 4,
        fades: to,
      }],
    },
  }
  let tracks: Track[] = []
  const deps: Parameters<typeof execUndo>[1] = {
    convexClient,
    convexApi,
    getTracks: () => tracks,
    getHistoryEntries: () => [entry],
    projectId,
    userId: 'user',
    persistLocalMix: () => {},
    audioEngine: new AudioEngine(),
    grantTrackWrite: () => {},
    grantClipWrite: () => {},
    actions: {
      insertLocalTrack: (track) => { tracks = [...tracks, track] },
      removeLocalTrack: () => {},
      insertLocalClip: (trackId, clip) => {
        tracks = tracks.map((track) => track.id === trackId ? { ...track, clips: [...track.clips, clip] } : track)
      },
      replaceLocalClip: () => {},
      removeLocalClips: () => {},
      commitClipMoves: () => {},
      commitClipTiming: () => {},
      commitClipAudioWarp: () => {},
      commitClipFades: () => {},
      rescheduleChangedClips: () => {},
      cancelTrackVolumeWrite: () => {},
      cancelTrackRoutingWrite: () => {},
      cancelTrackMixWrite: () => {},
      applyTrackVolume: () => {},
      applyTrackMixState: () => {},
      applyTrackRouting: () => {},
      applyTrackPatch: () => {},
      applyAutomationEnvelope: () => {},
    },
  }

  await execUndo(entry, deps)

  expect((await repository.loadSnapshot()).clips[0]?.fades).toMatchObject(to)
})
