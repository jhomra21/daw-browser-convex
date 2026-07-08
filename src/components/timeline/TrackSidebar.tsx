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
import { normalizeDragMoveSet, resolveTrackDropZone, type TrackDropTarget } from "~/lib/track-group-ops";
import { DEFAULT_AUTOMATION_LANE_HEIGHT, GROUP_INDENT_PX, GROUP_RAIL_WIDTH, LANE_HEIGHT, RULER_HEIGHT, clampAutomationLaneHeight } from "~/lib/timeline-utils";
import { cn } from "~/lib/utils";
import type { Track, TrackSend } from "@daw-browser/timeline-core/types";
import type { TimelineWorkspaceAutomationModel } from "~/hooks/useTimelineAutomationController";
import { trackLayoutRowAtY, type TimelineTrackLayoutRow } from "~/lib/timeline-track-layout";
import MasterSidebarRow, {
  MASTER_ROW_HEIGHT,
  type MasterSidebarModel,
} from "~/components/timeline/MasterSidebarRow";
import AutomationParameterPicker from "./automation-parameter-picker";
import TimelineContextMenu, { type TimelineContextMenuItem } from "./context-menu/timeline-context-menu";
import { useAppPreferences } from "~/context/app-preferences";
import { parseHexColor } from "~/lib/preferences/app-preferences";

const automationParameterOptions = getAutomationParameterOptions();

