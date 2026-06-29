import { describe, expect, test } from 'bun:test'
import { createDefaultDrumRackParams, createDefaultSynthParams } from '@daw-browser/shared'
import { readInstrumentParamsFromEffectRow } from './effect-row-instrument-params'

describe('effect row instrument params', () => {
  test('reads legacy Synth rows as active Synth instruments', () => {
    const params = { ...createDefaultSynthParams(), gain: 0.25 }

    expect(readInstrumentParamsFromEffectRow({
      effect: 'synth',
      params,
    })).toEqual({
      kind: 'synth',
      params,
    })
  })

  test('reads instrument rows for Drum Rack params', () => {
    const params = createDefaultDrumRackParams()

    expect(readInstrumentParamsFromEffectRow({
      effect: 'instrument',
      params: { kind: 'drum-rack', params },
    })).toEqual({ kind: 'drum-rack', params })
  })
})
