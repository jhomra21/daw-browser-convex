import { scanTruePeak } from './true-peak-scanner'

type LoudnessBuffer = {
  numberOfChannels: number
  length: number
  sampleRate: number
  getChannelData: (channel: number) => Float32Array<ArrayBufferLike>
}

export type LoudnessValue = number | null

export type LoudnessAnalysis = {
  reference: 'bs1770-equations'
  integratedLufs: LoudnessValue
  loudnessRangeLu: LoudnessValue
  momentaryLufs: readonly number[]
  shortTermLufs: readonly number[]
  momentaryMaxLufs: LoudnessValue
  shortTermMaxLufs: LoudnessValue
  truePeak: number
  truePeakDbtp: LoudnessValue
}

export const LOUDNESS_REPORT_SERIES_LIMIT = 4_096
export const LOUDNESS_HISTOGRAM_BIN_COUNT = 9_001
const LOUDNESS_HISTOGRAM_MIN = -70
const LOUDNESS_HISTOGRAM_MAX = 20
const LOUDNESS_HISTOGRAM_STEP = 0.01

export type LoudnessEnergyHistogram = {
  counts: Float64Array
  energySums: Float64Array
}

type BiquadCoefficients = {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

const loudnessFromEnergy = (energy: number) => energy > 0 ? -0.691 + 10 * Math.log10(energy) : Number.NEGATIVE_INFINITY

export const createLoudnessEnergyHistogram = (): LoudnessEnergyHistogram => ({
  counts: new Float64Array(LOUDNESS_HISTOGRAM_BIN_COUNT),
  energySums: new Float64Array(LOUDNESS_HISTOGRAM_BIN_COUNT),
})

const histogramIndex = (loudness: number) => Math.max(
  0,
  Math.min(
    LOUDNESS_HISTOGRAM_BIN_COUNT - 1,
    Math.floor((loudness - LOUDNESS_HISTOGRAM_MIN) / LOUDNESS_HISTOGRAM_STEP),
  ),
)

export const addLoudnessEnergy = (histogram: LoudnessEnergyHistogram, energy: number) => {
  if (!(energy > 0)) return
  const index = histogramIndex(loudnessFromEnergy(energy))
  histogram.counts[index] += 1
  histogram.energySums[index] += energy
}

const histogramTotalsAbove = (histogram: LoudnessEnergyHistogram, thresholdLoudness: number) => {
  const firstWholeBin = Math.min(
    LOUDNESS_HISTOGRAM_BIN_COUNT,
    Math.max(1, Math.ceil((thresholdLoudness - LOUDNESS_HISTOGRAM_MIN) / LOUDNESS_HISTOGRAM_STEP)),
  )
  let count = 0
  let energySum = 0
  for (let index = firstWholeBin; index < LOUDNESS_HISTOGRAM_BIN_COUNT; index += 1) {
    count += histogram.counts[index]
    energySum += histogram.energySums[index]
  }
  return { count, energySum }
}

export const gatedHistogramMean = (
  histogram: LoudnessEnergyHistogram,
  absoluteGate: number,
  relativeOffset: number,
) => {
  const absolute = histogramTotalsAbove(histogram, absoluteGate)
  if (absolute.count === 0) return null
  const relativeGate = loudnessFromEnergy(absolute.energySum / absolute.count) + relativeOffset
  const relative = histogramTotalsAbove(histogram, Math.max(absoluteGate, relativeGate))
  return relative.count === 0 ? null : relative.energySum / relative.count
}

const histogramValueAtRank = (
  histogram: LoudnessEnergyHistogram,
  firstBin: number,
  rank: number,
) => {
  let cumulative = 0
  for (let index = firstBin; index < LOUDNESS_HISTOGRAM_BIN_COUNT; index += 1) {
    const binCount = histogram.counts[index]
    if (rank < cumulative + binCount) {
      const binMinimum = LOUDNESS_HISTOGRAM_MIN + index * LOUDNESS_HISTOGRAM_STEP
      return Math.min(LOUDNESS_HISTOGRAM_MAX, binMinimum + LOUDNESS_HISTOGRAM_STEP / 2)
    }
    cumulative += binCount
  }
  return LOUDNESS_HISTOGRAM_MAX
}

const histogramPercentile = (
  histogram: LoudnessEnergyHistogram,
  firstBin: number,
  count: number,
  probability: number,
) => {
  const position = probability * (count - 1)
  const lower = Math.floor(position)
  const fraction = position - lower
  const lowerValue = histogramValueAtRank(histogram, firstBin, lower)
  const upperValue = histogramValueAtRank(histogram, firstBin, Math.min(lower + 1, count - 1))
  return lowerValue + (upperValue - lowerValue) * fraction
}

export const gatedHistogramLoudnessRange = (
  histogram: LoudnessEnergyHistogram,
  absoluteGate: number,
  relativeOffset: number,
) => {
  const absolute = histogramTotalsAbove(histogram, absoluteGate)
  if (absolute.count === 0) return null
  const relativeGate = loudnessFromEnergy(absolute.energySum / absolute.count) + relativeOffset
  const threshold = Math.max(absoluteGate, relativeGate)
  const firstBin = Math.min(
    LOUDNESS_HISTOGRAM_BIN_COUNT,
    Math.max(1, Math.ceil((threshold - LOUDNESS_HISTOGRAM_MIN) / LOUDNESS_HISTOGRAM_STEP)),
  )
  const gated = histogramTotalsAbove(histogram, threshold)
  if (gated.count === 0) return null
  return histogramPercentile(histogram, firstBin, gated.count, 0.95)
    - histogramPercentile(histogram, firstBin, gated.count, 0.1)
}

const createHighShelf = (sampleRate: number): BiquadCoefficients => {
  const frequency = 1_681.974450955533
  const gainDb = 3.999843853973347
  const q = 0.7071752369554196
  const k = Math.tan(Math.PI * frequency / sampleRate)
  const vh = 10 ** (gainDb / 20)
  const vb = vh ** 0.4996667741545416
  const a0 = 1 + k / q + k * k
  return {
    b0: (vh + vb * k / q + k * k) / a0,
    b1: 2 * (k * k - vh) / a0,
    b2: (vh - vb * k / q + k * k) / a0,
    a1: 2 * (k * k - 1) / a0,
    a2: (1 - k / q + k * k) / a0,
  }
}

const createHighPass = (sampleRate: number): BiquadCoefficients => {
  const frequency = 38.13547087602444
  const q = 0.5003270373238773
  const k = Math.tan(Math.PI * frequency / sampleRate)
  const a0 = 1 + k / q + k * k
  return {
    b0: 1 / a0,
    b1: -2 / a0,
    b2: 1 / a0,
    a1: 2 * (k * k - 1) / a0,
    a2: (1 - k / q + k * k) / a0,
  }
}

type BiquadState = { x1: number; x2: number; y1: number; y2: number }

const filterSample = (input: number, coefficients: BiquadCoefficients, state: BiquadState) => {
  const x = Number.isFinite(input) ? input : 0
  const y = coefficients.b0 * x + coefficients.b1 * state.x1 + coefficients.b2 * state.x2
    - coefficients.a1 * state.y1 - coefficients.a2 * state.y2
  state.x2 = state.x1
  state.x1 = x
  state.y2 = state.y1
  state.y1 = y
  return y
}

const createRollingEnergies = (
  buffer: LoudnessBuffer,
  shelf: BiquadCoefficients,
  highPass: BiquadCoefficients,
  signal?: AbortSignal,
) => {
  const momentaryFrames = Math.max(1, Math.round(buffer.sampleRate * 0.4))
  const momentaryStep = Math.max(1, Math.round(buffer.sampleRate * 0.1))
  const shortTermFrames = Math.max(1, Math.round(buffer.sampleRate * 3))
  const shortTermStep = Math.max(1, Math.round(buffer.sampleRate))
  const capacity = shortTermFrames
  const channelEnergyRings = Array.from({ length: buffer.numberOfChannels }, () => new Float64Array(capacity))
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel))
  const shelfStates: BiquadState[] = Array.from(
    { length: buffer.numberOfChannels },
    () => ({ x1: 0, x2: 0, y1: 0, y2: 0 }),
  )
  const highPassStates: BiquadState[] = Array.from(
    { length: buffer.numberOfChannels },
    () => ({ x1: 0, x2: 0, y1: 0, y2: 0 }),
  )
  const momentarySums = new Float64Array(buffer.numberOfChannels)
  const shortTermSums = new Float64Array(buffer.numberOfChannels)
  const integratedHistogram = createLoudnessEnergyHistogram()
  const shortTermHistogram = createLoudnessEnergyHistogram()
  const momentaryEnergies: number[] = []
  const shortTermEnergies: number[] = []
  let momentaryMaximum = Number.NEGATIVE_INFINITY
  let shortTermMaximum = Number.NEGATIVE_INFINITY

  for (let frame = 0; frame < buffer.length; frame += 1) {
    if ((frame & 4095) === 0) signal?.throwIfAborted()
    const ringIndex = frame % capacity
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const shelved = filterSample(channels[channel][frame], shelf, shelfStates[channel])
      const filtered = filterSample(shelved, highPass, highPassStates[channel])
      const energy = filtered * filtered
      const replaced = channelEnergyRings[channel][ringIndex]
      channelEnergyRings[channel][ringIndex] = energy
      shortTermSums[channel] += energy - replaced
      momentarySums[channel] += energy
      if (frame >= momentaryFrames) {
        const expiredIndex = (frame - momentaryFrames) % capacity
        momentarySums[channel] -= channelEnergyRings[channel][expiredIndex]
      }
    }
    const frameCount = frame + 1
    if (frameCount >= momentaryFrames && (frameCount - momentaryFrames) % momentaryStep === 0) {
      const energy = momentarySums.reduce((sum, value) => sum + value / momentaryFrames, 0)
      addLoudnessEnergy(integratedHistogram, energy)
      momentaryMaximum = Math.max(momentaryMaximum, loudnessFromEnergy(energy))
      if (momentaryEnergies.length < LOUDNESS_REPORT_SERIES_LIMIT) momentaryEnergies.push(energy)
    }
    if (frameCount >= shortTermFrames && (frameCount - shortTermFrames) % shortTermStep === 0) {
      const energy = shortTermSums.reduce((sum, value) => sum + value / shortTermFrames, 0)
      addLoudnessEnergy(shortTermHistogram, energy)
      shortTermMaximum = Math.max(shortTermMaximum, loudnessFromEnergy(energy))
      if (shortTermEnergies.length < LOUDNESS_REPORT_SERIES_LIMIT) shortTermEnergies.push(energy)
    }
  }
  return {
    integratedHistogram,
    shortTermHistogram,
    momentaryEnergies,
    shortTermEnergies,
    momentaryMaximum,
    shortTermMaximum,
  }
}

