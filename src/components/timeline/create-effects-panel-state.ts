import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
} from "solid-js";
import {
  clampSynthCardBounds,
  createInitialSynthCardBounds,
  type SynthCardBounds,
} from "~/components/effects/synth-card-bounds";
import { createPersistedEffectState } from "~/components/timeline/create-persisted-effect-state";
import { createLocalEffectRows } from "~/components/timeline/create-local-effect-rows";
import { readInstrumentParamsFromEffectRow } from "~/lib/effect-row-instrument-params";
import { createDrumRackBufferSync } from "~/lib/drum-rack-buffer-sync";
import { assignSampleToDrumRackPad, buildClipCreatePayload, type ClipCreateSnapshot } from "@daw-browser/shared";
import { convexApi } from "~/lib/convex";
import type { LocalEffectRow } from "~/lib/local-effects";
import { isLocalId } from "@daw-browser/shared";
import { publishDurableSharedTimelineOperation } from "~/lib/shared-outbox";
import { buildSharedClipCreateOperation, type SharedTimelineOperation } from "~/lib/shared-timeline-operations-api";
import { createLocalTimelineRepository } from "~/lib/timeline-repository/local-timeline-repository";
import { toLocalTimelineClip } from "~/lib/timeline-repository/track-row-adapter";
import {
  createDefaultArpeggiatorParams,
  createDefaultDrumRackParams,
  createDefaultSynthParams,
  INSTRUMENT_CONTRACTS,
  normalizeTrackInstrumentParams,
  type ArpeggiatorParams,
  type DrumRackParams,
  type DrumRackSampleAssignment,
  type InstrumentKind,
  type SynthParams,
  type TrackInstrumentParams,
} from "@daw-browser/shared";
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
};

type ExpandedSynthBounds = SynthCardBounds & {
  targetId: string;
};

