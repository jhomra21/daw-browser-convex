import { mutation, query } from './_generated/server'
import { v } from 'convex/values'

import { findSampleRow } from './sampleRows'
import { requireAuthenticatedUserId, requireProjectAccess, requireProjectRole } from './projectAccess'
import { enqueueR2DeleteRows } from './r2Deletes'

const readSampleObjectPathFromUrl = (url: string) => {
  const marker = '?key='
  const index = url.indexOf(marker)
  if (index < 0) return null
  try {
    return decodeURIComponent(url.slice(index + marker.length))
  } catch {
    return null
  }
}

export const listByRoom = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    await requireProjectAccess(ctx, projectId, userId)
    return await ctx.db
      .query('samples')
      .withIndex('by_room', q => q.eq('projectId', projectId))
      .collect()
  },
})

export const removeFromRoom = mutation({
  args: {
    projectId: v.string(),
    assetKey: v.optional(v.string()),
  },
  handler: async (ctx, { projectId, assetKey }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    if (!assetKey) return
    const row = await findSampleRow(ctx, { projectId, assetKey })
    if (!row) return
    await requireProjectRole(ctx, projectId, userId, ['owner', 'editor'])

    const clips = await ctx.db
      .query('clips')
      .withIndex('by_room', q => q.eq('projectId', projectId))
      .collect()
    const inUse = clips.some((clip) => clip.sourceAssetKey === assetKey)
    if (inUse) return
    const sampleObjectPath = readSampleObjectPathFromUrl(row.url)
    if (sampleObjectPath?.startsWith(`projects/${projectId}/assets/${assetKey}/`)) {
      await enqueueR2DeleteRows(ctx, { projectId, keys: [sampleObjectPath], kind: 'sample' })
    }
    await ctx.db.delete(row._id)
  },
})
