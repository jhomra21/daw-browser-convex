import { ALL_FORMATS, AudioSampleSink, BlobSource, Input, UrlSource } from 'mediabunny'

const sourceCacheBytes = 8 * 1024 * 1024
export const defaultDecodedAudioPageFrames = 16_384
/** Per-range deadline for remote requests, including stalled headers or bodies. */
export const defaultRemoteMediaRequestTimeoutMs = 120_000
/** Total deadline shared by all range requests for one decode operation. */
export const defaultRemoteMediaOperationDeadlineMs = 120_000
/** Maximum response bytes that one decode operation may transfer. */
export const defaultRemoteMediaMaximumBytes = 512 * 1024 * 1024
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

export type AudioPcmSourceDescriptor = {
  readonly identity: string
  readonly persistable?: boolean
  readonly durationSec: number
  readonly frameCount: number
  readonly sampleRate: number
  readonly channelCount: number
  readonly readPages: (options?: {
    startSec?: number
    endSec?: number
    startFrame?: number
    endFrame?: number
    signal?: AbortSignal
    remoteOperation?: RemoteMediaOperation
  }) => AsyncGenerator<DecodedAudioPage>
}

export type DecodeAudioPagesOptions = {
  startSec?: number
  endSec?: number
  startFrame?: number
  endFrame?: number
  pageFrames?: number
  signal?: AbortSignal
  remoteRequestTimeoutMs?: number
  remoteOperationDeadlineMs?: number
  remoteMaximumBytes?: number
  remoteMaxRetries?: number
  fetchFn?: typeof fetch
  remoteOperation?: RemoteMediaOperation
}

export type RemoteMediaOperation = {
  readonly signal: AbortSignal
  readonly maximumBytes: number
  readonly transferredBytes: () => number
  readonly retryAttempts: () => number
  readonly remainingMs: () => number
  readonly abort: (reason?: Error | DOMException) => void
  readonly dispose: () => void
  readonly takeRetryDelay: () => number
  readonly consumeRetry: () => boolean
  readonly addBytes: (value: number) => void
}

const validPageFrames = (value: number) => Number.isSafeInteger(value) && value > 0
const validFrameBound = (value: number) => Number.isSafeInteger(value) && value >= 0

export const createRemoteMediaOperation = (
  operationDeadlineMs: number,
  maximumBytes: number,
  maxRetries: number,
): RemoteMediaOperation => {
  const controller = new AbortController()
  const startedAt = Date.now()
  let transferredBytes = 0
  let retryAttempts = 0
  let retryDelayMs = 0
  const deadline = setTimeout(() => controller.abort(new DOMException('Remote media operation timed out.', 'TimeoutError')), operationDeadlineMs)
  const abort = (reason?: Error | DOMException) => {
    clearTimeout(deadline)
    controller.abort(reason)
  }
  return {
    signal: controller.signal,
    maximumBytes,
    transferredBytes: () => transferredBytes,
    retryAttempts: () => retryAttempts,
    remainingMs: () => Math.max(0, operationDeadlineMs - (Date.now() - startedAt)),
    abort,
    dispose: () => clearTimeout(deadline),
    takeRetryDelay: () => {
      const delay = retryDelayMs
      retryDelayMs = 0
      return delay
    },
    consumeRetry: () => {
      if (retryAttempts >= maxRetries) return false
      retryAttempts += 1
      retryDelayMs = Math.min(2 ** Math.max(0, retryAttempts - 1), 16) * 1_000
      return true
    },
    addBytes: (value) => { transferredBytes += value },
  }
}

const validateDescriptorMetadata = (metadata: Pick<AudioPcmSourceDescriptor, 'durationSec' | 'frameCount' | 'sampleRate' | 'channelCount'>) => {
  if (!Number.isFinite(metadata.durationSec) || metadata.durationSec < 0) throw new Error('Audio source duration is invalid.')
  if (!Number.isSafeInteger(metadata.frameCount) || metadata.frameCount < 0) throw new Error('Audio source frame count is invalid.')
  if (!Number.isFinite(metadata.sampleRate) || metadata.sampleRate <= 0) throw new Error('Audio source sample rate is invalid.')
  if (!Number.isSafeInteger(metadata.channelCount) || metadata.channelCount <= 0) throw new Error('Audio source channel count is invalid.')
  const expectedDuration = metadata.frameCount / metadata.sampleRate
  if (Math.abs(metadata.durationSec - expectedDuration) > 0.5 / metadata.sampleRate) {
    throw new Error('Audio source duration does not match its frame metadata.')
  }
}

