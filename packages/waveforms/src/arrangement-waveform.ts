import type { AudioPcmSourceDescriptor } from '@daw-browser/audio-engine/media-pages'
import { loadWaveformSourceData } from './select-waveform-window'
import type { WaveformSourceData, WaveformSourceIdentity } from './types'

export const ARRANGEMENT_PCM_TILE_FRAMES = 16_384
export const ARRANGEMENT_PCM_TILE_INTERVALS = 128
export const ARRANGEMENT_PCM_MAX_CONCURRENT = 2
export const ARRANGEMENT_PCM_MAX_QUEUE = 64
export const ARRANGEMENT_PCM_MAX_CACHE_BYTES = 32 * 1024 * 1024
export const ARRANGEMENT_PCM_MAX_CACHE_ENTRY_BYTES = 8 * 1024 * 1024
export const ARRANGEMENT_PCM_MAX_CACHE_ENTRIES = 128

const tileSpanFor = (framesPerInterval: number) => {
  const minimumFrames = Math.max(
    ARRANGEMENT_PCM_TILE_FRAMES,
    ARRANGEMENT_PCM_TILE_INTERVALS * framesPerInterval,
  )
  return Math.ceil(minimumFrames / framesPerInterval) * framesPerInterval
}

export type ArrangementWaveformRequest = {
  readonly assetKey: string
  readonly sourceIdentity: string
  readonly sourceIdentityMetadata?: WaveformSourceIdentity
  readonly source: (signal: AbortSignal) => Promise<AudioPcmSourceDescriptor | null>
  readonly sourceStartFrame: number
  readonly sourceEndFrame: number
  readonly framesPerInterval: number
  readonly priority?: number
  readonly signal?: AbortSignal
}

export type ArrangementWaveformDecoder = (
  request: ArrangementWaveformRequest & { readonly tileStartFrame: number; readonly tileEndFrame: number },
  signal: AbortSignal,
) => Promise<WaveformSourceData | null>

export type ArrangementWaveformDiagnostics = {
  readonly active: number
  readonly peakActive: number
  readonly queued: number
  readonly peakQueued: number
  readonly dedupeCount: number
  readonly cancellationCount: number
  readonly cacheHits: number
  readonly cacheMisses: number
  readonly cacheBytes: number
  readonly failureCount: number
  readonly admission: number
  readonly peakAdmission: number
}
type MutableDiagnostics = {
  -readonly [Key in keyof ArrangementWaveformDiagnostics]: ArrangementWaveformDiagnostics[Key]
}

type Job = {
  readonly key: string
  readonly epoch: number
  readonly request: ArrangementWaveformRequest
  readonly tileStartFrame: number
  readonly tileEndFrame: number
  readonly controller: AbortController
  readonly subscribers: Set<Subscriber>
  priority: number
  sequence: number
  active: boolean
}
type Subscriber = {
  readonly resolve: (value: WaveformSourceData | null) => void
  readonly reject: (reason?: Error) => void
  readonly signal?: AbortSignal
  onAbort?: () => void
}

const dataBytes = (data: WaveformSourceData) => data.channels.reduce(
  (total, channel) => total + channel.byteLength,
  0,
)

const cloneData = (data: WaveformSourceData): WaveformSourceData => {
  if (data.kind === 'samples') {
    return { ...data, channels: data.channels.map((channel) => channel.slice()) }
  }
  if (data.encoding === 'signed-u8') {
    return { ...data, channels: data.channels.map((channel) => channel.slice()) }
  }
  return { ...data, channels: data.channels.map((channel) => channel.slice()) }
}

const requestKey = (request: ArrangementWaveformRequest, start: number, end: number) => JSON.stringify([
  request.assetKey,
  request.sourceIdentity,
  request.sourceIdentityMetadata,
  request.framesPerInterval,
  start,
  end,
])

