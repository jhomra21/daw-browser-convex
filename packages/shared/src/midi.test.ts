import { expect, test } from 'bun:test'
import {
  MAX_MIDI_PERFORMANCE_EVENTS,
  midiClipEquals,
  midiMappingCount,
  midiPerformanceEventCount,
  midiSerializedByteLength,
  normalizeLegacyMidiClip,
  normalizeMidiClip,
  sanitizeLegacyMidiClipForCreate,
  type MidiClip,
} from './midi'

test('normalizes legacy MIDI IDs deterministically, including duplicates', () => {
  const input = {
    wave: 'sine' as const,
    notes: [
      { beat: 0, length: 1, pitch: 60 },
      { beat: 0, length: 1, pitch: 60 },
    ],
  }
  const normalized = normalizeMidiClip(input)
  expect(normalized.notes.map((note) => note.id)).toEqual([
    'midi:note:[["beat",0],["channel",1],["length",1],["pitch",60]]:0',
    'midi:note:[["beat",0],["channel",1],["length",1],["pitch",60]]:1',
  ])
  expect(normalized.notes.every((note) => note.channel === 1)).toBe(true)
  expect(normalizeMidiClip(normalized)).toEqual(normalized)
})

test('canonicalizes legacy default channels and ID ordinals independently of explicit IDs', () => {
  const legacy = { beat: 0, length: 1, pitch: 60 }
  const withExplicitNeighbors = normalizeMidiClip({
    wave: 'sine',
    notes: [{ id: 'A', ...legacy }, legacy, { id: 'a', ...legacy }, legacy],
  })
  const reordered = normalizeMidiClip({
    wave: 'sine',
    notes: [{ id: 'a', ...legacy }, legacy, { id: 'A', ...legacy }, legacy],
  })
  expect(withExplicitNeighbors.notes.map((note) => note.id).filter((id) => id?.startsWith('midi:')))
    .toEqual(reordered.notes.map((note) => note.id).filter((id) => id?.startsWith('midi:')))
  expect(normalizeMidiClip({ wave: 'sine', notes: [legacy] }))
    .toEqual(normalizeMidiClip({ wave: 'sine', notes: [{ ...legacy, channel: 1 }] }))
  expect(normalizeMidiClip({
    wave: 'sine',
    notes: [{ id: 'a', ...legacy }, { id: 'A', ...legacy }],
  }).notes.map((note) => note.id)).toEqual(['A', 'a'])
})

test('reserves supplied MIDI IDs before deterministic legacy ID generation', () => {
  const legacy = { beat: 0, length: 1, pitch: 60 }
  const generated = 'midi:note:[["beat",0],["channel",1],["length",1],["pitch",60]]:0'
  const normalized = normalizeMidiClip({
    wave: 'sine',
    notes: [{ id: generated, ...legacy }, legacy, legacy],
  })
  expect(normalized.notes.map((note) => note.id)).toEqual([
    generated,
    `${generated}:1`,
    'midi:note:[["beat",0],["channel",1],["length",1],["pitch",60]]:1',
  ])
  const retained = normalizeMidiClip({
    wave: 'sine',
    notes: [{ id: `${generated}:1`, ...legacy }, legacy],
  })
  expect(retained.notes.map((note) => note.id)).toContain(generated)
  const crossEvent = normalizeMidiClip({
    wave: 'sine',
    notes: [legacy],
    cc: [{ id: generated, beat: 0, controller: 1, value: 0 }],
  })
  expect(crossEvent.notes[0]?.id).toBe(`${generated}:1`)
})

test('reads legacy rows above new write limits without accepting them as new writes', () => {
  const legacy = {
    wave: 'sine',
    notes: Array.from({ length: MAX_MIDI_PERFORMANCE_EVENTS }, (_, beat) => ({ beat, length: 1, pitch: 60 })),
    cc: [{ beat: 0, controller: 1, value: 0 }],
  } satisfies MidiClip
  expect(normalizeLegacyMidiClip(legacy)).toHaveProperty('cc')
  expect(midiClipEquals(legacy, legacy)).toBe(true)
  expect(() => normalizeMidiClip(legacy)).toThrow('performance events')
})

