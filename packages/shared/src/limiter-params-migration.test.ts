import { describe, expect, test } from 'bun:test'
import { AUDIO_EFFECT_PARAMS_VERSION, migrateAudioEffectParams } from './audio-effect-param-versions'
import { AUDIO_EFFECT_CONTRACTS } from './effects-params'
import { isJsonObject } from './json-value'
import { migrateLimiterParamsV1 } from './limiter-params-migration'

const version1 = (lookaheadMs: number) => ({
  enabled: true, ceilingDbtp: -3, releaseMs: 250, lookaheadMs, link: 0.5, detectorOversampling: 4,
})

describe('Limiter params version 1 -> 2', () => {
  test('is the current version', () => {
    expect(AUDIO_EFFECT_PARAMS_VERSION.limiter).toBe(2)
  })

  test('keeps Ceiling, Release and Link and adds Gain 0 dB with Auto off', () => {
    expect(migrateLimiterParamsV1(version1(5))).toEqual({
      enabled: true, ceilingDbtp: -3, releaseMs: 250, lookaheadMs: 6, link: 0.5, gainDb: 0, autoRelease: false,
    })
  })

  test('snaps the old continuous lookahead to the nearest step', () => {
    const snapped = [1, 1.5, 2, 2.2, 3, 4, 4.5, 5].map((lookaheadMs) => {
      const migrated = migrateLimiterParamsV1(version1(lookaheadMs))

      return isJsonObject(migrated) ? migrated.lookaheadMs : null
    })

    expect(snapped).toEqual([1.5, 1.5, 1.5, 1.5, 3, 3, 6, 6])
  })

  test('migrates a wrapped envelope and leaves the version stamp to the caller', () => {
    expect(migrateLimiterParamsV1({ version: 1, state: version1(1) })).toEqual({
      version: 1,
      state: { enabled: true, ceilingDbtp: -3, releaseMs: 250, lookaheadMs: 1.5, link: 0.5, gainDb: 0, autoRelease: false },
    })
  })

  test('migrates stored rows through the registry and normalizes to a valid state', () => {
    const migrated = migrateAudioEffectParams('limiter', { version: 1, state: version1(5) }, 1)

    expect(AUDIO_EFFECT_CONTRACTS.limiter.normalizeParams(migrated)).toEqual({
      version: 1,
      state: { enabled: true, gainDb: 0, ceilingDbtp: -3, releaseMs: 250, autoRelease: false, lookaheadMs: 6, link: 0.5 },
    })
  })

  test('passes non-objects through', () => {
    expect(migrateLimiterParamsV1(null)).toBeNull()
  })
})