export function createArrangementWaveformScheduler(options: {
  readonly maxConcurrent?: number
  readonly maxQueued?: number
  readonly maxCacheBytes?: number
  readonly maxCacheEntryBytes?: number
  readonly maxCacheEntries?: number
  readonly decode?: ArrangementWaveformDecoder
} = {}) {
  const maxConcurrent = options.maxConcurrent ?? ARRANGEMENT_PCM_MAX_CONCURRENT
  const maxQueued = options.maxQueued ?? ARRANGEMENT_PCM_MAX_QUEUE
  const maxCacheBytes = options.maxCacheBytes ?? ARRANGEMENT_PCM_MAX_CACHE_BYTES
  const maxCacheEntryBytes = options.maxCacheEntryBytes ?? ARRANGEMENT_PCM_MAX_CACHE_ENTRY_BYTES
  const maxCacheEntries = options.maxCacheEntries ?? ARRANGEMENT_PCM_MAX_CACHE_ENTRIES
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0
    || !Number.isSafeInteger(maxQueued) || maxQueued < 0
    || !Number.isSafeInteger(maxCacheBytes) || maxCacheBytes <= 0
    || !Number.isSafeInteger(maxCacheEntryBytes) || maxCacheEntryBytes <= 0
    || !Number.isSafeInteger(maxCacheEntries) || maxCacheEntries <= 0) {
    throw new Error('Waveform scheduler limits are invalid.')
  }
  const decode = options.decode ?? (async (request, signal) => {
    const source = await request.source(signal)
    if (!source || source.identity !== request.sourceIdentity) return null
    return await loadWaveformSourceData({
      assetKey: request.assetKey,
      sourceIdentity: request.sourceIdentityMetadata ?? {
        assetKey: request.assetKey,
        identity: source.identity,
        frameCount: source.frameCount,
        durationSec: source.durationSec,
        sampleRate: source.sampleRate,
        channelCount: source.channelCount,
      },
      source,
      sourceStartFrame: request.tileStartFrame,
      sourceEndFrame: request.tileEndFrame,
      framesPerInterval: request.framesPerInterval,
      signal,
    })
  })
  const cache = new Map<string, { data: WaveformSourceData; bytes: number }>()
  const pending = new Map<string, Job>()
  const queue: Job[] = []
  type AdmissionResult = 'admitted' | 'retry' | 'aborted'
  let admissionSignal: Promise<AdmissionResult>
  let resolveAdmissionSignal: (result: AdmissionResult) => void = () => {}
  let epoch = 0
  let active = 0
  let sequence = 0
  let cacheBytes = 0
  const diagnostics: MutableDiagnostics = {
    active: 0,
    peakActive: 0,
    queued: 0,
    peakQueued: 0,
    dedupeCount: 0,
    cancellationCount: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheBytes: 0,
    failureCount: 0,
    admission: 0,
    peakAdmission: 0,
  }
  const resetAdmissionSignal = () => {
    admissionSignal = new Promise<AdmissionResult>((resolve) => {
      resolveAdmissionSignal = resolve
    })
  }
  resetAdmissionSignal()
  type AdmissionWaiter = {
    readonly resolve: (result: AdmissionResult) => void
    readonly signal?: AbortSignal
    readonly onAbort: () => void
    readonly priority: number
    readonly sequence: number
  }
  const admissionWaiters = new Set<AdmissionWaiter>()
  const maxAdmissionWaiters = Math.max(1, maxConcurrent + Math.max(1, maxQueued))
  const availableAdmissionSlots = () => (
    Math.max(0, maxConcurrent - active) + Math.max(0, maxQueued - queue.length)
  )
  const notifyAdmissionWaiters = () => {
    const slots = availableAdmissionSlots()
    if (slots <= 0) return
    const waiters = [...admissionWaiters]
      .sort((left, right) => left.priority - right.priority || left.sequence - right.sequence)
    for (const waiter of waiters.slice(0, slots)) {
      waiter.signal?.removeEventListener('abort', waiter.onAbort)
      waiter.resolve('admitted')
    }
    resolveAdmissionSignal('retry')
    resetAdmissionSignal()
  }
  const waitForAdmission = (priority: number, signal?: AbortSignal): Promise<AdmissionResult> => {
    if (signal?.aborted) return Promise.resolve('aborted')
    const sequenceNumber = sequence++
    if (admissionWaiters.size >= maxAdmissionWaiters) {
      const worst = [...admissionWaiters]
        .sort((left, right) => right.priority - left.priority || right.sequence - left.sequence)[0]
      if (!worst || priority >= worst.priority) {
        const signalToAwait = admissionSignal
        return new Promise<AdmissionResult>((resolve) => {
          let settled = false
          const finish = (result: AdmissionResult) => {
            if (settled) return
            settled = true
            if (signal && onAbort) signal.removeEventListener('abort', onAbort)
            resolve(result)
          }
          const onAbort = () => finish('aborted')
          signal?.addEventListener('abort', onAbort, { once: true })
        void signalToAwait.then(finish)
        })
      }
      admissionWaiters.delete(worst)
      worst.signal?.removeEventListener('abort', worst.onAbort)
      worst.resolve('retry')
    }
    return new Promise<AdmissionResult>((resolve) => {
      const waiter: AdmissionWaiter = {
        resolve: (result) => {
          admissionWaiters.delete(waiter)
          diagnostics.admission = admissionWaiters.size
          resolve(result)
        },
        signal,
        priority,
        sequence: sequenceNumber,
        onAbort: () => {
          admissionWaiters.delete(waiter)
          diagnostics.admission = admissionWaiters.size
          resolve('aborted')
        },
      }
      admissionWaiters.add(waiter)
      diagnostics.admission = admissionWaiters.size
      diagnostics.peakAdmission = Math.max(diagnostics.peakAdmission, diagnostics.admission)
      signal?.addEventListener('abort', waiter.onAbort, { once: true })
    })
  }

  const cacheGet = (key: string) => {
    const entry = cache.get(key)
    if (!entry) {
      diagnostics.cacheMisses += 1
      return null
    }
    cache.delete(key)
    cache.set(key, entry)
    diagnostics.cacheHits += 1
    return cloneData(entry.data)
  }
  const cacheSet = (key: string, data: WaveformSourceData) => {
    const bytes = dataBytes(data)
    if (bytes <= 0 || bytes > maxCacheEntryBytes || bytes > maxCacheBytes) return
    const previous = cache.get(key)
    if (previous) cacheBytes -= previous.bytes
    cache.delete(key)
    cache.set(key, { data: cloneData(data), bytes })
    cacheBytes += bytes
    while (cacheBytes > maxCacheBytes || cache.size > maxCacheEntries) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      const entry = cache.get(oldest)
      cache.delete(oldest)
      if (entry) cacheBytes -= entry.bytes
    }
    diagnostics.cacheBytes = cacheBytes
  }
  const settle = (job: Job, value: WaveformSourceData | null, error?: Error) => {
    for (const subscriber of job.subscribers) {
      if (subscriber.onAbort && subscriber.signal) {
        subscriber.signal.removeEventListener('abort', subscriber.onAbort)
      }
      if (error) subscriber.reject(error)
      else subscriber.resolve(value ? cloneData(value) : null)
    }
    job.subscribers.clear()
  }
  const cancelQueuedJob = (job: Job) => {
    job.controller.abort()
    if (pending.get(job.key) === job) pending.delete(job.key)
    const index = queue.indexOf(job)
    if (index >= 0) queue.splice(index, 1)
    settle(job, null)
    diagnostics.queued = queue.length
    notifyAdmissionWaiters()
  }
  const pump = () => {
    queue.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence)
    while (active < maxConcurrent && queue.length > 0) {
      const job = queue.shift()
      if (!job) break
      diagnostics.queued = queue.length
      notifyAdmissionWaiters()
      if (job.subscribers.size === 0) {
        pending.delete(job.key)
        continue
      }
      job.active = true
      active += 1
      diagnostics.active = active
      diagnostics.peakActive = Math.max(diagnostics.peakActive, active)
      const complete = (data: WaveformSourceData | null, failed: boolean, error?: Error) => {
        if (job.epoch !== epoch) return
        let result = data
        let didFail = failed
        if (data && !job.controller.signal.aborted) {
          try {
            cacheSet(job.key, data)
          } catch {
            result = null
            didFail = true
          }
        }
        if (didFail) diagnostics.failureCount += 1
        if (pending.get(job.key) === job) pending.delete(job.key)
        active -= 1
        job.active = false
        diagnostics.active = active
        pump()
        notifyAdmissionWaiters()
        settle(
          job,
          result && !job.controller.signal.aborted ? result : null,
          failed && !job.controller.signal.aborted
            ? error instanceof Error ? error : new Error('Waveform decoding failed.')
            : undefined,
        )
      }
      void decode({ ...job.request, tileStartFrame: job.tileStartFrame, tileEndFrame: job.tileEndFrame }, job.controller.signal)
        .then(
          (data) => complete(data, false),
          (error: Error) => complete(null, true, error),
        )
    }
  }
  const requestTile = async (request: ArrangementWaveformRequest, start: number, end: number) => {
    const key = requestKey(request, start, end)
    while (true) {
      if (request.signal?.aborted) return null
      const cached = cacheGet(key)
      if (cached) return cached
      const existing = pending.get(key)
      if (existing) {
        diagnostics.dedupeCount += 1
        const subscriberPriority = request.priority ?? 0
        if (!existing.active && subscriberPriority < existing.priority) {
          existing.priority = subscriberPriority
          queue.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence)
        }
        return await subscribe(existing, request.signal)
      }
      const candidate = queue
        .filter((job) => job.priority > (request.priority ?? 0))
        .sort((left, right) => right.priority - left.priority || right.sequence - left.sequence)[0]
      const canAdmit = active < maxConcurrent
        || (maxQueued > 0 && queue.length < maxQueued)
      if (!canAdmit && candidate) {
        cancelQueuedJob(candidate)
        diagnostics.cancellationCount += 1
      } else if (!canAdmit) {
        const admission = await waitForAdmission(request.priority ?? 0, request.signal)
        if (admission === 'aborted') return null
        continue
      }
      break
    }
    const job: Job = {
      key,
      request,
      tileStartFrame: start,
      tileEndFrame: end,
      controller: new AbortController(),
      subscribers: new Set(),
      priority: request.priority ?? 0,
      sequence: sequence++,
      active: false,
      epoch,
    }
    pending.set(key, job)
    queue.push(job)
    diagnostics.queued = queue.length
    diagnostics.peakQueued = Math.max(diagnostics.peakQueued, queue.length)
    const result = subscribe(job, request.signal)
    pump()
    return result
  }
  const subscribe = (job: Job, signal?: AbortSignal) => new Promise<WaveformSourceData | null>((resolve, reject) => {
    const subscriber: Subscriber = { resolve, reject, signal }
    const onAbort = () => {
      if (!job.subscribers.delete(subscriber)) return
      diagnostics.cancellationCount += 1
      resolve(null)
      if (job.subscribers.size > 0) return
      job.controller.abort()
      if (pending.get(job.key) === job) pending.delete(job.key)
      if (!job.active) {
        const index = queue.indexOf(job)
        if (index >= 0) queue.splice(index, 1)
        diagnostics.queued = queue.length
      }
      if (!job.active) settle(job, null)
    }
    if (signal) {
      subscriber.onAbort = onAbort
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    }
    if (!signal?.aborted) job.subscribers.add(subscriber)
  })
  const request = async (input: ArrangementWaveformRequest) => {
    if (
      input.signal?.aborted
      || !Number.isSafeInteger(input.sourceStartFrame)
      || input.sourceStartFrame < 0
      || !Number.isSafeInteger(input.sourceEndFrame)
      || input.sourceEndFrame <= input.sourceStartFrame
      || !Number.isSafeInteger(input.framesPerInterval)
      || input.framesPerInterval <= 0
    ) return null
    const tileSpan = tileSpanFor(input.framesPerInterval)
    const firstTile = Math.floor(input.sourceStartFrame / tileSpan)
    const lastTile = Math.floor((input.sourceEndFrame - 1) / tileSpan)
    const tileCount = lastTile - firstTile + 1
    const maxWorkers = Math.min(maxConcurrent, tileCount)
    const requestController = new AbortController()
    const forwardAbort = () => requestController.abort(input.signal?.reason)
    input.signal?.addEventListener('abort', forwardAbort, { once: true })
    const requestInput = { ...input, signal: requestController.signal }
    const inFlight = new Map<number, Promise<WaveformSourceData | null>>()
    let nextTile = firstTile
    const launch = () => {
      while (nextTile <= lastTile && inFlight.size < maxWorkers) {
        const tile = nextTile
        nextTile += 1
        inFlight.set(tile, requestTile(
          requestInput,
          tile * tileSpan,
          (tile + 1) * tileSpan,
        ))
      }
    }
    launch()

    let first: WaveformSourceData | undefined
    let channelCount = 0
    const clippedStart = input.sourceStartFrame
    const clippedEnd = input.sourceEndFrame
    let sampleChannels: Float32Array[] | undefined
    let byteIntervalChannels: Uint8Array[] | undefined
    let floatIntervalChannels: Float32Array[] | undefined
    let intervalOffset = 0
    const assemble = (tile: number, data: WaveformSourceData) => {
      if (!first) {
        first = data
        channelCount = data.channels.length
        if (channelCount <= 0) return false
        if (data.kind === 'samples') {
          if ((clippedEnd - clippedStart) * channelCount * Float32Array.BYTES_PER_ELEMENT > maxCacheEntryBytes) {
            return false
          }
          sampleChannels = Array.from(
            { length: channelCount },
            () => new Float32Array(clippedEnd - clippedStart),
          )
        } else {
          const intervalsPerTile = tileSpan / data.framesPerInterval
          const maxIntervals = tileCount * intervalsPerTile
          const bytesPerInterval = data.encoding === 'signed-u8' ? 1 : Float32Array.BYTES_PER_ELEMENT
          if (maxIntervals * channelCount * bytesPerInterval * 2 > maxCacheEntryBytes) return false
          if (data.encoding === 'signed-u8') {
            byteIntervalChannels = Array.from(
              { length: channelCount },
              () => new Uint8Array(maxIntervals * 2),
            )
          } else {
            floatIntervalChannels = Array.from(
              { length: channelCount },
              () => new Float32Array(maxIntervals * 2),
            )
          }
        }
      }
      const current = first
      if (!current
        || data.firstFrame !== tile * tileSpan
        || data.sampleRate !== current.sampleRate
        || data.sourceFrameCount !== current.sourceFrameCount
        || data.channels.length !== channelCount
        || data.kind !== current.kind
        || (data.kind === 'intervals'
          && (current.kind !== 'intervals'
            || data.framesPerInterval !== input.framesPerInterval
            || data.encoding !== current.encoding
            || data.framesPerInterval !== current.framesPerInterval))) return false
      if (data.kind === 'samples') {
        if (!sampleChannels) return false
        const dataEnd = data.firstFrame + (data.channels[0]?.length ?? 0)
        if (data.channels.some((channel) => channel.length !== dataEnd - data.firstFrame)) return false
        const overlapStart = Math.max(clippedStart, data.firstFrame)
        const overlapEnd = Math.min(clippedEnd, dataEnd)
        if (overlapEnd > overlapStart) {
          for (let channel = 0; channel < channelCount; channel += 1) {
            sampleChannels[channel]?.set(
              data.channels[channel]?.subarray(overlapStart - data.firstFrame, overlapEnd - data.firstFrame)
                ?? new Float32Array(0),
              overlapStart - clippedStart,
            )
          }
        }
        return true
      }
      if (current.kind !== 'intervals') return false
      const tileEnd = (tile + 1) * tileSpan
      const maxTileIntervals = Math.ceil((tileEnd - data.firstFrame) / data.framesPerInterval)
      if (data.intervalCount <= 0
        || data.intervalCount > maxTileIntervals
        || data.channels.some((channel) => channel.length !== data.intervalCount * 2)) return false
      for (let channel = 0; channel < channelCount; channel += 1) {
        const source = data.channels[channel]
        const target = data.encoding === 'signed-u8'
          ? byteIntervalChannels?.[channel]
          : floatIntervalChannels?.[channel]
        if (!source || !target) return false
        target.set(source, intervalOffset * 2)
      }
      intervalOffset += data.intervalCount
      return true
    }
    let complete = false
    try {
      for (let tile = firstTile; tile <= lastTile; tile += 1) {
        const pending = inFlight.get(tile)
        if (!pending) return null
        const value = await pending
        inFlight.delete(tile)
        if (!value || !assemble(tile, value)) return null
        launch()
      }
      complete = true
    } finally {
      input.signal?.removeEventListener('abort', forwardAbort)
      if (!complete) requestController.abort()
    }
    if (!first) return null
    if (first.kind === 'samples') {
      if (!sampleChannels) return null
      return { ...first, firstFrame: clippedStart, channels: sampleChannels, sourceFrameCount: first.sourceFrameCount }
    }
    if (first.encoding === 'signed-u8') {
      if (!byteIntervalChannels) return null
      return {
        ...first,
        firstFrame: firstTile * tileSpan,
        intervalCount: intervalOffset,
        channels: byteIntervalChannels.map((channel) => channel.subarray(0, intervalOffset * 2)),
      }
    }
    if (!floatIntervalChannels) return null
    return {
      ...first,
      firstFrame: firstTile * tileSpan,
      intervalCount: intervalOffset,
      channels: floatIntervalChannels.map((channel) => channel.subarray(0, intervalOffset * 2)),
    }
  }
  return {
    request,
    clear: () => {
      epoch += 1
      for (const job of pending.values()) {
        settle(job, null)
        job.controller.abort()
        job.active = false
      }
      pending.clear()
      queue.splice(0)
      active = 0
      diagnostics.active = 0
      diagnostics.queued = 0
      for (const waiter of admissionWaiters) {
        waiter.signal?.removeEventListener('abort', waiter.onAbort)
        waiter.resolve('aborted')
      }
      diagnostics.admission = 0
      resolveAdmissionSignal('aborted')
      resetAdmissionSignal()
      cache.clear()
      cacheBytes = 0
      diagnostics.cacheBytes = 0
    },
    getDiagnostics: () => ({ ...diagnostics }),
  }
}

export const arrangementWaveformScheduler = createArrangementWaveformScheduler()
