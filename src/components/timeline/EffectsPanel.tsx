import {
  type Component,
  Show,
  For,
  createEffect,
  createSignal,
  createMemo,
  untrack,
  onCleanup,
} from "solid-js";
import type { LocalEffectRow } from "~/lib/local-effects";
import { isLocalId } from "@daw-browser/shared";
import Arpeggiator from "~/components/effects/Arpeggiator";
import Eq from "~/components/effects/Eq";
import Reverb from "~/components/effects/Reverb";
import Synth from "~/components/effects/Synth";
import SynthCard from "~/components/effects/SynthCard";
import { Button } from "~/components/ui/button";
import { createPersistedEffectState } from "~/components/timeline/create-persisted-effect-state";
import { createLocalEffectRows } from "~/components/timeline/create-local-effect-rows";
import {
  createEffectsPanelState,
  EFFECT_PANEL_LOCAL_EDIT_SUPPRESS_MS,
  EFFECT_PANEL_SAVE_DEBOUNCE_MS,
} from "~/components/timeline/create-effects-panel-state";
import {
  type ArpeggiatorParams,
  createDefaultEqParams,
  createDefaultReverbParams,
  normalizeSynthParams,
  serializeEqParams,
  serializeReverbParams,
  type EqParams,
  type ReverbParams,
} from "@daw-browser/shared";
import type { FunctionReturnType } from "convex/server";
import type { AudioEngine, SpectrumFrame } from "@daw-browser/audio-engine/audio-engine";
import { convexApi, useConvexQuery } from "~/lib/convex";
import { useEffectsPanelAudioSync } from "~/hooks/useEffectsPanelAudioSync";
import { useEffectsPanelTarget } from "~/hooks/useEffectsPanelTarget";
import type { OptimisticGrantWrite } from "~/lib/optimistic-grant-scope";
import { publishDurableSharedTimelineOperation } from "~/lib/shared-outbox";
import type { SharedTimelineOperation } from "~/lib/shared-timeline-operations-api";
import type { EffectParamsCommitPayload, EffectType } from "~/lib/undo/types";
import { FX_PANEL_HEIGHT_PX } from "~/lib/timeline-utils";
import type { Clip, Track } from "@daw-browser/timeline-core/types";

type EffectsPanelProps = {
  isOpen: boolean;
  selectedFXTarget: Track["id"] | "master";
  tracks: Track[];
  onClose: () => void;
  onOpen: () => void;
  audioEngine: AudioEngine;
  projectId?: string;
  userId?: string;
  canWriteTrackRouting?: (trackId: Track["id"]) => boolean;
  grantClipWrite?: OptimisticGrantWrite;
  // Timeline context
  playheadSec?: number;
  onSelectClip?: (trackId: Track["id"], clipId: string, startSec: number) => void;
  insertLocalClip?: (trackId: Track["id"], clip: Clip) => void;
  onEffectParamsCommitted?: <Effect extends EffectType>(payload: EffectParamsCommitPayload<Effect>, projectId?: string) => void;
  onLocalSaveFailed?: (message: string) => void;
};

type EffectKind = "eq" | "reverb";
type InstrumentPanelState = ReturnType<typeof createEffectsPanelState>;
type RoomEffectRow = FunctionReturnType<typeof convexApi.effects.listByRoom>[number];
type LocalEqRow = LocalEffectRow<EqParams>;
type LocalReverbRow = LocalEffectRow<ReverbParams>;

type EffectsPanelRailProps = {
  rail: {
    isInstrumentTrack: boolean;
    targetName: string;
    onClose: () => void;
    onAddMidiClip: () => Promise<void>;
    canWrite: boolean;
  };
};

const EffectsPanelRail: Component<EffectsPanelRailProps> = (props) => (
  <div class="flex w-20 flex-col items-center gap-2 border-r border-neutral-800 px-2 py-2">
    <Button
      variant="outline"
      size="sm"
      class="w-full py-1 text-xs"
      onClick={props.rail.onClose}
    >
      Hide
    </Button>
    <Show when={props.rail.isInstrumentTrack}>
      <Button
        variant="default"
        size="sm"
        class="w-full px-1 py-1 text-xs"
        disabled={!props.rail.canWrite}
        onClick={() => void props.rail.onAddMidiClip()}
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
        {props.rail.targetName}
      </span>
    </div>
  </div>
);

