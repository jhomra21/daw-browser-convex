import { createEffect, createMemo, createSignal, type Accessor } from "solid-js";
import type { FunctionReturnType } from "convex/server";
import type { AudioEngine } from "@daw-browser/audio-engine/audio-engine";
import {
  AUDIO_EFFECT_CONTRACTS,
  AUDIO_EFFECT_ORDER,
  areAudioEffectOrdersEqual,
  normalizeAudioEffectOrder,
  normalizeCompressorParams,
  normalizeDelayParams,
  normalizeEqParams,
  normalizeReverbParams,
  normalizeSaturatorParams,
  type AudioEffectKind,
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
import { reorderLocalAudioEffects, type LocalEffectRow } from "~/lib/local-effects";
import type { SharedTimelineOperation } from "~/lib/shared-timeline-operations-api";
import { publishDurableSharedTimelineOperation } from "~/lib/shared-outbox";
import type { EffectParamsCommitPayload, EffectType } from "~/lib/undo/types";

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
    change: (updates: Partial<CompressorParams>) => void;
    params: Accessor<CompressorParams | undefined>;
    readDraftForTarget: (targetId: string) => CompressorParams | undefined;
    reset: () => void;
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
  addByKindToTarget: (targetId: Track["id"] | "master", effect: AudioEffectKind, index?: number) => Promise<boolean>;
  canAddByKindToTarget: (targetId: Track["id"] | "master", effect: AudioEffectKind) => boolean;
  flushPending: () => Promise<void>;
  orderedEffects: Accessor<AudioEffectKind[]>;
  removeAllFromTarget: (targetId: Track["id"] | "master") => Promise<boolean>;
  removeByKindFromTarget: (targetId: Track["id"] | "master", effect: AudioEffectKind) => Promise<boolean>;
  reorder: (effect: AudioEffectKind, targetIndex: number) => void;
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

  const [optimisticOrder, setOptimisticOrder] = createSignal<{ targetId: string; order: AudioEffectKind[] }>();

  function readPersistedOrderedEffectsForTarget(targetId: string): AudioEffectKind[] {
    const rowForKind = (kind: AudioEffectKind) => {
      if (!isLocalProject()) return remoteEffectForTarget(targetId, kind);
      if (kind === "eq") return localEq.row(targetId);
      if (kind === "compressor") return localCompressor.row(targetId);
      if (kind === "saturator") return localSaturator.row(targetId);
      if (kind === "delay") return localDelay.row(targetId);
      return localReverb.row(targetId);
    };
    return AUDIO_EFFECT_ORDER
      .flatMap((kind) => {
        const row = rowForKind(kind);
        const hasParams =
          (kind === "eq" && eqState.readForTarget(targetId))
          || (kind === "compressor" && compressorState.readForTarget(targetId))
          || (kind === "saturator" && saturatorState.readForTarget(targetId))
          || (kind === "delay" && delayState.readForTarget(targetId))
          || (kind === "reverb" && reverbState.readForTarget(targetId))
          || row?.params;
        if (!hasParams) return [];
        return [{ kind, index: row?.index }];
      })
      .sort(compareAudioEffectOrderEntries)
      .map((entry) => entry.kind);
  }

  const persistedOrderedEffects = createMemo<AudioEffectKind[]>(() => {
    const targetId = currentTargetId();
    return readPersistedOrderedEffectsForTarget(targetId);
  });

  const orderedEffects = createMemo<AudioEffectKind[]>(() => {
    const persistedOrder = persistedOrderedEffects();
    const optimistic = optimisticOrder();
    if (optimistic?.targetId !== currentTargetId()) return persistedOrder;
    return optimistic.order;
  });

  createEffect(() => {
    const optimistic = optimisticOrder();
    if (!optimistic || optimistic.targetId !== currentTargetId()) return;
    if (areAudioEffectOrdersEqual(optimistic.order, persistedOrderedEffects())) {
      setOptimisticOrder();
    }
  });

  createEffect(() => {
    const order = orderedEffects();
    const targetId = currentTargetId();
    if (targetId === "master") context.audioEngine().setMasterFxOrder(order);
    else context.audioEngine().setTrackFxOrder(targetId, order);
  });

  const persistReorder = async (targetId: string, order: AudioEffectKind[]) => {
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

  const reorder = (effect: AudioEffectKind, targetIndex: number) => {
    if (!context.canWriteCurrentTargetEffects()) return;
    reorderForTarget(currentTargetId(), effect, targetIndex);
  };

  const reorderForTarget = (targetId: string, effect: AudioEffectKind, targetIndex: number) => {
    const currentOrder = targetId === currentTargetId() ? orderedEffects() : readPersistedOrderedEffectsForTarget(targetId);
    const fromIndex = currentOrder.indexOf(effect);
    if (fromIndex < 0) return;
    const nextOrder = currentOrder.filter((kind) => kind !== effect);
    const clampedIndex = Math.max(0, Math.min(targetIndex, nextOrder.length));
    nextOrder.splice(clampedIndex, 0, effect);
    const normalized = normalizeAudioEffectOrder(nextOrder, currentOrder);
    if (areAudioEffectOrdersEqual(currentOrder, normalized)) return;
    setOptimisticOrder({ targetId, order: normalized });
    if (targetId === "master") context.audioEngine().setMasterFxOrder(normalized);
    else context.audioEngine().setTrackFxOrder(targetId, normalized);
    void persistReorder(targetId, normalized).catch(() => {
      const optimistic = optimisticOrder();
      if (optimistic?.targetId === targetId && areAudioEffectOrdersEqual(optimistic.order, normalized)) {
        setOptimisticOrder();
      }
    });
  };

  const updateEq = (updater: (prev: EqParams) => EqParams) => {
    if (!context.canWriteCurrentTargetEffects()) return;
    eqState.update(updater);
  };
  const updateReverb = (updater: (prev: ReverbParams) => ReverbParams) => {
    if (!context.canWriteCurrentTargetEffects()) return;
    reverbState.update(updater);
  };
  const updateCompressor = (updater: (prev: CompressorParams) => CompressorParams) => {
    if (!context.canWriteCurrentTargetEffects()) return;
    compressorState.update(updater);
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
  const addCompressor = () => {
    if (!context.canWriteCurrentTargetEffects()) return;
    compressorState.add();
  };
  const addSaturator = () => {
    if (!context.canWriteCurrentTargetEffects()) return;
    saturatorState.add();
  };
  const addDelay = () => {
    if (!context.canWriteCurrentTargetEffects()) return;
    delayState.add();
  };
  const stateForKind = (effect: AudioEffectKind) => {
    if (effect === "eq") return eqState;
    if (effect === "compressor") return compressorState;
    if (effect === "saturator") return saturatorState;
    if (effect === "delay") return delayState;
    return reverbState;
  };
  const localRowsForKind = (effect: AudioEffectKind) => {
    if (effect === "eq") return localEq;
    if (effect === "compressor") return localCompressor;
    if (effect === "saturator") return localSaturator;
    if (effect === "delay") return localDelay;
    return localReverb;
  };
  const hasPersistedLocalEffectForTarget = async (targetId: Track["id"] | "master", effect: AudioEffectKind) => {
    const projectId = context.projectId();
    if (!projectId || !isLocalId("project", projectId)) return false;
    const row = await localRowsForKind(effect).fetchRow(projectId, targetId);
    return row?.params !== undefined;
  };
  const addByKindToTarget = async (targetId: Track["id"] | "master", effect: AudioEffectKind, index?: number) => {
    if (!canAddByKindToTarget(targetId, effect)) return false;
    if (await hasPersistedLocalEffectForTarget(targetId, effect)) return false;
    const state = stateForKind(effect);
    state.addForTarget(targetId);
    if (index === undefined) return true;
    await state.flushPending();
    reorderForTarget(targetId, effect, index);
    return true;
  };
  const canAddByKindToTarget = (targetId: Track["id"] | "master", effect: AudioEffectKind) => {
    const currentOrder = targetId === currentTargetId() ? orderedEffects() : readPersistedOrderedEffectsForTarget(targetId);
    return !currentOrder.includes(effect);
  };
  const removeByKindFromTarget = async (targetId: Track["id"] | "master", effect: AudioEffectKind) => {
    if (!context.canWriteCurrentTargetEffects()) return false;
    const currentOrder = targetId === currentTargetId() ? orderedEffects() : readPersistedOrderedEffectsForTarget(targetId);
    if (!currentOrder.includes(effect)) return false;
    const state = stateForKind(effect);
    if (!state.removeForTarget(targetId)) return false;
    const nextOrder = currentOrder.filter((kind) => kind !== effect);
    setOptimisticOrder({ targetId, order: nextOrder });
    if (targetId === "master") context.audioEngine().setMasterFxOrder(nextOrder);
    else context.audioEngine().setTrackFxOrder(targetId, nextOrder);
    try {
      await state.flushPending();
    } catch (error) {
      const optimistic = optimisticOrder();
      if (optimistic?.targetId === targetId && areAudioEffectOrdersEqual(optimistic.order, nextOrder)) {
        setOptimisticOrder();
      }
      throw error;
    }
    return true;
  };
  const removeAllFromTarget = async (targetId: Track["id"] | "master") => {
    if (!context.canWriteCurrentTargetEffects()) return false;
    const currentOrder = targetId === currentTargetId() ? orderedEffects() : readPersistedOrderedEffectsForTarget(targetId);
    if (currentOrder.length === 0) return false;
    setOptimisticOrder({ targetId, order: [] });
    if (targetId === "master") context.audioEngine().setMasterFxOrder([]);
    else context.audioEngine().setTrackFxOrder(targetId, []);
    const removals = currentOrder.map((effect) => stateForKind(effect).removeForTarget(targetId));
    try {
      await Promise.all([
        eqState.flushPending(),
        compressorState.flushPending(),
        saturatorState.flushPending(),
        delayState.flushPending(),
        reverbState.flushPending(),
      ]);
    } catch (error) {
      const optimistic = optimisticOrder();
      if (optimistic?.targetId === targetId && optimistic.order.length === 0) {
        setOptimisticOrder();
      }
      throw error;
    }
    return removals.some(Boolean);
  };

  return {
    addByKindToTarget,
    canAddByKindToTarget,
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
    removeAllFromTarget,
    removeByKindFromTarget,
    reorder,
    compressor: {
      add: addCompressor,
      change: (updates) => updateCompressor((prev) => normalizeCompressorParams({ ...prev, ...updates })),
      params: compressorState.params,
      readDraftForTarget: compressorState.readDraftForTarget,
      reset: () => updateCompressor(() => AUDIO_EFFECT_CONTRACTS.compressor.createDefaultParams()),
      toggleEnabled: (enabled) => updateCompressor((prev) => ({ ...prev, enabled })),
    },
    saturator: {
      add: addSaturator,
      change: (updates) => updateSaturator((prev) => normalizeSaturatorParams({ ...prev, ...updates })),
      params: saturatorState.params,
      readDraftForTarget: saturatorState.readDraftForTarget,
      reset: () => updateSaturator(() => AUDIO_EFFECT_CONTRACTS.saturator.createDefaultParams()),
      toggleEnabled: (enabled) => updateSaturator((prev) => ({ ...prev, enabled })),
    },
    delay: {
      add: addDelay,
      change: (updates) => updateDelay((prev) => normalizeDelayParams({ ...prev, ...updates })),
      params: delayState.params,
      readDraftForTarget: delayState.readDraftForTarget,
      reset: () => updateDelay(() => AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams()),
      toggleEnabled: (enabled) => updateDelay((prev) => ({ ...prev, enabled })),
    },
    reverb: {
      add: addReverb,
      change: (updates) => updateReverb((prev) => normalizeReverbParams({ ...prev, ...updates })),
      params: reverbState.params,
      readDraftForTarget: reverbState.readDraftForTarget,
      reset: () => updateReverb(() => AUDIO_EFFECT_CONTRACTS.reverb.createDefaultParams()),
      toggleEnabled: (enabled) => updateReverb((prev) => ({ ...prev, enabled })),
    },
  };
}
