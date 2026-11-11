import {
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
} from "solid-js";
import type { ParameterGestureHandle } from "~/components/timeline/parameter-gesture-owner";
import { createPersistedEffectState } from "~/components/timeline/create-persisted-effect-state";
import { createLocalEffectsView } from "~/components/timeline/create-local-effects-view";
import { readInstrumentParamsFromEffectRow } from "~/lib/effect-row-instrument-params";
import type { createDrumRackBufferSync } from "~/lib/drum-rack-buffer-sync";
import type { NativeInstrumentPreparation } from "~/lib/desktop/native-instrument-budget-policy";
import type { NativeBuiltInParameterPayload } from "~/lib/desktop/native-built-in-parameter-mapper";
import { nativeInstrumentContentKey, type DeliveryRegistration, type LiveProcessorEditIdentity, type ProcessorDelivery, type PublicationJoin } from "~/lib/live-processor-control";
import { parameterSaveResult } from "~/components/timeline/parameter-gesture-owner";
import { compileLiveNativeInstrumentConfigurations } from "@daw-browser/audio-engine/live-native-projection";
import { localizeInstrumentFx } from "@daw-browser/audio-engine/portable-export-snapshot";
import { validateInstrumentBuffers } from "~/lib/live-playback-snapshot";
import type { createSamplerBufferSync, GranularLoadStatus, NativeInstrumentRetryIdentity, SamplerLoadStatus } from "~/lib/sampler-buffer-sync";
import { assignSampleToDrumRackPad, buildClipCreatePayload, type ClipCreateSnapshot, isLocalId,
  createDefaultArpeggiatorParams,
  arpeggiatorParamsSchema,
  normalizeArpeggiatorParams,
  createDefaultDrumRackParams,
  createDefaultSynthParams,
  mergeSynthParams,
  INSTRUMENT_CONTRACTS,
  normalizeTrackInstrumentParams,
  createInstrumentInstanceId,
  type ArpeggiatorParams,
  type DrumRackParams,
  type DrumRackSampleAssignment,
  type InstrumentKind,
  type GranularParams,
  type SamplerParams,
  type SamplerZone,
  type SynthParams,
  type SynthParamsUpdate,
  type TrackInstrumentParams } from "@daw-browser/shared";
import type { convexApi } from "~/lib/convex";
import type { LocalEffectRow } from "~/lib/local-effects";
import { setLocalEffect } from "~/lib/local-effects";
import type { LocalEffectsViewSource } from "~/components/timeline/create-local-effects-view";
import { publishDurableEffectsOperation, publishDurableSharedTimelineOperation } from "~/lib/shared-outbox";
import { buildSharedClipCreateOperation, type SharedTimelineOperation } from "~/lib/shared-timeline-operations-api";
import { createLocalTimelineRepository } from "~/lib/timeline-repository/local-timeline-repository";
import { toLocalTimelineClip } from "~/lib/timeline-repository/track-row-adapter";
import { trackColorForClip } from "~/lib/clip-color";
import {
  didOptimisticGrantScopeChange,
  readOptimisticGrantScope,
  type OptimisticGrantWrite,
} from "~/lib/optimistic-grant-scope";
import type { EffectParamsByEffect, EffectParamsCommitOptions, EffectParamsCommitPayload, EffectType } from "~/lib/undo/types";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { AudioEngine, EngineDisposition } from "@daw-browser/audio-engine/audio-engine";
import type { SampledInstrumentBuffer } from "@daw-browser/audio-engine/sampled-instrument-region";
import type { Clip, Track } from "@daw-browser/timeline-core/types";
import type { AddMidiClipOptions } from "~/components/timeline/timeline-device-insert-actions";
type RoomEffectRow = FunctionReturnType<typeof convexApi.effects.listByRoom>[number];
type LocalArpRow = LocalEffectRow<ArpeggiatorParams>;
type ArpRow = RoomEffectRow | LocalArpRow | undefined;
type InstrumentRow = RoomEffectRow | undefined;

export const publishEffects = async (projectId: string, userId: string, operation: SharedTimelineOperation) => (
  await publishDurableEffectsOperation({ projectId, userId, operation })
);

