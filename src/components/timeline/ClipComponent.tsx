import {
  type Component,
  createEffect,
  createMemo,
  Show,
  untrack,
} from "solid-js";

import { drawWaveformPeaks, drawWaveformPcmLine } from "@daw-browser/waveforms/render-waveform";
import { useAppPreferences } from "~/context/app-preferences";
import { useClipWaveformViewModel, type ClipWaveformRaster } from "~/hooks/useClipWaveformViewModel";
import { createClipVisualColors, resolveClipColor } from "~/lib/clip-color";
import { LANE_HEIGHT } from "~/lib/timeline-utils";
import { getTimelineClipViewportSlice } from "~/lib/timeline-viewport-geometry";
import { waveformCanvasSize } from "~/lib/waveform-canvas";
import { cn } from "~/lib/utils";
import type { Track } from "@daw-browser/timeline-core/types";
import type { RuntimeClip } from "~/lib/timeline-runtime-types";
import type { AudioPcmSourceResolver } from "~/lib/audio-pcm-source-resolver";
import {
  normalizeClipFades,
  normalizedFadeGainAtClipTime,
  type ClipFades,
} from "@daw-browser/timeline-core/clip-fades";
import ClipFadeOverlay from "./ClipFadeOverlay";
import type { ClipRangeOverlap } from "~/lib/timeline-range-selection";
import {
  getVisibleMidiBarIndices,
  getVisibleMidiNoteProjection,
} from "~/lib/timeline-midi-rendering";
import TimelineContextMenu, { type TimelineContextMenuItem } from "./context-menu/timeline-context-menu";

export type ClipContextMenuActions = {
  selectClip: (trackId: Track["id"], clipId: string) => void;
  duplicateSelectedClips: () => void;
  deleteSelectedClips: () => void;
};

type ClipComponentProps = {
  clip: RuntimeClip;
  trackId: Track["id"];
  isSelected: boolean;
  onPointerDown: (
    trackId: Track["id"],
    clipId: string,
    e: PointerEvent,
  ) => void;
  onPointerUp: (trackId: Track["id"], clipId: string, e: PointerEvent) => void;
  onResizeStart: (
    trackId: Track["id"],
    clipId: string,
    edge: "left" | "right",
    e: PointerEvent,
  ) => void;
  onDblClick?: (trackId: Track["id"], clipId: string) => void;
  contextMenu: ClipContextMenuActions;
  onRetryMedia: (clipId: string) => void;
  onReplaceMedia: (trackId: Track["id"], clipId: string) => void;
  onRemoveMissingMedia: (trackId: Track["id"], clipId: string) => void;
  resolveAudioSource: AudioPcmSourceResolver;
  bpm: number;
  pixelsPerSecond: number;
  visibleRange: { startSec: number; endSec: number };
  timeToX: (timeSec: number) => number;
  viewportRedrawVersion: number;
  waveformVisible?: boolean;
  rangeOverlap: ClipRangeOverlap | null;
  canEditFades: () => boolean;
  onCommitFades: (clipId: string, fades: ClipFades, baseline: ClipFades) => void;
};

const MIN_CLIP_PX = 1;
const WAVEFORM_PAD_Y = 6;
const CLIP_TITLE_HEADER_H = 20;
const AUDIO_WAVEFORM_PADDING_Y = 4;
const AUDIO_WAVEFORM_MAX_HEIGHT_FRACTION = 0.9;
const DOUBLE_TAP_MS = 700;
const DOUBLE_TAP_DISTANCE_PX = 8;
const SELECTED_TAP_MS = 700;
export const retainedWaveformTransform = (
  raster: ClipWaveformRaster,
  renderStartSec: number,
  pixelsPerSecond: number,
) => (
  `translateX(${(raster.timelineStartSec - renderStartSec) * pixelsPerSecond}px) scaleX(${pixelsPerSecond / Math.max(1e-6, raster.pixelsPerSecond)})`
);
const createFadeScale = (
  fades: ReturnType<typeof normalizeClipFades>,
  duration: number,
  canvasStartSec: number,
  canvasDurationSec: number,
  cssW: number,
) => (column: number) => normalizedFadeGainAtClipTime(
  fades,
  duration,
  canvasStartSec + ((column + 0.5) / Math.max(1, cssW)) * canvasDurationSec,
);
const createFadeSampleScale = (
  fades: ReturnType<typeof normalizeClipFades>,
  duration: number,
  canvasStartSec: number,
  canvasDurationSec: number,
  sampleCount: number,
) => (index: number) => normalizedFadeGainAtClipTime(
  fades,
  duration,
  canvasStartSec + (index / Math.max(1, sampleCount - 1)) * canvasDurationSec,
);
type ClipTapState = { key: string; at: number; x: number; y: number; pointerType: string };
type ClipOpenState = { key: string; at: number };
// Native dblclick can be lost when selection remounts the clip; keep the tap window outside the component.
let lastClipTap:
  | ClipTapState
  | undefined;
