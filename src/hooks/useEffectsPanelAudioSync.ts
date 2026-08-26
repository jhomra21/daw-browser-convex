import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js";
import type { FunctionReturnType } from "convex/server";
import {
  AUDIO_EFFECT_CONTRACTS,
  isAudioEffectKind,
  isJsonObject,
  type AudioEffectKind,
  type CompressorParams,
  type ArpeggiatorParams,
  type DelayParams,
  type EqParams,
  type ReverbParams,
  type SaturatorParams,
  type TrackInstrumentParams,
  type JsonObject,
  type JsonValue,
  isLocalId,
  arpeggiatorParamsSchema,
  normalizeArpeggiatorParams,
} from "@daw-browser/shared";
import type { AudioEffectRuntimeInstance, AudioEngine, SpectrumFrame } from "@daw-browser/audio-engine/audio-engine";
import type { convexApi } from "~/lib/convex";
import { audioEffectKindFromLocalEffect, listLocalEffects, type LocalEffectRow } from "~/lib/local-effects";
import { collectAudioEffectInstances } from "~/lib/audio-effect-order-rows";
import { subscribeToLocalProjectChanges } from "~/lib/local-project-changes";
import type { ExternalSidechainRoute, Track } from "@daw-browser/timeline-core/types";
import { readInstrumentParamsFromEffectRow } from "~/lib/effect-row-instrument-params";
import { createDrumRackBufferSync } from "~/lib/drum-rack-buffer-sync";
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
  localDraftEffects?: {
    eq?: (targetId: string) => EqParams | undefined;
    compressor?: (targetId: string) => CompressorParams | undefined;
    saturator?: (targetId: string) => SaturatorParams | undefined;
    delay?: (targetId: string) => DelayParams | undefined;
    reverb?: (targetId: string) => ReverbParams | undefined;
    instrument?: (targetId: string) => TrackInstrumentParams | undefined;
    arp?: (targetId: string) => ArpeggiatorParams | undefined;
  };
  samplerBufferSync: ReturnType<typeof createSamplerBufferSync>;
  drumRackBufferSync?: ReturnType<typeof createDrumRackBufferSync>;
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

type PendingWork = Promise<void>;

type EffectsPanelReadinessOptions = {
  loadLocalEffects: (projectId: string) => Promise<LocalEffectRow<JsonValue>[]>;
  currentProjectId: Accessor<string | undefined>;
  onLocalEffectsLoaded?: (projectId: string, rows: LocalEffectRow<JsonValue>[]) => void;
};

const toError = (cause: unknown) => cause instanceof Error ? cause : new Error(String(cause));
const errorMessage = (error: Error | undefined) => error?.message ?? "Unknown effects readiness failure.";

