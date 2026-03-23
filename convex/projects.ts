import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { deleteOwnedTrack, getTrackDeletePreflight } from "./tracks";
import { listAccessibleRooms } from "./roomAccess";

const deleteConflictReason = v.union(
  v.literal("foreign-clips"),
  v.literal("not-empty"),
);

const deleteConflict = v.object({
  trackId: v.string(),
  reason: deleteConflictReason,
});

async function getOwnedRoomDeletePreflight(
  ctx: any,
  roomId: string,
  userId: string,
) {
  const ownerships = await ctx.db
    .query("ownerships")
    .withIndex("by_room", (q: any) => q.eq("roomId", roomId))
    .collect();
  const ownedTrackOwnerships = ownerships.filter((ownership: any) => ownership.ownerUserId === userId && ownership.trackId);
  const ownedClipOwnerships = ownerships.filter((ownership: any) => ownership.ownerUserId === userId && ownership.clipId);
  const markerOwnerships = ownerships.filter((ownership: any) => ownership.ownerUserId === userId && !ownership.trackId && !ownership.clipId);

  const conflictsByTrackId = new Map<string, {
    trackId: string;
    reason: "foreign-clips" | "not-empty";
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

export const listMineDetailed = query({
  args: { userId: v.string() },
  returns: v.array(v.object({ roomId: v.string(), name: v.string() })),
  handler: async (ctx, { userId }) => {
    return await listAccessibleRooms(ctx, userId);
  },
});

export const ensureOwnedRoom = mutation({
  args: { roomId: v.string(), userId: v.string() },
  returns: v.null(),
  handler: async (ctx, { roomId, userId }) => {
    const [projRows, ownershipRows] = await Promise.all([
      ctx.db
        .query("projects")
        .withIndex("by_room_owner", (q) => q.eq("roomId", roomId).eq("ownerUserId", userId))
        .collect(),
      ctx.db
        .query("ownerships")
        .withIndex("by_room_owner", (q) => q.eq("roomId", roomId).eq("ownerUserId", userId))
        .collect(),
    ]);
    if (!projRows[0]) {
      await ctx.db.insert("projects", {
        roomId,
        ownerUserId: userId,
        name: "Untitled",
        createdAt: Date.now(),
      });
    }
    if (!ownershipRows[0]) {
      await ctx.db.insert("ownerships", {
        roomId,
        ownerUserId: userId,
      });
    }
    return null;
  },
});

export const preflightDeleteOwnedInRoom = query({
  args: { roomId: v.string(), userId: v.string() },
  returns: v.object({
    status: v.union(v.literal("ok"), v.literal("conflict")),
    conflictTrackIds: v.array(v.string()),
    conflicts: v.array(deleteConflict),
  }),
  handler: async (ctx, { roomId, userId }) => {
    const preflight = await getOwnedRoomDeletePreflight(ctx, roomId, userId);
    return {
      status: preflight.conflicts.length > 0 ? "conflict" as const : "ok" as const,
      conflictTrackIds: preflight.conflictTrackIds,
      conflicts: preflight.conflicts,
    };
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
      return {
        status: "conflict" as const,
        conflictTrackIds: preflight.conflictTrackIds,
        conflicts: preflight.conflicts,
      };
    }

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

    const projects = await ctx.db
      .query("projects")
      .withIndex("by_room_owner", (q) => q.eq("roomId", roomId).eq("ownerUserId", userId))
      .collect();
    if (projects[0]) {
      await ctx.db.delete(projects[0]._id);
    }

    return {
      status: "deleted" as const,
      conflictTrackIds: [],
      conflicts: [],
    };
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
