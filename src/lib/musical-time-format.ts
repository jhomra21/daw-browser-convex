import { secondsToBeats } from '~/lib/timeline-range-selection'

const BEATS_PER_BAR = 4
const SIXTEENTHS_PER_BEAT = 4
const SIXTEENTHS_PER_BAR = BEATS_PER_BAR * SIXTEENTHS_PER_BEAT
// Keeps an exact boundary (e.g. bar 5) from flooring one sixteenth early on float error.
const SIXTEENTH_EPSILON = 1e-9

// Same 4/4 assumption as the timeline grid and ruler. Non-finite time or non-positive bpm is treated as the project start.
const sixteenthsAtTime = (timeSec: number, bpm: number) => {
  const validInput = Number.isFinite(timeSec) && Number.isFinite(bpm) && bpm > 0
  const safeSec = validInput ? Math.max(0, timeSec) : 0
  return Math.floor(secondsToBeats(safeSec, bpm) * SIXTEENTHS_PER_BEAT + SIXTEENTH_EPSILON)
}

// Zero-based bar index. The ruler label and the playhead share this bar boundary.
export const barIndexAtTime = (timeSec: number, bpm: number) => (
  Math.floor(sixteenthsAtTime(timeSec, bpm) / SIXTEENTHS_PER_BAR)
)

const barsBeatsSixteenthsParts = (sixteenths: number) => ({
  bar: Math.floor(sixteenths / SIXTEENTHS_PER_BAR),
  beat: Math.floor(sixteenths / SIXTEENTHS_PER_BEAT) % BEATS_PER_BAR,
  sixteenth: sixteenths % SIXTEENTHS_PER_BEAT,
})

export const formatBarsBeatsSixteenths = (timeSec: number, bpm: number) => {
  const { bar, beat, sixteenth } = barsBeatsSixteenthsParts(sixteenthsAtTime(timeSec, bpm))
  return `${bar + 1}.${beat + 1}.${sixteenth + 1}`
}

// A length measured from a clip edge, so it is zero-based: 1 beat reads 0.1.0 and 0 reads 0.0.0.
export const formatBarsBeatsSixteenthsDuration = (durationSec: number, bpm: number) => {
  const { bar, beat, sixteenth } = barsBeatsSixteenthsParts(sixteenthsAtTime(durationSec, bpm))
  return `${bar}.${beat}.${sixteenth}`
}
