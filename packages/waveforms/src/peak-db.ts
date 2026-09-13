import {
  peakAssetFormatVersion,
  type PeakAssetRecord,
  type PeakLevelRecord,
  type WaveformPeakChunkData,
  type WaveformSourceIdentity,
} from './types'

const DB_NAME = 'audio-peaks-db'
export const PEAK_DB_VERSION = 3
const META_STORE = 'asset-meta'
const CHUNK_STORE = 'asset-chunks'

let dbPromise: Promise<IDBDatabase | null> | null = null

type RecordFields = {
  assetKey?: unknown
  formatVersion?: unknown
  durationSec?: unknown
  sampleRate?: unknown
  channelCount?: unknown
  sourceIdentity?: unknown
  identity?: unknown
  levels?: unknown
  peaksPerSecond?: unknown
  chunkDurationSec?: unknown
  chunkCount?: unknown
}

const isRecord = <Value>(value: Value): value is Value & RecordFields => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const isString = <Value>(value: Value): value is Value & string => typeof value === 'string'
const isNumber = <Value>(value: Value): value is Value & number => (
  typeof value === 'number' && Number.isFinite(value)
)

const isWaveformSourceIdentity = <Value>(value: Value): value is Value & WaveformSourceIdentity => (
  isRecord(value)
  && isString(value.assetKey)
  && (value.identity === undefined || isString(value.identity))
  && (value.durationSec === undefined || isNumber(value.durationSec))
  && (value.sampleRate === undefined || isNumber(value.sampleRate))
  && (value.channelCount === undefined || isNumber(value.channelCount))
)

const isPeakLevelRecord = <Value>(value: Value): value is Value & PeakLevelRecord => (
  isRecord(value)
  && isNumber(value.peaksPerSecond) && value.peaksPerSecond > 0
  && isNumber(value.chunkDurationSec) && value.chunkDurationSec > 0
  && isNumber(value.chunkCount) && Number.isSafeInteger(value.chunkCount) && value.chunkCount > 0
)

const isPeakAssetRecord = <Value>(value: Value): value is Value & PeakAssetRecord => (
  isRecord(value)
  && value.formatVersion === peakAssetFormatVersion
  && isString(value.assetKey)
  && isNumber(value.durationSec) && value.durationSec >= 0
  && isNumber(value.sampleRate) && Number.isSafeInteger(value.sampleRate) && value.sampleRate > 0
  && isNumber(value.channelCount) && Number.isSafeInteger(value.channelCount) && value.channelCount > 0
  && (value.sourceIdentity === undefined || isWaveformSourceIdentity(value.sourceIdentity))
  && Array.isArray(value.levels)
  && value.levels.every(isPeakLevelRecord)
)

const parsePeakAssetRecord = <Value>(value: Value): PeakAssetRecord | null => (
  isPeakAssetRecord(value) ? value : null
)

const parsePeakChunkData = <Value>(value: Value): WaveformPeakChunkData | null => {
  if (!Array.isArray(value) || value.length === 0) return null
  return value.every((channel) => channel instanceof Uint8Array)
    ? value
    : null
}

export const isPeakChunkData = (
  value: WaveformPeakChunkData | null,
  channelCount: number,
  peakCount: number,
) => Boolean(
  value
  && value.length === channelCount
  && value.every((channel) => channel instanceof Uint8Array && channel.length === peakCount * 2),
)

function canUseIndexedDb() {
  return 'indexedDB' in globalThis && Boolean(globalThis.indexedDB)
}

async function getDb() {
  if (!canUseIndexedDb()) return null
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const request = globalThis.indexedDB.open(DB_NAME, PEAK_DB_VERSION)
        request.onupgradeneeded = (event) => {
          const db = request.result
          const oldVersion = event.oldVersion
          if (request.transaction && oldVersion < PEAK_DB_VERSION) {
            if (db.objectStoreNames.contains(META_STORE)) db.deleteObjectStore(META_STORE)
            if (db.objectStoreNames.contains(CHUNK_STORE)) db.deleteObjectStore(CHUNK_STORE)
          }
          if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE)
          if (!db.objectStoreNames.contains(CHUNK_STORE)) db.createObjectStore(CHUNK_STORE)
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
      const tx = db.transaction(META_STORE, 'readonly')
      const request = tx.objectStore(META_STORE).get(assetKey)
      request.onsuccess = () => resolve(parsePeakAssetRecord(request.result))
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
      tx.onerror = () => reject(tx.error ?? new Error('Failed to store waveform asset metadata.'))
      tx.onabort = () => reject(tx.error ?? new Error('Waveform asset metadata write was aborted.'))
    } catch {
      reject(new Error('Failed to store waveform asset metadata.'))
    }
  })
}

export async function loadPeakChunk(chunkKey: string): Promise<WaveformPeakChunkData | null> {
  const db = await getDb()
  if (!db) return null

  return await new Promise((resolve) => {
    try {
      const tx = db.transaction(CHUNK_STORE, 'readonly')
      const request = tx.objectStore(CHUNK_STORE).get(chunkKey)
      request.onsuccess = () => {
        resolve(parsePeakChunkData(request.result))
      }
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

export async function storePeakChunk(chunkKey: string, data: WaveformPeakChunkData): Promise<void> {
  const db = await getDb()
  if (!db) return

  await new Promise<void>((resolve, reject) => {
    try {
      const tx = db.transaction(CHUNK_STORE, 'readwrite')
      tx.objectStore(CHUNK_STORE).put(data.map((channel) => channel.slice()), chunkKey)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('Failed to store waveform peak chunk.'))
      tx.onabort = () => reject(tx.error ?? new Error('Waveform peak chunk write was aborted.'))
    } catch {
      reject(new Error('Failed to store waveform peak chunk.'))
    }
  })
}

export async function deletePeakAssetData(
  assetKey: string,
): Promise<void> {
  const db = await getDb()
  if (!db) return
  await new Promise<void>((resolve, reject) => {
    try {
      const tx = db.transaction([META_STORE, CHUNK_STORE], 'readwrite')
      tx.objectStore(META_STORE).delete(assetKey)
      const request = tx.objectStore(CHUNK_STORE).openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return
        if (cursor.key.toString().startsWith(`${assetKey}:`)) {
          cursor.delete()
        }
        cursor.continue()
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('Failed to delete waveform asset data.'))
      tx.onabort = () => reject(tx.error ?? new Error('Waveform asset deletion was aborted.'))
    } catch {
      reject(new Error('Failed to delete waveform asset data.'))
    }
  })
}