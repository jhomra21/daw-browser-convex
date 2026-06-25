import { describe, expect, test } from 'bun:test'
import { addEarlyReflectionTaps, configureEqNodeChannels, createReverbImpulseRenderInfo, createSaturatorCurve, getEqTopologySignature, resolveDelayTimeSec, resolveEqChannelCount } from './dsp'
import { getAppliedReverbSignature, getReverbImpulseBucket, getReverbImpulseSignature, getReverbTopologySignature } from './reverb-signature'
import { createDefaultDelayParams, createDefaultReverbParams, normalizeDelayParams, normalizeEqParams, normalizeReverbParams, REVERB_DECAY_SEC_MAX } from '@daw-browser/shared'

describe('EQ channel mode', () => {
  test('uses one channel for mono EQ nodes', () => {
    const node: Pick<AudioNode, 'channelCount' | 'channelCountMode' | 'channelInterpretation'> = {
      channelCount: 2,
      channelCountMode: 'max',
      channelInterpretation: 'speakers',
    }

    configureEqNodeChannels(node, 'mono', 2)

    expect(node.channelCountMode).toBe('explicit')
    expect(node.channelInterpretation).toBe('speakers')
    expect(node.channelCount).toBe(1)
  })

  test('clamps stereo EQ nodes to available channels', () => {
    expect(resolveEqChannelCount('stereo', 0)).toBe(1)
    expect(resolveEqChannelCount('stereo', 1)).toBe(1)
    expect(resolveEqChannelCount('stereo', 4)).toBe(2)
  })

  test('includes channel mode in EQ topology signature', () => {
    const stereo = normalizeEqParams({ channelMode: 'stereo' })
    const mono = normalizeEqParams({ channelMode: 'mono' })

    expect(getEqTopologySignature(mono)).not.toBe(getEqTopologySignature(stereo))
  })

  test('omits channel mode from empty EQ topology signatures', () => {
    const mono = normalizeEqParams({
      channelMode: 'mono',
      bands: [{ id: 'b1', type: 'peaking', frequency: 1000, gainDb: 0, q: 1, enabled: false }],
    })

    expect(getEqTopologySignature(mono)).toBe('')
  })
})

describe('saturator and delay helpers', () => {
  test('creates finite distinct saturator curves', () => {
    const soft = createSaturatorCurve('soft')
    const hard = createSaturatorCurve('hard')
    expect(soft.length).toBe(4096)
    expect(Array.from(soft).every((value) => Number.isFinite(value) && value >= -1 && value <= 1)).toBe(true)
    expect(soft[3000]).not.toBe(hard[3000])
  })

  test('resolves sync delay time and clamps feedback', () => {
    expect(resolveDelayTimeSec(createDefaultDelayParams(), 120)).toBe(0.25)
    expect(normalizeDelayParams({ feedback: 2 }).feedback).toBe(0.95)
  })
})

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
