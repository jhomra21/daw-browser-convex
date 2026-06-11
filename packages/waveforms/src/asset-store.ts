import { extractPeakAsset } from './extract-peaks'
import { loadPeakAssetRecord, loadPeakChunk, storePeakAssetRecord, storePeakChunk } from './peak-db'
import { createWaveformSourceIdentity, peakAssetMatchesSourceIdentity } from './source-identity'
import type { EnsureWaveformAssetOptions, PeakAssetRecord, WaveformSourceIdentity } from './types'

const assetRecordCache = new Map<string, PeakAssetRecord>()
const assetChunkCache = new Map<string, Uint8Array>()
const pendingAssetLoads = new Map<string, Promise<void>>()
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

async function runSerializedAssetLoad(
  assetKey: string,
  load: () => Promise<PeakAssetRecord | null>,
) {
  const previous = pendingAssetLoads.get(assetKey)
  let release: () => void = () => {}
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  pendingAssetLoads.set(assetKey, current)

  try {
    if (previous) {
      try {
        await previous
      } catch {}
    }
    return await load()
  } finally {
    release()
    if (pendingAssetLoads.get(assetKey) === current) pendingAssetLoads.delete(assetKey)
  }
}

function createBufferSourceIdentity(assetKey: string, buffer: AudioBuffer): WaveformSourceIdentity {
  return createWaveformSourceIdentity({
    assetKey,
    durationSec: buffer.duration,
    sampleRate: buffer.sampleRate,
    channelCount: buffer.numberOfChannels,
  })
}

function createSourceIdentity(options: EnsureWaveformAssetOptions): WaveformSourceIdentity | undefined {
  if (options.sourceIdentity) return createWaveformSourceIdentity(options.sourceIdentity)
  if (options.buffer) return createBufferSourceIdentity(options.assetKey, options.buffer)
  return undefined
}

export async function ensurePeakAsset(options: EnsureWaveformAssetOptions): Promise<PeakAssetRecord | null> {
  const assetKey = options.assetKey
  const sourceIdentity = createSourceIdentity(options)
  const cached = assetRecordCache.get(assetKey)
  if (cached && peakAssetMatchesSourceIdentity(cached, sourceIdentity)) return cached

  return await runSerializedAssetLoad(assetKey, async () => {
    const cached = assetRecordCache.get(assetKey)
    if (cached && peakAssetMatchesSourceIdentity(cached, sourceIdentity)) return cached

    const stored = await loadPeakAssetRecord(assetKey)
    if (isPeakAssetRecord(stored) && peakAssetMatchesSourceIdentity(stored, sourceIdentity)) {
      assetRecordCache.set(assetKey, stored)
      return stored
    }

    const buffer = options.buffer ?? (options.sampleUrl ? await decodeBufferFromSampleUrl(options.sampleUrl) : null)
    if (!buffer) return null
    const extracted = extractPeakAsset(buffer, assetKey, sourceIdentity)
    await persistPeakAsset(extracted.record, extracted.chunks)
    return extracted.record
  })
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


export function clearWaveformAssetCache() {
  assetRecordCache.clear()
  assetChunkCache.clear()
  pendingAssetLoads.clear()
  pendingChunkLoads.clear()
}

