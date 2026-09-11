import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import { enqueueR2DeleteRows, hasR2DeleteRow } from "./r2Deletes";

const projectId = "project-assets";
const owner = "asset-owner";
const digest = "a".repeat(64);
const audioMetadata = { durationSec: 1, sampleRate: 44_100, channelCount: 2 };
const controlIdentity = {
  subject: owner,
  dawControlActorIssuer: "https://control.example",
  dawControlActorTokenIdentifier: "token-assets",
};
const workerIdentity = {
  subject: "maintenance-worker",
  dawWorker: true,
  tokenIdentifier: "worker-assets",
};

const modules = {
  "./_generated/api.ts": () => import("./_generated/api"),
  "./assets.ts": () => import("./assets"),
  "./resumableAssetUploads.ts": () => import("./resumableAssetUploads"),
  "./projects.ts": () => import("./projects"),
  "./projectAccess.ts": () => import("./projectAccess"),
  "./projectRows.ts": () => import("./projectRows"),
  "./sampleRows.ts": () => import("./sampleRows"),
  "./r2Deletes.ts": () => import("./r2Deletes"),
};

const setup = async () => {
  const t = convexTest(schema, modules);
  await t.withIdentity({ subject: owner }).mutation(api.projects.createOwnedRoom, { projectId });
  return t;
};

const begin = (t: Awaited<ReturnType<typeof setup>>, idempotencyKey = "asset-key-1") => (
  t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.beginUpload, {
    projectId, idempotencyKey, contentSha256: digest, name: "Kick.wav", mimeType: "audio/wav", sizeBytes: 12, ...audioMetadata,
  })
);

test("asset receipts replay deterministically and finalize exactly once", async () => {
  const t = await setup();
  const first = await begin(t);
  const replay = await begin(t);
  expect(replay).toEqual(first);
  await expect(t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.beginUpload, {
    projectId, idempotencyKey: "asset-key-1", contentSha256: "b".repeat(64), name: "Kick.wav", mimeType: "audio/wav", sizeBytes: 12, ...audioMetadata,
  })).rejects.toThrow("Idempotency key");
  const finalized = await t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.finalizeUpload, {
    projectId, idempotencyKey: "asset-key-1", contentSha256: digest,
  });
  expect(finalized.idempotencyReplay).toBe(false);
  expect(finalized.asset).toMatchObject({
    durationSec: 1,
    sampleRate: 44_100,
    channelCount: 2,
  });
  expect((await t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.finalizeUpload, {
    projectId, idempotencyKey: "asset-key-1", contentSha256: digest,
  })).idempotencyReplay).toBe(true);
  expect((await t.run(async (ctx) => await ctx.db.query("projects")
    .withIndex("by_room", (query) => query.eq("projectId", projectId)).unique()))?.revision).toBe(1);
});

test("rejects asset sizes above the canonical multipart file limit", async () => {
  const t = await setup();
  const sizeBytes = 10 * 1024 * 1024 + 1;
  await expect(t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.beginUpload, {
    projectId,
    idempotencyKey: "large-asset-key",
    contentSha256: digest,
    name: "Large.wav",
    mimeType: "audio/wav",
    sizeBytes,
    ...audioMetadata,
  })).rejects.toThrow("10 MiB");
});

test("rejects non-safe asset sizes in the canonical mutation", async () => {
  const t = await setup();
  await expect(t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.beginUpload, {
    projectId,
    idempotencyKey: "unsafe-size-key",
    contentSha256: digest,
    name: "Unsafe.wav",
    mimeType: "audio/wav",
    sizeBytes: Number.MAX_SAFE_INTEGER + 1,
    ...audioMetadata,
  })).rejects.toThrow("Asset size is invalid");
});

