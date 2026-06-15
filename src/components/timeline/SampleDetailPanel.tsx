import { createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js";
import type { AudioEngine } from "@daw-browser/audio-engine/audio-engine";
import type { AudioWarp, Clip } from "@daw-browser/timeline-core/types";
import { dbToLinearGain, linearGainToDb } from "@daw-browser/shared";
import { FX_PANEL_HEIGHT_PX } from "~/lib/timeline-utils";
import { SAMPLE_DETAIL_PANEL_DEFAULT_HEIGHT_PX, clampSampleDetailPanelHeight, loadSampleDetailPanelHeight, saveSampleDetailPanelHeight } from "~/lib/sample-detail-panel-preferences";
import type { BpmDetectionService } from "~/lib/bpm-detection-service";
import SampleClipPanel from "~/components/timeline/SampleClipPanel";
import SampleDetailWaveform from "~/components/timeline/SampleDetailWaveform";

type SampleDetailPanelProps = {
  clip: Clip<AudioBuffer>;
  preferenceScopeId?: string;
  projectBpm: number;
  audioEngine: AudioEngine;
  bpmDetection: BpmDetectionService;
  ensureClipBuffer: (clipId: string, sampleUrl?: string) => Promise<void>;
  canWriteClip: (clipId: string) => boolean;
  onWarpChange: (clip: Clip, audioWarp: AudioWarp) => Promise<boolean> | boolean | void;
  onGainChange: (clip: Clip, gain: number) => Promise<boolean> | boolean | void;
  onMarkerDragStateChange?: (dragging: boolean) => void;
  onClose: () => void;
};

const SampleDetailPanel: Component<SampleDetailPanelProps> = (props) => {
  const preferenceScopeId = () => props.preferenceScopeId ?? "default";
  const [height, setHeight] = createSignal(typeof window === "undefined" ? FX_PANEL_HEIGHT_PX : loadSampleDetailPanelHeight(preferenceScopeId(), window.innerHeight));
  const [dragStart, setDragStart] = createSignal<{ y: number; height: number }>();
  const gainDb = createMemo(() => linearGainToDb(props.clip.gain ?? 1));
  const gainLabel = createMemo(() => Number.isFinite(gainDb()) ? `${gainDb().toFixed(1)} dB` : "-inf dB");
  const canWrite = createMemo(() => props.canWriteClip(props.clip.id));

  const commitHeight = (value: number) => {
    setHeight(saveSampleDetailPanelHeight(preferenceScopeId(), value, window.innerHeight));
  };

  createEffect(() => {
    const start = dragStart();
    if (!start) return;
    const onMove = (event: PointerEvent) => setHeight(clampSampleDetailPanelHeight(start.height + start.y - event.clientY, window.innerHeight));
    const onUp = () => {
      commitHeight(height());
      setDragStart(undefined);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setHeight(start.height);
      setDragStart(undefined);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
    });
  });

  return (
  <div class="fixed left-0 right-0 bottom-0 z-50 border-t border-neutral-800 bg-neutral-900">
    <button
      type="button"
      aria-label="Resize sample detail panel"
      class="absolute left-0 right-0 top-0 h-2 cursor-ns-resize bg-neutral-800/60 hover:bg-sky-500/50"
      onDblClick={() => commitHeight(SAMPLE_DETAIL_PANEL_DEFAULT_HEIGHT_PX)}
      onPointerDown={(event) => {
        event.preventDefault();
        setDragStart({ y: event.clientY, height: height() });
      }}
    />
    <div class="flex gap-3 overflow-x-auto px-3 py-3" style={{ height: `${height()}px` }}>
      <div class="flex w-20 shrink-0 flex-col items-center gap-2 border-r border-neutral-800 pr-2">
        <button
          class="w-full border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-700"
          type="button"
          onClick={props.onClose}
        >
          Effects
        </button>
        <div class="flex flex-1 items-center justify-center">
          <span
            class="inline-flex text-sm font-semibold uppercase tracking-widest text-neutral-300"
            style={{ transform: "rotate(-90deg)", "white-space": "nowrap" }}
          >
            Sample Detail
          </span>
        </div>
      </div>
      <SampleClipPanel
        audioEngine={props.audioEngine}
        sample={{
          clip: props.clip,
          projectBpm: props.projectBpm,
          bpmDetection: props.bpmDetection,
          ensureClipBuffer: props.ensureClipBuffer,
          canWrite: canWrite(),
          onWarpChange: (audioWarp) => props.onWarpChange(props.clip, audioWarp),
        }}
      />
      <div class="flex w-32 shrink-0 flex-col gap-2 border border-neutral-800 bg-neutral-950 p-3 text-xs text-neutral-300">
        <div class="font-semibold uppercase tracking-wide text-neutral-400">Clip Gain</div>
        <input
          type="range"
          min="-60"
          max="6.02"
          step="0.1"
          value={Number.isFinite(gainDb()) ? gainDb() : -60}
          disabled={!canWrite()}
          onChange={(event) => {
            const db = Number(event.currentTarget.value);
            props.onGainChange(props.clip, db <= -60 ? 0 : dbToLinearGain(db));
          }}
        />
        <div>{gainLabel()}</div>
      </div>
      <SampleDetailWaveform
        clip={props.clip}
        projectBpm={props.projectBpm}
        ensureClipBuffer={props.ensureClipBuffer}
        canWrite={canWrite()}
        onMarkerDragStateChange={props.onMarkerDragStateChange}
        onWarpChange={(audioWarp) => props.onWarpChange(props.clip, audioWarp)}
      />
    </div>
  </div>
  );
};

export default SampleDetailPanel;
