import { describe, expect, test } from 'bun:test'
import {
  createDefaultGranularParams,
  createDefaultSamplerParams,
  duplicateTrackInstrumentParams,
  normalizeTrackInstrumentParams,
} from './index'

describe('instrument identity', () => {
  test('legacy normalization is deterministic across reload and reorder', () => {
    const value = { kind: 'sampler', params: createDefaultSamplerParams() }
    const first = normalizeTrackInstrumentParams(value)
    const second = normalizeTrackInstrumentParams({ params: value.params, kind: value.kind })

    expect(first?.instanceId).toBe(second?.instanceId)
    expect(first?.instanceId).toStartWith('instrument:migration:sampler:')
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

  test('granular state migrates with stable identity and preserves versioned asset state', () => {
    const params = {
      ...createDefaultGranularParams(),
      zone: {
        id: 'zone',
        sample: { assetKey: 'asset:granular', url: '/sample.wav' },
      },
    }
    const first = normalizeTrackInstrumentParams({ kind: 'granular', params })
    const second = normalizeTrackInstrumentParams({ kind: 'granular', params })
    expect(first).toEqual(second)
    expect(first?.instanceId).toStartWith('instrument:migration:granular:')
    expect(first?.params).toMatchObject({ version: 1, zone: params.zone })
  })
})
