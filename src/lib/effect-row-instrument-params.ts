import {
  normalizeTrackInstrumentParams,
  type TrackInstrumentParams,
} from "@daw-browser/shared";
import { structuredCloneJsonValue } from "./structured-clone-json";
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
    const value = z.json().safeParse(structuredCloneJsonValue({ kind, instanceId: row.instanceId, params: row.params }));
    return value.success ? normalizeTrackInstrumentParams(value.data) : undefined;
  }
  if (kind === "instrument") {
    const value = z.json().safeParse(structuredCloneJsonValue(row.params));
    return value.success ? normalizeTrackInstrumentParams(value.data) : undefined;
  }
  return undefined;
}
