import { describe, expect, test } from 'bun:test'
import {
  createSrcImpulseFixture,
  createSrcStereoIsolationFixture,
  createSrcToneFixture,
  measureIsolationDb,
  measureSrcImpulse,
  measureStereoCorrelation,
  measureToneAmplitude,
  sampleRateConversionCandidates,
} from './sample-rate-characterization'

describe('sample-rate conversion fixtures and metrics', () => {
  test('creates deterministic impulse, tone, and stereo isolation fixtures', () => {
    expect(Array.from(createSrcImpulseFixture(5, 2))).toEqual([0, 0, 1, 0, 0])
    expect(createSrcToneFixture(8, 1_000, 48_000)).toEqual(createSrcToneFixture(8, 1_000, 48_000))
    const stereo = createSrcStereoIsolationFixture(48, 48_000)
    expect(stereo[0].some((sample) => sample !== 0)).toBe(true)
    expect(stereo[1].every((sample) => sample === 0)).toBe(true)
  })

  test('measures tone gain, impulse ringing and stereo isolation', () => {
    const tone = createSrcToneFixture(48_000, 1_000, 48_000)
    expect(measureToneAmplitude(tone, 1_000, 48_000)).toBeCloseTo(1, 5)
    const impulse = measureSrcImpulse(new Float32Array([0.1, 1, -0.2]), 1)
    expect(impulse.peak).toBe(1)
    expect(impulse.preRingingPeak).toBeCloseTo(0.1)
    expect(impulse.postRingingPeak).toBeCloseTo(0.2)
    expect(impulse.phaseDelayFrames).toBe(0)
    expect(measureStereoCorrelation(tone, tone)).toBeCloseTo(1)
    expect(measureIsolationDb(tone, new Float32Array(tone.length))).toBe(Number.NEGATIVE_INFINITY)
  })
})

describe('sample-rate conversion report schema', () => {
  test('reports absent candidate implementations without claiming benchmarks', () => {
    expect(sampleRateConversionCandidates).toHaveLength(3)
    expect(sampleRateConversionCandidates.every((candidate) =>
      candidate.status === 'not-evaluated'
      && candidate.reason.includes('Dependency')
      && candidate.reason.includes('license'))).toBe(true)
  })
})
