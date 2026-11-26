import { describe, expect, test } from 'bun:test'
import { configureEqNodeChannels, getEqTopologySignature, resolveDelayTimeSec, resolveEqChannelCount } from './dsp'
import { createDefaultDelayParams, createDefaultReverbParams, evaluateSaturatorCurvePoint, normalizeDelayParams, normalizeEqParams, normalizeReverbParams } from '@daw-browser/shared'

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
      bands: normalizeEqParams({}).bands.map((band) => ({ ...band, enabled: false })),
    })

    expect(getEqTopologySignature(mono)).toBe('')
  })
})

describe('saturator and delay helpers', () => {
  test('evaluates finite distinct saturator curves', () => {
    const curves = ['soft', 'medium', 'hard', 'clip', 'analog', 'sine', 'bass', 'fold', 'warp'] as const
    const at = (curve: (typeof curves)[number]) => evaluateSaturatorCurvePoint(curve, 0.7)

    expect(curves.every((curve) => Number.isFinite(at(curve)) && Math.abs(at(curve)) <= 1.5)).toBe(true)
    // Sine and Fold share one shape until the input passes pi/2.
    expect(new Set(curves.map(at)).size).toBe(curves.length - 1)
  })

  test('resolves sync delay time and clamps feedback', () => {
    expect(resolveDelayTimeSec(createDefaultDelayParams(), 120)).toBe(0.25)
    expect(normalizeDelayParams({ feedback: 2 }).feedback).toBe(1)
  })
})

describe('reverb parameter normalization', () => {
  test('preserves the canonical defaults', () => {
    const defaults = createDefaultReverbParams()
    expect(defaults.reflectionSpin).toBe(true)
    expect(defaults.reflectionModAmountMs).toBe(17.5)
    expect(defaults.reflectionModRateHz).toBe(0.3)
    expect(defaults['reflectionShape']).toBe(0.5)
    expect(defaults.diffuse).toBe(0.7)
    expect(defaults.reflections).toBe(0.25)
  })

  test('clamps the canonical control ranges', () => {
    const normalized = normalizeReverbParams({
      reflectionModAmountMs: 50,
      reflectionModRateHz: 0,
      'reflectionShape': 2,
      diffuse: -1,
    })

    expect(normalized.reflectionModAmountMs).toBe(25)
    expect(normalized.reflectionModRateHz).toBe(0.01)
    expect(normalized['reflectionShape']).toBe(1)
    expect(normalized.diffuse).toBe(0)
  })
})
