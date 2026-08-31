import type { WaveformPcmPage } from './pcm-envelope'
import type { WaveformSampleChannelSlice } from './types'

type PcmSampleWindowInput = {
  startFrame: number
  endFrame: number
  sampleRate: number
  channelCount: number
  sourceStartSec: number
  sourceEndSec: number
}

const validPositiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0
const validNonNegativeInteger = (value: number) => Number.isSafeInteger(value) && value >= 0

export function createPcmSampleWindowCollector(input: PcmSampleWindowInput) {
  if (!validNonNegativeInteger(input.startFrame)
    || !validPositiveInteger(input.endFrame)
    || input.endFrame <= input.startFrame
    || !validPositiveInteger(input.sampleRate)
    || !validPositiveInteger(input.channelCount)
    || !Number.isFinite(input.sourceStartSec) || input.sourceStartSec < 0
    || !Number.isFinite(input.sourceEndSec) || input.sourceEndSec <= input.sourceStartSec) {
    throw new Error('PCM waveform sample window bounds are invalid.')
  }

  const frameCount = input.endFrame - input.startFrame
  if (!validPositiveInteger(frameCount)) {
    throw new Error('PCM waveform sample window bounds are invalid.')
  }
  const channels = Array.from({ length: input.channelCount }, () => new Float32Array(frameCount))
  let previousPageEndFrame = 0
  let hasPreviousPage = false

  const append = (page: WaveformPcmPage) => {
    if (!validNonNegativeInteger(page.startFrame)
      || !validPositiveInteger(page.frameCount)
      || !Number.isSafeInteger(page.startFrame + page.frameCount)
      || page.planes.length !== input.channelCount
      || page.planes.some((plane) => plane.length < page.frameCount)) {
      throw new Error('PCM waveform page metadata is inconsistent.')
    }

    const pageEndFrame = page.startFrame + page.frameCount
    if (hasPreviousPage && page.startFrame < previousPageEndFrame) {
      throw new Error('PCM waveform pages overlap or are out of order.')
    }
    previousPageEndFrame = pageEndFrame
    hasPreviousPage = true
    const overlapStart = Math.max(input.startFrame, page.startFrame)
    const overlapEnd = Math.min(input.endFrame, pageEndFrame)
    if (overlapEnd <= overlapStart) return

    const sourceOffset = overlapStart - page.startFrame
    const targetOffset = overlapStart - input.startFrame
    const copyFrames = overlapEnd - overlapStart
    for (let channel = 0; channel < input.channelCount; channel += 1) {
      const source = page.planes[channel]
      const target = channels[channel]
      if (!source || !target) continue
      target.set(source.subarray(sourceOffset, sourceOffset + copyFrames), targetOffset)
    }
  }

  const finish = (): WaveformSampleChannelSlice => ({
    channels,
    firstFrame: input.startFrame,
    sampleRate: input.sampleRate,
    sourceStartSec: input.sourceStartSec,
    sourceEndSec: input.sourceEndSec,
  })

  return { append, finish }
}
