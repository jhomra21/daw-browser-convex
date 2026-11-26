import { describe, expect, test } from 'bun:test'
import { AUDIO_EFFECT_PARAMS_VERSION, AUDIO_EFFECT_PARAMS_VERSIONING, migrateAudioEffectParams } from './audio-effect-param-versions'
import { normalizeAudioEffect } from './audio-effect-normalization'
import { createDefaultReverbParams } from './effects-params'
import { isJsonObject, type JsonValue } from './json-value'
import { migrateReverbParamsV1, migrateReverbStereoWidthV1 } from './reverb-params-migration'

const version1 = {
  enabled: true, wet: 0.4, decaySec: 3, preDelayMs: 30, reflections: 0.2, reflectionSpin: true, reflectionModAmountMs: 10,
  reflectionModRateHz: 0.5, 'reflectionShape': 0.3, diffuse: 0.9, size: 0.5, diffusion: 0.6, density: 0.5, lowCutHz: 20, highCutHz: 20000,
  diffusionLowCutHz: 20, diffusionHighCutHz: 20000, stereoWidth: 1,
}

const fieldsOf = (params: JsonValue) => (isJsonObject(params) ? params : {})

describe('Reverb params version 1 -> 2', () => {
  test('is the current version', () => {
    expect(AUDIO_EFFECT_PARAMS_VERSION.reverb).toBe(2)
  })

  test('keeps the knobs that kept their meaning and drops the diffusion cuts', () => {
    const migrated = fieldsOf(migrateReverbParamsV1(version1))

    expect(migrated).toMatchObject({
      enabled: true, wet: 0.4, decaySec: 3, preDelayMs: 30, reflections: 0.2, reflectionSpin: true, reflectionModAmountMs: 10,
      reflectionModRateHz: 0.5, 'reflectionShape': 0.3, size: 0.5, diffusion: 0.6,
    })

    expect('diffusionLowCutHz' in migrated).toBe(false)
    expect('diffusionHighCutHz' in migrated).toBe(false)
  })

  test('migrated projects keep the old eight-line network (Sparse) and take the new Chorus and Smooth defaults', () => {
    const defaults = createDefaultReverbParams()

    expect(fieldsOf(migrateReverbParamsV1(version1))).toMatchObject({
      density: 'sparse', smooth: defaults.smooth, freeze: false, flat: false, cut: false, chorus: defaults.chorus,
      chorusAmountMs: defaults.chorusAmountMs, chorusRateHz: defaults.chorusRateHz,
    })
  })

  test('folds the old output gain (Diffuse, Density and Diffusion) into Diffuse so the tail is as loud', () => {
    const defaults = { ...version1, decaySec: 2.2, size: 0.65, reflections: 0, diffuse: 1, density: 0.8, diffusion: 0.75 }

    // The old default output gain was 0.7; the engines differ by -0.14 dB at the default Decay and Size.
    expect(Number(fieldsOf(migrateReverbParamsV1(defaults)).diffuse)).toBeCloseTo(0.7, 1)
    expect(fieldsOf(migrateReverbParamsV1({ ...defaults, diffuse: 1, density: 1, diffusion: 1 })).diffuse).toBe(1)
  })

  test('the Diffuse it folds into follows what the old engine did to the tail', () => {
    const diffuse = (old: Record<string, JsonValue>) => Number(fieldsOf(migrateReverbParamsV1({ ...version1, reflections: 0, ...old })).diffuse)

    expect(diffuse({ reflections: 0.2 })).toBeLessThan(diffuse({}))
    expect(diffuse({ reflections: 0.2, reflectionSpin: false })).toBeCloseTo(diffuse({}), 12)
    expect(diffuse({ stereoWidth: 2 })).toBeGreaterThan(diffuse({ stereoWidth: 1 }))
    expect(diffuse({ stereoWidth: 0 })).toBeLessThan(diffuse({ stereoWidth: 1 }))
    expect(diffuse({ decaySec: 0.5 })).toBeLessThan(diffuse({ decaySec: 0.5, size: 0 }))
  })

  test('the old in-loop cuts become shelves with the loss they cost and the input cuts start open', () => {
    const flat = fieldsOf(migrateReverbParamsV1(version1))

    expect(flat).toMatchObject({ lowCutHz: 20, highCutHz: 20000, lowShelfOn: false, highShelfOn: false, lowShelfDb: 0, highShelfDb: 0 })
    const cut = fieldsOf(migrateReverbParamsV1({ ...version1, lowCutHz: 300, highCutHz: 4000 }))

    expect(cut).toMatchObject({ lowCutHz: 20, highCutHz: 20000, lowShelfOn: true, highShelfOn: true, lowShelfHz: 300, highShelfHz: 4000 })
    expect(cut.highShelfDb).toBeLessThan(0)
    expect(cut.highShelfDb).toBeGreaterThanOrEqual(-24)
  })

  test('a diffusion cut counts like an in-loop cut and the stricter of each pair wins', () => {
    const migrated = fieldsOf(migrateReverbParamsV1({ ...version1, lowCutHz: 100, diffusionLowCutHz: 400, highCutHz: 9000, diffusionHighCutHz: 6000 }))

    expect(migrated).toMatchObject({ lowShelfHz: 400, highShelfHz: 6000, lowShelfOn: true, highShelfOn: true })
  })

  test('a shorter decay costs the cut relatively less per trip, so its shelf is shallower', () => {
    const shelf = (decaySec: number) => Number(fieldsOf(migrateReverbParamsV1({ ...version1, decaySec, highCutHz: 4000 })).highShelfDb)

    expect(shelf(0.3)).toBeGreaterThan(shelf(12))
  })

  test('Width keeps the left/right correlation of the old crossfeed and never goes anti-phase', () => {
    const correlation = (width: number) => (1 - width ** 2) / (1 + width ** 2)
    const correlationAt = (degrees: number) => Math.cos(Math.PI / 2 * degrees / 120)

    for (const width of [0, 0.25, 0.5, 0.75, 1]) expect(correlationAt(migrateReverbStereoWidthV1(width))).toBeCloseTo(correlation(width), 12)

    expect(migrateReverbStereoWidthV1(1)).toBeCloseTo(120, 12)
    expect(migrateReverbStereoWidthV1(0)).toBe(0)
    expect(migrateReverbStereoWidthV1(2)).toBeCloseTo(120, 12)
  })

  test('a wrapped envelope migrates its state and leaves the version stamp to the caller', () => {
    const migrated = migrateReverbParamsV1({ version: 1, state: version1 })

    expect(fieldsOf(migrated).version).toBe(1)
    expect(fieldsOf(fieldsOf(migrated).state).density).toBe('sparse')
  })

  test('migrates stored rows through the registry and normalizes to a valid state', () => {
    const normalized = normalizeAudioEffect('reverb', migrateAudioEffectParams('reverb', version1, 1)).params

    expect(normalized).toMatchObject({ density: 'sparse', decaySec: 3, stereoWidth: 120 })
    expect(Object.keys(normalized)).toEqual(Object.keys(createDefaultReverbParams()))
  })

  test('rescales a recorded Width automation point through the versioning table', () => {
    const rescale = AUDIO_EFFECT_PARAMS_VERSIONING.parameterValues.reverb?.[1]?.['reverb.stereoWidth']

    expect(rescale?.(0.5)).toBeCloseTo(migrateReverbStereoWidthV1(0.5), 12)
  })

  test('passes non-objects through', () => {
    expect(migrateReverbParamsV1(null)).toBeNull()
  })
})
