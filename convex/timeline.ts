import { query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { listProjectTracksWithMixerChannels } from "./mixerChannels";
import { requireAuthenticatedUserId, requireProjectAccess } from "./projectAccess";

const readFullTimelineView = async (
  ctx: QueryCtx,
  projectId: string,
) => {
  const userId = await requireAuthenticatedUserId(ctx);
  await requireProjectAccess(ctx, projectId, userId);

  const [tracks, clips] = await Promise.all([
    listProjectTracksWithMixerChannels(ctx, projectId),
    ctx.db
      .query("clips")
      .withIndex("by_room", q => q.eq("projectId", projectId))
      .collect(),
  ]);

  return { tracks, clips };
};

export const fullView = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => await readFullTimelineView(ctx, projectId),
});

export const fullViewAuthed = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => await readFullTimelineView(ctx, projectId),
});
