import { expect, test } from 'bun:test'
import {
  assertPortableFrameSchedule,
  eventsForPortableFrameBlock,
  isPortableFrameSchedule,
} from './portable-frame-scheduling'

const schedule = {
  revision: 1,
  transportEpoch: 1,
  sampleRateHz: 48_000,
  bpm: 120,
  timeOrigin: { timelineSec: 0, frame: 0 },
  events: [
    {
      frame: 127,
      sequence: 1,
      type: 'note-on' as const,
      target: { kind: 'instrument' as const, trackId: 'track-a' },
      noteId: 1,
      pitch: 60,
      velocity: 1,
    },
    {
      frame: 128,
      sequence: 2,
      type: 'note-off' as const,
      target: { kind: 'instrument' as const, trackId: 'track-a' },
      noteId: 1,
      pitch: 60,
    },
  ],
}

test('enforces monotonic frame order and half-open block boundaries', () => {
  expect(isPortableFrameSchedule(schedule)).toBe(true)
  expect(eventsForPortableFrameBlock(schedule, 0, 128).events).toEqual([{
    ...schedule.events[0],
    frameOffset: 127,
  }])
  expect(() => assertPortableFrameSchedule({
    ...schedule,
    events: [{ ...schedule.events[1], sequence: 1 }, schedule.events[0]],
  })).toThrow('ordering')
})