export const createEffectsPanelReadinessOwner = (options: EffectsPanelReadinessOptions) => {
  type ProjectState = {
    generation: number;
    localLoad?: Promise<void>;
    localError?: Error;
    localLoaded: boolean;
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
      generation: 0,
      localLoaded: false,
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

  const ensureLocalLoad = (projectId: string) => {
    const state = stateFor(projectId);
    if (state.localLoad) return;
    void startLocalLoad(projectId, () => options.loadLocalEffects(projectId), () => undefined);
  };

  const startLocalLoad = <T>(
    projectId: string,
    load: () => Promise<T>,
    onSuccess: (rows: T) => void,
    force = false,
  ) => {
    const state = stateFor(projectId);
    if (!force && state.localLoad) return state.localLoad;
    state.generation += 1;
    state.localLoaded = false;
    state.localError = undefined;
    state.rowsProcessed = false;
    const generation = state.generation;
    const loadPromise = load().then((rows) => {
      if (state.generation !== generation) return;
      state.localLoaded = true;
      onSuccess(rows);
      if (Array.isArray(rows) && options.currentProjectId() === projectId) {
        options.onLocalEffectsLoaded?.(projectId, rows);
      }
      notify();
    }).catch((cause: unknown) => {
      if (state.generation !== generation) return;
      state.localError = toError(cause);
      notify();
    });
    state.localLoad = loadPromise;
    return loadPromise;
  };

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
    if (isLocalId("project", projectId)) {
      if (!state.localLoaded || state.localError) return;
    } else if (state.remoteStatus !== "success" || !state.remoteDataDefined) {
      return;
    }
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
    if (isLocalId("project", projectId)) ensureLocalLoad(projectId);
    while (!disposed) {
      assertCurrentProject();
      const generation = state.generation;
      if (isLocalId("project", projectId)) {
        if (state.localLoad) await Promise.race([state.localLoad, waitForChange()]);
        assertCurrentProject();
        if (state.generation !== generation) continue;
        if (state.localError) {
          throw new Error(`Failed to load local effects for project "${projectId}": ${errorMessage(state.localError)}`);
        }
        if (!state.localLoaded || !state.rowsProcessed) {
          await waitForChange();
          assertCurrentProject();
          continue;
        }
      } else {
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
    startLocalLoad,
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

type SyncedAudioEffectInstanceRow = AudioEffectRuntimeInstance & {
  targetId: string;
  index?: number;
};

type SampledInstrumentWorkRegistrationOptions = {
  projectId: string;
  tracks: readonly Track[];
  instruments: ReadonlyMap<string, TrackInstrumentParams>;
  clearSamplerTrack: (trackId: Track["id"]) => void;
  clearDrumRackTrack: (trackId: Track["id"]) => void;
  syncSamplerTrack: (
    trackId: Track["id"],
    params: Extract<TrackInstrumentParams, { kind: "sampler" }>["params"],
    instanceId?: string,
  ) => PendingWork | void;
  syncGranularTrack: (
    trackId: Track["id"],
    params: Extract<TrackInstrumentParams, { kind: "granular" }>["params"],
    instanceId?: string,
  ) => PendingWork | void;
  syncDrumRackTrack: (
    trackId: Track["id"],
    params: Extract<TrackInstrumentParams, { kind: "drum-rack" }>["params"],
    instanceId?: string,
  ) => PendingWork | void;
  trackPendingWork: (projectId: string, work: PendingWork | void) => void;
};

export const registerSampledInstrumentWork = (
  options: SampledInstrumentWorkRegistrationOptions,
) => {
  for (const track of options.tracks) {
    if (track.kind !== "instrument") continue;
    const instrument = options.instruments.get(track.id);
    if (instrument?.kind === "drum-rack") {
      options.clearSamplerTrack(track.id);
      options.trackPendingWork(
        options.projectId,
        options.syncDrumRackTrack(track.id, instrument.params, instrument.instanceId),
      );
    } else if (instrument?.kind === "sampler") {
      options.clearDrumRackTrack(track.id);
      options.trackPendingWork(
        options.projectId,
        options.syncSamplerTrack(track.id, instrument.params, instrument.instanceId),
      );
    } else if (instrument?.kind === "granular") {
      options.clearDrumRackTrack(track.id);
      options.trackPendingWork(
        options.projectId,
        options.syncGranularTrack(track.id, instrument.params, instrument.instanceId),
      );
    } else {
      options.clearDrumRackTrack(track.id);
      options.clearSamplerTrack(track.id);
    }
  }
};

const createSyncedAudioEffectInstanceRow = (
  targetId: string,
  kind: AudioEffectKind,
  cause: SyncedEffectRow["params"],
  instanceId?: string,
  index?: number
): SyncedAudioEffectInstanceRow => {
  if (!instanceId) throw new Error(`Audio effect "${kind}" is missing an instance ID.`)
  const id = instanceId;
  const input: JsonObject = isJsonObject(cause) ? cause : {};
  if (kind === "utility") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.utility.normalizeParams(input), index };
  if (kind === "autofilter") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams(input), index };
  if (kind === "eq") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.eq.normalizeParams(input), index };
  if (kind === "gate") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.gate.normalizeParams(input), index };
  if (kind === "compressor") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.compressor.normalizeParams(input), index };
  if (kind === "saturator") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.saturator.normalizeParams(input), index };
  if (kind === "limiter") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.limiter.normalizeParams(input), index };
  if (kind === "lofi") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams(input), index };
  if (kind === "delay") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.delay.normalizeParams(input), index };
  if (kind === "reverb") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.reverb.normalizeParams(input), index };
  if (kind === "chorus") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams(input), index };
  if (kind === "flanger") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams(input), index };
  if (kind === "phaser") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams(input), index };
  if (kind === "tremolo") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams(input), index };
  if (kind === "autopan") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams(input), index };
  if (kind === "spectral") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.spectral.normalizeParams(input), index };
  return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams(input), index };
};

