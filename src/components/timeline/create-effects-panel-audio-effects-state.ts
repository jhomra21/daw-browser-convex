import { createMemo, type Accessor } from "solid-js";
import type { FunctionReturnType } from "convex/server";
import type { AudioEngine } from "@daw-browser/audio-engine/audio-engine";
import {
  createDefaultEqParams,
  createDefaultDelayParams,
  createDefaultReverbParams,
  createDefaultSaturatorParams,
  normalizeDelayParams,
  normalizeEqParams,
  normalizeReverbParams,
  normalizeSaturatorParams,
  serializeDelayParams,
  serializeEqParams,
  serializeReverbParams,
  serializeSaturatorParams,
  type DelayParams,
  type EqChannelMode,
  type EqParams,
  type ReverbParams,
  type SaturatorParams,
} from "@daw-browser/shared";
import { isLocalId } from "@daw-browser/shared";
import type { Track } from "@daw-browser/timeline-core/types";
import { createLocalEffectRows } from "~/components/timeline/create-local-effect-rows";
import { createPersistedEffectState } from "~/components/timeline/create-persisted-effect-state";
import {
  EFFECT_PANEL_LOCAL_EDIT_SUPPRESS_MS,
  EFFECT_PANEL_SAVE_DEBOUNCE_MS,
} from "~/components/timeline/create-effects-panel-state";
import { convexApi } from "~/lib/convex";
import type { LocalEffectRow } from "~/lib/local-effects";
import type { SharedTimelineOperation } from "~/lib/shared-timeline-operations-api";
import { publishDurableSharedTimelineOperation } from "~/lib/shared-outbox";
import type { EffectParamsCommitPayload, EffectType } from "~/lib/undo/types";

type EffectKind = "eq" | "saturator" | "delay" | "reverb";

type RoomEffectRow = FunctionReturnType<typeof convexApi.effects.listByRoom>[number];
type PersistedAudioEffectDescriptor<Params> = {
  kind: EffectKind;
  createDefaultParams: () => Params;
  normalizeParams: (params: Params) => Params;
  serializeParams: (params: Params) => string;
  setTrackEngineParams: (audioEngine: AudioEngine, trackId: string, params: Params) => void;
  setMasterEngineParams: (audioEngine: AudioEngine, params: Params) => void;
  row: (targetId: string) => LocalEffectRow<Params> | undefined;
  persistLocal: (projectId: string, targetId: string, params: Params) => Promise<void>;
  publishTrackParams: (projectId: string, userId: string, trackId: string, params: Params) => Promise<unknown>;
  publishMasterParams: (projectId: string, userId: string, params: Params) => Promise<unknown>;
  commitTrackParams: (trackId: string, previous: Params, next: Params, projectId?: string) => void;
  commitMasterParams: (previous: Params, next: Params, projectId?: string) => void;
};

type EffectsPanelAudioEffectsContext = {
  audioEngine: Accessor<AudioEngine>;
  projectId: Accessor<string | undefined>;
  userId: Accessor<string | undefined>;
  roomEffects: Accessor<RoomEffectRow[] | undefined>;
  canWriteCurrentTargetEffects: Accessor<boolean>;
  onEffectParamsCommitted?: <Effect extends EffectType>(payload: EffectParamsCommitPayload<Effect>, projectId?: string) => void;
  onLocalSaveFailed?: (message: string) => void;
};

type EffectsPanelAudioDevice = {
  eq: {
    add: () => void;
    changeBand: (bandId: string, updates: Partial<EqParams["bands"][number]>) => void;
    changeChannelMode: (mode: EqChannelMode) => void;
    params: Accessor<EqParams | undefined>;
    readDraftForTarget: (targetId: string) => EqParams | undefined;
    reset: () => void;
    toggleBand: (bandId: string) => void;
    toggleEnabled: (enabled: boolean) => void;
  };
  saturator: {
    add: () => void;
    change: (updates: Partial<SaturatorParams>) => void;
    params: Accessor<SaturatorParams | undefined>;
    readDraftForTarget: (targetId: string) => SaturatorParams | undefined;
    reset: () => void;
    toggleEnabled: (enabled: boolean) => void;
  };
  delay: {
    add: () => void;
    change: (updates: Partial<DelayParams>) => void;
    params: Accessor<DelayParams | undefined>;
    readDraftForTarget: (targetId: string) => DelayParams | undefined;
    reset: () => void;
    toggleEnabled: (enabled: boolean) => void;
  };
  flushPending: () => Promise<void>;
  orderedEffects: Accessor<EffectKind[]>;
  reverb: {
    add: () => void;
    change: (updates: Partial<ReverbParams>) => void;
    params: Accessor<ReverbParams | undefined>;
    readDraftForTarget: (targetId: string) => ReverbParams | undefined;
    reset: () => void;
    toggleEnabled: (enabled: boolean) => void;
  };
};

