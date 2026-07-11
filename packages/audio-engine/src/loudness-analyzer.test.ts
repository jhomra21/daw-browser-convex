import { describe, expect, test } from 'bun:test'
import {
  LOUDNESS_HISTOGRAM_BIN_COUNT,
  addLoudnessEnergy,
  analyzeLoudness,
  createLoudnessEnergyHistogram,
  gatedHistogramLoudnessRange,
  gatedHistogramMean,
} from './loudness-analyzer'

const ITU_R_BS_1770_4_EQUATION_2_OFFSET_LU = -0.691
const scalarLoudnessFromMeanSquare = (meanSquare: number) =>
  ITU_R_BS_1770_4_EQUATION_2_OFFSET_LU + 10 * Math.log10(meanSquare)
const energyFromLoudness = (loudness: number) =>
  10 ** ((loudness - ITU_R_BS_1770_4_EQUATION_2_OFFSET_LU) / 10)
const loudnessFromEnergy = (energy: number) =>
  ITU_R_BS_1770_4_EQUATION_2_OFFSET_LU + 10 * Math.log10(energy)

const exactGatedMean = (energies: readonly number[], relativeOffset: number) => {
  const absolute = energies.filter((energy) => loudnessFromEnergy(energy) >= -70)
  if (absolute.length === 0) return null
  const mean = absolute.reduce((sum, energy) => sum + energy, 0) / absolute.length
  const threshold = energyFromLoudness(Math.max(-70, loudnessFromEnergy(mean) + relativeOffset))
  const gated = absolute.filter((energy) => energy >= threshold)
  return gated.length === 0 ? null : gated.reduce((sum, energy) => sum + energy, 0) / gated.length
}

const percentile = (sorted: readonly number[], probability: number) => {
  const position = probability * (sorted.length - 1)
  const lower = Math.floor(position)
  const fraction = position - lower
  return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * fraction
}

const exactLoudnessRange = (energies: readonly number[]) => {
  const absolute = energies.filter((energy) => loudnessFromEnergy(energy) >= -70)
  if (absolute.length === 0) return null
  const mean = absolute.reduce((sum, energy) => sum + energy, 0) / absolute.length
  const threshold = Math.max(-70, loudnessFromEnergy(mean) - 20)
  const gated = absolute
    .map(loudnessFromEnergy)
    .filter((loudness) => loudness >= threshold)
    .sort((left, right) => left - right)
  return gated.length === 0 ? null : percentile(gated, 0.95) - percentile(gated, 0.1)
}

const buffer = (channels: readonly Float32Array[], sampleRate: number) => ({
  numberOfChannels: channels.length,
  length: channels[0]?.length ?? 0,
  sampleRate,
  getChannelData(channel: number) {
    const samples = channels[channel]
    if (!samples) throw new Error('Missing channel')
    return samples
  },
})

