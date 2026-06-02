import { api as convexApi } from '../convex/_generated/api'
import type { ApiContext } from './app-types'
import type { Session } from './auth'
import { createWorkerConvexClient } from './convex-auth'

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

export const drainR2DeleteQueue = async (input: {
  c: ApiContext
  user: Session['user']
  bucket: R2Bucket
  projectId: string
  limit?: number
}) => {
  const convex = await createWorkerConvexClient(input.c, input.user)
  const rows = await convex.query(convexApi.r2Deletes.listDue, {
    projectId: input.projectId,
    now: Date.now(),
    limit: input.limit ?? 25,
  })
  const deletedIds = []
  const deletedKeys: string[] = []
  const objectRows = rows.filter((row) => row.kind !== 'project-prefix')
  if (objectRows.length > 0) {
    try {
      await deleteR2Keys(input.bucket, objectRows.map((row) => row.r2Key))
      for (const row of objectRows) {
        deletedIds.push(row._id)
        deletedKeys.push(row.r2Key)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'R2 delete failed'
      await Promise.all(objectRows.map((row) => (
        convex.mutation(convexApi.r2Deletes.markFailed, {
          projectId: input.projectId,
          id: row._id,
          error: message,
        })
      )))
    }
  }
  for (const row of rows.filter((entry) => entry.kind === 'project-prefix')) {
    try {
      await deleteR2Prefix(input.bucket, row.r2Key)
      deletedIds.push(row._id)
      deletedKeys.push(row.r2Key)
    } catch (error) {
      await convex.mutation(convexApi.r2Deletes.markFailed, {
        projectId: input.projectId,
        id: row._id,
        error: error instanceof Error ? error.message : 'R2 delete failed',
      })
    }
  }
  if (deletedIds.length > 0) {
    await convex.mutation(convexApi.r2Deletes.markDeleted, {
      projectId: input.projectId,
      ids: deletedIds,
    })
  }
  return { processed: rows.length, deleted: deletedIds.length, deletedKeys }
}

export const drainProjectPrefixDelete = async (input: {
  c: ApiContext
  user: Session['user']
  bucket: R2Bucket
  projectId: string
}) => {
  const convex = await createWorkerConvexClient(input.c, input.user)
  const row = await convex.query(convexApi.r2Deletes.findDueProjectPrefix, {
    projectId: input.projectId,
    now: Date.now(),
  })
  if (!row) return { processed: 0, deleted: 0 }
  try {
    await deleteR2Prefix(input.bucket, row.r2Key)
    await convex.mutation(convexApi.r2Deletes.markDeleted, {
      projectId: input.projectId,
      ids: [row._id],
    })
    return { processed: 1, deleted: 1 }
  } catch (error) {
    await convex.mutation(convexApi.r2Deletes.markFailed, {
      projectId: input.projectId,
      id: row._id,
      error: error instanceof Error ? error.message : 'R2 delete failed',
    })
    return { processed: 1, deleted: 0 }
  }
}