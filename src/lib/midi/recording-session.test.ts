import { describe, expect, test } from 'bun:test'
import { MAX_MIDI_PERFORMANCE_EVENTS } from '@daw-browser/shared'
import type { MidiInputEvent } from './midi-input'
import { createMidiRecordingSession } from './recording-session'

const noteOn = (pitch: number, timeStamp = 0): MidiInputEvent => ({
  sourceId: 'keyboard', timeStamp, channel: 1, kind: 'note-on', note: pitch, velocity: 0.5,
})
const noteOff = (pitch: number, timeStamp = 0): MidiInputEvent => ({
  sourceId: 'keyboard', timeStamp, channel: 1, kind: 'note-off', note: pitch, velocity: 0,
})

describe('createMidiRecordingSession', () => {
  test('pairs duplicate notes FIFO and preserves IDs between snapshots', () => {
    const session = createMidiRecordingSession(10, 'take')
    session.receive(noteOn(60), 10)
    session.receive(noteOn(60), 11)
    session.receive(noteOff(60), 12)
    session.receive(noteOff(60), 13)
    const first = session.snapshot(120, 14).midi
    const second = session.snapshot(120, 14).midi

    expect(first.notes).toEqual([
      { id: 'take:0', beat: 0, length: 4, pitch: 60, velocity: 0.5, channel: 1 },
      { id: 'take:1', beat: 2, length: 4, pitch: 60, velocity: 0.5, channel: 1 },
    ])
    expect(second.notes.map((note) => note.id)).toEqual(first.notes.map((note) => note.id))
  })

  test('holds notes through sustain and clears them on all sound off', () => {
    const session = createMidiRecordingSession(0, 'take')
    session.receive(noteOn(60), 0)
    session.receive({ sourceId: 'keyboard', timeStamp: 1, channel: 1, kind: 'control-change', controller: 64, value: 1 }, 1)
    session.receive(noteOff(60), 2)
    session.receive({ sourceId: 'keyboard', timeStamp: 3, channel: 1, kind: 'control-change', controller: 64, value: 0 }, 3)
    session.receive(noteOn(61), 4)
    session.receive({ sourceId: 'keyboard', timeStamp: 5, channel: 1, kind: 'control-change', controller: 120, value: 0 }, 5)

    const snapshot = session.snapshot(60, 6).midi
    expect(snapshot.notes.map((note) => note.length)).toEqual([3, 1])
    expect(snapshot.cc?.map((entry) => entry.controller)).toEqual([64, 64, 120])
  })

  test('records expression, source resets, and closes held notes', () => {
    const session = createMidiRecordingSession(0, 'take')
    session.receive(noteOn(64), 0)
    session.receive({ sourceId: 'keyboard', timeStamp: 1, channel: 1, kind: 'pitch-bend', value: -0.25 }, 1)
    session.receive({ sourceId: 'keyboard', timeStamp: 2, channel: 1, kind: 'channel-pressure', pressure: 0.5 }, 2)
    session.receive({ sourceId: 'keyboard', timeStamp: 3, channel: 1, kind: 'poly-pressure', note: 64, pressure: 0.75 }, 3)
    session.resetSource('keyboard', 4)
    const snapshot = session.snapshot(60, 5).midi

    expect(snapshot.notes[0]?.length).toBe(4)
    expect(snapshot.pitchBends?.[0]?.id).toBe('take:1')
    expect(snapshot.channelPressure?.[0]?.id).toBe('take:2')
    expect(snapshot.polyPressure?.[0]?.id).toBe('take:3')
  })

  test('settles without exceeding the performance event limit', () => {
    const session = createMidiRecordingSession(0, 'take')
    for (let index = 0; index < MAX_MIDI_PERFORMANCE_EVENTS; index += 1) {
      session.receive(noteOn(index % 128), index)
    }
    session.receive(noteOn(1), 501)
    const snapshot = session.snapshot(60, 501)

    expect(snapshot.eventCount).toBe(MAX_MIDI_PERFORMANCE_EVENTS)
    expect(snapshot.complete).toBe(true)
    expect(snapshot.midi.notes).toHaveLength(MAX_MIDI_PERFORMANCE_EVENTS)
    expect(snapshot.midi.notes.every((note) => note.length > 0)).toBe(true)
  })
})
