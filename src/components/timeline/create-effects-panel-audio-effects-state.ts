import { createEffect, createMemo, createSignal, onCleanup, untrack, type Accessor } from "solid-js";
import type { FunctionReturnType } from "convex/server";
import type { AudioEffectRuntimeInstance, AudioEngine } from "@daw-browser/audio-engine/audio-engine";
import {
  AUDIO_EFFECT_CONTRACTS,
  AUDIO_EFFECT_ORDER,
  areAudioEffectInstanceOrdersEqual,
  normalizeAudioEffectInstanceOrder,
  normalizeCompressorParams,
  normalizeDelayParams,
  normalizeEqParams,
  normalizeReverbParams,
  normalizeSaturatorParams,
  normalizeGateParamsEnvelope,
  normalizeUtilityParamsEnvelope,
  type AudioEffectKind,
  type AutoFilterParamsEnvelope,
  type AutoPanParamsEnvelope,
  type AudioEffectInstance,
  type ChorusParamsEnvelope,
  type CompressorParams,
  type DelayParams,
  type EqChannelMode,
  type EqParams,
  type ReverbParams,
  type SaturatorParams,
  type SpectralParamsEnvelope,
  type GateParamsEnvelope,
  type EnsembleParamsEnvelope,
  type FlangerParamsEnvelope,
  type LimiterParamsEnvelope,
  type LoFiParamsEnvelope,
  type PhaserParamsEnvelope,
  type TremoloParamsEnvelope,
  type UtilityParamsEnvelope,isLocalId
} from "@daw-browser/shared";
import type { ExternalSidechainRoute, Track } from "@daw-browser/timeline-core/types";
import { createLocalEffectRows } from "~/components/timeline/create-local-effect-rows";
import { createPersistedEffectState } from "~/components/timeline/create-persisted-effect-state";
import {
  EFFECT_PANEL_LOCAL_EDIT_SUPPRESS_MS,
  EFFECT_PANEL_SAVE_DEBOUNCE_MS,
} from "~/components/timeline/create-effects-panel-state";
import type { convexApi } from "~/lib/convex";
import { compareAudioEffectOrderEntries } from "~/lib/audio-effect-order-rows";
import { createAudioEffectInstanceId, deleteLocalEffectInstance, listLocalEffects, reorderLocalAudioEffects, setLocalEffectInstance, type LocalEffectKind, type LocalEffectRow } from "~/lib/local-effects";
import { subscribeToLocalProjectChanges } from "~/lib/local-project-changes";
import type { SharedTimelineOperation } from "~/lib/shared-timeline-operations-api";
import { publishDurableSharedTimelineOperation } from "~/lib/shared-outbox";
import type { EffectParamsByEffect, EffectParamsCommitPayload, EffectType } from "~/lib/undo/types";
import type { AudioEffectChainPresetStep } from "~/lib/audio-effect-chain-presets";
import { createLocalTimelineRepository } from "~/lib/timeline-repository/local-timeline-repository";
import type { ExportEffectRow, ExportEffectsProjection } from "~/lib/export/export-effect-rows";

type RoomEffectRow = FunctionReturnType<typeof convexApi.effects.listByRoom>[number];
type PersistedAudioEffectDescriptor<Params> = {
  kind: AudioEffectKind;
  createDefaultParams: () => Params;
  normalizeParams: (params: Params) => Params;
  serializeParams: (params: Params) => string;
  row: (targetId: string) => LocalEffectRow<Params> | undefined;
  instanceId: (targetId: string) => string | undefined;
  persistLocal: (projectId: string, targetId: string, params: Params, instanceId: string) => Promise<void>;
  removeLocal: (projectId: string, targetId: string, instanceId: string) => Promise<void>;
  publishTrackParams: (projectId: string, userId: string, trackId: string, params: Params, instanceId: string) => Promise<unknown>;
  publishMasterParams: (projectId: string, userId: string, params: Params, instanceId: string) => Promise<unknown>;
  commitTrackParams: (trackId: string, instanceId: string, previous: Params, next: Params, projectId?: string) => void;
  commitMasterParams: (instanceId: string, previous: Params, next: Params, projectId?: string) => void;
};

type EffectsPanelAudioEffectsContext = {
  audioEngine: Accessor<AudioEngine>;
  projectId: Accessor<string | undefined>;
  userId: Accessor<string | undefined>;
  roomEffects: Accessor<RoomEffectRow[] | undefined>;
  sidechainRoutes?: Accessor<ExternalSidechainRoute[]>;
  persistSidechainRoute?: (targetTrackId: string, effectInstanceId: string, sourceTrackId?: string) => Promise<unknown>;
  canWriteCurrentTargetEffects: Accessor<boolean>;
  usesLegacyAudioEngine?: Accessor<boolean>;
  projectGeneration?: Accessor<number>;
  onEffectParamsPreview?: (payload: EffectParamsCommitPayload<"eq" | "master-eq">) => void | Promise<void>;
  onEffectParamsFlush?: (payload: EffectParamsCommitPayload<"eq" | "master-eq">) => void | Promise<void>;
  persistAudioEffectOrder?: (targetId: string, order: AudioEffectInstance[]) => void | Promise<unknown>;
  onEffectParamsCommitted?: <Effect extends EffectType>(payload: EffectParamsCommitPayload<Effect>, projectId?: string) => void;
  onLocalSaveFailed?: (message: string) => void;
};

