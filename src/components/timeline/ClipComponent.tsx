import {
  type Component,
  createEffect,
} from "solid-js";

import { drawWaveformPeaks } from "@daw-browser/waveforms/render-waveform";
import { useClipWaveformViewModel } from "~/hooks/useClipWaveformViewModel";
import { LANE_HEIGHT, PPS } from "~/lib/timeline-utils";
import { cn } from "~/lib/utils";
import type { Clip, Track } from "@daw-browser/timeline-core/types";
import type { RuntimeClip } from "~/lib/timeline-runtime-types";

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
  onRetryMedia?: (clipId: string) => void;
  onReplaceMedia?: (trackId: Track["id"], clipId: string) => void;
  onRemoveMissingMedia?: (trackId: Track["id"], clipId: string) => void;
  ensureClipBuffer?: (clipId: string, sampleUrl?: string) => Promise<void>;
  bpm: number;
  viewportRedrawVersion: number;
};

// these values center waveform in clips container
const MIN_CLIP_PX = 6;
const WAVEFORM_PAD_Y = 6;
const AUDIO_WAVEFORM_BOX_H = 34;
const AUDIO_WAVEFORM_TOP_PX = 8;
const DOUBLE_TAP_MS = 700;
const DOUBLE_TAP_DISTANCE_PX = 8;
const SELECTED_TAP_MS = 700;
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
  let canvasRef: HTMLCanvasElement | undefined;
  let selectedTapStart:
    | { x: number; y: number; at: number }
    | undefined;

  const clipWidthPx = () =>
    Math.max(MIN_CLIP_PX, Math.floor(props.clip.duration * PPS));
  const handleWidthPx = () =>
    clipWidthPx() < 18 ? 2 : clipWidthPx() < 28 ? 3 : 6;

  const waveform = useClipWaveformViewModel({
    clip: () => props.clip,
    cssWidthPx: () => clipWidthPx(),
    projectBpm: () => props.bpm,
    ensureClipBuffer: props.ensureClipBuffer,
  });
  const isGhost = () => props.clip.id.startsWith("__dup_preview:");
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

    const cssW = clipWidthPx();
    const cssH = Math.max(1, Math.floor(LANE_HEIGHT - 1));

    const dpr = window.devicePixelRatio || 1;
    const pxW = Math.floor(cssW * dpr);
    const pxH = Math.floor(cssH * dpr);
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    (ctx as any).imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cssW, cssH);

    const padTop = WAVEFORM_PAD_Y;
    const padBottom = WAVEFORM_PAD_Y;
    const innerH = Math.max(1, cssH - padTop - padBottom);

    const midi: any = (props.clip as any).midi;
    if (midi && Array.isArray(midi.notes) && midi.notes.length > 0) {
      const spb = 60 / Math.max(1, props.bpm || 120);
      const midiOffsetBeats = Math.max(
        0,
        (props.clip as any).midiOffsetBeats ?? 0,
      );
      const color = props.isSelected
        ? "rgba(59,130,246,0.95)"
        : "rgba(34,197,94,0.95)";
      let minP = Infinity;
      let maxP = -Infinity;
      for (const note of midi.notes as Array<{ pitch: number }>) {
        if (typeof note.pitch !== "number") continue;
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
      for (const note of midi.notes as Array<{
        beat: number;
        length: number;
        pitch: number;
      }>) {
        const noteBeat = note.beat || 0;
        const trimmedBeats = Math.max(0, midiOffsetBeats - noteBeat);
        const effectiveLength = Math.max(0, (note.length || 0) - trimmedBeats);
        if (effectiveLength <= 0) continue;
        const startBeats = Math.max(0, noteBeat - midiOffsetBeats);
        const startSec = startBeats * spb;
        const endSec = Math.max(startSec, startSec + effectiveLength * spb);
        const left = Math.max(
          0,
          Math.min(
            cssW,
            Math.floor((startSec / Math.max(1e-6, props.clip.duration)) * cssW),
          ),
        );
        const right = Math.max(
          left + 1,
          Math.min(
            cssW,
            Math.floor((endSec / Math.max(1e-6, props.clip.duration)) * cssW),
          ),
        );
        const frac = 1 - (note.pitch - minP) / range;
        const centerY = padTop + Math.max(0, Math.min(1, frac)) * innerH;
        const yTop = Math.max(padTop, Math.floor(centerY - barH / 2));
        ctx.fillRect(left, yTop, Math.max(1, right - left), barH);
      }

      ctx.strokeStyle = "rgba(255,255,255,0.15)";
      ctx.lineWidth = 1;
      const bars = Math.max(1, Math.floor(props.clip.duration / (spb * 4)));
      for (let b = 1; b <= bars; b++) {
        const x =
          Math.floor(
            ((b * spb * 4) / Math.max(1e-6, props.clip.duration)) * cssW,
          ) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, padTop);
        ctx.lineTo(x, padTop + innerH);
        ctx.stroke();
      }
      return;
    }

    const layout = waveform.layout();
    const { padPx, drawCols, audioStartPx, audioEndPx } = layout;
    const peaks = waveform.peaks();
    if (drawCols <= 0) {
      ctx.fillStyle = "rgba(15,23,42,0.45)";
      ctx.fillRect(0, 0, cssW, cssH);
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.beginPath();
      ctx.moveTo(0, Math.floor(cssH / 2) + 0.5);
      ctx.lineTo(cssW, Math.floor(cssH / 2) + 0.5);
      ctx.stroke();
      return;
    }

    const silentFill = props.isSelected
      ? "rgba(15,23,42,0.42)"
      : "rgba(15,23,42,0.34)";
    if (audioStartPx > 0) {
      ctx.fillStyle = silentFill;
      ctx.fillRect(0, 0, Math.min(cssW, audioStartPx), cssH);
    }
    if (audioEndPx < cssW) {
      ctx.fillStyle = silentFill;
      ctx.fillRect(Math.max(0, audioEndPx), 0, cssW - Math.max(0, audioEndPx), cssH);
    }

    if (!peaks) {
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      for (let x = audioStartPx; x < audioEndPx; x += 6) {
        ctx.beginPath();
        ctx.moveTo(x, cssH);
        ctx.lineTo(Math.min(audioEndPx, x + 6), 0);
        ctx.stroke();
      }
      return;
    }

    const waveformBoxH = Math.max(
      16,
      Math.min(AUDIO_WAVEFORM_BOX_H, cssH - 16),
    );
    const waveformTop = Math.min(
      Math.max(WAVEFORM_PAD_Y, AUDIO_WAVEFORM_TOP_PX),
      Math.max(WAVEFORM_PAD_Y, cssH - waveformBoxH - WAVEFORM_PAD_Y),
    );

    drawWaveformPeaks({
      ctx,
      peaks,
      drawCols,
      padPx,
      topY: waveformTop,
      contentH: waveformBoxH,
      cssW,
      cssH,
    });
  }

  createEffect(() => {
    void props.clip.duration;
    void props.clip.buffer;
    void props.clip.sampleUrl;
    void props.clip.sourceAssetKey;
    void props.clip.leftPadSec;
    void props.clip.bufferOffsetSec;
    void props.clip.sourceDurationSec;
    void props.clip.sourceSampleRate;
    void props.clip.sourceChannelCount;
    void props.clip.audioWarp;
    void props.isSelected;
    const midi: any = (props.clip as any).midi;
    const midiSignature = Array.isArray(midi?.notes)
      ? midi.notes
          .map(
            (note: any) =>
              `${note.pitch ?? ""}/${note.beat ?? ""}/${note.length ?? ""}`,
          )
          .join("|")
      : "";
    void midiSignature;
    void props.bpm;
    void waveform.peaks();
    void props.viewportRedrawVersion;
    drawWaveform();
  });

  return (
    <div
      class={cn(
        "group absolute overflow-hidden border z-20 select-none",
        isGhost()
          ? "border-green-400/60 border-dashed bg-green-500/20 opacity-60 pointer-events-none"
          : props.isSelected
            ? "border-blue-400 bg-blue-500/25"
            : "border-green-500/60 bg-green-500/20 hover:bg-green-500/25 cursor-grab",
      )}
      style={{
        top: "0px",
        left: `${props.clip.startSec * PPS}px`,
        width: `${Math.max(MIN_CLIP_PX, props.clip.duration * PPS)}px`,
        height: `${LANE_HEIGHT - 1}px`,
      }}
      onPointerDown={(e) => {
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
      <div
        class="absolute inset-y-0 left-0 z-20 flex cursor-ew-resize items-center justify-center select-none text-xs text-neutral-200/80"
        style={{ width: `${handleWidthPx()}px` }}
        onPointerDown={(e) => {
          e.stopPropagation();
          props.onResizeStart(props.trackId, props.clip.id, "left", e);
        }}
      >
        <span class="opacity-0 group-hover:opacity-100 pointer-events-none">
          [
        </span>
      </div>
      <div
        class="absolute inset-y-0 right-0 z-20 flex cursor-ew-resize items-center justify-center select-none text-xs text-neutral-200/80"
        style={{ width: `${handleWidthPx()}px` }}
        onPointerDown={(e) => {
          e.stopPropagation();
          props.onResizeStart(props.trackId, props.clip.id, "right", e);
        }}
      >
        <span class="opacity-0 group-hover:opacity-100 pointer-events-none">
          ]
        </span>
      </div>

      <canvas
        ref={(el) => (canvasRef = el || undefined)}
        class="absolute inset-0 pointer-events-none z-0"
      />
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
              props.onRetryMedia?.(props.clip.id);
            }}
          >
            Retry
          </button>
          <button
            class="border border-red-300/40 px-1 py-0.5 text-[9px] text-red-50 hover:bg-red-300/20"
            onClick={(event) => {
              event.stopPropagation();
              props.onReplaceMedia?.(props.trackId, props.clip.id);
            }}
          >
            Replace
          </button>
          <button
            class="border border-red-300/40 px-1 py-0.5 text-[9px] text-red-50 hover:bg-red-300/20"
            onClick={(event) => {
              event.stopPropagation();
              props.onRemoveMissingMedia?.(props.trackId, props.clip.id);
            }}
          >
            Remove
          </button>
        </div>
      )}
      <div
        class={cn(
          "absolute left-0 right-0 top-0 z-20 pointer-events-none",
          isGhost() ? "bg-black/20" : "bg-black/35",
        )}
      >
        <div
          class="truncate p-1 text-xs leading-none text-white"
          style={{ "text-shadow": "0 1px 2px rgba(0,0,0,0.75)" }}
        >
          {props.clip.name}
        </div>
      </div>
    </div>
  );
};

export default ClipComponent;
