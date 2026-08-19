import {
  type Accessor,
  type Component,
  For,
  Show,
  type Setter,
  untrack,
} from "solid-js";
import type { TrackStereoLevels } from "@daw-browser/audio-engine/audio-engine";
import {
  automationTargetKey,
  getAutomationParameterOptionsForTarget,
  isClipKindCompatibleWithTrack,
  type AutomationEnvelope,
} from "@daw-browser/shared";
import {
  canTrackReceiveAudioClip,
  getTrackChannelRole,
} from "@daw-browser/timeline-core/track-routing";
import type { Track } from "@daw-browser/timeline-core/types";
import type { TimelineWorkspaceAutomationModel } from "~/hooks/useTimelineAutomationController";
import type { TimelineTrackLayoutRow } from "~/lib/timeline-track-layout";
import {
  DEFAULT_AUTOMATION_LANE_HEIGHT,
  GROUP_INDENT_PX,
  GROUP_RAIL_WIDTH,
  LANE_HEIGHT,
} from "~/lib/timeline-utils";
import { cn } from "~/lib/utils";
import { parseHexColor } from "~/lib/color";
import { trackColorForClip } from "~/lib/clip-color";
import { formatTrackVolumeDb } from "~/lib/track-sidebar-mixer";
import type { TimelineContextMenuItem } from "./context-menu/timeline-context-menu";
import TimelineContextMenu from "./context-menu/timeline-context-menu";
import AutomationParameterPicker from "./automation-parameter-picker";
import type { TrackSidebarModel } from "./TrackSidebar";

type ActiveVolumeDrag = {
  pointerId: number;
  trackId: Track["id"];
  startValue: number;
  value: number;
};

type TrackSidebarRowModel = {
  sidebar: Accessor<TrackSidebarModel>;
  automation: Accessor<TimelineWorkspaceAutomationModel>;
  automationMetaByTrackId: Accessor<
    ReadonlyMap<
      string,
      {
        automatedTargetKeys: ReadonlySet<string>;
        volumeRange?: { min: number; max: number };
        volumeEnvelope?: AutomationEnvelope;
      }
    >
  >;
  appPreferences: {
    timeline: {
      defaultTrackColor: Accessor<string>;
      defaultTrackColorInput: Accessor<string>;
      defaultGroupColor: Accessor<string>;
      defaultGroupColorInput: Accessor<string>;
    };
  };
  depthByTrackId: Accessor<ReadonlyMap<string, number>>;
  trackNumbersById: Accessor<ReadonlyMap<Track["id"], number>>;
  layoutByTrackId: Accessor<ReadonlyMap<Track["id"], TimelineTrackLayoutRow>>;
  ancestorGroupColorBandsByTrackId: Accessor<
    ReadonlyMap<
      Track["id"],
      Array<{ trackId: Track["id"]; leftPx: number; color: string }>
    >
  >;
  defaultGroupColor: Accessor<string>;
  resolveGroupColor: (color: string | undefined) => string;
  displayTrackName: (track: Track) => string;
  outputTargetName: (track: Track) => string;
  sendTargetName: (track: Track) => string;
  groupTracks: Accessor<Track[]>;
  canWriteTrackRouting: (track: Track) => boolean;
  selectedOutputTargetId: (track: Track) => string;
  selectedSendTargetId: (track: Track) => string;
  returnTracks: Accessor<Track[]>;
  handleTrackCollapseClick: (track: Track, event: MouseEvent) => void;
  isTrackDragBlockedTarget: (target: EventTarget | null) => boolean;
  startTrackDrag: (trackId: Track["id"], event: PointerEvent) => void;
  updateTrackDrag: (event: PointerEvent) => void;
  finishTrackDrag: (event: PointerEvent) => void;
  cancelTrackDrag: (event: PointerEvent) => void;
  suppressTrackClickId: Accessor<Track["id"] | undefined>;
  setSuppressTrackClickId: Setter<Track["id"] | undefined>;
  meters: Record<string, TrackStereoLevels>;
  displayVolume: (track: Track) => number;
  displayMeterLevel: (value: number | undefined) => number;
  quantizeVolume: (volume: number) => number;
  trackVolumeAutomationTargetKey: (trackId: Track["id"]) => string;
  previewTrackVolume: (track: Track, volume: number) => void;
  commitTrackVolume: (
    trackId: Track["id"],
    volume: number,
    previousVolume: number,
  ) => void;
  activeVolumeDrag: Accessor<ActiveVolumeDrag | null>;
  setActiveVolumeDrag: Setter<ActiveVolumeDrag | null>;
  updateVolumeFromPointer: (
    track: Track,
    input: HTMLInputElement,
    clientX: number,
  ) => void;
  releaseVolumePointerCapture: (
    input: HTMLInputElement,
    pointerId: number,
  ) => void;
  startAutomationResize: (
    trackId: Track["id"],
    startHeight: number,
    event: PointerEvent,
  ) => void;
  handleOutputTargetChange: (track: Track, value: string) => void;
  handleSendTargetChange: (track: Track, value: string) => void;
};

