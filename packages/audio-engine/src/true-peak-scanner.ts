import { yieldToEventLoop } from './event-loop-yield'
import { predictLinkedTruePeakAtFrame } from './true-peak-kernel'

type TruePeakBuffer = {
  numberOfChannels: number
  length: number
  getChannelData: (channel: number) => Float32Array<ArrayBufferLike>
}

type TruePeakScanResult = {
  peak: number
  peakDbtp: number
}

// Each frame runs the full oversampling kernel, so this bounds one synchronous block.
const truePeakChunkFrames = 4096

const toTruePeakResult = (peak: number): TruePeakScanResult => ({
  peak,
  peakDbtp: peak === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(peak),
})

// The kernel reads the whole channel rather than a chunk-local window, so taps that cross a chunk edge
// see the same neighbors as a single pass.
const scanTruePeakFrames = (
  channels: readonly Float32Array<ArrayBufferLike>[],
  startFrame: number,
  endFrame: number,
  peak: number,
) => {
  let next = peak
  for (const channel of channels) {
    for (let frame = startFrame; frame < endFrame; frame += 1) {
      next = Math.max(next, predictLinkedTruePeakAtFrame({
        channelCount: 1,
        frame,
        sampleAt: (_channel, sourceFrame) => (
          sourceFrame >= 0 && sourceFrame < channel.length ? channel[sourceFrame] ?? 0 : 0
        ),
      }))
    }
  }
  return next
}

// Channels are read once per scan, not once per chunk.
const readTruePeakChannels = (buffer: TruePeakBuffer) => Array.from(
  { length: buffer.numberOfChannels },
  (_, channelIndex) => buffer.getChannelData(channelIndex),
)

export function scanTruePeak(
  buffer: TruePeakBuffer,
  signal?: AbortSignal,
): TruePeakScanResult {
  const channels = readTruePeakChannels(buffer)
  let peak = 0
  for (let startFrame = 0; startFrame < buffer.length; startFrame += truePeakChunkFrames) {
    signal?.throwIfAborted()
    peak = scanTruePeakFrames(channels, startFrame, Math.min(buffer.length, startFrame + truePeakChunkFrames), peak)
  }
  signal?.throwIfAborted()
  return toTruePeakResult(peak)
}

// Same scan as scanTruePeak, yielding to the event loop after each chunk so a long export check does not freeze the UI.
export async function scanTruePeakAsync(
  buffer: TruePeakBuffer,
  signal?: AbortSignal,
): Promise<TruePeakScanResult> {
  const channels = readTruePeakChannels(buffer)
  let peak = 0
  for (let startFrame = 0; startFrame < buffer.length; startFrame += truePeakChunkFrames) {
    signal?.throwIfAborted()
    peak = scanTruePeakFrames(channels, startFrame, Math.min(buffer.length, startFrame + truePeakChunkFrames), peak)
    await yieldToEventLoop()
  }
  signal?.throwIfAborted()
  return toTruePeakResult(peak)
}
