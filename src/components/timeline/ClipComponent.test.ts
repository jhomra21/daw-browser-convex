import { expect, test } from 'bun:test'
import { getVisibleMidiBarIndices } from '~/lib/timeline-midi-rendering'

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
