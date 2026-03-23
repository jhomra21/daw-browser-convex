import { query } from "./_generated/server";
import { v } from "convex/values";
import { listRoomTracksWithMixerChannels } from "./mixerChannels";

export const fullView = query({
  args: { roomId: v.string() },
  handler: async (ctx, { roomId }) => {
    const tracks = await listRoomTracksWithMixerChannels(ctx, roomId);
    const clips = await ctx.db
      .query("clips")
      .withIndex("by_room", q => q.eq("roomId", roomId))
      .collect();

    return { tracks, clips };
  }
});
