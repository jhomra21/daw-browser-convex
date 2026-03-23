import {
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
import { convexApi, convexClient, useConvexQuery } from "~/lib/convex";
import {
  createDefaultArpeggiatorParams,
  createDefaultSynthParams,
  normalizeSynthParams,
  serializeSynthParams,
  type ArpeggiatorParams,
  type SynthParams,
  type SynthParamsInput,
} from "~/lib/effects/params";
import type { AudioEngine } from "~/lib/audio-engine";
import type { Track } from "~/types/timeline";

type EffectParamsCommitPayload = {
  targetId: string;
  effect: "arp" | "synth";
  from: unknown;
  to: unknown;
};

type EffectsPanelContext = {
  audioEngine?: AudioEngine;
  roomId?: string;
  userId?: string;
  playheadSec?: number;
  grantClipWrite?: (clipId: string) => void;
  onSelectClip?: (trackId: string, clipId: string, startSec: number) => void;
  onEffectParamsCommitted?: (payload: EffectParamsCommitPayload) => void;
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
    reset: () => void;
    toggle: (enabled: boolean) => void;
  };
  synth: {
    change: (updates: Partial<SynthParams>) => void;
    close: () => void;
    expandedCard: Accessor<ExpandedSynthCard | null>;
    isExpandedForCurrentTarget: Accessor<boolean>;
    open: () => void;
    params: Accessor<SynthParams | undefined>;
    reset: () => void;
    updateCardBounds: (next: SynthCardBounds) => void;
  };
};

type TrackEffectState<TParams> = {
  add: () => void;
  flushPending: () => void;
  params: Accessor<TParams | undefined>;
  readForTarget: (targetId: string) => TParams | undefined;
  reset: () => void;
  update: (updater: (prev: TParams) => TParams) => void;
  updateForTarget: (targetId: string, updater: (prev: TParams) => TParams) => void;
};

type TrackEffectStateOptions<TParams> = {
  effect: EffectParamsCommitPayload["effect"];
  query: any;
  queryKey: string;
  readQueryParams: (row: any) => TParams | undefined;
  readVisibleParams: (targetId: string) => TParams | undefined;
  createInitialParams: (targetId: string) => TParams | undefined;
  serializeParams: (params: TParams) => string;
  applyToEngine: (targetId: string, params: TParams) => void;
  clearFromEngine: (targetId: string) => void;
  persistParams: (targetId: string, params: TParams) => void;
  debounceMs?: number;
};

const SAVE_DEBOUNCE_MS = 200;
const LOCAL_EDIT_SUPPRESS_MS = 800;

export function createEffectsPanelState(
  context: EffectsPanelContext,
  currentTargetId: Accessor<string>,
  currentTrack: Accessor<Track | undefined>,
): EffectsPanelState {
  function getTrackTargetId(): string | undefined {
    const targetId = currentTargetId();
    if (!targetId || targetId === "master") return undefined;
    return targetId;
  }

  function persistTrackEffect(targetId: string, mutation: any, params: unknown): void {
    const roomId = context.roomId;
    const userId = context.userId;
    if (!roomId || !userId) return;

    void convexClient.mutation(mutation, {
      roomId,
      trackId: targetId as any,
      userId,
      params,
    });
  }

  function commitEffectChange(
    effect: EffectParamsCommitPayload["effect"],
    targetId: string,
    previous: unknown,
    next: unknown,
  ): void {
    if (previous === undefined) return;

    context.onEffectParamsCommitted?.({
      targetId,
      effect,
      from: previous,
      to: next,
    });
  }

  function createTrackEffectState<TParams>(
    options: TrackEffectStateOptions<TParams>,
  ): TrackEffectState<TParams> {
    const query = useConvexQuery(
      options.query,
      () => {
        const targetId = getTrackTargetId();
        return targetId ? { trackId: targetId as any } : null;
      },
      () => ["effects", options.queryKey, currentTargetId()],
    );

    return createPersistedEffectState<TParams>({
      targetId: getTrackTargetId,
      row: () => query.data,
      readQueryParams: options.readQueryParams,
      readVisibleParams: options.readVisibleParams,
      createInitialParams: options.createInitialParams,
      serializeParams: options.serializeParams,
      applyToEngine: options.applyToEngine,
      clearFromEngine: options.clearFromEngine,
      persistParams: options.persistParams,
      debounceMs: options.debounceMs,
      remoteOverwriteAfterMs: LOCAL_EDIT_SUPPRESS_MS,
      onParamsCommitted: (targetId, previous, next) => {
        commitEffectChange(options.effect, targetId, previous, next);
      },
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

  const arpState = createTrackEffectState<ArpeggiatorParams>({
    effect: "arp",
    query: (convexApi as any).effects.getArpeggiatorForTrack,
    queryKey: "arpeggiator",
    readQueryParams: (row) => row?.params as ArpeggiatorParams | undefined,
    readVisibleParams: () => undefined,
    createInitialParams: () => createDefaultArpeggiatorParams(),
    serializeParams: (params) => JSON.stringify(params),
    applyToEngine: (targetId, params) => {
      context.audioEngine?.setTrackArpeggiator(targetId, params);
    },
    clearFromEngine: (targetId) => {
      context.audioEngine?.clearTrackArpeggiator?.(targetId);
    },
    persistParams: (targetId, params) => {
      persistTrackEffect(targetId, (convexApi as any).effects.setArpeggiatorParams, params);
    },
  });

  const synthState = createTrackEffectState<SynthParams>({
    effect: "synth",
    query: (convexApi as any).effects.getSynthForTrack,
    queryKey: "synth",
    readQueryParams: (row) => {
      return row?.params
        ? normalizeSynthParams(row.params as SynthParamsInput)
        : undefined;
    },
    readVisibleParams: (targetId) => {
      return currentTrack()?.kind === "instrument"
        ? ensureSynthDefaults(targetId)
        : undefined;
    },
    createInitialParams: (targetId) => {
      return currentTrack()?.kind === "instrument"
        ? ensureSynthDefaults(targetId)
        : undefined;
    },
    serializeParams: serializeSynthParams,
    applyToEngine: (targetId, params) => {
      context.audioEngine?.setTrackSynth(targetId, params);
    },
    clearFromEngine: (targetId) => {
      context.audioEngine?.clearTrackSynth?.(targetId);
    },
    persistParams: (targetId, params) => {
      persistTrackEffect(targetId, (convexApi as any).effects.setSynthParams, params);
    },
    debounceMs: SAVE_DEBOUNCE_MS,
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

    const roomId = context.roomId;
    const userId = context.userId;
    if (!roomId || !userId) return;

    const start = Math.max(0, Math.round((context.playheadSec ?? 0) * 1000) / 1000);

    try {
      const clipId = await convexClient.mutation(convexApi.clips.create as any, {
        roomId,
        trackId: track.id as any,
        startSec: start,
        duration: 1,
        userId,
        name: "MIDI Clip",
        clipKind: "midi",
        midi: {
          wave: "sawtooth",
          gain: 0.8,
          notes: [],
        },
      } as any) as any as string;
      if (!clipId) return;

      context.grantClipWrite?.(clipId);
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
      reset: arpState.reset,
      toggle: handleArpToggle,
    },
    synth: {
      change: handleSynthChange,
      close: closeSynthCard,
      expandedCard: expandedSynthCard,
      isExpandedForCurrentTarget: isSynthExpandedForCurrentTarget,
      open: openSynthCard,
      params: synthState.params,
      reset: synthState.reset,
      updateCardBounds: updateSynthCardBounds,
    },
  };
}
