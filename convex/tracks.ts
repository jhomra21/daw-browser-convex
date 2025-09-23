import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const listByRoom = query({
  args: { roomId: v.string() },
  handler: async (ctx, { roomId }) => {
    const tracks = await ctx.db
      .query("tracks")
      .withIndex("by_room", q => q.eq("roomId", roomId))
      .collect();
    tracks.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return tracks;
  },
});

export const create = mutation({
  args: { roomId: v.string(), userId: v.string() },
  handler: async (ctx, { roomId, userId }) => {
    // Compute next index in room
    const existing = await ctx.db
      .query("tracks")
      .withIndex("by_room", q => q.eq("roomId", roomId))
      .collect();
    const nextIndex = existing.length;

    const trackId = await ctx.db.insert("tracks", {
      roomId,
      index: nextIndex,
      volume: 0.8,
    });
    // Record ownership
    await ctx.db.insert("ownerships", {
      roomId,
      ownerUserId: userId,
      trackId,
    });
    return trackId;
  },
});

export const setVolume = mutation({
  args: { trackId: v.id("tracks"), volume: v.number() },
  handler: async (ctx, { trackId, volume }) => {
    await ctx.db.patch(trackId, { volume });
  },
});

export const setMix = mutation({
  args: { trackId: v.id("tracks"), muted: v.optional(v.boolean()), soloed: v.optional(v.boolean()), userId: v.string() },
  handler: async (ctx, { trackId, muted, soloed, userId }) => {
    // Only the owner of the track may update shared mix state
    const owners = await ctx.db
      .query("ownerships")
      .withIndex("by_track", q => q.eq("trackId", trackId))
      .collect();
    const owner = owners[0];
    if (!owner || owner.ownerUserId !== userId) return;
    const patch: any = {};
    if (typeof muted === 'boolean') patch.muted = muted;
    if (typeof soloed === 'boolean') patch.soloed = soloed;
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(trackId, patch);
    }
  },
});

export const remove = mutation({
  args: { trackId: v.id("tracks"), userId: v.string() },
  handler: async (ctx, { trackId, userId }) => {
    const track = await ctx.db.get(trackId);
    if (!track) return;
    // Verify track ownership
    const owners = await ctx.db
      .query("ownerships")
      .withIndex("by_track", q => q.eq("trackId", trackId))
      .collect();
    const owner = owners[0];
    if (!owner || owner.ownerUserId !== userId) return;

    // Ensure all clips on this track are owned by the same session
    const clips = await ctx.db
      .query("clips")
      .withIndex("by_track", q => q.eq("trackId", trackId))
      .collect();
    for (const c of clips) {
      const cOwners = await ctx.db
        .query("ownerships")
        .withIndex("by_clip", q => q.eq("clipId", c._id))
        .collect();
      const cOwner = cOwners[0];
      if (!cOwner || cOwner.ownerUserId !== userId) {
        return; // contains clips not owned by requester; abort
      }
    }

    // Delete all clip ownerships and clips
    for (const c of clips) {
      const cOwners = await ctx.db
        .query("ownerships")
        .withIndex("by_clip", q => q.eq("clipId", c._id))
        .collect();
      const cOwner = cOwners[0];
      if (cOwner) await ctx.db.delete(cOwner._id);
      await ctx.db.delete(c._id);
    }
    // Delete track ownership then the track
    await ctx.db.delete(owner._id);
    await ctx.db.delete(trackId);
  },
});

