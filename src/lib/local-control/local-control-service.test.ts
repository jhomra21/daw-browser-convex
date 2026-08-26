import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'
import { canonicalRecoveryPayloadV1, hashRecoveryPayloadSyncV1 } from '@daw-browser/control'
import type { JsonValue } from '@daw-browser/shared'
import { createLocalProject, createLocalProjectEntityRow, openLocalProjectDb } from '~/lib/local-project-db'
import { registerPendingLocalProjectWriteFlusher } from '~/lib/local-project-pending-writes'
import { createLocalControlService, LocalControlServiceError } from './local-control-service'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'

const actor = { subject: 'local:00000000-0000-4000-8000-000000000000' }

test('flushes pending MIDI writes before acquiring the local asset lock for a generic commit', async () => {
  const project = await createLocalProject(`MIDI flush ${crypto.randomUUID()}`)
  const nested = createLocalControlService({ actor, excludePendingWriteKinds: ['midi'] })
  let flushed = 0
  const unregister = registerPendingLocalProjectWriteFlusher('midi', project.id, async () => {
    flushed += 1
    await nested.commit({
      version: 'v1',
      projectId: project.id,
      idempotencyKey: 'midi-runtime-write',
      actions: [{ kind: 'project.rename', name: 'MIDI flushed' }],
    })
  })
  try {
    const service = createLocalControlService({ actor })
    await service.commit({
      version: 'v1',
      projectId: project.id,
      idempotencyKey: 'generic-commit',
      actions: [{ kind: 'project.rename', name: 'Committed' }],
    })
    expect(flushed).toBeGreaterThanOrEqual(1)
  } finally {
    unregister()
  }
})

class AvailabilityError extends Error {}

test('provides canonical local snapshot, preview, commit, and history with idempotency replay', async () => {
  const project = await createLocalProject(`Service ${crypto.randomUUID()}`)
  const service = createLocalControlService({ actor })
  expect(service.capabilities().executionTarget).toBe('local-project')
  const initial = await service.snapshot({ projectId: project.id })
  const request = {
    version: 'v1',
    projectId: project.id,
    expectedRevision: initial.project.revision,
    actions: [{ kind: 'project.rename', name: 'Renamed locally' }],
  }
  expect((await service.preview(request)).applied).toBe(true)
  const committed = await service.commit({ ...request, idempotencyKey: 'local-commit-1' })
  expect(committed.idempotencyReplay).toBe(false)
  expect((await service.commit({ ...request, idempotencyKey: 'local-commit-1' })).idempotencyReplay).toBe(true)
  const history = await service.history({ projectId: project.id, limit: 10 })
  const entry = history.entries[0]
  if (!entry || !('actorSubject' in entry)) throw new Error('Expected a history entry.')
  expect(entry.actorSubject).toBe(actor.subject)
  expect(history.entries).toHaveLength(1)
  expect((await service.recoveries({ projectId: project.id, limit: 10 })).entries).toEqual([])
})

test('projects historical finite MIDI values through the local V1 snapshot', async () => {
  const project = await createLocalProject(`Legacy local snapshot ${crypto.randomUUID()}`)
  const repository = createLocalTimelineRepository(project.id)
  const track = await repository.createTrack({ id: 'legacy-instrument', kind: 'instrument' })
  const db = await openLocalProjectDb(project.id)
  const midi = {
    wave: 'custom-legacy',
    gain: 7,
    notes: [{ beat: -2, length: -1, pitch: 200, velocity: 2 }],
  }
  await db.put('entities', createLocalProjectEntityRow('clip', 'legacy-midi-clip', {
    id: 'legacy-midi-clip', trackId: track.id, historyRef: 'legacy-midi-clip',
    name: 'Legacy MIDI', startSec: 0, duration: 1, color: 'clip-midi', midi,
    createdAt: 1, updatedAt: 1,
  }, 1))

  expect((await createLocalControlService({ actor }).snapshot({ projectId: project.id }))
    .clips[0]?.midi).toEqual(midi)
})

