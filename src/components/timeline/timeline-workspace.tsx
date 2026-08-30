import {
  createMemo,
  createSignal,
  For,
  Show,
  onCleanup,
  onMount,
  type Accessor,
  type Component,
  type JSX,
} from "solid-js";
import GridOverlay from "~/components/timeline/GridOverlay";
import TimelineRuler from "~/components/timeline/TimelineRuler";
import ArrangementOverview from "~/components/timeline/ArrangementOverview";
import TrackLane from "~/components/timeline/TrackLane";
import type { ClipContextMenuActions } from "~/components/timeline/ClipComponent";
import {
  masterAreaHeight,
  masterRowHeight,
  type MasterSidebarModel,
} from "~/components/timeline/MasterSidebarRow";
import TrackSidebar from "~/components/timeline/TrackSidebar";
import AutomationLane from "~/components/timeline/automation-lane";
import { TimelineLeftBrowser } from "~/components/timeline/browser/timeline-left-browser";
import type { TimelineLeftBrowserModel } from "~/components/timeline/browser/browser-types";
import TimelineOverlays from "~/components/timeline/timeline-overlays";
import type { TimelineMidiBounds } from "~/lib/timeline-midi-bounds";
import {
  DEFAULT_AUTOMATION_LANE_HEIGHT,
  LANE_HEIGHT,
  TIMELINE_HEADER_HEIGHT,
} from "~/lib/timeline-utils";
import type { AudioEngine } from "@daw-browser/audio-engine/audio-engine";
import type { TimelineSelectionController } from "~/hooks/useTimelineSelectionState";
import type {
  Clip,
  Track,
  TrackId,
  TrackSend,
} from "@daw-browser/timeline-core/types";
import type { TimelineTrackIndex } from "@daw-browser/timeline-core/track-index";
import type { RuntimeTrack } from "~/lib/timeline-runtime-types";
import type { ClipFades } from "@daw-browser/timeline-core/clip-fades";
import { automationTargetKey, createAutomationTarget } from "@daw-browser/shared";
import type { TimelineWorkspaceAutomationModel } from "~/hooks/useTimelineAutomationController";
import TimelineContextMenu, {
  type TimelineContextMenuItem,
} from "./context-menu/timeline-context-menu";
import {
  buildGroupClipOverview,
  type TimelineTrackLayout,
  type TimelineTrackLayoutRow,
} from "~/lib/timeline-track-layout";
import type { TrackDropTarget } from "~/lib/track-group-ops";

const createViewportRedrawVersion = () => {
  const [version, setVersion] = createSignal(0);
  const requestRedraw = () => setVersion((value) => value + 1);

  onMount(() => {
    requestRedraw();
    window.addEventListener("resize", requestRedraw);
    window.visualViewport?.addEventListener("resize", requestRedraw);

    let dprQuery: MediaQueryList | undefined;
    let dprListener: (() => void) | undefined;
    const bindDprListener = () => {
      if (dprQuery && dprListener)
        dprQuery.removeEventListener("change", dprListener);
      dprQuery = window.matchMedia(
        `(resolution: ${window.devicePixelRatio}dppx)`,
      );
      dprListener = () => {
        requestRedraw();
        bindDprListener();
      };
      dprQuery.addEventListener("change", dprListener);
    };
    bindDprListener();

    onCleanup(() => {
      window.removeEventListener("resize", requestRedraw);
      window.visualViewport?.removeEventListener("resize", requestRedraw);
      if (dprQuery && dprListener)
        dprQuery.removeEventListener("change", dprListener);
    });
  });

  return version;
};

