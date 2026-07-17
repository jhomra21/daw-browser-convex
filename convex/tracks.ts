import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  buildMixerChannelInsert,
  deleteMixerStateForTrack,
  ensureMixerChannelForTrack,
  listProjectTracksWithMixerChannels,
  normalizeMixerLockState,
  removeTrackRoutingReferences,
  removeTracksRoutingReferences,
} from "./mixerChannels";
import {
  sanitizeChannelRole,
  sanitizeTrackRouting,
} from "./trackRouting";
import { getTrackWriteAccess, requireTrackOwnerForWrite } from "./trackWrites";
import { getClipWriteAccess } from "./clipWrites";
import { requireAuthenticatedUserId, requireProjectAccess, requireProjectRole } from "./projectAccess";
import { runSharedOperationOnce } from "./sharedOperationResults";
import { advanceProjectRevision } from "./projectRows";
import { effectiveControlMixerBoolean } from "./controlEffectiveValues";
import { automationTargetKey, canonicalTrackCreation, collectTrackDescendantIds, granularAutomationKey, hasTrackGroupCycle, hasValidReturnTrackPartition, instrumentAutomationKey, isHexColor, normalizeClipColor, normalizeSharedUngroupRestoreAutomation, normalizeSharedUngroupRestoreEffects, parseGranularAutomationKey, parseInstrumentAutomationKey, parseSynthAutomationKey, sidechainEligibilityError, sidechainTargetEligibilityError, synthAutomationKey, trackCreationCollapsed } from "@daw-browser/shared";

type DeleteOwnedTrackOptions = {
  onlyIfEmpty?: boolean
  assumeOwnedClipsRemoved?: boolean
}

const trackDeleteConflictReason = v.union(
  v.literal("foreign-clips"),
  v.literal("not-empty"),
  v.literal("locked"),
)

const rebaseRestoredAutomationParameter = (trackId: string, parameterId: string) => {
  const samplerKey = parseInstrumentAutomationKey(parameterId);
  if (samplerKey) return instrumentAutomationKey(trackId, samplerKey.instanceId, samplerKey.parameterId);
  const granularKey = parseGranularAutomationKey(parameterId);
  if (granularKey) return granularAutomationKey(trackId, granularKey.instanceId, granularKey.parameterId);
  const synthKey = parseSynthAutomationKey(parameterId);
  if (synthKey) return synthAutomationKey(trackId, synthKey.instanceId, synthKey.parameterId);
  return parameterId;
};

const trackDeleteResult = v.union(
  v.object({
    status: v.literal("deleted"),
  }),
  v.object({
    status: v.literal("access-denied"),
  }),
  v.object({
    status: v.literal("conflict"),
    reason: trackDeleteConflictReason,
  }),
)

const trackMixWriteResult = v.union(
  v.object({
    status: v.literal("applied"),
  }),
  v.object({
    status: v.literal("access-denied"),
  }),
  v.object({
    status: v.literal("not-found"),
  }),
  v.object({
    status: v.literal("noop"),
  }),
)

type TrackDeletePreflight =
  | {
      ok: true
      owner: any
      track: any
      clips: any[]
      clipOwnersByClipId: Map<string, any>
    }
  | {
      ok: false
      reason: "access-denied" | "not-empty" | "foreign-clips" | "locked"
    }

export async function getTrackDeletePreflight(
  ctx: any,
  trackId: any,
  userId: string,
  options?: DeleteOwnedTrackOptions,
): Promise<TrackDeletePreflight> {
  const access = await getTrackWriteAccess(ctx, trackId, userId);
  if (!access) {
    return { ok: false, reason: "access-denied" };
  }

  const { owner, track, projectWriter } = access;
  const channel = await ensureMixerChannelForTrack(ctx, track);
  const lockState = normalizeMixerLockState(channel.lockedBy, channel.lockedAt);
  if (lockState.isLocked) {
    return { ok: false, reason: "locked" };
  }
  const clips = await ctx.db
    .query("clips")
    .withIndex("by_track", (q: any) => q.eq("trackId", trackId))
    .collect();
  const clipOwnerships = clips.length === 0
    ? []
    : await Promise.all(
      clips.map((clip: any) =>
        ctx.db
          .query("ownerships")
          .withIndex("by_clip", (q: any) => q.eq("clipId", clip._id))
          .first(),
      ),
    );

  const clipOwnersByClipId = new Map<string, any>();
  let remainingClipCount = 0;
  let hasForeignClips = false;
  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index];
    const clipOwner = clipOwnerships[index] ?? null;
    const ownedByUser = projectWriter || (!!clipOwner && clipOwner.ownerUserId === userId);
    clipOwnersByClipId.set(String(clip._id), clipOwner);
    if (!ownedByUser) {
      hasForeignClips = true;
    }
    if (!options?.assumeOwnedClipsRemoved || !ownedByUser) {
      remainingClipCount += 1;
    }
  }

  if (options?.onlyIfEmpty && remainingClipCount > 0) {
    return {
      ok: false,
      reason: hasForeignClips ? "foreign-clips" : "not-empty",
    };
  }

  if (!options?.onlyIfEmpty && hasForeignClips) {
    return { ok: false, reason: "foreign-clips" };
  }

  return {
    ok: true,
    owner,
    track,
    clips,
    clipOwnersByClipId,
  };
}

async function deleteTrackEntitiesFromPreflight(
  ctx: any,
  preflight: Extract<TrackDeletePreflight, { ok: true }>,
  options?: DeleteOwnedTrackOptions,
) {
  const { owner, track, clips, clipOwnersByClipId } = preflight;

  if (options?.onlyIfEmpty) {
    if (clips.length > 0) return false;
  } else {
    for (const clip of clips) {
      const clipOwner = clipOwnersByClipId.get(String(clip._id));
      if (clipOwner) await ctx.db.delete(clipOwner._id);
      await ctx.db.delete(clip._id);
    }
  }

  const automationEnvelopes = await ctx.db
    .query("automationEnvelopes")
    .withIndex("by_project_track", (q: any) => q.eq("projectId", track.projectId).eq("trackId", track._id))
    .collect();
  for (const envelope of automationEnvelopes) {
    await ctx.db.delete(envelope._id);
  }
  const effects = await ctx.db
    .query("effects")
    .withIndex("by_track", (q: any) => q.eq("trackId", track._id))
    .collect();
  for (const effect of effects) {
    await ctx.db.delete(effect._id);
  }
  const [sourceSidechains, targetSidechains] = await Promise.all([
    ctx.db.query("sidechainRoutes").withIndex("by_source", (q: any) => q.eq("sourceTrackId", track._id)).collect(),
    ctx.db.query("sidechainRoutes").withIndex("by_target", (q: any) => q.eq("targetTrackId", track._id)).collect(),
  ]);
  for (const route of new Map([...sourceSidechains, ...targetSidechains].map((route: any) => [String(route._id), route])).values()) {
    await ctx.db.delete(route._id);
  }
  await deleteMixerStateForTrack(ctx, track._id);
  await ctx.db.delete(owner._id);
  await ctx.db.delete(track._id);
  return true;
}

async function deleteTrackFromPreflight(
  ctx: any,
  preflight: Extract<TrackDeletePreflight, { ok: true }>,
  options?: DeleteOwnedTrackOptions,
) {
  const { track } = preflight;
  if (!await deleteTrackEntitiesFromPreflight(ctx, preflight, options)) return false;
  await removeTrackRoutingReferences(ctx, track.projectId, track._id);
  const remaining = await ctx.db
    .query("tracks")
    .withIndex("by_room_index", (q: any) => q.eq("projectId", track.projectId))
    .collect();
  for (const remainingTrack of remaining) {
    const patch: { index?: number; groupId?: undefined } = {};
    if (remainingTrack.index > track.index) patch.index = remainingTrack.index - 1;
    if (String(remainingTrack.groupId) === String(track._id)) patch.groupId = undefined;
    if (Object.keys(patch).length === 0) continue;
    await ctx.db.patch(remainingTrack._id, patch);
  }
  return true;
}

async function deleteTrackSubtreeFromPreflights(
  ctx: any,
  preflights: Array<Extract<TrackDeletePreflight, { ok: true }>>,
) {
  if (preflights.length === 0) return;
  const projectId = preflights[0].track.projectId;
  const deletedTrackIds = new Set(preflights.map((preflight) => String(preflight.track._id)));

  await removeTracksRoutingReferences(ctx, projectId, deletedTrackIds);
  for (const preflight of preflights) {
    await deleteTrackEntitiesFromPreflight(ctx, preflight);
  }

  const remaining = await ctx.db
    .query("tracks")
    .withIndex("by_room_index", (q: any) => q.eq("projectId", projectId))
    .collect();
  const orderedRemaining = remaining.sort((left: any, right: any) => left.index - right.index);
  for (let index = 0; index < orderedRemaining.length; index += 1) {
    const track = orderedRemaining[index];
    const nextGroupId = deletedTrackIds.has(String(track.groupId)) ? undefined : track.groupId;
    const patch: { index?: number; groupId?: any } = {};
    if (track.index !== index) patch.index = index;
    if (track.groupId !== nextGroupId) patch.groupId = nextGroupId;
    if (Object.keys(patch).length === 0) continue;
    await ctx.db.patch(track._id, patch);
  }
}

