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
import { buildClipCreatePayload, type ClipCreateSnapshot } from "~/lib/clip-create";
import { convexApi, convexClient, useConvexQuery } from "~/lib/convex";
import { buildTrackEffectMutationInput, buildTrackEffectQueryArgs } from "~/lib/effect-track-args";
import { getLocalEffect, setLocalEffect, type LocalEffectRow } from "~/lib/local-effects";
import { isLocalId } from "~/lib/local-ids";
import { createLocalTimelineRepository } from "~/lib/timeline-repository/local-timeline-repository";
import {
  createDefaultArpeggiatorParams,
  createDefaultSynthParams,
  normalizeSynthParams,
  serializeSynthParams,
  type ArpeggiatorParams,
  type SynthParams,
} from "~/lib/effects/params";
import {
  didOptimisticGrantScopeChange,
  readOptimisticGrantScope,
  type OptimisticGrantWrite,
} from "~/lib/optimistic-grant-scope";
import type { EffectParamsByEffect, EffectParamsCommitPayload, EffectType } from "~/lib/undo/types";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { AudioEngine } from "~/lib/audio-engine";
import type { Track } from "~/types/timeline";
type TrackArpRow = FunctionReturnType<typeof convexApi.effects.getArpeggiatorForTrack>;
type TrackSynthRow = FunctionReturnType<typeof convexApi.effects.getSynthForTrack>;
type LocalArpRow = LocalEffectRow<ArpeggiatorParams>;
type LocalSynthRow = LocalEffectRow<SynthParams>;

type EffectsPanelContext = {
  audioEngine?: AudioEngine;
  projectId?: string;
  userId?: string;
  playheadSec?: number;
  grantClipWrite?: OptimisticGrantWrite;
  onSelectClip?: (trackId: Track["id"], clipId: string, startSec: number) => void;
  onEffectParamsCommitted?: <Effect extends EffectType>(payload: EffectParamsCommitPayload<Effect>) => void;
};

type ExpandedSynthBounds = SynthCardBounds & {
  targetId: string;
};

type ExpandedSynthCard = ExpandedSynthBounds & {
  params: SynthParams;
  onChange: (updates: Partial<SynthParams>) => void;
  onReset: () => void;
};

