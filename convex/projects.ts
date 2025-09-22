import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

// List distinct roomIds for a given owner (Better Auth userId)
export const listMine = query({
  args: { userId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, { userId }) => {
    const owned = await ctx.db
      .query("ownerships")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", userId))
      .collect();

    const rooms = new Set<string>();
    for (const o of owned) {
      rooms.add(o.roomId);
    }

    // Return deterministic order for convenience
    return Array.from(rooms).sort();
  },
});

// Ensure the user has an ownership marker in a room so it appears in listMine.
// This creates a placeholder ownership row without clipId/trackId.
export const ensureOwnedRoom = mutation({
  args: { roomId: v.string(), userId: v.string() },
  returns: v.null(),
  handler: async (ctx, { roomId, userId }) => {
    // Does an ownership by this user in this room exist already?
    const existing = await ctx.db
      .query("ownerships")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .collect();
    const has = existing.some((o) => o.ownerUserId === userId);
    if (!has) {
      await ctx.db.insert("ownerships", {
        roomId,
        ownerUserId: userId,
        // clipId and trackId left undefined as a marker
      } as any);
    }
    return null;
  },
});

// Delete all content owned by the user within a room and remove their ownerships.
// This is safe for a shared room: it only removes the caller's owned items.
export const deleteOwnedInRoom = mutation({
  args: { roomId: v.string(), userId: v.string() },
  returns: v.null(),
  handler: async (ctx, { roomId, userId }) => {
    // 1) Delete owned clips first
    const clips = await ctx.db
      .query("clips")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .collect();
    for (const clip of clips) {
      const owners = await ctx.db
        .query("ownerships")
        .withIndex("by_clip", (q) => q.eq("clipId", clip._id))
        .collect();
      const owner = owners[0];
      if (owner && owner.ownerUserId === userId) {
        await ctx.db.delete(owner._id);
        await ctx.db.delete(clip._id);
      }
    }

    // 2) Delete owned tracks that are now empty
    const tracks = await ctx.db
      .query("tracks")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .collect();
    for (const track of tracks) {
      const owners = await ctx.db
        .query("ownerships")
        .withIndex("by_track", (q) => q.eq("trackId", track._id))
        .collect();
      const owner = owners[0];
      if (owner && owner.ownerUserId === userId) {
        const remainingClips = await ctx.db
          .query("clips")
          .withIndex("by_track", (q) => q.eq("trackId", track._id))
          .collect();
        if (remainingClips.length === 0) {
          await ctx.db.delete(owner._id);
          await ctx.db.delete(track._id);
        }
      }
    }

    // 3) Remove any stray ownership rows by this user within the room
    const ownerships = await ctx.db
      .query("ownerships")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .collect();
    for (const o of ownerships) {
      if (o.ownerUserId === userId) {
        await ctx.db.delete(o._id);
      }
    }

    return null;
  },
});
