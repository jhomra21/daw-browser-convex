import { mutation, query, type DatabaseReader, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { listAccessibleProjects, requireAuthenticatedUserId, requireProjectRole } from "./projectAccess";
import { removeProjectMemberAccessAndTransferEntities } from "./projectMembership";
import { enqueueR2DeleteRows } from "./r2Deletes";
import { advanceProjectRevision, ensureOwnedProjectRow, getProjectRow, requireProjectRow } from "./projectRows";

type RowOperationResult<State extends object> =
  | { changed: false; value: State & { status: "noop" } }
  | { changed: true; value: State & { status: "applied" } };

type ProjectTimelineSettingsInput = {
  tempoBpm?: number;
  timeSignatureNumerator?: number;
  timeSignatureDenominator?: number;
  loopEnabled?: boolean;
  loopStartSec?: number;
  loopEndSec?: number;
};

type ProjectTimelineSettingsState = {
  tempoBpm: number;
  timeSignatureNumerator: number;
  timeSignatureDenominator: number;
  loopEnabled: boolean;
  loopStartSec: number;
  loopEndSec: number;
};

const noopRowOperation = <State extends object>(state: State): RowOperationResult<State> => ({
  changed: false,
  value: { ...state, status: "noop" },
});

const appliedRowOperation = <State extends object>(state: State): RowOperationResult<State> => ({
  changed: true,
  value: { ...state, status: "applied" },
});

const statusResult = <Status extends string>(status: Status) => ({ status });

async function deleteRoomDataRows(ctx: MutationCtx, projectId: string) {
  await Promise.all([
    ctx.db.query("samples").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()
      .then((rows) => Promise.all(rows.map((row) => ctx.db.delete(row._id)))),
    ctx.db.query("assetFolders").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect()
      .then((rows) => Promise.all(rows.map((row) => ctx.db.delete(row._id)))),
    ctx.db.query("assetUploadReceipts").withIndex("by_project_status_updatedAt", (q) => q.eq("projectId", projectId))
      .collect().then((rows) => Promise.all(rows.map((row) => ctx.db.delete(row._id)))),
    ctx.db.query("exports").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()
      .then((rows) => Promise.all(rows.map((row) => ctx.db.delete(row._id)))),
    ctx.db.query("effects").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()
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
    ctx.db.query("projectMixerSettings").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()
      .then((rows) => Promise.all(rows.map((row) => ctx.db.delete(row._id)))),
    ctx.db.query("automationEnvelopes").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect()
      .then((rows) => Promise.all(rows.map((row) => ctx.db.delete(row._id)))),
    ctx.db.query("sidechainRoutes").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()
      .then((rows) => Promise.all(rows.map((row) => ctx.db.delete(row._id)))),
    ctx.db.query("controlCommits").withIndex("by_project_createdAt", (q) => q.eq("projectId", projectId)).collect()
      .then((rows) => Promise.all(rows.map((row) => ctx.db.delete(row._id)))),
    ctx.db.query("controlApprovals").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect()
      .then((rows) => Promise.all(rows.map((row) => ctx.db.delete(row._id)))),
    ctx.db.query("controlRecoveries").withIndex("by_project_createdAt", (q) => q.eq("projectId", projectId)).collect()
      .then((rows) => Promise.all(rows.map((row) => ctx.db.delete(row._id)))),
    ctx.db.query("sharedOperationResults").withIndex("by_room_user_operation", (q) => q.eq("projectId", projectId)).collect()
      .then((rows) => Promise.all(rows.map((row) => ctx.db.delete(row._id)))),
    ctx.db.query("clipDeletionRecoveries").withIndex("by_project_expiresAt", (q) => q.eq("projectId", projectId)).collect()
      .then((rows) => Promise.all(rows.map((row) => ctx.db.delete(row._id)))),
    ctx.db.query("clipDeletionRecoveryReceipts").withIndex("by_project_createdAt", (q) => q.eq("projectId", projectId)).collect()
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
  const project = await getProjectRow(ctx, projectId);
  return project?.ownerUserId === userId ? project : null;
}

async function setRoomProjectDeletionPendingAt(
  ctx: MutationCtx,
  projectId: string,
  deletionPendingAt: number | undefined,
) {
  const project = await getProjectRow(ctx, projectId);
  if (project) await ctx.db.patch(project._id, { deletionPendingAt });
}

export async function setProjectNameRow(
  ctx: MutationCtx,
  projectId: string,
  name: string,
) {
  const project = await requireProjectRow(ctx, projectId);
  const trimmed = name.trim().slice(0, 120);
  const state = { name: trimmed.length ? trimmed : "Untitled" };
  if (project.name === state.name) return noopRowOperation(state);
  await ctx.db.patch(project._id, state);
  return appliedRowOperation(state);
}

export async function setProjectTimelineSettingsRow(
  ctx: MutationCtx,
  projectId: string,
  input: ProjectTimelineSettingsInput,
) {
  const project = await requireProjectRow(ctx, projectId);
  const tempoBpm = input.tempoBpm === undefined
    ? project.tempoBpm
    : Math.min(300, Math.max(30, Math.round(input.tempoBpm)));
  const timeSignatureNumerator = input.timeSignatureNumerator === undefined
    ? project.timeSignatureNumerator
    : Math.min(32, Math.max(1, Math.round(input.timeSignatureNumerator)));
  const timeSignatureDenominator = input.timeSignatureDenominator === undefined
    ? project.timeSignatureDenominator
    : input.timeSignatureDenominator;
  if (![1, 2, 4, 8, 16, 32].includes(timeSignatureDenominator)) {
    throw new Error("Unsupported time signature denominator.");
  }
  const loopStartSec = input.loopStartSec === undefined
    ? project.loopStartSec
    : Math.max(0, input.loopStartSec);
  const loopEndSec = input.loopEndSec === undefined
    ? project.loopEndSec
    : Math.max(loopStartSec + 0.05, input.loopEndSec);

  const state: ProjectTimelineSettingsState = {
    tempoBpm,
    timeSignatureNumerator,
    timeSignatureDenominator,
    loopEnabled: input.loopEnabled ?? project.loopEnabled,
    loopStartSec,
    loopEndSec,
  };
  const changed = (
    project.tempoBpm !== state.tempoBpm
    || project.timeSignatureNumerator !== state.timeSignatureNumerator
    || project.timeSignatureDenominator !== state.timeSignatureDenominator
    || project.loopEnabled !== state.loopEnabled
    || project.loopStartSec !== state.loopStartSec
    || project.loopEndSec !== state.loopEndSec
  );
  if (!changed) return noopRowOperation(state);
  await ctx.db.patch(project._id, state);
  return appliedRowOperation(state);
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
    const existingProject = await getProjectRow(ctx, projectId);
    if (existingProject) {
      if (existingProject.deletionPendingAt !== undefined) {
        throw new Error("Project deletion is pending.");
      }
      if (existingProject.ownerUserId === userId) {
        return statusResult("exists");
      }
      throw new Error("Project already exists.");
    }
    const created = await ensureOwnedProjectRow(ctx, projectId, userId);
    return { status: created.status };
  },
});

export const exists = query({
  args: { projectId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { projectId }) => {
    const row = await getProjectRow(ctx, projectId);
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
    return statusResult("pending");
  },
});

export const finalizeCloudRoomDeleteAsOwner = mutation({
  args: { projectId: v.string() },
  returns: v.object({ status: v.literal("deleted") }),
  handler: async (ctx, { projectId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const ownerProject = await findOwnedProject(ctx, projectId, userId);
    if (!ownerProject) {
      return statusResult("deleted");
    }
    if (ownerProject.deletionPendingAt === undefined) {
      throw new Error("Project deletion is not pending.");
    }
    await deleteRoomRows(ctx, projectId);
    await enqueueR2DeleteRows(ctx, {
      projectId, storageNamespace: ownerProject.storageNamespace,
      keys: [`asset-namespaces/${ownerProject.storageNamespace}/`], kind: "project-prefix",
    });
    return statusResult("deleted");
  },
});

export const clearCloudRoomDeletePendingAsOwner = mutation({
  args: { projectId: v.string() },
  returns: v.object({ status: v.union(v.literal("cleared"), v.literal("skipped")) }),
  handler: async (ctx, { projectId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const ownerProject = await findOwnedProject(ctx, projectId, userId);
    if (!ownerProject?.deletionPendingAt) {
      return statusResult("skipped");
    }
    await setRoomProjectDeletionPendingAt(ctx, projectId, undefined);
    return statusResult("cleared");
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
    return statusResult("left");
  },
});

export const setName = mutation({
  args: { projectId: v.string(), name: v.string() },
  returns: v.null(),
  handler: async (ctx, { projectId, name }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, projectId, userId, ["owner"]);
    const result = await setProjectNameRow(ctx, projectId, name);
    if (result.changed) await advanceProjectRevision(ctx, projectId);
    return null;
  },
});

export const setTimelineSettings = mutation({
  args: {
    projectId: v.string(),
    tempoBpm: v.optional(v.number()),
    timeSignatureNumerator: v.optional(v.number()),
    timeSignatureDenominator: v.optional(v.number()),
    loopEnabled: v.optional(v.boolean()),
    loopStartSec: v.optional(v.number()),
    loopEndSec: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const project = await findOwnedProject(ctx, input.projectId, userId);
    if (!project) throw new Error("Only project owners can update project settings.");
    const result = await setProjectTimelineSettingsRow(ctx, input.projectId, input);
    if (result.changed) await advanceProjectRevision(ctx, input.projectId);
    return null;
  },
});
