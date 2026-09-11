import { expect, test } from 'bun:test'
import { getAutomationEnvelopeSchedulePlan } from '@daw-browser/audio-engine/automation'
import { getScheduledMidiEvents } from '@daw-browser/audio-engine/audio-scheduling'
import { eventsForPortableFrameBlock, isPortableFrameScheduleCurrent, portableFrameAtTimelineTime } from '@daw-browser/audio-engine/portable-frame-scheduling'
import { resolveTrackMidiExpressionSchedule } from '@daw-browser/audio-engine/midi-expression-scheduling'
import type { AutomationEnvelope } from '@daw-browser/shared'
import type { RuntimeTrack } from '~/lib/timeline-runtime-types'
import { compilePortableFrameSchedule } from '~/lib/portable-frame-schedule'

const automation: AutomationEnvelope = {
  id: 'automation-a',
  projectId: 'project-a',
  target: { kind: 'track', trackId: 'track-a' },
  targetKey: 'automation-a',
  parameterId: 'volume',
  enabled: true,
  points: [
    { id: 'start', timeSec: 0, value: 0.5, interpolation: 'linear' },
    { id: 'end', timeSec: 2, value: 1, interpolation: 'linear' },
  ],
  updatedAt: 1,
}

const track: RuntimeTrack = {
  id: 'track-a',
  name: 'Instrument',
  volume: 0.8,
  clips: [{
    id: 'clip-a',
    name: 'MIDI',
    color: '#fff',
    startSec: 0,
    duration: 2,
    midiOffsetBeats: 0,
    midi: {
      wave: 'sine',
      notes: [{ id: 'note-a', beat: 0, length: 1, pitch: 60, velocity: 0.7 }],
      cc: [{ id: 'cc-a', beat: 1, controller: 1, value: 0.5 }],
      mappings: [{
        id: 'mapping-a',
        source: { kind: 'cc', controller: 1 },
        target: { parameterId: 'volume' },
        outputMin: 0,
        outputMax: 1,
      }],
    },
  }],
}

const input = {
  revision: 7,
  transportEpoch: 3,
  sampleRateHz: 48_000,
  bpm: 60,
  timeOrigin: { timelineSec: 0, frame: 0 },
  rangeEndSec: 2,
  tracks: [track],
  automationEnvelopes: [automation],
  arpeggiators: new Map(),
}

test('projects timeline, expression, and automation authorities into stable frame events', () => {
  const schedule = compilePortableFrameSchedule(input)
  const frameAt = (timeSec: number) => portableFrameAtTimelineTime(schedule, timeSec)
  const clip = track.clips[0]
  if (!clip) throw new Error('Expected fixture clip.')
  const expectedNotes = getScheduledMidiEvents({
    clip,
    bpm: input.bpm,
    notes: clip.midi?.notes ?? [],
    rangeStartSec: 0,
    rangeEndSec: 2,
  })
  const expectedExpression = resolveTrackMidiExpressionSchedule({
    clips: track.clips,
    trackId: track.id,
    trackVolume: track.volume,
    automationEnvelopes: [automation],
    bpm: input.bpm,
    rangeStartSec: 0,
    rangeEndSec: 2,
  })
  const expectedAutomation = getAutomationEnvelopeSchedulePlan(automation, {
    playheadSec: 0,
    startLimitSec: 0,
    endLimitSec: 2,
  }, 1)

  expect(schedule.events.filter((event) => event.type === 'note-on' || event.type === 'note-off')).toEqual([
    { frame: frameAt(expectedNotes[0]?.startSec ?? 0), sequence: 3, type: 'note-on', target: { kind: 'instrument', trackId: 'track-a' }, noteId: 1, pitch: 60, velocity: 0.7 },
    { frame: frameAt(expectedNotes[0]?.endSec ?? 0), sequence: 5, type: 'note-off', target: { kind: 'instrument', trackId: 'track-a' }, noteId: 1, pitch: 60 },
  ])
  expect(schedule.events.filter((event) => event.type.startsWith('parameter'))).toEqual([
    {
      frame: frameAt(expectedAutomation[0]?.timeSec ?? 0),
      sequence: 1,
      type: 'parameter-set',
      target: { kind: 'parameter', scope: 'track', trackId: 'track-a', parameterId: 'mixer.gain' },
      value: expectedAutomation[0]?.value,
    },
    {
      endFrame: frameAt(expectedAutomation[1]?.timeSec ?? 0),
      endValue: expectedAutomation[1]?.value,
      frame: frameAt(expectedAutomation[0]?.timeSec ?? 0),
      interpolation: 'linear',
      sequence: 2,
      startFrame: frameAt(expectedAutomation[0]?.timeSec ?? 0),
      startValue: expectedAutomation[0]?.value,
      target: { kind: 'parameter', scope: 'track', trackId: 'track-a', parameterId: 'mixer.gain' },
      type: 'parameter-ramp',
    },
    {
      frame: frameAt(expectedExpression[0]?.timeSec ?? 0),
      sequence: 4,
      type: 'parameter-set',
      target: { kind: 'parameter', scope: 'track', trackId: 'track-a', parameterId: 'mixer.gain' },
      value: expectedExpression[0]?.value,
    },
    {
      frame: frameAt(expectedExpression[1]?.timeSec ?? 0),
      sequence: 6,
      type: 'parameter-restore',
      target: { kind: 'parameter', scope: 'track', trackId: 'track-a', parameterId: 'mixer.gain' },
      value: expectedExpression[1]?.value,
    },
  ])
})