test("tracks resumable uploads without the V1 size cap", async () => {
  const t = await setup();
  const sizeBytes = 20 * 1024 * 1024;
  const resumable = await t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.beginUpload, {
    projectId,
    idempotencyKey: "resumable-asset-key",
    contentSha256: digest,
    name: "Long.wav",
    mimeType: "audio/wav",
    sizeBytes,
    transport: "resumable",
    ...audioMetadata,
  });
  expect(resumable.assetKey).toStartWith("asset-");
  const attached = await t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.attachMultipartUpload, {
    projectId,
    idempotencyKey: "resumable-asset-key",
    contentSha256: digest,
    multipartUploadId: "upload-1",
  });
  expect(attached.multipartUploadId).toBe("upload-1");
});

test("accepts a logical upload above 4 GiB without allocating its bytes", async () => {
  const t = await setup();
  const sizeBytes = 4 * 1024 * 1024 * 1024 + 1;
  const begun = await t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.beginUpload, {
    projectId,
    idempotencyKey: "resumable-four-gib-key",
    contentSha256: digest,
    name: "Four-GiB-plus-one.wav",
    mimeType: "audio/wav",
    sizeBytes,
    transport: "resumable",
  });
  expect(begun.sessionId).toBeDefined();
  expect(await t.run(async (ctx) => {
    const session = await ctx.db.query("assetUploadSessions")
      .withIndex("by_session", (query) => query.eq("sessionId", begun.sessionId ?? "")).unique();
    return session?.partCount;
  })).toBe(513);
  const attached = await t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.attachMultipartUpload, {
    projectId,
    idempotencyKey: "resumable-four-gib-key",
    contentSha256: digest,
    multipartUploadId: "upload-four-gib",
  });
  const claim = await t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.claimUploadPart, {
    projectId, assetKey: attached.assetKey, sessionId: begun.sessionId ?? "",
    partNumber: 1, sizeBytes: 8 * 1024 * 1024,
  });
  expect(claim.status).toBe("claimed");
  await expect(t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.claimUploadPart, {
    projectId, assetKey: attached.assetKey, sessionId: begun.sessionId ?? "",
    partNumber: 1, sizeBytes: 8 * 1024 * 1024,
  })).rejects.toThrow("already leased");
});
test("resumable sessions own part geometry, leases, and completion parts", async () => {
  const t = await setup();
  const partSizeBytes = 8 * 1024 * 1024;
  const sizeBytes = partSizeBytes + 12;
  const begun = await t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.beginUpload, {
    projectId,
    idempotencyKey: "resumable-session-key",
    contentSha256: digest,
    name: "Authoritative.wav",
    mimeType: "audio/wav",
    sizeBytes,
    transport: "resumable",
  });
  expect(begun.sessionId).toBeDefined();
  const attached = await t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.attachMultipartUpload, {
    projectId,
    idempotencyKey: "resumable-session-key",
    contentSha256: digest,
    multipartUploadId: "upload-session-1",
  });
  await expect(t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.claimUploadPart, {
    projectId, assetKey: attached.assetKey, sessionId: begun.sessionId ?? "",
    partNumber: 1, sizeBytes: 12,
  })).rejects.toThrow("geometry");
  const first = await t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.claimUploadPart, {
    projectId, assetKey: attached.assetKey, sessionId: begun.sessionId ?? "",
    partNumber: 1, sizeBytes: partSizeBytes,
  });
  expect(first.status).toBe("claimed");
  if (first.status !== "claimed") throw new Error("Expected a part lease.");
  await t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.acceptUploadPart, {
    projectId, assetKey: attached.assetKey, sessionId: begun.sessionId ?? "",
    partNumber: 1, leaseToken: first.leaseToken, etag: "etag-session-1",
  });
  const second = await t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.claimUploadPart, {
    projectId, assetKey: attached.assetKey, sessionId: begun.sessionId ?? "",
    partNumber: 2, sizeBytes: 12,
  });
  expect(second.status).toBe("claimed");
  if (second.status !== "claimed") throw new Error("Expected a second part lease.");
  await t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.acceptUploadPart, {
    projectId, assetKey: attached.assetKey, sessionId: begun.sessionId ?? "",
    partNumber: 2, leaseToken: second.leaseToken, etag: "etag-session-2",
  });
  const completion = await t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.claimResumableCompletion, {
    projectId, assetKey: attached.assetKey, sessionId: begun.sessionId ?? "",
  });
  expect(completion.parts).toEqual([
    { partNumber: 1, etag: "etag-session-1", sizeBytes: partSizeBytes },
    { partNumber: 2, etag: "etag-session-2", sizeBytes: 12 },
  ]);
  await expect(t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.claimResumableCompletion, {
    projectId, assetKey: attached.assetKey, sessionId: begun.sessionId ?? "",
  })).rejects.toThrow("already in progress");
});

