import { mutation, type MutationCtx, query } from "./_generated/server";
import { v } from "convex/values";
import { isValidR2DeleteKey, type R2DeleteKind } from "@daw-browser/shared";

const retryDelayMs = (attempts: number) => Math.min(60 * 60 * 1000, 2 ** Math.min(attempts, 8) * 1000);
const clampQueueLimit = (limit: number) => Math.max(1, Math.min(limit, 100));
const deletedRetentionMs = 7 * 24 * 60 * 60 * 1000;
const claimLeaseMs = 5 * 60 * 1000;
const pruneDeletedRows = async (ctx: Pick<MutationCtx, "db">, now: number) => {
  const rows = await ctx.db.query("r2DeleteQueue")
    .withIndex("by_status_due", (q) => q.eq("status", "deleted").lte("nextAttemptAt", now - deletedRetentionMs))
    .take(100);
  for (const row of rows) await ctx.db.delete(row._id);
};

type WorkerAuthCtx = {
  auth: {
    getUserIdentity: () => Promise<{ tokenIdentifier: string; dawWorker?: unknown } | null>;
  };
};

const requireWorkerQueueAccess = async (ctx: WorkerAuthCtx) => {
  const identity = await ctx.auth.getUserIdentity();
  if (identity?.dawWorker === true) return;
  throw new Error("R2 queue maintenance requires worker access.");
};

export const enqueueR2DeleteRows = async (
  ctx: Pick<MutationCtx, "db">,
  input: {
    projectId: string;
    storageNamespace: string;
    keys: string[];
    kind: R2DeleteKind;
    notBefore?: number;
  },
) => {
  const now = Date.now();
  const uniqueKeys = [...new Set(input.keys.filter(Boolean))];
  if (uniqueKeys.some((key) => !isValidR2DeleteKey(input.projectId, input.storageNamespace, input.kind, key))) {
    throw new Error("Invalid R2 delete key.");
  }
  for (const r2Key of uniqueKeys) {
    const existing = await ctx.db
      .query("r2DeleteQueue")
      .withIndex("by_key", (q) => q.eq("r2Key", r2Key))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        projectId: input.projectId,
        kind: input.kind,
        status: "pending",
        nextAttemptAt: Math.max(existing.nextAttemptAt, input.notBefore ?? now),
        claimedAt: undefined,
        claimToken: undefined,
        deletedAt: undefined,
        updatedAt: now,
      });
      continue;
    }
    await ctx.db.insert("r2DeleteQueue", {
      projectId: input.projectId,
      r2Key,
      kind: input.kind,
      attempts: 0,
      nextAttemptAt: input.notBefore ?? now,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
  }
};

export const hasR2DeleteRow = async (
  ctx: Pick<MutationCtx, "db">,
  input: { projectId: string; r2Key: string },
) => {
  const row = await ctx.db
    .query("r2DeleteQueue")
    .withIndex("by_key", (q) => q.eq("r2Key", input.r2Key))
    .first();
  return row?.projectId === input.projectId && row.status !== "deleted";
};

export const listDue = query({
  args: {
    projectId: v.string(),
    now: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, { projectId, now, limit }) => {
    await requireWorkerQueueAccess(ctx);
    const pending = await ctx.db
      .query("r2DeleteQueue")
      .withIndex("by_room_status_due", (q) => q.eq("projectId", projectId).eq("status", "pending").lte("nextAttemptAt", now))
      .take(clampQueueLimit(limit));
    if (pending.length >= clampQueueLimit(limit)) return pending;
    const stale = await ctx.db.query("r2DeleteQueue")
      .withIndex("by_room", (q) => q.eq("projectId", projectId))
      .filter((q) => q.and(
        q.eq(q.field("status"), "claimed"),
        q.lte(q.field("claimedAt"), now - claimLeaseMs),
      ))
      .take(clampQueueLimit(limit) - pending.length);
    return [...pending, ...stale];
  },
});

export const listDueAny = query({
  args: {
    now: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, { now, limit }) => {
    await requireWorkerQueueAccess(ctx);
    const pending = await ctx.db
      .query("r2DeleteQueue")
      .withIndex("by_status_due", (q) => q.eq("status", "pending").lte("nextAttemptAt", now))
      .take(clampQueueLimit(limit));
    if (pending.length >= clampQueueLimit(limit)) return pending;
    const stale = await ctx.db.query("r2DeleteQueue")
      .withIndex("by_status_claimedAt", (q) => q.eq("status", "claimed").lte("claimedAt", now - claimLeaseMs))
      .take(clampQueueLimit(limit) - pending.length);
    return [...pending, ...stale];
  },
});

