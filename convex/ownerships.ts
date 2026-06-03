import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { canWriteProject, getProjectRole, requireAuthenticatedUserId } from "./projectAccess";

const listOwnedIds = async <TableName extends "tracks" | "clips">(
  ctx: QueryCtx,
  projectId: string,
  ownerUserId: string,
  selectId: (row: Doc<"ownerships">) => Id<TableName> | undefined,
): Promise<Array<Id<TableName>>> => {
  const rows = await ctx.db
    .query("ownerships")
    .withIndex("by_room_owner", (q) => q.eq("projectId", projectId).eq("ownerUserId", ownerUserId))
    .collect();
  return rows.flatMap((row) => {
    const id = selectId(row);
    return id ? [id] : [];
  });
};

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
    return await listOwnedIds(ctx, projectId, ownerUserId, (row) => row.trackId);
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
    return await listOwnedIds(ctx, projectId, ownerUserId, (row) => row.clipId);
  },
});
