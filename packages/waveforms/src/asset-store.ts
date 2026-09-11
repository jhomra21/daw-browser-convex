import {
  createAudioPcmSourceDescriptor,
  getAudioBufferSessionIdentity,
  type AudioPcmSourceDescriptor,
} from '@daw-browser/audio-engine/media-pages'
import { extractPeakAsset } from './extract-peaks'
import { loadPeakAssetRecord, loadPeakChunk, storePeakAssetRecord, storePeakChunk } from './peak-db'
import { createWaveformSourceIdentity, peakAssetMatchesSourceIdentity } from './source-identity'
import type { EnsureWaveformAssetOptions, PeakAssetRecord, WaveformSourceIdentity } from './types'

const MAX_RECORD_CACHE_ENTRIES = 32
const MAX_CHUNK_CACHE_ENTRIES = 64
const assetRecordCache = new Map<string, PeakAssetRecord>()
const assetChunkCache = new Map<string, Uint8Array>()
const pendingAssetLoads = new Map<string, Promise<PeakAssetRecord | null>>()
const pendingAssetOperations = new Map<string, PendingAssetOperation>()
const pendingChunkLoads = new Map<string, Promise<Uint8Array | null>>()
const assetGenerations = new Map<string, number>()
let generationSequence = 0

type PendingAssetOperation = {
  identityKey: string
  controller: AbortController
  promise: Promise<PeakAssetRecord | null>
  waiterCount: number
  settled: boolean
}

function cacheSet<Key, Value>(cache: Map<Key, Value>, key: Key, value: Value, limit: number) {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > limit) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

function cacheGet<Key, Value>(cache: Map<Key, Value>, key: Key) {
  const value = cache.get(key)
  if (value === undefined) return undefined
  cache.delete(key)
  cache.set(key, value)
  return value
}

function nextGeneration(assetKey: string) {
  const generation = ++generationSequence
  assetGenerations.set(assetKey, generation)
  return generation
}

function createBufferSource(assetKey: string, buffer: AudioBuffer): AudioPcmSourceDescriptor {
  return createAudioPcmSourceDescriptor({
    identity: getAudioBufferSessionIdentity(buffer),
    durationSec: buffer.duration,
    frameCount: buffer.length,
    sampleRate: buffer.sampleRate,
    channelCount: buffer.numberOfChannels,
    source: buffer,
  })
}

function getSource(options: EnsureWaveformAssetOptions) {
  return options.source ?? (options.buffer ? createBufferSource(options.assetKey, options.buffer) : undefined)
}

function createSourceIdentity(
  assetKey: string,
  source: AudioPcmSourceDescriptor | undefined,
  identity: WaveformSourceIdentity | undefined,
) {
  if (identity) return createWaveformSourceIdentity(identity)
  if (!source) return undefined
  return createWaveformSourceIdentity({
    assetKey,
    identity: source.identity,
    durationSec: source.durationSec,
    sampleRate: source.sampleRate,
    channelCount: source.channelCount,
  })
}

function sourceIdentityKey(identity: WaveformSourceIdentity | undefined) {
  return JSON.stringify(identity ?? null)
}

async function runSerializedAssetLoad(
  assetKey: string,
  load: () => Promise<PeakAssetRecord | null>,
) {
  const previous = pendingAssetLoads.get(assetKey)
  const current = (async () => {
    if (previous) {
      try {
        await previous
      } catch {}
    }
    return await load()
  })()
  pendingAssetLoads.set(assetKey, current)
  try {
    return await current
  } finally {
    if (pendingAssetLoads.get(assetKey) === current) {
      pendingAssetLoads.delete(assetKey)
    }
  }
}

function waitForAssetLoad(operation: PendingAssetOperation, signal?: AbortSignal) {
  operation.waiterCount += 1
  let detached = false
  let settled = false

  const detach = () => {
    if (detached) return
    detached = true
    operation.waiterCount -= 1
    if (operation.waiterCount === 0 && !operation.settled) {
      operation.controller.abort(signal?.reason)
    }
  }

  return new Promise<PeakAssetRecord | null>((resolve, reject) => {
    const finish = () => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      detach()
    }
    const onAbort = () => {
      finish()
      resolve(null)
    }

    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    void operation.promise.then(
      (value) => {
        finish()
        resolve(value)
      },
      (error) => {
        finish()
        reject(error)
      },
    )
  })
}

