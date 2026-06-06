import { defaultSampleUrl, toDefaultSampleAssetKey } from '@daw-browser/shared'

const DEFAULT_SAMPLE_LIST_TIMEOUT_MS = 4_000
const DEFAULT_SAMPLE_PREFIX = 'default/'
const MAX_FALLBACK_SAMPLES = 1_000

type DefaultSample = {
  key: string
  assetKey: string
  sourceKind: 'url'
  name: string
  url: string | undefined
  duration?: number
  source?: {
    durationSec: number
    sampleRate: number
    channelCount: number
  }
  sizeBytes?: number
}

let cachedDefaultSamples: DefaultSample[] = []

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object'

const readString = (record: Record<string, unknown>, key: string) =>
  typeof record[key] === 'string' ? record[key] : undefined

const isDefaultSample = (value: unknown): value is DefaultSample => {
  if (!isRecord(value)) return false
  return readString(value, 'key') !== undefined
    && readString(value, 'assetKey') !== undefined
    && value.sourceKind === 'url'
    && readString(value, 'name') !== undefined
}

const withTimeout = async <T>(task: Promise<T>, timeoutMs: number): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  try {
    return await Promise.race([task, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const fallbackBaseUrl = (env: Env, requestUrl: string) => {
  const baseUrl = env.DEFAULT_SAMPLES_BASE_URL || env.BETTER_AUTH_URL
  if (!baseUrl || baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1')) return null
  try {
    const normalizedBaseUrl = baseUrl.replace(/\/$/, '')
    if (new URL(normalizedBaseUrl).origin === new URL(requestUrl).origin) return null
    return normalizedBaseUrl
  } catch {
    return null
  }
}

const defaultSampleFromR2Object = (obj: R2Object): DefaultSample | null => {
  if (obj.key === DEFAULT_SAMPLE_PREFIX || obj.key.endsWith('/')) return null

  const metadata = obj.customMetadata
  const duration = Number(metadata?.durationSec)
  const sampleRate = Number(metadata?.sampleRate)
  const channelCount = Number(metadata?.channelCount)
  const hasMetadata = Number.isFinite(duration) && duration > 0
    && Number.isFinite(sampleRate) && sampleRate > 0
    && Number.isFinite(channelCount) && channelCount > 0
  let decodedName = obj.key.slice(DEFAULT_SAMPLE_PREFIX.length)
  try {
    decodedName = decodeURIComponent(decodedName)
  } catch {}

  return {
    key: obj.key,
    assetKey: toDefaultSampleAssetKey(obj.key),
    sourceKind: 'url',
    name: decodedName,
    url: defaultSampleUrl(obj.key),
    duration: hasMetadata ? duration : undefined,
    source: hasMetadata ? { durationSec: duration, sampleRate, channelCount } : undefined,
    sizeBytes: obj.size,
  }
}

const fetchFallbackDefaultSamples = async (env: Env, requestUrl: string) => {
  const baseUrl = fallbackBaseUrl(env, requestUrl)
  if (!baseUrl) return null
  const response = await withTimeout(fetch(`${baseUrl}/api/default-samples`), DEFAULT_SAMPLE_LIST_TIMEOUT_MS)
  if (!response?.ok) return null
  const data: unknown = await response.json().catch(() => null)
  if (!isRecord(data) || !Array.isArray(data.samples)) return null
  return data.samples.filter(isDefaultSample).slice(0, MAX_FALLBACK_SAMPLES)
}

const fallbackOrCache = async (env: Env, requestUrl: string) => {
  const fallbackSamples = await fetchFallbackDefaultSamples(env, requestUrl).catch(() => null)
  if (fallbackSamples) {
    cachedDefaultSamples = fallbackSamples
    return fallbackSamples
  }
  return cachedDefaultSamples
}

export const listDefaultSamples = async (env: Env, requestUrl: string) => {
  const bucket = env.daw_audio_samples
  const samples: DefaultSample[] = []
  let cursor: string | undefined

  try {
    do {
      const page = await withTimeout(
        bucket.list({ prefix: DEFAULT_SAMPLE_PREFIX, cursor, limit: 1000 }),
        DEFAULT_SAMPLE_LIST_TIMEOUT_MS,
      )
      if (!page) return { samples: await fallbackOrCache(env, requestUrl) }
      for (const obj of page.objects) {
        const sample = defaultSampleFromR2Object(obj)
        if (sample) samples.push(sample)
      }
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
  } catch {
    return { samples: await fallbackOrCache(env, requestUrl) }
  }

  samples.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  if (samples.length === 0) return { samples: await fallbackOrCache(env, requestUrl) }
  cachedDefaultSamples = samples
  return { samples }
}

export const fetchFallbackDefaultSample = async (env: Env, requestUrl: string, key: string) => {
  const baseUrl = fallbackBaseUrl(env, requestUrl)
  if (!baseUrl) return null
  const response = await withTimeout(
    fetch(`${baseUrl}/api/default-sample?key=${encodeURIComponent(key)}`),
    DEFAULT_SAMPLE_LIST_TIMEOUT_MS,
  )
  return response?.ok ? response : null
}
