import {
  createAudioPcmSourceDescriptor,
  getAudioBufferSessionIdentity,
  type AudioPcmSourceDescriptor,
} from '@daw-browser/audio-engine/media-pages'
import { extractPeakAsset } from './extract-peaks'
import {
  deletePeakGenerationChunks,
  loadPeakAssetRecord,
  loadPeakChunk,
  storePeakAssetRecord,
  storePeakChunk,
} from './peak-db'
import { createWaveformSourceIdentity, peakAssetMatchesSourceIdentity } from './source-identity'
import type {
  EnsureWaveformAssetOptions,
  PeakAssetRecord,
  WaveformChunkData,
  WaveformSourceIdentity,
} from './types'

const MAX_RECORD_CACHE_ENTRIES = 32
const MAX_CHUNK_CACHE_ENTRIES = 64
const records = new Map<string, PeakAssetRecord>()
const chunks = new Map<string, WaveformChunkData>()
type PendingRecord = {
  readonly key: string
  readonly promise: Promise<PeakAssetRecord | null>
  readonly controller: AbortController
  readonly subscribers: Set<(value: PeakAssetRecord | null) => void>
}
type Generation = {
  readonly key: string
  readonly token: object
  readonly controller: AbortController
}
const pendingRecords = new Map<string, PendingRecord>()
const pendingChunks = new Map<string, Promise<WaveformChunkData | null>>()
const latestGeneration = new Map<string, Generation>()
const publicationTails = new Map<string, Promise<void>>()
let cacheEpoch = 0

const cacheSet = <Key, Value>(cache: Map<Key, Value>, key: Key, value: Value, limit: number) => {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > limit) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

const cacheGet = <Key, Value>(cache: Map<Key, Value>, key: Key) => {
  const value = cache.get(key)
  if (value === undefined) return undefined
  cache.delete(key)
  cache.set(key, value)
  return value
}

export const createWaveformSourceFromBuffer = (buffer: AudioBuffer): AudioPcmSourceDescriptor => (
  createAudioPcmSourceDescriptor({
    identity: getAudioBufferSessionIdentity(buffer),
    durationSec: buffer.duration,
    frameCount: buffer.length,
    sampleRate: buffer.sampleRate,
    channelCount: buffer.numberOfChannels,
    source: buffer,
  })
)

const sourceFor = (options: EnsureWaveformAssetOptions) => (
  options.source ?? (options.buffer ? createWaveformSourceFromBuffer(options.buffer) : undefined)
)

const identityFor = (
  assetKey: string,
  source: AudioPcmSourceDescriptor | undefined,
  identity: WaveformSourceIdentity | undefined,
) => {
  if (identity) return createWaveformSourceIdentity(identity)
  if (!source) return undefined
  return createWaveformSourceIdentity({
    assetKey,
    identity: source.identity,
    durationSec: source.durationSec,
    frameCount: source.frameCount,
    sampleRate: source.sampleRate,
    channelCount: source.channelCount,
  })
}

const generationKey = (
  assetKey: string,
  identity: WaveformSourceIdentity | undefined,
) => JSON.stringify([assetKey, identity])

const discardUnpublishedGeneration = async (assetKey: string, generationId: string) => {
  await deletePeakGenerationChunks(assetKey, generationId)
  const prefix = `${assetKey}:${generationId}:`
  for (const key of chunks.keys()) {
    if (key.startsWith(prefix)) chunks.delete(key)
  }
}

const publishRecord = async (
  assetKey: string,
  record: PeakAssetRecord,
  isCurrent: () => boolean,
): Promise<boolean> => {
  const previous = publicationTails.get(assetKey) ?? Promise.resolve()
  let release: () => void = () => {}
  const tail = new Promise<void>((resolve) => {
    release = resolve
  })
  publicationTails.set(assetKey, tail)
  try {
    await previous
    if (!isCurrent()) return false
    await storePeakAssetRecord(record)
    return true
  } finally {
    release()
    if (publicationTails.get(assetKey) === tail) publicationTails.delete(assetKey)
  }
}

