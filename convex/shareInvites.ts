import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAuthenticatedUserId, requireProjectRole } from "./projectAccess";
import { removeProjectMemberAccessAndTransferEntities } from "./projectMembership";

const SHARE_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const roleRank = (role: "owner" | "editor" | "viewer" | undefined) => (
  role === "owner" ? 3 : role === "viewer" ? 1 : 2
);

export const create = mutation({
  args: {
    projectId: v.string(),
    role: v.union(v.literal("editor"), v.literal("viewer")),
  },
  handler: async (ctx, { projectId, role }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, projectId, userId, ["owner"]);
    const token = crypto.randomUUID();
    const now = Date.now();
    await ctx.db.insert("shareInvites", {
      projectId,
      role,
      token,
      createdBy: userId,
      createdAt: now,
      expiresAt: now + SHARE_INVITE_TTL_MS,
    });
    return { token };
  },
});

export const accept = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const invite = await ctx.db
      .query("shareInvites")
      .withIndex("by_token", (q) => q.eq("token", token))
      .first();
    if (!invite || invite.revokedAt || (invite.expiresAt !== undefined && invite.expiresAt <= Date.now())) {
      throw new Error("Invite is not available.");
    }
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
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const invite = await ctx.db
      .query("shareInvites")
      .withIndex("by_token", (q) => q.eq("token", token))
      .first();
    if (!invite) return null;
    await requireProjectRole(ctx, invite.projectId, userId, ["owner"]);
    await ctx.db.patch(invite._id, { revokedAt: Date.now() });
    return null;
  },
});

export const listAcceptedAccess = query({
  args: { projectId: v.string() },
  returns: v.array(v.object({
    userId: v.string(),
    role: v.union(v.literal("editor"), v.literal("viewer")),
  })),
  handler: async (ctx, { projectId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, projectId, userId, ["owner"]);
    const rows = await ctx.db
      .query("ownerships")
      .withIndex("by_room", (q) => q.eq("projectId", projectId))
      .collect();
    return rows.flatMap((row) => {
      if (row.trackId || row.clipId) return [];
      if (row.ownerUserId === userId) return [];
      if (row.role !== "editor" && row.role !== "viewer") return [];
      return [{ userId: row.ownerUserId, role: row.role }];
    });
  },
});

export const revokeAcceptedAccess = mutation({
  args: {
    projectId: v.string(),
    targetUserId: v.string(),
  },
  returns: v.object({
    status: v.union(v.literal("revoked"), v.literal("not-found")),
  }),
  handler: async (ctx, { projectId, targetUserId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, projectId, userId, ["owner"]);
    if (targetUserId === userId) {
      throw new Error("Project owners cannot revoke themselves.");
    }

    const removal = await removeProjectMemberAccessAndTransferEntities(ctx, projectId, targetUserId);
    if (removal.status === "not-found") {
      const result: { status: "not-found" } = { status: "not-found" };
      return result;
    }
    const result: { status: "revoked" } = { status: "revoked" };
    return result;
  },
});
