import {
  BEATS_PER_BAR,
  SIXTEENTHS_PER_BEAT,
  barsBeatsSixteenthsParts,
  sixteenthsAtTime,
  timeAtSixteenths,
} from '~/lib/musical-time-format'

export type PositionField = 'bar' | 'beat' | 'sixteenth'

export const positionFieldMax: Record<PositionField, number> = {
  bar: 9999,
  beat: BEATS_PER_BAR,
  sixteenth: SIXTEENTHS_PER_BEAT,
}

// 1-based, matching formatBarsBeatsSixteenths.
export const arrangementPositionFields = (timeSec: number, bpm: number): Record<PositionField, number> => {
  const { bar, beat, sixteenth } = barsBeatsSixteenthsParts(sixteenthsAtTime(timeSec, bpm))

  return { bar: bar + 1, beat: beat + 1, sixteenth: sixteenth + 1 }
}

// Replaces one field of the current position, clamped to its range; the other fields keep their value.
export const timeAfterFieldChange = (timeSec: number, bpm: number, field: PositionField, value: number) => {
  const current = arrangementPositionFields(timeSec, bpm)
  const clamped = Math.max(1, Math.min(positionFieldMax[field], Math.round(value)))
  const next = { ...current, [field]: clamped }

  const sixteenths = ((next.bar - 1) * BEATS_PER_BAR + next.beat - 1) * SIXTEENTHS_PER_BEAT + next.sixteenth - 1

  return timeAtSixteenths(sixteenths, bpm)
}

export const parsePositionDraft = (draft: string) => {
  const text = draft.trim()

  return /^\d+$/.test(text) ? Number(text) : null
}
