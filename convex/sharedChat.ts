import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireProjectAccess } from "./projectAccess";

// List the latest N messages for a room, ordered by createdAt ascending.
export const listLatest = query({
  args: { projectId: v.string(), userId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { projectId, userId, limit }) => {
    await requireProjectAccess(ctx, projectId, userId);

    const rows = await ctx.db
      .query("projectMessages")
      .withIndex("by_room_createdAt", (q) => q.eq("projectId", projectId))
      .collect();

    const n = Math.max(1, Math.min(500, typeof limit === 'number' ? limit : 200));
    const start = rows.length > n ? rows.length - n : 0;
    const recent = rows.slice(start);
    recent.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    return recent;
  },
});

export const send = mutation({
  args: {
    projectId: v.string(),
    senderUserId: v.string(),
    content: v.string(),
    senderName: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { projectId, senderUserId, content, senderName }) => {
    const text = content.trim();
    if (!text) return null;

    await requireProjectAccess(ctx, projectId, senderUserId);

    await ctx.db.insert('projectMessages', {
      projectId,
      senderUserId,
      content: text,
      createdAt: Date.now(),
      senderName: senderName && senderName.trim() ? senderName.trim().slice(0, 120) : undefined,
      kind: 'text',
    } as any);

    return null;
  },
});
