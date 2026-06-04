import type { Accessor } from "solid-js";
import { createEffect, onCleanup } from "solid-js";
import type { AudioEngine } from "~/lib/audio-engine";
import type { ClipBufferWriter } from "~/lib/clip-buffer-cache";
import { isLocalId } from "~/lib/local-ids";
import type { LocalProjectMode } from "~/lib/local-project-db";
import { flushSharedOutbox } from "~/lib/shared-outbox";
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
  remoteTimelineAvailable: Accessor<boolean>;
  localProjectMode: Accessor<LocalProjectMode | undefined>;
  userId: Accessor<string | undefined>;
  renderTracks: Accessor<Track[]>;
  audioEngine: AudioEngine;
  audioBufferCache: ClipBufferWriter;
  localProject: LocalProjectActions;
  projection: ProjectionActions;
  selection: SelectionActions;
};

export const useTimelinePersistenceController = (input: Input) => {
  const mediaRecovery = useMissingMediaRecovery({
    projectId: input.projectId,
    remoteTimelineAvailable: input.remoteTimelineAvailable,
    localTimelineReloadVersion: input.localProject.localTimelineReloadVersion,
    userId: input.userId,
    renderTracks: input.renderTracks,
    audioEngine: input.audioEngine,
    audioBufferCache: input.audioBufferCache,
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
      return Boolean(input.userId() && isLocalId("project", input.projectId()) && mode === "backup");
    },
    sync: (projectId) => input.localProject.backUpNow({ projectId, skipIfUnchanged: true }),
  });
  createEffect(() => {
    const projectId = input.projectId();
    const userId = input.userId();
    if (!projectId || isLocalId("project", projectId) || !userId) return;
    const flush = () => {
      void flushSharedOutbox(projectId, userId).catch(() => undefined);
    };
    flush();
    window.addEventListener("online", flush);
    onCleanup(() => window.removeEventListener("online", flush));
  });

  return { mediaRecovery };
};