type EffectsPanelToolbarProps = {
  toolbar: {
    showAddArp: boolean;
    showAddEq: boolean;
    showAddReverb: boolean;
    onAddArp: () => void;
    onAddEq: () => void;
    onAddReverb: () => void;
    canWrite: boolean;
  };
};

const EffectsPanelToolbar: Component<EffectsPanelToolbarProps> = (props) => (
  <div class="flex min-h-7 flex-wrap items-center gap-1.5 border-b border-neutral-800/50 px-2 py-0.5">
    <Show when={props.toolbar.showAddArp}>
      <Button
        variant="default"
        size="sm"
        class="h-6 px-2 py-0.5 text-xs"
        disabled={!props.toolbar.canWrite}
        onClick={props.toolbar.onAddArp}
      >
        + Arp
      </Button>
    </Show>
    <Show when={props.toolbar.showAddEq}>
      <Button
        variant="default"
        size="sm"
        class="h-6 px-2 py-0.5 text-xs"
        disabled={!props.toolbar.canWrite}
        onClick={props.toolbar.onAddEq}
      >
        + EQ
      </Button>
    </Show>
    <Show when={props.toolbar.showAddReverb}>
      <Button
        variant="default"
        size="sm"
        class="h-6 px-2 py-0.5 text-xs"
        disabled={!props.toolbar.canWrite}
        onClick={props.toolbar.onAddReverb}
      >
        + Reverb
      </Button>
    </Show>
  </div>
);

type EffectsPanelInstrumentSectionProps = {
  instrument: {
    currentTrack?: Track;
    state: InstrumentPanelState;
    canWrite: boolean;
  };
};

const EffectsPanelInstrumentSection: Component<EffectsPanelInstrumentSectionProps> = (props) => (
  <div classList={{ "pointer-events-none opacity-60": !props.instrument.canWrite }}>
    <Show
      when={
        props.instrument.currentTrack &&
        props.instrument.currentTrack.kind === "instrument" &&
        !!props.instrument.state.arp.params()
      }
    >
      <Arpeggiator
        params={props.instrument.state.arp.params()!}
        onChange={(updates) => {
          if (!props.instrument.canWrite) return;
          props.instrument.state.arp.change(updates);
        }}
        onToggleEnabled={(enabled) => {
          if (!props.instrument.canWrite) return;
          props.instrument.state.arp.toggle(enabled);
        }}
        onReset={() => {
          if (!props.instrument.canWrite) return;
          props.instrument.state.arp.reset();
        }}
        disabled={!props.instrument.canWrite}
        class="min-w-72"
      />
    </Show>

    <Show
      when={
        props.instrument.currentTrack &&
        props.instrument.currentTrack.kind === "instrument" &&
        !!props.instrument.state.synth.params() &&
        !props.instrument.state.synth.isExpandedForCurrentTarget()
      }
    >
      <Synth
        params={props.instrument.state.synth.params()!}
        onChange={(updates) => {
          if (!props.instrument.canWrite) return;
          props.instrument.state.synth.change(updates);
        }}
        onReset={() => {
          if (!props.instrument.canWrite) return;
          props.instrument.state.synth.reset();
        }}
        onExpand={() => {
          if (!props.instrument.canWrite) return;
          props.instrument.state.synth.open();
        }}
        disabled={!props.instrument.canWrite}
        variant="compact"
        class="min-w-72"
      />
    </Show>

    <Show
      when={
        props.instrument.currentTrack &&
        props.instrument.currentTrack.kind === "instrument" &&
        !!props.instrument.state.synth.params() &&
        props.instrument.state.synth.isExpandedForCurrentTarget()
      }
    >
      <div class="flex min-w-48 items-center justify-between border border-neutral-800 bg-neutral-900 px-2 py-2 text-neutral-300">
        <span class="text-xs">Synth is expanded</span>
        <button
          class="border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-700"
          onClick={props.instrument.state.synth.close}
        >
          Restore
        </button>
      </div>
    </Show>
  </div>
);

