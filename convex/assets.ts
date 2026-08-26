import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { canonicalJson, controlErrorSchemaV1 } from "@daw-browser/control";
import { advanceProjectRevision, requireProjectRow } from "./projectRows";
import { requireAuthenticatedUserId, requireProjectAccess, requireProjectRole } from "./projectAccess";
import { enqueueR2DeleteRows, hasR2DeleteRow } from "./r2Deletes";
import { findSampleRow, insertSampleRow, moveSampleFolderRow } from "./sampleRows";

const maxNameLength = 120;
const maxUploadBytes = 10 * 1024 * 1024;
const maxSampleRate = 384_000;
const maxChannelCount = 64;
const digestPattern = /^[0-9a-f]{64}$/;
const mimeTypes = new Set([
  "audio/mpeg", "audio/wav", "audio/x-wav", "audio/flac",
  "audio/ogg", "audio/mp4", "audio/aac", "audio/webm",
]);

const fail = (
  code: "invalid-request" | "validation" | "idempotency-conflict" | "forbidden" | "authorization" | "not-found" | "limit-exceeded" | "internal",
  message: string,
): never => {
  throw new ConvexError(controlErrorSchemaV1.parse({ version: "v1", code, message }));
};

const validName = (value: string) => {
  const name = value.trim();
  if (!name || name.length > maxNameLength) fail("validation", "Asset names must be between 1 and 120 characters.");
  return name;
};

const validDigest = (value: string) => {
  if (!digestPattern.test(value)) fail("validation", "Asset SHA-256 must be lowercase hexadecimal.");
  return value;
};

const validMimeType = (value: string) => {
  if (!mimeTypes.has(value)) fail("validation", "Unsupported audio MIME type.");
  return value;
};

const validAudioMetadata = (input: { durationSec: number; sampleRate: number; channelCount: number }) => {
  if (!Number.isFinite(input.durationSec) || input.durationSec <= 0) {
    fail("validation", "Asset duration must be finite and greater than zero.");
  }
  if (!Number.isInteger(input.sampleRate) || input.sampleRate <= 0 || input.sampleRate > maxSampleRate) {
    fail("validation", "Asset sample rate is unsupported.");
  }
  if (!Number.isInteger(input.channelCount) || input.channelCount <= 0 || input.channelCount > maxChannelCount) {
    fail("validation", "Asset channel count is unsupported.");
  }
};

const assetObjectKey = (
  storageNamespace: string,
  assetKey: string,
  digest: string,
  name: string,
  attemptNonce?: string,
) => (
  `asset-namespaces/${storageNamespace}/${assetKey}${attemptNonce ? `/attempt-${attemptNonce}` : ""}/${digest}/${encodeURIComponent(name)}`
);

