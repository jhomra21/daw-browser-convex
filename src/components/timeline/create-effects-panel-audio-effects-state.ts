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
type EqRow = RoomEffectRow | LocalEffectRow<EqParams> | undefined;
type SaturatorRow = RoomEffectRow | LocalEffectRow<SaturatorParams> | undefined;
type DelayRow = RoomEffectRow | LocalEffectRow<DelayParams> | undefined;
type ReverbRow = RoomEffectRow | LocalEffectRow<ReverbParams> | undefined;

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

  const eqState = createPersistedEffectState<EqRow, EqParams>({
    targetId: currentTargetId,
    scopeId: context.projectId,
    row: () => isLocalProject() ? localEq.row(currentTargetId()) : remoteEffectForTarget(currentTargetId(), "eq"),
    readQueryParams: (row) => row?.params ? normalizeEqParams(row.params) : undefined,
    createInitialParams: () => createDefaultEqParams(),
    serializeParams: serializeEqParams,
    applyToEngine: (targetId, params) => {
      if (targetId === "master") {
        context.audioEngine().setMasterEq(params);
      } else {
        context.audioEngine().setTrackEq(targetId, params);
      }
    },
    createPersistContext: () => ({ projectId: context.projectId(), userId: context.userId() }),
    persistParams: (targetId, params, persistContext) => {
      if (!persistContext.projectId) return Promise.resolve();
      if (isLocalId("project", persistContext.projectId)) return localEq.persist(persistContext.projectId, targetId, params);
      if (!persistContext.userId) return Promise.resolve();
      if (targetId === "master") {
        return publishEffectOperation(persistContext.projectId, persistContext.userId, {
          kind: "effects.setMasterEqParams",
          payload: { params: normalizeEqParams(params) },
        });
      }
      const track = resolveTrackByTargetId(targetId);
      if (!track) return Promise.resolve();
      return publishEffectOperation(persistContext.projectId, persistContext.userId, {
        kind: "effects.setEqParams",
        payload: { trackId: track.id, params: normalizeEqParams(params) },
      });
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
        context.onEffectParamsCommitted?.({ targetId: "master", effect: "master-eq", from: previous, to: next }, persistContext.projectId);
        return;
      }
      const track = resolveTrackByTargetId(targetId);
      if (!track) return;
      context.onEffectParamsCommitted?.({ targetId: track.id, effect: "eq", from: previous, to: next }, persistContext.projectId);
    },
  });

  const reverbState = createPersistedEffectState<ReverbRow, ReverbParams>({
    targetId: currentTargetId,
    scopeId: context.projectId,
    row: () => isLocalProject() ? localReverb.row(currentTargetId()) : remoteEffectForTarget(currentTargetId(), "reverb"),
    readQueryParams: (row) => row?.params ? normalizeReverbParams(row.params) : undefined,
    createInitialParams: () => createDefaultReverbParams(),
    serializeParams: serializeReverbParams,
    applyToEngine: (targetId, params) => {
      if (targetId === "master") {
        context.audioEngine().setMasterReverb(params);
      } else {
        context.audioEngine().setTrackReverb(targetId, params);
      }
    },
    createPersistContext: () => ({ projectId: context.projectId(), userId: context.userId() }),
    persistParams: (targetId, params, persistContext) => {
      if (!persistContext.projectId) return Promise.resolve();
      if (isLocalId("project", persistContext.projectId)) return localReverb.persist(persistContext.projectId, targetId, params);
      if (!persistContext.userId) return Promise.resolve();
      const normalizedParams = normalizeReverbParams(params);
      if (targetId === "master") {
        return publishEffectOperation(persistContext.projectId, persistContext.userId, {
          kind: "effects.setMasterReverbParams",
          payload: { params: normalizedParams },
        });
      }
      const track = resolveTrackByTargetId(targetId);
      if (!track) return Promise.resolve();
      return publishEffectOperation(persistContext.projectId, persistContext.userId, {
        kind: "effects.setReverbParams",
        payload: { trackId: track.id, params: normalizedParams },
      });
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
        context.onEffectParamsCommitted?.({ targetId: "master", effect: "master-reverb", from: previous, to: next }, persistContext.projectId);
        return;
      }
      const track = resolveTrackByTargetId(targetId);
      if (!track) return;
      context.onEffectParamsCommitted?.({ targetId: track.id, effect: "reverb", from: previous, to: next }, persistContext.projectId);
    },
  });

  const saturatorState = createPersistedEffectState<SaturatorRow, SaturatorParams>({
    targetId: currentTargetId,
    scopeId: context.projectId,
    row: () => isLocalProject() ? localSaturator.row(currentTargetId()) : remoteEffectForTarget(currentTargetId(), "saturator"),
    readQueryParams: (row) => row?.params ? normalizeSaturatorParams(row.params) : undefined,
    createInitialParams: () => createDefaultSaturatorParams(),
    serializeParams: serializeSaturatorParams,
    applyToEngine: (targetId, params) => {
      if (targetId === "master") context.audioEngine().setMasterSaturator(params);
      else context.audioEngine().setTrackSaturator(targetId, params);
    },
    createPersistContext: () => ({ projectId: context.projectId(), userId: context.userId() }),
    persistParams: (targetId, params, persistContext) => {
      if (!persistContext.projectId) return Promise.resolve();
      if (isLocalId("project", persistContext.projectId)) return localSaturator.persist(persistContext.projectId, targetId, params);
      if (!persistContext.userId) return Promise.resolve();
      const normalizedParams = normalizeSaturatorParams(params);
      if (targetId === "master") {
        return publishEffectOperation(persistContext.projectId, persistContext.userId, {
          kind: "effects.setMasterSaturatorParams",
          payload: { params: normalizedParams },
        });
      }
      const track = resolveTrackByTargetId(targetId);
      if (!track) return Promise.resolve();
      return publishEffectOperation(persistContext.projectId, persistContext.userId, {
        kind: "effects.setSaturatorParams",
        payload: { trackId: track.id, params: normalizedParams },
      });
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
        context.onEffectParamsCommitted?.({ targetId: "master", effect: "master-saturator", from: previous, to: next }, persistContext.projectId);
        return;
      }
      const track = resolveTrackByTargetId(targetId);
      if (!track) return;
      context.onEffectParamsCommitted?.({ targetId: track.id, effect: "saturator", from: previous, to: next }, persistContext.projectId);
    },
  });

  const delayState = createPersistedEffectState<DelayRow, DelayParams>({
    targetId: currentTargetId,
    scopeId: context.projectId,
    row: () => isLocalProject() ? localDelay.row(currentTargetId()) : remoteEffectForTarget(currentTargetId(), "delay"),
    readQueryParams: (row) => row?.params ? normalizeDelayParams(row.params) : undefined,
    createInitialParams: () => createDefaultDelayParams(),
    serializeParams: serializeDelayParams,
    applyToEngine: (targetId, params) => {
      if (targetId === "master") context.audioEngine().setMasterDelay(params);
      else context.audioEngine().setTrackDelay(targetId, params);
    },
    createPersistContext: () => ({ projectId: context.projectId(), userId: context.userId() }),
    persistParams: (targetId, params, persistContext) => {
      if (!persistContext.projectId) return Promise.resolve();
      if (isLocalId("project", persistContext.projectId)) return localDelay.persist(persistContext.projectId, targetId, params);
      if (!persistContext.userId) return Promise.resolve();
      const normalizedParams = normalizeDelayParams(params);
      if (targetId === "master") {
        return publishEffectOperation(persistContext.projectId, persistContext.userId, {
          kind: "effects.setMasterDelayParams",
          payload: { params: normalizedParams },
        });
      }
      const track = resolveTrackByTargetId(targetId);
      if (!track) return Promise.resolve();
      return publishEffectOperation(persistContext.projectId, persistContext.userId, {
        kind: "effects.setDelayParams",
        payload: { trackId: track.id, params: normalizedParams },
      });
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
        context.onEffectParamsCommitted?.({ targetId: "master", effect: "master-delay", from: previous, to: next }, persistContext.projectId);
        return;
      }
      const track = resolveTrackByTargetId(targetId);
      if (!track) return;
      context.onEffectParamsCommitted?.({ targetId: track.id, effect: "delay", from: previous, to: next }, persistContext.projectId);
    },
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
