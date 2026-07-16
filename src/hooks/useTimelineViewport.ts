import { createEffect, createSignal, on, onCleanup, type Accessor } from 'solid-js'

import {
  minimumVisibleDuration,
  normalizeTimelineRange,
  normalizeWheelZoomFactor,
  pixelsPerSecondForRange,
  scrollLeftForTimelineRange,
  timelineViewportRange,
  ZOOM_STEP_FACTOR,
  zoomRangeAtAnchor,
  type TimelineRange,
} from '~/lib/timeline-view'

type UseTimelineViewportOptions = {
  persistenceScope: Accessor<string>
  pixelsPerSecond: Accessor<number>
  previewPixelsPerSecond: (value: number) => void
  commitPixelsPerSecond: (value: number) => void
  durationSec: Accessor<number>
  rightSidebarWidth: Accessor<number>
  canZoom: () => boolean
}

export function useTimelineViewport(options: UseTimelineViewportOptions) {
  const [scrollLeft, setScrollLeft] = createSignal(0)
  const [viewportWidth, setViewportWidth] = createSignal(0)
  let element: HTMLDivElement | undefined
  let observer: ResizeObserver | undefined
  let wheelCommitTimeout: ReturnType<typeof setTimeout> | undefined

  const clearWheelCommit = () => {
    if (!wheelCommitTimeout) return
    clearTimeout(wheelCommitTimeout)
    wheelCommitTimeout = undefined
  }

  createEffect(on(options.persistenceScope, clearWheelCommit))

  const measureWidth = () => {
    if (!element) return
    setViewportWidth(Math.max(0, element.clientWidth - options.rightSidebarWidth()))
  }

  const updateScrollLeft = () => {
    if (!element) return
    setScrollLeft(element.scrollLeft)
  }

  const bind = (next: HTMLDivElement) => {
    if (element === next) return
    clearWheelCommit()
    if (element) element.removeEventListener('scroll', updateScrollLeft)
    observer?.disconnect()
    element = next
    observer = new ResizeObserver(measureWidth)
    observer.observe(next)
    next.addEventListener('scroll', updateScrollLeft, { passive: true })
    measureWidth()
    updateScrollLeft()
  }

  createEffect(() => {
    options.rightSidebarWidth()
    measureWidth()
  })

  const visibleRange = () => timelineViewportRange(
    scrollLeft(),
    viewportWidth(),
    options.pixelsPerSecond(),
    options.durationSec(),
  )

  const applyVisibleRange = (range: TimelineRange, commit: boolean, isWheelPreview = false) => {
    if (!element) return
    if (!isWheelPreview) clearWheelCommit()
    const width = viewportWidth()
    const minimumDuration = minimumVisibleDuration(width)
    const normalizedRange = normalizeTimelineRange(range, options.durationSec(), minimumDuration)
    const nextScale = pixelsPerSecondForRange(normalizedRange, width)
    if (commit) options.commitPixelsPerSecond(nextScale)
    else options.previewPixelsPerSecond(nextScale)
    element.scrollLeft = scrollLeftForTimelineRange(normalizedRange, width, nextScale, options.durationSec())
    updateScrollLeft()
    return nextScale
  }

  const zoomAtPointer = (viewportX: number, factor: number, commit: boolean, isWheelPreview = false) => {
    if (!isWheelPreview) clearWheelCommit()
    if (!element || !options.canZoom()) return
    const width = viewportWidth()
    const range = visibleRange()
    const next = zoomRangeAtAnchor(
      range,
      width > 0 ? viewportX / width : 0.5,
      factor,
      options.durationSec(),
      width / 800,
    )
    return applyVisibleRange(next, commit, isWheelPreview)
  }

  const zoomIn = () => zoomAtPointer(viewportWidth() / 2, ZOOM_STEP_FACTOR, true)

  const zoomOut = () => zoomAtPointer(viewportWidth() / 2, 1 / ZOOM_STEP_FACTOR, true)

  const zoomToFit = () => {
    clearWheelCommit()
    if (!element || !options.canZoom()) return
    applyVisibleRange({ startSec: 0, endSec: options.durationSec() }, true)
  }

  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return
    const rect = element?.getBoundingClientRect()
    const previewedScale = zoomAtPointer(
      rect ? event.clientX - rect.left : viewportWidth() / 2,
      normalizeWheelZoomFactor(event.deltaY, event.deltaMode),
      false,
      true,
    )
    if (previewedScale === undefined) return
    event.preventDefault()
    clearWheelCommit()
    // Wheel events have no terminal event, so this coalesces persistence after the gesture settles.
    wheelCommitTimeout = setTimeout(() => {
      wheelCommitTimeout = undefined
      options.commitPixelsPerSecond(previewedScale)
    }, 150)
  }

  onCleanup(() => {
    if (element) element.removeEventListener('scroll', updateScrollLeft)
    observer?.disconnect()
    clearWheelCommit()
  })

  return {
    bind,
    visibleRange,
    previewVisibleRange: (range: TimelineRange) => applyVisibleRange(range, false),
    commitVisibleRange: (range: TimelineRange) => applyVisibleRange(range, true),
    usableWidth: viewportWidth,
    zoomIn,
    zoomOut,
    zoomToFit,
    onWheel,
  }
}
