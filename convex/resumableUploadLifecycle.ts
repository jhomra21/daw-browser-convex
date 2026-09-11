import type { QueryCtx } from "./_generated/server";

export const resumableSessionTtlMs = 24 * 60 * 60 * 1000;
export const resumableLeaseMs = 5 * 60 * 1000;

export const listAcceptedResumableParts = async (
  ctx: { db: QueryCtx["db"] },
  session: { projectId: string; assetKey: string; multipartUploadId: string },
) => (await ctx.db.query("assetUploadParts")
  .withIndex("by_upload", (query) => query
    .eq("projectId", session.projectId).eq("assetKey", session.assetKey)
    .eq("multipartUploadId", session.multipartUploadId))
  .collect())
  .filter((part) => part.status === "accepted")
  .sort((left, right) => left.partNumber - right.partNumber)
  .map((part) => ({ partNumber: part.partNumber, etag: part.etag, sizeBytes: part.sizeBytes }));

export const validateResumableVerificationState = (
  state: { words: number[]; totalBytes: number; tail: number[] },
  expectedBytes: number,
  fail: (message: string) => never,
) => {
  if (state.words.length !== 8 || state.tail.length >= 64
    || !Number.isSafeInteger(state.totalBytes) || state.totalBytes !== expectedBytes
    || state.tail.length !== expectedBytes % 64
    || state.words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffffffff)
    || state.tail.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    fail("Resumable upload verification state is invalid.");
  }
};
