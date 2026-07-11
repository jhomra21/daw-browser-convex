import { mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import {
  automationTargetKey,
  getAutomationParameterDescriptor,
  normalizeAutomationPoints,
} from "@daw-browser/shared";
import { requireAuthenticatedUserId, requireProjectRole } from "./projectAccess";

const automationPointValidator = v.object({
  id: v.string(),
  timeSec: v.number(),
  value: v.number(),
  interpolation: v.union(v.literal("linear"), v.literal("hold")),
});

const targetKindValidator = v.union(v.literal("track"), v.literal("master"));

type AutomationIdentityFields = {
  targetKind: "track" | "master";
  trackId?: unknown;
  effectInstanceId?: string;
  parameterId: string;
};

type EffectIdentityFields = {
  instanceId?: string;
  targetType: string;
  trackId?: unknown;
  type: string;
};

export const selectLegacyEffectMigrationCandidate = <Effect extends EffectIdentityFields>(
  effects: Effect[],
  input: {
    targetKind: "track" | "master";
    trackId?: unknown;
    effectInstanceId: string;
    parameterOwner: string;
  },
) => {
  if (effects.some((effect) => effect.instanceId === input.effectInstanceId)) {
    throw new Error("Automation effect instance id is already owned by another effect.");
  }
  const candidates = effects.filter((effect) => (
    effect.instanceId === undefined
    && effect.targetType === input.targetKind
    && String(effect.trackId ?? "") === String(input.trackId ?? "")
    && effect.type === input.effectInstanceId
  ));
  if (candidates.length !== 1) {
    throw new Error("Automation effect instance does not belong to this target.");
  }
  const candidate = candidates[0];
  if (candidate.type !== input.parameterOwner) {
    throw new Error("Automation parameter does not belong to the referenced effect kind.");
  }
  return candidate;
};

export const hasSameStructuredAutomationIdentity = (
  row: AutomationIdentityFields,
  identity: AutomationIdentityFields,
) => (
  row.targetKind === identity.targetKind
  && String(row.trackId ?? "") === String(identity.trackId ?? "")
  && row.effectInstanceId === identity.effectInstanceId
  && row.parameterId === identity.parameterId
);

export const isUnambiguousLegacyAutomationIdentity = (row: AutomationIdentityFields) => {
  const descriptor = getAutomationParameterDescriptor(row.parameterId);
  return descriptor?.owner === "mixer" && row.effectInstanceId === undefined;
};

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
    throw new Error("Effect automation requires an effect instance.");
  }
  const trackId = input.targetKind === "track"
    ? await normalizeTrackId(ctx, input.projectId, input.trackId)
    : undefined;
  if (input.targetKind === "track" && !trackId) throw new Error("Track automation requires a track id.");
  if (input.effectInstanceId) {
    const effects = await ctx.db.query("effects").withIndex("by_room", (q) => q.eq("projectId", input.projectId)).collect();
    const storedEffects = effects.filter((entry) => entry.instanceId === input.effectInstanceId);
    if (storedEffects.length > 1) {
      throw new Error("Automation effect instance id is already owned by another effect.");
    }
    const storedEffect = storedEffects[0];
    if (storedEffect && (
      storedEffect.targetType !== input.targetKind
      || (input.targetKind === "track" && storedEffect.trackId !== trackId)
    )) {
      throw new Error("Automation effect instance does not belong to this target.");
    }
    const effect = storedEffect ?? selectLegacyEffectMigrationCandidate(effects, {
      targetKind: input.targetKind,
      trackId,
      effectInstanceId: input.effectInstanceId,
      parameterOwner: descriptor.owner,
    });
    if (effect.type !== descriptor.owner) {
      throw new Error("Automation parameter does not belong to the referenced effect kind.");
    }
    if (!storedEffect) await ctx.db.patch(effect._id, { instanceId: input.effectInstanceId });
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
    existingEnvelopeId: v.optional(v.string()),
    existingOpaqueIdentity: v.optional(v.string()),
  },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, input.projectId, userId, ["owner", "editor"]);
    if (input.existingEnvelopeId || input.existingOpaqueIdentity) {
      if (!input.existingEnvelopeId || !input.existingOpaqueIdentity) throw new Error("Existing automation identity is incomplete.");
      const rowId = ctx.db.normalizeId("automationEnvelopes", input.existingEnvelopeId);
      if (!rowId) throw new Error("Invalid automation envelope id.");
      const existing = await ctx.db.get(rowId);
      if (!existing || existing.projectId !== input.projectId || existing.targetKey !== input.existingOpaqueIdentity) {
        throw new Error("Automation envelope not found.");
      }
      const descriptor = getAutomationParameterDescriptor(existing.parameterId);
      if (!descriptor) throw new Error("Unsupported automation parameter.");
      await ctx.db.patch(rowId, {
        enabled: input.enabled,
        points: normalizeAutomationPoints(input.points, descriptor),
        updatedAt: input.updatedAt,
      });
      return rowId;
    }
    const normalized = await normalizeEnvelopeInput(ctx, input);
    const projectRows = await ctx.db.query("automationEnvelopes").withIndex("by_project", (q) => q.eq("projectId", input.projectId)).collect();
    const identity = {
      targetKind: input.targetKind,
      trackId: normalized.trackId,
      effectInstanceId: input.effectInstanceId,
      parameterId: input.parameterId,
    };
    const existingRows = projectRows.filter((row) => (
      hasSameStructuredAutomationIdentity(row, identity)
      && (row.targetKey === normalized.targetKey || isUnambiguousLegacyAutomationIdentity(row))
    ));
    const existing = existingRows.reduce<(typeof existingRows)[number] | undefined>((winner, row) => {
      if (!winner) return row;
      if (row.updatedAt !== winner.updatedAt) return row.updatedAt > winner.updatedAt ? row : winner;
      return String(row._id).localeCompare(String(winner._id)) < 0 ? row : winner;
    }, undefined);
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
      for (const duplicate of existingRows) {
        if (duplicate._id !== existing._id) await ctx.db.delete(duplicate._id);
      }
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
    existingEnvelopeId: v.optional(v.string()),
    existingOpaqueIdentity: v.optional(v.string()),
  },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, input.projectId, userId, ["owner", "editor"]);
    if (input.existingEnvelopeId || input.existingOpaqueIdentity) {
      if (!input.existingEnvelopeId || !input.existingOpaqueIdentity) throw new Error("Existing automation identity is incomplete.");
      const rowId = ctx.db.normalizeId("automationEnvelopes", input.existingEnvelopeId);
      if (!rowId) throw new Error("Invalid automation envelope id.");
      const existing = await ctx.db.get(rowId);
      if (!existing || existing.projectId !== input.projectId || existing.targetKey !== input.existingOpaqueIdentity) return null;
      await ctx.db.delete(rowId);
      return rowId;
    }
    const normalized = await normalizeEnvelopeInput(ctx, { ...input, points: [] });
    const projectRows = await ctx.db.query("automationEnvelopes").withIndex("by_project", (q) => q.eq("projectId", input.projectId)).collect();
    const identity = {
      targetKind: input.targetKind,
      trackId: normalized.trackId,
      effectInstanceId: input.effectInstanceId,
      parameterId: input.parameterId,
    };
    const existing = projectRows.filter((row) => (
      hasSameStructuredAutomationIdentity(row, identity)
      && (row.targetKey === normalized.targetKey || isUnambiguousLegacyAutomationIdentity(row))
    ));
    for (const row of existing) await ctx.db.delete(row._id);
    return existing[0]?._id ?? null;
  },
});
