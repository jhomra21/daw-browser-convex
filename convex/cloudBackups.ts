import type { Doc } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { isProjectDeletionPending, requireAuthenticatedUserId, requireProjectRole } from "./projectAccess";
import { projectManifestValidator } from "./projectManifestValidator";
import {
  assertProjectManifestBaseIntegrity,
  assertProjectManifestPublishIntegrity,
  readProjectManifestCloudKeys,
  type ProjectManifest,
} from "@daw-browser/shared";
import { enqueueR2DeleteRows } from "./r2Deletes";

const latestBackup = async (ctx: Pick<QueryCtx, "db">, projectId: string) => (
  await ctx.db
    .query("cloudBackups")
    .withIndex("by_room_updatedAt", (q) => q.eq("projectId", projectId))
    .order("desc")
    .first()
);

const assertProjectNotDeleting = async (ctx: Pick<QueryCtx, "db">, projectId: string) => {
  if (await isProjectDeletionPending(ctx, projectId)) {
    throw new Error("Project deletion is pending.");
  }
};

const readBackupConflict = (
  existing: Pick<Doc<"cloudBackups">, "manifestVersion" | "manifestUpdatedAt" | "entityCount" | "assetCount"> | null | undefined,
  manifest: ProjectManifest,
  baseManifestVersion?: string,
) => {
  const manifestUpdatedAt = Number(manifest.updatedAt) || 0;
  if (!existing) return null;
  if (baseManifestVersion !== existing.manifestVersion || manifestUpdatedAt < existing.manifestUpdatedAt) {
    return {
      localUpdatedAt: manifestUpdatedAt,
      cloudUpdatedAt: existing.manifestUpdatedAt,
      localEntityCount: Number(manifest.entityCount) || 0,
      cloudEntityCount: existing.entityCount,
      localAssetCount: Number(manifest.assetCount) || 0,
      cloudAssetCount: existing.assetCount,
    };
  }
  return null;
};

const assertManifestProject = (projectId: string, manifest: { projectId: string }) => {
  if (manifest.projectId !== projectId) {
    throw new Error("Backup manifest projectId does not match project.");
  }
};

const assertConflictManifest = (projectId: string, manifest: ProjectManifest) => {
  assertManifestProject(projectId, manifest);
  assertProjectManifestBaseIntegrity(manifest);
};

const assertPublishManifest = (projectId: string, manifest: ProjectManifest) => {
  assertManifestProject(projectId, manifest);
  assertProjectManifestPublishIntegrity(manifest);
};

const readSupersededCloudKeys = (
  projectId: string,
  previousManifest: ProjectManifest | undefined,
  nextManifest: ProjectManifest,
) => {
  const nextKeys = new Set(readProjectManifestCloudKeys(projectId, nextManifest));
  return readProjectManifestCloudKeys(projectId, previousManifest).filter((key) => !nextKeys.has(key));
};

export const getLatest = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, projectId, userId, ["owner", "editor", "viewer"]);
    return await latestBackup(ctx, projectId);
  },
});

export const checkConflict = query({
  args: { projectId: v.string(), manifest: projectManifestValidator, baseManifestVersion: v.optional(v.string()) },
  handler: async (ctx, { projectId, manifest, baseManifestVersion }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, projectId, userId, ["owner", "editor"]);
    await assertProjectNotDeleting(ctx, projectId);
    assertConflictManifest(projectId, manifest);
    return readBackupConflict(await latestBackup(ctx, projectId), manifest, baseManifestVersion);
  },
});

export const upsertLatest = mutation({
  args: {
    projectId: v.string(),
    manifest: projectManifestValidator,
    conflictAction: v.union(v.literal("detect"), v.literal("overwrite")),
    baseManifestVersion: v.optional(v.string()),
    pendingDeletedCloudKeys: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { projectId, manifest, conflictAction, baseManifestVersion, pendingDeletedCloudKeys }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, projectId, userId, ["owner", "editor"]);
    await assertProjectNotDeleting(ctx, projectId);
    assertPublishManifest(projectId, manifest);
    const existing = await latestBackup(ctx, projectId);
    const conflict = readBackupConflict(existing, manifest, baseManifestVersion);
    if (conflictAction === "detect" && conflict) {
      return { ok: false, conflict };
    }
    const supersededCloudKeys = readSupersededCloudKeys(projectId, existing?.manifest, manifest);
    const queuedDeletedCloudKeys = [...new Set([...(pendingDeletedCloudKeys ?? []), ...supersededCloudKeys])];
    await enqueueR2DeleteRows(ctx, { projectId, keys: queuedDeletedCloudKeys, kind: "backup-asset" });

    const now = Date.now();
    const manifestVersion = `${now}-${crypto.randomUUID()}`;
    const row = {
      projectId,
      ownerUserId: userId,
      manifest,
      manifestVersion,
      updatedAt: now,
      manifestUpdatedAt: Number(manifest.updatedAt) || 0,
      entityCount: Number(manifest.entityCount) || 0,
      assetCount: Number(manifest.assetCount) || 0,
    };
    if (existing) {
      await ctx.db.patch(existing._id, row);
    } else {
      await ctx.db.insert("cloudBackups", row);
    }
    return { ok: true, manifestVersion, supersededCloudKeys, queuedDeletedCloudKeys };
  },
});
