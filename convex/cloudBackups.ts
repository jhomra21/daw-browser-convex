import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireProjectRole } from "./projectAccess";

const latestBackup = async (ctx: any, projectId: string) => {
  const rows = await ctx.db
    .query("cloudBackups")
    .withIndex("by_room", (q: any) => q.eq("projectId", projectId))
    .collect();
  return rows.sort((left: any, right: any) => right.updatedAt - left.updatedAt)[0];
};

export const getLatest = query({
  args: { projectId: v.string(), userId: v.string() },
  handler: async (ctx, { projectId, userId }) => {
    await requireProjectRole(ctx, projectId, userId, ["owner", "editor", "viewer"]);
    return await latestBackup(ctx, projectId) ?? null;
  },
});

export const upsertLatest = mutation({
  args: {
    projectId: v.string(),
    userId: v.string(),
    manifest: v.any(),
    conflictAction: v.union(v.literal("detect"), v.literal("overwrite")),
  },
  handler: async (ctx, { projectId, userId, manifest, conflictAction }) => {
    await requireProjectRole(ctx, projectId, userId, ["owner", "editor"]);
    const existing = await latestBackup(ctx, projectId);
    if (
      existing
      && conflictAction === "detect"
      && Number(manifest.updatedAt) < existing.updatedAt
    ) {
      return {
        ok: false,
        conflict: {
          localUpdatedAt: Number(manifest.updatedAt) || 0,
          cloudUpdatedAt: existing.updatedAt,
          localEntityCount: Number(manifest.entityCount) || 0,
          cloudEntityCount: existing.entityCount,
          localAssetCount: Number(manifest.assetCount) || 0,
          cloudAssetCount: existing.assetCount,
        },
      };
    }

    const now = Date.now();
    const manifestVersion = `${now}`;
    const row = {
      projectId,
      ownerUserId: userId,
      manifest,
      manifestVersion,
      updatedAt: now,
      entityCount: Number(manifest.entityCount) || 0,
      assetCount: Number(manifest.assetCount) || 0,
    };
    if (existing) {
      await ctx.db.patch(existing._id, row);
    } else {
      await ctx.db.insert("cloudBackups", row);
    }
    return { ok: true, manifestVersion };
  },
});
