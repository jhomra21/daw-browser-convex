import { getAudioClipTimeMap } from '@daw-browser/audio-engine/audio-scheduling'
import type { Clip } from '@daw-browser/timeline-core/types'
import { PPS } from '~/lib/timeline-utils'

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

  const padPx = Math.max(0, Math.floor((map.timelineStartSec - clip.startSec) * PPS))
  const drawCols = Math.max(
    0,
    Math.min(cssW - padPx, Math.floor(map.timelineDurationSec * PPS)),
  )
  const sourceStartSec = roundSeconds(map.sourceStartSec)
  const sourceEndSec = Math.min(
    sourceDurationSec,
    roundSeconds(map.timelineToSourceSec(map.timelineStartSec + drawCols / PPS)),
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