test("trusted resumable verification and finalization reject browser identities", async () => {
  const t = await setup();
  const begun = await t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.beginUpload, {
    projectId,
    idempotencyKey: "worker-boundary-key",
    contentSha256: digest,
    name: "Worker-boundary.wav",
    mimeType: "audio/wav",
    sizeBytes: 8 * 1024 * 1024,
    transport: "resumable",
  });
  const sessionId = begun.sessionId ?? "";
  const assetKey = begun.assetKey;
  await t.run(async (ctx) => {
    const session = await ctx.db.query("assetUploadSessions")
      .withIndex("by_session", (query) => query.eq("sessionId", sessionId)).unique();
    if (!session) throw new Error("Expected resumable session.");
    await ctx.db.patch(session._id, {
      status: "completing",
      completionToken: "completion-token",
      multipartUploadId: "multipart-worker-boundary",
    });
  });
  await expect(t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.beginResumableVerification, {
    projectId, assetKey, sessionId, completionToken: "completion-token",
  })).rejects.toThrow("Worker access required");
  await expect(t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.finalizeUpload, {
    projectId, assetKey, sessionId, completionToken: "completion-token", contentSha256: digest,
    durationSec: 1, sampleRate: 44_100, channelCount: 1,
  })).rejects.toThrow("Worker access required");
  await expect(t.withIdentity(workerIdentity).mutation(api.resumableAssetUploads.beginResumableVerification, {
    projectId, assetKey, sessionId, completionToken: "completion-token",
  })).resolves.toMatchObject({ status: "verifying" });
});

test("worker finalization binds persisted resumable state and preserves actor ownership", async () => {
  const t = await setup();
  const begun = await t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.beginUpload, {
    projectId,
    idempotencyKey: "worker-finalize-key",
    contentSha256: digest,
    name: "Worker-finalize.wav",
    mimeType: "audio/wav",
    sizeBytes: 8 * 1024 * 1024,
    transport: "resumable",
  });
  const sessionId = begun.sessionId ?? "";
  await t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.attachMultipartUpload, {
    projectId, idempotencyKey: "worker-finalize-key", contentSha256: digest,
    multipartUploadId: "multipart-worker-finalize",
  });
  await t.run(async (ctx) => {
    const session = await ctx.db.query("assetUploadSessions")
      .withIndex("by_session", (query) => query.eq("sessionId", sessionId)).unique();
    if (!session) throw new Error("Expected resumable session.");
    await ctx.db.patch(session._id, { status: "finalizing", completionToken: "finalize-token" });
  });
  await expect(t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.finalizeUpload, {
    projectId, idempotencyKey: "worker-finalize-key", contentSha256: digest,
    durationSec: 1, sampleRate: 44_100, channelCount: 1,
  })).rejects.toThrow("Worker access required");
  const finalized = await t.withIdentity(workerIdentity).mutation(api.resumableAssetUploads.finalizeUpload, {
    projectId, assetKey: begun.assetKey, sessionId, multipartUploadId: "multipart-worker-finalize",
    completionToken: "finalize-token", contentSha256: digest,
    durationSec: 1, sampleRate: 44_100, channelCount: 1,
  });
  expect(finalized.asset).toMatchObject({ sizeBytes: 8 * 1024 * 1024 });
  expect(await t.run(async (ctx) => {
    const asset = await ctx.db.query("samples").withIndex("by_room", (query) => query.eq("projectId", projectId)).unique();
    return asset?.ownerUserId;
  })).toBe(owner);
});

