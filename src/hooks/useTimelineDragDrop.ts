import { createSignal, onCleanup, onMount } from 'solid-js'
import type { Accessor } from 'solid-js'

import { SAMPLE_DRAG_DATA_TYPE } from '~/lib/sample-drag-data'
import { RULER_HEIGHT } from '~/lib/timeline-utils'
import { trackIndexAtY, type TimelineTrackLayoutRow } from '~/lib/timeline-track-layout'

type UseTimelineDragDropOptions = {
  trackLayout: Accessor<TimelineTrackLayoutRow[]>
  rootElement: () => HTMLDivElement | undefined
  scrollElement: () => HTMLDivElement | undefined
  onDrop: (event: DragEvent) => Promise<void> | void
}

type UseTimelineDragDropReturn = {
  dropTargetLane: Accessor<number | null>
  dropAtNewTrack: Accessor<boolean>
  clearDropTarget: () => void
  handleRootDragOver: (event: DragEvent) => void
  handleRootDrop: (event: DragEvent) => Promise<void>
  handleRootDragLeave: () => void
}

export function useTimelineDragDrop(
  options: UseTimelineDragDropOptions,
): UseTimelineDragDropReturn {
  const capture = true
  const [dropTargetLane, setDropTargetLane] = createSignal<number | null>(null)
  const [dropAtNewTrack, setDropAtNewTrack] = createSignal(false)

  const clearDropTarget = () => {
    setDropTargetLane(null)
    setDropAtNewTrack(false)
  }

  const updateDropTarget = (clientY: number) => {
    const scrollElement = options.scrollElement()
    if (!scrollElement) return
    const rect = scrollElement.getBoundingClientRect()
    const y = clientY - rect.top + (scrollElement.scrollTop || 0) - RULER_HEIGHT
    const laneIndex = trackIndexAtY(options.trackLayout(), y)
    if (laneIndex >= 0) {
      setDropTargetLane(laneIndex)
      setDropAtNewTrack(false)
      return
    }
    const layout = options.trackLayout()
    const trackAreaBottom = layout.length === 0 ? 0 : layout[layout.length - 1].topPx + layout[layout.length - 1].heightPx
    if (y >= trackAreaBottom) {
      setDropTargetLane(null)
      setDropAtNewTrack(true)
      return
    }
    clearDropTarget()
  }

  const setCopyDropEffect = (event: DragEvent) => {
    try {
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy'
      }
    } catch {}
  }

  const isSupportedDrag = (event: DragEvent) => {
    const transfer = event.dataTransfer
    return Boolean(
      transfer?.types.includes(SAMPLE_DRAG_DATA_TYPE)
      || transfer?.types.includes('Files'),
    )
  }

  const isSupportedDragInsideTimeline = (event: DragEvent) => {
    if (!isSupportedDrag(event)) return false
    const scrollElement = options.scrollElement()
    if (!scrollElement) return false
    const bounds = scrollElement.getBoundingClientRect()
    return (
      event.clientX >= bounds.left
      && event.clientX <= bounds.right
      && event.clientY >= bounds.top
      && event.clientY <= bounds.bottom
    )
  }

  const handleRootDragOver = (event: DragEvent) => {
    if (!isSupportedDragInsideTimeline(event)) return
    event.preventDefault()
    setCopyDropEffect(event)
    updateDropTarget(event.clientY)
  }

  const handleRootDrop = async (event: DragEvent) => {
    if (event.defaultPrevented) return
    if (!isSupportedDragInsideTimeline(event)) return
    await options.onDrop(event)
    clearDropTarget()
  }

  const handleGlobalDragOver = (event: DragEvent) => {
    if (!isSupportedDragInsideTimeline(event)) return
    event.preventDefault()
    setCopyDropEffect(event)
    updateDropTarget(event.clientY)
  }

  const handleWindowDrop = (event: DragEvent) => {
    if (!isSupportedDragInsideTimeline(event)) return
    event.preventDefault()
    void options.onDrop(event)
    clearDropTarget()
  }

  onMount(() => {
    window.addEventListener('dragover', handleGlobalDragOver, capture)
    window.addEventListener('drop', handleWindowDrop, capture)
  })

  onCleanup(() => {
    window.removeEventListener('dragover', handleGlobalDragOver, capture)
    window.removeEventListener('drop', handleWindowDrop, capture)
  })

  return {
    dropTargetLane,
    dropAtNewTrack,
    clearDropTarget,
    handleRootDragOver,
    handleRootDrop,
    handleRootDragLeave: clearDropTarget,
  }
}
