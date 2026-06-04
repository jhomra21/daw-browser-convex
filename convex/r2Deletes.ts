import { mutation, type MutationCtx, query } from "./_generated/server";
import { v } from "convex/values";
import { isValidR2DeleteKey, type R2DeleteKind } from "../src/lib/r2-delete-keys";

const retryDelayMs = (attempts: number) => Math.min(60 * 60 * 1000, 2 ** Math.min(attempts, 8) * 1000);
const clampQueueLimit = (limit: number) => Math.max(1, Math.min(limit, 100));

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
    keys: string[];
    kind: R2DeleteKind;
  },
) => {
  const now = Date.now();
  const uniqueKeys = [...new Set(input.keys.filter(Boolean))];
  if (uniqueKeys.some((key) => !isValidR2DeleteKey(input.projectId, input.kind, key))) {
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
        nextAttemptAt: Math.min(existing.nextAttemptAt, now),
        updatedAt: now,
      });
      continue;
    }
    await ctx.db.insert("r2DeleteQueue", {
      projectId: input.projectId,
      r2Key,
      kind: input.kind,
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }
};

export const listDue = query({
  args: {
    projectId: v.string(),
    now: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, { projectId, now, limit }) => {
    await requireWorkerQueueAccess(ctx);
    return await ctx.db
      .query("r2DeleteQueue")
      .withIndex("by_room_due", (q) => q.eq("projectId", projectId).lte("nextAttemptAt", now))
      .take(clampQueueLimit(limit));
  },
});

export const listDueAny = query({
  args: {
    now: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, { now, limit }) => {
    await requireWorkerQueueAccess(ctx);
    return await ctx.db
      .query("r2DeleteQueue")
      .withIndex("by_due", (q) => q.lte("nextAttemptAt", now))
      .take(clampQueueLimit(limit));
  },
});

export const findDueProjectPrefix = query({
  args: {
    projectId: v.string(),
    now: v.number(),
  },
  handler: async (ctx, { projectId, now }) => {
    await requireWorkerQueueAccess(ctx);
    const row = await ctx.db
      .query("r2DeleteQueue")
      .withIndex("by_key", (q) => q.eq("r2Key", `projects/${projectId}/`))
      .first();
    return row?.projectId === projectId && row.kind === "project-prefix" && row.nextAttemptAt <= now ? row : null;
  },
});

export const markDeleted = mutation({
  args: {
    projectId: v.string(),
    ids: v.array(v.id("r2DeleteQueue")),
  },
  handler: async (ctx, { projectId, ids }) => {
    await requireWorkerQueueAccess(ctx);
    for (const id of ids) {
      const row = await ctx.db.get(id);
      if (row?.projectId === projectId) await ctx.db.delete(id);
    }
    return { ok: true };
  },
});

export const markDeletedKeys = mutation({
  args: {
    projectId: v.string(),
    keys: v.array(v.string()),
  },
  handler: async (ctx, { projectId, keys }) => {
    await requireWorkerQueueAccess(ctx);
    for (const r2Key of keys) {
      const row = await ctx.db
        .query("r2DeleteQueue")
        .withIndex("by_key", (q) => q.eq("r2Key", r2Key))
        .first();
      if (row?.projectId === projectId) await ctx.db.delete(row._id);
    }
    return { ok: true };
  },
});

export const markFailed = mutation({
  args: {
    projectId: v.string(),
    id: v.id("r2DeleteQueue"),
    error: v.string(),
  },
  handler: async (ctx, { projectId, id, error }) => {
    await requireWorkerQueueAccess(ctx);
    const row = await ctx.db.get(id);
    if (!row || row.projectId !== projectId) return { ok: true };
    const attempts = row.attempts + 1;
    await ctx.db.patch(id, {
      attempts,
      lastError: error.slice(0, 500),
      nextAttemptAt: Date.now() + retryDelayMs(attempts),
      updatedAt: Date.now(),
    });
    return { ok: true };
  },
});
