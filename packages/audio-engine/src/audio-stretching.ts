import { assert } from '@daw-browser/shared'

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

export type WsolaSinglePassStreamOptions = WsolaStretchConfig & {
  inputFrameCount: number
  channelCount: number
  sampleRate: number
}

export type WsolaSinglePassMemoryBounds = {
  inputRingFrameCapacity: number
  overlapFrameCapacity: number
}

export type WsolaSinglePassStats = WsolaSinglePassMemoryBounds & {
  inputPeak: number
  outputPeak: number
}

type WsolaOutputWriter = (channels: Float32Array[]) => void

type WsolaStreamState = 'active' | 'emitting' | 'finishing' | 'finished' | 'failed'

const DEFAULT_WINDOW_FRAMES = 2048
const DEFAULT_OVERLAP_FRAMES = 1024
const DEFAULT_SEARCH_FRAMES = 512
const STREAM_INPUT_CHUNK_FRAMES = 16_384
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

const copyExact = (input: AudioStretchInput, outputFrameCount: number): AudioStretchResult => ({
  sampleRate: input.sampleRate,
  channels: input.channels.map((channel) => {
    const output = new Float32Array(outputFrameCount)
    output.set(channel.subarray(0, Math.min(channel.length, outputFrameCount)))
    return output
  }),
})

