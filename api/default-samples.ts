import { defaultSampleUrl, toDefaultSampleAssetKey } from '@daw-browser/shared'
import { z } from 'zod'

const DEFAULT_SAMPLE_LIST_TIMEOUT_MS = 4_000
const DEFAULT_SAMPLE_PREFIX = 'default/'
const MAX_FALLBACK_SAMPLES = 1_000

const defaultSampleSchema = z.object({
  key: z.string(),
  assetKey: z.string(),
  sourceKind: z.literal('url'),
  name: z.string(),
  url: z.string().optional(),
  duration: z.number().optional(),
  source: z.object({
    durationSec: z.number(),
    sampleRate: z.number(),
    channelCount: z.number(),
  }).optional(),
  sizeBytes: z.number().optional(),
})

type DefaultSample = z.infer<typeof defaultSampleSchema>

let cachedDefaultSamples: DefaultSample[] = []

const defaultSampleResponseSchema = z.object({ samples: z.array(z.unknown()) })

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
  const data = defaultSampleResponseSchema.safeParse(await response.json().catch(() => null))
  if (!data.success) return null
  return data.data.samples.flatMap((sample) => {
    const parsed = defaultSampleSchema.safeParse(sample)
    return parsed.success ? [parsed.data] : []
  }).slice(0, MAX_FALLBACK_SAMPLES)
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