type ExpandedSynthCard = ExpandedSynthBounds & {
  params: SynthParams;
  onChange: (updates: Partial<SynthParams>) => void;
  onReset: () => void;
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
    syncRemoteForTarget: (targetId: string, params: ArpeggiatorParams | undefined) => void;
    toggle: (enabled: boolean) => void;
  };
  synth: {
    change: (updates: Partial<SynthParams>) => void;
    close: () => void;
    expandedCard: Accessor<ExpandedSynthCard | null>;
    isExpandedForCurrentTarget: Accessor<boolean>;
    open: () => void;
    openForTarget: (targetId: Track["id"]) => void;
    params: Accessor<SynthParams | undefined>;
    readDraftForTarget: (targetId: string) => SynthParams | undefined;
    reset: () => void;
    syncRemoteForTarget: (targetId: string, params: SynthParams | undefined) => void;
    updateCardBounds: (next: SynthCardBounds) => void;
  };
  drumRack: {
    assignSampleToPad: (padId: string, sample: DrumRackSampleAssignment) => void;
    params: Accessor<DrumRackParams | undefined>;
    readDraftForTarget: (targetId: string) => DrumRackParams | undefined;
    readForTarget: (targetId: string) => DrumRackParams | undefined;
    reset: () => void;
    updatePad: (padId: string, updates: Partial<DrumRackParams["pads"][number]>) => void;
  };
  activeInstrument: Accessor<TrackInstrumentParams | undefined>;
  readDraftInstrumentForTarget: (targetId: string) => TrackInstrumentParams | undefined;
  readInstrumentForTarget: (targetId: string) => TrackInstrumentParams | undefined;
  syncRemoteInstrumentForTarget: (targetId: string, params: TrackInstrumentParams | undefined) => void;
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
    normalize: (params) => normalizeTrackInstrumentParams(params) ?? { kind: "synth", params: createDefaultSynthParams() },
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

  const synthDefaultsByTarget = new Map<string, SynthParams>();
  const ensureSynthDefaults = (targetId: string) => {
    const current = synthDefaultsByTarget.get(targetId);
    if (current) return current;
    const next = createDefaultSynthParams();
    synthDefaultsByTarget.set(targetId, next);
    return next;
  };

  const readSynthDefaults = (targetId: string) => {
    return getTrackByTargetId(targetId)?.kind === "instrument"
      ? ensureSynthDefaults(targetId)
      : undefined;
  };

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
    readVisibleParams: (targetId) => {
      const params = readSynthDefaults(targetId);
      return params ? { kind: "synth", params } : undefined;
    },
    createInitialParams: (targetId) => {
      const params = readSynthDefaults(targetId);
      return params ? { kind: "synth", params } : undefined;
    },
    serializeParams: (params) => JSON.stringify(params),
    applyToEngine: (targetId, params) => {
      if (params.kind === "synth") {
        context.audioEngine().setTrackSynth(targetId, params.params);
        return;
      }
      drumRackBufferSync.syncTrack(context.audioEngine(), targetId, params.params);
    },
    clearFromEngine: (targetId) => {
      drumRackBufferSync.clearTrack(targetId);
      context.audioEngine().clearTrackInstrument(targetId);
    },
    createPersistContext: () => ({ projectId: context.projectId(), userId: context.userId() }),
    persistParams: (targetId, params, persistContext) => {
      const track = getTrackByTargetId(targetId);
      if (!track) return;
      return persistInstrument(track.id, params, persistContext);
    },
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

  const [expandedSynth, setExpandedSynth] = createSignal<ExpandedSynthBounds | null>(null);

  function handleArpChange(updates: Partial<ArpeggiatorParams>): void {
    arpState.update((prev) => ({ ...prev, ...updates }));
  }

  function handleArpToggle(enabled: boolean): void {
    arpState.update((prev) => ({ ...prev, enabled }));
  }

  function handleSynthChange(updates: Partial<SynthParams>): void {
    instrumentState.update((prev) => ({
      kind: "synth",
      params: { ...(prev.kind === "synth" ? prev.params : createDefaultSynthParams()), ...updates },
    }));
  }

  function openSynthForTarget(targetId: Track["id"]): void {
    const track = getTrackByTargetId(targetId);
    if (!track || track.kind !== "instrument") return;
    setExpandedSynth({ targetId, ...createInitialSynthCardBounds() });
  }

  function openSynthCard(): void {
    const targetId = getTrackTargetId();
    if (!targetId) return;
    openSynthForTarget(targetId);
  }

  function closeSynthCard(): void {
    setExpandedSynth(null);
  }

  function updateSynthCardBounds(next: SynthCardBounds): void {
    const current = expandedSynth();
    if (!current) return;

    setExpandedSynth({
      targetId: current.targetId,
      ...clampSynthCardBounds(next),
    });
  }

  function getSynthParamsForTarget(targetId: string): SynthParams {
    const current = instrumentState.readForTarget(targetId);
    return current?.kind === "synth" ? current.params : ensureSynthDefaults(targetId);
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
    instrumentState.updateForTarget(targetId, (prev) => {
      if (prev.kind === kind) return prev;
      return kind === "synth"
        ? { kind, params: ensureSynthDefaults(targetId) }
        : { kind, params: INSTRUMENT_CONTRACTS["drum-rack"].createDefaultParams() };
    });
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

  async function handleAddMidiClip(): Promise<void> {
    const track = currentTrack();
    if (!track) return;
    await addMidiClipToTarget(track.id);
  }

  const expandedSynthCard = createMemo<ExpandedSynthCard | null>(() => {
    const current = expandedSynth();
    if (!current) return null;

    return {
      ...current,
      params: getSynthParamsForTarget(current.targetId),
      onChange: (updates) => {
        instrumentState.updateForTarget(current.targetId, (prev) => ({
          kind: "synth",
          params: { ...(prev.kind === "synth" ? prev.params : createDefaultSynthParams()), ...updates },
        }));
      },
      onReset: () => {
        instrumentState.updateForTarget(current.targetId, () => ({ kind: "synth", params: ensureSynthDefaults(current.targetId) }));
      },
    };
  });

  const isSynthExpandedForCurrentTarget = createMemo(
    () => expandedSynth()?.targetId === currentTargetId(),
  );

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
      syncRemoteForTarget: arpState.syncRemoteForTarget,
      toggle: handleArpToggle,
    },
    synth: {
      change: handleSynthChange,
      close: closeSynthCard,
      expandedCard: expandedSynthCard,
      isExpandedForCurrentTarget: isSynthExpandedForCurrentTarget,
      open: openSynthCard,
      openForTarget: openSynthForTarget,
      params: createMemo(() => {
        const current = instrumentState.params();
        return current?.kind === "synth" ? current.params : undefined;
      }),
      readDraftForTarget: (targetId) => {
        const current = instrumentState.readDraftForTarget(targetId);
        return current?.kind === "synth" ? current.params : undefined;
      },
      reset: () => {
        const targetId = getTrackTargetId();
        if (!targetId) return;
        instrumentState.updateForTarget(targetId, () => ({ kind: "synth", params: ensureSynthDefaults(targetId) }));
      },
      syncRemoteForTarget: (targetId, params) => {
        instrumentState.syncRemoteForTarget(targetId, params ? { kind: "synth", params } : undefined);
      },
      updateCardBounds: updateSynthCardBounds,
    },
    drumRack: {
      assignSampleToPad: assignSampleToCurrentDrumRackPad,
      params: createMemo(() => {
        const current = instrumentState.params();
        return current?.kind === "drum-rack" ? current.params : undefined;
      }),
      readDraftForTarget: (targetId) => {
        const current = instrumentState.readDraftForTarget(targetId);
        return current?.kind === "drum-rack" ? current.params : undefined;
      },
      readForTarget: readDrumRackForTarget,
      reset: () => {
        const targetId = getTrackTargetId();
        if (!targetId) return;
        instrumentState.updateForTarget(targetId, () => ({ kind: "drum-rack", params: createDefaultDrumRackParams() }));
      },
      updatePad: updateCurrentDrumRackPad,
    },
    activeInstrument: instrumentState.params,
    readDraftInstrumentForTarget: instrumentState.readDraftForTarget,
    readInstrumentForTarget: instrumentState.readForTarget,
    syncRemoteInstrumentForTarget: instrumentState.syncRemoteForTarget,
    switchInstrument,
    switchInstrumentForTarget,
  };
}
