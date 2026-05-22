import { mutation, query } from './_generated/server'
import { v } from 'convex/values'

import { findSampleRow } from './sampleRows'
import { requireProjectAccess } from './projectAccess'

export const listByRoom = query({
  args: { projectId: v.string(), userId: v.string() },
  handler: async (ctx, { projectId, userId }) => {
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
    userId: v.string(),
  },
  handler: async (ctx, { projectId, assetKey, userId }) => {
    if (!assetKey) return
    const row = await findSampleRow(ctx, { projectId, assetKey })
    if (!row) return
    if (row.ownerUserId !== userId) return

    const clips = await ctx.db
      .query('clips')
      .withIndex('by_room', q => q.eq('projectId', projectId))
      .collect()
    const inUse = clips.some((clip) => clip.sourceAssetKey === assetKey)
    if (inUse) return
    await ctx.db.delete(row._id)
  },
})