const assetSemanticDigest = async (input: {
  projectId: string; contentSha256: string; name: string; mimeType: string; sizeBytes: number;
  durationSec: number; sampleRate: number; channelCount: number; folderId?: string;
}) => {
  const bytes = new TextEncoder().encode(canonicalJson({ version: "v1", ...input }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const readFolder = async (ctx: MutationCtx, projectId: string, folderId: string) => {
  const normalized = ctx.db.normalizeId("assetFolders", folderId);
  if (!normalized) return null;
  const folder = await ctx.db.get(normalized);
  return folder?.projectId === projectId ? folder : null;
};

const assetView = (asset: {
  assetKey: string; name: string; sourceKind: string; mimeType: string; sizeBytes: number;
  contentSha256: string; duration?: number; sampleRate?: number; channelCount?: number;
  folderId?: string; createdAt: number; updatedAt: number;
}) => ({
  id: asset.assetKey,
  assetKey: asset.assetKey,
  name: asset.name,
  sourceKind: asset.sourceKind,
  mimeType: asset.mimeType,
  sizeBytes: asset.sizeBytes,
  contentSha256: asset.contentSha256,
  durationSec: asset.duration,
  duration: asset.duration,
  sampleRate: asset.sampleRate,
  channelCount: asset.channelCount,
  folderId: asset.folderId,
  createdAt: asset.createdAt,
  updatedAt: asset.updatedAt,
  ownerUserId: "",
  url: "",
});

const controlAssetView = (asset: {
  assetKey: string; name: string; sourceKind: string; mimeType: string; sizeBytes: number;
  contentSha256: string; duration?: number; sampleRate?: number; channelCount?: number;
  folderId?: string; createdAt: number; updatedAt: number;
}) => ({
  id: asset.assetKey,
  name: asset.name,
  sourceKind: asset.sourceKind,
  mimeType: asset.mimeType,
  sizeBytes: asset.sizeBytes,
  contentSha256: asset.contentSha256,
  durationSec: asset.duration,
  sampleRate: asset.sampleRate,
  channelCount: asset.channelCount,
  folderId: asset.folderId,
  createdAt: asset.createdAt,
  updatedAt: asset.updatedAt,
});

const folderView = (folder: { _id: unknown; name: string; createdAt: number; updatedAt: number }) => ({
  id: String(folder._id),
  _id: String(folder._id),
  name: folder.name,
  createdAt: folder.createdAt,
  updatedAt: folder.updatedAt,
});

const controlFolderView = (folder: { _id: unknown; name: string; createdAt: number; updatedAt: number }) => ({
  id: String(folder._id),
  name: folder.name,
  createdAt: folder.createdAt,
  updatedAt: folder.updatedAt,
});

export const listByProject = query({
  args: { projectId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { projectId, limit }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectAccess(ctx, projectId, userId);
    const rows = await ctx.db.query("samples").withIndex("by_room", (query) => query.eq("projectId", projectId))
      .take(Math.max(1, Math.min(limit ?? 1_000, 1_000)));
    return rows.map(assetView).sort((left, right) => left.id.localeCompare(right.id));
  },
});

export const listFoldersByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectAccess(ctx, projectId, userId);
    return (await ctx.db.query("assetFolders").withIndex("by_project", (query) => query.eq("projectId", projectId))
      .take(500)).map(folderView).sort((left, right) => left.id.localeCompare(right.id));
  },
});

export const beginUpload = mutation({
  args: {
    projectId: v.string(), idempotencyKey: v.string(), contentSha256: v.string(), name: v.string(),
    mimeType: v.string(), sizeBytes: v.number(), durationSec: v.number(), sampleRate: v.number(),
    channelCount: v.number(), folderId: v.optional(v.string()),
  },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, input.projectId, userId, ["owner", "editor"]);
    if (!/^[A-Za-z0-9._~-]{8,128}$/.test(input.idempotencyKey)) fail("invalid-request", "Invalid idempotency key.");
    const contentSha256 = validDigest(input.contentSha256);
    const name = validName(input.name);
    const mimeType = validMimeType(input.mimeType);
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > maxUploadBytes) {
      fail("limit-exceeded", "Asset upload exceeds the 10 MiB limit.");
    }
    validAudioMetadata(input);
    const project = await requireProjectRow(ctx, input.projectId);
    const semanticDigest = await assetSemanticDigest({
      projectId: input.projectId,
      contentSha256,
      name,
      mimeType,
      sizeBytes: input.sizeBytes,
      durationSec: input.durationSec,
      sampleRate: input.sampleRate,
      channelCount: input.channelCount,
      folderId: input.folderId,
    });
    if (input.folderId && !await readFolder(ctx, input.projectId, input.folderId)) fail("not-found", "Asset folder not found.");
    const prior = await ctx.db.query("assetUploadReceipts")
      .withIndex("by_project_actor_idempotency", (query) => query
        .eq("projectId", input.projectId).eq("actorUserId", userId).eq("idempotencyKey", input.idempotencyKey))
      .unique();
    if (prior) {
      if (
        prior.durationSec === undefined
        || prior.sampleRate === undefined
        || prior.channelCount === undefined
      ) {
        fail("idempotency-conflict", "Idempotency key is bound to a legacy upload receipt.");
      }
      if (prior.semanticDigest !== semanticDigest) fail("idempotency-conflict", "Idempotency key is already bound to another request.");
      if (prior.status === "failed") {
        const attempts = prior.attempts + 1;
        const r2Key = assetObjectKey(project.storageNamespace, prior.assetKey, contentSha256, name, String(attempts));
        await ctx.db.patch(prior._id, {
          r2Key,
          status: "pending",
          attempts,
          updatedAt: Date.now(),
        });
        return {
          status: "pending" as const,
          assetKey: prior.assetKey,
          r2Key,
          durationSec: prior.durationSec,
          sampleRate: prior.sampleRate,
          channelCount: prior.channelCount,
        };
      }
      return {
        status: prior.status,
        assetKey: prior.assetKey,
        r2Key: prior.r2Key,
        durationSec: prior.durationSec,
        sampleRate: prior.sampleRate,
        channelCount: prior.channelCount,
      };
    }
    if ((await ctx.db.query("samples").withIndex("by_room", (query) => query.eq("projectId", input.projectId)).take(1_000)).length >= 1_000) {
      fail("limit-exceeded", "Project asset limit reached.");
    }
    const assetKey = `asset-${crypto.randomUUID()}`;
    const r2Key = assetObjectKey(project.storageNamespace, assetKey, contentSha256, name);
    const now = Date.now();
    await ctx.db.insert("assetUploadReceipts", {
      projectId: input.projectId, actorUserId: userId, idempotencyKey: input.idempotencyKey,
      contentSha256, semanticDigest, assetKey, r2Key, status: "pending", mimeType, sizeBytes: input.sizeBytes, name,
      durationSec: input.durationSec, sampleRate: input.sampleRate, channelCount: input.channelCount,
      folderId: input.folderId,
      createdAt: now, updatedAt: now, attempts: 1,
    });
    return {
      status: "pending" as const,
      assetKey,
      r2Key,
      durationSec: input.durationSec,
      sampleRate: input.sampleRate,
      channelCount: input.channelCount,
    };
  },
});

