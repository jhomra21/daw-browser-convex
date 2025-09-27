import { query } from "./_generated/server";
import { v } from "convex/values";

// Returns all shared state for a room (tracks + clips)
export const fullView = query({
  args: { roomId: v.string() },
  handler: async (ctx, { roomId }) => {
    const tracks = await ctx.db
      .query("tracks")
      .withIndex("by_room", q => q.eq("roomId", roomId))
      .collect();

    // Sort client-side by index to simplify index requirements
    const now = Date.now();
    const STALE_LOCK_MS = 60_000;
    const sanitizedTracks = tracks.map(track => {
      if (track.lockedBy && typeof track.lockedAt === 'number' && now - track.lockedAt > STALE_LOCK_MS) {
        return { ...track, lockedBy: undefined, lockedAt: undefined };
      }
      return track;
    });

    sanitizedTracks.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

    const clips = await ctx.db
      .query("clips")
      .withIndex("by_room", q => q.eq("roomId", roomId))
      .collect();

    return { tracks: sanitizedTracks, clips };
  }
});
