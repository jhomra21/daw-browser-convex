import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import {
  canonicalJson, controlErrorSchemaV1, controlLimitsV1, resumableUploadLimitsV1,
} from "@daw-browser/control";
import { advanceProjectRevision, requireProjectRow } from "./projectRows";
import {
  requireAuthenticatedIdentity, requireAuthenticatedUserId, requireProjectRole,
  requireWorkerIdentity,
} from "./projectAccess";
import { enqueueMultipartAbortRows, enqueueR2DeleteRows, hasR2DeleteRow } from "./r2Deletes";
import { findSampleRow, insertSampleRow } from "./sampleRows";
import {
  listAcceptedResumableParts, resumableLeaseMs, resumableSessionTtlMs,
  validateResumableVerificationState,
} from "./resumableUploadLifecycle";

const maxNameLength = 120;
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

type AudioMetadata = { durationSec: number; sampleRate: number; channelCount: number };

const validAudioMetadata = (input: {
  durationSec?: number; sampleRate?: number; channelCount?: number;
}): AudioMetadata => {
  const durationSec = input.durationSec;
  const sampleRate = input.sampleRate;
  const channelCount = input.channelCount;
  if (durationSec === undefined || sampleRate === undefined || channelCount === undefined) {
    throw new Error("Authoritative audio metadata is required.");
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    fail("validation", "Asset duration must be finite and greater than zero.");
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate > maxSampleRate) {
    fail("validation", "Asset sample rate is unsupported.");
  }
  if (!Number.isInteger(channelCount) || channelCount <= 0 || channelCount > maxChannelCount) {
    fail("validation", "Asset channel count is unsupported.");
  }
  return { durationSec, sampleRate, channelCount };
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
  durationSec?: number; sampleRate?: number; channelCount?: number; folderId?: string;
  transport?: "multipart" | "resumable";
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

export const beginUpload = mutation({
  args: {
    projectId: v.string(), idempotencyKey: v.string(), contentSha256: v.string(), name: v.string(),
    mimeType: v.string(), sizeBytes: v.number(), durationSec: v.optional(v.number()), sampleRate: v.optional(v.number()),
    channelCount: v.optional(v.number()), folderId: v.optional(v.string()),
    transport: v.optional(v.union(v.literal("multipart"), v.literal("resumable"))),
  },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, input.projectId, userId, ["owner", "editor"]);
    if (!/^[A-Za-z0-9._~-]{8,128}$/.test(input.idempotencyKey)) fail("invalid-request", "Invalid idempotency key.");
    const contentSha256 = validDigest(input.contentSha256);
    const name = validName(input.name);
    const mimeType = validMimeType(input.mimeType);
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1) {
      fail("invalid-request", "Asset size is invalid.");
    }
    if (input.transport !== "resumable" && input.sizeBytes > controlLimitsV1.maxAssetUploadBytes) {
      fail("limit-exceeded", "Asset upload exceeds the 10 MiB file limit.");
    }
    if (input.transport !== "resumable") validAudioMetadata(input);
    const partCount = Math.ceil(input.sizeBytes / resumableUploadLimitsV1.partSizeBytes);
    if (input.transport === "resumable" && partCount > resumableUploadLimitsV1.maxPartCount) {
      fail("limit-exceeded", "Resumable upload has too many parts.");
    }
    const enforceResumableQuotas = async () => {
      if (input.transport !== "resumable") return;
      const statuses = ["uploading", "completing", "verifying", "finalizing"] as const;
      const activeSessions = (await Promise.all(statuses.map((status) => ctx.db.query("assetUploadSessions")
        .withIndex("by_project_status", (query) => query.eq("projectId", input.projectId).eq("status", status))
        .take(resumableUploadLimitsV1.maxActiveSessionsPerProject + 1)))).flat();
      if (activeSessions.length >= resumableUploadLimitsV1.maxActiveSessionsPerProject) {
        fail("limit-exceeded", "Project resumable upload quota reached.");
      }
      const activeActorSessions = activeSessions.filter((session) => session.actorUserId === userId);
      if (activeActorSessions.length >= resumableUploadLimitsV1.maxActiveSessionsPerActor) {
        fail("limit-exceeded", "User resumable upload quota reached.");
      }
    };
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
      transport: input.transport,
      folderId: input.folderId,
    });
    if (input.folderId && !await readFolder(ctx, input.projectId, input.folderId)) fail("not-found", "Asset folder not found.");
    const prior = await ctx.db.query("assetUploadReceipts")
      .withIndex("by_project_actor_idempotency", (query) => query
        .eq("projectId", input.projectId).eq("actorUserId", userId).eq("idempotencyKey", input.idempotencyKey))
      .unique();
    if (prior) {
      if (prior.transport !== "resumable" && (
        prior.durationSec === undefined
        || prior.sampleRate === undefined
        || prior.channelCount === undefined
      )) {
        fail("idempotency-conflict", "Idempotency key is bound to a legacy upload receipt.");
      }
      if (prior.semanticDigest !== semanticDigest) fail("idempotency-conflict", "Idempotency key is already bound to another request.");
      if (prior.status === "failed") {
        await enforceResumableQuotas();
        const attempts = prior.attempts + 1;
        const r2Key = assetObjectKey(project.storageNamespace, prior.assetKey, contentSha256, name, String(attempts));
        const sessionId = prior.transport === "resumable" ? crypto.randomUUID() : undefined;
        await ctx.db.patch(prior._id, {
          r2Key,
          status: "pending",
          attempts,
          multipartUploadId: undefined,
          sessionId,
          updatedAt: Date.now(),
        });
        if (sessionId) {
          await ctx.db.insert("assetUploadSessions", {
            sessionId, projectId: input.projectId, actorUserId: userId, idempotencyKey: input.idempotencyKey,
            contentSha256, assetKey: prior.assetKey, r2Key, multipartUploadId: "",
            name, mimeType, sizeBytes: input.sizeBytes, partSizeBytes: resumableUploadLimitsV1.partSizeBytes,
            partCount, acceptedBytes: 0, status: "uploading", expiresAt: Date.now() + resumableSessionTtlMs,
            createdAt: Date.now(), updatedAt: Date.now(),
          });
        }
        return {
          status: "pending" as const,
          assetKey: prior.assetKey,
          r2Key,
          sessionId,
          durationSec: prior.durationSec,
          sampleRate: prior.sampleRate,
          channelCount: prior.channelCount,
        };
      }
      return {
        status: prior.status,
        assetKey: prior.assetKey,
        r2Key: prior.r2Key,
        multipartUploadId: prior.multipartUploadId,
        sessionId: prior.sessionId,
        durationSec: prior.durationSec,
        sampleRate: prior.sampleRate,
        channelCount: prior.channelCount,
      };
    }
    if ((await ctx.db.query("samples").withIndex("by_room", (query) => query.eq("projectId", input.projectId)).take(1_000)).length >= 1_000) {
      fail("limit-exceeded", "Project asset limit reached.");
    }
    await enforceResumableQuotas();
    const assetKey = `asset-${crypto.randomUUID()}`;
    const r2Key = assetObjectKey(project.storageNamespace, assetKey, contentSha256, name);
    const now = Date.now();
    const sessionId = input.transport === "resumable" ? crypto.randomUUID() : undefined;
    await ctx.db.insert("assetUploadReceipts", {
      projectId: input.projectId, actorUserId: userId, idempotencyKey: input.idempotencyKey,
      contentSha256, semanticDigest, assetKey, r2Key, status: "pending", mimeType, sizeBytes: input.sizeBytes, name,
      durationSec: input.durationSec, sampleRate: input.sampleRate, channelCount: input.channelCount,
      folderId: input.folderId, transport: input.transport,
      sessionId,
      createdAt: now, updatedAt: now, attempts: 1,
    });
    if (sessionId) {
      await ctx.db.insert("assetUploadSessions", {
        sessionId, projectId: input.projectId, actorUserId: userId, idempotencyKey: input.idempotencyKey,
        contentSha256, assetKey, r2Key, multipartUploadId: "",
        name, mimeType, sizeBytes: input.sizeBytes, partSizeBytes: resumableUploadLimitsV1.partSizeBytes,
        partCount, acceptedBytes: 0, status: "uploading", expiresAt: now + resumableSessionTtlMs,
        createdAt: now, updatedAt: now,
      });
    }
    return {
      status: "pending" as const,
      assetKey,
      r2Key,
      multipartUploadId: undefined,
      sessionId,
      durationSec: input.durationSec,
      sampleRate: input.sampleRate,
      channelCount: input.channelCount,
    };
  },
});

