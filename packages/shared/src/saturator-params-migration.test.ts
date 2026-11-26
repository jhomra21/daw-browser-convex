import { describe, expect, test } from 'bun:test'
import { AUDIO_EFFECT_PARAMS_VERSION, migrateAudioEffectParams, migrateWrittenAudioEffectParams } from './audio-effect-param-versions'
import { createDefaultSaturatorParams, normalizeSaturatorParams } from './effects-params'
import { getAutomationParameterDescriptor } from './automation-parameters'

const version1 = {
  enabled: false, driveDb: 18, curve: 'hard', color: true, colorFrequencyHz: 2500, colorAmount: 0.5, outputDb: -3, dryWet: 0.75,
}

describe('Saturator params version 2', () => {
  test('keeps every version 1 knob and turns the Color amount into Amt Hi', () => {
    expect(AUDIO_EFFECT_PARAMS_VERSION.saturator).toBe(2)
    const migrated = normalizeSaturatorParams(migrateAudioEffectParams('saturator', version1, 1))

    expect(migrated).toEqual({
      ...createDefaultSaturatorParams(),
      enabled: false, driveDb: 18, curve: 'hard', color: true, colorFrequencyHz: 2500, colorHighDb: 6, outputDb: -3, dryWet: 0.75,
    })
    expect(migrated.hiQuality).toBe(true)
    expect(migrated.postClip).toBe('off')
    expect(migrated.colorLowDb).toBe(0)
  })

  test('a version 1 device with Color off migrates to a flat Color', () => {
    const migrated = normalizeSaturatorParams(migrateAudioEffectParams('saturator', { ...version1, color: false, colorAmount: 0 }, 1))

    expect(migrated.color).toBe(false)
    expect(migrated.colorHighDb).toBe(0)
  })

  test('migrates a client write at version 1 and refuses a newer one', () => {
    expect(migrateWrittenAudioEffectParams('saturator', version1, 1)).toMatchObject({ colorHighDb: 6, hiQuality: true })
    expect(migrateWrittenAudioEffectParams('saturator', version1, 3)).toBeUndefined()
  })

  test('exposes every continuous control for automation', () => {
    for (const id of ['driveDb', 'outputDb', 'dryWet', 'colorFrequencyHz', 'colorWidth', 'colorLowDb', 'colorHighDb', 'bassThresholdDb', 'waveshaperDepth', 'waveshaperPeriod']) {
      const descriptor = getAutomationParameterDescriptor(`saturator.${id}`)

      expect(descriptor?.owner).toBe('saturator')
      expect(descriptor?.defaultValue).toBe(createDefaultSaturatorParams()[id as keyof ReturnType<typeof createDefaultSaturatorParams>])
    }
    expect(getAutomationParameterDescriptor('saturator.colorAmount')).toBeUndefined()
  })
})
