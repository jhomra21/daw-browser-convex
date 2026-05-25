import { isLocalId } from "~/lib/local-ids";
import type { OptimisticGrantScope } from "~/lib/optimistic-grant-scope";
import { createLocalTimelineRepository } from "~/lib/timeline-repository/local-timeline-repository";
import { toLocalTimelineTrack } from "~/lib/timeline-repository/track-row-adapter";
import { buildClipMoveMutationInput } from "~/lib/clip-mutation-args";
import { buildTrackDeleteMutationInput } from "~/lib/track-mutation-args";
import { createOptimisticTrack } from "~/lib/tracks";
import type { Track } from "~/types/timeline";

type ClipMove = { clipId: string; trackId: Track["id"]; startSec: number };
type ConvexClient = typeof import("~/lib/convex").convexClient;
type ConvexApi = typeof import("~/lib/convex").convexApi;

type Input = {
  projectId: () => string;
  userId: () => string;
  convexClient: ConvexClient;
  convexApi: ConvexApi;
  insertLocalTrack: (track: Track, index: number) => void;
  removeLocalTrack: (trackId: Track["id"]) => void;
  placementTrackCount: () => number;
  grantWrite?: (trackId: Track["id"], scope?: OptimisticGrantScope | null) => void;
};

export const createClipDragPersistence = (input: Input) => {
  const isLocalProject = () => isLocalId("project", input.projectId());

  const deleteEmptyTrack = async (trackId: Track["id"]) => {
    if (isLocalProject()) {
      await createLocalTimelineRepository(input.projectId()).deleteTrack(trackId);
      input.removeLocalTrack(trackId);
      return;
    }
    const userId = input.userId();
    if (!userId) return;
    const result = await input.convexClient.mutation(
      input.convexApi.tracks.remove,
      buildTrackDeleteMutationInput({ trackId, userId }),
    );
    if (result?.status === "deleted") input.removeLocalTrack(trackId);
  };

  const createTrackForDrag = async (kind: Track["kind"]) => {
    const index = input.placementTrackCount();
    if (isLocalProject()) {
      const row = await createLocalTimelineRepository(input.projectId()).createTrack({ index, kind });
      const track = toLocalTimelineTrack(row);
      input.insertLocalTrack(track, index);
      return track.id;
    }
    const track = await createOptimisticTrack({
      convexClient: input.convexClient,
      convexApi: input.convexApi,
      projectId: input.projectId(),
      userId: input.userId(),
      insertLocalTrack: input.insertLocalTrack,
      index,
      grantWrite: input.grantWrite,
      grantScope: { projectId: input.projectId(), userId: input.userId() },
      kind,
    });
    return track?.id ?? null;
  };

  const moveLocalClips = async (moves: ClipMove[]) => {
    await createLocalTimelineRepository(input.projectId()).moveClips(moves);
  };

  const moveCloudClip = async (move: ClipMove) => {
    const result = await input.convexClient.mutation(
      input.convexApi.clips.move,
      buildClipMoveMutationInput({
        clipId: move.clipId,
        userId: input.userId(),
        startSec: move.startSec,
        toTrackId: move.trackId,
      }),
    );
    return result?.status === "applied";
  };

  return {
    isLocalProject,
    deleteEmptyTrack,
    createTrackForDrag,
    moveLocalClips,
    moveCloudClip,
  };
};
