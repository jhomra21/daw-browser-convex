import { expect, test } from 'bun:test'
import { AUDIO_EFFECT_CONTRACTS } from '@daw-browser/shared'

import {
  canonicalJson,
  controlRequestDigestSyncV1,
  controlActionSchemaV1,
  controlCapabilitiesV1,
  controlCapabilitiesV2,
  controlCapabilitiesSchemaV1,
  controlCapabilitiesSchemaV2,
  controlSnapshotQuerySchemaV1,
  canonicalControlApiVersion,
  canonicalControlLimits,
  canonicalControlCapabilities,
  canonicalControlCapabilitiesSchema,
  canonicalControlCapabilitiesQuerySchema,
  canonicalControlSnapshotQuerySchema,
  canonicalProjectSnapshotSchema,
  controlCommitResultSchemaV1,
  controlCommitRequestSchemaV1,
  controlHistoryEntrySchemaV1,
  controlHistoryQuerySchemaV1,
  controlHistoryResultSchemaV1,
  controlRequestDigestV1,
  controlErrorSchemaV1,
  controlLimitsV1,
  controlLimitsV2,
  controlPreviewResultSchemaV1,
  controlRequestDigestInputV1,
  findDuplicateCreationClientRefsV1,
  parseControlCommitRequestV1,
  parseControlHistoryQueryV1,
  parseControlPreviewRequestV1,
  parseControlSnapshotQueryV1,
  parseCanonicalControlSnapshotQuery,
  projectSnapshotSchemaV1,
  projectSnapshotSchemaV2,
  hashRecoveryPayloadSyncV1,
  hashRecoveryPayloadV1,
  canonicalRecoveryPayloadV1,
  canonicalRecoveryPayloadV2,
  canonicalCapturedRecoveryPayloadV2,
  parseCapturedRecoveryPayload,
  parseRecoveryPayload,
  recoveryPayloadSchemaV1,
  recoveryPayloadSchemaV2,
  recoveryCapturedPayloadSchemaV2,
  localControlCapabilitiesV1,
  localControlCapabilitiesV2,
  type ContextualRefV1,
  type ProcessorTargetV1,
  type RecoveryPayloadV2,
} from '@daw-browser/control'

const persisted = (id: string): ContextualRefV1 => ({ source: 'persisted', id })
const client = (clientRef: string): ContextualRefV1 => ({ source: 'client', clientRef })
const trackTarget = (track: ContextualRefV1): ProcessorTargetV1 => ({
  kind: 'track',
  track,
})
const masterTarget: ProcessorTargetV1 = { kind: 'master' }

type ControlCommitFixture = {
  version: string
  projectId: string
  expectedRevision?: number
  idempotencyKey: string
  actions: unknown[]
}
type ControlPreviewFixture = {
  version: string
  projectId: string
  expectedRevision?: number
  actions: unknown[]
}

const commit = (
  actions: unknown[],
  idempotencyKey = 'request-key',
): ControlCommitFixture => ({
  version: 'v1',
  projectId: 'project-1',
  expectedRevision: 0,
  idempotencyKey,
  actions,
})

const preview = (actions: unknown[]): ControlPreviewFixture => ({
  version: 'v1',
  projectId: 'project-1',
  expectedRevision: 0,
  actions,
})

const midiNotes = (count: number) => Array.from({ length: count }, (_, index) => ({
  beat: index / 4,
  length: 0.25,
  pitch: 48 + index % 36,
  velocity: 0.8,
}))

const automationPoints = (count: number) => Array.from({ length: count }, (_, index) => ({
  id: `point-${index}`,
  timeSec: index / 10,
  value: index / Math.max(1, count),
  interpolation: 'linear',
}))

const snapshot = {
  version: 'v1',
  project: {
    id: 'project-1',
    name: 'Project',
    revision: 1,
    tempoBpm: 120,
    timeSignature: { numerator: 4, denominator: 4 },
    loop: { enabled: false, startSec: 0, endSec: 8 },
    masterVolume: 0.8,
    updatedAt: 1,
  },
  tracks: [],
  clips: [],
  processors: [],
  automation: [],
  sidechains: [],
  assets: [],
  assetFolders: [],
}

const planningResult = {
  version: 'v1',
  projectId: 'project-1',
  priorRevision: 4,
  revision: 5,
  applied: true,
  requestDigest: '0'.repeat(64),
  resolvedRefs: [{ entity: 'track', clientRef: 'new-track', id: 'track-1', persisted: false }],
  warnings: [{ code: 'normalized', message: 'A value was normalized.', actionIndex: 0 }],
  changeSummary: {
    actionCount: 1,
    changes: [{ actionIndex: 0, kind: 'track.create', description: 'Create track.' }],
  },
}

test('parses persisted and client refs across every target category', () => {
  const request = parseControlCommitRequestV1(commit([
    { kind: 'track.create', clientRef: 'new-track', name: 'Bass', trackKind: 'instrument' },
    { kind: 'track.rename', track: client('new-track'), name: 'Bass Synth' },
    {
      kind: 'track.routing.set',
      track: persisted('track-1'),
      output: client('new-group'),
      sends: [{ target: persisted('return-1'), amount: 0.5 }],
    },
    {
      kind: 'track.reorder',
      tracks: [{ track: client('new-track'), index: 0, group: persisted('group-1') }],
    },
    { kind: 'track.group.set', track: persisted('track-1'), group: client('new-group') },
    {
      kind: 'clip.midi.create',
      clientRef: 'new-clip',
      track: client('new-track'),
      startSec: 0,
      duration: 1,
      wave: 'sine',
      notes: [],
    },
    { kind: 'clip.move', clip: client('new-clip'), track: persisted('track-2'), startSec: 2 },
    {
      kind: 'effect.upsert',
      target: trackTarget(client('new-track')),
      clientRef: 'new-effect',
      effectKind: 'eq',
    },
    {
      kind: 'automation.delete',
      target: masterTarget,
      effect: client('new-effect'),
      parameterId: 'gain',
    },
    {
      kind: 'sidechain.set',
      source: persisted('track-1'),
      target: client('new-track'),
      effect: persisted('compressor-1'),
    },
  ]))

  expect(request.projectId).toBe('project-1')
  expect(request.actions).toHaveLength(10)
  expect(request.actions.every((action) => !('projectId' in action))).toBe(true)
})

