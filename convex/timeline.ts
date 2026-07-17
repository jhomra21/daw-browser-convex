import { query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { listProjectTracksWithMixerChannels } from "./mixerChannels";
import { getProjectMixerSettings } from "./projectMixerSettings";
import { requireAuthenticatedUserId, requireProjectAccess } from "./projectAccess";

const readFullTimelineView = async (
  ctx: QueryCtx,
  projectId: string,
) => {
  const userId = await requireAuthenticatedUserId(ctx);
  await requireProjectAccess(ctx, projectId, userId);

  const [tracks, mixerSettings, clips, automationEnvelopes, effects, sidechainRoutes] = await Promise.all([
    listProjectTracksWithMixerChannels(ctx, projectId),
    getProjectMixerSettings(ctx, projectId),
    ctx.db
      .query("clips")
      .withIndex("by_room", q => q.eq("projectId", projectId))
      .collect(),
    ctx.db
      .query("automationEnvelopes")
      .withIndex("by_project", q => q.eq("projectId", projectId))
      .collect(),
    ctx.db
      .query("effects")
      .withIndex("by_room", q => q.eq("projectId", projectId))
      .collect(),
    ctx.db
      .query("sidechainRoutes")
      .withIndex("by_room", q => q.eq("projectId", projectId))
      .collect(),
  ]);
  const project = await ctx.db
    .query("projects")
    .withIndex("by_room", q => q.eq("projectId", projectId))
    .unique();
  if (!project) throw new Error("Project not found.");

  return {
    project: {
      projectId: project.projectId,
      name: project.name,
      revision: project.revision,
      tempoBpm: project.tempoBpm,
      timeSignatureNumerator: project.timeSignatureNumerator,
      timeSignatureDenominator: project.timeSignatureDenominator,
      loopEnabled: project.loopEnabled,
      loopStartSec: project.loopStartSec,
      loopEndSec: project.loopEndSec,
      updatedAt: project.updatedAt,
    },
    tracks,
    clips,
    mixerSettings,
    automationEnvelopes,
    effects,
    sidechainRoutes,
  };
};

export const fullView = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => await readFullTimelineView(ctx, projectId),
});

export const fullViewAuthed = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => await readFullTimelineView(ctx, projectId),
});
