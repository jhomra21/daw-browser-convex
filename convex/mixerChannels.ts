import type { Doc, Id } from "./_generated/dataModel";

export type MixerSend = {
  targetId: Id<"tracks">;
  amount: number;
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

export const STALE_LOCK_MS = 60_000;

export function isMixerLockStale(
  lockedBy: string | undefined,
  lockedAt: number | undefined,
  now = Date.now(),
) {
  return !!lockedBy && lockedAt !== undefined && now - lockedAt > STALE_LOCK_MS;
}

function buildMixerChannelStateRecord(fields: MixerChannelStateOverrides = {}, now = Date.now()) {
  const lockedAt = fields.lockedAt;
  const lockedBy = fields.lockedBy;
  const stale = isMixerLockStale(lockedBy, lockedAt, now);
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
    lockedBy: stale ? undefined : lockedBy,
    lockedAt: stale ? undefined : lockedAt,
    channelRole,
    outputTargetId: fields.outputTargetId,
    sends,
  };
}

export function buildMixerChannelInsert(
  roomId: string,
  trackId: Id<"tracks">,
  fields: MixerChannelStateOverrides = {},
  now = Date.now(),
) {
  return {
    roomId,
    trackId,
    ...buildMixerChannelStateRecord(fields, now),
  };
}

function removeRoutingReferencesFromFields(
  fields: {
    outputTargetId?: Id<"tracks">;
    sends?: MixerSend[];
  },
  trackId: Id<"tracks">,
) {
  const nextSends: MixerSend[] = [];
  let sendsChanged = false;
  for (const send of Array.isArray(fields.sends) ? fields.sends : []) {
    if (String(send?.targetId) === String(trackId)) {
      sendsChanged = true;
      continue;
    }
    nextSends.push(send);
  }

  const nextOutputTargetId = String(fields.outputTargetId) === String(trackId)
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
  now = Date.now(),
): MergedTrackDoc {
  if (!channel) {
    throw new Error(`Missing mixer channel for track ${String(track._id)}.`);
  }
  if (channel.channelRole === undefined) {
    throw new Error(`Missing mixer channel role for track ${String(track._id)}.`);
  }
  if (channel.sends === undefined) {
    throw new Error(`Missing mixer channel sends for track ${String(track._id)}.`);
  }
  const stale = isMixerLockStale(channel.lockedBy, channel.lockedAt, now);
  return {
    ...track,
    volume: channel.volume,
    muted: channel.muted,
    soloed: channel.soloed,
    lockedBy: stale ? undefined : channel.lockedBy,
    lockedAt: stale ? undefined : channel.lockedAt,
    channelRole: channel.channelRole,
    outputTargetId: channel.outputTargetId,
    sends: channel.sends,
  };
}

export async function listMixerChannelsForTrack(ctx: any, trackId: Id<"tracks">) {
  const rows = await ctx.db
    .query("mixerChannels")
    .withIndex("by_track", (q: any) => q.eq("trackId", trackId))
    .collect();
  return rows as Doc<"mixerChannels">[];
}

export async function deleteMixerStateForTrack(ctx: any, trackId: Id<"tracks">) {
  const rows = await listMixerChannelsForTrack(ctx, trackId);
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
}

export async function removeTrackRoutingReferences(
  ctx: any,
  roomId: string,
  trackId: Id<"tracks">,
) {
  const roomChannels = await ctx.db
    .query("mixerChannels")
    .withIndex("by_room", (q: any) => q.eq("roomId", roomId))
    .collect();

  for (const roomChannel of roomChannels as Doc<"mixerChannels">[]) {
    if (String(roomChannel.trackId) === String(trackId)) continue;

    const patch = removeRoutingReferencesFromFields(roomChannel, trackId);
    if (!patch) continue;
    await ctx.db.patch(roomChannel._id, patch);
  }
}

export async function ensureMixerChannelForTrack(ctx: any, track: Doc<"tracks">) {
  const rows = await listMixerChannelsForTrack(ctx, track._id);
  if (rows.length !== 1) {
    throw new Error(`Expected exactly one mixer channel for track ${String(track._id)}.`);
  }
  return rows[0];
}

export async function listRoomTracksWithMixerChannels(ctx: any, roomId: string): Promise<MergedTrackDoc[]> {
  const [tracksRaw, channelsRaw] = await Promise.all([
    ctx.db.query("tracks").withIndex("by_room", (q: any) => q.eq("roomId", roomId)).collect(),
    ctx.db.query("mixerChannels").withIndex("by_room", (q: any) => q.eq("roomId", roomId)).collect(),
  ]);
  const tracks = tracksRaw as Doc<"tracks">[];
  const channels = channelsRaw as Doc<"mixerChannels">[];
  const channelByTrackId = new Map<string, Doc<"mixerChannels">>();
  for (const channel of channels) {
    const trackId = String(channel.trackId);
    if (channelByTrackId.has(trackId)) {
      throw new Error(`Expected exactly one mixer channel for track ${trackId}.`);
    }
    channelByTrackId.set(trackId, channel);
  }
  const now = Date.now();
  return tracks
    .map((track) => {
      const channel = channelByTrackId.get(String(track._id));
      if (!channel) {
        throw new Error(`Missing mixer channel for track ${String(track._id)}.`);
      }
      return mergeTrackWithMixerState(track, channel, now);
    })
    .sort((a: MergedTrackDoc, b: MergedTrackDoc) => (a.index ?? 0) - (b.index ?? 0));
}

export async function getMergedTrack(ctx: any, trackId: Id<"tracks">): Promise<MergedTrackDoc | null> {
  const track = await ctx.db.get(trackId);
  if (!track) return null;
  const channel = await ensureMixerChannelForTrack(ctx, track);
  return mergeTrackWithMixerState(track, channel);
}
