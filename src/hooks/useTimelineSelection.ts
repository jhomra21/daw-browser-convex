import { createSignal, onCleanup, type Accessor } from 'solid-js'

import { PPS, RULER_HEIGHT } from '~/lib/timeline-utils'
import { normalizeTimelineRangeSelection, snapTimeRangeToGridColumns } from '~/lib/timeline-range-selection'
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

  const startLaneDrag = (event: PointerEvent, scrollEl: HTMLDivElement | undefined) => {
    const ts = tracks()
    if (ts.length === 0 || !scrollEl) return false

    currentScrollEl = scrollEl

    const rect = scrollEl.getBoundingClientRect()
    startX = event.clientX - rect.left + (scrollEl.scrollLeft || 0)
    startY = event.clientY - rect.top + (scrollEl.scrollTop || 0)
    if (!event.shiftKey) {
      const laneIndex = trackIndexAtY(trackLayout(), startY - RULER_HEIGHT)
      const track = ts[laneIndex]
      if (track) {
        if (
          selection.selectedTrackId() !== track.id ||
          selection.selectedFXTarget() !== track.id ||
          selection.selectedClip() ||
          selection.selectedClipIds().size > 0
        ) {
          selection.selectTrackTarget(track.id, { clearClipSelection: true })
        }
      } else {
        if (
          selection.selectedTrackId() ||
          selection.selectedFXTarget() !== 'master' ||
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

    const rangeTrackIds = trackIdsInYRange(trackLayout(), normY, normY + height)
    const primaryIndex = trackIndexAtY(trackLayout(), startY - RULER_HEIGHT)
    const primaryTrackId = primaryIndex >= 0 ? trackLayout()[primaryIndex]?.trackId ?? null : rangeTrackIds[0] ?? null
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
  }
}