export const finalizeUpload = mutation({
  args: { projectId: v.string(), idempotencyKey: v.string(), contentSha256: v.string() },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, input.projectId, userId, ["owner", "editor"]);
    const receipt = await ctx.db.query("assetUploadReceipts")
      .withIndex("by_project_actor_idempotency", (query) => query
        .eq("projectId", input.projectId).eq("actorUserId", userId).eq("idempotencyKey", input.idempotencyKey))
      .unique();
    if (receipt === null) throw new Error("Upload receipt not found.");
    if (receipt.contentSha256 !== validDigest(input.contentSha256)) fail("idempotency-conflict", "Upload digest does not match receipt.");
    const existing = await findSampleRow(ctx, { projectId: input.projectId, assetKey: receipt.assetKey });
    if (receipt.status === "completed" && existing) return { asset: controlAssetView(existing), idempotencyReplay: true };
    if (receipt.status !== "pending") fail("validation", "Upload receipt is not pending.");
    if (
      receipt.durationSec === undefined
      || receipt.sampleRate === undefined
      || receipt.channelCount === undefined
    ) {
      fail("validation", "Legacy upload receipt metadata is unavailable; the upload must be restarted.");
    }
    const uploadedObjectStorageKey = receipt.r2Key;
    if (await hasR2DeleteRow(ctx, { projectId: input.projectId, r2Key: uploadedObjectStorageKey })) {
      fail("validation", "Upload object cleanup is pending.");
    }
    if (receipt.folderId && !await readFolder(ctx, input.projectId, receipt.folderId)) {
      fail("validation", "Asset folder was removed before upload finalization.");
    }
    if ((await ctx.db.query("samples").withIndex("by_room", (query) => query.eq("projectId", input.projectId)).take(1_000)).length >= 1_000) {
      fail("limit-exceeded", "Project asset limit reached.");
    }
    const rowId = await insertSampleRow(ctx, {
      projectId: input.projectId, assetKey: receipt.assetKey, sourceKind: "upload", ownerUserId: userId,
      name: receipt.name, mimeType: receipt.mimeType, sizeBytes: receipt.sizeBytes, contentSha256: receipt.contentSha256,
      r2Key: uploadedObjectStorageKey, duration: receipt.durationSec, sampleRate: receipt.sampleRate,
      channelCount: receipt.channelCount, folderId: receipt.folderId,
    });
    const asset = await ctx.db.get(rowId);
    if (asset === null) throw new Error("Asset finalization failed.");
    const completedAt = Date.now();
    await ctx.db.patch(receipt._id, { status: "completed", updatedAt: completedAt, completedAt });
    await advanceProjectRevision(ctx, input.projectId);
    return { asset: controlAssetView(asset), idempotencyReplay: false };
  },
});

