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
import {
  assert,
  automationEnvelopeValueRange,
  automationTargetKey,
  type AutomationEnvelope,
} from "@daw-browser/shared";
import {
  getTrackChannelRole,
} from "@daw-browser/timeline-core/track-routing";
import { TIMELINE_SIDEBAR_MIN_WIDTH } from "~/lib/timeline-layout";
import {
  normalizeDragMoveSet,
  resolveTrackDropZone,
  type TrackDropTarget,
} from "~/lib/track-group-ops";
import {
  ARRANGEMENT_OVERVIEW_HEIGHT,
  GROUP_INDENT_PX,
  TIMELINE_HEADER_HEIGHT,
  clientYToTimelineTrackY,
  clampAutomationLaneHeight,
} from "~/lib/timeline-utils";
import { cn } from "~/lib/utils";
import type { Track, TrackSend } from "@daw-browser/timeline-core/types";
import type { TimelineWorkspaceAutomationModel } from "~/hooks/useTimelineAutomationController";
import {
  trackLayoutRowAtY,
  type TimelineTrackLayout,
} from "~/lib/timeline-track-layout";
import MasterSidebarRow, {
  type MasterSidebarModel,
} from "~/components/timeline/MasterSidebarRow";
import { useAppPreferences } from "~/context/app-preferences";
import {
  TIMELINE_DEFAULT_GROUP_COLOR,
  TIMELINE_DEFAULT_TRACK_COLOR,
} from "~/lib/preferences/app-preferences";
import {
  getReturnSendTargets,
  resolveSendTargetId,
} from "./track-send-targets";
import TrackSidebarRow from "./TrackSidebarRow";