export const finalizeUpload = mutation({
  args: {
    projectId: v.string(), idempotencyKey: v.optional(v.string()), assetKey: v.optional(v.string()),
    multipartUploadId: v.optional(v.string()), sessionId: v.optional(v.string()),
    completionToken: v.optional(v.string()), durationSec: v.optional(v.number()),
    sampleRate: v.optional(v.number()), channelCount: v.optional(v.number()), contentSha256: v.string(),
  },
  handler: async (ctx, input) => {
    const identity = await requireAuthenticatedIdentity(ctx);
    const userId = identity.subject;
    let receipt = input.idempotencyKey
      ? await ctx.db.query("assetUploadReceipts")
        .withIndex("by_project_actor_idempotency", (query) => query
          .eq("projectId", input.projectId).eq("actorUserId", userId).eq("idempotencyKey", input.idempotencyKey!))
        .unique()
      : input.assetKey && input.multipartUploadId
        ? (await ctx.db.query("assetUploadReceipts")
          .withIndex("by_asset", (query) => query.eq("projectId", input.projectId).eq("assetKey", input.assetKey!))
          .collect()).find((candidate) => candidate.multipartUploadId === input.multipartUploadId) ?? null
        : input.sessionId
          ? (await ctx.db.query("assetUploadReceipts")
            .withIndex("by_session", (query) => query.eq("sessionId", input.sessionId!)).unique())
          : null;
    if (receipt === null) throw new Error("Upload receipt not found.");
    const isResumable = receipt.transport === "resumable";
    if (isResumable) await requireWorkerIdentity(ctx);
    else await requireProjectRole(ctx, input.projectId, userId, ["owner", "editor"]);
    if (!isResumable && receipt.actorUserId !== userId) {
      fail("authorization", "Upload receipt belongs to another user.");
    }
    if (receipt.contentSha256 !== validDigest(input.contentSha256)) fail("idempotency-conflict", "Upload digest does not match receipt.");
    if (isResumable) {
      if (!input.sessionId || !input.completionToken || receipt.sessionId !== input.sessionId
        || receipt.projectId !== input.projectId || receipt.assetKey !== input.assetKey) {
        fail("authorization", "Resumable upload binding is invalid.");
      }
      const resumable = await ctx.db.query("assetUploadSessions")
        .withIndex("by_session", (query) => query.eq("sessionId", input.sessionId!)).unique();
      if (!resumable) throw new Error("Resumable upload session not found.");
      if (resumable.projectId !== receipt.projectId || resumable.assetKey !== receipt.assetKey
        || resumable.sessionId !== receipt.sessionId || resumable.status !== "finalizing"
        || resumable.completionToken !== input.completionToken) {
        fail("validation", "Resumable completion is no longer valid.");
      }
      const metadata = validAudioMetadata(input);
      await ctx.db.patch(receipt._id, {
        durationSec: metadata.durationSec, sampleRate: metadata.sampleRate, channelCount: metadata.channelCount,
      });
      receipt = { ...receipt, ...metadata };
    }
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
      projectId: input.projectId, assetKey: receipt.assetKey, sourceKind: "upload",
      ownerUserId: receipt.actorUserId,
      name: receipt.name, mimeType: receipt.mimeType, sizeBytes: receipt.sizeBytes, contentSha256: receipt.contentSha256,
      r2Key: uploadedObjectStorageKey, duration: receipt.durationSec, sampleRate: receipt.sampleRate,
      channelCount: receipt.channelCount, folderId: receipt.folderId,
    });
    const asset = await ctx.db.get(rowId);
    if (asset === null) throw new Error("Asset finalization failed.");
    const completedAt = Date.now();
    await ctx.db.patch(receipt._id, { status: "completed", updatedAt: completedAt, completedAt });
    if (isResumable) {
      const resumable = await ctx.db.query("assetUploadSessions")
        .withIndex("by_session", (query) => query.eq("sessionId", input.sessionId!)).unique();
      if (!resumable) throw new Error("Resumable upload session not found.");
      if (resumable.status !== "finalizing"
        || resumable.completionToken !== input.completionToken) {
        fail("validation", "Resumable completion was superseded.");
      }
      await ctx.db.patch(resumable._id, {
      status: "completed", acceptedBytes: resumable.sizeBytes, leaseToken: undefined,
        leaseExpiresAt: undefined, updatedAt: completedAt,
      });
    }
    const completedMultipartUploadId = receipt.multipartUploadId;
    if (completedMultipartUploadId) {
      const parts = await ctx.db.query("assetUploadParts").withIndex("by_upload", (query) => query
        .eq("projectId", receipt.projectId).eq("assetKey", receipt.assetKey)
        .eq("multipartUploadId", completedMultipartUploadId)).collect();
      await Promise.all(parts.map((part) => ctx.db.delete(part._id)));
    }
    await advanceProjectRevision(ctx, input.projectId);
    return { asset: controlAssetView(asset), idempotencyReplay: false };
  },
});

