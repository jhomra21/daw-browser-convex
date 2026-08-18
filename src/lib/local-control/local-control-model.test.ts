import { expect, test } from 'bun:test'
import type { ProjectSnapshotV2 } from '@daw-browser/control'
import { externalProcessorSchema } from '@daw-browser/external-plugins'
import { isJsonObject } from '@daw-browser/shared'
import { createLocalProjectEntityRow } from '~/lib/local-project-db'
import { materializeLocalControlSnapshot, parseLocalProjectStoredJsonValue } from './local-control-model'

test('materializes a legacy oversized persisted MIDI snapshot', () => {
  const snapshot: ProjectSnapshotV2 = {
    version: 'v2',
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
  const value = clip ? parseLocalProjectStoredJsonValue(clip.value) : undefined
  if (!clip || !isJsonObject(value) || value.midi === undefined) {
    throw new Error('Expected a materialized MIDI clip.')
  }
  expect(value.midi).toMatchObject({ wave: 'custom-legacy', gain: 7 })
  expect(JSON.stringify(value.midi)).toContain('"channel":1')
})

test('clears a legacy clip URL when assigning its first authoritative source', () => {
  const snapshot: ProjectSnapshotV2 = {
    version: 'v2',
    project: {
      id: 'project-1', name: 'Project', revision: 1, tempoBpm: 120,
      timeSignature: { numerator: 4, denominator: 4 }, loop: { enabled: false, startSec: 0, endSec: 0 },
      masterVolume: 1, updatedAt: 1,
    },
    tracks: [],
    clips: [{
      id: 'clip-1', trackId: 'track-1', name: 'Audio', startSec: 0, duration: 1,
      leftPadSec: 0, bufferOffsetSec: 0, midiOffsetBeats: 0,
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
  const value = clip ? parseLocalProjectStoredJsonValue(clip.value) : undefined
  if (!clip || !isJsonObject(value)) {
    throw new Error('Expected a materialized audio clip.')
  }
  expect(value.sampleUrl).toBeUndefined()
})

const externalInstanceId = '00000000-0000-4000-8000-000000000001'
const externalRow = externalProcessorSchema.parse({
  instanceId: externalInstanceId,
  targetId: 'track-1',
  index: 0,
  manifest: {
    identity: {
      format: 'vst3',
      classId: 'class-1',
      vendor: 'Vendor',
      name: 'Fixture',
      version: '1',
      architecture: 'arm64',
      discoveredPath: '/local/Fixture.vst3',
      binaryFingerprint: 'a'.repeat(64),
    },
    role: 'effect',
    audioInputs: [{ name: 'Input', channels: 2, enabled: true }],
    audioOutputs: [{ name: 'Output', channels: 2, enabled: true }],
    sidechainInputs: [],
    parameters: [{
      id: 1,
      title: 'Gain',
      unit: '',
      minimum: 0,
      maximum: 1,
      defaultValue: 0.5,
      stepCount: 100,
      readOnly: false,
      hidden: false,
    }],
    latencyFrames: 0,
    tailFrames: 0,
    supportsBypass: true,
    supportsEditor: false,
    supportsState: true,
  },
  parameterOverrides: { '1': 0.25 },
  state: {
    artifactId: '00000000-0000-4000-8000-000000000002',
    sha256: 'b'.repeat(64),
    byteLength: 4,
    artifactKind: 'plugin-state',
    ownerId: 'owner-1',
    acl: 'owner',
    bucket: 'local',
    location: '/local/state.bin',
  },
  latencyFrames: 0,
  tailFrames: 0,
  bypassed: false,
  health: { state: 'ready', updatedAt: 1 },
  updatedAt: 1,
})

const externalSnapshot = (overrides: Record<string, number>): ProjectSnapshotV2 => ({
  version: 'v2',
  project: {
    id: 'project-1', name: 'Project', revision: 1, tempoBpm: 120,
    timeSignature: { numerator: 4, denominator: 4 }, loop: { enabled: false, startSec: 0, endSec: 0 },
    masterVolume: 1, updatedAt: 1,
  },
  tracks: [],
  clips: [],
  processors: [{
    id: `external-plugin:${externalInstanceId}`,
    target: { trackId: 'track-1' },
    instanceId: externalInstanceId,
    index: 0,
    processor: {
      kind: 'external-vst3',
      params: {
        identity: { name: 'Fixture', vendor: 'Vendor', classId: 'class-1', role: 'effect' },
        bypassed: false,
        parameterOverrides: overrides,
        parameters: [{ id: 1, readOnly: false }],
      },
    },
  }],
  automation: [],
  sidechains: [],
  assets: [],
  assetFolders: [],
})

test('updates external overrides while preserving local-only plugin metadata', () => {
  const model = materializeLocalControlSnapshot({
    entities: [createLocalProjectEntityRow('external-plugin', `external-plugin:${externalInstanceId}`, externalRow, 1)],
    assets: [],
    projectState: [],
  }, externalSnapshot({ '1': 0.75 }), 2)
  const row = model.entities[0]
  expect(row?.value).toMatchObject({
    manifest: { identity: { discoveredPath: '/local/Fixture.vst3' } },
    parameterOverrides: { '1': 0.75 },
    state: { location: '/local/state.bin' },
    updatedAt: 2,
  })
})

test('fails closed when an external processor row is missing or corrupt', () => {
  expect(() => materializeLocalControlSnapshot({
    entities: [],
    assets: [],
    projectState: [],
  }, externalSnapshot({ '1': 0.75 }), 2)).toThrow('missing or corrupt')
  expect(() => materializeLocalControlSnapshot({
    entities: [createLocalProjectEntityRow('external-plugin', `external-plugin:${externalInstanceId}`, { instanceId: externalInstanceId }, 1)],
    assets: [],
    projectState: [],
  }, externalSnapshot({ '1': 0.75 }), 2)).toThrow('missing or corrupt')
})
