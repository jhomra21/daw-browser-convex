const OVERSAMPLING = 8
const TAPS_PER_PHASE = 24
const CENTER_TAP = TAPS_PER_PHASE / 2 - 1
const FUTURE_FRAMES = TAPS_PER_PHASE - 1 - CENTER_TAP

const sinc = (value: number) => value === 0 ? 1 : Math.sin(Math.PI * value) / (Math.PI * value)

const createPolyphaseCoefficients = (): readonly Float64Array[] => Array.from(
  { length: OVERSAMPLING },
  (_, phase) => {
    const coefficients = new Float64Array(TAPS_PER_PHASE)
    const fractionalOffset = phase / OVERSAMPLING
    let sum = 0
    for (let tap = 0; tap < TAPS_PER_PHASE; tap += 1) {
      const distance = tap - CENTER_TAP - fractionalOffset
      const window = 0.42
        - 0.5 * Math.cos(2 * Math.PI * tap / (TAPS_PER_PHASE - 1))
        + 0.08 * Math.cos(4 * Math.PI * tap / (TAPS_PER_PHASE - 1))
      const coefficient = sinc(distance) * window
      coefficients[tap] = coefficient
      sum += coefficient
    }
    for (let tap = 0; tap < coefficients.length; tap += 1) coefficients[tap] /= sum
    return coefficients
  },
)

const POLYPHASE_COEFFICIENTS = createPolyphaseCoefficients()

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
  const rings = Array.from({ length: channelCount }, () => new Float32Array(TAPS_PER_PHASE))
  let framesSeen = 0
  let nextFrameToProcess = 0
  let peak = 0
  let finished = false

  const sampleAt = (channel: number, frame: number) => {
    if (frame < 0 || frame >= framesSeen) return 0
    if (framesSeen - frame > TAPS_PER_PHASE) {
      throw new Error('Streaming true-peak history window was overwritten.')
    }
    return rings[channel]?.[frame % TAPS_PER_PHASE] ?? 0
  }

  const processFrame = (frame: number) => {
    for (let channel = 0; channel < channelCount; channel += 1) {
      for (const coefficients of POLYPHASE_COEFFICIENTS) {
        let sample = 0
        for (let tap = 0; tap < coefficients.length; tap += 1) {
          sample += sampleAt(channel, frame + tap - CENTER_TAP) * coefficients[tap]
        }
        if (Number.isFinite(sample)) peak = Math.max(peak, Math.abs(sample))
      }
    }
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
      const ringIndex = framesSeen % TAPS_PER_PHASE
      for (let channel = 0; channel < channelCount; channel += 1) {
        rings[channel]?.set([channels[channel]?.[localFrame] ?? 0], ringIndex)
      }
      framesSeen += 1
      while (nextFrameToProcess + FUTURE_FRAMES < framesSeen) {
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
