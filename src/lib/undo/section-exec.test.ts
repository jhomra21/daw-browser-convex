import { expect, test } from 'bun:test'

import { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import type { Track } from '@daw-browser/timeline-core/types'
import { convexApi, convexClient } from '~/lib/convex'

import { execRedo } from './exec'
import type { HistoryEntry } from './types'

const tracks: Track[] = [{
  id: 'track-1',
  historyRef: 'track-ref-1',
  name: 'Track 1',
  volume: 0.5,
  clips: [],
  muted: false,
  soloed: false,
  kind: 'audio',
  channelRole: 'track',
  sends: [],
}]

const actions = {
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
}

const entry = (): Extract<HistoryEntry, { type: 'section-edit' }> => ({
  type: 'section-edit',
  projectId: 'local:project-1',
  data: {
    entries: [
      {
        type: 'track-volume',
        projectId: 'local:project-1',
        data: { trackRef: 'track-ref-1', scope: 'local', from: 0.5, to: 0.9 },
      },
      {
        type: 'clip-timing',
        projectId: 'local:project-1',
        data: {
          clipRef: 'missing-clip',
          from: { startSec: 0, duration: 1 },
          to: { startSec: 1, duration: 1 },
        },
      },
    ],
  },
})

test('compensates completed section children in reverse after a later child fails', async () => {
  const persisted: number[] = []
  await expect(execRedo(entry(), {
    convexClient,
    convexApi,
    getTracks: () => tracks,
    getHistoryEntries: () => [],
    projectId: 'local:project-1',
    userId: 'local',
    persistLocalMix: (_projectId, _trackId, patch) => { if (patch.volume !== undefined) persisted.push(patch.volume) },
    audioEngine: new AudioEngine(),
    grantTrackWrite: () => {},
    grantClipWrite: () => {},
    actions,
  })).rejects.toThrow('Clip not found')
  expect(persisted).toEqual([0.9, 0.5])
})

test('preserves the original section failure first when compensation fails', async () => {
  const persisted: number[] = []
  let thrown: unknown
  try {
    await execRedo(entry(), {
      convexClient,
      convexApi,
      getTracks: () => tracks,
      getHistoryEntries: () => [],
      projectId: 'local:project-1',
      userId: 'local',
      persistLocalMix: (_projectId, _trackId, patch) => {
        if (patch.volume === 0.5) throw new Error('compensation failure')
        if (patch.volume !== undefined) persisted.push(patch.volume)
      },
      audioEngine: new AudioEngine(),
      grantTrackWrite: () => {},
      grantClipWrite: () => {},
      actions,
    })
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(AggregateError)
  if (!(thrown instanceof AggregateError)) throw new Error('Expected AggregateError')
  expect(thrown.errors[0]).toMatchObject({ message: 'Clip not found for clip-timing history entry' })
  expect(persisted).toEqual([0.9])
})
