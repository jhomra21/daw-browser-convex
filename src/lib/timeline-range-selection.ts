import type { Track } from '@daw-browser/timeline-core/types'
import { quantizeSecToGrid } from '~/lib/timeline-utils'

export type TimelineTimeRange = {
  startSec: number
  endSec: number
}

export type TimelineRangeSelection = TimelineTimeRange & {
  trackIds: Track['id'][]
  primaryTrackId: Track['id'] | null
}

export const normalizeTimelineRangeSelection = (
  input: TimelineRangeSelection,
): TimelineRangeSelection | null => {
  const startSec = Math.min(input.startSec, input.endSec)
  const endSec = Math.max(input.startSec, input.endSec)
  if (endSec - startSec <= 1e-6) return null
  if (input.trackIds.length === 0) return null

  return {
    startSec,
    endSec,
    trackIds: input.trackIds,
    primaryTrackId: input.primaryTrackId,
  }
}

export const isTimelineRangeSelectionEqual = (
  left: TimelineRangeSelection | null,
  right: TimelineRangeSelection | null,
) => {
  if (left === right) return true
  if (!left || !right) return false
  if (
    left.startSec !== right.startSec
    || left.endSec !== right.endSec
    || left.primaryTrackId !== right.primaryTrackId
    || left.trackIds.length !== right.trackIds.length
  ) return false
  return left.trackIds.every((trackId, index) => trackId === right.trackIds[index])
}

export const beatsToSeconds = (beats: number, bpm: number) => (
  beats * 60 / Math.max(1e-6, bpm)
)

export const secondsToBeats = (seconds: number, bpm: number) => (
  seconds * Math.max(1e-6, bpm) / 60
)

export const barDurationSec = (bpm: number) => beatsToSeconds(4, bpm)

export const floorSecToBar = (timeSec: number, bpm: number) => {
  const bar = barDurationSec(bpm)
  return Math.floor(timeSec / bar) * bar
}

export const ceilSecToBar = (timeSec: number, bpm: number) => {
  const bar = barDurationSec(bpm)
  return Math.ceil(timeSec / bar) * bar
}

export const snapTimeRangeToGridColumns = (
  range: TimelineTimeRange,
  bpm: number,
  gridDenominator: number,
): TimelineTimeRange | null => {
  const startSec = Math.min(range.startSec, range.endSec)
  const endSec = Math.max(range.startSec, range.endSec)
  const snappedStartSec = quantizeSecToGrid(startSec, bpm, gridDenominator, 'floor')
  const snappedEndSec = quantizeSecToGrid(endSec, bpm, gridDenominator, 'ceil')
  if (snappedEndSec - snappedStartSec <= 1e-6) return null
  return { startSec: snappedStartSec, endSec: snappedEndSec }
}
