import { mutation, query } from "./_generated/server"
import { v } from "convex/values"
import { requireProjectRole } from "./projectAccess"

export const listByRoom = query({
  args: { projectId: v.string(), userId: v.string() },
  handler: async (ctx, { projectId, userId }) => {
    await requireProjectRole(ctx, projectId, userId, ["owner", "editor", "viewer"])
    const rows = await ctx.db
      .query("exports")
      .withIndex("by_room_createdAt", q => q.eq("projectId", projectId))
      .collect()
    // Sort desc by createdAt client-side to be safe
    return rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  },
})

export const create = mutation({
  args: {
    projectId: v.string(),
    name: v.string(),
    url: v.string(),
    r2Key: v.string(),
    format: v.string(),
    duration: v.optional(v.number()),
    sampleRate: v.optional(v.number()),
    sizeBytes: v.optional(v.number()),
    userId: v.string(),
  },
  handler: async (ctx, { projectId, name, url, r2Key, format, duration, sampleRate, sizeBytes, userId }) => {
    await requireProjectRole(ctx, projectId, userId, ["owner", "editor"])
    return await ctx.db.insert("exports", {
      projectId,
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
    await requireProjectRole(ctx, row.projectId, userId, ["owner", "editor"])
    if (row.createdBy !== userId) return
    await ctx.db.delete(exportId)
  },
})
