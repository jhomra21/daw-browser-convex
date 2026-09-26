import { sampleThirtyTrackMixedRatePage, type planThirtyTrackMixedRateSources } from "./spec"

type Source = ReturnType<typeof planThirtyTrackMixedRateSources>[number]
const pageFrames = 16_384

// Yields a standard IEEE float WAV without ever retaining more than one PCM page.
export async function* streamThirtyTrackMixedRateWav(source: Source): AsyncGenerator<Uint8Array> {
  const dataLength = source.uncompressedBytes
  if (!Number.isSafeInteger(dataLength) || dataLength < 0 || dataLength + 36 > 0xffffffff) {
    throw new RangeError("Source exceeds the classic WAV size limit.")
  }
  const header = new Uint8Array(44)
  const view = new DataView(header.buffer)
  const fourCC = (offset: number, value: string) => {
    for (let index = 0; index < 4; index++) header[offset + index] = value.charCodeAt(index)
  }
  fourCC(0, "RIFF")
  view.setUint32(4, dataLength + 36, true)
  fourCC(8, "WAVE")
  fourCC(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 3, true)
  view.setUint16(22, source.channelCount, true)
  view.setUint32(24, source.sampleRate, true)
  view.setUint32(28, source.sampleRate * source.channelCount * 4, true)
  view.setUint16(32, source.channelCount * 4, true)
  view.setUint16(34, 32, true)
  fourCC(36, "data")
  view.setUint32(40, dataLength, true)
  yield header
  const totalFrames = source.sampleRate * source.durationSec
  for (let start = 0; start < totalFrames; start += pageFrames) {
    const frames = Math.min(pageFrames, totalFrames - start)
    const channels = sampleThirtyTrackMixedRatePage(source, start, frames)
    const bytes = new Uint8Array(frames * source.channelCount * 4)
    const pcm = new DataView(bytes.buffer)
    for (let frame = 0; frame < frames; frame++) {
      for (let channel = 0; channel < source.channelCount; channel++) {
        pcm.setFloat32((frame * source.channelCount + channel) * 4, channels[channel]![frame]!, true)
      }
    }
    yield bytes
  }
}
