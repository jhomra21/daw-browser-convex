import type { Doc, Id } from "./_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "./_generated/server";
import { assert, assertDefined } from "@daw-browser/shared";

export type MixerSend = {
  targetId: Id<"tracks">;
  amount: number;
  tap?: "pre-fx" | "pre-fader" | "post-fader";
};

export type MergedTrackDoc = Doc<"tracks"> & {
  volume: number;
  muted?: boolean;
  soloed?: boolean;
  lockedBy?: string;
  lockedAt?: number;
  channelRole: string;
  outputTargetId?: Id<"tracks">;
  sends: MixerSend[];
};

export type MergedTrackDocWithMixerChannel = MergedTrackDoc & {
  mixerChannelId: Id<"mixerChannels">;
};

type MixerChannelState = {
  volume: number;
  muted?: boolean;
  soloed?: boolean;
  lockedBy?: string;
  lockedAt?: number;
  channelRole: string;
  outputTargetId?: Id<"tracks">;
  sends: MixerSend[];
};

type MixerChannelStateOverrides = Partial<Omit<MixerChannelState, "sends">> & {
  sends?: MixerSend[];
};

type MixerReadCtx = { db: DatabaseReader };

export const STALE_LOCK_MS = 60_000;

export function isMixerLockStale(
  lockedBy: string | undefined,
  lockedAt: number | undefined,
  now = Date.now(),
) {
  return !!lockedBy && lockedAt !== undefined && now - lockedAt > STALE_LOCK_MS;
}

export function normalizeMixerLockState(
  lockedBy: string | undefined,
  lockedAt: number | undefined,
  now = Date.now(),
) {
  if (!lockedBy || lockedAt === undefined || isMixerLockStale(lockedBy, lockedAt, now)) {
    return {
      lockedBy: undefined,
      lockedAt: undefined,
      isLocked: false,
    };
  }

  return {
    lockedBy,
    lockedAt,
    isLocked: true,
  };
}

function buildMixerChannelStateRecord(fields: MixerChannelStateOverrides = {}, now = Date.now()) {
  const lockState = normalizeMixerLockState(fields.lockedBy, fields.lockedAt, now);
  let volume = fields.volume;
  if (volume === undefined) volume = 0.8;
  let channelRole = fields.channelRole;
  if (channelRole === undefined) channelRole = "track";
  let sends = fields.sends;
  if (sends === undefined) sends = [];
  return {
    volume,
    muted: fields.muted,
    soloed: fields.soloed,
    lockedBy: lockState.lockedBy,
    lockedAt: lockState.lockedAt,
    channelRole,
    outputTargetId: fields.outputTargetId,
    sends,
  };
}

export function buildMixerChannelInsert(
  projectId: string,
  trackId: Id<"tracks">,
  fields: MixerChannelStateOverrides = {},
  now = Date.now(),
) {
  return {
    projectId,
    trackId,
    ...buildMixerChannelStateRecord(fields, now),
  };
}

function removeRoutingReferencesToTracksFromFields(
  fields: {
    outputTargetId?: Id<"tracks">;
    sends?: MixerSend[];
  },
  trackIds: ReadonlySet<string>,
) {
  const nextSends: MixerSend[] = [];
  let sendsChanged = false;
  for (const send of Array.isArray(fields.sends) ? fields.sends : []) {
    if (trackIds.has(String(send?.targetId))) {
      sendsChanged = true;
      continue;
    }
    nextSends.push(send);
  }

  const nextOutputTargetId = trackIds.has(String(fields.outputTargetId))
    ? undefined
    : fields.outputTargetId;
  const outputChanged = nextOutputTargetId !== fields.outputTargetId;

  if (!sendsChanged && !outputChanged) return null;

  return {
    outputTargetId: nextOutputTargetId,
    sends: nextSends,
  };
}