export async function ensurePeakAsset(options: EnsureWaveformAssetOptions): Promise<PeakAssetRecord | null> {
  const { assetKey } = options
  options.signal?.throwIfAborted()
  const source = getSource(options)
  const sourceIdentity = createSourceIdentity(assetKey, source, options.sourceIdentity)
  const cached = cacheGet(assetRecordCache, assetKey)
  if (cached && peakAssetMatchesSourceIdentity(cached, sourceIdentity)) return cached
  if (!source) return null
  const identityKey = sourceIdentityKey(sourceIdentity)
  const pending = pendingAssetOperations.get(assetKey)
  if (pending?.identityKey === identityKey && !pending.controller.signal.aborted) {
    return await waitForAssetLoad(pending, options.signal)
  }

  const generation = nextGeneration(assetKey)
  pending?.controller.abort()
  const generationController = new AbortController()
  const promise = runSerializedAssetLoad(assetKey, async () => {
    try {
      generationController.signal.throwIfAborted()
      const current = cacheGet(assetRecordCache, assetKey)
      if (current && peakAssetMatchesSourceIdentity(current, sourceIdentity)) return current

      const stored = source.persistable === true
        ? await loadPeakAssetRecord(assetKey)
        : null
      generationController.signal.throwIfAborted()
      if (stored && peakAssetMatchesSourceIdentity(stored, sourceIdentity)) {
        cacheSet(assetRecordCache, assetKey, stored, MAX_RECORD_CACHE_ENTRIES)
        return stored
      }

      const record = await extractPeakAsset(source, assetKey, {
        signal: generationController.signal,
        onChunk: async ({ chunks }) => {
          generationController.signal.throwIfAborted()
          if (assetGenerations.get(assetKey) !== generation) {
            generationController.abort()
            generationController.signal.throwIfAborted()
          }
          for (const chunk of chunks) {
            if (assetGenerations.get(assetKey) !== generation) {
              generationController.abort()
              generationController.signal.throwIfAborted()
            }
            if (source.persistable === true) await storePeakChunk(chunk.meta.chunkKey, chunk.data)
            cacheSet(assetChunkCache, chunk.meta.chunkKey, chunk.data, MAX_CHUNK_CACHE_ENTRIES)
          }
        },
      }, sourceIdentity)
      generationController.signal.throwIfAborted()
      if (assetGenerations.get(assetKey) !== generation) return record
      if (source.persistable === true) await storePeakAssetRecord(record)
      generationController.signal.throwIfAborted()
      cacheSet(assetRecordCache, assetKey, record, MAX_RECORD_CACHE_ENTRIES)
      return record
    } catch (error) {
      if (generationController.signal.aborted) return null
      throw error
    }
  }).finally(() => {
    const operation = pendingAssetOperations.get(assetKey)
    if (operation?.controller === generationController) {
      operation.settled = true
      pendingAssetOperations.delete(assetKey)
    }
    if (assetGenerations.get(assetKey) === generation) assetGenerations.delete(assetKey)
  })
  const operation: PendingAssetOperation = {
    identityKey,
    controller: generationController,
    promise,
    waiterCount: 0,
    settled: false,
  }
  pendingAssetOperations.set(assetKey, operation)
  return await waitForAssetLoad(operation, options.signal)
}

export async function loadPeakChunkData(chunkKey: string): Promise<Uint8Array | null> {
  const cached = cacheGet(assetChunkCache, chunkKey)
  if (cached) return cached

  const pending = pendingChunkLoads.get(chunkKey)
  if (pending) return await pending

  const task = (async () => {
    const loaded = await loadPeakChunk(chunkKey)
    if (loaded) cacheSet(assetChunkCache, chunkKey, loaded, MAX_CHUNK_CACHE_ENTRIES)
    return loaded
  })()

  pendingChunkLoads.set(chunkKey, task)
  try {
    return await task
  } finally {
    if (pendingChunkLoads.get(chunkKey) === task) pendingChunkLoads.delete(chunkKey)
  }
}

export function clearWaveformAssetCache() {
  assetRecordCache.clear()
  assetChunkCache.clear()
  pendingAssetLoads.clear()
  pendingChunkLoads.clear()
  assetGenerations.clear()
  for (const operation of pendingAssetOperations.values()) operation.controller.abort()
  pendingAssetOperations.clear()
}

export const waveformCacheLimits = {
  recordEntries: MAX_RECORD_CACHE_ENTRIES,
  chunkEntries: MAX_CHUNK_CACHE_ENTRIES,
}

export const getWaveformCacheSizes = () => ({
  recordEntries: assetRecordCache.size,
  chunkEntries: assetChunkCache.size,
  generationEntries: assetGenerations.size,
})
