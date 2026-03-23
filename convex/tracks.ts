import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import {
  buildMixerChannelInsert,
  deleteMixerStateForTrack,
  ensureMixerChannelForTrack,
  getMergedTrack,
  isMixerLockStale,
  listRoomTracksWithMixerChannels,
  removeTrackRoutingReferences,
} from "./mixerChannels";
import {
  sanitizeChannelRole,
  sanitizeTrackRouting,
} from "./trackRouting";
import { getTrackWriteAccess, requireTrackOwnerForWrite } from "./trackWrites";

type DeleteOwnedTrackOptions = {
  onlyIfEmpty?: boolean
  assumeOwnedClipsRemoved?: boolean
}

const trackDeleteConflictReason = v.union(
  v.literal("foreign-clips"),
  v.literal("not-empty"),
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
      reason: "access-denied" | "not-empty" | "foreign-clips"
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

  const { owner, track } = access;
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
    const ownedByUser = !!clipOwner && clipOwner.ownerUserId === userId;
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

  await removeTrackRoutingReferences(ctx, track.roomId, track._id);
  await deleteMixerStateForTrack(ctx, track._id);
  await ctx.db.delete(owner._id);
  await ctx.db.delete(track._id);
  const remaining = await ctx.db
    .query("tracks")
    .withIndex("by_room_index", (q: any) => q.eq("roomId", track.roomId))
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
  args: { roomId: v.string() },
  handler: async (ctx, { roomId }) => {
    return await listRoomTracksWithMixerChannels(ctx, roomId);
  },
});

export const create = mutation({
  args: { roomId: v.string(), userId: v.string(), index: v.optional(v.number()), kind: v.optional(v.string()), channelRole: v.optional(v.string()) },
  handler: async (ctx, { roomId, userId, index, kind, channelRole }) => {
    const existing = await ctx.db
      .query("tracks")
      .withIndex("by_room_index", q => q.eq("roomId", roomId))
      .collect();
    let nextIndex = existing.length;
    if (index !== undefined) {
      nextIndex = Math.max(0, Math.min(index, existing.length));
    }
    for (let existingIndex = existing.length - 1; existingIndex >= 0; existingIndex -= 1) {
      const track = existing[existingIndex];
      if (track.index < nextIndex) break;
      await ctx.db.patch(track._id, { index: track.index + 1 });
    }

    const trackId = await ctx.db.insert("tracks", {
      roomId,
      index: nextIndex,
      kind,
    });
    await ctx.db.insert(
      "mixerChannels",
      buildMixerChannelInsert(roomId, trackId, {
        channelRole: sanitizeChannelRole(channelRole),
      }),
    );
    await ctx.db.insert("ownerships", {
      roomId,
      ownerUserId: userId,
      trackId,
    });
    return trackId;
  },
});

export const setVolume = mutation({
  args: { trackId: v.id("tracks"), volume: v.number(), userId: v.string() },
  handler: async (ctx, { trackId, volume, userId }) => {
    const { track } = await requireTrackOwnerForWrite(ctx, trackId, userId);
    const channel = await ensureMixerChannelForTrack(ctx, track);
    await ctx.db.patch(channel._id, { volume });
  },
});

export const setMix = mutation({
  args: { trackId: v.id("tracks"), muted: v.optional(v.boolean()), soloed: v.optional(v.boolean()), userId: v.string() },
  returns: trackMixWriteResult,
  handler: async (ctx, { trackId, muted, soloed, userId }) => {
    const track = await ctx.db.get(trackId);
    if (!track) return { status: "not-found" as const };

    const access = await getTrackWriteAccess(ctx, trackId, userId);
    if (!access) return { status: "access-denied" as const };

    const channel = await ensureMixerChannelForTrack(ctx, access.track);

    const patch: any = {};
    if (muted !== undefined) patch.muted = muted;
    if (soloed !== undefined) patch.soloed = soloed;
    if (Object.keys(patch).length === 0) return { status: "noop" as const };

    await ctx.db.patch(channel._id, patch);
    return { status: "applied" as const };
  },
});

export const setRouting = mutation({
  args: {
    trackId: v.id("tracks"),
    userId: v.string(),
    outputTargetId: v.optional(v.union(v.id("tracks"), v.null())),
    sends: v.optional(v.array(v.object({
      targetId: v.id("tracks"),
      amount: v.number(),
    }))),
  },
  handler: async (ctx, { trackId, userId, outputTargetId, sends }) => {
    const { track } = await requireTrackOwnerForWrite(ctx, trackId, userId);

    const channel = await ensureMixerChannelForTrack(ctx, track);
    const mergedTrack = await getMergedTrack(ctx, trackId);
    if (!mergedTrack) return;

    const tracksInRoom = await listRoomTracksWithMixerChannels(ctx, track.roomId);

    const nextSends = sends === undefined ? mergedTrack.sends : sends;
    const nextOutputTargetId = outputTargetId === undefined
      ? mergedTrack.outputTargetId
      : outputTargetId ?? undefined;

    const normalizedRouting = sanitizeTrackRouting(
      { _id: trackId, channelRole: mergedTrack.channelRole },
      {
        sends: nextSends,
        outputTargetId: nextOutputTargetId,
      },
      tracksInRoom as any,
    );

    await ctx.db.patch(channel._id, {
      sends: normalizedRouting.sends as any,
      outputTargetId: normalizedRouting.outputTargetId as any,
    });
  },
});

export const lock = mutation({
  args: { trackId: v.id("tracks"), userId: v.string() },
  handler: async (ctx, { trackId, userId }) => {
    const track = await ctx.db.get(trackId);
    if (!track) {
      return { ok: false, reason: "Track not found" };
    }
    const channel = await ensureMixerChannelForTrack(ctx, track);
    const mergedTrack = await getMergedTrack(ctx, trackId);
    if (!mergedTrack) return { ok: false, reason: "Track not found" };
    const now = Date.now();
    if (mergedTrack.lockedBy && mergedTrack.lockedBy !== userId) {
      if (isMixerLockStale(mergedTrack.lockedBy, mergedTrack.lockedAt ?? undefined, now)) {
        await ctx.db.patch(channel._id, { lockedBy: userId, lockedAt: now });
        return { ok: true };
      }
      return { ok: false, reason: "Track locked by another user" };
    }
    await ctx.db.patch(channel._id, { lockedBy: userId, lockedAt: now });
    return { ok: true };
  },
});

export const unlock = mutation({
  args: { trackId: v.id("tracks"), userId: v.string() },
  handler: async (ctx, { trackId, userId }) => {
    const track = await ctx.db.get(trackId);
    if (!track) return { ok: false };
    const channel = await ensureMixerChannelForTrack(ctx, track);
    const mergedTrack = await getMergedTrack(ctx, trackId);
    if (!mergedTrack) return { ok: false };
    if (mergedTrack.lockedBy && mergedTrack.lockedBy !== userId) {
      return { ok: false };
    }
    await ctx.db.patch(channel._id, { lockedBy: undefined, lockedAt: undefined });
    return { ok: true };
  },
});

export const remove = mutation({
  args: { trackId: v.id("tracks"), userId: v.string() },
  returns: trackDeleteResult,
  handler: async (ctx, { trackId, userId }) => {
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
