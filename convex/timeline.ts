import { query } from "./_generated/server";
import { v } from "convex/values";
import { listRoomTracksWithMixerChannels } from "./mixerChannels";
import { requireRoomAccess } from "./roomAccess";

export const fullView = query({
  args: { roomId: v.string(), userId: v.string() },
  handler: async (ctx, { roomId, userId }) => {
    await requireRoomAccess(ctx, roomId, userId);

    const tracks = await listRoomTracksWithMixerChannels(ctx, roomId);
    const clips = await ctx.db
      .query("clips")
      .withIndex("by_room", q => q.eq("roomId", roomId))
      .collect();

    return { tracks, clips };
  }
});
