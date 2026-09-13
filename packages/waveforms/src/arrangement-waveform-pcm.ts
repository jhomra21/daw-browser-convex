import type { AudioPcmSourceDescriptor, DecodedAudioPage } from '@daw-browser/audio-engine/media-pages'
import { createPcmEnvelopeAccumulator } from './pcm-envelope'
import { createPcmSampleWindowCollector } from './pcm-samples'
import { decodePeakByte, encodePeakByte, SILENCE_BYTE } from './extract-peaks'
import type { WaveformPeakChannelSlice, WaveformPcmResult, WaveformSampleChannelSlice } from './types'

export const ARRANGEMENT_PCM_TILE_FRAMES = 16_384
export const ARRANGEMENT_PCM_MAX_CONCURRENT = 2
export const ARRANGEMENT_PCM_MAX_QUEUE = 64
export const ARRANGEMENT_PCM_MAX_CACHE_BYTES = 32 * 1024 * 1024
export const ARRANGEMENT_PCM_MAX_CACHE_ENTRY_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_CACHE_ENTRIES = 256

class ArrangementWaveformStaleError extends Error {
  constructor() {
    super('Arrangement waveform PCM source identity is stale.')
  }
}

export type ArrangementWaveformPcmRequest = {
  assetKey: string
  sourceIdentity: string
  source: (signal?: AbortSignal) => Promise<AudioPcmSourceDescriptor | null>
  sourceStartSec: number
  sourceEndSec: number
  columns: number
  sampleRate: number
  channelCount: number
  mode?: 'pcm-envelope' | 'pcm-line'
  exactRange?: boolean
  priority?: number
  signal?: AbortSignal
}

export type ArrangementWaveformPcmDecodeRequest = Omit<ArrangementWaveformPcmRequest, 'priority' | 'signal'>

export type ArrangementWaveformPcmDecoder = (
  request: ArrangementWaveformPcmDecodeRequest & { tileStartFrame: number; tileEndFrame: number },
  signal: AbortSignal,
) => Promise<WaveformPcmResult | null>

export type ArrangementWaveformPcmDiagnostics = {
  active: number
  peakActive: number
  queued: number
  peakQueued: number
  dedupeCount: number
  cancellationCount: number
  cacheHits: number
  cacheMisses: number
  cacheBytes: number
  staleCount: number
  failureCount: number
  evictionCount: number
  capacityCount: number
}

type CacheEntry = {
  value: WaveformPcmResult
  bytes: number
}

type Subscriber = {
  resolve: (value: WaveformPcmResult | null) => void
  signal?: AbortSignal
  onAbort?: () => void
}

type Job = {
  key: string
  request: ArrangementWaveformPcmDecodeRequest
  tileStartFrame: number
  tileEndFrame: number
  priority: number
  sequence: number
  controller: AbortController
  subscribers: Set<Subscriber>
  active: boolean
}

const validPositiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0
const validNonNegativeFinite = (value: number) => Number.isFinite(value) && value >= 0

const normalizePriority = (value: number | undefined) => (
  value === undefined || !Number.isFinite(value) ? 0 : value
)

const cloneResult = (value: WaveformPcmResult): WaveformPcmResult => (
  value.mode === 'pcm-envelope'
    ? {
      mode: 'pcm-envelope',
      columns: value.columns,
      channels: value.channels.map((channel) => new Uint8Array(channel)),
      sourceStartSec: value.sourceStartSec,
      sourceEndSec: value.sourceEndSec,
    }
    : {
      mode: 'pcm-line',
      firstFrame: value.firstFrame,
      sampleRate: value.sampleRate,
      sourceStartSec: value.sourceStartSec,
      sourceEndSec: value.sourceEndSec,
      channels: value.channels.map((channel) => new Float32Array(channel)),
    }
)

const resultBytes = (value: WaveformPcmResult) => value.channels.reduce(
  (total, channel) => total + channel.byteLength,
  0,
)

