import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireMasterBusWriteAccess } from "./roomAccess";
import { getTrackWriteAccess } from "./trackWrites";
import { normalizeSynthParams } from "../src/lib/effects/params";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const sanitizeArpParams = (params: {
  enabled: boolean
  pattern: 'up' | 'down' | 'updown' | 'random'
  rate: '1/4' | '1/8' | '1/16' | '1/32'
  octaves: number
  gate: number
  hold: boolean
}) => {
  const octaves = clamp(Math.round(params.octaves) || 1, 1, 4)
  const gate = clamp(Math.round(params.gate * 100) / 100 || 0.8, 0.1, 1.0)
  return {
    enabled: !!params.enabled,
    pattern: params.pattern,
    rate: params.rate,
    octaves,
    gate,
    hold: !!params.hold,
  }
}

// Return the EQ effect row for a track if it exists (we use a single EQ per track for now)
export const listByRoom = query({
  args: { roomId: v.string() },
  handler: async (ctx, { roomId }) => {
    const rows = await ctx.db
      .query("effects")
      .withIndex("by_room", q => q.eq("roomId", roomId))
      .collect();
    rows.sort((a, b) => {
      if ((a.targetType ?? '') !== (b.targetType ?? '')) return (a.targetType ?? '').localeCompare(b.targetType ?? '');
      if (String(a.trackId ?? '') !== String(b.trackId ?? '')) return String(a.trackId ?? '').localeCompare(String(b.trackId ?? ''));
      return (a.index ?? 0) - (b.index ?? 0);
    });
    return rows;
  },
});

export const getEqForTrack = query({
  args: { trackId: v.id("tracks") },
  handler: async (ctx, { trackId }) => {
    const rows = await ctx.db
      .query("effects")
      .withIndex("by_track", q => q.eq("trackId", trackId))
      .collect();
    rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return rows.find(r => r.type === "eq" && r.targetType === 'track') ?? null;
  },
});

// Synth: get synth row for a track
export const getSynthForTrack = query({
  args: { trackId: v.id('tracks') },
  handler: async (ctx, { trackId }) => {
    const rows = await ctx.db
      .query('effects')
      .withIndex('by_track', q => q.eq('trackId', trackId))
      .collect();
    rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return rows.find(r => r.type === 'synth' && r.targetType === 'track') ?? null;
  },
})

// Arpeggiator: get arpeggiator row for a track
export const getArpeggiatorForTrack = query({
  args: { trackId: v.id('tracks') },
  handler: async (ctx, { trackId }) => {
    const rows = await ctx.db
      .query('effects')
      .withIndex('by_track', q => q.eq('trackId', trackId))
      .collect();
    rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return rows.find(r => r.type === 'arpeggiator' && r.targetType === 'track') ?? null;
  },
})

// Synth: set or create synth params for a track
export const setSynthParams = mutation({
  args: {
    roomId: v.string(),
    trackId: v.id('tracks'),
    userId: v.string(),
    params: v.object({
      wave1: v.union(
        v.literal('sine'),
        v.literal('square'),
        v.literal('sawtooth'),
        v.literal('triangle'),
      ),
      wave2: v.union(
        v.literal('sine'),
        v.literal('square'),
        v.literal('sawtooth'),
        v.literal('triangle'),
      ),
      gain: v.optional(v.number()),
      attackMs: v.optional(v.number()),
      releaseMs: v.optional(v.number()),
    }),
  },
  handler: async (ctx, { roomId, trackId, userId, params }) => {
    const sanitized = normalizeSynthParams(params)
    const access = await getTrackWriteAccess(ctx, trackId, userId)
    if (!access || access.track.roomId !== roomId) return

    const existing = await ctx.db
      .query('effects')
      .withIndex('by_track', q => q.eq('trackId', trackId))
      .collect();
    const byIndex = existing.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    const row = byIndex.find(r => r.type === 'synth') ?? null
    if (row) {
      await ctx.db.patch(row._id, { params: sanitized, targetType: 'track' })
      return row._id
    }
    const newIndex = existing.length
    const id = await ctx.db.insert('effects', {
      roomId,
      targetType: 'track',
      trackId,
      index: newIndex,
      type: 'synth',
      params: sanitized,
      createdAt: Date.now(),
    })
    return id
  },
})

