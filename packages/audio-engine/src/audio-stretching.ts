type AudioStretchInput = {
  channels: Float32Array[]
  sampleRate: number
}

type WsolaStretchConfig = {
  outputFrameCount: number
  windowFrameCount?: number
  overlapFrameCount?: number
  searchFrameCount?: number
}

type AudioStretchResult = AudioStretchInput

const DEFAULT_WINDOW_FRAMES = 2048
const DEFAULT_OVERLAP_FRAMES = 1024
const DEFAULT_SEARCH_FRAMES = 512
const MIN_STRETCH_RATIO = 0.5
const MAX_STRETCH_RATIO = 2
const PEAK_EPSILON = 0.0001

const resolveEvenFrameCount = (value: number | undefined, fallback: number) => {
  const frameCount = Number.isFinite(value) && value !== undefined ? Math.max(2, Math.floor(value)) : fallback
  return frameCount % 2 === 0 ? frameCount : frameCount - 1
}

const getInputFrameCount = (channels: Float32Array[]) => channels[0]?.length ?? 0

const getPeak = (channels: Float32Array[]) => {
  let peak = 0
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index++) {
      peak = Math.max(peak, Math.abs(channel[index]))
    }
  }
  return peak
}

const normalizePeak = (channels: Float32Array[], maxPeak: number) => {
  const peak = getPeak(channels)
  if (peak <= maxPeak || peak <= 0) return channels
  const gain = maxPeak / peak
  return channels.map((channel) => {
    const normalized = new Float32Array(channel.length)
    for (let index = 0; index < channel.length; index++) normalized[index] = channel[index] * gain
    return normalized
  })
}

const createMonoAnalysis = (channels: Float32Array[]) => {
  const frameCount = getInputFrameCount(channels)
  const mono = new Float32Array(frameCount)
  if (channels.length === 0) return mono
  const gain = 1 / channels.length
  for (const channel of channels) {
    for (let index = 0; index < frameCount; index++) mono[index] += channel[index] * gain
  }
  return mono
}

const copyExact = (input: AudioStretchInput, outputFrameCount: number): AudioStretchResult => ({
  sampleRate: input.sampleRate,
  channels: input.channels.map((channel) => {
    const output = new Float32Array(outputFrameCount)
    output.set(channel.subarray(0, Math.min(channel.length, outputFrameCount)))
    return output
  }),
})

const stretchWithinSupportedRatio = (input: AudioStretchInput, outputFrameCount: number, config: WsolaStretchConfig): AudioStretchResult => {
  const inputFrameCount = getInputFrameCount(input.channels)
  const stretchRatio = outputFrameCount / inputFrameCount
  if (stretchRatio >= MIN_STRETCH_RATIO && stretchRatio <= MAX_STRETCH_RATIO) {
    return stretchAudioWsola(input, { ...config, outputFrameCount })
  }
  const intermediateFrameCount = stretchRatio < MIN_STRETCH_RATIO
    ? Math.max(outputFrameCount + 1, Math.ceil(inputFrameCount * MIN_STRETCH_RATIO))
    : Math.min(outputFrameCount, Math.ceil(inputFrameCount * MAX_STRETCH_RATIO))
  if (intermediateFrameCount === inputFrameCount || intermediateFrameCount === outputFrameCount) return copyExact(input, outputFrameCount)
  const intermediate = stretchAudioWsola(input, { ...config, outputFrameCount: intermediateFrameCount })
  return stretchWithinSupportedRatio(intermediate, outputFrameCount, config)
}

const scoreOverlap = (mono: Float32Array, outputMono: Float32Array, inputStart: number, outputStart: number, overlapFrameCount: number) => {
  let correlation = 0
  let inputEnergy = 0
  let outputEnergy = 0
  for (let index = 0; index < overlapFrameCount; index++) {
    const inputSample = mono[inputStart + index] ?? 0
    const outputSample = outputMono[outputStart + index] ?? 0
    correlation += inputSample * outputSample
    inputEnergy += inputSample * inputSample
    outputEnergy += outputSample * outputSample
  }
  if (inputEnergy <= 0 || outputEnergy <= 0) return 0
  return correlation / Math.sqrt(inputEnergy * outputEnergy)
}

