import { createSignal, onCleanup, onMount } from 'solid-js'
import type { Accessor } from 'solid-js'

import { yToLaneIndex } from '~/lib/timeline-utils'
import type { Track } from '~/types/timeline'

type UseTimelineDragDropOptions = {
  tracks: Accessor<Track[]>
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
    const laneIndex = yToLaneIndex(clientY, scrollElement)
    const trackCount = options.tracks().length
    if (laneIndex >= 0 && laneIndex < trackCount) {
      setDropTargetLane(laneIndex)
      setDropAtNewTrack(false)
      return
    }
    if (laneIndex >= trackCount) {
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

  const isSampleDragInsideRoot = (event: DragEvent) => {
    const transfer = event.dataTransfer
    const types = Array.from(transfer?.types ?? [])
    if (!types.includes('application/x-mediabunny-sample')) return false
    const root = options.rootElement()
    if (!root) return false
    const bounds = root.getBoundingClientRect()
    return (
      event.clientX >= bounds.left
      && event.clientX <= bounds.right
      && event.clientY >= bounds.top
      && event.clientY <= bounds.bottom
    )
  }

  const handleRootDragOver = (event: DragEvent) => {
    event.preventDefault()
    setCopyDropEffect(event)
    updateDropTarget(event.clientY)
  }

  const handleRootDrop = async (event: DragEvent) => {
    if (event.defaultPrevented) return
    await options.onDrop(event)
    clearDropTarget()
  }

  const handleGlobalDragOver = (event: DragEvent) => {
    if (!isSampleDragInsideRoot(event)) return
    event.preventDefault()
    setCopyDropEffect(event)
    updateDropTarget(event.clientY)
  }

  const handleWindowDrop = (event: DragEvent) => {
    if (!isSampleDragInsideRoot(event)) return
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
