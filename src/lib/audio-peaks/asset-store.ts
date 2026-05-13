import { extractPeakAsset } from '~/lib/audio-peaks/extract-peaks'
import { loadPeakAssetRecord, loadPeakChunk, storePeakAssetRecord, storePeakChunk } from '~/lib/audio-peaks/peak-db'
import type { EnsureWaveformAssetOptions, PeakAssetRecord } from '~/lib/audio-peaks/types'

const assetRecordCache = new Map<string, PeakAssetRecord>()
const assetChunkCache = new Map<string, Uint8Array>()
const pendingAssetLoads = new Map<string, Promise<PeakAssetRecord | null>>()
const pendingChunkLoads = new Map<string, Promise<Uint8Array | null>>()

function isPeakAssetRecord(value: unknown): value is PeakAssetRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as PeakAssetRecord
  return Array.isArray(record.levels)
}

async function decodeBufferFromSampleUrl(sampleUrl: string): Promise<AudioBuffer | null> {
  let audioContext: BaseAudioContext | null = null
  let closableContext: AudioContext | null = null

  try {
    const response = await fetch(sampleUrl)
    if (!response.ok) return null
    const arrayBuffer = await response.arrayBuffer()

    try {
      if (typeof OfflineAudioContext !== 'undefined') {
        audioContext = new OfflineAudioContext(1, 1, 44100)
      }
    } catch {}

    if (!audioContext) {
      try {
        if (typeof AudioContext !== 'undefined') {
          closableContext = new AudioContext()
          audioContext = closableContext
        }
      } catch {}
    }

    if (!audioContext) return null
    return await audioContext.decodeAudioData(arrayBuffer.slice(0))
  } catch {
    return null
  } finally {
    if (closableContext) {
      try {
        await closableContext.close()
      } catch {}
    }
  }
}

async function persistPeakAsset(record: PeakAssetRecord, chunks: Array<{ meta: { chunkKey: string }; data: Uint8Array }>) {
  assetRecordCache.set(record.assetKey, record)
  for (const chunk of chunks) {
    assetChunkCache.set(chunk.meta.chunkKey, chunk.data)
  }
  await storePeakAssetRecord(record)
  await Promise.all(chunks.map((chunk) => storePeakChunk(chunk.meta.chunkKey, chunk.data)))
}

export async function ensurePeakAsset(options: EnsureWaveformAssetOptions): Promise<PeakAssetRecord | null> {
  const assetKey = options.assetKey
  const cached = assetRecordCache.get(assetKey)
  if (cached) return cached

  const pending = pendingAssetLoads.get(assetKey)
  if (pending) return await pending

  const task = (async () => {
    const stored = await loadPeakAssetRecord(assetKey)
    if (isPeakAssetRecord(stored)) {
      assetRecordCache.set(assetKey, stored)
      return stored
    }

    const buffer = options.buffer ?? (options.sampleUrl ? await decodeBufferFromSampleUrl(options.sampleUrl) : null)
    if (!buffer) return null
    const extracted = extractPeakAsset(buffer, assetKey)
    await persistPeakAsset(extracted.record, extracted.chunks)
    return extracted.record
  })()

  pendingAssetLoads.set(assetKey, task)
  try {
    return await task
  } finally {
    if (pendingAssetLoads.get(assetKey) === task) pendingAssetLoads.delete(assetKey)
  }
}

export async function loadPeakChunkData(chunkKey: string): Promise<Uint8Array | null> {
  const cached = assetChunkCache.get(chunkKey)
  if (cached) return cached

  const pending = pendingChunkLoads.get(chunkKey)
  if (pending) return await pending

  const task = (async () => {
    const loaded = await loadPeakChunk(chunkKey)
    if (loaded) assetChunkCache.set(chunkKey, loaded)
    return loaded
  })()

  pendingChunkLoads.set(chunkKey, task)
  try {
    return await task
  } finally {
    if (pendingChunkLoads.get(chunkKey) === task) pendingChunkLoads.delete(chunkKey)
  }
}

export const primeWaveformAsset = ensurePeakAsset

export function clearWaveformAssetCache() {
  assetRecordCache.clear()
  assetChunkCache.clear()
  pendingAssetLoads.clear()
  pendingChunkLoads.clear()
}

