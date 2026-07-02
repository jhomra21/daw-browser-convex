import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import type { FunctionReturnType } from "convex/server";
import type { AudioEffectRuntimeInstance, AudioEngine } from "@daw-browser/audio-engine/audio-engine";
import {
  AUDIO_EFFECT_CONTRACTS,
  AUDIO_EFFECT_ORDER,
  areAudioEffectInstanceOrdersEqual,
  audioEffectOrderItemKind,
  normalizeAudioEffectInstanceOrder,
  normalizeCompressorParams,
  normalizeDelayParams,
  normalizeEqParams,
  normalizeReverbParams,
  normalizeSaturatorParams,
  type AudioEffectKind,
  type AudioEffectInstance,
  type CompressorParams,
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
import { compareAudioEffectOrderEntries } from "~/lib/audio-effect-order-rows";
import { createAudioEffectInstanceId, deleteLocalEffectInstance, listLocalEffects, reorderLocalAudioEffects, setLocalEffectInstance, type LocalEffectRow } from "~/lib/local-effects";
import { subscribeToLocalProjectChanges } from "~/lib/local-project-changes";
import type { SharedTimelineOperation } from "~/lib/shared-timeline-operations-api";
import { publishDurableSharedTimelineOperation } from "~/lib/shared-outbox";
import type { EffectParamsCommitPayload, EffectType } from "~/lib/undo/types";
import type { AudioEffectChainPresetStep } from "~/lib/audio-effect-chain-presets";

type RoomEffectRow = FunctionReturnType<typeof convexApi.effects.listByRoom>[number];
type PersistedAudioEffectDescriptor<Params> = {
  kind: AudioEffectKind;
  createDefaultParams: () => Params;
  normalizeParams: (params: Params) => Params;
  serializeParams: (params: Params) => string;
  setTrackEngineParams: (audioEngine: AudioEngine, trackId: string, params: Params) => void;
  setMasterEngineParams: (audioEngine: AudioEngine, params: Params) => void;
  row: (targetId: string) => LocalEffectRow<Params> | undefined;
  persistLocal: (projectId: string, targetId: string, params: Params) => Promise<void>;
  removeLocal: (projectId: string, targetId: string) => Promise<void>;
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
    changeInstance: (instanceId: string, updates: (params: EqParams) => EqParams) => void;
    changeBand: (bandId: string, updates: Partial<EqParams["bands"][number]>) => void;
    changeChannelMode: (mode: EqChannelMode) => void;
    params: Accessor<EqParams | undefined>;
    readDraftForTarget: (targetId: string) => EqParams | undefined;
    reset: () => void;
    toggleBand: (bandId: string) => void;
    toggleEnabled: (enabled: boolean) => void;
  };
  compressor: {
    add: () => void;
    changeInstance: (instanceId: string, updates: (params: CompressorParams) => CompressorParams) => void;
    change: (updates: Partial<CompressorParams>) => void;
    params: Accessor<CompressorParams | undefined>;
    readDraftForTarget: (targetId: string) => CompressorParams | undefined;
    reset: () => void;
    toggleEnabled: (enabled: boolean) => void;
  };
  saturator: {
    add: () => void;
    changeInstance: (instanceId: string, updates: (params: SaturatorParams) => SaturatorParams) => void;
    change: (updates: Partial<SaturatorParams>) => void;
    params: Accessor<SaturatorParams | undefined>;
    readDraftForTarget: (targetId: string) => SaturatorParams | undefined;
    reset: () => void;
    toggleEnabled: (enabled: boolean) => void;
  };
  delay: {
    add: () => void;
    changeInstance: (instanceId: string, updates: (params: DelayParams) => DelayParams) => void;
    change: (updates: Partial<DelayParams>) => void;
    params: Accessor<DelayParams | undefined>;
    readDraftForTarget: (targetId: string) => DelayParams | undefined;
    reset: () => void;
    toggleEnabled: (enabled: boolean) => void;
  };
  addByKindToTarget: (targetId: Track["id"] | "master", effect: AudioEffectKind, index?: number) => Promise<boolean>;
  addChainToTarget: (targetId: Track["id"] | "master", effects: readonly AudioEffectChainPresetStep[], index?: number) => Promise<boolean>;
  canAddByKindToTarget: (targetId: Track["id"] | "master", effect: AudioEffectKind) => boolean;
  flushPending: () => Promise<void>;
  paramsForInstance: (instance: AudioEffectInstance) => EqParams | CompressorParams | SaturatorParams | DelayParams | ReverbParams | undefined;
  orderedEffects: Accessor<AudioEffectInstance[]>;
  removeAllFromTarget: (targetId: Track["id"] | "master") => Promise<boolean>;
  removeByInstanceFromTarget: (targetId: Track["id"] | "master", instance: AudioEffectInstance) => Promise<boolean>;
  reorder: (instance: AudioEffectInstance, targetIndex: number) => void;
  reverb: {
    add: () => void;
    changeInstance: (instanceId: string, updates: (params: ReverbParams) => ReverbParams) => void;
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
    effect: (targetId) => targetId === "master" ? AUDIO_EFFECT_CONTRACTS.eq.masterKind : AUDIO_EFFECT_CONTRACTS.eq.kind,
    normalize: AUDIO_EFFECT_CONTRACTS.eq.normalizeParams,
  });
  const localReverb = createLocalEffectRows<ReverbParams>({
    projectId: context.projectId,
    targetId: currentTargetId,
    effect: (targetId) => targetId === "master" ? AUDIO_EFFECT_CONTRACTS.reverb.masterKind : AUDIO_EFFECT_CONTRACTS.reverb.kind,
    normalize: AUDIO_EFFECT_CONTRACTS.reverb.normalizeParams,
  });
  const localCompressor = createLocalEffectRows<CompressorParams>({
    projectId: context.projectId,
    targetId: currentTargetId,
    effect: (targetId) => targetId === "master" ? AUDIO_EFFECT_CONTRACTS.compressor.masterKind : AUDIO_EFFECT_CONTRACTS.compressor.kind,
    normalize: AUDIO_EFFECT_CONTRACTS.compressor.normalizeParams,
  });
  const localSaturator = createLocalEffectRows<SaturatorParams>({
    projectId: context.projectId,
    targetId: currentTargetId,
    effect: (targetId) => targetId === "master" ? AUDIO_EFFECT_CONTRACTS.saturator.masterKind : AUDIO_EFFECT_CONTRACTS.saturator.kind,
    normalize: AUDIO_EFFECT_CONTRACTS.saturator.normalizeParams,
  });
  const localDelay = createLocalEffectRows<DelayParams>({
    projectId: context.projectId,
    targetId: currentTargetId,
    effect: (targetId) => targetId === "master" ? AUDIO_EFFECT_CONTRACTS.delay.masterKind : AUDIO_EFFECT_CONTRACTS.delay.kind,
    normalize: AUDIO_EFFECT_CONTRACTS.delay.normalizeParams,
  });
  const isLocalProject = localEq.isLocalProject;
  const [localAllEffects, setLocalAllEffects] = createSignal<LocalEffectRow[] | undefined>();

  createEffect(() => {
    const projectId = context.projectId();
    if (!projectId || !isLocalProject()) {
      setLocalAllEffects(undefined);
      return;
    }
    const isCurrentProject = () => context.projectId() === projectId && isLocalProject();
    const reload = () => listLocalEffects(projectId).then((rows) => {
      if (isCurrentProject()) setLocalAllEffects(rows);
    }).catch(() => {
      if (isCurrentProject()) setLocalAllEffects([]);
    });
    void reload();
    const unsubscribe = subscribeToLocalProjectChanges(projectId, () => {
      void reload();
    });
    onCleanup(unsubscribe);
  });

  const remoteEffectForTarget = (targetId: string, effectType: AudioEffectKind) => {
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
    persistRemove: (targetId, persistContext) => {
      if (!persistContext.projectId) return Promise.resolve();
      if (isLocalId("project", persistContext.projectId)) return descriptor.removeLocal(persistContext.projectId, targetId);
      if (!persistContext.userId) return Promise.resolve();
      if (targetId === "master") {
        return publishEffectOperation(persistContext.projectId, persistContext.userId, {
          kind: "effects.removeAudioEffect",
          payload: { targetType: "master", effect: descriptor.kind },
        });
      }
      const track = resolveTrackByTargetId(targetId);
      if (!track) return Promise.resolve();
      return publishEffectOperation(persistContext.projectId, persistContext.userId, {
        kind: "effects.removeAudioEffect",
        payload: { targetType: "track", trackId: track.id, effect: descriptor.kind },
      });
    },
    clearAfterPersistRemove: (persistContext) => Boolean(persistContext.projectId && isLocalId("project", persistContext.projectId)),
    isMissingRowLoaded: () => !isLocalProject() && context.roomEffects() !== undefined,
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
    kind: AUDIO_EFFECT_CONTRACTS.eq.kind,
    createDefaultParams: AUDIO_EFFECT_CONTRACTS.eq.createDefaultParams,
    normalizeParams: AUDIO_EFFECT_CONTRACTS.eq.normalizeParams,
    serializeParams: AUDIO_EFFECT_CONTRACTS.eq.serializeParams,
    setTrackEngineParams: (audioEngine, trackId, params) => audioEngine.setTrackEq(trackId, params),
    setMasterEngineParams: (audioEngine, params) => audioEngine.setMasterEq(params),
    row: localEq.row,
    persistLocal: localEq.persist,
    removeLocal: localEq.remove,
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
    kind: AUDIO_EFFECT_CONTRACTS.reverb.kind,
    createDefaultParams: AUDIO_EFFECT_CONTRACTS.reverb.createDefaultParams,
    normalizeParams: AUDIO_EFFECT_CONTRACTS.reverb.normalizeParams,
    serializeParams: AUDIO_EFFECT_CONTRACTS.reverb.serializeParams,
    setTrackEngineParams: (audioEngine, trackId, params) => audioEngine.setTrackReverb(trackId, params),
    setMasterEngineParams: (audioEngine, params) => audioEngine.setMasterReverb(params),
    row: localReverb.row,
    persistLocal: localReverb.persist,
    removeLocal: localReverb.remove,
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

  const compressorState = createAudioEffectState<CompressorParams>({
    kind: AUDIO_EFFECT_CONTRACTS.compressor.kind,
    createDefaultParams: AUDIO_EFFECT_CONTRACTS.compressor.createDefaultParams,
    normalizeParams: AUDIO_EFFECT_CONTRACTS.compressor.normalizeParams,
    serializeParams: AUDIO_EFFECT_CONTRACTS.compressor.serializeParams,
    setTrackEngineParams: (audioEngine, trackId, params) => audioEngine.setTrackCompressor(trackId, params),
    setMasterEngineParams: (audioEngine, params) => audioEngine.setMasterCompressor(params),
    row: localCompressor.row,
    persistLocal: localCompressor.persist,
    removeLocal: localCompressor.remove,
    publishTrackParams: (projectId, userId, trackId, params) => publishEffectOperation(projectId, userId, {
      kind: "effects.setCompressorParams",
      payload: { trackId, params },
    }),
    publishMasterParams: (projectId, userId, params) => publishEffectOperation(projectId, userId, {
      kind: "effects.setMasterCompressorParams",
      payload: { params },
    }),
    commitTrackParams: (trackId, previous, next, projectId) => context.onEffectParamsCommitted?.({ targetId: trackId, effect: "compressor", from: previous, to: next }, projectId),
    commitMasterParams: (previous, next, projectId) => context.onEffectParamsCommitted?.({ targetId: "master", effect: "master-compressor", from: previous, to: next }, projectId),
  });

  const saturatorState = createAudioEffectState<SaturatorParams>({
    kind: AUDIO_EFFECT_CONTRACTS.saturator.kind,
    createDefaultParams: AUDIO_EFFECT_CONTRACTS.saturator.createDefaultParams,
    normalizeParams: AUDIO_EFFECT_CONTRACTS.saturator.normalizeParams,
    serializeParams: AUDIO_EFFECT_CONTRACTS.saturator.serializeParams,
    setTrackEngineParams: (audioEngine, trackId, params) => audioEngine.setTrackSaturator(trackId, params),
    setMasterEngineParams: (audioEngine, params) => audioEngine.setMasterSaturator(params),
    row: localSaturator.row,
    persistLocal: localSaturator.persist,
    removeLocal: localSaturator.remove,
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
    kind: AUDIO_EFFECT_CONTRACTS.delay.kind,
    createDefaultParams: AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams,
    normalizeParams: AUDIO_EFFECT_CONTRACTS.delay.normalizeParams,
    serializeParams: AUDIO_EFFECT_CONTRACTS.delay.serializeParams,
    setTrackEngineParams: (audioEngine, trackId, params) => audioEngine.setTrackDelay(trackId, params),
    setMasterEngineParams: (audioEngine, params) => audioEngine.setMasterDelay(params),
    row: localDelay.row,
    persistLocal: localDelay.persist,
    removeLocal: localDelay.remove,
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

  type AudioEffectParams = EqParams | CompressorParams | SaturatorParams | DelayParams | ReverbParams;
  type AudioEffectPanelRow = {
    targetId: string;
    kind: AudioEffectKind;
    instanceId?: string;
    index?: number;
    params: AudioEffectParams;
  };
  const [draftParamsByInstance, setDraftParamsByInstance] = createSignal<Record<string, AudioEffectParams | undefined>>({});
  const [optimisticOrder, setOptimisticOrder] = createSignal<{ targetId: string; order: AudioEffectInstance[] }>();

  const objectParamInput = (params: unknown): object => (params && typeof params === "object" ? params : {});

  const normalizeParamsForKind = (kind: AudioEffectKind, params: unknown): AudioEffectParams => {
    const input = objectParamInput(params);
    if (kind === "eq") return AUDIO_EFFECT_CONTRACTS.eq.normalizeParams(input);
    if (kind === "compressor") return AUDIO_EFFECT_CONTRACTS.compressor.normalizeParams(input);
    if (kind === "saturator") return AUDIO_EFFECT_CONTRACTS.saturator.normalizeParams(input);
    if (kind === "delay") return AUDIO_EFFECT_CONTRACTS.delay.normalizeParams(input);
    return AUDIO_EFFECT_CONTRACTS.reverb.normalizeParams(input);
  };

  const createDefaultParamsForKind = (kind: AudioEffectKind): AudioEffectParams => {
    if (kind === "eq") return AUDIO_EFFECT_CONTRACTS.eq.createDefaultParams();
    if (kind === "compressor") return AUDIO_EFFECT_CONTRACTS.compressor.createDefaultParams();
    if (kind === "saturator") return AUDIO_EFFECT_CONTRACTS.saturator.createDefaultParams();
    if (kind === "delay") return AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams();
    return AUDIO_EFFECT_CONTRACTS.reverb.createDefaultParams();
  };

  const areParamsForKindEqual = (kind: AudioEffectKind, previous: AudioEffectParams, next: AudioEffectParams) => {
    if (kind === "eq") return AUDIO_EFFECT_CONTRACTS.eq.serializeParams(normalizeEqParams(previous)) === AUDIO_EFFECT_CONTRACTS.eq.serializeParams(normalizeEqParams(next));
    if (kind === "compressor") return AUDIO_EFFECT_CONTRACTS.compressor.serializeParams(normalizeCompressorParams(previous)) === AUDIO_EFFECT_CONTRACTS.compressor.serializeParams(normalizeCompressorParams(next));
    if (kind === "saturator") return AUDIO_EFFECT_CONTRACTS.saturator.serializeParams(normalizeSaturatorParams(previous)) === AUDIO_EFFECT_CONTRACTS.saturator.serializeParams(normalizeSaturatorParams(next));
    if (kind === "delay") return AUDIO_EFFECT_CONTRACTS.delay.serializeParams(normalizeDelayParams(previous)) === AUDIO_EFFECT_CONTRACTS.delay.serializeParams(normalizeDelayParams(next));
    return AUDIO_EFFECT_CONTRACTS.reverb.serializeParams(normalizeReverbParams(previous)) === AUDIO_EFFECT_CONTRACTS.reverb.serializeParams(normalizeReverbParams(next));
  };

  const normalizePresetStepParams = (step: AudioEffectChainPresetStep): AudioEffectParams => {
    if (step.kind === "eq") return normalizeEqParams(step.params);
    if (step.kind === "compressor") return normalizeCompressorParams(step.params);
    if (step.kind === "saturator") return normalizeSaturatorParams(step.params);
    if (step.kind === "delay") return normalizeDelayParams(step.params);
    return normalizeReverbParams(step.params);
  };

  const createDefaultPresetStep = (kind: AudioEffectKind): AudioEffectChainPresetStep => {
    if (kind === "eq") return { kind, params: AUDIO_EFFECT_CONTRACTS.eq.createDefaultParams() };
    if (kind === "compressor") return { kind, params: AUDIO_EFFECT_CONTRACTS.compressor.createDefaultParams() };
    if (kind === "saturator") return { kind, params: AUDIO_EFFECT_CONTRACTS.saturator.createDefaultParams() };
    if (kind === "delay") return { kind, params: AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams() };
    return { kind, params: AUDIO_EFFECT_CONTRACTS.reverb.createDefaultParams() };
  };

  const localEffectForKind = (targetId: string, kind: AudioEffectKind) => (
    targetId === "master" ? AUDIO_EFFECT_CONTRACTS[kind].masterKind : AUDIO_EFFECT_CONTRACTS[kind].kind
  );

  const instanceKey = (targetId: string, instanceId: string) => `${targetId}:${instanceId}`;

  const persistedRowsForTarget = (targetId: string): AudioEffectPanelRow[] => {
    if (isLocalProject()) {
      return (localAllEffects() ?? []).flatMap((row) => {
        if (row.targetId !== targetId) return [];
        const kind = AUDIO_EFFECT_ORDER.find((entry) => row.effect === entry || row.effect === AUDIO_EFFECT_CONTRACTS[entry].masterKind);
        return kind && row.params ? [{
          targetId,
          kind,
          instanceId: row.instanceId,
          index: row.index,
          params: normalizeParamsForKind(kind, row.params),
        }] : [];
      });
    }
    return (context.roomEffects() ?? []).flatMap((row) => {
      if (targetId === "master") {
        if (row.targetType !== "master") return [];
      } else if (row.targetType !== "track" || row.trackId !== targetId) return [];
      const kind = AUDIO_EFFECT_ORDER.find((entry) => row.type === entry);
      return kind && row.params ? [{
        targetId,
        kind,
        instanceId: row.instanceId,
        index: row.index,
        params: normalizeParamsForKind(kind, row.params),
      }] : [];
    });
  };

  const orderedInstancesForTarget = (targetId: string): AudioEffectInstance[] => {
    const rows = persistedRowsForTarget(targetId);
    const entries = rows
      .map((row) => ({ kind: row.kind, id: row.instanceId ?? row.kind, index: row.index }))
      .sort(compareAudioEffectOrderEntries)
      .map((row) => ({ id: row.id, kind: row.kind }));
    return normalizeAudioEffectInstanceOrder(entries, entries);
  };

  function readPersistedOrderedEffectsForTarget(targetId: string): AudioEffectInstance[] {
    return orderedInstancesForTarget(targetId);
  }

  const persistedOrderedEffects = createMemo<AudioEffectInstance[]>(() => {
    const targetId = currentTargetId();
    return readPersistedOrderedEffectsForTarget(targetId);
  });

  const orderedEffects = createMemo<AudioEffectInstance[]>(() => {
    const persistedOrder = persistedOrderedEffects();
    const optimistic = optimisticOrder();
    if (optimistic?.targetId !== currentTargetId()) return persistedOrder;
    return optimistic.order;
  });

  createEffect(() => {
    const optimistic = optimisticOrder();
    if (!optimistic || optimistic.targetId !== currentTargetId()) return;
    if (areAudioEffectInstanceOrdersEqual(optimistic.order, persistedOrderedEffects())) {
      setOptimisticOrder();
    }
  });

  createEffect(() => {
    const order = orderedEffects();
    const targetId = currentTargetId();
    applyInstancesToEngine(targetId, order);
  });

  const persistReorder = async (targetId: string, order: AudioEffectInstance[]) => {
    const projectId = context.projectId();
    if (!projectId) return;
    if (isLocalId("project", projectId)) {
      await reorderLocalAudioEffects(projectId, targetId, order);
      return;
    }
    const userId = context.userId();
    if (!userId) return;
    if (targetId === "master") {
      await publishEffectOperation(projectId, userId, {
        kind: "effects.reorderMasterAudioChain",
        payload: { order },
      });
      return;
    }
    const track = resolveTrackByTargetId(targetId);
    if (!track) return;
    await publishEffectOperation(projectId, userId, {
      kind: "effects.reorderAudioChain",
      payload: { trackId: track.id, order },
    });
  };

  const reorder = (instance: AudioEffectInstance, targetIndex: number) => {
    if (!context.canWriteCurrentTargetEffects()) return;
    reorderForTarget(currentTargetId(), instance, targetIndex);
  };

  const reorderForTarget = (targetId: string, instance: AudioEffectInstance, targetIndex: number) => {
    const currentOrder = targetId === currentTargetId() ? orderedEffects() : readPersistedOrderedEffectsForTarget(targetId);
    const fromIndex = currentOrder.findIndex((entry) => entry.id === instance.id);
    if (fromIndex < 0) return;
    const nextOrder = currentOrder.filter((entry) => entry.id !== instance.id);
    const clampedIndex = Math.max(0, Math.min(targetIndex, nextOrder.length));
    nextOrder.splice(clampedIndex, 0, instance);
    const normalized = normalizeAudioEffectInstanceOrder(nextOrder, currentOrder);
    if (areAudioEffectInstanceOrdersEqual(currentOrder, normalized)) return;
    setOptimisticOrder({ targetId, order: normalized });
    applyInstancesToEngine(targetId, normalized);
    void persistReorder(targetId, normalized).catch(() => {
      const optimistic = optimisticOrder();
      if (optimistic?.targetId === targetId && areAudioEffectInstanceOrdersEqual(optimistic.order, normalized)) {
        setOptimisticOrder();
      }
    });
  };

  function paramsForInstanceForTarget(targetId: string, instance: AudioEffectInstance) {
    return draftParamsByInstance()[instanceKey(targetId, instance.id)]
      ?? persistedRowsForTarget(targetId).find((row) => (row.instanceId ?? row.kind) === instance.id && row.kind === instance.kind)?.params;
  }

  const paramsForInstance = (instance: AudioEffectInstance) => paramsForInstanceForTarget(currentTargetId(), instance);

  function runtimeInstanceForParams(instance: AudioEffectInstance, params: AudioEffectParams): AudioEffectRuntimeInstance {
    if (instance.kind === "eq") return { id: instance.id, kind: instance.kind, params: normalizeEqParams(params) };
    if (instance.kind === "compressor") return { id: instance.id, kind: instance.kind, params: normalizeCompressorParams(params) };
    if (instance.kind === "saturator") return { id: instance.id, kind: instance.kind, params: normalizeSaturatorParams(params) };
    if (instance.kind === "delay") return { id: instance.id, kind: instance.kind, params: normalizeDelayParams(params) };
    return { id: instance.id, kind: instance.kind, params: normalizeReverbParams(params) };
  }

  function buildRuntimeInstancesForTarget(targetId: string, order: AudioEffectInstance[]): AudioEffectRuntimeInstance[] {
    return order.flatMap((instance) => {
      const params = paramsForInstanceForTarget(targetId, instance);
      return params ? [runtimeInstanceForParams(instance, params)] : [];
    });
  }

  function commitInstanceParams(targetId: string, instanceId: string, kind: AudioEffectKind, previous: AudioEffectParams, next: AudioEffectParams) {
    if (kind === "eq") {
      const from = normalizeEqParams(previous);
      const to = normalizeEqParams(next);
      if (AUDIO_EFFECT_CONTRACTS.eq.serializeParams(from) === AUDIO_EFFECT_CONTRACTS.eq.serializeParams(to)) return;
      if (targetId === "master") context.onEffectParamsCommitted?.({ targetId: "master", effect: "master-eq", instanceId, from, to }, context.projectId());
      else context.onEffectParamsCommitted?.({ targetId, effect: "eq", instanceId, from, to }, context.projectId());
      return;
    }
    if (kind === "compressor") {
      const from = normalizeCompressorParams(previous);
      const to = normalizeCompressorParams(next);
      if (AUDIO_EFFECT_CONTRACTS.compressor.serializeParams(from) === AUDIO_EFFECT_CONTRACTS.compressor.serializeParams(to)) return;
      if (targetId === "master") context.onEffectParamsCommitted?.({ targetId: "master", effect: "master-compressor", instanceId, from, to }, context.projectId());
      else context.onEffectParamsCommitted?.({ targetId, effect: "compressor", instanceId, from, to }, context.projectId());
      return;
    }
    if (kind === "saturator") {
      const from = normalizeSaturatorParams(previous);
      const to = normalizeSaturatorParams(next);
      if (AUDIO_EFFECT_CONTRACTS.saturator.serializeParams(from) === AUDIO_EFFECT_CONTRACTS.saturator.serializeParams(to)) return;
      if (targetId === "master") context.onEffectParamsCommitted?.({ targetId: "master", effect: "master-saturator", instanceId, from, to }, context.projectId());
      else context.onEffectParamsCommitted?.({ targetId, effect: "saturator", instanceId, from, to }, context.projectId());
      return;
    }
    if (kind === "delay") {
      const from = normalizeDelayParams(previous);
      const to = normalizeDelayParams(next);
      if (AUDIO_EFFECT_CONTRACTS.delay.serializeParams(from) === AUDIO_EFFECT_CONTRACTS.delay.serializeParams(to)) return;
      if (targetId === "master") context.onEffectParamsCommitted?.({ targetId: "master", effect: "master-delay", instanceId, from, to }, context.projectId());
      else context.onEffectParamsCommitted?.({ targetId, effect: "delay", instanceId, from, to }, context.projectId());
      return;
    }
    const from = normalizeReverbParams(previous);
    const to = normalizeReverbParams(next);
    if (AUDIO_EFFECT_CONTRACTS.reverb.serializeParams(from) === AUDIO_EFFECT_CONTRACTS.reverb.serializeParams(to)) return;
    if (targetId === "master") context.onEffectParamsCommitted?.({ targetId: "master", effect: "master-reverb", instanceId, from, to }, context.projectId());
    else context.onEffectParamsCommitted?.({ targetId, effect: "reverb", instanceId, from, to }, context.projectId());
  }

  function applyInstancesToEngine(targetId: string, order: AudioEffectInstance[]) {
    const instances = buildRuntimeInstancesForTarget(targetId, order);
    if (targetId === "master") context.audioEngine().setMasterFxInstances(instances);
    else context.audioEngine().setTrackFxInstances(targetId, instances);
  }

  const persistInstanceParams = async (targetId: string, instanceId: string, kind: AudioEffectKind, params: unknown) => {
    const projectId = context.projectId();
    if (!projectId) return;
    const input = objectParamInput(params);
    if (isLocalId("project", projectId)) {
      if (kind === "eq") await setLocalEffectInstance(projectId, targetId, localEffectForKind(targetId, kind), normalizeEqParams(input), { instanceId });
      else if (kind === "compressor") await setLocalEffectInstance(projectId, targetId, localEffectForKind(targetId, kind), normalizeCompressorParams(input), { instanceId });
      else if (kind === "saturator") await setLocalEffectInstance(projectId, targetId, localEffectForKind(targetId, kind), normalizeSaturatorParams(input), { instanceId });
      else if (kind === "delay") await setLocalEffectInstance(projectId, targetId, localEffectForKind(targetId, kind), normalizeDelayParams(input), { instanceId });
      else await setLocalEffectInstance(projectId, targetId, localEffectForKind(targetId, kind), normalizeReverbParams(input), { instanceId });
      return;
    }
    const userId = context.userId();
    if (!userId) return;
    if (targetId === "master") {
      if (kind === "eq") await publishEffectOperation(projectId, userId, { kind: "effects.setMasterEqParams", payload: { instanceId, params: normalizeEqParams(input) } });
      else if (kind === "compressor") await publishEffectOperation(projectId, userId, { kind: "effects.setMasterCompressorParams", payload: { instanceId, params: normalizeCompressorParams(input) } });
      else if (kind === "saturator") await publishEffectOperation(projectId, userId, { kind: "effects.setMasterSaturatorParams", payload: { instanceId, params: normalizeSaturatorParams(input) } });
      else if (kind === "delay") await publishEffectOperation(projectId, userId, { kind: "effects.setMasterDelayParams", payload: { instanceId, params: normalizeDelayParams(input) } });
      else await publishEffectOperation(projectId, userId, { kind: "effects.setMasterReverbParams", payload: { instanceId, params: normalizeReverbParams(input) } });
      return;
    }
    const track = resolveTrackByTargetId(targetId);
    if (!track) return;
    if (kind === "eq") await publishEffectOperation(projectId, userId, { kind: "effects.setEqParams", payload: { trackId: track.id, instanceId, params: normalizeEqParams(input) } });
    else if (kind === "compressor") await publishEffectOperation(projectId, userId, { kind: "effects.setCompressorParams", payload: { trackId: track.id, instanceId, params: normalizeCompressorParams(input) } });
    else if (kind === "saturator") await publishEffectOperation(projectId, userId, { kind: "effects.setSaturatorParams", payload: { trackId: track.id, instanceId, params: normalizeSaturatorParams(input) } });
    else if (kind === "delay") await publishEffectOperation(projectId, userId, { kind: "effects.setDelayParams", payload: { trackId: track.id, instanceId, params: normalizeDelayParams(input) } });
    else await publishEffectOperation(projectId, userId, { kind: "effects.setReverbParams", payload: { trackId: track.id, instanceId, params: normalizeReverbParams(input) } });
  };

  const updateInstance = (instanceId: string, kind: AudioEffectKind, updater: (prev: AudioEffectParams) => AudioEffectParams) => {
    if (!context.canWriteCurrentTargetEffects()) return;
    const targetId = currentTargetId();
    const current = paramsForInstance({ id: instanceId, kind }) ?? createDefaultParamsForKind(kind);
    const next = normalizeParamsForKind(kind, updater(current));
    if (areParamsForKindEqual(kind, current, next)) return;
    setDraftParamsByInstance((prev) => ({ ...prev, [instanceKey(targetId, instanceId)]: next }));
    commitInstanceParams(targetId, instanceId, kind, current, next);
    void persistInstanceParams(targetId, instanceId, kind, next).catch(() => undefined);
  };
  const updateEq = (updater: (prev: EqParams) => EqParams) => {
    const instance = orderedEffects().find((entry) => entry.kind === "eq");
    if (instance) updateInstance(instance.id, "eq", (prev) => updater(normalizeEqParams(prev)));
  };
  const updateReverb = (updater: (prev: ReverbParams) => ReverbParams) => {
    const instance = orderedEffects().find((entry) => entry.kind === "reverb");
    if (instance) updateInstance(instance.id, "reverb", (prev) => updater(normalizeReverbParams(prev)));
  };
  const updateCompressor = (updater: (prev: CompressorParams) => CompressorParams) => {
    const instance = orderedEffects().find((entry) => entry.kind === "compressor");
    if (instance) updateInstance(instance.id, "compressor", (prev) => updater(normalizeCompressorParams(prev)));
  };
  const updateSaturator = (updater: (prev: SaturatorParams) => SaturatorParams) => {
    const instance = orderedEffects().find((entry) => entry.kind === "saturator");
    if (instance) updateInstance(instance.id, "saturator", (prev) => updater(normalizeSaturatorParams(prev)));
  };
  const updateDelay = (updater: (prev: DelayParams) => DelayParams) => {
    const instance = orderedEffects().find((entry) => entry.kind === "delay");
    if (instance) updateInstance(instance.id, "delay", (prev) => updater(normalizeDelayParams(prev)));
  };
  const addEq = () => {
    if (!context.canWriteCurrentTargetEffects()) return;
    void addByKindToTarget(currentTargetId(), "eq");
  };
  const addReverb = () => {
    if (!context.canWriteCurrentTargetEffects()) return;
    void addByKindToTarget(currentTargetId(), "reverb");
  };
  const addCompressor = () => {
    if (!context.canWriteCurrentTargetEffects()) return;
    void addByKindToTarget(currentTargetId(), "compressor");
  };
  const addSaturator = () => {
    if (!context.canWriteCurrentTargetEffects()) return;
    void addByKindToTarget(currentTargetId(), "saturator");
  };
  const addDelay = () => {
    if (!context.canWriteCurrentTargetEffects()) return;
    void addByKindToTarget(currentTargetId(), "delay");
  };
  const addChainToTarget = async (
    targetId: Track["id"] | "master",
    effects: readonly AudioEffectChainPresetStep[],
    index?: number,
  ) => {
    if (effects.length === 0 || !effects.every((effect) => canAddByKindToTarget(targetId, effect.kind))) return false;
    const entries = effects.map((effect) => ({
      instance: { id: createAudioEffectInstanceId(), kind: effect.kind },
      params: normalizePresetStepParams(effect),
    }));
    const instances = entries.map((entry) => entry.instance);
    setDraftParamsByInstance((prev) => {
      let next = prev;
      for (const entry of entries) {
        next = { ...next, [instanceKey(targetId, entry.instance.id)]: entry.params };
      }
      return next;
    });
    const currentOrder = targetId === currentTargetId() ? orderedEffects() : readPersistedOrderedEffectsForTarget(targetId);
    const nextOrder = [...currentOrder];
    nextOrder.splice(index === undefined ? nextOrder.length : Math.max(0, Math.min(index, nextOrder.length)), 0, ...instances);
    setOptimisticOrder({ targetId, order: nextOrder });
    applyInstancesToEngine(targetId, nextOrder);
    for (const entry of entries) {
      await persistInstanceParams(targetId, entry.instance.id, entry.instance.kind, entry.params);
    }
    await persistReorder(targetId, nextOrder);
    return true;
  };
  const addByKindToTarget = async (targetId: Track["id"] | "master", effect: AudioEffectKind, index?: number) => (
    await addChainToTarget(targetId, [createDefaultPresetStep(effect)], index)
  );
  const canAddByKindToTarget = (_targetId: Track["id"] | "master", _effect: AudioEffectKind) => true;
  const deleteInstanceFromTarget = async (targetId: Track["id"] | "master", instance: AudioEffectInstance, projectId: string) => {
    const row = persistedRowsForTarget(targetId).find((entry) => (entry.instanceId ?? entry.kind) === instance.id && entry.kind === instance.kind);
    if (isLocalId("project", projectId)) {
      await deleteLocalEffectInstance(projectId, targetId, localEffectForKind(targetId, instance.kind), row?.instanceId);
      return true;
    }
    const userId = context.userId();
    if (!userId) return false;
    if (targetId === "master") {
      await publishEffectOperation(projectId, userId, { kind: "effects.removeAudioEffect", payload: { targetType: "master", effect: instance.kind, instanceId: row?.instanceId } });
      return true;
    }
    const track = resolveTrackByTargetId(targetId);
    if (!track) return false;
    await publishEffectOperation(projectId, userId, { kind: "effects.removeAudioEffect", payload: { targetType: "track", trackId: track.id, effect: instance.kind, instanceId: row?.instanceId } });
    return true;
  };
  const removeByInstanceFromTarget = async (targetId: Track["id"] | "master", instance: AudioEffectInstance) => {
    if (!context.canWriteCurrentTargetEffects()) return false;
    const currentOrder = targetId === currentTargetId() ? orderedEffects() : readPersistedOrderedEffectsForTarget(targetId);
    if (!currentOrder.some((entry) => entry.id === instance.id)) return false;
    const projectId = context.projectId();
    if (!projectId) return false;
    if (!(await deleteInstanceFromTarget(targetId, instance, projectId))) return false;
    const nextOrder = currentOrder.filter((entry) => entry.id !== instance.id);
    setOptimisticOrder({ targetId, order: nextOrder });
    applyInstancesToEngine(targetId, nextOrder);
    await persistReorder(targetId, nextOrder);
    return true;
  };
  const removeAllFromTarget = async (targetId: Track["id"] | "master") => {
    if (!context.canWriteCurrentTargetEffects()) return false;
    const currentOrder = targetId === currentTargetId() ? orderedEffects() : readPersistedOrderedEffectsForTarget(targetId);
    if (currentOrder.length === 0) return false;
    const projectId = context.projectId();
    if (!projectId) return false;
    const deleted = await Promise.all(currentOrder.map((instance) => deleteInstanceFromTarget(targetId, instance, projectId)));
    if (!deleted.every(Boolean)) return false;
    setOptimisticOrder({ targetId, order: [] });
    applyInstancesToEngine(targetId, []);
    await persistReorder(targetId, []);
    return true;
  };

  return {
    addByKindToTarget,
    addChainToTarget,
    canAddByKindToTarget,
    eq: {
      add: addEq,
      changeInstance: (instanceId, updater) => updateInstance(instanceId, "eq", (prev) => updater(normalizeEqParams(prev))),
      changeBand: (bandId, updates) => updateEq((prev) => ({
        ...prev,
        bands: prev.bands.map((band) => band.id === bandId ? { ...band, ...updates } : band),
      })),
      changeChannelMode: (channelMode) => updateEq((prev) => (
        prev.channelMode === channelMode ? prev : normalizeEqParams({ ...prev, channelMode })
      )),
      params: eqState.params,
      readDraftForTarget: eqState.readDraftForTarget,
      reset: () => updateEq(() => AUDIO_EFFECT_CONTRACTS.eq.createDefaultParams()),
      toggleBand: (bandId) => updateEq((prev) => ({
        ...prev,
        bands: prev.bands.map((band) => band.id === bandId ? { ...band, enabled: !band.enabled } : band),
      })),
      toggleEnabled: (enabled) => updateEq((prev) => ({ ...prev, enabled })),
    },
    flushPending: async () => {
      await Promise.all([eqState.flushPending(), compressorState.flushPending(), saturatorState.flushPending(), delayState.flushPending(), reverbState.flushPending()]);
    },
    orderedEffects,
    paramsForInstance,
    removeAllFromTarget,
    removeByInstanceFromTarget,
    reorder,
    compressor: {
      add: addCompressor,
      changeInstance: (instanceId, updater) => updateInstance(instanceId, "compressor", (prev) => updater(normalizeCompressorParams(prev))),
      change: (updates) => updateCompressor((prev) => normalizeCompressorParams({ ...prev, ...updates })),
      params: compressorState.params,
      readDraftForTarget: compressorState.readDraftForTarget,
      reset: () => updateCompressor(() => AUDIO_EFFECT_CONTRACTS.compressor.createDefaultParams()),
      toggleEnabled: (enabled) => updateCompressor((prev) => ({ ...prev, enabled })),
    },
    saturator: {
      add: addSaturator,
      changeInstance: (instanceId, updater) => updateInstance(instanceId, "saturator", (prev) => updater(normalizeSaturatorParams(prev))),
      change: (updates) => updateSaturator((prev) => normalizeSaturatorParams({ ...prev, ...updates })),
      params: saturatorState.params,
      readDraftForTarget: saturatorState.readDraftForTarget,
      reset: () => updateSaturator(() => AUDIO_EFFECT_CONTRACTS.saturator.createDefaultParams()),
      toggleEnabled: (enabled) => updateSaturator((prev) => ({ ...prev, enabled })),
    },
    delay: {
      add: addDelay,
      changeInstance: (instanceId, updater) => updateInstance(instanceId, "delay", (prev) => updater(normalizeDelayParams(prev))),
      change: (updates) => updateDelay((prev) => normalizeDelayParams({ ...prev, ...updates })),
      params: delayState.params,
      readDraftForTarget: delayState.readDraftForTarget,
      reset: () => updateDelay(() => AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams()),
      toggleEnabled: (enabled) => updateDelay((prev) => ({ ...prev, enabled })),
    },
    reverb: {
      add: addReverb,
      changeInstance: (instanceId, updater) => updateInstance(instanceId, "reverb", (prev) => updater(normalizeReverbParams(prev))),
      change: (updates) => updateReverb((prev) => normalizeReverbParams({ ...prev, ...updates })),
      params: reverbState.params,
      readDraftForTarget: reverbState.readDraftForTarget,
      reset: () => updateReverb(() => AUDIO_EFFECT_CONTRACTS.reverb.createDefaultParams()),
      toggleEnabled: (enabled) => updateReverb((prev) => ({ ...prev, enabled })),
    },
  };
}