test('does not invent singleton instrument or arpeggiator references', () => {
  expect(() => parseControlCommitRequestV1(commit([{
    kind: 'instrument.set',
    target: trackTarget(client('new-track')),
    instrumentKind: 'synth',
  }]))).not.toThrow()
  expect(() => parseControlCommitRequestV1(commit([{
    kind: 'instrument.set',
    target: trackTarget(persisted('track-1')),
    instrument: persisted('instrument-1'),
    instrumentKind: 'synth',
  }]))).toThrow()
  expect(() => parseControlCommitRequestV1(commit([{
    kind: 'arpeggiator.set',
    target: trackTarget(persisted('track-1')),
    params: { enabled: true, pattern: 'up', rate: '1/8', octaves: 1, gate: 0.8, hold: false },
  }]))).not.toThrow()
  expect(() => parseControlCommitRequestV1(commit([{
    kind: 'arpeggiator.set',
    target: trackTarget(persisted('track-1')),
    clientRef: 'not-supported',
    params: { enabled: true, pattern: 'up', rate: '1/8', octaves: 1, gate: 0.8, hold: false },
  }]))).toThrow()
})

test('rejects raw, malformed, ambiguous, and non-strict refs', () => {
  const invalidTracks = [
    'track-1',
    { id: 'track-1' },
    { source: 'persisted', id: 'track-1', clientRef: 'track-client' },
    { source: 'client', clientRef: 'track-client', id: 'track-1' },
    { source: 'magic', id: 'track-1' },
  ]
  for (const track of invalidTracks) {
    expect(() => parseControlCommitRequestV1(commit([{
      kind: 'track.rename',
      track,
      name: 'Invalid',
    }]))).toThrow()
  }
  expect(() => parseControlCommitRequestV1(commit([{
    kind: 'effect.upsert',
    target: { kind: 'master', track: persisted('track-1') },
    effectKind: 'eq',
  }]))).toThrow()
  expect(() => parseControlCommitRequestV1(commit([{
    kind: 'effect.upsert',
    target: masterTarget,
    effect: persisted('effect-1'),
    clientRef: 'new-effect',
    effectKind: 'eq',
  }]))).toThrow()
})

test('detects duplicate creation client refs with the exported helper and envelope schemas', () => {
  const actions = controlActionSchemaV1.array().parse([
    { kind: 'track.create', clientRef: 'shared-ref' },
    {
      kind: 'clip.midi.create',
      clientRef: 'shared-ref',
      track: persisted('track-1'),
      startSec: 0,
      duration: 1,
      wave: 'sine',
      notes: [],
    },
    { kind: 'effect.upsert', target: masterTarget, clientRef: 'unique-ref', effectKind: 'eq' },
  ])
  expect(findDuplicateCreationClientRefsV1(actions)).toEqual(['shared-ref'])
  expect(() => parseControlCommitRequestV1(commit(actions))).toThrow()
  expect(() => parseControlPreviewRequestV1(preview(actions))).toThrow()
})

test('validates optional revisions and strict idempotency keys', () => {
  const withoutRevision = commit([{ kind: 'track.delete', track: persisted('track-1') }])
  delete withoutRevision.expectedRevision
  expect(() => parseControlCommitRequestV1(withoutRevision)).not.toThrow()

  const previewWithoutRevision = preview([{ kind: 'track.delete', track: persisted('track-1') }])
  delete previewWithoutRevision.expectedRevision
  expect(() => parseControlPreviewRequestV1(previewWithoutRevision)).not.toThrow()

  for (const idempotencyKey of ['short', 'contains space', 'contains/slash', 'ümlaut-key']) {
    expect(() => parseControlCommitRequestV1(commit([
      { kind: 'track.delete', track: persisted('track-1') },
    ], idempotencyKey))).toThrow()
  }
  expect(() => parseControlCommitRequestV1(commit([
    { kind: 'track.delete', track: persisted('track-1') },
  ], 'a'.repeat(128)))).not.toThrow()
  expect(() => parseControlCommitRequestV1(commit([
    { kind: 'track.delete', track: persisted('track-1') },
  ], 'a'.repeat(129)))).toThrow()
})

test('validates strict preview, commit, and error result envelopes', () => {
  expect(controlPreviewResultSchemaV1.parse(planningResult).revision).toBe(5)
  expect(() => controlPreviewResultSchemaV1.parse({ ...planningResult, snapshot })).toThrow()
  expect(controlCommitResultSchemaV1.parse({
    ...planningResult,
    revision: 5,
    applied: true,
    idempotencyReplay: false,
    recoveries: [],
    restored: [],
  }).revision).toBe(5)

  for (const code of [
    'invalid-request', 'validation', 'unsupported-action', 'revision-conflict',
    'idempotency-conflict', 'forbidden', 'authorization', 'not-found',
    'limit-exceeded', 'approval-required', 'internal',
  ]) {
    expect(() => controlErrorSchemaV1.parse({ version: 'v1', code, message: 'Error.' })).not.toThrow()
  }
  expect(() => controlErrorSchemaV1.parse({
    version: 'v1',
    code: 'validation',
    message: 'Error.',
    details: { field: 'Invalid value.' },
  })).not.toThrow()
  expect(() => controlErrorSchemaV1.parse({
    version: 'v1',
    code: 'validation',
    message: 'x'.repeat(1001),
  })).toThrow()
  expect(() => controlPreviewResultSchemaV1.parse({
    ...planningResult,
    warnings: Array.from({ length: controlLimitsV1.maxActions + 1 }, () => ({
      code: 'warning',
      message: 'Too many warnings.',
    })),
  })).toThrow()
  expect(() => controlCommitResultSchemaV1.parse({
    ...planningResult,
    revision: 5,
    applied: true,
    idempotencyReplay: false,
    serverInternal: true,
  })).toThrow()
})

