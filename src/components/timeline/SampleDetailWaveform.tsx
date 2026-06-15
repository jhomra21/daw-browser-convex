import { For, createEffect, createMemo, createSignal, type Component } from "solid-js";
import { drawWaveformPeaks } from "@daw-browser/waveforms/render-waveform";
import type { AudioWarp, Clip } from "@daw-browser/timeline-core/types";
import { mapTimelineBeatToSourceBeat } from "@daw-browser/shared";
import { useClipWaveformViewModel } from "~/hooks/useClipWaveformViewModel";
import { buildNextAudioWarp } from "~/lib/audio-warp-patch";
import { getAudioWaveformLayout, getSourceBeatOffsetAnchorX, getSourceBeatOffsetFromAnchorX } from "~/lib/audio-waveform-layout";

type SampleDetailWaveformProps = {
  clip: Clip<AudioBuffer>;
  projectBpm: number;
  ensureClipBuffer?: (clipId: string, sampleUrl?: string) => Promise<void>;
  canWrite: boolean;
  onMarkerDragStateChange?: (dragging: boolean) => void;
  onWarpChange: (audioWarp: AudioWarp) => Promise<boolean> | boolean | void;
};

const WAVEFORM_WIDTH_PX = 960;
const WAVEFORM_HEIGHT_PX = 108;
const MIN_MARKER_GAP_BEATS = 0.001;

const getClipBeatWidth = (clipDurationSec: number, projectBpm: number) => (
  clipDurationSec / (60 / Math.max(1, projectBpm))
);

const beatFromPointer = (event: Pick<PointerEvent, "clientX" | "altKey">, canvas: HTMLCanvasElement, clipDurationSec: number, projectBpm: number) => {
  const bounds = canvas.getBoundingClientRect();
  const x = Math.min(bounds.width, Math.max(0, event.clientX - bounds.left));
  const rawBeat = (x / Math.max(1, bounds.width)) * getClipBeatWidth(clipDurationSec, projectBpm);
  return event.altKey ? rawBeat : Math.round(rawBeat);
};