test('previews, approves, and commits restore-then-delete asset recovery with a canonical recapture', async () => {
  const project = await createLocalProject(`Restore then delete asset ${crypto.randomUUID()}`)
  const db = await openLocalProjectDb(project.id)
  await db.put('assets', {
    id: 'restore-then-delete',
    name: 'Recovered.wav',
    mimeType: 'audio/wav',
    sizeBytes: 1,
    storagePath: 'recovered.wav',
    sourceKind: 'upload',
    contentHash: 'a'.repeat(64),
    durationSec: 1,
    sampleRate: 48_000,
    channelCount: 2,
    createdAt: 1,
    updatedAt: 1,
  })
  const service = createLocalControlService({ actor })
  const initialRequest = {
    version: 'v1' as const,
    projectId: project.id,
    actions: [{ kind: 'asset.delete' as const, asset: { source: 'persisted' as const, id: 'restore-then-delete' } }],
  }
  const initialApproval = await service.requestApproval(initialRequest)
  const initialCommit = await service.commit({
    ...initialRequest,
    idempotencyKey: 'restore-then-delete-initial',
    approvalToken: initialApproval.approvalToken,
  })
  const recovery = initialCommit.recoveries[0]
  if (!recovery) throw new Error('Expected asset recovery.')

  const actions: JsonValue[] = [
    { kind: 'recovery.restore', recovery: { id: recovery.id } },
    { kind: 'asset.delete', asset: { source: 'persisted', id: 'restore-then-delete' } },
  ]
  const request = {
    version: 'v1' as const,
    projectId: project.id,
    actions,
  }
  expect((await service.preview(request)).applied).toBe(true)
  const approval = await service.requestApproval(request)
  const committed = await service.commit({
    ...request,
    idempotencyKey: 'restore-then-delete-commit',
    approvalToken: approval.approvalToken,
  })
  const recaptured = committed.recoveries[0]
  if (!recaptured) throw new Error('Expected recaptured asset recovery.')
  const row = await db.get('controlRecoveries', recaptured.id)
  if (!row) throw new Error('Expected recaptured recovery row.')
  expect(hashRecoveryPayloadSyncV1(row.payload)).toBe(row.payloadHash)
  expect(await db.get('assets', 'restore-then-delete')).toBeUndefined()
})

test('lists and restores an unexpired stored V1 local clip recovery', async () => {
  const project = await createLocalProject(`Stored V1 recovery ${crypto.randomUUID()}`)
  const service = createLocalControlService({ actor })
  const track = (await service.snapshot({ projectId: project.id })).tracks[0]
  if (!track) throw new Error('Expected initial track.')
  const payload = canonicalRecoveryPayloadV1({
    version: 1,
    kind: 'clip.delete',
    data: {
      clipId: 'legacy-local-clip',
      ownership: { projectId: project.id, localActorSubject: actor.subject },
      clip: {
        projectId: project.id,
        trackId: track.id,
        startSec: 2,
        duration: 3,
        name: 'Stored local V1 clip',
      },
    },
  })
  const recoveryId = 'local-recovery:stored-v1'
  const db = await openLocalProjectDb(project.id)
  await db.put('controlRecoveries', {
    id: recoveryId,
    version: 1,
    projectId: project.id,
    actorSubject: actor.subject,
    sourceActionIndex: 0,
    kind: 'clip.delete',
    payload,
    payloadHash: hashRecoveryPayloadSyncV1(payload),
    createdAt: Date.now() - 1_000,
    expiresAt: Date.now() + 60_000,
  })
  expect((await service.recoveries({ projectId: project.id, limit: 10 })).entries)
    .toEqual([expect.objectContaining({ id: recoveryId, kind: 'clip.delete' })])
  const restored = await service.commit({
    version: 'v1',
    projectId: project.id,
    idempotencyKey: 'stored-v1-recovery-restore',
    actions: [{ kind: 'recovery.restore', recovery: { id: recoveryId } }],
  })
  expect(restored.restored[0]?.entities).toEqual([
    expect.objectContaining({ entity: 'clip', sourceId: 'legacy-local-clip' }),
  ])
  expect((await service.snapshot({ projectId: project.id })).clips).toEqual([
    expect.objectContaining({
      trackId: track.id,
      startSec: 2,
      duration: 3,
      name: 'Stored local V1 clip',
    }),
  ])
})

test('maps malformed inputs and duplicate recovery restores to parsed local errors', async () => {
  const service = createLocalControlService({ actor })
  await expect(service.snapshot({ projectId: '' })).rejects.toBeInstanceOf(LocalControlServiceError)
  const project = await createLocalProject(`Service errors ${crypto.randomUUID()}`)
  await expect(service.preview({
    version: 'v1',
    projectId: project.id,
    actions: [
      { kind: 'recovery.restore', recovery: { id: 'local-recovery:duplicate' } },
      { kind: 'recovery.restore', recovery: { id: 'local-recovery:duplicate' } },
    ],
  })).rejects.toMatchObject({ data: { code: 'validation', actionIndex: 1 } })
})

