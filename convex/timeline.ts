import { query } from "./_generated/server";
import { v } from "convex/values";
import { listProjectTracksWithMixerChannels } from "./mixerChannels";
import { requireProjectAccess } from "./projectAccess";

export const fullView = query({
  args: { projectId: v.string(), userId: v.string() },
  handler: async (ctx, { projectId, userId }) => {
    await requireProjectAccess(ctx, projectId, userId);

    const tracks = await listProjectTracksWithMixerChannels(ctx, projectId);
    const clips = await ctx.db
      .query("clips")
      .withIndex("by_room", q => q.eq("projectId", projectId))
      .collect();

    return { tracks, clips };
  }
});
