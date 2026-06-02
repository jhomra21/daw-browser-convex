import { query } from "./_generated/server";
import { v } from "convex/values";
import { canWriteProject, getProjectRole, requireAuthenticatedUserId } from "./projectAccess";

// Return IDs of tracks owned by the given user in a room
export const listOwnedTrackIds = query({
  args: { projectId: v.string() },
  returns: v.array(v.id("tracks")),
  handler: async (ctx, { projectId }) => {
    const ownerUserId = await requireAuthenticatedUserId(ctx);
    const role = await getProjectRole(ctx, projectId, ownerUserId);
    if (canWriteProject(role)) {
      const tracks = await ctx.db
        .query("tracks")
        .withIndex("by_room_index", (q) => q.eq("projectId", projectId))
        .collect();
      return tracks.map((track) => track._id);
    }
    const rows = await ctx.db
      .query("ownerships")
      .withIndex("by_room_owner", (q) => q.eq("projectId", projectId).eq("ownerUserId", ownerUserId))
      .collect();
    const ids = [];
    for (const row of rows) {
      if (row.trackId) ids.push(row.trackId);
    }
    return ids;
  },
});

export const listOwnedClipIds = query({
  args: { projectId: v.string() },
  returns: v.array(v.id("clips")),
  handler: async (ctx, { projectId }) => {
    const ownerUserId = await requireAuthenticatedUserId(ctx);
    const role = await getProjectRole(ctx, projectId, ownerUserId);
    if (canWriteProject(role)) {
      const clips = await ctx.db
        .query("clips")
        .withIndex("by_room", (q) => q.eq("projectId", projectId))
        .collect();
      return clips.map((clip) => clip._id);
    }
    const rows = await ctx.db
      .query("ownerships")
      .withIndex("by_room_owner", (q) => q.eq("projectId", projectId).eq("ownerUserId", ownerUserId))
      .collect();
    const ids = [];
    for (const row of rows) {
      if (row.clipId) ids.push(row.clipId);
    }
    return ids;
  },
});
