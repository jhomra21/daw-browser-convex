import { expect, test } from 'bun:test'

import {
  createLocalProjectEntityRow,
  type LocalControlProjectMetadata,
  type LocalProjectAssetRow,
} from '~/lib/local-project-db'
import { buildTimelineTrackRow } from '~/lib/timeline-repository/track-row-builder'
import { projectLocalControlSnapshotV1 } from './local-control-projector'

const metadata: LocalControlProjectMetadata = {
  version: 1,
  name: 'Project',
  updatedAt: 1,
  timeSignature: { numerator: 4, denominator: 4 },
}

const asset = (id: string, complete: boolean): LocalProjectAssetRow => ({
  id,
  name: 'Kick.wav',
  mimeType: 'audio/wav',
  sizeBytes: 1,
  storagePath: `${id}.wav`,
  sourceKind: complete ? 'upload' : undefined,
  contentHash: complete ? 'a'.repeat(64) : undefined,
  durationSec: 1,
  sampleRate: 48_000,
  channelCount: 2,
  createdAt: 1,
  updatedAt: 1,
})

test('projects complete local assets while omitting incomplete clip sources', () => {
  const track = buildTimelineTrackRow({ id: 'track-1', index: 0, timestamp: 1 })
  const snapshot = projectLocalControlSnapshotV1({
    projectId: 'project-1',
    fallbackMetadata: metadata,
    entities: [
      createLocalProjectEntityRow('track', track.id, track, 1),
      createLocalProjectEntityRow('clip', 'clip-1', {
        id: 'clip-1', historyRef: 'clip-1', trackId: track.id, name: 'Audio',
        startSec: 0, duration: 1, color: 'clip-audio', sourceAssetKey: 'incomplete',
        createdAt: 1, updatedAt: 1,
      }, 1),
    ],
    assets: [asset('complete', true), asset('incomplete', false)],
    projectState: [],
    revision: 0,
  })
  expect(snapshot.assets.map((entry) => entry.id)).toEqual(['complete'])
  expect(snapshot.clips[0]?.source).toBeUndefined()
})

test('omits assets that violate canonical limits while retaining unrelated snapshot data', () => {
  const track = buildTimelineTrackRow({ id: 'track-1', index: 0, timestamp: 1 })
  const snapshot = projectLocalControlSnapshotV1({
    projectId: 'project-1',
    fallbackMetadata: metadata,
    entities: [
      createLocalProjectEntityRow('track', track.id, track, 1),
      createLocalProjectEntityRow('clip', 'clip-1', {
        id: 'clip-1', historyRef: 'clip-1', trackId: track.id, name: 'Audio',
        startSec: 0, duration: 1, color: 'clip-audio', sourceAssetKey: 'oversized',
        createdAt: 1, updatedAt: 1,
      }, 1),
    ],
    assets: [{
      ...asset('oversized', true),
      sizeBytes: 10 * 1024 * 1024 + 1,
    }, {
      ...asset('complete', true),
      channelCount: 2,
    }],
    projectState: [],
    revision: 0,
  })
  expect(snapshot.assets.map((entry) => entry.id)).toEqual(['complete'])
  expect(snapshot.clips[0]?.source).toBeUndefined()
  expect(snapshot.tracks.map((entry) => entry.id)).toEqual(['track-1'])
})

test('omits tracks with malformed nested routing before shared projection', () => {
  const valid = buildTimelineTrackRow({ id: 'track-valid', index: 0, timestamp: 1 })
  const malformed = {
    ...buildTimelineTrackRow({ id: 'track-malformed', index: 1, timestamp: 1 }),
    sends: [{ targetId: 42, amount: 1 }],
  }
  const snapshot = projectLocalControlSnapshotV1({
    projectId: 'project-1',
    fallbackMetadata: metadata,
    entities: [
      createLocalProjectEntityRow('track', valid.id, valid, 1),
      createLocalProjectEntityRow('track', malformed.id, malformed, 1),
    ],
    assets: [],
    projectState: [],
    revision: 0,
  })
  expect(snapshot.tracks.map((track) => track.id)).toEqual(['track-valid'])
})

test('omits tracks with oversized routing IDs or duplicate send targets', () => {
  const valid = buildTimelineTrackRow({ id: 'track-valid', index: 0, timestamp: 1 })
  const oversized = {
    ...buildTimelineTrackRow({ id: 'track-oversized', index: 1, timestamp: 1 }),
    groupId: 'a'.repeat(257),
  }
  const duplicateTargets = {
    ...buildTimelineTrackRow({ id: 'track-duplicate', index: 2, timestamp: 1 }),
    sends: [
      { targetId: 'return-1', amount: 1, tap: 'post-fader' },
      { targetId: 'return-1', amount: 0.5, tap: 'pre-fader' },
    ],
  }
  const snapshot = projectLocalControlSnapshotV1({
    projectId: 'project-1',
    fallbackMetadata: metadata,
    entities: [
      createLocalProjectEntityRow('track', valid.id, valid, 1),
      createLocalProjectEntityRow('track', oversized.id, oversized, 1),
      createLocalProjectEntityRow('track', duplicateTargets.id, duplicateTargets, 1),
    ],
    assets: [],
    projectState: [],
    revision: 0,
  })
  expect(snapshot.tracks.map((track) => track.id)).toEqual(['track-valid'])
})

test('falls back from invalid metadata signatures while preserving canonical boundaries', () => {
  const snapshot = projectLocalControlSnapshotV1({
    projectId: 'project-1',
    fallbackMetadata: metadata,
    entities: [],
    assets: [],
    projectState: [{
      key: 'control-project-metadata',
      value: {
        version: 1,
        name: 'Invalid',
        updatedAt: 2,
        timeSignature: { numerator: 33, denominator: 4 },
      },
      updatedAt: 2,
    }],
    revision: 0,
  })
  expect(snapshot.project.timeSignature).toEqual({ numerator: 4, denominator: 4 })

  const boundary = projectLocalControlSnapshotV1({
    projectId: 'project-1',
    fallbackMetadata: metadata,
    entities: [],
    assets: [],
    projectState: [{
      key: 'control-project-metadata',
      value: {
        version: 1,
        name: 'Boundary',
        updatedAt: 2,
        timeSignature: { numerator: 32, denominator: 32 },
      },
      updatedAt: 2,
    }],
    revision: 0,
  })
  expect(boundary.project.timeSignature).toEqual({ numerator: 32, denominator: 32 })
})
