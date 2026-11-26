import { describe, expect, test } from 'bun:test'
import { AUDIO_EFFECT_PARAMS_VERSION, effectParamsByInstanceId, migrateAudioEffectParams, migrateAutomationPointValues } from './audio-effect-param-versions'
import { AUDIO_EFFECT_CONTRACTS } from './effects-params'
import type { JsonValue } from './json-value'
import { spectralGateDbOffset } from './spectral-params-migration'

const v1 = {
  enabled: true, fftSize: 1024, overlap: 4, mode: 'gate', freeze: 0, gateThresholdDb: -20, gateAttackMs: 5, gateReleaseMs: 80, morph: 0.3,
  binShift: 3, blur: 0.2, harmonicPercussiveBalance: -0.4, noiseReduction: 0.6, profileLearn: 0.25, mix: 0.7,
}

// The raw magnitude of a full-scale bin-centred sine through the kernel's periodic sqrt-Hann window.
const rawPeakDb = (size: number) => {
  let sum = 0

  for (let index = 0; index < size; index += 1) sum += Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * index / size))

  return 20 * Math.log10(sum / 2)
}

describe('Spectral params version 1 -> 2', () => {
  test('is the current version', () => {
    expect(AUDIO_EFFECT_PARAMS_VERSION.spectral).toBe(2)
  })

  test('the Gate offset is the window peak gain at every FFT size', () => {
    for (const size of [512, 1024, 2048, 4096]) expect(spectralGateDbOffset(size)).toBeCloseTo(rawPeakDb(size), 9)
  })

  test('moves the threshold to dBFS by the stored size, so the gate opens on the same signal', () => {
    for (const size of [512, 1024, 2048, 4096]) {
      const migrated = AUDIO_EFFECT_CONTRACTS.spectral.normalizeParams(migrateAudioEffectParams('spectral', { ...v1, fftSize: size }, 1)).state

      expect(migrated.gateThresholdDb).toBeCloseTo(-20 - rawPeakDb(size), 9)
    }
  })

  test('keeps every other knob, turns a Learn rate into the toggle and starts the floor at -30 dB', () => {
    const migrated = AUDIO_EFFECT_CONTRACTS.spectral.normalizeParams(migrateAudioEffectParams('spectral', v1, 1)).state

    expect(migrated).toMatchObject({ ...v1, gateThresholdDb: migrated.gateThresholdDb, profileLearn: 1, noiseFloorDb: -30 })
    expect(AUDIO_EFFECT_CONTRACTS.spectral.normalizeParams(migrateAudioEffectParams('spectral', { ...v1, profileLearn: 0 }, 1)).state.profileLearn).toBe(0)
  })

  test('clamps a threshold that lands below -120 dBFS and keeps a wrapped envelope wrapped', () => {
    const migrated = migrateAudioEffectParams('spectral', { version: 1, state: { ...v1, fftSize: 4096, gateThresholdDb: -100 } }, 1)

    expect(migrated).toMatchObject({ version: 1, state: { gateThresholdDb: -120 } })
  })

  test('moves automation points on the threshold as at 2048 and leaves other lanes alone', () => {
    const points = [{ time: 0, value: -60 }]

    expect(migrateAutomationPointValues('spectral.gateThresholdDb', points, 1)[0]?.value).toBeCloseTo(-60 - rawPeakDb(2048), 9)
    expect(migrateAutomationPointValues('spectral.gateThresholdDb', points, 2)).toBe(points)
    expect(migrateAutomationPointValues('spectral.mix', points, 1)).toBe(points)
  })

  test('a threshold lane moves to the same dBFS as its effect at 512 and 4096, bare or state-wrapped', () => {
    const lane = [{ time: 0, value: -20 }]

    for (const size of [512, 4096]) {
      const owner = { ...v1, fftSize: size }
      const effect = AUDIO_EFFECT_CONTRACTS.spectral.normalizeParams(migrateAudioEffectParams('spectral', owner, 1)).state.gateThresholdDb

      for (const ownerParams of [owner, { version: 1, state: owner }]) {
        expect(migrateAutomationPointValues('spectral.gateThresholdDb', lane, 1, undefined, ownerParams)[0]?.value).toBeCloseTo(effect, 9)
      }
      expect(effect).toBeCloseTo(-20 - rawPeakDb(size), 9)
    }
    expect(rawPeakDb(4096) - rawPeakDb(2048)).toBeGreaterThan(5)
  })

  test('a lane whose owner is unknown or has no legal FFT size moves as at 2048', () => {
    const lane = [{ time: 0, value: -60 }]
    const asDefault = -60 - rawPeakDb(2048)

    const owners: (JsonValue | undefined)[] = [undefined, 'broken', {}, { fftSize: 777 }]

    for (const ownerParams of owners) {
      expect(migrateAutomationPointValues('spectral.gateThresholdDb', lane, 1, undefined, ownerParams)[0]?.value).toBeCloseTo(asDefault, 9)
    }
  })

  test('effectParamsByInstanceId maps instance ids and skips rows without one', () => {
    const owners = effectParamsByInstanceId([{ instanceId: 'a', params: { fftSize: 512 } }, { params: { fftSize: 1024 } }])

    expect([...owners.keys()]).toEqual(['a'])
  })

  test('a non-object stays as stored', () => {
    expect(migrateAudioEffectParams('spectral', 'broken', 1)).toBe('broken')
  })
})
