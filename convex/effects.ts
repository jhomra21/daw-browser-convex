import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAuthenticatedUserId, requireMasterBusWriteAccess, requireProjectAccess } from "./projectAccess";
import { getTrackWriteAccess } from "./trackWrites";
import { normalizeReverbParams, normalizeSynthParams } from "@daw-browser/shared";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const reverbParamsValidator = v.object({
  enabled: v.boolean(),
  wet: v.number(),
  decaySec: v.number(),
  preDelayMs: v.number(),
  reflections: v.optional(v.number()),
  reflectionSpin: v.optional(v.boolean()),
  reflectionModAmountMs: v.optional(v.number()),
  reflectionModRateHz: v.optional(v.number()),
  reflectionShape: v.optional(v.number()),
  diffuse: v.optional(v.number()),
  size: v.optional(v.number()),
  diffusion: v.optional(v.number()),
  density: v.optional(v.number()),
  lowCutHz: v.optional(v.number()),
  highCutHz: v.optional(v.number()),
  diffusionLowCutHz: v.optional(v.number()),
  diffusionHighCutHz: v.optional(v.number()),
  stereoWidth: v.optional(v.number()),
})

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
    enabled: params.enabled,
    pattern: params.pattern,
    rate: params.rate,
    octaves,
    gate,
    hold: params.hold,
  }
}

const upsertTrackEffect = async (
  ctx: any,
  input: {
    projectId: string
    userId: string
    trackId: any
    type: 'synth' | 'arpeggiator' | 'reverb' | 'eq'
    params: unknown
  },
) => {
  const access = await getTrackWriteAccess(ctx, input.trackId, input.userId)
  if (!access || access.track.projectId !== input.projectId) return
  const existing = await ctx.db.query('effects').withIndex('by_track', (q: any) => q.eq('trackId', input.trackId)).collect()
  const byIndex = existing.sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0))
  const row = byIndex.find((entry: any) => entry.type === input.type) ?? null
  if (row) {
    await ctx.db.patch(row._id, { params: input.params, targetType: 'track' })
    return row._id
  }
  return await ctx.db.insert('effects', {
    projectId: input.projectId,
    targetType: 'track',
    trackId: input.trackId,
    index: existing.length,
    type: input.type,
    params: input.params,
    createdAt: Date.now(),
  })
}

const upsertMasterEffect = async (
  ctx: any,
  input: {
    projectId: string
    userId: string
    type: 'reverb' | 'eq'
    params: unknown
  },
) => {
  await requireMasterBusWriteAccess(ctx, input.projectId, input.userId)
  const existing = await ctx.db.query('effects').withIndex('by_room', (q: any) => q.eq('projectId', input.projectId)).collect()
  const byIndex = existing.sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0))
  const row = byIndex.find((entry: any) => entry.type === input.type && entry.targetType === 'master') ?? null
  if (row) {
    await ctx.db.patch(row._id, { params: input.params, targetType: 'master' })
    return row._id
  }
  return await ctx.db.insert('effects', {
    projectId: input.projectId,
    targetType: 'master',
    index: existing.filter((entry: any) => entry.targetType === 'master').length,
    type: input.type,
    params: input.params,
    createdAt: Date.now(),
  })
}

const getTrackEffect = async (
  ctx: any,
  input: {
    projectId: string
    trackId: any
    userId: string
    type: 'synth' | 'arpeggiator' | 'reverb' | 'eq'
  },
) => {
  const access = await getTrackWriteAccess(ctx, input.trackId, input.userId)
  if (!access || access.track.projectId !== input.projectId) return null
  const rows = await ctx.db
    .query("effects")
    .withIndex("by_track", (q: any) => q.eq("trackId", input.trackId))
    .collect();
  rows.sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0));
  return rows.find((row: any) => row.type === input.type && row.targetType === 'track') ?? null;
}

// Return the EQ effect row for a track if it exists (we use a single EQ per track for now)
export const listByRoom = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectAccess(ctx, projectId, userId);
    const rows = await ctx.db
      .query("effects")
      .withIndex("by_room", q => q.eq("projectId", projectId))
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
  args: { projectId: v.string(), trackId: v.id("tracks") },
  handler: async (ctx, { projectId, trackId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return await getTrackEffect(ctx, { projectId, trackId, userId, type: "eq" });
  },
});

