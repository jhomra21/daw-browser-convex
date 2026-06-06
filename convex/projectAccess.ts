import type { Doc } from "./_generated/dataModel";
import { query, type DatabaseReader } from "./_generated/server";
import { v } from "convex/values";
import { isProjectRole, type ProjectRole } from "@daw-browser/shared";

type RoomSummary = {
  projectId: string;
  name: string;
};

type ProjectRecord = Doc<"projects">;
type RoomOwnership = Doc<"ownerships">;
type ProjectAccessCtx = { db: DatabaseReader };
type AuthenticatedCtx = {
  auth: {
    getUserIdentity: () => Promise<{ subject: string } | null>;
  };
};

export function isProjectOwnership(ownership: RoomOwnership) {
  return !ownership.trackId && !ownership.clipId;
}

const hasDeletionPending = (projects: ProjectRecord[]) => (
  projects.some((project) => project.deletionPendingAt !== undefined)
);

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

export async function isProjectDeletionPending(
  ctx: ProjectAccessCtx,
  projectId: string,
) {
  const projects = await ctx.db
    .query("projects")
    .withIndex("by_room", (q) => q.eq("projectId", projectId))
    .collect();
  return hasDeletionPending(projects);
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

async function readAccessibleProjectNameByRoom(
  ctx: ProjectAccessCtx,
  projectId: string,
) {
  const projects = await ctx.db
    .query("projects")
    .withIndex("by_room_createdAt", (q) => q.eq("projectId", projectId))
    .order("asc")
    .collect();
  if (hasDeletionPending(projects)) return null;
  const project = projects[0];
  return project?.name.trim() ? project.name : "Untitled";
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
      .withIndex("by_owner_project_marker", (q) => q.eq("ownerUserId", userId).eq("trackId", undefined).eq("clipId", undefined))
      .collect(),
  ]);

  const pendingProjectIds = new Set(
    projects
      .filter((project) => project.deletionPendingAt !== undefined)
      .map((project) => project.projectId),
  );
  const activeProjects = projects.filter((project) => project.deletionPendingAt === undefined && !pendingProjectIds.has(project.projectId));
  const nameByProjectId = buildProjectNameByRoom(activeProjects);
  const projectIds = new Set<string>();

  for (const project of activeProjects) {
    projectIds.add(project.projectId);
  }
  const ownershipProjectIds = Array.from(new Set(
    ownerships.map((ownership) => ownership.projectId),
  ));
  if (ownershipProjectIds.length > 0) {
    const ownershipNames = await Promise.all(
      ownershipProjectIds.map(async (projectId) => [
        projectId,
        nameByProjectId.get(projectId) ?? await readAccessibleProjectNameByRoom(ctx, projectId),
      ] as const),
    );
    for (const [projectId, projectName] of ownershipNames) {
      if (projectName === null) continue;
      projectIds.add(projectId);
      nameByProjectId.set(projectId, projectName);
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

export const canWriteProject = (role: ProjectRole | null) => role === "owner" || role === "editor";

export async function getProjectRole(
  ctx: ProjectAccessCtx,
  projectId: string,
  userId: string,
): Promise<ProjectRole | null> {
  const projects = await listProjectsByUser(ctx, projectId, userId);
  if (projects.length > 0) return hasDeletionPending(projects) ? null : "owner";
  const ownerships = await ctx.db
    .query("ownerships")
    .withIndex("by_room_owner", (q) => q.eq("projectId", projectId).eq("ownerUserId", userId))
    .collect();
  if (ownerships.length === 0) return null;
  const projectOwnership = ownerships.find(isProjectOwnership);
  if (!projectOwnership) return null;
  if (await isProjectDeletionPending(ctx, projectId)) return null;
  const role = projectOwnership.role;
  return isProjectRole(role) ? role : "editor";
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
  args: { projectId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { projectId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return hasProjectAccess(ctx, projectId, userId);
  },
});

export const roleForUser = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return getProjectRole(ctx, projectId, userId);
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

export async function requireAuthenticatedUserId(ctx: AuthenticatedCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Authentication required.");
  return identity.subject;
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
  await requireProjectRole(ctx, projectId, userId, ["owner", "editor"]);
}
