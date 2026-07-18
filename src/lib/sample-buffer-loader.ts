type SampleLoadState =
  | { status: 'pending'; promise: Promise<AudioBuffer | null> }
  | { status: 'ready'; buffer: AudioBuffer }
  | { status: 'failed'; attempts: number; retryAfterMs: number; lastError?: string }

type SampleFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type SampleBufferLoaderOptions = {
  fetchImpl?: SampleFetch
}

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
  const states = new Map<string, SampleLoadState>()

  const load = async (url: string, decodeAudioData: (data: ArrayBuffer) => Promise<AudioBuffer>, signal?: AbortSignal): Promise<AudioBuffer | null> => {
    signal?.throwIfAborted()
    const current = states.get(url)
    if (current?.status === 'ready') return current.buffer
    if (current?.status === 'pending' && !signal) return current.promise
    if (current?.status === 'failed' && Date.now() < current.retryAfterMs) return null

    const attempts = current?.status === 'failed' ? current.attempts + 1 : 1
    const promise = (async () => {
      try {
        const arrayBuffer = await fetchArrayBufferWithRetry(fetchImpl, url, signal)
        const buffer = await awaitWithSignal(decodeAudioData(arrayBuffer), signal)
        signal?.throwIfAborted()
        states.set(url, { status: 'ready', buffer })
        return buffer
      } catch (error) {
        if (signal?.aborted) throw error
        const lastError = error instanceof Error ? error.message : String(error)
        states.set(url, {
          status: 'failed',
          attempts,
          retryAfterMs: Date.now() + computeRetryDelayMs(attempts, lastError),
          lastError,
        })
        return null
      }
    })()

    if (!signal) states.set(url, { status: 'pending', promise })
    return promise
  }

  const invalidate = (url?: string) => {
    if (url) {
      states.delete(url)
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