export const deleteTrackRows = async (
  ctx: MutationCtx,
  input: { projectId: string; trackIds: Id<"tracks">[] },
) => {
  if (input.trackIds.length === 0) {
    return { changed: false, status: "noop" as const, trackIds: [] };
  }
  if (new Set(input.trackIds.map(String)).size !== input.trackIds.length) {
    return { changed: false, status: "rejected" as const, trackIds: [] };
  }
  const preflights = await Promise.all(input.trackIds.map(async (trackId) => {
    const track = await ctx.db.get(trackId);
    if (!track || track.projectId !== input.projectId) return null;
    const owner = await ctx.db
      .query("ownerships")
      .withIndex("by_track", (q) => q.eq("trackId", trackId))
      .first();
    if (!owner) return null;
    const clips = await ctx.db
      .query("clips")
      .withIndex("by_track", (q) => q.eq("trackId", trackId))
      .collect();
    const clipOwners = await Promise.all(clips.map((clip) => ctx.db
      .query("ownerships")
      .withIndex("by_clip", (q) => q.eq("clipId", clip._id))
      .first()));
    return {
      ok: true as const,
      owner,
      track,
      clips,
      clipOwnersByClipId: new Map(clips.map((clip, index) => [String(clip._id), clipOwners[index] ?? null])),
    };
  }));
  if (preflights.some((preflight) => !preflight)) {
    return { changed: false, status: "not-found" as const, trackIds: [] };
  }
  const validPreflights = preflights.flatMap((preflight) => preflight ? [preflight] : []);
  await deleteTrackSubtreeFromPreflights(ctx, validPreflights);
  return {
    changed: true,
    status: "deleted" as const,
    trackIds: input.trackIds,
  };
};

function collectTrackSubtreeIds(
  tracks: any[],
  rootTrackId: any,
) {
  const childrenByParent = new Map<string, any[]>();
  for (const track of tracks) {
    if (!track.groupId) continue;
    const parentId = String(track.groupId);
    const children = childrenByParent.get(parentId) ?? [];
    children.push(track._id);
    childrenByParent.set(parentId, children);
  }
  const subtreeIds: any[] = [rootTrackId];
  const seen = new Set([String(rootTrackId)]);
  for (let index = 0; index < subtreeIds.length; index += 1) {
    const trackId = subtreeIds[index];
    for (const childId of childrenByParent.get(String(trackId)) ?? []) {
      const childKey = String(childId);
      if (seen.has(childKey)) continue;
      seen.add(childKey);
      subtreeIds.push(childId);
    }
  }
  return subtreeIds;
}

export async function deleteOwnedTrack(
  ctx: any,
  trackId: any,
  userId: string,
  options?: DeleteOwnedTrackOptions,
) {
  const preflight = await getTrackDeletePreflight(ctx, trackId, userId, options);
  if (!preflight.ok) return false;
  return await deleteTrackFromPreflight(ctx, preflight, options);
}

export const listByRoom = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectAccess(ctx, projectId, userId);
    return await listProjectTracksWithMixerChannels(ctx, projectId);
  },
});

export const createTrackRow = async (
  ctx: MutationCtx,
  input: {
    projectId: string
    ownerUserId: string
    index?: number
    kind?: string
    channelRole?: string
    collapsed?: boolean
    color?: string
    name?: string
  },
) => {
  const existing = await listProjectTracksWithMixerChannels(ctx, input.projectId);
  const channelRole = sanitizeChannelRole(input.channelRole);
  const creation = canonicalTrackCreation(existing, channelRole, input.index);
  const existingById = new Map(existing.map((track) => [String(track._id), track]));
  for (const track of creation.existingTracks) {
    const previous = existingById.get(String(track._id));
    if (
      !previous
      || previous.index === track.index
      && previous.groupId === track.groupId
    ) continue;
    await ctx.db.patch(track._id, {
      index: track.index,
      groupId: track.groupId,
    });
  }
  const trackId = await ctx.db.insert("tracks", {
    projectId: input.projectId,
    name: input.name?.trim() || `Track ${creation.creationIndex + 1}`,
    index: creation.creationIndex,
    kind: input.kind,
    collapsed: trackCreationCollapsed(channelRole, input.collapsed),
    color: input.color,
  });
  await ctx.db.insert(
    "mixerChannels",
    buildMixerChannelInsert(input.projectId, trackId, {
      channelRole,
    }),
  );
  await ctx.db.insert("ownerships", {
    projectId: input.projectId,
    ownerUserId: input.ownerUserId,
    trackId,
  });
  return { changed: true, status: "created" as const, trackId };
};

const createTrackForUser = async (
  ctx: any,
  input: {
    projectId: string
    userId: string
    index?: number
    kind?: string
    channelRole?: string
    collapsed?: boolean
    color?: string
    name?: string
    operationId?: string
  },
) => await runSharedOperationOnce(ctx, {
  projectId: input.projectId,
  userId: input.userId,
  operationId: input.operationId,
  isResult: (value): value is string => typeof value === "string",
  run: async () => {
    await requireProjectRole(ctx, input.projectId, input.userId, ["owner", "editor"]);
    const result = await createTrackRow(ctx, { ...input, ownerUserId: input.userId });
    await advanceProjectRevision(ctx, input.projectId);
    return result.trackId;
  },
});

export const setTrackVolumeRow = async (
  ctx: MutationCtx,
  input: { projectId: string; trackId: Id<"tracks">; volume: number },
) => {
  const track = await ctx.db.get(input.trackId);
  if (!track || track.projectId !== input.projectId) {
    return { changed: false, status: "not-found" as const };
  }
  const channel = await ensureMixerChannelForTrack(ctx, track);
  if (channel.volume === input.volume) {
    return { changed: false, status: "noop" as const };
  }
  await ctx.db.patch(channel._id, { volume: input.volume });
  return { changed: true, status: "applied" as const };
};

export const setTrackMixRow = async (
  ctx: MutationCtx,
  input: { projectId: string; trackId: Id<"tracks">; muted?: boolean; soloed?: boolean },
) => {
  const track = await ctx.db.get(input.trackId);
  if (!track || track.projectId !== input.projectId) {
    return { changed: false, status: "not-found" as const };
  }
  const channel = await ensureMixerChannelForTrack(ctx, track);
  const patch: any = {};
  if (input.muted !== undefined && input.muted !== effectiveControlMixerBoolean(channel.muted)) patch.muted = input.muted;
  if (input.soloed !== undefined && input.soloed !== effectiveControlMixerBoolean(channel.soloed)) patch.soloed = input.soloed;
  if (Object.keys(patch).length === 0) {
    return { changed: false, status: "noop" as const };
  }
  await ctx.db.patch(channel._id, patch);
  return { changed: true, status: "applied" as const };
}

const mixerSendsEqual = (
  left: Array<{ targetId: string; amount: number; tap?: "pre-fx" | "pre-fader" | "post-fader" }>,
  right: Array<{ targetId: string; amount: number; tap?: "pre-fx" | "pre-fader" | "post-fader" }>,
) => (
  left.length === right.length
  && left.every((send, index) => (
    send.targetId === right[index]?.targetId
    && send.amount === right[index]?.amount
    && (send.tap ?? "post-fader") === (right[index]?.tap ?? "post-fader")
  ))
)

export const setTrackRoutingRow = async (
  ctx: MutationCtx,
  input: {
    projectId: string
    trackId: Id<"tracks">
    outputTargetId?: Id<"tracks"> | null
    sends?: Array<{ targetId: Id<"tracks">; amount: number; tap?: "pre-fx" | "pre-fader" | "post-fader" }>
  },
) => {
  const track = await ctx.db.get(input.trackId);
  if (!track || track.projectId !== input.projectId) {
    return { changed: false, status: "not-found" as const };
  }
  const channel = await ensureMixerChannelForTrack(ctx, track);
  if (input.sends === undefined && input.outputTargetId === undefined) {
    return { changed: false, status: "noop" as const };
  }
  const tracksInRoom = await listProjectTracksWithMixerChannels(ctx, input.projectId);
  const nextSends = input.sends === undefined ? channel.sends : input.sends;
  const nextOutputTargetId = input.outputTargetId === undefined
    ? channel.outputTargetId
    : input.outputTargetId ?? undefined;
  const normalizedRouting = sanitizeTrackRouting(
    { _id: input.trackId, channelRole: channel.channelRole, groupId: track.groupId },
    { sends: nextSends, outputTargetId: nextOutputTargetId },
    tracksInRoom as any,
  );
  if (
    normalizedRouting.outputTargetId === channel.outputTargetId
    && mixerSendsEqual(normalizedRouting.sends, channel.sends)
  ) return { changed: false, status: "noop" as const };
  await ctx.db.patch(channel._id, {
    sends: normalizedRouting.sends as any,
    outputTargetId: normalizedRouting.outputTargetId as any,
  });
  return { changed: true, status: "applied" as const };
}

const wouldCreateGroupCycle = async (ctx: any, trackId: any, proposedGroupId: any) => {
  let current = proposedGroupId;
  while (current) {
    if (String(current) === String(trackId)) return true;
    const parent = await ctx.db.get(current);
    current = parent?.groupId;
  }
  return false;
}