test('keeps same-frame caller order, excludes a block end boundary, and invalidates after a seek epoch', () => {
  const schedule = compilePortableFrameSchedule(input)
  const block = eventsForPortableFrameBlock(schedule, 0, 48_000)

  expect(block.events.map((event) => [event.frameOffset, event.sequence])).toEqual([
    [0, 1],
    [0, 2],
    [0, 3],
  ])
  expect(block.events.some((event) => event.frameOffset === 48_000)).toBe(false)
  expect(isPortableFrameScheduleCurrent(schedule, { revision: 7, transportEpoch: 3 })).toBe(true)
  expect(isPortableFrameScheduleCurrent(schedule, { revision: 7, transportEpoch: 4 })).toBe(false)
})

test('keeps a spanning note identity stable across logical loop windows', () => {
  const spanningTrack: RuntimeTrack = {
    ...track,
    clips: [{
      ...track.clips[0]!,
      duration: 8,
      midi: {
        ...track.clips[0]!.midi!,
        notes: [{ id: 'long-note', beat: 0, length: 8, pitch: 60, velocity: 0.7 }],
      },
    }],
  }
  const first = compilePortableFrameSchedule({
    ...input,
    tracks: [spanningTrack],
    rangeEndSec: 2,
    stableNoteIds: true,
    clipSpanningNoteOn: true,
  })
  const second = compilePortableFrameSchedule({
    ...input,
    timeOrigin: { timelineSec: 2, frame: 96_000 },
    tracks: [spanningTrack],
    rangeEndSec: 4,
    stableNoteIds: true,
    clipSpanningNoteOn: true,
  })
  const firstNote = first.events.find((event) => event.type === 'note-on')
  const secondNote = second.events.find((event) => event.type === 'note-on')
  expect(firstNote?.noteId).toBe(secondNote?.noteId)
  expect(secondNote?.frame).toBe(96_000)
})

test('emits release and retrigger events instead of collapsing adjacent notes', () => {
  const adjacentTrack: RuntimeTrack = {
    ...track,
    clips: [{
      ...track.clips[0]!,
      midi: {
        ...track.clips[0]!.midi!,
        notes: [
          { id: 'first', beat: 0, length: 1, pitch: 60, velocity: 0.5 },
          { id: 'second', beat: 1, length: 1, pitch: 60, velocity: 0.8 },
        ],
      },
    }],
  }
  const events = compilePortableFrameSchedule({
    ...input,
    tracks: [adjacentTrack],
    automationEnvelopes: [],
  }).events.filter((event) => event.type === 'note-on' || event.type === 'note-off')
  expect(events.map((event) => event.type)).toEqual(['note-on', 'note-off', 'note-on', 'note-off'])
  expect(events.map((event) => event.noteId)).toEqual([1, 1, 2, 2])
})

test('releases active voices at a loop boundary before retriggering the next iteration', () => {
  const longTrack: RuntimeTrack = {
    ...track,
    clips: [{
      ...track.clips[0]!,
      midi: {
        ...track.clips[0]!.midi!,
        notes: [{ id: 'boundary-note', beat: 0, length: 2, pitch: 60, velocity: 0.7 }],
      },
    }],
  }
  const events = compilePortableFrameSchedule({
    ...input,
    tracks: [longTrack],
    automationEnvelopes: [],
    rangeEndSec: 2,
    loop: { loopEnabled: true, loopStartSec: 0, loopEndSec: 1 },
  }).events.filter((event) => event.type === 'note-on' || event.type === 'note-off')
  expect(events.map((event) => [event.frame, event.type])).toEqual([
    [0, 'note-on'],
    [48_000, 'note-off'],
    [48_000, 'note-on'],
    [96_000, 'note-off'],
  ])
  expect(events[1]?.noteId).not.toBe(events[2]?.noteId)
})
