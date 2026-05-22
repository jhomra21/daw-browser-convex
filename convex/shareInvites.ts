import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireProjectRole } from "./projectAccess";

export const create = mutation({
  args: {
    projectId: v.string(),
    userId: v.string(),
    role: v.union(v.literal("editor"), v.literal("viewer")),
  },
  handler: async (ctx, { projectId, userId, role }) => {
    await requireProjectRole(ctx, projectId, userId, ["owner"]);
    const token = crypto.randomUUID();
    await ctx.db.insert("shareInvites", {
      projectId,
      role,
      token,
      createdBy: userId,
      createdAt: Date.now(),
    });
    return { token };
  },
});

export const accept = mutation({
  args: { token: v.string(), userId: v.string() },
  handler: async (ctx, { token, userId }) => {
    const rows = await ctx.db
      .query("shareInvites")
      .withIndex("by_token", (q) => q.eq("token", token))
      .collect();
    const invite = rows[0];
    if (!invite || invite.revokedAt) throw new Error("Invite is not available.");
    const existing = await ctx.db
      .query("ownerships")
      .withIndex("by_room_owner", (q) => q.eq("projectId", invite.projectId).eq("ownerUserId", userId))
      .collect();
    const projectOwnership = existing.find((entry) => !entry.trackId && !entry.clipId);
    if (projectOwnership) {
      await ctx.db.patch(projectOwnership._id, { role: invite.role });
    } else {
      await ctx.db.insert("ownerships", {
        projectId: invite.projectId,
        ownerUserId: userId,
        role: invite.role,
      });
    }
    return { projectId: invite.projectId, role: invite.role };
  },
});

export const revoke = mutation({
  args: { token: v.string(), userId: v.string() },
  handler: async (ctx, { token, userId }) => {
    const rows = await ctx.db
      .query("shareInvites")
      .withIndex("by_token", (q) => q.eq("token", token))
      .collect();
    const invite = rows[0];
    if (!invite) return null;
    await requireProjectRole(ctx, invite.projectId, userId, ["owner"]);
    await ctx.db.patch(invite._id, { revokedAt: Date.now() });
    return null;
  },
});