test('validates bounded strict control history contracts', () => {
  const entry = controlHistoryEntrySchemaV1.parse({
    id: 'commit-1',
    projectId: 'project-1',
    actorSubject: 'user-1',
    actorIssuer: 'issuer-1',
    actorTokenIdentifier: 'token-1',
    actorRole: 'editor',
    idempotencyKey: 'history-key',
    requestDigest: '0'.repeat(64),
    priorRevision: 1,
    revision: 2,
    applied: true,
    createdAt: 1,
  })
  expect(controlHistoryQuerySchemaV1.parse({ projectId: 'project-1' })).toEqual({
    projectId: 'project-1',
    limit: controlLimitsV1.defaultHistoryPageSize,
  })
  expect(parseControlHistoryQueryV1({
    projectId: 'project-1',
    cursor: 'cursor-1',
    limit: controlLimitsV1.maxHistoryPageSize,
  }).limit).toBe(100)
  expect(() => controlHistoryQuerySchemaV1.parse({
    projectId: 'project-1',
    cursor: 'not valid\ncursor',
  })).toThrow()
  expect(() => controlHistoryQuerySchemaV1.parse({
    projectId: 'project-1',
    limit: controlLimitsV1.maxHistoryPageSize + 1,
  })).toThrow()
  expect(() => controlHistoryQuerySchemaV1.parse({
    projectId: 'project-1',
    extra: true,
  })).toThrow()
  expect(controlHistoryEntrySchemaV1.parse(entry)).toEqual(entry)
  expect(() => controlHistoryEntrySchemaV1.parse({
    ...entry,
    semanticRequest: '{}',
  })).toThrow()
  expect(controlHistoryResultSchemaV1.parse({
    entries: [entry],
    continueCursor: '_end_cursor',
    isDone: true,
  }).entries).toHaveLength(1)
  expect(() => controlHistoryResultSchemaV1.parse({
    entries: Array.from({ length: controlLimitsV1.maxHistoryPageSize + 1 }, () => entry),
    continueCursor: '_end_cursor',
    isDone: true,
  })).toThrow()
})

test('accepts opaque project IDs and rejects URL-interpretable project IDs everywhere', () => {
  const acceptedProjectIds = ['project-1', 'k9zzzzz', 'project:opaque_~id', 'project%20name']
  for (const projectId of acceptedProjectIds) {
    expect(() => parseControlCommitRequestV1({ ...commit([{ kind: 'project.rename', name: 'Project' }]), projectId })).not.toThrow()
    expect(() => parseControlPreviewRequestV1({ ...preview([{ kind: 'project.rename', name: 'Project' }]), projectId })).not.toThrow()
    expect(() => parseControlSnapshotQueryV1({ projectId })).not.toThrow()
    expect(() => parseControlHistoryQueryV1({ projectId })).not.toThrow()
    expect(() => controlPreviewResultSchemaV1.parse({ ...planningResult, projectId })).not.toThrow()
    expect(() => controlHistoryEntrySchemaV1.parse({
      id: 'commit-1',
      projectId,
      actorSubject: 'user-1',
      actorRole: 'editor',
      idempotencyKey: 'history-key',
      requestDigest: '0'.repeat(64),
      priorRevision: 1,
      revision: 2,
      applied: true,
      createdAt: 1,
    })).not.toThrow()
    expect(() => projectSnapshotSchemaV1.parse({
      ...snapshot,
      project: { ...snapshot.project, id: projectId },
    })).not.toThrow()
  }

  const forbiddenProjectIds = [
    '.', '..', 'project/id', 'project\\id', 'project%2fid', 'project%2Fid',
    'project%5cid', 'project%5Cid', 'project?id', 'project#id',
    'project%3fid', 'project%23id', 'project%00id', 'project%1Fid', 'project%7fid',
    'project\nid', `project${String.fromCharCode(127)}id`,
  ]
  for (const projectId of forbiddenProjectIds) {
    expect(() => parseControlCommitRequestV1({ ...commit([{ kind: 'project.rename', name: 'Project' }]), projectId })).toThrow()
    expect(() => parseControlPreviewRequestV1({ ...preview([{ kind: 'project.rename', name: 'Project' }]), projectId })).toThrow()
    expect(() => parseControlSnapshotQueryV1({ projectId })).toThrow()
    expect(() => parseControlHistoryQueryV1({ projectId })).toThrow()
    expect(() => controlPreviewResultSchemaV1.parse({ ...planningResult, projectId })).toThrow()
    expect(() => controlHistoryEntrySchemaV1.parse({
      id: 'commit-1',
      projectId,
      actorSubject: 'user-1',
      actorRole: 'editor',
      idempotencyKey: 'history-key',
      requestDigest: '0'.repeat(64),
      priorRevision: 1,
      revision: 2,
      applied: true,
      createdAt: 1,
    })).toThrow()
    expect(() => projectSnapshotSchemaV1.parse({
      ...snapshot,
      project: { ...snapshot.project, id: projectId },
    })).toThrow()
  }
})

test('semantic digest input is canonical and excludes idempotency', () => {
  const first = parseControlCommitRequestV1(commit([{
    kind: 'track.rename',
    track: persisted('track-1'),
    name: 'Bass',
  }], 'request-0001'))
  const second = parseControlCommitRequestV1({
    actions: [{ name: 'Bass', track: { id: 'track-1', source: 'persisted' }, kind: 'track.rename' }],
    idempotencyKey: 'request-0002',
    expectedRevision: 0,
    projectId: 'project-1',
    version: 'v1',
  })
  const previewRequest = parseControlPreviewRequestV1(preview(first.actions))

  expect(controlRequestDigestInputV1(first)).toBe(controlRequestDigestInputV1(second))
  expect(controlRequestDigestInputV1(first)).toBe(controlRequestDigestInputV1(previewRequest))
  expect(controlRequestDigestInputV1(first)).not.toContain('request-0001')
  expect(controlRequestDigestInputV1(first)).toBe(canonicalJson({
    actions: first.actions,
    expectedRevision: 0,
    projectId: 'project-1',
    version: 'v1',
  }))
})

