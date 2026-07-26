import type { DatabaseReader } from "./_generated/server";
import { controlLimitsV1 } from "@daw-browser/control";
import { projectControlSnapshotV1, projectControlSnapshotV2 } from "./controlProjection";
import { listProjectTracksWithMixerChannels } from "./mixerChannels";
import { getProjectMixerSettings } from "./projectMixerSettings";
import { requireProjectRow } from "./projectRows";

type SnapshotContext = { db: DatabaseReader };

const readProjectControlSnapshot = async (
  ctx: SnapshotContext,
  projectId: string,
  projectSnapshot: typeof projectControlSnapshotV1 | typeof projectControlSnapshotV2,
) => {
  const [project, tracks, mixerSettings, clips, automationEnvelopes, effects, sidechainRoutes, assets, assetFolders] = await Promise.all([
    requireProjectRow(ctx, projectId),
    listProjectTracksWithMixerChannels(ctx, projectId),
    getProjectMixerSettings(ctx, projectId),
    ctx.db.query("clips").withIndex("by_room", (query) => query.eq("projectId", projectId)).collect(),
    ctx.db.query("automationEnvelopes").withIndex("by_project", (query) => query.eq("projectId", projectId)).collect(),
    ctx.db.query("effects").withIndex("by_room", (query) => query.eq("projectId", projectId)).collect(),
    ctx.db.query("sidechainRoutes").withIndex("by_room", (query) => query.eq("projectId", projectId)).collect(),
    ctx.db.query("samples").withIndex("by_room", (query) => query.eq("projectId", projectId))
      .take(controlLimitsV1.maxAssetsPerSnapshot + 1),
    ctx.db.query("assetFolders").withIndex("by_project", (query) => query.eq("projectId", projectId))
      .take(controlLimitsV1.maxAssetFoldersPerSnapshot + 1),
  ]);
  if (assets.length > controlLimitsV1.maxAssetsPerSnapshot || assetFolders.length > controlLimitsV1.maxAssetFoldersPerSnapshot) {
    throw new Error("Project asset snapshot limit exceeded.");
  }
  return projectSnapshot({
    project,
    tracks,
    clips,
    masterVolume: mixerSettings.masterVolume,
    automationEnvelopes,
    effects,
    sidechainRoutes,
    assets,
    assetFolders,
  });
}

export async function readProjectControlSnapshotV1(ctx: SnapshotContext, projectId: string) {
  return readProjectControlSnapshot(ctx, projectId, projectControlSnapshotV1);
}

export async function readProjectControlSnapshotV2(ctx: SnapshotContext, projectId: string) {
  return readProjectControlSnapshot(ctx, projectId, projectControlSnapshotV2);
}
