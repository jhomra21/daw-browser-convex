import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from 'mediabunny'

const sourceCacheBytes = 8 * 1024 * 1024
export const defaultDecodedAudioPageFrames = 16_384

export type DecodedAudioPage = {
  startFrame: number
  frameCount: number
  sampleRate: number
  channelCount: number
  planes: Float32Array[]
}

export type DecodeAudioPagesOptions = {
  startSec?: number
  endSec?: number
  pageFrames?: number
  signal?: AbortSignal
}

const validPageFrames = (value: number) => Number.isSafeInteger(value) && value > 0

export async function* decodeAudioPages(
  source: Blob,
  options: DecodeAudioPagesOptions = {},
): AsyncGenerator<DecodedAudioPage> {
  const pageFrames = options.pageFrames ?? defaultDecodedAudioPageFrames
  if (!validPageFrames(pageFrames)) throw new Error('Decoded audio page size is invalid.')
  if (options.startSec !== undefined && (!Number.isFinite(options.startSec) || options.startSec < 0)) {
    throw new Error('Decoded audio start time is invalid.')
  }
  if (options.endSec !== undefined && (
    !Number.isFinite(options.endSec)
    || options.endSec < 0
    || (options.startSec !== undefined && options.endSec <= options.startSec)
  )) {
    throw new Error('Decoded audio end time is invalid.')
  }

  const input = new Input({
    source: new BlobSource(source, { maxCacheSize: sourceCacheBytes }),
    formats: ALL_FORMATS,
  })

  try {
    options.signal?.throwIfAborted()
    if (!(await input.canRead())) throw new Error('Audio source has an unsupported or unrecognizable format.')
    const track = await input.getPrimaryAudioTrack()
    if (!track) throw new Error('Audio source does not contain an audio track.')
    const sink = new AudioSampleSink(track)

    for await (const sample of sink.samples(options.startSec, options.endSec)) {
      try {
        options.signal?.throwIfAborted()
        const sampleStartFrame = Math.round(sample.timestamp * sample.sampleRate)
        for (let frameOffset = 0; frameOffset < sample.numberOfFrames; frameOffset += pageFrames) {
          options.signal?.throwIfAborted()
          const frameCount = Math.min(pageFrames, sample.numberOfFrames - frameOffset)
          const planes = Array.from({ length: sample.numberOfChannels }, (_, planeIndex) => {
            const plane = new Float32Array(frameCount)
            sample.copyTo(plane, {
              planeIndex,
              format: 'f32-planar',
              frameOffset,
              frameCount,
            })
            return plane
          })
          yield {
            startFrame: sampleStartFrame + frameOffset,
            frameCount,
            sampleRate: sample.sampleRate,
            channelCount: sample.numberOfChannels,
            planes,
          }
        }
      } finally {
        sample.close()
      }
    }
  } finally {
    input.dispose()
  }
}