export async function ensurePeakAsset(options: EnsureWaveformAssetOptions): Promise<PeakAssetRecord | null> {
  options.signal?.throwIfAborted()
  const source = sourceFor(options)
  const identity = identityFor(options.assetKey, source, options.sourceIdentity)
  const current = options.forceRegenerate ? undefined : cacheGet(records, options.assetKey)
  if (current && peakAssetMatchesSourceIdentity(current, identity)) return current
  if (!source) return null

  const key = generationKey(options.assetKey, identity)
  const pending = pendingRecords.get(key)
  if (pending) return await subscribeToRecord(pending, options.signal)
  const generationToken = {}
  const controller = new AbortController()
  const previous = latestGeneration.get(options.assetKey)
  if (previous) {
    const previousPending = pendingRecords.get(previous.key)
    if (previousPending?.controller === previous.controller) {
      pendingRecords.delete(previous.key)
      for (const finish of previousPending.subscribers) finish(null)
    }
    previous.controller.abort()
  }
  const generation: Generation = { key, token: generationToken, controller }
  latestGeneration.set(options.assetKey, generation)
  const generationEpoch = cacheEpoch
  const task = (async () => {
    let generationId: string | undefined
    let published = false
    const isCurrent = () => (
      cacheEpoch === generationEpoch
      && latestGeneration.get(options.assetKey)?.token === generationToken
    )
    let stored: PeakAssetRecord | null = null
    try {
      stored = source.persistable === true ? await loadPeakAssetRecord(options.assetKey) : null
      controller.signal.throwIfAborted()
      if (!options.forceRegenerate && stored && peakAssetMatchesSourceIdentity(stored, identity)) {
        if (!isCurrent()) return null
        cacheSet(records, options.assetKey, stored, MAX_RECORD_CACHE_ENTRIES)
        published = true
        return stored
      }
      const record = await extractPeakAsset(source, options.assetKey, {
        signal: controller.signal,
        onGeneration: (nextRecord) => {
          generationId = nextRecord.generationId
        },
        onChunk: async ({ meta, data }) => {
          controller.signal.throwIfAborted()
          if (!isCurrent()) {
            controller.abort()
            controller.signal.throwIfAborted()
          }
          if (source.persistable === true) await storePeakChunk(meta.chunkKey, data)
          if (!isCurrent()) {
            controller.abort()
            controller.signal.throwIfAborted()
          }
          cacheSet(chunks, meta.chunkKey, data, MAX_CHUNK_CACHE_ENTRIES)
        },
      }, identity)
      controller.signal.throwIfAborted()
      if (!isCurrent()) return null
      if (source.persistable === true) {
        const committed = await publishRecord(options.assetKey, record, isCurrent)
        if (committed) published = true
        if (!isCurrent()) return null
        if (stored && stored.generationId !== record.generationId) {
          await deletePeakGenerationChunks(options.assetKey, stored.generationId)
        }
        if (!isCurrent()) return null
      } else {
        published = true
      }
      if (!isCurrent()) return null
      cacheSet(records, options.assetKey, record, MAX_RECORD_CACHE_ENTRIES)
      return record
    } finally {
      if (latestGeneration.get(options.assetKey)?.token === generationToken) {
        latestGeneration.delete(options.assetKey)
      }
      if (!published && source.persistable === true && generationId) {
        await discardUnpublishedGeneration(options.assetKey, generationId)
      }
    }
  })()
  const pendingRecord: PendingRecord = { key, promise: task, controller, subscribers: new Set() }
  pendingRecords.set(key, pendingRecord)
  void task.finally(() => {
    if (pendingRecords.get(key) === pendingRecord) pendingRecords.delete(key)
  }).catch(() => {})
  return await subscribeToRecord(pendingRecord, options.signal)
}

async function subscribeToRecord(
  pending: PendingRecord,
  signal?: AbortSignal,
): Promise<PeakAssetRecord | null> {
  if (signal?.aborted) return null
  return await new Promise<PeakAssetRecord | null>((resolve) => {
    let settled = false
    const finish = (value: PeakAssetRecord | null) => {
      if (settled) return
      settled = true
      pending.subscribers.delete(finish)
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => {
      finish(null)
      if (pending.subscribers.size !== 0) return
      if (pendingRecords.get(pending.key) === pending) pendingRecords.delete(pending.key)
      pending.controller.abort()
    }
    pending.subscribers.add(finish)
    signal?.addEventListener('abort', onAbort, { once: true })
    void pending.promise.then(finish, () => finish(null))
  })
}

export async function loadPeakChunkData(chunkKey: string): Promise<WaveformChunkData | null> {
  const current = cacheGet(chunks, chunkKey)
  if (current) return current
  const pending = pendingChunks.get(chunkKey)
  if (pending) return await pending
  const epoch = cacheEpoch
  const task = loadPeakChunk(chunkKey).then((value) => {
    if (cacheEpoch !== epoch) return null
    if (value) cacheSet(chunks, chunkKey, value, MAX_CHUNK_CACHE_ENTRIES)
    return value
  })
  pendingChunks.set(chunkKey, task)
  try {
    return await task
  } finally {
    if (pendingChunks.get(chunkKey) === task) pendingChunks.delete(chunkKey)
  }
}

export async function loadCachedPeakAsset(assetKey: string) {
  const current = cacheGet(records, assetKey)
  if (current) return current
  const epoch = cacheEpoch
  const stored = await loadPeakAssetRecord(assetKey)
  if (cacheEpoch !== epoch) return null
  if (stored) cacheSet(records, assetKey, stored, MAX_RECORD_CACHE_ENTRIES)
  return stored
}

export function clearWaveformAssetCache() {
  cacheEpoch += 1
  for (const pending of pendingRecords.values()) {
    for (const finish of pending.subscribers) finish(null)
    pending.controller.abort()
  }
  records.clear()
  chunks.clear()
  pendingRecords.clear()
  pendingChunks.clear()
  latestGeneration.clear()
}

export const waveformCacheLimits = {
  recordEntries: MAX_RECORD_CACHE_ENTRIES,
  chunkEntries: MAX_CHUNK_CACHE_ENTRIES,
}

export const getWaveformCacheSizes = () => ({
  recordEntries: records.size,
  chunkEntries: chunks.size,
  generationEntries: latestGeneration.size,
})