const requestBounds = (request: ArrangementWaveformPcmRequest) => {
  if (request.assetKey.length === 0
    || request.sourceIdentity.length === 0
    || !validPositiveInteger(request.sampleRate)
    || !validPositiveInteger(request.channelCount)
    || !validPositiveInteger(request.columns)
    || !validNonNegativeFinite(request.sourceStartSec)
    || !Number.isFinite(request.sourceEndSec)
    || request.sourceEndSec <= request.sourceStartSec) return null
  const startFrame = Math.floor(request.sourceStartSec * request.sampleRate)
  const endFrame = Math.ceil(request.sourceEndSec * request.sampleRate)
  if (!Number.isSafeInteger(startFrame) || startFrame < 0
    || !Number.isSafeInteger(endFrame) || endFrame <= startFrame) return null
  if (request.exactRange) {
    return {
      startFrame,
      endFrame,
      tiles: [{ tileStartFrame: startFrame, tileEndFrame: endFrame }],
    }
  }
  const firstTile = Math.floor(startFrame / ARRANGEMENT_PCM_TILE_FRAMES)
  const lastTile = Math.floor((endFrame - 1) / ARRANGEMENT_PCM_TILE_FRAMES)
  const tiles = Array.from({ length: lastTile - firstTile + 1 }, (_, index) => {
    const tileStartFrame = (firstTile + index) * ARRANGEMENT_PCM_TILE_FRAMES
    return { tileStartFrame, tileEndFrame: tileStartFrame + ARRANGEMENT_PCM_TILE_FRAMES }
  })
  if (tiles.some((tile) => !Number.isSafeInteger(tile.tileEndFrame))) return null
  return {
    startFrame,
    endFrame,
    tiles,
  }
}

const requestKey = (
  request: ArrangementWaveformPcmRequest,
  tileStartFrame: number,
  tileEndFrame: number,
) => JSON.stringify([
  request.assetKey,
  request.sourceIdentity,
  request.sampleRate,
  request.channelCount,
  tileStartFrame,
  tileEndFrame,
  request.exactRange ? request.columns : tileEndFrame - tileStartFrame,
  request.mode ?? 'pcm-envelope',
])

const validatePage = (page: DecodedAudioPage, source: AudioPcmSourceDescriptor) => {
  if (page.sampleRate !== source.sampleRate
    || page.channelCount !== source.channelCount
    || page.planes.length !== source.channelCount
    || page.frameCount <= 0
    || page.planes.some((plane) => plane.length < page.frameCount)) {
    throw new Error('Arrangement waveform PCM metadata changed during decoding.')
  }
}

export async function decodeArrangementWaveformPcm(
  request: ArrangementWaveformPcmDecodeRequest & { tileStartFrame: number; tileEndFrame: number },
  signal: AbortSignal,
): Promise<WaveformPcmResult | null> {
  signal.throwIfAborted()
  const source = await request.source(signal)
  signal.throwIfAborted()
  if (!source) return null
  if (source.identity !== request.sourceIdentity) {
    throw new ArrangementWaveformStaleError()
  }
  if (!Number.isFinite(source.durationSec)
    || source.durationSec < 0
    || !Number.isSafeInteger(source.frameCount)
    || source.frameCount < 0
    || !Number.isSafeInteger(source.sampleRate)
    || source.sampleRate <= 0
    || !Number.isSafeInteger(source.channelCount)
    || source.channelCount <= 0
    || Math.abs(source.durationSec - source.frameCount / source.sampleRate) > 0.5 / source.sampleRate
    || source.sampleRate !== request.sampleRate
    || source.channelCount !== request.channelCount) {
    throw new Error('Arrangement waveform PCM source metadata is inconsistent.')
  }
  const startFrame = Math.min(request.tileStartFrame, source.frameCount)
  const endFrame = Math.min(request.tileEndFrame, source.frameCount)
  if (endFrame <= startFrame) return null

  const mode = request.mode ?? 'pcm-envelope'
  const accumulator = mode === 'pcm-envelope'
    ? createPcmEnvelopeAccumulator({
      startFrame,
      endFrame,
      columns: request.exactRange ? request.columns : endFrame - startFrame,
      sampleRate: source.sampleRate,
      channelCount: source.channelCount,
      sourceStartSec: startFrame / source.sampleRate,
      sourceEndSec: endFrame / source.sampleRate,
    })
    : createPcmSampleWindowCollector({
      startFrame,
      endFrame,
      sampleRate: source.sampleRate,
      channelCount: source.channelCount,
      sourceStartSec: startFrame / source.sampleRate,
      sourceEndSec: endFrame / source.sampleRate,
    })

  for await (const page of source.readPages({ startFrame, endFrame, signal })) {
    signal.throwIfAborted()
    validatePage(page, source)
    accumulator.append(page)
  }
  return accumulator.finish()
}

