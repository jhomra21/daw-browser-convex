import { describe, expect, it } from 'bun:test'
import { AUDIO_EFFECT_KINDS } from './audio-effect-registry'
import { migrateAudioEffectParams, readAudioEffectParamsVersion } from './audio-effect-param-versions'
import { isJsonObject } from './json-value'

describe('audio effect parameter versions', () => {
  it('defaults missing storage metadata to version 1', () => {
    expect(readAudioEffectParamsVersion(undefined)).toBe(1)
  })

  it('applies each consecutive migration before returning parameters', () => {
    const params = migrateAudioEffectParams('eq', { oldName: 0.5 }, 1, {
      eq: {
        1: (value) => {
          if (!isJsonObject(value)) return value

          return { renamed: value.oldName }
        },
        2: (value) => {
          if (!isJsonObject(value)) return value

          return { ...value, current: true }
        },
      },
    }, 3)

    expect(params).toEqual({ renamed: 0.5, current: true })
  })

  it('rejects unknown future versions', () => {
    expect(() => migrateAudioEffectParams('eq', {}, 2)).toThrow('Unsupported eq params version 2.')
  })

  it('has current version metadata for every catalog effect', () => {
    expect(AUDIO_EFFECT_KINDS.every((kind) => migrateAudioEffectParams(kind, {}, undefined) !== undefined)).toBe(true)
  })
})
