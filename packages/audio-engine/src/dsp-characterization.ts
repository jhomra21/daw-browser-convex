type AudioFixture = readonly Float32Array[]

type AudioMetrics = {
  peak: number
  rms: number
  dcOffset: readonly number[]
  containsNonFiniteSamples: boolean
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
