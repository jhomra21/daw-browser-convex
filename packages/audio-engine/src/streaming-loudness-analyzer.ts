import {
  LOUDNESS_REPORT_SERIES_LIMIT,
  addLoudnessEnergy,
  createLoudnessEnergyHistogram,
  gatedHistogramLoudnessRange,
  gatedHistogramMean,
  type LoudnessAnalysis,
} from './loudness-analyzer'
import { createStreamingTruePeakScanner } from './streaming-true-peak-scanner'

type BiquadCoefficients = {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

type BiquadState = {
  x1: number
  x2: number
  y1: number
  y2: number
}

export type StreamingLoudnessChunk = {
  numberOfChannels: number
  length: number
  sampleRate: number
  getChannelData: (channel: number) => Float32Array<ArrayBufferLike>
}

const loudnessFromEnergy = (energy: number) => energy > 0
  ? -0.691 + 10 * Math.log10(energy)
  : Number.NEGATIVE_INFINITY

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

export const createStreamingLoudnessAnalyzer = (input: {
  sampleRate: number
  channelCount: number
}) => {
  if (!Number.isFinite(input.sampleRate) || input.sampleRate <= 0
    || !Number.isSafeInteger(input.channelCount)
    || input.channelCount < 1
    || input.channelCount > 2) {
    throw new Error('Streaming BS.1770 analyzer metadata is invalid.')
  }

  const momentaryFrames = Math.max(1, Math.round(input.sampleRate * 0.4))
  const momentaryStep = Math.max(1, Math.round(input.sampleRate * 0.1))
  const shortTermFrames = Math.max(1, Math.round(input.sampleRate * 3))
  const shortTermStep = Math.max(1, Math.round(input.sampleRate))
  const channelEnergyRings = Array.from(
    { length: input.channelCount },
    () => new Float64Array(shortTermFrames),
  )
  const shelf = createHighShelf(input.sampleRate)
  const highPass = createHighPass(input.sampleRate)
  const shelfStates: BiquadState[] = Array.from(
    { length: input.channelCount },
    () => ({ x1: 0, x2: 0, y1: 0, y2: 0 }),
  )
  const highPassStates: BiquadState[] = Array.from(
    { length: input.channelCount },
    () => ({ x1: 0, x2: 0, y1: 0, y2: 0 }),
  )
  const momentarySums = new Float64Array(input.channelCount)
  const shortTermSums = new Float64Array(input.channelCount)
  const integratedHistogram = createLoudnessEnergyHistogram()
  const shortTermHistogram = createLoudnessEnergyHistogram()
  const momentaryEnergies: number[] = []
  const shortTermEnergies: number[] = []
  const truePeak = createStreamingTruePeakScanner(input.channelCount)
  let momentaryMaximum = Number.NEGATIVE_INFINITY
  let shortTermMaximum = Number.NEGATIVE_INFINITY
  let framesProcessed = 0
  let result: LoudnessAnalysis | undefined

  const append = (chunk: StreamingLoudnessChunk, signal?: AbortSignal) => {
    if (result) throw new Error('Streaming BS.1770 analyzer is already finalized.')
    if (chunk.numberOfChannels !== input.channelCount
      || chunk.sampleRate !== input.sampleRate
      || !Number.isSafeInteger(chunk.length)
      || chunk.length < 0) {
      throw new Error('Streaming BS.1770 chunk metadata is invalid.')
    }
    const channels = Array.from({ length: input.channelCount }, (_, channel) => {
      const data = chunk.getChannelData(channel)
      if (data.length !== chunk.length) throw new Error('Streaming BS.1770 chunk channel length is invalid.')
      return data
    })

    truePeak.append(chunk, signal)
    for (let localFrame = 0; localFrame < chunk.length; localFrame += 1) {
      if ((framesProcessed & 4095) === 0) signal?.throwIfAborted()
      const ringIndex = framesProcessed % shortTermFrames
      for (let channel = 0; channel < input.channelCount; channel += 1) {
        const samples = channels[channel]
        const energyRing = channelEnergyRings[channel]
        const shelfState = shelfStates[channel]
        const highPassState = highPassStates[channel]
        if (!samples || !energyRing || !shelfState || !highPassState) {
          throw new Error('Streaming BS.1770 channel state is missing.')
        }
        const shelved = filterSample(samples[localFrame] ?? 0, shelf, shelfState)
        const filtered = filterSample(shelved, highPass, highPassState)
        const energy = filtered * filtered
        const replaced = energyRing[ringIndex] ?? 0
        energyRing[ringIndex] = energy
        shortTermSums[channel] = (shortTermSums[channel] ?? 0) + energy - replaced
        momentarySums[channel] = (momentarySums[channel] ?? 0) + energy
        if (framesProcessed >= momentaryFrames) {
          const expiredIndex = (framesProcessed - momentaryFrames) % shortTermFrames
          momentarySums[channel] = (momentarySums[channel] ?? 0) - (energyRing[expiredIndex] ?? 0)
        }
      }
      framesProcessed += 1
      if (framesProcessed >= momentaryFrames
        && (framesProcessed - momentaryFrames) % momentaryStep === 0) {
        let energy = 0
        for (let channel = 0; channel < input.channelCount; channel += 1) {
          energy += (momentarySums[channel] ?? 0) / momentaryFrames
        }
        addLoudnessEnergy(integratedHistogram, energy)
        momentaryMaximum = Math.max(momentaryMaximum, loudnessFromEnergy(energy))
        if (momentaryEnergies.length < LOUDNESS_REPORT_SERIES_LIMIT) momentaryEnergies.push(energy)
      }
      if (framesProcessed >= shortTermFrames
        && (framesProcessed - shortTermFrames) % shortTermStep === 0) {
        let energy = 0
        for (let channel = 0; channel < input.channelCount; channel += 1) {
          energy += (shortTermSums[channel] ?? 0) / shortTermFrames
        }
        addLoudnessEnergy(shortTermHistogram, energy)
        shortTermMaximum = Math.max(shortTermMaximum, loudnessFromEnergy(energy))
        if (shortTermEnergies.length < LOUDNESS_REPORT_SERIES_LIMIT) shortTermEnergies.push(energy)
      }
    }
  }

  const finish = (signal?: AbortSignal): LoudnessAnalysis => {
    if (result) return result
    signal?.throwIfAborted()
    const integratedEnergy = gatedHistogramMean(integratedHistogram, -70, -10)
    const loudnessRangeLu = gatedHistogramLoudnessRange(shortTermHistogram, -70, -20)
    const scannedTruePeak = truePeak.finish(signal)
    result = {
      reference: 'bs1770-equations',
      integratedLufs: integratedEnergy === null ? null : loudnessFromEnergy(integratedEnergy),
      loudnessRangeLu,
      momentaryLufs: momentaryEnergies.map(loudnessFromEnergy),
      shortTermLufs: shortTermEnergies.map(loudnessFromEnergy),
      momentaryMaxLufs: momentaryMaximum === Number.NEGATIVE_INFINITY ? null : momentaryMaximum,
      shortTermMaxLufs: shortTermMaximum === Number.NEGATIVE_INFINITY ? null : shortTermMaximum,
      truePeak: scannedTruePeak.peak,
      truePeakDbtp: scannedTruePeak.peak === 0 ? null : scannedTruePeak.peakDbtp,
    }
    return result
  }

  return { append, finish }
}
