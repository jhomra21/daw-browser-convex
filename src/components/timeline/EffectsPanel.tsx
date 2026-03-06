import {
  type Component,
  Show,
  For,
  createSignal,
  createMemo,
  createEffect,
  untrack,
  onMount,
  onCleanup,
} from "solid-js";
import Arpeggiator from "~/components/effects/Arpeggiator";
import Eq from "~/components/effects/Eq";
import Reverb from "~/components/effects/Reverb";
import Synth from "~/components/effects/Synth";
import SynthCard from "~/components/effects/SynthCard";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from "~/components/ui/dropdown-menu";
import { Button } from "~/components/ui/button";
import {
  createEffectsPanelState,
} from "~/components/timeline/create-effects-panel-state";
import {
  createDefaultEqParams,
  createDefaultReverbParams,
  type EqParams,
  type EqParamsLite,
  type ReverbParams,
  type ReverbParamsLite,
} from "~/lib/effects/params";
import type { AudioEngine, SpectrumFrame } from "~/lib/audio-engine";
import { convexApi, convexClient, useConvexQuery } from "~/lib/convex";
import { FX_PANEL_HEIGHT_PX } from "~/lib/timeline-utils";
import type { Track } from "~/types/timeline";

type EffectsPanelProps = {
  isOpen: boolean;
  selectedFXTarget: string;
  tracks: Track[];
  onClose: () => void;
  onOpen: () => void;
  audioEngine?: AudioEngine;
  roomId?: string;
  userId?: string;
  // Timeline context
  playheadSec?: number;
  onSelectClip?: (trackId: string, clipId: string, startSec: number) => void;
  onEffectParamsCommitted?: (payload: { targetId: string; effect: 'eq'|'reverb'|'synth'|'arp'|'master-eq'|'master-reverb'; from: any; to: any }) => void;
};