export const setTrackGroupRow = async (
  ctx: MutationCtx,
  input: { projectId: string; trackId: Id<"tracks">; groupId?: Id<"tracks"> | null },
) => {
  const track = await ctx.db.get(input.trackId);
  if (!track || track.projectId !== input.projectId) {
    return { changed: false, status: "not-found" as const };
  }
  if (input.groupId === undefined) return { changed: false, status: "noop" as const };
  const groupId = input.groupId ?? undefined;
  const channel = await ensureMixerChannelForTrack(ctx, track);
  if (channel.channelRole === "return" && groupId) {
    throw new Error("Return tracks cannot belong to a group.");
  }
  if (groupId) {
    const group = await ctx.db.get(groupId);
    if (!group || group.projectId !== input.projectId) throw new Error("Group track not found.");
    const groupChannel = await ensureMixerChannelForTrack(ctx, group);
    if (groupChannel.channelRole !== "group") throw new Error("Parent track must be a group.");
    if (await wouldCreateGroupCycle(ctx, input.trackId, groupId)) throw new Error("Track group cycle rejected.");
  }
  if (track.groupId === groupId) return { changed: false, status: "noop" as const };
  await ctx.db.patch(input.trackId, { groupId });
  return { changed: true, status: "applied" as const };
}

const setTrackCollapsedForUser = async (
  ctx: any,
  input: { trackId: any; userId: string; collapsed: boolean },
) => {
  const { track } = await requireTrackOwnerForWrite(ctx, input.trackId, input.userId);
  if (track.collapsed === input.collapsed) return;
  await ctx.db.patch(input.trackId, { collapsed: input.collapsed });
}

const setTrackColorForUser = async (
  ctx: any,
  input: { trackId: any; userId: string; color?: string | null },
) => {
  const { track } = await requireTrackOwnerForWrite(ctx, input.trackId, input.userId);
  const color = input.color ?? undefined;
  if (track.color === color) return;
  await ctx.db.patch(input.trackId, { color });
}

const lockTrackForUser = async (ctx: any, trackId: any, userId: string) => {
  const access = await getTrackWriteAccess(ctx, trackId, userId);
  if (!access) return { ok: false, reason: "Track not found" };
  const track = access.track;
  await requireProjectRole(ctx, track.projectId, userId, ["owner", "editor"]);
  const channel = await ensureMixerChannelForTrack(ctx, track);
  const now = Date.now();
  const lockState = normalizeMixerLockState(channel.lockedBy, channel.lockedAt, now);
  if (lockState.isLocked && lockState.lockedBy !== userId) {
    return { ok: false, reason: "Track locked by another user" };
  }
  await ctx.db.patch(channel._id, { lockedBy: userId, lockedAt: now });
  return { ok: true };
}

const unlockTrackForUser = async (ctx: any, trackId: any, userId: string) => {
  const access = await getTrackWriteAccess(ctx, trackId, userId);
  if (!access) return { ok: false };
  const track = access.track;
  await requireProjectRole(ctx, track.projectId, userId, ["owner", "editor"]);
  const channel = await ensureMixerChannelForTrack(ctx, track);
  const lockState = normalizeMixerLockState(channel.lockedBy, channel.lockedAt);
  if (lockState.isLocked && lockState.lockedBy !== userId) return { ok: false };
  await ctx.db.patch(channel._id, { lockedBy: undefined, lockedAt: undefined });
  return { ok: true };
}

export const create = mutation({
  args: { projectId: v.string(), name: v.optional(v.string()), index: v.optional(v.number()), kind: v.optional(v.string()), channelRole: v.optional(v.string()), collapsed: v.optional(v.boolean()), color: v.optional(v.string()), operationId: v.optional(v.string()) },
  handler: async (ctx, { projectId, name, index, kind, channelRole, collapsed, color, operationId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return await createTrackForUser(ctx, { projectId, userId, name, index, kind, channelRole, collapsed, color, operationId });
  },
});

export const serverCreate = mutation({
  args: {
    projectId: v.string(),
    name: v.optional(v.string()),
    index: v.optional(v.number()),
    kind: v.optional(v.string()),
    channelRole: v.optional(v.string()),
    collapsed: v.optional(v.boolean()),
    color: v.optional(v.string()),
    operationId: v.optional(v.string()),
  },
  handler: async (ctx, { projectId, name, index, kind, channelRole, collapsed, color, operationId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return await createTrackForUser(ctx, { projectId, userId, name, index, kind, channelRole, collapsed, color, operationId });
  },
});

export const setVolume = mutation({
  args: { trackId: v.id("tracks"), volume: v.number() },
  handler: async (ctx, { trackId, volume }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const { track } = await requireTrackOwnerForWrite(ctx, trackId, userId);
    const result = await setTrackVolumeRow(ctx, { projectId: track.projectId, trackId, volume });
    if (result.changed) await advanceProjectRevision(ctx, track.projectId);
  },
});

export const serverSetVolume = mutation({
  args: { trackId: v.string(), volume: v.number() },
  handler: async (ctx, { trackId, volume }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const normalizedTrackId = ctx.db.normalizeId("tracks", trackId);
    if (!normalizedTrackId) throw new Error("Track not found.");
    const { track } = await requireTrackOwnerForWrite(ctx, normalizedTrackId, userId);
    const result = await setTrackVolumeRow(ctx, {
      projectId: track.projectId,
      trackId: normalizedTrackId,
      volume,
    });
    if (result.changed) await advanceProjectRevision(ctx, track.projectId);
  },
});

export const setMix = mutation({
  args: { trackId: v.id("tracks"), muted: v.optional(v.boolean()), soloed: v.optional(v.boolean()) },
  returns: trackMixWriteResult,
  handler: async (ctx, { trackId, muted, soloed }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const access = await getTrackWriteAccess(ctx, trackId, userId);
    if (!access) {
      return await ctx.db.get(trackId)
        ? { status: "access-denied" as const }
        : { status: "not-found" as const };
    }
    const result = await setTrackMixRow(ctx, {
      projectId: access.track.projectId,
      trackId,
      muted,
      soloed,
    });
    if (result.changed) await advanceProjectRevision(ctx, access.track.projectId);
    return { status: result.status };
  },
});

export const serverSetMix = mutation({
  args: { trackId: v.string(), muted: v.optional(v.boolean()), soloed: v.optional(v.boolean()) },
  returns: trackMixWriteResult,
  handler: async (ctx, { trackId, muted, soloed }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const normalizedTrackId = ctx.db.normalizeId("tracks", trackId);
    if (!normalizedTrackId) return { status: "not-found" as const };
    const access = await getTrackWriteAccess(ctx, normalizedTrackId, userId);
    if (!access) return { status: "access-denied" as const };
    const result = await setTrackMixRow(ctx, {
      projectId: access.track.projectId,
      trackId: normalizedTrackId,
      muted,
      soloed,
    });
    if (result.changed) await advanceProjectRevision(ctx, access.track.projectId);
    return { status: result.status };
  },
});

export const setRouting = mutation({
  args: {
    trackId: v.id("tracks"),
    outputTargetId: v.optional(v.union(v.id("tracks"), v.null())),
    sends: v.optional(v.array(v.object({
      targetId: v.id("tracks"),
      amount: v.number(),
      tap: v.optional(v.union(v.literal("pre-fx"), v.literal("pre-fader"), v.literal("post-fader"))),
    }))),
  },
  handler: async (ctx, { trackId, outputTargetId, sends }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const { track } = await requireTrackOwnerForWrite(ctx, trackId, userId);
    const result = await setTrackRoutingRow(ctx, {
      projectId: track.projectId,
      trackId,
      outputTargetId,
      sends,
    });
    if (result.changed) await advanceProjectRevision(ctx, track.projectId);
  },
});

export const serverSetRouting = mutation({
  args: {
    trackId: v.string(),
    outputTargetId: v.optional(v.union(v.string(), v.null())),
    sends: v.optional(v.array(v.object({
      targetId: v.string(),
      amount: v.number(),
      tap: v.optional(v.union(v.literal("pre-fx"), v.literal("pre-fader"), v.literal("post-fader"))),
    }))),
  },
  handler: async (ctx, { trackId, outputTargetId, sends }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const normalizedTrackId = ctx.db.normalizeId("tracks", trackId);
    if (!normalizedTrackId) throw new Error("Track not found.");
    const normalizedOutputTargetId = typeof outputTargetId === "string"
      ? ctx.db.normalizeId("tracks", outputTargetId)
      : outputTargetId;
    if (typeof outputTargetId === "string" && !normalizedOutputTargetId) {
      throw new Error("Output target track not found.");
    }
    const normalizedSends = sends?.flatMap((send) => {
      const targetId = ctx.db.normalizeId("tracks", send.targetId);
      return targetId ? [{ targetId, amount: send.amount, tap: send.tap }] : [];
    });
    if (sends && normalizedSends?.length !== sends.length) {
      throw new Error("Send target track not found.");
    }

    const { track } = await requireTrackOwnerForWrite(ctx, normalizedTrackId, userId);
    const result = await setTrackRoutingRow(ctx, {
      projectId: track.projectId,
      trackId: normalizedTrackId,
      outputTargetId: normalizedOutputTargetId,
      sends: normalizedSends,
    });
    if (result.changed) await advanceProjectRevision(ctx, track.projectId);
  },
});

export const setSidechainRouteRow = async (
  ctx: MutationCtx,
  input: {
    projectId: string
    sourceTrackId: Id<"tracks">
    targetTrackId: Id<"tracks">
    effectInstanceId: string
  },
) => {
  const [sourceTrack, targetTrack] = await Promise.all([
    ctx.db.get(input.sourceTrackId),
    ctx.db.get(input.targetTrackId),
  ]);
  if (
    !sourceTrack
    || !targetTrack
    || sourceTrack.projectId !== input.projectId
    || targetTrack.projectId !== input.projectId
  ) {
    throw new Error("Sidechain source or target track not found.");
  }
  const effects = await ctx.db.query("effects").withIndex("by_track", (q: any) => q.eq("trackId", input.targetTrackId)).collect();
  const matching = effects.filter((effect: any) => (
    sidechainEligibilityError({
      sourceTrackId: String(input.sourceTrackId),
      targetTrackId: String(input.targetTrackId),
      effectTargetTrackId: effect.targetType === "track" ? String(effect.trackId) : undefined,
      effectKind: effect.type,
      effectInstanceId: effect.instanceId,
    }) === undefined
    && effect.instanceId === input.effectInstanceId
  ));
  if (matching.length !== 1) throw new Error("Sidechain target must identify exactly one compressor, gate, or spectral instance.");
  const existing = await ctx.db.query("sidechainRoutes")
    .withIndex("by_room_target_effect", (q: any) => (
      q.eq("projectId", input.projectId)
        .eq("targetTrackId", input.targetTrackId)
        .eq("effectInstanceId", input.effectInstanceId)
    ))
    .collect();
  if (existing.length === 1 && String(existing[0]?.sourceTrackId) === String(input.sourceTrackId)) {
    return { changed: false, status: "noop" as const, routeId: existing[0]._id };
  }
  for (const route of existing) await ctx.db.delete(route._id);
  const routeId = await ctx.db.insert("sidechainRoutes", {
    projectId: input.projectId,
    sourceTrackId: input.sourceTrackId,
    targetTrackId: input.targetTrackId,
    effectInstanceId: input.effectInstanceId,
  });
  return { changed: true, status: "applied" as const, routeId };
};

export const setSidechainRoute = mutation({
  args: { sourceTrackId: v.id("tracks"), targetTrackId: v.id("tracks"), effectInstanceId: v.string() },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const [sourceAccess, targetAccess] = await Promise.all([
      getTrackWriteAccess(ctx, input.sourceTrackId, userId),
      getTrackWriteAccess(ctx, input.targetTrackId, userId),
    ]);
    if (!sourceAccess || !targetAccess || sourceAccess.track.projectId !== targetAccess.track.projectId) {
      throw new Error("Sidechain source or target track not found.");
    }
    const projectId = targetAccess.track.projectId;
    const result = await setSidechainRouteRow(ctx, { ...input, projectId });
    if (result.changed) await advanceProjectRevision(ctx, projectId);
  },
});

export const serverSetSidechainRoute = mutation({
  args: { projectId: v.string(), sourceTrackId: v.string(), targetTrackId: v.string(), effectInstanceId: v.string() },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const sourceTrackId = ctx.db.normalizeId("tracks", input.sourceTrackId);
    const targetTrackId = ctx.db.normalizeId("tracks", input.targetTrackId);
    if (!sourceTrackId || !targetTrackId) throw new Error("Sidechain source or target track not found.");
    const [sourceAccess, targetAccess] = await Promise.all([
      getTrackWriteAccess(ctx, sourceTrackId, userId),
      getTrackWriteAccess(ctx, targetTrackId, userId),
    ]);
    if (
      !sourceAccess
      || !targetAccess
      || sourceAccess.track.projectId !== input.projectId
      || targetAccess.track.projectId !== input.projectId
    ) {
      throw new Error("Sidechain source or target track not found.");
    }
    const result = await setSidechainRouteRow(ctx, { ...input, sourceTrackId, targetTrackId });
    if (result.changed) await advanceProjectRevision(ctx, input.projectId);
  },
});

