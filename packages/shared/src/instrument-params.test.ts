import { describe, expect, test } from 'bun:test'
import {
  applySamplerZoneEdit,
  createDefaultGranularParams,
  createDefaultSamplerParams,
  duplicateTrackInstrumentParams,
  normalizeTrackInstrumentParams,
  type SamplerZone,
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
        sample: {
          assetKey: 'asset:granular',
          url: '/sample.wav',
          sourceKind: 'upload',
          source: { durationSec: 3, sampleRate: 48000, channelCount: 2 },
        },
        keyLow: 0,
        keyHigh: 127,
        velocityLow: 1,
        velocityHigh: 127,
        rootNote: 60,
        tuneCents: 0,
        gain: 1,
        pan: 0,
        roundRobinGroup: 0,
        roundRobinIndex: 0,
        playbackMode: 'one-shot',
        startSec: 0,
        endSec: 3,
        crossfadeSec: 0,
        chokeGroup: 0,
      },
    }
    const first = normalizeTrackInstrumentParams({ kind: 'granular', instanceId: 'instrument:granular', params })
    const second = normalizeTrackInstrumentParams({ kind: 'granular', instanceId: 'instrument:granular', params })
    expect(first).toEqual(second)
    expect(first?.instanceId).toBe('instrument:granular')
    expect(first?.params).toMatchObject({
      version: 1,
      zone: { id: 'zone', sample: { assetKey: 'asset:granular' }, endSec: 3 },
    })
  })

  test('editing one zone range bound clamps it to the other bound instead of dropping the zone', () => {
    const zone: SamplerZone = {
      id: 'zone',
      sample: {
        assetKey: 'asset:sampler',
        url: '/sample.wav',
        sourceKind: 'upload',
        source: { durationSec: 3, sampleRate: 48000, channelCount: 2 },
      },
      keyLow: 40,
      keyHigh: 60,
      velocityLow: 20,
      velocityHigh: 100,
      rootNote: 60,
      tuneCents: 0,
      gain: 1,
      pan: 0,
      roundRobinGroup: 0,
      roundRobinIndex: 0,
      playbackMode: 'one-shot',
      startSec: 0,
      endSec: 3,
      crossfadeSec: 0,
      chokeGroup: 0,
    }
    expect(applySamplerZoneEdit(zone, { keyLow: 90 })).toMatchObject({ keyLow: 60, keyHigh: 60 })
    expect(applySamplerZoneEdit(zone, { keyHigh: 10 })).toMatchObject({ keyLow: 40, keyHigh: 40 })
    expect(applySamplerZoneEdit(zone, { velocityLow: 127 })).toMatchObject({ velocityLow: 100, velocityHigh: 100 })
    expect(applySamplerZoneEdit(zone, { velocityHigh: 1 })).toMatchObject({ velocityLow: 20, velocityHigh: 20 })
    expect(applySamplerZoneEdit(zone, { keyLow: 50, id: 'other' })).toMatchObject({ id: zone.id, keyLow: 50, keyHigh: 60 })
  })

  test('synth normalization rejects non-finite persisted legacy values', () => {
    expect(normalizeTrackInstrumentParams({
      kind: 'synth',
      instanceId: 'instrument:synth',
      params: {
        gain: Number.NaN,
        attackMs: Number.POSITIVE_INFINITY,
        releaseMs: Number.NEGATIVE_INFINITY,
      },
    })?.params).toMatchObject({
      gain: 0.8,
      ampEnvelope: { attackSec: 0.005, releaseSec: 0.12 },
    })
  })
})