type TrackSidebarProps = {
  sidebar: {
    tracks: Track[];
    allTracks: Track[];
    trackById: ReadonlyMap<string, Track>;
    trackLayout: TimelineTrackLayoutRow[];
    scrollElement: () => HTMLDivElement | undefined;
    selectedTrackId: Track["id"] | "";
    selectedTrackIds: readonly Track["id"][];
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
    onToggleTrackCollapsed: (trackId: Track["id"]) => void;
    onSetTracksCollapsed: (updates: Array<{ trackId: Track["id"]; collapsed: boolean }>) => void;
    onGroupTracks: (trackIds: Track["id"][]) => void;
    onUngroupTrack: (groupId: Track["id"]) => void;
    onMoveTrackToGroup: (trackId: Track["id"], groupId: Track["id"] | undefined) => void;
    onReorderTracks: (trackIds: Track["id"][], target: TrackDropTarget) => void;
    onSetTrackColor: (trackId: Track["id"], color: string | undefined) => void;
    onSelectAllClipsInGroup: (groupId: Track["id"]) => void;
    currentUserId: string;
    subscribeTrackLevels: (
      listener: (levels: ReadonlyMap<string, TrackStereoLevels>) => void,
    ) => () => void;
    onVolumePreview: (
      trackId: Track["id"],
      volume: number,
      muted: boolean,
    ) => void;
    onDeleteTrack: (trackId: Track["id"]) => void;
  };
  automation: TimelineWorkspaceAutomationModel;
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
const isBulkCollapseModifier = (event: MouseEvent | PointerEvent) => event.metaKey || event.altKey;
const TrackSidebar: Component<TrackSidebarProps> = (props) => {
  const sidebar = () => props.sidebar;
  const appPreferences = useAppPreferences();

  const [meters, setMeters] = createStore<Record<string, TrackStereoLevels>>({});
  const [selectedOutputTargets, setSelectedOutputTargets] = createSignal<
    Map<Track["id"], string>
  >(new Map());
  const [selectedSendTargets, setSelectedSendTargets] = createSignal<
    Map<Track["id"], string>
  >(new Map());
  const [trackDrag, setTrackDrag] = createSignal<{
    pointerId: number;
    startX: number;
    startY: number;
    trackId: Track["id"];
    dragging: boolean;
    target?: TrackDropTarget;
  }>();
  const [suppressTrackClickId, setSuppressTrackClickId] = createSignal<Track["id"]>();
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
    const trackIds = new Set<string>(sidebar().allTracks.map((track) => track.id));
    setMeters(produce((current) => {
      for (const trackId of Object.keys(current)) {
        if (!trackIds.has(trackId)) delete current[trackId];
      }
    }));
  });

  const groupTracks = createMemo(() =>
    sidebar().allTracks.filter((track) => getTrackChannelRole(track) === "group"),
  );
  const groupTrackNames = createMemo(
    () =>
      new Map<string, string>(
        groupTracks().map((track, index) => [track.id, track.name || `Group ${index + 1}`]),
      ),
  );
  const depthByTrackId = createMemo(() => new Map(sidebar().trackLayout.map((row) => [row.trackId, row.depth])));
  const layoutByTrackId = createMemo(() => new Map(sidebar().trackLayout.map((row) => [row.trackId, row])));
  const returnTracks = createMemo(() =>
    sidebar().allTracks.filter((track) => getTrackChannelRole(track) === "return"),
  );
  const returnTrackNames = createMemo(
    () =>
      new Map<string, string>(
        returnTracks().map((track, index) => [track.id, track.name || `Return ${index + 1}`]),
      ),
  );
  const displayTrackName = (track: Track) =>
    groupTrackNames().get(track.id) ?? returnTrackNames().get(track.id) ?? track.name;
  const automationMetaByTrackId = createMemo(() => {
    const byTrackId = new Map<string, {
      automatedParameterIds: ReadonlySet<string>;
      volumeRange?: { min: number; max: number };
      volumeEnvelope?: AutomationEnvelope;
    }>();
    const mutable = new Map<string, {
      automatedParameterIds: Set<string>;
      volumeRange?: { min: number; max: number };
      volumeEnvelope?: AutomationEnvelope;
    }>();
    for (const envelope of props.automation.envelopes.byTargetKey.values()) {
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
    const meta: {
      automatedParameterIds: Set<string>;
      selectedEnvelope: AutomationEnvelope | undefined;
    } = {
      automatedParameterIds: new Set<string>(),
      selectedEnvelope: undefined,
    };
    const selectedParameter = props.automation.lanes.selectedParametersByTargetKey.master ?? "volume";
    const selectedTargetKey = automationTargetKey({ kind: "master" }, selectedParameter);
    for (const envelope of props.automation.envelopes.byTargetKey.values()) {
      if (envelope.target.kind !== "master") continue;
      meta.automatedParameterIds.add(envelope.parameterId);
      if (envelope.targetKey === selectedTargetKey) meta.selectedEnvelope = envelope;
    }
    return meta;
  });
  const masterRowReservedHeight = () => (
    MASTER_ROW_HEIGHT + (!sidebar().master.collapsed && props.automation.lanes.masterVisible ? props.automation.lanes.masterHeight : 0)
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
    setSelectedOutputTargets((current) => {
      let next: Map<Track["id"], string> | null = null;
      for (const [trackId, targetId] of current) {
        const track = sidebar().trackById.get(trackId);
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
        const track = sidebar().trackById.get(trackId);
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
  const handleTrackCollapseClick = (track: Track, event: MouseEvent) => {
    const collapsed = track.collapsed !== true;
    if (!isBulkCollapseModifier(event)) {
      sidebar().onToggleTrackCollapsed(track.id);
      return;
    }
    sidebar().onSetTracksCollapsed(
      sidebar().allTracks
        .filter((candidate) => candidate.collapsed !== collapsed)
        .map((candidate) => ({ trackId: candidate.id, collapsed })),
    );
  };

  const dropTargetAt = (clientY: number): TrackDropTarget | undefined => {
    const scrollElement = sidebar().scrollElement();
    if (!scrollElement) return undefined;
    const rect = scrollElement.getBoundingClientRect();
    const localY = clientY - rect.top + (scrollElement.scrollTop || 0) - RULER_HEIGHT;
    const row = trackLayoutRowAtY(sidebar().trackLayout, localY);
    if (!row) return undefined;
    const track = sidebar().trackById.get(row.trackId);
    if (!track) return undefined;
    return {
      trackId: row.trackId,
      zone: resolveTrackDropZone({
        localY: localY - row.topPx,
        rowHeightPx: row.heightPx,
        targetIsGroup: getTrackChannelRole(track) === "group",
      }),
    };
  };

  const startTrackDrag = (trackId: Track["id"], event: PointerEvent) => {
    if (event.button !== 0) return;
    if (event.currentTarget instanceof HTMLElement) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setTrackDrag({
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      trackId,
      dragging: false,
    });
  };

  const updateTrackDrag = (event: PointerEvent) => {
    const drag = trackDrag();
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dragging = drag.dragging || Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4;
    const target = dragging ? dropTargetAt(event.clientY) : undefined;
    if (drag.dragging === dragging && drag.target?.trackId === target?.trackId && drag.target?.zone === target?.zone) return;
    setTrackDrag({ ...drag, dragging, target });
  };

  const finishTrackDrag = (event: PointerEvent) => {
    const drag = trackDrag();
    if (!drag || drag.pointerId !== event.pointerId) return;
    setTrackDrag(undefined);
    if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag.dragging || !drag.target) return;
    setSuppressTrackClickId(drag.trackId);
    const activeSelection = sidebar().selectedTrackIds.includes(drag.trackId)
      ? sidebar().selectedTrackIds
      : [drag.trackId];
    sidebar().onReorderTracks(normalizeDragMoveSet(sidebar().allTracks, new Set(activeSelection)), drag.target);
  };

  const cancelTrackDrag = (event: PointerEvent) => {
    const drag = trackDrag();
    if (drag?.pointerId === event.pointerId) setTrackDrag(undefined);
  };

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
      props.automation.actions.resizeTrackLane(
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
        <div class="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-muted" />
      </div>

      <div
        class="relative flex h-full flex-col overflow-x-clip border-l border-border bg-timeline-surface p-0"
        style={{
          width: `${sidebar().sidebarWidth}px`,
          "min-width": `${TIMELINE_SIDEBAR_MIN_WIDTH}px`,
        }}
      >
        <div class="sticky top-0 z-40 border-b border-border bg-timeline-surface" style={{ height: `${RULER_HEIGHT}px` }} />
        <Show when={trackDrag()?.dragging && trackDrag()?.target}>
          {(target) => {
            const row = () => layoutByTrackId().get(target().trackId);
            const top = () => {
              const current = row();
              if (!current) return RULER_HEIGHT;
              if (target().zone === "below") return RULER_HEIGHT + current.topPx + current.heightPx;
              return RULER_HEIGHT + current.topPx;
            };
            return (
              <div
                class={cn(
                  "pointer-events-none absolute z-50 border-primary",
                  target().zone === "inside"
                    ? "h-8 rounded border"
                    : "h-0 border-t-2",
                )}
                style={{
                  top: target().zone === "inside" ? `${top() + 12}px` : `${top()}px`,
                  left: `${8 + (row()?.depth ?? 0) * GROUP_INDENT_PX}px`,
                  right: "8px",
                }}
              />
            );
          }}
        </Show>
        <For each={sidebar().tracks}>
          {(track) => {
            const lockedByOther =
              !!track.lockedBy && track.lockedBy !== sidebar().currentUserId;
            const isRecordArmed = () => sidebar().recordArmTrackId === track.id;
            const channelRole = getTrackChannelRole(track);
            const isReturnTrack = channelRole === "return";
            const isGroupTrack = channelRole === "group";
            const depth = () => depthByTrackId().get(track.id) ?? 0;
            const defaultTrackColor = () => appPreferences.timeline.defaultTrackColor();
            const defaultGroupColor = () => appPreferences.timeline.defaultGroupColor();
            const trackColor = () => track.color ?? (isGroupTrack ? defaultGroupColor() : defaultTrackColor());
            const ancestorGroupColorBands = () => {
              const bands: Array<{ leftPx: number; color: string }> = [];
              let groupId = track.groupId;
              while (groupId) {
                const group = sidebar().trackById.get(groupId);
                if (!group) break;
                bands.push({
                  leftPx: (depthByTrackId().get(group.id) ?? 0) * GROUP_INDENT_PX,
                  color: group.color ?? defaultGroupColor(),
                });
                groupId = group.groupId;
              }
              return bands;
            };
            const muteDisabled = lockedByOther;
            const soloDisabled = lockedByOther;
            const volumeDisabled = lockedByOther;
            const recordDisabled =
              lockedByOther || !canTrackReceiveAudioClip(track);
            const volume = () => displayVolume(track);
            const muted = () => !!track.muted;
            const soloed = () => !!track.soloed;
            const currentSendTargetId = () => selectedSendTargetId(track);
            const selectedAutomationParameter = () => props.automation.lanes.selectedParametersByTargetKey[track.id] ?? "volume";
            const selectedAutomationTargetKey = () => automationTargetKey({ kind: "track", trackId: track.id }, selectedAutomationParameter());
            const selectedAutomationEnvelope = () => props.automation.envelopes.byTargetKey.get(selectedAutomationTargetKey());
            const automationMeta = () => automationMetaByTrackId().get(track.id);
            const automationVisible = () => props.automation.lanes.visibleByTrackId[track.id] === true;
            const displayedAutomationVisible = () => track.collapsed !== true && automationVisible();
            const automationButtonActive = () => track.collapsed ? automationVisible() : displayedAutomationVisible();
            const visibleAutomationParameterIds = () => props.automation.lanes.visibleParameterIdsByTrackId[track.id] ?? [];
            const automationHeight = () => props.automation.lanes.heightsByLaneOwnerKey[track.id] ?? DEFAULT_AUTOMATION_LANE_HEIGHT;
            const rowLayout = () => layoutByTrackId().get(track.id);
            const rowHeightPx = () => rowLayout()?.heightPx ?? LANE_HEIGHT;
            const clipLaneHeightPx = () => rowLayout()?.clipLaneHeightPx ?? LANE_HEIGHT;
            const automationTotalHeight = () => rowLayout()?.automationHeightPx ?? (displayedAutomationVisible() ? automationHeight() * Math.max(1, visibleAutomationParameterIds().length) : 0);
            const canAddAutomationLane = () => {
              if (!displayedAutomationVisible()) return false;
              const visible = new Set(visibleAutomationParameterIds());
              if (!visible.has(selectedAutomationParameter())) return true;
              return automationParameterOptions.some((option) => !visible.has(option.id));
            };
            const contextMenuColor = () => parseHexColor(track.color, isGroupTrack ? defaultGroupColor() : defaultTrackColor());
            const trackContextMenuItems = (): TimelineContextMenuItem[] => [
              { kind: "label", label: displayTrackName(track) },
              { kind: "item", label: "Open effects", onSelect: () => sidebar().onTrackClick(track.id) },
              {
                kind: "item",
                label: isGroupTrack ? (track.collapsed ? "Expand group" : "Collapse group") : "Group track",
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
                onChange: (color) => sidebar().onSetTrackColor(track.id, parseHexColor(color, contextMenuColor())),
              },
              {
                kind: "item",
                label: "Clear track color",
                disabled: !track.color,
                onSelect: () => sidebar().onSetTrackColor(track.id, undefined),
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
                label: displayedAutomationVisible() ? "Hide automation lane" : "Show automation lane",
                onSelect: () => props.automation.actions.toggleTrackVisibility(track.id),
              },
              {
                kind: "item",
                label: "Add automation lane",
                disabled: !canAddAutomationLane(),
                onSelect: () => props.automation.actions.addTrackLane(track.id),
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
                  "relative [box-shadow:inset_0_-1px_0_rgb(38_38_38)]",
                  isGroupTrack
                    ? "text-black"
                    : sidebar().selectedTrackId === track.id
                    ? "bg-timeline-surface-muted"
                    : "bg-timeline-surface",
                )}
                style={{
                  height: `${rowHeightPx()}px`,
                  ...(isGroupTrack || track.groupId ? { background: trackColor() } : {}),
                }}
                onClick={() => sidebar().onTrackClick(track.id)}
                onPointerMove={updateTrackDrag}
                onPointerUp={finishTrackDrag}
                onPointerCancel={cancelTrackDrag}
                onLostPointerCapture={cancelTrackDrag}
              >
                <For each={ancestorGroupColorBands()}>
                  {(band) => (
                    <div
                      class="absolute bottom-0 top-0"
                      style={{
                        left: `${band.leftPx}px`,
                        width: `${GROUP_INDENT_PX}px`,
                        background: band.color,
                      }}
                    />
                  )}
                </For>
                <Show when={!isGroupTrack || depth() > 0}>
                  <div
                    class="absolute bottom-0 top-0"
                    style={{
                      left: `${depth() * GROUP_INDENT_PX}px`,
                      width: `${track.groupId ? GROUP_INDENT_PX : GROUP_RAIL_WIDTH}px`,
                      background: trackColor(),
                    }}
                  />
                </Show>
                <div
                  class={cn(
                    "grid items-center gap-x-4",
                    track.collapsed
                      ? "grid-cols-[minmax(0,1fr)_auto] px-2 py-0.5"
                      : "grid-cols-[minmax(72px,96px)_minmax(96px,1fr)_92px] p-2",
                  )}
                  style={{
                    height: `${clipLaneHeightPx()}px`,
                    "padding-left": `${8 + depth() * GROUP_INDENT_PX}px`,
                  }}
                >
                  <div class="flex min-w-0 items-center gap-1 overflow-hidden">
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
                        "flex flex-1 items-center justify-center border px-2 text-center text-sm font-semibold",
                        track.collapsed ? "h-6" : "h-7",
                        isGroupTrack
                          ? "border-transparent bg-timeline-background text-foreground hover:bg-timeline-surface-muted"
                          : muteDisabled
                          ? "cursor-not-allowed border-border text-muted-foreground"
                          : muted()
                            ? "border-border bg-amber-500 text-black"
                            : sidebar().selectedTrackId === track.id
                              ? "border-border"
                              : "border-border hover:border-border",
                      )}
                      style={{
                        "border-width": "0.5px",
                      }}
                      disabled={muteDisabled}
                      onPointerDown={(event) => startTrackDrag(track.id, event)}
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
                            !canWriteTrackRouting(track) &&
                              "text-muted-foreground",
                          )}
                        >
                          <span class="truncate">
                            {outputTargetName(track)}
                          </span>
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
                          <span class="truncate">
                            {sendTargetName(track)}
                          </span>
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
                  </Show>

                  <Show
                    when={!track.collapsed}
                    fallback={
                      <div class="grid grid-cols-3 gap-1">
                        <button
                          class={cn(
                            "h-6 w-6 border text-xs font-bold transition-colors",
                            recordDisabled
                              ? "cursor-not-allowed border-red-900 bg-timeline-surface-muted text-red-900"
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
                            "h-6 w-6 border text-xs font-semibold",
                            soloDisabled
                              ? "cursor-not-allowed border-border bg-muted/40 text-muted-foreground"
                              : soloed()
                                ? "border-blue-300 bg-blue-500/90 text-black"
                                : "border-border bg-timeline-surface-muted text-foreground hover:bg-muted",
                          )}
                          disabled={soloDisabled}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (soloDisabled) return;
                            sidebar().onToggleSolo(track.id);
                          }}
                          title={lockedByOther ? "Track locked by another user" : soloed() ? "Unsolo" : "Solo"}
                        >
                          S
                        </button>
                        <button
                          class={cn(
                            "h-6 w-6 border text-xs font-semibold transition-colors",
                            automationButtonActive()
                              ? "border-red-400 bg-red-500/90 text-black"
                              : "border-border bg-timeline-surface-muted text-red-300 hover:bg-red-500/20",
                          )}
                          onClick={(event) => {
                            event.stopPropagation();
                            props.automation.actions.toggleTrackVisibility(track.id);
                          }}
                          title={automationVisible() ? "Hide automation lane" : "Show automation lane when expanded"}
                        >
                          A
                        </button>
                      </div>
                    }
                  >
                  <div class="flex w-[92px] items-center gap-2">
                    <div class="flex w-[72px] shrink-0 flex-col gap-1">
                      <div class="grid grid-cols-4 gap-1">
                        <button
                          class={cn(
                            "flex h-7 items-center justify-center border text-xs font-bold transition-colors",
                            recordDisabled
                              ? "cursor-not-allowed border-red-900 bg-timeline-surface-muted text-red-900"
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
                              ? "cursor-not-allowed border-border bg-muted/40 text-muted-foreground"
                              : soloed()
                                ? "border-blue-300 bg-blue-500/90 text-black"
                                : "border-border bg-timeline-surface-muted text-foreground hover:bg-muted",
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
                            displayedAutomationVisible()
                              ? "border-red-400 bg-red-500/90 text-black"
                              : "border-border bg-timeline-surface-muted text-red-300 hover:bg-red-500/20",
                          )}
                          onClick={(event) => {
                            event.stopPropagation();
                            props.automation.actions.toggleTrackVisibility(track.id);
                          }}
                          title={displayedAutomationVisible() ? "Hide automation lane" : "Show automation lane"}
                        >
                          A
                        </button>
                        <button
                          class={cn(
                            "h-7 border text-xs font-semibold transition-colors",
                            canAddAutomationLane()
                              ? "border-border bg-timeline-surface-muted text-red-200 hover:bg-red-500/20"
                              : "cursor-not-allowed border-border bg-timeline-surface text-muted-foreground",
                          )}
                          disabled={!canAddAutomationLane()}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (!canAddAutomationLane()) return;
                            props.automation.actions.addTrackLane(track.id);
                          }}
                          title={displayedAutomationVisible() ? "Add another automation lane" : "Show automation with A before adding lanes"}
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
                            props.automation.actions.selectParameter(track.id, "volume");
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
                              <div class="relative h-full w-1 overflow-hidden bg-timeline-background/70">
                                <div
                                  class={cn(
                                    "absolute bottom-0 w-full transition-all duration-75",
                                    leftColor,
                                  )}
                                  style={{ height: `${left * 100}%` }}
                                />
                              </div>
                              <div class="relative h-full w-1 overflow-hidden bg-timeline-background/70">
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
                  </Show>
                </div>
                {displayedAutomationVisible() ? (
                  <div
                    class="absolute inset-x-0 z-10 border-t border-automation/30 bg-timeline-background/95 text-[11px] text-error-foreground"
                    style={{ top: `${clipLaneHeightPx()}px`, height: `${automationTotalHeight()}px` }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div
                      class="absolute inset-x-0 top-0 h-2 -translate-y-1/2 cursor-row-resize"
                      onPointerDown={(event) => startAutomationResize(track.id, automationHeight(), event)}
                    />
                    <For each={visibleAutomationParameterIds()}>
                      {(parameterId) => {
                        const targetKey = () => automationTargetKey({ kind: "track", trackId: track.id }, parameterId);
                        const envelope = () => props.automation.envelopes.byTargetKey.get(targetKey());
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
                                props.automation.actions.hideTrackLane(track.id, parameterId);
                                props.automation.actions.showTrackLane(track.id, nextParameterId);
                                props.automation.actions.selectParameter(track.id, nextParameterId);
                              }}
                            />
                            <div class="flex items-center justify-end gap-2 text-red-200/70">
                              <span class="truncate">{envelope()?.points.length ?? 0} pts</span>
                              <button
                                type="button"
                                class="h-5 w-5 border border-automation/30 text-error-foreground hover:border-red-400"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  props.automation.actions.hideTrackLane(track.id, parameterId);
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
          automation={{
            visible: props.automation.lanes.masterVisible,
            heightPx: props.automation.lanes.masterHeight,
            selectedParameterId: props.automation.lanes.selectedParametersByTargetKey.master ?? "volume",
            automatedParameterIds: masterAutomationMeta().automatedParameterIds,
            selectedEnvelope: masterAutomationMeta().selectedEnvelope,
            onToggleVisibility: props.automation.actions.toggleMasterVisibility,
            onResizeLane: props.automation.actions.resizeMasterLane,
            onSelectParameter: (parameterId) => props.automation.actions.selectParameter("master", parameterId),
          }}
        />
      </div>
    </>
  );
};

export default TrackSidebar;
