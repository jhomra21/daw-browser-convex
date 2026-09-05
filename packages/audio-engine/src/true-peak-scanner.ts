type TruePeakBuffer = {
  numberOfChannels: number
  length: number
  getChannelData: (channel: number) => Float32Array<ArrayBufferLike>
}

import { predictLinkedTruePeakAtFrame } from './true-peak-kernel'

type TruePeakScanResult = {
  peak: number
  peakDbtp: number
}

export function scanTruePeak(
  buffer: TruePeakBuffer,
  signal?: AbortSignal,
): TruePeakScanResult {
  let peak = 0
  for (let channelIndex = 0; channelIndex < buffer.numberOfChannels; channelIndex += 1) {
    const channel = buffer.getChannelData(channelIndex)
    for (let frame = 0; frame < buffer.length; frame += 1) {
      if ((frame & 4095) === 0) signal?.throwIfAborted()
      peak = Math.max(peak, predictLinkedTruePeakAtFrame({
        channelCount: 1,
        frame,
        sampleAt: (_channel, sourceFrame) => (
          sourceFrame >= 0 && sourceFrame < channel.length ? channel[sourceFrame] ?? 0 : 0
        ),
      }))
    }
  }
  signal?.throwIfAborted()
  return {
    peak,
    peakDbtp: peak === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(peak),
  }
}
