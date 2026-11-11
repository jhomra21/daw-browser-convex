import { describe, expect, test } from 'bun:test'
import { GRANULAR_MAX_GRAINS, createDefaultGranularParams, normalizeGranularParams } from './granular-params'

describe('granular params', () => {
  test('normalizes controls and enforces resource bounds', () => {
    const params = normalizeGranularParams({
      grainSizeMs: -1,
      densityHz: 999,
      position: 2,
      spray: -1,
      pitchSemitones: 100,
      reverseProbability: 2,
      stereoSpread: 2,
      maxGrains: 999,
      maxDecodedBytes: Number.POSITIVE_INFINITY,
    })
    expect(params.grainSizeMs).toBe(5)
    expect(params.densityHz).toBe(200)
    expect(params.position).toBe(1)
    expect(params.spray).toBe(0)
    expect(params.pitchSemitones).toBe(48)
    expect(params.reverseProbability).toBe(1)
    expect(params.stereoSpread).toBe(1)
    expect(params.maxGrains).toBe(GRANULAR_MAX_GRAINS)
    expect(params.maxDecodedBytes).toBe(createDefaultGranularParams().maxDecodedBytes)
  })

  test('preserves minimal and inverted-range granular zones without Sampler filtering', () => {
    const sample = { assetKey: 'sample', url: 'local-asset:sample', sourceKind: 'upload', source: { durationSec: 2, sampleRate: 48000, channelCount: 2 } }
    const minimalZone = { id: 'minimal', sample }
    const invertedZone = { id: 'inverted', sample, keyLow: 100, keyHigh: 20, velocityLow: 100, velocityHigh: 10 }

    expect(normalizeGranularParams({ zone: minimalZone }).zone).toMatchObject(minimalZone)
    expect(normalizeGranularParams({ zone: invertedZone }).zone).toMatchObject(invertedZone)
  })
})