type EffectsPanelContext = {
  audioEngine: Accessor<AudioEngine>;
  projectId: Accessor<string | undefined>;
  userId: Accessor<string | undefined>;
  playheadSec: Accessor<number | undefined>;
  roomEffects?: Accessor<RoomEffectRow[] | undefined>;
  grantClipWrite?: OptimisticGrantWrite;
  onSelectClip?: (trackId: Track["id"], clipId: string, startSec: number) => void;
  insertLocalClip?: (trackId: Track["id"], clip: Clip) => void;
  onEffectParamsCommitted?: <Effect extends EffectType>(payload: EffectParamsCommitPayload<Effect>, projectId?: string, options?: EffectParamsCommitOptions) => void;
  onStructuralPlaybackChange?: (targetId: Track["id"], next: TrackInstrumentParams | undefined, edit?: LiveProcessorEditIdentity) => Promise<void>;
  deliverProcessor?: (edit: LiveProcessorEditIdentity, gesture?: ProcessorDelivery["gesture"]) => DeliveryRegistration;
  joinPublication?: (join: PublicationJoin) => DeliveryRegistration;
  applyPortableProcessor?: (edit: LiveProcessorEditIdentity) => Promise<EngineDisposition | undefined>;
  usesLegacyAudioEngine?: Accessor<boolean>;
  canWrite?: Accessor<boolean>;
  allocateProcessorEdit?: (payload: NativeBuiltInParameterPayload) => LiveProcessorEditIdentity | undefined;
  projectGeneration?: Accessor<number>;
  onLocalSaveFailed?: (projectId: string, message: string) => void;
  onEffectError?: (title: string, message: string) => void;
  samplerBufferSync: ReturnType<typeof createSamplerBufferSync>;
  drumRackBufferSync: ReturnType<typeof createDrumRackBufferSync>;
  trackSampledInstrumentWork?: (work: Promise<EngineDisposition>) => void;
  localEffectsView?: LocalEffectsViewSource;
  retryNativeInstrumentPreparation?: (identity: NativeInstrumentRetryIdentity) => Promise<void>;
};

type EffectsPanelInstrumentDevice = {
  addMidiClip: () => Promise<void>;
  addMidiClipToTarget: (targetId: Track["id"], options?: AddMidiClipOptions) => Promise<boolean>;
  flushPending: () => Promise<void>;
  arp: {
    add: () => void;
    addToTarget: (targetId: Track["id"]) => Promise<boolean>;
    change: (updates: Partial<ArpeggiatorParams>) => void;
    params: Accessor<ArpeggiatorParams | undefined>;
    gestureOwner: ParameterGestureHandle;
    readProvisionalForTarget: (targetId: string) => ArpeggiatorParams | undefined;
    readForTarget: (targetId: string) => ArpeggiatorParams | undefined;
    reset: () => void;
    setForTarget: (targetId: Track["id"], params: ArpeggiatorParams) => boolean;
    syncRemoteForTarget: (targetId: string, params: ArpeggiatorParams | undefined, through?: number) => void;
    toggle: (enabled: boolean) => void;
  };
  synth: {
    change: (updates: SynthParamsUpdate) => void;
    instanceId: Accessor<string | undefined>;
    params: Accessor<SynthParams | undefined>;
    reset: () => void;
  };
  drumRack: {
    assignSampleToPad: (padId: string, sample: DrumRackSampleAssignment) => void;
    buffers: (targetId: string, params: DrumRackParams) => ReadonlyMap<string, SampledInstrumentBuffer> | undefined;
    subscribeBuffers: (listener: () => void) => () => void;
    nativeStatus: Accessor<NativeInstrumentPreparation | undefined>;
    retry: () => void;
    params: Accessor<DrumRackParams | undefined>;
    readForTarget: (targetId: string) => DrumRackParams | undefined;
    reset: () => void;
    updatePad: (padId: string, updates: Partial<DrumRackParams["pads"][number]>) => void;
  };
  sampler: {
    params: Accessor<SamplerParams | undefined>;
    status: Accessor<SamplerLoadStatus | undefined>;
    retryZone: (zoneId: string) => void;
    reset: () => void;
    update: (updates: Partial<SamplerParams>) => void;
    updateZone: (zoneId: string, updates: Partial<SamplerZone>) => void;
    addZone: (zone: SamplerZone) => void;
    removeZone: (zoneId: string) => void;
  };
  granular: {
    params: Accessor<GranularParams | undefined>;
    status: Accessor<GranularLoadStatus | undefined>;
    retry: () => void;
    reset: () => void;
    update: (updates: Partial<GranularParams>) => void;
  };
  activeInstrument: Accessor<TrackInstrumentParams | undefined>;
  gestureOwner: ParameterGestureHandle;
  snapshotInstrumentBuffers: (
    targetId: string,
    instrument: TrackInstrumentParams,
  ) => {
    samplerBuffers?: ReadonlyMap<string, SampledInstrumentBuffer>;
    drumRackBuffers?: ReadonlyMap<string, SampledInstrumentBuffer>;
    granularBuffer?: { assetKey: string } & SampledInstrumentBuffer;
    unavailableSampleAssetKeys?: readonly string[];
  } | undefined;
  readInstrumentForTarget: (targetId: string) => TrackInstrumentParams | undefined;
  syncRemoteInstrumentForTarget: (targetId: string, params: TrackInstrumentParams | undefined, through?: number) => void;
  setInstrumentForTarget: (targetId: Track["id"], instrument: TrackInstrumentParams) => boolean;
  switchInstrument: (kind: InstrumentKind) => void;
  switchInstrumentForTarget: (targetId: Track["id"], kind: InstrumentKind) => boolean;
};

