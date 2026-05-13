import type { Doc, Id } from "./_generated/dataModel";

type TrackWriteAccess = {
  owner: Doc<"ownerships">;
  track: Doc<"tracks">;
};

async function readTrackWriteAccess(ctx: any, trackId: Id<"tracks">) {
  const track = await ctx.db.get(trackId);
  if (!track) {
    return {
      owner: null,
      track: null,
    };
  }

  const owners = await ctx.db
    .query("ownerships")
    .withIndex("by_track", (q: any) => q.eq("trackId", trackId))
    .collect();

  return {
    owner: (owners[0] as Doc<"ownerships"> | undefined) ?? null,
    track: track as Doc<"tracks">,
  };
}

export async function getTrackWriteAccess(
  ctx: any,
  trackId: Id<"tracks">,
  userId: string,
): Promise<TrackWriteAccess | null> {
  const access = await readTrackWriteAccess(ctx, trackId);
  if (!access.track || !access.owner || access.owner.ownerUserId !== userId) return null;

  return {
    owner: access.owner,
    track: access.track,
  };
}

export async function requireTrackOwnerForWrite(
  ctx: any,
  trackId: Id<"tracks">,
  userId: string,
): Promise<TrackWriteAccess> {
  const access = await readTrackWriteAccess(ctx, trackId);
  if (!access.track) {
    throw new Error("Track not found.");
  }
  if (!access.owner || access.owner.ownerUserId !== userId) {
    throw new Error("Only the track owner can update this track.");
  }

  return {
    owner: access.owner,
    track: access.track,
  };
}