type EffectsPanelState = {
  addMidiClip: () => Promise<void>;
  flushPending: () => void;
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

export function createEffectsPanelState(
  context: EffectsPanelContext,
  currentTargetId: Accessor<string>,
  currentTrack: Accessor<Track | undefined>,
  resolveTrackById: (targetId: string) => Track | undefined,
): EffectsPanelState {
  function getTrackTargetId(): Track["id"] | undefined {
    if (currentTargetId() === "master") return undefined;
    return currentTrack()?.id;
  }

  function getTrackByTargetId(targetId: string): Track | undefined {
    if (targetId === "master") return undefined;
    return resolveTrackById(targetId);
  }

  const isLocalProject = () => Boolean(context.projectId && isLocalId("project", context.projectId));
  const [localArpRows, setLocalArpRows] = createSignal<Record<string, LocalArpRow | undefined>>({});
  const [localSynthRows, setLocalSynthRows] = createSignal<Record<string, LocalSynthRow | undefined>>({});

  createEffect(() => {
    const projectId = context.projectId;
    const targetId = getTrackTargetId();
    if (!projectId || !targetId || !isLocalProject()) return;
    void getLocalEffect<ArpeggiatorParams>(projectId, targetId, "arp").then((row) => {
      setLocalArpRows((prev) => ({ ...prev, [targetId]: row }));
    });
  });

  createEffect(() => {
    const projectId = context.projectId;
    const targetId = getTrackTargetId();
    if (!projectId || !targetId || !isLocalProject()) return;
    void getLocalEffect<SynthParams>(projectId, targetId, "synth").then((row) => {
      setLocalSynthRows((prev) => ({ ...prev, [targetId]: row }));
    });
  });

  function persistArpeggiator(trackId: Track["id"], params: FunctionArgs<typeof convexApi.effects.setArpeggiatorParams>["params"]) {
    const projectId = context.projectId;
    const userId = context.userId;
    if (!projectId) return;
    if (isLocalId("project", projectId)) {
      return setLocalEffect(projectId, trackId, "arp", params).then((row) => {
        setLocalArpRows((prev) => ({ ...prev, [trackId]: row }));
      });
    }
    if (!userId) return;

    return convexClient.mutation(
      convexApi.effects.setArpeggiatorParams,
      buildTrackEffectMutationInput({
        projectId,
        trackId,
        userId,
        params,
      }),
    );
  }

  function persistSynth(trackId: Track["id"], params: FunctionArgs<typeof convexApi.effects.setSynthParams>["params"]) {
    const projectId = context.projectId;
    const userId = context.userId;
    if (!projectId) return;
    if (isLocalId("project", projectId)) {
      return setLocalEffect<SynthParams>(projectId, trackId, "synth", normalizeSynthParams(params)).then((row) => {
        setLocalSynthRows((prev) => ({ ...prev, [trackId]: row }));
      });
    }
    if (!userId) return;

    return convexClient.mutation(
      convexApi.effects.setSynthParams,
      buildTrackEffectMutationInput({
        projectId,
        trackId,
        userId,
        params,
      }),
    );
  }

  function commitArpChange(
    targetId: Track["id"],
    previous: EffectParamsByEffect["arp"] | undefined,
    next: EffectParamsByEffect["arp"],
  ): void {
    if (previous === undefined) return;
    context.onEffectParamsCommitted?.({
      targetId,
      effect: "arp",
      from: previous,
      to: next,
    });
  }

  function commitSynthChange(
    targetId: Track["id"],
    previous: EffectParamsByEffect["synth"] | undefined,
    next: EffectParamsByEffect["synth"],
  ): void {
    if (previous === undefined) return;
    context.onEffectParamsCommitted?.({
      targetId,
      effect: "synth",
      from: previous,
      to: next,
    });
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

  const arpQuery = useConvexQuery(
    convexApi.effects.getArpeggiatorForTrack,
    () => {
      const targetId = getTrackTargetId();
      return targetId && !isLocalId("track", targetId) ? buildTrackEffectQueryArgs(targetId) : null;
    },
    () => ["effects", "arpeggiator", currentTargetId()],
  );

  const arpState = createPersistedEffectState<TrackArpRow, ArpeggiatorParams>({
    targetId: getTrackTargetId,
    row: () => isLocalProject() ? localArpRows()[getTrackTargetId() ?? ""] : arpQuery.data,
    readQueryParams: (row) => row?.params,
    createInitialParams: () => createDefaultArpeggiatorParams(),
    serializeParams: (params) => JSON.stringify(params),
    applyToEngine: (targetId, params) => {
      context.audioEngine?.setTrackArpeggiator(targetId, params);
    },
    clearFromEngine: (targetId) => {
      context.audioEngine?.clearTrackArpeggiator?.(targetId);
    },
    persistParams: (targetId, params) => {
      const track = getTrackByTargetId(targetId);
      if (!track) return;
      persistArpeggiator(track.id, params);
    },
    remoteOverwriteAfterMs: EFFECT_PANEL_LOCAL_EDIT_SUPPRESS_MS,
    onParamsCommitted: (targetId, previous, next) => {
      const track = getTrackByTargetId(targetId);
      if (!track) return;
      commitArpChange(track.id, previous, next);
    },
  });

  const synthQuery = useConvexQuery(
    convexApi.effects.getSynthForTrack,
    () => {
      const targetId = getTrackTargetId();
      return targetId && !isLocalId("track", targetId) ? buildTrackEffectQueryArgs(targetId) : null;
    },
    () => ["effects", "synth", currentTargetId()],
  );

  const synthState = createPersistedEffectState<TrackSynthRow, SynthParams>({
    targetId: getTrackTargetId,
    row: () => isLocalProject() ? localSynthRows()[getTrackTargetId() ?? ""] : synthQuery.data,
    readQueryParams: (row) => {
      return row?.params
        ? normalizeSynthParams(row.params)
        : undefined;
    },
    readVisibleParams: readSynthDefaults,
    createInitialParams: readSynthDefaults,
    serializeParams: serializeSynthParams,
    applyToEngine: (targetId, params) => {
      context.audioEngine?.setTrackSynth(targetId, params);
    },
    clearFromEngine: (targetId) => {
      context.audioEngine?.clearTrackSynth?.(targetId);
    },
    persistParams: (targetId, params) => {
      const track = getTrackByTargetId(targetId);
      if (!track) return;
      persistSynth(track.id, params);
    },
    debounceMs: EFFECT_PANEL_SAVE_DEBOUNCE_MS,
    remoteOverwriteAfterMs: EFFECT_PANEL_LOCAL_EDIT_SUPPRESS_MS,
    onParamsCommitted: (targetId, previous, next) => {
      const track = getTrackByTargetId(targetId);
      if (!track) return;
      commitSynthChange(track.id, previous, next);
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

    const projectId = context.projectId;
    if (!projectId) return;
    const grantScope = readOptimisticGrantScope({
      projectId,
      userId: context.userId,
    });

    const start = Math.max(0, Math.round((context.playheadSec ?? 0) * 1000) / 1000);
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
        context.onSelectClip?.(track.id, row.id, start);
        return;
      }

      if (!grantScope) return;
      const { userId } = grantScope;
      const clipId = await convexClient.mutation(convexApi.clips.create, buildClipCreatePayload({
        projectId,
        userId,
        trackId: track.id,
        clip,
      }));
      if (!clipId) return;

      context.grantClipWrite?.(clipId, grantScope);
      const currentScope = readOptimisticGrantScope({
        projectId: context.projectId,
        userId: context.userId,
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

  const flushPending = () => {
    arpState.flushPending();
    synthState.flushPending();
  };

  onCleanup(() => {
    flushPending();
  });

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
