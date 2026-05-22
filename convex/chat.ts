import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireProjectAccess } from "./projectAccess";

// Get chat history for a specific user within a project (room)
export const getHistory = query({
  args: { projectId: v.string(), ownerUserId: v.string(), requestingUserId: v.string() },
  returns: v.array(
    v.object({
      role: v.string(), // 'user' | 'assistant'
      content: v.string(),
    })
  ),
  handler: async (ctx, { projectId, ownerUserId, requestingUserId }) => {
    if (requestingUserId !== ownerUserId) return [];
    await requireProjectAccess(ctx, projectId, requestingUserId);
    const rows = await ctx.db
      .query("chatHistories")
      .withIndex("by_room_owner", (q) => q.eq("projectId", projectId).eq("ownerUserId", ownerUserId))
      .collect();
    const row = rows[0];
    return row?.messages ?? [];
  },
});

// Replace chat history (upsert) for a specific user within a project (room)
export const setHistory = mutation({
  args: {
    projectId: v.string(),
    ownerUserId: v.string(),
    requestingUserId: v.string(),
    messages: v.array(
      v.object({
        role: v.string(), // 'user' | 'assistant'
        content: v.string(),
      })
    ),
  },
  returns: v.null(),
  handler: async (ctx, { projectId, ownerUserId, requestingUserId, messages }) => {
    if (requestingUserId !== ownerUserId) return null;
    await requireProjectAccess(ctx, projectId, requestingUserId);
    const rows = await ctx.db
      .query("chatHistories")
      .withIndex("by_room_owner", (q) => q.eq("projectId", projectId).eq("ownerUserId", ownerUserId))
      .collect();
    const row = rows[0];
    if (row) {
      await ctx.db.patch(row._id, { messages, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("chatHistories", {
        projectId,
        ownerUserId,
        messages,
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});
