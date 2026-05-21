import { query } from "./_generated/server";
import { v } from "convex/values";

// Return IDs of tracks owned by the given user in a room
export const listOwnedTrackIds = query({
  args: { projectId: v.string(), ownerUserId: v.string() },
  returns: v.array(v.id("tracks")),
  handler: async (ctx, { projectId, ownerUserId }) => {
    const rows = await ctx.db
      .query("ownerships")
      .withIndex("by_room_owner", (q) => q.eq("projectId", projectId).eq("ownerUserId", ownerUserId))
      .collect();
    const ids = rows
      .filter((r) => r.trackId)
      .map((r) => r.trackId!)
    return ids as any;
  },
});

export const listOwnedClipIds = query({
  args: { projectId: v.string(), ownerUserId: v.string() },
  returns: v.array(v.id("clips")),
  handler: async (ctx, { projectId, ownerUserId }) => {
    const rows = await ctx.db
      .query("ownerships")
      .withIndex("by_room_owner", (q) => q.eq("projectId", projectId).eq("ownerUserId", ownerUserId))
      .collect();
    const ids = rows
      .filter((r) => r.clipId)
      .map((r) => r.clipId!)
    return ids as any;
  },
});
