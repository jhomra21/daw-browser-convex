import type { Component } from "solid-js";
import type { GranularParams, SamplerZone } from "@daw-browser/shared";
import EffectShell from "~/components/effects/EffectShell";
import { parseSampleDragData, SAMPLE_DRAG_DATA_TYPE } from "~/lib/sample-drag-data";
import type { GranularLoadStatus } from "~/lib/sampler-buffer-sync";

type GranularProps = {
  params: GranularParams;
  status?: GranularLoadStatus;
  canWrite: boolean;
  onReset: () => void;
  onRetry: () => void;
  onUpdate: (updates: Partial<GranularParams>) => void;
};

const Granular: Component<GranularProps> = (props) => {
  const drop = (event: DragEvent) => {
    if (!props.canWrite) return;
    const raw = event.dataTransfer?.getData(SAMPLE_DRAG_DATA_TYPE);
    const sample = raw ? parseSampleDragData(raw) : undefined;
    if (!sample) return;
    event.preventDefault();
    const zone: SamplerZone = {
      id: crypto.randomUUID(), sample, keyLow: 0, keyHigh: 127, velocityLow: 1, velocityHigh: 127,
      rootNote: 60, tuneCents: 0, gain: 1, pan: 0, roundRobinGroup: 0, roundRobinIndex: 0,
      playbackMode: "one-shot", startSec: 0, endSec: sample.source.durationSec, crossfadeSec: 0, chokeGroup: 0,
    };
    props.onUpdate({ zone });
  };
  return (
    <EffectShell title="Granular" typeLabel="Instrument" onReset={props.onReset} disabled={!props.canWrite}  class="w-176 min-w-176">
      <div class="flex h-full flex-col gap-3 p-3 text-xs text-muted-foreground">
        <div class="flex items-center gap-3">
          <span class="max-w-48 truncate text-foreground">{props.params.zone?.sample.name ?? props.params.zone?.sample.assetKey ?? "No sample"}</span>
          <button disabled={!props.params.zone || props.status?.state === "ready"} onClick={() => props.onRetry()}>{props.status?.state ?? "missing"}</button>
          <span>{Math.round((props.status?.totalBytes ?? 0) / 1048576)} / {Math.round((props.status?.maxBytes ?? props.params.maxDecodedBytes) / 1048576)} MB</span>
        </div>
        <div class="border border-dashed border-border p-2" onDragOver={(event) => { if (props.canWrite && event.dataTransfer?.types.includes(SAMPLE_DRAG_DATA_TYPE)) event.preventDefault(); }} onDrop={drop}>
          Drop a sample to replace the granular source
        </div>
        <div class="grid grid-cols-4 gap-2">
          <label>Grain ms <input type="number" min="5" max="1000" value={props.params.grainSizeMs} onChange={(event) => props.onUpdate({ grainSizeMs: Number(event.currentTarget.value) })} /></label>
          <label>Density Hz <input type="number" min="0.25" max="200" step="0.25" value={props.params.densityHz} onChange={(event) => props.onUpdate({ densityHz: Number(event.currentTarget.value) })} /></label>
          <label>Position <input type="number" min="0" max="1" step="0.01" value={props.params.position} onChange={(event) => props.onUpdate({ position: Number(event.currentTarget.value) })} /></label>
          <label>Spray <input type="number" min="0" max="1" step="0.01" value={props.params.spray} onChange={(event) => props.onUpdate({ spray: Number(event.currentTarget.value) })} /></label>
          <label>Pitch <input type="number" min="-48" max="48" step="0.1" value={props.params.pitchSemitones} onChange={(event) => props.onUpdate({ pitchSemitones: Number(event.currentTarget.value) })} /></label>
          <label>Reverse <input type="number" min="0" max="1" step="0.01" value={props.params.reverseProbability} onChange={(event) => props.onUpdate({ reverseProbability: Number(event.currentTarget.value) })} /></label>
          <label>Spread <input type="number" min="0" max="1" step="0.01" value={props.params.stereoSpread} onChange={(event) => props.onUpdate({ stereoSpread: Number(event.currentTarget.value) })} /></label>
          <label>Seed <input type="number" min="1" max="2147483647" value={props.params.seed} onChange={(event) => props.onUpdate({ seed: Number(event.currentTarget.value) })} /></label>
          <label>Window <select value={props.params["windowShape"]} onChange={(event) => props.onUpdate({ ["windowShape"]: event.currentTarget.value === "tukey" ? "tukey" : event.currentTarget.value === "gaussian" ? "gaussian" : "hann" })}><option value="hann">Hann</option><option value="tukey">Tukey</option><option value="gaussian">Gaussian</option></select></label>
          <label class="flex items-center gap-1"><input type="checkbox" checked={props.params.freeze} onChange={(event) => props.onUpdate({ freeze: event.currentTarget.checked })} /> Freeze</label>
        </div>
      </div>
    </EffectShell>
  );
};

export default Granular;
