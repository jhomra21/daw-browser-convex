import type { TimelineTrackRow } from "./types";
import { normalizeTrackColor } from "@daw-browser/shared";

type BuildTimelineTrackRowInput = {
  id: string;
  index: number;
  timestamp: number;
  historyRef?: string;
  name?: string;
  volume?: number;
  muted?: boolean;
  soloed?: boolean;
  kind?: TimelineTrackRow["kind"];
  channelRole?: TimelineTrackRow["channelRole"];
  groupId?: string;
  collapsed?: boolean;
  color?: string;
  outputTargetId?: string;
  sends?: TimelineTrackRow["sends"];
};

export const buildTimelineTrackRow = (input: BuildTimelineTrackRowInput): TimelineTrackRow => ({
  id: input.id,
  historyRef: input.historyRef ?? input.id,
  name: input.name?.trim() || `${input.channelRole === "return" ? "Return" : "Track"} ${input.index + 1}`,
  index: input.index,
  volume: input.volume ?? 0.8,
  muted: input.muted ?? false,
  soloed: input.soloed ?? false,
  kind: input.kind ?? "audio",
  channelRole: input.channelRole ?? "track",
  groupId: input.groupId,
  collapsed:
    input.collapsed ?? (input.channelRole === "return" ? true : undefined),
  color: normalizeTrackColor(input.color),
  outputTargetId: input.outputTargetId,
  sends: input.sends ?? [],
  createdAt: input.timestamp,
  updatedAt: input.timestamp,
});
