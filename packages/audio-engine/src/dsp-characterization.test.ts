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
  characterizeAnalyzerFrame,
  measureReverbCharacterization,
  ANALYZER_BIN_COUNT,
  ANALYZER_FFT_SIZE,
  ANALYZER_SMOOTHING,
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

  test('characterizes analyzer silence as finite bounded zero output', () => {
    const result = characterizeAnalyzerFrame(createSilenceFixture(ANALYZER_FFT_SIZE, 2))

    expect(result.magnitude.length).toBe(ANALYZER_BIN_COUNT)
    expect(Array.from(result.magnitude).every((value) => value === 0)).toBe(true)
    expect(Array.from(result.normalized).every((value) => value === 0)).toBe(true)
    expect(Array.from(result.normalized).every((value) => value >= 0 && value <= 1)).toBe(true)
  })

  test('peaks a bin-centered sine at the expected linear bin', () => {
    const bin = 32
    const fixture = createSineFixture(ANALYZER_FFT_SIZE, bin, ANALYZER_FFT_SIZE)
    const result = characterizeAnalyzerFrame(fixture)
    const peakBin = result.magnitude.reduce(
      (best, value, index) => value > result.magnitude[best] ? index : best,
      0,
    )

    expect(Math.abs(peakBin - bin)).toBeLessThanOrEqual(1)
    expect(result.magnitude[peakBin]).toBeGreaterThan(0.35)
    expect(result.decibels[peakBin]).toBe(-30)
  })

  test('uses speakers downmix and preserves isolation polarity', () => {
    const left = createSineFixture(ANALYZER_FFT_SIZE, 24, ANALYZER_FFT_SIZE)[0]
    const stereoLeft = [left, new Float32Array(ANALYZER_FFT_SIZE)] as const
    const opposite = [left, left.map((sample) => -sample)] as const
    const mono = characterizeAnalyzerFrame([left])
    const downmixed = characterizeAnalyzerFrame(stereoLeft)
    const cancelled = characterizeAnalyzerFrame(opposite)

    expect(downmixed.magnitude[24]).toBeCloseTo(mono.magnitude[24] / 2, 5)
    expect(cancelled.magnitude.every((value) => value === 0)).toBe(true)
  })

  test('applies explicit previous-frame smoothing without hidden state', () => {
    const fixture = createSineFixture(ANALYZER_FFT_SIZE, 16, ANALYZER_FFT_SIZE)
    const current = characterizeAnalyzerFrame(fixture)
    const previous = new Float32Array(ANALYZER_BIN_COUNT)
    previous[16] = 1
    const smoothed = characterizeAnalyzerFrame(fixture, previous)

    expect(smoothed.magnitude[16]).toBeCloseTo(
      ANALYZER_SMOOTHING + (1 - ANALYZER_SMOOTHING) * current.magnitude[16],
      5,
    )
    expect(characterizeAnalyzerFrame(fixture)).toEqual(current)
    expect(characterizeAnalyzerFrame(fixture, previous)).toEqual(smoothed)
  })

  test('measures quantitative reverb onset, decay, early energy, and stereo correlation', () => {
    const length = 4_096
    const left = new Float32Array(length)
    const right = new Float32Array(length)
    left[480] = 1
    right[480] = 0.8
    left[816] = 0.25
    right[816] = -0.2
    for (let frame = 481; frame < 2_400; frame += 1) {
      const decay = Math.pow(0.5, (frame - 480) / 480)
      left[frame] += decay * 0.01
      right[frame] += decay * -0.008
    }
    const metrics = measureReverbCharacterization([left, right], { earlyWindow: [480, 960] })

    expect(metrics.finite).toBe(true)
    expect(metrics.onsetFrame).toBe(480)
    expect(metrics.earlyReflectionEnergy).toBeGreaterThan(0)
    expect(metrics.decayFrameAtMinus60Db).toBeGreaterThan(1_900)
    expect(metrics.stereoCorrelation).not.toBeNull()
    expect(metrics.stereoCorrelation).toBeLessThan(1)
  })

  test('does not classify a silent channel as measured decorrelation', () => {
    const left = new Float32Array([1, 0, 0, 0])
    const right = new Float32Array(4)

    expect(measureReverbCharacterization([left, right], { earlyWindow: [0, 4] }).stereoCorrelation).toBeNull()
  })
})
