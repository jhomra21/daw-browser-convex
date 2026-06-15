import { getAudioClipTimeMap } from '@daw-browser/audio-engine/audio-scheduling'
import type { Clip } from '@daw-browser/timeline-core/types'

type AudioWaveformLayout = {
  sourceDurationSec: number
  padPx: number
  drawCols: number
  audioStartPx: number
  audioEndPx: number
  sourceStartSec: number
  sourceEndSec: number
}

const roundSeconds = (value: number) => Math.round(value * 1_000_000_000) / 1_000_000_000
const SOURCE_BEAT_OFFSET_MIN = -16
const SOURCE_BEAT_OFFSET_MAX = 16
const SOURCE_BEAT_OFFSET_SNAP = 0.25
const SOURCE_BEAT_OFFSET_PRECISION = 1_000

const normalizeSourceBeatOffsetForDrag = (value: number, snap: boolean) => {
  const snapped = snap ? Math.round(value / SOURCE_BEAT_OFFSET_SNAP) * SOURCE_BEAT_OFFSET_SNAP : value
  return Math.round(
    Math.min(SOURCE_BEAT_OFFSET_MAX, Math.max(SOURCE_BEAT_OFFSET_MIN, snapped)) * SOURCE_BEAT_OFFSET_PRECISION,
  ) / SOURCE_BEAT_OFFSET_PRECISION
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

  const pixelsPerSecond = cssW / Math.max(1e-6, clip.duration)
  const padPx = Math.max(0, Math.floor((map.timelineStartSec - clip.startSec) * pixelsPerSecond))
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

  return {
    sourceDurationSec,
    padPx,
    drawCols,
    audioStartPx,
    audioEndPx,
    sourceStartSec,
    sourceEndSec,
  }
}