export const removeSidechainRouteRow = async (
  ctx: MutationCtx,
  input: { projectId: string; targetTrackId: Id<"tracks">; effectInstanceId: string },
) => {
  const target = await ctx.db.get(input.targetTrackId);
  if (!target || target.projectId !== input.projectId) {
    throw new Error("Sidechain target track does not belong to this project.");
  }
  const effects = await ctx.db.query("effects").withIndex("by_track", (q: any) => q.eq("trackId", input.targetTrackId)).collect();
  const eligibleEffects = effects.filter((effect: any) => (
    effect.instanceId === input.effectInstanceId
    && sidechainTargetEligibilityError({
      targetTrackId: String(input.targetTrackId),
      effectTargetTrackId: effect.targetType === "track" ? String(effect.trackId) : undefined,
      effectKind: effect.type,
      effectInstanceId: effect.instanceId,
    }) === undefined
  ));
  if (eligibleEffects.length !== 1) throw new Error("Sidechain target effect does not belong to this project.");
  const routes = await ctx.db.query("sidechainRoutes")
    .withIndex("by_room_target_effect", (q: any) => q.eq("projectId", input.projectId).eq("targetTrackId", input.targetTrackId).eq("effectInstanceId", input.effectInstanceId))
    .collect();
  for (const route of routes) {
    await ctx.db.delete(route._id);
  }
  return routes.length > 0
    ? { changed: true, status: "deleted" as const, routeIds: routes.map((route) => route._id) }
    : { changed: false, status: "noop" as const, routeIds: [] };
};

export const removeSidechainRoute = mutation({
  args: { projectId: v.string(), targetTrackId: v.id("tracks"), effectInstanceId: v.string() },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectRole(ctx, input.projectId, userId, ["owner", "editor"]);
    const result = await removeSidechainRouteRow(ctx, input);
    if (result.changed) await advanceProjectRevision(ctx, input.projectId);
  },
});

export const serverRemoveSidechainRoute = mutation({
  args: { projectId: v.string(), targetTrackId: v.string(), effectInstanceId: v.string() },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const targetTrackId = ctx.db.normalizeId("tracks", input.targetTrackId);
    if (!targetTrackId) throw new Error("Sidechain target track not found.");
    await requireProjectRole(ctx, input.projectId, userId, ["owner", "editor"]);
    const result = await removeSidechainRouteRow(ctx, { ...input, targetTrackId });
    if (result.changed) await advanceProjectRevision(ctx, input.projectId);
  },
});

