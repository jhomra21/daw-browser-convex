import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  automationTargetKey,
  getAutomationParameterDescriptor,
  normalizeTrackInstrumentParams,
  normalizeAutomationPoints,
  parseJsonValue,
  parseInstrumentAutomationKey,
  parseGranularAutomationKey,
  parseSynthAutomationKey,
} from "@daw-browser/shared";
import { requireAuthenticatedUserId, requireProjectRole } from "./projectAccess";
import { advanceProjectRevision } from "./projectRows";

type InstrumentEffectRow = {
  type: string;
  instanceId?: string;
  params: unknown;
};

type SetAutomationEnvelopeRowResult = {
  changed: boolean;
  status: "created" | "updated" | "noop";
  envelopeId: Id<"automationEnvelopes">;
};

type DeleteAutomationEnvelopeRowResult = {
  changed: boolean;
  status: "deleted" | "not-found";
  envelopeId?: Id<"automationEnvelopes">;
};

export const readAutomationTrackInstrument = (rows: readonly InstrumentEffectRow[]) => {
  const instrumentRow = rows.find((entry) => entry.type === "instrument");
  if (instrumentRow) return normalizeTrackInstrumentParams(parseJsonValue(instrumentRow.params) ?? null);
  const legacySynthRow = rows.find((entry) => entry.type === "synth");
  return legacySynthRow
    ? normalizeTrackInstrumentParams({
        kind: "synth",
        instanceId: legacySynthRow.instanceId ?? null,
        params: parseJsonValue(legacySynthRow.params) ?? null,
      })
    : undefined;
};

const automationPointValidator = v.object({
  id: v.string(),
  timeSec: v.number(),
  value: v.number(),
  interpolation: v.union(v.literal("linear"), v.literal("hold")),
});

const targetKindValidator = v.union(v.literal("track"), v.literal("master"));

const resolveAutomationTrackId = async (ctx: MutationCtx, projectId: string, trackId: string | undefined) => {
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
    trackId?: Id<"tracks">;
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
    if (descriptor.owner !== "sampler" && descriptor.owner !== "granular" && descriptor.owner !== "synth") throw new Error("Effect automation requires an effect instance.");
  }
  const trackId = input.targetKind === "track" ? input.trackId : undefined;
  if (input.targetKind === "track" && !trackId) throw new Error("Track automation requires a track id.");
  const instrumentKey = parseInstrumentAutomationKey(input.parameterId);
  const granularKey = parseGranularAutomationKey(input.parameterId);
  const synthKey = parseSynthAutomationKey(input.parameterId);
  const instrumentAutomation = instrumentKey ?? granularKey ?? synthKey;
  if (instrumentAutomation) {
    if (input.targetKind !== "track" || input.effectInstanceId || instrumentAutomation.trackId !== String(trackId)) {
      throw new Error("Instrument automation identity does not match its target.");
    }
    const instrumentRows = await ctx.db.query("effects").withIndex("by_track", (q) => q.eq("trackId", trackId)).collect();
    const instrument = readAutomationTrackInstrument(instrumentRows);
    if (
      !instrument
      || instrument.instanceId !== instrumentAutomation.instanceId
      || instrument.kind !== (granularKey ? "granular" : synthKey ? "synth" : "sampler")
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

const sameEnvelopeState = (
  existing: {
    targetKind: "track" | "master";
    trackId?: unknown;
    effectInstanceId?: string;
    targetKey: string;
    parameterId: string;
    enabled: boolean;
    points: Array<{ id: string; timeSec: number; value: number; interpolation: "linear" | "hold" }>;
  },
  next: {
    targetKind: "track" | "master";
    trackId?: unknown;
    effectInstanceId?: string;
    targetKey: string;
    parameterId: string;
    enabled: boolean;
    points: Array<{ id: string; timeSec: number; value: number; interpolation: "linear" | "hold" }>;
  },
) => (
  existing.targetKind === next.targetKind
  && String(existing.trackId ?? "") === String(next.trackId ?? "")
  && existing.effectInstanceId === next.effectInstanceId
  && existing.targetKey === next.targetKey
  && existing.parameterId === next.parameterId
  && existing.enabled === next.enabled
  && existing.points.length === next.points.length
  && existing.points.every((point, index) => {
    const nextPoint = next.points[index];
    return nextPoint !== undefined
      && point.id === nextPoint.id
      && point.timeSec === nextPoint.timeSec
      && point.value === nextPoint.value
      && point.interpolation === nextPoint.interpolation;
  })
);

export const setAutomationEnvelopeRow = async (
  ctx: MutationCtx,
  input: {
    projectId: string;
    targetKind: "track" | "master";
    trackId?: Id<"tracks">;
    effectInstanceId?: string;
    parameterId: string;
    enabled: boolean;
    points: Array<{ id: string; timeSec: number; value: number; interpolation: "linear" | "hold" }>;
  },
): Promise<SetAutomationEnvelopeRowResult> => {
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
  };
  if (existing) {
    if (sameEnvelopeState(existing, row)) {
      return { changed: false, status: "noop", envelopeId: existing._id };
    }
    await ctx.db.patch(existing._id, { ...row, updatedAt: Date.now() });
    return { changed: true, status: "updated", envelopeId: existing._id };
  }
  return {
    changed: true,
    status: "created",
    envelopeId: await ctx.db.insert("automationEnvelopes", { ...row, updatedAt: Date.now() }),
  };
};

export const deleteAutomationEnvelopeRow = async (
  ctx: MutationCtx,
  input: {
    projectId: string;
    targetKind: "track" | "master";
    trackId?: Id<"tracks">;
    effectInstanceId?: string;
    parameterId: string;
  },
): Promise<DeleteAutomationEnvelopeRowResult> => {
  const normalized = await normalizeEnvelopeInput(ctx, { ...input, points: [] });
  const existing = await ctx.db.query("automationEnvelopes")
    .withIndex("by_project_target_key", (q) => q.eq("projectId", input.projectId).eq("targetKey", normalized.targetKey))
    .unique();
  if (!existing) return { changed: false, status: "not-found" };
  await ctx.db.delete(existing._id);
  return { changed: true, status: "deleted", envelopeId: existing._id };
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
    const trackId = input.targetKind === "track"
      ? await resolveAutomationTrackId(ctx, input.projectId, input.trackId)
      : undefined;
    const result = await setAutomationEnvelopeRow(ctx, { ...input, trackId });
    if (result.changed) await advanceProjectRevision(ctx, input.projectId);
    return result.envelopeId;
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
    const trackId = input.targetKind === "track"
      ? await resolveAutomationTrackId(ctx, input.projectId, input.trackId)
      : undefined;
    const result = await deleteAutomationEnvelopeRow(ctx, { ...input, trackId });
    if (result.changed) await advanceProjectRevision(ctx, input.projectId);
    return result.envelopeId ?? null;
  },
});
