import type { MutationCtx, QueryCtx } from "./_generated/server";

type SampleContext = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

export type AssetRowInput = {
  projectId: string;
  assetKey: string;
  sourceKind: "upload" | "url" | "recording";
  ownerUserId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  contentSha256: string;
  r2Key: string;
  duration?: number;
  sampleRate?: number;
  channelCount?: number;
  folderId?: string;
};

export const findSampleRow = async (
  ctx: SampleContext,
  input: { projectId: string; assetKey: string },
) => await ctx.db
  .query("samples")
  .withIndex("by_room_assetKey", (query) => query.eq("projectId", input.projectId).eq("assetKey", input.assetKey))
  .unique();

export const insertSampleRow = async (
  ctx: Pick<MutationCtx, "db">,
  input: AssetRowInput,
) => {
  const now = Date.now();
  return await ctx.db.insert("samples", {
    ...input,
    createdAt: now,
    updatedAt: now,
  });
};

export const moveSampleFolderRow = async (
  ctx: Pick<MutationCtx, "db">,
  input: { projectId: string; assetKey: string; folderId?: string },
) => {
  const asset = await findSampleRow(ctx, input);
  if (!asset) return { changed: false, asset: null };
  if (asset.folderId === input.folderId) return { changed: false, asset };
  await ctx.db.patch(asset._id, { folderId: input.folderId, updatedAt: Date.now() });
  return { changed: true, asset };
};

export const deleteSampleRow = async (
  ctx: Pick<MutationCtx, "db">,
  input: { projectId: string; assetKey: string },
) => {
  const asset = await findSampleRow(ctx, input);
  if (!asset) return { changed: false, asset: null };
  await ctx.db.delete(asset._id);
  const receipts = await ctx.db
    .query("assetUploadReceipts")
    .withIndex("by_asset", (query) => query.eq("projectId", input.projectId).eq("assetKey", input.assetKey))
    .collect();
  for (const receipt of receipts) await ctx.db.delete(receipt._id);
  return { changed: true, asset };
};
