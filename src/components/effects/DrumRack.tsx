import { createEffect, createSignal, For, onCleanup, Show, type Component } from "solid-js";
import { drawWaveformPeaks } from "@daw-browser/waveforms/render-waveform";
import { getWaveformSlice } from "@daw-browser/waveforms/select-waveform-window";
import {
  getDrumRackPadNoteLabel,
  type DrumRackPadParams,
  type DrumRackParams,
  type DrumRackSampleAssignment,
} from "@daw-browser/shared";
import type { AudioEngine } from "@daw-browser/audio-engine/audio-engine";
import EffectShell from "~/components/effects/EffectShell";
import { DeviceToggleButton } from "~/components/ui/device-control";
import Knob from "~/components/ui/knob";
import { drumRackSampleKey } from "~/lib/drum-rack-buffer-sync";
import { createSampleBufferLoader } from "~/lib/sample-buffer-loader";
import { parseSampleDragData, SAMPLE_DRAG_DATA_TYPE, type SampleDragData } from "~/lib/sample-drag-data";
import { cn } from "~/lib/utils";

type DrumRackProps = {
  params: DrumRackParams;
  targetId: string;
  audioEngine: AudioEngine;
  canWrite: boolean;
  onAssignSampleToPad: (padId: string, sample: DrumRackSampleAssignment) => void;
  onReset: () => void;
  onUpdatePad: (padId: string, updates: Partial<DrumRackPadParams>) => void;
};

type DrumRackBufferState = {
  targetId: string;
  buffers: ReadonlyMap<string, AudioBuffer>;
  sampleKeys: ReadonlyMap<string, string>;
};

const sampleToAssignment = (sample: SampleDragData): DrumRackSampleAssignment => ({
  assetKey: sample.assetKey,
  url: sample.url,
  name: sample.name,
  sourceKind: sample.sourceKind,
  source: sample.source,
});

const formatSampleLength = (pad: DrumRackPadParams) => {
  const duration = pad.sample?.source.durationSec;
  if (!duration) return "Empty";
  return `${duration.toFixed(duration < 10 ? 2 : 1)}s`;
};

const padDisplayName = (pad: DrumRackPadParams) => pad.name ?? getDrumRackPadNoteLabel(pad.note);

const sampleKey = (sample: DrumRackSampleAssignment | undefined) => sample ? drumRackSampleKey(sample) : undefined;

const createEmptyBufferState = (targetId: string): DrumRackBufferState => ({
  targetId,
  buffers: new Map(),
  sampleKeys: new Map(),
});

const pruneBufferState = (state: DrumRackBufferState, targetId: string, params: DrumRackParams): DrumRackBufferState => {
  if (state.targetId !== targetId) return createEmptyBufferState(targetId);
  const nextBuffers = new Map<string, AudioBuffer>();
  const nextKeys = new Map<string, string>();
  for (const pad of params.pads) {
    const key = sampleKey(pad.sample);
    const buffer = state.buffers.get(pad.id);
    if (!key || !buffer || state.sampleKeys.get(pad.id) !== key) continue;
    nextBuffers.set(pad.id, buffer);
    nextKeys.set(pad.id, key);
  }
  return nextBuffers.size === state.buffers.size ? state : { targetId, buffers: nextBuffers, sampleKeys: nextKeys };
};

const loader = createSampleBufferLoader();
const CHOKE_GROUPS = Array.from({ length: 16 }, (_, index) => index + 1);
const SAMPLE_WAVEFORM_BINS = 360;

const formatPan = (value: number) => {
  if (value === 0) return "C";
  return `${value < 0 ? "L" : "R"}${Math.round(Math.abs(value) * 100)}`;
};

const formatTranspose = (value: number) => `${value > 0 ? "+" : ""}${value} st`;

const formatSampleRate = (sampleRate: number) => `${Math.round(sampleRate / 1000)}kHz`;

const sampleChannelLabel = (channelCount: number) => channelCount === 1 ? "Mono" : "Stereo";