export const attachMultipartUpload = mutation({
  args: {
    projectId: v.string(), idempotencyKey: v.string(), contentSha256: v.string(),
    multipartUploadId: v.string(),
  },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, input.projectId, userId, ["owner", "editor"]);
    const receipt = await ctx.db.query("assetUploadReceipts")
      .withIndex("by_project_actor_idempotency", (query) => query
        .eq("projectId", input.projectId).eq("actorUserId", userId).eq("idempotencyKey", input.idempotencyKey))
      .unique();
    if (!receipt) {
      throw new Error("Upload receipt not found.");
    }
    if (receipt.contentSha256 !== validDigest(input.contentSha256)) {
      fail("idempotency-conflict", "Upload digest does not match receipt.");
    }
    if (receipt.transport !== "resumable" || receipt.status !== "pending") {
      fail("validation", "Upload receipt is not resumable or is no longer pending.");
    }
    if (receipt.multipartUploadId && receipt.multipartUploadId !== input.multipartUploadId) {
      fail("idempotency-conflict", "Upload is already attached to another multipart session.");
    }
    if (!receipt.multipartUploadId) {
      await ctx.db.patch(receipt._id, { multipartUploadId: input.multipartUploadId, updatedAt: Date.now() });
    }
    if (receipt.sessionId) {
      const session = await ctx.db.query("assetUploadSessions")
        .withIndex("by_session", (query) => query.eq("sessionId", receipt.sessionId!))
        .unique();
      if (!session) throw new Error("Upload session is no longer active.");
      if (session.status !== "uploading") fail("validation", "Upload session is no longer active.");
      if (session.multipartUploadId && session.multipartUploadId !== input.multipartUploadId) {
        fail("idempotency-conflict", "Upload session is already attached.");
      }
      await ctx.db.patch(session._id, { multipartUploadId: input.multipartUploadId, updatedAt: Date.now() });
    }
    return { assetKey: receipt.assetKey, r2Key: receipt.r2Key, multipartUploadId: input.multipartUploadId };
  },
});

