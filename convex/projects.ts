import type { Doc } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { deleteOwnedTrack, getTrackDeletePreflight } from "./tracks";
import { listAccessibleProjects } from "./projectAccess";

type DeleteConflictReason = "foreign-clips" | "not-empty" | "locked";

const deleteConflictReason = v.union(
  v.literal("foreign-clips"),
  v.literal("not-empty"),
  v.literal("locked"),
);

const deleteConflict = v.object({
  trackId: v.string(),
  reason: deleteConflictReason,
});

type DeleteConflict = {
  trackId: string
  reason: DeleteConflictReason
}

type DeleteOwnedInRoomConflictResult = {
  status: "conflict"
  conflictTrackIds: string[]
  conflicts: DeleteConflict[]
}

type DeleteOwnedInRoomDeletedResult = {
  status: "deleted"
  conflictTrackIds: string[]
  conflicts: DeleteConflict[]
}

type DeleteCurrentOwnedInRoomDeletedResult = {
  status: "deleted"
  destinationProjectId: string
}

function buildDeleteConflictResult(
  preflight: Pick<Awaited<ReturnType<typeof getOwnedRoomDeletePreflight>>, "conflictTrackIds" | "conflicts">,
): DeleteOwnedInRoomConflictResult {
  return {
    status: "conflict",
    conflictTrackIds: preflight.conflictTrackIds,
    conflicts: preflight.conflicts,
  };
}

function buildDeleteOwnedInRoomDeletedResult(): DeleteOwnedInRoomDeletedResult {
  return {
    status: "deleted",
    conflictTrackIds: [],
    conflicts: [],
  };
}

function buildDeleteCurrentOwnedInRoomDeletedResult(
  destinationProjectId: string,
): DeleteCurrentOwnedInRoomDeletedResult {
  return {
    status: "deleted",
    destinationProjectId,
  };
}

async function getOwnedRoomDeletePreflight(
  ctx: MutationCtx,
  projectId: string,
  userId: string,
) {
  const ownerships: Doc<"ownerships">[] = await ctx.db
    .query("ownerships")
    .withIndex("by_room", (q) => q.eq("projectId", projectId))
    .collect();
  const ownedTrackOwnerships: Doc<"ownerships">[] = [];
  const ownedClipOwnerships: Doc<"ownerships">[] = [];
  const markerOwnerships: Doc<"ownerships">[] = [];

  for (const ownership of ownerships) {
    if (ownership.ownerUserId !== userId) continue;
    if (ownership.trackId) {
      ownedTrackOwnerships.push(ownership);
      continue;
    }
    if (ownership.clipId) {
      ownedClipOwnerships.push(ownership);
      continue;
    }
    markerOwnerships.push(ownership);
  }

  const conflictsByTrackId = new Map<string, {
    trackId: string;
    reason: DeleteConflictReason;
  }>();

  for (const ownership of ownedTrackOwnerships) {
    const trackId = ownership.trackId;
    if (!trackId) continue;

    const preflight = await getTrackDeletePreflight(ctx, trackId, userId, {
      onlyIfEmpty: true,
      assumeOwnedClipsRemoved: true,
    });
    if (preflight.ok || preflight.reason === "access-denied") continue;

    const trackKey = String(trackId);
    if (conflictsByTrackId.has(trackKey)) continue;

    conflictsByTrackId.set(trackKey, {
      trackId: trackKey,
      reason: preflight.reason,
    });
  }

  const conflicts = Array.from(conflictsByTrackId.values())
    .sort((left, right) => left.trackId.localeCompare(right.trackId));

  return {
    conflicts,
    conflictTrackIds: conflicts.map((conflict) => conflict.trackId),
    ownedTrackOwnerships,
    ownedClipOwnerships,
    markerOwnerships,
  };
}

