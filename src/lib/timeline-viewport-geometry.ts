export const MAX_PIXELS_PER_SECOND = 480_000

export type TimelineViewportGeometry = {
  visibleStartSec: number
  viewportWidthPx: number
  pixelsPerSecond: number
  durationSec: number
}

export type TimelineViewportRange = {
  startSec: number
  endSec: number
}

export type TimelineViewportIntersection = TimelineViewportRange & {
  startPx: number
  endPx: number
}

export type TimelineViewportProjection = {
  leftPx: number
  widthPx: number
}

export type TimelineClipViewportSlice = {
  startSec: number
  endSec: number
  startPx: number
  widthPx: number
  hasLeftBoundary: boolean
  hasRightBoundary: boolean
}

export type TimelineViewport = {
  visibleRange: TimelineViewportRange
  overscanRange: TimelineViewportRange
  width: number
  pixelsPerSecond: number
  timeToX: (timeSec: number) => number
  xToTime: (x: number) => number
  runwayWidth: number
  runwayOffset: number
}

export const TIMELINE_VIEWPORT_OVERSCAN_PX = 512
export const TIMELINE_PHYSICAL_RUNWAY_WIDTH_PX = 200_000

export type BoundedPhysicalRunway = {
  startSec: number
  widthPx: number
  visibleStartPx: number
  visibleEndPx: number
  recenteredStartSec: number
  needsRecentering: boolean
}

const finiteNonNegative = (value: number) => Number.isFinite(value) && value >= 0

const safePixelsPerSecond = (value: number) => (
  Number.isFinite(value) && value > 0
    ? Math.min(MAX_PIXELS_PER_SECOND, value)
    : 1
)

const safeGeometry = (input: TimelineViewportGeometry) => ({
  visibleStartSec: finiteNonNegative(input.visibleStartSec) ? input.visibleStartSec : 0,
  viewportWidthPx: finiteNonNegative(input.viewportWidthPx) ? input.viewportWidthPx : 0,
  pixelsPerSecond: safePixelsPerSecond(input.pixelsPerSecond),
  durationSec: finiteNonNegative(input.durationSec) ? input.durationSec : 0,
})

export const visibleDurationSec = (input: TimelineViewportGeometry) => {
  const geometry = safeGeometry(input)
  return geometry.viewportWidthPx / geometry.pixelsPerSecond
}

export const clampedVisibleStartSec = (input: TimelineViewportGeometry) => {
  const geometry = safeGeometry(input)
  const duration = visibleDurationSec(geometry)
  return Math.min(Math.max(0, geometry.visibleStartSec), Math.max(0, geometry.durationSec - duration))
}

export const visibleEndSec = (input: TimelineViewportGeometry) => (
  Math.min(safeGeometry(input).durationSec, clampedVisibleStartSec(input) + visibleDurationSec(input))
)

export const visibleStartAfterScrollDelta = (input: TimelineViewportGeometry, deltaPx: number) => {
  const geometry = safeGeometry(input)
  const currentStart = clampedVisibleStartSec(geometry)
  const deltaSeconds = Number.isFinite(deltaPx)
    ? deltaPx / geometry.pixelsPerSecond
    : 0
  return Math.min(
    Math.max(0, currentStart + deltaSeconds),
    Math.max(0, geometry.durationSec - visibleDurationSec(geometry)),
  )
}

export const timeToViewportX = (input: TimelineViewportGeometry, timeSec: number) => (
  (timeSec - clampedVisibleStartSec(input)) * safePixelsPerSecond(input.pixelsPerSecond)
)

export const viewportXToTime = (input: TimelineViewportGeometry, viewportX: number) => (
  clampedVisibleStartSec(input) + Math.max(0, Number.isFinite(viewportX) ? viewportX : 0) / safePixelsPerSecond(input.pixelsPerSecond)
)

export const createTimelineViewport = (input: TimelineViewportGeometry): TimelineViewport => {
  const geometry = safeGeometry(input)
  const startSec = clampedVisibleStartSec(geometry)
  const visibleDuration = visibleDurationSec(geometry)
  const endSec = Math.min(geometry.durationSec, startSec + visibleDuration)
  const overscan = TIMELINE_VIEWPORT_OVERSCAN_PX / geometry.pixelsPerSecond
  const visibleRange = { startSec, endSec }
  const overscanRange = {
    startSec: Math.max(0, startSec - overscan),
    endSec: Math.min(geometry.durationSec, endSec + overscan),
  }
  return {
    visibleRange,
    overscanRange,
    width: geometry.viewportWidthPx,
    pixelsPerSecond: geometry.pixelsPerSecond,
    timeToX: (timeSec) => timeToViewportX(geometry, timeSec),
    xToTime: (x) => viewportXToTime(geometry, x),
    runwayWidth: geometry.viewportWidthPx,
    runwayOffset: 0,
  }
}

export const visibleIntersectionWithOverscan = (
  input: TimelineViewportGeometry,
  range: TimelineViewportRange,
  overscanPx: number,
): TimelineViewportIntersection | null => {
  const geometry = safeGeometry(input)
  const start = Math.min(range.startSec, range.endSec)
  const end = Math.max(range.startSec, range.endSec)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  const overscan = finiteNonNegative(overscanPx) ? overscanPx : 0
  const startPx = Math.max(0, timeToViewportX(geometry, start) - overscan)
  const endPx = Math.min(
    geometry.viewportWidthPx,
    timeToViewportX(geometry, end) + overscan,
  )
  if (endPx <= startPx) return null
  return {
    startSec: viewportXToTime(geometry, startPx),
    endSec: viewportXToTime(geometry, endPx),
    startPx,
    endPx,
  }
}

