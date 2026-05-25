import type { Accessor } from "solid-js";
import type { AudioEngine } from "~/lib/audio-engine";
import { buildClipRemoveManyMutationInput } from "~/lib/clip-mutation-args";
import { convexApi, convexClient } from "~/lib/convex";
import { isLocalId } from "~/lib/local-ids";
import { createLocalTimelineRepository } from "~/lib/timeline-repository/local-timeline-repository";
import type { Clip, Track } from "~/types/timeline";
import { useCloudSyncTick } from "./useCloudSyncTick";
import { useLocalProjectActions } from "./useLocalProjectActions";
import { useMissingMediaRecovery } from "./useLocalTimelineMediaRecovery";

type ProjectionActions = {
  insertLocalClip: (trackId: Track["id"], clip: Clip) => void;
  removeLocalClips: (clipIds: Iterable<string>) => void;
};

type SelectionActions = {
  selectedClip: Accessor<{ clipId: string } | null>;
  setSelectedClip: (clip: null) => void;
  setSelectedClipIds: (updater: (current: Set<string>) => Set<string>) => void;
  selectTrackTarget: (
    trackId: Track["id"],
    options: { clearClipSelection: boolean; clearPrimaryClip: boolean },
  ) => void;
};

type Input = {
  projectId: Accessor<string>;
  userId: Accessor<string | undefined>;
  navigateToRoom: (projectId: string) => void;
  renderTracks: Accessor<Track[]>;
  audioEngine: AudioEngine;
  audioBufferCache: Map<string, AudioBuffer>;
  clipMediaStatus: Map<string, Clip["mediaStatus"]>;
  projection: ProjectionActions;
  selection: SelectionActions;
};

export const useTimelinePersistenceController = (input: Input) => {
  const localProject = useLocalProjectActions({
    projectId: input.projectId,
    navigateToRoom: input.navigateToRoom,
  });
  const mediaRecovery = useMissingMediaRecovery({
    projectId: input.projectId,
    userId: input.userId,
    renderTracks: input.renderTracks,
    audioEngine: input.audioEngine,
    audioBufferCache: input.audioBufferCache,
    clipMediaStatus: input.clipMediaStatus,
    removeClip: async ({ clipId }) => {
      const projectId = input.projectId();
      if (isLocalId("project", projectId)) {
        await createLocalTimelineRepository(projectId).deleteClip(clipId);
        return true;
      }
      const userId = input.userId();
      if (!userId) return false;
      const result = await convexClient.mutation(
        convexApi.clips.removeMany,
        buildClipRemoveManyMutationInput({ clipIds: [clipId], userId }),
      );
      return Array.isArray(result?.removedClipIds) && result.removedClipIds.length > 0;
    },
    projection: input.projection,
    selection: input.selection,
  });
  useCloudSyncTick({
    projectId: input.projectId,
    enabled: () => Boolean(input.userId() && isLocalId("project", input.projectId())),
    sync: () => localProject.backUpNow({ skipIfUnchanged: true }),
  });

  return { localProject, mediaRecovery };
};