test('retains empty and arbitrary legacy waves with finite gains outside strict write bounds', () => {
  const emptyWave = { wave: '', gain: -1, notes: [] }
  const customWave = { wave: 'custom-legacy', gain: 7, notes: [] }
  expect(normalizeLegacyMidiClip(emptyWave)).toMatchObject(emptyWave)
  expect(normalizeLegacyMidiClip(customWave)).toMatchObject(customWave)
  expect(() => normalizeMidiClip(emptyWave)).toThrow()
  expect(() => normalizeMidiClip(customWave)).toThrow()
})

test('sanitizes historical MIDI for a strict new clip without repairing the source', () => {
  const legacy = {
    wave: 'custom-legacy',
    gain: 7,
    notes: [
      { beat: 0, length: 1, pitch: 60 },
      { beat: 1, length: -1, pitch: 200 },
      ...Array.from({ length: 600 }, (_, beat) => ({ beat: beat + 2, length: 1, pitch: 60 })),
    ],
  }
  const sanitized = sanitizeLegacyMidiClipForCreate(legacy)
  expect(sanitized.wave).toBe('sine')
  expect(sanitized.notes[0]?.pitch).toBe(60)
  expect(sanitized.gain).toBeUndefined()
  expect(sanitized.notes).toHaveLength(MAX_MIDI_PERFORMANCE_EVENTS)
  expect(normalizeLegacyMidiClip(legacy)).toMatchObject({ wave: 'custom-legacy', gain: 7 })
})

test('preserves and sorts expanded MIDI data', () => {
  const midi = normalizeMidiClip({
    wave: 'square',
    inputChannel: 2,
    notes: [{ id: 'note-2', beat: 2, length: 1, pitch: 60, channel: 2 }],
    cc: [{ id: 'cc-2', beat: 2, controller: 1, value: 0.5, channel: 2 }, { id: 'cc-1', beat: 1, controller: 1, value: 0.25, channel: 2 }],
    pitchBends: [{ id: 'bend', beat: 0, value: -0.5, channel: 2 }],
    channelPressure: [{ id: 'pressure', beat: 0, value: 0.5, channel: 2 }],
    polyPressure: [{ id: 'poly', beat: 0, pitch: 60, value: 0.5, channel: 2 }],
    mappings: [{
      id: 'mapping',
      source: { kind: 'cc', controller: 1, channel: 2 },
      target: { parameterId: 'volume' },
      outputMin: 0,
      outputMax: 1,
    }],
  })
  expect(midi.cc.map((event) => event.id)).toEqual(['cc-1', 'cc-2'])
  expect(midiPerformanceEventCount(midi)).toBe(6)
  expect(midiMappingCount(midi)).toBe(1)
  expect(midiSerializedByteLength(midi)).toBeGreaterThan(0)
  expect(midiClipEquals(midi, normalizeMidiClip(midi))).toBe(true)
  expect(midi.mappings[0]?.source).toEqual({ kind: 'cc', controller: 1, channel: 2 })
})

test('keeps omitted clip and mapping source channels as omni and any-channel', () => {
  const midi = normalizeMidiClip({
    wave: 'sine',
    notes: [],
    mappings: [{
      id: 'mapping',
      source: { kind: 'cc', controller: 1 },
      target: { parameterId: 'opaque-parameter' },
      outputMin: 0,
      outputMax: 1,
    }],
  })
  expect(midi.inputChannel).toBeUndefined()
  expect(midi.mappings[0]?.source).toEqual({ kind: 'cc', controller: 1 })
})

test('rejects duplicate supplied IDs and performance event overflow', () => {
  expect(() => normalizeMidiClip({
    wave: 'sine',
    notes: [
      { id: 'duplicate', beat: 0, length: 1, pitch: 60 },
      { id: 'duplicate', beat: 1, length: 1, pitch: 61 },
    ],
  })).toThrow('IDs must be unique')
  expect(() => normalizeMidiClip({
    wave: 'sine',
    notes: Array.from({ length: MAX_MIDI_PERFORMANCE_EVENTS }, (_, pitch) => ({
      id: `note-${pitch}`, beat: pitch, length: 1, pitch: pitch % 128,
    })),
    cc: [{ id: 'over', beat: 0, controller: 1, value: 0 }],
  })).toThrow('performance events')
})
