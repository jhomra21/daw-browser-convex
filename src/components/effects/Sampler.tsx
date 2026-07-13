import { For, type Component } from "solid-js";
import type { SamplerParams, SamplerZone } from "@daw-browser/shared";
import EffectShell from "~/components/effects/EffectShell";
import { parseSampleDragData, SAMPLE_DRAG_DATA_TYPE } from "~/lib/sample-drag-data";
import type { SamplerLoadStatus } from "~/lib/sampler-buffer-sync";

type SamplerProps = {
  params: SamplerParams;
  status?: SamplerLoadStatus;
  canWrite: boolean;
  onAddZone: (zone: SamplerZone) => void;
  onRemoveZone: (zoneId: string) => void;
  onReset: () => void;
  onRetryZone: (zoneId: string) => void;
  onUpdate: (updates: Partial<SamplerParams>) => void;
  onUpdateZone: (zoneId: string, updates: Partial<SamplerZone>) => void;
};

const Sampler: Component<SamplerProps> = (props) => {
  const drop = (event: DragEvent) => {
    if (!props.canWrite) return;
    const raw = event.dataTransfer?.getData(SAMPLE_DRAG_DATA_TYPE);
    const sample = raw ? parseSampleDragData(raw) : undefined;
    if (!sample) return;
    event.preventDefault();
    props.onAddZone({
      id: crypto.randomUUID(),
      sample,
      keyLow: 0,
      keyHigh: 127,
      velocityLow: 1,
      velocityHigh: 127,
      rootNote: 60,
      tuneCents: 0,
      gain: 1,
      pan: 0,
      roundRobinGroup: 0,
      roundRobinIndex: 0,
      playbackMode: "one-shot",
      startSec: 0,
      endSec: sample.source.durationSec,
      crossfadeSec: 0,
      chokeGroup: 0,
    });
  };
  return (
    <EffectShell title="Sampler" typeLabel="Instrument" onReset={props.onReset} disabled={!props.canWrite}  class="w-176 min-w-176">
      <div class="flex h-full flex-col gap-2 p-3 text-xs text-muted-foreground">
        <div class="flex items-center gap-3">
          <label>Voices <input class="w-14 bg-app-surface px-1 text-foreground" type="number" min="1" max="128" value={props.params.polyphony} onChange={(event) => props.onUpdate({ polyphony: Number(event.currentTarget.value) })} /></label>
          <label>Cache <select class="bg-app-surface text-foreground" value={props.params.cachePolicy} onChange={(event) => props.onUpdate({ cachePolicy: event.currentTarget.value === "lazy" ? "lazy" : "preload" })}><option value="preload">Preload</option><option value="lazy">Lazy</option></select></label>
          <span>{props.params.zones.length} zones</span>
          <span>{Math.round((props.status?.totalBytes ?? 0) / 1048576)} / {Math.round((props.status?.maxBytes ?? props.params.maxDecodedBytes) / 1048576)} MB</span>
          <span>{props.status?.misses ?? 0} misses</span>
          <span classList={{ "text-destructive": props.status?.overBudgetPinned }}> {props.status?.overBudgetPinned ? "Over budget" : ""}</span>
        </div>
        <div class="min-h-14 border border-dashed border-border p-2" onDragOver={(event) => { if (props.canWrite && event.dataTransfer?.types.includes(SAMPLE_DRAG_DATA_TYPE)) event.preventDefault(); }} onDrop={drop}>
          Drop samples to add zones
        </div>
        <div class="min-h-0 flex-1 overflow-auto">
          <For each={props.params.zones}>
            {(zone) => (
              <div class="grid grid-cols-[1fr_repeat(5,4rem)_5rem_4rem_2rem] items-center gap-1 border-b border-border py-1">
                <span class="truncate text-foreground">{zone.sample.name ?? zone.sample.assetKey}</span>
                <input aria-label="Low key" type="number" min="0" max="127" value={zone.keyLow} onChange={(event) => props.onUpdateZone(zone.id, { keyLow: Number(event.currentTarget.value) })} />
                <input aria-label="High key" type="number" min="0" max="127" value={zone.keyHigh} onChange={(event) => props.onUpdateZone(zone.id, { keyHigh: Number(event.currentTarget.value) })} />
                <input aria-label="Low velocity" type="number" min="1" max="127" value={zone.velocityLow} onChange={(event) => props.onUpdateZone(zone.id, { velocityLow: Number(event.currentTarget.value) })} />
                <input aria-label="High velocity" type="number" min="1" max="127" value={zone.velocityHigh} onChange={(event) => props.onUpdateZone(zone.id, { velocityHigh: Number(event.currentTarget.value) })} />
                <input aria-label="Root note" type="number" min="0" max="127" value={zone.rootNote} onChange={(event) => props.onUpdateZone(zone.id, { rootNote: Number(event.currentTarget.value) })} />
                <select value={zone.playbackMode} onChange={(event) => props.onUpdateZone(zone.id, { playbackMode: event.currentTarget.value === "forward-loop" ? "forward-loop" : event.currentTarget.value === "crossfade-loop" ? "crossfade-loop" : "one-shot" })}><option value="one-shot">One shot</option><option value="forward-loop">Loop</option><option value="crossfade-loop">Xfade</option></select>
                <button disabled={props.status?.zones.get(zone.id) !== "error" && props.status?.zones.get(zone.id) !== "missing"} onClick={() => props.onRetryZone(zone.id)}>{props.status?.zones.get(zone.id) ?? "missing"}</button>
                <button aria-label="Remove zone" onClick={() => props.onRemoveZone(zone.id)}>×</button>
              </div>
            )}
          </For>
        </div>
      </div>
    </EffectShell>
  );
};

export default Sampler;
