import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const sanitizeSynthParams = (params: { wave: 'sine' | 'square' | 'sawtooth' | 'triangle'; gain?: number; attackMs?: number; releaseMs?: number }) => {
  const gain = clamp(typeof params.gain === 'number' ? params.gain : 0.8, 0, 1.5)
  const attackMs = clamp(typeof params.attackMs === 'number' ? params.attackMs : 5, 0, 200)
  const releaseMs = clamp(typeof params.releaseMs === 'number' ? params.releaseMs : 30, 0, 200)
  return {
    wave: params.wave,
    gain,
    attackMs,
    releaseMs,
  }
}

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
export const getEqForTrack = query({
  args: { trackId: v.id("tracks") },
  handler: async (ctx, { trackId }) => {
    const rows = await ctx.db
      .query("effects")
      .withIndex("by_track", q => q.eq("trackId", trackId))
      .collect();
    // Prefer the first EQ by index; treat missing targetType as 'track' for backward-compat
    rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return rows.find(r => r.type === "eq" && ((r as any).targetType === 'track' || (r as any).targetType === undefined)) ?? null;
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
    return rows.find(r => r.type === 'synth' && ((r as any).targetType === 'track' || (r as any).targetType === undefined)) ?? null;
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
    return rows.find(r => r.type === 'arpeggiator' && ((r as any).targetType === 'track' || (r as any).targetType === undefined)) ?? null;
  },
})

// Synth: set or create synth params for a track
export const setSynthParams = mutation({
  args: {
    roomId: v.string(),
    trackId: v.id('tracks'),
    userId: v.string(),
    params: v.object({
      wave: v.union(
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
    const sanitized = sanitizeSynthParams(params)
    const track = await ctx.db.get(trackId)
    if (!track || track.roomId !== roomId) return

    // owner only
    const owners = await ctx.db
      .query('ownerships')
      .withIndex('by_track', q => q.eq('trackId', trackId))
      .collect();
    const owner = owners[0]
    if (!owner || owner.ownerUserId !== userId) return

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
    const track = await ctx.db.get(trackId)
    if (!track || track.roomId !== roomId) return

    // owner only
    const owners = await ctx.db
      .query('ownerships')
      .withIndex('by_track', q => q.eq('trackId', trackId))
      .collect();
    const owner = owners[0]
    if (!owner || owner.ownerUserId !== userId) return

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
    const track = await ctx.db.get(trackId);
    if (!track || track.roomId !== roomId) return;

    // Enforce ownership
    const owners = await ctx.db
      .query("ownerships")
      .withIndex("by_track", q => q.eq("trackId", trackId))
      .collect();
    const owner = owners[0];
    if (!owner || owner.ownerUserId !== userId) return;

    const existing = await ctx.db
      .query("effects")
      .withIndex("by_track", q => q.eq("trackId", trackId))
      .collect();
    const byIndex = existing.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const row = byIndex.find(r => r.type === "reverb") ?? null;
    if (row) {
      await ctx.db.patch(row._id, { params });
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

// Set or create the Reverb params for the room master bus
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
    // Enforce that the user owns a project entry for this room
    const projs = await ctx.db
      .query('projects')
      .withIndex('by_room_owner', q => q.eq('roomId', roomId).eq('ownerUserId', userId))
      .collect();
    const proj = projs[0]
    if (!proj) return

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
  }
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
    return rows.find(r => r.type === "reverb" && ((r as any).targetType === 'track' || (r as any).targetType === undefined)) ?? null;
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
    // Validate that the track belongs to the same room
    const track = await ctx.db.get(trackId);
    if (!track || track.roomId !== roomId) return;

    // Enforce ownership
    const owners = await ctx.db
      .query("ownerships")
      .withIndex("by_track", q => q.eq("trackId", trackId))
      .collect();
    const owner = owners[0];
    if (!owner || owner.ownerUserId !== userId) return;

    // Find existing EQ for this track
    const existing = await ctx.db
      .query("effects")
      .withIndex("by_track", q => q.eq("trackId", trackId))
      .collect();
    const byIndex = existing.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const eqRow = byIndex.find(r => r.type === "eq") ?? null;

    if (eqRow) {
      await ctx.db.patch(eqRow._id, { params });
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
    // Enforce that the user owns a project entry for this room
    const projs = await ctx.db
      .query('projects')
      .withIndex('by_room_owner', q => q.eq('roomId', roomId).eq('ownerUserId', userId))
      .collect();
    const proj = projs[0]
    if (!proj) return

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
