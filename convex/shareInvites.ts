import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireProjectRole } from "./projectAccess";

declare const process: { env: { SHARE_INVITES_SERVICE_TOKEN?: string } };

const requireServerSecret = (serverSecret: string) => {
  if (!serverSecret || serverSecret !== process.env.SHARE_INVITES_SERVICE_TOKEN) {
    throw new Error("Unauthorized share invite request.");
  }
};

const roleRank = (role: "owner" | "editor" | "viewer" | undefined) => (
  role === "owner" ? 3 : role === "viewer" ? 1 : 2
);

export const create = mutation({
  args: {
    projectId: v.string(),
    userId: v.string(),
    role: v.union(v.literal("editor"), v.literal("viewer")),
    serverSecret: v.string(),
  },
  handler: async (ctx, { projectId, userId, role, serverSecret }) => {
    requireServerSecret(serverSecret);
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
  args: { token: v.string(), userId: v.string(), serverSecret: v.string() },
  handler: async (ctx, { token, userId, serverSecret }) => {
    requireServerSecret(serverSecret);
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
      if (roleRank(invite.role) > roleRank(projectOwnership.role)) {
        await ctx.db.patch(projectOwnership._id, { role: invite.role });
      }
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
  args: { token: v.string(), userId: v.string(), serverSecret: v.string() },
  handler: async (ctx, { token, userId, serverSecret }) => {
    requireServerSecret(serverSecret);
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
