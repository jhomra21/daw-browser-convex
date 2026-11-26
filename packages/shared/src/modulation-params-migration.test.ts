import { describe, expect, test } from 'bun:test'
import { AUDIO_EFFECT_CONTRACTS } from './effects-params'
import { migrateAudioEffectParams } from './audio-effect-param-versions'
import type { JsonValue } from './json-value'

type ModulationKind = 'chorus' | 'flanger' | 'phaser' | 'tremolo' | 'autopan' | 'ensemble'

const v1: Record<ModulationKind, Record<string, string | number | boolean>> = {
  chorus: { enabled: true, delayMs: 14, depthMs: 3, rateHz: 1.1, feedback: 0.2, stereoPhase: 0.3, mix: 0.4 },
  flanger: { enabled: false, delayMs: 2, depthMs: 1.5, rateHz: 0.4, feedback: -0.5, stereoPhase: 0.1, mix: 0.6 },
  phaser: { enabled: true, stages: 8, centerHz: 700, depthOctaves: 2, rateHz: 0.5, feedback: 0.4, stereoPhase: 0.2, mix: 0.7 },
  tremolo: { enabled: true, waveform: 'triangle', rateHz: 6, depth: 0.8, 'shape': 0.3, phase: 0.25 },
  autopan: { enabled: true, waveform: 'sine', rateHz: 2, depth: 0.9, 'shape': 0.6, phase: 0.5 },
  ensemble: { enabled: true, voices: 3, delayMs: 20, depthMs: 5, rateHz: 0.7, spread: 0.8, mix: 0.45 },
}

const kinds: ModulationKind[] = ['chorus', 'flanger', 'phaser', 'tremolo', 'autopan', 'ensemble']

describe('modulation params v1 to v2', () => {
  for (const kind of kinds) {
    test(`${kind}: every old knob keeps its value and the added controls take their neutral defaults`, () => {
      const old: JsonValue = v1[kind]
      const migrated = migrateAudioEffectParams(kind, old, 1)
      const normalized = AUDIO_EFFECT_CONTRACTS[kind].normalizeParams(migrated).state
      const defaults = AUDIO_EFFECT_CONTRACTS[kind].createDefaultParams().state

      expect(normalized).toMatchObject(v1[kind])
      // Every field the old shape did not have equals the default of the rebuilt effect, which leaves the sound as it was.
      const actual = new Map(Object.entries(normalized))

      for (const [key, value] of Object.entries(defaults)) {
        if (!(key in v1[kind])) expect(actual.get(key)).toEqual(value)
      }
    })

    test(`${kind}: a wrapped version 1 envelope stays wrapped`, () => {
      const migrated = migrateAudioEffectParams(kind, { version: 1, state: v1[kind] }, 1)

      expect(migrated).toMatchObject({ version: 1, state: v1[kind] })
      expect(migrated).toHaveProperty('state.waveform')
    })

    test(`${kind}: a stored v2 value is left alone`, () => {
      const current = AUDIO_EFFECT_CONTRACTS[kind].createDefaultParams()

      expect(migrateAudioEffectParams(kind, current, 2)).toEqual(current)
    })
  }

  test('a non-object stays as stored', () => {
    expect(migrateAudioEffectParams('chorus', 'broken', 1)).toBe('broken')
  })
})
