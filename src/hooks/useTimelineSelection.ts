import { createSignal, onCleanup, type Accessor } from 'solid-js'

import { PPS, quantizeSecToGrid, RULER_HEIGHT } from '~/lib/timeline-utils'
import { extendTimelineRangeSelectionToPoint, normalizeTimelineRangeSelection, snapTimeRangeToGridColumns } from '~/lib/timeline-range-selection'
import { trackIdsInYRange, trackIndexAtY, type TimelineTrackLayoutRow } from '~/lib/timeline-track-layout'
import type { Track } from '@daw-browser/timeline-core/types'

import { useDrag } from './useDrag'
import type { TimelineSelectionController } from './useTimelineSelectionState'

type TimelineSelectionOptions = {
  tracks: Accessor<Track[]>
  trackLayout: Accessor<TimelineTrackLayoutRow[]>
  selection: TimelineSelectionController
  bpm: Accessor<number>
  gridDenominator: Accessor<number>
  startScrub: (clientX: number, options?: { listen?: boolean }) => void
  moveScrub: (clientX: number) => void
  stopScrub: () => void
}

type TimelineSelection = {
  marqueeRect: Accessor<{ x: number; y: number; width: number; height: number } | null>
  onLanePointerDown: (event: PointerEvent, scrollEl: HTMLDivElement | undefined) => void
  extendRangeSelectionToPointer: (event: PointerEvent, scrollEl: HTMLDivElement | undefined, trackId?: Track['id']) => boolean
}

