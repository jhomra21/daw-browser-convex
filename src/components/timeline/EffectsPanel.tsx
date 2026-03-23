import {
  type Component,
  Show,
  For,
  createSignal,
  createMemo,
  createEffect,
  untrack,
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
import { createPersistedEffectState } from "~/components/timeline/create-persisted-effect-state";
import {
  createEffectsPanelState,
} from "~/components/timeline/create-effects-panel-state";
import {
  createDefaultEqParams,
  createDefaultReverbParams,
  type ArpeggiatorParams,
  normalizeSynthParams,
  type EqParams,
  type EqParamsLite,
  type ReverbParams,
  type ReverbParamsLite,
  type SynthParamsInput,
} from "~/lib/effects/params";
import type { AudioEngine, SpectrumFrame } from "~/lib/audio-engine";
import { convexApi, convexClient, useConvexQuery } from "~/lib/convex";
import { getTrackChannelRole } from "~/lib/track-routing";
import { FX_PANEL_HEIGHT_PX } from "~/lib/timeline-utils";
import type { Track, TrackSend } from "~/types/timeline";

type EffectsPanelProps = {
  isOpen: boolean;
  selectedFXTarget: string;
  tracks: Track[];
  onClose: () => void;
  onOpen: () => void;
  audioEngine?: AudioEngine;
  roomId?: string;
  userId?: string;
  canWriteTrackRouting?: (trackId: string) => boolean;
  grantClipWrite?: (clipId: string) => void;
  // Timeline context
  playheadSec?: number;
  onSelectClip?: (trackId: string, clipId: string, startSec: number) => void;
  onTrackSendsChange?: (trackId: string, sends: TrackSend[]) => void;
  onTrackOutputTargetChange?: (trackId: string, outputTargetId?: string) => void;
  onEffectParamsCommitted?: (payload: { targetId: string; effect: 'eq'|'reverb'|'synth'|'arp'|'master-eq'|'master-reverb'; from: any; to: any }) => void;
};

const EffectsPanel: Component<EffectsPanelProps> = (props) => {
  type EffectKind = "eq" | "reverb";
  type EffectCommitKind = "eq" | "reverb" | "master-eq" | "master-reverb";
  type ManagedEffectConfig<TParams, TParamsLite> = {
    kind: EffectKind;
    trackCommitEffect: EffectKind;
    masterCommitEffect: EffectCommitKind;
    createDefaultParams: () => TParams;
    masterQueryApi: unknown;
    trackQueryApi: unknown;
    applyToEngine: (targetId: string, params: TParamsLite) => void;
    persist: (targetId: string, params: TParams) => Promise<unknown>;
  };

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
  const currentTrackRole = createMemo(() => getTrackChannelRole(currentTrack()));
  const isInstrumentTrack = createMemo(() => currentTrack()?.kind === "instrument");
  const isGroupTrack = createMemo(() => currentTrackRole() === "group");
  const canEditSends = createMemo(() => currentTrackRole() === "track");
  const canWriteCurrentTrackRouting = createMemo(() => {
    const track = currentTrack();
    if (!track) return false;
    return props.canWriteTrackRouting ? props.canWriteTrackRouting(track.id) : true;
  });
  const returnTracks = createMemo(() =>
    props.tracks.filter((track) => getTrackChannelRole(track) === "return" && track.id !== currentTargetId()),
  );
  const groupTracks = createMemo(() =>
    props.tracks.filter((track) => getTrackChannelRole(track) === "group" && track.id !== currentTargetId()),
  );
  const currentTrackSends = () => currentTrack()?.sends ?? [];
  const currentTrackOutputTargetId = () => currentTrack()?.outputTargetId ?? "";
  const currentSendAmountByTarget = createMemo(() => {
    const next = new Map<string, number>();
    for (const send of currentTrackSends()) {
      next.set(send.targetId, send.amount);
    }
    return next;
  });

  const LOCAL_EDIT_SUPPRESS_MS = 800;
  const SAVE_DEBOUNCE_MS = 200;


  // ===== Effect ordering (per target) =====
  const [effectOrderByTarget, setEffectOrderByTarget] = createSignal<
    Record<string, EffectKind[]>
  >({});
  const [effectIndexByTarget, setEffectIndexByTarget] = createSignal<
    Record<string, Partial<Record<EffectKind, number>>>
  >({});

  function appendEffectOrder(targetId: string, kind: EffectKind) {
    setEffectOrderByTarget((prev) => {
      const arr = prev[targetId] ?? [];
      if (arr.includes(kind)) return prev;
      return { ...prev, [targetId]: [...arr, kind] };
    });
  }

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
          [targetId]: entries.map((entry) => entry.kind),
        }));
        return;
      }
    }
    appendEffectOrder(targetId, kind);
  }

  function createManagedEffectState<TParams extends EqParams | ReverbParams, TParamsLite extends EqParamsLite | ReverbParamsLite>(
    config: ManagedEffectConfig<TParams, TParamsLite>,
  ) {
    const masterQuery = useConvexQuery(
      config.masterQueryApi as any,
      () => (props.roomId ? { roomId: props.roomId } : null),
      () => ["effects", config.kind, "master", props.roomId],
    );

    const trackQuery = useConvexQuery(
      config.trackQueryApi as any,
      () => {
        const id = currentTargetId();
        if (!id || id === "master") return null;
        return { trackId: id as any };
      },
      () => ["effects", config.kind, "track", currentTargetId()],
    );

    return createPersistedEffectState<TParams>({
      targetId: currentTargetId,
      row: () => currentTargetId() === "master"
        ? masterQuery.data
        : trackQuery.data,
      readQueryParams: (row) => row?.params as TParams | undefined,
      createInitialParams: () => config.createDefaultParams(),
      serializeParams: (params) => JSON.stringify(params),
      applyToEngine: (targetId, params) => {
        config.applyToEngine(targetId, params as unknown as TParamsLite);
      },
      persistParams: (targetId, params) => config.persist(targetId, params),
      debounceMs: SAVE_DEBOUNCE_MS,
      remoteOverwriteAfterMs: LOCAL_EDIT_SUPPRESS_MS,
      onQueryRow: (targetId, row) => {
        if (row?.params) {
          setEffectOrderForTarget(targetId, config.kind, row.index as number | undefined);
        }
      },
      onParamsCommitted: (targetId, previous, next) => {
        if (previous === undefined) return;
        props.onEffectParamsCommitted?.({
          targetId,
          effect: targetId === "master" ? config.masterCommitEffect : config.trackCommitEffect,
          from: previous,
          to: next,
        });
      },
    });
  }

  const instrumentState = createEffectsPanelState(props, currentTargetId, currentTrack);
  const roomEffects = useConvexQuery(
    (convexApi as any).effects.listByRoom,
    () => props.roomId ? { roomId: props.roomId } : null,
    () => ["effects", "room", props.roomId],
  );
  const disabledEq = { ...createDefaultEqParams(), enabled: false };
  const disabledReverb = { ...createDefaultReverbParams(), enabled: false };

  createEffect(() => {
    const audioEngine = props.audioEngine;
    const effects = roomEffects.data;
    if (!audioEngine || !effects) return;

    const activeTargetId = currentTargetId();
    const eqByTrackId = new Map<string, EqParamsLite>();
    const reverbByTrackId = new Map<string, ReverbParamsLite>();
    const synthByTrackId = new Map<string, SynthParamsInput>();
    const arpByTrackId = new Map<string, ArpeggiatorParams>();
    let hasMasterEq = false;
    let hasMasterReverb = false;

    for (const row of effects) {
      if (row?.targetType === "master") {
        if (activeTargetId === "master") continue;
        if (row.type === "eq" && row.params) {
          hasMasterEq = true;
          audioEngine.setMasterEq(row.params as EqParamsLite);
        }
        if (row.type === "reverb" && row.params) {
          hasMasterReverb = true;
          audioEngine.setMasterReverb(row.params as ReverbParamsLite);
        }
        continue;
      }

      const trackId = row?.trackId as string | undefined;
      if (!trackId || trackId === activeTargetId) continue;
      if (row.type === "eq" && row.params) eqByTrackId.set(trackId, row.params as EqParamsLite);
      if (row.type === "reverb" && row.params) reverbByTrackId.set(trackId, row.params as ReverbParamsLite);
      if (row.type === "synth" && row.params) synthByTrackId.set(trackId, normalizeSynthParams(row.params as SynthParamsInput));
      if (row.type === "arpeggiator" && row.params) arpByTrackId.set(trackId, row.params as ArpeggiatorParams);
    }
    if (activeTargetId !== "master") {
      if (!hasMasterEq) audioEngine.setMasterEq(disabledEq);
      if (!hasMasterReverb) audioEngine.setMasterReverb(disabledReverb);
    }

    for (const track of props.tracks) {
      if (track.id === activeTargetId) continue;
      const eq = eqByTrackId.get(track.id);
      if (eq) audioEngine.setTrackEq(track.id, eq);
      else audioEngine.setTrackEq(track.id, disabledEq);
      const reverb = reverbByTrackId.get(track.id);
      if (reverb) audioEngine.setTrackReverb(track.id, reverb);
      else audioEngine.setTrackReverb(track.id, disabledReverb);
      if (track.kind === "instrument") {
        const synth = synthByTrackId.get(track.id);
        if (synth) audioEngine.setTrackSynth(track.id, synth);
        else audioEngine.clearTrackSynth?.(track.id);
        const arp = arpByTrackId.get(track.id);
        if (arp) audioEngine.setTrackArpeggiator(track.id, arp);
        else audioEngine.clearTrackArpeggiator?.(track.id);
        continue;
      }
      audioEngine.clearTrackSynth?.(track.id);
      audioEngine.clearTrackArpeggiator?.(track.id);
    }
  });

  const [spectrum, setSpectrum] = createSignal<SpectrumFrame | null>(null);

  // Live spectrum polling (keeps last non-empty after pause)
  createEffect(() => {
    if (!props.isOpen) return;
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

  const eqState = createManagedEffectState<EqParams, EqParamsLite>({
    kind: "eq",
    trackCommitEffect: "eq",
    masterCommitEffect: "master-eq",
    createDefaultParams: createDefaultEqParams,
    masterQueryApi: convexApi.effects.getEqForMaster,
    trackQueryApi: convexApi.effects.getEqForTrack,
    applyToEngine: (targetId, params) => {
      if (targetId === "master") {
        props.audioEngine?.setMasterEq(params);
      } else {
        props.audioEngine?.setTrackEq(targetId, params);
      }
    },
    persist: (targetId, params) => {
      if (!props.roomId || !props.userId) return Promise.resolve();
      if (targetId === "master") {
        return convexClient.mutation(convexApi.effects.setMasterEqParams, {
          roomId: props.roomId,
          userId: props.userId,
          params,
        });
      }
      return convexClient.mutation(convexApi.effects.setEqParams, {
        roomId: props.roomId,
        trackId: targetId as any,
        userId: props.userId,
        params,
      });
    },
  });

  const eqForTarget = eqState.params;
  const handleBandChange = (
    bandId: string,
    updates: Partial<EqParams["bands"][number]>,
  ) => {
    eqState.update((prev) => ({
      ...prev,
      bands: prev.bands.map((band) =>
        band.id === bandId ? { ...band, ...updates } : band,
      ),
    }));
  };
  const handleBandToggle = (bandId: string) => {
    eqState.update((prev) => ({
      ...prev,
      bands: prev.bands.map((band) =>
        band.id === bandId ? { ...band, enabled: !band.enabled } : band,
      ),
    }));
  };
  const handleToggleEnabled = (enabled: boolean) => {
    eqState.update((prev) => ({ ...prev, enabled }));
  };
  const handleReset = () => {
    eqState.update(() => createDefaultEqParams());
  };

  const reverbState = createManagedEffectState<ReverbParams, ReverbParamsLite>({
    kind: "reverb",
    trackCommitEffect: "reverb",
    masterCommitEffect: "master-reverb",
    createDefaultParams: createDefaultReverbParams,
    masterQueryApi: convexApi.effects.getReverbForMaster,
    trackQueryApi: convexApi.effects.getReverbForTrack,
    applyToEngine: (targetId, params) => {
      if (targetId === "master") {
        props.audioEngine?.setMasterReverb(params);
      } else {
        props.audioEngine?.setTrackReverb(targetId, params);
      }
    },
    persist: (targetId, params) => {
      if (!props.roomId || !props.userId) return Promise.resolve();
      if (targetId === "master") {
        return convexClient.mutation(convexApi.effects.setMasterReverbParams, {
          roomId: props.roomId,
          userId: props.userId,
          params,
        });
      }
      return convexClient.mutation(convexApi.effects.setReverbParams, {
        roomId: props.roomId,
        trackId: targetId as any,
        userId: props.userId,
        params,
      });
    },
  });

  const reverbForTarget = reverbState.params;
  const handleReverbChange = (updates: Partial<ReverbParams>) => {
    reverbState.update((prev) => ({ ...prev, ...updates }));
  };
  const handleReverbToggle = (enabled: boolean) => {
    reverbState.update((prev) => ({ ...prev, enabled }));
  };
  const handleReverbReset = () => {
    reverbState.update(() => createDefaultReverbParams());
  };

  const orderedEffects = createMemo<EffectKind[]>(() => {
    const id = currentTargetId();
    const map = effectOrderByTarget();
    const arr = map[id];
    if (arr && arr.length > 0) return arr;
    const present: EffectKind[] = [];
    if (eqForTarget()) present.push("eq");
    if (reverbForTarget()) present.push("reverb");
    if (present.length === 2) return ["eq", "reverb"];
    return present;
  });

  const flushPending = () => {
    eqState.flushPending();
    reverbState.flushPending();
    instrumentState.flushPending();
  };

  const handleClose = () => {
    flushPending();
    props.onClose();
  };

  onCleanup(() => {
    flushPending();
  });


  function handleSendAmountChange(targetId: string, amount: number) {
    const track = currentTrack();
    if (!track || !canEditSends() || !canWriteCurrentTrackRouting()) return;

    const nextAmount = Math.max(0, Math.min(1, Number.isFinite(amount) ? amount : 0));
    const nextSends = currentTrackSends().filter((send) => send.targetId !== targetId);
    if (nextAmount > 0.0001) {
      nextSends.push({ targetId, amount: nextAmount });
    }
    props.onTrackSendsChange?.(track.id, nextSends);
  }
  function handleOutputTargetChange(nextValue: string) {
    const track = currentTrack();
    if (!track || isGroupTrack() || !canWriteCurrentTrackRouting()) return;
    props.onTrackOutputTargetChange?.(track.id, nextValue || undefined);
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
                class="w-full py-1 text-xs"
                onClick={handleClose}
              >
                Hide
              </Button>
              <Show
                when={isInstrumentTrack()}
              >
                <Button
                  variant="default"
                  size="sm"
                  class="w-full px-1 py-1 text-xs"
                  onClick={instrumentState.addMidiClip}
                >
                  + MIDI
                </Button>
              </Show>
              <div class="flex flex-1 items-center justify-center">
                <span
                  class="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-neutral-300"
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
              <div class="flex min-h-7 flex-wrap items-center gap-1.5 border-b border-neutral-800/50 px-2 py-0.5">
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
                    class="h-6 px-2 py-0.5 text-xs"
                    onClick={instrumentState.arp.add}
                  >
                    + Arp
                  </Button>
                </Show>
                <Show when={!eqForTarget()}>
                  <Button
                    variant="default"
                    size="sm"
                    class="h-6 px-2 py-0.5 text-xs"
                    onClick={eqState.add}
                  >
                    + EQ
                  </Button>
                </Show>
                <Show when={!reverbForTarget()}>
                  <Button
                    variant="default"
                    size="sm"
                    class="h-6 px-2 py-0.5 text-xs"
                    onClick={reverbState.add}
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
                        class="h-6 px-2 py-0.5 text-xs"
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
                      class="min-w-72"
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
                      class="min-w-72"
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
                    <div class="min-w-48 rounded border border-neutral-800 bg-neutral-900 px-2 py-2 text-neutral-300 flex items-center justify-between">
                      <span class="text-xs">Synth is expanded</span>
                      <button
                        class="text-xs px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300 border border-neutral-700"
                        onClick={instrumentState.synth.close}
                      >Restore</button>
                    </div>
                  </Show>

                  <Show when={currentTrack() && !isGroupTrack()}>
                    <div class="min-w-60 rounded border border-neutral-800 bg-neutral-950/80 p-3">
                      <div class="mb-3 flex items-center justify-between">
                        <span class="text-xs font-semibold uppercase tracking-wide text-neutral-300">Output</span>
                        <span class="text-xs text-neutral-500">Bus routing</span>
                      </div>
                      <select
                        value={currentTrackOutputTargetId()}
                        onChange={(event) => handleOutputTargetChange((event.currentTarget as HTMLSelectElement).value)}
                        disabled={!canWriteCurrentTrackRouting()}
                        class="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-600"
                      >
                        <option value="">Master</option>
                        <For each={groupTracks()}>
                          {(groupTrack) => <option value={groupTrack.id}>{groupTrack.name}</option>}
                        </For>
                      </select>
                      <Show when={groupTracks().length === 0}>
                        <div class="mt-2 text-xs text-neutral-500">Add a group track to route this channel into a submix.</div>
                      </Show>
                      <Show when={!canWriteCurrentTrackRouting()}>
                        <div class="mt-2 text-xs text-neutral-500">Routing is read-only for collaborator-owned tracks.</div>
                      </Show>
                    </div>
                  </Show>

                  <Show when={currentTrack() && canEditSends()}>
                    <div class="min-w-64 rounded border border-neutral-800 bg-neutral-950/80 p-3">
                      <div class="mb-3 flex items-center justify-between">
                        <span class="text-xs font-semibold uppercase tracking-wide text-neutral-300">Sends</span>
                        <span class="text-xs text-neutral-500">Post-fader</span>
                      </div>
                      <Show
                        when={returnTracks().length > 0}
                        fallback={
                          <div class="text-xs text-neutral-500">
                            Add a return track to route shared reverb or delay-style processing.
                          </div>
                        }
                      >
                        <div class="space-y-3">
                          <For each={returnTracks()}>
                            {(returnTrack) => {
                              const amount = () => currentSendAmountByTarget().get(returnTrack.id) ?? 0;
                              return (
                                <label class="block">
                                  <div class="mb-1 flex items-center justify-between gap-3 text-xs text-neutral-300">
                                    <span class="truncate">{returnTrack.name}</span>
                                    <span class="tabular-nums text-neutral-500">{Math.round(amount() * 100)}%</span>
                                  </div>
                                  <input
                                    type="range"
                                    min="0"
                                    max="1"
                                    step="0.01"
                                    value={amount()}
                                    disabled={!canWriteCurrentTrackRouting()}
                                    onInput={(event) =>
                                      handleSendAmountChange(
                                        returnTrack.id,
                                        parseFloat((event.currentTarget as HTMLInputElement).value),
                                      )}
                                    class="h-2 w-full cursor-pointer accent-neutral-200"
                                  />
                                </label>
                              );
                            }}
                          </For>
                        </div>
                      </Show>
                      <Show when={!canWriteCurrentTrackRouting()}>
                        <div class="mt-3 text-xs text-neutral-500">Routing is read-only for collaborator-owned tracks.</div>
                      </Show>
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
                              class="min-w-72"
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
                            class="min-w-80"
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
