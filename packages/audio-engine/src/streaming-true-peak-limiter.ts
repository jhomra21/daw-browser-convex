import {
  predictLinkedTruePeakAtFrame,
  truePeakFutureFrames,
  truePeakTapsPerPhase,
} from './true-peak-kernel'

export type StreamingTruePeakLimiterChunk = {
  numberOfChannels: number
  length: number
  sampleRate: number
  getChannelData: (channel: number) => Float32Array<ArrayBufferLike>
}

type StreamingTruePeakLimiterOptions = {
  sampleRate: number
  channelCount: number
  ceilingDbtp: number
  outputChunkFrames?: number
}

const DEFAULT_OUTPUT_CHUNK_FRAMES = 16_384
const LOOKAHEAD_SEC = 0.005
const RELEASE_SEC = 0.08

const linearFromDb = (value: number) => 10 ** (value / 20)
const validPositiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0

export const createStreamingTruePeakLimiter = (options: StreamingTruePeakLimiterOptions) => {
  if (!Number.isFinite(options.sampleRate) || options.sampleRate <= 0
    || !validPositiveInteger(options.channelCount)
    || options.channelCount > 2
    || !Number.isFinite(options.ceilingDbtp)) {
    throw new Error('Streaming true-peak limiter metadata is invalid.')
  }
  const outputChunkFrames = options.outputChunkFrames ?? DEFAULT_OUTPUT_CHUNK_FRAMES
  if (!validPositiveInteger(outputChunkFrames)) {
    throw new Error('Streaming true-peak limiter output block size is invalid.')
  }

  const lookaheadFrames = Math.max(1, Math.ceil(options.sampleRate * LOOKAHEAD_SEC))
  const rawCapacity = lookaheadFrames + truePeakTapsPerPhase + 2
  const rawRings = Array.from(
    { length: options.channelCount },
    () => new Float32Array(rawCapacity),
  )
  const dequeCapacity = lookaheadFrames + 2
  const peakDequeFrames = new Float64Array(dequeCapacity)
  const peakDequeValues = new Float64Array(dequeCapacity)
  const outputPlanes = Array.from(
    { length: options.channelCount },
    () => new Float32Array(outputChunkFrames),
  )
  const ceiling = linearFromDb(options.ceilingDbtp) * 0.99
  const releaseCoefficient = Math.exp(-1 / Math.max(1, options.sampleRate * RELEASE_SEC))
  let framesSeen = 0
  let nextPredictionFrame = 0
  let nextOutputFrame = 0
  let dequeStart = 0
  let dequeCount = 0
  let outputFrameCount = 0
  let envelope = 1
  let limited = false
  let consumed = false

  const sampleAt = (channel: number, frame: number) => {
    if (frame < 0 || frame >= framesSeen) return 0
    if (framesSeen - frame > rawCapacity) {
      throw new Error('Streaming true-peak limiter history window was overwritten.')
    }
    return rawRings[channel]?.[frame % rawCapacity] ?? 0
  }

  const dequeBackIndex = () => (dequeStart + dequeCount - 1 + dequeCapacity) % dequeCapacity

  const enqueuePeak = (frame: number, value: number) => {
    while (dequeCount > 0 && (peakDequeValues[dequeBackIndex()] ?? 0) <= value) dequeCount -= 1
    if (dequeCount >= dequeCapacity) {
      throw new Error('Streaming true-peak limiter lookahead queue overflowed.')
    }
    const index = (dequeStart + dequeCount) % dequeCapacity
    peakDequeFrames[index] = frame
    peakDequeValues[index] = value
    dequeCount += 1
  }

  const processPrediction = (frame: number) => {
    enqueuePeak(frame, predictLinkedTruePeakAtFrame({
      channelCount: options.channelCount,
      frame,
      sampleAt,
    }))
  }

  const flushOutput = (): AudioBuffer | undefined => {
    if (outputFrameCount === 0) return undefined
    const output = new AudioBuffer({
      numberOfChannels: options.channelCount,
      length: outputFrameCount,
      sampleRate: options.sampleRate,
    })
    for (let channel = 0; channel < options.channelCount; channel += 1) {
      const source = outputPlanes[channel]
      if (!source) throw new Error('Streaming true-peak limiter output channel is missing.')
      output.getChannelData(channel).set(source.subarray(0, outputFrameCount))
    }
    outputFrameCount = 0
    return output
  }

  const emitFrame = (): AudioBuffer | undefined => {
    while (dequeCount > 0 && (peakDequeFrames[dequeStart] ?? 0) < nextOutputFrame) {
      dequeStart = (dequeStart + 1) % dequeCapacity
      dequeCount -= 1
    }
    const predictedPeak = dequeCount > 0 ? peakDequeValues[dequeStart] ?? 0 : 0
    const requiredGain = predictedPeak > ceiling ? ceiling / predictedPeak : 1
    envelope = requiredGain < envelope
      ? requiredGain
      : 1 - (1 - envelope) * releaseCoefficient
    if (envelope < 1) limited = true
    for (let channel = 0; channel < options.channelCount; channel += 1) {
      const output = outputPlanes[channel]
      if (!output) throw new Error('Streaming true-peak limiter output channel is missing.')
      output[outputFrameCount] = sampleAt(channel, nextOutputFrame) * envelope
    }
    outputFrameCount += 1
    nextOutputFrame += 1
    return outputFrameCount === outputChunkFrames ? flushOutput() : undefined
  }

  const transform = async function* (
    chunks: Iterable<StreamingTruePeakLimiterChunk> | AsyncIterable<StreamingTruePeakLimiterChunk>,
    signal?: AbortSignal,
  ): AsyncGenerator<AudioBuffer> {
    if (consumed) throw new Error('Streaming true-peak limiter can only consume one audio stream.')
    consumed = true

    for await (const chunk of chunks) {
      signal?.throwIfAborted()
      if (chunk.sampleRate !== options.sampleRate
        || chunk.numberOfChannels !== options.channelCount
        || !validPositiveInteger(chunk.length)) {
        throw new Error('Streaming true-peak limiter chunk metadata is invalid.')
      }
      const channels = Array.from({ length: options.channelCount }, (_, channel) => {
        const samples = chunk.getChannelData(channel)
        if (samples.length !== chunk.length) {
          throw new Error('Streaming true-peak limiter chunk channel length is invalid.')
        }
        return samples
      })

      for (let localFrame = 0; localFrame < chunk.length; localFrame += 1) {
        if ((framesSeen & 4095) === 0) signal?.throwIfAborted()
        const ringIndex = framesSeen % rawCapacity
        for (let channel = 0; channel < options.channelCount; channel += 1) {
          const ring = rawRings[channel]
          const samples = channels[channel]
          if (!ring || !samples) throw new Error('Streaming true-peak limiter channel is missing.')
          ring[ringIndex] = samples[localFrame] ?? 0
        }
        framesSeen += 1

        while (nextPredictionFrame + truePeakFutureFrames < framesSeen) {
          processPrediction(nextPredictionFrame)
          nextPredictionFrame += 1
          if (nextOutputFrame + lookaheadFrames < nextPredictionFrame) {
            const output = emitFrame()
            if (output) yield output
          }
        }
      }
    }

    signal?.throwIfAborted()
    while (nextPredictionFrame < framesSeen) {
      processPrediction(nextPredictionFrame)
      nextPredictionFrame += 1
      if (nextOutputFrame + lookaheadFrames < nextPredictionFrame) {
        const output = emitFrame()
        if (output) yield output
      }
    }
    while (nextOutputFrame < framesSeen) {
      if ((nextOutputFrame & 4095) === 0) signal?.throwIfAborted()
      const output = emitFrame()
      if (output) yield output
    }
    const finalOutput = flushOutput()
    if (finalOutput) yield finalOutput
  }

  return {
    transform,
    wasLimited: () => limited,
  }
}