test('execution guards prevent transaction reads and writes after availability is revoked', async () => {
  const project = await createLocalProject(`Guarded service ${crypto.randomUUID()}`)
  let available = true
  const service = createLocalControlService({
    actor,
    assertAvailable: () => {
      if (!available) throw new AvailabilityError()
    },
  })
  const initial = await service.snapshot({ projectId: project.id })
  const track = initial.tracks[0]
  if (!track) throw new Error('Expected local project track.')
  available = false
  const destructive = {
    version: 'v1' as const,
    projectId: project.id,
    actions: [{ kind: 'track.delete' as const, track: { source: 'persisted' as const, id: track.id } }],
  }
  await expect(service.preview({
    version: 'v1',
    projectId: project.id,
    actions: [{ kind: 'project.rename', name: 'Blocked preview' }],
  })).rejects.toBeInstanceOf(AvailabilityError)
  await expect(service.requestApproval(destructive)).rejects.toBeInstanceOf(AvailabilityError)
  await expect(service.commit({
    version: 'v1',
    projectId: project.id,
    idempotencyKey: 'blocked-commit',
    actions: [{ kind: 'project.rename', name: 'Blocked commit' }],
  })).rejects.toBeInstanceOf(AvailabilityError)
  await expect(service.snapshot({ projectId: project.id })).rejects.toBeInstanceOf(AvailabilityError)
  await expect(service.history({ projectId: project.id, limit: 10 })).rejects.toBeInstanceOf(AvailabilityError)
  await expect(service.recoveries({ projectId: project.id, limit: 10 })).rejects.toBeInstanceOf(AvailabilityError)

  const inspected = createLocalControlService({ actor })
  const after = await inspected.snapshot({ projectId: project.id })
  expect(after.project).toEqual(initial.project)
  expect((await inspected.history({ projectId: project.id, limit: 10 })).entries).toEqual([])
  const db = await openLocalProjectDb(project.id)
  expect(await db.count('controlApprovals')).toBe(0)
  expect(await db.count('controlCommits')).toBe(0)
})

test('replays only the original semantic request for an idempotency key', async () => {
  const project = await createLocalProject(`Idempotency ${crypto.randomUUID()}`)
  const service = createLocalControlService({ actor })
  const first = {
    version: 'v1',
    projectId: project.id,
    idempotencyKey: 'same-key',
    actions: [{ kind: 'project.rename', name: 'First name' }],
  }
  await service.commit(first)
  await expect(service.commit({
    ...first,
    actions: [{ kind: 'project.rename', name: 'Different name' }],
  })).rejects.toMatchObject({ data: { code: 'idempotency-conflict' } })
})

test('maps missing projects and malformed local ledgers to canonical errors', async () => {
  const service = createLocalControlService({ actor })
  const missing = crypto.randomUUID()
  await expect(service.snapshot({ projectId: missing })).rejects.toMatchObject({ data: { code: 'not-found' } })
  await expect(service.preview({ version: 'v1', projectId: missing, actions: [{ kind: 'project.rename', name: 'Missing' }] })).rejects.toMatchObject({ data: { code: 'not-found' } })
  await expect(service.commit({ version: 'v1', projectId: missing, idempotencyKey: 'missing-project', actions: [{ kind: 'project.rename', name: 'Missing' }] })).rejects.toMatchObject({ data: { code: 'not-found' } })
  await expect(service.history({ projectId: missing, limit: 1 })).rejects.toMatchObject({ data: { code: 'not-found' } })

  const project = await createLocalProject(`Corrupt history ${crypto.randomUUID()}`)
  const db = await openLocalProjectDb(project.id)
  await db.put('controlCommits', {
    id: 'local-commit:corrupt',
    version: 1,
    projectId: project.id,
    createdAt: Date.now(),
    actorSubject: actor.subject,
    actorRole: 'owner',
    idempotencyKey: 'corrupt-row',
    requestDigest: '0'.repeat(64),
    result: { projectId: 'foreign-project' },
    priorRevision: 0,
    revision: 999,
    applied: true,
    status: 'completed',
  })
  await expect(service.history({ projectId: project.id, limit: 10 }))
    .rejects.toMatchObject({ data: { code: 'internal' } })
})

