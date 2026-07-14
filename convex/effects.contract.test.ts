import { describe, expect, test } from 'bun:test'
import { restoreChainArgsValidator, validateAudioEffectInstanceId } from './effects'

describe('audio effect persistence instance contract', () => {
  test('accepts a seventeenth unique track or master effect instance', () => {
    const rows = Array.from({ length: 17 }, (_, index) => ({
      _id: `effect-${index}`,
      type: 'utility',
      instanceId: `instance-${index}`,
    }))

    expect(() => validateAudioEffectInstanceId(rows, 'instance-16', 'utility')).not.toThrow()
  })

  test('keeps nonempty and per-target cross-kind instance identity validation', () => {
    const rows = [{ _id: 'effect-1', type: 'utility', instanceId: 'shared-instance' }]

    expect(() => validateAudioEffectInstanceId(rows, ' ', 'utility')).toThrow('nonempty')
    expect(() => validateAudioEffectInstanceId(rows, 'shared-instance', 'gate')).toThrow('unique per target')
    expect(() => validateAudioEffectInstanceId(rows, 'shared-instance', 'utility')).not.toThrow()
  })

  test('accepts only canonical restore-chain audio effect fields', () => {
    const audioEffects = restoreChainArgsValidator.audioEffects

    expect(audioEffects.kind).toBe('array')
    expect(audioEffects.element.kind).toBe('object')
    expect(Object.keys(audioEffects.element.fields)).toEqual(['id', 'kind', 'params'])
  })
})