async function ensureOwnedRoomRecords(
  ctx: MutationCtx,
  projectId: string,
  userId: string,
) {
  const [projRows, ownershipRows]: [Doc<"projects">[], Doc<"ownerships">[]] = await Promise.all([
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

async function deleteOwnedRoomFromPreflight(
  ctx: MutationCtx,
  projectId: string,
  preflight: Awaited<ReturnType<typeof getOwnedRoomDeletePreflight>>,
  userId: string,
) {
  for (const ownership of preflight.ownedClipOwnerships) {
    const clipId = ownership.clipId;
    if (!clipId) continue;
    const clip = await ctx.db.get(clipId);
    if (clip) {
      await ctx.db.delete(clip._id);
    }
    await ctx.db.delete(ownership._id);
  }

  for (const ownership of preflight.ownedTrackOwnerships) {
    const trackId = ownership.trackId;
    if (!trackId) continue;
    const track = await ctx.db.get(trackId);
    if (!track) {
      await ctx.db.delete(ownership._id);
      continue;
    }
    const removed = await deleteOwnedTrack(ctx, trackId, userId, { onlyIfEmpty: true });
    if (!removed) {
      throw new Error("Unable to remove an owned track during project cleanup.");
    }
  }

  for (const ownership of preflight.markerOwnerships) {
    await ctx.db.delete(ownership._id);
  }

  const projects: Doc<"projects">[] = await ctx.db
    .query("projects")
    .withIndex("by_room_owner", (q) => q.eq("projectId", projectId).eq("ownerUserId", userId))
    .collect();
  for (const project of projects) {
    await ctx.db.delete(project._id);
  }
}

export const listMineDetailed = query({
  args: { userId: v.string() },
  returns: v.array(v.object({ projectId: v.string(), name: v.string() })),
  handler: async (ctx, { userId }) => {
    return listAccessibleProjects(ctx, userId);
  },
});

export const ensureOwnedRoom = mutation({
  args: { projectId: v.string(), userId: v.string() },
  returns: v.null(),
  handler: async (ctx, { projectId, userId }) => {
    await ensureOwnedRoomRecords(ctx, projectId, userId);
    return null;
  },
});

export const deleteOwnedInRoom = mutation({
  args: { projectId: v.string(), userId: v.string() },
  returns: v.object({
    status: v.union(v.literal("deleted"), v.literal("conflict")),
    conflictTrackIds: v.array(v.string()),
    conflicts: v.array(deleteConflict),
  }),
  handler: async (ctx, { projectId, userId }) => {
    const preflight = await getOwnedRoomDeletePreflight(ctx, projectId, userId);
    if (preflight.conflicts.length > 0) {
      return buildDeleteConflictResult(preflight);
    }
    await deleteOwnedRoomFromPreflight(ctx, projectId, preflight, userId);

    return buildDeleteOwnedInRoomDeletedResult();
  },
});

async function ensureDeleteDestinationRoom(
  ctx: MutationCtx,
  projectId: string,
  userId: string,
) {
  const alternateRoom = (await listAccessibleProjects(ctx, userId))
    .find((entry) => entry.projectId !== projectId);
  if (alternateRoom?.projectId) {
    return alternateRoom.projectId;
  }

  const destinationProjectId = crypto.randomUUID();
  await ensureOwnedRoomRecords(ctx, destinationProjectId, userId);
  return destinationProjectId;
}

export const deleteCurrentOwnedInRoom = mutation({
  args: { projectId: v.string(), userId: v.string() },
  returns: v.union(
    v.object({
      status: v.literal("deleted"),
      destinationProjectId: v.string(),
    }),
    v.object({
      status: v.literal("conflict"),
      conflictTrackIds: v.array(v.string()),
      conflicts: v.array(deleteConflict),
    }),
  ),
  handler: async (ctx, { projectId, userId }) => {
    const preflight = await getOwnedRoomDeletePreflight(ctx, projectId, userId);
    if (preflight.conflicts.length > 0) {
      return buildDeleteConflictResult(preflight);
    }

    const destinationProjectId = await ensureDeleteDestinationRoom(ctx, projectId, userId);
    await deleteOwnedRoomFromPreflight(ctx, projectId, preflight, userId);

    return buildDeleteCurrentOwnedInRoomDeletedResult(destinationProjectId);
  },
});

export const setName = mutation({
  args: { projectId: v.string(), userId: v.string(), name: v.string() },
  returns: v.null(),
  handler: async (ctx, { projectId, userId, name }) => {
    const trimmed = name.trim().slice(0, 120);
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_room_owner", (q) => q.eq("projectId", projectId).eq("ownerUserId", userId))
      .collect();
    const row = existing[0];
    if (row) {
      await ctx.db.patch(row._id, { name: trimmed.length ? trimmed : "Untitled" });
    } else {
      await ctx.db.insert("projects", {
        projectId,
        ownerUserId: userId,
        name: trimmed.length ? trimmed : "Untitled",
        createdAt: Date.now(),
      });
    }
    return null;
  },
});
