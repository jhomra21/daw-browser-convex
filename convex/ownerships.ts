import { query } from "./_generated/server";
import { v } from "convex/values";

// Return IDs of tracks owned by the given user in a room
export const listOwnedTrackIds = query({
  args: { roomId: v.string(), ownerUserId: v.string() },
  returns: v.array(v.id("tracks")),
  handler: async (ctx, { roomId, ownerUserId }) => {
    const rows = await ctx.db
      .query("ownerships")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", ownerUserId))
      .collect();
    // Filter to this room and to rows that refer to a track
    const ids = rows
      .filter((r) => r.roomId === roomId && r.trackId)
      .map((r) => r.trackId!)
    return ids as any;
  },
});
