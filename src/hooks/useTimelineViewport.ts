import { batch, createEffect, createSignal, on, onCleanup, type Accessor } from 'solid-js'

import {
  minimumVisibleDuration,
  normalizeTimelineRange,
  normalizeWheelZoomFactor,
  pixelsPerSecondForRange,
  ZOOM_STEP_FACTOR,
  zoomRangeAtAnchor,
  type TimelineRange,
} from '~/lib/timeline-view'
import {
  createTimelineViewport,
  MAX_PIXELS_PER_SECOND,
  TIMELINE_PHYSICAL_RUNWAY_WIDTH_PX,
  visibleStartAfterScrollDelta,
  type TimelineViewport,
} from '~/lib/timeline-viewport-geometry'

type UseTimelineViewportOptions = {
  persistenceScope: Accessor<string>
  pixelsPerSecond: Accessor<number>
  previewPixelsPerSecond: (value: number) => void
  commitPixelsPerSecond: (value: number) => void
  durationSec: Accessor<number>
  rightSidebarWidth: Accessor<number>
  canZoom: () => boolean
}

type TimelineScrollElement = {
  clientWidth: number
  scrollLeft: number
  addEventListener: (
    type: 'scroll',
    listener: () => void,
    options?: AddEventListenerOptions,
  ) => void
  removeEventListener: (type: 'scroll', listener: () => void) => void
  getBoundingClientRect: () => Pick<DOMRect, 'left'>
}

type TimelineWheelEvent = Pick<
  WheelEvent,
  'ctrlKey' | 'metaKey' | 'deltaY' | 'deltaMode' | 'clientX' | 'preventDefault'
>