test("resumable sessions reject expired claims and accept leases", async () => {
  const t = await setup();
  const begun = await t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.beginUpload, {
    projectId,
    idempotencyKey: "expired-resumable-key",
    contentSha256: digest,
    name: "Expired.wav",
    mimeType: "audio/wav",
    sizeBytes: 8 * 1024 * 1024,
    transport: "resumable",
  });
  const attached = await t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.attachMultipartUpload, {
    projectId, idempotencyKey: "expired-resumable-key", contentSha256: digest,
    multipartUploadId: "expired-upload",
  });
  await t.run(async (ctx) => {
    const session = await ctx.db.query("assetUploadSessions")
      .withIndex("by_session", (query) => query.eq("sessionId", begun.sessionId ?? "")).unique();
    if (!session) throw new Error("Expected resumable session.");
    await ctx.db.patch(session._id, { expiresAt: Date.now() - 1 });
  });
  await expect(t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.claimUploadPart, {
    projectId, assetKey: attached.assetKey, sessionId: begun.sessionId ?? "",
    partNumber: 1, sizeBytes: 8 * 1024 * 1024,
  })).rejects.toThrow("expired");
});

test("resumable sessions enforce active actor quotas", async () => {
  const t = await setup();
  for (let index = 1; index <= 4; index += 1) {
    await t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.beginUpload, {
      projectId,
      idempotencyKey: `quota-resumable-${index}`,
      contentSha256: digest,
      name: `Quota-${index}.wav`,
      mimeType: "audio/wav",
      sizeBytes: 8 * 1024 * 1024,
      transport: "resumable",
    });
  }
  await expect(t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.beginUpload, {
    projectId,
    idempotencyKey: "quota-resumable-5",
    contentSha256: digest,
    name: "Quota-5.wav",
    mimeType: "audio/wav",
    sizeBytes: 8 * 1024 * 1024,
    transport: "resumable",
  })).rejects.toThrow("User resumable upload quota");
});

test("resumable quotas reject bounded reads when active rows exceed the project limit", async () => {
  const t = await setup();
  await t.run(async (ctx) => {
    for (let index = 1; index <= 9; index += 1) {
      await ctx.db.insert("assetUploadSessions", {
        sessionId: `bounded-quota-session-${index}`,
        projectId,
        actorUserId: owner,
        idempotencyKey: `bounded-quota-key-${index}`,
        contentSha256: digest,
        assetKey: `bounded-quota-asset-${index}`,
        r2Key: `bounded-quota-r2-${index}`,
        multipartUploadId: "",
        name: `Bounded-${index}.wav`,
        mimeType: "audio/wav",
        sizeBytes: 8 * 1024 * 1024,
        partSizeBytes: 8 * 1024 * 1024,
        partCount: 1,
        acceptedBytes: 0,
        status: "uploading",
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  });
  await expect(t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.beginUpload, {
    projectId,
    idempotencyKey: "bounded-quota-new",
    contentSha256: digest,
    name: "Bounded-new.wav",
    mimeType: "audio/wav",
    sizeBytes: 8 * 1024 * 1024,
    transport: "resumable",
  })).rejects.toThrow("Project resumable upload quota");
});

test("receipt replay rejects trusted metadata drift", async () => {
  const t = await setup();
  await begin(t);
  await expect(t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.beginUpload, {
    projectId,
    idempotencyKey: "asset-key-1",
    contentSha256: digest,
    name: "Kick.wav",
    mimeType: "audio/wav",
    sizeBytes: 12,
    durationSec: 2,
    sampleRate: 44_100,
    channelCount: 2,
  })).rejects.toThrow("Idempotency key");
});

test("legacy upload receipts fail closed until restarted", async () => {
  const t = await setup();
  await t.run(async (ctx) => {
    await ctx.db.insert("assetUploadReceipts", {
      projectId,
      actorUserId: owner,
      idempotencyKey: "legacy-key",
      contentSha256: digest,
      assetKey: "legacy-asset",
      r2Key: "asset-namespaces/legacy/samples/legacy",
      semanticDigest: "legacy",
      status: "pending",
      mimeType: "audio/wav",
      sizeBytes: 12,
      name: "Legacy.wav",
      createdAt: 1,
      updatedAt: 1,
      attempts: 0,
    });
  });
  await expect(t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.beginUpload, {
    projectId,
    idempotencyKey: "legacy-key",
    contentSha256: digest,
    name: "Legacy.wav",
    mimeType: "audio/wav",
    sizeBytes: 12,
    ...audioMetadata,
  })).rejects.toThrow("legacy upload receipt");
  await expect(t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.finalizeUpload, {
    projectId, idempotencyKey: "legacy-key", contentSha256: digest,
  })).rejects.toThrow("Legacy upload receipt metadata");
});