const SampleWaveform: Component<{
  sample: DrumRackSampleAssignment;
  buffer: AudioBuffer | undefined;
}> = (props) => {
  let canvasRef: HTMLCanvasElement | undefined;
  const [peaks, setPeaks] = createSignal<Uint8Array | null>(null);
  const [canvasSize, setCanvasSize] = createSignal({ width: SAMPLE_WAVEFORM_BINS, height: 56 });
  let waveformRequestKey: string | undefined;

  createEffect(() => {
    const sample = props.sample;
    const buffer = props.buffer;
    const nextRequestKey = `${drumRackSampleKey(sample)}\n${buffer ? String(buffer.length) : "url"}`;
    if (waveformRequestKey === nextRequestKey) return;
    waveformRequestKey = nextRequestKey;
    let cancelled = false;
    setPeaks(null);
    void getWaveformSlice({
      assetKey: sample.assetKey,
      sourceIdentity: {
        assetKey: sample.assetKey,
        durationSec: sample.source.durationSec,
        sampleRate: sample.source.sampleRate,
        channelCount: sample.source.channelCount,
      },
      sampleUrl: sample.url,
      buffer,
      sourceStartSec: 0,
      sourceEndSec: sample.source.durationSec,
      bins: SAMPLE_WAVEFORM_BINS,
    }).then((nextPeaks) => {
      if (!cancelled) setPeaks(nextPeaks);
    }, () => {
      if (!cancelled) setPeaks(null);
    });
    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    const canvas = canvasRef;
    if (!canvas) return;
    const updateSize = () => {
      const width = Math.max(1, Math.floor(canvas.clientWidth || SAMPLE_WAVEFORM_BINS));
      const height = Math.max(1, Math.floor(canvas.clientHeight || 56));
      setCanvasSize((current) => current.width === width && current.height === height ? current : { width, height });
    };
    updateSize();
    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(canvas);
    onCleanup(() => resizeObserver.disconnect());
  });

  createEffect(() => {
    const canvas = canvasRef;
    if (!canvas) return;
    const { width: cssW, height: cssH } = canvasSize();
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
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cssW, cssH);

    const data = peaks();
    if (!data) {
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      for (let x = 0; x < cssW; x += 7) {
        ctx.beginPath();
        ctx.moveTo(x, cssH);
        ctx.lineTo(Math.min(cssW, x + 7), 0);
        ctx.stroke();
      }
      return;
    }

    const drawCols = Math.min(Math.floor(data.length / 2), cssW);
    drawWaveformPeaks({
      ctx,
      peaks: data,
      drawCols,
      padPx: 0,
      topY: 0,
      contentH: cssH,
      cssW,
      cssH,
    });
  });

  return (
    <canvas
      ref={canvasRef}
      class="h-16 w-full opacity-80"
      aria-label={`${props.sample.name} waveform`}
    />
  );
};

