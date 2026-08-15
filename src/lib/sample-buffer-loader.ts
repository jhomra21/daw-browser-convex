import { resolveSamplePlaybackUrlForRuntime } from '~/lib/renderer-api-url'
import { readLocalAssetBytes, type LocalAssetBytesResult } from '~/lib/local-assets'

type SampleLoadState =
  | { status: 'pending'; promise: Promise<AudioBuffer | null> }
  | { status: 'ready'; buffer: AudioBuffer }
  | { status: 'failed'; attempts: number; retryAfterMs: number; lastError?: string }

type SampleFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type SampleBufferLoaderOptions = {
  fetchImpl?: SampleFetch
  resolveUrl?: (url: string) => string | null
  projectId?: () => string | undefined
  readLocalAsset?: (projectId: string, assetId: string) => Promise<LocalAssetBytesResult>
  cacheDecodedBuffers?: boolean
}

export type SampleDecodeOptions = {
  targetSampleRate?: number
}
type SampleLoadOptions = SampleDecodeOptions & { signal?: AbortSignal }
type SampleLoadSignalOrOptions = SampleLoadOptions | AbortSignal

const isAbortSignal = (input: SampleLoadSignalOrOptions): input is AbortSignal =>
  'aborted' in input && 'throwIfAborted' in input

const normalizeLoadOptions = (input: SampleLoadSignalOrOptions | undefined): SampleLoadOptions => {
  if (!input) return {}
  if (isAbortSignal(input)) return { signal: input }
  return input
}

const sampleRateCacheKey = (sampleRate: number | undefined) => sampleRate === undefined ? 'canonical' : String(sampleRate)

const LOCAL_ASSET_PREFIX = 'local-asset:'

const localAssetIdForUrl = (url: string) => (
  url.startsWith(LOCAL_ASSET_PREFIX) && url.length > LOCAL_ASSET_PREFIX.length
    ? url.slice(LOCAL_ASSET_PREFIX.length)
    : undefined
)

const awaitWithSignal = async <Value,>(promise: Promise<Value>, signal?: AbortSignal): Promise<Value> => {
  if (!signal) return await promise
  signal.throwIfAborted()
  return await new Promise<Value>((resolve, reject) => {
    const abort = () => {
      try {
        signal.throwIfAborted()
      } catch (error) {
        reject(error)
      }
    }
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function computeRetryDelayMs(attempts: number, error?: string) {
  const isLikelyTerminal = /HTTP 403\b|HTTP 404\b/.test(error ?? '')
  if (isLikelyTerminal) return Math.min(120_000, 15_000 * Math.max(1, attempts))
  return Math.min(30_000, 1_000 * Math.pow(2, Math.max(0, attempts - 1)))
}

const waitForRetry = async (ms: number, signal?: AbortSignal) => {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms))
    return
  }
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    const abort = () => {
      clearTimeout(timer)
      try {
        signal.throwIfAborted()
      } catch (error) {
        reject(error)
      }
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function fetchArrayBufferWithRetry(fetchImpl: SampleFetch, url: string, signal?: AbortSignal) {
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      signal?.throwIfAborted()
      const response = await awaitWithSignal(fetchImpl(url, signal ? { signal } : undefined), signal)
      if (response.ok) return await awaitWithSignal(response.arrayBuffer(), signal)
      lastError = new Error(`HTTP ${response.status} for ${url}`)
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = error instanceof Error ? error : new Error(String(error))
    }
    if (attempt < 2) {
      await waitForRetry(200 * Math.pow(2, attempt), signal)
    }
  }
  throw lastError ?? new Error(`failed to fetch ${url}`)
}

export function createSampleBufferLoader(options: SampleBufferLoaderOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const resolveUrl = options.resolveUrl ?? resolveSamplePlaybackUrlForRuntime
  const projectId = options.projectId
  const readLocalAsset = options.readLocalAsset ?? readLocalAssetBytes
  const cacheDecodedBuffers = options.cacheDecodedBuffers ?? true
  const states = new Map<string, SampleLoadState>()

  const load = async (
    url: string,
    decodeAudioData: (data: ArrayBuffer, targetSampleRate?: number) => Promise<AudioBuffer>,
    optionsInput?: SampleLoadSignalOrOptions,
  ): Promise<AudioBuffer | null> => {
    const options = normalizeLoadOptions(optionsInput)
    const signal = options?.signal
    signal?.throwIfAborted()
    const localAssetId = localAssetIdForUrl(url)
    const activeProjectId = projectId?.() ?? ''
    const localProjectId = localAssetId ? activeProjectId || undefined : undefined
    const resolvedUrl = localAssetId ? localProjectId ? url : null : resolveUrl(url)
    if (!resolvedUrl) return null
    const cacheKey = `${activeProjectId}\u0000${resolvedUrl}\u0000${sampleRateCacheKey(options.targetSampleRate)}`
    const current = states.get(cacheKey)
    if (current?.status === 'ready') return current.buffer
    if (current?.status === 'pending' && !signal) return current.promise
    if (current?.status === 'failed' && Date.now() < current.retryAfterMs) return null

    const attempts = current?.status === 'failed' ? current.attempts + 1 : 1
    const promise = (async () => {
      try {
        const arrayBuffer = localAssetId && localProjectId
          ? await awaitWithSignal(readLocalAsset(localProjectId, localAssetId), signal).then(async (result) => {
              if (result.status !== 'ready') return null
              return await awaitWithSignal(result.file.arrayBuffer(), signal)
            })
          : await fetchArrayBufferWithRetry(fetchImpl, resolvedUrl, signal)
        if (!arrayBuffer) {
          states.set(cacheKey, {
            status: 'failed',
            attempts,
            retryAfterMs: Date.now() + computeRetryDelayMs(attempts),
          })
          return null
        }
        const buffer = await awaitWithSignal(decodeAudioData(arrayBuffer, options?.targetSampleRate), signal)
        signal?.throwIfAborted()
        if (cacheDecodedBuffers) states.set(cacheKey, { status: 'ready', buffer })
        return buffer
      } catch (error) {
        if (signal?.aborted) throw error
        const lastError = error instanceof Error ? error.message : String(error)
        states.set(cacheKey, {
          status: 'failed',
          attempts,
          retryAfterMs: Date.now() + computeRetryDelayMs(attempts, lastError),
          lastError,
        })
        return null
      }
    })()

    if (!signal) {
      states.set(cacheKey, { status: 'pending', promise })
      if (!cacheDecodedBuffers) {
        void promise.finally(() => {
          const state = states.get(cacheKey)
          if (state?.status === 'pending' && state.promise === promise) states.delete(cacheKey)
        })
      }
    }
    return promise
  }

  const invalidate = (url?: string) => {
    if (url) {
      const localAssetId = localAssetIdForUrl(url)
      const projectId = options.projectId?.() ?? ''
      const resolvedUrl = localAssetId && projectId ? url : resolveUrl(url)
      if (resolvedUrl) {
        const prefix = `${projectId}\u0000${resolvedUrl}\u0000`
        for (const cacheKey of states.keys()) {
          if (cacheKey.startsWith(prefix)) states.delete(cacheKey)
        }
      }
      return
    }
    states.clear()
  }

  return {
    load,
    invalidate,
    clear: () => states.clear(),
  }
}
