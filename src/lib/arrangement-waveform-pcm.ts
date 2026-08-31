import {
  decodeAudioPages,
  type DecodeAudioPageSource,
} from '@daw-browser/audio-engine/media-pages'
import { createPcmEnvelopeAccumulator } from '@daw-browser/waveforms/pcm-envelope'
import type { WaveformPeakChannelSlice } from '@daw-browser/waveforms/types'

const DEFAULT_MAX_CONCURRENT_DECODES = 2
const DEFAULT_MAX_CACHE_BYTES = 8 * 1024 * 1024

type ArrangementWaveformPcmDecodeRequest = {
  assetKey: string
  source: () => Promise<DecodeAudioPageSource | null>
  sourceStartSec: number
  sourceEndSec: number
  columns: number
  sampleRate: number
  channelCount: number
}

export type ArrangementWaveformPcmRequest = ArrangementWaveformPcmDecodeRequest & {
  priority?: number
  signal?: AbortSignal
}

type ArrangementWaveformPcmDecoder = (
  request: ArrangementWaveformPcmDecodeRequest,
  signal: AbortSignal,
) => Promise<WaveformPeakChannelSlice | null>

type SchedulerOptions = {
  maxConcurrent?: number
  maxCacheBytes?: number
  decode?: ArrangementWaveformPcmDecoder
}

type CacheEntry = {
  value: WaveformPeakChannelSlice
  bytes: number
}

type Subscriber = {
  signal?: AbortSignal
  resolve: (value: WaveformPeakChannelSlice | null) => void
  abort?: () => void
}

type Job = {
  key: string
  request: ArrangementWaveformPcmDecodeRequest
  priority: number
  sequence: number
  controller: AbortController
  subscribers: Set<Subscriber>
  active: boolean
}

const validPositiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0
const validNonNegativeFinite = (value: number) => Number.isFinite(value) && value >= 0

const frameBounds = (request: ArrangementWaveformPcmDecodeRequest) => {
  if (!validPositiveInteger(request.sampleRate)
    || !validPositiveInteger(request.channelCount)
    || !validPositiveInteger(request.columns)
    || !validNonNegativeFinite(request.sourceStartSec)
    || !Number.isFinite(request.sourceEndSec)
    || request.sourceEndSec <= request.sourceStartSec) return null

  const rawStartFrame = request.sourceStartSec * request.sampleRate
  const rawEndFrame = request.sourceEndSec * request.sampleRate
  if (!Number.isFinite(rawStartFrame) || !Number.isFinite(rawEndFrame)) return null

  const startFrame = Math.floor(rawStartFrame)
  const endFrame = Math.max(startFrame + 1, Math.ceil(rawEndFrame))
  if (!Number.isSafeInteger(startFrame)
    || startFrame < 0
    || !Number.isSafeInteger(endFrame)
    || endFrame <= startFrame) return null

  return { startFrame, endFrame }
}

const cacheKey = (request: ArrangementWaveformPcmDecodeRequest) => [
  request.assetKey,
  request.sampleRate,
  request.channelCount,
  request.sourceStartSec,
  request.sourceEndSec,
  request.columns,
].join(':')

const sliceBytes = (slice: WaveformPeakChannelSlice) => (
  slice.channels.reduce((total, channel) => total + channel.byteLength, 0)
)

export async function decodeArrangementWaveformPcmEnvelope(
  request: ArrangementWaveformPcmDecodeRequest,
  signal: AbortSignal,
): Promise<WaveformPeakChannelSlice | null> {
  const bounds = frameBounds(request)
  if (!bounds || request.assetKey.length === 0) return null

  signal.throwIfAborted()
  const source = await request.source()
  signal.throwIfAborted()
  if (!source) return null

  const accumulator = createPcmEnvelopeAccumulator({
    startFrame: bounds.startFrame,
    endFrame: bounds.endFrame,
    columns: request.columns,
    channelCount: request.channelCount,
  })

  for await (const page of decodeAudioPages(source, {
    startSec: request.sourceStartSec,
    endSec: request.sourceEndSec,
    signal,
  })) {
    if (page.sampleRate !== request.sampleRate || page.channelCount !== request.channelCount) {
      throw new Error('Arrangement waveform PCM metadata changed during decoding.')
    }
    accumulator.append(page)
  }

  return accumulator.finish()
}