export function createEffectsPanelInstrumentDevice(
  context: EffectsPanelContext,
  currentTargetId: Accessor<string>,
  currentTrack: Accessor<Track | undefined>,
  resolveTrackById: (targetId: string) => Track | undefined,
): EffectsPanelInstrumentDevice {
  function getTrackTargetId(): Track["id"] | undefined {
    if (currentTargetId() === "master") return undefined;
    return currentTrack()?.id;
  }

  function getTrackByTargetId(targetId: string): Track | undefined {
    if (targetId === "master") return undefined;
    return resolveTrackById(targetId);
  }

  const isLocalProject = () => {
    const projectId = context.projectId();
    return Boolean(projectId && isLocalId("project", projectId));
  };
  const drumRackBufferSync = context.drumRackBufferSync;
  const samplerBufferSync = context.samplerBufferSync;
  const localEffectsView = context.localEffectsView ?? createLocalEffectsView({
    projectId: context.projectId,
    onError: context.onEffectError,
  });
  const [samplerStatusVersion, setSamplerStatusVersion] = createSignal(0);
  onCleanup(samplerBufferSync.subscribe(() => setSamplerStatusVersion((version) => version + 1)));
  onCleanup(drumRackBufferSync.subscribe(() => setSamplerStatusVersion((version) => version + 1)));
  // A permanent rejection is an outcome of the publication; the callers here have always surfaced it as a failure.
  function persistInstrument(trackId: Track["id"], instrument: TrackInstrumentParams, persistContext: { projectId?: string; userId?: string }) {
    const projectId = persistContext.projectId;
    const userId = persistContext.userId;
    if (!projectId) return;
    if (isLocalId("project", projectId)) {
      const normalized = normalizeTrackInstrumentParams(instrument);
      if (!normalized) return;
      return setLocalEffect(projectId, trackId, "instrument", normalized);
    }
    if (!userId) return;

    const operation: SharedTimelineOperation = {
      kind: "instruments.setTrackInstrument",
      payload: { trackId, instrument },
    };
    return publishEffects(projectId, userId, operation);
  }

  function persistArpeggiator(trackId: Track["id"], params: FunctionArgs<typeof convexApi.effects.setArpeggiatorParams>["params"], persistContext: { projectId?: string; userId?: string }) {
    const projectId = persistContext.projectId;
    const userId = persistContext.userId;
    if (!projectId) return;
    if (isLocalId("project", projectId)) {
      return setLocalEffect(projectId, trackId, "arp", params);
    }
    if (!userId) return;

    const operation: SharedTimelineOperation = {
      kind: "effects.setArpeggiatorParams",
      payload: { trackId, params },
    };
    return publishEffects(projectId, userId, operation);
  }

  function commitArpChange(
    targetId: Track["id"],
    previous: EffectParamsByEffect["arp"] | undefined,
    next: EffectParamsByEffect["arp"],
    projectId?: string,
  ): void {
    if (previous === undefined) return;
    context.onEffectParamsCommitted?.({
      targetId,
      effect: "arp",
      from: previous,
      to: next,
    }, projectId, { mergeHistory: false });
  }

  const instrumentPayload = (targetId: string, from: TrackInstrumentParams, to: TrackInstrumentParams, edit?: LiveProcessorEditIdentity): EffectParamsCommitPayload<"instrument"> => (
    { targetId, effect: "instrument", from, to, edit }
  );
  // A failed save reaches the panel the way the effects chain reports it: a local project's save notice, a shared project's effect error.
  const reportSaveFailure = (error: Error, persistContext: { projectId?: string } | undefined) => {
    const projectId = persistContext?.projectId;
    if (projectId && isLocalId("project", projectId)) context.onLocalSaveFailed?.(projectId, error.message);
    else context.onEffectError?.("Effect save failed", error.message);
  };
  // A thrown portable apply fails the release before saving; native settlement
  // is independent and never vetoes persistence.
  const reportReleaseFailure = (error: Error, persistContext: { projectId?: string } | undefined) => {
    const message = error.message;
    const projectId = persistContext?.projectId;
    if (projectId && isLocalId("project", projectId)) context.onLocalSaveFailed?.(projectId, message);
    else context.onEffectError?.("Effect playback update failed", message);
  };

  function commitInstrumentChange(
    targetId: Track["id"],
    previous: EffectParamsByEffect["instrument"] | undefined,
    next: EffectParamsByEffect["instrument"],
    edit: LiveProcessorEditIdentity | undefined,
    projectId?: string,
  ): void {
    if (previous === undefined) return;
    context.onEffectParamsCommitted?.({
      targetId,
      effect: "instrument",
      edit,
      from: previous,
      to: next,
    }, projectId, { mergeHistory: false });
  }

  const remoteEffectForTarget = (targetId: string | undefined, effectType: "instrument" | "synth" | "arpeggiator") => {
    if (!targetId || isLocalProject()) return undefined;
    const rows = context.roomEffects?.();
    if (effectType === "instrument") {
      return rows?.find((row) => row.trackId === targetId && row.type === "instrument" && row.targetType === "track")
        ?? rows?.find((row) => row.trackId === targetId && row.type === "synth" && row.targetType === "track");
    }
    return rows?.find((row) => row.trackId === targetId && row.type === effectType && row.targetType === "track");
  };
  const localArpeggiatorForTarget = (targetId: string | undefined): LocalArpRow | undefined => {
    const projectId = context.projectId();
    if (!projectId || !targetId || localEffectsView.view()?.projectId !== projectId) return undefined;
    const row = localEffectsView.view()?.rows.find((candidate) => (
      candidate.targetId === targetId && candidate.effect === "arp"
    ));
    if (!row) return undefined;
    const params = arpeggiatorParamsSchema.safeParse(row.params);
    return params.success ? { ...row, params: normalizeArpeggiatorParams(params.data) } : undefined;
  };

  const arpState = createPersistedEffectState<ArpRow, ArpeggiatorParams>({
    audioEngine: context.audioEngine,
    usesLegacyAudioEngine: context.usesLegacyAudioEngine,
    targetId: getTrackTargetId,
    scopeId: context.projectId,
    row: () => isLocalProject()
      ? localArpeggiatorForTarget(getTrackTargetId())
      : remoteEffectForTarget(getTrackTargetId(), "arpeggiator"),
    readQueryParams: (row) => row?.params,
    readQueryThrough: (row) => isLocalProject() ? localEffectsView.view()?.through ?? 0 : row && "revision" in row ? row.revision ?? 0 : 0,
    createInitialParams: () => createDefaultArpeggiatorParams(),
    serializeParams: (params) => JSON.stringify(params),
    applyToEngine: (targetId, params) => {
      return context.audioEngine().setTrackArpeggiator(targetId, params);
    },
    clearFromEngine: (targetId) => {
      context.audioEngine().clearTrackArpeggiator(targetId);
    },
    createPersistContext: () => ({
      projectId: context.projectId(),
      userId: context.userId(),
      projectGeneration: context.projectGeneration?.(),
    }),
    isRemote: () => !isLocalProject(),
    persistParams: async (targetId, params, persistContext) => {
      const result = await persistArpeggiator(targetId, params, persistContext);
      return result ? parameterSaveResult(result) : { kind: "rejected", reason: "The effect write has no project or user." };
    },
    canWrite: context.canWrite,
    isMissingRowLoaded: () => isLocalProject()
      ? localEffectsView.view()?.projectId === context.projectId()
      : context.roomEffects?.() !== undefined,
    onPersistError: reportSaveFailure,
    onEngineApplyError: (error) => context.onEffectError?.("Effect playback update failed", error instanceof Error ? error.message : "The effect could not be applied to playback."),
    onReleaseFailed: reportReleaseFailure,
    history: (targetId, previous, next, _edit, persistContext) => {
      const track = getTrackByTargetId(targetId);
      if (!track) return;
      commitArpChange(track.id, previous, next, persistContext.projectId);
    },
  });

  const instrumentState = createPersistedEffectState<InstrumentRow, TrackInstrumentParams>({
    audioEngine: context.audioEngine,
    usesLegacyAudioEngine: context.usesLegacyAudioEngine,
    targetId: getTrackTargetId,
    scopeId: context.projectId,
    // Local rows arrive for every track through useEffectsPanelAudioSync.
    // A second selected-row cache can replay stale values after a save echo.
    row: () => isLocalProject() ? undefined : remoteEffectForTarget(getTrackTargetId(), "instrument"),
    readQueryParams: (row) => row ? readInstrumentParamsFromEffectRow(row) : undefined,
    readQueryThrough: (row) => row?.revision ?? 0,
    readVisibleParams: () => undefined,
    createInitialParams: () => undefined,
    serializeParams: (params) => JSON.stringify(params),
    applyToEngine: (targetId, params, edit) => {
      if (params.kind === "synth") {
        drumRackBufferSync.clearTrack(targetId);
        samplerBufferSync.clearTrack(targetId);
        const applied = context.audioEngine().setTrackInstrument(targetId, { instrument: params });
        // Live MIDI keeps playing through the browser engine; prepared portable playback takes the same values live.
        // The session records what it took in its own prepared snapshot, so the owner keeps the browser result.
        return !(context.usesLegacyAudioEngine?.() ?? true) && edit && context.applyPortableProcessor
          ? context.applyPortableProcessor(edit).then(() => applied)
          : applied;
      }
      let work: Promise<EngineDisposition>;
      if (params.kind === "drum-rack") {
        samplerBufferSync.clearTrack(targetId);
        work = drumRackBufferSync.syncTrack(context.audioEngine(), targetId, params.params, params.instanceId);
      } else if (params.kind === "granular") {
        drumRackBufferSync.clearTrack(targetId);
        work = samplerBufferSync.syncGranularTrack(context.audioEngine(), targetId, params.params, params.instanceId);
      } else {
        drumRackBufferSync.clearTrack(targetId);
        work = samplerBufferSync.syncTrack(context.audioEngine(), targetId, params.params, params.instanceId);
      }
      context.trackSampledInstrumentWork?.(work);
      return work;
    },
    clearFromEngine: (targetId) => {
      drumRackBufferSync.clearTrack(targetId);
      samplerBufferSync.clearTrack(targetId);
      context.audioEngine().clearTrackInstrument(targetId);
    },
    createPersistContext: () => ({
      projectId: context.projectId(),
      userId: context.userId(),
      projectGeneration: context.projectGeneration?.(),
    }),
    persistParams: async (targetId, params, persistContext) => {
      const result = await persistInstrument(targetId, params, persistContext);
      return result ? parameterSaveResult(result) : { kind: "rejected", reason: "The instrument write has no project or user." };
    },
    canWrite: context.canWrite,
    isMissingRowLoaded: () => !isLocalProject() && context.roomEffects?.() !== undefined,
    allocateEdit: (targetId, _from, to) => to.kind === "synth" ? context.allocateProcessorEdit?.(instrumentPayload(targetId, to, to)) : undefined,
    registerDelivery: (targetId, params, edit, gesture, lifetime) => {
      if (context.usesLegacyAudioEngine?.() ?? true) return undefined;
      if (params.kind === "synth") return edit ? context.deliverProcessor?.(edit, gesture) : undefined;
      const buffers = params.kind === "sampler"
        ? { samplerBuffers: samplerBufferSync.snapshotSamplerBuffers(targetId, params), unavailableSampleAssetKeys: samplerBufferSync.snapshotUnavailableAssetKeys(targetId, params) }
        : params.kind === "drum-rack"
          ? (() => { const snapshot = drumRackBufferSync.snapshotBuffers(targetId, params); return { drumRackBuffers: snapshot?.buffers, unavailableSampleAssetKeys: snapshot?.unavailableSampleAssetKeys }; })()
          : { granularBuffer: samplerBufferSync.snapshotGranularBuffer(targetId, params), unavailableSampleAssetKeys: samplerBufferSync.snapshotUnavailableAssetKeys(targetId, params) };
      const trackFx = { [targetId]: { instances: [], instrument: params, ...buffers } };
      validateInstrumentBuffers(trackFx);
      const fx = localizeInstrumentFx({ masterVolume: 1, masterFxInstances: [], trackFx });
      const configuration = compileLiveNativeInstrumentConfigurations([], fx).configurations.find(entry => entry.nodeId === targetId);
      if (!configuration) throw new Error(`Native instrument content is unavailable for "${targetId}".`);
      return context.joinPublication?.({ target: { nodeId: targetId, instanceId: params.instanceId }, contentKey: nativeInstrumentContentKey(configuration.state), lifetime: lifetime.incarnation });
    },
    announce: (targetId, next, edit) => context.onStructuralPlaybackChange?.(targetId, next, edit),
    announceRemoved: (targetId) => context.onStructuralPlaybackChange?.(targetId, undefined),
    onPersistError: reportSaveFailure,
    onEngineApplyError: (error) => context.onEffectError?.("Effect playback update failed", error instanceof Error ? error.message : "The effect could not be applied to playback."),
    onReleaseFailed: reportReleaseFailure,
    history: (targetId, previous, next, edit, persistContext) => {
      const track = getTrackByTargetId(targetId);
      if (!track) return;
      commitInstrumentChange(track.id, previous, next, edit, persistContext.projectId);
    },
  });

  function handleArpChange(updates: Partial<ArpeggiatorParams>): void {
    arpState.update((prev) => ({ ...prev, ...updates }));
  }

  function handleArpToggle(enabled: boolean): void {
    arpState.update((prev) => ({ ...prev, enabled }));
  }

  function handleSynthChange(updates: SynthParamsUpdate): void {
    instrumentState.update((prev) => ({
      kind: "synth",
      instanceId: prev.kind === "synth" ? prev.instanceId : createInstrumentInstanceId(),
      params: mergeSynthParams(prev.kind === "synth" ? prev.params : createDefaultSynthParams(), updates),
    }));
  }

  function readDrumRackForTarget(targetId: string): DrumRackParams | undefined {
    const current = instrumentState.readForTarget(targetId);
    return current?.kind === "drum-rack" ? current.params : undefined;
  }

  function samplesEqual(a: DrumRackSampleAssignment | undefined, b: DrumRackSampleAssignment): boolean {
    return a?.assetKey === b.assetKey
      && a.url === b.url
      && a.name === b.name
      && a.sourceKind === b.sourceKind
      && a.source.durationSec === b.source.durationSec
      && a.source.sampleRate === b.source.sampleRate
      && a.source.channelCount === b.source.channelCount;
  }

  function assignSampleToCurrentDrumRackPad(padId: string, sample: DrumRackSampleAssignment): void {
    const targetId = getTrackTargetId();
    if (!targetId) return;
    const current = instrumentState.readForTarget(targetId);
    const currentParams = current?.kind === "drum-rack" ? current.params : undefined;
    const currentPad = currentParams?.pads.find((pad) => pad.id === padId);
    if (currentParams?.selectedPadId === padId && samplesEqual(currentPad?.sample, sample)) return;
    instrumentState.updateForTarget(targetId, (prev) => ({
      kind: "drum-rack",
      instanceId: prev.kind === "drum-rack" ? prev.instanceId : createInstrumentInstanceId(),
      params: assignSampleToDrumRackPad(
        prev.kind === "drum-rack" ? prev.params : INSTRUMENT_CONTRACTS["drum-rack"].createDefaultParams(),
        padId,
        sample,
      ),
    }));
  }

  function updateCurrentDrumRackPad(padId: string, updates: Partial<DrumRackParams["pads"][number]>): void {
    const targetId = getTrackTargetId();
    if (!targetId) return;
    instrumentState.updateForTarget(targetId, (prev) => {
      const params = prev.kind === "drum-rack" ? prev.params : INSTRUMENT_CONTRACTS["drum-rack"].createDefaultParams();
      return {
        kind: "drum-rack",
        instanceId: prev.kind === "drum-rack" ? prev.instanceId : createInstrumentInstanceId(),
        params: {
          ...params,
          pads: params.pads.map((pad) => pad.id === padId ? { ...pad, ...updates, id: pad.id, note: pad.note } : pad),
          selectedPadId: padId,
        },
      };
    });
  }

  function switchInstrumentForTarget(targetId: Track["id"], kind: InstrumentKind): boolean {
    const track = getTrackByTargetId(targetId);
    if (!track || track.kind !== "instrument") return false;
    const current = instrumentState.readForTarget(targetId);
    if (current?.kind === kind) return true;
    const instanceId = createInstrumentInstanceId();
    if (kind === "synth") instrumentState.setForTarget(targetId, { kind, instanceId, params: createDefaultSynthParams() });
    else if (kind === "drum-rack") instrumentState.setForTarget(targetId, { kind, instanceId, params: INSTRUMENT_CONTRACTS["drum-rack"].createDefaultParams() });
    else if (kind === "sampler") instrumentState.setForTarget(targetId, { kind, instanceId, params: INSTRUMENT_CONTRACTS.sampler.createDefaultParams() });
    else instrumentState.setForTarget(targetId, { kind, instanceId, params: INSTRUMENT_CONTRACTS.granular.createDefaultParams() });
    return true;
  }

  function switchInstrument(kind: InstrumentKind): void {
    const targetId = getTrackTargetId();
    if (!targetId) return;
    switchInstrumentForTarget(targetId, kind);
  }

  async function addMidiClipToTarget(targetId: Track["id"], options?: AddMidiClipOptions): Promise<boolean> {
    const track = getTrackByTargetId(targetId);
    if (!track || track.kind !== "instrument") return false;

    const projectId = context.projectId();
    if (!projectId) return false;
    const grantScope = readOptimisticGrantScope({
      projectId,
      userId: context.userId(),
    });

    const start = Math.max(0, Math.round((options?.startSec ?? context.playheadSec() ?? 0) * 1000) / 1000);
    const clip: ClipCreateSnapshot = {
      startSec: start,
      duration: Math.max(0.001, options?.durationSec ?? 1),
      name: "MIDI Clip",
      color: trackColorForClip(track.color) ?? "clip-midi",
      midi: {
        wave: "sawtooth",
        gain: 0.8,
        notes: [],
      },
    };

    try {
      if (isLocalId("project", projectId)) {
        const row = await createLocalTimelineRepository(projectId).createClip({
          trackId: track.id,
          ...clip,
        });
        context.insertLocalClip?.(track.id, toLocalTimelineClip(row));
        context.onSelectClip?.(track.id, row.id, start);
        return true;
      }

      if (!grantScope) return false;
      const operation = buildSharedClipCreateOperation(
        buildClipCreatePayload({
          projectId,
          trackId: track.id,
          clip,
        }),
      );
      const result = await publishDurableSharedTimelineOperation({ projectId, userId: grantScope.userId, operation });
      const clipId = result !== null && result !== undefined && result === String(result)
        ? String(result)
        : null;
      if (!clipId) return false;

      context.grantClipWrite?.(clipId, grantScope);
      const currentScope = readOptimisticGrantScope({
        projectId: context.projectId(),
        userId: context.userId(),
      });
      if (!currentScope || didOptimisticGrantScopeChange(grantScope, currentScope)) return false;
      context.onSelectClip?.(track.id, clipId, start);
      return true;
    } catch (error) {
      console.warn("[EffectsPanel] failed to add MIDI clip", error);
      return false;
    }
  }

  async function addArpeggiatorToTarget(targetId: Track["id"]): Promise<boolean> {
    const track = getTrackByTargetId(targetId);
    if (!track || track.kind !== "instrument") return false;
    if (arpState.readForTarget(targetId)) return false;
    arpState.addForTarget(targetId);
    return true;
  }

  function setArpeggiatorForTarget(targetId: Track["id"], params: ArpeggiatorParams): boolean {
    const track = getTrackByTargetId(targetId);
    if (!track || track.kind !== "instrument") return false;
    arpState.setForTarget(targetId, params);
    return true;
  }

  function setInstrumentForTarget(targetId: Track["id"], instrument: TrackInstrumentParams): boolean {
    const track = getTrackByTargetId(targetId);
    if (!track || track.kind !== "instrument") return false;
    instrumentState.setForTarget(targetId, instrument);
    return true;
  }

  async function handleAddMidiClip(): Promise<void> {
    const track = currentTrack();
    if (!track) return;
    await addMidiClipToTarget(track.id);
  }

  const synthParams = createMemo(() => {
    const current = instrumentState.params();
    return current?.kind === "synth" ? current.params : undefined;
  });
  const synthInstanceId = createMemo(() => {
    const current = instrumentState.params();
    return current?.kind === "synth" ? current.instanceId : undefined;
  });
  const drumRackParams = createMemo(() => {
    const current = instrumentState.params();
    return current?.kind === "drum-rack" ? current.params : undefined;
  });
  const samplerParams = createMemo(() => {
    const current = instrumentState.params();
    return current?.kind === "sampler" ? current.params : undefined;
  });
  const samplerStatus = createMemo(() => {
    samplerStatusVersion();
    const targetId = getTrackTargetId();
    return targetId ? samplerBufferSync.getStatus(targetId) : undefined;
  });
  const granularParams = createMemo(() => {
    const current = instrumentState.params();
    return current?.kind === "granular" ? current.params : undefined;
  });
  const granularStatus = createMemo(() => {
    samplerStatusVersion();
    const targetId = getTrackTargetId();
    return targetId ? samplerBufferSync.getGranularStatus(targetId) : undefined;
  });

  const flushPending = async () => {
    await Promise.all([
      arpState.flushPending(),
      instrumentState.flushPending(),
    ]);
  };

  return {
    addMidiClip: handleAddMidiClip,
    addMidiClipToTarget,
    flushPending,
    arp: {
      add: arpState.add,
      addToTarget: addArpeggiatorToTarget,
      change: handleArpChange,
      params: arpState.params,
      gestureOwner: arpState.gestureOwner,
      readProvisionalForTarget: arpState.readProvisionalForTarget,
      readForTarget: arpState.readForTarget,
      reset: arpState.reset,
      setForTarget: setArpeggiatorForTarget,
      syncRemoteForTarget: arpState.syncRemoteForTarget,
      toggle: handleArpToggle,
    },
    synth: {
      change: handleSynthChange,
      instanceId: synthInstanceId,
      params: synthParams,
      reset: () => {
        const targetId = getTrackTargetId();
        if (!targetId) return;
        instrumentState.updateForTarget(targetId, (previous) => ({ kind: "synth", instanceId: previous.kind === "synth" ? previous.instanceId : createInstrumentInstanceId(), params: createDefaultSynthParams() }));
      },
    },
    drumRack: {
      assignSampleToPad: assignSampleToCurrentDrumRackPad,
      buffers: (targetId, params) => {
        const instrument = instrumentState.readForTarget(targetId);
        return instrument?.kind === "drum-rack"
          ? context.drumRackBufferSync.snapshotBuffers(targetId, { kind: "drum-rack", instanceId: instrument.instanceId, params })?.buffers
          : undefined;
      },
      subscribeBuffers: context.drumRackBufferSync.subscribe,
      nativeStatus: () => {
        samplerStatusVersion();
        const targetId = getTrackTargetId();
        return targetId ? drumRackBufferSync.getNativePreparation(targetId) : undefined;
      },
      retry: () => {
        const targetId = getTrackTargetId();
        if (!targetId) return;
        const instrument = instrumentState.readForTarget(targetId);
        if (instrument?.kind !== "drum-rack") return;
        void drumRackBufferSync.retryTrack(
          context.audioEngine(),
          targetId,
          instrument.params,
          instrument.instanceId,
          context.retryNativeInstrumentPreparation,
        );
      },
      params: drumRackParams,
      readForTarget: readDrumRackForTarget,
      reset: () => {
        const targetId = getTrackTargetId();
        if (!targetId) return;
        instrumentState.updateForTarget(targetId, (previous) => ({ kind: "drum-rack", instanceId: previous.kind === "drum-rack" ? previous.instanceId : createInstrumentInstanceId(), params: createDefaultDrumRackParams() }));
      },
      updatePad: updateCurrentDrumRackPad,
    },
    sampler: {
      params: samplerParams,
      status: samplerStatus,
      retryZone: (zoneId) => {
        const targetId = getTrackTargetId();
        if (targetId) {
          void samplerBufferSync.retryZone(
            context.audioEngine(),
            targetId,
            zoneId,
            context.retryNativeInstrumentPreparation,
          );
        }
      },
      reset: () => {
        const targetId = getTrackTargetId();
        if (!targetId) return;
        instrumentState.updateForTarget(targetId, (previous) => ({ kind: "sampler", instanceId: previous.kind === "sampler" ? previous.instanceId : createInstrumentInstanceId(), params: INSTRUMENT_CONTRACTS.sampler.createDefaultParams() }));
      },
      update: (updates) => {
        const targetId = getTrackTargetId();
        if (!targetId) return;
        instrumentState.updateForTarget(targetId, (previous) => ({
          kind: "sampler",
          instanceId: previous.kind === "sampler" ? previous.instanceId : createInstrumentInstanceId(),
          params: INSTRUMENT_CONTRACTS.sampler.normalizeParams({ ...(previous.kind === "sampler" ? previous.params : INSTRUMENT_CONTRACTS.sampler.createDefaultParams()), ...updates }),
        }));
      },
      updateZone: (zoneId, updates) => {
        const targetId = getTrackTargetId();
        if (!targetId) return;
        instrumentState.updateForTarget(targetId, (previous) => {
          const params = previous.kind === "sampler" ? previous.params : INSTRUMENT_CONTRACTS.sampler.createDefaultParams();
          return { kind: "sampler", instanceId: previous.kind === "sampler" ? previous.instanceId : createInstrumentInstanceId(), params: INSTRUMENT_CONTRACTS.sampler.normalizeParams({ ...params, zones: params.zones.map((zone) => zone.id === zoneId ? { ...zone, ...updates, id: zone.id } : zone) }) };
        });
      },
      addZone: (zone) => {
        const targetId = getTrackTargetId();
        if (!targetId) return;
        instrumentState.updateForTarget(targetId, (previous) => {
          const params = previous.kind === "sampler" ? previous.params : INSTRUMENT_CONTRACTS.sampler.createDefaultParams();
          return { kind: "sampler", instanceId: previous.kind === "sampler" ? previous.instanceId : createInstrumentInstanceId(), params: { ...params, zones: [...params.zones, zone] } };
        });
      },
      removeZone: (zoneId) => {
        const targetId = getTrackTargetId();
        if (!targetId) return;
        instrumentState.updateForTarget(targetId, (previous) => {
          const params = previous.kind === "sampler" ? previous.params : INSTRUMENT_CONTRACTS.sampler.createDefaultParams();
          return { kind: "sampler", instanceId: previous.kind === "sampler" ? previous.instanceId : createInstrumentInstanceId(), params: { ...params, zones: params.zones.filter((zone) => zone.id !== zoneId) } };
        });
      },
    },
    granular: {
      params: granularParams,
      status: granularStatus,
      retry: () => {
        const targetId = getTrackTargetId();
        if (targetId) {
          samplerBufferSync.retryGranular(
            context.audioEngine(),
            targetId,
            context.retryNativeInstrumentPreparation,
          );
        }
      },
      reset: () => {
        const targetId = getTrackTargetId();
        if (!targetId) return;
        instrumentState.updateForTarget(targetId, (previous) => ({ kind: "granular", instanceId: previous.kind === "granular" ? previous.instanceId : createInstrumentInstanceId(), params: INSTRUMENT_CONTRACTS.granular.createDefaultParams() }));
      },
      update: (updates) => {
        const targetId = getTrackTargetId();
        if (!targetId) return;
        instrumentState.updateForTarget(targetId, (previous) => ({
          kind: "granular",
          instanceId: previous.kind === "granular" ? previous.instanceId : createInstrumentInstanceId(),
          params: INSTRUMENT_CONTRACTS.granular.normalizeParams({ ...(previous.kind === "granular" ? previous.params : INSTRUMENT_CONTRACTS.granular.createDefaultParams()), ...updates }),
        }));
      },
    },
    activeInstrument: instrumentState.params,
    gestureOwner: instrumentState.gestureOwner,
    snapshotInstrumentBuffers: (targetId: string, instrument: TrackInstrumentParams) => {
      if (instrument.kind === "sampler") {
        const buffers = samplerBufferSync.snapshotSamplerBuffers(targetId, instrument);
        const unavailableSampleAssetKeys = samplerBufferSync.snapshotUnavailableAssetKeys(targetId, instrument);
        return buffers && unavailableSampleAssetKeys
          ? { samplerBuffers: buffers, unavailableSampleAssetKeys }
          : undefined;
      }
      if (instrument.kind === "drum-rack") {
        const snapshot = drumRackBufferSync.snapshotBuffers(targetId, instrument);
        return snapshot
          ? { drumRackBuffers: snapshot.buffers, unavailableSampleAssetKeys: snapshot.unavailableSampleAssetKeys }
          : undefined;
      }
      if (instrument.kind === "granular") {
        const buffer = samplerBufferSync.snapshotGranularBuffer(targetId, instrument);
        const unavailableSampleAssetKeys = samplerBufferSync.snapshotUnavailableAssetKeys(targetId, instrument);
        if (buffer) return { granularBuffer: buffer, unavailableSampleAssetKeys };
        return unavailableSampleAssetKeys?.length ? { unavailableSampleAssetKeys } : undefined;
      }
      return undefined;
    },
    readInstrumentForTarget: instrumentState.readForTarget,
    syncRemoteInstrumentForTarget: instrumentState.syncRemoteForTarget,
    setInstrumentForTarget,
    switchInstrument,
    switchInstrumentForTarget,
  };
}