const validatePage = (
  page: DecodedAudioPage,
  metadata: Pick<AudioPcmSourceDescriptor, 'sampleRate' | 'channelCount'>,
  expectedStartFrame: number,
) => {
  if (
    page.startFrame !== expectedStartFrame
    || page.frameCount <= 0
    || page.sampleRate !== metadata.sampleRate
    || page.channelCount !== metadata.channelCount
    || page.planes.length !== metadata.channelCount
    || page.planes.some((plane) => plane.length !== page.frameCount)
  ) throw new Error('Decoded audio page metadata or coverage is invalid.')
}

const createAudioBufferDescriptor = (input: {
  identity: string
  persistable?: boolean
  buffer: AudioBuffer
}): AudioPcmSourceDescriptor => {
  const metadata = {
    durationSec: input.buffer.length / input.buffer.sampleRate,
    frameCount: input.buffer.length,
    sampleRate: input.buffer.sampleRate,
    channelCount: input.buffer.numberOfChannels,
  }
  validateDescriptorMetadata(metadata)
  return {
    identity: input.identity,
    persistable: input.persistable !== false,
    ...metadata,
    readPages: async function* (options = {}) {
      const pageFrames = defaultDecodedAudioPageFrames
      const startFrame = Math.max(0, options.startFrame ?? Math.ceil((options.startSec ?? 0) * metadata.sampleRate))
      const endFrame = Math.min(metadata.frameCount, options.endFrame ?? Math.ceil((options.endSec ?? metadata.durationSec) * metadata.sampleRate))
      if (!validFrameBound(startFrame) || !validFrameBound(endFrame) || endFrame < startFrame) {
        throw new Error('Audio source frame range is invalid.')
      }
      options.signal?.throwIfAborted()
      for (let frame = startFrame; frame < endFrame; frame += pageFrames) {
        options.signal?.throwIfAborted()
        const frameCount = Math.min(pageFrames, endFrame - frame)
        const planes = Array.from({ length: metadata.channelCount }, (_, channelIndex) => {
          const plane = new Float32Array(frameCount)
          input.buffer.copyFromChannel(plane, channelIndex, frame)
          return plane
        })
        yield { startFrame: frame, frameCount, sampleRate: metadata.sampleRate, channelCount: metadata.channelCount, planes }
      }
    },
  }
}

const isAudioBufferSource = (
  source: AudioBuffer | DecodeAudioPageSource,
): source is AudioBuffer => typeof source === 'object'
  && source !== null
  && 'copyFromChannel' in source
  && typeof source.copyFromChannel === 'function'

export const createAudioPcmSourceDescriptor = (input: {
  identity: string
  persistable?: boolean
  durationSec: number
  frameCount: number
  sampleRate: number
  channelCount: number
  source: AudioBuffer | DecodeAudioPageSource
  pageFrames?: number
  fetchFn?: typeof fetch
}): AudioPcmSourceDescriptor => {
  validateDescriptorMetadata(input)
  if (isAudioBufferSource(input.source)) {
    if (
      input.source.length !== input.frameCount
      || input.source.sampleRate !== input.sampleRate
      || input.source.numberOfChannels !== input.channelCount
    ) throw new Error('Audio source buffer metadata does not match its descriptor.')
    return createAudioBufferDescriptor({
      identity: input.identity,
      persistable: input.persistable,
      buffer: input.source,
    })
  }
  const source = input.source
  const pageFrames = input.pageFrames ?? defaultDecodedAudioPageFrames
  if (!validPageFrames(pageFrames) || pageFrames > defaultDecodedAudioPageFrames) {
    throw new Error(`Audio source page size must be at most ${defaultDecodedAudioPageFrames} frames.`)
  }
  return {
    identity: input.identity,
    persistable: input.persistable === true,
    durationSec: input.durationSec,
    frameCount: input.frameCount,
    sampleRate: input.sampleRate,
    channelCount: input.channelCount,
    readPages: async function* (options = {}) {
      const startFrame = options.startFrame ?? (options.startSec === undefined
        ? 0
        : Math.ceil(options.startSec * input.sampleRate))
      const endFrame = options.endFrame ?? (options.endSec === undefined
        ? input.frameCount
        : Math.ceil(options.endSec * input.sampleRate))
      if (!validFrameBound(startFrame) || !validFrameBound(endFrame) || endFrame < startFrame || endFrame > input.frameCount) {
        throw new Error('Audio source frame range is invalid.')
      }
      let expectedStartFrame = startFrame
      for await (const page of decodeAudioPages(source, {
        ...options,
        startSec: startFrame / input.sampleRate,
        endSec: endFrame / input.sampleRate,
        startFrame,
        endFrame,
        pageFrames,
        fetchFn: input.fetchFn,
        remoteOperation: options.remoteOperation,
      })) {
        validatePage(page, input, expectedStartFrame)
        expectedStartFrame += page.frameCount
        yield page
      }
      if (expectedStartFrame !== endFrame) throw new Error('Decoded audio pages do not cover the requested range exactly.')
    },
  }
}

