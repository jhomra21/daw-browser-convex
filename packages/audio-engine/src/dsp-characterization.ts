export type AudioFixture = readonly Float32Array[]

type AudioMetrics = {
  peak: number
  rms: number
  dcOffset: readonly number[]
  containsNonFiniteSamples: boolean
}

export const ANALYZER_FFT_SIZE = 2048
export const ANALYZER_BIN_COUNT = ANALYZER_FFT_SIZE / 2
export const ANALYZER_NYQUIST_BIN = ANALYZER_FFT_SIZE / 2
export const ANALYZER_SMOOTHING = 0.7
export const ANALYZER_MIN_DECIBELS = -100
export const ANALYZER_MAX_DECIBELS = -30
export const ANALYZER_BLACKMAN_ALPHA = 0.16

export type AnalyzerReferenceFrame = {
  magnitude: Float32Array
  decibels: Float32Array
  normalized: Float32Array
}

const createChannels = (channelCount: number, length: number) =>
  Array.from({ length: channelCount }, () => new Float32Array(length))

export const createSilenceFixture = (length: number, channelCount = 1): AudioFixture =>
  createChannels(channelCount, length)

export const createImpulseFixture = (length: number, channelCount = 1): AudioFixture => {
  const channels = createChannels(channelCount, length)
  for (const channel of channels) {
    if (channel.length > 0) channel[0] = 1
  }
  return channels
}

export const createStepFixture = (length: number, value = 1, channelCount = 1): AudioFixture => {
  const channels = createChannels(channelCount, length)
  for (const channel of channels) channel.fill(value)
  return channels
}

export const createSineFixture = (length: number, frequencyHz: number, sampleRate: number, channelCount = 1): AudioFixture => {
  const channels = createChannels(channelCount, length)
  for (const channel of channels) {
    for (let frame = 0; frame < length; frame += 1) {
      channel[frame] = Math.sin(2 * Math.PI * frequencyHz * frame / sampleRate)
    }
  }
  return channels
}

export const createSweepFixture = (
  length: number,
  startFrequencyHz: number,
  endFrequencyHz: number,
  sampleRate: number,
): AudioFixture => {
  const channel = new Float32Array(length)
  let phase = 0
  for (let frame = 0; frame < length; frame += 1) {
    const progress = length <= 1 ? 0 : frame / (length - 1)
    const frequency = startFrequencyHz + (endFrequencyHz - startFrequencyHz) * progress
    phase += 2 * Math.PI * frequency / sampleRate
    channel[frame] = Math.sin(phase)
  }
  return [channel]
}

export const createSeededNoiseFixture = (length: number, seed = 1, channelCount = 1): AudioFixture => {
  let state = seed >>> 0
  const channels = createChannels(channelCount, length)
  for (const channel of channels) {
    for (let frame = 0; frame < length; frame += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      channel[frame] = state / 0xffffffff * 2 - 1
    }
  }
  return channels
}

export const createStereoIsolationFixture = (length: number): AudioFixture => {
  const channels = createChannels(2, length)
  if (length > 0) channels[0][0] = 1
  return channels
}

export const createOppositePolarityFixture = (length: number): AudioFixture => {
  const channels = createChannels(2, length)
  for (let frame = 0; frame < length; frame += 1) {
    const value = frame % 2 === 0 ? 1 : -1
    channels[0][frame] = value
    channels[1][frame] = -value
  }
  return channels
}

export const createEdgeCaseFixture = (): AudioFixture => [
  new Float32Array([2, -2, Number.MIN_VALUE, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]),
]

export const measureAudio = (channels: AudioFixture): AudioMetrics => {
  let peak = 0
  let squareSum = 0
  let sampleCount = 0
  let containsNonFiniteSamples = false
  const dcOffset = channels.map((channel) => {
    let sum = 0
    let finiteSampleCount = 0
    for (const sample of channel) {
      if (!Number.isFinite(sample)) {
        containsNonFiniteSamples = true
        continue
      }
      peak = Math.max(peak, Math.abs(sample))
      squareSum += sample * sample
      sum += sample
      sampleCount += 1
      finiteSampleCount += 1
    }
    return finiteSampleCount === 0 ? 0 : sum / finiteSampleCount
  })
  return {
    peak,
    rms: sampleCount === 0 ? 0 : Math.sqrt(squareSum / sampleCount),
    dcOffset,
    containsNonFiniteSamples,
  }
}