const assembleEnvelope = (
  tiles: Array<{ result: WaveformPeakChannelSlice; startFrame: number; endFrame: number }>,
  startFrame: number,
  endFrame: number,
  columns: number,
  sampleRate: number,
): WaveformPeakChannelSlice => {
  const channelCount = tiles[0]?.result.channels.length ?? 0
  const channels = Array.from({ length: channelCount }, () => new Uint8Array(columns * 2))
  channels.forEach((channel) => channel.fill(SILENCE_BYTE))
  for (let column = 0; column < columns; column += 1) {
    const columnStart = startFrame + Math.floor(column * (endFrame - startFrame) / columns)
    const columnEnd = Math.max(
      columnStart + 1,
      startFrame + Math.ceil((column + 1) * (endFrame - startFrame) / columns),
    )
    for (let channel = 0; channel < channelCount; channel += 1) {
      let min = 1
      let max = -1
      let touched = false
      for (const tile of tiles) {
        const overlapStart = Math.max(columnStart, tile.startFrame)
        const overlapEnd = Math.min(columnEnd, tile.endFrame)
        if (overlapEnd <= overlapStart) continue
        const tileColumns = tile.result.columns
        const localStart = Math.max(
          0,
          Math.floor((overlapStart - tile.startFrame) * tileColumns / (tile.endFrame - tile.startFrame)),
        )
        const localEnd = Math.min(
          tileColumns,
          Math.max(
            localStart + 1,
            Math.ceil((overlapEnd - tile.startFrame) * tileColumns / (tile.endFrame - tile.startFrame)),
          ),
        )
        const peaks = tile.result.channels[channel]
        if (!peaks) continue
        for (let local = localStart; local < localEnd; local += 1) {
          min = Math.min(min, decodePeakByte(peaks[local * 2] ?? 128))
          max = Math.max(max, decodePeakByte(peaks[local * 2 + 1] ?? 128))
          touched = true
        }
      }
      if (touched) {
        channels[channel]![column * 2] = encodePeakByte(min)
        channels[channel]![column * 2 + 1] = encodePeakByte(max)
      }
    }
  }
  return {
    mode: 'pcm-envelope',
    columns,
    channels,
    sourceStartSec: startFrame / sampleRate,
    sourceEndSec: endFrame / sampleRate,
  }
}

const assembleLine = (
  tiles: Array<{ result: WaveformSampleChannelSlice; startFrame: number; endFrame: number }>,
  startFrame: number,
  endFrame: number,
  sourceStartSec: number,
  sourceEndSec: number,
  sampleRate: number,
): WaveformSampleChannelSlice => {
  const channelCount = tiles[0]?.result.channels.length ?? 0
  const channels = Array.from({ length: channelCount }, () => new Float32Array(endFrame - startFrame))
  for (const tile of tiles) {
    const overlapStart = Math.max(startFrame, tile.startFrame)
    const overlapEnd = Math.min(endFrame, tile.endFrame)
    if (overlapEnd <= overlapStart) continue
    const sourceOffset = overlapStart - tile.startFrame
    const targetOffset = overlapStart - startFrame
    for (let channel = 0; channel < channelCount; channel += 1) {
      const source = tile.result.channels[channel]
      const target = channels[channel]
      if (source && target) {
        target.set(
          source.subarray(sourceOffset, sourceOffset + overlapEnd - overlapStart),
          targetOffset,
        )
      }
    }
  }
  return {
    mode: 'pcm-line',
    channels,
    firstFrame: startFrame,
    sampleRate,
    sourceStartSec,
    sourceEndSec,
  }
}

