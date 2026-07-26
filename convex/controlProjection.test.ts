import { expect, test } from 'bun:test'

import { compareControlSnapshotText, projectControlSnapshotV1, projectControlSnapshotV2 } from './controlProjection'

test('orders snapshot identifiers by code unit', () => {
  expect(['a', 'A', '_', '-', 'Z'].sort(compareControlSnapshotText)).toEqual(['-', 'A', 'Z', '_', 'a'])
})

test('projects complete deterministic clip timing, fades, and MIDI notes in V2', () => {
  const snapshot = projectControlSnapshotV2({
    project: {
      projectId: 'project-1',
      name: 'Project',
      revision: 2,
      tempoBpm: 120,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      loopEnabled: false,
      loopStartSec: 0,
      loopEndSec: 8,
      updatedAt: 2,
    },
    tracks: [],
    clips: [{
      _id: 'clip-b',
      trackId: 'track-1',
      name: 'Clip',
      startSec: 1,
      duration: 4,
      leftPadSec: 0.25,
      bufferOffsetSec: 0.5,
      midiOffsetBeats: 1,
      fades: {
        fadeInStartSec: 0.1,
        fadeInSec: 0.5,
        fadeOutSec: 1,
        fadeOutEndSec: 3.9,
        fadeInCurve: 0.4,
        fadeOutCurve: -0.4,
        fadeInCurvePosition: 0.2,
        fadeOutCurvePosition: 0.8,
      },
      midi: {
        wave: 'sine',
        inputChannel: 2,
        notes: [
          { id: 'note-2', beat: 2, length: 1, pitch: 72, channel: 2 },
          { id: 'note-1', beat: 0, length: 1, pitch: 60, channel: 2 },
        ],
        cc: [{ id: 'cc-1', beat: 0, controller: 1, value: 0.5, channel: 2 }],
        pitchBends: [{ id: 'bend-1', beat: 0, value: 0.25, channel: 2 }],
        channelPressure: [{ id: 'channel-pressure-1', beat: 0, value: 0.5, channel: 2 }],
        polyPressure: [{ id: 'poly-pressure-1', beat: 0, pitch: 60, value: 0.5, channel: 2 }],
        mappings: [{
          id: 'mapping-1',
          source: { kind: 'cc', controller: 1 },
          target: { parameterId: 'opaque-parameter' },
          outputMin: 0,
          outputMax: 1,
        }],
      },
    }],
    masterVolume: 0.8,
    effects: [],
    automationEnvelopes: [],
    sidechainRoutes: [],
    assets: [],
    assetFolders: [],
  })
  expect(snapshot.clips[0]?.leftPadSec).toBe(0.25)
  expect(snapshot.clips[0]?.fades?.fadeInCurvePosition).toBe(0.2)
  expect(snapshot.clips[0]?.midi?.notes.map((note) => note.pitch)).toEqual([60, 72])
  expect(snapshot.clips[0]?.midi).toEqual(expect.objectContaining({
    inputChannel: 2,
    cc: [{ id: 'cc-1', beat: 0, controller: 1, value: 0.5, channel: 2 }],
    mappings: [{
      id: 'mapping-1',
      source: { kind: 'cc', controller: 1 },
      target: { parameterId: 'opaque-parameter' },
      outputMin: 0,
      outputMax: 1,
    }],
  }))
})

test('projects legacy MIDI rows beyond new aggregate write limits in V2', () => {
  const snapshot = projectControlSnapshotV2({
    project: {
      projectId: 'project-legacy', name: 'Project', revision: 1, tempoBpm: 120,
      timeSignatureNumerator: 4, timeSignatureDenominator: 4, loopEnabled: false,
      loopStartSec: 0, loopEndSec: 0, updatedAt: 1,
    },
    tracks: [],
    clips: [{
      _id: 'clip-legacy', trackId: 'track-1', name: 'Legacy', startSec: 0, duration: 1,
      midi: {
        wave: 'sine',
        notes: Array.from({ length: 500 }, (_, beat) => ({ beat, length: 1, pitch: 60 })),
        cc: [{ beat: 0, controller: 1, value: 0 }],
      },
    }],
    masterVolume: 1, effects: [], automationEnvelopes: [], sidechainRoutes: [], assets: [], assetFolders: [],
  })
  expect(snapshot.clips[0]?.midi?.notes).toHaveLength(500)
  expect(snapshot.clips[0]?.midi?.cc).toEqual([expect.objectContaining({ channel: 1 })])
})

test('projects legacy wave and finite out-of-range gain without repairing persisted MIDI', () => {
  const snapshot = projectControlSnapshotV2({
    project: {
      projectId: 'project-legacy-wave', name: 'Project', revision: 1, tempoBpm: 120,
      timeSignatureNumerator: 4, timeSignatureDenominator: 4, loopEnabled: false,
      loopStartSec: 0, loopEndSec: 0, updatedAt: 1,
    },
    tracks: [],
    clips: [{
      _id: 'clip-legacy-wave', trackId: 'track-1', name: 'Legacy', startSec: 0, duration: 1,
      midi: { wave: 'custom-legacy', gain: 7, notes: [] },
    }],
    masterVolume: 1, effects: [], automationEnvelopes: [], sidechainRoutes: [], assets: [], assetFolders: [],
  })
  expect(snapshot.clips[0]?.midi).toMatchObject({ wave: 'custom-legacy', gain: 7 })
})

test('projects bounded asset metadata without object locators', () => {
  const snapshot = projectControlSnapshotV1({
    project: {
      projectId: 'project-1', name: 'Project', revision: 2, tempoBpm: 120,
      timeSignatureNumerator: 4, timeSignatureDenominator: 4, loopEnabled: false,
      loopStartSec: 0, loopEndSec: 8, updatedAt: 2,
    },
    tracks: [],
    clips: [{
      _id: 'clip-1', trackId: 'track-1', name: 'Audio', startSec: 0, duration: 1,
      sourceAssetKey: 'asset-a',
    }],
    masterVolume: 0.8,
    effects: [],
    automationEnvelopes: [],
    sidechainRoutes: [],
    assets: [{
      assetKey: 'asset-a', name: 'Kick.wav', sourceKind: 'upload', mimeType: 'audio/wav',
      sizeBytes: 12, contentSha256: 'a'.repeat(64), createdAt: 1, updatedAt: 2,
    }],
    assetFolders: [],
  })
  expect(snapshot.assets[0]).toEqual(expect.objectContaining({ id: 'asset-a', contentSha256: 'a'.repeat(64) }))
  expect(JSON.stringify(snapshot)).not.toContain('r2Key')
  expect(snapshot.clips[0]?.source?.assetId).toBe('asset-a')
})
