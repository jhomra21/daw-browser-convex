import { mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import {
  automationTargetKey,
  getAutomationParameterDescriptor,
  normalizeTrackInstrumentParams,
  normalizeAutomationPoints,
  parseInstrumentAutomationKey,
  parseGranularAutomationKey,
} from "@daw-browser/shared";
import { requireAuthenticatedUserId, requireProjectRole } from "./projectAccess";

const automationPointValidator = v.object({
  id: v.string(),
  timeSec: v.number(),
  value: v.number(),
  interpolation: v.union(v.literal("linear"), v.literal("hold")),
});

const targetKindValidator = v.union(v.literal("track"), v.literal("master"));

const normalizeTrackId = async (ctx: MutationCtx, projectId: string, trackId: string | undefined) => {
  if (!trackId) return undefined;
  const normalizedTrackId = ctx.db.normalizeId("tracks", trackId);
  if (!normalizedTrackId) throw new Error("Invalid automation track id.");
  const track = await ctx.db.get(normalizedTrackId);
  if (!track || track.projectId !== projectId) throw new Error("Automation track does not belong to this project.");
  return track._id;
};

const normalizeEnvelopeInput = async (
  ctx: MutationCtx,
  input: {
    projectId: string;
    targetKind: "track" | "master";
    trackId?: string;
    effectInstanceId?: string;
    parameterId: string;
    points: Array<{ id: string; timeSec: number; value: number; interpolation: "linear" | "hold" }>;
  },
) => {
  const descriptor = getAutomationParameterDescriptor(input.parameterId);
  if (!descriptor || !descriptor.targetKinds.includes(input.targetKind)) {
    throw new Error("Unsupported automation parameter.");
  }
  if (descriptor.owner === "mixer" && input.effectInstanceId) {
    throw new Error("Mixer automation cannot reference an effect instance.");
  }
  if (descriptor.owner !== "mixer" && !input.effectInstanceId) {
    if (descriptor.owner !== "sampler" && descriptor.owner !== "granular") throw new Error("Effect automation requires an effect instance.");
  }
  const trackId = input.targetKind === "track"
    ? await normalizeTrackId(ctx, input.projectId, input.trackId)
    : undefined;
  if (input.targetKind === "track" && !trackId) throw new Error("Track automation requires a track id.");
  const instrumentKey = parseInstrumentAutomationKey(input.parameterId);
  const granularKey = parseGranularAutomationKey(input.parameterId);
  const instrumentAutomation = instrumentKey ?? granularKey;
  if (instrumentAutomation) {
    if (input.targetKind !== "track" || input.effectInstanceId || instrumentAutomation.trackId !== String(trackId)) {
      throw new Error("Instrument automation identity does not match its target.");
    }
    const instrumentRows = await ctx.db.query("effects").withIndex("by_track", (q) => q.eq("trackId", trackId)).collect();
    const instrumentRow = instrumentRows.find((entry) => entry.type === "instrument");
    const instrument = instrumentRow ? normalizeTrackInstrumentParams(instrumentRow.params) : undefined;
    if (
      !instrument
      || instrument.instanceId !== instrumentAutomation.instanceId
      || instrument.kind !== (granularKey ? "granular" : "sampler")
    ) {
      throw new Error("Instrument automation instance does not belong to this track.");
    }
  }
  if (input.effectInstanceId) {
    const effects = input.targetKind === "master"
      ? await ctx.db.query("effects").withIndex("by_room_target", (q) => (
        q.eq("projectId", input.projectId).eq("targetType", "master")
      )).collect()
      : await ctx.db.query("effects").withIndex("by_track", (q) => q.eq("trackId", trackId)).collect();
    const effect = effects.find((entry) => (
      entry.targetType === input.targetKind
      && entry.instanceId === input.effectInstanceId
      && entry.type === descriptor.owner
      && (input.targetKind === "master" || entry.trackId === trackId)
    ));
    if (!effect) throw new Error("Automation effect instance does not belong to this target.");
  }
  const targetKey = input.targetKind === "master"
    ? automationTargetKey({ kind: "master", effectInstanceId: input.effectInstanceId }, input.parameterId)
    : automationTargetKey({ kind: "track", trackId: String(trackId), effectInstanceId: input.effectInstanceId }, input.parameterId);
  return {
    trackId,
    targetKey,
    points: normalizeAutomationPoints(input.points, descriptor),
  };
};

export const listByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, projectId, userId, ["owner", "editor", "viewer"]);
    return await ctx.db.query("automationEnvelopes").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect();
  },
});

export const serverSetEnvelope = mutation({
  args: {
    projectId: v.string(),
    targetKind: targetKindValidator,
    trackId: v.optional(v.string()),
    effectInstanceId: v.optional(v.string()),
    parameterId: v.string(),
    enabled: v.boolean(),
    points: v.array(automationPointValidator),
    updatedAt: v.number(),
  },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, input.projectId, userId, ["owner", "editor"]);
    const normalized = await normalizeEnvelopeInput(ctx, input);
    const existing = await ctx.db.query("automationEnvelopes")
      .withIndex("by_project_target_key", (q) => q.eq("projectId", input.projectId).eq("targetKey", normalized.targetKey))
      .unique();
    const row = {
      projectId: input.projectId,
      targetKind: input.targetKind,
      trackId: normalized.trackId,
      effectInstanceId: input.effectInstanceId,
      targetKey: normalized.targetKey,
      parameterId: input.parameterId,
      enabled: input.enabled,
      points: normalized.points,
      updatedAt: input.updatedAt,
    };
    if (existing) {
      await ctx.db.patch(existing._id, row);
      return existing._id;
    }
    return await ctx.db.insert("automationEnvelopes", row);
  },
});

export const serverDeleteEnvelope = mutation({
  args: {
    projectId: v.string(),
    targetKind: targetKindValidator,
    trackId: v.optional(v.string()),
    effectInstanceId: v.optional(v.string()),
    parameterId: v.string(),
  },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, input.projectId, userId, ["owner", "editor"]);
    const normalized = await normalizeEnvelopeInput(ctx, { ...input, points: [] });
    const existing = await ctx.db.query("automationEnvelopes")
      .withIndex("by_project_target_key", (q) => q.eq("projectId", input.projectId).eq("targetKey", normalized.targetKey))
      .unique();
    if (!existing) return null;
    await ctx.db.delete(existing._id);
    return existing._id;
  },
});
