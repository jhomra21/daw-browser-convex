import { mutation, query } from "./_generated/server"
import { v } from "convex/values"
import { requireAuthenticatedUserId, requireProjectRole } from "./projectAccess"
import { isValidR2DeleteKey } from "../src/lib/r2-delete-keys"
import { enqueueR2DeleteRows } from "./r2Deletes"

export const listByRoom = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const userId = await requireAuthenticatedUserId(ctx)
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
  },
  handler: async (ctx, { projectId, name, url, r2Key, format, duration, sampleRate, sizeBytes }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    await requireProjectRole(ctx, projectId, userId, ["owner", "editor"])
    if (!isValidR2DeleteKey(projectId, "export", r2Key)) {
      throw new Error("Invalid export key.")
    }
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
  args: { exportId: v.string() },
  handler: async (ctx, { exportId }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const normalizedExportId = ctx.db.normalizeId("exports", exportId)
    if (!normalizedExportId) return
    const row = await ctx.db.get(normalizedExportId)
    if (!row) return
    await requireProjectRole(ctx, row.projectId, userId, ["owner", "editor"])
    await enqueueR2DeleteRows(ctx, { projectId: row.projectId, keys: [row.r2Key], kind: "export" })
    await ctx.db.delete(normalizedExportId)
    return { projectId: row.projectId }
  },
})
