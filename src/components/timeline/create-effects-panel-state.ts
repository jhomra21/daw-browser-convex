import {
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
} from "solid-js";
import { createPersistedEffectState } from "~/components/timeline/create-persisted-effect-state";
import { createLocalEffectRows } from "~/components/timeline/create-local-effect-rows";
import { readInstrumentParamsFromEffectRow } from "~/lib/effect-row-instrument-params";
import { createDrumRackBufferSync } from "~/lib/drum-rack-buffer-sync";
import type { createSamplerBufferSync, GranularLoadStatus, SamplerLoadStatus } from "~/lib/sampler-buffer-sync";
import { assignSampleToDrumRackPad, buildClipCreatePayload, type ClipCreateSnapshot, isLocalId,
  createDefaultArpeggiatorParams,
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
import { publishDurableSharedTimelineOperation } from "~/lib/shared-outbox";
import { buildSharedClipCreateOperation, type SharedTimelineOperation } from "~/lib/shared-timeline-operations-api";
import { createLocalTimelineRepository } from "~/lib/timeline-repository/local-timeline-repository";
import { toLocalTimelineClip } from "~/lib/timeline-repository/track-row-adapter";
import { trackColorForClip } from "~/lib/clip-color";
import {
  didOptimisticGrantScopeChange,
  readOptimisticGrantScope,
  type OptimisticGrantWrite,
} from "~/lib/optimistic-grant-scope";
import type { EffectParamsByEffect, EffectParamsCommitPayload, EffectType } from "~/lib/undo/types";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { AudioEngine } from "@daw-browser/audio-engine/audio-engine";
import type { Clip, Track } from "@daw-browser/timeline-core/types";
import type { AddMidiClipOptions } from "~/components/timeline/timeline-device-insert-actions";
type RoomEffectRow = FunctionReturnType<typeof convexApi.effects.listByRoom>[number];
type LocalArpRow = LocalEffectRow<ArpeggiatorParams>;
type LocalInstrumentRow = LocalEffectRow<TrackInstrumentParams>;
type ArpRow = RoomEffectRow | LocalArpRow | undefined;
type InstrumentRow = RoomEffectRow | LocalInstrumentRow | undefined;

type EffectsPanelContext = {
  audioEngine: Accessor<AudioEngine>;
  projectId: Accessor<string | undefined>;
  userId: Accessor<string | undefined>;
  playheadSec: Accessor<number | undefined>;
  roomEffects?: Accessor<RoomEffectRow[] | undefined>;
  grantClipWrite?: OptimisticGrantWrite;
  onSelectClip?: (trackId: Track["id"], clipId: string, startSec: number) => void;
  insertLocalClip?: (trackId: Track["id"], clip: Clip) => void;
  onEffectParamsCommitted?: <Effect extends EffectType>(payload: EffectParamsCommitPayload<Effect>, projectId?: string) => void;
  onLocalSaveFailed?: (message: string) => void;
  samplerBufferSync: ReturnType<typeof createSamplerBufferSync>;
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
    readDraftForTarget: (targetId: string) => ArpeggiatorParams | undefined;
    readForTarget: (targetId: string) => ArpeggiatorParams | undefined;
    reset: () => void;
    setForTarget: (targetId: Track["id"], params: ArpeggiatorParams) => boolean;
    syncRemoteForTarget: (targetId: string, params: ArpeggiatorParams | undefined) => void;
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
    params: Accessor<DrumRackParams | undefined>;
    readDraftForTarget: (targetId: string) => DrumRackParams | undefined;
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
  readDraftInstrumentForTarget: (targetId: string) => TrackInstrumentParams | undefined;
  readInstrumentForTarget: (targetId: string) => TrackInstrumentParams | undefined;
  syncRemoteInstrumentForTarget: (targetId: string, params: TrackInstrumentParams | undefined) => void;
  setInstrumentForTarget: (targetId: Track["id"], instrument: TrackInstrumentParams) => boolean;
  switchInstrument: (kind: InstrumentKind) => void;
  switchInstrumentForTarget: (targetId: Track["id"], kind: InstrumentKind) => boolean;
};

export const EFFECT_PANEL_SAVE_DEBOUNCE_MS = 200;
export const EFFECT_PANEL_LOCAL_EDIT_SUPPRESS_MS = 800;

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
  const drumRackBufferSync = createDrumRackBufferSync();
  const samplerBufferSync = context.samplerBufferSync;
  const [samplerStatusVersion, setSamplerStatusVersion] = createSignal(0);
  onCleanup(samplerBufferSync.subscribe(() => setSamplerStatusVersion((version) => version + 1)));
  onCleanup(drumRackBufferSync.dispose);
  const localArp = createLocalEffectRows<ArpeggiatorParams>({
    projectId: context.projectId,
    targetId: getTrackTargetId,
    effect: "arp",
  });
  const localInstrument = createLocalEffectRows<TrackInstrumentParams>({
    projectId: context.projectId,
    targetId: getTrackTargetId,
    effect: "instrument",
    normalize: (params) => normalizeTrackInstrumentParams(params) ?? { kind: "synth", instanceId: createInstrumentInstanceId(), params: createDefaultSynthParams() },
  });

  function persistInstrument(trackId: Track["id"], instrument: TrackInstrumentParams, persistContext: { projectId?: string; userId?: string }) {
    const projectId = persistContext.projectId;
    const userId = persistContext.userId;
    if (!projectId) return;
    if (isLocalId("project", projectId)) {
      return localInstrument.persist(projectId, trackId, instrument);
    }
    if (!userId) return;

    const operation: SharedTimelineOperation = {
      kind: "instruments.setTrackInstrument",
      payload: { trackId, instrument },
    };
    return publishDurableSharedTimelineOperation({ projectId, userId, operation });
  }

  function persistArpeggiator(trackId: Track["id"], params: FunctionArgs<typeof convexApi.effects.setArpeggiatorParams>["params"], persistContext: { projectId?: string; userId?: string }) {
    const projectId = persistContext.projectId;
    const userId = persistContext.userId;
    if (!projectId) return;
    if (isLocalId("project", projectId)) {
      return localArp.persist(projectId, trackId, params);
    }
    if (!userId) return;

    const operation: SharedTimelineOperation = {
      kind: "effects.setArpeggiatorParams",
      payload: { trackId, params },
    };
    return publishDurableSharedTimelineOperation({ projectId, userId, operation });
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
    }, projectId);
  }

  function commitInstrumentChange(
    targetId: Track["id"],
    previous: EffectParamsByEffect["instrument"] | undefined,
    next: EffectParamsByEffect["instrument"],
    projectId?: string,
  ): void {
    if (previous === undefined) return;
    context.onEffectParamsCommitted?.({
      targetId,
      effect: "instrument",
      from: previous,
      to: next,
    }, projectId);
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

  const arpState = createPersistedEffectState<ArpRow, ArpeggiatorParams>({
    targetId: getTrackTargetId,
    scopeId: context.projectId,
    row: () => isLocalProject() ? localArp.row(getTrackTargetId()) : remoteEffectForTarget(getTrackTargetId(), "arpeggiator"),
    readQueryParams: (row) => row?.params,
    createInitialParams: () => createDefaultArpeggiatorParams(),
    serializeParams: (params) => JSON.stringify(params),
    applyToEngine: (targetId, params) => {
      context.audioEngine().setTrackArpeggiator(targetId, params);
    },
    clearFromEngine: (targetId) => {
      context.audioEngine().clearTrackArpeggiator(targetId);
    },
    createPersistContext: () => ({ projectId: context.projectId(), userId: context.userId() }),
    persistParams: (targetId, params, persistContext) => {
      const track = getTrackByTargetId(targetId);
      if (!track) return;
      return persistArpeggiator(track.id, params, persistContext);
    },
    isMissingRowLoaded: () => isLocalProject()
      ? localArp.isLoaded(getTrackTargetId())
      : context.roomEffects?.() !== undefined,
    remoteOverwriteAfterMs: EFFECT_PANEL_LOCAL_EDIT_SUPPRESS_MS,
    onPersistError: (error) => {
      if (!isLocalProject()) return;
      context.onLocalSaveFailed?.(error instanceof Error ? error.message : "Local effect could not be saved.");
    },
    onParamsCommitted: (targetId, previous, next, persistContext) => {
      const track = getTrackByTargetId(targetId);
      if (!track) return;
      commitArpChange(track.id, previous, next, persistContext.projectId);
    },
  });

  const instrumentState = createPersistedEffectState<InstrumentRow, TrackInstrumentParams>({
    targetId: getTrackTargetId,
    scopeId: context.projectId,
    row: () => isLocalProject() ? localInstrument.row(getTrackTargetId()) : remoteEffectForTarget(getTrackTargetId(), "instrument"),
    readQueryParams: (row) => row ? readInstrumentParamsFromEffectRow(row) : undefined,
    readVisibleParams: () => undefined,
    createInitialParams: () => undefined,
    serializeParams: (params) => JSON.stringify(params),
    applyToEngine: (targetId, params) => {
      if (params.kind === "synth") {
        context.audioEngine().setTrackInstrument(targetId, { instrument: params });
        return;
      }
      if (params.kind === "drum-rack") {
        samplerBufferSync.clearTrack(targetId);
        drumRackBufferSync.syncTrack(context.audioEngine(), targetId, params.params);
        return;
      }
      if (params.kind === "granular") {
        drumRackBufferSync.clearTrack(targetId);
        samplerBufferSync.syncGranularTrack(context.audioEngine(), targetId, params.params, params.instanceId);
        return;
      }
      drumRackBufferSync.clearTrack(targetId);
      samplerBufferSync.syncTrack(context.audioEngine(), targetId, params.params, params.instanceId);
    },
    clearFromEngine: (targetId) => {
      drumRackBufferSync.clearTrack(targetId);
      samplerBufferSync.clearTrack(targetId);
      context.audioEngine().clearTrackInstrument(targetId);
    },
    createPersistContext: () => ({ projectId: context.projectId(), userId: context.userId() }),
    persistParams: (targetId, params, persistContext) => {
      const track = getTrackByTargetId(targetId);
      if (!track) return;
      return persistInstrument(track.id, params, persistContext);
    },
    isMissingRowLoaded: () => isLocalProject()
      ? localInstrument.isLoaded(getTrackTargetId())
      : context.roomEffects?.() !== undefined,
    debounceMs: EFFECT_PANEL_SAVE_DEBOUNCE_MS,
    remoteOverwriteAfterMs: EFFECT_PANEL_LOCAL_EDIT_SUPPRESS_MS,
    onPersistError: (error) => {
      if (!isLocalProject()) return;
      context.onLocalSaveFailed?.(error instanceof Error ? error.message : "Local effect could not be saved.");
    },
    onParamsCommitted: (targetId, previous, next, persistContext) => {
      const track = getTrackByTargetId(targetId);
      if (!track) return;
      commitInstrumentChange(track.id, previous, next, persistContext.projectId);
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
      const clipId = typeof result === "string" ? result : null;
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
    const projectId = context.projectId();
    if (projectId && isLocalId("project", projectId)) {
      const row = await localArp.fetchRow(projectId, targetId);
      if (row?.params !== undefined) return false;
    }
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
      readDraftForTarget: arpState.readDraftForTarget,
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
      params: drumRackParams,
      readDraftForTarget: (targetId) => {
        const current = instrumentState.readDraftForTarget(targetId);
        return current?.kind === "drum-rack" ? current.params : undefined;
      },
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
        if (targetId) samplerBufferSync.retryZone(context.audioEngine(), targetId, zoneId);
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
          params: { ...(previous.kind === "sampler" ? previous.params : INSTRUMENT_CONTRACTS.sampler.createDefaultParams()), ...updates },
        }));
      },
      updateZone: (zoneId, updates) => {
        const targetId = getTrackTargetId();
        if (!targetId) return;
        instrumentState.updateForTarget(targetId, (previous) => {
          const params = previous.kind === "sampler" ? previous.params : INSTRUMENT_CONTRACTS.sampler.createDefaultParams();
          return { kind: "sampler", instanceId: previous.kind === "sampler" ? previous.instanceId : createInstrumentInstanceId(), params: { ...params, zones: params.zones.map((zone) => zone.id === zoneId ? { ...zone, ...updates, id: zone.id } : zone) } };
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
        if (targetId) samplerBufferSync.retryGranular(context.audioEngine(), targetId);
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
          params: { ...(previous.kind === "granular" ? previous.params : INSTRUMENT_CONTRACTS.granular.createDefaultParams()), ...updates },
        }));
      },
    },
    activeInstrument: instrumentState.params,
    readDraftInstrumentForTarget: instrumentState.readDraftForTarget,
    readInstrumentForTarget: instrumentState.readForTarget,
    syncRemoteInstrumentForTarget: instrumentState.syncRemoteForTarget,
    setInstrumentForTarget,
    switchInstrument,
    switchInstrumentForTarget,
  };
}
