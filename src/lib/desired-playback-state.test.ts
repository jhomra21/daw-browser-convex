import { describe, expect, test } from 'bun:test'
import { AUDIO_EFFECT_CONTRACTS, AUDIO_EFFECT_KINDS, isDspAudioEffectKind, normalizeAudioEffect, normalizeAudioEffectRow, type AudioEffectKind, type JsonValue } from '@daw-browser/shared'
import type { ExportFx } from '@daw-browser/audio-engine/export-mixdown'
import { applyEffectsProjectionToFx, applyLocalEffectRowsToFx, cloneExportEffectsProjection, cloneExportFx } from './desired-playback-state'
import type { LocalEffectRow } from './local-effects'

const row = (id: string, effect: AudioEffectKind, index: number, params: JsonValue): LocalEffectRow<JsonValue> => ({
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

const dspKinds = AUDIO_EFFECT_KINDS.filter(isDspAudioEffectKind)

describe('export fx per effect kind', () => {
  for (const kind of dspKinds) {
    const expected = normalizeAudioEffect(kind, AUDIO_EFFECT_CONTRACTS[kind].createDefaultParams())
    const instance = { id: `${kind}-1`, ...expected }

    test(`${kind} local rows become one normalized instance on a track and on the master`, () => {
      const params = AUDIO_EFFECT_CONTRACTS[kind].createDefaultParams()
      const fx = project([row(`${kind}-1`, kind, 0, params), { ...row(`${kind}-1`, kind, 0, params), targetId: 'master' }])

      expect(fx.trackFx?.['track-1']?.instances).toEqual([instance])
      expect(fx.masterFxInstances).toEqual([instance])
    })

    test(`${kind} projected rows replace or upsert one normalized instance`, () => {
      const projected = { targetId: 'track-1', instanceId: `${kind}-1`, index: 0, ...normalizeAudioEffectRow(kind, expected.params) }
      const replaced: ExportFx = { masterFxInstances: [] }
      const upserted: ExportFx = { masterFxInstances: [] }

      applyEffectsProjectionToFx(replaced, { replaceAudioEffectTargets: [{ targetId: 'track-1', rows: [projected] }], upsertDeviceRows: [] })
      applyEffectsProjectionToFx(upserted, { replaceAudioEffectTargets: [], upsertDeviceRows: [projected] })

      expect(replaced.trackFx?.['track-1']?.instances).toEqual([instance])
      expect(upserted.trackFx?.['track-1']?.instances).toEqual([instance])
    })

    test(`${kind} clones are normalized copies`, () => {
      const cloned = cloneExportFx({ masterFxInstances: [instance], trackFx: { 'track-1': { instances: [instance] } } })
      const projected = { targetId: 'track-1', instanceId: instance.id, index: 0, ...normalizeAudioEffectRow(kind, expected.params) }
      const projection = cloneExportEffectsProjection({ replaceAudioEffectTargets: [{ targetId: 'track-1', rows: [projected] }], upsertDeviceRows: [] })

      expect(cloned.masterFxInstances).toEqual([instance])
      expect(cloned.trackFx?.['track-1']?.instances).toEqual([instance])
      expect(projection?.replaceAudioEffectTargets[0]?.rows).toEqual([projected])
    })
  }
})
