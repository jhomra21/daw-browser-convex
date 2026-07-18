import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";

const projectId = "project-assets";
const owner = "asset-owner";
const digest = "a".repeat(64);
const controlIdentity = {
  subject: owner,
  dawControlActorIssuer: "https://control.example",
  dawControlActorTokenIdentifier: "token-assets",
};

const modules = {
  "./_generated/api.ts": () => import("./_generated/api"),
  "./assets.ts": () => import("./assets"),
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
  t.withIdentity(controlIdentity).mutation(api.assets.beginUpload, {
    projectId, idempotencyKey, contentSha256: digest, name: "Kick.wav", mimeType: "audio/wav", sizeBytes: 12,
  })
);

test("asset receipts replay deterministically and finalize exactly once", async () => {
  const t = await setup();
  const first = await begin(t);
  const replay = await begin(t);
  expect(replay).toEqual(first);
  await expect(t.withIdentity(controlIdentity).mutation(api.assets.beginUpload, {
    projectId, idempotencyKey: "asset-key-1", contentSha256: "b".repeat(64), name: "Kick.wav", mimeType: "audio/wav", sizeBytes: 12,
  })).rejects.toThrow("Idempotency key");
  const finalized = await t.withIdentity(controlIdentity).mutation(api.assets.finalizeUpload, {
    projectId, idempotencyKey: "asset-key-1", contentSha256: digest,
  });
  expect(finalized.idempotencyReplay).toBe(false);
  expect((await t.withIdentity(controlIdentity).mutation(api.assets.finalizeUpload, {
    projectId, idempotencyKey: "asset-key-1", contentSha256: digest,
  })).idempotencyReplay).toBe(true);
  expect((await t.run(async (ctx) => await ctx.db.query("projects")
    .withIndex("by_room", (query) => query.eq("projectId", projectId)).unique()))?.revision).toBe(1);
});

test("folders have material revisions and cannot delete nonempty contents", async () => {
  const t = await setup();
  const folder = await t.withIdentity(controlIdentity).mutation(api.assets.createFolder, { projectId, name: "Drums" });
  expect((await t.withIdentity(controlIdentity).mutation(api.assets.renameFolder, {
    projectId, folderId: folder.folder.id, name: "Drums",
  })).applied).toBe(false);
  await begin(t);
  const uploaded = await t.withIdentity(controlIdentity).mutation(api.assets.finalizeUpload, {
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
  expect((await t.withIdentity(controlIdentity).mutation(api.assets.failUpload, {
    projectId, idempotencyKey: "asset-key-1", contentSha256: digest,
  })).queued).toBe(true);
  expect((await begin(t)).status).toBe("pending");
  await expect(t.withIdentity(controlIdentity).mutation(api.assets.beginUpload, {
    projectId, idempotencyKey: "asset-key-1", contentSha256: digest, name: "Other.wav", mimeType: "audio/wav", sizeBytes: 12,
  })).rejects.toThrow("Idempotency key");
});

test("retry keeps a fetched old-key deletion from deleting the new object", async () => {
  const t = await setup();
  const begun = await begin(t);
  const bucket = new Map([[begun.r2Key, "old content"]]);
  await t.withIdentity(controlIdentity).mutation(api.assets.failUpload, {
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
  await t.withIdentity(controlIdentity).mutation(api.assets.finalizeUpload, {
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
    t.withIdentity(controlIdentity).mutation(api.assets.finalizeUpload, {
      projectId, idempotencyKey: "asset-key-1", contentSha256: digest,
    }),
    t.withIdentity(controlIdentity).mutation(api.assets.finalizeUpload, {
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
  await t.withIdentity(controlIdentity).mutation(api.assets.beginUpload, {
    projectId, idempotencyKey: "asset-key-1", contentSha256: digest, name: "Kick.wav", mimeType: "audio/wav", sizeBytes: 12,
    folderId: folder.folder.id,
  });
  await t.withIdentity(controlIdentity).mutation(api.assets.failUpload, {
    projectId, idempotencyKey: "asset-key-1", contentSha256: digest,
  });
  await expect(t.withIdentity(controlIdentity).mutation(api.assets.deleteFolder, {
    projectId, folderId: folder.folder.id,
  })).rejects.toThrow("retryable");
  await expect(t.withIdentity(controlIdentity).mutation(api.assets.beginUpload, {
    projectId, idempotencyKey: "asset-key-1", contentSha256: digest, name: "Kick.wav", mimeType: "audio/wav", sizeBytes: 12,
    folderId: folder.folder.id,
  })).resolves.toMatchObject({ status: "pending" });
});
