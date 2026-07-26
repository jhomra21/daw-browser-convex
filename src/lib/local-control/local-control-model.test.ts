import { expect, test } from 'bun:test'
import type { ControlPlanV1 } from '@daw-browser/control'
import { createLocalProjectEntityRow } from '~/lib/local-project-db'
import { materializeLocalControlSnapshot } from './local-control-model'

test('materializes a legacy oversized persisted MIDI snapshot', () => {
  const snapshot: ControlPlanV1['snapshot'] = {
    project: {
      id: 'project-1',
      name: 'Project',
      revision: 1,
      tempoBpm: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      loop: { enabled: false, startSec: 0, endSec: 0 },
      masterVolume: 1,
      updatedAt: 1,
    },
    tracks: [],
    clips: [{
      id: 'clip-1',
      trackId: 'track-1',
      name: 'MIDI',
      startSec: 0,
      duration: 1,
      gain: 1,
      leftPadSec: 0,
      bufferOffsetSec: 0,
      midiOffsetBeats: 0,
      midi: {
        wave: 'custom-legacy',
        gain: 7,
        notes: Array.from({ length: 500 }, (_, beat) => ({ beat, length: 1, pitch: 60 })),
        cc: [{ beat: 0, controller: 1, value: 0 }],
      },
    }],
    processors: [],
    automation: [],
    sidechains: [],
    assets: [],
    assetFolders: [],
  }
  const model = materializeLocalControlSnapshot({
    entities: [],
    assets: [],
    projectState: [],
  }, snapshot, 1)
  const clip = model.entities.find((entity) => entity.kind === 'clip')
  if (!clip || typeof clip.value !== 'object' || clip.value === null || !('midi' in clip.value)) {
    throw new Error('Expected a materialized MIDI clip.')
  }
  expect(clip.value.midi).toMatchObject({ wave: 'custom-legacy', gain: 7 })
  expect(JSON.stringify(clip.value.midi)).toContain('"channel":1')
})

test('clears a legacy clip URL when assigning its first authoritative source', () => {
  const snapshot: ControlPlanV1['snapshot'] = {
    project: {
      id: 'project-1', name: 'Project', revision: 1, tempoBpm: 120,
      timeSignature: { numerator: 4, denominator: 4 }, loop: { enabled: false, startSec: 0, endSec: 0 },
      masterVolume: 1, updatedAt: 1,
    },
    tracks: [],
    clips: [{
      id: 'clip-1', trackId: 'track-1', name: 'Audio', startSec: 0, duration: 1,
      source: { assetId: 'asset-2', sourceKind: 'upload', durationSec: 1, sampleRate: 48_000, channelCount: 2 },
    }],
    processors: [], automation: [], sidechains: [], assets: [], assetFolders: [],
  }
  const model = materializeLocalControlSnapshot({
    entities: [createLocalProjectEntityRow('clip', 'clip-1', {
      id: 'clip-1', trackId: 'track-1', sampleUrl: 'https://stale.example/audio.wav',
    }, 1)],
    assets: [],
    projectState: [],
  }, snapshot, 2)
  const clip = model.entities.find((entity) => entity.kind === 'clip')
  if (!clip || typeof clip.value !== 'object' || clip.value === null) {
    throw new Error('Expected a materialized audio clip.')
  }
  expect(clip.value).toMatchObject({ sampleUrl: undefined })
})
