import { batch, createSignal, type Accessor, type Setter } from 'solid-js'

import { PPS, RULER_HEIGHT, LANE_HEIGHT } from '~/lib/timeline-utils'
import type { Track } from '~/types/timeline'

export type TimelineSelectionOptions = {
  tracks: Accessor<Track[]>
  setSelectedTrackId: Setter<string>
  setSelectedClip: Setter<{ trackId: string; clipId: string } | null>
  setSelectedClipIds: Setter<Set<string>>
  setSelectedFXTarget: Setter<string>
  startScrub: (clientX: number) => void
  stopScrub: () => void
}

export type TimelineSelection = {
  marqueeRect: Accessor<{ x: number; y: number; width: number; height: number } | null>
  setMarqueeRect: Setter<{ x: number; y: number; width: number; height: number } | null>
  onLaneMouseDown: (event: MouseEvent, scrollEl: HTMLDivElement | undefined) => void
  onLaneDragMove: (event: MouseEvent, scrollEl: HTMLDivElement | undefined) => void
  onLaneDragUp: () => void
}

export function useTimelineSelection(options: TimelineSelectionOptions): TimelineSelection {
  const {
    tracks,
    setSelectedTrackId,
    setSelectedClip,
    setSelectedClipIds,
    setSelectedFXTarget,
    startScrub,
    stopScrub,
  } = options

  const [marqueeRect, setMarqueeRect] = createSignal<{ x: number; y: number; width: number; height: number } | null>(null)

  let marqueeActive = false
  let marqueeAdditive = false
  let startX = 0
  let startY = 0

  const onLaneMouseDown = (event: MouseEvent, scrollEl: HTMLDivElement | undefined) => {
    event.preventDefault()
    const ts = tracks()
    if (ts.length === 0 || !scrollEl) return

    currentScrollEl = scrollEl

    let trackIdx = Math.max(
      0,
      Math.min(
        ts.length - 1,
        Math.floor((event.clientY - scrollEl.getBoundingClientRect().top + (scrollEl.scrollTop || 0) - RULER_HEIGHT) / LANE_HEIGHT),
      ),
    )
    const id = ts[trackIdx]?.id
    if (id) {
      batch(() => {
        setSelectedTrackId(id)
        setSelectedFXTarget(id)
        setSelectedClip(null)
        if (!event.shiftKey) setSelectedClipIds(new Set<string>())
      })
    }

    marqueeAdditive = !!event.shiftKey
    const rect = scrollEl.getBoundingClientRect()
    startX = event.clientX - rect.left + (scrollEl.scrollLeft || 0)
    startY = event.clientY - rect.top + (scrollEl.scrollTop || 0)
    marqueeActive = false
    window.addEventListener('mousemove', handleDragMove)
    window.addEventListener('mouseup', handleDragUp)
    startScrub(event.clientX)
  }

  const handleDragMove = (event: MouseEvent) => {
    const scrollEl = currentScrollEl
    if (!scrollEl) return
    onLaneDragMove(event, scrollEl)
  }

  const handleDragUp = () => {
    onLaneDragUp()
  }

  let currentScrollEl: HTMLDivElement | undefined
  const onLaneDragMove = (event: MouseEvent, scrollEl: HTMLDivElement | undefined) => {
    currentScrollEl = scrollEl
    if (!scrollEl) return

    const rect = scrollEl.getBoundingClientRect()
    const currentX = event.clientX - rect.left + (scrollEl.scrollLeft || 0)
    const currentY = event.clientY - rect.top + (scrollEl.scrollTop || 0)
    const dx = Math.abs(currentX - startX)
    const dy = Math.abs(currentY - startY)

    if (!marqueeActive && (dx > 4 || dy > 4)) {
      marqueeActive = true
      stopScrub()
    }

    if (!marqueeActive) return

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

    if (marqueeAdditive) {
      setSelectedClipIds(prev => {
        const next = new Set<string>(prev)
        for (const id of selected) next.add(id)
        return next
      })
    } else {
      setSelectedClipIds(selected)
    }
  }

  const onLaneDragUp = () => {
    window.removeEventListener('mousemove', handleDragMove)
    window.removeEventListener('mouseup', handleDragUp)
    setMarqueeRect(null)
    marqueeActive = false
    currentScrollEl = undefined
  }

  return {
    marqueeRect,
    setMarqueeRect,
    onLaneMouseDown,
    onLaneDragMove,
    onLaneDragUp,
  }
}
