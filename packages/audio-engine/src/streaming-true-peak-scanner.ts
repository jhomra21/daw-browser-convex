import {
  predictLinkedTruePeakAtFrame,
  truePeakFutureFrames,
  truePeakTapsPerPhase,
} from './true-peak-kernel'

export type StreamingTruePeakChunk = {
  numberOfChannels: number
  length: number
  getChannelData: (channel: number) => Float32Array<ArrayBufferLike>
}

export type StreamingTruePeakResult = {
  peak: number
  peakDbtp: number
}

export const createStreamingTruePeakScanner = (channelCount: number) => {
  if (!Number.isSafeInteger(channelCount) || channelCount <= 0) {
    throw new Error('Streaming true-peak channel count is invalid.')
  }
  const rings = Array.from({ length: channelCount }, () => new Float32Array(truePeakTapsPerPhase))
  let framesSeen = 0
  let nextFrameToProcess = 0
  let peak = 0
  let finished = false

  const sampleAt = (channel: number, frame: number) => {
    if (frame < 0 || frame >= framesSeen) return 0
    if (framesSeen - frame > truePeakTapsPerPhase) {
      throw new Error('Streaming true-peak history window was overwritten.')
    }
    return rings[channel]?.[frame % truePeakTapsPerPhase] ?? 0
  }

  const processFrame = (frame: number) => {
    peak = Math.max(peak, predictLinkedTruePeakAtFrame({ channelCount, frame, sampleAt }))
  }

  const append = (chunk: StreamingTruePeakChunk, signal?: AbortSignal) => {
    if (finished) throw new Error('Streaming true-peak scanner is already finalized.')
    if (chunk.numberOfChannels !== channelCount
      || !Number.isSafeInteger(chunk.length)
      || chunk.length < 0) {
      throw new Error('Streaming true-peak chunk metadata is invalid.')
    }
    const channels = Array.from({ length: channelCount }, (_, channel) => {
      const data = chunk.getChannelData(channel)
      if (data.length !== chunk.length) throw new Error('Streaming true-peak chunk channel length is invalid.')
      return data
    })

    for (let localFrame = 0; localFrame < chunk.length; localFrame += 1) {
      if ((framesSeen & 4095) === 0) signal?.throwIfAborted()
      const ringIndex = framesSeen % truePeakTapsPerPhase
      for (let channel = 0; channel < channelCount; channel += 1) {
        const ring = rings[channel]
        const samples = channels[channel]
        if (!ring || !samples) throw new Error('Streaming true-peak channel is missing.')
        ring[ringIndex] = samples[localFrame] ?? 0
      }
      framesSeen += 1
      while (nextFrameToProcess + truePeakFutureFrames < framesSeen) {
        processFrame(nextFrameToProcess)
        nextFrameToProcess += 1
      }
    }
  }

  const finish = (signal?: AbortSignal): StreamingTruePeakResult => {
    if (!finished) {
      signal?.throwIfAborted()
      while (nextFrameToProcess < framesSeen) {
        if ((nextFrameToProcess & 4095) === 0) signal?.throwIfAborted()
        processFrame(nextFrameToProcess)
        nextFrameToProcess += 1
      }
      finished = true
    }
    return {
      peak,
      peakDbtp: peak === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(peak),
    }
  }

  return { append, finish }
}
