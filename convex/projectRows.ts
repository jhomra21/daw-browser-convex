import type { DatabaseReader, MutationCtx } from "./_generated/server";
import { DEFAULT_BPM, DEFAULT_LOOP } from "@daw-browser/timeline-core/project-defaults";
import { hasActiveR2DeleteRows } from "./r2Deletes";

type ProjectRowReadCtx = { db: DatabaseReader };

export type ProjectEdit = {
  revision: number;
  stamp: () => number;
};

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

export async function withProjectEdit<Value>(
  ctx: MutationCtx,
  projectId: string,
  run: (edit: ProjectEdit) => Promise<Value>,
): Promise<Value> {
  const project = await requireProjectRow(ctx, projectId);
  const revision = project.revision + 1;
  let stamped = false;

  try {
    return await run({
      revision,
      stamp: () => {
        stamped = true;

        return revision;
      },
    });
  } finally {
    if (stamped) await ctx.db.patch(project._id, { revision, updatedAt: Date.now() });
  }
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

  if (await hasActiveR2DeleteRows(ctx, projectId)) {
    throw new Error("Project storage cleanup is still pending.");
  }

  const now = Date.now();

  const projectIdRow = await ctx.db.insert("projects", {
    projectId,
    storageNamespace: crypto.randomUUID(),
    ownerUserId: userId,
    name: "Untitled",
    createdAt: now,
    updatedAt: now,
    revision: 0,
    tempoBpm: DEFAULT_BPM,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    loopEnabled: DEFAULT_LOOP.enabled,
    loopStartSec: DEFAULT_LOOP.startSec,
    loopEndSec: DEFAULT_LOOP.endSec,
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
