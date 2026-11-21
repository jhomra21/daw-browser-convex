import { createEffect, createMemo, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js";
import type { PlaybackAcceptanceObserver } from "~/lib/desktop/acceptance-observer";
import type { FunctionReturnType } from "convex/server";
import type { AudioEffectRuntimeInstance, AudioEngine, EngineDisposition } from "@daw-browser/audio-engine/audio-engine";
import {
  AUDIO_EFFECT_CONTRACTS,
  AUDIO_EFFECT_KINDS,
  areAudioEffectParamsEqual,
  type AudioEffectParamsByKind,
  normalizeAudioEffect,
  normalizeAudioEffectRow,
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
  isAudioEffectKind,
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
  type SpectrumParamsEnvelope,
  type DspAudioEffectKind,
  type GateParamsEnvelope,
  type EnsembleParamsEnvelope,
  type FlangerParamsEnvelope,
  type LimiterParamsEnvelope,
  type LoFiParamsEnvelope,
  type PhaserParamsEnvelope,
  type TremoloParamsEnvelope,
  type UtilityParamsEnvelope,
  isJsonObject,
  isLocalId,
  type JsonObject,
} from "@daw-browser/shared";
import type { ExternalSidechainRoute, Track } from "@daw-browser/timeline-core/types";
import type { convexApi } from "~/lib/convex";
import { compareAudioEffectOrderEntries } from "~/lib/audio-effect-order-rows";
import { createAudioEffectInstanceId, deleteLocalEffectInstance, reorderLocalAudioEffects, setLocalEffectInstance, type LocalEffectKind } from "~/lib/local-effects";
import { createLocalEffectsView, type LocalEffectsViewSource } from "~/components/timeline/create-local-effects-view";
import type { SharedTimelineOperation } from "~/lib/shared-timeline-operations-api";
import { publishDurableEffectsOperation } from "~/lib/shared-outbox-publishers";
import type { EffectParamsByEffect, EffectParamsCommitOptions, EffectParamsCommitPayload, EffectType } from "~/lib/undo/types";
import type { AudioEffectChainPresetStep } from "~/lib/audio-effect-chain-presets";
import { createLocalTimelineRepository } from "~/lib/timeline-repository/local-timeline-repository";
import type { ExportEffectRow, ExportEffectsProjection } from "~/lib/export/export-effect-rows";
import type { NativeBuiltInParameterPayload } from "~/lib/processor-edit-semantics";
import { isAbortError } from "~/lib/dom-errors";
import { createAudioEffectParameterPayload } from "~/lib/audio-effect-parameter-payload";
import { audioEffectForms } from "~/lib/audio-effect-kinds";
import { createAudioEffectInstanceIdentityCache } from "~/components/timeline/create-effects-panel-instance-identity-cache";
import { createParameterGestureOwner, type ParameterDrain, type ParameterGestureHandle } from "~/components/timeline/parameter-gesture-owner";
import { effectAdmission, parameterSaveResult, type ParameterSaveResult } from "~/components/timeline/effect-publication-result";
import type { DeliveryRegistration, LiveProcessorEditIdentity, ProcessorDelivery } from "~/lib/live-processor-control";

export const registerAudioEffectCardInteractionCleanup = (input: {
  audioEffects: Accessor<{ interruptGesture: (instanceId: string, targetId?: string) => void }>;
  effectId: Accessor<string>;
  targetId: Accessor<string | undefined>;
  ownerKey: Accessor<string>;
}) => {
  // Keyed by identity strings: a card whose effect object is replaced by an equal one keeps its gesture.
  const identity = createMemo(() => `${input.ownerKey()}|${input.targetId() ?? ""}`);
  createEffect(on(identity, () => {
    if (!input.ownerKey()) return;
    const effectId = input.effectId();
    const audioEffects = input.audioEffects();
    const targetId = input.targetId();
    onCleanup(() => audioEffects.interruptGesture(effectId, targetId));
  }));
};

type RoomEffectRow = FunctionReturnType<typeof convexApi.effects.listByRoom>[number];

type EffectsPanelAudioEffectsContext = {
  acceptance?: PlaybackAcceptanceObserver;
  audioEngine: Accessor<AudioEngine>;
  tracks?: Accessor<Track[]>;
  projectId: Accessor<string | undefined>;
  userId: Accessor<string | undefined>;
  roomEffects: Accessor<RoomEffectRow[] | undefined>;
  // The controller's single local reader, shared with the audio sync; a device built alone makes its own.
  localEffectsView?: LocalEffectsViewSource;
  sidechainRoutes?: Accessor<ExternalSidechainRoute[]>;
  persistSidechainRoute?: (targetTrackId: string, effectInstanceId: string, sourceTrackId?: string) => Promise<void>;
  canWriteCurrentTargetEffects: Accessor<boolean>;
  usesLegacyAudioEngine?: Accessor<boolean>;
  projectGeneration?: Accessor<number>;
  allocateProcessorEdit?: (payload: NativeBuiltInParameterPayload) => LiveProcessorEditIdentity | undefined;
  deliverProcessor?: (edit: LiveProcessorEditIdentity, gesture?: ProcessorDelivery["gesture"]) => DeliveryRegistration;
  applyPortableProcessor?: (edit: LiveProcessorEditIdentity) => Promise<EngineDisposition | undefined>;
  persistAudioEffectOrder?: (targetId: string, order: AudioEffectInstance[]) => void | Promise<void>;
  onEffectParamsCommitted?: <Effect extends EffectType>(payload: EffectParamsCommitPayload<Effect>, projectId?: string, options?: EffectParamsCommitOptions) => void | Promise<void>;
  onLocalSaveFailed?: (projectId: string, message: string) => void;
  onEffectError?: (title: string, message: string) => void;
};

// Shared by the kinds whose panel binding is exactly add/change/reset/toggle over one params type.
type FlatAudioEffectBinding<Params> = {
  add: () => void;
  changeInstance: (instanceId: string, updates: (params: Params) => Params) => void;
  change: (updates: Partial<Params>) => void;
  reset: () => void;
  toggleEnabled: (enabled: boolean) => void;
};

type AudioEffectInstanceBinding<Params> = {
  changeInstance: (instanceId: string, updates: (params: Params) => Params) => void;
};

type EffectsPanelAudioDevice = {
  gestureOwner: (instanceId: string, kind: AudioEffectKind, targetId?: string) => ParameterGestureHandle;
  interruptGesture: (instanceId: string, targetId?: string) => void;
  utility: AudioEffectInstanceBinding<UtilityParamsEnvelope>;
  gate: {
    changeInstance: AudioEffectInstanceBinding<GateParamsEnvelope>["changeInstance"];
    setSidechainSource: (instanceId: string, sourceTrackId?: string) => Promise<void>;
  };
  limiter: {
    changeInstance: AudioEffectInstanceBinding<LimiterParamsEnvelope>["changeInstance"];
  };
  lofi: AudioEffectInstanceBinding<LoFiParamsEnvelope>;
  autofilter: AudioEffectInstanceBinding<AutoFilterParamsEnvelope>;
  chorus: AudioEffectInstanceBinding<ChorusParamsEnvelope>;
  flanger: AudioEffectInstanceBinding<FlangerParamsEnvelope>;
  phaser: AudioEffectInstanceBinding<PhaserParamsEnvelope>;
  tremolo: AudioEffectInstanceBinding<TremoloParamsEnvelope>;
  autopan: AudioEffectInstanceBinding<AutoPanParamsEnvelope>;
  ensemble: AudioEffectInstanceBinding<EnsembleParamsEnvelope>;
  spectrum: AudioEffectInstanceBinding<SpectrumParamsEnvelope>;
  eq: {
    add: () => void;
    changeInstance: (instanceId: string, updates: (params: EqParams) => EqParams) => void;
    changeBand: (bandId: string, updates: Partial<EqParams["bands"][number]>) => void;
    changeChannelMode: (mode: EqChannelMode) => void;
    reset: () => void;
    toggleBand: (bandId: string) => void;
    toggleEnabled: (enabled: boolean) => void;
  };
  compressor: FlatAudioEffectBinding<CompressorParams>;
  saturator: FlatAudioEffectBinding<SaturatorParams>;
  delay: FlatAudioEffectBinding<DelayParams>;
  spectral: {
    changeInstance: AudioEffectInstanceBinding<SpectralParamsEnvelope>["changeInstance"];
    setSidechainSource: (instanceId: string, sourceTrackId?: string) => Promise<void>;
  };
  addByKindToTarget: (targetId: Track["id"] | "master", effect: AudioEffectKind, index?: number) => Promise<boolean>;
  addChainToTarget: (targetId: Track["id"] | "master", effects: readonly AudioEffectChainPresetStep[], index?: number) => Promise<boolean>;
  canAddByKindToTarget: (targetId: Track["id"] | "master", effect: AudioEffectKind) => boolean;
  snapshotExportProjection: () => ExportEffectsProjection;
  snapshotExportRows: (targetIds: readonly string[]) => ExportEffectRow[];
  snapshotSidechainRoutes: () => ExternalSidechainRoute[];
  flushPending: () => Promise<ParameterDrain<{ targetId: string; instanceId: string; kind: AudioEffectKind }>>;
  paramsForInstance: (instance: AudioEffectInstance) => AudioEffectParamsByKind[AudioEffectKind] | undefined;
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
  reverb: FlatAudioEffectBinding<ReverbParams>;
};

export const indexFirstAudioEffectRowsByKind = <Row extends {
  targetId: string;
  instanceId?: string;
  kind: AudioEffectKind;
}>(rows: readonly Row[]) => {
  const indexed = new Map<string, Row>();

  for (const row of rows) {
    if (!row.instanceId) continue;
    const key = `${row.targetId}:${row.instanceId}:${row.kind}`;

    if (!indexed.has(key)) indexed.set(key, row);
  }

  return indexed;
};

export function createEffectsPanelAudioDevice(
  context: EffectsPanelAudioEffectsContext,
  currentTargetId: Accessor<string>,
  resolveTrackByTargetId: (targetId: string) => Track | undefined,
): EffectsPanelAudioDevice {
  const currentProjectGeneration = () => context.projectGeneration?.() ?? 0;

  const isLocalProject = createMemo(() => {
    const projectId = context.projectId();

    return Boolean(projectId && isLocalId("project", projectId));
  });

  const localEffectsView = context.localEffectsView ?? createLocalEffectsView({ projectId: context.projectId, onError: context.onEffectError });

  const persistEffectOperation = async (
    projectId: string,
    userId: string,
    operation: SharedTimelineOperation,
  ) => {
    const publication = await publishDurableEffectsOperation({ projectId, userId, operation });

    if (publication.kind === "rejected") throw new Error(publication.reason);

    return publication;
  };

  type AudioEffectParams = AudioEffectParamsByKind[AudioEffectKind];

  type AudioEffectInstanceBindings = {
    [Kind in AudioEffectKind]: AudioEffectInstanceBinding<AudioEffectParamsByKind[Kind]>;
  };

  type AudioEffectPanelRow = {
    targetId: string;
    kind: AudioEffectKind;
    instanceId?: string;
    index?: number;
    params: AudioEffectParams;
    through: number;
  };

  const projectLifetime = createMemo(() => ({ projectId: context.projectId(), generation: currentProjectGeneration() }), undefined, {
    equals: (previous, next) => previous.projectId === next.projectId && previous.generation === next.generation,
  });

  type ProjectLifetime = ReturnType<typeof projectLifetime>;

  type OptimisticOrder = { lifetime: ProjectLifetime; order: AudioEffectInstance[] };

  const [optimisticOrder, setOptimisticOrder] = createSignal<{ targetId: string } | undefined>(undefined, { equals: false });
  const optimisticOrdersByTarget = new Map<string, OptimisticOrder>();

  const optimisticOrderForTarget = (targetId: string) => {
    const entry = optimisticOrdersByTarget.get(targetId);

    return entry?.lifetime === projectLifetime() ? entry.order : undefined;
  };

  type SidechainPatch = { attempt: number; targetTrackId: string; effectInstanceId: string; sourceTrackId?: string };

  const sidechainPatches = new Map<string, SidechainPatch>();
  const pendingSidechainWrites = new Set<Promise<void>>();
  let sidechainAttempt = 0;

  type EffectParamsInput = RoomEffectRow["params"] | AudioEffectParams | null | undefined;

  const objectParamInput = (cause: EffectParamsInput): JsonObject => (
    isJsonObject(cause) ? cause : {}
  );

  const normalizeParamsForKind = (kind: AudioEffectKind, cause: EffectParamsInput): AudioEffectParams => {
    return AUDIO_EFFECT_CONTRACTS[kind].normalizeParams(objectParamInput(cause));
  };

  const audioEffectKindForHistoryEffect = (effect: EffectType): AudioEffectKind | undefined => {
    const kind = effect.replace(/^master-/, "");

    return isAudioEffectKind(kind) ? kind : undefined;
  };

  const createDefaultParamsForKind = (kind: AudioEffectKind): AudioEffectParams => {
    return AUDIO_EFFECT_CONTRACTS[kind].createDefaultParams();
  };

  const areParamsForKindEqual = areAudioEffectParamsEqual;

  const normalizePresetStepParams = (step: AudioEffectChainPresetStep): AudioEffectParams => {
    return normalizeParamsForKind(step.kind, step.params);
  };

  const defaultPresetStepByKind = {
    utility: () => ({ kind: "utility", params: AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams() }),
    autofilter: () => ({ kind: "autofilter", params: AUDIO_EFFECT_CONTRACTS.autofilter.createDefaultParams() }),
    gate: () => ({ kind: "gate", params: AUDIO_EFFECT_CONTRACTS.gate.createDefaultParams() }),
    limiter: () => ({ kind: "limiter", params: AUDIO_EFFECT_CONTRACTS.limiter.createDefaultParams() }),
    eq: () => ({ kind: "eq", params: AUDIO_EFFECT_CONTRACTS.eq.createDefaultParams() }),
    compressor: () => ({ kind: "compressor", params: AUDIO_EFFECT_CONTRACTS.compressor.createDefaultParams() }),
    saturator: () => ({ kind: "saturator", params: AUDIO_EFFECT_CONTRACTS.saturator.createDefaultParams() }),
    delay: () => ({ kind: "delay", params: AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams() }),
    reverb: () => ({ kind: "reverb", params: AUDIO_EFFECT_CONTRACTS.reverb.createDefaultParams() }),
    spectral: () => ({ kind: "spectral", params: AUDIO_EFFECT_CONTRACTS.spectral.createDefaultParams() }),
    chorus: () => ({ kind: "chorus", params: AUDIO_EFFECT_CONTRACTS.chorus.createDefaultParams() }),
    flanger: () => ({ kind: "flanger", params: AUDIO_EFFECT_CONTRACTS.flanger.createDefaultParams() }),
    phaser: () => ({ kind: "phaser", params: AUDIO_EFFECT_CONTRACTS.phaser.createDefaultParams() }),
    tremolo: () => ({ kind: "tremolo", params: AUDIO_EFFECT_CONTRACTS.tremolo.createDefaultParams() }),
    autopan: () => ({ kind: "autopan", params: AUDIO_EFFECT_CONTRACTS.autopan.createDefaultParams() }),
    lofi: () => ({ kind: "lofi", params: AUDIO_EFFECT_CONTRACTS.lofi.createDefaultParams() }),
    ensemble: () => ({ kind: "ensemble", params: AUDIO_EFFECT_CONTRACTS.ensemble.createDefaultParams() }),
    spectrum: () => ({ kind: "spectrum", params: AUDIO_EFFECT_CONTRACTS.spectrum.createDefaultParams() }),
  } satisfies Record<AudioEffectKind, () => AudioEffectChainPresetStep>;

  const createDefaultPresetStep = (kind: AudioEffectKind): AudioEffectChainPresetStep => defaultPresetStepByKind[kind]();

  const localEffectForKind = (targetId: string, kind: AudioEffectKind): LocalEffectKind => (
    targetId === "master" ? `master-${kind}` : kind
  );

  const instanceKey = (targetId: string, instanceId: string) => `${targetId}:${instanceId}`;

  type EffectTarget = { targetId: string; instanceId: string; kind: AudioEffectKind };

  const requiredInstanceId = (instanceId: string | undefined, kind: AudioEffectKind) => {
    if (!instanceId) throw new Error(`Audio effect "${kind}" is missing an instance ID.`);

    return instanceId;
  };

  const persistedInstanceCache = createAudioEffectInstanceIdentityCache();
  // Deferred: browser-mode effects may first run after setup has already created optimistic drafts.
  createEffect(on([context.projectId, currentProjectGeneration], () => persistedInstanceCache.reset(), { defer: true }));

  const normalizedPersistedAudioEffectRows = createMemo<AudioEffectPanelRow[]>(() => {
    if (isLocalProject()) {
      return (localEffectsView.view()?.rows ?? []).flatMap((row) => {
        const kind = AUDIO_EFFECT_KINDS.find((entry) => row.effect === entry || row.effect === AUDIO_EFFECT_CONTRACTS[entry].masterKind);

        return kind && row.params && row.instanceId ? [{
          targetId: row.targetId,
          through: localEffectsView.view()?.through ?? 0,
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
      const kind = AUDIO_EFFECT_KINDS.find((entry) => row.type === entry);

      return kind && row.params && row.instanceId ? [{
        targetId,
        through: row.revision ?? 0,
        kind,
        instanceId: row.instanceId,
        index: row.index,
        params: normalizeParamsForKind(kind, row.params),
      }] : [];
    });
  });

  const persistedRows = createMemo(() => {
    const rowsByTarget = new Map<string, AudioEffectPanelRow[]>();
    const rowsByInstance = new Map<string, AudioEffectPanelRow>();
    const rows = normalizedPersistedAudioEffectRows();

    for (const row of rows) {
      const rows = rowsByTarget.get(row.targetId) ?? [];
      rows.push(row);
      rowsByTarget.set(row.targetId, rows);
      const key = instanceKey(row.targetId, requiredInstanceId(row.instanceId, row.kind));
      rowsByInstance.set(key, row);
    }

    return {
      byTarget: rowsByTarget,
      byInstance: rowsByInstance,
      byInstanceAndKind: indexFirstAudioEffectRowsByKind(rows),
    };
  });

  const persistedRowsForTarget = (targetId: string): AudioEffectPanelRow[] => (
    persistedRows().byTarget.get(targetId) ?? []
  );

  const orderedInstancesForTarget = (targetId: string): AudioEffectInstance[] => {
    const rows = persistedRowsForTarget(targetId);

    const entries = rows
      .map((row) => ({ kind: row.kind, id: requiredInstanceId(row.instanceId, row.kind), index: row.index }))
      .sort(compareAudioEffectOrderEntries)
      .map((row) => persistedInstanceCache.instance(targetId, row.id, row.kind));

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

    return optimisticOrderForTarget(currentTargetId()) ?? persistedOrder;
  });

  createEffect(() => {
    const rows = normalizedPersistedAudioEffectRows();
    const optimistic = optimisticOrder();
    // Membership is persisted rows and optimistic additions, so a creation still pending persistence keeps its incarnation.
    persistedInstanceCache.retain([
      ...rows.flatMap((row) => row.instanceId ? [{ targetId: row.targetId, id: row.instanceId, kind: row.kind }] : []),
      ...[...optimisticOrdersByTarget.keys()].flatMap(targetId => (optimisticOrderForTarget(targetId) ?? []).map(entry => ({ targetId, id: entry.id, kind: entry.kind }))),
    ]);

    for (const targetId of optimisticOrdersByTarget.keys()) {
      const order = optimisticOrderForTarget(targetId);

      if (order && !areAudioEffectInstanceOrdersEqual(order, readPersistedOrderedEffectsForTarget(targetId))) continue;
      optimisticOrdersByTarget.delete(targetId);
    }

    if (optimistic && !optimisticOrdersByTarget.has(optimistic.targetId)) {
      setOptimisticOrder();
    }
  });

  const currentOrderForTarget = (targetId: string) => {
    return optimisticOrderForTarget(targetId)
      ?? (targetId === currentTargetId()
        ? orderedEffects()
        : readPersistedOrderedEffectsForTarget(targetId));
  };

  const effectIndexForTarget = (targetId: string, instanceId: string) => (
    persistedRowsForTarget(targetId).find((row) => row.instanceId === instanceId)?.index
  );

  const setOptimisticOrderForTarget = (targetId: string, order: AudioEffectInstance[]) => {
    optimisticOrdersByTarget.set(targetId, { lifetime: projectLifetime(), order });
    setOptimisticOrder({ targetId });
  };

  const rollbackOptimisticOrder = (targetId: string, order: AudioEffectInstance[], lifetime: ProjectLifetime) => {
    if (projectLifetime() !== lifetime) return;
    const optimistic = optimisticOrderForTarget(targetId);

    if (!optimistic || !areAudioEffectInstanceOrdersEqual(optimistic, order)) return;
    optimisticOrdersByTarget.delete(targetId);
    setOptimisticOrder();
    // Rollback is synchronous UI work; construction reports once, and in legacy mode flushPending joins its request.
    void applyStructureToEngine(targetId, readPersistedOrderedEffectsForTarget(targetId)).catch(() => {});
  };

  const persistReorder = async (targetId: string, order: AudioEffectInstance[], lifetime: ProjectLifetime) => {
    if (projectLifetime() !== lifetime) return;

    if (context.persistAudioEffectOrder) {
      await context.persistAudioEffectOrder(targetId, order);

      return;
    }

    const projectId = lifetime.projectId;

    if (!projectId) return;

    if (isLocalId("project", projectId)) {
      await reorderLocalAudioEffects(projectId, targetId, order);

      return;
    }

    const userId = context.userId();

    if (!userId) return;

    if (targetId === "master") {
      await persistEffectOperation(projectId, userId, {
        kind: "effects.reorderMasterAudioChain",
        payload: { order },
      });

      return;
    }

    const track = resolveTrackByTargetId(targetId);

    if (!track) return;
    await persistEffectOperation(projectId, userId, {
      kind: "effects.reorderAudioChain",
      payload: { trackId: track.id, order },
    });
  };

  const reorder = (instance: AudioEffectInstance, targetIndex: number) => {
    if (!context.canWriteCurrentTargetEffects()) return;
    reorderForTarget(currentTargetId(), instance, targetIndex);
  };

  const reorderForTarget = (targetId: string, instance: AudioEffectInstance, targetIndex: number) => {
    const lifetime = projectLifetime();
    const currentOrder = currentOrderForTarget(targetId);
    const fromIndex = currentOrder.findIndex((entry) => entry.id === instance.id);

    if (fromIndex < 0) return;
    const nextOrder = currentOrder.filter((entry) => entry.id !== instance.id);
    const clampedIndex = Math.max(0, Math.min(targetIndex, nextOrder.length));
    nextOrder.splice(clampedIndex, 0, instance);
    const normalized = normalizeAudioEffectInstanceOrder(nextOrder, currentOrder);

    if (areAudioEffectInstanceOrdersEqual(currentOrder, normalized)) return;
    setOptimisticOrderForTarget(targetId, normalized);
    // Reorder is a synchronous UI callback; construction reports once, and in legacy mode flushPending joins its request.
    void applyStructureToEngine(targetId, normalized).catch(() => {});
    // Persistence outlives the UI callback; rollback may only alter its captured project lifetime.
    void persistReorder(targetId, normalized, lifetime).catch(() =>
      untrack(() => rollbackOptimisticOrder(targetId, normalized, lifetime)),
    );
  };

  // Committed state: what retention and persistence see. A gesture's preview is not part of it. The export projection
  // does carry the preview: the native compile and the processor-edit registry must see the value the engine plays.
  const effectTarget = (targetId: string, instance: { id: string; kind: AudioEffectKind }): EffectTarget => ({ targetId, instanceId: instance.id, kind: instance.kind });
  const committedParamsForInstance = (targetId: string, instance: AudioEffectInstance) => owner.committed(effectTarget(targetId, instance));
  const effectiveParamsForInstance = (targetId: string, instance: AudioEffectInstance) => owner.effective(effectTarget(targetId, instance));
  const paramsForInstance = (instance: AudioEffectInstance) => effectiveParamsForInstance(currentTargetId(), instance);

  const exportRowForInstance = (targetId: string, instance: AudioEffectInstance & { kind: DspAudioEffectKind }, index: number, params: AudioEffectParams): ExportEffectRow => (
    { targetId, instanceId: instance.id, index, ...normalizeAudioEffectRow(instance.kind, params) }
  );

  const snapshotExportProjection = (): ExportEffectsProjection => {
    const ownedTargetIds = new Set([...optimisticOrdersByTarget.keys()].filter(targetId => optimisticOrderForTarget(targetId)));

    for (const row of normalizedPersistedAudioEffectRows()) ownedTargetIds.add(row.targetId);
    const replaceAudioEffectTargets: ExportEffectsProjection["replaceAudioEffectTargets"] = [];

    for (const targetId of ownedTargetIds) {
      const rows: ExportEffectRow[] = [];

      for (const [index, instance] of currentOrderForTarget(targetId).filter(isDspInstance).entries()) {
        const params = effectiveParamsForInstance(targetId, instance);

        if (params === undefined) continue;
        rows.push(exportRowForInstance(targetId, instance, index, params));
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

  // The Spectrum device only observes: it never reaches the engine, the native graph or an export.
  const isDspInstance = (instance: AudioEffectInstance): instance is AudioEffectInstance & { kind: DspAudioEffectKind } => instance.kind !== "spectrum";

  const runtimeInstanceForParams = (instance: AudioEffectInstance & { kind: DspAudioEffectKind }, params: AudioEffectParams): AudioEffectRuntimeInstance => (
    { id: instance.id, ...normalizeAudioEffect(instance.kind, params) }
  );

  function buildRuntimeInstancesForTarget(targetId: string, order: AudioEffectInstance[]): AudioEffectRuntimeInstance[] {
    return order.filter(isDspInstance).flatMap((instance) => {
      const params = effectiveParamsForInstance(targetId, instance);

      return params ? [runtimeInstanceForParams(instance, params)] : [];
    });
  }

  async function commitInstanceParams(projectId: string | undefined, targetId: string, instanceId: string | undefined, kind: AudioEffectKind, previous: AudioEffectParams, next: AudioEffectParams, edit: LiveProcessorEditIdentity | undefined, options: EffectParamsCommitOptions) {
    if (areParamsForKindEqual(kind, previous, next)) return;
    const payload = { ...createAudioEffectParameterPayload({ targetId, instanceId: instanceId ?? "", kind }, previous, next), edit };
    await context.onEffectParamsCommitted?.(payload, projectId, options);
  }

  function applyInstancesToEngine(targetId: string, order: AudioEffectInstance[]) {
    const instances = buildRuntimeInstancesForTarget(targetId, order);

    return targetId === "master"
      ? context.audioEngine().setMasterFxInstances(instances)
      : context.audioEngine().setTrackFxInstances(targetId, instances);
  }

  // Share structural requests with explicit UI changes and flushPending. The engine's existing
  // admission owns in-flight supersession; this map is not another parameter owner or FIFO.
  type StructuralApplication = {
    signature: string;
    engine: AudioEngine;
    pending: Promise<EngineDisposition>;
    supersede: () => void;
  };

  const structuralApplications = new Map<string, StructuralApplication>();

  const legacyInstallation = createMemo<{ legacy: boolean; epoch: number }>(previous => {
    const legacy = context.usesLegacyAudioEngine?.() ?? true;

    return { legacy, epoch: (previous?.epoch ?? 0) + (legacy && previous?.legacy === false ? 1 : 0) };
  });

  // Joined owner applications observe the same rejection, but only its construction announces it.
  const reportedStructuralFailures = new WeakSet<Error>();

  const recordStructuralApplication = (targetId: string, signature: string, engine: AudioEngine, work: Promise<EngineDisposition>) => {
    let supersede: StructuralApplication["supersede"] = () => {};
    const superseded = new Promise<EngineDisposition>(resolve => { supersede = () => resolve("superseded"); });

    const entry: StructuralApplication = {
      signature, engine, supersede,
      pending: Promise.race([work, superseded]).then(result => {
        const current = structuralApplications.get(targetId);

        return current === entry ? result : current?.pending ?? "superseded";
      }, cause => {
        const current = structuralApplications.get(targetId);

        if (current === entry) throw cause;

        return current?.pending ?? "superseded";
      }),
    };

    const previous = structuralApplications.get(targetId);
    structuralApplications.set(targetId, entry);
    // Existing flush waiters adopt the newer completion, not an obsolete construction or a FIFO.
    previous?.supersede();
    // Detached retention cleanup only: current failures remain in pending and are observable by flush.
    void entry.pending.then(() => untrack(() => {
      if (structuralApplications.get(targetId) === entry && currentOrderForTarget(targetId).length === 0
        && persistedRowsForTarget(targetId).length === 0) structuralApplications.delete(targetId);
    }), () => {});

    return entry;
  };

  const ensureStructuralApplication = (targetId: string, order: AudioEffectInstance[]) => {
    const engine = context.audioEngine();
    const signature = JSON.stringify([context.projectId(), currentProjectGeneration(), legacyInstallation().epoch, order.map(instance => [instance.id, instance.kind])]);
    const previous = structuralApplications.get(targetId);

    if (previous?.signature === signature && previous.engine === engine) return previous;
    const pending = applyInstancesToEngine(targetId, order);
    // Report actual construction failures even after supersession; only the current completion gates flush.
    void pending.catch(cause => {
      if (cause instanceof Error) reportedStructuralFailures.add(cause);
      reportEngineError(cause);
    });

    return recordStructuralApplication(targetId, signature, engine, pending);
  };

  const applyStructureToEngine = (targetId: string, order = currentOrderForTarget(targetId)) => (
    (context.usesLegacyAudioEngine?.() ?? true)
      ? ensureStructuralApplication(targetId, order).pending
      : applyInstancesToEngine(targetId, order).catch(cause => {
        reportEngineError(cause);
        throw cause;
      })
  );

  // The project is the one the edit was released in, not the one attached when the write finally runs.
  const writeInstanceParams = async (projectId: string | undefined, userId: string | undefined, targetId: string, instanceId: string, kind: AudioEffectKind, cause: EffectParamsInput) => {
    if (!projectId) return;
    const input = objectParamInput(cause);

    if (isLocalId("project", projectId)) {
      return await setLocalEffectInstance(projectId, targetId, localEffectForKind(targetId, kind), normalizeParamsForKind(kind, input), { instanceId });
    }

    if (!userId) return;

    return await persistEffectOperation(projectId, userId, audioEffectForms(kind, undefined, input).persist(targetId, instanceId));
  };

  const persistInstanceParams = async (projectId: string | undefined, userId: string | undefined, targetId: string, instanceId: string, kind: AudioEffectKind, params: EffectParamsInput): Promise<ParameterSaveResult> => {
    try {
      const result = await writeInstanceParams(projectId, userId, targetId, instanceId, kind, params);

      return result ? parameterSaveResult(result) : { kind: "rejected", reason: "The effect write has no project or user." };
    } catch (cause) {
      if (projectId && isLocalId("project", projectId)) {
        context.onLocalSaveFailed?.(projectId, cause instanceof Error ? cause.message : "Local effect could not be saved.");
      } else {
        context.onEffectError?.("Effect save failed", cause instanceof Error ? cause.message : "The effect could not be saved.");
      }

      throw cause;
    }
  };

  const updateInstance = (instanceId: string, kind: AudioEffectKind, updater: (prev: AudioEffectParams) => AudioEffectParams) => {
    if (!context.canWriteCurrentTargetEffects()) return;
    owner.write({ targetId: currentTargetId(), instanceId, kind }, (prev) => normalizeParamsForKind(kind, updater(prev)));
  };

  const updateEq = (updater: (prev: EqParams) => EqParams) => {
    const instance = orderedEffects().find((entry) => entry.kind === "eq");

    if (instance) updateInstance(instance.id, "eq", (prev) => updater(normalizeEqParams(objectParamInput(prev))));
  };

  function reportEngineError(cause: unknown) {
    if (isAbortError(cause)) return;
    context.onEffectError?.(
      "Effect playback update failed",
      cause instanceof Error ? cause.message : "The effect could not be applied to playback.",
    );
  }

  const reportReleaseFailure = (cause: unknown, projectId: string | undefined) => {
    if (isAbortError(cause)) return;
    const message = cause instanceof Error ? cause.message : "The effect could not be applied to playback.";

    if (projectId && isLocalId("project", projectId)) context.onLocalSaveFailed?.(projectId, message);
    else context.onEffectError?.("Effect playback update failed", message);
  };

  const applyToEngine = async (target: EffectTarget, params: AudioEffectParams): Promise<EngineDisposition> => {
    const order = currentOrderForTarget(target.targetId);
    const instance = order.find((entry) => entry.id === target.instanceId && entry.kind === target.kind);

    if (!instance) return "superseded";

    if (!isDspInstance(instance)) return "skipped";
    const structural = ensureStructuralApplication(target.targetId, order);
    const runtime = runtimeInstanceForParams(instance, params);
    const engine = context.audioEngine();
    // Submit before awaiting: a retired owner cannot wake behind a newer structure and write stale content.
    const replacement = target.targetId === "master" ? engine.setMasterFxInstance(runtime) : engine.setTrackFxInstance(target.targetId, runtime);

    // The replacement, or its fresh-order fallback, is authoritative for this owner, never older structure.
    const applied = replacement.then(replaced => untrack(() => replaced !== "not-held" ? replaced
      : applyInstancesToEngine(target.targetId, currentOrderForTarget(target.targetId))));

    const current = recordStructuralApplication(target.targetId, structural.signature, engine, applied);

    // Preserve a settled replacement's own result; only still-pending obsolete work joins its successor.
    const settled = await Promise.race([applied, current.pending.then(
      result => result === "applied" || result === "joined" || result === "skipped" ? result : applied,
      () => applied,
    )]);

    // The engine builds every replacement from the chain last requested, so the request that supersedes this one
    // carries its content: this release is installed exactly when that successor is.
    return settled === "superseded" ? current.pending.catch(() => settled) : settled;
  };

  const owner = createParameterGestureOwner<EffectTarget, AudioEffectParams>({
    acceptance: context.acceptance,
    key: (target) => instanceKey(target.targetId, target.instanceId),
    scope: () => ({ projectId: context.projectId(), userId: context.userId(), generation: currentProjectGeneration() }),
    exists: (target) => currentOrderForTarget(target.targetId).some((entry) => entry.id === target.instanceId && entry.kind === target.kind),
    canWrite: context.canWriteCurrentTargetEffects,
    equal: (target, a, b) => areParamsForKindEqual(target.kind, a, b),
    initial: (target) => createDefaultParamsForKind(target.kind),
    committed: (target) => persistedRows().byInstanceAndKind.get(`${instanceKey(target.targetId, target.instanceId)}:${target.kind}`)?.params,
    rowsReachEngine: () => true,
    apply: (target, params, edit) => (context.usesLegacyAudioEngine?.() ?? true) ? applyToEngine(target, params) : edit ? context.applyPortableProcessor?.(edit) : undefined,
    registerDelivery: (_target, _params, edit, gesture) => !(context.usesLegacyAudioEngine?.() ?? true) && edit ? context.deliverProcessor?.(edit, gesture) : undefined,
    persist: (record) => persistInstanceParams(record.lifetime.projectId, record.lifetime.userId, record.target.targetId, record.target.instanceId, record.target.kind, record.latest),
    admission: effectAdmission,
    history: (record) => {
      const { targetId, instanceId, kind } = record.target;
      // The owner history callback is synchronous; completion reports through the existing error boundary.
      void commitInstanceParams(record.lifetime.projectId, targetId, instanceId, kind, record.baseline ?? createDefaultParamsForKind(kind), record.latest, record.edit, { mergeHistory: false }).catch(reportEngineError);
    },
    // The edit registry reuses the identity of equal content, so a write, its history replay and its row echo share one edit.
    allocateEdit: (target, _from, to) => context.allocateProcessorEdit?.(createAudioEffectParameterPayload(target, to, to)),
    // persistInstanceParams has already reported a failed save.
    onError: (stage, cause, record) => {
      if (stage === "persist") return;

      if (cause instanceof Error && reportedStructuralFailures.has(cause)) {
        if (record?.lifetime.projectId && isLocalId("project", record.lifetime.projectId)) {
          reportReleaseFailure(cause, record.lifetime.projectId);
        }

        return;
      }

      if (record) reportReleaseFailure(cause, record.lifetime.projectId);
      else reportEngineError(cause);
    },
  });

  // Rows echo into the owner; a row that disappears is a removal.
  let seenTargets = new Map<string, EffectTarget>();
  createEffect(() => {
    const rows = persistedRows().byInstance;

    if (isLocalProject() ? localEffectsView.view()?.projectId !== context.projectId() : context.roomEffects() === undefined) return;
    const next = new Map<string, EffectTarget>();
    untrack(() => {
      for (const [key, row] of rows) {
        const target = { targetId: row.targetId, instanceId: requiredInstanceId(row.instanceId, row.kind), kind: row.kind };
        const previous = seenTargets.get(key);

        if (previous && previous.kind !== target.kind) owner.external(previous, undefined);
        next.set(key, target);
        owner.external(target, row.params, row.through);
      }

      for (const [key, target] of seenTargets) if (!next.has(key)) owner.external(target, undefined);
    });
    seenTargets = next;
  });
  // One signature lane covers additions, removals (including the last row), kinds and order.
  // Observe rows first so the one chain builder reads their fresh effective params.
  createEffect(() => {
    const trackIds = context.tracks ? new Set(context.tracks().map(track => track.id)) : undefined;

    for (const [targetId, entry] of structuralApplications) {
      if (targetId !== "master" && trackIds && !trackIds.has(targetId)) {
        structuralApplications.delete(targetId);
        entry.supersede();
      }
    }

    if (!legacyInstallation().legacy) return;
    const rows = normalizedPersistedAudioEffectRows();
    optimisticOrder();
    context.projectId(); currentProjectGeneration(); context.audioEngine();

    if (isLocalProject() ? localEffectsView.view()?.projectId !== context.projectId() : context.roomEffects() === undefined) return;
    const targets = new Set([...structuralApplications.keys(), ...optimisticOrdersByTarget.keys(), ...rows.map(row => row.targetId)]);
    untrack(() => {
      for (const targetId of targets) {
        if (targetId !== "master" && trackIds && !trackIds.has(targetId)) continue;
        // Effects cannot await; construction reports once and flushPending joins the same promise.
        void applyStructureToEngine(targetId).catch(() => {});
      }
    });
  });
  // Losing write access ends every open gesture without committing it.
  createEffect(on(context.canWriteCurrentTargetEffects, (canWrite) => {
    if (!canWrite) owner.closeAll("cancel");
  }, { defer: true }));

  const gestureOwner: EffectsPanelAudioDevice["gestureOwner"] = (instanceId, kind, targetId = currentTargetId()) => (
    owner.handle(() => ({ targetId, instanceId, kind }))
  );

  const createInstanceBinding = <Params extends AudioEffectParams>(
    kind: AudioEffectKind,
    normalize: (params: AudioEffectParams) => Params,
  ): AudioEffectInstanceBinding<Params> => ({
    changeInstance: (instanceId, updater) => updateInstance(instanceId, kind, (prev) => updater(normalize(prev))),
  });

  const instanceBindingByKind = {
    utility: createInstanceBinding("utility", (prev) => normalizeUtilityParamsEnvelope(prev)),
    autofilter: createInstanceBinding("autofilter", (prev) => AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams(prev)),
    eq: createInstanceBinding("eq", (prev) => normalizeEqParams(objectParamInput(prev))),
    gate: createInstanceBinding("gate", (prev) => normalizeGateParamsEnvelope(prev)),
    limiter: createInstanceBinding("limiter", (prev) => AUDIO_EFFECT_CONTRACTS.limiter.normalizeParams(prev)),
    lofi: createInstanceBinding("lofi", (prev) => AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams(prev)),
    compressor: createInstanceBinding("compressor", (prev) => normalizeCompressorParams(objectParamInput(prev))),
    saturator: createInstanceBinding("saturator", (prev) => normalizeSaturatorParams(objectParamInput(prev))),
    delay: createInstanceBinding("delay", (prev) => normalizeDelayParams(objectParamInput(prev))),
    reverb: createInstanceBinding("reverb", (prev) => normalizeReverbParams(objectParamInput(prev))),
    spectral: createInstanceBinding("spectral", (prev) => AUDIO_EFFECT_CONTRACTS.spectral.normalizeParams(prev)),
    chorus: createInstanceBinding("chorus", (prev) => AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams(prev)),
    flanger: createInstanceBinding("flanger", (prev) => AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams(prev)),
    phaser: createInstanceBinding("phaser", (prev) => AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams(prev)),
    tremolo: createInstanceBinding("tremolo", (prev) => AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams(prev)),
    autopan: createInstanceBinding("autopan", (prev) => AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams(prev)),
    ensemble: createInstanceBinding("ensemble", (prev) => AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams(prev)),
    spectrum: createInstanceBinding("spectrum", (prev) => AUDIO_EFFECT_CONTRACTS.spectrum.normalizeParams(prev)),
  } satisfies AudioEffectInstanceBindings;

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
    const lifetime = projectLifetime();
    const userId = context.userId();
    const previousOrder = currentOrderForTarget(targetId);

    if (effects.length === 0) return false;

    const entries = effects.map((effect) => ({
      instance: { id: createAudioEffectInstanceId(), kind: effect.kind },
      params: normalizePresetStepParams(effect),
    }));

    const instances = entries.map((entry) => entry.instance);

    for (const entry of entries) owner.replay(effectTarget(targetId, entry.instance), entry.params);
    const nextOrder = [...previousOrder];
    nextOrder.splice(index === undefined ? nextOrder.length : Math.max(0, Math.min(index, nextOrder.length)), 0, ...instances);
    setOptimisticOrderForTarget(targetId, nextOrder);
    const persisted: AudioEffectInstance[] = [];

    try {
      await applyStructureToEngine(targetId, nextOrder);

      if (projectLifetime() !== lifetime) return false;

      for (const entry of entries) {
        await persistInstanceParams(lifetime.projectId, userId, targetId, entry.instance.id, entry.instance.kind, entry.params);

        if (projectLifetime() !== lifetime) return false;
        persisted.push(entry.instance);
      }

      await persistReorder(targetId, nextOrder, lifetime);

      if (projectLifetime() !== lifetime) return false;

      return true;
    } catch {
      if (projectLifetime() !== lifetime) return false;
      const projectId = lifetime.projectId;

      if (projectId) {
        await Promise.allSettled(persisted.map((instance) => deleteInstanceFromTarget(targetId, instance, projectId)));
        await persistReorder(targetId, previousOrder, lifetime).catch(() => undefined);
      }

      if (projectLifetime() !== lifetime) return false;

      for (const entry of entries) owner.discard(effectTarget(targetId, entry.instance));
      setOptimisticOrderForTarget(targetId, previousOrder);
      await applyStructureToEngine(targetId, previousOrder).catch(() => undefined);

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
      await persistEffectOperation(projectId, userId, { kind: "effects.removeAudioEffect", payload: { targetType: "master", effect: instance.kind, instanceId } });

      return true;
    }

    const track = resolveTrackByTargetId(targetId);

    if (!track) return false;
    await persistEffectOperation(projectId, userId, { kind: "effects.removeAudioEffect", payload: { targetType: "track", trackId: track.id, effect: instance.kind, instanceId } });

    return true;
  };

  // Ends active gestures and waits for queued flush/persist work, so nothing writes a row after it is deleted.
  // A removed instance has nothing to restore: its gestures just end.
  const settleInstances = async (targetId: string, instances: readonly AudioEffectInstance[]) => {
    for (const instance of instances) owner.close(effectTarget(targetId, instance), "drop");
    await Promise.all(instances.map((instance) => owner.settle(effectTarget(targetId, instance))));
  };

  const removeByInstanceFromTarget = async (targetId: Track["id"] | "master", instance: AudioEffectInstance) => {
    const lifetime = projectLifetime();

    if (!context.canWriteCurrentTargetEffects()) return false;
    const currentOrder = currentOrderForTarget(targetId);

    if (!currentOrder.some((entry) => entry.id === instance.id)) return false;
    const projectId = context.projectId();

    if (!projectId) return false;
    const nextOrder = currentOrder.filter((entry) => entry.id !== instance.id);
    setOptimisticOrderForTarget(targetId, nextOrder);
    await settleInstances(targetId, [instance]);

    if (projectLifetime() !== lifetime) return false;
    await applyStructureToEngine(targetId, nextOrder);

    if (projectLifetime() !== lifetime) return false;

    try {
      const deleted = await deleteInstanceFromTarget(targetId, instance, projectId);

      if (projectLifetime() !== lifetime) return false;

      if (!deleted) {
        setOptimisticOrderForTarget(targetId, currentOrder);
        await applyStructureToEngine(targetId, currentOrder);

        return false;
      }

      await persistReorder(targetId, nextOrder, lifetime);

      if (projectLifetime() !== lifetime) return false;
      owner.discard(effectTarget(targetId, instance));

      return true;
    } catch (error) {
      if (projectLifetime() !== lifetime) throw error;
      setOptimisticOrderForTarget(targetId, currentOrder);
      await applyStructureToEngine(targetId, currentOrder);
      throw error;
    }
  };

  const replayInstanceParams: EffectsPanelAudioDevice["replayInstanceParams"] = (payload) => {
    const kind = audioEffectKindForHistoryEffect(payload.effect);

    if (!kind) return false;
    const order = payload.targetId === currentTargetId() ? orderedEffects() : readPersistedOrderedEffectsForTarget(payload.targetId);

    if (!order.some((entry) => entry.id === payload.instanceId && entry.kind === kind)) return false;
    const params = normalizeParamsForKind(kind, payload.params);

    // An undo during a gesture moves only the committed value and the baseline. The preview and what the engine holds
    // stay, Escape restores the new baseline, and a release commits baseline to latest.
    if (owner.replay({ targetId: payload.targetId, instanceId: payload.instanceId, kind }, params)) return true;
    // Synchronous replay fallback; history replay remains best-effort when no owner can accept it.
    void applyInstancesToEngine(payload.targetId, order).catch(() => undefined);

    return true;
  };

  const removeAllFromTarget = async (targetId: Track["id"] | "master") => {
    const lifetime = projectLifetime();

    if (!context.canWriteCurrentTargetEffects()) return false;
    const currentOrder = currentOrderForTarget(targetId);

    if (currentOrder.length === 0) return false;
    const projectId = context.projectId();

    if (!projectId) return false;
    setOptimisticOrderForTarget(targetId, []);
    await settleInstances(targetId, currentOrder);

    if (projectLifetime() !== lifetime) return false;
    await applyStructureToEngine(targetId, []);

    if (projectLifetime() !== lifetime) return false;

    try {
      const deleted = await Promise.all(currentOrder.map((instance) => deleteInstanceFromTarget(targetId, instance, projectId)));

      if (projectLifetime() !== lifetime) return false;

      if (!deleted.every(Boolean)) {
        setOptimisticOrderForTarget(targetId, currentOrder);
        await applyStructureToEngine(targetId, currentOrder);

        return false;
      }

      await persistReorder(targetId, [], lifetime);

      if (projectLifetime() !== lifetime) return false;

      for (const instance of currentOrder) owner.discard(effectTarget(targetId, instance));

      return true;
    } catch (error) {
      if (projectLifetime() !== lifetime) throw error;
      setOptimisticOrderForTarget(targetId, currentOrder);
      await applyStructureToEngine(targetId, currentOrder);
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
      await persistEffectOperation(projectId, userId, sourceTrackId
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
      const rows = currentOrderForTarget(targetId).filter(isDspInstance).flatMap((instance, index) => {
        const params = committedParamsForInstance(targetId, instance);

        if (params === undefined) return [];

        return [exportRowForInstance(targetId, instance, index, params)];
      });

      return rows;
    }),
    snapshotSidechainRoutes,
    addByKindToTarget,
    addChainToTarget,
    canAddByKindToTarget,
    gestureOwner,
    interruptGesture: (instanceId, targetId = currentTargetId()) => {
      const instance = currentOrderForTarget(targetId).find((entry) => entry.id === instanceId);

      if (instance) owner.close(effectTarget(targetId, instance), "cancel");
    },
    utility: instanceBindingByKind.utility,
    gate: {
      ...instanceBindingByKind.gate,
      setSidechainSource,
    },
    limiter: {
      ...instanceBindingByKind.limiter,
    },
    autofilter: {
      ...instanceBindingByKind.autofilter,
    },
    chorus: {
      ...instanceBindingByKind.chorus,
    },
    flanger: {
      ...instanceBindingByKind.flanger,
    },
    phaser: {
      ...instanceBindingByKind.phaser,
    },
    tremolo: {
      ...instanceBindingByKind.tremolo,
    },
    autopan: {
      ...instanceBindingByKind.autopan,
    },
    ensemble: {
      ...instanceBindingByKind.ensemble,
    },
    lofi: {
      ...instanceBindingByKind.lofi,
    },
    spectrum: instanceBindingByKind.spectrum,
    spectral: {
      ...instanceBindingByKind.spectral,
      setSidechainSource,
    },
    eq: {
      add: addEq,
      ...instanceBindingByKind.eq,
      changeBand: (bandId, updates) => updateEq((prev) => ({
        ...prev,
        bands: prev.bands.map((band) => band.id === bandId ? { ...band, ...updates } : band),
      })),
      changeChannelMode: (channelMode) => updateEq((prev) => (
        prev.channelMode === channelMode ? prev : normalizeEqParams({ ...prev, channelMode })
      )),
      reset: () => updateEq(() => AUDIO_EFFECT_CONTRACTS.eq.createDefaultParams()),
      toggleBand: (bandId) => updateEq((prev) => ({
        ...prev,
        bands: prev.bands.map((band) => band.id === bandId ? { ...band, enabled: !band.enabled } : band),
      })),
      toggleEnabled: (enabled) => updateEq((prev) => ({ ...prev, enabled })),
    },
    flushPending: async () => {
      const [drain] = await Promise.all([owner.flushPending(), ...pendingSidechainWrites]);
      await Promise.all([...structuralApplications.values()].map(entry => entry.pending));

      return drain;
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
      ...instanceBindingByKind.compressor,
      change: (updates) => updateCompressor((prev) => normalizeCompressorParams({ ...prev, ...updates })),
      reset: () => updateCompressor(() => AUDIO_EFFECT_CONTRACTS.compressor.createDefaultParams()),
      toggleEnabled: (enabled) => updateCompressor((prev) => ({ ...prev, enabled })),
    },
    saturator: {
      add: addSaturator,
      ...instanceBindingByKind.saturator,
      change: (updates) => updateSaturator((prev) => normalizeSaturatorParams({ ...prev, ...updates })),
      reset: () => updateSaturator(() => AUDIO_EFFECT_CONTRACTS.saturator.createDefaultParams()),
      toggleEnabled: (enabled) => updateSaturator((prev) => ({ ...prev, enabled })),
    },
    delay: {
      add: addDelay,
      ...instanceBindingByKind.delay,
      change: (updates) => updateDelay((prev) => normalizeDelayParams({ ...prev, ...updates })),
      reset: () => updateDelay(() => AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams()),
      toggleEnabled: (enabled) => updateDelay((prev) => ({ ...prev, enabled })),
    },
    reverb: {
      add: addReverb,
      ...instanceBindingByKind.reverb,
      change: (updates) => updateReverb((prev) => normalizeReverbParams({ ...prev, ...updates })),
      reset: () => updateReverb(() => AUDIO_EFFECT_CONTRACTS.reverb.createDefaultParams()),
      toggleEnabled: (enabled) => updateReverb((prev) => ({ ...prev, enabled })),
    },
  };
}