export const decodedSampleStartFrame = (
  timestamp: number,
  firstTimestamp: number,
  sampleRate: number,
) => Math.round((timestamp - firstTimestamp) * sampleRate)

const validTimeout = (value: number) => Number.isSafeInteger(value) && value > 0
const validRetries = (value: number) => Number.isSafeInteger(value) && value >= 0

const createDeadlineFetch = (
  fetchFn: typeof fetch,
  timeoutMs: number,
  operation: RemoteMediaOperation,
): typeof fetch => {
  const fetchWithDeadline: typeof fetch = Object.assign(
  async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const controller = new AbortController()
    const upstream = init.signal
    const abort = () => controller.abort(upstream?.reason ?? operation.signal.reason)
    const operationAbort = () => controller.abort(operation.signal.reason)
    if (upstream?.aborted || operation.signal.aborted) abort()
    else {
      upstream?.addEventListener('abort', abort, { once: true })
      operation.signal.addEventListener('abort', operationAbort, { once: true })
    }
    // This timer is a bounded per-request deadline and is always cleared when the fetch settles.
    let finished = false
    if (operation.remainingMs() <= 0) {
      upstream?.removeEventListener('abort', abort)
      operation.signal.removeEventListener('abort', operationAbort)
      throw new DOMException('Remote media operation timed out.', 'TimeoutError')
    }
    const retryDelayMs = operation.takeRetryDelay()
    if (retryDelayMs > 0) {
      try {
        await new Promise<void>((resolve, reject) => {
          // Retry backoff is abortable and bounded by the shared operation deadline.
          const timeout = setTimeout(() => {
            controller.signal.removeEventListener('abort', onAbort)
            resolve()
          }, Math.min(retryDelayMs, operation.remainingMs()))
          const onAbort = () => {
            clearTimeout(timeout)
            controller.signal.removeEventListener('abort', onAbort)
            reject(controller.signal.reason ?? new DOMException('Remote media request aborted.', 'AbortError'))
          }
          controller.signal.addEventListener('abort', onAbort, { once: true })
          if (controller.signal.aborted) onAbort()
        })
      } catch (error) {
        upstream?.removeEventListener('abort', abort)
        operation.signal.removeEventListener('abort', operationAbort)
        throw error
      }
    }
    const remainingMs = Math.min(timeoutMs, operation.remainingMs())
    if (remainingMs <= 0) throw new DOMException('Remote media operation timed out.', 'TimeoutError')
    const timeout = setTimeout(() => controller.abort(new DOMException('Remote media request timed out.', 'TimeoutError')), remainingMs)
    const cleanup = () => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      upstream?.removeEventListener('abort', abort)
      operation.signal.removeEventListener('abort', operationAbort)
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
              const nextBytes = operation.transferredBytes() + next.value.byteLength
              if (nextBytes > operation.maximumBytes) {
                await reader.cancel()
                cleanup()
                streamController.error(new Error('Remote media transfer exceeded its byte budget.'))
                return
              }
              operation.addBytes(next.value.byteLength)
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
      const wrapped = new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
      Object.defineProperty(wrapped, 'url', { value: response.url })
      Object.defineProperty(wrapped, 'redirected', { value: response.redirected })
      return wrapped
    } finally {
      if (controller.signal.aborted) cleanup()
    }
  },
  { preconnect: fetchFn.preconnect },
  )
  return fetchWithDeadline
}

