import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireAuthenticatedUserId, requireProjectAccess } from "./projectAccess";

const MAX_AGENT_CHAT_REQUEST_MESSAGES = 32;
const MAX_AGENT_CHAT_HISTORY_MESSAGES = MAX_AGENT_CHAT_REQUEST_MESSAGES - 1;
const MAX_AGENT_CHAT_CONTENT_LENGTH = 8_000;
const CHAT_HISTORY_ROLES = new Set(["user", "assistant"]);

function trimChatHistory(
  messages: Array<{ role: string; content: string }>
): Array<{ role: string; content: string }> {
  return messages
    .filter((message) => CHAT_HISTORY_ROLES.has(message.role))
    .slice(-MAX_AGENT_CHAT_HISTORY_MESSAGES)
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, MAX_AGENT_CHAT_CONTENT_LENGTH),
    }));
}

// Get chat history for a specific user within a project (room)
export const getHistory = query({
  args: { projectId: v.string() },
  returns: v.array(
    v.object({
      role: v.string(), // 'user' | 'assistant'
      content: v.string(),
    })
  ),
  handler: async (ctx, { projectId }) => {
    const ownerUserId = await requireAuthenticatedUserId(ctx);
    await requireProjectAccess(ctx, projectId, ownerUserId);
    const rows = await ctx.db
      .query("chatHistories")
      .withIndex("by_room_owner", (q) => q.eq("projectId", projectId).eq("ownerUserId", ownerUserId))
      .collect();
    const row = rows[0];
    return trimChatHistory(row?.messages ?? []);
  },
});

// Replace chat history (upsert) for a specific user within a project (room)
export const setHistory = mutation({
  args: {
    projectId: v.string(),
    messages: v.array(
      v.object({
        role: v.string(), // 'user' | 'assistant'
        content: v.string(),
      })
    ),
  },
  returns: v.null(),
  handler: async (ctx, { projectId, messages }) => {
    const ownerUserId = await requireAuthenticatedUserId(ctx);
    await requireProjectAccess(ctx, projectId, ownerUserId);
    const nextMessages = trimChatHistory(messages);
    const rows = await ctx.db
      .query("chatHistories")
      .withIndex("by_room_owner", (q) => q.eq("projectId", projectId).eq("ownerUserId", ownerUserId))
      .collect();
    const row = rows[0];
    if (row) {
      await ctx.db.patch(row._id, { messages: nextMessages, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("chatHistories", {
        projectId,
        ownerUserId,
        messages: nextMessages,
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});