export function createWsolaSinglePassStream(options: WsolaSinglePassStreamOptions) {
  const inputFrameCount = options.inputFrameCount
  assert(Number.isSafeInteger(inputFrameCount) && inputFrameCount > 0, 'WSOLA stream input frame count must be a positive safe integer')
  assert(Number.isSafeInteger(options.channelCount) && options.channelCount > 0, 'WSOLA stream channel count must be a positive safe integer')
  assert(Number.isFinite(options.sampleRate) && options.sampleRate > 0, 'WSOLA stream sample rate must be positive')
  const outputFrameCount = options.outputFrameCount
  assert(Number.isSafeInteger(outputFrameCount) && outputFrameCount > 0, 'WSOLA stream output frame count must be a positive safe integer')

  const stretchRatio = outputFrameCount / inputFrameCount
  assert(
    stretchRatio >= MIN_STRETCH_RATIO && stretchRatio <= MAX_STRETCH_RATIO,
    'WSOLA stream only accepts a single supported stretch-ratio pass',
  )

  const windowFrameCount = Math.min(
    inputFrameCount,
    resolveEvenFrameCount(options.windowFrameCount, DEFAULT_WINDOW_FRAMES),
  )
  const overlapFrameCount = Math.min(
    windowFrameCount - 1,
    resolveEvenFrameCount(
      options.overlapFrameCount,
      Math.min(DEFAULT_OVERLAP_FRAMES, Math.floor(windowFrameCount / 2)),
    ),
  )
  const synthesisHop = Math.max(1, windowFrameCount - overlapFrameCount)
  const searchFrameCount = Math.max(0, Math.floor(options.searchFrameCount ?? DEFAULT_SEARCH_FRAMES))
  const inputRingFrameCapacity = Math.max(
    windowFrameCount,
    windowFrameCount + searchFrameCount * 2,
  )
  const inputRings = Array.from(
    { length: options.channelCount },
    () => new Float32Array(inputRingFrameCapacity),
  )
  const monoRing = new Float32Array(inputRingFrameCapacity)
  let pendingChannels = Array.from(
    { length: options.channelCount },
    () => new Float32Array(overlapFrameCount),
  )
  let pendingMono = new Float32Array(overlapFrameCount)
  let framesSeen = 0
  let framesEmitted = 0
  let nextOutputStart = synthesisHop
  let initialized = false
  let state: WsolaStreamState = 'active'
  let finishedStats: WsolaSinglePassStats | undefined
  let inputPeak = 0
  let outputPeak = 0

  const sourceSampleAt = (channel: number, frame: number) => {
    if (frame < 0 || frame >= inputFrameCount) return 0
    if (frame < framesSeen - inputRingFrameCapacity) {
      throw new Error('WSOLA stream source history was overwritten before use.')
    }
    if (frame >= framesSeen) throw new Error('WSOLA stream requested source audio before it was supplied.')
    return inputRings[channel]?.[frame % inputRingFrameCapacity] ?? 0
  }

  const monoSampleAt = (frame: number) => {
    if (frame < 0 || frame >= inputFrameCount) return 0
    if (frame < framesSeen - inputRingFrameCapacity) {
      throw new Error('WSOLA stream analysis history was overwritten before use.')
    }
    if (frame >= framesSeen) throw new Error('WSOLA stream requested analysis audio before it was supplied.')
    return monoRing[frame % inputRingFrameCapacity] ?? 0
  }

  const emit = (channels: Float32Array[], frameCount: number, write: WsolaOutputWriter) => {
    if (frameCount <= 0) return
    const output = channels.map((channel) => channel.slice(0, frameCount))
    for (const channel of output) {
      for (let frame = 0; frame < channel.length; frame++) {
        outputPeak = Math.max(outputPeak, Math.abs(channel[frame]))
      }
    }
    const previousState = state
    state = 'emitting'
    try {
      write(output)
      framesEmitted += frameCount
    } finally {
      state = previousState
    }
  }

  const initialize = (write: WsolaOutputWriter) => {
    const frameCount = Math.min(windowFrameCount, outputFrameCount)
    const windowChannels = Array.from(
      { length: options.channelCount },
      () => new Float32Array(frameCount),
    )
    const windowMono = new Float32Array(frameCount)
    for (let frame = 0; frame < frameCount; frame++) {
      for (let channel = 0; channel < options.channelCount; channel++) {
        const target = windowChannels[channel]
        if (!target) throw new Error('WSOLA stream output channel is missing.')
        target[frame] = sourceSampleAt(channel, frame)
      }
      windowMono[frame] = monoSampleAt(frame)
    }
    const emitFrameCount = Math.min(synthesisHop, frameCount)
    emit(windowChannels, emitFrameCount, write)
    const remainingFrameCount = Math.min(overlapFrameCount, frameCount - emitFrameCount)
    pendingChannels = windowChannels.map((channel) => {
      const pending = new Float32Array(overlapFrameCount)
      pending.set(channel.subarray(emitFrameCount, emitFrameCount + remainingFrameCount))
      return pending
    })
    pendingMono = new Float32Array(overlapFrameCount)
    pendingMono.set(windowMono.subarray(emitFrameCount, emitFrameCount + remainingFrameCount))
    initialized = true
  }

  const scoreOverlap = (inputStart: number) => {
    let correlation = 0
    let inputEnergy = 0
    let outputEnergy = 0
    for (let frame = 0; frame < overlapFrameCount; frame++) {
      const inputSample = monoSampleAt(inputStart + frame)
      const outputSample = pendingMono[frame] ?? 0
      correlation += inputSample * outputSample
      inputEnergy += inputSample * inputSample
      outputEnergy += outputSample * outputSample
    }
    if (inputEnergy <= 0 || outputEnergy <= 0) return 0
    return correlation / Math.sqrt(inputEnergy * outputEnergy)
  }

  const requiredSourceEndFrame = () => {
    const expectedInputStart = Math.round(nextOutputStart / stretchRatio)
    const maxInputStart = Math.min(
      inputFrameCount - overlapFrameCount,
      expectedInputStart + searchFrameCount,
    )
    const outputWindowFrameCount = Math.min(windowFrameCount, outputFrameCount - nextOutputStart)
    return Math.min(
      inputFrameCount,
      Math.max(0, maxInputStart) + Math.max(overlapFrameCount, outputWindowFrameCount),
    )
  }

  const processNextWindow = (write: WsolaOutputWriter) => {
    const expectedInputStart = Math.round(nextOutputStart / stretchRatio)
    const minInputStart = Math.max(0, expectedInputStart - searchFrameCount)
    const maxInputStart = Math.min(
      inputFrameCount - overlapFrameCount,
      expectedInputStart + searchFrameCount,
    )
    let bestInputStart = Math.max(0, Math.min(expectedInputStart, maxInputStart))
    let bestScore = -Infinity
    for (let inputStart = minInputStart; inputStart <= maxInputStart; inputStart++) {
      const score = scoreOverlap(inputStart)
      if (score > bestScore) {
        bestScore = score
        bestInputStart = inputStart
      }
    }

    const frameCount = Math.min(windowFrameCount, outputFrameCount - nextOutputStart)
    const windowChannels = Array.from(
      { length: options.channelCount },
      () => new Float32Array(frameCount),
    )
    const windowMono = new Float32Array(frameCount)
    for (let frame = 0; frame < frameCount; frame++) {
      const inputMono = monoSampleAt(bestInputStart + frame)
      const fadeIn = frame / overlapFrameCount
      windowMono[frame] = frame < overlapFrameCount
        ? (pendingMono[frame] ?? 0) * (1 - fadeIn) + inputMono * fadeIn
        : inputMono
      for (let channel = 0; channel < options.channelCount; channel++) {
        const target = windowChannels[channel]
        if (!target) throw new Error('WSOLA stream output channel is missing.')
        const inputSample = sourceSampleAt(channel, bestInputStart + frame)
        target[frame] = frame < overlapFrameCount
          ? (pendingChannels[channel]?.[frame] ?? 0) * (1 - fadeIn) + inputSample * fadeIn
          : inputSample
      }
    }

    const emitFrameCount = Math.min(synthesisHop, frameCount)
    emit(windowChannels, emitFrameCount, write)
    const remainingFrameCount = Math.min(overlapFrameCount, frameCount - emitFrameCount)
    pendingChannels = windowChannels.map((channel) => {
      const pending = new Float32Array(overlapFrameCount)
      pending.set(channel.subarray(emitFrameCount, emitFrameCount + remainingFrameCount))
      return pending
    })
    pendingMono = new Float32Array(overlapFrameCount)
    pendingMono.set(windowMono.subarray(emitFrameCount, emitFrameCount + remainingFrameCount))
    nextOutputStart += synthesisHop
  }

  const drain = (write: WsolaOutputWriter) => {
    const initialFrameCount = Math.min(inputFrameCount, Math.min(windowFrameCount, outputFrameCount))
    if (!initialized && framesSeen >= initialFrameCount) initialize(write)
    while (
      initialized
      && nextOutputStart < outputFrameCount
      && framesSeen >= requiredSourceEndFrame()
    ) {
      processNextWindow(write)
    }
  }

  const push = (channels: Float32Array[], write: WsolaOutputWriter) => {
    if (state !== 'active') throw new Error('WSOLA stream cannot accept audio after finish.')
    if (channels.length !== options.channelCount) throw new Error('WSOLA stream channel count changed.')
    const frameCount = channels[0]?.length ?? 0
    for (const channel of channels) {
      if (channel.length !== frameCount) throw new Error('WSOLA stream input channels must have matching frame counts.')
    }
    if (framesSeen + frameCount > inputFrameCount) throw new Error('WSOLA stream received more source frames than declared.')

    const channelGain = 1 / options.channelCount
    for (let localFrame = 0; localFrame < frameCount; localFrame++) {
      let mono = 0
      const ringIndex = framesSeen % inputRingFrameCapacity
      for (let channel = 0; channel < options.channelCount; channel++) {
        const source = channels[channel]
        const ring = inputRings[channel]
        if (!source || !ring) throw new Error('WSOLA stream input channel is missing.')
        const sample = source[localFrame] ?? 0
        ring[ringIndex] = sample
        inputPeak = Math.max(inputPeak, Math.abs(sample))
        mono = Math.fround(mono + sample * channelGain)
      }
      monoRing[ringIndex] = mono
      framesSeen += 1
      drain(write)
    }
  }

  const finish = (write: WsolaOutputWriter): WsolaSinglePassStats => {
    if (state === 'finished') {
      if (!finishedStats) throw new Error('WSOLA stream finished without completion statistics.')
      return finishedStats
    }
    if (state === 'emitting') throw new Error('WSOLA stream output emission is already in progress.')
    if (state === 'finishing') throw new Error('WSOLA stream finish is already in progress.')
    if (state === 'failed') throw new Error('WSOLA stream cannot finish after a failed completion.')
    if (framesSeen !== inputFrameCount) throw new Error('WSOLA stream ended before every declared source frame was supplied.')
    state = 'finishing'
    try {
      drain(write)
      while (nextOutputStart < outputFrameCount) processNextWindow(write)
      if (!initialized || framesEmitted !== outputFrameCount) {
        throw new Error('WSOLA stream did not produce the declared output frame count.')
      }
      finishedStats = {
        inputPeak,
        outputPeak,
        inputRingFrameCapacity,
        overlapFrameCapacity: overlapFrameCount,
      }
      state = 'finished'
      return finishedStats
    } catch (error) {
      state = 'failed'
      throw error
    }
  }

  const memoryBounds = (): WsolaSinglePassMemoryBounds => ({
    inputRingFrameCapacity,
    overlapFrameCapacity: overlapFrameCount,
  })

  return {
    push,
    finish,
    memoryBounds,
  }
}

