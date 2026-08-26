import { expect, test } from 'bun:test'
import {
  compileMidiMappingSourceIndex,
  midiMappingInputRatio,
  midiMappingOutputRatio,
  midiMappingValue,
} from './midi-mapping'
import type { MidiMapping } from './midi'

const mappings = [{
  id: 'cc',
  source: { kind: 'cc', controller: 1, channel: 2 },
  target: { parameterId: 'volume' },
  outputMin: 1,
  outputMax: 0,
}, {
  id: 'pressure',
  source: { kind: 'poly-pressure', pitch: 60 },
  target: { parameterId: 'volume' },
  outputMin: 0,
  outputMax: 1,
}] satisfies MidiMapping[]

test('indexes MIDI mappings by source without scanning unrelated mappings', () => {
  const index = compileMidiMappingSourceIndex(mappings)
  expect(index.match({ kind: 'cc', controller: 1, channel: 2, value: 0.5 }).map((mapping) => mapping.id)).toEqual(['cc'])
  expect(index.match({ kind: 'cc', controller: 1, channel: 1, value: 0.5 })).toEqual([])
  expect(index.match({ kind: 'poly-pressure', pitch: 60, channel: 9, value: 0.5 }).map((mapping) => mapping.id)).toEqual(['pressure'])
})

test('normalizes pitch bend and supports inverted output ranges', () => {
  expect(midiMappingInputRatio({ kind: 'pitch-bend', value: -1 })).toBe(0)
  expect(midiMappingInputRatio({ kind: 'pitch-bend', value: 1 })).toBe(1)
  expect(midiMappingOutputRatio(mappings[0], 0.25)).toBe(0.75)
  expect(midiMappingValue(mappings[0], { kind: 'cc', controller: 1, channel: 2, value: 0.5 })).toBeCloseTo(1)
})