const DrumRack: Component<DrumRackProps> = (props) => {
  const [selectedPadId, setSelectedPadId] = createSignal(props.params.selectedPadId ?? props.params.pads[0]?.id);
  const [loadingPadId, setLoadingPadId] = createSignal<string>();
  const [bufferState, setBufferState] = createSignal<DrumRackBufferState>(createEmptyBufferState(props.targetId));

  createEffect(() => {
    const next = props.params.selectedPadId;
    if (next) setSelectedPadId(next);
  });

  createEffect(() => {
    const targetId = props.targetId;
    const params = props.params;
    setBufferState((current) => pruneBufferState(current, targetId, params));
  });

  const selectedPad = () => props.params.pads.find((pad) => pad.id === selectedPadId()) ?? props.params.pads[0];
  const readCachedPadBuffer = (targetId: string, pad: DrumRackPadParams) => {
    const key = sampleKey(pad.sample);
    const state = bufferState();
    if (!key || state.targetId !== targetId || state.sampleKeys.get(pad.id) !== key) return undefined;
    return state.buffers.get(pad.id);
  };
  const currentPadSampleKey = (padId: string) => sampleKey(props.params.pads.find((pad) => pad.id === padId)?.sample);

  const loadPadBuffer = async (targetId: string, pad: DrumRackPadParams) => {
    const sample = pad.sample;
    if (!sample) return undefined;
    setLoadingPadId(pad.id);
    const buffer = await loader.load(sample.url, (data) => props.audioEngine.decodeAudioData(data));
    if (loadingPadId() === pad.id) setLoadingPadId(undefined);
    if (props.targetId !== targetId) return undefined;
    return buffer ?? undefined;
  };

  const syncPadBuffer = async (pad: DrumRackPadParams) => {
    const targetId = props.targetId;
    const params = props.params;
    const key = sampleKey(pad.sample);
    if (!key) return false;

    const cachedState = bufferState();
    const cachedBuffer = readCachedPadBuffer(targetId, pad);
    if (cachedBuffer) {
      props.audioEngine.setTrackDrumRack(targetId, params, cachedState.buffers);
      return true;
    }

    const buffer = await loadPadBuffer(targetId, pad);
    if (!buffer) return false;
    if (currentPadSampleKey(pad.id) !== key) return false;
    const nextParams = props.params;
    let nextBuffers: ReadonlyMap<string, AudioBuffer> | undefined;
    setBufferState((current) => {
      const pruned = pruneBufferState(current, targetId, nextParams);
      const buffers = new Map(pruned.buffers);
      const sampleKeys = new Map(pruned.sampleKeys);
      buffers.set(pad.id, buffer);
      sampleKeys.set(pad.id, key);
      nextBuffers = buffers;
      return { targetId, buffers, sampleKeys };
    });
    if (!nextBuffers) return false;
    props.audioEngine.setTrackDrumRack(targetId, nextParams, nextBuffers);
    return true;
  };

  const previewPad = async (pad: DrumRackPadParams) => {
    if (!pad.sample || pad.mute) return;
    const didSync = await syncPadBuffer(pad);
    if (!didSync) return;
    props.audioEngine.previewDrumRackPad(props.targetId, pad.id, 1);
  };

  const assignSample = async (pad: DrumRackPadParams, sample: SampleDragData) => {
    const targetId = props.targetId;
    const assignment = sampleToAssignment(sample);
    props.onAssignSampleToPad(pad.id, assignment);
    const buffer = await loader.load(assignment.url, (data) => props.audioEngine.decodeAudioData(data));
    if (!buffer || props.targetId !== targetId) return;
    const key = sampleKey(assignment);
    if (!key) return;
    if (currentPadSampleKey(pad.id) !== key) return;
    const nextParams = props.params;
    let nextBuffers: ReadonlyMap<string, AudioBuffer> | undefined;
    setBufferState((current) => {
      const pruned = pruneBufferState(current, targetId, nextParams);
      const buffers = new Map(pruned.buffers);
      const sampleKeys = new Map(pruned.sampleKeys);
      buffers.set(pad.id, buffer);
      sampleKeys.set(pad.id, key);
      nextBuffers = buffers;
      return { targetId, buffers, sampleKeys };
    });
    if (!nextBuffers) return;
    props.audioEngine.setTrackDrumRack(
      targetId,
      nextParams,
      nextBuffers,
    );
  };

  const acceptsSampleDrop = (event: DragEvent) => {
    if (!props.canWrite) return false;
    return event.dataTransfer?.types.includes(SAMPLE_DRAG_DATA_TYPE) === true;
  };

  const handleSampleDragOver = (event: DragEvent) => {
    if (!acceptsSampleDrop(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  };

  const handleSampleDrop = (event: DragEvent, pad: DrumRackPadParams) => {
    if (!props.canWrite) return;
    const raw = event.dataTransfer?.getData(SAMPLE_DRAG_DATA_TYPE);
    if (!raw) return;
    const sample = parseSampleDragData(raw);
    if (!sample) return;
    event.preventDefault();
    setSelectedPadId(pad.id);
    void assignSample(pad, sample);
  };

  return (
    <EffectShell
      title="Drum Rack"
      typeLabel="Instrument"
      onReset={props.onReset}
      disabled={!props.canWrite}
      class="w-[38rem] min-w-[38rem]"
    >
      <div class="flex h-full min-h-0 text-xs text-neutral-300">
        <div class="flex w-72 flex-col border-r border-neutral-800 p-3">
          <div class="flex items-center justify-between">
            <div class="text-[10px] uppercase tracking-[0.18em] text-neutral-500">16 pads</div>
            <div class="text-[10px] text-neutral-600">
              {getDrumRackPadNoteLabel(props.params.pads[0]?.note ?? 36)}-{getDrumRackPadNoteLabel(props.params.pads[props.params.pads.length - 1]?.note ?? 51)}
            </div>
          </div>

          <div class="mt-3 grid grid-cols-4 gap-1.5">
            <For each={props.params.pads}>
              {(pad) => (
                <button
                  class={cn(
                    "relative flex h-14 flex-col justify-between border p-1.5 text-left text-[10px] transition-colors",
                    pad.id === selectedPadId()
                      ? "border-cyan-500/70 bg-cyan-950/30 text-cyan-100"
                      : pad.sample
                        ? "border-neutral-700 bg-neutral-800/80 text-neutral-300 hover:border-neutral-500"
                        : "border-neutral-800/60 bg-neutral-900/40 text-neutral-600 hover:border-neutral-700",
                    pad.mute && "opacity-40",
                  )}
                  onClick={() => setSelectedPadId(pad.id)}
                  onDblClick={() => previewPad(pad)}
                  onDragOver={handleSampleDragOver}
                  onDrop={(event) => handleSampleDrop(event, pad)}
                >
                  <span class={cn("truncate", pad.sample ? "text-neutral-200" : "text-neutral-500")}>{padDisplayName(pad)}</span>
                  <div class="flex items-center justify-between">
                    <span class="text-neutral-500">{getDrumRackPadNoteLabel(pad.note)}</span>
                    <Show when={pad.sample}>
                      <span class="h-1.5 w-1.5 rounded-full bg-cyan-400/60" />
                    </Show>
                  </div>
                </button>
              )}
            </For>
          </div>
        </div>

        <Show when={selectedPad()}>
          {(pad) => (
            <div class="flex min-w-0 flex-1 flex-col p-3">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="truncate font-medium text-neutral-100">{padDisplayName(pad())}</div>
                  <div class="mt-1 text-[10px] uppercase tracking-[0.18em] text-neutral-500">
                    {getDrumRackPadNoteLabel(pad().note)} · {formatSampleLength(pad())}
                  </div>
                </div>
                <button
                  class="flex h-6 w-6 shrink-0 items-center justify-center border border-neutral-700 bg-neutral-900 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-50"
                  disabled={!pad().sample || pad().mute || loadingPadId() === pad().id}
                  onClick={() => void previewPad(pad())}
                  title="Preview"
                >
                  <Show
                    when={loadingPadId() !== pad().id}
                    fallback={<span class="font-mono text-[10px] leading-none">...</span>}
                  >
                    <span class="ml-px h-0 w-0 border-y-[4px] border-l-[7px] border-y-transparent border-l-current" />
                  </Show>
                </button>
              </div>

              <div class="mt-3 flex min-h-0 flex-1 flex-col justify-between">
                <Show
                  when={pad().sample}
                  fallback={
                    <div
                      class="flex h-16 items-center justify-center border border-dashed border-neutral-700/50 bg-neutral-900/30 text-[10px] text-neutral-600"
                      onDragOver={handleSampleDragOver}
                      onDrop={(event) => handleSampleDrop(event, pad())}
                    >
                      Drop sample here
                    </div>
                  }
                >
                  {(sample) => (
                    <div
                      class="bg-neutral-950/80 px-2 py-2"
                      onDragOver={handleSampleDragOver}
                      onDrop={(event) => handleSampleDrop(event, pad())}
                    >
                      <SampleWaveform sample={sample()} buffer={readCachedPadBuffer(props.targetId, pad())} />
                      <div class="mt-1 flex items-center gap-2 text-[10px] leading-none text-neutral-500">
                        <span>{formatSampleLength(pad())}</span>
                        <span>{formatSampleRate(sample().source.sampleRate)}</span>
                        <span>{sampleChannelLabel(sample().source.channelCount)}</span>
                      </div>
                    </div>
                  )}
                </Show>

                <div class="grid grid-cols-4 items-start gap-1 px-1 pt-3">
                  <Knob
                    label="Gain"
                    valueLabel={pad().gain.toFixed(2)}
                    value={pad().gain}
                    resetValue={1}
                    min={0}
                    max={2}
                    step={0.01}
                    size={28}
                    disabled={!props.canWrite}
                    onValueChange={(gain) => props.onUpdatePad(pad().id, { gain })}
                  />
                  <Knob
                    label="Pan"
                    valueLabel={formatPan(pad().pan)}
                    value={pad().pan}
                    resetValue={0}
                    min={-1}
                    max={1}
                    step={0.01}
                    bipolar
                    size={28}
                    disabled={!props.canWrite}
                    onValueChange={(pan) => props.onUpdatePad(pad().id, { pan })}
                  />
                  <Knob
                    label="Tune"
                    valueLabel={formatTranspose(pad().transpose)}
                    value={pad().transpose}
                    resetValue={0}
                    min={-48}
                    max={48}
                    step={1}
                    bipolar
                    size={28}
                    disabled={!props.canWrite}
                    onValueChange={(transpose) => props.onUpdatePad(pad().id, { transpose })}
                  />
                  <div class="flex flex-col items-center gap-1">
                    <div class="text-xs font-medium leading-none text-neutral-400">Mute</div>
                    <DeviceToggleButton
                      label={pad().mute ? "On" : "Off"}
                      active={pad().mute}
                      disabled={!props.canWrite}
                      class="w-10"
                      onClick={() => props.onUpdatePad(pad().id, { mute: !pad().mute })}
                    />
                  </div>
                </div>

                <label class="mt-3 flex items-center gap-2 text-[10px]">
                  <span class="text-neutral-500">Choke</span>
                  <select
                    class="border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-neutral-200 disabled:cursor-not-allowed disabled:opacity-50"
                    value={pad().chokeGroup}
                    disabled={!props.canWrite}
                    onChange={(event) => props.onUpdatePad(pad().id, { chokeGroup: Number(event.currentTarget.value) })}
                  >
                    <option value={0}>Off</option>
                    <For each={CHOKE_GROUPS}>
                      {(group) => <option value={group}>{group}</option>}
                    </For>
                  </select>
                </label>
              </div>
            </div>
          )}
        </Show>
      </div>
    </EffectShell>
  );
};

export default DrumRack;
