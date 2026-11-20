import { describe, expect, test } from 'bun:test'
import { AUDIO_EFFECT_CONTRACTS, AUDIO_EFFECT_KINDS, normalizeAudioEffect, normalizeAudioEffectRow } from './index'

describe('audio effect normalization', () => {
  for (const kind of AUDIO_EFFECT_KINDS) {
    test(`${kind} runs its own contract normalizer under either name`, () => {
      const params = AUDIO_EFFECT_CONTRACTS[kind].normalizeParams({})
  
      const effect = normalizeAudioEffect(kind, {})
      const row = normalizeAudioEffectRow(kind, {})

      expect([effect.kind, effect.params]).toEqual([kind, params])
      expect([row.effect, row.params]).toEqual([kind, params])
    })
  }

  for (const kind of AUDIO_EFFECT_KINDS) {
    test(`${kind} normalizes stored params that are not an object like an empty object`, () => {
      expect(normalizeAudioEffect(kind, [1])).toEqual(normalizeAudioEffect(kind, {}))
    })
  }
})