test('rejects an asset recovery while its GC lease is active', async () => {
  const project = await createLocalProject(`GC lease ${crypto.randomUUID()}`)
  const db = await openLocalProjectDb(project.id)
  await db.put('assets', {
    id: 'asset-lease',
    name: 'lease.wav',
    mimeType: 'audio/wav',
    sizeBytes: 1,
    storagePath: 'lease.wav',
    contentHash: 'a'.repeat(64),
    sourceKind: 'upload',
    createdAt: 1,
    updatedAt: 1,
  })
  const service = createLocalControlService({ actor })
  const deleteRequest = {
    version: 'v1' as const,
    projectId: project.id,
    actions: [{ kind: 'asset.delete' as const, asset: { source: 'persisted' as const, id: 'asset-lease' } }],
  }
  const approval = await service.requestApproval(deleteRequest)
  const deleted = await service.commit({
    ...deleteRequest,
    idempotencyKey: 'delete-lease',
    approvalToken: approval.approvalToken,
  })
  const recovery = deleted.recoveries[0]
  if (!recovery) throw new Error('Expected asset recovery.')
  const gcId = `local-asset-gc:${recovery.id}`
  const gc = await db.get('controlAssetGc', gcId)
  if (!gc) throw new Error('Expected GC row.')
  await db.put('controlAssetGc', { ...gc, claimToken: 'a'.repeat(64), claimedAt: Date.now() })
  await expect(service.commit({
    version: 'v1',
    projectId: project.id,
    idempotencyKey: 'restore-lease',
    actions: [{ kind: 'recovery.restore', recovery: { id: recovery.id } }],
  })).rejects.toMatchObject({ data: { code: 'validation' } })
})

test('rejects a 129th protected asset recovery without orphaning its GC job', async () => {
  const project = await createLocalProject(`Protected recovery cap ${crypto.randomUUID()}`)
  const db = await openLocalProjectDb(project.id)
  await Promise.all(Array.from({ length: 129 }, (_, index) => db.put('assets', {
    id: `protected-${index}`,
    name: `protected-${index}.wav`,
    mimeType: 'audio/wav',
    sizeBytes: 1,
    storagePath: `protected-${index}.wav`,
    contentHash: 'a'.repeat(64),
    sourceKind: 'upload' as const,
    createdAt: 1,
    updatedAt: 1,
  })))
  const service = createLocalControlService({ actor })
  for (let index = 0; index < 128; index += 1) {
    const request = {
      version: 'v1' as const,
      projectId: project.id,
      actions: [{ kind: 'asset.delete' as const, asset: { source: 'persisted' as const, id: `protected-${index}` } }],
    }
    const approval = await service.requestApproval(request)
    await service.commit({
      ...request,
      idempotencyKey: `protected-${index}`,
      approvalToken: approval.approvalToken,
    })
  }
  const request = {
    version: 'v1' as const,
    projectId: project.id,
    actions: [{ kind: 'asset.delete' as const, asset: { source: 'persisted' as const, id: 'protected-128' } }],
  }
  const approval = await service.requestApproval(request)
  await expect(service.commit({
    ...request,
    idempotencyKey: 'protected-129',
    approvalToken: approval.approvalToken,
  })).rejects.toMatchObject({ data: { code: 'limit-exceeded' } })
  expect(await db.count('controlRecoveries')).toBe(128)
  expect(await db.count('controlAssetGc')).toBe(128)
  expect(await db.get('assets', 'protected-128')).toBeDefined()

  const oldestRecovery = (await db.getAll('controlRecoveries'))[0]
  if (!oldestRecovery) throw new Error('Expected protected recovery.')
  const balancedActions: JsonValue[] = [
    { kind: 'asset.delete', asset: { source: 'persisted', id: 'protected-128' } },
    { kind: 'recovery.restore', recovery: { id: oldestRecovery.id } },
  ]
  const balancedRequest = {
    version: 'v1' as const,
    projectId: project.id,
    actions: balancedActions,
  }
  const balancedApproval = await service.requestApproval(balancedRequest)
  await expect(service.commit({
    ...balancedRequest,
    idempotencyKey: 'protected-balanced-replace',
    approvalToken: balancedApproval.approvalToken,
  })).resolves.toMatchObject({ applied: true })
  expect(await db.count('controlRecoveries')).toBe(129)
  expect(await db.count('controlAssetGc')).toBe(128)
})

