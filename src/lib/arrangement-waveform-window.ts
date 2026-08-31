import type { Clip } from '@daw-browser/timeline-core/types'
import { selectWaveformLod } from '@daw-browser/waveforms/lod'
import { getAudioWaveformLayout } from './audio-waveform-layout'

export type ArrangementWaveformTimelineRange = {
  startSec: number
  endSec: number
}

export type ArrangementWaveformVisibleSegment = {
  drawStartPx: number
  drawCols: number
  timelineStartSec: number
  timelineEndSec: number
  sourceStartSec: number
  sourceEndSec: number
}

export type ArrangementWaveformRoute = 'cached-peaks' | 'pcm-envelope'

export const selectArrangementWaveformRoute = (input: {
  sampleRate: number
  sourceStartSec: number
  sourceEndSec: number
  drawCols: number
}): ArrangementWaveformRoute | null => {
  const lod = selectWaveformLod({
    sampleRate: input.sampleRate,
    sourceStartSec: input.sourceStartSec,
    sourceEndSec: input.sourceEndSec,
    widthPx: input.drawCols,
  })
  if (!lod) return null
  return lod.mode === 'cached-peaks' ? 'cached-peaks' : 'pcm-envelope'
}

const validRange = (range: ArrangementWaveformTimelineRange) => (
  Number.isFinite(range.startSec)
  && Number.isFinite(range.endSec)
  && range.endSec > range.startSec
)

const visibleSegment = (
  segment: ArrangementWaveformVisibleSegment,
  range: ArrangementWaveformTimelineRange,
  clipStartSec: number,
  cssWidthPx: number,
  pixelsPerSecond: number,
): ArrangementWaveformVisibleSegment | null => {
  const timelineStartSec = Math.max(segment.timelineStartSec, range.startSec)
  const timelineEndSec = Math.min(segment.timelineEndSec, range.endSec)
  const timelineDurationSec = segment.timelineEndSec - segment.timelineStartSec
  const sourceDurationSec = segment.sourceEndSec - segment.sourceStartSec
  if (timelineEndSec <= timelineStartSec
    || !Number.isFinite(timelineDurationSec)
    || timelineDurationSec <= 0
    || !Number.isFinite(sourceDurationSec)
    || sourceDurationSec <= 0) return null

  const startFraction = (timelineStartSec - segment.timelineStartSec) / timelineDurationSec
  const endFraction = (timelineEndSec - segment.timelineStartSec) / timelineDurationSec
  const drawStartPx = Math.max(0, Math.floor((timelineStartSec - clipStartSec) * pixelsPerSecond))
  const drawEndPx = Math.min(
    cssWidthPx,
    Math.ceil((timelineEndSec - clipStartSec) * pixelsPerSecond),
  )
  if (drawEndPx <= drawStartPx) return null

  return {
    drawStartPx,
    drawCols: drawEndPx - drawStartPx,
    timelineStartSec,
    timelineEndSec,
    sourceStartSec: segment.sourceStartSec + sourceDurationSec * startFraction,
    sourceEndSec: segment.sourceStartSec + sourceDurationSec * endFraction,
  }
}

export const getArrangementWaveformVisibleSegments = (input: {
  clip: Clip<AudioBuffer>
  cssWidthPx: number
  pixelsPerSecond: number
  projectBpm: number
  visibleRange: ArrangementWaveformTimelineRange
  bufferDurationSec?: number
}): ArrangementWaveformVisibleSegment[] => {
  if (!validRange(input.visibleRange)
    || !Number.isFinite(input.cssWidthPx)
    || input.cssWidthPx <= 0
    || !Number.isFinite(input.pixelsPerSecond)
    || input.pixelsPerSecond <= 0
    || !Number.isFinite(input.clip.startSec)
    || !Number.isFinite(input.clip.duration)
    || input.clip.duration <= 0) return []

  const layoutWidthPx = input.clip.duration * input.pixelsPerSecond
  if (!Number.isFinite(layoutWidthPx) || layoutWidthPx <= 0) return []

  const layout = getAudioWaveformLayout(
    input.clip,
    layoutWidthPx,
    input.bufferDurationSec,
    input.projectBpm,
  )
  const segments = layout.segments ?? (layout.drawCols > 0
    ? [{
      drawStartPx: layout.padPx,
      drawCols: layout.drawCols,
      timelineStartSec: input.clip.startSec + layout.padPx / input.pixelsPerSecond,
      timelineEndSec: input.clip.startSec + (layout.padPx + layout.drawCols) / input.pixelsPerSecond,
      sourceStartSec: layout.sourceStartSec,
      sourceEndSec: layout.sourceEndSec,
    }]
    : [])

  return segments.flatMap((segment) => {
    const visible = visibleSegment(
      segment,
      input.visibleRange,
      input.clip.startSec,
      input.cssWidthPx,
      input.pixelsPerSecond,
    )
    return visible ? [visible] : []
  })
}
