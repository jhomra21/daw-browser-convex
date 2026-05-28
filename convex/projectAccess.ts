import type { Doc } from "./_generated/dataModel";
import { query, type DatabaseReader } from "./_generated/server";
import { v } from "convex/values";

type RoomSummary = {
  projectId: string;
  name: string;
};

type ProjectRecord = Doc<"projects">;
type RoomOwnership = Doc<"ownerships">;
type ProjectAccessCtx = { db: DatabaseReader };

function isProjectOwnership(ownership: RoomOwnership) {
  return !ownership.trackId && !ownership.clipId;
}

function isProjectDeletionPending(project: ProjectRecord) {
  return project.deletionPendingAt !== undefined;
}

async function listProjectsByUser(
  ctx: ProjectAccessCtx,
  projectId: string,
  userId: string,
) {
  return await ctx.db
    .query("projects")
    .withIndex("by_room_owner", (q) => q.eq("projectId", projectId).eq("ownerUserId", userId))
    .collect();
}

function buildProjectNameByRoom(projects: ProjectRecord[]) {
  const nameByProjectId = new Map<string, string>();
  for (const project of projects) {
    if (!nameByProjectId.has(project.projectId)) {
      nameByProjectId.set(project.projectId, project.name);
    }
  }
  return nameByProjectId;
}

function pickProjectName(projects: ProjectRecord[]) {
  if (projects.length === 0) return "Untitled";
  const sorted = projects
    .slice()
    .sort((left, right) => left.createdAt - right.createdAt);
  for (const project of sorted) {
    const trimmed = project.name.trim();
    if (trimmed) return trimmed;
  }
  return "Untitled";
}

export async function listAccessibleProjects(
  ctx: ProjectAccessCtx,
  userId: string,
): Promise<RoomSummary[]> {
  const [projects, ownerships] = await Promise.all([
    ctx.db
      .query("projects")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", userId))
      .collect(),
    ctx.db
      .query("ownerships")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", userId))
      .collect(),
  ]);

  const activeProjects = projects.filter((project) => !isProjectDeletionPending(project));
  const nameByProjectId = buildProjectNameByRoom(activeProjects);
  const projectIds = new Set<string>();

  for (const project of activeProjects) {
    projectIds.add(project.projectId);
  }
  const ownershipProjectIds = Array.from(new Set(
    ownerships.flatMap((ownership) => isProjectOwnership(ownership) ? [ownership.projectId] : []),
  ));
  if (ownershipProjectIds.length > 0) {
    const ownershipRooms = await Promise.all(
      ownershipProjectIds.map(async (projectId) => {
        const roomProjects = await ctx.db
          .query("projects")
          .withIndex("by_room", (q) => q.eq("projectId", projectId))
          .collect();
        return [projectId, roomProjects] as const;
      }),
    );
    for (const [projectId, roomProjects] of ownershipRooms) {
      if (roomProjects.some(isProjectDeletionPending)) continue;
      projectIds.add(projectId);
      if (!nameByProjectId.has(projectId)) {
        nameByProjectId.set(projectId, pickProjectName(roomProjects));
      }
    }
  }

  return Array.from(projectIds)
    .map((projectId) => ({
      projectId,
      name: nameByProjectId.get(projectId) ?? "Untitled",
    }))
    .sort((left, right) => left.projectId.localeCompare(right.projectId));
}

export async function hasProjectAccess(
  ctx: ProjectAccessCtx,
  projectId: string,
  userId: string,
): Promise<boolean> {
  return (await getProjectRole(ctx, projectId, userId)) !== null;
}

export type ProjectRole = "owner" | "editor" | "viewer";

export async function getProjectRole(
  ctx: ProjectAccessCtx,
  projectId: string,
  userId: string,
): Promise<ProjectRole | null> {
  if (await isRoomDeletionPending(ctx, projectId)) return null;
  return getProjectRoleIncludingPending(ctx, projectId, userId);
}

async function isRoomDeletionPending(
  ctx: ProjectAccessCtx,
  projectId: string,
) {
  const project = await ctx.db
    .query("projects")
    .withIndex("by_room", (q) => q.eq("projectId", projectId))
    .first();
  return project ? isProjectDeletionPending(project) : false;
}

async function getProjectRoleIncludingPending(
  ctx: ProjectAccessCtx,
  projectId: string,
  userId: string,
): Promise<ProjectRole | null> {
  const projects = await listProjectsByUser(ctx, projectId, userId);
  if (projects.length > 0) return "owner";
  const ownerships = await ctx.db
    .query("ownerships")
    .withIndex("by_room_owner", (q) => q.eq("projectId", projectId).eq("ownerUserId", userId))
    .collect();
  if (ownerships.length === 0) return null;
  const projectOwnership = ownerships.find(isProjectOwnership);
  if (!projectOwnership) return null;
  const role = projectOwnership.role;
  return role === "owner" || role === "editor" || role === "viewer" ? role : "editor";
}

export async function requireProjectRole(
  ctx: ProjectAccessCtx,
  projectId: string,
  userId: string,
  allowed: ProjectRole[],
) {
  const role = await getProjectRole(ctx, projectId, userId);
  if (role && allowed.includes(role)) return role;
  throw new Error("You do not have permission for this project action.");
}

export const canAccess = query({
  args: { projectId: v.string(), userId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { projectId, userId }) => {
    return hasProjectAccess(ctx, projectId, userId);
  },
});

export const roleForUser = query({
  args: { projectId: v.string(), userId: v.string() },
  handler: async (ctx, { projectId, userId }) => {
    return getProjectRole(ctx, projectId, userId);
  },
});

export const roleForUserIncludingPending = query({
  args: { projectId: v.string(), userId: v.string() },
  handler: async (ctx, { projectId, userId }) => {
    return getProjectRoleIncludingPending(ctx, projectId, userId);
  },
});

export async function requireProjectAccess(
  ctx: ProjectAccessCtx,
  projectId: string,
  userId: string,
) {
  if (await hasProjectAccess(ctx, projectId, userId)) return;
  throw new Error("You do not have access to this room.");
}

export async function hasProjectAdminCapability(
  ctx: ProjectAccessCtx,
  projectId: string,
  userId: string,
): Promise<boolean> {
  return (await getProjectRole(ctx, projectId, userId)) === "owner";
}

export async function requireProjectAdminCapability(
  ctx: ProjectAccessCtx,
  projectId: string,
  userId: string,
) {
  if (await hasProjectAdminCapability(ctx, projectId, userId)) return;
  throw new Error("Only project owners can update room-level settings.");
}

export async function requireMasterBusWriteAccess(
  ctx: ProjectAccessCtx,
  projectId: string,
  userId: string,
) {
  await requireProjectAdminCapability(ctx, projectId, userId);
}
