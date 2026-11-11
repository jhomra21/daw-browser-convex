import { describe, expect, test } from 'bun:test'
import { createDefaultDrumRackParams, createDefaultSynthParams, createDefaultSamplerParams, normalizeTrackInstrumentParams } from '@daw-browser/shared'
import type { DrumRackPadSample } from '@daw-browser/shared'
import { readInstrumentParamsFromEffectRow } from './effect-row-instrument-params'

describe('effect row instrument params', () => {
  test('reads normalized sampled instruments with absent optional fields after structured-clone persistence', () => {
    const sample = { assetKey: 'sample', url: 'local-asset:sample', sourceKind: 'upload', source: { durationSec: 8, sampleRate: 48000, channelCount: 2 } }
    const sampler = normalizeTrackInstrumentParams({
      kind: 'sampler', instanceId: 'instrument:sampler:1',
      params: { ...createDefaultSamplerParams(), zones: [{ id: 'zone', sample }] },
    })
    const rack = normalizeTrackInstrumentParams({
      kind: 'drum-rack', instanceId: 'instrument:rack:1',
      params: { ...createDefaultDrumRackParams(), pads: [{ sample }] },
    })
    for (const instrument of [sampler, rack]) {
      expect(instrument).toBeDefined()
      expect(readInstrumentParamsFromEffectRow({
        effect: 'instrument', params: structuredClone(instrument),
      })).toEqual(instrument)
    }
  })

  test('retains Sampler instruments with empty asset keys and sparse zones or pads', () => {
    const sample = { assetKey: '', url: 'local-asset:empty', sourceKind: 'upload', source: { durationSec: 8, sampleRate: 48000, channelCount: 2 } }
    const validPadSample: DrumRackPadSample = { ...sample, assetKey: 'sample:valid-pad', sourceKind: 'upload' }
    const samplerParams = createDefaultSamplerParams()
    const sparseZones = Array(2)
    sparseZones[1] = { id: 'valid-zone', sample }
    const drumRackParams = createDefaultDrumRackParams()
    const sparsePads = Array(2)
    sparsePads[1] = { sample: validPadSample }

    expect(readInstrumentParamsFromEffectRow({
      effect: 'instrument',
      params: { kind: 'sampler', instanceId: 'instrument:empty-key', params: { ...samplerParams, zones: [{ id: 'empty-key-zone', sample }] } },
    })).toMatchObject({ kind: 'sampler', params: { zones: [{ id: 'empty-key-zone', sample: { assetKey: '' } }] } })
    expect(readInstrumentParamsFromEffectRow({
      effect: 'instrument',
      params: { kind: 'sampler', instanceId: 'instrument:sparse-zones', params: { ...samplerParams, zones: sparseZones } },
    })).toMatchObject({ kind: 'sampler', params: { zones: [{ id: 'valid-zone', sample: { assetKey: '' } }] } })
    const drumRack = readInstrumentParamsFromEffectRow({
      effect: 'instrument',
      params: { kind: 'drum-rack', instanceId: 'instrument:sparse-pads', params: { ...drumRackParams, pads: sparsePads } },
    })
    expect(drumRack?.kind).toBe('drum-rack')
    if (drumRack?.kind === 'drum-rack') {
      expect(drumRack.params.pads[1]?.sample?.assetKey).toBe('sample:valid-pad')
    }
  })

  test('converts sparse JSON arrays without dropping instruments', () => {
    expect(readInstrumentParamsFromEffectRow({
      effect: 'instrument',
      params: { kind: 'sampler', instanceId: 'instrument:sparse-array', params: { ...createDefaultSamplerParams(), zones: Array(1) } },
    })).toMatchObject({ kind: 'sampler', params: { zones: [] } })
  })

  test('drops malformed sample zones while retaining the instrument', () => {
    expect(readInstrumentParamsFromEffectRow({
      effect: 'instrument',
      params: { kind: 'sampler', instanceId: 'instrument:1', params: { ...createDefaultSamplerParams(), zones: [{ sample: { assetKey: 'sample' } }] } },
    })).toMatchObject({ kind: 'sampler', params: { zones: [] } })
  })

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

  test('reads legacy synth params inside instrument rows', () => {
    expect(readInstrumentParamsFromEffectRow({
      effect: 'instrument',
      params: {
        kind: 'synth',
        instanceId: 'instrument:legacy',
        params: { wave1: 'sine', wave2: 'square' },
      },
    })).toMatchObject({
      kind: 'synth',
      instanceId: 'instrument:legacy',
      params: { oscillators: [{ wave: 'sine' }, { wave: 'square' }] },
    })
  })

  test('migrates historical V2 synth params missing noise or oscillator enabled', () => {
    const defaults = createDefaultSynthParams()
    const { noise: _noise, ...withoutNoise } = defaults
    const oscillator = defaults.oscillators[0]
    const { enabled: _enabled, ...historicalOscillator } = oscillator

    for (const params of [
      withoutNoise,
      { ...defaults, oscillators: [historicalOscillator, defaults.oscillators[1]] },
    ]) {
      expect(readInstrumentParamsFromEffectRow({
        effect: 'instrument',
        params: { kind: 'synth', instanceId: 'instrument:historical', params },
      })).toMatchObject({ kind: 'synth', params: defaults })
    }
  })
})
