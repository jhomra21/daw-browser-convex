import { describe, expect, test } from 'bun:test'
import {
  createEdgeCaseFixture,
  createImpulseFixture,
  createOppositePolarityFixture,
  createSeededNoiseFixture,
  createSilenceFixture,
  createSineFixture,
  createStepFixture,
  createStereoIsolationFixture,
  createSweepFixture,
  measureAudio,
  measureChannelLeakageDb,
  measureFrameOffset,
} from './dsp-characterization'

describe('DSP characterization fixtures and metrics', () => {
  test('matches hand-computable silence, impulse, step, and sine metrics', () => {
    expect(measureAudio(createSilenceFixture(4))).toEqual({
      peak: 0,
      rms: 0,
      dcOffset: [0],
      containsNonFiniteSamples: false,
    })
    expect(measureAudio(createImpulseFixture(4))).toEqual({
      peak: 1,
      rms: 0.5,
      dcOffset: [0.25],
      containsNonFiniteSamples: false,
    })
    expect(measureAudio(createStepFixture(4, -0.5))).toEqual({
      peak: 0.5,
      rms: 0.5,
      dcOffset: [-0.5],
      containsNonFiniteSamples: false,
    })
    expect(measureAudio(createSineFixture(4, 1, 4)).rms).toBeCloseTo(Math.SQRT1_2)
  })

  test('produces known seeded noise and sweep samples', () => {
    const noise = createSeededNoiseFixture(4, 42)[0]
    expect(noise[0]).toBeCloseTo(-0.49530965)
    expect(noise[1]).toBeCloseTo(-0.8237499)
    expect(noise[2]).toBeCloseTo(0.1545624)
    expect(noise[3]).toBeCloseTo(-0.55489147)

    const sweep = createSweepFixture(4, 1, 4, 8)[0]
    expect(sweep[0]).toBeCloseTo(Math.SQRT1_2)
    expect(sweep[1]).toBeCloseTo(Math.SQRT1_2)
    expect(sweep[2]).toBeCloseTo(-1)
    expect(sweep[3]).toBeCloseTo(1)
  })

  test('divides channel DC offset by finite samples only', () => {
    expect(measureAudio([new Float32Array([1, Number.NaN, 3])])).toEqual({
      peak: 3,
      rms: Math.sqrt(5),
      dcOffset: [2],
      containsNonFiniteSamples: true,
    })
    expect(measureAudio([new Float32Array([Number.NaN, Number.POSITIVE_INFINITY])]).dcOffset).toEqual([0])
  })

  test('measures correlated offsets and returns null for indeterminate signals', () => {
    expect(measureFrameOffset(new Float32Array([0, 1, 0]), new Float32Array([0, 0, 1]), 2)).toBe(1)
    expect(measureFrameOffset(new Float32Array([0, 1, 0]), new Float32Array([0, 0, -1]), 2)).toBe(1)
    expect(measureFrameOffset(new Float32Array(3), new Float32Array(3), 2)).toBeNull()
    expect(measureFrameOffset(new Float32Array([1, 1]), new Float32Array([1, -1]), 0)).toBeNull()
  })

  test('covers stereo, polarity, non-finite, and leakage baselines', () => {
    const isolation = createStereoIsolationFixture(4)
    expect(measureAudio(isolation).dcOffset).toEqual([0.25, 0])
    expect(createOppositePolarityFixture(2)[1]).toEqual(new Float32Array([-1, 1]))
    expect(measureAudio(createEdgeCaseFixture()).containsNonFiniteSamples).toBe(true)
    expect(measureChannelLeakageDb(1, 0)).toBe(Number.NEGATIVE_INFINITY)
    expect(measureChannelLeakageDb(1, 0.1)).toBeCloseTo(-20)
  })
})
