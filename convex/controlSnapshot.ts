import type { DatabaseReader } from "./_generated/server";
import { projectControlSnapshotV1 } from "./controlProjection";
import { listProjectTracksWithMixerChannels } from "./mixerChannels";
import { getProjectMixerSettings } from "./projectMixerSettings";
import { requireProjectRow } from "./projectRows";

type SnapshotContext = { db: DatabaseReader };

export async function readProjectControlSnapshotV1(ctx: SnapshotContext, projectId: string) {
  const [project, tracks, mixerSettings, clips, automationEnvelopes, effects, sidechainRoutes] = await Promise.all([
    requireProjectRow(ctx, projectId),
    listProjectTracksWithMixerChannels(ctx, projectId),
    getProjectMixerSettings(ctx, projectId),
    ctx.db.query("clips").withIndex("by_room", (query) => query.eq("projectId", projectId)).collect(),
    ctx.db.query("automationEnvelopes").withIndex("by_project", (query) => query.eq("projectId", projectId)).collect(),
    ctx.db.query("effects").withIndex("by_room", (query) => query.eq("projectId", projectId)).collect(),
    ctx.db.query("sidechainRoutes").withIndex("by_room", (query) => query.eq("projectId", projectId)).collect(),
  ]);
  return projectControlSnapshotV1({
    project,
    tracks,
    clips,
    masterVolume: mixerSettings.masterVolume,
    automationEnvelopes,
    effects,
    sidechainRoutes,
  });
}