test('computes stable SHA-256 semantic request digests', async () => {
  const first = parseControlCommitRequestV1(commit([{
    kind: 'track.rename',
    track: persisted('track-1'),
    name: 'Bass',
  }], 'request-0001'))
  const second = parseControlCommitRequestV1(commit([{
    kind: 'track.rename',
    track: persisted('track-1'),
    name: 'Bass',
  }], 'request-0002'))
  const changed = parseControlCommitRequestV1(commit([{
    kind: 'track.rename',
    track: persisted('track-1'),
    name: 'Lead',
  }], 'request-0001'))

  const digest = await controlRequestDigestV1(first)
  expect(digest).toMatch(/^[0-9a-f]{64}$/)
  expect(await controlRequestDigestV1(second)).toBe(digest)
  expect(await controlRequestDigestV1(changed)).not.toBe(digest)
})

test('hashes canonical Unicode and empty payloads synchronously with WebCrypto-equivalent wrappers', async () => {
  const request = parseControlCommitRequestV1(commit([{
    kind: 'project.rename',
    name: 'Åudio 🎛️',
  }]))
  const asyncDigest = await controlRequestDigestV1(request)
  expect(controlRequestDigestSyncV1(request)).toBe(asyncDigest)
  const emptyDigest = hashRecoveryPayloadSyncV1('')
  const webCrypto = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(''))
  expect(emptyDigest).toBe(Array.from(new Uint8Array(webCrypto), (byte) => byte.toString(16).padStart(2, '0')).join(''))
  expect(canonicalJson({ z: 1, a: 'Åudio 🎛️' })).toBe('{"a":"Åudio 🎛️","z":1}')
})

test('keeps cloud recovery payload bytes canonical while accepting strict local storage variants', async () => {
  const cloud = recoveryPayloadSchemaV1.parse({
    version: 1,
    kind: 'asset.delete',
    data: {
      assetId: 'asset-1',
      asset: {
        projectId: 'project-1', assetKey: 'asset-1', sourceKind: 'upload',
        name: 'Kick.wav', mimeType: 'audio/wav', sizeBytes: 1, contentSha256: 'a'.repeat(64),
        r2Key: 'projects/project-1/assets/asset-1/kick.wav', ownerUserId: 'user-1',
        createdAt: 1, updatedAt: 1,
      },
    },
  })
  const local = recoveryPayloadSchemaV1.parse({
    version: 1,
    kind: 'asset.delete',
    data: {
      assetId: 'asset-1',
      asset: {
        projectId: 'project-1', assetKey: 'asset-1', sourceKind: 'upload',
        name: 'Kick.wav', mimeType: 'audio/wav', sizeBytes: 1, contentSha256: 'a'.repeat(64),
        storagePath: 'asset-1.wav', createdAt: 1, updatedAt: 1,
      },
    },
  })
  const bytes = canonicalRecoveryPayloadV1(cloud)
  expect(bytes).toBe(canonicalJson(cloud))
  expect(await hashRecoveryPayloadV1(bytes)).toBe(hashRecoveryPayloadSyncV1(bytes))
  expect(JSON.stringify(local)).not.toContain('r2Key')
})

test('verifies legacy recovery bytes before normalizing note-only MIDI', () => {
  const legacy = {
    version: 1 as const,
    kind: 'clip.delete' as const,
    data: {
      clipId: 'clip-1',
      ownership: { projectId: 'project-1', localActorSubject: 'actor-1' },
      clip: {
        projectId: 'project-1',
        trackId: 'track-1',
        startSec: 0,
        duration: 1,
        midi: { wave: 'sine', notes: [{ beat: 0, length: 1, pitch: 60 }] },
      },
    },
  }
  const stored = canonicalJson(legacy)
  const restored = parseRecoveryPayload(stored)
  if (restored.kind !== 'clip.delete') throw new Error('Expected clip recovery payload.')
  expect(restored.data.clip.midi).toMatchObject({
    notes: [{ channel: 1 }],
    cc: [],
    pitchBends: [],
    channelPressure: [],
    polyPressure: [],
    mappings: [],
  })
})

test('keeps exact V1 recovery bytes and rejects expanded MIDI fields', () => {
  const legacy = {
    version: 1 as const,
    kind: 'clip.delete' as const,
    data: {
      clipId: 'clip-1',
      ownership: { projectId: 'project-1', localActorSubject: 'actor-1' },
      clip: {
        projectId: 'project-1',
        trackId: 'track-1',
        startSec: 0,
        duration: 1,
        midi: { wave: 'sine', gain: 1, notes: [{ beat: 0, length: 1, pitch: 60, velocity: 0.5 }] },
      },
    },
  }
  const bytes = canonicalRecoveryPayloadV1(recoveryPayloadSchemaV1.parse(legacy))
  expect(bytes).toBe(canonicalJson(legacy))
  const emptyWave = recoveryPayloadSchemaV1.parse({
    ...legacy,
    data: { ...legacy.data, clip: { ...legacy.data.clip, midi: { ...legacy.data.clip.midi, wave: '' } } },
  })
  expect(canonicalRecoveryPayloadV1(emptyWave)).toBe(canonicalJson(emptyWave))
  expect(parseRecoveryPayload(canonicalRecoveryPayloadV1(emptyWave))).toMatchObject({
    version: 2,
    data: { clip: { midi: { wave: '' } } },
  })
  expect(() => recoveryPayloadSchemaV1.parse({
    ...legacy,
    data: { ...legacy.data, clip: { ...legacy.data.clip, midi: { ...legacy.data.clip.midi, inputChannel: 1 } } },
  })).toThrow()
})

test('parses and hashes a 501-note canonical V1 recovery without applying V2 write limits', async () => {
  const legacy = recoveryPayloadSchemaV1.parse({
    version: 1,
    kind: 'clip.delete',
    data: {
      clipId: 'clip-1',
      ownership: { projectId: 'project-1', localActorSubject: 'actor-1' },
      clip: {
        projectId: 'project-1',
        trackId: 'track-1',
        startSec: 0,
        duration: 501,
        midi: { wave: 'sine', notes: midiNotes(501) },
      },
    },
  })
  const bytes = canonicalRecoveryPayloadV1(legacy)
  expect(await hashRecoveryPayloadV1(bytes)).toBe(hashRecoveryPayloadSyncV1(bytes))
  const restored = parseRecoveryPayload(bytes)
  if (restored.kind !== 'clip.delete') throw new Error('Expected clip recovery payload.')
  expect(restored.data.clip.midi?.notes).toHaveLength(501)
})

