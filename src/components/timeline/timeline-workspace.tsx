import { createSignal, For, onCleanup, onMount, type JSX } from "solid-js";
import TimelineRuler from "~/components/timeline/TimelineRuler";
import TrackLane from "~/components/timeline/TrackLane";
import type { MasterSidebarModel } from "~/components/timeline/MasterSidebarRow";
import TrackSidebar from "~/components/timeline/TrackSidebar";
import { TimelineLeftBrowser } from "~/components/timeline/browser/timeline-left-browser";
import type { TimelineLeftBrowserModel } from "~/components/timeline/browser/browser-types";
import TimelineOverlays from "~/components/timeline/timeline-overlays";
import type { TimelineMidiBounds } from "~/lib/timeline-midi-bounds";
import { LANE_HEIGHT, PPS, RULER_HEIGHT } from "~/lib/timeline-utils";
import type { AudioEngine } from "@daw-browser/audio-engine/audio-engine";
import type { TimelineSelectionController } from "~/hooks/useTimelineSelectionState";
import type { Clip, Track, TrackId, TrackSend } from "@daw-browser/timeline-core/types";
import type { TimelineTrackIndex } from "@daw-browser/timeline-core/track-index";
import type { RuntimeTrack } from "~/lib/timeline-runtime-types";
import type { AutomationEnvelope } from "@daw-browser/shared";
import { automationTargetKey } from "@daw-browser/shared";

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
      if (dprQuery && dprListener) dprQuery.removeEventListener("change", dprListener);
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
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
      if (dprQuery && dprListener) dprQuery.removeEventListener("change", dprListener);
    });
  });

  return version;
};

type Props = {
  containerRef: (el: HTMLDivElement) => void;
  scrollRef: (el: HTMLDivElement) => void;
  bottomPanelOffsetPx: number;
  leftBrowser: TimelineLeftBrowserModel;
  durationSec: number;
  sidebarWidth: number;
  tracks: RuntimeTrack[];
  dropAtNewTrack: boolean;
  dropTargetLane: number | null;
  bpm: number;
  gridDenominator: number;
  gridEnabled: boolean;
  loopEnabled: boolean;
  loopStartSec: number;
  loopEndSec: number;
  playheadSec: number;
  onSetLoopRegion: (startSec: number, endSec: number) => void;
  onLanePointerDown: JSX.EventHandler<HTMLDivElement, PointerEvent>;
  onRulerPointerDown: (event: PointerEvent) => void;
  selection: TimelineSelectionController;
  onClipPointerDown: (trackId: Track["id"], clipId: string, event: PointerEvent) => void;
  onClipPointerUp: (trackId: Track["id"], clipId: string, event: PointerEvent) => void;
  onClipResizeStart: (trackId: Track["id"], clipId: string, edge: "left" | "right", event: PointerEvent) => void;
  ensureClipBuffer: (clipId: string, sampleUrl?: string) => Promise<void>;
  replaceMissingMediaClip: (trackId: Track["id"], clipId: string) => Promise<void>;
  removeMissingMediaClip: (trackId: Track["id"], clipId: string) => Promise<void>;
  trackLookup: TimelineTrackIndex<AudioBuffer>;
  openMidiEditorFor: (clipId: string) => void;
  openSampleDetailFor: (clipId: string) => void;
  marqueeRect: { x: number; y: number; width: number; height: number } | null;
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
    close: () => void;
    changeBounds: (bounds: TimelineMidiBounds) => void;
    auditionNote: (note: number, velocity?: number) => void;
    keyboard: {
      isActive: (pitch: number) => boolean;
    };
    onLocalMidiSaved: (clipId: string, midi: Clip["midi"]) => void;
  };
  sidebar: {
    currentUserId: string;
    master: MasterSidebarModel;
    subscribeTrackLevels: AudioEngine["subscribeTrackStereoLevels"];
    canWriteTrackRouting: (trackId: Track["id"]) => boolean;
    onTrackClick: (trackId: Track["id"]) => void;
    onTrackSendsChange: (trackId: Track["id"], sends: TrackSend[]) => void;
    onTrackOutputTargetChange: (trackId: Track["id"], outputTargetId?: Track["id"]) => void;
    onVolumePreview: (trackId: Track["id"], volume: number, muted: boolean) => void;
    onVolumeChange: (trackId: Track["id"], volume: number) => void;
    onToggleMute: (trackId: Track["id"]) => void;
    onToggleSolo: (trackId: Track["id"]) => void;
    onSidebarPointerDown: (event: PointerEvent) => void;
    onToggleRecordArm: (trackId: Track["id"]) => void;
  };
  automation: {
    projectId: string;
    visibleByTrackId: Record<string, boolean>;
    onToggleTrackVisibility: (trackId: Track["id"]) => void;
    selectedParametersByTargetKey: Record<string, string>;
    onSelectParameter: (targetKey: string, parameterId: string) => void;
    envelopesByTargetKey: Map<string, AutomationEnvelope>;
    onPreviewEnvelope: (envelope: AutomationEnvelope | undefined) => void;
    onCommitEnvelope: (envelope: AutomationEnvelope | undefined, targetKey?: string) => void;
  };
};