const collectSyncedAudioEffectInstances = (effects: SyncedEffectRow[]) => {
  const rows: SyncedAudioEffectInstanceRow[] = [];
  for (const row of effects) {
    let instance: SyncedAudioEffectInstanceRow | undefined;
    if ("effect" in row) {
      const kind = audioEffectKindFromLocalEffect(row.effect);
      if (kind) instance = createSyncedAudioEffectInstanceRow(row.targetId, kind, row.params, row.instanceId, row.index);
    } else if (isAudioEffectKind(row.type) && row.params) {
      const targetId = row.targetType === "master" ? "master" : row.trackId;
      if (targetId) instance = createSyncedAudioEffectInstanceRow(targetId, row.type, row.params, row.instanceId, row.index);
    }
    if (!instance) continue;
    rows.push(instance);
  }
  const instances = collectAudioEffectInstances(rows.map((row) => ({
    targetId: row.targetId,
    kind: row.kind,
    instanceId: row.id,
    index: row.index,
  })));
  const rowByKey = new Map(rows.map((row) => [`${row.targetId}:${row.id}`, row]));
  const toRuntimeInstances = (targetId: string, order: ReturnType<typeof collectAudioEffectInstances>["master"]): AudioEffectRuntimeInstance[] => {
    const runtimeInstances: AudioEffectRuntimeInstance[] = [];
    for (const instance of order) {
      const row = rowByKey.get(`${targetId}:${instance.id}`);
      if (!row) continue;
      if (row.kind === "utility") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "autofilter") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "eq") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "gate") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "compressor") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "saturator") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "limiter") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "lofi") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "delay") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "reverb") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "chorus") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "flanger") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "phaser") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "tremolo") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "autopan") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "spectral") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
    }
    return runtimeInstances;
  };
  return {
    master: toRuntimeInstances("master", instances.master),
    tracks: new Map([...instances.tracks].map(([trackId, order]) => [trackId, toRuntimeInstances(trackId, order)])),
  };
};

