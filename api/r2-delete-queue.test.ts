import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { drainR2DeleteRows } from "./r2-delete-queue";

const modules = {
  "./_generated/api.ts": () => import("../convex/_generated/api"),
  "./r2Deletes.ts": () => import("../convex/r2Deletes"),
};

test("project prefix drain paginates and keeps failed prefix rows independent", async () => {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const rows = await t.run(async (ctx) => {
    const firstPrefix = await ctx.db.insert("r2DeleteQueue", {
      projectId: "project-1",
      r2Key: "asset-namespaces/namespace-1/",
      kind: "project-prefix",
      attempts: 0,
      nextAttemptAt: now,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    const secondPrefix = await ctx.db.insert("r2DeleteQueue", {
      projectId: "project-1",
      r2Key: "projects/project-1/",
      kind: "project-prefix",
      attempts: 0,
      nextAttemptAt: now,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("r2DeleteQueue", {
      projectId: "project-1",
      r2Key: "asset-namespaces/namespace-1/sample",
      kind: "sample",
      attempts: 0,
      nextAttemptAt: now,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("r2DeleteQueue", {
      projectId: "project-1",
      r2Key: "projects/project-1/export",
      kind: "export",
      attempts: 0,
      nextAttemptAt: now,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("r2DeleteQueue", {
      projectId: "project-1",
      r2Key: "projects/project-1/object-a",
      kind: "sample",
      attempts: 0,
      nextAttemptAt: now,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("r2DeleteQueue", {
      projectId: "project-1",
      r2Key: "projects/project-1/object-b",
      kind: "sample",
      attempts: 0,
      nextAttemptAt: now,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    return { firstPrefix, secondPrefix };
  });
  const deletedObjects = new Set<string>();
  const listCalls: string[] = [];
  const bucket = {
    list: async ({ prefix, cursor }: { prefix: string; cursor?: string }) => {
      listCalls.push(`${prefix}:${cursor ?? ""}`);
      if (prefix === "projects/project-1/") throw new Error("projects prefix unavailable");
      return cursor
        ? { objects: [{ key: `${prefix}second` }], truncated: false }
        : { objects: [{ key: `${prefix}first` }], truncated: true, cursor: "next" };
    },
    delete: async (keys: string[]) => {
      for (const key of keys) deletedObjects.add(key);
    },
  };
  const worker = t.withIdentity({ subject: "worker", tokenIdentifier: "token", dawWorker: true });
  const result = await drainR2DeleteRows({
    convex: worker,
    bucket,
    rows: await t.run(async (ctx) => await ctx.db.query("r2DeleteQueue").collect()),
  });

  expect(result).toMatchObject({ processed: 6, deleted: 2 });
  expect(listCalls.sort()).toEqual([
    "asset-namespaces/namespace-1/:",
    "asset-namespaces/namespace-1/:next",
    "projects/project-1/:",
  ]);
  expect(deletedObjects).toEqual(new Set([
    "asset-namespaces/namespace-1/first",
    "asset-namespaces/namespace-1/second",
  ]));
  const storedRows = await t.run(async (ctx) => await ctx.db.query("r2DeleteQueue").collect());
  expect(storedRows.find((row) => row._id === rows.firstPrefix)?.status).toBe("deleted");
  expect(storedRows.find((row) => row._id === rows.secondPrefix)?.status).toBe("pending");
  expect(storedRows.filter((row) => row.r2Key.startsWith("asset-namespaces/namespace-1/")).every((row) => row.status === "deleted")).toBe(true);
  expect(storedRows.filter((row) => row.r2Key.startsWith("projects/project-1/")).every((row) => row.status === "pending")).toBe(true);
  for (const key of ["projects/project-1/object-a", "projects/project-1/object-b"]) {
    const row = storedRows.find((candidate) => candidate.r2Key === key);
    expect(row).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "R2 prefix delete failed",
    });
    expect(row?.claimToken).toBeUndefined();
    expect(row?.claimedAt).toBeUndefined();
  }
});
