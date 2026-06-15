import { createSignal, onCleanup, type Accessor } from 'solid-js'

import { PPS, RULER_HEIGHT, LANE_HEIGHT, yToLaneIndex } from '~/lib/timeline-utils'
import type { Track } from '@daw-browser/timeline-core/types'

import { useDrag } from './useDrag'
import type { TimelineSelectionController } from './useTimelineSelectionState'

type TimelineSelectionOptions = {
  tracks: Accessor<Track[]>
  selection: TimelineSelectionController
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
    selection,
    startScrub,
    moveScrub,
    stopScrub,
  } = options

  const [marqueeRect, setMarqueeRect] = createSignal<{ x: number; y: number; width: number; height: number } | null>(null)

  let marqueeActive = false
  let marqueeAdditive = false
  let marqueeBaseClipIds = new Set<string>()
  let startX = 0
  let startY = 0

  const findPrimarySelectedClip = (selectedClipIds: Set<string>) => {
    for (const track of tracks()) {
      for (const clip of track.clips) {
        if (selectedClipIds.has(clip.id)) {
          return { trackId: track.id, clipId: clip.id }
        }
      }
    }
    return null
  }

  const selectMarqueeClips = (selected: Set<string>) => {
    const clipIds = marqueeAdditive
      ? new Set([...marqueeBaseClipIds, ...selected])
      : selected
    const primaryClip = findPrimarySelectedClip(clipIds)
    if (primaryClip) {
      selection.selectClipGroup({
        trackId: primaryClip.trackId,
        clipIds: [...clipIds],
        primaryClipId: primaryClip.clipId,
      })
      return
    }
    if (!marqueeAdditive) {
      selection.selectMasterTarget()
    }
  }

  const startLaneDrag = (event: PointerEvent, scrollEl: HTMLDivElement | undefined) => {
    const ts = tracks()
    if (ts.length === 0 || !scrollEl) return false

    currentScrollEl = scrollEl

    marqueeAdditive = !!event.shiftKey
    marqueeBaseClipIds = marqueeAdditive ? new Set(selection.selectedClipIds()) : new Set<string>()
    const rect = scrollEl.getBoundingClientRect()
    startX = event.clientX - rect.left + (scrollEl.scrollLeft || 0)
    startY = event.clientY - rect.top + (scrollEl.scrollTop || 0)
    if (!event.shiftKey) {
      const laneIndex = yToLaneIndex(event.clientY, scrollEl)
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

    const selected = new Set<string>()
    const ts = tracks()
    for (let i = 0; i < ts.length; i++) {
      const laneTop = i * LANE_HEIGHT
      const laneBottom = laneTop + LANE_HEIGHT
      const rTop = normY
      const rBottom = normY + height
      const verticalOverlap = !(laneBottom <= rTop || laneTop >= rBottom)
      if (!verticalOverlap) continue
      const track = ts[i]
      for (const clip of track.clips) {
        const cx1 = clip.startSec * PPS
        const cx2 = cx1 + clip.duration * PPS
        const rx1 = x
        const rx2 = x + width
        const horizontalOverlap = !(cx2 <= rx1 || cx1 >= rx2)
        if (horizontalOverlap) selected.add(clip.id)
      }
    }

    selectMarqueeClips(selected)
  }

  const laneDrag = useDrag({
    onDragMove: (_, event) => {
      onLaneDragMove(event, currentScrollEl)
    },
    onDragEnd: () => {
      onLaneDragUp()
    },
  })

  const onLaneDragUp = () => {
    stopScrub()
    setMarqueeRect(null)
    marqueeActive = false
    marqueeBaseClipIds = new Set<string>()
  }

  onCleanup(() => {
    onLaneDragUp()
  })

  return {
    marqueeRect,
    onLanePointerDown,
  }
}