const findBestInputStart = (mono: Float32Array, outputMono: Float32Array, expectedStart: number, outputStart: number, overlapFrameCount: number, searchFrameCount: number) => {
  const minStart = Math.max(0, expectedStart - searchFrameCount)
  const maxStart = Math.min(mono.length - overlapFrameCount, expectedStart + searchFrameCount)
  let bestStart = Math.max(0, Math.min(expectedStart, maxStart))
  let bestScore = -Infinity
  for (let inputStart = minStart; inputStart <= maxStart; inputStart++) {
    const score = scoreOverlap(mono, outputMono, inputStart, outputStart, overlapFrameCount)
    if (score > bestScore) {
      bestScore = score
      bestStart = inputStart
    }
  }
  return bestStart
}

const writeFrame = (input: Float32Array, output: Float32Array, inputStart: number, outputStart: number, frameCount: number) => {
  for (let index = 0; index < frameCount; index++) {
    const outputIndex = outputStart + index
    if (outputIndex >= output.length) return
    output[outputIndex] = input[inputStart + index] ?? 0
  }
}

const overlapAddFrame = (
  input: Float32Array,
  output: Float32Array,
  inputStart: number,
  outputStart: number,
  overlapFrameCount: number,
  frameCount: number,
) => {
  for (let index = 0; index < frameCount; index++) {
    const outputIndex = outputStart + index
    if (outputIndex >= output.length) return
    const inputSample = input[inputStart + index] ?? 0
    if (index < overlapFrameCount) {
      const fadeIn = index / overlapFrameCount
      output[outputIndex] = output[outputIndex] * (1 - fadeIn) + inputSample * fadeIn
    } else {
      output[outputIndex] = inputSample
    }
  }
}

export function stretchAudioWsola(input: AudioStretchInput, config: WsolaStretchConfig): AudioStretchResult {
  const inputFrameCount = getInputFrameCount(input.channels)
  const outputFrameCount = Math.max(0, Math.floor(config.outputFrameCount))
  if (inputFrameCount === 0 || outputFrameCount === 0) {
    return { sampleRate: input.sampleRate, channels: input.channels.map(() => new Float32Array(outputFrameCount)) }
  }
  for (const channel of input.channels) {
    if (channel.length !== inputFrameCount) throw new Error('WSOLA input channels must have matching frame counts')
  }

  const stretchRatio = outputFrameCount / inputFrameCount
  if (stretchRatio < MIN_STRETCH_RATIO || stretchRatio > MAX_STRETCH_RATIO) {
    return stretchWithinSupportedRatio(input, outputFrameCount, config)
  }
  if (Math.abs(stretchRatio - 1) <= 1 / Math.max(1, inputFrameCount)) return copyExact(input, outputFrameCount)

  const windowFrameCount = Math.min(inputFrameCount, resolveEvenFrameCount(config.windowFrameCount, DEFAULT_WINDOW_FRAMES))
  const overlapFrameCount = Math.min(
    windowFrameCount - 1,
    resolveEvenFrameCount(config.overlapFrameCount, Math.min(DEFAULT_OVERLAP_FRAMES, Math.floor(windowFrameCount / 2))),
  )
  const synthesisHop = Math.max(1, windowFrameCount - overlapFrameCount)
  const searchFrameCount = Math.max(0, Math.floor(config.searchFrameCount ?? DEFAULT_SEARCH_FRAMES))
  const outputChannels = input.channels.map(() => new Float32Array(outputFrameCount))
  const mono = createMonoAnalysis(input.channels)
  const outputMono = new Float32Array(outputFrameCount)

  for (let channelIndex = 0; channelIndex < input.channels.length; channelIndex++) {
    writeFrame(input.channels[channelIndex], outputChannels[channelIndex], 0, 0, Math.min(windowFrameCount, outputFrameCount))
  }
  writeFrame(mono, outputMono, 0, 0, Math.min(windowFrameCount, outputFrameCount))

  for (let outputStart = synthesisHop; outputStart < outputFrameCount; outputStart += synthesisHop) {
    const expectedInputStart = Math.round(outputStart / stretchRatio)
    const bestInputStart = findBestInputStart(mono, outputMono, expectedInputStart, outputStart, overlapFrameCount, searchFrameCount)
    const frameCount = Math.min(windowFrameCount, outputFrameCount - outputStart)
    for (let channelIndex = 0; channelIndex < input.channels.length; channelIndex++) {
      overlapAddFrame(input.channels[channelIndex], outputChannels[channelIndex], bestInputStart, outputStart, overlapFrameCount, frameCount)
    }
    overlapAddFrame(mono, outputMono, bestInputStart, outputStart, overlapFrameCount, frameCount)
  }

  const inputPeak = getPeak(input.channels)
  return {
    sampleRate: input.sampleRate,
    channels: normalizePeak(outputChannels, inputPeak + PEAK_EPSILON),
  }
}
