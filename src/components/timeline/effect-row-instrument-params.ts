import {
  normalizeTrackInstrumentParams,
  type TrackInstrumentParams,
} from "@daw-browser/shared";

type EffectRowInstrumentInput = {
  effect?: unknown;
  params?: unknown;
  type?: unknown;
};

export function readInstrumentParamsFromEffectRow(row: EffectRowInstrumentInput): TrackInstrumentParams | undefined {
  const kind = row.effect ?? row.type;
  if (kind === "synth") return normalizeTrackInstrumentParams({ kind, params: row.params });
  if (kind === "instrument") return normalizeTrackInstrumentParams(row.params);
  return undefined;
}
