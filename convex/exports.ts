import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

export const listByRoom = query({
  args: { roomId: v.string() },
  handler: async (ctx, { roomId }) => {
    const rows = await ctx.db
      .query("exports")
      .withIndex("by_room_createdAt", q => q.eq("roomId", roomId))
      .collect()
    // Sort desc by createdAt client-side to be safe
    return rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  },
})

export const create = mutation({
  args: {
    roomId: v.string(),
    name: v.string(),
    url: v.string(),
    r2Key: v.string(),
    format: v.string(),
    duration: v.optional(v.number()),
    sampleRate: v.optional(v.number()),
    sizeBytes: v.optional(v.number()),
    userId: v.string(),
  },
  handler: async (ctx, { roomId, name, url, r2Key, format, duration, sampleRate, sizeBytes, userId }) => {
    return await ctx.db.insert("exports", {
      roomId,
      name,
      url,
      r2Key,
      format,
      duration,
      sampleRate,
      sizeBytes,
      createdAt: Date.now(),
      createdBy: userId,
    })
  },
})

export const remove = mutation({
  args: { exportId: v.id("exports"), userId: v.string() },
  handler: async (ctx, { exportId, userId }) => {
    const row = await ctx.db.get(exportId)
    if (!row) return
    if (row.createdBy !== userId) return
    await ctx.db.delete(exportId)
  },
})