test('round-trips canonical V2 recovery MIDI without changing fields', () => {
  const payload = recoveryPayloadSchemaV2.parse({
    version: 2,
    kind: 'clip.delete',
    data: {
      clipId: 'clip-1',
      ownership: { projectId: 'project-1', localActorSubject: 'actor-1' },
      clip: {
        projectId: 'project-1',
        trackId: 'track-1',
        startSec: 0,
        duration: 1,
        midi: {
          wave: 'sine',
          inputChannel: 2,
          notes: [{ id: 'note-1', beat: 0, length: 1, pitch: 60, velocity: 0.5, channel: 2 }],
          cc: [{ id: 'cc-1', beat: 0, controller: 1, value: 0.5, channel: 2 }],
          pitchBends: [],
          channelPressure: [],
          polyPressure: [],
          mappings: [{ id: 'mapping-1', source: { kind: 'cc', controller: 1, channel: 2 }, target: { parameterId: 'gain' }, outputMin: 0, outputMax: 1 }],
        },
      },
    },
  })
  const bytes = canonicalRecoveryPayloadV2(payload)
  expect(parseRecoveryPayload(bytes)).toEqual(payload)
  expect(() => parseRecoveryPayload(bytes.replace('"version":2', '"version":1'))).toThrow()
})

test('rejects expanded V2 recovery MIDI limits and duplicate supplied IDs', () => {
  const recovery = (
    midi: NonNullable<Extract<RecoveryPayloadV2, { kind: 'clip.delete' }>['data']['clip']['midi']>,
  ) => ({
    version: 2 as const,
    kind: 'clip.delete' as const,
    data: {
      clipId: 'clip-1',
      ownership: { projectId: 'project-1', localActorSubject: 'actor-1' },
      clip: { projectId: 'project-1', trackId: 'track-1', startSec: 0, duration: 1, midi },
    },
  }) satisfies Extract<RecoveryPayloadV2, { kind: 'clip.delete' }>
  expect(() => canonicalRecoveryPayloadV2(recovery({
    wave: 'sine',
    notes: midiNotes(501).map((note, index) => ({ ...note, id: `note-${index}`, channel: 1 })),
    cc: [{ id: 'cc-1', beat: 0, controller: 1, value: 0, channel: 1 }],
  }))).toThrow('performance events')
  expect(() => canonicalRecoveryPayloadV2(recovery({
    wave: 'sine',
    notes: [
      { id: 'duplicate', beat: 0, length: 1, pitch: 60, channel: 1 },
      { id: 'duplicate', beat: 1, length: 1, pitch: 61, channel: 1 },
    ],
  }))).toThrow('IDs must be unique')
})

test('captures oversized durable V2 MIDI without relaxing new recovery payload limits', () => {
  const oversizedMidi = {
    wave: 'custom-legacy',
    gain: 7,
    notes: midiNotes(500).map((note, index) => ({ ...note, id: `note-${index}`, channel: 1 })),
    cc: [{ id: 'cc-1', beat: 0, controller: 1, value: 0, channel: 1 }],
  }
  const clipPayload = {
    version: 2 as const,
    kind: 'clip.delete' as const,
    data: {
      clipId: 'clip-1',
      ownership: { projectId: 'project-1', localActorSubject: 'actor-1' },
      clip: { projectId: 'project-1', trackId: 'track-1', startSec: 0, duration: 1, midi: oversizedMidi },
    },
  }
  expect(() => recoveryPayloadSchemaV2.parse(clipPayload)).toThrow()
  const bytes = canonicalCapturedRecoveryPayloadV2(recoveryCapturedPayloadSchemaV2.parse(clipPayload))
  const parsed = parseCapturedRecoveryPayload(bytes)
  if (parsed.kind !== 'clip.delete') throw new Error('Expected clip recovery payload.')
  expect(parsed.data.clip.midi?.notes).toHaveLength(500)
  expect(parsed.data.clip.midi?.cc).toHaveLength(1)
  expect(parsed.data.clip.midi).toMatchObject({ wave: 'custom-legacy', gain: 7 })
  expect(hashRecoveryPayloadSyncV1(bytes)).toHaveLength(64)
  expect(bytes).toBe(canonicalCapturedRecoveryPayloadV2(recoveryCapturedPayloadSchemaV2.parse(JSON.parse(bytes))))

  const trackPayload = {
    version: 2 as const,
    kind: 'track.delete' as const,
    data: {
      rootTrackId: 'track-1',
      tracks: [{
        id: 'track-1',
        track: {
          projectId: 'project-1',
          name: 'Track 1',
          index: 0,
          mixer: { volume: 1, channelRole: 'track' as const, sends: [] },
        },
        ownership: { projectId: 'project-1', localActorSubject: 'actor-1' },
      }],
      clips: [{
        id: 'clip-1',
        clip: clipPayload.data.clip,
        ownership: clipPayload.data.ownership,
      }],
      effects: [],
      automation: [],
      sidechains: [],
      survivors: [],
    },
  }
  expect(() => recoveryPayloadSchemaV2.parse(trackPayload)).toThrow()
  const trackBytes = canonicalCapturedRecoveryPayloadV2(recoveryCapturedPayloadSchemaV2.parse(trackPayload))
  const parsedTrack = parseCapturedRecoveryPayload(trackBytes)
  if (parsedTrack.kind !== 'track.delete') throw new Error('Expected track recovery payload.')
  expect(parsedTrack.data.clips[0]?.clip.midi?.notes).toHaveLength(500)
  expect(parsedTrack.data.clips[0]?.clip.midi?.cc).toHaveLength(1)
})

