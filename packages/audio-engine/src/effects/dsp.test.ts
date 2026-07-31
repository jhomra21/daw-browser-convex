import { describe, expect, test } from 'bun:test'
import { configureEqNodeChannels, createSaturatorCurve, getEqTopologySignature, resolveDelayTimeSec, resolveEqChannelCount } from './dsp'
import { createDefaultDelayParams, createDefaultReverbParams, normalizeDelayParams, normalizeEqParams, normalizeReverbParams } from '@daw-browser/shared'

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

describe('reverb parameter normalization', () => {
  test('preserves the canonical defaults', () => {
    const defaults = createDefaultReverbParams()
    expect(defaults.reflectionSpin).toBe(true)
    expect(defaults.reflectionModAmountMs).toBe(17.5)
    expect(defaults.reflectionModRateHz).toBe(0.3)
    expect(defaults.reflectionShape).toBe(0.5)
    expect(defaults.diffuse).toBe(1)
  })

  test('clamps the canonical control ranges', () => {
    const normalized = normalizeReverbParams({
      reflectionModAmountMs: 50,
      reflectionModRateHz: 0,
      reflectionShape: 2,
      diffuse: -1,
    })
    expect(normalized.reflectionModAmountMs).toBe(25)
    expect(normalized.reflectionModRateHz).toBe(0.01)
    expect(normalized.reflectionShape).toBe(1)
    expect(normalized.diffuse).toBe(0)
  })
})