/* Kept independent from the streaming implementation for equation-derived test fixtures. */
export const applyBs1770BiquadReference = (
  input: Float32Array<ArrayBufferLike> | Float64Array<ArrayBufferLike>,
  coefficients: BiquadCoefficients,
) => {
  const output = new Float64Array(input.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let index = 0; index < input.length; index += 1) {
    const x = Number.isFinite(input[index]) ? input[index] : 0
    const y = coefficients.b0 * x + coefficients.b1 * x1 + coefficients.b2 * x2
      - coefficients.a1 * y1 - coefficients.a2 * y2
    output[index] = y
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
  }
  return output
}

export function analyzeLoudness(buffer: LoudnessBuffer, signal?: AbortSignal): LoudnessAnalysis {
  signal?.throwIfAborted()
  if (buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2) {
    throw new Error('BS.1770 loudness analysis supports mono or stereo buffers.')
  }
  const shelf = createHighShelf(buffer.sampleRate)
  const highPass = createHighPass(buffer.sampleRate)
  const {
    integratedHistogram,
    shortTermHistogram,
    momentaryEnergies,
    shortTermEnergies,
    momentaryMaximum,
    shortTermMaximum,
  } = createRollingEnergies(buffer, shelf, highPass, signal)
  const integratedEnergy = gatedHistogramMean(integratedHistogram, -70, -10)
  const loudnessRangeLu = gatedHistogramLoudnessRange(shortTermHistogram, -70, -20)
  const truePeak = scanTruePeak(buffer, signal)
  signal?.throwIfAborted()
  return {
    reference: 'bs1770-equations',
    integratedLufs: integratedEnergy === null ? null : loudnessFromEnergy(integratedEnergy),
    loudnessRangeLu,
    momentaryLufs: momentaryEnergies.map(loudnessFromEnergy),
    shortTermLufs: shortTermEnergies.map(loudnessFromEnergy),
    momentaryMaxLufs: momentaryMaximum === Number.NEGATIVE_INFINITY ? null : momentaryMaximum,
    shortTermMaxLufs: shortTermMaximum === Number.NEGATIVE_INFINITY ? null : shortTermMaximum,
    truePeak: truePeak.peak,
    truePeakDbtp: truePeak.peak === 0 ? null : truePeak.peakDbtp,
  }
}