export const failUpload = mutation({
  args: { projectId: v.string(), idempotencyKey: v.string(), contentSha256: v.string() },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, input.projectId, userId, ["owner", "editor"]);
    const receipt = await ctx.db.query("assetUploadReceipts")
      .withIndex("by_project_actor_idempotency", (query) => query
        .eq("projectId", input.projectId).eq("actorUserId", userId).eq("idempotencyKey", input.idempotencyKey))
      .unique();
    if (!receipt || receipt.contentSha256 !== validDigest(input.contentSha256) || receipt.status === "completed") return { queued: false };
    await ctx.db.patch(receipt._id, { status: "failed", updatedAt: Date.now() });
    const project = await requireProjectRow(ctx, input.projectId);
    await enqueueR2DeleteRows(ctx, {
      projectId: input.projectId, storageNamespace: project.storageNamespace, keys: [receipt.r2Key], kind: "sample",
    });
    return { queued: true };
  },
});

export const getContentLocator = query({
  args: { projectId: v.string(), assetKey: v.string() },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectAccess(ctx, input.projectId, userId);
    const asset = await findSampleRow(ctx, input);
    if (!asset) return null;
    return { r2Key: asset.r2Key, mimeType: asset.mimeType, name: asset.name };
  },
});

export const deleteAsset = mutation({
  args: { projectId: v.string(), assetKey: v.string() },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, input.projectId, userId, ["owner", "editor"]);
    const asset = await findSampleRow(ctx, input);
    if (!asset) return { deleted: false };
    const reference = await ctx.db.query("clips").withIndex("by_room", (query) => query.eq("projectId", input.projectId))
      .filter((query) => query.eq(query.field("sourceAssetKey"), input.assetKey)).first();
    if (reference) fail("validation", "Referenced assets cannot be deleted.");
    await ctx.db.delete(asset._id);
    const receipts = await ctx.db.query("assetUploadReceipts").withIndex("by_asset", (query) => query
      .eq("projectId", input.projectId).eq("assetKey", input.assetKey)).collect();
    await Promise.all(receipts.map((receipt) => ctx.db.delete(receipt._id)));
    const project = await requireProjectRow(ctx, input.projectId);
    await enqueueR2DeleteRows(ctx, {
      projectId: input.projectId, storageNamespace: project.storageNamespace, keys: [asset.r2Key], kind: "sample",
    });
    await advanceProjectRevision(ctx, input.projectId);
    return { deleted: true };
  },
});

export const createFolder = mutation({
  args: { projectId: v.string(), name: v.string() },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, input.projectId, userId, ["owner", "editor"]);
    if ((await ctx.db.query("assetFolders").withIndex("by_project", (query) => query.eq("projectId", input.projectId)).take(500)).length >= 500) {
      fail("limit-exceeded", "Project asset folder limit reached.");
    }
    const now = Date.now();
    const id = await ctx.db.insert("assetFolders", { projectId: input.projectId, name: validName(input.name), createdAt: now, updatedAt: now });
    const folder = await ctx.db.get(id);
    if (folder === null) throw new Error("Folder creation failed.");
    await advanceProjectRevision(ctx, input.projectId);
    return { folder: controlFolderView(folder), applied: true };
  },
});

