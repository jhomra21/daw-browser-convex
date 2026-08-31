import { getAudioClipTimeMap, getMarkerWarpTimelineSegments } from '@daw-browser/timeline-core/audio-clip-time-map'
import type { Clip } from '@daw-browser/timeline-core/types'
import { normalizeSourceBeatOffsetValue } from '@daw-browser/shared'

type AudioWaveformLayoutSegment = {
  drawStartPx: number
  drawCols: number
  timelineStartSec: number
  timelineEndSec: number
  sourceStartSec: number
  sourceEndSec: number
}

type AudioWaveformLayout = {
  sourceDurationSec: number
  visibleTimelineStartSec: number
  visibleTimelineEndSec: number
  padPx: number
  drawCols: number
  audioStartPx: number
  audioEndPx: number
  sourceStartSec: number
  sourceEndSec: number
  segments?: AudioWaveformLayoutSegment[]
}

export type AudioWaveformVisibleRange = {
  startSec: number
  endSec: number
}

const roundSeconds = (value: number) => Math.round(value * 1_000_000_000) / 1_000_000_000
const SOURCE_BEAT_OFFSET_SNAP = 0.25

const normalizeSourceBeatOffsetForDrag = (value: number, snap: boolean) => {
  const snapped = snap ? Math.round(value / SOURCE_BEAT_OFFSET_SNAP) * SOURCE_BEAT_OFFSET_SNAP : value
  return normalizeSourceBeatOffsetValue(snapped)
}

export const getSourceBeatOffsetAnchorX = (input: {
  sourceBeatOffset: number
  clipDurationSec: number
  cssWidthPx: number
  projectBpm: number
  leftPadSec?: number
}) => {
  const secondsPerBeat = 60 / Math.max(1, input.projectBpm)
  const timelineOffsetSec = Math.max(0, input.leftPadSec ?? 0) + input.sourceBeatOffset * secondsPerBeat
  return (timelineOffsetSec / Math.max(1e-6, input.clipDurationSec)) * input.cssWidthPx
}

export const getSourceBeatOffsetFromAnchorX = (input: {
  anchorX: number
  clipDurationSec: number
  cssWidthPx: number
  projectBpm: number
  leftPadSec?: number
  snap: boolean
}) => {
  const timelineOffsetSec = (input.anchorX / Math.max(1, input.cssWidthPx)) * Math.max(1e-6, input.clipDurationSec)
  const secondsPerBeat = 60 / Math.max(1, input.projectBpm)
  return normalizeSourceBeatOffsetForDrag(
    (timelineOffsetSec - Math.max(0, input.leftPadSec ?? 0)) / secondsPerBeat,
    input.snap,
  )
}

const emptyLayout = (
  sourceDurationSec: number,
  visibleTimelineStartSec: number,
  visibleTimelineEndSec: number,
): AudioWaveformLayout => ({
  sourceDurationSec,
  visibleTimelineStartSec,
  visibleTimelineEndSec,
  padPx: 0,
  drawCols: 0,
  audioStartPx: 0,
  audioEndPx: 0,
  sourceStartSec: 0,
  sourceEndSec: 0,
})

const resolveVisibleTimelineRange = (
  clip: Clip<AudioBuffer>,
  visibleRange?: AudioWaveformVisibleRange,
) => {
  const clipStartSec = clip.startSec
  const clipEndSec = clip.startSec + Math.max(0, clip.duration)
  if (!visibleRange) return { startSec: clipStartSec, endSec: clipEndSec }
  if (!Number.isFinite(visibleRange.startSec)
    || !Number.isFinite(visibleRange.endSec)
    || visibleRange.endSec <= visibleRange.startSec) return null
  const startSec = Math.max(clipStartSec, Math.min(clipEndSec, visibleRange.startSec))
  const endSec = Math.max(startSec, Math.min(clipEndSec, visibleRange.endSec))
  return endSec > startSec ? { startSec, endSec } : null
}

export function getAudioWaveformLayout(
  clip: Clip<AudioBuffer>,
  cssW: number,
  bufferDurationSec?: number,
  projectBpm = 120,
  visibleRange?: AudioWaveformVisibleRange,
): AudioWaveformLayout {
  const sourceDurationSec = Math.max(
    bufferDurationSec ?? clip.sourceDurationSec ?? 0,
    0,
  )
  const range = resolveVisibleTimelineRange(clip, visibleRange)
  if (!range || !Number.isFinite(cssW) || cssW <= 0) {
    return emptyLayout(sourceDurationSec, range?.startSec ?? clip.startSec, range?.endSec ?? clip.startSec)
  }

  const map = getAudioClipTimeMap({
    clip,
    bufferDurationSec: sourceDurationSec,
    projectBpm,
    rangeStartSec: range.startSec,
    rangeEndSec: range.endSec,
  })
  if (!map) return emptyLayout(sourceDurationSec, range.startSec, range.endSec)

  const visibleDurationSec = range.endSec - range.startSec
  const pixelsPerSecond = cssW / visibleDurationSec
  const padPx = Math.max(0, Math.floor((map.timelineStartSec - range.startSec) * pixelsPerSecond))
  const drawCols = Math.max(
    0,
    Math.min(cssW - padPx, Math.floor(map.timelineDurationSec * pixelsPerSecond)),
  )
  const sourceStartSec = roundSeconds(map.sourceStartSec)
  const sourceEndSec = Math.min(
    sourceDurationSec,
    roundSeconds(map.timelineToSourceSec(map.timelineStartSec + drawCols / pixelsPerSecond)),
  )
  const audioStartPx = padPx
  const audioEndPx = Math.min(cssW, audioStartPx + drawCols)
  const segments = getMarkerWarpTimelineSegments({
    clip,
    map,
    projectBpm,
    timelineEndSec: map.timelineStartSec + drawCols / pixelsPerSecond,
  }).flatMap((segment) => {
    const timelineStartSec = segment.timelineStartSec
    const timelineEndSec = segment.timelineEndSec
    const segmentStartPx = Math.floor((timelineStartSec - range.startSec) * pixelsPerSecond)
    const segmentEndPx = Math.floor((timelineEndSec - range.startSec) * pixelsPerSecond)
    const drawStartPx = Math.max(0, Math.min(cssW, segmentStartPx))
    const segmentDrawCols = Math.max(0, Math.min(cssW, segmentEndPx) - drawStartPx)
    if (segmentDrawCols <= 0) return []
    return [{
      drawStartPx,
      drawCols: segmentDrawCols,
      timelineStartSec,
      timelineEndSec,
      sourceStartSec: Math.max(0, Math.min(sourceDurationSec, roundSeconds(map.timelineToSourceSec(timelineStartSec)))),
      sourceEndSec: Math.max(0, Math.min(sourceDurationSec, roundSeconds(map.timelineToSourceSec(timelineEndSec)))),
    }]
  })

  const layout = {
    sourceDurationSec,
    visibleTimelineStartSec: range.startSec,
    visibleTimelineEndSec: range.endSec,
    padPx,
    drawCols,
    audioStartPx,
    audioEndPx,
    sourceStartSec,
    sourceEndSec,
  }
  return segments.length > 1 ? { ...layout, segments } : layout
}
