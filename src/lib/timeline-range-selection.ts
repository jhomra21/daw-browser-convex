import type { Clip, Track } from '@daw-browser/timeline-core/types'
import { quantizeSecToGrid } from '~/lib/timeline-utils'

export type TimelineTimeRange = {
  startSec: number
  endSec: number
}

export type TimelineRangeSelection = TimelineTimeRange & {
  trackIds: Track['id'][]
  primaryTrackId: Track['id'] | null
}

export type ClipRangeOverlap = {
  startSec: number
  endSec: number
  offsetSec: number
  durationSec: number
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

const beatsToSeconds = (beats: number, bpm: number) => (
  beats * 60 / Math.max(1e-6, bpm)
)

export const secondsToBeats = (seconds: number, bpm: number) => (
  seconds * Math.max(1e-6, bpm) / 60
)

const barDurationSec = (bpm: number) => beatsToSeconds(4, bpm)

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

export const clipRangeOverlap = (
  clip: Pick<Clip, 'startSec' | 'duration'>,
  range: TimelineRangeSelection | null,
): ClipRangeOverlap | null => {
  if (!range) return null
  const clipEndSec = clip.startSec + clip.duration
  const startSec = Math.max(clip.startSec, range.startSec)
  const endSec = Math.min(clipEndSec, range.endSec)
  if (endSec - startSec <= 1e-6) return null
  return {
    startSec,
    endSec,
    offsetSec: startSec - clip.startSec,
    durationSec: endSec - startSec,
  }
}

export const extendTimelineRangeSelectionToPoint = (
  range: TimelineRangeSelection,
  input: { timeSec: number; trackIds?: readonly Track['id'][]; primaryTrackId?: Track['id'] | null },
): TimelineRangeSelection | null => {
  const midpointSec = (range.startSec + range.endSec) / 2
  const nextRange = input.timeSec <= midpointSec
    ? { startSec: input.timeSec, endSec: range.endSec }
    : { startSec: range.startSec, endSec: input.timeSec }
  return normalizeTimelineRangeSelection({
    startSec: nextRange.startSec,
    endSec: nextRange.endSec,
    trackIds: [...(input.trackIds ?? range.trackIds)],
    primaryTrackId: input.primaryTrackId ?? range.primaryTrackId,
  })
}
