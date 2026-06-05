import { getPersistableAudioSourceMetadata } from "~/lib/audio-source";
import type { ClipMediaCache } from "~/lib/clip-buffer-cache";
import type { BatchClipCreateItem } from "~/lib/clip-create";
import type { DuplicatedClipPlacement, MultiDragSnapshot } from "~/lib/clip-drag-placement";
import { createTimelineTrackIndex, type TimelineTrackIndex } from "@daw-browser/timeline-core/track-index";
import { PPS, quantizeSecToGrid, yToLaneIndex } from "~/lib/timeline-utils";
import type { Clip, Track, TrackId } from "@daw-browser/timeline-core/types";

type DraggingIds = { trackId: Track["id"]; clipId: string };
type ClipMove = { clipId: string; trackId: Track["id"]; startSec: number };

type ClipDragStart = {
  draggingIds: DraggingIds;
  prePositions: Map<string, ClipMove>;
  multiDragging: MultiDragSnapshot | null;
  preserveSelection: boolean;
};

export const buildClipDragStart = (input: {
  trackId: Track["id"];
  clipId: string;
  clip: Clip;
  tracks: Track[];
  lookup: TimelineTrackIndex;
  selectedClipIds: Set<string>;
  canWriteClip: (clipId: string) => boolean;
}): ClipDragStart => {
  const ownedSelectionIds = Array.from(input.selectedClipIds).filter((id) => input.canWriteClip(id));
  const dragSelectionIds = input.selectedClipIds.has(input.clipId) && ownedSelectionIds.length > 1
    ? ownedSelectionIds
    : [input.clipId];
  const isMultiDrag = dragSelectionIds.length > 1;
  const prePositions = new Map<string, ClipMove>();

  for (const id of dragSelectionIds) {
    const clip = input.lookup.clipById.get(id);
    const trackId = input.lookup.clipTrackIdById.get(id);
    if (!clip || !trackId) continue;
    prePositions.set(id, { clipId: id, trackId, startSec: clip.startSec });
  }

  if (!isMultiDrag) {
    return {
      draggingIds: { trackId: input.trackId, clipId: input.clipId },
      prePositions,
      multiDragging: null,
      preserveSelection: false,
    };
  }

  const anchorTrackIdx = input.tracks.findIndex((track) => track.id === input.trackId);
  const items: MultiDragSnapshot["items"] = [];
  for (const id of dragSelectionIds) {
    const clip = input.lookup.clipById.get(id);
    const trackId = input.lookup.clipTrackIdById.get(id);
    const trackIdx = trackId ? (input.lookup.trackIndexById.get(trackId) ?? -1) : -1;
    if (!clip || trackIdx < 0) continue;
    items.push({ clipId: id, origTrackIdx: trackIdx, origStartSec: clip.startSec });
  }

  return {
    draggingIds: { trackId: input.trackId, clipId: input.clipId },
    prePositions,
    multiDragging: {
      anchorClipId: input.clipId,
      anchorOrigTrackIdx: anchorTrackIdx,
      anchorOrigStartSec: input.clip.startSec,
      items,
    },
    preserveSelection: true,
  };
};

export const draftMovesChanged = (previous: ClipMove[] | null, nextMoves: ClipMove[]) => {
  if (!previous || previous.length !== nextMoves.length) return true;
  for (let index = 0; index < nextMoves.length; index++) {
    const prev = previous[index];
    const next = nextMoves[index];
    if (prev.clipId !== next.clipId || prev.trackId !== next.trackId || prev.startSec !== next.startSec) return true;
  }
  return false;
};

export const readDragPointer = (input: {
  event: PointerEvent;
  scroll: HTMLDivElement;
  dragDeltaX: number;
  gridEnabled: boolean;
  bpm: number;
  gridDenominator: number;
}) => {
  const rect = input.scroll.getBoundingClientRect();
  const x = input.event.clientX - rect.left - input.dragDeltaX + (input.scroll.scrollLeft || 0);
  const rawStart = Math.max(0, x / PPS);
  return {
    desiredStart: input.gridEnabled
      ? quantizeSecToGrid(rawStart, input.bpm, input.gridDenominator, "round")
      : rawStart,
    laneIdx: yToLaneIndex(input.event.clientY, input.scroll),
  };
};

export const createDuplicatePreviews = (placements: DuplicatedClipPlacement[], previewPrefix: string) => {
  const previews = new Map<TrackId, Clip[]>();
  for (const placement of placements) {
    const trackPreviews = previews.get(placement.trackId) ?? [];
    trackPreviews.push({
      ...placement.originalClip,
      id: `${previewPrefix}${placement.originalClip.id}`,
      startSec: placement.startSec,
    });
    previews.set(placement.trackId, trackPreviews);
  }
  return previews;
};

export const buildDuplicateClipCreateItems = (
  placements: DuplicatedClipPlacement[],
  audioBufferCache: ClipMediaCache,
): BatchClipCreateItem[] => placements.map((placement) => ({
  trackId: placement.trackId,
  buffer: placement.originalClip.buffer ?? audioBufferCache.getBuffer(placement.originalClip.id) ?? null,
  clip: {
    startSec: placement.startSec,
    duration: placement.originalClip.duration,
    name: placement.originalClip.name,
    sampleUrl: placement.originalClip.sampleUrl,
    source: getPersistableAudioSourceMetadata(placement.originalClip),
    sourceAssetKey: placement.originalClip.sourceAssetKey,
    sourceKind: placement.originalClip.sourceKind,
    midi: placement.originalClip.midi,
    timing: {
      leftPadSec: placement.originalClip.leftPadSec,
      bufferOffsetSec: placement.originalClip.bufferOffsetSec,
      midiOffsetBeats: placement.originalClip.midiOffsetBeats,
    },
  },
}));

export const previousMovesFrom = (moves: ClipMove[], prePositions: Map<string, ClipMove>) => (
  moves.map((move) => ({
    clipId: move.clipId,
    trackId: prePositions.get(move.clipId)?.trackId ?? move.trackId,
    startSec: prePositions.get(move.clipId)?.startSec ?? move.startSec,
  }))
);

export const createDragTrackLookupCache = () => {
  let tracksSnapshot: Track[] | null = null;
  let lookupSnapshot: TimelineTrackIndex | null = null;
  return {
    get(tracks: Track[]) {
      if (tracksSnapshot === tracks && lookupSnapshot) return lookupSnapshot;
      tracksSnapshot = tracks;
      lookupSnapshot = createTimelineTrackIndex(tracks);
      return lookupSnapshot;
    },
    clear() {
      tracksSnapshot = null;
      lookupSnapshot = null;
    },
  };
};