test('projects historical finite MIDI values through the narrow V1 snapshot schema', () => {
  const legacyMidi = {
    wave: 'custom-legacy',
    gain: 7,
    notes: [{ beat: -2, length: -1, pitch: 200, velocity: 2 }],
  }
  const parsed = projectSnapshotSchemaV1.parse({
    ...snapshot,
    clips: [{
      id: 'clip-1',
      trackId: 'track-1',
      name: 'Legacy MIDI',
      startSec: 0,
      duration: 1,
      leftPadSec: 0,
      bufferOffsetSec: 0,
      midiOffsetBeats: 0,
      midi: legacyMidi,
    }],
  })
  expect(parsed.clips[0]?.midi).toEqual(legacyMidi)
  expect(() => parseControlCommitRequestV1(commit([{
    kind: 'clip.midi.create',
    track: persisted('track-1'),
    startSec: 0,
    duration: 1,
    wave: 'sine',
    notes: legacyMidi.notes,
  }]))).toThrow()
})

test('rejects external snapshots with oversized parameter override records', () => {
  const parameterOverrides = Object.fromEntries(
    Array.from({ length: 16_385 }, (_, index) => [String(index), 0]),
  )
  expect(() => projectSnapshotSchemaV1.parse({
    ...snapshot,
    processors: [{
      id: 'external-plugin:instance-1',
      target: { master: true },
      instanceId: 'instance-1',
      index: 0,
      processor: {
        kind: 'external-vst3',
        params: {
          identity: { name: 'Fixture', vendor: 'Vendor', classId: 'class-1', role: 'effect' },
          bypassed: false,
          parameterOverrides,
          parameters: [],
        },
      },
    }],
  })).toThrow()
})

test('enforces MIDI and automation aggregates at exact boundaries for preview and commit', () => {
  const boundaryActions = [
    {
      kind: 'clip.midi.create',
      track: persisted('track-1'),
      startSec: 0,
      duration: 128,
      wave: 'sine',
      notes: midiNotes(controlLimitsV1.maxMidiNotesPerCommit),
    },
    {
      kind: 'automation.set',
      target: masterTarget,
      parameterId: 'volume',
      enabled: true,
      points: automationPoints(controlLimitsV1.maxAutomationPointsPerCommit),
    },
  ]
  expect(() => parseControlCommitRequestV1(commit(boundaryActions))).not.toThrow()
  expect(() => parseControlPreviewRequestV1(preview(boundaryActions))).not.toThrow()

  const midiOver = [
    { ...boundaryActions[0], notes: midiNotes(251) },
    { ...boundaryActions[0], notes: midiNotes(250) },
  ]
  const automationOver = [
    { ...boundaryActions[1], points: automationPoints(501) },
    { ...boundaryActions[1], points: automationPoints(500) },
  ]
  expect(() => parseControlCommitRequestV1(commit(midiOver))).toThrow()
  expect(() => parseControlPreviewRequestV1(preview(midiOver))).toThrow()
  expect(() => parseControlCommitRequestV1(commit(automationOver))).toThrow()
  expect(() => parseControlPreviewRequestV1(preview(automationOver))).toThrow()
})

test('reports expanded MIDI aggregate overflow through safeParse', () => {
  const result = controlCommitRequestSchemaV1.safeParse(commit([{
    kind: 'clip.midi.create',
    track: persisted('track-1'),
    startSec: 0,
    duration: 1,
    wave: 'sine',
    notes: midiNotes(500),
    cc: [{ id: 'cc-1', beat: 0, controller: 1, value: 0, channel: 1 }],
  }]))
  expect(result.success).toBe(false)
})

test('aggregates strict MIDI set payloads while preserving oversized legacy set envelopes', () => {
  const set = (notes: number, mappings = 0) => ({
    kind: 'clip.midi.set' as const,
    clip: persisted('clip-1'),
    wave: 'sine',
    notes: midiNotes(notes),
    mappings: mappings === 0 ? undefined : Array.from({ length: mappings }, (_, index) => ({
        id: `mapping-${index}`,
        source: { kind: 'cc' as const, controller: index, channel: 1 },
        target: { parameterId: 'gain' },
        outputMin: 0,
        outputMax: 1,
      })),
  })
  expect(() => parseControlPreviewRequestV1(preview([set(250), set(251)]))).toThrow('MIDI performance events')
  expect(() => parseControlCommitRequestV1(commit([
    {
      kind: 'clip.midi.create',
      track: persisted('track-1'),
      startSec: 0,
      duration: 1,
      wave: 'sine',
      notes: midiNotes(250),
    },
    set(251),
  ]))).toThrow('MIDI performance events')
  expect(() => parseControlPreviewRequestV1(preview([set(1, 40), set(1, 40)]))).not.toThrow()
  expect(() => parseControlPreviewRequestV1(preview([set(501)]))).not.toThrow()
})

test('enforces action count for preview and commit', () => {
  const boundary = Array.from({ length: controlLimitsV1.maxActions }, () => ({
    kind: 'track.delete',
    track: persisted('track-1'),
  }))
  expect(() => parseControlCommitRequestV1(commit(boundary))).not.toThrow()
  expect(() => parseControlPreviewRequestV1(preview(boundary))).not.toThrow()
  expect(() => parseControlCommitRequestV1(commit([...boundary, boundary[0]]))).toThrow()
  expect(() => parseControlPreviewRequestV1(preview([...boundary, boundary[0]]))).toThrow()
})

const requestOfByteLength = (byteLength: number, mode: 'commit' | 'preview') => {
  const actions = Array.from({ length: controlLimitsV1.maxActions }, () => ({
    kind: 'track.routing.set',
    track: persisted('track-1'),
    sends: Array.from({ length: 16 }, () => ({ target: persisted('x'), amount: 1 })),
  }))
  const request = mode === 'commit' ? commit(actions) : preview(actions)
  const baseline = new TextEncoder().encode(canonicalJson(request)).byteLength
  let remaining = byteLength - baseline
  for (const action of actions) {
    for (const send of action.sends) {
      const extension = Math.min(255, Math.max(0, remaining))
      if (send.target.source !== 'persisted') throw new Error('Expected a persisted routing target.')
      send.target.id = `x${'x'.repeat(extension)}`
      remaining -= extension
    }
  }
  if (remaining !== 0) throw new Error('Requested routing fixture size is unavailable.')
  return request
}