export function useEffectsPanelAudioSync(
  options: UseEffectsPanelAudioSyncOptions,
): UseEffectsPanelAudioSyncReturn {
  const [localEffects, setLocalEffects] = createSignal<LocalEffectRow<JsonValue>[] | undefined>(undefined);
  const readinessOwner = createEffectsPanelReadinessOwner({
    loadLocalEffects: listLocalEffects,
    currentProjectId: options.projectId,
    onLocalEffectsLoaded: (_projectId, rows) => setLocalEffects(rows),
  });
  onCleanup(readinessOwner.dispose);

  createEffect(on(options.projectId, (projectId) => {
    readinessOwner.projectChanged();
    if (!projectId || !isLocalId("project", projectId)) {
      setLocalEffects(undefined);
      return;
    }
    const isCurrentProject = () => options.projectId() === projectId;
    const reloadLocalEffects = (force = false) => readinessOwner.startLocalLoad(
      projectId,
      () => listLocalEffects(projectId).catch((cause: unknown) => {
        if (isCurrentProject()) setLocalEffects([]);
        throw cause;
      }),
      (rows) => {
        if (isCurrentProject()) setLocalEffects(rows);
      },
      force,
    );
    void reloadLocalEffects(true);
    const unsubscribe = subscribeToLocalProjectChanges(projectId, () => {
      void reloadLocalEffects(true);
    })
    onCleanup(unsubscribe)
  }));

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
  const drumRackBufferSync = options.drumRackBufferSync ?? createDrumRackBufferSync();
  const samplerBufferSync = options.samplerBufferSync;
  const pendingWorkOwner = createPendingWorkOwner();
  onCleanup(pendingWorkOwner.dispose);
  if (!options.drumRackBufferSync) onCleanup(drumRackBufferSync.dispose);

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

  createEffect(() => {
    const audioEngine = options.audioEngine();
    const usesLegacyAudioEngine = options.usesLegacyAudioEngine?.() ?? true;
    const projectId = options.projectId();
    const effects: SyncedEffectRow[] | undefined = projectId && isLocalId("project", projectId)
      ? localEffects()
      : options.roomEffects();

    const tracks = options.tracks();
    const currentTrackIds = new Set(tracks.map((track) => track.id));
    if (effects === undefined) {
      if (usesLegacyAudioEngine && projectId && syncedProjectId !== projectId) {
        clearSyncedTrackState(audioEngine, new Set([...syncedTrackIds, ...currentTrackIds]));
        clearSyncedMasterState(audioEngine);
        syncedTrackIds = new Set(currentTrackIds);
        syncedProjectId = projectId;
      }
      return;
    }

    if (!projectId) return;

    const instrumentByTrackId = new Map<string, TrackInstrumentParams>();
    const arpByTrackId = new Map<string, ArpeggiatorParams>();
    const effectInstances = collectSyncedAudioEffectInstances(effects);

    for (const row of effects) {
      if ("effect" in row) {
        if (row.effect === "instrument" || (row.effect === "synth" && !instrumentByTrackId.has(row.targetId))) {
          const instrument = readInstrumentParamsFromEffectRow(row);
          if (instrument) instrumentByTrackId.set(row.targetId, instrument);
          continue;
        }
        if (row.effect === "arp") {
          const parsed = arpeggiatorParamsSchema.safeParse(row.params);
          if (parsed.success) {
            arpByTrackId.set(row.targetId, normalizeArpeggiatorParams(parsed.data));
          }
          continue;
        }
        continue;
      }
      const trackId = row.trackId;
      if (!trackId) continue;
      if (row.type === "instrument" || (row.type === "synth" && !instrumentByTrackId.has(trackId))) {
        const instrument = readInstrumentParamsFromEffectRow(row);
        if (instrument) instrumentByTrackId.set(trackId, instrument);
      }
      if (row.type === "arpeggiator" && row.params) {
        arpByTrackId.set(trackId, normalizeArpeggiatorParams(row.params));
      }
    }

    const effectiveInstrumentByTrackId = new Map(instrumentByTrackId);
    for (const track of tracks) {
      const draftInstrument = options.localDraftEffects?.instrument?.(track.id);
      if (draftInstrument) effectiveInstrumentByTrackId.set(track.id, draftInstrument);
    }

    const staleTrackIds = new Set<Track["id"]>();
    for (const trackId of syncedTrackIds) {
      if (!currentTrackIds.has(trackId)) {
        staleTrackIds.add(trackId);
      }
    }
    for (const trackId of staleTrackIds) {
      drumRackBufferSync.clearTrack(trackId);
      samplerBufferSync.clearTrack(trackId);
    }

    registerSampledInstrumentWork({
      projectId,
      tracks,
      instruments: effectiveInstrumentByTrackId,
      clearSamplerTrack: (trackId) => samplerBufferSync.clearTrack(trackId),
      clearDrumRackTrack: (trackId) => drumRackBufferSync.clearTrack(trackId),
      syncSamplerTrack: (trackId, params, instanceId) => samplerBufferSync.syncTrack(audioEngine, trackId, params, instanceId),
      syncGranularTrack: (trackId, params, instanceId) => samplerBufferSync.syncGranularTrack(audioEngine, trackId, params, instanceId),
      syncDrumRackTrack: (trackId, params, instanceId) => drumRackBufferSync.syncTrack(audioEngine, trackId, params, instanceId),
      trackPendingWork: (currentProjectId, work) => pendingWorkOwner.track(currentProjectId, work),
    });

    if (!usesLegacyAudioEngine) {
      syncedTrackIds = new Set(currentTrackIds);
      syncedProjectId = projectId;
      readinessOwner.markRowsProcessed(projectId);
      return;
    }

    void audioEngine.setMasterFxInstances(effectInstances.master).catch(() => undefined);
    clearSyncedTrackState(audioEngine, staleTrackIds);

    for (const track of tracks) {
      const trackEffectInstances = effectInstances.tracks.get(track.id) ?? [];
      void audioEngine.setTrackFxInstances(track.id, trackEffectInstances).catch(() => undefined);
      if (track.kind === "instrument") {
        const instrument = options.localDraftEffects?.instrument?.(track.id) ?? instrumentByTrackId.get(track.id);
        if (instrument?.kind === "synth") {
          audioEngine.setTrackInstrument(track.id, { instrument });
        } else if (!instrument) {
          audioEngine.clearTrackInstrument(track.id);
        }
        const arp = options.localDraftEffects?.arp?.(track.id) ?? arpByTrackId.get(track.id);
        if (arp) audioEngine.setTrackArpeggiator(track.id, arp);
        else audioEngine.clearTrackArpeggiator(track.id);
        continue;
      }
      drumRackBufferSync.clearTrack(track.id);
      samplerBufferSync.clearTrack(track.id);
      audioEngine.clearTrackInstrument(track.id);
      audioEngine.clearTrackArpeggiator(track.id);
    }
    audioEngine.setExternalSidechainRoutes(options.sidechainRoutes());

    syncedTrackIds = new Set(currentTrackIds);
    syncedProjectId = projectId;
    readinessOwner.markRowsProcessed(projectId);
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