test('rejects a new asset deletion at the operational GC ceiling without changing state', async () => {
  const project = await createLocalProject(`GC ceiling ${crypto.randomUUID()}`)
  const db = await openLocalProjectDb(project.id)
  await db.put('assets', {
    id: 'ceiling-asset',
    name: 'ceiling.wav',
    mimeType: 'audio/wav',
    sizeBytes: 1,
    storagePath: 'ceiling.wav',
    contentHash: 'a'.repeat(64),
    sourceKind: 'upload',
    createdAt: 1,
    updatedAt: 1,
  })
  await Promise.all(Array.from({ length: 1_000 }, (_, index) => db.put('controlAssetGc', {
    id: `local-asset-gc:legacy-${index}`,
    version: 1,
    projectId: project.id,
    assetId: `legacy-${index}`,
    eligibleAt: Date.now() + 60_000,
    storagePath: `legacy-${index}.wav`,
    recoveryId: `legacy-${index}`,
  })))
  const service = createLocalControlService({ actor })
  const initial = await service.snapshot({ projectId: project.id })
  const request = {
    version: 'v1' as const,
    projectId: project.id,
    idempotencyKey: 'reject-gc-ceiling',
    actions: [{ kind: 'asset.delete' as const, asset: { source: 'persisted' as const, id: 'ceiling-asset' } }],
  }
  await expect(service.requestApproval({
    version: request.version,
    projectId: request.projectId,
    actions: request.actions,
  })).rejects.toMatchObject({ data: { code: 'limit-exceeded' } })
  expect(await db.count('controlAssetGc')).toBe(1_000)
  expect(await db.get('assets', 'ceiling-asset')).toBeDefined()
  expect((await service.snapshot({ projectId: project.id })).project.revision).toBe(initial.project.revision)
})

test('fails closed for malformed persisted control state without overwriting it', async () => {
  const project = await createLocalProject(`State corruption ${crypto.randomUUID()}`)
  const service = createLocalControlService({ actor })
  await service.commit({
    version: 'v1',
    projectId: project.id,
    idempotencyKey: 'state-revision-one',
    actions: [{ kind: 'project.rename', name: 'Revision one' }],
  })
  const db = await openLocalProjectDb(project.id)
  const state = await db.get('controlState', 'snapshot')
  if (!state) throw new Error('Expected control state.')
  const malformed = {
    key: state.key,
    value: {
      version: 1,
      revision: 1,
      digest: 'bad',
      updatedAt: state.updatedAt,
    },
    updatedAt: state.updatedAt,
  }
  await db.put('controlState', malformed)

  await expect(service.snapshot({ projectId: project.id })).rejects.toMatchObject({ data: { code: 'internal' } })
  await expect(service.preview({
    version: 'v1', projectId: project.id, actions: [{ kind: 'project.rename', name: 'Preview' }],
  })).rejects.toMatchObject({ data: { code: 'internal' } })
  await expect(service.commit({
    version: 'v1', projectId: project.id, idempotencyKey: 'state-corrupt', actions: [{ kind: 'project.rename', name: 'Commit' }],
  })).rejects.toMatchObject({ data: { code: 'internal' } })
  expect(await db.get('controlState', 'snapshot')).toEqual(malformed)
})

test('validates and persists every injected actor claim', async () => {
  for (const actorInput of [
    { subject: '' },
    { subject: 'x'.repeat(257) },
    { subject: 'valid', issuer: '' },
    { subject: 'valid', issuer: 'x'.repeat(257) },
    { subject: 'valid', tokenIdentifier: '' },
    { subject: 'valid', tokenIdentifier: 'x'.repeat(257) },
  ]) {
    expect(() => createLocalControlService({ actor: actorInput })).toThrow(LocalControlServiceError)
  }

  const project = await createLocalProject(`Actor claims ${crypto.randomUUID()}`)
  const maxActor = {
    subject: 's'.repeat(256),
    issuer: 'i'.repeat(256),
    tokenIdentifier: 't'.repeat(256),
  }
  const service = createLocalControlService({ actor: maxActor })
  await service.commit({
    version: 'v1',
    projectId: project.id,
    idempotencyKey: 'max-actor-claims',
    actions: [{ kind: 'project.rename', name: 'Actor claims' }],
  })
  const entry = (await service.history({ projectId: project.id, limit: 1 })).entries[0]
  expect(entry).toMatchObject({
    actorSubject: maxActor.subject,
    actorIssuer: maxActor.issuer,
    actorTokenIdentifier: maxActor.tokenIdentifier,
  })
  expect((await service.commit({
    version: 'v1',
    projectId: project.id,
    idempotencyKey: 'max-actor-second',
    actions: [{ kind: 'project.rename', name: 'Actor claims again' }],
  })).idempotencyReplay).toBe(false)
})
