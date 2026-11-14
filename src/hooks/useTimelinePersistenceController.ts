import { createEffect, onCleanup, type Accessor } from "solid-js";
import type { AudioEngine } from "@daw-browser/audio-engine/audio-engine";
import type { ClipBufferWriter, EnsureClipBuffer } from "~/lib/clip-buffer-cache";
import { isLocalId } from "@daw-browser/shared";
import type { LocalProjectMode } from "~/lib/local-project-db";
import { flushSharedOutbox, readSharedOutboxRetryState, sharedOutboxRetryDelayMs } from "~/lib/shared-outbox";
import { subscribeToLocalProjectChanges } from "~/lib/local-project-changes";
import { createTimelineClipWriteAdapter } from "~/lib/timeline-clip-write-adapter";
import type { Clip, Track } from "@daw-browser/timeline-core/types";
import { useCloudSyncTick } from "./useCloudSyncTick";
import type { useLocalProjectActions } from "./useLocalProjectActions";
import { useMissingMediaRecovery } from "./useLocalTimelineMediaRecovery";
import type { TimelineSnapshot } from "~/lib/timeline-repository/types";

type LocalProjectActions = ReturnType<typeof useLocalProjectActions>;

type ProjectionActions = {
  reconcileLocalSnapshot?: (snapshot: TimelineSnapshot) => void;
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
  mountedProjectGeneration: Accessor<number>;
  remoteTimelineAvailable: Accessor<boolean>;
  localProjectMode: Accessor<LocalProjectMode | undefined>;
  userId: Accessor<string | undefined>;
  renderTracks: Accessor<Track[]>;
  audioEngine: AudioEngine;
  audioBufferCache: ClipBufferWriter;
  preloadClipBuffer: EnsureClipBuffer;
  getClipBuffer: (clipId: string) => AudioBuffer | undefined;
  localProject: LocalProjectActions;
  projection: ProjectionActions;
  selection: SelectionActions;
  notify: (title: string, message: string) => void;
};

export const useTimelinePersistenceController = (input: Input) => {
  const mediaRecovery = useMissingMediaRecovery({
    projectId: input.projectId,
    mountedProjectGeneration: input.mountedProjectGeneration,
    remoteTimelineAvailable: input.remoteTimelineAvailable,
    localTimelineReloadVersion: input.localProject.localTimelineReloadVersion,
    userId: input.userId,
    renderTracks: input.renderTracks,
    audioEngine: input.audioEngine,
    audioBufferCache: input.audioBufferCache,
    preloadClipBuffer: input.preloadClipBuffer,
    getClipBuffer: input.getClipBuffer,
    removeClip: async ({ clipId }) => {
      const projectId = input.projectId();
      const deletion = await createTimelineClipWriteAdapter({
        projectId,
        userId: input.userId(),
      }).deleteClips([clipId]);
      return deletion.removedIds.has(clipId);
    },
    projection: input.projection,
    selection: input.selection,
    notify: input.notify,
    onLocalSaveFailed: input.localProject.setLocalSaveFailure,
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
    let active = true;
    let retryTimer: number | undefined;
    let flushPromise: Promise<void> | undefined;
    let flushRequested = false;
    let retryScheduleVersion = 0;
    let flushFailures = 0;
    let retryNotBefore = 0;
    const cancelRetry = () => {
      if (retryTimer === undefined) return;
      window.clearTimeout(retryTimer);
      retryTimer = undefined;
    };
    const scheduleRetry = async () => {
      const version = ++retryScheduleVersion;
      let retryState: Awaited<ReturnType<typeof readSharedOutboxRetryState>>;
      try {
        retryState = await readSharedOutboxRetryState(projectId, userId);
      } catch {
        retryState = { nextAttemptAt: retryNotBefore || undefined };
      }
      if (!active || version !== retryScheduleVersion) return;
      cancelRetry();
      if (retryState.nextAttemptAt === undefined && !retryNotBefore) return;
      // Persisted deadlines drive retries; storage/lock failures add bounded backoff.
      // Project cleanup cancels this one-shot timer, including failed metadata reads.
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        void flush();
      }, Math.max(0, Math.max(retryState.nextAttemptAt ?? 0, retryNotBefore) - Date.now()));
    };
    const flush = () => {
      if (flushPromise) {
        flushRequested = true;
        return flushPromise;
      }
      const operation = flushSharedOutbox(projectId, userId)
        .then(() => {
          flushFailures = 0;
          retryNotBefore = 0;
        }, () => {
          flushFailures += 1;
          retryNotBefore = Date.now() + sharedOutboxRetryDelayMs(flushFailures);
          flushRequested = false;
        })
        .then(scheduleRetry)
        .finally(() => {
          flushPromise = undefined;
          if (flushRequested && active && !retryNotBefore) {
            flushRequested = false;
            void flush();
          }
        });
      flushPromise = operation;
      return operation;
    };
    const refreshRetry = () => {
      retryScheduleVersion += 1;
      cancelRetry();
      void scheduleRetry();
    };
    const onOnline = () => { void flush(); };
    void flush();
    window.addEventListener("online", onOnline);
    const unsubscribe = subscribeToLocalProjectChanges(projectId, refreshRetry);
    onCleanup(() => {
      active = false;
      retryScheduleVersion += 1;
      cancelRetry();
      unsubscribe();
      window.removeEventListener("online", onOnline);
    });
  });

  return {
    mediaRecovery,
    reconcileMountedLocalTimeline: (guard: {
      projectId: string;
      mountedProjectGeneration: number;
      signal: AbortSignal;
    }) => mediaRecovery.reloadLocalTimeline(guard),
    ensureMountedLocalMedia: mediaRecovery.ensureMountedLocalMedia,
  };
};