const createInputSource = (source: DecodeAudioPageSource, options: DecodeAudioPagesOptions) => {
  if (source instanceof Blob) return new BlobSource(source, { maxCacheSize: sourceCacheBytes })
  const timeoutMs = options.remoteRequestTimeoutMs ?? defaultRemoteMediaRequestTimeoutMs
  const operationDeadlineMs = options.remoteOperationDeadlineMs ?? defaultRemoteMediaOperationDeadlineMs
  const maximumBytes = options.remoteMaximumBytes ?? defaultRemoteMediaMaximumBytes
  const maxRetries = options.remoteMaxRetries ?? defaultRemoteMediaMaxRetries
  if (!validTimeout(timeoutMs)) throw new Error('Remote media request timeout is invalid.')
  if (!validTimeout(operationDeadlineMs)) throw new Error('Remote media operation deadline is invalid.')
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) throw new Error('Remote media byte budget is invalid.')
  if (!validRetries(maxRetries)) throw new Error('Remote media retry count is invalid.')
  const fetchFn = options.fetchFn ?? globalThis.fetch
  const operation = options.remoteOperation ?? createRemoteMediaOperation(operationDeadlineMs, maximumBytes, maxRetries)
  return new UrlSource(source, {
    maxCacheSize: sourceCacheBytes,
    parallelism: 1,
    fetchFn: createDeadlineFetch(fetchFn, timeoutMs, operation),
    getRetryDelay: () => operation.consumeRetry() ? 0 : null,
  })
}

export const inspectAudioSourceMetadata = async (
  source: DecodeAudioPageSource,
  options: Omit<DecodeAudioPagesOptions, 'startSec' | 'endSec' | 'startFrame' | 'endFrame' | 'pageFrames'> = {},
) => {
  const remoteOperation = options.remoteOperation ?? (
    source instanceof Blob
      ? undefined
      : createRemoteMediaOperation(
        options.remoteOperationDeadlineMs ?? defaultRemoteMediaOperationDeadlineMs,
        options.remoteMaximumBytes ?? defaultRemoteMediaMaximumBytes,
        options.remoteMaxRetries ?? defaultRemoteMediaMaxRetries,
      )
  )
  const input = new Input({
    source: createInputSource(source, { ...options, remoteOperation }),
    formats: ALL_FORMATS,
  })
  const abortInput = () => input.dispose()
  const abortOperation = () => remoteOperation?.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abortInput, { once: true })
  options.signal?.addEventListener('abort', abortOperation, { once: true })
  try {
    options.signal?.throwIfAborted()
    if (!(await input.canRead())) throw new Error('Audio source has an unsupported or unrecognizable format.')
    const track = await input.getPrimaryAudioTrack()
    if (!track) throw new Error('Audio source does not contain an audio track.')
    const durationSec = await track.getDurationFromMetadata()
    const sampleRate = await track.getSampleRate()
    const channelCount = await track.getNumberOfChannels()
    if (!Number.isFinite(sampleRate) || sampleRate <= 0
      || !Number.isSafeInteger(channelCount) || channelCount <= 0) {
      throw new Error('Audio source track metadata is invalid.')
    }
    return { durationSec: durationSec ?? undefined, sampleRate, channelCount }
  } finally {
    options.signal?.removeEventListener('abort', abortInput)
    options.signal?.removeEventListener('abort', abortOperation)
    input.dispose()
    if (!options.remoteOperation) remoteOperation?.dispose()
  }
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

  const ownedRemoteOperation = options.remoteOperation ?? (
    source instanceof Blob
      ? undefined
      : createRemoteMediaOperation(
        options.remoteOperationDeadlineMs ?? defaultRemoteMediaOperationDeadlineMs,
        options.remoteMaximumBytes ?? defaultRemoteMediaMaximumBytes,
        options.remoteMaxRetries ?? defaultRemoteMediaMaxRetries,
      )
  )
  const input = new Input({
    source: createInputSource(source, { ...options, remoteOperation: ownedRemoteOperation }),
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
  const abortOperation = () => ownedRemoteOperation?.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abortOperation, { once: true })

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
    options.signal?.removeEventListener('abort', abortOperation)
    disposeInput()
    if (!options.remoteOperation) ownedRemoteOperation?.dispose()
  }
}