export const renameFolder = mutation({
  args: { projectId: v.string(), folderId: v.string(), name: v.string() },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, input.projectId, userId, ["owner", "editor"]);
    const folder = await readFolder(ctx, input.projectId, input.folderId);
    if (folder === null) throw new Error("Asset folder not found.");
    const name = validName(input.name);
    if (folder.name === name) return { folder: controlFolderView(folder), applied: false };
    const updatedAt = Date.now();
    await ctx.db.patch(folder._id, { name, updatedAt });
    await advanceProjectRevision(ctx, input.projectId);
    return { folder: { ...controlFolderView(folder), name, updatedAt }, applied: true };
  },
});

export const deleteFolder = mutation({
  args: { projectId: v.string(), folderId: v.string() },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, input.projectId, userId, ["owner", "editor"]);
    const folder = await readFolder(ctx, input.projectId, input.folderId);
    if (!folder) return { deleted: false };
    const asset = await ctx.db.query("samples").withIndex("by_room_folder", (query) => query
      .eq("projectId", input.projectId).eq("folderId", input.folderId)).first();
    if (asset) fail("validation", "Only empty asset folders can be deleted.");
    const pendingReceipt = await ctx.db.query("assetUploadReceipts").withIndex("by_project_folder_status", (query) => query
      .eq("projectId", input.projectId).eq("folderId", input.folderId).eq("status", "pending")).first();
    if (pendingReceipt) fail("validation", "Folders with pending uploads cannot be deleted.");
    const failedReceipt = await ctx.db.query("assetUploadReceipts").withIndex("by_project_folder_status", (query) => query
      .eq("projectId", input.projectId).eq("folderId", input.folderId).eq("status", "failed")).first();
    if (failedReceipt) fail("validation", "Folders with retryable uploads cannot be deleted.");
    await ctx.db.delete(folder._id);
    await advanceProjectRevision(ctx, input.projectId);
    return { deleted: true };
  },
});

export const moveAssetToFolder = mutation({
  args: { projectId: v.string(), assetKey: v.string(), folderId: v.optional(v.string()) },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, input.projectId, userId, ["owner", "editor"]);
    if (input.folderId && !await readFolder(ctx, input.projectId, input.folderId)) fail("not-found", "Asset folder not found.");
    const result = await moveSampleFolderRow(ctx, input);
    if (result.asset === null) throw new Error("Asset not found.");
    const asset = result.asset;
    if (!result.changed) return { asset: assetView(asset), applied: false };
    await advanceProjectRevision(ctx, input.projectId);
    return { asset: assetView({ ...asset, folderId: input.folderId, updatedAt: Date.now() }), applied: true };
  },
});

export const reconcileStalePending = mutation({
  args: { before: v.number(), limit: v.number() },
  handler: async (ctx, input) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity?.dawWorker !== true) throw new Error("Asset reconciliation requires worker access.");
    const limit = Math.max(1, Math.min(input.limit, 100));
    const receipts = await ctx.db.query("assetUploadReceipts")
      .withIndex("by_status_updatedAt", (query) => query.eq("status", "pending").lte("updatedAt", input.before))
      .take(limit);
    for (const receipt of receipts) {
      const completed = await findSampleRow(ctx, { projectId: receipt.projectId, assetKey: receipt.assetKey });
      if (completed) {
        const now = Date.now();
        await ctx.db.patch(receipt._id, {
          status: "completed",
          completedAt: now,
          updatedAt: now,
        });
        if (completed.duration !== undefined) await ctx.db.patch(receipt._id, { durationSec: completed.duration });
        if (completed.sampleRate !== undefined) await ctx.db.patch(receipt._id, { sampleRate: completed.sampleRate });
        if (completed.channelCount !== undefined) await ctx.db.patch(receipt._id, { channelCount: completed.channelCount });
        continue;
      }
      await ctx.db.patch(receipt._id, { status: "failed", updatedAt: Date.now() });
      const project = await requireProjectRow(ctx, receipt.projectId);
      await enqueueR2DeleteRows(ctx, {
        projectId: receipt.projectId, storageNamespace: project.storageNamespace, keys: [receipt.r2Key], kind: "sample",
      });
    }
    return { reconciled: receipts.length };
  },
});
