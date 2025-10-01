import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

// Get chat history for a specific user within a project (room)
export const getHistory = query({
  args: { roomId: v.string(), ownerUserId: v.string() },
  returns: v.array(
    v.object({
      role: v.string(), // 'user' | 'assistant'
      content: v.string(),
    })
  ),
  handler: async (ctx, { roomId, ownerUserId }) => {
    const rows = await ctx.db
      .query("chatHistories")
      .withIndex("by_room_owner", (q) => q.eq("roomId", roomId).eq("ownerUserId", ownerUserId))
      .collect();
    const row = rows[0];
    return row?.messages ?? [];
  },
});

// Replace chat history (upsert) for a specific user within a project (room)
export const setHistory = mutation({
  args: {
    roomId: v.string(),
    ownerUserId: v.string(),
    messages: v.array(
      v.object({
        role: v.string(), // 'user' | 'assistant'
        content: v.string(),
      })
    ),
  },
  returns: v.null(),
  handler: async (ctx, { roomId, ownerUserId, messages }) => {
    const rows = await ctx.db
      .query("chatHistories")
      .withIndex("by_room_owner", (q) => q.eq("roomId", roomId).eq("ownerUserId", ownerUserId))
      .collect();
    const row = rows[0];
    if (row) {
      await ctx.db.patch(row._id, { messages, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("chatHistories", {
        roomId,
        ownerUserId,
        messages,
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});