export function useTimelineSelection(options: TimelineSelectionOptions): TimelineSelection {
  const {
    tracks,
    trackLayout,
    selection,
    bpm,
    gridDenominator,
    startScrub,
    moveScrub,
    stopScrub,
  } = options

  const [marqueeRect, setMarqueeRect] = createSignal<{ x: number; y: number; width: number; height: number } | null>(null)

  let marqueeActive = false
  let startX = 0
  let startY = 0

  const rangeTrackIdsThroughRow = (
    rows: readonly TimelineTrackLayoutRow[],
    rangeTrackIds: readonly Track['id'][],
    targetTrackId: Track['id'] | undefined,
  ) => {
    if (!targetTrackId) return rangeTrackIds
    const indexes = rangeTrackIds
      .map((trackId) => rows.findIndex((row) => row.trackId === trackId))
      .filter((index) => index >= 0)
    const targetIndex = rows.findIndex((row) => row.trackId === targetTrackId)
    if (targetIndex < 0) return rangeTrackIds
    const startIndex = Math.min(targetIndex, ...indexes)
    const endIndex = Math.max(targetIndex, ...indexes)
    return rows.slice(startIndex, endIndex + 1).map((row) => row.trackId)
  }

  const extendRangeSelectionToPointer = (
    event: PointerEvent,
    scrollEl: HTMLDivElement | undefined,
    clickedTrackId?: Track['id'],
  ) => {
    const currentRange = selection.rangeSelection()
    if (!event.shiftKey || !currentRange || !scrollEl) return false
    const rect = scrollEl.getBoundingClientRect()
    const x = event.clientX - rect.left + (scrollEl.scrollLeft || 0)
    const y = event.clientY - rect.top + (scrollEl.scrollTop || 0) - RULER_HEIGHT
    const rows = trackLayout()
    const trackIndex = clickedTrackId ? -1 : trackIndexAtY(rows, y)
    const trackId = clickedTrackId ?? (trackIndex >= 0 ? rows[trackIndex]?.trackId : undefined)
    const nextRange = extendTimelineRangeSelectionToPoint(currentRange, {
      timeSec: quantizeSecToGrid(x / PPS, bpm(), gridDenominator()),
      trackIds: rangeTrackIdsThroughRow(rows, currentRange.trackIds, trackId),
      primaryTrackId: trackId ?? currentRange.primaryTrackId,
    })
    if (nextRange) selection.selectTimeRange(nextRange)
    event.stopPropagation()
    event.preventDefault()
    return true
  }

  const startLaneDrag = (event: PointerEvent, scrollEl: HTMLDivElement | undefined) => {
    const ts = tracks()
    if (ts.length === 0 || !scrollEl) return false
    const trackById = new Map(ts.map((track) => [track.id, track]))

    currentScrollEl = scrollEl

    const rect = scrollEl.getBoundingClientRect()
    startX = event.clientX - rect.left + (scrollEl.scrollLeft || 0)
    startY = event.clientY - rect.top + (scrollEl.scrollTop || 0)
    if (!event.shiftKey) {
      const laneIndex = trackIndexAtY(trackLayout(), startY - RULER_HEIGHT)
      const row = laneIndex >= 0 ? trackLayout()[laneIndex] : undefined
      const track = row ? trackById.get(row.trackId) : undefined
      if (track) {
        if (
          selection.selectedTrackId() !== track.id ||
          selection.selectedFXTarget() !== track.id ||
          selection.rangeSelection() ||
          selection.selectedClip() ||
          selection.selectedClipIds().size > 0
        ) {
          selection.selectTrackTarget(track.id, { clearClipSelection: true })
        }
      } else {
        if (
          selection.selectedTrackId() ||
          selection.selectedFXTarget() !== 'master' ||
          selection.rangeSelection() ||
          selection.selectedClip() ||
          selection.selectedClipIds().size > 0
        ) {
          selection.selectMasterTarget()
        }
      }
    }
    marqueeActive = false
    startScrub(event.clientX, { listen: false })
    return true
  }

  const onLanePointerDown = (event: PointerEvent, scrollEl: HTMLDivElement | undefined) => {
    if (extendRangeSelectionToPointer(event, scrollEl)) {
      return
    }
    if (!startLaneDrag(event, scrollEl)) return
    laneDrag.onPointerDown(event)
  }

  let currentScrollEl: HTMLDivElement
  const onLaneDragMove = (event: PointerEvent, scrollEl: HTMLDivElement) => {
    currentScrollEl = scrollEl

    const rect = scrollEl.getBoundingClientRect()
    const currentX = event.clientX - rect.left + (scrollEl.scrollLeft || 0)
    const currentY = event.clientY - rect.top + (scrollEl.scrollTop || 0)
    const dx = Math.abs(currentX - startX)
    const dy = Math.abs(currentY - startY)

    if (!marqueeActive && (dx > 4 || dy > 4)) {
      marqueeActive = true
      stopScrub()
    }

    if (!marqueeActive) {
      moveScrub(event.clientX)
      return
    }

    const x = Math.min(startX, currentX)
    const y = Math.min(startY, currentY) - RULER_HEIGHT
    const width = Math.abs(currentX - startX)
    const height = Math.abs(currentY - startY)
    const normY = Math.max(0, y)

    setMarqueeRect({ x, y: normY, width, height })

    const rows = trackLayout()
    const rangeTrackIds = trackIdsInYRange(rows, normY, normY + height)
    const primaryIndex = trackIndexAtY(rows, startY - RULER_HEIGHT)
    const primaryTrackId = primaryIndex >= 0 ? rows[primaryIndex].trackId : rangeTrackIds[0] ?? null
    const snappedRange = snapTimeRangeToGridColumns({
      startSec: x / PPS,
      endSec: (x + width) / PPS,
    }, bpm(), gridDenominator())
    if (!snappedRange) {
      if (!event.shiftKey) selection.selectMasterTarget()
      return
    }
    const range = normalizeTimelineRangeSelection({
      startSec: snappedRange.startSec,
      endSec: snappedRange.endSec,
      trackIds: rangeTrackIds,
      primaryTrackId,
    })
    if (range) {
      selection.selectTimeRange(range)
      return
    }

    if (!event.shiftKey) selection.selectMasterTarget()
  }

  const onLaneDragUp = () => {
    stopScrub()
    setMarqueeRect(null)
    marqueeActive = false
  }

  const laneDrag = useDrag({
    onDragMove: (_, event) => {
      onLaneDragMove(event, currentScrollEl)
    },
    onDragEnd: onLaneDragUp,
    onDragCancel: onLaneDragUp,
  })

  onCleanup(() => {
    onLaneDragUp()
  })

  return {
    marqueeRect,
    onLanePointerDown,
    extendRangeSelectionToPointer,
  }
}