test("stale legacy receipts backfill metadata from completed samples", async () => {
  const t = await setup();
  await t.run(async (ctx) => {
    await ctx.db.insert("assetUploadReceipts", {
      projectId,
      actorUserId: owner,
      idempotencyKey: "legacy-reconcile",
      contentSha256: digest,
      assetKey: "legacy-reconcile-asset",
      r2Key: "asset-namespaces/legacy/samples/reconcile",
      semanticDigest: "legacy",
      status: "pending",
      mimeType: "audio/wav",
      sizeBytes: 12,
      name: "Legacy.wav",
      createdAt: 1,
      updatedAt: 1,
      attempts: 0,
    });
    await ctx.db.insert("samples", {
      projectId,
      assetKey: "legacy-reconcile-asset",
      sourceKind: "upload",
      name: "Legacy.wav",
      mimeType: "audio/wav",
      sizeBytes: 12,
      contentSha256: digest,
      r2Key: "asset-namespaces/legacy/samples/reconcile",
      duration: 2,
      sampleRate: 48_000,
      channelCount: 1,
      ownerUserId: owner,
      createdAt: 1,
      updatedAt: 1,
    });
  });
  await t.withIdentity({ subject: "worker", dawWorker: true, tokenIdentifier: "worker-assets" })
    .mutation(api.resumableAssetUploads.reconcileStalePending, { before: Date.now(), limit: 10 });
  expect(await t.run(async (ctx) => await ctx.db.query("assetUploadReceipts").first())).toMatchObject({
    status: "completed",
    durationSec: 2,
    sampleRate: 48_000,
    channelCount: 1,
  });
});

test("folders have material revisions and cannot delete nonempty contents", async () => {
  const t = await setup();
  const folder = await t.withIdentity(controlIdentity).mutation(api.assets.createFolder, { projectId, name: "Drums" });
  expect((await t.withIdentity(controlIdentity).mutation(api.assets.renameFolder, {
    projectId, folderId: folder.folder.id, name: "Drums",
  })).applied).toBe(false);
  await begin(t);
  const uploaded = await t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.finalizeUpload, {
    projectId, idempotencyKey: "asset-key-1", contentSha256: digest,
  });
  await t.withIdentity(controlIdentity).mutation(api.assets.moveAssetToFolder, {
    projectId, assetKey: uploaded.asset.id, folderId: folder.folder.id,
  });
  await expect(t.withIdentity(controlIdentity).mutation(api.assets.deleteFolder, {
    projectId, folderId: folder.folder.id,
  })).rejects.toThrow("empty");
  await expect(t.withIdentity(controlIdentity).mutation(api.assets.deleteAsset, {
    projectId, assetKey: uploaded.asset.id,
  })).resolves.toEqual({ deleted: true });
});

test("failed receipts retry only with the same full request metadata", async () => {
  const t = await setup();
  await begin(t);
  expect((await t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.failUpload, {
    projectId, idempotencyKey: "asset-key-1", contentSha256: digest,
  })).queued).toBe(true);
  expect((await begin(t)).status).toBe("pending");
  await expect(t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.beginUpload, {
    projectId, idempotencyKey: "asset-key-1", contentSha256: digest, name: "Other.wav", mimeType: "audio/wav", sizeBytes: 12, ...audioMetadata,
  })).rejects.toThrow("Idempotency key");
});