test('accepts serialized request boundaries and rejects one byte over for preview and commit', () => {
  const commitLimit = requestOfByteLength(controlLimitsV1.maxSerializedBodyBytes, 'commit')
  const commitOver = requestOfByteLength(controlLimitsV1.maxSerializedBodyBytes + 1, 'commit')
  const previewLimit = requestOfByteLength(controlLimitsV1.maxSerializedBodyBytes, 'preview')
  const previewOver = requestOfByteLength(controlLimitsV1.maxSerializedBodyBytes + 1, 'preview')

  expect(() => parseControlCommitRequestV1(commitLimit)).not.toThrow()
  expect(() => parseControlCommitRequestV1(commitOver)).toThrow()
  expect(() => parseControlPreviewRequestV1(previewLimit)).not.toThrow()
  expect(() => parseControlPreviewRequestV1(previewOver)).toThrow()
})

test('rejects oversized raw requests before trim normalization for preview and commit', () => {
  const oversizedName = `Name${' '.repeat(controlLimitsV1.maxSerializedBodyBytes)}`
  const commitRequest = commit([{ kind: 'project.rename', name: oversizedName }])
  const previewRequest = preview([{ kind: 'project.rename', name: oversizedName }])

  expect(() => parseControlCommitRequestV1(commitRequest)).toThrow('serialized body limit')
  expect(() => parseControlPreviewRequestV1(previewRequest)).toThrow('serialized body limit')
  expect(canonicalJson({
    ...commitRequest,
    actions: [{ kind: 'project.rename', name: 'Name' }],
  }).length).toBeLessThan(controlLimitsV1.maxSerializedBodyBytes)
  expect(() => parseControlCommitRequestV1(new Date())).toThrow('Canonical JSON')
})

test('preserves the truthful v1 action list and snapshot contract', () => {
  expect(controlCapabilitiesSchemaV1.parse(controlCapabilitiesV1)).toEqual(controlCapabilitiesV1)
  expect(controlCapabilitiesSchemaV1.parse(localControlCapabilitiesV1)).toEqual(localControlCapabilitiesV1)
  expect(controlCapabilitiesV1.limits.maxAutomationPointsPerCommit).toBe(1000)
  expect(controlCapabilitiesV1.limits.maxErrorDetails).toBe(16)
  expect(controlCapabilitiesV1.limits).not.toHaveProperty('maxMidiPerformanceEventsPerClip')
  expect(controlCapabilitiesV1.limits).not.toHaveProperty('maxMidiEventsPerArray')
  expect(controlCapabilitiesV1.limits).not.toHaveProperty('maxMidiMappingsPerClip')
  expect(controlCapabilitiesV1.actionKinds).toHaveLength(39)
  expect(controlCapabilitiesV1.actionKinds).toEqual([
    'project.rename', 'project.settings.set', 'track.create', 'track.rename',
    'track.mix.set', 'track.routing.set', 'track.reorder', 'track.group.set',
    'track.delete', 'clip.midi.create', 'clip.move', 'clip.timing.set',
    'clip.rename', 'clip.delete', 'master.volume.set', 'timeline.range.delete', 'effect.upsert',
    'effect.remove', 'effect.reorder', 'instrument.set', 'arpeggiator.set',
    'automation.set', 'automation.delete', 'sidechain.set', 'sidechain.remove',
    'clip.audio.create', 'clip.source.set', 'clip.midi.set', 'clip.fades.set',
    'clip.audioWarp.set', 'clip.color.set', 'track.collapsed.set', 'track.color.set',
    'track.color.cascade', 'track.ungroup', 'instrument.remove', 'arpeggiator.remove',
    'asset.delete', 'recovery.restore',
  ])
  expect(localControlCapabilitiesV1.actionKinds).toHaveLength(40)
  expect(localControlCapabilitiesV1.actionKinds).toEqual([
    ...controlCapabilitiesV1.actionKinds,
    'external-plugin.parameters.set',
  ])
  expect(controlCapabilitiesV1.actionKinds).not.toContain('external-plugin.parameters.set')
  expect(localControlCapabilitiesV1.actionKinds).toContain('external-plugin.parameters.set')
  expect(controlCapabilitiesV2.actionKinds).not.toContain('external-plugin.parameters.set')
  expect(localControlCapabilitiesV2.actionKinds).toContain('external-plugin.parameters.set')
  expect(controlCapabilitiesV1.actionKinds).not.toContain('clip.create')
  expect(controlCapabilitiesV1.actionKinds).not.toContain('effect.add')
  expect(projectSnapshotSchemaV1.parse(snapshot).project.masterVolume).toBe(0.8)
})

test('parses every Phase 5B action strictly', () => {
  const track = persisted('track-1')
  const clip = persisted('clip-1')
  const asset = { source: 'persisted' as const, id: 'asset-1' }
  const target = trackTarget(track)
  const actions = [
    { kind: 'clip.audio.create', track, asset },
    { kind: 'clip.source.set', clip, asset },
    { kind: 'clip.midi.set', clip, wave: 'sine', notes: [] },
    { kind: 'clip.fades.set', clip, fades: { fadeInSec: 0, fadeOutSec: 0, fadeInCurve: 0, fadeOutCurve: 0 } },
    { kind: 'clip.audioWarp.set', clip, audioWarp: { enabled: false, mode: 'repitch' } },
    { kind: 'clip.color.set', clip, color: null },
    { kind: 'track.collapsed.set', track, collapsed: true },
    { kind: 'track.color.set', track, color: null },
    { kind: 'track.color.cascade', root: track, color: '#22c55e', cascadeClipColors: true },
    { kind: 'track.ungroup', group: track },
    {
      kind: 'external-plugin.parameters.set',
      target,
      processor: persisted('external-plugin:instance-1'),
      changes: [{ parameterId: 1, normalizedValue: 0.5 }],
    },
    { kind: 'instrument.remove', target },
    { kind: 'arpeggiator.remove', target },
    { kind: 'asset.delete', asset },
    { kind: 'timeline.range.delete', tracks: [track], startSec: 0, endSec: 1 },
  ]
  for (const action of actions) expect(() => parseControlCommitRequestV1(commit([action]))).not.toThrow()
  expect(() => parseControlCommitRequestV1(commit([{
    kind: 'clip.audio.create', track, asset: { source: 'persisted', id: 'asset-1', key: 'raw-key' },
  }]))).toThrow()
  expect(controlActionSchemaV1.safeParse({
    kind: 'external-plugin.parameters.set',
    target,
    processor: persisted('external-plugin:instance-1'),
    changes: [
      { parameterId: 1, normalizedValue: 0.5 },
      { parameterId: 1, normalizedValue: 0.75 },
    ],
  }).success).toBe(false)
  expect(controlActionSchemaV1.safeParse({
    kind: 'external-plugin.parameters.set',
    target,
    processor: persisted('external-plugin:instance-1'),
    changes: [{ parameterId: 1, normalizedValue: Number.NaN }],
  }).success).toBe(false)
  for (const parameterId of [0, 0x7fff_ffff, 0x8000_0000, 0xffff_ffff]) {
    expect(controlActionSchemaV1.safeParse({
      kind: 'external-plugin.parameters.set',
      target,
      processor: persisted('external-plugin:instance-1'),
      changes: [{ parameterId, normalizedValue: 0.5 }],
    }).success).toBe(true)
  }
  expect(controlActionSchemaV1.safeParse({
    kind: 'external-plugin.parameters.set',
    target,
    processor: persisted('external-plugin:instance-1'),
    changes: [{ parameterId: 0x1_0000_0000, normalizedValue: 0.5 }],
  }).success).toBe(false)
})