export const claimUploadPart = mutation({
  args: {
    projectId: v.string(), assetKey: v.string(), sessionId: v.string(),
    partNumber: v.number(), sizeBytes: v.number(),
  },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, input.projectId, userId, ["owner", "editor"]);
    const session = await ctx.db.query("assetUploadSessions")
      .withIndex("by_session", (query) => query.eq("sessionId", input.sessionId)).unique();
    if (!session) throw new Error("Resumable upload session not found.");
    if (session.projectId !== input.projectId || session.assetKey !== input.assetKey
      || session.actorUserId !== userId || session.status !== "uploading") {
      fail("not-found", "Resumable upload session not found.");
    }
    const now = Date.now();
    if (session.expiresAt <= now) fail("validation", "Resumable upload session expired.");
    if (!Number.isInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > session.partCount) {
      fail("invalid-request", "Invalid multipart part number.");
    }
    const expectedSize = input.partNumber === session.partCount
      ? session.sizeBytes - session.partSizeBytes * (session.partCount - 1)
      : session.partSizeBytes;
    if (input.sizeBytes !== expectedSize) fail("validation", "Multipart part geometry is invalid.");
    const existing = await ctx.db.query("assetUploadParts")
      .withIndex("by_upload_part", (query) => query
        .eq("projectId", input.projectId).eq("assetKey", input.assetKey)
        .eq("multipartUploadId", session.multipartUploadId).eq("partNumber", input.partNumber))
      .unique();
    if (existing?.status === "accepted") return { status: "accepted" as const, etag: existing.etag };
    if (existing?.leaseExpiresAt && existing.leaseExpiresAt > now) {
      fail("validation", "Multipart part is already leased.");
    }
    const leaseToken = crypto.randomUUID();
    const value = {
      projectId: input.projectId, assetKey: input.assetKey, multipartUploadId: session.multipartUploadId,
      partNumber: input.partNumber, etag: existing?.etag ?? "", sizeBytes: input.sizeBytes,
      sessionId: input.sessionId, status: "claimed" as const, leaseToken,
      leaseExpiresAt: now + resumableLeaseMs, attempts: (existing?.attempts ?? 0) + 1, nextAttemptAt: now,
      createdAt: existing?.createdAt ?? now,
    };
    if (existing) await ctx.db.patch(existing._id, value);
    else await ctx.db.insert("assetUploadParts", value);
    return { status: "claimed" as const, leaseToken };
  },
});

export const acceptUploadPart = mutation({
  args: {
    projectId: v.string(), assetKey: v.string(), sessionId: v.string(),
    partNumber: v.number(), leaseToken: v.string(), etag: v.string(),
  },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, input.projectId, userId, ["owner", "editor"]);
    const session = await ctx.db.query("assetUploadSessions")
      .withIndex("by_session", (query) => query.eq("sessionId", input.sessionId)).unique();
    if (!session) throw new Error("Resumable upload session not found.");
    if (session.projectId !== input.projectId || session.assetKey !== input.assetKey
      || session.actorUserId !== userId || session.status !== "uploading") {
      fail("not-found", "Resumable upload session not found.");
    }
    if (session.expiresAt <= Date.now()) fail("validation", "Resumable upload session expired.");
    if (input.etag.length < 1 || input.etag.length > 512) fail("invalid-request", "Invalid multipart ETag.");
    const part = await ctx.db.query("assetUploadParts")
      .withIndex("by_upload_part", (query) => query
        .eq("projectId", input.projectId).eq("assetKey", input.assetKey)
        .eq("multipartUploadId", session.multipartUploadId).eq("partNumber", input.partNumber))
      .unique();
    if (!part) throw new Error("Multipart part lease is invalid or expired.");
    if (part.status !== "claimed" || part.leaseToken !== input.leaseToken
      || (part.leaseExpiresAt ?? 0) <= Date.now()) {
      fail("validation", "Multipart part lease is invalid or expired.");
    }
    await ctx.db.patch(part._id, {
      etag: input.etag, status: "accepted", leaseToken: undefined, leaseExpiresAt: undefined,
      nextAttemptAt: undefined,
    });
    await ctx.db.patch(session._id, {
      acceptedBytes: session.acceptedBytes + part.sizeBytes, updatedAt: Date.now(),
    });
    return { accepted: true, etag: input.etag };
  },
});

