import {
  normalizeTrackInstrumentParams,
  type TrackInstrumentParams,
} from "@daw-browser/shared";
import { z } from "zod";

type EffectRowInstrumentInput = {
  effect?: unknown;
  instanceId?: unknown;
  params?: unknown;
  type?: unknown;
};

export function readInstrumentParamsFromEffectRow(row: EffectRowInstrumentInput): TrackInstrumentParams | undefined {
  const kind = row.effect ?? row.type;
  if (kind === "synth") {
    const value = z.json().safeParse({ kind, instanceId: row.instanceId, params: row.params });
    return value.success ? normalizeTrackInstrumentParams(value.data) : undefined;
  }
  if (kind === "instrument") {
    const value = z.json().safeParse(row.params);
    return value.success ? normalizeTrackInstrumentParams(value.data) : undefined;
  }
  return undefined;
}
