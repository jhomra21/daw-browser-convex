import { expect, test } from 'bun:test'
import {
  getVisibleMidiBarIndices,
  getVisibleMidiNoteProjection,
} from '~/lib/timeline-midi-rendering'

test('bounds MIDI bar indices to the visible slice at extreme zoom', () => {
  expect(getVisibleMidiBarIndices({
    clipDurationSec: 10_000,
    windowStartSec: 5_000.001,
    windowEndSec: 5_000.002,
    barDurationSec: 2,
  })).toBeNull()
  expect(getVisibleMidiBarIndices({
    clipDurationSec: 10_000,
    windowStartSec: 4_998,
    windowEndSec: 5_002,
    barDurationSec: 2,
  })).toEqual({ firstBar: 2499, lastBar: 2501 })
})

test('culls MIDI notes wholly outside a deep slice before projection', () => {
  expect(getVisibleMidiNoteProjection({
    noteBeat: 0,
    noteLength: 1,
    midiOffsetBeats: 0,
    secondsPerBeat: 0.5,
    windowStartSec: 5_000,
    windowEndSec: 5_000.001,
  })).toBeNull()
  expect(getVisibleMidiNoteProjection({
    noteBeat: 10_002,
    noteLength: 1,
    midiOffsetBeats: 0,
    secondsPerBeat: 0.5,
    windowStartSec: 5_000,
    windowEndSec: 5_000.001,
  })).toBeNull()
})