export function createEffectsPanelAudioDevice(
  context: EffectsPanelAudioEffectsContext,
  currentTargetId: Accessor<string>,
  resolveTrackByTargetId: (targetId: string) => Track | undefined,
): EffectsPanelAudioDevice {
  const localEq = createLocalEffectRows<EqParams>({
    projectId: context.projectId,
    targetId: currentTargetId,
    effect: (targetId) => targetId === "master" ? "master-eq" : "eq",
    normalize: normalizeEqParams,
  });
  const localReverb = createLocalEffectRows<ReverbParams>({
    projectId: context.projectId,
    targetId: currentTargetId,
    effect: (targetId) => targetId === "master" ? "master-reverb" : "reverb",
    normalize: normalizeReverbParams,
  });
  const localSaturator = createLocalEffectRows<SaturatorParams>({
    projectId: context.projectId,
    targetId: currentTargetId,
    effect: (targetId) => targetId === "master" ? "master-saturator" : "saturator",
    normalize: normalizeSaturatorParams,
  });
  const localDelay = createLocalEffectRows<DelayParams>({
    projectId: context.projectId,
    targetId: currentTargetId,
    effect: (targetId) => targetId === "master" ? "master-delay" : "delay",
    normalize: normalizeDelayParams,
  });
  const isLocalProject = localEq.isLocalProject;

  const remoteEffectForTarget = (targetId: string, effectType: EffectKind) => {
    const targetType = targetId === "master" ? "master" : "track";
    return context.roomEffects()?.find((row) => {
      if (row.type !== effectType || row.targetType !== targetType) return false;
      return targetType === "master" ? true : row.trackId === targetId;
    });
  };

  const publishEffectOperation = (
    projectId: string,
    userId: string,
    operation: SharedTimelineOperation,
  ) => publishDurableSharedTimelineOperation({ projectId, userId, operation });

  function createAudioEffectState<Params>(descriptor: PersistedAudioEffectDescriptor<Params>) {
    return createPersistedEffectState<RoomEffectRow | LocalEffectRow<Params> | undefined, Params>({
    targetId: currentTargetId,
    scopeId: context.projectId,
    row: () => isLocalProject() ? descriptor.row(currentTargetId()) : remoteEffectForTarget(currentTargetId(), descriptor.kind),
    readQueryParams: (row) => row?.params ? descriptor.normalizeParams(row.params) : undefined,
    createInitialParams: () => descriptor.createDefaultParams(),
    serializeParams: descriptor.serializeParams,
    applyToEngine: (targetId, params) => {
      if (targetId === "master") {
        descriptor.setMasterEngineParams(context.audioEngine(), params);
      } else {
        descriptor.setTrackEngineParams(context.audioEngine(), targetId, params);
      }
    },
    createPersistContext: () => ({ projectId: context.projectId(), userId: context.userId() }),
    persistParams: (targetId, params, persistContext) => {
      if (!persistContext.projectId) return Promise.resolve();
      if (isLocalId("project", persistContext.projectId)) return descriptor.persistLocal(persistContext.projectId, targetId, params);
      if (!persistContext.userId) return Promise.resolve();
      const normalizedParams = descriptor.normalizeParams(params);
      if (targetId === "master") {
        return descriptor.publishMasterParams(persistContext.projectId, persistContext.userId, normalizedParams);
      }
      const track = resolveTrackByTargetId(targetId);
      if (!track) return Promise.resolve();
      return descriptor.publishTrackParams(persistContext.projectId, persistContext.userId, track.id, normalizedParams);
    },
    debounceMs: EFFECT_PANEL_SAVE_DEBOUNCE_MS,
    remoteOverwriteAfterMs: EFFECT_PANEL_LOCAL_EDIT_SUPPRESS_MS,
    onPersistError: (error) => {
      if (!isLocalProject()) return;
      context.onLocalSaveFailed?.(error instanceof Error ? error.message : "Local effect could not be saved.");
    },
    onParamsCommitted: (targetId, previous, next, persistContext) => {
      if (previous === undefined) return;
      if (targetId === "master") {
        descriptor.commitMasterParams(previous, next, persistContext.projectId);
        return;
      }
      const track = resolveTrackByTargetId(targetId);
      if (!track) return;
      descriptor.commitTrackParams(track.id, previous, next, persistContext.projectId);
    },
  });
  }

  const eqState = createAudioEffectState<EqParams>({
    kind: "eq",
    createDefaultParams: createDefaultEqParams,
    normalizeParams: normalizeEqParams,
    serializeParams: serializeEqParams,
    setTrackEngineParams: (audioEngine, trackId, params) => audioEngine.setTrackEq(trackId, params),
    setMasterEngineParams: (audioEngine, params) => audioEngine.setMasterEq(params),
    row: localEq.row,
    persistLocal: localEq.persist,
    publishTrackParams: (projectId, userId, trackId, params) => publishEffectOperation(projectId, userId, {
      kind: "effects.setEqParams",
      payload: { trackId, params },
    }),
    publishMasterParams: (projectId, userId, params) => publishEffectOperation(projectId, userId, {
      kind: "effects.setMasterEqParams",
      payload: { params },
    }),
    commitTrackParams: (trackId, previous, next, projectId) => context.onEffectParamsCommitted?.({ targetId: trackId, effect: "eq", from: previous, to: next }, projectId),
    commitMasterParams: (previous, next, projectId) => context.onEffectParamsCommitted?.({ targetId: "master", effect: "master-eq", from: previous, to: next }, projectId),
  });

  const reverbState = createAudioEffectState<ReverbParams>({
    kind: "reverb",
    createDefaultParams: createDefaultReverbParams,
    normalizeParams: normalizeReverbParams,
    serializeParams: serializeReverbParams,
    setTrackEngineParams: (audioEngine, trackId, params) => audioEngine.setTrackReverb(trackId, params),
    setMasterEngineParams: (audioEngine, params) => audioEngine.setMasterReverb(params),
    row: localReverb.row,
    persistLocal: localReverb.persist,
    publishTrackParams: (projectId, userId, trackId, params) => publishEffectOperation(projectId, userId, {
      kind: "effects.setReverbParams",
      payload: { trackId, params },
    }),
    publishMasterParams: (projectId, userId, params) => publishEffectOperation(projectId, userId, {
      kind: "effects.setMasterReverbParams",
      payload: { params },
    }),
    commitTrackParams: (trackId, previous, next, projectId) => context.onEffectParamsCommitted?.({ targetId: trackId, effect: "reverb", from: previous, to: next }, projectId),
    commitMasterParams: (previous, next, projectId) => context.onEffectParamsCommitted?.({ targetId: "master", effect: "master-reverb", from: previous, to: next }, projectId),
  });

  const saturatorState = createAudioEffectState<SaturatorParams>({
    kind: "saturator",
    createDefaultParams: createDefaultSaturatorParams,
    normalizeParams: normalizeSaturatorParams,
    serializeParams: serializeSaturatorParams,
    setTrackEngineParams: (audioEngine, trackId, params) => audioEngine.setTrackSaturator(trackId, params),
    setMasterEngineParams: (audioEngine, params) => audioEngine.setMasterSaturator(params),
    row: localSaturator.row,
    persistLocal: localSaturator.persist,
    publishTrackParams: (projectId, userId, trackId, params) => publishEffectOperation(projectId, userId, {
      kind: "effects.setSaturatorParams",
      payload: { trackId, params },
    }),
    publishMasterParams: (projectId, userId, params) => publishEffectOperation(projectId, userId, {
      kind: "effects.setMasterSaturatorParams",
      payload: { params },
    }),
    commitTrackParams: (trackId, previous, next, projectId) => context.onEffectParamsCommitted?.({ targetId: trackId, effect: "saturator", from: previous, to: next }, projectId),
    commitMasterParams: (previous, next, projectId) => context.onEffectParamsCommitted?.({ targetId: "master", effect: "master-saturator", from: previous, to: next }, projectId),
  });

  const delayState = createAudioEffectState<DelayParams>({
    kind: "delay",
    createDefaultParams: createDefaultDelayParams,
    normalizeParams: normalizeDelayParams,
    serializeParams: serializeDelayParams,
    setTrackEngineParams: (audioEngine, trackId, params) => audioEngine.setTrackDelay(trackId, params),
    setMasterEngineParams: (audioEngine, params) => audioEngine.setMasterDelay(params),
    row: localDelay.row,
    persistLocal: localDelay.persist,
    publishTrackParams: (projectId, userId, trackId, params) => publishEffectOperation(projectId, userId, {
      kind: "effects.setDelayParams",
      payload: { trackId, params },
    }),
    publishMasterParams: (projectId, userId, params) => publishEffectOperation(projectId, userId, {
      kind: "effects.setMasterDelayParams",
      payload: { params },
    }),
    commitTrackParams: (trackId, previous, next, projectId) => context.onEffectParamsCommitted?.({ targetId: trackId, effect: "delay", from: previous, to: next }, projectId),
    commitMasterParams: (previous, next, projectId) => context.onEffectParamsCommitted?.({ targetId: "master", effect: "master-delay", from: previous, to: next }, projectId),
  });

  const orderedEffects = createMemo<EffectKind[]>(() => {
    const present: EffectKind[] = [];
    if (eqState.params()) present.push("eq");
    if (saturatorState.params()) present.push("saturator");
    if (delayState.params()) present.push("delay");
    if (reverbState.params()) present.push("reverb");
    const fixedOrder: EffectKind[] = ["eq", "saturator", "delay", "reverb"];
    return fixedOrder.filter((kind) => present.includes(kind));
  });

  const updateEq = (updater: (prev: EqParams) => EqParams) => {
    if (!context.canWriteCurrentTargetEffects()) return;
    eqState.update(updater);
  };
  const updateReverb = (updater: (prev: ReverbParams) => ReverbParams) => {
    if (!context.canWriteCurrentTargetEffects()) return;
    reverbState.update(updater);
  };
  const updateSaturator = (updater: (prev: SaturatorParams) => SaturatorParams) => {
    if (!context.canWriteCurrentTargetEffects()) return;
    saturatorState.update(updater);
  };
  const updateDelay = (updater: (prev: DelayParams) => DelayParams) => {
    if (!context.canWriteCurrentTargetEffects()) return;
    delayState.update(updater);
  };
  const addEq = () => {
    if (!context.canWriteCurrentTargetEffects()) return;
    eqState.add();
  };
  const addReverb = () => {
    if (!context.canWriteCurrentTargetEffects()) return;
    reverbState.add();
  };
  const addSaturator = () => {
    if (!context.canWriteCurrentTargetEffects()) return;
    saturatorState.add();
  };
  const addDelay = () => {
    if (!context.canWriteCurrentTargetEffects()) return;
    delayState.add();
  };

  return {
    eq: {
      add: addEq,
      changeBand: (bandId, updates) => updateEq((prev) => ({
        ...prev,
        bands: prev.bands.map((band) => band.id === bandId ? { ...band, ...updates } : band),
      })),
      changeChannelMode: (channelMode) => updateEq((prev) => (
        prev.channelMode === channelMode ? prev : normalizeEqParams({ ...prev, channelMode })
      )),
      params: eqState.params,
      readDraftForTarget: eqState.readDraftForTarget,
      reset: () => updateEq(() => createDefaultEqParams()),
      toggleBand: (bandId) => updateEq((prev) => ({
        ...prev,
        bands: prev.bands.map((band) => band.id === bandId ? { ...band, enabled: !band.enabled } : band),
      })),
      toggleEnabled: (enabled) => updateEq((prev) => ({ ...prev, enabled })),
    },
    flushPending: async () => {
      await Promise.all([eqState.flushPending(), saturatorState.flushPending(), delayState.flushPending(), reverbState.flushPending()]);
    },
    orderedEffects,
    saturator: {
      add: addSaturator,
      change: (updates) => updateSaturator((prev) => normalizeSaturatorParams({ ...prev, ...updates })),
      params: saturatorState.params,
      readDraftForTarget: saturatorState.readDraftForTarget,
      reset: () => updateSaturator(() => createDefaultSaturatorParams()),
      toggleEnabled: (enabled) => updateSaturator((prev) => ({ ...prev, enabled })),
    },
    delay: {
      add: addDelay,
      change: (updates) => updateDelay((prev) => normalizeDelayParams({ ...prev, ...updates })),
      params: delayState.params,
      readDraftForTarget: delayState.readDraftForTarget,
      reset: () => updateDelay(() => createDefaultDelayParams()),
      toggleEnabled: (enabled) => updateDelay((prev) => ({ ...prev, enabled })),
    },
    reverb: {
      add: addReverb,
      change: (updates) => updateReverb((prev) => normalizeReverbParams({ ...prev, ...updates })),
      params: reverbState.params,
      readDraftForTarget: reverbState.readDraftForTarget,
      reset: () => updateReverb(() => createDefaultReverbParams()),
      toggleEnabled: (enabled) => updateReverb((prev) => ({ ...prev, enabled })),
    },
  };
}
