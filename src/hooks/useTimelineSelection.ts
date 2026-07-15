import { createSignal, onCleanup, type Accessor } from "solid-js";

import { PPS, quantizeSecToGrid, RULER_HEIGHT } from "~/lib/timeline-utils";
import {
  extendTimelineRangeSelectionToPoint,
  normalizeTimelineRangeSelection,
  snapTimeRangeToGridColumns,
} from "~/lib/timeline-range-selection";
import {
  trackIdsInYRange,
  trackIndexAtY,
  type TimelineTrackLayoutRow,
} from "~/lib/timeline-track-layout";
import type { Track } from "@daw-browser/timeline-core/types";

import { useDrag } from "./useDrag";
import type { TimelineSelectionController } from "./useTimelineSelectionState";

type TimelineSelectionOptions = {
  tracks: Accessor<Track[]>;
  trackLayout: Accessor<TimelineTrackLayoutRow[]>;
  displayTrackIds: Accessor<Track["id"][]>;
  selection: TimelineSelectionController;
  bpm: Accessor<number>;
  gridDenominator: Accessor<number>;
  startScrub: (clientX: number, options?: { listen?: boolean }) => void;
  moveScrub: (clientX: number) => void;
  stopScrub: () => void;
};

export const rangeTrackIdsThroughDisplayOrder = (
  displayTrackIds: readonly Track["id"][],
  rangeTrackIds: readonly Track["id"][],
  targetTrackId: Track["id"] | undefined,
) => {
  if (!targetTrackId) return rangeTrackIds;
  const targetIndex = displayTrackIds.indexOf(targetTrackId);
  const selectedIndexes = rangeTrackIds
    .map((trackId) => displayTrackIds.indexOf(trackId))
    .filter((index) => index >= 0);
  if (targetIndex < 0) return rangeTrackIds;
  if (selectedIndexes.length === 0) return [targetTrackId];
  return displayTrackIds.slice(
    Math.min(targetIndex, ...selectedIndexes),
    Math.max(targetIndex, ...selectedIndexes) + 1,
  );
};

export const timelinePointerCoordinates = (
  event: Pick<PointerEvent, "clientX" | "clientY">,
  element: {
    scrollLeft: number;
    scrollTop: number;
    getBoundingClientRect: () => Pick<DOMRect, "left" | "top">;
  },
  rulerOffsetPx: number,
) => {
  const rect = element.getBoundingClientRect();
  return {
    x: event.clientX - rect.left + (element.scrollLeft || 0),
    y: event.clientY - rect.top + (element.scrollTop || 0) - rulerOffsetPx,
  };
};

type TimelineSelection = {
  marqueeRect: Accessor<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>;
  marqueeSurface: Accessor<"scrolling" | "return" | null>;
  onLanePointerDown: (
    event: PointerEvent,
    surface: TimelineLanePointerSurface,
  ) => void;
  extendRangeSelectionToPointer: (
    event: PointerEvent,
    options: TimelineRangePointerOptions,
  ) => boolean;
};

type TimelineLanePointerSurface = {
  kind: "scrolling" | "return";
  element: HTMLDivElement | undefined;
  rows: readonly TimelineTrackLayoutRow[];
  rulerOffsetPx: number;
};

type TimelineRangePointerOptions = {
  element: HTMLDivElement | undefined;
  trackId?: Track["id"];
  rows?: readonly TimelineTrackLayoutRow[];
  rulerOffsetPx?: number;
};

