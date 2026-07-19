import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'
import { createLocalProject, openLocalProjectDb } from '~/lib/local-project-db'
import { runLocalControlAssetGc } from './local-control-asset-gc'
import { createLocalControlService } from './local-control-service'

const actor = { subject: 'local:00000000-0000-4000-8000-000000000000' }

const createExpiredAssetRecovery = async () => {
  const project = await createLocalProject(`GC integrity ${crypto.randomUUID()}`)
  const db = await openLocalProjectDb(project.id)
  await db.put('assets', {
    id: 'deleted-asset',
    name: 'Deleted.wav',
    mimeType: 'audio/wav',
    sizeBytes: 1,
    storagePath: 'deleted.wav',
    contentHash: 'a'.repeat(64),
    sourceKind: 'upload',
    createdAt: 1,
    updatedAt: 1,
  })
  const service = createLocalControlService({ actor })
  const request = {
    version: 'v1' as const,
    projectId: project.id,
    actions: [{ kind: 'asset.delete' as const, asset: { source: 'persisted' as const, id: 'deleted-asset' } }],
  }
  const approval = await service.requestApproval(request)
  const result = await service.commit({
    ...request,
    idempotencyKey: `delete-${crypto.randomUUID()}`,
    approvalToken: approval.approvalToken,
  })
  const recovery = result.recoveries[0]
  if (!recovery) throw new Error('Expected asset recovery.')
  const jobId = `local-asset-gc:${recovery.id}`
  const job = await db.get('controlAssetGc', jobId)
  const recoveryRow = await db.get('controlRecoveries', recovery.id)
  if (!job || !recoveryRow) throw new Error('Expected GC job and recovery.')
  const expiredAt = Date.now() - 1
  await db.put('controlAssetGc', { ...job, eligibleAt: expiredAt })
  await db.put('controlRecoveries', { ...recoveryRow, expiresAt: expiredAt })
  return { project, db, jobId, recoveryId: recovery.id, service }
}

test('never claims malformed or live-referenced asset GC jobs', async () => {
  const { project, db, jobId } = await createExpiredAssetRecovery()
  const job = await db.get('controlAssetGc', jobId)
  if (!job) throw new Error('Expected GC job.')
  await db.put('assets', {
    id: 'replacement-asset',
    name: 'Replacement.wav',
    mimeType: 'audio/wav',
    sizeBytes: 1,
    storagePath: job.storagePath,
    contentHash: 'b'.repeat(64),
    sourceKind: 'upload',
    createdAt: 1,
    updatedAt: 1,
  })
  await db.put('controlAssetGc', {
    id: 'local-asset-gc:corrupt',
    version: 1,
    projectId: project.id,
    assetId: job.assetId,
    eligibleAt: 0,
    storagePath: job.storagePath,
    recoveryId: job.recoveryId,
    claimToken: 'not-a-token',
  })

  expect(await runLocalControlAssetGc(project.id, { notify: false })).toEqual({ finalized: false })
  expect((await db.get('controlAssetGc', jobId))?.claimToken).toBeUndefined()
  expect((await db.get('controlAssetGc', 'local-asset-gc:corrupt'))?.claimToken).toBe('not-a-token')
})

test('does not reclaim an active asset GC lease or accept wrong recovery linkage', async () => {
  const { project, db, jobId, recoveryId } = await createExpiredAssetRecovery()
  const job = await db.get('controlAssetGc', jobId)
  const recovery = await db.get('controlRecoveries', recoveryId)
  if (!job || !recovery) throw new Error('Expected GC job and recovery.')
  await db.put('controlAssetGc', {
    ...job,
    claimToken: 'a'.repeat(64),
    claimedAt: Date.now(),
  })
  await db.put('controlRecoveries', { ...recovery, projectId: 'wrong-project' })

  expect(await runLocalControlAssetGc(project.id, { notify: false })).toEqual({ finalized: false })
  expect((await db.get('controlAssetGc', jobId))?.claimToken).toBe('a'.repeat(64))
})

test('retains an expired recovery until its linked GC job finalizes', async () => {
  const { project, db, jobId, recoveryId, service } = await createExpiredAssetRecovery()
  const job = await db.get('controlAssetGc', jobId)
  if (!job) throw new Error('Expected GC job.')
  await db.put('controlAssetGc', { ...job, eligibleAt: Date.now() + 60_000 })
  await service.commit({
    version: 'v1',
    projectId: project.id,
    idempotencyKey: 'prune-expired-gc-recovery',
    actions: [{ kind: 'project.rename', name: 'Preserve recovery evidence' }],
  })
  expect(await db.get('controlRecoveries', recoveryId)).toBeDefined()
})
