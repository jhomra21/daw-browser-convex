import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import {
  controlErrorSchemaV1,
} from "@daw-browser/control";
import { advanceProjectRevision, requireProjectRow } from "./projectRows";
import {
  requireAuthenticatedUserId, requireProjectAccess, requireProjectRole,
} from "./projectAccess";
import { enqueueR2DeleteRows } from "./r2Deletes";
import { findSampleRow, moveSampleFolderRow } from "./sampleRows";

const maxNameLength = 120;

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