function mergeTrackWithMixerState(
  track: Doc<"tracks">,
  channel: Doc<"mixerChannels"> | null | undefined,
  now: number,
  includeMixerChannelId: false,
): MergedTrackDoc;
function mergeTrackWithMixerState(
  track: Doc<"tracks">,
  channel: Doc<"mixerChannels"> | null | undefined,
  now: number,
  includeMixerChannelId: true,
): MergedTrackDocWithMixerChannel;
function mergeTrackWithMixerState(
  track: Doc<"tracks">,
  channel: Doc<"mixerChannels"> | null | undefined,
  now = Date.now(),
  includeMixerChannelId = false,
): MergedTrackDoc | MergedTrackDocWithMixerChannel {
  const definedChannel = assertDefined(channel, `Missing mixer channel for track ${String(track._id)}.`);
  assert(definedChannel.channelRole !== undefined, `Missing mixer channel role for track ${String(track._id)}.`);
  assert(definedChannel.sends !== undefined, `Missing mixer channel sends for track ${String(track._id)}.`);
  const lockState = normalizeMixerLockState(definedChannel.lockedBy, definedChannel.lockedAt, now);
  const merged = {
    ...track,
    volume: definedChannel.volume,
    muted: definedChannel.muted,
    soloed: definedChannel.soloed,
    lockedBy: lockState.lockedBy,
    lockedAt: lockState.lockedAt,
    channelRole: definedChannel.channelRole,
    outputTargetId: definedChannel.outputTargetId,
    sends: definedChannel.sends,
  };
  return includeMixerChannelId
    ? { ...merged, mixerChannelId: definedChannel._id }
    : merged;
}

export async function listMixerChannelsForTrack(ctx: MixerReadCtx, trackId: Id<"tracks">) {
  return await ctx.db
    .query("mixerChannels")
    .withIndex("by_track", (q) => q.eq("trackId", trackId))
    .collect();
}

export async function deleteMixerStateForTrack(ctx: MutationCtx, trackId: Id<"tracks">) {
  const rows = await listMixerChannelsForTrack(ctx, trackId);
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
}

export async function removeTrackRoutingReferences(
  ctx: MutationCtx,
  projectId: string,
  trackId: Id<"tracks">,
) {
  await removeTracksRoutingReferences(ctx, projectId, new Set([String(trackId)]));
}

export async function removeTracksRoutingReferences(
  ctx: MutationCtx,
  projectId: string,
  trackIds: ReadonlySet<string>,
) {
  const roomChannels = await ctx.db
    .query("mixerChannels")
    .withIndex("by_room", (q) => q.eq("projectId", projectId))
    .collect();

  for (const roomChannel of roomChannels) {
    if (trackIds.has(String(roomChannel.trackId))) continue;

    const patch = removeRoutingReferencesToTracksFromFields(roomChannel, trackIds);
    if (!patch) continue;
    await ctx.db.patch(roomChannel._id, patch);
  }
}

export async function ensureMixerChannelForTrack(ctx: MixerReadCtx, track: Doc<"tracks">) {
  const rows = await listMixerChannelsForTrack(ctx, track._id);
  assert(rows.length === 1, `Expected exactly one mixer channel for track ${String(track._id)}.`);
  return assertDefined(rows[0], `Missing mixer channel for track ${String(track._id)}.`);
}

export async function listProjectTracksWithMixerChannels(
  ctx: MixerReadCtx,
  projectId: string,
): Promise<MergedTrackDoc[]>;
export async function listProjectTracksWithMixerChannels(
  ctx: MixerReadCtx,
  projectId: string,
  includeMixerChannelIds: true,
): Promise<MergedTrackDocWithMixerChannel[]>;
export async function listProjectTracksWithMixerChannels(
  ctx: MixerReadCtx,
  projectId: string,
  includeMixerChannelIds = false,
): Promise<MergedTrackDoc[] | MergedTrackDocWithMixerChannel[]> {
  const [tracks, channels] = await Promise.all([
    ctx.db.query("tracks").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect(),
    ctx.db.query("mixerChannels").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect(),
  ]);
  const channelByTrackId = new Map<string, Doc<"mixerChannels">>();
  for (const channel of channels) {
    const trackId = String(channel.trackId);
    assert(!channelByTrackId.has(trackId), `Expected exactly one mixer channel for track ${trackId}.`);
    channelByTrackId.set(trackId, channel);
  }
  const now = Date.now();
  return tracks
    .map((track) => {
      const channel = assertDefined(
        channelByTrackId.get(String(track._id)),
        `Missing mixer channel for track ${String(track._id)}.`,
      );
      return includeMixerChannelIds
        ? mergeTrackWithMixerState(track, channel, now, true)
        : mergeTrackWithMixerState(track, channel, now, false);
    })
    .sort((a: MergedTrackDoc, b: MergedTrackDoc) => (a.index ?? 0) - (b.index ?? 0));
}

export async function getMergedTrack(ctx: MixerReadCtx, trackId: Id<"tracks">): Promise<MergedTrackDoc | null> {
  const track = await ctx.db.get(trackId);
  if (!track) return null;
  const channel = await ensureMixerChannelForTrack(ctx, track);
  return mergeTrackWithMixerState(track, channel, Date.now(), false);
}