const EffectsPanel: Component<EffectsPanelProps> = (props) => {
  const targetName = () => {
    if (currentTargetId() === "master") return "Master";
    return currentTrack()?.name ?? "Track";
  };

  const currentTargetId = () => props.selectedFXTarget || "master";
  const currentTrack = createMemo(() => {
    const id = currentTargetId();
    if (!id || id === "master") return undefined;
    return props.tracks.find((t) => t.id === id);
  });
  const isInstrumentTrack = createMemo(() => currentTrack()?.kind === "instrument");

  const eqLastLocalEdit = new Map<string, number>();
  const reverbLastLocalEdit = new Map<string, number>();
  const eqSaveTimers = new Map<string, number>();
  const reverbSaveTimers = new Map<string, number>();
  const LOCAL_EDIT_SUPPRESS_MS = 800;
  const SAVE_DEBOUNCE_MS = 200;

  const getQueryResult = <T,>(query: any): T | undefined => {
    const raw = query?.data;
    return typeof raw === "function" ? raw() : raw;
  };

  const eqMasterQuery = useConvexQuery(
    convexApi.effects.getEqForMaster,
    () => (props.roomId ? { roomId: props.roomId } : null),
    () => ["effects", "eq", "master", props.roomId],
  );

  const eqTrackQuery = useConvexQuery(
    convexApi.effects.getEqForTrack,
    () => {
      const id = currentTargetId();
      if (!id || id === "master") return null;
      return { trackId: id as any };
    },
    () => ["effects", "eq", "track", currentTargetId()],
  );

  const reverbMasterQuery = useConvexQuery(
    convexApi.effects.getReverbForMaster,
    () => (props.roomId ? { roomId: props.roomId } : null),
    () => ["effects", "reverb", "master", props.roomId],
  );

  const reverbTrackQuery = useConvexQuery(
    convexApi.effects.getReverbForTrack,
    () => {
      const id = currentTargetId();
      if (!id || id === "master") return null;
      return { trackId: id as any };
    },
    () => ["effects", "reverb", "track", currentTargetId()],
  );

  const instrumentState = createEffectsPanelState(props, currentTargetId, currentTrack);

  // Local EQ params per FX target (trackId or 'master'); undefined = no EQ yet
  const [eqByTarget, setEqByTarget] = createSignal<
    Record<string, EqParams | undefined>
  >({});
  const [spectrum, setSpectrum] = createSignal<SpectrumFrame | null>(null);

  const eqForTarget = createMemo(() => {
    const id = currentTargetId();
    const map = eqByTarget();
    return map[id];
  });

  // Live spectrum polling (keeps last non-empty after pause)
  onMount(() => {
    let raf = 0;
    const loop = () => {
      try {
        const id = currentTargetId();
        const data =
          id === "master"
            ? props.audioEngine?.getMasterSpectrum()
            : props.audioEngine?.getTrackSpectrum(id);
        if (data) setSpectrum(data);
      } catch {}
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    onCleanup(() => {
      try {
        cancelAnimationFrame(raf);
      } catch {}
    });
  });

  createEffect(() => {
    void currentTargetId();
    setSpectrum(null);
  });

  function updateEqForTarget(updater: (prev: EqParams) => EqParams) {
    const id = currentTargetId();
    // mark recent local edit to temporarily ignore server hydration
    eqLastLocalEdit.set(id, Date.now());
    setEqByTarget((prev) => ({
      ...prev,
      [id]: updater(prev[id] ?? createDefaultEqParams()),
    }));
  }

  const handleBandChange = (
    bandId: string,
    updates: Partial<EqParams["bands"][number]>,
  ) => {
    updateEqForTarget((prev) => ({
      ...prev!,
      bands: prev!.bands.map((b) =>
        b.id === bandId ? { ...b, ...updates } : b,
      ),
    }));
  };
  const handleBandToggle = (bandId: string) => {
    updateEqForTarget((prev) => ({
      ...prev!,
      bands: prev!.bands.map((b) =>
        b.id === bandId ? { ...b, enabled: !b.enabled } : b,
      ),
    }));
  };
  const handleToggleEnabled = (enabled: boolean) => {
    updateEqForTarget((prev) => ({ ...prev!, enabled }));
  };
  const handleReset = () => {
    updateEqForTarget(() => createDefaultEqParams());
  };

  const lastSaved = new Map<string, string>();
  createEffect(() => {
    const id = currentTargetId();
    if (!id) return;
    const row =
      id === "master"
        ? getQueryResult<any>(eqMasterQuery)
        : getQueryResult<any>(eqTrackQuery);
    if (row === undefined) return;
    if (row?.params) {
      const params = row.params as EqParams;
      const rowJson = JSON.stringify(params);
      const current = (eqByTarget() as any)[id] as EqParams | undefined;
      const currentJson = current ? JSON.stringify(current) : undefined;
      const lastEdit = eqLastLocalEdit.get(id) ?? 0;
      const editing =
        Date.now() - lastEdit < LOCAL_EDIT_SUPPRESS_MS || eqSaveTimers.has(id);
      if (!current) {
        // Initial hydration for this target
        setEqByTarget((prev) => ({ ...prev, [id]: params }));
        lastSaved.set(id, rowJson);
        if (id === "master") {
          props.audioEngine?.setMasterEq(params as EqParamsLite);
        } else {
          props.audioEngine?.setTrackEq(id, params as EqParamsLite);
        }
        setEffectOrderForTarget(id, "eq", (row as any).index);
      } else {
        if (editing) return;
        if (currentJson === rowJson) {
          // Already in sync; keep UI stable, only track order/lastSaved
          lastSaved.set(id, rowJson);
          setEffectOrderForTarget(id, "eq", (row as any).index);
        } else {
          setEqByTarget((prev) => ({ ...prev, [id]: params }));
          lastSaved.set(id, rowJson);
          if (id === "master") {
            props.audioEngine?.setMasterEq(params as EqParamsLite);
          } else {
            props.audioEngine?.setTrackEq(id, params as EqParamsLite);
          }
          setEffectOrderForTarget(id, "eq", (row as any).index);
        }
      }
    } else {
      // Only clear when not actively editing
      const lastEdit = eqLastLocalEdit.get(id) ?? 0;
      if (
        Date.now() - lastEdit >= LOCAL_EDIT_SUPPRESS_MS &&
        !eqSaveTimers.has(id)
      ) {
        setEqByTarget((prev) => ({ ...prev, [id]: undefined }));
      }
    }
  });

  // Apply to audio engine and persist when params change
  createEffect(() => {
    const id = currentTargetId();
    if (!id) return;
    const params = eqForTarget();
    if (!params) return;
    const json = JSON.stringify(params);
    if (lastSaved.get(id) === json) return;
    const prev = lastSaved.get(id);
    lastSaved.set(id, json);
    // Apply immediately to engine for responsive audio
    if (id === "master") {
      props.audioEngine?.setMasterEq(params as unknown as EqParamsLite);
    } else {
      props.audioEngine?.setTrackEq(id, params as unknown as EqParamsLite);
    }
    // Debounce server persistence per target
    const prevTimer = eqSaveTimers.get(id);
    if (prevTimer) {
      try {
        clearTimeout(prevTimer);
      } catch {}
    }
    if (props.roomId && props.userId) {
      const timer = window.setTimeout(() => {
        eqSaveTimers.delete(id);
        if (id === "master") {
          void convexClient.mutation(convexApi.effects.setMasterEqParams, {
            roomId: props.roomId!,
            userId: props.userId!,
            params,
          });
        } else {
          void convexClient.mutation(convexApi.effects.setEqParams, {
            roomId: props.roomId!,
            trackId: id as any,
            userId: props.userId!,
            params,
          });
        }
      }, SAVE_DEBOUNCE_MS);
      eqSaveTimers.set(id, timer);
    }
    try {
      if (prev)
        props.onEffectParamsCommitted?.({
          targetId: id,
          effect: id === "master" ? "master-eq" : "eq",
          from: JSON.parse(prev),
          to: params,
        });
    } catch {}
  });

  // ===== Reverb wiring (parallel to EQ) =====
  const [reverbByTarget, setReverbByTarget] = createSignal<
    Record<string, ReverbParams | undefined>
  >({});
  const reverbForTarget = createMemo(() => reverbByTarget()[currentTargetId()]);
  const updateReverbForTarget = (
    updater: (prev: ReverbParams) => ReverbParams,
  ) => {
    const id = currentTargetId();
    reverbLastLocalEdit.set(id, Date.now());
    setReverbByTarget((prev) => ({
      ...prev,
      [id]: updater(prev[id] ?? createDefaultReverbParams()),
    }));
  };
  const handleReverbChange = (updates: Partial<ReverbParams>) => {
    updateReverbForTarget((prev) => ({ ...prev!, ...updates }));
  };
  const handleReverbToggle = (enabled: boolean) => {
    updateReverbForTarget((prev) => ({ ...prev!, enabled }));
  };
  const handleReverbReset = () => {
    updateReverbForTarget(() => createDefaultReverbParams());
  };

  const lastSavedReverb = new Map<string, string>();
  createEffect(() => {
    const id = currentTargetId();
    if (!id) return;
    const row =
      id === "master"
        ? getQueryResult<any>(reverbMasterQuery)
        : getQueryResult<any>(reverbTrackQuery);
    if (row === undefined) return;
    if (row?.params) {
      const params = row.params as ReverbParams;
      const rowJson = JSON.stringify(params);
      const current = (reverbByTarget() as any)[id] as ReverbParams | undefined;
      const currentJson = current ? JSON.stringify(current) : undefined;
      const lastEdit = reverbLastLocalEdit.get(id) ?? 0;
      const editing =
        Date.now() - lastEdit < LOCAL_EDIT_SUPPRESS_MS ||
        reverbSaveTimers.has(id);
      if (!current) {
        setReverbByTarget((prev) => ({ ...prev, [id]: params }));
        lastSavedReverb.set(id, rowJson);
        if (id === "master") {
          props.audioEngine?.setMasterReverb(
            params as unknown as ReverbParamsLite,
          );
        } else {
          props.audioEngine?.setTrackReverb(
            id,
            params as unknown as ReverbParamsLite,
          );
        }
        setEffectOrderForTarget(id, "reverb", (row as any).index);
      } else {
        if (editing) return;
        if (currentJson === rowJson) {
          lastSavedReverb.set(id, rowJson);
          setEffectOrderForTarget(id, "reverb", (row as any).index);
        } else {
          setReverbByTarget((prev) => ({ ...prev, [id]: params }));
          lastSavedReverb.set(id, rowJson);
          if (id === "master") {
            props.audioEngine?.setMasterReverb(
              params as unknown as ReverbParamsLite,
            );
          } else {
            props.audioEngine?.setTrackReverb(
              id,
              params as unknown as ReverbParamsLite,
            );
          }
          setEffectOrderForTarget(id, "reverb", (row as any).index);
        }
      }
    } else {
      const lastEdit = reverbLastLocalEdit.get(id) ?? 0;
      if (
        Date.now() - lastEdit >= LOCAL_EDIT_SUPPRESS_MS &&
        !reverbSaveTimers.has(id)
      ) {
        setReverbByTarget((prev) => ({ ...prev, [id]: undefined }));
      }
    }
  });

  // Apply/persist reverb when params change
  createEffect(() => {
    const id = currentTargetId();
    if (!id) return;
    const params = reverbForTarget();
    if (!params) return;
    const json = JSON.stringify(params);
    if (lastSavedReverb.get(id) === json) return;
    const prev = lastSavedReverb.get(id);
    lastSavedReverb.set(id, json);
    // Apply immediately to engine for responsive audio
    if (id === "master") {
      props.audioEngine?.setMasterReverb(params as unknown as ReverbParamsLite);
    } else {
      props.audioEngine?.setTrackReverb(
        id,
        params as unknown as ReverbParamsLite,
      );
    }
    // Debounce server persistence per target
    const prevTimer = reverbSaveTimers.get(id);
    if (prevTimer) {
      try {
        clearTimeout(prevTimer);
      } catch {}
    }
    if (props.roomId && props.userId) {
      const timer = window.setTimeout(() => {
        reverbSaveTimers.delete(id);
        if (id === "master") {
          void convexClient.mutation(convexApi.effects.setMasterReverbParams, {
            roomId: props.roomId!,
            userId: props.userId!,
            params,
          });
        } else {
          void convexClient.mutation(convexApi.effects.setReverbParams, {
            roomId: props.roomId!,
            trackId: id as any,
            userId: props.userId!,
            params,
          });
        }
      }, SAVE_DEBOUNCE_MS);
      reverbSaveTimers.set(id, timer);
    }
    try {
      if (prev)
        props.onEffectParamsCommitted?.({
          targetId: id,
          effect: id === "master" ? "master-reverb" : "reverb",
          from: JSON.parse(prev),
          to: params,
        });
    } catch {}
  });

  // ===== Effect ordering (per target) =====
  type EffectKind = "eq" | "reverb";
  const [effectOrderByTarget, setEffectOrderByTarget] = createSignal<
    Record<string, EffectKind[]>
  >({});
  const [effectIndexByTarget, setEffectIndexByTarget] = createSignal<
    Record<string, Partial<Record<EffectKind, number>>>
  >({});

  function setEffectOrderForTarget(
    targetId: string,
    kind: EffectKind,
    index?: number,
  ) {
    if (typeof index === "number") {
      setEffectIndexByTarget((prev) => {
        const next = { ...prev };
        next[targetId] = { ...(next[targetId] ?? {}), [kind]: index };
        return next;
      });
      const idxCurrent = untrack(() => effectIndexByTarget()[targetId] ?? {});
      const idx = { ...idxCurrent, [kind]: index };
      const entries: { kind: EffectKind; idx: number }[] = [];
      if (typeof idx.eq === "number")
        entries.push({ kind: "eq", idx: idx.eq as number });
      if (typeof idx.reverb === "number")
        entries.push({ kind: "reverb", idx: idx.reverb as number });
      if (entries.length > 0) {
        entries.sort((a, b) => a.idx - b.idx);
        setEffectOrderByTarget((prev) => ({
          ...prev,
          [targetId]: entries.map((e) => e.kind),
        }));
        return;
      }
    }
    appendEffectOrder(targetId, kind);
  }

  function appendEffectOrder(targetId: string, kind: EffectKind) {
    setEffectOrderByTarget((prev) => {
      const arr = prev[targetId] ?? [];
      if (arr.includes(kind)) return prev;
      return { ...prev, [targetId]: [...arr, kind] };
    });
  }

  const orderedEffects = createMemo<EffectKind[]>(() => {
    const id = currentTargetId();
    const map = effectOrderByTarget();
    const arr = map[id];
    if (arr && arr.length > 0) return arr;
    // Fallback by presence
    const present: EffectKind[] = [];
    if (eqForTarget()) present.push("eq");
    if (reverbForTarget()) present.push("reverb");
    if (present.length === 2) return ["eq", "reverb"];
    return present;
  });

  function handleAddReverb() {
    const id = currentTargetId();
    if (!id) return;

    const params = createDefaultReverbParams();
    setReverbByTarget((prev) => ({ ...prev, [id]: params }));
    appendEffectOrder(id, "reverb");

    if (id === "master") {
      props.audioEngine?.setMasterReverb(
        params as unknown as ReverbParamsLite,
      );
      if (props.roomId && props.userId) {
        void convexClient.mutation(convexApi.effects.setMasterReverbParams, {
          roomId: props.roomId,
          userId: props.userId,
          params,
        });
      }
    } else {
      props.audioEngine?.setTrackReverb(
        id,
        params as unknown as ReverbParamsLite,
      );
      if (props.roomId && props.userId) {
        void convexClient.mutation(convexApi.effects.setReverbParams, {
          roomId: props.roomId,
          trackId: id as any,
          userId: props.userId,
          params,
        });
      }
    }

    lastSavedReverb.set(id, JSON.stringify(params));
  }
  function handleAddEq() {
    const id = currentTargetId();
    if (!id) return;
    const params = createDefaultEqParams();
    setEqByTarget((prev) => ({ ...prev, [id]: params }));
    appendEffectOrder(id, "eq");
    // Apply immediately
    if (id === "master") {
      props.audioEngine?.setMasterEq(params as unknown as EqParamsLite);
      if (props.roomId && props.userId) {
        void convexClient.mutation(
          (convexApi as any).effects.setMasterEqParams,
          {
            roomId: props.roomId,
            userId: props.userId,
            params,
          },
        );
      }
    } else {
      props.audioEngine?.setTrackEq(id, params as EqParamsLite);
      if (props.roomId && props.userId) {
        void convexClient.mutation(convexApi.effects.setEqParams, {
          roomId: props.roomId,
          trackId: id as any,
          userId: props.userId,
          params,
        });
      }
    }
    lastSaved.set(id, JSON.stringify(params));
  }

  return (
    <>
      <Show when={props.isOpen}>
        <div class="fixed left-0 right-0 bottom-0 z-50 border-t border-neutral-800 bg-neutral-900">
          <div class="flex" style={{ height: `${FX_PANEL_HEIGHT_PX}px` }}>
            <div class="flex w-20 flex-col items-center gap-2 border-r border-neutral-800 px-2 py-2">
              <Button
                variant="outline"
                size="sm"
                class="w-full text-[10px] py-1"
                onClick={props.onClose}
              >
                Hide
              </Button>
              <Show
                when={isInstrumentTrack()}
              >
                <Button
                  variant="default"
                  size="sm"
                  class="w-full text-[10px] py-1 px-1"
                  onClick={instrumentState.addMidiClip}
                >
                  + MIDI
                </Button>
              </Show>
              <div class="flex flex-1 items-center justify-center">
                <span
                  class="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.15em] text-neutral-300"
                  style={{
                    transform: "rotate(-90deg)",
                    "white-space": "nowrap",
                  }}
                >
                  {targetName()}
                </span>
              </div>
            </div>
            <div class="flex flex-1 flex-col overflow-hidden min-h-0">
              <div class="flex flex-wrap items-center gap-1.5 px-2 py-0.5 border-b border-neutral-800/50 min-h-[28px]">
                <Show
                  when={
                    currentTrack() &&
                    currentTrack()!.kind === "instrument" &&
                    !instrumentState.arp.params()
                  }
                >
                  <Button
                    variant="default"
                    size="sm"
                    class="text-[11px] py-0.5 px-2 h-6"
                    onClick={instrumentState.arp.add}
                  >
                    + Arp
                  </Button>
                </Show>
                <Show when={!eqForTarget()}>
                  <Button
                    variant="default"
                    size="sm"
                    class="text-[11px] py-0.5 px-2 h-6"
                    onClick={handleAddEq}
                  >
                    + EQ
                  </Button>
                </Show>
                <Show when={!reverbForTarget()}>
                  <Button
                    variant="default"
                    size="sm"
                    class="text-[11px] py-0.5 px-2 h-6"
                    onClick={handleAddReverb}
                  >
                    + Reverb
                  </Button>
                </Show>
                <div class="ml-auto">
                  <DropdownMenu>
                    <DropdownMenuTrigger>
                      <Button
                        variant="outline"
                        size="sm"
                        class="text-[11px] py-0.5 px-2 h-6"
                        aria-label="Show keyboard shortcuts"
                      >
                        Shortcuts
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      class="bg-neutral-900 text-neutral-100"
                      style={{ width: "min(92vw, 22rem)" }}
                    >
                      <DropdownMenuLabel class="text-neutral-400">
                        Timeline
                      </DropdownMenuLabel>
                      <DropdownMenuItem disabled>
                        Play / Pause
                        <DropdownMenuShortcut>Space</DropdownMenuShortcut>
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled>
                        Delete selection or track
                        <DropdownMenuShortcut>
                          Del / Backspace
                        </DropdownMenuShortcut>
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled>
                        Duplicate clips
                        <DropdownMenuShortcut>
                          Ctrl/Cmd + D
                        </DropdownMenuShortcut>
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled>
                        Add Audio Track
                        <DropdownMenuShortcut>Shift + T</DropdownMenuShortcut>
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled>
                        Add Instrument Track
                        <DropdownMenuShortcut>
                          Ctrl/Cmd + Shift + T
                        </DropdownMenuShortcut>
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled>
                        Toggle Sidebar
                        <DropdownMenuShortcut>
                          Ctrl/Cmd + B
                        </DropdownMenuShortcut>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel class="text-neutral-400">
                        MIDI Editor (when keyboard enabled)
                      </DropdownMenuLabel>
                      <DropdownMenuItem disabled>
                        Note keys
                        <DropdownMenuShortcut>
                          A S D F G H J K L ;
                        </DropdownMenuShortcut>
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled>
                        Sharp keys
                        <DropdownMenuShortcut>
                          W E T Y U O P
                        </DropdownMenuShortcut>
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled>
                        Octave down
                        <DropdownMenuShortcut>Z</DropdownMenuShortcut>
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled>
                        Octave up
                        <DropdownMenuShortcut>X</DropdownMenuShortcut>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
              <div class="flex-1 overflow-x-auto overflow-y-hidden px-2 py-2 min-h-0">
                <div class="flex items-stretch gap-3 h-full min-w-min min-h-0">
                  {/* MIDI Effects (pre-synth) - LEFTMOST */}
                  <Show
                    when={
                      currentTrack() &&
                      currentTrack()!.kind === "instrument" &&
                      !!instrumentState.arp.params()
                    }
                  >
                    <Arpeggiator
                      params={instrumentState.arp.params()!}
                      onChange={instrumentState.arp.change}
                      onToggleEnabled={instrumentState.arp.toggle}
                      onReset={instrumentState.arp.reset}
                      class="min-w-[280px]"
                    />
                  </Show>

                  {/* Instrument (Synth) */}
                  <Show
                    when={
                      currentTrack() &&
                      currentTrack()!.kind === "instrument" &&
                      !!instrumentState.synth.params() &&
                      !instrumentState.synth.isExpandedForCurrentTarget()
                    }
                  >
                    <Synth
                      params={instrumentState.synth.params()!}
                      onChange={instrumentState.synth.change}
                      onReset={instrumentState.synth.reset}
                      onExpand={instrumentState.synth.open}
                      variant="compact"
                      class="min-w-[280px]"
                    />
                  </Show>
                  <Show
                    when={
                      currentTrack() &&
                      currentTrack()!.kind === "instrument" &&
                      !!instrumentState.synth.params() &&
                      instrumentState.synth.isExpandedForCurrentTarget()
                    }
                  >
                    <div class="min-w-[200px] flex items-center justify-between px-2 py-2 rounded border border-neutral-800 bg-neutral-900 text-neutral-300">
                      <span class="text-xs">Synth is expanded</span>
                      <button
                        class="text-xs px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300 border border-neutral-700"
                        onClick={instrumentState.synth.close}
                      >Restore</button>
                    </div>
                  </Show>

                  <For each={orderedEffects()}>
                    {(eff) => (
                      <Show
                        when={eff === "eq"}
                        fallback={
                          <Show when={!!reverbForTarget()}>
                            <Reverb
                              params={reverbForTarget()!}
                              onChange={handleReverbChange}
                              onToggleEnabled={handleReverbToggle}
                              onReset={handleReverbReset}
                              class="min-w-[280px]"
                            />
                          </Show>
                        }
                      >
                        <Show when={!!eqForTarget()}>
                          <Eq
                            bands={eqForTarget()!.bands}
                            enabled={eqForTarget()!.enabled}
                            onBandChange={handleBandChange}
                            onBandToggle={handleBandToggle}
                            onToggleEnabled={handleToggleEnabled}
                            onReset={handleReset}
                            class="min-w-[320px]"
                            spectrumData={spectrum()}
                          />
                        </Show>
                      </Show>
                    )}
                  </For>

                  <Show
                    when={
                      !eqForTarget() &&
                      !reverbForTarget() &&
                      !instrumentState.arp.params() &&
                      (!instrumentState.synth.params() ||
                        !currentTrack() ||
                        currentTrack()!.kind !== "instrument")
                    }
                  >
                    <div class="flex items-center text-sm text-neutral-400 px-4">
                      No effects on this{" "}
                      {currentTargetId() === "master" ? "master bus" : "track"}.
                      Use Add EQ or Add Reverb.
                    </div>
                  </Show>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Show>

      <Show when={!props.isOpen}>
        <button
          class="fixed bottom-4 right-4 bg-neutral-800 text-white rounded-md px-3 py-2 border border-neutral-700 hover:bg-neutral-700"
          onClick={props.onOpen}
        >
          Open Effects
        </button>
      </Show>

      {/* Floating Synth card */}
      <Show when={!!instrumentState.synth.expandedCard()}>
        {(() => {
          const card = instrumentState.synth.expandedCard()!;
          return (
            <SynthCard
              params={card.params}
              onChange={card.onChange}
              onReset={card.onReset}
              x={card.x}
              y={card.y}
              w={card.w}
              h={card.h}
              onChangeBounds={instrumentState.synth.updateCardBounds}
              onClose={instrumentState.synth.close}
            />
          )
        })()}
      </Show>
      {/* Shortcuts dropdown implemented above; removed dialog variant */}
    </>
  );
};

export default EffectsPanel;