export function createArrangementWaveformPcmScheduler(options: SchedulerOptions = {}) {
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_DECODES
  const maxCacheBytes = options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES
  if (!validPositiveInteger(maxConcurrent)
    || !Number.isSafeInteger(maxCacheBytes)
    || maxCacheBytes < 0) {
    throw new Error('Arrangement waveform PCM scheduler limits are invalid.')
  }

  const decode = options.decode ?? decodeArrangementWaveformPcmEnvelope
  const cache = new Map<string, CacheEntry>()
  const pending = new Map<string, Job>()
  const queue: Job[] = []
  let activeCount = 0
  let cachedBytes = 0
  let nextSequence = 0

  const removeSubscriber = (job: Job, subscriber: Subscriber) => {
    if (subscriber.signal && subscriber.abort) {
      subscriber.signal.removeEventListener('abort', subscriber.abort)
    }
    job.subscribers.delete(subscriber)
  }

  const settleSubscriber = (
    job: Job,
    subscriber: Subscriber,
    value: WaveformPeakChannelSlice | null,
  ) => {
    removeSubscriber(job, subscriber)
    subscriber.resolve(subscriber.signal?.aborted ? null : value)
  }

  const removeQueuedJob = (job: Job) => {
    const index = queue.indexOf(job)
    if (index >= 0) queue.splice(index, 1)
    if (pending.get(job.key) === job) pending.delete(job.key)
  }

  const abandonIfUnused = (job: Job) => {
    if (job.subscribers.size > 0) return
    if (job.active) {
      job.controller.abort()
      return
    }
    removeQueuedJob(job)
  }

  const cacheValue = (key: string, value: WaveformPeakChannelSlice) => {
    const bytes = sliceBytes(value)
    if (bytes > maxCacheBytes) return

    const existing = cache.get(key)
    if (existing) {
      cachedBytes -= existing.bytes
      cache.delete(key)
    }
    cache.set(key, { value, bytes })
    cachedBytes += bytes

    while (cachedBytes > maxCacheBytes && cache.size > 0) {
      const oldestKey = cache.keys().next().value
      if (typeof oldestKey !== 'string') break
      const oldest = cache.get(oldestKey)
      cache.delete(oldestKey)
      if (oldest) cachedBytes -= oldest.bytes
    }
  }

  const cachedValue = (key: string) => {
    const entry = cache.get(key)
    if (!entry) return null
    cache.delete(key)
    cache.set(key, entry)
    return entry.value
  }

  const pump = () => {
    queue.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence)
    while (activeCount < maxConcurrent && queue.length > 0) {
      const job = queue.shift()
      if (!job) break
      if (job.subscribers.size === 0) {
        if (pending.get(job.key) === job) pending.delete(job.key)
        continue
      }

      job.active = true
      activeCount += 1
      void decode(job.request, job.controller.signal)
        .then((value) => {
          if (value && !job.controller.signal.aborted) cacheValue(job.key, value)
          for (const subscriber of [...job.subscribers]) {
            settleSubscriber(job, subscriber, value)
          }
        })
        .catch(() => {
          for (const subscriber of [...job.subscribers]) {
            settleSubscriber(job, subscriber, null)
          }
        })
        .finally(() => {
          activeCount -= 1
          job.active = false
          if (pending.get(job.key) === job) pending.delete(job.key)
          pump()
        })
    }
  }

  const subscribe = (job: Job, signal?: AbortSignal) => new Promise<WaveformPeakChannelSlice | null>((resolve) => {
    const subscriber: Subscriber = { signal, resolve }
    const abort = () => {
      if (!job.subscribers.has(subscriber)) return
      removeSubscriber(job, subscriber)
      resolve(null)
      abandonIfUnused(job)
    }
    subscriber.abort = abort
    job.subscribers.add(subscriber)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })

  const request = (input: ArrangementWaveformPcmRequest) => {
    if (input.signal?.aborted || input.assetKey.length === 0 || !frameBounds(input)) {
      return Promise.resolve<WaveformPeakChannelSlice | null>(null)
    }

    const key = cacheKey(input)
    const cached = cachedValue(key)
    if (cached) return Promise.resolve(cached)

    const existing = pending.get(key)
    if (existing) {
      const priority = Number.isFinite(input.priority) ? input.priority ?? 0 : Number.POSITIVE_INFINITY
      if (priority < existing.priority) {
        existing.priority = priority
        if (!existing.active) queue.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence)
      }
      return subscribe(existing, input.signal)
    }

    const priority = Number.isFinite(input.priority) ? input.priority ?? 0 : Number.POSITIVE_INFINITY
    const job: Job = {
      key,
      request: {
        assetKey: input.assetKey,
        source: input.source,
        sourceStartSec: input.sourceStartSec,
        sourceEndSec: input.sourceEndSec,
        columns: input.columns,
        sampleRate: input.sampleRate,
        channelCount: input.channelCount,
      },
      priority,
      sequence: nextSequence,
      controller: new AbortController(),
      subscribers: new Set<Subscriber>(),
      active: false,
    }
    nextSequence += 1
    pending.set(key, job)
    queue.push(job)
    const result = subscribe(job, input.signal)
    pump()
    return result
  }

  const clear = () => {
    for (const job of pending.values()) {
      job.controller.abort()
      for (const subscriber of [...job.subscribers]) settleSubscriber(job, subscriber, null)
    }
    pending.clear()
    queue.splice(0, queue.length)
    cache.clear()
    cachedBytes = 0
  }

  return { request, clear }
}

export const arrangementWaveformPcmScheduler = createArrangementWaveformPcmScheduler()
