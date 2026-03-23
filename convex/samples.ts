import { mutation, query } from './_generated/server'
import { v } from 'convex/values'

import { findSampleRow } from './sampleRows'

export const listByRoom = query({
  args: { roomId: v.string() },
  handler: async (ctx, { roomId }) => {
    return await ctx.db
      .query('samples')
      .withIndex('by_room', q => q.eq('roomId', roomId))
      .collect()
  },
})

export const removeFromRoom = mutation({
  args: {
    roomId: v.string(),
    assetKey: v.optional(v.string()),
    userId: v.string(),
  },
  handler: async (ctx, { roomId, assetKey, userId }) => {
    if (!assetKey) return
    const row = await findSampleRow(ctx, { roomId, assetKey })
    if (!row) return
    if (row.ownerUserId !== userId) return

    const clips = await ctx.db
      .query('clips')
      .withIndex('by_room', q => q.eq('roomId', roomId))
      .collect()
    const inUse = clips.some((clip) => clip.sourceAssetKey === assetKey)
    if (inUse) return
    await ctx.db.delete(row._id)
  },
})
