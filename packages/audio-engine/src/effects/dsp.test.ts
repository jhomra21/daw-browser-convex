import { describe, expect, test } from 'bun:test'
import { addEarlyReflectionTaps, createReverbImpulseRenderInfo } from './dsp'
import { getAppliedReverbSignature, getReverbImpulseBucket, getReverbImpulseSignature, getReverbTopologySignature } from './reverb-signature'
import { createDefaultReverbParams, normalizeReverbParams, REVERB_DECAY_SEC_MAX } from '@daw-browser/shared'

describe('reverb impulse rendering', () => {
  test('uses shared maximum decay for impulse buckets', () => {
    const bucket = getReverbImpulseBucket(REVERB_DECAY_SEC_MAX + 10)

    expect(bucket.bucketSec).toBe(REVERB_DECAY_SEC_MAX)
  })

  test('includes impulse-shaping params in the render signature', () => {
    const base = normalizeReverbParams({ decaySec: 2, size: 0.5, density: 0.5, diffusion: 0.5, diffusionLowCutHz: 120, diffusionHighCutHz: 12000, reflections: 0.5 })
    const denser = normalizeReverbParams({ ...base, density: 0.8 })
    const lowCut = normalizeReverbParams({ ...base, diffusionLowCutHz: 830 })
    const darker = normalizeReverbParams({ ...base, diffusionHighCutHz: 8000 })
    const reflections = normalizeReverbParams({ ...base, reflections: 0.7 })
    const reflectionSpin = normalizeReverbParams({ ...base, reflectionSpin: false })
    const reflectionAmount = normalizeReverbParams({ ...base, reflectionModAmountMs: 4 })
    const reflectionRate = normalizeReverbParams({ ...base, reflectionModRateHz: 1.2 })
    const reflectionShape = normalizeReverbParams({ ...base, reflectionShape: 0.2 })
    const diffuse = normalizeReverbParams({ ...base, diffuse: 0.4 })

    const baseSignature = createReverbImpulseRenderInfo(48000, base).signature

    expect(createReverbImpulseRenderInfo(48000, denser).signature).not.toBe(baseSignature)
    expect(createReverbImpulseRenderInfo(48000, lowCut).signature).not.toBe(baseSignature)
    expect(createReverbImpulseRenderInfo(48000, darker).signature).not.toBe(baseSignature)
    expect(createReverbImpulseRenderInfo(48000, reflections).signature).not.toBe(baseSignature)
    expect(createReverbImpulseRenderInfo(48000, reflectionSpin).signature).not.toBe(baseSignature)
    expect(createReverbImpulseRenderInfo(48000, reflectionAmount).signature).not.toBe(baseSignature)
    expect(createReverbImpulseRenderInfo(48000, reflectionRate).signature).not.toBe(baseSignature)
    expect(createReverbImpulseRenderInfo(48000, reflectionShape).signature).not.toBe(baseSignature)
    expect(createReverbImpulseRenderInfo(48000, diffuse).signature).not.toBe(baseSignature)
  })

  test('excludes inactive reflection spin params from the impulse render signature', () => {
    const disabledReflections = normalizeReverbParams({ reflections: 0 })
    const disabledSpin = normalizeReverbParams({ reflections: 0.5, reflectionSpin: false })

    expect(createReverbImpulseRenderInfo(48000, { ...disabledReflections, reflectionModAmountMs: 4 }).signature)
      .toBe(createReverbImpulseRenderInfo(48000, disabledReflections).signature)
    expect(createReverbImpulseRenderInfo(48000, { ...disabledSpin, reflectionModRateHz: 1.2 }).signature)
      .toBe(createReverbImpulseRenderInfo(48000, disabledSpin).signature)
  })

  test('includes size in the impulse render signature within the same decay bucket', () => {
    const base = normalizeReverbParams({ decaySec: 2, size: 0.5 })
    const resized = normalizeReverbParams({ ...base, size: 0.52 })

    const baseInfo = createReverbImpulseRenderInfo(48000, base)
    const resizedInfo = createReverbImpulseRenderInfo(48000, resized)

    expect(resizedInfo.bucketIndex).toBe(baseInfo.bucketIndex)
    expect(resizedInfo.signature).not.toBe(baseInfo.signature)
    expect(getReverbImpulseSignature(resized)).not.toBe(getReverbImpulseSignature(base))
  })

  test('excludes input filters from the impulse render signature', () => {
    const base = normalizeReverbParams({ decaySec: 2, size: 0.5, density: 0.5, diffusion: 0.5, lowCutHz: 20, highCutHz: 20000 })
    const inputFiltered = normalizeReverbParams({ ...base, lowCutHz: 830, highCutHz: 8000 })

    expect(createReverbImpulseRenderInfo(48000, inputFiltered).signature).toBe(createReverbImpulseRenderInfo(48000, base).signature)
    expect(getReverbImpulseSignature(inputFiltered)).toBe(getReverbImpulseSignature(base))
  })

  test('includes input filters in the applied reverb signature', () => {
    const base = normalizeReverbParams({ decaySec: 2, lowCutHz: 20, highCutHz: 20000 })
    const inputFiltered = normalizeReverbParams({ ...base, lowCutHz: 830, highCutHz: 8000 })

    expect(getAppliedReverbSignature(inputFiltered)).not.toBe(getAppliedReverbSignature(base))
  })

  test('excludes reflections from the topology signature', () => {
    const base = normalizeReverbParams({ reflections: 0 })
    const reflections = normalizeReverbParams({
      ...base,
      reflections: 1,
      reflectionSpin: false,
      reflectionModAmountMs: 2,
      reflectionModRateHz: 1,
      reflectionShape: 0.25,
      diffuse: 0.5,
    })

    expect(getReverbTopologySignature(reflections)).toBe(getReverbTopologySignature(base))
  })

  test('normalizes early reflection defaults and ranges', () => {
    const defaults = createDefaultReverbParams()
    const normalized = normalizeReverbParams({
      reflectionModAmountMs: 50,
      reflectionModRateHz: 0,
      reflectionShape: 2,
      diffuse: -1,
    })

    expect(defaults.reflectionSpin).toBe(true)
    expect(defaults.reflectionModAmountMs).toBe(17.5)
    expect(defaults.reflectionModRateHz).toBe(0.3)
    expect(defaults.reflectionShape).toBe(0.5)
    expect(defaults.diffuse).toBe(1)
    expect(normalized.reflectionModAmountMs).toBe(25)
    expect(normalized.reflectionModRateHz).toBe(0.01)
    expect(normalized.reflectionShape).toBe(1)
    expect(normalized.diffuse).toBe(0)
  })

  test('adds deterministic early reflection taps only when reflections are enabled', () => {
    const dry = new Float32Array(2048)
    const wet = new Float32Array(2048)
    const disabled = normalizeReverbParams({ reflections: 0, size: 0.5, reflectionSpin: false })
    const enabled = normalizeReverbParams({ reflections: 1, size: 0.5, reflectionSpin: false, reflectionShape: 0.5 })

    addEarlyReflectionTaps(dry, 48000, disabled, 0)
    addEarlyReflectionTaps(wet, 48000, enabled, 0)

    expect(Array.from(dry).every((value) => value === 0)).toBe(true)
    expect(wet.some((value) => value !== 0)).toBe(true)
    expect(wet[370]).toBeCloseTo(0.34, 5)
  })
})
