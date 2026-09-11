import { getAudioClipTimeMap, getMarkerWarpTimelineSegments } from '@daw-browser/timeline-core/audio-clip-time-map'
import type { Clip } from '@daw-browser/timeline-core/types'
import { normalizeSourceBeatOffsetValue } from '@daw-browser/shared'

type AudioWaveformLayoutSegment = {
  drawCols: number
  sourceStartSec: number
  sourceEndSec: number
  startPx: number
  endPx: number
  canvasStartSec: number
  canvasEndSec: number
}

type AudioWaveformLayout = {
  canvasStartSec?: number
  canvasEndSec?: number
  sourceDurationSec: number
  padPx: number
  drawCols: number
  audioStartPx: number
  audioEndPx: number
  sourceStartSec: number
  sourceEndSec: number
  segments?: AudioWaveformLayoutSegment[]
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

export function getAudioWaveformLayout(
  clip: Clip<AudioBuffer>,
  cssW: number,
  bufferDurationSec?: number,
  projectBpm = 120,
  window?: { startSec: number; endSec: number },
): AudioWaveformLayout {
  const sourceDurationSec = Math.max(
    bufferDurationSec ?? clip.sourceDurationSec ?? 0,
    0,
  )
  const map = getAudioClipTimeMap({
    clip,
    bufferDurationSec: sourceDurationSec,
    projectBpm,
    rangeStartSec: clip.startSec,
    rangeEndSec: clip.startSec + clip.duration,
  })
  if (!map) {
    return {
      sourceDurationSec,
      padPx: 0,
      drawCols: 0,
      audioStartPx: 0,
      audioEndPx: 0,
      sourceStartSec: 0,
      sourceEndSec: 0,
    }
  }

  const legacyPixelsPerSecond = cssW / Math.max(1e-6, clip.duration)
  const canvasStartSec = Math.max(clip.startSec, window?.startSec ?? clip.startSec)
  const canvasEndSec = Math.min(clip.startSec + clip.duration, window?.endSec ?? clip.startSec + clip.duration)
  const windowStartSec = window ? Math.max(map.timelineStartSec, canvasStartSec) : map.timelineStartSec
  const windowEndSec = window ? Math.min(map.timelineEndSec, canvasEndSec) : map.timelineStartSec + map.timelineDurationSec
  const windowDurationSec = Math.max(1e-6, canvasEndSec - canvasStartSec)
  const pixelsPerWindowSecond = window ? cssW / windowDurationSec : legacyPixelsPerSecond
  const padPx = Math.max(0, Math.floor((windowStartSec - canvasStartSec) * pixelsPerWindowSecond))
  const drawCols = Math.max(
    0,
    Math.min(cssW - padPx, Math.floor((windowEndSec - windowStartSec) * pixelsPerWindowSecond)),
  )
  const sourceStartSec = window ? roundSeconds(map.timelineToSourceSec(windowStartSec)) : roundSeconds(map.sourceStartSec)
  const sourceEndSec = Math.min(
    sourceDurationSec,
    roundSeconds(map.timelineToSourceSec(window ? windowEndSec : map.timelineStartSec + drawCols / legacyPixelsPerSecond)),
  )
  const audioStartPx = padPx
  const audioEndPx = Math.min(cssW, audioStartPx + drawCols)
  const segments = getMarkerWarpTimelineSegments({
    clip,
    map,
    projectBpm,
    timelineEndSec: windowEndSec,
  }).flatMap((segment) => {
    const timelineStartSec = segment.timelineStartSec
    const timelineEndSec = segment.timelineEndSec
    const segmentWindowStart = Math.max(timelineStartSec, canvasStartSec)
    const segmentWindowEnd = Math.min(timelineEndSec, canvasEndSec)
    const segmentStartPx = Math.floor((segmentWindowStart - canvasStartSec) * pixelsPerWindowSecond)
    const segmentEndPx = Math.floor((segmentWindowEnd - canvasStartSec) * pixelsPerWindowSecond)
    const segmentDrawCols = Math.max(0, segmentEndPx - segmentStartPx)
    if (segmentDrawCols <= 0) return []
    return [{
      drawCols: segmentDrawCols,
      sourceStartSec: Math.max(0, Math.min(sourceDurationSec, roundSeconds(map.timelineToSourceSec(segmentWindowStart)))),
      sourceEndSec: Math.max(0, Math.min(sourceDurationSec, roundSeconds(map.timelineToSourceSec(segmentWindowEnd)))),
      startPx: segmentStartPx,
      endPx: segmentEndPx,
      canvasStartSec: segmentWindowStart,
      canvasEndSec: segmentWindowEnd,
    }]
  })

  const layout = {
    sourceDurationSec,
    padPx,
    drawCols,
    audioStartPx,
    audioEndPx,
    sourceStartSec,
    sourceEndSec,
  }
  const windowedLayout = window ? { ...layout, canvasStartSec, canvasEndSec } : layout
  return segments.length > 1 ? { ...windowedLayout, segments } : windowedLayout
}
