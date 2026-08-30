import { encodePeakByte, SILENCE_BYTE } from './extract-peaks'
import type { WaveformPeakChannelSlice } from './types'

export type WaveformPcmPage = {
  startFrame: number
  frameCount: number
  planes: readonly Float32Array[]
}

type PcmEnvelopeAccumulatorInput = {
  startFrame: number
  endFrame: number
  columns: number
  channelCount: number
}

const validPositiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0
const validNonNegativeInteger = (value: number) => Number.isSafeInteger(value) && value >= 0

export function createPcmEnvelopeAccumulator(input: PcmEnvelopeAccumulatorInput) {
  if (!validNonNegativeInteger(input.startFrame)
    || !validPositiveInteger(input.endFrame)
    || input.endFrame <= input.startFrame
    || !validPositiveInteger(input.columns)
    || !validPositiveInteger(input.channelCount)) {
    throw new Error('PCM waveform envelope bounds are invalid.')
  }

  const frameSpan = input.endFrame - input.startFrame
  const mins = Array.from({ length: input.channelCount }, () => {
    const values = new Float32Array(input.columns)
    values.fill(1)
    return values
  })
  const maxs = Array.from({ length: input.channelCount }, () => {
    const values = new Float32Array(input.columns)
    values.fill(-1)
    return values
  })
  const touched = new Uint8Array(input.columns)

  const append = (page: WaveformPcmPage) => {
    if (!validNonNegativeInteger(page.startFrame)
      || !validPositiveInteger(page.frameCount)
      || !Number.isSafeInteger(page.startFrame + page.frameCount)
      || page.planes.length !== input.channelCount
      || page.planes.some((plane) => plane.length < page.frameCount)) {
      throw new Error('PCM waveform page metadata is inconsistent.')
    }

    const pageEndFrame = page.startFrame + page.frameCount
    const overlapStart = Math.max(input.startFrame, page.startFrame)
    const overlapEnd = Math.min(input.endFrame, pageEndFrame)
    for (let frame = overlapStart; frame < overlapEnd; frame += 1) {
      const column = Math.min(
        input.columns - 1,
        Math.floor(((frame - input.startFrame) * input.columns) / frameSpan),
      )
      const pageOffset = frame - page.startFrame
      touched[column] = 1
      for (let channel = 0; channel < input.channelCount; channel += 1) {
        const value = page.planes[channel]?.[pageOffset] ?? 0
        if (value < mins[channel]![column]!) mins[channel]![column] = value
        if (value > maxs[channel]![column]!) maxs[channel]![column] = value
      }
    }
  }

  const finish = (): WaveformPeakChannelSlice => ({
    columns: input.columns,
    channels: Array.from({ length: input.channelCount }, (_, channel) => {
      const peaks = new Uint8Array(input.columns * 2)
      peaks.fill(SILENCE_BYTE)
      for (let column = 0; column < input.columns; column += 1) {
        if (touched[column] === 0) continue
        peaks[column * 2] = encodePeakByte(mins[channel]![column]!)
        peaks[column * 2 + 1] = encodePeakByte(maxs[channel]![column]!)
      }
      return peaks
    }),
  })

  return { append, finish }
}
