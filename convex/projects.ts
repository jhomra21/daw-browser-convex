import { mutation, query, type DatabaseReader, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { listAccessibleProjects, requireProjectRole } from "./projectAccess";

declare const process: { env: { CLOUD_PROJECTS_SERVICE_TOKEN?: string } };

const requireServerSecret = (serverSecret: string) => {
  if (!serverSecret || serverSecret !== process.env.CLOUD_PROJECTS_SERVICE_TOKEN) {
    throw new Error("Unauthorized project request.");
  }
};

async function ensureOwnedRoomRecords(
  ctx: MutationCtx,
  projectId: string,
  userId: string,
) {
  const [projRows, ownershipRows] = await Promise.all([
    ctx.db
      .query("projects")
      .withIndex("by_room_owner", (q) => q.eq("projectId", projectId).eq("ownerUserId", userId))
      .collect(),
    ctx.db
      .query("ownerships")
      .withIndex("by_room_owner", (q) => q.eq("projectId", projectId).eq("ownerUserId", userId))
      .collect(),
  ]);
  const markerOwnership = ownershipRows.find((ownership) => !ownership.trackId && !ownership.clipId);
  if (!projRows[0]) {
    await ctx.db.insert("projects", {
      projectId,
      ownerUserId: userId,
      name: "Untitled",
      createdAt: Date.now(),
    });
  }
  if (!markerOwnership) {
    await ctx.db.insert("ownerships", {
      projectId,
      ownerUserId: userId,
    });
  }
}

async function deleteRoomDataRows(ctx: MutationCtx, projectId: string) {
  await Promise.all([
    ctx.db.query("samples").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()
      .then((rows) => Promise.all(rows.map((row) => ctx.db.delete(row._id)))),
    ctx.db.query("exports").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()
      .then((rows) => Promise.all(rows.map((row) => ctx.db.delete(row._id)))),
    ctx.db.query("effects").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()
      .then((rows) => Promise.all(rows.map((row) => ctx.db.delete(row._id)))),
    ctx.db.query("chatHistories").withIndex("by_room_owner", (q) => q.eq("projectId", projectId)).collect()
      .then((rows) => Promise.all(rows.map((row) => ctx.db.delete(row._id)))),
    ctx.db.query("projectMessages").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()
      .then((rows) => Promise.all(rows.map((row) => ctx.db.delete(row._id)))),
    ctx.db.query("shareInvites").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()
      .then((rows) => Promise.all(rows.map((row) => ctx.db.delete(row._id)))),
    ctx.db.query("cloudBackups").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()
      .then((rows) => Promise.all(rows.map((row) => ctx.db.delete(row._id)))),
    ctx.db.query("mixerChannels").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()
      .then((rows) => Promise.all(rows.map((row) => ctx.db.delete(row._id)))),
    ctx.db.query("clips").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()
      .then((rows) => Promise.all(rows.map((row) => ctx.db.delete(row._id)))),
    ctx.db.query("tracks").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()
      .then((rows) => Promise.all(rows.map((row) => ctx.db.delete(row._id)))),
  ]);
}

async function deleteRoomAuthRows(ctx: MutationCtx, projectId: string) {
  await Promise.all([
    ctx.db.query("ownerships").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()
      .then((rows) => Promise.all(rows.map((row) => ctx.db.delete(row._id)))),
    ctx.db.query("projects").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()
      .then((rows) => Promise.all(rows.map((row) => ctx.db.delete(row._id)))),
  ]);
}

async function deleteRoomRows(ctx: MutationCtx, projectId: string) {
  await Promise.all([
    deleteRoomDataRows(ctx, projectId),
    deleteRoomAuthRows(ctx, projectId),
  ]);
}

async function findOwnedProject(ctx: { db: DatabaseReader }, projectId: string, userId: string) {
  return ctx.db
    .query("projects")
    .withIndex("by_room_owner", (q) => q.eq("projectId", projectId).eq("ownerUserId", userId))
    .first();
}

export const listMineDetailed = query({
  args: { userId: v.string() },
  returns: v.array(v.object({ projectId: v.string(), name: v.string() })),
  handler: async (ctx, { userId }) => {
    return listAccessibleProjects(ctx, userId);
  },
});

export const createOwnedRoom = mutation({
  args: { projectId: v.string(), userId: v.string(), serverSecret: v.string() },
  returns: v.object({ status: v.union(v.literal("created"), v.literal("exists")) }),
  handler: async (ctx, { projectId, userId, serverSecret }) => {
    requireServerSecret(serverSecret);
    const existingProject = await ctx.db
      .query("projects")
      .withIndex("by_room", (q) => q.eq("projectId", projectId))
      .first();
    if (existingProject) {
      if (existingProject.deletionPendingAt !== undefined) {
        throw new Error("Project deletion is pending.");
      }
      if (existingProject.ownerUserId === userId) {
        const result: { status: "exists" } = { status: "exists" };
        return result;
      }
      throw new Error("Project already exists.");
    }
    await ensureOwnedRoomRecords(ctx, projectId, userId);
    const result: { status: "created" } = { status: "created" };
    return result;
  },
});

export const exists = query({
  args: { projectId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { projectId }) => {
    const row = await ctx.db
      .query("projects")
      .withIndex("by_room", (q) => q.eq("projectId", projectId))
      .first();
    return Boolean(row);
  },
});

export const canDeleteAsOwner = query({
  args: { projectId: v.string(), userId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { projectId, userId }) => {
    return Boolean(await findOwnedProject(ctx, projectId, userId));
  },
});

export const prepareCloudRoomDeleteAsOwner = mutation({
  args: { projectId: v.string(), userId: v.string(), serverSecret: v.string() },
  returns: v.object({ status: v.literal("deleted") }),
  handler: async (ctx, { projectId, userId, serverSecret }) => {
    requireServerSecret(serverSecret);
    const ownerProject = await findOwnedProject(ctx, projectId, userId);
    if (!ownerProject) throw new Error("Only project owners can delete this project.");
    await ctx.db.patch(ownerProject._id, { deletionPendingAt: Date.now() });
    const result: { status: "deleted" } = { status: "deleted" };
    return result;
  },
});

export const finalizeCloudRoomDeleteAsOwner = mutation({
  args: { projectId: v.string(), userId: v.string(), serverSecret: v.string() },
  returns: v.object({ status: v.literal("deleted") }),
  handler: async (ctx, { projectId, userId, serverSecret }) => {
    requireServerSecret(serverSecret);
    const ownerProject = await findOwnedProject(ctx, projectId, userId);
    if (!ownerProject) {
      const result: { status: "deleted" } = { status: "deleted" };
      return result;
    }
    await deleteRoomRows(ctx, projectId);
    const result: { status: "deleted" } = { status: "deleted" };
    return result;
  },
});

export const clearCloudRoomDeletePendingAsOwner = mutation({
  args: { projectId: v.string(), userId: v.string(), serverSecret: v.string() },
  returns: v.object({ status: v.union(v.literal("cleared"), v.literal("skipped")) }),
  handler: async (ctx, { projectId, userId, serverSecret }) => {
    requireServerSecret(serverSecret);
    const ownerProject = await findOwnedProject(ctx, projectId, userId);
    if (!ownerProject?.deletionPendingAt) {
      const result: { status: "skipped" } = { status: "skipped" };
      return result;
    }
    await ctx.db.patch(ownerProject._id, { deletionPendingAt: undefined });
    const result: { status: "cleared" } = { status: "cleared" };
    return result;
  },
});

export const setName = mutation({
  args: { projectId: v.string(), userId: v.string(), name: v.string() },
  returns: v.null(),
  handler: async (ctx, { projectId, userId, name }) => {
    await requireProjectRole(ctx, projectId, userId, ["owner"]);
    const trimmed = name.trim().slice(0, 120);
    const row = await findOwnedProject(ctx, projectId, userId);
    if (row) {
      await ctx.db.patch(row._id, { name: trimmed.length ? trimmed : "Untitled" });
    }
    return null;
  },
});
