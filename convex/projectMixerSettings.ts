import { DEFAULT_MASTER_VOLUME, normalizeMasterVolume } from "@daw-browser/shared";
import { mutation, query, type DatabaseReader, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { requireAuthenticatedUserId, requireMasterBusWriteAccess, requireProjectAccess } from "./projectAccess";
import { advanceProjectRevision } from "./projectRows";

type ProjectMixerSettingsReadCtx = { db: DatabaseReader };

export type ProjectMixerSettings = {
  masterVolume: number;
};

export const effectiveProjectMasterVolume = (value: number | undefined) => (
  value === undefined ? DEFAULT_MASTER_VOLUME : normalizeMasterVolume(value)
);

export async function getProjectMixerSettings(
  ctx: ProjectMixerSettingsReadCtx,
  projectId: string,
): Promise<ProjectMixerSettings> {
  const row = await ctx.db
    .query("projectMixerSettings")
    .withIndex("by_room", (q) => q.eq("projectId", projectId))
    .first();
  return {
    masterVolume: effectiveProjectMasterVolume(row?.masterVolume),
  };
}

export async function setProjectMasterVolumeForUser(
  ctx: MutationCtx,
  projectId: string,
  userId: string,
  volume: number,
) {
  await requireMasterBusWriteAccess(ctx, projectId, userId);
  const masterVolume = effectiveProjectMasterVolume(volume);
  const row = await ctx.db
    .query("projectMixerSettings")
    .withIndex("by_room", (q) => q.eq("projectId", projectId))
    .first();
  if (row) {
    if (effectiveProjectMasterVolume(row.masterVolume) === masterVolume) return { status: "noop" as const };
    await ctx.db.patch(row._id, { masterVolume, updatedAt: Date.now() });
    await advanceProjectRevision(ctx, projectId);
    return { status: "applied" as const };
  }
  if (masterVolume === effectiveProjectMasterVolume(undefined)) {
    return { status: "noop" as const };
  }
  await ctx.db.insert("projectMixerSettings", {
    projectId,
    masterVolume,
    updatedAt: Date.now(),
  });
  await advanceProjectRevision(ctx, projectId);
  return { status: "applied" as const };
}

export const get = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    await requireProjectAccess(ctx, projectId, userId);
    return await getProjectMixerSettings(ctx, projectId);
  },
});

export const setMasterVolume = mutation({
  args: { projectId: v.string(), volume: v.number() },
  handler: async (ctx, { projectId, volume }) => {
    const userId = await requireAuthenticatedUserId(ctx);
    return await setProjectMasterVolumeForUser(ctx, projectId, userId, volume);
  },
});