export const releaseUploadPart = mutation({
  args: {
    projectId: v.string(), assetKey: v.string(), sessionId: v.string(),
    partNumber: v.number(), leaseToken: v.string(),
  },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, input.projectId, userId, ["owner", "editor"]);
    const session = await ctx.db.query("assetUploadSessions")
      .withIndex("by_session", (query) => query.eq("sessionId", input.sessionId)).unique();
    if (!session) return { released: false };
    if (session.projectId !== input.projectId || session.assetKey !== input.assetKey
      || session.actorUserId !== userId) return { released: false };
    const part = await ctx.db.query("assetUploadParts")
      .withIndex("by_upload_part", (query) => query
        .eq("projectId", input.projectId).eq("assetKey", input.assetKey)
        .eq("multipartUploadId", session.multipartUploadId).eq("partNumber", input.partNumber))
      .unique();
    if (!part || part.status !== "claimed" || part.leaseToken !== input.leaseToken) return { released: false };
    await ctx.db.patch(part._id, {
      status: "claimed", leaseToken: undefined, leaseExpiresAt: undefined, nextAttemptAt: Date.now(),
    });
    return { released: true };
  },
});

export const claimResumableCompletion = mutation({
  args: { projectId: v.string(), assetKey: v.string(), sessionId: v.string(), completionToken: v.optional(v.string()) },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, input.projectId, userId, ["owner", "editor"]);
    const session = await ctx.db.query("assetUploadSessions")
      .withIndex("by_session", (query) => query.eq("sessionId", input.sessionId)).unique();
    if (!session) throw new Error("Resumable upload session not found.");
    if (session.projectId !== input.projectId || session.actorUserId !== userId || session.assetKey !== input.assetKey) {
      fail("not-found", "Resumable upload session not found.");
    }
    if (session.expiresAt <= Date.now()) fail("validation", "Resumable upload session expired.");
    if (session.status === "completing" && session.completionToken
      && (session.leaseExpiresAt ?? 0) > Date.now()) {
      if (input.completionToken === session.completionToken) {
        return { ...session, parts: await listAcceptedResumableParts(ctx, session) };
      }
      fail("validation", "Resumable completion is already in progress.");
    }
    if (session.status === "completing" && session.leaseExpiresAt !== undefined) {
      const parts = await listAcceptedResumableParts(ctx, session);
      const completionToken = crypto.randomUUID();
      await ctx.db.patch(session._id, {
        completionToken, leaseToken: completionToken,
        leaseExpiresAt: Date.now() + resumableLeaseMs, updatedAt: Date.now(),
      });
      return { ...session, completionToken, parts };
    }
    if (session.status !== "uploading" || session.acceptedBytes !== session.sizeBytes) {
      fail("validation", "Resumable upload is incomplete.");
    }
    const parts = await listAcceptedResumableParts(ctx, session);
    if (parts.length !== session.partCount) fail("validation", "Resumable upload is missing parts.");
    const completionToken = crypto.randomUUID();
    await ctx.db.patch(session._id, {
      status: "completing", completionToken, leaseToken: completionToken,
      leaseExpiresAt: Date.now() + resumableLeaseMs, updatedAt: Date.now(),
    });
    return { ...session, status: "completing" as const, completionToken, parts };
  },
});

const verificationStateValidator = v.object({
  words: v.array(v.number()),
  totalBytes: v.number(),
  tail: v.array(v.number()),
});

export const beginResumableVerification = mutation({
  args: { projectId: v.string(), assetKey: v.string(), sessionId: v.string(), completionToken: v.string() },
  handler: async (ctx, input) => {
    await requireWorkerIdentity(ctx);
    const session = await ctx.db.query("assetUploadSessions")
      .withIndex("by_session", (query) => query.eq("sessionId", input.sessionId)).unique();
    if (!session || session.projectId !== input.projectId || session.assetKey !== input.assetKey
      ) throw new Error("Resumable upload session not found.");
    if (session.status === "verifying" || session.status === "finalizing") return session;
    if (session.status !== "completing" || session.completionToken !== input.completionToken) {
      fail("validation", "Resumable upload verification is no longer valid.");
    }
    await ctx.db.patch(session._id, {
      status: "verifying",
      verificationOffsetBytes: 0,
      verificationState: {
        words: [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
          0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19],
        totalBytes: 0,
        tail: [],
      },
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      updatedAt: Date.now(),
    });
    return { ...session, status: "verifying" as const, verificationOffsetBytes: 0 };
  },
});

