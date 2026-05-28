import type { Accessor } from "solid-js";
import type { AudioEngine } from "~/lib/audio-engine";
import { isLocalId } from "~/lib/local-ids";
import type { LocalProjectMode } from "~/lib/local-project-db";
import { createTimelineClipWriteAdapter } from "~/lib/timeline-clip-write-adapter";
import type { Clip, Track } from "~/types/timeline";
import { useCloudSyncTick } from "./useCloudSyncTick";
import { useLocalProjectActions } from "./useLocalProjectActions";
import { useMissingMediaRecovery } from "./useLocalTimelineMediaRecovery";

type LocalProjectActions = ReturnType<typeof useLocalProjectActions>;

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
  localProjectMode: Accessor<LocalProjectMode | undefined>;
  userId: Accessor<string | undefined>;
  renderTracks: Accessor<Track[]>;
  audioEngine: AudioEngine;
  audioBufferCache: Map<string, AudioBuffer>;
  clipMediaStatus: Map<string, Clip["mediaStatus"]>;
  localProject: LocalProjectActions;
  projection: ProjectionActions;
  selection: SelectionActions;
};

export const useTimelinePersistenceController = (input: Input) => {
  const mediaRecovery = useMissingMediaRecovery({
    projectId: input.projectId,
    userId: input.userId,
    renderTracks: input.renderTracks,
    audioEngine: input.audioEngine,
    audioBufferCache: input.audioBufferCache,
    clipMediaStatus: input.clipMediaStatus,
    removeClip: async ({ clipId }) => {
      const projectId = input.projectId();
      const removedIds = await createTimelineClipWriteAdapter({
        projectId,
        userId: input.userId(),
      }).deleteClips([clipId]);
      return removedIds.has(clipId);
    },
    projection: input.projection,
    selection: input.selection,
  });
  useCloudSyncTick({
    projectId: input.projectId,
    enabled: () => {
      const mode = input.localProjectMode();
      return Boolean(input.userId() && isLocalId("project", input.projectId()) && (mode === "backup" || mode === "shared"));
    },
    sync: () => input.localProject.backUpNow({ skipIfUnchanged: true }),
  });

  return { mediaRecovery };
};