type TileResult = {
  result: WaveformPcmResult
  startFrame: number
  endFrame: number
}

const isEnvelopeTile = (
  tile: TileResult,
): tile is TileResult & { result: WaveformPeakChannelSlice } => tile.result.mode === 'pcm-envelope'

const isLineTile = (
  tile: TileResult,
): tile is TileResult & { result: WaveformSampleChannelSlice } => tile.result.mode === 'pcm-line'

type SchedulerOptions = {
  maxConcurrent?: number
  maxQueued?: number
  maxCacheBytes?: number
  maxCacheEntryBytes?: number
  maxCacheEntries?: number
  decode?: ArrangementWaveformPcmDecoder
}

export function createArrangementWaveformPcmScheduler(options: SchedulerOptions = {}) {
  const maxConcurrent = options.maxConcurrent ?? ARRANGEMENT_PCM_MAX_CONCURRENT
  const maxQueued = options.maxQueued ?? ARRANGEMENT_PCM_MAX_QUEUE
  const maxCacheBytes = options.maxCacheBytes ?? ARRANGEMENT_PCM_MAX_CACHE_BYTES
  const maxCacheEntryBytes = options.maxCacheEntryBytes ?? ARRANGEMENT_PCM_MAX_CACHE_ENTRY_BYTES
  const maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES
  if (!validPositiveInteger(maxConcurrent) || maxConcurrent > ARRANGEMENT_PCM_MAX_CONCURRENT
    || !Number.isSafeInteger(maxQueued) || maxQueued < 0 || maxQueued > ARRANGEMENT_PCM_MAX_QUEUE
    || !Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < 0
    || !Number.isSafeInteger(maxCacheEntryBytes) || maxCacheEntryBytes < 0
    || !Number.isSafeInteger(maxCacheEntries) || maxCacheEntries < 0
    || maxCacheEntryBytes > maxCacheBytes && maxCacheBytes > 0) {
    throw new Error('Arrangement waveform PCM scheduler limits are invalid.')
  }

  const decode = options.decode ?? decodeArrangementWaveformPcm
  const cache = new Map<string, CacheEntry>()
  const pending = new Map<string, Job>()
  const queue: Job[] = []
  let active = 0
  let sequence = 0
  let cachedBytes = 0
  const diagnostics: ArrangementWaveformPcmDiagnostics = {
    active: 0,
    peakActive: 0,
    queued: 0,
    peakQueued: 0,
    dedupeCount: 0,
    cancellationCount: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheBytes: 0,
    staleCount: 0,
    failureCount: 0,
    evictionCount: 0,
    capacityCount: 0,
  }

  const cached = (key: string) => {
    const entry = cache.get(key)
    if (!entry) {
      diagnostics.cacheMisses += 1
      return null
    }
    cache.delete(key)
    cache.set(key, entry)
    diagnostics.cacheHits += 1
    return cloneResult(entry.value)
  }

  const store = (key: string, value: WaveformPcmResult) => {
    const bytes = resultBytes(value)
    if (bytes === 0 || bytes > maxCacheEntryBytes || bytes > maxCacheBytes) return
    const existing = cache.get(key)
    if (existing) cachedBytes -= existing.bytes
    cache.delete(key)
    cache.set(key, { value: cloneResult(value), bytes })
    cachedBytes += bytes
    while (cache.size > maxCacheEntries || cachedBytes > maxCacheBytes) {
      const oldestKey = cache.keys().next().value
      if (oldestKey === undefined) break
      const oldest = cache.get(oldestKey)
      cache.delete(oldestKey)
      if (oldest) cachedBytes -= oldest.bytes
    }
    diagnostics.cacheBytes = cachedBytes
  }

  const removeSubscriber = (job: Job, subscriber: Subscriber) => {
    if (subscriber.signal && subscriber.onAbort) {
      subscriber.signal.removeEventListener('abort', subscriber.onAbort)
    }
    job.subscribers.delete(subscriber)
  }

  const settle = (job: Job, value: WaveformPcmResult | null) => {
    for (const subscriber of Array.from(job.subscribers)) {
      removeSubscriber(job, subscriber)
      subscriber.resolve(subscriber.signal?.aborted ? null : value ? cloneResult(value) : null)
    }
  }

  const abandon = (job: Job) => {
    if (job.subscribers.size > 0) return
    if (job.active) {
      job.controller.abort()
      pending.delete(job.key)
      return
    }
    const index = queue.indexOf(job)
    if (index >= 0) queue.splice(index, 1)
    pending.delete(job.key)
    diagnostics.queued = queue.length
  }

  const pump = () => {
    queue.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence)
    while (active < maxConcurrent && queue.length > 0) {
      const job = queue.shift()
      diagnostics.queued = queue.length
      if (!job) break
      if (job.subscribers.size === 0) {
        pending.delete(job.key)
        continue
      }
      job.active = true
      active += 1
      diagnostics.active = active
      diagnostics.peakActive = Math.max(diagnostics.peakActive, active)
      let result: Promise<WaveformPcmResult | null>
      try {
        result = decode({
          ...job.request,
          tileStartFrame: job.tileStartFrame,
          tileEndFrame: job.tileEndFrame,
        }, job.controller.signal)
      } catch (error) {
        result = Promise.reject(error)
      }
      void result.then((value) => {
        if (value && !job.controller.signal.aborted) store(job.key, value)
        pending.delete(job.key)
        settle(job, value)
      }).catch((error) => {
        pending.delete(job.key)
        if (error instanceof ArrangementWaveformStaleError) diagnostics.staleCount += 1
        else if (!job.controller.signal.aborted) diagnostics.failureCount += 1
        settle(job, null)
      }).finally(() => {
        active -= 1
        job.active = false
        diagnostics.active = active
        pump()
      })
    }
  }

  const subscribe = (job: Job, signal?: AbortSignal) => new Promise<WaveformPcmResult | null>((resolve) => {
    const subscriber: Subscriber = { resolve, signal }
    subscriber.onAbort = () => {
      if (!job.subscribers.has(subscriber)) return
      removeSubscriber(job, subscriber)
      diagnostics.cancellationCount += 1
      resolve(null)
      abandon(job)
    }
    job.subscribers.add(subscriber)
    signal?.addEventListener('abort', subscriber.onAbort, { once: true })
    if (signal?.aborted) subscriber.onAbort()
  })

  const requestTile = (input: ArrangementWaveformPcmRequest, tile: {
    tileStartFrame: number
    tileEndFrame: number
  }) => {
    if (input.signal?.aborted) return Promise.resolve<WaveformPcmResult | null>(null)
    const key = requestKey(input, tile.tileStartFrame, tile.tileEndFrame)
    const cachedResult = cached(key)
    if (cachedResult) return Promise.resolve(cachedResult)
    const existing = pending.get(key)
    if (existing) {
      diagnostics.dedupeCount += 1
      const priority = normalizePriority(input.priority)
      if (!existing.active && priority < existing.priority) existing.priority = priority
      return subscribe(existing, input.signal)
    }
    if (queue.length >= maxQueued) {
      const priority = normalizePriority(input.priority)
      const lowestPriorityIndex = queue.reduce((worstIndex, candidate, index) => {
        const worst = queue[worstIndex]
        if (!worst) return index
        return candidate.priority > worst.priority
          || (candidate.priority === worst.priority && candidate.sequence > worst.sequence)
          ? index
          : worstIndex
      }, 0)
      const lowestPriority = queue[lowestPriorityIndex]
      if (lowestPriority && priority < lowestPriority.priority) {
        queue.splice(lowestPriorityIndex, 1)
        pending.delete(lowestPriority.key)
        diagnostics.evictionCount += 1
        diagnostics.queued = queue.length
        settle(lowestPriority, null)
      } else {
        diagnostics.capacityCount += 1
        return Promise.resolve<WaveformPcmResult | null>(null)
      }
    }

    const job: Job = {
      key,
      request: {
        assetKey: input.assetKey,
        sourceIdentity: input.sourceIdentity,
        source: input.source,
        sourceStartSec: input.sourceStartSec,
        sourceEndSec: input.sourceEndSec,
        columns: input.exactRange ? input.columns : tile.tileEndFrame - tile.tileStartFrame,
        sampleRate: input.sampleRate,
        channelCount: input.channelCount,
        mode: input.mode,
        exactRange: input.exactRange,
      },
      tileStartFrame: tile.tileStartFrame,
      tileEndFrame: tile.tileEndFrame,
      priority: normalizePriority(input.priority),
      sequence,
      controller: new AbortController(),
      subscribers: new Set(),
      active: false,
    }
    sequence += 1
    pending.set(key, job)
    queue.push(job)
    diagnostics.queued = queue.length
    diagnostics.peakQueued = Math.max(diagnostics.peakQueued, queue.length)
    const result = subscribe(job, input.signal)
    pump()
    return result
  }

  const request = async (input: ArrangementWaveformPcmRequest) => {
    const bounds = requestBounds(input)
    if (!bounds || input.signal?.aborted) return null
    const results: Array<WaveformPcmResult | null> = []
    const maxOutstanding = maxConcurrent + maxQueued
    for (let offset = 0; offset < bounds.tiles.length; offset += maxOutstanding) {
      if (input.signal?.aborted) return null
      const batch = bounds.tiles.slice(offset, offset + maxOutstanding)
      const batchResults = await Promise.all(batch.map((tile) => requestTile(input, tile)))
      results.push(...batchResults)
      if (batchResults.some((result) => result === null)) return null
    }
    if (results.some((result) => result === null)) return null
    if (input.exactRange && results.length === 1) {
      const result = results[0]
      return result ? cloneResult(result) : null
    }
    const mode = input.mode ?? 'pcm-envelope'
    const tileResults = results.flatMap((result, index) => {
      if (!result) return []
      const tile = bounds.tiles[index]
      if (!tile) return []
      const startFrame = result.sourceStartSec === undefined
        ? tile.tileStartFrame
        : Math.max(tile.tileStartFrame, Math.floor(result.sourceStartSec * input.sampleRate))
      const endFrame = result.sourceEndSec === undefined
        ? tile.tileEndFrame
        : Math.min(tile.tileEndFrame, Math.ceil(result.sourceEndSec * input.sampleRate))
      return endFrame > startFrame ? [{ result, startFrame, endFrame }] : []
    })
    if (tileResults.length !== bounds.tiles.length) return null
    if (mode === 'pcm-envelope') {
      const envelopeTiles = tileResults.filter(isEnvelopeTile)
      return envelopeTiles.length === tileResults.length
        ? assembleEnvelope(
          envelopeTiles,
          bounds.startFrame,
          bounds.endFrame,
          input.columns,
          input.sampleRate,
        )
        : null
    }
    const lineTiles = tileResults.filter(isLineTile)
    return lineTiles.length === tileResults.length
      ? assembleLine(
        lineTiles,
        bounds.startFrame,
        bounds.endFrame,
        input.sourceStartSec,
        input.sourceEndSec,
        input.sampleRate,
      )
      : null
  }

  const clear = () => {
    for (const job of pending.values()) {
      job.controller.abort()
      settle(job, null)
    }
    pending.clear()
    queue.splice(0, queue.length)
    cache.clear()
    cachedBytes = 0
    diagnostics.queued = 0
    diagnostics.cacheBytes = 0
  }

  return {
    request,
    clear,
    getDiagnostics: (): ArrangementWaveformPcmDiagnostics => ({ ...diagnostics }),
  }
}

export const arrangementWaveformPcmScheduler = createArrangementWaveformPcmScheduler()