// Arpeggiator: set or create arpeggiator params for a track
export const setArpeggiatorParams = mutation({
  args: {
    roomId: v.string(),
    trackId: v.id('tracks'),
    userId: v.string(),
    params: v.object({
      enabled: v.boolean(),
      pattern: v.union(
        v.literal('up'),
        v.literal('down'),
        v.literal('updown'),
        v.literal('random'),
      ),
      rate: v.union(
        v.literal('1/4'),
        v.literal('1/8'),
        v.literal('1/16'),
        v.literal('1/32'),
      ),
      octaves: v.number(), // 1-4
      gate: v.number(), // 0.1-1.0
      hold: v.boolean(), // Keep arpeggiation looping until clip ends
    }),
  },
  handler: async (ctx, { roomId, trackId, userId, params }) => {
    const sanitized = sanitizeArpParams(params)
    const access = await getTrackWriteAccess(ctx, trackId, userId)
    if (!access || access.track.roomId !== roomId) return

    const existing = await ctx.db
      .query('effects')
      .withIndex('by_track', q => q.eq('trackId', trackId))
      .collect();
    const byIndex = existing.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    const row = byIndex.find(r => r.type === 'arpeggiator') ?? null
    if (row) {
      await ctx.db.patch(row._id, { params: sanitized, targetType: 'track' })
      return row._id
    }
    const newIndex = existing.length
    const id = await ctx.db.insert('effects', {
      roomId,
      targetType: 'track',
      trackId,
      index: newIndex,
      type: 'arpeggiator',
      params: sanitized,
      createdAt: Date.now(),
    })
    return id
  },
})

// Set or create the Reverb params for a given track
export const setReverbParams = mutation({
  args: {
    roomId: v.string(),
    trackId: v.id("tracks"),
    userId: v.string(),
    params: v.object({
      enabled: v.boolean(),
      wet: v.number(), // 0..1
      decaySec: v.number(), // 0.1..10
      preDelayMs: v.number(), // 0..200
    }),
  },
  handler: async (ctx, { roomId, trackId, userId, params }) => {
    const access = await getTrackWriteAccess(ctx, trackId, userId);
    if (!access || access.track.roomId !== roomId) return;

    const existing = await ctx.db
      .query("effects")
      .withIndex("by_track", q => q.eq("trackId", trackId))
      .collect();
    const byIndex = existing.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const row = byIndex.find(r => r.type === "reverb") ?? null;
    if (row) {
      await ctx.db.patch(row._id, { params, targetType: 'track' });
      return row._id;
    }
    const newIndex = existing.length;
    const id = await ctx.db.insert("effects", {
      roomId,
      targetType: 'track',
      trackId,
      index: newIndex,
      type: "reverb",
      params,
      createdAt: Date.now(),
    });
    return id;
  },
});

export const setMasterReverbParams = mutation({
  args: {
    roomId: v.string(),
    userId: v.string(),
    params: v.object({
      enabled: v.boolean(),
      wet: v.number(),
      decaySec: v.number(),
      preDelayMs: v.number(),
    }),
  },
  handler: async (ctx, { roomId, userId, params }) => {
    await requireMasterBusWriteAccess(ctx, roomId, userId)

    const existing = await ctx.db
      .query('effects')
      .withIndex('by_room', q => q.eq('roomId', roomId))
      .collect();
    const byIndex = existing.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const row = byIndex.find(r => r.type === 'reverb' && r.targetType === 'master') ?? null;
    if (row) {
      await ctx.db.patch(row._id, { params });
      return row._id;
    }
    const countMaster = existing.filter(r => r.targetType === 'master').length;
    const id = await ctx.db.insert('effects', {
      roomId,
      targetType: 'master',
      index: countMaster,
      type: 'reverb',
      params,
      createdAt: Date.now(),
    });
    return id;
  },
});

