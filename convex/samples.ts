import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const listByRoom = query({
  args: { roomId: v.string() },
  handler: async (ctx, { roomId }) => {
    return await ctx.db
      .query("samples")
      .withIndex("by_room", q => q.eq("roomId", roomId))
      .collect();
  },
});

export const ensureInRoom = mutation({
  args: {
    roomId: v.string(),
    url: v.string(),
    userId: v.string(),
    name: v.optional(v.string()),
    duration: v.optional(v.number()),
  },
  handler: async (ctx, { roomId, url, userId, name, duration }) => {
    const existingRows = await ctx.db
      .query("samples")
      .withIndex("by_room_url", q => q.eq("roomId", roomId).eq("url", url))
      .collect();

    const row = existingRows[0];
    if (row) {
      const patch: Partial<typeof row> = {};
      if (!row.name && name) {
        patch.name = name;
      }
      if (row.duration === undefined && duration !== undefined) {
        patch.duration = duration;
      }
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(row._id, patch);
      }
      return row._id;
    }

    return await ctx.db.insert("samples", {
      roomId,
      url,
      name,
      duration,
      ownerUserId: userId,
      createdAt: Date.now(),
    });
  },
});

export const removeFromRoom = mutation({
  args: {
    roomId: v.string(),
    url: v.string(),
    userId: v.string(),
  },
  handler: async (ctx, { roomId, url, userId }) => {
    const rows = await ctx.db
      .query("samples")
      .withIndex("by_room_url", q => q.eq("roomId", roomId).eq("url", url))
      .collect();
    const row = rows[0];
    if (!row) return;
    if (row.ownerUserId !== userId) return;

    const clips = await ctx.db
      .query("clips")
      .withIndex("by_room", q => q.eq("roomId", roomId))
      .collect();
    const inUse = clips.some(clip => clip.sampleUrl === url);
    if (inUse) return;

    await ctx.db.delete(row._id);
  },
});
