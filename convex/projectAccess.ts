import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { v } from "convex/values";

type RoomSummary = {
  projectId: string;
  name: string;
};

type ProjectRecord = Doc<"projects">;
type RoomOwnership = Doc<"ownerships">;

async function listProjectsByUser(
  ctx: any,
  projectId: string,
  userId: string,
) {
  return await ctx.db
    .query("projects")
    .withIndex("by_room_owner", (q: any) => q.eq("projectId", projectId).eq("ownerUserId", userId))
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
  ctx: any,
  userId: string,
): Promise<RoomSummary[]> {
  const [projectsRaw, ownershipsRaw] = await Promise.all([
    ctx.db
      .query("projects")
      .withIndex("by_owner", (q: any) => q.eq("ownerUserId", userId))
      .collect(),
    ctx.db
      .query("ownerships")
      .withIndex("by_owner", (q: any) => q.eq("ownerUserId", userId))
      .collect(),
  ]);

  const projects = projectsRaw as ProjectRecord[];
  const ownerships = ownershipsRaw as RoomOwnership[];
  const nameByProjectId = buildProjectNameByRoom(projects);
  const projectIds = new Set<string>();

  for (const project of projects) {
    projectIds.add(project.projectId);
  }
  for (const ownership of ownerships) {
    projectIds.add(ownership.projectId);
  }

  const missingProjectIds = Array.from(projectIds).filter((projectId) => !nameByProjectId.has(projectId));
  if (missingProjectIds.length > 0) {
    const missingNames = await Promise.all(
      missingProjectIds.map(async (projectId) => {
        const roomProjectsRaw = await ctx.db
          .query("projects")
          .withIndex("by_room", (q: any) => q.eq("projectId", projectId))
          .collect();
        return [projectId, pickProjectName(roomProjectsRaw as ProjectRecord[])] as const;
      }),
    );
    for (const [projectId, name] of missingNames) {
      nameByProjectId.set(projectId, name);
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
  ctx: any,
  projectId: string,
  userId: string,
): Promise<boolean> {
  const [projectsRaw, ownershipsRaw] = await Promise.all([
    listProjectsByUser(ctx, projectId, userId),
    ctx.db
      .query("ownerships")
      .withIndex("by_room_owner", (q: any) => q.eq("projectId", projectId).eq("ownerUserId", userId))
      .collect(),
  ]);

  return projectsRaw.length > 0 || ownershipsRaw.length > 0;
}

export type ProjectRole = "owner" | "editor" | "viewer";

export async function getProjectRole(
  ctx: any,
  projectId: string,
  userId: string,
): Promise<ProjectRole | null> {
  const projects = await listProjectsByUser(ctx, projectId, userId);
  if (projects.length > 0) return "owner";
  const ownerships = await ctx.db
    .query("ownerships")
    .withIndex("by_room_owner", (q: any) => q.eq("projectId", projectId).eq("ownerUserId", userId))
    .collect();
  if (ownerships.length === 0) return null;
  const role = ownerships.find((ownership: any) => !ownership.trackId && !ownership.clipId)?.role;
  return role === "owner" || role === "editor" || role === "viewer" ? role : "editor";
}

export async function requireProjectRole(
  ctx: any,
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

export async function requireProjectAccess(
  ctx: any,
  projectId: string,
  userId: string,
) {
  if (await hasProjectAccess(ctx, projectId, userId)) return;
  throw new Error("You do not have access to this room.");
}

export async function hasProjectAdminCapability(
  ctx: any,
  projectId: string,
  userId: string,
): Promise<boolean> {
  return (await getProjectRole(ctx, projectId, userId)) === "owner";
}

export async function requireProjectAdminCapability(
  ctx: any,
  projectId: string,
  userId: string,
) {
  if (await hasProjectAdminCapability(ctx, projectId, userId)) return;
  throw new Error("Only project owners can update room-level settings.");
}

export async function requireMasterBusWriteAccess(
  ctx: any,
  projectId: string,
  userId: string,
) {
  await requireProjectAdminCapability(ctx, projectId, userId);
}
