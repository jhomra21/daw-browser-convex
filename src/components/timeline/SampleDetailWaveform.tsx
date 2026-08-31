import { For, createEffect, createMemo, createSignal, onCleanup, onMount, type Component } from "solid-js";
import { drawWaveformPeaks, drawWaveformSamples } from "@daw-browser/waveforms/render-waveform";
import type { AudioWarp, Clip } from "@daw-browser/timeline-core/types";
import { mapTimelineBeatToSourceBeat, normalizeSourceBeatOffsetValue } from "@daw-browser/shared";
import { useAppPreferences } from "~/context/app-preferences";
import { useSampleDetailWaveformViewModel } from "~/hooks/useSampleDetailWaveformViewModel";
import { buildNextAudioWarp } from "~/lib/audio-warp-patch";
import {
  fitSampleDetailWaveformViewport,
  panSampleDetailWaveformViewport,
  sampleDetailWaveformTimeAtX,
  sampleDetailWaveformXAtTime,
  zoomSampleDetailWaveformViewport,
  type SampleDetailWaveformViewport,
} from "~/lib/sample-detail-waveform-viewport";

type SampleDetailWaveformProps = {
  clip: Clip<AudioBuffer>;
  projectId?: string;
  projectBpm: number;
  canWrite: boolean;
  onMarkerDragStateChange?: (dragging: boolean) => void;
  onWarpChange: (audioWarp: AudioWarp) => Promise<boolean> | boolean | void;
};

type ViewportState = {
  clipId: string;
  viewport: SampleDetailWaveformViewport;
};

const WAVEFORM_PANEL_MIN_WIDTH_PX = 480;
const WAVEFORM_MIN_HEIGHT_PX = 108;
const DEFAULT_WAVEFORM_WIDTH_PX = 960;
const MIN_MARKER_GAP_BEATS = 0.001;
const SOURCE_BEAT_OFFSET_SNAP = 0.25;
const WHEEL_ZOOM_SENSITIVITY = 0.002;

const getClipBeatWidth = (clipDurationSec: number, projectBpm: number) => (
  clipDurationSec / (60 / Math.max(1, projectBpm))
);