export function useTimelineViewport(options: UseTimelineViewportOptions) {
  const [visibleStartSec, setVisibleStartSec] = createSignal(0)
  const [viewportWidth, setViewportWidth] = createSignal(0)
  let element: TimelineScrollElement | undefined
  let observer: ResizeObserver | undefined
  let wheelCommitTimeout: ReturnType<typeof setTimeout> | undefined
  let wheelFrame: number | undefined
  let pendingWheel: { deltaY: number; deltaMode: number; clientX: number } | undefined
  let suppressScroll = false
  let physicalAnchor = 0

  const physicalRunwayWidth = () => Math.max(
    viewportWidth(),
    TIMELINE_PHYSICAL_RUNWAY_WIDTH_PX,
  )

  const clearWheelCommit = () => {
    if (!wheelCommitTimeout) return
    clearTimeout(wheelCommitTimeout)
    wheelCommitTimeout = undefined
  }

  const setPhysicalAnchor = () => {
    if (!element) return
    const width = Math.max(0, element.clientWidth - options.rightSidebarWidth())
    const runwayWidth = Math.max(width, TIMELINE_PHYSICAL_RUNWAY_WIDTH_PX)
    physicalAnchor = Math.max(0, (runwayWidth - width) / 2)
    suppressScroll = true
    element.scrollLeft = physicalAnchor
    suppressScroll = false
  }

  createEffect(on(options.persistenceScope, () => {
    clearWheelCommit()
    setVisibleStartSec(0)
    setPhysicalAnchor()
  }))

  const measureWidth = () => {
    if (!element) return
    setViewportWidth(Math.max(0, element.clientWidth - options.rightSidebarWidth()))
    setPhysicalAnchor()
  }

  const updateScrollLeft = () => {
    if (!element || suppressScroll) return
    const deltaPx = element.scrollLeft - physicalAnchor
    if (Math.abs(deltaPx) < 0.5) return
    const next = visibleStartAfterScrollDelta({
      visibleStartSec: visibleStartSec(),
      viewportWidthPx: viewportWidth(),
      pixelsPerSecond: options.pixelsPerSecond(),
      durationSec: options.durationSec(),
    }, deltaPx)
    setVisibleStartSec(next)
    // The runway is deliberately bounded. Re-centering here keeps native scroll
    // coordinates small while retaining the user's vertical scroll position.
    setPhysicalAnchor()
  }

  const bind = (next: TimelineScrollElement) => {
    if (element === next) return
    clearWheelCommit()
    if (element) element.removeEventListener('scroll', updateScrollLeft)
    observer?.disconnect()
    element = next
    observer = new ResizeObserver(measureWidth)
    if (next instanceof Element) observer.observe(next)
    next.addEventListener('scroll', updateScrollLeft, { passive: true })
    measureWidth()
    setPhysicalAnchor()
  }

  createEffect(() => {
    options.rightSidebarWidth()
    measureWidth()
  })

  const visibleDurationSec = () => (
    viewportWidth() / Math.max(1e-9, options.pixelsPerSecond())
  )

  const viewport = (): TimelineViewport => ({
    ...createTimelineViewport({
      visibleStartSec: visibleStartSec(),
      viewportWidthPx: viewportWidth(),
      pixelsPerSecond: options.pixelsPerSecond(),
      durationSec: options.durationSec(),
    }),
    runwayWidth: physicalRunwayWidth(),
    runwayOffset: physicalAnchor,
  })

  const applyVisibleRange = (range: TimelineRange, commit: boolean, isWheelPreview = false) => {
    const width = viewportWidth()
    const minimumDuration = minimumVisibleDuration(width)
    const normalizedRange = normalizeTimelineRange(range, options.durationSec(), minimumDuration)
    const nextScale = pixelsPerSecondForRange(normalizedRange, width)
    batch(() => {
      if (commit) options.commitPixelsPerSecond(nextScale)
      else options.previewPixelsPerSecond(nextScale)
      setVisibleStartSec(normalizedRange.startSec)
      // Zoom changes logical time only; physical anchor is maintained by bind,
      // resize, reset, and native scroll paths.
    })
    if (!isWheelPreview) clearWheelCommit()
    return nextScale
  }

  const zoomAtPointer = (viewportX: number, factor: number, commit: boolean, isWheelPreview = false) => {
    if (!isWheelPreview) clearWheelCommit()
    if (!options.canZoom()) return
    const width = viewportWidth()
    const range = viewport().visibleRange
    const next = zoomRangeAtAnchor(
      range,
      width > 0 ? viewportX / width : 0.5,
      factor,
      options.durationSec(),
      width / MAX_PIXELS_PER_SECOND,
    )
    return applyVisibleRange(next, commit, isWheelPreview)
  }

  const zoomIn = () => zoomAtPointer(viewportWidth() / 2, ZOOM_STEP_FACTOR, true)
  const zoomOut = () => zoomAtPointer(viewportWidth() / 2, 1 / ZOOM_STEP_FACTOR, true)

  const zoomToFit = () => {
    clearWheelCommit()
    if (!options.canZoom()) return
    applyVisibleRange({ startSec: 0, endSec: options.durationSec() }, true)
  }

  const setVisibleStart = (startSec: number) => {
    const nextStart = Math.min(
      Math.max(0, Number.isFinite(startSec) ? startSec : 0),
      Math.max(0, options.durationSec() - visibleDurationSec()),
    )
    setVisibleStartSec(nextStart)
    setPhysicalAnchor()
  }

  const flushWheel = () => {
    wheelFrame = undefined
    const event = pendingWheel
    pendingWheel = undefined
    if (!event) return
    const rect = element?.getBoundingClientRect()
    const viewportX = rect
      ? Math.min(viewportWidth(), Math.max(0, event.clientX - rect.left))
      : viewportWidth() / 2
    const previewedScale = zoomAtPointer(
      viewportX,
      normalizeWheelZoomFactor(event.deltaY, event.deltaMode),
      false,
      true,
    )
    if (previewedScale === undefined) return
    clearWheelCommit()
    // Wheel events have no terminal event. One timer commits the settled scale.
    wheelCommitTimeout = setTimeout(() => {
      wheelCommitTimeout = undefined
      options.commitPixelsPerSecond(previewedScale)
    }, 150)
  }

  const onWheel = (event: TimelineWheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    const previous = pendingWheel
    pendingWheel = {
      deltaY: (previous?.deltaY ?? 0) + event.deltaY,
      deltaMode: event.deltaMode,
      clientX: event.clientX,
    }
    if (wheelFrame === undefined) {
      // Coalesce high-frequency trackpad events to one expensive viewport update
      // per frame; cleanup below cancels the scheduled frame deterministically.
      wheelFrame = requestAnimationFrame(flushWheel)
    }
  }

  onCleanup(() => {
    if (element) element.removeEventListener('scroll', updateScrollLeft)
    observer?.disconnect()
    clearWheelCommit()
    pendingWheel = undefined
    if (wheelFrame !== undefined) cancelAnimationFrame(wheelFrame)
  })

  return {
    bind,
    viewport,
    visibleRange: () => viewport().visibleRange,
    previewVisibleRange: (range: TimelineRange) => applyVisibleRange(range, false),
    commitVisibleRange: (range: TimelineRange) => applyVisibleRange(range, true),
    setVisibleStart,
    usableWidth: viewportWidth,
    physicalRunwayWidth,
    physicalOffset: () => physicalAnchor,
    zoomIn,
    zoomOut,
    zoomToFit,
    onWheel,
  }
}
