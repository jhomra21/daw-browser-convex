import { expect, test } from 'bun:test'
import { AUDIO_EFFECT_CONTRACTS } from '@daw-browser/shared'

import {
  canonicalJson,
  controlActionSchemaV1,
  controlCapabilitiesV1,
  controlCapabilitiesSchemaV1,
  controlCommitResultSchemaV1,
  controlHistoryEntrySchemaV1,
  controlHistoryQuerySchemaV1,
  controlHistoryResultSchemaV1,
  controlRequestDigestV1,
  controlErrorSchemaV1,
  controlLimitsV1,
  destructiveControlActionKindsV1,
  controlPreviewResultSchemaV1,
  controlRequestDigestInputV1,
  findDuplicateCreationClientRefsV1,
  parseControlCommitRequestV1,
  parseControlHistoryQueryV1,
  parseControlPreviewRequestV1,
  parseControlSnapshotQueryV1,
  projectSnapshotSchemaV1,
  type ContextualRefV1,
  type ProcessorTargetV1,
} from './index'

const persisted = (id: string): ContextualRefV1 => ({ source: 'persisted', id })
const client = (clientRef: string): ContextualRefV1 => ({ source: 'client', clientRef })
const trackTarget = (track: ContextualRefV1): ProcessorTargetV1 => ({
  kind: 'track',
  track,
})
const masterTarget: ProcessorTargetV1 = { kind: 'master' }

const commit = (actions: unknown[], idempotencyKey = 'request-0001'): {
  version: string
  projectId: string
  expectedRevision?: number
  idempotencyKey: string
  actions: unknown[]
} => ({
  version: 'v1',
  projectId: 'project-1',
  expectedRevision: 0,
  idempotencyKey,
  actions,
})

const preview = (actions: unknown[]): {
  version: string
  projectId: string
  expectedRevision?: number
  actions: unknown[]
} => ({
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
  expect(controlCapabilitiesV1.limits.maxAutomationPointsPerCommit).toBe(1000)
  expect(controlCapabilitiesV1.limits.maxErrorDetails).toBe(16)
  expect(controlCapabilitiesV1.actionKinds).toHaveLength(37)
  expect(controlCapabilitiesV1.actionKinds).toEqual([
    'project.rename', 'project.settings.set', 'track.create', 'track.rename',
    'track.mix.set', 'track.routing.set', 'track.reorder', 'track.group.set',
    'track.delete', 'clip.midi.create', 'clip.move', 'clip.timing.set',
    'clip.rename', 'clip.delete', 'master.volume.set', 'effect.upsert',
    'effect.remove', 'effect.reorder', 'instrument.set', 'arpeggiator.set',
    'automation.set', 'automation.delete', 'sidechain.set', 'sidechain.remove',
    'clip.audio.create', 'clip.source.set', 'clip.midi.set', 'clip.fades.set',
    'clip.audioWarp.set', 'clip.color.set', 'track.collapsed.set', 'track.color.set',
    'track.color.cascade', 'track.ungroup', 'instrument.remove', 'arpeggiator.remove',
    'asset.delete',
  ])
  expect(controlCapabilitiesV1.actionKinds).not.toContain('clip.create')
  expect(controlCapabilitiesV1.actionKinds).not.toContain('effect.add')
  expect(projectSnapshotSchemaV1.parse(snapshot).project.masterVolume).toBe(0.8)
})

test('defines the exhaustive destructive action policy', () => {
  expect(destructiveControlActionKindsV1).toEqual([
    'track.delete',
    'track.ungroup',
    'clip.delete',
    'effect.remove',
    'instrument.remove',
    'arpeggiator.remove',
    'automation.delete',
    'sidechain.remove',
    'asset.delete',
  ])
  expect(destructiveControlActionKindsV1.every((kind) => controlCapabilitiesV1.actionKinds.includes(kind))).toBe(true)
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
    { kind: 'instrument.remove', target },
    { kind: 'arpeggiator.remove', target },
    { kind: 'asset.delete', asset },
  ]
  for (const action of actions) expect(() => parseControlCommitRequestV1(commit([action]))).not.toThrow()
  expect(() => parseControlCommitRequestV1(commit([{
    kind: 'clip.audio.create', track, asset: { source: 'persisted', id: 'asset-1', key: 'raw-key' },
  }]))).toThrow()
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
