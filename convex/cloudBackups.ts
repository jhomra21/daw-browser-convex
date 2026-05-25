import type { Doc } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { requireProjectRole } from "./projectAccess";
import { projectManifestValidator } from "./projectManifestValidator";
import {
  assertProjectManifestBaseIntegrity,
  assertProjectManifestPublishIntegrity,
  type ProjectManifest,
} from "../src/lib/project-manifest-contract";

type CloudBackup = Doc<"cloudBackups">;

const listBackupsNewestFirst = async (
  ctx: Pick<QueryCtx, "db">,
  projectId: string,
): Promise<CloudBackup[]> => {
  const rows = await ctx.db
    .query("cloudBackups")
    .withIndex("by_room", (q) => q.eq("projectId", projectId))
    .collect();
  return rows.sort((left, right) => right.updatedAt - left.updatedAt);
};

const latestBackup = async (ctx: Pick<QueryCtx, "db">, projectId: string) => (
  (await listBackupsNewestFirst(ctx, projectId))[0]
);

const normalizeLatestBackup = async (ctx: MutationCtx, projectId: string) => {
  const rows = await listBackupsNewestFirst(ctx, projectId);
  const [latest, ...duplicates] = rows;
  for (const duplicate of duplicates) {
    await ctx.db.delete(duplicate._id);
  }
  return {
    latest,
    duplicateManifests: duplicates.map((row) => row.manifest),
  };
};

const readBackupConflict = (
  existing: Pick<CloudBackup, "manifestUpdatedAt" | "entityCount" | "assetCount"> | undefined,
  manifest: BackupManifestForValidation,
) => {
  const manifestUpdatedAt = Number(manifest.updatedAt) || 0;
  if (!existing || manifestUpdatedAt >= existing.manifestUpdatedAt) return null;
  return {
    localUpdatedAt: manifestUpdatedAt,
    cloudUpdatedAt: existing.manifestUpdatedAt,
    localEntityCount: Number(manifest.entityCount) || 0,
    cloudEntityCount: existing.entityCount,
    localAssetCount: Number(manifest.assetCount) || 0,
    cloudAssetCount: existing.assetCount,
  };
};

const assertManifestProject = (projectId: string, manifest: { projectId: string }) => {
  if (manifest.projectId !== projectId) {
    throw new Error("Backup manifest projectId does not match project.");
  }
};

type BackupManifestForValidation = Omit<ProjectManifest, "syncState"> & {
  syncState?: ProjectManifest["syncState"];
};

const assertConflictManifest = (projectId: string, manifest: BackupManifestForValidation) => {
  assertManifestProject(projectId, manifest);
  assertProjectManifestBaseIntegrity({
    ...manifest,
    syncState: manifest.syncState ?? [],
  });
};

const assertPublishManifest = (projectId: string, manifest: BackupManifestForValidation) => {
  assertManifestProject(projectId, manifest);
  assertProjectManifestPublishIntegrity({
    ...manifest,
    syncState: manifest.syncState ?? [],
  });
};

const readManifestCloudKeys = (projectId: string, manifest: BackupManifestForValidation | undefined) => (
  manifest?.assets
    .flatMap((asset) => asset.cloudKey ? [asset.cloudKey] : [])
    .filter((key) => key.startsWith(`projects/${projectId}/assets/`)) ?? []
);

const readSupersededCloudKeys = (
  projectId: string,
  previousManifest: BackupManifestForValidation | undefined,
  nextManifest: BackupManifestForValidation,
) => {
  const nextKeys = new Set(readManifestCloudKeys(projectId, nextManifest));
  return readManifestCloudKeys(projectId, previousManifest).filter((key) => !nextKeys.has(key));
};

export const getLatest = query({
  args: { projectId: v.string(), userId: v.string() },
  handler: async (ctx, { projectId, userId }) => {
    await requireProjectRole(ctx, projectId, userId, ["owner", "editor", "viewer"]);
    return await latestBackup(ctx, projectId) ?? null;
  },
});

export const checkConflict = query({
  args: { projectId: v.string(), userId: v.string(), manifest: projectManifestValidator },
  handler: async (ctx, { projectId, userId, manifest }) => {
    await requireProjectRole(ctx, projectId, userId, ["owner", "editor"]);
    assertConflictManifest(projectId, manifest);
    return readBackupConflict(await latestBackup(ctx, projectId), manifest);
  },
});

export const upsertLatest = mutation({
  args: {
    projectId: v.string(),
    userId: v.string(),
    manifest: projectManifestValidator,
    conflictAction: v.union(v.literal("detect"), v.literal("overwrite")),
  },
  handler: async (ctx, { projectId, userId, manifest, conflictAction }) => {
    await requireProjectRole(ctx, projectId, userId, ["owner", "editor"]);
    assertPublishManifest(projectId, manifest);
    const { latest: existing, duplicateManifests } = await normalizeLatestBackup(ctx, projectId);
    const conflict = readBackupConflict(existing, manifest);
    if (conflictAction === "detect" && conflict) {
      return { ok: false, conflict };
    }
    const supersededCloudKeys = [
      ...readSupersededCloudKeys(projectId, existing?.manifest, manifest),
      ...duplicateManifests.flatMap((duplicateManifest) => readSupersededCloudKeys(projectId, duplicateManifest, manifest)),
    ];

    const now = Date.now();
    const manifestVersion = `${now}`;
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
    return { ok: true, manifestVersion, supersededCloudKeys };
  },
});
