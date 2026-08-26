import { DEFAULT_MASTER_VOLUME, normalizeMasterVolume } from "@daw-browser/shared";
import { mutation, query, type DatabaseReader, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { requireAuthenticatedUserId, requireMasterBusWriteAccess, requireProjectAccess } from "./projectAccess";
import { advanceProjectRevision } from "./projectRows";

type ProjectMixerSettingsReadCtx = { db: DatabaseReader };

export type ProjectMixerSettings = {
  masterVolume: number;
};

type ProjectMasterVolumeRowResult =
  | { changed: false; value: ProjectMixerSettings & { status: "noop" } }
  | { changed: true; value: ProjectMixerSettings & { status: "applied" } };

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

export async function setProjectMasterVolumeRow(
  ctx: MutationCtx,
  projectId: string,
  volume: number,
): Promise<ProjectMasterVolumeRowResult> {
  const masterVolume = effectiveProjectMasterVolume(volume);
  const state = { masterVolume };
  const row = await ctx.db
    .query("projectMixerSettings")
    .withIndex("by_room", (q) => q.eq("projectId", projectId))
    .first();
  if (row) {
    if (effectiveProjectMasterVolume(row.masterVolume) === masterVolume) {
      return { changed: false, value: { ...state, status: "noop" } };
    }
    await ctx.db.patch(row._id, { masterVolume, updatedAt: Date.now() });
    return { changed: true, value: { ...state, status: "applied" } };
  }
  if (masterVolume === effectiveProjectMasterVolume(undefined)) {
    return { changed: false, value: { ...state, status: "noop" } };
  }
  await ctx.db.insert("projectMixerSettings", {
    projectId,
    masterVolume,
    updatedAt: Date.now(),
  });
  return { changed: true, value: { ...state, status: "applied" } };
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
    await requireMasterBusWriteAccess(ctx, projectId, userId);
    const result = await setProjectMasterVolumeRow(ctx, projectId, volume);
    if (result.changed) await advanceProjectRevision(ctx, projectId);
    return { status: result.value.status };
  },
});
