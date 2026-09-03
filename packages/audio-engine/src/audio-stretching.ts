import { assert } from '@daw-browser/shared'

export type AudioStretchInput = {
  channels: Float32Array[]
  sampleRate: number
}

export type WsolaStretchConfig = {
  outputFrameCount: number
  windowFrameCount?: number
  overlapFrameCount?: number
  searchFrameCount?: number
  signal?: AbortSignal
  sourceChunkFrameCount?: number
  createTransaction?: WsolaPcmTransactionFactory
}

export type AudioStretchResult = AudioStretchInput

export type WsolaPcmChunk = {
  channels: Float32Array[]
}

export type WsolaPcmSource = {
  readonly sampleRate: number
  readonly channelCount: number
  readonly frameCount: number
  replay: (signal?: AbortSignal) => Iterable<WsolaPcmChunk>
  dispose: () => void
}

export type WsolaPcmTransactionMetadata = {
  sampleRate: number
  channelCount: number
  frameCount: number
}

export type WsolaPcmTransaction = {
  /**
   * The append must durably retain the chunk before it returns.
   * Transaction-owned storage may be duration-sized outside the working-memory
   * budget; the injected adapter owns that storage and its resident-memory bound.
   */
  append: (chunk: WsolaPcmChunk) => void
  commit: () => WsolaPcmSource
  abort: () => void
}

export type WsolaPcmTransactionFactory = (metadata: WsolaPcmTransactionMetadata) => WsolaPcmTransaction

export type WsolaBoundedMemoryStats = {
  stageFrameCounts: number[]
  stageInputPeaks: number[]
  stageRawOutputPeaks: number[]
  stageGains: number[]
  maxSourceChunkFrames: number
  maxOutputChunkFrames: number
  inputRingFrameCapacity: number
  overlapFrameCapacity: number
  /** Resident pipeline working memory; caller source and transaction storage are excluded. */
  pipelineWorkingMemoryBytes: number
}

export type WsolaBoundedResult = {
  result: AudioStretchResult
  stats: WsolaBoundedMemoryStats
}

export type WsolaBoundedSourceResult = {
  source: WsolaPcmSource
  stats: WsolaBoundedMemoryStats
}

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

export const WSOLA_MAX_CHANNEL_COUNT = 32
export const WSOLA_MAX_WINDOW_FRAMES = 16_384
export const WSOLA_MAX_OVERLAP_FRAMES = 8_192
export const WSOLA_MAX_SEARCH_FRAMES = 4_096
export const WSOLA_MAX_SOURCE_CHUNK_FRAMES = 65_536
const WSOLA_MAX_SCORE_SAMPLES_PER_OUTPUT_WINDOW = 4_194_304
export const WSOLA_MAX_PIPELINE_WORKING_MEMORY_BYTES = 64 * 1024 * 1024
export const WSOLA_MAX_MATERIALIZED_OUTPUT_BYTES = 256 * 1024 * 1024

export type WsolaBoundedSourceConfig = Omit<WsolaStretchConfig, 'createTransaction'> & {
  createTransaction: WsolaPcmTransactionFactory
}
type InternalStretchConfig = WsolaBoundedSourceConfig & { allowNonFinite?: boolean }

type WsolaOutputWriter = (channels: Float32Array[]) => void
type WsolaStreamState = 'active' | 'emitting' | 'finishing' | 'finished' | 'failed'
const DEFAULT_WINDOW_FRAMES = 2048
const DEFAULT_OVERLAP_FRAMES = 1024
const DEFAULT_SEARCH_FRAMES = 512
const DEFAULT_SOURCE_CHUNK_FRAMES = 16_384
const MIN_STRETCH_RATIO = 0.5
const MAX_STRETCH_RATIO = 2
const PEAK_EPSILON = 0.0001
const MAX_TYPED_ARRAY_LENGTH = 4_294_967_295
const FLOAT32_BYTES = Float32Array.BYTES_PER_ELEMENT

// AbortSignal is cooperative here: this synchronous DSP path cannot yield to
// another task. The checks make cancellation deterministic at its boundaries.
const throwIfAborted = (signal: AbortSignal | undefined) => signal?.throwIfAborted()

const validNonnegativeFrameCount = (value: number) => Number.isSafeInteger(value) && value >= 0
const validPositiveFrameCount = (value: number) => Number.isSafeInteger(value) && value > 0

const validateNonnegativeFrameCount = (value: number, name: string) => {
  if (!validNonnegativeFrameCount(value)) throw new Error(`WSOLA ${name} must be a finite nonnegative safe integer.`)
}

const validatePositiveFrameCount = (value: number, name: string) => {
  if (!validPositiveFrameCount(value)) throw new Error(`WSOLA ${name} must be a positive safe integer.`)
}

const validateSampleRate = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) throw new Error('WSOLA sample rate must be finite and positive.')
}

const validateChannelCount = (value: number, allowZero: boolean) => {
  const valid = Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0)
  if (!valid) {
    throw new Error(`WSOLA channel count must be a finite ${allowZero ? 'nonnegative' : 'positive'} safe integer.`)
  }
  if (value > WSOLA_MAX_CHANNEL_COUNT) {
    throw new Error(`WSOLA channel count exceeds the supported limit of ${WSOLA_MAX_CHANNEL_COUNT}.`)
  }
}

const validateOption = (value: number | undefined, name: string, maximum: number, allowZero: boolean) => {
  if (value === undefined) return
  const valid = Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0)
  if (!valid) {
    throw new Error(`WSOLA ${name} must be a finite ${allowZero ? 'nonnegative' : 'positive'} safe integer.`)
  }
  if (value > maximum) throw new Error(`WSOLA ${name} exceeds the supported limit of ${maximum}.`)
}

const validateStretchConfig = (config: WsolaStretchConfig) => {
  validateNonnegativeFrameCount(config.outputFrameCount, 'output frame count')
  validateOption(config.windowFrameCount, 'window frame count', WSOLA_MAX_WINDOW_FRAMES, false)
  validateOption(config.overlapFrameCount, 'overlap frame count', WSOLA_MAX_OVERLAP_FRAMES, true)
  validateOption(config.searchFrameCount, 'search frame count', WSOLA_MAX_SEARCH_FRAMES, true)
  validateOption(config.sourceChunkFrameCount, 'source chunk frame count', WSOLA_MAX_SOURCE_CHUNK_FRAMES, false)
}

