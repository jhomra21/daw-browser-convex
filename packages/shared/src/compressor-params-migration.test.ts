import { describe, expect, test } from 'bun:test'
import { AUDIO_EFFECT_PARAMS_VERSION, migrateAudioEffectParams } from './audio-effect-param-versions'
import { migrateCompressorParamsV1 } from './compressor-params-migration'
import { AUDIO_EFFECT_CONTRACTS } from './effects-params'
import { isJsonObject } from './json-value'

const version1 = (lookaheadMs: number) => ({
  enabled: true, thresholdDb: -30, ratio: 6, attackMs: 5, releaseMs: 200, autoRelease: true, makeupDb: 3, outputDb: -1, dryWet: 0.8,
  kneeDb: 4, lookaheadMs, detectorMode: 'peak', dynamicsMode: 'compress', envelopeCurve: 'log',
  sidechain: { enabled: false, filterType: 'highpass', frequencyHz: 120, q: 0.707 },
})

describe('Compressor params version 1 -> 2', () => {
  test('is the current version', () => {
    expect(AUDIO_EFFECT_PARAMS_VERSION.compressor).toBe(2)
  })

  test('keeps every knob and adds Auto Makeup off', () => {
    expect(migrateCompressorParamsV1(version1(0))).toEqual({ ...version1(0), autoMakeup: false })
  })

  test('snaps the old continuous lookahead to the nearest step, a tie going to the longer one', () => {
    const snapped = [0, 0.4, 0.5, 0.6, 1, 3, 5, 5.5, 8, 10].map((lookaheadMs) => {
      const migrated = migrateCompressorParamsV1(version1(lookaheadMs))

      return isJsonObject(migrated) ? migrated.lookaheadMs : null
    })

    expect(snapped).toEqual([0, 0, 1, 1, 1, 1, 1, 10, 10, 10])
  })

  test('migrates a wrapped envelope and leaves the version stamp to the caller', () => {
    expect(migrateCompressorParamsV1({ version: 1, state: version1(10) })).toEqual({
      version: 1,
      state: { ...version1(10), autoMakeup: false },
    })
  })

  test('migrates stored rows through the registry and normalizes to a valid state', () => {
    const migrated = migrateAudioEffectParams('compressor', version1(7), 1)

    expect(migrated).toEqual({ ...version1(7), lookaheadMs: 10, autoMakeup: false })
    expect(AUDIO_EFFECT_CONTRACTS.compressor.normalizeParams({ lookaheadMs: 7 }).lookaheadMs).toBe(10)
  })

  test('passes non-objects through', () => {
    expect(migrateCompressorParamsV1(null)).toBeNull()
  })
})
