import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const listByRoom = query({
  args: { roomId: v.string() },
  handler: async (ctx, { roomId }) => {
    return await ctx.db
      .query("clips")
      .withIndex("by_room", q => q.eq("roomId", roomId))
      .collect();
  },
});

export const create = mutation({
  args: {
    roomId: v.string(),
    trackId: v.id("tracks"),
    startSec: v.number(),
    duration: v.number(),
    userId: v.string(),
    name: v.optional(v.string()),
  },
  handler: async (ctx, { roomId, trackId, startSec, duration, userId, name }) => {
    // Validate that the track belongs to the same room
    const track = await ctx.db.get(trackId);
    if (!track || track.roomId !== roomId) return;

    const clipId = await ctx.db.insert("clips", { roomId, trackId, startSec, duration, name });

    // Record ownership
    await ctx.db.insert("ownerships", {
      roomId,
      ownerUserId: userId,
      clipId,
    });

    return clipId;
  },
});

export const move = mutation({
  args: {
    clipId: v.id("clips"),
    startSec: v.number(),
    toTrackId: v.optional(v.id("tracks")),
  },
  handler: async (ctx, { clipId, startSec, toTrackId }) => {
    const clip = await ctx.db.get(clipId);
    if (!clip) return;
    // If moving across tracks, ensure target track is in the same room
    if (toTrackId) {
      const targetTrack = await ctx.db.get(toTrackId);
      if (!targetTrack || targetTrack.roomId !== clip.roomId) {
        return; // ignore cross-room moves
      }
    }
    await ctx.db.patch(clipId, {
      startSec,
      trackId: toTrackId ?? clip.trackId,
    });
  },
});

export const remove = mutation({
  args: { clipId: v.id("clips"), userId: v.string() },
  handler: async (ctx, { clipId, userId }) => {
    const clip = await ctx.db.get(clipId);
    if (!clip) return;
    // Lookup ownership and enforce owner-only delete
    const owners = await ctx.db
      .query("ownerships")
      .withIndex("by_clip", q => q.eq("clipId", clipId))
      .collect();
    const owner = owners[0];
    if (!owner || owner.ownerUserId !== userId) return;

    // Delete ownership then the clip
    await ctx.db.delete(owner._id);
    await ctx.db.delete(clipId);
  },
});

// Update a clip's sampleUrl (R2-backed URL)
export const setSampleUrl = mutation({
  args: { clipId: v.id("clips"), sampleUrl: v.string() },
  handler: async (ctx, { clipId, sampleUrl }) => {
    const clip = await ctx.db.get(clipId);
    if (!clip) return;
    await ctx.db.patch(clipId, { sampleUrl });
  },
});

// Optionally update a clip's shared name
export const setName = mutation({
  args: { clipId: v.id("clips"), name: v.string() },
  handler: async (ctx, { clipId, name }) => {
    const clip = await ctx.db.get(clipId);
    if (!clip) return;
    await ctx.db.patch(clipId, { name });
  },
});

