import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireAuthenticatedUserId, requireProjectAccess } from "./projectAccess";

export { deleteAsset as removeFromRoom, moveAssetToFolder as moveToFolder } from "./assets";

export const listByRoom = query({
  args: { projectId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { projectId, limit }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectAccess(ctx, projectId, userId);
    const rows = await ctx.db.query("samples").withIndex("by_room", (query) => query.eq("projectId", projectId))
      .take(Math.max(1, Math.min(limit ?? 1_000, 1_000)));
    return rows.map(({ r2Key: _r2Key, ...row }) => ({
      ...row,
      url: `/api/samples/${encodeURIComponent(projectId)}/${encodeURIComponent(row.assetKey)}`,
    }));
  },
});