let lastClipDoubleOpen:
  | ClipOpenState
  | undefined;

const ClipComponent: Component<ClipComponentProps> = (props) => {
  const appPreferences = useAppPreferences();
  let canvasRef: HTMLCanvasElement | undefined;
  let selectedTapStart:
    | { x: number; y: number; at: number }
    | undefined;

  const renderSlice = createMemo(() => getTimelineClipViewportSlice({
    clipStartSec: props.clip.startSec,
    clipDurationSec: props.clip.duration,
    visibleRange: props.visibleRange,
    pixelsPerSecond: props.pixelsPerSecond,
  }));
  const renderStartSec = () => renderSlice()?.startSec ?? props.clip.startSec;
  const renderEndSec = () => renderSlice()?.endSec ?? props.clip.startSec;
  const clipWidthPx = () =>
    Math.max(
      MIN_CLIP_PX,
      Math.ceil(Math.max(0, renderEndSec() - renderStartSec()) * props.pixelsPerSecond),
    );
  const hasLeftBoundary = () => renderSlice()?.hasLeftBoundary === true;
  const hasRightBoundary = () => renderSlice()?.hasRightBoundary === true;
  const handleWidthPx = () =>
    clipWidthPx() < 18 ? 2 : clipWidthPx() < 28 ? 3 : 6;
  const isGhost = () => props.clip.id.startsWith("__dup_preview:");
  const clipContentColor = createMemo(() => resolveClipColor(
    props.clip.color,
    appPreferences.appearance.themeTokens(),
  ));
  const clipVisualColors = createMemo(() => createClipVisualColors(
    clipContentColor(),
    props.isSelected,
    isGhost(),
  ));

  const waveform = useClipWaveformViewModel({
    clip: () => props.clip,
    cssWidthPx: () => clipWidthPx(),
    projectBpm: () => props.bpm,
    resolveAudioSource: () => props.resolveAudioSource,
    visibleRange: () => props.visibleRange,
    priorityRange: () => props.visibleRange,
    waveformVisible: () => props.waveformVisible !== false,
  });
  const waveformCanvasStyle = createMemo(() => {
    const currentRaster = waveform.raster();
    return {
      width: `${currentRaster?.widthPx ?? clipWidthPx()}px`,
      height: `${LANE_HEIGHT - 1}px`,
      transform: currentRaster
        ? retainedWaveformTransform(currentRaster, renderStartSec(), props.pixelsPerSecond)
        : undefined,
      "transform-origin": "top left",
    };
  });
  const overlapProjection = createMemo(() => {
    const overlap = props.rangeOverlap;
    if (!overlap) return null;
    const sliceStart = renderStartSec() - props.clip.startSec;
    const left = Math.max(0, (overlap.offsetSec - sliceStart) * props.pixelsPerSecond);
    const right = Math.min(
      clipWidthPx(),
      (overlap.offsetSec + overlap.durationSec - sliceStart) * props.pixelsPerSecond,
    );
    return { left, width: Math.max(0, right - left) };
  });
  const openClip = () => props.onDblClick?.(props.trackId, props.clip.id);
  const selectClipForMenu = () => props.contextMenu.selectClip(props.trackId, props.clip.id);
  const contextMenuItems = (): TimelineContextMenuItem[] => {
    const items: TimelineContextMenuItem[] = [
      { kind: "label", label: props.clip.name },
      { kind: "item", label: props.clip.midi ? "Open MIDI editor" : "Open sample editor", onSelect: openClip },
      { kind: "separator" },
      {
        kind: "item",
        label: "Duplicate",
        shortcut: "⌘D",
        onSelect: props.contextMenu.duplicateSelectedClips,
      },
      {
        kind: "item",
        label: "Delete",
        shortcut: "⌫",
        onSelect: props.contextMenu.deleteSelectedClips,
      },
    ];
    if (mediaStatusLabel()) {
      items.push(
        { kind: "separator" },
        {
          kind: "item",
          label: "Retry media",
          onSelect: () => props.onRetryMedia(props.clip.id),
        },
        {
          kind: "item",
          label: "Replace media",
          onSelect: () => props.onReplaceMedia(props.trackId, props.clip.id),
        },
        {
          kind: "item",
          label: "Remove missing media clip",
          onSelect: () => props.onRemoveMissingMedia(props.trackId, props.clip.id),
        },
      );
    }
    return items;
  };
  const mediaStatusLabel = () => {
    if (props.clip.mediaStatus === "permission-denied") return "Permission needed";
    if (props.clip.mediaStatus === "missing") return "Missing media";
    return null;
  };

  const openFromDoubleTap = () => {
    const now = performance.now();
    const key = `${props.trackId}:${props.clip.id}`;
    if (
      lastClipDoubleOpen?.key === key &&
      now - lastClipDoubleOpen.at < DOUBLE_TAP_MS
    ) return;
    lastClipDoubleOpen = { key, at: now };
    props.onDblClick?.(props.trackId, props.clip.id);
  };

  const isDoubleTap = (event: PointerEvent) => {
    const now = performance.now();
    const previous = lastClipTap;
    const key = `${props.trackId}:${props.clip.id}`;
    lastClipTap = {
      key,
      at: now,
      x: event.clientX,
      y: event.clientY,
      pointerType: event.pointerType,
    };
    if (
      !previous ||
      previous.key !== key ||
      previous.pointerType !== event.pointerType
    ) return false;
    if (now - previous.at > DOUBLE_TAP_MS) return false;
    return (
      Math.abs(event.clientX - previous.x) <= DOUBLE_TAP_DISTANCE_PX &&
      Math.abs(event.clientY - previous.y) <= DOUBLE_TAP_DISTANCE_PX
    );
  };

  function drawWaveform() {
    const canvas = canvasRef;
    if (!canvas) return;
    if (props.waveformVisible === false) {
      canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const currentRaster = waveform.raster();
    const cssH = Math.max(1, Math.floor(LANE_HEIGHT - 1));

    const canvasSize = waveformCanvasSize({
      cssWidthPx: currentRaster?.widthPx ?? clipWidthPx(),
      cssHeightPx: cssH,
      devicePixelRatio: window.devicePixelRatio || 1,
    });
    const cssW = canvasSize.cssWidthPx;
    const pxW = canvasSize.backingWidthPx;
    const pxH = canvasSize.backingHeightPx;
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(
      canvasSize.contextScaleX,
      0,
      0,
      canvasSize.contextScaleY,
      0,
      0,
    );
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cssW, cssH);

    const canvasColors = appPreferences.appearance.themeTokens();
    const clipSelected = canvasColors["clip-selected"];
    const timelineGridMajor = canvasColors["timeline-grid-major"];
    const timelineGridMinor = canvasColors["timeline-grid-minor"];
    const timelineSurface = canvasColors["timeline-surface"];
    const timelineSurfaceMuted = canvasColors["timeline-surface-muted"];
    const contentColor = clipContentColor();

    const padTop = WAVEFORM_PAD_Y;
    const padBottom = WAVEFORM_PAD_Y;
    const innerH = Math.max(1, cssH - padTop - padBottom);

    const midi = props.clip.midi;
    if (midi && Array.isArray(midi.notes) && midi.notes.length > 0) {
      const spb = 60 / Math.max(1, props.bpm || 120);
      const midiOffsetBeats = Math.max(
        0,
        props.clip.midiOffsetBeats ?? 0,
      );
      const color = props.isSelected
        ? clipSelected
        : contentColor;
      const midiWindowStart = renderStartSec() - props.clip.startSec;
      const midiWindowDuration = Math.max(1e-6, renderEndSec() - renderStartSec());
      const midiWindowEnd = midiWindowStart + midiWindowDuration;
      let minP = Infinity;
      let maxP = -Infinity;
      for (const note of midi.notes) {
        if (note.pitch < minP) minP = note.pitch;
        if (note.pitch > maxP) maxP = note.pitch;
      }
      if (!Number.isFinite(minP) || !Number.isFinite(maxP)) {
        minP = 60;
        maxP = 72;
      }
      const range = Math.max(1, maxP - minP);
      const barH = Math.max(2, Math.floor(innerH / Math.min(12, range)));

      ctx.fillStyle = color;
      for (const note of midi.notes) {
        const noteBeat = note.beat || 0;
        const projection = getVisibleMidiNoteProjection({
          noteBeat,
          noteLength: note.length || 0,
          midiOffsetBeats,
          secondsPerBeat: spb,
          windowStartSec: midiWindowStart,
          windowEndSec: midiWindowEnd,
        });
        if (!projection) continue;
        const { startSec, endSec } = projection;
        const left = Math.max(
          0,
          Math.min(
            cssW,
            Math.floor(((startSec - midiWindowStart) / midiWindowDuration) * cssW),
          ),
        );
        const right = Math.max(
          left + 1,
          Math.min(
            cssW,
            Math.floor(((endSec - midiWindowStart) / midiWindowDuration) * cssW),
          ),
        );
        const frac = 1 - (note.pitch - minP) / range;
        const centerY = padTop + Math.max(0, Math.min(1, frac)) * innerH;
        const yTop = Math.max(padTop, Math.floor(centerY - barH / 2));
        ctx.fillRect(left, yTop, Math.max(1, right - left), barH);
      }

      ctx.strokeStyle = timelineGridMajor;
      ctx.lineWidth = 1;
      const windowStart = renderStartSec() - props.clip.startSec;
      const windowDuration = Math.max(1e-6, renderEndSec() - renderStartSec());
      const barDurationSec = spb * 4;
      const visibleBars = getVisibleMidiBarIndices({
        clipDurationSec: props.clip.duration,
        windowStartSec: windowStart,
        windowEndSec: windowStart + windowDuration,
        barDurationSec,
      });
      for (let b = visibleBars?.firstBar ?? 1; b <= (visibleBars?.lastBar ?? 0); b++) {
        const x =
          Math.floor(
            ((b * barDurationSec - windowStart) / windowDuration) * cssW,
          ) + 0.5;
        if (x < 0 || x > cssW) continue;
        ctx.beginPath();
        ctx.moveTo(x, padTop);
        ctx.lineTo(x, padTop + innerH);
        ctx.stroke();
      }
      return;
    }

    const rasterSegments = waveform.rasterSegments();
    const layout = waveform.layout();
    const padPx = layout.padPx;
    const drawCols = layout.drawCols || rasterSegments.reduce(
      (end, segment) => Math.max(end, segment.endPx),
      0,
    );
    const audioStartPx = rasterSegments.length > 0
      ? Math.min(...rasterSegments.map((segment) => segment.startPx))
      : layout.audioStartPx;
    const audioEndPx = rasterSegments.length > 0
      ? Math.max(...rasterSegments.map((segment) => segment.endPx))
      : layout.audioEndPx;
    const peaks = rasterSegments.length === 0
      ? waveform.peaks()
      : null;
    if (drawCols <= 0) {
      ctx.fillStyle = timelineSurface;
      ctx.fillRect(0, 0, cssW, cssH);
      ctx.strokeStyle = timelineGridMinor;
      ctx.beginPath();
      ctx.moveTo(0, Math.floor(cssH / 2) + 0.5);
      ctx.lineTo(cssW, Math.floor(cssH / 2) + 0.5);
      ctx.stroke();
      return;
    }

    const silentFill = props.isSelected
      ? timelineSurfaceMuted
      : timelineSurface;
    if (audioStartPx > 0) {
      ctx.fillStyle = silentFill;
      ctx.fillRect(0, 0, Math.min(cssW, audioStartPx), cssH);
    }
    if (audioEndPx < cssW) {
      ctx.fillStyle = silentFill;
      ctx.fillRect(Math.max(0, audioEndPx), 0, cssW - Math.max(0, audioEndPx), cssH);
    }

    const waveformTop = CLIP_TITLE_HEADER_H + AUDIO_WAVEFORM_PADDING_Y;
    const waveformBoxH = cssH - waveformTop - AUDIO_WAVEFORM_PADDING_Y;
    const fades = normalizeClipFades(props.clip.fades, props.clip.duration);
    const hasEffectiveFade = fades.fadeInStartSec > 0
      || fades.fadeInSec > 0
      || fades.fadeOutSec > 0
      || fades.fadeOutEndSec > 0;
    const waveformSegments = rasterSegments;
    if (waveformSegments.length > 0) {
      for (const segment of waveformSegments) {
        const segmentWidth = Math.max(1, segment.endPx - segment.startPx);
        const segmentPcm = segment.pcm;
        const scaleAtColumn = hasEffectiveFade
          ? createFadeScale(
            fades,
            props.clip.duration,
            segment.canvasStartSec - props.clip.startSec,
            segment.canvasEndSec - segment.canvasStartSec,
            segmentWidth,
          )
          : undefined;
        if (segmentPcm?.mode === "pcm-envelope") {
          const laneHeight = waveformBoxH / Math.max(1, segmentPcm.channels.length);
          segmentPcm.channels.forEach((channelPeaks, channel) => {
            drawWaveformPeaks({
              ctx,
              peaks: channelPeaks,
              drawCols: Math.max(1, Math.ceil(segmentWidth)),
              padPx: 0,
              xOffsetPx: segment.startPx,
              topY: waveformTop + channel * laneHeight,
              contentH: laneHeight,
              cssW,
              cssH,
              fillStyle: contentColor,
              boundaryStyle: timelineGridMajor,
              maxHeightFraction: AUDIO_WAVEFORM_MAX_HEIGHT_FRACTION,
              amplitudeScaleAtColumn: scaleAtColumn,
            });
          });
        } else if (segmentPcm?.mode === "pcm-line") {
          drawWaveformPcmLine({
            ctx,
            pcm: segmentPcm,
            topY: waveformTop,
            contentH: waveformBoxH,
            cssW: segmentWidth,
            xOffsetPx: segment.startPx,
            fillStyle: contentColor,
            pointRadius: 1,
            showPoints: segment.showPoints,
            amplitudeScaleAtSample: hasEffectiveFade
              ? createFadeSampleScale(
                fades,
                props.clip.duration,
                segment.canvasStartSec - props.clip.startSec,
                segment.canvasEndSec - segment.canvasStartSec,
                segmentPcm.channels[0]?.length ?? 1,
              )
              : undefined,
          });
        } else if (segment.peaks) {
          const laneHeight = waveformBoxH / Math.max(1, segment.peaks.channels.length);
          segment.peaks.channels.forEach((channelPeaks, channel) => {
            drawWaveformPeaks({
              ctx,
              peaks: channelPeaks,
              drawCols: Math.max(1, Math.ceil(segmentWidth)),
              padPx: 0,
              xOffsetPx: segment.startPx,
              topY: waveformTop + channel * laneHeight,
              contentH: laneHeight,
              cssW,
              cssH,
              fillStyle: contentColor,
              boundaryStyle: timelineGridMajor,
              maxHeightFraction: AUDIO_WAVEFORM_MAX_HEIGHT_FRACTION,
              amplitudeScaleAtColumn: scaleAtColumn,
            });
          });
        }
      }
      return;
    }

    if (!peaks && !currentRaster) {
      ctx.strokeStyle = timelineGridMinor;
      for (let x = audioStartPx; x < audioEndPx; x += 6) {
        ctx.beginPath();
        ctx.moveTo(x, cssH);
        ctx.lineTo(Math.min(audioEndPx, x + 6), 0);
        ctx.stroke();
      }
      return;
    }

    if (peaks) {
      const laneHeight = waveformBoxH / Math.max(1, peaks.channels.length);
      peaks.channels.forEach((channelPeaks, channel) => {
        drawWaveformPeaks({
          ctx,
          peaks: channelPeaks,
          drawCols,
          padPx,
          topY: waveformTop + channel * laneHeight,
          contentH: laneHeight,
          cssW,
          cssH,
          fillStyle: contentColor,
          boundaryStyle: timelineGridMajor,
          maxHeightFraction: AUDIO_WAVEFORM_MAX_HEIGHT_FRACTION,
          amplitudeScaleAtColumn: hasEffectiveFade
            ? createFadeScale(
              fades,
              props.clip.duration,
              (layout.canvasStartSec ?? props.clip.startSec) - props.clip.startSec
                + padPx / Math.max(1, cssW)
                  * Math.max(0, (layout.canvasEndSec ?? props.clip.startSec + props.clip.duration) - (layout.canvasStartSec ?? props.clip.startSec)),
              Math.max(0, (layout.canvasEndSec ?? props.clip.startSec + props.clip.duration) - (layout.canvasStartSec ?? props.clip.startSec)),
              cssW,
            )
            : undefined,
        });
      });
    }
  }

  createEffect(() => {
    const hasRaster = waveform.rasterDataRevision() !== undefined;
    void props.viewportRedrawVersion;
    void props.clip;
    void props.isSelected;
    void props.bpm;
    void props.waveformVisible;
    void appPreferences.appearance.themeTokens();
    if (!hasRaster || props.clip.midi) {
      void props.pixelsPerSecond;
      void props.visibleRange;
    }
    untrack(drawWaveform);
  });

  const clipElement = (
    <div
      class={cn(
        "group absolute overflow-hidden border z-20 select-none",
        isGhost()
          ? "border-dashed opacity-60 pointer-events-none"
          : props.isSelected
            ? "ring-1 ring-blue-400/80"
            : "hover:brightness-110 cursor-grab",
      )}
      style={{
        top: "0px",
        left: `${props.timeToX(renderStartSec())}px`,
        width: `${clipWidthPx()}px`,
        height: `${LANE_HEIGHT - 1}px`,
        ...clipVisualColors(),
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) {
          e.stopPropagation();
          selectedTapStart = undefined;
          return;
        }
        if (e.detail >= 2 || isDoubleTap(e)) {
          e.stopPropagation();
          e.preventDefault();
          selectedTapStart = undefined;
          openFromDoubleTap();
          return;
        }
        selectedTapStart = props.isSelected
          ? { x: e.clientX, y: e.clientY, at: performance.now() }
          : undefined;
        props.onPointerDown(props.trackId, props.clip.id, e);
      }}
      onDblClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        openFromDoubleTap();
      }}
      onPointerUp={(e) => {
        if (e.button !== 0) {
          e.stopPropagation();
          selectedTapStart = undefined;
          return;
        }
        props.onPointerUp(props.trackId, props.clip.id, e);
        const start = selectedTapStart;
        selectedTapStart = undefined;
        if (!start) return;
        if (performance.now() - start.at > SELECTED_TAP_MS) return;
        if (
          Math.abs(e.clientX - start.x) > DOUBLE_TAP_DISTANCE_PX ||
          Math.abs(e.clientY - start.y) > DOUBLE_TAP_DISTANCE_PX
        ) return;
        openFromDoubleTap();
      }}
      title={`${props.clip.name}`}
    >
      <Show when={hasLeftBoundary()}>
        <div
          class="absolute inset-y-0 left-0 z-20 flex cursor-ew-resize items-center justify-center select-none text-xs text-foreground/80"
          style={{ width: `${handleWidthPx()}px` }}
          onPointerDown={(e) => {
            e.stopPropagation();
            if (e.button !== 0) return;
            props.onResizeStart(props.trackId, props.clip.id, "left", e);
          }}
        >
          <span class="opacity-0 group-hover:opacity-100 pointer-events-none">[</span>
        </div>
      </Show>
      <Show when={hasRightBoundary()}>
        <div
          class="absolute inset-y-0 right-0 z-20 flex cursor-ew-resize items-center justify-center select-none text-xs text-foreground/80"
          style={{ width: `${handleWidthPx()}px` }}
          onPointerDown={(e) => {
            e.stopPropagation();
            if (e.button !== 0) return;
            props.onResizeStart(props.trackId, props.clip.id, "right", e);
          }}
        >
          <span class="opacity-0 group-hover:opacity-100 pointer-events-none">]</span>
        </div>
      </Show>

      <Show when={props.waveformVisible !== false}>
        <canvas
          ref={(el) => (canvasRef = el || undefined)}
          class="absolute inset-0 size-full pointer-events-none z-10"
          style={waveformCanvasStyle()}
        />
      </Show>
      <ClipFadeOverlay
        clip={{
          ...props.clip,
          sliceStartSec: renderStartSec() - props.clip.startSec,
          sliceDurationSec: Math.max(0, renderEndSec() - renderStartSec()),
        }}
        canEdit={() => props.canEditFades()}
        onCommit={(fades, baseline) => props.onCommitFades(props.clip.id, fades, baseline)}
      />
      {!props.isSelected && overlapProjection() && (
        <>
          <div
            class="absolute inset-y-0 z-0 pointer-events-none bg-timeline-background"
            style={{
              left: `${overlapProjection()?.left ?? 0}px`,
              width: `${overlapProjection()?.width ?? 0}px`,
            }}
          >
            <div class="absolute inset-0 bg-blue-500/25" />
          </div>
          <div
            class="absolute inset-y-0 z-20 pointer-events-none border-x border-blue-400"
            style={{
              left: `${overlapProjection()?.left ?? 0}px`,
              width: `${overlapProjection()?.width ?? 0}px`,
            }}
          />
        </>
      )}
      {mediaStatusLabel() && (
        <div
          class="absolute inset-0 z-30 flex items-center justify-center gap-1 bg-red-950/75 px-2 text-[10px] font-semibold uppercase tracking-wide text-red-100"
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
        >
          <span>{mediaStatusLabel()}</span>
          <button
            class="border border-red-300/40 px-1 py-0.5 text-[9px] text-red-50 hover:bg-red-300/20"
            onClick={(event) => {
              event.stopPropagation();
              props.onRetryMedia(props.clip.id);
            }}
          >
            Retry
          </button>
          <button
            class="border border-red-300/40 px-1 py-0.5 text-[9px] text-red-50 hover:bg-red-300/20"
            onClick={(event) => {
              event.stopPropagation();
              props.onReplaceMedia(props.trackId, props.clip.id);
            }}
          >
            Replace
          </button>
          <button
            class="border border-red-300/40 px-1 py-0.5 text-[9px] text-red-50 hover:bg-red-300/20"
            onClick={(event) => {
              event.stopPropagation();
              props.onRemoveMissingMedia(props.trackId, props.clip.id);
            }}
          >
            Remove
          </button>
        </div>
      )}
      <div
        class={cn(
          "absolute left-0 right-0 top-0 z-20 pointer-events-none",
          isGhost() ? "bg-background/20" : "bg-background/35",
        )}
        style={{ height: `${CLIP_TITLE_HEADER_H}px` }}
      >
        <div class="truncate p-1 text-xs leading-none text-foreground">
          {props.clip.name}
        </div>
      </div>
    </div>
  );

  return (
    <TimelineContextMenu items={contextMenuItems} onOpenChange={(open) => { if (open && !props.isSelected) selectClipForMenu(); }}>
      {clipElement}
    </TimelineContextMenu>
  );
};

export default ClipComponent;