const SampleDetailWaveform: Component<SampleDetailWaveformProps> = (props) => {
  let canvasRef: HTMLCanvasElement | undefined;
  let markerHandleRef: HTMLButtonElement | undefined;
  const waveform = useClipWaveformViewModel({
    clip: () => props.clip,
    cssWidthPx: () => WAVEFORM_WIDTH_PX,
    projectBpm: () => props.projectBpm,
    ensureClipBuffer: props.ensureClipBuffer,
  });
  const [dragPreviewOffset, setDragPreviewOffset] = createSignal<number | undefined>();
  const [isDraggingMarker, setIsDraggingMarker] = createSignal(false);
  const sourceBeatOffset = createMemo(() => props.clip.audioWarp?.sourceBeatOffset ?? 0);
  const warpMarkers = createMemo(() => props.clip.audioWarp?.markers ?? []);
  const markerWarpActive = createMemo(() => warpMarkers().length >= 2);
  const [selectedMarkerId, setSelectedMarkerId] = createSignal<string>();
  const [dragMarker, setDragMarker] = createSignal<{ id: string; timelineBeat: number; sourceBeat: number }>();
  const visibleSourceBeatOffset = createMemo(() => dragPreviewOffset() ?? sourceBeatOffset());
  const markerX = createMemo(() => getSourceBeatOffsetAnchorX({
    sourceBeatOffset: visibleSourceBeatOffset(),
    clipDurationSec: props.clip.duration,
    cssWidthPx: WAVEFORM_WIDTH_PX,
    projectBpm: props.projectBpm,
    leftPadSec: props.clip.leftPadSec,
  }));

  const previewOffsetFromPointer = (event: PointerEvent) => {
    const canvas = canvasRef;
    if (!canvas) return sourceBeatOffset();
    const bounds = canvas.getBoundingClientRect();
    return getSourceBeatOffsetFromAnchorX({
      anchorX: event.clientX - bounds.left,
      clipDurationSec: props.clip.duration,
      cssWidthPx: bounds.width,
      projectBpm: props.projectBpm,
      leftPadSec: props.clip.leftPadSec,
      snap: !event.altKey,
    });
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
    const timelineBeat = beatFromPointer(event, canvasRef, props.clip.duration, props.projectBpm);
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

  const draw = () => {
    const canvas = canvasRef;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const pxW = Math.floor(WAVEFORM_WIDTH_PX * dpr);
    const pxH = Math.floor(WAVEFORM_HEIGHT_PX * dpr);
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, WAVEFORM_WIDTH_PX, WAVEFORM_HEIGHT_PX);
    ctx.fillStyle = "rgb(10, 10, 10)";
    ctx.fillRect(0, 0, WAVEFORM_WIDTH_PX, WAVEFORM_HEIGHT_PX);

    const layout = waveform.layout();
    const peaks = waveform.peaks();
    const sourceDurationSec = props.clip.buffer?.duration ?? props.clip.sourceDurationSec ?? 0;
    const fullLayout = getAudioWaveformLayout(
      props.clip,
      WAVEFORM_WIDTH_PX,
      sourceDurationSec,
      props.projectBpm,
    );

    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    const secondsPerBeat = 60 / Math.max(1, props.projectBpm);
    const firstBeat = Math.ceil(props.clip.startSec / secondsPerBeat) * secondsPerBeat;
    for (
      let timelineSec = firstBeat;
      timelineSec <= props.clip.startSec + props.clip.duration + 1e-6;
      timelineSec += secondsPerBeat
    ) {
      const x = Math.round(((timelineSec - props.clip.startSec) / Math.max(1e-6, props.clip.duration)) * WAVEFORM_WIDTH_PX) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, WAVEFORM_HEIGHT_PX);
      ctx.stroke();
    }

    if (!peaks || layout.drawCols <= 0) {
      ctx.strokeStyle = "rgba(255,255,255,0.14)";
      ctx.beginPath();
      ctx.moveTo(0, Math.floor(WAVEFORM_HEIGHT_PX / 2) + 0.5);
      ctx.lineTo(WAVEFORM_WIDTH_PX, Math.floor(WAVEFORM_HEIGHT_PX / 2) + 0.5);
      ctx.stroke();
      return;
    }

    drawWaveformPeaks({
      ctx,
      peaks,
      drawCols: layout.drawCols,
      padPx: layout.padPx,
      topY: 16,
      contentH: WAVEFORM_HEIGHT_PX - 32,
      cssW: WAVEFORM_WIDTH_PX,
      cssH: WAVEFORM_HEIGHT_PX,
    });

    ctx.strokeStyle = props.clip.audioWarp?.enabled === true ? "rgba(96,165,250,0.75)" : "rgba(34,197,94,0.65)";
    ctx.lineWidth = 1;
    ctx.strokeRect(fullLayout.audioStartPx + 0.5, 8.5, Math.max(0, fullLayout.audioEndPx - fullLayout.audioStartPx), WAVEFORM_HEIGHT_PX - 17);
  };

  createEffect(() => {
    void props.clip.id;
    void props.clip.duration;
    void props.clip.buffer;
    void props.clip.sampleUrl;
    void props.clip.sourceAssetKey;
    void props.clip.sourceKind;
    void props.clip.sourceDurationSec;
    void props.clip.audioWarp;
    void visibleSourceBeatOffset();
    void props.projectBpm;
    void waveform.peaks();
    draw();
  });

  return (
    <div class="flex min-w-[980px] flex-1 flex-col gap-2 overflow-hidden border border-neutral-800 bg-neutral-950 px-3 py-2">
      <div class="flex items-center justify-between gap-3">
        <div>
          <div class="text-xs font-semibold uppercase tracking-wide text-neutral-400">Beat Grid</div>
          <div class="text-xs text-neutral-500">
            {props.clip.audioWarp?.enabled === true ? "Warp follows source BPM timing" : "Warp off, grid follows project BPM"}
          </div>
        </div>
        <div class="text-xs text-neutral-500">
          {props.clip.mediaStatus === "permission-denied" ? "Permission needed" : props.clip.mediaStatus === "missing" ? "Missing media" : ""}
        </div>
      </div>
      <div class="relative h-[108px] w-[960px]">
        <canvas
          ref={(el) => {
            canvasRef = el || undefined;
          }}
          class="h-[108px] w-[960px] border border-neutral-800"
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
            const markerLeft = createMemo(() => (preview().timelineBeat / Math.max(1e-6, getClipBeatWidth(props.clip.duration, props.projectBpm))) * WAVEFORM_WIDTH_PX);
            return (
              <button
                type="button"
                aria-label="Warp marker"
                disabled={!props.canWrite || props.clip.audioWarp?.enabled !== true}
                class="absolute top-0 h-[108px] w-3 -translate-x-1/2 border-x border-amber-300/80 bg-amber-400/10 disabled:opacity-50"
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
                  const beat = beatFromPointer(event, canvasRef, props.clip.duration, props.projectBpm);
                  const markers = warpMarkers();
                  const previous = markers[index() - 1];
                  const next = markers[index() + 1];
                  const lower = previous ? previous.timelineBeat + MIN_MARKER_GAP_BEATS : 0;
                  const upper = next ? next.timelineBeat - MIN_MARKER_GAP_BEATS : getClipBeatWidth(props.clip.duration, props.projectBpm);
                  const timelineBeat = Math.min(upper, Math.max(lower, beat));
                  const current = dragMarker();
                  if (current?.timelineBeat === timelineBeat && current.sourceBeat === marker.sourceBeat) return;
                  setDragMarker({ id: marker.id, timelineBeat, sourceBeat: marker.sourceBeat });
                }}
                onPointerUp={(event) => {
                  const dragged = dragMarker();
                  if (!dragged || dragged.id !== marker.id) return;
                  event.currentTarget.releasePointerCapture(event.pointerId);
                  setDragMarker(undefined);
                  props.onMarkerDragStateChange?.(false);
                  if (dragged.timelineBeat === marker.timelineBeat && dragged.sourceBeat === marker.sourceBeat) return;
                  commitMarkers(warpMarkers().map((entry) => entry.id === marker.id ? dragged : entry));
                }}
                onPointerCancel={() => {
                  setDragMarker(undefined);
                  props.onMarkerDragStateChange?.(false);
                }}
              />
            );
          }}
        </For>
        {props.clip.audioWarp?.enabled === true && !markerWarpActive() && (
          <div
            class="pointer-events-none absolute top-0 h-[108px]"
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
              class="pointer-events-auto absolute -left-2 top-0 h-4 w-4 border border-sky-300 bg-neutral-950 hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
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
                event.currentTarget.releasePointerCapture(event.pointerId);
                setIsDraggingMarker(false);
                props.onMarkerDragStateChange?.(false);
                setDragPreviewOffset(undefined);
                commitSourceBeatOffset(nextOffset);
              }}
              onPointerCancel={(event) => {
                if (!isDraggingMarker()) return;
                event.currentTarget.releasePointerCapture(event.pointerId);
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
