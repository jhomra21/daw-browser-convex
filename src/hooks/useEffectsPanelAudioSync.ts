import { createEffect, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js";
import type { FunctionReturnType } from "convex/server";
import {
  type ArpeggiatorParams,
  type TrackInstrumentParams,
  type JsonValue,
  isLocalId,
} from "@daw-browser/shared";
import type { AudioEngine, EngineDisposition, SpectrumFrame } from "@daw-browser/audio-engine/audio-engine";
import type { convexApi } from "~/lib/convex";
import type { LocalEffectRow } from "~/lib/local-effects";
import type { LocalEffectsViewSource } from "~/components/timeline/create-local-effects-view";
import type { ExternalSidechainRoute, Track } from "@daw-browser/timeline-core/types";
import { indexInstrumentEffectRows } from "~/lib/effect-row-index";
import type { createDrumRackBufferSync } from "~/lib/drum-rack-buffer-sync";
import type { createSamplerBufferSync } from "~/lib/sampler-buffer-sync";

type UseEffectsPanelAudioSyncOptions = {
  isOpen: Accessor<boolean>;
  projectId: Accessor<string | undefined>;
  currentTargetId: Accessor<string>;
  tracks: Accessor<Track[]>;
  sidechainRoutes: Accessor<ExternalSidechainRoute[]>;
  audioEngine: Accessor<AudioEngine>;
  usesLegacyAudioEngine?: Accessor<boolean>;
  roomEffects: Accessor<RoomEffectRow[] | undefined>;
  roomEffectsStatus: Accessor<"pending" | "error" | "success">;
  roomEffectsError: Accessor<unknown>;
  localEffectsView: LocalEffectsViewSource;
  pendingWorkOwner?: ReturnType<typeof createPendingWorkOwner>;
  syncInstrumentForTarget?: (targetId: string, params: TrackInstrumentParams | undefined, through?: number) => void;
  syncArpeggiatorForTarget?: (targetId: string, params: ArpeggiatorParams | undefined, through?: number) => void;
  samplerBufferSync: ReturnType<typeof createSamplerBufferSync>;
  drumRackBufferSync: ReturnType<typeof createDrumRackBufferSync>;
  spectrumProvider?: Accessor<((targetId: string, listener: (frame: SpectrumFrame | null) => void) => () => void) | undefined>;
};

type RoomEffectRow = FunctionReturnType<typeof convexApi.effects.listByRoom>[number];
type SyncedEffectRow = RoomEffectRow | LocalEffectRow<JsonValue>;

type UseEffectsPanelAudioSyncReturn = {
  spectrum: Accessor<SpectrumFrame | null>;
  flushPending: () => Promise<void>;
};

type SpectrumProvider = (
  targetId: string,
  listener: (frame: SpectrumFrame | null) => void,
) => () => void;

export const createSpectrumSubscriptionOwner = (
  setFrame: (frame: SpectrumFrame | null) => void,
) => {
  let unsubscribe: () => void = () => undefined;
  let generation = 0;
  let disposed = false;
  let activeOpen = false;
  let activeProvider: SpectrumProvider | undefined;
  let activeTargetId = "";

  const update = (
    isOpen: boolean,
    provider: SpectrumProvider | undefined,
    targetId: string,
  ) => {
    if (disposed) return;
    if (isOpen === activeOpen && provider === activeProvider && targetId === activeTargetId) return;
    generation += 1;
    unsubscribe();
    unsubscribe = () => undefined;
    activeOpen = isOpen;
    activeProvider = provider;
    activeTargetId = targetId;
    if (!isOpen || !provider) {
      setFrame(null);
      return;
    }
    const subscriptionGeneration = generation;
    unsubscribe = provider(targetId, (frame) => {
      if (!disposed && subscriptionGeneration === generation) setFrame(frame);
    });
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    generation += 1;
    unsubscribe();
    unsubscribe = () => undefined;
  };

  return { update, dispose };
};

type PendingWork = Promise<void | EngineDisposition>;

type EffectsPanelReadinessOptions = {
  currentProjectId: Accessor<string | undefined>;
  // Readiness of a local project's rows belongs to the local effects view.
  localReady: LocalEffectsViewSource["ready"];
};

const toError = (cause: unknown) => cause instanceof Error ? cause : new Error(String(cause));
const errorMessage = (error: Error | undefined) => error?.message ?? "Unknown effects readiness failure.";

// Readiness of a cloud project's rows; a local project's is delegated to the local effects view.
export const createEffectsPanelReadinessOwner = (options: EffectsPanelReadinessOptions) => {
  type ProjectState = {
    rowsProcessed: boolean;
    remoteStatus: "pending" | "error" | "success";
    remoteDataDefined: boolean;
    remoteError?: Error;
  };

  const states = new Map<string, ProjectState>();
  const waiters = new Set<() => void>();
  let disposed = false;

  const stateFor = (projectId: string) => {
    const existing = states.get(projectId);
    if (existing) return existing;
    const state: ProjectState = {
      rowsProcessed: false,
      remoteStatus: "pending",
      remoteDataDefined: false,
    };
    states.set(projectId, state);
    return state;
  };

  const notify = () => {
    for (const waiter of waiters) waiter();
    waiters.clear();
  };

  const waitForChange = () => new Promise<void>((resolve) => {
    waiters.add(resolve);
  });

  const updateRemote = (
    projectId: string,
    rows: SyncedEffectRow[] | undefined,
    status: "pending" | "error" | "success",
    cause: unknown,
  ) => {
    const state = stateFor(projectId);
    state.remoteStatus = status;
    state.remoteDataDefined = rows !== undefined;
    state.remoteError = toError(cause);
    if (status !== "success" || rows === undefined) state.rowsProcessed = false;
    notify();
  };

  const markRowsProcessed = (projectId: string) => {
    const state = stateFor(projectId);
    if (state.remoteStatus !== "success" || !state.remoteDataDefined) return;
    state.rowsProcessed = true;
    notify();
  };

  const flushPending = async (projectId: string | undefined) => {
    if (disposed || !projectId) return;
    const assertCurrentProject = () => {
      if (options.currentProjectId() !== projectId) {
        throw new Error(`Project changed while waiting for effects readiness for project "${projectId}".`);
      }
    };
    const state = stateFor(projectId);
    while (!disposed) {
      assertCurrentProject();
      if (isLocalId("project", projectId)) {
        const localReady = options.localReady().catch((cause: unknown) => {
          throw new Error(`Failed to load local effects for project "${projectId}": ${errorMessage(toError(cause))}`);
        });
        // A change can win the race; the read this pass waited on may still fail afterwards.
        localReady.catch(() => undefined);
        const ready = await Promise.race([localReady, waitForChange().then(() => false)]);
        assertCurrentProject();
        if (ready) return;
        continue;
      }
      if (state.remoteStatus === "error") {
        throw new Error(`Failed to load remote effects for project "${projectId}": ${errorMessage(state.remoteError)}`);
      }
      if (
        state.remoteStatus !== "success"
        || !state.remoteDataDefined
        || !state.rowsProcessed
      ) {
        await waitForChange();
        assertCurrentProject();
        continue;
      }
      return;
    }
  };

  const dispose = () => {
    disposed = true;
    states.clear();
    notify();
  };

  return {
    dispose,
    flushPending,
    markRowsProcessed,
    projectChanged: notify,
    updateRemote,
  };
};

export const createPendingWorkOwner = () => {
  const pendingByProject = new Map<string, Set<PendingWork>>();
  let disposed = false;

  const track = (projectId: string | undefined, work: PendingWork | void) => {
    if (disposed || !projectId || !work) return;
    const pending = Promise.resolve(work).catch(() => undefined);
    const projectPending = pendingByProject.get(projectId) ?? new Set<PendingWork>();
    projectPending.add(pending);
    pendingByProject.set(projectId, projectPending);
    void pending.then(() => {
      projectPending.delete(pending);
      if (projectPending.size === 0 && pendingByProject.get(projectId) === projectPending) {
        pendingByProject.delete(projectId);
      }
    });
  };

  const flushPending = async (projectId: string | undefined) => {
    if (disposed || !projectId) return;
    while (true) {
      const projectPending = pendingByProject.get(projectId);
      if (!projectPending || projectPending.size === 0) return;
      await Promise.all(projectPending);
    }
  };

  const dispose = () => {
    disposed = true;
    pendingByProject.clear();
  };

  return { dispose, flushPending, track };
};

export function useEffectsPanelAudioSync(
  options: UseEffectsPanelAudioSyncOptions,
): UseEffectsPanelAudioSyncReturn {
  const localEffectsView = options.localEffectsView;
  const readinessOwner = createEffectsPanelReadinessOwner({
    currentProjectId: options.projectId,
    localReady: localEffectsView.ready,
  });
  onCleanup(readinessOwner.dispose);

  createEffect(on(options.projectId, () => readinessOwner.projectChanged()));

  createEffect(() => {
    const projectId = options.projectId();
    if (!projectId || isLocalId("project", projectId)) return;
    readinessOwner.updateRemote(
      projectId,
      options.roomEffects(),
      options.roomEffectsStatus(),
      options.roomEffectsError(),
    );
  });

  let syncedTrackIds = new Set<Track["id"]>();
  let syncedProjectId: string | null = null;
  const drumRackBufferSync = options.drumRackBufferSync;
  const samplerBufferSync = options.samplerBufferSync;
  const pendingWorkOwner = options.pendingWorkOwner ?? createPendingWorkOwner();
  onCleanup(pendingWorkOwner.dispose);

  const clearSyncedTrackState = (audioEngine: AudioEngine, trackIds: Iterable<Track["id"]>) => {
    for (const trackId of trackIds) {
      void audioEngine.setTrackFxInstances(trackId, [])
        .catch(() => undefined);
      audioEngine.clearTrackInstrument(trackId);
      audioEngine.clearTrackArpeggiator(trackId);
      drumRackBufferSync.clearTrack(trackId);
      samplerBufferSync.clearTrack(trackId);
    }
  };

  const clearSyncedMasterState = (audioEngine: AudioEngine) => {
    void audioEngine.setMasterFxInstances([]).catch(() => undefined);
  };

  createEffect(() => {
    const audioEngine = options.audioEngine();
    if (options.usesLegacyAudioEngine && !options.usesLegacyAudioEngine()) return;
    const projectId = options.projectId();
    if (projectId) return;
    clearSyncedTrackState(audioEngine, syncedTrackIds);
    clearSyncedMasterState(audioEngine);
    syncedTrackIds = new Set();
    syncedProjectId = null;
  });

  createEffect(function reconcileEffectsRows() {
    const audioEngine = options.audioEngine();
    const usesLegacyAudioEngine = options.usesLegacyAudioEngine?.() ?? true;
    const projectId = options.projectId();
    const effects: SyncedEffectRow[] | undefined = projectId && isLocalId("project", projectId)
      ? localEffectsView.view()?.rows
      : options.roomEffects();

    const tracks = options.tracks();
    const currentTrackIds = new Set(tracks.map((track) => track.id));
    if (effects === undefined) {
      if (projectId && syncedProjectId !== projectId) {
        if (usesLegacyAudioEngine) {
          clearSyncedTrackState(audioEngine, new Set([...syncedTrackIds, ...currentTrackIds]));
          clearSyncedMasterState(audioEngine);
        } else {
          for (const trackId of new Set([...syncedTrackIds, ...currentTrackIds])) {
            drumRackBufferSync.clearTrack(trackId);
            samplerBufferSync.clearTrack(trackId);
          }
        }
        syncedTrackIds = new Set(currentTrackIds);
        syncedProjectId = projectId;
      }
      return;
    }

    if (!projectId) return;

    if (isLocalId("project", projectId)) {
      const { instruments, arpeggiators } = indexInstrumentEffectRows(effects);
      untrack(() => {
        const through = localEffectsView.view()?.through ?? 0;
        for (const track of tracks) {
          options.syncInstrumentForTarget?.(track.id, track.kind === "instrument" ? instruments.get(track.id)?.params : undefined, through);
          options.syncArpeggiatorForTarget?.(track.id, track.kind === "instrument" ? arpeggiators.get(track.id)?.params : undefined, through);
        }
      });
    }

    const staleTrackIds = new Set<Track["id"]>();
    for (const trackId of syncedTrackIds) {
      if (!currentTrackIds.has(trackId)) {
        staleTrackIds.add(trackId);
      }
    }
    for (const trackId of staleTrackIds) {
      if (isLocalId("project", projectId)) untrack(() => {
        options.syncInstrumentForTarget?.(trackId, undefined);
        options.syncArpeggiatorForTarget?.(trackId, undefined);
      });
      drumRackBufferSync.clearTrack(trackId);
      samplerBufferSync.clearTrack(trackId);
    }

    const acknowledgeRows = () => {
      if (isLocalId("project", projectId)) localEffectsView.acknowledge(localEffectsView.view()?.publicationId);
      else readinessOwner.markRowsProcessed(projectId);
    };

    if (!usesLegacyAudioEngine) {
      syncedTrackIds = new Set(currentTrackIds);
      syncedProjectId = projectId;
      acknowledgeRows();
      return;
    }

    clearSyncedTrackState(audioEngine, staleTrackIds);
    audioEngine.setExternalSidechainRoutes(options.sidechainRoutes());

    syncedTrackIds = new Set(currentTrackIds);
    syncedProjectId = projectId;
    acknowledgeRows();
  });

  const [spectrum, setSpectrum] = createSignal<SpectrumFrame | null>(null);

  const spectrumSubscription = createSpectrumSubscriptionOwner(setSpectrum);
  spectrumSubscription.update(options.isOpen(), options.spectrumProvider?.(), options.currentTargetId());
  createEffect(() => {
    spectrumSubscription.update(options.isOpen(), options.spectrumProvider?.(), options.currentTargetId());
  });
  onCleanup(spectrumSubscription.dispose);

  return {
    flushPending: async () => {
      const projectId = options.projectId();
      await readinessOwner.flushPending(projectId);
      await pendingWorkOwner.flushPending(projectId);
    },
    spectrum,
  };
}
