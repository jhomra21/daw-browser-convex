import {
  peakAssetFormatVersion,
  waveformIntervalsPerChunk,
  type PeakAssetRecord,
  type PeakChunkRecord,
  type PeakLevelRecord,
  type WaveformChunkData,
  type WaveformSourceIdentity,
} from './types'

const DB_NAME = 'audio-peaks-db'
export const PEAK_DB_VERSION = 5
const META_STORE = 'asset-meta'
const CHUNK_STORE = 'asset-chunks'

let dbPromise: Promise<IDBDatabase | null> | null = null

type RecordFields = {
  assetKey?: string
  identity?: string
  durationSec?: number
  frameCount?: number
  sampleRate?: number
  channelCount?: number
  sourceIdentity?: object
  formatVersion?: number
  levels?: readonly object[]
  framesPerInterval?: number
  intervalCount?: number
  intervalsPerChunk?: number
  chunkCount?: number
  generationId?: string
}

const isRecord = <Value>(value: Value): value is Value & RecordFields => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)
const isNumber = <Value>(value: Value): value is Value & number => (
  typeof value === 'number' && Number.isFinite(value)
)
const isInteger = <Value>(value: Value): value is Value & number => (
  typeof value === 'number' && Number.isSafeInteger(value)
)
const isString = <Value>(value: Value): value is Value & string => typeof value === 'string'

const sourceIdentity = <Value>(value: Value): value is Value & WaveformSourceIdentity => (
  isRecord(value)
  && isString(value.assetKey)
  && (value.identity === undefined || isString(value.identity))
  && (value.durationSec === undefined || isNumber(value.durationSec))
  && (value.frameCount === undefined || isInteger(value.frameCount))
  && (value.sampleRate === undefined || isInteger(value.sampleRate))
  && (value.channelCount === undefined || isInteger(value.channelCount))
)

const levelRecord = <Value>(value: Value): value is Value & PeakLevelRecord => (
  isRecord(value)
  && isInteger(value.framesPerInterval) && value.framesPerInterval > 0
  && isInteger(value.intervalCount) && value.intervalCount > 0
  && value.intervalsPerChunk === waveformIntervalsPerChunk
  && isInteger(value.chunkCount) && value.chunkCount > 0
)

const assetRecord = <Value>(value: Value): value is Value & PeakAssetRecord => (
  isRecord(value)
  && value.formatVersion === peakAssetFormatVersion
  && isString(value.assetKey)
  && isString(value.generationId)
  && isInteger(value.frameCount) && value.frameCount >= 0
  && isNumber(value.durationSec) && value.durationSec >= 0
  && isInteger(value.sampleRate) && value.sampleRate > 0
  && isInteger(value.channelCount) && value.channelCount > 0
  && (value.sourceIdentity === undefined || sourceIdentity(value.sourceIdentity))
  && Array.isArray(value.levels)
  && value.levels.every(levelRecord)
)

const parseChunkData = <Value>(value: Value): WaveformChunkData | null => {
  if (!Array.isArray(value) || value.length === 0) return null
  return value.every((channel) => channel instanceof Uint8Array) ? value : null
}

export const isWaveformChunkData = (
  value: WaveformChunkData | null,
  channelCount: number,
  intervalCount: number,
) => Boolean(
  value
  && value.length === channelCount
  && value.every((channel) => channel.length === intervalCount * 2),
)

const canUseIndexedDb = () => 'indexedDB' in globalThis && Boolean(globalThis.indexedDB)

async function getDb() {
  if (!canUseIndexedDb()) return null
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const request = globalThis.indexedDB.open(DB_NAME, PEAK_DB_VERSION)
        request.onupgradeneeded = () => {
          const db = request.result
          if (db.objectStoreNames.contains(META_STORE)) db.deleteObjectStore(META_STORE)
          if (db.objectStoreNames.contains(CHUNK_STORE)) db.deleteObjectStore(CHUNK_STORE)
          db.createObjectStore(META_STORE)
          db.createObjectStore(CHUNK_STORE)
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  }
  return await dbPromise
}

export async function loadPeakAssetRecord(assetKey: string): Promise<PeakAssetRecord | null> {
  const db = await getDb()
  if (!db) return null
  return await new Promise((resolve) => {
    try {
      const request = db.transaction(META_STORE, 'readonly').objectStore(META_STORE).get(assetKey)
      request.onsuccess = () => resolve(assetRecord(request.result) ? request.result : null)
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

export async function storePeakAssetRecord(record: PeakAssetRecord): Promise<void> {
  const db = await getDb()
  if (!db) return
  await new Promise<void>((resolve, reject) => {
    try {
      const tx = db.transaction(META_STORE, 'readwrite')
      tx.objectStore(META_STORE).put(record, record.assetKey)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('Failed to store waveform metadata.'))
      tx.onabort = () => reject(tx.error ?? new Error('Waveform metadata write aborted.'))
    } catch {
      reject(new Error('Failed to store waveform metadata.'))
    }
  })
}

export async function loadPeakChunk(chunkKey: string): Promise<WaveformChunkData | null> {
  const db = await getDb()
  if (!db) return null
  return await new Promise((resolve) => {
    try {
      const request = db.transaction(CHUNK_STORE, 'readonly').objectStore(CHUNK_STORE).get(chunkKey)
      request.onsuccess = () => resolve(parseChunkData(request.result))
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

export async function storePeakChunk(chunkKey: string, data: WaveformChunkData): Promise<void> {
  const db = await getDb()
  if (!db) return
  await new Promise<void>((resolve, reject) => {
    try {
      const tx = db.transaction(CHUNK_STORE, 'readwrite')
      tx.objectStore(CHUNK_STORE).put(data.map((channel) => channel.slice()), chunkKey)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('Failed to store waveform chunk.'))
      tx.onabort = () => reject(tx.error ?? new Error('Waveform chunk write aborted.'))
    } catch {
      reject(new Error('Failed to store waveform chunk.'))
    }
  })
}

export function peakChunkKey(
  assetKey: string,
  generationId: string,
  framesPerInterval: number,
  chunkIndex: number,
) {
  return `${assetKey}:${generationId}:${framesPerInterval}:${chunkIndex}`
}

export function getPeakChunkRecord(
  assetKey: string,
  generationId: string,
  level: PeakLevelRecord,
  channelCount: number,
  chunkIndex: number,
): PeakChunkRecord {
  const intervalStart = chunkIndex * level.intervalsPerChunk
  const intervalCount = Math.min(level.intervalsPerChunk, level.intervalCount - intervalStart)
  return {
    chunkKey: peakChunkKey(assetKey, generationId, level.framesPerInterval, chunkIndex),
    generationId,
    framesPerInterval: level.framesPerInterval,
    chunkIndex,
    intervalStart,
    intervalCount,
    channelCount,
  }
}

export async function deletePeakGenerationChunks(assetKey: string, generationId: string): Promise<void> {
  const db = await getDb()
  if (!db) return
  await new Promise<void>((resolve, reject) => {
    try {
      const tx = db.transaction(CHUNK_STORE, 'readwrite')
      const prefix = `${assetKey}:${generationId}:`
      const cursorRequest = tx.objectStore(CHUNK_STORE).openCursor(
        IDBKeyRange.bound(prefix, `${prefix}\uffff`),
      )
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (!cursor) return
        cursor.delete()
        cursor.continue()
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('Failed to delete waveform generation.'))
      tx.onabort = () => reject(tx.error ?? new Error('Waveform generation deletion aborted.'))
    } catch {
      reject(new Error('Failed to delete waveform generation.'))
    }
  })
}
