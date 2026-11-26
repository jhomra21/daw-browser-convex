import { expect, test } from 'bun:test'
import { migrateAudioEffectParams } from './audio-effect-param-versions'
import { createDefaultLoFiParams, normalizeLoFiParamsEnvelope } from './effects-params'
import { migrateLoFiParamsV1 } from './lofi-params-migration'

const v1 = (sampleRateRatio: number) => ({
  version: 1,
  state: { enabled: true, bitDepth: 8, sampleRateRatio, jitter: 0.2, noiseDb: -60, quantization: 'floor', dither: 'triangular', mix: 0.7, seed: 9 },
})

test('a version 1 ratio becomes Hz at 48 kHz and keeps every other setting', () => {
  const migrated = normalizeLoFiParamsEnvelope(migrateLoFiParamsV1(v1(0.25))).state

  expect(migrated.sampleRateHz).toBe(12000)
  expect(migrated).toMatchObject({ bitDepth: 8, jitter: 0.2, noiseDb: -60, quantization: 'floor', dither: 'triangular', mix: 0.7, seed: 9 })
  expect(migrated).toMatchObject({ preFilter: false, postFilter: false, dcCorrection: false })
})

test('ratio 1 becomes the top of the range so no host rate drops samples', () => {
  expect(normalizeLoFiParamsEnvelope(migrateLoFiParamsV1(v1(1))).state.sampleRateHz).toBe(createDefaultLoFiParams().sampleRateHz)
})

test('the smallest ratio stays inside the range and unwrapped params migrate too', () => {
  expect(normalizeLoFiParamsEnvelope(migrateLoFiParamsV1(v1(0.01))).state.sampleRateHz).toBe(480)
  expect(migrateLoFiParamsV1({ ...v1(0.5).state })).toMatchObject({ sampleRateHz: 24000 })
})

test('stored version 1 params migrate through the version table', () => {
  expect(normalizeLoFiParamsEnvelope(migrateAudioEffectParams('lofi', v1(0.5), 1)).state.sampleRateHz).toBe(24000)
  expect(normalizeLoFiParamsEnvelope(migrateAudioEffectParams('lofi', v1(0.5), 2)).state.sampleRateHz).toBe(96000)
})