const stretchWithinSupportedRatio = (
  input: AudioStretchInput,
  outputFrameCount: number,
  config: WsolaStretchConfig,
): AudioStretchResult => {
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

export function stretchAudioWsola(input: AudioStretchInput, config: WsolaStretchConfig): AudioStretchResult {
  const inputFrameCount = getInputFrameCount(input.channels)
  const outputFrameCount = Math.max(0, Math.floor(config.outputFrameCount))
  if (inputFrameCount === 0 || outputFrameCount === 0) {
    return { sampleRate: input.sampleRate, channels: input.channels.map(() => new Float32Array(outputFrameCount)) }
  }
  for (const channel of input.channels) {
    assert(channel.length === inputFrameCount, 'WSOLA input channels must have matching frame counts')
  }

  const stretchRatio = outputFrameCount / inputFrameCount
  if (stretchRatio < MIN_STRETCH_RATIO || stretchRatio > MAX_STRETCH_RATIO) {
    return stretchWithinSupportedRatio(input, outputFrameCount, config)
  }
  if (Math.abs(stretchRatio - 1) <= 1 / Math.max(1, inputFrameCount)) return copyExact(input, outputFrameCount)

  const outputChannels = input.channels.map(() => new Float32Array(outputFrameCount))
  let outputOffset = 0
  const stream = createWsolaSinglePassStream({
    ...config,
    inputFrameCount,
    outputFrameCount,
    channelCount: input.channels.length,
    sampleRate: input.sampleRate,
  })
  const write = (channels: Float32Array[]) => {
    const frameCount = channels[0]?.length ?? 0
    for (let channel = 0; channel < outputChannels.length; channel++) {
      const output = outputChannels[channel]
      const source = channels[channel]
      if (!output || !source) throw new Error('WSOLA stream output channel is missing.')
      output.set(source, outputOffset)
    }
    outputOffset += frameCount
  }

  for (let startFrame = 0; startFrame < inputFrameCount; startFrame += STREAM_INPUT_CHUNK_FRAMES) {
    const endFrame = Math.min(inputFrameCount, startFrame + STREAM_INPUT_CHUNK_FRAMES)
    stream.push(input.channels.map((channel) => channel.subarray(startFrame, endFrame)), write)
  }
  const stats = stream.finish(write)
  return {
    sampleRate: input.sampleRate,
    channels: stats.outputPeak <= stats.inputPeak + PEAK_EPSILON || stats.outputPeak <= 0
      ? outputChannels
      : normalizePeak(outputChannels, stats.inputPeak + PEAK_EPSILON),
  }
}
