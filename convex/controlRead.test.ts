import { expect, test } from "bun:test";
import { convexTest } from "convex-test";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = {
  "./_generated/api.ts": () => import("./_generated/api"),
  "./control.ts": () => import("./control"),
  "./projects.ts": () => import("./projects"),
};

const projectId = "project-control-read";
const owner = "owner-control-read";
const editor = "editor-control-read";
const viewer = "viewer-control-read";

const commitRequest = (idempotencyKey: string, name: string) => ({
  version: "v1",
  projectId,
  idempotencyKey,
  actions: [{ kind: "project.rename", name }],
});

const setup = async () => {
  const t = convexTest(schema, modules);
  await t.withIdentity({ subject: owner }).mutation(api.projects.createOwnedRoom, { projectId });
  await t.run(async (ctx) => {
    await ctx.db.insert("ownerships", { projectId, ownerUserId: editor, role: "editor" });
    await ctx.db.insert("ownerships", { projectId, ownerUserId: viewer, role: "viewer" });
  });
  return t;
};

const seedCommit = async (
  t: Awaited<ReturnType<typeof setup>>,
  index: number,
) => await t.run(async (ctx) => await ctx.db.insert("controlCommits", {
  projectId,
  apiVersion: "v1",
  actorSubject: owner,
  actorIssuer: "issuer-control-read",
  actorTokenIdentifier: "token-control-read",
  actorRole: "owner",
  idempotencyKey: `seed-key-${index}`,
  requestDigest: `${index}`.padStart(64, "0"),
  semanticRequest: "{\"mustNot\":\"leak\"}",
  priorRevision: index,
  finalRevision: index + 1,
  applied: true,
  result: { mustNot: "leak" },
  createdAt: 10_000 + index,
  status: "completed",
}));

test("owners, editors, and viewers can read snapshots and history while anonymous and non-member users receive structured rejection", async () => {
  const t = await setup();
  await seedCommit(t, 1);

  for (const userId of [owner, editor, viewer]) {
    const snapshot = await t.withIdentity({ subject: userId }).query(api.control.snapshotV1, { projectId });
    const history = await t.withIdentity({ subject: userId }).query(api.control.historyV1, { projectId });
    expect(snapshot.project.id).toBe(projectId);
    expect(history.entries).toHaveLength(1);
  }

  await expect(t.query(api.control.snapshotV1, { projectId })).rejects.toThrow(
    "Authentication is required",
  );
  await expect(t.query(api.control.historyV1, { projectId })).rejects.toThrow(
    "Authentication is required",
  );
  await expect(t.withIdentity({ subject: "non-member-control-read" }).query(
    api.control.snapshotV1,
    { projectId },
  )).rejects.toThrow("read access");
  await expect(t.withIdentity({ subject: "non-member-control-read" }).query(
    api.control.historyV1,
    { projectId },
  )).rejects.toThrow("read access");
});

test("history uses newest-first bounded Convex cursor pagination without public ledger leakage", async () => {
  const t = await setup();
  for (let index = 0; index < 101; index += 1) {
    await seedCommit(t, index);
  }

  const first = await t.withIdentity({ subject: owner }).query(api.control.historyV1, { projectId });
  expect(first.entries).toHaveLength(50);
  expect(first.isDone).toBe(false);
  expect(first.entries.map((entry: { revision: number }) => entry.revision)).toEqual(
    Array.from({ length: 50 }, (_, index) => 101 - index),
  );
  expect(first.entries[0]).not.toHaveProperty("semanticRequest");
  expect(first.entries[0]).not.toHaveProperty("result");

  const second = await t.withIdentity({ subject: owner }).query(api.control.historyV1, {
    projectId,
    cursor: first.continueCursor,
    limit: 100,
  });
  expect(second.entries).toHaveLength(51);
  expect(second.isDone).toBe(true);
  const ids = [...first.entries, ...second.entries].map((entry: { id: string }) => entry.id);
  expect(new Set(ids).size).toBe(101);
  expect(second.entries.map((entry: { revision: number }) => entry.revision)).toEqual(
    Array.from({ length: 51 }, (_, index) => 51 - index),
  );
});

test("history rejects malformed control query arguments with structured errors", async () => {
  const t = await setup();
  for (const args of [
    { projectId: "" },
    { projectId, cursor: "invalid\ncursor" },
    { projectId, limit: 101 },
    { projectId, limit: 1.5 },
  ]) {
    await expect(t.withIdentity({ subject: owner }).query(api.control.historyV1, args)).rejects.toThrow(
      "Invalid control history request",
    );
  }

  await expect(t.withIdentity({ subject: owner }).query(api.control.historyV1, {
    projectId,
    cursor: "bogus",
  })).rejects.toThrow("Invalid control history cursor");
});

test("commits retain normal and trusted bridge actor attribution without request actor metadata", async () => {
  const t = await setup();
  await t.withIdentity({
    subject: owner,
    issuer: "normal-issuer",
    tokenIdentifier: "normal-token",
  }).mutation(api.control.commitV1, {
    request: commitRequest("normal-actor-key", "Normal actor"),
  });
  await t.withIdentity({
    subject: owner,
    issuer: "normal-issuer",
    tokenIdentifier: "normal-token",
    dawControlActorIssuer: "bridge-issuer",
    dawControlActorTokenIdentifier: "bridge-token",
  }).mutation(api.control.commitV1, {
    request: commitRequest("bridge-actor-key", "Bridge actor"),
  });

  const commits = await t.run(async (ctx) => await ctx.db
    .query("controlCommits")
    .withIndex("by_project_createdAt", (query) => query.eq("projectId", projectId))
    .order("asc")
    .collect());
  expect(commits.map((commit) => ({
    subject: commit.actorSubject,
    issuer: commit.actorIssuer,
    tokenIdentifier: commit.actorTokenIdentifier,
  }))).toEqual([
    { subject: owner, issuer: "normal-issuer", tokenIdentifier: "normal-token" },
    { subject: owner, issuer: "bridge-issuer", tokenIdentifier: "bridge-token" },
  ]);
});