// Master-level EQ (per room)
export const getEqForMaster = query({
  args: { roomId: v.string() },
  handler: async (ctx, { roomId }) => {
    const rows = await ctx.db
      .query("effects")
      .withIndex("by_room", q => q.eq("roomId", roomId))
      .collect();
    rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return rows.find(r => r.type === 'eq' && r.targetType === 'master') ?? null;
  },
});

// Reverb: get first reverb row for a track
export const getReverbForTrack = query({
  args: { trackId: v.id("tracks") },
  handler: async (ctx, { trackId }) => {
    const rows = await ctx.db
      .query("effects")
      .withIndex("by_track", q => q.eq("trackId", trackId))
      .collect();
    rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return rows.find(r => r.type === "reverb" && r.targetType === 'track') ?? null;
  },
});

// Reverb: get first master reverb row for room
export const getReverbForMaster = query({
  args: { roomId: v.string() },
  handler: async (ctx, { roomId }) => {
    const rows = await ctx.db
      .query("effects")
      .withIndex("by_room", q => q.eq("roomId", roomId))
      .collect();
    rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return rows.find(r => r.type === 'reverb' && r.targetType === 'master') ?? null;
  },
});

// Set or create the EQ params for a given track. We enforce ownership based on the track owner.
export const setEqParams = mutation({
  args: {
    roomId: v.string(),
    trackId: v.id("tracks"),
    userId: v.string(),
    params: v.object({
      enabled: v.boolean(),
      bands: v.array(v.object({
        id: v.string(),
        type: v.string(),
        frequency: v.number(),
        gainDb: v.number(),
        q: v.number(),
        enabled: v.boolean(),
      })),
    }),
  },
  handler: async (ctx, { roomId, trackId, userId, params }) => {
    const access = await getTrackWriteAccess(ctx, trackId, userId);
    if (!access || access.track.roomId !== roomId) return;

    const existing = await ctx.db
      .query("effects")
      .withIndex("by_track", q => q.eq("trackId", trackId))
      .collect();
    const byIndex = existing.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const eqRow = byIndex.find(r => r.type === "eq") ?? null;

    if (eqRow) {
      await ctx.db.patch(eqRow._id, { params, targetType: 'track' });
      return eqRow._id;
    }

    // Insert as index 0; if there are other effects, append at current length
    const newIndex = existing.length; // append
    const id = await ctx.db.insert("effects", {
      roomId,
      targetType: 'track',
      trackId,
      index: newIndex,
      type: "eq",
      params,
      createdAt: Date.now(),
    });
    return id;
  },
});

// Set or create the EQ params for the room master bus. We enforce that the user owns the project for this room.
export const setMasterEqParams = mutation({
  args: {
    roomId: v.string(),
    userId: v.string(),
    params: v.object({
      enabled: v.boolean(),
      bands: v.array(v.object({
        id: v.string(),
        type: v.string(),
        frequency: v.number(),
        gainDb: v.number(),
        q: v.number(),
        enabled: v.boolean(),
      })),
    }),
  },
  handler: async (ctx, { roomId, userId, params }) => {
    await requireMasterBusWriteAccess(ctx, roomId, userId)

    // Find existing master EQ
    const existing = await ctx.db
      .query('effects')
      .withIndex('by_room', q => q.eq('roomId', roomId))
      .collect();
    const byIndex = existing.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const eqRow = byIndex.find(r => r.type === 'eq' && r.targetType === 'master') ?? null;

    if (eqRow) {
      await ctx.db.patch(eqRow._id, { params, targetType: 'master' });
      return eqRow._id;
    }

    const countMaster = existing.filter(r => r.targetType === 'master').length;
    const id = await ctx.db.insert('effects', {
      roomId,
      targetType: 'master',
      index: countMaster,
      type: 'eq',
      params,
      createdAt: Date.now(),
    });
    return id;
  }
})
