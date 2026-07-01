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
    parameterId: string;
    points: Array<{ id: string; timeSec: number; value: number; interpolation: "linear" | "hold" }>;
  },
) => {
  const descriptor = getAutomationParameterDescriptor(input.parameterId);
  if (!descriptor || !descriptor.targetKinds.includes(input.targetKind)) {
    throw new Error("Unsupported automation parameter.");
  }
  const trackId = input.targetKind === "track"
    ? await normalizeTrackId(ctx, input.projectId, input.trackId)
    : undefined;
  if (input.targetKind === "track" && !trackId) throw new Error("Track automation requires a track id.");
  const targetKey = input.targetKind === "master"
    ? automationTargetKey({ kind: "master" }, input.parameterId)
    : automationTargetKey({ kind: "track", trackId: String(trackId) }, input.parameterId);
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
    parameterId: v.string(),
    enabled: v.boolean(),
    points: v.array(automationPointValidator),
    updatedAt: v.number(),
  },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, input.projectId, userId, ["owner", "editor"]);
    const normalized = await normalizeEnvelopeInput(ctx, input);
    const existing = await ctx.db
      .query("automationEnvelopes")
      .withIndex("by_project_target_key", (q) => q.eq("projectId", input.projectId).eq("targetKey", normalized.targetKey))
      .first();
    const row = {
      projectId: input.projectId,
      targetKind: input.targetKind,
      trackId: normalized.trackId,
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
    parameterId: v.string(),
  },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, input.projectId, userId, ["owner", "editor"]);
    const normalized = await normalizeEnvelopeInput(ctx, { ...input, points: [] });
    const existing = await ctx.db
      .query("automationEnvelopes")
      .withIndex("by_project_target_key", (q) => q.eq("projectId", input.projectId).eq("targetKey", normalized.targetKey))
      .first();
    if (!existing) return null;
    await ctx.db.delete(existing._id);
    return existing._id;
  },
});
