import { expect, test } from 'bun:test'
import { compileTrackMidiExpressionSchedule } from './midi-expression-scheduling'
import type { Clip } from '@daw-browser/timeline-core/types'

const clip = {
  id: 'clip-a',
  startSec: 0,
  duration: 4,
  midiOffsetBeats: 0,
  midi: {
    wave: 'sine',
    notes: [],
    cc: [{ id: 'event-a', beat: 1, controller: 1, value: 0.5 }],
    mappings: [{
      id: 'mapping-a',
      source: { kind: 'cc', controller: 1 },
      target: { parameterId: 'volume' },
      outputMin: 0,
      outputMax: 1,
    }],
  },
} satisfies Pick<Clip, 'id' | 'startSec' | 'duration' | 'midiOffsetBeats' | 'midi'>

test('schedules expression values and restores at the clip boundary', () => {
  const events = compileTrackMidiExpressionSchedule({
    clips: [clip],
    bpm: 60,
    rangeStartSec: 0,
    rangeEndSec: 5,
  })
  expect(events[0]?.timeSec).toBe(1)
  expect(events[0]?.phase).toBe('set')
  expect(events[0]?.value).toBe(0.75)
  expect(events[1]?.timeSec).toBe(4)
  expect(events[1]?.phase).toBe('restore')
})

test('seeds mapped expression on a mid-clip seek', () => {
  const event = compileTrackMidiExpressionSchedule({
    clips: [clip],
    bpm: 60,
    rangeStartSec: 2,
    rangeEndSec: 5,
  })[0]
  expect(event?.timeSec).toBe(2)
  expect(event?.phase).toBe('set')
  expect(event?.value).toBe(0.75)
})

test('applies a clip-start expression during a zero-length seek', () => {
  const events = compileTrackMidiExpressionSchedule({
    clips: [{
      ...clip,
      midi: {
        ...clip.midi,
        cc: [{ id: 'event-at-start', beat: 0, controller: 1, value: 0.5 }],
      },
    }],
    bpm: 60,
    rangeStartSec: 0,
    rangeEndSec: 0,
  })
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ timeSec: 0, phase: 'set', value: 0.75 })
})

test('seeds a trimmed clip from the latest pre-trim state without replaying older events', () => {
  const events = compileTrackMidiExpressionSchedule({
    clips: [{
      ...clip,
      midiOffsetBeats: 2,
      midi: {
        ...clip.midi,
        cc: [
          { id: 'before-first', beat: 0.5, controller: 1, value: 0.1 },
          { id: 'before-latest', beat: 1.5, controller: 1, value: 0.8 },
          { id: 'visible', beat: 3, controller: 1, value: 0.4 },
        ],
      },
    }],
    bpm: 60,
    rangeStartSec: 0,
    rangeEndSec: 4,
  })

  expect(events).toHaveLength(3)
  expect(events[0]).toMatchObject({ timeSec: 0, phase: 'set', eventId: 'seed:before-latest' })
  expect(events[0]?.value).toBeCloseTo(1.2)
  expect(events[1]).toMatchObject({ timeSec: 1, phase: 'set', eventId: 'visible' })
  expect(events[1]?.value).toBeCloseTo(0.6)
  expect(events[2]).toMatchObject({ timeSec: 4, phase: 'restore' })
})

test('uses the latest pre-trim event per target when mappings sort differently', () => {
  const events = compileTrackMidiExpressionSchedule({
    clips: [{
      ...clip,
      midiOffsetBeats: 3,
      midi: {
        ...clip.midi,
        cc: [
          { id: 'early-z-mapping', beat: 1, controller: 2, value: 0.1 },
          { id: 'late-a-mapping', beat: 2, controller: 1, value: 0.8 },
        ],
        mappings: [
          {
            id: 'mapping-a',
            source: { kind: 'cc', controller: 1 },
            target: { parameterId: 'volume' },
            outputMin: 0,
            outputMax: 1,
          },
          {
            id: 'mapping-z',
            source: { kind: 'cc', controller: 2 },
            target: { parameterId: 'volume' },
            outputMin: 0,
            outputMax: 1,
          },
        ],
      },
    }],
    bpm: 60,
    rangeStartSec: 0,
    rangeEndSec: 4,
  })

  expect(events).toHaveLength(2)
  expect(events[0]).toMatchObject({
    timeSec: 0,
    phase: 'set',
    mappingId: 'mapping-a',
    eventId: 'seed:late-a-mapping',
  })
  expect(events[0]?.value).toBeCloseTo(1.2)
  expect(events[1]).toMatchObject({ timeSec: 4, phase: 'restore' })
})

test('applies an exact trim-boundary event after its pre-trim seed despite lexical IDs', () => {
  const events = compileTrackMidiExpressionSchedule({
    clips: [{
      ...clip,
      midiOffsetBeats: 2,
      midi: {
        ...clip.midi,
        cc: [
          { id: 'z-pre-trim', beat: 1, controller: 1, value: 0.1 },
          { id: 'a-boundary', beat: 2, controller: 1, value: 0.8 },
        ],
      },
    }],
    bpm: 60,
    rangeStartSec: 0,
    rangeEndSec: 4,
  })

  expect(events[0]).toMatchObject({ timeSec: 0, eventId: 'seed:a-boundary' })
  expect(events[0]?.value).toBeCloseTo(1.2)
})

test('applies a real boundary event after a pre-trim seed from another clip', () => {
  const events = compileTrackMidiExpressionSchedule({
    clips: [
      {
        ...clip,
        id: 'z-trimmed',
        midiOffsetBeats: 4,
        midi: {
          ...clip.midi,
          cc: [{ id: 'late-source-seed', beat: 3, controller: 1, value: 0.1 }],
        },
      },
      {
        ...clip,
        id: 'a-boundary',
        midi: {
          ...clip.midi,
          cc: [{ id: 'real-boundary', beat: 0, controller: 1, value: 0.8 }],
        },
      },
    ],
    bpm: 60,
    rangeStartSec: 0,
    rangeEndSec: 4,
  })

  expect(events[0]).toMatchObject({ timeSec: 0, eventId: 'seed:real-boundary' })
  expect(events[0]?.value).toBeCloseTo(1.2)
})