type TrackSidebarRowProps = {
  track: Track;
  model: TrackSidebarRowModel;
};

const TrackSidebarRow: Component<TrackSidebarRowProps> = (props) => {
  const model = untrack(() => props.model);
  const track = untrack(() => props.track);
  const {
    activeVolumeDrag,
    ancestorGroupColorBandsByTrackId,
    appPreferences,
    automation,
    automationMetaByTrackId,
    canWriteTrackRouting,
    commitTrackVolume,
    defaultGroupColor,
    depthByTrackId,
    displayTrackName,
    displayVolume,
    displayMeterLevel,
    groupTracks,
    handleOutputTargetChange,
    handleSendTargetChange,
    handleTrackCollapseClick,
    isTrackDragBlockedTarget,
    meters,
    previewTrackVolume,
    quantizeVolume,
    releaseVolumePointerCapture,
    layoutByTrackId,
    trackNumbersById,
    outputTargetName,
    resolveGroupColor,
    returnTracks,
    selectedOutputTargetId,
    selectedSendTargetId,
    sendTargetName,
    setActiveVolumeDrag,
    startAutomationResize,
    startTrackDrag,
    suppressTrackClickId,
    setSuppressTrackClickId,
    trackVolumeAutomationTargetKey,
    updateTrackDrag,
    finishTrackDrag,
    cancelTrackDrag,
    updateVolumeFromPointer,
  } = model;
  const sidebar = model.sidebar;

  const lockedByOther =
    !!track.lockedBy && track.lockedBy !== sidebar().currentUserId;
  const isRecordArmed = () => sidebar().recordArmTrackId === track.id;
  const channelRole = getTrackChannelRole(track);
  const trackNumber = () => trackNumbersById().get(track.id) ?? 0;
  const isReturnTrack = channelRole === "return";
  const isGroupTrack = channelRole === "group";
  const depth = () => depthByTrackId().get(track.id) ?? 0;
  const defaultTrackColor = () => appPreferences.timeline.defaultTrackColor();
  const defaultTrackColorInput = () =>
    appPreferences.timeline.defaultTrackColorInput();
  const defaultGroupColorInput = () =>
    appPreferences.timeline.defaultGroupColorInput();
  const configuredDefaultColor = () =>
    isGroupTrack ? defaultGroupColor() : defaultTrackColor();
  const customDefaultColor = () => parseHexColor(configuredDefaultColor(), "");
  const explicitTrackColor = () => parseHexColor(track.color, "");
  const rowBackgroundColor = () =>
    explicitTrackColor() || customDefaultColor() || undefined;
  const isSelected = () =>
    sidebar().selectedTrackId === track.id ||
    sidebar().selectedTrackIds.includes(track.id);
  const ancestorGroupColorBands = () =>
    ancestorGroupColorBandsByTrackId().get(track.id) ?? [];
  const railHeightPx = () => Math.max(0, clipLaneHeightPx() - 1);
  const muteDisabled = lockedByOther;
  const soloDisabled = lockedByOther;
  const volumeDisabled = lockedByOther;
  const recordDisabled = lockedByOther || !(
    canTrackReceiveAudioClip(track) || isClipKindCompatibleWithTrack(track, "midi")
  );
  const volume = () => displayVolume(track);
  const muted = () => !!track.muted;
  const soloed = () => !!track.soloed;
  const currentSendTargetId = () => selectedSendTargetId(track);
  const selectedAutomationSelection = () =>
    automation().lanes.selectedTargetsByOwnerKey[track.id] ?? {
      parameterId: "volume",
    };
  const selectedAutomationTargetKey = () =>
    automationTargetKey(
      {
        kind: "track",
        trackId: track.id,
        effectInstanceId: selectedAutomationSelection().effectInstanceId,
      },
      selectedAutomationSelection().parameterId,
    );

  const automationMeta = () => automationMetaByTrackId().get(track.id);
  const automationVisible = () =>
    automation().lanes.visibleByTrackId[track.id] === true;
  const displayedAutomationVisible = () =>
    track.collapsed !== true && automationVisible();
  const visibleAutomationTargetKeys = () =>
    automation().lanes.visibleTargetKeysByTrackId[track.id] ?? [];
  const automationHeight = () =>
    automation().lanes.heightsByLaneOwnerKey[track.id] ??
    DEFAULT_AUTOMATION_LANE_HEIGHT;
  const rowLayout = () => layoutByTrackId().get(track.id);
  const rowHeightPx = () => rowLayout()?.heightPx ?? LANE_HEIGHT;
  const clipLaneHeightPx = () => rowLayout()?.clipLaneHeightPx ?? LANE_HEIGHT;
  const automationTotalHeight = () =>
    rowLayout()?.automationHeightPx ??
    (displayedAutomationVisible()
      ? automationHeight() * Math.max(1, visibleAutomationTargetKeys().length)
      : 0);
  const canAddAutomationLane = () => {
    if (!automationVisible()) return false;
    const visible = new Set(visibleAutomationTargetKeys());
    if (!visible.has(selectedAutomationTargetKey())) return true;
    return getAutomationParameterOptionsForTarget(
      automation().lanes.effectInstancesByOwnerKey[track.id] ?? [],
    ).some(
      (option) =>
        !visible.has(
          automationTargetKey(
            {
              kind: "track",
              trackId: track.id,
              effectInstanceId: option.effectInstanceId,
            },
            option.parameterId,
          ),
        ),
    );
  };
  const handleAutomationVisibility = () => {
    if (track.collapsed) {
      sidebar().onToggleTrackCollapsed(track.id);
      if (!automationVisible())
        automation().actions.toggleTrackVisibility(track.id);
      return;
    }
    automation().actions.toggleTrackVisibility(track.id);
  };
  const handleAddAutomationLane = () => {
    if (!canAddAutomationLane()) return;
    if (track.collapsed) sidebar().onToggleTrackCollapsed(track.id);
    automation().actions.addTrackLane(track.id);
  };
  const contextMenuColor = () =>
    parseHexColor(
      track.color,
      isGroupTrack ? defaultGroupColorInput() : defaultTrackColorInput(),
    );
  const trackContextMenuItems = (): TimelineContextMenuItem[] => [
    { kind: "label", label: displayTrackName(track) },
    {
      kind: "item",
      label: "Open effects",
      onSelect: () => sidebar().onTrackClick(track.id),
    },
    {
      kind: "item",
      label: isGroupTrack
        ? track.collapsed
          ? "Expand group"
          : "Collapse group"
        : "Group track",
      disabled: isReturnTrack,
      onSelect: () => {
        if (isGroupTrack) sidebar().onToggleTrackCollapsed(track.id);
        else sidebar().onGroupTracks([track.id]);
      },
    },
    {
      kind: "item",
      label: track.groupId ? "Remove from group" : "No group",
      disabled: !track.groupId,
      onSelect: () => sidebar().onMoveTrackToGroup(track.id, undefined),
    },
    {
      kind: "item",
      label: "Ungroup tracks",
      disabled: !isGroupTrack,
      onSelect: () => sidebar().onUngroupTrack(track.id),
    },
    {
      kind: "item",
      label: "Select all clips in group",
      disabled: !isGroupTrack,
      onSelect: () => sidebar().onSelectAllClipsInGroup(track.id),
    },
    {
      kind: "color",
      label: "Track color",
      value: contextMenuColor(),
      onChange: (color) =>
        sidebar().onSetTrackColor(
          track.id,
          parseHexColor(color, contextMenuColor()),
        ),
    },
    {
      kind: "item",
      label: "Reset track color",
      onSelect: () => sidebar().onResetTrackColor(track.id),
    },
    {
      kind: "item",
      label: isGroupTrack
        ? "Assign group colors to clips"
        : "Assign track color to clips",
      disabled: !trackColorForClip(track.color),
      onSelect: () => sidebar().onAssignTrackColorToClips(track.id),
    },
    {
      kind: "item",
      label: isGroupTrack ? "Reset group clip colors" : "Reset clip colors",
      onSelect: () => sidebar().onResetClipColors(track.id),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: muted() ? "Unmute track" : "Mute track",
      disabled: muteDisabled,
      onSelect: () => sidebar().onToggleMute(track.id),
    },
    {
      kind: "item",
      label: soloed() ? "Unsolo track" : "Solo track",
      disabled: soloDisabled,
      onSelect: () => sidebar().onToggleSolo(track.id),
    },
    {
      kind: "item",
      label: isRecordArmed() ? "Disarm recording" : "Arm for recording",
      disabled: recordDisabled,
      onSelect: () => sidebar().onToggleRecordArm(track.id),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: displayedAutomationVisible()
        ? "Hide automation lane"
        : "Show automation lane",
      onSelect: handleAutomationVisibility,
    },
    {
      kind: "item",
      label: "Add automation lane",
      disabled: !canAddAutomationLane(),
      onSelect: handleAddAutomationLane,
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Delete track",
      shortcut: "⌫",
      onSelect: () => sidebar().onDeleteTrack(track.id),
    },
  ];

  const row = (
    <div
      class={cn(
        "track-row-divider relative",
        isSelected() && rowBackgroundColor() && "track-row-selected-wash",
        isGroupTrack && rowBackgroundColor()
          ? "text-black"
          : isSelected()
            ? "bg-timeline-surface-muted"
            : "bg-timeline-surface",
      )}
      style={{
        height: `${rowHeightPx()}px`,
        background: rowBackgroundColor() ? rowBackgroundColor() : undefined,
      }}
      onClick={() => {
        if (suppressTrackClickId() === track.id) {
          setSuppressTrackClickId(undefined);
          return;
        }
        sidebar().onTrackClick(track.id);
      }}
      onPointerDown={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("[data-track-name]")
        ) {
          startTrackDrag(track.id, event);
          return;
        }
        if (isTrackDragBlockedTarget(event.target)) return;
        startTrackDrag(track.id, event);
      }}
      onPointerMove={updateTrackDrag}
      onPointerUp={finishTrackDrag}
      onPointerCancel={cancelTrackDrag}
      onLostPointerCapture={cancelTrackDrag}
    >
      <For each={ancestorGroupColorBands()}>
        {(band) => (
          <div
            class="absolute top-0 z-10 cursor-pointer border-r border-border"
            style={{
              left: `${band.leftPx}px`,
              width: `${GROUP_RAIL_WIDTH}px`,
              height: `${railHeightPx()}px`,
              background: band.color,
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
              sidebar().onTrackClick(band.trackId);
            }}
            onClick={(event) => event.stopPropagation()}
          />
        )}
      </For>
      <Show when={isGroupTrack && depth() > 0}>
        <div
          class="absolute top-0 z-10 cursor-pointer border-r border-border"
          style={{
            left: `${depth() * GROUP_INDENT_PX}px`,
            width: `${GROUP_RAIL_WIDTH}px`,
            height: `${railHeightPx()}px`,
            background: resolveGroupColor(track.color),
          }}
          onPointerDown={(event) => {
            event.stopPropagation();
            sidebar().onTrackClick(track.id);
          }}
          onClick={(event) => event.stopPropagation()}
        />
      </Show>
      <Show when={isGroupTrack && !track.collapsed}>
        <div
          class="pointer-events-none absolute z-10 h-px bg-border"
          style={{
            top: `${clipLaneHeightPx() - 1}px`,
            left: `${depth() * GROUP_INDENT_PX + GROUP_RAIL_WIDTH}px`,
            right: "0",
          }}
        />
      </Show>
      <div
        class={cn(
          "grid items-start gap-x-2",
          track.collapsed ? "px-2 py-1" : "p-2",
        )}
        style={{
          height: `${clipLaneHeightPx()}px`,
          "padding-left": `${4 + depth() * GROUP_INDENT_PX}px`,
          "grid-template-columns":
            "minmax(76px, 1fr) minmax(96px, 1.2fr) 101px",
        }}
      >
        <div class="flex min-w-0 items-start gap-1 overflow-hidden">
          <button
            class={cn(
              "flex w-4 shrink-0 items-center justify-center text-xs text-muted-foreground hover:text-foreground",
              track.collapsed ? "h-6" : "h-7",
            )}
            onClick={(event) => {
              event.stopPropagation();
              handleTrackCollapseClick(track, event);
            }}
            title={track.collapsed ? "Expand track" : "Collapse track"}
          >
            {track.collapsed ? "▶" : "▼"}
          </button>
          <button
            class={cn(
              "flex min-w-0 flex-1 items-start justify-start px-0 text-left text-sm font-semibold leading-6 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary",
              track.collapsed
                ? "h-6"
                : "h-7",
            )}
            type="button"
            data-track-name
            onDblClick={(event) => {
              if (!isGroupTrack || !track.collapsed) return;
              event.stopPropagation();
              sidebar().onToggleTrackCollapsed(track.id);
            }}
            onClick={(event) => {
              event.stopPropagation();
              if (suppressTrackClickId() === track.id) {
                setSuppressTrackClickId(undefined);
                return;
              }
              sidebar().onTrackClick(track.id);
            }}
            aria-label={`Select track ${trackNumber()}: ${displayTrackName(track)}`}
            title={`Select track ${trackNumber()}: ${displayTrackName(track)}`}
          >
            <span class="truncate">{displayTrackName(track)}</span>
          </button>
        </div>

        <Show when={!track.collapsed}>
          <div class="flex min-w-0 flex-col gap-1">
            <Show when={!isGroupTrack}>
              <div class="relative">
                <div
                  class={cn(
                    "flex h-7 w-full items-center justify-between border border-border bg-timeline-background px-2 text-xs text-foreground",
                    !canWriteTrackRouting(track) && "text-muted-foreground",
                  )}
                >
                  <span class="truncate">{outputTargetName(track)}</span>
                  <svg
                    class="h-3 w-3 shrink-0 text-muted-foreground"
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
                    handleOutputTargetChange(track, event.currentTarget.value)
                  }
                  class="absolute inset-0 h-7 w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                  title="Track output"
                >
                  <option value="">Master</option>
                  <For each={groupTracks()}>
                    {(groupTrack) => (
                      <option value={groupTrack.id}>
                        {displayTrackName(groupTrack)}
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
                    "flex h-7 w-full items-center justify-between border border-border bg-timeline-background px-2 text-xs text-foreground",
                    (!canWriteTrackRouting(track) ||
                      returnTracks().length === 0) &&
                      "text-muted-foreground",
                  )}
                >
                  <span class="truncate">{sendTargetName(track)}</span>
                  <svg
                    class="h-3 w-3 shrink-0 text-muted-foreground"
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
                    !canWriteTrackRouting(track) || returnTracks().length === 0
                  }
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) =>
                    handleSendTargetChange(track, event.currentTarget.value)
                  }
                  class="absolute inset-0 h-7 w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                  title={
                    returnTracks().length === 0
                      ? "Add a Return track to create sends"
                      : "Track send"
                  }
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
        </Show>

        <div class="track-row-control-panel flex items-start gap-2">
          <div
            class={cn(
              "track-row-control-stack shrink-0",
              track.collapsed ? "grid gap-1" : "flex flex-col gap-1",
            )}
            style={
              track.collapsed
                ? { "grid-template-columns": "18px 12px 12px 1fr" }
                : undefined
            }
          >
            <div
              class={cn(
                track.collapsed ? "contents" : "grid gap-1",
              )}
              style={{ "grid-template-columns": "3fr 1fr 1fr" }}
            >
                <button
                  class={cn(
                    "border-2 text-xs font-bold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary",
                    "h-5",
                    muteDisabled
                      ? "cursor-not-allowed border-border bg-timeline-surface-muted text-muted-foreground"
                      : muted()
                        ? "border-border bg-timeline-surface-muted text-muted-foreground hover:bg-muted"
                        : "border-amber-300 bg-amber-400 text-black shadow-inner",
                  )}
                  type="button"
                  disabled={muteDisabled}
                  aria-pressed={!muted()}
                  aria-label={
                    muted()
                      ? `Activate track ${trackNumber()}`
                      : `Deactivate track ${trackNumber()}`
                  }
                  title={
                    lockedByOther
                      ? "Track locked by another user"
                      : muted()
                        ? `Activate track ${trackNumber()}`
                        : `Deactivate track ${trackNumber()}`
                  }
                  onClick={(event) => {
                    event.stopPropagation();
                    if (!muteDisabled) sidebar().onToggleMute(track.id);
                  }}
                >
                  {trackNumber()}
                </button>
                <button
                  class={cn(
                    "border text-xs font-semibold",
                    "h-5",
                    soloDisabled
                      ? "cursor-not-allowed border-border bg-muted/40 text-muted-foreground"
                      : soloed()
                        ? "border-blue-300 bg-blue-500/90 text-black"
                        : "border-border bg-timeline-surface-muted text-foreground hover:bg-muted",
                  )}
                  type="button"
                  aria-pressed={soloed()}
                  aria-label={
                    soloed()
                      ? `Unsolo track ${trackNumber()}`
                      : `Solo track ${trackNumber()}`
                  }
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
                    "flex items-center justify-center border text-xs font-bold transition-colors",
                    "h-5",
                    recordDisabled
                      ? "cursor-not-allowed border-red-900 bg-timeline-surface-muted text-red-900"
                      : isRecordArmed()
                        ? "border-red-400 bg-red-500 text-black shadow-inner"
                        : "border-red-500 text-red-400 hover:bg-red-500/20",
                  )}
                  type="button"
                  aria-pressed={isRecordArmed()}
                  aria-label={
                    isRecordArmed()
                      ? `Disarm track ${trackNumber()} for recording`
                      : `Arm track ${trackNumber()} for recording`
                  }
                  title={
                    lockedByOther
                      ? "Track locked by another user"
                      : isReturnTrack
                        ? "Return tracks cannot be armed for recording"
                        : isGroupTrack
                          ? "Group tracks cannot be armed for recording"
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

            </div>

            <div
              class={cn(
                track.collapsed ? "contents" : "grid gap-1",
              )}
              style={{ "grid-template-columns": "3fr 1fr 1fr" }}
            >
              <div
                class={cn(
                  "relative flex items-center",
                  track.collapsed ? "h-5" : "h-6",
                  track.collapsed && "col-start-4 row-start-1",
                )}
              >
                <Show when={automationMeta()?.volumeEnvelope}>
                  <span class="track-automation-indicator absolute right-0 top-0 z-10 h-2 w-2 rounded-full bg-red-500" />
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
                    automation().actions.selectParameter(track.id, {
                      parameterId: "volume",
                    });
                    if (volumeDisabled) return;
                    event.preventDefault();
                    const startValue = quantizeVolume(volume());
                    automation().actions.overrideTarget(
                      trackVolumeAutomationTargetKey(track.id),
                    );
                    setActiveVolumeDrag({
                      pointerId: event.pointerId,
                      trackId: track.id,
                      startValue,
                      value: startValue,
                    });
                    event.currentTarget.setPointerCapture(event.pointerId);
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
                    automationMeta()?.volumeEnvelope &&
                      "track-volume-slider-automated",
                    volumeDisabled && "cursor-not-allowed opacity-60",
                  )}
                  title={
                    lockedByOther
                      ? "Track locked by another user"
                      : `Track ${trackNumber()} volume`
                  }
                  aria-label={`Track ${trackNumber()} volume`}
                  aria-valuetext={formatTrackVolumeDb(volume())}
                />
                <output
                  class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center text-xs font-semibold tabular-nums text-foreground"
                  aria-hidden="true"
                >
                  {formatTrackVolumeDb(volume())}
                </output>
              </div>
              <div
                class="col-span-2"
                classList={{ hidden: track.collapsed }}
                aria-hidden="true"
              />
            </div>
            <Show when={!track.collapsed}>
              <div
                class="grid gap-1"
                style={{ "grid-template-columns": "3fr 1fr 1fr" }}
              >
                <div aria-hidden="true" />
                <button
                  class={cn(
                    "h-6 border text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary",
                    displayedAutomationVisible()
                      ? "border-red-400 bg-red-500/90 text-black"
                      : "border-border bg-timeline-surface-muted text-red-300 hover:bg-red-500/20",
                  )}
                  type="button"
                  aria-pressed={displayedAutomationVisible()}
                  aria-label={
                    displayedAutomationVisible()
                      ? `Hide automation for track ${trackNumber()}`
                      : `Show automation for track ${trackNumber()}`
                  }
                  onClick={(event) => {
                    event.stopPropagation();
                    handleAutomationVisibility();
                  }}
                  title={
                    displayedAutomationVisible()
                      ? "Hide automation lane"
                      : "Show automation lane"
                  }
                >
                  A
                </button>
                <button
                  class={cn(
                    "h-6 border text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary",
                    canAddAutomationLane()
                      ? "border-border bg-timeline-surface-muted text-red-200 hover:bg-red-500/20"
                      : "cursor-not-allowed border-border bg-timeline-surface text-muted-foreground",
                  )}
                  type="button"
                  disabled={!canAddAutomationLane()}
                  aria-label={`Add automation lane for track ${trackNumber()}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleAddAutomationLane();
                  }}
                  title={
                    displayedAutomationVisible()
                      ? "Add another automation lane"
                      : "Show automation with A before adding lanes"
                  }
                >
                  +
                </button>
              </div>
            </Show>
          </div>

          <div
            class={cn(
              "track-meter-strip relative shrink-0",
              track.collapsed ? "h-6" : "h-full",
            )}
          >
            <div class="absolute inset-0 flex items-end justify-center gap-1">
              {(() => {
                const meter = meters[track.id];
                const left = displayMeterLevel(meter?.left);
                const right = displayMeterLevel(meter?.right);
                const leftColor = left >= 0.98 ? "bg-red-500" : "bg-green-500";
                const rightColor =
                  right >= 0.98 ? "bg-red-500" : "bg-green-500";
                return (
                  <>
                    <div class="relative h-full w-1 overflow-hidden bg-border/60">
                      <div
                        class={cn(
                          "absolute bottom-0 w-full transition-all duration-75",
                          leftColor,
                        )}
                        style={{ height: `${left * 100}%` }}
                      />
                    </div>
                    <div class="relative h-full w-1 overflow-hidden bg-border/60">
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
      {displayedAutomationVisible() ? (
        <div
          class="absolute inset-x-0 z-10 border-t border-automation/30 bg-timeline-background/95 text-xxs text-error-foreground"
          style={{
            top: `${clipLaneHeightPx()}px`,
            height: `${automationTotalHeight()}px`,
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <div
            class="absolute inset-x-0 top-0 h-2 -translate-y-1/2 cursor-row-resize"
            onPointerDown={(event) =>
              startAutomationResize(track.id, automationHeight(), event)
            }
          />
          <For each={visibleAutomationTargetKeys()}>
            {(targetKey) => {
              const envelope = () =>
                automation().envelopes.byTargetKey.get(targetKey);
              const selection = () => {
                const currentEnvelope = envelope();
                if (currentEnvelope)
                  return {
                    parameterId: currentEnvelope.parameterId,
                    effectInstanceId: currentEnvelope.target.effectInstanceId,
                  };
                return (
                  getAutomationParameterOptionsForTarget(
                    automation().lanes.effectInstancesByOwnerKey[track.id] ?? [],
                  ).find(
                    (option) =>
                      automationTargetKey(
                        {
                          kind: "track",
                          trackId: track.id,
                          effectInstanceId: option.effectInstanceId,
                        },
                        option.parameterId,
                      ) === targetKey,
                  ) ?? { parameterId: "volume" }
                );
              };
              return (
                <div
                  class="track-expanded-row-grid grid items-center gap-x-4 border-b border-red-500/20 px-2"
                  style={{ height: `${automationHeight()}px` }}
                >
                  <div class="flex items-center gap-1 overflow-hidden">
                    <span
                      class="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500"
                      classList={{ "opacity-30": !envelope() }}
                    />
                    <span class="truncate">Automation</span>
                  </div>
                  <AutomationParameterPicker
                    target={{ kind: "track", trackId: track.id }}
                    effects={
                      automation().lanes.effectInstancesByOwnerKey[track.id] ?? []
                    }
                    value={selection()}
                    automatedTargetKeys={automationMeta()?.automatedTargetKeys}
                    onChange={(nextSelection) => {
                      automation().actions.hideTrackLane(track.id, targetKey);
                      automation().actions.showTrackLane(track.id, nextSelection);
                      automation().actions.selectParameter(
                        track.id,
                        nextSelection,
                      );
                    }}
                  />
                  <div class="flex items-center justify-end gap-2 text-red-200/70">
                    <span class="truncate">
                      {envelope()?.points.length ?? 0} pts
                    </span>
                    <button
                      type="button"
                      class="h-5 w-5 border border-automation/30 text-error-foreground hover:border-red-400"
                      onClick={(event) => {
                        event.stopPropagation();
                        automation().actions.hideTrackLane(track.id, targetKey);
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
  return (
    <TimelineContextMenu items={trackContextMenuItems}>
      {row}
    </TimelineContextMenu>
  );
};

export default TrackSidebarRow;