test("retry keeps a fetched old-key deletion from deleting the new object", async () => {
  const t = await setup();
  const begun = await begin(t);
  const bucket = new Map([[begun.r2Key, "old content"]]);
  await t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.failUpload, {
    projectId, idempotencyKey: "asset-key-1", contentSha256: digest,
  });
  const fetchedDeleteRow = await t.run(async (ctx) => await ctx.db.query("r2DeleteQueue")
    .withIndex("by_key", (query) => query.eq("r2Key", begun.r2Key)).first());
  if (!fetchedDeleteRow) throw new Error("Expected old upload cleanup row.");
  const retried = await begin(t);
  expect(retried.assetKey).toBe(begun.assetKey);
  expect(retried.r2Key).not.toBe(begun.r2Key);
  bucket.set(retried.r2Key, "new content");
  expect(await t.run(async (ctx) => await ctx.db.query("r2DeleteQueue")
    .withIndex("by_key", (query) => query.eq("r2Key", begun.r2Key)).first())).not.toBeNull();
  await t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.finalizeUpload, {
    projectId, idempotencyKey: "asset-key-1", contentSha256: digest,
  });
  bucket.delete(fetchedDeleteRow.r2Key);
  const sample = await t.run(async (ctx) => await ctx.db.query("samples")
    .withIndex("by_room_assetKey", (query) => query.eq("projectId", projectId).eq("assetKey", begun.assetKey)).unique());
  expect(sample?.r2Key).toBe(retried.r2Key);
  expect(bucket.get(sample?.r2Key ?? "")).toBe("new content");
});

test("finalization preserves the asset cap under concurrent pending receipts", async () => {
  const t = await setup();
  await t.run(async (ctx) => {
    for (let index = 0; index < 999; index += 1) {
      await ctx.db.insert("samples", {
        projectId,
        assetKey: `existing-${index}`,
        sourceKind: "upload",
        ownerUserId: owner,
        name: "Existing.wav",
        mimeType: "audio/wav",
        sizeBytes: 1,
        contentSha256: digest,
        r2Key: `asset-namespaces/test/existing-${index}`,
        createdAt: index,
        updatedAt: index,
      });
    }
  });
  await begin(t, "asset-key-1");
  await begin(t, "asset-key-2");
  const results = await Promise.allSettled([
    t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.finalizeUpload, {
      projectId, idempotencyKey: "asset-key-1", contentSha256: digest,
    }),
    t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.finalizeUpload, {
      projectId, idempotencyKey: "asset-key-2", contentSha256: digest,
    }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect((await t.withIdentity(controlIdentity).query(api.assets.listByProject, { projectId, limit: 1_000 }))).toHaveLength(1_000);
  expect((await t.run(async (ctx) => await ctx.db.query("projects")
    .withIndex("by_room", (query) => query.eq("projectId", projectId)).unique()))?.revision).toBe(1);
});

test("failed uploads protect their folders until retried", async () => {
  const t = await setup();
  const folder = await t.withIdentity(controlIdentity).mutation(api.assets.createFolder, { projectId, name: "Drums" });
  await t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.beginUpload, {
    projectId, idempotencyKey: "asset-key-1", contentSha256: digest, name: "Kick.wav", mimeType: "audio/wav", sizeBytes: 12, ...audioMetadata,
    folderId: folder.folder.id,
  });
  await t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.failUpload, {
    projectId, idempotencyKey: "asset-key-1", contentSha256: digest,
  });
  await expect(t.withIdentity(controlIdentity).mutation(api.assets.deleteFolder, {
    projectId, folderId: folder.folder.id,
  })).rejects.toThrow("retryable");
  await expect(t.withIdentity(controlIdentity).mutation(api.resumableAssetUploads.beginUpload, {
    projectId, idempotencyKey: "asset-key-1", contentSha256: digest, name: "Kick.wav", mimeType: "audio/wav", sizeBytes: 12, ...audioMetadata,
    folderId: folder.folder.id,
  })).resolves.toMatchObject({ status: "pending" });
});