export const intersectTimelineRangeWithViewport = (input: {
  range: TimelineViewportRange
  visibleStartSec: number
  viewportWidthPx: number
  pixelsPerSecond: number
}): TimelineViewportProjection | null => {
  const visibleStartSec = finiteNonNegative(input.visibleStartSec) ? input.visibleStartSec : 0
  const viewportWidthPx = finiteNonNegative(input.viewportWidthPx) ? input.viewportWidthPx : 0
  const pixelsPerSecond = safePixelsPerSecond(input.pixelsPerSecond)
  const rangeStartSec = Math.min(input.range.startSec, input.range.endSec)
  const rangeEndSec = Math.max(input.range.startSec, input.range.endSec)
  if (!Number.isFinite(rangeStartSec) || !Number.isFinite(rangeEndSec) || rangeEndSec <= rangeStartSec) return null
  const visibleEndSec = visibleStartSec + viewportWidthPx / pixelsPerSecond
  const startSec = Math.max(visibleStartSec, rangeStartSec)
  const endSec = Math.min(visibleEndSec, rangeEndSec)
  if (endSec <= startSec) return null
  const leftPx = Math.max(0, Math.min(viewportWidthPx, (startSec - visibleStartSec) * pixelsPerSecond))
  const rightPx = Math.max(leftPx, Math.min(viewportWidthPx, (endSec - visibleStartSec) * pixelsPerSecond))
  if (rightPx <= leftPx) return null
  return { leftPx, widthPx: rightPx - leftPx }
}

export const getTimelineClipViewportSlice = (input: {
  clipStartSec: number
  clipDurationSec: number
  visibleRange: TimelineViewportRange
  pixelsPerSecond: number
}): TimelineClipViewportSlice | null => {
  const clipEndSec = input.clipStartSec + input.clipDurationSec
  const startSec = Math.max(input.clipStartSec, input.visibleRange.startSec)
  const endSec = Math.min(clipEndSec, input.visibleRange.endSec)
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return null
  const pixelsPerSecond = safePixelsPerSecond(input.pixelsPerSecond)
  return {
    startSec,
    endSec,
    startPx: (startSec - input.visibleRange.startSec) * pixelsPerSecond,
    widthPx: (endSec - startSec) * pixelsPerSecond,
    hasLeftBoundary: input.clipStartSec >= input.visibleRange.startSec
      && input.clipStartSec <= input.visibleRange.endSec,
    hasRightBoundary: clipEndSec >= input.visibleRange.startSec
      && clipEndSec <= input.visibleRange.endSec,
  }
}

export const scaleViewportAtPointer = (
  input: TimelineViewportGeometry,
  pointerX: number,
  nextPixelsPerSecond: number,
): TimelineViewportGeometry => {
  const geometry = safeGeometry(input)
  const safePointerX = Math.min(
    geometry.viewportWidthPx,
    Math.max(0, Number.isFinite(pointerX) ? pointerX : geometry.viewportWidthPx / 2),
  )
  const anchorTime = viewportXToTime(geometry, safePointerX)
  const nextScale = safePixelsPerSecond(nextPixelsPerSecond)
  const nextDuration = geometry.viewportWidthPx / nextScale
  const nextStart = anchorTime - safePointerX / nextScale
  return {
    ...geometry,
    visibleStartSec: Math.min(
      Math.max(0, nextStart),
      Math.max(0, geometry.durationSec - nextDuration),
    ),
    pixelsPerSecond: nextScale,
  }
}

export const calculateBoundedPhysicalRunway = (input: {
  visibleStartSec: number
  viewportWidthPx: number
  pixelsPerSecond: number
  maxRunwayWidthPx: number
  recenterMarginPx?: number
}): BoundedPhysicalRunway => {
  const pixelsPerSecond = safePixelsPerSecond(input.pixelsPerSecond)
  const viewportWidthPx = finiteNonNegative(input.viewportWidthPx) ? input.viewportWidthPx : 0
  const maxRunwayWidthPx = finiteNonNegative(input.maxRunwayWidthPx) ? input.maxRunwayWidthPx : 0
  const widthPx = Math.max(viewportWidthPx, maxRunwayWidthPx)
  const marginPx = input.recenterMarginPx !== undefined && finiteNonNegative(input.recenterMarginPx)
    ? input.recenterMarginPx
    : widthPx / 4
  const visibleStartSec = finiteNonNegative(input.visibleStartSec) ? input.visibleStartSec : 0
  const visibleStartPx = visibleStartSec * pixelsPerSecond
  const visibleEndPx = visibleStartPx + viewportWidthPx
  const startSec = Math.max(0, visibleStartSec - (widthPx - viewportWidthPx) / pixelsPerSecond / 2)
  const recenteredStartSec = Math.max(0, visibleStartSec - (widthPx - viewportWidthPx) / pixelsPerSecond / 2)
  return {
    startSec,
    widthPx,
    visibleStartPx: visibleStartPx - startSec * pixelsPerSecond,
    visibleEndPx: visibleEndPx - startSec * pixelsPerSecond,
    recenteredStartSec,
    needsRecentering: visibleStartPx < marginPx || visibleEndPx > widthPx - marginPx,
  }
}