const SampleDetailWaveform: Component<SampleDetailWaveformProps> = (props) => {
  const appPreferences = useAppPreferences();
  let canvasRef: HTMLCanvasElement | undefined;
  let canvasWrapRef: HTMLDivElement | undefined;
  let markerHandleRef: HTMLButtonElement | undefined;
  const [waveformWidthPx, setWaveformWidthPx] = createSignal(DEFAULT_WAVEFORM_WIDTH_PX);
  const [waveformHeightPx, setWaveformHeightPx] = createSignal(220);
  const [viewportState, setViewportState] = createSignal<ViewportState>({
    clipId: "",
    viewport: fitSampleDetailWaveformViewport(0),
  });
  const sourceSampleRate = createMemo(() => props.clip.buffer?.sampleRate ?? props.clip.sourceSampleRate ?? 0);
  const viewport = createMemo(() => {
    const state = viewportState();
    if (state.clipId !== props.clip.id) return fitSampleDetailWaveformViewport(props.clip.duration);
    return state.viewport;
  });
  const setViewport = (next: SampleDetailWaveformViewport) => {
    setViewportState({ clipId: props.clip.id, viewport: next });
  };
  const fitViewport = () => setViewport(fitSampleDetailWaveformViewport(props.clip.duration));
  const waveform = useSampleDetailWaveformViewModel({
    projectId: () => props.projectId,
    clip: () => props.clip,
    cssWidthPx: waveformWidthPx,
    projectBpm: () => props.projectBpm,
    viewport,
  });
  const [dragPreviewOffset, setDragPreviewOffset] = createSignal<number | undefined>();
  const [isDraggingMarker, setIsDraggingMarker] = createSignal(false);
  const clipAudioStartSec = createMemo(() => Math.max(0, props.clip.leftPadSec ?? 0));
  const sourceBeatOffset = createMemo(() => props.clip.audioWarp?.sourceBeatOffset ?? 0);
  const warpMarkers = createMemo(() => props.clip.audioWarp?.markers ?? []);
  const markerWarpActive = createMemo(() => warpMarkers().length >= 2);
  const [selectedMarkerId, setSelectedMarkerId] = createSignal<string>();
  const [dragMarker, setDragMarker] = createSignal<{ id: string; timelineBeat: number; sourceBeat: number }>();
  const visibleSourceBeatOffset = createMemo(() => dragPreviewOffset() ?? sourceBeatOffset());
  const secondsPerBeat = createMemo(() => 60 / Math.max(1, props.projectBpm));
  const markerX = createMemo(() => sampleDetailWaveformXAtTime({
    viewport: viewport(),
    timeSec: clipAudioStartSec() + visibleSourceBeatOffset() * secondsPerBeat(),
    widthPx: waveformWidthPx(),
  }));

  onMount(() => {
    const commitSize = (widthPx: number, heightPx: number) => {
      const nextWidthPx = Math.max(1, Math.floor(widthPx));
      const nextHeightPx = Math.max(WAVEFORM_MIN_HEIGHT_PX, Math.floor(heightPx));
      setWaveformWidthPx((currentWidthPx) => currentWidthPx === nextWidthPx ? currentWidthPx : nextWidthPx);
      setWaveformHeightPx((currentHeightPx) => currentHeightPx === nextHeightPx ? currentHeightPx : nextHeightPx);
    };
    const measure = () => {
      const bounds = canvasWrapRef?.getBoundingClientRect();
      if (bounds) commitSize(bounds.width, bounds.height);
    };
    measure();
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) commitSize(entry.contentRect.width, entry.contentRect.height);
    });
    if (canvasWrapRef) resizeObserver.observe(canvasWrapRef);
    onCleanup(() => resizeObserver.disconnect());
  });

  onCleanup(() => {
    if (dragMarker() || isDraggingMarker()) props.onMarkerDragStateChange?.(false);
  });

  const clipTimeFromPointer = (event: Pick<PointerEvent, "clientX">) => {
    const canvas = canvasRef;
    if (!canvas) return viewport().startSec;
    const bounds = canvas.getBoundingClientRect();
    const x = Math.min(bounds.width, Math.max(0, event.clientX - bounds.left));
    return sampleDetailWaveformTimeAtX({
      viewport: viewport(),
      xPx: x,
      widthPx: bounds.width,
    });
  };

  const beatFromPointer = (event: Pick<PointerEvent, "clientX" | "altKey">) => {
    const rawBeat = (clipTimeFromPointer(event) - clipAudioStartSec()) / secondsPerBeat();
    return Math.max(0, event.altKey ? rawBeat : Math.round(rawBeat));
  };

  const previewOffsetFromPointer = (event: PointerEvent) => {
    const rawOffset = (clipTimeFromPointer(event) - clipAudioStartSec()) / secondsPerBeat();
    const snapped = event.altKey
      ? rawOffset
      : Math.round(rawOffset / SOURCE_BEAT_OFFSET_SNAP) * SOURCE_BEAT_OFFSET_SNAP;
    return normalizeSourceBeatOffsetValue(snapped);
  };

  const commitSourceBeatOffset = (value: number) => {
    const audioWarp = buildNextAudioWarp(props.projectBpm, props.clip.audioWarp, {
      enabled: true,
      sourceBeatOffset: value,
    });
    if (audioWarp) props.onWarpChange(audioWarp);
  };

  const commitMarkers = (markers: AudioWarp["markers"]) => {
    const audioWarp = buildNextAudioWarp(props.projectBpm, props.clip.audioWarp, {
      enabled: props.clip.audioWarp?.enabled === true,
      markers,
      mode: "stretch",
    });
    if (audioWarp) props.onWarpChange(audioWarp);
  };

  const addMarker = (event: MouseEvent) => {
    if (!props.canWrite || event.detail !== 2 || !canvasRef || props.clip.audioWarp?.enabled !== true) return;
    const timelineBeat = beatFromPointer(event);
    const sourceBeat = warpMarkers().length >= 2
      ? mapTimelineBeatToSourceBeat(warpMarkers(), timelineBeat)
      : timelineBeat + sourceBeatOffset();
    const marker = { id: `warp-marker-${Date.now().toString(36)}`, timelineBeat, sourceBeat };
    commitMarkers([...warpMarkers(), marker]);
    setSelectedMarkerId(marker.id);
  };

  const deleteSelectedMarker = () => {
    const selected = selectedMarkerId();
    if (!selected || !props.canWrite || props.clip.audioWarp?.enabled !== true) return;
    commitMarkers(warpMarkers().filter((marker) => marker.id !== selected));
    setSelectedMarkerId(undefined);
  };

  const handleWheel = (event: WheelEvent) => {
    if (!canvasRef || sourceSampleRate() <= 0) return;
    const bounds = canvasRef.getBoundingClientRect();
    const current = viewport();
    if (!event.ctrlKey && !event.metaKey && Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      event.preventDefault();
      const visibleDurationSec = current.endSec - current.startSec;
      setViewport(panSampleDetailWaveformViewport({
        viewport: current,
        clipDurationSec: props.clip.duration,
        sampleRate: sourceSampleRate(),
        deltaSec: (event.deltaX / Math.max(1, bounds.width)) * visibleDurationSec,
      }));
      return;
    }
    if (!event.ctrlKey && !event.metaKey) return;

    event.preventDefault();
    const anchorFraction = Math.min(1, Math.max(0, (event.clientX - bounds.left) / Math.max(1, bounds.width)));
    setViewport(zoomSampleDetailWaveformViewport({
      viewport: current,
      clipDurationSec: props.clip.duration,
      sampleRate: sourceSampleRate(),
      anchorFraction,
      zoomFactor: Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY),
    }));
  };

  const draw = () => {
    const canvas = canvasRef;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = waveformWidthPx();
    const height = waveformHeightPx();
    const pxW = Math.floor(width * dpr);
    const pxH = Math.floor(height * dpr);
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const canvasColors = appPreferences.appearance.themeTokens();
    const timelineBackground = canvasColors["timeline-background"];
    const timelineGridMinor = canvasColors["timeline-grid-minor"];
    const timelineGridMajor = canvasColors["timeline-grid-major"];
    const clipAudio = canvasColors["clip-audio"];
    const currentViewport = viewport();
    const viewportDurationSec = currentViewport.endSec - currentViewport.startSec;

    ctx.fillStyle = timelineBackground;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = timelineGridMinor;
    ctx.lineWidth = 1;
    const beatDurationSec = secondsPerBeat();
    const visibleTimelineStartSec = props.clip.startSec + currentViewport.startSec;
    const visibleTimelineEndSec = props.clip.startSec + currentViewport.endSec;
    const firstBeat = Math.ceil(visibleTimelineStartSec / beatDurationSec) * beatDurationSec;
    for (
      let timelineSec = firstBeat;
      timelineSec <= visibleTimelineEndSec + 1e-6;
      timelineSec += beatDurationSec
    ) {
      const x = Math.round(((timelineSec - visibleTimelineStartSec) / Math.max(1e-6, viewportDurationSec)) * width) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    const renderSegments = waveform.renderSegments();
    const firstPopulatedSegment = renderSegments.find((segment) => (
      segment.mode === "peaks" ? segment.peaks.channels.length > 0 : segment.samples.channels.length > 0
    ));
    const visibleChannelCount = firstPopulatedSegment
      ? (firstPopulatedSegment.mode === "peaks" ? firstPopulatedSegment.peaks.channels.length : firstPopulatedSegment.samples.channels.length)
      : Math.max(1, props.clip.buffer?.numberOfChannels ?? props.clip.sourceChannelCount ?? 1);
    const contentTop = 16;
    const contentHeight = Math.max(1, height - 32);
    const channelHeight = contentHeight / visibleChannelCount;

    for (const segment of renderSegments) {
      if (segment.mode === "peaks") {
        for (let channel = 0; channel < segment.peaks.channels.length; channel += 1) {
          const peaks = segment.peaks.channels[channel];
          if (!peaks) continue;
          drawWaveformPeaks({
            ctx,
            peaks,
            drawCols: segment.peaks.columns,
            padPx: segment.drawStartPx,
            topY: contentTop + channel * channelHeight,
            contentH: channelHeight,
            cssW: width,
            cssH: height,
            fillStyle: clipAudio,
            boundaryStyle: timelineGridMajor,
            drawBoundary: false,
          });
        }
        continue;
      }

      drawWaveformSamples({
        ctx,
        samples: segment.samples,
        padPx: 0,
        drawStartPx: segment.drawStartPx,
        drawWidthPx: segment.drawCols,
        topY: contentTop,
        contentH: contentHeight,
        cssW: width,
        strokeStyle: clipAudio,
        pointStyle: clipAudio,
        showPoints: segment.showPoints,
      });
    }

    ctx.strokeStyle = timelineGridMajor;
    ctx.lineWidth = 1;
    for (let channel = 0; channel < visibleChannelCount; channel += 1) {
      const centerY = contentTop + channel * channelHeight + channelHeight / 2;
      ctx.beginPath();
      ctx.moveTo(0, Math.floor(centerY) + 0.5);
      ctx.lineTo(width, Math.floor(centerY) + 0.5);
      ctx.stroke();
    }
  };

  createEffect(() => {
    draw();
  });

  return (
    <div
      class="flex h-full min-w-0 flex-1 flex-col gap-2 overflow-hidden bg-timeline-background px-3 py-2"
      style={{ "min-width": `${WAVEFORM_PANEL_MIN_WIDTH_PX}px` }}
    >
      <div class="flex items-center justify-between gap-3">
        <div>
          <div class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Beat Grid</div>
          <div class="text-xs text-muted-foreground">
            {props.clip.audioWarp?.enabled === true ? "Warp follows source BPM timing" : "Warp off, grid follows project BPM"}
          </div>
        </div>
        <div class="flex items-center gap-2 text-xs text-muted-foreground">
          {waveform.loading() ? <span>Loading waveform</span> : null}
          {props.clip.mediaStatus === "permission-denied" ? <span>Permission needed</span> : props.clip.mediaStatus === "missing" ? <span>Missing media</span> : null}
          <button
            type="button"
            class="rounded border border-border px-2 py-1 text-foreground hover:bg-secondary"
            onClick={fitViewport}
          >
            Fit
          </button>
        </div>
      </div>
      <div
        ref={(el) => { canvasWrapRef = el || undefined; }}
        class="relative min-h-0 min-w-0 flex-1 overflow-hidden"
      >
        <canvas
          ref={(el) => {
            canvasRef = el || undefined;
          }}
          class="h-full w-full"
          on:wheel={handleWheel}
          onDblClick={addMarker}
          onKeyDown={(event) => {
            if (event.key !== "Delete" && event.key !== "Backspace") return;
            event.preventDefault();
            deleteSelectedMarker();
          }}
          tabIndex={0}
        />
        <For each={warpMarkers()}>
          {(marker, index) => {
            const preview = createMemo(() => dragMarker()?.id === marker.id ? dragMarker() ?? marker : marker);
            const markerLeft = createMemo(() => sampleDetailWaveformXAtTime({
              viewport: viewport(),
              timeSec: clipAudioStartSec() + preview().timelineBeat * secondsPerBeat(),
              widthPx: waveformWidthPx(),
            }));
            return (
              <button
                type="button"
                aria-label="Warp marker"
                disabled={!props.canWrite || props.clip.audioWarp?.enabled !== true}
                class="absolute top-0 h-full w-3 -translate-x-1/2 border-x border-amber-300/80 bg-amber-400/10 disabled:opacity-50"
                classList={{ "bg-amber-300/30": selectedMarkerId() === marker.id }}
                style={{ left: `${markerLeft()}px` }}
                onClick={() => setSelectedMarkerId(marker.id)}
                onKeyDown={(event) => {
                  if (event.key !== "Delete" && event.key !== "Backspace") return;
                  event.preventDefault();
                  deleteSelectedMarker();
                }}
                onPointerDown={(event) => {
                  if (!props.canWrite || props.clip.audioWarp?.enabled !== true || !canvasRef) return;
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setSelectedMarkerId(marker.id);
                  setDragMarker(marker);
                  props.onMarkerDragStateChange?.(true);
                }}
                onPointerMove={(event) => {
                  if (dragMarker()?.id !== marker.id || !canvasRef) return;
                  const beat = beatFromPointer(event);
                  const markers = warpMarkers();
                  const previous = markers[index() - 1];
                  const next = markers[index() + 1];
                  const lower = previous ? previous.timelineBeat + MIN_MARKER_GAP_BEATS : 0;
                  const upper = next
                    ? next.timelineBeat - MIN_MARKER_GAP_BEATS
                    : getClipBeatWidth(Math.max(0, props.clip.duration - clipAudioStartSec()), props.projectBpm);
                  const timelineBeat = Math.min(upper, Math.max(lower, beat));
                  const current = dragMarker();
                  if (current?.timelineBeat === timelineBeat && current.sourceBeat === marker.sourceBeat) return;
                  setDragMarker({ id: marker.id, timelineBeat, sourceBeat: marker.sourceBeat });
                }}
                onPointerUp={(event) => {
                  const dragged = dragMarker();
                  if (!dragged || dragged.id !== marker.id) return;
                  setDragMarker(undefined);
                  props.onMarkerDragStateChange?.(false);
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                  if (dragged.timelineBeat === marker.timelineBeat && dragged.sourceBeat === marker.sourceBeat) return;
                  commitMarkers(warpMarkers().map((entry) => entry.id === marker.id ? dragged : entry));
                }}
                onPointerCancel={(event) => {
                  if (dragMarker()?.id !== marker.id) return;
                  setDragMarker(undefined);
                  props.onMarkerDragStateChange?.(false);
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                }}
                onLostPointerCapture={() => {
                  if (dragMarker()?.id !== marker.id) return;
                  setDragMarker(undefined);
                  props.onMarkerDragStateChange?.(false);
                }}
              />
            );
          }}
        </For>
        {props.clip.audioWarp?.enabled === true && !markerWarpActive() && (
          <div
            class="pointer-events-none absolute top-0 h-full"
            style={{ left: `${markerX()}px` }}
            data-warp-marker-dragging={isDraggingMarker() ? "true" : undefined}
          >
            <div class={isDraggingMarker() ? "h-full w-px bg-sky-300" : "h-full w-px bg-sky-400/80"} />
            <button
              ref={(el) => {
                markerHandleRef = el || undefined;
              }}
              type="button"
              aria-label="Drag beat offset marker"
              class="pointer-events-auto absolute -left-2 top-0 h-4 w-4 border border-sky-300 bg-timeline-background hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
              classList={{ "bg-sky-400": isDraggingMarker() }}
              disabled={!props.canWrite}
              onPointerDown={(event) => {
                if (!props.canWrite) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                setIsDraggingMarker(true);
                props.onMarkerDragStateChange?.(true);
                setDragPreviewOffset(previewOffsetFromPointer(event));
              }}
              onPointerMove={(event) => {
                if (!isDraggingMarker()) return;
                event.preventDefault();
                setDragPreviewOffset(previewOffsetFromPointer(event));
              }}
              onPointerUp={(event) => {
                if (!isDraggingMarker()) return;
                event.preventDefault();
                const nextOffset = previewOffsetFromPointer(event);
                setIsDraggingMarker(false);
                props.onMarkerDragStateChange?.(false);
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
                setDragPreviewOffset(undefined);
                commitSourceBeatOffset(nextOffset);
              }}
              onPointerCancel={(event) => {
                if (!isDraggingMarker()) return;
                setIsDraggingMarker(false);
                props.onMarkerDragStateChange?.(false);
                setDragPreviewOffset(undefined);
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
              }}
              onLostPointerCapture={() => {
                if (!isDraggingMarker()) return;
                setIsDraggingMarker(false);
                props.onMarkerDragStateChange?.(false);
                setDragPreviewOffset(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Escape" || !isDraggingMarker()) return;
                event.preventDefault();
                event.stopPropagation();
                setIsDraggingMarker(false);
                props.onMarkerDragStateChange?.(false);
                setDragPreviewOffset(undefined);
                markerHandleRef?.blur();
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default SampleDetailWaveform;
