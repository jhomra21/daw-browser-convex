import type { DatabaseReader, MutationCtx } from "./_generated/server";

type ProjectRowReadCtx = { db: DatabaseReader };

export function requireUnambiguousProjectOwnershipMarker(
  ownerships: ReadonlyArray<{ trackId?: unknown; clipId?: unknown }>,
) {
  const markers = ownerships.filter((ownership) => !ownership.trackId && !ownership.clipId);
  if (markers.length > 1) throw new Error("Project ownership marker is ambiguous.");
  return markers[0];
}

export async function getProjectRow(
  ctx: ProjectRowReadCtx,
  projectId: string,
) {
  return await ctx.db
    .query("projects")
    .withIndex("by_room", (q) => q.eq("projectId", projectId))
    .unique();
}

export async function requireProjectRow(
  ctx: ProjectRowReadCtx,
  projectId: string,
) {
  const project = await getProjectRow(ctx, projectId);
  if (!project) throw new Error("Project not found.");
  return project;
}

export async function ensureOwnedProjectRow(
  ctx: MutationCtx,
  projectId: string,
  userId: string,
) {
  // Convex OCC serializes this query-before-insert uniqueness invariant.
  const project = await getProjectRow(ctx, projectId);
  if (project) {
    if (project.ownerUserId !== userId) throw new Error("Project already exists.");
    const ownerships = await ctx.db
      .query("ownerships")
      .withIndex("by_room_owner", (q) => q.eq("projectId", projectId).eq("ownerUserId", userId))
      .collect();
    const marker = requireUnambiguousProjectOwnershipMarker(ownerships);
    if (!marker) {
      await ctx.db.insert("ownerships", { projectId, ownerUserId: userId });
    }
    return { status: "exists" as const, project };
  }

  const now = Date.now();
  const projectIdRow = await ctx.db.insert("projects", {
    projectId,
    ownerUserId: userId,
    name: "Untitled",
    createdAt: now,
    updatedAt: now,
    revision: 0,
    tempoBpm: 120,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    loopEnabled: false,
    loopStartSec: 0,
    loopEndSec: 8,
  });
  await ctx.db.insert("ownerships", { projectId, ownerUserId: userId });
  const created = await ctx.db.get(projectIdRow);
  if (!created) throw new Error("Project creation failed.");
  return { status: "created" as const, project: created };
}

export async function advanceProjectRevision(
  ctx: MutationCtx,
  projectId: string,
) {
  const project = await requireProjectRow(ctx, projectId);
  const updatedAt = Date.now();
  await ctx.db.patch(project._id, {
    revision: project.revision + 1,
    updatedAt,
  });
  return { revision: project.revision + 1, updatedAt };
}