const validateSourceMetadata = (source: WsolaPcmSource) => {
  validateSampleRate(source.sampleRate)
  validateChannelCount(source.channelCount, true)
  validateNonnegativeFrameCount(source.frameCount, 'source frame count')
  if (!Number.isSafeInteger(source.frameCount * source.channelCount)) {
    throw new Error('WSOLA source frame and channel counts exceed the safe arithmetic range.')
  }
  if (source.frameCount > 0 && source.channelCount === 0) {
    throw new Error('WSOLA sources with frames must have at least one channel.')
  }
}

const validateTransactionMetadata = (metadata: WsolaPcmTransactionMetadata) => {
  validateSampleRate(metadata.sampleRate)
  validateChannelCount(metadata.channelCount, true)
  validateNonnegativeFrameCount(metadata.frameCount, 'transaction frame count')
  if (metadata.frameCount > 0 && metadata.channelCount === 0) {
    throw new Error('WSOLA transactions with frames must have at least one channel.')
  }
}

const validateChunk = (chunk: WsolaPcmChunk, channelCount: number) => {
  if (!chunk || !Array.isArray(chunk.channels)) throw new Error('WSOLA PCM chunk is invalid.')
  if (chunk.channels.length !== channelCount) throw new Error('WSOLA PCM chunk channel count changed.')
  const frameCount = chunk.channels[0]?.length ?? 0
  if (!validPositiveFrameCount(frameCount)) throw new Error('WSOLA PCM chunks must contain a positive safe frame count.')
  for (const channel of chunk.channels) {
    if (!(channel instanceof Float32Array)) throw new Error('WSOLA PCM chunk channels must be Float32Array values.')
    if (channel.length !== frameCount) throw new Error('WSOLA PCM chunk channels must have matching frame counts.')
  }
}

const validateFiniteChunk = (chunk: WsolaPcmChunk) => {
  for (const channel of chunk.channels) {
    for (let frame = 0; frame < channel.length; frame += 1) {
      if (!Number.isFinite(channel[frame])) throw new Error('WSOLA bounded sources require finite PCM samples.')
    }
  }
}

const splitChunk = function* (chunk: WsolaPcmChunk, maximumFrames: number): Iterable<WsolaPcmChunk> {
  const frameCount = chunk.channels[0]?.length ?? 0
  for (let startFrame = 0; startFrame < frameCount; startFrame += maximumFrames) {
    const endFrame = Math.min(frameCount, startFrame + maximumFrames)
    yield { channels: chunk.channels.map((channel) => channel.subarray(startFrame, endFrame)) }
  }
}

const createArraySource = (input: AudioStretchInput, chunkFrameCount: number): WsolaPcmSource => ({
  sampleRate: input.sampleRate,
  channelCount: input.channels.length,
  frameCount: input.channels[0]?.length ?? 0,
  replay: function* (signal) {
    const frameCount = input.channels[0]?.length ?? 0
    for (let startFrame = 0; startFrame < frameCount; startFrame += chunkFrameCount) {
      throwIfAborted(signal)
      const endFrame = Math.min(frameCount, startFrame + chunkFrameCount)
      yield { channels: input.channels.map((channel) => channel.subarray(startFrame, endFrame)) }
    }
  },
  dispose: () => {},
})

type CleanupFailure = { readonly error: unknown }
const NO_PRIMARY = Symbol('no-primary')

const throwWithCleanup = (primary: CleanupFailure, cleanupErrors: unknown[]): never => {
  if (cleanupErrors.length === 0) throw primary.error
  throw new AggregateError([primary.error, ...cleanupErrors], 'WSOLA operation and cleanup both failed.')
}

