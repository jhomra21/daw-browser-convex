import {
  type Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { TrackStereoLevels } from "@daw-browser/audio-engine/audio-engine";
import { automationEnvelopeValueRange, automationTargetKey, getAutomationParameterOptions, type AutomationEnvelope } from "@daw-browser/shared";
import {
  canTrackReceiveAudioClip,
  getTrackChannelRole,
} from "@daw-browser/timeline-core/track-routing";
import { TIMELINE_SIDEBAR_MIN_WIDTH } from "~/lib/timeline-layout";
import { DEFAULT_AUTOMATION_LANE_HEIGHT, LANE_HEIGHT, RULER_HEIGHT, clampAutomationLaneHeight } from "~/lib/timeline-utils";
import { cn } from "~/lib/utils";
import type { Track, TrackSend } from "@daw-browser/timeline-core/types";
import MasterSidebarRow, {
  MASTER_ROW_HEIGHT,
  type MasterSidebarModel,
} from "~/components/timeline/MasterSidebarRow";
import AutomationParameterPicker from "./automation-parameter-picker";

const automationParameterOptions = getAutomationParameterOptions();

type TrackSidebarProps = {
  sidebar: {
    tracks: Track[];
    selectedTrackId: Track["id"] | "";
    sidebarWidth: number;
    bottomOffsetPx: number;
    master: MasterSidebarModel;
    onTrackClick: (trackId: Track["id"]) => void;
    canWriteTrackRouting: (trackId: Track["id"]) => boolean;
    onTrackSendsChange: (trackId: Track["id"], sends: TrackSend[]) => void;
    onTrackOutputTargetChange: (
      trackId: Track["id"],
      outputTargetId?: Track["id"],
    ) => void;
    onVolumeChange: (trackId: Track["id"], volume: number) => void;
    onSidebarPointerDown: (e: PointerEvent) => void;
    onToggleMute: (trackId: Track["id"]) => void;
    onToggleSolo: (trackId: Track["id"]) => void;
    recordArmTrackId: Track["id"] | null;
    onToggleRecordArm: (trackId: Track["id"]) => void;
    currentUserId: string;
    subscribeTrackLevels: (
      listener: (levels: ReadonlyMap<string, TrackStereoLevels>) => void,
    ) => () => void;
    onVolumePreview: (
      trackId: Track["id"],
      volume: number,
      muted: boolean,
    ) => void;
  };
  automation?: {
    visibleByTrackId: Record<string, boolean>;
    visibleTrackLanesByTrackId: Record<string, string[]>;
    masterVisible: boolean;
    onToggleMasterVisibility: () => void;
    onToggleTrackVisibility: (trackId: Track["id"]) => void;
    onAddTrackLane: (trackId: Track["id"]) => void;
    onShowTrackLane: (trackId: Track["id"], parameterId: string) => void;
    onHideTrackLane: (trackId: Track["id"], parameterId: string) => void;
    laneHeightsByTrackId: Record<string, number>;
    masterLaneHeight: number;
    onResizeMasterLane: (height: number) => void;
    onResizeTrackLane: (trackId: Track["id"], height: number) => void;
    selectedParametersByTargetKey: Record<string, string>;
    envelopesByTargetKey: Map<string, AutomationEnvelope>;
    onSelectParameter: (targetKey: string, parameterId: string) => void;
  };
};

const clampUnit = (value: number) => Math.max(0, Math.min(1, value));
const METER_SILENCE_FLOOR = 0.005;
const displayMeterLevel = (value: number | undefined) => {
  const clamped = clampUnit(value ?? 0);
  return clamped > METER_SILENCE_FLOOR ? clamped : 0;
};
const clampVolume = (volume: number) => clampUnit(volume);
const quantizeVolume = (volume: number) =>
  Math.round(clampVolume(volume) * 100) / 100;
const TrackSidebar: Component<TrackSidebarProps> = (props) => {
  const sidebar = () => props.sidebar;

  const [meters, setMeters] = createStore<Record<string, TrackStereoLevels>>({});
  const [selectedOutputTargets, setSelectedOutputTargets] = createSignal<
    Map<Track["id"], string>
  >(new Map());
  const [selectedSendTargets, setSelectedSendTargets] = createSignal<
    Map<Track["id"], string>
  >(new Map());
  let cleanupAutomationResize: (() => void) | undefined;

  createEffect(() => {
    const unsubscribe = sidebar().subscribeTrackLevels((levelsByTrackId) => {
      setMeters(produce((current) => {
        for (const [trackId, levels] of levelsByTrackId) {
          const next = {
            left: clampUnit(levels.left),
            right: clampUnit(levels.right),
          };
          const previous = current[trackId];
          if (previous?.left === next.left && previous.right === next.right) continue;
          current[trackId] = next;
        }
      }));
    });
    onCleanup(unsubscribe);
  });

  createEffect(() => {
    const trackIds = new Set<string>(sidebar().tracks.map((track) => track.id));
    setMeters(produce((current) => {
      for (const trackId of Object.keys(current)) {
        if (!trackIds.has(trackId)) delete current[trackId];
      }
    }));
  });

  const groupTracks = createMemo(() =>
    sidebar().tracks.filter((track) => getTrackChannelRole(track) === "group"),
  );
  const groupTrackNames = createMemo(
    () =>
      new Map<string, string>(
        groupTracks().map((track) => [track.id, track.name]),
      ),
  );
  const returnTracks = createMemo(() =>
    sidebar().tracks.filter((track) => getTrackChannelRole(track) === "return"),
  );
  const returnTrackNames = createMemo(
    () =>
      new Map<string, string>(
        returnTracks().map((track, index) => [track.id, `Return ${index + 1}`]),
      ),
  );
  const displayTrackName = (track: Track) =>
    returnTrackNames().get(track.id) ?? track.name;
  const automationMetaByTrackId = createMemo(() => {
    const byTrackId = new Map<string, {
      automatedParameterIds: ReadonlySet<string>;
      volumeRange?: { min: number; max: number };
      volumeEnvelope?: AutomationEnvelope;
    }>();
    const automation = props.automation;
    if (!automation) return byTrackId;
    const mutable = new Map<string, {
      automatedParameterIds: Set<string>;
      volumeRange?: { min: number; max: number };
      volumeEnvelope?: AutomationEnvelope;
    }>();
    for (const envelope of automation.envelopesByTargetKey.values()) {
      if (envelope.target.kind !== "track") continue;
      const existing = mutable.get(envelope.target.trackId) ?? { automatedParameterIds: new Set<string>() };
      existing.automatedParameterIds.add(envelope.parameterId);
      if (envelope.parameterId === "volume") {
        existing.volumeEnvelope = envelope;
        existing.volumeRange = automationEnvelopeValueRange(envelope, { min: 0, max: 1 });
      }
      mutable.set(envelope.target.trackId, existing);
    }
    for (const [trackId, meta] of mutable) {
      byTrackId.set(trackId, meta);
    }
    return byTrackId;
  });
  const masterAutomationMeta = createMemo<{
    automatedParameterIds: Set<string>;
    selectedEnvelope: AutomationEnvelope | undefined;
  }>(() => {
    const automation = props.automation;
    const meta: {
      automatedParameterIds: Set<string>;
      selectedEnvelope: AutomationEnvelope | undefined;
    } = {
      automatedParameterIds: new Set<string>(),
      selectedEnvelope: undefined,
    };
    if (!automation) return meta;
    const selectedParameter = automation.selectedParametersByTargetKey.master ?? "volume";
    const selectedTargetKey = automationTargetKey({ kind: "master" }, selectedParameter);
    for (const envelope of automation.envelopesByTargetKey.values()) {
      if (envelope.target.kind !== "master") continue;
      meta.automatedParameterIds.add(envelope.parameterId);
      if (envelope.targetKey === selectedTargetKey) meta.selectedEnvelope = envelope;
    }
    return meta;
  });
  const masterRowReservedHeight = () => (
    MASTER_ROW_HEIGHT + (props.automation?.masterVisible ? props.automation.masterLaneHeight : 0)
  );
  const actualOutputTargetId = (track: Track) => track.outputTargetId ?? "";
  const selectedOutputTargetId = (track: Track) =>
    selectedOutputTargets().get(track.id) ?? actualOutputTargetId(track);
  const outputTargetName = (track: Track) =>
    groupTrackNames().get(selectedOutputTargetId(track)) ?? "Master";
  const actualSendTargetId = (track: Track) =>
    track.sends?.find((send) => send.amount > 0.0001)?.targetId ??
    "";
  const selectedSendTargetId = (track: Track) =>
    selectedSendTargets().get(track.id) ?? actualSendTargetId(track);
  const sendTargetName = (track: Track) => {
    const targetId = selectedSendTargetId(track);
    if (!targetId) return "None";
    return returnTrackNames().get(targetId) ?? "None";
  };

  createEffect(() => {
    const trackById = new Map(sidebar().tracks.map((track) => [track.id, track]));
    setSelectedOutputTargets((current) => {
      let next: Map<Track["id"], string> | null = null;
      for (const [trackId, targetId] of current) {
        const track = trackById.get(trackId);
        if (
          !track ||
          actualOutputTargetId(track) === targetId ||
          (targetId && !groupTrackNames().has(targetId))
        ) {
          if (!next) next = new Map(current);
          next.delete(trackId);
        }
      }
      return next ?? current;
    });
    setSelectedSendTargets((current) => {
      let next: Map<Track["id"], string> | null = null;
      for (const [trackId, targetId] of current) {
        const track = trackById.get(trackId);
        if (
          !track ||
          actualSendTargetId(track) === targetId ||
          (targetId && !returnTrackNames().has(targetId))
        ) {
          if (!next) next = new Map(current);
          next.delete(trackId);
        }
      }
      return next ?? current;
    });
  });

  const canWriteTrackRouting = (track: Track) =>
    sidebar().canWriteTrackRouting(track.id);

  const handleOutputTargetChange = (track: Track, value: string) => {
    if (!canWriteTrackRouting(track)) return;
    setSelectedOutputTargets((current) =>
      current.get(track.id) === value
        ? current
        : new Map(current).set(track.id, value),
    );
    const outputTargetId = value
      ? groupTracks().find((groupTrack) => groupTrack.id === value)?.id
      : undefined;
    sidebar().onTrackOutputTargetChange(track.id, outputTargetId);
  };

  const handleSendTargetChange = (track: Track, targetId: string) => {
    if (!canWriteTrackRouting(track)) return;
    setSelectedSendTargets((current) =>
      current.get(track.id) === targetId
        ? current
        : new Map(current).set(track.id, targetId),
    );
    const existingSends = track.sends ?? [];
    const returnTrack = returnTracks().find(
      (candidate) => candidate.id === targetId,
    );
    if (!returnTrack) {
      sidebar().onTrackSendsChange(track.id, []);
      return;
    }
    const currentTargetId = actualSendTargetId(track);
    const existingAmount = existingSends.find(
      (send) => send.targetId === returnTrack.id,
    )?.amount;
    const amount =
      existingAmount !== undefined && existingAmount > 0.0001
        ? existingAmount
        : 1;
    sidebar().onTrackSendsChange(track.id, [
      ...existingSends.filter(
        (send) =>
          send.targetId !== currentTargetId && send.targetId !== returnTrack.id,
      ),
      { targetId: returnTrack.id, amount },
    ]);
  };

  const [activeVolumeDrag, setActiveVolumeDrag] = createSignal<{
    pointerId: number;
    trackId: Track["id"];
    startValue: number;
    value: number;
  } | null>(null);

  const volumeFromPointer = (input: HTMLInputElement, clientX: number) => {
    const rect = input.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    return quantizeVolume((clientX - rect.left) / width);
  };

  const displayVolume = (track: Track) => {
    const active = activeVolumeDrag();
    return active?.trackId === track.id ? active.value : track.volume ?? 0.8;
  };

  const previewTrackVolume = (track: Track, volume: number) => {
    const nextVolume = quantizeVolume(volume);
    setActiveVolumeDrag((active) => {
      if (!active || active.trackId !== track.id || active.value === nextVolume) return active;
      return { ...active, value: nextVolume };
    });
    sidebar().onVolumePreview(track.id, nextVolume, !!track.muted);
  };

  const commitTrackVolume = (trackId: Track["id"], volume: number, previousVolume: number) => {
    if (volume === previousVolume) return;
    sidebar().onVolumeChange(trackId, volume);
  };

  const startAutomationResize = (trackId: Track["id"], startHeight: number, event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    const move = (moveEvent: PointerEvent) => {
      props.automation?.onResizeTrackLane(
        trackId,
        clampAutomationLaneHeight(startHeight + moveEvent.clientY - startY),
      );
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      if (cleanupAutomationResize === cleanup) cleanupAutomationResize = undefined;
    };
    cleanupAutomationResize?.();
    cleanupAutomationResize = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", cleanup, { once: true });
    window.addEventListener("pointercancel", cleanup, { once: true });
  };

  onCleanup(() => cleanupAutomationResize?.());

  const updateVolumeFromPointer = (
    track: Track,
    input: HTMLInputElement,
    clientX: number,
  ) => {
    previewTrackVolume(track, volumeFromPointer(input, clientX));
  };

  const releaseVolumePointerCapture = (
    input: HTMLInputElement,
    pointerId: number,
  ) => {
    if (input.hasPointerCapture(pointerId)) {
      input.releasePointerCapture(pointerId);
    }
  };

  return (
    <>
      <div
        class="absolute inset-y-0 left-0 z-40 w-4 -translate-x-1/2 cursor-col-resize"
        onPointerDown={sidebar().onSidebarPointerDown}
      >
        <div class="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-neutral-700" />
      </div>

      <div
        class="flex h-full flex-col overflow-x-clip border-l border-neutral-800 bg-neutral-900 p-0"
        style={{
          width: `${sidebar().sidebarWidth}px`,
          "min-width": `${TIMELINE_SIDEBAR_MIN_WIDTH}px`,
        }}
      >
        <div class="sticky top-0 z-40 border-b border-neutral-800 bg-neutral-900" style={{ height: `${RULER_HEIGHT}px` }} />
        <For each={sidebar().tracks}>
          {(track) => {
            const lockedByOther =
              !!track.lockedBy && track.lockedBy !== sidebar().currentUserId;
            const isRecordArmed = () => sidebar().recordArmTrackId === track.id;
            const channelRole = getTrackChannelRole(track);
            const isReturnTrack = channelRole === "return";
            const isGroupTrack = channelRole === "group";
            const muteDisabled = lockedByOther;
            const soloDisabled = lockedByOther;
            const volumeDisabled = lockedByOther;
            const recordDisabled =
              lockedByOther || !canTrackReceiveAudioClip(track);
            const volume = () => displayVolume(track);
            const muted = () => !!track.muted;
            const soloed = () => !!track.soloed;
            const currentSendTargetId = () => selectedSendTargetId(track);
            const selectedAutomationParameter = () => props.automation?.selectedParametersByTargetKey[track.id] ?? "volume";
            const selectedAutomationTargetKey = () => automationTargetKey({ kind: "track", trackId: track.id }, selectedAutomationParameter());
            const selectedAutomationEnvelope = () => props.automation?.envelopesByTargetKey.get(selectedAutomationTargetKey());
            const automationMeta = () => automationMetaByTrackId().get(track.id);
            const automationVisible = () => props.automation?.visibleByTrackId[track.id] === true;
            const visibleAutomationParameterIds = () => props.automation?.visibleTrackLanesByTrackId[track.id] ?? [];
            const automationHeight = () => props.automation?.laneHeightsByTrackId[track.id] ?? DEFAULT_AUTOMATION_LANE_HEIGHT;
            const automationTotalHeight = () => automationVisible() ? automationHeight() * Math.max(1, visibleAutomationParameterIds().length) : 0;
            const canAddAutomationLane = () => {
              if (!automationVisible()) return false;
              const visible = new Set(visibleAutomationParameterIds());
              if (!visible.has(selectedAutomationParameter())) return true;
              return automationParameterOptions.some((option) => !visible.has(option.id));
            };

            return (
              <div
                class={cn(
                  "relative [box-shadow:inset_0_-1px_0_rgb(38_38_38)]",
                  sidebar().selectedTrackId === track.id
                    ? "bg-neutral-800"
                    : "bg-neutral-900",
                )}
                style={{ height: `${LANE_HEIGHT + automationTotalHeight()}px` }}
                onClick={() => sidebar().onTrackClick(track.id)}
              >
                <div
                  class="grid grid-cols-[minmax(72px,96px)_minmax(96px,1fr)_92px] items-center gap-x-4 p-2"
                  style={{ height: `${LANE_HEIGHT}px` }}
                >
                  <div class="min-w-0 overflow-hidden">
                    <button
                      class={cn(
                        "flex h-7 w-full items-center justify-center border px-2 text-center text-sm font-semibold",
                        muteDisabled
                          ? "cursor-not-allowed border-neutral-700 text-neutral-500"
                          : muted()
                            ? "border-neutral-700 bg-amber-500 text-black"
                            : sidebar().selectedTrackId === track.id
                              ? "border-neutral-700"
                              : "border-neutral-700 hover:border-neutral-600",
                      )}
                      style={{ "border-width": "0.5px" }}
                      disabled={muteDisabled}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (muteDisabled) return;
                        sidebar().onToggleMute(track.id);
                      }}
                      title={
                        lockedByOther
                          ? "Track locked by another user"
                          : muted()
                            ? "Unmute track"
                            : "Mute track"
                      }
                    >
                      <span class="flex min-w-0 flex-col items-center gap-1">
                        <span class="truncate">{displayTrackName(track)}</span>
                        <Show when={isGroupTrack}>
                          <span class="bg-neutral-700 px-1.5 py-0.5 text-xs uppercase tracking-wide text-neutral-300">
                            Group
                          </span>
                        </Show>
                      </span>
                    </button>
                  </div>

                  <div class="flex min-w-0 flex-col gap-1">
                    <Show when={!isGroupTrack}>
                      <div class="relative">
                        <div
                          class={cn(
                            "flex h-7 w-full items-center justify-between border border-neutral-700 bg-neutral-950 px-2 text-xs text-neutral-200",
                            !canWriteTrackRouting(track) &&
                              "text-neutral-500",
                          )}
                        >
                          <span class="truncate">
                            {outputTargetName(track)}
                          </span>
                          <svg
                            class="h-3 w-3 shrink-0 text-neutral-300"
                            viewBox="0 0 12 12"
                            fill="none"
                            aria-hidden="true"
                          >
                            <path
                              d="M2.5 4.5 6 8l3.5-3.5"
                              stroke="currentColor"
                              stroke-width="1.5"
                            />
                          </svg>
                        </div>
                        <select
                          value={selectedOutputTargetId(track)}
                          disabled={!canWriteTrackRouting(track)}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) =>
                            handleOutputTargetChange(
                              track,
                              event.currentTarget.value,
                            )
                          }
                          class="absolute inset-0 h-7 w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                          title="Track output"
                        >
                          <option value="">Master</option>
                          <For each={groupTracks()}>
                            {(groupTrack) => (
                              <option value={groupTrack.id}>
                                {groupTrack.name}
                              </option>
                            )}
                          </For>
                        </select>
                      </div>
                    </Show>

                    <Show when={channelRole === "track"}>
                      <div class="relative">
                        <div
                          class={cn(
                            "flex h-7 w-full items-center justify-between border border-neutral-700 bg-neutral-950 px-2 text-xs text-neutral-200",
                            (!canWriteTrackRouting(track) ||
                              returnTracks().length === 0) &&
                              "text-neutral-500",
                          )}
                        >
                          <span class="truncate">
                            {sendTargetName(track)}
                          </span>
                          <svg
                            class="h-3 w-3 shrink-0 text-neutral-300"
                            viewBox="0 0 12 12"
                            fill="none"
                            aria-hidden="true"
                          >
                            <path
                              d="M2.5 4.5 6 8l3.5-3.5"
                              stroke="currentColor"
                              stroke-width="1.5"
                            />
                          </svg>
                        </div>
                        <select
                          value={currentSendTargetId()}
                          disabled={
                            !canWriteTrackRouting(track) ||
                            returnTracks().length === 0
                          }
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) =>
                            handleSendTargetChange(
                              track,
                              event.currentTarget.value,
                            )
                          }
                          class="absolute inset-0 h-7 w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                          title="Track send"
                        >
                          <option value="">None</option>
                          <For each={returnTracks()}>
                            {(returnTrack) => (
                              <option value={returnTrack.id}>
                                {displayTrackName(returnTrack)}
                              </option>
                            )}
                          </For>
                        </select>
                      </div>
                    </Show>
                  </div>

                  <div class="flex w-[92px] items-center gap-2">
                    <div class="flex w-[72px] shrink-0 flex-col gap-1">
                      <div class="grid grid-cols-4 gap-1">
                        <button
                          class={cn(
                            "flex h-7 items-center justify-center border text-xs font-bold transition-colors",
                            recordDisabled
                              ? "cursor-not-allowed border-red-900 bg-neutral-800 text-red-900"
                              : isRecordArmed()
                                ? "border-red-400 bg-red-500 text-black shadow-inner"
                                : "border-red-500 text-red-400 hover:bg-red-500/20",
                          )}
                          title={
                            lockedByOther
                              ? "Track locked by another user"
                              : isReturnTrack
                                ? "Return tracks cannot be armed for recording"
                                : isGroupTrack
                                  ? "Group tracks cannot be armed for recording"
                                  : track.kind === "instrument"
                                    ? "Instrument tracks cannot be armed for audio recording"
                                    : isRecordArmed()
                                      ? "Disarm recording"
                                      : "Arm for recording"
                          }
                          disabled={recordDisabled}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (recordDisabled) return;
                            sidebar().onToggleRecordArm(track.id);
                          }}
                        >
                          R
                        </button>

                        <button
                          class={cn(
                            "h-7 border text-xs font-semibold",
                            soloDisabled
                              ? "cursor-not-allowed border-neutral-700 bg-neutral-700/40 text-neutral-500"
                              : soloed()
                                ? "border-blue-300 bg-blue-500/90 text-black"
                                : "border-neutral-700 bg-neutral-800 text-neutral-200 hover:bg-neutral-700",
                          )}
                          disabled={soloDisabled}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (soloDisabled) return;
                            sidebar().onToggleSolo(track.id);
                          }}
                          title={
                            lockedByOther
                              ? "Track locked by another user"
                              : soloed()
                                ? "Unsolo"
                                : "Solo"
                          }
                        >
                          S
                        </button>

                        <button
                          class={cn(
                            "h-7 border text-xs font-semibold transition-colors",
                            automationVisible()
                              ? "border-red-400 bg-red-500/90 text-black"
                              : "border-neutral-700 bg-neutral-800 text-red-300 hover:bg-red-500/20",
                          )}
                          onClick={(event) => {
                            event.stopPropagation();
                            props.automation?.onToggleTrackVisibility(track.id);
                          }}
                          title={automationVisible() ? "Hide automation lane" : "Show automation lane"}
                        >
                          A
                        </button>
                        <button
                          class={cn(
                            "h-7 border text-xs font-semibold transition-colors",
                            canAddAutomationLane()
                              ? "border-neutral-700 bg-neutral-800 text-red-200 hover:bg-red-500/20"
                              : "cursor-not-allowed border-neutral-800 bg-neutral-900 text-neutral-600",
                          )}
                          disabled={!canAddAutomationLane()}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (!canAddAutomationLane()) return;
                            props.automation?.onAddTrackLane(track.id);
                          }}
                          title={automationVisible() ? "Add another automation lane" : "Show automation with A before adding lanes"}
                        >
                          +
                        </button>
                      </div>

                      <div class="relative flex h-7 items-center px-0.5">
                        <Show when={automationMeta()?.volumeEnvelope}>
                          <span class="absolute right-0 top-0 z-10 h-2 w-2 rounded-full bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.75)]" />
                        </Show>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.01"
                          value={volume()}
                          disabled={volumeDisabled}
                          style={{
                            "--track-volume-percent": `${volume() * 100}%`,
                            "--track-volume-automation-start": `${(automationMeta()?.volumeRange?.min ?? 0) * 100}%`,
                            "--track-volume-automation-end": `${(automationMeta()?.volumeRange?.max ?? 0) * 100}%`,
                          }}
                          onClick={(event) => event.stopPropagation()}
                          onPointerDown={(event) => {
                            event.stopPropagation();
                            props.automation?.onSelectParameter(track.id, "volume");
                            if (volumeDisabled) return;
                            event.preventDefault();
                            const startValue = quantizeVolume(track.volume ?? 0.8);
                            setActiveVolumeDrag({
                              pointerId: event.pointerId,
                              trackId: track.id,
                              startValue,
                              value: startValue,
                            });
                            event.currentTarget.setPointerCapture(
                              event.pointerId,
                            );
                            updateVolumeFromPointer(
                              track,
                              event.currentTarget,
                              event.clientX,
                            );
                          }}
                          onPointerMove={(event) => {
                            const active = activeVolumeDrag();
                            if (active?.pointerId !== event.pointerId) return;
                            event.stopPropagation();
                            updateVolumeFromPointer(
                              track,
                              event.currentTarget,
                              event.clientX,
                            );
                          }}
                          onPointerUp={(event) => {
                            const active = activeVolumeDrag();
                            if (active?.pointerId !== event.pointerId) return;
                            event.stopPropagation();
                            commitTrackVolume(
                              active.trackId,
                              active.value,
                              active.startValue,
                            );
                            setActiveVolumeDrag(null);
                            releaseVolumePointerCapture(
                              event.currentTarget,
                              event.pointerId,
                            );
                          }}
                          onPointerCancel={(event) => {
                            const active = activeVolumeDrag();
                            if (active?.pointerId !== event.pointerId) return;
                            sidebar().onVolumePreview(
                              active.trackId,
                              active.startValue,
                              !!track.muted,
                            );
                            setActiveVolumeDrag(null);
                            releaseVolumePointerCapture(
                              event.currentTarget,
                              event.pointerId,
                            );
                          }}
                          onInput={(event) => {
                            event.stopPropagation();
                            if (volumeDisabled) return;
                            const nextVolume = quantizeVolume(
                              parseFloat(event.currentTarget.value),
                            );
                            const active = activeVolumeDrag();
                            if (active?.trackId === track.id) {
                              previewTrackVolume(track, nextVolume);
                              return;
                            }
                            commitTrackVolume(
                              track.id,
                              nextVolume,
                              quantizeVolume(track.volume ?? 0.8),
                            );
                          }}
                          class={cn(
                            "track-volume-slider w-full cursor-pointer",
                            automationMeta()?.volumeEnvelope && "track-volume-slider-automated",
                            volumeDisabled && "cursor-not-allowed opacity-60",
                          )}
                          title={
                            lockedByOther
                              ? "Track locked by another user"
                              : "Track volume"
                          }
                        />
                      </div>
                    </div>

                    <div class="relative h-16 w-[12px] shrink-0">
                      <div class="absolute inset-0 flex items-end justify-center gap-1">
                        {(() => {
                          const meter = meters[track.id];
                          const left = displayMeterLevel(meter?.left);
                          const right = displayMeterLevel(meter?.right);
                          const leftColor =
                            left >= 0.98 ? "bg-red-500" : "bg-green-500";
                          const rightColor =
                            right >= 0.98 ? "bg-red-500" : "bg-green-500";
                          return (
                            <>
                              <div class="relative h-full w-1 overflow-hidden bg-neutral-950/70">
                                <div
                                  class={cn(
                                    "absolute bottom-0 w-full transition-all duration-75",
                                    leftColor,
                                  )}
                                  style={{ height: `${left * 100}%` }}
                                />
                              </div>
                              <div class="relative h-full w-1 overflow-hidden bg-neutral-950/70">
                                <div
                                  class={cn(
                                    "absolute bottom-0 w-full transition-all duration-75",
                                    rightColor,
                                  )}
                                  style={{ height: `${right * 100}%` }}
                                />
                              </div>
                            </>
                          );
                        })()}
                      </div>
                    </div>
                  </div>
                </div>
                {automationVisible() ? (
                  <div
                    class="absolute inset-x-0 z-10 border-t border-red-500/30 bg-neutral-950/95 text-[11px] text-red-100"
                    style={{ top: `${LANE_HEIGHT}px`, height: `${automationTotalHeight()}px` }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div
                      class="absolute inset-x-0 top-0 h-2 -translate-y-1/2 cursor-row-resize"
                      onPointerDown={(event) => startAutomationResize(track.id, automationHeight(), event)}
                    />
                    <For each={visibleAutomationParameterIds()}>
                      {(parameterId) => {
                        const targetKey = () => automationTargetKey({ kind: "track", trackId: track.id }, parameterId);
                        const envelope = () => props.automation?.envelopesByTargetKey.get(targetKey());
                        return (
                          <div
                            class="grid grid-cols-[minmax(72px,96px)_minmax(96px,1fr)_92px] items-center gap-x-4 border-b border-red-500/20 px-2"
                            style={{ height: `${automationHeight()}px` }}
                          >
                            <div class="flex items-center gap-1 overflow-hidden">
                              <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" classList={{ "opacity-30": !envelope() }} />
                              <span class="truncate">Automation</span>
                            </div>
                            <AutomationParameterPicker
                              value={parameterId}
                              automatedParameterIds={automationMeta()?.automatedParameterIds}
                              onChange={(nextParameterId) => {
                                props.automation?.onHideTrackLane(track.id, parameterId);
                                props.automation?.onShowTrackLane(track.id, nextParameterId);
                                props.automation?.onSelectParameter(track.id, nextParameterId);
                              }}
                            />
                            <div class="flex items-center justify-end gap-2 text-red-200/70">
                              <span class="truncate">{envelope()?.points.length ?? 0} pts</span>
                              <button
                                type="button"
                                class="h-5 w-5 border border-red-500/30 text-red-100 hover:border-red-400"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  props.automation?.onHideTrackLane(track.id, parameterId);
                                }}
                                title="Hide automation lane"
                              >
                                ×
                              </button>
                            </div>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                ) : null}
              </div>
            );
          }}
        </For>
        <div
          class="min-h-6 flex-1 shrink-0"
          style={{ "padding-bottom": `${masterRowReservedHeight()}px` }}
        />
        <MasterSidebarRow
          master={sidebar().master}
          sidebarWidth={sidebar().sidebarWidth}
          bottomOffsetPx={sidebar().bottomOffsetPx}
          automation={props.automation ? {
            visible: props.automation.masterVisible,
            heightPx: props.automation.masterLaneHeight,
            selectedParameterId: props.automation.selectedParametersByTargetKey.master ?? "volume",
            automatedParameterIds: masterAutomationMeta().automatedParameterIds,
            selectedEnvelope: masterAutomationMeta().selectedEnvelope,
            onToggleVisibility: props.automation.onToggleMasterVisibility,
            onResizeLane: props.automation.onResizeMasterLane,
            onSelectParameter: (parameterId) => props.automation?.onSelectParameter("master", parameterId),
          } : undefined}
        />
      </div>
    </>
  );
};

export default TrackSidebar;
