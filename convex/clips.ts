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
      // Block moving audio clips into instrument tracks
      const isInstrument = (targetTrack as any).kind === 'instrument'
      const isAudioClip = (clip as any).midi === undefined || (clip as any).midi === null
      if (isInstrument && isAudioClip) {
        return; // disallow placing audio clips on instrument tracks
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

    const owners = await ctx.db
      .query("ownerships")
      .withIndex("by_clip", q => q.eq("clipId", clipId))
      .collect();
    const owner = owners[0];
    if (!owner) return;

    const existingSamples = await ctx.db
      .query("samples")
      .withIndex("by_room_url", q => q.eq("roomId", clip.roomId).eq("url", sampleUrl))
      .collect();

    const sampleRow = existingSamples[0];
    if (sampleRow) {
      const patch: Partial<typeof sampleRow> = {};
      if (!sampleRow.name && clip.name) {
        patch.name = clip.name;
      }
      if (sampleRow.duration === undefined && typeof clip.duration === "number") {
        patch.duration = clip.duration;
      }
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(sampleRow._id, patch);
      }
    } else {
      await ctx.db.insert("samples", {
        roomId: clip.roomId,
        url: sampleUrl,
        name: clip.name,
        duration: clip.duration,
        ownerUserId: owner.ownerUserId,
        createdAt: Date.now(),
      });
    }
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


// Update timing (startSec and duration) for a clip
export const setTiming = mutation({
  args: { clipId: v.id("clips"), startSec: v.number(), duration: v.number(), leftPadSec: v.optional(v.number()) },
  handler: async (ctx, { clipId, startSec, duration, leftPadSec }) => {
    const clip = await ctx.db.get(clipId)
    if (!clip) return
    // Sanity clamps
    const safeStart = Math.max(0, startSec)
    const safeDuration = Math.max(0, duration)
    const safePad = typeof leftPadSec === 'number' && isFinite(leftPadSec) ? Math.max(0, leftPadSec) : undefined
    await ctx.db.patch(clipId, { startSec: safeStart, duration: safeDuration, ...(safePad !== undefined ? { leftPadSec: safePad } : {}) })
  },
});

// Set or update MIDI payload for a clip
export const setMidi = mutation({
  args: {
    clipId: v.id('clips'),
    midi: v.object({
      wave: v.string(),
      gain: v.optional(v.number()),
      notes: v.array(v.object({
        beat: v.number(),
        length: v.number(),
        pitch: v.number(),
        velocity: v.optional(v.number()),
      })),
    }),
    userId: v.string(),
  },
  handler: async (ctx, { clipId, midi, userId }) => {
    const clip = await ctx.db.get(clipId)
    if (!clip) return
    const track = await ctx.db.get(clip.trackId)
    if (!track || (track as any).kind === 'audio') return

    const owners = await ctx.db
      .query('ownerships')
      .withIndex('by_clip', q => q.eq('clipId', clipId))
      .collect()
    const owner = owners[0]
    if (!owner || owner.ownerUserId !== userId) return

    await ctx.db.patch(clipId, { midi })
  },
})