// Synth: get synth row for a track
export const getSynthForTrack = query({
  args: { projectId: v.string(), trackId: v.id('tracks') },
  handler: async (ctx, { projectId, trackId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return await getTrackEffect(ctx, { projectId, trackId, userId, type: 'synth' });
  },
})

// Arpeggiator: get arpeggiator row for a track
export const getArpeggiatorForTrack = query({
  args: { projectId: v.string(), trackId: v.id('tracks') },
  handler: async (ctx, { projectId, trackId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return await getTrackEffect(ctx, { projectId, trackId, userId, type: 'arpeggiator' });
  },
})

// Synth: set or create synth params for a track
export const setSynthParams = mutation({
  args: {
    projectId: v.string(),
    trackId: v.id('tracks'),
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
  handler: async (ctx, { projectId, trackId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const sanitized = normalizeSynthParams(params)
    return await upsertTrackEffect(ctx, { projectId, userId, trackId, type: 'synth', params: sanitized })
  },
})

// Arpeggiator: set or create arpeggiator params for a track
export const setArpeggiatorParams = mutation({
  args: {
    projectId: v.string(),
    trackId: v.id('tracks'),
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
  handler: async (ctx, { projectId, trackId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const sanitized = sanitizeArpParams(params)
    return await upsertTrackEffect(ctx, { projectId, userId, trackId, type: 'arpeggiator', params: sanitized })
  },
})

// Set or create the Reverb params for a given track
export const setReverbParams = mutation({
  args: {
    projectId: v.string(),
    trackId: v.id("tracks"),
    params: reverbParamsValidator,
  },
  handler: async (ctx, { projectId, trackId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return await upsertTrackEffect(ctx, { projectId, userId, trackId, type: 'reverb', params: normalizeReverbParams(params) });
  },
});

export const setMasterReverbParams = mutation({
  args: {
    projectId: v.string(),
    params: reverbParamsValidator,
  },
  handler: async (ctx, { projectId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    return await upsertMasterEffect(ctx, { projectId, userId, type: 'reverb', params: normalizeReverbParams(params) })
  },
});

// Master-level EQ (per room)
export const getEqForMaster = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectAccess(ctx, projectId, userId);
    const rows = await ctx.db
      .query("effects")
      .withIndex("by_room", q => q.eq("projectId", projectId))
      .collect();
    rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return rows.find(r => r.type === 'eq' && r.targetType === 'master') ?? null;
  },
});

// Reverb: get first reverb row for a track
export const getReverbForTrack = query({
  args: { projectId: v.string(), trackId: v.id("tracks") },
  handler: async (ctx, { projectId, trackId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return await getTrackEffect(ctx, { projectId, trackId, userId, type: "reverb" });
  },
});

// Reverb: get first master reverb row for room
export const getReverbForMaster = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectAccess(ctx, projectId, userId);
    const rows = await ctx.db
      .query("effects")
      .withIndex("by_room", q => q.eq("projectId", projectId))
      .collect();
    rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return rows.find(r => r.type === 'reverb' && r.targetType === 'master') ?? null;
  },
});

// Set or create the EQ params for a given track. We enforce ownership based on the track owner.
export const setEqParams = mutation({
  args: {
    projectId: v.string(),
    trackId: v.id("tracks"),
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
  handler: async (ctx, { projectId, trackId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return await upsertTrackEffect(ctx, { projectId, userId, trackId, type: 'eq', params });
  },
});

// Set or create the EQ params for the room master bus. We enforce that the user owns the project for this room.
export const setMasterEqParams = mutation({
  args: {
    projectId: v.string(),
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
  handler: async (ctx, { projectId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    return await upsertMasterEffect(ctx, { projectId, userId, type: 'eq', params })
  }
})

export const serverSetSynthParams = mutation({
  args: {
    projectId: v.string(),
    trackId: v.string(),
    params: v.object({
      wave1: v.union(v.literal('sine'), v.literal('square'), v.literal('sawtooth'), v.literal('triangle')),
      wave2: v.union(v.literal('sine'), v.literal('square'), v.literal('sawtooth'), v.literal('triangle')),
      gain: v.optional(v.number()),
      attackMs: v.optional(v.number()),
      releaseMs: v.optional(v.number()),
    }),
  },
  handler: async (ctx, { projectId, trackId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const normalizedTrackId = ctx.db.normalizeId('tracks', trackId)
    if (!normalizedTrackId) return
    const sanitized = normalizeSynthParams(params)
    return await upsertTrackEffect(ctx, { projectId, userId, trackId: normalizedTrackId, type: 'synth', params: sanitized })
  },
})

export const serverSetArpeggiatorParams = mutation({
  args: {
    projectId: v.string(),
    trackId: v.string(),
    params: v.object({
      enabled: v.boolean(),
      pattern: v.union(v.literal('up'), v.literal('down'), v.literal('updown'), v.literal('random')),
      rate: v.union(v.literal('1/4'), v.literal('1/8'), v.literal('1/16'), v.literal('1/32')),
      octaves: v.number(),
      gate: v.number(),
      hold: v.boolean(),
    }),
  },
  handler: async (ctx, { projectId, trackId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const normalizedTrackId = ctx.db.normalizeId('tracks', trackId)
    if (!normalizedTrackId) return
    const sanitized = sanitizeArpParams(params)
    return await upsertTrackEffect(ctx, { projectId, userId, trackId: normalizedTrackId, type: 'arpeggiator', params: sanitized })
  },
})

export const serverSetReverbParams = mutation({
  args: {
    projectId: v.string(),
    trackId: v.string(),
    params: reverbParamsValidator,
  },
  handler: async (ctx, { projectId, trackId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const normalizedTrackId = ctx.db.normalizeId('tracks', trackId)
    if (!normalizedTrackId) return
    return await upsertTrackEffect(ctx, { projectId, userId, trackId: normalizedTrackId, type: 'reverb', params: normalizeReverbParams(params) })
  },
})

export const serverSetEqParams = mutation({
  args: {
    projectId: v.string(),
    trackId: v.string(),
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
  handler: async (ctx, { projectId, trackId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    const normalizedTrackId = ctx.db.normalizeId('tracks', trackId)
    if (!normalizedTrackId) return
    return await upsertTrackEffect(ctx, { projectId, userId, trackId: normalizedTrackId, type: 'eq', params })
  },
})

export const serverSetMasterReverbParams = mutation({
  args: {
    projectId: v.string(),
    params: reverbParamsValidator,
  },
  handler: async (ctx, { projectId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    return await upsertMasterEffect(ctx, { projectId, userId, type: 'reverb', params: normalizeReverbParams(params) })
  },
})

export const serverSetMasterEqParams = mutation({
  args: {
    projectId: v.string(),
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
  handler: async (ctx, { projectId, params }) => {
    const userId = await requireAuthenticatedUserId(ctx)
    return await upsertMasterEffect(ctx, { projectId, userId, type: 'eq', params })
  },
})
