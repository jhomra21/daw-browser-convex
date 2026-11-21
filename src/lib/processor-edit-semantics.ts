import { processorRegistry } from "@daw-browser/audio-core-contract/generated";
import type { SynthParams, SynthParamsUpdate } from "@daw-browser/shared";
import type { EffectParamsCommitPayload, EffectType } from "~/lib/undo/types";
import type { LiveProcessorEditIdentity } from "~/lib/live-processor-control";

// A renderer-local discriminator that keeps a synth target distinct from the built-in processor kinds. Native synths
// are instrument nodes, dispatched by instrument events; a synth is identified everywhere by its instanceId.
export const SYNTH_KIND_ID = 18;

// What the parameter mapper reads of an edit: the effect and its two contents, never where the effect lives.
export type EffectChange<Effect extends EffectType = EffectType> = {
  [E in Effect]: Pick<EffectParamsCommitPayload<E>, "effect" | "from" | "to">;
}[Effect];

// Dispatches can explicitly re-send touched fields even when from/to are equal.
export type NativeBuiltInParameterPayload = EffectParamsCommitPayload & {
  parameterIds?: ReadonlySet<string>;
  edit?: LiveProcessorEditIdentity;
};

type SynthNativeField =
  | "outputGain" | "outputPan" | "filterCutoffHz" | "filterResonance"
  | "ampAttackMs" | "ampDecayMs" | "ampSustain" | "ampReleaseMs";

type SynthLiveField = {
  parameterId: string;
  nativeField: SynthNativeField;
  // What native reads when a compiled state leaves the field out.
  nativeDefault: number;
  // The portable param is in seconds where native is in milliseconds.
  nativeScale: number;
  read: (params: SynthParams) => number;
  update: (value: number) => SynthParamsUpdate;
};

export const SYNTH_LIVE_FIELDS: readonly SynthLiveField[] = [
  { parameterId: "synth.outputGain", nativeField: "outputGain", nativeDefault: 1, nativeScale: 1,
    read: (params) => params.gain, update: (gain) => ({ gain }) },
  { parameterId: "synth.outputPan", nativeField: "outputPan", nativeDefault: 0, nativeScale: 1,
    read: (params) => params.pan, update: (pan) => ({ pan }) },
  { parameterId: "synth.filterCutoffHz", nativeField: "filterCutoffHz", nativeDefault: 20_000, nativeScale: 1,
    read: (params) => params.filter.frequencyHz, update: (frequencyHz) => ({ filter: { frequencyHz } }) },
  { parameterId: "synth.filterResonance", nativeField: "filterResonance", nativeDefault: 0.7, nativeScale: 1,
    read: (params) => params.filter.q, update: (q) => ({ filter: { q } }) },
  { parameterId: "synth.ampAttackMs", nativeField: "ampAttackMs", nativeDefault: 0, nativeScale: 1000,
    read: (params) => params.ampEnvelope.attackSec, update: (attackSec) => ({ ampEnvelope: { attackSec } }) },
  { parameterId: "synth.ampDecayMs", nativeField: "ampDecayMs", nativeDefault: 0, nativeScale: 1000,
    read: (params) => params.ampEnvelope.decaySec, update: (decaySec) => ({ ampEnvelope: { decaySec } }) },
  { parameterId: "synth.ampSustain", nativeField: "ampSustain", nativeDefault: 1, nativeScale: 1,
    read: (params) => params.ampEnvelope.sustain, update: (sustain) => ({ ampEnvelope: { sustain } }) },
  { parameterId: "synth.ampReleaseMs", nativeField: "ampReleaseMs", nativeDefault: 0, nativeScale: 1000,
    read: (params) => params.ampEnvelope.releaseSec, update: (releaseSec) => ({ ampEnvelope: { releaseSec } }) },
];

// The live fields `to` moved away from `from`, as one update.
export const movedSynthLiveFields = (from: SynthParams, to: SynthParams): SynthParamsUpdate =>
  SYNTH_LIVE_FIELDS.reduce<SynthParamsUpdate>((moved, field) => {
    const value = field.read(to);

    if (Object.is(value, field.read(from))) return moved;
    const update = field.update(value);

    return Object.assign(moved, update, {
      filter: { ...moved.filter, ...update.filter },
      ampEnvelope: { ...moved.ampEnvelope, ...update.ampEnvelope },
    });
  }, { filter: {}, ampEnvelope: {} });

const processorKindIdsByName = new Map(processorRegistry.map((processor) => [processor.name, processor.id]));

export const processorEditKindId = (effect: string): number | undefined => {
  const kind = effect.replace(/^master-/, "");

  return kind === "instrument" ? SYNTH_KIND_ID : processorKindIdsByName.get(kind);
};
