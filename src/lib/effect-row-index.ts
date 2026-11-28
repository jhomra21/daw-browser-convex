import {
  arpeggiatorParamsSchema,
  normalizeArpeggiatorParams,
  type ArpeggiatorParams,
  type TrackInstrumentParams,
} from "@daw-browser/shared";
import { readInstrumentParamsFromEffectRow } from "~/lib/effect-row-instrument-params";

type CloudEffectRow = {
  type: string;
  targetType: string;
  trackId?: string;
  revision?: number;
  instanceId?: string;
  params?: unknown;
};

type LocalEffectRow = {
  effect: string;
  targetId: string;
  instanceId?: string;
  params: unknown;
};

type IndexedEffect<TParams> = { params: TParams; through: number };

type InstrumentEffectIndex = {
  instruments: Map<string, IndexedEffect<TrackInstrumentParams>>;
  arpeggiators: Map<string, IndexedEffect<ArpeggiatorParams>>;
};

const trackRow = (row: CloudEffectRow | LocalEffectRow) => {
  if ("effect" in row) {
    return { targetId: row.targetId, kind: row.effect === "arp" ? "arpeggiator" : row.effect, through: 0 };
  }

  if (row.targetType !== "track" || !row.trackId) return undefined;

  return { targetId: row.trackId, kind: row.type, through: row.revision ?? 0 };
};

// The instrument and arpeggiator of each track, from cloud rows (`type`, `trackId`) or local rows (`effect`, `targetId`).
// A `synth` row only stands in for an instrument when the track has no `instrument` row before it.
export const indexInstrumentEffectRows = (rows: readonly (CloudEffectRow | LocalEffectRow)[]): InstrumentEffectIndex => {
  const instruments = new Map<string, IndexedEffect<TrackInstrumentParams>>();
  const arpeggiators = new Map<string, IndexedEffect<ArpeggiatorParams>>();

  for (const row of rows) {
    const track = trackRow(row);

    if (!track) continue;

    if (track.kind === "instrument" || (track.kind === "synth" && !instruments.has(track.targetId))) {
      const params = readInstrumentParamsFromEffectRow(row);

      if (params) instruments.set(track.targetId, { params, through: track.through });
    } else if (track.kind === "arpeggiator") {
      const parsed = arpeggiatorParamsSchema.safeParse(row.params);

      if (parsed.success) arpeggiators.set(track.targetId, { params: normalizeArpeggiatorParams(parsed.data), through: track.through });
    }
  }

  return { instruments, arpeggiators };
};
