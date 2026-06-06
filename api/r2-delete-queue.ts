import { api as convexApi } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'
import type { R2DeleteKind } from '@daw-browser/shared'
import type { ApiContext } from './app-types'
import type { Session } from './auth'
import { createMaintenanceWorkerConvexClient, createWorkerConvexClient, type ApiConvexClient } from './convex-auth'

type R2DeleteQueueRow = {
  _id: Id<'r2DeleteQueue'>
  projectId: string
  r2Key: string
  kind: R2DeleteKind
}

type R2DeleteDrainSummary = {
  processed: number
  deleted: number
}

type ProjectR2DeleteDrainResult = R2DeleteDrainSummary & {
  deletedKeys: string[]
}

const toDrainSummary = (result: ProjectR2DeleteDrainResult): R2DeleteDrainSummary => ({
  processed: result.processed,
  deleted: result.deleted,
})

const deleteR2Prefix = async (bucket: R2Bucket, prefix: string) => {
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 })
    const keys = page.objects.map((entry) => entry.key).filter(Boolean)
    if (keys.length > 0) await bucket.delete(keys)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
}

export const deleteR2Keys = async (bucket: R2Bucket, keys: string[]) => {
  if (keys.length === 0) return
  await bucket.delete(keys)
}

const markFailed = async (convex: ApiConvexClient, row: R2DeleteQueueRow, error: unknown) => {
  await convex.mutation(convexApi.r2Deletes.markFailed, {
    projectId: row.projectId,
    id: row._id,
    error: error instanceof Error ? error.message : 'R2 delete failed',
  })
}

const drainR2DeleteRows = async (input: {
  convex: ApiConvexClient
  bucket: R2Bucket
  rows: R2DeleteQueueRow[]
}) => {
  const deletedIdsByProject = new Map<string, Id<'r2DeleteQueue'>[]>()
  const deletedKeys: string[] = []
  const recordDeleted = (row: R2DeleteQueueRow) => {
    let ids = deletedIdsByProject.get(row.projectId)
    if (!ids) {
      ids = []
      deletedIdsByProject.set(row.projectId, ids)
    }
    ids.push(row._id)
    deletedKeys.push(row.r2Key)
  }
  const objectRows: R2DeleteQueueRow[] = []
  const prefixRows: R2DeleteQueueRow[] = []
  for (const row of input.rows) {
    if (row.kind === 'project-prefix') prefixRows.push(row)
    else objectRows.push(row)
  }
  const deletedPrefixes: string[] = []
  for (let index = 0; index < prefixRows.length; index += 2) {
    await Promise.all(prefixRows.slice(index, index + 2).map(async (row) => {
      try {
        await deleteR2Prefix(input.bucket, row.r2Key)
        deletedPrefixes.push(row.r2Key)
        recordDeleted(row)
      } catch (error) {
        await markFailed(input.convex, row, error)
      }
    }))
  }
  const remainingObjectRows: R2DeleteQueueRow[] = []
  for (const row of objectRows) {
    if (deletedPrefixes.some((prefix) => row.r2Key.startsWith(prefix))) recordDeleted(row)
    else remainingObjectRows.push(row)
  }
  if (remainingObjectRows.length > 0) {
    try {
      await deleteR2Keys(input.bucket, remainingObjectRows.map((row) => row.r2Key))
      for (const row of remainingObjectRows) recordDeleted(row)
    } catch (error) {
      await Promise.all(remainingObjectRows.map((row) => markFailed(input.convex, row, error)))
    }
  }
  await Promise.all(Array.from(deletedIdsByProject).map(([projectId, ids]) => (
    input.convex.mutation(convexApi.r2Deletes.markDeleted, { projectId, ids })
  )))
  return { processed: input.rows.length, deleted: deletedKeys.length, deletedKeys }
}

export const drainR2DeleteQueue = async (input: {
  c: ApiContext
  user: Session['user']
  bucket: R2Bucket
  projectId: string
  limit?: number
}): Promise<ProjectR2DeleteDrainResult> => {
  const convex = await createWorkerConvexClient(input.c, input.user)
  const rows = await convex.query(convexApi.r2Deletes.listDue, {
    projectId: input.projectId,
    now: Date.now(),
    limit: input.limit ?? 25,
  })
  return await drainR2DeleteRows({ convex, bucket: input.bucket, rows })
}

export const drainDueR2DeleteQueue = async (input: {
  c: ApiContext
  bucket: R2Bucket
  limit?: number
}): Promise<R2DeleteDrainSummary> => {
  const convex = await createMaintenanceWorkerConvexClient(input.c)
  const rows = await convex.query(convexApi.r2Deletes.listDueAny, {
    now: Date.now(),
    limit: input.limit ?? 25,
  })
  const result = await drainR2DeleteRows({ convex, bucket: input.bucket, rows })
  return toDrainSummary(result)
}

export const drainProjectPrefixDelete = async (input: {
  c: ApiContext
  user: Session['user']
  bucket: R2Bucket
  projectId: string
}): Promise<R2DeleteDrainSummary> => {
  const convex = await createWorkerConvexClient(input.c, input.user)
  const row = await convex.query(convexApi.r2Deletes.findDueProjectPrefix, {
    projectId: input.projectId,
    now: Date.now(),
  })
  if (!row) return { processed: 0, deleted: 0 }
  const result = await drainR2DeleteRows({ convex, bucket: input.bucket, rows: [row] })
  return toDrainSummary(result)
}
