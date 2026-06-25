import {
  createEffect,
  createMemo,
  createSignal,
  type Accessor,
} from "solid-js";
import {
  clampSynthCardBounds,
  createInitialSynthCardBounds,
  type SynthCardBounds,
} from "~/components/effects/synth-card-bounds";
import { createPersistedEffectState } from "~/components/timeline/create-persisted-effect-state";
import { createLocalEffectRows } from "~/components/timeline/create-local-effect-rows";
import { buildClipCreatePayload, type ClipCreateSnapshot } from "@daw-browser/shared";
import { convexApi } from "~/lib/convex";
import type { LocalEffectRow } from "~/lib/local-effects";
import { isLocalId } from "@daw-browser/shared";
import { publishDurableSharedTimelineOperation } from "~/lib/shared-outbox";
import { buildSharedClipCreateOperation, type SharedTimelineOperation } from "~/lib/shared-timeline-operations-api";
import { createLocalTimelineRepository } from "~/lib/timeline-repository/local-timeline-repository";
import { toLocalTimelineClip } from "~/lib/timeline-repository/track-row-adapter";
import {
  createDefaultArpeggiatorParams,
  createDefaultSynthParams,
  normalizeSynthParams,
  serializeSynthParams,
  type ArpeggiatorParams,
  type SynthParams,
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
type RoomEffectRow = FunctionReturnType<typeof convexApi.effects.listByRoom>[number];
type LocalArpRow = LocalEffectRow<ArpeggiatorParams>;
type LocalSynthRow = LocalEffectRow<SynthParams>;
type ArpRow = RoomEffectRow | LocalArpRow | undefined;
type SynthRow = RoomEffectRow | LocalSynthRow | undefined;

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
  flushPending: () => Promise<void>;
  arp: {
    add: () => void;
    change: (updates: Partial<ArpeggiatorParams>) => void;
    params: Accessor<ArpeggiatorParams | undefined>;
    readDraftForTarget: (targetId: string) => ArpeggiatorParams | undefined;
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
    params: Accessor<SynthParams | undefined>;
    readDraftForTarget: (targetId: string) => SynthParams | undefined;
    reset: () => void;
    syncRemoteForTarget: (targetId: string, params: SynthParams | undefined) => void;
    updateCardBounds: (next: SynthCardBounds) => void;
  };
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
  const localArp = createLocalEffectRows<ArpeggiatorParams>({
    projectId: context.projectId,
    targetId: getTrackTargetId,
    effect: "arp",
  });
  const localSynth = createLocalEffectRows<SynthParams>({
    projectId: context.projectId,
    targetId: getTrackTargetId,
    effect: "synth",
    normalize: normalizeSynthParams,
  });

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

  function persistSynth(trackId: Track["id"], params: FunctionArgs<typeof convexApi.effects.setSynthParams>["params"], persistContext: { projectId?: string; userId?: string }) {
    const projectId = persistContext.projectId;
    const userId = persistContext.userId;
    if (!projectId) return;
    if (isLocalId("project", projectId)) {
      return localSynth.persist(projectId, trackId, normalizeSynthParams(params));
    }
    if (!userId) return;

    const operation: SharedTimelineOperation = {
      kind: "effects.setSynthParams",
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

  function commitSynthChange(
    targetId: Track["id"],
    previous: EffectParamsByEffect["synth"] | undefined,
    next: EffectParamsByEffect["synth"],
    projectId?: string,
  ): void {
    if (previous === undefined) return;
    context.onEffectParamsCommitted?.({
      targetId,
      effect: "synth",
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

  const remoteEffectForTarget = (targetId: string | undefined, effectType: "synth" | "arpeggiator") => {
    if (!targetId || isLocalProject()) return undefined;
    return context.roomEffects?.()?.find((row) => row.trackId === targetId && row.type === effectType && row.targetType === "track");
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

  const synthState = createPersistedEffectState<SynthRow, SynthParams>({
    targetId: getTrackTargetId,
    scopeId: context.projectId,
    row: () => isLocalProject() ? localSynth.row(getTrackTargetId()) : remoteEffectForTarget(getTrackTargetId(), "synth"),
    readQueryParams: (row) => {
      return row?.params
        ? normalizeSynthParams(row.params)
        : undefined;
    },
    readVisibleParams: readSynthDefaults,
    createInitialParams: readSynthDefaults,
    serializeParams: serializeSynthParams,
    applyToEngine: (targetId, params) => {
      context.audioEngine().setTrackSynth(targetId, params);
    },
    clearFromEngine: (targetId) => {
      context.audioEngine().clearTrackSynth(targetId);
    },
    createPersistContext: () => ({ projectId: context.projectId(), userId: context.userId() }),
    persistParams: (targetId, params, persistContext) => {
      const track = getTrackByTargetId(targetId);
      if (!track) return;
      return persistSynth(track.id, params, persistContext);
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
      commitSynthChange(track.id, previous, next, persistContext.projectId);
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
    synthState.update((prev) => ({ ...prev, ...updates }));
  }

  function openSynthCard(): void {
    const targetId = getTrackTargetId();
    if (!targetId) return;

    setExpandedSynth({ targetId, ...createInitialSynthCardBounds() });
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
    return synthState.readForTarget(targetId) ?? ensureSynthDefaults(targetId);
  }

  async function handleAddMidiClip(): Promise<void> {
    const track = currentTrack();
    if (!track || track.kind !== "instrument") return;

    const projectId = context.projectId();
    if (!projectId) return;
    const grantScope = readOptimisticGrantScope({
      projectId,
      userId: context.userId(),
    });

    const start = Math.max(0, Math.round((context.playheadSec() ?? 0) * 1000) / 1000);
    const clip: ClipCreateSnapshot = {
      startSec: start,
      duration: 1,
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
        return;
      }

      if (!grantScope) return;
      const operation = buildSharedClipCreateOperation(
        buildClipCreatePayload({
          projectId,
          trackId: track.id,
          clip,
        }),
      );
      const result = await publishDurableSharedTimelineOperation({ projectId, userId: grantScope.userId, operation });
      const clipId = typeof result === "string" ? result : null;
      if (!clipId) return;

      context.grantClipWrite?.(clipId, grantScope);
      const currentScope = readOptimisticGrantScope({
        projectId: context.projectId(),
        userId: context.userId(),
      });
      if (!currentScope || didOptimisticGrantScopeChange(grantScope, currentScope)) return;
      context.onSelectClip?.(track.id, clipId, start);
    } catch (error) {
      console.warn("[EffectsPanel] failed to add MIDI clip", error);
    }
  }

  const expandedSynthCard = createMemo<ExpandedSynthCard | null>(() => {
    const current = expandedSynth();
    if (!current) return null;

    return {
      ...current,
      params: getSynthParamsForTarget(current.targetId),
      onChange: (updates) => {
        synthState.updateForTarget(current.targetId, (prev) => ({ ...prev, ...updates }));
      },
      onReset: () => {
        synthState.updateForTarget(current.targetId, () => ensureSynthDefaults(current.targetId));
      },
    };
  });

  const isSynthExpandedForCurrentTarget = createMemo(
    () => expandedSynth()?.targetId === currentTargetId(),
  );

  const flushPending = async () => {
    await Promise.all([
      arpState.flushPending(),
      synthState.flushPending(),
    ]);
  };

  return {
    addMidiClip: handleAddMidiClip,
    flushPending,
    arp: {
      add: arpState.add,
      change: handleArpChange,
      params: arpState.params,
      readDraftForTarget: arpState.readDraftForTarget,
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
      params: synthState.params,
      readDraftForTarget: synthState.readDraftForTarget,
      reset: synthState.reset,
      syncRemoteForTarget: synthState.syncRemoteForTarget,
      updateCardBounds: updateSynthCardBounds,
    },
  };
}
