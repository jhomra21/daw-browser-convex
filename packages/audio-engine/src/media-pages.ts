import { ALL_FORMATS, AudioSampleSink, BlobSource, Input, UrlSource } from 'mediabunny'

const sourceCacheBytes = 8 * 1024 * 1024
export const defaultDecodedAudioPageFrames = 16_384
/** Per-range deadline for remote requests, including stalled headers or bodies. */
export const defaultRemoteMediaRequestTimeoutMs = 120_000
/** Finite retry count keeps a reachable but failing remote source bounded. */
export const defaultRemoteMediaMaxRetries = 3

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
  startFrame?: number
  endFrame?: number
  pageFrames?: number
  signal?: AbortSignal
  remoteRequestTimeoutMs?: number
  remoteMaxRetries?: number
  fetchFn?: typeof fetch
}

const validPageFrames = (value: number) => Number.isSafeInteger(value) && value > 0
const validFrameBound = (value: number) => Number.isSafeInteger(value) && value >= 0

export const decodedSampleStartFrame = (
  timestamp: number,
  firstTimestamp: number,
  sampleRate: number,
) => Math.round((timestamp - firstTimestamp) * sampleRate)

const validTimeout = (value: number) => Number.isSafeInteger(value) && value > 0
const validRetries = (value: number) => Number.isSafeInteger(value) && value >= 0

const createDeadlineFetch = (fetchFn: typeof fetch, timeoutMs: number): typeof fetch => Object.assign(
  async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const controller = new AbortController()
    const upstream = init.signal
    const abort = () => controller.abort(upstream?.reason)
    if (upstream?.aborted) abort()
    else upstream?.addEventListener('abort', abort, { once: true })
    // This timer is a bounded per-request deadline and is always cleared when the fetch settles.
    let finished = false
    const timeout = setTimeout(() => controller.abort(new DOMException('Remote media request timed out.', 'TimeoutError')), timeoutMs)
    const cleanup = () => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      upstream?.removeEventListener('abort', abort)
    }
    try {
      let request: Promise<Response>
      try {
        request = fetchFn(input, { ...init, signal: controller.signal })
      } catch (cause) {
        cleanup()
        throw cause
      }
      const response = await new Promise<Response>((resolve, reject) => {
        let settled = false
        const finish = (callback: () => void) => {
          if (settled) return
          settled = true
          callback()
        }
        request.then(
          (response) => finish(() => resolve(response)),
          (cause) => finish(() => reject(cause)),
        )
        controller.signal.addEventListener('abort', () => {
          const reason = controller.signal.reason
          finish(() => reject(reason instanceof Error ? reason : new DOMException('Remote media request aborted.', 'AbortError')))
        }, { once: true })
      }).catch((cause) => {
        cleanup()
        throw cause
      })
      if (!response.body) {
        cleanup()
        return response
      }
      const reader = response.body.getReader()
      const stream = new ReadableStream<Uint8Array>({
        async pull(streamController) {
          try {
            const next = await reader.read()
            if (next.done) {
              cleanup()
              streamController.close()
            } else {
              streamController.enqueue(next.value)
            }
          } catch (error) {
            cleanup()
            streamController.error(error)
          }
        },
        async cancel(reason) {
          cleanup()
          await reader.cancel(reason)
        },
      })
      controller.signal.addEventListener('abort', () => {
        cleanup()
        void reader.cancel(controller.signal.reason).catch(() => undefined)
      }, { once: true })
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    } finally {
      if (controller.signal.aborted) cleanup()
    }
  },
  { preconnect: fetchFn.preconnect },
)

const createInputSource = (source: DecodeAudioPageSource, options: DecodeAudioPagesOptions) => {
  if (source instanceof Blob) return new BlobSource(source, { maxCacheSize: sourceCacheBytes })
  const timeoutMs = options.remoteRequestTimeoutMs ?? defaultRemoteMediaRequestTimeoutMs
  const maxRetries = options.remoteMaxRetries ?? defaultRemoteMediaMaxRetries
  if (!validTimeout(timeoutMs)) throw new Error('Remote media request timeout is invalid.')
  if (!validRetries(maxRetries)) throw new Error('Remote media retry count is invalid.')
  const fetchFn = options.fetchFn ?? globalThis.fetch
  return new UrlSource(source, {
    maxCacheSize: sourceCacheBytes,
    fetchFn: createDeadlineFetch(fetchFn, timeoutMs),
    getRetryDelay: (previousAttempts) => previousAttempts <= maxRetries
      ? Math.min(2 ** Math.max(0, previousAttempts - 1), 16)
      : null,
  })
}

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
  if (options.startFrame !== undefined && !validFrameBound(options.startFrame)) {
    throw new Error('Decoded audio start frame is invalid.')
  }
  if (options.endFrame !== undefined && (
    !validFrameBound(options.endFrame)
    || (options.startFrame !== undefined && options.endFrame <= options.startFrame)
  )) {
    throw new Error('Decoded audio end frame is invalid.')
  }

  const input = new Input({
    source: createInputSource(source, options),
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
        const rangeStartFrame = options.startFrame
          ?? (startSec === undefined ? Number.MIN_SAFE_INTEGER : Math.ceil(startSec * sample.sampleRate))
        const rangeEndFrame = options.endFrame
          ?? (endSec === undefined ? Number.MAX_SAFE_INTEGER : Math.ceil(endSec * sample.sampleRate))
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