type EffectsPanelEffectCardsProps = {
  effects: {
    orderedEffects: EffectKind[];
    eqParams?: EqParams;
    reverbParams?: ReverbParams;
    canWrite: boolean;
    spectrum: SpectrumFrame | null;
    onBandChange: (bandId: string, updates: Partial<EqParams["bands"][number]>) => void;
    onBandToggle: (bandId: string) => void;
    onToggleEqEnabled: (enabled: boolean) => void;
    onResetEq: () => void;
    onReverbChange: (updates: Partial<ReverbParams>) => void;
    onReverbToggle: (enabled: boolean) => void;
    onResetReverb: () => void;
  };
};

const EffectsPanelEffectCards: Component<EffectsPanelEffectCardsProps> = (props) => (
  <div classList={{ "pointer-events-none opacity-60": !props.effects.canWrite }}>
    <For each={props.effects.orderedEffects}>
      {(effect) => (
        <Show
          when={effect === "eq"}
          fallback={
            <Show when={!!props.effects.reverbParams}>
              <Reverb
                params={props.effects.reverbParams!}
                onChange={props.effects.onReverbChange}
                onToggleEnabled={props.effects.onReverbToggle}
                onReset={props.effects.onResetReverb}
                class="min-w-72"
              />
            </Show>
          }
        >
          <Show when={!!props.effects.eqParams}>
            <Eq
              bands={props.effects.eqParams!.bands}
              enabled={props.effects.eqParams!.enabled}
              onBandChange={props.effects.onBandChange}
              onBandToggle={props.effects.onBandToggle}
              onToggleEnabled={props.effects.onToggleEqEnabled}
              onReset={props.effects.onResetEq}
              class="min-w-80"
              spectrumData={props.effects.spectrum}
            />
          </Show>
        </Show>
      )}
    </For>
  </div>
);

const EffectsPanelReadOnlyNotice: Component = () => (
  <div class="flex min-w-60 items-center border border-neutral-800 bg-neutral-950/80 px-3 py-2 text-xs text-neutral-500">
    Effects are read-only for collaborator-owned tracks.
  </div>
);

type EffectsPanelEmptyStateProps = {
  empty: {
    visible: boolean;
    currentTargetId: string;
  };
};

const EffectsPanelEmptyState: Component<EffectsPanelEmptyStateProps> = (props) => (
  <Show when={props.empty.visible}>
    <div class="flex items-center px-4 text-sm text-neutral-400">
      No effects on this {props.empty.currentTargetId === "master" ? "master bus" : "track"}.
      Use Add EQ or Add Reverb.
    </div>
  </Show>
);

type EffectsPanelClosedButtonProps = {
  onOpen: () => void;
};

const EffectsPanelClosedButton: Component<EffectsPanelClosedButtonProps> = (props) => (
  <button
    class="fixed bottom-4 right-4 border border-neutral-700 bg-neutral-800 px-3 py-2 text-white hover:bg-neutral-700"
    onClick={props.onOpen}
  >
    Open Effects
  </button>
);

type EffectsPanelFloatingSynthProps = {
  synth: InstrumentPanelState["synth"];
  canWrite: boolean;
};

const EffectsPanelFloatingSynth: Component<EffectsPanelFloatingSynthProps> = (props) => {
  const card = () => props.synth.expandedCard();

  return (
    <Show when={props.canWrite && !!card()}>
      <SynthCard
        params={card()!.params}
        onChange={card()!.onChange}
        onReset={card()!.onReset}
        x={card()!.x}
        y={card()!.y}
        w={card()!.w}
        h={card()!.h}
        onChangeBounds={props.synth.updateCardBounds}
        onClose={props.synth.close}
      />
    </Show>
  );
};

