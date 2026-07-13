import { describe, expect, test } from 'bun:test'
import {
  createDefaultGranularParams,
  createDefaultSamplerParams,
  duplicateTrackInstrumentParams,
  normalizeTrackInstrumentParams,
} from './index'

describe('instrument identity', () => {
  test('normalization requires a durable instance id', () => {
    const value = { kind: 'sampler', params: createDefaultSamplerParams() }
    expect(normalizeTrackInstrumentParams(value)).toBeUndefined()
  })

  test('normalization preserves identity and duplication creates a new identity', () => {
    const original = normalizeTrackInstrumentParams({
      kind: 'sampler',
      instanceId: 'instrument:original',
      params: createDefaultSamplerParams(),
    })
    if (!original) throw new Error('Expected sampler instrument')
    const duplicate = duplicateTrackInstrumentParams(original)

    expect(normalizeTrackInstrumentParams(original)?.instanceId).toBe('instrument:original')
    expect(duplicate.instanceId).not.toBe(original.instanceId)
    expect(duplicate.params).toBe(original.params)
  })

  test('granular state preserves its durable identity and versioned asset state', () => {
    const params = {
      ...createDefaultGranularParams(),
      zone: {
        id: 'zone',
        sample: { assetKey: 'asset:granular', url: '/sample.wav' },
      },
    }
    const first = normalizeTrackInstrumentParams({ kind: 'granular', instanceId: 'instrument:granular', params })
    const second = normalizeTrackInstrumentParams({ kind: 'granular', instanceId: 'instrument:granular', params })
    expect(first).toEqual(second)
    expect(first?.instanceId).toBe('instrument:granular')
    expect(first?.params).toMatchObject({ version: 1, zone: params.zone })
  })
})