export function useTimelineSelection(
  options: TimelineSelectionOptions,
): TimelineSelection {
  const {
    tracks,
    trackLayout,
    selection,
    bpm,
    gridDenominator,
    startScrub,
    moveScrub,
    stopScrub,
    displayTrackIds,
  } = options;

  const [marqueeRect, setMarqueeRect] = createSignal<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const [marqueeSurface, setMarqueeSurface] = createSignal<
    "scrolling" | "return" | null
  >(null);

  let marqueeActive = false;
  let startX = 0;
  let startY = 0;

  const extendRangeSelectionToPointer = (
    event: PointerEvent,
    pointerOptions: TimelineRangePointerOptions,
  ) => {
    const scrollEl = pointerOptions.element;
    const clickedTrackId = pointerOptions.trackId;
    const rows = pointerOptions.rows ?? trackLayout();
    const rulerOffsetPx = pointerOptions.rulerOffsetPx ?? RULER_HEIGHT;
    const currentRange = selection.rangeSelection();
    if (!event.shiftKey || !currentRange || !scrollEl) return false;
    const { x, y } = timelinePointerCoordinates(event, scrollEl, rulerOffsetPx);
    const trackIndex = clickedTrackId ? -1 : trackIndexAtY(rows, y);
    const trackId =
      clickedTrackId ??
      (trackIndex >= 0 ? rows[trackIndex]?.trackId : undefined);
    const nextRange = extendTimelineRangeSelectionToPoint(currentRange, {
      timeSec: quantizeSecToGrid(x / PPS, bpm(), gridDenominator()),
      trackIds: rangeTrackIdsThroughDisplayOrder(
        displayTrackIds(),
        currentRange.trackIds,
        trackId,
      ),
      primaryTrackId: trackId ?? currentRange.primaryTrackId,
    });
    if (nextRange) selection.selectTimeRange(nextRange);
    event.stopPropagation();
    event.preventDefault();
    return true;
  };

  const startLaneDrag = (
    event: PointerEvent,
    surface: TimelineLanePointerSurface,
  ) => {
    const { element: scrollEl, rows, rulerOffsetPx } = surface;
    const ts = tracks();
    if (ts.length === 0 || !scrollEl) return false;
    const trackById = new Map(ts.map((track) => [track.id, track]));

    currentScrollEl = scrollEl;

    const start = timelinePointerCoordinates(event, scrollEl, 0);
    startX = start.x;
    startY = start.y;
    if (!event.shiftKey) {
      const laneIndex = trackIndexAtY(rows, startY - rulerOffsetPx);
      const row = laneIndex >= 0 ? rows[laneIndex] : undefined;
      const track = row ? trackById.get(row.trackId) : undefined;
      if (track) {
        if (
          selection.selectedTrackId() !== track.id ||
          selection.selectedFXTarget() !== track.id ||
          selection.rangeSelection() ||
          selection.selectedClip() ||
          selection.selectedClipIds().size > 0
        ) {
          selection.selectTrackTarget(track.id, { clearClipSelection: true });
        }
      } else {
        if (
          selection.selectedTrackId() ||
          selection.selectedFXTarget() !== "master" ||
          selection.rangeSelection() ||
          selection.selectedClip() ||
          selection.selectedClipIds().size > 0
        ) {
          selection.selectMasterTarget();
        }
      }
    }
    marqueeActive = false;
    startScrub(event.clientX, { listen: false });
    return true;
  };

  const onLanePointerDown = (
    event: PointerEvent,
    surface: TimelineLanePointerSurface,
  ) => {
    if (
      extendRangeSelectionToPointer(
        event,
        surface,
      )
    ) {
      return;
    }
    if (!startLaneDrag(event, surface)) return;
    currentRows = surface.rows;
    currentRulerOffsetPx = surface.rulerOffsetPx;
    setMarqueeSurface(surface.kind);
    laneDrag.onPointerDown(event);
  };

  let currentScrollEl: HTMLDivElement | undefined;
  let currentRows: readonly TimelineTrackLayoutRow[] = [];
  let currentRulerOffsetPx = RULER_HEIGHT;
  const onLaneDragMove = (event: PointerEvent, scrollEl: HTMLDivElement) => {
    currentScrollEl = scrollEl;

    const current = timelinePointerCoordinates(event, scrollEl, 0);
    const currentX = current.x;
    const currentY = current.y;
    const dx = Math.abs(currentX - startX);
    const dy = Math.abs(currentY - startY);

    if (!marqueeActive && (dx > 4 || dy > 4)) {
      marqueeActive = true;
      stopScrub();
    }

    if (!marqueeActive) {
      moveScrub(event.clientX);
      return;
    }

    const x = Math.min(startX, currentX);
    const y = Math.min(startY, currentY) - currentRulerOffsetPx;
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);
    const normY = Math.max(0, y);

    setMarqueeRect({ x, y: normY, width, height });

    const rangeTrackIds = trackIdsInYRange(currentRows, normY, normY + height);
    const primaryIndex = trackIndexAtY(
      currentRows,
      startY - currentRulerOffsetPx,
    );
    const primaryTrackId =
      primaryIndex >= 0
        ? currentRows[primaryIndex].trackId
        : (rangeTrackIds[0] ?? null);
    const snappedRange = snapTimeRangeToGridColumns(
      {
        startSec: x / PPS,
        endSec: (x + width) / PPS,
      },
      bpm(),
      gridDenominator(),
    );
    if (!snappedRange) {
      if (!event.shiftKey) selection.selectMasterTarget();
      return;
    }
    const range = normalizeTimelineRangeSelection({
      startSec: snappedRange.startSec,
      endSec: snappedRange.endSec,
      trackIds: rangeTrackIds,
      primaryTrackId,
    });
    if (range) {
      selection.selectTimeRange(range);
      return;
    }

    if (!event.shiftKey) selection.selectMasterTarget();
  };

  const onLaneDragUp = () => {
    stopScrub();
    setMarqueeRect(null);
    setMarqueeSurface(null);
    marqueeActive = false;
    currentScrollEl = undefined;
    currentRows = [];
    currentRulerOffsetPx = RULER_HEIGHT;
  };

  const laneDrag = useDrag({
    onDragMove: (_, event) => {
      if (currentScrollEl) onLaneDragMove(event, currentScrollEl);
    },
    onDragEnd: onLaneDragUp,
    onDragCancel: onLaneDragUp,
  });

  onCleanup(() => {
    onLaneDragUp();
  });

  return {
    marqueeRect,
    marqueeSurface,
    onLanePointerDown,
    extendRangeSelectionToPointer,
  };
}
