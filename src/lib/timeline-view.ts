export const DEFAULT_PIXELS_PER_SECOND = 100
export const MIN_PIXELS_PER_SECOND = 0.25
export const MAX_PIXELS_PER_SECOND = 800
export const ZOOM_STEP_FACTOR = 1.25

export type TimelineRange = { startSec: number; endSec: number }

export const clampPixelsPerSecond = (value: number) => (
  Number.isFinite(value)
    ? Math.min(MAX_PIXELS_PER_SECOND, Math.max(MIN_PIXELS_PER_SECOND, value))
    : DEFAULT_PIXELS_PER_SECOND
)

export const secondsToPixels = (seconds: number, pixelsPerSecond: number) => (
  Math.max(0, seconds) * clampPixelsPerSecond(pixelsPerSecond)
)

export const pixelsToSeconds = (pixels: number, pixelsPerSecond: number) => (
  Math.max(0, pixels) / clampPixelsPerSecond(pixelsPerSecond)
)

export const normalizeTimelineRange = (
  range: TimelineRange,
  durationSec: number,
  minimumDurationSec = 0,
): TimelineRange => {
  const duration = Math.max(0, durationSec)
  const minimum = Math.min(duration, Math.max(0, minimumDurationSec))
  const rawStart = Number.isFinite(range.startSec) ? range.startSec : 0
  const rawEnd = Number.isFinite(range.endSec) ? range.endSec : rawStart + minimum
  const start = Math.min(rawStart, rawEnd)
  const end = Math.max(rawStart, rawEnd)
  const rangeDuration = Math.max(minimum, end - start)
  const clampedStart = Math.min(Math.max(0, start), Math.max(0, duration - rangeDuration))
  return { startSec: clampedStart, endSec: Math.min(duration, clampedStart + rangeDuration) }
}

export const timelineViewportRange = (
  scrollLeft: number,
  viewportWidth: number,
  pixelsPerSecond: number,
  durationSec: number,
) => normalizeTimelineRange({
  startSec: pixelsToSeconds(scrollLeft, pixelsPerSecond),
  endSec: pixelsToSeconds(Math.max(0, scrollLeft) + Math.max(0, viewportWidth), pixelsPerSecond),
}, durationSec)

export const scrollLeftForTimelineRange = (
  range: TimelineRange,
  viewportWidth: number,
  pixelsPerSecond: number,
  durationSec: number,
) => {
  const totalWidth = secondsToPixels(durationSec, pixelsPerSecond)
  const maxScroll = Math.max(0, totalWidth - Math.max(0, viewportWidth))
  return Math.min(maxScroll, Math.max(0, secondsToPixels(range.startSec, pixelsPerSecond)))
}

export const pixelsPerSecondForRange = (range: TimelineRange, viewportWidth: number) => (
  clampPixelsPerSecond(Math.max(0, viewportWidth) / Math.max(1e-6, range.endSec - range.startSec))
)

export const zoomRangeAtAnchor = (
  range: TimelineRange,
  anchorFraction: number,
  factor: number,
  durationSec: number,
  minimumDurationSec: number,
) => {
  const normalizedAnchor = Math.min(1, Math.max(0, Number.isFinite(anchorFraction) ? anchorFraction : 0.5))
  const rangeDuration = Math.max(1e-6, range.endSec - range.startSec)
  const nextDuration = Math.min(durationSec, Math.max(minimumDurationSec, rangeDuration / Math.max(1e-6, factor)))
  const anchorTime = range.startSec + rangeDuration * normalizedAnchor
  return normalizeTimelineRange({
    startSec: anchorTime - nextDuration * normalizedAnchor,
    endSec: anchorTime + nextDuration * (1 - normalizedAnchor),
  }, durationSec, minimumDurationSec)
}

export const minimumVisibleDuration = (viewportWidth: number) => (
  Math.max(0, viewportWidth) / MAX_PIXELS_PER_SECOND
)

export const normalizeWheelZoomFactor = (deltaY: number, deltaMode: number) => {
  const unit = deltaMode === 1
    ? 16
    : deltaMode === 2
      ? 800
      : 1
  const normalizedDelta = Number.isFinite(deltaY)
    ? Math.min(240, Math.max(-240, deltaY * unit))
    : 0
  return Math.exp(-normalizedDelta / 400)
}

export const musicalBarLabelAtTime = (timeSec: number, bpm: number) => (
  Math.floor(Math.max(0, timeSec) / (60 / Math.max(1e-6, bpm) * 4)) + 1
)

type TimelineGridIntervals = { minorSec: number; majorSec: number }

const secondsIntervals = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]

export const selectTimelineGridIntervals = (
  pixelsPerSecond: number,
  bpm: number,
  denominator: number,
  gridEnabled: boolean,
): TimelineGridIntervals => {
  const scale = clampPixelsPerSecond(pixelsPerSecond)
  if (gridEnabled) {
    const beat = 60 / Math.max(1e-6, bpm)
    const base = beat * 4 / Math.max(1, denominator)
    let minor = base
    while (minor * scale < 8) minor *= 2
    let major = beat * 4
    while (major * scale < 56) major *= 2
    while (major < minor) major *= 2
    return { minorSec: minor, majorSec: major }
  }
  const minorSec = secondsIntervals.find((candidate) => candidate * scale >= 8) ?? secondsIntervals[secondsIntervals.length - 1]
  const majorSec = secondsIntervals.find((candidate) => candidate >= minorSec && candidate * scale >= 56) ?? secondsIntervals[secondsIntervals.length - 1]
  return { minorSec, majorSec }
}