export const setGroup = mutation({
  args: { trackId: v.id("tracks"), groupId: v.optional(v.union(v.id("tracks"), v.null())) },
  handler: async (ctx, { trackId, groupId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const { track } = await requireTrackOwnerForWrite(ctx, trackId, userId);
    const result = await setTrackGroupRow(ctx, { projectId: track.projectId, trackId, groupId });
    if (result.changed) await advanceProjectRevision(ctx, track.projectId);
  },
});

export const serverSetGroup = mutation({
  args: { trackId: v.string(), groupId: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { trackId, groupId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const normalizedTrackId = ctx.db.normalizeId("tracks", trackId);
    if (!normalizedTrackId) throw new Error("Track not found.");
    const normalizedGroupId = typeof groupId === "string" ? ctx.db.normalizeId("tracks", groupId) : groupId;
    if (typeof groupId === "string" && !normalizedGroupId) throw new Error("Group track not found.");
    const { track } = await requireTrackOwnerForWrite(ctx, normalizedTrackId, userId);
    const result = await setTrackGroupRow(ctx, {
      projectId: track.projectId,
      trackId: normalizedTrackId,
      groupId: normalizedGroupId,
    });
    if (result.changed) await advanceProjectRevision(ctx, track.projectId);
  },
});

type TrackReorderUpdate = {
  trackId: Id<"tracks">
  index: number
  groupId?: Id<"tracks"> | null
  outputTargetId?: Id<"tracks"> | null
}

export const reorderAndGroupTrackRows = async (
  ctx: MutationCtx,
  input: { projectId: string; updates: TrackReorderUpdate[] },
) => {
  if (input.updates.length === 0) {
    return { changed: false, status: "noop" as const };
  }
  const tracks = await listProjectTracksWithMixerChannels(ctx, input.projectId);
  if (input.updates.length !== tracks.length) {
    return { changed: false, status: "rejected" as const };
  }
  const trackById = new Map(tracks.map((track) => [String(track._id), track]));
  if (input.updates.some((update) => !trackById.has(String(update.trackId)))) {
    return { changed: false, status: "rejected" as const };
  }
  if (new Set(input.updates.map((update) => String(update.trackId))).size !== tracks.length) {
    return { changed: false, status: "rejected" as const };
  }
  const sortedIndexes = input.updates.map((update) => update.index).sort((left, right) => left - right);
  if (sortedIndexes.some((index, offset) => index !== offset)) {
    return { changed: false, status: "rejected" as const };
  }

  const parentByTrackId = new Map(tracks.map((track) => [String(track._id), track.groupId ? String(track.groupId) : undefined]));
  for (const update of input.updates) {
    parentByTrackId.set(String(update.trackId), update.groupId ? String(update.groupId) : undefined);
    if (update.groupId) {
      const groupTrack = trackById.get(String(update.groupId));
      if (!groupTrack || groupTrack.channelRole !== "group") {
        return { changed: false, status: "rejected" as const };
      }
    }
  }
  for (const track of tracks) {
    const seen = new Set<string>();
    let cursor = parentByTrackId.get(String(track._id));
    while (cursor) {
      if (seen.has(cursor) || cursor === String(track._id)) {
        return { changed: false, status: "rejected" as const };
      }
      seen.add(cursor);
      cursor = parentByTrackId.get(cursor);
    }
  }

  const normalizedUpdateById = new Map(input.updates.map((update) => [String(update.trackId), update]));
  const proposedTracks = tracks.map((track) => {
    const update = normalizedUpdateById.get(String(track._id));
    return update
      ? { ...track, index: update.index, groupId: update.groupId ?? undefined }
      : track;
  });
  if (!hasValidReturnTrackPartition(proposedTracks)) {
    return { changed: false, status: "rejected" as const };
  }

  let changed = false;
  await Promise.all(input.updates.map(async (update) => {
    const track = trackById.get(String(update.trackId));
    if (!track) return;
    const nextGroupId = update.groupId ?? undefined;
    if (track.index !== update.index || String(track.groupId) !== String(nextGroupId)) {
      changed = true;
      await ctx.db.patch(update.trackId, {
        index: update.index,
        groupId: nextGroupId,
      });
    }
    const channel = await ensureMixerChannelForTrack(ctx, track);
    const routing = sanitizeTrackRouting(
      { _id: update.trackId, channelRole: track.channelRole, groupId: update.groupId ?? undefined },
      { sends: channel.sends, outputTargetId: update.outputTargetId ?? undefined },
      proposedTracks,
    );
    const nextOutputTargetId = routing.outputTargetId;
    if (!nextOutputTargetId) {
      if (channel.outputTargetId === undefined) return;
      changed = true;
      await ctx.db.patch(channel._id, { outputTargetId: undefined });
      return;
    }
    const normalizedNextOutputTargetId = ctx.db.normalizeId("tracks", nextOutputTargetId);
    if (!normalizedNextOutputTargetId) return;
    if (String(channel.outputTargetId) === String(normalizedNextOutputTargetId)) return;
    changed = true;
    await ctx.db.patch(channel._id, { outputTargetId: normalizedNextOutputTargetId });
  }));
  return changed
    ? { changed: true, status: "applied" as const }
    : { changed: false, status: "noop" as const };
};

export const serverReorderAndGroup = mutation({
  args: {
    updates: v.array(v.object({
      trackId: v.string(),
      index: v.number(),
      groupId: v.optional(v.union(v.string(), v.null())),
      outputTargetId: v.optional(v.union(v.string(), v.null())),
    })),
  },
  handler: async (ctx, { updates }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    if (updates.length === 0) return { status: "noop" as const };
    const normalizedUpdates = [];
    for (const update of updates) {
      const trackId = ctx.db.normalizeId("tracks", update.trackId);
      if (!trackId) return { status: "rejected" };
      const groupId = typeof update.groupId === "string" ? ctx.db.normalizeId("tracks", update.groupId) : update.groupId;
      const outputTargetId = typeof update.outputTargetId === "string" ? ctx.db.normalizeId("tracks", update.outputTargetId) : update.outputTargetId;
      if (typeof update.groupId === "string" && !groupId) return { status: "rejected" };
      if (typeof update.outputTargetId === "string" && !outputTargetId) return { status: "rejected" };
      normalizedUpdates.push({ ...update, trackId, groupId, outputTargetId });
    }

    const accesses = await Promise.all(normalizedUpdates.map((update) => getTrackWriteAccess(ctx, update.trackId, userId)));
    if (accesses.some((access) => !access)) return { status: "rejected" };
    const firstAccess = accesses[0];
    if (!firstAccess) return { status: "rejected" };
    const projectId = firstAccess.track.projectId;
    if (accesses.some((access) => access?.track.projectId !== projectId)) return { status: "rejected" };
    const result = await reorderAndGroupTrackRows(ctx, { projectId, updates: normalizedUpdates });
    if (result.changed) await advanceProjectRevision(ctx, projectId);
    return { status: result.status };
  },
});

export const setCollapsed = mutation({
  args: { trackId: v.id("tracks"), collapsed: v.boolean() },
  handler: async (ctx, { trackId, collapsed }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await setTrackCollapsedForUser(ctx, { trackId, userId, collapsed });
  },
});

export const serverSetCollapsed = mutation({
  args: { trackId: v.string(), collapsed: v.boolean() },
  handler: async (ctx, { trackId, collapsed }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const normalizedTrackId = ctx.db.normalizeId("tracks", trackId);
    if (!normalizedTrackId) throw new Error("Track not found.");
    await setTrackCollapsedForUser(ctx, { trackId: normalizedTrackId, userId, collapsed });
  },
});

export const setColor = mutation({
  args: { trackId: v.id("tracks"), color: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { trackId, color }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await setTrackColorForUser(ctx, { trackId, userId, color });
  },
});

export const serverSetColor = mutation({
  args: { trackId: v.string(), color: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { trackId, color }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const normalizedTrackId = ctx.db.normalizeId("tracks", trackId);
    if (!normalizedTrackId) throw new Error("Track not found.");
    await setTrackColorForUser(ctx, { trackId: normalizedTrackId, userId, color });
  },
});

const isTrackLockedByOther = async (ctx: any, track: any, userId: string) => {
  const channel = await ensureMixerChannelForTrack(ctx, track);
  const lockState = normalizeMixerLockState(channel.lockedBy, channel.lockedAt);
  return lockState.isLocked && lockState.lockedBy !== userId;
};

const hasRoutingReferenceTo = (track: any, targetTrackId: string) => (
  String(track.outputTargetId) === targetTrackId
  || (track.sends ?? []).some((send: { targetId: any }) => String(send.targetId) === targetTrackId)
);

const restoreGroupPlaceholderId = "restored-group";

const routingMatches = (
  left: { outputTargetId?: string; sends: Array<{ targetId: string; amount: number; tap?: "pre-fx" | "pre-fader" | "post-fader" }> },
  right: { outputTargetId?: string; sends: Array<{ targetId: string; amount: number; tap?: "pre-fx" | "pre-fader" | "post-fader" }> },
) => (
  left.outputTargetId === right.outputTargetId
  && left.sends.length === right.sends.length
  && left.sends.every((send, index) => (
    send.targetId === right.sends[index]?.targetId
    && send.amount === right.sends[index]?.amount
    && (send.tap ?? "post-fader") === (right.sends[index]?.tap ?? "post-fader")
  ))
);

export const validateRestoreUngroupRouting = (
  input: {
    group: {
      index: number;
      parentGroupId?: string;
      outputTargetId?: string;
      sends: Array<{ targetId: string; amount: number }>;
    };
    children: Array<{ trackId: string; outputTargetId?: string; outputToGroup: boolean }>;
  },
  tracks: any[],
) => {
  const childIds = new Set(input.children.map((child) => child.trackId));
  if (input.group.parentGroupId && childIds.has(input.group.parentGroupId)) return false;
  const trackById = new Map(tracks.map((track) => [String(track._id), track]));
  const childrenByTrackId = new Map(input.children.map((child) => [child.trackId, child]));
  const groupIndex = Math.max(0, Math.min(Math.round(input.group.index), tracks.length));
  const restoredGroupTrack = {
    _id: restoreGroupPlaceholderId,
    index: groupIndex,
    channelRole: "group",
    groupId: input.group.parentGroupId,
  };
  const routingTracks = [
    ...tracks.map((track) => ({
      _id: String(track._id),
      index: track.index >= groupIndex ? track.index + 1 : track.index,
      channelRole: track.channelRole,
      groupId: childrenByTrackId.has(String(track._id))
        ? restoreGroupPlaceholderId
        : (track.groupId ? String(track.groupId) : undefined),
    })),
    restoredGroupTrack,
  ];
  const routingTrackById = new Map(routingTracks.map((track) => [track._id, track]));
  if (!hasValidReturnTrackPartition(routingTracks)) return false;
  if (hasTrackGroupCycle(routingTracks.map((track) => ({ id: track._id, groupId: track.groupId })))) return false;

  const groupRouting = sanitizeTrackRouting(restoredGroupTrack, {
    sends: input.group.sends,
    outputTargetId: input.group.outputTargetId,
  }, routingTracks);
  if (!routingMatches(groupRouting, {
    sends: input.group.sends,
    outputTargetId: input.group.outputTargetId,
  })) return false;

  for (const child of input.children) {
    const existingTrack = trackById.get(child.trackId);
    const projectedTrack = routingTrackById.get(child.trackId);
    if (!existingTrack || !projectedTrack) return false;
    const outputTargetId = child.outputToGroup ? restoreGroupPlaceholderId : child.outputTargetId;
    const sends = existingTrack.sends.map((send: { targetId: any; amount: number; tap?: "pre-fx" | "pre-fader" | "post-fader" }) => ({
      targetId: String(send.targetId),
      amount: send.amount,
      tap: send.tap,
    }));
    const routing = sanitizeTrackRouting(projectedTrack, { sends, outputTargetId }, routingTracks);
    if (!routingMatches(routing, { sends, outputTargetId })) return false;
  }
  return true;
};

const normalizeColorBatch = (
  ctx: any,
  input: {
    trackUpdates: Array<{ trackId: string; color?: string | null }>;
    clipUpdates: Array<{ clipId: string; color: string }>;
  },
) => {
  const trackUpdates: Array<{ trackId: Id<"tracks">; color?: string }> = [];
  for (const update of input.trackUpdates) {
    const trackId = ctx.db.normalizeId("tracks", update.trackId);
    if (!trackId) return null;
    trackUpdates.push({ trackId, color: update.color ?? undefined });
  }
  const clipUpdates: Array<{ clipId: Id<"clips">; color: string }> = [];
  for (const update of input.clipUpdates) {
    const clipId = ctx.db.normalizeId("clips", update.clipId);
    const color = normalizeClipColor(update.color);
    if (!clipId || !color) return null;
    clipUpdates.push({ clipId, color });
  }
  if (new Set(trackUpdates.map((update) => update.trackId)).size !== trackUpdates.length) return null;
  if (new Set(clipUpdates.map((update) => update.clipId)).size !== clipUpdates.length) return null;
  return { trackUpdates, clipUpdates };
};

const preflightColorBatch = async (
  ctx: any,
  userId: string,
  updates: NonNullable<ReturnType<typeof normalizeColorBatch>>,
) => {
  const trackAccesses = await Promise.all(updates.trackUpdates.map((update) => getTrackWriteAccess(ctx, update.trackId, userId)));
  const clipAccesses = await Promise.all(updates.clipUpdates.map((update) => getClipWriteAccess(ctx, update.clipId, userId)));
  if (trackAccesses.some((access) => !access) || clipAccesses.some((access) => !access)) return null;
  const tracks = trackAccesses.flatMap((access) => access ? [access.track] : []);
  const clips = clipAccesses.flatMap((access) => access ? [access.clip] : []);
  const projectId = tracks[0]?.projectId ?? clips[0]?.projectId;
  if (!projectId || tracks.some((track) => track.projectId !== projectId) || clips.some((clip) => clip.projectId !== projectId)) return null;
  const locked = await Promise.all(tracks.map((track) => isTrackLockedByOther(ctx, track, userId)));
  if (locked.some(Boolean)) return null;
  const clipTrackIds = new Set(clips.map((clip) => String(clip.trackId)));
  const clipTracks = await Promise.all(Array.from(clipTrackIds, async (trackId) => {
    const normalizedTrackId = ctx.db.normalizeId("tracks", trackId);
    return normalizedTrackId ? await ctx.db.get(normalizedTrackId) : null;
  }));
  if (clipTracks.some((track) => !track)) return null;
  const clipLocks = await Promise.all(clipTracks.flatMap((track) => track ? [isTrackLockedByOther(ctx, track, userId)] : []));
  return clipLocks.some(Boolean) ? null : { tracks, clips, projectId };
};

const applyColorBatchForUser = async (
  ctx: any,
  userId: string,
  input: {
    trackUpdates: Array<{ trackId: string; color?: string | null }>;
    clipUpdates: Array<{ clipId: string; color: string }>;
  },
) => {
  const normalized = normalizeColorBatch(ctx, input);
  if (!normalized) return null;
  const preflight = await preflightColorBatch(ctx, userId, normalized);
  if (!preflight) return null;
  const tracksById = new Map(preflight.tracks.map((track) => [String(track._id), track]));
  const clipsById = new Map(preflight.clips.map((clip) => [String(clip._id), clip]));
  const trackUpdates = normalized.trackUpdates.filter((update) => (
    tracksById.get(String(update.trackId))?.color !== update.color
  ));
  const clipUpdates = normalized.clipUpdates.filter((update) => (
    clipsById.get(String(update.clipId))?.color !== update.color
  ));
  const result = {
    trackUpdates: normalized.trackUpdates.map((update) => ({
      trackId: String(update.trackId),
      from: tracksById.get(String(update.trackId))?.color,
      to: update.color,
    })),
    clipUpdates: normalized.clipUpdates.map((update) => ({
      clipId: String(update.clipId),
      from: clipsById.get(String(update.clipId))?.color,
      to: update.color,
    })),
  };
  if (trackUpdates.length === 0 && clipUpdates.length === 0) return result;
  await Promise.all([
    ...trackUpdates.map((update) => ctx.db.patch(update.trackId, { color: update.color })),
    ...clipUpdates.map((update) => ctx.db.patch(update.clipId, { color: update.color })),
  ]);
  return result;
};

const ungroupTrackForUser = async (ctx: any, userId: string, projectId: string, groupId: string) => {
  const normalizedGroupId = ctx.db.normalizeId("tracks", groupId);
  if (!normalizedGroupId) return { status: "rejected" as const };
  const groupAccess = await getTrackWriteAccess(ctx, normalizedGroupId, userId);
  if (!groupAccess || groupAccess.track.projectId !== projectId) {
    return { status: "rejected" as const };
  }

  const tracks = await listProjectTracksWithMixerChannels(ctx, groupAccess.track.projectId);
  const group = tracks.find((track) => String(track._id) === String(normalizedGroupId));
  if (!group || group.channelRole !== "group" || await isTrackLockedByOther(ctx, group, userId)) return { status: "rejected" as const };
  const directChildren = tracks.filter((track) => String(track.groupId) === String(normalizedGroupId));
  const childAccesses = await Promise.all(directChildren.map((track) => getTrackWriteAccess(ctx, track._id, userId)));
  if (childAccesses.some((access) => !access)) return { status: "rejected" as const };
  const childLocks = await Promise.all(directChildren.map((track) => isTrackLockedByOther(ctx, track, userId)));
  if (childLocks.some(Boolean)) return { status: "rejected" as const };

  const groupClips = await ctx.db.query("clips").withIndex("by_track", (q: any) => q.eq("trackId", normalizedGroupId)).collect();
  if (groupClips.length > 0) return { status: "rejected" as const };
  const directChildIds = new Set(directChildren.map((track) => String(track._id)));
  const hasExternalReference = tracks.some((track) => (
    String(track._id) !== String(normalizedGroupId)
    && !directChildIds.has(String(track._id))
    && hasRoutingReferenceTo(track, String(normalizedGroupId))
  ));
  if (hasExternalReference) return { status: "rejected" as const };

  for (const child of directChildren) {
    const groupIdForChild = group.groupId;
    if (String(child.groupId) !== String(groupIdForChild)) {
      await ctx.db.patch(child._id, { groupId: groupIdForChild });
    }
    const channel = await ensureMixerChannelForTrack(ctx, child);
    if (String(channel.outputTargetId) === String(normalizedGroupId)) {
      await ctx.db.patch(channel._id, { outputTargetId: groupIdForChild });
    }
  }
  const automation = await ctx.db
    .query("automationEnvelopes")
    .withIndex("by_project_track", (q: any) => q.eq("projectId", group.projectId).eq("trackId", normalizedGroupId))
    .collect();
  const effects = await ctx.db.query("effects").withIndex("by_track", (q: any) => q.eq("trackId", normalizedGroupId)).collect();
  const [sourceSidechains, targetSidechains] = await Promise.all([
    ctx.db.query("sidechainRoutes").withIndex("by_source", (q: any) => q.eq("sourceTrackId", normalizedGroupId)).collect(),
    ctx.db.query("sidechainRoutes").withIndex("by_target", (q: any) => q.eq("targetTrackId", normalizedGroupId)).collect(),
  ]);
  const deletedSidechains = new Map([...sourceSidechains, ...targetSidechains].map((route: any) => [String(route._id), route]));
  const result = {
    status: "applied" as const,
    group: {
      trackId: String(group._id),
      name: group.name,
      historyRef: group.historyRef,
      index: group.index,
      kind: group.kind,
      parentGroupId: group.groupId ? String(group.groupId) : undefined,
      collapsed: group.collapsed,
      color: group.color,
      volume: group.volume,
      muted: group.muted,
      soloed: group.soloed,
      outputTargetId: group.outputTargetId ? String(group.outputTargetId) : undefined,
      sends: group.sends.map((send: { targetId: Id<"tracks">; amount: number; tap?: "pre-fx" | "pre-fader" | "post-fader" }) => ({
        targetId: String(send.targetId),
        amount: send.amount,
        tap: send.tap,
      })),
    },
    children: directChildren.map((child) => ({
      trackId: String(child._id),
      previousOutputTargetId: child.outputTargetId ? String(child.outputTargetId) : undefined,
      nextOutputTargetId: String(child.outputTargetId) === String(normalizedGroupId)
        ? (group.groupId ? String(group.groupId) : undefined)
        : (child.outputTargetId ? String(child.outputTargetId) : undefined),
    })),
    effects: effects.map((effect: { type: string; instanceId?: string; index?: number; params: unknown }) => ({
      type: effect.type,
      instanceId: effect.instanceId,
      index: effect.index,
      params: effect.params,
    })),
    automation: automation.map((envelope: { effectInstanceId?: string; parameterId: string; enabled: boolean; points: unknown[]; updatedAt: number }) => ({
      effectInstanceId: envelope.effectInstanceId,
      parameterId: envelope.parameterId,
      enabled: envelope.enabled,
      points: envelope.points,
      updatedAt: envelope.updatedAt,
    })),
    sidechainRoutes: Array.from(deletedSidechains.values(), (route: { sourceTrackId: Id<"tracks">; targetTrackId: Id<"tracks">; effectInstanceId: string }) => ({
      sourceTrackId: String(route.sourceTrackId),
      targetTrackId: String(route.targetTrackId),
      effectInstanceId: route.effectInstanceId,
    })),
  };
  for (const envelope of automation) await ctx.db.delete(envelope._id);
  for (const effect of effects) await ctx.db.delete(effect._id);
  for (const route of deletedSidechains.values()) {
    await ctx.db.delete(route._id);
  }
  await deleteMixerStateForTrack(ctx, normalizedGroupId);
  await ctx.db.delete(groupAccess.owner._id);
  await ctx.db.delete(normalizedGroupId);
  const remaining = tracks.filter((track) => String(track._id) !== String(normalizedGroupId));
  for (const track of remaining) {
    if (track.index > group.index) await ctx.db.patch(track._id, { index: track.index - 1 });
  }
  return result;
};

export const serverUngroup = mutation({
  args: { projectId: v.string(), groupId: v.string(), operationId: v.optional(v.string()) },
  handler: async (ctx, { projectId, groupId, operationId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return await runSharedOperationOnce(ctx, {
      projectId,
      userId,
      operationId,
      isResult: (value): value is Awaited<ReturnType<typeof ungroupTrackForUser>> => (
        typeof value === "object"
        && value !== null
        && "status" in value
        && (value.status === "applied" || value.status === "rejected")
      ),
      run: async () => {
        const result = await ungroupTrackForUser(ctx, userId, projectId, groupId);
        if (result.status === "applied") await advanceProjectRevision(ctx, projectId);
        return result;
      },
    });
  },
});

export const serverRestoreUngroup = mutation({
  args: {
    projectId: v.string(),
    group: v.object({
      name: v.optional(v.string()),
      index: v.number(),
      kind: v.optional(v.string()),
      historyRef: v.optional(v.string()),
      parentGroupId: v.optional(v.string()),
      collapsed: v.optional(v.boolean()),
      color: v.optional(v.string()),
      volume: v.number(),
      muted: v.optional(v.boolean()),
      soloed: v.optional(v.boolean()),
      outputTargetId: v.optional(v.string()),
      sends: v.array(v.object({
        targetId: v.string(),
        amount: v.number(),
        tap: v.optional(v.union(v.literal("pre-fx"), v.literal("pre-fader"), v.literal("post-fader"))),
      })),
    }),
    children: v.array(v.object({ trackId: v.string(), outputTargetId: v.optional(v.string()), outputToGroup: v.boolean() })),
    effects: v.array(v.object({
      type: v.union(
        v.literal("utility"),
        v.literal("eq"),
        v.literal("autofilter"),
        v.literal("gate"),
        v.literal("compressor"),
        v.literal("saturator"),
        v.literal("limiter"),
        v.literal("lofi"),
        v.literal("chorus"),
        v.literal("flanger"),
        v.literal("phaser"),
        v.literal("tremolo"),
        v.literal("autopan"),
        v.literal("ensemble"),
        v.literal("delay"),
        v.literal("reverb"),
        v.literal("spectral"),
        v.literal("instrument"),
        v.literal("synth"),
        v.literal("arpeggiator"),
      ),
      instanceId: v.optional(v.string()),
      index: v.optional(v.number()),
      params: v.any(),
    })),
    automation: v.array(v.object({
      effectInstanceId: v.optional(v.string()),
      parameterId: v.string(),
      enabled: v.boolean(),
      points: v.array(v.object({
        id: v.string(),
        timeSec: v.number(),
        value: v.number(),
        interpolation: v.union(v.literal("linear"), v.literal("hold")),
      })),
      updatedAt: v.number(),
    })),
    sidechainRoutes: v.optional(v.array(v.object({
      sourceTrackId: v.optional(v.string()),
      targetTrackId: v.optional(v.string()),
      effectInstanceId: v.string(),
    }))),
    operationId: v.optional(v.string()),
  },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return await runSharedOperationOnce(ctx, {
      projectId: input.projectId,
      userId,
      operationId: input.operationId,
      isResult: (value): value is { status: "applied"; groupId: string } | { status: "rejected" } => (
        typeof value === "object"
        && value !== null
        && "status" in value
        && (
          value.status === "rejected"
          || (value.status === "applied" && "groupId" in value && typeof value.groupId === "string")
        )
      ),
      run: async () => {
        await requireProjectRole(ctx, input.projectId, userId, ["owner", "editor"]);
        const effects = normalizeSharedUngroupRestoreEffects(input.effects);
        const automation = normalizeSharedUngroupRestoreAutomation(input.automation);
        if (!effects || !automation) return { status: "rejected" as const };
        const effectInstanceIds = new Set(effects.flatMap((effect) => effect.instanceId ? [effect.instanceId] : []));
        if (automation.some((envelope) => envelope.effectInstanceId && !effectInstanceIds.has(envelope.effectInstanceId))) {
          return { status: "rejected" as const };
        }
        const tracks = await listProjectTracksWithMixerChannels(ctx, input.projectId);
        const trackById = new Map(tracks.map((track) => [String(track._id), track]));
        const requiredTrackIds = new Set<string>(input.children.map((child) => child.trackId));
        if (input.group.parentGroupId) requiredTrackIds.add(input.group.parentGroupId);
        if (input.group.outputTargetId) requiredTrackIds.add(input.group.outputTargetId);
        for (const send of input.group.sends) requiredTrackIds.add(send.targetId);
        for (const child of input.children) if (!child.outputToGroup && child.outputTargetId) requiredTrackIds.add(child.outputTargetId);
        for (const route of input.sidechainRoutes ?? []) {
          if (route.sourceTrackId) requiredTrackIds.add(route.sourceTrackId);
          if (route.targetTrackId) requiredTrackIds.add(route.targetTrackId);
        }
        if (Array.from(requiredTrackIds).some((trackId) => !trackById.has(trackId))) return { status: "rejected" as const };
        const parent = input.group.parentGroupId ? trackById.get(input.group.parentGroupId) : undefined;
        if (parent && parent.channelRole !== "group") return { status: "rejected" as const };
        const childIds = new Set(input.children.map((child) => child.trackId));
        if (childIds.size !== input.children.length) return { status: "rejected" as const };
        const childAccesses = await Promise.all(input.children.map((child) => {
          const track = trackById.get(child.trackId);
          return track ? getTrackWriteAccess(ctx, track._id, userId) : null;
        }));
        if (childAccesses.some((access) => !access)) return { status: "rejected" as const };
        const childLocks = await Promise.all(input.children.map((child) => {
          const track = trackById.get(child.trackId);
          return track ? isTrackLockedByOther(ctx, track, userId) : true;
        }));
        if (childLocks.some(Boolean)) return { status: "rejected" as const };
        if (!validateRestoreUngroupRouting(input, tracks)) return { status: "rejected" as const };
        const sidechainTargetKeys = new Set<string>();
        for (const route of input.sidechainRoutes ?? []) {
          if (route.sourceTrackId === route.targetTrackId) return { status: "rejected" as const };
          const targetKey = `${route.targetTrackId ?? restoreGroupPlaceholderId}:${route.effectInstanceId}`;
          if (sidechainTargetKeys.has(targetKey)) return { status: "rejected" as const };
          sidechainTargetKeys.add(targetKey);
          if (!route.targetTrackId) {
            const matchingEffects = effects.filter((effect) => (
              (effect.type === "compressor" || effect.type === "gate" || effect.type === "spectral")
              && effect.instanceId === route.effectInstanceId
            ));
            if (matchingEffects.length !== 1) return { status: "rejected" as const };
            continue;
          }
          const targetTrack = trackById.get(route.targetTrackId);
          if (!targetTrack) return { status: "rejected" as const };
          const targetEffects = await ctx.db.query("effects").withIndex("by_track", (q: any) => q.eq("trackId", targetTrack._id)).collect();
          const matchingEffects = targetEffects.filter((effect: any) => (
            (effect.type === "compressor" || effect.type === "gate" || effect.type === "spectral")
            && effect.instanceId === route.effectInstanceId
          ));
          if (matchingEffects.length !== 1) return { status: "rejected" as const };
        }

        const index = Math.max(0, Math.min(Math.round(input.group.index), tracks.length));
        for (const track of tracks) {
          if (track.index >= index) await ctx.db.patch(track._id, { index: track.index + 1 });
        }
        const parentGroupId = parent?._id;
        const outputTargetId = input.group.outputTargetId ? trackById.get(input.group.outputTargetId)?._id : undefined;
        const sends = input.group.sends.flatMap((send) => {
          const target = trackById.get(send.targetId);
          return target ? [{ targetId: target._id, amount: send.amount, tap: send.tap }] : [];
        });
        const groupId = await ctx.db.insert("tracks", {
          projectId: input.projectId,
          name: input.group.name ?? `Track ${index + 1}`,
          index,
          kind: input.group.kind,
          historyRef: input.group.historyRef,
          groupId: parentGroupId,
          collapsed: input.group.collapsed,
          color: input.group.color,
        });
        await ctx.db.insert("mixerChannels", buildMixerChannelInsert(input.projectId, groupId, {
          volume: input.group.volume,
          muted: input.group.muted,
          soloed: input.group.soloed,
          channelRole: "group",
          outputTargetId,
          sends,
        }));
        await ctx.db.insert("ownerships", { projectId: input.projectId, ownerUserId: userId, trackId: groupId });
        for (const child of input.children) {
          const track = trackById.get(child.trackId);
          if (!track) throw new Error("Restore group preflight became invalid.");
          await ctx.db.patch(track._id, { groupId });
          const channel = await ensureMixerChannelForTrack(ctx, track);
          const childOutputTargetId = child.outputToGroup
            ? groupId
            : (child.outputTargetId ? trackById.get(child.outputTargetId)?._id : undefined);
          await ctx.db.patch(channel._id, { outputTargetId: childOutputTargetId });
        }
        for (const effect of effects) {
          await ctx.db.insert("effects", {
            projectId: input.projectId,
            targetType: "track",
            trackId: groupId,
            index: effect.index ?? 0,
            type: effect.type,
            instanceId: effect.instanceId,
            params: effect.params,
            createdAt: Date.now(),
          });
        }
        for (const envelope of automation) {
          const parameterId = rebaseRestoredAutomationParameter(String(groupId), envelope.parameterId);
          await ctx.db.insert("automationEnvelopes", {
            projectId: input.projectId,
            targetKind: "track",
            trackId: groupId,
            effectInstanceId: envelope.effectInstanceId,
            targetKey: automationTargetKey({ kind: "track", trackId: String(groupId), effectInstanceId: envelope.effectInstanceId }, parameterId),
            parameterId,
            enabled: envelope.enabled,
            points: envelope.points,
            updatedAt: envelope.updatedAt,
          });
        }
        for (const route of input.sidechainRoutes ?? []) {
          const sourceTrackId = route.sourceTrackId ? trackById.get(route.sourceTrackId)?._id : groupId;
          const targetTrackId = route.targetTrackId ? trackById.get(route.targetTrackId)?._id : groupId;
          if (!sourceTrackId || !targetTrackId) throw new Error("Restore group sidechain preflight became invalid.");
          await ctx.db.insert("sidechainRoutes", {
            projectId: input.projectId,
            sourceTrackId,
            targetTrackId,
            effectInstanceId: route.effectInstanceId,
          });
        }
        await advanceProjectRevision(ctx, input.projectId);
        return { status: "applied" as const, groupId: String(groupId) };
      },
    });
  },
});

export const serverSetColorCascade = mutation({
  args: {
    rootTrackId: v.string(),
    color: v.optional(v.union(v.string(), v.null())),
    cascadeClipColors: v.boolean(),
  },
  handler: async (ctx, { rootTrackId, color, cascadeClipColors }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const normalizedRootTrackId = ctx.db.normalizeId("tracks", rootTrackId);
    if (!normalizedRootTrackId) return { status: "rejected" as const };
    const rootAccess = await getTrackWriteAccess(ctx, normalizedRootTrackId, userId);
    if (!rootAccess) return { status: "rejected" as const };
    const tracks = await listProjectTracksWithMixerChannels(ctx, rootAccess.track.projectId);
    const root = tracks.find((track) => String(track._id) === String(normalizedRootTrackId));
    if (!root) return { status: "rejected" as const };
    const targetTrackIds = root.channelRole === "group"
      ? new Set([String(root._id), ...collectTrackDescendantIds(tracks.map((track) => ({ id: String(track._id), groupId: track.groupId ? String(track.groupId) : undefined })), String(root._id))])
      : new Set([String(root._id)]);
    const targetTracks = tracks.filter((track) => targetTrackIds.has(String(track._id)));
    const clipColor = color && isHexColor(color) ? color : undefined;
    const targetClips = root.channelRole === "group" && cascadeClipColors && clipColor
      ? (await Promise.all(targetTracks.map((track) => (
        ctx.db.query("clips").withIndex("by_track", (q: any) => q.eq("trackId", track._id)).collect()
      )))).flat()
      : [];
    const colorUpdates = {
      trackUpdates: targetTracks.map((track) => ({ trackId: String(track._id), color })),
      clipUpdates: targetClips.map((clip) => ({ clipId: String(clip._id), color: clipColor ?? clip.color ?? "" })),
    };
    const updates = await applyColorBatchForUser(ctx, userId, colorUpdates);
    return updates
      ? { status: "applied" as const, ...updates }
      : { status: "rejected" as const };
  },
});

export const setTrackNameRow = async (
  ctx: MutationCtx,
  input: { projectId: string; trackId: Id<"tracks">; name: string },
) => {
  const track = await ctx.db.get(input.trackId);
  if (!track || track.projectId !== input.projectId) {
    return { changed: false, status: "not-found" as const };
  }
  const nextName = input.name.trim().slice(0, 120) || `Track ${track.index + 1}`;
  if (track.name === nextName) {
    return { changed: false, status: "noop" as const, name: nextName };
  }
  await ctx.db.patch(input.trackId, { name: nextName });
  return { changed: true, status: "applied" as const, name: nextName };
};

export const setName = mutation({
  args: { trackId: v.id("tracks"), name: v.string() },
  handler: async (ctx, { trackId, name }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const { track } = await requireTrackOwnerForWrite(ctx, trackId, userId);
    const result = await setTrackNameRow(ctx, { projectId: track.projectId, trackId, name });
    if (result.changed) await advanceProjectRevision(ctx, track.projectId);
  },
});

export const serverSetName = mutation({
  args: { trackId: v.string(), name: v.string() },
  handler: async (ctx, { trackId, name }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const normalizedTrackId = ctx.db.normalizeId("tracks", trackId);
    if (!normalizedTrackId) throw new Error("Track not found.");
    const { track } = await requireTrackOwnerForWrite(ctx, normalizedTrackId, userId);
    const result = await setTrackNameRow(ctx, {
      projectId: track.projectId,
      trackId: normalizedTrackId,
      name,
    });
    if (result.changed) await advanceProjectRevision(ctx, track.projectId);
  },
});

export const serverApplyColorBatch = mutation({
  args: {
    trackUpdates: v.array(v.object({ trackId: v.string(), color: v.optional(v.union(v.string(), v.null())) })),
    clipUpdates: v.array(v.object({ clipId: v.string(), color: v.string() })),
  },
  handler: async (ctx, input) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const updates = await applyColorBatchForUser(ctx, userId, input);
    return updates
      ? { status: "applied" as const, ...updates }
      : { status: "rejected" as const };
  },
});

export const lock = mutation({
  args: { trackId: v.id("tracks") },
  handler: async (ctx, { trackId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return await lockTrackForUser(ctx, trackId, userId);
  },
});

export const serverLock = mutation({
  args: { trackId: v.string() },
  handler: async (ctx, { trackId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const normalizedTrackId = ctx.db.normalizeId("tracks", trackId);
    if (!normalizedTrackId) return { ok: false, reason: "Track not found" };
    return await lockTrackForUser(ctx, normalizedTrackId, userId);
  },
});

export const unlock = mutation({
  args: { trackId: v.id("tracks") },
  handler: async (ctx, { trackId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return await unlockTrackForUser(ctx, trackId, userId);
  },
});

export const serverUnlock = mutation({
  args: { trackId: v.string() },
  handler: async (ctx, { trackId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const normalizedTrackId = ctx.db.normalizeId("tracks", trackId);
    if (!normalizedTrackId) return { ok: false };
    return await unlockTrackForUser(ctx, normalizedTrackId, userId);
  },
});

export const remove = mutation({
  args: { trackId: v.id("tracks") },
  returns: trackDeleteResult,
  handler: async (ctx, { trackId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const rootPreflight = await getTrackDeletePreflight(ctx, trackId, userId);
    if (!rootPreflight.ok) {
      if (rootPreflight.reason === "access-denied") {
        return { status: "access-denied" as const };
      }
      return {
        status: "conflict" as const,
        reason: rootPreflight.reason,
      };
    }

    const projectTracks = await ctx.db
      .query("tracks")
      .withIndex("by_room_index", (q: any) => q.eq("projectId", rootPreflight.track.projectId))
      .collect();
    const subtreeIds = collectTrackSubtreeIds(projectTracks, trackId);
    const descendantPreflights = await Promise.all(
      subtreeIds.slice(1).map((subtreeTrackId) => getTrackDeletePreflight(ctx, subtreeTrackId, userId)),
    );
    const preflights = [rootPreflight];
    for (const preflight of descendantPreflights) {
      if (!preflight.ok) {
        if (preflight.reason === "access-denied") {
          return { status: "access-denied" as const };
        }
        return {
          status: "conflict" as const,
          reason: preflight.reason,
        };
      }
      preflights.push(preflight);
    }

    const result = await deleteTrackRows(ctx, {
      projectId: rootPreflight.track.projectId,
      trackIds: preflights.map((preflight) => preflight.track._id),
    });
    if (!result.changed) return { status: "access-denied" as const };
    await advanceProjectRevision(ctx, rootPreflight.track.projectId);
    return { status: "deleted" as const };
  },
});