const EffectsPanel: Component<EffectsPanelProps> = (props) => {
  const target = useEffectsPanelTarget({
    selectedFXTarget: () => props.selectedFXTarget,
    tracks: () => props.tracks,
    canWriteTrackRouting: props.canWriteTrackRouting,
  });
  const {
    currentTargetId,
    targetName,
    currentTrack,
    isInstrumentTrack,
    canWriteCurrentTrackRouting,
    resolveTrackByTargetId,
  } = target;

  const effectScopeKey = (targetId: string) => `${props.projectId ?? "no-project"}:${targetId}`;

  // ===== Effect ordering (per project target) =====
  const [effectOrderByTarget, setEffectOrderByTarget] = createSignal<
    Record<string, EffectKind[]>
  >({});
  const [effectIndexByTarget, setEffectIndexByTarget] = createSignal<
    Record<string, Partial<Record<EffectKind, number>>>
  >({});

  function appendEffectOrder(targetId: string, kind: EffectKind) {
    const key = effectScopeKey(targetId);
    setEffectOrderByTarget((prev) => {
      const arr = prev[key] ?? [];
      if (arr.includes(kind)) return prev;
      return { ...prev, [key]: [...arr, kind] };
    });
  }

  function setEffectOrderForTarget(
    targetId: string,
    kind: EffectKind,
    index?: number,
  ) {
    const key = effectScopeKey(targetId);
    if (typeof index === "number") {
      setEffectIndexByTarget((prev) => {
        if (prev[key]?.[kind] === index) return prev;
        return {
          ...prev,
          [key]: { ...(prev[key] ?? {}), [kind]: index },
        };
      });
      const idxCurrent = untrack(() => effectIndexByTarget()[key] ?? {});
      const idx = { ...idxCurrent, [kind]: index };
      const entries: { kind: EffectKind; idx: number }[] = [];
      if (typeof idx.eq === "number") entries.push({ kind: "eq", idx: idx.eq });
      if (typeof idx.reverb === "number") entries.push({ kind: "reverb", idx: idx.reverb });
      if (entries.length > 0) {
        entries.sort((a, b) => a.idx - b.idx);
        const nextOrder = entries.map((entry) => entry.kind);
        setEffectOrderByTarget((prev) => {
          const currentOrder = prev[key] ?? [];
          if (
            currentOrder.length === nextOrder.length &&
            currentOrder.every((entry, entryIndex) => entry === nextOrder[entryIndex])
          ) {
            return prev;
          }
          return {
            ...prev,
            [key]: nextOrder,
          };
        });
        return;
      }
    }
    appendEffectOrder(targetId, kind);
  }

  const roomEffectsQuery = useConvexQuery(
    convexApi.effects.listByRoom,
    () => {
      const projectId = props.projectId;
      if (projectId && isLocalId("project", projectId)) return null;
      return projectId && props.userId ? { projectId } : null;
    },
    () => ["effects", "room", props.projectId, props.userId],
  );
  const remoteEffectForTarget = (targetId: string, effectType: "eq" | "reverb") => {
    const targetType = targetId === "master" ? "master" : "track";
    return roomEffectsQuery.data?.find((row: RoomEffectRow) => {
      if (row.type !== effectType || row.targetType !== targetType) return false;
      return targetType === "master" ? true : row.trackId === targetId;
    });
  };

  const instrumentState = createEffectsPanelState(
    {
      audioEngine: () => props.audioEngine,
      projectId: () => props.projectId,
      userId: () => props.userId,
      playheadSec: () => props.playheadSec,
      roomEffects: () => roomEffectsQuery.data,
      grantClipWrite: props.grantClipWrite,
      onSelectClip: props.onSelectClip,
      insertLocalClip: props.insertLocalClip,
      onEffectParamsCommitted: props.onEffectParamsCommitted,
      onLocalSaveFailed: props.onLocalSaveFailed,
    },
    currentTargetId,
    currentTrack,
    resolveTrackByTargetId,
  );
  const canWriteCurrentTargetEffects = createMemo(() => currentTargetId() === "master" || canWriteCurrentTrackRouting());
  const isCurrentTargetReadOnly = createMemo(() => currentTargetId() !== "master" && !canWriteCurrentTrackRouting());
  const localEq = createLocalEffectRows<EqParams>({
    projectId: () => props.projectId,
    targetId: currentTargetId,
    effect: (targetId) => targetId === "master" ? "master-eq" : "eq",
  });
  const localReverb = createLocalEffectRows<ReverbParams>({
    projectId: () => props.projectId,
    targetId: currentTargetId,
    effect: (targetId) => targetId === "master" ? "master-reverb" : "reverb",
  });
  const isLocalProject = localEq.isLocalProject;

  const publishEffectOperation = (
    projectId: string,
    userId: string,
    operation: SharedTimelineOperation,
  ) => publishDurableSharedTimelineOperation({ projectId, userId, operation });

  const eqState = createPersistedEffectState<RoomEffectRow | undefined, EqParams>({
    targetId: currentTargetId,
    scopeId: () => props.projectId,
    row: () => isLocalProject() ? localEq.row(currentTargetId()) : remoteEffectForTarget(currentTargetId(), "eq"),
    readQueryParams: (row) => row?.params,
    createInitialParams: () => createDefaultEqParams(),
    serializeParams: serializeEqParams,
    applyToEngine: (targetId, params) => {
      if (targetId === "master") {
      props.audioEngine.setMasterEq(params);
      } else {
      props.audioEngine.setTrackEq(targetId, params);
      }
    },
    createPersistContext: () => ({ projectId: props.projectId, userId: props.userId }),
    persistParams: (targetId, params, context) => {
      if (!context.projectId) return Promise.resolve();
      if (isLocalId("project", context.projectId)) {
        return localEq.persist(context.projectId, targetId, params);
      }
      if (!context.userId) return Promise.resolve();
      if (targetId === "master") {
        return publishEffectOperation(context.projectId, context.userId, {
          kind: "effects.setMasterEqParams",
          payload: { params },
        });
      }
      const track = resolveTrackByTargetId(targetId);
      if (!track) return Promise.resolve();
      return publishEffectOperation(context.projectId, context.userId, {
        kind: "effects.setEqParams",
        payload: { trackId: track.id, params },
      });
    },
    debounceMs: EFFECT_PANEL_SAVE_DEBOUNCE_MS,
    remoteOverwriteAfterMs: EFFECT_PANEL_LOCAL_EDIT_SUPPRESS_MS,
    onPersistError: (error) => {
      if (!isLocalProject()) return;
      props.onLocalSaveFailed?.(error instanceof Error ? error.message : "Local effect could not be saved.");
    },
    onQueryRow: (targetId, row) => {
      if (row?.params) {
        setEffectOrderForTarget(targetId, "eq", typeof row.index === "number" ? row.index : undefined);
      }
    },
    onParamsCommitted: (targetId, previous, next, context) => {
      if (previous === undefined) return;
      if (targetId === "master") {
        props.onEffectParamsCommitted?.({
          targetId: "master",
          effect: "master-eq",
          from: previous,
          to: next,
        }, context.projectId);
        return;
      }
      const track = resolveTrackByTargetId(targetId);
      if (!track) return;
      props.onEffectParamsCommitted?.({
        targetId: track.id,
        effect: "eq",
        from: previous,
        to: next,
      }, context.projectId);
    },
  });

  const eqForTarget = eqState.params;
  const handleBandChange = (
    bandId: string,
    updates: Partial<EqParams["bands"][number]>,
  ) => {
    if (!canWriteCurrentTargetEffects()) return;
    eqState.update((prev) => ({
      ...prev,
      bands: prev.bands.map((band) =>
        band.id === bandId ? { ...band, ...updates } : band,
      ),
    }));
  };
  const handleBandToggle = (bandId: string) => {
    if (!canWriteCurrentTargetEffects()) return;
    eqState.update((prev) => ({
      ...prev,
      bands: prev.bands.map((band) =>
        band.id === bandId ? { ...band, enabled: !band.enabled } : band,
      ),
    }));
  };
  const handleToggleEnabled = (enabled: boolean) => {
    if (!canWriteCurrentTargetEffects()) return;
    eqState.update((prev) => ({ ...prev, enabled }));
  };
  const handleReset = () => {
    if (!canWriteCurrentTargetEffects()) return;
    eqState.update(() => createDefaultEqParams());
  };

  const reverbState = createPersistedEffectState<RoomEffectRow | undefined, ReverbParams>({
    targetId: currentTargetId,
    scopeId: () => props.projectId,
    row: () => isLocalProject() ? localReverb.row(currentTargetId()) : remoteEffectForTarget(currentTargetId(), "reverb"),
    readQueryParams: (row) => row?.params,
    createInitialParams: () => createDefaultReverbParams(),
    serializeParams: serializeReverbParams,
    applyToEngine: (targetId, params) => {
      if (targetId === "master") {
      props.audioEngine.setMasterReverb(params);
      } else {
      props.audioEngine.setTrackReverb(targetId, params);
      }
    },
    createPersistContext: () => ({ projectId: props.projectId, userId: props.userId }),
    persistParams: (targetId, params, context) => {
      if (!context.projectId) return Promise.resolve();
      if (isLocalId("project", context.projectId)) {
        return localReverb.persist(context.projectId, targetId, params);
      }
      if (!context.userId) return Promise.resolve();
      if (targetId === "master") {
        return publishEffectOperation(context.projectId, context.userId, {
          kind: "effects.setMasterReverbParams",
          payload: { params },
        });
      }
      const track = resolveTrackByTargetId(targetId);
      if (!track) return Promise.resolve();
      return publishEffectOperation(context.projectId, context.userId, {
        kind: "effects.setReverbParams",
        payload: { trackId: track.id, params },
      });
    },
    debounceMs: EFFECT_PANEL_SAVE_DEBOUNCE_MS,
    remoteOverwriteAfterMs: EFFECT_PANEL_LOCAL_EDIT_SUPPRESS_MS,
    onPersistError: (error) => {
      if (!isLocalProject()) return;
      props.onLocalSaveFailed?.(error instanceof Error ? error.message : "Local effect could not be saved.");
    },
    onQueryRow: (targetId, row) => {
      if (row?.params) {
        setEffectOrderForTarget(targetId, "reverb", typeof row.index === "number" ? row.index : undefined);
      }
    },
    onParamsCommitted: (targetId, previous, next, context) => {
      if (previous === undefined) return;
      if (targetId === "master") {
        props.onEffectParamsCommitted?.({
          targetId: "master",
          effect: "master-reverb",
          from: previous,
          to: next,
        }, context.projectId);
        return;
      }
      const track = resolveTrackByTargetId(targetId);
      if (!track) return;
      props.onEffectParamsCommitted?.({
        targetId: track.id,
        effect: "reverb",
        from: previous,
        to: next,
      }, context.projectId);
    },
  });

  const reverbForTarget = reverbState.params;
  const handleReverbChange = (updates: Partial<ReverbParams>) => {
    if (!canWriteCurrentTargetEffects()) return;
    reverbState.update((prev) => ({ ...prev, ...updates }));
  };
  const handleReverbToggle = (enabled: boolean) => {
    if (!canWriteCurrentTargetEffects()) return;
    reverbState.update((prev) => ({ ...prev, enabled }));
  };
  const handleReverbReset = () => {
    if (!canWriteCurrentTargetEffects()) return;
    reverbState.update(() => createDefaultReverbParams());
  };

  const { spectrum } = useEffectsPanelAudioSync({
    isOpen: () => props.isOpen,
    projectId: () => props.projectId,
    currentTargetId,
    tracks: () => props.tracks,
    audioEngine: () => props.audioEngine,
    roomEffects: () => roomEffectsQuery.data,
    playheadSec: () => props.playheadSec,
    localDraftEffects: {
      eq: eqState.readDraftForTarget,
      reverb: reverbState.readDraftForTarget,
      synth: instrumentState.synth.readDraftForTarget,
      arp: instrumentState.arp.readDraftForTarget,
    },
  });

  createEffect(() => {
    const effects = roomEffectsQuery.data;
    if (effects === undefined) return;
    const activeTarget = currentTargetId();
    const synthByTrackId = new Map<string, ReturnType<typeof normalizeSynthParams>>();
    const arpByTrackId = new Map<string, ArpeggiatorParams>();
    for (const row of effects) {
      if (row?.targetType !== "track" || !row.trackId) continue;
      if (row.type === "synth" && row.params) {
        synthByTrackId.set(row.trackId, normalizeSynthParams(row.params));
      }
      if (row.type === "arpeggiator" && row.params) {
        arpByTrackId.set(row.trackId, row.params);
      }
    }
    for (const track of props.tracks) {
      if (track.id === activeTarget) continue;
      const synthParams = track.kind === "instrument" ? synthByTrackId.get(track.id) : undefined;
      const arpParams = track.kind === "instrument" ? arpByTrackId.get(track.id) : undefined;
      instrumentState.synth.syncRemoteForTarget(track.id, synthParams);
      instrumentState.arp.syncRemoteForTarget(track.id, arpParams);
    }
  });

  const orderedEffects = createMemo<EffectKind[]>(() => {
    const id = currentTargetId();
    const map = effectOrderByTarget();
    const arr = map[effectScopeKey(id)];
    if (arr && arr.length > 0) return arr;
    const present: EffectKind[] = [];
    if (eqForTarget()) present.push("eq");
    if (reverbForTarget()) present.push("reverb");
    if (present.length === 2) return ["eq", "reverb"];
    return present;
  });

  const flushPending = async () => {
    await Promise.all([
      eqState.flushPending(),
      reverbState.flushPending(),
      instrumentState.flushPending(),
    ]);
  };

  createEffect(() => {
    if (!isCurrentTargetReadOnly()) return;
    instrumentState.synth.close();
  });

  const handleClose = () => {
    void flushPending();
    props.onClose();
  };

  onCleanup(() => {
    void flushPending();
  });

  return (
    <>
      <Show when={props.isOpen}>
        <div class="fixed left-0 right-0 bottom-0 z-50 border-t border-neutral-800 bg-neutral-900">
          <div class="flex" style={{ height: `${FX_PANEL_HEIGHT_PX}px` }}>
            <EffectsPanelRail
              rail={{
                isInstrumentTrack: isInstrumentTrack(),
                targetName: targetName(),
                onClose: handleClose,
                onAddMidiClip: instrumentState.addMidiClip,
                canWrite: canWriteCurrentTargetEffects(),
              }}
            />
            <div class="flex flex-1 flex-col overflow-hidden min-h-0">
              <EffectsPanelToolbar
                toolbar={{
                  showAddArp: !!currentTrack() && currentTrack()!.kind === "instrument" && !instrumentState.arp.params(),
                  showAddEq: !eqForTarget(),
                  showAddReverb: !reverbForTarget(),
                  onAddArp: instrumentState.arp.add,
                  onAddEq: eqState.add,
                  onAddReverb: reverbState.add,
                  canWrite: canWriteCurrentTargetEffects(),
                }}
              />
              <div class="flex-1 overflow-x-auto overflow-y-hidden px-2 py-2 min-h-0">
                <div class="flex items-stretch gap-3 h-full min-w-min min-h-0">
                  <EffectsPanelInstrumentSection
                    instrument={{
                      currentTrack: currentTrack(),
                      state: instrumentState,
                      canWrite: canWriteCurrentTargetEffects(),
                    }}
                  />
                  <EffectsPanelEffectCards
                    effects={{
                      orderedEffects: orderedEffects(),
                      eqParams: eqForTarget(),
                      reverbParams: reverbForTarget(),
                      canWrite: canWriteCurrentTargetEffects(),
                      spectrum: spectrum(),
                      onBandChange: handleBandChange,
                      onBandToggle: handleBandToggle,
                      onToggleEqEnabled: handleToggleEnabled,
                      onResetEq: handleReset,
                      onReverbChange: handleReverbChange,
                      onReverbToggle: handleReverbToggle,
                      onResetReverb: handleReverbReset,
                    }}
                  />
                  <Show when={isCurrentTargetReadOnly()}>
                    <EffectsPanelReadOnlyNotice />
                  </Show>
                  <EffectsPanelEmptyState
                    empty={{
                      visible:
                        !eqForTarget() &&
                        !reverbForTarget() &&
                        !instrumentState.arp.params() &&
                        (!instrumentState.synth.params() ||
                          !currentTrack() ||
                          currentTrack()!.kind !== "instrument"),
                      currentTargetId: currentTargetId(),
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </Show>

      <Show when={!props.isOpen}>
        <EffectsPanelClosedButton onOpen={props.onOpen} />
      </Show>

      <EffectsPanelFloatingSynth synth={instrumentState.synth} canWrite={canWriteCurrentTargetEffects()} />
    </>
  );
};

export default EffectsPanel;