test('accepts every canonical effect payload and rejects unknown nested fields', () => {
  for (const [effectKind, contract] of Object.entries(AUDIO_EFFECT_CONTRACTS)) {
    const action = {
      kind: 'effect.upsert',
      target: trackTarget(persisted('track-1')),
      effect: persisted(`${effectKind}-1`),
      effectKind,
      params: contract.createDefaultParams(),
    }
    expect(() => parseControlCommitRequestV1(commit([action]))).not.toThrow()
    expect(() => parseControlCommitRequestV1(commit([{
      ...action,
      params: { ...action.params, unexpected: true },
    }]))).toThrow()
  }
})

test('keeps V1 capabilities strict and exposes additive MIDI limits in V2', () => {
  expect(() => controlCapabilitiesSchemaV1.parse({
    ...controlCapabilitiesV1,
    limits: { ...controlCapabilitiesV1.limits, maxMidiEventsPerArray: 500 },
  })).toThrow()
  const parsed = controlCapabilitiesSchemaV2.parse(controlCapabilitiesV2)
  expect(parsed.limits.maxMidiPerformanceEventsPerClip).toBe(controlLimitsV2.maxMidiPerformanceEventsPerClip)
  expect(parsed.limits.maxMidiEventsPerArray).toBe(controlLimitsV2.maxMidiEventsPerArray)
  expect(parsed.limits.maxMidiMappingsPerClip).toBe(controlLimitsV2.maxMidiMappingsPerClip)
})

test('exposes canonical aliases over the existing high-fidelity V2 contracts', () => {
  expect(canonicalControlApiVersion).toBe('v2')
  expect(canonicalControlLimits).toBe(controlLimitsV2)
  expect(canonicalControlCapabilities).toBe(controlCapabilitiesV2)
  expect(canonicalControlCapabilitiesSchema).toBe(controlCapabilitiesSchemaV2)
  expect(canonicalControlCapabilitiesQuerySchema.parse({})).toEqual({})
  expect(canonicalControlSnapshotQuerySchema).toBe(controlSnapshotQuerySchemaV1)
  expect(parseCanonicalControlSnapshotQuery({ projectId: 'project-1' })).toEqual(
    parseControlSnapshotQueryV1({ projectId: 'project-1' }),
  )

  const parsedV2 = projectSnapshotSchemaV2.parse({ ...snapshot, version: 'v2' })
  expect(canonicalProjectSnapshotSchema).toBe(projectSnapshotSchemaV2)
  expect(canonicalProjectSnapshotSchema.parse({ ...snapshot, version: 'v2' })).toEqual(parsedV2)
})

test('keeps the canonical request serialization and digest fixture unchanged', () => {
  const request = parseControlCommitRequestV1(commit([{
    kind: 'track.rename',
    track: persisted('track-1'),
    name: 'Bass',
  }]))
  expect(controlRequestDigestInputV1(request)).toBe(
    '{"actions":[{"kind":"track.rename","name":"Bass","track":{"id":"track-1","source":"persisted"}}],"expectedRevision":0,"projectId":"project-1","version":"v1"}',
  )
  expect(controlRequestDigestSyncV1(request)).toBe('792d0816df2a942166689ec8b3ce745ce2c6305bd072e86e2e822dc0e48bad21')
})

test('rejects duplicate MIDI event and mapping IDs while permitting legacy mapping envelopes', () => {
  const action = {
    kind: 'clip.midi.set' as const,
    clip: persisted('clip-1'),
    wave: 'sine' as const,
    notes: [{ id: 'duplicate', beat: 0, length: 1, pitch: 60 }],
  }
  expect(controlActionSchemaV1.safeParse({
    ...action,
    notes: [...action.notes, { id: 'duplicate', beat: 1, length: 1, pitch: 61 }],
  }).success).toBe(false)
  expect(controlActionSchemaV1.safeParse({
    ...action,
    cc: [{ id: 'duplicate', beat: 0, controller: 1, value: 0 }],
  }).success).toBe(false)
  expect(controlActionSchemaV1.safeParse({
    ...action,
    mappings: [
      { id: 'mapping', source: { kind: 'cc', controller: 1 }, target: { parameterId: 'gain' }, outputMin: 0, outputMax: 1 },
      { id: 'mapping', source: { kind: 'cc', controller: 2 }, target: { parameterId: 'gain' }, outputMin: 0, outputMax: 1 },
    ],
  }).success).toBe(false)
  expect(controlActionSchemaV1.safeParse({
    ...action,
    mappings: Array.from({ length: 65 }, (_, index) => ({
      id: `mapping-${index}`,
      source: { kind: 'cc' as const, controller: index },
      target: { parameterId: 'gain' },
      outputMin: 0,
      outputMax: 1,
    })),
  }).success).toBe(true)
})
