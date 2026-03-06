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

const LOCAL_EDIT_SUPPRESS_MS = 800;
const SAVE_DEBOUNCE_MS = 200;

function getQueryResult<T>(query: unknown): T | undefined {
  const raw = (query as { data?: unknown })?.data;
  return typeof raw === "function" ? (raw as () => T)() : (raw as T | undefined);
}

function parseJsonValue(value: string | undefined): unknown {
  if (!value) return undefined;

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

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

  function persistArpeggiator(targetId: string, params: ArpeggiatorParams): void {
    const roomId = context.roomId;
    const userId = context.userId;
    if (!roomId || !userId) return;

    void convexClient.mutation((convexApi as any).effects.setArpeggiatorParams, {
      roomId,
      trackId: targetId as any,
      userId,
      params,
    });
  }

  function persistSynth(targetId: string, params: SynthParamsInput): void {
    const roomId = context.roomId;
    const userId = context.userId;
    if (!roomId || !userId) return;

    void convexClient.mutation((convexApi as any).effects.setSynthParams, {
      roomId,
      trackId: targetId as any,
      userId,
      params,
    });
  }

  function commitEffectChange(
    effect: EffectParamsCommitPayload["effect"],
    targetId: string,
    previous: string | undefined,
    next: unknown,
  ): void {
    const from = parseJsonValue(previous);
    if (from === undefined) return;

    context.onEffectParamsCommitted?.({
      targetId,
      effect,
      from,
      to: next,
    });
  }

  const synthLastLocalEdit = new Map<string, number>();
  const synthSaveTimers = new Map<string, number>();

  const arpeggiatorQuery = useConvexQuery(
    (convexApi as any).effects.getArpeggiatorForTrack,
    () => {
      const targetId = getTrackTargetId();
      return targetId ? { trackId: targetId as any } : null;
    },
    () => ["effects", "arpeggiator", currentTargetId()],
  );

  const synthQuery = useConvexQuery(
    (convexApi as any).effects.getSynthForTrack,
    () => {
      const targetId = getTrackTargetId();
      return targetId ? { trackId: targetId as any } : null;
    },
    () => ["effects", "synth", currentTargetId()],
  );

  const [arpByTarget, setArpByTarget] = createSignal<Record<string, ArpeggiatorParams | undefined>>({});
  const arpForTarget = createMemo(() => arpByTarget()[currentTargetId()]);

  const [synthByTarget, setSynthByTarget] = createSignal<Record<string, SynthParams | undefined>>({});
  const synthForTarget = createMemo(() => synthByTarget()[currentTargetId()]);

  const [expandedSynth, setExpandedSynth] = createSignal<ExpandedSynthBounds | null>(null);

  const lastSavedArp = new Map<string, string>();
  createEffect(() => {
    const targetId = getTrackTargetId();
    if (!targetId) return;

    const row = getQueryResult<any>(arpeggiatorQuery);
    if (row === undefined) return;

    if (row?.params) {
      const params = row.params as ArpeggiatorParams;
      setArpByTarget((prev) => ({ ...prev, [targetId]: params }));
      lastSavedArp.set(targetId, JSON.stringify(params));
      context.audioEngine?.setTrackArpeggiator(targetId, params);
      return;
    }

    setArpByTarget((prev) => ({ ...prev, [targetId]: undefined }));
    context.audioEngine?.clearTrackArpeggiator?.(targetId);
  });

  createEffect(() => {
    const targetId = getTrackTargetId();
    if (!targetId) return;

    const params = arpForTarget();
    if (!params) return;

    const json = JSON.stringify(params);
    if (lastSavedArp.get(targetId) === json) return;

    const previous = lastSavedArp.get(targetId);
    lastSavedArp.set(targetId, json);
    context.audioEngine?.setTrackArpeggiator(targetId, params);
    persistArpeggiator(targetId, params);
    commitEffectChange("arp", targetId, previous, params);
  });

  function updateArp(updater: (prev: ArpeggiatorParams) => ArpeggiatorParams): void {
    const targetId = getTrackTargetId();
    if (!targetId) return;

    setArpByTarget((prev) => ({
      ...prev,
      [targetId]: updater(prev[targetId] ?? createDefaultArpeggiatorParams()),
    }));
  }

  function handleArpChange(updates: Partial<ArpeggiatorParams>): void {
    updateArp((prev) => ({ ...prev, ...updates }));
  }

  function handleArpToggle(enabled: boolean): void {
    updateArp((prev) => ({ ...prev, enabled }));
  }

  function handleArpReset(): void {
    updateArp(() => createDefaultArpeggiatorParams());
  }

  function handleAddArp(): void {
    const targetId = getTrackTargetId();
    if (!targetId) return;

    const params = createDefaultArpeggiatorParams();
    setArpByTarget((prev) => ({ ...prev, [targetId]: params }));
    context.audioEngine?.setTrackArpeggiator(targetId, params);
    persistArpeggiator(targetId, params);
    lastSavedArp.set(targetId, JSON.stringify(params));
  }

  function applySynthForTarget(targetId: string, updater: (prev: SynthParams) => SynthParams): void {
    setSynthByTarget((prev) => {
      const base = prev[targetId] ?? createDefaultSynthParams();
      return {
        ...prev,
        [targetId]: normalizeSynthParams(updater(base)),
      };
    });
  }

  const lastSavedSynth = new Map<string, string>();
  createEffect(() => {
    const targetId = getTrackTargetId();
    if (!targetId) return;

    const row = getQueryResult<any>(synthQuery);
    if (row === undefined) return;

    if (!row?.params) {
      const track = currentTrack();
      if (track?.kind === "instrument") {
        setSynthByTarget((prev) => {
          if (prev[targetId]) return prev;

          const defaults = createDefaultSynthParams();
          lastSavedSynth.set(targetId, serializeSynthParams(defaults));
          context.audioEngine?.setTrackSynth(targetId, defaults);
          return { ...prev, [targetId]: defaults };
        });
        return;
      }

      setSynthByTarget((prev) => ({ ...prev, [targetId]: undefined }));
      return;
    }

    const params = normalizeSynthParams(row.params as SynthParamsInput);
    const current = synthByTarget()[targetId];
    const rowJson = serializeSynthParams(params);
    const currentJson = current ? serializeSynthParams(current) : undefined;
    const lastEdit = synthLastLocalEdit.get(targetId) ?? 0;
    const isEditing = Date.now() - lastEdit < LOCAL_EDIT_SUPPRESS_MS || synthSaveTimers.has(targetId);

    if (!current) {
      setSynthByTarget((prev) => ({ ...prev, [targetId]: params }));
      lastSavedSynth.set(targetId, rowJson);
      context.audioEngine?.setTrackSynth(targetId, params);
      return;
    }

    if (isEditing) return;

    if (currentJson !== rowJson) {
      setSynthByTarget((prev) => ({ ...prev, [targetId]: params }));
      lastSavedSynth.set(targetId, rowJson);
      context.audioEngine?.setTrackSynth(targetId, params);
      return;
    }

    lastSavedSynth.set(targetId, rowJson);
  });

  createEffect(() => {
    const targetId = getTrackTargetId();
    if (!targetId) return;

    const params = synthForTarget();
    if (!params) return;

    const payload = normalizeSynthParams(params);
    const json = serializeSynthParams(payload);
    if (lastSavedSynth.get(targetId) === json) return;

    const previous = lastSavedSynth.get(targetId);
    lastSavedSynth.set(targetId, json);
    context.audioEngine?.setTrackSynth(targetId, payload);

    const previousTimer = synthSaveTimers.get(targetId);
    if (previousTimer) {
      clearTimeout(previousTimer);
    }

    if (context.roomId && context.userId) {
      const timer = window.setTimeout(() => {
        synthSaveTimers.delete(targetId);
        persistSynth(targetId, payload);
      }, SAVE_DEBOUNCE_MS);
      synthSaveTimers.set(targetId, timer);
    }

    commitEffectChange("synth", targetId, previous, payload);
  });

  function updateSynth(updater: (prev: SynthParams) => SynthParams): void {
    const targetId = getTrackTargetId();
    if (!targetId) return;

    synthLastLocalEdit.set(targetId, Date.now());
    applySynthForTarget(targetId, updater);
  }

  function handleSynthChange(updates: Partial<SynthParams>): void {
    updateSynth((prev) => ({ ...prev, ...updates }));
  }

  function handleSynthReset(): void {
    updateSynth(() => createDefaultSynthParams());
  }

  function handleSynthChangeForTarget(targetId: string, updates: Partial<SynthParams>): void {
    synthLastLocalEdit.set(targetId, Date.now());
    applySynthForTarget(targetId, (prev) => ({ ...prev, ...updates }));
  }

  function handleSynthResetForTarget(targetId: string): void {
    applySynthForTarget(targetId, () => createDefaultSynthParams());
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
    return synthByTarget()[targetId] ?? createDefaultSynthParams();
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
      } as any) as any as string;
      if (!clipId) return;

      await convexClient.mutation((convexApi as any).clips.setMidi, {
        clipId: clipId as any,
        midi: {
          wave: "sawtooth",
          gain: 0.8,
          notes: [],
        },
        userId,
      });

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
      onChange: (updates) => handleSynthChangeForTarget(current.targetId, updates),
      onReset: () => handleSynthResetForTarget(current.targetId),
    };
  });

  const isSynthExpandedForCurrentTarget = createMemo(
    () => expandedSynth()?.targetId === currentTargetId(),
  );

  return {
    addMidiClip: handleAddMidiClip,
    arp: {
      add: handleAddArp,
      change: handleArpChange,
      params: arpForTarget,
      reset: handleArpReset,
      toggle: handleArpToggle,
    },
    synth: {
      change: handleSynthChange,
      close: closeSynthCard,
      expandedCard: expandedSynthCard,
      isExpandedForCurrentTarget: isSynthExpandedForCurrentTarget,
      open: openSynthCard,
      params: synthForTarget,
      reset: handleSynthReset,
      updateCardBounds: updateSynthCardBounds,
    },
  };
}

