import { describe, expect, test } from 'bun:test'
import { AUDIO_EFFECT_PARAMS_VERSION, migrateAudioEffectParams } from './audio-effect-param-versions'
import { AUDIO_EFFECT_CONTRACTS } from './effects-params'
import { migrateGateParamsV1 } from './gate-params-migration'
import { isJsonObject } from './json-value'

const version1 = (lookaheadMs: number) => ({
  enabled: true, mode: 'expander', thresholdDb: -30, ratio: 3, attackMs: 5, holdMs: 40, releaseMs: 200, hysteresisDb: 4, rangeDb: -50,
  lookaheadMs, detector: 'rms', link: 0.5,
  sidechain: { enabled: true, filterType: 'highpass', frequencyHz: 120, q: 1.5 },
})

describe('Gate params version 1 -> 2', () => {
  test('is the current version', () => {
    expect(AUDIO_EFFECT_PARAMS_VERSION.gate).toBe(2)
  })

  test('keeps every knob and adds Flip off, a high-pass detector filter, sidechain Gain 0 dB and Dry/Wet 100 %', () => {
    expect(migrateGateParamsV1(version1(0))).toEqual({
      ...version1(0),
      flip: false,
      sidechain: { enabled: true, filterType: 'highpass', frequencyHz: 120, q: 1.5, gainDb: 0, mix: 1 },
    })
  })

  test('snaps the old continuous lookahead to the nearest step, a tie going to the longer one', () => {
    const snapped = [0, 0.4, 0.5, 0.6, 1, 1.5, 2].map((lookaheadMs) => {
      const migrated = migrateGateParamsV1(version1(lookaheadMs))

      return isJsonObject(migrated) ? migrated.lookaheadMs : null
    })

    expect(snapped).toEqual([0, 0, 1, 1, 1, 1, 1])
  })

  test('adds the new fields to a state that has no detector filter object', () => {
    const { sidechain: _sidechain, ...withoutSidechain } = version1(0)
    const migrated = migrateGateParamsV1(withoutSidechain)

    expect(isJsonObject(migrated) ? migrated.sidechain : null).toEqual({ filterType: 'highpass', gainDb: 0, mix: 1 })
  })

  test('migrates a wrapped envelope and leaves the version stamp to the caller', () => {
    expect(migrateGateParamsV1({ version: 1, state: version1(1) })).toEqual({
      version: 1,
      state: {
        ...version1(1),
        flip: false,
        sidechain: { enabled: true, filterType: 'highpass', frequencyHz: 120, q: 1.5, gainDb: 0, mix: 1 },
      },
    })
  })

  test('migrates stored rows through the registry and normalizes to a valid state', () => {
    const migrated = migrateAudioEffectParams('gate', { version: 1, state: version1(2) }, 1)

    expect(AUDIO_EFFECT_CONTRACTS.gate.normalizeParams(migrated)).toEqual({
      version: 1,
      state: {
        enabled: true, mode: 'expander', thresholdDb: -30, ratio: 3, attackMs: 5, holdMs: 40, releaseMs: 200, hysteresisDb: 4, rangeDb: -50,
        lookaheadMs: 1, detector: 'rms', link: 0.5, flip: false,
        sidechain: { enabled: true, filterType: 'highpass', frequencyHz: 120, q: 1.5, gainDb: 0, mix: 1 },
      },
    })
  })

  test('normalizing clamps the new fields and falls back on unknown filter types', () => {
    const { state } = AUDIO_EFFECT_CONTRACTS.gate.normalizeParams({
      state: { ...version1(0), lookaheadMs: 7, flip: true, sidechain: { filterType: 'notch', gainDb: 99, mix: -1 } },
      version: 1,
    })

    expect(state.lookaheadMs).toBe(10)
    expect(state.flip).toBe(true)
    expect(state.sidechain).toEqual({ enabled: false, filterType: 'highpass', frequencyHz: 80, q: 0.707, gainDb: 24, mix: 0 })
  })

  test('passes non-objects through', () => {
    expect(migrateGateParamsV1(null)).toBeNull()
  })
})
