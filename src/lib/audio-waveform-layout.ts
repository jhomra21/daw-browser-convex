import { getPlayableAudioWindow } from '@daw-browser/audio-engine/audio-scheduling'
import type { Clip } from '@daw-browser/timeline-core/types'
import { PPS } from '~/lib/timeline-utils'

type AudioWaveformLayout = {
  sourceDurationSec: number
  padPx: number
  drawCols: number
  sourceStartSec: number
  sourceEndSec: number
}

export function getAudioWaveformLayout(
  clip: Clip<AudioBuffer>,
  cssW: number,
  bufferDurationSec?: number,
): AudioWaveformLayout {
  const sourceDurationSec = Math.max(
    bufferDurationSec ?? clip.sourceDurationSec ?? 0,
    0,
  )
  const window = getPlayableAudioWindow({
    clip,
    bufferDurationSec: sourceDurationSec,
    rangeStartSec: clip.startSec,
    rangeEndSec: clip.startSec + clip.duration,
  })
  if (!window) {
    return {
      sourceDurationSec,
      padPx: 0,
      drawCols: 0,
      sourceStartSec: 0,
      sourceEndSec: 0,
    }
  }

  const padPx = Math.max(0, Math.floor((window.startSec - clip.startSec) * PPS))
  const drawCols = Math.max(
    0,
    Math.min(cssW - padPx, Math.floor(window.durationSec * PPS)),
  )
  const sourceStartSec = window.offsetSec
  const sourceEndSec = Math.min(sourceDurationSec, sourceStartSec + drawCols / PPS)

  return {
    sourceDurationSec,
    padPx,
    drawCols,
    sourceStartSec,
    sourceEndSec,
  }
}
