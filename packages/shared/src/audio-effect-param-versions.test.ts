import { describe, expect, it, spyOn } from 'bun:test'
import { AUDIO_EFFECT_KINDS } from './audio-effect-registry'
import {
  AUDIO_EFFECT_PARAMS_VERSION,
  AUDIO_EFFECT_PARAMS_VERSIONING,
  audioEffectParamsVersionStamp,
  migrateAudioEffectParams,
  type AudioEffectParamsVersioning,
} from './audio-effect-param-versions'
import { isJsonObject } from './json-value'

// Test-only chain: eq is pretended to be at version 3 with a rename step then an added field.
const exampleVersioning: AudioEffectParamsVersioning = {
  current: { ...AUDIO_EFFECT_PARAMS_VERSION, eq: 3 },
  migrations: {
    eq: {
      1: (params) => isJsonObject(params) ? { renamed: params.oldName } : params,
      2: (params) => isJsonObject(params) ? { ...params, current: true } : params,
    },
  },
}

describe('audio effect parameter versions', () => {
  it('treats a missing stored version as version 1', () => {
    expect(migrateAudioEffectParams('eq', { oldName: 0.5 }, undefined, exampleVersioning)).toEqual({ renamed: 0.5, current: true })
  })

  it('applies each step from the stored version up to current', () => {
    expect(migrateAudioEffectParams('eq', { oldName: 0.5 }, 1, exampleVersioning)).toEqual({ renamed: 0.5, current: true })
    expect(migrateAudioEffectParams('eq', { renamed: 0.5 }, 2, exampleVersioning)).toEqual({ renamed: 0.5, current: true })
    expect(migrateAudioEffectParams('eq', { renamed: 0.5, current: true }, 3, exampleVersioning)).toEqual({ renamed: 0.5, current: true })
  })

  it('leaves params of an up-to-date row untouched', () => {
    const params = { version: 1, state: { gainDb: 3 } }

    expect(migrateAudioEffectParams('utility', params, 1)).toBe(params)
  })

  it('returns params from a newer build unchanged and warns once per kind and version', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    const params = { fromTheFuture: true }

    expect(migrateAudioEffectParams('reverb', params, 99)).toBe(params)
    expect(migrateAudioEffectParams('reverb', params, 99)).toBe(params)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('fails loudly when a migration step is missing', () => {
    const gap: AudioEffectParamsVersioning = { current: { ...AUDIO_EFFECT_PARAMS_VERSION, gate: 2 }, migrations: {} }

    expect(() => migrateAudioEffectParams('gate', {}, 1, gap)).toThrow('Missing gate params migration from version 1 to 2.')
  })

  it('has a step for every version below current for every catalog kind', () => {
    for (const kind of AUDIO_EFFECT_KINDS) {
      for (let version = 1; version < AUDIO_EFFECT_PARAMS_VERSIONING.current[kind]; version += 1) {
        expect(AUDIO_EFFECT_PARAMS_VERSIONING.migrations[kind]?.[version]).toBeFunction()
      }
    }
  })

  it('stamps the current version on catalog kinds only', () => {
    for (const kind of AUDIO_EFFECT_KINDS) expect(audioEffectParamsVersionStamp(kind)).toEqual({ paramsVersion: AUDIO_EFFECT_PARAMS_VERSION[kind] })
    expect(audioEffectParamsVersionStamp('instrument')).toEqual({})
  })
})
