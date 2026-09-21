import { getAudioClipTimeMap, getMarkerWarpTimelineSegments } from '@daw-browser/timeline-core/audio-clip-time-map'
import type { Clip } from '@daw-browser/timeline-core/types'
import { normalizeSourceBeatOffsetValue } from '@daw-browser/shared'
import type {
  WaveformByteIntervals,
  WaveformFloatIntervals,
  WaveformSourceData,
} from '@daw-browser/waveforms/types'

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

export type { AudioWaveformLayout, AudioWaveformLayoutSegment }

export type CroppedWaveformData = {
  data: WaveformSourceData
  sourceStartFrame: number
  sourceEndFrame: number
}

export type ProjectedWaveformData = CroppedWaveformData & {
  requestKey?: string
  startPx: number
  endPx: number
  canvasStartSec: number
  canvasEndSec: number
}

const roundSeconds = (value: number) => Math.round(value * 1_000_000_000) / 1_000_000_000
const SOURCE_BEAT_OFFSET_SNAP = 0.25

const normalizeSourceBeatOffsetForDrag = (value: number, snap: boolean) => {
  const snapped = snap ? Math.round(value / SOURCE_BEAT_OFFSET_SNAP) * SOURCE_BEAT_OFFSET_SNAP : value
  return normalizeSourceBeatOffsetValue(snapped)
}

const clampSource = (value: number, start: number, end: number) => (
  Math.max(start, Math.min(end, value))
)

export const cropWaveformDataToSourceRange = (input: {
  data: WaveformSourceData
  sourceStartSec: number
  sourceEndSec: number
}): CroppedWaveformData | null => {
  const dataStart = input.data.firstFrame / input.data.sampleRate
  const dataEnd = input.data.kind === 'samples'
    ? dataStart + (input.data.channels[0]?.length ?? 0) / input.data.sampleRate
    : dataStart + input.data.intervalCount * input.data.framesPerInterval / input.data.sampleRate
  const start = clampSource(Math.max(input.sourceStartSec, dataStart), dataStart, dataEnd)
  const end = clampSource(Math.min(input.sourceEndSec, dataEnd), dataStart, dataEnd)
  if (end <= start) return null

  if (input.data.kind === 'samples') {
    const firstFrame = Math.max(input.data.firstFrame, Math.ceil(start * input.data.sampleRate))
    const dataEndFrame = input.data.firstFrame + (input.data.channels[0]?.length ?? 0)
    const endFrame = Math.min(dataEndFrame, Math.ceil(end * input.data.sampleRate))
    if (endFrame <= firstFrame) return null
    const offset = firstFrame - input.data.firstFrame
    const channels = input.data.channels.map((channel) => (
      channel.subarray(offset, offset + endFrame - firstFrame)
    ))
    const cropped: WaveformSourceData = {
      kind: 'samples',
      channels,
      firstFrame,
      sampleRate: input.data.sampleRate,
      sourceFrameCount: input.data.sourceFrameCount,
    }
    return {
      data: cropped,
      sourceStartFrame: firstFrame,
      sourceEndFrame: endFrame,
    }
  }

  const framesPerInterval = input.data.framesPerInterval
  const exactStartFrame = Math.max(
    input.data.firstFrame,
    Math.min(input.data.sourceFrameCount, Math.ceil(start * input.data.sampleRate)),
  )
  const exactEndFrame = Math.max(
    exactStartFrame,
    Math.min(input.data.sourceFrameCount, Math.ceil(end * input.data.sampleRate)),
  )
  const startColumn = Math.max(
    0,
    Math.min(input.data.intervalCount - 1, Math.floor((start * input.data.sampleRate - input.data.firstFrame) / framesPerInterval)),
  )
  const endColumn = Math.min(
    input.data.intervalCount,
    Math.max(startColumn + 1, Math.ceil((end * input.data.sampleRate - input.data.firstFrame) / framesPerInterval)),
  )
  if (endColumn <= startColumn) return null
  const base: Pick<
    WaveformByteIntervals,
    'kind' | 'firstFrame' | 'sampleRate' | 'sourceFrameCount' | 'framesPerInterval' | 'intervalCount'
  > = {
    kind: 'intervals',
    firstFrame: input.data.firstFrame + startColumn * framesPerInterval,
    sampleRate: input.data.sampleRate,
    sourceFrameCount: input.data.sourceFrameCount,
    framesPerInterval,
    intervalCount: endColumn - startColumn,
  }
  const cropped: WaveformByteIntervals | WaveformFloatIntervals = input.data.encoding === 'signed-u8'
    ? {
      ...base,
      kind: 'intervals',
      encoding: 'signed-u8',
      channels: input.data.channels.map((channel) => channel.subarray(startColumn * 2, endColumn * 2)),
    }
    : {
      ...base,
      kind: 'intervals',
      encoding: 'float32',
      channels: input.data.channels.map((channel) => channel.subarray(startColumn * 2, endColumn * 2)),
    }
  return {
    data: cropped,
    sourceStartFrame: exactStartFrame,
    sourceEndFrame: exactEndFrame,
  }
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