export type TrackSidebarProps = {
  sidebar: {
    tracks: Track[];
    allTracks: Track[];
    trackById: ReadonlyMap<string, Track>;
    trackLayout: TimelineTrackLayout;
    scrollElement: () => HTMLDivElement | undefined;
    selectedTrackId: Track["id"] | "";
    selectedTrackIds: readonly Track["id"][];
    sidebarWidth: number;
    bottomOffsetPx: number;
    stickyFooterHeightPx: number;
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
    onSetTracksCollapsed: (
      updates: Array<{ trackId: Track["id"]; collapsed: boolean }>,
    ) => void;
    onGroupTracks: (trackIds: Track["id"][]) => void;
    onUngroupTrack: (groupId: Track["id"]) => void;
    onMoveTrackToGroup: (
      trackId: Track["id"],
      groupId: Track["id"] | undefined,
    ) => void;
    onReorderTracks: (trackIds: Track["id"][], target: TrackDropTarget) => void;
    onSetTrackColor: (trackId: Track["id"], color: string | undefined) => void;
    onResetTrackColor: (trackId: Track["id"]) => void;
    onAssignTrackColorToClips: (trackId: Track["id"]) => void;
    onResetClipColors: (trackId: Track["id"]) => void;
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

export type TrackSidebarModel = TrackSidebarProps["sidebar"];

const clampUnit = (value: number) => Math.max(0, Math.min(1, value));
const METER_SILENCE_FLOOR = 0.005;
const displayMeterLevel = (value: number | undefined) => {
  const clamped = clampUnit(value ?? 0);
  return clamped > METER_SILENCE_FLOOR ? clamped : 0;
};
const clampVolume = (volume: number) => clampUnit(volume);
const quantizeVolume = (volume: number) =>
  Math.round(clampVolume(volume) * 100) / 100;
const isBulkCollapseModifier = (event: MouseEvent | PointerEvent) =>
  event.metaKey || event.altKey;
const TrackSidebar: Component<TrackSidebarProps> = (props) => {
  const sidebar = () => props.sidebar;
  const appPreferences = useAppPreferences();

  const [meters, setMeters] = createStore<Record<string, TrackStereoLevels>>(
    {},
  );
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
    moveTrackIds: Track["id"][];
    dragging: boolean;
    target?: TrackDropTarget;
  }>();
  const [suppressTrackClickId, setSuppressTrackClickId] =
    createSignal<Track["id"]>();
  let cleanupAutomationResize: (() => void) | undefined;
  let returnSectionElement: HTMLDivElement | undefined;

  createEffect(() => {
    const unsubscribe = sidebar().subscribeTrackLevels((levelsByTrackId) => {
      setMeters(
        produce((current) => {
          for (const [trackId, levels] of levelsByTrackId) {
            const next = {
              left: clampUnit(levels.left),
              right: clampUnit(levels.right),
            };
            const previous = current[trackId];
            if (previous?.left === next.left && previous.right === next.right)
              continue;
            current[trackId] = next;
          }
        }),
      );
    });
    onCleanup(unsubscribe);
  });

  createEffect(() => {
    const trackIds = new Set<string>(
      sidebar().allTracks.map((track) => track.id),
    );
    setMeters(
      produce((current) => {
        for (const trackId of Object.keys(current)) {
          if (!trackIds.has(trackId)) delete current[trackId];
        }
      }),
    );
  });

  const groupTracks = createMemo(() =>
    sidebar().allTracks.filter(
      (track) => getTrackChannelRole(track) === "group",
    ),
  );
  const groupTrackNames = createMemo(
    () =>
      new Map<string, string>(
        groupTracks().map((track, index) => [
          track.id,
          track.name || `Group ${index + 1}`,
        ]),
      ),
  );
  const allTrackLayout = createMemo(() => [
    ...sidebar().trackLayout.scrollingRows,
    ...sidebar().trackLayout.returnRows,
  ]);
  const depthByTrackId = createMemo(
    () => new Map(allTrackLayout().map((row) => [row.trackId, row.depth])),
  );
  const layoutByTrackId = createMemo(
    () => new Map(allTrackLayout().map((row) => [row.trackId, row])),
  );
  const visibleTrackIds = createMemo(
    () => new Set(allTrackLayout().map((row) => row.trackId)),
  );
  const scrollingTracks = createMemo(() =>
    sidebar().tracks.filter((track) => getTrackChannelRole(track) !== "return"),
  );
  const visibleReturnTracks = createMemo(() =>
    sidebar().trackLayout.returnRows.flatMap((row) => {
      const track = sidebar().trackById.get(row.trackId);
      return track ? [track] : [];
    }),
  );
  const defaultGroupColor = () => appPreferences.timeline.defaultGroupColor();
  const resolveGroupColor = (color: string | undefined) => {
    if (
      color === TIMELINE_DEFAULT_GROUP_COLOR ||
      color === TIMELINE_DEFAULT_TRACK_COLOR
    )
      return defaultGroupColor();
    return color ?? defaultGroupColor();
  };
  const ancestorGroupColorBandsByTrackId = createMemo(() => {
    const bandsByTrackId = new Map<
      Track["id"],
      Array<{ trackId: Track["id"]; leftPx: number; color: string }>
    >();
    const trackById = sidebar().trackById;
    const depths = depthByTrackId();
    for (const track of sidebar().tracks) {
      const bands: Array<{
        trackId: Track["id"];
        leftPx: number;
        color: string;
      }> = [];
      let groupId = track.groupId;
      while (groupId) {
        const group = trackById.get(groupId);
        if (!group) break;
        bands.push({
          trackId: group.id,
          leftPx: (depths.get(group.id) ?? 0) * GROUP_INDENT_PX,
          color: resolveGroupColor(group.color),
        });
        groupId = group.groupId;
      }
      bandsByTrackId.set(track.id, bands);
    }
    return bandsByTrackId;
  });
  const returnTracks = createMemo(() =>
    getReturnSendTargets(sidebar().allTracks),
  );
  const returnTrackNames = createMemo(
    () =>
      new Map<string, string>(
        returnTracks().map((track, index) => [
          track.id,
          track.name || `Return ${index + 1}`,
        ]),
      ),
  );
  const displayTrackName = (track: Track) =>
    groupTrackNames().get(track.id) ??
    returnTrackNames().get(track.id) ??
    track.name;
  const automationMetaByTrackId = createMemo(() => {
    const byTrackId = new Map<
      string,
      {
        automatedTargetKeys: ReadonlySet<string>;
        volumeRange?: { min: number; max: number };
        volumeEnvelope?: AutomationEnvelope;
      }
    >();
    const mutable = new Map<
      string,
      {
        automatedTargetKeys: Set<string>;
        volumeRange?: { min: number; max: number };
        volumeEnvelope?: AutomationEnvelope;
      }
    >();
    for (const envelope of props.automation.envelopes.byTargetKey.values()) {
      if (envelope.target.kind !== "track") continue;
      const existing = mutable.get(envelope.target.trackId) ?? {
        automatedTargetKeys: new Set<string>(),
      };
      existing.automatedTargetKeys.add(envelope.targetKey);
      if (
        envelope.parameterId === "volume" &&
        envelope.target.effectInstanceId === undefined
      ) {
        existing.volumeEnvelope = envelope;
        existing.volumeRange = automationEnvelopeValueRange(envelope, {
          min: 0,
          max: 1,
        });
      }
      mutable.set(envelope.target.trackId, existing);
    }
    for (const [trackId, meta] of mutable) {
      byTrackId.set(trackId, meta);
    }
    return byTrackId;
  });
  const masterAutomationMeta = createMemo<{
    automatedTargetKeys: Set<string>;
    selectedEnvelope: AutomationEnvelope | undefined;
  }>(() => {
    const meta: {
      automatedTargetKeys: Set<string>;
      selectedEnvelope: AutomationEnvelope | undefined;
    } = {
      automatedTargetKeys: new Set<string>(),
      selectedEnvelope: undefined,
    };
    const selected = props.automation.lanes.selectedTargetsByOwnerKey
      .master ?? { parameterId: "volume" };
    const selectedTargetKey = automationTargetKey(
      { kind: "master", effectInstanceId: selected.effectInstanceId },
      selected.parameterId,
    );
    for (const envelope of props.automation.envelopes.byTargetKey.values()) {
      if (envelope.target.kind !== "master") continue;
      meta.automatedTargetKeys.add(envelope.targetKey);
      if (envelope.targetKey === selectedTargetKey)
        meta.selectedEnvelope = envelope;
    }
    return meta;
  });
  const returnAreaHeight = () => {
    return sidebar().trackLayout.returnHeightPx;
  };
  const scrollingDragTarget = () => {
    const drag = trackDrag();
    if (!drag?.dragging || !drag.target) return undefined;
    const targetTrack = sidebar().trackById.get(drag.target.trackId);
    if (!targetTrack) return undefined;
    return getTrackChannelRole(targetTrack) === "return"
      ? undefined
      : drag.target;
  };
  const returnDragTarget = () => {
    const drag = trackDrag();
    if (!drag?.dragging || !drag.target) return undefined;
    const targetTrack = sidebar().trackById.get(drag.target.trackId);
    if (!targetTrack) return undefined;
    return getTrackChannelRole(targetTrack) === "return"
      ? drag.target
      : undefined;
  };
  const actualOutputTargetId = (track: Track) => track.outputTargetId ?? "";
  const selectedOutputTargetId = (track: Track) =>
    selectedOutputTargets().get(track.id) ?? actualOutputTargetId(track);
  const outputTargetName = (track: Track) =>
    groupTrackNames().get(selectedOutputTargetId(track)) ?? "Master";
  const actualSendTargetId = (track: Track) => {
    const targetId =
      track.sends?.find((send) => send.amount > 0.0001)?.targetId ?? "";
    return resolveSendTargetId(targetId, undefined, returnTracks());
  };
  const selectedSendTargetId = (track: Track) =>
    resolveSendTargetId(
      actualSendTargetId(track),
      selectedSendTargets().get(track.id),
      returnTracks(),
    );
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
      sidebar()
        .allTracks.filter((candidate) => candidate.collapsed !== collapsed)
        .map((candidate) => ({ trackId: candidate.id, collapsed })),
    );
  };

  const dropTargetAt = (
    clientY: number,
    movingReturns: boolean,
  ): TrackDropTarget | undefined => {
    const returnSection = returnSectionElement;
    if (returnSection) {
      const rect = returnSection.getBoundingClientRect();
      if (clientY >= rect.top && clientY < rect.bottom) {
        if (!movingReturns) return undefined;
        const row = trackLayoutRowAtY(
          sidebar().trackLayout.returnRows,
          clientY - rect.top,
        );
        if (!row) return undefined;
        return {
          trackId: row.trackId,
          zone: resolveTrackDropZone({
            localY: clientY - rect.top - row.topPx,
            rowHeightPx: row.heightPx,
            targetIsGroup: false,
          }),
        };
      }
    }
    if (movingReturns) return undefined;
    const scrollElement = sidebar().scrollElement();
    if (!scrollElement) return undefined;
    const localY = clientYToTimelineTrackY(clientY, scrollElement);
    const row = trackLayoutRowAtY(sidebar().trackLayout.scrollingRows, localY);
    if (!row) return undefined;
    const track = sidebar().trackById.get(row.trackId);
    assert(
      track,
      `Timeline layout row references missing track ${row.trackId}`,
    );
    return {
      trackId: row.trackId,
      zone: resolveTrackDropZone({
        localY: localY - row.topPx,
        rowHeightPx: row.heightPx,
        targetIsGroup: getTrackChannelRole(track) === "group",
      }),
    };
  };

  const isTrackDragBlockedTarget = (target: EventTarget | null) =>
    target instanceof Element &&
    Boolean(
      target.closest(
        "button, input, select, textarea, [role='button'], [data-track-drag-block]",
      ),
    );

  const startTrackDrag = (trackId: Track["id"], event: PointerEvent) => {
    if (event.button !== 0) return;
    const selectedTrackIds = sidebar().selectedTrackIds;
    const trackAlreadySelected = selectedTrackIds.includes(trackId);
    const movingReturns =
      sidebar().trackById.get(trackId)?.channelRole === "return";
    const activeSelection = trackAlreadySelected
      ? selectedTrackIds.filter(
          (selectedTrackId) =>
            visibleTrackIds().has(selectedTrackId) &&
            (sidebar().trackById.get(selectedTrackId)?.channelRole ===
              "return") ===
              movingReturns,
        )
      : [trackId];
    if (!trackAlreadySelected) {
      sidebar().onTrackClick(trackId);
    }
    if (event.currentTarget instanceof HTMLElement) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setTrackDrag({
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      trackId,
      moveTrackIds: normalizeDragMoveSet(
        sidebar().allTracks,
        new Set([...activeSelection, trackId]),
      ),
      dragging: false,
    });
  };

  const updateTrackDrag = (event: PointerEvent) => {
    const drag = trackDrag();
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dragging =
      drag.dragging ||
      Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4;
    const movingTrack = sidebar().trackById.get(drag.trackId);
    const target =
      dragging && movingTrack
        ? dropTargetAt(
            event.clientY,
            getTrackChannelRole(movingTrack) === "return",
          )
        : undefined;
    if (
      drag.dragging === dragging &&
      drag.target?.trackId === target?.trackId &&
      drag.target?.zone === target?.zone
    )
      return;
    setTrackDrag({ ...drag, dragging, target });
  };

  const finishTrackDrag = (event: PointerEvent) => {
    const drag = trackDrag();
    if (!drag || drag.pointerId !== event.pointerId) return;
    setTrackDrag(undefined);
    if (
      event.currentTarget instanceof HTMLElement &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag.dragging || !drag.target) return;
    setSuppressTrackClickId(drag.trackId);
    sidebar().onReorderTracks(drag.moveTrackIds, drag.target);
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
    const returnTrack = returnTracks().find(
      (candidate) => candidate.id === targetId,
    );
    if (targetId && !returnTrack) {
      setSelectedSendTargets((current) => {
        if (!current.has(track.id)) return current;
        const next = new Map(current);
        next.delete(track.id);
        return next;
      });
      return;
    }
    const nextTargetId = returnTrack?.id ?? "";
    setSelectedSendTargets((current) =>
      current.get(track.id) === nextTargetId
        ? current
        : new Map(current).set(track.id, nextTargetId),
    );
    const existingSends = track.sends ?? [];
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
    if (active?.trackId === track.id) return active.value;
    return (
      props.automation
        .evaluatedValuesByTargetKey()
        .get(
          automationTargetKey({ kind: "track", trackId: track.id }, "volume"),
        ) ??
      track.volume ??
      0.8
    );
  };
  const trackVolumeAutomationTargetKey = (trackId: Track["id"]) =>
    automationTargetKey({ kind: "track", trackId }, "volume");

  const previewTrackVolume = (track: Track, volume: number) => {
    const nextVolume = quantizeVolume(volume);
    setActiveVolumeDrag((active) => {
      if (!active || active.trackId !== track.id || active.value === nextVolume)
        return active;
      return { ...active, value: nextVolume };
    });
    sidebar().onVolumePreview(track.id, nextVolume, !!track.muted);
  };

  const commitTrackVolume = (
    trackId: Track["id"],
    volume: number,
    previousVolume: number,
  ) => {
    if (volume === previousVolume) return;
    sidebar().onVolumeChange(trackId, volume);
  };

  const startAutomationResize = (
    trackId: Track["id"],
    startHeight: number,
    event: PointerEvent,
  ) => {
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
      if (cleanupAutomationResize === cleanup)
        cleanupAutomationResize = undefined;
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
    <div
      class="sticky right-0 z-40 relative flex shrink-0 flex-col overflow-x-clip border-l border-border bg-timeline-surface p-0"
      style={{
        width: `${sidebar().sidebarWidth}px`,
        "min-width": `${TIMELINE_SIDEBAR_MIN_WIDTH}px`,
      }}
    >
      <div
        class="absolute inset-y-0 left-0 z-40 w-4 -translate-x-1/2 cursor-col-resize"
        onPointerDown={(event) => sidebar().onSidebarPointerDown(event)}
      >
        <div class="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-muted" />
      </div>

      <div class="sticky top-0 z-40 bg-timeline-surface">
        <div
          class="pointer-events-none border-b border-border"
          style={{ height: `${ARRANGEMENT_OVERVIEW_HEIGHT}px` }}
        />
        <div
          class="border-b border-border"
          style={{
            height: `${TIMELINE_HEADER_HEIGHT - ARRANGEMENT_OVERVIEW_HEIGHT}px`,
          }}
        />
      </div>
      <Show when={scrollingDragTarget()}>
          {(target) => {
            const row = () => layoutByTrackId().get(target().trackId);
            const top = () => {
              const current = row();
              if (!current) return TIMELINE_HEADER_HEIGHT;
              if (target().zone === "below")
                return TIMELINE_HEADER_HEIGHT + current.topPx + current.heightPx;
              return TIMELINE_HEADER_HEIGHT + current.topPx;
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
                  top:
                    target().zone === "inside"
                      ? `${top() + 12}px`
                      : `${top()}px`,
                  left: `${8 + (row()?.depth ?? 0) * GROUP_INDENT_PX}px`,
                  right: "8px",
                }}
              />
            );
          }}
      </Show>
      {(() => {
          const renderTrackRow = (track: Track) => (
            <TrackSidebarRow
              track={track}
              model={{
                sidebar,
                automation: () => props.automation,
                automationMetaByTrackId,
                appPreferences,
                depthByTrackId,
                layoutByTrackId,
                ancestorGroupColorBandsByTrackId,
                defaultGroupColor,
                resolveGroupColor,
                displayTrackName,
                outputTargetName,
                sendTargetName,
                groupTracks,
                canWriteTrackRouting,
                selectedOutputTargetId,
                selectedSendTargetId,
                returnTracks,
                handleTrackCollapseClick,
                isTrackDragBlockedTarget,
                startTrackDrag,
                updateTrackDrag,
                finishTrackDrag,
                cancelTrackDrag,
                suppressTrackClickId,
                setSuppressTrackClickId,
                meters,
                displayVolume,
                displayMeterLevel,
                quantizeVolume,
                trackVolumeAutomationTargetKey,
                previewTrackVolume,
                commitTrackVolume,
                activeVolumeDrag,
                setActiveVolumeDrag,
                updateVolumeFromPointer,
                releaseVolumePointerCapture,
                startAutomationResize,
                handleOutputTargetChange,
                handleSendTargetChange,
              }}
            />
          );
          return (
            <>
              <For each={scrollingTracks()}>{renderTrackRow}</For>
              <div class="min-h-6 flex-1 shrink-0" />
              <div
                class="sticky z-40 box-border shrink-0 border-t border-border bg-timeline-surface"
                ref={(element) => {
                  returnSectionElement = element;
                }}
                style={{
                  bottom: `${sidebar().bottomOffsetPx}px`,
                  height: `${sidebar().stickyFooterHeightPx}px`,
                }}
              >
                <div
                  class="relative overflow-hidden"
                  style={{
                    height: `${returnAreaHeight()}px`,
                  }}
                >
                  <For each={visibleReturnTracks()}>{renderTrackRow}</For>
                  <Show when={returnDragTarget()}>
                    {(target) => {
                      const row = () => layoutByTrackId().get(target().trackId);
                      const top = () => {
                        const current = row();
                        if (!current) return 0;
                        return target().zone === "below"
                          ? current.topPx + current.heightPx
                          : current.topPx;
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
                            top:
                              target().zone === "inside"
                                ? `${top() + 12}px`
                                : `${top()}px`,
                            left: "8px",
                            right: "8px",
                          }}
                        />
                      );
                    }}
                  </Show>
                </div>
                <MasterSidebarRow
                  master={sidebar().master}
                  automation={{
                    visible: props.automation.lanes.masterVisible,
                    heightPx: props.automation.lanes.masterHeight,
                    selected: props.automation.lanes.selectedTargetsByOwnerKey
                      .master ?? { parameterId: "volume" },
                    effects:
                      props.automation.lanes.effectInstancesByOwnerKey.master ??
                      [],
                    automatedTargetKeys:
                      masterAutomationMeta().automatedTargetKeys,
                    selectedEnvelope: masterAutomationMeta().selectedEnvelope,
                    evaluatedValuesByTargetKey:
                      props.automation.evaluatedValuesByTargetKey(),
                    onToggleVisibility:
                      props.automation.actions.toggleMasterVisibility,
                    onResizeLane: props.automation.actions.resizeMasterLane,
                    onSelectParameter: (selection) =>
                      props.automation.actions.selectParameter(
                        "master",
                        selection,
                      ),
                    onManualAutomationOverride: () =>
                      props.automation.actions.overrideTarget(
                        automationTargetKey({ kind: "master" }, "volume"),
                      ),
                  }}
                />
              </div>
            </>
          );
      })()}
    </div>
  );
};

export default TrackSidebar;
