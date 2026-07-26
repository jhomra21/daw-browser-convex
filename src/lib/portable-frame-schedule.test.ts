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
