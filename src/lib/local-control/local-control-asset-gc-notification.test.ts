import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'
import { createLocalProject, openLocalProjectDb } from '~/lib/local-project-db'
import { subscribeToLocalProjectChanges } from '~/lib/local-project-changes'
import { runLocalControlAssetGc } from './local-control-asset-gc'
import { createLocalControlService } from './local-control-service'

const actor = { subject: 'local:00000000-0000-4000-8000-000000000000' }
let failingStoragePath: string | undefined

const localAssets = () => ({
  removeLocalAssetFileUnlocked: async (_projectId: string, storagePath: string) => {
    if (storagePath === failingStoragePath) throw new Error('Injected asset removal failure.')
    return { status: 'already-missing' as const }
  },
})

const createExpiredAssetRecovery = async (
  assetId: string,
  existing?: {
    project: Awaited<ReturnType<typeof createLocalProject>>
    db: Awaited<ReturnType<typeof openLocalProjectDb>>
  },
) => {
  const project = existing?.project ?? await createLocalProject(`GC notification ${crypto.randomUUID()}`)
  const db = existing?.db ?? await openLocalProjectDb(project.id)
  const service = createLocalControlService({ actor, removeAssetFile: localAssets().removeLocalAssetFileUnlocked })
  await db.put('assets', {
    id: assetId,
    name: `${assetId}.wav`,
    mimeType: 'audio/wav',
    sizeBytes: 1,
    storagePath: `${assetId}.wav`,
    contentHash: 'a'.repeat(64),
    sourceKind: 'upload',
    createdAt: 1,
    updatedAt: 1,
  })
  const request = {
    version: 'v1' as const,
    projectId: project.id,
    actions: [{ kind: 'asset.delete' as const, asset: { source: 'persisted' as const, id: assetId } }],
  }
  const approval = await service.requestApproval(request)
  const result = await service.commit({
    ...request,
    idempotencyKey: `delete-${assetId}-${crypto.randomUUID()}`,
    approvalToken: approval.approvalToken,
  })
  const recovery = result.recoveries[0]
  if (!recovery) throw new Error('Expected asset recovery.')
  const jobId = `local-asset-gc:${recovery.id}`
  const job = await db.get('controlAssetGc', jobId)
  const recoveryRow = await db.get('controlRecoveries', recovery.id)
  if (!job || !recoveryRow) throw new Error('Expected GC job and recovery.')
  return { project, db, job, recoveryRow, jobId, recoveryId: recovery.id, service, storagePath: job.storagePath }
}

const expireAssetRecovery = async (
  recovery: Awaited<ReturnType<typeof createExpiredAssetRecovery>>,
  eligibleAt: number,
) => {
  await recovery.db.put('controlAssetGc', { ...recovery.job, eligibleAt })
  await recovery.db.put('controlRecoveries', { ...recovery.recoveryRow, expiresAt: eligibleAt })
}

test('isolates a failed GC job and notifies after another job finalizes', async () => {
  const first = await createExpiredAssetRecovery('first-asset')
  const second = await createExpiredAssetRecovery('second-asset', first)
  await expireAssetRecovery(first, Date.now() - 2)
  await expireAssetRecovery(second, Date.now() - 1)
  failingStoragePath = second.storagePath
  let changes = 0
  const unsubscribe = subscribeToLocalProjectChanges(first.project.id, () => { changes += 1 })
  try {
    expect(await runLocalControlAssetGc(first.project.id, {
      removeAssetFile: localAssets().removeLocalAssetFileUnlocked,
    })).toEqual({ finalized: true })
    expect(changes).toBe(1)
    expect(await first.db.get('controlAssetGc', first.jobId)).toBeUndefined()
    expect(await first.db.get('controlRecoveries', first.recoveryId)).toBeUndefined()
    const failed = await first.db.get('controlAssetGc', second.jobId)
    expect(failed?.claimToken).toMatch(/^[0-9a-f]{64}$/u)
    expect(failed?.claimedAt).toBeGreaterThan(0)
    expect(await first.db.get('controlRecoveries', second.recoveryId)).toBeDefined()
  } finally {
    failingStoragePath = undefined
    unsubscribe()
  }
})

test('a no-op commit publishes partial GC finalization once without double-publishing applied commits', async () => {
  const first = await createExpiredAssetRecovery('first-commit-asset')
  const second = await createExpiredAssetRecovery('second-commit-asset', first)
  await expireAssetRecovery(first, Date.now() - 2)
  await expireAssetRecovery(second, Date.now() - 1)
  failingStoragePath = second.storagePath
  let changes = 0
  const unsubscribe = subscribeToLocalProjectChanges(first.project.id, () => { changes += 1 })
  try {
    expect(await first.service.commit({
      version: 'v1',
      projectId: first.project.id,
      idempotencyKey: 'no-op-gc-finalization',
      actions: [{ kind: 'project.rename', name: first.project.name }],
    })).toMatchObject({ applied: false, idempotencyReplay: false })
    expect(changes).toBe(1)
    expect(await first.db.get('controlAssetGc', first.jobId)).toBeUndefined()
    const failed = await first.db.get('controlAssetGc', second.jobId)
    expect(failed?.claimToken).toMatch(/^[0-9a-f]{64}$/u)

    failingStoragePath = undefined
    if (!failed) throw new Error('Expected failed GC job.')
    await first.db.put('controlAssetGc', { ...failed, claimedAt: 0 })
    expect(await first.service.commit({
      version: 'v1',
      projectId: first.project.id,
      idempotencyKey: 'applied-gc-finalization',
      actions: [{ kind: 'project.rename', name: 'Applied alongside GC' }],
    })).toMatchObject({ applied: true, idempotencyReplay: false })
    expect(changes).toBe(2)
    expect(await first.db.get('controlAssetGc', second.jobId)).toBeUndefined()
    expect(await first.db.get('controlRecoveries', second.recoveryId)).toBeUndefined()
  } finally {
    failingStoragePath = undefined
    unsubscribe()
  }
})
