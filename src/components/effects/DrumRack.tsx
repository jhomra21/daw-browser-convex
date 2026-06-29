import { createEffect, createSignal, For, Show, type Component } from "solid-js";
import {
  assignSampleToDrumRackPad,
  getDrumRackPadNoteLabel,
  type DrumRackPadParams,
  type DrumRackParams,
  type DrumRackSampleAssignment,
} from "@daw-browser/shared";
import type { AudioEngine } from "@daw-browser/audio-engine/audio-engine";
import { createSampleBufferLoader } from "~/lib/sample-buffer-loader";
import { parseSampleDragData, SAMPLE_DRAG_DATA_TYPE, type SampleDragData } from "~/lib/sample-drag-data";

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

const sampleKey = (sample: DrumRackSampleAssignment | undefined) => sample
  ? [
    sample.assetKey,
    sample.url,
    sample.sourceKind,
    sample.source.durationSec,
    sample.source.sampleRate,
    sample.source.channelCount,
  ].join("\n")
  : undefined;

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
    const cachedBuffer = cachedState.targetId === targetId && cachedState.sampleKeys.get(pad.id) === key
      ? cachedState.buffers.get(pad.id)
      : undefined;
    if (cachedBuffer) {
      props.audioEngine.setTrackDrumRack(targetId, params, cachedState.buffers);
      return true;
    }

    const buffer = await loadPadBuffer(targetId, pad);
    if (!buffer) return false;
    let nextBuffers: ReadonlyMap<string, AudioBuffer> | undefined;
    setBufferState((current) => {
      const pruned = pruneBufferState(current, targetId, params);
      const buffers = new Map(pruned.buffers);
      const sampleKeys = new Map(pruned.sampleKeys);
      buffers.set(pad.id, buffer);
      sampleKeys.set(pad.id, key);
      nextBuffers = buffers;
      return { targetId, buffers, sampleKeys };
    });
    if (!nextBuffers) return false;
    props.audioEngine.setTrackDrumRack(targetId, params, nextBuffers);
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
    const params = props.params;
    const assignment = sampleToAssignment(sample);
    props.onAssignSampleToPad(pad.id, assignment);
    const buffer = await loader.load(assignment.url, (data) => props.audioEngine.decodeAudioData(data));
    if (!buffer || props.targetId !== targetId) return;
    const key = sampleKey(assignment);
    if (!key) return;
    let nextBuffers: ReadonlyMap<string, AudioBuffer> | undefined;
    setBufferState((current) => {
      const nextParams = assignSampleToDrumRackPad(params, pad.id, assignment);
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
      assignSampleToDrumRackPad(params, pad.id, assignment),
      nextBuffers,
    );
  };

  return (
    <div class="flex h-full min-w-[34rem] border border-neutral-800 bg-neutral-950 text-xs text-neutral-300">
      <div class="flex w-72 flex-col border-r border-neutral-800 p-3">
        <div class="flex items-center justify-between">
          <div>
            <div class="font-medium text-neutral-100">Drum Rack</div>
            <div class="text-[10px] uppercase tracking-[0.18em] text-neutral-500">16 pads</div>
          </div>
          <button
            class="border border-neutral-700 bg-neutral-900 px-2 py-1 text-[10px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
            disabled={!props.canWrite}
            onClick={props.onReset}
          >
            Reset
          </button>
        </div>

        <div class="mt-3 grid grid-cols-4 gap-1.5">
          <For each={props.params.pads}>
            {(pad) => (
              <button
                class="flex h-14 flex-col justify-between border border-neutral-800 bg-neutral-900 p-1.5 text-left text-[10px] text-neutral-400 hover:border-neutral-600 hover:bg-neutral-800"
                classList={{
                  "border-cyan-500 bg-cyan-950/30 text-cyan-100": pad.id === selectedPadId(),
                  "opacity-45": pad.mute,
                }}
                onClick={() => setSelectedPadId(pad.id)}
                onDblClick={() => previewPad(pad)}
                onDragOver={(event) => {
                  if (!props.canWrite) return;
                  if (!event.dataTransfer?.types.includes(SAMPLE_DRAG_DATA_TYPE)) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                }}
                onDrop={(event) => {
                  if (!props.canWrite) return;
                  const raw = event.dataTransfer?.getData(SAMPLE_DRAG_DATA_TYPE);
                  if (!raw) return;
                  const sample = parseSampleDragData(raw);
                  if (!sample) return;
                  event.preventDefault();
                  setSelectedPadId(pad.id);
                  void assignSample(pad, sample);
                }}
              >
                <span class="truncate text-neutral-200">{padDisplayName(pad)}</span>
                <span class="text-neutral-500">{getDrumRackPadNoteLabel(pad.note)}</span>
              </button>
            )}
          </For>
        </div>
      </div>

      <Show when={selectedPad()}>
        {(pad) => (
          <div class="flex w-72 flex-col p-3">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="truncate font-medium text-neutral-100">{padDisplayName(pad())}</div>
                <div class="mt-1 text-[10px] uppercase tracking-[0.18em] text-neutral-500">
                  {getDrumRackPadNoteLabel(pad().note)} · {formatSampleLength(pad())}
                </div>
              </div>
              <button
                class="border border-neutral-700 bg-neutral-900 px-2 py-1 text-[10px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
                disabled={!pad().sample || pad().mute || loadingPadId() === pad().id}
                onClick={() => void previewPad(pad())}
              >
                {loadingPadId() === pad().id ? "Loading" : "Preview"}
              </button>
            </div>

            <div class="mt-4 flex flex-1 flex-col justify-between border border-neutral-800 bg-neutral-900/60 p-3">
              <div>
                <div class="text-[10px] uppercase tracking-[0.18em] text-neutral-500">Sample</div>
                <div class="mt-2 truncate text-neutral-200">{pad().sample?.name ?? "Drop a sample on a pad"}</div>
                <div class="mt-1 truncate text-[10px] text-neutral-500">{pad().sample?.assetKey ?? "Empty pads show note labels only"}</div>
              </div>

              <div class="mt-4 grid grid-cols-2 gap-2 text-[10px] text-neutral-400">
                <div class="border border-neutral-800 bg-neutral-950 p-2">
                  <div class="text-neutral-500">Gain</div>
                  <div class="mt-1 text-neutral-200">{pad().gain.toFixed(2)}</div>
                </div>
                <div class="border border-neutral-800 bg-neutral-950 p-2">
                  <div class="text-neutral-500">Pan</div>
                  <div class="mt-1 text-neutral-200">{pad().pan.toFixed(2)}</div>
                </div>
                <div class="border border-neutral-800 bg-neutral-950 p-2">
                  <div class="text-neutral-500">Transpose</div>
                  <div class="mt-1 text-neutral-200">{pad().transpose} st</div>
                </div>
                <div class="border border-neutral-800 bg-neutral-950 p-2">
                  <div class="text-neutral-500">Mute</div>
                  <button
                    class="mt-1 text-neutral-200 hover:text-cyan-200 disabled:hover:text-neutral-200"
                    disabled={!props.canWrite}
                    onClick={() => props.onUpdatePad(pad().id, { mute: !pad().mute })}
                  >
                    {pad().mute ? "On" : "Off"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
};

export default DrumRack;