test("R2 deletion rows claim atomically, complete, and reactivate from tombstones", async () => {
  const t = await setup();
  const project = await t.run(async (ctx) => await ctx.db.query("projects")
    .withIndex("by_room", (query) => query.eq("projectId", projectId)).unique());
  if (!project) throw new Error("Project missing.");
  const r2Key = `asset-namespaces/${project.storageNamespace}/samples/recovery-queue-test`;
  await t.run(async (ctx) => {
    await enqueueR2DeleteRows(ctx, {
      projectId,
      storageNamespace: project.storageNamespace,
      keys: [r2Key],
      kind: "sample",
    });
  });
  const worker = { subject: "worker", tokenIdentifier: "worker-token", dawWorker: true };
  const due = await t.withIdentity(worker).query(api.r2Deletes.listDue, { projectId, now: Date.now(), limit: 10 });
  expect(due).toHaveLength(1);
  const claimed = await t.withIdentity(worker).mutation(api.r2Deletes.claimRows, {
    projectId, ids: due.map((row) => row._id), now: Date.now(),
  });
  expect(claimed).toHaveLength(1);
  expect((await t.withIdentity(worker).mutation(api.r2Deletes.claimRows, {
    projectId, ids: due.map((row) => row._id), now: Date.now(),
  }))).toEqual([]);
  await t.withIdentity(worker).mutation(api.r2Deletes.markDeleted, {
    projectId,
    claims: claimed.flatMap((row) => row.claimToken ? [{ id: row._id, claimToken: row.claimToken }] : []),
  });
  expect(await t.run(async (ctx) => await hasR2DeleteRow(ctx, { projectId, r2Key }))).toBe(false);
  await t.run(async (ctx) => {
    await enqueueR2DeleteRows(ctx, {
      projectId,
      storageNamespace: project.storageNamespace,
      keys: [r2Key],
      kind: "sample",
    });
  });
  expect(await t.run(async (ctx) => await hasR2DeleteRow(ctx, { projectId, r2Key }))).toBe(true);
});

test("expired R2 claims are re-leased and reject stale completion", async () => {
  const t = await setup();
  const project = await t.run(async (ctx) => await ctx.db.query("projects")
    .withIndex("by_room", (query) => query.eq("projectId", projectId)).unique());
  if (!project) throw new Error("Project missing.");
  const r2Key = `asset-namespaces/${project.storageNamespace}/samples/stale-claim`;
  await t.run(async (ctx) => await enqueueR2DeleteRows(ctx, {
    projectId, storageNamespace: project.storageNamespace, keys: [r2Key], kind: "sample",
  }));
  const worker = { subject: "worker", tokenIdentifier: "worker-token", dawWorker: true };
  const now = Date.now();
  const first = await t.withIdentity(worker).mutation(api.r2Deletes.claimRows, {
    projectId,
    ids: (await t.withIdentity(worker).query(api.r2Deletes.listDue, { projectId, now, limit: 1 })).map((row) => row._id),
    now,
  });
  const original = first[0];
  if (!original?.claimToken) throw new Error("Expected initial claim.");
  const reclaimed = await t.withIdentity(worker).mutation(api.r2Deletes.claimRows, {
    projectId, ids: [original._id], now: now + 5 * 60 * 1000,
  });
  const current = reclaimed[0];
  if (!current?.claimToken) throw new Error("Expected reclaimed claim.");
  await t.withIdentity(worker).mutation(api.r2Deletes.markDeleted, {
    projectId, claims: [{ id: original._id, claimToken: original.claimToken }],
  });
  const row = await t.run(async (ctx) => await ctx.db.get(original._id));
  expect(row?.status).toBe("claimed");
  expect(row?.claimToken).toBe(current.claimToken);
});