type Props = {
  containerRef: (el: HTMLDivElement) => void;
  scrollRef: (el: HTMLDivElement) => void;
  returnSectionRef: (el: HTMLDivElement) => void;
  masterTimelineRef: (el: HTMLDivElement) => void;
  timelineSurfaceRef: (el: HTMLDivElement) => void;
  bottomPanelOffsetPx: number;
  leftBrowser: TimelineLeftBrowserModel;
  durationSec: number;
  pixelsPerSecond: number;
  viewport: {
    visibleRange: { startSec: number; endSec: number };
    width: number;
    previewVisibleRange: (range: { startSec: number; endSec: number }) => void;
    commitVisibleRange: (range: { startSec: number; endSec: number }) => void;
    onWheel: (event: WheelEvent) => void;
  };
  sidebarWidth: number;
  tracks: RuntimeTrack[];
  dropAtNewTrack: boolean;
  dropTargetLane: number | null;
  browserDropTargetTrackId: Track["id"] | null;
  bpm: number;
  gridDenominator: number;
  gridEnabled: boolean;
  loopEnabled: boolean;
  loopStartSec: number;
  loopEndSec: number;
  playheadSec: number;
  onSetLoopRegion: (startSec: number, endSec: number) => void;
  onLanePointerDown: JSX.EventHandler<HTMLDivElement, PointerEvent>;
  onReturnPointerDown: JSX.EventHandler<HTMLDivElement, PointerEvent>;
  onMasterPointerDown: JSX.EventHandler<HTMLDivElement, PointerEvent>;
  onRulerPointerDown: (event: PointerEvent) => void;
  selection: TimelineSelectionController;
  onClipPointerDown: (
    trackId: Track["id"],
    clipId: string,
    event: PointerEvent,
  ) => void;
  onClipPointerUp: (
    trackId: Track["id"],
    clipId: string,
    event: PointerEvent,
  ) => void;
  onClipResizeStart: (
    trackId: Track["id"],
    clipId: string,
    edge: "left" | "right",
    event: PointerEvent,
  ) => void;
  canEditClipFades: (clipId: string) => boolean;
  onCommitClipFades: (clipId: string, fades: ClipFades, baseline: ClipFades) => void;
  onAddMidiClipToTrack?: (trackId: Track["id"]) => void;
  onDeleteTrack: (trackId: Track["id"]) => void;
  clipContextMenu: ClipContextMenuActions;
  ensureClipBuffer: (clipId: string, sampleUrl?: string) => Promise<void>;
  replaceMissingMediaClip: (
    trackId: Track["id"],
    clipId: string,
  ) => Promise<void>;
  removeMissingMediaClip: (
    trackId: Track["id"],
    clipId: string,
  ) => Promise<void>;
  trackLookup: TimelineTrackIndex<AudioBuffer>;
  openMidiEditorFor: (clipId: string) => void;
  openSampleDetailFor: (clipId: string) => void;
  marqueeRect: { x: number; y: number; width: number; height: number } | null;
  marqueeSurface: "scrolling" | "return" | null;
  recording: {
    isRecording: boolean;
    previewStartSec: number | null;
    previewPoints: Array<{ offset: number; amplitude: number }>;
    recordingTrackId: TrackId | null;
    recordArmTrackId: TrackId | null;
  };
  midi: {
    clipId: string | null;
    card: TimelineMidiBounds;
    userId: string;
    projectId: string;
    canWrite: boolean;
    close: () => void;
    changeBounds: (bounds: TimelineMidiBounds) => void;
    auditionNote: (trackId: string, note: number, velocity?: number, durSec?: number) => void;
    keyboard: {
      isActive: (pitch: number) => boolean;
    };
    onLocalMidiSaved: (clipId: string, midi: Clip["midi"]) => void;
  };
  sidebar: {
    currentUserId: string;
    master: MasterSidebarModel;
    subscribeTrackLevels: AudioEngine["subscribeTrackStereoLevels"];
    subscribeMasterLevels: AudioEngine["subscribeMasterStereoLevels"];
    canWriteTrackRouting: (trackId: Track["id"]) => boolean;
    onTrackClick: (trackId: Track["id"]) => void;
    onTrackSendsChange: (trackId: Track["id"], sends: TrackSend[]) => void;
    onTrackOutputTargetChange: (
      trackId: Track["id"],
      outputTargetId?: Track["id"],
    ) => void;
    onVolumePreview: (
      trackId: Track["id"],
      volume: number,
      muted: boolean,
    ) => void;
    onVolumeChange: (trackId: Track["id"], volume: number) => void;
    onToggleMute: (trackId: Track["id"]) => void;
    onToggleSolo: (trackId: Track["id"]) => void;
    onSidebarPointerDown: (event: PointerEvent) => void;
    onToggleRecordArm: (trackId: Track["id"]) => void;
    onDeleteTrack: (trackId: Track["id"]) => void;
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
  };
  automation: TimelineWorkspaceAutomationModel;
  trackLayout: TimelineTrackLayout;
};

