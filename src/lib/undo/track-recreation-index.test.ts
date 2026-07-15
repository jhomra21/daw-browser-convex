import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'

import { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import { convexApi, convexClient } from '~/lib/convex'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import type { Track } from '@daw-browser/timeline-core/types'

import { execRedo, execUndo } from './exec'
import type { HistoryEntry } from './types'

const track = (id: string, channelRole: Track['channelRole']): Track => ({
  id,
  historyRef: id,
  name: id,
  volume: 0.8,
  clips: [],
  muted: false,
  soloed: false,
  kind: 'audio',
  channelRole,
  sends: [],
})

test('redo recreates a Return track at the current canonical index', async () => {
  const projectId = 'project:history-return-recreation-index'
  const repository = createLocalTimelineRepository(projectId)
  await repository.createTrack({ id: 'normal-a' })
  await repository.createTrack({ id: 'return', channelRole: 'return' })
  let tracks = [
    track('normal-a', 'track'),
    track('return', 'return'),
  ]
  const entry: HistoryEntry = {
    type: 'track-create',
    projectId,
    data: {
      trackRef: 'return',
      currentTrackId: 'return',
      index: 1,
      channelRole: 'return',
      collapsed: true,
    },
  }
  const inserted: Array<{ track: Track; index: number }> = []
  const deps: Parameters<typeof execRedo>[1] = {
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
      insertLocalTrack: (nextTrack, index) => {
        inserted.push({ track: nextTrack, index })
        tracks = [...tracks, nextTrack]
      },
      removeLocalTrack: (trackId) => {
        tracks = tracks.filter((current) => current.id !== trackId)
      },
      insertLocalClip: () => {},
      replaceLocalClip: () => {},
      removeLocalClips: () => {},
      commitClipMoves: () => {},
      commitClipTiming: () => {},
      commitClipAudioWarp: () => {},
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
  await repository.createTrack({ id: 'normal-b' })
  tracks = [...tracks, track('normal-b', 'track')]

  await execRedo(entry, deps)

  expect(inserted).toHaveLength(1)
  expect(inserted[0]).toMatchObject({
    index: 2,
    track: {
      id: 'return',
      channelRole: 'return',
    },
  })
  expect((await repository.loadSnapshot()).tracks.map((current) => ({
    id: current.id,
    index: current.index,
    channelRole: current.channelRole,
  }))).toEqual([
    { id: 'normal-a', index: 0, channelRole: 'track' },
    { id: 'normal-b', index: 1, channelRole: 'track' },
    { id: 'return', index: 2, channelRole: 'return' },
  ])
})
