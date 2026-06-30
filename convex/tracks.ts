import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import {
  buildMixerChannelInsert,
  deleteMixerStateForTrack,
  ensureMixerChannelForTrack,
  listProjectTracksWithMixerChannels,
  normalizeMixerLockState,
  removeTrackRoutingReferences,
} from "./mixerChannels";
import {
  sanitizeChannelRole,
  sanitizeTrackRouting,
} from "./trackRouting";
import { getTrackWriteAccess, requireTrackOwnerForWrite } from "./trackWrites";
import { requireAuthenticatedUserId, requireProjectAccess, requireProjectRole } from "./projectAccess";
import { runSharedOperationOnce } from "./sharedOperationResults";

type DeleteOwnedTrackOptions = {
  onlyIfEmpty?: boolean
  assumeOwnedClipsRemoved?: boolean
}

const trackDeleteConflictReason = v.union(
  v.literal("foreign-clips"),
  v.literal("not-empty"),
  v.literal("locked"),
)

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

async function deleteTrackFromPreflight(
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

  await removeTrackRoutingReferences(ctx, track.projectId, track._id);
  const automationEnvelopes = await ctx.db
    .query("automationEnvelopes")
    .withIndex("by_project_track", (q: any) => q.eq("projectId", track.projectId).eq("trackId", track._id))
    .collect();
  for (const envelope of automationEnvelopes) {
    await ctx.db.delete(envelope._id);
  }
  await deleteMixerStateForTrack(ctx, track._id);
  await ctx.db.delete(owner._id);
  await ctx.db.delete(track._id);
  const remaining = await ctx.db
    .query("tracks")
    .withIndex("by_room_index", (q: any) => q.eq("projectId", track.projectId))
    .collect();
  for (const remainingTrack of remaining) {
    if (remainingTrack.index <= track.index) continue;
    await ctx.db.patch(remainingTrack._id, { index: remainingTrack.index - 1 });
  }
  return true;
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

const createTrackForUser = async (
  ctx: any,
  input: {
    projectId: string
    userId: string
    index?: number
    kind?: string
    channelRole?: string
    operationId?: string
  },
) => {
  return await runSharedOperationOnce(ctx, {
    projectId: input.projectId,
    userId: input.userId,
    operationId: input.operationId,
    isResult: (value): value is string => typeof value === "string",
    run: async () => {
      await requireProjectRole(ctx, input.projectId, input.userId, ["owner", "editor"]);
      const existing = await ctx.db
        .query("tracks")
        .withIndex("by_room_index", (q: any) => q.eq("projectId", input.projectId))
        .collect();
      let nextIndex = existing.length;
      if (input.index !== undefined) {
        nextIndex = Math.max(0, Math.min(input.index, existing.length));
      }
      for (let existingIndex = existing.length - 1; existingIndex >= 0; existingIndex -= 1) {
        const track = existing[existingIndex];
        if (track.index < nextIndex) break;
        await ctx.db.patch(track._id, { index: track.index + 1 });
      }
      const trackId = await ctx.db.insert("tracks", {
        projectId: input.projectId,
        index: nextIndex,
        kind: input.kind,
      });
      await ctx.db.insert(
        "mixerChannels",
        buildMixerChannelInsert(input.projectId, trackId, {
          channelRole: sanitizeChannelRole(input.channelRole),
        }),
      );
      await ctx.db.insert("ownerships", {
        projectId: input.projectId,
        ownerUserId: input.userId,
        trackId,
      });
      return trackId;
    },
  });
}

const setTrackVolumeForUser = async (ctx: any, trackId: any, userId: string, volume: number) => {
  const { track } = await requireTrackOwnerForWrite(ctx, trackId, userId);
  const channel = await ensureMixerChannelForTrack(ctx, track);
  if (channel.volume === volume) return;
  await ctx.db.patch(channel._id, { volume });
}

const setTrackMixForUser = async (
  ctx: any,
  input: { trackId: any; userId: string; muted?: boolean; soloed?: boolean },
) => {
  const track = await ctx.db.get(input.trackId);
  if (!track) return { status: "not-found" as const };
  const access = await getTrackWriteAccess(ctx, input.trackId, input.userId);
  if (!access) return { status: "access-denied" as const };
  const channel = await ensureMixerChannelForTrack(ctx, access.track);
  const patch: any = {};
  if (input.muted !== undefined && input.muted !== channel.muted) patch.muted = input.muted;
  if (input.soloed !== undefined && input.soloed !== channel.soloed) patch.soloed = input.soloed;
  if (Object.keys(patch).length === 0) return { status: "noop" as const };
  await ctx.db.patch(channel._id, patch);
  return { status: "applied" as const };
}

const mixerSendsEqual = (
  left: Array<{ targetId: string; amount: number }>,
  right: Array<{ targetId: string; amount: number }>,
) => (
  left.length === right.length
  && left.every((send, index) => send.targetId === right[index]?.targetId && send.amount === right[index]?.amount)
)

const setTrackRoutingForUser = async (
  ctx: any,
  input: {
    trackId: any
    userId: string
    outputTargetId?: any | null
    sends?: Array<{ targetId: any; amount: number }>
  },
) => {
  const { track } = await requireTrackOwnerForWrite(ctx, input.trackId, input.userId);
  const channel = await ensureMixerChannelForTrack(ctx, track);
  if (input.sends === undefined && input.outputTargetId === undefined) return;
  const tracksInRoom = await listProjectTracksWithMixerChannels(ctx, track.projectId);
  const nextSends = input.sends === undefined ? channel.sends : input.sends;
  const nextOutputTargetId = input.outputTargetId === undefined
    ? channel.outputTargetId
    : input.outputTargetId ?? undefined;
  const normalizedRouting = sanitizeTrackRouting(
    { _id: input.trackId, channelRole: channel.channelRole },
    { sends: nextSends, outputTargetId: nextOutputTargetId },
    tracksInRoom as any,
  );
  if (
    normalizedRouting.outputTargetId === channel.outputTargetId
    && mixerSendsEqual(normalizedRouting.sends, channel.sends)
  ) return;
  await ctx.db.patch(channel._id, {
    sends: normalizedRouting.sends as any,
    outputTargetId: normalizedRouting.outputTargetId as any,
  });
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
  args: { projectId: v.string(), index: v.optional(v.number()), kind: v.optional(v.string()), channelRole: v.optional(v.string()), operationId: v.optional(v.string()) },
  handler: async (ctx, { projectId, index, kind, channelRole, operationId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return await createTrackForUser(ctx, { projectId, userId, index, kind, channelRole, operationId });
  },
});

export const serverCreate = mutation({
  args: {
    projectId: v.string(),
    index: v.optional(v.number()),
    kind: v.optional(v.string()),
    channelRole: v.optional(v.string()),
    operationId: v.optional(v.string()),
  },
  handler: async (ctx, { projectId, index, kind, channelRole, operationId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return await createTrackForUser(ctx, { projectId, userId, index, kind, channelRole, operationId });
  },
});

export const setVolume = mutation({
  args: { trackId: v.id("tracks"), volume: v.number() },
  handler: async (ctx, { trackId, volume }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await setTrackVolumeForUser(ctx, trackId, userId, volume);
  },
});

export const serverSetVolume = mutation({
  args: { trackId: v.string(), volume: v.number() },
  handler: async (ctx, { trackId, volume }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const normalizedTrackId = ctx.db.normalizeId("tracks", trackId);
    if (!normalizedTrackId) throw new Error("Track not found.");
    await setTrackVolumeForUser(ctx, normalizedTrackId, userId, volume);
  },
});

export const setMix = mutation({
  args: { trackId: v.id("tracks"), muted: v.optional(v.boolean()), soloed: v.optional(v.boolean()) },
  returns: trackMixWriteResult,
  handler: async (ctx, { trackId, muted, soloed }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return await setTrackMixForUser(ctx, { trackId, userId, muted, soloed });
  },
});

export const serverSetMix = mutation({
  args: { trackId: v.string(), muted: v.optional(v.boolean()), soloed: v.optional(v.boolean()) },
  returns: trackMixWriteResult,
  handler: async (ctx, { trackId, muted, soloed }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const normalizedTrackId = ctx.db.normalizeId("tracks", trackId);
    if (!normalizedTrackId) return { status: "not-found" as const };
    return await setTrackMixForUser(ctx, { trackId: normalizedTrackId, userId, muted, soloed });
  },
});

export const setRouting = mutation({
  args: {
    trackId: v.id("tracks"),
    outputTargetId: v.optional(v.union(v.id("tracks"), v.null())),
    sends: v.optional(v.array(v.object({
      targetId: v.id("tracks"),
      amount: v.number(),
    }))),
  },
  handler: async (ctx, { trackId, outputTargetId, sends }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await setTrackRoutingForUser(ctx, { trackId, userId, outputTargetId, sends });
  },
});

export const serverSetRouting = mutation({
  args: {
    trackId: v.string(),
    outputTargetId: v.optional(v.union(v.string(), v.null())),
    sends: v.optional(v.array(v.object({
      targetId: v.string(),
      amount: v.number(),
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
      return targetId ? [{ targetId, amount: send.amount }] : [];
    });
    if (sends && normalizedSends?.length !== sends.length) {
      throw new Error("Send target track not found.");
    }

    await setTrackRoutingForUser(ctx, {
      trackId: normalizedTrackId,
      userId,
      outputTargetId: normalizedOutputTargetId,
      sends: normalizedSends,
    });
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
    const preflight = await getTrackDeletePreflight(ctx, trackId, userId);
    if (!preflight.ok) {
      if (preflight.reason === "access-denied") {
        return { status: "access-denied" as const };
      }
      return {
        status: "conflict" as const,
        reason: preflight.reason,
      };
    }

    await deleteTrackFromPreflight(ctx, preflight);
    return { status: "deleted" as const };
  },
});