export const measureFrameOffset = (reference: Float32Array, candidate: Float32Array, maximumOffset: number) => {
  const referenceEnergy = reference.reduce((sum, sample) => sum + sample * sample, 0)
  const candidateEnergy = candidate.reduce((sum, sample) => sum + sample * sample, 0)
  if (referenceEnergy === 0 || candidateEnergy === 0) return null
  const normalization = Math.sqrt(referenceEnergy * candidateEnergy)
  let bestOffset = 0
  let bestCorrelationMagnitude = 0
  for (let offset = -maximumOffset; offset <= maximumOffset; offset += 1) {
    let correlation = 0
    for (let frame = 0; frame < reference.length; frame += 1) {
      const candidateFrame = frame + offset
      if (candidateFrame >= 0 && candidateFrame < candidate.length) {
        const referenceSample = reference[frame]
        const candidateSample = candidate[candidateFrame]
        correlation += referenceSample * candidateSample
      }
    }
    const correlationMagnitude = Math.abs(correlation / normalization)
    if (correlationMagnitude > bestCorrelationMagnitude) {
      bestCorrelationMagnitude = correlationMagnitude
      bestOffset = offset
    }
  }
  return bestCorrelationMagnitude >= 0.5 ? bestOffset : null
}

export const measureChannelLeakageDb = (sourcePeak: number, leakedPeak: number) => {
  if (leakedPeak <= 0) return Number.NEGATIVE_INFINITY
  if (sourcePeak <= 0) return Number.POSITIVE_INFINITY
  return 20 * Math.log10(leakedPeak / sourcePeak)
}

const blackmanWindow = (frame: number, length: number) => {
  const progress = frame / (length - 1)
  return (1 - ANALYZER_BLACKMAN_ALPHA) / 2
    - 0.5 * Math.cos(2 * Math.PI * progress)
    + ANALYZER_BLACKMAN_ALPHA / 2 * Math.cos(4 * Math.PI * progress)
}

const downmixAnalyzerFrame = (channels: AudioFixture) => {
  const frame = new Float64Array(ANALYZER_FFT_SIZE)
  const left = channels[0]
  const right = channels[1]
  for (let index = 0; index < ANALYZER_FFT_SIZE; index += 1) {
    const leftSample = Number.isFinite(left?.[index]) ? left[index] : 0
    const rightSample = Number.isFinite(right?.[index]) ? right[index] : 0
    frame[index] = channels.length > 1
      ? (leftSample + rightSample) * 0.5
      : leftSample
  }
  return frame
}

/**
 * Pure reference for the analyzer contract used by the browser meter.
 *
 * The DFT is intentionally direct rather than shared with production DSP:
 * this keeps the characterization independent and makes the DC, Nyquist, and
 * one-sided-bin scaling explicit. Previous-frame smoothing is caller-owned.
 */
export const characterizeAnalyzerFrame = (
  channels: AudioFixture,
  previousMagnitude?: Float32Array,
): AnalyzerReferenceFrame => {
  const input = downmixAnalyzerFrame(channels)
  const magnitude = new Float32Array(ANALYZER_BIN_COUNT)
  const decibels = new Float32Array(ANALYZER_BIN_COUNT)
  const normalized = new Float32Array(ANALYZER_BIN_COUNT)
  for (let bin = 0; bin < ANALYZER_BIN_COUNT; bin += 1) {
    let real = 0
    let imaginary = 0
    for (let frame = 0; frame < ANALYZER_FFT_SIZE; frame += 1) {
      const angle = 2 * Math.PI * bin * frame / ANALYZER_FFT_SIZE
      const sample = input[frame] * blackmanWindow(frame, ANALYZER_FFT_SIZE)
      real += sample * Math.cos(angle)
      imaginary -= sample * Math.sin(angle)
    }
    // Web Audio exposes bins [0, N/2), so Nyquist is not present in the
    // 1024-value output. DC is not doubled; every exposed non-DC bin is.
    const scale = bin === 0 ? 1 / ANALYZER_FFT_SIZE : 2 / ANALYZER_FFT_SIZE
    const currentMagnitude = Math.hypot(real, imaginary) * scale
    const smoothedMagnitude = previousMagnitude && previousMagnitude.length === ANALYZER_BIN_COUNT
      ? ANALYZER_SMOOTHING * previousMagnitude[bin] + (1 - ANALYZER_SMOOTHING) * currentMagnitude
      : currentMagnitude
    magnitude[bin] = Number.isFinite(smoothedMagnitude) ? smoothedMagnitude : 0
    const db = 20 * Math.log10(Math.max(magnitude[bin], Number.MIN_VALUE))
    decibels[bin] = Math.min(ANALYZER_MAX_DECIBELS, Math.max(ANALYZER_MIN_DECIBELS, db))
    normalized[bin] = (decibels[bin] - ANALYZER_MIN_DECIBELS)
      / (ANALYZER_MAX_DECIBELS - ANALYZER_MIN_DECIBELS)
  }
  return { magnitude, decibels, normalized }
}