export const claimResumableVerification = mutation({
  args: { projectId: v.string(), assetKey: v.string(), sessionId: v.string(), leaseToken: v.optional(v.string()) },
  handler: async (ctx, input) => {
    await requireWorkerIdentity(ctx);
    const session = await ctx.db.query("assetUploadSessions")
      .withIndex("by_session", (query) => query.eq("sessionId", input.sessionId)).unique();
    if (!session || session.projectId !== input.projectId || session.assetKey !== input.assetKey
      ) throw new Error("Resumable upload session not found.");
    if (session.status !== "verifying") return { status: session.status, claimed: false, session };
    const now = Date.now();
    if ((session.leaseExpiresAt ?? 0) > now && session.leaseToken && input.leaseToken === session.leaseToken) {
      return { status: "verifying" as const, claimed: true, session };
    }
    if ((session.leaseExpiresAt ?? 0) > now && session.leaseToken) {
      return { status: "busy" as const, claimed: false, session };
    }
    const leaseToken = crypto.randomUUID();
    await ctx.db.patch(session._id, {
      leaseToken, leaseExpiresAt: now + resumableLeaseMs, updatedAt: now,
    });
    return {
      status: "verifying" as const,
      claimed: true,
      session: { ...session, leaseToken, leaseExpiresAt: now + resumableLeaseMs },
    };
  },
});

export const advanceResumableVerification = mutation({
  args: {
    projectId: v.string(), assetKey: v.string(), sessionId: v.string(), leaseToken: v.string(),
    offsetBytes: v.number(), state: verificationStateValidator, digest: v.string(),
  },
  handler: async (ctx, input) => {
    await requireWorkerIdentity(ctx);
    const session = await ctx.db.query("assetUploadSessions")
      .withIndex("by_session", (query) => query.eq("sessionId", input.sessionId)).unique();
    if (!session || session.projectId !== input.projectId || session.assetKey !== input.assetKey
      ) throw new Error("Resumable upload session not found.");
    if (session.status !== "verifying" || session.leaseToken !== input.leaseToken
      || (session.leaseExpiresAt ?? 0) <= Date.now()) {
      return { status: "stale" as const, offsetBytes: session.verificationOffsetBytes ?? 0 };
    }
    const offsetBytes = session.verificationOffsetBytes ?? 0;
    if (input.offsetBytes < offsetBytes || input.offsetBytes > session.sizeBytes) {
      fail("validation", "Resumable upload verification offset is invalid.");
    }
    validateResumableVerificationState(input.state, input.offsetBytes, (message) => fail("validation", message));
    if (input.offsetBytes < session.sizeBytes) {
      await ctx.db.patch(session._id, {
        verificationOffsetBytes: input.offsetBytes,
        verificationState: input.state,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        updatedAt: Date.now(),
      });
      return { status: "verifying" as const, offsetBytes: input.offsetBytes };
    }
    if (validDigest(input.digest) !== (await ctx.db.query("assetUploadReceipts")
      .withIndex("by_session", (query) => query.eq("sessionId", session.sessionId)).unique())?.contentSha256) {
      const receipt = await ctx.db.query("assetUploadReceipts")
        .withIndex("by_session", (query) => query.eq("sessionId", session.sessionId)).unique();
      if (receipt && receipt.status === "pending") await ctx.db.patch(receipt._id, { status: "failed", updatedAt: Date.now() });
      const project = await requireProjectRow(ctx, session.projectId);
      await enqueueR2DeleteRows(ctx, {
        projectId: session.projectId, storageNamespace: project.storageNamespace,
        keys: [session.r2Key], kind: "sample",
      });
      await ctx.db.patch(session._id, {
        status: "failed", leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: Date.now(),
      });
      return { status: "failed" as const, offsetBytes: input.offsetBytes };
    }
    await ctx.db.patch(session._id, {
      status: "finalizing", verificationOffsetBytes: input.offsetBytes,
      verificationState: input.state, leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: Date.now(),
    });
    return { status: "finalizing" as const, offsetBytes: input.offsetBytes };
  },
});

