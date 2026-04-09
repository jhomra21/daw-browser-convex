import type { Doc } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { deleteOwnedTrack, getTrackDeletePreflight } from "./tracks";
import { listAccessibleRooms } from "./roomAccess";

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
  destinationRoomId: string
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
  destinationRoomId: string,
): DeleteCurrentOwnedInRoomDeletedResult {
  return {
    status: "deleted",
    destinationRoomId,
  };
}

async function getOwnedRoomDeletePreflight(
  ctx: MutationCtx,
  roomId: string,
  userId: string,
) {
  const ownerships: Doc<"ownerships">[] = await ctx.db
    .query("ownerships")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
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
  roomId: string,
  userId: string,
) {
  const [projRows, ownershipRows]: [Doc<"projects">[], Doc<"ownerships">[]] = await Promise.all([
    ctx.db
      .query("projects")
      .withIndex("by_room_owner", (q) => q.eq("roomId", roomId).eq("ownerUserId", userId))
      .collect(),
    ctx.db
      .query("ownerships")
      .withIndex("by_room_owner", (q) => q.eq("roomId", roomId).eq("ownerUserId", userId))
      .collect(),
  ]);
  const markerOwnership = ownershipRows.find((ownership) => !ownership.trackId && !ownership.clipId);
  if (!projRows[0]) {
    await ctx.db.insert("projects", {
      roomId,
      ownerUserId: userId,
      name: "Untitled",
      createdAt: Date.now(),
    });
  }
  if (!markerOwnership) {
    await ctx.db.insert("ownerships", {
      roomId,
      ownerUserId: userId,
    });
  }
}

async function deleteOwnedRoomFromPreflight(
  ctx: MutationCtx,
  roomId: string,
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
    .withIndex("by_room_owner", (q) => q.eq("roomId", roomId).eq("ownerUserId", userId))
    .collect();
  for (const project of projects) {
    await ctx.db.delete(project._id);
  }
}

export const listMineDetailed = query({
  args: { userId: v.string() },
  returns: v.array(v.object({ roomId: v.string(), name: v.string() })),
  handler: async (ctx, { userId }) => {
    return listAccessibleRooms(ctx, userId);
  },
});

export const ensureOwnedRoom = mutation({
  args: { roomId: v.string(), userId: v.string() },
  returns: v.null(),
  handler: async (ctx, { roomId, userId }) => {
    await ensureOwnedRoomRecords(ctx, roomId, userId);
    return null;
  },
});

export const deleteOwnedInRoom = mutation({
  args: { roomId: v.string(), userId: v.string() },
  returns: v.object({
    status: v.union(v.literal("deleted"), v.literal("conflict")),
    conflictTrackIds: v.array(v.string()),
    conflicts: v.array(deleteConflict),
  }),
  handler: async (ctx, { roomId, userId }) => {
    const preflight = await getOwnedRoomDeletePreflight(ctx, roomId, userId);
    if (preflight.conflicts.length > 0) {
      return buildDeleteConflictResult(preflight);
    }
    await deleteOwnedRoomFromPreflight(ctx, roomId, preflight, userId);

    return buildDeleteOwnedInRoomDeletedResult();
  },
});

async function ensureDeleteDestinationRoom(
  ctx: MutationCtx,
  roomId: string,
  userId: string,
) {
  const alternateRoom = (await listAccessibleRooms(ctx, userId))
    .find((entry) => entry.roomId !== roomId);
  if (alternateRoom?.roomId) {
    return alternateRoom.roomId;
  }

  const destinationRoomId = crypto.randomUUID();
  await ensureOwnedRoomRecords(ctx, destinationRoomId, userId);
  return destinationRoomId;
}

export const deleteCurrentOwnedInRoom = mutation({
  args: { roomId: v.string(), userId: v.string() },
  returns: v.union(
    v.object({
      status: v.literal("deleted"),
      destinationRoomId: v.string(),
    }),
    v.object({
      status: v.literal("conflict"),
      conflictTrackIds: v.array(v.string()),
      conflicts: v.array(deleteConflict),
    }),
  ),
  handler: async (ctx, { roomId, userId }) => {
    const preflight = await getOwnedRoomDeletePreflight(ctx, roomId, userId);
    if (preflight.conflicts.length > 0) {
      return buildDeleteConflictResult(preflight);
    }

    const destinationRoomId = await ensureDeleteDestinationRoom(ctx, roomId, userId);
    await deleteOwnedRoomFromPreflight(ctx, roomId, preflight, userId);

    return buildDeleteCurrentOwnedInRoomDeletedResult(destinationRoomId);
  },
});

export const setName = mutation({
  args: { roomId: v.string(), userId: v.string(), name: v.string() },
  returns: v.null(),
  handler: async (ctx, { roomId, userId, name }) => {
    const trimmed = name.trim().slice(0, 120);
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_room_owner", (q) => q.eq("roomId", roomId).eq("ownerUserId", userId))
      .collect();
    const row = existing[0];
    if (row) {
      await ctx.db.patch(row._id, { name: trimmed.length ? trimmed : "Untitled" });
    } else {
      await ctx.db.insert("projects", {
        roomId,
        ownerUserId: userId,
        name: trimmed.length ? trimmed : "Untitled",
        createdAt: Date.now(),
      });
    }
    return null;
  },
});
