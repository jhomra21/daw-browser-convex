import { expect, test } from 'bun:test'
import { INSTRUMENT_CONTRACTS, INSTRUMENT_KINDS, isInstrumentKind } from './instrument-params'

test('the instrument kinds keep their device order and match the contract table', () => {
  expect([...INSTRUMENT_KINDS]).toEqual(['synth', 'drum-rack', 'sampler', 'granular'])
  expect(Object.keys(INSTRUMENT_CONTRACTS)).toEqual([...INSTRUMENT_KINDS])
})

test('instrument kinds are accepted only as exact names', () => {
  expect(INSTRUMENT_KINDS.every(isInstrumentKind)).toBe(true)
  expect(isInstrumentKind('Synth')).toBe(false)
  expect(isInstrumentKind('instrument')).toBe(false)
  expect(isInstrumentKind(null)).toBe(false)
})