export const failResumableVerification = mutation({
  args: { projectId: v.string(), assetKey: v.string(), sessionId: v.string() },
  handler: async (ctx, input) => {
    await requireWorkerIdentity(ctx);
    const session = await ctx.db.query("assetUploadSessions")
      .withIndex("by_session", (query) => query.eq("sessionId", input.sessionId)).unique();
    if (!session || session.projectId !== input.projectId || session.assetKey !== input.assetKey
      || (session.status !== "verifying" && session.status !== "finalizing")) {
      return { failed: false };
    }
    await ctx.db.patch(session._id, {
      status: "failed", leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: Date.now(),
    });
    const receipt = await ctx.db.query("assetUploadReceipts")
      .withIndex("by_session", (query) => query.eq("sessionId", session.sessionId)).unique();
    if (receipt && receipt.status === "pending") {
      await ctx.db.patch(receipt._id, { status: "failed", updatedAt: Date.now() });
    }
    const project = await requireProjectRow(ctx, session.projectId);
    await enqueueR2DeleteRows(ctx, {
      projectId: session.projectId, storageNamespace: project.storageNamespace,
      keys: [session.r2Key], kind: "sample",
    });
    return { failed: true };
  },
});

export const getResumableUpload = query({
  args: { projectId: v.string(), sessionId: v.string() },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, input.projectId, userId, ["owner", "editor"]);
    const session = await ctx.db.query("assetUploadSessions")
      .withIndex("by_session", (query) => query.eq("sessionId", input.sessionId)).unique();
    if (!session || session.projectId !== input.projectId || session.actorUserId !== userId) {
      throw new Error("Resumable upload not found.");
    }
    const receipt = await ctx.db.query("assetUploadReceipts")
      .withIndex("by_session", (query) => query.eq("sessionId", input.sessionId)).unique();
    if (!receipt) throw new Error("Resumable upload receipt not found.");
    if (receipt.status !== "pending" && receipt.status !== "completed" || receipt.transport !== "resumable") {
      fail("validation", "Resumable upload is no longer pending.");
    }
    const parts = await listAcceptedResumableParts(ctx, session);
    return {
      assetKey: receipt.assetKey, r2Key: receipt.r2Key, multipartUploadId: session.multipartUploadId,
      contentSha256: receipt.contentSha256, idempotencyKey: receipt.idempotencyKey,
      sizeBytes: receipt.sizeBytes, mimeType: receipt.mimeType, name: receipt.name,
      sessionId: session.sessionId, partSizeBytes: session.partSizeBytes, partCount: session.partCount,
      acceptedBytes: session.acceptedBytes, status: session.status, expiresAt: session.expiresAt,
      completionToken: session.completionToken, leaseToken: session.leaseToken,
      verificationOffsetBytes: session.verificationOffsetBytes,
      verificationState: session.verificationState, parts,
    };
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
    const failedMultipartUploadId = receipt.multipartUploadId;
    if (failedMultipartUploadId) {
      const parts = await ctx.db.query("assetUploadParts").withIndex("by_upload", (query) => query
        .eq("projectId", receipt.projectId).eq("assetKey", receipt.assetKey)
        .eq("multipartUploadId", failedMultipartUploadId)).collect();
      await Promise.all(parts.map((part) => ctx.db.delete(part._id)));
    }
    const project = await requireProjectRow(ctx, input.projectId);
    await enqueueR2DeleteRows(ctx, {
      projectId: input.projectId, storageNamespace: project.storageNamespace, keys: [receipt.r2Key], kind: "sample",
    });
    return { queued: true };
  },
});

export const failResumableUpload = mutation({
  args: {
    projectId: v.string(), assetKey: v.string(), sessionId: v.string(),
    completionToken: v.string(), contentSha256: v.string(),
  },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, input.projectId, userId, ["owner", "editor"]);
    const session = await ctx.db.query("assetUploadSessions")
      .withIndex("by_session", (query) => query.eq("sessionId", input.sessionId)).unique();
    if (!session || session.actorUserId !== userId || session.assetKey !== input.assetKey
      || session.status !== "completing" || session.completionToken !== input.completionToken
      || session.contentSha256 !== validDigest(input.contentSha256)) {
      return { failed: false };
    }
    await ctx.db.patch(session._id, {
      status: "failed", leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: Date.now(),
    });
    const receipt = await ctx.db.query("assetUploadReceipts")
      .withIndex("by_session", (query) => query.eq("sessionId", session.sessionId)).unique();
    if (receipt && receipt.status === "pending") {
      await ctx.db.patch(receipt._id, { status: "failed", updatedAt: Date.now() });
    }
    const project = await requireProjectRow(ctx, input.projectId);
    await enqueueR2DeleteRows(ctx, {
      projectId: input.projectId, storageNamespace: project.storageNamespace,
      keys: [session.r2Key], kind: "sample",
    });
    return { failed: true };
  },
});