export default function TimelineWorkspace(props: Props) {
  let scrollElement: HTMLDivElement | undefined;
  const viewportRedrawVersion = createViewportRedrawVersion();
  const trackById = createMemo(() => props.trackLookup.trackById);
  const visibleTracks = createMemo(() =>
    [
      ...props.trackLayout.scrollingRows,
      ...props.trackLayout.returnRows,
    ].flatMap((row) => {
      const track = trackById().get(row.trackId);
      return track ? [track] : [];
    }),
  );
  const selectedTrackIds = createMemo(() => {
    const range = props.selection.rangeSelection();
    if (range) return range.trackIds;
    const selectedTrackId = props.selection.selectedTrackId();
    return selectedTrackId ? [selectedTrackId] : [];
  });
  const groupClipOverviewByTrackId = createMemo(() => {
    const overviews = new Map<
      Track["id"],
      ReturnType<typeof buildGroupClipOverview>
    >();
    for (const track of props.tracks) {
      if (track.channelRole !== "group" || track.collapsed !== true) continue;
      overviews.set(track.id, buildGroupClipOverview(track.id, props.tracks));
    }
    return overviews;
  });
  const trackAreaHeight = () =>
    props.trackLayout.scrollingHeightPx +
    (props.dropAtNewTrack ? LANE_HEIGHT : 0);
  const masterAutomationVisible = () =>
    !props.sidebar.master.collapsed && props.automation.lanes.masterVisible;
  const masterBaseHeight = () =>
    masterRowHeight(props.sidebar.master.collapsed);
  const masterTotalHeight = () =>
    masterAreaHeight(
      props.sidebar.master.collapsed,
      props.automation.lanes.masterVisible,
      props.automation.lanes.masterHeight,
    );
  const returnAreaHeight = () => props.trackLayout.returnHeightPx;
  const stickyFooterHeight = () =>
    returnAreaHeight() + masterTotalHeight();
  const fullHeight = () =>
    TIMELINE_HEADER_HEIGHT + trackAreaHeight() + stickyFooterHeight();
  const scrollContentHeight = () => fullHeight() + props.bottomPanelOffsetPx;
  const masterSelection = () =>
    props.automation.lanes.selectedTargetsByOwnerKey.master ?? {
      parameterId: "volume",
    };
  const masterTarget = () =>
    createAutomationTarget({ kind: "master" }, masterSelection().effectInstanceId);
  const masterTargetKey = () =>
    automationTargetKey(masterTarget(), masterSelection().parameterId);
  const fallbackMenuItems = (): TimelineContextMenuItem[] => [
    { kind: "label", label: "Timeline" },
    {
      kind: "item",
      label: "Show master automation lane",
      disabled: props.automation.lanes.masterVisible,
      onSelect: props.automation.actions.toggleMasterVisibility,
    },
  ];
  const RenderTrackLane: Component<{
    row: TimelineTrackLayoutRow;
    layout: TimelineTrackLayoutRow;
    isDropTarget?: Accessor<boolean>;
  }> = (laneProps) => {
    const track = () => trackById().get(laneProps.row.trackId);
    const visibleTargetKeys = () =>
      props.automation.lanes.visibleTargetKeysByTrackId[laneProps.row.trackId] ?? [];
    const laneHeight = () =>
      props.automation.lanes.heightsByLaneOwnerKey[laneProps.row.trackId] ??
      DEFAULT_AUTOMATION_LANE_HEIGHT;
    return (
      <Show when={track()}>
        {(visibleTrack) => (
          <TrackLane
            track={visibleTrack()}
            groupClipOverview={
              groupClipOverviewByTrackId().get(laneProps.row.trackId) ?? []
            }
            layout={laneProps.layout}
            isDropTarget={laneProps.isDropTarget}
            selectedClipIds={props.selection.selectedClipIds()}
            rangeSelection={props.selection.rangeSelection()}
            onClipPointerDown={props.onClipPointerDown}
            onClipPointerUp={props.onClipPointerUp}
            onClipResizeStart={props.onClipResizeStart}
            canEditClipFades={props.canEditClipFades}
            onCommitClipFades={props.onCommitClipFades}
            onAddMidiClip={props.onAddMidiClipToTrack}
            onDeleteTrack={props.onDeleteTrack}
            clipContextMenu={props.clipContextMenu}
            onRetryMedia={(clipId) => {
              void props.ensureClipBuffer(clipId);
            }}
            onReplaceMedia={(trackId, clipId) => {
              void props.replaceMissingMediaClip(trackId, clipId);
            }}
            onRemoveMissingMedia={(trackId, clipId) => {
              void props.removeMissingMediaClip(trackId, clipId);
            }}
            ensureClipBuffer={props.ensureClipBuffer}
            bpm={props.bpm}
            pixelsPerSecond={props.pixelsPerSecond}
            viewportRedrawVersion={viewportRedrawVersion()}
            automation={{
              projectId: props.automation.projectId,
              visible:
                props.automation.lanes.visibleByTrackId[laneProps.row.trackId] === true,
              selections: visibleTargetKeys().flatMap((targetKey) => {
                const selection =
                  props.automation.lanes.selectionByTargetKey.get(targetKey);
                return selection ? [selection] : [];
              }),
              laneHeightPx: laneHeight(),
              envelopeForSelection: (selection) =>
                props.automation.envelopes.byTargetKey.get(
                  automationTargetKey(
                    createAutomationTarget(
                      { kind: "track", trackId: laneProps.row.trackId },
                      selection.effectInstanceId,
                    ),
                    selection.parameterId,
                  ),
                ),
              durationSec: props.durationSec,
              onPreview: props.automation.envelopes.preview,
              onCommit: props.automation.envelopes.commit,
              onCancelPreview: props.automation.envelopes.cancelPreview,
            }}
            onClipDblClick={(_, clipId) => {
              const match = props.trackLookup.clipEntryById.get(clipId);
              if (match?.clip.midi) {
                props.openMidiEditorFor(clipId);
                return;
              }
              props.openSampleDetailFor(clipId);
            }}
          />
        )}
      </Show>
    );
  };
  return (
    <div class="flex-1 flex min-h-0" ref={props.containerRef}>
      <div
        class="min-h-0 shrink-0"
        style={{ height: `calc(100% - ${props.bottomPanelOffsetPx}px)` }}
      >
        <TimelineLeftBrowser browser={props.leftBrowser} />
      </div>
      <TimelineContextMenu items={fallbackMenuItems}>
        <div
          class="flex-1 relative overflow-auto"
          ref={(element) => {
            scrollElement = element;
            props.scrollRef(element);
          }}
          onWheel={(event) => props.viewport.onWheel(event)}
        >
          <div
            class="relative flex select-none"
            style={{
              width: `${props.durationSec * props.pixelsPerSecond + props.sidebarWidth}px`,
              height: `${scrollContentHeight()}px`,
              "min-height": "100%",
            }}
          >
            <div
              class="relative flex shrink-0 flex-col"
              ref={props.timelineSurfaceRef}
              style={{
                width: `${props.durationSec * props.pixelsPerSecond}px`,
              }}
               onPointerDown={(event) => props.onLanePointerDown(event)}
            >
              <ArrangementOverview
                durationSec={props.durationSec}
                width={props.viewport.width}
                tracks={props.tracks}
                visibleRange={props.viewport.visibleRange}
                onPreviewVisibleRange={props.viewport.previewVisibleRange}
                onCommitVisibleRange={props.viewport.commitVisibleRange}
              />
              <TimelineRuler
                durationSec={props.durationSec}
                bpm={props.bpm}
                denom={props.gridDenominator}
                gridEnabled={props.gridEnabled}
                pixelsPerSecond={props.pixelsPerSecond}
                visibleRange={props.viewport.visibleRange}
                onPointerDown={props.onRulerPointerDown}
                loopEnabled={props.loopEnabled}
                loopStartSec={props.loopStartSec}
                loopEndSec={props.loopEndSec}
                onSetLoopRegion={props.onSetLoopRegion}
              />

              <div
                class="absolute left-0 right-0 bg-timeline-background"
                style={{
                  top: `${TIMELINE_HEADER_HEIGHT}px`,
                  bottom: `${props.bottomPanelOffsetPx}px`,
                }}
              >
                <For each={props.trackLayout.scrollingRows}>
                  {(row, i) => {
                    const isDropTarget = createMemo(
                      () =>
                        props.browserDropTargetTrackId === row.trackId ||
                        (props.browserDropTargetTrackId === null &&
                          props.dropTargetLane === i()),
                    );
                    return (
                      <RenderTrackLane
                        row={row}
                        layout={row}
                        isDropTarget={isDropTarget}
                      />
                    );
                  }}
                </For>
                <TimelineOverlays
                  timeline={{
                    tracks: props.tracks,
                    trackLookup: props.trackLookup,
                    durationSec: props.durationSec,
                    pixelsPerSecond: props.pixelsPerSecond,
                    bpm: props.bpm,
                    gridDenominator: props.gridDenominator,
                    gridEnabled: props.gridEnabled,
                    loopEnabled: props.loopEnabled,
                    loopStartSec: props.loopStartSec,
                    loopEndSec: props.loopEndSec,
                    playheadSec: props.playheadSec,
                    dropAtNewTrack: props.dropAtNewTrack,
                    marqueeRect:
                      props.marqueeSurface === "scrolling"
                        ? props.marqueeRect
                        : null,
                    rowLayouts: props.trackLayout.scrollingRows,
                    trackAreaHeight: trackAreaHeight(),
                    range: props.selection.rangeSelection(),
                  }}
                  recording={props.recording}
                  midi={props.midi}
                  effectInstancesByOwnerKey={props.automation.lanes.effectInstancesByOwnerKey}
                />
              </div>
              <div
                class="min-h-0 grow shrink-0"
                style={{ "min-height": `${trackAreaHeight()}px` }}
              />
              <div
                class="sticky z-30 box-border shrink-0 border-t border-neutral-800 bg-timeline-background"
                style={{
                  width: `${props.durationSec * props.pixelsPerSecond}px`,
                  height: `${stickyFooterHeight()}px`,
                  bottom: `${props.bottomPanelOffsetPx}px`,
                }}
              >
                <div
                  class="relative overflow-hidden bg-timeline-background"
                  ref={(element) => {
                    props.returnSectionRef(element);
                  }}
                  style={{ height: `${returnAreaHeight()}px` }}
                   onPointerDown={(event) => props.onReturnPointerDown(event)}
                >
                  <For each={props.trackLayout.returnRows}>
                    {(row) => {
                      const isDropTarget = createMemo(
                        () => props.browserDropTargetTrackId === row.trackId,
                      );
                      return (
                        <div
                        class="absolute left-0 right-0"
                        data-track-id={row.trackId}
                        style={{
                          top: `${row.topPx}px`,
                          height: `${row.heightPx}px`,
                        }}
                      >
                        <RenderTrackLane
                          row={row}
                          layout={{ ...row, topPx: 0 }}
                          isDropTarget={isDropTarget}
                        />
                      </div>
                      );
                    }}
                  </For>
                  <GridOverlay
                    durationSec={props.durationSec}
                    pixelsPerSecond={props.pixelsPerSecond}
                    bpm={props.bpm}
                    denom={props.gridDenominator}
                    enabled={props.gridEnabled}
                  />
                  <Show
                    when={
                      props.marqueeSurface === "return"
                        ? props.marqueeRect
                        : null
                    }
                  >
                    {(marquee) => (
                      <div
                        class="pointer-events-none absolute z-20 border border-blue-300/60 bg-blue-400/12"
                        style={{
                          left: `${marquee().x}px`,
                          top: `${marquee().y}px`,
                          width: `${marquee().width}px`,
                          height: `${marquee().height}px`,
                        }}
                      />
                    )}
                  </Show>
                  <Show when={props.selection.rangeSelection()}>
                    {(range) => (
                      <For
                        each={props.trackLayout.returnRows.filter((row) =>
                          range().trackIds.includes(row.trackId),
                        )}
                      >
                        {(row) => (
                          <div
                            class="absolute z-10 pointer-events-none bg-blue-400/12 border-x border-blue-300/30"
                            style={{
                              left: `${range().startSec * props.pixelsPerSecond}px`,
                              top: `${row.topPx}px`,
                              width: `${(range().endSec - range().startSec) * props.pixelsPerSecond}px`,
                              height: `${row.heightPx}px`,
                            }}
                          />
                        )}
                      </For>
                    )}
                  </Show>
                </div>
                <div ref={props.masterTimelineRef}>
                  <div
                    class="relative overflow-hidden bg-timeline-background"
                    style={{ height: `${masterBaseHeight()}px` }}
                     onPointerDown={(event) => props.onMasterPointerDown(event)}
                  >
                    <GridOverlay
                      durationSec={props.durationSec}
                      pixelsPerSecond={props.pixelsPerSecond}
                      bpm={props.bpm}
                      denom={props.gridDenominator}
                      enabled={props.gridEnabled}
                    />
                    <div class="absolute left-0 right-0 bottom-0 h-px bg-timeline-surface-muted" />
                  </div>
                  <Show when={masterAutomationVisible()}>
                    <div
                      class="border-t border-automation/30 bg-timeline-background/95"
                      style={{
                        height: `${props.automation.lanes.masterHeight}px`,
                      }}
                    >
                      <AutomationLane
                        projectId={props.automation.projectId}
                        target={masterTarget()}
                        parameterId={masterSelection().parameterId}
                        envelope={props.automation.envelopes.byTargetKey.get(
                          masterTargetKey(),
                        )}
                        durationSec={props.durationSec}
                        pixelsPerSecond={props.pixelsPerSecond}
                        heightPx={props.automation.lanes.masterHeight}
                        onPreview={props.automation.envelopes.preview}
                        onCommit={props.automation.envelopes.commit}
                        onCancelPreview={props.automation.envelopes.cancelPreview}
                      />
                    </div>
                  </Show>
                </div>
              </div>
              <div
                class="shrink-0"
                style={{ height: `${props.bottomPanelOffsetPx}px` }}
              />
            </div>

            <TrackSidebar
              sidebar={{
                tracks: visibleTracks(),
                allTracks: props.tracks,
                trackById: trackById(),
                trackLayout: props.trackLayout,
                scrollElement: () => scrollElement,
                selectedTrackId: props.selection.selectedTrackId(),
                selectedTrackIds: selectedTrackIds(),
                sidebarWidth: props.sidebarWidth,
                bottomOffsetPx: props.bottomPanelOffsetPx,
                stickyFooterHeightPx: stickyFooterHeight(),
                master: props.sidebar.master,
                recordArmTrackId: props.recording.recordArmTrackId,
                currentUserId: props.sidebar.currentUserId,
                subscribeTrackLevels: props.sidebar.subscribeTrackLevels,
                subscribeMasterLevels: props.sidebar.subscribeMasterLevels,
                onTrackClick: props.sidebar.onTrackClick,
                canWriteTrackRouting: props.sidebar.canWriteTrackRouting,
                onTrackSendsChange: props.sidebar.onTrackSendsChange,
                onTrackOutputTargetChange:
                  props.sidebar.onTrackOutputTargetChange,
                onVolumePreview: props.sidebar.onVolumePreview,
                onVolumeChange: props.sidebar.onVolumeChange,
                onToggleMute: props.sidebar.onToggleMute,
                onToggleSolo: props.sidebar.onToggleSolo,
                onSidebarPointerDown: props.sidebar.onSidebarPointerDown,
                onToggleRecordArm: props.sidebar.onToggleRecordArm,
                onDeleteTrack: props.sidebar.onDeleteTrack,
                onToggleTrackCollapsed: props.sidebar.onToggleTrackCollapsed,
                onSetTracksCollapsed: props.sidebar.onSetTracksCollapsed,
                onGroupTracks: props.sidebar.onGroupTracks,
                onUngroupTrack: props.sidebar.onUngroupTrack,
                onMoveTrackToGroup: props.sidebar.onMoveTrackToGroup,
                onReorderTracks: props.sidebar.onReorderTracks,
                onSetTrackColor: props.sidebar.onSetTrackColor,
                onResetTrackColor: props.sidebar.onResetTrackColor,
                onAssignTrackColorToClips:
                  props.sidebar.onAssignTrackColorToClips,
                onResetClipColors: props.sidebar.onResetClipColors,
                onSelectAllClipsInGroup:
                  props.sidebar.onSelectAllClipsInGroup,
              }}
              automation={props.automation}
            />
          </div>
        </div>
      </TimelineContextMenu>
    </div>
  );
}