const disposeResources = (
  disposers: Array<() => void>,
  primary: CleanupFailure | typeof NO_PRIMARY = NO_PRIMARY,
): void => {
  const cleanupErrors: unknown[] = []
  for (const dispose of disposers) {
    try {
      dispose()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (primary !== NO_PRIMARY) throwWithCleanup(primary, cleanupErrors)
  if (cleanupErrors.length === 1) throw cleanupErrors[0]
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'WSOLA cleanup failed.')
}

const resolveEvenFrameCount = (value: number | undefined, fallback: number) => {
  const frameCount = value !== undefined ? Math.max(2, value) : fallback
  return frameCount % 2 === 0 ? frameCount : frameCount - 1
}

type EffectiveStreamOptions = WsolaSinglePassMemoryBounds & {
  windowFrameCount: number
  overlapFrameCount: number
  searchFrameCount: number
  synthesisHop: number
  scoreSamplesPerOutputWindow: number
  workingMemoryBytes: number
}

const getCandidateCount = (inputFrameCount: number, overlapFrameCount: number, searchFrameCount: number) => {
  const availableStarts = Math.max(1, inputFrameCount - overlapFrameCount + 1)
  return Math.min(availableStarts, searchFrameCount * 2 + 1)
}

const getEffectiveStreamOptions = (
  inputFrameCount: number,
  outputFrameCount: number,
  channelCount: number,
  config: WsolaStretchConfig,
): EffectiveStreamOptions => {
  const windowFrameCount = Math.min(inputFrameCount, resolveEvenFrameCount(config.windowFrameCount, DEFAULT_WINDOW_FRAMES))
  const overlapFrameCount = Math.min(
    Math.max(0, windowFrameCount - 1),
    resolveEvenFrameCount(config.overlapFrameCount, Math.min(DEFAULT_OVERLAP_FRAMES, Math.floor(windowFrameCount / 2))),
  )
  const synthesisHop = Math.max(1, windowFrameCount - overlapFrameCount)
  const searchFrameCount = config.searchFrameCount ?? DEFAULT_SEARCH_FRAMES
  const inputRingFrameCapacity = Math.max(windowFrameCount, windowFrameCount + searchFrameCount * 2)
  const candidateCount = getCandidateCount(inputFrameCount, overlapFrameCount, searchFrameCount)
  const scoreSamplesPerOutputWindow = candidateCount * overlapFrameCount
  if (!Number.isSafeInteger(scoreSamplesPerOutputWindow)
    || scoreSamplesPerOutputWindow > WSOLA_MAX_SCORE_SAMPLES_PER_OUTPUT_WINDOW) {
    throw new Error('WSOLA overlap scoring exceeds the supported work limit.')
  }

  const maxEmitFrames = Math.min(synthesisHop, outputFrameCount)
  const persistentElements = channelCount * inputRingFrameCapacity
    + inputRingFrameCapacity
    + channelCount * overlapFrameCount
    + overlapFrameCount
  const replacementPendingElements = channelCount * overlapFrameCount + overlapFrameCount
  const windowElements = channelCount * windowFrameCount + windowFrameCount
  const emittedElements = channelCount * maxEmitFrames
  const workingElements = persistentElements + replacementPendingElements + windowElements + emittedElements
  const workingMemoryBytes = workingElements * FLOAT32_BYTES
  if (!Number.isSafeInteger(workingMemoryBytes) || workingMemoryBytes > WSOLA_MAX_PIPELINE_WORKING_MEMORY_BYTES) {
    throw new Error('WSOLA stream working memory exceeds the supported limit.')
  }
  return {
    inputRingFrameCapacity,
    overlapFrameCapacity: overlapFrameCount,
    windowFrameCount,
    overlapFrameCount,
    searchFrameCount,
    synthesisHop,
    scoreSamplesPerOutputWindow,
    workingMemoryBytes,
  }
}

const validateStreamRequest = (options: WsolaSinglePassStreamOptions) => {
  validatePositiveFrameCount(options.inputFrameCount, 'stream input frame count')
  validateChannelCount(options.channelCount, false)
  validateSampleRate(options.sampleRate)
  validateStretchConfig(options)
  validatePositiveFrameCount(options.outputFrameCount, 'stream output frame count')
  const stretchRatio = options.outputFrameCount / options.inputFrameCount
  assert(
    stretchRatio >= MIN_STRETCH_RATIO && stretchRatio <= MAX_STRETCH_RATIO,
    'WSOLA stream only accepts a single supported stretch-ratio pass',
  )
  return getEffectiveStreamOptions(options.inputFrameCount, options.outputFrameCount, options.channelCount, options)
}

const validatePipelineRequest = (source: WsolaPcmSource, config: WsolaStretchConfig) => {
  validateSourceMetadata(source)
  validateStretchConfig(config)
  if (source.channelCount === 0 && config.outputFrameCount > 0) {
    throw new Error('WSOLA bounded sources cannot produce positive frames with zero channels.')
  }
  const outputFrameCount = config.outputFrameCount
  const inputFrameCount = source.frameCount
  const stageFrameCounts = inputFrameCount > 0 && outputFrameCount > 0
    ? getStageFrameCounts(inputFrameCount, outputFrameCount)
    : [inputFrameCount, outputFrameCount]
  const requestedChunkFrames = config.sourceChunkFrameCount ?? DEFAULT_SOURCE_CHUNK_FRAMES
  const chunkFrameCount = requestedChunkFrames
  if (inputFrameCount === 0 || outputFrameCount === 0) {
    return {
      stageFrameCounts,
      chunkFrameCount,
      inputRingFrameCapacity: 0,
      overlapFrameCapacity: 0,
      pipelineWorkingMemoryBytes: source.channelCount * chunkFrameCount * FLOAT32_BYTES,
    }
  }
  // Source chunks are caller-owned and only viewed through subarrays. Their
  // storage is intentionally excluded after the per-chunk bound is enforced.
  let pipelineWorkingMemoryBytes = 0
  let inputRingFrameCapacity = 0
  let overlapFrameCapacity = 0
  let maxOutputChunkFrames = 0
  for (let index = 1; index < stageFrameCounts.length; index += 1) {
    const inputFrames = stageFrameCounts[index - 1]
    const outputFrames = stageFrameCounts[index]
    if (inputFrames === undefined || outputFrames === undefined) throw new Error('WSOLA stage frame count is missing.')
    if (inputFrames === outputFrames || Math.abs(outputFrames / inputFrames - 1) <= 1 / Math.max(1, inputFrames)) {
      continue
    }
    const streamOptions = validateStreamRequest({
      ...config,
      inputFrameCount: inputFrames,
      outputFrameCount: outputFrames,
      channelCount: source.channelCount,
      sampleRate: source.sampleRate,
    })
    pipelineWorkingMemoryBytes += streamOptions.workingMemoryBytes
    inputRingFrameCapacity = Math.max(inputRingFrameCapacity, streamOptions.inputRingFrameCapacity)
    overlapFrameCapacity = Math.max(overlapFrameCapacity, streamOptions.overlapFrameCapacity)
    maxOutputChunkFrames = Math.max(maxOutputChunkFrames, Math.min(streamOptions.synthesisHop, outputFrames))
  }
  pipelineWorkingMemoryBytes += source.channelCount * maxOutputChunkFrames * FLOAT32_BYTES
  if (!Number.isSafeInteger(pipelineWorkingMemoryBytes)
    || pipelineWorkingMemoryBytes > WSOLA_MAX_PIPELINE_WORKING_MEMORY_BYTES) {
    throw new Error('WSOLA pipeline working memory exceeds the supported limit.')
  }
  return {
    stageFrameCounts,
    chunkFrameCount,
    inputRingFrameCapacity,
    overlapFrameCapacity,
    pipelineWorkingMemoryBytes,
  }
}

export function createWsolaSinglePassStream(options: WsolaSinglePassStreamOptions) {
  const effective = validateStreamRequest(options)
  const inputFrameCount = options.inputFrameCount
  const outputFrameCount = options.outputFrameCount
  const windowFrameCount = effective.windowFrameCount
  const overlapFrameCount = effective.overlapFrameCount
  const synthesisHop = effective.synthesisHop
  const searchFrameCount = effective.searchFrameCount
  const inputRingFrameCapacity = effective.inputRingFrameCapacity
  const inputRings = Array.from({ length: options.channelCount }, () => new Float32Array(inputRingFrameCapacity))
  const monoRing = new Float32Array(inputRingFrameCapacity)
  let pendingChannels = Array.from({ length: options.channelCount }, () => new Float32Array(overlapFrameCount))
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
    if (frame < framesSeen - inputRingFrameCapacity) throw new Error('WSOLA stream source history was overwritten before use.')
    if (frame >= framesSeen) throw new Error('WSOLA stream requested source audio before it was supplied.')
    return inputRings[channel]?.[frame % inputRingFrameCapacity] ?? 0
  }

  const monoSampleAt = (frame: number) => {
    if (frame < 0 || frame >= inputFrameCount) return 0
    if (frame < framesSeen - inputRingFrameCapacity) throw new Error('WSOLA stream analysis history was overwritten before use.')
    if (frame >= framesSeen) throw new Error('WSOLA stream requested analysis audio before it was supplied.')
    return monoRing[frame % inputRingFrameCapacity] ?? 0
  }

  const emit = (channels: Float32Array[], frameCount: number, write: WsolaOutputWriter, signal?: AbortSignal) => {
    if (frameCount <= 0) return
    throwIfAborted(signal)
    const output = channels.map((channel) => channel.slice(0, frameCount))
    for (const channel of output) {
      for (let frame = 0; frame < channel.length; frame += 1) outputPeak = Math.max(outputPeak, Math.abs(channel[frame] ?? 0))
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

  const initialize = (write: WsolaOutputWriter, signal?: AbortSignal) => {
    const frameCount = Math.min(windowFrameCount, outputFrameCount)
    const windowChannels = Array.from({ length: options.channelCount }, () => new Float32Array(frameCount))
    const windowMono = new Float32Array(frameCount)
    for (let frame = 0; frame < frameCount; frame += 1) {
      if ((frame & 4095) === 0) throwIfAborted(signal)
      for (let channel = 0; channel < options.channelCount; channel += 1) {
        const target = windowChannels[channel]
        if (!target) throw new Error('WSOLA stream output channel is missing.')
        target[frame] = sourceSampleAt(channel, frame)
      }
      windowMono[frame] = monoSampleAt(frame)
    }
    const emitFrameCount = Math.min(synthesisHop, frameCount)
    emit(windowChannels, emitFrameCount, write, signal)
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

  const scoreOverlap = (inputStart: number, signal?: AbortSignal) => {
    let correlation = 0
    let inputEnergy = 0
    let outputEnergy = 0
    for (let frame = 0; frame < overlapFrameCount; frame += 1) {
      if ((frame & 255) === 0) throwIfAborted(signal)
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
    const stretchRatio = outputFrameCount / inputFrameCount
    const expectedInputStart = Math.round(nextOutputStart / stretchRatio)
    const maxInputStart = Math.min(inputFrameCount - overlapFrameCount, expectedInputStart + searchFrameCount)
    const outputWindowFrameCount = Math.min(windowFrameCount, outputFrameCount - nextOutputStart)
    return Math.min(inputFrameCount, Math.max(0, maxInputStart) + Math.max(overlapFrameCount, outputWindowFrameCount))
  }

  const processNextWindow = (write: WsolaOutputWriter, signal?: AbortSignal) => {
    throwIfAborted(signal)
    const stretchRatio = outputFrameCount / inputFrameCount
    const expectedInputStart = Math.round(nextOutputStart / stretchRatio)
    const minInputStart = Math.max(0, expectedInputStart - searchFrameCount)
    const maxInputStart = Math.min(inputFrameCount - overlapFrameCount, expectedInputStart + searchFrameCount)
    let bestInputStart = Math.max(0, Math.min(expectedInputStart, maxInputStart))
    let bestScore = -Infinity
    for (let inputStart = minInputStart; inputStart <= maxInputStart; inputStart += 1) {
      throwIfAborted(signal)
      const score = scoreOverlap(inputStart, signal)
      if (score > bestScore) {
        bestScore = score
        bestInputStart = inputStart
      }
    }
    const frameCount = Math.min(windowFrameCount, outputFrameCount - nextOutputStart)
    const windowChannels = Array.from({ length: options.channelCount }, () => new Float32Array(frameCount))
    const windowMono = new Float32Array(frameCount)
    for (let frame = 0; frame < frameCount; frame += 1) {
      if ((frame & 4095) === 0) throwIfAborted(signal)
      const inputMono = monoSampleAt(bestInputStart + frame)
      const fadeIn = overlapFrameCount > 0 ? frame / overlapFrameCount : 1
      windowMono[frame] = frame < overlapFrameCount ? (pendingMono[frame] ?? 0) * (1 - fadeIn) + inputMono * fadeIn : inputMono
      for (let channel = 0; channel < options.channelCount; channel += 1) {
        const target = windowChannels[channel]
        if (!target) throw new Error('WSOLA stream output channel is missing.')
        const inputSample = sourceSampleAt(channel, bestInputStart + frame)
        target[frame] = frame < overlapFrameCount
          ? (pendingChannels[channel]?.[frame] ?? 0) * (1 - fadeIn) + inputSample * fadeIn
          : inputSample
      }
    }
    const emitFrameCount = Math.min(synthesisHop, frameCount)
    emit(windowChannels, emitFrameCount, write, signal)
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

  const drain = (write: WsolaOutputWriter, signal?: AbortSignal) => {
    const initialFrameCount = Math.min(inputFrameCount, Math.min(windowFrameCount, outputFrameCount))
    if (!initialized && framesSeen >= initialFrameCount) initialize(write, signal)
    while (initialized && nextOutputStart < outputFrameCount && framesSeen >= requiredSourceEndFrame()) {
      processNextWindow(write, signal)
    }
  }

  const push = (channels: Float32Array[], write: WsolaOutputWriter, signal = options.signal) => {
    if (state !== 'active') throw new Error('WSOLA stream cannot accept audio after finish.')
    throwIfAborted(signal)
    if (channels.length !== options.channelCount) throw new Error('WSOLA stream channel count changed.')
    const frameCount = channels[0]?.length ?? 0
    for (const channel of channels) {
      if (channel.length !== frameCount) throw new Error('WSOLA stream input channels must have matching frame counts.')
    }
    if (framesSeen + frameCount > inputFrameCount) throw new Error('WSOLA stream received more source frames than declared.')
    const channelGain = 1 / options.channelCount
    try {
      for (let localFrame = 0; localFrame < frameCount; localFrame += 1) {
        if ((localFrame & 4095) === 0) throwIfAborted(signal)
        let mono = 0
        const ringIndex = framesSeen % inputRingFrameCapacity
        for (let channel = 0; channel < options.channelCount; channel += 1) {
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
        drain(write, signal)
      }
    } catch (error) {
      state = 'failed'
      throw error
    }
  }

  const finish = (write: WsolaOutputWriter, signal = options.signal): WsolaSinglePassStats => {
    if (state === 'finished') {
      if (!finishedStats) throw new Error('WSOLA stream finished without completion statistics.')
      return finishedStats
    }
    if (state === 'emitting') throw new Error('WSOLA stream output emission is already in progress.')
    if (state === 'finishing') throw new Error('WSOLA stream finish is already in progress.')
    if (state === 'failed') throw new Error('WSOLA stream cannot finish after a failed completion.')
    throwIfAborted(signal)
    if (framesSeen !== inputFrameCount) throw new Error('WSOLA stream ended before every declared source frame was supplied.')
    state = 'finishing'
    try {
      drain(write, signal)
      while (nextOutputStart < outputFrameCount) processNextWindow(write, signal)
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

  return {
    push,
    finish,
    memoryBounds: (): WsolaSinglePassMemoryBounds => ({
      inputRingFrameCapacity,
      overlapFrameCapacity: effective.overlapFrameCapacity,
    }),
  }
}

const getStageFrameCounts = (inputFrameCount: number, outputFrameCount: number) => {
  const stages = [inputFrameCount]
  let current = inputFrameCount
  while (true) {
    const ratio = outputFrameCount / current
    if (ratio >= MIN_STRETCH_RATIO && ratio <= MAX_STRETCH_RATIO) {
      stages.push(outputFrameCount)
      return stages
    }
    const next = ratio < MIN_STRETCH_RATIO
      ? Math.max(outputFrameCount + 1, Math.ceil(current * MIN_STRETCH_RATIO))
      : Math.min(outputFrameCount, Math.ceil(current * MAX_STRETCH_RATIO))
    validatePositiveFrameCount(next, 'stage frame count')
    stages.push(next)
    if (next === current || next === outputFrameCount) return stages
    current = next
  }
}

export const getWsolaStageFrameCounts = (inputFrameCount: number, outputFrameCount: number) => {
  if (!validPositiveFrameCount(inputFrameCount) || !validPositiveFrameCount(outputFrameCount)) {
    throw new Error('WSOLA stage frame counts must be positive safe integers.')
  }
  return getStageFrameCounts(inputFrameCount, outputFrameCount)
}

const isEffectivelyOneX = (inputFrameCount: number, outputFrameCount: number) => (
  inputFrameCount === outputFrameCount
  || Math.abs(outputFrameCount / inputFrameCount - 1) <= 1 / Math.max(1, inputFrameCount)
)

const createMaterializingCompatibilityTransaction = (
  metadata: WsolaPcmTransactionMetadata,
): WsolaPcmTransaction => {
  validateTransactionMetadata(metadata)
  let state: 'open' | 'failed' | 'committed' | 'aborted' = 'open'
  let writtenFrames = 0
  const stored: WsolaPcmChunk[] = []
  return {
    append: (chunk) => {
      if (state !== 'open') throw new Error('WSOLA PCM transaction is no longer writable.')
      try {
        validateChunk(chunk, metadata.channelCount)
        const frameCount = chunk.channels[0]?.length ?? 0
        if (frameCount > metadata.frameCount - writtenFrames) {
          throw new Error('WSOLA PCM transaction received more frames than declared.')
        }
        stored.push({ channels: chunk.channels.map((channel) => channel.slice()) })
        writtenFrames += frameCount
      } catch (error) {
        state = 'failed'
        throw error
      }
    },
    commit: () => {
      if (state !== 'open') throw new Error('WSOLA PCM transaction cannot commit after failure or abort.')
      if (writtenFrames !== metadata.frameCount) {
        state = 'failed'
        throw new Error('WSOLA PCM transaction ended with the wrong frame count.')
      }
      state = 'committed'
      let disposed = false
      return Object.freeze({
        ...metadata,
        replay: function* (signal) {
          if (disposed) throw new Error('WSOLA PCM source has been disposed.')
          for (const chunk of stored) {
            throwIfAborted(signal)
            yield { channels: chunk.channels.map((channel) => channel.slice()) }
          }
        },
        dispose: () => {
          if (disposed) return
          disposed = true
          stored.length = 0
        },
      })
    },
    abort: () => {
      if (state === 'aborted' || state === 'committed') return
      state = 'aborted'
      stored.length = 0
    },
  }
}

/**
 * Materializes PCM in JavaScript memory for compatibility callers and tests.
 * This is not a bounded-storage adapter for createWsolaBoundedSource.
 */
export const createWsolaMaterializingCompatibilityTransaction: WsolaPcmTransactionFactory =
  createMaterializingCompatibilityTransaction

type ExactForwarder = {
  push: (chunk: WsolaPcmChunk) => void
  finish: () => { inputPeak: number; outputPeak: number }
}

const createExactForwarder = (
  inputFrameCount: number,
  outputFrameCount: number,
  channelCount: number,
  write: WsolaOutputWriter,
  chunkFrameCount: number,
): ExactForwarder => {
  let inputFrames = 0
  let outputFrames = 0
  let finished = false
  let inputPeak = 0
  let outputPeak = 0
  const forward = (channels: Float32Array[], frameCount: number) => {
    if (frameCount <= 0) return
    for (const channel of channels) {
      for (let frame = 0; frame < frameCount; frame += 1) {
        outputPeak = Math.max(outputPeak, Math.abs(channel[frame] ?? 0))
      }
    }
    write(channels.map((channel) => channel.subarray(0, frameCount)))
    outputFrames += frameCount
  }
  return {
    push: (chunk) => {
      if (finished) throw new Error('WSOLA exact adapter is no longer writable.')
      validateChunk(chunk, channelCount)
      const frameCount = chunk.channels[0]?.length ?? 0
      if (inputFrames + frameCount > inputFrameCount) {
        throw new Error('WSOLA exact adapter received more frames than declared.')
      }
      for (const channel of chunk.channels) {
        for (const sample of channel) inputPeak = Math.max(inputPeak, Math.abs(sample))
      }
      const remaining = outputFrameCount - outputFrames
      forward(chunk.channels, Math.min(frameCount, Math.max(0, remaining)))
      inputFrames += frameCount
    },
    finish: () => {
      if (finished) return { inputPeak, outputPeak }
      finished = true
      if (inputFrames !== inputFrameCount) throw new Error('WSOLA exact adapter ended with the wrong input frame count.')
      while (outputFrames < outputFrameCount) {
        const frameCount = Math.min(chunkFrameCount, outputFrameCount - outputFrames)
        write(Array.from({ length: channelCount }, () => new Float32Array(frameCount)))
        outputFrames += frameCount
      }
      if (outputFrames !== outputFrameCount) throw new Error('WSOLA exact adapter produced the wrong output frame count.')
      return { inputPeak, outputPeak }
    },
  }
}

const createMaterializingTransaction = (
  metadata: WsolaPcmTransactionMetadata,
  channels: Float32Array[],
): WsolaPcmTransaction => {
  validateTransactionMetadata(metadata)
  let state: 'open' | 'failed' | 'committed' | 'aborted' = 'open'
  let writtenFrames = 0
  return {
    append: (chunk) => {
      if (state !== 'open') throw new Error('WSOLA PCM transaction is no longer writable.')
      try {
        validateChunk(chunk, metadata.channelCount)
        const frameCount = chunk.channels[0]?.length ?? 0
        if (frameCount > metadata.frameCount - writtenFrames) {
          throw new Error('WSOLA PCM transaction received more frames than declared.')
        }
        for (let channel = 0; channel < metadata.channelCount; channel += 1) {
          const target = channels[channel]
          const input = chunk.channels[channel]
          if (!target || !input) throw new Error('WSOLA PCM transaction channel is missing.')
          target.set(input, writtenFrames)
        }
        writtenFrames += frameCount
      } catch (error) {
        state = 'failed'
        throw error
      }
    },
    commit: () => {
      if (state !== 'open') throw new Error('WSOLA PCM transaction cannot commit after failure or abort.')
      if (writtenFrames !== metadata.frameCount) {
        state = 'failed'
        throw new Error('WSOLA PCM transaction ended with the wrong frame count.')
      }
      state = 'committed'
      let disposed = false
      return Object.freeze({
        ...metadata,
        replay: function* (signal) {
          if (disposed) throw new Error('WSOLA PCM source has been disposed.')
          if (metadata.frameCount === 0) return
          for (let startFrame = 0; startFrame < metadata.frameCount; startFrame += DEFAULT_SOURCE_CHUNK_FRAMES) {
            throwIfAborted(signal)
            const endFrame = Math.min(metadata.frameCount, startFrame + DEFAULT_SOURCE_CHUNK_FRAMES)
            yield { channels: channels.map((channel) => channel.slice(startFrame, endFrame)) }
          }
        },
        dispose: () => { disposed = true },
      })
    },
    abort: () => {
      if (state === 'aborted' || state === 'committed') return
      state = 'aborted'
    },
  }
}

type PipelineStage = {
  push: (chunk: WsolaPcmChunk) => void
  finish: () => void
}

const createBoundedSource = (
  sourceInput: WsolaPcmSource,
  config: InternalStretchConfig,
): WsolaBoundedSourceResult => {
  let transaction: WsolaPcmTransaction | undefined
  let committed: WsolaPcmSource | undefined
  try {
    const validated = validatePipelineRequest(sourceInput, config)
    throwIfAborted(config.signal)
    const stages = validated.stageFrameCounts
    const stats: WsolaBoundedMemoryStats = {
      stageFrameCounts: stages,
      stageInputPeaks: [],
      stageRawOutputPeaks: [],
      stageGains: [],
      maxSourceChunkFrames: 0,
      maxOutputChunkFrames: 0,
      inputRingFrameCapacity: validated.inputRingFrameCapacity,
      overlapFrameCapacity: validated.overlapFrameCapacity,
      pipelineWorkingMemoryBytes: validated.pipelineWorkingMemoryBytes,
    }
    const finalFrameCount = config.outputFrameCount
    const metadata = {
      sampleRate: sourceInput.sampleRate,
      channelCount: sourceInput.channelCount,
      frameCount: finalFrameCount,
    }
    transaction = config.createTransaction(metadata)
    if (sourceInput.frameCount === 0 || finalFrameCount === 0) {
      if (finalFrameCount > 0) {
        for (let startFrame = 0; startFrame < finalFrameCount; startFrame += validated.chunkFrameCount) {
          throwIfAborted(config.signal)
          const frameCount = Math.min(validated.chunkFrameCount, finalFrameCount - startFrame)
          transaction.append({
            channels: Array.from({ length: sourceInput.channelCount }, () => new Float32Array(frameCount)),
          })
          throwIfAborted(config.signal)
        }
      }
      throwIfAborted(config.signal)
      committed = transaction.commit()
      throwIfAborted(config.signal)
      if (
        committed.sampleRate !== metadata.sampleRate
        || committed.channelCount !== metadata.channelCount
        || committed.frameCount !== metadata.frameCount
      ) {
        throw new Error('WSOLA transaction committed source metadata does not match the requested output.')
      }
      validateSourceMetadata(committed)
      let disposed = false
      const outputSource = Object.freeze({
        ...committed,
        dispose: () => {
          if (disposed) return
          disposed = true
          disposeResources([committed?.dispose ?? (() => {}), sourceInput.dispose])
        },
      })
      return Object.freeze({
        source: outputSource,
        stats,
      })
    }
    const stagesByIndex: PipelineStage[] = []
    let outputFrames = 0
    const writeStage = (stageIndex: number, channels: Float32Array[]) => {
      validateChunk({ channels }, sourceInput.channelCount)
      stats.maxOutputChunkFrames = Math.max(stats.maxOutputChunkFrames, channels[0]?.length ?? 0)
      const next = stagesByIndex[stageIndex + 1]
      if (next) {
        next.push({ channels })
        return
      }
      const output = { channels }
      if (!config.allowNonFinite) validateFiniteChunk(output)
      outputFrames += channels[0]?.length ?? 0
      transaction?.append(output)
    }
    for (let index = sourceInput.frameCount > 0 && finalFrameCount > 0 ? 1 : stages.length; index < stages.length; index += 1) {
      const inputFrames = stages[index - 1]
      const outputFrames = stages[index]
      if (inputFrames === undefined || outputFrames === undefined) throw new Error('WSOLA stage frame count is missing.')
      const write = (channels: Float32Array[]) => writeStage(index, channels)
      if (isEffectivelyOneX(inputFrames, outputFrames)) {
        const exactForwarder = createExactForwarder(
          inputFrames,
          outputFrames,
          sourceInput.channelCount,
          write,
          validated.chunkFrameCount,
        )
        stagesByIndex[index] = {
          push: exactForwarder.push,
          finish: () => {
            const peaks = exactForwarder.finish()
            if (!config.allowNonFinite && (!Number.isFinite(peaks.inputPeak) || !Number.isFinite(peaks.outputPeak))) {
              throw new Error('WSOLA bounded sources require finite PCM peaks.')
            }
            if (!config.allowNonFinite && peaks.outputPeak > peaks.inputPeak + PEAK_EPSILON) {
              throw new Error('WSOLA stage exceeded its finite convex peak invariant.')
            }
            stats.stageInputPeaks.push(peaks.inputPeak)
            stats.stageRawOutputPeaks.push(peaks.outputPeak)
            stats.stageGains.push(1)
          },
        }
        continue
      }
      const stream = createWsolaSinglePassStream({
        ...config,
        inputFrameCount: inputFrames,
        outputFrameCount: outputFrames,
        channelCount: sourceInput.channelCount,
        sampleRate: sourceInput.sampleRate,
      })
      stagesByIndex[index] = {
        push: (chunk) => stream.push(chunk.channels, write, config.signal),
        finish: () => {
          const streamStats = stream.finish(write, config.signal)
          if (!config.allowNonFinite && (!Number.isFinite(streamStats.inputPeak) || !Number.isFinite(streamStats.outputPeak))) {
            throw new Error('WSOLA bounded sources require finite PCM peaks.')
          }
          if (!config.allowNonFinite && streamStats.outputPeak > streamStats.inputPeak + PEAK_EPSILON) {
            throw new Error('WSOLA stage exceeded its finite convex peak invariant.')
          }
          stats.stageInputPeaks.push(streamStats.inputPeak)
          stats.stageRawOutputPeaks.push(streamStats.outputPeak)
          stats.stageGains.push(1)
        },
      }
    }

    let sourceFrames = 0
    const feedFirstStage = (chunk: WsolaPcmChunk) => {
      if (stages.length === 1) {
        stats.maxOutputChunkFrames = Math.max(stats.maxOutputChunkFrames, chunk.channels[0]?.length ?? 0)
        transaction?.append(chunk)
        outputFrames += chunk.channels[0]?.length ?? 0
        return
      }
      const first = stagesByIndex[1]
      if (!first) throw new Error('WSOLA first stage is missing.')
      first.push(chunk)
    }
    if (sourceInput.frameCount > 0 && finalFrameCount > 0) {
      for (const chunk of sourceInput.replay(config.signal)) {
        throwIfAborted(config.signal)
        validateChunk(chunk, sourceInput.channelCount)
        const originalFrameCount = chunk.channels[0]?.length ?? 0
        if (originalFrameCount > validated.chunkFrameCount) {
          throw new Error('WSOLA PCM source yielded a chunk larger than the configured source chunk frame limit.')
        }
        if (!config.allowNonFinite) validateFiniteChunk(chunk)
        for (const bounded of splitChunk(chunk, validated.chunkFrameCount)) {
          const frameCount = bounded.channels[0]?.length ?? 0
          stats.maxSourceChunkFrames = Math.max(stats.maxSourceChunkFrames, frameCount)
          sourceFrames += frameCount
          feedFirstStage(bounded)
        }
      }
      if (sourceFrames !== sourceInput.frameCount) {
        throw new Error('WSOLA PCM source replay produced the wrong frame count.')
      }
      throwIfAborted(config.signal)
    }
    for (let index = sourceInput.frameCount > 0 && finalFrameCount > 0 ? 1 : stages.length; index < stages.length; index += 1) {
      const stage = stagesByIndex[index]
      if (!stage) throw new Error('WSOLA pipeline stage is missing.')
      throwIfAborted(config.signal)
      stage.finish()
    }
    throwIfAborted(config.signal)
    if (outputFrames !== finalFrameCount) {
      throw new Error('WSOLA pipeline produced the wrong output frame count.')
    }
    throwIfAborted(config.signal)
    committed = transaction.commit()
    throwIfAborted(config.signal)
    if (
      committed.sampleRate !== metadata.sampleRate
      || committed.channelCount !== metadata.channelCount
      || committed.frameCount !== metadata.frameCount
    ) {
      throw new Error('WSOLA transaction committed source metadata does not match the requested output.')
    }
    validateSourceMetadata(committed)
    const outputSource = committed
    let disposed = false
    const ownedSource = Object.freeze({
      ...outputSource,
      dispose: () => {
        if (disposed) return
        disposed = true
        disposeResources([outputSource.dispose, sourceInput.dispose])
      },
    })
    return { source: ownedSource, stats }
  } catch (error) {
    const disposers: Array<() => void> = []
    if (transaction) disposers.push(transaction.abort)
    if (committed) disposers.push(committed.dispose)
    disposers.push(sourceInput.dispose)
    disposeResources(disposers, { error })
    throw error
  }
}

/**
 * Builds a bounded WSOLA source using caller-owned transactional storage.
 * The transaction may store the duration-sized result externally, but its
 * adapter is responsible for keeping resident memory bounded.
 */
export const createWsolaBoundedSource = (
  sourceInput: WsolaPcmSource,
  config: WsolaBoundedSourceConfig,
): WsolaBoundedSourceResult => createBoundedSource(sourceInput, config)

const validateMaterializedOutput = (channelCount: number, outputFrameCount: number) => {
  if (outputFrameCount > MAX_TYPED_ARRAY_LENGTH) {
    throw new Error('WSOLA materialized frame count exceeds the typed-array representation limit.')
  }
  const outputBytes = channelCount * outputFrameCount * FLOAT32_BYTES
  if (!Number.isSafeInteger(outputBytes) || outputBytes > WSOLA_MAX_MATERIALIZED_OUTPUT_BYTES) {
    throw new Error('WSOLA materialized output exceeds the 256 MiB compatibility limit.')
  }
}

const getPeak = (channels: Float32Array[]) => {
  let peak = 0
  for (const channel of channels) {
    for (const sample of channel) peak = Math.max(peak, Math.abs(sample))
  }
  return peak
}

type LegacyNormalizationResult = {
  channels: Float32Array[]
  gain: number
}

const normalizeLegacyStage = (
  channels: Float32Array[],
  inputPeak: number,
): LegacyNormalizationResult => {
  const outputPeak = getPeak(channels)
  const maxPeak = inputPeak + PEAK_EPSILON
  if (outputPeak <= maxPeak || outputPeak <= 0) return { channels, gain: 1 }
  const gain = maxPeak / outputPeak
  for (const channel of channels) {
    for (let frame = 0; frame < channel.length; frame += 1) {
      channel[frame] = (channel[frame] ?? 0) * gain
    }
  }
  return { channels, gain }
}

const stretchNonFiniteCompatibility = (
  input: AudioStretchInput,
  config: WsolaStretchConfig,
  preflight: ReturnType<typeof validatePipelineRequest>,
): WsolaBoundedResult => {
  const stages = preflight.stageFrameCounts
  let channels = input.channels
  const stageInputPeaks: number[] = []
  const stageRawOutputPeaks: number[] = []
  const stageGains: number[] = []
  let maxSourceChunkFrames = 0
  let maxOutputChunkFrames = 0

  for (let index = 1; index < stages.length; index += 1) {
    const inputFrameCount = stages[index - 1]
    const outputFrameCount = stages[index]
    if (inputFrameCount === undefined || outputFrameCount === undefined) {
      throw new Error('WSOLA stage frame count is missing.')
    }
    validateMaterializedOutput(input.channels.length, outputFrameCount)
    const outputChannels = Array.from(
      { length: input.channels.length },
      () => new Float32Array(outputFrameCount),
    )
    const source = createArraySource(
      { sampleRate: input.sampleRate, channels },
      preflight.chunkFrameCount,
    )
    const bounded = createBoundedSource(source, {
      ...config,
      outputFrameCount,
      createTransaction: (metadata) => createMaterializingTransaction(metadata, outputChannels),
      allowNonFinite: true,
    })
    bounded.source.dispose()

    const normalization = isEffectivelyOneX(inputFrameCount, outputFrameCount)
      ? { channels: outputChannels, gain: 1 }
      : normalizeLegacyStage(outputChannels, getPeak(channels))
    channels = normalization.channels
    const inputPeak = bounded.stats.stageInputPeaks[0]
    const rawOutputPeak = bounded.stats.stageRawOutputPeaks[0]
    if (inputPeak === undefined || rawOutputPeak === undefined) {
      throw new Error('WSOLA compatibility stage statistics are incomplete.')
    }
    stageInputPeaks.push(inputPeak)
    stageRawOutputPeaks.push(rawOutputPeak)
    stageGains.push(normalization.gain)
    maxSourceChunkFrames = Math.max(maxSourceChunkFrames, bounded.stats.maxSourceChunkFrames)
    maxOutputChunkFrames = Math.max(maxOutputChunkFrames, bounded.stats.maxOutputChunkFrames)
  }

  return {
    result: { sampleRate: input.sampleRate, channels },
    stats: {
      stageFrameCounts: stages,
      stageInputPeaks,
      stageRawOutputPeaks,
      stageGains,
      maxSourceChunkFrames,
      maxOutputChunkFrames,
      inputRingFrameCapacity: preflight.inputRingFrameCapacity,
      overlapFrameCapacity: preflight.overlapFrameCapacity,
      pipelineWorkingMemoryBytes: preflight.pipelineWorkingMemoryBytes,
    },
  }
}

const stretchBounded = (input: AudioStretchInput, config: WsolaStretchConfig): WsolaBoundedResult => {
  const inputFrameCount = input.channels[0]?.length ?? 0
  validateSampleRate(input.sampleRate)
  validateChannelCount(input.channels.length, true)
  for (const channel of input.channels) {
    if (!(channel instanceof Float32Array)) throw new Error('WSOLA input channels must be Float32Array values.')
    assert(channel.length === inputFrameCount, 'WSOLA input channels must have matching frame counts')
  }
  validateStretchConfig(config)
  if (input.channels.length === 0) return { result: { sampleRate: input.sampleRate, channels: [] }, stats: {
    stageFrameCounts: [inputFrameCount, config.outputFrameCount],
    stageInputPeaks: [],
    stageRawOutputPeaks: [],
    stageGains: [],
    maxSourceChunkFrames: 0,
    maxOutputChunkFrames: 0,
    inputRingFrameCapacity: 0,
    overlapFrameCapacity: 0,
    pipelineWorkingMemoryBytes: 0,
  } }
  validateMaterializedOutput(input.channels.length, config.outputFrameCount)
  const requestedChunkFrames = config.sourceChunkFrameCount ?? DEFAULT_SOURCE_CHUNK_FRAMES
  const source = createArraySource(input, requestedChunkFrames)
  const preflight = validatePipelineRequest(source, config)
  throwIfAborted(config.signal)
  if (inputFrameCount > 0 && config.outputFrameCount > 0 && hasNonFiniteSamples(input.channels)) {
    return stretchNonFiniteCompatibility(input, config, preflight)
  }
  const outputChannels = Array.from({ length: input.channels.length }, () => new Float32Array(config.outputFrameCount))
  const transactionFactory: WsolaPcmTransactionFactory = (metadata) => createMaterializingTransaction(metadata, outputChannels)
  const bounded = createBoundedSource(source, {
    ...config,
    createTransaction: transactionFactory,
  })
  bounded.source.dispose()
  return {
    result: { sampleRate: input.sampleRate, channels: outputChannels },
    stats: { ...bounded.stats, pipelineWorkingMemoryBytes: preflight.pipelineWorkingMemoryBytes },
  }
}

const hasNonFiniteSamples = (channels: Float32Array[]) => {
  for (const channel of channels) {
    for (const sample of channel) if (!Number.isFinite(sample)) return true
  }
  return false
}

export function stretchAudioWsolaWithStats(input: AudioStretchInput, config: WsolaStretchConfig): WsolaBoundedResult {
  return stretchBounded(input, config)
}

export function stretchAudioWsola(input: AudioStretchInput, config: WsolaStretchConfig): AudioStretchResult {
  validateSampleRate(input.sampleRate)
  validateStretchConfig(config)
  if (input.channels.length === 0) return { sampleRate: input.sampleRate, channels: [] }
  return stretchBounded(input, config).result
}