export default function TimelineWorkspace(props: Props) {
  const viewportRedrawVersion = createViewportRedrawVersion();
  const trackAreaHeight = () => (props.tracks.length + (props.dropAtNewTrack ? 1 : 0)) * LANE_HEIGHT;
  const fullHeight = () => RULER_HEIGHT + trackAreaHeight();
  const scrollContentHeight = () => fullHeight() + props.bottomPanelOffsetPx;
  return (
    <div class="flex-1 flex min-h-0" ref={props.containerRef}>
      <div
        class="min-h-0 shrink-0"
        style={{ height: `calc(100% - ${props.bottomPanelOffsetPx}px)` }}
      >
        <TimelineLeftBrowser browser={props.leftBrowser} />
      </div>
      <div
        class="flex-1 relative overflow-auto"
        ref={props.scrollRef}
      >
        <div
          class="relative flex select-none"
          style={{
            width: `${props.durationSec * PPS + props.sidebarWidth}px`,
            height: `${scrollContentHeight()}px`,
            "min-height": "100%",
          }}
        >
          <div
            class="relative shrink-0"
            style={{
              width: `${props.durationSec * PPS}px`,
              height: "100%",
            }}
            onPointerDown={props.onLanePointerDown}
          >
            <TimelineRuler
              durationSec={props.durationSec}
              bpm={props.bpm}
              denom={props.gridDenominator}
              gridEnabled={props.gridEnabled}
              onPointerDown={props.onRulerPointerDown}
              loopEnabled={props.loopEnabled}
              loopStartSec={props.loopStartSec}
              loopEndSec={props.loopEndSec}
              onSetLoopRegion={props.onSetLoopRegion}
            />

            <div
              class="absolute left-0 right-0 bg-neutral-950"
              style={{
                top: `${RULER_HEIGHT}px`,
                bottom: `${props.bottomPanelOffsetPx}px`,
              }}
            >
              <For each={props.tracks}>
                {(track, i) => (
                  (() => {
                    const parameterId = props.automation.selectedParametersByTargetKey[track.id] ?? "volume";
                    const targetKey = automationTargetKey({ kind: "track", trackId: track.id }, parameterId);
                    return (
                      <TrackLane
                        track={track}
                        topPx={i() * LANE_HEIGHT}
                        isDropTarget={props.dropTargetLane === i()}
                        selectedClipIds={props.selection.selectedClipIds()}
                        onClipPointerDown={props.onClipPointerDown}
                        onClipPointerUp={props.onClipPointerUp}
                        onClipResizeStart={props.onClipResizeStart}
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
                        viewportRedrawVersion={viewportRedrawVersion()}
                        automation={{
                          projectId: props.automation.projectId,
                          visible: props.automation.visibleByTrackId[track.id] === true,
                          parameterId,
                          envelope: props.automation.envelopesByTargetKey.get(targetKey),
                          durationSec: props.durationSec,
                          onPreview: props.automation.onPreviewEnvelope,
                          onCommit: props.automation.onCommitEnvelope,
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
                    );
                  })()
                )}
              </For>
              <TimelineOverlays
                timeline={{
                  tracks: props.tracks,
                  trackLookup: props.trackLookup,
                  durationSec: props.durationSec,
                  bpm: props.bpm,
                  gridDenominator: props.gridDenominator,
                  gridEnabled: props.gridEnabled,
                  loopEnabled: props.loopEnabled,
                  loopStartSec: props.loopStartSec,
                  loopEndSec: props.loopEndSec,
                  playheadSec: props.playheadSec,
                  dropAtNewTrack: props.dropAtNewTrack,
                  marqueeRect: props.marqueeRect,
                }}
                recording={props.recording}
                midi={props.midi}
              />
            </div>
          </div>

          <div class="sticky right-0 z-40 flex h-full shrink-0" style={{ width: `${props.sidebarWidth}px` }}>
            <TrackSidebar
              sidebar={{
                tracks: props.tracks,
                selectedTrackId: props.selection.selectedTrackId(),
                sidebarWidth: props.sidebarWidth,
                bottomOffsetPx: props.bottomPanelOffsetPx,
                master: props.sidebar.master,
                recordArmTrackId: props.recording.recordArmTrackId,
                currentUserId: props.sidebar.currentUserId,
                subscribeTrackLevels: props.sidebar.subscribeTrackLevels,
                onTrackClick: props.sidebar.onTrackClick,
                canWriteTrackRouting: props.sidebar.canWriteTrackRouting,
                onTrackSendsChange: props.sidebar.onTrackSendsChange,
                onTrackOutputTargetChange: props.sidebar.onTrackOutputTargetChange,
                onVolumePreview: props.sidebar.onVolumePreview,
                onVolumeChange: props.sidebar.onVolumeChange,
                onToggleMute: props.sidebar.onToggleMute,
                onToggleSolo: props.sidebar.onToggleSolo,
                onSidebarPointerDown: props.sidebar.onSidebarPointerDown,
                onToggleRecordArm: props.sidebar.onToggleRecordArm,
              }}
              automation={{
                visibleByTrackId: props.automation.visibleByTrackId,
                onToggleTrackVisibility: props.automation.onToggleTrackVisibility,
                selectedParametersByTargetKey: props.automation.selectedParametersByTargetKey,
                envelopesByTargetKey: props.automation.envelopesByTargetKey,
                onSelectParameter: props.automation.onSelectParameter,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
