type SampleLoadState =
  | { status: 'pending'; promise: Promise<AudioBuffer | null> }
  | { status: 'ready'; buffer: AudioBuffer }
  | { status: 'failed'; attempts: number; retryAfterMs: number; lastError?: string }

type SampleBufferLoaderOptions = {
  fetchImpl?: typeof fetch
}

function computeRetryDelayMs(attempts: number, error?: string) {
  const isLikelyTerminal = /HTTP 403\b|HTTP 404\b/.test(error ?? '')
  if (isLikelyTerminal) return Math.min(120_000, 15_000 * Math.max(1, attempts))
  return Math.min(30_000, 1_000 * Math.pow(2, Math.max(0, attempts - 1)))
}

async function fetchArrayBufferWithRetry(fetchImpl: typeof fetch, url: string) {
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchImpl(url)
      if (response.ok) return await response.arrayBuffer()
      lastError = new Error(`HTTP ${response.status} for ${url}`)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 200 * Math.pow(2, attempt)))
    }
  }
  throw lastError ?? new Error(`failed to fetch ${url}`)
}

export function createSampleBufferLoader(options: SampleBufferLoaderOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const states = new Map<string, SampleLoadState>()

  const load = async (url: string, decodeAudioData: (data: ArrayBuffer) => Promise<AudioBuffer>): Promise<AudioBuffer | null> => {
    const current = states.get(url)
    if (current?.status === 'ready') return current.buffer
    if (current?.status === 'pending') return current.promise
    if (current?.status === 'failed' && Date.now() < current.retryAfterMs) return null

    const attempts = current?.status === 'failed' ? current.attempts + 1 : 1
    const promise = (async () => {
      try {
        const arrayBuffer = await fetchArrayBufferWithRetry(fetchImpl, url)
        const buffer = await decodeAudioData(arrayBuffer)
        states.set(url, { status: 'ready', buffer })
        return buffer
      } catch (error) {
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

    states.set(url, { status: 'pending', promise })
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
