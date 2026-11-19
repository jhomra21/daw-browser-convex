import { describe, expect, test } from 'bun:test'
import { AUDIO_EFFECT_CONTRACTS, type JsonValue } from '@daw-browser/shared'
import type { ExportFx } from '@daw-browser/audio-engine/export-mixdown'
import { applyLocalEffectRowsToFx } from './desired-playback-state'
import type { LocalEffectRow } from './local-effects'

const row = (id: string, effect: 'delay' | 'spectrum', index: number, params: JsonValue): LocalEffectRow<JsonValue> => ({
  id, targetId: 'track-1', effect, instanceId: id, params, index, updatedAt: 1,
})
const delay = row('delay-1', 'delay', 0, AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams())
const spectrum = row('spectrum-1', 'spectrum', 1, AUDIO_EFFECT_CONTRACTS.spectrum.createDefaultParams())
const project = (rows: LocalEffectRow<JsonValue>[]) => {
  const fx: ExportFx = { masterFxInstances: [] }
  applyLocalEffectRowsToFx(fx, rows)
  return fx
}

describe('export fx with a Spectrum device', () => {
  test('is identical to the same chain without it, for tracks and the master', () => {
    expect(project([delay, spectrum])).toEqual(project([delay]))
    const masterSpectrum = { ...spectrum, targetId: 'master', effect: 'spectrum' as const }
    expect(project([delay, masterSpectrum])).toEqual(project([delay]))
  })

  test('a chain holding only a Spectrum device contributes no export processors', () => {
    expect(project([spectrum]).trackFx?.['track-1']?.instances ?? []).toEqual([])
  })
})
