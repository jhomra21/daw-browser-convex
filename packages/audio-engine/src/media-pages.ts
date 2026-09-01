import { ALL_FORMATS, AudioSampleSink, BlobSource, Input, UrlSource } from 'mediabunny'

const sourceCacheBytes = 8 * 1024 * 1024
export const defaultDecodedAudioPageFrames = 16_384

export type DecodedAudioPage = {
  startFrame: number
  frameCount: number
  sampleRate: number
  channelCount: number
  planes: Float32Array[]
}

export type DecodeAudioPageSource = Blob | string | URL | Request

export type DecodeAudioPagesOptions = {
  startSec?: number
  endSec?: number
  pageFrames?: number
  signal?: AbortSignal
}

const validPageFrames = (value: number) => Number.isSafeInteger(value) && value > 0

export const decodedSampleStartFrame = (
  timestamp: number,
  firstTimestamp: number,
  sampleRate: number,
) => Math.round((timestamp - firstTimestamp) * sampleRate)

const createInputSource = (source: DecodeAudioPageSource) => (
  source instanceof Blob
    ? new BlobSource(source, { maxCacheSize: sourceCacheBytes })
    : new UrlSource(source, { maxCacheSize: sourceCacheBytes })
)

export async function* decodeAudioPages(
  source: DecodeAudioPageSource,
  options: DecodeAudioPagesOptions = {},
): AsyncGenerator<DecodedAudioPage> {
  const pageFrames = options.pageFrames ?? defaultDecodedAudioPageFrames
  if (!validPageFrames(pageFrames)) throw new Error('Decoded audio page size is invalid.')
  if (options.startSec !== undefined && !Number.isFinite(options.startSec)) {
    throw new Error('Decoded audio start time is invalid.')
  }
  if (options.endSec !== undefined && (
    !Number.isFinite(options.endSec)
    || (options.startSec !== undefined && options.endSec <= options.startSec)
  )) {
    throw new Error('Decoded audio end time is invalid.')
  }

  const input = new Input({
    source: createInputSource(source),
    formats: ALL_FORMATS,
  })
  let disposed = false
  const disposeInput = () => {
    if (disposed) return
    disposed = true
    input.dispose()
  }
  const abortInput = () => disposeInput()
  options.signal?.addEventListener('abort', abortInput, { once: true })

  try {
    options.signal?.throwIfAborted()
    if (!(await input.canRead())) throw new Error('Audio source has an unsupported or unrecognizable format.')
    const track = await input.getPrimaryAudioTrack()
    if (!track) throw new Error('Audio source does not contain an audio track.')
    const firstTimestamp = await input.getFirstTimestamp([track])
    const startSec = options.startSec
    const endSec = options.endSec
    const sink = new AudioSampleSink(track)

    for await (const sample of sink.samples(
      startSec === undefined ? undefined : firstTimestamp + startSec,
      endSec === undefined ? undefined : firstTimestamp + endSec,
    )) {
      try {
        options.signal?.throwIfAborted()
        const sampleStartFrame = decodedSampleStartFrame(
          sample.timestamp,
          firstTimestamp,
          sample.sampleRate,
        )
        const rangeStartFrame = startSec === undefined ? Number.MIN_SAFE_INTEGER : Math.ceil(startSec * sample.sampleRate)
        const rangeEndFrame = endSec === undefined ? Number.MAX_SAFE_INTEGER : Math.ceil(endSec * sample.sampleRate)
        const firstFrame = Math.max(0, rangeStartFrame - sampleStartFrame)
        const lastFrame = Math.min(sample.numberOfFrames, rangeEndFrame - sampleStartFrame)
        for (let frameOffset = firstFrame; frameOffset < lastFrame; frameOffset += pageFrames) {
          options.signal?.throwIfAborted()
          const frameCount = Math.min(pageFrames, lastFrame - frameOffset)
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
  } catch (error) {
    options.signal?.throwIfAborted()
    throw error
  } finally {
    options.signal?.removeEventListener('abort', abortInput)
    disposeInput()
  }
}
