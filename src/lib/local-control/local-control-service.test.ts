import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'
import { createLocalProject, openLocalProjectDb } from '~/lib/local-project-db'
import { createLocalControlService, LocalControlServiceError } from './local-control-service'

const actor = { subject: 'local:00000000-0000-4000-8000-000000000000' }

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
  const balancedRequest = {
    version: 'v1' as const,
    projectId: project.id,
    actions: [
      { kind: 'asset.delete' as const, asset: { source: 'persisted' as const, id: 'protected-128' } },
      { kind: 'recovery.restore' as const, recovery: { id: oldestRecovery.id } },
    ],
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
  const approval = await service.requestApproval({
    version: request.version,
    projectId: request.projectId,
    actions: request.actions,
  })
  await expect(service.commit({ ...request, approvalToken: approval.approvalToken }))
    .rejects.toMatchObject({ data: { code: 'limit-exceeded' } })
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