export type ReverbCharacterizationMetrics = {
  onsetFrame: number | null
  peak: number
  decayFrameAtMinus60Db: number | null
  earlyReflectionEnergy: number
  stereoCorrelation: number | null
  finite: boolean
}

export const measureReverbCharacterization = (
  channels: AudioFixture,
  options: {
    earlyWindow: readonly [number, number]
    onsetThreshold?: number
    decayThresholdDb?: number
  },
): ReverbCharacterizationMetrics => {
  const left = channels[0] ?? new Float32Array()
  const right = channels[1] ?? left
  let peak = 0
  let finite = true
  for (const channel of channels) {
    for (const sample of channel) {
      finite = finite && Number.isFinite(sample)
      if (Number.isFinite(sample)) peak = Math.max(peak, Math.abs(sample))
    }
  }
  const onsetThreshold = options.onsetThreshold ?? 1e-6
  const onsetFrame = channels.reduce<number | null>((first, channel) => {
    for (let frame = 0; frame < channel.length; frame += 1) {
      if (Number.isFinite(channel[frame]) && Math.abs(channel[frame]) >= onsetThreshold) {
        return first === null ? frame : Math.min(first, frame)
      }
    }
    return first
  }, null)
  const decayThreshold = peak * Math.pow(10, (options.decayThresholdDb ?? -60) / 20)
  let decayFrameAtMinus60Db: number | null = null
  if (peak > 0) {
    for (const channel of channels) {
      for (let frame = channel.length - 1; frame >= 0; frame -= 1) {
        if (Number.isFinite(channel[frame]) && Math.abs(channel[frame]) >= decayThreshold) {
          decayFrameAtMinus60Db = decayFrameAtMinus60Db === null
            ? frame
            : Math.max(decayFrameAtMinus60Db, frame)
          break
        }
      }
    }
  }
  const start = Math.max(0, options.earlyWindow[0])
  const end = Math.min(Math.max(left.length, right.length), options.earlyWindow[1])
  let earlyReflectionEnergy = 0
  for (const channel of channels) {
    for (let frame = start; frame < end && frame < channel.length; frame += 1) {
      const sample = channel[frame]
      if (Number.isFinite(sample)) earlyReflectionEnergy += sample * sample
    }
  }
  let leftEnergy = 0
  let rightEnergy = 0
  let crossEnergy = 0
  const correlationLength = Math.min(left.length, right.length)
  for (let frame = 0; frame < correlationLength; frame += 1) {
    const leftSample = Number.isFinite(left[frame]) ? left[frame] : 0
    const rightSample = Number.isFinite(right[frame]) ? right[frame] : 0
    leftEnergy += leftSample * leftSample
    rightEnergy += rightSample * rightSample
    crossEnergy += leftSample * rightSample
  }
  const minimumEnergy = 1e-10
  const stereoCorrelation = leftEnergy < minimumEnergy || rightEnergy < minimumEnergy
    ? null
    : crossEnergy / Math.sqrt(leftEnergy * rightEnergy)
  return {
    onsetFrame,
    peak,
    decayFrameAtMinus60Db,
    earlyReflectionEnergy,
    stereoCorrelation,
    finite,
  }
}