describe('BS.1770-4 / EBU R128 loudness analysis', () => {
  test('matches the calibrated 1 kHz sine level at standard sample rates', () => {
    for (const sampleRate of [44_100, 48_000, 96_000]) {
      const amplitude = 10 ** (-18 / 20)
      const samples = Float32Array.from(
        { length: sampleRate * 4 },
        (_, frame) => amplitude * Math.sin(2 * Math.PI * 1_000 * frame / sampleRate),
      )
      const analysis = analyzeLoudness(buffer([samples], sampleRate))
      expect(analysis.integratedLufs).not.toBeNull()
      expect(analysis.integratedLufs ?? 0).toBeCloseTo(-21.034, 1)
      expect(analysis.reference).toBe('bs1770-equations')
    }
  })

  test('ITU-R BS.1770-4 Equation 2 scalar energy reference is independently reproduced', () => {
    const amplitude = 10 ** (-18 / 20)
    const unweightedSineMeanSquare = amplitude * amplitude / 2
    expect(scalarLoudnessFromMeanSquare(unweightedSineMeanSquare)).toBeCloseTo(-21.701, 2)
  })

  test('uses fixed rolling sample storage for a long-duration input model', () => {
    const sampleRate = 8_000
    const samples = Float32Array.from(
      { length: sampleRate * 60 },
      (_, frame) => 0.1 * Math.sin(2 * Math.PI * 1_000 * frame / sampleRate),
    )
    let channelReads = 0
    const analysis = analyzeLoudness({
      numberOfChannels: 1,
      length: samples.length,
      sampleRate,
      getChannelData() {
        channelReads += 1
        return samples
      },
    })
    expect(channelReads).toBe(2)
    expect(analysis.momentaryLufs).toHaveLength(597)
    expect(analysis.shortTermLufs).toHaveLength(58)
  })

  test('matches exact two-pass gating for varied and gated programs', () => {
    const programs = [
      [-24, -23.7, -23.2, -22.5, -22, -21.6, -21.1, -20.5],
      [-65, -55, -45, -30, -24, -23.5, -23, -22.5, -22],
      Array.from({ length: 600 }, (_, index) => -58 + 36 * Math.sin(index * 0.071)),
      Array.from({ length: 1_000 }, (_, index) => index % 7 === 0 ? -55 : -18 - (index % 31) * 0.17),
    ]
    for (const program of programs) {
      const energies = program.map(energyFromLoudness)
      const histogram = createLoudnessEnergyHistogram()
      for (const energy of energies) addLoudnessEnergy(histogram, energy)
      const exactIntegrated = exactGatedMean(energies, -10)
      const histogramIntegrated = gatedHistogramMean(histogram, -70, -10)
      expect(exactIntegrated).not.toBeNull()
      expect(histogramIntegrated).not.toBeNull()
      expect(Math.abs(
        loudnessFromEnergy(histogramIntegrated ?? 0) - loudnessFromEnergy(exactIntegrated ?? 0),
      )).toBeLessThanOrEqual(0.02)

      const exactRange = exactLoudnessRange(energies)
      const histogramRange = gatedHistogramLoudnessRange(histogram, -70, -20)
      expect(exactRange).not.toBeNull()
      expect(histogramRange).not.toBeNull()
      expect(Math.abs((histogramRange ?? 0) - (exactRange ?? 0))).toBeLessThanOrEqual(0.1)
    }
  })

  test('keeps fixed histogram memory for more than 24 hours of blocks', () => {
    const histogram = createLoudnessEnergyHistogram()
    const blocks = 24 * 60 * 60 * 10 + 1
    for (let block = 0; block < blocks; block += 1) {
      addLoudnessEnergy(histogram, energyFromLoudness(-30 + block % 20))
    }
    expect(histogram.counts).toHaveLength(LOUDNESS_HISTOGRAM_BIN_COUNT)
    expect(histogram.energySums).toHaveLength(LOUDNESS_HISTOGRAM_BIN_COUNT)
    expect(histogram.counts.reduce((sum, count) => sum + count, 0)).toBe(blocks)
  })

  test('histogram silence remains ungated', () => {
    const histogram = createLoudnessEnergyHistogram()
    for (let index = 0; index < 10_000; index += 1) addLoudnessEnergy(histogram, 0)
    expect(gatedHistogramMean(histogram, -70, -10)).toBeNull()
    expect(gatedHistogramLoudnessRange(histogram, -70, -20)).toBeNull()
  })

  test('types silence as null and negative-infinity block loudness', () => {
    const analysis = analyzeLoudness(buffer([new Float32Array(48_000 * 4)], 48_000))
    expect(analysis.integratedLufs).toBeNull()
    expect(analysis.loudnessRangeLu).toBeNull()
    expect(analysis.truePeakDbtp).toBeNull()
    expect(analysis.momentaryLufs.every((value) => value === Number.NEGATIVE_INFINITY)).toBe(true)
  })

  test('gates quiet segments and computes a bounded loudness range', () => {
    const sampleRate = 48_000
    const samples = Float32Array.from({ length: sampleRate * 8 }, (_, frame) => {
      const amplitude = frame < sampleRate * 4 ? 10 ** (-18 / 20) : 10 ** (-60 / 20)
      return amplitude * Math.sin(2 * Math.PI * 1_000 * frame / sampleRate)
    })
    const analysis = analyzeLoudness(buffer([samples], sampleRate))
    expect(analysis.integratedLufs ?? -100).toBeGreaterThan(-22)
    expect(analysis.integratedLufs ?? 0).toBeLessThan(-20.9)
    expect(analysis.loudnessRangeLu).not.toBeNull()
  })

  test('honors cancellation', () => {
    const controller = new AbortController()
    controller.abort()
    expect(() => analyzeLoudness(buffer([new Float32Array(48_000)], 48_000), controller.signal)).toThrow()
  })
})