export const abortResumableUpload = mutation({
  args: { projectId: v.string(), assetKey: v.string(), sessionId: v.string() },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, input.projectId, userId, ["owner", "editor"]);
    const session = await ctx.db.query("assetUploadSessions")
      .withIndex("by_session", (query) => query.eq("sessionId", input.sessionId)).unique();
    if (!session || session.projectId !== input.projectId || session.assetKey !== input.assetKey
      || session.actorUserId !== userId || session.status === "completed") {
      return { aborted: false };
    }
    await ctx.db.patch(session._id, {
      status: "aborted", leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: Date.now(),
    });
    const receipt = await ctx.db.query("assetUploadReceipts")
      .withIndex("by_session", (query) => query.eq("sessionId", session.sessionId)).unique();
    if (receipt && receipt.status !== "completed") {
      await ctx.db.patch(receipt._id, { status: "failed", updatedAt: Date.now() });
    }
    const parts = await ctx.db.query("assetUploadParts").withIndex("by_upload", (query) => query
      .eq("projectId", session.projectId).eq("assetKey", session.assetKey)
      .eq("multipartUploadId", session.multipartUploadId)).collect();
    await Promise.all(parts.map((part) => ctx.db.delete(part._id)));
    return { aborted: true };
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
    const multipartUploads: Array<{ r2Key: string; multipartUploadId: string }> = [];
    for (const receipt of receipts) {
      if (receipt.transport === "resumable") continue;
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
      const staleParts = await ctx.db.query("assetUploadParts").withIndex("by_upload", (query) => query
        .eq("projectId", receipt.projectId).eq("assetKey", receipt.assetKey)
        .eq("multipartUploadId", receipt.multipartUploadId ?? "")).collect();
      await Promise.all(staleParts.map((part) => ctx.db.delete(part._id)));
      const project = await requireProjectRow(ctx, receipt.projectId);
      await enqueueR2DeleteRows(ctx, {
        projectId: receipt.projectId, storageNamespace: project.storageNamespace, keys: [receipt.r2Key], kind: "sample",
      });
    }
    return { reconciled: receipts.length, multipartUploads };
  },
});

export const expireResumableSessions = mutation({
  args: { now: v.number(), limit: v.number() },
  handler: async (ctx, input) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity?.dawWorker !== true) throw new Error("Asset reconciliation requires worker access.");
    const expired = (await ctx.db.query("assetUploadSessions")
      .withIndex("by_status_expiresAt", (query) => query.eq("status", "uploading").lte("expiresAt", input.now))
      .take(Math.max(1, Math.min(input.limit, 100))))
      .concat(await ctx.db.query("assetUploadSessions")
        .withIndex("by_status_expiresAt", (query) => query.eq("status", "completing").lte("expiresAt", input.now))
        .take(Math.max(0, Math.min(input.limit, 100))))
      .concat(await ctx.db.query("assetUploadSessions")
        .withIndex("by_status_expiresAt", (query) => query.eq("status", "verifying").lte("expiresAt", input.now))
        .take(Math.max(0, Math.min(input.limit, 100))))
      .concat(await ctx.db.query("assetUploadSessions")
        .withIndex("by_status_expiresAt", (query) => query.eq("status", "finalizing").lte("expiresAt", input.now))
        .take(Math.max(0, Math.min(input.limit, 100))))
      .slice(0, Math.max(1, Math.min(input.limit, 100)));
    const multipartUploads: Array<{ r2Key: string; multipartUploadId: string }> = [];
    for (const session of expired) {
      await ctx.db.patch(session._id, {
        status: "failed", updatedAt: input.now, leaseToken: undefined, leaseExpiresAt: undefined,
      });
      const receipt = await ctx.db.query("assetUploadReceipts")
        .withIndex("by_session", (query) => query.eq("sessionId", session.sessionId)).unique();
      if (receipt && receipt.status === "pending") {
        await ctx.db.patch(receipt._id, { status: "failed", updatedAt: input.now });
      }
      if (session.multipartUploadId) multipartUploads.push({
        r2Key: session.r2Key, multipartUploadId: session.multipartUploadId,
      });
      const parts = await ctx.db.query("assetUploadParts").withIndex("by_upload", (query) => query
        .eq("projectId", session.projectId).eq("assetKey", session.assetKey)
        .eq("multipartUploadId", session.multipartUploadId)).collect();
      await Promise.all(parts.map((part) => ctx.db.delete(part._id)));
      const project = await requireProjectRow(ctx, session.projectId);
      await enqueueR2DeleteRows(ctx, {
        projectId: session.projectId, storageNamespace: project.storageNamespace,
        keys: [session.r2Key], kind: "sample",
      });
    }
    const uploadsByProject = new Map<string, Array<{ r2Key: string; multipartUploadId: string }>>();
    for (const session of expired) {
      if (!session.multipartUploadId) continue;
      const uploads = uploadsByProject.get(session.projectId) ?? [];
      uploads.push({ r2Key: session.r2Key, multipartUploadId: session.multipartUploadId });
      uploadsByProject.set(session.projectId, uploads);
    }
    for (const [projectId, uploads] of uploadsByProject) {
      const project = await requireProjectRow(ctx, projectId);
      await enqueueMultipartAbortRows(ctx, {
        projectId,
        storageNamespace: project.storageNamespace,
        uploads,
      });
    }
    return { expired: expired.length, multipartUploads };
  },
});
