import { mutation, query, type DatabaseReader, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { listAccessibleProjects, requireAuthenticatedUserId, requireProjectRole } from "./projectAccess";
import { removeProjectMemberAccessAndTransferEntities } from "./projectMembership";
import { enqueueR2DeleteRows } from "./r2Deletes";

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

async function listRoomProjectRows(ctx: { db: DatabaseReader }, projectId: string) {
  return await ctx.db
    .query("projects")
    .withIndex("by_room", (q) => q.eq("projectId", projectId))
    .collect();
}

async function setRoomProjectDeletionPendingAt(
  ctx: MutationCtx,
  projectId: string,
  deletionPendingAt: number | undefined,
) {
  const projects = await listRoomProjectRows(ctx, projectId);
  await Promise.all(projects.map((project) => ctx.db.patch(project._id, { deletionPendingAt })));
}

export const listMineDetailed = query({
  args: {},
  returns: v.array(v.object({ projectId: v.string(), name: v.string() })),
  handler: async (ctx) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return listAccessibleProjects(ctx, userId);
  },
});

export const createOwnedRoom = mutation({
  args: { projectId: v.string() },
  returns: v.object({ status: v.union(v.literal("created"), v.literal("exists")) }),
  handler: async (ctx, { projectId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const existingProjects = await listRoomProjectRows(ctx, projectId);
    const existingProject = existingProjects[0];
    if (existingProject) {
      if (existingProjects.some((project) => project.deletionPendingAt !== undefined)) {
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
  args: { projectId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { projectId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return Boolean(await findOwnedProject(ctx, projectId, userId));
  },
});

export const prepareCloudRoomDeleteAsOwner = mutation({
  args: { projectId: v.string() },
  returns: v.object({ status: v.literal("pending") }),
  handler: async (ctx, { projectId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const ownerProject = await findOwnedProject(ctx, projectId, userId);
    if (!ownerProject) throw new Error("Only project owners can delete this project.");
    const deletionPendingAt = ownerProject.deletionPendingAt ?? Date.now();
    await setRoomProjectDeletionPendingAt(ctx, projectId, deletionPendingAt);
    const result: { status: "pending" } = { status: "pending" };
    return result;
  },
});

export const finalizeCloudRoomDeleteAsOwner = mutation({
  args: { projectId: v.string() },
  returns: v.object({ status: v.literal("deleted") }),
  handler: async (ctx, { projectId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const ownerProject = await findOwnedProject(ctx, projectId, userId);
    if (!ownerProject) {
      const result: { status: "deleted" } = { status: "deleted" };
      return result;
    }
    if (ownerProject.deletionPendingAt === undefined) {
      throw new Error("Project deletion is not pending.");
    }
    await enqueueR2DeleteRows(ctx, { projectId, keys: [`projects/${projectId}/`], kind: "project-prefix" });
    await deleteRoomRows(ctx, projectId);
    const result: { status: "deleted" } = { status: "deleted" };
    return result;
  },
});

export const clearCloudRoomDeletePendingAsOwner = mutation({
  args: { projectId: v.string() },
  returns: v.object({ status: v.union(v.literal("cleared"), v.literal("skipped")) }),
  handler: async (ctx, { projectId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const ownerProject = await findOwnedProject(ctx, projectId, userId);
    if (!ownerProject?.deletionPendingAt) {
      const result: { status: "skipped" } = { status: "skipped" };
      return result;
    }
    await setRoomProjectDeletionPendingAt(ctx, projectId, undefined);
    const result: { status: "cleared" } = { status: "cleared" };
    return result;
  },
});

export const leaveCloudRoomAccess = mutation({
  args: { projectId: v.string() },
  returns: v.object({ status: v.literal("left") }),
  handler: async (ctx, { projectId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const role = await requireProjectRole(ctx, projectId, userId, ["owner", "editor", "viewer"]);
    if (role === "owner") throw new Error("Project owners cannot leave without deleting or transferring the project.");
    await removeProjectMemberAccessAndTransferEntities(ctx, projectId, userId);
    const result: { status: "left" } = { status: "left" };
    return result;
  },
});

export const setName = mutation({
  args: { projectId: v.string(), name: v.string() },
  returns: v.null(),
  handler: async (ctx, { projectId, name }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, projectId, userId, ["owner"]);
    const trimmed = name.trim().slice(0, 120);
    const row = await findOwnedProject(ctx, projectId, userId);
    if (row) {
      await ctx.db.patch(row._id, { name: trimmed.length ? trimmed : "Untitled" });
    }
    return null;
  },
});
