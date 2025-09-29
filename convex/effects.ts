import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

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
      wave: v.string(),
      gain: v.optional(v.number()),
      attackMs: v.optional(v.number()),
      releaseMs: v.optional(v.number()),
    }),
  },
  handler: async (ctx, { roomId, trackId, userId, params }) => {
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
      await ctx.db.patch(row._id, { params, targetType: 'track' })
      return row._id
    }
    const newIndex = existing.length
    const id = await ctx.db.insert('effects', {
      roomId,
      targetType: 'track',
      trackId,
      index: newIndex,
      type: 'synth',
      params,
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
      pattern: v.string(), // 'up' | 'down' | 'updown' | 'random'
      rate: v.string(), // '1/4' | '1/8' | '1/16' | '1/32'
      octaves: v.number(), // 1-4
      gate: v.number(), // 0.1-1.0
      hold: v.boolean(), // Keep arpeggiation looping until clip ends
    }),
  },
  handler: async (ctx, { roomId, trackId, userId, params }) => {
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
      await ctx.db.patch(row._id, { params, targetType: 'track' })
      return row._id
    }
    const newIndex = existing.length
    const id = await ctx.db.insert('effects', {
      roomId,
      targetType: 'track',
      trackId,
      index: newIndex,
      type: 'arpeggiator',
      params,
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