type EffectsPanelAudioDevice = {
  utility: {
    changeInstance: (instanceId: string, updates: (params: UtilityParamsEnvelope) => UtilityParamsEnvelope) => void;
  };
  gate: {
    changeInstance: (instanceId: string, updates: (params: GateParamsEnvelope) => GateParamsEnvelope) => void;
    setSidechainSource: (instanceId: string, sourceTrackId?: string) => Promise<void>;
  };
  limiter: {
    changeInstance: (instanceId: string, updates: (params: LimiterParamsEnvelope) => LimiterParamsEnvelope) => void;
  };
  lofi: { changeInstance: (instanceId: string, updates: (params: LoFiParamsEnvelope) => LoFiParamsEnvelope) => void };
  autofilter: { changeInstance: (instanceId: string, updates: (params: AutoFilterParamsEnvelope) => AutoFilterParamsEnvelope) => void };
  chorus: { changeInstance: (instanceId: string, updates: (params: ChorusParamsEnvelope) => ChorusParamsEnvelope) => void };
  flanger: { changeInstance: (instanceId: string, updates: (params: FlangerParamsEnvelope) => FlangerParamsEnvelope) => void };
  phaser: { changeInstance: (instanceId: string, updates: (params: PhaserParamsEnvelope) => PhaserParamsEnvelope) => void };
  tremolo: { changeInstance: (instanceId: string, updates: (params: TremoloParamsEnvelope) => TremoloParamsEnvelope) => void };
  autopan: { changeInstance: (instanceId: string, updates: (params: AutoPanParamsEnvelope) => AutoPanParamsEnvelope) => void };
  ensemble: { changeInstance: (instanceId: string, updates: (params: EnsembleParamsEnvelope) => EnsembleParamsEnvelope) => void };
  eq: {
    add: () => void;
    changeInstance: (instanceId: string, updates: (params: EqParams) => EqParams) => void;
    beginInteraction: (instanceId: string) => void;
    previewInteraction: (instanceId: string, updater: (params: EqParams) => EqParams) => void;
    commitInteraction: (instanceId: string) => void;
    cancelInteraction: (instanceId: string) => void;
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
  spectral: {
    changeInstance: (instanceId: string, updates: (params: SpectralParamsEnvelope) => SpectralParamsEnvelope) => void;
    setSidechainSource: (instanceId: string, sourceTrackId?: string) => Promise<void>;
  };
  addByKindToTarget: (targetId: Track["id"] | "master", effect: AudioEffectKind, index?: number) => Promise<boolean>;
  addChainToTarget: (targetId: Track["id"] | "master", effects: readonly AudioEffectChainPresetStep[], index?: number) => Promise<boolean>;
  canAddByKindToTarget: (targetId: Track["id"] | "master", effect: AudioEffectKind) => boolean;
  snapshotExportProjection: () => ExportEffectsProjection;
  snapshotExportRows: (targetIds: readonly string[]) => ExportEffectRow[];
  snapshotSidechainRoutes: () => ExternalSidechainRoute[];
  flushPending: () => Promise<void>;
  paramsForInstance: (instance: AudioEffectInstance) => UtilityParamsEnvelope | AutoFilterParamsEnvelope | EqParams | GateParamsEnvelope | LimiterParamsEnvelope | LoFiParamsEnvelope | CompressorParams | SaturatorParams | DelayParams | ReverbParams | SpectralParamsEnvelope | ChorusParamsEnvelope | FlangerParamsEnvelope | PhaserParamsEnvelope | TremoloParamsEnvelope | AutoPanParamsEnvelope | EnsembleParamsEnvelope | undefined;
  orderedEffects: Accessor<AudioEffectInstance[]>;
  effectIndexForTarget: (targetId: string, instanceId: string) => number | undefined;
  removeAllFromTarget: (targetId: Track["id"] | "master") => Promise<boolean>;
  removeByInstanceFromTarget: (targetId: Track["id"] | "master", instance: AudioEffectInstance) => Promise<boolean>;
  replayInstanceParams: <Effect extends EffectType>(payload: {
    targetId: string;
    effect: Effect;
    instanceId: string;
    params: EffectParamsByEffect[Effect];
  }) => boolean;
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

export const createAudioEffectInstanceIdentityCache = () => {
  const cache = new Map<string, AudioEffectInstance>();
  return {
    get: (targetId: string, id: string, kind: AudioEffectKind) => {
      const key = `${targetId}:${id}`;
      const cached = cache.get(key);
      if (cached?.kind === kind) return cached;
      const instance = { id, kind };
      cache.set(key, instance);
      return instance;
    },
    prune: (reachableKeys: ReadonlySet<string>) => {
      for (const key of cache.keys()) {
        if (!reachableKeys.has(key)) cache.delete(key);
      }
    },
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
    applyToEngine: (targetId) => (
      (context.usesLegacyAudioEngine?.() ?? true)
        ? applyInstancesToEngine(targetId, currentOrderForTarget(targetId))
        : undefined
    ),
    readQueryParams: (row) => row?.params ? descriptor.normalizeParams(row.params) : undefined,
    createInitialParams: () => descriptor.createDefaultParams(),
    serializeParams: descriptor.serializeParams,
    createPersistContext: () => ({ projectId: context.projectId(), userId: context.userId() }),
    persistParams: (targetId, params, persistContext) => {
      if (!persistContext.projectId) return Promise.resolve();
      const instanceId = descriptor.instanceId(targetId);
      if (!instanceId) return Promise.resolve();
      if (isLocalId("project", persistContext.projectId)) return descriptor.persistLocal(persistContext.projectId, targetId, params, instanceId);
      if (!persistContext.userId) return Promise.resolve();
      const normalizedParams = descriptor.normalizeParams(params);
      if (targetId === "master") {
        return descriptor.publishMasterParams(persistContext.projectId, persistContext.userId, normalizedParams, instanceId);
      }
      const track = resolveTrackByTargetId(targetId);
      if (!track) return Promise.resolve();
      return descriptor.publishTrackParams(persistContext.projectId, persistContext.userId, track.id, normalizedParams, instanceId);
    },
    persistRemove: (targetId, persistContext) => {
      if (!persistContext.projectId) return Promise.resolve();
      const instanceId = descriptor.instanceId(targetId);
      if (!instanceId) return Promise.resolve();
      if (isLocalId("project", persistContext.projectId)) return descriptor.removeLocal(persistContext.projectId, targetId, instanceId);
      if (!persistContext.userId) return Promise.resolve();
      if (targetId === "master") {
        return publishEffectOperation(persistContext.projectId, persistContext.userId, {
          kind: "effects.removeAudioEffect",
          payload: { targetType: "master", effect: descriptor.kind, instanceId },
        });
      }
      const track = resolveTrackByTargetId(targetId);
      if (!track) return Promise.resolve();
      return publishEffectOperation(persistContext.projectId, persistContext.userId, {
        kind: "effects.removeAudioEffect",
        payload: { targetType: "track", trackId: track.id, effect: descriptor.kind, instanceId },
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
      const instanceId = descriptor.instanceId(targetId);
      if (!instanceId) return;
      if (targetId === "master") {
        descriptor.commitMasterParams(instanceId, previous, next, persistContext.projectId);
        return;
      }
      const track = resolveTrackByTargetId(targetId);
      if (!track) return;
      descriptor.commitTrackParams(track.id, instanceId, previous, next, persistContext.projectId);
    },
  });
  }

  const eqState = createAudioEffectState<EqParams>({
    kind: AUDIO_EFFECT_CONTRACTS.eq.kind,
    createDefaultParams: AUDIO_EFFECT_CONTRACTS.eq.createDefaultParams,
    normalizeParams: AUDIO_EFFECT_CONTRACTS.eq.normalizeParams,
    serializeParams: AUDIO_EFFECT_CONTRACTS.eq.serializeParams,
    row: localEq.row,
    instanceId: (targetId) => isLocalProject() ? localEq.row(targetId)?.instanceId : remoteEffectForTarget(targetId, "eq")?.instanceId,
    persistLocal: localEq.persist,
    removeLocal: localEq.remove,
    publishTrackParams: (projectId, userId, trackId, params, instanceId) => publishEffectOperation(projectId, userId, {
      kind: "effects.setEqParams",
      payload: { trackId, params, instanceId },
    }),
    publishMasterParams: (projectId, userId, params, instanceId) => publishEffectOperation(projectId, userId, {
      kind: "effects.setMasterEqParams",
      payload: { params, instanceId },
    }),
    commitTrackParams: (trackId, instanceId, previous, next, projectId) => context.onEffectParamsCommitted?.({ targetId: trackId, effect: "eq", instanceId, from: previous, to: next }, projectId),
    commitMasterParams: (instanceId, previous, next, projectId) => context.onEffectParamsCommitted?.({ targetId: "master", effect: "master-eq", instanceId, from: previous, to: next }, projectId),
  });

  const reverbState = createAudioEffectState<ReverbParams>({
    kind: AUDIO_EFFECT_CONTRACTS.reverb.kind,
    createDefaultParams: AUDIO_EFFECT_CONTRACTS.reverb.createDefaultParams,
    normalizeParams: AUDIO_EFFECT_CONTRACTS.reverb.normalizeParams,
    serializeParams: AUDIO_EFFECT_CONTRACTS.reverb.serializeParams,
    row: localReverb.row,
    instanceId: (targetId) => isLocalProject() ? localReverb.row(targetId)?.instanceId : remoteEffectForTarget(targetId, "reverb")?.instanceId,
    persistLocal: localReverb.persist,
    removeLocal: localReverb.remove,
    publishTrackParams: (projectId, userId, trackId, params, instanceId) => publishEffectOperation(projectId, userId, {
      kind: "effects.setReverbParams",
      payload: { trackId, params, instanceId },
    }),
    publishMasterParams: (projectId, userId, params, instanceId) => publishEffectOperation(projectId, userId, {
      kind: "effects.setMasterReverbParams",
      payload: { params, instanceId },
    }),
    commitTrackParams: (trackId, instanceId, previous, next, projectId) => context.onEffectParamsCommitted?.({ targetId: trackId, effect: "reverb", instanceId, from: previous, to: next }, projectId),
    commitMasterParams: (instanceId, previous, next, projectId) => context.onEffectParamsCommitted?.({ targetId: "master", effect: "master-reverb", instanceId, from: previous, to: next }, projectId),
  });

  const compressorState = createAudioEffectState<CompressorParams>({
    kind: AUDIO_EFFECT_CONTRACTS.compressor.kind,
    createDefaultParams: AUDIO_EFFECT_CONTRACTS.compressor.createDefaultParams,
    normalizeParams: AUDIO_EFFECT_CONTRACTS.compressor.normalizeParams,
    serializeParams: AUDIO_EFFECT_CONTRACTS.compressor.serializeParams,
    row: localCompressor.row,
    instanceId: (targetId) => isLocalProject() ? localCompressor.row(targetId)?.instanceId : remoteEffectForTarget(targetId, "compressor")?.instanceId,
    persistLocal: localCompressor.persist,
    removeLocal: localCompressor.remove,
    publishTrackParams: (projectId, userId, trackId, params, instanceId) => publishEffectOperation(projectId, userId, {
      kind: "effects.setCompressorParams",
      payload: { trackId, params, instanceId },
    }),
    publishMasterParams: (projectId, userId, params, instanceId) => publishEffectOperation(projectId, userId, {
      kind: "effects.setMasterCompressorParams",
      payload: { params, instanceId },
    }),
    commitTrackParams: (trackId, instanceId, previous, next, projectId) => context.onEffectParamsCommitted?.({ targetId: trackId, effect: "compressor", instanceId, from: previous, to: next }, projectId),
    commitMasterParams: (instanceId, previous, next, projectId) => context.onEffectParamsCommitted?.({ targetId: "master", effect: "master-compressor", instanceId, from: previous, to: next }, projectId),
  });

  const saturatorState = createAudioEffectState<SaturatorParams>({
    kind: AUDIO_EFFECT_CONTRACTS.saturator.kind,
    createDefaultParams: AUDIO_EFFECT_CONTRACTS.saturator.createDefaultParams,
    normalizeParams: AUDIO_EFFECT_CONTRACTS.saturator.normalizeParams,
    serializeParams: AUDIO_EFFECT_CONTRACTS.saturator.serializeParams,
    row: localSaturator.row,
    instanceId: (targetId) => isLocalProject() ? localSaturator.row(targetId)?.instanceId : remoteEffectForTarget(targetId, "saturator")?.instanceId,
    persistLocal: localSaturator.persist,
    removeLocal: localSaturator.remove,
    publishTrackParams: (projectId, userId, trackId, params, instanceId) => publishEffectOperation(projectId, userId, {
      kind: "effects.setSaturatorParams",
      payload: { trackId, params, instanceId },
    }),
    publishMasterParams: (projectId, userId, params, instanceId) => publishEffectOperation(projectId, userId, {
      kind: "effects.setMasterSaturatorParams",
      payload: { params, instanceId },
    }),
    commitTrackParams: (trackId, instanceId, previous, next, projectId) => context.onEffectParamsCommitted?.({ targetId: trackId, effect: "saturator", instanceId, from: previous, to: next }, projectId),
    commitMasterParams: (instanceId, previous, next, projectId) => context.onEffectParamsCommitted?.({ targetId: "master", effect: "master-saturator", instanceId, from: previous, to: next }, projectId),
  });

  const delayState = createAudioEffectState<DelayParams>({
    kind: AUDIO_EFFECT_CONTRACTS.delay.kind,
    createDefaultParams: AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams,
    normalizeParams: AUDIO_EFFECT_CONTRACTS.delay.normalizeParams,
    serializeParams: AUDIO_EFFECT_CONTRACTS.delay.serializeParams,
    row: localDelay.row,
    instanceId: (targetId) => isLocalProject() ? localDelay.row(targetId)?.instanceId : remoteEffectForTarget(targetId, "delay")?.instanceId,
    persistLocal: localDelay.persist,
    removeLocal: localDelay.remove,
    publishTrackParams: (projectId, userId, trackId, params, instanceId) => publishEffectOperation(projectId, userId, {
      kind: "effects.setDelayParams",
      payload: { trackId, params, instanceId },
    }),
    publishMasterParams: (projectId, userId, params, instanceId) => publishEffectOperation(projectId, userId, {
      kind: "effects.setMasterDelayParams",
      payload: { params, instanceId },
    }),
    commitTrackParams: (trackId, instanceId, previous, next, projectId) => context.onEffectParamsCommitted?.({ targetId: trackId, effect: "delay", instanceId, from: previous, to: next }, projectId),
    commitMasterParams: (instanceId, previous, next, projectId) => context.onEffectParamsCommitted?.({ targetId: "master", effect: "master-delay", instanceId, from: previous, to: next }, projectId),
  });

  type AudioEffectParams = UtilityParamsEnvelope | AutoFilterParamsEnvelope | EqParams | GateParamsEnvelope | LimiterParamsEnvelope | LoFiParamsEnvelope | CompressorParams | SaturatorParams | DelayParams | ReverbParams | SpectralParamsEnvelope | ChorusParamsEnvelope | FlangerParamsEnvelope | PhaserParamsEnvelope | TremoloParamsEnvelope | AutoPanParamsEnvelope | EnsembleParamsEnvelope;
  type AudioEffectPanelRow = {
    targetId: string;
    kind: AudioEffectKind;
    instanceId?: string;
    index?: number;
    params: AudioEffectParams;
  };
  type AudioEffectPanelDraft = {
    targetId: string;
    instanceId: string;
    kind: AudioEffectKind;
    params: AudioEffectParams;
  };
  const [draftParamsByInstance, setDraftParamsByInstance] = createSignal<Record<string, AudioEffectPanelDraft | undefined>>({});
  const [optimisticOrder, setOptimisticOrder] = createSignal<{ targetId: string; order: AudioEffectInstance[] } | undefined>(undefined, { equals: false });
  const optimisticOrdersByTarget = new Map<string, AudioEffectInstance[]>();
  type SidechainPatch = { attempt: number; targetTrackId: string; effectInstanceId: string; sourceTrackId?: string };
  const sidechainPatches = new Map<string, SidechainPatch>();
  const pendingSidechainWrites = new Set<Promise<void>>();
  let sidechainAttempt = 0;

  const objectParamInput = (params: unknown): object => (params && typeof params === "object" ? params : {});

  const normalizeParamsForKind = (kind: AudioEffectKind, params: unknown): AudioEffectParams => {
    const input = objectParamInput(params);
    if (kind === "utility") return normalizeUtilityParamsEnvelope(input);
    if (kind === "autofilter") return AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams(input);
    if (kind === "gate") return normalizeGateParamsEnvelope(input);
    if (kind === "limiter") return AUDIO_EFFECT_CONTRACTS.limiter.normalizeParams(input);
    if (kind === "eq") return AUDIO_EFFECT_CONTRACTS.eq.normalizeParams(input);
    if (kind === "compressor") return AUDIO_EFFECT_CONTRACTS.compressor.normalizeParams(input);
    if (kind === "saturator") return AUDIO_EFFECT_CONTRACTS.saturator.normalizeParams(input);
    if (kind === "delay") return AUDIO_EFFECT_CONTRACTS.delay.normalizeParams(input);
    if (kind === "reverb") return AUDIO_EFFECT_CONTRACTS.reverb.normalizeParams(input);
    if (kind === "spectral") return AUDIO_EFFECT_CONTRACTS.spectral.normalizeParams(input);
    return AUDIO_EFFECT_CONTRACTS[kind].normalizeParams(input);
  };
  const audioEffectKindForHistoryEffect = (effect: EffectType): AudioEffectKind | undefined => {
    if (effect === "utility" || effect === "master-utility") return "utility";
    if (effect === "autofilter" || effect === "master-autofilter") return "autofilter";
    if (effect === "gate" || effect === "master-gate") return "gate";
    if (effect === "limiter" || effect === "master-limiter") return "limiter";
    if (effect === "eq" || effect === "master-eq") return "eq";
    if (effect === "compressor" || effect === "master-compressor") return "compressor";
    if (effect === "saturator" || effect === "master-saturator") return "saturator";
    if (effect === "delay" || effect === "master-delay") return "delay";
    if (effect === "reverb" || effect === "master-reverb") return "reverb";
    if (effect === "spectral" || effect === "master-spectral") return "spectral";
    if (effect === "chorus" || effect === "master-chorus") return "chorus";
    if (effect === "flanger" || effect === "master-flanger") return "flanger";
    if (effect === "phaser" || effect === "master-phaser") return "phaser";
    if (effect === "tremolo" || effect === "master-tremolo") return "tremolo";
    if (effect === "autopan" || effect === "master-autopan") return "autopan";
    if (effect === "ensemble" || effect === "master-ensemble") return "ensemble";
    if (effect === "lofi" || effect === "master-lofi") return "lofi";
    return undefined;
  };

  const createDefaultParamsForKind = (kind: AudioEffectKind): AudioEffectParams => {
    if (kind === "utility") return AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams();
    if (kind === "autofilter") return AUDIO_EFFECT_CONTRACTS.autofilter.createDefaultParams();
    if (kind === "gate") return AUDIO_EFFECT_CONTRACTS.gate.createDefaultParams();
    if (kind === "limiter") return AUDIO_EFFECT_CONTRACTS.limiter.createDefaultParams();
    if (kind === "eq") return AUDIO_EFFECT_CONTRACTS.eq.createDefaultParams();
    if (kind === "compressor") return AUDIO_EFFECT_CONTRACTS.compressor.createDefaultParams();
    if (kind === "saturator") return AUDIO_EFFECT_CONTRACTS.saturator.createDefaultParams();
    if (kind === "delay") return AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams();
    if (kind === "reverb") return AUDIO_EFFECT_CONTRACTS.reverb.createDefaultParams();
    if (kind === "spectral") return AUDIO_EFFECT_CONTRACTS.spectral.createDefaultParams();
    if (kind === "chorus") return AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams({});
    if (kind === "flanger") return AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams({});
    if (kind === "phaser") return AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams({});
    if (kind === "tremolo") return AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams({});
    if (kind === "autopan") return AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams({});
    if (kind === "lofi") return AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams({});
    return AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams({});
  };

  const areParamsForKindEqual = (kind: AudioEffectKind, previous: AudioEffectParams, next: AudioEffectParams) => {
    if (kind === "utility") return AUDIO_EFFECT_CONTRACTS.utility.serializeParams(normalizeUtilityParamsEnvelope(previous)) === AUDIO_EFFECT_CONTRACTS.utility.serializeParams(normalizeUtilityParamsEnvelope(next));
    if (kind === "autofilter") return AUDIO_EFFECT_CONTRACTS.autofilter.serializeParams(AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams(previous)) === AUDIO_EFFECT_CONTRACTS.autofilter.serializeParams(AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams(next));
    if (kind === "limiter") return AUDIO_EFFECT_CONTRACTS.limiter.serializeParams(AUDIO_EFFECT_CONTRACTS.limiter.normalizeParams(previous)) === AUDIO_EFFECT_CONTRACTS.limiter.serializeParams(AUDIO_EFFECT_CONTRACTS.limiter.normalizeParams(next));
    if (kind === "gate") return AUDIO_EFFECT_CONTRACTS.gate.serializeParams(normalizeGateParamsEnvelope(previous)) === AUDIO_EFFECT_CONTRACTS.gate.serializeParams(normalizeGateParamsEnvelope(next));
    if (kind === "eq") return AUDIO_EFFECT_CONTRACTS.eq.serializeParams(normalizeEqParams(objectParamInput(previous))) === AUDIO_EFFECT_CONTRACTS.eq.serializeParams(normalizeEqParams(objectParamInput(next)));
    if (kind === "compressor") return AUDIO_EFFECT_CONTRACTS.compressor.serializeParams(normalizeCompressorParams(objectParamInput(previous))) === AUDIO_EFFECT_CONTRACTS.compressor.serializeParams(normalizeCompressorParams(objectParamInput(next)));
    if (kind === "saturator") return AUDIO_EFFECT_CONTRACTS.saturator.serializeParams(normalizeSaturatorParams(objectParamInput(previous))) === AUDIO_EFFECT_CONTRACTS.saturator.serializeParams(normalizeSaturatorParams(objectParamInput(next)));
    if (kind === "delay") return AUDIO_EFFECT_CONTRACTS.delay.serializeParams(normalizeDelayParams(objectParamInput(previous))) === AUDIO_EFFECT_CONTRACTS.delay.serializeParams(normalizeDelayParams(objectParamInput(next)));
    if (kind === "reverb") return AUDIO_EFFECT_CONTRACTS.reverb.serializeParams(normalizeReverbParams(objectParamInput(previous))) === AUDIO_EFFECT_CONTRACTS.reverb.serializeParams(normalizeReverbParams(objectParamInput(next)));
    if (kind === "spectral") return AUDIO_EFFECT_CONTRACTS.spectral.serializeParams(AUDIO_EFFECT_CONTRACTS.spectral.normalizeParams(previous)) === AUDIO_EFFECT_CONTRACTS.spectral.serializeParams(AUDIO_EFFECT_CONTRACTS.spectral.normalizeParams(next));
    if (kind === "chorus") return AUDIO_EFFECT_CONTRACTS.chorus.serializeParams(AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams(previous)) === AUDIO_EFFECT_CONTRACTS.chorus.serializeParams(AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams(next));
    if (kind === "flanger") return AUDIO_EFFECT_CONTRACTS.flanger.serializeParams(AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams(previous)) === AUDIO_EFFECT_CONTRACTS.flanger.serializeParams(AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams(next));
    if (kind === "phaser") return AUDIO_EFFECT_CONTRACTS.phaser.serializeParams(AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams(previous)) === AUDIO_EFFECT_CONTRACTS.phaser.serializeParams(AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams(next));
    if (kind === "tremolo") return AUDIO_EFFECT_CONTRACTS.tremolo.serializeParams(AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams(previous)) === AUDIO_EFFECT_CONTRACTS.tremolo.serializeParams(AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams(next));
    if (kind === "autopan") return AUDIO_EFFECT_CONTRACTS.autopan.serializeParams(AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams(previous)) === AUDIO_EFFECT_CONTRACTS.autopan.serializeParams(AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams(next));
    if (kind === "lofi") return AUDIO_EFFECT_CONTRACTS.lofi.serializeParams(AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams(previous)) === AUDIO_EFFECT_CONTRACTS.lofi.serializeParams(AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams(next));
    return AUDIO_EFFECT_CONTRACTS.ensemble.serializeParams(AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams(previous)) === AUDIO_EFFECT_CONTRACTS.ensemble.serializeParams(AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams(next));
  };

  const normalizePresetStepParams = (step: AudioEffectChainPresetStep): AudioEffectParams => {
    if (step.kind === "utility") return normalizeUtilityParamsEnvelope(step.params);
    if (step.kind === "autofilter") return AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams(step.params);
    if (step.kind === "gate") return normalizeGateParamsEnvelope(step.params);
    if (step.kind === "limiter") return AUDIO_EFFECT_CONTRACTS.limiter.normalizeParams(step.params);
    if (step.kind === "eq") return normalizeEqParams(step.params);
    if (step.kind === "compressor") return normalizeCompressorParams(step.params);
    if (step.kind === "saturator") return normalizeSaturatorParams(step.params);
    if (step.kind === "delay") return normalizeDelayParams(step.params);
    if (step.kind === "reverb") return normalizeReverbParams(step.params);
    if (step.kind === "spectral") return AUDIO_EFFECT_CONTRACTS.spectral.normalizeParams(step.params);
    if (step.kind === "chorus") return AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams(step.params);
    if (step.kind === "flanger") return AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams(step.params);
    if (step.kind === "phaser") return AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams(step.params);
    if (step.kind === "tremolo") return AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams(step.params);
    if (step.kind === "autopan") return AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams(step.params);
    if (step.kind === "lofi") return AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams(step.params);
    return AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams(step.params);
  };

  const createDefaultPresetStep = (kind: AudioEffectKind): AudioEffectChainPresetStep => {
    if (kind === "utility") return { kind, params: AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams() };
    if (kind === "autofilter") return { kind, params: AUDIO_EFFECT_CONTRACTS.autofilter.createDefaultParams() };
    if (kind === "gate") return { kind, params: AUDIO_EFFECT_CONTRACTS.gate.createDefaultParams() };
    if (kind === "limiter") return { kind, params: AUDIO_EFFECT_CONTRACTS.limiter.createDefaultParams() };
    if (kind === "eq") return { kind, params: AUDIO_EFFECT_CONTRACTS.eq.createDefaultParams() };
    if (kind === "compressor") return { kind, params: AUDIO_EFFECT_CONTRACTS.compressor.createDefaultParams() };
    if (kind === "saturator") return { kind, params: AUDIO_EFFECT_CONTRACTS.saturator.createDefaultParams() };
    if (kind === "delay") return { kind, params: AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams() };
    if (kind === "reverb") return { kind, params: AUDIO_EFFECT_CONTRACTS.reverb.createDefaultParams() };
    if (kind === "spectral") return { kind, params: AUDIO_EFFECT_CONTRACTS.spectral.createDefaultParams() };
    if (kind === "chorus") return { kind, params: AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams({}) };
    if (kind === "flanger") return { kind, params: AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams({}) };
    if (kind === "phaser") return { kind, params: AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams({}) };
    if (kind === "tremolo") return { kind, params: AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams({}) };
    if (kind === "autopan") return { kind, params: AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams({}) };
    if (kind === "lofi") return { kind, params: AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams({}) };
    return { kind: "ensemble", params: AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams({}) };
  };

  const localEffectForKind = (targetId: string, kind: AudioEffectKind): LocalEffectKind => (
    targetId === "master" ? `master-${kind}` : kind
  );

  const instanceKey = (targetId: string, instanceId: string) => `${targetId}:${instanceId}`;
  type EqInteraction = {
    targetId: string;
    instanceId: string;
    generation: number;
    baseline: EqParams;
    latest: EqParams;
  };
  const eqInteractions = new Map<string, EqInteraction>();
  const pendingEqPreviewFrames = new Map<string, number>();
  const pendingEqPreviewPayloads = new Map<string, EffectParamsCommitPayload<"eq" | "master-eq">>();
  const pendingEqWrites = new Set<Promise<void>>();
  const requiredInstanceId = (instanceId: string | undefined, kind: AudioEffectKind) => {
    if (!instanceId) throw new Error(`Audio effect "${kind}" is missing an instance ID.`);
    return instanceId;
  };
  const persistedInstanceCache = createAudioEffectInstanceIdentityCache();

  const normalizedPersistedAudioEffectRows = createMemo<AudioEffectPanelRow[]>(() => {
    if (isLocalProject()) {
      return (localAllEffects() ?? []).flatMap((row) => {
        const kind = AUDIO_EFFECT_ORDER.find((entry) => row.effect === entry || row.effect === AUDIO_EFFECT_CONTRACTS[entry].masterKind);
        return kind && row.params && row.instanceId ? [{
          targetId: row.targetId,
          kind,
          instanceId: row.instanceId,
          index: row.index,
          params: normalizeParamsForKind(kind, row.params),
        }] : [];
      });
    }
    return (context.roomEffects() ?? []).flatMap((row) => {
      const targetId = row.targetType === "master" ? "master" : row.trackId;
      if (!targetId) return [];
      const kind = AUDIO_EFFECT_ORDER.find((entry) => row.type === entry);
      return kind && row.params && row.instanceId ? [{
        targetId,
        kind,
        instanceId: row.instanceId,
        index: row.index,
        params: normalizeParamsForKind(kind, row.params),
      }] : [];
    });
  });

  const persistedRowsForTarget = (targetId: string): AudioEffectPanelRow[] => (
    normalizedPersistedAudioEffectRows().filter((row) => row.targetId === targetId)
  );

  const writeDraftParams = (targetId: string, instanceId: string, kind: AudioEffectKind, params: AudioEffectParams) => {
    setDraftParamsByInstance((prev) => ({
      ...prev,
      [instanceKey(targetId, instanceId)]: { targetId, instanceId, kind, params },
    }));
  };

  const clearDraftParams = (targetId: string, instanceId: string) => {
    setDraftParamsByInstance((prev) => {
      const key = instanceKey(targetId, instanceId);
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const clearDraftParamsForTarget = (targetId: string) => {
    setDraftParamsByInstance((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const [key, draft] of Object.entries(prev)) {
        if (draft?.targetId !== targetId) continue;
        delete next[key];
        changed = true;
      }
      return changed ? next : prev;
    });
  };

  createEffect(() => {
    const persistedRowsByInstance = new Map(normalizedPersistedAudioEffectRows().map((row) => [
      instanceKey(row.targetId, requiredInstanceId(row.instanceId, row.kind)),
      row,
    ]));
    const drafts = draftParamsByInstance();
    const next = { ...drafts };
    let changed = false;
    for (const [key, draft] of Object.entries(drafts)) {
      if (!draft) continue;
      const row = persistedRowsByInstance.get(key);
      if (!row || row.kind !== draft.kind) continue;
      if (!areParamsForKindEqual(draft.kind, row.params, draft.params)) continue;
      delete next[key];
      changed = true;
    }
    if (changed) setDraftParamsByInstance(next);
  });

  const orderedInstancesForTarget = (targetId: string): AudioEffectInstance[] => {
    const rows = persistedRowsForTarget(targetId);
    const entries = rows
      .map((row) => ({ kind: row.kind, id: requiredInstanceId(row.instanceId, row.kind), index: row.index }))
      .sort(compareAudioEffectOrderEntries)
      .map((row) => persistedInstanceCache.get(targetId, row.id, row.kind));
    return normalizeAudioEffectInstanceOrder(entries, entries);
  };

  function readPersistedOrderedEffectsForTarget(targetId: string): AudioEffectInstance[] {
    return orderedInstancesForTarget(targetId);
  }

  const persistedOrderedEffects = createMemo<AudioEffectInstance[]>(
    () => readPersistedOrderedEffectsForTarget(currentTargetId()),
    [],
    { equals: areAudioEffectInstanceOrdersEqual },
  );

  const orderedEffects = createMemo<AudioEffectInstance[]>(() => {
    const persistedOrder = persistedOrderedEffects();
    optimisticOrder();
    const targetId = currentTargetId();
    return optimisticOrdersByTarget.has(targetId)
      ? optimisticOrdersByTarget.get(targetId) ?? []
      : persistedOrder;
  });

  createEffect(() => {
    const rows = normalizedPersistedAudioEffectRows();
    persistedInstanceCache.prune(new Set(rows.flatMap((row) => row.instanceId ? [instanceKey(row.targetId, row.instanceId)] : [])));
    const optimistic = optimisticOrder();
    for (const [targetId, order] of optimisticOrdersByTarget) {
      if (!areAudioEffectInstanceOrdersEqual(order, readPersistedOrderedEffectsForTarget(targetId))) continue;
      optimisticOrdersByTarget.delete(targetId);
    }
    if (optimistic && !optimisticOrdersByTarget.has(optimistic.targetId)) {
      setOptimisticOrder();
    }
  });

  createEffect(() => {
    const order = orderedEffects();
    const targetId = currentTargetId();
    normalizedPersistedAudioEffectRows();
    draftParamsByInstance();
    void order;
    void targetId;
    // Parameter drafts are applied by explicit update paths. Keeping this
    // reactive observer side-effect free avoids duplicate chain rebuilds.
  });

  const currentOrderForTarget = (targetId: string) => {
    return optimisticOrdersByTarget.has(targetId)
      ? optimisticOrdersByTarget.get(targetId) ?? []
      : targetId === currentTargetId()
        ? orderedEffects()
        : readPersistedOrderedEffectsForTarget(targetId);
  };

  const effectIndexForTarget = (targetId: string, instanceId: string) => (
    persistedRowsForTarget(targetId).find((row) => row.instanceId === instanceId)?.index
  );

  const setOptimisticOrderForTarget = (targetId: string, order: AudioEffectInstance[]) => {
    optimisticOrdersByTarget.set(targetId, order);
    setOptimisticOrder({ targetId, order });
  };

  const rollbackOptimisticOrder = (targetId: string, order: AudioEffectInstance[]) => {
    const optimistic = optimisticOrdersByTarget.get(targetId);
    if (!optimistic || !areAudioEffectInstanceOrdersEqual(optimistic, order)) return;
    optimisticOrdersByTarget.delete(targetId);
    setOptimisticOrder();
    void applyInstancesToEngine(targetId, readPersistedOrderedEffectsForTarget(targetId)).catch(() => undefined);
  };

  const persistReorder = async (targetId: string, order: AudioEffectInstance[]) => {
    if (context.persistAudioEffectOrder) {
      await context.persistAudioEffectOrder(targetId, order);
      return;
    }
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
    const currentOrder = currentOrderForTarget(targetId);
    const fromIndex = currentOrder.findIndex((entry) => entry.id === instance.id);
    if (fromIndex < 0) return;
    const nextOrder = currentOrder.filter((entry) => entry.id !== instance.id);
    const clampedIndex = Math.max(0, Math.min(targetIndex, nextOrder.length));
    nextOrder.splice(clampedIndex, 0, instance);
    const normalized = normalizeAudioEffectInstanceOrder(nextOrder, currentOrder);
    if (areAudioEffectInstanceOrdersEqual(currentOrder, normalized)) return;
    setOptimisticOrderForTarget(targetId, normalized);
    void applyInstancesToEngine(targetId, normalized).catch(() => undefined);
    void persistReorder(targetId, normalized).catch(() =>
      untrack(() => rollbackOptimisticOrder(targetId, normalized)),
    );
  };

  function paramsForInstanceForTarget(targetId: string, instance: AudioEffectInstance) {
    return draftParamsByInstance()[instanceKey(targetId, instance.id)]?.params
      ?? persistedRowsForTarget(targetId).find((row) => requiredInstanceId(row.instanceId, row.kind) === instance.id && row.kind === instance.kind)?.params;
  }

  const paramsForInstance = (instance: AudioEffectInstance) => paramsForInstanceForTarget(currentTargetId(), instance);

  const exportRowForRuntime = (targetId: string, instanceId: string, index: number, runtime: AudioEffectRuntimeInstance): ExportEffectRow => {
    const extras = { targetId, instanceId, index };
    if (runtime.kind === "utility") return { ...extras, effect: runtime.kind, params: structuredClone(runtime.params) };
    if (runtime.kind === "autofilter") return { ...extras, effect: runtime.kind, params: structuredClone(runtime.params) };
    if (runtime.kind === "eq") return { ...extras, effect: runtime.kind, params: structuredClone(runtime.params) };
    if (runtime.kind === "gate") return { ...extras, effect: runtime.kind, params: structuredClone(runtime.params) };
    if (runtime.kind === "compressor") return { ...extras, effect: runtime.kind, params: structuredClone(runtime.params) };
    if (runtime.kind === "saturator") return { ...extras, effect: runtime.kind, params: structuredClone(runtime.params) };
    if (runtime.kind === "limiter") return { ...extras, effect: runtime.kind, params: structuredClone(runtime.params) };
    if (runtime.kind === "lofi") return { ...extras, effect: runtime.kind, params: structuredClone(runtime.params) };
    if (runtime.kind === "delay") return { ...extras, effect: runtime.kind, params: structuredClone(runtime.params) };
    if (runtime.kind === "reverb") return { ...extras, effect: runtime.kind, params: structuredClone(runtime.params) };
    if (runtime.kind === "chorus") return { ...extras, effect: runtime.kind, params: structuredClone(runtime.params) };
    if (runtime.kind === "flanger") return { ...extras, effect: runtime.kind, params: structuredClone(runtime.params) };
    if (runtime.kind === "phaser") return { ...extras, effect: runtime.kind, params: structuredClone(runtime.params) };
    if (runtime.kind === "tremolo") return { ...extras, effect: runtime.kind, params: structuredClone(runtime.params) };
    if (runtime.kind === "autopan") return { ...extras, effect: runtime.kind, params: structuredClone(runtime.params) };
    if (runtime.kind === "ensemble") return { ...extras, effect: runtime.kind, params: structuredClone(runtime.params) };
    return { ...extras, effect: runtime.kind, params: structuredClone(runtime.params) };
  };
  const snapshotExportProjection = (): ExportEffectsProjection => {
    const ownedTargetIds = new Set(optimisticOrdersByTarget.keys());
    for (const draft of Object.values(draftParamsByInstance())) {
      if (draft) ownedTargetIds.add(draft.targetId);
    }
    const replaceAudioEffectTargets: ExportEffectsProjection["replaceAudioEffectTargets"] = [];
    for (const targetId of ownedTargetIds) {
      const rows: ExportEffectRow[] = [];
      for (const [index, instance] of currentOrderForTarget(targetId).entries()) {
        const params = paramsForInstanceForTarget(targetId, instance);
        if (params === undefined) continue;
        rows.push(exportRowForRuntime(targetId, instance.id, index, runtimeInstanceForParams(instance, params)));
      }
      replaceAudioEffectTargets.push({ targetId, rows });
    }
    return { replaceAudioEffectTargets, upsertDeviceRows: [] };
  };

  const sidechainKey = (targetTrackId: string, effectInstanceId: string) => `${targetTrackId}:${effectInstanceId}`;
  const snapshotSidechainRoutes = () => {
    const base = new Map((context.sidechainRoutes?.() ?? []).map((route) => [sidechainKey(route.targetTrackId, route.effectInstanceId), route]));
    for (const [key, patch] of sidechainPatches) {
      const baseRoute = base.get(key);
      if (baseRoute?.sourceTrackId === patch.sourceTrackId || (!baseRoute && patch.sourceTrackId === undefined)) {
        sidechainPatches.delete(key);
        continue;
      }
      if (patch.sourceTrackId) base.set(key, { targetTrackId: patch.targetTrackId, effectInstanceId: patch.effectInstanceId, sourceTrackId: patch.sourceTrackId });
      else base.delete(key);
    }
    return Array.from(base.values());
  };

  function persistedInstanceIdForTarget(targetId: string, instance: AudioEffectInstance) {
    const row = persistedRowsForTarget(targetId).find((entry) => entry.instanceId === instance.id && entry.kind === instance.kind);
    return row?.instanceId ?? instance.id;
  }

  function runtimeInstanceForParams(instance: AudioEffectInstance, params: AudioEffectParams): AudioEffectRuntimeInstance {
    if (instance.kind === "utility") return { id: instance.id, kind: instance.kind, params: AUDIO_EFFECT_CONTRACTS.utility.normalizeParams(params) };
    if (instance.kind === "autofilter") return { id: instance.id, kind: instance.kind, params: AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams(params) };
    if (instance.kind === "limiter") return { id: instance.id, kind: instance.kind, params: AUDIO_EFFECT_CONTRACTS.limiter.normalizeParams(params) };
    if (instance.kind === "gate") return { id: instance.id, kind: instance.kind, params: AUDIO_EFFECT_CONTRACTS.gate.normalizeParams(params) };
    if (instance.kind === "eq") return { id: instance.id, kind: instance.kind, params: normalizeEqParams(objectParamInput(params)) };
    if (instance.kind === "compressor") return { id: instance.id, kind: instance.kind, params: normalizeCompressorParams(objectParamInput(params)) };
    if (instance.kind === "saturator") return { id: instance.id, kind: instance.kind, params: normalizeSaturatorParams(objectParamInput(params)) };
    if (instance.kind === "delay") return { id: instance.id, kind: instance.kind, params: normalizeDelayParams(objectParamInput(params)) };
    if (instance.kind === "reverb") return { id: instance.id, kind: instance.kind, params: normalizeReverbParams(objectParamInput(params)) };
    if (instance.kind === "spectral") return { id: instance.id, kind: instance.kind, params: AUDIO_EFFECT_CONTRACTS.spectral.normalizeParams(params) };
    if (instance.kind === "chorus") return { id: instance.id, kind: instance.kind, params: AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams(params) };
    if (instance.kind === "flanger") return { id: instance.id, kind: instance.kind, params: AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams(params) };
    if (instance.kind === "phaser") return { id: instance.id, kind: instance.kind, params: AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams(params) };
    if (instance.kind === "tremolo") return { id: instance.id, kind: instance.kind, params: AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams(params) };
    if (instance.kind === "autopan") return { id: instance.id, kind: instance.kind, params: AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams(params) };
    if (instance.kind === "lofi") return { id: instance.id, kind: instance.kind, params: AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams(params) };
    return { id: instance.id, kind: instance.kind, params: AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams(params) };
  }

  function buildRuntimeInstancesForTarget(targetId: string, order: AudioEffectInstance[]): AudioEffectRuntimeInstance[] {
    return order.flatMap((instance) => {
      const params = paramsForInstanceForTarget(targetId, instance);
      return params ? [runtimeInstanceForParams(instance, params)] : [];
    });
  }

  function commitInstanceParams(targetId: string, instanceId: string | undefined, kind: AudioEffectKind, previous: AudioEffectParams, next: AudioEffectParams) {
    if (kind === "utility") {
      const from = normalizeUtilityParamsEnvelope(previous);
      const to = normalizeUtilityParamsEnvelope(next);
      if (AUDIO_EFFECT_CONTRACTS.utility.serializeParams(from) === AUDIO_EFFECT_CONTRACTS.utility.serializeParams(to)) return;
      if (targetId === "master") context.onEffectParamsCommitted?.({ targetId, effect: "master-utility", instanceId, from, to }, context.projectId());
      else context.onEffectParamsCommitted?.({ targetId, effect: "utility", instanceId, from, to }, context.projectId());
      return;
    }
    if (kind === "autofilter") {
      const from = AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams(previous);
      const to = AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams(next);
      if (AUDIO_EFFECT_CONTRACTS.autofilter.serializeParams(from) === AUDIO_EFFECT_CONTRACTS.autofilter.serializeParams(to)) return;
      if (targetId === "master") context.onEffectParamsCommitted?.({ targetId, effect: "master-autofilter", instanceId, from, to }, context.projectId());
      else context.onEffectParamsCommitted?.({ targetId, effect: "autofilter", instanceId, from, to }, context.projectId());
      return;
    }
    if (kind === "gate") {
      const from = normalizeGateParamsEnvelope(previous);
      const to = normalizeGateParamsEnvelope(next);
      if (AUDIO_EFFECT_CONTRACTS.gate.serializeParams(from) === AUDIO_EFFECT_CONTRACTS.gate.serializeParams(to)) return;
      if (targetId === "master") context.onEffectParamsCommitted?.({ targetId, effect: "master-gate", instanceId, from, to }, context.projectId());
      else context.onEffectParamsCommitted?.({ targetId, effect: "gate", instanceId, from, to }, context.projectId());
      return;
    }
    if (kind === "eq") {
      const from = normalizeEqParams(objectParamInput(previous));
      const to = normalizeEqParams(objectParamInput(next));
      if (AUDIO_EFFECT_CONTRACTS.eq.serializeParams(from) === AUDIO_EFFECT_CONTRACTS.eq.serializeParams(to)) return;
      if (targetId === "master") context.onEffectParamsCommitted?.({ targetId: "master", effect: "master-eq", instanceId, from, to }, context.projectId());
      else context.onEffectParamsCommitted?.({ targetId, effect: "eq", instanceId, from, to }, context.projectId());
      return;
    }
    if (kind === "compressor") {
      const from = normalizeCompressorParams(objectParamInput(previous));
      const to = normalizeCompressorParams(objectParamInput(next));
      if (AUDIO_EFFECT_CONTRACTS.compressor.serializeParams(from) === AUDIO_EFFECT_CONTRACTS.compressor.serializeParams(to)) return;
      if (targetId === "master") context.onEffectParamsCommitted?.({ targetId: "master", effect: "master-compressor", instanceId, from, to }, context.projectId());
      else context.onEffectParamsCommitted?.({ targetId, effect: "compressor", instanceId, from, to }, context.projectId());
      return;
    }
    if (kind === "saturator") {
      const from = normalizeSaturatorParams(objectParamInput(previous));
      const to = normalizeSaturatorParams(objectParamInput(next));
      if (AUDIO_EFFECT_CONTRACTS.saturator.serializeParams(from) === AUDIO_EFFECT_CONTRACTS.saturator.serializeParams(to)) return;
      if (targetId === "master") context.onEffectParamsCommitted?.({ targetId: "master", effect: "master-saturator", instanceId, from, to }, context.projectId());
      else context.onEffectParamsCommitted?.({ targetId, effect: "saturator", instanceId, from, to }, context.projectId());
      return;
    }
    if (kind === "delay") {
      const from = normalizeDelayParams(objectParamInput(previous));
      const to = normalizeDelayParams(objectParamInput(next));
      if (AUDIO_EFFECT_CONTRACTS.delay.serializeParams(from) === AUDIO_EFFECT_CONTRACTS.delay.serializeParams(to)) return;
      if (targetId === "master") context.onEffectParamsCommitted?.({ targetId: "master", effect: "master-delay", instanceId, from, to }, context.projectId());
      else context.onEffectParamsCommitted?.({ targetId, effect: "delay", instanceId, from, to }, context.projectId());
      return;
    }
    if (kind === "spectral") {
      const from = AUDIO_EFFECT_CONTRACTS.spectral.normalizeParams(previous);
      const to = AUDIO_EFFECT_CONTRACTS.spectral.normalizeParams(next);
      if (AUDIO_EFFECT_CONTRACTS.spectral.serializeParams(from) === AUDIO_EFFECT_CONTRACTS.spectral.serializeParams(to)) return;
      if (targetId === "master") context.onEffectParamsCommitted?.({ targetId: "master", effect: "master-spectral", instanceId, from, to }, context.projectId());
      else context.onEffectParamsCommitted?.({ targetId, effect: "spectral", instanceId, from, to }, context.projectId());
      return;
    }
    if (kind === "chorus") {
      const from = AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams(previous); const to = AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams(next);
      if (AUDIO_EFFECT_CONTRACTS.chorus.serializeParams(from) !== AUDIO_EFFECT_CONTRACTS.chorus.serializeParams(to)) context.onEffectParamsCommitted?.(targetId === "master" ? { targetId, effect: "master-chorus", instanceId, from, to } : { targetId, effect: "chorus", instanceId, from, to }, context.projectId());
      return;
    }
    if (kind === "flanger") {
      const from = AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams(previous); const to = AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams(next);
      if (AUDIO_EFFECT_CONTRACTS.flanger.serializeParams(from) !== AUDIO_EFFECT_CONTRACTS.flanger.serializeParams(to)) context.onEffectParamsCommitted?.(targetId === "master" ? { targetId, effect: "master-flanger", instanceId, from, to } : { targetId, effect: "flanger", instanceId, from, to }, context.projectId());
      return;
    }
    if (kind === "phaser") {
      const from = AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams(previous); const to = AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams(next);
      if (AUDIO_EFFECT_CONTRACTS.phaser.serializeParams(from) !== AUDIO_EFFECT_CONTRACTS.phaser.serializeParams(to)) context.onEffectParamsCommitted?.(targetId === "master" ? { targetId, effect: "master-phaser", instanceId, from, to } : { targetId, effect: "phaser", instanceId, from, to }, context.projectId());
      return;
    }
    if (kind === "tremolo") {
      const from = AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams(previous); const to = AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams(next);
      if (AUDIO_EFFECT_CONTRACTS.tremolo.serializeParams(from) !== AUDIO_EFFECT_CONTRACTS.tremolo.serializeParams(to)) context.onEffectParamsCommitted?.(targetId === "master" ? { targetId, effect: "master-tremolo", instanceId, from, to } : { targetId, effect: "tremolo", instanceId, from, to }, context.projectId());
      return;
    }
    if (kind === "autopan") {
      const from = AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams(previous); const to = AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams(next);
      if (AUDIO_EFFECT_CONTRACTS.autopan.serializeParams(from) !== AUDIO_EFFECT_CONTRACTS.autopan.serializeParams(to)) context.onEffectParamsCommitted?.(targetId === "master" ? { targetId, effect: "master-autopan", instanceId, from, to } : { targetId, effect: "autopan", instanceId, from, to }, context.projectId());
      return;
    }
    if (kind === "ensemble") {
      const from = AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams(previous); const to = AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams(next);
      if (AUDIO_EFFECT_CONTRACTS.ensemble.serializeParams(from) !== AUDIO_EFFECT_CONTRACTS.ensemble.serializeParams(to)) context.onEffectParamsCommitted?.(targetId === "master" ? { targetId, effect: "master-ensemble", instanceId, from, to } : { targetId, effect: "ensemble", instanceId, from, to }, context.projectId());
      return;
    }
    if (kind === "lofi") {
      const from = AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams(previous); const to = AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams(next);
      if (AUDIO_EFFECT_CONTRACTS.lofi.serializeParams(from) !== AUDIO_EFFECT_CONTRACTS.lofi.serializeParams(to)) context.onEffectParamsCommitted?.(targetId === "master" ? { targetId, effect: "master-lofi", instanceId, from, to } : { targetId, effect: "lofi", instanceId, from, to }, context.projectId());
      return;
    }
    const from = normalizeReverbParams(objectParamInput(previous));
    const to = normalizeReverbParams(objectParamInput(next));
    if (AUDIO_EFFECT_CONTRACTS.reverb.serializeParams(from) === AUDIO_EFFECT_CONTRACTS.reverb.serializeParams(to)) return;
    if (targetId === "master") context.onEffectParamsCommitted?.({ targetId: "master", effect: "master-reverb", instanceId, from, to }, context.projectId());
    else context.onEffectParamsCommitted?.({ targetId, effect: "reverb", instanceId, from, to }, context.projectId());
  }

  function applyInstancesToEngine(targetId: string, order: AudioEffectInstance[]) {
    const instances = buildRuntimeInstancesForTarget(targetId, order);
    return targetId === "master"
      ? context.audioEngine().setMasterFxInstances(instances)
      : context.audioEngine().setTrackFxInstances(targetId, instances);
  }

  const persistInstanceParams = async (targetId: string, instanceId: string, kind: AudioEffectKind, params: unknown) => {
    const projectId = context.projectId();
    if (!projectId) return;
    const input = objectParamInput(params);
    if (isLocalId("project", projectId)) {
      if (kind === "utility") {
        await setLocalEffectInstance(projectId, targetId, localEffectForKind(targetId, kind), normalizeUtilityParamsEnvelope(input), { instanceId });
      } else if (kind === "autofilter") {
        await setLocalEffectInstance(projectId, targetId, localEffectForKind(targetId, kind), AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams(input), { instanceId });
      } else if (kind === "gate") {
        await setLocalEffectInstance(projectId, targetId, localEffectForKind(targetId, kind), normalizeGateParamsEnvelope(input), { instanceId });
      } else if (kind === "limiter") {
        await setLocalEffectInstance(projectId, targetId, localEffectForKind(targetId, kind), AUDIO_EFFECT_CONTRACTS.limiter.normalizeParams(input), { instanceId });
      } else if (kind === "eq") {
        const normalized = normalizeEqParams(input);
        await setLocalEffectInstance(projectId, targetId, localEffectForKind(targetId, kind), normalized, { instanceId });
      } else if (kind === "compressor") {
        const normalized = normalizeCompressorParams(input);
        await setLocalEffectInstance(projectId, targetId, localEffectForKind(targetId, kind), normalized, { instanceId });
      } else if (kind === "saturator") {
        const normalized = normalizeSaturatorParams(input);
        await setLocalEffectInstance(projectId, targetId, localEffectForKind(targetId, kind), normalized, { instanceId });
      } else if (kind === "delay") {
        const normalized = normalizeDelayParams(input);
        await setLocalEffectInstance(projectId, targetId, localEffectForKind(targetId, kind), normalized, { instanceId });
      } else if (kind === "reverb") {
        const normalized = normalizeReverbParams(input);
        await setLocalEffectInstance(projectId, targetId, localEffectForKind(targetId, kind), normalized, { instanceId });
      } else if (kind === "spectral") {
        await setLocalEffectInstance(projectId, targetId, localEffectForKind(targetId, kind), AUDIO_EFFECT_CONTRACTS.spectral.normalizeParams(input), { instanceId });
      } else {
        await setLocalEffectInstance(projectId, targetId, localEffectForKind(targetId, kind), AUDIO_EFFECT_CONTRACTS[kind].normalizeParams(input), { instanceId });
      }
      return;
    }
    const userId = context.userId();
    if (!userId) return;
    const persistModulationParams = async (trackId?: string) => {
      const exactInstanceId = instanceId;
      const publish = (payload: Extract<SharedTimelineOperation, { kind: "effects.setMasterModulationParams" }>["payload"]) => publishEffectOperation(projectId, userId, trackId
        ? { kind: "effects.setModulationParams", payload: { ...payload, trackId } }
        : { kind: "effects.setMasterModulationParams", payload });
      if (kind === "autofilter") return publish({ effect: kind, params: AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams(input), instanceId: exactInstanceId });
      if (kind === "chorus") return publish({ effect: kind, params: AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams(input), instanceId: exactInstanceId });
      if (kind === "flanger") return publish({ effect: kind, params: AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams(input), instanceId: exactInstanceId });
      if (kind === "phaser") return publish({ effect: kind, params: AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams(input), instanceId: exactInstanceId });
      if (kind === "tremolo") return publish({ effect: kind, params: AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams(input), instanceId: exactInstanceId });
      if (kind === "autopan") return publish({ effect: kind, params: AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams(input), instanceId: exactInstanceId });
      if (kind === "ensemble") return publish({ effect: kind, params: AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams(input), instanceId: exactInstanceId });
      if (kind === "lofi") return publish({ effect: kind, params: AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams(input), instanceId: exactInstanceId });
    };
    if (targetId === "master") {
      if (kind === "utility") await publishEffectOperation(projectId, userId, { kind: "effects.setMasterUtilityParams", payload: { params: normalizeUtilityParamsEnvelope(input), instanceId } });
      else if (kind === "gate") await publishEffectOperation(projectId, userId, { kind: "effects.setMasterGateParams", payload: { params: normalizeGateParamsEnvelope(input), instanceId } });
      else if (kind === "limiter") await publishEffectOperation(projectId, userId, { kind: "effects.setMasterLimiterParams", payload: { params: AUDIO_EFFECT_CONTRACTS.limiter.normalizeParams(input), instanceId } });
      else if (kind === "eq") await publishEffectOperation(projectId, userId, { kind: "effects.setMasterEqParams", payload: { params: normalizeEqParams(input), instanceId } });
      else if (kind === "compressor") await publishEffectOperation(projectId, userId, { kind: "effects.setMasterCompressorParams", payload: { params: normalizeCompressorParams(input), instanceId } });
      else if (kind === "saturator") await publishEffectOperation(projectId, userId, { kind: "effects.setMasterSaturatorParams", payload: { params: normalizeSaturatorParams(input), instanceId } });
      else if (kind === "delay") await publishEffectOperation(projectId, userId, { kind: "effects.setMasterDelayParams", payload: { params: normalizeDelayParams(input), instanceId } });
      else if (kind === "reverb") await publishEffectOperation(projectId, userId, { kind: "effects.setMasterReverbParams", payload: { params: normalizeReverbParams(input), instanceId } });
      else if (kind === "spectral") await publishEffectOperation(projectId, userId, { kind: "effects.setMasterSpectralParams", payload: { params: AUDIO_EFFECT_CONTRACTS.spectral.normalizeParams(input), instanceId } });
      else await persistModulationParams();
      return;
    }
    const track = resolveTrackByTargetId(targetId);
    if (!track) return;
    if (kind === "utility") await publishEffectOperation(projectId, userId, { kind: "effects.setUtilityParams", payload: { trackId: track.id, params: normalizeUtilityParamsEnvelope(input), instanceId } });
    else if (kind === "gate") await publishEffectOperation(projectId, userId, { kind: "effects.setGateParams", payload: { trackId: track.id, params: normalizeGateParamsEnvelope(input), instanceId } });
    else if (kind === "limiter") await publishEffectOperation(projectId, userId, { kind: "effects.setLimiterParams", payload: { trackId: track.id, params: AUDIO_EFFECT_CONTRACTS.limiter.normalizeParams(input), instanceId } });
    else if (kind === "eq") await publishEffectOperation(projectId, userId, { kind: "effects.setEqParams", payload: { trackId: track.id, params: normalizeEqParams(input), instanceId } });
    else if (kind === "compressor") await publishEffectOperation(projectId, userId, { kind: "effects.setCompressorParams", payload: { trackId: track.id, params: normalizeCompressorParams(input), instanceId } });
    else if (kind === "saturator") await publishEffectOperation(projectId, userId, { kind: "effects.setSaturatorParams", payload: { trackId: track.id, params: normalizeSaturatorParams(input), instanceId } });
    else if (kind === "delay") await publishEffectOperation(projectId, userId, { kind: "effects.setDelayParams", payload: { trackId: track.id, params: normalizeDelayParams(input), instanceId } });
    else if (kind === "reverb") await publishEffectOperation(projectId, userId, { kind: "effects.setReverbParams", payload: { trackId: track.id, params: normalizeReverbParams(input), instanceId } });
    else if (kind === "spectral") await publishEffectOperation(projectId, userId, { kind: "effects.setSpectralParams", payload: { trackId: track.id, params: AUDIO_EFFECT_CONTRACTS.spectral.normalizeParams(input), instanceId } });
    else await persistModulationParams(track.id);
  };

  const updateInstance = (instanceId: string, kind: AudioEffectKind, updater: (prev: AudioEffectParams) => AudioEffectParams) => {
    if (!context.canWriteCurrentTargetEffects()) return;
    const targetId = currentTargetId();
    const current = paramsForInstance({ id: instanceId, kind }) ?? createDefaultParamsForKind(kind);
    const next = normalizeParamsForKind(kind, updater(current));
    if (areParamsForKindEqual(kind, current, next)) return;
    const persistedInstanceId = persistedInstanceIdForTarget(targetId, { id: instanceId, kind });
    writeDraftParams(targetId, instanceId, kind, next);
    if (context.usesLegacyAudioEngine?.() ?? true) {
      void applyInstancesToEngine(targetId, currentOrderForTarget(targetId)).catch(() => undefined);
    }
    commitInstanceParams(targetId, persistedInstanceId, kind, current, next);
    void persistInstanceParams(targetId, persistedInstanceId, kind, next).catch(() => undefined);
  };
  const updateEq = (updater: (prev: EqParams) => EqParams) => {
    const instance = orderedEffects().find((entry) => entry.kind === "eq");
    if (instance) updateInstance(instance.id, "eq", (prev) => updater(normalizeEqParams(objectParamInput(prev))));
  };

  const createEqCommitPayload = (
    targetId: string,
    instanceId: string,
    from: EqParams,
    to: EqParams,
  ): EffectParamsCommitPayload<"eq" | "master-eq"> => targetId === "master"
    ? { targetId: "master", effect: "master-eq", instanceId, from, to }
    : { targetId, effect: "eq", instanceId, from, to };

  const dispatchEqPreview = (key: string, payload: EffectParamsCommitPayload<"eq" | "master-eq">) => {
    pendingEqPreviewPayloads.set(key, payload);
    if (pendingEqPreviewFrames.has(key)) return;
    const flush = async () => {
      pendingEqPreviewFrames.delete(key);
      const latest = pendingEqPreviewPayloads.get(key);
      pendingEqPreviewPayloads.delete(key);
      if (!latest) return;
      if (context.usesLegacyAudioEngine?.() ?? true) {
        await applyInstancesToEngine(latest.targetId, currentOrderForTarget(latest.targetId)).catch(() => undefined);
      } else {
        await context.onEffectParamsPreview?.(latest);
      }
    };
    if (typeof requestAnimationFrame === "function") {
      pendingEqPreviewFrames.set(key, requestAnimationFrame(flush));
    } else {
      void flush();
    }
  };

  const flushEqPreview = async (key: string) => {
    const frame = pendingEqPreviewFrames.get(key);
    if (frame !== undefined) cancelAnimationFrame(frame);
    pendingEqPreviewFrames.delete(key);
    const latest = pendingEqPreviewPayloads.get(key);
    pendingEqPreviewPayloads.delete(key);
    if (!latest) return;
    if (context.usesLegacyAudioEngine?.() ?? true) {
      await applyInstancesToEngine(latest.targetId, currentOrderForTarget(latest.targetId)).catch(() => undefined);
    } else {
      await context.onEffectParamsPreview?.(latest);
    }
  };

  const beginEqInteraction = (instanceId: string) => {
    if (!context.canWriteCurrentTargetEffects()) return;
    const targetId = currentTargetId();
    const baseline = normalizeEqParams(objectParamInput(paramsForInstance({ id: instanceId, kind: "eq" })));
    eqInteractions.set(instanceKey(targetId, instanceId), {
      targetId,
      instanceId,
      generation: context.projectGeneration?.() ?? 0,
      baseline,
      latest: baseline,
    });
  };

  const previewEqInteraction = (instanceId: string, updater: (params: EqParams) => EqParams) => {
    const targetId = currentTargetId();
    const key = instanceKey(targetId, instanceId);
    const interaction = eqInteractions.get(key);
    if (!interaction || interaction.generation !== (context.projectGeneration?.() ?? 0)) return;
    const current = normalizeEqParams(objectParamInput(paramsForInstance({ id: instanceId, kind: "eq" })));
    const next = normalizeEqParams(updater(current));
    if (areParamsForKindEqual("eq", current, next)) return;
    interaction.latest = next;
    writeDraftParams(targetId, instanceId, "eq", next);
    dispatchEqPreview(key, createEqCommitPayload(targetId, instanceId, interaction.baseline, next));
  };

  const commitEqInteraction = async (instanceId: string) => {
    const targetId = currentTargetId();
    const key = instanceKey(targetId, instanceId);
    const interaction = eqInteractions.get(key);
    if (!interaction || interaction.generation !== (context.projectGeneration?.() ?? 0)) return;
    await flushEqPreview(key);
    eqInteractions.delete(key);
    const next = normalizeEqParams(objectParamInput(paramsForInstance({ id: instanceId, kind: "eq" })));
    if (areParamsForKindEqual("eq", interaction.baseline, next)) return;
    if (context.usesLegacyAudioEngine?.() ?? true) {
      void applyInstancesToEngine(targetId, currentOrderForTarget(targetId)).catch(() => undefined);
    }
    const persistedInstanceId = persistedInstanceIdForTarget(targetId, { id: instanceId, kind: "eq" });
    if (!(context.usesLegacyAudioEngine?.() ?? true)) {
      await context.onEffectParamsFlush?.(createEqCommitPayload(targetId, instanceId, interaction.baseline, next));
    }
    const write = persistInstanceParams(targetId, persistedInstanceId, "eq", next)
      .then(() => commitInstanceParams(targetId, persistedInstanceId, "eq", interaction.baseline, next))
      .catch(() => undefined)
      .finally(() => pendingEqWrites.delete(write));
    pendingEqWrites.add(write);
  };

  const cancelEqInteraction = (instanceId: string) => {
    const targetId = currentTargetId();
    const key = instanceKey(targetId, instanceId);
    const interaction = eqInteractions.get(key);
    if (!interaction || interaction.generation !== (context.projectGeneration?.() ?? 0)) return;
    const frame = pendingEqPreviewFrames.get(key);
    if (frame !== undefined) cancelAnimationFrame(frame);
    pendingEqPreviewFrames.delete(key);
    pendingEqPreviewPayloads.delete(key);
    eqInteractions.delete(key);
    writeDraftParams(targetId, instanceId, "eq", interaction.baseline);
    if (context.usesLegacyAudioEngine?.() ?? true) {
      void applyInstancesToEngine(targetId, currentOrderForTarget(targetId)).catch(() => undefined);
    } else {
      context.onEffectParamsPreview?.(createEqCommitPayload(targetId, instanceId, interaction.latest, interaction.baseline));
    }
  };
  const updateReverb = (updater: (prev: ReverbParams) => ReverbParams) => {
    const instance = orderedEffects().find((entry) => entry.kind === "reverb");
    if (instance) updateInstance(instance.id, "reverb", (prev) => updater(normalizeReverbParams(objectParamInput(prev))));
  };
  const updateCompressor = (updater: (prev: CompressorParams) => CompressorParams) => {
    const instance = orderedEffects().find((entry) => entry.kind === "compressor");
    if (instance) updateInstance(instance.id, "compressor", (prev) => updater(normalizeCompressorParams(objectParamInput(prev))));
  };
  const updateSaturator = (updater: (prev: SaturatorParams) => SaturatorParams) => {
    const instance = orderedEffects().find((entry) => entry.kind === "saturator");
    if (instance) updateInstance(instance.id, "saturator", (prev) => updater(normalizeSaturatorParams(objectParamInput(prev))));
  };
  const updateDelay = (updater: (prev: DelayParams) => DelayParams) => {
    const instance = orderedEffects().find((entry) => entry.kind === "delay");
    if (instance) updateInstance(instance.id, "delay", (prev) => updater(normalizeDelayParams(objectParamInput(prev))));
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
    const previousOrder = currentOrderForTarget(targetId);
    if (effects.length === 0) return false;
    const entries = effects.map((effect) => ({
      instance: { id: createAudioEffectInstanceId(), kind: effect.kind },
      params: normalizePresetStepParams(effect),
    }));
    const instances = entries.map((entry) => entry.instance);
    for (const entry of entries) {
      writeDraftParams(targetId, entry.instance.id, entry.instance.kind, entry.params);
    }
    const nextOrder = [...previousOrder];
    nextOrder.splice(index === undefined ? nextOrder.length : Math.max(0, Math.min(index, nextOrder.length)), 0, ...instances);
    setOptimisticOrderForTarget(targetId, nextOrder);
    const persisted: AudioEffectInstance[] = [];
    try {
      await applyInstancesToEngine(targetId, nextOrder);
      for (const entry of entries) {
        await persistInstanceParams(targetId, entry.instance.id, entry.instance.kind, entry.params);
        persisted.push(entry.instance);
      }
      await persistReorder(targetId, nextOrder);
      return true;
    } catch {
      const projectId = context.projectId();
      if (projectId) {
        await Promise.allSettled(persisted.map((instance) => deleteInstanceFromTarget(targetId, instance, projectId)));
        await persistReorder(targetId, previousOrder).catch(() => undefined);
      }
      for (const entry of entries) clearDraftParams(targetId, entry.instance.id);
      setOptimisticOrderForTarget(targetId, previousOrder);
      await applyInstancesToEngine(targetId, previousOrder).catch(() => undefined);
      return false;
    }
  };
  const addByKindToTarget = async (targetId: Track["id"] | "master", effect: AudioEffectKind, index?: number) => (
    await addChainToTarget(targetId, [createDefaultPresetStep(effect)], index)
  );
  const canAddByKindToTarget = (_targetId: Track["id"] | "master", _effect: AudioEffectKind) => true;
  const deleteInstanceFromTarget = async (targetId: Track["id"] | "master", instance: AudioEffectInstance, projectId: string) => {
    const instanceId = persistedInstanceIdForTarget(targetId, instance);
    if (isLocalId("project", projectId)) {
      await deleteLocalEffectInstance(projectId, targetId, localEffectForKind(targetId, instance.kind), instanceId);
      return true;
    }
    const userId = context.userId();
    if (!userId) return false;
    if (targetId === "master") {
      await publishEffectOperation(projectId, userId, { kind: "effects.removeAudioEffect", payload: { targetType: "master", effect: instance.kind, instanceId } });
      return true;
    }
    const track = resolveTrackByTargetId(targetId);
    if (!track) return false;
    await publishEffectOperation(projectId, userId, { kind: "effects.removeAudioEffect", payload: { targetType: "track", trackId: track.id, effect: instance.kind, instanceId } });
    return true;
  };
  const removeByInstanceFromTarget = async (targetId: Track["id"] | "master", instance: AudioEffectInstance) => {
    if (!context.canWriteCurrentTargetEffects()) return false;
    const currentOrder = currentOrderForTarget(targetId);
    if (!currentOrder.some((entry) => entry.id === instance.id)) return false;
    const projectId = context.projectId();
    if (!projectId) return false;
    const nextOrder = currentOrder.filter((entry) => entry.id !== instance.id);
    setOptimisticOrderForTarget(targetId, nextOrder);
    await applyInstancesToEngine(targetId, nextOrder);
    try {
      if (!(await deleteInstanceFromTarget(targetId, instance, projectId))) {
        setOptimisticOrderForTarget(targetId, currentOrder);
        await applyInstancesToEngine(targetId, currentOrder);
        return false;
      }
      await persistReorder(targetId, nextOrder);
      clearDraftParams(targetId, instance.id);
      return true;
    } catch (error) {
      setOptimisticOrderForTarget(targetId, currentOrder);
      await applyInstancesToEngine(targetId, currentOrder);
      throw error;
    }
  };
  const replayInstanceParams: EffectsPanelAudioDevice["replayInstanceParams"] = (payload) => {
    const kind = audioEffectKindForHistoryEffect(payload.effect);
    if (!kind) return false;
    const order = payload.targetId === currentTargetId() ? orderedEffects() : readPersistedOrderedEffectsForTarget(payload.targetId);
    if (!order.some((entry) => entry.id === payload.instanceId && entry.kind === kind)) return false;
    const params = normalizeParamsForKind(kind, payload.params);
    writeDraftParams(payload.targetId, payload.instanceId, kind, params);
    void applyInstancesToEngine(payload.targetId, order).catch(() => undefined);
    return true;
  };
  const removeAllFromTarget = async (targetId: Track["id"] | "master") => {
    if (!context.canWriteCurrentTargetEffects()) return false;
    const currentOrder = currentOrderForTarget(targetId);
    if (currentOrder.length === 0) return false;
    const projectId = context.projectId();
    if (!projectId) return false;
    setOptimisticOrderForTarget(targetId, []);
    await applyInstancesToEngine(targetId, []);
    try {
      const deleted = await Promise.all(currentOrder.map((instance) => deleteInstanceFromTarget(targetId, instance, projectId)));
      if (!deleted.every(Boolean)) {
        setOptimisticOrderForTarget(targetId, currentOrder);
        await applyInstancesToEngine(targetId, currentOrder);
        return false;
      }
      await persistReorder(targetId, []);
      clearDraftParamsForTarget(targetId);
      return true;
    } catch (error) {
      setOptimisticOrderForTarget(targetId, currentOrder);
      await applyInstancesToEngine(targetId, currentOrder);
      throw error;
    }
  };

  const setSidechainSource = async (instanceId: string, sourceTrackId?: string) => {
    const projectId = context.projectId();
    const targetId = currentTargetId();
    if (!projectId || targetId === "master") return;
    const key = sidechainKey(targetId, instanceId);
    const patch = { attempt: ++sidechainAttempt, targetTrackId: targetId, effectInstanceId: instanceId, sourceTrackId };
    sidechainPatches.set(key, patch);
    const persist = async () => {
      if (context.persistSidechainRoute) {
        await context.persistSidechainRoute(targetId, instanceId, sourceTrackId);
        return;
      }
      if (isLocalId("project", projectId)) {
        const repository = createLocalTimelineRepository(projectId);
        if (sourceTrackId) await repository.setSidechainRoute({ sourceTrackId, targetTrackId: targetId, effectInstanceId: instanceId });
        else await repository.removeSidechainRoute(targetId, instanceId);
        return;
      }
      const userId = context.userId();
      if (!userId) return;
      await publishEffectOperation(projectId, userId, sourceTrackId
        ? { kind: "sidechains.setRoute", payload: { projectId, sourceTrackId, targetTrackId: targetId, effectInstanceId: instanceId } }
        : { kind: "sidechains.removeRoute", payload: { projectId, targetTrackId: targetId, effectInstanceId: instanceId } });
    };
    const pending = persist().then(() => {
    }).catch((error) => {
      const current = sidechainPatches.get(key);
      if (current?.attempt === patch.attempt) sidechainPatches.delete(key);
      throw error;
    });
    pendingSidechainWrites.add(pending);
    try {
      await pending;
    } finally {
      pendingSidechainWrites.delete(pending);
    }
  };

  return {
    snapshotExportProjection,
    snapshotExportRows: (targetIds) => targetIds.flatMap((targetId) => {
      const rows = currentOrderForTarget(targetId).flatMap((instance, index) => {
        const params = paramsForInstanceForTarget(targetId, instance);
        if (params === undefined) return [];
        return [exportRowForRuntime(targetId, instance.id, index, runtimeInstanceForParams(instance, params))];
      });
      return rows;
    }),
    snapshotSidechainRoutes,
    addByKindToTarget,
    addChainToTarget,
    canAddByKindToTarget,
    utility: {
      changeInstance: (instanceId, updater) => updateInstance(instanceId, "utility", (prev) => updater(normalizeUtilityParamsEnvelope(prev))),
    },
    gate: {
      changeInstance: (instanceId, updater) => updateInstance(instanceId, "gate", (prev) => updater(normalizeGateParamsEnvelope(prev))),
      setSidechainSource,
    },
    limiter: {
      changeInstance: (instanceId, updater) => updateInstance(instanceId, "limiter", (prev) => updater(AUDIO_EFFECT_CONTRACTS.limiter.normalizeParams(prev))),
    },
    autofilter: {
      changeInstance: (instanceId, updater) => updateInstance(instanceId, "autofilter", (prev) => updater(AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams(prev))),
    },
    chorus: {
      changeInstance: (instanceId, updater) => updateInstance(instanceId, "chorus", (prev) => updater(AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams(prev))),
    },
    flanger: {
      changeInstance: (instanceId, updater) => updateInstance(instanceId, "flanger", (prev) => updater(AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams(prev))),
    },
    phaser: {
      changeInstance: (instanceId, updater) => updateInstance(instanceId, "phaser", (prev) => updater(AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams(prev))),
    },
    tremolo: {
      changeInstance: (instanceId, updater) => updateInstance(instanceId, "tremolo", (prev) => updater(AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams(prev))),
    },
    autopan: {
      changeInstance: (instanceId, updater) => updateInstance(instanceId, "autopan", (prev) => updater(AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams(prev))),
    },
    ensemble: {
      changeInstance: (instanceId, updater) => updateInstance(instanceId, "ensemble", (prev) => updater(AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams(prev))),
    },
    lofi: {
      changeInstance: (instanceId, updater) => updateInstance(instanceId, "lofi", (prev) => updater(AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams(prev))),
    },
    spectral: {
      changeInstance: (instanceId, updater) => updateInstance(instanceId, "spectral", (prev) => updater(AUDIO_EFFECT_CONTRACTS.spectral.normalizeParams(prev))),
      setSidechainSource,
    },
    eq: {
      add: addEq,
      changeInstance: (instanceId, updater) => updateInstance(instanceId, "eq", (prev) => updater(normalizeEqParams(objectParamInput(prev)))),
      beginInteraction: beginEqInteraction,
      previewInteraction: previewEqInteraction,
      commitInteraction: commitEqInteraction,
      cancelInteraction: cancelEqInteraction,
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
      await Promise.all([eqState.flushPending(), compressorState.flushPending(), saturatorState.flushPending(), delayState.flushPending(), reverbState.flushPending(), ...pendingSidechainWrites, ...pendingEqWrites]);
    },
    orderedEffects,
    effectIndexForTarget,
    paramsForInstance,
    removeAllFromTarget,
    removeByInstanceFromTarget,
    replayInstanceParams,
    reorder,
    compressor: {
      add: addCompressor,
      changeInstance: (instanceId, updater) => updateInstance(instanceId, "compressor", (prev) => updater(normalizeCompressorParams(objectParamInput(prev)))),
      change: (updates) => updateCompressor((prev) => normalizeCompressorParams({ ...prev, ...updates })),
      params: compressorState.params,
      readDraftForTarget: compressorState.readDraftForTarget,
      reset: () => updateCompressor(() => AUDIO_EFFECT_CONTRACTS.compressor.createDefaultParams()),
      toggleEnabled: (enabled) => updateCompressor((prev) => ({ ...prev, enabled })),
    },
    saturator: {
      add: addSaturator,
      changeInstance: (instanceId, updater) => updateInstance(instanceId, "saturator", (prev) => updater(normalizeSaturatorParams(objectParamInput(prev)))),
      change: (updates) => updateSaturator((prev) => normalizeSaturatorParams({ ...prev, ...updates })),
      params: saturatorState.params,
      readDraftForTarget: saturatorState.readDraftForTarget,
      reset: () => updateSaturator(() => AUDIO_EFFECT_CONTRACTS.saturator.createDefaultParams()),
      toggleEnabled: (enabled) => updateSaturator((prev) => ({ ...prev, enabled })),
    },
    delay: {
      add: addDelay,
      changeInstance: (instanceId, updater) => updateInstance(instanceId, "delay", (prev) => updater(normalizeDelayParams(objectParamInput(prev)))),
      change: (updates) => updateDelay((prev) => normalizeDelayParams({ ...prev, ...updates })),
      params: delayState.params,
      readDraftForTarget: delayState.readDraftForTarget,
      reset: () => updateDelay(() => AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams()),
      toggleEnabled: (enabled) => updateDelay((prev) => ({ ...prev, enabled })),
    },
    reverb: {
      add: addReverb,
      changeInstance: (instanceId, updater) => updateInstance(instanceId, "reverb", (prev) => updater(normalizeReverbParams(objectParamInput(prev)))),
      change: (updates) => updateReverb((prev) => normalizeReverbParams({ ...prev, ...updates })),
      params: reverbState.params,
      readDraftForTarget: reverbState.readDraftForTarget,
      reset: () => updateReverb(() => AUDIO_EFFECT_CONTRACTS.reverb.createDefaultParams()),
      toggleEnabled: (enabled) => updateReverb((prev) => ({ ...prev, enabled })),
    },
  };
}
