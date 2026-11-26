import { describe, expect, test } from 'bun:test'
import { AUDIO_EFFECT_PARAMS_VERSION, migrateAudioEffectParams, migrateWrittenAudioEffectParams } from './audio-effect-param-versions'
import { createDefaultSaturatorParams } from './effects-params'
import { getAutomationParameterDescriptor } from './automation-parameters'

const version1 = {
  enabled: false, driveDb: 18, curve: 'hard', color: true, colorFrequencyHz: 2500, colorAmount: 0.5, outputDb: -3, dryWet: 0.75,
}

describe('Saturator params version 2', () => {
  test('keeps every version 1 knob and turns the Color amount into Amt Hi', () => {
    expect(AUDIO_EFFECT_PARAMS_VERSION.saturator).toBe(2)

    expect(migrateAudioEffectParams('saturator', version1, 1)).toMatchObject({
      enabled: false, driveDb: 18, curve: 'hard', color: true, colorFrequencyHz: 2500, outputDb: -3, dryWet: 0.75,
      colorHighDb: 6, colorLowDb: 0, colorWidth: createDefaultSaturatorParams().colorWidth, hiQuality: true, postClip: 'off',
    })
  })

  test('a version 1 device with Color off migrates to a flat Color', () => {
    expect(migrateAudioEffectParams('saturator', { ...version1, color: false, colorAmount: 0 }, 1)).toMatchObject({ color: false, colorHighDb: 0 })
  })

  test('migrates a client write at version 1 and refuses a newer one', () => {
    expect(migrateWrittenAudioEffectParams('saturator', version1, 1)).toMatchObject({ colorHighDb: 6, hiQuality: true })
    expect(migrateWrittenAudioEffectParams('saturator', version1, 3)).toBeUndefined()
  })

  test('exposes every continuous control for automation', () => {
    const defaults = createDefaultSaturatorParams()

    const controls: [string, number][] = [
      ['driveDb', defaults.driveDb], ['outputDb', defaults.outputDb], ['dryWet', defaults.dryWet], ['colorFrequencyHz', defaults.colorFrequencyHz],
      ['colorWidth', defaults.colorWidth], ['colorLowDb', defaults.colorLowDb], ['colorHighDb', defaults.colorHighDb],
      ['bassThresholdDb', defaults.bassThresholdDb], ['warpDepth', defaults.warpDepth], ['warpPeriod', defaults.warpPeriod],
    ]

    for (const [id, defaultValue] of controls) {
      const descriptor = getAutomationParameterDescriptor(`saturator.${id}`)

      expect(descriptor?.owner).toBe('saturator')
      expect(descriptor?.defaultValue).toBe(defaultValue)
    }

    expect(getAutomationParameterDescriptor('saturator.colorAmount')).toBeUndefined()
  })
})
