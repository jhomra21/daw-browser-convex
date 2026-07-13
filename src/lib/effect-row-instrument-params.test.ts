import { describe, expect, test } from 'bun:test'
import { createDefaultDrumRackParams, createDefaultSynthParams } from '@daw-browser/shared'
import { readInstrumentParamsFromEffectRow } from './effect-row-instrument-params'

describe('effect row instrument params', () => {
  test('reads Synth rows with durable instrument identity', () => {
    const params = { ...createDefaultSynthParams(), gain: 0.25 }

    expect(readInstrumentParamsFromEffectRow({
      effect: 'synth',
      instanceId: 'instrument:synth:1',
      params,
    })).toMatchObject({
      kind: 'synth',
      params,
      instanceId: 'instrument:synth:1',
    })
  })

  test('reads instrument rows for Drum Rack params', () => {
    const params = createDefaultDrumRackParams()

    expect(readInstrumentParamsFromEffectRow({
      effect: 'instrument',
      params: { kind: 'drum-rack', instanceId: 'instrument:drum-rack:1', params },
    })).toMatchObject({ kind: 'drum-rack', params, instanceId: 'instrument:drum-rack:1' })
  })
})