export const findDueProjectPrefix = query({
  args: {
    projectId: v.string(),
    now: v.number(),
  },
  handler: async (ctx, { projectId, now }) => {
    await requireWorkerQueueAccess(ctx);
    const rows = await ctx.db
      .query("r2DeleteQueue")
      .withIndex("by_room_status_due", (q) => q.eq("projectId", projectId).eq("status", "pending").lte("nextAttemptAt", now))
      .take(100);
    const stale = await ctx.db.query("r2DeleteQueue")
      .withIndex("by_room", (q) => q.eq("projectId", projectId))
      .filter((q) => q.and(
        q.eq(q.field("kind"), "project-prefix"),
        q.eq(q.field("status"), "claimed"),
        q.lte(q.field("claimedAt"), now - claimLeaseMs),
      ))
      .take(1);
    return rows.find((row) => row.kind === "project-prefix") ?? stale[0] ?? null;
  },
});

export const claimRows = mutation({
  args: { projectId: v.string(), ids: v.array(v.id("r2DeleteQueue")), now: v.number() },
  handler: async (ctx, { projectId, ids, now }) => {
    await requireWorkerQueueAccess(ctx);
    const claimed = [];
    for (const id of ids) {
      const row = await ctx.db.get(id);
      const claimable = row?.status === "pending" && row.nextAttemptAt <= now
        || row?.status === "claimed" && (row.claimedAt ?? 0) <= now - claimLeaseMs;
      if (!row || row.projectId !== projectId || !claimable) continue;
      const claimToken = crypto.randomUUID();
      await ctx.db.patch(id, { status: "claimed", claimToken, claimedAt: now, updatedAt: now });
      const claimedRow = await ctx.db.get(id);
      if (claimedRow) claimed.push(claimedRow);
    }
    return claimed;
  },
});

export const markDeleted = mutation({
  args: {
    projectId: v.string(),
    claims: v.array(v.object({ id: v.id("r2DeleteQueue"), claimToken: v.string() })),
  },
  handler: async (ctx, { projectId, claims }) => {
    await requireWorkerQueueAccess(ctx);
    for (const { id, claimToken } of claims) {
      const row = await ctx.db.get(id);
      if (row?.projectId === projectId && row.status === "claimed" && row.claimToken === claimToken) {
        const now = Date.now();
        await ctx.db.patch(id, { status: "deleted", deletedAt: now, claimedAt: undefined, claimToken: undefined, nextAttemptAt: now, updatedAt: now });
      }
    }
    await pruneDeletedRows(ctx, Date.now());
    return { ok: true };
  },
});

export const markDeletedKeys = mutation({
  args: {
    projectId: v.string(),
    claims: v.array(v.object({ r2Key: v.string(), claimToken: v.string() })),
  },
  handler: async (ctx, { projectId, claims }) => {
    await requireWorkerQueueAccess(ctx);
    for (const { r2Key, claimToken } of claims) {
      const row = await ctx.db
        .query("r2DeleteQueue")
        .withIndex("by_key", (q) => q.eq("r2Key", r2Key))
        .first();
      if (row?.projectId === projectId && row.status === "claimed" && row.claimToken === claimToken) {
        const now = Date.now();
        await ctx.db.patch(row._id, { status: "deleted", deletedAt: now, claimedAt: undefined, claimToken: undefined, nextAttemptAt: now, updatedAt: now });
      }
    }
    return { ok: true };
  },
});

export const markFailed = mutation({
  args: {
    projectId: v.string(),
    id: v.id("r2DeleteQueue"),
    claimToken: v.string(),
    error: v.string(),
  },
  handler: async (ctx, { projectId, id, claimToken, error }) => {
    await requireWorkerQueueAccess(ctx);
    const row = await ctx.db.get(id);
    if (!row || row.projectId !== projectId || row.status !== "claimed" || row.claimToken !== claimToken) return { ok: true };
    const attempts = row.attempts + 1;
    await ctx.db.patch(id, {
      attempts,
      status: "pending",
      claimedAt: undefined,
      claimToken: undefined,
      lastError: error.slice(0, 500),
      nextAttemptAt: Date.now() + retryDelayMs(attempts),
      updatedAt: Date.now(),
    });
    return { ok: true };
  },
});
